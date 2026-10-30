//! express-openapi-validator 5.6.2's request validation as Node mounts it.
//!
//! It runs on `/api` with seerr-api.yml (`validateRequests: true`,
//! everything else default), together with the middlewares before it that
//! can answer first (`express.json()`), and the Express error handler that
//! renders its errors as `{ message, errors }` with `err.status`.
//!
//! [`Validator::decide`] is a pure function of the request; [`gate`] puts
//! it in front of the router.

mod ajv;
mod bodyparser;
pub mod gate;
mod iconv;
mod qs;
pub mod request;
mod spec;
pub mod yaml;

#[cfg(test)]
mod difftest;

use std::collections::HashMap;
use std::path::Path;

use anyhow::{Context, Result};
use axum::http::{HeaderMap, Method, Uri};
use regex::Regex;
use serde_json::{Map, Value};

use self::ajv::{always_valid, Ajv, AjvError};
use self::request::{has_body, js_value, node_header, parse_query, raw_query_pairs, ContentType};
use self::spec::{truthy, Operation, Route, Spec};

/// ajv-formats' fast `date` format, as the validator checks it.
#[must_use]
pub fn fast_date(text: &str) -> bool {
    ajv::fast_date(text)
}

/// ajv-formats' fast `date-time` format, as the validator checks it.
#[must_use]
pub fn fast_date_time(text: &str) -> bool {
    ajv::fast_date_time(text)
}

/// What the validator leaves for the route handlers: `req.query` and the
/// path parameters after coercion and defaults, and `req.body` (`None`
/// for `undefined`) with defaults applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Validated {
    pub query: Map<String, Value>,
    pub params: Map<String, Value>,
    pub body: Option<Value>,
}

/// Marks a [`Validated`] the validator wasn't sure is exactly Node's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unsure;

/// The only doubt about an [`Unsure`] pass: a parameter coerced to a
/// non-finite number (`Infinity`, `1e400`), which the validator left as
/// `null` where Node holds `±Infinity`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NonFiniteOnly;

/// The doubt [`NonFiniteOnly`] stands for.
pub const NON_FINITE: &str = "a parameter coerced to a non-finite number";

/// An answer Node gives before any route handler runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejection {
    pub status: u16,
    pub body: Value,
}

/// The validator's verdict on a request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// No validation applies (not under `/api`, or no spec route and not
    /// under a server base path).
    Unvalidated,
    /// Validated; the handlers run with this.
    Pass(Box<Validated>),
    /// Node answers this itself.
    Reject(Rejection),
}

/// A decision, and why it might not be exactly Node's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    pub decision: Decision,
    pub unsure: Option<String>,
}

/// The loaded spec, ready to validate requests.
#[derive(Debug)]
pub struct Validator {
    spec: Spec,
    patterns: HashMap<String, Option<Regex>>,
}

impl Validator {
    /// Read and prepare seerr-api.yml.
    ///
    /// # Errors
    ///
    /// Fails when the file can't be read or uses features not ported.
    pub fn load(path: &Path) -> Result<Self> {
        let text =
            std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        Self::from_doc(yaml::load(&text).with_context(|| format!("parsing {}", path.display()))?)
    }

    /// Prepare an already parsed document.
    ///
    /// # Errors
    ///
    /// Fails for documents using features not ported.
    pub fn from_doc(doc: Value) -> Result<Self> {
        let spec = Spec::new(doc)?;
        let mut patterns = HashMap::new();
        collect_patterns(&spec.doc, &mut patterns);
        Ok(Self { spec, patterns })
    }

    /// Whether `express.json()` would read this request's body (and so
    /// the validator needs it): JSON or form content and a body.
    #[must_use]
    pub fn needs_body(headers: &HeaderMap) -> bool {
        has_body(headers)
            && matches!(
                parser_type(headers).map(|(t, _)| t).as_deref(),
                Some("application/json" | "application/x-www-form-urlencoded")
            )
    }

