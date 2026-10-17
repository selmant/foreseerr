//! `GET /settings/logs`: the machine log file, filtered, searched and paged
//! as Node does it, behind the same `express-rate-limit` (50 a minute,
//! legacy `X-RateLimit-*` headers).

use std::collections::HashMap;
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::sync::{Mutex, OnceLock};

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{header, HeaderValue, Method, Response, StatusCode};
use serde_json::{Map, Number, Value};

use super::nodestate::{json_safe, NativeFut};
use super::{Outcome, Ready, Table};

/// This module's routes.
pub(super) const ROUTES: &Table = &[("/api/v1/settings/logs", Method::GET, logs)];

/// The limiter's window and allowance.
const WINDOW_MS: i64 = 60_000;
const LIMIT: i64 = 50;

/// The properties a log line keeps at the top; any other is copied into
/// `data` too.
const LOG_PROPERTIES: [&str; 5] = ["timestamp", "level", "label", "message", "data"];

/// The parsed query string.
#[derive(Debug, Clone, PartialEq)]
struct LogQuery {
    /// `pageSize`.
    take: i64,
    /// `skip`.
    skip: i64,
    levels: Vec<&'static str>,
    search: Option<String>,
}

/// `take`, `skip`, `filter` and `search`, for the spellings Node and its
/// validator agree on; anything else is Node's.
fn parse_query(raw: &str) -> Result<LogQuery, String> {
    let mut query = LogQuery {
        take: 25,
        skip: 0,
        levels: vec!["debug", "info", "warn", "error"],
        search: None,
    };
    let mut seen: Vec<&str> = Vec::new();
    let forward = |why: &str| Err(why.to_owned());
    for pair in raw.split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if seen.contains(&key) {
            return forward("a repeated query key");
        }
        seen.push(key);
        let Some(value) = super::user::decode_query_value(value) else {
            return forward("a reserved or malformed character in a query value");
        };
        if value.is_empty() {
            return forward("an empty value");
        }
        let number = || super::blocklist::plain_integer(&value).filter(|n| *n <= 1_000_000_000);
        match key {
            "take" => match number().filter(|n| *n > 0) {
                Some(n) => query.take = n,
                None => return forward("take isn't a positive integer"),
            },
            "skip" => match number() {
                Some(n) => query.skip = n,
                None => return forward("skip isn't a non-negative integer"),
            },
            "filter" => {
                query.levels = match value.as_str() {
                    "debug" => vec!["debug", "info", "warn", "error"],
                    "info" => vec!["info", "warn", "error"],
                    "warn" => vec!["warn", "error"],
                    "error" => vec!["error"],
                    _ => return forward("an unknown filter"),
                };
            }
            "search" => query.search = Some(value),
            _ => return forward("an unknown query key"),
        }
    }
    Ok(query)
}

/// The handler's reading of the query the validator left:
/// `take ? Number(take) : 25`, `skip ? Number(skip) : 0`, the `filter`
/// switch, and `search` when truthy.
fn validated_query(q: &Map<String, Value>) -> Result<LogQuery, super::Fallback> {
    use super::params::truthy;
    let (take, skip) = super::params::take_skip(q, 25)?;
    let levels = match q.get("filter").and_then(Value::as_str) {
        Some("info") => vec!["info", "warn", "error"],
        Some("warn") => vec!["warn", "error"],
        Some("error") => vec!["error"],
        Some(_) | None => vec!["debug", "info", "warn", "error"],
    };
    Ok(LogQuery {
        take,
        skip,
        levels,
        search: truthy(q.get("search"))
            .then(|| crate::media::js_string(q.get("search")).into_owned()),
    })
}

/// JavaScript's `Number.prototype.toString` (`JSON.parse` read the number
/// as a double).
fn js_number(n: &Number) -> String {
    crate::jsval::number_string(crate::jsval::json_number(n))
}

