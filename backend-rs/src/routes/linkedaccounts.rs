//! Linked-account routes from `server/routes/user/usersettings.ts`.
//!
//! The media-action toggles, unlinking Trakt, Simkl, `AniList`, Plex and
//! Jellyfin, the `AniList` status and PIN link, and `/watch_data` (its
//! Tautulli lookups in [`super::userwatchdata`]).

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use axum::http::Method;
use serde_json::{Map, Value};

use super::userwrite::{
    body_object, invalidate_sync_cache, own_or_admin, own_profile, SERVER_EMBY, SERVER_JELLYFIN,
};
use super::{Outcome, Ready, Table};
use crate::db::Bind;
use crate::settings::public::truthy;
use crate::typeorm::{self, Changes};

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

const TRAKT: &str = "/api/v1/user/{id}/settings/linked-accounts/trakt";
const SIMKL: &str = "/api/v1/user/{id}/settings/linked-accounts/simkl";
const ANILIST: &str = "/api/v1/user/{id}/settings/linked-accounts/anilist";
const PLEX: &str = "/api/v1/user/{id}/settings/linked-accounts/plex";
const JELLYFIN: &str = "/api/v1/user/{id}/settings/linked-accounts/jellyfin";

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    (TRAKT, Method::PATCH, trakt_patch),
    (TRAKT, Method::DELETE, trakt_delete),
    (SIMKL, Method::PATCH, simkl_patch),
    (SIMKL, Method::DELETE, simkl_delete),
    (ANILIST, Method::GET, anilist_get),
    (ANILIST, Method::PATCH, anilist_patch),
    (ANILIST, Method::POST, anilist_link),
    (ANILIST, Method::DELETE, anilist_delete),
    (PLEX, Method::DELETE, plex_delete),
    (JELLYFIN, Method::DELETE, jellyfin_delete),
    ("/api/v1/user/{id}/watch_data", Method::GET, watch_data),
];

macro_rules! try_forward {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(why) => return Outcome::forward(why),
        }
    };
}

/// `PLEX` in `MediaServerType`, `LOCAL` in `UserType`.
const SERVER_PLEX: i64 = 1;
const USER_TYPE_LOCAL: i64 = 2;

const ANILIST_AUTHORIZE_URL: &str = "https://anilist.co/api/v2/oauth/authorize";
const ANILIST_TOKEN_URL: &str = "https://anilist.co/api/v2/oauth/token";
const ANILIST_PIN_REDIRECT: &str = "https://anilist.co/api/v2/oauth/pin";
const ANILIST_GRAPHQL_URL: &str = "https://graphql.anilist.co";
const ANILIST_TOKEN_TTL_FALLBACK_SECONDS: f64 = 365.0 * 24.0 * 60.0 * 60.0;
const VIEWER_QUERY: &str = "\n  query Viewer {\n    Viewer { id name }\n  }\n";
/// The user agent of a bare `axios.create()` client (the `AniList` token
/// exchange doesn't add Foreseerr's).
const AXIOS_USER_AGENT: &str = "axios/1.18.0";

/// The `{id}` of `/user/{id}/settings/linked-accounts/<name>`.
fn linked_id(ctx: &Ready<'_>) -> Result<i64, super::Fallback> {
    super::params::path_int(ctx, 3)
}

fn message(text: &str) -> Value {
    let mut out = Map::new();
    out.insert(String::from("message"), Value::from(text));
    Value::Object(out)
}

// ---------------------------------------------------------------------------
// Media-action toggles
// ---------------------------------------------------------------------------

/// What `patchLinkedAccountActions` decided before the payload is built.
enum Patched {
    Done,
    Answer(Outcome),
}

