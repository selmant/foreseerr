//! `server/lib/ratings`: `fetchCombinedRatings`, with its three sources.
//!
//! `MDBList` answers when an API key is configured; otherwise Rotten Tomatoes
//! (through its search index, scored like Node does) and, for movies, the
//! `IMDb` proxy Radarr hosts.

use std::collections::HashMap;
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::{Map, Value};

use crate::media::js_string;
use crate::memcache::{self, CacheId};
use crate::settings::public::truthy;
use crate::settings::Settings;
use crate::tmdb::axios_encode;

const RT_BASE: &str = "https://79frdp12pn-dsn.algolia.net/1/indexes/*";
const RT_AGENT: &str = "Algolia%20for%20JavaScript%20(4.14.3)%3B%20Browser%20(lite)";
const RT_API_KEY: &str = "175588f6e5f8319b27702e4cc4013561";
const RT_APP_ID: &str = "79FRDP12PN";
const IMDB_BASE: &str = "https://api.radarr.video/v1";
/// `ExternalAPI`'s default TTL, which the RT and `IMDb` calls use.
const DEFAULT_TTL: Duration = Duration::from_secs(300);
/// `MDBList` ratings TTLs by the title's age.
const MDBLIST_HOT: Duration = Duration::from_secs(86_400);
const MDBLIST_WARM: Duration = Duration::from_secs(86_400 * 7);
const MDBLIST_COLD: Duration = Duration::from_secs(86_400 * 30);

const INEXACT_TITLE_FACTOR: f64 = 0.25;
const ALTERNATE_TITLE_FACTOR: f64 = 0.8;
const PER_YEAR_PENALTY: f64 = 0.4;
const MINIMUM_SCORE: f64 = 0.175;

/// What `fetchCombinedRatings` needs to know about a title.
#[derive(Debug, Clone)]
pub struct Title<'a> {
    /// `movie` or `tv`.
    pub media_type: &'a str,
    /// `TMDB` id.
    pub tmdb_id: i64,
    /// Title in the requested language.
    pub title: &'a str,
    /// Release year, when known.
    pub year: Option<i64>,
    /// `releaseDate` / `firstAirDate`, for `MDBList`'s cache TTL.
    pub release_date: Option<&'a str>,
    /// `IMDb` id, for the proxy lookup.
    pub imdb_id: Option<&'a str>,
}

/// The three rating sources, over the shared `rt`, `imdb` and `mdblist`
/// caches.
#[derive(Debug, Clone)]
pub struct Ratings {
    client: reqwest::Client,
}

impl Ratings {
    /// Clients over the outgoing HTTP client.
    #[must_use]
    pub const fn new(client: reqwest::Client) -> Self {
        Self { client }
    }

    /// `fetchCombinedRatings`: `Ok(None)` is Node's `null`.
    ///
    /// # Errors
    ///
    /// Fails when Rotten Tomatoes or the `IMDb` proxy can't be reached, which
    /// makes Node's route fail too; `MDBList` failures are swallowed as in
    /// Node.
    pub async fn combined(&self, settings: &Settings, title: &Title<'_>) -> Result<Option<Value>> {
        let mdblist_key = settings.str("/mdblist/apiKey").trim().to_owned();
        if !mdblist_key.is_empty() {
            let Some(parsed) = self.mdblist(settings, title).await else {
                return Ok(None);
            };
            let mapped = map_mdblist(&parsed, title.title, title.year);
            return Ok(has_any_rating(&mapped).then_some(mapped));
        }
        let rt = if title.media_type == "movie" {
            self.rt_movie(settings, title.title, title.year.unwrap_or(0))
                .await?
        } else {
            self.rt_tv(settings, title.title, title.year).await?
        };
        let imdb = match (title.media_type, title.imdb_id) {
            ("movie", Some(imdb_id)) if !imdb_id.is_empty() => self.imdb(imdb_id).await?,
            _ => None,
        };
        if rt.is_none() && imdb.is_none() {
            return Ok(None);
        }
        let mut out = Map::new();
        out.insert(String::from("provider"), Value::from("legacy"));
        if let Some(rt) = rt {
            out.insert(String::from("rt"), rt);
        }
        if let Some(imdb) = imdb {
            out.insert(String::from("imdb"), imdb);
        }
        Ok(Some(Value::Object(out)))
    }

