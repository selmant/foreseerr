//! The database schema at startup when no Node runs behind this server.
//!
//! As Node's `server/index.ts` handles it: `TypeORM`'s
//! `dataSource.runMigrations()` in production (with `PRAGMA
//! foreign_keys=OFF/ON` around it on `SQLite`), then
//! `assertSupportedDatabaseSchema` (`server/lib/db/schemaGuard.ts`).
//!
//! The statements come from `server/migration/{sqlite,postgres}` through
//! `scripts/gen-migrations.ts`; none of the migrations' `up()` methods
//! branch on data, so replaying them in order is the whole port. Applied
//! migrations are recorded in the `migrations` table exactly as `TypeORM`
//! does (id, timestamp, name), so Node and Rust agree on what has run.

pub mod devschema;
mod postgres;
mod sqlite;
mod synchronize;

use std::collections::HashSet;

use anyhow::{bail, Context, Result};
use sqlx::{AssertSqlSafe, Row};

use crate::db::Db;

/// One `TypeORM` migration: `name` (the class name, ending in its
/// timestamp) and the statements its `up()` sends.
#[derive(Debug)]
pub struct Migration {
    /// The last 13 digits of `name`, which `TypeORM` sorts by.
    pub timestamp: i64,
    /// What the `migrations` table records.
    pub name: &'static str,
    /// The statements, in order.
    pub queries: &'static [&'static str],
}

/// The migrations this build ships for the database in use, in the order
/// `TypeORM` runs them.
#[must_use]
pub fn migrations(db: &Db) -> Vec<&'static Migration> {
    if db.is_postgres() {
        postgres::MIGRATIONS.iter().collect()
    } else {
        sqlite::MIGRATIONS.iter().collect()
    }
}

/// The Jellyseerr migrations `checkOverseerrMerge` records as applied on an
/// Overseerr database, as (timestamp, name).
pub const JELLYSEERR_MIGRATIONS: [(i64, &str); 12] = [
    (1_613_379_909_641, "AddJellyfinUserParams1613379909641"),
    (1_613_412_948_344, "ServerTypeEnum1613412948344"),
    (1_613_670_041_760, "AddJellyfinDeviceId1613670041760"),
    (1_682_608_634_546, "AddWatchlists1682608634546"),
    (1_699_901_142_442, "AddBlacklist1699901142442"),
    (
        1_727_907_530_757,
        "AddUserSettingsStreamingRegion1727907530757",
    ),
    (1_734_287_582_736, "AddTelegramMessageThreadId1734287582736"),
    (1_734_805_733_535, "AddOverrideRules1734805733535"),
    (1_737_320_080_282, "AddBlacklistTagsColumn1737320080282"),
    (1_743_023_610_704, "UpdateWebPush1743023610704"),
    (1_743_107_645_301, "AddUserAvatarCacheFields1743107645301"),
    (1_745_492_372_230, "UpdateWebPush1745492372230"),
];

/// The `SQLite` list `checkOverseerrMerge` swaps in for the rest of the
/// process: the Jellyseerr-only migrations dropped, and
/// `UpdateWebPush1745492372230` replaced by its `SeerrMigration`.
#[must_use]
pub fn overseerr_merge_migrations() -> Vec<&'static Migration> {
    let replaced = "UpdateWebPush1745492372230";
    let mut list: Vec<&'static Migration> = sqlite::MIGRATIONS
        .iter()
        .filter(|m| m.name == replaced || !JELLYSEERR_MIGRATIONS.iter().any(|(_, n)| *n == m.name))
        .map(|m| {
            if m.name == replaced {
                &sqlite::SEERR_MIGRATION
            } else {
                m
            }
        })
        .collect();
    // TypeORM sorts by timestamp again, keeping ties in list order.
    list.sort_by_key(|m| m.timestamp);
    list
}

