//! The built frontend, served as `server/index.ts` serves it in production:
//! `express.static(PUBLIC_PATH, { index: false, setHeaders })` (serve-static
//! 2 over send 1) and the SPA fallback `res.sendFile(index.html)` with
//! `Cache-Control: no-store`.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use axum::body::Body;
use axum::http::request::Parts;
use axum::http::{header, HeaderMap, HeaderValue, Method, Response, StatusCode};
use chrono::{DateTime, Utc};

/// `express.static`: the file under `root`, or `None` where serve-static
/// calls `next()` (not GET/HEAD, missing, a dotfile, a failed check).
pub(super) async fn serve_static(root: &Path, parts: &Parts) -> Option<Response<Body>> {
    serve_path(root, parts, parts.uri.path(), cache_control_for).await
}

/// `express.static(root, { index: false })` for `pathname` below its
/// mount, with `cache_control` as its `setHeaders`.
pub(super) async fn serve_path(
    root: &Path,
    parts: &Parts,
    pathname: &str,
    cache_control: fn(&Path) -> Option<&'static str>,
) -> Option<Response<Body>> {
    if parts.method != Method::GET && parts.method != Method::HEAD {
        return None;
    }
    let segments = safe_segments(pathname)?;
    let file = segments.iter().fold(root.to_path_buf(), |p, s| p.join(s));
    let meta = tokio::fs::metadata(&file).await.ok()?;
    if meta.is_dir() {
        if pathname.ends_with('/') {
            return None;
        }
        return Some(redirect_to_directory(parts));
    }
    if pathname.ends_with('/') {
        // ENOTDIR
        return None;
    }
    let preset = cache_control(&file);
    match send_file(&file, &meta, parts, preset).await {
        Sent::Response(res) => Some(res),
        // serve-static turns send's 4xx into next().
        Sent::Failed(_) => None,
    }
}

/// The SPA fallback route: `index.html` with `no-store` for every GET (and
/// HEAD) outside `/api`, `/api-docs`, `/imageproxy`, `/avatarproxy` and
/// `/assets/`. `None` when the route doesn't match.
pub(super) async fn spa(root: &Path, parts: &Parts) -> Option<Response<Body>> {
    if parts.method != Method::GET && parts.method != Method::HEAD {
        return None;
    }
    if !spa_route(parts.uri.path()) {
        return None;
    }
    let file = root.join("index.html");
    let Ok(meta) = tokio::fs::metadata(&file).await else {
        // send's stat error reaches the error handler.
        let message = format!(
            "ENOENT: no such file or directory, stat '{}'",
            file.display()
        );
        return Some(no_store(error_json(parts, 404, &message)));
    };
    Some(
        match send_file(&file, &meta, parts, Some("no-store")).await {
            Sent::Response(res) => res,
            Sent::Failed(status) => {
                let message = StatusCode::from_u16(status)
                    .ok()
                    .and_then(|s| s.canonical_reason())
                    .unwrap_or("Error");
                no_store(error_json(parts, status, message))
            }
        },
    )
}

/// `/^(?!\/api(?:\/|$)|\/api-docs|\/imageproxy|\/avatarproxy|\/assets\/).*/`.
fn spa_route(path: &str) -> bool {
    let api = path == "/api" || path.starts_with("/api/");
    !(api
        || path.starts_with("/api-docs")
        || path.starts_with("/imageproxy")
        || path.starts_with("/avatarproxy")
        || path.starts_with("/assets/"))
}

