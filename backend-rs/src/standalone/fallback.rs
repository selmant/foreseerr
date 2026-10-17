//! What standalone mode answers for requests no Rust handler takes (the
//! handlers answer their own failures, see `routes::Fallback`).
//!
//! Under `/api`, the `OpenAPI` validator's answers are reproduced from the
//! spec ([`super::apiroutes`]): 405 for an undocumented method, 401 for a
//! secured route without a credential; an undocumented path falls through
//! to Express's 404. A documented route without a handler answers a plain
//! 500.
//!
//! `/internal` is answered in-process behind Node's API-key guard. In
//! production the built frontend is served with the SPA fallback; the rest
//! is Express's `finalhandler` 404. `/api-docs` (Swagger UI) is not served.

use axum::body::Body;
use axum::http::request::Parts;
use axum::http::{header, HeaderMap, Method, Request, Response, StatusCode};
use serde_json::{json, Value};

use super::internal;
use crate::state::AppState;

/// One documented route: the `OpenAPI` path, its segments (`None` for a
/// parameter) and its methods with whether each needs a credential.
#[derive(Debug)]
pub struct ApiRoute {
    /// `/api/v1/user/{userId}`.
    pub template: &'static str,
    /// `api`, `v1`, `user`, parameter.
    pub segments: &'static [Option<&'static str>],
    /// `GET`, secured.
    pub methods: &'static [(&'static str, bool)],
}

/// Answer a request no Rust handler took.
pub async fn answer(state: &AppState, req: Request<Body>) -> Response<Body> {
    let (parts, body) = req.into_parts();
    let path = parts.uri.path().to_owned();
    if under(&path, "/api") {
        if find(&path).is_none() {
            if let Some(res) = unrouted(state, &parts).await {
                return res;
            }
        }
        return api(&parts);
    }
    if let Some(res) = super::apidocs::answer(&state.env.app_root, &parts).await {
        return res;
    }
    if under(&path, "/internal") {
        if let Some(res) = internal_http(state, &parts, body).await {
            return res;
        }
    }
    if let Some(res) = crate::runtime::plugin::index(&parts) {
        return res;
    }
    if let Some(root) = super::statics::root(&state.env.app_root) {
        if let Some(res) = super::statics::serve_static(&root, &parts).await {
            return res;
        }
        if let Some(res) = super::statics::spa(&root, &parts).await {
            return res;
        }
    }
    not_found(&parts)
}

/// The `/api/v1` mounts of `server/routes/index.ts` that guard with
/// `isAuthenticated(permission)` before their routers run.
const GUARDED_MOUNTS: [(&str, i64); 20] = [
    ("/api/v1/user", 0),
    ("/api/v1/settings", ADMIN),
    ("/api/v1/search", 0),
    ("/api/v1/discover", 0),
    ("/api/v1/request", 0),
    ("/api/v1/watchlist", 0),
    ("/api/v1/blocklist", 0),
    ("/api/v1/blacklist", 0),
    ("/api/v1/movie", 0),
    ("/api/v1/tv", 0),
    ("/api/v1/media", 0),
    ("/api/v1/library", 0),
    ("/api/v1/media-actions", 0),
    ("/api/v1/person", 0),
    ("/api/v1/collection", 0),
    ("/api/v1/calendar", 0),
    ("/api/v1/service", 0),
    ("/api/v1/issue", 0),
    ("/api/v1/issueComment", 0),
    ("/api/v1/overrideRule", ADMIN),
];

/// `Permission.ADMIN`.
const ADMIN: i64 = 2;

/// An `/api` path the spec doesn't document, walked through Node's routers:
/// the `/api/v1` root answers its banner; a guarded mount checks
/// `isAuthenticated()` first; mounts whose middleware sets headers do so
/// before the 404. `None` for everything
/// else, and when the user can't be worked out here.
async fn unrouted(state: &AppState, parts: &Parts) -> Option<Response<Body>> {
    let path = parts.uri.path();
    let get = matches!(parts.method, Method::GET | Method::HEAD);
    if get
        && matches!(
            path.to_ascii_lowercase().as_str(),
            "/api/v1" | "/api/v1/" | "/api/v1//"
        )
    {
        return Some(crate::respond::json_status(
            200,
            &parts.method,
            &parts.headers,
            &json!({ "api": "Seerr API", "version": "1.0" }),
        ));
    }
    if under(path, "/api/v1/desktop") {
        let mut res = not_found(parts);
        res.headers_mut().insert(
            header::CACHE_CONTROL,
            header::HeaderValue::from_static("no-store"),
        );
        return Some(res);
    }
    let &(mount, permission) = GUARDED_MOUNTS.iter().find(|(m, _)| under(path, m))?;
    let settings = state.settings.current().await.ok()?;
    let identity = crate::auth::check_user(&state.db, &settings, &parts.headers)
        .await
        .ok()?;
    let user = match identity {
        crate::auth::Identity::Unportable(_) => return None,
        crate::auth::Identity::Anonymous => None,
        crate::auth::Identity::User(user) => Some(user),
    };
    if !user.is_some_and(|u| u.has_permission(permission)) {
        return Some(crate::respond::json_status(
            403,
            &parts.method,
            &parts.headers,
            &json!({
                "status": 403,
                "error": "You do not have permission to access this endpoint",
            }),
        ));
    }
    let mut res = not_found(parts);
    if mount == "/api/v1/blacklist" {
        deprecation_headers(res.headers_mut());
    }
    Some(res)
}

