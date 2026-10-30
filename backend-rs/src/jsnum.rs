//! JavaScript's `Number(value)` and `String(number)` for JSON values, as
//! the image cache and the mapping dataset parsers use them.

use serde_json::Value;

/// `String(n)` for a JavaScript number.
#[must_use]
pub fn to_string(n: f64) -> String {
    if n.is_nan() {
        return String::from("NaN");
    }
    if n.is_infinite() {
        return String::from(if n > 0.0 { "Infinity" } else { "-Infinity" });
    }
    if n == 0.0 {
        return String::from("0");
    }
    let abs = n.abs();
    if abs < 1e21 && n.fract() == 0.0 {
        return format!("{n:.0}");
    }
    if (1e-6..1e21).contains(&abs) {
        return format!("{n}");
    }
    let text = format!("{n:e}");
    match text.split_once('e') {
        Some((mantissa, exponent)) if !exponent.starts_with('-') => {
            format!("{mantissa}e+{exponent}")
        }
        _ => text,
    }
}

/// `String(value)` for what JSON holds (`undefined` for a missing value).
#[must_use]
pub fn value_string(value: Option<&Value>) -> String {
    match value {
        None => String::from("undefined"),
        Some(Value::Null) => String::from("null"),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.as_f64().map_or_else(|| n.to_string(), to_string),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other @ (Value::Bool(_)
                | Value::Number(_)
                | Value::String(_)
                | Value::Array(_)
                | Value::Object(_)) => value_string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => String::from("[object Object]"),
    }
}

/// `Number(value)` (`NaN` for a missing value).
#[must_use]
pub fn value_number(value: Option<&Value>) -> f64 {
    match value {
        None | Some(Value::Object(_)) => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => crate::librarymap::js_number(s),
        Some(array @ Value::Array(_)) => crate::librarymap::js_number(&value_string(Some(array))),
    }
}

/// An integer as a JavaScript number.
#[must_use]
pub fn from_i64(n: i64) -> f64 {
    n.to_string().parse().unwrap_or(f64::NAN)
}

/// `Date.now()`.
#[must_use]
pub fn now() -> f64 {
    from_i64(crate::clock::now_millis())
}

/// A number as `res.json` prints it: integers without a fraction.
#[must_use]
pub fn json(n: f64) -> Value {
    crate::librarymap::safe_integer(n).map_or_else(|| crate::librarymap::num(n), Value::from)
}

/// `Number.isInteger(n)`.
#[must_use]
pub fn is_integer(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn prints_like_javascript() {
        assert_eq!(to_string(86_400.0), "86400", "integer");
        assert_eq!(to_string(12.5), "12.5", "fraction");
        assert_eq!(to_string(-0.0), "0", "negative zero");
        assert_eq!(to_string(1e21), "1e+21", "large");
        assert_eq!(to_string(1.5e-7), "1.5e-7", "small");
        assert_eq!(to_string(f64::NAN), "NaN", "NaN");
        assert_eq!(
            to_string(1_791_661_865_758.0),
            "1791661865758",
            "a timestamp"
        );
    }

    #[test]
    fn reads_like_javascript() {
        assert!(value_number(None).is_nan(), "undefined");
        assert!(value_number(Some(&json!({}))).is_nan(), "object");
        assert!(
            (value_number(Some(&Value::Null))).abs() < f64::EPSILON,
            "null"
        );
        assert!(
            (value_number(Some(&json!(true))) - 1.0).abs() < f64::EPSILON,
            "true"
        );
        assert!(
            (value_number(Some(&json!(" 12 "))) - 12.0).abs() < f64::EPSILON,
            "string"
        );
        assert!(
            (value_number(Some(&json!([5]))) - 5.0).abs() < f64::EPSILON,
            "one-element array"
        );
        assert!(value_number(Some(&json!([1, 2]))).is_nan(), "longer array");
        assert!(
            value_number(Some(&json!([]))).abs() < f64::EPSILON,
            "empty array"
        );
        assert_eq!(
            value_string(Some(&json!([1, null, "a"]))),
            "1,,a",
            "array text"
        );
    }
}
