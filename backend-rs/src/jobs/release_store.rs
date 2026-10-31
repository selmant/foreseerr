//! `server/lib/releases/repository.ts` (`reconcileServerOccurrences`),
//! `producers.ts` and `relevance.ts`: the occurrence writes of one
//! server's calendar and the notifications they lead to.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use serde_json::{Map, Value};

use super::release_calendar::{is_material_date_change, lease_condition, Aired, Lease, Normalized};
use super::syncutil::{boolean, date, date_bind, date_ph, int, iso, now_ms, opt_date_bind, Tx};
use super::JobCtx;
use crate::db::Bind;
use crate::notify::{self, Kind, Payload, Person};
use crate::state::AppState;

const DAY_MS: i64 = 86_400_000;
const MISSING_GRACE_DAYS: i64 = 7;
const CHANGE_RETENTION_DAYS: i64 = 365;
const NEW_SEASON_GRACE_MS: i64 = 7 * DAY_MS;
/// `MediaRequestStatus.DECLINED` and `FAILED`.
const DECLINED: i64 = 3;
const FAILED: i64 = 4;

/// `ReleaseCalendarSyncResult`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SyncResult {
    /// `fetched`.
    pub fetched: i64,
    /// `inserted`.
    pub inserted: i64,
    /// `changed`.
    pub changed: i64,
    /// `missing`.
    pub missing: i64,
    /// `unmapped`.
    pub unmapped: i64,
    /// `errored`.
    pub errored: i64,
}

/// The input of `reconcileServerOccurrences`.
#[derive(Debug)]
pub struct Reconcile<'a> {
    /// `radarr` or `sonarr`.
    pub source: &'static str,
    /// `sourceServerId`.
    pub server_id: i64,
    /// The calendar, normalized.
    pub occurrences: &'a [Normalized],
    /// The window start (epoch ms).
    pub start: i64,
    /// The window end (epoch ms).
    pub end: i64,
    /// A first backfill announces nothing.
    pub initial_backfill: bool,
    /// The lease, checked inside the transaction.
    pub lease: Option<&'a Lease>,
}

/// The parts of a saved `ReleaseOccurrence` the producers read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventOccurrence {
    id: i64,
    source: String,
    date_type: String,
    title: String,
    season: Option<i64>,
    episode: Option<i64>,
    tvdb_id: Option<i64>,
    media_id: Option<i64>,
    media_type: String,
    is4k: bool,
    starts_at: i64,
    raw_dates: Option<String>,
    /// Where the episode sits in the aired order.
    aired: Aired,
}

/// A `ReleaseDateChange` as saved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
    old_starts_at: Option<i64>,
    new_starts_at: Option<i64>,
    kind: &'static str,
}

/// `DiscoveredReleaseEvents`.
#[derive(Debug, Default)]
pub struct Events {
    date_changes: Vec<(EventOccurrence, Change)>,
    new_seasons: Vec<EventOccurrence>,
}

/// JavaScript `===` between a stored column and a value.
fn js_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::String(x), Value::String(y)) => x == y,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Null, Value::Null) => true,
        _ => false,
    }
}

fn col<'r>(row: &'r Map<String, Value>, key: &str) -> &'r Value {
    row.get(key).unwrap_or(&Value::Null)
}

fn nullable(v: Option<&Value>) -> &Value {
    v.unwrap_or(&Value::Null)
}

const OCC_COLUMNS: &str = r#"CAST("id" AS BIGINT) AS "id", "source", CAST("sourceItemId" AS BIGINT) AS "sourceItemId", "sourceSeriesId", "mediaType", "tmdbId", "tvdbId", "mediaId", "title", "subtitle", "seasonNumber", "episodeNumber", "dateType", "allDay", "monitored", "hasFile", "is4k", "sourceUrl", "rawDates""#;

