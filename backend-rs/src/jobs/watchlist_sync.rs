//! `plex-watchlist-sync`: `server/lib/watchlistsync.ts`.
//!
//! For every user with a Plex token, auto-request permissions and watchlist
//! sync turned on, the first page of their Plex watchlist is requested
//! (`MediaRequest.request(..., { isAutoRequest: true })`, through
//! `routes::autorequest`) unless the title is already available, requested
//! by an earlier sync, or blocklisted.

use std::sync::Arc;

use anyhow::Result;
use serde_json::{Map, Value};

use super::syncutil::{boolean, int, text};
use super::JobCtx;
use crate::db::Bind;
use crate::plexwatchlist::Item;
use crate::routes::autorequest::{self, AutoRequest};

/// `Permission` bits.
const ADMIN: i64 = 2;
const AUTO_REQUEST: i64 = 8_388_608;
const AUTO_REQUEST_MOVIE: i64 = 16_777_216;
const AUTO_REQUEST_TV: i64 = 33_554_432;
/// `MediaStatus`.
const UNKNOWN: i64 = 1;
const AVAILABLE: i64 = 5;
const BLOCKLISTED: i64 = 6;
const DELETED: i64 = 7;

/// `user.hasPermission(bits, { type: 'or' })`.
const fn has_any(permissions: i64, bits: i64) -> bool {
    permissions & ADMIN != 0 || permissions & bits != 0
}

/// A whole TMDB/TVDB id as JavaScript compares it (`NaN` matches nothing).
fn whole(n: f64) -> Option<i64> {
    (n.is_finite() && n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0)
        .then(|| format!("{n:.0}").parse().ok())
        .flatten()
}

/// `'tv'` for Plex shows, `'movie'` otherwise.
fn media_type(item: &Item) -> &'static str {
    if item.kind.as_ref().and_then(Value::as_str) == Some("show") {
        "tv"
    } else {
        "movie"
    }
}

/// `watchlistSync.syncWatchlist()`.
///
/// # Errors
///
/// Database errors, which end the run as an exception ends Node's.
pub async fn run(job: &JobCtx) -> Result<()> {
    let users = job
        .state
        .db
        .rows(
            r#"SELECT CAST("u"."id" AS BIGINT) AS "id", "u"."plexToken" AS "plexToken", CAST("u"."permissions" AS BIGINT) AS "permissions", "s"."watchlistSyncMovies" AS "movies", "s"."watchlistSyncTv" AS "tv" FROM "user" "u" LEFT JOIN "user_settings" "s" ON "s"."userId" = "u"."id" WHERE "u"."plexToken" != '' ORDER BY "u"."id" ASC"#,
            &[],
        )
        .await?;
    for user in &users {
        if job.cancelled() {
            break;
        }
        sync_user(job, user).await?;
    }
    Ok(())
}

/// `syncUserWatchlist(user)`.
async fn sync_user(job: &JobCtx, user: &Map<String, Value>) -> Result<()> {
    let Some(token) = text(user, "plexToken").filter(|t| !t.is_empty()) else {
        return Ok(());
    };
    let user_id = int(user, "id").unwrap_or(0);
    let permissions = int(user, "permissions").unwrap_or(0);
    if !has_any(
        permissions,
        AUTO_REQUEST | AUTO_REQUEST_MOVIE | AUTO_REQUEST_TV,
    ) {
        return Ok(());
    }
    let (movies, tv) = (boolean(user, "movies"), boolean(user, "tv"));
    if !movies && !tv {
        return Ok(());
    }
    let page = match crate::plexwatchlist::watchlist(&job.state.outbound, &token, 0.0).await {
        Ok(page) => page,
        Err(why) => {
            tracing::warn!(
                label = "Plex Watchlist Sync",
                user_id,
                "Skipping a watchlist Node would read differently: {}",
                why.0
            );
            return Ok(());
        }
    };
    let ids: Vec<i64> = page.items.iter().filter_map(|i| whole(i.tmdb_id)).collect();
    let known = related_media(job, &ids).await;
    let auto_requested = auto_requested(job, user_id, &ids).await?;
    for item in &page.items {
        let kind = media_type(item);
        let tmdb = whole(item.tmdb_id);
        if tmdb.is_some_and(|t| auto_requested.contains(&(kind.to_owned(), t))) {
            continue;
        }
        let covered = known.iter().any(|(t, k, status)| {
            Some(*t) == tmdb
                && k == kind
                && (*status == BLOCKLISTED
                    || (kind == "movie" && *status != UNKNOWN && *status != DELETED)
                    || (kind == "tv" && *status == AVAILABLE))
        });
        if covered {
            continue;
        }
        request_item(job, user_id, permissions, (movies, tv), item).await?;
    }
    Ok(())
}

