//! The parts of the request the validator reads, parsed the way Express,
//! `querystring`, `cookie` and the validator's own helpers parse them.

use axum::http::HeaderMap;
use serde_json::{Map, Value};

/// `querystring.parse(raw)` (Express 5's "simple" query parser): `+` is a
/// space, repeated keys become arrays, at most 1000 pairs. The object's
/// keys are in JavaScript property order.
#[must_use]
pub fn parse_query(raw: &str) -> Map<String, Value> {
    let mut map = Map::new();
    if raw.is_empty() {
        return map;
    }
    for pair in raw.split('&').take(1000) {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = unescape(key);
        let value = Value::String(unescape(value));
        match map.get_mut(&key) {
            None => {
                map.insert(key, value);
            }
            Some(Value::Array(items)) => items.push(value),
            Some(existing) => {
                let first = std::mem::take(existing);
                *existing = Value::Array(vec![first, value]);
            }
        }
    }
    js_ordered(map)
}

/// `querystring.unescape` after `+` becomes a space: `decodeURIComponent`,
/// or where that throws, `unescapeBuffer(s).toString()` (valid `%XX`
/// escapes decoded, the rest kept, invalid UTF-8 replaced).
fn unescape(text: &str) -> String {
    let spaced = text.replace('+', " ");
    if let Some(decoded) = crate::jsval::decode_uri_component(&spaced) {
        return decoded;
    }
    let bytes = spaced.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while let Some(&b) = bytes.get(i) {
        let hex = |j: usize| bytes.get(j).and_then(|c| char::from(*c).to_digit(16));
        if let (b'%', Some(hi), Some(lo)) = (b, hex(i + 1), hex(i + 2)) {
            out.push(u8::try_from(hi * 16 + lo).unwrap_or(b'?'));
            i += 3;
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The validator's `BracketNotationHandler`.
///
/// No parameter in the spec has a literal bracket in its name, so every
/// key with a `[` is re-parsed with ``qs.parse(`${key}=${value}`)`` into
/// its plain name, then removed. A plain name `qs` didn't set but
/// `Object.prototype` has (`constructor`) reads the inherited value, which
/// is stood for by an empty object.
pub fn bracket_notation(query: &mut Map<String, Value>) {
    let keys: Vec<String> = query.keys().filter(|k| k.contains('[')).cloned().collect();
    for key in keys {
        let value = match query.get(&key) {
            Some(Value::Array(items)) => items
                .iter()
                .map(|v| crate::jsval::string_of(Some(v)))
                .collect::<Vec<_>>()
                .join(","),
            Some(v) => crate::jsval::string_of(Some(v)),
            None => continue,
        };
        let normalized = key.split('[').next().unwrap_or("").to_owned();
        let parsed = super::qs::parse(&format!("{key}={value}"), &super::qs::Options::DEFAULTS)
            .unwrap_or_default();
        let found = parsed
            .get(&normalized)
            .map(super::qs::to_json)
            .or_else(|| super::qs::on_prototype(&normalized).then(|| Value::Object(Map::new())));
        if let Some(parsed) = found {
            let merged = match (query.get(&normalized), &parsed) {
                (Some(existing @ (Value::Object(_) | Value::Array(_))), Value::Object(new)) => {
                    let mut out = match existing {
                        Value::Object(m) => m.clone(),
                        Value::Array(items) => items
                            .iter()
                            .enumerate()
                            .map(|(i, v)| (i.to_string(), v.clone()))
                            .collect(),
                        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {
                            Map::new()
                        }
                    };
                    for (k, v) in new {
                        out.insert(k.clone(), v.clone());
                    }
                    Value::Object(js_ordered(out))
                }
                _ => parsed,
            };
            query.insert(normalized, merged);
        }
        query.shift_remove(&key);
    }
    let ordered = js_ordered(std::mem::take(query));
    *query = ordered;
}

/// Whether `key` is an array index, which JavaScript objects list first.
#[must_use]
pub fn is_array_index(key: &str) -> bool {
    let canonical = key == "0" || (!key.starts_with('0') && !key.is_empty());
    canonical
        && key.len() <= 10
        && key.bytes().all(|b| b.is_ascii_digit())
        && key.parse::<u64>().is_ok_and(|n| n < 4_294_967_295)
}

/// An object's keys in JavaScript property order: array indices first,
/// ascending, then the rest in insertion order.
#[must_use]
pub fn js_ordered(map: Map<String, Value>) -> Map<String, Value> {
    if !map.keys().any(|k| is_array_index(k)) {
        return map;
    }
    let mut indices: Vec<(u64, String, Value)> = Vec::new();
    let mut rest = Map::new();
    for (k, v) in map {
        match k.parse::<u64>() {
            Ok(n) if is_array_index(&k) => indices.push((n, k, v)),
            Ok(_) | Err(_) => {
                rest.insert(k, v);
            }
        }
    }
    indices.sort_by_key(|(n, _, _)| *n);
    let mut out: Map<String, Value> = indices.into_iter().map(|(_, k, v)| (k, v)).collect();
    out.extend(rest);
    out
}

/// A JSON value with every object in JavaScript property order, as
/// `JSON.parse` builds it.
#[must_use]
pub fn js_value(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(js_ordered(
            map.into_iter().map(|(k, v)| (k, js_value(v))).collect(),
        )),
        Value::Array(items) => Value::Array(items.into_iter().map(js_value).collect()),
        other @ (Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)) => other,
    }
}

/// The validator's `parseQueryStringUndecoded`: the raw query with its
/// first `?` dropped, split on `&` and `=`, values undecoded (`None` for a
/// pair without `=`), grouped by raw key.
#[must_use]
pub fn raw_query_pairs(raw: &str) -> Vec<(String, Vec<Option<String>>)> {
    let q = raw.replacen('?', "", 1);
    let mut out: Vec<(String, Vec<Option<String>>)> = Vec::new();
    for pair in q.split('&') {
        let mut parts = pair.split('=');
        let key = parts.next().unwrap_or("").to_owned();
        let value = parts.next().map(str::to_owned);
        match out.iter_mut().find(|(k, _)| *k == key) {
            Some((_, values)) => values.push(value),
            None => out.push((key, vec![value])),
        }
    }
    out
}

/// The validator's `RESERVED_CHARS`.
#[must_use]
pub fn has_reserved(value: &str) -> bool {
    value.chars().any(|c| {
        matches!(
            c,
            ':' | '/'
                | '?'
                | '#'
                | '['
                | ']'
                | '@'
                | '!'
                | '$'
                | '&'
                | '\''
                | '('
                | ')'
                | '*'
                | '+'
                | ','
                | ';'
                | '='
        )
    })
}

/// The headers Node keeps only the first of when they repeat
/// (`IncomingMessage`'s `matchKnownFields`; Bun does the same).
const FIRST_ONLY: [&str; 18] = [
    "content-type",
    "content-length",
    "user-agent",
    "referer",
    "host",
    "authorization",
    "proxy-authorization",
    "if-modified-since",
    "if-unmodified-since",
    "from",
    "location",
    "max-forwards",
    "retry-after",
    "etag",
    "last-modified",
    "server",
    "age",
    "expires",
];

/// One header as Node exposes it (`req.headers[name]`), `None` when absent.
///
/// Repeated lines are joined with `; ` (cookies) or `, `, or only the
/// first is kept for the headers Node keeps once; bytes read as latin-1.
#[must_use]
pub fn node_header(headers: &HeaderMap, name: &str) -> Option<String> {
    let latin1 = |v: &axum::http::HeaderValue| -> String {
        v.as_bytes().iter().map(|b| char::from(*b)).collect()
    };
    let mut values = headers.get_all(name).iter();
    let mut out = latin1(values.next()?);
    if FIRST_ONLY.contains(&name) {
        return Some(out);
    }
    let separator = if name == "cookie" { "; " } else { ", " };
    for v in values {
        out.push_str(separator);
        out.push_str(&latin1(v));
    }
    Some(out)
}

/// `cookie.parse(header)[name]` (cookie 0.7, as cookie-parser uses it).
///
/// The first pair with that name, trimmed of spaces and tabs, one pair of
/// surrounding quotes dropped. The value is undecoded; only whether it is
/// empty matters here.
#[must_use]
pub fn cookie_raw<'c>(header: &'c str, name: &str) -> Option<&'c str> {
    let bytes = header.as_bytes();
    let len = bytes.len();
    if len < 2 {
        return None;
    }
    let mut index = 0;
    loop {
        let eq = find(bytes, b'=', index)?;
        let end = match find(bytes, b';', index) {
            None => len,
            Some(end) if eq > end => {
                index = after_last(bytes, b';', eq);
                continue;
            }
            Some(end) => end,
        };
        let key_start = start_index(bytes, index, eq);
        let key_end = end_index(bytes, eq, key_start);
        if header.get(key_start..key_end) == Some(name) {
            let mut value_start = start_index(bytes, eq + 1, end);
            let mut value_end = end_index(bytes, end, value_start);
            if bytes.get(value_start) == Some(&b'"')
                && value_end > 0
                && bytes.get(value_end - 1) == Some(&b'"')
            {
                value_start += 1;
                value_end = value_end.saturating_sub(1);
            }
            return Some(
                header
                    .get(value_start..value_end.max(value_start))
                    .unwrap_or(""),
            );
        }
        index = end + 1;
        if index >= len {
            return None;
        }
    }
}