/// `String(value)` for what a search tests; none where that isn't
/// followed here (objects, arrays, exponent numbers).
fn js_text(value: Option<&Value>) -> Option<String> {
    match value {
        None => Some(String::from("undefined")),
        Some(Value::Null) => Some(String::from("null")),
        Some(Value::Bool(b)) => Some(b.to_string()),
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) => Some(js_number(n)),
        Some(Value::Array(_) | Value::Object(_)) => None,
    }
}

/// `deepValueStrings`: every string and number under an object, at any
/// depth (`Object.values` of a string yields its characters).
fn deep_value_strings(value: &Value, out: &mut Vec<String>) -> Result<(), String> {
    let items: Vec<&Value> = match value {
        Value::Object(map) => map.values().collect(),
        Value::Array(items) => items.iter().collect(),
        Value::String(s) => {
            for unit in s.encode_utf16() {
                out.push(String::from_utf16_lossy(&[unit]));
            }
            return Ok(());
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => return Ok(()),
    };
    for item in items {
        match item {
            Value::String(s) => out.push(s.clone()),
            Value::Number(n) => out.push(js_number(n)),
            Value::Object(_) | Value::Array(_) => deep_value_strings(item, out)?,
            Value::Null | Value::Bool(_) => {}
        }
    }
    Ok(())
}

/// `new RegExp(escapeRegExp(search), 'i').test(text)`: a literal match on
/// UTF-16 code units under the non-Unicode `Canonicalize`.
fn matches(text: &str, needle: &str) -> bool {
    let fold = |s: &str| -> Vec<u16> { s.encode_utf16().map(canonicalize).collect() };
    let (hay, pin) = (fold(text), fold(needle));
    pin.is_empty() || hay.windows(pin.len()).any(|w| w == pin.as_slice())
}

/// `Canonicalize(ch)` for an `i` regular expression without `u`: the
/// upper case when it is one code unit, unless that would fold a
/// non-ASCII unit onto ASCII.
fn canonicalize(unit: u16) -> u16 {
    let Some(ch) = char::from_u32(u32::from(unit)) else {
        return unit;
    };
    let mut upper = ch.to_uppercase();
    let (Some(first), None) = (upper.next(), upper.next()) else {
        return unit;
    };
    let Ok(folded) = u16::try_from(u32::from(first)) else {
        return unit;
    };
    if unit >= 128 && folded < 128 {
        return unit;
    }
    folded
}

/// One line of the log as the route keeps it, `None` when it is filtered
/// out, or why Node has to answer.
fn process_line(line: &str, query: &LogQuery) -> Result<Option<Map<String, Value>>, String> {
    let parsed: Value = serde_json::from_str(line).map_err(|e| {
        if json_parse_fails(&e) {
            String::from(UNPARSABLE)
        } else {
            String::from("a log line serde can't parse")
        }
    })?;
    let mut message = match parsed {
        Value::Object(map) => map,
        Value::Null => return Err(String::from("a null log line")),
        Value::Bool(_) | Value::Number(_) | Value::String(_) | Value::Array(_) => return Ok(None),
    };
    let level_ok = message
        .get("level")
        .and_then(Value::as_str)
        .is_some_and(|l| query.levels.contains(&l));
    if !level_ok {
        return Ok(None);
    }
    let extras: Vec<String> = message
        .keys()
        .filter(|k| !LOG_PROPERTIES.contains(&k.as_str()))
        .cloned()
        .collect();
    for prop in extras {
        let lodash_path_safe = !prop.is_empty()
            && !prop.contains(['.', '[', ']'])
            && !super::nodestate::is_index_key(&prop)
            && !matches!(prop.as_str(), "__proto__" | "constructor" | "prototype");
        if !lodash_path_safe || message.get("data").is_some_and(Value::is_array) {
            return Err(String::from(
                "an extra log property lodash.set treats specially",
            ));
        }
        let value = message.get(&prop).cloned().unwrap_or(Value::Null);
        if !message.get("data").is_some_and(Value::is_object) {
            message.insert(String::from("data"), Value::Object(Map::new()));
        }
        if let Some(Value::Object(data)) = message.get_mut("data") {
            data.insert(prop, value);
        }
    }
    if let Some(search) = &query.search {
        let label = match message.get("label") {
            None | Some(Value::Null) => Some(String::new()),
            other => js_text(other),
        };
        let text = js_text(message.get("message"));
        let (Some(label), Some(text)) = (label, text) else {
            return Err(String::from(
                "a label or message String() isn't followed here",
            ));
        };
        let mut values = Vec::new();
        match message.get("data") {
            None | Some(Value::Null) => {}
            Some(data) => deep_value_strings(data, &mut values)?,
        }
        if !matches(&label, search)
            && !matches(&text, search)
            && !values.iter().any(|v| matches(v, search))
        {
            return Ok(None);
        }
    }
    Ok(Some(message))
}

/// Depth and container count of a value, as `jsonSafeClone` limits them.
fn shape(value: &Value, depth: usize, max_depth: &mut usize, nodes: &mut usize) {
    *max_depth = (*max_depth).max(depth);
    let children: Vec<&Value> = match value {
        Value::Object(map) => map.values().collect(),
        Value::Array(items) => items.iter().collect(),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => return,
    };
    *nodes += 1;
    for child in children {
        shape(child, depth + 1, max_depth, nodes);
    }
}

/// What [`process_line`] says about a line `JSON.parse` throws on: the
/// handler's catch answers 500.
const UNPARSABLE: &str = "a log line JSON.parse throws on";

/// Whether `JSON.parse` throws where serde failed: every syntax error but
/// the limits only serde has (number range, nesting, lone surrogates).
fn json_parse_fails(e: &serde_json::Error) -> bool {
    let text = e.to_string();
    let serde_only = ["number out of range", "recursion limit", "surrogate"];
    matches!(
        e.classify(),
        serde_json::error::Category::Syntax | serde_json::error::Category::Eof
    ) && !serde_only.iter().any(|s| text.contains(s))
}

/// The page of logs and its `pageInfo`, or why Node has to answer.
fn page(text: &str, query: &LogQuery) -> Result<Value, String> {
    // A line `JSON.parse` throws on (or a `null`, whose `.level` throws)
    // ends Node's loop in its catch, whatever came before it.
    for line in text.split('\n').filter(|l| !l.is_empty()) {
        match serde_json::from_str::<Value>(line) {
            Err(e) if json_parse_fails(&e) => return Err(String::from(UNPARSABLE)),
            Ok(Value::Null) => return Err(String::from(UNPARSABLE)),
            Ok(_) | Err(_) => {}
        }
    }
    let mut kept = Vec::new();
    for line in text.split('\n') {
        if line.is_empty() {
            continue;
        }
        if let Some(message) = process_line(line, query)? {
            kept.push(message);
        }
    }
    let total = kept.len();
    kept.reverse();
    // `logs.reverse().slice(skip, skip + pageSize)`.
    let range =
        super::params::slice_range(total, query.skip, query.skip.saturating_add(query.take));
    let shown: Vec<Value> = kept
        .into_iter()
        .skip(range.start)
        .take(range.len())
        .map(|m| json_safe(Value::Object(m)))
        .collect();
    let results = Value::Array(shown);
    let (mut depth, mut nodes) = (0, 0);
    shape(&results, 1, &mut depth, &mut nodes);
    if depth > 30 || nodes > 150_000 {
        return Err(String::from("a page jsonSafeClone may truncate"));
    }
    let info = super::params::page_info(query.take, query.skip, super::params::count(total));
    let mut out = Map::new();
    out.insert(String::from("pageInfo"), Value::Object(info));
    out.insert(String::from("results"), results);
    Ok(Value::Object(out))
}

/// One client's hits in the current window.
#[derive(Debug, Clone, Copy)]
struct Client {
    hits: i64,
    reset_ms: i64,
}

/// The route's `MemoryStore`.
fn store() -> &'static Mutex<HashMap<String, Client>> {
    static STORE: OnceLock<Mutex<HashMap<String, Client>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `MemoryStore.increment`: the hit count and reset time after this hit.
fn increment(key: &str, now_ms: i64) -> Client {
    let mut clients = crate::sync::lock(store());
    if clients.len() > 10_000 {
        clients.retain(|_, c| c.reset_ms > now_ms);
    }
    let client = clients.entry(key.to_owned()).or_insert(Client {
        hits: 0,
        reset_ms: now_ms + WINDOW_MS,
    });
    if client.reset_ms <= now_ms {
        client.hits = 0;
        client.reset_ms = now_ms + WINDOW_MS;
    }
    client.hits += 1;
    let snapshot = *client;
    drop(clients);
    snapshot
}

/// The hit count this request would bring the client to, without counting
/// it, so a request that goes to Node isn't counted twice.
fn peek(key: &str, now_ms: i64) -> i64 {
    crate::sync::lock(store())
        .get(key)
        .filter(|c| c.reset_ms > now_ms)
        .map_or(1, |c| c.hits + 1)
}

/// The limiter's key: `ipKeyGenerator(req.ip)`, with `trust proxy` as
/// Express set it at startup. Trusted, `req.ip` is the leftmost forwarded
/// address, else the peer's. With Node behind this server and no trust,
/// every request reaches Node from here, so all share one key.
fn limiter_key(ctx: &Ready<'_>) -> Result<String, String> {
    let trusted = ctx.state.trust_proxy_at_startup();
    if !trusted && !crate::standalone::enabled() {
        return Ok(String::from("proxy"));
    }
    let forwarded = ctx
        .req
        .headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(str::trim)
        .filter(|first| trusted && !first.is_empty());
    let ip = match forwarded {
        Some(first) => first
            .parse::<IpAddr>()
            .map_err(|_| String::from("a forwarded address that isn't an IP"))?,
        None => ctx
            .req
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|c| c.0.ip().to_canonical())
            .ok_or_else(|| String::from("no peer address"))?,
    };
    Ok(match ip {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => {
            let masked = u128::from(v6) & !((1_u128 << 72) - 1);
            format!("{}/56", Ipv6Addr::from(masked))
        }
    })
}

