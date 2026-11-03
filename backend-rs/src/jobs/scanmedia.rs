//! `BaseScanner.processMovie`, `processShow`, `declineOrphanedRequests`.
//!
//! With `seasonStatus.ts`: how a scanned title updates its `media` row and
//! seasons. The decisions are pure functions; the saves of existing titles
//! go through `routes::mediasave` so `MediaSubscriber`'s effects (request
//! approval and completion, availability notifications) happen as in Node.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use anyhow::{Context, Result};
use serde_json::Value;

use super::scanbase::{Scan, AVAILABLE, DELETED, PARTIAL, PROCESSING, UNKNOWN};
use crate::clock::Utc;
use crate::db::{Bind, Db, MediaRow, RequestRow, SeasonRow};
use crate::lifecycle::{Lc, APPROVED, COMPLETED, DECLINED};
use crate::routes::mediasave::{self, FreshSeason, MediaEdit};

/// The status resets an *arr scan leaves for the end of its run, when it
/// can answer for every server and not just the one it was scanning.
#[derive(Debug, Default)]
pub struct Resets {
    /// `statusResetCandidates`: (media id, 4K).
    pub media: BTreeSet<(i64, bool)>,
    /// `seasonResetCandidates`: (media id, 4K) → the season numbers and the
    /// seasons the scan saw last.
    pub seasons: BTreeMap<(i64, bool), (BTreeSet<i64>, Vec<ProcessableSeason>)>,
}

/// What settling abandoned seasons does to a title's approved requests.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct SeasonResetPlan {
    /// The requests to decline.
    pub decline: Vec<i64>,
    /// Requests that keep other seasons: (request id, the season request
    /// ids to remove, the seasons left, whether they are all completed).
    pub trim: Vec<(i64, Vec<i64>, i64, bool)>,
}

/// The approved requests of a title whose seasons `abandoned` Sonarr
/// stopped pursuing.
///
/// All of them are declined when the title itself fell back to unknown;
/// otherwise a request is declined when every season it asked for was
/// abandoned, and loses the abandoned ones when not.
#[must_use]
pub fn plan_season_resets(
    requests: &[RequestRow],
    abandoned: &BTreeSet<i64>,
    title_unknown: bool,
) -> SeasonResetPlan {
    let mut plan = SeasonResetPlan::default();
    for request in requests {
        let gone = |s: &&crate::db::SeasonRequestRow| abandoned.contains(&s.season_number);
        let affected = request.seasons.iter().any(|s| gone(&s));
        let all_gone = affected && request.seasons.iter().all(|s| gone(&s));
        if title_unknown || all_gone {
            plan.decline.push(request.id);
        } else if affected {
            let (removed, kept): (Vec<_>, Vec<_>) = request.seasons.iter().partition(gone);
            plan.trim.push((
                request.id,
                removed.iter().map(|s| s.id).collect(),
                i64::try_from(kept.len()).unwrap_or(i64::MAX),
                kept.iter().all(|s| s.status == COMPLETED),
            ));
        }
    }
    plan
}

/// `recordStatusReset` and `recordSeasonReset` for a scanned show.
fn record_show_resets(
    resets: &std::sync::Mutex<Resets>,
    media_id: i64,
    update: &ShowUpdate,
    scanned: &[ProcessableSeason],
) {
    let mut resets = crate::sync::lock(resets);
    for &four_k in &update.status_resets {
        resets.media.insert((media_id, four_k));
    }
    for &(number, four_k) in &update.deferred_seasons {
        let entry = resets.seasons.entry((media_id, four_k)).or_default();
        entry.0.insert(number);
        entry.1 = scanned.to_vec();
    }
    drop(resets);
}

/// `ProcessableSeason`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProcessableSeason {
    /// `seasonNumber`.
    pub season_number: i64,
    /// `totalEpisodes`: what the metadata provider lists.
    pub total_episodes: i64,
    /// `episodes`: available in standard quality.
    pub episodes: i64,
    /// `episodes4k`.
    pub episodes4k: i64,
    /// `is4kOverride` (`undefined` is `false`).
    pub is4k_override: bool,
    /// `processing` (`undefined` is `false`).
    pub processing: bool,
}

/// `nextSeasonStatus`.
#[must_use]
pub fn next_season_status(
    previous: Option<i64>,
    total_episodes: i64,
    available_episodes: i64,
    can_be_available: bool,
    processing_for_quality: bool,
    processing: bool,
) -> i64 {
    if can_be_available && total_episodes == available_episodes && available_episodes > 0 {
        return AVAILABLE;
    }
    if previous == Some(AVAILABLE) {
        return AVAILABLE;
    }
    if can_be_available && available_episodes > 0 {
        return PARTIAL;
    }
    if processing_for_quality && processing && previous != Some(DELETED) {
        return PROCESSING;
    }
    if previous == Some(PROCESSING)
        && processing_for_quality
        && !processing
        && available_episodes == 0
    {
        return UNKNOWN;
    }
    previous.unwrap_or(UNKNOWN)
}

const fn season_status(season: &SeasonRow, four_k: bool) -> i64 {
    if four_k {
        season.status4k
    } else {
        season.status
    }
}

/// `rollupShowStatus`.
#[must_use]
pub fn rollup_show_status(
    seasons: &[SeasonRow],
    scanned: &[ProcessableSeason],
    four_k: bool,
    previous: Option<i64>,
    enabled: bool,
) -> i64 {
    let rollup: Vec<&SeasonRow> = seasons
        .iter()
        .filter(|s| s.season_number != 0)
        .filter(|s| {
            scanned
                .iter()
                .find(|item| item.season_number == s.season_number)
                .map_or_else(
                    || season_status(s, four_k) != UNKNOWN,
                    |item| item.total_episodes > 0,
                )
        })
        .collect();
    let all_available =
        !rollup.is_empty() && rollup.iter().all(|s| season_status(s, four_k) == AVAILABLE);
    if enabled && all_available {
        return AVAILABLE;
    }
    if enabled
        && seasons
            .iter()
            .any(|s| matches!(season_status(s, four_k), PARTIAL | AVAILABLE))
    {
        return PARTIAL;
    }
    if (scanned.is_empty() && previous != Some(DELETED))
        || seasons
            .iter()
            .any(|s| season_status(s, four_k) == PROCESSING)
    {
        return PROCESSING;
    }
    if previous == Some(DELETED) {
        DELETED
    } else {
        UNKNOWN
    }
}

