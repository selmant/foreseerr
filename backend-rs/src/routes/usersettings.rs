//! `GET /user/:id/settings/*` from `server/routes/user/usersettings.ts`.

use std::future::Future;
use std::pin::Pin;

use serde_json::{Map, Value};

use super::{Outcome, Ready};
use crate::auth::CurrentUser;
use crate::db::{UserRecord, UserSettingsRecord};
use crate::settings::public::truthy;
use crate::user::{discover_filter_defaults, notification_types};

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// `Permission.MANAGE_USERS`.
const MANAGE_USERS: i64 = 8;
/// `DEFAULT_SKIPPED_EPISODE_PROGRESS_THRESHOLD` and its range.
const SKIPPED_THRESHOLD: (i64, i64, i64) = (50, 1, 100);
/// `DEFAULT_WATCH_AHEAD_EPISODE_COUNT` and its range.
const WATCH_AHEAD: (i64, i64, i64) = (10, 1, 50);

/// A loaded user, or the outcome that ends the request instead.
enum Loaded {
    User(Box<(UserRecord, Option<UserSettingsRecord>)>),
    Done(Outcome),
}

/// The user id in the path (`/api/v1/user/{id}/...`).
fn path_id(ctx: &Ready<'_>) -> Result<i64, super::Fallback> {
    ctx.req
        .uri
        .path()
        .split('/')
        .nth(4)
        .and_then(crate::jsval::decode_uri_component)
        .as_deref()
        .and_then(super::params::integer)
        .ok_or_else(|| super::Fallback::status(400, "The id in the path must be an integer."))
}

/// `isAuthenticated()` on the user router, `isOwnProfileOrAdmin()` (or a
/// permission) on the route, then `findOne` with the eager settings.
async fn load(
    ctx: &Ready<'_>,
    required: i64,
    own_profile_ok: bool,
) -> Result<Loaded, super::Fallback> {
    ctx.no_query()?;
    let viewer: &CurrentUser = ctx.authenticated(0)?;
    let id = path_id(ctx)?;
    let allowed = viewer.has_permission(required) && (own_profile_ok || required != 0)
        || (own_profile_ok && viewer.id == id);
    if !allowed {
        if !ctx.passed() {
            return Err(if own_profile_ok {
                super::Fallback::not_own_profile()
            } else {
                super::Fallback::forbidden("the user may not view this")
            });
        }
        // `isOwnProfileOrAdmin()`, or `isAuthenticated(permission)`.
        return Ok(Loaded::Done(if own_profile_ok {
            ctx.error(
                403,
                "You do not have permission to view this user's settings.",
            )
        } else {
            ctx.forbidden()
        }));
    }
    let loaded = ctx
        .state
        .db
        .user_record(id)
        .await
        .map_err(|e| format!("loading the user failed: {e:#}"))?;
    Ok(loaded.map_or_else(
        || Loaded::Done(ctx.error(404, "User not found.")),
        |loaded| Loaded::User(Box::new(loaded)),
    ))
}

