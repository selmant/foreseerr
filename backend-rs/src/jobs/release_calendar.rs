//! `release-calendar-sync`: `server/lib/releases/sync.ts` with
//! `normalization.ts` and `state.ts`.
//!
//! Each Radarr and Sonarr server's calendar is fetched under a
//! database lease (`release_sync_state`), reconciled into
//! `release_occurrence` (`release_store`) and the date changes and season
//! premieres it found are notified.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Result};
use reqwest::Method;
use serde_json::{Map, Value};

use super::release_store::{self, Reconcile, SyncResult};
use super::syncutil::{axios_message, date, int, iso, now_ms, parse_js_date, text};
use super::JobCtx;
use crate::db::{Bind, Db};
use crate::episodeorder::AiredNumbers;
use crate::settings::public::truthy;

/// `RELEASE_SYNC_LEASE_MS`.
const LEASE_MS: i64 = 30 * 60 * 1000;
const DAY_MS: i64 = 86_400_000;
const INCREMENTAL_PAST_DAYS: i64 = 7;
const INCREMENTAL_FUTURE_DAYS: i64 = 45;
const BACKFILL_PAST_DAYS: i64 = 30;
const BACKFILL_FUTURE_DAYS: i64 = 365;
const ALL_DAY_CHANGE_HOURS: i64 = 24;
const TIMED_CHANGE_HOURS: i64 = 12;

static RUNNING: AtomicBool = AtomicBool::new(false);
/// `sourceStatuses`: `source:serverId` → status, in first-seen order.
static SOURCE_STATUSES: LazyLock<Mutex<Vec<(String, Value)>>> =
    LazyLock::new(|| Mutex::new(Vec::new()));

/// `releaseCalendarSync.getSourceStatuses()` as `res.json` prints it (what
/// `GET /internal/calendar/source-statuses` answers in Node).
#[must_use]
pub fn source_statuses() -> Vec<Value> {
    crate::sync::lock(&SOURCE_STATUSES)
        .iter()
        .map(|(_, v)| v.clone())
        .collect()
}

fn set_source_status(key: String, status: Value) {
    let mut statuses = crate::sync::lock(&SOURCE_STATUSES);
    if let Some(slot) = statuses.iter_mut().find(|(k, _)| *k == key) {
        slot.1 = status;
    } else {
        statuses.push((key, status));
    }
}

/// `releaseCalendarSync.running`.
#[must_use]
pub fn running() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

/// `ReleaseSyncMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// `incremental`.
    Incremental,
    /// `backfill`.
    Backfill,
}

/// `calendarWindow(mode, now)`: `(start, end)` in epoch milliseconds.
#[must_use]
pub const fn calendar_window(mode: Mode, now: i64) -> (i64, i64) {
    let (past, future) = match mode {
        Mode::Backfill => (BACKFILL_PAST_DAYS, BACKFILL_FUTURE_DAYS),
        Mode::Incremental => (INCREMENTAL_PAST_DAYS, INCREMENTAL_FUTURE_DAYS),
    };
    (now - past * DAY_MS, now + future * DAY_MS)
}

/// `releaseSyncMode(state, now)`.
#[must_use]
pub const fn release_sync_mode(last_backfill: Option<i64>, now: i64) -> Mode {
    match last_backfill {
        Some(at) if now - at < DAY_MS => Mode::Incremental,
        _ => Mode::Backfill,
    }
}

/// An occurrence's `monitored`, `hasFile` and `is4k`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Flags {
    /// `monitored`.
    pub monitored: bool,
    /// `hasFile`.
    pub has_file: bool,
    /// `is4k`.
    pub is4k: bool,
}

/// `NormalizedOccurrence`. The optional columns are `None` where Node's
/// object leaves the property `undefined` (a save then leaves the column
/// as it is) and `Some(Value::Null)` where it is `null`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Normalized {
    /// `radarr` or `sonarr`.
    pub source: &'static str,
    /// `sourceServerId`.
    pub server_id: i64,
    /// `sourceItemId`.
    pub item_id: i64,
    /// `sourceSeriesId` (Sonarr only).
    pub series_id: Option<Value>,
    /// `sourceSeriesTvdbId` (not persisted).
    pub series_tvdb_id: Option<i64>,
    /// `movie` or `tv`.
    pub media_type: &'static str,
    /// `tmdbId` (Radarr only).
    pub tmdb_id: Option<Value>,
    /// `tvdbId` (Sonarr only).
    pub tvdb_id: Option<Value>,
    /// `title`.
    pub title: Option<Value>,
    /// `subtitle` (Sonarr only).
    pub subtitle: Option<Value>,
    /// `seasonNumber` (Sonarr only).
    pub season: Option<Value>,
    /// `episodeNumber` (Sonarr only).
    pub episode: Option<Value>,
    /// `dateType`.
    pub date_type: &'static str,
    /// `startsAt`.
    pub starts_at: i64,
    /// `allDay`.
    pub all_day: bool,
    /// `monitored`, `hasFile` and `is4k`.
    pub flags: Flags,
    /// `sourceUrl`; `None` when the URL can't be built.
    pub source_url: Option<String>,
    /// `rawDates`.
    pub raw_dates: String,
    /// The episode's aired-order numbers (not persisted).
    pub aired: Aired,
}

