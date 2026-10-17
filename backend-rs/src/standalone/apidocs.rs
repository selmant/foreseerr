//! `/api-docs`: `server.use('/api-docs', swaggerUi.serve,
//! swaggerUi.setup(apiDocs))` with swagger-ui-express 5.0.1.
//!
//! Below the mount (matched case-insensitively), for any method:
//!
//! 1. a URL path ending in `/package.json` is `res.sendStatus(404)`;
//!    one ending in `/swagger-ui-init.js` is the init script (the spec,
//!    `yaml.load`ed with js-yaml's default schema, as `JSON.stringify(...,
//!    2)` in swagger-ui-express's template), `application/javascript`;
//! 2. GET and HEAD go to `express.static(swagger-ui-dist, { index: false
//!    })`: the browser assets built into `dist/public/api-docs`
//!    (`FORESEERR_SWAGGER_UI_PATH` overrides it), the redirect of
//!    `/api-docs` to `/api-docs/`;
//! 3. everything else is the Swagger UI page, `res.send(html)`.
//!
//! The page doesn't depend on the spec: it is the one swagger-ui-express
//! generates for `setup(apiDocs)` with no options (`apidocs.html`).

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use axum::body::Body;
use axum::http::request::Parts;
use axum::http::{header, HeaderValue, Method, Response, StatusCode};
use serde_json::{Map, Value};

/// The page `setup()` generates.
const HTML: &str = include_str!("apidocs.html");
/// swagger-ui-express's `jsTplString`.
const INIT_TEMPLATE: &str = include_str!("apidocs-init.js.tpl");

/// The answer below `/api-docs`, or `None` outside it.
pub(super) async fn answer(app_root: &Path, parts: &Parts) -> Option<Response<Body>> {
    let path = parts.uri.path();
    let rest = below(path, "/api-docs")?;
    if rest.ends_with("/package.json") {
        return Some(send(
            parts,
            StatusCode::NOT_FOUND,
            "text/plain; charset=utf-8",
            Body::from("Not Found"),
            b"Not Found",
        ));
    }
    if rest.ends_with("/swagger-ui-init.js") {
        let script = init_script(app_root);
        return Some(send(
            parts,
            StatusCode::OK,
            "application/javascript; charset=utf-8",
            Body::from(script.as_bytes()),
            script.as_bytes(),
        ));
    }
    if parts.method == Method::GET || parts.method == Method::HEAD {
        let root = dist_root(app_root);
        // serve-static: the mount itself without a slash is the root
        // directory, which redirects.
        let pathname = if path.len() == "/api-docs".len() {
            ""
        } else {
            rest
        };
        if let Some(res) = super::statics::serve_path(&root, parts, pathname, |_| None).await {
            return Some(res);
        }
    }
    Some(send(
        parts,
        StatusCode::OK,
        "text/html; charset=utf-8",
        Body::from(HTML),
        HTML.as_bytes(),
    ))
}

/// Swagger's browser assets, packaged by Vite with the frontend.
/// `FORESEERR_SWAGGER_UI_PATH` overrides the packaged directory.
fn dist_root(app_root: &Path) -> PathBuf {
    if let Some(path) = std::env::var_os("FORESEERR_SWAGGER_UI_PATH").filter(|p| !p.is_empty()) {
        return PathBuf::from(path);
    }
    super::public_path(app_root).join("api-docs")
}

/// The part of `path` below a mount (`/` when nothing is left), when the
/// mount matches as Express matches it.
fn below<'a>(path: &'a str, mount: &str) -> Option<&'a str> {
    let head = path.get(..mount.len())?;
    let rest = path.get(mount.len()..)?;
    (head.eq_ignore_ascii_case(mount) && (rest.is_empty() || rest.starts_with('/')))
        .then_some(if rest.is_empty() { "/" } else { rest })
}

