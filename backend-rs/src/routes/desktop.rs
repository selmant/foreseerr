//! `POST /desktop/auth-tickets` and `POST /desktop/auth-tickets/redeem`:
//! the challenge-bound tickets a browser session issues so the native
//! desktop host can bootstrap a Jellyfin session.
//!
//! The issue/redeem rate windows are Node's in-memory map; they live here
//! now (the keys `browser-cache/redeem` uses are its own, so Node's copy
//! never needed to agree with this one).

use std::sync::Mutex;
use std::time::Duration;

use axum::http::{header, HeaderValue, Method};
use base64::prelude::*;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::authcommon::{
    authorization, client_ip, client_version, current_type, date_bind, date_param, finish,
    has_cookie, hex, js_int, media_server_type, prop, random_bytes, settings_hostname, CallError,
    Jellyfin, Native, Step, JELLYFIN,
};
use super::{Outcome, Ready, Table};
use crate::auth::{now_ms, session_id};
use crate::db::Bind;

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/desktop/auth-tickets", Method::POST, issue),
    ("/api/v1/desktop/auth-tickets/redeem", Method::POST, redeem),
];

const TICKET_LIFETIME_MS: i64 = 60_000;
const MAX_REQUESTS_PER_WINDOW: u32 = 10;
const RATE_WINDOW_MS: i64 = 60_000;
const MAX_KEYS: usize = 4096;

/// `requests`: key, count and window end, in insertion order like a `Map`.
static REQUESTS: Mutex<Vec<(String, u32, i64)>> = Mutex::new(Vec::new());

/// `allowRequest(key)`.
pub(super) fn allow_request(key: &str) -> bool {
    allow_in(&mut crate::sync::lock(&REQUESTS), key, now_ms())
}

fn allow_in(requests: &mut Vec<(String, u32, i64)>, key: &str, now: i64) -> bool {
    if requests.len() >= MAX_KEYS {
        requests.retain(|(_, _, reset_at)| *reset_at > now);
        while requests.len() >= MAX_KEYS {
            requests.remove(0);
        }
    }
    match requests.iter_mut().find(|(k, _, _)| k == key) {
        Some(entry) if entry.2 > now => {
            if entry.1 >= MAX_REQUESTS_PER_WINDOW {
                return false;
            }
            entry.1 += 1;
            true
        }
        Some(entry) => {
            entry.1 = 1;
            entry.2 = now + RATE_WINDOW_MS;
            true
        }
        None => {
            requests.push((key.to_owned(), 1, now + RATE_WINDOW_MS));
            true
        }
    }
}

/// `{ code }` with a status and the router's `Cache-Control: no-store`.
fn code(ctx: &Ready<'_>, status: u16, code: &str) -> Outcome {
    let mut body = Map::new();
    body.insert(String::from("code"), Value::from(code));
    no_store(ctx.json_with(status, &Value::Object(body)))
}

/// `next(error)`: 500 with the message, still `no-store`.
fn failed(ctx: &Ready<'_>, message: &str) -> Outcome {
    tracing::error!("desktop auth ticket: {message}");
    no_store(ctx.error(500, message))
}

fn no_store(mut outcome: Outcome) -> Outcome {
    if let Outcome::Done(res) = &mut outcome {
        res.headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    outcome
}

/// `createHash('sha256').update(value).digest('hex')`.
fn digest(value: &str) -> String {
    hex(&Sha256::digest(value.as_bytes()))
}

/// `Buffer.from(text, 'hex')`: pairs of hex digits up to the first one
/// that isn't.
fn node_hex(text: &str) -> Vec<u8> {
    text.as_bytes()
        .chunks_exact(2)
        .map_while(|pair| {
            let digit = |b: u8| char::from(b).to_digit(16);
            let (hi, lo) = (digit(*pair.first()?)?, digit(*pair.get(1)?)?);
            u8::try_from(hi * 16 + lo).ok()
        })
        .collect()
}

/// `sameDigest(left, right)`.
fn same_digest(left: &str, right: &str) -> bool {
    let (a, b) = (node_hex(left), node_hex(right));
    a.len() == b.len() && bool::from(subtle::ConstantTimeEq::ct_eq(a.as_slice(), b.as_slice()))
}

/// A string matching `^[a-f0-9]{64}$` / `^[A-Za-z0-9_-]{43}$`.
fn challenge_like(v: Option<&Value>) -> bool {
    v.and_then(Value::as_str)
        .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| matches!(b, b'a'..=b'f' | b'0'..=b'9')))
}

