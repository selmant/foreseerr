//! `server/job/execution.ts`: the managed job executor.
//!
//! Every scheduled or manual run goes through one path that admits at most one heavy and two light jobs at a time,
//! never runs a job id twice at once (a second request waits, coalesced, for
//! a free slot) and records each run in `job_execution_state`.

use std::future::Future;

use crate::clock::Utc;
use crate::db::{Bind, Db};

/// `ManagedJobWeight`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Weight {
    /// Library scans and other long database work; one at a time.
    Heavy,
    /// Everything else; two at a time.
    Light,
}

impl Weight {
    /// The name Node logs.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Heavy => "heavy",
            Self::Light => "light",
        }
    }
}

/// The executor's slots: `activeJobs`, the heavy and light counters and
/// `pendingJobs` (insertion-ordered, one entry per id).
#[derive(Debug, Default)]
pub struct Slots {
    active: Vec<String>,
    heavy: u32,
    light: u32,
    pending: Vec<(String, Weight)>,
}

impl Slots {
    /// `canAdmit(id, weight)`.
    fn can_admit(&self, id: &str, weight: Weight) -> bool {
        if self.active.iter().any(|a| a == id) {
            return false;
        }
        match weight {
            Weight::Heavy => self.heavy < 1,
            Weight::Light => self.light < 2,
        }
    }

    fn take(&mut self, id: &str, weight: Weight) {
        self.active.push(id.to_owned());
        match weight {
            Weight::Heavy => self.heavy += 1,
            Weight::Light => self.light += 1,
        }
    }

    /// The start of `executeManagedJob`: take a slot, or queue the id
    /// (replacing an earlier queued request for it) and say no.
    pub fn admit(&mut self, id: &str, weight: Weight) -> bool {
        if self.can_admit(id, weight) {
            self.take(id, weight);
            return true;
        }
        if let Some(entry) = self.pending.iter_mut().find(|(p, _)| p == id) {
            entry.1 = weight;
        } else {
            self.pending.push((id.to_owned(), weight));
        }
        false
    }

    /// The `finally` of `executeManagedJob`: free the slot, then
    /// `drainPendingJobs`: every queued id that fits now is admitted, in
    /// queue order. The caller starts them.
    pub fn release(&mut self, id: &str, weight: Weight) -> Vec<(String, Weight)> {
        if let Some(i) = self.active.iter().position(|a| a == id) {
            self.active.remove(i);
        }
        match weight {
            Weight::Heavy => self.heavy = self.heavy.saturating_sub(1),
            Weight::Light => self.light = self.light.saturating_sub(1),
        }
        let mut started = Vec::new();
        let queued = std::mem::take(&mut self.pending);
        for (pending, w) in queued {
            if self.can_admit(&pending, w) {
                self.take(&pending, w);
                started.push((pending, w));
            } else {
                self.pending.push((pending, w));
            }
        }
        started
    }

    /// Whether a run of `id` holds a slot.
    #[must_use]
    pub fn is_active(&self, id: &str) -> bool {
        self.active.iter().any(|a| a == id)
    }

    /// The ids holding a slot.
    #[must_use]
    pub fn active(&self) -> &[String] {
        &self.active
    }

    /// Drop every queued request; a freed slot then starts nothing.
    pub fn clear_pending(&mut self) {
        self.pending.clear();
    }
}

/// `summarizeFailure`: the message with credentials redacted
/// (`/(?:token|authorization|cookie|password)=?[^\s,;]+/gi`), cut to 512
/// UTF-16 units.
#[must_use]
pub fn summarize_failure(message: &str) -> String {
    const KEYWORDS: [&str; 4] = ["token", "authorization", "cookie", "password"];
    let stop = |c: char| c.is_whitespace() || c == ',' || c == ';';
    let mut out = String::with_capacity(message.len());
    let mut rest = message;
    'scan: while !rest.is_empty() {
        for keyword in KEYWORDS {
            let Some(head) = rest.get(..keyword.len()) else {
                continue;
            };
            if !head.eq_ignore_ascii_case(keyword) {
                continue;
            }
            let after = rest.get(keyword.len()..).unwrap_or_default();
            let run = after.find(stop).unwrap_or(after.len());
            if run > 0 {
                out.push_str("[redacted]");
                rest = after.get(run..).unwrap_or_default();
                continue 'scan;
            }
        }
        let mut chars = rest.chars();
        if let Some(c) = chars.next() {
            out.push(c);
        }
        rest = chars.as_str();
    }
    js_slice(&out, 512)
}