/// `patchLinkedAccountActions`: the owner check, then `ensureUserSettings`
/// and an unconditional update of the toggle. `missing_status` is the
/// status the route gives "User not found". Once the settings row may be
/// written, failures are answered here (500).
async fn patch_actions(
    ctx: &Ready<'_>,
    id: i64,
    viewer_id: i64,
    column: &str,
    missing_status: u16,
) -> Result<Patched, String> {
    let body = body_object(ctx)?;
    let Some(enabled) = body.get("actionsEnabled").and_then(Value::as_bool) else {
        return Err(String::from("actionsEnabled is the validator's"));
    };
    if id == 1 && viewer_id != 1 {
        return Ok(Patched::Answer(ctx.error(
            403,
            "You do not have permission to modify this user's settings.",
        )));
    }
    let settings_id = match typeorm::ensure_user_settings(&ctx.state.db, id).await {
        Ok(settings_id) => settings_id,
        Err(e) => return Ok(Patched::Answer(write_failed(ctx, &e))),
    };
    let Some(settings_id) = settings_id else {
        return Ok(Patched::Answer(ctx.error(missing_status, "User not found")));
    };
    let sql = format!(
        "UPDATE \"user_settings\" SET \"{column}\" = {} WHERE \"id\" = ?1",
        if enabled { "TRUE" } else { "FALSE" }
    );
    if let Err(e) = ctx.state.db.execute(&sql, &[Bind::Int(settings_id)]).await {
        return Ok(Patched::Answer(write_failed(ctx, &e)));
    }
    Ok(Patched::Done)
}

/// The 500 for a failed write: answered here, never handed on.
fn write_failed(ctx: &Ready<'_>, e: &anyhow::Error) -> Outcome {
    let why = format!("database: {e:#}");
    tracing::error!("{} {}: {why}", ctx.req.method, ctx.req.uri.path());
    ctx.error(500, &why)
}

/// `getTraktLinkedAccountPayload` for the direct provider.
async fn trakt_payload(ctx: &Ready<'_>, id: i64) -> anyhow::Result<Value> {
    let row = ctx.state.db.linked_accounts(id).await?.unwrap_or_default();
    let connected = row.trakt_access && row.trakt_refresh;
    let mut out = Map::new();
    out.insert(String::from("provider"), Value::from("direct"));
    out.insert(String::from("connected"), Value::Bool(connected));
    out.insert(
        String::from("username"),
        if connected {
            row.trakt_username.map_or(Value::Null, Value::from)
        } else {
            Value::Null
        },
    );
    out.insert(
        String::from("actionsEnabled"),
        Value::Bool(row.trakt_actions != Some(false)),
    );
    Ok(Value::Object(out))
}

/// `getSimklLinkedAccountPayload`.
async fn simkl_payload(ctx: &Ready<'_>, id: i64) -> anyhow::Result<Value> {
    let row = ctx.state.db.linked_accounts(id).await?.unwrap_or_default();
    let mut out = Map::new();
    out.insert(String::from("connected"), Value::Bool(row.simkl_access));
    out.insert(
        String::from("username"),
        if row.simkl_access {
            row.simkl_username.map_or(Value::Null, Value::from)
        } else {
            Value::Null
        },
    );
    out.insert(
        String::from("actionsEnabled"),
        Value::Bool(row.simkl_actions != Some(false)),
    );
    Ok(Value::Object(out))
}

fn jellyfin_trakt(ctx: &Ready<'_>) -> bool {
    ctx.settings.str("/trakt/provider") == "jellyfin"
}

/// `PATCH .../linked-accounts/trakt`.
fn trakt_patch<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let id = try_forward!(linked_id(ctx));
        let viewer = try_forward!(own_or_admin(ctx, id));
        match try_forward!(patch_actions(ctx, id, viewer.id, "mediaActionsTraktEnabled", 404).await)
        {
            Patched::Answer(outcome) => outcome,
            Patched::Done if jellyfin_trakt(ctx) => {
                let actions = match ctx.state.db.linked_accounts(id).await {
                    Ok(row) => row.unwrap_or_default().trakt_actions != Some(false),
                    Err(e) => return ctx.error(500, &format!("{e:#}")),
                };
                match super::bettertrakt::linked_payload(ctx, id, false, actions).await {
                    Ok(payload) => ctx.json(&payload),
                    Err(e) => ctx.error(500, &format!("{e:#}")),
                }
            }
            Patched::Done => match trakt_payload(ctx, id).await {
                Ok(payload) => ctx.json(&payload),
                Err(e) => ctx.error(500, &format!("{e:#}")),
            },
        }
    })
}

