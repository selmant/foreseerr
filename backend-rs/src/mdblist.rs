//! `server/api/mdblist`: the shared `MDBList` client.
//!
//! Like Node's singleton it keeps one response cache (the `mdblist` cache), one circuit breaker
//! and one request queue for the whole process: ratings, batch ratings and
//! list lookups all wait their turn, so a quota answer opens the circuit
//! before queued calls reach `MDBList`. A changed API key drops the cache
//! and the circuit, as the settings route's `clearMdblistProviderState`
//! does.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use reqwest::header::{HeaderMap, ACCEPT, CONTENT_TYPE};
use reqwest::Method;
use serde_json::{Map, Value};

use crate::jsval;
use crate::memcache::{self, CacheId};
use crate::settings::public::truthy;
use crate::settings::Settings;
use crate::sync::lock;
use crate::tmdb::{axios_encode, js_numbers};

const BASE_URL: &str = "https://api.mdblist.com";
/// `MDBLIST_COLD_RATINGS_TTL_SECONDS`, the batch default.
pub const COLD_TTL_SECS: u64 = 86_400 * 30;
const LIST_SEARCH_TTL_SECS: u64 = 15 * 60;
/// `MDBLIST_LIST_ITEMS_TTL_SECONDS`.
pub const LIST_ITEMS_TTL_SECS: u64 = 60 * 60;
const CIRCUIT_OPEN_MS: i64 = 60_000;
const MAX_TIMEOUT_MS: u64 = 4_000;
const UNAVAILABLE: &str = "MDBList is temporarily unavailable";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Circuit {
    Closed,
    Open,
    HalfOpen,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Slot {
    Allowed,
    Probe,
    Blocked,
}

#[derive(Debug)]
struct Shared {
    key: String,
    circuit: Circuit,
    opened_at: i64,
    open_timeout_ms: i64,
    probe_in_flight: bool,
}

impl Shared {
    const fn new(key: String) -> Self {
        Self {
            key,
            circuit: Circuit::Closed,
            opened_at: 0,
            open_timeout_ms: CIRCUIT_OPEN_MS,
            probe_in_flight: false,
        }
    }

    /// `acquireCircuitSlot`.
    fn acquire(&mut self) -> Slot {
        if self.circuit == Circuit::Closed {
            return Slot::Allowed;
        }
        if self.circuit == Circuit::Open
            && crate::clock::now_millis() - self.opened_at >= self.open_timeout_ms
        {
            self.circuit = Circuit::HalfOpen;
            self.probe_in_flight = false;
        }
        if self.circuit == Circuit::HalfOpen {
            if self.probe_in_flight {
                return Slot::Blocked;
            }
            self.probe_in_flight = true;
            return Slot::Probe;
        }
        Slot::Blocked
    }

    /// `closeCircuit`.
    const fn close(&mut self) {
        self.circuit = Circuit::Closed;
        self.opened_at = 0;
        self.open_timeout_ms = CIRCUIT_OPEN_MS;
        self.probe_in_flight = false;
    }

    /// `openCircuit(cooldownMs)`.
    fn open(&mut self, cooldown_ms: Option<i64>) {
        let cooldown = cooldown_ms.unwrap_or(CIRCUIT_OPEN_MS);
        self.circuit = Circuit::Open;
        self.opened_at = crate::clock::now_millis();
        self.open_timeout_ms = cooldown;
        self.probe_in_flight = false;
        tracing::warn!("[MDBList] MDBList circuit opened after rate limit (cooldown {cooldown}ms)");
    }
}

/// A copy of a stored `mdblist` answer.
fn cached(key: &str) -> Option<Value> {
    memcache::get(CacheId::Mdblist, key).map(std::sync::Arc::unwrap_or_clone)
}

/// `cache.set(key, value, ttl)`; a TTL of 0 stores nothing.
fn store(key: String, value: Value, ttl_secs: u64) {
    if ttl_secs == 0 {
        return;
    }
    memcache::set(CacheId::Mdblist, key, value, Duration::from_secs(ttl_secs));
}

/// `clearMdblistProviderState`: flush the `mdblist` cache and drop the
/// shared client state (circuit included), as `resetInstance` does.
pub fn clear_provider_state() {
    memcache::flush(CacheId::Mdblist);
    *lock(&SHARED) = Shared::new(String::new());
}

static SHARED: LazyLock<Mutex<Shared>> = LazyLock::new(|| Mutex::new(Shared::new(String::new())));
/// `requestQueue`: one `MDBList` call at a time.
static QUEUE: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

/// Why a list call failed, as the route sorts it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ListError {
    /// `MdblistNotConfiguredError`.
    NotConfigured,
    /// `MdblistListNotFoundError`.
    NotFound,
    /// `MdblistUnavailableError(message)`.
    Unavailable(String),
    /// An answer of an unexpected shape: the route's 500.
    Internal(String),
    /// A failure whose message only Node can write (a network error).
    Forward(String),
}

