//! The pure parts of `server/api/trakt` and `lib/trakt/mixedPagination.ts`.
//!
//! How Trakt payloads become `TraktMediaItem`s and `TraktListMetadata`,
//! `parseListUrl`, and the page slicing. Items stay JSON objects in Node's
//! key order, since they travel through Node's mapping routes.

use serde_json::{Map, Number, Value};

use crate::media::js_string;
use crate::settings::public::truthy;

/// A page of items and whether another may follow.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Paged {
    /// The items of the page.
    pub items: Vec<Value>,
    /// Whether another page may exist.
    pub has_more: bool,
}

/// `TraktListSortBy`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortBy {
    /// Newest `listed_at` / `watched_at` first.
    Added,
    /// Newest release first.
    Released,
}

impl SortBy {
    /// The query value as Node spells it.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Added => "added",
            Self::Released => "released",
        }
    }
}

/// `Number(text)`.
#[must_use]
pub fn js_number_of_text(text: &str) -> f64 {
    let t = text.trim();
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
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
        return u64::from_str_radix(digits, radix)
            .ok()
            .and_then(|n| n.to_string().parse::<f64>().ok())
            .unwrap_or(f64::NAN);
    }
    let plain = t
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'-' | b'+' | b'e' | b'E'));
    if !plain {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Number(value)`; `None` is `undefined`.
#[must_use]
pub fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None | Some(Value::Object(_)) => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => js_number_of_text(s),
        Some(Value::Array(items)) => match items.as_slice() {
            [] => 0.0,
            [one @ (Value::Number(_) | Value::String(_))] => js_number(Some(one)),
            _ => f64::NAN,
        },
    }
}

/// A JavaScript number as `JSON.stringify` writes it: whole numbers as
/// integers, `NaN` and infinities as `null`.
#[must_use]
pub fn num_value(n: f64) -> Value {
    if !n.is_finite() {
        return Value::Null;
    }
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        if let Ok(i) = format!("{n:.0}").parse::<i64>() {
            return Value::from(i);
        }
    }
    Number::from_f64(n).map_or(Value::Null, Value::Number)
}

/// `String(n)` for a JavaScript number.
#[must_use]
pub fn num_text(n: f64) -> String {
    js_string(Some(&num_value(n))).into_owned()
}

fn positive(n: f64) -> Option<f64> {
    (n.is_finite() && n > 0.0).then_some(n)
}

/// `value?.trim() || undefined`: an error when the value is there but
/// isn't a string.
fn trimmed(value: Option<&Value>) -> Result<Option<String>, String> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => {
            let t = s.trim();
            Ok((!t.is_empty()).then(|| t.to_owned()))
        }
        Some(Value::Bool(_) | Value::Number(_) | Value::Array(_) | Value::Object(_)) => {
            Err(String::from("a Trakt field that should be text isn't"))
        }
    }
}

/// `a || b`: the first truthy value.
fn or<'v>(a: Option<&'v Value>, b: Option<&'v Value>) -> Option<&'v Value> {
    if truthy(a) {
        a
    } else {
        b.filter(|v| truthy(Some(v)))
    }
}

/// `normalizeMediaItem`.
///
/// # Errors
///
/// Fails on an answer of an unexpected shape.
pub fn normalize_media_item(
    item: Option<&Value>,
    media_type: &str,
) -> Result<Option<Map<String, Value>>, String> {
    let Some(item) = item.filter(|v| truthy(Some(v))) else {
        return Ok(None);
    };
    let ids = item.get("ids");
    let id = |key: &str| ids.and_then(|i| i.get(key));
    let tmdb_id = positive(js_number(id("tmdb")));
    let slug = trimmed(id("slug"))?;
    let trakt_id = positive(js_number(id("trakt")));
    let imdb_id = trimmed(id("imdb"))?;
    let tvdb = positive(js_number(id("tvdb")));
    if tmdb_id.is_none() && slug.is_none() && trakt_id.is_none() {
        return Ok(None);
    }
    let community = match item.get("rating") {
        None | Some(Value::Null) => None,
        rating @ Some(_) => Some(js_number(rating)).filter(|n| n.is_finite()),
    };
    let title = or(item.get("title"), item.get("name"))
        .cloned()
        .unwrap_or_else(|| {
            slug.clone()
                .or_else(|| trakt_id.map(num_text))
                .map_or_else(|| Value::from(""), Value::from)
        });
    let mut out = Map::new();
    if let Some(tmdb_id) = tmdb_id {
        out.insert(String::from("tmdbId"), num_value(tmdb_id));
    }
    out.insert(String::from("mediaType"), Value::from(media_type));
    out.insert(String::from("title"), title);
    if let Some(year) = item.get("year") {
        out.insert(String::from("year"), year.clone());
    }
    if let Some(slug) = slug {
        out.insert(String::from("traktSlug"), Value::from(slug));
    }
    if let Some(trakt_id) = trakt_id {
        out.insert(String::from("traktId"), num_value(trakt_id));
    }
    if let Some(imdb_id) = imdb_id {
        out.insert(String::from("imdbId"), Value::from(imdb_id));
    }
    if let Some(tvdb) = tvdb {
        out.insert(String::from("tvdbId"), num_value(tvdb));
    }
    if let Some(rating) = community {
        out.insert(String::from("traktCommunityRating"), num_value(rating));
    }
    Ok(Some(out))
}

/// `for (const entry of payload || [])`: the entries, or the `TypeError`
/// of a payload that can't be iterated. A string iterates characters,
/// none of which is an entry.
fn entries(payload: Option<&Value>) -> Result<&[Value], String> {
    match payload {
        Some(Value::Array(items)) => Ok(items.as_slice()),
        Some(Value::String(_) | Value::Null) | None => Ok(&[]),
        Some(v @ (Value::Bool(_) | Value::Number(_))) if !truthy(Some(v)) => Ok(&[]),
        Some(Value::Bool(_) | Value::Number(_) | Value::Object(_)) => {
            Err(String::from("a Trakt answer that should be a list isn't"))
        }
    }
}

/// `entry.<key>` where a `null` entry throws.
fn field<'v>(entry: &'v Value, key: &str) -> Result<Option<&'v Value>, String> {
    if entry.is_null() {
        return Err(format!("a Trakt entry is null where {key} was expected"));
    }
    Ok(entry.get(key))
}

/// `normalizeListItems`.
///
/// # Errors
///
/// Fails on an answer of an unexpected shape.
pub fn normalize_list_items(payload: Option<&Value>) -> Result<Vec<Value>, String> {
    let mut items = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for entry in entries(payload)? {
        let normalized = match field(entry, "type")?.and_then(Value::as_str) {
            Some("movie") => normalize_media_item(entry.get("movie"), "movie")?,
            Some("show" | "episode") => normalize_media_item(entry.get("show"), "tv")?,
            _ => None,
        };
        let Some(mut normalized) = normalized else {
            continue;
        };
        let key = item_key(&Value::Object(normalized.clone()));
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        let media = or(entry.get("movie"), entry.get("show"));
        if let Some(sort_at) = or(entry.get("listed_at"), entry.get("watched_at")) {
            normalized.insert(String::from("traktAddedAt"), sort_at.clone());
        }
        let release = media.and_then(|m| or(m.get("released"), m.get("first_aired")));
        if let Some(release) = release {
            normalized.insert(String::from("traktReleaseDate"), release.clone());
        }
        items.push(Value::Object(normalized));
    }
    Ok(items)
}

/// `normalizeRecommendationItems`.
///
/// # Errors
///
/// Fails on an answer of an unexpected shape.
pub fn normalize_recommendation_items(
    payload: Option<&Value>,
    media_type: &str,
) -> Result<Vec<Value>, String> {
    let mut items = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for entry in entries(payload)? {
        let Some(normalized) = normalize_media_item(Some(entry), media_type)? else {
            continue;
        };
        let normalized = Value::Object(normalized);
        let key = item_key(&normalized);
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        items.push(normalized);
    }
    Ok(items)
}

/// `getChartItems`' wrapping: `{ type: key, [key]: entry[key] ?? entry }`.
///
/// # Errors
///
/// Fails on an answer of an unexpected shape (`.map` of a non-array,
/// a `null` entry).
pub fn chart_entries(payload: Option<&Value>, key: &str) -> Result<Value, String> {
    let list: &[Value] = match payload {
        Some(Value::Array(items)) => items,
        None | Some(Value::Null) => &[],
        Some(v) if !truthy(Some(v)) => &[],
        Some(_) => return Err(String::from("a Trakt answer that should be a list isn't")),
    };
    let mut out = Vec::with_capacity(list.len());
    for entry in list {
        let media = match field(entry, key)? {
            None | Some(Value::Null) => entry.clone(),
            Some(media) => media.clone(),
        };
        let mut wrapped = Map::new();
        wrapped.insert(String::from("type"), Value::from(key));
        wrapped.insert(key.to_owned(), media);
        out.push(Value::Object(wrapped));
    }
    Ok(Value::Array(out))
}

/// `traktItemKey`.
#[must_use]
pub fn item_key(item: &Value) -> String {
    let media_type = js_string(item.get("mediaType"));
    let tmdb = item.get("tmdbId");
    if truthy(tmdb) && js_number(tmdb) > 0.0 {
        return format!("{media_type}:tmdb:{}", js_string(tmdb));
    }
    let slug = item.get("traktSlug");
    if truthy(slug) {
        return format!("{media_type}:slug:{}", js_string(slug));
    }
    let trakt = item.get("traktId");
    if truthy(trakt) && js_number(trakt) > 0.0 {
        return format!("{media_type}:trakt:{}", js_string(trakt));
    }
    let title = match item.get("title") {
        None | Some(Value::Null) => String::new(),
        t @ Some(_) => js_string(t).into_owned(),
    };
    format!("{media_type}:title:{title}")
}

/// Days from 1970-01-01 to a proleptic Gregorian date (month may be any
/// value 1..=12, day overflows into the next month as V8 allows).
const fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn digits(text: &str, len: usize) -> Option<i64> {
    (text.len() == len && text.bytes().all(|b| b.is_ascii_digit()))
        .then(|| text.parse().ok())
        .flatten()
}

/// `Date.parse` for the ISO forms Trakt sends (`YYYY`, `YYYY-MM`,
/// `YYYY-MM-DD`, optionally `THH:mm[:ss[.fff]]` with `Z` or `±HH:mm`), in
/// milliseconds. Other spellings are `None` (Node's `NaN` for most).
#[must_use]
pub fn parse_js_date(text: &str) -> Option<f64> {
    let (date, time) = text
        .split_once('T')
        .map_or((text, None), |(d, t)| (d, Some(t)));
    let mut parts = date.split('-');
    let year = digits(parts.next()?, 4)?;
    let month = parts.next().map_or(Some(1), |m| digits(m, 2))?;
    let day = parts.next().map_or(Some(1), |d| digits(d, 2))?;
    if parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut ms = days_from_civil(year, month, day) * 86_400_000;
    if let Some(time) = time {
        let (clock, offset_ms) = if let Some(clock) = time.strip_suffix('Z') {
            (clock, 0)
        } else {
            let at = time.rfind(['+', '-'])?;
            let (clock, offset) = (time.get(..at)?, time.get(at..)?);
            let sign = if offset.starts_with('-') { -1 } else { 1 };
            let (h, m) = offset.get(1..)?.split_once(':')?;
            (clock, sign * (digits(h, 2)? * 60 + digits(m, 2)?) * 60_000)
        };
        let (hms, frac) = clock
            .split_once('.')
            .map_or((clock, None), |(a, b)| (a, Some(b)));
        let mut fields = hms.split(':');
        let h = digits(fields.next()?, 2)?;
        let m = digits(fields.next()?, 2)?;
        let s = fields.next().map_or(Some(0), |s| digits(s, 2))?;
        if fields.next().is_some() || h > 24 || m > 59 || s > 59 || (h == 24 && (m > 0 || s > 0)) {
            return None;
        }
        let frac_ms = match frac {
            None => 0,
            Some(f) if !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()) => {
                let padded = format!("{f:0<3}");
                padded.get(..3)?.parse::<i64>().ok()?
            }
            Some(_) => return None,
        };
        ms += ((h * 60 + m) * 60 + s) * 1000 + frac_ms - offset_ms;
    }
    format!("{ms}").parse::<f64>().ok()
}

/// `getTraktItemSortTimestamp`.
#[must_use]
pub fn sort_timestamp(item: &Value, sort_by: SortBy) -> f64 {
    let key = match sort_by {
        SortBy::Added => "traktAddedAt",
        SortBy::Released => "traktReleaseDate",
    };
    item.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .and_then(parse_js_date)
        .unwrap_or(0.0)
}

/// `paginateSortedTraktItems`.
#[must_use]
pub fn paginate_sorted(
    items: &[Value],
    page: i64,
    limit: i64,
    sort_by: SortBy,
    has_more_upstream: bool,
) -> Paged {
    let mut sorted: Vec<&Value> = items.iter().collect();
    sorted.sort_by(|a, b| {
        sort_timestamp(b, sort_by)
            .partial_cmp(&sort_timestamp(a, sort_by))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    slice_page(&sorted, page, limit, has_more_upstream)
}

/// The `(page - 1) * limit` slice, with `hasMore` when more items follow
/// or `extra` says so.
fn slice_page(items: &[&Value], page: i64, limit: i64, extra: bool) -> Paged {
    let page = page.max(1);
    let limit = limit.max(1);
    let start = usize::try_from((page - 1).saturating_mul(limit)).unwrap_or(usize::MAX);
    let end = start.saturating_add(usize::try_from(limit).unwrap_or(usize::MAX));
    Paged {
        items: items
            .iter()
            .skip(start)
            .take(end - start)
            .map(|v| (*v).clone())
            .collect(),
        has_more: items.len() > end || extra,
    }
}

/// `paginatePage`: a plain slice of already collected items.
#[must_use]
pub fn plain_page(items: &[Value], page: i64, limit: i64, extra: bool) -> Paged {
    let refs: Vec<&Value> = items.iter().collect();
    slice_page(&refs, page, limit, extra)
}

/// `mergeAndPaginateTraktItems`, by `traktAddedAt` or (`by_position`) by
/// position within each stream.
#[must_use]
pub fn merge_and_paginate(
    movies: &[Value],
    shows: &[Value],
    page: i64,
    limit: i64,
    more: (bool, bool),
    by_position: bool,
) -> Paged {
    let stamp = |item: &Value, index: usize| -> f64 {
        if by_position {
            -f64::from(u32::try_from(index).unwrap_or(u32::MAX))
        } else {
            sort_timestamp(item, SortBy::Added)
        }
    };
    let mut picked: Vec<&Value> = Vec::new();
    let (mut mi, mut ti) = (0, 0);
    loop {
        match (movies.get(mi), shows.get(ti)) {
            (None, None) => break,
            (None, Some(tv)) => {
                picked.push(tv);
                ti += 1;
            }
            (Some(movie), None) => {
                picked.push(movie);
                mi += 1;
            }
            (Some(movie), Some(tv)) => {
                if stamp(movie, mi) >= stamp(tv, ti) {
                    picked.push(movie);
                    mi += 1;
                } else {
                    picked.push(tv);
                    ti += 1;
                }
            }
        }
    }
    let mut merged: Vec<&Value> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for item in picked {
        let key = item_key(item);
        if !seen.contains(&key) {
            seen.push(key);
            merged.push(item);
        }
    }
    slice_page(&merged, page, limit, more.0 || more.1)
}

/// `normalizeListMetadata`.
///
/// # Errors
///
/// Fails on a `null` payload, where Node reads a property of `null`.
pub fn normalize_list_metadata(payload: Option<&Value>) -> Result<Value, String> {
    let empty = Value::Object(Map::new());
    let payload = match payload {
        None => &empty,
        Some(Value::Null) => return Err(String::from("the Trakt list is null")),
        Some(p) => p,
    };
    let ids = or(payload.get("ids"), None);
    let slug = or(payload.get("slug"), ids.and_then(|i| i.get("slug")));
    let slug = slug.map_or_else(String::new, |s| js_string(Some(s)).into_owned());
    let list_id = ids.and_then(|i| i.get("trakt")).filter(|v| !v.is_null());
    let user = or(payload.get("user"), None);
    let user_ids = user.and_then(|u| or(u.get("ids"), None));
    let username = or(
        or(
            user.and_then(|u| u.get("username")),
            user.and_then(|u| u.get("slug")),
        ),
        user_ids.and_then(|i| i.get("slug")),
    );
    let mut out = Map::new();
    out.insert(
        String::from("id"),
        Value::from(list_id.map_or_else(String::new, |v| js_string(Some(v)).into_owned())),
    );
    out.insert(String::from("slug"), Value::from(slug.as_str()));
    out.insert(
        String::from("name"),
        or(payload.get("name"), payload.get("title"))
            .cloned()
            .unwrap_or_else(|| Value::from(slug.as_str())),
    );
    let count = or(payload.get("item_count"), None);
    out.insert(
        String::from("itemCount"),
        num_value(count.map_or(0.0, |c| js_number(Some(c)))),
    );
    if let Some(privacy) = payload.get("privacy") {
        out.insert(String::from("privacy"), privacy.clone());
    }
    if let Some(username) = username {
        out.insert(
            String::from("username"),
            Value::from(js_string(Some(username)).into_owned()),
        );
    }
    Ok(Value::Object(out))
}

/// `normalizeUserLists`: `(payload || []).map(normalizeListMetadata)`.
///
/// # Errors
///
/// Fails on an answer of an unexpected shape.
pub fn normalize_user_lists(payload: Option<&Value>) -> Result<Vec<Value>, String> {
    map_list(payload)?
        .iter()
        .map(|entry| normalize_list_metadata(Some(entry)))
        .collect()
}

/// `(payload || []).map(...)`: the array, empty for a falsy payload.
fn map_list(payload: Option<&Value>) -> Result<&[Value], String> {
    match payload {
        Some(Value::Array(items)) => Ok(items),
        None | Some(Value::Null) => Ok(&[]),
        Some(v) if !truthy(Some(v)) => Ok(&[]),
        Some(_) => Err(String::from("a Trakt answer that should be a list isn't")),
    }
}

/// `getLikedLists`' mapping: each entry's list with `isLiked: true`.
///
/// # Errors
///
/// Fails on an answer of an unexpected shape.
pub fn normalize_liked_lists(payload: Option<&Value>) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    for entry in map_list(payload)? {
        let Some(list) = field(entry, "list")?.filter(|l| truthy(Some(l))) else {
            continue;
        };
        let mut normalized = normalize_list_metadata(Some(list))?;
        if let Value::Object(map) = &mut normalized {
            map.insert(String::from("isLiked"), Value::Bool(true));
        }
        out.push(normalized);
    }
    Ok(out)
}

/// `searchLists`' mapping: list entries, deduplicated by owner and slug.
///
/// # Errors
///
/// Fails on an answer of an unexpected shape.
pub fn normalize_search_lists(payload: Option<&Value>) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for entry in entries(payload)? {
        let kind = field(entry, "type")?.and_then(Value::as_str);
        let list = entry.get("list").filter(|l| truthy(Some(l)));
        let (Some("list"), Some(list)) = (kind, list) else {
            continue;
        };
        let normalized = normalize_list_metadata(Some(list))?;
        let text = |k: &str| normalized.get(k).and_then(Value::as_str).unwrap_or("");
        let slug_or_id = if text("slug").is_empty() {
            text("id")
        } else {
            text("slug")
        };
        let key = if text("username").is_empty() {
            slug_or_id.to_owned()
        } else {
            format!("{}/{slug_or_id}", text("username"))
        };
        if key.is_empty() || seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(normalized);
    }
    Ok(out)
}

/// Why a list URL isn't answered with a list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ListUrlError {
    /// Node's 400 message.
    Bad(String),
}

/// `decodeURIComponent`; `None` where it throws (`URIError`).
fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while let Some(&b) = bytes.get(i) {
        if b == b'%' {
            let hex = text.get(i + 1..i + 3)?;
            if !hex.bytes().all(|h| h.is_ascii_hexdigit()) {
                return None;
            }
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `String.prototype.trim`.
#[must_use]
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

/// `TraktAPI.parseListUrl(value)`: `(username, listRef)`.
///
/// # Errors
///
/// `Bad` with Node's message.
pub fn parse_list_url(value: &str) -> Result<(Option<String>, String), ListUrlError> {
    let text = decode_uri_component(js_trim(value))
        .ok_or_else(|| ListUrlError::Bad(String::from("URI error")))?;
    if text.is_empty() {
        return Err(ListUrlError::Bad(String::from(
            "List URL or reference is required",
        )));
    }
    if text.starts_with("http://") || text.starts_with("https://") {
        // `new URL(text)`; both follow the WHATWG URL standard.
        let url = reqwest::Url::parse(&text)
            .map_err(|_| ListUrlError::Bad(String::from("Invalid URL")))?;
        let parts: Vec<&str> = url.path().split('/').filter(|p| !p.is_empty()).collect();
        return match parts.as_slice() {
            ["users", user, "lists", list, ..] => {
                Ok((Some((*user).to_owned()), (*list).to_owned()))
            }
            ["users", user, "watchlist"] => {
                Ok((Some((*user).to_owned()), String::from("watchlist")))
            }
            ["lists", list, ..] => Ok((None, (*list).to_owned())),
            _ => Err(ListUrlError::Bad(format!(
                "Unsupported Trakt list URL: {value}"
            ))),
        };
    }
    if let Some((user, rest)) = text.split_once('/') {
        let list_ref = js_trim(rest).to_lowercase();
        let user = js_trim(user);
        if user.is_empty() || list_ref.is_empty() {
            return Err(ListUrlError::Bad(format!(
                "Invalid Trakt list reference: {value}"
            )));
        }
        return Ok((Some(user.to_owned()), list_ref));
    }
    Ok((None, text))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_like_javascript() {
        assert!(js_number(None).is_nan(), "undefined");
        assert!(
            (js_number(Some(&json!(" 12 "))) - 12.0).abs() < f64::EPSILON,
            "trimmed"
        );
        assert!(
            (js_number(Some(&json!("0x10"))) - 16.0).abs() < f64::EPSILON,
            "hex"
        );
        assert!(js_number(Some(&json!("inf"))).is_nan(), "not Infinity");
        assert_eq!(num_value(12.0), json!(12), "whole");
        assert_eq!(num_value(f64::NAN), Value::Null, "NaN");
    }

    #[test]
    fn normalizes_media_items() {
        let item = json!({"title": "", "name": "Show", "year": 2020, "rating": "7.5",
            "ids": {"tmdb": "12", "slug": " show ", "trakt": 0, "imdb": "", "tvdb": 4}});
        let out = normalize_media_item(Some(&item), "tv")
            .ok()
            .flatten()
            .map(Value::Object);
        assert_eq!(
            out,
            Some(
                json!({"tmdbId": 12, "mediaType": "tv", "title": "Show", "year": 2020,
                "traktSlug": "show", "tvdbId": 4, "traktCommunityRating": 7.5})
            ),
            "ids, title fallback and rating"
        );
        let bare = json!({"ids": {"trakt": 5}});
        let out = normalize_media_item(Some(&bare), "movie")
            .ok()
            .flatten()
            .map(Value::Object);
        assert_eq!(
            out,
            Some(json!({"mediaType": "movie", "title": "5", "traktId": 5})),
            "trakt id title"
        );
        assert_eq!(
            normalize_media_item(Some(&json!({"ids": {}})), "movie"),
            Ok(None),
            "no ids"
        );
        assert!(
            normalize_media_item(Some(&json!({"ids": {"slug": 3}})), "movie").is_err(),
            "a non-text slug"
        );
    }

    #[test]
    fn normalizes_list_entries() {
        let payload = json!([
            {"type": "movie", "listed_at": "2024-01-02T00:00:00.000Z",
             "movie": {"title": "A", "released": "2020-01-01", "ids": {"tmdb": 1}}},
            {"type": "movie", "movie": {"title": "A again", "ids": {"tmdb": 1}}},
            {"type": "episode", "watched_at": "2024-01-01T00:00:00.000Z",
             "show": {"title": "S", "first_aired": "2019-01-01T00:00:00.000Z", "ids": {"slug": "s"}}},
            {"type": "person"}
        ]);
        let items = normalize_list_items(Some(&payload)).unwrap_or_default();
        assert_eq!(items.len(), 2, "deduplicated, unknown types skipped");
        assert_eq!(
            items.first(),
            Some(&json!({"tmdbId": 1, "mediaType": "movie", "title": "A",
                "traktAddedAt": "2024-01-02T00:00:00.000Z", "traktReleaseDate": "2020-01-01"})),
            "list metadata appended"
        );
        assert!(
            normalize_list_items(Some(&json!([null]))).is_err(),
            "null entry"
        );
        assert!(
            normalize_list_items(Some(&json!({}))).is_err(),
            "not iterable"
        );
        assert_eq!(
            normalize_list_items(Some(&json!(""))),
            Ok(Vec::new()),
            "falsy"
        );
    }

    #[test]
    fn wraps_chart_entries() {
        let payload = json!([{"watchers": 2, "movie": {"ids": {"tmdb": 3}}}, {"ids": {"tmdb": 4}}]);
        let wrapped = chart_entries(Some(&payload), "movie").unwrap_or_default();
        let ids: Vec<Option<i64>> = normalize_list_items(Some(&wrapped))
            .unwrap_or_default()
            .iter()
            .map(|i| i.get("tmdbId").and_then(Value::as_i64))
            .collect();
        assert_eq!(ids, vec![Some(3), Some(4)], "wrapped and bare entries");
    }

    #[test]
    fn keys_items() {
        assert_eq!(
            item_key(&json!({"mediaType": "tv", "tmdbId": 5})),
            "tv:tmdb:5",
            "tmdb"
        );
        assert_eq!(
            item_key(&json!({"mediaType": "tv", "traktSlug": "x"})),
            "tv:slug:x",
            "slug"
        );
        assert_eq!(
            item_key(&json!({"mediaType": "movie", "traktId": 9})),
            "movie:trakt:9",
            "trakt"
        );
        assert_eq!(
            item_key(&json!({"mediaType": "movie"})),
            "movie:title:",
            "title"
        );
    }

    #[test]
    fn parses_dates_like_v8() {
        assert_eq!(
            parse_js_date("2024-01-01T12:00:00.123456Z"),
            Some(1_704_110_400_123.0),
            "fraction"
        );
        assert_eq!(
            parse_js_date("2021-02-30"),
            Some(1_614_643_200_000.0),
            "day overflow"
        );
        assert_eq!(
            parse_js_date("2024-01-01T12:00:00+01:00"),
            Some(1_704_106_800_000.0),
            "offset"
        );
        assert_eq!(
            parse_js_date("2024-01-01T24:00:00Z"),
            Some(1_704_153_600_000.0),
            "midnight"
        );
        assert_eq!(parse_js_date("2024"), Some(1_704_067_200_000.0), "year");
        assert_eq!(parse_js_date("2024-13-01"), None, "month");
        assert_eq!(
            parse_js_date("2024-01-01T12:00:00.1Z"),
            Some(1_704_110_400_100.0),
            "short fraction"
        );
    }

    #[test]
    fn paginates() {
        let item =
            |id: i64, at: &str| json!({"mediaType": "movie", "tmdbId": id, "traktAddedAt": at});
        let items = vec![
            item(1, "2020-01-01"),
            item(2, "2022-01-01"),
            item(3, "bad"),
            item(4, "2021-01-01"),
        ];
        let page = paginate_sorted(&items, 1, 2, SortBy::Added, false);
        let ids: Vec<Option<i64>> = page
            .items
            .iter()
            .map(|i| i.get("tmdbId").and_then(Value::as_i64))
            .collect();
        assert_eq!(ids, vec![Some(2), Some(4)], "newest first");
        assert!(page.has_more, "more after the slice");
        let movies = vec![
            json!({"mediaType": "movie", "title": "A"}),
            json!({"mediaType": "movie", "title": "B"}),
        ];
        let shows = vec![json!({"mediaType": "tv", "title": "C"})];
        let merged = merge_and_paginate(&movies, &shows, 1, 3, (false, false), true);
        let titles: Vec<Option<&str>> = merged
            .items
            .iter()
            .map(|i| i.get("title").and_then(Value::as_str))
            .collect();
        assert_eq!(
            titles,
            vec![Some("A"), Some("C"), Some("B")],
            "interleaved by position"
        );
        assert!(!merged.has_more, "exhausted");
    }

    #[test]
    fn normalizes_list_metadata() {
        let list = json!({"name": "Mine", "item_count": 3, "privacy": null,
            "ids": {"trakt": 7, "slug": "mine"}, "user": {"ids": {"slug": "me"}}});
        assert_eq!(
            normalize_list_metadata(Some(&list)),
            Ok(
                json!({"id": "7", "slug": "mine", "name": "Mine", "itemCount": 3, "privacy": null, "username": "me"})
            ),
            "metadata"
        );
        assert_eq!(
            normalize_list_metadata(None),
            Ok(json!({"id": "", "slug": "", "name": "", "itemCount": 0})),
            "empty"
        );
        let search = json!([
            {"type": "list", "list": {"slug": "a", "user": {"username": "u"}}},
            {"type": "list", "list": {"slug": "a", "user": {"username": "u"}}},
            {"type": "list", "list": {}},
            {"type": "user"}
        ]);
        assert_eq!(
            normalize_search_lists(Some(&search)).map(|l| l.len()),
            Ok(1),
            "deduplicated"
        );
    }

    #[test]
    fn parses_list_urls() {
        assert_eq!(
            parse_list_url("https://trakt.tv/users/justin/lists/watched?sort=rank"),
            Ok((Some(String::from("justin")), String::from("watched"))),
            "user list"
        );
        assert_eq!(
            parse_list_url("https://trakt.tv/users/justin/watchlist"),
            Ok((Some(String::from("justin")), String::from("watchlist"))),
            "watchlist"
        );
        assert_eq!(
            parse_list_url("https://trakt.tv/lists/123"),
            Ok((None, String::from("123"))),
            "list id"
        );
        assert_eq!(
            parse_list_url("justin/My-List"),
            Ok((Some(String::from("justin")), String::from("my-list"))),
            "shorthand"
        );
        assert_eq!(
            parse_list_url("https://trakt.tv/movies/x"),
            Err(ListUrlError::Bad(String::from(
                "Unsupported Trakt list URL: https://trakt.tv/movies/x"
            ))),
            "unsupported"
        );
        assert_eq!(
            parse_list_url("/x"),
            Err(ListUrlError::Bad(String::from(
                "Invalid Trakt list reference: /x"
            ))),
            "no user"
        );
        assert_eq!(
            parse_list_url("a%zz"),
            Err(ListUrlError::Bad(String::from("URI error"))),
            "malformed escape"
        );
        assert_eq!(
            parse_list_url("a%20b"),
            Ok((None, String::from("a b"))),
            "decoded"
        );
        assert_eq!(
            parse_list_url("U/%C3%89"),
            Ok((Some(String::from("U")), String::from("\u{e9}"))),
            "lower-cased"
        );
    }
}