fn ticket_like(v: Option<&Value>) -> bool {
    v.and_then(Value::as_str).is_some_and(|s| {
        s.len() == 43
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}

/// The body the validator and zod both accept, or why Node answers.
fn body_of<'r>(ctx: &'r Ready<'_>) -> Result<&'r Map<String, Value>, String> {
    let Some(Value::Object(body)) = &ctx.body else {
        return Err(String::from("a body that isn't an object"));
    };
    if body.get("protocolVersion").and_then(js_int) != Some(1) {
        return Err(String::from("protocolVersion is the validator's"));
    }
    Ok(body)
}

/// `findLinkedUser`: the Jellyfin link of a user, or `None`.
async fn linked_user(ctx: &Ready<'_>, user_id: i64) -> anyhow::Result<Option<Map<String, Value>>> {
    Ok(ctx
        .state
        .db
        .rows(
            r#"SELECT "jellyfinUserId", "jellyfinAuthToken", "jellyfinDeviceId" FROM "user" WHERE "id" = ?1"#,
            &[Bind::Int(user_id)],
        )
        .await?
        .into_iter()
        .next())
}

/// The three link columns when all are set.
fn link(user: Option<&Map<String, Value>>) -> Option<(String, String, String)> {
    let user = user?;
    let text = |key: &str| {
        user.get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    Some((
        text("jellyfinUserId")?,
        text("jellyfinAuthToken")?,
        text("jellyfinDeviceId")?,
    ))
}

fn issue<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move { finish(issue_route(ctx).await) })
}

/// `POST /desktop/auth-tickets`.
async fn issue_route(ctx: &Ready<'_>) -> Step {
    ctx.no_query()?;
    if !has_cookie(ctx, "connect.sid") {
        return Err(String::from("no session cookie; the validator answers 401").into());
    }
    let body = body_of(ctx)?;
    if !challenge_like(body.get("challenge")) {
        return Err(String::from("challenge is the validator's").into());
    }
    let challenge = body
        .get("challenge")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let user = ctx.authenticated(0)?;
    let db = &ctx.state.db;
    let db_err = |e: anyhow::Error| format!("database: {e:#}");
    let sid = session_id(&ctx.req.headers, ctx.settings.session_secret());
    let session_user = match &sid {
        Some(sid) => db
            .session_user_id(sid, now_ms())
            .await
            .map_err(db_err)?
            .and_then(|s| s.user_id),
        None => None,
    };
    let (Some(sid), true) = (sid, session_user == Some(user.id)) else {
        return Ok(code(ctx, 403, "session_required"));
    };
    let ip = client_ip(ctx)?;
    let server_type = media_server_type(ctx)?;
    if !allow_request(&format!("issue:ip:{ip}")) || !allow_request(&format!("issue:session:{sid}"))
    {
        return Ok(code(ctx, 429, "rate_limited"));
    }
    let linked = linked_user(ctx, user.id).await.map_err(db_err)?;
    if server_type != JELLYFIN || link(linked.as_ref()).is_none() {
        return Ok(code(ctx, 409, "not_linked"));
    }
    let Ok(bytes) = random_bytes(32) else {
        return Ok(failed(ctx, "no randomness"));
    };
    let ticket = BASE64_URL_SAFE_NO_PAD.encode(bytes);
    let now = now_ms();
    let cleanup = format!(
        r#"DELETE FROM "desktop_auth_ticket" WHERE "expiresAt" < {}"#,
        date_param(db, 1)
    );
    if let Err(e) = db.execute(&cleanup, &[date_bind(db, now)]).await {
        return Ok(failed(ctx, &format!("{e:#}")));
    }
    let insert = format!(
        r#"INSERT INTO "desktop_auth_ticket" ("userId", "sessionId", "ticketDigest", "challengeDigest", "protocolVersion", "expiresAt", "consumedAt") VALUES (?1, ?2, ?3, ?4, 1, {}, NULL)"#,
        date_param(db, 5)
    );
    let binds = [
        Bind::Int(user.id),
        Bind::Text(sid),
        Bind::Text(digest(&ticket)),
        Bind::Text(challenge),
        date_bind(db, now + TICKET_LIFETIME_MS),
    ];
    if let Err(e) = db.execute(&insert, &binds).await {
        return Ok(failed(ctx, &format!("{e:#}")));
    }
    let mut out = Map::new();
    out.insert(String::from("ticket"), Value::from(ticket));
    out.insert(String::from("expiresIn"), Value::from(TICKET_LIFETIME_MS));
    Ok(no_store(ctx.json_with(201, &Value::Object(out))))
}

/// `normalizeJellyfinUrl`.
fn normalize_url(value: &str) -> Option<String> {
    let trimmed = value.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if trimmed.is_empty() {
        return None;
    }
    let url = reqwest::Url::parse(trimmed).ok()?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none_or(str::is_empty)
        || !matches!(url.scheme(), "http" | "https")
    {
        return None;
    }
    let text = url.as_str();
    Some(text.strip_suffix('/').unwrap_or(text).to_owned())
}

/// `jellyfinDesktopHosts()`: the internal URL first, the external one as
/// a fallback when they differ.
fn desktop_hosts(ctx: &Ready<'_>) -> Result<Result<(String, Option<String>), ()>, String> {
    let internal = normalize_url(&settings_hostname(ctx));
    let external = match ctx.settings.get("/jellyfin/externalHostname") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => normalize_url(s),
        Some(_) => return Err(String::from("an externalHostname that isn't a string")),
    };
    Ok(match (internal, external) {
        (Some(i), Some(e)) if i != e => Ok((i, Some(e))),
        (Some(i), _) => Ok((i, None)),
        (None, Some(e)) => Ok((e, None)),
        (None, None) => Err(()),
    })
}