/// What `deprecatedRoute` sets on every `/blacklist` answer past the
/// mount's `isAuthenticated()`.
fn deprecation_headers(headers: &mut HeaderMap) {
    headers.insert("deprecation", header::HeaderValue::from_static("true"));
    headers.insert(
        "link",
        header::HeaderValue::from_static("</api/v1/blocklist>; rel=\"successor-version\""),
    );
    headers.insert(
        "sunset",
        header::HeaderValue::from_static("Mon, 01 Jun 2026 00:00:00 GMT"),
    );
}

/// `path` is `prefix` or below it (Express mounts match case-insensitively).
fn under(path: &str, prefix: &str) -> bool {
    path.get(..prefix.len())
        .is_some_and(|p| p.eq_ignore_ascii_case(prefix))
        && matches!(path.as_bytes().get(prefix.len()), None | Some(b'/'))
}

fn api(parts: &Parts) -> Response<Body> {
    let path = parts.uri.path();
    let Some(route) = find(path) else {
        return not_found(parts);
    };
    let method = parts.method.as_str();
    let Some(&(_, secured)) = route.methods.iter().find(|(m, _)| *m == method) else {
        // `req.path` below the `/api` mount.
        let below = path.get(4..).unwrap_or("");
        return validator_error(parts, 405, &format!("{method} method not allowed"), below);
    };
    if secured && !credential_present(&parts.headers) {
        // `servers` carries the plugin mount (`pluginApiSpec`).
        let template = format!("{}{}", crate::runtime::api_server_prefix(), route.template);
        return validator_error(parts, 401, "cookie 'connect.sid' required", &template);
    }
    internal_error(parts)
}

/// The first documented route matching `path`, as path-to-regexp 8 matches
/// (case-insensitive, an optional trailing slash, non-empty parameters).
fn find(path: &str) -> Option<&'static ApiRoute> {
    let trimmed = if path.len() > 1 {
        path.strip_suffix('/').unwrap_or(path)
    } else {
        path
    };
    let segments: Vec<&str> = trimmed.strip_prefix('/')?.split('/').collect();
    super::apiroutes::ROUTES.iter().find(|route| {
        route.segments.len() == segments.len()
            && route.segments.iter().zip(&segments).all(|(want, got)| {
                want.map_or(!got.is_empty(), |literal| literal.eq_ignore_ascii_case(got))
            })
    })
}

/// The validator's security check: a non-empty `connect.sid` cookie or
/// `X-Api-Key` header.
fn credential_present(headers: &HeaderMap) -> bool {
    let api_key = headers
        .get_all("x-api-key")
        .iter()
        .any(|v| !v.as_bytes().is_empty());
    let cookie = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|h| {
            h.split(';').find_map(|pair| {
                let (k, v) = pair.split_once('=')?;
                (k.trim() == "connect.sid").then(|| v.trim().trim_matches('"').to_owned())
            })
        })
        .is_some_and(|v| !v.is_empty());
    api_key || cookie
}

/// An express-openapi-validator error through Node's error handler.
fn validator_error(parts: &Parts, status: u16, message: &str, path: &str) -> Response<Body> {
    let mut res = crate::respond::json_status(
        status,
        &parts.method,
        &parts.headers,
        &json!({
            "message": message,
            "errors": [{ "path": path, "message": message }],
        }),
    );
    res.extensions_mut()
        .insert(crate::runtime::desktop::Unrouted);
    res
}

/// The last resort for a documented route no Rust handler answers.
fn internal_error(parts: &Parts) -> Response<Body> {
    tracing::error!(
        "{} {}: no handler answers this documented route",
        parts.method,
        parts.uri.path()
    );
    crate::respond::json_status(
        500,
        &parts.method,
        &parts.headers,
        &json!({ "message": "Internal Server Error" }),
    )
}

