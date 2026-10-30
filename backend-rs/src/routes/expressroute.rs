//! Express 5's route matching for the native routes.
//!
//! The router (`router` 2.x on path-to-regexp 8) matches every layer
//! case-insensitively with an optional trailing slash, and hands the
//! handlers parameters decoded with `decodeURIComponent`. axum matches
//! exact paths only, so before routing a request is matched here against
//! every registered path and its URI rewritten to the registered spelling:
//! literal segments as registered, no trailing slash, and each parameter
//! decoded and re-encoded only where a URI path needs it (`%`, `/`, `?`,
//! `#`, spaces, quotes, non-ASCII…). Handlers that read raw segments see
//! what Express gives `req.params`, and those that decode get it back
//! unchanged.
//!
//! The request as it came stays in the extensions ([`Original`]): Node
//! gets that one when a handler forwards, and handlers that read
//! `req.originalUrl` or a router's `req.path` use it.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::request::Parts;
use axum::http::Uri;

/// The URI a request arrived with, when matching rewrote it.
#[derive(Debug, Clone)]
pub(super) struct Original(pub(super) Uri);

/// One segment of a registered path.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Segment {
    Literal(&'static str),
    Param,
}

/// The registered paths Node serves with a `'/'` route inside a mounted
/// router, and the methods of those routes. The mount takes the path up to
/// its own optional trailing slash, and the `'/'` route takes one more, so
/// these also answer with two trailing slashes (`/api/v1/user//`).
const MOUNT_ROOTS: &[(&str, &[&str])] = &[
    ("/api/v1/blocklist", &["GET", "POST"]),
    ("/api/v1/calendar", &["GET"]),
    ("/api/v1/discover/watchlist", &["GET"]),
    ("/api/v1/issue", &["GET", "POST"]),
    ("/api/v1/media", &["GET"]),
    ("/api/v1/overrideRule", &["GET", "POST"]),
    ("/api/v1/request", &["GET", "POST"]),
    ("/api/v1/search", &["GET"]),
    ("/api/v1/servarr/interventions", &["GET"]),
    ("/api/v1/settings/discover", &["POST"]),
    ("/api/v1/settings/metadatas", &["GET", "PUT"]),
    ("/api/v1/settings/radarr", &["GET", "POST"]),
    ("/api/v1/settings/sonarr", &["GET", "POST"]),
    ("/api/v1/user", &["GET", "POST", "PUT"]),
    ("/api/v1/watchlist", &["POST"]),
];

/// Every registered path, split into segments.
#[derive(Debug, Default)]
pub(super) struct Paths {
    names: Vec<&'static str>,
    templates: Vec<Vec<Segment>>,
}

impl Paths {
    /// The registered paths (`/api/v1/user/{id}`).
    pub(super) fn new<'a>(paths: impl IntoIterator<Item = &'a &'static str>) -> Self {
        let names: Vec<&'static str> = paths.into_iter().copied().collect();
        let templates = names
            .iter()
            .map(|path| {
                path.trim_start_matches('/')
                    .split('/')
                    .map(|seg| {
                        if seg.starts_with('{') && seg.ends_with('}') {
                            Segment::Param
                        } else {
                            Segment::Literal(seg)
                        }
                    })
                    .collect()
            })
            .collect();
        Self { names, templates }
    }

    /// The registered spelling of `path` for `method`, or `None` when no
    /// registered path matches it (or it already is that spelling).
    fn canonical(&self, path: &str, method: &str) -> Option<String> {
        let doubled = path.len() > 2 && path.ends_with("//");
        let trimmed = if doubled {
            path.get(..path.len() - 2)?
        } else if path.len() > 1 {
            path.strip_suffix('/').unwrap_or(path)
        } else {
            path
        };
        let segments: Vec<&str> = trimmed.strip_prefix('/')?.split('/').collect();
        let chosen = self.select(&segments, false)?;
        if doubled {
            let name = self.names.get(chosen)?;
            let root = MOUNT_ROOTS
                .iter()
                .any(|(root, methods)| root == name && methods.contains(&method));
            if !root {
                return None;
            }
        }
        let template = self.templates.get(chosen)?;
        let mut parts = Vec::with_capacity(segments.len());
        for (want, got) in template.iter().zip(&segments) {
            match want {
                Segment::Literal(literal) => parts.push((*literal).to_owned()),
                Segment::Param => {
                    parts.push(encode_param(&crate::jsval::decode_uri_component(got)?));
                }
            }
        }
        let decoded: Vec<&str> = parts.iter().map(String::as_str).collect();
        // A decoded parameter that spells a sibling's literal would route
        // there; keep such parameters as they came.
        let canonical = if self.select(&decoded, true) == Some(chosen) {
            parts
        } else {
            template
                .iter()
                .zip(&segments)
                .map(|(want, got)| match want {
                    Segment::Literal(literal) => (*literal).to_owned(),
                    Segment::Param => (*got).to_owned(),
                })
                .collect()
        };
        let out = format!("/{}", canonical.join("/"));
        (out != path).then_some(out)
    }

    /// The registered path axum would pick for `segments` (literal
    /// segments before parameters, left to right); literals compare
    /// case-insensitively unless `exact`.
    fn select(&self, segments: &[&str], exact: bool) -> Option<usize> {
        let mut best: Option<usize> = None;
        for (i, template) in self.templates.iter().enumerate() {
            let fits = template.len() == segments.len()
                && template.iter().zip(segments).all(|(want, got)| match want {
                    Segment::Literal(literal) if exact => literal == got,
                    Segment::Literal(literal) => literal.eq_ignore_ascii_case(got),
                    Segment::Param => !got.is_empty(),
                });
            if !fits {
                continue;
            }
            best = match best.and_then(|b| self.templates.get(b).map(|t| (b, t))) {
                Some((b, current)) if !more_specific(template, current) => Some(b),
                _ => Some(i),
            };
        }
        best
    }
}

