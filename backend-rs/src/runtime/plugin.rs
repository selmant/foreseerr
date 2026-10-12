//! The Jellyfin plugin's side of the sidecar.
//!
//! - `loadJellyfinHostBootstrap()`: the plugin writes
//!   `<CONFIG_DIRECTORY>/jellyfin-host.json` before each start; its values
//!   are merged into settings.json once the settings are loaded
//!   (`applyJellyfinHostFile`), and settings.json is saved.
//! - `pluginIndexHtml()`: in production the SPA's `index.html` gets a
//!   `<base>` for the public base path (`FORESEERR_PUBLIC_BASE_PATH`, else
//!   the mount) and loses its manifest link; it is served for every page
//!   route without a file extension (or ending in `.html`), with
//!   `Cache-Control: no-store`.

use std::path::Path;
use std::sync::OnceLock;

use anyhow::{bail, Context, Result};
use axum::body::Body;
use axum::http::request::Parts;
use axum::http::{header, HeaderValue, Method, Response, StatusCode};
use serde_json::{Map, Value};

use crate::settings::public::truthy;

/// `JELLYFIN` of `MediaServerType`.
const JELLYFIN: i64 = 2;

/// `loadJellyfinHostBootstrap()` on the document `Settings.load()` left.
///
/// # Errors
///
/// A host file Node would trip over, or settings.json can't be written.
pub async fn bootstrap(settings_path: &Path, config_dir: &Path, mut data: Value) -> Result<()> {
    if !(super::active() && super::plugin_mode()) {
        return Ok(());
    }
    let host_path = config_dir.join("jellyfin-host.json");
    let Some(host) = read_host_file(&host_path).await else {
        tracing::warn!(
            label = "Plugin",
            path = %host_path.display(),
            "Plugin mode is on but jellyfin-host.json was not found"
        );
        return Ok(());
    };
    apply(&mut data, &host)?;
    crate::standalone::settingsfile::save(settings_path, &data).await?;
    tracing::info!(label = "Plugin", "Merged managed Jellyfin host settings");
    Ok(())
}

/// `readJellyfinHostFile()`: the parsed file, `None` when it is missing,
/// unreadable or falsy.
pub async fn read_host_file(path: &Path) -> Option<Value> {
    let text = tokio::fs::read_to_string(path).await.ok()?;
    let host: Value = serde_json::from_str(&text).ok()?;
    truthy(Some(&host)).then_some(host)
}

/// `pluginValue(current, incoming, applied)`: the plugin page's value wins;
/// without one, only a value the plugin set before is cleared.
fn plugin_value(current: Option<&Value>, incoming: &str, applied: Option<&Value>) -> Value {
    if !incoming.is_empty() {
        return Value::from(incoming);
    }
    if current == applied {
        return Value::from("");
    }
    match current {
        None | Some(Value::Null) => Value::from(""),
        Some(v) => v.clone(),
    }
}

/// `mergeLibraries(current, incoming)`: the plugin's list, keeping the
/// `enabled` and `lastScan` Foreseerr already had for each id.
fn merge_libraries(current: Option<&Value>, incoming: &Value) -> Result<Value> {
    let Value::Array(incoming) = incoming else {
        bail!("TypeError: incoming.map is not a function");
    };
    let previous: Vec<&Value> = current
        .and_then(Value::as_array)
        .map(|libs| libs.iter().collect())
        .unwrap_or_default();
    let find = |id: Option<&Value>| {
        // `new Map(...)`: the last library with an id wins.
        previous.iter().rev().find(|l| l.get("id") == id).copied()
    };
    let merged = incoming
        .iter()
        .map(|library| {
            let id = library.get("id");
            let prev = find(id);
            let mut out = Map::new();
            for key in ["id", "name", "type"] {
                if let Some(v) = library.get(key) {
                    out.insert(key.to_owned(), v.clone());
                }
            }
            let enabled = match prev.and_then(|p| p.get("enabled")) {
                Some(v) if !v.is_null() => v.clone(),
                Some(_) | None => Value::Bool(library.get("enabled") != Some(&Value::Bool(false))),
            };
            out.insert(String::from("enabled"), enabled);
            if let Some(last) = prev.and_then(|p| p.get("lastScan")) {
                out.insert(String::from("lastScan"), last.clone());
            }
            Value::Object(out)
        })
        .collect();
    Ok(Value::Array(merged))
}