/// `text.slice(0, n)` in UTF-16 code units.
#[must_use]
pub fn js_slice(text: &str, n: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in text.chars() {
        units += c.len_utf16();
        if units > n {
            break;
        }
        out.push(c);
    }
    out
}

/// A `Date` parameter of the `timestamp` columns of
/// `job_execution_state` (local wall-clock time on Postgres, see
/// `naivetime`).
fn date_param(db: &Db, n: usize) -> String {
    crate::naivetime::param(db, n)
}

fn date_bind(db: &Db, at: &Utc) -> Bind {
    let millis = crate::clock::parse_date_millis(&at.iso_string()).unwrap_or_default();
    crate::naivetime::bind(db, millis)
}

/// The `JobExecutionState` row of the run, as far as this run needs it.
#[derive(Debug)]
struct Record {
    job_id: String,
    consecutive_failures: i64,
}

/// `findOne({ where: { jobId } }) ?? new JobExecutionState({ jobId })`,
/// then `lastStartedAt = new Date()` and `save()`.
async fn record_start(db: &Db, id: &str) -> anyhow::Result<Record> {
    let rows = db
        .rows(
            r#"SELECT CAST("consecutiveFailures" AS BIGINT) AS "consecutiveFailures" FROM "job_execution_state" WHERE "jobId" = ?1"#,
            &[Bind::Text(id.to_owned())],
        )
        .await?;
    let now = Utc::now();
    let existing = rows.first().map(|row| {
        row.get("consecutiveFailures")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0)
    });
    if let Some(consecutive_failures) = existing {
        db.execute(
            &format!(
                r#"UPDATE "job_execution_state" SET "lastStartedAt" = {} WHERE "jobId" = ?2"#,
                date_param(db, 1)
            ),
            &[date_bind(db, &now), Bind::Text(id.to_owned())],
        )
        .await?;
        return Ok(Record {
            job_id: id.to_owned(),
            consecutive_failures,
        });
    }
    db.execute(
        &format!(
            r#"INSERT INTO "job_execution_state" ("jobId", "lastStartedAt") VALUES (?1, {})"#,
            date_param(db, 2)
        ),
        &[Bind::Text(id.to_owned()), date_bind(db, &now)],
    )
    .await?;
    Ok(Record {
        job_id: id.to_owned(),
        consecutive_failures: 0,
    })
}

async fn record_cancelled(db: &Db, record: &Record) -> anyhow::Result<()> {
    db.execute(
        &format!(
            r#"UPDATE "job_execution_state" SET "lastCancelledAt" = {} WHERE "jobId" = ?2"#,
            date_param(db, 1)
        ),
        &[
            date_bind(db, &Utc::now()),
            Bind::Text(record.job_id.clone()),
        ],
    )
    .await?;
    Ok(())
}

async fn record_success(db: &Db, record: &Record) -> anyhow::Result<()> {
    db.execute(
        &format!(
            r#"UPDATE "job_execution_state" SET "lastSucceededAt" = {}, "consecutiveFailures" = 0, "lastFailureSummary" = NULL WHERE "jobId" = ?2"#,
            date_param(db, 1)
        ),
        &[date_bind(db, &Utc::now()), Bind::Text(record.job_id.clone())],
    )
    .await?;
    Ok(())
}

async fn record_failure(db: &Db, record: &mut Record, summary: &str) -> anyhow::Result<()> {
    record.consecutive_failures += 1;
    db.execute(
        &format!(
            r#"UPDATE "job_execution_state" SET "lastFailedAt" = {}, "lastFailureSummary" = ?2, "consecutiveFailures" = ?3 WHERE "jobId" = ?4"#,
            date_param(db, 1)
        ),
        &[
            date_bind(db, &Utc::now()),
            Bind::Text(summary.to_owned()),
            Bind::Int(record.consecutive_failures),
            Bind::Text(record.job_id.clone()),
        ],
    )
    .await?;
    Ok(())
}

