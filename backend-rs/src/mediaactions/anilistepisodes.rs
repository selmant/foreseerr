//! `anilistEpisodes.ts`: episode watched state as an `AniList` entry's
//! progress, placed by episode rules where the datasets state them and
//! by the season heuristics otherwise.

use serde_json::Value;

use super::anilist::{available, user_context, warm};
use super::anilistmapping::{
    episode_rules, pick_season_entry, season_candidates, season_entries, translate_bridged, Mode,
    SeasonMapping,
};
use super::anilistprogress::{
    absolute_episode, next_progress, progress_for_episode, watched_for_season,
    watched_from_progress, SeasonCount,
};
use super::dispatcher::Thrown;
use super::env::Env;
use super::types::EpisodeWrite;
use crate::anilist::actions::{self, Save};
use crate::anilist::Anilist;
use crate::mappinglayer::synccache::{self, AnilistEntry, AnilistPatch};
use crate::mappinglayer::{IdRef, MediaType};

fn db_error(e: &anyhow::Error) -> Thrown {
    format!("{e:#}")
}

/// `seasonsFromTmdb(await new TheMovieDb().getTvShow({ tvId }))`.
async fn tmdb_seasons(env: &Env<'_>, tmdb_id: i64) -> Result<Vec<SeasonCount>, Thrown> {
    let ctx = env.ctx();
    let show = ctx
        .tmdb
        .tv(tmdb_id, &ctx.locale)
        .await
        .map_err(|e| db_error(&e))?;
    let int = |v: Option<&Value>| {
        v.and_then(Value::as_f64)
            .and_then(crate::mappinglayer::int_of)
    };
    Ok(show
        .get("seasons")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|s| {
            Some(SeasonCount {
                season: int(s.get("season_number"))?,
                episodes: int(s.get("episode_count")).unwrap_or(0),
            })
        })
        .collect())
}

/// `progressFromRules(tmdbShowId, seasonNumber, episodeNumber)`:
/// `(anilistId, progress)`.
async fn progress_from_rules(
    env: &Env<'_>,
    tmdb_id: i64,
    season: i64,
    episode: i64,
) -> Result<Option<(i64, i64)>, Thrown> {
    let db = &env.state.db;
    crate::mappinglayer::ensure(db)
        .await
        .map_err(|e| db_error(&e))?;
    let from = IdRef {
        season: Some(season),
        ..IdRef::new("tmdb_show", &tmdb_id.to_string())
    };
    let translated = translate_bridged(db, &from, episode, "anilist", &["anidb", "mal"])
        .await
        .map_err(|e| db_error(&e))?;
    let Some(translated) = translated else {
        return Ok(None);
    };
    let id = crate::jsval::number_of_str(&translated.target.id);
    if id.is_nan() || id <= 0.0 || translated.episode < 1 {
        return Ok(None);
    }
    Ok(crate::mappinglayer::int_of(id).map(|id| (id, translated.episode)))
}

