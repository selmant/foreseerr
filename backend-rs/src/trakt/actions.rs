//! The writes of `server/api/trakt/index.ts` the media actions make.
//!
//! `requestWithRetry` for POST and DELETE (and the uncached GET of the
//! playback list), the history and rating bodies, and the cache
//! invalidation after a sync write.

use std::time::Duration;

use reqwest::Method;
use serde_json::{Map, Value};

use super::{
    assert_circuit_closed, body_value, cache_get, cache_set, other, parse_retry_after, request_url,
    TraktClient, TraktError, BASE_URL, GET_CACHE_TTL, RATE_LIMIT_FALLBACK_SECONDS, RAW_TIMEOUT,
    RAW_USER_AGENT, RETRY_AFTER_MAX_SECONDS,
};
use crate::mappinglayer::MediaType;

/// The `catch` of `requestWithRetry`: errors of its own kinds pass, any
/// other is wrapped with the method and endpoint.
#[must_use]
pub fn wrap(method: &str, endpoint: &str, error: TraktError) -> TraktError {
    match error {
        TraktError::RateLimited(_) | TraktError::Reconnect(_) | TraktError::AppAccessDenied => {
            error
        }
        TraktError::Other(message) if message.starts_with("Trakt API") => {
            TraktError::Other(message)
        }
        e @ (TraktError::Other(_)
        | TraktError::NotConfigured
        | TraktError::NotLinked
        | TraktError::Axios(_)) => other(format!(
            "Trakt API request failed: {method} {endpoint}: {}",
            e.message()
        )),
    }
}

/// `requestWithRetry(method, endpoint, { params, data, skipCache })`.
///
/// # Errors
///
/// Trakt's failures, worded as Node's.
pub async fn request(
    client: &TraktClient,
    method: Method,
    endpoint: &str,
    params: &[(&str, Value)],
    data: Option<&Value>,
    skip_cache: bool,
) -> Result<Value, TraktError> {
    let verb = method.as_str().to_owned();
    let cached_get = method == Method::GET && !skip_cache;
    let mut retry_auth = true;
    let mut retry_rate = true;
    loop {
        client.ensure_fresh().await?;
        assert_circuit_closed(&client.circuit_key())?;
        let key = client.scoped_key(endpoint, params);
        if cached_get {
            if let Some(cached) = cache_get(&key) {
                return Ok(std::sync::Arc::unwrap_or_clone(cached));
            }
        }
        let token = client.access();
        let mut req = client
            .http
            .request(method.clone(), request_url(endpoint, params))
            .timeout(RAW_TIMEOUT)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header("trakt-api-version", "2")
            .header("trakt-api-key", &client.client_id)
            .header(reqwest::header::USER_AGENT, RAW_USER_AGENT);
        if let Some(token) = &token {
            req = req.header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"));
        }
        if let Some(data) = data {
            req = req.body(data.to_string());
        }
        let failed = |e: &reqwest::Error| {
            other(format!(
                "Trakt API request failed: {verb} {endpoint}: {}",
                crate::outbound::describe(e)
            ))
        };
        let res = req.send().await.map_err(|e| failed(&e))?;
        let status = res.status().as_u16();
        if (200..300).contains(&status) {
            let value = body_value(res.text().await.map_err(|e| failed(&e))?);
            if cached_get {
                cache_set(key, value.clone(), GET_CACHE_TTL);
            }
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
            return Err(client.rate_limit(retry_after));
        }
        if status == 401 && token.is_some() && retry_auth {
            client
                .refresh_tokens()
                .await
                .map_err(|e| wrap(&verb, endpoint, e))?;
            retry_auth = false;
            continue;
        }
        if token.is_none() && matches!(status, 401 | 403) {
            return Err(TraktError::AppAccessDenied);
        }
        return Err(other(format!(
            "Trakt API request failed: {verb} {endpoint} returned {status}"
        )));
    }
}

/// `invalidateWatchedGetCache()`: drop the cached sync lists.
fn invalidate_watched_get_cache() {
    let prefixes = [
        "/sync/watched/shows",
        "/sync/watched/movies",
        "/sync/ratings/shows",
        "/sync/ratings/movies",
    ]
    .map(|endpoint| format!("{BASE_URL}{endpoint}"));
    for key in crate::memcache::keys(crate::memcache::CacheId::Trakt) {
        if prefixes.iter().any(|p| key.starts_with(p.as_str())) {
            crate::memcache::delete(crate::memcache::CacheId::Trakt, &key);
        }
    }
}

