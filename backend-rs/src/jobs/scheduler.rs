//! `server/job/schedule.ts`: the job scheduler.
//!
//! The jobs run on their `settings.jobs[id].schedule` cron strings, run through the managed executor (`execution.rs`), and
//! what the job settings routes show and do. Active when the process owns
//! the jobs (`FORESEERR_RUST_JOBS=1`); Node then skips `startJobs()`.
//!
//! Timers follow node-schedule: the first run is the cron's next occurrence
//! after the moment of scheduling, each later one the occurrence after the
//! previous one. The desktop runtime's launch catch-up and playback
//! deferral live in `src/runtime/desktop.rs`.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use serde_json::{Map, Value};

use super::cron::{CronExpr, CronIter};
use super::execution::{run_recorded, Slots, Weight};
use super::JobCtx;
use crate::state::AppState;

static RUST_JOBS: LazyLock<bool> = LazyLock::new(|| {
    std::env::var("FORESEERR_RUST_JOBS").is_ok_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        || crate::standalone::enabled()
});

/// `FORESEERR_RUST_JOBS=1` (or standalone mode): this process schedules and
/// runs the jobs and owns their state (the download tracker included).
#[must_use]
pub fn rust_jobs() -> bool {
    *RUST_JOBS
}

/// What `cancelFn` does to the job's `running()`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Cancel {
    /// No `running()` and no `cancelFn`.
    None,
    /// `cancel()` sets `running = false` at once (scanners, availability
    /// sync, blocklisted tags).
    StopsRunning,
    /// `cancel()` sets a flag; `running` stays true until the run ends.
    Flag,
}

/// One entry of `startJobs()`.
#[derive(Debug)]
pub struct JobDef {
    /// `JobId`.
    pub id: &'static str,
    /// The name the job list shows.
    pub name: &'static str,
    /// The name the cron callback and `runScheduledJob` log.
    pub log_name: &'static str,
    /// `process` or `command`.
    kind: &'static str,
    /// `seconds`, `minutes`, `hours`, `days` or `fixed`.
    interval: &'static str,
    /// The executor slot it takes.
    pub weight: Weight,
    cancel: Cancel,
}

const fn def(
    id: &'static str,
    name: &'static str,
    log_name: &'static str,
    interval: &'static str,
    weight: Weight,
    cancel: Cancel,
) -> JobDef {
    JobDef {
        id,
        name,
        log_name,
        kind: "process",
        interval,
        weight,
        cancel,
    }
}

const PLEX_JOBS: [JobDef; 4] = [
    def(
        "plex-recently-added-scan",
        "Plex Recently Added Scan",
        "Plex Recently Added Scan",
        "minutes",
        Weight::Heavy,
        Cancel::StopsRunning,
    ),
    def(
        "plex-full-scan",
        "Plex Full Library Scan",
        "Plex Full Library Scan",
        "hours",
        Weight::Heavy,
        Cancel::StopsRunning,
    ),
    def(
        "plex-refresh-token",
        "Plex Refresh Token",
        "Plex Refresh Token",
        "fixed",
        Weight::Light,
        Cancel::None,
    ),
    def(
        "plex-watchlist-sync",
        "Plex Watchlist Sync",
        "Plex Watchlist Sync",
        "seconds",
        Weight::Light,
        Cancel::None,
    ),
];

const JELLYFIN_JOBS: [JobDef; 2] = [
    def(
        "jellyfin-recently-added-scan",
        "Jellyfin Recently Added Scan",
        "Jellyfin Recently Added Scan",
        "minutes",
        Weight::Heavy,
        Cancel::StopsRunning,
    ),
    def(
        "jellyfin-full-scan",
        "Jellyfin Full Library Scan",
        "Jellyfin Full Scan",
        "hours",
        Weight::Heavy,
        Cancel::StopsRunning,
    ),
];

