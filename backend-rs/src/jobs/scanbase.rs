//! `BaseScanner` (`server/lib/scanners/baseScanner.ts`).
//!
//! What every library and *arr scanner shares — the run session and its status board,
//! the bundle loop, the per-title lock — plus the helpers the scanners use
//! to talk to Node (the mapping layer behind `animeList`, the TVDB
//! metadata provider) and to save settings.
//!
//! Node's scanners are singletons whose `status()` outlives a run (the last
//! libraries, progress and total stay until the next run replaces them);
//! the boards here are kept the same way, one per job id.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde_json::{Map, Value};

use super::JobCtx;
use crate::settings::public::truthy;
use crate::sync::lock;

/// `MediaStatus.UNKNOWN`.
pub const UNKNOWN: i64 = 1;
/// `MediaStatus.PROCESSING`.
pub const PROCESSING: i64 = 3;
/// `MediaStatus.PARTIALLY_AVAILABLE`.
pub const PARTIAL: i64 = 4;
/// `MediaStatus.AVAILABLE`.
pub const AVAILABLE: i64 = 5;
/// `MediaStatus.DELETED`.
pub const DELETED: i64 = 7;

/// `UPDATE_RATE`: the pause between bundles.
const UPDATE_RATE: Duration = Duration::from_secs(4);
/// `BUNDLE_SIZE`, the default bundle.
pub const BUNDLE_SIZE: usize = 20;
/// `SCAN_ITEM_CONCURRENCY`.
const SCAN_ITEM_CONCURRENCY: usize = 2;

/// Which scanner a board belongs to and how its status names things.
#[derive(Debug)]
pub struct Kind {
    /// The job id.
    pub id: &'static str,
    /// `scannerName`, the log label.
    pub label: &'static str,
    /// `currentLibrary` or `currentServer`.
    current_key: &'static str,
    /// `libraries` or `servers`.
    list_key: &'static str,
}

impl Kind {
    /// A library scanner (`currentLibrary`, `libraries`).
    #[must_use]
    pub const fn library(id: &'static str, label: &'static str) -> Self {
        Self {
            id,
            label,
            current_key: "currentLibrary",
            list_key: "libraries",
        }
    }

    /// An *arr scanner (`currentServer`, `servers`).
    #[must_use]
    pub const fn server(id: &'static str, label: &'static str) -> Self {
        Self {
            id,
            label,
            current_key: "currentServer",
            list_key: "servers",
        }
    }
}

/// A scanner singleton's fields that `status()` prints.
#[derive(Debug, Default)]
struct Board {
    session: u64,
    running: bool,
    progress: i64,
    total: i64,
    current: Option<Value>,
    list: Option<Value>,
    job: Option<JobCtx>,
}

impl Board {
    fn running(&self) -> bool {
        self.running && !self.job.as_ref().is_some_and(JobCtx::cancelled)
    }

    fn json(&self, kind: &Kind) -> Map<String, Value> {
        let mut out = Map::new();
        out.insert(String::from("running"), Value::Bool(self.running()));
        out.insert(String::from("progress"), Value::from(self.progress));
        out.insert(String::from("total"), Value::from(self.total));
        if let Some(current) = &self.current {
            out.insert(kind.current_key.to_owned(), current.clone());
        }
        if let Some(list) = &self.list {
            out.insert(kind.list_key.to_owned(), list.clone());
        }
        out
    }
}

static BOARDS: LazyLock<Mutex<HashMap<&'static str, Board>>> = LazyLock::new(Mutex::default);
static SESSIONS: AtomicU64 = AtomicU64::new(0);

/// Change a board and show the result on its run's status.
fn update(kind: &Kind, change: impl FnOnce(&mut Board)) {
    let mut boards = lock(&BOARDS);
    let board = boards.entry(kind.id).or_default();
    change(board);
    let json = board.json(kind);
    let job = board.job.clone();
    drop(boards);
    if let Some(job) = job {
        job.progress(|p| p.status = json);
    }
}

/// `scanner.status()`: `{ running, progress, total, current…, list… }`.
///
/// The fields of the last run (`running: false, progress: 0, total: 0`
/// before the first). `running` turns false as soon as the run is
/// cancelled, as Node's `cancel()` does.
#[must_use]
pub fn status(kind: &Kind) -> Map<String, Value> {
    lock(&BOARDS)
        .get(kind.id)
        .map_or_else(|| Board::default().json(kind), |b| b.json(kind))
}

