//! `server/lib/mapping/datasets.ts`: the bulk mapping datasets.
//!
//! Each is refreshed into `mapping_edge` under a new generation and switched over by moving
//! `mapping_dataset.generation`, so readers never see half a dataset.
//!
//! Readers here follow the generation through the database
//! (`crate::mapping`), so the in-memory state is only what the refresh
//! itself needs: enable/disable counts, the run per dataset, and whether
//! an enabled dataset was never written. After every switch the lookup
//! caches (`crate::mappinglayer`) are dropped, and Node, which keeps its
//! own copy, is told to reload (`POST /internal/mapping/datasets/changed`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde_json::{Map, Value};
use tokio::sync::watch;

use crate::clock::Utc;
use crate::db::{Bind, Db};
use crate::jobs::JobCtx;
use crate::mappingpacks::{
    self, begin_pack_progress, end_pack_progress, update_pack_progress, FetchPack, FetchStatus,
    ParsedDataset, Validate,
};
use crate::state::AppState;

/// One dataset (`DatasetDefinition`).
#[derive(Debug)]
pub struct Definition {
    /// Key and `mapping_dataset` primary key.
    pub key: &'static str,
    /// Lower answers first.
    pub rank: i64,
    /// Upstream URLs in order.
    pub urls: &'static [&'static str],
    /// Licence shown in settings.
    pub licence: &'static str,
    /// Note shown in settings.
    pub note: Option<&'static str>,
    /// The parser.
    pub parse: fn(&str) -> Result<ParsedDataset>,
}

/// `DATASETS`, in declaration order.
pub const DATASETS: [Definition; 2] = [
    Definition {
        key: "anibridge",
        rank: 1,
        urls: &[
            "https://github.com/anibridge/anibridge-mappings/releases/download/v3/mappings.min.json",
        ],
        licence: "MIT",
        note: None,
        parse: mappingpacks::parse_anibridge,
    },
    Definition {
        key: "fribb",
        rank: 2,
        urls: &[
            "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json",
            "https://cdn.jsdelivr.net/gh/Fribb/anime-lists@master/anime-list-full.json",
        ],
        licence: "none",
        note: Some(
            "Fribb/anime-lists publishes no licence. It only fills ids anibridge does not have yet, mostly the current season.",
        ),
        parse: mappingpacks::parse_fribb,
    },
];

/// `datasetDefinition(key)`.
#[must_use]
pub fn definition(key: &str) -> Option<&'static Definition> {
    DATASETS.iter().find(|d| d.key == key)
}

/// `extraMirrors(key)`: `MAPPING_MIRROR_TEMPLATES`, `{key}` filled in.
fn extra_mirrors(key: &str) -> Vec<String> {
    let Ok(template) = std::env::var("MAPPING_MIRROR_TEMPLATES") else {
        return Vec::new();
    };
    template
        .split(',')
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .map(|e| e.replace(&String::from_iter(['{', 'k', 'e', 'y', '}']), key))
        .collect()
}

const INSERT_CHUNK: usize = 500;
const MIN_DROP_COMPARE_COUNT: i64 = 1000;
const MAX_DROP_RATIO: f64 = 0.5;
/// Files left on disk by packs that are no longer used.
const RETIRED_FILES: [&str; 2] = ["animeapi.json", "anime-lists.xml"];
/// `MappingDataset`'s columns, in declaration order.
const DATASET_FIELDS: [&str; 10] = [
    "key",
    "enabled",
    "generation",
    "edgeCount",
    "version",
    "etag",
    "lastModified",
    "lastFetchedAt",
    "lastSuccessAt",
    "lastError",
];

type Outcome = Result<RefreshResult, String>;

#[derive(Debug)]
struct Running {
    id: u64,
    toggle: u64,
    done: watch::Receiver<Option<Outcome>>,
}

#[derive(Debug, Default)]
struct Layer {
    toggles: HashMap<String, u64>,
    refreshes: HashMap<String, Running>,
    active_loaded: bool,
    unwritten: bool,
    /// The first download: `Some(true)` while it runs, `Some(false)` for
    /// the hour after (`initialLoad` still set), `None` otherwise.
    initial: Option<bool>,
}

static LAYER: LazyLock<Mutex<Layer>> = LazyLock::new(|| Mutex::new(Layer::default()));
static SEEDING: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));
/// One dataset ingests at a time, so the pauses between its slices leave
/// the write lock free for everyone else.
static INGESTING: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));
static RUN_IDS: AtomicU64 = AtomicU64::new(0);

