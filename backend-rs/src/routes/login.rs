//! `POST /auth/local` and `POST /auth/logout`, with sessions stored the
//! way `express-session` and `connect-typeorm` store them.

use std::future::Future;
use std::pin::Pin;

use axum::http::{header, HeaderValue};
use serde_json::{Map, Value};

use super::{Outcome, Ready};
use crate::auth::{now_ms, session_id};
use crate::db::Bind;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

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

/// `POST /auth/local`: a password sign-in that starts a new session.
pub(super) fn local<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let Some(Value::Object(body)) = &ctx.body else {
            return Outcome::forward(String::from("a body that isn't an object"));
        };
        let (Some(Value::String(email)), Some(Value::String(password))) =
            (body.get("email"), body.get("password"))
        else {
            return Outcome::forward(String::from("email and password are the validator's"));
        };
        let mut error = Map::new();
        if !crate::settings::public::truthy(ctx.settings.get("/main/localLogin")) {
            error.insert(
                String::from("error"),
                Value::from("Password sign-in is disabled."),
            );
            return ctx.json_with(500, &Value::Object(error));
        }
        if email.is_empty() || password.is_empty() {
            error.insert(
                String::from("error"),
                Value::from("You must provide both an email address and a password."),
            );
            return ctx.json_with(500, &Value::Object(error));
        }
        // `email.toLowerCase()`: the same Unicode case mapping (final
        // sigma included) as Rust's.
        let account = try_db!(ctx.state.db.login_account(&email.to_lowercase()).await);
        let Some(account) = account else {
            return ctx.error(403, "Access denied.");
        };
        let Some(hash) = account.password.as_deref().filter(|h| !h.is_empty()) else {
            return ctx.error(403, "Access denied.");
        };
        if !hash.starts_with("$2") {
            return Outcome::forward(String::from("a password hash that isn't bcrypt"));
        }
        let matched = crate::typeorm::verify_password(password, hash.to_owned()).await;
        let Ok(matched) = matched else {
            return Outcome::forward(String::from("the stored hash couldn't be checked"));
        };
        if !matched {
            return ctx.error(403, "Access denied.");
        }
        let cookie = match start_session(ctx, account.id).await {
            Ok(cookie) => cookie,
            Err(why) => return Outcome::forward(why),
        };
        let email = account.email.unwrap_or_default().to_lowercase();
        let mut out = Map::new();
        out.insert(String::from("id"), Value::from(account.id));
        out.insert(String::from("email"), Value::from(email.as_str()));
        out.insert(String::from("displayName"), Value::from(email.as_str()));
        out.insert(String::from("permissions"), Value::from(0));
        out.insert(
            String::from("requestCount"),
            Value::from(account.request_count),
        );
        out.insert(String::from("warnings"), Value::Array(Vec::new()));
        out.insert(
            String::from("plexId"),
            account.plex_id.map_or(Value::Null, Value::from),
        );
        let mut outcome = ctx.json(&Value::Object(out));
        if let Outcome::Done(res) = &mut outcome {
            if let Some(Ok(value)) = cookie.as_deref().map(HeaderValue::from_str) {
                res.headers_mut().append(header::SET_COOKIE, value);
            }
        }
        outcome
    })
}

/// `req.session.userId = user_id` and express-session's save: the
/// `Set-Cookie` value, `None` when the session already was the user's
/// (`src/runtime/session.rs`).
pub(super) async fn start_session(ctx: &Ready<'_>, user_id: i64) -> Result<Option<String>, String> {
    // A session the desktop restore made for this request is the one
    // express-session saves (`req.session` already carries it).
    let headers = crate::runtime::desktop::session_headers(ctx.req);
    crate::runtime::session::sign_in(ctx.state, &ctx.settings, &headers, user_id)
        .await
        .map(|saved| saved.cookie)
}

/// `POST /auth/logout`: soft-deletes the session; Jellyfin and Emby
/// installs also unregister the user's device first.
pub(super) fn logout<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        try_forward!(ctx.credential_present());
        crate::runtime::desktop::forget();
        let mut ok = Map::new();
        ok.insert(String::from("status"), Value::from("ok"));
        let headers = crate::runtime::desktop::session_headers(ctx.req);
        let Some(sid) = session_id(&headers, ctx.settings.session_secret()) else {
            return ctx.json(&Value::Object(ok));
        };
        let session = try_db!(ctx.state.db.session_user_id(&sid, now_ms()).await);
        let user_id = session.and_then(|s| s.user_id).filter(|id| *id != 0);
        if user_id.is_none() {
            return ctx.json(&Value::Object(ok));
        }
        let server_type = ctx
            .settings
            .get("/main/mediaServerType")
            .and_then(Value::as_i64);
        // The plugin's Jellyfin owns the device; Node leaves it alone there.
        let plugin = crate::runtime::active() && crate::runtime::plugin_mode();
        if let (Some(2 | 3), Some(user_id), false) = (server_type, user_id, plugin) {
            try_forward!(super::authjellyfin::forget_device(ctx, user_id).await);
        }
        try_db!(
            ctx.state
                .db
                .execute(
                    r#"UPDATE "session" SET "destroyedAt" = CURRENT_TIMESTAMP WHERE "id" = ?1 AND "destroyedAt" IS NULL"#,
                    &[Bind::Text(sid)],
                )
                .await
        );
        ctx.json(&Value::Object(ok))
    })
}