/// Where a Sonarr episode sits in the aired order, which season premieres
/// are told in.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Aired {
    /// Sonarr numbers it in aired order (and a movie has no numbers).
    #[default]
    AsNumbered,
    /// Its aired season and episode; Sonarr numbers it in another order.
    Mapped(i64, i64),
    /// Sonarr numbers it in another order and its aired place is unknown.
    Unknown,
    /// Sonarr numbers it in another order and TVDB, which knows its aired
    /// place, couldn't be asked: a new one more than two days off waits for
    /// a run that can place it, so its season premiere isn't missed.
    Unchecked,
}

impl Normalized {
    /// `occurrenceKey`.
    #[must_use]
    pub fn key(&self) -> String {
        format!("{}:{}", self.item_id, self.date_type)
    }
}

/// `parseProviderDate(value)`: the moment and whether it is a date alone.
#[must_use]
pub fn parse_provider_date(value: Option<&str>) -> Option<(i64, bool)> {
    let value = value.filter(|v| !v.is_empty())?;
    let starts_at = parse_js_date(value)?;
    let date_only = value.len() == 10
        && value.bytes().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        });
    Some((starts_at, date_only))
}

/// `isMaterialDateChange(existing, next)`.
#[must_use]
pub const fn is_material_date_change(existing: (i64, bool), next: (i64, bool)) -> bool {
    let hours = if existing.1 || next.1 {
        ALL_DAY_CHANGE_HOURS
    } else {
        TIMED_CHANGE_HOURS
    };
    (existing.0 - next.0).abs() >= hours * 3_600_000
}

/// `sourceUrl(server, path)`.
fn source_url(server: &Value, path: &str) -> Option<String> {
    let base = match server.get("externalUrl") {
        None | Some(Value::Null) => format!(
            "{}://{}:{}{}",
            if truthy(server.get("useSsl")) {
                "https"
            } else {
                "http"
            },
            crate::media::js_string(server.get("hostname")),
            crate::media::js_string(server.get("port")),
            match server.get("baseUrl") {
                None | Some(Value::Null) => std::borrow::Cow::Borrowed(""),
                other => crate::media::js_string(other),
            }
        ),
        other => crate::media::js_string(other).into_owned(),
    };
    let base = format!("{}/", base.strip_suffix('/').unwrap_or(&base));
    let path = path.strip_prefix('/').unwrap_or(path);
    reqwest::Url::parse(&base)
        .and_then(|b| b.join(path))
        .ok()
        .map(|u| u.to_string())
}

/// `JSON.stringify` of the named properties that are present.
fn raw_dates(item: &Value, keys: &[&str]) -> String {
    let mut out = Map::new();
    for key in keys {
        if let Some(v) = item.get(*key) {
            out.insert((*key).to_owned(), v.clone());
        }
    }
    Value::Object(out).to_string()
}

/// `a || b` for the slug of a URL path.
fn slug_or(slug: Option<&Value>, id: Option<&Value>) -> String {
    if truthy(slug) {
        crate::media::js_string(slug).into_owned()
    } else {
        crate::media::js_string(id).into_owned()
    }
}