/// `GET /user/:id/settings/main`.
pub(super) fn main<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let (user, settings) = match load(ctx, MANAGE_USERS, true).await {
            Ok(Loaded::User(loaded)) => *loaded,
            Ok(Loaded::Done(outcome)) => return outcome,
            Err(why) => return Outcome::forward(why),
        };
        let s = settings.as_ref();
        let quota = |path: &str| {
            ctx.settings
                .get(&format!("/main/defaultQuotas/{path}"))
                .cloned()
        };
        let mut out = Map::new();
        let mut put = |key: &str, value: Option<Value>| {
            if let Some(v) = value {
                out.insert(String::from(key), v);
            }
        };
        let text = |v: &Option<String>| Some(v.as_deref().map_or(Value::Null, Value::from));
        let number = |v: Option<i64>| Some(v.map_or(Value::Null, Value::from));
        let flag = |v: Option<bool>| Some(v.map_or(Value::Null, Value::Bool));
        put("username", text(&user.username));
        put(
            "email",
            Some(Value::from(
                user.email.as_deref().unwrap_or("").to_lowercase(),
            )),
        );
        put("locale", s.map(|s| Value::from(s.public.locale.as_str())));
        put(
            "discoverRegion",
            s.and_then(|s| text(&s.public.discover_region)),
        );
        put(
            "streamingRegion",
            s.and_then(|s| text(&s.public.streaming_region)),
        );
        put(
            "originalLanguage",
            s.and_then(|s| text(&s.public.original_language)),
        );
        put("movieQuotaLimit", number(user.movie_quota_limit));
        put("movieQuotaDays", number(user.movie_quota_days));
        put("tvQuotaLimit", number(user.tv_quota_limit));
        put("tvQuotaDays", number(user.tv_quota_days));
        put("globalMovieQuotaDays", quota("movie/quotaDays"));
        put("globalMovieQuotaLimit", quota("movie/quotaLimit"));
        put("globalTvQuotaDays", quota("tv/quotaDays"));
        put("globalTvQuotaLimit", quota("tv/quotaLimit"));
        put(
            "watchlistSyncMovies",
            s.and_then(|s| flag(s.public.watchlist_sync_movies)),
        );
        put(
            "watchlistSyncTv",
            s.and_then(|s| flag(s.public.watchlist_sync_tv)),
        );
        put(
            "autoCompleteSkippedEpisodeEndings",
            s.and_then(|s| flag(s.public.auto_complete_skipped_episode_endings)),
        );
        put(
            "autoCompleteSkippedEpisodeThreshold",
            Some(clamped(
                s.and_then(|s| s.public.auto_complete_skipped_episode_threshold),
                SKIPPED_THRESHOLD,
            )),
        );
        put(
            "watchAheadEpisodeCount",
            Some(clamped(
                s.and_then(|s| s.public.watch_ahead_episode_count),
                WATCH_AHEAD,
            )),
        );
        ctx.json(&Value::Object(out))
    })
}

/// `skippedEpisodeProgressThreshold` / `watchAheadEpisodeCount`: the
/// default for anything that isn't a number, otherwise clamped. Stored
/// values are whole, so `Math.round` has nothing to do.
fn clamped(value: Option<i64>, (default, min, max): (i64, i64, i64)) -> Value {
    Value::from(value.map_or(default, |v| v.clamp(min, max)))
}

/// `GET /user/:id/settings/password`.
pub(super) fn password<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user = match load(ctx, MANAGE_USERS, true).await {
            Ok(Loaded::User(loaded)) => loaded.0,
            Ok(Loaded::Done(outcome)) => return outcome,
            Err(why) => return Outcome::forward(why),
        };
        let has_password = match ctx.state.db.user_has_password(user.id).await {
            Ok(has) => has,
            Err(e) => return Outcome::forward(format!("reading the password failed: {e:#}")),
        };
        let mut out = Map::new();
        out.insert(String::from("hasPassword"), Value::Bool(has_password));
        ctx.json(&Value::Object(out))
    })
}