fn no_store(mut res: Response<Body>) -> Response<Body> {
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/// The error handler's `{ message }` (no `errors`).
fn error_json(parts: &Parts, status: u16, message: &str) -> Response<Body> {
    crate::respond::json_status(
        status,
        &parts.method,
        &parts.headers,
        &serde_json::json!({ "message": message }),
    )
}

/// The decoded path segments send would join under the root, or `None`
/// where it fails (malformed escapes, NUL, `..`) or ignores the file (a
/// dotfile).
fn safe_segments(pathname: &str) -> Option<Vec<String>> {
    let decoded = percent_decode(pathname)?;
    if decoded.contains('\0') {
        return None;
    }
    let mut out = Vec::new();
    for segment in decoded.split(['/', '\\']) {
        match segment {
            "" | "." => {}
            ".." => return None,
            s if s.starts_with('.') => return None,
            s => out.push(s.to_owned()),
        }
    }
    Some(out)
}

/// `decodeURIComponent`, `None` when it would throw.
fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while let Some(&b) = bytes.get(i) {
        if b == b'%' {
            let hex = text.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The `setHeaders` callback in server/index.ts.
fn cache_control_for(file: &Path) -> Option<&'static str> {
    let text = file.to_string_lossy();
    let sep = std::path::MAIN_SEPARATOR;
    if text.ends_with(&format!("{sep}index.html")) {
        return Some("no-store");
    }
    if text.contains(&format!("{sep}assets{sep}")) {
        return Some("public, max-age=31536000, immutable");
    }
    None
}

/// serve-static's directory redirect: 301 to the path with a slash.
fn redirect_to_directory(parts: &Parts) -> Response<Body> {
    let mut pathname = format!("{}/", crate::runtime::http::original_path(parts));
    while pathname.starts_with("//") {
        pathname.remove(0);
    }
    let location = match parts.uri.query() {
        Some(q) => format!("{pathname}?{q}"),
        None => pathname,
    };
    let location = super::fallback::encode_url(&location);
    let doc = super::fallback::html_document(
        "Redirecting",
        &format!("Redirecting to {}", super::fallback::escape_html(&location)),
    );
    let mut res = html_response(
        StatusCode::MOVED_PERMANENTLY,
        doc,
        "text/html; charset=UTF-8",
    );
    if let Ok(v) = HeaderValue::from_str(&location) {
        res.headers_mut().insert(header::LOCATION, v);
    }
    res
}

/// An HTML answer with send's security headers.
pub(super) fn html_response(
    status: StatusCode,
    doc: String,
    content_type: &'static str,
) -> Response<Body> {
    let mut res = Response::new(Body::from(doc));
    *res.status_mut() = status;
    let headers = res.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    res
}

enum Sent {
    Response(Response<Body>),
    /// send failed with this status (412, 416, a read error).
    Failed(u16),
}

/// What `send` does for one file: validators, conditional GET, one byte
/// range, HEAD.
async fn send_file(
    file: &Path,
    meta: &std::fs::Metadata,
    parts: &Parts,
    cache_control: Option<&'static str>,
) -> Sent {
    let size = meta.len();
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis());
    let last_modified = utc_string(mtime_ms);
    let etag = format!("W/\"{size:x}-{mtime_ms:x}\"");
    let req = &parts.headers;
    if conditional(req) {
        if precondition_failure(req, &etag, &last_modified) {
            return Sent::Failed(412);
        }
        if fresh(req, &etag, &last_modified) {
            let mut res = Response::new(Body::empty());
            *res.status_mut() = StatusCode::NOT_MODIFIED;
            validators(res.headers_mut(), cache_control, &last_modified, &etag);
            return Sent::Response(res);
        }
    }
    let mut status = StatusCode::OK;
    let mut range: Option<(u64, u64)> = None;
    if let Some(spec) =
        text(req, header::RANGE.as_str()).filter(|r| r.trim_start().starts_with("bytes="))
    {
        if range_fresh(req, &etag, &last_modified) {
            match parse_range(size, spec) {
                RangeResult::Unsatisfiable => return Sent::Failed(416),
                RangeResult::One(start, end) => {
                    status = StatusCode::PARTIAL_CONTENT;
                    range = Some((start, end));
                }
                RangeResult::Ignore => {}
            }
        }
    }
    let mut res = Response::new(Body::empty());
    *res.status_mut() = status;
    let headers = res.headers_mut();
    validators(headers, cache_control, &last_modified, &etag);
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(content_type(file)),
    );
    let (start, len) = match range {
        Some((start, end)) => {
            if let Ok(v) = HeaderValue::from_str(&format!("bytes {start}-{end}/{size}")) {
                headers.insert(header::CONTENT_RANGE, v);
            }
            (start, end - start + 1)
        }
        None => (0, size),
    };
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(len));
    if parts.method == Method::HEAD {
        return Sent::Response(res);
    }
    let Ok(bytes) = tokio::fs::read(file).await else {
        return Sent::Failed(500);
    };
    let from = usize::try_from(start).unwrap_or(usize::MAX);
    let to = usize::try_from(start + len).unwrap_or(usize::MAX);
    let Some(slice) = bytes.get(from..to) else {
        return Sent::Failed(500);
    };
    *res.body_mut() = Body::from(slice.to_vec());
    Sent::Response(res)
}

