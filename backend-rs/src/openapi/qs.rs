//! `qs` 6.14.1's `parse`, with the options its two callers here use:
//! `express.urlencoded({ extended: true })` (body-parser 2.2.2) and the
//! validator's bracket-notation query fields (`qs.parse` defaults).
//!
//! Values follow JavaScript's rules where they show: object keys iterate
//! integer keys first, arrays can have holes until `compact`, objects past
//! `arrayLimit` are "overflow" objects that keep appending.

use serde_json::{Map, Value};

/// The parse options that differ between the callers.
#[derive(Debug, Clone, Copy)]
pub(super) struct Options {
    pub(super) allow_prototypes: bool,
    pub(super) array_limit: usize,
    pub(super) depth: usize,
    pub(super) latin1: bool,
    pub(super) parameter_limit: usize,
    pub(super) strict_depth: bool,
}

impl Options {
    /// `qs.parse(text)` with the defaults.
    pub(super) const DEFAULTS: Self = Self {
        allow_prototypes: false,
        array_limit: 20,
        depth: 5,
        latin1: false,
        parameter_limit: 1000,
        strict_depth: false,
    };
}

/// `Input depth exceeded depth option of N and strictDepth is true`.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct DepthExceeded;

/// A parsed value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Q {
    Str(String),
    /// `target[source] = true` of a merge.
    True,
    /// An array; `None` is a hole.
    Arr(Vec<Option<Self>>),
    Obj(Obj),
}

/// A plain object: keys in insertion order (iterated JavaScript's way by
/// [`Obj::keys`]), and the highest index when it is an overflow object.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct Obj {
    entries: Vec<(String, Q)>,
    overflow: Option<usize>,
}

/// An array index key (`"0"`, `"17"`; not `"01"`, not past 2^32 - 2).
fn index_key(key: &str) -> Option<u32> {
    if key.is_empty()
        || (key.len() > 1 && key.starts_with('0'))
        || !key.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    key.parse::<u32>().ok().filter(|n| *n < u32::MAX)
}

/// `Object.prototype`'s own property names.
const PROTOTYPE_KEYS: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

/// `has.call(Object.prototype, key)`.
pub(super) fn on_prototype(key: &str) -> bool {
    PROTOTYPE_KEYS.contains(&key)
}

impl Obj {
    pub(super) fn get(&self, key: &str) -> Option<&Q> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    fn set(&mut self, key: &str, value: Q) {
        if let Some(slot) = self.entries.iter_mut().find(|(k, _)| k == key) {
            slot.1 = value;
        } else {
            self.entries.push((key.to_owned(), value));
        }
    }

    fn take(&mut self, key: &str) -> Option<Q> {
        let at = self.entries.iter().position(|(k, _)| k == key)?;
        Some(self.entries.remove(at).1)
    }

    /// `Object.keys`: integer keys ascending, then the rest in order.
    pub(super) fn keys(&self) -> Vec<String> {
        let mut ints: Vec<(u32, &String)> = self
            .entries
            .iter()
            .filter_map(|(k, _)| index_key(k).map(|n| (n, k)))
            .collect();
        ints.sort_unstable_by_key(|(n, _)| *n);
        let mut out: Vec<String> = ints.into_iter().map(|(_, k)| k.clone()).collect();
        out.extend(
            self.entries
                .iter()
                .filter(|(k, _)| index_key(k).is_none())
                .map(|(k, _)| k.clone()),
        );
        out
    }
}

/// `utils.decode`: `+` is a space, then `decodeURIComponent` (the text
/// as it is where that throws), or `unescape` of `%XX` for latin-1.
fn decode(text: &str, latin1: bool) -> String {
    let spaced = text.replace('+', " ");
    if latin1 {
        let bytes = spaced.as_bytes();
        let mut out = String::with_capacity(spaced.len());
        let mut i = 0;
        let mut start = 0;
        while let Some(&b) = bytes.get(i) {
            let hex = |at: usize| bytes.get(at).and_then(|c| char::from(*c).to_digit(16));
            if b == b'%' {
                if let (Some(h), Some(l)) = (hex(i + 1), hex(i + 2)) {
                    out.push_str(spaced.get(start..i).unwrap_or(""));
                    out.push(char::from_u32(h * 16 + l).unwrap_or('\u{fffd}'));
                    i += 3;
                    start = i;
                    continue;
                }
            }
            i += 1;
        }
        out.push_str(spaced.get(start..).unwrap_or(""));
        return out;
    }
    crate::jsval::decode_uri_component(&spaced).unwrap_or(spaced)
}

