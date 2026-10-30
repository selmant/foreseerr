//! `server/api/simkl` (the reads the discover rows make) and the pure
//! parts of `server/lib/simklCatalog.ts`.
//!
//! Catalog payloads become candidates, and details hydrate them. Resolving candidates to TMDB ids goes through
//! Node's mapping layer.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use reqwest::header::{ACCEPT, CONTENT_TYPE, USER_AGENT};
use serde_json::{Map, Value};

use crate::jsval;
use crate::ratings::encode_uri_component;
use crate::settings::Settings;
use crate::sync::lock;

const BASE_URL: &str = "https://api.simkl.com";
const POSTER_BASE: &str = "https://wsrv.nl/?url=https://simkl.in/posters";

/// Why a Simkl read failed, with the message Node's error carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SimklError {
    /// `SimklRateLimitedError`.
    RateLimited(String),
    /// `SimklTemporarilyUnavailableError` and anything else.
    Unavailable(String),
}

impl SimklError {
    /// `error.message`.
    #[must_use]
    pub fn message(&self) -> &str {
        match self {
            Self::RateLimited(m) | Self::Unavailable(m) => m,
        }
    }
}

/// `new SimklAPI()`: the app client with its pacing.
#[derive(Debug, Clone)]
pub struct Simkl {
    client: reqwest::Client,
    client_id: String,
    version: String,
    timeout: Option<Duration>,
    next_request_at: Arc<Mutex<Option<Instant>>>,
}

impl Simkl {
    /// The client, or `None` where the constructor throws
    /// `SimklNotConfiguredError`.
    #[must_use]
    pub fn new(client: &reqwest::Client, settings: &Settings, version: &str) -> Option<Self> {
        let client_id = crate::simklapi::effective_client_id(settings).unwrap_or_default();
        if client_id.is_empty() {
            return None;
        }
        let timeout = settings
            .get("/network/apiRequestTimeout")
            .and_then(Value::as_u64)
            .filter(|ms| *ms > 0)
            .map(Duration::from_millis);
        Some(Self {
            client: client.clone(),
            client_id,
            version: version.to_owned(),
            timeout,
            next_request_at: Arc::new(Mutex::new(None)),
        })
    }

    /// `pace()`: 100 ms between GETs of one client. The slot is reserved under
    /// the lock before sleeping, so concurrent callers queue behind each other
    /// instead of all waking at the same instant.
    async fn pace(&self) {
        let at = {
            let mut next = lock(&self.next_request_at);
            let now = Instant::now();
            let at = next.map_or(now, |next| next.max(now));
            *next = Some(at + Duration::from_millis(100));
            at
        };
        let wait = at.saturating_duration_since(Instant::now());
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
    }

    fn required_parameters(&self) -> String {
        format!(
            "client_id={}&app-name=foreseerr&app-version={}",
            jsval::form_encode(&self.client_id),
            jsval::form_encode(&self.version)
        )
    }

    fn get(&self, url: &str) -> reqwest::RequestBuilder {
        let mut req = self
            .client
            .get(url)
            .header(ACCEPT, "application/json")
            .header(CONTENT_TYPE, "application/json")
            .header("simkl-api-key", &self.client_id)
            .header("app-name", "foreseerr")
            .header("app-version", &self.version)
            .header(
                USER_AGENT,
                format!("Foreseerr/{} (Simkl integration)", self.version),
            );
        if let Some(timeout) = self.timeout {
            req = req.timeout(timeout);
        }
        req
    }