/// `normalizeRadarrMovie(movie, server)`.
#[must_use]
pub fn normalize_radarr_movie(movie: &Value, server: &Value) -> Vec<Normalized> {
    let raw = raw_dates(movie, &["inCinemas", "digitalRelease", "physicalRelease"]);
    let server_id = server.get("id").and_then(Value::as_i64).unwrap_or(0);
    let is4k = truthy(server.get("is4k"));
    let url = source_url(
        server,
        &format!(
            "/movie/{}",
            slug_or(movie.get("titleSlug"), movie.get("id"))
        ),
    );
    let mut out = Vec::new();
    for (date_type, key) in [
        ("digital", "digitalRelease"),
        ("physical", "physicalRelease"),
        ("theatrical", "inCinemas"),
    ] {
        let Some((starts_at, all_day)) =
            parse_provider_date(movie.get(key).and_then(Value::as_str))
        else {
            continue;
        };
        out.push(Normalized {
            source: "radarr",
            server_id,
            item_id: movie.get("id").and_then(Value::as_i64).unwrap_or(0),
            series_id: None,
            series_tvdb_id: None,
            media_type: "movie",
            tmdb_id: movie.get("tmdbId").cloned(),
            tvdb_id: None,
            title: movie.get("title").cloned(),
            subtitle: None,
            season: None,
            episode: None,
            date_type,
            starts_at,
            all_day,
            flags: Flags {
                monitored: truthy(movie.get("monitored")),
                has_file: truthy(movie.get("hasFile")) || truthy(movie.get("isAvailable")),
                is4k,
            },
            source_url: url.clone(),
            raw_dates: raw.clone(),
            aired: Aired::AsNumbered,
        });
    }
    out
}

/// `normalizeSonarrEpisode(episode, server)`.
#[must_use]
pub fn normalize_sonarr_episode(episode: &Value, server: &Value) -> Option<Normalized> {
    let utc = episode.get("airDateUtc").filter(|v| truthy(Some(v)));
    let value = utc.or_else(|| episode.get("airDate"));
    let (starts_at, all_day) = parse_provider_date(value.and_then(Value::as_str))?;
    let series = episode.get("series").filter(|s| !s.is_null());
    let series_field = |key: &str| series.and_then(|s| s.get(key));
    let title = match series_field("title") {
        None | Some(Value::Null) => Value::from("Unknown series"),
        Some(v) => v.clone(),
    };
    let series_monitored = match series_field("monitored") {
        None | Some(Value::Null) => true,
        Some(v) => truthy(Some(v)),
    };
    Some(Normalized {
        source: "sonarr",
        server_id: server.get("id").and_then(Value::as_i64).unwrap_or(0),
        item_id: episode.get("id").and_then(Value::as_i64).unwrap_or(0),
        series_id: episode.get("seriesId").cloned(),
        series_tvdb_id: series_field("tvdbId").and_then(Value::as_i64),
        media_type: "tv",
        tmdb_id: None,
        tvdb_id: episode.get("tvdbId").cloned(),
        title: Some(title),
        subtitle: episode.get("title").cloned(),
        season: episode.get("seasonNumber").cloned(),
        episode: episode.get("episodeNumber").cloned(),
        date_type: "air",
        starts_at,
        all_day,
        flags: Flags {
            monitored: truthy(episode.get("monitored")) && series_monitored,
            has_file: truthy(episode.get("hasFile")),
            is4k: truthy(server.get("is4k")),
        },
        source_url: source_url(
            server,
            &format!(
                "/series/{}",
                slug_or(series_field("titleSlug"), episode.get("seriesId"))
            ),
        ),
        raw_dates: raw_dates(episode, &["airDate", "airDateUtc"]),
        aired: Aired::AsNumbered,
    })
}

/// The aired place of each calendar episode of a series Sonarr numbers in
/// another order than the aired one, from the TVDB catalog of the series
/// (loaded once per series).
async fn place_in_aired_order(job: &JobCtx, episodes: &[Value], occurrences: &mut [Normalized]) {
    let mut catalogs: Vec<(i64, Option<AiredNumbers>)> = Vec::new();
    for (episode, occurrence) in episodes.iter().zip(occurrences.iter_mut()) {
        let Some(series) = episode.get("series") else {
            continue;
        };
        if crate::episodeorder::other_order(series).is_none() {
            continue;
        }
        let Some(tvdb_id) = series.get("tvdbId").and_then(Value::as_i64) else {
            occurrence.aired = Aired::Unknown;
            continue;
        };
        if !catalogs.iter().any(|(id, _)| *id == tvdb_id) {
            let numbers = match crate::episodeorder::aired_catalog(&job.state.outbound, tvdb_id)
                .await
            {
                Ok(catalog) => Some(crate::episodeorder::aired_numbers(&catalog)),
                Err(e) => {
                    tracing::warn!(
                        label = "Release Calendar Sync",
                        tvdb_id,
                        error_message = %format!("{e:#}"),
                        "Failed to load the aired episode order of a series Sonarr numbers in another order; its new calendar entries more than two days off wait for a run that can check them for season premieres"
                    );
                    None
                }
            };
            catalogs.push((tvdb_id, numbers));
        }
        let numbers = catalogs
            .iter()
            .find(|(id, _)| *id == tvdb_id)
            .and_then(|(_, numbers)| numbers.as_ref());
        occurrence.aired = placed(numbers, episode.get("tvdbId").and_then(Value::as_i64));
    }
}