/// `[].concat(a, b)`: arrays spread (holes kept), anything else appended.
fn concat(a: Q, b: Q) -> Vec<Option<Q>> {
    let mut out = Vec::new();
    for v in [a, b] {
        match v {
            Q::Arr(items) => out.extend(items),
            other @ (Q::Str(_) | Q::True | Q::Obj(_)) => out.push(Some(other)),
        }
    }
    out
}

/// `utils.arrayToObject`.
fn array_to_object(items: Vec<Option<Q>>) -> Obj {
    let mut obj = Obj::default();
    for (i, v) in items.into_iter().enumerate() {
        if let Some(v) = v {
            obj.set(&i.to_string(), v);
        }
    }
    obj
}

/// `utils.combine(a, b, arrayLimit)`.
fn combine(a: Q, b: Q, limit: usize) -> Q {
    if let Q::Obj(mut obj) = a {
        if let Some(max) = obj.overflow {
            obj.set(&(max + 1).to_string(), b);
            obj.overflow = Some(max + 1);
            return Q::Obj(obj);
        }
        return combine_plain(Q::Obj(obj), b, limit);
    }
    combine_plain(a, b, limit)
}

fn combine_plain(a: Q, b: Q, limit: usize) -> Q {
    let result = concat(a, b);
    if result.len() > limit {
        let max = result.len() - 1;
        let mut obj = array_to_object(result);
        obj.overflow = Some(max);
        return Q::Obj(obj);
    }
    Q::Arr(result)
}

/// `parseValues`: the pairs, keys decoded, repeated keys combined.
fn parse_values(text: &str, o: &Options) -> Obj {
    let clean = replace_ci(&replace_ci(text, "%5B", "["), "%5D", "]");
    let mut obj = Obj::default();
    for part in clean.split('&').take(o.parameter_limit) {
        let pos = part.find("]=").map(|at| at + 1).or_else(|| part.find('='));
        let (key, val) = pos.map_or_else(
            || (decode(part, o.latin1), String::new()),
            |at| {
                (
                    decode(part.get(..at).unwrap_or(""), o.latin1),
                    decode(part.get(at + 1..).unwrap_or(""), o.latin1),
                )
            },
        );
        let val = Q::Str(val);
        // `obj[key] = combine(obj[key], val)` keeps the key's place.
        let combined = match obj.get(&key) {
            Some(existing) => combine(existing.clone(), val, o.array_limit),
            None => val,
        };
        obj.set(&key, combined);
    }
    obj
}

/// `str.replace(/needle/gi, with)` for an ASCII needle.
fn replace_ci(text: &str, needle: &str, with: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let needle_lower = needle.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while let Some(found) = lower.get(i..).and_then(|rest| rest.find(&needle_lower)) {
        out.push_str(text.get(i..i + found).unwrap_or(""));
        out.push_str(with);
        i += found + needle.len();
    }
    out.push_str(text.get(i..).unwrap_or(""));
    out
}

/// The first `[...]` group (no brackets inside) at or after `from`:
/// its start and end (past the `]`).
fn bracket_group(key: &str, from: usize) -> Option<(usize, usize)> {
    let bytes = key.as_bytes();
    let mut i = from;
    while let Some(&b) = bytes.get(i) {
        if b == b'[' {
            let mut j = i + 1;
            while let Some(&c) = bytes.get(j) {
                if c == b']' {
                    return Some((i, j + 1));
                }
                if c == b'[' {
                    break;
                }
                j += 1;
            }
            if bytes.get(j) == Some(&b'[') {
                i = j;
                continue;
            }
            return None;
        }
        i += 1;
    }
    None
}

/// `splitKeyIntoSegments`; `Ok(None)` when a prototype key drops it.
fn split_key(key: &str, o: &Options) -> Result<Option<Vec<String>>, DepthExceeded> {
    if o.depth == 0 {
        if !o.allow_prototypes && on_prototype(key) {
            return Ok(None);
        }
        return Ok(Some(vec![key.to_owned()]));
    }
    let first = bracket_group(key, 0);
    let parent = first.map_or(key, |(start, _)| key.get(..start).unwrap_or(""));
    let mut keys = Vec::new();
    if !parent.is_empty() {
        if !o.allow_prototypes && on_prototype(parent) {
            return Ok(None);
        }
        keys.push(parent.to_owned());
    }
    let mut at = 0;
    let mut count = 0;
    let mut pending = bracket_group(key, at);
    while let Some((start, end)) = pending {
        if count >= o.depth {
            break;
        }
        count += 1;
        let segment = key.get(start..end).unwrap_or("");
        let content = segment.get(1..segment.len() - 1).unwrap_or("");
        if !o.allow_prototypes && on_prototype(content) {
            return Ok(None);
        }
        keys.push(segment.to_owned());
        at = end;
        pending = bracket_group(key, at);
    }
    if let Some((start, _)) = pending {
        if o.strict_depth {
            return Err(DepthExceeded);
        }
        keys.push(format!("[{}]", key.get(start..).unwrap_or("")));
    }
    Ok(Some(keys))
}