/// `postAuthenticated(endpoint, data)`.
async fn post(client: &TraktClient, endpoint: &str, data: &Value) -> Result<Value, TraktError> {
    let result = request(client, Method::POST, endpoint, &[], Some(data), false).await?;
    if endpoint.starts_with("/sync/history") || endpoint.starts_with("/sync/ratings") {
        invalidate_watched_get_cache();
    }
    Ok(result)
}

fn object(pairs: Vec<(&str, Value)>) -> Value {
    Value::Object(
        pairs
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect::<Map<String, Value>>(),
    )
}

/// `{ ids: { tmdb } }`.
fn ids(tmdb_id: i64) -> Value {
    object(vec![("ids", object(vec![("tmdb", Value::from(tmdb_id))]))])
}

/// `syncBody(mediaType, item)`.
fn sync_body(media_type: MediaType, item: Value) -> Value {
    let key = match media_type {
        MediaType::Movie => "movies",
        MediaType::Tv => "shows",
    };
    object(vec![(key, Value::Array(vec![item]))])
}

/// `addToHistory(mediaType, tmdbId, watchedAt)`.
///
/// # Errors
///
/// Trakt's failures.
pub async fn add_to_history(
    client: &TraktClient,
    media_type: MediaType,
    tmdb_id: i64,
    watched_at: Option<&str>,
) -> Result<(), TraktError> {
    let mut item = ids(tmdb_id);
    if let (Some(at), Value::Object(map)) = (watched_at, &mut item) {
        map.insert(String::from("watched_at"), Value::from(at));
    }
    post(client, "/sync/history", &sync_body(media_type, item))
        .await
        .map(drop)
}

/// `removeFromHistory(mediaType, tmdbId)`.
///
/// # Errors
///
/// Trakt's failures.
pub async fn remove_from_history(
    client: &TraktClient,
    media_type: MediaType,
    tmdb_id: i64,
) -> Result<(), TraktError> {
    post(
        client,
        "/sync/history/remove",
        &sync_body(media_type, ids(tmdb_id)),
    )
    .await
    .map(drop)
}

/// `addRating(mediaType, tmdbId, rating)`.
///
/// # Errors
///
/// A rating outside 1–10, or Trakt's failures.
pub async fn add_rating(
    client: &TraktClient,
    media_type: MediaType,
    tmdb_id: i64,
    rating: f64,
) -> Result<(), TraktError> {
    let value = rating.trunc();
    if !(1.0..=10.0).contains(&value) {
        return Err(other(String::from("Trakt rating must be between 1 and 10")));
    }
    let mut item = ids(tmdb_id);
    if let Value::Object(map) = &mut item {
        map.insert(String::from("rating"), crate::jsval::num(value));
    }
    post(client, "/sync/ratings", &sync_body(media_type, item))
        .await
        .map(drop)
}

/// `removeRating(mediaType, tmdbId)`.
///
/// # Errors
///
/// Trakt's failures.
pub async fn remove_rating(
    client: &TraktClient,
    media_type: MediaType,
    tmdb_id: i64,
) -> Result<(), TraktError> {
    post(
        client,
        "/sync/ratings/remove",
        &sync_body(media_type, ids(tmdb_id)),
    )
    .await
    .map(drop)
}

/// `episodeHistoryPayload(tmdbShowId, seasonNumber, episodeNumber)`.
#[must_use]
pub fn episode_history_payload(tmdb_show_id: i64, season: i64, episode: i64) -> Value {
    let episodes = Value::Array(vec![object(vec![("number", Value::from(episode))])]);
    let seasons = Value::Array(vec![object(vec![
        ("number", Value::from(season)),
        ("episodes", episodes),
    ])]);
    let mut show = ids(tmdb_show_id);
    if let Value::Object(map) = &mut show {
        map.insert(String::from("seasons"), seasons);
    }
    object(vec![("shows", Value::Array(vec![show]))])
}