/// An episode's aired place from its series' aired numbers (`None` when
/// TVDB couldn't be asked).
fn placed(numbers: Option<&AiredNumbers>, tvdb_id: Option<i64>) -> Aired {
    let Some(numbers) = numbers else {
        return Aired::Unchecked;
    };
    match tvdb_id.and_then(|t| numbers.get(&t)) {
        Some(&(season, episode)) => Aired::Mapped(season, episode),
        None => Aired::Unknown,
    }
}

/// A held lease: the source row, owner and fence.
#[derive(Debug, Clone)]
pub struct Lease {
    /// `radarr` or `sonarr`.
    pub source: &'static str,
    /// `sourceServerId`.
    pub server_id: i64,
    /// `${pid}:${uuid}`.
    pub owner: String,
    /// `leaseFence`.
    pub fence: i64,
}

fn expiry_sql(db: &Db) -> String {
    let seconds = (LEASE_MS + 999) / 1000;
    if db.is_postgres() {
        format!("CURRENT_TIMESTAMP + INTERVAL '{seconds} seconds'")
    } else {
        format!("datetime('now', '+{seconds} seconds')")
    }
}

/// `getReleaseSyncState`.
async fn state_row(db: &Db, source: &str, server_id: i64) -> Result<Map<String, Value>> {
    let sql = format!(
        r#"SELECT CAST("leaseFence" AS BIGINT) AS "leaseFence", "leaseOwner", {} AS "leaseExpiresAt", {} AS "lastSuccessfulBackfillAt" FROM "release_sync_state" WHERE "source" = ?1 AND "sourceServerId" = ?2 LIMIT 1"#,
        db.iso_sql(r#""leaseExpiresAt""#),
        db.iso_sql(r#""lastSuccessfulBackfillAt""#)
    );
    db.rows(&sql, &[Bind::Text(source.to_owned()), Bind::Int(server_id)])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("no release sync state row"))
}

/// `acquireReleaseSyncLease`.
async fn acquire(
    db: &Db,
    source: &'static str,
    server_id: i64,
    owner: String,
) -> Result<Option<Lease>> {
    db.execute(
        r#"INSERT INTO "release_sync_state" ("source", "sourceServerId") VALUES (?1, ?2) ON CONFLICT ("source", "sourceServerId") DO NOTHING"#,
        &[Bind::Text(source.to_owned()), Bind::Int(server_id)],
    )
    .await?;
    state_row(db, source, server_id).await?;
    let sql = format!(
        r#"UPDATE "release_sync_state" SET "leaseOwner" = ?1, "leaseExpiresAt" = {}, "leaseFence" = "leaseFence" + 1 WHERE "source" = ?2 AND "sourceServerId" = ?3 AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= CURRENT_TIMESTAMP)"#,
        expiry_sql(db)
    );
    let affected = db
        .execute(
            &sql,
            &[
                Bind::Text(owner.clone()),
                Bind::Text(source.to_owned()),
                Bind::Int(server_id),
            ],
        )
        .await?;
    if affected != 1 {
        return Ok(None);
    }
    let row = state_row(db, source, server_id).await?;
    if text(&row, "leaseOwner").as_deref() == Some(owner.as_str())
        && date(&row, "leaseExpiresAt").is_some()
    {
        Ok(Some(Lease {
            source,
            server_id,
            owner,
            fence: int(&row, "leaseFence").unwrap_or(0),
        }))
    } else {
        Ok(None)
    }
}

fn fenced_binds(lease: &Lease, first: usize) -> (String, Vec<Bind>) {
    (
        format!(
            r#""source" = ?{} AND "sourceServerId" = ?{} AND "leaseOwner" = ?{} AND "leaseFence" = ?{}"#,
            first,
            first + 1,
            first + 2,
            first + 3
        ),
        vec![
            Bind::Text(lease.source.to_owned()),
            Bind::Int(lease.server_id),
            Bind::Text(lease.owner.clone()),
            Bind::Int(lease.fence),
        ],
    )
}

/// `renewReleaseSyncLease`.
///
/// # Errors
///
/// Fails on database errors.
pub async fn renew(db: &Db, lease: &Lease) -> Result<bool> {
    let (fenced, binds) = fenced_binds(lease, 1);
    let sql = format!(
        r#"UPDATE "release_sync_state" SET "leaseExpiresAt" = {} WHERE {fenced} AND "leaseExpiresAt" > CURRENT_TIMESTAMP"#,
        expiry_sql(db)
    );
    Ok(db.execute(&sql, &binds).await? == 1)
}

/// `assertReleaseSyncLease` outside a transaction.
async fn assert_lease(db: &Db, lease: &Lease) -> Result<()> {
    let (fenced, binds) = fenced_binds(lease, 1);
    let sql = format!(
        r#"SELECT CAST("id" AS BIGINT) AS "id" FROM "release_sync_state" "state" WHERE {fenced} AND "state"."leaseExpiresAt" > CURRENT_TIMESTAMP LIMIT 1"#
    );
    if db.rows(&sql, &binds).await?.is_empty() {
        return Err(anyhow!("Release calendar sync lease is no longer owned"));
    }
    Ok(())
}

/// The fenced-row condition and binds, for `release_store`.
#[must_use]
pub fn lease_condition(lease: &Lease) -> (String, Vec<Bind>) {
    fenced_binds(lease, 1)
}

async fn release(db: &Db, lease: &Lease) -> Result<()> {
    let (fenced, binds) = fenced_binds(lease, 1);
    db.execute(
        &format!(
            r#"UPDATE "release_sync_state" SET "leaseOwner" = NULL, "leaseExpiresAt" = NULL WHERE {fenced}"#
        ),
        &binds,
    )
    .await?;
    Ok(())
}

async fn mark_success(db: &Db, lease: &Lease, mode: Mode) -> Result<()> {
    let column = match mode {
        Mode::Backfill => "lastSuccessfulBackfillAt",
        Mode::Incremental => "lastSuccessfulIncrementalAt",
    };
    let (fenced, binds) = fenced_binds(lease, 1);
    let sql = format!(
        r#"UPDATE "release_sync_state" SET "{column}" = CURRENT_TIMESTAMP, "lastErrorAt" = NULL, "lastError" = NULL WHERE {fenced} AND "leaseExpiresAt" > CURRENT_TIMESTAMP"#
    );
    if db.execute(&sql, &binds).await? != 1 {
        return Err(anyhow!(
            "Release calendar sync lease was lost before completion"
        ));
    }
    Ok(())
}

async fn mark_error(db: &Db, lease: &Lease, message: &str) -> Result<()> {
    let (fenced, mut binds) = fenced_binds(lease, 2);
    let mut all = vec![Bind::Text(message.chars().take(2048).collect())];
    all.append(&mut binds);
    let sql = format!(
        r#"UPDATE "release_sync_state" SET "lastErrorAt" = CURRENT_TIMESTAMP, "lastError" = ?1 WHERE {fenced} AND "leaseExpiresAt" > CURRENT_TIMESTAMP"#
    );
    db.execute(&sql, &all).await?;
    Ok(())
}

/// `crypto.randomUUID()`.
fn random_uuid() -> String {
    use rand::Rng;
    let mut bytes: [u8; 16] = rand::thread_rng().gen();
    if let Some(b) = bytes.get_mut(6) {
        *b = (*b & 0x0f) | 0x40;
    }
    if let Some(b) = bytes.get_mut(8) {
        *b = (*b & 0x3f) | 0x80;
    }
    let hex: String = bytes
        .iter()
        .flat_map(|b| [b >> 4, b & 0x0f])
        .filter_map(|n| char::from_digit(u32::from(n), 16))
        .collect();
    format!(
        "{}-{}-{}-{}-{}",
        hex.get(0..8).unwrap_or(""),
        hex.get(8..12).unwrap_or(""),
        hex.get(12..16).unwrap_or(""),
        hex.get(16..20).unwrap_or(""),
        hex.get(20..32).unwrap_or("")
    )
}

/// `releaseCalendarSync.run()`.
///
/// # Errors
///
/// A database error recording a server's failure.
pub async fn run(job: &JobCtx) -> Result<()> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let _running = super::Running::new(&RUNNING, job);
    run_servers(job).await
}

