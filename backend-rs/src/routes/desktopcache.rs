//! `POST /settings/cache/browser/flush` issues a browser-cache ticket and
//! `POST /desktop/browser-cache/redeem` lets the native host redeem it.
//!
//! The tickets are Node's in-memory `browserCacheTickets`: opaque,
//! single-use, a minute long and bound to the issuing session. The redeem
//! route isn't in the `OpenAPI` spec, so the validator lets every body
//! through; csurf and the desktop guard's `Origin` check skip it. The flush
//! route is validated as `/settings/cache/{cacheId}/flush`.

use std::sync::Mutex;

use axum::http::{header, HeaderValue, Method};
use base64::prelude::*;
use serde_json::{Map, Value};

use super::authcommon::{client_ip, finish, random_bytes, Native, Step};
use super::desktop::digest;
use super::userwrite::has_permission;
use super::{Outcome, Ready, Table, ADMIN};
use crate::auth::{now_ms, session_id};

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/settings/cache/browser/flush", Method::POST, flush),
    ("/api/v1/desktop/browser-cache/redeem", Method::POST, redeem),
];

const TICKET_LIFETIME_MS: i64 = 60_000;

/// One of `browserCacheTickets`, keyed by the ticket's digest.
struct Ticket {
    digest: String,
    user_id: i64,
    /// `req.sessionID`; express-session makes one up for a request without
    /// a session (an API key), which no session row ever has.
    session_id: Option<String>,
    expires_at: i64,
}

static TICKETS: Mutex<Vec<Ticket>> = Mutex::new(Vec::new());

/// `cleanupBrowserCacheTickets`.
fn cleanup(tickets: &mut Vec<Ticket>, now: i64) {
    tickets.retain(|t| t.expires_at > now);
}

/// `issueBrowserCacheTicket(userId, sessionId)`: the opaque ticket.
fn issue(user_id: i64, session_id: Option<String>) -> Result<String, String> {
    let ticket = BASE64_URL_SAFE_NO_PAD.encode(random_bytes(32)?);
    let now = now_ms();
    let entry = Ticket {
        digest: digest(&ticket),
        user_id,
        session_id,
        expires_at: now + TICKET_LIFETIME_MS,
    };
    let mut tickets = crate::sync::lock(&TICKETS);
    cleanup(&mut tickets, now);
    tickets.push(entry);
    drop(tickets);
    Ok(ticket)
}

/// Take a ticket out, used or not, and return it unless it expired.
fn take(ticket: &str) -> Option<Ticket> {
    let now = now_ms();
    let wanted = digest(ticket);
    let mut tickets = crate::sync::lock(&TICKETS);
    cleanup(&mut tickets, now);
    let found = tickets.iter().position(|t| t.digest == wanted);
    let record = found.map(|i| tickets.remove(i));
    drop(tickets);
    record.filter(|r| r.expires_at > now)
}

/// The response with the desktop router's `Cache-Control: no-store`.
fn no_store(mut outcome: Outcome) -> Outcome {
    if let Outcome::Done(res) = &mut outcome {
        res.headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    outcome
}

/// `{ code }` with the desktop router's `Cache-Control: no-store`.
fn code(ctx: &Ready<'_>, status: u16, code: &str) -> Outcome {
    let mut body = Map::new();
    body.insert(String::from("code"), Value::from(code));
    no_store(ctx.json_with(status, &Value::Object(body)))
}

/// `next(error)`: 500 with the message, still `no-store`.
fn failed(ctx: &Ready<'_>, message: &str) -> Outcome {
    tracing::error!("browser cache ticket: {message}");
    no_store(ctx.error(500, message))
}

/// `browserCacheRedeemBody`: a 43-character base64url ticket and protocol
/// version 1; the ticket when the body is one.
fn valid_body(body: Option<&Value>) -> Option<&str> {
    let Some(Value::Object(body)) = body else {
        return None;
    };
    let ticket = body.get("ticket").and_then(Value::as_str).filter(|s| {
        s.len() == 43
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    });
    let version = body
        .get("protocolVersion")
        .and_then(Value::as_f64)
        .is_some_and(|v| (v - 1.0).abs() < f64::EPSILON);
    ticket.filter(|_| version)
}

fn flush<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move { finish(flush_route(ctx)) })
}

