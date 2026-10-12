//! Responses shaped like Express's `res.json`: compact JSON, a weak `ETag` and
//! a 304 when the client already has it.

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, Method, Response, StatusCode};
use base64::prelude::*;
use serde_json::Value;
use sha1::{Digest, Sha1};

/// A 200 JSON response, or a 304 when the request's validators match.
#[must_use]
pub fn json(method: &Method, req_headers: &HeaderMap, value: &Value) -> Response<Body> {
    json_status(200, method, req_headers, value)
}

/// A JSON response with `status`. Express only turns 2xx into a 304.
#[must_use]
pub fn json_status(
    status: u16,
    method: &Method,
    req_headers: &HeaderMap,
    value: &Value,
) -> Response<Body> {
    let body = serde_json::to_vec(value).unwrap_or_else(|e| {
        tracing::error!("serializing a response: {e}");
        Vec::new()
    });
    let etag = weak_etag(&body);
    let mut res = Response::new(Body::empty());
    if let Ok(v) = HeaderValue::from_str(&etag) {
        res.headers_mut().insert(header::ETAG, v);
    }
    let status_code = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let cacheable = (*method == Method::GET || *method == Method::HEAD) && status_code.is_success();
    if cacheable && fresh(req_headers, &etag) {
        *res.status_mut() = StatusCode::NOT_MODIFIED;
        return res;
    }
    *res.status_mut() = status_code;
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    *res.body_mut() = Body::from(body);
    res
}

/// The `etag` package's weak tag: length in hex, then 27 characters of the
/// base64 SHA-1 of the body.
#[must_use]
pub fn weak_etag(body: &[u8]) -> String {
    let hash = BASE64_STANDARD_NO_PAD.encode(Sha1::digest(body));
    format!("W/\"{:x}-{hash}\"", body.len())
}

/// The `fresh` package: whether the response can be a 304.
#[must_use]
pub fn fresh(req: &HeaderMap, etag: &str) -> bool {
    let text = |name: header::HeaderName| {
        req.get(name)
            .and_then(|v| v.to_str().ok())
            .filter(|v| !v.is_empty())
    };
    let none_match = text(header::IF_NONE_MATCH);
    let modified_since = text(header::IF_MODIFIED_SINCE);
    if none_match.is_none() && modified_since.is_none() {
        return false;
    }
    if text(header::CACHE_CONTROL).is_some_and(|c| c.split(',').any(|t| t.trim() == "no-cache")) {
        return false;
    }
    if let Some(list) = none_match.filter(|v| *v != "*") {
        if !list
            .split(',')
            .map(str::trim)
            .any(|m| etag_matches(m, etag))
        {
            return false;
        }
    }
    // Last-Modified is never sent, so a date alone can't make it fresh.
    modified_since.is_none()
}

/// Weak comparison, as `fresh` does it.
fn etag_matches(candidate: &str, etag: &str) -> bool {
    candidate == etag
        || candidate.strip_prefix("W/") == Some(etag)
        || etag.strip_prefix("W/") == Some(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn etag_matches_express() {
        // `etag(Buffer.from('{"a":1}'), { weak: true })`
        assert_eq!(
            weak_etag(br#"{"a":1}"#),
            "W/\"7-n4nHQM60bXQYySSnisV5QdXpZSA\"",
            "weak etag of a small body"
        );
        assert_eq!(
            weak_etag(b""),
            "W/\"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk\"",
            "weak etag of an empty body"
        );
    }

    #[test]
    fn freshness() {
        let etag = "W/\"3-abc\"";
        let mut req = HeaderMap::new();
        assert!(!fresh(&req, etag), "no validators");
        req.insert(header::IF_NONE_MATCH, HeaderValue::from_static("\"3-abc\""));
        assert!(fresh(&req, etag), "strong vs weak");
        req.insert(
            header::IF_NONE_MATCH,
            HeaderValue::from_static("\"x\", W/\"3-abc\""),
        );
        assert!(fresh(&req, etag), "list");
        req.insert(header::IF_NONE_MATCH, HeaderValue::from_static("*"));
        assert!(fresh(&req, etag), "star");
        req.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("max-age=0, no-cache"),
        );
        assert!(!fresh(&req, etag), "no-cache");
        req.remove(header::CACHE_CONTROL);
        req.insert(
            header::IF_MODIFIED_SINCE,
            HeaderValue::from_static("Mon, 01 Jan 2024 00:00:00 GMT"),
        );
        assert!(!fresh(&req, etag), "date without last-modified");
    }
}