/// `PATCH .../linked-accounts/simkl`.
fn simkl_patch<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let id = try_forward!(linked_id(ctx));
        let viewer = try_forward!(own_or_admin(ctx, id));
        match try_forward!(patch_actions(ctx, id, viewer.id, "mediaActionsSimklEnabled", 500).await)
        {
            Patched::Answer(outcome) => outcome,
            Patched::Done => match simkl_payload(ctx, id).await {
                Ok(payload) => ctx.json(&payload),
                Err(e) => ctx.error(500, &format!("{e:#}")),
            },
        }
    })
}

/// `PATCH .../linked-accounts/anilist`.
fn anilist_patch<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let id = try_forward!(linked_id(ctx));
        let viewer = try_forward!(own_or_admin(ctx, id));
        match try_forward!(
            patch_actions(ctx, id, viewer.id, "mediaActionsAnilistEnabled", 404).await
        ) {
            Patched::Answer(outcome) => outcome,
            Patched::Done => match anilist_payload(ctx, id).await {
                Ok(payload) => ctx.json(&payload),
                Err(e) => ctx.error(500, &format!("{e:#}")),
            },
        }
    })
}

// ---------------------------------------------------------------------------
// Unlinking
// ---------------------------------------------------------------------------

/// Set these settings columns to NULL on the user's row, if there is one.
/// Returns whether there was a row; `Err` is the handler's answer (a
/// failed update is a 500, not handed on).
async fn clear_settings(ctx: &Ready<'_>, id: i64, columns: &[&str]) -> Result<bool, Outcome> {
    let settings_id = match typeorm::settings_id(&ctx.state.db, id).await {
        Ok(settings_id) => settings_id,
        Err(e) => return Err(Outcome::forward(format!("database: {e:#}"))),
    };
    let Some(settings_id) = settings_id else {
        return Ok(false);
    };
    let sets: Vec<String> = columns.iter().map(|c| format!("\"{c}\" = NULL")).collect();
    let sql = format!(
        "UPDATE \"user_settings\" SET {} WHERE \"id\" = ?1",
        sets.join(", ")
    );
    match ctx.state.db.execute(&sql, &[Bind::Int(settings_id)]).await {
        Ok(_) => Ok(true),
        Err(e) => Err(write_failed(ctx, &e)),
    }
}

/// `DELETE .../linked-accounts/trakt`.
fn trakt_delete<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let id = try_forward!(linked_id(ctx));
        try_forward!(own_or_admin(ctx, id));
        if jellyfin_trakt(ctx) {
            return ctx.json_with(
                409,
                &message("Trakt is provided by Better Trakt through Jellyfin. Unlink it from Jellyfin instead."),
            );
        }
        let cleared = clear_settings(
            ctx,
            id,
            &[
                "traktAccessToken",
                "traktRefreshToken",
                "traktTokenExpiresAt",
                "traktUsername",
                "traktUserId",
            ],
        )
        .await;
        match cleared {
            Ok(true) => {
                invalidate_sync_cache(ctx, id, "trakt").await;
                Ready::no_content()
            }
            Ok(false) => Ready::no_content(),
            Err(outcome) => outcome,
        }
    })
}

/// `DELETE .../linked-accounts/anilist`.
fn anilist_delete<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let id = try_forward!(linked_id(ctx));
        try_forward!(own_or_admin(ctx, id));
        let cleared = clear_settings(
            ctx,
            id,
            &[
                "anilistAccessToken",
                "anilistTokenExpiresAt",
                "anilistUsername",
                "anilistUserId",
            ],
        )
        .await;
        match cleared {
            Ok(true) => {
                invalidate_sync_cache(ctx, id, "anilist").await;
                Ready::no_content()
            }
            Ok(false) => Ready::no_content(),
            Err(outcome) => outcome,
        }
    })
}