/// `ProcessOptions` of `processMovie`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MovieOpts {
    /// `is4k`.
    pub is4k: bool,
    /// `mediaAddedAt` in milliseconds.
    pub media_added_at: Option<i64>,
    /// `ratingKey` (Plex).
    pub rating_key: Option<String>,
    /// `jellyfinMediaId`.
    pub jellyfin_media_id: Option<String>,
    /// `imdbId`.
    pub imdb_id: Option<String>,
    /// `serviceId`.
    pub service_id: Option<i64>,
    /// `externalServiceId`.
    pub external_service_id: Option<i64>,
    /// `externalServiceSlug`.
    pub external_service_slug: Option<String>,
    /// `title`, for the logs.
    pub title: String,
    /// `processing`.
    pub processing: bool,
    /// `hasFile`.
    pub has_file: bool,
}

impl MovieOpts {
    /// The defaults (`processing = false`, `hasFile = true`) for a title.
    #[must_use]
    pub fn new(title: &str) -> Self {
        Self {
            is4k: false,
            media_added_at: None,
            rating_key: None,
            jellyfin_media_id: None,
            imdb_id: None,
            service_id: None,
            external_service_id: None,
            external_service_slug: None,
            title: title.to_owned(),
            processing: false,
            has_file: true,
        }
    }
}

/// `ProcessOptions` of `processShow`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ShowOpts {
    /// `mediaAddedAt` in milliseconds.
    pub media_added_at: Option<i64>,
    /// `ratingKey`.
    pub rating_key: Option<String>,
    /// `jellyfinMediaId`.
    pub jellyfin_media_id: Option<String>,
    /// `serviceId`.
    pub service_id: Option<i64>,
    /// `externalServiceId`.
    pub external_service_id: Option<i64>,
    /// `externalServiceSlug`.
    pub external_service_slug: Option<String>,
    /// `is4k`: which service columns the ids go to.
    pub is4k: bool,
    /// `title`.
    pub title: String,
}

fn iso(ms: i64) -> String {
    Utc::from_unix_millis(ms).iso_string()
}

fn non_empty(value: Option<&String>) -> Option<&String> {
    value.filter(|v| !v.is_empty())
}

const fn status_mut(media: &mut MediaRow, four_k: bool) -> &mut i64 {
    if four_k {
        &mut media.status4k
    } else {
        &mut media.status
    }
}

/// Set an optional column when the value differs; whether it did.
fn set_if_differs<T: PartialEq + Clone>(field: &mut Option<T>, value: &T) -> bool {
    if field.as_ref() == Some(value) {
        false
    } else {
        *field = Some(value.clone());
        true
    }
}

/// `processMovie` on an existing title: the changed row, and whether Node
/// sees a change (`changedExisting`).
#[must_use]
/// `defer` is [`Kind::defer_resets`](super::scanbase::Kind::defer_resets).
pub fn apply_movie(existing: &MediaRow, o: &MovieOpts, defer: bool) -> (MediaRow, bool) {
    let mut m = existing.clone();
    let mut changed = false;
    let k = o.is4k;
    let previous = *status_mut(&mut m, k);
    let deferred = movie_reset_deferred(existing, o, defer);
    if previous != AVAILABLE && !deferred {
        let next = if !o.processing && o.has_file {
            AVAILABLE
        } else if !o.processing && !o.has_file && previous == PROCESSING {
            UNKNOWN
        } else if o.processing {
            if previous == DELETED {
                DELETED
            } else {
                PROCESSING
            }
        } else {
            previous
        };
        *status_mut(&mut m, k) = next;
        if next != previous {
            if let Some(at) = o.media_added_at {
                m.media_added_at = Some(iso(at));
            }
            changed = true;
        }
    }
    if !changed && m.media_added_at.is_none() {
        if let Some(at) = o.media_added_at {
            m.media_added_at = Some(iso(at));
            changed = true;
        }
    }
    if let Some(key) = non_empty(o.rating_key.as_ref()) {
        let field = if k {
            &mut m.rating_key4k
        } else {
            &mut m.rating_key
        };
        changed |= set_if_differs(field, key);
    }
    if let Some(id) = non_empty(o.jellyfin_media_id.as_ref()) {
        let field = if k {
            &mut m.jellyfin_media_id4k
        } else {
            &mut m.jellyfin_media_id
        };
        changed |= set_if_differs(field, id);
    }
    if let Some(imdb) = non_empty(o.imdb_id.as_ref()) {
        if non_empty(m.imdb_id.as_ref()).is_none() {
            m.imdb_id = Some(imdb.clone());
            changed = true;
        }
    }
    // An abandoned entry claiming them would make them depend on the
    // order the servers are scanned in.
    if !deferred {
        changed |= set_services(
            &mut m,
            k,
            o.service_id,
            o.external_service_id,
            o.external_service_slug.as_ref(),
        );
    }
    (m, changed)
}

/// Whether an *arr scan found a processing movie's entry abandoned
/// (unmonitored, nothing downloaded): one server can't speak for the
/// others, so the reset to unknown waits for the end of the run.
#[must_use]
pub const fn movie_reset_deferred(existing: &MediaRow, o: &MovieOpts, defer: bool) -> bool {
    let previous = if o.is4k {
        existing.status4k
    } else {
        existing.status
    };
    defer && !o.processing && !o.has_file && previous == PROCESSING
}