    /// `getTitle(kind, simklId)`: the detail object (`{}` for other
    /// shapes); any failure is an error, which hydration swallows.
    async fn title(&self, kind: &str, simkl_id: &str) -> Result<Map<String, Value>, ()> {
        self.pace().await;
        let url = format!(
            "{BASE_URL}/{kind}/{}?{}",
            encode_uri_component(simkl_id),
            self.required_parameters()
        );
        for attempt in 0..2 {
            let status = match self.get(&url).send().await {
                Ok(res) if res.status().is_success() => {
                    let text = res.text().await.map_err(|_| ())?;
                    let parsed = serde_json::from_str::<Value>(&text).map(crate::tmdb::js_numbers);
                    return Ok(match parsed {
                        Ok(Value::Object(map)) => map,
                        Ok(
                            Value::Null
                            | Value::Bool(_)
                            | Value::Number(_)
                            | Value::String(_)
                            | Value::Array(_),
                        )
                        | Err(_) => Map::new(),
                    });
                }
                Ok(res) => Some(res.status().as_u16()),
                Err(_) => None,
            };
            let retryable = status.is_none_or(|s| s >= 500);
            if attempt == 0 && retryable && status != Some(401) && status != Some(429) {
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }
            return Err(());
        }
        Err(())
    }

    /// `getCdnCatalog(path)`.
    ///
    /// # Errors
    ///
    /// Fails with Node's rate-limit or unavailable error.
    pub async fn cdn_catalog(&self, path: &str) -> Result<Value, SimklError> {
        self.pace().await;
        let url = format!("https://data.simkl.in{path}?{}", self.required_parameters());
        let unavailable =
            || SimklError::Unavailable(String::from("Simkl is temporarily unavailable"));
        let res = self.get(&url).send().await.map_err(|_| unavailable())?;
        let status = res.status().as_u16();
        if status == 429 {
            let header = res
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .map_or(f64::NAN, jsval::number_of_str);
            let seconds = if header.is_nan() || header == 0.0 {
                1.0
            } else {
                header
            }
            .max(1.0);
            return Err(SimklError::RateLimited(format!(
                "Simkl API rate limited; retry after {}s",
                jsval::number_string(seconds)
            )));
        }
        if !(200..300).contains(&status) {
            return Err(unavailable());
        }
        let text = res.text().await.map_err(|_| unavailable())?;
        Ok(serde_json::from_str::<Value>(&text)
            .map_or_else(|_| Value::from(text.as_str()), crate::tmdb::js_numbers))
    }
}

/// `trendingFile(mediaType, period)`.
#[must_use]
pub fn trending_file(media_type: &str, period: &str) -> String {
    let window = if period == "day" { "today" } else { period };
    match media_type {
        "movie" => format!("/discover/trending/movies/{window}_100.json"),
        "tv" => format!("/discover/trending/tv/{window}_100.json"),
        "anime" => format!("/discover/trending/anime/{window}_100.json"),
        _ => format!("/discover/trending/{window}_100.json"),
    }
}

/// `scalar(value)`.
pub fn scalar(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(s) => Some(jsval::trim(s).to_owned()).filter(|s| !s.is_empty()),
        Value::Number(n) => n.as_f64().map(jsval::number_string),
        Value::Null | Value::Bool(_) | Value::Array(_) | Value::Object(_) => None,
    }
}

/// `numberValue(value)`.
fn number_value(value: Option<&Value>) -> Option<f64> {
    let n = jsval::number_of(value);
    (n.is_finite() && n > 0.0).then_some(n)
}

/// `a ?? b`: the first present, non-null value.
fn coalesce<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    values.iter().copied().flatten().find(|v| !v.is_null())
}

fn object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

/// `simklExternalIds(ids)`.
fn external_ids(ids: Option<&Map<String, Value>>) -> Map<String, Value> {
    let get = |k: &str| ids.and_then(|m| m.get(k));
    let mut out = Map::new();
    if let Some(tmdb) = number_value(coalesce(&[get("tmdb"), get("tmdb_id")])) {
        out.insert(String::from("tmdb"), jsval::num(tmdb));
    }
    let imdb = scalar(coalesce(&[get("imdb"), get("imdb_id")])).filter(|raw| {
        raw.len() >= 6
            && raw.get(..2).is_some_and(|p| p.eq_ignore_ascii_case("tt"))
            && raw.bytes().skip(2).all(|b| b.is_ascii_digit())
    });
    if let Some(imdb) = imdb {
        out.insert(String::from("imdb"), Value::from(imdb.to_lowercase()));
    }
    for (key, alt) in [
        ("tvdb", "tvdb_id"),
        ("anidb", "anidb_id"),
        ("anilist", "anilist_id"),
        ("mal", "mal_id"),
    ] {
        if let Some(n) = number_value(coalesce(&[get(key), get(alt)])) {
            out.insert(String::from(key), jsval::num(n));
        }
    }
    out
}

