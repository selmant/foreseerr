//! `POST /user/{id}/settings/*` from `server/routes/user/usersettings.ts`:
//! main, password, permissions, notifications and discover.

use std::future::Future;
use std::pin::Pin;

use axum::http::Method;
use serde_json::{Map, Value};

use super::userwrite::{
    body_object, can_make_permissions_change, check_fields, flag, has_permission, int, load_user,
    own_or_admin, text, Kind, ADMIN, MANAGE_USERS, USER_TYPE_PLEX,
};
use super::{Outcome, Ready, Table};
use crate::db::{Bind, UserRecord, UserSettingsRecord};
use crate::typeorm::{self, Changes};

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/user/{id}/settings/main", Method::POST, main),
    (
        "/api/v1/user/{id}/settings/password",
        Method::POST,
        password,
    ),
    (
        "/api/v1/user/{id}/settings/permissions",
        Method::POST,
        permissions,
    ),
    (
        "/api/v1/user/{id}/settings/notifications",
        Method::POST,
        notifications,
    ),
    (
        "/api/v1/user/{id}/settings/discover",
        Method::POST,
        discover,
    ),
];

macro_rules! try_forward {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(why) => return Outcome::forward(why),
        }
    };
}

macro_rules! try_db {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(e) => return Outcome::forward(format!("database: {e:#}")),
        }
    };
}

/// The owner's settings are the owner's alone.
const OWNER_ONLY: &str = "You do not have permission to modify this user's settings.";

/// `DEFAULT_SKIPPED_EPISODE_PROGRESS_THRESHOLD` and its range.
const SKIPPED_THRESHOLD: (i64, i64, i64) = (50, 1, 100);
/// `DEFAULT_WATCH_AHEAD_EPISODE_COUNT` and its range.
const WATCH_AHEAD: (i64, i64, i64) = (10, 1, 50);

/// `skippedEpisodeProgressThreshold` / `watchAheadEpisodeCount` for a whole
/// number (or nothing).
fn clamped(value: Option<i64>, (default, min, max): (i64, i64, i64)) -> Value {
    Value::from(value.map_or(default, |v| v.clamp(min, max)))
}

/// A body field put back into the response the way `save()` leaves the
/// entity: the value when assigned, `null` for an `undefined` nullable
/// column of an entity that was written, nothing otherwise.
fn echoed(out: &mut Map<String, Value>, key: &str, assigned: Option<&Value>, written: bool) {
    match assigned {
        Some(v) => {
            out.insert(String::from(key), v.clone());
        }
        None if written => {
            out.insert(String::from(key), Value::Null);
        }
        None => {}
    }
}