fn find(bytes: &[u8], needle: u8, from: usize) -> Option<usize> {
    bytes
        .get(from..)?
        .iter()
        .position(|b| *b == needle)
        .map(|i| i + from)
}

/// `str.lastIndexOf(c, before - 1) + 1`: just past the last `c` before
/// `before`, or 0.
fn after_last(bytes: &[u8], needle: u8, before: usize) -> usize {
    bytes
        .get(..before)
        .and_then(|head| head.iter().rposition(|b| *b == needle))
        .map_or(0, |i| i + 1)
}

fn start_index(bytes: &[u8], mut index: usize, max: usize) -> usize {
    while index < max {
        match bytes.get(index) {
            Some(b' ' | b'\t') => index += 1,
            _ => return index,
        }
    }
    max
}

fn end_index(bytes: &[u8], mut index: usize, min: usize) -> usize {
    while index > min {
        index -= 1;
        match bytes.get(index) {
            Some(b' ' | b'\t') => {}
            _ => return index + 1,
        }
    }
    min
}

/// The validator's `ContentType`: the media type lower-cased, and the
/// parameters its regular expression `/;\s*([^=]+)=([^;]+)/g` finds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentType {
    /// `null` when the header is absent.
    pub media_type: Option<String>,
    parameters: Vec<(String, String)>,
}

