//! `/settings/plex` writes and plex.tv reads (`server/routes/settings`,
//! `PlexAPI`, `PlexTvAPI`), plus the library toggles shared with Jellyfin.

use std::time::Duration;

use axum::http::Method;
use serde_json::{Map, Value};

use super::nodestate::{
    admin, admin_columns, assign, decode_segment, fits, join_ordered, js_key_order, js_strict_eq,
    json_safe, mutate, nullable, object_body, raw_segment, req, upstream_get, Field, NativeFut, Ty,
    Upstream,
};
use super::plexxml::{self, Element};
use super::{Outcome, Ready, Table};
use crate::media::js_string;
use crate::settings::public::truthy;

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/settings/plex", Method::POST, plex_save),
    (
        "/api/v1/settings/plex/library/sync",
        Method::POST,
        plex_library_sync,
    ),
    (
        "/api/v1/settings/plex/library/{id}",
        Method::PUT,
        plex_library,
    ),
    (
        "/api/v1/settings/jellyfin/library/{id}",
        Method::PUT,
        jellyfin_library,
    ),
    ("/api/v1/settings/plex/users", Method::GET, plex_users),
    (
        "/api/v1/settings/plex/devices/servers",
        Method::GET,
        plex_servers,
    ),
];

/// `PlexSettings` in the spec (`name`, `machineId`, `libraries` are
/// read-only).
const PLEX_FIELDS: [Field; 4] = [
    req("ip", Ty::Str),
    req("port", Ty::Num),
    nullable("useSsl", Ty::Bool),
    nullable("webAppUrl", Ty::Str),
];

/// `new PlexAPI(...)`'s base URL for a set of Plex settings.
pub(crate) fn plex_base(plex: &Value) -> String {
    let scheme = if truthy(plex.get("useSsl")) {
        "https"
    } else {
        "http"
    };
    format!(
        "{scheme}://{}:{}",
        js_string(plex.get("ip")),
        js_string(plex.get("port"))
    )
}

