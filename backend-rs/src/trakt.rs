//! `server/api/trakt/index.ts`, as far as the `/discover/trakt` routes use it.
//!
//! Like Node it keeps `ExternalAPI`'s `trakt` response cache (five minutes)
//! and the per-token rate-limit circuit in process-wide state; a token
//! refresh runs `refreshUserTraktTokens` with its per-user lock, database
//! write and sync-cache invalidation: in Node, or in
//! [`crate::routes::procstate::traktrefresh`] when this process owns it.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

use crate::settings::public::truthy;
use crate::settings::Settings;
use crate::sync::lock;
use crate::tmdb::{axios_encode, js_numbers};
use crate::traktitems::{
    chart_entries, item_key, js_number, merge_and_paginate, normalize_liked_lists,
    normalize_list_items, normalize_list_metadata, normalize_recommendation_items,
    normalize_search_lists, normalize_user_lists, num_value, paginate_sorted, Paged, SortBy,
};

pub mod actions;

const BASE_URL: &str = "https://api.trakt.tv";
const REFRESH_WINDOW_SECONDS: f64 = 300.0;
const RETRY_AFTER_MAX_SECONDS: u64 = 5;
const RATE_LIMIT_FALLBACK_SECONDS: u64 = 1;
/// `TRAKT_GET_CACHE_TTL_SECONDS`, also every `this.get(..., 300)`.
pub const GET_CACHE_TTL: u64 = 300;
const CIRCUIT_FALLBACK_SECONDS: u64 = 60;
const RECOMMENDATIONS_LIMIT_MAX: i64 = 500;
/// The `rawAxios` instance's timeout.
const RAW_TIMEOUT: Duration = Duration::from_secs(15);
/// `rawAxios` is an `axios.create()` instance without the user agent
/// interceptor, so it sends axios's own.
const RAW_USER_AGENT: &str = "axios/1.18.0";
/// Pages a sorted list collects at most.
const SORTED_LIST_MAX_PAGES: i64 = 10;

/// `traktCircuitOpenUntilMs`, per token or app client.
static CIRCUITS: LazyLock<Mutex<HashMap<String, Instant>>> = LazyLock::new(Mutex::default);

/// A fresh entry of the shared `trakt` cache, shared; copy it to change it.
#[must_use]
pub fn cache_get(key: &str) -> Option<Arc<Value>> {
    crate::memcache::get(crate::memcache::CacheId::Trakt, key)
}

/// Store an entry in the `trakt` cache (a TTL of 0 stores nothing).
pub fn cache_set(key: String, value: Value, ttl_secs: u64) {
    if ttl_secs == 0 {
        return;
    }
    crate::memcache::set(
        crate::memcache::CacheId::Trakt,
        key,
        value,
        Duration::from_secs(ttl_secs),
    );
}

fn remaining_circuit_seconds(key: &str) -> u64 {
    let until = lock(&CIRCUITS).get(key).copied();
    until
        .and_then(|until| until.checked_duration_since(Instant::now()))
        .map_or(0, |left| {
            let ceil = left.as_secs_f64().ceil();
            format!("{ceil:.0}").parse().unwrap_or(0)
        })
}

fn assert_circuit_closed(key: &str) -> Result<(), TraktError> {
    match remaining_circuit_seconds(key) {
        0 => Ok(()),
        left => Err(TraktError::RateLimited(left)),
    }
}

/// `openTraktCircuit(key, retryAfter || 60)`.
fn open_circuit(key: &str, retry_after: u64) {
    let seconds = retry_after.max(CIRCUIT_FALLBACK_SECONDS);
    // A Retry-After too large for a deadline is "forever" for all purposes.
    let Some(until) = Instant::now().checked_add(Duration::from_secs(seconds.min(1 << 40))) else {
        return;
    };
    let opened = {
        let mut circuits = lock(&CIRCUITS);
        let later = circuits.get(key).is_none_or(|current| until > *current);
        if later {
            circuits.insert(key.to_owned(), until);
        }
        later
    };
    if opened {
        let shown = key.strip_prefix("token:").map_or_else(
            || key.to_owned(),
            |token| {
                let tail: String = token
                    .chars()
                    .rev()
                    .take(8)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
                format!("token:…{tail}")
            },
        );
        tracing::warn!(
            circuit_key = %shown,
            retry_after_seconds = seconds,
            "Trakt circuit opened after rate limit"
        );
    }
}

/// `parseRetryAfter`: `parseInt(value, 10)`, at least 0.
pub fn parse_retry_after(value: Option<&str>) -> u64 {
    let text = value.unwrap_or("0").trim_start();
    let (negative, digits) = text.strip_prefix('-').map_or_else(
        || (false, text.strip_prefix('+').unwrap_or(text)),
        |d| (true, d),
    );
    let run: String = digits.chars().take_while(char::is_ascii_digit).collect();
    if negative || run.is_empty() {
        return 0;
    }
    run.parse().unwrap_or(u64::MAX)
}