/// The ticket row `redeem` reads.
#[derive(Debug, Clone)]
struct Record {
    id: i64,
    user_id: i64,
    session_id: String,
    challenge_digest: String,
    expires_at: Option<i64>,
    consumed: bool,
}

async fn find_record(ctx: &Ready<'_>, ticket: &str) -> anyhow::Result<Option<Record>> {
    let db = &ctx.state.db;
    let sql = format!(
        r#"SELECT CAST("id" AS BIGINT) AS "id", CAST("userId" AS BIGINT) AS "userId", "sessionId", "challengeDigest", {} AS "expiresAt", CASE WHEN "consumedAt" IS NULL THEN 0 ELSE 1 END AS "consumed" FROM "desktop_auth_ticket" WHERE "ticketDigest" = ?1 AND "protocolVersion" = 1"#,
        db.iso_sql(r#""expiresAt""#)
    );
    let rows = db.rows(&sql, &[Bind::Text(digest(ticket))]).await?;
    Ok(rows.first().map(|r| {
        let text = |key: &str| r.get(key).and_then(Value::as_str).unwrap_or("").to_owned();
        Record {
            id: r.get("id").and_then(Value::as_i64).unwrap_or_default(),
            user_id: r.get("userId").and_then(Value::as_i64).unwrap_or_default(),
            session_id: text("sessionId"),
            challenge_digest: text("challengeDigest"),
            expires_at: r
                .get("expiresAt")
                .and_then(Value::as_str)
                .and_then(crate::clock::parse_date_millis),
            consumed: r.get("consumed").and_then(Value::as_i64) == Some(1),
        }
    }))
}

fn redeem<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move { finish(redeem_route(ctx).await) })
}

/// `POST /desktop/auth-tickets/redeem`.
async fn redeem_route(ctx: &Ready<'_>) -> Step {
    ctx.no_query()?;
    let body = body_of(ctx)?;
    if !ticket_like(body.get("ticket")) || !ticket_like(body.get("verifier")) {
        return Err(String::from("ticket and verifier are the validator's").into());
    }
    let ticket = body.get("ticket").and_then(Value::as_str).unwrap_or("");
    let verifier = body.get("verifier").and_then(Value::as_str).unwrap_or("");
    let ip = client_ip(ctx)?;
    if !allow_request(&format!("redeem:ip:{ip}")) {
        return Ok(code(ctx, 429, "rate_limited"));
    }
    let db = &ctx.state.db;
    let db_err = |e: anyhow::Error| format!("database: {e:#}");
    let Some(record) = find_record(ctx, ticket).await.map_err(db_err)? else {
        return Ok(code(ctx, 401, "ticket_expired"));
    };
    if record.consumed {
        return Ok(code(ctx, 409, "ticket_used"));
    }
    let Some(expires_at) = record.expires_at else {
        return Err(String::from("an unreadable ticket expiry").into());
    };
    if expires_at <= now_ms() {
        return Ok(code(ctx, 401, "ticket_expired"));
    }
    if !same_digest(&record.challenge_digest, &digest(verifier)) {
        return Ok(code(ctx, 401, "invalid_verifier"));
    }
    let session_user = db
        .session_user_id(&record.session_id, now_ms())
        .await
        .map_err(db_err)?
        .and_then(|s| s.user_id);
    if session_user != Some(record.user_id) {
        return Ok(code(ctx, 401, "session_expired"));
    }
    let linked = linked_user(ctx, record.user_id).await.map_err(db_err)?;
    if media_server_type(ctx)? != JELLYFIN {
        return Ok(code(ctx, 409, "unsupported_media_server"));
    }
    let Some((jellyfin_user_id, token, device_id)) = link(linked.as_ref()) else {
        return Ok(code(ctx, 409, "not_linked"));
    };
    let Ok((server_url, fallback)) = desktop_hosts(ctx)? else {
        return Ok(failed(ctx, "Invalid Jellyfin desktop server URL"));
    };
    let version = client_version(ctx, current_type(ctx));
    let mut identity = None;
    let mut last = "server_unreachable";
    for candidate in std::iter::once(&server_url).chain(fallback.as_ref()) {
        let jf = Jellyfin::new(
            &ctx.state.outbound,
            candidate,
            authorization(Some(&token), Some(&device_id), &version),
            Some(Duration::from_secs(5)),
        );
        match jf.call(Method::GET, "/Users/Me", None, &[]).await {
            Ok(data) => {
                identity = Some(data);
                break;
            }
            Err(CallError::Status(401 | 403)) => last = "token_invalid",
            Err(CallError::Status(_) | CallError::NoResponse(_)) => last = "server_unreachable",
        }
    }
    let Some(identity) = identity.filter(|v| crate::settings::public::truthy(Some(v))) else {
        let status = if last == "token_invalid" { 401 } else { 503 };
        return Ok(code(ctx, status, last));
    };
    let id = prop(&identity, "Id").ok().flatten();
    let server_id = prop(&identity, "ServerId").ok().flatten();
    if id != Some(&Value::String(jellyfin_user_id.clone()))
        || !crate::settings::public::truthy(server_id)
    {
        return Ok(code(ctx, 401, "token_invalid"));
    }
    consume(
        ctx,
        &record,
        server_url,
        fallback,
        server_id.cloned(),
        (jellyfin_user_id, token, device_id),
    )
    .await
}