/// `scanner.cancel()`: `running = false`; the run stops at its next check.
pub fn cancel(kind: &Kind) {
    update(kind, |b| b.running = false);
}

/// A random v4 UUID, for the "Scan starting" log line.
fn uuid() -> String {
    let bytes: [u8; 16] = rand::random();
    let hex: String = bytes
        .iter()
        .enumerate()
        .map(|(i, b)| match i {
            6 => format!("{:02x}", (b & 0x0f) | 0x40),
            8 => format!("{:02x}", (b & 0x3f) | 0x80),
            _ => format!("{b:02x}"),
        })
        .collect();
    let part = |a: usize, b: usize| hex.get(a..b).unwrap_or_default().to_owned();
    format!(
        "{}-{}-{}-{}-{}",
        part(0, 8),
        part(8, 12),
        part(12, 16),
        part(16, 20),
        part(20, 32)
    )
}

/// One run of a scanner (`startRun` … `endRun`).
#[derive(Debug)]
pub struct Scan<'a> {
    /// The job.
    pub job: &'a JobCtx,
    /// The scanner.
    pub kind: &'static Kind,
    session: u64,
    /// `enable4kMovie`: a 4K Radarr server exists.
    pub enable4k_movie: bool,
    /// `enable4kShow`: a 4K Sonarr server exists.
    pub enable4k_show: bool,
    locks: Arc<KeyLock>,
}

/// A run's [`Scan`] that owns its job, for work the run starts without
/// awaiting it (a promise Node never awaits).
#[derive(Debug)]
pub struct Detached {
    job: JobCtx,
    kind: &'static Kind,
    session: u64,
    enable4k_movie: bool,
    enable4k_show: bool,
    locks: Arc<KeyLock>,
}

impl Detached {
    /// The run again, borrowing the owned job.
    #[must_use]
    pub fn scan(&self) -> Scan<'_> {
        Scan {
            job: &self.job,
            kind: self.kind,
            session: self.session,
            enable4k_movie: self.enable4k_movie,
            enable4k_show: self.enable4k_show,
            locks: Arc::clone(&self.locks),
        }
    }
}

/// Whether any server of `settings[key]` is a 4K one.
fn any_4k(job: &JobCtx, key: &str) -> bool {
    job.settings
        .get(key)
        .and_then(Value::as_array)
        .is_some_and(|servers| servers.iter().any(|s| truthy(s.get("is4k"))))
}

impl<'a> Scan<'a> {
    /// `startRun()`.
    #[must_use]
    pub fn start(job: &'a JobCtx, kind: &'static Kind) -> Self {
        let session = SESSIONS.fetch_add(1, Ordering::SeqCst) + 1;
        let session_id = uuid();
        tracing::info!(label = kind.label, sessionId = %session_id, "Scan starting");
        let enable4k_movie = any_4k(job, "/radarr");
        if enable4k_movie {
            tracing::info!(
                label = kind.label,
                "At least one 4K Radarr server was detected. 4K movie detection is now enabled"
            );
        }
        let enable4k_show = any_4k(job, "/sonarr");
        if enable4k_show {
            tracing::info!(
                label = kind.label,
                "At least one 4K Sonarr server was detected. 4K series detection is now enabled"
            );
        }
        update(kind, |b| {
            b.session = session;
            b.running = true;
            b.job = Some(job.clone());
        });
        Self {
            job,
            kind,
            session,
            enable4k_movie,
            enable4k_show,
            locks: Arc::default(),
        }
    }

    /// This run with its own copy of the job, to move into a task.
    #[must_use]
    pub fn detach(&self) -> Detached {
        Detached {
            job: self.job.clone(),
            kind: self.kind,
            session: self.session,
            enable4k_movie: self.enable4k_movie,
            enable4k_show: self.enable4k_show,
            locks: Arc::clone(&self.locks),
        }
    }

    /// `endRun(sessionId)`.
    pub fn end(&self) {
        let session = self.session;
        update(self.kind, |b| {
            if b.session == session {
                b.running = false;
            }
        });
    }

    /// The checks at the top of `loop` and `paginateLibrary`.
    ///
    /// # Errors
    ///
    /// `Sync was aborted.` after a cancel, `New session was started. Old
    /// session aborted.` when another run took over.
    pub fn check(&self) -> Result<()> {
        let (running, session) = lock(&BOARDS)
            .get(self.kind.id)
            .map_or((false, 0), |b| (b.running(), b.session));
        if !running {
            return Err(anyhow!("Sync was aborted."));
        }
        if session != self.session {
            return Err(anyhow!("New session was started. Old session aborted."));
        }
        Ok(())
    }

