//! Who is making the request: `checkUser` from `server/middleware/auth.ts`.
//!
//! A request is either signed with the API key (`X-API-Key`, acting as user
//! 1 or `X-API-User`) or carries the express-session cookie, whose id is
//! looked up in the `session` table Node writes.

use anyhow::Result;
use axum::http::{header, HeaderMap, HeaderValue};
use base64::prelude::*;
use hmac::{Hmac, KeyInit, Mac};
use serde_json::Value;
use sha2::Sha256;
use subtle::ConstantTimeEq;

use crate::db::{Db, UserRow};
use crate::settings::public::truthy;
use crate::settings::Settings;

/// The cookie express-session sets.
const SESSION_COOKIE: &str = "connect.sid";
/// `cookie.maxAge` and the store's TTL: 30 days.
pub const SESSION_TTL_MS: i64 = 1000 * 60 * 60 * 24 * 30;

/// The user a request acts as.
#[derive(Debug, Clone)]
pub struct CurrentUser {
    /// `user.id`.
    pub id: i64,
    /// `user.permissions`, the bitmask.
    pub permissions: i64,
    /// `user.settings.notificationTypes.webpush` is truthy (or unset).
    pub webpush_enabled: bool,
    /// `user_settings.locale` when it is a non-empty string; `req.locale`
    /// falls back to `main.locale` otherwise.
    pub locale: Option<String>,
}

/// `Permission.ADMIN`, which satisfies every check.
const ADMIN: i64 = 2;

impl CurrentUser {
    /// `hasPermission` with one permission value (bits may be combined):
    /// nothing required, admin, or any required bit set.
    #[must_use]
    pub const fn has_permission(&self, required: i64) -> bool {
        required == 0 || self.permissions & ADMIN != 0 || self.permissions & required != 0
    }

    /// `hasPermission([...], { type: 'and' })`: admin, or every bit set.
    #[must_use]
    pub const fn has_all_permissions(&self, required: i64) -> bool {
        self.permissions & ADMIN != 0 || self.permissions & required == required
    }
}

/// What `checkUser` decided.
#[derive(Debug, Clone)]
pub enum Identity {
    /// No valid key or session.
    Anonymous,
    /// A known user.
    User(CurrentUser),
    /// Node would do something this port doesn't reproduce; let it answer.
    Unportable(&'static str),
}

/// Work out the user, touching the session like express-session does.
///
/// # Errors
///
/// Fails on database errors.
pub async fn check_user(db: &Db, settings: &Settings, headers: &HeaderMap) -> Result<Identity> {
    if let Some(key) = headers.get("x-api-key") {
        if api_key_matches(key.as_bytes(), settings.api_key()) {
            // Work on the original administrator account unless told otherwise.
            // Node tests the header's truthiness before calling Number().
            let user_id = match headers
                .get("x-api-user")
                .filter(|v| !v.as_bytes().is_empty())
            {
                None => 1,
                Some(v) => match api_user_id(v) {
                    Some(id) => id,
                    None => return Ok(Identity::Unportable("X-API-User is not a whole number")),
                },
            };
            return load(db, user_id).await;
        }
    }
    let Some(sid) = session_id(headers, settings.session_secret()) else {
        return Ok(Identity::Anonymous);
    };
    let now = now_ms();
    let Some(session) = db.session_user_id(&sid, now).await? else {
        return Ok(Identity::Anonymous);
    };
    db.touch_session(&sid, now + SESSION_TTL_MS).await?;
    match session.user_id {
        Some(id) if id != 0 => load(db, id).await,
        Some(_) | None => Ok(Identity::Anonymous),
    }
}

fn api_key_matches(given: &[u8], expected: &str) -> bool {
    !expected.is_empty() && bool::from(given.ct_eq(expected.as_bytes()))
}

/// The user `id` as a request signed in as them would see it.
///
/// # Errors
///
/// Fails on database errors.
pub async fn load_user(db: &Db, id: i64) -> Result<Identity> {
    load(db, id).await
}

async fn load(db: &Db, id: i64) -> Result<Identity> {
    let Some(row) = db.user(id).await? else {
        return Ok(Identity::Anonymous);
    };
    Ok(match webpush_enabled(&row) {
        Ok(webpush_enabled) => Identity::User(CurrentUser {
            id: row.id,
            permissions: row.permissions,
            webpush_enabled,
            locale: row.locale.clone().filter(|l| !l.is_empty()),
        }),
        Err(why) => Identity::Unportable(why),
    })
}

/// `Number(header)` for the values this port accepts: a whole number, or
/// blank (which `Number` turns into 0, a user that never exists).
fn api_user_id(value: &HeaderValue) -> Option<i64> {
    let text = value.to_str().ok()?.trim();
    if text.is_empty() {
        return Some(0);
    }
    if !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// `user.settings?.notificationTypes.webpush ?? true`, including the column
/// transformer in `server/entity/UserSettings.ts`, which falls back to all
/// notifications when the value is missing, not an object or lacks the key.
fn webpush_enabled(row: &UserRow) -> Result<bool, &'static str> {
    if !row.has_settings {
        return Ok(true);
    }
    let Some(text) = row.notification_types.as_deref().filter(|t| !t.is_empty()) else {
        return Ok(true);
    };
    let value: Value =
        serde_json::from_str(text).map_err(|_| "user_settings.notificationTypes is not JSON")?;
    match value {
        // `typeof null === 'object'`, then `null.webpush` throws.
        Value::Null => Err("user_settings.notificationTypes is null"),
        Value::Object(map) => Ok(match map.get("webpush") {
            None | Some(Value::Null) => true,
            Some(v) => truthy(Some(v)),
        }),
        Value::Array(_) | Value::Bool(_) | Value::Number(_) | Value::String(_) => Ok(true),
    }
}

#[must_use]
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or_default()
}

