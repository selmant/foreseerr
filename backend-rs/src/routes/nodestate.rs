//! Pieces the ported settings routes share.
//!
//! Calls to Node's `/internal` routes for process state, the request-body
//! checks Node's `OpenAPI` validator makes, and JavaScript object semantics
//! (key order, strict equality, `jsonSafeClone`).

use std::future::Future;
use std::ops::ControlFlow;
use std::pin::Pin;

use anyhow::{Context, Result};
use serde_json::{Map, Value};

use super::{Outcome, Ready};
use crate::db::Bind;

/// What a handler returns.
pub(super) type NativeFut<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// The admin guard every `/settings` route has, plus "no query string".
pub(super) fn admin(ctx: &Ready<'_>) -> Result<(), super::Fallback> {
    ctx.no_query()?;
    ctx.authenticated(super::ADMIN).map(|_| ())
}

/// One call to Node's `/internal{path}` with the API key; the status and
/// the JSON answer (null when empty).
///
/// # Errors
///
/// Fails when Node can't be reached or answers something that isn't JSON.
pub(super) async fn node_call(
    ctx: &Ready<'_>,
    method: axum::http::Method,
    path: &str,
    body: Option<&Value>,
) -> Result<(u16, Value)> {
    if super::procstate::in_process(path) {
        let answer = crate::standalone::internal::call(ctx.state, &method, path, body).await;
        return Ok((answer.status, answer.body));
    }
    let url = format!(
        "{}/internal{path}",
        ctx.state.env.node_url.trim_end_matches('/')
    );
    let mut request = ctx
        .state
        .internal
        .request(method, url)
        .header("X-API-Key", ctx.settings.api_key());
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request
        .send()
        .await
        .with_context(|| format!("calling Node's /internal{path}"))?;
    let status = response.status().as_u16();
    let bytes = response
        .bytes()
        .await
        .with_context(|| format!("reading Node's /internal{path}"))?;
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .with_context(|| format!("Node's /internal{path} is not JSON"))?
    };
    Ok((status, crate::tmdb::js_numbers(value)))
}

/// The request's JSON object body, when `express.json()` would have parsed
/// one: a JSON content type and a body that is present. Without it Express
/// leaves `req.body` undefined, which the validator or the handler treats
/// in ways not reproduced here.
pub(super) fn object_body<'a>(ctx: &'a Ready<'_>) -> Result<&'a Map<String, Value>, String> {
    if ctx.validated().is_some() {
        // The validator ran body-parser's `hasBody`: an empty body with a
        // length is `{}`, no body at all leaves `req.body` undefined.
        return match ctx.body.as_ref() {
            None => Err(String::from(
                "no JSON body; Express leaves req.body undefined",
            )),
            Some(Value::Object(map)) if !has_dunder(&Value::Object(map.clone())) => Ok(map),
            Some(Value::Object(_)) => Err(String::from("a body key starting with __")),
            Some(_) => Err(String::from("a body that isn't a JSON object")),
        };
    }
    let headers = &ctx.req.headers;
    let json_type = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|t| t.split(';').next())
        .is_some_and(|t| t.trim().eq_ignore_ascii_case("application/json"));
    let has_body = headers
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .map_or_else(
            || headers.contains_key(axum::http::header::TRANSFER_ENCODING),
            |len| len.trim() != "0",
        );
    if !json_type || !has_body {
        return Err(String::from(
            "no JSON body; Express leaves req.body undefined",
        ));
    }
    match ctx.body.as_ref() {
        Some(Value::Object(map)) => {
            if has_dunder(&Value::Object(map.clone())) {
                Err(String::from("a body key starting with __"))
            } else {
                Ok(map)
            }
        }
        _ => Err(String::from("a body that isn't a JSON object")),
    }
}

/// [`object_body`] for a handler that reads an undefined `req.body` as
/// `{}` (`Object.assign(x, undefined)`, `req.body ?? {}`).
pub(super) fn object_body_or_empty<'a>(
    ctx: &'a Ready<'_>,
) -> Result<&'a Map<String, Value>, String> {
    static EMPTY: std::sync::LazyLock<Map<String, Value>> = std::sync::LazyLock::new(Map::new);
    if ctx.validated().is_some() && ctx.body.is_none() {
        return Ok(&EMPTY);
    }
    object_body(ctx)
}

