//! Ajv 8 (the `ajv-draft-04` build express-openapi-validator compiles
//! `OpenAPI` 3.0 schemas with) as an interpreter, for the options the
//! validator passes: `allErrors: false`, `useDefaults: true`,
//! `strictNumbers`, `coerceTypes` for parameters only, `ajv-formats` in
//! fast mode, and its `readOnly` and `x-eov-type` keywords.
//!
//! Ajv compiles each schema into code that stops at the first failing
//! keyword; this walks the schema in the same order. Keyword groups run
//! untyped first, then number, string, array and object keywords; inside
//! a group keywords run in the order their vocabularies registered them.
//! The two places where a composite context (`anyOf`/`oneOf` branches)
//! behaves differently are reproduced: a type error there doesn't stop the
//! untyped keywords, and defaults aren't assigned. `$ref`s to schemas
//! without nested `$ref`s are inlined (and inherit the context); others
//! are separate functions, which always run as non-composite.

use std::collections::HashMap;

use regex::Regex;
use serde_json::{Map, Value};

use super::request::is_array_index;

/// One Ajv error, with what the validator's error mapping reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct AjvError {
    pub(super) instance_path: String,
    pub(super) keyword: String,
    pub(super) message: String,
    pub(super) missing_property: Option<String>,
    pub(super) additional_property: Option<String>,
    pub(super) allowed_values: Option<Vec<Value>>,
}

const UNTYPED: [&str; 16] = [
    "$comment",
    "$ref",
    "x-eov-type",
    "type",
    "nullable",
    "const",
    "enum",
    "not",
    "anyOf",
    "oneOf",
    "allOf",
    "if",
    "then",
    "else",
    "readOnly",
    "x-eov-req-serdes",
];
const NUMBER: [&str; 6] = [
    "maximum",
    "minimum",
    "exclusiveMaximum",
    "exclusiveMinimum",
    "multipleOf",
    "format",
];
const STRING: [&str; 4] = ["maxLength", "minLength", "pattern", "format"];
const ARRAY: [&str; 6] = [
    "maxItems",
    "minItems",
    "additionalItems",
    "items",
    "uniqueItems",
    "contains",
];
const OBJECT: [&str; 8] = [
    "maxProperties",
    "minProperties",
    "required",
    "propertyNames",
    "additionalProperties",
    "dependencies",
    "properties",
    "patternProperties",
];
/// Keywords this port doesn't evaluate; a schema using one is unsure.
const UNSUPPORTED: [&str; 14] = [
    "not",
    "if",
    "then",
    "else",
    "x-eov-req-serdes",
    "exclusiveMaximum",
    "exclusiveMinimum",
    "multipleOf",
    "uniqueItems",
    "contains",
    "maxProperties",
    "minProperties",
    "propertyNames",
    "dependencies",
];

/// Names `Object.prototype` provides, which Ajv's `data.x !== undefined`
/// presence checks see on any parsed JSON object.
const PROTOTYPE_NAMES: [&str; 12] = [
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
    "__proto__",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Group {
    Number,
    String,
    Array,
    Object,
}

impl Group {
    const fn keywords(self) -> &'static [&'static str] {
        match self {
            Self::Number => &NUMBER,
            Self::String => &STRING,
            Self::Array => &ARRAY,
            Self::Object => &OBJECT,
        }
    }

    const fn name(self) -> &'static str {
        match self {
            Self::Number => "number",
            Self::String => "string",
            Self::Array => "array",
            Self::Object => "object",
        }
    }

    const fn holds(self, data: &Value) -> bool {
        matches!(
            (self, data),
            (Self::Number, Value::Number(_))
                | (Self::String, Value::String(_))
                | (Self::Array, Value::Array(_))
                | (Self::Object, Value::Object(_))
        )
    }
}

/// Whether a key is one of Ajv's rules (`RULES.all`).
fn is_rule(key: &str) -> bool {
    UNTYPED.contains(&key)
        || NUMBER.contains(&key)
        || STRING.contains(&key)
        || ARRAY.contains(&key)
        || OBJECT.contains(&key)
}

