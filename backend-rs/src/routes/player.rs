//! Pairing for the native player (Moonfin in receiver mode).
//!
//! A signed-in user asks for a short-lived, single-use ticket and the page
//! hands it to the player in a link. `info` tells the player which Jellyfin
//! server and user the ticket is for, without spending it. The player then
//! starts Jellyfin Quick Connect itself and sends the code to
//! `quickconnect`, where Foreseerr approves it with the user's linked
//! Jellyfin token. The player ends up with a Jellyfin device and session of
//! its own; Foreseerr's token never leaves Foreseerr.
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
use super::desktop::{allow_request, digest};
use super::{Outcome, Ready, Table};
use crate::auth::now_ms;
use crate::db::Bind;

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/player/pair-tickets", Method::POST, issue),
    ("/api/v1/player/pair-tickets/info", Method::POST, info),
    (
        "/api/v1/player/pair-tickets/quickconnect",
        Method::POST,
        quickconnect,
    ),
];

const TICKET_LIFETIME_MS: i64 = 120_000;
const MAX_TICKETS: usize = 1024;

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

/// A Quick Connect code: Jellyfin hands out six digits.
fn code_like(s: &str) -> bool {
    (4..=16).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
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
    device_id: String,
    /// The first host that answered, for the calls that follow.
    reached: String,
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
                    device_id,
                    reached: host.clone(),
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

fn quickconnect<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move { finish(quickconnect_route(ctx).await) })
}

/// `POST /player/pair-tickets/quickconnect`: approves the player's code
/// as the ticket's user.
async fn quickconnect_route(ctx: &Ready<'_>) -> Step {
    let ticket = match redeemable(ctx, "redeem")? {
        Ok(ticket) => ticket,
        Err(outcome) => return Ok(outcome),
    };
    let qc_code = field(ctx, "code")?;
    if !code_like(qc_code) {
        return Err(String::from("code is the validator's").into());
    }
    let pairing = match pairing(ctx, ticket).await? {
        Ok(pairing) => pairing,
        Err(outcome) => return Ok(outcome),
    };
    if !spend(ticket) {
        return Ok(code(ctx, 409, "ticket_used"));
    }
    let version = client_version(ctx, current_type(ctx));
    let jf = Jellyfin::new(
        &ctx.state.outbound,
        &pairing.reached,
        authorization(Some(&pairing.token), Some(&pairing.device_id), &version),
        Some(Duration::from_secs(10)),
    );
    let path = format!("/QuickConnect/Authorize?code={qc_code}");
    match jf.call(Method::POST, &path, None, &[]).await {
        Ok(_) => {}
        Err(CallError::Status(401)) => return Ok(code(ctx, 401, "token_invalid")),
        Err(CallError::Status(403)) => return Ok(code(ctx, 403, "quickconnect_disabled")),
        Err(CallError::Status(404)) => return Ok(code(ctx, 404, "unknown_code")),
        Err(CallError::Status(status)) => {
            tracing::warn!("player pairing: Quick Connect authorize answered {status}");
            return Ok(code(ctx, 502, "quickconnect_failed"));
        }
        Err(CallError::NoResponse(e)) => {
            tracing::warn!("player pairing: Quick Connect authorize failed: {e}");
            return Ok(code(ctx, 503, "server_unreachable"));
        }
    }
    Ok(no_store(ctx.json(&Value::Object(describe(&pairing)))))
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(code_like("123456"));
        assert!(!code_like("12a456"), "digits only");
        assert!(!code_like("1&x=2"), "no query smuggling");
        assert_eq!(
            normalize_url("https://jf.example.com/").as_deref(),
            Some("https://jf.example.com")
        );
        assert_eq!(normalize_url("http://u:p@x"), None);
    }
}