/// `DELETE .../linked-accounts/simkl`: the credentials and the local
/// Simkl library mirror.
fn simkl_delete<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let id = try_forward!(linked_id(ctx));
        try_forward!(own_or_admin(ctx, id));
        let cleared = match clear_settings(
            ctx,
            id,
            &["simklAccessToken", "simklUsername", "simklUserId"],
        )
        .await
        {
            Ok(cleared) => cleared,
            Err(outcome) => return outcome,
        };
        if cleared {
            for table in ["simkl_sync_item", "simkl_sync_state"] {
                let sql = format!("DELETE FROM \"{table}\" WHERE \"userId\" = ?1");
                if let Err(e) = ctx.state.db.execute(&sql, &[Bind::Int(id)]).await {
                    return ctx.error(500, &format!("{e:#}"));
                }
            }
        }
        Ready::no_content()
    })
}

/// The media server unlink checks shared by Plex and Jellyfin: the user
/// (with its password), not the owner, with a local email and password.
async fn unlink_target(
    ctx: &Ready<'_>,
    id: i64,
) -> Result<Result<Map<String, Value>, Outcome>, String> {
    let rows = ctx
        .state
        .db
        .rows(
            r#"SELECT CAST("id" AS BIGINT) AS "id", "email", "password", CAST("userType" AS BIGINT) AS "userType", CAST("plexId" AS BIGINT) AS "plexId", "plexUsername", "jellyfinUserId", "jellyfinUsername" FROM "user" WHERE "id" = ?1"#,
            &[Bind::Int(id)],
        )
        .await
        .map_err(|e| format!("database: {e:#}"))?;
    let Some(row) = rows.into_iter().next() else {
        return Ok(Err(ctx.json_with(404, &message("User not found."))));
    };
    if id == 1 {
        return Ok(Err(ctx.json_with(
            400,
            &message("Cannot unlink media server accounts for the primary administrator."),
        )));
    }
    let filled = |k: &str| {
        row.get(k)
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty())
    };
    if !filled("email") || !filled("password") {
        return Ok(Err(ctx.json_with(
            400,
            &message("User does not have a local email or password set."),
        )));
    }
    Ok(Ok(row))
}

/// Save an unlink: the selected columns compare with the row, the hidden
/// ones always count as changed (the reloaded row doesn't have them).
async fn save_unlink(
    ctx: &Ready<'_>,
    id: i64,
    row: &Map<String, Value>,
    visible: &[&'static str],
    hidden: &[&'static str],
) -> Outcome {
    let mut changes = Changes::default();
    changes.assign(
        "userType",
        Some(&Value::from(USER_TYPE_LOCAL)),
        row.get("userType").unwrap_or(&Value::Null),
    );
    for column in visible {
        changes.assign(
            column,
            Some(&Value::Null),
            row.get(*column).unwrap_or(&Value::Null),
        );
    }
    for column in hidden {
        changes.set(column, Value::Null);
    }
    let update = match changes.update_sql("user", id, true) {
        Ok(update) => update,
        Err(e) => return Outcome::forward(format!("{e:#}")),
    };
    match typeorm::run(&ctx.state.db, update).await {
        Ok(()) => Ready::no_content(),
        Err(e) => write_failed(ctx, &e),
    }
}

/// `DELETE .../linked-accounts/plex`.
fn plex_delete<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let id = try_forward!(linked_id(ctx));
        try_forward!(own_or_admin(ctx, id));
        if ctx
            .settings
            .get("/main/mediaServerType")
            .and_then(Value::as_i64)
            != Some(SERVER_PLEX)
        {
            return ctx.json_with(500, &message("Plex login is disabled"));
        }
        let row = match try_forward!(unlink_target(ctx, id).await) {
            Ok(row) => row,
            Err(outcome) => return outcome,
        };
        save_unlink(ctx, id, &row, &["plexId", "plexUsername"], &["plexToken"]).await
    })
}

