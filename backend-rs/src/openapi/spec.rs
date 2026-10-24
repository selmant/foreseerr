//! seerr-api.yml after the validator's start-up work: the route table
//! (`OpenApiSpecLoader`), the schema preprocessing that changes request
//! validation (`SchemaPreprocessor`: path-level parameters, `readOnly`
//! properties dropped from `required`, `date`/`date-time` strings typed by
//! `x-eov-type`), and per operation the parameter schemas the request
//! validator builds (`ParametersSchemaParser`).

use std::collections::HashSet;

use anyhow::{anyhow, bail, Result};
use serde_json::{Map, Value};

/// One operation's request side.
#[derive(Debug)]
pub(super) struct Operation {
    /// `paths[key][method]`, preprocessed.
    pub(super) schema: Value,
    /// The parameters, `$ref`s resolved, path-level ones appended.
    pub(super) parameters: Vec<Value>,
    /// `{ type: 'object', properties, required }` for the query, or `{}`.
    pub(super) query: Value,
    /// The same for the path parameters.
    pub(super) params: Value,
    /// Query parameters declared with `allowEmptyValue`.
    pub(super) allow_empty: Vec<String>,
    /// Why this operation can't be validated exactly, if it can't.
    pub(super) unsupported: Option<String>,
}

/// One path of the spec as an Express route.
#[derive(Debug)]
pub(super) struct Route {
    /// `/api/v1/movie/:movieId`.
    pub(super) express: String,
    /// `/api/v1/movie/{movieId}`.
    pub(super) open_api: String,
    segments: Vec<Segment>,
    /// Method (lower case) to operation, in the spec's order.
    pub(super) methods: Vec<(String, Operation)>,
}

#[derive(Debug)]
enum Segment {
    Text(String),
    Param(String),
}

/// The loaded spec.
#[derive(Debug)]
pub(super) struct Spec {
    pub(super) doc: Value,
    /// Routes in the validator's lookup order.
    pub(super) routes: Vec<Route>,
    /// The servers' base paths, e.g. `/api/v1/`.
    pub(super) base_paths: Vec<String>,
}

const HTTP_METHODS: [&str; 8] = [
    "get", "put", "post", "delete", "options", "head", "patch", "trace",
];

impl Spec {
    /// Build the validator's view of an `OpenAPI` 3.0 document.
    ///
    /// # Errors
    ///
    /// Fails for documents using features this port doesn't reproduce
    /// (server variables in the path, `$ref`'d path items, non-3.0 specs).
    pub(super) fn new(mut doc: Value) -> Result<Self> {
        let version = doc.get("openapi").and_then(Value::as_str).unwrap_or("");
        if !version.starts_with("3.0.") {
            bail!("only OpenAPI 3.0 specs are supported, not {version}");
        }
        let base_paths = base_paths(&doc)?;
        preprocess(&mut doc)?;
        let paths = doc
            .get("paths")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("the spec has no paths"))?;
        let mut routes = Vec::new();
        for base in &base_paths {
            let bp = base.trim_end_matches('/');
            for (key, item) in paths {
                let item = item
                    .as_object()
                    .ok_or_else(|| anyhow!("path {key} isn't an object"))?;
                let open_api = format!("{bp}{key}");
                let mut methods = Vec::new();
                for (method, op) in item {
                    if method.starts_with("x-")
                        || matches!(method.as_str(), "parameters" | "summary" | "description")
                    {
                        continue;
                    }
                    methods.push((method.clone(), operation(&doc, op)));
                }
                routes.push(Route {
                    express: express_route(&open_api),
                    segments: segments(&open_api)?,
                    open_api,
                    methods,
                });
            }
        }
        // `sortRoutes`: `/:` sorts as `/~`, a route after the routes it
        // prefixes. That is a total order, so any sort gives Node's result.
        routes.sort_by(|a, b| route_order(&a.express, &b.express));
        let mut seen = HashSet::new();
        routes.retain(|r| seen.insert(r.express.clone()));
        Ok(Self {
            doc,
            routes,
            base_paths,
        })
    }

    /// The first route matching a raw request path, with its raw
    /// (undecoded) parameter values.
    #[must_use]
    pub(super) fn lookup(&self, path: &str) -> Option<(&Route, Vec<(String, String)>)> {
        self.routes
            .iter()
            .find_map(|r| r.matches(path).map(|p| (r, p)))
    }
}