/// The `serviceId`, `externalServiceId` and `externalServiceSlug` given
/// (`!== undefined`) for one quality; whether any differed.
fn set_services(
    m: &mut MediaRow,
    four_k: bool,
    service_id: Option<i64>,
    external_id: Option<i64>,
    slug: Option<&String>,
) -> bool {
    let mut changed = false;
    if let Some(id) = service_id {
        let field = if four_k {
            &mut m.service_id4k
        } else {
            &mut m.service_id
        };
        changed |= set_if_differs(field, &id);
    }
    if let Some(id) = external_id {
        let field = if four_k {
            &mut m.external_service_id4k
        } else {
            &mut m.external_service_id
        };
        changed |= set_if_differs(field, &id);
    }
    if let Some(slug) = slug {
        let field = if four_k {
            &mut m.external_service_slug4k
        } else {
            &mut m.external_service_slug
        };
        changed |= set_if_differs(field, slug);
    }
    changed
}

/// `processMovie` for a title not in the database: the new row, or `None`
/// when nothing is to be created (no file and not processing).
#[must_use]
pub fn new_movie(tmdb_id: i64, o: &MovieOpts, enable4k: bool) -> Option<MediaRow> {
    if !o.processing && !o.has_file {
        return None;
    }
    let k = o.is4k;
    let pick = |four_k: bool, v: &Option<String>| if four_k { v.clone() } else { None };
    let mut m = MediaRow {
        media_type: String::from("movie"),
        tmdb_id,
        imdb_id: o.imdb_id.clone(),
        status: match (k, o.processing) {
            (false, false) => AVAILABLE,
            (false, true) => PROCESSING,
            (true, _) => UNKNOWN,
        },
        status4k: match (k && enable4k, o.processing) {
            (true, false) => AVAILABLE,
            (true, true) => PROCESSING,
            (false, _) => UNKNOWN,
        },
        media_added_at: o.media_added_at.map(iso),
        ..MediaRow::default()
    };
    set_services(
        &mut m,
        k,
        o.service_id,
        o.external_service_id,
        o.external_service_slug.as_ref(),
    );
    if non_empty(o.rating_key.as_ref()).is_some() {
        m.rating_key = pick(!k, &o.rating_key);
        m.rating_key4k = pick(k && enable4k, &o.rating_key);
    }
    if non_empty(o.jellyfin_media_id.as_ref()).is_some() {
        m.jellyfin_media_id = pick(!k, &o.jellyfin_media_id);
        m.jellyfin_media_id4k = pick(k && enable4k, &o.jellyfin_media_id);
    }
    Some(m)
}

/// A scanned season as `processShow` counts it: a season the provider
/// lists as empty has its counts zeroed.
const fn counted(season: &ProcessableSeason) -> (i64, i64) {
    if season.total_episodes > 0 {
        (season.episodes, season.episodes4k)
    } else {
        (0, 0)
    }
}

/// A season's `(status, status4k)` after a scan.
fn scanned_statuses(
    previous: Option<(i64, i64)>,
    season: &ProcessableSeason,
    enable4k: bool,
) -> (i64, i64) {
    let (episodes, episodes4k) = counted(season);
    (
        next_season_status(
            previous.map(|p| p.0),
            season.total_episodes,
            episodes,
            true,
            !season.is4k_override,
            season.processing,
        ),
        next_season_status(
            previous.map(|p| p.1),
            season.total_episodes,
            episodes4k,
            enable4k,
            season.is4k_override,
            season.processing,
        ),
    )
}

/// `processShow` on an existing title.
#[derive(Debug, Clone)]
pub struct ShowUpdate {
    /// The row after the scan, created seasons appended.
    pub after: MediaRow,
    /// The created seasons.
    pub fresh: Vec<FreshSeason>,
    /// How many more seasons are available (standard, 4K).
    pub more_available: (usize, usize),
    /// Processing seasons an *arr scan found abandoned, left processing
    /// for the end of the run: (season number, 4K).
    pub deferred_seasons: Vec<(i64, bool)>,
    /// The qualities (4K or not) whose status went from processing to
    /// unknown in an *arr scan.
    pub status_resets: Vec<bool>,
}

fn available_count(seasons: &[SeasonRow], four_k: bool) -> usize {
    seasons
        .iter()
        .filter(|s| season_status(s, four_k) == AVAILABLE)
        .count()
}

