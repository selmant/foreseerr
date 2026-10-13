//! `server/api/themoviedb`: the parts of the TMDB client ported so far,
//! with `ExternalAPI.get`'s response cache (five minutes unless a call
//! names its own TTL).
//!
//! Cached answers are shared: [`TmdbClient::raw`] hands out the stored
//! value itself, and the lookups that reshape theirs copy it first.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::Value;

use crate::memcache::{self, CacheId};

const BASE_URL: &str = "https://api.themoviedb.org/3";
/// The key every Foreseerr install uses.
const API_KEY: &str = "431a8708161bcd1f1fbe7536137e61ed";
/// A day, the TTL of the configuration lookups.
const DAY: Duration = Duration::from_secs(86_400);
/// Twelve hours, the TTL of title details.
const HALF_DAY: Duration = Duration::from_secs(43_200);
/// `ExternalAPI`'s default TTL.
const DEFAULT_TTL: Duration = Duration::from_secs(300);
const MOVIE_DETAILS_APPEND: &str =
    "credits,external_ids,videos,keywords,release_dates,watch/providers";
const TV_DETAILS_APPEND: &str =
    "aggregate_credits,credits,external_ids,keywords,videos,content_ratings,watch/providers";

/// A TMDB client over the shared `tmdb` response cache.
#[derive(Debug, Clone)]
pub struct TmdbClient {
    client: reqwest::Client,
}

impl TmdbClient {
    /// A client that sends through `client`.
    #[must_use]
    pub const fn new(client: reqwest::Client) -> Self {
        Self { client }
    }

    /// `getRegions`: countries sorted by English name.
    ///
    /// # Errors
    ///
    /// Fails when TMDB can't be reached or answers an error.
    pub async fn regions(&self) -> Result<Vec<Value>> {
        let data = self.get("/configuration/countries", &[], DAY).await?;
        Ok(sort_by_english_name(as_array(&data)))
    }

    /// `getLanguages`: languages sorted by English name.
    ///
    /// # Errors
    ///
    /// Fails when TMDB can't be reached or answers an error.
    pub async fn languages(&self) -> Result<Vec<Value>> {
        let data = self.get("/configuration/languages", &[], DAY).await?;
        Ok(sort_by_english_name(as_array(&data)))
    }

    /// `getAvailableWatchProviderRegions`.
    ///
    /// # Errors
    ///
    /// Fails when TMDB can't be reached or answers an error.
    pub async fn watch_provider_regions(&self, language: Option<&str>) -> Result<Vec<Value>> {
        let params = language.map(|l| ("language", l));
        let data = self
            .get("/watch/providers/regions", params.as_slice(), DAY)
            .await?;
        Ok(results(&data))
    }

    /// `getMovieWatchProviders` or `getTvWatchProviders`, by `kind`.
    ///
    /// # Errors
    ///
    /// Fails when TMDB can't be reached or answers an error.
    pub async fn watch_providers(
        &self,
        kind: &str,
        language: Option<&str>,
        watch_region: &str,
    ) -> Result<Vec<Value>> {
        let mut params = Vec::new();
        if let Some(l) = language {
            params.push(("language", l));
        }
        params.push(("watch_region", watch_region));
        let data = self
            .get(&format!("/watch/providers/{kind}"), &params, DAY)
            .await?;
        Ok(results(&data))
    }

    /// `getMovie`: the movie with credits, external ids, videos, keywords,
    /// release dates and watch providers, cached for twelve hours.
    ///
    /// # Errors
    ///
    /// Fails when TMDB can't be reached or answers an error.
    pub async fn movie(&self, id: impl PathNumber, language: &str) -> Result<Value> {
        self.title("movie", id, language, MOVIE_DETAILS_APPEND)
            .await
    }

    /// `getTvShow`: the show with aggregate credits, crew, external ids,
    /// keywords, videos, content ratings and watch providers, cached for
    /// twelve hours; the unread `aggregate_credits.crew` and `credits.cast`
    /// are dropped before caching as `stripUnreadTvCredits` does.
    ///
    /// # Errors
    ///
    /// Fails when TMDB can't be reached or answers an error.
    pub async fn tv(&self, id: impl PathNumber, language: &str) -> Result<Value> {
        self.title("tv", id, language, TV_DETAILS_APPEND).await
    }

