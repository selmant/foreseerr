//! `server/lib/mapping/resolve.ts`: a source item's ids to a TMDB id, in
//! a fixed order: correction, dataset edge, stored answer, TMDB `/find`,
//! Sonarr's `anilist:`/`mal:` lookup, then the anime fallback.

use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use anyhow::Result;

use super::derive::{self, AnimeHints, DeriveDeps, NetDeps};
use super::lru::BoundedLru;
use super::resolutions::{self, Stored, Write, GUESS_ORIGINS};
use super::{edges, probe, Ctx, IdRef, MediaType};
use crate::sync::lock;

/// A `ResolveRequest`.
#[derive(Default)]
pub struct Request<'a> {
    /// Every id the source supplied, most reliable first.
    pub refs: Vec<IdRef>,
    /// What the item is filed under; defaults to the first of `refs`.
    pub identity: Option<IdRef>,
    /// What the source says the item is.
    pub media_type: Option<MediaType>,
    /// Title.
    pub title: Option<String>,
    /// Year.
    pub year: Option<i64>,
    /// Discover source.
    pub discover_source: Option<String>,
    /// Anime hints, which allow the title and prequel fallback.
    pub anime: Option<AnimeHints>,
    /// Datasets and stored answers only.
    pub offline: bool,
    /// Test seam for the fallback's lookups.
    pub derive: Option<&'a dyn DeriveDeps>,
}

impl std::fmt::Debug for Request<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Request")
            .field("refs", &self.refs)
            .field("media_type", &self.media_type)
            .finish_non_exhaustive()
    }
}

/// A `TmdbResolution`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolution {
    /// TMDB id.
    pub tmdb_id: i64,
    /// Namespace.
    pub media_type: MediaType,
    /// `manual`, `dataset`, `tmdb-find`, `sonarr`, `title` or `prequel`.
    pub origin: String,
}

const ANIME_ENTRY: [&str; 3] = ["anilist", "mal", "anidb"];
const MISS_TTL_MSEC: i64 = 12 * 3600 * 1000;

type Hot = BoundedLru<String, Option<Resolution>>;

static HOT: LazyLock<Mutex<Hot>> =
    LazyLock::new(|| Mutex::new(BoundedLru::new(20_000, Some(Duration::from_secs(15 * 60)))));
static FAILED: LazyLock<Mutex<BoundedLru<String, ()>>> =
    LazyLock::new(|| Mutex::new(BoundedLru::new(20_000, Some(Duration::from_secs(2 * 60)))));

/// `invalidateResolutions`: drop cached answers.
pub fn invalidate_resolutions() {
    lock(&HOT).clear();
    lock(&FAILED).clear();
    resolutions::invalidate_corrections();
    crate::rowcache::clear();
}

/// The dataset-change listener: drop the answers (not the failures).
pub fn clear_hot() {
    lock(&HOT).clear();
}

/// `correctionAnswer`.
#[must_use]
pub fn correction_answer(c: &resolutions::Correction) -> Option<Resolution> {
    let id = c.tmdb_id.filter(|id| *id != 0)?;
    let media_type = c.tmdb_type.as_deref().and_then(MediaType::parse)?;
    Some(Resolution {
        tmdb_id: id,
        media_type,
        origin: String::from("manual"),
    })
}

fn from_row(row: &Stored) -> Option<Resolution> {
    if row.origin == "miss" {
        return None;
    }
    let id = row.tmdb_id.filter(|id| *id != 0)?;
    let media_type = row.tmdb_type.as_deref().and_then(MediaType::parse)?;
    Some(Resolution {
        tmdb_id: id,
        media_type,
        origin: row.origin.clone(),
    })
}

fn applies(row: &Stored, media_type: Option<MediaType>) -> bool {
    row.media_type.is_empty() || row.media_type == media_type.map_or("", MediaType::as_str)
}

async fn via_find(ctx: &Ctx<'_>, request: &Request<'_>) -> Result<Option<(IdRef, i64, MediaType)>> {
    for r in &request.refs {
        let source = match r.ns.as_str() {
            "imdb" => "imdb",
            "tvdb_show" => "tvdb",
            _ => continue,
        };
        if source == "tvdb" && request.media_type == Some(MediaType::Movie) {
            continue;
        }
        let found = probe::tmdb_find(ctx, source, &r.id).await?;
        let candidates: Vec<(MediaType, &Vec<i64>)> = match request.media_type {
            Some(MediaType::Movie) => vec![(MediaType::Movie, &found.movies)],
            Some(MediaType::Tv) => vec![(MediaType::Tv, &found.shows)],
            None => vec![
                (MediaType::Movie, &found.movies),
                (MediaType::Tv, &found.shows),
            ],
        };
        let answers: Vec<(MediaType, i64)> = candidates
            .into_iter()
            .flat_map(|(kind, ids)| ids.iter().map(move |id| (kind, *id)))
            .collect();
        if let [(kind, id)] = answers.as_slice() {
            return Ok(Some((r.clone(), *id, *kind)));
        }
    }
    Ok(None)
}