fn toggle_of(key: &str) -> u64 {
    crate::sync::lock(&LAYER)
        .toggles
        .get(key)
        .copied()
        .unwrap_or(0)
}

/// `DatasetRefreshResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshResult {
    /// Dataset key.
    pub key: String,
    /// `downloaded`, `notModified`, `lastGood`, `skipped` or `failed`.
    pub status: &'static str,
    /// Edge count, when known.
    pub edges: Option<i64>,
    /// Why it failed.
    pub error: Option<String>,
}

impl RefreshResult {
    fn of(key: &str, status: &'static str) -> Self {
        Self {
            key: key.to_owned(),
            status,
            edges: None,
            error: None,
        }
    }

    /// The object Node answers with.
    #[must_use]
    pub fn to_value(&self) -> Value {
        let mut out = Map::new();
        out.insert(String::from("key"), Value::from(self.key.as_str()));
        out.insert(String::from("status"), Value::from(self.status));
        if let Some(edges) = self.edges {
            out.insert(String::from("edges"), Value::from(edges));
        }
        if let Some(error) = &self.error {
            out.insert(String::from("error"), Value::from(error.as_str()));
        }
        Value::Object(out)
    }
}

// ---------------------------------------------------------------------------
// Rows.

/// Every `mapping_dataset` row as `TypeORM` loads it (dates as ISO text).
async fn all_rows(db: &Db) -> Result<Vec<Map<String, Value>>> {
    let sql = format!(
        r#"SELECT "key", "enabled", "generation", "edgeCount", "version", "etag", "lastModified", {} AS "lastFetchedAt", {} AS "lastSuccessAt", "lastError" FROM "mapping_dataset""#,
        db.iso_sql(r#""lastFetchedAt""#),
        db.iso_sql(r#""lastSuccessAt""#)
    );
    let mut rows = db.rows(&sql, &[]).await?;
    for row in &mut rows {
        let enabled = match row.get("enabled") {
            Some(Value::Bool(b)) => *b,
            Some(Value::Number(n)) => n.as_i64().is_some_and(|n| n != 0),
            _ => false,
        };
        row.insert(String::from("enabled"), Value::Bool(enabled));
    }
    Ok(rows)
}

fn row_key(row: &Map<String, Value>) -> &str {
    row.get("key").and_then(Value::as_str).unwrap_or("")
}

fn row_int(row: &Map<String, Value>, name: &str) -> Option<i64> {
    row.get(name).and_then(Value::as_i64)
}

fn row_enabled(row: &Map<String, Value>) -> bool {
    row.get("enabled").and_then(Value::as_bool).unwrap_or(false)
}

/// The entity as `res.json` prints it.
fn entity_json(row: &Map<String, Value>) -> Map<String, Value> {
    DATASET_FIELDS
        .iter()
        .map(|f| ((*f).to_owned(), row.get(*f).cloned().unwrap_or(Value::Null)))
        .collect()
}

/// `ensureRows`: every known dataset has a row; a new one starts enabled
/// and unwritten.
async fn ensure_rows(db: &Db) -> Result<Vec<Map<String, Value>>> {
    {
        let _seeding = SEEDING.lock().await;
        let existing = all_rows(db).await?;
        for def in &DATASETS {
            if existing.iter().any(|r| row_key(r) == def.key) {
                continue;
            }
            let inserted = db
                .execute(
                    r#"INSERT INTO "mapping_dataset" ("key", "enabled", "generation") VALUES (?1, ?2, ?3)"#,
                    &[Bind::Text(def.key.to_owned()), Bind::Bool(true), Bind::Int(0)],
                )
                .await;
            if let Err(e) = inserted {
                // Node may have seeded it meanwhile.
                if !all_rows(db).await?.iter().any(|r| row_key(r) == def.key) {
                    return Err(e);
                }
            }
        }
    }
    all_rows(db).await
}

/// `loadActiveGenerations`: seed the rows and note whether an enabled
/// dataset was never written.
///
/// # Errors
///
/// Fails on database errors.
pub async fn load_active_generations(db: &Db, force: bool) -> Result<()> {
    if crate::sync::lock(&LAYER).active_loaded && !force {
        return Ok(());
    }
    let rows = ensure_rows(db).await?;
    let unwritten = rows.iter().any(|row| {
        row_enabled(row)
            && definition(row_key(row)).is_some()
            && row_int(row, "generation").unwrap_or(0) <= 0
    });
    let mut layer = crate::sync::lock(&LAYER);
    layer.unwritten = unwritten;
    layer.active_loaded = true;
    drop(layer);
    Ok(())
}

/// The readable edge set changed: the lookups follow the database, so
/// their caches and the stored provider rows resolved against the old edge
/// set are dropped.
fn notify_changed() {
    crate::rowcache::mark_stale();
    crate::mappinglayer::datasets_changed();
}

async fn reload(state: &AppState) -> Result<()> {
    load_active_generations(&state.db, true).await?;
    notify_changed();
    Ok(())
}

/// A value to set on a `mapping_dataset` row.
enum Set {
    Bind(Bind),
    Now(Utc),
}

async fn update_row(db: &Db, key: &str, sets: Vec<(&'static str, Set)>) -> Result<()> {
    let mut assignments = Vec::new();
    let mut binds = Vec::new();
    for (column, value) in sets {
        let n = binds.len() + 1;
        match value {
            Set::Bind(bind) => {
                assignments.push(format!(r#""{column}" = ?{n}"#));
                binds.push(bind);
            }
            Set::Now(at) if db.is_postgres() => {
                assignments.push(format!(r#""{column}" = CAST(?{n} AS timestamptz)"#));
                binds.push(Bind::Text(at.iso_string()));
            }
            Set::Now(at) => {
                assignments.push(format!(r#""{column}" = ?{n}"#));
                binds.push(Bind::Text(at.typeorm_string()));
            }
        }
    }
    let n = binds.len() + 1;
    binds.push(Bind::Text(key.to_owned()));
    let sql = format!(
        r#"UPDATE "mapping_dataset" SET {} WHERE "key" = ?{n}"#,
        assignments.join(", ")
    );
    db.execute(&sql, &binds).await?;
    Ok(())
}

async fn delete_generation(db: &Db, key: &str, same: bool, generation: i64) -> Result<()> {
    let op = if same { "=" } else { "<>" };
    let sql =
        format!(r#"DELETE FROM "mapping_edge" WHERE "dataset" = ?1 AND "generation" {op} ?2"#);
    db.execute(&sql, &[Bind::Text(key.to_owned()), Bind::Int(generation)])
        .await?;
    Ok(())
}

/// `writeGeneration`: the edges under `generation`, 500 rows a statement.
///
/// # Errors
///
/// Fails on database errors.
pub async fn write_generation(
    db: &Db,
    key: &str,
    generation: i64,
    edges: &[mappingpacks::EdgeRow],
) -> Result<()> {
    let _ingesting = INGESTING.lock().await;
    delete_generation(db, key, true, generation).await?;
    let total = edges.len();
    let mut done = 0_usize;
    let mut chunks = edges.chunks(INSERT_CHUNK).peekable();
    while chunks.peek().is_some() {
        // One `dataSource.transaction` per slice of at most
        // `INGEST_SLICE_MSEC`, then the progress.
        let mut tx = crate::jobs::syncutil::Tx::begin(db).await?;
        let started = std::time::Instant::now();
        for chunk in chunks.by_ref() {
            let (sql, binds) = edge_insert(key, generation, chunk);
            tx.execute(&sql, &binds).await?;
            done += chunk.len();
            if started.elapsed() >= INGEST_SLICE {
                break;
            }
        }
        tx.commit().await?;
        // Node's single connection queued every other query between
        // slices. Here the others wait in SQLite's busy handler, which
        // only retries every 100 ms or so; beginning the next slice at
        // once would starve them (sign-ins failed with "database is
        // locked" during a first import), so leave the lock free a while.
        tokio::time::sleep(INGEST_PAUSE).await;
        update_pack_progress(
            key,
            &[
                ("phase", Some(Value::from("ingesting"))),
                ("recordsDone", Some(Value::from(done))),
                ("recordsTotal", Some(Value::from(total))),
            ],
        );
    }
    Ok(())
}

/// `INGEST_SLICE_MSEC`.
const INGEST_SLICE: Duration = Duration::from_millis(50);

/// How long the write lock stays free between ingest slices.
const INGEST_PAUSE: Duration = Duration::from_millis(50);

/// The multi-row insert of one chunk of edges.
fn edge_insert(key: &str, generation: i64, chunk: &[mappingpacks::EdgeRow]) -> (String, Vec<Bind>) {
    let mut values = Vec::with_capacity(chunk.len());
    let mut binds = vec![Bind::Text(key.to_owned()), Bind::Int(generation)];
    for edge in chunk {
        let first = binds.len() + 1;
        let slots: Vec<String> = (first..first + 8).map(|i| format!("?{i}")).collect();
        values.push(format!("(?1, ?2, {})", slots.join(", ")));
        binds.extend([
            Bind::Text(edge.src_ns.clone()),
            Bind::Text(edge.src_id.clone()),
            Bind::Text(edge.src_scope.clone()),
            Bind::Text(edge.dst_ns.clone()),
            Bind::Text(edge.dst_id.clone()),
            Bind::Text(edge.dst_scope.clone()),
            Bind::OptText(edge.src_range.clone()),
            Bind::OptText(edge.dst_range.clone()),
        ]);
    }
    let sql = format!(
        r#"INSERT INTO "mapping_edge" ("dataset", "generation", "srcNs", "srcId", "srcScope", "dstNs", "dstId", "dstScope", "srcRange", "dstRange") VALUES {}"#,
        values.join(", ")
    );
    (sql, binds)
}

fn count(n: usize) -> i64 {
    i64::try_from(n).unwrap_or(i64::MAX)
}

// ---------------------------------------------------------------------------
// Refresh.

/// The checks `validate` makes before a download is published.
fn validate(def: &Definition, previous: i64) -> Validate {
    let (key, parse) = (def.key, def.parse);
    Arc::new(move |body: &str| {
        update_pack_progress(key, &[("phase", Some(Value::from("parsing")))]);
        let result = parse(body)?;
        let edges = count(result.edges.len());
        if edges == 0 {
            anyhow::bail!("dataset parsed to zero edges");
        }
        if previous >= MIN_DROP_COMPARE_COUNT
            && crate::jsnum::from_i64(edges) < crate::jsnum::from_i64(previous) * MAX_DROP_RATIO
        {
            anyhow::bail!("dataset dropped from {previous} to {edges} edges");
        }
        Ok(result)
    })
}

/// The body of `refreshUnlocked` inside its `try`.
async fn attempt(
    state: &AppState,
    def: &Definition,
    row: &Map<String, Value>,
    force: bool,
    toggle: u64,
) -> Result<RefreshResult> {
    let key = def.key;
    let db = &state.db;
    let generation_now = row_int(row, "generation").unwrap_or(0);
    let edge_count = row_int(row, "edgeCount");
    let conditional = !force && generation_now > 0;
    let mut mirrors: Vec<String> = def.urls.iter().map(|u| (*u).to_owned()).collect();
    mirrors.extend(extra_mirrors(key));
    let text = |name: &str| row.get(name).and_then(Value::as_str).map(str::to_owned);
    let pack = FetchPack {
        key,
        mirrors: &mirrors,
        cache: conditional.then(|| (text("etag"), text("lastModified"))),
        config_dir: &state.env.config_dir,
        max_bytes: mappingpacks::MAX_PACK_BYTES,
    };
    let client = mappingpacks::download_client(state).await?;
    let check = validate(def, edge_count.unwrap_or(0));
    let fetched = mappingpacks::fetch_pack(&client, &pack, &check).await?;
    let now = Utc::now();
    if fetched.status == FetchStatus::NotModified && generation_now > 0 {
        update_row(
            db,
            key,
            vec![
                ("lastFetchedAt", Set::Now(now)),
                ("lastSuccessAt", Set::Now(now)),
                ("lastError", Set::Bind(Bind::OptText(None))),
            ],
        )
        .await?;
        let mut result = RefreshResult::of(key, "notModified");
        result.edges = edge_count;
        return Ok(result);
    }
    if fetched.status == FetchStatus::LastGood && generation_now > 0 {
        update_row(
            db,
            key,
            vec![
                ("lastFetchedAt", Set::Now(now)),
                (
                    "lastError",
                    Set::Bind(Bind::Text(String::from(
                        "Upstream unreachable; keeping the loaded copy.",
                    ))),
                ),
            ],
        )
        .await?;
        let mut result = RefreshResult::of(key, "lastGood");
        result.edges = edge_count;
        return Ok(result);
    }
    let result = match (fetched.parsed.clone(), fetched.body.as_deref()) {
        (Some(parsed), _) => parsed,
        (None, Some(body)) => {
            let (parse, body) = (def.parse, body.to_owned());
            crate::cpu::run(move || parse(&body)).await??
        }
        (None, None) => ParsedDataset::default(),
    };
    if result.edges.is_empty() {
        anyhow::bail!("dataset has no edges");
    }
    let generation = generation_now + 1;
    write_generation(db, key, generation, &result.edges).await?;
    if toggle_of(key) != toggle {
        delete_generation(db, key, true, generation).await?;
        return Ok(RefreshResult::of(key, "skipped"));
    }
    let edges = count(result.edges.len());
    let version = result.version.clone().or_else(|| {
        fetched
            .sha256
            .as_deref()
            .map(|s| s.chars().take(12).collect())
    });
    let last_good = fetched.status == FetchStatus::LastGood;
    let mut sets = vec![
        ("generation", Set::Bind(Bind::Int(generation))),
        ("edgeCount", Set::Bind(Bind::Int(edges))),
        ("version", Set::Bind(Bind::OptText(version))),
        ("etag", Set::Bind(Bind::OptText(fetched.etag.clone()))),
        (
            "lastModified",
            Set::Bind(Bind::OptText(fetched.last_modified.clone())),
        ),
        ("lastFetchedAt", Set::Now(now)),
    ];
    if !last_good {
        sets.push(("lastSuccessAt", Set::Now(now)));
    }
    sets.push((
        "lastError",
        Set::Bind(Bind::OptText(last_good.then(|| {
            String::from("Upstream unreachable; serving the last downloaded copy.")
        }))),
    ));
    update_row(db, key, sets).await?;
    reload(state).await?;
    delete_generation(db, key, false, generation).await?;
    tracing::info!(
        label = "Mapping",
        status = fetched.status.as_str(),
        edges,
        mirror = fetched.mirror.as_deref().unwrap_or(""),
        "Refreshed mapping dataset {key}"
    );
    let mut out = RefreshResult::of(key, fetched.status.as_str());
    out.edges = Some(edges);
    Ok(out)
}

/// `refreshUnlocked`.
async fn refresh_unlocked(
    state: &AppState,
    def: &Definition,
    force: bool,
    toggle: u64,
) -> Result<RefreshResult> {
    let key = def.key;
    ensure_rows(&state.db).await?;
    let rows = all_rows(&state.db).await?;
    let row = rows
        .into_iter()
        .find(|r| row_key(r) == key)
        .ok_or_else(|| anyhow!("no mapping dataset row for this key"))?;
    if !row_enabled(&row) || toggle_of(key) != toggle {
        return Ok(RefreshResult::of(key, "skipped"));
    }
    begin_pack_progress(key);
    let outcome = match attempt(state, def, &row, force, toggle).await {
        Ok(result) => Ok(result),
        Err(e) => {
            let message = e.to_string();
            let recorded = update_row(
                &state.db,
                key,
                vec![
                    ("lastFetchedAt", Set::Now(Utc::now())),
                    ("lastError", Set::Bind(Bind::Text(message.clone()))),
                ],
            )
            .await;
            match recorded {
                Ok(()) => {
                    tracing::error!(
                        label = "Mapping",
                        "Unable to refresh mapping dataset {key}: {message}"
                    );
                    let mut result = RefreshResult::of(key, "failed");
                    result.error = Some(message);
                    Ok(result)
                }
                Err(e) => Err(e),
            }
        }
    };
    end_pack_progress(key);
    outcome
}

async fn wait_for(mut done: watch::Receiver<Option<Outcome>>) -> Outcome {
    loop {
        let current = done.borrow().clone();
        if let Some(outcome) = current {
            return outcome;
        }
        if done.changed().await.is_err() {
            return done
                .borrow()
                .clone()
                .unwrap_or_else(|| Err(String::from("the refresh stopped")));
        }
    }
}

type Claim = (
    watch::Receiver<Option<Outcome>>,
    Option<(
        watch::Sender<Option<Outcome>>,
        Option<watch::Receiver<Option<Outcome>>>,
        u64,
        u64,
    )>,
);

/// Join the run in flight for `key`, or register a new one behind it.
fn claim(key: &str) -> Claim {
    let mut layer = crate::sync::lock(&LAYER);
    let toggle = layer.toggles.get(key).copied().unwrap_or(0);
    let running = layer.refreshes.get(key).map(|r| (r.toggle, r.done.clone()));
    let claimed = match running {
        Some((same, done)) if same == toggle => (done, None),
        previous => {
            let id = RUN_IDS.fetch_add(1, Ordering::SeqCst);
            let (tx, rx) = watch::channel(None);
            layer.refreshes.insert(
                key.to_owned(),
                Running {
                    id,
                    toggle,
                    done: rx.clone(),
                },
            );
            (rx, Some((tx, previous.map(|(_, done)| done), id, toggle)))
        }
    };
    drop(layer);
    claimed
}

/// `refreshDataset(key, { force })`: download, validate and swap in one
/// dataset. Concurrent calls share a run; a call after an enable or
/// disable queues a fresh run behind the one in flight.
///
/// # Errors
///
/// Fails when the database fails (Node's promise rejects then too).
pub async fn refresh_dataset(
    state: &Arc<AppState>,
    key: &str,
    force: bool,
) -> Result<RefreshResult> {
    let Some(def) = definition(key) else {
        let mut result = RefreshResult::of(key, "failed");
        result.error = Some(String::from("Unknown mapping dataset."));
        return Ok(result);
    };
    let (done, start) = claim(key);
    if let Some((tx, previous, id, toggle)) = start {
        let state = Arc::clone(state);
        tokio::spawn(async move {
            if let Some(previous) = previous {
                // Its outcome is its callers'; this run only waits for it.
                drop(wait_for(previous).await);
            }
            let outcome = refresh_unlocked(&state, def, force, toggle)
                .await
                .map_err(|e| format!("{e:#}"));
            {
                let mut layer = crate::sync::lock(&LAYER);
                if layer.refreshes.get(def.key).is_some_and(|r| r.id == id) {
                    layer.refreshes.remove(def.key);
                }
            }
            if tx.send(Some(outcome)).is_err() {
                tracing::trace!("nobody waits for the {} refresh", def.key);
            }
        });
    }
    wait_for(done).await.map_err(|e| anyhow!(e))
}

/// `refreshAllDatasets`: every dataset by rank, after removing retired
/// files. A dead upstream leaves the current generation in place; a run
/// stops between datasets when the job is cancelled.
///
/// # Errors
///
/// Fails on database errors.
pub async fn refresh_all(
    state: &Arc<AppState>,
    force: bool,
    job: Option<&JobCtx>,
) -> Result<Vec<RefreshResult>> {
    let directory = mappingpacks::pack_directory(&state.env.config_dir);
    for name in RETIRED_FILES {
        for file in [name.to_owned(), format!("{name}.last-good")] {
            if let Err(e) = tokio::fs::remove_file(directory.join(&file)).await {
                tracing::trace!("{file}: {e}");
            }
        }
    }
    let mut ordered: Vec<&Definition> = DATASETS.iter().collect();
    ordered.sort_by_key(|d| d.rank);
    let mut results = Vec::new();
    for def in ordered {
        if job.is_some_and(JobCtx::cancelled) {
            break;
        }
        results.push(refresh_dataset(state, def.key, force).await?);
    }
    Ok(results)
}

/// `setDatasetEnabled`: turn a dataset on or off.
///
/// Disabling deletes its
/// edges, so a later enable starts from a clean download. The row after
/// the change, as `res.json` prints it; `None` for an unknown key.
///
/// # Errors
///
/// Fails on database errors.
pub async fn set_dataset_enabled(
    state: &AppState,
    key: &str,
    enabled: bool,
) -> Result<Option<Value>> {
    if definition(key).is_none() {
        return Ok(None);
    }
    let db = &state.db;
    ensure_rows(db).await?;
    {
        let mut layer = crate::sync::lock(&LAYER);
        *layer.toggles.entry(key.to_owned()).or_insert(0) += 1;
        drop(layer);
    }
    let mut sets = vec![("enabled", Set::Bind(Bind::Bool(enabled)))];
    if !enabled {
        sets.extend([
            ("generation", Set::Bind(Bind::Int(0))),
            ("edgeCount", Set::Bind(Bind::OptInt(None))),
            ("etag", Set::Bind(Bind::OptText(None))),
            ("lastModified", Set::Bind(Bind::OptText(None))),
        ]);
    }
    update_row(db, key, sets).await?;
    reload(state).await?;
    if !enabled {
        delete_generation(db, key, false, 0).await?;
    }
    Ok(all_rows(db)
        .await?
        .iter()
        .find(|r| row_key(r) == key)
        .map(|r| Value::Object(entity_json(r))))
}

/// What Node's `POST /internal/mapping/datasets/:key` does: toggle, and
/// on enable start a refresh in the background.
///
/// # Errors
///
/// Fails on database errors.
pub async fn toggle_dataset(
    state: &Arc<AppState>,
    key: &str,
    enabled: bool,
) -> Result<Option<Value>> {
    let dataset = set_dataset_enabled(state, key, enabled).await?;
    if enabled && dataset.is_some() {
        let state = Arc::clone(state);
        let key = key.to_owned();
        tokio::spawn(async move {
            if let Err(e) = refresh_dataset(&state, &key, false).await {
                tracing::error!(
                    label = "Mapping",
                    "Unable to refresh mapping dataset {key}: {e:#}"
                );
            }
        });
    }
    Ok(dataset)
}

/// `listDatasets`: each known dataset's row with its licence, note and
/// rank, in `DATASETS` order.
///
/// # Errors
///
/// Fails on database errors.
pub async fn list_datasets(db: &Db) -> Result<Vec<Value>> {
    let rows = ensure_rows(db).await?;
    Ok(DATASETS
        .iter()
        .filter_map(|def| {
            let row = rows.iter().find(|r| row_key(r) == def.key)?;
            let mut out = entity_json(row);
            out.insert(String::from("licence"), Value::from(def.licence));
            if let Some(note) = def.note {
                out.insert(String::from("note"), Value::from(note));
            }
            out.insert(String::from("rank"), Value::from(def.rank));
            Some(Value::Object(out))
        })
        .collect())
}

/// `datasetsLoading()`: the first download is running.
#[must_use]
pub fn datasets_loading() -> bool {
    crate::sync::lock(&LAYER).initial == Some(true)
}

/// Mark the first download as started, unless nothing is unwritten or one
/// ran within the hour.
fn start_initial_load() -> bool {
    let mut layer = crate::sync::lock(&LAYER);
    let start = layer.unwritten && layer.initial.is_none();
    if start {
        layer.initial = Some(true);
    }
    drop(layer);
    start
}

/// `ensureMappingLayer`: load the dataset state and, when an enabled
/// dataset was never written, download everything in the background
/// (once an hour at most; the nightly job retries failures).
///
/// # Errors
///
/// Fails on database errors.
pub async fn ensure_mapping_layer(state: Arc<AppState>) -> Result<()> {
    load_active_generations(&state.db, false).await?;
    if !start_initial_load() {
        return Ok(());
    }
    tokio::spawn(async move {
        if let Err(e) = refresh_all(&state, false, None).await {
            tracing::error!(
                label = "Mapping",
                "Unable to start loading the mapping datasets: {e:#}"
            );
        }
        crate::sync::lock(&LAYER).initial = Some(false);
        tokio::time::sleep(Duration::from_secs(3600)).await;
        crate::sync::lock(&LAYER).initial = None;
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn results_print_like_node() {
        let mut result = RefreshResult::of("fribb", "failed");
        result.error = Some(String::from("x"));
        assert_eq!(
            result.to_value().to_string(),
            r#"{"key":"fribb","status":"failed","error":"x"}"#,
            "failed"
        );
        let mut result = RefreshResult::of("anibridge", "downloaded");
        result.edges = Some(3);
        assert_eq!(
            result.to_value().to_string(),
            r#"{"key":"anibridge","status":"downloaded","edges":3}"#,
            "downloaded"
        );
    }

    #[test]
    fn drop_check() {
        let Some(def) = definition("fribb") else {
            return;
        };
        let check = validate(def, 5000);
        let body = r#"[{"anilist_id": 1, "themoviedb_id": {"tv": 2}}]"#;
        let err = check(body).err().map(|e| e.to_string());
        assert_eq!(
            err.as_deref(),
            Some("dataset dropped from 5000 to 2 edges"),
            "a large drop"
        );
        assert!(validate(def, 0)(body).is_ok(), "no previous copy");
        assert_eq!(
            validate(def, 0)("[]")
                .err()
                .map(|e| e.to_string())
                .as_deref(),
            Some("dataset parsed to zero edges"),
            "empty"
        );
        assert!(definition("nope").is_none(), "unknown");
    }
}