    /// `RottenTomatoes.getMovieRatings`: `Ok(None)` is its `null`.
    ///
    /// # Errors
    ///
    /// Fails when the search can't be made.
    pub async fn rt_movie(
        &self,
        settings: &Settings,
        name: &str,
        year: i64,
    ) -> Result<Option<Value>> {
        let hits = self
            .rt_search(
                settings,
                &strip_the(name),
                "isEmsSearchable=1 AND type:\"movie\"",
            )
            .await?;
        let Some(best) = best(&hits, name, (year != 0).then_some(year)) else {
            return Ok(None);
        };
        let Some(rt) = best.get("rottenTomatoes").filter(|rt| truthy(Some(rt))) else {
            return Ok(None);
        };
        let critics = rt
            .get("criticsScore")
            .and_then(Value::as_f64)
            .unwrap_or(f64::NAN);
        let audience = rt
            .get("audienceScore")
            .and_then(Value::as_f64)
            .unwrap_or(f64::NAN);
        let critics_rating = if truthy(rt.get("certifiedFresh")) {
            "Certified Fresh"
        } else if critics >= 60.0 {
            "Fresh"
        } else {
            "Rotten"
        };
        Ok(Some(rt_json(
            best,
            "m",
            critics_rating,
            rt.get("criticsScore"),
            audience,
            rt.get("audienceScore"),
        )))
    }

    /// `RottenTomatoes.getTVRatings`: `Ok(None)` is its `null`.
    ///
    /// # Errors
    ///
    /// Fails when the search can't be made.
    pub async fn rt_tv(
        &self,
        settings: &Settings,
        name: &str,
        year: Option<i64>,
    ) -> Result<Option<Value>> {
        let hits = self
            .rt_search(settings, name, "isEmsSearchable=1 AND type:\"tv\"")
            .await?;
        let Some(best) = best(&hits, name, year) else {
            return Ok(None);
        };
        let Some(rt) = best.get("rottenTomatoes").filter(|rt| truthy(Some(rt))) else {
            return Ok(None);
        };
        let critics = rt
            .get("criticsScore")
            .and_then(Value::as_f64)
            .unwrap_or(f64::NAN);
        let audience = rt
            .get("audienceScore")
            .and_then(Value::as_f64)
            .unwrap_or(f64::NAN);
        let critics_rating = if critics >= 60.0 { "Fresh" } else { "Rotten" };
        Ok(Some(rt_json(
            best,
            "tv",
            critics_rating,
            rt.get("criticsScore"),
            audience,
            rt.get("audienceScore"),
        )))
    }

