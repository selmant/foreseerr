//! `server/job/catchup.ts`: missed cron occurrences.
//!
//! Whether a cron schedule was missed while the process was not running. Node uses it for the desktop runtime's launch
//! catch-up, which is not ported; the decision itself is here for when it is.

use super::cron::{CronExpr, CronIter};
use super::execution::Weight;

/// `CatchUpState`: the last success and failure (Unix milliseconds).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CatchUpState {
    /// `lastSucceededAt`.
    pub last_succeeded_at: Option<i64>,
    /// `lastFailedAt`.
    pub last_failed_at: Option<i64>,
}

/// `hasMissedOccurrence`: one or more occurrences fell between the last
/// success and `now` (they coalesce), in the local time zone.
#[must_use]
pub fn has_missed_occurrence(schedule: &str, last_succeeded_at: Option<i64>, now: i64) -> bool {
    has_missed_in(schedule, last_succeeded_at, now, &chrono::Local)
}

fn has_missed_in<Tz: chrono::TimeZone>(
    schedule: &str,
    last_succeeded_at: Option<i64>,
    now: i64,
    tz: &Tz,
) -> bool {
    let Some(last) = last_succeeded_at else {
        return false;
    };
    if last >= now {
        return false;
    }
    CronExpr::parse(schedule).is_ok_and(|expr| {
        CronIter::new(expr, tz.clone(), last, Some(now))
            .next_after()
            .is_ok()
    })
}

/// `canRunLaunchCatchUp`: missed, and not inside the failure back-off
/// (six hours for heavy jobs, thirty minutes for light ones).
#[must_use]
pub fn can_run_launch_catch_up(
    schedule: &str,
    weight: Weight,
    state: CatchUpState,
    now: i64,
) -> bool {
    if !has_missed_occurrence(schedule, state.last_succeeded_at, now) {
        return false;
    }
    let Some(failed) = state.last_failed_at else {
        return true;
    };
    let delay = match weight {
        Weight::Heavy => 6 * 60 * 60_000,
        Weight::Light => 30 * 60_000,
    };
    now - failed >= delay
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(iso: &str) -> i64 {
        crate::clock::parse_date_millis(iso).unwrap_or_default()
    }

    fn state(succeeded: &str, failed: &str) -> CatchUpState {
        CatchUpState {
            last_succeeded_at: Some(ms(succeeded)),
            last_failed_at: Some(ms(failed)),
        }
    }

    #[test]
    fn coalesces_missed_occurrences() {
        let now = ms("2026-08-22T12:00:00Z");
        assert!(
            has_missed_occurrence("* * * * *", Some(ms("2026-08-22T11:00:00Z")), now),
            "an hour of minutes"
        );
    }

    #[test]
    fn failure_backoff() {
        let now = ms("2026-08-22T12:00:00Z");
        assert!(
            !can_run_launch_catch_up(
                "* * * * *",
                Weight::Light,
                state("2026-08-22T10:00:00Z", "2026-08-22T11:45:00Z"),
                now
            ),
            "light, 15 minutes after a failure"
        );
        assert!(
            can_run_launch_catch_up(
                "* * * * *",
                Weight::Light,
                state("2026-08-22T10:00:00Z", "2026-08-22T11:30:00Z"),
                now
            ),
            "light, 30 minutes after a failure"
        );
        assert!(
            !can_run_launch_catch_up(
                "* * * * *",
                Weight::Heavy,
                state("2026-08-22T01:00:00Z", "2026-08-22T07:00:00Z"),
                now
            ),
            "heavy, 5 hours after a failure"
        );
        assert!(
            can_run_launch_catch_up(
                "* * * * *",
                Weight::Heavy,
                state("2026-08-22T01:00:00Z", "2026-08-22T06:00:00Z"),
                now
            ),
            "heavy, 6 hours after a failure"
        );
    }

    #[test]
    fn needs_a_successful_baseline() {
        let now = ms("2026-08-22T12:00:00Z");
        assert!(!has_missed_occurrence("* * * * *", None, now), "never ran");
        assert!(
            !has_missed_occurrence("* * * * *", Some(now), now),
            "ran just now"
        );
        assert!(
            !has_missed_occurrence("not a cron", Some(ms("2026-08-22T11:00:00Z")), now),
            "not a cron"
        );
        assert!(
            !has_missed_in(
                "0 0 3 * * *",
                Some(ms("2026-08-22T03:00:00Z")),
                ms("2026-08-23T02:59:59Z"),
                &chrono::Utc
            ),
            "the next run isn't due yet"
        );
    }
}