/// `alwaysValidSchema`.
#[must_use]
pub(super) fn always_valid(schema: &Value) -> bool {
    match schema {
        Value::Bool(b) => *b,
        Value::Object(o) => !o.keys().any(|k| is_rule(k)),
        Value::Null | Value::Number(_) | Value::String(_) | Value::Array(_) => true,
    }
}

/// `hasRef` from Ajv's `inlineRef`.
fn has_ref(value: &Value) -> bool {
    match value {
        Value::Object(o) => o.iter().any(|(k, v)| {
            matches!(
                k.as_str(),
                "$ref" | "$recursiveRef" | "$recursiveAnchor" | "$dynamicRef" | "$dynamicAnchor"
            ) || has_ref(v)
        }),
        Value::Array(items) => items.iter().any(has_ref),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => false,
    }
}

/// The evaluation of one compiled validator.
pub(super) struct Ajv<'s> {
    doc: &'s Value,
    patterns: &'s HashMap<String, Option<Regex>>,
    coerce: bool,
    pub(super) errors: Vec<AjvError>,
    /// Set when something wasn't reproduced exactly.
    pub(super) unsure: Option<String>,
    /// A value was coerced to an infinity, which JSON can't hold (it is
    /// kept as `null`).
    pub(super) non_finite: bool,
}

impl<'s> Ajv<'s> {
    #[must_use]
    pub(super) const fn new(
        doc: &'s Value,
        patterns: &'s HashMap<String, Option<Regex>>,
        coerce: bool,
    ) -> Self {
        Self {
            doc,
            patterns,
            coerce,
            errors: Vec::new(),
            unsure: None,
            non_finite: false,
        }
    }

    fn unsure(&mut self, why: &str) {
        if self.unsure.is_none() {
            self.unsure = Some(why.to_owned());
        }
    }

    fn error(&mut self, path: &str, keyword: &str, message: String) {
        self.errors.push(AjvError {
            instance_path: path.to_owned(),
            keyword: keyword.to_owned(),
            message,
            missing_property: None,
            additional_property: None,
            allowed_values: None,
        });
    }

    /// Validate `data` against `schema`; errors are appended. Returns
    /// whether it is valid.
    pub(super) fn validate(
        &mut self,
        schema: &Value,
        data: &mut Value,
        path: &str,
        composite: bool,
    ) -> bool {
        let obj = match schema {
            Value::Bool(true) => return true,
            Value::Bool(false) => {
                self.error(
                    path,
                    "false schema",
                    String::from("boolean schema is false"),
                );
                return false;
            }
            Value::Object(o) => o,
            Value::Null | Value::Number(_) | Value::String(_) | Value::Array(_) => {
                self.unsure("a schema that isn't an object");
                return true;
            }
        };
        if !obj.keys().any(|k| is_rule(k)) {
            return true;
        }
        if let Some(reference) = obj.get("$ref") {
            if !obj.keys().any(|k| k != "$ref" && is_rule(k)) {
                return self.reference(reference, data, path, composite);
            }
        }
        if let Some(k) = obj.keys().find(|k| UNSUPPORTED.contains(&k.as_str())) {
            let why = format!("the {k} keyword isn't ported");
            self.unsure(&why);
        }
        let Some(types) = schema_types(obj) else {
            self.unsure("a type Ajv refuses to compile");
            return true;
        };
        let coerce_to: Vec<&str> = if self.coerce {
            types
                .iter()
                .copied()
                .filter(|t| matches!(*t, "string" | "number" | "integer" | "boolean" | "null"))
                .collect()
        } else {
            Vec::new()
        };
        // A single type with keywords of its group is checked in that group.
        let deferred = coerce_to.is_empty()
            && types.len() == 1
            && types.first().is_some_and(|t| has_rules_for_type(obj, t));
        let check_types = !types.is_empty() && !deferred;
        let start = self.errors.len();
        if check_types && !types.iter().any(|t| has_type(t, data)) {
            let coerced = if coerce_to.is_empty() {
                None
            } else {
                coerce(&coerce_to, data)
            };
            match coerced {
                Some(Coerced::Value(v)) => *data = v,
                Some(Coerced::NonFinite) => {
                    self.non_finite = true;
                    *data = Value::Null;
                }
                None => {
                    self.type_error(obj, path);
                    if !composite {
                        return false;
                    }
                }
            }
        }
        if !self.untyped(obj, data, path, composite) || self.errors.len() != start {
            return false;
        }
        for group in [Group::Number, Group::String, Group::Array, Group::Object] {
            if !group.keywords().iter().any(|k| obj.contains_key(*k)) {
                continue;
            }
            if group.holds(data) {
                if group == Group::Object && !composite {
                    assign_defaults(obj, data);
                }
                if !self.group(group, obj, data, path, composite) {
                    return false;
                }
            } else if types.len() == 1 && types.first() == Some(&group.name()) && !check_types {
                self.type_error(obj, path);
                return false;
            }
            if self.errors.len() != start {
                return false;
            }
        }
        self.errors.len() == start
    }