/// The errors the routes tell apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TraktError {
    /// `TraktRateLimitedError`, with `retryAfterSeconds`.
    RateLimited(u64),
    /// `TraktAppAccessDeniedError`.
    AppAccessDenied,
    /// `TraktReconnectRequiredError`, with its message.
    Reconnect(String),
    /// `TraktNotConfiguredError`.
    NotConfigured,
    /// `TraktNotLinkedError`.
    NotLinked,
    /// The `AxiosError` of a non-2xx answer to `ExternalAPI.get`, with its
    /// `status`.
    Axios(u16),
    /// Anything else (a 500 with the route's message).
    Other(String),
}

impl TraktError {
    /// `new TraktRateLimitedError(seconds)`: at least one, rounded up.
    #[must_use]
    pub const fn rate_limited(seconds: u64) -> Self {
        Self::RateLimited(if seconds == 0 { 1 } else { seconds })
    }

    /// `error.message`.
    #[must_use]
    pub fn message(&self) -> String {
        match self {
            Self::RateLimited(seconds) => {
                format!("Trakt API rate limited; retry after {seconds}s")
            }
            Self::AppAccessDenied => String::from(
                "Trakt refused an unauthenticated request. Trakt now requires a linked account for API access.",
            ),
            Self::Reconnect(message) | Self::Other(message) => message.clone(),
            Self::NotConfigured => {
                String::from("Trakt application credentials are not configured")
            }
            Self::NotLinked => String::from("User has not linked a Trakt account"),
            Self::Axios(status) => format!("Request failed with status code {status}"),
        }
    }

    /// `handleTraktDiscoverRouteError`'s rule: the status and `retryAfter`,
    /// or `None` for the route's 500.
    #[must_use]
    pub const fn route_status(&self) -> Option<(u16, Option<u64>)> {
        match self {
            Self::NotConfigured => Some((400, None)),
            Self::NotLinked | Self::AppAccessDenied => Some((404, None)),
            Self::Reconnect(_) => Some((401, None)),
            Self::RateLimited(seconds) => Some((429, Some(*seconds))),
            Self::Other(_) | Self::Axios(_) => None,
        }
    }
}

/// `getTraktAppCredentials`: the trimmed client id and secret.
///
/// # Errors
///
/// `NotConfigured` when either is blank.
pub fn app_credentials(settings: &Settings) -> Result<(String, String), TraktError> {
    let read = |pointer: &str| match settings.get(pointer) {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(s)) => Ok(s.trim().to_owned()),
        Some(Value::Bool(_) | Value::Number(_) | Value::Array(_) | Value::Object(_)) => Err(
            TraktError::Other(String::from("the Trakt credentials are not text")),
        ),
    };
    let id = read("/trakt/clientId")?;
    if id.is_empty() {
        return Err(TraktError::NotConfigured);
    }
    let secret = read("/trakt/clientSecret")?;
    if secret.is_empty() {
        return Err(TraktError::NotConfigured);
    }
    Ok((id, secret))
}

/// `TraktFetchMediaType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchType {
    /// Movies only.
    Movie,
    /// Shows only.
    Tv,
    /// Both.
    All,
}

impl FetchType {
    /// The Trakt path segment of a single type.
    const fn single(self) -> Option<&'static str> {
        match self {
            Self::Movie => Some("movies"),
            Self::Tv => Some("shows"),
            Self::All => None,
        }
    }
}