/// `processShow` for a title in the database; `now_ms` is `new Date()`,
/// `defer` is [`Kind::defer_resets`](super::scanbase::Kind::defer_resets).
#[must_use]
pub fn apply_show(
    media: &MediaRow,
    scanned: &[ProcessableSeason],
    o: &ShowOpts,
    enable4k: bool,
    now_ms: i64,
    defer: bool,
) -> ShowUpdate {
    let mut m = media.clone();
    let loaded = media.seasons.len();
    let mut fresh = Vec::new();
    let mut deferred_seasons = Vec::new();
    for season in scanned {
        let (episodes, episodes4k) = counted(season);
        if episodes > 0 {
            if let Some(key) = &o.rating_key {
                m.rating_key = Some(key.clone());
            }
            if let Some(id) = &o.jellyfin_media_id {
                m.jellyfin_media_id = Some(id.clone());
            }
        }
        if episodes4k > 0 && enable4k {
            if let Some(key) = &o.rating_key {
                m.rating_key4k = Some(key.clone());
            }
            if let Some(id) = &o.jellyfin_media_id {
                m.jellyfin_media_id4k = Some(id.clone());
            }
        }
        let existing = m
            .seasons
            .iter_mut()
            .take(loaded)
            .find(|s| s.season_number == season.season_number);
        if let Some(existing) = existing {
            let abandoned = |episodes: i64, status: i64| {
                defer && !season.processing && episodes == 0 && status == PROCESSING
            };
            let defer_standard =
                !season.is4k_override && abandoned(season.episodes, existing.status);
            let defer_4k = season.is4k_override && abandoned(season.episodes4k, existing.status4k);
            let (status, status4k) =
                scanned_statuses(Some((existing.status, existing.status4k)), season, enable4k);
            if defer_standard || defer_4k {
                deferred_seasons.push((season.season_number, defer_4k));
            }
            if !defer_standard {
                existing.status = status;
            }
            if !defer_4k {
                existing.status4k = status4k;
            }
        } else {
            let (status, status4k) = scanned_statuses(None, season, enable4k);
            fresh.push(FreshSeason {
                index: m.seasons.len(),
                four_k: false,
            });
            m.seasons.push(SeasonRow {
                season_number: season.season_number,
                status,
                status4k,
                media_id: Some(m.id),
                ..SeasonRow::default()
            });
        }
    }
    let more_standard =
        available_count(&m.seasons, false).saturating_sub(available_count(&media.seasons, false));
    let more_4k =
        available_count(&m.seasons, true).saturating_sub(available_count(&media.seasons, true));
    if more_standard > 0 {
        m.last_season_change = Some(iso(now_ms));
        if let Some(at) = o.media_added_at {
            m.media_added_at = Some(iso(at));
        }
    }
    if more_4k > 0 {
        m.last_season_change = Some(iso(now_ms));
    }
    if m.media_added_at.is_none() {
        m.media_added_at = o.media_added_at.map(iso);
    }
    let quality_status = if o.is4k { media.status4k } else { media.status };
    let abandoned_entry = defer
        && quality_status == PROCESSING
        && !scanned
            .iter()
            .any(|s| s.processing || (if o.is4k { s.episodes4k } else { s.episodes }) > 0);
    // As for movies: an abandoned entry doesn't claim the service ids.
    if !abandoned_entry {
        set_services(
            &mut m,
            o.is4k,
            o.service_id,
            o.external_service_id,
            o.external_service_slug.as_ref(),
        );
    }
    m.status = rollup_show_status(&m.seasons, scanned, false, Some(media.status), true);
    m.status4k = rollup_show_status(&m.seasons, scanned, true, Some(media.status4k), enable4k);
    let mut status_resets = Vec::new();
    if defer {
        if media.status == PROCESSING && m.status == UNKNOWN {
            status_resets.push(false);
        }
        if media.status4k == PROCESSING && m.status4k == UNKNOWN {
            status_resets.push(true);
        }
    }
    ShowUpdate {
        after: m,
        fresh,
        more_available: (more_standard, more_4k),
        deferred_seasons,
        status_resets,
    }
}

/// `processShow` for a title not in the database: the row to insert with
/// its seasons.
#[must_use]
pub fn new_show(
    tmdb_id: i64,
    tvdb: Option<i64>,
    scanned: &[ProcessableSeason],
    o: &ShowOpts,
    enable4k: bool,
) -> MediaRow {
    let seasons: Vec<SeasonRow> = scanned
        .iter()
        .map(|season| {
            let (status, status4k) = scanned_statuses(None, season, enable4k);
            SeasonRow {
                season_number: season.season_number,
                status,
                status4k,
                ..SeasonRow::default()
            }
        })
        .collect();
    let any = |four_k: bool| {
        seasons
            .iter()
            .any(|s| matches!(season_status(s, four_k), PARTIAL | AVAILABLE))
    };
    let standard = any(false);
    let uhd = enable4k && any(true);
    let mut m = MediaRow {
        media_type: String::from("tv"),
        tmdb_id,
        tvdb_id: tvdb,
        media_added_at: o.media_added_at.map(iso),
        rating_key: o.rating_key.clone().filter(|_| standard),
        rating_key4k: o.rating_key.clone().filter(|_| uhd),
        jellyfin_media_id: o.jellyfin_media_id.clone().filter(|_| standard),
        jellyfin_media_id4k: o.jellyfin_media_id.clone().filter(|_| uhd),
        status: rollup_show_status(&seasons, scanned, false, None, true),
        status4k: rollup_show_status(&seasons, scanned, true, None, enable4k),
        ..MediaRow::default()
    };
    set_services(
        &mut m,
        o.is4k,
        o.service_id,
        o.external_service_id,
        o.external_service_slug.as_ref(),
    );
    m.seasons = seasons;
    m
}

/// `mediaRepository.findOne({ where: { tmdbId, mediaType } })` with the
/// eager seasons.
///
/// # Errors
///
/// Database errors.
pub async fn find_media(db: &Db, tmdb_id: i64, media_type: &str) -> Result<Option<MediaRow>> {
    let Some(found) = db.media_by_tmdb(tmdb_id, media_type).await? else {
        return Ok(None);
    };
    Ok(db.media_by_ids(&[found.id], true).await?.pop())
}

/// The lifecycle handle of a job.
#[must_use]
pub fn lc_of(scan: &Scan<'_>) -> Lc {
    Lc {
        state: Arc::clone(&scan.job.state),
        settings: Arc::clone(&scan.job.settings),
    }
}

/// `mediaRepository.save(media)` for a loaded title, with its hooks.
///
/// # Errors
///
/// Database errors.
pub async fn save_existing(
    scan: &Scan<'_>,
    before: MediaRow,
    after: MediaRow,
    fresh: Vec<FreshSeason>,
) -> Result<()> {
    let mut edit = MediaEdit {
        before,
        after,
        fresh,
    };
    Box::pin(mediasave::save(&lc_of(scan), &mut edit)).await
}

/// A date column value as `TypeORM` writes it.
fn date_sql(db: &Db, n: usize) -> String {
    if db.is_postgres() {
        format!("CAST(?{n} AS timestamptz)")
    } else {
        format!("?{n}")
    }
}

fn date_bind(db: &Db, iso: &str) -> Bind {
    let ms = crate::clock::parse_date_millis(iso).unwrap_or_default();
    let t = Utc::from_unix_millis(ms);
    Bind::Text(if db.is_postgres() {
        t.iso_string()
    } else {
        t.typeorm_string()
    })
}