/// The session id from a valid `connect.sid` cookie.
#[must_use]
pub fn session_id(headers: &HeaderMap, secret: &str) -> Option<String> {
    if secret.is_empty() {
        return None;
    }
    let raw = cookie_value(headers, SESSION_COOKIE)?;
    let signed = raw.strip_prefix("s:")?;
    unsign(signed, secret)
}

/// The first cookie named `name`, decoded as the `cookie` package does.
fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|h| h.split(';'))
        .find_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            (key.trim() == name).then(|| {
                let value = value.trim();
                let value = value
                    .strip_prefix('"')
                    .and_then(|v| v.strip_suffix('"'))
                    .unwrap_or(value);
                percent_decode(value)
            })
        })
}

/// `decodeURIComponent`, keeping the raw text when it isn't valid.
fn percent_decode(value: &str) -> String {
    if !value.contains('%') {
        return value.to_owned();
    }
    let mut out = Vec::with_capacity(value.len());
    let mut bytes = value.bytes();
    while let Some(b) = bytes.next() {
        if b != b'%' {
            out.push(b);
            continue;
        }
        let hex = [bytes.next(), bytes.next()];
        let digit = |x: Option<u8>| x.and_then(|c| char::from(c).to_digit(16));
        match (digit(hex[0]), digit(hex[1])) {
            (Some(hi), Some(lo)) => match u8::try_from(hi * 16 + lo) {
                Ok(byte) => out.push(byte),
                Err(_) => return value.to_owned(),
            },
            _ => return value.to_owned(),
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| value.to_owned())
}

/// `cookie-signature`'s `sign`: the value, a dot and its unpadded base64
/// HMAC-SHA256.
#[must_use]
pub fn sign(value: &str, secret: &str) -> Option<String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(value.as_bytes());
    let tag = BASE64_STANDARD_NO_PAD.encode(mac.finalize().into_bytes());
    Some(format!("{value}.{tag}"))
}