    /// `this.progress = n`.
    pub fn set_progress(&self, n: usize) {
        let n = i64::try_from(n).unwrap_or(i64::MAX);
        update(self.kind, |b| b.progress = n);
    }

    /// `this.totalSize = n` / `this.items = …` (the total `status()` shows).
    pub fn set_total(&self, n: i64) {
        update(self.kind, |b| b.total = n);
    }

    /// `this.currentLibrary` / `this.currentServer`.
    pub fn set_current(&self, value: &Value) {
        update(self.kind, |b| b.current = Some(value.clone()));
    }

    /// `this.libraries` / `this.servers`.
    pub fn set_list(&self, values: &[Value]) {
        update(self.kind, |b| b.list = Some(Value::Array(values.to_vec())));
    }

    /// `this.log(message, 'debug')`.
    pub fn debug(&self, message: &str) {
        tracing::debug!(label = self.kind.label, "{message}");
    }

    /// `this.log(message, 'info')`.
    pub fn info(&self, message: &str) {
        tracing::info!(label = self.kind.label, "{message}");
    }

    /// `this.log(message, 'warn')`.
    pub fn warn(&self, message: &str) {
        tracing::warn!(label = self.kind.label, "{message}");
    }

    /// `this.log(message, 'error', { errorMessage })`.
    pub fn error(&self, message: &str, error: &anyhow::Error) {
        tracing::error!(label = self.kind.label, errorMessage = %format!("{error:#}"), "{message}");
    }

    /// `asyncLock.dispatch(tmdbId, …)`: one title at a time.
    pub async fn lock_title(&self, tmdb_id: i64) -> tokio::sync::OwnedMutexGuard<()> {
        self.locks.lock(tmdb_id).await
    }

    /// `loop(processFn)`: the items in bundles, each processed two at a
    /// time, `progress` at the bundle's start, a pause after each bundle,
    /// and the abort checks before every bundle and once after the last.
    ///
    /// # Errors
    ///
    /// The abort reasons of [`Self::check`].
    pub async fn bundles<T, F, Fut>(&self, items: &[T], bundle: usize, process: F) -> Result<()>
    where
        T: Clone + Sync,
        F: Fn(T) -> Fut + Sync,
        Fut: Future<Output = ()> + Send,
    {
        let mut start = 0;
        loop {
            self.check()?;
            if start >= items.len() {
                return Ok(());
            }
            self.set_progress(start);
            let end = start.saturating_add(bundle).min(items.len());
            concurrently(items.get(start..end).unwrap_or_default(), &process).await;
            tokio::time::sleep(UPDATE_RATE).await;
            start = start.saturating_add(bundle);
        }
    }

    /// The pause between pages (`protectedUpdateRate`).
    pub async fn pause() {
        tokio::time::sleep(UPDATE_RATE).await;
    }
}

/// `mapWithConcurrency(items, SCAN_ITEM_CONCURRENCY, fn)`: in order, two at
/// a time.
pub async fn concurrently<T, F, Fut>(items: &[T], process: &F)
where
    T: Clone + Sync,
    F: Fn(T) -> Fut + Sync,
    Fut: Future<Output = ()> + Send,
{
    let next = AtomicUsize::new(0);
    let worker = || async {
        loop {
            let i = next.fetch_add(1, Ordering::SeqCst);
            let Some(item) = items.get(i) else {
                break;
            };
            process(item.clone()).await;
        }
    };
    debug_assert_eq!(SCAN_ITEM_CONCURRENCY, 2, "two workers below");
    tokio::join!(worker(), worker());
}

/// `AsyncLock`: one holder per key.
#[derive(Debug, Default)]
struct KeyLock(Mutex<HashMap<i64, Arc<tokio::sync::Mutex<()>>>>);

impl KeyLock {
    async fn lock(&self, key: i64) -> tokio::sync::OwnedMutexGuard<()> {
        let mutex = Arc::clone(lock(&self.0).entry(key).or_default());
        mutex.lock_owned().await
    }
}

/// lodash `uniqWith`: the first of each group of equal items, in order.
#[must_use]
pub fn uniq_with<T: Clone>(items: &[T], same: impl Fn(&T, &T) -> bool) -> Vec<T> {
    let mut out: Vec<T> = Vec::new();
    for item in items {
        if !out.iter().any(|kept| same(item, kept)) {
            out.push(item.clone());
        }
    }
    out
}