/// How one request went.
#[derive(Debug)]
enum Failure {
    Status {
        status: u16,
        retry_after_ms: Option<i64>,
    },
    Timeout(String),
    Network(String),
}

/// A list reference, as `parseMdblistListRef` returns it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ListRef {
    /// `{ kind: 'id', listId }`.
    Id(i64),
    /// `{ kind: 'slug', username, slug }`.
    Slug {
        /// The owner.
        username: String,
        /// The list.
        slug: String,
    },
}

impl ListRef {
    fn path(&self) -> String {
        match self {
            Self::Id(id) => format!("/lists/{id}"),
            Self::Slug { username, slug } => format!(
                "/lists/{}/{}",
                crate::ratings::encode_uri_component(username),
                crate::ratings::encode_uri_component(slug)
            ),
        }
    }

    fn fallback_title(&self) -> String {
        match self {
            Self::Id(id) => id.to_string(),
            Self::Slug { slug, .. } => slug.clone(),
        }
    }
}

/// One page of a list.
#[derive(Debug, Clone, PartialEq)]
pub struct ListPage {
    /// The list's name.
    pub title: String,
    /// `MdblistDiscoverItem`s, ranked.
    pub items: Vec<ListItem>,
    /// Whether a full page came back.
    pub has_more: bool,
}

/// `MdblistDiscoverItem`.
#[derive(Debug, Clone, PartialEq)]
pub struct ListItem {
    /// A valid TMDB id.
    pub tmdb_id: Option<f64>,
    /// `movie` or `tv` when `MDBList` said so.
    pub media_type: Option<&'static str>,
    /// Never empty.
    pub title: String,
    /// The list rank, when a number.
    pub rank: Option<f64>,
    /// `IMDb` id.
    pub imdb_id: Option<String>,
    /// TVDB id.
    pub tvdb_id: Option<f64>,
}

/// `MdblistAPI.getInstance()`.
#[derive(Debug, Clone)]
pub struct Mdblist {
    client: reqwest::Client,
    key: String,
    timeout_ms: u64,
}

impl Mdblist {
    /// The client for the configured key; a key other than the last one
    /// seen resets the shared state.
    #[must_use]
    pub fn new(client: &reqwest::Client, settings: &Settings) -> Self {
        let key = jsval::trim(settings.str("/mdblist/apiKey")).to_owned();
        let changed = {
            let mut shared = lock(&SHARED);
            let changed = shared.key != key;
            if changed {
                *shared = Shared::new(key.clone());
            }
            drop(shared);
            changed
        };
        if changed {
            // The cache keys leave the API key out.
            memcache::flush(CacheId::Mdblist);
        }
        let timeout_ms = settings
            .get("/network/apiRequestTimeout")
            .and_then(Value::as_f64)
            .filter(|ms| *ms > 0.0)
            .map_or(MAX_TIMEOUT_MS, |ms| {
                if ms >= 4000.0 {
                    MAX_TIMEOUT_MS
                } else {
                    format!("{:.0}", ms.ceil())
                        .parse()
                        .unwrap_or(MAX_TIMEOUT_MS)
                }
            });
        Self {
            client: client.clone(),
            key,
            timeout_ms,
        }
    }

    /// `isConfigured()`.
    #[must_use]
    pub fn is_configured(&self) -> bool {
        !self.key.is_empty()
    }

    /// `validateApiKey()`: `ExternalAPI.get` of a fixed title with a TTL
    /// of 0 (the cache is read, nothing is stored); whether it succeeded.
    pub async fn validate_api_key(&self) -> bool {
        if self.key.is_empty() {
            return false;
        }
        let endpoint = "/tmdb/movie/550";
        if cached(&cache_key(endpoint, &[])).is_some_and(|v| truthy(Some(&v))) {
            return true;
        }
        self.request(Method::GET, endpoint, &[], None).await.is_ok()
    }