/// `parseObject(chain, leaf)`.
fn parse_object(chain: &[String], leaf: Q, o: &Options) -> Q {
    let mut leaf = leaf;
    for root in chain.iter().rev() {
        if root == "[]" {
            leaf = match leaf {
                overflow @ Q::Obj(Obj {
                    overflow: Some(_), ..
                }) => overflow,
                other @ (Q::Str(_) | Q::True | Q::Arr(_) | Q::Obj(_)) => {
                    combine_plain(Q::Arr(Vec::new()), other, o.array_limit)
                }
            };
            continue;
        }
        let clean = if root.len() >= 2 && root.starts_with('[') && root.ends_with(']') {
            root.get(1..root.len() - 1).unwrap_or("")
        } else {
            root.as_str()
        };
        let index = (root != clean)
            .then(|| index_key(clean))
            .flatten()
            .and_then(|n| usize::try_from(n).ok())
            .filter(|n| *n <= o.array_limit);
        leaf = if let Some(index) = index {
            let mut items = vec![None; index];
            items.push(Some(leaf));
            Q::Arr(items)
        } else {
            let mut obj = Obj::default();
            if clean != "__proto__" {
                obj.set(clean, leaf);
            }
            Q::Obj(obj)
        };
    }
    leaf
}

/// `utils.merge(target, source)`.
fn merge(target: Q, source: Q, o: &Options) -> Q {
    if matches!(&source, Q::Str(s) if s.is_empty()) {
        return target;
    }
    match source {
        Q::Str(_) | Q::True => merge_primitive(target, source, o),
        Q::Arr(_) | Q::Obj(_) => merge_object(target, source, o),
    }
}

fn merge_primitive(target: Q, source: Q, o: &Options) -> Q {
    match target {
        Q::Arr(mut items) => {
            items.push(Some(source));
            Q::Arr(items)
        }
        Q::Obj(mut obj) => {
            if let Some(max) = obj.overflow {
                obj.set(&(max + 1).to_string(), source);
                obj.overflow = Some(max + 1);
            } else {
                let key = match &source {
                    Q::Str(s) => s.clone(),
                    Q::True | Q::Arr(_) | Q::Obj(_) => String::from("true"),
                };
                if o.allow_prototypes || !on_prototype(&key) {
                    obj.set(&key, Q::True);
                }
            }
            Q::Obj(obj)
        }
        primitive @ (Q::Str(_) | Q::True) => Q::Arr(vec![Some(primitive), Some(source)]),
    }
}

fn merge_object(target: Q, source: Q, o: &Options) -> Q {
    let target = match target {
        primitive @ (Q::Str(_) | Q::True) => {
            if let Q::Obj(src) = &source {
                if let Some(max) = src.overflow {
                    let mut result = Obj::default();
                    result.set("0", primitive);
                    for key in src.keys() {
                        let shifted = key
                            .parse::<usize>()
                            .map_or_else(|_| key.clone(), |n| (n + 1).to_string());
                        if let Some(v) = src.get(&key) {
                            result.set(&shifted, v.clone());
                        }
                    }
                    result.overflow = Some(max + 1);
                    return Q::Obj(result);
                }
            }
            return Q::Arr(concat(primitive, source));
        }
        other @ (Q::Arr(_) | Q::Obj(_)) => other,
    };
    match (target, source) {
        (Q::Arr(mut items), Q::Arr(src)) => {
            for (i, item) in src.into_iter().enumerate() {
                let Some(item) = item else { continue };
                match items.get_mut(i) {
                    Some(slot @ Some(_)) => {
                        let existing = slot.take();
                        match existing {
                            Some(existing @ (Q::Arr(_) | Q::Obj(_)))
                                if matches!(item, Q::Arr(_) | Q::Obj(_)) =>
                            {
                                *slot = Some(merge(existing, item, o));
                            }
                            other => {
                                *slot = other;
                                items.push(Some(item));
                            }
                        }
                    }
                    Some(hole) => *hole = Some(item),
                    None => {
                        items.resize(i, None);
                        items.push(Some(item));
                    }
                }
            }
            Q::Arr(items)
        }
        (target, source) => {
            let mut acc = match target {
                Q::Arr(items) => array_to_object(items),
                Q::Obj(obj) => obj,
                Q::Str(_) | Q::True => Obj::default(),
            };
            let (keys, mut entries): (Vec<String>, Obj) = match source {
                Q::Obj(obj) => (obj.keys(), obj),
                Q::Arr(items) => {
                    let obj = array_to_object(items);
                    (obj.keys(), obj)
                }
                Q::Str(_) | Q::True => (Vec::new(), Obj::default()),
            };
            for key in keys {
                let Some(value) = entries.take(&key) else {
                    continue;
                };
                match acc.entries.iter().position(|(k, _)| *k == key) {
                    Some(at) => {
                        let (_, existing) = acc.entries.remove(at);
                        acc.entries.insert(at, (key, merge(existing, value, o)));
                    }
                    None => acc.entries.push((key, value)),
                }
            }
            Q::Obj(acc)
        }
    }
}

