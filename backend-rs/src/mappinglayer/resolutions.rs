//! `server/lib/mapping/resolutions.ts`: stored answers, misses and the
//! admin's corrections, plus the batched miss sightings.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use anyhow::Result;
use serde_json::{Map, Value};

use super::IdRef;
use crate::clock::Utc;
use crate::db::{Bind, Db};
use crate::sync::lock;

/// `GUESS_ORIGINS`: answers a dataset edge replaces once it knows the item.
pub const GUESS_ORIGINS: [&str; 3] = ["title", "prequel", "sonarr"];

/// A `Correction`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Correction {
    /// `None` records "this has no TMDB counterpart".
    pub tmdb_id: Option<i64>,
    /// `movie` or `tv`.
    pub tmdb_type: Option<String>,
}

#[derive(Debug, Default)]
struct Corrections {
    loaded: Option<Arc<HashMap<String, Correction>>>,
    generation: u64,
}

static CORRECTIONS: LazyLock<Mutex<Corrections>> =
    LazyLock::new(|| Mutex::new(Corrections::default()));

/// `invalidateCorrections`.
pub fn invalidate_corrections() {
    let mut c = lock(&CORRECTIONS);
    c.loaded = None;
    c.generation += 1;
}

async fn load_corrections(db: &Db) -> Result<Arc<HashMap<String, Correction>>> {
    let generation = {
        let c = lock(&CORRECTIONS);
        if let Some(loaded) = &c.loaded {
            return Ok(Arc::clone(loaded));
        }
        c.generation
    };
    let rows = db
        .rows(
            r#"SELECT "srcNs", "srcId", "tmdbId", "tmdbType" FROM "mapping_resolution" WHERE "origin" = 'manual'"#,
            &[],
        )
        .await?;
    let map: HashMap<String, Correction> = rows
        .iter()
        .map(|row| {
            let text = |k: &str| row.get(k).and_then(Value::as_str).unwrap_or_default();
            (
                format!("{}:{}", text("srcNs"), text("srcId")),
                Correction {
                    tmdb_id: row.get("tmdbId").and_then(Value::as_i64),
                    tmdb_type: row
                        .get("tmdbType")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                },
            )
        })
        .collect();
    let map = Arc::new(map);
    let mut c = lock(&CORRECTIONS);
    if c.generation == generation {
        c.loaded = Some(Arc::clone(&map));
    }
    drop(c);
    Ok(map)
}

/// `correctionFor(refs)`: the correction for the first id that has one.
///
/// # Errors
///
/// Fails on database errors.
pub async fn correction_for(db: &Db, refs: &[Option<&IdRef>]) -> Result<Option<Correction>> {
    let known = load_corrections(db).await?;
    Ok(refs
        .iter()
        .flatten()
        .find_map(|r| known.get(&format!("{}:{}", r.ns, r.id)).cloned()))
}

/// One stored `mapping_resolution` row, as the resolver reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stored {
    /// Primary key.
    pub id: i64,
    /// Source namespace.
    pub src_ns: String,
    /// Source id.
    pub src_id: String,
    /// The media type it was filed under (`''` for any).
    pub media_type: String,
    /// TMDB id.
    pub tmdb_id: Option<i64>,
    /// TMDB type.
    pub tmdb_type: Option<String>,
    /// Origin.
    pub origin: String,
    /// `checkedAt` in milliseconds.
    pub checked_at: Option<i64>,
}