/// `hasEpisodeRules(tmdbShowId, seasonNumber)`.
async fn has_episode_rules(env: &Env<'_>, tmdb_id: i64, season: i64) -> Result<bool, Thrown> {
    let from = IdRef {
        season: Some(season),
        ..IdRef::new("tmdb_show", &tmdb_id.to_string())
    };
    for namespace in ["anilist", "anidb", "mal"] {
        if !episode_rules(&env.state.db, &from, namespace)
            .await
            .map_err(|e| db_error(&e))?
            .is_empty()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `seasonEntries(tmdbShowId)`.
async fn entries_of(env: &Env<'_>, tmdb_id: i64) -> Result<Vec<SeasonMapping>, Thrown> {
    crate::mappinglayer::ensure(&env.state.db)
        .await
        .map_err(|e| db_error(&e))?;
    season_entries(&env.state.db, tmdb_id)
        .await
        .map_err(|e| db_error(&e))
}

fn progress_of(entry: Option<&AnilistEntry>) -> f64 {
    entry.and_then(|e| e.progress).unwrap_or(0.0)
}

/// The body of `getSeasonStatus`'s `try`.
async fn season_status_inner(
    env: &Env<'_>,
    tmdb_id: i64,
    season: i64,
) -> Result<(bool, Vec<f64>), Thrown> {
    // Ranges answer per episode, so they come before the season
    // heuristics decide there is nothing to show.
    let candidates = if has_episode_rules(env, tmdb_id, season).await? {
        None
    } else {
        Some(season_candidates(&entries_of(env, tmdb_id).await?, season))
    };
    if candidates.as_ref().is_some_and(|c| c.entries.is_empty()) {
        return Ok((false, Vec::new()));
    }
    let (client, account) = user_context(env).await?;
    let snapshot = warm(env, &client, account).await?;
    let Some(candidates) = candidates else {
        let seasons = tmdb_seasons(env, tmdb_id).await?;
        let count = seasons
            .iter()
            .find(|s| s.season == season)
            .map_or(0, |s| s.episodes);
        let mut watched = Vec::new();
        for episode in 1..=count {
            let Some((anilist_id, progress)) =
                progress_from_rules(env, tmdb_id, season, episode).await?
            else {
                continue;
            };
            let entry = synccache::lookup_anilist_id(&snapshot, anilist_id);
            if progress_of(entry) >= crate::jsnum::from_i64(progress) {
                watched.push(crate::jsnum::from_i64(episode));
            }
        }
        return Ok((true, watched));
    };
    if candidates.mode == Mode::Absolute {
        let Some(mapping) = candidates.entries.first() else {
            return Ok((true, Vec::new()));
        };
        let entry = synccache::lookup_anilist_id(&snapshot, mapping.anilist_id);
        let progress = progress_of(entry);
        if progress <= 0.0 {
            return Ok((true, Vec::new()));
        }
        let seasons = tmdb_seasons(env, tmdb_id).await?;
        return Ok((
            true,
            watched_for_season(
                &seasons,
                season,
                progress,
                entry.and_then(|e| e.episode_count),
            ),
        ));
    }
    let seasons = tmdb_seasons(env, tmdb_id).await?;
    let count = seasons
        .iter()
        .find(|s| s.season == season)
        .map(|s| crate::jsnum::from_i64(s.episodes));
    let mut watched: Vec<f64> = Vec::new();
    for mapping in &candidates.entries {
        let progress = progress_of(synccache::lookup_anilist_id(&snapshot, mapping.anilist_id));
        if progress <= 0.0 {
            continue;
        }
        let offset = crate::jsnum::from_i64(mapping.offset(candidates.catalog));
        for episode in watched_from_progress(progress, count.unwrap_or(progress), offset) {
            if !watched.contains(&episode) {
                watched.push(episode);
            }
        }
    }
    watched.sort_by(f64::total_cmp);
    Ok((true, watched))
}

/// `anilistEpisodeActions.getSeasonStatus`: any failure past the
/// availability check reads as unavailable.
///
/// # Errors
///
/// What the availability check throws.
pub async fn season_status(
    env: &Env<'_>,
    tmdb_id: i64,
    season: i64,
) -> Result<(bool, Vec<f64>), Thrown> {
    if !available(env).await? {
        return Ok((false, Vec::new()));
    }
    Ok(season_status_inner(env, tmdb_id, season)
        .await
        .unwrap_or((false, Vec::new())))
}

/// `anilistEpisodeActions.setWatched`.
///
/// # Errors
///
/// `AniList`, TMDB and database failures.
pub async fn set_watched(
    env: &Env<'_>,
    tmdb_id: i64,
    season: i64,
    episode: i64,
    watched: bool,
) -> Result<EpisodeWrite, Thrown> {
    if !available(env).await? || season < 1 || episode < 1 {
        return Ok(EpisodeWrite::Skipped);
    }
    let from_rules = progress_from_rules(env, tmdb_id, season, episode).await?;
    let entries = entries_of(env, tmdb_id).await?;
    let picked = match from_rules {
        Some((anilist_id, progress)) => Some((anilist_id, progress, Mode::InSeason)),
        None => {
            pick_season_entry(&entries, season, episode).map(|(m, p, mode)| (m.anilist_id, p, mode))
        }
    };
    let Some((anilist_id, progress, mode)) = picked else {
        return Ok(EpisodeWrite::Skipped);
    };
    let (client, account) = user_context(env).await?;
    let snapshot = warm(env, &client, account).await?;
    let current = synccache::lookup_anilist_id(&snapshot, anilist_id).cloned();
    let mut episode_count = current.as_ref().and_then(|c| c.episode_count);
    if episode_count.is_none() {
        let media = actions::media(&client, anilist_id)
            .await
            .map_err(|e| e.message())?;
        episode_count = media
            .as_ref()
            .and_then(|m| m.get("episodes"))
            .filter(|e| !e.is_null())
            .map(|e| crate::jsval::number_of(Some(e)));
    }
    let mut target = progress;
    if mode == Mode::Absolute {
        let seasons = tmdb_seasons(env, tmdb_id).await?;
        let Some(absolute) = absolute_episode(&seasons, season, episode) else {
            return Ok(EpisodeWrite::Skipped);
        };
        let Some(mapped) = progress_for_episode(absolute, episode_count, episode) else {
            return Ok(EpisodeWrite::Skipped);
        };
        target = mapped;
    } else if episode_count.is_some_and(|c| c > 0.0 && crate::jsnum::from_i64(target) > c) {
        return Ok(EpisodeWrite::Skipped);
    }
    write_progress(
        env,
        &client,
        Progress {
            tmdb_id,
            anilist_id,
            current,
            episode_count,
            target: crate::jsnum::from_i64(target),
            watched,
        },
    )
    .await
}

/// `writeProgress`'s options.
#[derive(Debug)]
struct Progress {
    tmdb_id: i64,
    anilist_id: i64,
    current: Option<AnilistEntry>,
    episode_count: Option<f64>,
    target: f64,
    watched: bool,
}

/// `writeProgress(options)`.
async fn write_progress(
    env: &Env<'_>,
    client: &Anilist,
    p: Progress,
) -> Result<EpisodeWrite, Thrown> {
    let Some(next) = next_progress(progress_of(p.current.as_ref()), p.target, p.watched) else {
        return Ok(if p.watched {
            EpisodeWrite::Done(true)
        } else {
            EpisodeWrite::Skipped
        });
    };
    let entry_id = p.current.as_ref().and_then(|c| c.list_entry_id);
    if next <= 0.0 && entry_id.is_none_or(|id| id == 0) {
        return Ok(EpisodeWrite::Skipped);
    }
    let completed = p.episode_count.is_some_and(|c| c > 0.0 && next >= c);
    let status = if next <= 0.0 {
        "PLANNING"
    } else if completed {
        "COMPLETED"
    } else {
        "CURRENT"
    };
    let progress = next.max(0.0);
    let save = Save {
        media_id: p.anilist_id,
        status: Some(status),
        score_raw: None,
        progress: Some(progress),
    };
    let saved = actions::save_media_list_entry(client, &save)
        .await
        .map_err(|e| e.message())?;
    let saved_id = saved
        .as_ref()
        .and_then(|s| s.get("id"))
        .filter(|id| !id.is_null())
        .and_then(Value::as_i64);
    synccache::patch_anilist(
        env.user,
        MediaType::Tv,
        p.tmdb_id,
        AnilistPatch {
            watched: Some(completed),
            status: Some(Some(String::from(status))),
            progress: Some(Some(progress)),
            episode_count: Some(p.episode_count),
            anilist_id: Some(p.anilist_id),
            list_entry_id: Some(saved_id.or(entry_id)),
            ..AnilistPatch::default()
        },
    );
    Ok(EpisodeWrite::Done(true))
}