impl ContentType {
    #[must_use]
    pub fn parse(header: Option<&str>) -> Self {
        let Some(text) = header.filter(|t| !t.is_empty()) else {
            return Self {
                media_type: None,
                parameters: Vec::new(),
            };
        };
        let mut parameters: Vec<(String, String)> = Vec::new();
        let mut search = 0;
        while let Some(semi) = text.get(search..).and_then(|t| t.find(';')) {
            let at = search + semi;
            match parameter_at(text, at) {
                Some((key, value, end)) => {
                    let key = key.to_lowercase();
                    let value = if key == "charset" {
                        value.to_lowercase()
                    } else {
                        value.to_owned()
                    };
                    if let Some(slot) = parameters.iter_mut().find(|(k, _)| *k == key) {
                        slot.1 = value;
                    } else {
                        parameters.push((key, value));
                    }
                    search = end;
                }
                None => search = at + 1,
            }
        }
        let media = text.split(';').next().unwrap_or("");
        Self {
            media_type: Some(js_trim(&media.to_lowercase()).to_owned()),
            parameters,
        }
    }

    /// `normalize()`: the media type and the sorted parameters but
    /// `boundary`; `None` without a media type (JavaScript `undefined`).
    #[must_use]
    pub fn normalize(&self) -> Option<String> {
        self.normalize_without(&["boundary"])
    }

