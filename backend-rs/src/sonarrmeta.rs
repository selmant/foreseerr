//! Sonarr reads beyond adding a series: the series lookup by other ids
//! (`tmdb:` and the like, on Sonarr 4 and 5 alike).

use anyhow::Result;
use reqwest::Method;
use serde_json::Value;

use crate::arr::Arr;

async fn read(arr: &Arr<'_>, path: &str, query: &[(&str, String)]) -> Result<Value> {
    arr.client
        .call(arr.server, Method::GET, path, query, None, arr.timeout)
        .await
}

/// `GET /series/lookup?term={term}`: Sonarr's search, which takes `tvdb:`,
/// `tmdb:`, `imdb:`, `anilist:` and `mal:` ids as well as titles.
///
/// # Errors
///
/// Fails when the call fails.
pub async fn lookup_series(arr: &Arr<'_>, term: &str) -> Result<Vec<Value>> {
    Ok(
        match read(arr, "/series/lookup", &[("term", term.to_owned())]).await? {
            Value::Array(found) => found,
            Value::Null
            | Value::Bool(_)
            | Value::Number(_)
            | Value::String(_)
            | Value::Object(_) => Vec::new(),
        },
    )
}

/// The `tmdb:` lookup, keeping only series whose `tmdbId` is that id:
/// Sonarr resolves it through TVDB's own TMDB links.
///
/// # Errors
///
/// Fails when the call fails.
pub async fn series_by_tmdb(arr: &Arr<'_>, tmdb_id: i64) -> Result<Vec<Value>> {
    let found = lookup_series(arr, &format!("tmdb:{tmdb_id}")).await?;
    Ok(with_tmdb_id(found, tmdb_id))
}

/// Lookup results for `tmdb_id` only.
#[must_use]
pub fn with_tmdb_id(found: Vec<Value>, tmdb_id: i64) -> Vec<Value> {
    found
        .into_iter()
        .filter(|s| s.get("tmdbId").and_then(Value::as_i64) == Some(tmdb_id))
        .collect()
}

/// The first TVDB id among lookup results.
#[must_use]
pub fn first_tvdb_id(found: &[Value]) -> Option<i64> {
    found
        .iter()
        .find_map(|s| s.get("tvdbId").and_then(Value::as_i64).filter(|id| *id > 0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tmdb_matches_only() {
        let found = vec![
            json!({"title": "Firefly", "tvdbId": 78874, "tmdbId": 1437}),
            json!({"title": "Firefly Lane", "tvdbId": 1, "tmdbId": 2}),
            json!({"title": "No TMDB", "tvdbId": 3}),
        ];
        let kept = with_tmdb_id(found, 1437);
        assert_eq!(kept.len(), 1, "only the requested show");
        assert_eq!(first_tvdb_id(&kept), Some(78874));
        assert_eq!(first_tvdb_id(&[json!({"tvdbId": 0})]), None, "no id");
    }
}
