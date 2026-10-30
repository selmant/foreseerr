//! `/imageproxy/:type/*path` and `/avatarproxy/:jellyfinUserId`.
//!
//! `server/routes/imageproxy.ts` and `server/routes/avatarproxy.ts`, which
//! Node mounts outside `/api` behind `clearCookies`: no session, no
//! `OpenAPI` validator, no cookies on the answer.
//!
//! Paths Express would decode (`%`), normalise (`.`/`..`, empty segments,
//! a trailing slash) or route elsewhere get the fallback answer, as do
//! methods other than `GET` and `HEAD`.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderMap, HeaderValue, Response, StatusCode};
use axum::routing::get;
use axum::Router;
use serde_json::{Map, Value};

use super::Shared;
use crate::imagecache::{self, Image, Proxy};
use crate::jsnum;
use crate::state::AppState;

/// Register both mounts on the router.
pub(super) fn routes(router: Router<Shared>) -> Router<Shared> {
    router
        .route(
            "/imageproxy/{*path}",
            // HEAD runs the GET route, as in Express.
            get(imageproxy).fallback(super::forward),
        )
        .route(
            "/avatarproxy/{*path}",
            get(avatarproxy).fallback(super::forward),
        )
}

/// What a handler decided: an answer, or the fallback's.
type Decided = Result<Response<Body>, super::Fallback>;

async fn imageproxy(State(state): State<Shared>, req: Request) -> Response<Body> {
    let (parts, _) = req.into_parts();
    finish(&parts, image(&state, &parts).await)
}

async fn avatarproxy(State(state): State<Shared>, req: Request) -> Response<Body> {
    let (parts, _) = req.into_parts();
    finish(&parts, avatar(&state, &parts).await)
}

fn finish(parts: &Parts, decided: Decided) -> Response<Body> {
    match decided {
        Ok(response) => response,
        Err(fallback) => fallback.respond(parts),
    }
}

/// A path segment Express passes through as it is: no percent-decoding,
/// no dot segments, nothing the URL parser would re-encode.
fn plain_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && segment.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(
                    b,
                    b'-' | b'.'
                        | b'_'
                        | b'~'
                        | b'!'
                        | b'$'
                        | b'&'
                        | b'\''
                        | b'('
                        | b')'
                        | b'*'
                        | b'+'
                        | b','
                        | b';'
                        | b'='
                        | b':'
                        | b'@'
                )
        })
}

/// A query the URL parsers on both sides leave as it is.
fn plain_query(query: &str) -> bool {
    query.bytes().all(|b| {
        b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'-' | b'.'
                    | b'_'
                    | b'~'
                    | b'!'
                    | b'$'
                    | b'&'
                    | b'\''
                    | b'('
                    | b')'
                    | b'*'
                    | b'+'
                    | b','
                    | b';'
                    | b'='
                    | b':'
                    | b'@'
                    | b'/'
                    | b'?'
                    | b'%'
            )
    })
}

/// The segments after a mount, when Express would read them as they are.
fn segments<'a>(parts: &'a Parts, mount: &str) -> Result<Vec<&'a str>, super::Fallback> {
    let rest = parts
        .uri
        .path()
        .strip_prefix(mount)
        .ok_or_else(|| super::Fallback::from("a path outside the mount"))?;
    plain_segments(rest).ok_or_else(|| super::Fallback::from("a path with encoded or dot segments"))
}

/// `rest` split as Express splits a wildcard: an empty segment inside the
/// path (`w1920_and_h800_multi_faces//x.jpg`, as the frontend builds every
/// backdrop URL) is kept, one at either end is not judged here.
fn plain_segments(rest: &str) -> Option<Vec<&str>> {
    let segments: Vec<&str> = rest.split('/').collect();
    let last = segments.len().saturating_sub(1);
    segments
        .iter()
        .enumerate()
        .all(|(i, s)| plain_segment(s) || (s.is_empty() && i != 0 && i != last))
        .then_some(segments)
}