/// `DELETE .../linked-accounts/jellyfin`.
fn jellyfin_delete<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let id = try_forward!(linked_id(ctx));
        try_forward!(own_or_admin(ctx, id));
        let server = ctx
            .settings
            .get("/main/mediaServerType")
            .and_then(Value::as_i64);
        if server != Some(SERVER_JELLYFIN) && server != Some(SERVER_EMBY) {
            return ctx.json_with(500, &message("Jellyfin/Emby login is disabled"));
        }
        let row = match try_forward!(unlink_target(ctx, id).await) {
            Ok(row) => row,
            Err(outcome) => return outcome,
        };
        save_unlink(
            ctx,
            id,
            &row,
            &["jellyfinUserId", "jellyfinUsername"],
            &["jellyfinAuthToken", "jellyfinDeviceId"],
        )
        .await
    })
}

// ---------------------------------------------------------------------------
// AniList
// ---------------------------------------------------------------------------

/// `getAnilistAppCredentials`: the trimmed client id and secret, or `None`
/// for `AnilistNotConfiguredError`.
fn anilist_credentials(ctx: &Ready<'_>) -> Option<(String, String)> {
    let id = ctx.settings.str("/anilist/clientId").trim().to_owned();
    let secret = ctx.settings.str("/anilist/clientSecret").trim().to_owned();
    (!id.is_empty() && !secret.is_empty()).then_some((id, secret))
}

/// `AnilistAPI.buildAuthorizeUrl`.
fn authorize_url(client_id: &str) -> String {
    format!(
        "{ANILIST_AUTHORIZE_URL}?client_id={}&redirect_uri={}&response_type=code",
        typeorm::form_urlencode(client_id),
        typeorm::form_urlencode(ANILIST_PIN_REDIRECT)
    )
}

/// `Number(value)` for a stored bigint (a number or numeric text).
fn stored_number(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        Value::Null | Value::Bool(_) | Value::Array(_) | Value::Object(_) => None,
    }
}

/// `isAnilistTokenExpired`.
fn anilist_expired(expires_at: Option<&Value>, now_seconds: i64) -> bool {
    let empty = match expires_at {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s.is_empty(),
        Some(Value::Number(n)) => n.as_f64() == Some(0.0),
        Some(_) => false,
    };
    if empty {
        return false;
    }
    let limit: f64 = (now_seconds + 60).to_string().parse().unwrap_or(f64::MAX);
    match stored_number(expires_at) {
        Some(expires) if expires.is_finite() && expires > 0.0 => expires <= limit,
        _ => false,
    }
}

/// `getAnilistLinkedAccountPayload`.
async fn anilist_payload(ctx: &Ready<'_>, id: i64) -> anyhow::Result<Value> {
    let rows = ctx
        .state
        .db
        .rows(
            r#"SELECT "anilistAccessToken", "anilistTokenExpiresAt", "anilistUsername", "mediaActionsAnilistEnabled" FROM "user_settings" WHERE "userId" = ?1"#,
            &[Bind::Int(id)],
        )
        .await?;
    let row = rows.into_iter().next().unwrap_or_default();
    let now = crate::clock::now_millis().div_euclid(1000);
    let has_token = row
        .get("anilistAccessToken")
        .and_then(Value::as_str)
        .is_some_and(|t| !t.is_empty());
    let expired = anilist_expired(row.get("anilistTokenExpiresAt"), now);
    let connected = has_token && !expired;
    let mut out = Map::new();
    out.insert(String::from("connected"), Value::Bool(connected));
    out.insert(String::from("expired"), Value::Bool(has_token && expired));
    out.insert(
        String::from("username"),
        if connected {
            row.get("anilistUsername").cloned().unwrap_or(Value::Null)
        } else {
            Value::Null
        },
    );
    out.insert(
        String::from("authorizeUrl"),
        anilist_credentials(ctx).map_or(Value::Null, |(id, _)| Value::from(authorize_url(&id))),
    );
    // SQLite booleans come back as integers.
    let disabled = matches!(
        row.get("mediaActionsAnilistEnabled"),
        Some(Value::Bool(false))
    ) || row
        .get("mediaActionsAnilistEnabled")
        .and_then(Value::as_i64)
        == Some(0);
    out.insert(String::from("actionsEnabled"), Value::Bool(!disabled));
    Ok(Value::Object(out))
}

