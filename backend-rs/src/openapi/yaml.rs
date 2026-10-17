//! seerr-api.yml as `js-yaml` reads it.
//!
//! [`load`] reads it as `load(text, { schema: JSON_SCHEMA })` does (what
//! `@apidevtools/json-schema-ref-parser` hands the validator): plain scalars resolve to null, booleans and numbers, everything else is
//! a string, mapping keys become strings, and objects list array-index
//! keys first as JavaScript objects do.

use anyhow::{anyhow, bail, Result};
use serde_json::{Map, Value};
use yaml_rust2::parser::{Event, MarkedEventReceiver, Parser};
use yaml_rust2::scanner::{Marker, TScalarStyle};

/// Parse one YAML document into JSON.
///
/// # Errors
///
/// Fails on invalid YAML, aliases, tags, duplicate keys and more than one
/// document, which `js-yaml` would refuse or resolve differently.
pub(super) fn load(text: &str) -> Result<Value> {
    load_with(text, false)
}

/// `js-yaml`'s `load(text)` with its default schema, as `server/index.ts`
/// loads the spec for Swagger UI: plain timestamps become `Date`s, which
/// JSON prints as `toISOString()`.
///
/// # Errors
///
/// As [`load`].
pub fn load_default(text: &str) -> Result<Value> {
    load_with(text, true)
}

fn load_with(text: &str, timestamps: bool) -> Result<Value> {
    let mut builder = Builder {
        timestamps,
        ..Builder::default()
    };
    Parser::new_from_str(text)
        .load(&mut builder, false)
        .map_err(|e| anyhow!("{e}"))?;
    if let Some(error) = builder.error {
        bail!(error);
    }
    builder
        .root
        .ok_or_else(|| anyhow!("the YAML file is empty"))
}

enum Frame {
    Seq(Vec<Value>),
    Map(Map<String, Value>, Option<String>),
}

#[derive(Default)]
struct Builder {
    stack: Vec<Frame>,
    root: Option<Value>,
    error: Option<String>,
    timestamps: bool,
}

impl Builder {
    fn push_value(&mut self, value: Value) {
        match self.stack.last_mut() {
            None => {
                if self.root.is_some() {
                    self.error = Some(String::from("more than one YAML document"));
                }
                self.root = Some(value);
            }
            Some(Frame::Seq(items)) => items.push(value),
            Some(Frame::Map(map, key)) => match key.take() {
                None => match key_string(&value) {
                    Some(k) => *key = Some(k),
                    None => self.error = Some(String::from("a mapping key that isn't a scalar")),
                },
                Some(k) => {
                    if map.contains_key(&k) {
                        self.error = Some(format!("duplicated mapping key {k}"));
                    }
                    map.insert(k, value);
                }
            },
        }
    }
}

impl MarkedEventReceiver for Builder {
    fn on_event(&mut self, ev: Event, _mark: Marker) {
        match ev {
            Event::Scalar(text, style, anchor, tag) => {
                if anchor != 0 || tag.is_some() {
                    self.error = Some(String::from("YAML anchors and tags aren't supported"));
                }
                let stamp = (self.timestamps && style == TScalarStyle::Plain)
                    .then(|| crate::standalone::apidocs::yaml_timestamp(&text))
                    .flatten();
                let value = stamp.map_or_else(
                    || {
                        if style == TScalarStyle::Plain {
                            resolve_plain(&text)
                        } else {
                            Value::String(text)
                        }
                    },
                    Value::String,
                );
                self.push_value(value);
            }
            Event::SequenceStart(anchor, tag) | Event::MappingStart(anchor, tag)
                if anchor != 0 || tag.is_some() =>
            {
                self.error = Some(String::from("YAML anchors and tags aren't supported"));
            }
            Event::SequenceStart(..) => self.stack.push(Frame::Seq(Vec::new())),
            Event::MappingStart(..) => self.stack.push(Frame::Map(Map::new(), None)),
            Event::SequenceEnd | Event::MappingEnd => match self.stack.pop() {
                Some(Frame::Seq(items)) => self.push_value(Value::Array(items)),
                Some(Frame::Map(map, _)) => {
                    // A JavaScript object lists array-index keys first.
                    self.push_value(Value::Object(super::request::js_ordered(map)));
                }
                None => self.error = Some(String::from("unbalanced YAML events")),
            },
            Event::Alias(_) => self.error = Some(String::from("YAML aliases aren't supported")),
            Event::Nothing
            | Event::StreamStart
            | Event::StreamEnd
            | Event::DocumentStart
            | Event::DocumentEnd => {}
        }
    }
}