fn occ_select(db: &crate::db::Db) -> String {
    let iso_sql = |e: &str| db.iso_sql(e);
    format!(
        r#"SELECT {OCC_COLUMNS}, {} AS "startsAt", {} AS "firstSeenAt", {} AS "missingSince" FROM "release_occurrence""#,
        iso_sql(r#""startsAt""#),
        iso_sql(r#""firstSeenAt""#),
        iso_sql(r#""missingSince""#)
    )
}

fn key_of(row: &Map<String, Value>) -> String {
    format!(
        "{}:{}",
        int(row, "sourceItemId").unwrap_or(0),
        row.get("dateType").and_then(Value::as_str).unwrap_or("")
    )
}

/// `hasOccurrenceChanged(existing, next, mediaId)`.
fn has_changed(existing: &Map<String, Value>, next: &Normalized, media_id: Option<i64>) -> bool {
    let media = media_id.map_or(Value::Null, Value::from);
    !js_eq(
        col(existing, "sourceSeriesId"),
        nullable(next.series_id.as_ref()),
    ) || !js_eq(col(existing, "mediaType"), &Value::from(next.media_type))
        || !js_eq(col(existing, "tmdbId"), nullable(next.tmdb_id.as_ref()))
        || !js_eq(col(existing, "tvdbId"), nullable(next.tvdb_id.as_ref()))
        || !js_eq(col(existing, "mediaId"), &media)
        || next
            .title
            .as_ref()
            .is_none_or(|t| !js_eq(col(existing, "title"), t))
        || !js_eq(col(existing, "subtitle"), nullable(next.subtitle.as_ref()))
        || !js_eq(
            col(existing, "seasonNumber"),
            nullable(next.season.as_ref()),
        )
        || !js_eq(
            col(existing, "episodeNumber"),
            nullable(next.episode.as_ref()),
        )
        || date(existing, "startsAt") != Some(next.starts_at)
        || boolean(existing, "allDay") != next.all_day
        || boolean(existing, "monitored") != next.flags.monitored
        || boolean(existing, "hasFile") != next.flags.has_file
        || boolean(existing, "is4k") != next.flags.is4k
        || !js_eq(
            col(existing, "sourceUrl"),
            &next.source_url.clone().map_or(Value::Null, Value::from),
        )
        || !js_eq(
            col(existing, "rawDates"),
            &Value::from(next.raw_dates.clone()),
        )
        || date(existing, "missingSince").is_some()
}

fn opt_int(v: Option<&Value>) -> Option<i64> {
    v.and_then(Value::as_i64)
}

fn int_bind(v: &Value) -> Bind {
    Bind::OptInt(v.as_i64())
}

fn text_bind(v: &Value) -> Bind {
    Bind::OptText(match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other @ (Value::Bool(_) | Value::Number(_) | Value::Array(_) | Value::Object(_)) => {
            Some(crate::media::js_string(Some(other)).into_owned())
        }
    })
}

/// The saved entity: the next values where defined, the stored ones
/// otherwise.
fn merged(
    id: i64,
    existing: Option<&Map<String, Value>>,
    next: &Normalized,
    media_id: Option<i64>,
) -> EventOccurrence {
    let pick = |v: Option<&Value>, key: &str| -> Value {
        v.cloned()
            .or_else(|| existing.and_then(|e| e.get(key).cloned()))
            .unwrap_or(Value::Null)
    };
    EventOccurrence {
        id,
        source: next.source.to_owned(),
        date_type: next.date_type.to_owned(),
        title: crate::media::js_string(Some(&pick(next.title.as_ref(), "title"))).into_owned(),
        season: pick(next.season.as_ref(), "seasonNumber").as_i64(),
        episode: pick(next.episode.as_ref(), "episodeNumber").as_i64(),
        tvdb_id: pick(next.tvdb_id.as_ref(), "tvdbId").as_i64(),
        media_id,
        media_type: next.media_type.to_owned(),
        is4k: next.flags.is4k,
        starts_at: next.starts_at,
        raw_dates: Some(next.raw_dates.clone()),
        aired: next.aired,
    }
}

fn stored_event(row: &Map<String, Value>) -> EventOccurrence {
    EventOccurrence {
        id: int(row, "id").unwrap_or(0),
        source: row
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        date_type: row
            .get("dateType")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        title: crate::media::js_string(row.get("title")).into_owned(),
        season: int(row, "seasonNumber"),
        episode: int(row, "episodeNumber"),
        tvdb_id: int(row, "tvdbId"),
        media_id: int(row, "mediaId"),
        media_type: row
            .get("mediaType")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        is4k: boolean(row, "is4k"),
        starts_at: date(row, "startsAt").unwrap_or(0),
        raw_dates: row
            .get("rawDates")
            .and_then(Value::as_str)
            .map(str::to_owned),
        // Only premieres read it, and those come from fresh calendars.
        aired: Aired::AsNumbered,
    }
}

fn id_list(ids: &[i64]) -> String {
    ids.iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

/// `reconcileServerOccurrences`, in one transaction.
///
/// # Errors
///
/// Database errors (the transaction is rolled back) or a lost lease.
pub async fn reconcile(
    state: &AppState,
    input: Reconcile<'_>,
    result: &mut SyncResult,
) -> Result<Events> {
    let db = &state.db;
    let pg = db.is_postgres();
    let select = occ_select(db);
    let mut tx = Tx::begin(db).await?;
    let now = now_ms();
    let missing_cutoff = now - MISSING_GRACE_DAYS * DAY_MS;
    if let Some(lease) = input.lease {
        let (fenced, binds) = lease_condition(lease);
        let sql = format!(
            r#"SELECT CAST("id" AS BIGINT) AS "id" FROM "release_sync_state" "state" WHERE {fenced} AND "state"."leaseExpiresAt" > CURRENT_TIMESTAMP{}"#,
            if pg { " FOR UPDATE" } else { "" }
        );
        if tx.rows(&sql, &binds).await?.is_empty() {
            return Err(anyhow!("Release calendar sync lease is no longer owned"));
        }
    }
    let source_binds = || {
        vec![
            Bind::Text(input.source.to_owned()),
            Bind::Int(input.server_id),
        ]
    };
    let mut binds = source_binds();
    binds.push(date_bind(pg, input.start));
    binds.push(date_bind(pg, input.end));
    let existing_rows = tx
        .rows(
            &format!(
                r#"{select} WHERE "source" = ?1 AND "sourceServerId" = ?2 AND "startsAt" BETWEEN {} AND {}"#,
                date_ph(pg, 3),
                date_ph(pg, 4)
            ),
            &binds,
        )
        .await?;
    let mut by_key: HashMap<String, Map<String, Value>> = HashMap::new();
    for row in &existing_rows {
        by_key.insert(key_of(row), row.clone());
    }
    let mut item_ids: Vec<i64> = Vec::new();
    for o in input.occurrences {
        if !item_ids.contains(&o.item_id) {
            item_ids.push(o.item_id);
        }
    }
    for chunk in item_ids.chunks(500) {
        let rows = tx
            .rows(
                &format!(
                    r#"{select} WHERE "source" = ?1 AND "sourceServerId" = ?2 AND "sourceItemId" IN ({})"#,
                    id_list(chunk)
                ),
                &source_binds(),
            )
            .await?;
        for row in rows {
            by_key.insert(key_of(&row), row);
        }
    }
    let media_ids = media_maps(&mut tx, input.occurrences).await?;
    let mut inserted: HashSet<String> = HashSet::new();
    let mut moved: HashMap<String, i64> = HashMap::new();
    let mut saved: Vec<(String, EventOccurrence)> = Vec::new();
    for next in input.occurrences {
        let key = next.key();
        let existing = by_key.get(&key);
        if existing.is_none() && !input.initial_backfill && next.aired == Aired::Unchecked {
            // Stored now, it would never be checked for a season premiere
            // again (only new entries are); the next run that reaches TVDB
            // stores it.
            continue;
        }
        let media_id = if opt_int(next.tmdb_id.as_ref()).is_some_and(|t| t != 0) {
            opt_int(next.tmdb_id.as_ref()).and_then(|t| media_ids.0.get(&t).copied())
        } else {
            next.series_tvdb_id
                .filter(|t| *t != 0)
                .and_then(|t| media_ids.1.get(&t).copied())
        };
        if media_id.is_none() {
            result.unmapped += 1;
        }
        if let Some(existing) = existing {
            if !has_changed(existing, next, media_id) {
                continue;
            }
            let stored = (
                date(existing, "startsAt").unwrap_or(0),
                boolean(existing, "allDay"),
            );
            if is_material_date_change(stored, (next.starts_at, next.all_day)) {
                moved.insert(key.clone(), stored.0);
            }
            let id = int(existing, "id").unwrap_or(0);
            update_occurrence(&mut tx, id, next, media_id, now).await?;
            saved.push((key, merged(id, Some(existing), next, media_id)));
        } else {
            inserted.insert(key.clone());
            let id = insert_occurrence(&mut tx, next, media_id, now).await?;
            saved.push((key, merged(id, None, next, media_id)));
        }
    }
    result.inserted += i64::try_from(inserted.len()).unwrap_or(0);
    let mut events = Events::default();
    for (key, occurrence) in &saved {
        if inserted.contains(key) {
            if !input.initial_backfill && occurrence.source == "radarr" {
                let change = Change {
                    old_starts_at: None,
                    new_starts_at: Some(occurrence.starts_at),
                    kind: "announced",
                };
                events.date_changes.push((occurrence.clone(), change));
            }
            if !input.initial_backfill && is_season_premiere(occurrence) {
                events.new_seasons.push(occurrence.clone());
            }
        } else if let Some(old) = moved.get(key) {
            let kind = if occurrence.starts_at < *old {
                "moved_earlier"
            } else {
                "delayed"
            };
            let change = Change {
                old_starts_at: Some(*old),
                new_starts_at: Some(occurrence.starts_at),
                kind,
            };
            events.date_changes.push((occurrence.clone(), change));
        }
    }
    for (occurrence, change) in &events.date_changes {
        insert_change(&mut tx, occurrence, change, input.source, now).await?;
    }
    result.changed += i64::try_from(events.date_changes.len()).unwrap_or(0);
    let seen: HashSet<String> = input.occurrences.iter().map(Normalized::key).collect();
    let newly_missing: Vec<i64> = existing_rows
        .iter()
        .filter(|row| {
            date(row, "missingSince").is_none()
                && date(row, "startsAt").is_some_and(|s| s >= input.start && s <= input.end)
                && !seen.contains(&key_of(row))
        })
        .filter_map(|row| int(row, "id"))
        .collect();
    if !newly_missing.is_empty() {
        tx.execute(
            &format!(
                r#"UPDATE "release_occurrence" SET "missingSince" = {}, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" IN ({})"#,
                date_ph(pg, 1),
                id_list(&newly_missing)
            ),
            &[date_bind(pg, now)],
        )
        .await?;
        result.missing += i64::try_from(newly_missing.len()).unwrap_or(0);
    }
    expire_missing(
        &mut tx,
        &input,
        &select,
        missing_cutoff,
        now,
        &mut events,
        result,
    )
    .await?;
    tx.commit().await?;
    Ok(events)
}

/// The movie (by TMDB id) and series (by TVDB id) media ids.
async fn media_maps(
    tx: &mut Tx,
    occurrences: &[Normalized],
) -> Result<(HashMap<i64, i64>, HashMap<i64, i64>)> {
    let mut movie_ids: Vec<i64> = Vec::new();
    let mut series_ids: Vec<i64> = Vec::new();
    for o in occurrences {
        if let Some(t) = opt_int(o.tmdb_id.as_ref()) {
            if !movie_ids.contains(&t) {
                movie_ids.push(t);
            }
        }
        if let Some(t) = o.series_tvdb_id {
            if !series_ids.contains(&t) {
                series_ids.push(t);
            }
        }
    }
    let mut movies = HashMap::new();
    if !movie_ids.is_empty() {
        let rows = tx
            .rows(
                &format!(
                    r#"SELECT CAST("id" AS BIGINT) AS "id", CAST("tmdbId" AS BIGINT) AS "key" FROM "media" WHERE "tmdbId" IN ({}) AND "mediaType" = 'movie'"#,
                    id_list(&movie_ids)
                ),
                &[],
            )
            .await?;
        for row in rows {
            if let (Some(k), Some(id)) = (int(&row, "key"), int(&row, "id")) {
                movies.insert(k, id);
            }
        }
    }
    let mut series = HashMap::new();
    if !series_ids.is_empty() {
        let rows = tx
            .rows(
                &format!(
                    r#"SELECT CAST("id" AS BIGINT) AS "id", CAST("tvdbId" AS BIGINT) AS "key" FROM "media" WHERE "tvdbId" IN ({}) AND "mediaType" = 'tv'"#,
                    id_list(&series_ids)
                ),
                &[],
            )
            .await?;
        for row in rows {
            if let (Some(k), Some(id)) = (int(&row, "key"), int(&row, "id")) {
                series.insert(k, id);
            }
        }
    }
    Ok((movies, series))
}

fn is_season_premiere(o: &EventOccurrence) -> bool {
    premiere_season(o).is_some()
}

/// The aired season a Sonarr episode premieres: its first episode, past
/// the specials. A series Sonarr numbers in another order is placed by
/// its aired-order numbers: Sonarr's episode 1 may be none (absolute
/// order) or another season's (DVD order).
fn premiere_season(o: &EventOccurrence) -> Option<i64> {
    if o.source != "sonarr" {
        return None;
    }
    let (season, episode) = match o.aired {
        Aired::AsNumbered => (o.season.unwrap_or(0), o.episode),
        Aired::Mapped(season, episode) => (season, Some(episode)),
        Aired::Unknown | Aired::Unchecked => return None,
    };
    (season > 0 && episode == Some(1)).then_some(season)
}

async fn insert_occurrence(
    tx: &mut Tx,
    next: &Normalized,
    media_id: Option<i64>,
    now: i64,
) -> Result<i64> {
    let pg = tx.is_postgres();
    let null = Value::Null;
    let sql = format!(
        r#"INSERT INTO "release_occurrence" ("source", "sourceServerId", "sourceItemId", "sourceSeriesId", "mediaType", "tmdbId", "tvdbId", "mediaId", "title", "subtitle", "seasonNumber", "episodeNumber", "dateType", "startsAt", "allDay", "monitored", "hasFile", "is4k", "sourceUrl", "rawDates", "firstSeenAt", "lastSeenAt", "missingSince") VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, {}, ?15, ?16, ?17, ?18, ?19, ?20, {}, {}, NULL) RETURNING CAST("id" AS BIGINT) AS "id""#,
        date_ph(pg, 14),
        date_ph(pg, 21),
        date_ph(pg, 22)
    );
    tx.insert_id(
        &sql,
        &[
            Bind::Text(next.source.to_owned()),
            Bind::Int(next.server_id),
            Bind::Int(next.item_id),
            int_bind(next.series_id.as_ref().unwrap_or(&null)),
            Bind::Text(next.media_type.to_owned()),
            int_bind(next.tmdb_id.as_ref().unwrap_or(&null)),
            int_bind(next.tvdb_id.as_ref().unwrap_or(&null)),
            Bind::OptInt(media_id),
            text_bind(next.title.as_ref().unwrap_or(&null)),
            text_bind(next.subtitle.as_ref().unwrap_or(&null)),
            int_bind(next.season.as_ref().unwrap_or(&null)),
            int_bind(next.episode.as_ref().unwrap_or(&null)),
            Bind::Text(next.date_type.to_owned()),
            date_bind(pg, next.starts_at),
            Bind::Bool(next.all_day),
            Bind::Bool(next.flags.monitored),
            Bind::Bool(next.flags.has_file),
            Bind::Bool(next.flags.is4k),
            Bind::OptText(next.source_url.clone()),
            Bind::Text(next.raw_dates.clone()),
            date_bind(pg, now),
            date_bind(pg, now),
        ],
    )
    .await
}

/// The save of a changed occurrence: every property Node assigns a
/// defined value to.
async fn update_occurrence(
    tx: &mut Tx,
    id: i64,
    next: &Normalized,
    media_id: Option<i64>,
    now: i64,
) -> Result<()> {
    let pg = tx.is_postgres();
    let mut sets: Vec<String> = Vec::new();
    let mut binds: Vec<Bind> = Vec::new();
    let mut set = |column: &str, bind: Bind, date_col: bool| {
        binds.push(bind);
        let ph = if date_col {
            date_ph(pg, binds.len())
        } else {
            format!("?{}", binds.len())
        };
        sets.push(format!(r#""{column}" = {ph}"#));
    };
    if let Some(v) = &next.series_id {
        set("sourceSeriesId", int_bind(v), false);
    }
    set("mediaType", Bind::Text(next.media_type.to_owned()), false);
    if let Some(v) = &next.tmdb_id {
        set("tmdbId", int_bind(v), false);
    }
    if let Some(v) = &next.tvdb_id {
        set("tvdbId", int_bind(v), false);
    }
    if let Some(v) = &next.title {
        set("title", text_bind(v), false);
    }
    if let Some(v) = &next.subtitle {
        set("subtitle", text_bind(v), false);
    }
    if let Some(v) = &next.season {
        set("seasonNumber", int_bind(v), false);
    }
    if let Some(v) = &next.episode {
        set("episodeNumber", int_bind(v), false);
    }
    set("startsAt", date_bind(pg, next.starts_at), true);
    set("allDay", Bind::Bool(next.all_day), false);
    set("monitored", Bind::Bool(next.flags.monitored), false);
    set("hasFile", Bind::Bool(next.flags.has_file), false);
    set("is4k", Bind::Bool(next.flags.is4k), false);
    if let Some(url) = &next.source_url {
        set("sourceUrl", Bind::Text(url.clone()), false);
    }
    set("rawDates", Bind::Text(next.raw_dates.clone()), false);
    set("mediaId", Bind::OptInt(media_id), false);
    set("lastSeenAt", date_bind(pg, now), true);
    binds.push(Bind::Int(id));
    let sql = format!(
        r#"UPDATE "release_occurrence" SET {}, "missingSince" = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?{}"#,
        sets.join(", "),
        binds.len()
    );
    tx.execute(&sql, &binds).await?;
    Ok(())
}

async fn insert_change(
    tx: &mut Tx,
    occurrence: &EventOccurrence,
    change: &Change,
    source: &str,
    now: i64,
) -> Result<()> {
    let pg = tx.is_postgres();
    let mut metadata = Map::new();
    metadata.insert(String::from("source"), Value::from(source));
    metadata.insert(
        String::from("dateType"),
        Value::from(occurrence.date_type.clone()),
    );
    let sql = format!(
        r#"INSERT INTO "release_date_change" ("occurrenceId", "oldStartsAt", "newStartsAt", "changeKind", "detectedAt", "notifiable", "metadata") VALUES (?1, {}, {}, ?4, {}, ?6, ?7) RETURNING CAST("id" AS BIGINT) AS "id""#,
        date_ph(pg, 2),
        date_ph(pg, 3),
        date_ph(pg, 5)
    );
    tx.insert_id(
        &sql,
        &[
            Bind::Int(occurrence.id),
            opt_date_bind(pg, change.old_starts_at),
            opt_date_bind(pg, change.new_starts_at),
            Bind::Text(change.kind.to_owned()),
            date_bind(pg, now),
            Bind::Bool(true),
            Bind::Text(Value::Object(metadata).to_string()),
        ],
    )
    .await?;
    Ok(())
}

/// Withdraw occurrences missing past the grace period, drop old changes and
/// the expired occurrences no change refers to any more.
async fn expire_missing(
    tx: &mut Tx,
    input: &Reconcile<'_>,
    select: &str,
    missing_cutoff: i64,
    now: i64,
    events: &mut Events,
    result: &mut SyncResult,
) -> Result<()> {
    let pg = tx.is_postgres();
    let expired = tx
        .rows(
            &format!(
                r#"{select} WHERE "source" = ?1 AND "sourceServerId" = ?2 AND "missingSince" < {}"#,
                date_ph(pg, 3)
            ),
            &[
                Bind::Text(input.source.to_owned()),
                Bind::Int(input.server_id),
                date_bind(pg, missing_cutoff),
            ],
        )
        .await?;
    let expired_ids: Vec<i64> = expired.iter().filter_map(|r| int(r, "id")).collect();
    if !expired_ids.is_empty() {
        let withdrawn = tx
            .rows(
                &format!(
                    r#"SELECT CAST("occurrenceId" AS BIGINT) AS "occurrenceId" FROM "release_date_change" WHERE "occurrenceId" IN ({}) AND "changeKind" = 'withdrawn'"#,
                    id_list(&expired_ids)
                ),
                &[],
            )
            .await?;
        let withdrawn: HashSet<i64> = withdrawn
            .iter()
            .filter_map(|r| int(r, "occurrenceId"))
            .collect();
        let mut withdrawals = Vec::new();
        for row in &expired {
            let occurrence = stored_event(row);
            if withdrawn.contains(&occurrence.id) {
                continue;
            }
            let change = Change {
                old_starts_at: date(row, "startsAt"),
                new_starts_at: None,
                kind: "withdrawn",
            };
            insert_change(tx, &occurrence, &change, input.source, now).await?;
            withdrawals.push((occurrence, change));
        }
        result.changed += i64::try_from(withdrawals.len()).unwrap_or(0);
        events.date_changes.extend(withdrawals);
    }
    tx.execute(
        &format!(
            r#"DELETE FROM "release_date_change" WHERE "detectedAt" < {}"#,
            date_ph(pg, 1)
        ),
        &[date_bind(pg, now - CHANGE_RETENTION_DAYS * DAY_MS)],
    )
    .await?;
    if !expired_ids.is_empty() {
        let retained = tx
            .rows(
                &format!(
                    r#"SELECT CAST("occurrenceId" AS BIGINT) AS "occurrenceId" FROM "release_date_change" WHERE "occurrenceId" IN ({})"#,
                    id_list(&expired_ids)
                ),
                &[],
            )
            .await?;
        let retained: HashSet<i64> = retained
            .iter()
            .filter_map(|r| int(r, "occurrenceId"))
            .collect();
        let deletable: Vec<i64> = expired_ids
            .iter()
            .copied()
            .filter(|id| !retained.contains(id))
            .collect();
        if !deletable.is_empty() {
            tx.execute(
                &format!(
                    r#"DELETE FROM "release_occurrence" WHERE "id" IN ({})"#,
                    id_list(&deletable)
                ),
                &[],
            )
            .await?;
        }
    }
    Ok(())
}

/// `getRequestRelevanceReason`'s answer: whether the request makes the
/// occurrence relevant to its requester.
#[must_use]
pub fn relevance_reason(
    occurrence: (&str, Option<i64>, Option<i64>),
    status: i64,
    episode_selection_type: Option<&str>,
    episode_tvdb_ids: &[i64],
    season_numbers: &[i64],
) -> Option<&'static str> {
    let (media_type, tvdb_id, season) = occurrence;
    if status == DECLINED || status == FAILED {
        return None;
    }
    if media_type == "movie" {
        return Some("requested_movie");
    }
    if let Some(tvdb) = tvdb_id.filter(|t| *t != 0) {
        if episode_tvdb_ids.contains(&tvdb) {
            return Some("requested_episode");
        }
    }
    if season.is_some_and(|s| season_numbers.contains(&s)) {
        return Some("requested_season");
    }
    if episode_selection_type.is_some_and(|t| !t.is_empty()) || !episode_tvdb_ids.is_empty() {
        return None;
    }
    Some("requested_series")
}

/// `notificationContext`: the users the occurrence is relevant to, with
/// their settings, and its media.
async fn notification_context(
    state: &AppState,
    occurrence: &EventOccurrence,
) -> Result<(Vec<Person>, Option<crate::db::MediaRow>)> {
    let Some(media_id) = occurrence.media_id.filter(|id| *id != 0) else {
        return Ok((Vec::new(), None));
    };
    let db = &state.db;
    let requests = db.requests_of_media(media_id).await?;
    let mut user_ids: Vec<i64> = Vec::new();
    for request in requests.iter().filter(|r| r.is4k == occurrence.is4k) {
        let episodes: Vec<i64> = request.episodes.iter().map(|e| e.tvdb_id).collect();
        let seasons: Vec<i64> = request.seasons.iter().map(|s| s.season_number).collect();
        let reason = relevance_reason(
            (
                &occurrence.media_type,
                occurrence.tvdb_id,
                occurrence.season,
            ),
            request.status,
            request.episode_selection_type.as_deref(),
            &episodes,
            &seasons,
        );
        if let (Some(_), Some(user)) = (reason, request.requested_by_id) {
            if !user_ids.contains(&user) {
                user_ids.push(user);
            }
        }
    }
    user_ids.sort_unstable();
    let mut users = Vec::new();
    for id in user_ids {
        if let Some((user, settings)) = db.user_record(id).await? {
            users.push(Person::from_records(&user, settings.as_ref()));
        }
    }
    let media = db.media_by_ids(&[media_id], true).await?.pop();
    Ok((users, media))
}

fn iso_date(ms: i64) -> String {
    iso(ms).chars().take(10).collect()
}

/// `selectedMovieDateType`.
fn selected_movie_date_type(occurrence: &EventOccurrence) -> String {
    let dates: Value = occurrence
        .raw_dates
        .as_deref()
        .and_then(|r| serde_json::from_str(r).ok())
        .unwrap_or(Value::Null);
    let present = |k: &str| crate::settings::public::truthy(dates.get(k));
    for (date_type, key) in [
        ("digital", "digitalRelease"),
        ("physical", "physicalRelease"),
        ("theatrical", "inCinemas"),
    ] {
        if present(key) {
            return date_type.to_owned();
        }
    }
    occurrence.date_type.clone()
}

/// `dateChangeMessage`.
fn date_change_message(occurrence: &EventOccurrence, change: &Change) -> String {
    let old = change.old_starts_at.map(iso_date);
    let new = change.new_starts_at.map(iso_date);
    let date_type = &occurrence.date_type;
    match change.kind {
        "withdrawn" => format!(
            "The {date_type} release date{} was withdrawn.",
            old.map(|d| format!(" ({d})")).unwrap_or_default()
        ),
        "announced" => format!(
            "A {date_type} release date was announced{}.",
            new.map(|d| format!(" for {d}")).unwrap_or_default()
        ),
        _ => format!(
            "The {date_type} release moved from {} to {}.",
            old.unwrap_or_else(|| String::from("an earlier date")),
            new.unwrap_or_else(|| String::from("a new date"))
        ),
    }
}

/// `safelyProduceReleaseEvents`.
pub async fn produce_events(job: &JobCtx, events: &Events) {
    let settings = job
        .current_settings()
        .await
        .unwrap_or_else(|_| Arc::clone(&job.settings));
    let mut failed = 0_usize;
    for (occurrence, change) in &events.date_changes {
        if occurrence.source == "radarr"
            && selected_movie_date_type(occurrence) != occurrence.date_type
        {
            continue;
        }
        match notification_context(&job.state, occurrence).await {
            Ok((users, media)) => {
                for user in users {
                    notify::send(
                        Arc::clone(&job.state),
                        Arc::clone(&settings),
                        Kind::ReleaseDateChanged,
                        Payload {
                            event: Some(String::from("Release Date Changed")),
                            subject: occurrence.title.clone(),
                            message: Some(date_change_message(occurrence, change)),
                            notify_admin: false,
                            notify_system: true,
                            notify_user: Some(user),
                            media: media.clone(),
                            ..Payload::default()
                        },
                    );
                }
            }
            Err(_) => failed += 1,
        }
    }
    let now = now_ms();
    for occurrence in &events.new_seasons {
        let Some(season) = premiere_season(occurrence) else {
            continue;
        };
        if occurrence.starts_at < now - NEW_SEASON_GRACE_MS {
            continue;
        }
        match notification_context(&job.state, occurrence).await {
            Ok((users, media)) => {
                for user in users {
                    notify::send(
                        Arc::clone(&job.state),
                        Arc::clone(&settings),
                        Kind::NewSeason,
                        Payload {
                            event: Some(String::from("New Season Announced")),
                            subject: occurrence.title.clone(),
                            message: Some(format!(
                                "Season {season} premieres {}.",
                                iso_date(occurrence.starts_at)
                            )),
                            notify_admin: false,
                            notify_system: true,
                            notify_user: Some(user),
                            media: media.clone(),
                            ..Payload::default()
                        },
                    );
                }
            }
            Err(_) => failed += 1,
        }
    }
    if failed > 0 {
        tracing::warn!(
            label = "Release Calendar Sync",
            failed,
            "Some release notifications could not be sent"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn episode_only_requests_are_not_the_whole_series() {
        assert_eq!(
            relevance_reason(("tv", Some(200), Some(2)), 2, Some("single"), &[101], &[]),
            None,
            "episode-only request"
        );
        assert_eq!(
            relevance_reason(("tv", Some(101), Some(1)), 2, Some("single"), &[101], &[]),
            Some("requested_episode"),
            "the requested episode"
        );
        assert_eq!(
            relevance_reason(("tv", Some(200), Some(2)), 2, None, &[], &[1]),
            Some("requested_series"),
            "later seasons of a series request"
        );
        assert_eq!(
            relevance_reason(("movie", None, None), 3, None, &[], &[]),
            None,
            "declined"
        );
    }

    fn occ(kind: &str, raw: &str) -> EventOccurrence {
        EventOccurrence {
            id: 1,
            source: String::from("radarr"),
            date_type: kind.to_owned(),
            title: String::from("T"),
            season: None,
            episode: None,
            tvdb_id: None,
            media_id: None,
            media_type: String::from("movie"),
            is4k: false,
            starts_at: 0,
            raw_dates: Some(raw.to_owned()),
            aired: Aired::AsNumbered,
        }
    }

    fn episode(season: i64, episode: i64, aired: Aired) -> EventOccurrence {
        EventOccurrence {
            source: String::from("sonarr"),
            season: Some(season),
            episode: Some(episode),
            media_type: String::from("tv"),
            aired,
            ..occ("air", "{}")
        }
    }

    #[test]
    fn premieres_by_aired_order() {
        assert_eq!(
            premiere_season(&episode(2, 1, Aired::AsNumbered)),
            Some(2),
            "aired order"
        );
        assert_eq!(
            premiere_season(&episode(0, 1, Aired::AsNumbered)),
            None,
            "specials"
        );
        assert_eq!(
            premiere_season(&episode(1, 13, Aired::Mapped(2, 1))),
            Some(2),
            "absolute S01E13 premieres aired season 2"
        );
        assert_eq!(
            premiere_season(&episode(2, 1, Aired::Mapped(1, 14))),
            None,
            "DVD S02E01 is the middle of aired season 1"
        );
        assert_eq!(
            premiere_season(&episode(2, 1, Aired::Unknown)),
            None,
            "aired place unknown"
        );
        assert_eq!(
            premiere_season(&occ("digital", "{}")),
            None,
            "movies don't premiere seasons"
        );
    }

    #[test]
    fn primary_movie_dates() {
        let raw = r#"{"inCinemas":"2026-08-01","digitalRelease":"2026-09-01"}"#;
        assert_eq!(
            selected_movie_date_type(&occ("theatrical", raw)),
            "digital",
            "digital first"
        );
        assert_eq!(
            selected_movie_date_type(&occ(
                "physical",
                r#"{"physicalRelease":"x","inCinemas":"y"}"#
            )),
            "physical",
            "then physical"
        );
    }

    #[test]
    fn messages() {
        let o = occ("digital", "{}");
        let day = 86_400_000 * 20_000;
        assert_eq!(
            date_change_message(
                &o,
                &Change {
                    old_starts_at: None,
                    new_starts_at: Some(day),
                    kind: "announced"
                }
            ),
            "A digital release date was announced for 2024-10-04.",
            "announced"
        );
        assert_eq!(
            date_change_message(
                &o,
                &Change {
                    old_starts_at: Some(day),
                    new_starts_at: None,
                    kind: "withdrawn"
                }
            ),
            "The digital release date (2024-10-04) was withdrawn.",
            "withdrawn"
        );
        assert_eq!(
            date_change_message(
                &o,
                &Change {
                    old_starts_at: Some(day),
                    new_starts_at: Some(day + 86_400_000),
                    kind: "delayed"
                }
            ),
            "The digital release moved from 2024-10-04 to 2024-10-05.",
            "moved"
        );
    }
}