/// `simklPosterUrl(path)`.
#[must_use]
pub fn poster_url(path: Option<&str>) -> Option<String> {
    let path = path?;
    if jsval::trim(path).is_empty() {
        return None;
    }
    let lower = path.get(..8).unwrap_or(path).to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Some(path.to_owned());
    }
    Some(format!("{POSTER_BASE}/{}_w.webp&q=90", jsval::trim(path)))
}

/// `unwrapSimklLibraryItem`, for reading fields (key order unused).
pub fn unwrap_item(item: &Map<String, Value>) -> Map<String, Value> {
    let Some(nested) = ["show", "movie", "anime"]
        .iter()
        .find_map(|k| object(item.get(*k)))
    else {
        return item.clone();
    };
    let mut out = item.clone();
    for (k, v) in nested {
        out.insert(k.clone(), v.clone());
    }
    let mut set = |key: &str, value: Option<&Value>| match value {
        Some(v) => {
            out.insert(key.to_owned(), v.clone());
        }
        None => {
            out.shift_remove(key);
        }
    };
    set("status", item.get("status"));
    // `null` is a removed rating, not a missing one.
    set(
        "user_rating",
        item.get("user_rating")
            .or_else(|| nested.get("user_rating")),
    );
    set(
        "added_to_list_at",
        coalesce(&[
            item.get("added_to_watchlist_at"),
            item.get("added_to_list_at"),
            nested.get("added_at"),
        ]),
    );
    set(
        "last_watched_at",
        coalesce(&[item.get("last_watched_at"), nested.get("last_watched_at")]),
    );
    set(
        "watched_episodes_count",
        coalesce(&[
            item.get("watched_episodes_count"),
            nested.get("watched_episodes_count"),
        ]),
    );
    set(
        "total_episodes_count",
        coalesce(&[
            item.get("total_episodes_count"),
            nested.get("total_episodes_count"),
        ]),
    );
    set(
        "anime_type",
        coalesce(&[item.get("anime_type"), nested.get("anime_type")]),
    );
    let ids = if nested.get("ids").is_some_and(Value::is_object) {
        nested.get("ids")
    } else {
        item.get("ids")
    };
    set("ids", ids);
    out
}

fn bucket_hint(key: &str) -> Option<&'static str> {
    match key {
        "movies" | "movie" => Some("movie"),
        "tv" | "shows" | "show" => Some("tv"),
        "anime" => Some("anime"),
        _ => None,
    }
}

/// `catalogEntries(payload, typeHint)`.
pub fn catalog_entries(payload: &Value, type_hint: &str) -> Vec<(Map<String, Value>, String)> {
    let entry = |item: &Map<String, Value>, hint: &str| (unwrap_item(item), hint.to_owned());
    match payload {
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_object)
            .map(|item| entry(item, type_hint))
            .collect(),
        Value::Object(map) => {
            let mut from_buckets = Vec::new();
            for (key, value) in jsval::object_entries(map) {
                let Value::Array(items) = value else {
                    continue;
                };
                let Some(hint) = bucket_hint(key) else {
                    continue;
                };
                if type_hint != "all" && hint != type_hint {
                    continue;
                }
                for item in items.iter().filter_map(Value::as_object) {
                    from_buckets.push(entry(item, hint));
                }
            }
            if !from_buckets.is_empty() {
                if type_hint == "all" {
                    from_buckets.retain(|(_, hint)| hint != "anime");
                }
                return from_buckets;
            }
            jsval::object_entries(map)
                .into_iter()
                .filter_map(|(_, v)| v.as_array())
                .flat_map(|items| items.iter().filter_map(Value::as_object))
                .map(|item| entry(item, type_hint))
                .collect()
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => Vec::new(),
    }
}

