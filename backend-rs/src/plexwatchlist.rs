//! `PlexTvAPI.getWatchlist` (`server/api/plextv.ts`).
//!
//! The watchlist page with its `plexwatchlist` cache (`ETag` per token,
//! five minutes) and the
//! per-item metadata through `ExternalAPI.getRolling`'s `plextv` cache
//! (five minutes, refreshed in the background once ten seconds old).

use std::time::Duration;

use reqwest::header::{ACCEPT, CONTENT_TYPE, IF_NONE_MATCH};
use serde_json::{Map, Value};

use crate::memcache::{self, CacheId};

const DISCOVER_URL: &str = "https://discover.provider.plex.tv";
const TTL: Duration = Duration::from_secs(300);
const ROLLING_BUFFER: Duration = Duration::from_secs(10);

/// `PlexWatchlistItem`, as the route reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    /// `metadata.ratingKey` (`None` when missing).
    pub rating_key: Option<Value>,
    /// The TMDB id from the `tmdb://` GUID, `NaN` or 0 when unusable.
    pub tmdb_id: f64,
    /// The TVDB id from the `tvdb://` GUID (`NaN` when unusable), when
    /// there is one.
    pub tvdb_id: Option<f64>,
    /// `metadata.title`.
    pub title: Option<Value>,
    /// `metadata.type`.
    pub kind: Option<Value>,
}

/// The page: total size and items.
#[derive(Debug, Clone, PartialEq)]
pub struct Page {
    /// `MediaContainer.totalSize`.
    pub total_size: Value,
    /// The items with metadata.
    pub items: Vec<Item>,
}

impl Page {
    fn empty() -> Self {
        Self {
            total_size: Value::from(0),
            items: Vec::new(),
        }
    }
}

/// What went wrong in a way only Node's output reproduces.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unportable(pub String);

fn request(client: &reqwest::Client, token: &str, url: &str) -> reqwest::RequestBuilder {
    client
        .get(url)
        .header("X-Plex-Token", token)
        .header(CONTENT_TYPE, "application/json")
        .header(ACCEPT, "application/json")
}

async fn fetch_json(req: reqwest::RequestBuilder) -> Result<(u16, Option<String>, Value), ()> {
    let res = req.send().await.map_err(|_| ())?;
    let status = res.status().as_u16();
    let etag = res
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let text = res.text().await.map_err(|_| ())?;
    let body = serde_json::from_str::<Value>(&text)
        .map_or_else(|_| Value::from(text.as_str()), crate::tmdb::js_numbers);
    Ok((status, etag, body))
}

