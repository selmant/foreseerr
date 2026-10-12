//! The middleware in front of everything else in the managed runtimes.
//!
//! Plugin mode (`listenApp.use(publicBasePath, server)` and
//! `requirePluginProxy`): the app lives under the base path, matched
//! case-insensitively; anything else is Express's 404. Under it, a request
//! that doesn't come from loopback with the shared secret in
//! `X-Foreseerr-Plugin-Secret` is refused with 403
//! `{"error":"Plugin proxy authentication required."}`. The prefix is then
//! cut off, as the mount does (`req.url`); Express's 404 page and the
//! static redirects still print the full path (`req.originalUrl`).
//!
//! Desktop runtime: while stopping, everything but `/api/v1/status` is 503
//! `{"message":"Foreseerr is shutting down"}`; otherwise a request is 403
//! `{"message":"Invalid local desktop request"}` when its `Host` isn't the
//! loopback origin's, it carries `X-Forwarded-Host` or `Forwarded`, its
//! target is an absolute URL, or it is a `POST`/`PUT`/`PATCH`/`DELETE`
//! whose `Origin` isn't the loopback origin (the two native redeem routes
//! excepted).
//!
//! Both: Express writes the session cookie last, after the cookies
//! middleware set, so `connect.sid` moves behind them.
//!
//! Every mode: an absolute-form target is turned into its origin form
//! (after the desktop guard, which refuses it).

use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderValue, Method, Response, Uri};
use axum::middleware::Next;
use serde_json::json;

use crate::state::AppState;

/// The path the request came in with, base path included: Express's 404
/// and directory redirects print `req.originalUrl`.
#[derive(Debug, Clone)]
pub struct Mounted(pub String);

/// The native hosts' redeem routes, which carry no browser `Origin`.
const NATIVE_TICKETS: [&str; 2] = [
    "/api/v1/desktop/auth-tickets/redeem",
    "/api/v1/desktop/browser-cache/redeem",
];