fn validators(
    headers: &mut HeaderMap,
    cache_control: Option<&'static str>,
    last_modified: &str,
    etag: &str,
) {
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(cache_control.unwrap_or("public, max-age=0")),
    );
    if let Ok(v) = HeaderValue::from_str(last_modified) {
        headers.insert(header::LAST_MODIFIED, v);
    }
    if let Ok(v) = HeaderValue::from_str(etag) {
        headers.insert(header::ETAG, v);
    }
}

/// `Date.prototype.toUTCString()`.
fn utc_string(ms: u128) -> String {
    let ms = i64::try_from(ms).unwrap_or(0);
    DateTime::<Utc>::from_timestamp_millis(ms)
        .unwrap_or_default()
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string()
}

/// `Date.parse` for HTTP dates; `None` for `NaN`.
fn parse_http_date(text: &str) -> Option<i64> {
    DateTime::parse_from_rfc2822(text.trim())
        .ok()
        .map(|d| d.timestamp_millis())
}

fn text<'a>(req: &'a HeaderMap, name: &str) -> Option<&'a str> {
    req.get(name)
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty())
}

fn conditional(req: &HeaderMap) -> bool {
    [
        "if-match",
        "if-unmodified-since",
        "if-none-match",
        "if-modified-since",
    ]
    .iter()
    .any(|h| text(req, h).is_some())
}

/// `parseTokenList`: comma-separated, spaces trimmed, empties dropped.
fn tokens(list: &str) -> impl Iterator<Item = &str> {
    list.split(',')
        .map(|t| t.trim_matches(' '))
        .filter(|t| !t.is_empty())
}

fn etag_match(candidate: &str, etag: &str) -> bool {
    candidate == etag || format!("W/{etag}") == candidate || format!("W/{candidate}") == etag
}

fn precondition_failure(req: &HeaderMap, etag: &str, last_modified: &str) -> bool {
    if let Some(list) = text(req, "if-match") {
        return list != "*" && tokens(list).all(|m| !etag_match(m, etag));
    }
    if let Some(since) = text(req, "if-unmodified-since").and_then(parse_http_date) {
        return parse_http_date(last_modified).is_none_or(|lm| lm > since);
    }
    false
}

/// The `fresh` package (2.0).
fn fresh(req: &HeaderMap, etag: &str, last_modified: &str) -> bool {
    let modified_since = text(req, "if-modified-since");
    let none_match = text(req, "if-none-match");
    if modified_since.is_none() && none_match.is_none() {
        return false;
    }
    if text(req, "cache-control").is_some_and(|c| c.split(',').any(|t| t.trim() == "no-cache")) {
        return false;
    }
    if let Some(list) = none_match {
        return list == "*" || tokens(list).any(|m| etag_match(m, etag));
    }
    match (
        parse_http_date(last_modified),
        modified_since.and_then(parse_http_date),
    ) {
        (Some(lm), Some(since)) => lm <= since,
        _ => false,
    }
}