/// `catalogTitle(item)`; `Err` where `decodeURIComponent` throws.
fn catalog_title(item: &Map<String, Value>) -> Result<Option<String>, String> {
    if let Some(Value::String(title)) = item.get("title") {
        let t = jsval::trim(title);
        if !t.is_empty() {
            return Ok(Some(t.to_owned()));
        }
    }
    let url = item.get("url").and_then(Value::as_str).unwrap_or("");
    let from_url = url.split('/').rfind(|s| !s.is_empty()).map(Value::from);
    let ids = object(item.get("ids"));
    let slug = scalar(coalesce(&[
        item.get("slug"),
        ids.and_then(|m| m.get("slug")),
        from_url.as_ref(),
    ]));
    slug.map_or(Ok(None), |slug| {
        jsval::decode_uri_component(&slug)
            .map(|s| Some(s.replace('-', " ")))
            .ok_or_else(|| String::from("URI malformed"))
    })
}

/// `isSimklVideoGamePlay(item)`.
fn is_video_game_play(item: &Map<String, Value>) -> bool {
    let text = |key: &str| match item.get(key) {
        None | Some(Value::Null) => String::new(),
        v => jsval::string_of(v).to_lowercase(),
    };
    if text("type") == "game" || text("network") == "youtube" {
        return true;
    }
    item.get("genres")
        .and_then(Value::as_array)
        .is_some_and(|genres| {
            genres.iter().any(|g| {
                jsval::string_of(Some(g))
                    .to_lowercase()
                    .contains("video game")
            })
        })
}

/// `looksLikeAnimeFilmTitle(title)`.
#[must_use]
pub fn looks_like_anime_film_title(title: &str) -> bool {
    if title.contains("劇場版") || title.contains("映画") {
        return true;
    }
    let chars: Vec<char> = title.chars().collect();
    let word = |c: Option<&char>| c.is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_');
    let words: [&[&str]; 5] = [
        &["gekijoban", "gekijouban", "gekijōban", "gekijōuban"],
        &["eiga"],
        &["movie"],
        &["film"],
        &["theatrical"],
    ];
    let same = |c: char, w: char| {
        if w == 'ō' {
            c == 'ō' || c == 'Ō'
        } else {
            c.eq_ignore_ascii_case(&w)
        }
    };
    (0..chars.len()).any(|i| {
        if i > 0 && word(chars.get(i - 1)) {
            return false;
        }
        words.iter().flat_map(|alts| alts.iter()).any(|w| {
            let w: Vec<char> = w.chars().collect();
            chars
                .get(i..i + w.len())
                .is_some_and(|s| s.iter().zip(&w).all(|(c, w)| same(*c, *w)))
                && !word(chars.get(i + w.len()))
        })
    })
}