impl Route {
    /// `pathToRegexp(expressRoute, { sensitive: false })`: literal
    /// segments compared case-insensitively, `[^/]+` for parameters, an
    /// optional trailing slash.
    fn matches(&self, path: &str) -> Option<Vec<(String, String)>> {
        let path = path
            .strip_suffix('/')
            .filter(|p| !p.is_empty() || self.segments.is_empty())
            .unwrap_or(path);
        let mut parts = path.split('/');
        if parts.next() != Some("") {
            return None;
        }
        let mut params = Vec::new();
        for segment in &self.segments {
            let part = parts.next()?;
            match segment {
                Segment::Text(text) => {
                    if !part.eq_ignore_ascii_case(text) {
                        return None;
                    }
                }
                Segment::Param(name) => {
                    if part.is_empty() {
                        return None;
                    }
                    params.push((name.clone(), part.to_owned()));
                }
            }
        }
        if parts.next().is_some() {
            return None;
        }
        Some(params)
    }

    /// The operation for a request method.
    #[must_use]
    pub(super) fn operation(&self, method: &str) -> Option<&Operation> {
        let lower = method.to_ascii_lowercase();
        self.methods
            .iter()
            .find(|(m, _)| *m == lower)
            .map(|(_, op)| op)
    }
}

fn resolve_in<'d>(doc: &'d Value, reference: &str) -> Option<&'d Value> {
    let pointer = reference.strip_prefix('#')?;
    doc.pointer(pointer)
}

fn route_order(a: &str, b: &str) -> std::cmp::Ordering {
    let a = a.replace("/:", "/~");
    let b = b.replace("/:", "/~");
    if a == b {
        return std::cmp::Ordering::Equal;
    }
    if a.starts_with(&b) {
        return std::cmp::Ordering::Less;
    }
    if b.starts_with(&a) {
        return std::cmp::Ordering::Greater;
    }
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `BasePath.findUrlPath` for each server, always ending in `/`.
fn base_paths(doc: &Value) -> Result<Vec<String>> {
    let Some(servers) = doc
        .get("servers")
        .and_then(Value::as_array)
        .filter(|s| !s.is_empty())
    else {
        return Ok(vec![String::from("/")]);
    };
    let mut out: Vec<String> = Vec::new();
    for server in servers {
        let url = server.get("url").and_then(Value::as_str).unwrap_or("");
        let start = url.find("://").map_or(0, |i| i + 3);
        let path = url
            .get(start..)
            .and_then(|rest| rest.find('/'))
            .map_or_else(
                || String::from("/"),
                |i| {
                    let path = url.get(start + i..).unwrap_or("/");
                    if path.ends_with('/') {
                        path.to_owned()
                    } else {
                        format!("{path}/")
                    }
                },
            );
        if path.contains(['{', ':', '(', ')', '*']) {
            bail!("server URL paths with variables aren't supported: {url}");
        }
        if !out.contains(&path) {
            out.push(path);
        }
    }
    Ok(out)
}

/// `toExpressParams` for the simple `{name}` segments the spec uses.
fn express_route(open_api: &str) -> String {
    let mut out = String::with_capacity(open_api.len());
    let mut rest = open_api;
    while let Some(start) = rest.find('{') {
        out.push_str(rest.get(..start).unwrap_or(""));
        let after = rest.get(start + 1..).unwrap_or("");
        if let Some(end) = after.find('}') {
            out.push(':');
            out.push_str(after.get(..end).unwrap_or(""));
            rest = after.get(end + 1..).unwrap_or("");
        } else {
            out.push_str(rest.get(start..).unwrap_or(""));
            rest = "";
        }
    }
    out.push_str(rest);
    out
}

fn segments(open_api: &str) -> Result<Vec<Segment>> {
    let mut out = Vec::new();
    for part in open_api.split('/').skip(1) {
        if let Some(name) = part.strip_prefix('{').and_then(|p| p.strip_suffix('}')) {
            if name.contains(['{', '}']) {
                bail!("unsupported path template {open_api}");
            }
            out.push(Segment::Param(name.to_owned()));
        } else if part.contains(['{', '}', ':', '*', '(', ')', '?', '+']) {
            bail!("unsupported path template {open_api}");
        } else {
            out.push(Segment::Text(part.to_owned()));
        }
    }
    Ok(out)
}

/// `dereferenceParameter`: a `$ref` names `components.parameters` by its
/// last segment.
fn dereference_parameter<'d>(doc: &'d Value, param: &'d Value) -> Option<&'d Value> {
    match param.get("$ref").and_then(Value::as_str) {
        Some(reference) => {
            let id = reference.rsplit('/').next().unwrap_or("");
            doc.pointer("/components/parameters")?.get(id)
        }
        None => Some(param),
    }
}

fn operation(doc: &Value, op: &Value) -> Operation {
    let mut unsupported = None;
    let mut parameters = Vec::new();
    let mut query = Map::new();
    let mut query_required = Vec::new();
    let mut params = Map::new();
    let mut params_required = Vec::new();
    let mut allow_empty = Vec::new();
    let empty = Vec::new();
    let list = op
        .get("parameters")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    for raw in list {
        let Some(param) = dereference_parameter(doc, raw) else {
            unsupported = Some(String::from("a parameter $ref that doesn't resolve"));
            continue;
        };
        parameters.push(param.clone());
        let name = param
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let schema = parameter_schema(doc, param).unwrap_or_else(|why| {
            unsupported = Some(why.to_owned());
            Value::Object(Map::new())
        });
        if param.get("content").is_some() || param.get("allowReserved").is_some() {
            unsupported = Some(String::from("parameter content or allowReserved"));
        }
        let style = param.get("style").and_then(Value::as_str);
        let explode = param.get("explode").and_then(Value::as_bool);
        let required = param.get("required").is_some_and(truthy);
        match param.get("in").and_then(Value::as_str) {
            Some("query") => {
                if style.is_some_and(|s| s != "form") || explode == Some(false) {
                    unsupported = Some(String::from("a query parameter style"));
                }
                if object_like(&schema) {
                    unsupported = Some(String::from("an object query parameter"));
                }
                if param.get("allowEmptyValue").is_some_and(truthy) {
                    allow_empty.push(name.clone());
                }
                query.insert(name.clone(), schema);
                if required {
                    query_required.push(Value::from(name));
                }
            }
            Some("path") => {
                params.insert(name.clone(), schema);
                if required {
                    params_required.push(Value::from(name));
                }
            }
            Some(_) | None => {
                unsupported = Some(String::from("a header or cookie parameter"));
            }
        }
    }
    Operation {
        schema: op.clone(),
        parameters,
        query: object_schema(query, query_required),
        params: object_schema(params, params_required),
        allow_empty,
        unsupported,
    }
}

/// `normalizeParameter`'s schema: the parameter's own, or the component a
/// `$ref` names.
fn parameter_schema(doc: &Value, param: &Value) -> Result<Value, &'static str> {
    let schema = param.get("schema").ok_or("a parameter without a schema")?;
    let Some(reference) = schema.get("$ref").and_then(Value::as_str) else {
        return Ok(schema.clone());
    };
    resolve_in(doc, reference)
        .filter(|target| target.get("$ref").is_none())
        .cloned()
        .ok_or("a parameter schema $ref chain")
}