/// Sonarr's `anilist:` then `mal:` lookup for an anime TV entry that starts
/// its show ([`derive::sonarr_lookup_applies`]); the id it went by and the
/// series. A Sonarr that can't be reached leaves it to the next rule.
async fn via_sonarr(
    request: &Request<'_>,
    deps: &dyn DeriveDeps,
) -> Option<(IdRef, derive::SonarrMatch)> {
    let anime = request.anime.as_ref()?;
    let year = anime.year.or(request.year).filter(|y| *y != 0)?;
    let hints = AnimeHints {
        year: Some(year),
        ..anime.clone()
    };
    if request.media_type != Some(MediaType::Tv) || !derive::sonarr_lookup_applies(&hints) {
        return None;
    }
    let mut ids: Vec<IdRef> = anime
        .anilist_id
        .filter(|id| *id > 0)
        .map(|id| IdRef::new("anilist", &id.to_string()))
        .into_iter()
        .collect();
    for ns in ["anilist", "mal"] {
        for r in request.refs.iter().filter(|r| r.ns == ns) {
            if !ids.contains(r) {
                ids.push(r.clone());
            }
        }
    }
    for r in ids {
        let Ok(id) = r.id.parse::<i64>() else {
            continue;
        };
        let found = match deps.sonarr_lookup(&format!("{}:{id}", r.ns)).await {
            Ok(Some(found)) => found,
            Ok(None) => return None,
            Err(e) => {
                tracing::debug!(
                    label = "Mapping",
                    "Sonarr's {}:{id} lookup failed: {e:#}",
                    r.ns
                );
                return None;
            }
        };
        if let Some(series) = derive::sonarr_match(&found, &r.ns, id, year) {
            return Some((r, series));
        }
    }
    None
}

fn context_write(request: &Request<'_>, r: IdRef, origin: &'static str) -> Write {
    Write {
        r,
        media_type: request.media_type.map(|t| t.as_str().to_owned()),
        title: request.title.clone(),
        year: request.year,
        discover_source: request.discover_source.clone(),
        origin,
        attempted: true,
        ..Write::default()
    }
}

/// Drop the misses (and superseded guesses) once the item has an answer.
async fn answered(
    ctx: &Ctx<'_>,
    answer: Resolution,
    stale: impl Iterator<Item = i64>,
) -> Result<Option<Resolution>> {
    let ids: Vec<i64> = stale.collect();
    resolutions::delete_resolutions(ctx.db, &ids).await?;
    Ok(Some(answer))
}

