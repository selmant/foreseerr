//! Background work Node runs on its scheduler (`server/job/schedule.ts`):
//! scanners, syncs and maintenance. Each job is a module with
//!
//! ```ignore
//! pub async fn run(job: &JobCtx) -> anyhow::Result<()>
//! ```
//!
//! that checks `job.cancelled()` between units of work and reports what a
//! status endpoint shows through `job.progress()`. The scheduler that fires
//! them on their cron schedules (and records `job_execution_state`) is
//! separate, so a job can also be run by hand from a settings route.

pub mod arrscan;
pub mod availability_sync;
pub mod blocklisted_tags;
pub mod catchup;
pub mod cron;
pub mod downloadtracker;
pub mod episode_request_sync;
pub mod execution;
pub mod image_cache_cleanup;
pub mod jellyfinscan;
pub mod mapping_refresh;
pub mod plexscan;
pub mod refreshtoken;
pub mod release_calendar;
pub mod release_store;
pub mod scanbase;
pub mod scanmedia;
pub mod scantmdb;
pub mod scheduler;
pub mod syncutil;
pub mod watchlist_sync;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value;

use crate::settings::Settings;
use crate::state::AppState;

/// What a running scanner reports (`status()` in Node's scanners):
/// `running`, `progress`, `total`, `currentLibrary`, `libraries`, …,
/// kept as the JSON object Node's status endpoint would print.
#[derive(Debug, Default)]
pub struct Progress {
    /// The status object.
    pub status: serde_json::Map<String, Value>,
}

/// One run of a job.
#[derive(Debug, Clone)]
pub struct JobCtx {
    /// Database and clients.
    pub state: Arc<AppState>,
    /// The settings when the run started (jobs re-read them where Node
    /// calls `getSettings()` mid-run).
    pub settings: Arc<Settings>,
    cancel: Arc<AtomicBool>,
    progress: Arc<Mutex<Progress>>,
}

impl JobCtx {
    /// A fresh run.
    #[must_use]
    pub fn new(state: Arc<AppState>, settings: Arc<Settings>) -> Self {
        Self {
            state,
            settings,
            cancel: Arc::new(AtomicBool::new(false)),
            progress: Arc::new(Mutex::new(Progress::default())),
        }
    }

    /// Ask the run to stop at its next check.
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    /// Whether `cancel` was called.
    #[must_use]
    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// Change the reported status.
    pub fn progress(&self, update: impl FnOnce(&mut Progress)) {
        update(&mut crate::sync::lock(&self.progress));
    }

    /// The reported status.
    #[must_use]
    pub fn status(&self) -> serde_json::Map<String, Value> {
        crate::sync::lock(&self.progress).status.clone()
    }

    /// The settings as they are now.
    ///
    /// # Errors
    ///
    /// Fails when settings.json can't be read.
    pub async fn current_settings(&self) -> anyhow::Result<Arc<Settings>> {
        self.state.settings.current().await
    }
}

/// A job's static `running` flag, set by the caller and cleared when this
/// drops: Node's `finally { this.running = false }`, so a run that panics
/// doesn't leave the job looking busy. Reports `running` in the status
/// while it lives.
pub(crate) struct Running<'a> {
    flag: &'static AtomicBool,
    job: &'a JobCtx,
}

impl<'a> Running<'a> {
    /// The run has set `flag`.
    pub(crate) fn new(flag: &'static AtomicBool, job: &'a JobCtx) -> Self {
        job.progress(|p| {
            p.status.insert(String::from("running"), Value::Bool(true));
        });
        Self { flag, job }
    }
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::SeqCst);
        self.job.progress(|p| {
            p.status.insert(String::from("running"), Value::Bool(false));
        });
    }
}