    fn reference(
        &mut self,
        reference: &Value,
        data: &mut Value,
        path: &str,
        composite: bool,
    ) -> bool {
        let target = reference
            .as_str()
            .and_then(|r| r.strip_prefix('#'))
            .and_then(|p| self.doc.pointer(p));
        let Some(target) = target else {
            self.unsure("a $ref that doesn't resolve");
            return true;
        };
        let inline = !has_ref(target);
        self.validate(target, data, path, composite && inline)
    }

    fn type_error(&mut self, obj: &Map<String, Value>, path: &str) {
        let shown = match obj.get("type") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(items)) => items
                .iter()
                .map(|v| v.as_str().unwrap_or("").to_owned())
                .collect::<Vec<_>>()
                .join(","),
            _ => String::new(),
        };
        self.error(path, "type", format!("must be {shown}"));
    }

    fn untyped(
        &mut self,
        obj: &Map<String, Value>,
        data: &mut Value,
        path: &str,
        composite: bool,
    ) -> bool {
        if let Some(reference) = obj.get("$ref") {
            if !self.reference(reference, data, path, composite) {
                return false;
            }
        }
        // `x-eov-type` reuses the JTD `type` keyword from express-openapi-
        // validator's own copy of Ajv; its code fragments don't belong to
        // the `ajv-draft-04` instance's code generator and compile to an
        // object literal, so the check never fails.
        if let Some(expected) = obj.get("const") {
            if !js_equal(data, expected) {
                self.error(path, "const", String::from("must be equal to constant"));
                return false;
            }
        }
        if let Some(allowed) = obj.get("enum") {
            let Some(values) = allowed.as_array().filter(|v| !v.is_empty()) else {
                self.unsure("an enum Ajv refuses to compile");
                return true;
            };
            if !values.iter().any(|v| js_equal(data, v)) {
                self.errors.push(AjvError {
                    instance_path: path.to_owned(),
                    keyword: String::from("enum"),
                    message: String::from("must be equal to one of the allowed values"),
                    missing_property: None,
                    additional_property: None,
                    allowed_values: Some(values.clone()),
                });
                return false;
            }
        }
        if let Some(branches) = obj.get("anyOf") {
            if !self.any_of(branches, data, path) {
                return false;
            }
        }
        if let Some(branches) = obj.get("oneOf") {
            if !self.one_of(branches, data, path) {
                return false;
            }
        }
        if let Some(branches) = obj.get("allOf").and_then(Value::as_array) {
            for branch in branches {
                if !always_valid(branch) && !self.validate(branch, data, path, composite) {
                    return false;
                }
            }
        }
        if obj.get("readOnly").is_some_and(super::spec::truthy) {
            // The validator's keyword returns false whatever the value,
            // with its own error unless the value is null.
            let message = if data.is_null() {
                "must pass \"readOnly\" keyword validation"
            } else {
                "is read-only"
            };
            self.error(path, "readOnly", message.to_owned());
            return false;
        }
        true
    }

    fn any_of(&mut self, branches: &Value, data: &mut Value, path: &str) -> bool {
        let Some(branches) = branches.as_array() else {
            self.unsure("anyOf that isn't an array");
            return true;
        };
        if branches.iter().any(always_valid) {
            return true;
        }
        let start = self.errors.len();
        for branch in branches {
            if self.validate(branch, data, path, true) {
                self.errors.truncate(start);
                return true;
            }
        }
        self.error(path, "anyOf", String::from("must match a schema in anyOf"));
        false
    }

    fn one_of(&mut self, branches: &Value, data: &mut Value, path: &str) -> bool {
        let Some(branches) = branches.as_array() else {
            self.unsure("oneOf that isn't an array");
            return true;
        };
        let start = self.errors.len();
        let mut passing = 0;
        for branch in branches {
            let ok = always_valid(branch) || self.validate(branch, data, path, true);
            if ok {
                passing += 1;
                if passing > 1 {
                    break;
                }
            }
        }
        if passing == 1 {
            self.errors.truncate(start);
            return true;
        }
        self.error(
            path,
            "oneOf",
            String::from("must match exactly one schema in oneOf"),
        );
        false
    }

    fn group(
        &mut self,
        group: Group,
        obj: &Map<String, Value>,
        data: &mut Value,
        path: &str,
        composite: bool,
    ) -> bool {
        match group {
            Group::Number => self.number(obj, data, path),
            Group::String => self.string(obj, data, path),
            Group::Array => self.array(obj, data, path, composite),
            Group::Object => self.object(obj, data, path, composite),
        }
    }

    fn number(&mut self, obj: &Map<String, Value>, data: &Value, path: &str) -> bool {
        let n = data.as_f64().unwrap_or(f64::NAN);
        for (keyword, op) in [("maximum", "<="), ("minimum", ">=")] {
            let Some(limit) = obj.get(keyword) else {
                continue;
            };
            let Some(limit) = limit.as_f64() else {
                self.unsure("a limit that isn't a number");
                continue;
            };
            let fails = if keyword == "maximum" {
                n > limit
            } else {
                n < limit
            } || n.is_nan();
            if fails {
                let shown = crate::jsval::number_string(limit);
                self.error(path, keyword, format!("must be {op} {shown}"));
                return false;
            }
        }
        if let Some(format) = obj.get("format").and_then(Value::as_str) {
            if !matches!(
                format,
                "date" | "date-time" | "binary" | "password" | "byte"
            ) {
                let why = format!("format {format} isn't ported");
                self.unsure(&why);
            }
        }
        true
    }

    fn string(&mut self, obj: &Map<String, Value>, data: &Value, path: &str) -> bool {
        let text = data.as_str().unwrap_or("");
        let length = text.chars().count();
        for (keyword, word) in [("maxLength", "more"), ("minLength", "fewer")] {
            let Some(limit) = obj.get(keyword) else {
                continue;
            };
            let Some(limit) = limit.as_f64() else {
                self.unsure("a length that isn't a number");
                continue;
            };
            let len = f64::from(u32::try_from(length).unwrap_or(u32::MAX));
            let fails = if keyword == "maxLength" {
                len > limit
            } else {
                len < limit
            };
            if fails {
                let shown = crate::jsval::number_string(limit);
                self.error(
                    path,
                    keyword,
                    format!("must NOT have {word} than {shown} characters"),
                );
                return false;
            }
        }
        if let Some(pattern) = obj.get("pattern").and_then(Value::as_str) {
            match self.patterns.get(pattern) {
                Some(Some(re)) => {
                    if !re.is_match(text) {
                        self.error(path, "pattern", format!("must match pattern \"{pattern}\""));
                        return false;
                    }
                }
                Some(None) | None => self.unsure("a pattern not ported to Rust's regex"),
            }
        }
        if let Some(format) = obj.get("format").and_then(Value::as_str) {
            let valid = match format {
                "date" => Some(fast_date(text)),
                "date-time" => Some(fast_date_time(text)),
                "binary" | "password" => Some(true),
                "byte" => Some(text.len() % 4 == 0 && base64ish(text)),
                _ => None,
            };
            match valid {
                Some(true) => {}
                Some(false) => {
                    self.error(path, "format", format!("must match format \"{format}\""));
                    return false;
                }
                None => {
                    let why = format!("format {format} isn't ported");
                    self.unsure(&why);
                }
            }
        }
        true
    }

    fn array(
        &mut self,
        obj: &Map<String, Value>,
        data: &mut Value,
        path: &str,
        composite: bool,
    ) -> bool {
        let len = data.as_array().map_or(0, Vec::len);
        for (keyword, word) in [("maxItems", "more"), ("minItems", "fewer")] {
            let Some(limit) = obj.get(keyword).and_then(Value::as_f64) else {
                continue;
            };
            let n = f64::from(u32::try_from(len).unwrap_or(u32::MAX));
            let fails = if keyword == "maxItems" {
                n > limit
            } else {
                n < limit
            };
            if fails {
                let shown = crate::jsval::number_string(limit);
                self.error(
                    path,
                    keyword,
                    format!("must NOT have {word} than {shown} items"),
                );
                return false;
            }
        }
        if let Some(items) = obj.get("items") {
            if items.is_array() {
                self.unsure("tuple items aren't ported");
            } else if !always_valid(items) {
                if let Some(elements) = data.as_array_mut() {
                    for (i, element) in elements.iter_mut().enumerate() {
                        let child = format!("{path}/{i}");
                        if !self.validate(items, element, &child, composite) {
                            return false;
                        }
                    }
                }
            }
        }
        true
    }

    fn object(
        &mut self,
        obj: &Map<String, Value>,
        data: &mut Value,
        path: &str,
        composite: bool,
    ) -> bool {
        let Some(map) = data.as_object_mut() else {
            return true;
        };
        if let Some(required) = obj.get("required").and_then(Value::as_array) {
            for name in required {
                let name = name.as_str().unwrap_or("");
                if PROTOTYPE_NAMES.contains(&name) {
                    self.unsure("a property named like an Object.prototype member");
                }
                if !map.contains_key(name) {
                    self.errors.push(AjvError {
                        instance_path: path.to_owned(),
                        keyword: String::from("required"),
                        message: format!("must have required property '{name}'"),
                        missing_property: Some(name.to_owned()),
                        additional_property: None,
                        allowed_values: None,
                    });
                    return false;
                }
            }
        }
        let properties = obj.get("properties").and_then(Value::as_object);
        if let Some(extra) = obj.get("additionalProperties") {
            if !always_valid(extra) {
                if obj.contains_key("patternProperties") {
                    self.unsure("patternProperties aren't ported");
                }
                for key in js_keys(map) {
                    if properties.is_some_and(|p| p.contains_key(&key)) {
                        continue;
                    }
                    let child = format!("{path}/{}", escape_pointer(&key));
                    if extra == &Value::Bool(false) {
                        self.errors.push(AjvError {
                            instance_path: path.to_owned(),
                            keyword: String::from("additionalProperties"),
                            message: String::from("must NOT have additional properties"),
                            missing_property: None,
                            additional_property: Some(key),
                            allowed_values: None,
                        });
                        return false;
                    }
                    if let Some(value) = map.get_mut(&key) {
                        if !self.validate(extra, value, &child, composite) {
                            return false;
                        }
                    }
                }
            }
        }
        if let Some(properties) = properties {
            for (name, sub) in properties {
                if name == "__proto__" || always_valid(sub) {
                    continue;
                }
                if PROTOTYPE_NAMES.contains(&name.as_str()) {
                    self.unsure("a property named like an Object.prototype member");
                }
                let Some(value) = map.get_mut(name) else {
                    continue;
                };
                let child = format!("{path}/{}", escape_pointer(name));
                if !self.validate(sub, value, &child, composite) {
                    return false;
                }
            }
        }
        true
    }
}