/// A GET to a Plex server with `PlexAPI`'s headers.
pub(crate) fn plex_request(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    client_id: Option<&str>,
) -> reqwest::RequestBuilder {
    let mut request = client
        .get(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("X-Plex-Token", token);
    if let Some(id) = client_id {
        request = request.header("X-Plex-Client-Identifier", id);
    }
    request
        .header("X-Plex-Product", "Foreseerr")
        .header("X-Plex-Device-Name", "Foreseerr")
        .header("X-Plex-Platform", "Foreseerr")
}

/// `settings.clientId` as axios sends it (dropped when undefined).
fn client_id(ctx: &Ready<'_>) -> Option<String> {
    match ctx.settings.get("/clientId") {
        None => None,
        other => Some(js_string(other).into_owned()),
    }
}

/// The admin's Plex token (`?? ''`), or why Node has to answer.
async fn admin_plex_token(ctx: &Ready<'_>) -> Result<String, String> {
    match admin_columns(ctx, &["plexToken"]).await {
        Ok(Some(row)) => Ok(row
            .get("plexToken")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()),
        Ok(None) => Err(String::from("no admin user; findOneOrFail throws")),
        Err(e) => Err(format!("loading the admin failed: {e:#}")),
    }
}

/// `POST /settings/plex`: merge the body, test the server and store its
/// machine id and name. A failed test leaves the merged values in memory,
/// unsaved (in proxy mode only Node has that memory, so it answers).
fn plex_save<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(async move {
        if let Err(why) = admin(ctx) {
            return Outcome::forward(why);
        }
        let body = match object_body(ctx) {
            Ok(body) => body,
            Err(why) => return Outcome::forward(why),
        };
        if !fits(body, &PLEX_FIELDS, &["name", "machineId", "libraries"]) {
            return Outcome::forward(String::from("a body the validator may reject"));
        }
        let token = match admin_plex_token(ctx).await {
            Ok(token) => token,
            Err(why) => return Outcome::forward(why),
        };
        let Value::Object(body) =
            crate::tmdb::js_numbers(Value::Object(js_key_order(body.clone())))
        else {
            return Outcome::forward(String::from("a body that isn't an object"));
        };
        let Some(mut plex) = ctx
            .settings
            .get("/plex")
            .and_then(Value::as_object)
            .cloned()
        else {
            return Outcome::forward(String::from("settings.plex isn't an object"));
        };
        let before = plex.clone();
        assign(&mut plex, &body);
        let unchanged = plex == before;
        let url = format!("{}/", plex_base(&Value::Object(plex)));
        // `Object.assign(settings.plex, req.body)` lands in Node's shared
        // settings before the test; requests in between see it.
        if !unchanged && crate::standalone::enabled() {
            let kept = ctx
                .state
                .settings
                .mutate_unsaved(|doc| {
                    if let Some(plex) = doc.get_mut("plex").and_then(Value::as_object_mut) {
                        assign(plex, &body);
                    }
                })
                .await;
            if let Err(e) = kept {
                return Outcome::forward(format!("reading the settings failed: {e:#}"));
            }
        }
        let id = client_id(ctx);
        let result = upstream_get(plex_request(
            &ctx.state.outbound,
            &url,
            &token,
            id.as_deref(),
        ))
        .await;
        let container = match &result {
            Upstream::Json(v) => v.get("MediaContainer"),
            Upstream::NotJson | Upstream::Status(_) | Upstream::Network(_) => None,
        };
        let Some(machine_id) = container
            .and_then(|c| c.get("machineIdentifier"))
            .filter(|m| truthy(Some(m)))
        else {
            // Node's in-memory settings keep the assigned body unsaved; only
            // a body that changed nothing leaves them as the file has them.
            if !unchanged && !crate::standalone::enabled() {
                return Outcome::forward(String::from("the Plex connection test failed"));
            }
            return ctx.error(500, "Unable to connect to Plex.");
        };
        let name = container.and_then(|c| c.get("friendlyName"));
        let saved = mutate(ctx, |doc| {
            let Some(plex) = doc.get_mut("plex").and_then(Value::as_object_mut) else {
                return Err(Box::new(Outcome::forward(String::from(
                    "settings.plex isn't an object",
                ))));
            };
            assign(plex, &body);
            plex.insert(String::from("machineId"), machine_id.clone());
            match name {
                Some(name) => {
                    plex.insert(String::from("name"), name.clone());
                }
                None => {
                    plex.shift_remove("name");
                }
            }
            Ok(Value::Object(plex.clone()))
        })
        .await;
        match saved {
            Ok(saved) => ctx.json(&saved),
            Err(outcome) => outcome,
        }
    })
}

/// `PUT /settings/{plex,jellyfin}/library/{id}`: toggle one library.
async fn library_toggle(ctx: &Ready<'_>, server: &str) -> Outcome {
    if let Err(why) = admin(ctx) {
        return Outcome::forward(why);
    }
    let body = match object_body(ctx) {
        Ok(body) => body,
        Err(why) => return Outcome::forward(why),
    };
    let Some(Value::Bool(enabled)) = body.get("enabled") else {
        return Outcome::forward(String::from(
            "enabled isn't a boolean; the validator answers",
        ));
    };
    let Some(id) = decode_segment(raw_segment(ctx, 0)) else {
        return Outcome::forward(String::from("a library id Express can't decode"));
    };
    let wanted = Value::String(id);
    let updated = mutate(ctx, |doc| {
        let Some(libraries) = doc
            .get_mut(server)
            .and_then(|s| s.get_mut("libraries"))
            .and_then(Value::as_array_mut)
        else {
            return Err(Box::new(Outcome::forward(String::from(
                "libraries isn't a list",
            ))));
        };
        let mut found = None;
        for (i, library) in libraries.iter().enumerate() {
            if library.is_null() {
                return Err(Box::new(Outcome::forward(String::from(
                    "a null library; find throws",
                ))));
            }
            if js_strict_eq(library.get("id"), Some(&wanted)) {
                found = Some(i);
                break;
            }
        }
        let Some(library) = found.and_then(|i| libraries.get_mut(i)) else {
            return Err(Box::new(ctx.error(404, "Library does not exist.")));
        };
        let Some(map) = library.as_object_mut() else {
            return Err(Box::new(Outcome::forward(String::from(
                "a library that isn't an object",
            ))));
        };
        map.insert(String::from("enabled"), Value::Bool(*enabled));
        Ok(library.clone())
    })
    .await;
    match updated {
        Ok(updated) => ctx.json(&updated),
        Err(outcome) => outcome,
    }
}

