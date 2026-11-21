//! Pairing for the native player (Moonfin in receiver mode).
//!
//! A signed-in user asks for a short-lived, single-use ticket and the page
//! hands it to the player in a link. `info` tells the player which Jellyfin
//! server and user the ticket is for, without spending it, so a player
//! already signed in as that user just switches to them. Otherwise it
//! spends the ticket at `redeem` for the user's linked Jellyfin session (the
//! token Foreseerr signed in with) and signs in with it. Player and
//! Foreseerr then share that Jellyfin session: removing it in Jellyfin signs
//! out both, and the user signs in to Foreseerr again.
//!
//! Tickets live in process memory.

use std::sync::Mutex;
use std::time::Duration;

use axum::http::{header, HeaderValue, Method};
use base64::prelude::*;
use serde_json::{Map, Value};

use super::authcommon::{
    authorization, client_ip, client_version, current_type, finish, media_server_type, prop,
    random_bytes, settings_hostname, CallError, Jellyfin, Native, Step, JELLYFIN,
};
use super::{Outcome, Ready, Table};
use crate::auth::now_ms;
use crate::db::Bind;

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/player/pair-tickets", Method::POST, issue),
    ("/api/v1/player/pair-tickets/info", Method::POST, info),
    ("/api/v1/player/pair-tickets/redeem", Method::POST, redeem),
];

const TICKET_LIFETIME_MS: i64 = 120_000;
const MAX_TICKETS: usize = 1024;
const MAX_REQUESTS_PER_WINDOW: u32 = 10;
const RATE_WINDOW_MS: i64 = 60_000;
const MAX_KEYS: usize = 4096;

/// Requests per key: key, count and window end, oldest first.
static REQUESTS: Mutex<Vec<(String, u32, i64)>> = Mutex::new(Vec::new());