/// `next({ status, message })` through Node's error handler.
fn error(parts: &Parts, status: u16, message: &str) -> Response<Body> {
    let mut body = Map::new();
    body.insert(String::from("message"), Value::from(message));
    crate::respond::json_status(status, &parts.method, &parts.headers, &Value::Object(body))
}

/// The request header as Node's `req.headers[name]` joins it.
fn request_header(headers: &HeaderMap, name: header::HeaderName) -> Option<String> {
    let values: Vec<String> = headers
        .get_all(name)
        .iter()
        .map(|v| v.as_bytes().iter().map(|b| char::from(*b)).collect())
        .collect();
    if values.is_empty() {
        None
    } else {
        Some(values.join(", "))
    }
}

/// `HOSTS` of `imageproxySources.ts`: host, source, origin.
const HOSTS: [(&str, &str, &str); 6] = [
    ("image.tmdb.org", "tmdb", "https://image.tmdb.org"),
    (
        "artworks.thetvdb.com",
        "tvdb",
        "https://artworks.thetvdb.com",
    ),
    ("s4.anilist.co", "anilist", "https://s4.anilist.co"),
    ("img.anilist.co", "anilist", "https://img.anilist.co"),
    ("simkl.in", "simkl", "https://simkl.in"),
    ("www.simkl.in", "simkl", "https://www.simkl.in"),
];

/// Where `resolveImageProxyFetch` sends a request, or the error status.
#[derive(Debug, PartialEq, Eq)]
enum Resolved {
    /// The cache instance and the path or URL it fetches.
    Fetch(Proxy, String),
    /// `unsupported`: 400.
    Unsupported,
    /// `invalid`: 403.
    Invalid,
}

const fn source_proxy(key: &'static str, base_url: &'static str) -> Proxy {
    Proxy {
        key,
        base_url,
        follow_redirects: false,
        rate_limited: true,
    }
}

/// `resolveImageProxyFetch` plus `requestPathForFetch`, for a path made of
/// plain segments and a search that is empty or starts with `?`.
fn resolve(source: &str, path_segments: &[&str], search: &str) -> Resolved {
    let image_path = format!("/{}", path_segments.join("/"));
    match source {
        "tmdb" => Resolved::Fetch(
            source_proxy("tmdb", "https://image.tmdb.org"),
            format!("{image_path}{search}"),
        ),
        "tvdb" => Resolved::Fetch(
            source_proxy("tvdb", "https://artworks.thetvdb.com"),
            format!("{image_path}{search}"),
        ),
        "anilist" | "simkl" => {
            let Some((host, rest)) = path_segments.split_first() else {
                return Resolved::Invalid;
            };
            let Some((_, mapped, origin)) = HOSTS.iter().find(|(h, _, _)| h == host) else {
                return Resolved::Invalid;
            };
            if *mapped != source || rest.is_empty() {
                return Resolved::Invalid;
            }
            let key = if source == "anilist" {
                "anilist"
            } else {
                "simkl"
            };
            Resolved::Fetch(
                source_proxy(key, ""),
                format!("{origin}/{}{search}", rest.join("/")),
            )
        }
        _ => Resolved::Unsupported,
    }
}

fn header_value(text: &str) -> Result<HeaderValue, String> {
    HeaderValue::from_str(text).map_err(|_| format!("an unsupported header value: {text}"))
}

const fn cache_status(image: &Image) -> HeaderValue {
    HeaderValue::from_static(if image.meta.cache_miss { "MISS" } else { "HIT" })
}