fn plex_library<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(library_toggle(ctx, "plex"))
}

fn jellyfin_library<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(library_toggle(ctx, "jellyfin"))
}

/// The libraries a sync keeps, built from the server's list: enabled flags
/// and last scans carried over from `existing`. `None` where Node's map
/// would throw.
pub(crate) fn merge_libraries(found: &[Value], existing: &[Value]) -> Option<Vec<Value>> {
    let mut out = Vec::with_capacity(found.len());
    for library in found {
        let mut current = None;
        for old in existing {
            if old.is_null() {
                return None;
            }
            if js_strict_eq(old.get("id"), library.get("key")) {
                current = Some(old);
                break;
            }
        }
        let mut entry = Map::new();
        if let Some(key) = library.get("key") {
            entry.insert(String::from("id"), key.clone());
        }
        if let Some(title) = library.get("title") {
            entry.insert(String::from("name"), title.clone());
        }
        let enabled = match current.and_then(|c| c.get("enabled")) {
            None | Some(Value::Null) => Value::Bool(false),
            Some(v) => v.clone(),
        };
        entry.insert(String::from("enabled"), enabled);
        if let Some(kind) = library.get("type") {
            entry.insert(String::from("type"), kind.clone());
        }
        if let Some(scan) = current.and_then(|c| c.get("lastScan")) {
            entry.insert(String::from("lastScan"), scan.clone());
        }
        out.push(Value::Object(entry));
    }
    Some(out)
}

/// `syncLibraries`' filter: movie and show libraries with a metadata agent.
pub(crate) fn plex_libraries(directory: &Value) -> Option<Vec<Value>> {
    let items = directory.as_array()?;
    let mut out = Vec::new();
    for library in items {
        if library.is_null() {
            return None;
        }
        let kind_ok = matches!(
            library.get("type").and_then(Value::as_str),
            Some("movie" | "show")
        );
        let agent_ok =
            library.get("agent").and_then(Value::as_str) != Some("com.plexapp.agents.none");
        if kind_ok && agent_ok {
            out.push(library.clone());
        }
    }
    Some(out)
}

/// `POST /settings/plex/library/sync`.
fn plex_library_sync<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(async move {
        if let Err(why) = admin(ctx) {
            return Outcome::forward(why);
        }
        let token = match admin_plex_token(ctx).await {
            Ok(token) => token,
            Err(why) => return Outcome::forward(why),
        };
        let Some(plex) = ctx.settings.get("/plex").cloned() else {
            return Outcome::forward(String::from("no plex settings"));
        };
        let Some(existing) = plex.get("libraries").and_then(Value::as_array).cloned() else {
            return Outcome::forward(String::from("plex.libraries isn't a list"));
        };
        let url = format!("{}/library/sections", plex_base(&plex));
        let id = client_id(ctx);
        let result = upstream_get(plex_request(
            &ctx.state.outbound,
            &url,
            &token,
            id.as_deref(),
        ))
        .await;
        let found = match result {
            Upstream::Json(v) => v
                .get("MediaContainer")
                .and_then(|c| c.get("Directory"))
                .and_then(plex_libraries),
            Upstream::Status(status) => {
                tracing::error!("Failed to fetch Plex libraries: status {status}");
                return ctx.error(status, "UNKNOWN");
            }
            Upstream::NotJson => None,
            Upstream::Network(e) => {
                tracing::error!("Failed to fetch Plex libraries: {e}");
                None
            }
        };
        let Some(found) = found else {
            return ctx.error(502, "CONNECTION_ERROR");
        };
        let Some(libraries) = merge_libraries(&found, &existing) else {
            return Outcome::forward(String::from("a null library; find throws"));
        };
        let saved = mutate(ctx, |doc| {
            if let Some(plex) = doc.get_mut("plex").and_then(Value::as_object_mut) {
                plex.insert(String::from("libraries"), Value::Array(libraries.clone()));
            }
            Ok(())
        })
        .await;
        if let Err(outcome) = saved {
            return outcome;
        }
        ctx.json(&Value::Array(libraries))
    })
}