/// Add the legacy `X-RateLimit-*` headers.
fn rate_headers(res: &mut Response<Body>, client: Client) {
    let headers = res.headers_mut();
    let mut set = |name: &'static str, value: String| {
        if let Ok(v) = HeaderValue::from_str(&value) {
            headers.insert(name, v);
        }
    };
    set("x-ratelimit-limit", LIMIT.to_string());
    set(
        "x-ratelimit-remaining",
        (LIMIT - client.hits).max(0).to_string(),
    );
    set(
        "x-ratelimit-reset",
        ((client.reset_ms + 999).div_euclid(1000)).to_string(),
    );
}

/// The limiter's 429: `res.status(429).send(message)`.
fn too_many(client: Client, now_ms: i64) -> Response<Body> {
    let body = "Too many requests, please try again later.";
    let mut res = Response::new(Body::from(body));
    *res.status_mut() = StatusCode::TOO_MANY_REQUESTS;
    rate_headers(&mut res, client);
    let retry = ((client.reset_ms - now_ms + 999).div_euclid(1000)).max(0);
    let headers = res.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&retry.to_string()) {
        headers.insert(header::RETRY_AFTER, v);
    }
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    if let Ok(v) = HeaderValue::from_str(&crate::respond::weak_etag(body.as_bytes())) {
        headers.insert(header::ETAG, v);
    }
    res
}

