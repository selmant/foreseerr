//! Statements that run either on the pool or inside a
//! `dataSource.transaction(...)` ([`crate::jobs::syncutil::Tx`]), so the
//! helpers a transaction shares with plain writes take either.

use anyhow::{Context, Result};
use serde_json::{Map, Value};

use crate::db::{Bind, Db};
use crate::jobs::syncutil::Tx;

/// Where a statement runs.
#[derive(Debug)]
pub enum Exec<'a> {
    /// The pool: each statement on its own.
    Db(&'a Db),
    /// The open transaction.
    Tx(&'a mut Tx),
}

impl Exec<'_> {
    /// A statement with `?N` placeholders; the rows it touched.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn execute(&mut self, sql: &str, binds: &[Bind]) -> Result<u64> {
        match self {
            Self::Db(db) => db.execute(sql, binds).await,
            Self::Tx(tx) => tx.execute(sql, binds).await,
        }
    }

    /// Rows as JSON objects, like [`Db::rows`].
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn rows(&mut self, sql: &str, binds: &[Bind]) -> Result<Vec<Map<String, Value>>> {
        match self {
            Self::Db(db) => db.rows(sql, binds).await,
            Self::Tx(tx) => tx.rows(sql, binds).await,
        }
    }

    /// One integer: the first column of the first row, like
    /// [`Db::scalar`].
    ///
    /// # Errors
    ///
    /// Fails on database errors or when no integer comes back.
    pub async fn scalar(&mut self, sql: &str, binds: &[Bind]) -> Result<i64> {
        match self {
            Self::Db(db) => db.scalar(sql, binds).await,
            Self::Tx(tx) => tx
                .rows(sql, binds)
                .await?
                .first()
                .and_then(|row| row.values().next())
                .and_then(Value::as_i64)
                .context("the statement returned no integer"),
        }
    }
}

/// [`crate::typeorm::insert`] on the pool or inside a transaction: the
/// new row's id.
///
/// # Errors
///
/// Fails for non-scalar values or database errors.
pub async fn insert(exec: &mut Exec<'_>, table: &str, columns: &[(&str, Value)]) -> Result<i64> {
    let mut binds = Vec::new();
    let mut names = Vec::with_capacity(columns.len());
    let mut values = Vec::with_capacity(columns.len());
    for (column, value) in columns {
        names.push(format!("\"{column}\""));
        values.push(crate::typeorm::sql_value(value, &mut binds)?);
    }
    let sql = format!(
        "INSERT INTO \"{table}\" ({}) VALUES ({}) RETURNING CAST(\"id\" AS BIGINT)",
        names.join(", "),
        values.join(", ")
    );
    exec.scalar(&sql, &binds).await
}

/// The TVDB id a new media row is saved with.
///
/// None when another row already holds it, as the column is unique and
/// the insert would fail: Sonarr's `tmdb:` lookup can give a show the TVDB
/// id TMDB lists for another entry.
///
/// # Errors
///
/// Fails on database errors.
pub async fn free_tvdb_id(
    exec: &mut Exec<'_>,
    tmdb_id: i64,
    wanted: Option<i64>,
) -> Result<Option<i64>> {
    let Some(id) = wanted else {
        return Ok(None);
    };
    let holders = exec
        .rows(
            r#"SELECT "tmdbId" FROM "media" WHERE "tvdbId" = ?1"#,
            &[Bind::Int(id)],
        )
        .await?;
    let Some(holder) = holders.first() else {
        return Ok(Some(id));
    };
    let other = holder.get("tmdbId").and_then(Value::as_i64).unwrap_or(0);
    tracing::warn!(
        "TVDB ID {id} of TMDB {tmdb_id} is already on the media of TMDB {other}; saving TMDB {tmdb_id} without it"
    );
    Ok(None)
}

/// [`crate::typeorm::run`] on the pool or inside a transaction.
///
/// # Errors
///
/// Fails on database errors.
pub async fn run(exec: &mut Exec<'_>, update: Option<(String, Vec<Bind>)>) -> Result<()> {
    if let Some((sql, binds)) = update {
        exec.execute(&sql, &binds).await?;
    }
    Ok(())
}

/// A migrated scratch `SQLite` database for tests of the write paths,
/// removed when dropped.
#[cfg(test)]
pub mod scratch {
    use std::path::PathBuf;

    use anyhow::{Context, Result};
    use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};

    use crate::db::Db;

    /// The database and its directory.
    #[derive(Debug)]
    pub struct Scratch {
        /// The pool: two connections, so pool reads work beside an open
        /// transaction as they do in the server.
        pub db: Db,
        dir: PathBuf,
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            if let Err(e) = std::fs::remove_dir_all(&self.dir) {
                tracing::warn!("removing {} failed: {e}", self.dir.display());
            }
        }
    }

    /// A fresh file with every migration applied.
    ///
    /// # Errors
    ///
    /// Fails when the file can't be made or a migration fails.
    pub async fn sqlite(tag: &str) -> Result<Scratch> {
        let dir = std::env::temp_dir().join(format!(
            "foreseerr-dbtx-{tag}-{}-{}",
            std::process::id(),
            crate::clock::now_millis()
        ));
        std::fs::create_dir_all(&dir)?;
        let options = SqliteConnectOptions::new()
            .filename(dir.join("db.sqlite3"))
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal);
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_lazy_with(options);
        let scratch = Scratch {
            db: Db::Sqlite(pool),
            dir,
        };
        crate::dbmigrate::run(&scratch.db, &crate::dbmigrate::migrations(&scratch.db))
            .await
            .context("migrating the scratch database")?;
        Ok(scratch)
    }

    /// Run statements (seed rows, triggers) one by one.
    ///
    /// # Errors
    ///
    /// Fails on the first statement that does.
    pub async fn run(db: &Db, statements: &[&str]) -> Result<()> {
        for sql in statements {
            db.execute(sql, &[])
                .await
                .with_context(|| format!("running {sql}"))?;
        }
        Ok(())
    }

    /// The integers of a one-column query, in order.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn ints(db: &Db, sql: &str) -> Result<Vec<i64>> {
        Ok(db
            .rows(sql, &[])
            .await?
            .iter()
            .filter_map(|row| row.values().next().and_then(serde_json::Value::as_i64))
            .collect())
    }

    /// A user (1), a series (`media` 1) with season 1 stored, and a
    /// pending request (1) for that season with one quota unit.
    pub const PENDING_SEASON_ONE: [&str; 5] = [
        r#"INSERT INTO "user" ("id", "email", "avatar", "permissions") VALUES (1, 'owner@example.test', '', 2)"#,
        r#"INSERT INTO "media" ("id", "mediaType", "tmdbId", "status") VALUES (1, 'tv', 1399, 2)"#,
        r#"INSERT INTO "season" ("seasonNumber", "status", "mediaId") VALUES (1, 2, 1)"#,
        r#"INSERT INTO "media_request" ("id", "status", "type", "mediaId", "requestedById", "tvQuotaUnits") VALUES (1, 1, 'tv', 1, 1, 1)"#,
        r#"INSERT INTO "season_request" ("seasonNumber", "status", "requestId") VALUES (1, 1, 1)"#,
    ];
}
