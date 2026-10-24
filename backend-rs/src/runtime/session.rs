//! express-session as `server/index.ts` mounts it, for the writes made
//! here: signing a user in, the desktop session restore and the plugin's
//! `req.session.regenerate()`.
//!
//! The cookie options depend on the runtime: `path` is the plugin mount
//! (`pluginCookiePath()`), `sameSite` is `strict` in the desktop runtime or
//! with `network.csrfProtection` (read at startup) and `lax` otherwise, and
//! `secure` is off in the desktop runtime and `'auto'` elsewhere, i.e. on
//! when `req.secure` (the first `X-Forwarded-Proto` value is `https` and
//! `trust proxy` is on: always in plugin mode, with `network.trustProxy`
//! outside the desktop runtime).
//!
//! A request whose cookie names a live session keeps it: the user id is
//! written into it and the cookie is sent again with the attributes stored
//! in it, its expiry moved on. A session that already belongs to the user
//! is only touched (no `Set-Cookie`). Without one a new session is stored
//! (`connect-typeorm` first removes two expired rows).

use axum::http::HeaderMap;
use base64::prelude::*;
use serde_json::{Map, Value};

use crate::auth::{now_ms, session_id, sign, SESSION_TTL_MS};
use crate::db::{Bind, Db};
use crate::settings::Settings;
use crate::state::AppState;

/// The cookie a new session gets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CookieOptions {
    /// `cookie.path`.
    pub path: String,
    /// `cookie.sameSite`: `strict` or `lax`.
    pub same_site: &'static str,
    /// `cookie.secure` as decided for this request.
    pub secure: bool,
}

/// `req.secure` behind `trust proxy`: the first `X-Forwarded-Proto` value.
#[must_use]
pub fn forwarded_https(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty())
        .is_some_and(|v| v.split(',').next().map(str::trim) == Some("https"))
}

/// The session cookie's options for a request.
#[must_use]
pub fn options(state: &AppState, headers: &HeaderMap) -> CookieOptions {
    let desktop = super::active() && super::desktop_runtime();
    let plugin = super::active() && super::plugin_mode();
    let trust_proxy = plugin || (!desktop && state.trust_proxy_at_startup());
    CookieOptions {
        path: if plugin {
            super::cookie_path().to_owned()
        } else {
            String::from("/")
        },
        same_site: if desktop || state.csrf_at_startup() {
            "strict"
        } else {
            "lax"
        },
        secure: !desktop && trust_proxy && forwarded_https(headers),
    }
}

/// A session row about to be written and the `Set-Cookie` for it.
#[derive(Debug, Clone)]
pub struct Saved {
    /// The session id.
    pub sid: String,
    /// The `Set-Cookie` value; `None` when express-session wouldn't send
    /// it (the session didn't change).
    pub cookie: Option<String>,
}

/// `req.session.userId = userId` and the save at the end of the request.
///
/// # Errors
///
/// A database failure, or a secret that can't sign.
pub async fn sign_in(
    state: &AppState,
    settings: &Settings,
    headers: &HeaderMap,
    user_id: i64,
) -> Result<Saved, String> {
    let now = now_ms();
    if let Some((sid, json)) = live_session(&state.db, settings, headers, now).await? {
        return update(state, settings, &sid, &json, user_id, now).await;
    }
    create(state, settings, headers, user_id, now).await
}

/// `req.session.regenerate()` (the live session is destroyed) and then
/// `req.session.userId = userId; req.session.save()`.
///
/// # Errors
///
/// As [`sign_in`].
pub async fn regenerate(
    state: &AppState,
    settings: &Settings,
    headers: &HeaderMap,
    user_id: i64,
) -> Result<Saved, String> {
    let now = now_ms();
    if let Some((sid, _)) = live_session(&state.db, settings, headers, now).await? {
        state
            .db
            .execute(
                r#"UPDATE "session" SET "destroyedAt" = CURRENT_TIMESTAMP WHERE "id" = ?1 AND "destroyedAt" IS NULL"#,
                &[Bind::Text(sid)],
            )
            .await
            .map_err(|e| db_error(&e))?;
    }
    create(state, settings, headers, user_id, now).await
}

fn db_error(e: &anyhow::Error) -> String {
    format!("database: {e:#}")
}