/// A plex.tv XML endpoint with `PlexTvAPI`'s headers, parsed; none for any
/// failure (Node's message for those isn't reproduced).
pub(super) async fn plex_tv_xml(
    client: &reqwest::Client,
    token: &str,
    path: &str,
) -> Option<Element> {
    let response = client
        .get(format!("https://plex.tv{path}"))
        .header("X-Plex-Token", token)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    let text = response.text().await.ok()?;
    plexxml::parse(&text)
}

/// JavaScript's `parseInt(text, 10)` for short numbers; none for `NaN`.
fn parse_int(text: Option<&str>) -> Option<i64> {
    let t = super::nodestate::js_trim(text?);
    let (negative, digits) = t
        .strip_prefix('-')
        .map_or_else(|| (false, t.strip_prefix('+').unwrap_or(t)), |d| (true, d));
    let end = digits
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(digits.len());
    let n: i64 = digits.get(..end.min(15))?.parse().ok()?;
    Some(if negative { -n } else { n })
}

/// `new Date(parseInt(s, 10) * 1000)` as JSON: an ISO string, or null for
/// an invalid date; none for dates printed differently.
fn device_date(text: Option<&str>) -> Result<Value, String> {
    let Some(seconds) = parse_int(text) else {
        return Ok(Value::Null);
    };
    if !(0..=253_402_300_799).contains(&seconds) {
        return Err(String::from("a device date outside 0000-9999"));
    }
    Ok(Value::from(
        crate::clock::Utc::from_unix_millis(seconds * 1000).iso_string(),
    ))
}

/// `getDevices`' mapping of one `<Device>`; why Node would throw otherwise.
fn device_json(device: &Element) -> Result<Map<String, Value>, String> {
    if !device.has_attrs() {
        return Err(String::from("a Device without attributes"));
    }
    let text = |key: &str| device.attr(key).map(Value::from);
    let flag = |key: &str| Value::Bool(device.attr(key) == Some("1"));
    let mut out = Map::new();
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(v) = value {
            out.insert(key.to_owned(), v);
        }
    };
    for key in [
        "name",
        "product",
        "productVersion",
        "platform",
        "platformVersion",
        "device",
        "clientIdentifier",
    ] {
        put(key, text(key));
    }
    put("createdAt", Some(device_date(device.attr("createdAt"))?));
    put("lastSeenAt", Some(device_date(device.attr("lastSeenAt"))?));
    let provides = device
        .attr("provides")
        .ok_or_else(|| String::from("a Device without provides"))?;
    put(
        "provides",
        Some(Value::Array(provides.split(',').map(Value::from).collect())),
    );
    put("owned", Some(flag("owned")));
    put("accessToken", text("accessToken"));
    put("publicAddress", text("publicAddress"));
    for key in [
        "publicAddressMatches",
        "httpsRequired",
        "synced",
        "relay",
        "dnsRebindingProtection",
        "natLoopbackSupported",
        "presence",
    ] {
        put(key, Some(flag(key)));
    }
    put("ownerID", text("ownerID"));
    put("home", Some(flag("home")));
    put("sourceTitle", text("sourceTitle"));
    let connections: Vec<&Element> = device.children_named("Connection").collect();
    if !connections.is_empty() {
        let mut list = Vec::with_capacity(connections.len());
        for conn in connections {
            if !conn.has_attrs() {
                return Err(String::from("a Connection without attributes"));
            }
            let mut c = Map::new();
            for key in ["protocol", "address"] {
                if let Some(v) = conn.attr(key) {
                    c.insert(key.to_owned(), Value::from(v));
                }
            }
            c.insert(
                String::from("port"),
                parse_int(conn.attr("port")).map_or(Value::Null, Value::from),
            );
            if let Some(v) = conn.attr("uri") {
                c.insert(String::from("uri"), Value::from(v));
            }
            c.insert(
                String::from("local"),
                Value::Bool(conn.attr("local") == Some("1")),
            );
            list.push(Value::Object(c));
        }
        out.insert(String::from("connection"), Value::Array(list));
    }
    Ok(out)
}