/// Node's production startup: run every pending migration in one
/// transaction, as `runMigrations()` with the default `transaction: "all"`.
/// Returns the names of the migrations that ran.
///
/// # Errors
///
/// Fails when a statement fails; the transaction is rolled back and Node
/// would stop here too.
pub async fn run(db: &Db, all: &[&'static Migration]) -> Result<Vec<&'static str>> {
    let ran = match db {
        Db::Sqlite(pool) => {
            let mut conn = pool.acquire().await.context("opening the database")?;
            let conn = &mut *conn;
            // server/index.ts wraps runMigrations() in these.
            exec_sqlite(conn, "PRAGMA foreign_keys=OFF").await?;
            let ran = run_sqlite(conn, all).await;
            exec_sqlite(conn, "PRAGMA foreign_keys=ON").await?;
            ran?
        }
        Db::Postgres(pool) => {
            let mut conn = pool.acquire().await.context("connecting to Postgres")?;
            run_postgres(&mut conn, all).await?
        }
    };
    for name in &ran {
        tracing::info!(
            label = "Database",
            "Migration {name} has been executed successfully."
        );
    }
    Ok(ran)
}

async fn exec_sqlite(conn: &mut sqlx::SqliteConnection, sql: &'static str) -> Result<()> {
    sqlx::raw_sql(sql)
        .execute(conn)
        .await
        .with_context(|| format!("running {sql}"))?;
    Ok(())
}

async fn exec_postgres(conn: &mut sqlx::PgConnection, sql: &'static str) -> Result<()> {
    sqlx::raw_sql(sql)
        .execute(conn)
        .await
        .with_context(|| format!("running {sql}"))?;
    Ok(())
}

/// The migrations not recorded yet, oldest first (`TypeORM` matches by name).
fn pending(all: &[&'static Migration], executed: &[String]) -> Vec<&'static Migration> {
    let executed: HashSet<&str> = executed.iter().map(String::as_str).collect();
    all.iter()
        .copied()
        .filter(|m| !executed.contains(m.name))
        .collect()
}

async fn run_sqlite(
    conn: &mut sqlx::SqliteConnection,
    all: &[&'static Migration],
) -> Result<Vec<&'static str>> {
    let exists: Option<String> = sqlx::query_scalar(
        r#"SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" = 'migrations'"#,
    )
    .fetch_optional(&mut *conn)
    .await
    .context("looking for the migrations table")?;
    if exists.is_none() {
        exec_sqlite(conn, sqlite::MIGRATIONS_TABLE).await?;
    }
    let executed: Vec<String> =
        sqlx::query_scalar(r#"SELECT "name" FROM "migrations" ORDER BY "id" DESC"#)
            .fetch_all(&mut *conn)
            .await
            .context("reading the migrations table")?;
    let pending = pending(all, &executed);
    if pending.is_empty() {
        return Ok(Vec::new());
    }
    // AbstractSqliteQueryRunner.beforeMigration() / startTransaction().
    exec_sqlite(conn, "PRAGMA foreign_keys = OFF").await?;
    exec_sqlite(conn, "BEGIN TRANSACTION").await?;
    let applied = apply_sqlite(conn, &pending).await;
    if applied.is_err() {
        if let Err(e) = exec_sqlite(conn, "ROLLBACK").await {
            tracing::warn!(label = "Database", "rolling back failed: {e:#}");
        }
    }
    let applied = applied?;
    exec_sqlite(conn, "COMMIT").await?;
    exec_sqlite(conn, "PRAGMA foreign_keys = ON").await?;
    Ok(applied)
}

async fn apply_sqlite(
    conn: &mut sqlx::SqliteConnection,
    pending: &[&'static Migration],
) -> Result<Vec<&'static str>> {
    let mut applied = Vec::new();
    for migration in pending {
        for query in migration.queries {
            let sql = sqlite_text(query);
            if let Err(e) = sqlx::raw_sql(AssertSqlSafe(sql)).execute(&mut *conn).await {
                tracing::error!(
                    label = "Database",
                    "Migration \"{}\" failed, error: {e}",
                    migration.name
                );
                bail!("migration {} failed: {e}", migration.name);
            }
        }
        sqlx::query(r#"INSERT INTO "migrations"("timestamp", "name") VALUES (?, ?)"#)
            .bind(migration.timestamp)
            .bind(migration.name)
            .execute(&mut *conn)
            .await
            .with_context(|| format!("recording migration {}", migration.name))?;
        applied.push(migration.name);
    }
    Ok(applied)
}

/// sqlx trims a statement before preparing it, but `SQLite` stores a
/// `CREATE INDEX` with the whitespace that ended it, and Node's schema has
/// those spaces. A closing `;` keeps them: `SQLite` drops the `;` itself.
fn sqlite_text(query: &str) -> String {
    if query.ends_with(char::is_whitespace) {
        format!("{query};")
    } else {
        query.to_owned()
    }
}

async fn run_postgres(
    conn: &mut sqlx::PgConnection,
    all: &[&'static Migration],
) -> Result<Vec<&'static str>> {
    let exists: Option<String> = sqlx::query_scalar(
        r#"SELECT "table_name"::text FROM "information_schema"."tables" WHERE "table_schema" = current_schema() AND "table_name" = 'migrations'"#,
    )
    .fetch_optional(&mut *conn)
    .await
    .context("looking for the migrations table")?;
    if exists.is_none() {
        exec_postgres(conn, postgres::MIGRATIONS_TABLE).await?;
    }
    let executed: Vec<String> =
        sqlx::query_scalar(r#"SELECT "name"::text FROM "migrations" ORDER BY "id" DESC"#)
            .fetch_all(&mut *conn)
            .await
            .context("reading the migrations table")?;
    let pending = pending(all, &executed);
    if pending.is_empty() {
        return Ok(Vec::new());
    }
    exec_postgres(conn, "START TRANSACTION").await?;
    let applied = apply_postgres(conn, &pending).await;
    if applied.is_err() {
        if let Err(e) = exec_postgres(conn, "ROLLBACK").await {
            tracing::warn!(label = "Database", "rolling back failed: {e:#}");
        }
    }
    let applied = applied?;
    exec_postgres(conn, "COMMIT").await?;
    Ok(applied)
}

async fn apply_postgres(
    conn: &mut sqlx::PgConnection,
    pending: &[&'static Migration],
) -> Result<Vec<&'static str>> {
    let mut applied = Vec::new();
    for migration in pending {
        for query in migration.queries {
            if let Err(e) = sqlx::raw_sql(AssertSqlSafe(*query))
                .execute(&mut *conn)
                .await
            {
                tracing::error!(
                    label = "Database",
                    "Migration \"{}\" failed, error: {e}",
                    migration.name
                );
                bail!("migration {} failed: {e}", migration.name);
            }
        }
        sqlx::query(r#"INSERT INTO "migrations"("timestamp", "name") VALUES ($1, $2)"#)
            .bind(migration.timestamp)
            .bind(migration.name)
            .execute(&mut *conn)
            .await
            .with_context(|| format!("recording migration {}", migration.name))?;
        applied.push(migration.name);
    }
    Ok(applied)
}

/// `isMissingMigrationsTableError`: only a missing `migrations` table is
/// fine (a fresh database); every other read error fails closed.
#[must_use]
pub fn is_missing_migrations_table_error(message: &str) -> bool {
    let lower = message.to_lowercase();
    if !lower.contains("migrations") {
        return false;
    }
    lower.contains("no such table") || relation_does_not_exist(&lower)
}

/// `/relation .+ does not exist/i`.
fn relation_does_not_exist(lower: &str) -> bool {
    lower.find("relation ").is_some_and(|start| {
        lower
            .get(start + "relation ".len()..)
            .and_then(|rest| rest.find(" does not exist"))
            .is_some_and(|gap| gap > 0)
    })
}

/// The recorded migrations this build does not know, in table order.
fn unknown_migrations(known: &[&Migration], executed: Vec<String>) -> Vec<String> {
    let known: HashSet<&str> = known.iter().map(|m| m.name).collect();
    executed
        .into_iter()
        .filter(|name| !known.contains(name.as_str()))
        .collect()
}

/// `assertSupportedDatabaseSchema`: refuse a database migrated by a newer
/// Foreseerr than this one.
///
/// # Errors
///
/// Fails when the migrations table can't be read (other than missing) or
/// names a migration this build doesn't ship.
pub async fn assert_supported_schema(db: &Db, known: &[&'static Migration]) -> Result<()> {
    let sql = r#"SELECT "name" FROM "migrations""#;
    let read: Result<Vec<String>, sqlx::Error> = match db {
        Db::Sqlite(pool) => sqlx::query(sql)
            .fetch_all(pool)
            .await
            .and_then(|rows| rows.iter().map(|r| r.try_get::<String, _>(0)).collect()),
        Db::Postgres(pool) => sqlx::query(sql)
            .fetch_all(pool)
            .await
            .and_then(|rows| rows.iter().map(|r| r.try_get::<String, _>(0)).collect()),
    };
    let executed = match read {
        Ok(names) => names,
        Err(e) if is_missing_migrations_table_error(&e.to_string()) => return Ok(()),
        Err(e) => {
            tracing::error!(
                label = "Database",
                "Failed to read the migrations table; refusing to start. {e}"
            );
            return Err(e).context("reading the migrations table");
        }
    };
    let unknown = unknown_migrations(known, executed);
    if unknown.is_empty() {
        return Ok(());
    }
    tracing::error!(
        label = "Database",
        "This database was migrated by a newer version of Foreseerr and includes migrations this version does not recognize: {}.",
        unknown.join(", ")
    );
    tracing::error!(
        label = "Database",
        "Downgrading a database to an older Foreseerr version is not supported. Restore a backup taken before the upgrade, or upgrade to a Foreseerr release that recognizes these migrations. See the Backups documentation for restore procedures."
    );
    bail!("Unsupported database schema: unrecognized migrations detected.")
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod upgradetests;