/// A JSON schema type as the validator checks it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Ty {
    Str,
    Num,
    Bool,
}

/// One property of a request schema.
#[derive(Debug, Clone, Copy)]
pub(super) struct Field {
    pub(super) name: &'static str,
    pub(super) ty: Ty,
    pub(super) nullable: bool,
    pub(super) required: bool,
}

/// A required, non-nullable property.
pub(super) const fn req(name: &'static str, ty: Ty) -> Field {
    Field {
        name,
        ty,
        nullable: false,
        required: true,
    }
}

/// An optional, non-nullable property.
pub(super) const fn opt(name: &'static str, ty: Ty) -> Field {
    Field {
        name,
        ty,
        nullable: false,
        required: false,
    }
}

/// An optional, nullable property.
pub(super) const fn nullable(name: &'static str, ty: Ty) -> Field {
    Field {
        name,
        ty,
        nullable: true,
        required: false,
    }
}

/// Whether the validator accepts `body` for a schema with `fields` (extra
/// properties allowed) and `read_only` properties (refused in requests).
pub(super) fn fits(body: &Map<String, Value>, fields: &[Field], read_only: &[&str]) -> bool {
    if read_only.iter().any(|k| body.contains_key(*k)) {
        return false;
    }
    fields.iter().all(|f| match body.get(f.name) {
        None => !f.required,
        Some(Value::Null) => f.nullable,
        Some(v) => matches!(
            (f.ty, v),
            (Ty::Str, Value::String(_)) | (Ty::Num, Value::Number(_)) | (Ty::Bool, Value::Bool(_))
        ),
    })
}

/// Whether any object key, at any depth, starts with `__`: `jsonSafeClone`
/// drops those and `__proto__` behaves specially, so such bodies are Node's.
pub(super) fn has_dunder(value: &Value) -> bool {
    match value {
        Value::Object(map) => map
            .iter()
            .any(|(k, v)| k.starts_with("__") || has_dunder(v)),
        Value::Array(items) => items.iter().any(has_dunder),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => false,
    }
}

/// An array-index key, which JavaScript objects list first, ascending.
pub(super) fn is_index_key(key: &str) -> bool {
    key == "0"
        || (!key.is_empty()
            && !key.starts_with('0')
            && key.len() <= 10
            && key.bytes().all(|b| b.is_ascii_digit())
            && key.parse::<u64>().is_ok_and(|n| n < 4_294_967_295))
}

/// An object's keys in JavaScript property order: index keys ascending,
/// then the rest in insertion order.
pub(super) fn js_key_order(map: Map<String, Value>) -> Map<String, Value> {
    if !map.keys().any(|k| is_index_key(k)) {
        return map;
    }
    let (mut index, rest): (Vec<_>, Vec<_>) = map.into_iter().partition(|(k, _)| is_index_key(k));
    index.sort_by_key(|(k, _)| k.parse::<u64>().unwrap_or(u64::MAX));
    index.into_iter().chain(rest).collect()
}

/// A parsed upstream answer as Node would send it on: JavaScript key order
/// at every level and `jsonSafeClone`'s dropping of `__` keys.
pub(super) fn json_safe(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(js_key_order(
            map.into_iter()
                .filter(|(k, _)| !k.starts_with("__"))
                .map(|(k, v)| (k, json_safe(v)))
                .collect(),
        )),
        Value::Array(items) => Value::Array(items.into_iter().map(json_safe).collect()),
        other @ (Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)) => other,
    }
}

/// JavaScript `===` between two possibly-undefined JSON values. Objects and
/// arrays are distinct references, so never equal.
pub(super) fn js_strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) | (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        _ => false,
    }
}

/// `Object.assign(target, source)`: a shallow copy of every key, existing
/// keys keeping their place.
pub(super) fn assign(target: &mut Map<String, Value>, source: &Map<String, Value>) {
    for (k, v) in source {
        target.insert(k.clone(), v.clone());
    }
}