    /// The `content_rt` hits of one search, through `ExternalAPI.post`'s
    /// five-minute cache.
    async fn rt_search(
        &self,
        settings: &Settings,
        query: &str,
        filters: &str,
    ) -> Result<Vec<Value>> {
        let url = format!(
            "{RT_BASE}/queries?x-algolia-agent={}&x-algolia-api-key={}&x-algolia-application-id={}",
            axios_encode(RT_AGENT),
            axios_encode(RT_API_KEY),
            axios_encode(RT_APP_ID)
        );
        let mut request = Map::new();
        request.insert(String::from("indexName"), Value::from("content_rt"));
        request.insert(String::from("query"), Value::from(query));
        request.insert(
            String::from("params"),
            Value::from(format!(
                "filters={}&hitsPerPage=20",
                encode_uri_component(filters)
            )),
        );
        let mut body = Map::new();
        body.insert(
            String::from("requests"),
            Value::Array(vec![Value::Object(request)]),
        );
        let body = Value::Object(body);
        let key = format!("{RT_BASE}/queries {body}");
        let data = if let Some(data) = cached(CacheId::Rt, &key) {
            data
        } else {
            let data: Value = self
                .client
                .post(&url)
                .header(reqwest::header::ACCEPT, "application/json")
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .header("x-algolia-usertoken", settings.str("/clientId"))
                .body(body.to_string())
                .send()
                .await
                .map_err(crate::outbound::redact)
                .context("[RT API] search")?
                .error_for_status()
                .map_err(crate::outbound::redact)
                .context("[RT API] search")?
                .json()
                .await
                .map_err(crate::outbound::redact)
                .context("[RT API] search: not JSON")?;
            let data = crate::tmdb::js_numbers(data);
            memcache::set(CacheId::Rt, key, data.clone(), DEFAULT_TTL);
            data
        };
        let hits = data
            .get("results")
            .and_then(Value::as_array)
            .and_then(|results| {
                results
                    .iter()
                    .find(|r| r.get("index").and_then(Value::as_str) == Some("content_rt"))
            })
            .and_then(|r| r.get("hits"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(hits)
    }

    /// `IMDBRadarrProxy.getMovieRatings`.
    async fn imdb(&self, imdb_id: &str) -> Result<Option<Value>> {
        let url = format!("{IMDB_BASE}/movie/imdb/{imdb_id}");
        let key = url.clone();
        let data = if let Some(data) = cached(CacheId::Imdb, &key) {
            data
        } else {
            let data: Value = self
                .client
                .get(&url)
                .header(reqwest::header::ACCEPT, "application/json")
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .send()
                .await
                .context("[IMDB RADARR PROXY API] lookup")?
                .error_for_status()
                .context("[IMDB RADARR PROXY API] lookup")?
                .json()
                .await
                .context("[IMDB RADARR PROXY API] lookup: not JSON")?;
            let data = crate::tmdb::js_numbers(data);
            memcache::set(CacheId::Imdb, key, data.clone(), DEFAULT_TTL);
            data
        };
        let Some(first) = data.as_array().and_then(|items| items.first()) else {
            return Ok(None);
        };
        if first.get("ImdbId").and_then(Value::as_str) != Some(imdb_id) {
            return Ok(None);
        }
        let Some(rating) = first
            .pointer("/MovieRatings/Imdb")
            .filter(|imdb| truthy(Some(imdb)))
        else {
            return Ok(None);
        };
        let mut out = Map::new();
        out.insert(
            String::from("title"),
            first.get("Title").cloned().unwrap_or(Value::Null),
        );
        out.insert(
            String::from("url"),
            Value::from(format!("https://www.imdb.com/title/{imdb_id}")),
        );
        if let Some(value) = rating.get("Value") {
            out.insert(String::from("criticsScore"), value.clone());
        }
        if let Some(count) = rating.get("Count") {
            out.insert(String::from("criticsScoreCount"), count.clone());
        }
        Ok(Some(Value::Object(out)))
    }

    /// `MdblistAPI.getRatings`, parsed, through the shared client (its
    /// cache, circuit breaker and queue); `None` on any failure.
    async fn mdblist(&self, settings: &Settings, title: &Title<'_>) -> Option<Parsed> {
        let payload = crate::mdblist::Mdblist::new(&self.client, settings)
            .ratings(
                title.media_type,
                title.tmdb_id,
                mdblist_ttl(title.release_date).as_secs(),
            )
            .await?;
        Some(parse_mdblist(&payload))
    }
}

/// `ExternalAPI`'s cache check: a copy of a stored answer that is truthy.
fn cached(id: CacheId, key: &str) -> Option<Value> {
    memcache::get(id, key)
        .filter(|v| truthy(Some(v)))
        .map(std::sync::Arc::unwrap_or_clone)
}

/// An `RTRating` from the best hit.
fn rt_json(
    hit: &Value,
    kind: &str,
    critics_rating: &str,
    critics_score: Option<&Value>,
    audience: f64,
    audience_score: Option<&Value>,
) -> Value {
    let mut out = Map::new();
    out.insert(
        String::from("title"),
        hit.get("title").cloned().unwrap_or(Value::Null),
    );
    out.insert(
        String::from("url"),
        Value::from(format!(
            "https://www.rottentomatoes.com/{kind}/{}",
            js_string(hit.get("vanity"))
        )),
    );
    out.insert(String::from("criticsRating"), Value::from(critics_rating));
    if let Some(score) = critics_score {
        out.insert(String::from("criticsScore"), score.clone());
    }
    out.insert(
        String::from("audienceRating"),
        Value::from(if audience >= 60.0 {
            "Upright"
        } else {
            "Spilled"
        }),
    );
    if let Some(score) = audience_score {
        out.insert(String::from("audienceScore"), score.clone());
    }
    out.insert(String::from("year"), js_number(hit.get("releaseYear")));
    Value::Object(out)
}

/// `Number(x)` for a JSON value, as JSON prints it (NaN is null).
fn js_number(v: Option<&Value>) -> Value {
    match v {
        Some(Value::Number(n)) => Value::Number(n.clone()),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                Value::from(0)
            } else if let Ok(n) = t.parse::<i64>() {
                Value::from(n)
            } else {
                t.parse::<f64>()
                    .ok()
                    .filter(|f| f.is_finite())
                    .map_or(Value::Null, Value::from)
            }
        }
        Some(Value::Bool(b)) => Value::from(i64::from(*b)),
        Some(Value::Null) => Value::from(0),
        Some(Value::Array(_) | Value::Object(_)) | None => Value::Null,
    }
}