async fn resolve_uncached(ctx: &Ctx<'_>, request: &Request<'_>) -> Result<Option<Resolution>> {
    let refs = &request.refs;
    let media_type = request.media_type;
    let primary = request
        .identity
        .clone()
        .or_else(|| refs.first().cloned())
        .unwrap_or_default();

    let ordered: Vec<Option<&IdRef>> = refs.iter().map(Some).collect();
    if let Some(correction) = resolutions::correction_for(ctx.db, &ordered).await? {
        return Ok(correction_answer(&correction));
    }

    let stored: Vec<Stored> = resolutions::stored_for(ctx.db, refs)
        .await?
        .into_iter()
        .filter(|row| applies(row, media_type))
        .collect();
    let misses: Vec<&Stored> = stored.iter().filter(|row| row.origin == "miss").collect();
    let miss_ids = || misses.iter().map(|row| row.id);

    for r in refs {
        if let Some(known) = edges::dataset_tmdb(ctx.db, r, media_type, true).await? {
            let guesses = stored
                .iter()
                .filter(|row| GUESS_ORIGINS.contains(&row.origin.as_str()))
                .map(|row| row.id);
            let answer = Resolution {
                tmdb_id: known.tmdb_id,
                media_type: known.media_type,
                origin: String::from("dataset"),
            };
            return answered(ctx, answer, miss_ids().chain(guesses)).await;
        }
    }

    for r in refs {
        let row = stored
            .iter()
            .find(|c| c.src_ns == r.ns && c.src_id == r.id && c.origin != "miss");
        if let Some(answer) = row.and_then(from_row) {
            if media_type.is_none_or(|t| t == answer.media_type) {
                return answered(ctx, answer, miss_ids()).await;
            }
        }
    }

    let now = crate::clock::now_millis();
    let recent_miss = misses
        .iter()
        .any(|row| row.checked_at.is_some_and(|at| now - at < MISS_TTL_MSEC));
    if request.offline || recent_miss || crate::mappingdatasets::datasets_loading() {
        return Ok(None);
    }

    if let Some((r, tmdb_id, kind)) = via_find(ctx, request).await? {
        let mut write = context_write(request, r, "tmdb-find");
        write.tmdb_id = Some(tmdb_id);
        write.tmdb_type = Some(kind.as_str().to_owned());
        resolutions::save_resolution(ctx.db, &write).await?;
        let answer = Resolution {
            tmdb_id,
            media_type: kind,
            origin: String::from("tmdb-find"),
        };
        return answered(ctx, answer, miss_ids()).await;
    }

    let net = NetDeps::new(ctx);
    let deps: &dyn DeriveDeps = request.derive.unwrap_or(&net);

    if let Some((r, found)) = via_sonarr(request, deps).await {
        let mut write = context_write(request, r.clone(), "sonarr");
        write.tmdb_id = Some(found.tmdb_id);
        write.tmdb_type = Some(MediaType::Tv.as_str().to_owned());
        write.detail = Some(format!(
            "{}:{} is \"{}\" (tvdb {})",
            r.ns,
            r.id,
            found.title,
            found
                .tvdb_id
                .map_or_else(|| String::from("?"), |id| id.to_string())
        ));
        resolutions::save_resolution(ctx.db, &write).await?;
        let answer = Resolution {
            tmdb_id: found.tmdb_id,
            media_type: MediaType::Tv,
            origin: String::from("sonarr"),
        };
        return answered(ctx, answer, miss_ids()).await;
    }

    if let (Some(anime), Some(kind)) = (&request.anime, media_type) {
        let hints = AnimeHints {
            titles: Some(anime.titles.clone().unwrap_or_else(|| {
                request
                    .title
                    .clone()
                    .filter(|t| !t.is_empty())
                    .into_iter()
                    .collect()
            })),
            year: anime.year.or(request.year),
            ..anime.clone()
        };
        if let Some(derived) = derive::derive_tmdb(ctx, &hints, kind, deps).await? {
            let filed = anime.anilist_id.filter(|id| *id != 0).map_or_else(
                || primary.clone(),
                |id| IdRef::new("anilist", &id.to_string()),
            );
            let mut write = context_write(request, filed, derived.origin);
            write.tmdb_id = Some(derived.tmdb_id);
            write.tmdb_type = Some(derived.media_type.as_str().to_owned());
            write.detail = Some(derived.detail.clone());
            resolutions::save_resolution(ctx.db, &write).await?;
            let answer = Resolution {
                tmdb_id: derived.tmdb_id,
                media_type: derived.media_type,
                origin: derived.origin.to_owned(),
            };
            return answered(ctx, answer, miss_ids()).await;
        }
    }

    let mut write = context_write(request, primary, "miss");
    write.attempted =
        request.anime.is_some() || !refs.iter().any(|r| ANIME_ENTRY.contains(&r.ns.as_str()));
    resolutions::save_resolution(ctx.db, &write).await?;
    Ok(None)
}

/// `resolveTmdb(request)`.
///
/// # Errors
///
/// Fails when the mapping layer can't be loaded; lookup failures read as
/// "no answer" and hold the same request off for two minutes.
pub async fn resolve_tmdb(ctx: &Ctx<'_>, request: Request<'_>) -> Result<Option<Resolution>> {
    let mut seen = Vec::new();
    let refs: Vec<IdRef> = request
        .identity
        .iter()
        .chain(request.refs.iter())
        .filter(|r| r.truthy())
        .filter(|r| {
            let key = r.key();
            if seen.contains(&key) {
                return false;
            }
            seen.push(key);
            true
        })
        .cloned()
        .collect();
    if refs.is_empty() {
        return Ok(None);
    }
    super::ensure(ctx.db).await?;
    let key = [
        refs.iter().map(IdRef::key).collect::<Vec<_>>().join(","),
        request
            .media_type
            .map_or_else(String::new, |t| t.as_str().to_owned()),
        String::from(if request.offline { "offline" } else { "" }),
        String::from(if request.anime.is_some() { "anime" } else { "" }),
    ]
    .join("|");
    let cached = lock(&HOT).get(&key);
    if let Some(cached) = cached {
        return Ok(cached);
    }
    if lock(&FAILED).get(&key).is_some() {
        return Ok(None);
    }
    let request = Request { refs, ..request };
    match resolve_uncached(ctx, &request).await {
        Ok(value) => {
            lock(&HOT).set(key, value.clone());
            Ok(value)
        }
        Err(e) => {
            lock(&FAILED).set(key, ());
            tracing::debug!(
                label = "Mapping",
                refs = request
                    .refs
                    .iter()
                    .map(IdRef::key)
                    .collect::<Vec<_>>()
                    .join(","),
                "Mapping lookup failed: {e:#}"
            );
            Ok(None)
        }
    }
}