/// `GET .../linked-accounts/anilist`.
fn anilist_get<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let id = try_forward!(linked_id(ctx));
        try_forward!(own_or_admin(ctx, id));
        match anilist_payload(ctx, id).await {
            Ok(payload) => ctx.json(&payload),
            Err(e) => Outcome::forward(format!("database: {e:#}")),
        }
    })
}

/// What the `AniList` token exchange and viewer query gave.
struct AnilistLink {
    access_token: String,
    expires_at: Value,
    viewer_id: String,
    viewer_name: Option<Value>,
}

/// `AnilistAPI.exchangePinCode`, then `getViewer()` with the new token.
async fn anilist_exchange(
    ctx: &Ready<'_>,
    client_id: &str,
    client_secret: &str,
    code: &str,
) -> anyhow::Result<AnilistLink> {
    let mut payload = Map::new();
    for (k, v) in [
        ("grant_type", "authorization_code"),
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("redirect_uri", ANILIST_PIN_REDIRECT),
        ("code", code),
    ] {
        payload.insert(String::from(k), Value::from(v));
    }
    let token: Value = ctx
        .state
        .outbound
        .post(ANILIST_TOKEN_URL)
        .timeout(Duration::from_secs(15))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("User-Agent", AXIOS_USER_AGENT)
        .json(&Value::Object(payload))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let access_token = match token.get("access_token") {
        None | Some(Value::Null) => String::new(),
        Some(v) => crate::media::js_string(Some(v)).trim().to_owned(),
    };
    if access_token.is_empty() {
        anyhow::bail!("AniList did not return an access token");
    }
    let expires_in = stored_number(token.get("expires_in"))
        .filter(|n| *n > 0.0)
        .unwrap_or(ANILIST_TOKEN_TTL_FALLBACK_SECONDS);
    let now = crate::clock::now_millis().div_euclid(1000);
    let expires_at = expires_in
        .to_string()
        .parse::<i64>()
        .ok()
        .and_then(|n| now.checked_add(n))
        .map(Value::from)
        .ok_or_else(|| anyhow::anyhow!("a fractional expires_in"))?;
    let mut query = Map::new();
    query.insert(String::from("query"), Value::from(VIEWER_QUERY));
    query.insert(String::from("variables"), Value::Object(Map::new()));
    let response: Value = ctx
        .state
        .outbound
        .post(ANILIST_GRAPHQL_URL)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("Authorization", format!("Bearer {access_token}"))
        .json(&Value::Object(query))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    if response
        .get("errors")
        .and_then(Value::as_array)
        .is_some_and(|e| !e.is_empty())
    {
        anyhow::bail!("AniList GraphQL error");
    }
    let viewer = response
        .pointer("/data/Viewer")
        .ok_or_else(|| anyhow::anyhow!("AniList Viewer query returned no user"))?;
    let viewer_id = match viewer.get("id") {
        Some(Value::Number(n)) if n.as_i64().is_some_and(|n| n != 0) => n.to_string(),
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        _ => anyhow::bail!("AniList Viewer query returned no user"),
    };
    Ok(AnilistLink {
        access_token,
        expires_at,
        viewer_id,
        viewer_name: viewer.get("name").cloned(),
    })
}