fn object<'a>(data: &'a mut Value, key: &str) -> Result<&'a mut Map<String, Value>> {
    let Some(map) = data.as_object_mut() else {
        bail!("TypeError: settings is not an object");
    };
    let entry = map
        .entry(key.to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    if entry.is_null() {
        *entry = Value::Object(Map::new());
    }
    entry
        .as_object_mut()
        .with_context(|| format!("TypeError: settings.{key} is not an object"))
}

/// `applyJellyfinHostFile(host)`.
///
/// # Errors
///
/// A library list that isn't an array (Node throws).
pub fn apply(data: &mut Value, host: &Value) -> Result<()> {
    let host_main = host.get("main");
    let main = object(data, "main")?;
    main.insert(String::from("mediaServerType"), Value::from(JELLYFIN));
    main.insert(
        String::from("mediaServerLogin"),
        nullish(
            host_main.and_then(|m| m.get("mediaServerLogin")),
            Value::Bool(true),
        ),
    );
    main.insert(
        String::from("localLogin"),
        nullish(
            host_main.and_then(|m| m.get("localLogin")),
            Value::Bool(false),
        ),
    );
    let current_url = main.get("applicationUrl").cloned();
    let incoming_url = host_main
        .and_then(|m| m.get("applicationUrl"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let locale = host_main
        .and_then(|m| m.get("locale"))
        .filter(|l| truthy(Some(l)))
        .cloned();
    if let Some(locale) = locale {
        main.insert(String::from("locale"), locale);
    }
    let plugin = object(data, "plugin")?;
    if let Some(incoming) = &incoming_url {
        let value = plugin_value(current_url.as_ref(), incoming, plugin.get("applicationUrl"));
        plugin.insert(
            String::from("applicationUrl"),
            Value::from(incoming.as_str()),
        );
        object(data, "main")?.insert(String::from("applicationUrl"), value);
    }
    if let Some(jf) = host.get("jellyfin").filter(|j| truthy(Some(j))) {
        apply_jellyfin(data, jf)?;
    }
    let provider = host
        .pointer("/trakt/provider")
        .and_then(Value::as_str)
        .filter(|p| matches!(*p, "jellyfin" | "direct"))
        .map(str::to_owned);
    let trakt = object(data, "trakt")?;
    if let Some(provider) = provider {
        if !truthy(trakt.get("clientId")) {
            trakt.insert(String::from("provider"), Value::from(provider));
        }
    }
    let has_key = truthy(data.pointer("/jellyfin/apiKey"));
    let public = object(data, "public")?;
    if !truthy(public.get("initialized")) && has_key {
        public.insert(String::from("initialized"), Value::Bool(true));
    }
    Ok(())
}

/// `value ?? fallback`.
fn nullish(value: Option<&Value>, fallback: Value) -> Value {
    match value {
        None | Some(Value::Null) => fallback,
        Some(v) => v.clone(),
    }
}

/// The `jellyfinPatch` part of `applyJellyfinHostFile`.
fn apply_jellyfin(data: &mut Value, jf: &Value) -> Result<()> {
    let mut patch: Vec<(&str, Value)> = Vec::new();
    for key in ["name", "ip"] {
        if let Some(v) = jf.get(key).filter(|v| truthy(Some(v))) {
            patch.push((key, v.clone()));
        }
    }
    if let Some(v) = jf.get("port").filter(|v| v.is_number()) {
        patch.push(("port", v.clone()));
    }
    if let Some(v) = jf.get("useSsl").filter(|v| v.is_boolean()) {
        patch.push(("useSsl", v.clone()));
    }
    if let Some(v) = jf.get("urlBase").filter(|v| v.is_string()) {
        patch.push(("urlBase", v.clone()));
    }
    if let Some(incoming) = jf.get("externalHostname").and_then(Value::as_str) {
        let current = data.pointer("/jellyfin/externalHostname").cloned();
        let plugin = object(data, "plugin")?;
        let value = plugin_value(current.as_ref(), incoming, plugin.get("externalHostname"));
        plugin.insert(String::from("externalHostname"), Value::from(incoming));
        patch.push(("externalHostname", value));
    }
    for key in ["serverId", "apiKey"] {
        if let Some(v) = jf.get(key).filter(|v| truthy(Some(v))) {
            patch.push((key, v.clone()));
        }
    }
    if let Some(incoming) = jf.get("libraries").filter(|v| truthy(Some(v))) {
        let merged = merge_libraries(data.pointer("/jellyfin/libraries"), incoming)?;
        patch.push(("libraries", merged));
    }
    let jellyfin = object(data, "jellyfin")?;
    for (key, value) in patch {
        jellyfin.insert(key.to_owned(), value);
    }
    Ok(())
}

// --- index.html -----------------------------------------------------------

static INDEX: OnceLock<String> = OnceLock::new();

/// `/^\/(?!\/)[a-zA-Z0-9/._~-]+$/`.
fn valid_base(base: &str) -> bool {
    let Some(rest) = base.strip_prefix('/') else {
        return false;
    };
    !rest.is_empty()
        && !rest.starts_with('/')
        && rest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'.' | b'_' | b'~' | b'-'))
}