/// How one connection test ended: `(200, "OK")` or `(500, message)`, or
/// none when axios's message for the failure isn't reproduced.
async fn probe(
    client: reqwest::Client,
    url: String,
    headers: (String, Option<String>),
) -> Option<String> {
    let (token, id) = headers;
    let request =
        plex_request(&client, &url, &token, id.as_deref()).timeout(Duration::from_secs(5));
    match request.send().await {
        Ok(response) if response.status().is_success() => Some(String::from("OK")),
        Ok(response) => Some(format!(
            "Request failed with status code {}",
            response.status().as_u16()
        )),
        Err(e) => Some(crate::outbound::describe(&e)),
    }
}

/// The owned servers as JSON objects and the connection tests to run.
type Expanded = (Vec<Map<String, Value>>, Vec<Probe>);

/// One connection to test: its place and request.
struct Probe {
    device: usize,
    connection: usize,
    url: String,
}

/// The owned servers with their connections expanded as the route does
/// (a `plex.direct` URI adds a copy aimed at its host; the original is
/// tried over HTTP), and the tests to run.
fn expand_servers(root: &Element, plex: &Value) -> Result<Expanded, String> {
    let mut devices = Vec::new();
    for device in root.children_named("Device") {
        devices.push(device_json(device)?);
    }
    let mut servers: Vec<Map<String, Value>> = devices
        .into_iter()
        .filter(|d| {
            let provides = d.get("provides").and_then(Value::as_array);
            provides.is_some_and(|p| p.iter().any(|v| v.as_str() == Some("server")))
                && d.get("owned") == Some(&Value::Bool(true))
        })
        .collect();
    let mut probes = Vec::new();
    for (di, device) in servers.iter_mut().enumerate() {
        let Some(Value::Array(connections)) = device.get_mut("connection") else {
            return Err(String::from("an owned server without connections"));
        };
        let mut direct = Vec::new();
        for conn in connections.iter_mut() {
            let uri = conn.get("uri").and_then(Value::as_str).unwrap_or("");
            let url = reqwest::Url::parse(uri)
                .map_err(|_| String::from("a connection URI new URL() may reject"))?;
            let host = url.host_str().unwrap_or("").to_owned();
            if conn.get("address").and_then(Value::as_str) != Some(host.as_str()) {
                let mut copy = conn.clone();
                if let Some(map) = copy.as_object_mut() {
                    map.insert(String::from("address"), Value::from(host));
                }
                direct.push(copy);
                if let Some(map) = conn.as_object_mut() {
                    map.insert(String::from("protocol"), Value::from("http"));
                }
            }
        }
        connections.extend(direct);
        for (ci, conn) in connections.iter().enumerate() {
            let address = conn
                .get("address")
                .and_then(Value::as_str)
                .ok_or_else(|| String::from("a connection without an address"))?;
            let port = conn
                .get("port")
                .and_then(Value::as_i64)
                .ok_or_else(|| String::from("a connection without a port"))?;
            if address.contains(':') || address.is_empty() {
                return Err(String::from("an address the URL can't hold as is"));
            }
            let mut settings = plex.clone();
            if let Some(map) = settings.as_object_mut() {
                map.insert(String::from("ip"), Value::from(address));
                map.insert(String::from("port"), Value::from(port));
                map.insert(
                    String::from("useSsl"),
                    Value::Bool(conn.get("protocol").and_then(Value::as_str) == Some("https")),
                );
            }
            probes.push(Probe {
                device: di,
                connection: ci,
                url: format!("{}/", plex_base(&settings)),
            });
        }
    }
    Ok((servers, probes))
}