/// `getWatchlist({ offset })`; Node's catch-all turns failures into an
/// empty page.
///
/// # Errors
///
/// `Unportable` for responses whose handling only Node reproduces.
pub async fn watchlist(
    client: &reqwest::Client,
    token: &str,
    offset: f64,
) -> Result<Page, Unportable> {
    // The shared `plexwatchlist` cache: token → `{ etag, response }`.
    let cached = memcache::get(CacheId::PlexWatchlist, token).map(|entry| {
        (
            entry.get("etag").and_then(Value::as_str).map(str::to_owned),
            entry.get("response").cloned().unwrap_or(Value::Null),
        )
    });
    let url = format!(
        "{DISCOVER_URL}/library/sections/watchlist/all?X-Plex-Container-Start={}&X-Plex-Container-Size=20",
        crate::jsval::number_string(offset)
    );
    let mut req = request(client, token, &url);
    if let Some(etag) = cached.as_ref().and_then(|(etag, _)| etag.as_ref()) {
        req = req.header(IF_NONE_MATCH, etag);
    }
    let Ok((status, etag, body)) = fetch_json(req).await else {
        tracing::error!("[Plex.TV Metadata API] Failed to retrieve watchlist items");
        return Ok(Page::empty());
    };
    if status >= 400 {
        tracing::error!("[Plex.TV Metadata API] Failed to retrieve watchlist items");
        return Ok(Page::empty());
    }
    let response = if (200..300).contains(&status) {
        let mut entry = Map::new();
        if let Some(etag) = etag {
            entry.insert(String::from("etag"), Value::from(etag));
        }
        entry.insert(String::from("response"), body.clone());
        memcache::set(
            CacheId::PlexWatchlist,
            token.to_owned(),
            Value::Object(entry),
            TTL,
        );
        Some(body)
    } else {
        cached.map(|(_, response)| response)
    };
    let Some(response) = response else {
        return Ok(Page::empty());
    };
    let Some(container) = response.get("MediaContainer").filter(|c| !c.is_null()) else {
        return Ok(Page::empty());
    };
    let entries = match container.get("Metadata") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items.clone(),
        Some(_) => return Ok(Page::empty()),
    };
    let mut keys = Vec::with_capacity(entries.len());
    for entry in &entries {
        if entry.is_null() {
            return Ok(Page::empty());
        }
        let key = crate::jsval::string_of(entry.get("ratingKey"));
        if !key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        {
            return Err(Unportable(String::from("a ratingKey that needs encoding")));
        }
        keys.push(key);
    }
    let mut set = tokio::task::JoinSet::new();
    for (index, key) in keys.into_iter().enumerate() {
        let client = client.clone();
        let token = token.to_owned();
        set.spawn(async move { (index, metadata(&client, &token, &key).await) });
    }
    let mut details: Vec<Option<Result<Option<Item>, ()>>> = vec![None; entries.len()];
    while let Some(done) = set.join_next().await {
        if let Ok((index, detail)) = done {
            if let Some(slot) = details.get_mut(index) {
                *slot = Some(detail);
            }
        }
    }
    let mut items = Vec::new();
    for detail in details {
        match detail {
            Some(Ok(Some(item))) => items.push(item),
            Some(Ok(None)) => {}
            Some(Err(())) | None => {
                tracing::error!("[Plex.TV Metadata API] Failed to retrieve watchlist items");
                return Ok(Page::empty());
            }
        }
    }
    let total_size = match container.get("totalSize") {
        None | Some(Value::Null) => Value::from(0),
        Some(n @ Value::Number(_)) => n.clone(),
        Some(_) => return Err(Unportable(String::from("totalSize isn't a number"))),
    };
    Ok(Page { total_size, items })
}

/// One item's metadata: `Ok(None)` where Node skips it (404, no
/// metadata), `Err` where it throws.
async fn metadata(
    client: &reqwest::Client,
    token: &str,
    rating_key: &str,
) -> Result<Option<Item>, ()> {
    let path = format!("/library/metadata/{rating_key}");
    let response = rolling(client, token, &path).await?;
    let Some(response) = response else {
        tracing::warn!(
            "[Plex.TV Metadata API] Item with ratingKey {rating_key} not found, it may have been removed from the server."
        );
        return Ok(None);
    };
    let container = response
        .get("MediaContainer")
        .filter(|c| !c.is_null())
        .ok_or(())?;
    let first = |key: &str| -> Result<Option<Value>, ()> {
        match container.get(key) {
            Some(Value::Array(items)) => Ok(items.first().filter(|v| !v.is_null()).cloned()),
            Some(Value::Object(map)) => Ok(map.get("0").filter(|v| !v.is_null()).cloned()),
            // `"text"[0]` is its first UTF-16 unit.
            Some(Value::String(text)) => Ok(text
                .encode_utf16()
                .next()
                .map(|unit| Value::from(String::from_utf16_lossy(&[unit])))),
            None | Some(Value::Null | Value::Bool(_) | Value::Number(_)) => Ok(None),
        }
    };
    let Some(metadata) = first("Metadata")?.map_or_else(|| first("Video"), |m| Ok(Some(m)))? else {
        tracing::warn!(
            "[Plex.TV Metadata API] Item with ratingKey {rating_key} returned no metadata, skipping."
        );
        return Ok(None);
    };
    let metadata = metadata.as_object().cloned().unwrap_or_default();
    let tmdb = find_guid(metadata.get("Guid"), "tmdb")?;
    let tvdb_guid = find_guid(metadata.get("Guid"), "tvdb")?;
    let tmdb_id = tmdb.map_or(0.0, |id| {
        id.split("//")
            .nth(1)
            .map_or(f64::NAN, crate::jsval::number_of_str)
    });
    Ok(Some(Item {
        rating_key: metadata.get("ratingKey").cloned(),
        tmdb_id,
        tvdb_id: tvdb_guid.map(|id| {
            id.split("//")
                .nth(1)
                .map_or(f64::NAN, crate::jsval::number_of_str)
        }),
        title: metadata.get("title").cloned(),
        kind: metadata.get("type").cloned(),
    }))
}

