//! Small pieces the sync jobs share: database transactions, dates as
//! `TypeORM` writes them, and HTTP failures as axios reports them.

use anyhow::{Context, Result};
use serde_json::{Map, Value};
use sqlx::AssertSqlSafe;

use crate::clock::Utc;
use crate::db::{bind_value, pg_json_row, pg_placeholders, sqlite_json_row, Bind, Db};

/// `dataSource.transaction(...)`: one connection, committed by
/// [`Tx::commit`], rolled back when dropped.
pub enum Tx {
    /// `SQLite`, begun `IMMEDIATE` so a read-then-write never fails on a
    /// stale snapshot.
    Sqlite(sqlx::Transaction<'static, sqlx::Sqlite>),
    /// Postgres.
    Postgres(sqlx::Transaction<'static, sqlx::Postgres>),
}

impl std::fmt::Debug for Tx {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(if self.is_postgres() {
            "Tx(Postgres)"
        } else {
            "Tx(Sqlite)"
        })
    }
}

impl Tx {
    /// Begin a transaction.
    ///
    /// # Errors
    ///
    /// Fails when no connection can be had.
    pub async fn begin(db: &Db) -> Result<Self> {
        Ok(match db {
            Db::Sqlite(pool) => Self::Sqlite(pool.begin_with("BEGIN IMMEDIATE").await?),
            Db::Postgres(pool) => Self::Postgres(pool.begin().await?),
        })
    }

    /// Whether this is Postgres.
    #[must_use]
    pub const fn is_postgres(&self) -> bool {
        matches!(self, Self::Postgres(_))
    }

    /// A statement with `?N` placeholders; the rows it touched.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn execute(&mut self, sql: &str, binds: &[Bind]) -> Result<u64> {
        match self {
            Self::Sqlite(tx) => {
                let mut q = sqlx::query(AssertSqlSafe(sql.to_owned()));
                for b in binds {
                    q = bind_value(q, b);
                }
                Ok(q.execute(&mut **tx).await?.rows_affected())
            }
            Self::Postgres(tx) => {
                let mut q = sqlx::query(AssertSqlSafe(pg_placeholders(sql)));
                for b in binds {
                    q = bind_value(q, b);
                }
                Ok(q.execute(&mut **tx).await?.rows_affected())
            }
        }
    }

    /// Rows as JSON objects, like [`Db::rows`].
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn rows(&mut self, sql: &str, binds: &[Bind]) -> Result<Vec<Map<String, Value>>> {
        match self {
            Self::Sqlite(tx) => {
                let mut q = sqlx::query(AssertSqlSafe(sql.to_owned()));
                for b in binds {
                    q = bind_value(q, b);
                }
                q.fetch_all(&mut **tx)
                    .await?
                    .iter()
                    .map(sqlite_json_row)
                    .collect()
            }
            Self::Postgres(tx) => {
                let mut q = sqlx::query(AssertSqlSafe(pg_placeholders(sql)));
                for b in binds {
                    q = bind_value(q, b);
                }
                q.fetch_all(&mut **tx)
                    .await?
                    .iter()
                    .map(pg_json_row)
                    .collect()
            }
        }
    }

    /// The `id` an `INSERT … RETURNING CAST("id" AS BIGINT) AS "id"` gives.
    ///
    /// # Errors
    ///
    /// Fails on database errors or when no id comes back.
    pub async fn insert_id(&mut self, sql: &str, binds: &[Bind]) -> Result<i64> {
        self.rows(sql, binds)
            .await?
            .first()
            .and_then(|r| int(r, "id"))
            .context("the insert returned no id")
    }

    /// Commit.
    ///
    /// # Errors
    ///
    /// Fails when the commit does.
    pub async fn commit(self) -> Result<()> {
        match self {
            Self::Sqlite(tx) => tx.commit().await?,
            Self::Postgres(tx) => tx.commit().await?,
        }
        Ok(())
    }
}

/// `settings.save()` from a job: write settings.json the way the settings
/// routes do and tell Node to reload it.
///
/// # Errors
///
/// Fails when settings.json can't be written.
pub async fn save_settings(state: &crate::state::AppState, data: &Value) -> Result<()> {
    state.settings.save(data).await?;
    if crate::standalone::enabled() {
        return Ok(());
    }
    let api_key = state.settings.current().await?.api_key().to_owned();
    let url = format!(
        "{}/internal/settings/reload",
        state.env.node_url.trim_end_matches('/')
    );
    match state
        .internal
        .post(url)
        .header("X-API-Key", api_key)
        .send()
        .await
    {
        Ok(res) if res.status().is_success() => {}
        Ok(res) => tracing::warn!("Node refused to reload settings: {}", res.status()),
        Err(e) => tracing::warn!("Node could not be told to reload settings: {e:#}"),
    }
    Ok(())
}

/// `Number(text)` printed back as JavaScript prints it (`NaN` included),
/// for ids that end up in a URL.
#[must_use]
pub fn js_number_text(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::from("0");
    }
    match trimmed.parse::<f64>() {
        Ok(n)
            if n.is_finite()
                && trimmed.bytes().all(|b| {
                    b.is_ascii_digit()
                        || b == b'.'
                        || b == b'-'
                        || b == b'+'
                        || b == b'e'
                        || b == b'E'
                }) =>
        {
            if n.fract() == 0.0 && n.abs() < 1e21 {
                format!("{n:.0}")
            } else {
                format!("{n}")
            }
        }
        Ok(n) if n.is_infinite() && trimmed.trim_start_matches(['+', '-']) == "Infinity" => {
            String::from(if n < 0.0 { "-Infinity" } else { "Infinity" })
        }
        _ => String::from("NaN"),
    }
}