/// The id and stored JSON of the session the request's cookie names, when
/// it is live.
async fn live_session(
    db: &Db,
    settings: &Settings,
    headers: &HeaderMap,
    now: i64,
) -> Result<Option<(String, String)>, String> {
    let Some(sid) = session_id(headers, settings.session_secret()) else {
        return Ok(None);
    };
    let rows = db
        .rows(
            r#"SELECT "json" FROM "session" WHERE "id" = ?1 AND "expiredAt" > ?2 AND "destroyedAt" IS NULL"#,
            &[Bind::Text(sid.clone()), Bind::Int(now)],
        )
        .await
        .map_err(|e| db_error(&e))?;
    Ok(rows.into_iter().next().and_then(|row| {
        row.get("json")
            .and_then(Value::as_str)
            .map(|json| (sid, json.to_owned()))
    }))
}

/// A new session for `user_id`.
async fn create(
    state: &AppState,
    settings: &Settings,
    headers: &HeaderMap,
    user_id: i64,
    now: i64,
) -> Result<Saved, String> {
    let options = options(state, headers);
    let mut bytes = [0_u8; 24];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes)
        .map_err(|_| String::from("no randomness for a session id"))?;
    let sid = BASE64_URL_SAFE_NO_PAD.encode(bytes);
    let cookie = StoredCookie {
        original_max_age: Value::from(SESSION_TTL_MS),
        secure: options.secure,
        http_only: true,
        path: options.path,
        same_site: Value::from(options.same_site),
        expires: now + SESSION_TTL_MS,
    };
    let mut session = Map::new();
    session.insert(String::from("cookie"), cookie.json());
    session.insert(String::from("userId"), Value::from(user_id));
    let db = &state.db;
    db.execute(
        r#"DELETE FROM "session" WHERE "id" IN (SELECT "id" FROM "session" WHERE "expiredAt" <= ?1 LIMIT 2)"#,
        &[Bind::Int(now)],
    )
    .await
    .map_err(|e| db_error(&e))?;
    db.execute(
        r#"INSERT INTO "session" ("expiredAt", "id", "json") VALUES (?1, ?2, ?3)"#,
        &[
            Bind::Int(now + SESSION_TTL_MS),
            Bind::Text(sid.clone()),
            Bind::Text(Value::Object(session).to_string()),
        ],
    )
    .await
    .map_err(|e| db_error(&e))?;
    let cookie = cookie.header(&sid, settings)?;
    Ok(Saved {
        sid,
        cookie: Some(cookie),
    })
}

/// The live session `sid` now belongs to `user_id`.
async fn update(
    state: &AppState,
    settings: &Settings,
    sid: &str,
    json: &str,
    user_id: i64,
    now: i64,
) -> Result<Saved, String> {
    let mut session = match serde_json::from_str::<Value>(json) {
        Ok(Value::Object(map)) => map,
        Ok(_) | Err(_) => Map::new(),
    };
    let db = &state.db;
    if session.get("userId").and_then(Value::as_i64) == Some(user_id) {
        // Unmodified: the store's `touch`, no cookie.
        db.execute(
            r#"UPDATE "session" SET "expiredAt" = ?1 WHERE "id" = ?2"#,
            &[Bind::Int(now + SESSION_TTL_MS), Bind::Text(sid.to_owned())],
        )
        .await
        .map_err(|e| db_error(&e))?;
        return Ok(Saved {
            sid: sid.to_owned(),
            cookie: None,
        });
    }
    let stored = session.get("cookie").cloned().unwrap_or(Value::Null);
    let cookie = StoredCookie::touched(&stored, now);
    session.insert(String::from("cookie"), cookie.json());
    session.insert(String::from("userId"), Value::from(user_id));
    db.execute(
        r#"DELETE FROM "session" WHERE "id" IN (SELECT "id" FROM "session" WHERE "expiredAt" <= ?1 LIMIT 2)"#,
        &[Bind::Int(now)],
    )
    .await
    .map_err(|e| db_error(&e))?;
    db.execute(
        r#"UPDATE "session" SET "expiredAt" = ?1, "json" = ?2 WHERE "id" = ?3 AND "destroyedAt" IS NULL"#,
        &[
            Bind::Int(now + SESSION_TTL_MS),
            Bind::Text(Value::Object(session).to_string()),
            Bind::Text(sid.to_owned()),
        ],
    )
    .await
    .map_err(|e| db_error(&e))?;
    let header = cookie.header(sid, settings)?;
    Ok(Saved {
        sid: sid.to_owned(),
        cookie: Some(header),
    })
}