/// `mediaRepository.save(new Media(…))`: the media row, then its seasons.
///
/// Columns left `undefined` take their defaults. A TVDB id another row
/// already holds is left out (see [`crate::dbtx::free_tvdb_id`]).
///
/// # Errors
///
/// Database errors.
pub async fn insert_media(db: &Db, m: &MediaRow) -> Result<i64> {
    let tvdb_id =
        crate::dbtx::free_tvdb_id(&mut crate::dbtx::Exec::Db(db), m.tmdb_id, m.tvdb_id).await?;
    let mut names = vec![
        "mediaType",
        "tmdbId",
        "tvdbId",
        "imdbId",
        "status",
        "status4k",
        "serviceId",
        "serviceId4k",
        "externalServiceId",
        "externalServiceId4k",
        "externalServiceSlug",
        "externalServiceSlug4k",
        "ratingKey",
        "ratingKey4k",
        "jellyfinMediaId",
        "jellyfinMediaId4k",
    ];
    let mut binds = vec![
        Bind::Text(m.media_type.clone()),
        Bind::Int(m.tmdb_id),
        Bind::OptInt(tvdb_id),
        Bind::OptText(m.imdb_id.clone()),
        Bind::Int(m.status),
        Bind::Int(m.status4k),
        Bind::OptInt(m.service_id),
        Bind::OptInt(m.service_id4k),
        Bind::OptInt(m.external_service_id),
        Bind::OptInt(m.external_service_id4k),
        Bind::OptText(m.external_service_slug.clone()),
        Bind::OptText(m.external_service_slug4k.clone()),
        Bind::OptText(m.rating_key.clone()),
        Bind::OptText(m.rating_key4k.clone()),
        Bind::OptText(m.jellyfin_media_id.clone()),
        Bind::OptText(m.jellyfin_media_id4k.clone()),
    ];
    let mut values: Vec<String> = (1..=binds.len()).map(|n| format!("?{n}")).collect();
    if let Some(at) = &m.media_added_at {
        names.push("mediaAddedAt");
        binds.push(date_bind(db, at));
        values.push(date_sql(db, binds.len()));
    }
    let columns: Vec<String> = names.iter().map(|n| format!("\"{n}\"")).collect();
    let sql = format!(
        r#"INSERT INTO "media" ({}) VALUES ({}) RETURNING CAST("id" AS BIGINT)"#,
        columns.join(", "),
        values.join(", ")
    );
    let id = db.scalar(&sql, &binds).await.context("inserting media")?;
    for season in &m.seasons {
        db.scalar(
            r#"INSERT INTO "season" ("seasonNumber", "status", "status4k", "mediaId") VALUES (?1, ?2, ?3, ?4) RETURNING CAST("id" AS BIGINT)"#,
            &[
                Bind::Int(season.season_number),
                Bind::Int(season.status),
                Bind::Int(season.status4k),
                Bind::Int(id),
            ],
        )
        .await
        .context("inserting a season")?;
    }
    Ok(id)
}