/// `GET /imageproxy/:type/*path`.
async fn image(state: &Arc<AppState>, parts: &Parts) -> Decided {
    let segs = segments(parts, "/imageproxy/")?;
    let Some((source, path_segments)) = segs.split_first() else {
        return Err("no image type".into());
    };
    if path_segments.is_empty() {
        return Err(super::Fallback::status(404, "No image path."));
    }
    let search = match parts.uri.query() {
        None => String::new(),
        Some(q) if !q.is_empty() && plain_query(q) => format!("?{q}"),
        Some(_) => return Err("an unsupported query string".into()),
    };
    let image_path = format!("/{}", path_segments.join("/"));
    if image_path.starts_with("//") || image_path.contains("://") {
        tracing::error!("Invalid URL for image proxy: {image_path}");
        return Ok(error(parts, 403, "Invalid URL for image proxy."));
    }
    let (proxy, fetch) = match resolve(source, path_segments, &search) {
        Resolved::Fetch(proxy, fetch) => (proxy, fetch),
        Resolved::Unsupported => {
            tracing::error!("Unsupported image type: {image_path} ({source})");
            return Ok(error(parts, 400, "Unsupported image type."));
        }
        Resolved::Invalid => {
            tracing::error!("Invalid URL for image proxy: {image_path}");
            return Ok(error(parts, 403, "Invalid URL for image proxy."));
        }
    };
    let image = match imagecache::get_image(state, proxy, &fetch, None).await {
        Ok(image) => image,
        Err(e) => {
            tracing::error!("Failed to proxy image {image_path}: {e:#}");
            return Ok(error(parts, 500, "Failed to proxy image."));
        }
    };
    // The fetch may have written the disk cache: answered here from now on.
    Ok(image_response(parts, &image).unwrap_or_else(|why| {
        tracing::error!("Failed to proxy image {image_path}: {why}");
        error(parts, 500, "Failed to proxy image.")
    }))
}

/// The image route's answer for a fetched image; `Err` for a header value
/// HTTP can't carry.
fn image_response(parts: &Parts, image: &Image) -> Result<Response<Body>, String> {
    let revalidate = if image.meta.cur_revalidate.is_nan() {
        0.0
    } else {
        image.meta.cur_revalidate
    };
    let max_age = revalidate.max(86_400.0);
    let etag = match image.meta.etag.as_deref() {
        Some(tag) if !tag.is_empty() => format!("\"{tag}\""),
        Some(_) | None => format!("\"{}\"", image.meta.cache_key),
    };
    let cache_control = format!("public, max-age={}, immutable", jsnum::to_string(max_age));
    let etag_value = header_value(&etag)?;
    let cache_control_value = header_value(&cache_control)?;
    let key_value = header_value(&image.meta.cache_key)?;
    if request_header(&parts.headers, header::IF_NONE_MATCH).as_deref() == Some(etag.as_str()) {
        let mut res = Response::new(Body::empty());
        *res.status_mut() = StatusCode::NOT_MODIFIED;
        let headers = res.headers_mut();
        headers.insert(header::ETAG, etag_value);
        headers.insert(header::CACHE_CONTROL, cache_control_value);
        headers.insert("os-cache-key", key_value);
        headers.insert("os-cache-status", cache_status(image));
        return Ok(res);
    }
    let content_type = header_value(&format!(
        "image/{}",
        imagecache::part_text(image.meta.extension.as_deref())
    ))?;
    let mut res = Response::new(Body::from(image.bytes.clone()));
    let headers = res.headers_mut();
    headers.insert(header::CONTENT_TYPE, content_type);
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(image.bytes.len()));
    headers.insert(header::CACHE_CONTROL, cache_control_value);
    headers.insert(header::ETAG, etag_value);
    headers.insert("os-cache-key", key_value);
    headers.insert("os-cache-status", cache_status(image));
    Ok(res)
}

/// Whether `req.query.v` is truthy under Express 5's `querystring`
/// parser; `None` when the query needs decoding.
fn version_param(query: Option<&str>) -> Option<bool> {
    let Some(query) = query else {
        return Some(false);
    };
    if query.contains(['%', '+']) {
        return None;
    }
    let values: Vec<&str> = query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (key == "v").then_some(value)
        })
        .collect();
    Some(match values.as_slice() {
        [] => false,
        [one] => !one.is_empty(),
        _ => true,
    })
}