/// `getSchemaTypes`: the declared types plus `null` for `nullable: true`;
/// `None` where Ajv throws at compile time.
fn schema_types(obj: &Map<String, Value>) -> Option<Vec<&'static str>> {
    let names = [
        "string", "number", "integer", "boolean", "null", "object", "array",
    ];
    let known = |s: &str| names.iter().copied().find(|n| *n == s);
    let mut types: Vec<&'static str> = match obj.get("type") {
        None => Vec::new(),
        Some(Value::String(s)) => vec![known(s)?],
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| v.as_str().and_then(known))
            .collect::<Option<Vec<_>>>()?,
        Some(_) => return None,
    };
    let nullable = obj.get("nullable");
    if types.contains(&"null") {
        if nullable == Some(&Value::Bool(false)) {
            return None;
        }
    } else {
        if types.is_empty() && nullable.is_some() {
            return None;
        }
        if nullable == Some(&Value::Bool(true)) {
            types.push("null");
        }
    }
    Some(types)
}

fn has_rules_for_type(obj: &Map<String, Value>, t: &str) -> bool {
    let group = match t {
        "number" => Group::Number,
        "string" => Group::String,
        "array" => Group::Array,
        "object" => Group::Object,
        _ => return false,
    };
    group.keywords().iter().any(|k| obj.contains_key(*k))
}