/// Milliseconds since the epoch, now.
#[must_use]
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// `Date.toISOString()`.
#[must_use]
pub fn iso(ms: i64) -> String {
    Utc::from_unix_millis(ms).iso_string()
}

/// A placeholder for a date parameter: `SQLite` compares `TypeORM`'s
/// `YYYY-MM-DD HH:MM:SS.SSS` text, Postgres reads a `timestamptz`.
#[must_use]
pub fn date_ph(postgres: bool, n: usize) -> String {
    if postgres {
        format!("CAST(?{n} AS TIMESTAMPTZ)")
    } else {
        format!("?{n}")
    }
}

/// A date parameter as `TypeORM` binds a `Date` (see [`date_ph`]).
#[must_use]
pub fn date_bind(postgres: bool, ms: i64) -> Bind {
    let at = Utc::from_unix_millis(ms);
    Bind::Text(if postgres {
        at.iso_string()
    } else {
        at.typeorm_string()
    })
}

/// An optional date parameter.
#[must_use]
pub fn opt_date_bind(postgres: bool, ms: Option<i64>) -> Bind {
    ms.map_or(Bind::OptText(None), |ms| date_bind(postgres, ms))
}

/// A column read as an integer (`SQLite` booleans and Postgres int4
/// included).
#[must_use]
pub fn int(row: &Map<String, Value>, key: &str) -> Option<i64> {
    match row.get(key)? {
        Value::Number(n) => n.as_i64().or_else(|| {
            n.as_f64()
                .filter(|f| f.fract() == 0.0)
                .map(|f| format!("{f:.0}").parse().unwrap_or(0))
        }),
        Value::Bool(b) => Some(i64::from(*b)),
        Value::String(s) => s.parse().ok(),
        Value::Null | Value::Array(_) | Value::Object(_) => None,
    }
}

/// A column read as a boolean.
#[must_use]
pub fn boolean(row: &Map<String, Value>, key: &str) -> bool {
    match row.get(key) {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_i64().is_some_and(|n| n != 0),
        _ => false,
    }
}

/// A text column.
#[must_use]
pub fn text(row: &Map<String, Value>, key: &str) -> Option<String> {
    row.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// A date column selected through `Db::iso_sql`, as epoch milliseconds.
#[must_use]
pub fn date(row: &Map<String, Value>, key: &str) -> Option<i64> {
    row.get(key)
        .and_then(Value::as_str)
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis())
}

/// The HTTP status of a failed call, when there was a response.
#[must_use]
pub fn http_status(err: &anyhow::Error) -> Option<u16> {
    err.chain()
        .find_map(|e| e.downcast_ref::<reqwest::Error>())
        .and_then(reqwest::Error::status)
        .map(|s| s.as_u16())
}

/// The message for a failed call.
#[must_use]
pub fn axios_message(err: &anyhow::Error) -> String {
    crate::outbound::failure_in(err).unwrap_or_else(|| format!("{err:#}"))
}

/// `new Date(value)` for the ISO strings the *arr APIs send.
///
/// A date alone is UTC midnight, a date-time without an offset is local
/// time. `None` where JavaScript gets an invalid date (other formats
/// included).
#[must_use]
pub fn parse_js_date(value: &str) -> Option<i64> {
    use chrono::{NaiveDate, NaiveDateTime, TimeZone};
    if let Ok(d) = chrono::DateTime::parse_from_rfc3339(value) {
        return Some(d.timestamp_millis());
    }
    if value.len() == 10 {
        let day = NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()?;
        return Some(day.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis());
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M"] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(value, format) {
            return chrono::Local
                .from_local_datetime(&naive)
                .earliest()
                .map(|d| d.timestamp_millis());
        }
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f%:z", "%Y-%m-%dT%H:%M%:z"] {
        if let Ok(d) = chrono::DateTime::parse_from_str(value, format) {
            return Some(d.timestamp_millis());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_dates() {
        assert_eq!(
            parse_js_date("2026-10-11").map(iso),
            Some(String::from("2026-10-11T00:00:00.000Z")),
            "a date alone is UTC"
        );
        assert_eq!(
            parse_js_date("2026-10-11T01:30:00Z").map(iso),
            Some(String::from("2026-10-11T01:30:00.000Z")),
            "zulu"
        );
        assert_eq!(
            parse_js_date("2026-10-11T01:30:00.5+02:00").map(iso),
            Some(String::from("2026-10-10T23:30:00.500Z")),
            "offset"
        );
        assert_eq!(parse_js_date("soon"), None, "invalid");
        assert_eq!(parse_js_date(""), None, "empty");
    }

    #[test]
    fn date_binds() {
        let ms = 1_791_000_000_123;
        assert_eq!(
            date_bind(false, ms),
            Bind::Text(String::from("2026-10-03 04:00:00.123")),
            "sqlite text"
        );
        assert_eq!(
            date_bind(true, ms),
            Bind::Text(String::from("2026-10-03T04:00:00.123Z")),
            "postgres iso"
        );
        assert_eq!(date_ph(true, 2), "CAST(?2 AS TIMESTAMPTZ)", "pg cast");
    }

    fn assert_send<T: Send>(_: &T) {}

    /// The scheduler spawns each run, so their futures must be `Send`.
    fn runs_are_send(job: &crate::jobs::JobCtx) {
        assert_send(&crate::jobs::availability_sync::run(job));
        assert_send(&crate::jobs::blocklisted_tags::run(job));
        assert_send(&crate::jobs::episode_request_sync::run(job));
        assert_send(&crate::jobs::release_calendar::run(job));
        assert_send(&crate::jobs::watchlist_sync::run(job));
    }

    #[test]
    fn job_futures_are_send() {
        let check: fn(&crate::jobs::JobCtx) = runs_are_send;
        assert!(!format!("{check:p}").is_empty(), "checked at compile time");
    }
}