/// JavaScript truthiness of a JSON value (`undefined` for `None`).
#[must_use]
pub fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `Number(value)` for ids: integers from numbers and decimal strings;
/// `None` for what would be `0` or `NaN` (both falsy where Node tests the
/// result) and for fractions, which no id has.
#[must_use]
pub fn js_id(value: Option<&Value>) -> Option<i64> {
    let n = match value? {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() || !t.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
                return None;
            }
            t.parse::<f64>().ok()?
        }
        Value::Bool(true) => 1.0,
        Value::Null | Value::Bool(false) | Value::Array(_) | Value::Object(_) => return None,
    };
    if n == 0.0 || n.fract() != 0.0 || !n.is_finite() {
        return None;
    }
    format!("{n:.0}").parse().ok()
}

/// A JSON string field, `None` when missing or not a string.
#[must_use]
pub fn str_of<'v>(value: &'v Value, key: &str) -> Option<&'v str> {
    value.get(key).and_then(Value::as_str)
}

/// A JSON array field, empty when missing.
#[must_use]
pub fn array_of<'v>(value: &'v Value, key: &str) -> &'v [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// `new Date(text)` for the dates media servers send
/// (`2024-01-01T10:20:30.1234567Z`, with `Z` or `+00:00`).
#[must_use]
pub fn parse_date(text: &str) -> Option<i64> {
    let normalized = text
        .strip_suffix("+00:00")
        .map_or_else(|| text.to_owned(), |t| format!("{t}Z"));
    crate::clock::parse_date_millis(&normalized)
}

/// Ask Node (`/internal{path}`) for what only it holds.
///
/// # Errors
///
/// Fails when Node can't be reached, refuses or doesn't answer JSON.
pub async fn node_call(job: &JobCtx, method: reqwest::Method, path: &str) -> Result<Value> {
    if crate::routes::procstate::in_process(path) {
        return crate::standalone::internal::call(&job.state, &method, path, None)
            .await
            .into_result(path);
    }
    let url = format!(
        "{}/internal{path}",
        job.state.env.node_url.trim_end_matches('/')
    );
    let response = job
        .state
        .internal
        .request(method, url)
        .header("X-API-Key", job.settings.api_key())
        .send()
        .await
        .with_context(|| format!("asking Node for {path}"))?
        .error_for_status()
        .with_context(|| format!("Node refused {path}"))?;
    let bytes = response.bytes().await.context("reading Node's answer")?;
    if bytes.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&bytes).with_context(|| format!("Node's answer to {path}"))
}

/// `settings.save()` after a scan's change to the shared settings.
///
/// `change` runs on the latest settings under the mutation lock (see
/// [`crate::settings::SettingsStore::mutate`]), then Node reloads the file
/// (only logged when it can't be told).
///
/// # Errors
///
/// Fails when the file can't be read or written.
pub async fn mutate_settings(job: &JobCtx, change: impl FnOnce(&mut Value)) -> Result<()> {
    job.state.settings.update(change).await?;
    if let Err(e) = node_call(job, reqwest::Method::POST, "/settings/reload").await {
        tracing::warn!("Node could not be told to reload settings: {e:#}");
    }
    Ok(())
}

/// What `animeList` (the mapping layer) knows about an
/// `AniDB` id or a TVDB special.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AnidbItem {
    /// `tvdbId`.
    pub tvdb_id: Option<i64>,
    /// `tmdbId`.
    pub tmdb_id: Option<i64>,
    /// `imdbId`.
    pub imdb_id: Option<String>,
    /// `tvdbSeason`.
    pub tvdb_season: Option<i64>,
}

impl AnidbItem {
    fn parse(value: &Value) -> Option<Self> {
        let item = value.get("item").filter(|v| v.is_object())?;
        Some(Self {
            tvdb_id: item.get("tvdbId").and_then(Value::as_i64),
            tmdb_id: item.get("tmdbId").and_then(Value::as_i64),
            imdb_id: str_of(item, "imdbId").map(str::to_owned),
            tvdb_season: item.get("tvdbSeason").and_then(Value::as_i64),
        })
    }
}

/// `animeList.sync()` (`ensureMappingLayer`). Node being unreachable is
/// only logged: the lookups that need the layer fail on their own.
///
/// # Errors
///
/// Node answered that the mapping layer failed to load.
pub async fn anime_sync(job: &JobCtx) -> Result<()> {
    if crate::mappinglayer::owned() {
        let ctx = crate::mappinglayer::Ctx::with_settings(&job.state, &job.settings);
        return Box::pin(crate::mappinglayer::animelist::sync(&ctx)).await;
    }
    match node_call(job, reqwest::Method::POST, "/animelist/sync").await {
        Ok(_) => Ok(()),
        Err(e) if refused(&e) => Err(e),
        Err(e) => {
            tracing::warn!("Mapping layer sync skipped: {e:#}");
            Ok(())
        }
    }
}