    /// `getTitleSummary`: the bare `/movie/{id}` or `/tv/{id}` record, without
    /// appends, for a list tile and an existence check. A full [`Self::movie`]
    /// or [`Self::tv`] answer already cached is reused; otherwise the request
    /// shares its cache entry (and its twelve hours) with the browse metadata
    /// lookups.
    ///
    /// # Errors
    ///
    /// Fails when TMDB can't be reached or answers an error.
    pub async fn title_summary(&self, kind: &str, id: i64, language: &str) -> Result<Value> {
        let path = format!("/{kind}/{id}");
        let append = if kind == "movie" {
            MOVIE_DETAILS_APPEND
        } else {
            TV_DETAILS_APPEND
        };
        let full = cache_key(
            &path,
            &[
                ("language", language),
                ("append_to_response", append),
                ("include_video_language", language),
            ],
        );
        if let Some(cached) = memcache::get(CacheId::Tmdb, &full) {
            return Ok(Arc::unwrap_or_clone(cached));
        }
        self.owned(&path, &[("language", language)], HALF_DAY).await
    }

    /// A title's details. For a non-English language without a trailer,
    /// English trailers are appended from a second lookup (failures of that
    /// one are ignored).
    async fn title(
        &self,
        kind: &str,
        id: impl PathNumber,
        language: &str,
        append: &str,
    ) -> Result<Value> {
        let path = format!("/{kind}/{}", id.path_text());
        let mut data = self
            .owned(
                &path,
                &[
                    ("language", language),
                    ("append_to_response", append),
                    ("include_video_language", language),
                ],
                HALF_DAY,
            )
            .await?;
        if kind == "tv" {
            data = strip_unread_tv_credits(data);
        }
        let has_trailer = |videos: Option<&Value>| {
            videos
                .and_then(|v| v.get("results"))
                .and_then(Value::as_array)
                .is_some_and(|results| {
                    results
                        .iter()
                        .any(|video| video.get("type").and_then(Value::as_str) == Some("Trailer"))
                })
        };
        if !language.starts_with("en") && !has_trailer(data.get("videos")) {
            let fallback = self
                .get(
                    &path,
                    &[
                        ("language", language),
                        ("append_to_response", "videos"),
                        ("include_video_language", "en"),
                    ],
                    HALF_DAY,
                )
                .await;
            if let Ok(fallback) = fallback {
                let localized: Vec<Value> = data
                    .pointer("/videos/results")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let keys: Vec<Option<&Value>> = localized.iter().map(|v| v.get("key")).collect();
                let english: Vec<Value> = fallback
                    .pointer("/videos/results")
                    .and_then(Value::as_array)
                    .map(|results| {
                        results
                            .iter()
                            .filter(|video| {
                                video.get("type").and_then(Value::as_str) == Some("Trailer")
                                    && !keys.contains(&video.get("key"))
                            })
                            .cloned()
                            .collect()
                    })
                    .unwrap_or_default();
                if !english.is_empty() {
                    let mut videos = match data.get("videos") {
                        Some(Value::Object(videos)) => videos.clone(),
                        Some(
                            Value::Null
                            | Value::Bool(_)
                            | Value::Number(_)
                            | Value::String(_)
                            | Value::Array(_),
                        )
                        | None => serde_json::Map::new(),
                    };
                    let mut results = localized;
                    results.extend(english);
                    videos.insert(String::from("results"), Value::Array(results));
                    if let Value::Object(map) = &mut data {
                        map.insert(String::from("videos"), Value::Object(videos));
                    }
                }
            }
        }
        Ok(data)
    }

