//! `server/api/animelist.ts`: the `AniDB` lookups the library scanners
//! make, served from the mapping datasets.

use anyhow::Result;

use super::edges::{self, apply_episode_rule};
use super::resolve::{self, Request};
use super::{Ctx, IdRef, MediaType};
use crate::jobs::scanbase::AnidbItem;

/// `animeList.sync()`.
///
/// # Errors
///
/// Fails when the dataset rows can't be loaded.
pub async fn sync(ctx: &Ctx<'_>) -> Result<()> {
    super::ensure(ctx.db).await
}

/// `animeList.getFromAnidbId(anidbId)`.
///
/// # Errors
///
/// Fails on database errors.
pub async fn from_anidb(ctx: &Ctx<'_>, anidb_id: i64) -> Result<Option<AnidbItem>> {
    super::ensure(ctx.db).await?;
    let found = edges::edges_for(ctx.db, &IdRef::new("anidb", &anidb_id.to_string())).await?;
    if found.is_empty() {
        return Ok(None);
    }
    let tvdb_target = edges::targets_in(&found, "tvdb_show").into_iter().next();
    let tmdb_target = edges::targets_in(&found, "tmdb_show")
        .into_iter()
        .chain(edges::targets_in(&found, "tmdb_movie"))
        .next();
    let imdb = edges::targets_in(&found, "imdb").into_iter().next();
    let item = AnidbItem {
        tvdb_id: tvdb_target.as_ref().and_then(|t| edges::js_int(&t.id)),
        tvdb_season: tvdb_target.as_ref().and_then(|t| t.season),
        tmdb_id: tmdb_target.as_ref().and_then(|t| edges::js_int(&t.id)),
        imdb_id: imdb.map(|t| t.id),
    };
    let any = tvdb_target.is_some() || tmdb_target.is_some() || item.imdb_id.is_some();
    Ok(any.then_some(item))
}

/// `animeList.getSpecialEpisode(tvdbId, episode)`: what a TVDB specials
/// episode is (often a film with its own TMDB entry).
///
/// # Errors
///
/// Fails on database errors.
pub async fn special_episode(
    ctx: &Ctx<'_>,
    tvdb_id: i64,
    episode: i64,
) -> Result<Option<AnidbItem>> {
    super::ensure(ctx.db).await?;
    let from = IdRef {
        season: Some(0),
        ..IdRef::new("tvdb_show", &tvdb_id.to_string())
    };
    let covers = |rules: Vec<(edges::RangeRule, String)>| {
        rules
            .into_iter()
            .find(|(rule, _)| apply_episode_rule(rule, episode).is_some())
            .map(|(_, id)| id)
    };
    let movie = covers(edges::find_episode_rules(ctx.db, &from, "tmdb_movie").await?);
    if let Some(movie) = movie.filter(|id| !id.is_empty()) {
        return Ok(Some(AnidbItem {
            tmdb_id: edges::js_int(&movie),
            ..AnidbItem::default()
        }));
    }
    let Some(imdb_id) =
        covers(edges::find_episode_rules(ctx.db, &from, "imdb").await?).filter(|id| !id.is_empty())
    else {
        return Ok(None);
    };
    let resolution = resolve::resolve_tmdb(
        ctx,
        Request {
            refs: vec![IdRef::new("imdb", &imdb_id)],
            media_type: Some(MediaType::Movie),
            offline: true,
            ..Request::default()
        },
    )
    .await?;
    Ok(Some(AnidbItem {
        imdb_id: Some(imdb_id),
        tmdb_id: resolution.map(|r| r.tmdb_id),
        ..AnidbItem::default()
    }))
}