/// Run a user update (with `updatedAt`) and a settings update.
async fn save(
    ctx: &Ready<'_>,
    user_id: i64,
    user: &Changes,
    settings: Option<(i64, &Changes)>,
) -> anyhow::Result<()> {
    typeorm::run(&ctx.state.db, user.update_sql("user", user_id, true)?).await?;
    if let Some((id, changes)) = settings {
        typeorm::run(
            &ctx.state.db,
            changes.update_sql("user_settings", id, false)?,
        )
        .await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// POST /settings/main
// ---------------------------------------------------------------------------

/// The per-user quota fields of `/settings/main`, which the handler only
/// assigns when a manager edits someone without `MANAGE_USERS`.
const QUOTA_FIELDS: [(&str, &[Kind]); 4] = [
    ("movieQuotaLimit", &[Kind::Int, Kind::Null]),
    ("movieQuotaDays", &[Kind::Int, Kind::Null]),
    ("tvQuotaLimit", &[Kind::Int, Kind::Null]),
    ("tvQuotaDays", &[Kind::Int, Kind::Null]),
];

const MAIN_FIELDS: [(&str, &[Kind]); 15] = [
    ("username", &[Kind::Text, Kind::Null]),
    ("email", &[Kind::Text]),
    // `locale` is nullable in the schema, but the column is NOT NULL: a
    // null fails the save (see `main`).
    ("locale", &[Kind::Text, Kind::Null]),
    ("discoverRegion", &[Kind::Text, Kind::Null]),
    ("streamingRegion", &[Kind::Text, Kind::Null]),
    ("originalLanguage", &[Kind::Text, Kind::Null]),
    ("globalMovieQuotaDays", &[Kind::Number, Kind::Null]),
    ("globalMovieQuotaLimit", &[Kind::Number, Kind::Null]),
    ("globalTvQuotaLimit", &[Kind::Number, Kind::Null]),
    ("globalTvQuotaDays", &[Kind::Number, Kind::Null]),
    ("watchlistSyncMovies", &[Kind::Bool, Kind::Null]),
    ("watchlistSyncTv", &[Kind::Bool, Kind::Null]),
    (
        "autoCompleteSkippedEpisodeEndings",
        &[Kind::Bool, Kind::Null],
    ),
    (
        "autoCompleteSkippedEpisodeThreshold",
        &[Kind::Int, Kind::Null],
    ),
    ("watchAheadEpisodeCount", &[Kind::Int, Kind::Null]),
];

/// The integer settings, validated to their schema ranges; `None` means
/// the handler leaves the column alone.
fn ranged(
    body: &Map<String, Value>,
    key: &str,
    (_, min, max): (i64, i64, i64),
) -> Result<Option<i64>, String> {
    match body.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => match v.as_i64() {
            Some(n) if (min..=max).contains(&n) => Ok(Some(n)),
            _ => Err(format!("{key} outside what the validator accepts")),
        },
    }
}

/// `POST /user/{id}/settings/main`.
fn main<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let id = try_forward!(super::params::path_int(ctx, 2));
        let viewer = try_forward!(own_or_admin(ctx, id));
        let body = try_forward!(body_object(ctx));
        try_forward!(check_fields(body, &MAIN_FIELDS));
        let threshold = try_forward!(ranged(
            body,
            "autoCompleteSkippedEpisodeThreshold",
            SKIPPED_THRESHOLD
        ));
        let watch_ahead = try_forward!(ranged(body, "watchAheadEpisodeCount", WATCH_AHEAD));
        let (user, settings) = match try_forward!(load_user(ctx, id).await) {
            Ok(loaded) => loaded,
            Err(outcome) => return outcome,
        };
        if user.id == 1 && viewer.id != 1 {
            return ctx.error(403, OWNER_ONLY);
        }
        if !has_permission(user.permissions, MANAGE_USERS) && viewer.id != user.id {
            try_forward!(check_fields(body, &QUOTA_FIELDS));
        }
        let old_email = user.email.as_deref().unwrap_or("").to_lowercase();
        let email = if user.user_type == USER_TYPE_PLEX {
            old_email.clone()
        } else {
            body.get("email")
                .and_then(Value::as_str)
                .filter(|e| !e.is_empty())
                .or_else(|| user.jellyfin_username.as_deref().filter(|n| !n.is_empty()))
                .map_or_else(|| old_email.clone(), str::to_owned)
        };
        if old_email != email {
            let taken = try_db!(
                ctx.state
                    .db
                    .scalar(
                        r#"SELECT COUNT(*) FROM "user" WHERE "email" = ?1 AND "id" != ?2"#,
                        &[Bind::Text(email.to_lowercase()), Bind::Int(user.id)],
                    )
                    .await
            );
            if taken > 0 {
                return ctx.error(400, "INVALID_EMAIL");
            }
        }
        if body.get("locale").is_some_and(Value::is_null) {
            // The column is NOT NULL; the save fails.
            return ctx.error(500, "locale must not be null.");
        }
        let user_changes = main_user_changes(body, &user, viewer.id, &email);
        let settings_out = if let Some(s) = settings.as_ref() {
            let changes = main_settings_changes(body, s, threshold, watch_ahead);
            let written = changes.any() || typeorm::settings_change_by_itself(s);
            if let Err(e) = save(ctx, user.id, &user_changes, Some((s.id, &changes))).await {
                return Outcome::forward(format!("saving the settings failed: {e:#}"));
            }
            main_settings_json(body, Some(s), written, threshold, watch_ahead)
        } else {
            if let Err(e) = save(ctx, user.id, &user_changes, None).await {
                return Outcome::forward(format!("saving the user failed: {e:#}"));
            }
            if let Err(e) = insert_main_settings(ctx, user.id, body, threshold, watch_ahead).await {
                return ctx.error(500, &format!("{e:#}"));
            }
            main_settings_json(body, None, true, threshold, watch_ahead)
        };
        let mut out = Map::new();
        echoed(
            &mut out,
            "username",
            body.get("username"),
            user_changes.any(),
        );
        out.extend(settings_out);
        out.insert(String::from("email"), Value::from(email));
        ctx.json(&Value::Object(out))
    })
}

