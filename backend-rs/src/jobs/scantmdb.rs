//! The TMDB lookups of the scanners.
//!
//! `getTvShowForScan`,
//! `getShowByTvdbIdForScan`, `resolveImdbIdForScan`,
//! `getByExternalIdForScan`, fifteen-minute cache) and
//! `getMetadataProvider`'s swap to TVDB, which is still Node's.
//!
//! The scanners' `TheMovieDb` is built when Node imports them, before
//! settings are loaded, so its locale is the default `en`.

use anyhow::{anyhow, Context, Result};
use serde_json::Value;

use super::scanbase::{array_of, internal_call};
use super::JobCtx;

/// `ANIME_KEYWORD_ID`.
const ANIME_KEYWORD_ID: i64 = 210_024;
/// The scan cache's TTL.
const SCAN_TTL: u64 = 900;
/// The scanners' TMDB locale.
const LOCALE: &str = "en";

/// `getTvShowForScan({ tvId })`.
///
/// # Errors
///
/// `[TMDB] Failed to fetch TV show scan details: …`.
pub async fn tv_for_scan(job: &JobCtx, tv_id: i64) -> Result<Value> {
    job.state
        .tmdb
        .raw_scan(
            &format!("/tv/{tv_id}"),
            &[
                ("language", LOCALE.to_owned()),
                ("append_to_response", String::from("keywords,external_ids")),
            ],
            SCAN_TTL,
        )
        .await
        .map(std::sync::Arc::unwrap_or_clone)
        .context("[TMDB] Failed to fetch TV show scan details")
}

/// `getByExternalIdForScan({ externalId, type })`.
async fn find_for_scan(
    job: &JobCtx,
    external_id: &str,
    imdb: bool,
) -> Result<std::sync::Arc<Value>> {
    job.state
        .tmdb
        .raw_scan(
            &format!("/find/{external_id}"),
            &[
                (
                    "external_source",
                    String::from(if imdb { "imdb_id" } else { "tvdb_id" }),
                ),
                ("language", LOCALE.to_owned()),
            ],
            SCAN_TTL,
        )
        .await
        .context("[TMDB] Failed to find by external ID")
}

fn first_id(found: &Value, key: &str) -> Option<i64> {
    array_of(found, key)
        .first()
        .and_then(|r| r.get("id"))
        .and_then(Value::as_i64)
}

fn id_of(value: &Value) -> Result<i64> {
    value
        .get("id")
        .and_then(Value::as_i64)
        .ok_or_else(|| anyhow!("TMDB answered without an id"))
}

/// `resolveImdbIdForScan({ imdbId })`: the movie (verified) or show id.
///
/// # Errors
///
/// `[TMDB] Failed to find media using external IMDb ID: …`.
pub async fn resolve_imdb(job: &JobCtx, imdb_id: &str) -> Result<i64> {
    let resolved = async {
        let found = find_for_scan(job, imdb_id, true).await?;
        if let Some(movie) = first_id(&found, "movie_results") {
            let verified = job
                .state
                .tmdb
                .raw_scan(&format!("/movie/{movie}"), &[], SCAN_TTL)
                .await?;
            return id_of(&verified);
        }
        if let Some(show) = first_id(&found, "tv_results") {
            return id_of(&tv_for_scan(job, show).await?);
        }
        Err(anyhow!(
            "No movie or show returned from API for ID {imdb_id}"
        ))
    };
    resolved
        .await
        .context("[TMDB] Failed to find media using external IMDb ID")
}

/// `getShowByTvdbIdForScan({ tvdbId })`.
///
/// # Errors
///
/// `[TMDB] Failed to get TV show using the external TVDB ID: …`.
pub async fn show_by_tvdb(job: &JobCtx, tvdb_id: i64) -> Result<Value> {
    let show = async {
        let found = find_for_scan(job, &tvdb_id.to_string(), false).await?;
        let Some(id) = first_id(&found, "tv_results") else {
            return Err(anyhow!("No show returned from API for ID {tvdb_id}"));
        };
        tv_for_scan(job, id).await
    };
    show.await
        .context("[TMDB] Failed to get TV show using the external TVDB ID")
}

/// `getByExternalIdForScan({ externalId: tvdbId, type: 'tvdb' })`'s first
/// show id.
///
/// # Errors
///
/// When TMDB can't be asked.
pub async fn tvdb_show_id(job: &JobCtx, tvdb_id: i64) -> Result<Option<i64>> {
    let found = find_for_scan(job, &tvdb_id.to_string(), false).await?;
    Ok(first_id(&found, "tv_results"))
}

/// Whether the show has the anime keyword.
#[must_use]
pub fn is_anime(show: &Value) -> bool {
    show.get("keywords")
        .map(|k| array_of(k, "results"))
        .unwrap_or_default()
        .iter()
        .any(|k| k.get("id").and_then(Value::as_i64) == Some(ANIME_KEYWORD_ID))
}

/// `getMetadataProvider(anime ? 'anime' : 'tv')` and, when that is TVDB,
/// `provider.getTvShow({ tvId: show.id })` (asked of Node); otherwise the
/// TMDB show as it is.
///
/// # Errors
///
/// When TVDB (through Node) fails.
pub async fn provider_show(job: &JobCtx, show: Value) -> Result<Value> {
    let anime = is_anime(&show);
    let settings = job
        .current_settings()
        .await
        .unwrap_or_else(|_| std::sync::Arc::clone(&job.settings));
    let key = if anime {
        "/metadataSettings/anime"
    } else {
        "/metadataSettings/tv"
    };
    if settings.str(key) != "tvdb" {
        return Ok(show);
    }
    let id = id_of(&show)?;
    let kind = if anime { "anime" } else { "tv" };
    let answer = internal_call(
        job,
        reqwest::Method::GET,
        &format!("/metadata/tv/{kind}/{id}"),
    )
    .await?;
    match answer.get("show") {
        Some(provided) if provided.is_object() => Ok(crate::tmdb::js_numbers(provided.clone())),
        _ => Ok(show),
    }
}

/// `getTvShow({ tmdbId, tvdbId })` of the Plex and Jellyfin scanners.
///
/// # Errors
///
/// When TMDB or the metadata provider fails.
pub async fn tv_show(job: &JobCtx, from_tmdb: Option<i64>, via_tvdb: Option<i64>) -> Result<Value> {
    let show = if let Some(id) = from_tmdb {
        tv_for_scan(job, id).await?
    } else if let Some(id) = via_tvdb {
        show_by_tvdb(job, id).await?
    } else {
        return Err(anyhow!("No ID provided"));
    };
    provider_show(job, show).await
}

/// One season of a show as the scanners read it: `(season_number,
/// episode_count)`.
#[must_use]
pub fn seasons_of(show: &Value, specials: bool) -> Vec<(i64, i64)> {
    array_of(show, "seasons")
        .iter()
        .filter_map(|s| {
            let number = s.get("season_number").and_then(Value::as_i64)?;
            let count = s.get("episode_count").and_then(Value::as_i64).unwrap_or(0);
            Some((number, count))
        })
        .filter(|(number, _)| specials || *number != 0)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn anime_and_seasons() {
        let show = json!({
            "keywords": { "results": [{ "id": 210_024 }] },
            "seasons": [
                { "season_number": 0, "episode_count": 2 },
                { "season_number": 1, "episode_count": 10 }
            ]
        });
        assert!(is_anime(&show), "anime keyword");
        assert!(!is_anime(&json!({})), "no keywords");
        assert_eq!(seasons_of(&show, false), vec![(1, 10)], "no specials");
        assert_eq!(seasons_of(&show, true).len(), 2, "with specials");
    }
}