/// The keys of `source` named in `keys`, in that order, absent ones left
/// out (as `undefined` would be).
pub(super) fn pick(source: &Value, keys: &[&str]) -> Map<String, Value> {
    let mut out = Map::new();
    for key in keys {
        if let Some(v) = source.get(*key) {
            out.insert((*key).to_owned(), v.clone());
        }
    }
    out
}

/// The raw path segment `depth` places from the end.
pub(super) fn raw_segment<'a>(ctx: &'a Ready<'_>, depth: usize) -> &'a str {
    ctx.req.uri.path().rsplit('/').nth(depth).unwrap_or("")
}

/// `decodeURIComponent` of a path segment as Express decodes parameters;
/// none when it isn't valid (Express answers 400 itself).
pub(super) fn decode_segment(raw: &str) -> Option<String> {
    if !raw.contains('%') {
        return Some(raw.to_owned());
    }
    let mut out = Vec::with_capacity(raw.len());
    let mut bytes = raw.bytes();
    while let Some(b) = bytes.next() {
        if b != b'%' {
            out.push(b);
            continue;
        }
        let hex = [bytes.next()?, bytes.next()?];
        let digit = |c: u8| char::from(c).to_digit(16);
        out.push(u8::try_from(digit(hex[0])? * 16 + digit(hex[1])?).ok()?);
    }
    String::from_utf8(out).ok()
}

/// `String.prototype.trim`: JavaScript's white space and line terminators
/// (which include U+FEFF but not U+0085).
pub(super) fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

/// The admin account (`id = 1`) with the named columns, or none.
///
/// # Errors
///
/// Fails on database errors.
pub(super) async fn admin_columns(
    ctx: &Ready<'_>,
    columns: &[&str],
) -> Result<Option<Map<String, Value>>> {
    let list: Vec<String> = columns.iter().map(|c| format!("\"{c}\"")).collect();
    let sql = format!(
        "SELECT {} FROM \"user\" WHERE \"user\".\"id\" = ?1",
        list.join(", ")
    );
    let rows = ctx.state.db.rows(&sql, &[Bind::Int(1)]).await?;
    Ok(rows.into_iter().next())
}

/// Run futures concurrently (as `Promise.all` does) and collect their
/// results in input order.
pub(super) async fn join_ordered<T, F>(futures: Vec<F>) -> Vec<T>
where
    T: Send + 'static,
    F: Future<Output = T> + Send + 'static,
{
    let mut set = tokio::task::JoinSet::new();
    let count = futures.len();
    for (i, fut) in futures.into_iter().enumerate() {
        set.spawn(async move { (i, fut.await) });
    }
    let mut slots: Vec<Option<T>> = std::iter::repeat_with(|| None).take(count).collect();
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok((i, value)) => {
                if let Some(slot) = slots.get_mut(i) {
                    *slot = Some(value);
                }
            }
            Err(e) => tracing::error!("a concurrent settings task failed: {e}"),
        }
    }
    slots.into_iter().flatten().collect()
}

/// One change made to the latest settings and saved (see
/// [`Ready::mutate_settings`]); an `Err` from `change` is answered and
/// nothing is written.
pub(super) async fn mutate<T>(
    ctx: &Ready<'_>,
    change: impl FnOnce(&mut Value) -> Result<T, Box<Outcome>>,
) -> Result<T, Outcome> {
    let flow = ctx
        .mutate_settings(|doc| match change(doc) {
            Ok(out) => ControlFlow::Continue(out),
            Err(outcome) => ControlFlow::Break(outcome),
        })
        .await;
    match flow {
        Ok(ControlFlow::Continue(out)) => Ok(out),
        Ok(ControlFlow::Break(outcome)) => Err(*outcome),
        Err(e) => {
            tracing::error!("saving settings failed: {e:#}");
            Err(ctx.error(500, "Unable to save settings."))
        }
    }
}

