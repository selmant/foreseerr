//! The upgrade matrix: a database created by an older release, with rows in
//! it, brought to this build's schema by the migrations startup runs.
//!
//! Each source is rebuilt by running only the migrations it shipped (up to
//! its cutoff), then seeded with rows written against that older table
//! shape, so the test fails when a later migration loses or mangles data,
//! not just when one fails to run.
//!
//! `SQLite` always runs. Postgres runs when `FORESEERR_UPGRADE_TEST_PG` is
//! a connection URL to a role that may create databases (CI's migration
//! job sets it); each case gets its own database there, dropped afterwards.

use std::path::PathBuf;
use std::str::FromStr;

use anyhow::{ensure, Context, Result};
use serde_json::Map;
use serde_json::Value;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::AssertSqlSafe;

use super::{assert_supported_schema, migrations, run, Migration};
use crate::db::Db;

/// Where an upgrade starts: the last migration timestamp the source shipped.
const SOURCES: [(&str, i64); 4] = [
    // Upstream Seerr at bd491c7e7ecf7d249da532f8fe9b82456ed6e42e, the
    // merge-base this fork's migration history continues from.
    ("seerr-baseline", 1_781_732_098_511),
    ("foreseerr-v0.1.0", 1_784_500_000_000),
    ("foreseerr-v0.5.0", 1_785_910_000_000),
    ("foreseerr-v0.7.0", 1_787_440_000_000),
];

/// The rows every source is seeded with, using only columns the baseline
/// tables already have: two Plex users, an available movie with an
/// approved request, the second user's settings and a built-in slider.
const SEED: [&str; 6] = [
    r#"INSERT INTO "user" ("email", "username", "plexId", "plexToken", "plexUsername", "userType", "permissions", "avatar")
       VALUES ('legacy-admin@seerr.dev', 'legacy-admin', 1, 'legacy-token', 'legacy-admin', 1, 2, '/avatarproxy/legacy')"#,
    r#"INSERT INTO "user" ("email", "username", "plexId", "plexToken", "plexUsername", "userType", "permissions", "avatar")
       VALUES ('legacy-friend@seerr.dev', 'legacy-friend', 2, 'legacy-friend-token', 'legacy-friend', 1, 32, '/avatarproxy/legacy-friend')"#,
    r#"INSERT INTO "media" ("mediaType", "tmdbId", "imdbId", "status", "status4k", "serviceId", "externalServiceId")
       VALUES ('movie', 603, 'tt0133093', 5, 1, 1, 42)"#,
    r#"INSERT INTO "media_request" ("status", "type", "mediaId", "requestedById", "modifiedById", "is4k", "serverId", "profileId", "rootFolder", "languageProfileId", "tags", "isAutoRequest")
       SELECT 2, 'movie', m."id", u."id", u."id", false, 0, 4, '/movies', NULL, NULL, false
       FROM "media" m, "user" u WHERE m."tmdbId" = 603 AND u."email" = 'legacy-admin@seerr.dev'"#,
    r#"INSERT INTO "user_settings" ("userId", "locale", "discoverRegion", "watchlistSyncMovies")
       SELECT "id", 'en', 'US', true FROM "user" WHERE "email" = 'legacy-friend@seerr.dev'"#,
    r#"INSERT INTO "discover_slider" ("type", "order", "isBuiltIn", "enabled", "title")
       VALUES (1, 0, true, true, 'Trending')"#,
];