/// `name.replace(/\bthe\b ?/gi, '')` with JavaScript's ASCII word
/// boundaries.
fn strip_the(name: &str) -> String {
    let chars: Vec<char> = name.chars().collect();
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut out = String::with_capacity(name.len());
    let mut i = 0;
    while i < chars.len() {
        let at_the = chars.get(i..i + 3).is_some_and(|w| {
            w.iter()
                .zip(['t', 'h', 'e'])
                .all(|(c, e)| c.to_ascii_lowercase() == e)
        });
        let boundary_before = i == 0 || chars.get(i - 1).is_none_or(|c| !is_word(*c));
        let boundary_after = chars.get(i + 3).is_none_or(|c| !is_word(*c));
        if at_the && boundary_before && boundary_after {
            i += 3;
            if chars.get(i) == Some(&' ') {
                i += 1;
            }
            continue;
        }
        if let Some(c) = chars.get(i) {
            out.push(*c);
        }
        i += 1;
    }
    out
}

/// `norm`: lower-cased, keeping letters, numbers and spaces.
fn norm(s: &str) -> Vec<u16> {
    s.to_lowercase()
        .chars()
        .filter(|c| c.is_alphabetic() || c.is_numeric() || *c == ' ')
        .collect::<String>()
        .encode_utf16()
        .collect()
}

/// `wink-jaro-distance`'s similarity over UTF-16 code units, as JavaScript
/// indexes strings.
fn jaro(s1: &[u16], s2: &[u16]) -> f64 {
    if s1 == s2 {
        return 1.0;
    }
    if s1.is_empty() || s2.is_empty() {
        return 0.0;
    }
    let (short, long) = if s1.len() > s2.len() {
        (s2, s1)
    } else {
        (s1, s2)
    };
    let window = (long.len() / 2).saturating_sub(1);
    let mut long_matched = vec![false; long.len()];
    let mut matched_chars = Vec::new();
    for (i, c) in short.iter().enumerate() {
        let start = i.saturating_sub(window);
        let end = (i + window + 1).min(long.len());
        for j in start..end {
            if !long_matched.get(j).copied().unwrap_or(true) && long.get(j) == Some(c) {
                if let Some(slot) = long_matched.get_mut(j) {
                    *slot = true;
                }
                matched_chars.push(*c);
                break;
            }
        }
    }
    let matches = matched_chars.len();
    if matches == 0 {
        return 0.0;
    }
    let mut transposes = 0_usize;
    let mut j = 0;
    for (i, flag) in long_matched.iter().enumerate() {
        if j >= matches {
            break;
        }
        if *flag {
            if long.get(i) != matched_chars.get(j) {
                transposes += 1;
            }
            j += 1;
        }
    }
    let m = to_f64(matches);
    let t = to_f64(transposes) / 2.0;
    ((m / to_f64(short.len())) + (m / to_f64(long.len())) + ((m - t) / m)) / 3.0
}