/// `POST /settings/cache/browser/flush`. Remote/browser deployments
/// cannot and must not ask a native runtime to clear a profile they do
/// not own.
fn flush_route(ctx: &Ready<'_>) -> Step {
    ctx.no_query()?;
    let user = ctx.authenticated(ADMIN)?;
    if !crate::runtime::desktop_runtime() {
        return Ok(ctx.error(409, "Browser cache is managed by the desktop runtime only."));
    }
    // A restored desktop session is the one `req.sessionID` names.
    let headers = crate::runtime::desktop::session_headers(ctx.req);
    let sid = session_id(&headers, ctx.settings.session_secret());
    let ticket = issue(user.id, sid)?;
    let mut out = Map::new();
    out.insert(String::from("ticket"), Value::from(ticket));
    out.insert(String::from("expiresIn"), Value::from(TICKET_LIFETIME_MS));
    Ok(ctx.json_with(201, &Value::Object(out)))
}

fn redeem<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move { finish(redeem_route(ctx).await) })
}

/// `POST /desktop/browser-cache/redeem`. The ticket is consumed before
/// any I/O so a client racing the native bridge can't repeat the action.
async fn redeem_route(ctx: &Ready<'_>) -> Step {
    let Some(ticket) = valid_body(ctx.body.as_ref()) else {
        return Ok(code(ctx, 400, "invalid_request"));
    };
    let ip = client_ip(ctx)?;
    if !super::desktop::allow_request(&format!("browser-cache:ip:{ip}")) {
        return Ok(code(ctx, 429, "rate_limited"));
    }
    let Some(record) = take(ticket) else {
        return Ok(code(ctx, 401, "ticket_expired"));
    };
    let db = &ctx.state.db;
    let session_user = match &record.session_id {
        Some(sid) => match db.session_user_id(sid, now_ms()).await {
            Ok(session) => session.and_then(|s| s.user_id),
            Err(e) => return Ok(failed(ctx, &format!("{e:#}"))),
        },
        None => None,
    };
    let admin = match db.user_record(record.user_id).await {
        Ok(user) => user.is_some_and(|(user, _)| has_permission(user.permissions, ADMIN)),
        Err(e) => return Ok(failed(ctx, &format!("{e:#}"))),
    };
    if session_user != Some(record.user_id) || !admin {
        return Ok(code(ctx, 401, "session_expired"));
    }
    Ok(no_store(Ready::no_content()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bodies() {
        let ticket = "a".repeat(43);
        let valid = serde_json::json!({"ticket": ticket, "protocolVersion": 1});
        assert_eq!(valid_body(Some(&valid)), Some(ticket.as_str()), "valid");
        assert!(
            valid_body(Some(
                &serde_json::json!({"ticket": ticket, "protocolVersion": 2})
            ))
            .is_none(),
            "version"
        );
        assert!(
            valid_body(Some(
                &serde_json::json!({"ticket": "short", "protocolVersion": 1})
            ))
            .is_none(),
            "ticket"
        );
        assert!(valid_body(None).is_none(), "no body");
    }

    #[test]
    fn tickets_are_single_use_and_expire() -> Result<(), String> {
        let ticket = issue(7, Some(String::from("sid")))?;
        let body = serde_json::json!({"ticket": ticket, "protocolVersion": 1});
        assert!(valid_body(Some(&body)).is_some(), "a redeemable ticket");
        let record = take(&ticket).ok_or("the issued ticket redeems")?;
        assert_eq!(
            (record.user_id, record.session_id.as_deref()),
            (7, Some("sid")),
            "bound to the issuing user and session"
        );
        assert!(take(&ticket).is_none(), "consumed");

        let stale = issue(7, None)?;
        let stale_digest = digest(&stale);
        for t in crate::sync::lock(&TICKETS).iter_mut() {
            if t.digest == stale_digest {
                t.expires_at = now_ms();
            }
        }
        assert!(take(&stale).is_none(), "expired");
        Ok(())
    }
}