/// Whether the error is Node answering with an error status.
fn refused(e: &anyhow::Error) -> bool {
    e.chain()
        .filter_map(|c| c.downcast_ref::<reqwest::Error>())
        .any(reqwest::Error::is_status)
}

/// `animeList.getFromAnidbId(id)`.
///
/// # Errors
///
/// Fails when Node can't answer.
pub async fn anime_from_anidb(job: &JobCtx, anidb_id: i64) -> Result<Option<AnidbItem>> {
    if crate::mappinglayer::owned() {
        let ctx = crate::mappinglayer::Ctx::with_settings(&job.state, &job.settings);
        return Box::pin(crate::mappinglayer::animelist::from_anidb(&ctx, anidb_id)).await;
    }
    let answer = node_call(
        job,
        reqwest::Method::GET,
        &format!("/animelist/anidb/{anidb_id}"),
    )
    .await?;
    Ok(AnidbItem::parse(&answer))
}

/// `animeList.getSpecialEpisode(tvdbId, episode)`.
///
/// # Errors
///
/// Fails when Node can't answer.
pub async fn anime_special(job: &JobCtx, tvdb_id: i64, episode: i64) -> Result<Option<AnidbItem>> {
    if crate::mappinglayer::owned() {
        let ctx = crate::mappinglayer::Ctx::with_settings(&job.state, &job.settings);
        return Box::pin(crate::mappinglayer::animelist::special_episode(
            &ctx, tvdb_id, episode,
        ))
        .await;
    }
    let answer = node_call(
        job,
        reqwest::Method::GET,
        &format!("/animelist/special/{tvdb_id}/{episode}"),
    )
    .await?;
    Ok(AnidbItem::parse(&answer))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_truthiness() {
        assert_eq!(js_id(Some(&Value::from("123"))), Some(123), "string id");
        assert_eq!(js_id(Some(&Value::from(" 7 "))), Some(7), "trimmed");
        assert_eq!(js_id(Some(&Value::from(""))), None, "Number('') is 0");
        assert_eq!(js_id(Some(&Value::from("tt1"))), None, "NaN");
        assert_eq!(js_id(Some(&Value::from(42))), Some(42), "number");
        assert_eq!(js_id(None), None, "Number(null) is 0");
        assert!(!js_truthy(Some(&Value::from(""))), "empty string");
        assert!(js_truthy(Some(&Value::from("0"))), "non-empty string");
        assert!(!js_truthy(Some(&Value::from(0))), "zero");
    }

    #[test]
    fn uniq_keeps_first() {
        let items = [1, 2, 11, 3, 12];
        assert_eq!(
            uniq_with(&items, |a, b| a % 10 == b % 10),
            vec![1, 2, 3],
            "first of each class"
        );
    }

    #[test]
    fn dates_and_uuid() {
        assert_eq!(
            parse_date("2024-01-02T03:04:05.1234567Z"),
            Some(1_704_164_645_123),
            "seven fraction digits"
        );
        assert_eq!(
            parse_date("2024-01-02T03:04:05.123+00:00"),
            Some(1_704_164_645_123),
            "UTC offset"
        );
        let id = uuid();
        assert_eq!(id.len(), 36, "uuid length");
        assert_eq!(id.get(14..15), Some("4"), "version 4");
    }

    #[test]
    fn status_board() {
        static KIND: Kind = Kind::library("test-scan", "Test Scan");
        let empty = status(&KIND);
        assert_eq!(
            Value::Object(empty).to_string(),
            r#"{"running":false,"progress":0,"total":0}"#,
            "before any run"
        );
        update(&KIND, |b| {
            b.running = true;
            b.list = Some(Value::Array(Vec::new()));
            b.current = Some(Value::from("x"));
        });
        assert_eq!(
            Value::Object(status(&KIND)).to_string(),
            r#"{"running":true,"progress":0,"total":0,"currentLibrary":"x","libraries":[]}"#,
            "status order"
        );
        cancel(&KIND);
        assert_eq!(
            status(&KIND).get("running"),
            Some(&Value::Bool(false)),
            "cancelled"
        );
    }
}