impl Scan<'_> {
    /// `processMovie(tmdbId, options)`.
    ///
    /// # Errors
    ///
    /// Database errors.
    pub async fn process_movie(&self, tmdb_id: i64, o: &MovieOpts) -> Result<()> {
        let _title = self.lock_title(tmdb_id).await;
        let db = &self.job.state.db;
        if let Some(existing) = find_media(db, tmdb_id, "movie").await? {
            if movie_reset_deferred(&existing, o, self.kind.defer_resets) {
                crate::sync::lock(&self.resets)
                    .media
                    .insert((existing.id, o.is4k));
            }
            let (after, changed) = apply_movie(&existing, o, self.kind.defer_resets);
            if changed {
                save_existing(self, existing, after, Vec::new()).await?;
                self.info(&format!(
                    "Media for {} exists. Changes were detected and the title will be updated.",
                    o.title
                ));
            } else {
                self.debug(&format!(
                    "Title already exists and no changes detected for {}",
                    o.title
                ));
            }
            return Ok(());
        }
        let Some(row) = new_movie(tmdb_id, o, self.enable4k_movie) else {
            return Ok(());
        };
        insert_media(db, &row).await?;
        self.debug(&format!("Saved new media: {}", o.title));
        Ok(())
    }

    /// `processShow(tmdbId, tvdbId, seasons, options)`.
    ///
    /// # Errors
    ///
    /// Database errors.
    pub async fn process_show(
        &self,
        tmdb_id: i64,
        tvdb: Option<i64>,
        seasons: &[ProcessableSeason],
        o: &ShowOpts,
    ) -> Result<()> {
        let _title = self.lock_title(tmdb_id).await;
        let db = &self.job.state.db;
        if let Some(media) = find_media(db, tmdb_id, "tv").await? {
            let update = apply_show(
                &media,
                seasons,
                o,
                self.enable4k_show,
                crate::clock::now_millis(),
                self.kind.defer_resets,
            );
            record_show_resets(&self.resets, media.id, &update, seasons);
            let (standard, uhd) = update.more_available;
            if standard > 0 {
                self.debug(&format!(
                    "Detected {standard} new standard season(s) for {}",
                    o.title
                ));
            }
            if uhd > 0 {
                self.debug(&format!("Detected {uhd} new 4K season(s) for {}", o.title));
            }
            save_existing(self, media, update.after, update.fresh).await?;
            self.debug(&format!("Updating existing title: {}", o.title));
            return Ok(());
        }
        let row = new_show(tmdb_id, tvdb, seasons, o, self.enable4k_show);
        insert_media(db, &row).await?;
        self.debug(&format!("Saved {}", o.title));
        Ok(())
    }

    /// The ids of the media's approved requests of one quality, as the
    /// `requests` relation holds them when the title is loaded.
    ///
    /// # Errors
    ///
    /// Database errors.
    pub async fn approved_requests(&self, media_id: i64, four_k: bool) -> Result<Vec<i64>> {
        let rows = self
            .job
            .state
            .db
            .rows(
                r#"SELECT CAST(r."id" AS BIGINT) AS "id" FROM "media_request" r WHERE r."mediaId" = ?1 AND r."is4k" = ?2 AND r."status" = ?3 ORDER BY r."id" ASC"#,
                &[Bind::Int(media_id), Bind::Bool(four_k), Bind::Int(APPROVED)],
            )
            .await?;
        Ok(rows
            .iter()
            .filter_map(|r| r.get("id").and_then(Value::as_i64))
            .collect())
    }

    /// `declineOrphanedRequests(media, is4k)` for the requests
    /// [`Self::approved_requests`] found.
    ///
    /// # Errors
    ///
    /// Database errors.
    pub async fn decline_orphaned(&self, media: &MediaRow, requests: &[i64]) -> Result<()> {
        self.decline_requests(media, requests, "not found in any Sonarr/Radarr server")
            .await
    }

    /// Decline these requests of `media`, logging `reason`.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn decline_requests(
        &self,
        media: &MediaRow,
        requests: &[i64],
        reason: &str,
    ) -> Result<()> {
        let lc = lc_of(self);
        let kind = if media.media_type == "movie" {
            "movie"
        } else {
            "series"
        };
        for id in requests {
            let Some(mut entity) = lc.load(*id).await? else {
                continue;
            };
            entity.row.status = DECLINED;
            lc.save(&mut entity).await?;
            self.info(&format!(
                "Declined orphaned {kind} request {id} for {} {reason}.",
                media.tmdb_id
            ));
        }
        Ok(())
    }

    /// `resolveStatusResets`: once every server was scanned, the titles and
    /// seasons the scan found abandoned that no server pursues (as
    /// `abandoned(tmdb id, 4K, season)` tells) fall back to unknown, and
    /// their approved requests are declined or lose those seasons.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn resolve_resets(
        &self,
        abandoned: &(dyn Fn(i64, bool, Option<i64>) -> bool + Send + Sync),
    ) -> Result<()> {
        let Resets { media, seasons } = std::mem::take(&mut *crate::sync::lock(&self.resets));
        let db = &self.job.state.db;
        for (media_id, four_k) in media {
            let Some(found) = db.media_by_ids(&[media_id], true).await?.pop() else {
                continue;
            };
            if !abandoned(found.tmdb_id, four_k, None) {
                continue;
            }
            let status = if four_k { found.status4k } else { found.status };
            // A show's status only changes through its seasons' rollup.
            let found = if found.media_type == "movie" && status == PROCESSING {
                let mut after = found.clone();
                *status_mut(&mut after, four_k) = UNKNOWN;
                save_existing(self, found, after.clone(), Vec::new()).await?;
                after
            } else if status == UNKNOWN {
                found
            } else {
                // Finished or deleted mid-run: no longer this scan's to reset.
                continue;
            };
            let requests = self.approved_requests(found.id, four_k).await?;
            self.decline_requests(
                &found,
                &requests,
                "reset to UNKNOWN after the Sonarr/Radarr entry went unmonitored with nothing downloaded",
            )
            .await?;
        }
        for ((media_id, four_k), (numbers, scanned)) in seasons {
            Box::pin(self.resolve_season_resets(media_id, four_k, &numbers, &scanned, abandoned))
                .await?;
        }
        Ok(())
    }

    async fn resolve_season_resets(
        &self,
        media_id: i64,
        four_k: bool,
        numbers: &BTreeSet<i64>,
        scanned: &[ProcessableSeason],
        abandoned: &(dyn Fn(i64, bool, Option<i64>) -> bool + Send + Sync),
    ) -> Result<()> {
        let db = &self.job.state.db;
        let Some(media) = db.media_by_ids(&[media_id], true).await?.pop() else {
            return Ok(());
        };
        let mut after = media.clone();
        let mut gone = BTreeSet::new();
        let mut reset = false;
        for season in &mut after.seasons {
            if !numbers.contains(&season.season_number)
                || !abandoned(media.tmdb_id, four_k, Some(season.season_number))
            {
                continue;
            }
            let status = if four_k {
                &mut season.status4k
            } else {
                &mut season.status
            };
            if *status == PROCESSING {
                *status = UNKNOWN;
                reset = true;
            } else if *status != UNKNOWN {
                continue;
            }
            gone.insert(season.season_number);
        }
        if gone.is_empty() {
            return Ok(());
        }
        if reset {
            let previous = if four_k { media.status4k } else { media.status };
            let enabled = !four_k || self.enable4k_show;
            let rolled =
                rollup_show_status(&after.seasons, scanned, four_k, Some(previous), enabled);
            *status_mut(&mut after, four_k) = rolled;
        }
        let title_unknown = (if four_k { after.status4k } else { after.status }) == UNKNOWN;
        let requests: Vec<RequestRow> = db
            .requests_of_media(media_id)
            .await?
            .into_iter()
            .filter(|r| r.is4k == four_k && r.status == APPROVED)
            .collect();
        let plan = plan_season_resets(&requests, &gone, title_unknown);
        let lc = lc_of(self);
        for (request_id, removed, kept, completed) in &plan.trim {
            for season_request in removed {
                db.execute(
                    r#"DELETE FROM "season_request" WHERE "id" = ?1"#,
                    &[Bind::Int(*season_request)],
                )
                .await?;
            }
            db.execute(
                r#"UPDATE "media_request" SET "tvQuotaUnits" = ?1 WHERE "id" = ?2"#,
                &[Bind::Int(*kept), Bind::Int(*request_id)],
            )
            .await?;
            self.info(&format!(
                "Removed {} season(s) from series request {request_id} for {} after Sonarr stopped pursuing them.",
                removed.len(),
                media.tmdb_id
            ));
            // Nothing else would complete it: the media row may not change.
            if *completed {
                if let Some(mut entity) = lc.load(*request_id).await? {
                    entity.row.status = COMPLETED;
                    lc.save(&mut entity).await?;
                }
            }
        }
        if reset {
            save_existing(self, media, after.clone(), Vec::new()).await?;
        }
        self.decline_requests(
            &after,
            &plan.decline,
            "after Sonarr stopped pursuing its requested seasons",
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dbtx::scratch;

    #[tokio::test]
    async fn a_new_row_leaves_out_a_taken_tvdb_id() -> Result<()> {
        let scratch = scratch::sqlite("scanmedia-tvdb").await?;
        let db = &scratch.db;
        // TMDB 100 got TVDB 472212 from Sonarr's lookup; TMDB 200 lists it.
        let first = MediaRow {
            media_type: String::from("tv"),
            tmdb_id: 100,
            tvdb_id: Some(472_212),
            status: 1,
            status4k: 1,
            ..MediaRow::default()
        };
        insert_media(db, &first).await?;
        let second = MediaRow {
            tmdb_id: 200,
            ..first.clone()
        };
        insert_media(db, &second).await?;
        assert_eq!(
            scratch::ints(
                db,
                r#"SELECT COALESCE("tvdbId", 0) FROM "media" ORDER BY "tmdbId""#
            )
            .await?,
            vec![472_212, 0]
        );
        Ok(())
    }

    fn season(n: i64, status: i64, status4k: i64) -> SeasonRow {
        SeasonRow {
            id: n + 100,
            season_number: n,
            status,
            status4k,
            ..SeasonRow::default()
        }
    }

    fn scanned(n: i64, total: i64, episodes: i64) -> ProcessableSeason {
        ProcessableSeason {
            season_number: n,
            total_episodes: total,
            episodes,
            ..ProcessableSeason::default()
        }
    }

    fn show(seasons: Vec<SeasonRow>, status: i64) -> MediaRow {
        MediaRow {
            id: 1,
            media_type: String::from("tv"),
            tmdb_id: 5000,
            status,
            status4k: UNKNOWN,
            seasons,
            ..MediaRow::default()
        }
    }

    #[test]
    fn season_transitions() {
        assert_eq!(
            next_season_status(Some(AVAILABLE), 10, 0, true, true, true),
            AVAILABLE,
            "an available season stays available"
        );
        assert_eq!(
            next_season_status(Some(PROCESSING), 10, 0, true, true, false),
            UNKNOWN,
            "processing without files falls back"
        );
        assert_eq!(
            next_season_status(Some(DELETED), 10, 0, true, true, true),
            DELETED,
            "deleted is kept while processing"
        );
        assert_eq!(
            next_season_status(None, 10, 3, true, true, false),
            PARTIAL,
            "partial"
        );
    }

    #[test]
    fn rollup_ignores_specials_and_unknown_sources() {
        let seasons = [
            season(0, AVAILABLE, UNKNOWN),
            season(1, AVAILABLE, UNKNOWN),
            season(2, UNKNOWN, UNKNOWN),
        ];
        assert_eq!(
            rollup_show_status(
                &seasons,
                &[scanned(1, 10, 10), scanned(2, 0, 0)],
                false,
                Some(UNKNOWN),
                true
            ),
            AVAILABLE,
            "only real seasons with source data count"
        );
    }

    // jellyfin.test.ts: empty TMDB season handling.
    #[test]
    fn empty_placeholder_season() {
        let media = show(
            vec![
                season(1, AVAILABLE, UNKNOWN),
                season(2, AVAILABLE, UNKNOWN),
                season(3, UNKNOWN, UNKNOWN),
            ],
            PARTIAL,
        );
        let update = apply_show(
            &media,
            &[scanned(1, 10, 10), scanned(2, 10, 10), scanned(3, 0, 0)],
            &ShowOpts::default(),
            false,
            0,
            false,
        );
        assert_eq!(update.after.status, AVAILABLE, "placeholder ignored");
        assert!(update.fresh.is_empty(), "no season created");
    }

    #[test]
    fn orphan_unknown_season() {
        let media = show(
            vec![season(1, AVAILABLE, UNKNOWN), season(2, UNKNOWN, UNKNOWN)],
            PARTIAL,
        );
        let update = apply_show(
            &media,
            &[scanned(1, 10, 10)],
            &ShowOpts::default(),
            false,
            0,
            false,
        );
        assert_eq!(update.after.status, AVAILABLE, "orphan placeholder ignored");
    }

    #[test]
    fn deleted_season_missing_from_provider() {
        let media = show(
            vec![season(1, AVAILABLE, UNKNOWN), season(2, DELETED, UNKNOWN)],
            PARTIAL,
        );
        let update = apply_show(
            &media,
            &[scanned(1, 10, 10)],
            &ShowOpts::default(),
            false,
            0,
            false,
        );
        assert_eq!(update.after.status, PARTIAL, "stays partially available");
    }

    #[test]
    fn show_updates_keys_dates_and_seasons() {
        let media = show(vec![season(1, PARTIAL, UNKNOWN)], PARTIAL);
        let o = ShowOpts {
            rating_key: Some(String::from("42")),
            media_added_at: Some(1000),
            title: String::from("T"),
            ..ShowOpts::default()
        };
        let update = apply_show(
            &media,
            &[scanned(1, 2, 2), scanned(2, 3, 0)],
            &o,
            false,
            5000,
            false,
        );
        assert_eq!(update.after.rating_key.as_deref(), Some("42"), "rating key");
        assert_eq!(update.more_available, (1, 0), "one more season");
        assert_eq!(
            update.after.last_season_change.as_deref(),
            Some("1970-01-01T00:00:05.000Z"),
            "lastSeasonChange"
        );
        assert_eq!(
            update.after.media_added_at.as_deref(),
            Some("1970-01-01T00:00:01.000Z"),
            "mediaAddedAt"
        );
        assert_eq!(update.fresh.len(), 1, "season 2 created");
        assert_eq!(
            update.after.seasons.get(1).map(|s| (s.status, s.media_id)),
            Some((UNKNOWN, Some(1))),
            "created season"
        );
        assert_eq!(update.after.status, PARTIAL, "season 2 is still missing");
    }

    #[test]
    fn new_show_rows() {
        let o = ShowOpts {
            service_id: Some(3),
            external_service_id: Some(9),
            external_service_slug: Some(String::from("slug")),
            rating_key: Some(String::from("rk")),
            ..ShowOpts::default()
        };
        let mut processing = scanned(1, 10, 0);
        processing.processing = true;
        let row = new_show(7, Some(70), &[processing], &o, false);
        assert_eq!(row.status, PROCESSING, "a monitored empty season");
        assert_eq!(row.rating_key, None, "no rating key without episodes");
        assert_eq!(
            (row.service_id, row.external_service_id, row.service_id4k),
            (Some(3), Some(9), None),
            "service ids"
        );
        let row = new_show(7, None, &[], &ShowOpts::default(), false);
        assert_eq!(row.status, PROCESSING, "nothing scanned is processing");
    }

    fn movie(status: i64) -> MediaRow {
        MediaRow {
            id: 1,
            media_type: String::from("movie"),
            tmdb_id: 1,
            status,
            status4k: UNKNOWN,
            ..MediaRow::default()
        }
    }

    fn radarr(processing: bool, has_file: bool) -> MovieOpts {
        MovieOpts {
            service_id: Some(0),
            external_service_id: Some(5),
            processing,
            has_file,
            ..MovieOpts::new("M")
        }
    }

    // radarr.test.ts: unmonitored movie handling.
    #[test]
    fn radarr_statuses() {
        let (m, _) = apply_movie(&movie(PROCESSING), &radarr(false, false), false);
        assert_eq!(m.status, UNKNOWN, "unmonitored without file resets");
        assert_eq!(
            new_movie(1, &radarr(false, false), false),
            None,
            "not created"
        );
        let (m, _) = apply_movie(&movie(UNKNOWN), &radarr(false, true), false);
        assert_eq!(m.status, AVAILABLE, "file makes it available");
        let (m, _) = apply_movie(&movie(UNKNOWN), &radarr(true, false), false);
        assert_eq!(m.status, PROCESSING, "monitored without file");
        let (m, _) = apply_movie(&movie(DELETED), &radarr(true, false), false);
        assert_eq!(m.status, DELETED, "deleted kept");
        let (m, _) = apply_movie(&movie(AVAILABLE), &radarr(false, false), false);
        assert_eq!(m.status, AVAILABLE, "available kept");
        let created = new_movie(1, &radarr(true, false), false);
        assert_eq!(
            created.map(|m| (m.status, m.service_id, m.external_service_id)),
            Some((PROCESSING, Some(0), Some(5))),
            "created processing"
        );
    }

    // radarr.test.ts / sonarr.test.ts: resets settled at the end of a run.
    #[test]
    fn arr_scans_leave_abandoned_titles_for_the_end_of_the_run() {
        let mut processing = movie(PROCESSING);
        processing.service_id = Some(1);
        let o = radarr(false, false);
        assert!(movie_reset_deferred(&processing, &o, true), "deferred");
        let (m, _) = apply_movie(&processing, &o, true);
        assert_eq!(m.status, PROCESSING, "still processing until the run ends");
        assert_eq!(m.service_id, Some(1), "the entry doesn't claim the server");
        assert!(
            !movie_reset_deferred(&processing, &o, false),
            "a library scan doesn't defer"
        );
        assert!(
            !movie_reset_deferred(&processing, &radarr(true, false), true),
            "a monitored entry isn't abandoned"
        );

        let media = show(vec![season(1, PROCESSING, UNKNOWN)], PROCESSING);
        let o = ShowOpts {
            service_id: Some(3),
            ..ShowOpts::default()
        };
        let idle = scanned(1, 10, 0);
        let update = apply_show(&media, std::slice::from_ref(&idle), &o, false, 0, true);
        assert_eq!(
            update.after.seasons.first().map(|s| s.status),
            Some(PROCESSING)
        );
        assert_eq!(
            update.deferred_seasons,
            vec![(1, false)],
            "the season waits"
        );
        assert_eq!(update.after.status, PROCESSING, "and so does the title");
        assert_eq!(update.after.service_id, None, "no server claimed");
        let update = apply_show(&media, &[idle], &o, false, 0, false);
        assert_eq!(
            update.after.status, UNKNOWN,
            "a library scan resets at once"
        );
        assert!(update.deferred_seasons.is_empty() && update.status_resets.is_empty());
    }

    #[test]
    fn abandoned_seasons_trim_or_decline_requests() {
        let season_request = |id: i64, number: i64, status: i64| crate::db::SeasonRequestRow {
            id,
            season_number: number,
            status,
            ..Default::default()
        };
        let request = |id: i64, seasons: Vec<crate::db::SeasonRequestRow>| RequestRow {
            id,
            seasons,
            ..Default::default()
        };
        let requests = [
            request(1, vec![season_request(11, 2, APPROVED)]),
            request(
                2,
                vec![
                    season_request(21, 1, COMPLETED),
                    season_request(22, 2, APPROVED),
                ],
            ),
            request(3, vec![season_request(31, 3, APPROVED)]),
        ];
        let abandoned = BTreeSet::from([2]);
        assert_eq!(
            plan_season_resets(&requests, &abandoned, false),
            SeasonResetPlan {
                decline: vec![1],
                trim: vec![(2, vec![22], 1, true)],
            },
            "only season 2 was abandoned"
        );
        assert_eq!(
            plan_season_resets(&requests, &abandoned, true).decline,
            vec![1, 2, 3],
            "the title fell back to unknown: every request goes"
        );
    }

    #[test]
    fn movie_changes() {
        let mut existing = movie(AVAILABLE);
        existing.rating_key = Some(String::from("1"));
        let mut o = MovieOpts::new("M");
        o.rating_key = Some(String::from("1"));
        let (_, changed) = apply_movie(&existing, &o, false);
        assert!(!changed, "same key");
        o.media_added_at = Some(0);
        let (m, changed) = apply_movie(&existing, &o, false);
        assert!(changed, "missing mediaAddedAt filled");
        assert_eq!(
            m.media_added_at.as_deref(),
            Some("1970-01-01T00:00:00.000Z"),
            "date"
        );
        o.is4k = true;
        let created = new_movie(2, &o, false);
        assert_eq!(
            created.map(|m| (m.status, m.status4k, m.rating_key, m.rating_key4k)),
            Some((UNKNOWN, UNKNOWN, None, None)),
            "4K without 4K servers"
        );
    }
}