/// `SimklCandidate` as JSON (Node reads it back), built by
/// `toSimklCandidate`; `Err` where Node would throw.
fn to_candidate(
    item: &Map<String, Value>,
    type_hint: &str,
    key_prefix: &str,
) -> Result<Option<Value>, String> {
    if is_video_game_play(item) {
        return Ok(None);
    }
    let ids = object(item.get("ids"));
    let Some(id) = scalar(coalesce(&[
        ids.and_then(|m| m.get("simkl")),
        ids.and_then(|m| m.get("simkl_id")),
        item.get("simkl_id"),
        item.get("id"),
    ])) else {
        return Ok(None);
    };
    let Some(title) = catalog_title(item)? else {
        return Ok(None);
    };
    let url = item.get("url").and_then(Value::as_str);
    let is_anime = type_hint == "anime"
        || item
            .get("anime_type")
            .and_then(Value::as_str)
            .is_some_and(|t| !jsval::trim(t).is_empty())
        || url.is_some_and(|u| u.contains("/anime/"));
    let anime_type = scalar(item.get("anime_type")).map(|t| t.to_lowercase());
    let source_type = jsval::string_of(item.get("type"));
    let typed_from_source = source_type == "movie"
        || source_type == "show"
        || matches!(anime_type.as_deref(), Some("movie" | "tv"))
        || type_hint == "movie";
    let media_type = if source_type == "movie"
        || anime_type.as_deref() == Some("movie")
        || type_hint == "movie"
        || (!typed_from_source && is_anime && looks_like_anime_film_title(&title))
    {
        "movie"
    } else {
        "tv"
    };
    let external = external_ids(ids);
    let tmdb_id = external.get("tmdb").and_then(Value::as_f64);
    let poster = poster_url(item.get("poster").and_then(Value::as_str));
    let year = jsval::number_of(item.get("year"));
    let source_url = match url {
        Some(u) if u.starts_with("http") => u.to_owned(),
        Some(u) if u.starts_with('/') => format!("https://simkl.com{u}"),
        _ => {
            let kind = if type_hint == "anime" {
                "anime"
            } else if media_type == "movie" {
                "movies"
            } else {
                "tv"
            };
            let slug = scalar(coalesce(&[
                item.get("slug"),
                ids.and_then(|m| m.get("slug")),
            ]))
            .unwrap_or_else(|| id.clone());
            format!("https://simkl.com/{kind}/{}", encode_uri_component(&slug))
        }
    };
    let mut out = Map::new();
    out.insert(String::from("ids"), Value::Object(external));
    out.insert(String::from("isAnime"), Value::Bool(is_anime));
    if year.fract() == 0.0 && year.is_finite() && year > 1870.0 {
        out.insert(String::from("year"), jsval::num(year));
    }
    out.insert(
        String::from("typedFromSource"),
        Value::Bool(typed_from_source),
    );
    let fallback_id = jsval::number_of_str(&id);
    let shown_id = tmdb_id.unwrap_or(fallback_id);
    let mut card = Map::new();
    card.insert(
        String::from("id"),
        jsval::num(if shown_id.is_nan() || shown_id == 0.0 {
            0.0
        } else {
            shown_id
        }),
    );
    card.insert(
        String::from("ratingKey"),
        Value::from(format!("{key_prefix}-{id}")),
    );
    if let Some(tmdb) = tmdb_id {
        card.insert(String::from("tmdbId"), jsval::num(tmdb));
    }
    card.insert(String::from("mediaType"), Value::from(media_type));
    card.insert(String::from("title"), Value::from(title));
    card.insert(String::from("source"), Value::from("simkl"));
    card.insert(String::from("sourceId"), Value::from(id));
    card.insert(String::from("sourceUrl"), Value::from(source_url));
    if let Some(poster) = poster {
        card.insert(String::from("image"), Value::from(poster));
    }
    out.insert(String::from("item"), Value::Object(card));
    Ok(Some(Value::Object(out)))
}

/// `catalogCandidates([payload], typeHint, keyPrefix)`.
///
/// # Errors
///
/// Fails with `URI malformed` where Node's title decoding throws.
pub fn catalog_candidates(
    payload: &Value,
    type_hint: &str,
    key_prefix: &str,
) -> Result<Vec<Value>, String> {
    let mut results = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for (item, hint) in catalog_entries(payload, type_hint) {
        let Some(candidate) = to_candidate(&item, &hint, key_prefix)? else {
            continue;
        };
        let key = candidate
            .pointer("/item/ratingKey")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        results.push(candidate);
    }
    Ok(results)
}

