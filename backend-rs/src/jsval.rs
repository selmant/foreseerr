//! JavaScript value semantics the provider clients lean on.
//!
//! `Number(x)`, `String(n)`, `trim()`, `decodeURIComponent`,
//! `URLSearchParams` encoding and the slice of ICU collation
//! `localeCompare` needs for plain titles.

use std::cmp::Ordering;

use serde_json::Value;
use unicode_normalization::UnicodeNormalization;
use unicode_properties::{GeneralCategoryGroup, UnicodeGeneralCategory};

/// JavaScript's `WhiteSpace` and `LineTerminator` characters, which
/// `String.prototype.trim` strips.
const fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `s.trim()`.
#[must_use]
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `Number(text)` for a string: blank is 0, decimal literals (with an
/// optional exponent), `Infinity`, and `0x`/`0o`/`0b` integers; anything
/// else is `NaN`.
#[must_use]
pub fn number_of_str(text: &str) -> f64 {
    let t = trim(text);
    if t.is_empty() {
        return 0.0;
    }
    let (sign, body) = match t.as_bytes().first() {
        Some(b'-') => (-1.0, t.get(1..).unwrap_or("")),
        Some(b'+') => (1.0, t.get(1..).unwrap_or("")),
        _ => (1.0, t),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    let radix = [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ]
    .iter()
    .find_map(|(prefix, radix)| t.strip_prefix(prefix).map(|digits| (digits, *radix)));
    if let Some((digits, radix)) = radix {
        if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
            return f64::NAN;
        }
        // The exact integer, rounded once, as the spec's mathematical value.
        return u128::from_str_radix(digits, radix)
            .ok()
            .and_then(|n| n.to_string().parse::<f64>().ok())
            .unwrap_or_else(|| {
                digits.chars().fold(0.0, |acc: f64, c| {
                    acc.mul_add(f64::from(radix), c.to_digit(radix).map_or(0.0, f64::from))
                })
            });
    }
    if decimal_literal(body) {
        t.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

/// `StrUnsignedDecimalLiteral`: digits with an optional fraction (or a
/// fraction alone) and an optional exponent.
fn decimal_literal(s: &str) -> bool {
    let (mantissa, exponent) = s.find(['e', 'E']).map_or((s, None), |i| {
        (s.get(..i).unwrap_or(""), Some(s.get(i + 1..).unwrap_or("")))
    });
    let (int, frac) = mantissa
        .split_once('.')
        .map_or((mantissa, ""), |(i, f)| (i, f));
    let digits = |p: &str| p.bytes().all(|b| b.is_ascii_digit());
    if !digits(int) || !digits(frac) || (int.is_empty() && frac.is_empty()) {
        return false;
    }
    exponent.is_none_or(|e| {
        let e = e.strip_prefix(['+', '-']).unwrap_or(e);
        !e.is_empty() && digits(e)
    })
}

/// `Number(value)` for any JSON value.
#[must_use]
pub fn number_of(value: Option<&Value>) -> f64 {
    match value {
        None | Some(Value::Object(_)) => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => number_of_str(s),
        Some(Value::Array(items)) => match items.as_slice() {
            [] => 0.0,
            [one] => match one {
                Value::Array(_) | Value::Object(_) => f64::NAN,
                Value::Null => 0.0,
                other @ (Value::Bool(_) | Value::Number(_) | Value::String(_)) => {
                    number_of_str(&crate::media::js_string(Some(other)))
                }
            },
            _ => f64::NAN,
        },
    }
}

/// A number as `JSON.stringify` writes it: integers without a fraction,
/// `NaN` and the infinities as `null`.
#[must_use]
pub fn num(f: f64) -> Value {
    if !f.is_finite() {
        return Value::Null;
    }
    if f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0 {
        if let Ok(i) = format!("{f:.0}").parse::<i64>() {
            return Value::from(i);
        }
    }
    serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number)
}

/// `String(n)`.
#[must_use]
pub fn number_string(f: f64) -> String {
    if f.is_nan() {
        return String::from("NaN");
    }
    if f.is_infinite() {
        return String::from(if f > 0.0 { "Infinity" } else { "-Infinity" });
    }
    if f == 0.0 {
        return String::from("0");
    }
    let abs = f.abs();
    if (1e-6..1e21).contains(&abs) {
        return format!("{f}");
    }
    let text = format!("{f:e}");
    match text.split_once('e') {
        Some((mantissa, exp)) if !exp.starts_with('-') => format!("{mantissa}e+{exp}"),
        _ => text,
    }
}

/// `parseInt(text, radix)` (`radix` `None` for `undefined`): leading
/// whitespace and a sign, a `0x` prefix when the radix is 16 or left out,
/// then the longest run of digits; `NaN` when there are none.
#[must_use]
pub fn parse_int(text: &str, radix: Option<u32>) -> f64 {
    let s = text.trim_start_matches(is_js_space);
    let (sign, s) = match s.as_bytes().first() {
        Some(b'-') => (-1.0, s.get(1..).unwrap_or("")),
        Some(b'+') => (1.0, s.get(1..).unwrap_or("")),
        _ => (1.0, s),
    };
    let mut radix = radix.unwrap_or(0);
    if radix != 0 && !(2..=36).contains(&radix) {
        return f64::NAN;
    }
    let mut s = s;
    if radix == 0 || radix == 16 {
        if let Some(rest) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
            s = rest;
            radix = 16;
        }
    }
    if radix == 0 {
        radix = 10;
    }
    let end = s.find(|c: char| !c.is_digit(radix)).unwrap_or(s.len());
    let digits = s.get(..end).unwrap_or("");
    if digits.is_empty() {
        return f64::NAN;
    }
    let magnitude = if radix == 10 {
        digits.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        u128::from_str_radix(digits, radix)
            .ok()
            .and_then(|n| n.to_string().parse::<f64>().ok())
            .unwrap_or_else(|| {
                digits.chars().fold(0.0, |acc: f64, c| {
                    acc.mul_add(f64::from(radix), c.to_digit(radix).map_or(0.0, f64::from))
                })
            })
    };
    sign * magnitude
}

/// `parseFloat(text)`: leading whitespace, then the longest prefix that is
/// a decimal literal (or `Infinity`); `NaN` when there is none.
#[must_use]
pub fn parse_float(text: &str) -> f64 {
    let s = text.trim_start_matches(is_js_space);
    let unsigned = s.strip_prefix(['+', '-']).unwrap_or(s);
    if unsigned.starts_with("Infinity") {
        return if s.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    let sign_len = s.len() - unsigned.len();
    let bytes = unsigned.as_bytes();
    let digits_from = |mut i: usize| {
        while bytes.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        i
    };
    let int_end = digits_from(0);
    let mut end = int_end;
    if bytes.get(end) == Some(&b'.') {
        let frac_end = digits_from(end + 1);
        if frac_end > end + 1 || int_end > 0 {
            end = frac_end;
        }
    }
    if end == 0 || (end == 1 && bytes.first() == Some(&b'.')) {
        return f64::NAN;
    }
    if matches!(bytes.get(end), Some(b'e' | b'E')) {
        let mut i = end + 1;
        if matches!(bytes.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let exp_end = digits_from(i);
        if exp_end > i {
            end = exp_end;
        }
    }
    s.get(..sign_len + end)
        .and_then(|literal| literal.parse::<f64>().ok())
        .unwrap_or(f64::NAN)
}

/// `a === b` for numbers (`NaN` equals nothing, `-0` equals `0`).
#[must_use]
pub fn same(a: f64, b: f64) -> bool {
    a.partial_cmp(&b) == Some(Ordering::Equal)
}

/// `Number.isSafeInteger(n)`.
#[must_use]
pub fn is_safe_integer(n: f64) -> bool {
    crate::jsnum::is_integer(n) && n.abs() <= 9_007_199_254_740_991.0
}

/// An integral number as `i64` (`-0` is 0); `None` for fractions, `NaN`,
/// the infinities and magnitudes past 2^63.
#[must_use]
pub fn to_i64(n: f64) -> Option<i64> {
    if !crate::jsnum::is_integer(n) || n.abs() >= 9.223_372_036_854_776e18 {
        return None;
    }
    format!("{n:.0}").parse::<i64>().ok()
}

/// The number a JSON value holds, as JavaScript reads it (`NaN` for
/// anything else).
#[must_use]
pub fn json_number(n: &serde_json::Number) -> f64 {
    n.as_f64()
        .or_else(|| n.to_string().parse::<f64>().ok())
        .unwrap_or(f64::NAN)
}

/// `String(value)` for a JSON value that may be missing (`undefined`).
#[must_use]
pub fn string_of(value: Option<&Value>) -> String {
    match value {
        Some(Value::Number(n)) => n.as_f64().map_or_else(|| n.to_string(), number_string),
        other => crate::media::js_string(other).into_owned(),
    }
}

/// `decodeURIComponent`; `None` where it throws `URIError`.
#[must_use]
pub fn decode_uri_component(text: &str) -> Option<String> {
    if !text.contains('%') {
        return Some(text.to_owned());
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while let Some(&b) = bytes.get(i) {
        if b == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let digit = |c: u8| char::from(c).to_digit(16);
            let value = digit(*hex.first()?)? * 16 + digit(*hex.get(1)?)?;
            out.push(u8::try_from(value).ok()?);
            i += 3;
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `URLSearchParams` serialisation of one value
/// (`application/x-www-form-urlencoded`).
#[must_use]
pub fn form_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b' ' => out.push('+'),
            b if b.is_ascii_alphanumeric() || matches!(b, b'*' | b'-' | b'.' | b'_') => {
                out.push(char::from(b));
            }
            b => {
                out.push('%');
                for nibble in [b >> 4, b & 0x0F] {
                    out.push(
                        char::from_digit(u32::from(nibble), 16)
                            .map_or('0', |c| c.to_ascii_uppercase()),
                    );
                }
            }
        }
    }
    out
}

/// `a.localeCompare(b)` under ICU's root collation for titles made of
/// ASCII letters, digits and spaces; `None` for anything else, whose
/// ordering only ICU knows.
#[must_use]
pub fn locale_compare(a: &str, b: &str) -> Option<Ordering> {
    if a == b {
        return Some(Ordering::Equal);
    }
    let simple = |s: &str| s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b' ');
    if !simple(a) || !simple(b) {
        return None;
    }
    let primary = |s: &str| -> Vec<u8> {
        s.bytes()
            .map(|c| match c {
                b' ' => 0,
                b'0'..=b'9' => 1 + (c - b'0'),
                _ => 20 + (c.to_ascii_lowercase() - b'a'),
            })
            .collect()
    };
    let tertiary = |s: &str| -> Vec<u8> {
        s.bytes()
            .map(|c| u8::from(c.is_ascii_uppercase()))
            .collect()
    };
    Some(
        primary(a)
            .cmp(&primary(b))
            .then_with(|| tertiary(a).cmp(&tertiary(b))),
    )
}

/// Primary collation weights after ICU's root order, as `(group, weight)`.
///
/// Groups: whitespace, `-`, `&`, other symbols, digits, letters. Accents
/// are dropped and case is ignored (`sensitivity: 'base'`), so `Çocuk`
/// sorts with `cocuk`; what ICU orders by tables of its own (other
/// scripts, symbols) goes by code point within its group.
#[must_use]
pub fn base_collation_key(name: &str) -> Vec<(u8, u32)> {
    name.nfd()
        .filter(|c| c.general_category_group() != GeneralCategoryGroup::Mark)
        .flat_map(char::to_lowercase)
        .map(|c| match c {
            '-' => (1, 0),
            '&' => (2, 0),
            '0'..='9' => (4, u32::from(c)),
            'a'..='z' => (5, u32::from(c)),
            // Turkish dotless i sits right after i in ICU's root order.
            '\u{131}' => (5, u32::from('i')),
            c if c.is_whitespace() => (0, 0),
            c if c.is_alphabetic() => (6, u32::from(c)),
            c => (3, u32::from(c)),
        })
        .collect()
}

/// [`locale_compare`], or for text it can't order, [`base_collation_key`]
/// and then the code points: a total order that never needs ICU.
#[must_use]
pub fn locale_compare_or_base(a: &str, b: &str) -> Ordering {
    locale_compare(a, b).unwrap_or_else(|| {
        base_collation_key(a)
            .cmp(&base_collation_key(b))
            .then_with(|| a.cmp(b))
    })
}

/// `Object.keys` order: array-index keys ascending first, then the rest in
/// insertion order.
#[must_use]
pub fn object_entries(map: &serde_json::Map<String, Value>) -> Vec<(&String, &Value)> {
    let index = |k: &str| -> Option<u32> {
        (k == "0"
            || (!k.starts_with('0') && !k.is_empty() && k.bytes().all(|b| b.is_ascii_digit())))
        .then(|| k.parse::<u32>().ok())
        .flatten()
        .filter(|n| *n != u32::MAX)
    };
    let mut indexed: Vec<(u32, (&String, &Value))> = map
        .iter()
        .filter_map(|(k, v)| index(k).map(|n| (n, (k, v))))
        .collect();
    indexed.sort_by_key(|(n, _)| *n);
    let mut out: Vec<(&String, &Value)> = indexed.into_iter().map(|(_, e)| e).collect();
    out.extend(map.iter().filter(|(k, _)| index(k).is_none()));
    out
}

/// `Date.parse` of an RFC 7231 `IMF-fixdate` (`Sun, 06 Nov 1994 08:49:37
/// GMT`), the shape of `Retry-After` dates; other shapes are `None`.
#[must_use]
pub fn parse_http_date(text: &str) -> Option<i64> {
    let rest = text.trim().split_once(", ")?.1;
    let mut parts = rest.split(' ');
    let day: i64 = parts.next()?.parse().ok()?;
    let month = parts.next()?;
    let year: i64 = parts.next()?.parse().ok()?;
    let clock = parts.next()?;
    if parts.next()? != "GMT" || parts.next().is_some() {
        return None;
    }
    let months = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let month = i64::try_from(months.iter().position(|m| *m == month)? + 1).ok()?;
    let mut fields = clock.split(':').map(str::parse::<i64>);
    let (h, m, s) = (
        fields.next()?.ok()?,
        fields.next()?.ok()?,
        fields.next()?.ok()?,
    );
    if fields.next().is_some() || h > 23 || m > 59 || s > 60 || !(1..=31).contains(&day) {
        return None;
    }
    Some(
        crate::clock::days_from_civil(year, month, day) * 86_400_000
            + ((h * 60 + m) * 60 + s) * 1000,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_like_javascript() {
        assert!(
            (number_of_str(" 12 ") - 12.0).abs() < f64::EPSILON,
            "trimmed"
        );
        assert!(number_of_str("").abs() < f64::EPSILON, "blank");
        assert!((number_of_str("0x1A") - 26.0).abs() < f64::EPSILON, "hex");
        assert!(
            (number_of_str(".5e1") - 5.0).abs() < f64::EPSILON,
            "fraction"
        );
        assert!(number_of_str("12abc").is_nan(), "garbage");
        assert!(number_of_str("1e").is_nan(), "bad exponent");
        assert!(
            (number_of(Some(&json!(true))) - 1.0).abs() < f64::EPSILON,
            "bool"
        );
        assert!(number_of(None).is_nan(), "undefined");
        assert_eq!(num(8.0), json!(8), "whole");
        assert_eq!(num(f64::NAN), Value::Null, "nan");
        assert_eq!(number_string(1.5), "1.5", "fraction");
        assert_eq!(number_string(1e21), "1e+21", "exponent");
        assert_eq!(number_string(42.0), "42", "integer");
    }

    /// Values printed by Bun 1.4.1 (`String(parseInt(s))` and friends).
    #[test]
    fn parsing_like_bun() {
        let cases: [(&str, &str, &str, &str, &str); 15] = [
            ("  -12px", "-12", "-12", "-18", "-12"),
            ("0x1F", "31", "0", "31", "0"),
            ("0x", "NaN", "0", "NaN", "0"),
            ("-0x10", "-16", "0", "-16", "0"),
            ("1e3", "1", "1", "483", "1000"),
            ("Infinity", "NaN", "NaN", "NaN", "Infinity"),
            (
                "9007199254740993",
                "9007199254740992",
                "9007199254740992",
                "10378291982571407000",
                "9007199254740992",
            ),
            (
                "123456789012345678901234",
                "1.2345678901234569e+23",
                "1.2345678901234569e+23",
                "5.634002666912405e+27",
                "1.2345678901234569e+23",
            ),
            ("+5", "5", "5", "5", "5"),
            ("-0", "0", "0", "0", "0"),
            (".5", "NaN", "NaN", "NaN", "0.5"),
            ("5.", "5", "5", "5", "5"),
            ("1_000", "1", "1", "1", "1"),
            ("abc", "NaN", "NaN", "2748", "NaN"),
            ("", "NaN", "NaN", "NaN", "NaN"),
        ];
        for (input, int, int10, int16, float) in cases {
            assert_eq!(
                number_string(parse_int(input, None)),
                int,
                "parseInt({input:?})"
            );
            assert_eq!(
                number_string(parse_int(input, Some(10))),
                int10,
                "radix 10 {input:?}"
            );
            assert_eq!(
                number_string(parse_int(input, Some(16))),
                int16,
                "radix 16 {input:?}"
            );
            assert_eq!(
                number_string(parse_float(input)),
                float,
                "parseFloat({input:?})"
            );
        }
        assert!(
            parse_int("-0", None).is_sign_negative(),
            "-0 stays negative"
        );
        assert_eq!(
            number_string(number_of_str("1e400")),
            "Infinity",
            "overflow"
        );
        assert_eq!(number_string(number_of_str(" 0x10 ")), "16", "trimmed hex");
        assert!(same(-0.0, 0.0) && !same(f64::NAN, f64::NAN), "===");
        assert_eq!(to_i64(-0.0), Some(0), "-0");
        assert_eq!(to_i64(1.5), None, "fraction");
        assert_eq!(to_i64(1e20), None, "past i64");
    }

    #[test]
    fn strings_like_javascript() {
        assert_eq!(trim("\u{feff} a \u{a0}"), "a", "js whitespace");
        assert_eq!(trim("\u{85}a"), "\u{85}a", "NEL is not js whitespace");
        assert_eq!(
            decode_uri_component("a%20b%C3%A9").as_deref(),
            Some("a bé"),
            "decoded"
        );
        assert_eq!(decode_uri_component("%E0%A4%A"), None, "malformed");
        assert_eq!(decode_uri_component("%C3"), None, "truncated utf-8");
        assert_eq!(form_encode("a b&c~"), "a+b%26c%7E", "form encoding");
        assert_eq!(string_of(Some(&json!(3))), "3", "number");
        assert_eq!(string_of(None), "undefined", "undefined");
    }

    #[test]
    fn collation() {
        assert_eq!(
            locale_compare("ab", "Ab"),
            Some(Ordering::Less),
            "lower first"
        );
        assert_eq!(
            locale_compare("Ab", "ac"),
            Some(Ordering::Less),
            "primary first"
        );
        assert_eq!(
            locale_compare("a b", "ab"),
            Some(Ordering::Less),
            "space sorts low"
        );
        assert_eq!(
            locale_compare("9", "a"),
            Some(Ordering::Less),
            "digits before letters"
        );
        assert_eq!(locale_compare("é", "e"), None, "only ICU knows");
        assert_eq!(
            locale_compare_or_base("Şehir", "Sahne"),
            Ordering::Greater,
            "accents folded"
        );
        assert_eq!(
            locale_compare_or_base("é", "e"),
            Ordering::Greater,
            "a tie on the base letters goes by code point"
        );
        assert_eq!(
            locale_compare_or_base("Ab", "ac"),
            Ordering::Less,
            "ICU's answer when it is known"
        );
        assert_eq!(
            locale_compare("x.y", "x.y"),
            Some(Ordering::Equal),
            "same text"
        );
    }

    #[test]
    fn object_key_order() {
        let map = json!({"b": 1, "2": 2, "a": 3, "1": 4});
        let keys: Vec<&str> = map
            .as_object()
            .map(|m| {
                object_entries(m)
                    .into_iter()
                    .map(|(k, _)| k.as_str())
                    .collect()
            })
            .unwrap_or_default();
        assert_eq!(keys, vec!["1", "2", "b", "a"], "indices first");
        assert_eq!(
            parse_http_date("Wed, 21 Oct 2015 07:28:00 GMT"),
            Some(1_445_412_480_000),
            "imf-fixdate"
        );
    }
}