    /// What Node does with this request up to its route handlers. `body`
    /// is the raw body when [`Validator::needs_body`] asked for it.
    #[must_use]
    pub fn decide(
        &self,
        method: &Method,
        uri: &Uri,
        headers: &HeaderMap,
        body: Option<&[u8]>,
    ) -> Verdict {
        let mut run = Run {
            validator: self,
            unsure: None,
            unsure_if_validated: None,
        };
        let decision = run.decide(method, uri, headers, body);
        let validated = match &decision {
            Decision::Pass(_) => true,
            Decision::Reject(r) => r.body.pointer("/errors/0/errorCode").is_some(),
            Decision::Unvalidated => false,
        };
        let unsure = if validated {
            run.unsure.or(run.unsure_if_validated)
        } else {
            run.unsure
        };
        Verdict { decision, unsure }
    }
}

fn collect_patterns(value: &Value, out: &mut HashMap<String, Option<Regex>>) {
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                if let (true, Value::String(p)) = (k == "pattern", v) {
                    let compiled = if p.contains('\\') {
                        None
                    } else {
                        Regex::new(p).ok()
                    };
                    out.insert(p.clone(), compiled);
                }
                collect_patterns(v, out);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_patterns(item, out);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
}

/// The content type as the body parsers' `type-is` check sees it.
fn parser_type(headers: &HeaderMap) -> Option<(String, Vec<(String, String)>)> {
    let header = node_header(headers, "content-type")?;
    request::strict_content_type(&header)
}

/// `{ message, errors: [{ path, message }] }` of an `HttpError`.
fn http_error(status: u16, path: &str, message: &str) -> Decision {
    let mut entry = Map::new();
    entry.insert(String::from("path"), Value::from(path));
    entry.insert(String::from("message"), Value::from(message));
    let mut body = Map::new();
    body.insert(String::from("message"), Value::from(message));
    body.insert(
        String::from("errors"),
        Value::Array(vec![Value::Object(entry)]),
    );
    Decision::Reject(Rejection {
        status,
        body: Value::Object(body),
    })
}

/// A body-parser error: `{ message }` (its `errors` is undefined).
fn parser_error(status: u16, message: &str) -> Decision {
    let mut body = Map::new();
    body.insert(String::from("message"), Value::from(message));
    Decision::Reject(Rejection {
        status,
        body: Value::Object(body),
    })
}