/// `storedFor(refs)`: rows for any of the ids, whatever media type they
/// were filed under, in the order `SQLite` walks the unique index for the
/// `OR` (each id in turn, then media type).
///
/// # Errors
///
/// Fails on database errors.
pub async fn stored_for(db: &Db, refs: &[IdRef]) -> Result<Vec<Stored>> {
    if refs.is_empty() {
        return Ok(Vec::new());
    }
    let mut clauses = Vec::new();
    let mut binds = Vec::new();
    for r in refs {
        let n = binds.len();
        clauses.push(format!(
            r#"("srcNs" = ?{} AND "srcId" = ?{})"#,
            n + 1,
            n + 2
        ));
        binds.push(Bind::Text(r.ns.clone()));
        binds.push(Bind::Text(r.id.clone()));
    }
    let sql = format!(
        r#"SELECT "id", "srcNs", "srcId", "mediaType", "tmdbId", "tmdbType", "origin", {} AS "checkedAt" FROM "mapping_resolution" WHERE {}"#,
        db.iso_sql(r#""checkedAt""#),
        clauses.join(" OR ")
    );
    let rows = db.rows(&sql, &binds).await?;
    let mut stored: Vec<Stored> = rows
        .iter()
        .map(|row| {
            let text = |k: &str| {
                row.get(k)
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned()
            };
            Stored {
                id: row.get("id").and_then(Value::as_i64).unwrap_or(0),
                src_ns: text("srcNs"),
                src_id: text("srcId"),
                media_type: text("mediaType"),
                tmdb_id: row.get("tmdbId").and_then(Value::as_i64),
                tmdb_type: row
                    .get("tmdbType")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                origin: text("origin"),
                checked_at: row
                    .get("checkedAt")
                    .and_then(Value::as_str)
                    .and_then(crate::clock::parse_date_millis),
            }
        })
        .collect();
    let position = |s: &Stored| {
        refs.iter()
            .position(|r| r.ns == s.src_ns && r.id == s.src_id)
            .unwrap_or(usize::MAX)
    };
    stored.sort_by(|a, b| {
        position(a)
            .cmp(&position(b))
            .then_with(|| a.media_type.cmp(&b.media_type))
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(stored)
}

/// A `ResolutionWrite` (never manual here: corrections are written by the
/// settings routes).
#[derive(Debug, Clone, Default)]
pub struct Write {
    /// The id it is filed under.
    pub r: IdRef,
    /// The declared media type, as the source gave it.
    pub media_type: Option<String>,
    /// TMDB id.
    pub tmdb_id: Option<i64>,
    /// TMDB type.
    pub tmdb_type: Option<String>,
    /// `tmdb-find`, `title`, `prequel` or `miss`.
    pub origin: &'static str,
    /// Title.
    pub title: Option<String>,
    /// Year.
    pub year: Option<i64>,
    /// Discover source.
    pub discover_source: Option<String>,
    /// Detail (`Some` sets it, `None` leaves it).
    pub detail: Option<String>,
    /// Sightings to add.
    pub hits: i64,
    /// `false` for a bare sighting.
    pub attempted: bool,
}

/// A timestamp bind and its SQL as `TypeORM` writes a `Date` there.
fn stamp(db: &Db, at: &Utc, binds: &mut Vec<Bind>) -> String {
    if db.is_postgres() {
        binds.push(Bind::Text(at.iso_string()));
        format!("CAST(?{} AS timestamptz)", binds.len())
    } else {
        binds.push(Bind::Text(at.typeorm_string()));
        format!("?{}", binds.len())
    }
}

/// The row `findOne({ where })` picks.
async fn find_one(
    db: &Db,
    ns: &str,
    id: &str,
    media_type: &str,
    manual: bool,
) -> Result<Option<(i64, String, i64)>> {
    let sql = if manual {
        r#"SELECT "id", "origin", "hitCount" FROM "mapping_resolution" WHERE "srcNs" = ?1 AND "srcId" = ?2 AND "mediaType" = ?3 AND "origin" = 'manual' LIMIT 1"#
    } else {
        r#"SELECT "id", "origin", "hitCount" FROM "mapping_resolution" WHERE "srcNs" = ?1 AND "srcId" = ?2 AND "mediaType" = ?3 LIMIT 1"#
    };
    let rows = db
        .rows(
            sql,
            &[
                Bind::Text(ns.to_owned()),
                Bind::Text(id.to_owned()),
                Bind::Text(media_type.to_owned()),
            ],
        )
        .await?;
    Ok(rows.first().map(|row| {
        (
            row.get("id").and_then(Value::as_i64).unwrap_or(0),
            row.get("origin")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            row.get("hitCount").and_then(Value::as_i64).unwrap_or(0),
        )
    }))
}

/// One pass of `saveResolution`: `Ok(Err(e))` when the insert failed (a
/// race with another lookup), which is retried once.
async fn save_once(db: &Db, w: &Write) -> Result<Result<()>> {
    let media_type = w.media_type.clone().unwrap_or_default();
    let existing = if w.origin == "miss" {
        find_one(db, &w.r.ns, &w.r.id, "", true).await?
    } else {
        None
    };
    let existing = match existing {
        Some(found) => Some(found),
        None => find_one(db, &w.r.ns, &w.r.id, &media_type, false).await?,
    };
    let now = Utc::now();
    if let Some((id, origin, hit_count)) = existing {
        let keep_answer = origin == "manual" || (w.origin == "miss" && origin != "miss");
        if keep_answer {
            if w.hits != 0 {
                db.execute(
                    r#"UPDATE "mapping_resolution" SET "hitCount" = "hitCount" + ?1 WHERE "id" = ?2"#,
                    &[Bind::Int(w.hits), Bind::Int(id)],
                )
                .await?;
            }
            return Ok(Ok(()));
        }
        let mut binds = vec![
            Bind::OptInt(w.tmdb_id),
            Bind::OptText(w.tmdb_type.clone()),
            Bind::Text(w.origin.to_owned()),
            Bind::Int(hit_count + w.hits),
        ];
        let mut sets = vec![
            String::from(r#""tmdbId" = ?1"#),
            String::from(r#""tmdbType" = ?2"#),
            String::from(r#""origin" = ?3"#),
            String::from(r#""hitCount" = ?4"#),
        ];
        if w.attempted {
            let at = stamp(db, &now, &mut binds);
            sets.push(format!(r#""checkedAt" = {at}"#));
        }
        let at = stamp(db, &now, &mut binds);
        sets.push(format!(r#""updatedAt" = {at}"#));
        let optional = [
            (
                "title",
                w.title.clone().filter(|t| !t.is_empty()).map(Bind::Text),
            ),
            ("year", w.year.filter(|y| *y != 0).map(Bind::Int)),
            (
                "discoverSource",
                w.discover_source
                    .clone()
                    .filter(|s| !s.is_empty())
                    .map(Bind::Text),
            ),
            ("detail", w.detail.clone().map(Bind::Text)),
        ];
        for (column, bind) in optional {
            if let Some(bind) = bind {
                binds.push(bind);
                sets.push(format!(r#""{column}" = ?{}"#, binds.len()));
            }
        }
        binds.push(Bind::Int(id));
        let sql = format!(
            r#"UPDATE "mapping_resolution" SET {} WHERE "id" = ?{}"#,
            sets.join(", "),
            binds.len()
        );
        db.execute(&sql, &binds).await?;
        return Ok(Ok(()));
    }
    let mut binds = vec![
        Bind::Text(w.r.ns.clone()),
        Bind::Text(w.r.id.clone()),
        Bind::Text(media_type),
        Bind::OptInt(w.tmdb_id),
        Bind::OptText(w.tmdb_type.clone()),
        Bind::Text(w.origin.to_owned()),
        Bind::OptText(w.title.clone()),
        Bind::OptInt(w.year),
        Bind::OptText(w.discover_source.clone()),
        Bind::OptText(w.detail.clone()),
        Bind::Int(w.hits),
        Bind::OptInt(None),
    ];
    let checked = if w.attempted {
        now
    } else {
        Utc::from_unix_millis(0)
    };
    let checked_sql = stamp(db, &checked, &mut binds);
    let created_sql = stamp(db, &now, &mut binds);
    let updated_sql = stamp(db, &now, &mut binds);
    let sql = format!(
        r#"INSERT INTO "mapping_resolution" ("srcNs", "srcId", "mediaType", "tmdbId", "tmdbType", "origin", "title", "year", "discoverSource", "detail", "hitCount", "createdByUserId", "checkedAt", "createdAt", "updatedAt") VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, {checked_sql}, {created_sql}, {updated_sql})"#
    );
    Ok(db.execute(&sql, &binds).await.map(|_| ()))
}

/// `saveResolution(write)`: store an answer or a miss for one id. A
/// manual row is never overwritten here, and a miss never replaces an
/// answer.
///
/// # Errors
///
/// Fails on database errors.
pub async fn save_resolution(db: &Db, w: &Write) -> Result<()> {
    match save_once(db, w).await? {
        Ok(()) => Ok(()),
        // Two lookups raced to the insert: apply this write to the row.
        Err(_) => save_once(db, w).await?,
    }
}

/// `deleteResolutions(ids)`.
///
/// # Errors
///
/// Fails on database errors.
pub async fn delete_resolutions(db: &Db, ids: &[i64]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let marks: Vec<String> = (1..=ids.len()).map(|i| format!("?{i}")).collect();
    let sql = format!(
        r#"DELETE FROM "mapping_resolution" WHERE "id" IN ({})"#,
        marks.join(", ")
    );
    let binds: Vec<Bind> = ids.iter().copied().map(Bind::Int).collect();
    db.execute(&sql, &binds).await?;
    invalidate_corrections();
    Ok(())
}

// ---------------------------------------------------------------------------
// Miss sightings.

/// A `MissObservation`: the id plus the fields given, as JavaScript
/// object keys (a later sighting's keys replace an earlier one's, even
/// when they are `undefined`, written here as `null`).
#[derive(Debug, Clone)]
pub struct Observation {
    /// The id.
    pub r: IdRef,
    /// `mediaType`, `title`, `year`, `discoverSource`, `detail`.
    pub fields: Map<String, Value>,
}

impl Observation {
    /// An observation of `r` with no fields yet.
    #[must_use]
    pub fn new(r: IdRef) -> Self {
        Self {
            r,
            fields: Map::new(),
        }
    }

    /// Set one field (`Value::Null` for `undefined`).
    #[must_use]
    pub fn with(mut self, key: &str, value: Value) -> Self {
        self.fields.insert(key.to_owned(), value);
        self
    }

    fn text(&self, key: &str) -> Option<String> {
        self.fields
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    fn key(&self) -> String {
        format!(
            "{}:{}:{}",
            self.r.ns,
            self.r.id,
            self.text("mediaType").unwrap_or_default()
        )
    }
}

const FLUSH_WINDOW: Duration = Duration::from_secs(5);

#[derive(Debug, Default)]
struct Pending {
    batch: Vec<(String, Observation, i64)>,
    timer: Option<u64>,
    timers: u64,
}

static PENDING: LazyLock<Mutex<Pending>> = LazyLock::new(|| Mutex::new(Pending::default()));

/// `recordMiss(observation)`: count a sighting of an item without a TMDB
/// id; written in a batch within five seconds.
pub fn record_miss(db: &Db, observation: Observation) {
    if observation.r.id.is_empty() {
        return;
    }
    let key = observation.key();
    let mut pending = lock(&PENDING);
    match pending.batch.iter_mut().find(|(k, _, _)| *k == key) {
        Some((_, existing, hits)) => {
            *hits += 1;
            existing.r = observation.r;
            for (k, v) in observation.fields {
                existing.fields.insert(k, v);
            }
        }
        None => pending.batch.push((key, observation, 1)),
    }
    if pending.timer.is_none() {
        pending.timers += 1;
        let id = pending.timers;
        pending.timer = Some(id);
        let db = db.clone();
        tokio::spawn(async move {
            tokio::time::sleep(FLUSH_WINDOW).await;
            let batch = {
                let mut pending = lock(&PENDING);
                if pending.timer != Some(id) {
                    return;
                }
                pending.timer = None;
                std::mem::take(&mut pending.batch)
            };
            write_batch(&db, batch).await;
        });
    }
    drop(pending);
}

async fn write_batch(db: &Db, batch: Vec<(String, Observation, i64)>) {
    for (_, observation, hits) in batch {
        let write = Write {
            media_type: observation.text("mediaType"),
            title: observation.text("title"),
            year: observation
                .fields
                .get("year")
                .and_then(Value::as_f64)
                .and_then(super::int_of),
            discover_source: observation.text("discoverSource"),
            detail: observation.text("detail"),
            r: observation.r,
            origin: "miss",
            hits,
            attempted: false,
            ..Write::default()
        };
        if let Err(e) = save_resolution(db, &write).await {
            tracing::debug!(
                label = "Mapping",
                r#ref = format!("{}:{}", write.r.ns, write.r.id),
                "Unable to record unmapped item: {e:#}"
            );
        }
    }
}

/// `flushMisses()`: write the pending sightings now.
pub async fn flush_misses(db: &Db) {
    let batch = {
        let mut pending = lock(&PENDING);
        pending.timer = None;
        std::mem::take(&mut pending.batch)
    };
    write_batch(db, batch).await;
}