    /// One call with the `apikey` parameter first, as axios merges it, and
    /// the response interceptor that opens the circuit when the quota is
    /// spent. Errors leave the URL, and so the key, out.
    async fn request(
        &self,
        method: Method,
        endpoint: &str,
        params: &[(&str, String)],
        body: Option<&Value>,
    ) -> Result<Value, Failure> {
        let mut url = format!("{BASE_URL}{endpoint}?apikey={}", axios_encode(&self.key));
        for (k, v) in params {
            url.push('&');
            url.push_str(k);
            url.push('=');
            url.push_str(&axios_encode(v));
        }
        let mut req = self
            .client
            .request(method, &url)
            .header(ACCEPT, "application/json")
            .header(CONTENT_TYPE, "application/json")
            .timeout(Duration::from_millis(self.timeout_ms));
        if let Some(body) = body {
            req = req.body(body.to_string());
        }
        let timeout = || Failure::Timeout(format!("timeout of {}ms exceeded", self.timeout_ms));
        let res = match req.send().await {
            Ok(res) => res,
            Err(e) if e.is_timeout() => return Err(timeout()),
            Err(e) => return Err(Failure::Network(format!("{:#}", e.without_url()))),
        };
        let status = res.status().as_u16();
        let headers = res.headers().clone();
        if !(200..300).contains(&status) {
            return Err(Failure::Status {
                status,
                retry_after_ms: retry_after_ms(&headers),
            });
        }
        let text = match res.text().await {
            Ok(text) => text,
            Err(e) if e.is_timeout() => return Err(timeout()),
            Err(e) => return Err(Failure::Network(format!("{:#}", e.without_url()))),
        };
        let remaining = header_number(&headers, "x-ratelimit-remaining");
        if remaining.is_some_and(|r| r.is_finite() && r <= 0.0) {
            lock(&SHARED).open(reset_after_ms(&headers));
        }
        Ok(parse_body(&text))
    }

    /// `getRatings(mediaType, tmdbId, ttl)`: the raw media payload (cached
    /// or fresh), or `None` for Node's `null`.
    pub async fn ratings(&self, media_type: &str, tmdb_id: i64, ttl_secs: u64) -> Option<Value> {
        if self.key.is_empty() || tmdb_id == 0 {
            return None;
        }
        let _turn = QUEUE.lock().await;
        let slot = lock(&SHARED).acquire();
        if slot == Slot::Blocked {
            return None;
        }
        let endpoint = format!("/tmdb/{}/{tmdb_id}", provider_type(media_type));
        let key = cache_key(&endpoint, &[]);
        let cached = cached(&key).filter(|v| truthy(Some(v)));
        if let Some(cached) = cached {
            if slot == Slot::Probe {
                lock(&SHARED).close();
            }
            return Some(cached);
        }
        for attempt in 1..=3_u64 {
            match self.request(Method::GET, &endpoint, &[], None).await {
                Ok(data) => {
                    {
                        let mut shared = lock(&SHARED);
                        store(key, data.clone(), ttl_secs);
                        if slot == Slot::Probe {
                            shared.close();
                        }
                    }
                    let usable = truthy(Some(&data))
                        && (data.is_object() || data.is_array())
                        && !truthy(data.get("error"));
                    return usable.then_some(data);
                }
                Err(Failure::Status {
                    status: 429,
                    retry_after_ms,
                }) => {
                    lock(&SHARED).open(retry_after_ms);
                    return None;
                }
                Err(Failure::Status { status: 503, .. }) if attempt < 3 => {
                    tokio::time::sleep(Duration::from_millis(400 * attempt * attempt)).await;
                }
                Err(failure) => {
                    if slot == Slot::Probe || !matches!(failure, Failure::Status { .. }) {
                        lock(&SHARED).open(None);
                    }
                    return None;
                }
            }
        }
        None
    }

    /// `getBatchRatings(mediaType, items)`: each `(tmdbId, ttl)` with its
    /// raw payload, `None` where `MDBList` had nothing.
    pub async fn batch_ratings(
        &self,
        media_type: &str,
        items: &[(i64, u64)],
    ) -> HashMap<i64, Option<Value>> {
        let mut results = HashMap::new();
        if self.key.is_empty() || items.is_empty() {
            return results;
        }
        let _turn = QUEUE.lock().await;
        let provider = provider_type(media_type);
        let mut unique: Vec<(i64, u64)> = Vec::new();
        for (id, ttl) in items {
            if let Some(slot) = unique.iter_mut().find(|(u, _)| u == id) {
                slot.1 = *ttl;
            } else {
                unique.push((*id, *ttl));
            }
        }
        let mut missing = Vec::new();
        for (id, ttl) in unique {
            let key = cache_key(&format!("/tmdb/{provider}/{id}"), &[]);
            let cached = cached(&key);
            match cached.filter(|v| truthy(Some(v))) {
                Some(cached) => {
                    results.insert(id, Some(cached));
                }
                None => missing.push((id, ttl)),
            }
        }
        if missing.is_empty() {
            return results;
        }
        let slot = lock(&SHARED).acquire();
        if slot == Slot::Blocked {
            for (id, _) in missing {
                results.insert(id, None);
            }
            return results;
        }
        let ids: Vec<Value> = missing.iter().map(|(id, _)| Value::from(*id)).collect();
        let mut body = Map::new();
        body.insert(String::from("ids"), Value::Array(ids));
        let reply = self
            .request(
                Method::POST,
                &format!("/tmdb/{provider}/"),
                &[],
                Some(&Value::Object(body)),
            )
            .await;
        match reply {
            Ok(payloads) => {
                let mut shared = lock(&SHARED);
                if slot == Slot::Probe {
                    shared.close();
                }
                if !store_batch(provider, &missing, &payloads, &mut results) {
                    shared.open(None);
                }
            }
            Err(Failure::Status {
                status: 429,
                retry_after_ms,
            }) => lock(&SHARED).open(retry_after_ms),
            Err(_) => lock(&SHARED).open(None),
        }
        for (id, _) in missing {
            results.entry(id).or_insert(None);
        }
        results
    }