fn to_f64(n: usize) -> f64 {
    u32::try_from(n).map_or(f64::MAX, f64::from)
}

fn similarity(a: &[u16], b: &[u16]) -> f64 {
    if a == b {
        1.0
    } else {
        jaro(a, b) * INEXACT_TITLE_FACTOR
    }
}

/// `t_score`: the best similarity over the title, its `aka` and `titles`
/// lists, alternates weighted down.
fn title_score(hit: &Value, name: &[u16]) -> f64 {
    let mut candidates: Vec<Option<&str>> = vec![hit.get("title").and_then(Value::as_str)];
    for list in ["aka", "titles"] {
        if let Some(items) = hit.get(list).and_then(Value::as_array) {
            candidates.extend(items.iter().map(Value::as_str));
        }
    }
    candidates
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let factor = if i == 0 { 1.0 } else { ALTERNATE_TITLE_FACTOR };
            t.map_or(f64::NAN, |t| similarity(&norm(t), name) * factor)
        })
        .fold(f64::NEG_INFINITY, f64::max)
}

fn year_score(hit: &Value, year: Option<i64>) -> f64 {
    let Some(year) = year else {
        return 1.0;
    };
    let release = hit
        .get("releaseYear")
        .and_then(Value::as_f64)
        .unwrap_or(f64::NAN);
    let year = u32::try_from(year.unsigned_abs()).map_or(f64::MAX, f64::from)
        * if year < 0 { -1.0 } else { 1.0 };
    (release - year)
        .abs()
        .mul_add(-PER_YEAR_PENALTY, 1.0)
        .max(0.0)
}

fn extra_score(hit: &Value) -> f64 {
    if truthy(hit.get("rottenTomatoes")) {
        1.0
    } else {
        0.5
    }
}

/// `best`: the highest-scoring hit above the minimum, if any.
fn best<'a>(hits: &'a [Value], name: &str, year: Option<i64>) -> Option<&'a Value> {
    let wanted = norm(name);
    let mut scored: Vec<(f64, &Value)> = hits
        .iter()
        .map(|hit| {
            (
                title_score(hit, &wanted) * year_score(hit, year) * extra_score(hit),
                hit,
            )
        })
        .filter(|(score, _)| *score > MINIMUM_SCORE)
        .collect();
    scored.sort_by(|(a, _), (b, _)| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    scored.first().map(|(_, hit)| *hit)
}

/// `encodeURIComponent`.
#[must_use]
pub fn encode_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'~' | b'!' | b'\'' | b'(' | b')' | b'*'
            )
        {
            out.push(char::from(byte));
        } else {
            out.push('%');
            for nibble in [byte >> 4, byte & 0x0F] {
                out.push(
                    char::from_digit(u32::from(nibble), 16).map_or('0', |c| c.to_ascii_uppercase()),
                );
            }
        }
    }
    out
}

/// `ParsedMdblistRatings`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Parsed {
    imdb_id: Option<String>,
    imdb_rating: Option<f64>,
    imdb_votes: Option<i64>,
    rt_rating: Option<f64>,
    rt_user_rating: Option<f64>,
    metacritic_rating: Option<f64>,
    trakt_rating: Option<f64>,
    trakt_votes: Option<i64>,
}

/// `Number(x)` for a score, `None` for null, undefined, "" and NaN.
fn finite(v: Option<&Value>) -> Option<f64> {
    match v {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.is_empty() => None,
        other => match js_number(other) {
            Value::Number(n) => n.as_f64(),
            Value::Null
            | Value::Bool(_)
            | Value::String(_)
            | Value::Array(_)
            | Value::Object(_) => None,
        },
    }
}