/// Whether `key` may make another request in its rate window.
fn allow_request(key: &str) -> bool {
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

/// A ticket's SHA-256, in hex.
fn digest(value: &str) -> String {
    super::authcommon::hex(&<sha2::Sha256 as sha2::Digest>::digest(value.as_bytes()))
}

/// A ticket by its SHA-256 digest.
#[derive(Debug, Clone)]
struct Ticket {
    digest: String,
    user_id: i64,
    expires_at: i64,
}

static TICKETS: Mutex<Vec<Ticket>> = Mutex::new(Vec::new());

fn store(ticket: Ticket) {
    let mut tickets = crate::sync::lock(&TICKETS);
    let now = now_ms();
    tickets.retain(|t| t.expires_at > now);
    while tickets.len() >= MAX_TICKETS {
        tickets.remove(0);
    }
    tickets.push(ticket);
}

/// The user a live ticket was issued to.
fn peek(ticket: &str) -> Option<i64> {
    let digest = digest(ticket);
    let now = now_ms();
    crate::sync::lock(&TICKETS)
        .iter()
        .find(|t| t.digest == digest && t.expires_at > now)
        .map(|t| t.user_id)
}

/// Spends a live ticket. False when it was spent or expired meanwhile.
fn spend(ticket: &str) -> bool {
    let digest = digest(ticket);
    let now = now_ms();
    let mut tickets = crate::sync::lock(&TICKETS);
    let before = tickets.len();
    tickets.retain(|t| !(t.digest == digest && t.expires_at > now));
    tickets.len() != before
}

fn no_store(mut outcome: Outcome) -> Outcome {
    if let Outcome::Done(res) = &mut outcome {
        res.headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    outcome
}

/// `{ code }` with a status, never cached.
fn code(ctx: &Ready<'_>, status: u16, code: &str) -> Outcome {
    let mut body = Map::new();
    body.insert(String::from("code"), Value::from(code));
    no_store(ctx.json_with(status, &Value::Object(body)))
}

fn ticket_like(s: &str) -> bool {
    s.len() == 43
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The body's string field, or the validator's answer.
fn field<'r>(ctx: &'r Ready<'_>, key: &str) -> Result<&'r str, String> {
    match &ctx.body {
        Some(Value::Object(body)) => body
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{key} is the validator's")),
        _ => Err(String::from("a body that isn't an object")),
    }
}

/// A user's Jellyfin link: user ID, token and device ID, when all are set.
async fn link(ctx: &Ready<'_>, user_id: i64) -> anyhow::Result<Option<(String, String, String)>> {
    let row = ctx
        .state
        .db
        .rows(
            r#"SELECT "jellyfinUserId", "jellyfinAuthToken", "jellyfinDeviceId" FROM "user" WHERE "id" = ?1"#,
            &[Bind::Int(user_id)],
        )
        .await?
        .into_iter()
        .next();
    let Some(row) = row else { return Ok(None) };
    let text = |key: &str| {
        row.get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    Ok((|| {
        Some((
            text("jellyfinUserId")?,
            text("jellyfinAuthToken")?,
            text("jellyfinDeviceId")?,
        ))
    })())
}

/// `normalizeJellyfinUrl`: an http(s) URL without credentials or a
/// trailing slash.
fn normalize_url(value: &str) -> Option<String> {
    let trimmed = value.trim();
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

/// The Jellyfin URLs to offer a player: the external one first, since the
/// player usually runs off the server's network, then the internal one.
fn player_hosts(ctx: &Ready<'_>) -> Vec<String> {
    let external = match ctx.settings.get("/jellyfin/externalHostname") {
        Some(Value::String(s)) => normalize_url(s),
        _ => None,
    };
    let internal = normalize_url(&settings_hostname(ctx));
    let mut hosts: Vec<String> = external.into_iter().chain(internal).collect();
    hosts.dedup();
    hosts
}

/// What a ticket stands for, checked against Jellyfin.
struct Pairing {
    hosts: Vec<String>,
    server_id: Value,
    user_id: String,
    token: String,
}

/// Looks the ticket's user up and asks Jellyfin who the token belongs to.
async fn pairing(ctx: &Ready<'_>, ticket: &str) -> Result<Result<Pairing, Outcome>, String> {
    let Some(user) = peek(ticket) else {
        return Ok(Err(code(ctx, 401, "ticket_expired")));
    };
    if media_server_type(ctx)? != JELLYFIN {
        return Ok(Err(code(ctx, 409, "unsupported_media_server")));
    }
    let Some((user_id, token, device_id)) = link(ctx, user)
        .await
        .map_err(|e| format!("database: {e:#}"))?
    else {
        return Ok(Err(code(ctx, 409, "not_linked")));
    };
    let hosts = player_hosts(ctx);
    let version = client_version(ctx, current_type(ctx));
    let mut last = "server_unreachable";
    // Foreseerr reaches Jellyfin best on its internal address, so ask there
    // first; the player gets every address.
    for host in hosts.iter().rev() {
        let jf = Jellyfin::new(
            &ctx.state.outbound,
            host,
            authorization(Some(&token), Some(&device_id), &version),
            Some(Duration::from_secs(5)),
        );
        match jf.call(Method::GET, "/Users/Me", None, &[]).await {
            Ok(me) => {
                let id = prop(&me, "Id").ok().flatten().and_then(Value::as_str);
                let server_id = prop(&me, "ServerId").ok().flatten().cloned();
                if id != Some(user_id.as_str()) {
                    return Ok(Err(code(ctx, 401, "token_invalid")));
                }
                return Ok(Ok(Pairing {
                    hosts: hosts.clone(),
                    server_id: server_id.unwrap_or(Value::Null),
                    user_id,
                    token,
                }));
            }
            Err(CallError::Status(401 | 403)) => last = "token_invalid",
            Err(CallError::Status(_) | CallError::NoResponse(_)) => {}
        }
    }
    let status = if last == "token_invalid" { 401 } else { 503 };
    Ok(Err(code(ctx, status, last)))
}

/// The server and user a pairing is for.
fn describe(pairing: &Pairing) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert(
        String::from("serverUrls"),
        Value::from(pairing.hosts.clone()),
    );
    out.insert(String::from("serverId"), pairing.server_id.clone());
    out.insert(String::from("userId"), Value::from(pairing.user_id.clone()));
    out
}

fn issue<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move { finish(issue_route(ctx).await) })
}

/// `POST /player/pair-tickets`.
async fn issue_route(ctx: &Ready<'_>) -> Step {
    ctx.no_query()?;
    let user = ctx.authenticated(0)?;
    if !allow_request(&format!("player-issue:user:{}", user.id)) {
        return Ok(code(ctx, 429, "rate_limited"));
    }
    if media_server_type(ctx)? != JELLYFIN {
        return Ok(code(ctx, 409, "unsupported_media_server"));
    }
    let linked = link(ctx, user.id)
        .await
        .map_err(|e| format!("database: {e:#}"))?;
    if linked.is_none() {
        return Ok(code(ctx, 409, "not_linked"));
    }
    let bytes = random_bytes(32)?;
    let ticket = BASE64_URL_SAFE_NO_PAD.encode(bytes);
    store(Ticket {
        digest: digest(&ticket),
        user_id: user.id,
        expires_at: now_ms() + TICKET_LIFETIME_MS,
    });
    let mut out = Map::new();
    out.insert(String::from("ticket"), Value::from(ticket));
    out.insert(String::from("expiresIn"), Value::from(TICKET_LIFETIME_MS));
    Ok(no_store(ctx.json_with(201, &Value::Object(out))))
}

/// The ticket from the body after the per-address rate check.
fn redeemable<'r>(
    ctx: &'r Ready<'_>,
    kind: &str,
) -> Result<Result<&'r str, Outcome>, super::Fallback> {
    ctx.no_query()?;
    let ticket = field(ctx, "ticket")?;
    if !ticket_like(ticket) {
        return Err(String::from("ticket is the validator's").into());
    }
    let ip = client_ip(ctx)?;
    if !allow_request(&format!("player-{kind}:ip:{ip}")) {
        return Ok(Err(code(ctx, 429, "rate_limited")));
    }
    Ok(Ok(ticket))
}