/// How a third-party GET ended, in axios's terms.
#[derive(Debug)]
pub(super) enum Upstream {
    /// A 2xx whose body parsed as JSON (JavaScript key order, `__` keys
    /// dropped, numbers as JavaScript prints them).
    Json(Value),
    /// A 2xx whose body isn't JSON: axios hands back the text.
    NotJson,
    /// A non-2xx answer: `e.response.status`.
    Status(u16),
    /// No answer at all: `e.response` is undefined.
    Network(reqwest::Error),
}

/// Send a GET and classify the result as axios would.
pub(super) async fn upstream_get(request: reqwest::RequestBuilder) -> Upstream {
    let response = match request.send().await {
        Ok(response) => response,
        Err(e) => return Upstream::Network(e),
    };
    let status = response.status();
    if !status.is_success() {
        return Upstream::Status(status.as_u16());
    }
    match response.bytes().await {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes).map_or(Upstream::NotJson, |v| {
            Upstream::Json(json_safe(crate::tmdb::js_numbers(v)))
        }),
        Err(e) => Upstream::Network(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn javascript_objects() {
        let v = json_safe(json!({"b": 1, "10": 2, "2": 3, "__x": 4, "c": {"1": 0, "a": 1}}));
        assert_eq!(
            serde_json::to_string(&v).unwrap_or_default(),
            r#"{"2":3,"10":2,"b":1,"c":{"1":0,"a":1}}"#,
            "index keys first, __ dropped"
        );
        assert!(
            is_index_key("0") && !is_index_key("01") && !is_index_key("4294967295"),
            "index keys"
        );
        assert!(js_strict_eq(None, None), "undefined === undefined");
        assert!(!js_strict_eq(Some(&json!({})), Some(&json!({}))), "objects");
        assert!(js_strict_eq(Some(&json!(1)), Some(&json!(1.0))), "numbers");
        assert_eq!(js_trim("\u{feff} a \u{85}"), "a \u{85}", "js trim");
        assert_eq!(decode_segment("a%20b").as_deref(), Some("a b"), "decode");
        assert!(decode_segment("%zz").is_none(), "bad escape");
    }

    /// Every route table registers into one router without a path or
    /// method conflict (axum panics on those at startup).
    #[test]
    fn routes_register_without_conflicts() {
        use axum::http::Method;
        use axum::routing::{MethodFilter, MethodRouter};
        let mut paths: Vec<(&'static str, Vec<Method>)> = Vec::new();
        let mut add = |path: &'static str, method: Method| {
            if let Some((_, methods)) = paths.iter_mut().find(|(p, _)| *p == path) {
                methods.push(method);
            } else {
                paths.push((path, vec![method]));
            }
        };
        for (path, _) in super::super::ROUTES {
            add(path, Method::GET);
        }
        for (path, _) in super::super::SETTINGS_SECTIONS {
            add(path, Method::GET);
        }
        for table in super::super::TABLES {
            for (path, method, _) in *table {
                add(path, method.clone());
            }
        }
        let mut router: axum::Router = axum::Router::new();
        for (path, methods) in paths {
            let mut methods_router: MethodRouter = MethodRouter::new();
            for method in methods {
                if let Ok(filter) = MethodFilter::try_from(method) {
                    methods_router = methods_router.on(filter, || async {});
                }
            }
            router = router.route(path, methods_router);
        }
        assert!(router.has_routes(), "routes registered");
    }

    #[test]
    fn validator_shapes() {
        let fields = [
            req("a", Ty::Str),
            nullable("b", Ty::Num),
            opt("c", Ty::Bool),
        ];
        let ok = json!({"a": "x", "b": null, "extra": 1});
        let missing = json!({"b": 1});
        let wrong = json!({"a": 1});
        let read_only = json!({"a": "x", "id": 1});
        let fit = |v: &Value| v.as_object().is_some_and(|m| fits(m, &fields, &["id"]));
        assert!(fit(&ok), "ok");
        assert!(!fit(&missing), "missing");
        assert!(!fit(&wrong), "wrong type");
        assert!(!fit(&read_only), "read only");
    }
}