/// The user columns `/settings/main` assigns, as changes.
fn main_user_changes(
    body: &Map<String, Value>,
    user: &UserRecord,
    viewer_id: i64,
    email: &str,
) -> Changes {
    let mut changes = Changes::default();
    changes.assign(
        "username",
        body.get("username"),
        &text(user.username.as_ref()),
    );
    // The email transformer lower-cases both sides before comparing.
    if email.to_lowercase() != user.email.as_deref().unwrap_or("").to_lowercase() {
        changes.set("email", Value::from(email.to_lowercase()));
    }
    if !has_permission(user.permissions, MANAGE_USERS) && viewer_id != user.id {
        for (key, old) in [
            ("movieQuotaLimit", user.movie_quota_limit),
            ("movieQuotaDays", user.movie_quota_days),
            ("tvQuotaLimit", user.tv_quota_limit),
            ("tvQuotaDays", user.tv_quota_days),
        ] {
            changes.assign(key, body.get(key), &int(old));
        }
    }
    changes
}

/// The settings columns `/settings/main` assigns, as changes.
fn main_settings_changes(
    body: &Map<String, Value>,
    s: &UserSettingsRecord,
    threshold: Option<i64>,
    watch_ahead: Option<i64>,
) -> Changes {
    let p = &s.public;
    let mut changes = Changes::default();
    changes.assign(
        "locale",
        body.get("locale"),
        &Value::from(p.locale.as_str()),
    );
    changes.assign(
        "discoverRegion",
        body.get("discoverRegion"),
        &text(p.discover_region.as_ref()),
    );
    changes.assign(
        "streamingRegion",
        body.get("streamingRegion"),
        &text(p.streaming_region.as_ref()),
    );
    changes.assign(
        "originalLanguage",
        body.get("originalLanguage"),
        &text(p.original_language.as_ref()),
    );
    changes.assign(
        "watchlistSyncMovies",
        body.get("watchlistSyncMovies"),
        &flag(p.watchlist_sync_movies),
    );
    changes.assign(
        "watchlistSyncTv",
        body.get("watchlistSyncTv"),
        &flag(p.watchlist_sync_tv),
    );
    if let Some(v @ Value::Bool(_)) = body.get("autoCompleteSkippedEpisodeEndings") {
        changes.assign(
            "autoCompleteSkippedEpisodeEndings",
            Some(v),
            &flag(p.auto_complete_skipped_episode_endings),
        );
    }
    if let Some(t) = threshold {
        changes.assign(
            "autoCompleteSkippedEpisodeThreshold",
            Some(&Value::from(t)),
            &int(p.auto_complete_skipped_episode_threshold),
        );
    }
    if let Some(w) = watch_ahead {
        changes.assign(
            "watchAheadEpisodeCount",
            Some(&Value::from(w)),
            &int(p.watch_ahead_episode_count),
        );
    }
    changes
}