/// The stream a merged page reads from.
#[derive(Debug, Clone, Copy)]
enum Stream<'s> {
    Watchlist(&'s str),
    History,
    Chart(&'s str),
}

#[derive(Debug, Clone)]
struct Tokens {
    access: String,
    refresh: String,
    expires_at: f64,
}

/// How to reach Node's `refreshUserTraktTokens` for one user.
#[derive(Debug, Clone)]
pub struct NodeRefresh {
    /// The loopback client for Node's internal routes.
    pub client: reqwest::Client,
    /// `{node_url}/internal/trakt/refresh`.
    pub url: String,
    /// Node's API key.
    pub api_key: String,
    /// The user whose tokens these are.
    pub user_id: i64,
}

/// Where a user's client gets fresh tokens (its `refreshTokens` callback).
#[derive(Debug, Clone)]
enum Refresher {
    /// `refreshUserTraktTokens`.
    Node(NodeRefresh),
    /// The Better Trakt token bridge (`getJellyfinTraktToken`).
    Jellyfin(crate::traktbridge::Bridge),
}

/// One `TraktAPI` instance: an app client or a user's client.
#[derive(Debug)]
pub struct TraktClient {
    http: reqwest::Client,
    client_id: String,
    tokens: Mutex<Option<Tokens>>,
    refresh: Option<Refresher>,
}

fn now_secs() -> f64 {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    format!("{secs}").parse().unwrap_or(0.0)
}

/// A response body as axios hands it over: parsed JSON, or the text.
fn body_value(text: String) -> Value {
    serde_json::from_str::<Value>(&text).map_or(Value::String(text), js_numbers)
}

/// `JSON.stringify` of a params object, optionally with the cache scope
/// header.
fn params_json(params: &[(&str, Value)], scope: Option<&str>) -> String {
    let mut map = Map::new();
    for (key, value) in params {
        map.insert((*key).to_owned(), value.clone());
    }
    if let Some(scope) = scope {
        let mut headers = Map::new();
        headers.insert(String::from("x-trakt-cache-scope"), Value::from(scope));
        map.insert(String::from("headers"), Value::Object(headers));
    }
    Value::Object(map).to_string()
}

/// The request URL as axios builds it.
fn request_url(endpoint: &str, params: &[(&str, Value)]) -> String {
    let query: Vec<String> = params
        .iter()
        .map(|(key, value)| {
            let text = crate::media::js_string(Some(value));
            format!("{key}={}", axios_encode(&text))
        })
        .collect();
    if query.is_empty() {
        return format!("{BASE_URL}{endpoint}");
    }
    // `buildURL`: a fragment goes, and parameters join a query the path
    // already has.
    let path = endpoint.split('#').next().unwrap_or("");
    let joiner = if path.contains('?') { '&' } else { '?' };
    format!("{BASE_URL}{path}{joiner}{}", query.join("&"))
}

fn page_params(limit: i64, page: i64, extended: &str) -> [(&'static str, Value); 3] {
    [
        ("limit", Value::from(limit)),
        ("page", Value::from(page)),
        ("extended", Value::from(extended)),
    ]
}

/// `circuitKey()`: per token, else per app client.
fn circuit_key(access: Option<&str>, client_id: &str) -> String {
    access.map_or_else(
        || {
            let id = if client_id.is_empty() {
                "public"
            } else {
                client_id
            };
            format!("client:{id}")
        },
        |token| format!("token:{token}"),
    )
}

/// `x-trakt-cache-scope`: the token's last 16 UTF-16 units, or `public`.
fn scope(access: Option<&str>) -> String {
    access.map_or_else(
        || String::from("public"),
        |token| {
            let units: Vec<u16> = token.encode_utf16().collect();
            let tail = units.get(units.len().saturating_sub(16)..).unwrap_or(&[]);
            format!("auth:{}", String::from_utf16_lossy(tail))
        },
    )
}

const fn other(message: String) -> TraktError {
    TraktError::Other(message)
}

impl TraktClient {
    /// `createTraktAppClient()`.
    #[must_use]
    pub const fn app(http: reqwest::Client, client_id: String) -> Self {
        Self {
            http,
            client_id,
            tokens: Mutex::new(None),
            refresh: None,
        }
    }

    /// `new TraktAPI({ clientId, clientSecret, accessToken, refreshToken,
    /// expiresAt })` without a `refreshTokens` callback.
    #[must_use]
    pub const fn with_tokens(
        http: reqwest::Client,
        client_id: String,
        access: String,
        refresh: String,
        expires_at: f64,
    ) -> Self {
        Self {
            http,
            client_id,
            tokens: Mutex::new(Some(Tokens {
                access,
                refresh,
                expires_at,
            })),
            refresh: None,
        }
    }

    /// `getUserSettings()`: `(username, traktUserId)`.
    ///
    /// # Errors
    ///
    /// Fails as `getAuthenticated` does.
    pub async fn user_profile(&self) -> Result<(String, String), TraktError> {
        fn field<'v>(v: Option<&'v Value>, key: &str) -> Option<&'v Value> {
            v.and_then(|v| v.get(key)).filter(|v| truthy(Some(v)))
        }
        let payload = self.request("/users/settings", &[]).await?;
        let user = payload.get("user").filter(|u| !u.is_null());
        let ids = user.and_then(|u| u.get("ids")).filter(|i| !i.is_null());
        let text = |v: &Value| crate::media::js_string(Some(v)).into_owned();
        let username = field(user, "username")
            .or_else(|| field(user, "name"))
            .or_else(|| field(user, "slug"))
            .or_else(|| field(ids, "slug"))
            .map_or_else(String::new, text);
        let user_id = field(ids, "uuid")
            .or_else(|| field(ids, "slug"))
            .or_else(|| field(ids, "trakt"))
            .or_else(|| field(user, "username"))
            .map_or_else(|| username.clone(), text);
        Ok((username, user_id))
    }

    /// `createTraktUserClient(userId)` for a direct Trakt link.
    #[must_use]
    pub const fn user(
        http: reqwest::Client,
        client_id: String,
        access: String,
        refresh: String,
        expires_at: f64,
        node: NodeRefresh,
    ) -> Self {
        Self {
            http,
            client_id,
            tokens: Mutex::new(Some(Tokens {
                access,
                refresh,
                expires_at,
            })),
            refresh: Some(Refresher::Node(node)),
        }
    }

    /// `createTraktUserClient(userId)` with the Better Trakt provider: the
    /// bridge's client id and token, asked again on every refresh.
    #[must_use]
    pub fn jellyfin(
        http: reqwest::Client,
        token: crate::traktbridge::BridgeToken,
        bridge: crate::traktbridge::Bridge,
    ) -> Self {
        let crate::traktbridge::BridgeToken {
            client_id,
            access,
            expires_at,
        } = token;
        Self {
            http,
            client_id,
            tokens: Mutex::new(Some(Tokens {
                access,
                refresh: String::from(crate::traktbridge::REFRESH_SENTINEL),
                expires_at,
            })),
            refresh: Some(Refresher::Jellyfin(bridge)),
        }
    }

    fn access(&self) -> Option<String> {
        lock(&self.tokens)
            .as_ref()
            .map(|t| t.access.clone())
            .filter(|t| !t.is_empty())
    }

    fn circuit_key(&self) -> String {
        circuit_key(self.access().as_deref(), &self.client_id)
    }

    fn scope(&self) -> String {
        scope(self.access().as_deref())
    }

    /// The key `requestWithRetry` caches a GET under.
    fn scoped_key(&self, endpoint: &str, params: &[(&str, Value)]) -> String {
        format!(
            "{BASE_URL}{endpoint}{}",
            params_json(params, Some(&self.scope()))
        )
    }

    /// `ensureFreshToken`.
    async fn ensure_fresh(&self) -> Result<(), TraktError> {
        let due = lock(&self.tokens).as_ref().is_some_and(|t| {
            !t.refresh.is_empty()
                && t.expires_at != 0.0
                && !t.expires_at.is_nan()
                && t.expires_at <= now_secs() + REFRESH_WINDOW_SECONDS
        });
        if due {
            self.refresh_tokens().await?;
        }
        Ok(())
    }

    /// `refreshAccessToken` through the `refreshTokens` callback, which is
    /// Node's `refreshUserTraktTokens`.
    async fn refresh_tokens(&self) -> Result<(), TraktError> {
        let current = lock(&self.tokens).clone().filter(|t| !t.refresh.is_empty());
        let Some(current) = current else {
            return Err(other(String::from(
                "Cannot refresh Trakt token without a refresh token",
            )));
        };
        let node = match self.refresh.as_ref().filter(|_| !current.access.is_empty()) {
            Some(Refresher::Node(node)) => node,
            Some(Refresher::Jellyfin(bridge)) => {
                let fresh = bridge.token().await?;
                *lock(&self.tokens) = Some(Tokens {
                    access: fresh.access,
                    refresh: String::from(crate::traktbridge::REFRESH_SENTINEL),
                    expires_at: fresh.expires_at,
                });
                return Ok(());
            }
            None => return Err(other(String::from("a refresh without Node's callback"))),
        };
        let mut tokens = Map::new();
        tokens.insert(String::from("accessToken"), Value::from(current.access));
        tokens.insert(String::from("refreshToken"), Value::from(current.refresh));
        tokens.insert(String::from("expiresAt"), num_value(current.expires_at));
        let mut body = Map::new();
        body.insert(String::from("userId"), Value::from(node.user_id));
        body.insert(String::from("tokens"), Value::Object(tokens));
        let answer: Value = if crate::routes::procstate::in_process("/trakt/refresh") {
            crate::routes::procstate::trakt_refresh(&Value::Object(body))
                .await
                .into_result("/trakt/refresh")
                .map_err(|e| other(format!("Node's Trakt refresh failed: {e:#}")))?
        } else {
            node.client
                .post(&node.url)
                .header("X-API-Key", &node.api_key)
                .json(&Value::Object(body))
                .send()
                .await
                .and_then(reqwest::Response::error_for_status)
                .map_err(|e| other(format!("Node's Trakt refresh failed: {e:#}")))?
                .json()
                .await
                .map_err(|e| other(format!("Node's Trakt refresh answered oddly: {e:#}")))?
        };
        if let Some(error) = answer.get("error") {
            let message = crate::media::js_string(error.get("message")).into_owned();
            return Err(match error.get("name").and_then(Value::as_str) {
                Some("TraktReconnectRequiredError") => TraktError::Reconnect(message),
                Some("TraktNotConfiguredError") => TraktError::NotConfigured,
                _ => other(message),
            });
        }
        let fresh = answer.get("tokens");
        let text = |key: &str| crate::media::js_string(fresh.and_then(|t| t.get(key))).into_owned();
        *lock(&self.tokens) = Some(Tokens {
            access: text("accessToken"),
            refresh: text("refreshToken"),
            expires_at: js_number(fresh.and_then(|t| t.get("expiresAt"))),
        });
        Ok(())
    }

    /// `requestWithRetry('GET', endpoint, { params })` (`getAuthenticated`).
    async fn request(&self, endpoint: &str, params: &[(&str, Value)]) -> Result<Value, TraktError> {
        let mut retry_auth = true;
        let mut retry_rate = true;
        loop {
            self.ensure_fresh().await?;
            assert_circuit_closed(&self.circuit_key())?;
            let key = self.scoped_key(endpoint, params);
            if let Some(cached) = cache_get(&key) {
                return Ok(Arc::unwrap_or_clone(cached));
            }
            let token = self.access();
            let mut req = self
                .http
                .get(request_url(endpoint, params))
                .timeout(RAW_TIMEOUT)
                .header(reqwest::header::ACCEPT, "application/json")
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .header("trakt-api-version", "2")
                .header("trakt-api-key", &self.client_id)
                .header(reqwest::header::USER_AGENT, RAW_USER_AGENT);
            if let Some(token) = &token {
                req = req.header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"));
            }
            let failed = |e: reqwest::Error| {
                other(format!(
                    "Trakt API request failed: GET {endpoint}: {}",
                    crate::outbound::describe(&e)
                ))
            };
            let res = req.send().await.map_err(failed)?;
            let status = res.status().as_u16();
            if (200..300).contains(&status) {
                let value = body_value(res.text().await.map_err(failed)?);
                cache_set(key, value.clone(), GET_CACHE_TTL);
                return Ok(value);
            }
            if status == 429 {
                let retry_after = parse_retry_after(
                    res.headers()
                        .get("retry-after")
                        .and_then(|v| v.to_str().ok()),
                );
                if retry_rate && retry_after <= RETRY_AFTER_MAX_SECONDS {
                    let wait = if retry_after == 0 {
                        RATE_LIMIT_FALLBACK_SECONDS
                    } else {
                        retry_after
                    };
                    tokio::time::sleep(Duration::from_secs(wait)).await;
                    retry_rate = false;
                    continue;
                }
                return Err(self.rate_limit(retry_after));
            }
            if status == 401 && token.is_some() && retry_auth {
                self.refresh_tokens()
                    .await
                    .map_err(|e| actions::wrap("GET", endpoint, e))?;
                retry_auth = false;
                continue;
            }
            if token.is_none() && matches!(status, 401 | 403) {
                return Err(TraktError::AppAccessDenied);
            }
            return Err(other(format!(
                "Trakt API request failed: GET {endpoint} returned {status}"
            )));
        }
    }

    /// Open the circuit and build the error a 429 turns into.
    fn rate_limit(&self, retry_after: u64) -> TraktError {
        let key = self.circuit_key();
        let fallback = |n: u64| if n == 0 { None } else { Some(n) };
        open_circuit(
            &key,
            fallback(retry_after).unwrap_or(CIRCUIT_FALLBACK_SECONDS),
        );
        TraktError::rate_limited(
            fallback(retry_after)
                .or_else(|| fallback(remaining_circuit_seconds(&key)))
                .unwrap_or(CIRCUIT_FALLBACK_SECONDS),
        )
    }

    /// `TraktAPI.get` (`ExternalAPI.get` behind the circuit check), with a
    /// TTL of 300 seconds as every caller here passes.
    async fn external_get(
        &self,
        endpoint: &str,
        params: &[(&str, Value)],
    ) -> Result<Value, TraktError> {
        assert_circuit_closed(&self.circuit_key())?;
        let key = format!("{BASE_URL}{endpoint}{}", params_json(params, None));
        if let Some(cached) = cache_get(&key).filter(|v| truthy(Some(v))) {
            return Ok(Arc::unwrap_or_clone(cached));
        }
        let mut req = self
            .http
            .get(request_url(endpoint, params))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::ACCEPT, "application/json")
            .header("trakt-api-version", "2")
            .header("trakt-api-key", &self.client_id);
        if let Some(token) = self.access() {
            req = req.header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"));
        }
        let failed = |e: reqwest::Error| other(format!("{e}"));
        let res = req.send().await.map_err(failed)?;
        let status = res.status().as_u16();
        if status == 429 {
            let retry_after = parse_retry_after(
                res.headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok()),
            );
            return Err(self.rate_limit(retry_after));
        }
        if !(200..300).contains(&status) {
            return Err(TraktError::Axios(status));
        }
        let value = body_value(res.text().await.map_err(failed)?);
        cache_set(key, value.clone(), GET_CACHE_TTL);
        Ok(value)
    }

    /// `getAuthenticatedOrPublic`: the user's request, falling back to the
    /// plain cached GET on any failure but a rate limit.
    async fn authed_or_public(
        &self,
        endpoint: &str,
        params: &[(&str, Value)],
    ) -> Result<Value, TraktError> {
        match self.request(endpoint, params).await {
            Err(TraktError::RateLimited(seconds)) => Err(TraktError::RateLimited(seconds)),
            Ok(value) => Ok(value),
            Err(e) => {
                tracing::debug!(
                    endpoint,
                    "Authenticated Trakt request failed; retrying publicly: {}",
                    e.message()
                );
                assert_circuit_closed(&self.circuit_key())?;
                self.external_get(endpoint, params).await
            }
        }
    }

    /// One page of one stream.
    async fn type_page(
        &self,
        stream: Stream<'_>,
        kind: &str,
        page: i64,
        limit: i64,
        extended: &str,
    ) -> Result<Value, TraktError> {
        let params = page_params(limit, page, extended);
        match stream {
            Stream::Watchlist(user) => {
                self.request(&format!("/users/{user}/watchlist/{kind}"), &params)
                    .await
            }
            Stream::History => {
                self.request(&format!("/sync/history/{kind}"), &params)
                    .await
            }
            Stream::Chart(chart) => {
                let payload = self.request(&format!("/{kind}/{chart}"), &params).await?;
                let key = if kind == "movies" { "movie" } else { "show" };
                chart_entries(Some(&payload), key).map_err(other)
            }
        }
    }

    /// `collectTypePrefix`.
    async fn collect_type_prefix(
        &self,
        stream: Stream<'_>,
        kind: &str,
        needed: usize,
        page_size: i64,
        extended: &str,
    ) -> Result<Paged, TraktError> {
        let mut items: Vec<Value> = Vec::new();
        let mut seen: Vec<String> = Vec::new();
        let mut page = 1;
        let mut has_more = false;
        let size = usize::try_from(page_size).unwrap_or(usize::MAX);
        while items.len() < needed {
            let payload = self
                .type_page(stream, kind, page, page_size, extended)
                .await?;
            let batch = normalize_list_items(Some(&payload)).map_err(other)?;
            if batch.is_empty() {
                has_more = false;
                break;
            }
            let batch_len = batch.len();
            for entry in batch {
                let key = item_key(&entry);
                if seen.contains(&key) {
                    continue;
                }
                seen.push(key);
                items.push(entry);
                if items.len() >= needed {
                    break;
                }
            }
            if batch_len < size {
                has_more = false;
                break;
            }
            has_more = true;
            if items.len() >= needed {
                break;
            }
            page += 1;
        }
        items.truncate(needed);
        let full = items.len() >= needed;
        Ok(Paged {
            items,
            has_more: has_more && full,
        })
    }

    /// `fetchMergedMediaPages`.
    async fn fetch_merged(
        &self,
        stream: Stream<'_>,
        limit: i64,
        page: i64,
        extended: &str,
        by_position: bool,
    ) -> Result<Paged, TraktError> {
        let needed = usize::try_from(page.saturating_mul(limit)).unwrap_or(usize::MAX);
        let (movies, shows) = tokio::join!(
            self.collect_type_prefix(stream, "movies", needed, limit, extended),
            self.collect_type_prefix(stream, "shows", needed, limit, extended)
        );
        let (movies, shows) = (movies?, shows?);
        Ok(merge_and_paginate(
            &movies.items,
            &shows.items,
            page,
            limit,
            (movies.has_more, shows.has_more),
            by_position,
        ))
    }

    /// A single-type page or the merged one.
    async fn stream_page(
        &self,
        stream: Stream<'_>,
        fetch_type: FetchType,
        page: i64,
        limit: i64,
        extended: &str,
    ) -> Result<Paged, TraktError> {
        let limit = limit.clamp(1, 100);
        let page = page.max(1);
        if let Some(kind) = fetch_type.single() {
            let payload = self.type_page(stream, kind, page, limit, extended).await?;
            let items = normalize_list_items(Some(&payload)).map_err(other)?;
            let has_more = items.len() >= usize::try_from(limit).unwrap_or(usize::MAX);
            return Ok(Paged { items, has_more });
        }
        let by_position = matches!(stream, Stream::Chart(_));
        self.fetch_merged(stream, limit, page, extended, by_position)
            .await
    }

    /// `getChartItems`.
    ///
    /// # Errors
    ///
    /// Trakt's failures as Node classifies them.
    pub async fn chart_items(
        &self,
        chart: &str,
        fetch_type: FetchType,
        page: i64,
        limit: i64,
        extended: &str,
    ) -> Result<Paged, TraktError> {
        self.ensure_fresh().await?;
        self.stream_page(Stream::Chart(chart), fetch_type, page, limit, extended)
            .await
    }

    /// `getWatchlistItems`.
    ///
    /// # Errors
    ///
    /// Trakt's failures as Node classifies them.
    pub async fn watchlist_items(
        &self,
        user: &str,
        fetch_type: FetchType,
        page: i64,
        limit: i64,
        extended: &str,
    ) -> Result<Paged, TraktError> {
        self.ensure_fresh().await?;
        let user = if user.trim().is_empty() {
            "me"
        } else {
            user.trim()
        };
        self.stream_page(Stream::Watchlist(user), fetch_type, page, limit, extended)
            .await
    }

    /// `getHistoryItems`.
    ///
    /// # Errors
    ///
    /// Trakt's failures as Node classifies them.
    pub async fn history_items(
        &self,
        fetch_type: FetchType,
        page: i64,
        limit: i64,
        extended: &str,
    ) -> Result<Paged, TraktError> {
        self.ensure_fresh().await?;
        self.stream_page(Stream::History, fetch_type, page, limit, extended)
            .await
    }

    /// One page of a list: the user's request (or the plain GET without a
    /// token).
    async fn list_page(
        &self,
        path: &str,
        page: i64,
        limit: i64,
        extended: &str,
    ) -> Result<Value, TraktError> {
        let params = page_params(limit, page, extended);
        if self.access().is_some() {
            self.authed_or_public(path, &params).await
        } else {
            self.external_get(path, &params).await
        }
    }

    /// `getListItems`.
    ///
    /// # Errors
    ///
    /// Trakt's failures as Node classifies them.
    pub async fn list_items(
        &self,
        username: Option<&str>,
        list_ref: &str,
        fetch_type: FetchType,
        page: i64,
        extended: &str,
        sort_by: Option<SortBy>,
    ) -> Result<Paged, TraktError> {
        let list_ref = list_ref.trim();
        if list_ref.is_empty() {
            return Err(other(String::from("listRef is required")));
        }
        let types = fetch_type.single().unwrap_or("movies,shows");
        let limit = 20;
        let page = page.max(1);
        let path = username.filter(|u| !u.is_empty()).map_or_else(
            || format!("/lists/{list_ref}/items/{types}"),
            |user| format!("/users/{user}/lists/{list_ref}/items/{types}"),
        );
        let Some(sort_by) = sort_by else {
            let payload = self.list_page(&path, page, limit, extended).await?;
            let items = normalize_list_items(Some(&payload)).map_err(other)?;
            let has_more = items.len() >= 20;
            return Ok(Paged { items, has_more });
        };
        let pool_params = [
            ("sortBy", Value::from(sort_by.as_str())),
            ("limit", Value::from(limit)),
            ("pool", Value::from("sorted-list")),
        ];
        let key = self.scoped_key(&format!("{path}:sorted"), &pool_params);
        if let Some(pool) = cache_get(&key).filter(|v| truthy(Some(v))) {
            let items = pool
                .get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let more = truthy(pool.get("hasMoreUpstream"));
            return Ok(paginate_sorted(&items, page, limit, sort_by, more));
        }
        let mut collected: Vec<Value> = Vec::new();
        let mut seen: Vec<String> = Vec::new();
        let mut has_more_upstream = false;
        let mut trakt_page = 1;
        while trakt_page <= SORTED_LIST_MAX_PAGES {
            let payload = self.list_page(&path, trakt_page, limit, extended).await?;
            let batch = normalize_list_items(Some(&payload)).map_err(other)?;
            if batch.is_empty() {
                has_more_upstream = false;
                break;
            }
            let batch_len = batch.len();
            for entry in batch {
                let entry_key = item_key(&entry);
                if !seen.contains(&entry_key) {
                    seen.push(entry_key);
                    collected.push(entry);
                }
            }
            if batch_len < 20 {
                has_more_upstream = false;
                break;
            }
            has_more_upstream = true;
            trakt_page += 1;
        }
        let mut pool = Map::new();
        pool.insert(String::from("items"), Value::Array(collected.clone()));
        pool.insert(
            String::from("hasMoreUpstream"),
            Value::Bool(has_more_upstream),
        );
        cache_set(key, Value::Object(pool), GET_CACHE_TTL);
        Ok(paginate_sorted(
            &collected,
            page,
            limit,
            sort_by,
            has_more_upstream,
        ))
    }

    /// `getListMetadata`.
    ///
    /// # Errors
    ///
    /// Trakt's failures as Node classifies them.
    pub async fn list_metadata(
        &self,
        username: Option<&str>,
        list_ref: &str,
    ) -> Result<Value, TraktError> {
        let list_ref = list_ref.trim();
        if list_ref.is_empty() {
            return Err(other(String::from("listRef is required")));
        }
        let path = username.filter(|u| !u.is_empty()).map_or_else(
            || format!("/lists/{list_ref}"),
            |user| format!("/users/{user}/lists/{list_ref}"),
        );
        let payload = if self.access().is_some() {
            self.authed_or_public(&path, &[]).await?
        } else {
            self.external_get(&path, &[]).await?
        };
        normalize_list_metadata(Some(&payload)).map_err(other)
    }

    /// `getUserLists('me')`.
    ///
    /// # Errors
    ///
    /// Trakt's failures as Node classifies them.
    pub async fn user_lists(&self) -> Result<Vec<Value>, TraktError> {
        self.ensure_fresh().await?;
        let payload = self
            .request("/users/me/lists", &[("extended", Value::from("min"))])
            .await?;
        normalize_user_lists(Some(&payload)).map_err(other)
    }

    /// `getLikedLists()`.
    ///
    /// # Errors
    ///
    /// Trakt's failures as Node classifies them.
    pub async fn liked_lists(&self) -> Result<Vec<Value>, TraktError> {
        self.ensure_fresh().await?;
        let payload = self.request("/users/likes/lists", &[]).await?;
        normalize_liked_lists(Some(&payload)).map_err(other)
    }

    /// `searchLists(query)`.
    ///
    /// # Errors
    ///
    /// Trakt's failures as Node classifies them.
    pub async fn search_lists(&self, query: &str) -> Result<Vec<Value>, TraktError> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let payload = self
            .external_get(
                "/search/list",
                &[("query", Value::from(q)), ("limit", Value::from(20))],
            )
            .await?;
        normalize_search_lists(Some(&payload)).map_err(other)
    }

    /// `getSyncWatched(mediaType)` (`watched`) or `getSyncRatings(mediaType)`
    /// (`ratings`): every page of the user's sync list (`getAllSyncPages`).
    ///
    /// # Errors
    ///
    /// Trakt's failures as Node classifies them.
    pub async fn sync_list(&self, list: &str, tv: bool) -> Result<Vec<Value>, TraktError> {
        let path = format!("/sync/{list}/{}", if tv { "shows" } else { "movies" });
        let progress = tv && list == "watched";
        let limit: i64 = if progress { 100 } else { 250 };
        let mut items = Vec::new();
        let mut page: i64 = 1;
        loop {
            let params: Vec<(&str, Value)> = if progress {
                vec![
                    ("extended", Value::from("progress")),
                    ("limit", Value::from(limit)),
                    ("page", Value::from(page)),
                ]
            } else {
                vec![("page", Value::from(page)), ("limit", Value::from(limit))]
            };
            let batch = match self.request(&path, &params).await? {
                Value::Null => return Ok(items),
                Value::Array(batch) => batch,
                Value::Bool(_) | Value::Number(_) | Value::String(_) | Value::Object(_) => {
                    return Err(other(String::from("a Trakt page that isn't a list")))
                }
            };
            if batch.is_empty() {
                return Ok(items);
            }
            let full = i64::try_from(batch.len()).unwrap_or(i64::MAX) >= limit;
            items.extend(batch);
            if !full {
                return Ok(items);
            }
            page += 1;
        }
    }

    /// `getRecommendations(mediaType, { limit: 500, ... })`.
    ///
    /// # Errors
    ///
    /// Trakt's failures as Node classifies them.
    pub async fn recommendations(
        &self,
        media_type: &str,
        ignore_collected: bool,
        ignore_watchlisted: bool,
        extended: &str,
    ) -> Result<Vec<Value>, TraktError> {
        self.ensure_fresh().await?;
        let path = if media_type == "movie" {
            "/recommendations/movies"
        } else {
            "/recommendations/shows"
        };
        let mut params = vec![
            ("limit", Value::from(RECOMMENDATIONS_LIMIT_MAX)),
            ("extended", Value::from(extended)),
        ];
        if ignore_collected {
            params.push(("ignore_collected", Value::from("true")));
        }
        if ignore_watchlisted {
            params.push(("ignore_watchlisted", Value::from("true")));
        }
        let payload = self.request(path, &params).await?;
        normalize_recommendation_items(Some(&payload), media_type).map_err(other)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_retry_after_like_parse_int() {
        assert_eq!(parse_retry_after(Some("120")), 120, "plain");
        assert_eq!(parse_retry_after(Some(" 1.5")), 1, "leading integer");
        assert_eq!(parse_retry_after(Some("abc")), 0, "NaN");
        assert_eq!(parse_retry_after(Some("-5")), 0, "negative");
        assert_eq!(parse_retry_after(None), 0, "missing");
    }

    #[test]
    fn builds_keys_and_urls() {
        let params = [("query", json!("a b")), ("limit", json!(20))];
        assert_eq!(
            params_json(&params, None),
            r#"{"query":"a b","limit":20}"#,
            "plain key"
        );
        assert_eq!(
            params_json(&[], Some("public")),
            r#"{"headers":{"x-trakt-cache-scope":"public"}}"#,
            "scoped key"
        );
        assert_eq!(
            request_url("/search/list", &params),
            "https://api.trakt.tv/search/list?query=a+b&limit=20",
            "axios query"
        );
    }

    #[test]
    fn circuits_are_per_key() {
        open_circuit("client:test-circuit", 0);
        assert!(
            matches!(
                assert_circuit_closed("client:test-circuit"),
                Err(TraktError::RateLimited(60))
            ),
            "open"
        );
        assert!(assert_circuit_closed("client:other").is_ok(), "other keys");
        assert_eq!(
            TraktError::rate_limited(0),
            TraktError::RateLimited(1),
            "at least one second"
        );
    }

    #[test]
    fn scopes_by_token_tail() {
        let token = Some("0123456789abcdefXYZ");
        assert_eq!(scope(token), "auth:3456789abcdefXYZ", "last 16");
        assert_eq!(
            circuit_key(token, "id"),
            "token:0123456789abcdefXYZ",
            "token circuit"
        );
        assert_eq!(circuit_key(None, ""), "client:public", "app circuit");
        assert_eq!(circuit_key(None, "id"), "client:id", "app id circuit");
        assert_eq!(scope(None), "public", "public scope");
    }
}