/// `GET /settings/logs`.
fn logs<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(async move {
        if let Err(why) = ctx.authenticated(super::ADMIN) {
            return Outcome::forward(why);
        }
        let query = super::params::query(ctx).map_or_else(
            || parse_query(ctx.req.uri.query().unwrap_or("")).map_err(super::Fallback::from),
            |validated| validated_query(&validated),
        );
        let query = match query {
            Ok(query) => query,
            Err(why) => return Outcome::forward(why),
        };
        let key = match limiter_key(ctx) {
            Ok(key) => key,
            Err(why) => return Outcome::forward(why),
        };
        let now = crate::clock::now_millis();
        if peek(&key, now) > LIMIT {
            let client = increment(&key, now);
            return Outcome::Done(too_many(client, now));
        }
        let path = ctx
            .state
            .env
            .config_dir
            .join("logs")
            .join(".machinelogs.json");
        let text = match tokio::fs::read(&path).await {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(text) => Some(text),
                Err(_) => return Outcome::forward(String::from("a log file that isn't UTF-8")),
            },
            Err(e) => {
                tracing::error!("Something went wrong while retrieving logs: {e}");
                None
            }
        };
        let body = match text {
            Some(text) => {
                let paged = tokio::task::spawn_blocking(move || page(&text, &query)).await;
                match paged {
                    Ok(Ok(body)) => Some(body),
                    Ok(Err(why)) if why == UNPARSABLE => {
                        tracing::error!("Something went wrong while retrieving logs: {why}");
                        None
                    }
                    Ok(Err(why)) => return Outcome::forward(why),
                    Err(e) => return Outcome::forward(format!("reading logs failed: {e}")),
                }
            }
            None => None,
        };
        let now = crate::clock::now_millis();
        let client = increment(&key, now);
        if client.hits > LIMIT {
            return Outcome::Done(too_many(client, now));
        }
        let outcome = body.map_or_else(
            || ctx.error(500, "Unable to retrieve logs."),
            |body| ctx.json(&body),
        );
        match outcome {
            Outcome::Done(mut res) => {
                rate_headers(&mut res, client);
                Outcome::Done(res)
            }
            forward @ Outcome::Forward(_) => forward,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn query(raw: &str) -> Option<LogQuery> {
        parse_query(raw).ok()
    }

    #[test]
    fn query_parsing() {
        let q = query("take=10&skip=20&filter=warn&search=plex");
        assert_eq!(
            q.as_ref().map(|q| (q.take, q.skip)),
            Some((10, 20)),
            "numbers"
        );
        assert_eq!(
            q.as_ref().map(|q| q.levels.clone()),
            Some(vec!["warn", "error"]),
            "filter"
        );
        assert!(query("take=0").is_none(), "take 0");
        assert!(query("filter=fatal").is_none(), "unknown filter");
        assert!(query("search=").is_none(), "empty search");
        assert!(query("x=1").is_none(), "unknown key");
        assert!(query("take=1&take=2").is_none(), "repeated");
    }

    #[test]
    fn lines_and_pages() {
        let q = LogQuery {
            take: 1,
            skip: 0,
            levels: vec!["info", "warn", "error"],
            search: Some(String::from("RADARR")),
        };
        let text = [
            r#"{"timestamp":"t1","level":"info","label":"Radarr","message":"a"}"#,
            r#"{"timestamp":"t2","level":"debug","label":"Radarr","message":"b"}"#,
            r#"{"timestamp":"t3","level":"info","label":"x","message":"c","extra":"radarr host"}"#,
            "",
        ]
        .join("\n");
        let out = page(&text, &q).ok();
        assert_eq!(
            out,
            Some(json!({
                "pageInfo": {"pages": 2, "pageSize": 1, "results": 2, "page": 1},
                "results": [{"timestamp":"t3","level":"info","label":"x","message":"c","extra":"radarr host","data":{"extra":"radarr host"}}]
            })),
            "page"
        );
        assert_eq!(page("null", &q), Err(String::from(UNPARSABLE)), "null line");
        assert_eq!(
            page("{\"a\":", &q),
            Err(String::from(UNPARSABLE)),
            "cut short"
        );
        assert!(matches("Hello World", "o w"), "case-insensitive");
        assert_eq!(js_number(&Number::from(5)), "5", "int");
        assert!(matches("caf\u{c9}", "\u{e9}"), "non-ASCII folds");
        assert!(!matches("\u{17f}", "s"), "no fold onto ASCII");
    }

    #[test]
    fn limiter() {
        let first = increment("test-key", 1_000);
        assert_eq!((first.hits, first.reset_ms), (1, 61_000), "first hit");
        let second = increment("test-key", 2_000);
        assert_eq!((second.hits, second.reset_ms), (2, 61_000), "same window");
        let later = increment("test-key", 61_000);
        assert_eq!((later.hits, later.reset_ms), (1, 121_000), "new window");
    }
}