    /// `getMovieRecommendations`, `getMovieSimilar`, `getTvRecommendations`
    /// and `getTvSimilar`: one page of a title's `recommendations` or
    /// `similar` list, cached five minutes.
    ///
    /// # Errors
    ///
    /// Fails when TMDB can't be reached or answers an error.
    pub async fn title_list(
        &self,
        kind: &str,
        id: impl PathNumber,
        list: &str,
        page: impl PathNumber,
        language: &str,
    ) -> Result<Value> {
        self.owned(
            &format!("/{kind}/{}/{list}", id.path_text()),
            &[("page", &page.path_text()), ("language", language)],
            DEFAULT_TTL,
        )
        .await
    }

    /// `getPerson`, cached five minutes.
    ///
    /// # Errors
    ///
    /// Fails when TMDB can't be reached or answers an error.
    pub async fn person(&self, id: impl PathNumber, language: &str) -> Result<Value> {
        self.owned(
            &format!("/person/{}", id.path_text()),
            &[("language", language)],
            DEFAULT_TTL,
        )
        .await
    }

    /// `getPersonCombinedCredits`, cached five minutes.
    ///
    /// # Errors
    ///
    /// Fails when TMDB can't be reached or answers an error.
    pub async fn person_combined_credits(
        &self,
        id: impl PathNumber,
        language: &str,
    ) -> Result<Value> {
        self.owned(
            &format!("/person/{}/combined_credits", id.path_text()),
            &[("language", language)],
            DEFAULT_TTL,
        )
        .await
    }

    /// `getCollection`, cached five minutes.
    ///
    /// # Errors
    ///
    /// Fails when TMDB can't be reached or answers an error.
    pub async fn collection(&self, id: impl PathNumber, language: &str) -> Result<Value> {
        self.owned(
            &format!("/collection/{}", id.path_text()),
            &[("language", language)],
            DEFAULT_TTL,
        )
        .await
    }

    /// `getTvSeason`: a season with its episodes and external ids, cached
    /// five minutes, with the image host prefixed onto each episode's
    /// `still_path`. The prefix goes on a copy: Node writes it onto the
    /// object its cache holds, so each later call within the TTL prefixes
    /// it once more, and that isn't carried over.
    ///
    /// # Errors
    ///
    /// Fails when TMDB can't be reached or answers an error.
    pub async fn tv_season(
        &self,
        id: impl PathNumber,
        season: impl PathNumber,
        language: &str,
    ) -> Result<Value> {
        let path = format!("/tv/{}/season/{}", id.path_text(), season.path_text());
        let params = [
            ("language", language),
            ("append_to_response", "external_ids"),
        ];
        let mut data = self.owned(&path, &params, DEFAULT_TTL).await?;
        if let Some(Value::Array(episodes)) = data.get_mut("episodes") {
            for episode in episodes.iter_mut() {
                let still = episode
                    .get("still_path")
                    .filter(|v| crate::settings::public::truthy(Some(v)))
                    .map(|v| crate::media::js_string(Some(v)).into_owned());
                if let (Some(still), Value::Object(map)) = (still, &mut *episode) {
                    map.insert(
                        String::from("still_path"),
                        Value::from(format!("https://image.tmdb.org/t/p/original/{still}")),
                    );
                }
            }
        }
        Ok(data)
    }

    /// `searchMulti`, cached five minutes; a failure is an empty page, as
    /// Node swallows it.
    pub async fn search_multi(&self, query: &str, page: impl PathNumber, language: &str) -> Value {
        match self
            .owned(
                "/search/multi",
                &[
                    ("query", query),
                    ("page", &page.path_text()),
                    ("include_adult", "false"),
                    ("language", language),
                ],
                DEFAULT_TTL,
            )
            .await
        {
            Ok(data) => data,
            Err(e) => {
                tracing::debug!("TMDB multi search failed: {e:#}");
                let mut empty = serde_json::Map::new();
                empty.insert(String::from("page"), Value::from(1));
                empty.insert(String::from("results"), Value::Array(Vec::new()));
                empty.insert(String::from("total_pages"), Value::from(1));
                empty.insert(String::from("total_results"), Value::from(0));
                Value::Object(empty)
            }
        }
    }