/// `cookie-signature`'s `unsign`.
fn unsign(signed: &str, secret: &str) -> Option<String> {
    let dot = signed.rfind('.')?;
    let (value, _) = signed.split_at(dot);
    let expected = sign(value, secret)?;
    bool::from(expected.as_bytes().ct_eq(signed.as_bytes())).then(|| value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signs_like_cookie_signature() {
        // `require('cookie-signature').sign('abc', 'secret')`
        assert_eq!(
            sign("abc", "secret").as_deref(),
            Some("abc.mUba1OAOkT/Ivo5dP34RCkqegy+D+wnDRShdeGONig4"),
            "signature"
        );
        assert_eq!(
            unsign("abc.mUba1OAOkT/Ivo5dP34RCkqegy+D+wnDRShdeGONig4", "secret").as_deref(),
            Some("abc"),
            "round trip"
        );
        assert_eq!(
            unsign("abc.mUba1OAOkT/Ivo5dP34RCkqegy+D+wnDRShdeGONig4", "other"),
            None,
            "wrong secret"
        );
        assert_eq!(unsign("abc", "secret"), None, "no signature");
    }

    #[test]
    fn empty_secrets_never_authenticate() {
        assert!(!api_key_matches(b"", ""), "empty keys are not credentials");
        assert!(!api_key_matches(b"", "key"), "a key is required");
        assert!(api_key_matches(b"key", "key"), "the configured key works");
        let mut headers = HeaderMap::new();
        let signed = sign("known-session", "").unwrap_or_default();
        if let Ok(cookie) = HeaderValue::from_str(&format!("connect.sid=s:{signed}")) {
            headers.insert(header::COOKIE, cookie);
        }
        assert_eq!(
            session_id(&headers, ""),
            None,
            "cookies cannot be authenticated with a missing secret"
        );
    }

    #[test]
    fn reads_the_session_cookie() {
        let mut headers = HeaderMap::new();
        headers.append(
            header::COOKIE,
            HeaderValue::from_static("a=1; connect.sid=s%3AWq8vJ3kZ2m1n.f76fYsHfYmRIPkMsnsE2A1M8EsklhBvNPeoNrmcmCak; connect.sid=other"),
        );
        assert_eq!(
            session_id(&headers, "s3cr3t").as_deref(),
            Some("Wq8vJ3kZ2m1n"),
            "first cookie wins"
        );
        assert_eq!(session_id(&headers, "nope"), None, "bad secret");

        let mut unsigned = HeaderMap::new();
        unsigned.append(
            header::COOKIE,
            HeaderValue::from_static("connect.sid=Wq8vJ3kZ2m1n"),
        );
        assert_eq!(session_id(&unsigned, "s3cr3t"), None, "unsigned cookie");
    }

    #[test]
    fn decodes_like_decode_uri_component() {
        assert_eq!(percent_decode("s%3Aabc"), "s:abc", "percent");
        assert_eq!(percent_decode("plain"), "plain", "plain");
        assert_eq!(percent_decode("bad%zz"), "bad%zz", "malformed stays raw");
        assert_eq!(
            percent_decode("%E2%82"),
            "%E2%82",
            "invalid utf-8 stays raw"
        );
    }

    #[test]
    fn permission_bits() {
        let user = |permissions: i64| CurrentUser {
            id: 1,
            permissions,
            webpush_enabled: true,
            locale: None,
        };
        assert!(user(0).has_permission(0), "nothing required");
        assert!(user(2).has_permission(4), "admin passes everything");
        assert!(user(32).has_permission(32), "has the bit");
        assert!(
            user(32 | 64).has_permission(64 | 128),
            "any required bit is enough"
        );
        assert!(!user(32).has_permission(4), "lacks the bit");
    }

    #[test]
    fn api_user_header() {
        assert_eq!(
            api_user_id(&HeaderValue::from_static(" 12 ")),
            Some(12),
            "number"
        );
        assert_eq!(
            api_user_id(&HeaderValue::from_static("")),
            Some(0),
            "blank is 0"
        );
        assert_eq!(
            api_user_id(&HeaderValue::from_static("1e3")),
            None,
            "not plain digits"
        );
    }

    #[test]
    fn webpush_from_notification_types() {
        let row = |has_settings: bool, types: Option<&str>| UserRow {
            id: 1,
            permissions: 0,
            has_settings,
            locale: None,
            notification_types: types.map(str::to_owned),
        };
        assert_eq!(
            webpush_enabled(&row(false, None)),
            Ok(true),
            "no settings row"
        );
        assert_eq!(webpush_enabled(&row(true, None)), Ok(true), "null column");
        assert_eq!(
            webpush_enabled(&row(true, Some(r#"{"webpush":0}"#))),
            Ok(false),
            "disabled"
        );
        assert_eq!(
            webpush_enabled(&row(true, Some(r#"{"webpush":2}"#))),
            Ok(true),
            "enabled"
        );
        assert_eq!(
            webpush_enabled(&row(true, Some(r#"{"email":0}"#))),
            Ok(true),
            "missing key"
        );
        assert_eq!(
            webpush_enabled(&row(true, Some("2"))),
            Ok(true),
            "not an object"
        );
        assert!(
            webpush_enabled(&row(true, Some("null"))).is_err(),
            "null throws in Node"
        );
        assert!(
            webpush_enabled(&row(true, Some("{"))).is_err(),
            "invalid JSON throws in Node"
        );
    }
}