/// One watchlist item's request.
async fn request_item(
    job: &JobCtx,
    user_id: i64,
    permissions: i64,
    (movies, tv): (bool, bool),
    item: &Item,
) -> Result<()> {
    let title = item
        .title
        .as_ref()
        .map(|t| crate::media::js_string(Some(t)).into_owned())
        .unwrap_or_default();
    let show = item.kind.as_ref().and_then(Value::as_str) == Some("show");
    let tvdb = item.tvdb_id.filter(|t| *t != 0.0 && !t.is_nan());
    if show && tvdb.is_none() {
        tracing::error!(
            label = "Watchlist Sync",
            user_id,
            media_title = %title,
            error_message = "Missing TVDB ID from Plex Metadata",
            "Failed to create media request from watchlist"
        );
        return Ok(());
    }
    let is_movie = item.kind.as_ref().and_then(Value::as_str) == Some("movie");
    if ((!has_any(permissions, AUTO_REQUEST | AUTO_REQUEST_MOVIE) || !movies) && is_movie)
        || ((!has_any(permissions, AUTO_REQUEST | AUTO_REQUEST_TV) || !tv) && show)
    {
        return Ok(());
    }
    let mut body = Map::new();
    body.insert(
        String::from("mediaId"),
        whole(item.tmdb_id).map_or(Value::Null, Value::from),
    );
    body.insert(String::from("mediaType"), Value::from(media_type(item)));
    if show {
        body.insert(String::from("seasons"), Value::from("all"));
    }
    if let Some(tvdb) = item.tvdb_id.and_then(whole) {
        body.insert(String::from("tvdbId"), Value::from(tvdb));
    }
    body.insert(String::from("is4k"), Value::Bool(false));
    let settings = job.current_settings().await?;
    let outcome = autorequest::create(
        Arc::clone(&job.state),
        settings,
        user_id,
        Value::Object(body),
    )
    .await?;
    match outcome {
        AutoRequest::Created => tracing::info!(
            label = "Watchlist Sync",
            user_id,
            media_title = %title,
            "Created media request from user's Plex Watchlist"
        ),
        AutoRequest::Refused {
            status: 403,
            message,
        } if message == "This media is blocklisted." => {}
        AutoRequest::Refused {
            status: 202 | 403 | 409,
            message,
        } => tracing::debug!(
            label = "Watchlist Sync",
            user_id,
            media_title = %title,
            error_message = %message,
            "Failed to create media request from watchlist"
        ),
        AutoRequest::Refused { message, .. } => tracing::error!(
            label = "Watchlist Sync",
            user_id,
            media_title = %title,
            error_message = %message,
            "Failed to create media request from watchlist"
        ),
        AutoRequest::Unported(why) => tracing::warn!(
            label = "Watchlist Sync",
            user_id,
            media_title = %title,
            "Skipped a watchlist request: {why}"
        ),
    }
    Ok(())
}

/// `Media.getRelatedMedia(user, items)`: `(tmdbId, mediaType, status)` of
/// the stored titles; nothing when the lookup fails (Node logs and goes
/// on).
async fn related_media(job: &JobCtx, ids: &[i64]) -> Vec<(i64, String, i64)> {
    if ids.is_empty() {
        return Vec::new();
    }
    let list = ids
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    let rows = job
        .state
        .db
        .rows(
            &format!(
                r#"SELECT CAST("tmdbId" AS BIGINT) AS "tmdbId", "mediaType", CAST("status" AS BIGINT) AS "status" FROM "media" WHERE "tmdbId" IN ({list})"#
            ),
            &[],
        )
        .await;
    match rows {
        Ok(rows) => rows
            .iter()
            .filter_map(|r| Some((int(r, "tmdbId")?, text(r, "mediaType")?, int(r, "status")?)))
            .collect(),
        Err(e) => {
            tracing::error!("Something went wrong loading related media: {e:#}");
            Vec::new()
        }
    }
}

/// The `mediaType:tmdbId` of the user's earlier auto-requests whose title
/// isn't deleted.
async fn auto_requested(job: &JobCtx, user_id: i64, ids: &[i64]) -> Result<Vec<(String, i64)>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let list = ids
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    let rows = job
        .state
        .db
        .rows(
            &format!(
                r#"SELECT "m"."mediaType" AS "mediaType", CAST("m"."tmdbId" AS BIGINT) AS "tmdbId", CAST("m"."status" AS BIGINT) AS "status" FROM "media_request" "r" LEFT JOIN "media" "m" ON "m"."id" = "r"."mediaId" WHERE "r"."requestedById" = ?1 AND "r"."isAutoRequest" = ?2 AND "m"."tmdbId" IN ({list})"#
            ),
            &[Bind::Int(user_id), Bind::Bool(true)],
        )
        .await?;
    Ok(rows
        .iter()
        .filter(|r| int(r, "status") != Some(DELETED))
        .filter_map(|r| Some((text(r, "mediaType")?, int(r, "tmdbId")?)))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ids_compare_like_numbers() {
        assert_eq!(whole(603.0), Some(603), "whole");
        assert_eq!(whole(f64::NAN), None, "NaN matches nothing");
        assert_eq!(whole(1.5), None, "fractions");
    }

    #[test]
    fn plex_types() {
        let item = |kind: &str| Item {
            rating_key: None,
            tmdb_id: 1.0,
            tvdb_id: None,
            title: None,
            kind: Some(json!(kind)),
        };
        assert_eq!(media_type(&item("show")), "tv", "shows");
        assert_eq!(media_type(&item("movie")), "movie", "movies");
        assert_eq!(media_type(&item("episode")), "movie", "anything else");
    }

    #[test]
    fn permissions() {
        assert!(has_any(ADMIN, AUTO_REQUEST), "admins");
        assert!(
            has_any(AUTO_REQUEST_TV, AUTO_REQUEST | AUTO_REQUEST_TV),
            "any bit"
        );
        assert!(!has_any(0, AUTO_REQUEST), "none");
    }
}