/// `isRangeFresh`: `If-Range` names this `ETag` or a date not before it.
fn range_fresh(req: &HeaderMap, etag: &str, last_modified: &str) -> bool {
    let Some(if_range) = text(req, "if-range") else {
        return true;
    };
    if if_range.contains('"') {
        return if_range.contains(etag);
    }
    match (parse_http_date(last_modified), parse_http_date(if_range)) {
        (Some(lm), Some(at)) => lm <= at,
        _ => false,
    }
}

#[derive(Debug, PartialEq, Eq)]
enum RangeResult {
    /// No usable range: send the whole file.
    Ignore,
    /// range-parser's -1.
    Unsatisfiable,
    /// One combined range, inclusive.
    One(u64, u64),
}

/// `parseInt(text, 10)`, `None` for `NaN`.
fn parse_int(text: &str) -> Option<i64> {
    let t = text.trim_start();
    let (negative, rest) = t
        .strip_prefix('-')
        .map_or_else(|| (false, t.strip_prefix('+').unwrap_or(t)), |r| (true, r));
    let end = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
    let n: i64 = rest.get(..end.min(18))?.parse().ok()?;
    Some(if negative { -n } else { n })
}

/// range-parser 1.2 with `combine: true`; send only uses a single range.
fn parse_range(size: u64, spec: &str) -> RangeResult {
    let Some((_, specs)) = spec.split_once('=') else {
        return RangeResult::Ignore;
    };
    let size = i64::try_from(size).unwrap_or(i64::MAX);
    let mut ranges: Vec<(i64, i64)> = Vec::new();
    for part in specs.split(',') {
        let mut bounds = part.split('-');
        let start = bounds.next().and_then(parse_int);
        let end = bounds.next().and_then(parse_int);
        let (start, end) = match (start, end) {
            (None, Some(suffix)) => (size - suffix, size - 1),
            (Some(start), None) => (start, size - 1),
            (Some(start), Some(end)) => (start, end.min(size - 1)),
            (None, None) => continue,
        };
        if start > end || start < 0 {
            continue;
        }
        ranges.push((start, end));
    }
    if ranges.is_empty() {
        return RangeResult::Unsatisfiable;
    }
    ranges.sort_unstable();
    let mut combined: Vec<(i64, i64)> = Vec::new();
    for (start, end) in ranges {
        match combined.last_mut() {
            Some(last) if start <= last.1 + 1 => last.1 = last.1.max(end),
            _ => combined.push((start, end)),
        }
    }
    match combined.as_slice() {
        [(start, end)] => match (u64::try_from(*start), u64::try_from(*end)) {
            (Ok(s), Ok(e)) => RangeResult::One(s, e),
            _ => RangeResult::Ignore,
        },
        _ => RangeResult::Ignore,
    }
}

/// `mime-types` `contentType(extname(path))`.
fn content_type(file: &Path) -> &'static str {
    let ext = file
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.get(1..))
        .and_then(|n| n.rsplit_once('.'))
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" | "shtml" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "webmanifest" => "application/manifest+json; charset=utf-8",
        "txt" | "text" | "conf" | "log" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        "svg" | "svgz" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" | "jpe" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/vnd.microsoft.icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// Where the frontend lives, when it is served at all.