const COMMON_JOBS: [JobDef; 10] = [
    def(
        "radarr-scan",
        "Radarr Scan",
        "Radarr Scan",
        "minutes",
        Weight::Heavy,
        Cancel::StopsRunning,
    ),
    def(
        "episode-request-sync",
        "Episode Request Sync",
        "Episode Request Sync",
        "minutes",
        Weight::Light,
        Cancel::Flag,
    ),
    def(
        "release-calendar-sync",
        "Release Calendar Sync",
        "Release Calendar Sync",
        "hours",
        Weight::Light,
        Cancel::Flag,
    ),
    def(
        "sonarr-scan",
        "Sonarr Scan",
        "Sonarr Scan",
        "minutes",
        Weight::Heavy,
        Cancel::StopsRunning,
    ),
    def(
        "availability-sync",
        "Media Availability Sync",
        "Media Availability Sync",
        "hours",
        Weight::Heavy,
        Cancel::StopsRunning,
    ),
    JobDef {
        kind: "command",
        ..def(
            "download-sync",
            "Download Sync",
            "Download Sync",
            "seconds",
            Weight::Light,
            Cancel::None,
        )
    },
    JobDef {
        kind: "command",
        ..def(
            "download-sync-reset",
            "Download Sync Reset",
            "Download Sync Reset",
            "hours",
            Weight::Light,
            Cancel::None,
        )
    },
    def(
        "image-cache-cleanup",
        "Image Cache Cleanup",
        "Image Cache Cleanup",
        "hours",
        Weight::Light,
        Cancel::None,
    ),
    def(
        "process-blocklisted-tags",
        "Process Blocklisted Tags",
        "Process Blocklisted Tags",
        "days",
        Weight::Heavy,
        Cancel::StopsRunning,
    ),
    def(
        "mapping-pack-refresh",
        "Mapping Dataset Refresh",
        "Mapping Dataset Refresh",
        "days",
        Weight::Light,
        Cancel::None,
    ),
];

/// The job of an id, whatever the media server.
#[must_use]
pub fn definition(id: &str) -> Option<&'static JobDef> {
    PLEX_JOBS
        .iter()
        .chain(JELLYFIN_JOBS.iter())
        .chain(COMMON_JOBS.iter())
        .find(|d| d.id == id)
}

/// The registry: job id → its `run`. Jobs ported by other modules are
/// wired in here (`crate::jobs::<module>::run(job).await`); until then they
/// log that they are not ported and do nothing.
async fn run_job(id: &str, job: &JobCtx) -> anyhow::Result<()> {
    match id {
        "download-sync" => super::downloadtracker::update(job).await,
        "download-sync-reset" => {
            super::downloadtracker::reset();
            Ok(())
        }
        "plex-refresh-token" => super::refreshtoken::run(job).await,
        "image-cache-cleanup" => super::image_cache_cleanup::run(job).await,
        "mapping-pack-refresh" => super::mapping_refresh::run(job).await,
        "plex-recently-added-scan" => super::plexscan::run_recent(job).await,
        "plex-full-scan" => super::plexscan::run_full(job).await,
        "jellyfin-recently-added-scan" => super::jellyfinscan::run_recent(job).await,
        "jellyfin-full-scan" => super::jellyfinscan::run_full(job).await,
        "radarr-scan" => super::arrscan::run_radarr(job).await,
        "sonarr-scan" => super::arrscan::run_sonarr(job).await,
        "availability-sync" => super::availability_sync::run(job).await,
        "episode-request-sync" => super::episode_request_sync::run(job).await,
        "release-calendar-sync" => super::release_calendar::run(job).await,
        "plex-watchlist-sync" => super::watchlist_sync::run(job).await,
        "process-blocklisted-tags" => super::blocklisted_tags::run(job).await,
        _ => Err(anyhow::anyhow!("Unknown job: {id}")),
    }
}

/// How a schedule fires: a cron's occurrences, or once at a date (what
/// node-schedule makes of a string `new Date()` reads).
enum Plan {
    Cron(Box<CronIter<chrono::Local>>),
    Once,
}