/// `GET /settings/plex/devices/servers`: the admin's owned servers and
/// whether each of their connections answers.
fn plex_servers<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(async move {
        if let Err(why) = admin(ctx) {
            return Outcome::forward(why);
        }
        let token = match admin_plex_token(ctx).await {
            Ok(token) if !token.is_empty() => token,
            // No client, so `devices` is undefined.
            Ok(_) => return super::empty_json(),
            Err(why) => return Outcome::forward(why),
        };
        let client = &ctx.state.outbound;
        let failed = || ctx.error(500, "Unable to retrieve Plex server list.");
        let root = match plex_tv(client, &token, "/api/resources?includeHttps=1").await {
            // An empty document parses to nothing, so there are no devices.
            PlexTv::Text(text) if text.trim_start_matches('\u{feff}').trim().is_empty() => {
                return super::empty_json()
            }
            PlexTv::Text(text) => match plexxml::parse(&text) {
                Some(root) => root,
                None => return failed(),
            },
            PlexTv::Status(_) | PlexTv::Network(_) => return failed(),
        };
        if root.name != "MediaContainer" || root.children_named("Device").next().is_none() {
            // No devices.
            return super::empty_json();
        }
        let plex = ctx.settings.get("/plex").cloned().unwrap_or(Value::Null);
        let (mut servers, probes) = match expand_servers(&root, &plex) {
            Ok(expanded) => expanded,
            Err(why) => return Outcome::forward(why),
        };
        let id = client_id(ctx);
        let tasks: Vec<_> = probes
            .iter()
            .map(|p| probe(client.clone(), p.url.clone(), (token.clone(), id.clone())))
            .collect();
        let results = join_ordered(tasks).await;
        if results.len() != probes.len() {
            return Outcome::forward(String::from("a connection test failed to run"));
        }
        for (p, message) in probes.iter().zip(results) {
            let Some(message) = message else {
                return Outcome::forward(String::from(
                    "a connection error axios words differently",
                ));
            };
            let conn = servers
                .get_mut(p.device)
                .and_then(|d| d.get_mut("connection"))
                .and_then(Value::as_array_mut)
                .and_then(|c| c.get_mut(p.connection))
                .and_then(Value::as_object_mut);
            if let Some(conn) = conn {
                let status = if message == "OK" { 200 } else { 500 };
                conn.insert(String::from("status"), Value::from(status));
                conn.insert(String::from("message"), Value::from(message));
            }
        }
        let body: Vec<Value> = servers.into_iter().map(Value::Object).collect();
        ctx.json(&json_safe(Value::Array(body)))
    })
}

/// `checkUserAccess`: whether the shared user can reach this server, read
/// from a fresh copy of the user list as Node fetches it.
pub(super) async fn check_user_access(
    client: reqwest::Client,
    token: String,
    machine_id: Value,
    user_id: i64,
) -> bool {
    if !truthy(Some(&machine_id)) {
        return false;
    }
    let Some(root) = plex_tv_xml(&client, &token, "/api/users").await else {
        return false;
    };
    if root.name != "MediaContainer" {
        return false;
    }
    for user in root.children_named("User") {
        if !user.has_attrs() {
            return false;
        }
        if parse_int(user.attr("id")) != Some(user_id) {
            continue;
        }
        for server in user.children_named("Server") {
            if !server.has_attrs() {
                return false;
            }
            let id = server.attr("machineIdentifier").map(Value::from);
            if js_strict_eq(id.as_ref(), Some(&machine_id)) {
                return true;
            }
        }
        return false;
    }
    false
}