/// `a` has a literal where `b` has a parameter at the first place they
/// differ in kind.
fn more_specific(a: &[Segment], b: &[Segment]) -> bool {
    for (x, y) in a.iter().zip(b) {
        match (x, y) {
            (Segment::Literal(_), Segment::Param) => return true,
            (Segment::Param, Segment::Literal(_)) => return false,
            _ => {}
        }
    }
    false
}

/// A decoded parameter written back into a path: characters a path
/// segment can't hold as they are, or that mean something there, are
/// percent-encoded (UTF-8, upper-case hex).
fn encode_param(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
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
            );
        if keep {
            out.push(char::from(byte));
        } else {
            out.push('%');
            out.push(hex(byte >> 4));
            out.push(hex(byte & 0x0f));
        }
    }
    out
}

fn hex(nibble: u8) -> char {
    char::from_digit(u32::from(nibble), 16).map_or('0', |c| c.to_ascii_uppercase())
}

/// The middleware: rewrite the URI of a request a registered path
/// matches the way Express would match it.
pub(super) async fn rewrite(State(paths): State<Arc<Paths>>, mut req: Request) -> Request {
    let Some(canonical) = paths.canonical(req.uri().path(), req.method().as_str()) else {
        return req;
    };
    let target = match req.uri().query() {
        Some(query) => format!("{canonical}?{query}"),
        None => canonical,
    };
    let Ok(uri) = target.parse::<Uri>() else {
        return req;
    };
    let original = std::mem::replace(req.uri_mut(), uri);
    req.extensions_mut().insert(Original(original));
    req
}

/// Put back the URI the request arrived with (before it goes to Node).
pub(super) fn restore(parts: &mut Parts) {
    if let Some(Original(uri)) = parts.extensions.remove::<Original>() {
        parts.uri = uri;
    }
}

/// `req.originalUrl`'s path: the path the request arrived with.
pub(super) fn original_path(parts: &Parts) -> &str {
    parts
        .extensions
        .get::<Original>()
        .map_or_else(|| parts.uri.path(), |Original(uri)| uri.path())
}

/// `req.path` inside a router mounted at `mount` (a registered prefix
/// such as `/api/v1/discover/anilist`): what is left of the path as it
/// arrived once the mount's segments are taken off.
pub(super) fn path_below(parts: &Parts, mount: &str) -> String {
    let depth = mount.trim_matches('/').split('/').count();
    let path = original_path(parts);
    let rest: Vec<&str> = path.split('/').skip(depth + 1).collect();
    format!("/{}", rest.join("/"))
}

#[cfg(test)]
mod tests {
    use super::{encode_param, Paths};

    fn paths() -> Paths {
        Paths::new(&[
            "/api/v1/status",
            "/api/v1/user",
            "/api/v1/user/{id}",
            "/api/v1/user/{id}/settings/main",
            "/api/v1/request/count",
            "/api/v1/request/{id}",
        ])
    }

    #[test]
    fn matches_like_express() {
        let p = paths();
        assert_eq!(
            p.canonical("/api/v1/status", "GET"),
            None,
            "already canonical"
        );
        assert_eq!(
            p.canonical("/API/V1/STATUS", "GET").as_deref(),
            Some("/api/v1/status"),
            "case-insensitive"
        );
        assert_eq!(
            p.canonical("/api/v1/user/", "GET").as_deref(),
            Some("/api/v1/user"),
            "one trailing slash"
        );
        assert_eq!(
            p.canonical("/API/V1/USER//", "GET").as_deref(),
            Some("/api/v1/user"),
            "a mount root takes two trailing slashes"
        );
        assert_eq!(
            p.canonical("/api/v1/user//", "DELETE"),
            None,
            "for its own methods only"
        );
        assert_eq!(
            p.canonical("/api/v1/status//", "GET"),
            None,
            "two trailing slashes elsewhere"
        );
        assert_eq!(
            p.canonical("/api/v1/USER/1/Settings/MAIN/", "GET")
                .as_deref(),
            Some("/api/v1/user/1/settings/main"),
            "params keep their case"
        );
        assert_eq!(
            p.canonical("/api/v1/user/%31", "GET").as_deref(),
            Some("/api/v1/user/1"),
            "params are decoded"
        );
        assert_eq!(
            p.canonical("/api/v1/user/a%2Fb", "GET"),
            None,
            "a decoded slash stays encoded"
        );
        assert_eq!(
            p.canonical("/api/v1/user/a%2fb%41", "GET").as_deref(),
            Some("/api/v1/user/a%2FbA"),
            "re-encoded"
        );
        assert_eq!(
            p.canonical("/api/v1/request/COUNT", "GET").as_deref(),
            Some("/api/v1/request/count"),
            "literals win"
        );
        assert_eq!(
            p.canonical("/api/v1/request/%63ount", "GET"),
            None,
            "an encoded literal stays a parameter"
        );
        assert_eq!(
            p.canonical("/api/v1/user/%E0%A4%A", "GET"),
            None,
            "undecodable"
        );
        assert_eq!(p.canonical("/api/v1/nope", "GET"), None, "no route");
    }

    #[test]
    fn encodes_params() {
        assert_eq!(encode_param("a b%/é"), "a%20b%25%2F%C3%A9", "encoded");
        assert_eq!(encode_param("abc-1.2_~+:@"), "abc-1.2_~+:@", "kept");
    }
}