/// `job.schedule(spec)`: the plan and its first moment, or `None` when
/// node-schedule rejects the spec. Only ISO dates (`2030-01-01`,
/// `2030-01-01T05:00:00Z`) are read as one-off dates.
fn plan(spec: &str, now: i64) -> Option<(Plan, i64)> {
    if let Ok(expr) = CronExpr::parse(spec) {
        let mut it = CronIter::new(expr, chrono::Local, now, None);
        if let Ok(first) = it.next_after() {
            return Some((Plan::Cron(Box::new(it)), first));
        }
    }
    crate::clock::parse_date_millis(spec)
        .filter(|at| *at >= now)
        .map(|at| (Plan::Once, at))
}

/// One entry of `scheduledJobs`.
#[derive(Debug)]
struct Scheduled {
    def: &'static JobDef,
    cron_schedule: Value,
    /// `job` is null: the schedule in settings.json never parsed.
    broken: bool,
    /// `nextInvocation()`.
    next: Option<i64>,
    /// Bumped on every reschedule; a timer of an older one stops.
    generation: u64,
    timer: Option<tokio::task::AbortHandle>,
}

/// The latest run of a job id.
#[derive(Debug)]
struct Run {
    ctx: JobCtx,
    /// The run's `AbortController` was aborted (`cancelManagedJob`).
    aborted: Arc<AtomicBool>,
}

#[derive(Debug, Default)]
struct Inner {
    jobs: Vec<Scheduled>,
    slots: Slots,
    runs: HashMap<String, Run>,
    /// `stopJobs()` ran: nothing is scheduled or admitted any more.
    stopped: bool,
}

static INNER: LazyLock<Mutex<Inner>> = LazyLock::new(Mutex::default);

/// Woken whenever a run frees its slot.
static RELEASED: LazyLock<tokio::sync::Notify> = LazyLock::new(tokio::sync::Notify::new);

fn inner() -> MutexGuard<'static, Inner> {
    crate::sync::lock(&INNER)
}

impl Inner {
    /// `job.running ? job.running() : false`.
    fn running(&self, def: &JobDef) -> bool {
        if def.cancel == Cancel::None || !self.slots.is_active(def.id) {
            return false;
        }
        let cancelled = self.runs.get(def.id).is_some_and(|run| run.ctx.cancelled());
        !(cancelled && def.cancel == Cancel::StopsRunning)
    }

    /// The job as the routes print it, `nextExecutionTime` as an ISO-8601
    /// string to the second.
    fn job_json(&self, job: &Scheduled) -> Map<String, Value> {
        let next = job.next.map_or(Value::Null, |ms| {
            Value::from(crate::clock::Utc::from_unix_millis(ms - ms.rem_euclid(1000)).iso_string())
        });
        let mut out = Map::new();
        out.insert(String::from("id"), Value::from(job.def.id));
        out.insert(String::from("name"), Value::from(job.def.name));
        out.insert(String::from("type"), Value::from(job.def.kind));
        out.insert(String::from("interval"), Value::from(job.def.interval));
        out.insert(String::from("cronSchedule"), job.cron_schedule.clone());
        out.insert(String::from("nextExecutionTime"), next);
        out.insert(String::from("running"), Value::Bool(self.running(job.def)));
        out
    }

    fn job(&self, id: &str) -> Option<&Scheduled> {
        self.jobs.iter().find(|j| j.def.id == id)
    }

    /// `stopJobs()`'s share of the scheduler: no more admissions, every
    /// timer cancelled and `scheduledJobs` emptied, the queue dropped, and
    /// each active run aborted (`cancelManagedJobs`) and told to stop (its
    /// `cancelFn`).
    fn stop(&mut self) {
        self.stopped = true;
        for job in self.jobs.drain(..) {
            if let Some(timer) = job.timer {
                timer.abort();
            }
        }
        self.slots.clear_pending();
        for id in self.slots.active() {
            if let Some(run) = self.runs.get(id) {
                run.aborted.store(true, Ordering::SeqCst);
                run.ctx.cancel();
            }
        }
    }