    /// `searchLists(query)`.
    ///
    /// # Errors
    ///
    /// Fails as Node's `queuedGet` does.
    pub async fn search_lists(&self, query: &str) -> Result<Vec<Value>, ListError> {
        if self.key.is_empty() {
            return Err(ListError::NotConfigured);
        }
        let trimmed = jsval::trim(query);
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        let _turn = QUEUE.lock().await;
        let payload = self
            .queued_get(
                "/lists/search",
                &[("query", trimmed.to_owned())],
                LIST_SEARCH_TTL_SECS,
            )
            .await?;
        Ok(public_lists(&payload))
    }

    /// `getListItems(ref, { limit, offset })` for a parsed reference.
    ///
    /// # Errors
    ///
    /// Fails as Node's `getListItems` does.
    pub async fn list_items(
        &self,
        list: &ListRef,
        limit: i64,
        offset: f64,
    ) -> Result<ListPage, ListError> {
        if self.key.is_empty() {
            return Err(ListError::NotConfigured);
        }
        let limit = limit.max(1);
        // `Math.max(0, options.offset)`, sent as `String(offset)`.
        let offset = if offset.is_nan() {
            offset
        } else {
            offset.max(0.0)
        };
        let _turn = QUEUE.lock().await;
        let path = list.path();
        let metadata = match self.queued_get(&path, &[], LIST_ITEMS_TTL_SECS).await {
            Ok(payload) => normalize_metadata(&payload),
            Err(ListError::NotFound) => return Err(ListError::NotFound),
            Err(_) => Vec::new(),
        };
        let title = metadata
            .first()
            .map_or_else(|| list.fallback_title(), |m| m.name.clone());
        let payload = self
            .queued_get(
                &format!("{path}/items"),
                &[
                    ("limit", limit.to_string()),
                    ("offset", jsval::number_string(offset)),
                ],
                LIST_ITEMS_TTL_SECS,
            )
            .await?;
        let raw = collect_list_items(&payload)?;
        let count = i64::try_from(raw.len()).unwrap_or(i64::MAX);
        Ok(ListPage {
            title,
            items: map_list_items(&raw)?,
            has_more: count >= limit,
        })
    }

    /// `queuedGet`, inside the caller's turn.
    async fn queued_get(
        &self,
        endpoint: &str,
        params: &[(&str, String)],
        ttl_secs: u64,
    ) -> Result<Value, ListError> {
        let slot = lock(&SHARED).acquire();
        if slot == Slot::Blocked {
            return Err(ListError::Unavailable(String::from(UNAVAILABLE)));
        }
        let key = cache_key(endpoint, params);
        let cached = cached(&key);
        if let Some(cached) = cached {
            if slot == Slot::Probe {
                lock(&SHARED).close();
            }
            return Ok(cached);
        }
        match self.request(Method::GET, endpoint, params, None).await {
            Ok(data) => {
                {
                    let mut shared = lock(&SHARED);
                    store(key, data.clone(), ttl_secs);
                    if slot == Slot::Probe {
                        shared.close();
                    }
                }
                Ok(data)
            }
            Err(Failure::Status {
                status: 429,
                retry_after_ms,
            }) => {
                lock(&SHARED).open(retry_after_ms);
                Err(ListError::Unavailable(String::from(
                    "MDBList daily quota exceeded",
                )))
            }
            Err(failure) => {
                if slot == Slot::Probe {
                    lock(&SHARED).open(None);
                }
                Err(match failure {
                    Failure::Status { status: 404, .. } => ListError::NotFound,
                    Failure::Status { status, .. } => {
                        ListError::Unavailable(format!("Request failed with status code {status}"))
                    }
                    Failure::Timeout(message) | Failure::Network(message) => {
                        ListError::Unavailable(message)
                    }
                })
            }
        }
    }
}