/// `metadata.Guid?.find((guid) => guid.id.startsWith(prefix))`, `Err`
/// where it throws.
fn find_guid(guids: Option<&Value>, prefix: &str) -> Result<Option<String>, ()> {
    match guids {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(guids)) => {
            for guid in guids {
                match guid.get("id") {
                    Some(Value::String(id)) if id.starts_with(prefix) => {
                        return Ok(Some(id.clone()))
                    }
                    Some(Value::String(_)) => {}
                    _ => return Err(()),
                }
            }
            Ok(None)
        }
        Some(_) => Err(()),
    }
}

/// `getRolling(path)`: `Ok(None)` for a 404.
async fn rolling(client: &reqwest::Client, token: &str, path: &str) -> Result<Option<Value>, ()> {
    // The shared `plextv` cache, keyed by the path.
    let key = format!("https://plex.tv{path}");
    let cached = memcache::get(CacheId::PlexTv, &key)
        .filter(|value| crate::settings::public::truthy(Some(value)));
    let url = format!("{DISCOVER_URL}{path}");
    if let Some(value) = cached {
        // `getTtl(key) - ttl` is when the answer was stored.
        let stale = memcache::expires_at(CacheId::PlexTv, &key)
            .and_then(|expires| expires.checked_sub(TTL))
            .is_none_or(|stored| stored.elapsed() > ROLLING_BUFFER);
        if stale {
            let client = client.clone();
            let token = token.to_owned();
            let key = key.clone();
            tokio::spawn(async move {
                if let Ok((status, _, body)) = fetch_json(request(&client, &token, &url)).await {
                    if (200..300).contains(&status) {
                        memcache::set(CacheId::PlexTv, key, body, TTL);
                    }
                }
            });
        }
        return Ok(Some(std::sync::Arc::unwrap_or_clone(value)));
    }
    let (status, _, body) = fetch_json(request(client, token, &url)).await?;
    if status == 404 {
        return Ok(None);
    }
    if !(200..300).contains(&status) {
        return Err(());
    }
    memcache::set(CacheId::PlexTv, key, body.clone(), TTL);
    Ok(Some(body))
}

/// The route's tile for one item.
#[must_use]
pub fn tile(item: &Item) -> Value {
    let tmdb = (item.tmdb_id.is_finite() && item.tmdb_id > 0.0).then_some(item.tmdb_id);
    let mut out = Map::new();
    out.insert(String::from("id"), crate::jsval::num(tmdb.unwrap_or(0.0)));
    if let Some(key) = item.rating_key.clone() {
        out.insert(String::from("ratingKey"), key);
    }
    if let Some(title) = item.title.clone() {
        out.insert(String::from("title"), title);
    }
    let media_type = if item.kind.as_ref().and_then(Value::as_str) == Some("show") {
        "tv"
    } else {
        "movie"
    };
    out.insert(String::from("mediaType"), Value::from(media_type));
    if let Some(tmdb) = tmdb {
        out.insert(String::from("tmdbId"), crate::jsval::num(tmdb));
    }
    out.insert(String::from("source"), Value::from("plex"));
    if let Some(key) = item.rating_key.clone() {
        out.insert(String::from("sourceId"), key);
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tiles() {
        let item = Item {
            rating_key: Some(json!("abc")),
            tmdb_id: 603.0,
            tvdb_id: None,
            title: Some(json!("The Matrix")),
            kind: Some(json!("movie")),
        };
        assert_eq!(
            tile(&item),
            json!({"id": 603, "ratingKey": "abc", "title": "The Matrix", "mediaType": "movie", "tmdbId": 603, "source": "plex", "sourceId": "abc"}),
            "mapped"
        );
        let unmapped = Item {
            rating_key: None,
            tmdb_id: f64::NAN,
            tvdb_id: None,
            title: None,
            kind: Some(json!("show")),
        };
        assert_eq!(
            tile(&unmapped),
            json!({"id": 0, "mediaType": "tv", "source": "plex"}),
            "undefined fields left out"
        );
    }
}