/// `Array.prototype.join` of an enum's values.
fn js_join(values: &[Value]) -> String {
    values
        .iter()
        .map(|v| match v {
            Value::Null => String::new(),
            Value::Array(items) => js_join(items).replace(", ", ","),
            Value::Object(_) => String::from("[object Object]"),
            other @ (Value::Bool(_) | Value::Number(_) | Value::String(_)) => {
                crate::jsval::string_of(Some(other))
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// The 400 for Ajv errors: `augmentAjvErrors`, `ajvErrorsToValidatorError`
/// and `errorsText(errors, { dataVar: 'request' })`.
fn ajv_rejection(mut errors: Vec<AjvError>) -> Decision {
    for e in &mut errors {
        if let Some(allowed) = &e.allowed_values {
            e.message = format!("{}: {}", e.message, js_join(allowed));
        }
    }
    let text = errors
        .iter()
        .map(|e| format!("request{} {}", e.instance_path, e.message))
        .collect::<Vec<_>>()
        .join(", ");
    let list = errors
        .iter()
        .map(|e| {
            let child = |name: &Option<String>| {
                name.as_ref()
                    .filter(|n| !n.is_empty())
                    .map(|n| format!("{}/{n}", e.instance_path))
            };
            let path = child(&e.missing_property)
                .or_else(|| child(&e.additional_property))
                .unwrap_or_else(|| e.instance_path.clone());
            let mut entry = Map::new();
            entry.insert(String::from("path"), Value::from(path));
            entry.insert(String::from("message"), Value::from(e.message.as_str()));
            entry.insert(
                String::from("errorCode"),
                Value::from(format!("{}.openapi.validation", e.keyword)),
            );
            Value::Object(entry)
        })
        .collect();
    let mut body = Map::new();
    body.insert(String::from("message"), Value::from(text));
    body.insert(String::from("errors"), Value::Array(list));
    Decision::Reject(Rejection {
        status: 400,
        body: Value::Object(body),
    })
}

struct Run<'v> {
    validator: &'v Validator,
    unsure: Option<String>,
    /// Doubts that only matter when the body or the coerced values reach
    /// the answer: a pass, or a schema rejection.
    unsure_if_validated: Option<String>,
}

/// `req.body` once `express.json()`/`urlencoded()` ran.
enum ParsedBody {
    Undefined,
    Json(Value),
}

impl Run<'_> {
    fn unsure(&mut self, why: &str) {
        if self.unsure.is_none() {
            self.unsure = Some(why.to_owned());
        }
    }

    fn decide(
        &mut self,
        method: &Method,
        uri: &Uri,
        headers: &HeaderMap,
        body: Option<&[u8]>,
    ) -> Decision {
        let path = uri.path();
        let mount = path.get(..4).filter(|m| m.eq_ignore_ascii_case("/api"));
        let Some(base_url) = mount.filter(|_| matches!(path.as_bytes().get(4), None | Some(b'/')))
        else {
            return Decision::Unvalidated;
        };
        let parsed = match Self::body_parser(headers, body) {
            Ok(parsed) => parsed,
            Err(rejection) => return rejection,
        };
        // `req.path` below the `/api` mount.
        let rest = path.get(4..).unwrap_or("");
        let req_path = if rest.is_empty() { "/" } else { rest };
        let Some((route, raw_params)) = self.validator.spec.lookup(path) else {
            let full = if req_path.starts_with(base_url) {
                req_path.to_owned()
            } else {
                format!("{base_url}/{req_path}")
            };
            if self
                .validator
                .spec
                .base_paths
                .iter()
                .any(|bp| full.starts_with(bp.as_str()))
            {
                return http_error(404, req_path, "not found");
            }
            return Decision::Unvalidated;
        };
        let mut params = Map::new();
        for (name, raw) in raw_params {
            match crate::jsval::decode_uri_component(&raw) {
                Some(value) => {
                    params.insert(name, Value::String(value));
                }
                None => return http_error(400, req_path, "malformed uri'"),
            }
        }
        let Some(op) = route.operation(method.as_str()) else {
            return http_error(
                405,
                req_path,
                &format!("{} method not allowed", method.as_str()),
            );
        };
        if let Some(why) = &op.unsupported {
            let why = why.clone();
            self.unsure(&why);
        }
        let query_raw = uri.query().unwrap_or("");
        let query = parse_query(query_raw);
        if let Some(rejection) = self.security(route, op, headers, &query) {
            return rejection;
        }
        let body_schema = match Self::body_schema(route, op, headers) {
            Ok(schema) => schema,
            Err(rejection) => return rejection,
        };
        let body = match parsed {
            ParsedBody::Undefined => None,
            ParsedBody::Json(v) => Some(v),
        };
        self.validate(op, query_raw, query, params, body, &body_schema)
    }

    /// `express.json()` and `express.urlencoded()`, which run first.
    fn body_parser(headers: &HeaderMap, body: Option<&[u8]>) -> Result<ParsedBody, Decision> {
        if !has_body(headers) {
            return Ok(ParsedBody::Undefined);
        }
        let Some((media, params)) = parser_type(headers) else {
            return Ok(ParsedBody::Undefined);
        };
        let kind = match media.as_str() {
            "application/json" => bodyparser::Kind::Json,
            "application/x-www-form-urlencoded" => bodyparser::Kind::Form,
            _ => return Ok(ParsedBody::Undefined),
        };
        // `getCharset`: the parameter, lower-cased; empty counts as none.
        let charset = params
            .iter()
            .find(|(k, _)| k == "charset")
            .map(|(_, v)| v.to_lowercase())
            .filter(|v| !v.is_empty());
        match bodyparser::read(kind, charset.as_deref(), headers, body.unwrap_or_default()) {
            Ok(bodyparser::Parsed::Json(value)) => Ok(ParsedBody::Json(js_value(value))),
            Ok(bodyparser::Parsed::Form(value)) => Ok(ParsedBody::Json(value)),
            Err((status, message)) => Err(parser_error(status, &message)),
        }
    }

    /// The security middleware with its default handlers: a requirement
    /// passes when every scheme it names finds its credential.
    fn security(
        &mut self,
        route: &Route,
        op: &Operation,
        headers: &HeaderMap,
        query: &Map<String, Value>,
    ) -> Option<Decision> {
        let doc = &self.validator.spec.doc;
        let securities = op.schema.get("security").or_else(|| doc.get("security"))?;
        let requirements = securities.as_array().filter(|s| !s.is_empty())?;
        let schemes = doc.pointer("/components/securitySchemes");
        let mut first_failure: Option<String> = None;
        for requirement in requirements {
            let Some(names) = requirement.as_object() else {
                self.unsure("a security requirement that isn't an object");
                continue;
            };
            let mut all = true;
            for name in names.keys() {
                let scheme = schemes.and_then(|s| s.get(name));
                match self.credential(scheme, headers, query) {
                    Ok(()) => {}
                    Err(message) => {
                        all = false;
                        first_failure.get_or_insert(message);
                    }
                }
            }
            if all {
                return None;
            }
        }
        let message = first_failure.unwrap_or_else(|| String::from("unauthorized"));
        // `servers` carries the plugin mount (`pluginApiSpec`).
        let path = format!("{}{}", crate::runtime::api_server_prefix(), route.open_api);
        Some(http_error(401, &path, &message))
    }

    fn credential(
        &mut self,
        scheme: Option<&Value>,
        headers: &HeaderMap,
        query: &Map<String, Value>,
    ) -> Result<(), String> {
        let Some(scheme) = scheme else {
            self.unsure("a security scheme that isn't declared");
            return Err(String::from("unauthorized"));
        };
        let field = |k: &str| scheme.get(k).and_then(Value::as_str).unwrap_or("");
        let name = field("name");
        match (field("type"), field("in")) {
            ("apiKey", "header") => match node_header(headers, &name.to_ascii_lowercase()) {
                Some(v) if !v.is_empty() => Ok(()),
                Some(_) | None => Err(format!("'{name}' header required")),
            },
            ("apiKey", "cookie") => {
                let header = node_header(headers, "cookie");
                match header.as_deref().and_then(|h| request::cookie_raw(h, name)) {
                    Some(v) if !v.is_empty() => Ok(()),
                    Some(_) | None => Err(format!("cookie '{name}' required")),
                }
            }
            ("apiKey", "query") => {
                if query.get(name).is_some_and(truthy) {
                    Ok(())
                } else {
                    Err(format!("query parameter '{name}' required"))
                }
            }
            _ => {
                self.unsure("a security scheme type not ported");
                Ok(())
            }
        }
    }

    /// `BodySchemaParser.toSchema`: the schema for the request's content
    /// type, or the 415.
    fn body_schema(route: &Route, op: &Operation, headers: &HeaderMap) -> Result<Value, Decision> {
        let empty = Value::Object(Map::new());
        let Some(request_body) = op.schema.get("requestBody") else {
            return Ok(empty);
        };
        let Some(content) = request_body.get("content").and_then(Value::as_object) else {
            return Ok(empty);
        };
        let header = node_header(headers, "content-type");
        let ct = ContentType::parse(header.as_deref());
        let normalized = ct.normalize();
        let pick = |schema: &Value| {
            schema
                .get("schema")
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new()))
        };
        for (key, media) in content {
            if ContentType::parse(Some(key)).normalize() == normalized {
                return Ok(pick(media));
            }
        }
        let equivalents = ct.equivalents();
        for (key, media) in content {
            if ContentType::parse(Some(key))
                .normalize()
                .is_some_and(|n| equivalents.contains(&n))
            {
                return Ok(pick(media));
            }
        }
        let mut keys: Vec<&String> = content.keys().collect();
        keys.sort_by(|a, b| b.encode_utf16().cmp(a.encode_utf16()));
        for key in keys {
            let Some(media) = content.get(key) else {
                continue;
            };
            if key == "*/*" {
                return Ok(pick(media));
            }
            if let Some(kind) = key
                .strip_suffix("/*")
                .filter(|k| !k.is_empty() && k.bytes().all(|b| b.is_ascii_lowercase()))
            {
                if normalized
                    .as_ref()
                    .is_some_and(|n| n.len() > kind.len() + 1 && n.starts_with(&format!("{kind}/")))
                {
                    return Ok(pick(media));
                }
            }
        }
        if normalized.is_none() && request_body.get("required") == Some(&Value::Bool(false)) {
            return Ok(empty);
        }
        let shown = normalized.unwrap_or_else(|| String::from("undefined"));
        Err(http_error(
            415,
            &route.express,
            &format!("unsupported media type {shown}"),
        ))
    }

    /// The request middleware: parameter mutation, unknown and empty
    /// query parameters, then the parameter and body schemas.
    fn validate(
        &mut self,
        op: &Operation,
        query_raw: &str,
        mut query: Map<String, Value>,
        mut params: Map<String, Value>,
        body: Option<Value>,
        body_schema: &Value,
    ) -> Decision {
        request::bracket_notation(&mut query);
        let raw = raw_query_pairs(query_raw);
        for param in &op.parameters {
            if param.get("in").and_then(Value::as_str) != Some("query") {
                continue;
            }
            let name = param.get("name").and_then(Value::as_str).unwrap_or("");
            let reserved = raw
                .iter()
                .filter(|(k, _)| k == name)
                .flat_map(|(_, vs)| vs.iter().flatten())
                .any(|v| request::has_reserved(v));
            if reserved {
                return http_error(
                    400,
                    &format!("/query/{name}"),
                    &format!("Parameter '{name}' must be url encoded. Its value may not contain reserved characters."),
                );
            }
            let is_array = op
                .query
                .pointer(&format!("/properties/{}/type", ajv::escape_pointer(name)))
                .and_then(Value::as_str)
                == Some("array");
            if is_array {
                if let Some(v) = query.get_mut(name) {
                    if truthy(v) && !v.is_array() {
                        let one = std::mem::take(v);
                        *v = Value::Array(vec![one]);
                    }
                }
            }
        }
        let props = op.query.get("properties").and_then(Value::as_object);
        let open = props.is_some_and(|p| {
            p.values().any(|s| {
                s.get("type").and_then(Value::as_str) == Some("object")
                    && s.get("additionalProperties").is_some_and(truthy)
            })
        });
        if !open {
            for (key, value) in &query {
                if !props.is_some_and(|p| p.contains_key(key)) {
                    return http_error(
                        400,
                        &format!("/query/{key}"),
                        &format!("Unknown query parameter '{key}'"),
                    );
                }
                if !op.allow_empty.contains(key) && value.as_str() == Some("") {
                    return http_error(
                        400,
                        &format!("/query/{key}"),
                        &format!("Empty value found for query parameter '{key}'"),
                    );
                }
            }
        }
        let doc = &self.validator.spec.doc;
        let patterns = &self.validator.patterns;
        let mut general = Ajv::new(doc, patterns, true);
        let mut query_value = Value::Object(query);
        let mut params_value = Value::Object(params);
        if general.validate(&op.query, &mut query_value, "/query", false) {
            general.validate(&op.params, &mut params_value, "/params", false);
        }
        let mut body_ajv = Ajv::new(doc, patterns, false);
        let mut body = body;
        let binary = body_schema.get("format").and_then(Value::as_str) == Some("binary");
        let required = !binary && body_schema.get("required").is_some_and(truthy);
        match body.as_mut() {
            None if required => {
                body_ajv.errors.push(AjvError {
                    instance_path: String::new(),
                    keyword: String::from("required"),
                    message: String::from("must have required property 'body'"),
                    missing_property: Some(String::from("body")),
                    additional_property: None,
                    allowed_values: None,
                });
            }
            Some(value) if !binary && !always_valid(body_schema) => {
                body_ajv.validate(body_schema, value, "/body", false);
            }
            None | Some(_) => {}
        }
        for why in [general.unsure.take(), body_ajv.unsure.take()]
            .into_iter()
            .flatten()
        {
            self.unsure(&why);
        }
        if general.non_finite || body_ajv.non_finite {
            self.unsure_if_validated
                .get_or_insert_with(|| String::from(NON_FINITE));
        }
        let mut errors = general.errors;
        errors.append(&mut body_ajv.errors);
        if !errors.is_empty() {
            return ajv_rejection(errors);
        }
        query = match query_value {
            Value::Object(m) => request::js_ordered(m),
            Value::Null
            | Value::Bool(_)
            | Value::Number(_)
            | Value::String(_)
            | Value::Array(_) => Map::new(),
        };
        params = match params_value {
            Value::Object(m) => m,
            Value::Null
            | Value::Bool(_)
            | Value::Number(_)
            | Value::String(_)
            | Value::Array(_) => Map::new(),
        };
        Decision::Pass(Box::new(Validated {
            query,
            params,
            body: body.map(js_value),
        }))
    }
}