/// `checkDataType` with `strictNumbers` (JSON numbers are finite).
fn has_type(t: &str, data: &Value) -> bool {
    match t {
        "null" => data.is_null(),
        "array" => data.is_array(),
        "object" => data.is_object(),
        "number" => data.is_number(),
        "integer" => data.as_f64().is_some_and(|f| f.fract() == 0.0),
        "string" => data.is_string(),
        "boolean" => data.is_boolean(),
        _ => false,
    }
}

enum Coerced {
    Value(Value),
    NonFinite,
}

/// `coerceData` for `coerceTypes: true`: the first type, in declaration
/// order, whose rule accepts the value.
fn coerce(types: &[&str], data: &Value) -> Option<Coerced> {
    let number = |f: f64| {
        if f.is_finite() {
            Coerced::Value(crate::jsval::num(f))
        } else {
            Coerced::NonFinite
        }
    };
    for t in types {
        match (*t, data) {
            ("string", Value::Number(n)) => {
                let f = n.as_f64().unwrap_or(f64::NAN);
                return Some(Coerced::Value(Value::from(crate::jsval::number_string(f))));
            }
            ("string", Value::Bool(b)) => return Some(Coerced::Value(Value::from(b.to_string()))),
            ("string", Value::Null) => return Some(Coerced::Value(Value::from(""))),
            ("number" | "integer", Value::Bool(b)) => return Some(number(f64::from(u8::from(*b)))),
            ("number" | "integer", Value::Null) => return Some(number(0.0)),
            ("number" | "integer", Value::String(s)) if !s.is_empty() => {
                let f = crate::jsval::number_of_str(s);
                let integral = f.is_nan() || (f % 1.0) == 0.0 || f.is_infinite();
                if !f.is_nan() && (*t == "number" || integral) {
                    return Some(number(f));
                }
            }
            ("boolean", Value::String(s)) if s == "false" => {
                return Some(Coerced::Value(Value::Bool(false)))
            }
            ("boolean", Value::String(s)) if s == "true" => {
                return Some(Coerced::Value(Value::Bool(true)))
            }
            ("boolean", Value::Null) => return Some(Coerced::Value(Value::Bool(false))),
            ("boolean", Value::Number(n)) if n.as_f64() == Some(0.0) => {
                return Some(Coerced::Value(Value::Bool(false)));
            }
            ("boolean", Value::Number(n)) if n.as_f64() == Some(1.0) => {
                return Some(Coerced::Value(Value::Bool(true)));
            }
            ("null", Value::String(s)) if s.is_empty() => return Some(Coerced::Value(Value::Null)),
            ("null", Value::Bool(false)) => return Some(Coerced::Value(Value::Null)),
            ("null", Value::Number(n)) if n.as_f64() == Some(0.0) => {
                return Some(Coerced::Value(Value::Null));
            }
            _ => {}
        }
    }
    None
}

