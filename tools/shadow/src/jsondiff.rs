//! Structural JSON diff with paths, plus glob patterns over those paths.

use std::collections::BTreeMap;

use serde_json::Value;

/// One difference between two JSON documents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diff {
    /// Exact location, e.g. `$.results[3].title`.
    pub path: String,
    /// Same location with array indices generalised: `$.results[*].title`.
    pub generic: String,
    /// Value on the left; `None` when the left side doesn't have this path.
    pub a: Option<Value>,
    /// Value on the right; `None` when the right side doesn't have this path.
    pub b: Option<Value>,
}

/// Differences between `a` and `b`, at most `limit` of them.
#[must_use]
pub fn diff(a: &Value, b: &Value, limit: usize) -> Vec<Diff> {
    let mut w = Walker {
        path: String::from("$"),
        generic: String::from("$"),
        out: Vec::new(),
        limit,
    };
    w.walk(a, b);
    w.out
}

struct Walker {
    path: String,
    generic: String,
    out: Vec<Diff>,
    limit: usize,
}

impl Walker {
    fn full(&self) -> bool {
        self.out.len() >= self.limit
    }

    fn record(&mut self, a: Option<&Value>, b: Option<&Value>) {
        self.out.push(Diff {
            path: self.path.clone(),
            generic: self.generic.clone(),
            a: a.cloned(),
            b: b.cloned(),
        });
    }

    /// Run `f` with `seg` appended to both paths.
    fn nested(&mut self, exact: &str, generic: &str, f: impl FnOnce(&mut Self)) {
        let (pl, gl) = (self.path.len(), self.generic.len());
        self.path.push_str(exact);
        self.generic.push_str(generic);
        f(self);
        self.path.truncate(pl);
        self.generic.truncate(gl);
    }

    fn walk(&mut self, a: &Value, b: &Value) {
        if self.full() {
            return;
        }
        match (a, b) {
            (Value::Object(ma), Value::Object(mb)) => {
                for (k, va) in ma {
                    let seg = key_segment(k);
                    self.nested(&seg, &seg, |w| match mb.get(k) {
                        Some(vb) => w.walk(va, vb),
                        None => w.record(Some(va), None),
                    });
                    if self.full() {
                        return;
                    }
                }
                for (k, vb) in mb {
                    if ma.contains_key(k) {
                        continue;
                    }
                    let seg = key_segment(k);
                    self.nested(&seg, &seg, |w| w.record(None, Some(vb)));
                    if self.full() {
                        return;
                    }
                }
            }
            (Value::Array(xa), Value::Array(xb)) => {
                for i in 0..xa.len().max(xb.len()) {
                    self.nested(&format!("[{i}]"), "[*]", |w| match (xa.get(i), xb.get(i)) {
                        (Some(va), Some(vb)) => w.walk(va, vb),
                        (va, vb) => w.record(va, vb),
                    });
                    if self.full() {
                        return;
                    }
                }
            }
            (Value::Number(na), Value::Number(nb)) => {
                if !numbers_equal(na, nb) {
                    self.record(Some(a), Some(b));
                }
            }
            _ => {
                if a != b {
                    self.record(Some(a), Some(b));
                }
            }
        }
    }
}

/// Numerically equal, so `1` and `1.0` match.
#[must_use]
pub fn numbers_equal(a: &serde_json::Number, b: &serde_json::Number) -> bool {
    a == b || matches!((a.as_f64(), b.as_f64()), (Some(x), Some(y)) if x.total_cmp(&y).is_eq())
}

fn key_segment(key: &str) -> String {
    let plain = !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '$');
    if plain {
        format!(".{key}")
    } else {
        format!("[\"{}\"]", key.replace('"', "\\\""))
    }
}