async fn run_servers(job: &JobCtx) -> Result<()> {
    let mut result = SyncResult::default();
    let mut sources: Vec<(&'static str, Value)> = Vec::new();
    for source in ["radarr", "sonarr"] {
        if let Some(Value::Array(servers)) = job.settings.get(&format!("/{source}")) {
            sources.extend(servers.iter().map(|s| (source, s.clone())));
        }
    }
    for (source, server) in &sources {
        if job.cancelled() {
            break;
        }
        sync_server(job, source, server, &mut result).await?;
    }
    tracing::info!(
        label = "Release Calendar Sync",
        fetched = result.fetched,
        inserted = result.inserted,
        changed = result.changed,
        missing = result.missing,
        unmapped = result.unmapped,
        errored = result.errored,
        cancelled = job.cancelled(),
        "Release calendar sync finished"
    );
    Ok(())
}

async fn sync_server(
    job: &JobCtx,
    source: &'static str,
    server: &Value,
    result: &mut SyncResult,
) -> Result<()> {
    let db = &job.state.db;
    let server_id = server.get("id").and_then(Value::as_i64).unwrap_or(0);
    let owner = format!("{}:{}", std::process::id(), random_uuid());
    let mut lease: Option<Lease> = None;
    let outcome = async {
        let Some(held) = acquire(db, source, server_id, owner).await? else {
            tracing::debug!(
                label = "Release Calendar Sync",
                source,
                server_id,
                "Release calendar sync skipped; source lease is held"
            );
            return Ok(None);
        };
        lease = Some(held.clone());
        sync_held(job, source, server, &held, result)
            .await
            .map(Some)
    }
    .await;
    match outcome {
        Ok(Some(mode)) => {
            let now = iso(now_ms());
            let mut status = Map::new();
            status.insert(String::from("source"), Value::from(source));
            status.insert(String::from("serverId"), Value::from(server_id));
            status.insert(String::from("lastSuccessAt"), Value::from(now.clone()));
            if mode == Mode::Backfill {
                status.insert(String::from("lastBackfillAt"), Value::from(now));
            }
            set_source_status(format!("{source}:{server_id}"), Value::Object(status));
        }
        Ok(None) => {}
        Err(e) => {
            result.errored += 1;
            let message = e.to_string();
            let recorded = match &lease {
                Some(l) => mark_error(db, l, &message).await,
                None => Ok(()),
            };
            let mut status = Map::new();
            status.insert(String::from("source"), Value::from(source));
            status.insert(String::from("serverId"), Value::from(server_id));
            status.insert(String::from("lastErrorAt"), Value::from(iso(now_ms())));
            status.insert(String::from("error"), Value::from(message.clone()));
            set_source_status(format!("{source}:{server_id}"), Value::Object(status));
            tracing::warn!(
                label = "Release Calendar Sync",
                source,
                server_id,
                server_name = %crate::media::js_string(server.get("name")),
                endpoint = "/calendar",
                error_message = %message,
                "Release calendar sync failed for {source} server"
            );
            if let Err(e) = recorded {
                if let Some(l) = &lease {
                    release(db, l).await?;
                }
                return Err(e);
            }
        }
    }
    if let Some(l) = &lease {
        release(db, l).await?;
    }
    Ok(())
}

/// The work under a held lease; the mode it ran in.
async fn sync_held(
    job: &JobCtx,
    source: &'static str,
    server: &Value,
    lease: &Lease,
    result: &mut SyncResult,
) -> Result<Mode> {
    let db = &job.state.db;
    let state = state_row(db, source, lease.server_id).await?;
    let last_backfill = date(&state, "lastSuccessfulBackfillAt");
    let mode = release_sync_mode(last_backfill, now_ms());
    let (start, end) = calendar_window(mode, now_ms());
    let (occurrences, renewal) = fetch_with_renewal(job, source, server, lease, start, end).await;
    let occurrences = occurrences?;
    if !renewal || !renew(db, lease).await? {
        return Err(anyhow!(
            "Release calendar sync lease was lost before reconcile"
        ));
    }
    result.fetched += i64::try_from(occurrences.len()).unwrap_or(0);
    let events = release_store::reconcile(
        &job.state,
        Reconcile {
            source,
            server_id: lease.server_id,
            occurrences: &occurrences,
            start,
            end,
            initial_backfill: mode == Mode::Backfill && last_backfill.is_none(),
            lease: Some(lease),
        },
        result,
    )
    .await?;
    if !renew(db, lease).await? {
        return Err(anyhow!(
            "Release calendar sync lease was lost before notifications"
        ));
    }
    assert_lease(db, lease).await?;
    release_store::produce_events(job, &events).await;
    mark_success(db, lease, mode).await?;
    Ok(mode)
}

/// The calendar fetch, renewing the lease every ten minutes meanwhile;
/// with the last renewal's result.
async fn fetch_with_renewal(
    job: &JobCtx,
    source: &'static str,
    server: &Value,
    lease: &Lease,
    start: i64,
    end: i64,
) -> (Result<Vec<Normalized>>, bool) {
    let fetch = fetch_occurrences(job, source, server, start, end);
    tokio::pin!(fetch);
    let period = Duration::from_millis(u64::try_from(LEASE_MS / 3).unwrap_or(600_000));
    let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
    let mut renewal = true;
    loop {
        tokio::select! {
            fetched = &mut fetch => return (fetched, renewal),
            _ = ticker.tick() => {
                renewal = renew(&job.state.db, lease).await.unwrap_or(false);
            }
        }
    }
}

/// `fetchOccurrences`.
async fn fetch_occurrences(
    job: &JobCtx,
    source: &'static str,
    server: &Value,
    start: i64,
    end: i64,
) -> Result<Vec<Normalized>> {
    let timeout = crate::servarr::api_timeout(&job.settings);
    let client = &job.state.servarr;
    let query = [
        ("start", iso(start)),
        ("end", iso(end)),
        ("unmonitored", String::from("true")),
    ];
    let label = if source == "radarr" {
        "Radarr"
    } else {
        "Sonarr"
    };
    let items = client
        .call(server, Method::GET, "/calendar", &query, None, timeout)
        .await
        .map_err(|e| {
            anyhow!(
                "[{label}] Failed to retrieve calendar: {}",
                axios_message(&e)
            )
        })?;
    let items = match items {
        Value::Array(items) => items,
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) | Value::Object(_) => {
            Vec::new()
        }
    };
    if source == "radarr" {
        return Ok(items
            .iter()
            .flat_map(|m| normalize_radarr_movie(m, server))
            .collect());
    }
    let items = enrich_series(job, server, items, timeout).await;
    let (items, mut occurrences): (Vec<Value>, Vec<Normalized>) = items
        .into_iter()
        .filter_map(|e| {
            let occurrence = normalize_sonarr_episode(&e, server)?;
            Some((e, occurrence))
        })
        .unzip();
    place_in_aired_order(job, &items, &mut occurrences).await;
    Ok(occurrences)
}