/// `utils.compact`: every nested array without its holes.
fn compact(value: Q) -> Q {
    match value {
        Q::Arr(items) => Q::Arr(
            items
                .into_iter()
                .flatten()
                .map(|v| Some(compact(v)))
                .collect(),
        ),
        Q::Obj(mut obj) => {
            obj.entries = obj
                .entries
                .into_iter()
                .map(|(k, v)| (k, compact(v)))
                .collect();
            Q::Obj(obj)
        }
        other @ (Q::Str(_) | Q::True) => other,
    }
}

/// `qs.parse(text, options)`.
pub(super) fn parse(text: &str, o: &Options) -> Result<Obj, DepthExceeded> {
    if text.is_empty() {
        return Ok(Obj::default());
    }
    let temp = parse_values(text, o);
    let mut obj = Q::Obj(Obj::default());
    for key in temp.keys() {
        if key.is_empty() {
            continue;
        }
        let Some(chain) = split_key(&key, o)? else {
            continue;
        };
        let Some(value) = temp.get(&key).cloned() else {
            continue;
        };
        let parsed = parse_object(&chain, value, o);
        obj = merge(obj, parsed, o);
    }
    match compact(obj) {
        Q::Obj(obj) => Ok(obj),
        Q::Arr(_) | Q::Str(_) | Q::True => Ok(Obj::default()),
    }
}

/// A parsed value as JSON (keys in JavaScript's order).
pub(super) fn to_json(value: &Q) -> Value {
    match value {
        Q::Str(s) => Value::from(s.as_str()),
        Q::True => Value::Bool(true),
        Q::Arr(items) => Value::Array(
            items
                .iter()
                .map(|v| v.as_ref().map_or(Value::Null, to_json))
                .collect(),
        ),
        Q::Obj(obj) => Value::Object(obj_json(obj)),
    }
}

/// An object as JSON.
pub(super) fn obj_json(obj: &Obj) -> Map<String, Value> {
    let mut out = Map::new();
    for key in obj.keys() {
        if let Some(v) = obj.get(&key) {
            out.insert(key, to_json(v));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(text: &str) -> String {
        let o = Options {
            allow_prototypes: true,
            array_limit: 100,
            depth: 32,
            latin1: false,
            parameter_limit: 1000,
            strict_depth: true,
        };
        parse(text, &o).map_or_else(
            |_| String::from("depth"),
            |obj| Value::Object(obj_json(&obj)).to_string(),
        )
    }

    /// Bun 1.4.1 with body-parser 2.2.2's `urlencoded({ extended: true })`.
    #[test]
    fn parses_like_body_parser() {
        assert_eq!(
            body("a[b][c]=1&a[b][d]=2&x[]=1&x[]=2&y[3]=z&constructor=1&__proto__[q]=1"),
            r#"{"a":{"b":{"c":"1","d":"2"}},"x":["1","2"],"y":["z"],"constructor":"1"}"#,
            "nesting, arrays, prototype keys"
        );
        assert_eq!(
            body(&format!("a{}=1", "[b]".repeat(33))),
            "depth",
            "strict depth"
        );
        assert_eq!(
            body("b=1&2=x&a=3"),
            r#"{"2":"x","b":"1","a":"3"}"#,
            "integer keys first"
        );
        assert_eq!(body("a=1&a=2&a"), r#"{"a":["1","2",""]}"#, "repeated keys");
        assert_eq!(
            body("a=&a[x]=1"),
            r#"{"a":["",{"x":"1"}]}"#,
            "a value and an object"
        );
        assert_eq!(
            body("a%5Bb%5D=1+2"),
            r#"{"a":{"b":"1 2"}}"#,
            "encoded brackets, plus"
        );
        assert_eq!(body("a=%ZZ"), r#"{"a":"%ZZ"}"#, "a bad escape stays");
    }
}