/// A new settings row for `/settings/main` (the cascade insert).
async fn insert_main_settings(
    ctx: &Ready<'_>,
    user_id: i64,
    body: &Map<String, Value>,
    threshold: Option<i64>,
    watch_ahead: Option<i64>,
) -> anyhow::Result<()> {
    let mut columns: Vec<(&str, Value)> = vec![(
        "locale",
        body.get("locale")
            .cloned()
            .unwrap_or_else(|| Value::from("")),
    )];
    for key in [
        "discoverRegion",
        "streamingRegion",
        "originalLanguage",
        "watchlistSyncMovies",
        "watchlistSyncTv",
    ] {
        columns.push((key, body.get(key).cloned().unwrap_or(Value::Null)));
    }
    if let Some(v @ Value::Bool(_)) = body.get("autoCompleteSkippedEpisodeEndings") {
        columns.push(("autoCompleteSkippedEpisodeEndings", v.clone()));
    }
    if let Some(t) = threshold {
        columns.push(("autoCompleteSkippedEpisodeThreshold", Value::from(t)));
    }
    if let Some(w) = watch_ahead {
        columns.push(("watchAheadEpisodeCount", Value::from(w)));
    }
    columns.push(("userId", Value::from(user_id)));
    typeorm::insert(&ctx.state.db, "user_settings", &columns).await?;
    Ok(())
}

/// The settings part of the `/settings/main` answer, in handler order.
fn main_settings_json(
    body: &Map<String, Value>,
    s: Option<&UserSettingsRecord>,
    written: bool,
    threshold: Option<i64>,
    watch_ahead: Option<i64>,
) -> Map<String, Value> {
    let mut out = Map::new();
    match (body.get("locale"), s) {
        (Some(v), _) => {
            out.insert(String::from("locale"), v.clone());
        }
        // A new row reloads the column default; an existing one leaves the
        // non-nullable column `undefined`.
        (None, None) => {
            out.insert(String::from("locale"), Value::from(""));
        }
        (None, Some(_)) => {}
    }
    for key in [
        "discoverRegion",
        "streamingRegion",
        "originalLanguage",
        "watchlistSyncMovies",
        "watchlistSyncTv",
    ] {
        echoed(&mut out, key, body.get(key), written);
    }
    let auto_complete = match body.get("autoCompleteSkippedEpisodeEndings") {
        Some(v @ Value::Bool(_)) => v.clone(),
        _ => s.map_or(Value::Null, |s| {
            flag(s.public.auto_complete_skipped_episode_endings)
        }),
    };
    out.insert(
        String::from("autoCompleteSkippedEpisodeEndings"),
        auto_complete,
    );
    out.insert(
        String::from("autoCompleteSkippedEpisodeThreshold"),
        clamped(
            threshold.or_else(|| s.and_then(|s| s.public.auto_complete_skipped_episode_threshold)),
            SKIPPED_THRESHOLD,
        ),
    );
    out.insert(
        String::from("watchAheadEpisodeCount"),
        clamped(
            watch_ahead.or_else(|| s.and_then(|s| s.public.watch_ahead_episode_count)),
            WATCH_AHEAD,
        ),
    );
    out
}

// ---------------------------------------------------------------------------
// POST /settings/password, /settings/permissions
// ---------------------------------------------------------------------------

