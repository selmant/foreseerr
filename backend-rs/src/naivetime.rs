//! Postgres `timestamp` (without time zone) columns.
//!
//! These are `TypeORM`'s `@Column({ type: 'timestamp' })` and
//! `@DeleteDateColumn()`, i.e.
//! `job_execution_state.last*At`, `simkl_sync_state.last*At`,
//! `simkl_sync_item.addedAt`/`lastWatchedAt` and `session.destroyedAt`.
//!
//! node-postgres sends a `Date` as the process's local time with its
//! offset (`2026-10-11T22:37:00.016+03:00`); a `timestamp` column drops
//! the offset and keeps the local wall-clock time. Reading one back,
//! node-postgres builds the `Date` from the wall-clock fields in local
//! time again. So the column holds local time and the round trip is
//! exact, as long as the process's time zone doesn't change. `SQLite`
//! stores `TypeORM`'s UTC text either way, so nothing changes there.

use chrono::{DateTime, Local, NaiveDateTime, TimeZone};

use crate::clock::Utc;
use crate::db::{Bind, Db};

/// The SQL for a bound date parameter of such a column (`?n`).
#[must_use]
pub fn param(db: &Db, n: usize) -> String {
    if db.is_postgres() {
        format!("CAST(?{n} AS timestamp)")
    } else {
        format!("?{n}")
    }
}

/// The bound value for [`param`]: a moment in Unix milliseconds.
#[must_use]
pub fn bind(db: &Db, millis: i64) -> Bind {
    if db.is_postgres() {
        Bind::Text(local_wall(millis))
    } else {
        Bind::Text(Utc::from_unix_millis(millis).typeorm_string())
    }
}

/// SQL reading such a column: `TypeORM`'s ISO text on `SQLite`, the
/// stored wall-clock time (`YYYY-MM-DDTHH:MM:SS.mmm`) on Postgres, which
/// [`read`] turns into the moment it stands for.
#[must_use]
pub fn select(db: &Db, expr: &str) -> String {
    if db.is_postgres() {
        format!(r#"to_char({expr}, 'YYYY-MM-DD"T"HH24:MI:SS.MS')"#)
    } else {
        db.iso_sql(expr)
    }
}

/// A value read with [`select`] as `Date.toJSON()` prints it.
#[must_use]
pub fn read(db: &Db, text: &str) -> Option<String> {
    if db.is_postgres() {
        from_local_wall(text).map(|ms| Utc::from_unix_millis(ms).iso_string())
    } else {
        Some(text.to_owned())
    }
}

/// A value read with [`select`] in Unix milliseconds.
#[must_use]
pub fn read_millis(db: &Db, text: &str) -> Option<i64> {
    if db.is_postgres() {
        from_local_wall(text)
    } else {
        crate::clock::parse_date_millis(text)
    }
}

/// node-postgres's `dateToString` without the offset: the local
/// wall-clock time of the moment.
fn local_wall(millis: i64) -> String {
    DateTime::from_timestamp_millis(millis).map_or_else(
        || Utc::from_unix_millis(millis).typeorm_string(),
        |at| {
            at.with_timezone(&Local)
                .naive_local()
                .format("%Y-%m-%d %H:%M:%S%.3f")
                .to_string()
        },
    )
}

/// `new Date(year, month, day, hour, minute, second, ms)` on the stored
/// fields: an ambiguous time (clocks going back) is the earlier moment, a
/// skipped one (clocks going forward) is read with the offset in force
/// before the change, as `ECMAScript`'s `UTC(t)` does.
fn from_local_wall(text: &str) -> Option<i64> {
    let naive = NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.3f").ok()?;
    let resolved = Local.from_local_datetime(&naive);
    if let Some(at) = resolved.earliest() {
        return Some(at.timestamp_millis());
    }
    let before = naive.checked_sub_signed(chrono::TimeDelta::days(1))?;
    let offset = Local.offset_from_utc_datetime(&before);
    Some((naive - offset).and_utc().timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_wall_round_trips() {
        let ms = 1_791_747_420_016;
        let wall = local_wall(ms).replacen(' ', "T", 1);
        assert_eq!(from_local_wall(&wall), Some(ms));
    }

    #[test]
    fn rejects_other_shapes() {
        assert_eq!(from_local_wall("2026-10-11"), None);
        assert_eq!(from_local_wall("x"), None);
    }
}