/// `pluginIndexHtml(html)`.
///
/// # Errors
///
/// `Invalid plugin public base path`.
pub fn index_html(html: &str, public_base: Option<&str>) -> Result<String> {
    let base = public_base
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| super::plugin_base_path());
    let base = base.strip_suffix('/').unwrap_or(base);
    if !valid_base(base) {
        bail!("Invalid plugin public base path");
    }
    let tag = format!(
        "<head><base href=\"{base}/\"><meta name=\"foreseerr-base-path\" content=\"{base}\">"
    );
    let html = html.replacen("<head>", &tag, 1);
    Ok(strip_manifest_links(&html))
}

/// `.replace(/<link\s+rel="manifest"[^>]*>/g, '')`.
fn strip_manifest_links(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(at) = rest.find("<link") {
        let (before, from) = rest.split_at(at);
        out.push_str(before);
        let after_link = from.get(5..).unwrap_or("");
        let spaces = after_link.len() - after_link.trim_start_matches(is_js_space).len();
        let attr = after_link.get(spaces..).unwrap_or("");
        if spaces > 0 && attr.starts_with("rel=\"manifest\"") {
            let Some(end) = attr.find('>') else {
                out.push_str(from);
                return out;
            };
            rest = attr.get(end + 1..).unwrap_or("");
            continue;
        }
        out.push_str("<link");
        rest = after_link;
    }
    out.push_str(rest);
    out
}

/// `\s` in a JavaScript regular expression.
fn is_js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// The startup's `pluginIndexHtml(await fs.readFile(index.html))` in
/// production; the result is what [`index`] serves.
///
/// # Errors
///
/// index.html is missing, or the base path is invalid.
pub fn check_index_base() -> Result<()> {
    if !crate::standalone::production() {
        return Ok(());
    }
    let root = crate::env::Env::from_env()?.app_root;
    let file = crate::standalone::public_path(&root).join("index.html");
    let html = std::fs::read_to_string(&file).with_context(|| {
        format!(
            "ENOENT: no such file or directory, open '{}'",
            file.display()
        )
    })?;
    let public = std::env::var("FORESEERR_PUBLIC_BASE_PATH").ok();
    let rewritten = index_html(&html, public.as_deref())?;
    INDEX.set(rewritten).ok();
    Ok(())
}

/// `path.extname(p)` (POSIX).
fn extname(path: &str) -> &str {
    let segment = path.rsplit('/').next().unwrap_or("");
    if segment == ".." {
        return "";
    }
    match segment.rfind('.') {
        Some(0) | None => "",
        Some(at) => segment.get(at..).unwrap_or(""),
    }
}

/// The plugin's page route, ahead of the static files: `None` when it
/// doesn't apply (Express moves on).
#[must_use]
pub fn index(parts: &Parts) -> Option<Response<Body>> {
    if !(super::active() && super::plugin_mode()) {
        return None;
    }
    let html = INDEX.get()?;
    if parts.method != Method::GET && parts.method != Method::HEAD {
        return None;
    }
    let path = parts.uri.path();
    let backend = path == "/api"
        || path.starts_with("/api/")
        || path.starts_with("/api-docs")
        || path.starts_with("/imageproxy")
        || path.starts_with("/avatarproxy")
        || path.starts_with("/assets/");
    if backend || (!extname(path).is_empty() && !path.as_bytes().ends_with(b".html")) {
        return None;
    }
    Some(send_html(parts, html))
}