/// `assignDefaults` for an object: missing properties with a `default`
/// get a copy of it.
fn assign_defaults(obj: &Map<String, Value>, data: &mut Value) {
    let (Some(properties), Some(map)) = (
        obj.get("properties").and_then(Value::as_object),
        data.as_object_mut(),
    ) else {
        return;
    };
    for (name, sub) in properties {
        if let Some(default) = sub.get("default") {
            if !map.contains_key(name) {
                map.insert(name.clone(), default.clone());
            }
        }
    }
}

/// Ajv's `equal` (fast-deep-equal) and `===` for primitives.
fn js_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| js_equal(p, q))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|w| js_equal(v, w)))
        }
        _ => a == b,
    }
}

/// `for (key in data)` order.
fn js_keys(map: &Map<String, Value>) -> Vec<String> {
    let mut indices: Vec<(u64, String)> = Vec::new();
    let mut rest = Vec::new();
    for k in map.keys() {
        match k.parse::<u64>() {
            Ok(n) if is_array_index(k) => indices.push((n, k.clone())),
            Ok(_) | Err(_) => rest.push(k.clone()),
        }
    }
    indices.sort_by_key(|(n, _)| *n);
    indices.into_iter().map(|(_, k)| k).chain(rest).collect()
}

/// A JSON Pointer segment.
#[must_use]
pub(super) fn escape_pointer(segment: &str) -> String {
    segment.replace('~', "~0").replace('/', "~1")
}