fn info<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move { finish(info_route(ctx).await) })
}

/// `POST /player/pair-tickets/info`: who and where, without spending it.
async fn info_route(ctx: &Ready<'_>) -> Step {
    let ticket = match redeemable(ctx, "info")? {
        Ok(ticket) => ticket,
        Err(outcome) => return Ok(outcome),
    };
    let pairing = match pairing(ctx, ticket).await? {
        Ok(pairing) => pairing,
        Err(outcome) => return Ok(outcome),
    };
    Ok(no_store(ctx.json(&Value::Object(describe(&pairing)))))
}

fn redeem<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move { finish(redeem_route(ctx).await) })
}

/// `POST /player/pair-tickets/redeem`: spends the ticket for the user's
/// linked Jellyfin session.
async fn redeem_route(ctx: &Ready<'_>) -> Step {
    let ticket = match redeemable(ctx, "redeem")? {
        Ok(ticket) => ticket,
        Err(outcome) => return Ok(outcome),
    };
    let pairing = match pairing(ctx, ticket).await? {
        Ok(pairing) => pairing,
        Err(outcome) => return Ok(outcome),
    };
    if !spend(ticket) {
        return Ok(code(ctx, 409, "ticket_used"));
    }
    let mut out = describe(&pairing);
    out.insert(String::from("accessToken"), Value::from(pairing.token));
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
    fn digests() {
        assert_eq!(
            digest("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    fn ticket(id: &str, user_id: i64, expires_at: i64) -> Ticket {
        Ticket {
            digest: digest(id),
            user_id,
            expires_at,
        }
    }

    #[test]
    fn tickets_are_single_use() {
        let id = "a".repeat(43);
        store(ticket(&id, 7, now_ms() + 60_000));
        assert_eq!(peek(&id), Some(7), "peek leaves it");
        assert_eq!(peek(&id), Some(7), "still there");
        assert!(spend(&id), "first spend");
        assert!(!spend(&id), "second spend");
        assert_eq!(peek(&id), None, "gone");
    }

    #[test]
    fn expired_tickets_do_not_count() {
        let id = "b".repeat(43);
        store(ticket(&id, 3, now_ms() - 1));
        assert_eq!(peek(&id), None);
        assert!(!spend(&id));
    }

    #[test]
    fn shapes() {
        assert!(ticket_like(&("a_-".repeat(14) + "b")));
        assert!(!ticket_like("short"));
        assert_eq!(
            normalize_url("https://jf.example.com/").as_deref(),
            Some("https://jf.example.com")
        );
        assert_eq!(normalize_url("http://u:p@x"), None);
    }
}