fn is_jellyfin_user_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| matches!(b, b'a'..=b'f' | b'0'..=b'9'))
}

/// `getJellyfinAvatarUrl`.
fn jellyfin_avatar_url(settings: &crate::settings::Settings, user_id: &str) -> String {
    let host = crate::jellyfin::hostname(settings);
    if jellyfin_server(settings) {
        format!("{host}/UserImage?UserId={user_id}")
    } else {
        format!("{host}/Users/{user_id}/Images/Primary?quality=90")
    }
}

/// `settings.main.mediaServerType === MediaServerType.JELLYFIN`.
fn jellyfin_server(settings: &crate::settings::Settings) -> bool {
    settings
        .get("/main/mediaServerType")
        .and_then(Value::as_f64)
        .is_some_and(|t| (t - 2.0).abs() < f64::EPSILON)
}

/// `GET /avatarproxy/:jellyfinUserId`.
async fn avatar(state: &Arc<AppState>, parts: &Parts) -> Decided {
    let segs = segments(parts, "/avatarproxy/")?;
    let [id] = segs.as_slice() else {
        return Err(super::Fallback::status(404, "Not one path segment."));
    };
    let settings =
        state.settings.current().await.map_err(|e| {
            super::Fallback::status(500, format!("settings.json is unreadable: {e:#}"))
        })?;
    if !is_jellyfin_user_id(id) {
        let server = if jellyfin_server(&settings) {
            "a Jellyfin"
        } else {
            "an Emby"
        };
        return Ok(error(
            parts,
            400,
            &format!("Provided URL is not {server} avatar."),
        ));
    }
    let version_param = version_param(parts.uri.query())
        .ok_or_else(|| super::Fallback::from("an unsupported query string"))?;
    let user = state
        .db
        .rows(
            r#"SELECT "email", "avatarVersion" FROM "user" WHERE "jellyfinUserId" = ?1 LIMIT 1"#,
            &[crate::db::Bind::Text((*id).to_owned())],
        )
        .await
        .map_err(|e| format!("looking up the user failed: {e:#}"))?;
    let user = user.first();
    let text = |name: &str| {
        user.and_then(|u| u.get(name))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    };
    let fallback = crate::typeorm::gravatar_url(text("email").unwrap_or("none"));
    let avatar_url = jellyfin_avatar_url(&settings, id);
    let proxy = imagecache::AVATAR;
    let loaded = if text("avatarVersion").is_some() {
        match imagecache::get_image(state, proxy, &avatar_url, Some(&fallback)).await {
            Ok(image) if image.meta.extension.as_deref() == Some("json") => {
                imagecache::get_image(state, proxy, &fallback, None).await
            }
            other => other,
        }
    } else {
        imagecache::get_image(state, proxy, &fallback, None).await
    };
    let image = match loaded {
        Ok(image) => image,
        Err(e) => {
            tracing::error!("Failed to proxy avatar image: {e:#}");
            return Ok(error(parts, 500, "Failed to proxy avatar image."));
        }
    };
    // The fetch may have written the disk cache: answered here from now on.
    Ok(
        avatar_response(parts, &image, version_param).unwrap_or_else(|why| {
            tracing::error!("Failed to proxy avatar image: {why}");
            error(parts, 500, "Failed to proxy avatar image.")
        }),
    )
}