/// The validator's `isObjectOrXOf`.
fn object_like(schema: &Value) -> bool {
    if schema.get("$ref").is_some() || schema.get("type").and_then(Value::as_str) == Some("object")
    {
        return true;
    }
    ["allOf", "oneOf", "anyOf"].iter().any(|k| {
        schema
            .get(*k)
            .and_then(Value::as_array)
            .is_some_and(|items| items.iter().any(object_like))
    })
}

fn object_schema(properties: Map<String, Value>, required: Vec<Value>) -> Value {
    if properties.is_empty() {
        return Value::Object(Map::new());
    }
    let mut schema = Map::new();
    schema.insert(String::from("type"), Value::from("object"));
    schema.insert(String::from("properties"), Value::Object(properties));
    if !required.is_empty() {
        schema.insert(String::from("required"), Value::Array(required));
    }
    Value::Object(schema)
}

/// JavaScript truthiness of a JSON value.
#[must_use]
pub(super) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

// ------------------------------------------------------------ preprocessing

/// `SchemaPreprocessor.preProcess()` as far as request validation sees it.
fn preprocess(doc: &mut Value) -> Result<()> {
    let component_ids: Vec<String> = doc
        .pointer("/components/schemas")
        .and_then(Value::as_object)
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    for id in &component_ids {
        let pointer = format!("/components/schemas/{}", escape(id));
        if doc.pointer(&pointer).and_then(|s| s.get("$ref")).is_some() {
            bail!("component schema {id} is a bare $ref");
        }
    }
    let mut roots: Vec<String> = component_ids
        .iter()
        .map(|id| format!("/components/schemas/{}", escape(id)))
        .collect();
    let mut body_copies: Vec<(String, String)> = Vec::new();
    let mut param_roots = Vec::new();
    let paths: Vec<String> = doc
        .get("paths")
        .and_then(Value::as_object)
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    for p in &paths {
        let item_ptr = format!("/paths/{}", escape(p));
        if doc.pointer(&item_ptr).and_then(|i| i.get("$ref")).is_some() {
            bail!("$ref'd path items aren't supported");
        }
        let methods: Vec<String> = doc
            .pointer(&item_ptr)
            .and_then(Value::as_object)
            .map(|m| {
                m.keys()
                    .filter(|k| HTTP_METHODS.contains(&k.as_str()))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        for m in methods {
            let op_ptr = format!("{item_ptr}/{m}");
            path_level_parameters(doc, &item_ptr, &op_ptr);
            if doc.pointer(&format!("{op_ptr}/requestBody/$ref")).is_some() {
                bail!("$ref'd request bodies aren't supported");
            }
            let content: Vec<String> = doc
                .pointer(&format!("{op_ptr}/requestBody/content"))
                .and_then(Value::as_object)
                .map(|c| c.keys().cloned().collect())
                .unwrap_or_default();
            for ct in content {
                let schema_ptr = format!("{op_ptr}/requestBody/content/{}/schema", escape(&ct));
                match doc.pointer(&schema_ptr) {
                    None => {}
                    Some(s) => match s.get("$ref").and_then(Value::as_str) {
                        // `resolveSchema` swaps the `$ref` for the component.
                        Some(reference) => {
                            let target = reference.strip_prefix('#').unwrap_or("").to_owned();
                            roots.push(target.clone());
                            body_copies.push((schema_ptr, target));
                        }
                        None => roots.push(schema_ptr),
                    },
                }
            }
            let count = doc
                .pointer(&format!("{op_ptr}/parameters"))
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            for i in 0..count {
                let param_ptr = format!("{op_ptr}/parameters/{i}");
                let Some(param) = doc.pointer(&param_ptr) else {
                    continue;
                };
                if param.get("$ref").is_some() {
                    continue;
                }
                let Some(schema) = param.get("schema") else {
                    continue;
                };
                if schema.get("items").is_some() || schema.get("$ref").is_some() {
                    continue;
                }
                param_roots.push(format!("{param_ptr}/schema"));
            }
        }
    }
    roots.extend(param_roots);
    let mut seen = HashSet::new();
    for root in roots {
        traverse(doc, None, &root, "", &mut seen);
    }
    for (at, from) in body_copies {
        let copy = doc
            .pointer(&from)
            .cloned()
            .ok_or_else(|| anyhow!("{from} doesn't resolve"))?;
        if let Some(slot) = doc.pointer_mut(&at) {
            *slot = copy;
        }
    }
    Ok(())
}

fn escape(segment: &str) -> String {
    segment.replace('~', "~0").replace('/', "~1")
}

/// `preprocessPathLevelParameters`: path-item parameters appended to the
/// operation's unless it declares one with the same name or `$ref`.
fn path_level_parameters(doc: &mut Value, item_ptr: &str, op_ptr: &str) {
    let Some(shared) = doc
        .pointer(&format!("{item_ptr}/parameters"))
        .and_then(Value::as_array)
        .filter(|p| !p.is_empty())
        .cloned()
    else {
        return;
    };
    let Some(op) = doc.pointer_mut(op_ptr).and_then(Value::as_object_mut) else {
        return;
    };
    let list = op
        .entry("parameters")
        .or_insert_with(|| Value::Array(Vec::new()));
    let Some(list) = list.as_array_mut() else {
        return;
    };
    for param in shared {
        let same = |p: &Value| {
            let field = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
            (field(p, "name").is_some() && field(p, "name") == field(&param, "name"))
                || (field(p, "$ref").is_some() && field(p, "$ref") == field(&param, "$ref"))
        };
        if !list.iter().any(same) {
            list.push(param);
        }
    }
}

/// `traverseSchemas`' `recurse`, visiting with `handleSerDes` and
/// `handleReadonly`.
fn traverse(
    doc: &mut Value,
    parent: Option<&str>,
    node: &str,
    last: &str,
    seen: &mut HashSet<String>,
) {
    let Some(schema) = doc.pointer(node).cloned() else {
        return;
    };
    if !schema.is_object() || !seen.insert(node.to_owned()) {
        return;
    }
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        visit(doc, parent, node, last);
        let target = reference.strip_prefix('#').unwrap_or("").to_owned();
        let target_last = reference.rsplit('/').next().unwrap_or("").to_owned();
        traverse(doc, Some(node), &target, &target_last, seen);
        return;
    }
    visit(doc, parent, node, last);
    let Some(schema) = doc.pointer(node).cloned() else {
        return;
    };
    for key in ["allOf", "oneOf", "anyOf"] {
        if let Some(items) = schema.get(key).and_then(Value::as_array) {
            for i in 0..items.len() {
                traverse(
                    doc,
                    Some(node),
                    &format!("{node}/{key}/{i}"),
                    &i.to_string(),
                    seen,
                );
            }
            return;
        }
    }
    if schema.get("type").and_then(Value::as_str) == Some("array")
        && schema.get("items").is_some_and(truthy)
    {
        traverse(doc, Some(node), &format!("{node}/items"), "items", seen);
    } else if let Some(props) = schema
        .get("properties")
        .filter(|p| truthy(p))
        .and_then(Value::as_object)
    {
        for id in props.keys() {
            traverse(
                doc,
                Some(node),
                &format!("{node}/properties/{}", escape(id)),
                id,
                seen,
            );
        }
    } else if schema.get("additionalProperties").is_some_and(truthy) {
        traverse(
            doc,
            Some(node),
            &format!("{node}/additionalProperties"),
            "additionalProperties",
            seen,
        );
    }
}

fn visit(doc: &mut Value, parent: Option<&str>, node: &str, last: &str) {
    // handleSerDes for the request side: `type` moves to `x-eov-type`.
    if let Some(schema) = doc.pointer_mut(node).and_then(Value::as_object_mut) {
        let serdes = schema.get("type").and_then(Value::as_str) == Some("string")
            && schema
                .get("format")
                .and_then(Value::as_str)
                .is_some_and(|f| f == "date" || f == "date-time");
        if serdes {
            schema.insert(String::from("x-eov-type"), Value::from("string"));
            if schema.contains_key("nullable") {
                schema.insert(
                    String::from("type"),
                    serde_json::json!(["string", "number", "boolean", "object", "array"]),
                );
            } else {
                schema.shift_remove("type");
            }
        }
    }
    // handleReadonly: a read-only property is no longer required.
    let read_only = doc
        .pointer(node)
        .and_then(|s| s.get("readOnly"))
        .is_some_and(truthy);
    let Some(parent) = parent.filter(|_| read_only) else {
        return;
    };
    let Some(parent) = doc.pointer_mut(parent).and_then(Value::as_object_mut) else {
        return;
    };
    let Some(required) = parent.get_mut("required").and_then(Value::as_array_mut) else {
        return;
    };
    if let Some(i) = required.iter().position(|r| r.as_str() == Some(last)) {
        required.remove(i);
        if required.is_empty() {
            parent.shift_remove("required");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_sort_static_before_params() {
        let mut routes = vec!["/a/:id", "/a/b", "/a", "/a/:id/c", "/b"];
        routes.sort_by(|a, b| route_order(a, b));
        assert_eq!(
            routes,
            vec!["/a/b", "/a/:id/c", "/a/:id", "/a", "/b"],
            "sortRoutes"
        );
    }

    #[test]
    fn express_routes_and_matching() {
        assert_eq!(
            express_route("/api/v1/user/{id}/x"),
            "/api/v1/user/:id/x",
            "params"
        );
        let route = Route {
            express: String::from("/api/v1/user/:id"),
            open_api: String::from("/api/v1/user/{id}"),
            segments: segments("/api/v1/user/{id}").unwrap_or_default(),
            methods: Vec::new(),
        };
        assert!(
            route.matches("/API/v1/User/5/").is_some(),
            "case and trailing slash"
        );
        assert!(route.matches("/api/v1/user/5//").is_none(), "two slashes");
        assert!(route.matches("/api/v1/user/").is_none(), "empty param");
        assert_eq!(
            route
                .matches("/api/v1/user/%31")
                .map(|p| p.into_iter().map(|(_, v)| v).collect::<Vec<_>>()),
            Some(vec![String::from("%31")]),
            "raw value"
        );
    }
}
