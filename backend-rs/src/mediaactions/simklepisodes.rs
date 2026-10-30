//! `simklEpisodes.ts`: episode history on Simkl, written in the
//! numbering Simkl indexes (TVDB's, where a rule translates it) and read
//! back into TMDB's.

use std::collections::HashSet;

use serde_json::{Map, Value};

use super::anilistmapping::{episode_rules, translate_bridged};
use super::dispatcher::Thrown;
use super::env::Env;
use super::simkl::{available, sync, user_client};
use super::types::EpisodeWrite;
use crate::mappinglayer::edges::apply_episode_rule;
use crate::mappinglayer::IdRef;

fn db_error(e: &anyhow::Error) -> Thrown {
    format!("{e:#}")
}

/// `SimklCoordinates`: the ids (in insertion order) and numbering.
#[derive(Debug, Clone, PartialEq)]
struct Coordinates {
    ids: Vec<(&'static str, f64)>,
    season: i64,
    episode: i64,
}

/// `simklCoordinates(tmdbId, seasonNumber, episodeNumber)`.
async fn coordinates(
    env: &Env<'_>,
    tmdb_id: i64,
    season: i64,
    episode: i64,
) -> Result<Coordinates, Thrown> {
    let db = &env.state.db;
    crate::mappinglayer::ensure(db)
        .await
        .map_err(|e| db_error(&e))?;
    let from = IdRef {
        season: Some(season),
        ..IdRef::new("tmdb_show", &tmdb_id.to_string())
    };
    let tvdb = translate_bridged(db, &from, episode, "tvdb_show", &["anidb"])
        .await
        .map_err(|e| db_error(&e))?;
    let anidb = translate_bridged(db, &from, episode, "anidb", &[])
        .await
        .map_err(|e| db_error(&e))?;
    let mut ids = vec![("tmdb", crate::jsnum::from_i64(tmdb_id))];
    for (key, found) in [("tvdb", &tvdb), ("anidb", &anidb)] {
        if let Some(found) = found.as_ref().filter(|t| !t.target.id.is_empty()) {
            let n = crate::jsval::number_of_str(&found.target.id);
            if n != 0.0 && !n.is_nan() {
                ids.push((key, n));
            }
        }
    }
    Ok(match tvdb {
        Some(t) => Coordinates {
            ids,
            season: t.season,
            episode: t.episode,
        },
        None => Coordinates {
            ids,
            season,
            episode,
        },
    })
}

/// `setEpisodeHistory(ids, season, episode, watched)`'s body.
fn history_body(c: &Coordinates) -> Value {
    let mut ids = Map::new();
    for (key, value) in &c.ids {
        ids.insert((*key).to_owned(), crate::jsval::num(*value));
    }
    serde_json::json!({
        "shows": [{
            "ids": Value::Object(ids),
            "seasons": [{ "number": c.season, "episodes": [{ "number": c.episode }] }]
        }]
    })
}

/// `cachedWatchedCoordinates(userId, tmdbId)`: every watched `(season,
/// episode)` Simkl reports for the show, in Simkl's own numbering, from
/// the synced library rather than a fresh download.
///
/// # Errors
///
/// Database failures.
pub async fn cached_watched_coordinates(
    db: &crate::db::Db,
    user_id: i64,
    tmdb_id: i64,
) -> anyhow::Result<Vec<(i64, i64)>> {
    let rows = db
        .rows(
            r#"SELECT "watchedEpisodes" FROM "simkl_sync_item"
               WHERE "userId" = ?1 AND "tmdbId" = ?2 AND "simklType" IN ('show', 'anime')"#,
            &[crate::db::Bind::Int(user_id), crate::db::Bind::Int(tmdb_id)],
        )
        .await?;
    let int = |v: Option<&Value>| {
        v.and_then(Value::as_f64)
            .and_then(crate::mappinglayer::int_of)
    };
    let mut out = Vec::new();
    for row in rows {
        let text = row
            .get("watchedEpisodes")
            .and_then(Value::as_str)
            .unwrap_or("[]");
        let Ok(Value::Array(pairs)) = serde_json::from_str::<Value>(text) else {
            continue;
        };
        for pair in pairs.iter().filter_map(Value::as_array) {
            if let (Some(season), Some(episode)) = (int(pair.first()), int(pair.get(1))) {
                out.push((season, episode));
            }
        }
    }
    Ok(out)
}

/// `tmdbEpisodeNumbers(tmdbId, seasonNumber, coordinates)`.
async fn tmdb_episode_numbers(
    env: &Env<'_>,
    tmdb_id: i64,
    season: i64,
    coordinates: &[(i64, i64)],
) -> Result<Vec<i64>, Thrown> {
    if coordinates.is_empty() {
        return Ok(Vec::new());
    }
    let from = IdRef {
        season: Some(season),
        ..IdRef::new("tmdb_show", &tmdb_id.to_string())
    };
    let rules = episode_rules(&env.state.db, &from, "tvdb_show")
        .await
        .map_err(|e| db_error(&e))?;
    if rules.is_empty() {
        let mut direct: Vec<i64> = coordinates
            .iter()
            .filter(|(s, _)| *s == season)
            .map(|(_, e)| *e)
            .collect::<HashSet<i64>>()
            .into_iter()
            .collect();
        direct.sort_unstable();
        return Ok(direct);
    }
    let by_simkl: HashSet<(i64, i64)> = coordinates.iter().copied().collect();
    let mut watched = HashSet::new();
    for (rule, target) in &rules {
        let start = rule.source.start;
        let end = rule.source.end.unwrap_or(start + 500);
        for episode in start..=end {
            let Some(mapped) = apply_episode_rule(rule, episode) else {
                continue;
            };
            let in_season = target.season.unwrap_or(season);
            if by_simkl.contains(&(in_season, mapped)) {
                watched.insert(episode);
            }
        }
    }
    let mut out: Vec<i64> = watched.into_iter().collect();
    out.sort_unstable();
    Ok(out)
}

/// `simklEpisodeActions.getSeasonStatus`.
///
/// # Errors
///
/// Simkl and database failures.
pub async fn season_status(
    env: &Env<'_>,
    tmdb_id: i64,
    season: i64,
) -> Result<(bool, Vec<f64>), Thrown> {
    if !available(env).await? {
        return Ok((false, Vec::new()));
    }
    // Activities first; the library delta carries each show's episodes.
    sync(env, false).await?;
    let coordinates = cached_watched_coordinates(&env.state.db, env.user, tmdb_id)
        .await
        .map_err(|e| db_error(&e))?;
    let numbers = tmdb_episode_numbers(env, tmdb_id, season, &coordinates).await?;
    Ok((
        true,
        numbers.into_iter().map(crate::jsnum::from_i64).collect(),
    ))
}

/// `simklEpisodeActions.setWatched`.
///
/// # Errors
///
/// Simkl and database failures.
pub async fn set_watched(
    env: &Env<'_>,
    tmdb_id: i64,
    season: i64,
    episode: i64,
    watched: bool,
) -> Result<EpisodeWrite, Thrown> {
    if !available(env).await? || season < 0 || episode < 1 {
        return Ok(EpisodeWrite::Done(false));
    }
    let coordinates = coordinates(env, tmdb_id, season, episode).await?;
    let client = user_client(env).await?;
    let path = if watched {
        "/sync/history"
    } else {
        "/sync/history/remove"
    };
    client
        .request(env, path, Some(&history_body(&coordinates)))
        .await?;
    sync(env, true).await?;
    Ok(EpisodeWrite::Done(true))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn history_body_ids_in_order() {
        let body = history_body(&Coordinates {
            ids: vec![("tmdb", 42.0), ("tvdb", 7.0)],
            season: 2,
            episode: 1,
        });
        assert_eq!(
            body,
            json!({"shows": [{"ids": {"tmdb": 42, "tvdb": 7}, "seasons": [{"number": 2, "episodes": [{"number": 1}]}]}]}),
            "body"
        );
    }
}
