use std::path::PathBuf;

use anyhow::{Context, Result};
use serde_json::Value;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};

use super::{
    assert_supported_schema, is_missing_migrations_table_error, run, unknown_migrations, Migration,
};
use crate::db::Db;

/// What `TypeORM`'s own `runMigrations()` leaves in a fresh `SQLite` file
/// (`scripts/gen-migrations.ts`).
const REFERENCE: &str = include_str!("sqlite_reference.json");

fn temp_db(tag: &str) -> Result<(PathBuf, Db)> {
    let dir = std::env::temp_dir().join(format!(
        "foreseerr-dbmigrate-{tag}-{}-{}",
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
    Ok((dir, Db::Sqlite(pool)))
}

#[tokio::test]
async fn fresh_sqlite_matches_typeorm() -> Result<()> {
    let (dir, db) = temp_db("fresh")?;
    let ran = run(&db, &super::migrations(&db)).await?;
    assert_eq!(
        ran.len(),
        super::sqlite::MIGRATIONS.len(),
        "every migration ran"
    );

    let reference: Value = serde_json::from_str(REFERENCE)?;
    let schema = db
        .rows(
            r#"SELECT "type", "name", "tbl_name", "sql" FROM sqlite_master WHERE "name" NOT LIKE 'sqlite_%' ORDER BY "type", "name""#,
            &[],
        )
        .await?;
    let schema = Value::Array(schema.into_iter().map(Value::Object).collect());
    assert_eq!(
        Some(&schema),
        reference.get("schema"),
        "sqlite_master matches"
    );
    // Two migrations share 1786200000000. TypeORM's sort keeps load order
    // for ties, and that is the glob's (directory) order in Node; the
    // compiled registry and this port use file-name order. The schema is
    // the same either way, so compare the rows as a set.
    let rows = db
        .rows(
            r#"SELECT "id", "timestamp", "name" FROM "migrations" ORDER BY "id""#,
            &[],
        )
        .await?;
    let ids: Vec<Value> = rows.iter().filter_map(|r| r.get("id").cloned()).collect();
    let expected_ids: Vec<Value> = (1..=rows.len()).map(Value::from).collect();
    assert_eq!(ids, expected_ids, "ids count up from 1");
    let mut ours: Vec<String> = rows
        .iter()
        .map(|r| {
            format!(
                "{} {}",
                r.get("timestamp").unwrap_or(&Value::Null),
                r.get("name").unwrap_or(&Value::Null)
            )
        })
        .collect();
    let mut theirs: Vec<String> = reference
        .get("migrations")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|r| {
                    format!(
                        "{} {}",
                        r.get("timestamp").unwrap_or(&Value::Null),
                        r.get("name").unwrap_or(&Value::Null)
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    ours.sort();
    theirs.sort();
    assert_eq!(ours, theirs, "the same migrations are recorded");

    assert!(
        run(&db, &super::migrations(&db)).await?.is_empty(),
        "nothing pending the second time"
    );
    assert_supported_schema(&db, &super::migrations(&db)).await?;

    db.execute(
        r#"INSERT INTO "migrations"("timestamp", "name") VALUES (?1, ?2)"#,
        &[
            crate::db::Bind::Int(1_999_999_999_999),
            crate::db::Bind::Text(String::from("FromTheFuture1999999999999")),
        ],
    )
    .await?;
    let refused = assert_supported_schema(&db, &super::migrations(&db)).await;
    assert!(refused.is_err(), "an unknown migration is refused");
    std::fs::remove_dir_all(&dir).context("cleaning up")?;
    Ok(())
}

/// `BackfillWatchAheadMonitoredAt1789700000000`: watch-ahead children from
/// before `monitoredAt` existed are dated from when they were added.
#[tokio::test]
async fn backfills_watch_ahead_monitored_at() -> Result<()> {
    let (dir, db) = temp_db("backfill")?;
    let all = super::migrations(&db);
    let before: Vec<_> = all
        .iter()
        .copied()
        .take_while(|m| m.timestamp != 1_789_700_000_000)
        .collect();
    assert!(before.len() < all.len(), "backfill migration exists");
    run(&db, &before).await?;
    for sql in [
        r#"INSERT INTO "media_request" ("id", "status", "type", "episodeSelectionType") VALUES (1, 2, 'tv', 'watchAhead'), (2, 2, 'tv', 'after')"#,
        r#"INSERT INTO "episode_request" ("requestId", "tvdbId", "seasonNumber", "episodeNumber", "createdAt", "monitoredAt") VALUES
            (1, 11, 1, 1, '2026-09-01 10:00:00', NULL),
            (1, 12, 1, 2, '2026-09-01 10:00:00', '2026-10-20 10:00:00'),
            (2, 21, 1, 1, '2026-09-01 10:00:00', NULL)"#,
    ] {
        db.execute(sql, &[]).await?;
    }
    run(&db, &all).await?;
    let rows = db
        .rows(
            r#"SELECT "tvdbId", "monitoredAt" FROM "episode_request" ORDER BY "tvdbId""#,
            &[],
        )
        .await?;
    let dates: Vec<(i64, Value)> = rows
        .iter()
        .map(|r| {
            (
                r.get("tvdbId").and_then(Value::as_i64).unwrap_or(0),
                r.get("monitoredAt").cloned().unwrap_or(Value::Null),
            )
        })
        .collect();
    assert_eq!(
        dates,
        vec![
            (11, Value::from("2026-09-01 10:00:00")),
            (12, Value::from("2026-10-20 10:00:00")),
            (21, Value::Null),
        ],
        "backfilled from createdAt, real dates kept, other selections untouched"
    );
    std::fs::remove_dir_all(&dir).context("cleaning up")?;
    Ok(())
}

#[tokio::test]
async fn missing_table_is_a_fresh_database() -> Result<()> {
    let (dir, db) = temp_db("guard")?;
    assert_supported_schema(&db, &super::migrations(&db)).await?;
    std::fs::remove_dir_all(&dir).context("cleaning up")?;
    Ok(())
}

#[test]
fn missing_table_errors() {
    assert!(
        is_missing_migrations_table_error("no such table: migrations"),
        "sqlite"
    );
    assert!(
        is_missing_migrations_table_error(
            "error returned from database: relation \"migrations\" does not exist"
        ),
        "postgres"
    );
    assert!(
        !is_missing_migrations_table_error("permission denied for table migrations"),
        "permissions fail closed"
    );
    assert!(
        !is_missing_migrations_table_error("connect ECONNREFUSED 127.0.0.1:5432"),
        "connections fail closed"
    );
    assert!(
        !is_missing_migrations_table_error("no such table: user"),
        "another table"
    );
}

#[test]
fn unknown_names() {
    const KNOWN: Migration = Migration {
        timestamp: 1,
        name: "A0000000000001",
        queries: &[],
    };
    assert_eq!(
        unknown_migrations(
            &[&KNOWN],
            vec![String::from("A0000000000001"), String::from("B")]
        ),
        vec![String::from("B")],
        "only the unknown name"
    );
}

#[test]
fn overseerr_list() {
    let list = super::overseerr_merge_migrations();
    let names: Vec<&str> = list.iter().map(|m| m.name).collect();
    assert!(
        names.contains(&"SeerrMigration1759769291608"),
        "the replacement"
    );
    assert!(!names.contains(&"UpdateWebPush1745492372230"), "replaced");
    assert!(
        !names.contains(&"AddBlacklist1699901142442"),
        "Jellyseerr-only"
    );
    assert_eq!(
        list.len(),
        super::sqlite::MIGRATIONS.len() - 11,
        "eleven dropped, one swapped"
    );
}

#[test]
fn generated_order() {
    for list in [super::sqlite::MIGRATIONS, super::postgres::MIGRATIONS] {
        assert!(
            list.windows(2)
                .all(|w| w.first().map(|m| m.timestamp) <= w.get(1).map(|m| m.timestamp)),
            "sorted by timestamp"
        );
        assert!(
            list.iter()
                .all(|m| m.name.ends_with(&m.timestamp.to_string())),
            "timestamps come from the names"
        );
    }
}