/// The series of calendar episodes Sonarr sent without one, fetched once
/// per series.
async fn enrich_series(
    job: &JobCtx,
    server: &Value,
    mut episodes: Vec<Value>,
    timeout: Option<Duration>,
) -> Vec<Value> {
    let mut missing: Vec<Value> = Vec::new();
    let mut seen = HashSet::new();
    for episode in &episodes {
        if !truthy(episode.get("series")) {
            let id = episode.get("seriesId").cloned().unwrap_or(Value::Null);
            if seen.insert(id.to_string()) {
                missing.push(id);
            }
        }
    }
    let mut found: Vec<(Value, Value)> = Vec::new();
    for series_id in missing {
        let path = format!("/series/{}", crate::media::js_string(Some(&series_id)));
        match job
            .state
            .servarr
            .call(server, Method::GET, &path, &[], None, timeout)
            .await
        {
            Ok(series) => {
                let mut s = Map::new();
                s.insert(
                    String::from("id"),
                    match series.get("id") {
                        None | Some(Value::Null) => series_id.clone(),
                        Some(v) => v.clone(),
                    },
                );
                for key in ["title", "tvdbId", "monitored", "titleSlug", "seasonType"] {
                    if let Some(v) = series.get(key) {
                        s.insert(key.to_owned(), v.clone());
                    }
                }
                found.push((series_id, Value::Object(s)));
            }
            Err(e) => tracing::warn!(
                label = "Sonarr API",
                error_message = %format!("[Sonarr] Failed to retrieve series by ID: {}", axios_message(&e)),
                series_id = %series_id,
                "Failed to enrich Sonarr calendar episode series"
            ),
        }
    }
    for episode in &mut episodes {
        if truthy(episode.get("series")) {
            continue;
        }
        let id = episode.get("seriesId").cloned().unwrap_or(Value::Null);
        if let (Some((_, series)), Value::Object(map)) =
            (found.iter().find(|(k, _)| *k == id), &mut *episode)
        {
            map.insert(String::from("series"), series.clone());
        }
    }
    episodes
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn server() -> Value {
        json!({"id": 2, "is4k": false, "externalUrl": "https://servarr.example/base"})
    }

    #[test]
    fn aired_places() {
        let numbers: AiredNumbers = std::iter::once((501, (2, 1))).collect();
        assert_eq!(
            placed(Some(&numbers), Some(501)),
            Aired::Mapped(2, 1),
            "placed"
        );
        assert_eq!(
            placed(Some(&numbers), Some(9)),
            Aired::Unknown,
            "not in the aired order"
        );
        assert_eq!(
            placed(None, Some(501)),
            Aired::Unchecked,
            "TVDB down: checked again later"
        );
    }

    #[test]
    fn provider_dates() {
        assert_eq!(
            parse_provider_date(Some("2026-08-04")).map(|(ms, all)| (iso(ms), all)),
            Some((String::from("2026-08-04T00:00:00.000Z"), true)),
            "date-only is all-day"
        );
        assert_eq!(parse_provider_date(Some("not-a-date")), None, "invalid");
        assert_eq!(
            parse_provider_date(Some("2026-10-01T18:00:00Z")).map(|(ms, all)| (iso(ms), all)),
            Some((String::from("2026-10-01T18:00:00.000Z"), false)),
            "timed UTC"
        );
    }

    #[test]
    fn material_changes() {
        let base = parse_js_date("2026-08-04T00:00:00.000Z").unwrap_or(0);
        let later = parse_js_date("2026-08-04T12:00:00.000Z").unwrap_or(0);
        assert!(
            !is_material_date_change((base, true), (later, true)),
            "a day for all-day"
        );
        assert!(
            is_material_date_change((base, false), (later, false)),
            "twelve hours"
        );
    }

    #[test]
    fn radarr_dates_and_urls() {
        let movie = json!({
            "id": 3, "tmdbId": 4, "title": "Example Movie", "titleSlug": "example-movie",
            "monitored": true, "hasFile": false, "isAvailable": false,
            "digitalRelease": "2026-09-01", "inCinemas": "2026-08-01"
        });
        let occ = normalize_radarr_movie(&movie, &server());
        let kinds: Vec<(&str, bool)> = occ.iter().map(|o| (o.date_type, o.all_day)).collect();
        assert_eq!(
            kinds,
            vec![("digital", true), ("theatrical", true)],
            "populated dates"
        );
        assert_eq!(
            occ.first().and_then(|o| o.source_url.clone()),
            Some(String::from(
                "https://servarr.example/base/movie/example-movie"
            )),
            "external url"
        );
        assert_eq!(
            occ.first().map(|o| o.raw_dates.clone()),
            Some(String::from(
                r#"{"inCinemas":"2026-08-01","digitalRelease":"2026-09-01"}"#
            )),
            "raw dates keep present keys"
        );
    }

    #[test]
    fn sonarr_episode() {
        let episode = json!({
            "id": 5, "seriesId": 6, "tvdbId": 7, "title": "Premiere", "seasonNumber": 2,
            "episodeNumber": 1, "airDateUtc": "2026-10-01T18:00:00Z", "monitored": true,
            "hasFile": false,
            "series": {"tvdbId": 8, "title": "Example Series", "titleSlug": "example-series", "monitored": true}
        });
        let occ = normalize_sonarr_episode(&episode, &server());
        assert_eq!(
            occ.as_ref().and_then(|o| o.title.clone()),
            Some(json!("Example Series")),
            "series title"
        );
        assert_eq!(
            occ.as_ref().and_then(|o| o.series_tvdb_id),
            Some(8),
            "series tvdb"
        );
        assert_eq!(occ.as_ref().map(|o| o.all_day), Some(false), "timed");
    }

    #[test]
    fn urls_from_server_fields() {
        let s = json!({"hostname": "h", "port": 8989, "useSsl": true, "baseUrl": "/sonarr"});
        assert_eq!(
            source_url(&s, "/series/a b"),
            Some(String::from("https://h:8989/sonarr/series/a%20b")),
            "built from the connection"
        );
        assert_eq!(
            source_url(&json!({"externalUrl": ""}), "/movie/1"),
            None,
            "empty base"
        );
    }

    #[test]
    fn modes_and_windows() {
        let now = 1_791_000_000_000;
        assert_eq!(
            release_sync_mode(None, now),
            Mode::Backfill,
            "never backfilled"
        );
        assert_eq!(
            release_sync_mode(Some(now - 1000), now),
            Mode::Incremental,
            "recent"
        );
        assert_eq!(
            release_sync_mode(Some(now - DAY_MS), now),
            Mode::Backfill,
            "a day old"
        );
        assert_eq!(
            calendar_window(Mode::Incremental, now),
            (now - 7 * DAY_MS, now + 45 * DAY_MS),
            "incremental window"
        );
    }

    #[test]
    fn uuids() {
        let id = random_uuid();
        assert_eq!(id.len(), 36, "length");
        assert_eq!(id.get(14..15), Some("4"), "version");
    }
}