    fn normalize_without(&self, excluded: &[&str]) -> Option<String> {
        let media = self.media_type.as_ref()?;
        let mut params: Vec<&(String, String)> = self.parameters.iter().collect();
        params.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
        let mut out = media.clone();
        for (k, v) in params {
            if !excluded.contains(&k.as_str()) {
                out.push_str("; ");
                out.push_str(k);
                out.push('=');
                out.push_str(v);
            }
        }
        Some(out)
    }

    /// `equivalents()`: the bare media type and, without a charset, the
    /// type with `charset=utf-8`.
    #[must_use]
    pub fn equivalents(&self) -> Vec<String> {
        let Some(media) = &self.media_type else {
            return Vec::new();
        };
        let mut out = vec![media.clone()];
        if !self
            .parameters
            .iter()
            .any(|(k, v)| k == "charset" && !v.is_empty())
        {
            let base = self.normalize_without(&["charset"]).unwrap_or_default();
            out.push(
                Self::parse(Some(&format!("{base}; charset=utf-8")))
                    .normalize()
                    .unwrap_or_default(),
            );
        }
        out
    }

    /// A parameter's value.
    #[must_use]
    pub fn parameter(&self, name: &str) -> Option<&str> {
        self.parameters
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

/// One match of `;\s*([^=]+)=([^;]+)` starting at the `;` at `at`: key,
/// value and where the match ends.
fn parameter_at(text: &str, at: usize) -> Option<(&str, &str, usize)> {
    let rest = text.get(at + 1..)?;
    let eq = rest.find('=')?;
    let run = rest.get(..eq)?;
    if run.is_empty() {
        return None;
    }
    let trimmed = run.trim_start_matches(is_js_space);
    // `\s*` gives back one character when the key would be empty.
    let key = if trimmed.is_empty() {
        run.char_indices()
            .last()
            .and_then(|(i, _)| run.get(i..))
            .unwrap_or(run)
    } else {
        trimmed
    };
    let after = rest.get(eq + 1..)?;
    let value_len = after.find(';').unwrap_or(after.len());
    if value_len == 0 {
        return None;
    }
    let value = after.get(..value_len)?;
    Some((key, value, at + 1 + eq + 1 + value_len))
}

const fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// The `content-type` package's `parse` (what body-parser and type-is use):
/// the lower-cased media type and parameters, `None` where it throws.
#[must_use]
pub fn strict_content_type(header: &str) -> Option<(String, Vec<(String, String)>)> {
    let tchar = |c: char| c.is_ascii_alphanumeric() || "!#$%&'*+.^_`|~-".contains(c);
    let (media, mut rest) = match header.find(';') {
        Some(i) => (header.get(..i)?, header.get(i..)?),
        None => (header, ""),
    };
    let media = js_trim(media);
    let (kind, sub) = media.split_once('/')?;
    if kind.is_empty() || sub.is_empty() || !kind.chars().all(tchar) || !sub.chars().all(tchar) {
        return None;
    }
    let mut params = Vec::new();
    let skip_spaces = |s: &str| s.trim_start_matches(' ').to_owned();
    while !rest.is_empty() {
        // `; *token *= *(token|quoted-string) *`
        let after = skip_spaces(rest.strip_prefix(';')?);
        let key_len = after.find(|c: char| !tchar(c)).unwrap_or(after.len());
        if key_len == 0 {
            return None;
        }
        let key = after.get(..key_len)?.to_ascii_lowercase();
        let after = skip_spaces(after.get(key_len..)?);
        let after = skip_spaces(after.strip_prefix('=')?);
        let (value, used) = if let Some(quoted) = after.strip_prefix('"') {
            let mut value = String::new();
            let mut chars = quoted.char_indices();
            let mut end = None;
            while let Some((i, c)) = chars.next() {
                match c {
                    '"' => {
                        end = Some(i + 2);
                        break;
                    }
                    '\\' => match chars.next() {
                        Some((_, e)) if e == '\u{b}' || (' '..='\u{ff}').contains(&e) => {
                            value.push(e);
                        }
                        _ => return None,
                    },
                    c if c == '\u{b}'
                        || c == ' '
                        || c == '!'
                        || ('#'..='\u{7e}').contains(&c)
                        || ('\u{80}'..='\u{ff}').contains(&c) =>
                    {
                        value.push(c);
                    }
                    _ => return None,
                }
            }
            (value, end?)
        } else {
            let len = after.find(|c: char| !tchar(c)).unwrap_or(after.len());
            if len == 0 {
                return None;
            }
            (after.get(..len)?.to_owned(), len)
        };
        let tail = skip_spaces(after.get(used..)?);
        if !tail.is_empty() && !tail.starts_with(';') {
            return None;
        }
        if let Some(slot) = params
            .iter_mut()
            .find(|(k, _): &&mut (String, String)| *k == key)
        {
            slot.1 = value;
        } else {
            params.push((key, value));
        }
        rest = header.get(header.len() - tail.len()..)?;
    }
    Some((media.to_ascii_lowercase(), params))
}

/// `typeis.hasBody(req)`: a `Transfer-Encoding` header, or a
/// `Content-Length` that `isNaN` accepts.
#[must_use]
pub fn has_body(headers: &HeaderMap) -> bool {
    if headers.contains_key(axum::http::header::TRANSFER_ENCODING) {
        return true;
    }
    node_header(headers, "content-length")
        .is_some_and(|v| !crate::jsval::number_of_str(&v).is_nan())
}

/// The most of a request body any layer buffers.
///
/// Four times body-parser's limit, past what `express.json()` or
/// `express.urlencoded()` would read even compressed, so Node answers a
/// JSON or form body that big with the parser's 413 too. Node doesn't
/// read other bodies; one that big gets the same 413 here rather than
/// being held in memory.
pub const BUFFER_LIMIT: usize = 4 * super::bodyparser::LIMIT;

/// Why a request body wasn't buffered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unbuffered {
    /// Past [`BUFFER_LIMIT`].
    TooLarge,
    /// Reading it failed.
    Failed,
}

impl Unbuffered {
    /// body-parser's `{ message }` for [`Unbuffered::TooLarge`].
    #[must_use]
    pub fn too_large_body() -> Value {
        serde_json::json!({ "message": "request entity too large" })
    }