    /// `searchKeyword` / `searchCompany`: TMDB's page as it is, cached a
    /// day.
    ///
    /// # Errors
    ///
    /// Fails when TMDB can't be reached or answers an error.
    pub async fn search_plain(
        &self,
        kind: &str,
        query: &str,
        page: impl PathNumber,
    ) -> Result<Value> {
        self.owned(
            &format!("/search/{kind}"),
            &[("query", query), ("page", &page.path_text())],
            DAY,
        )
        .await
    }

    /// A cached GET with parameters already in axios order (absent ones
    /// left out), for the routes that build their own; `ttl` in seconds.
    /// The answer is the cached one, shared.
    ///
    /// # Errors
    ///
    /// Fails when TMDB can't be reached or answers an error.
    pub async fn raw(
        &self,
        path: &str,
        params: &[(&str, String)],
        ttl_secs: u64,
    ) -> Result<Arc<Value>> {
        let borrowed: Vec<(&str, &str)> = params.iter().map(|(k, v)| (*k, v.as_str())).collect();
        self.get(path, &borrowed, Duration::from_secs(ttl_secs))
            .await
    }

    /// [`Self::raw`] through the library scans' `tmdbscan` cache.
    ///
    /// # Errors
    ///
    /// Fails when TMDB can't be reached or answers an error.
    pub async fn raw_scan(
        &self,
        path: &str,
        params: &[(&str, String)],
        ttl_secs: u64,
    ) -> Result<Arc<Value>> {
        let borrowed: Vec<(&str, &str)> = params.iter().map(|(k, v)| (*k, v.as_str())).collect();
        self.get_in(
            CacheId::TmdbScan,
            path,
            &borrowed,
            Duration::from_secs(ttl_secs),
        )
        .await
    }

    /// `getMovieGenres` / `getTvGenres`: the genre list, nameless genres
    /// named from the English list for other languages, nameless ones
    /// dropped, sorted by name.
    ///
    /// # Errors
    ///
    /// Fails when TMDB can't be reached or answers an error.
    pub async fn genres(&self, kind: &str, language: &str) -> Result<Vec<Value>> {
        let path = format!("/genre/{kind}/list");
        let data = self.get(&path, &[("language", language)], DAY).await?;
        let mut genres: Vec<Value> = data
            .get("genres")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let nameless = |g: &Value| !crate::settings::public::truthy(g.get("name"));
        if !language.starts_with("en") && genres.iter().any(nameless) {
            let english = self.get(&path, &[("language", "en")], DAY).await?;
            let english = english
                .get("genres")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for genre in genres.iter_mut().filter(|g| nameless(g)) {
                let name = english
                    .iter()
                    .find(|e| e.get("id") == genre.get("id"))
                    .and_then(|e| e.get("name"))
                    .cloned()
                    .unwrap_or_else(|| Value::from(""));
                if let Value::Object(map) = genre {
                    map.insert(String::from("name"), name);
                }
            }
        }
        genres.retain(|g| !nameless(g));
        genres.sort_by(|a, b| {
            let name = |v: &Value| {
                v.get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .encode_utf16()
                    .collect::<Vec<_>>()
            };
            name(a).cmp(&name(b))
        });
        Ok(genres)
    }

    /// `ExternalAPI.get`: the cached answer if it is still fresh, otherwise
    /// a request with `api_key` first and `params` after it.
    async fn get(&self, path: &str, params: &[(&str, &str)], ttl: Duration) -> Result<Arc<Value>> {
        self.get_in(CacheId::Tmdb, path, params, ttl).await
    }

    /// [`Self::get`], as a copy the caller may change.
    async fn owned(&self, path: &str, params: &[(&str, &str)], ttl: Duration) -> Result<Value> {
        self.get(path, params, ttl).await.map(Arc::unwrap_or_clone)
    }