/// express-session's `Cookie`: what is stored and what is sent.
#[derive(Debug, Clone, PartialEq)]
struct StoredCookie {
    original_max_age: Value,
    secure: bool,
    http_only: bool,
    path: String,
    same_site: Value,
    expires: i64,
}

impl StoredCookie {
    /// A stored cookie after `touch()`: the expiry moves to now plus
    /// `originalMaxAge`, the attributes stay.
    fn touched(stored: &Value, now: i64) -> Self {
        let original = stored
            .get("originalMaxAge")
            .and_then(Value::as_i64)
            .unwrap_or(SESSION_TTL_MS);
        Self {
            original_max_age: Value::from(original),
            secure: stored
                .get("secure")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            http_only: stored
                .get("httpOnly")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            path: stored
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or("/")
                .to_owned(),
            same_site: stored.get("sameSite").cloned().unwrap_or(Value::Null),
            expires: now + original,
        }
    }

    /// `cookie.toJSON()`, in its key order.
    fn json(&self) -> Value {
        let mut map = Map::new();
        map.insert(
            String::from("originalMaxAge"),
            self.original_max_age.clone(),
        );
        map.insert(
            String::from("expires"),
            Value::from(crate::clock::Utc::from_unix_millis(self.expires).iso_string()),
        );
        map.insert(String::from("secure"), Value::Bool(self.secure));
        map.insert(String::from("httpOnly"), Value::Bool(self.http_only));
        map.insert(String::from("path"), Value::from(self.path.as_str()));
        if !self.same_site.is_null() {
            map.insert(String::from("sameSite"), self.same_site.clone());
        }
        Value::Object(map)
    }

    /// `cookie.serialize('connect.sid', 's:' + signature)`.
    fn header(&self, sid: &str, settings: &Settings) -> Result<String, String> {
        let signed = sign(sid, settings.session_secret())
            .ok_or_else(|| String::from("the session secret can't sign"))?;
        let mut out = format!(
            "connect.sid={}; Path={}; Expires={}",
            crate::ratings::encode_uri_component(&format!("s:{signed}")),
            self.path,
            http_date(self.expires)
        );
        if self.http_only {
            out.push_str("; HttpOnly");
        }
        if self.secure {
            out.push_str("; Secure");
        }
        match &self.same_site {
            Value::Bool(true) => out.push_str("; SameSite=Strict"),
            Value::String(s) => match s.to_lowercase().as_str() {
                "strict" => out.push_str("; SameSite=Strict"),
                "lax" => out.push_str("; SameSite=Lax"),
                "none" => out.push_str("; SameSite=None"),
                _ => {}
            },
            Value::Null
            | Value::Bool(false)
            | Value::Number(_)
            | Value::Array(_)
            | Value::Object(_) => {}
        }
        Ok(out)
    }
}

/// `Date.prototype.toUTCString()`.
fn http_date(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).map_or_else(String::new, |t| {
        t.format("%a, %d %b %Y %H:%M:%S GMT").to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forwarded_protocol() {
        let mut headers = HeaderMap::new();
        assert!(!forwarded_https(&headers), "none");
        headers.insert(
            "x-forwarded-proto",
            axum::http::HeaderValue::from_static("https, http"),
        );
        assert!(forwarded_https(&headers), "first value");
        headers.insert(
            "x-forwarded-proto",
            axum::http::HeaderValue::from_static("http,https"),
        );
        assert!(!forwarded_https(&headers), "http first");
    }

    #[test]
    fn touched_cookie_keeps_attributes() {
        let stored = serde_json::json!({
            "originalMaxAge": 1000, "expires": "x", "secure": true,
            "httpOnly": true, "path": "/Foreseerr", "sameSite": "lax"
        });
        let cookie = StoredCookie::touched(&stored, 0);
        assert_eq!(cookie.expires, 1000, "expiry");
        assert_eq!(
            cookie.json().to_string(),
            r#"{"originalMaxAge":1000,"expires":"1970-01-01T00:00:01.000Z","secure":true,"httpOnly":true,"path":"/Foreseerr","sameSite":"lax"}"#,
            "stored form"
        );
    }

    #[test]
    fn dates_like_to_utc_string() {
        assert_eq!(
            http_date(1_794_331_410_535),
            "Tue, 10 Nov 2026 17:23:30 GMT",
            "toUTCString"
        );
    }
}