fn sqlite_db(tag: &str) -> Result<(PathBuf, Db)> {
    let dir = std::env::temp_dir().join(format!(
        "foreseerr-upgrade-{tag}-{}-{}",
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

/// The first row of `sql` as JSON (columns by name), or `None`.
async fn row(db: &Db, sql: &str) -> Result<Option<Map<String, Value>>> {
    Ok(db.rows(sql, &[]).await?.into_iter().next())
}

/// A column of a row from [`row`], NULL when absent.
fn col<'a>(row: &'a Map<String, Value>, name: &str) -> &'a Value {
    row.get(name).unwrap_or(&Value::Null)
}

/// A boolean column as `SQLite` (0/1) or Postgres (true/false) returns it.
fn flag(value: &Value) -> Option<bool> {
    value.as_bool().or_else(|| value.as_i64().map(|n| n != 0))
}

async fn upgrade(db: &Db, source: &str, cutoff: i64) -> Result<()> {
    let all = migrations(db);
    let shipped: Vec<&'static Migration> = all
        .iter()
        .copied()
        .filter(|m| m.timestamp <= cutoff)
        .collect();
    ensure!(
        !shipped.is_empty(),
        "{source}: no migrations up to {cutoff}"
    );
    run(db, &shipped)
        .await
        .context("building the source schema")?;
    for sql in SEED {
        db.execute(sql, &[])
            .await
            .with_context(|| format!("seeding the {source} schema"))?;
    }

    let ran = run(db, &all).await.context("upgrading")?;
    assert_eq!(
        ran.len(),
        all.len() - shipped.len(),
        "{source}: every later migration ran"
    );
    assert_supported_schema(db, &all).await?;
    assert_intact(db, source).await
}

async fn assert_intact(db: &Db, source: &str) -> Result<()> {
    let users = db.scalar(r#"SELECT COUNT(*) FROM "user""#, &[]).await?;
    assert_eq!(users, 2, "{source}: both users survive");
    let emails: Vec<Value> = db
        .rows(r#"SELECT "email" FROM "user" ORDER BY "id""#, &[])
        .await?
        .into_iter()
        .map(|r| col(&r, "email").clone())
        .collect();
    assert_eq!(
        emails,
        [
            Value::from("legacy-admin@seerr.dev"),
            Value::from("legacy-friend@seerr.dev")
        ],
        "{source}"
    );

    let media = row(
        db,
        r#"SELECT "imdbId", "status" FROM "media" WHERE "tmdbId" = 603"#,
    )
    .await?
    .context("the movie is gone")?;
    assert_eq!(col(&media, "imdbId"), "tt0133093", "{source}");
    assert_eq!(col(&media, "status"), 5, "{source}: still available");

    let request = row(
        db,
        r#"SELECT r."status", r."rootFolder", r."ignoreQuota", r."tvQuotaUnits"
           FROM "media_request" r JOIN "media" m ON m."id" = r."mediaId"
           WHERE m."tmdbId" = 603"#,
    )
    .await?
    .context("the request is gone")?;
    assert_eq!(col(&request, "status"), 2, "{source}: still approved");
    assert_eq!(col(&request, "rootFolder"), "/movies", "{source}");
    assert_eq!(
        flag(col(&request, "ignoreQuota")),
        Some(false),
        "{source}: ignoreQuota defaults to false for existing requests"
    );
    assert_eq!(col(&request, "tvQuotaUnits"), 0, "{source}");
    let episodes = db
        .scalar(r#"SELECT COUNT(*) FROM "episode_request""#, &[])
        .await?;
    assert_eq!(episodes, 0, "{source}");

    let settings = row(
        db,
        r#"SELECT s."discoverRegion", s."watchlistSyncMovies", s."traktAccessToken",
                  s."traktUserId", s."autoCompleteSkippedEpisodeEndings",
                  s."autoCompleteSkippedEpisodeThreshold", s."watchAheadEpisodeCount",
                  s."discoverFilterDefaults"
           FROM "user_settings" s JOIN "user" u ON u."id" = s."userId"
           WHERE u."email" = 'legacy-friend@seerr.dev'"#,
    )
    .await?
    .context("the user settings are gone")?;
    assert_eq!(col(&settings, "discoverRegion"), "US", "{source}");
    assert_eq!(
        flag(col(&settings, "watchlistSyncMovies")),
        Some(true),
        "{source}"
    );
    for unset in [
        "traktAccessToken",
        "traktUserId",
        "autoCompleteSkippedEpisodeEndings",
        "autoCompleteSkippedEpisodeThreshold",
        "watchAheadEpisodeCount",
    ] {
        assert!(
            col(&settings, unset).is_null(),
            "{source}: {unset} starts unset"
        );
    }
    // NULL reads as no defaults, as the entity's transformer had it.
    let filters: Value = match col(&settings, "discoverFilterDefaults") {
        Value::String(text) => serde_json::from_str(text)?,
        Value::Null => serde_json::json!({}),
        other @ (Value::Bool(_) | Value::Number(_) | Value::Array(_) | Value::Object(_)) => {
            other.clone()
        }
    };
    assert_eq!(filters, serde_json::json!({}), "{source}");

    let slider = row(
        db,
        r#"SELECT "type", "sort" FROM "discover_slider" WHERE "title" = 'Trending'"#,
    )
    .await?
    .context("the slider is gone")?;
    assert_eq!(col(&slider, "type"), 1, "{source}");
    assert!(col(&slider, "sort").is_null(), "{source}");

    for index in [
        "UQ_user_settings_traktUserId",
        "IDX_media_request_active_ongoing_episode",
    ] {
        let sql = if db.is_postgres() {
            format!("SELECT COUNT(*) FROM pg_indexes WHERE indexname = '{index}' AND schemaname = current_schema()")
        } else {
            format!("SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = '{index}'")
        };
        assert_eq!(db.scalar(&sql, &[]).await?, 1, "{source}: index {index}");
    }
    let foreign = if db.is_postgres() {
        r"SELECT COUNT(DISTINCT ccu.table_name) FROM information_schema.table_constraints tc
          JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
          WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = 'media_request'
            AND tc.table_schema = current_schema() AND ccu.table_name IN ('media', 'user')"
    } else {
        r"SELECT COUNT(DISTINCT `table`) FROM pragma_foreign_key_list('media_request')
          WHERE `table` IN ('media', 'user')"
    };
    assert_eq!(
        db.scalar(foreign, &[]).await?,
        2,
        "{source}: media_request still references media and user"
    );

    // The app's own queries against the upgraded tables, which select
    // columns the raw checks above don't.
    let movie = db
        .media_by_tmdb(603, "movie")
        .await?
        .context("media_by_tmdb")?;
    assert_eq!(db.requests_of_media(movie.id).await?.len(), 1, "{source}");
    assert!(db.user(1).await?.is_some(), "{source}");
    assert_eq!(db.discover_sliders().await?.len(), 1, "{source}");
    Ok(())
}

#[tokio::test]
async fn sqlite_upgrades_keep_data() -> Result<()> {
    for (source, cutoff) in SOURCES {
        let (dir, db) = sqlite_db(source)?;
        let result = upgrade(&db, source, cutoff).await;
        if let Db::Sqlite(pool) = &db {
            pool.close().await;
        }
        result.with_context(|| format!("upgrading from {source}"))?;
        std::fs::remove_dir_all(&dir).context("cleaning up")?;
    }
    Ok(())
}

#[tokio::test]
async fn postgres_upgrades_keep_data() -> Result<()> {
    let Ok(url) = std::env::var("FORESEERR_UPGRADE_TEST_PG") else {
        return Ok(());
    };
    let admin = PgPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .context("connecting to FORESEERR_UPGRADE_TEST_PG")?;
    for (source, cutoff) in SOURCES {
        let name = format!(
            "upgrade_{}_{}",
            source.replace(['-', '.'], "_"),
            std::process::id()
        );
        for sql in [
            format!(r#"DROP DATABASE IF EXISTS "{name}""#),
            format!(r#"CREATE DATABASE "{name}""#),
        ] {
            sqlx::raw_sql(AssertSqlSafe(sql)).execute(&admin).await?;
        }
        let options = PgConnectOptions::from_str(&url)?.database(&name);
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect_with(options)
            .await?;
        let db = Db::Postgres(pool);
        let result = upgrade(&db, source, cutoff).await;
        if let Db::Postgres(pool) = &db {
            pool.close().await;
        }
        result.with_context(|| format!("upgrading from {source}"))?;
        sqlx::raw_sql(AssertSqlSafe(format!(r#"DROP DATABASE "{name}""#)))
            .execute(&admin)
            .await?;
    }
    Ok(())
}