/// `POST /user/{id}/settings/password`. The handler reads `user.password`
/// from an entity loaded without it, so the current password is never
/// checked; that is reproduced as is.
fn password<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let id = try_forward!(super::params::path_int(ctx, 2));
        let viewer = try_forward!(own_or_admin(ctx, id));
        let body = try_forward!(body_object(ctx));
        try_forward!(check_fields(
            body,
            &[("currentPassword", &[Kind::Text, Kind::Null])]
        ));
        let Some(new_password) = body.get("newPassword").and_then(Value::as_str) else {
            return Outcome::forward(String::from("newPassword is the validator's"));
        };
        let (user, _) = match try_forward!(load_user(ctx, id).await) {
            Ok(loaded) => loaded,
            Err(outcome) => return outcome,
        };
        if typeorm::js_length(new_password) < 8 {
            return ctx.error(400, "Password must be at least 8 characters.");
        }
        if (user.id == 1 && viewer.id != 1)
            || (has_permission(user.permissions, ADMIN) && user.id != viewer.id && viewer.id != 1)
        {
            return ctx.error(
                403,
                "You do not have permission to modify this user's password.",
            );
        }
        let hash = try_forward!(typeorm::hash_password(new_password.to_owned())
            .await
            .map_err(|e| format!("{e:#}")));
        let mut changes = Changes::default();
        changes.set("password", Value::from(hash));
        if let Err(e) = save(ctx, user.id, &changes, None).await {
            return Outcome::forward(format!("saving the password failed: {e:#}"));
        }
        if viewer.has_permission(MANAGE_USERS) && viewer.id != user.id {
            tracing::debug!("Password overriden by user.");
        }
        Ready::no_content()
    })
}

/// `POST /user/{id}/settings/permissions`.
fn permissions<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let viewer = try_forward!(ctx.authenticated(MANAGE_USERS));
        let id = try_forward!(super::params::path_int(ctx, 2));
        let body = try_forward!(body_object(ctx));
        try_forward!(check_fields(body, &[("permissions", &[Kind::Number])]));
        let Some(permissions) = try_forward!(super::params::body_int(body, "permissions")) else {
            return ctx.error(400, "permissions is required.");
        };
        let (user, _) = match try_forward!(load_user(ctx, id).await) {
            Ok(loaded) => loaded,
            Err(outcome) => return outcome,
        };
        if user.id == 1 || viewer.id == user.id {
            return ctx.error(403, "You do not have permission to modify this user");
        }
        if !can_make_permissions_change(permissions, viewer) {
            return ctx.error(
                403,
                "You do not have permission to grant this level of access",
            );
        }
        let mut changes = Changes::default();
        changes.assign(
            "permissions",
            Some(&Value::from(permissions)),
            &super::userwrite::stored_permissions(&user),
        );
        if let Err(e) = save(ctx, user.id, &changes, None).await {
            return ctx.error(500, &crate::db::failure_message(&e));
        }
        let mut out = Map::new();
        out.insert(String::from("permissions"), Value::from(permissions));
        ctx.json(&Value::Object(out))
    })
}

// ---------------------------------------------------------------------------
// POST /settings/notifications
// ---------------------------------------------------------------------------

/// `UserSettingsNotifications` field types (besides `discordIds` and
/// `notificationTypes`).
const NOTIFICATION_FIELDS: [(&str, &[Kind]); 13] = [
    ("emailEnabled", &[Kind::Bool]),
    ("pgpKey", &[Kind::Text, Kind::Null]),
    ("discordEnabled", &[Kind::Bool]),
    ("discordEnabledTypes", &[Kind::Number, Kind::Null]),
    ("pushbulletAccessToken", &[Kind::Text, Kind::Null]),
    ("pushoverApplicationToken", &[Kind::Text, Kind::Null]),
    ("pushoverUserKey", &[Kind::Text, Kind::Null]),
    ("pushoverSound", &[Kind::Text, Kind::Null]),
    ("telegramEnabled", &[Kind::Bool]),
    ("telegramBotUsername", &[Kind::Text, Kind::Null]),
    ("telegramChatId", &[Kind::Text, Kind::Null]),
    ("telegramMessageThreadId", &[Kind::Text, Kind::Null]),
    ("telegramSendSilently", &[Kind::Bool, Kind::Null]),
];

/// The plain columns `/settings/notifications` copies from the body, in
/// response order (`pgpKey` and `discordIds` come first, separately).
const NOTIFICATION_COLUMNS: [&str; 7] = [
    "pushbulletAccessToken",
    "pushoverApplicationToken",
    "pushoverUserKey",
    "pushoverSound",
    "telegramChatId",
    "telegramMessageThreadId",
    "telegramSendSilently",
];