/// `GET /user/:id/settings/notifications`.
pub(super) fn notifications<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let settings = match load(ctx, MANAGE_USERS, true).await {
            Ok(Loaded::User(loaded)) => loaded.1,
            Ok(Loaded::Done(outcome)) => return outcome,
            Err(why) => return Outcome::forward(why),
        };
        let s = settings.as_ref();
        let agents = |path: &str| ctx.settings.get(&format!("/notifications/agents/{path}"));
        let discord_enabled = agents("discord/enabled");
        // `a && b` is `a` when `a` is falsy, else `b`.
        let discord_mentions = if truthy(discord_enabled) {
            agents("discord/options/enableMentions")
        } else {
            discord_enabled
        };
        let mut out = Map::new();
        let mut put = |key: &str, value: Option<Value>| {
            if let Some(v) = value {
                out.insert(String::from(key), v);
            }
        };
        let text = |v: &Option<String>| Some(v.as_deref().map_or(Value::Null, Value::from));
        let flag = |v: Option<bool>| Some(v.map_or(Value::Null, Value::Bool));
        put("emailEnabled", agents("email/enabled").cloned());
        put("pgpKey", s.and_then(|s| text(&s.pgp_key)));
        put("discordEnabled", discord_mentions.cloned());
        put(
            "discordEnabledTypes",
            Some(if truthy(discord_mentions) {
                agents("discord/types").cloned().unwrap_or(Value::Null)
            } else {
                Value::from(0)
            }),
        );
        put(
            "discordIds",
            Some(s.map_or_else(
                || Value::Array(Vec::new()),
                |s| crate::user::discord_ids(s.discord_ids.as_deref()),
            )),
        );
        put(
            "pushbulletAccessToken",
            s.and_then(|s| text(&s.pushbullet_access_token)),
        );
        put(
            "pushoverApplicationToken",
            s.and_then(|s| text(&s.pushover_application_token)),
        );
        put(
            "pushoverUserKey",
            s.and_then(|s| text(&s.pushover_user_key)),
        );
        put("pushoverSound", s.and_then(|s| text(&s.pushover_sound)));
        put("telegramEnabled", agents("telegram/enabled").cloned());
        put(
            "telegramBotUsername",
            agents("telegram/options/botUsername").cloned(),
        );
        put("telegramChatId", s.and_then(|s| text(&s.telegram_chat_id)));
        put(
            "telegramMessageThreadId",
            s.and_then(|s| text(&s.telegram_message_thread_id)),
        );
        put(
            "telegramSendSilently",
            s.and_then(|s| flag(s.telegram_send_silently)),
        );
        put("webPushEnabled", agents("webpush/enabled").cloned());
        let types = match s {
            Some(s) => match notification_types(s.public.notification_types.as_deref()) {
                Ok(types) => types,
                Err(why) => return Outcome::forward(why.to_owned()),
            },
            None => Value::Object(Map::new()),
        };
        put("notificationTypes", Some(types));
        ctx.json(&Value::Object(out))
    })
}

/// `GET /user/:id/settings/permissions`, for `MANAGE_USERS` only.
pub(super) fn permissions<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user = match load(ctx, MANAGE_USERS, false).await {
            Ok(Loaded::User(loaded)) => loaded.0,
            Ok(Loaded::Done(outcome)) => return outcome,
            Err(why) => return Outcome::forward(why),
        };
        let mut out = Map::new();
        out.insert(String::from("permissions"), Value::from(user.permissions));
        ctx.json(&Value::Object(out))
    })
}

/// `GET /user/:id/settings/discover`. `ensureUserSettings` creates the
/// settings row when it is missing (the cascade insert of
/// `new UserSettings({ user })`: the `locale` default, the rest null).
pub(super) fn discover<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let (user, settings) = match load(ctx, MANAGE_USERS, true).await {
            Ok(Loaded::User(loaded)) => *loaded,
            Ok(Loaded::Done(Outcome::Done(res))) if res.status() == 404 => {
                // `ensureUserSettings` throws "User not found", a 500.
                return ctx.error(500, "User not found");
            }
            Ok(Loaded::Done(outcome)) => return outcome,
            Err(why) => return Outcome::forward(why),
        };
        let Some(settings) = settings else {
            let columns = [
                ("locale", Value::from("")),
                ("userId", Value::from(user.id)),
            ];
            if let Err(e) = crate::typeorm::insert(&ctx.state.db, "user_settings", &columns).await {
                return ctx.error(500, &format!("{e:#}"));
            }
            // A new row has no filter defaults: the transformer reads `{}`.
            return ctx.json(&discover_filter_defaults(None));
        };
        ctx.json(&discover_filter_defaults(
            settings.public.discover_filter_defaults.as_deref(),
        ))
    })
}