/// `internalRoutes`: the API-key guard, then the in-process answer; `None`
/// for a path Node has no internal route for (Express moves on).
async fn internal_http(state: &AppState, parts: &Parts, body: Body) -> Option<Response<Body>> {
    let key = state
        .settings
        .current()
        .await
        .map(|s| s.api_key().to_owned())
        .unwrap_or_default();
    let given = parts
        .headers
        .get("x-api-key")
        .map(axum::http::HeaderValue::as_bytes);
    // `apiKeyMatches`: `timingSafeEqual`.
    let allowed = !key.is_empty()
        && given.is_some_and(|g| bool::from(subtle::ConstantTimeEq::ct_eq(g, key.as_bytes())));
    if !allowed {
        return Some(crate::respond::json_status(
            403,
            &parts.method,
            &parts.headers,
            &json!({ "message": "Forbidden" }),
        ));
    }
    let below = parts.uri.path().get("/internal".len()..).unwrap_or("");
    internal::group(below)?;
    let body = if parts.method == Method::GET {
        None
    } else {
        use http_body_util::BodyExt;
        let bytes = body.collect().await.ok()?.to_bytes();
        serde_json::from_slice::<Value>(&bytes).ok()
    };
    let answer = internal::call(state, &parts.method, below, body.as_ref()).await;
    if answer.body.is_null() {
        let mut res = Response::new(Body::empty());
        *res.status_mut() = StatusCode::from_u16(answer.status).unwrap_or(StatusCode::NO_CONTENT);
        return Some(res);
    }
    Some(crate::respond::json_status(
        answer.status,
        &parts.method,
        &parts.headers,
        &answer.body,
    ))
}

/// The 404 page: `Cannot GET /path`, the path as the request came in
/// (with the plugin mount).
pub(crate) fn not_found(parts: &Parts) -> Response<Body> {
    let path = crate::runtime::http::original_path(parts);
    let message = format!("Cannot {} {path}", parts.method);
    let doc = html_document("Error", &escape_html(&message));
    super::statics::html_response(StatusCode::NOT_FOUND, doc, "text/html; charset=utf-8")
}

/// finalhandler's and send's `createHtmlDocument` (the body already escaped
/// where it needs to be).
pub(super) fn html_document(title: &str, body: &str) -> String {
    let body = body.replace('\n', "<br>").replace("  ", " &nbsp;");
    format!(
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>{title}</title>\n</head>\n<body>\n<pre>{body}</pre>\n</body>\n</html>\n"
    )
}

/// `escape-html`.
pub(super) fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// One upper-case hex digit.
fn hex_digit(n: u8) -> char {
    char::from_digit(u32::from(n), 16).map_or('0', |c| c.to_ascii_uppercase())
}

/// `encodeurl` 2: every run of characters a URL can't hold, and of `%`s
/// that don't start an escape together with the one or two characters
/// after them, goes through `encodeURI`.
pub(crate) fn encode_url(text: &str) -> String {
    let allowed = |c: char| {
        matches!(c, '!' | '#'..=';' | '=' | '?'..='_' | 'a'..='z' | '|' | '~') && c != '%'
    };
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while let Some(&c) = chars.get(i) {
        let hex = |k: usize| chars.get(k).is_some_and(char::is_ascii_hexdigit);
        if allowed(c) {
            out.push(c);
            i += 1;
        } else if c == '%' && hex(i + 1) && (hex(i + 2) || i + 2 >= chars.len()) {
            // A valid escape, or `%` and one hex digit at the end, which
            // the expression doesn't match.
            out.push('%');
            i += 1;
        } else {
            // `%` plus a non-hex character, `%` plus a hex digit and a
            // non-hex character, a lone `%` at the end, or one character.
            let take = if c == '%' {
                if hex(i + 1) {
                    3
                } else {
                    2
                }
            } else {
                1
            };
            for &d in chars
                .get(i..(i + take).min(chars.len()))
                .unwrap_or_default()
            {
                encode_uri_char(d, &mut out);
            }
            i += take;
        }
    }
    out
}