/// The middleware.
pub async fn layer(
    State(_state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
    next: Next,
) -> Response<Body> {
    if !super::active() {
        return next.run(origin_form(req)).await;
    }
    let mut req = req;
    if super::plugin_mode() {
        req = match mount(req) {
            Ok(req) => req,
            Err(res) => return *res,
        };
        let secret = req
            .headers()
            .get("x-foreseerr-plugin-secret")
            .map(HeaderValue::as_bytes);
        if !super::is_loopback(peer.ip()) || !super::verify_secret(secret) {
            return crate::respond::json_status(
                403,
                req.method(),
                req.headers(),
                &json!({ "error": "Plugin proxy authentication required." }),
            );
        }
    }
    if super::desktop_runtime() {
        if let Some(res) = guard(&req) {
            return res;
        }
    }
    let mut res = next.run(origin_form(req)).await;
    session_cookie_last(&mut res);
    res
}

/// An absolute-form target (`GET http://host/path`) is routed like its
/// path and query; the rest of the app only sees origin-form targets.
fn origin_form(mut req: Request) -> Request {
    if req.uri().scheme().is_none() && req.uri().authority().is_none() {
        return req;
    }
    let path = req
        .uri()
        .path_and_query()
        .map_or("/", axum::http::uri::PathAndQuery::as_str);
    if let Ok(uri) = Uri::try_from(path) {
        *req.uri_mut() = uri;
    }
    req
}

/// `path` starts with the mount (case-insensitive) followed by `/` or the
/// end: the length of the prefix.
fn mount_prefix(path: &str, mount: &str) -> Option<usize> {
    let head = path.get(..mount.len())?;
    (head.eq_ignore_ascii_case(mount)
        && matches!(path.as_bytes().get(mount.len()), None | Some(b'/')))
    .then_some(mount.len())
}

/// The plugin mount: strip the base path, or answer Express's 404.
fn mount(req: Request) -> Result<Request, Box<Response<Body>>> {
    let base = super::plugin_base_path();
    let path = req.uri().path().to_owned();
    let Some(len) = mount_prefix(&path, base) else {
        let (parts, _) = req.into_parts();
        return Err(Box::new(crate::standalone::fallback::not_found(&parts)));
    };
    let rest = path.get(len..).filter(|r| !r.is_empty()).unwrap_or("/");
    let target = req
        .uri()
        .query()
        .map_or_else(|| rest.to_owned(), |q| format!("{rest}?{q}"));
    let (mut parts, body) = req.into_parts();
    let mut uri = parts.uri.clone().into_parts();
    uri.path_and_query = target.parse().ok();
    if let Ok(rebuilt) = Uri::from_parts(uri) {
        parts.uri = rebuilt;
    }
    parts.extensions.insert(Mounted(path.clone()));
    Ok(Request::from_parts(parts, body))
}

/// The desktop guard's refusal, if any.
fn guard(req: &Request) -> Option<Response<Body>> {
    let stopping = super::desktop::stopping();
    let path = req.uri().path();
    let origin = super::desktop::origin();
    let host = origin
        .as_deref()
        .map(|o| o.strip_prefix("http://").unwrap_or(o));
    let headers = req.headers();
    let unsafe_method =
        [Method::POST, Method::PUT, Method::PATCH, Method::DELETE].contains(req.method());
    let native_ticket = NATIVE_TICKETS.contains(&path);
    let absolute = matches!(req.uri().scheme_str(), Some("http" | "https"));
    let header_is = |name: header::HeaderName, want: Option<&str>| {
        let got = headers.get(name).map(HeaderValue::as_bytes);
        matches!((got, want), (Some(g), Some(w)) if g == w.as_bytes())
    };
    let refused = (stopping && path != "/api/v1/status")
        || origin.is_none()
        || !header_is(header::HOST, host)
        || headers.contains_key("x-forwarded-host")
        || headers.contains_key(header::FORWARDED)
        || absolute
        || (unsafe_method && !native_ticket && !header_is(header::ORIGIN, origin.as_deref()));
    if !refused {
        return None;
    }
    let (status, message) = if stopping {
        (503, "Foreseerr is shutting down")
    } else {
        (403, "Invalid local desktop request")
    };
    Some(crate::respond::json_status(
        status,
        req.method(),
        headers,
        &json!({ "message": message }),
    ))
}

/// Move the `connect.sid` cookies behind every other `Set-Cookie`.
fn session_cookie_last(res: &mut Response<Body>) {
    let headers = res.headers_mut();
    let all: Vec<HeaderValue> = headers
        .get_all(header::SET_COOKIE)
        .iter()
        .cloned()
        .collect();
    if all.len() < 2 {
        return;
    }
    let (session, other): (Vec<HeaderValue>, Vec<HeaderValue>) = all
        .into_iter()
        .partition(|v| v.as_bytes().starts_with(b"connect.sid="));
    headers.remove(header::SET_COOKIE);
    for value in other.into_iter().chain(session) {
        headers.append(header::SET_COOKIE, value);
    }
}

/// The path Express prints for a request: with the plugin mount in front.
#[must_use]
pub fn original_path(parts: &axum::http::request::Parts) -> String {
    parts
        .extensions
        .get::<Mounted>()
        .map_or_else(|| parts.uri.path().to_owned(), |m| m.0.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolute_targets_become_origin_form() -> Result<(), axum::http::Error> {
        let uri_of = |target: &str| {
            Request::builder()
                .uri(target)
                .body(Body::empty())
                .map(|req| origin_form(req).uri().to_string())
        };
        assert_eq!(
            uri_of("http://h:1/api/v1/status?x=1")?,
            "/api/v1/status?x=1",
            "path and query kept"
        );
        assert_eq!(uri_of("https://h")?, "/", "no path");
        assert_eq!(uri_of("/a?b")?, "/a?b", "origin form untouched");
        Ok(())
    }

    #[test]
    fn mount_matching() {
        assert_eq!(
            mount_prefix("/Foreseerr/api", "/Foreseerr"),
            Some(10),
            "below"
        );
        assert_eq!(mount_prefix("/foreseerr", "/Foreseerr"), Some(10), "case");
        assert_eq!(
            mount_prefix("/Foreseerrx", "/Foreseerr"),
            None,
            "longer name"
        );
        assert_eq!(mount_prefix("/api", "/Foreseerr"), None, "outside");
    }

    #[test]
    fn session_cookie_moves_last() {
        let mut res = Response::new(Body::empty());
        for v in ["connect.sid=a", "_csrf=b", "XSRF-TOKEN=c"] {
            res.headers_mut()
                .append(header::SET_COOKIE, HeaderValue::from_static(v));
        }
        session_cookie_last(&mut res);
        let order: Vec<&[u8]> = res
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(HeaderValue::as_bytes)
            .collect();
        assert_eq!(
            order,
            vec![&b"_csrf=b"[..], b"XSRF-TOKEN=c", b"connect.sid=a"],
            "order"
        );
    }
}