/// `GET /settings/plex/users`: shared Plex users with an email who aren't
/// imported yet and can reach this server, sorted by username.
fn plex_users<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(async move {
        if let Err(why) = admin(ctx) {
            return Outcome::forward(why);
        }
        let token = match admin_plex_token(ctx).await {
            Ok(token) => token,
            Err(why) => return Outcome::forward(why),
        };
        let client = &ctx.state.outbound;
        // Everything the handler's try catches.
        let failed = || ctx.error(500, "Unable to retrieve unimported Plex users.");
        let root = match plex_tv(client, &token, "/api/users").await {
            PlexTv::Text(text) => match plexxml::parse(&text) {
                Some(root) => root,
                None => return failed(),
            },
            PlexTv::Status(_) | PlexTv::Network(_) => return failed(),
        };
        let users: Vec<&Element> = root.children_named("User").collect();
        if root.name != "MediaContainer" || users.is_empty() || users.iter().any(|u| !u.has_attrs())
        {
            // `MediaContainer.User.map((user) => user.$).filter(...)` throws.
            return failed();
        }
        let mut plex_users = Vec::new();
        for user in users {
            let Some(email) = user.attr("email").filter(|e| !e.is_empty()) else {
                continue;
            };
            let Some(id) = user
                .attr("id")
                .filter(|id| {
                    !id.is_empty() && id.len() <= 15 && id.bytes().all(|b| b.is_ascii_digit())
                })
                .and_then(|id| id.parse::<i64>().ok())
            else {
                return Outcome::forward(String::from(
                    "a Plex user id parseInt may read differently",
                ));
            };
            plex_users.push((user, id, email.to_lowercase()));
        }
        let existing = match existing_users(ctx, &plex_users).await {
            Ok(rows) => rows,
            Err(e) => return Outcome::forward(format!("loading users failed: {e:#}")),
        };
        let machine_id = ctx
            .settings
            .get("/plex/machineId")
            .cloned()
            .unwrap_or(Value::Null);
        let candidates: Vec<&(&Element, i64, String)> = plex_users
            .iter()
            .filter(|(_, id, email)| {
                !existing.iter().any(|(plex_id, user_email)| {
                    *plex_id == Some(*id) || user_email.as_deref() == Some(email.as_str())
                })
            })
            .collect();
        let checks: Vec<_> = candidates
            .iter()
            .map(|(_, id, _)| {
                check_user_access(client.clone(), token.clone(), machine_id.clone(), *id)
            })
            .collect();
        let access = join_ordered(checks).await;
        if access.len() != candidates.len() {
            return Outcome::forward(String::from("an access check failed to run"));
        }
        let mut unimported: Vec<&Element> = candidates
            .iter()
            .zip(access)
            .filter_map(|((user, _, _), ok)| ok.then_some(*user))
            .collect();
        unimported.sort_by_cached_key(|u| {
            u.attr("username").map_or((1, Vec::new()), |name| {
                (0, name.encode_utf16().collect::<Vec<u16>>())
            })
        });
        let body: Vec<Value> = unimported
            .iter()
            .map(|u| {
                Value::Object(
                    u.attrs
                        .iter()
                        .map(|(k, v)| (k.clone(), Value::from(v.as_str())))
                        .collect(),
                )
            })
            .collect();
        ctx.json(&json_safe(Value::Array(body)))
    })
}