/// `res.setHeader('Cache-Control', 'no-store'); res.type('html').send(html)`.
fn send_html(parts: &Parts, html: &str) -> Response<Body> {
    let etag = crate::respond::weak_etag(html.as_bytes());
    let mut res = Response::new(Body::empty());
    let headers = res.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    if let Ok(v) = HeaderValue::from_str(&etag) {
        headers.insert(header::ETAG, v);
    }
    if crate::respond::fresh(&parts.headers, &etag) {
        headers.remove(header::CONTENT_TYPE);
        *res.status_mut() = StatusCode::NOT_MODIFIED;
        return res;
    }
    if let Ok(v) = HeaderValue::from_str(&html.len().to_string()) {
        res.headers_mut().insert(header::CONTENT_LENGTH, v);
    }
    if parts.method != Method::HEAD {
        *res.body_mut() = Body::from(html.to_owned());
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn index_html_like_plugin_index_html() -> Result<()> {
        let html = r#"<html><head><link rel="manifest" href="/m.json"><link rel="icon" href="/i.png"><link  rel="manifest"></head></html>"#;
        assert_eq!(
            index_html(html, Some("/jf/Foreseerr/"))?,
            r#"<html><head><base href="/jf/Foreseerr/"><meta name="foreseerr-base-path" content="/jf/Foreseerr"><link rel="icon" href="/i.png"></head></html>"#,
            "base and manifest"
        );
        assert!(
            index_html(html, Some("//evil")).is_err(),
            "protocol-relative"
        );
        assert!(index_html(html, Some("/a\"b")).is_err(), "quote");
        assert!(index_html(html, Some("/")).is_err(), "root only");
        Ok(())
    }

    #[test]
    fn extnames() {
        assert_eq!(extname("/login"), "", "none");
        assert_eq!(extname("/a/b.png"), ".png", "png");
        assert_eq!(extname("/.env"), "", "dotfile");
        assert_eq!(extname("/x."), ".", "trailing dot");
        assert_eq!(extname("/.."), "", "parent");
    }

    #[test]
    fn host_file_merge() -> Result<()> {
        let mut data = json!({
            "main": {"applicationUrl": "https://old", "mediaServerType": 4, "mediaServerLogin": true, "localLogin": true, "locale": "en"},
            "jellyfin": {"name": "", "ip": "", "port": 8096, "useSsl": false, "urlBase": "", "externalHostname": "", "libraries": [{"id": "lib1", "name": "M", "type": "movie", "enabled": false, "lastScan": 5}], "serverId": "", "apiKey": ""},
            "plugin": {"jellyfinAdmins": [], "applicationUrl": "", "externalHostname": ""},
            "trakt": {"clientId": "", "clientSecret": "", "provider": "direct"},
            "public": {"initialized": false}
        });
        let host = json!({
            "main": {"applicationUrl": "", "locale": "de"},
            "jellyfin": {"name": "JF", "port": 7590, "externalHostname": "https://jf", "apiKey": "k",
                "libraries": [{"id": "lib1", "name": "Movies", "type": "movie"}, {"id": "lib2", "name": "S", "type": "show", "enabled": false}]},
            "trakt": {"provider": "jellyfin"}
        });
        apply(&mut data, &host)?;
        assert_eq!(
            data,
            json!({
                "main": {"applicationUrl": "https://old", "mediaServerType": 2, "mediaServerLogin": true, "localLogin": false, "locale": "de"},
                "jellyfin": {"name": "JF", "ip": "", "port": 7590, "useSsl": false, "urlBase": "", "externalHostname": "https://jf",
                    "libraries": [{"id": "lib1", "name": "Movies", "type": "movie", "enabled": false, "lastScan": 5}, {"id": "lib2", "name": "S", "type": "show", "enabled": false}],
                    "serverId": "", "apiKey": "k"},
                "plugin": {"jellyfinAdmins": [], "applicationUrl": "", "externalHostname": "https://jf"},
                "trakt": {"clientId": "", "clientSecret": "", "provider": "jellyfin"},
                "public": {"initialized": true}
            }),
            "merged"
        );
        Ok(())
    }

    #[test]
    fn plugin_values() {
        let applied = Value::from("https://a");
        assert_eq!(
            plugin_value(Some(&applied), "", Some(&applied)),
            Value::from(""),
            "the plugin's own value is cleared"
        );
        assert_eq!(
            plugin_value(Some(&Value::from("mine")), "", Some(&applied)),
            Value::from("mine"),
            "a value set in Foreseerr stays"
        );
        assert_eq!(
            plugin_value(Some(&Value::from("mine")), "https://b", Some(&applied)),
            Value::from("https://b"),
            "the page wins"
        );
    }
}