/// `res.send(body)` for a string with this `Content-Type`: a weak `ETag`,
/// a 304 for a fresh GET or HEAD.
fn send(
    parts: &Parts,
    status: StatusCode,
    content_type: &'static str,
    body: Body,
    bytes: &[u8],
) -> Response<Body> {
    let etag = crate::respond::weak_etag(bytes);
    let etag = HeaderValue::from_str(&etag).ok();
    let mut res = Response::new(Body::empty());
    let cacheable =
        (parts.method == Method::GET || parts.method == Method::HEAD) && status.is_success();
    let fresh = etag
        .as_ref()
        .and_then(|e| e.to_str().ok())
        .is_some_and(|e| crate::respond::fresh(&parts.headers, e));
    if cacheable && fresh {
        *res.status_mut() = StatusCode::NOT_MODIFIED;
        if let Some(etag) = etag {
            res.headers_mut().insert(header::ETAG, etag);
        }
        return res;
    }
    *res.status_mut() = status;
    let headers = res.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(bytes.len()));
    if let Some(etag) = etag {
        headers.insert(header::ETAG, etag);
    }
    *res.body_mut() = body;
    res
}

/// The init script, built once (`setup()` runs at startup).
fn init_script(app_root: &Path) -> &'static str {
    static SCRIPT: OnceLock<String> = OnceLock::new();
    SCRIPT.get_or_init(|| {
        let spec = std::fs::read_to_string(app_root.join("seerr-api.yml"))
            .map_err(anyhow::Error::from)
            .and_then(|text| crate::openapi::yaml::load_default(&text));
        let doc = spec.unwrap_or_else(|e| {
            tracing::error!("Swagger UI: reading seerr-api.yml: {e:#}");
            Value::Null
        });
        let mut options = Map::new();
        // `swaggerDoc: swaggerDoc || undefined`; the `undefined`s drop out.
        if !doc.is_null() {
            options.insert(String::from("swaggerDoc"), doc);
        }
        options.insert(String::from("customOptions"), Value::Object(Map::new()));
        let mut json = String::new();
        pretty(&Value::Object(options), 0, &mut json);
        js_replace(
            INIT_TEMPLATE,
            "<% swaggerOptions %>",
            &format!("var options = {json};"),
        )
    })
}

/// `JSON.stringify(value, null, 2)`.
fn pretty(value: &Value, depth: usize, out: &mut String) {
    let indent = |out: &mut String, depth: usize| {
        out.push('\n');
        out.extend(std::iter::repeat_n(' ', depth * 2));
    };
    match value {
        Value::Array(items) if !items.is_empty() => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                indent(out, depth + 1);
                pretty(item, depth + 1, out);
            }
            indent(out, depth);
            out.push(']');
        }
        Value::Object(map) if !map.is_empty() => {
            out.push('{');
            for (i, (key, item)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                indent(out, depth + 1);
                out.push_str(&Value::String(key.clone()).to_string());
                out.push_str(": ");
                pretty(item, depth + 1, out);
            }
            indent(out, depth);
            out.push('}');
        }
        Value::Array(_) => out.push_str("[]"),
        Value::Object(_) => out.push_str("{}"),
        Value::Number(n) if n.is_f64() => {
            out.push_str(&n.as_f64().map_or_else(
                || String::from("null"),
                |f| {
                    if f.is_finite() {
                        crate::jsval::number_string(f)
                    } else {
                        String::from("null")
                    }
                },
            ));
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {
            out.push_str(&value.to_string());
        }
    }
}

/// `text.replace(pattern, replacement)` with a string pattern: the first
/// match, and the replacement's `$$`, `$&`, `` $` `` and `$'` patterns.
fn js_replace(text: &str, pattern: &str, replacement: &str) -> String {
    let Some(at) = text.find(pattern) else {
        return text.to_owned();
    };
    let before = text.get(..at).unwrap_or_default();
    let after = text.get(at + pattern.len()..).unwrap_or_default();
    let mut expanded = String::with_capacity(replacement.len());
    let mut chars = replacement.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '$' {
            expanded.push(c);
            continue;
        }
        match chars.peek() {
            Some('$') => expanded.push('$'),
            Some('&') => expanded.push_str(pattern),
            Some('`') => expanded.push_str(before),
            Some('\'') => expanded.push_str(after),
            Some(_) | None => {
                expanded.push('$');
                continue;
            }
        }
        chars.next();
    }
    format!("{before}{expanded}{after}")
}