/// Split a path into tokens: `$.a["b.c"][*]` -> `$`, `a`, `b.c`, `[*]`.
fn tokens(path: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut chars = path.chars();
    while let Some(c) = chars.next() {
        match c {
            '.' => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            '[' => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
                let inner: String = chars.by_ref().take_while(|&d| d != ']').collect();
                match inner.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
                    Some(key) => out.push(key.replace("\\\"", "\"")),
                    None => out.push(format!("[{inner}]")),
                }
            }
            _ => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Whether `path` matches `pattern`.
///
/// Patterns use the path syntax with wildcards: `*` is one segment, `**` is
/// any number of segments, `[*]` is any array index. Patterns that don't
/// start with `$` match anywhere, so `updatedAt` hits `$.results[*].updatedAt`.
#[must_use]
pub fn matches(pattern: &str, path: &str) -> bool {
    let mut pat = tokens(pattern);
    if pat.first().map(String::as_str) != Some("$") {
        pat.splice(0..0, [String::from("$"), String::from("**")]);
    }
    glob(&pat, &tokens(path))
}

fn glob(pat: &[String], path: &[String]) -> bool {
    match pat.split_first() {
        None => path.is_empty(),
        Some((p, rest)) if p == "**" => (0..=path.len())
            .filter_map(|i| path.get(i..))
            .any(|tail| glob(rest, tail)),
        Some((p, rest)) => path.split_first().is_some_and(|(seg, path_rest)| {
            let ok =
                p == "*" || p == seg || (p == "[*]" && seg.starts_with('[') && seg.ends_with(']'));
            ok && glob(rest, path_rest)
        }),
    }
}

/// Re-serialise JSON with object keys sorted, so equal values compare equal.
#[must_use]
pub fn canonical(v: &Value) -> String {
    fn sort(v: &Value) -> Value {
        match v {
            Value::Object(m) => {
                let sorted: BTreeMap<&String, Value> =
                    m.iter().map(|(k, x)| (k, sort(x))).collect();
                Value::Object(sorted.into_iter().map(|(k, x)| (k.clone(), x)).collect())
            }
            Value::Array(a) => Value::Array(a.iter().map(sort).collect()),
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => v.clone(),
        }
    }
    sort(v).to_string()
}

/// Replace ISO-8601 timestamps in strings with a placeholder.
pub fn mask_timestamps(v: &mut Value) {
    match v {
        Value::String(s) => {
            if looks_like_timestamp(s) {
                "<timestamp>".clone_into(s);
            }
        }
        Value::Array(a) => a.iter_mut().for_each(mask_timestamps),
        Value::Object(m) => m.values_mut().for_each(mask_timestamps),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

/// Starts with `YYYY-MM-DDTHH:MM:SS` (or a space instead of `T`).
#[must_use]
pub fn looks_like_timestamp(s: &str) -> bool {
    let shape = b"dddd-dd-ddTdd:dd:dd";
    s.len() >= shape.len()
        && s.bytes().zip(shape).all(|(c, want)| match want {
            b'd' => c.is_ascii_digit(),
            b'T' => c == b'T' || c == b' ',
            _ => c == *want,
        })
}

/// Parse `2026-10-10T19:16:37.000Z`, `2026-10-10 19:16:37.145` and offsets
/// like `+02:00` into unix milliseconds. Times without a zone count as UTC.
#[must_use]
pub fn parse_timestamp_ms(s: &str) -> Option<i64> {
    if !looks_like_timestamp(s) {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> { s.get(r)?.parse().ok() };
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hour, minute, second) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let rest = s.get(19..)?;
    let (millis, zone) = match rest.strip_prefix('.') {
        Some(frac_and_zone) => {
            let digits = frac_and_zone
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(frac_and_zone.len());
            let (frac, zone) = frac_and_zone.split_at_checked(digits)?;
            let padded: String = frac.chars().chain(std::iter::repeat('0')).take(3).collect();
            (padded.parse::<i64>().ok()?, zone)
        }
        None => (0, rest),
    };
    let offset_min = parse_zone(zone)?;
    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_min * 60;
    Some(secs * 1_000 + millis)
}

/// Minutes east of UTC for `Z`, `+02:00`, `-0530` or nothing.
fn parse_zone(zone: &str) -> Option<i64> {
    if zone.is_empty() || zone.eq_ignore_ascii_case("z") {
        return Some(0);
    }
    let (sign, digits) = if let Some(d) = zone.strip_prefix('+') {
        (1, d)
    } else {
        (-1, zone.strip_prefix('-')?)
    };
    let digits = digits.replace(':', "");
    let hours: i64 = digits.get(0..2)?.parse().ok()?;
    let minutes: i64 = digits.get(2..4).and_then(|m| m.parse().ok()).unwrap_or(0);
    Some(sign * (hours * 60 + minutes))
}

/// Days since 1970-01-01 (Howard Hinnant's algorithm).
const fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_from_march = (month + 9) % 12;
    let day_of_year = (153 * month_from_march + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// Two values that are timestamps within `tolerance_ms` of each other.
#[must_use]
pub fn close_timestamps(a: &Value, b: &Value, tolerance_ms: u64) -> bool {
    if tolerance_ms == 0 {
        return false;
    }
    match (
        a.as_str().and_then(parse_timestamp_ms),
        b.as_str().and_then(parse_timestamp_ms),
    ) {
        (Some(x), Some(y)) => x.abs_diff(y) <= tolerance_ms,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn finds_nested_differences() {
        let a = json!({"page": 1, "results": [{"id": 1, "title": "A"}, {"id": 2}], "x": 1.0});
        let b = json!({"page": 1, "results": [{"id": 1, "title": "B"}], "x": 1, "y": true});
        let d = diff(&a, &b, 100);
        let paths: Vec<&str> = d.iter().map(|d| d.path.as_str()).collect();
        assert_eq!(
            paths,
            vec!["$.results[0].title", "$.results[1]", "$.y"],
            "changed, removed and added values; 1.0 equals 1"
        );
        assert_eq!(
            d.first().map(|x| x.generic.as_str()),
            Some("$.results[*].title"),
            "indices generalised"
        );
    }

    #[test]
    fn odd_keys_are_quoted() {
        let d = diff(&json!({"a.b": 1}), &json!({"a.b": 2}), 10);
        let path = d.first().map(|x| x.path.clone()).unwrap_or_default();
        assert_eq!(path, "$[\"a.b\"]", "dotted key quoted");
        assert!(matches("$[\"a.b\"]", &path), "quoted keys match patterns");
    }

    #[test]
    fn glob_patterns() {
        assert!(matches("updatedAt", "$.results[*].updatedAt"), "unanchored");
        assert!(
            matches("**.updatedAt", "$.updatedAt"),
            "** matches zero segments"
        );
        assert!(
            matches("$.results[*].media.*", "$.results[*].media.status"),
            "* matches one segment"
        );
        assert!(
            !matches("$.results[*].media.*", "$.results[*].media.status.x"),
            "* matches only one segment"
        );
        assert!(
            matches("$.results.**", "$.results[*].media.status.x"),
            "** matches many segments"
        );
        assert!(
            !matches("$.page", "$.results[*].page"),
            "anchored patterns stay anchored"
        );
    }

    #[test]
    fn canonical_sorts_keys() {
        assert_eq!(
            canonical(&json!({"b": 1, "a": [{"d": 1, "c": 2}]})),
            r#"{"a":[{"c":2,"d":1}],"b":1}"#,
            "keys sorted at every level"
        );
    }

    #[test]
    fn parses_timestamps() {
        assert_eq!(
            parse_timestamp_ms("1970-01-01T00:00:01.5Z"),
            Some(1_500),
            "fraction"
        );
        assert_eq!(
            parse_timestamp_ms("2026-10-10 19:16:41.144"),
            parse_timestamp_ms("2026-10-10T19:16:41.144Z"),
            "space separator, no zone"
        );
        assert_eq!(
            parse_timestamp_ms("2026-10-10T21:16:41+02:00"),
            parse_timestamp_ms("2026-10-10T19:16:41Z"),
            "offset applied"
        );
        assert_eq!(
            parse_timestamp_ms("2000-03-01T00:00:00Z"),
            Some(951_868_800_000),
            "leap year arithmetic"
        );
        assert!(
            close_timestamps(
                &json!("2026-10-10 19:16:41.144"),
                &json!("2026-10-10 19:16:41.145"),
                5
            ),
            "1ms apart"
        );
        assert!(
            !close_timestamps(
                &json!("2026-10-10 19:16:41"),
                &json!("2026-10-10 19:16:49"),
                5_000
            ),
            "8s apart"
        );
        assert!(
            !close_timestamps(&json!("x"), &json!("x"), 5_000),
            "not timestamps"
        );
    }

    #[test]
    fn masks_timestamps() {
        let mut v = json!({"t": "2026-10-10T12:00:00.000Z", "n": "hello"});
        mask_timestamps(&mut v);
        assert_eq!(
            v,
            json!({"t": "<timestamp>", "n": "hello"}),
            "only timestamps masked"
        );
    }
}
