//! The schema step of a development start on `SQLite`.
//!
//! `devConfig` in `server/datasource.ts` has `synchronize: true`, so
//! `TypeORM` builds the schema from the entities instead of running the
//! migrations (whose result differs: other index and constraint names,
//! column order).
//!
//! On an empty database this sends the statements `synchronize` sends
//! (`synchronize.rs`, recorded from `TypeORM`), framed as `TypeORM`
//! frames them. A
//! database that already has exactly that schema needs nothing, as
//! `synchronize` then sends nothing. Any other schema `synchronize` would
//! diff against the entities and alter; that is not reproduced here, only
//! reported.

use anyhow::{Context, Result};
use serde_json::{Map, Value};

use super::{exec_sqlite, sqlite_text, synchronize};
use crate::db::Db;

/// What `synchronize` leaves in a fresh `SQLite` file, as recorded from
/// `TypeORM`.
pub(super) const REFERENCE: &str = include_str!("synchronize_reference.json");

/// The schema rows compared, as in the reference.
pub(super) const SCHEMA_SQL: &str = r#"SELECT "type", "name", "tbl_name", "sql" FROM sqlite_master WHERE "name" NOT LIKE 'sqlite_%' ORDER BY "type", "name""#;

/// What the start does to the schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// The database was empty; the entity schema was created.
    Created,
    /// The schema already is the entity schema.
    UpToDate,
    /// The schema differs; `synchronize` would alter it.
    Differs,
    /// Postgres: development runs the migrations instead.
    NotSqlite,
}

/// `synchronize` on a development start.
///
/// # Errors
///
/// Fails when the database can't be read or a statement fails (the
/// transaction is rolled back, and Node would stop there too).
pub async fn synchronize(db: &Db) -> Result<Outcome> {
    let Db::Sqlite(pool) = db else {
        return Ok(Outcome::NotSqlite);
    };
    let schema = db.rows(SCHEMA_SQL, &[]).await?;
    if schema.is_empty() {
        let mut conn = pool.acquire().await.context("opening the database")?;
        let conn = &mut *conn;
        // AbstractSqliteQueryRunner.beforeMigration() / startTransaction().
        exec_sqlite(conn, "PRAGMA foreign_keys = OFF").await?;
        exec_sqlite(conn, "BEGIN TRANSACTION").await?;
        let applied = apply(conn).await;
        if applied.is_err() {
            if let Err(e) = exec_sqlite(conn, "ROLLBACK").await {
                tracing::warn!(label = "Database", "rolling back failed: {e:#}");
            }
        }
        applied?;
        exec_sqlite(conn, "COMMIT").await?;
        exec_sqlite(conn, "PRAGMA foreign_keys = ON").await?;
        return Ok(Outcome::Created);
    }
    if matches_reference(schema)? {
        return Ok(Outcome::UpToDate);
    }
    tracing::warn!(
        label = "Database",
        "The database schema is not the one TypeORM's synchronize builds from the entities, and development mode doesn't alter it (Node's did). Start from an empty database, or run in production mode, which runs the migrations."
    );
    Ok(Outcome::Differs)
}

async fn apply(conn: &mut sqlx::SqliteConnection) -> Result<()> {
    for statement in synchronize::STATEMENTS {
        sqlx::raw_sql(sqlx::AssertSqlSafe(sqlite_text(statement)))
            .execute(&mut *conn)
            .await
            .with_context(|| format!("synchronize failed on {statement}"))?;
    }
    Ok(())
}

/// Whether these `sqlite_master` rows are the reference schema.
pub(super) fn matches_reference(schema: Vec<Map<String, Value>>) -> Result<bool> {
    let reference: Value =
        serde_json::from_str(REFERENCE).context("reading the synchronize reference")?;
    let schema = Value::Array(schema.into_iter().map(Value::Object).collect());
    Ok(reference.get("schema") == Some(&schema))
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};

    use super::*;

    #[tokio::test]
    async fn fresh_sqlite_gets_the_synchronize_schema() -> Result<()> {
        let dir = std::env::temp_dir().join(format!(
            "foreseerr-devschema-{}-{}",
            std::process::id(),
            crate::clock::now_millis()
        ));
        std::fs::create_dir_all(&dir)?;
        let options = SqliteConnectOptions::new()
            .filename(dir.join("db.sqlite3"))
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal);
        let db = Db::Sqlite(
            SqlitePoolOptions::new()
                .max_connections(2)
                .connect_lazy_with(options),
        );
        assert_eq!(synchronize(&db).await?, Outcome::Created);
        assert!(matches_reference(db.rows(SCHEMA_SQL, &[]).await?)?);
        assert_eq!(synchronize(&db).await?, Outcome::UpToDate);
        db.execute(r#"DROP TABLE "mapping_dataset""#, &[]).await?;
        assert_eq!(synchronize(&db).await?, Outcome::Differs);
        if let Db::Sqlite(pool) = &db {
            pool.close().await;
        }
        std::fs::remove_dir_all(&dir)?;
        Ok(())
    }
}