fn digits(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|b| b.is_ascii_digit())
}

/// ajv-formats' fast `date`: `/^\d\d\d\d-[0-1]\d-[0-3]\d$/`.
#[must_use]
pub(super) fn fast_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && digits(s.get(0..4).unwrap_or(""), 4)
        && b.get(4) == Some(&b'-')
        && matches!(b.get(5), Some(b'0' | b'1'))
        && b.get(6).is_some_and(u8::is_ascii_digit)
        && b.get(7) == Some(&b'-')
        && matches!(b.get(8), Some(b'0'..=b'3'))
        && b.get(9).is_some_and(u8::is_ascii_digit)
}

/// ajv-formats' fast `date-time`:
/// `/^\d\d\d\d-[0-1]\d-[0-3]\dt(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)$/i`.
#[must_use]
pub(super) fn fast_date_time(text: &str) -> bool {
    let (Some(date), Some(sep), Some(rest)) = (text.get(0..10), text.get(10..11), text.get(11..))
    else {
        return false;
    };
    if !fast_date(date) || !sep.eq_ignore_ascii_case("t") {
        return false;
    }
    let bytes = rest.as_bytes();
    let digit = |at: usize| bytes.get(at).is_some_and(u8::is_ascii_digit);
    let time = rest.get(0..8).is_some_and(|t| {
        t == "23:59:60"
            || (matches!(bytes.first(), Some(b'0'..=b'2'))
                && digit(1)
                && bytes.get(2) == Some(&b':')
                && matches!(bytes.get(3), Some(b'0'..=b'5'))
                && digit(4)
                && bytes.get(5) == Some(&b':')
                && matches!(bytes.get(6), Some(b'0'..=b'5'))
                && digit(7))
    });
    if !time {
        return false;
    }
    let mut at = 8;
    if bytes.get(at) == Some(&b'.') {
        let start = at + 1;
        at = start;
        while digit(at) {
            at += 1;
        }
        if at == start {
            return false;
        }
    }
    let zone = rest.get(at..).unwrap_or("");
    if zone.eq_ignore_ascii_case("z") {
        return true;
    }
    let zb = zone.as_bytes();
    let zone_digit = |j: usize| zb.get(j).is_some_and(u8::is_ascii_digit);
    matches!(zb.first(), Some(b'+' | b'-'))
        && zone_digit(1)
        && zone_digit(2)
        && match zb.len() {
            3 => true,
            5 => zone_digit(3) && zone_digit(4),
            6 => zb.get(3) == Some(&b':') && zone_digit(4) && zone_digit(5),
            _ => false,
        }
}