/// One `simkl_sync_item` row as `toSyncCandidate` reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct SyncRow {
    /// `simklId`.
    pub simkl_id: String,
    /// `movie`, `show` or `anime`.
    pub simkl_type: String,
    /// `tmdbId`.
    pub tmdb_id: Option<f64>,
    /// `tvdbId`.
    pub tvdb_id: Option<f64>,
    /// `slug`.
    pub slug: Option<String>,
    /// `title`.
    pub title: String,
    /// `posterPath`.
    pub poster_path: Option<String>,
}

/// `toSyncCandidate(row)` (routes/discover/simkl.ts).
#[must_use]
pub fn sync_candidate(row: &SyncRow) -> Value {
    let media_type = if row.simkl_type == "movie" {
        "movie"
    } else {
        "tv"
    };
    let image = poster_url(row.poster_path.as_deref());
    let tmdb_id = row.tmdb_id.filter(|n| n.is_finite() && *n > 0.0);
    let series_id = row.tvdb_id.filter(|n| *n > 0.0);
    let kind = match row.simkl_type.as_str() {
        "movie" => "movies",
        "anime" => "anime",
        _ => "tv",
    };
    let slug = row
        .slug
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(&row.simkl_id);
    let mut ids = Map::new();
    if let Some(tmdb) = tmdb_id {
        ids.insert(String::from("tmdb"), jsval::num(tmdb));
    }
    if let Some(series) = series_id {
        ids.insert(String::from("tvdb"), jsval::num(series));
    }
    let shown_id = tmdb_id.unwrap_or_else(|| jsval::number_of_str(&row.simkl_id));
    let mut tile = Map::new();
    tile.insert(
        String::from("id"),
        jsval::num(if shown_id.is_nan() || shown_id == 0.0 {
            0.0
        } else {
            shown_id
        }),
    );
    tile.insert(
        String::from("ratingKey"),
        Value::from(format!("simkl-{}-{}", row.simkl_type, row.simkl_id)),
    );
    if let Some(tmdb) = tmdb_id {
        tile.insert(String::from("tmdbId"), jsval::num(tmdb));
    }
    tile.insert(String::from("mediaType"), Value::from(media_type));
    tile.insert(String::from("title"), Value::from(row.title.as_str()));
    tile.insert(String::from("source"), Value::from("simkl"));
    tile.insert(String::from("sourceId"), Value::from(row.simkl_id.as_str()));
    tile.insert(
        String::from("sourceUrl"),
        Value::from(format!(
            "https://simkl.com/{kind}/{}",
            encode_uri_component(slug)
        )),
    );
    if let Some(image) = image {
        tile.insert(String::from("image"), Value::from(image));
    }
    let mut out = Map::new();
    out.insert(
        String::from("isAnime"),
        Value::Bool(row.simkl_type == "anime"),
    );
    out.insert(String::from("typedFromSource"), Value::Bool(true));
    out.insert(String::from("ids"), Value::Object(ids));
    out.insert(String::from("item"), Value::Object(tile));
    Value::Object(out)
}

/// `paginateWatchlist(results, page)`: the page, whether more follow.
#[must_use]
pub fn paginate(results: Vec<Value>, page: i64) -> (Vec<Value>, bool, i64) {
    let page = page.max(1);
    let start = usize::try_from((page - 1).saturating_mul(20)).unwrap_or(usize::MAX);
    let has_more = start.saturating_add(20) < results.len();
    let slice = results.into_iter().skip(start).take(20).collect();
    (slice, has_more, page)
}

/// `needsSimklDetail(candidate)`.
fn needs_detail(candidate: &Value) -> bool {
    let truthy = |p: &str| crate::settings::public::truthy(candidate.pointer(p));
    if !truthy("/item/sourceId") {
        return false;
    }
    if truthy("/isAnime") {
        if !truthy("/typedFromSource") {
            return true;
        }
        return !truthy("/ids/imdb") && !truthy("/ids/tvdb");
    }
    !truthy("/ids/tmdb") && !truthy("/ids/imdb") && !truthy("/ids/tvdb")
}