/// js-yaml's `timestamp` type: a plain scalar it reads as a `Date`, as
/// `toISOString()` prints it.
#[must_use]
pub fn yaml_timestamp(text: &str) -> Option<String> {
    static DATE: OnceLock<Option<regex::Regex>> = OnceLock::new();
    static STAMP: OnceLock<Option<regex::Regex>> = OnceLock::new();
    let date = DATE
        .get_or_init(|| regex::Regex::new(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})$").ok())
        .as_ref()?;
    let stamp = STAMP
        .get_or_init(|| {
            regex::Regex::new(
                r"^([0-9]{4})-([0-9][0-9]?)-([0-9][0-9]?)(?:[Tt]|[ \t]+)([0-9][0-9]?):([0-9]{2}):([0-9]{2})(?:\.([0-9]*))?(?:[ \t]*(Z|([-+])([0-9][0-9]?)(?::([0-9]{2}))?))?$",
            )
            .ok()
        })
        .as_ref()?;
    let num = |c: &regex::Captures<'_>, i: usize| -> i64 {
        c.get(i).and_then(|m| m.as_str().parse().ok()).unwrap_or(0)
    };
    let (y, mo, d, h, mi, s, ms, delta_min) = if let Some(c) = date.captures(text) {
        (num(&c, 1), num(&c, 2), num(&c, 3), 0, 0, 0, 0, 0)
    } else {
        let c = stamp.captures(text)?;
        let mut fraction: String = c
            .get(7)
            .map_or("", |m| m.as_str())
            .chars()
            .take(3)
            .collect();
        while fraction.len() < 3 {
            fraction.push('0');
        }
        let delta = if c.get(9).is_some() {
            let minutes = num(&c, 10) * 60 + num(&c, 11);
            if c.get(9).map(|m| m.as_str()) == Some("-") {
                -minutes
            } else {
                minutes
            }
        } else {
            0
        };
        (
            num(&c, 1),
            num(&c, 2),
            num(&c, 3),
            num(&c, 4),
            num(&c, 5),
            num(&c, 6),
            fraction.parse().unwrap_or(0),
            delta,
        )
    };
    // `Date.UTC(year, month - 1, day, ...)` rolls over out-of-range parts.
    let first = chrono::NaiveDate::from_ymd_opt(i32::try_from(y).ok()?, 1, 1)?;
    let base = first
        .checked_add_months(chrono::Months::new(u32::try_from(mo - 1).ok()?))?
        .and_hms_opt(0, 0, 0)?
        .and_utc();
    let ms_total = ((((d - 1) * 24 + h) * 60 + mi) * 60 + s) * 1000 + ms - delta_min * 60_000;
    let at = base.checked_add_signed(chrono::TimeDelta::try_milliseconds(ms_total)?)?;
    Some(crate::clock::Utc::from_unix_millis(at.timestamp_millis()).iso_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps() {
        assert_eq!(
            yaml_timestamp("2020-01-01").as_deref(),
            Some("2020-01-01T00:00:00.000Z"),
            "date"
        );
        assert_eq!(
            yaml_timestamp("2024-04-21T01:55:44.000Z").as_deref(),
            Some("2024-04-21T01:55:44.000Z"),
            "stamp"
        );
        assert_eq!(
            yaml_timestamp("2001-12-14 21:59:43.10 -5").as_deref(),
            Some("2001-12-15T02:59:43.100Z"),
            "offset"
        );
        assert_eq!(yaml_timestamp("2020-1-1"), None, "not a date alone");
        assert_eq!(yaml_timestamp("hello"), None, "text");
    }

    #[test]
    fn stringify_and_replace() {
        let mut out = String::new();
        pretty(
            &serde_json::json!({"a": [1, 1.5, {}], "b": {"c": null}, "d": []}),
            0,
            &mut out,
        );
        assert_eq!(
            out,
            "{\n  \"a\": [\n    1,\n    1.5,\n    {}\n  ],\n  \"b\": {\n    \"c\": null\n  },\n  \"d\": []\n}",
            "JSON.stringify(v, null, 2)"
        );
        assert_eq!(
            js_replace("a<x>b", "<x>", "[$&|$`|$'|$$|$1]"),
            "a[<x>|a|b|$|$1]b",
            "patterns"
        );
    }

    #[test]
    fn mount() {
        assert_eq!(below("/api-docs", "/api-docs"), Some("/"), "bare");
        assert_eq!(below("/API-DOCS/x", "/api-docs"), Some("/x"), "case");
        assert_eq!(below("/api-docsx", "/api-docs"), None, "longer");
    }
}