pub(super) fn root(app_root: &Path) -> Option<PathBuf> {
    super::production().then(|| super::public_path(app_root))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spa_route_excludes_backend_prefixes() {
        assert!(spa_route("/"), "root");
        assert!(spa_route("/discover/movies"), "a page");
        assert!(spa_route("/apis"), "/api only as a segment");
        assert!(spa_route("/assets"), "the folder itself");
        for path in [
            "/api",
            "/api/v1/x",
            "/api-docs",
            "/api-docsx",
            "/imageproxy/a",
            "/avatarproxy",
            "/assets/a.js",
        ] {
            assert!(!spa_route(path), "{path}");
        }
    }

    #[test]
    fn segments_like_send() {
        assert_eq!(
            safe_segments("/assets/a%20b.js"),
            Some(vec![String::from("assets"), String::from("a b.js")]),
            "decoded"
        );
        assert_eq!(safe_segments("/a/../b"), None, "traversal");
        assert_eq!(safe_segments("/a/%2e%2e/b"), None, "encoded traversal");
        assert_eq!(safe_segments("/.env"), None, "dotfile");
        assert_eq!(safe_segments("/%zz"), None, "malformed");
        assert_eq!(
            safe_segments("/a/./b"),
            Some(vec![String::from("a"), String::from("b")]),
            "dot segment"
        );
    }

    #[test]
    fn cache_headers_like_set_headers() {
        assert_eq!(
            cache_control_for(Path::new("/p/index.html")),
            Some("no-store"),
            "index"
        );
        assert_eq!(
            cache_control_for(Path::new("/p/assets/a.js")),
            Some("public, max-age=31536000, immutable"),
            "asset"
        );
        assert_eq!(
            cache_control_for(Path::new("/p/favicon.ico")),
            None,
            "default"
        );
    }

    #[test]
    fn ranges_like_range_parser() {
        assert_eq!(
            parse_range(100, "bytes=0-9"),
            RangeResult::One(0, 9),
            "head"
        );
        assert_eq!(
            parse_range(100, "bytes=-10"),
            RangeResult::One(90, 99),
            "suffix"
        );
        assert_eq!(
            parse_range(100, "bytes=90-"),
            RangeResult::One(90, 99),
            "open"
        );
        assert_eq!(
            parse_range(100, "bytes=0-500"),
            RangeResult::One(0, 99),
            "clamped"
        );
        assert_eq!(
            parse_range(100, "bytes=0-4,5-9"),
            RangeResult::One(0, 9),
            "combined"
        );
        assert_eq!(
            parse_range(100, "bytes=0-1,5-9"),
            RangeResult::Ignore,
            "several"
        );
        assert_eq!(
            parse_range(100, "bytes=200-300"),
            RangeResult::Unsatisfiable,
            "past the end"
        );
    }

    #[test]
    fn dates_like_javascript() {
        assert_eq!(
            utc_string(1_791_729_441_000),
            "Sun, 11 Oct 2026 14:37:21 GMT",
            "toUTCString"
        );
        assert_eq!(
            parse_http_date("Sun, 11 Oct 2026 14:37:21 GMT"),
            Some(1_791_729_441_000),
            "parse"
        );
        assert_eq!(parse_http_date("yesterday"), None, "NaN");
    }

    #[test]
    fn freshness_like_fresh() {
        let mut req = HeaderMap::new();
        let lm = "Sun, 11 Oct 2026 14:37:21 GMT";
        assert!(!fresh(&req, "W/\"1-2\"", lm), "unconditional");
        req.insert("if-none-match", HeaderValue::from_static("W/\"1-2\""));
        assert!(fresh(&req, "W/\"1-2\"", lm), "etag match");
        assert!(!fresh(&req, "W/\"1-3\"", lm), "etag mismatch");
        let mut req = HeaderMap::new();
        req.insert(
            "if-modified-since",
            HeaderValue::from_static("Sun, 11 Oct 2026 14:37:21 GMT"),
        );
        assert!(fresh(&req, "W/\"1-2\"", lm), "not modified since");
        assert!(
            !fresh(&req, "W/\"1-2\"", "Sun, 11 Oct 2026 14:37:22 GMT"),
            "modified"
        );
    }

    #[test]
    fn content_types_like_mime_types() {
        assert_eq!(
            content_type(Path::new("/p/a.JS")),
            "text/javascript; charset=utf-8",
            "js"
        );
        assert_eq!(
            content_type(Path::new("/p/site.webmanifest")),
            "application/manifest+json; charset=utf-8",
            "manifest"
        );
        assert_eq!(
            content_type(Path::new("/p/.png")),
            "application/octet-stream",
            "a dotfile has no extension"
        );
        assert_eq!(
            content_type(Path::new("/p/LICENSE")),
            "application/octet-stream",
            "none"
        );
    }
}