/// `simklDetailKind(item)`.
fn detail_kind(candidate: &Value) -> &'static str {
    if candidate
        .pointer("/item/sourceUrl")
        .and_then(Value::as_str)
        .is_some_and(|u| u.contains("/anime/"))
    {
        "anime"
    } else if candidate.pointer("/item/mediaType").and_then(Value::as_str) == Some("movie") {
        "movies"
    } else {
        "tv"
    }
}

/// The hydrated candidate, or `None` for a video game.
fn merge_detail(mut candidate: Value, detail: &Map<String, Value>) -> Option<Value> {
    if is_video_game_play(detail) {
        return None;
    }
    let anime_type = scalar(detail.get("anime_type")).map(|t| t.to_lowercase());
    let detail_type = jsval::string_of(detail.get("type"));
    let fresh_ids = external_ids(object(detail.get("ids")));
    let Value::Object(map) = &mut candidate else {
        return Some(candidate);
    };
    let mut ids = map
        .get("ids")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for (k, v) in fresh_ids {
        ids.insert(k, v);
    }
    let typed = crate::settings::public::truthy(map.get("typedFromSource"))
        || detail_type == "movie"
        || detail_type == "show"
        || matches!(anime_type.as_deref(), Some("movie" | "tv"));
    let tmdb = ids.get("tmdb").and_then(Value::as_f64).filter(|n| *n > 0.0);
    map.insert(String::from("typedFromSource"), Value::Bool(typed));
    map.insert(String::from("ids"), Value::Object(ids));
    if let Some(Value::Object(item)) = map.get_mut("item") {
        let title = detail
            .get("title")
            .and_then(Value::as_str)
            .map(jsval::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_owned);
        if let Some(title) = title {
            item.insert(String::from("title"), Value::from(title));
        }
        let media_type = if detail_type == "movie" || anime_type.as_deref() == Some("movie") {
            Some("movie")
        } else if anime_type.as_deref() == Some("tv") || detail_type == "show" {
            Some("tv")
        } else {
            None
        };
        if let Some(media_type) = media_type {
            item.insert(String::from("mediaType"), Value::from(media_type));
        }
        if let Some(tmdb) = tmdb {
            item.insert(String::from("tmdbId"), jsval::num(tmdb));
        }
    }
    Some(candidate)
}