/// The users matching any Plex id or email: `(plexId, email)` pairs.
async fn existing_users(
    ctx: &Ready<'_>,
    plex_users: &[(&Element, i64, String)],
) -> anyhow::Result<Vec<(Option<i64>, Option<String>)>> {
    if plex_users.is_empty() {
        return Ok(Vec::new());
    }
    let mut binds = Vec::new();
    let mut id_marks = Vec::new();
    for (_, id, _) in plex_users {
        binds.push(crate::db::Bind::Int(*id));
        id_marks.push(format!("?{}", binds.len()));
    }
    let mut email_marks = Vec::new();
    for (_, _, email) in plex_users {
        binds.push(crate::db::Bind::Text(email.clone()));
        email_marks.push(format!("?{}", binds.len()));
    }
    let sql = format!(
        "SELECT \"plexId\", \"email\" FROM \"user\" WHERE \"plexId\" IN ({}) OR \"email\" IN ({})",
        id_marks.join(", "),
        email_marks.join(", ")
    );
    let rows = ctx.state.db.rows(&sql, &binds).await?;
    Ok(rows
        .iter()
        .map(|r| {
            (
                r.get("plexId").and_then(Value::as_i64),
                r.get("email").and_then(Value::as_str).map(str::to_owned),
            )
        })
        .collect())
}

/// How a plex.tv GET ended.
#[derive(Debug)]
pub(super) enum PlexTv {
    /// A 2xx answer's text.
    Text(String),
    /// A non-2xx answer.
    Status(u16),
    /// No answer.
    Network(reqwest::Error),
}

/// `PlexTvAPI`'s `this.axios.get(path, { responseType: 'text' })`.
pub(super) async fn plex_tv(client: &reqwest::Client, token: &str, path: &str) -> PlexTv {
    let sent = client
        .get(format!("https://plex.tv{path}"))
        .header("X-Plex-Token", token)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .send()
        .await;
    let response = match sent {
        Ok(response) => response,
        Err(e) => return PlexTv::Network(e),
    };
    let status = response.status();
    if !status.is_success() {
        return PlexTv::Status(status.as_u16());
    }
    match response.text().await {
        Ok(text) => PlexTv::Text(text),
        Err(e) => PlexTv::Network(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn library_merge() {
        let found = vec![
            json!({"key": "1", "title": "Movies", "type": "movie"}),
            json!({"key": "2", "title": "TV", "type": "show"}),
        ];
        let existing = vec![json!({"id": "1", "name": "Old", "enabled": true, "lastScan": 5})];
        assert_eq!(
            merge_libraries(&found, &existing),
            Some(vec![
                json!({"id": "1", "name": "Movies", "enabled": true, "type": "movie", "lastScan": 5}),
                json!({"id": "2", "name": "TV", "enabled": false, "type": "show"}),
            ]),
            "merge"
        );
        assert_eq!(
            plex_libraries(
                &json!([{"type": "movie", "agent": "x"}, {"type": "artist"}, {"type": "show", "agent": "com.plexapp.agents.none"}])
            ),
            Some(vec![json!({"type": "movie", "agent": "x"})]),
            "filter"
        );
        assert_eq!(parse_int(Some(" 42abc")), Some(42), "parseInt");
        assert_eq!(parse_int(Some("x")), None, "NaN");
        assert_eq!(
            device_date(Some("0")),
            Ok(json!("1970-01-01T00:00:00.000Z")),
            "epoch"
        );
        assert_eq!(device_date(None), Ok(Value::Null), "invalid date");
    }

    #[test]
    fn servers() {
        let xml = r#"<MediaContainer><Device name="S" provides="server,player" owned="1" createdAt="1"><Connection protocol="https" address="10.0.0.2" port="32400" uri="https://10-0-0-2.abc.plex.direct:32400" local="1"/></Device><Device name="P" provides="player" owned="1"/></MediaContainer>"#;
        let root = plexxml::parse(xml);
        let expanded = root
            .as_ref()
            .map(|r| expand_servers(r, &json!({"ip": "x", "port": 1})));
        let (servers, probes) = match expanded {
            Some(Ok(expanded)) => expanded,
            _ => (Vec::new(), Vec::new()),
        };
        assert_eq!(servers.len(), 1, "owned servers only");
        let urls: Vec<&str> = probes.iter().map(|p| p.url.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "http://10.0.0.2:32400/",
                "https://10-0-0-2.abc.plex.direct:32400/"
            ],
            "original over http, plex.direct copy over https"
        );
    }
}