/// Store the batch answer; `false` where Node's loop would throw.
fn store_batch(
    provider: &str,
    missing: &[(i64, u64)],
    payloads: &Value,
    results: &mut HashMap<i64, Option<Value>>,
) -> bool {
    let payloads = match payloads {
        Value::Array(items) => items.as_slice(),
        Value::Null | Value::String(_) => return true,
        Value::Bool(_) | Value::Number(_) | Value::Object(_) => return false,
    };
    for payload in payloads {
        if payload.is_null() {
            return false;
        }
        let Some(tmdb_id) = payload.pointer("/ids/tmdb").and_then(Value::as_i64) else {
            continue;
        };
        let Some((_, ttl)) = missing.iter().find(|(id, _)| *id == tmdb_id) else {
            continue;
        };
        store(
            cache_key(&format!("/tmdb/{provider}/{tmdb_id}"), &[]),
            payload.clone(),
            *ttl,
        );
        results.insert(tmdb_id, Some(payload.clone()));
    }
    true
}

fn provider_type(media_type: &str) -> &'static str {
    if media_type == "tv" {
        "show"
    } else {
        "movie"
    }
}

/// The cache key of a request: its endpoint and parameters, in order.
fn cache_key(endpoint: &str, params: &[(&str, String)]) -> String {
    format!("{BASE_URL}{endpoint} {params:?}")
}

/// axios's body: JSON when it parses, the text otherwise.
fn parse_body(text: &str) -> Value {
    serde_json::from_str::<Value>(text).map_or_else(|_| Value::from(text), js_numbers)
}

fn header_number(headers: &HeaderMap, name: &str) -> Option<f64> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(jsval::number_of_str)
}

/// `getResetAfterMs`.
fn reset_after_ms(headers: &HeaderMap) -> Option<i64> {
    let reset = header_number(headers, "x-ratelimit-reset").filter(|r| r.is_finite())?;
    let reset_ms = if reset > 1_000_000_000.0 {
        reset * 1000.0
    } else {
        reset
    };
    let now = f64_of(crate::clock::now_millis());
    Some(ms_of((reset_ms - now).max(1000.0)))
}

/// `getRetryAfterMs`.
fn retry_after_ms(headers: &HeaderMap) -> Option<i64> {
    if let Some(text) = headers.get("retry-after").and_then(|v| v.to_str().ok()) {
        let seconds = jsval::number_of_str(text);
        if seconds.is_finite() {
            return Some(ms_of((seconds * 1000.0).max(1000.0)));
        }
        if let Some(at) = jsval::parse_http_date(text) {
            return Some((at - crate::clock::now_millis()).max(1000));
        }
    }
    reset_after_ms(headers)
}

fn f64_of(n: i64) -> f64 {
    n.to_string().parse().unwrap_or(0.0)
}

fn ms_of(f: f64) -> i64 {
    format!("{:.0}", f.round()).parse().unwrap_or(i64::MAX)
}

/// One list row, as `normalizeMdblistListMetadata` keeps it.
#[derive(Debug, Clone, PartialEq)]
struct Metadata {
    id: f64,
    name: String,
    slug: String,
    user_name: Option<Value>,
    mediatype: Option<Value>,
    items: Option<Value>,
    likes: Option<Value>,
}

/// `normalizeMdblistListMetadata`.
fn normalize_metadata(payload: &Value) -> Vec<Metadata> {
    let rows: Vec<&Value> = match payload {
        Value::Array(items) => items.iter().collect(),
        Value::Object(_) => vec![payload],
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => Vec::new(),
    };
    rows.into_iter()
        .filter_map(|row| {
            let list = row.as_object()?;
            let id = jsval::number_of(list.get("id"));
            if !id.is_finite() || id <= 0.0 {
                return None;
            }
            let text = |key: &str| match list.get(key) {
                None | Some(Value::Null) => String::new(),
                v => jsval::trim(&jsval::string_of(v)).to_owned(),
            };
            let name = text("name");
            Some(Metadata {
                id,
                name: if name.is_empty() {
                    jsval::number_string(id)
                } else {
                    name
                },
                slug: text("slug"),
                user_name: list.get("user_name").cloned(),
                mediatype: list.get("mediatype").cloned(),
                items: list.get("items").cloned(),
                likes: list.get("likes").cloned(),
            })
        })
        .collect()
}