/// `addEpisodeToHistory`: the history write, then the paused playback
/// rows of that episode go (their failures are only logged).
///
/// # Errors
///
/// The history write's failures.
pub async fn add_episode_to_history(
    client: &TraktClient,
    tmdb_show_id: i64,
    season: i64,
    episode: i64,
) -> Result<(), TraktError> {
    post(
        client,
        "/sync/history",
        &episode_history_payload(tmdb_show_id, season, episode),
    )
    .await?;
    if let Err(e) = remove_episode_playback_progress(client, tmdb_show_id, season, episode).await {
        tracing::warn!(
            tmdb_show_id,
            season,
            episode,
            "Failed to clear Trakt playback progress after history add: {}",
            e.message()
        );
    }
    Ok(())
}

/// `removeEpisodeFromHistory`.
///
/// # Errors
///
/// Trakt's failures.
pub async fn remove_episode_from_history(
    client: &TraktClient,
    tmdb_show_id: i64,
    season: i64,
    episode: i64,
) -> Result<(), TraktError> {
    post(
        client,
        "/sync/history/remove",
        &episode_history_payload(tmdb_show_id, season, episode),
    )
    .await
    .map(drop)
}

/// `listEpisodePlaybackProgress()`: up to 20 uncached pages of 100.
async fn playback_episodes(client: &TraktClient) -> Result<Vec<Value>, TraktError> {
    let mut items = Vec::new();
    let limit: usize = 100;
    for page in 1..=20_i64 {
        let params = [("page", Value::from(page)), ("limit", Value::from(100))];
        let batch = request(
            client,
            Method::GET,
            "/sync/playback/episodes",
            &params,
            None,
            true,
        )
        .await?;
        let rows = match batch {
            Value::Array(rows) => rows,
            Value::Null
            | Value::Bool(_)
            | Value::Number(_)
            | Value::String(_)
            | Value::Object(_) => Vec::new(),
        };
        let count = rows.len();
        items.extend(rows);
        if count < limit {
            break;
        }
    }
    Ok(items)
}

/// `removeEpisodePlaybackProgress`: delete the paused rows of one
/// episode (a 404 counts as gone; other failures are logged).
///
/// # Errors
///
/// Listing the paused rows failed.
pub async fn remove_episode_playback_progress(
    client: &TraktClient,
    tmdb_show_id: i64,
    season: i64,
    episode: i64,
) -> Result<(), TraktError> {
    let paused = playback_episodes(client).await?;
    let number = |v: Option<&Value>| crate::jsval::number_of(v);
    let matching = paused.iter().filter(|entry| {
        let show_tmdb = entry
            .get("show")
            .and_then(|s| s.get("ids"))
            .and_then(|i| i.get("tmdb"));
        let ep = entry.get("episode");
        let is =
            |v: Option<&Value>, n: i64| crate::jsval::same(number(v), crate::jsnum::from_i64(n));
        is(show_tmdb, tmdb_show_id)
            && is(ep.and_then(|e| e.get("season")), season)
            && is(ep.and_then(|e| e.get("number")), episode)
    });
    for entry in matching {
        let Some(id) = entry
            .get("id")
            .and_then(Value::as_f64)
            .filter(|id| id.is_finite() && *id > 0.0)
        else {
            continue;
        };
        let endpoint = format!("/sync/playback/{}", crate::jsnum::to_string(id));
        match request(client, Method::DELETE, &endpoint, &[], None, true).await {
            Ok(_) => {}
            Err(e) if e.message().contains("returned 404") => {}
            Err(e) => tracing::warn!(
                tmdb_show_id,
                season,
                episode,
                "Failed to remove Trakt playback progress: {}",
                e.message()
            ),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bodies() {
        assert_eq!(
            episode_history_payload(42, 1, 3),
            json!({"shows": [{"ids": {"tmdb": 42}, "seasons": [{"number": 1, "episodes": [{"number": 3}]}]}]}),
            "episode payload"
        );
        assert_eq!(
            sync_body(MediaType::Movie, ids(550)),
            json!({"movies": [{"ids": {"tmdb": 550}}]}),
            "movie body"
        );
        assert_eq!(
            wrap("POST", "/sync/history", other(String::from("Trakt token refresh failed with status 500"))).message(),
            "Trakt API request failed: POST /sync/history: Trakt token refresh failed with status 500",
            "wrapped"
        );
        assert_eq!(
            wrap("POST", "/x", TraktError::NotConfigured).message(),
            "Trakt API request failed: POST /x: Trakt application credentials are not configured",
            "not configured is wrapped too"
        );
        assert_eq!(
            wrap("POST", "/x", TraktError::Reconnect(String::from("r"))),
            TraktError::Reconnect(String::from("r")),
            "reconnect passes"
        );
    }
}