/// Mark the ticket used (only now, so a failed bootstrap can retry) and
/// hand out the session.
async fn consume(
    ctx: &Ready<'_>,
    record: &Record,
    server_url: String,
    fallback: Option<String>,
    server_id: Option<Value>,
    (jellyfin_user_id, token, device_id): (String, String, String),
) -> Step {
    let db = &ctx.state.db;
    let now = now_ms();
    let sql = format!(
        r#"UPDATE "desktop_auth_ticket" SET "consumedAt" = {} WHERE id = ?2 AND "consumedAt" IS NULL AND "expiresAt" > {}"#,
        date_param(db, 1),
        date_param(db, 3)
    );
    let affected = match db
        .execute(
            &sql,
            &[date_bind(db, now), Bind::Int(record.id), date_bind(db, now)],
        )
        .await
    {
        Ok(n) => n,
        Err(e) => return Ok(failed(ctx, &format!("{e:#}"))),
    };
    if affected != 1 {
        return Ok(code(ctx, 409, "ticket_used"));
    }
    let Ok(generation) = random_bytes(12) else {
        return Ok(failed(ctx, "no randomness"));
    };
    let mut out = Map::new();
    out.insert(String::from("serverUrl"), Value::from(server_url));
    if let Some(fallback) = fallback {
        out.insert(String::from("fallbackServerUrl"), Value::from(fallback));
    }
    out.insert(
        String::from("serverId"),
        server_id.map_or(Value::Null, crate::tmdb::js_numbers),
    );
    out.insert(String::from("userId"), Value::from(jellyfin_user_id));
    out.insert(String::from("deviceId"), Value::from(device_id));
    out.insert(String::from("accessToken"), Value::from(token));
    out.insert(
        String::from("bootstrapGeneration"),
        Value::from(hex(&generation)),
    );
    Ok(no_store(ctx.json(&Value::Object(out))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_windows() {
        let mut requests = Vec::new();
        for _ in 0..10 {
            assert!(allow_in(&mut requests, "k", 1000), "within the window");
        }
        assert!(!allow_in(&mut requests, "k", 1000), "eleventh is refused");
        assert!(allow_in(&mut requests, "k", 61_000), "a new window");
        assert!(allow_in(&mut requests, "other", 1000), "keys apart");
    }

    #[test]
    fn digests_and_urls() {
        assert_eq!(
            digest("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            "sha256"
        );
        assert!(same_digest("ab01", "AB01"), "case-insensitive bytes");
        assert!(!same_digest("ab01", "ab02"), "different");
        assert_eq!(node_hex("abzz"), vec![0xab], "stops at the first bad pair");
        assert_eq!(
            normalize_url(" http://10.0.0.2:8096 ").as_deref(),
            Some("http://10.0.0.2:8096"),
            "trailing slash dropped"
        );
        assert_eq!(
            normalize_url("https://jf.example.com:443/base/").as_deref(),
            Some("https://jf.example.com/base"),
            "default port elided"
        );
        assert_eq!(normalize_url("ftp://x"), None, "scheme");
        assert_eq!(normalize_url("http://u:p@x"), None, "credentials");
        assert_eq!(normalize_url(""), None, "empty");
        assert!(
            challenge_like(Some(&Value::from("a".repeat(64)))),
            "challenge"
        );
        assert!(
            !challenge_like(Some(&Value::from("A".repeat(64)))),
            "lowercase only"
        );
        assert!(
            ticket_like(Some(&Value::from("a_-".repeat(14) + "b"))),
            "ticket"
        );
    }
}