/// The validated body parts of `/settings/notifications`.
struct NotificationBody<'b> {
    body: &'b Map<String, Value>,
    discord_ids: Vec<Value>,
    types: Option<&'b Map<String, Value>>,
}

fn notification_body(body: &Map<String, Value>) -> Result<NotificationBody<'_>, super::Fallback> {
    let discord_ids = match body.get("discordIds") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(ids)) if ids.iter().all(Value::is_string) => ids
            .iter()
            .filter(|id| id.as_str() != Some(""))
            .cloned()
            .collect(),
        Some(_) => return Err(String::from("discordIds that aren't strings").into()),
    };
    check_fields(body, &NOTIFICATION_FIELDS)?;
    let types = match body.get("notificationTypes") {
        None => None,
        Some(Value::Object(types)) if types.values().all(|v| v.as_i64().is_some()) => Some(types),
        Some(_) => return Err(String::from("notificationTypes this port doesn't take").into()),
    };
    Ok(NotificationBody {
        body,
        discord_ids,
        types,
    })
}

/// `POST /user/{id}/settings/notifications`.
fn notifications<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let id = try_forward!(super::params::path_int(ctx, 2));
        let viewer = try_forward!(own_or_admin(ctx, id));
        let body = try_forward!(body_object(ctx));
        let parsed = try_forward!(notification_body(body));
        let (user, settings) = match try_forward!(load_user(ctx, id).await) {
            Ok(loaded) => loaded,
            Err(outcome) => return outcome,
        };
        if user.id == 1 && viewer.id != 1 {
            return ctx.error(403, OWNER_ONLY);
        }
        let out = match settings.as_ref() {
            Some(s) => try_forward!(update_notifications(ctx, s, &parsed).await),
            // `new UserSettings({ user: req.user })`, but the cascade from
            // the saved user writes the row as theirs.
            None => try_forward!(insert_notifications(ctx, &user, &parsed).await),
        };
        ctx.json(&Value::Object(out))
    })
}

/// The existing row: assign, merge the types, save the differences.
async fn update_notifications(
    ctx: &Ready<'_>,
    s: &UserSettingsRecord,
    parsed: &NotificationBody<'_>,
) -> Result<Map<String, Value>, String> {
    let body = parsed.body;
    let mut types = match crate::user::notification_types(s.public.notification_types.as_deref()) {
        Ok(Value::Object(types)) => types,
        Ok(_) => Map::new(),
        Err(why) => return Err(why.to_owned()),
    };
    let stored_types = typeorm::notification_types_to(&mut types.clone());
    if let Some(new) = parsed.types {
        for (k, v) in new {
            types.insert(k.clone(), v.clone());
        }
    }
    let new_types = typeorm::notification_types_to(&mut types);
    let mut changes = Changes::default();
    changes.assign("pgpKey", body.get("pgpKey"), &text(s.pgp_key.as_ref()));
    // `jsonArrayTransformer`: the stored side compares as `to(from(raw))`,
    // and a `null` there makes any array a change.
    let stored_ids = typeorm::json_array_to(&crate::user::discord_ids(s.discord_ids.as_deref()));
    let new_ids = typeorm::discord_ids_to(&parsed.discord_ids);
    if stored_ids.is_null() || !typeorm::strict_eq(&new_ids, &stored_ids) {
        changes.set("discordIds", new_ids);
    }
    let olds = [
        text(s.pushbullet_access_token.as_ref()),
        text(s.pushover_application_token.as_ref()),
        text(s.pushover_user_key.as_ref()),
        text(s.pushover_sound.as_ref()),
        text(s.telegram_chat_id.as_ref()),
        text(s.telegram_message_thread_id.as_ref()),
        flag(s.telegram_send_silently),
    ];
    for (key, old) in NOTIFICATION_COLUMNS.iter().zip(olds.iter()) {
        changes.assign(key, body.get(*key), old);
    }
    if new_types != stored_types {
        changes.set("notificationTypes", Value::from(new_types));
    }
    let written = changes.any() || typeorm::settings_change_by_itself(s);
    let update = changes
        .update_sql("user_settings", s.id, false)
        .map_err(|e| format!("{e:#}"))?;
    typeorm::run(&ctx.state.db, update)
        .await
        .map_err(|e| format!("saving the settings failed: {e:#}"))?;
    let mut out = Map::new();
    echoed(&mut out, "pgpKey", body.get("pgpKey"), written);
    out.insert(
        String::from("discordIds"),
        Value::Array(parsed.discord_ids.clone()),
    );
    for key in NOTIFICATION_COLUMNS {
        echoed(&mut out, key, body.get(key), written);
    }
    out.insert(String::from("notificationTypes"), Value::Object(types));
    Ok(out)
}