/// `String(key)` for a resolved mapping key.
fn key_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Null => Some(String::from("null")),
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(
            n.as_f64()
                .map_or_else(|| n.to_string(), crate::jsval::number_string),
        ),
        Value::Array(_) | Value::Object(_) => None,
    }
}

/// The JSON schema's implicit types for a plain scalar.
fn resolve_plain(text: &str) -> Value {
    match text {
        "" | "~" | "null" | "Null" | "NULL" => return Value::Null,
        "true" | "True" | "TRUE" => return Value::Bool(true),
        "false" | "False" | "FALSE" => return Value::Bool(false),
        _ => {}
    }
    if let Some(n) = integer(text) {
        return n;
    }
    if is_float(text) {
        if let Ok(f) = text.parse::<f64>() {
            return crate::jsval::num(f);
        }
    }
    Value::String(text.to_owned())
}

fn integer(text: &str) -> Option<Value> {
    let (negative, body) = match text.as_bytes().first() {
        Some(b'-') => (true, text.get(1..)?),
        Some(b'+') => (false, text.get(1..)?),
        _ => (false, text),
    };
    let (digits, radix) = if let Some(hex) = body.strip_prefix("0x") {
        (hex, 16)
    } else if let Some(oct) = body.strip_prefix("0o") {
        (oct, 8)
    } else if let Some(bin) = body.strip_prefix("0b") {
        (bin, 2)
    } else {
        let decimal =
            body == "0" || (body.bytes().all(|b| b.is_ascii_digit()) && !body.starts_with('0'));
        if body.is_empty() || !decimal {
            return None;
        }
        (body, 10)
    };
    if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
        return None;
    }
    let magnitude = i64::from_str_radix(digits, radix).ok()?;
    Some(Value::from(if negative { -magnitude } else { magnitude }))
}

fn is_float(text: &str) -> bool {
    let body = text.strip_prefix(['-', '+']).unwrap_or(text);
    let (mantissa, exponent) = body.find(['e', 'E']).map_or((body, None), |i| {
        (body.get(..i).unwrap_or(""), body.get(i + 1..))
    });
    let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    let mantissa_ok = digits(int) && digits(frac) && !(int.is_empty() && frac.is_empty());
    let exponent_ok = exponent.is_none_or(|e| {
        let e = e.strip_prefix(['-', '+']).unwrap_or(e);
        !e.is_empty() && digits(e)
    });
    mantissa_ok && exponent_ok && !int.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scalars_resolve_like_the_json_schema() {
        let doc = load(
            "a: 1\nb: '1'\nc: true\nd: ~\ne: 1.5\nf: -3\ng: 0x1A\nh: yes\ni: |\n  x\n  y\n200: ok\nj: [1, two]\n",
        )
        .ok();
        let expected = serde_json::json!({
            "a": 1, "b": "1", "c": true, "d": null, "e": 1.5, "f": -3, "g": 26,
            "h": "yes", "i": "x\ny\n", "200": "ok", "j": [1, "two"]
        });
        assert_eq!(doc, Some(expected), "plain scalars resolve");
    }

    #[test]
    fn duplicate_keys_and_aliases_are_refused() {
        assert!(load("a: 1\na: 2\n").is_err(), "duplicate key");
        assert!(load("a: &x 1\nb: *x\n").is_err(), "alias");
    }
}
