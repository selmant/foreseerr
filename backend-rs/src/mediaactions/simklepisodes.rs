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

/// `watchedCoordinates(payload, tmdbId)`: every watched `(season,
/// episode)` Simkl reports for the show.
#[must_use]
pub fn watched_coordinates(payload: &Value, tmdb_id: i64) -> Vec<(i64, i64)> {
    let values: Vec<&Value> = match payload {
        Value::Object(map) => map.values().collect(),
        Value::Array(items) => items.iter().collect(),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => return Vec::new(),
    };
    let show = values
        .into_iter()
        .filter_map(Value::as_array)
        .flatten()
        .find(|v| {
            v.is_object()
                && crate::jsval::same(
                    crate::jsval::number_of(v.get("ids").and_then(|i| i.get("tmdb"))),
                    crate::jsnum::from_i64(tmdb_id),
                )
        });
    let int = |v: Option<&Value>| {
        let n = crate::jsval::number_of(v);
        crate::mappinglayer::int_of(n)
    };
    let mut out = Vec::new();
    for season in show
        .and_then(|s| s.get("seasons"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(number) = int(season.get("number")).filter(|n| *n >= 0) else {
            continue;
        };
        for episode in season
            .get("episodes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if episode.get("watched_at").is_none() {
                continue;
            }
            if let Some(e) = int(episode.get("number")).filter(|n| *n > 0) {
                out.push((number, e));
            }
        }
    }
    out
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
    let client = user_client(env).await?;
    let payload = client
        .request(env, "/sync/watched?extended=episodes", None)
        .await?;
    let coordinates = watched_coordinates(&payload, tmdb_id);
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
    fn reads_watched_coordinates() {
        let payload = json!({
            "shows": [
                {"ids": {"tmdb": 5}, "seasons": [{"number": 1, "episodes": [{"number": 1, "watched_at": "x"}]}]},
                {"ids": {"tmdb": "42"}, "seasons": [
                    {"number": 2, "episodes": [
                        {"number": 1, "watched_at": "2026-01-01"},
                        {"number": 2},
                        {"number": 0, "watched_at": null}
                    ]},
                    {"number": -1, "episodes": [{"number": 1, "watched_at": "x"}]}
                ]}
            ]
        });
        assert_eq!(
            watched_coordinates(&payload, 42),
            vec![(2, 1)],
            "watched only"
        );
        assert!(
            watched_coordinates(&Value::Null, 42).is_empty(),
            "empty history"
        );
    }

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