    /// `Slots::admit`, refused outright once stopped.
    fn admit(&mut self, id: &str, weight: Weight) -> Option<bool> {
        if self.stopped {
            return None;
        }
        Some(self.slots.admit(id, weight))
    }
}

/// The schedule string node-schedule is handed (`expression + ''`).
fn spec_of(value: &Value) -> String {
    crate::media::js_string(Some(value)).into_owned()
}

/// `startJobs()`: schedule the jobs for the configured media server, once.
pub async fn start(state: Arc<AppState>) {
    let settings = match state.settings.current().await {
        Ok(settings) => settings,
        Err(e) => {
            tracing::error!(
                label = "Jobs",
                "Unable to read settings to start the jobs: {e:#}"
            );
            return;
        }
    };
    let server_jobs: &[JobDef] = match settings
        .get("/main/mediaServerType")
        .and_then(Value::as_i64)
    {
        Some(1) => &PLEX_JOBS,
        Some(2 | 3) => &JELLYFIN_JOBS,
        _ => &[],
    };
    let now = crate::clock::now_millis();
    let mut inner = inner();
    if inner.stopped || !inner.jobs.is_empty() {
        return;
    }
    for def in server_jobs.iter().chain(COMMON_JOBS.iter()) {
        let cron_schedule = settings
            .get(&format!("/jobs/{}/schedule", def.id))
            .cloned()
            .unwrap_or(Value::Null);
        let planned = plan(&spec_of(&cron_schedule), now);
        let (broken, next, timer) = if let Some((plan, first)) = planned {
            (
                false,
                Some(first),
                Some(spawn_timer(Arc::clone(&state), def, 0, plan, first)),
            )
        } else {
            tracing::error!(
                label = "Jobs",
                "Invalid schedule for {}: {cron_schedule}",
                def.id
            );
            (true, None, None)
        };
        inner.jobs.push(Scheduled {
            def,
            cron_schedule,
            broken,
            next,
            generation: 0,
            timer,
        });
    }
    drop(inner);
    tracing::info!(label = "Jobs", "Scheduled jobs loaded");
}

/// `scheduledJobs` with the schedule each was started with.
#[must_use]
pub fn scheduled() -> Vec<(&'static JobDef, String)> {
    inner()
        .jobs
        .iter()
        .map(|job| (job.def, spec_of(&job.cron_schedule)))
        .collect()
}