/// `mapMdblistPublicLists`.
fn public_lists(payload: &Value) -> Vec<Value> {
    let mut grouped: Vec<(String, Map<String, Value>)> = Vec::new();
    for list in normalize_metadata(payload) {
        let user_name = list.user_name.as_ref().filter(|v| !v.is_null());
        let reference = if truthy(user_name) && !list.slug.is_empty() {
            format!("{}/{}", jsval::string_of(user_name), list.slug)
        } else {
            jsval::number_string(list.id)
        };
        let or_zero = |v: Option<&Value>| {
            let n = jsval::number_of(v);
            if n.is_nan() || n == 0.0 {
                0.0
            } else {
                n
            }
        };
        let item_count = or_zero(list.items.as_ref());
        let likes = or_zero(list.likes.as_ref());
        if let Some((_, existing)) = grouped.iter_mut().find(|(r, _)| *r == reference) {
            let count = jsval::number_of(existing.get("itemCount")) + item_count;
            existing.insert(String::from("itemCount"), jsval::num(count));
            let best = jsval::number_of(existing.get("likes")).max(likes);
            existing.insert(String::from("likes"), jsval::num(best));
            continue;
        }
        let mut out = Map::new();
        out.insert(String::from("id"), jsval::num(list.id));
        out.insert(String::from("name"), Value::from(list.name.as_str()));
        out.insert(
            String::from("slug"),
            Value::from(if list.slug.is_empty() {
                jsval::number_string(list.id)
            } else {
                list.slug.clone()
            }),
        );
        out.insert(
            String::from("username"),
            user_name.cloned().unwrap_or_else(|| Value::from("")),
        );
        out.insert(
            String::from("mediaType"),
            list.mediatype
                .filter(|v| !v.is_null())
                .unwrap_or_else(|| Value::from("")),
        );
        out.insert(String::from("itemCount"), jsval::num(item_count));
        out.insert(String::from("likes"), jsval::num(likes));
        grouped.push((reference, out));
    }
    grouped.into_iter().map(|(_, m)| Value::Object(m)).collect()
}

/// `collectMdblistListItems`; buckets of other shapes would throw in Node.
fn collect_list_items(payload: &Value) -> Result<Vec<Value>, ListError> {
    match payload {
        Value::Array(items) => Ok(items.clone()),
        Value::Object(map) => {
            let mut out = Vec::new();
            for bucket in ["movies", "shows", "items", "unified"] {
                match map.get(bucket) {
                    None | Some(Value::Null) => {}
                    Some(Value::Array(items)) => out.extend(items.iter().cloned()),
                    Some(_) => {
                        return Err(ListError::Forward(String::from(
                            "a list bucket that isn't an array",
                        )))
                    }
                }
            }
            Ok(out)
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => Ok(Vec::new()),
    }
}

/// `positiveInt`.
fn positive_int(value: Option<&Value>) -> Option<f64> {
    let n = jsval::number_of(value);
    (n.is_finite() && n > 0.0).then(|| n.trunc())
}

/// `x?.trim()`: `None` for null/undefined, an error for non-strings.
fn optional_trim(value: Option<&Value>) -> Result<Option<String>, ListError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(jsval::trim(s).to_owned())),
        Some(_) => Err(ListError::Internal(String::from(
            "an MDBList field that should be text isn't",
        ))),
    }
}

/// `mapMdblistListItem`.
fn map_list_item(item: &Value) -> Result<Option<ListItem>, ListError> {
    if item.is_null() {
        return Err(ListError::Internal(String::from(
            "an MDBList list item is null",
        )));
    }
    let get = |key: &str| item.as_object().and_then(|m| m.get(key));
    let ids = get("ids").filter(|v| !v.is_null());
    let id_of = |key: &str| ids.and_then(|i| i.as_object()).and_then(|m| m.get(key));
    let tmdb_id = positive_int(id_of("tmdb"))
        .or_else(|| positive_int(get("tmdb_id")))
        .or_else(|| positive_int(get("id")));
    let nested_imdb = optional_trim(id_of("imdb"))?.filter(|s| !s.is_empty());
    let flat_imdb = match get("imdb_id") {
        None | Some(Value::Null) => String::new(),
        v => jsval::trim(&jsval::string_of(v)).to_owned(),
    };
    let imdb_id = nested_imdb.or_else(|| (!flat_imdb.is_empty()).then_some(flat_imdb));
    let series_id = positive_int(id_of("tvdb")).or_else(|| positive_int(get("tvdb_id")));
    let title = optional_trim(get("title"))?
        .filter(|s| !s.is_empty())
        .or_else(|| tmdb_id.map(jsval::number_string))
        .or_else(|| imdb_id.clone())
        .unwrap_or_default();
    if title.is_empty() {
        return Ok(None);
    }
    let kind = get("mediatype")
        .filter(|v| !v.is_null())
        .or_else(|| get("type"));
    let media_type = match kind.and_then(Value::as_str) {
        Some("movie") => Some("movie"),
        Some("show" | "tv") => Some("tv"),
        _ => None,
    };
    Ok(Some(ListItem {
        tmdb_id,
        media_type,
        title,
        rank: get("rank").and_then(Value::as_f64),
        imdb_id,
        tvdb_id: series_id,
    }))
}