/// `POST .../linked-accounts/anilist`: link with a PIN code.
fn anilist_link<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let id = try_forward!(linked_id(ctx));
        // `isOwnProfile()`: `req.user.id !== Number(req.params.id)`.
        if let Err(why) = own_profile(ctx, id) {
            if !ctx.passed() || ctx.authenticated(0).is_err() {
                return Outcome::forward(why);
            }
            return ctx.error(
                403,
                "You do not have permission to view this user's settings.",
            );
        }
        let body = try_forward!(body_object(ctx));
        let Some(code) = body.get("code").and_then(Value::as_str) else {
            return Outcome::forward(String::from("code is the validator's"));
        };
        let Some((client_id, client_secret)) = anilist_credentials(ctx) else {
            return ctx.json_with(
                400,
                &message("AniList application credentials are not configured"),
            );
        };
        let code = code.trim();
        if code.is_empty() {
            return ctx.json_with(400, &message("code is required"));
        }
        let failed = |why: &str| {
            tracing::error!("Failed to complete AniList authorization: {why}");
            ctx.json_with(500, &message("Unable to complete AniList authorization."))
        };
        let link = match anilist_exchange(ctx, &client_id, &client_secret, code).await {
            Ok(link) => link,
            Err(e) => return failed(&format!("{e:#}")),
        };
        let taken = ctx
            .state
            .db
            .scalar(
                r#"SELECT COUNT(*) FROM "user_settings" s LEFT JOIN "user" u ON u."id" = s."userId" WHERE s."anilistUserId" = ?1 AND u."id" != ?2"#,
                &[Bind::Text(link.viewer_id.clone()), Bind::Int(id)],
            )
            .await;
        match taken {
            Ok(0) => {}
            Ok(_) => {
                return ctx.json_with(
                    409,
                    &message("This AniList account is already linked to another Foreseerr user"),
                )
            }
            Err(e) => return failed(&format!("{e:#}")),
        }
        let settings_id = match typeorm::ensure_user_settings(&ctx.state.db, id).await {
            Ok(Some(settings_id)) => settings_id,
            Ok(None) => return failed("User not found"),
            Err(e) => return failed(&format!("{e:#}")),
        };
        let mut changes = Changes::default();
        changes.set("anilistAccessToken", Value::from(link.access_token));
        changes.set("anilistTokenExpiresAt", link.expires_at);
        if let Some(name) = &link.viewer_name {
            changes.set("anilistUsername", name.clone());
        }
        changes.set("anilistUserId", Value::from(link.viewer_id));
        let saved = match changes.update_sql("user_settings", settings_id, false) {
            Ok(update) => typeorm::run(&ctx.state.db, update).await,
            Err(e) => Err(e),
        };
        if let Err(e) = saved {
            return failed(&format!("{e:#}"));
        }
        invalidate_sync_cache(ctx, id, "anilist").await;
        let mut out = Map::new();
        out.insert(String::from("status"), Value::from("authorized"));
        if let Some(name) = link.viewer_name {
            out.insert(String::from("username"), name);
        }
        ctx.json(&Value::Object(out))
    })
}

// ---------------------------------------------------------------------------
// GET /user/{id}/watch_data
// ---------------------------------------------------------------------------

/// `GET /user/{id}/watch_data`: the "not configured" answer, then the
/// Tautulli lookups ([`super::userwatchdata`]).
fn watch_data<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        // Any failure of the lookup lands in the handler's catch, as an
        // unknown user does.
        let id = try_forward!(super::params::path_int(ctx, 1));
        try_forward!(own_or_admin(ctx, id));
        let configured = ["hostname", "port", "apiKey"]
            .iter()
            .all(|k| truthy(ctx.settings.get(&format!("/tautulli/{k}"))));
        if configured {
            return super::userwatchdata::answer(ctx, id).await;
        }
        ctx.error(404, "Tautulli API not configured.")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn anilist_authorize_url() {
        assert_eq!(
            authorize_url("123"),
            "https://anilist.co/api/v2/oauth/authorize?client_id=123&redirect_uri=https%3A%2F%2Fanilist.co%2Fapi%2Fv2%2Foauth%2Fpin&response_type=code",
            "URLSearchParams encoding"
        );
    }

    #[test]
    fn anilist_expiry() {
        assert!(!anilist_expired(None, 1000), "no expiry");
        assert!(!anilist_expired(Some(&json!("")), 1000), "empty");
        assert!(!anilist_expired(Some(&json!(0)), 1000), "zero");
        assert!(anilist_expired(Some(&json!(1050)), 1000), "within a minute");
        assert!(!anilist_expired(Some(&json!("2000")), 1000), "later");
        assert!(!anilist_expired(Some(&json!("abc")), 1000), "not a number");
    }
}