/// `parseMdblistRatings`.
pub fn parse_mdblist(payload: &Value) -> Parsed {
    let mut by_source: HashMap<&str, &Value> = HashMap::new();
    if let Some(entries) = payload.get("ratings").and_then(Value::as_array) {
        for entry in entries {
            if let Some(source) = entry.get("source").and_then(Value::as_str) {
                if !source.is_empty() {
                    by_source.insert(source, entry);
                }
            }
        }
    }
    let score = |source: &str| finite(by_source.get(source).and_then(|e| e.get("score")));
    let votes = |source: &str| finite(by_source.get(source).and_then(|e| e.get("votes")));
    let to_ten = |n: Option<f64>| n.map(|n| n.round() / 10.0);
    let to_percent = |n: Option<f64>| n.map(f64::round);
    let to_int = |n: Option<f64>| n.and_then(|n| float_to_i64(n.trunc()));
    Parsed {
        imdb_id: payload
            .pointer("/ids/imdb")
            .and_then(Value::as_str)
            .map(str::to_owned),
        imdb_rating: to_ten(score("imdb")),
        imdb_votes: to_int(votes("imdb")),
        rt_rating: to_percent(score("tomatoes")),
        rt_user_rating: to_percent(score("popcorn")),
        metacritic_rating: to_percent(score("metacritic")),
        trakt_rating: to_ten(score("trakt")),
        trakt_votes: to_int(votes("trakt")),
    }
}

/// A whole float as an integer, when it fits.
fn float_to_i64(f: f64) -> Option<i64> {
    let text = format!("{f:.0}");
    text.parse().ok()
}

/// A score as JSON: whole numbers print without a fraction, as JavaScript
/// prints them.
fn number(f: f64) -> Value {
    if f.fract() == 0.0 {
        float_to_i64(f).map_or_else(|| Value::from(f), Value::from)
    } else {
        Value::from(f)
    }
}

/// `mapMdblistToRatingResponse`.
#[must_use]
pub fn map_mdblist(parsed: &Parsed, title: &str, year: Option<i64>) -> Value {
    let mut out = Map::new();
    out.insert(String::from("provider"), Value::from("mdblist"));
    if parsed.rt_rating.is_some() || parsed.rt_user_rating.is_some() {
        let mut rt = Map::new();
        rt.insert(String::from("title"), Value::from(title));
        rt.insert(String::from("year"), Value::from(year.unwrap_or(0)));
        rt.insert(
            String::from("url"),
            Value::from(format!(
                "https://www.rottentomatoes.com/search?search={}",
                encode_uri_component(title)
            )),
        );
        if let Some(score) = parsed.rt_rating {
            rt.insert(String::from("criticsScore"), number(score));
            rt.insert(
                String::from("criticsRating"),
                Value::from(if score >= 75.0 {
                    "Certified Fresh"
                } else if score >= 60.0 {
                    "Fresh"
                } else {
                    "Rotten"
                }),
            );
        }
        if let Some(score) = parsed.rt_user_rating {
            rt.insert(String::from("audienceScore"), number(score));
            rt.insert(
                String::from("audienceRating"),
                Value::from(if score >= 60.0 { "Upright" } else { "Spilled" }),
            );
        }
        out.insert(String::from("rt"), Value::Object(rt));
    }
    if let Some(score) = parsed.imdb_rating {
        let mut imdb = Map::new();
        imdb.insert(String::from("title"), Value::from(title));
        imdb.insert(
            String::from("url"),
            Value::from(parsed.imdb_id.as_deref().map_or_else(
                || String::from("https://www.imdb.com"),
                |id| format!("https://www.imdb.com/title/{id}"),
            )),
        );
        imdb.insert(String::from("criticsScore"), number(score));
        imdb.insert(
            String::from("criticsScoreCount"),
            Value::from(parsed.imdb_votes.unwrap_or(0)),
        );
        out.insert(String::from("imdb"), Value::Object(imdb));
    }
    if let Some(score) = parsed.metacritic_rating {
        let mut metacritic = Map::new();
        metacritic.insert(String::from("score"), number(score));
        out.insert(String::from("metacritic"), Value::Object(metacritic));
    }
    if let Some(rating) = parsed.trakt_rating {
        let mut trakt = Map::new();
        trakt.insert(String::from("rating"), number(rating));
        if let Some(votes) = parsed.trakt_votes {
            trakt.insert(String::from("votes"), Value::from(votes));
        }
        out.insert(String::from("trakt"), Value::Object(trakt));
    }
    Value::Object(out)
}

