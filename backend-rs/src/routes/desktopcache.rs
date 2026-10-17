//! `POST /desktop/browser-cache/redeem`: the native host redeems a
//! browser-cache ticket.
//!
//! Node's tickets come from
//! `POST /settings/cache/browser/flush`, which `/cache/:cacheId/flush`
//! shadows (Express matches it first and answers `Cache not found.`), so no
//! ticket is ever issued: a well-formed request ends at `ticket_expired`.
//! The route isn't in the `OpenAPI` spec, so the validator lets every body
//! through; csurf and the desktop guard's `Origin` check skip it.

use axum::http::{header, HeaderValue, Method};
use serde_json::{Map, Value};

use super::authcommon::{client_ip, finish, Native, Step};
use super::{Outcome, Ready, Table};

/// This module's routes.
pub(super) const ROUTES: &Table = &[("/api/v1/desktop/browser-cache/redeem", Method::POST, redeem)];

/// `{ code }` with the desktop router's `Cache-Control: no-store`.
fn code(ctx: &Ready<'_>, status: u16, code: &str) -> Outcome {
    let mut body = Map::new();
    body.insert(String::from("code"), Value::from(code));
    let mut outcome = ctx.json_with(status, &Value::Object(body));
    if let Outcome::Done(res) = &mut outcome {
        res.headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    outcome
}

/// `browserCacheRedeemBody`: a 43-character base64url ticket and protocol
/// version 1.
fn valid_body(body: Option<&Value>) -> bool {
    let Some(Value::Object(body)) = body else {
        return false;
    };
    let ticket = body.get("ticket").and_then(Value::as_str).is_some_and(|s| {
        s.len() == 43
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    });
    let version = body
        .get("protocolVersion")
        .and_then(Value::as_f64)
        .is_some_and(|v| (v - 1.0).abs() < f64::EPSILON);
    ticket && version
}

fn redeem<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move { finish(redeem_route(ctx)) })
}

fn redeem_route(ctx: &Ready<'_>) -> Step {
    if !valid_body(ctx.body.as_ref()) {
        return Ok(code(ctx, 400, "invalid_request"));
    }
    let ip = client_ip(ctx)?;
    if !super::desktop::allow_request(&format!("browser-cache:ip:{ip}")) {
        return Ok(code(ctx, 429, "rate_limited"));
    }
    Ok(code(ctx, 401, "ticket_expired"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bodies() {
        let ticket = "a".repeat(43);
        assert!(
            valid_body(Some(
                &serde_json::json!({"ticket": ticket, "protocolVersion": 1})
            )),
            "valid"
        );
        assert!(
            !valid_body(Some(
                &serde_json::json!({"ticket": ticket, "protocolVersion": 2})
            )),
            "version"
        );
        assert!(
            !valid_body(Some(
                &serde_json::json!({"ticket": "short", "protocolVersion": 1})
            )),
            "ticket"
        );
        assert!(!valid_body(None), "no body");
    }
}
