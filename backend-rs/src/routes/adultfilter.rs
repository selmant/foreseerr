//! The per-user adult content switch (`user_settings.showAdultContent`).
//!
//! Off (the default) keeps Seerr's behaviour: TMDB discover and search ask
//! for `include_adult=false`, and person credits drop adult titles. Off
//! also drops adult titles from TMDB recommendations and from the provider
//! rows (Trakt, `MDBList`, `AniList`, Simkl, the Plex watchlist), which
//! list whatever their source holds. AI picks follow it too (in
//! `ai::recs`, and saved picks when served). On lets adult titles through
//! everywhere.

use serde_json::Value;

use super::Ready;
use crate::concurrency::{map_with_concurrency, PROVIDER_ROW_CONCURRENCY};

/// The tile key `AniList` rows carry for `media.isAdult`; dropped from
/// what is served.
pub(super) const ANILIST_ADULT_KEY: &str = "isAdult";

/// Whether the signed-in user (if any) chose to see adult titles.
pub(super) fn shows_adult(ctx: &Ready<'_>) -> bool {
    ctx.user.as_ref().is_some_and(|u| u.show_adult)
}

/// TMDB's `include_adult` value for this request.
pub(super) fn include_adult(ctx: &Ready<'_>) -> &'static str {
    if shows_adult(ctx) {
        "true"
    } else {
        "false"
    }
}

/// A TMDB result (or mapped tile) flagged `adult: true`.
pub(super) fn is_adult(item: &Value) -> bool {
    item.get("adult").and_then(Value::as_bool) == Some(true)
}

/// TMDB results without the adult ones, unless the user shows them.
pub(super) fn drop_adult_results(ctx: &Ready<'_>, results: Vec<Value>) -> Vec<Value> {
    if shows_adult(ctx) {
        return results;
    }
    results.into_iter().filter(|r| !is_adult(r)).collect()
}

/// Provider tiles without adult titles, unless the user shows them.
///
/// A tile goes when its source flags it (`AniList`'s `isAdult`) or when
/// the TMDB record it maps to is adult. The TMDB records come from the
/// same half-day cache the mapping probe fills, so a page served before
/// costs nothing; a lookup that fails keeps the tile.
pub(super) async fn drop_adult_tiles(ctx: &Ready<'_>, tiles: Vec<Value>) -> Vec<Value> {
    let tiles: Vec<(Value, bool)> = tiles.into_iter().map(strip_source_flag).collect();
    if shows_adult(ctx) {
        return tiles.into_iter().map(|(tile, _)| tile).collect();
    }
    let language = super::movie::languages(ctx, None, None).0;
    let language = language.as_str();
    let tmdb = &ctx.state.tmdb;
    let kept = map_with_concurrency(
        tiles,
        PROVIDER_ROW_CONCURRENCY,
        |(tile, source_adult)| async move {
            if source_adult {
                return None;
            }
            let Some((kind, id)) = tmdb_ref(&tile) else {
                return Some(tile);
            };
            match tmdb.title_summary(kind, id, language).await {
                Ok(record) if is_adult(&record) => None,
                Ok(_) => Some(tile),
                Err(e) => {
                    tracing::debug!("adult check for {kind} {id} failed: {e:#}");
                    Some(tile)
                }
            }
        },
    )
    .await;
    kept.into_iter().flatten().collect()
}

/// The tile without its source adult flag, and whether that flag was set.
fn strip_source_flag(mut tile: Value) -> (Value, bool) {
    let adult = tile
        .as_object_mut()
        .and_then(|map| map.remove(ANILIST_ADULT_KEY))
        .and_then(|v| v.as_bool())
        == Some(true);
    (tile, adult)
}

/// The TMDB record a tile maps to.
fn tmdb_ref(tile: &Value) -> Option<(&'static str, i64)> {
    let id = tile
        .get("tmdbId")
        .and_then(Value::as_i64)
        .filter(|id| *id > 0)?;
    match tile.get("mediaType").and_then(Value::as_str) {
        Some("movie") => Some(("movie", id)),
        Some("tv") => Some(("tv", id)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn adult_flags() {
        assert!(is_adult(&json!({"adult": true})));
        assert!(!is_adult(&json!({"adult": false})));
        assert!(!is_adult(&json!({})));
        let (tile, adult) = strip_source_flag(json!({"tmdbId": 1, "isAdult": true}));
        assert!(adult);
        assert_eq!(tile, json!({"tmdbId": 1}), "the source flag is not served");
        let (_, adult) = strip_source_flag(json!({"tmdbId": 1, "isAdult": false}));
        assert!(!adult);
        assert_eq!(
            tmdb_ref(&json!({"tmdbId": 5, "mediaType": "tv"})),
            Some(("tv", 5))
        );
        assert_eq!(tmdb_ref(&json!({"tmdbId": 0, "mediaType": "tv"})), None);
        assert_eq!(tmdb_ref(&json!({"tmdbId": 5})), None);
    }
}