/// The `catch` of `executeManagedJob`.
async fn failed(
    db: &Db,
    id: &str,
    record: Option<Record>,
    aborted: bool,
    error: &anyhow::Error,
) -> anyhow::Result<bool> {
    let summary = summarize_failure(&error.to_string());
    if let Some(mut record) = record {
        if aborted {
            record_cancelled(db, &record).await?;
            return Ok(false);
        }
        record_failure(db, &mut record, &summary).await?;
    }
    tracing::error!(label = "Jobs", message = %summary, "Managed job failed: {id}");
    Ok(false)
}

/// The admitted part of `executeManagedJob`: record the start, run, record
/// how it ended. `Ok(true)` when it succeeded; `Err` when recording a
/// failure failed (Node's promise rejects then).
///
/// # Errors
///
/// The database error of the failure or cancellation record.
pub async fn run_recorded<F>(
    db: &Db,
    id: &str,
    aborted: impl Fn() -> bool + Send,
    work: impl FnOnce() -> F + Send,
) -> anyhow::Result<bool>
where
    F: Future<Output = anyhow::Result<()>> + Send,
{
    let mut record = match record_start(db, id).await {
        Ok(record) => record,
        Err(e) => return failed(db, id, None, aborted(), &e).await,
    };
    if let Err(e) = work().await {
        return failed(db, id, Some(record), aborted(), &e).await;
    }
    if aborted() {
        if let Err(e) = record_cancelled(db, &record).await {
            return failed(db, id, Some(record), aborted(), &e).await;
        }
        return Ok(false);
    }
    if let Err(e) = record_success(db, &record).await {
        record.consecutive_failures = 0;
        return failed(db, id, Some(record), aborted(), &e).await;
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defers_a_third_light_job_until_a_slot_frees() {
        let mut slots = Slots::default();
        assert!(slots.admit("light-a", Weight::Light), "first");
        assert!(slots.admit("light-b", Weight::Light), "second");
        assert!(!slots.admit("light-c", Weight::Light), "third waits");
        assert!(
            slots.admit("heavy-a", Weight::Heavy),
            "heavy has its own slot"
        );
        assert!(
            !slots.admit("heavy-b", Weight::Heavy),
            "one heavy at a time"
        );
        assert_eq!(
            slots.release("light-a", Weight::Light),
            vec![(String::from("light-c"), Weight::Light)],
            "the deferred light job starts"
        );
        assert!(
            slots.release("light-b", Weight::Light).is_empty(),
            "nothing left for light"
        );
        assert_eq!(
            slots.release("heavy-a", Weight::Heavy),
            vec![(String::from("heavy-b"), Weight::Heavy)],
            "the deferred heavy job starts"
        );
    }

    #[test]
    fn coalesces_a_second_run_of_the_same_job() {
        let mut slots = Slots::default();
        assert!(slots.admit("same-id", Weight::Light), "first");
        assert!(!slots.admit("same-id", Weight::Light), "overlapping waits");
        assert!(!slots.admit("same-id", Weight::Light), "and coalesces");
        assert!(slots.is_active("same-id"), "running");
        assert_eq!(
            slots.release("same-id", Weight::Light),
            vec![(String::from("same-id"), Weight::Light)],
            "runs once more"
        );
        assert!(
            slots.release("same-id", Weight::Light).is_empty(),
            "only once"
        );
        assert!(!slots.is_active("same-id"), "done");
    }

    #[test]
    fn redacts_failures() {
        assert_eq!(
            summarize_failure("GET /x?X-Plex-Token=abc123 failed; password hunter2, token= x"),
            "GET /x?X-Plex-[redacted] failed; password hunter2, [redacted] x",
            "credentials"
        );
        assert_eq!(
            summarize_failure("Authorization:Bearer"),
            "[redacted]",
            "case-insensitive"
        );
        assert_eq!(
            summarize_failure(&"é".repeat(600)).chars().count(),
            512,
            "512 units"
        );
    }
}