/// `mapMdblistListItems`: mapped, ranked, ties by title as
/// `localeCompare` orders them ([`jsval::locale_compare_or_base`]).
fn map_list_items(raw: &[Value]) -> Result<Vec<ListItem>, ListError> {
    let mut mapped = Vec::with_capacity(raw.len());
    for item in raw {
        if let Some(item) = map_list_item(item)? {
            mapped.push(item);
        }
    }
    let max = 9_007_199_254_740_991.0;
    mapped.sort_by(|a, b| {
        let (ra, rb) = (a.rank.unwrap_or(max), b.rank.unwrap_or(max));
        match ra.partial_cmp(&rb) {
            Some(std::cmp::Ordering::Equal) | None => {}
            Some(order) => return order,
        }
        jsval::locale_compare_or_base(&a.title, &b.title)
    });
    Ok(mapped)
}

/// Why a reference can't be used: Node's message (a 400), or a shape only
/// Node's URL parser reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefError {
    /// The error message.
    Invalid(String),
    /// Node decides.
    Forward(String),
}

const MDBLIST_HOSTS: [&str; 2] = ["mdblist.com", "www.mdblist.com"];

/// `parseMdblistListRef(value)`.
///
/// # Errors
///
/// Fails with Node's message, or asks for Node where WHATWG URL parsing
/// would matter.
pub fn parse_list_ref(value: &str) -> Result<ListRef, RefError> {
    let text = jsval::decode_uri_component(jsval::trim(value))
        .ok_or_else(|| RefError::Forward(String::from("decodeURIComponent throws")))?;
    if text.is_empty() {
        return Err(RefError::Invalid(String::from(
            "List URL or reference is required",
        )));
    }
    if text.bytes().all(|b| b.is_ascii_digit()) {
        return list_id(&text).map(ListRef::Id);
    }
    let as_url = text.starts_with("http://") || text.starts_with("https://");
    if as_url || text.contains("mdblist.com/") {
        let full = if as_url {
            text
        } else {
            format!("https://{text}")
        };
        return parse_list_url(&full, value);
    }
    if text.contains('/') {
        let (username, rest) = text.split_once('/').unwrap_or((&text, ""));
        let slug = rest
            .strip_suffix("/json/")
            .or_else(|| rest.strip_suffix("/json"))
            .unwrap_or(rest);
        let slug = jsval::trim(slug);
        let username = jsval::trim(username);
        if username.is_empty() || slug.is_empty() {
            return Err(RefError::Invalid(format!(
                "Invalid MDBList list reference: {value}"
            )));
        }
        return Ok(ListRef::Slug {
            username: username.to_owned(),
            slug: slug.to_owned(),
        });
    }
    Err(RefError::Invalid(format!(
        "Invalid MDBList list reference: {value}"
    )))
}

/// `Number(digits)` for a list id that `String()` prints back the same.
fn list_id(digits: &str) -> Result<i64, RefError> {
    if digits.len() > 15 {
        return Err(RefError::Forward(String::from("a list id past 15 digits")));
    }
    digits
        .parse()
        .map_err(|_| RefError::Forward(String::from("an unreadable list id")))
}