/// No row yet: the cascade inserts one from the body.
async fn insert_notifications(
    ctx: &Ready<'_>,
    user: &UserRecord,
    parsed: &NotificationBody<'_>,
) -> Result<Map<String, Value>, String> {
    let body = parsed.body;
    let field = |k: &str| body.get(k).cloned().unwrap_or(Value::Null);
    let types = parsed.types.map(|t| {
        let mut t = t.clone();
        let stored = typeorm::notification_types_to(&mut t);
        (t, stored)
    });
    let mut columns: Vec<(&str, Value)> = vec![
        ("locale", Value::from("")),
        ("pgpKey", field("pgpKey")),
        ("discordIds", typeorm::discord_ids_to(&parsed.discord_ids)),
    ];
    for key in NOTIFICATION_COLUMNS {
        if key != "pushoverSound" {
            columns.push((key, field(key)));
        }
    }
    columns.push((
        "notificationTypes",
        types
            .as_ref()
            .map_or(Value::Null, |(_, stored)| Value::from(stored.as_str())),
    ));
    columns.push(("userId", Value::from(user.id)));
    typeorm::insert(&ctx.state.db, "user_settings", &columns)
        .await
        .map_err(|e| format!("creating the settings failed: {e:#}"))?;
    let mut out = Map::new();
    out.insert(String::from("pgpKey"), field("pgpKey"));
    out.insert(
        String::from("discordIds"),
        Value::Array(parsed.discord_ids.clone()),
    );
    for key in NOTIFICATION_COLUMNS {
        let value = if key == "pushoverSound" {
            Value::Null
        } else {
            field(key)
        };
        out.insert(String::from(key), value);
    }
    out.insert(
        String::from("notificationTypes"),
        types.map_or(Value::Null, |(t, _)| Value::Object(t)),
    );
    Ok(out)
}

// ---------------------------------------------------------------------------
// POST /settings/discover
// ---------------------------------------------------------------------------

/// Whether the validator lets these filter defaults through: known keys
/// with the schema's types (an empty string passes it, zod rejects it).
fn filter_schema_ok(body: &Map<String, Value>) -> bool {
    body.iter().all(|(k, v)| {
        let mut probe = Map::new();
        let v = if v.as_str() == Some("") {
            Value::from("x")
        } else {
            v.clone()
        };
        probe.insert(k.clone(), v);
        typeorm::parse_filter_defaults(&probe).is_some()
    })
}