/// `hydrateSimklCandidates(candidates, loadTitle)`: up to four detail
/// reads at a time, order kept.
pub async fn hydrate(simkl: &Simkl, candidates: Vec<Value>) -> Vec<Value> {
    let mut slots: Vec<Option<Value>> = Vec::with_capacity(candidates.len());
    let mut set = tokio::task::JoinSet::new();
    let mut pending = candidates.into_iter().enumerate();
    let mut running = 0_usize;
    loop {
        while running < 4 {
            let Some((index, candidate)) = pending.next() else {
                break;
            };
            slots.push(None);
            let simkl = simkl.clone();
            set.spawn(async move {
                if !needs_detail(&candidate) {
                    return (index, Some(candidate));
                }
                let source_id = jsval::string_of(candidate.pointer("/item/sourceId"));
                match simkl.title(detail_kind(&candidate), &source_id).await {
                    Ok(detail) => (index, merge_detail(candidate, &detail)),
                    Err(()) => (index, Some(candidate)),
                }
            });
            running += 1;
        }
        let Some(done) = set.join_next().await else {
            break;
        };
        running -= 1;
        if let Ok((index, value)) = done {
            if let Some(slot) = slots.get_mut(index) {
                *slot = value;
            }
        }
    }
    slots.into_iter().flatten().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn concurrent_requests_are_spaced() -> anyhow::Result<()> {
        if rustls::crypto::ring::default_provider()
            .install_default()
            .is_err()
        {
            tracing::trace!("a provider was installed");
        }
        let settings = Settings::from_file_value(json!({"simkl": {"clientId": "id"}}), None)?;
        let simkl = Simkl::new(&reqwest::Client::new(), &settings, "1.0.0")
            .ok_or_else(|| anyhow::anyhow!("configured"))?;
        let start = Instant::now();
        let paced = || async {
            simkl.pace().await;
            start.elapsed()
        };
        let mut times: [Duration; 3] = tokio::join!(paced(), paced(), paced()).into();
        times.sort();
        assert!(
            times[1] >= Duration::from_millis(100),
            "second waits one slot"
        );
        assert!(
            times[2] >= Duration::from_millis(200),
            "third waits two slots"
        );
        Ok(())
    }

    #[test]
    fn film_titles() {
        assert!(looks_like_anime_film_title("Gekijōban Foo"), "macron");
        assert!(looks_like_anime_film_title("The MOVIE"), "case");
        assert!(!looks_like_anime_film_title("Moviestar"), "word boundary");
        assert!(looks_like_anime_film_title("劇場版 X"), "kanji");
    }

    #[test]
    fn candidates_from_a_catalog() {
        let payload = json!({
            "movies": [{"title": "A", "ids": {"simkl_id": 1, "tmdb": "55", "imdb": "TT0012345"}, "url": "/movies/1/a", "poster": "ab/cd", "year": 2001}],
            "anime": [{"title": "Skip", "ids": {"simkl_id": 2}}],
            "tv": [{"ids": {"simkl_id": 3, "slug": "my-show"}, "network": "YouTube"}, {"ids": {"simkl_id": 4, "slug": "other-show"}}]
        });
        let candidates = catalog_candidates(&payload, "all", "simkl-public").unwrap_or_default();
        assert_eq!(
            candidates,
            vec![
                json!({"ids": {"tmdb": 55, "imdb": "tt0012345"}, "isAnime": false, "year": 2001, "typedFromSource": true, "item": {
                    "id": 55, "ratingKey": "simkl-public-1", "tmdbId": 55, "mediaType": "movie", "title": "A", "source": "simkl",
                    "sourceId": "1", "sourceUrl": "https://simkl.com/movies/1/a", "image": "https://wsrv.nl/?url=https://simkl.in/posters/ab/cd_w.webp&q=90"}}),
                json!({"ids": {}, "isAnime": false, "typedFromSource": false, "item": {
                    "id": 4, "ratingKey": "simkl-public-4", "mediaType": "tv", "title": "other show", "source": "simkl",
                    "sourceId": "4", "sourceUrl": "https://simkl.com/tv/other-show"}}),
            ],
            "anime dropped from all, games skipped"
        );
        assert_eq!(
            catalog_candidates(
                &json!([{"ids": {"simkl": 9, "slug": "%E0%A4%A"}}]),
                "tv",
                "k"
            ),
            Err(String::from("URI malformed")),
            "bad slug"
        );
    }

    #[test]
    fn hydration_merges_detail() {
        let candidate = json!({"ids": {"tmdb": 5}, "isAnime": true, "typedFromSource": false, "item": {"id": 5, "ratingKey": "k", "mediaType": "tv", "title": "x", "sourceId": "9"}});
        assert!(needs_detail(&candidate), "untyped anime");
        let detail = json!({"title": " Full ", "anime_type": "Movie", "ids": {"imdb": "tt1234567", "tmdb": 8}});
        let merged = detail.as_object().and_then(|d| merge_detail(candidate, d));
        assert_eq!(
            merged,
            Some(
                json!({"ids": {"tmdb": 8, "imdb": "tt1234567"}, "isAnime": true, "typedFromSource": true, "item": {"id": 5, "ratingKey": "k", "mediaType": "movie", "title": "Full", "sourceId": "9", "tmdbId": 8}})
            ),
            "merged"
        );
        assert_eq!(
            trending_file("all", "day"),
            "/discover/trending/today_100.json",
            "file"
        );
    }
}