/// `hasAnyRating`.
#[must_use]
pub fn has_any_rating(ratings: &Value) -> bool {
    ["rt", "imdb", "metacritic", "trakt"]
        .iter()
        .any(|key| truthy(ratings.get(*key)))
}

/// `getRatingsCacheTtl`: a day for titles under three months old or
/// without a date, a week under two years, a month otherwise.
#[must_use]
pub fn mdblist_ttl(release_date: Option<&str>) -> Duration {
    let Some(date) = release_date.filter(|d| !d.is_empty()) else {
        return MDBLIST_HOT;
    };
    let Some(release) = crate::clock::parse_date_millis(date) else {
        return MDBLIST_HOT;
    };
    let now = crate::clock::now_millis();
    if release >= now - 90 * 86_400 * 1000 {
        MDBLIST_HOT
    } else if release >= now - 730 * 86_400 * 1000 {
        MDBLIST_WARM
    } else {
        MDBLIST_COLD
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn jaro_matches_the_library() {
        let j = |a: &str, b: &str| jaro(&norm(a), &norm(b));
        assert!(
            (j("martha", "marhta") - 0.944_444_4).abs() < 1e-6,
            "classic example"
        );
        assert!(
            (j("dixon", "dicksonx") - 0.766_666_6).abs() < 1e-6,
            "classic example 2"
        );
        assert!((j("abc", "") - 0.0).abs() < f64::EPSILON, "empty");
        assert!((j("same", "same") - 1.0).abs() < f64::EPSILON, "equal");
    }

    #[test]
    fn strips_the_like_the_regex() {
        assert_eq!(strip_the("The Matrix"), "Matrix", "leading");
        assert_eq!(strip_the("Into the Wild"), "Into Wild", "middle with space");
        assert_eq!(strip_the("Breathe"), "Breathe", "inside a word");
        assert_eq!(strip_the("THE"), "", "whole");
    }

    #[test]
    fn picks_the_best_hit() {
        let hits = vec![
            json!({"title": "Fight Club", "releaseYear": 1999, "vanity": "fight_club", "rottenTomatoes": {"criticsScore": 81, "audienceScore": 96, "certifiedFresh": true}}),
            json!({"title": "Fight Club Remake", "releaseYear": 2025, "vanity": "x", "rottenTomatoes": {"criticsScore": 10, "audienceScore": 10}}),
            json!({"title": "Unrelated", "releaseYear": 1999, "vanity": "y"}),
        ];
        let hit = best(&hits, "Fight Club", Some(1999));
        assert_eq!(
            hit.and_then(|h| h.get("vanity")).and_then(Value::as_str),
            Some("fight_club"),
            "exact title and year wins"
        );
        assert!(
            best(&hits, "Completely Different", Some(1950)).is_none(),
            "below the minimum"
        );
    }

    #[test]
    fn mdblist_mapping() {
        let payload = json!({"ids": {"imdb": "tt1"}, "ratings": [
            {"source": "imdb", "score": 88, "votes": 123.7},
            {"source": "tomatoes", "score": 81},
            {"source": "popcorn", "score": "59.5"},
            {"source": "trakt", "score": 77, "votes": null},
            {"source": "metacritic", "score": ""}
        ]});
        let parsed = parse_mdblist(&payload);
        let mapped = map_mdblist(&parsed, "Fight Club", Some(1999));
        assert_eq!(
            mapped,
            json!({
                "provider": "mdblist",
                "rt": {"title": "Fight Club", "year": 1999, "url": "https://www.rottentomatoes.com/search?search=Fight%20Club", "criticsScore": 81, "criticsRating": "Certified Fresh", "audienceScore": 60, "audienceRating": "Upright"},
                "imdb": {"title": "Fight Club", "url": "https://www.imdb.com/title/tt1", "criticsScore": 8.8, "criticsScoreCount": 123},
                "trakt": {"rating": 7.7}
            }),
            "rounding, scales and omitted fields"
        );
        assert!(has_any_rating(&mapped), "has ratings");
        assert_eq!(
            encode_uri_component("a b&c=d/é"),
            "a%20b%26c%3Dd%2F%C3%A9",
            "encodeURIComponent"
        );
    }
}