/// `POST /user/{id}/settings/discover`.
fn discover<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let id = try_forward!(super::params::path_int(ctx, 2));
        let viewer = try_forward!(own_or_admin(ctx, id));
        let body = try_forward!(body_object(ctx));
        if !filter_schema_ok(body) {
            return Outcome::forward(String::from("keys or types the validator rejects"));
        }
        let exists = try_db!(
            ctx.state
                .db
                .scalar(
                    r#"SELECT COUNT(*) FROM "user" WHERE "id" = ?1"#,
                    &[Bind::Int(id)],
                )
                .await
        );
        if exists == 0 {
            return ctx.error(404, "User not found.");
        }
        if id == 1 && viewer.id != 1 {
            return ctx.error(403, OWNER_ONLY);
        }
        let Some(parsed) = typeorm::parse_filter_defaults(body) else {
            return ctx.error(400, "Invalid discover filter defaults.");
        };
        let Some(settings_id) = try_db!(typeorm::ensure_user_settings(&ctx.state.db, id).await)
        else {
            return ctx.error(500, "User not found");
        };
        let stored = try_db!(
            ctx.state
                .db
                .rows(
                    r#"SELECT "discoverFilterDefaults" FROM "user_settings" WHERE "id" = ?1"#,
                    &[Bind::Int(settings_id)],
                )
                .await
        );
        let stored = stored
            .first()
            .and_then(|r| r.get("discoverFilterDefaults"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let as_stored = |m: &Value| match m {
            Value::Object(m) if !m.is_empty() => {
                Value::from(serde_json::to_string(m).unwrap_or_default())
            }
            Value::Object(_)
            | Value::Null
            | Value::Bool(_)
            | Value::Number(_)
            | Value::String(_)
            | Value::Array(_) => Value::Null,
        };
        let old = as_stored(&crate::user::discover_filter_defaults(stored.as_deref()));
        let new = as_stored(&Value::Object(parsed.clone()));
        if old.is_null() || !typeorm::strict_eq(&new, &old) {
            let mut changes = Changes::default();
            changes.set("discoverFilterDefaults", new);
            let update = try_forward!(changes
                .update_sql("user_settings", settings_id, false)
                .map_err(|e| format!("{e:#}")));
            if let Err(e) = typeorm::run(&ctx.state.db, update).await {
                return ctx.error(500, &format!("{e:#}"));
            }
        }
        ctx.json(&Value::Object(parsed))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn echo_rules() {
        let mut out = Map::new();
        echoed(&mut out, "a", Some(&json!("x")), false);
        echoed(&mut out, "b", None, true);
        echoed(&mut out, "c", None, false);
        assert_eq!(
            Value::Object(out),
            json!({"a": "x", "b": null}),
            "assigned, null-filled, omitted"
        );
    }

    #[test]
    fn main_settings_for_a_new_row() {
        let body = json!({"discoverRegion": "US", "autoCompleteSkippedEpisodeEndings": null});
        let body = body.as_object().cloned().unwrap_or_default();
        let out = main_settings_json(&body, None, true, None, Some(80));
        assert_eq!(
            serde_json::to_string(&out).unwrap_or_default(),
            r#"{"locale":"","discoverRegion":"US","streamingRegion":null,"originalLanguage":null,"watchlistSyncMovies":null,"watchlistSyncTv":null,"autoCompleteSkippedEpisodeEndings":null,"autoCompleteSkippedEpisodeThreshold":50,"watchAheadEpisodeCount":50}"#,
            "defaults and clamping"
        );
    }

    #[test]
    fn notification_body_checks() {
        let body = json!({"discordIds": ["1", "", "2"], "notificationTypes": {"email": 4}});
        let body = body.as_object().cloned().unwrap_or_default();
        let parsed = notification_body(&body);
        assert_eq!(
            parsed.as_ref().map(|p| p.discord_ids.clone()).ok(),
            Some(vec![json!("1"), json!("2")]),
            "empty ids dropped"
        );
        let bad = json!({"discordIds": [1]});
        let bad = bad.as_object().cloned().unwrap_or_default();
        assert!(notification_body(&bad).is_err(), "non-string ids");
    }

    #[test]
    fn filter_schema() {
        let ok = json!({"genre": "", "ignoreWatched": true});
        assert!(
            filter_schema_ok(&ok.as_object().cloned().unwrap_or_default()),
            "empty strings pass the validator"
        );
        let bad = json!({"ignoreWatched": ""});
        assert!(
            !filter_schema_ok(&bad.as_object().cloned().unwrap_or_default()),
            "a string for a boolean"
        );
    }
}