    /// The answer: body-parser's 413, or a bare 400.
    #[must_use]
    pub fn response(
        self,
        method: &axum::http::Method,
        headers: &HeaderMap,
    ) -> axum::http::Response<axum::body::Body> {
        match self {
            Self::TooLarge => {
                crate::respond::json_status(413, method, headers, &Self::too_large_body())
            }
            Self::Failed => {
                let mut res = axum::http::Response::new(axum::body::Body::empty());
                *res.status_mut() = axum::http::StatusCode::BAD_REQUEST;
                res
            }
        }
    }
}

/// A request body, read up to [`BUFFER_LIMIT`].
///
/// # Errors
///
/// [`Unbuffered`] when it is bigger or reading it fails.
pub async fn buffer(body: axum::body::Body) -> Result<bytes::Bytes, Unbuffered> {
    use http_body_util::BodyExt;
    match http_body_util::Limited::new(body, BUFFER_LIMIT)
        .collect()
        .await
    {
        Ok(collected) => Ok(collected.to_bytes()),
        Err(e) if e.is::<http_body_util::LengthLimitError>() => Err(Unbuffered::TooLarge),
        Err(e) => {
            tracing::debug!("reading a request body failed: {e}");
            Err(Unbuffered::Failed)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn buffers_up_to_the_limit() {
        let body = |n: usize| axum::body::Body::from(vec![b'x'; n]);
        assert_eq!(
            buffer(body(BUFFER_LIMIT)).await.map(|b| b.len()),
            Ok(BUFFER_LIMIT),
            "at the limit"
        );
        assert_eq!(
            buffer(body(BUFFER_LIMIT + 1)).await,
            Err(Unbuffered::TooLarge),
            "past it"
        );
    }

    #[test]
    fn query_strings_parse_like_querystring() {
        let q = parse_query("b=1&a=x+y&b=2&2=z&1&c=%41");
        assert_eq!(
            Value::Object(q),
            serde_json::json!({"1": "", "2": "z", "b": ["1", "2"], "a": "x y", "c": "A"}),
            "order, arrays, plus and percent decoding"
        );
        assert_eq!(
            parse_query("a=%ZZ%41").get("a"),
            Some(&Value::from("%ZZA")),
            "lenient fallback"
        );
        let mut q = parse_query("a[b]=1&c[]=2&d[0]=3");
        bracket_notation(&mut q);
        assert_eq!(
            Value::Object(q),
            serde_json::json!({"a": {"b": "1"}, "c": ["2"], "d": ["3"]}),
            "qs shapes"
        );
    }

    #[test]
    fn raw_pairs_keep_encoding() {
        let pairs = raw_query_pairs("a=1,2&b&a=x=y?z");
        assert_eq!(
            pairs,
            vec![
                (
                    String::from("a"),
                    vec![Some(String::from("1,2")), Some(String::from("x"))]
                ),
                (String::from("b"), vec![None]),
            ],
            "split on & and ="
        );
        assert!(
            has_reserved("1,2") && !has_reserved("a%2Cb"),
            "reserved characters"
        );
    }

    #[test]
    fn cookies_parse_like_the_cookie_package() {
        assert_eq!(
            cookie_raw("a=1; connect.sid=s%3Ax", "connect.sid"),
            Some("s%3Ax"),
            "second pair"
        );
        assert_eq!(cookie_raw("connect.sid=", "connect.sid"), Some(""), "empty");
        assert_eq!(
            cookie_raw("connect.sid=\"\"", "connect.sid"),
            Some(""),
            "quoted empty"
        );
        assert_eq!(
            cookie_raw("connect.sid=a; connect.sid=b", "connect.sid"),
            Some("a"),
            "first wins"
        );
        assert_eq!(
            cookie_raw("x; connect.sid=y", "connect.sid"),
            Some("y"),
            "pair without ="
        );
        assert_eq!(cookie_raw("other=1", "connect.sid"), None, "absent");
    }

    #[test]
    fn content_types_normalize() {
        let ct = ContentType::parse(Some("Text/Plain; charset=UTF-8; a=b"));
        assert_eq!(
            ct.normalize().as_deref(),
            Some("text/plain; a=b; charset=utf-8"),
            "sorted params"
        );
        assert_eq!(ContentType::parse(None).normalize(), None, "absent");
        let json = ContentType::parse(Some("application/json"));
        assert_eq!(
            json.equivalents(),
            vec![
                String::from("application/json"),
                String::from("application/json; charset=utf-8")
            ],
            "equivalents"
        );
    }

    #[test]
    fn strict_content_types() {
        let parsed = strict_content_type("Application/JSON; Charset=\"utf-8\"");
        assert_eq!(
            parsed,
            Some((
                String::from("application/json"),
                vec![(String::from("charset"), String::from("utf-8"))]
            )),
            "quoted parameter"
        );
        assert!(
            strict_content_type("application/json; foo").is_none(),
            "parameter without value"
        );
        assert!(
            strict_content_type("application/json;").is_none(),
            "trailing semicolon"
        );
        assert!(
            strict_content_type("application/json, text/plain").is_none(),
            "a list"
        );
    }

    #[test]
    fn array_indices_sort_first() {
        assert!(
            is_array_index("0") && is_array_index("42") && !is_array_index("01"),
            "indices"
        );
        assert!(
            !is_array_index("4294967295") && !is_array_index("-1"),
            "out of range"
        );
    }
}