/// The URL branch for the plain URLs whose WHATWG parse is obvious.
fn parse_list_url(full: &str, value: &str) -> Result<ListRef, RefError> {
    let forward = |why: &str| {
        Err(RefError::Forward(format!(
            "{why}; Node's URL parser decides"
        )))
    };
    let unsupported = || {
        Err(RefError::Invalid(format!(
            "Unsupported MDBList list URL: {value}"
        )))
    };
    let Some((_, rest)) = full.split_once("://") else {
        return forward("no scheme separator");
    };
    if full.contains('\\') || rest.starts_with('/') {
        return forward("an unusual authority");
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    if authority.is_empty()
        || !authority
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
    {
        return forward("a host with unusual characters");
    }
    let host = authority.to_ascii_lowercase();
    if !MDBLIST_HOSTS.contains(&host.as_str()) {
        return unsupported();
    }
    let path_end = tail.find(['?', '#']).unwrap_or(tail.len());
    let path = tail.get(..path_end).unwrap_or("");
    let safe = |b: u8| {
        b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'-' | b'.'
                    | b'_'
                    | b'~'
                    | b'!'
                    | b'$'
                    | b'&'
                    | b'\''
                    | b'('
                    | b')'
                    | b'*'
                    | b'+'
                    | b','
                    | b';'
                    | b'='
                    | b':'
                    | b'@'
                    | b'/'
            )
    };
    if !path.bytes().all(safe) {
        return forward("a path the URL parser would re-encode");
    }
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    if parts.iter().any(|p| *p == "." || *p == "..") {
        return forward("dot segments");
    }
    match parts.as_slice() {
        ["lists", username, third, ..] => {
            let slug = if *third == "json" { "" } else { *third };
            if !username.is_empty() && !slug.is_empty() {
                return Ok(ListRef::Slug {
                    username: (*username).to_owned(),
                    slug: slug.to_owned(),
                });
            }
            unsupported()
        }
        ["lists", id] if id.bytes().all(|b| b.is_ascii_digit()) => list_id(id).map(ListRef::Id),
        _ => unsupported(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn list_references() {
        assert_eq!(parse_list_ref("123"), Ok(ListRef::Id(123)), "id");
        assert_eq!(
            parse_list_ref("https://mdblist.com/lists/linaspurinis/top-watched"),
            Ok(ListRef::Slug {
                username: String::from("linaspurinis"),
                slug: String::from("top-watched")
            }),
            "url"
        );
        assert_eq!(
            parse_list_ref("www.mdblist.com/lists/42?x=1"),
            Ok(ListRef::Id(42)),
            "schemeless id url"
        );
        assert_eq!(
            parse_list_ref("HTTPS://MDBList.com/lists/a/b"),
            Ok(ListRef::Slug {
                username: String::from("HTTPS:"),
                slug: String::from("/MDBList.com/lists/a/b")
            }),
            "the URL checks are case-sensitive, so this reads as a reference"
        );
        assert_eq!(
            parse_list_ref("user/my-list/json"),
            Ok(ListRef::Slug {
                username: String::from("user"),
                slug: String::from("my-list")
            }),
            "reference with json suffix"
        );
        assert_eq!(
            parse_list_ref("https://example.com/lists/a/b"),
            Err(RefError::Invalid(String::from(
                "Unsupported MDBList list URL: https://example.com/lists/a/b"
            ))),
            "foreign host"
        );
        assert_eq!(
            parse_list_ref("justaname"),
            Err(RefError::Invalid(String::from(
                "Invalid MDBList list reference: justaname"
            ))),
            "no slash"
        );
        assert!(
            matches!(
                parse_list_ref("https://mdblist.com/lists/a b/c"),
                Err(RefError::Forward(_))
            ),
            "re-encoded path"
        );
        assert_eq!(
            ListRef::Slug {
                username: String::from("a b"),
                slug: String::from("c")
            }
            .path(),
            "/lists/a%20b/c",
            "encoded path"
        );
    }

    #[test]
    fn list_items_map_and_rank() {
        let raw = vec![
            json!({"id": 5, "rank": 2, "title": " Beta ", "mediatype": "show", "imdb_id": "tt5"}),
            json!({"rank": 1, "ids": {"tmdb": "7", "tvdb": 9}, "type": "movie"}),
            json!({"rank": 2, "title": "alpha"}),
            json!({"title": ""}),
        ];
        let items = map_list_items(&raw).unwrap_or_default();
        let titles: Vec<&str> = items.iter().map(|i| i.title.as_str()).collect();
        assert_eq!(titles, vec!["7", "alpha", "Beta"], "rank then title");
        let tied = vec![
            json!({"rank": 1, "title": "Şahsiyet"}),
            json!({"rank": 1, "title": "Rüya"}),
            json!({"rank": 1, "title": "Sahne"}),
        ];
        let titles: Vec<String> = map_list_items(&tied)
            .unwrap_or_default()
            .into_iter()
            .map(|i| i.title)
            .collect();
        assert_eq!(
            titles,
            vec!["Rüya", "Sahne", "Şahsiyet"],
            "accented ties still sort"
        );
        assert_eq!(items.first().and_then(|i| i.tvdb_id), Some(9.0), "tvdb");
        assert_eq!(
            items.get(2).and_then(|i| i.media_type),
            Some("tv"),
            "show is tv"
        );
        assert!(
            matches!(
                map_list_item(&json!({"title": 5})),
                Err(ListError::Internal(_))
            ),
            "trim on a number throws"
        );
    }

    #[test]
    fn public_list_grouping() {
        let payload = json!([
            {"id": 1, "name": "A", "slug": "a", "user_name": "u", "mediatype": "movie", "items": 10, "likes": 3},
            {"id": 2, "name": "A", "slug": "a", "user_name": "u", "mediatype": "show", "items": "5", "likes": 7},
            {"id": "x"},
            {"id": 3, "name": " ", "items": null}
        ]);
        assert_eq!(
            Value::Array(public_lists(&payload)),
            json!([
                {"id": 1, "name": "A", "slug": "a", "username": "u", "mediaType": "movie", "itemCount": 15, "likes": 7},
                {"id": 3, "name": "3", "slug": "3", "username": "", "mediaType": "", "itemCount": 0, "likes": 0}
            ]),
            "merged by reference"
        );
    }
}