/// The avatar route's answer for a fetched image; `Err` for a header
/// value HTTP can't carry.
fn avatar_response(
    parts: &Parts,
    image: &Image,
    version_param: bool,
) -> Result<Response<Body>, String> {
    let etag = format!("\"{}\"", imagecache::part_text(image.meta.etag.as_deref()));
    let if_none_match = request_header(&parts.headers, header::IF_NONE_MATCH);
    if if_none_match.is_some_and(|tag| !tag.is_empty() && tag == etag) && !version_param {
        let mut res = Response::new(Body::empty());
        *res.status_mut() = StatusCode::NOT_MODIFIED;
        return Ok(res);
    }
    let content_type = header_value(&format!(
        "image/{}",
        imagecache::part_text(image.meta.extension.as_deref())
    ))?;
    let cache_control = header_value(&format!(
        "public, max-age={}",
        jsnum::to_string(image.meta.cur_revalidate)
    ))?;
    let etag_value = header_value(&etag)?;
    let key_value = header_value(&image.meta.cache_key)?;
    let mut res = Response::new(Body::from(image.bytes.clone()));
    let headers = res.headers_mut();
    headers.insert(header::CONTENT_TYPE, content_type);
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(image.bytes.len()));
    headers.insert(header::CACHE_CONTROL, cache_control);
    headers.insert(header::ETAG, etag_value);
    headers.insert("os-cache-key", key_value);
    headers.insert("os-cache-status", cache_status(image));
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_like_node() {
        assert_eq!(
            resolve("tmdb", &["t", "p", "w500", "a.jpg"], "?x=1"),
            Resolved::Fetch(
                source_proxy("tmdb", "https://image.tmdb.org"),
                String::from("/t/p/w500/a.jpg?x=1")
            ),
            "tmdb keeps the path"
        );
        assert_eq!(
            resolve("anilist", &["s4.anilist.co", "file", "a.png"], ""),
            Resolved::Fetch(
                source_proxy("anilist", ""),
                String::from("https://s4.anilist.co/file/a.png")
            ),
            "anilist names its host"
        );
        assert_eq!(
            resolve("simkl", &["s4.anilist.co", "a.png"], ""),
            Resolved::Invalid,
            "a host of another source"
        );
        assert_eq!(
            resolve("simkl", &["simkl.in"], ""),
            Resolved::Invalid,
            "a host and nothing else"
        );
        assert_eq!(
            resolve("anilist", &["evil.example", "a.png"], ""),
            Resolved::Invalid,
            "an unknown host"
        );
        assert_eq!(
            resolve("plex", &["a.png"], ""),
            Resolved::Unsupported,
            "an unknown type"
        );
    }

    #[test]
    fn segments_and_queries() {
        assert!(plain_segment("w500"), "plain");
        assert!(!plain_segment(""), "empty");
        assert!(!plain_segment(".."), "dot segment");
        assert!(!plain_segment("a%2Fb"), "encoded");
        assert!(!plain_segment("a b"), "space");
        assert_eq!(
            plain_segments("tmdb/t/p/w1920_and_h800_multi_faces//x.jpg"),
            Some(vec![
                "tmdb",
                "t",
                "p",
                "w1920_and_h800_multi_faces",
                "",
                "x.jpg"
            ]),
            "an empty segment inside, as backdrop URLs have"
        );
        assert_eq!(plain_segments("/tmdb/x.jpg"), None, "empty first");
        assert_eq!(plain_segments("tmdb/x.jpg/"), None, "empty last");
        assert_eq!(plain_segments("tmdb/a%2Fb.jpg"), None, "encoded");
        assert!(plain_query("a=1&b=%20"), "query");
        assert!(!plain_query("a=\"x\""), "quote");
    }

    #[test]
    fn version_params() {
        assert_eq!(version_param(None), Some(false), "none");
        assert_eq!(version_param(Some("v=123")), Some(true), "set");
        assert_eq!(version_param(Some("v=")), Some(false), "empty");
        assert_eq!(version_param(Some("v")), Some(false), "bare");
        assert_eq!(version_param(Some("v=&v=")), Some(true), "an array");
        assert_eq!(version_param(Some("w=1")), Some(false), "other key");
        assert_eq!(version_param(Some("v=%31")), None, "encoded");
    }

    #[test]
    fn jellyfin_ids() {
        assert!(
            is_jellyfin_user_id("0123456789abcdef0123456789abcdef"),
            "hex"
        );
        assert!(
            !is_jellyfin_user_id("0123456789ABCDEF0123456789abcdef"),
            "upper case"
        );
        assert!(!is_jellyfin_user_id("abc"), "short");
    }
}