    /// `ExternalAPI.get` with `options.cache`.
    async fn get_in(
        &self,
        cache: CacheId,
        path: &str,
        params: &[(&str, &str)],
        ttl: Duration,
    ) -> Result<Arc<Value>> {
        let url = request_url(path, params);
        let key = cache_key(path, params);
        if let Some(value) = memcache::get(cache, &key) {
            return Ok(value);
        }
        let value: Value = self
            .client
            .get(&url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .send()
            .await
            .with_context(|| format!("GET {path}"))?
            .error_for_status()
            .with_context(|| format!("GET {path}"))?
            .json()
            .await
            .with_context(|| format!("GET {path}: not JSON"))?;
        let value = Arc::new(js_numbers(value));
        memcache::set(cache, key, Arc::clone(&value), ttl);
        Ok(value)
    }
}

/// The cache key of a request: its path and parameters, in order.
fn cache_key(path: &str, params: &[(&str, &str)]) -> String {
    format!("{BASE_URL}{path} {params:?}")
}

/// Put an answer in the `tmdb` cache as a request would, for tests that
/// must not reach TMDB.
#[cfg(test)]
pub fn remember_for_tests(path: &str, params: &[(&str, &str)], value: Value) {
    memcache::set(CacheId::Tmdb, cache_key(path, params), value, HALF_DAY);
}

/// The request URL: the API key first, then the parameters in order.
fn request_url(path: &str, params: &[(&str, &str)]) -> String {
    let mut url = format!("{BASE_URL}{path}?api_key={API_KEY}");
    for (k, v) in params {
        url.push('&');
        url.push_str(k);
        url.push('=');
        url.push_str(&axios_encode(v));
    }
    url
}

/// `stripUnreadTvCredits`: drop the aggregate crew and the plain cast.
fn strip_unread_tv_credits(mut data: Value) -> Value {
    if let Some(Value::Object(aggregate)) = data.get_mut("aggregate_credits") {
        aggregate.shift_remove("crew");
    }
    if let Some(Value::Object(credits)) = data.get_mut("credits") {
        credits.shift_remove("cast");
    }
    data
}

/// Numbers as JavaScript would re-print them: a whole float (`8.0`) prints
/// as an integer (`8`), since JSON parsing loses the distinction.
#[must_use]
pub fn js_numbers(value: Value) -> Value {
    match value {
        Value::Number(n) => match n.as_f64() {
            Some(f) if n.is_f64() && f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0 => {
                format!("{f:.0}")
                    .parse::<i64>()
                    .map_or(Value::Number(n), Value::from)
            }
            _ => Value::Number(n),
        },
        Value::Array(items) => Value::Array(items.into_iter().map(js_numbers).collect()),
        Value::Object(map) => {
            Value::Object(map.into_iter().map(|(k, v)| (k, js_numbers(v))).collect())
        }
        other @ (Value::Null | Value::Bool(_) | Value::String(_)) => other,
    }
}

/// A copy of the items, or nothing when `value` isn't a list.
fn as_array(value: &Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
}

/// A copy of `data.results`, or nothing when the shape is off.
fn results(value: &Value) -> Vec<Value> {
    value.get("results").map_or_else(Vec::new, as_array)
}

/// lodash `sortBy(data, 'english_name')`: a stable sort comparing the
/// strings as JavaScript does, by UTF-16 code unit.
fn sort_by_english_name(mut items: Vec<Value>) -> Vec<Value> {
    let key = |v: &Value| -> Vec<u16> {
        v.get("english_name")
            .and_then(Value::as_str)
            .map(|s| s.encode_utf16().collect())
            .unwrap_or_default()
    };
    items.sort_by_cached_key(key);
    items
}

/// axios's query encoding: `encodeURIComponent`, then `:$,[]` put back and
/// spaces written as `+`.
#[must_use]
pub fn axios_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b' ' => out.push('+'),
            b':' | b'$' | b',' | b'[' | b']' => out.push(char::from(byte)),
            b if b.is_ascii_alphanumeric()
                || matches!(
                    b,
                    b'-' | b'_' | b'.' | b'~' | b'!' | b'\'' | b'(' | b')' | b'*'
                ) =>
            {
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

/// An id or page in a TMDB request: an integer, or a JavaScript number
/// written the way `String(n)` (and axios) writes it (`1.5`, `Infinity`).
pub trait PathNumber: Copy + Send {
    /// The text the path or query gets.
    fn path_text(self) -> String;
}

impl PathNumber for i64 {
    fn path_text(self) -> String {
        self.to_string()
    }
}

impl PathNumber for f64 {
    fn path_text(self) -> String {
        crate::jsval::number_string(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn title_summary_reuses_cached_details() {
        let full = json!({"id": 9_700_003, "name": "Cached", "poster_path": "/c.jpg", "vote_average": 7.1});
        memcache::set(
            CacheId::Tmdb,
            cache_key(
                "/tv/9700003",
                &[
                    ("language", "en"),
                    ("append_to_response", TV_DETAILS_APPEND),
                    ("include_video_language", "en"),
                ],
            ),
            full.clone(),
            HALF_DAY,
        );
        if rustls::crypto::ring::default_provider()
            .install_default()
            .is_err()
        {
            tracing::trace!("a provider was installed");
        }
        // Served from the cache: TMDB itself would answer something else.
        let client = TmdbClient::new(reqwest::Client::new());
        let summary = client.title_summary("tv", 9_700_003, "en").await.ok();
        assert_eq!(summary, Some(full), "the cached full record");
        let bare = json!({"id": 9_700_004, "title": "Bare"});
        memcache::set(
            CacheId::Tmdb,
            cache_key("/movie/9700004", &[("language", "en")]),
            bare.clone(),
            HALF_DAY,
        );
        let summary = client.title_summary("movie", 9_700_004, "en").await.ok();
        assert_eq!(summary, Some(bare), "the bare record's own entry");
    }

    #[test]
    fn cache_keys_tell_requests_apart() {
        let key = cache_key("/search/movie", &[("query", "a&b=c"), ("page", "1")]);
        assert_eq!(
            key,
            cache_key("/search/movie", &[("query", "a&b=c"), ("page", "1")]),
            "same request, same key"
        );
        for other in [
            cache_key("/search/movie", &[("query", "a"), ("b", "c&page=1")]),
            cache_key("/search/movie", &[("query", "a&b=c"), ("page", "2")]),
            cache_key("/search/tv", &[("query", "a&b=c"), ("page", "1")]),
        ] {
            assert_ne!(key, other, "{other}");
        }
    }

    #[test]
    fn prints_numbers_like_javascript() {
        let v: Value =
            serde_json::from_str(r#"{"a": 8.0, "b": 8.4, "c": [0.0, -2.0, 1e3], "d": 7}"#)
                .unwrap_or(Value::Null);
        assert_eq!(
            js_numbers(v).to_string(),
            r#"{"a":8,"b":8.4,"c":[0,-2,1000],"d":7}"#,
            "whole floats print as integers"
        );
    }

    #[test]
    fn encodes_like_axios() {
        assert_eq!(axios_encode("en-US"), "en-US", "plain");
        assert_eq!(
            axios_encode("a b:c,d$[e]"),
            "a+b:c,d$[e]",
            "axios keeps these"
        );
        assert_eq!(axios_encode("ü/&"), "%C3%BC%2F%26", "escaped");
    }

    #[test]
    fn sorts_like_lodash() {
        let items = vec![
            json!({"english_name": "b", "n": 1}),
            json!({"english_name": "A", "n": 2}),
            json!({"english_name": "a", "n": 3}),
            json!({"english_name": "b", "n": 4}),
        ];
        let sorted: Vec<i64> = sort_by_english_name(items)
            .iter()
            .filter_map(|v| v.get("n").and_then(Value::as_i64))
            .collect();
        assert_eq!(sorted, vec![2, 3, 1, 4], "code unit order, stable for ties");
    }

    #[test]
    fn unwraps_results() {
        assert_eq!(
            results(&json!({"results": [1, 2]})),
            vec![json!(1), json!(2)],
            "results"
        );
        assert!(results(&json!({"other": 1})).is_empty(), "missing");
    }
}