fn base64ish(s: &str) -> bool {
    let body = s.trim_end_matches('=');
    s.len() - body.len() <= 2
        && body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(schema: &Value, data: &mut Value, coerce: bool) -> (bool, Vec<String>) {
        let doc = json!({});
        let patterns = HashMap::new();
        let mut ajv = Ajv::new(&doc, &patterns, coerce);
        let ok = ajv.validate(schema, data, "", false);
        (
            ok,
            ajv.errors
                .iter()
                .map(|e| format!("{} {}", e.instance_path, e.message))
                .collect(),
        )
    }

    #[test]
    fn coercion_and_type_errors() {
        let schema = json!({"type": "object", "properties": {"n": {"type": "number"}, "b": {"type": "boolean"}}});
        let mut data = json!({"n": "1e3", "b": "true"});
        assert_eq!(run(&schema, &mut data, true), (true, vec![]), "coerced");
        assert_eq!(data, json!({"n": 1000, "b": true}), "written back");
        let mut bad = json!({"n": "x"});
        assert_eq!(
            run(&schema, &mut bad, true).1,
            vec![String::from("/n must be number")],
            "type error"
        );
    }

    #[test]
    fn deferred_type_errors_follow_untyped_keywords() {
        let schema = json!({"type": "string", "enum": ["a"], "minLength": 1});
        assert_eq!(
            run(&schema, &mut json!(5), false).1,
            vec![String::from(" must be equal to one of the allowed values")],
            "enum before the string group's type error"
        );
        let plain = json!({"type": "string", "enum": ["a"]});
        assert_eq!(
            run(&plain, &mut json!(5), false).1,
            vec![String::from(" must be string")],
            "type first"
        );
    }

    #[test]
    fn composite_branches_collect_errors() {
        let schema = json!({"oneOf": [{"type": "array"}, {"type": "string", "enum": ["all"]}]});
        assert_eq!(
            run(&schema, &mut json!(3), false).1,
            vec![
                String::from(" must be array"),
                String::from(" must be string"),
                String::from(" must be equal to one of the allowed values"),
                String::from(" must match exactly one schema in oneOf"),
            ],
            "a composite type error lets untyped keywords run"
        );
    }

    #[test]
    fn required_additional_and_defaults() {
        let schema = json!({"type": "object", "additionalProperties": false, "required": ["a"],
            "properties": {"a": {"type": "integer"}, "d": {"type": "string", "default": "x"}}});
        assert_eq!(
            run(&schema, &mut json!({}), false).1,
            vec![String::from(" must have required property 'a'")],
            "required"
        );
        assert_eq!(
            run(&schema, &mut json!({"a": 1, "z": 1}), false).1,
            vec![String::from(" must NOT have additional properties")],
            "additional"
        );
        let mut data = json!({"a": 1});
        assert!(run(&schema, &mut data, false).0, "valid");
        assert_eq!(data, json!({"a": 1, "d": "x"}), "default assigned");
    }

    #[test]
    fn fast_formats() {
        assert!(fast_date("2024-01-02") && !fast_date("2024-1-02"), "date");
        assert!(fast_date_time("2024-01-02T03:04:05Z"), "utc");
        assert!(fast_date_time("2024-01-02t03:04:05.123+01:00"), "offset");
        assert!(!fast_date_time("2024-01-02 03:04:05Z"), "space separator");
        assert!(!fast_date_time("2024-01-02T03:04Z"), "no seconds");
    }
}
