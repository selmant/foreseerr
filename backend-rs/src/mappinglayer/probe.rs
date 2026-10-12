//! `server/lib/mapping/tmdb.ts` (TMDB `/find` and the record probe, with
//! the not-found cache) and the confirm cache of
//! `server/lib/discover/validity.ts`.

use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use anyhow::Result;
use serde_json::Value;

use super::lru::BoundedLru;
use super::Ctx;
use crate::sync::lock;

static NEGATIVE: LazyLock<Mutex<BoundedLru<String, ()>>> =
    LazyLock::new(|| Mutex::new(BoundedLru::new(50_000, Some(Duration::from_secs(6 * 3600)))));

static ALIVE: LazyLock<Mutex<BoundedLru<String, Probe>>> = LazyLock::new(|| {
    Mutex::new(BoundedLru::new(
        20_000,
        Some(Duration::from_secs(24 * 3600)),
    ))
});

/// `TmdbFindResult`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Found {
    /// Movie ids.
    pub movies: Vec<i64>,
    /// Show ids.
    pub shows: Vec<i64>,
}

fn ids(list: Option<&Value>) -> Vec<i64> {
    list.and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|entry| entry.get("id").and_then(Value::as_i64))
                .filter(|id| *id != 0)
                .collect()
        })
        .unwrap_or_default()
}

/// `getByExternalId({ externalId, type })`: TMDB's `/find` answer.
///
/// # Errors
///
/// Fails when TMDB can't be reached or answers an error.
pub async fn find_by_external_id(ctx: &Ctx<'_>, source: &str, external_id: &str) -> Result<Value> {
    let (path, external_source) = if source == "imdb" {
        (format!("/find/{external_id}"), "imdb_id")
    } else {
        let n = crate::jsval::number_of_str(external_id);
        (format!("/find/{}", crate::jsnum::to_string(n)), "tvdb_id")
    };
    ctx.tmdb
        .raw(
            &path,
            &[
                ("external_source", String::from(external_source)),
                ("language", ctx.locale.clone()),
            ],
            300,
        )
        .await
}

/// `tmdbFind(source, externalId)`: the ids TMDB files an `IMDb` or TVDB id
/// under; an empty answer is remembered for six hours.
///
/// # Errors
///
/// Fails when TMDB can't be reached or answers an error.
pub async fn tmdb_find(ctx: &Ctx<'_>, source: &str, external_id: &str) -> Result<Found> {
    let request = format!("find:{source}:{external_id}");
    if lock(&NEGATIVE).get(&request).is_some() {
        return Ok(Found::default());
    }
    let found = find_by_external_id(ctx, source, external_id).await?;
    let result = Found {
        movies: ids(found.get("movie_results")),
        shows: ids(found.get("tv_results")),
    };
    if result.movies.is_empty() && result.shows.is_empty() {
        lock(&NEGATIVE).set(request, ());
    }
    Ok(result)
}

/// What a probe learnt (`TmdbProbe`, the fields read here).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Probe {
    /// The record exists.
    pub alive: bool,
    /// `posterPath`.
    pub poster_path: Option<String>,
    /// `backdropPath`.
    pub backdrop_path: Option<String>,
    /// `releaseDate` (movies).
    pub release_date: Option<String>,
    /// `firstAirDate` (series).
    pub first_air_date: Option<String>,
}

fn non_empty(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(crate::jsval::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// Whether TMDB answered 404.
fn not_found(e: &anyhow::Error) -> bool {
    e.chain()
        .filter_map(|c| c.downcast_ref::<reqwest::Error>())
        .any(|e| e.status().is_some_and(|s| s.as_u16() == 404))
}

/// `tmdbRecord(mediaType, tmdbId)`: the record in one namespace; a
/// confirmed 404 is remembered for six hours, anything else is thrown.
///
/// # Errors
///
/// Fails when TMDB can't be reached or answers an error other than 404.
pub async fn tmdb_record(ctx: &Ctx<'_>, media_type: &str, tmdb_id: i64) -> Result<Probe> {
    let request = format!("exists:{media_type}:{tmdb_id}");
    if lock(&NEGATIVE).get(&request).is_some() {
        return Ok(Probe::default());
    }
    let movie = media_type == "movie";
    let record = if movie {
        ctx.tmdb.movie(tmdb_id, &ctx.locale).await
    } else {
        ctx.tmdb.tv(tmdb_id, &ctx.locale).await
    };
    let record = match record {
        Ok(record) => record,
        Err(e) if not_found(&e) => {
            lock(&NEGATIVE).set(request, ());
            return Ok(Probe::default());
        }
        Err(e) => return Err(e),
    };
    let released = if record.get("release_date").is_some() {
        record.get("release_date")
    } else {
        record.get("first_air_date")
    };
    let date = non_empty(released);
    Ok(Probe {
        alive: true,
        poster_path: non_empty(record.get("poster_path")),
        backdrop_path: non_empty(record.get("backdrop_path")),
        release_date: date.clone().filter(|_| movie),
        first_air_date: date.filter(|_| !movie),
    })
}

/// `probe(mediaType, tmdbId)` of `validity.ts`: a live record is cached
/// for a day; a failure other than a 404 counts as alive.
pub async fn probe(ctx: &Ctx<'_>, media_type: &str, tmdb_id: i64) -> Probe {
    let key = format!("{media_type}:{tmdb_id}");
    let cached = lock(&ALIVE).get(&key);
    if let Some(cached) = cached {
        return cached;
    }
    match tmdb_record(ctx, media_type, tmdb_id).await {
        Ok(record) => {
            if record.alive {
                lock(&ALIVE).set(key, record.clone());
            }
            record
        }
        Err(_) => Probe {
            alive: true,
            ..Probe::default()
        },
    }
}

/// `confirmTmdbId(mediaType, tmdbId)`.
pub async fn confirm_tmdb_id(ctx: &Ctx<'_>, media_type: &str, tmdb_id: i64) -> bool {
    probe(ctx, media_type, tmdb_id).await.alive
}
