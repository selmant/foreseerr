//! The SQL against a real database: a scratch copy named by
//! `FORESEERR_MAPPING_TEST_DB` (skipped when unset, except under `CI`,
//! where a missing database fails). It writes to that copy, so never point
//! it at a live database. `scripts/ci-smoke.py --mapping-db` builds one.

use anyhow::Result;
use serde_json::{json, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

use super::resolutions::{self, Observation, Write};
use super::{animelist, discover, edges, resolve, Ctx, IdRef, MediaType};
use crate::db::{Bind, Db};
use crate::tmdb::TmdbClient;

fn open() -> Option<Db> {
    let Ok(path) = std::env::var("FORESEERR_MAPPING_TEST_DB") else {
        // CI must run this test, not pass it vacuously.
        assert!(
            std::env::var_os("CI").is_none(),
            "CI is set but FORESEERR_MAPPING_TEST_DB is not; build one with scripts/ci-smoke.py --mapping-db"
        );
        return None;
    };
    assert!(
        std::path::Path::new(&path).is_file(),
        "FORESEERR_MAPPING_TEST_DB={path} is not a file"
    );
    let options = SqliteConnectOptions::new().filename(path);
    Some(Db::Sqlite(
        SqlitePoolOptions::new()
            .max_connections(2)
            .connect_lazy_with(options),
    ))
}

async fn row(db: &Db, ns: &str, id: &str) -> Result<Vec<serde_json::Map<String, Value>>> {
    db.rows(
        r#"SELECT "mediaType", "tmdbId", "tmdbType", "origin", "title", "year", "discoverSource", "detail", "hitCount", "checkedAt" FROM "mapping_resolution" WHERE "srcNs" = ?1 AND "srcId" = ?2 ORDER BY "id""#,
        &[Bind::Text(ns.to_owned()), Bind::Text(id.to_owned())],
    )
    .await
}

#[tokio::test]
async fn against_a_scratch_database() -> Result<()> {
    let Some(db) = open() else {
        return Ok(());
    };
    if rustls::crypto::ring::default_provider()
        .install_default()
        .is_err()
    {
        tracing::trace!("a provider was installed");
    }
    let http = reqwest::Client::builder().build()?;
    let tmdb = TmdbClient::new(http.clone());
    let ctx = Ctx {
        db: &db,
        tmdb: &tmdb,
        http: &http,
        locale: String::from("en"),
    };

    // Edges and animeList.
    let item = animelist::from_anidb(&ctx, 1).await?;
    assert_eq!(
        item.map(|i| (i.tvdb_id, i.tvdb_season, i.tmdb_id)),
        Some((Some(72025), Some(1), Some(26209))),
        "anidb 1"
    );
    let special = animelist::special_episode(&ctx, 100_171, 3).await?;
    assert_eq!(
        special.and_then(|s| s.tmdb_id),
        Some(79109),
        "a film in the specials"
    );
    let shows = edges::targets_in(&edges::edges_from(&db, "anilist", "21").await?, "tmdb_show");
    assert_eq!(shows.len(), 1, "one show across seasons");
    let known =
        edges::dataset_tmdb(&db, &IdRef::new("anilist", "21"), Some(MediaType::Tv), true).await?;
    assert_eq!(known.map(|k| k.tmdb_id), Some(37854), "dataset answer");

    // Stored resolutions: a miss, a sighting, an answer that replaces it.
    let r = IdRef::new("trakt", "mapping-test-slug");
    let miss = Write {
        r: r.clone(),
        media_type: Some(String::from("movie")),
        origin: "miss",
        title: Some(String::from("Test")),
        attempted: true,
        ..Write::default()
    };
    resolutions::save_resolution(&db, &miss).await?;
    resolutions::record_miss(
        &db,
        Observation::new(r.clone())
            .with("mediaType", json!("movie"))
            .with("title", Value::Null)
            .with("year", json!(2001)),
    );
    resolutions::flush_misses(&db).await;
    let rows = row(&db, "trakt", "mapping-test-slug").await?;
    assert_eq!(
        rows.first().map(|r| (
            r.get("hitCount").cloned(),
            r.get("title").cloned(),
            r.get("year").cloned()
        )),
        Some((Some(json!(1)), Some(json!("Test")), Some(json!(2001)))),
        "a sighting counts and keeps the title"
    );
    let stored = resolutions::stored_for(&db, std::slice::from_ref(&r)).await?;
    assert_eq!(stored.len(), 1, "one row");
    let resolution = resolve::resolve_tmdb(
        &ctx,
        resolve::Request {
            refs: vec![r.clone()],
            media_type: Some(MediaType::Movie),
            offline: true,
            ..resolve::Request::default()
        },
    )
    .await?;
    assert_eq!(resolution, None, "offline and a fresh miss");

    let answer = Write {
        tmdb_id: Some(603),
        tmdb_type: Some(String::from("movie")),
        origin: "tmdb-find",
        ..miss.clone()
    };
    resolutions::save_resolution(&db, &answer).await?;
    resolutions::save_resolution(&db, &miss).await?;
    let rows = row(&db, "trakt", "mapping-test-slug").await?;
    assert_eq!(
        rows.first()
            .map(|r| (r.get("origin").cloned(), r.get("tmdbId").cloned())),
        Some((Some(json!("tmdb-find")), Some(json!(603)))),
        "a miss never replaces an answer"
    );

    // Unmapped tiles go through the miss buffer.
    discover::record_unmapped_items(
        &ctx,
        &[
            json!({"title": "Tile", "mediaType": "tv", "source": "simkl", "sourceId": "mapping-test-1"}),
        ],
        Some(&json!({"discoverSource": "simkl/test"})),
    );
    resolutions::flush_misses(&db).await;
    let rows = row(&db, "simkl", "mapping-test-1").await?;
    assert_eq!(
        rows.first().map(|r| (
            r.get("origin").cloned(),
            r.get("mediaType").cloned(),
            r.get("discoverSource").cloned(),
            r.get("checkedAt").cloned()
        )),
        Some((
            Some(json!("miss")),
            Some(json!("tv")),
            Some(json!("simkl/test")),
            Some(json!("1970-01-01 00:00:00.000"))
        )),
        "a bare sighting is not an attempt"
    );

    // A correction wins in the confirm step.
    db.execute(
        r#"INSERT INTO "mapping_resolution" ("srcNs", "srcId", "mediaType", "tmdbId", "tmdbType", "origin", "hitCount", "checkedAt", "createdAt", "updatedAt") VALUES ('trakt', 'mapping-test-fixed', '', 11, 'movie', 'manual', 0, '2026-01-01 00:00:00.000', '2026-01-01 00:00:00.000', '2026-01-01 00:00:00.000')"#,
        &[],
    )
    .await?;
    resolutions::invalidate_corrections();
    let confirmed = discover::confirm_items(
        &ctx,
        &[json!({"tmdbId": 12, "mediaType": "movie", "refs": []})],
        Some(&json!({"namespace": {"ns": "trakt", "id": "mapping-test-fixed"}})),
    )
    .await?;
    assert_eq!(
        Value::Array(confirmed).to_string(),
        r#"[{"tmdbId":11,"mediaType":"movie","mappingState":{"state":"mapped","sourceKey":"manual","namespace":"trakt","externalId":"mapping-test-fixed"}}]"#,
        "the correction replaces the id"
    );

    let datasets = crate::mappingdatasets::list_datasets(&db).await?;
    assert_eq!(datasets.len(), 2, "both datasets listed");

    db.execute(
        r#"DELETE FROM "mapping_resolution" WHERE "srcId" LIKE 'mapping-test-%'"#,
        &[],
    )
    .await?;
    Ok(())
}