/// `encodeURI` of one character.
fn encode_uri_char(c: char, out: &mut String) {
    let kept = c.is_ascii_alphanumeric() || ";,/?:@&=+$-_.!~*'()#".contains(c);
    if kept {
        out.push(c);
        return;
    }
    let mut utf8 = [0_u8; 4];
    for b in c.encode_utf8(&mut utf8).bytes() {
        out.push('%');
        out.push(hex_digit(b >> 4));
        out.push(hex_digit(b & 0x0f));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parts(
        method: Method,
        uri: &str,
        headers: &[(&str, &str)],
    ) -> Result<Parts, axum::http::Error> {
        let mut builder = Request::builder().method(method).uri(uri);
        for (k, v) in headers {
            builder = builder.header(*k, *v);
        }
        Ok(builder.body(())?.into_parts().0)
    }

    async fn body_text(res: Response<Body>) -> Result<String, Box<dyn std::error::Error>> {
        use http_body_util::BodyExt;
        let bytes = res.into_body().collect().await?.to_bytes();
        Ok(String::from_utf8(bytes.to_vec())?)
    }

    #[tokio::test]
    async fn not_found_page() -> Result<(), Box<dyn std::error::Error>> {
        let res = not_found(&parts(Method::GET, "/api", &[])?);
        assert_eq!(res.status(), StatusCode::NOT_FOUND, "status");
        assert_eq!(
            res.headers()
                .get(header::CONTENT_SECURITY_POLICY)
                .map(axum::http::HeaderValue::as_bytes),
            Some(&b"default-src 'none'"[..]),
            "csp"
        );
        let text = body_text(res).await?;
        assert_eq!(text.len(), 142, "the length Node sends for GET /api");
        assert!(text.contains("<pre>Cannot GET /api</pre>"), "message");
        Ok(())
    }

    #[tokio::test]
    async fn validator_answers() -> Result<(), Box<dyn std::error::Error>> {
        let res = api(&parts(Method::POST, "/api/v1/status", &[])?);
        assert_eq!(
            res.status(),
            StatusCode::METHOD_NOT_ALLOWED,
            "undocumented method"
        );
        assert_eq!(
            body_text(res).await?,
            r#"{"message":"POST method not allowed","errors":[{"path":"/v1/status","message":"POST method not allowed"}]}"#,
            "as Node answers"
        );
        let res = api(&parts(Method::GET, "/api/v1/settings/main", &[])?);
        assert_eq!(
            body_text(res).await?,
            r#"{"message":"cookie 'connect.sid' required","errors":[{"path":"/api/v1/settings/main","message":"cookie 'connect.sid' required"}]}"#,
            "no credential"
        );
        let res = api(&parts(Method::GET, "/api/v1/nonexistent", &[])?);
        assert_eq!(res.status(), StatusCode::NOT_FOUND, "undocumented path");
        let res = api(&parts(
            Method::GET,
            "/api/v1/settings/main",
            &[("cookie", "connect.sid=s%3Aabc")],
        )?);
        assert_eq!(
            res.status(),
            StatusCode::INTERNAL_SERVER_ERROR,
            "a route without a handler"
        );
        assert_eq!(
            body_text(res).await?,
            r#"{"message":"Internal Server Error"}"#,
            "the last resort"
        );
        Ok(())
    }

    #[test]
    fn routes_match_like_the_validator() {
        assert_eq!(
            find("/api/v1/user/5").map(|r| r.template),
            Some("/api/v1/user/{userId}"),
            "parameter"
        );
        assert_eq!(
            find("/api/v1/user/import-from-plex").map(|r| r.template),
            Some("/api/v1/user/import-from-plex"),
            "literal before parameter"
        );
        assert_eq!(
            find("/API/v1/Status/").map(|r| r.template),
            Some("/api/v1/status"),
            "case and trailing slash"
        );
        assert!(find("/api/v1/user//").is_none(), "empty parameter");
        assert!(find("/api/v1/status/nope").is_none(), "longer");
    }

    #[test]
    fn credentials_like_the_validator() -> Result<(), axum::http::Error> {
        let has =
            |h: &[(&str, &str)]| parts(Method::GET, "/", h).map(|p| credential_present(&p.headers));
        assert!(!has(&[])?, "none");
        assert!(!has(&[("cookie", "connect.sid=")])?, "empty cookie");
        assert!(has(&[("cookie", "a=b; connect.sid=x")])?, "cookie");
        assert!(has(&[("X-Api-Key", "k")])?, "header");
        assert!(!has(&[("X-Api-Key", "")])?, "empty header");
        Ok(())
    }

    #[test]
    fn helpers_like_node_packages() {
        assert_eq!(encode_url("/a b/%20/%zz"), "/a%20b/%20/%25zz", "encodeurl");
        assert_eq!(
            encode_url("%%60"),
            "%25%2560",
            "a bad escape takes the next one"
        );
        assert_eq!(
            encode_url("/^}%["),
            "/^%7D%25%5B",
            "encodeURI after a bad escape"
        );
        assert_eq!(encode_url("/a%4|"), "/a%254%7C", "half an escape");
        assert_eq!(encode_url("/a%4"), "/a%4", "half an escape at the end");
        assert_eq!(
            escape_html("<a href=\"x\">&'"),
            "&lt;a href=&quot;x&quot;&gt;&amp;&#39;",
            "escape-html"
        );
        assert!(under("/api", "/api") && under("/API/v1", "/api"), "mount");
        assert!(!under("/apis", "/api"), "not a segment");
    }
}