/// Node's boot: `startJobs()` when there is at least one user (and not in
/// the desktop runtime).
pub fn start_at_boot(state: &Arc<AppState>) {
    if !rust_jobs() || state.env.desktop_runtime {
        return;
    }
    let state = Arc::clone(state);
    tokio::spawn(async move {
        match state
            .db
            .scalar(r#"SELECT CAST(COUNT(*) AS BIGINT) FROM "user""#, &[])
            .await
        {
            Ok(n) if n > 0 => start(state).await,
            Ok(_) => {}
            Err(e) => tracing::error!(
                label = "Jobs",
                "Unable to count users to start the jobs: {e:#}"
            ),
        }
    });
}

/// Wait until a wall-clock moment, waking at least once a minute so a
/// clock change or a suspend doesn't push the run back.
async fn sleep_until(at: i64) {
    loop {
        let now = crate::clock::now_millis();
        if at <= now {
            return;
        }
        let wait = u64::try_from(at - now).unwrap_or(0).min(60_000);
        tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
    }
}

fn spawn_timer(
    state: Arc<AppState>,
    def: &'static JobDef,
    generation: u64,
    plan: Plan,
    first: i64,
) -> tokio::task::AbortHandle {
    tokio::spawn(timer(state, def, generation, plan, first)).abort_handle()
}

/// One job's timer: at each occurrence the next one is scheduled first,
/// then the job is invoked.
async fn timer(
    state: Arc<AppState>,
    def: &'static JobDef,
    generation: u64,
    mut plan: Plan,
    first: i64,
) {
    let mut at = first;
    loop {
        sleep_until(at).await;
        let following = match &mut plan {
            Plan::Cron(it) => it.next_after().ok(),
            Plan::Once => None,
        };
        if !set_next(def.id, generation, following) {
            return;
        }
        invoke(&state, def);
        match following {
            Some(next) => at = next,
            None => return,
        }
    }
}

/// Record a timer's next occurrence; false when the job was rescheduled
/// since (the timer is stale).
fn set_next(id: &str, generation: u64, next: Option<i64>) -> bool {
    let mut inner = inner();
    let Some(job) = inner.jobs.iter_mut().find(|j| j.def.id == id) else {
        return false;
    };
    if job.generation != generation {
        return false;
    }
    job.next = next;
    drop(inner);
    true
}

/// The cron callback (`job.invoke()`): log and start the managed run.
fn invoke(state: &Arc<AppState>, def: &'static JobDef) {
    if inner().stopped {
        return;
    }
    if def.id == "download-sync" {
        tracing::debug!(label = "Jobs", "Starting scheduled job: {}", def.log_name);
    } else {
        tracing::info!(label = "Jobs", "Starting scheduled job: {}", def.log_name);
    }
    if crate::runtime::desktop::defer(def) {
        return;
    }
    let state = Arc::clone(state);
    tokio::spawn(async move {
        if let Err(e) = execute_managed(state, def.id, def.weight).await {
            tracing::error!(
                label = "Jobs",
                message = %e,
                "Failed to record scheduled job: {}",
                def.log_name
            );
        }
    });
}

/// `executeManagedJob(id, weight, run)` with the registry's run: start now
/// when a slot is free (`Ok(true)` when it succeeded), otherwise queue it
/// and answer `Ok(false)`.
///
/// # Errors
///
/// The database error of a failure or cancellation record.
pub async fn execute_managed(
    state: Arc<AppState>,
    id: &str,
    weight: Weight,
) -> anyhow::Result<bool> {
    let Some(admitted) = inner().admit(id, weight) else {
        tracing::debug!(label = "Jobs", "Not starting {id}: the jobs are stopped");
        return Ok(false);
    };
    if !admitted {
        tracing::info!(
            label = "Jobs",
            weight = weight.as_str(),
            "Deferring scheduled job until a slot is free: {id}"
        );
        return Ok(false);
    }
    run_admitted(state, id.to_owned(), weight).await
}

/// A run that holds its slot: record and run it, free the slot and start
/// what was waiting for it.
async fn run_admitted(state: Arc<AppState>, id: String, weight: Weight) -> anyhow::Result<bool> {
    let result = match state.settings.current().await {
        Ok(settings) => {
            let ctx = JobCtx::new(Arc::clone(&state), settings);
            let aborted = Arc::new(AtomicBool::new(false));
            {
                let mut inner = inner();
                // Admitted before `stopJobs()` but registered after it:
                // Node's controller already existed then, so this run
                // starts aborted.
                if inner.stopped {
                    aborted.store(true, Ordering::SeqCst);
                    ctx.cancel();
                }
                inner.runs.insert(
                    id.clone(),
                    Run {
                        ctx: ctx.clone(),
                        aborted: Arc::clone(&aborted),
                    },
                );
            }
            let task_id = id.clone();
            run_recorded(
                &state.db,
                &id,
                || aborted.load(Ordering::SeqCst),
                move || async move {
                    // A panicking job fails its run instead of keeping the slot.
                    match tokio::spawn(async move { run_job(&task_id, &ctx).await }).await {
                        Ok(result) => result,
                        Err(e) => Err(anyhow::anyhow!("{e}")),
                    }
                },
            )
            .await
        }
        Err(e) => Err(e),
    };
    let started = inner().slots.release(&id, weight);
    RELEASED.notify_waiters();
    for (next, next_weight) in started {
        spawn_admitted(Arc::clone(&state), next, next_weight);
    }
    result
}

/// `stopJobs()` for the scheduler (see [`Inner::stop`]). The active runs
/// carry on until they notice; [`idle`] waits for them.
pub fn stop() {
    inner().stop();
}

/// Resolves once no run holds an executor slot.
pub async fn idle() {
    loop {
        // Registered before the check, so a release in between still wakes it.
        let released = RELEASED.notified();
        if inner().slots.active().is_empty() {
            return;
        }
        released.await;
    }
}

/// `void executeManagedJob(...)` of `drainPendingJobs`, already admitted.
fn spawn_admitted(state: Arc<AppState>, id: String, weight: Weight) {
    let run: Pin<Box<dyn Future<Output = ()> + Send>> = Box::pin(async move {
        if let Err(e) = run_admitted(state, id.clone(), weight).await {
            tracing::error!(label = "Jobs", message = %e, "Failed to record job: {id}");
        }
    });
    tokio::spawn(run);
}

/// `cancelManagedJob(id)` plus the job's own `cancel()`, as the Plex and
/// Jellyfin sync routes do: the run is recorded as cancelled.
pub fn cancel_managed(id: &str) {
    let inner = inner();
    if let Some(run) = inner.runs.get(id) {
        if inner.slots.is_active(id) {
            run.aborted.store(true, Ordering::SeqCst);
            run.ctx.cancel();
        }
    }
}

/// The status the latest run of a job reports (`status()` of Node's
/// scanners); `None` before its first run.
#[must_use]
pub fn status(id: &str) -> Option<Map<String, Value>> {
    inner().runs.get(id).map(|run| run.ctx.status())
}

/// Whether a run of the job holds an executor slot.
#[must_use]
pub fn is_active(id: &str) -> bool {
    inner().slots.is_active(id)
}

/// What a job route answers.
#[derive(Debug)]
pub enum JobAnswer {
    /// `404 Job not found.`
    NotFound,
    /// `400 Invalid job schedule.`
    Invalid,
    /// Node throws (its job is null); a 500 with this message.
    Throws(&'static str),
    /// The job.
    Job(Map<String, Value>),
}

const NULL_NEXT: &str = "nextInvocation is missing";

/// `GET /settings/jobs`: the list, or the message Node throws on a job
/// whose schedule never parsed.
///
/// # Errors
///
/// That message.
pub fn list() -> Result<Vec<Value>, &'static str> {
    let inner = inner();
    inner
        .jobs
        .iter()
        .map(|job| {
            if job.broken {
                Err(NULL_NEXT)
            } else {
                Ok(Value::Object(inner.job_json(job)))
            }
        })
        .collect()
}

/// `POST /settings/jobs/{id}/run`: `job.invoke()`.
#[must_use]
pub fn run_now(state: &Arc<AppState>, id: &str) -> JobAnswer {
    let inner = inner();
    let Some(job) = inner.job(id) else {
        return JobAnswer::NotFound;
    };
    if job.broken {
        return JobAnswer::Throws("invoke is missing");
    }
    let answer = inner.job_json(job);
    let def = job.def;
    drop(inner);
    invoke(state, def);
    JobAnswer::Job(answer)
}

/// `POST /settings/jobs/{id}/cancel`: the job's `cancelFn`, when it has
/// one (the run carries on until it checks).
#[must_use]
pub fn cancel(id: &str) -> JobAnswer {
    let inner = inner();
    let Some(job) = inner.job(id) else {
        return JobAnswer::NotFound;
    };
    if job.def.cancel != Cancel::None && inner.slots.is_active(id) {
        if let Some(run) = inner.runs.get(id) {
            run.ctx.cancel();
        }
    }
    if job.broken {
        return JobAnswer::Throws(NULL_NEXT);
    }
    JobAnswer::Job(inner.job_json(job))
}

/// `rescheduleJob(job, spec)` of `POST /settings/jobs/{id}/schedule`.
///
/// The route writes settings.json when the job comes back. As in node-schedule,
/// the old timer is dropped before the new spec is tried, so a rejected
/// spec leaves the job showing its old next run without firing it.
#[must_use]
pub fn reschedule(state: &Arc<AppState>, id: &str, spec: Option<&str>) -> JobAnswer {
    let now = crate::clock::now_millis();
    let mut inner = inner();
    let Some(job) = inner.jobs.iter_mut().find(|j| j.def.id == id) else {
        return JobAnswer::NotFound;
    };
    if job.broken {
        return JobAnswer::Invalid;
    }
    job.generation += 1;
    if let Some(timer) = job.timer.take() {
        timer.abort();
    }
    let Some((plan, first)) = spec.and_then(|spec| plan(spec, now)) else {
        return JobAnswer::Invalid;
    };
    job.next = Some(first);
    job.cron_schedule = Value::from(spec.unwrap_or_default());
    job.timer = Some(spawn_timer(
        Arc::clone(state),
        job.def,
        job.generation,
        plan,
        first,
    ));
    let Some(job) = inner.job(id) else {
        return JobAnswer::NotFound;
    };
    JobAnswer::Job(inner.job_json(job))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_table() {
        let count = PLEX_JOBS
            .iter()
            .chain(JELLYFIN_JOBS.iter())
            .chain(COMMON_JOBS.iter())
            .count();
        assert_eq!(count, 16, "every JobId");
        assert_eq!(
            definition("jellyfin-full-scan").map(|d| (d.name, d.log_name)),
            Some(("Jellyfin Full Library Scan", "Jellyfin Full Scan")),
            "the Jellyfin full scan logs another name"
        );
        assert_eq!(
            definition("download-sync").map(|d| (d.kind, d.interval)),
            Some(("command", "seconds")),
            "commands"
        );
        assert!(definition("nope").is_none(), "unknown");
    }

    #[test]
    fn plans() {
        let now = crate::clock::parse_date_millis("2026-10-11T12:00:00Z").unwrap_or_default();
        assert!(
            matches!(plan("0 */5 * * * *", now), Some((Plan::Cron(_), _))),
            "cron"
        );
        assert!(
            matches!(plan("2030-01-01", now), Some((Plan::Once, _))),
            "a date"
        );
        assert!(plan("2020-01-01", now).is_none(), "a past date");
        assert!(plan("garbage", now).is_none(), "garbage");
        assert!(
            plan("0 0 0 * * L", now).is_none(),
            "a cron that never matches"
        );
    }

    #[test]
    fn next_execution_is_an_iso_string() {
        let Some(def) = definition("download-sync") else {
            return;
        };
        let next = crate::clock::parse_date_millis("2026-10-12T03:00:00.250Z");
        let job = Scheduled {
            def,
            cron_schedule: Value::from("0 * * * * *"),
            broken: false,
            next,
            generation: 0,
            timer: None,
        };
        let inner = Inner::default();
        assert_eq!(
            inner.job_json(&job).get("nextExecutionTime"),
            Some(&Value::from("2026-10-12T03:00:00.000Z")),
            "to the second"
        );
        let job = Scheduled { next: None, ..job };
        assert_eq!(
            inner.job_json(&job).get("nextExecutionTime"),
            Some(&Value::Null),
            "not scheduled"
        );
    }

    #[tokio::test]
    async fn nothing_starts_after_stop() {
        let Some(def) = definition("download-sync-reset") else {
            return;
        };
        let timer = tokio::spawn(std::future::pending::<()>());
        let mut inner = Inner::default();
        inner.jobs.push(Scheduled {
            def,
            cron_schedule: Value::from("* * * * * *"),
            broken: false,
            next: None,
            generation: 0,
            timer: Some(timer.abort_handle()),
        });
        assert_eq!(
            inner.admit("radarr-scan", Weight::Heavy),
            Some(true),
            "runs"
        );
        assert_eq!(
            inner.admit("sonarr-scan", Weight::Heavy),
            Some(false),
            "queued"
        );
        inner.stop();
        assert!(
            timer.await.is_err_and(|e| e.is_cancelled()),
            "timer aborted"
        );
        assert!(inner.jobs.is_empty(), "scheduledJobs emptied");
        assert!(
            inner.slots.release("radarr-scan", Weight::Heavy).is_empty(),
            "the queued run was dropped"
        );
        assert_eq!(
            inner.admit("download-sync", Weight::Light),
            None,
            "no admission"
        );
    }
}
