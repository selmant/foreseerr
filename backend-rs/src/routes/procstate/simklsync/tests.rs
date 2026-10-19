use super::*;
use serde_json::json;

/// `value[path…] = to`.
fn set(value: &mut Value, path: &[&str], to: Value) {
    let Some((last, parents)) = path.split_last() else {
        return;
    };
    let target = parents
        .iter()
        .try_fold(value, |node, key| node.get_mut(*key));
    if let Some(map) = target.and_then(Value::as_object_mut) {
        map.insert((*last).to_owned(), to);
    }
}

fn object(v: &Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

#[test]
fn normalizes_library_items() {
    let raw = json!({
        "status": "watching", "user_rating": 8, "added_to_watchlist_at": "2024-01-02T03:04:05Z",
        "last_watched_at": 1_700_000_000, "watched_episodes_count": "3",
        "show": {"title": "Show", "year": 2020, "poster": "ab/cd", "ids": {"simkl": 42, "tmdb": "7", "slug": "show"}}
    });
    let item = sync_entries(&json!({"shows": [raw]}), None);
    assert_eq!(item.len(), 1, "one show");
    let (raw, kind) = item.into_iter().next().unwrap_or_default();
    assert_eq!(kind, "show", "bucket type");
    let normalized = normalize_item(&raw, Some(kind.as_str()), false);
    assert_eq!(
        normalized,
        Some(vec![
            ("simklId", Cell::Text(String::from("42"))),
            ("simklType", Cell::Text(String::from("show"))),
            ("tmdbId", Cell::Number(7.0)),
            ("slug", Cell::Text(String::from("show"))),
            ("title", Cell::Text(String::from("Show"))),
            ("year", Cell::Number(2020.0)),
            (
                "posterPath",
                Cell::Text(String::from(
                    "https://wsrv.nl/?url=https://simkl.in/posters/ab/cd_w.webp&q=90"
                ))
            ),
            ("status", Cell::Text(String::from("watching"))),
            ("userRating", Cell::Number(8.0)),
            ("addedAt", Cell::Date(1_704_164_645_000)),
            ("lastWatchedAt", Cell::Date(1_700_000_000_000)),
            ("watchedEpisodeCount", Cell::Number(3.0)),
        ]),
        "columns"
    );
    let unknown = object(&json!({"title": "x", "status": "liked", "ids": {"simkl": 1}}));
    assert!(
        normalize_item(&unknown, Some("movie"), false).is_none(),
        "unknown status"
    );
    let untyped = object(&json!({"title": "x", "status": "hold", "ids": {"simkl": 1}}));
    assert!(normalize_item(&untyped, None, false).is_none(), "no type");
}

#[test]
fn normalizes_episodes_and_removed_ratings() {
    let raw = object(&json!({
        "title": "x", "status": "watching", "user_rating": null, "ids": {"simkl": 1},
        "seasons": [
            {"number": 1, "episodes": [{"number": 1}, {"number": "2"}, {"number": 0}, null, {"number": 1.5}]},
            {"number": -1, "episodes": [{"number": 1}]},
            {"number": 0, "episodes": [{"number": 3}]},
            "special"
        ]
    }));
    assert_eq!(
        episode_coordinates(&raw),
        vec![(1, 1), (1, 2), (0, 3)],
        "Simkl's numbering"
    );
    let item = normalize_item(&raw, Some("show"), true).unwrap_or_default();
    assert!(
        item.contains(&("userRating", Cell::Null)),
        "null clears the rating"
    );
    assert!(
        item.contains(&(
            "watchedEpisodes",
            Cell::Text(String::from("[[1,1],[1,2],[0,3]]"))
        )),
        "episodes"
    );
    let unrated = object(&json!({"title": "x", "status": "hold", "ids": {"simkl": 1}}));
    let item = normalize_item(&unrated, Some("anime"), true).unwrap_or_default();
    assert!(
        !item.iter().any(|(c, _)| *c == "userRating"),
        "a missing rating stays"
    );
    assert!(
        item.contains(&("watchedEpisodes", Cell::Text(String::from("[]")))),
        "no seasons, no episodes"
    );
    let movie = normalize_item(&unrated, Some("movie"), true).unwrap_or_default();
    assert!(
        !movie.iter().any(|(c, _)| *c == "watchedEpisodes"),
        "movies have none"
    );
    let rated = normalize_item(&unrated, Some("show"), false).unwrap_or_default();
    assert!(
        !rated.iter().any(|(c, _)| *c == "watchedEpisodes"),
        "a ratings row leaves them alone"
    );
}

#[test]
fn watermark_and_moved_buckets() {
    let before = json!({
        "all": "2024-05-01T00:00:00Z",
        "settings": {"all": "1"},
        "tv_shows": {"all": "1", "watching": "1", "rated_at": "1", "removed_from_list": "1", "playback": "1"},
        "movies": {"all": "1"}
    });
    assert_eq!(
        watermark(&before).as_deref(),
        Some("2024-05-01T00:00:00Z"),
        "all"
    );
    let mut now = before.clone();
    set(&mut now, &["all"], json!("2"));
    set(&mut now, &["settings", "all"], json!("2"));
    set(&mut now, &["tv_shows", "all"], json!("2"));
    set(&mut now, &["tv_shows", "playback"], json!("2"));
    assert_eq!(
        moved_activities(&now, &before),
        Moved::default(),
        "settings, playback and `all` alone"
    );
    let mut now = before.clone();
    set(&mut now, &["movies", "completed"], json!("2"));
    set(&mut now, &["tv_shows", "rated_at"], json!(" 1 "));
    assert_eq!(
        moved_activities(&now, &before),
        Moved {
            statuses: true,
            ..Moved::default()
        },
        "a new status key; scalars compare trimmed"
    );
    let mut now = before.clone();
    set(&mut now, &["tv_shows", "rated_at"], json!(2));
    set(&mut now, &["tv_shows", "removed_from_list"], Value::Null);
    assert_eq!(
        moved_activities(&now, &before),
        Moved {
            ratings: true,
            removals: true,
            ..Moved::default()
        },
        "ratings and removals"
    );
    let anime = json!({"anime": {"hold": "3"}});
    assert!(
        moved_activities(&anime, &json!({})).statuses,
        "anime from nothing"
    );
}

#[test]
fn dates_and_buckets() {
    assert_eq!(
        js_date_parse("2024-01-01T02:00:00+02:00"),
        Some(1_704_067_200_000),
        "offset"
    );
    assert_eq!(to_date(Some(&json!(1.5))), Some(1500), "seconds");
    assert_eq!(to_date(Some(&json!("nope"))), None, "invalid");
    let flat = sync_entries(&json!([{"title": "a"}]), Some("movie"));
    assert_eq!(flat.len(), 1, "a bare array takes the fallback type");
    assert!(
        sync_entries(&json!([{"title": "a"}]), None).is_empty(),
        "no type, no entries"
    );
    assert_eq!(whole(3.0), Some(3), "whole");
    assert_eq!(whole(3.5), None, "fraction");
}

// The request sequences of `server/lib/simklSync.test.ts`, per Simkl's
// sync guide (https://api.simkl.org/guides/sync).

use crate::mediaactions::simklepisodes::cached_watched_coordinates;
use crate::simklapi::stub::{config, handler, Seen, Stub};

const USER: i64 = 7;

/// A linked user and the synced tables.
async fn linked_db() -> anyhow::Result<Db> {
    let db = Db::Sqlite(
        sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?,
    );
    for sql in [
        r#"CREATE TABLE "user_settings" ("id" integer PRIMARY KEY, "userId" integer, "simklAccessToken" varchar, "simklRefreshToken" varchar, "simklTokenExpiresAt" bigint, "simklUserId" varchar)"#,
        r#"CREATE TABLE "simkl_sync_item" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "simklId" varchar NOT NULL, "simklType" varchar NOT NULL, "tmdbId" integer, "tvdbId" integer, "slug" varchar, "title" varchar NOT NULL, "year" integer, "posterPath" varchar, "animeType" varchar, "status" varchar NOT NULL, "userRating" float, "addedAt" datetime, "lastWatchedAt" datetime, "watchedEpisodeCount" integer, "totalEpisodeCount" integer, "userId" integer, "watchedEpisodes" text)"#,
        r#"CREATE TABLE "simkl_sync_state" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "activities" text, "initialSyncComplete" boolean NOT NULL DEFAULT (0), "lastCheckedAt" datetime, "lastSuccessfulSyncAt" datetime, "lastError" text, "userId" integer, CONSTRAINT "REL_simkl_sync_state_user" UNIQUE ("userId"))"#,
    ] {
        db.execute(sql, &[]).await?;
    }
    db.execute(
        r#"INSERT INTO "user_settings" VALUES (1, ?1, 'simkl_at_token', NULL, NULL, '4242')"#,
        &[Bind::Int(USER)],
    )
    .await?;
    Ok(db)
}

/// `syncSimklUser(userId, true)` against `stub`.
async fn sync_with(db: &Db, stub: &Stub) -> anyhow::Result<Value> {
    let client = crate::simklapi::user_client(db, &config(stub), USER)
        .await
        .map_err(anyhow::Error::msg)?;
    let previous = load_previous(db, USER).await?;
    let outcome = pull(db, &client, USER, previous.as_ref()).await;
    settle(db, previous.as_ref(), outcome).await
}

/// Starts a stub routing each request by path, and runs one sync.
async fn sync_routed<F>(db: &Db, route: F) -> anyhow::Result<(Value, Vec<String>)>
where
    F: Fn(&str) -> (u16, Value) + Send + Sync + 'static,
{
    let stub = Stub::start(handler(move |seen: &Seen| route(&seen.path))).await?;
    let result = sync_with(db, &stub).await?;
    Ok((result, stub.requests().iter().map(Seen::call).collect()))
}

fn activities(all: &str) -> Value {
    json!({
        "all": all,
        "settings": {"all": "2026-01-01T00:00:00Z"},
        "tv_shows": {
            "all": all,
            "watching": "2026-01-01T00:00:00Z",
            "plantowatch": "2026-01-01T00:00:00Z",
            "rated_at": "2026-01-01T00:00:00Z",
            "removed_from_list": "2026-01-01T00:00:00Z",
            "playback": "2026-01-01T00:00:00Z"
        },
        "movies": {"all": all, "completed": "2026-01-01T00:00:00Z"},
        "anime": {"all": all, "watching": "2026-01-01T00:00:00Z"}
    })
}

fn with(mut base: Value, extra: &Value) -> Value {
    if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            base.insert(key.clone(), value.clone());
        }
    }
    base
}

fn show(simkl: i64, extra: &Value) -> Value {
    let base = json!({
        "status": "watching",
        "user_rating": null,
        "show": {"title": format!("Show {simkl}"), "ids": {"simkl": simkl, "tmdb": (simkl + 1000).to_string()}}
    });
    with(base, extra)
}

fn movie(simkl: i64, extra: &Value) -> Value {
    let base = json!({
        "status": "completed",
        "movie": {"title": format!("Movie {simkl}"), "ids": {"simkl": simkl, "tmdb": (simkl + 5000).to_string()}}
    });
    with(base, extra)
}

fn one_episode() -> Value {
    json!({"seasons": [{"number": 1, "episodes": [{"number": 1}]}]})
}

/// `type:simklId:status` of every cached item, sorted.
async fn cached(db: &Db) -> anyhow::Result<Vec<String>> {
    let rows = db
        .rows(
            r#"SELECT "simklType", "simklId", "status" FROM "simkl_sync_item" WHERE "userId" = ?1"#,
            &[Bind::Int(USER)],
        )
        .await?;
    let text = |row: &Map<String, Value>, key: &str| {
        row.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let mut out: Vec<String> = rows
        .iter()
        .map(|row| {
            format!(
                "{}:{}:{}",
                text(row, "simklType"),
                text(row, "simklId"),
                text(row, "status")
            )
        })
        .collect();
    out.sort();
    Ok(out)
}

/// The first sync: activities at `2026-05-01`, one show and one movie.
async fn initial_sync(db: &Db) -> anyhow::Result<()> {
    let (result, _) = sync_routed(db, |path| match path {
        "/sync/activities" => (200, activities("2026-05-01T00:00:00Z")),
        "/sync/all-items/shows" => (200, json!({"shows": [show(1, &one_episode())]})),
        "/sync/all-items/movies" => (200, json!({"movies": [movie(2, &json!({}))]})),
        _ => (200, json!({})),
    })
    .await?;
    assert_eq!(result.get("stale"), Some(&Value::Bool(false)), "synced");
    Ok(())
}

#[tokio::test]
async fn pulls_each_type_once_with_episodes_for_shows_and_anime() -> anyhow::Result<()> {
    let db = linked_db().await?;
    let (_, calls) = sync_routed(&db, |path| match path {
        "/sync/activities" => (200, activities("2026-05-01T00:00:00Z")),
        "/sync/all-items/shows" => (
            200,
            json!({"shows": [show(1, &json!({
                "seasons": [{"number": 1, "episodes": [{"number": 1}, {"number": 2}]}]
            }))]}),
        ),
        _ => (200, json!({})),
    })
    .await?;
    assert_eq!(
        calls,
        [
            "/sync/activities",
            "/sync/all-items/shows?extended=full&include_all_episodes=yes",
            "/sync/all-items/movies",
            "/sync/all-items/anime?extended=full&include_all_episodes=yes",
        ],
        "requests"
    );
    assert_eq!(
        cached_watched_coordinates(&db, USER, 1001).await?,
        [(1, 1), (1, 2)],
        "episodes"
    );
    Ok(())
}

#[tokio::test]
async fn stops_after_the_activity_check_when_nothing_changed() -> anyhow::Result<()> {
    let db = linked_db().await?;
    initial_sync(&db).await?;
    let (_, calls) = sync_routed(&db, |_| (200, activities("2026-05-01T00:00:00Z"))).await?;
    assert_eq!(calls, ["/sync/activities"], "requests");
    Ok(())
}

#[tokio::test]
async fn fetches_nothing_when_only_settings_or_playback_moved() -> anyhow::Result<()> {
    let db = linked_db().await?;
    initial_sync(&db).await?;
    let mut later = activities("2026-05-02T00:00:00Z");
    set(
        &mut later,
        &["settings", "all"],
        json!("2026-05-02T00:00:00Z"),
    );
    set(
        &mut later,
        &["tv_shows", "playback"],
        json!("2026-05-02T00:00:00Z"),
    );
    let (_, calls) = sync_routed(&db, move |_| (200, later.clone())).await?;
    assert_eq!(calls, ["/sync/activities"], "requests");
    Ok(())
}

#[tokio::test]
async fn merges_one_all_types_delta_from_the_saved_all() -> anyhow::Result<()> {
    let db = linked_db().await?;
    initial_sync(&db).await?;
    let mut later = activities("2026-05-02T10:00:00Z");
    set(
        &mut later,
        &["tv_shows", "watching"],
        json!("2026-05-02T10:00:00Z"),
    );
    let (_, calls) = sync_routed(&db, move |path| match path {
        "/sync/activities" => (200, later.clone()),
        _ => (
            200,
            json!({"shows": [
                show(1, &with(json!({"status": "completed"}), &one_episode())),
                show(3, &json!({})),
            ]}),
        ),
    })
    .await?;
    assert_eq!(
        calls,
        [
            "/sync/activities",
            "/sync/all-items?date_from=2026-05-01T00%3A00%3A00Z&extended=full&include_all_episodes=yes",
        ],
        "requests"
    );
    assert_eq!(
        cached(&db).await?,
        ["movie:2:completed", "show:1:completed", "show:3:watching"],
        "merged"
    );
    assert!(
        cached_watched_coordinates(&db, USER, 1003)
            .await?
            .is_empty(),
        "no seasons, no episodes"
    );
    Ok(())
}

#[tokio::test]
async fn reads_rating_changes_from_sync_ratings_clearing_removed_ones() -> anyhow::Result<()> {
    let db = linked_db().await?;
    initial_sync(&db).await?;
    db.execute(
        r#"UPDATE "simkl_sync_item" SET "userRating" = 8 WHERE "simklId" = '2'"#,
        &[],
    )
    .await?;
    let mut later = activities("2026-05-03T00:00:00Z");
    set(
        &mut later,
        &["movies", "rated_at"],
        json!("2026-05-03T00:00:00Z"),
    );
    let (_, calls) = sync_routed(&db, move |path| match path {
        "/sync/activities" => (200, later.clone()),
        _ => (
            200,
            json!({
                "movies": [movie(2, &json!({"user_rating": null}))],
                "shows": [show(1, &json!({"user_rating": 9}))]
            }),
        ),
    })
    .await?;
    assert_eq!(
        calls,
        [
            "/sync/activities",
            "/sync/ratings?date_from=2026-05-01T00%3A00%3A00Z",
        ],
        "requests"
    );
    let rows = db
        .rows(
            r#"SELECT "simklId", "userRating" FROM "simkl_sync_item" ORDER BY "simklId""#,
            &[],
        )
        .await?;
    let ratings: Vec<Option<f64>> = rows
        .iter()
        .map(|row| row.get("userRating").and_then(Value::as_f64))
        .collect();
    assert_eq!(ratings, [Some(9.0), None], "show 1 rated, movie 2 cleared");
    assert_eq!(
        cached_watched_coordinates(&db, USER, 1001).await?,
        [(1, 1)],
        "a ratings row keeps the episodes"
    );
    Ok(())
}

#[tokio::test]
async fn diffs_removals_with_one_ids_only_call() -> anyhow::Result<()> {
    let db = linked_db().await?;
    initial_sync(&db).await?;
    let mut later = activities("2026-05-04T00:00:00Z");
    set(
        &mut later,
        &["tv_shows", "removed_from_list"],
        json!("2026-05-04T00:00:00Z"),
    );
    let (_, calls) = sync_routed(&db, move |path| match path {
        "/sync/activities" => (200, later.clone()),
        _ => (200, json!({"movies": [{"movie": {"ids": {"simkl": 2}}}]})),
    })
    .await?;
    assert_eq!(
        calls,
        [
            "/sync/activities",
            "/sync/all-items?extended=simkl_ids_only"
        ],
        "requests"
    );
    assert_eq!(cached(&db).await?, ["movie:2:completed"], "show 1 removed");
    Ok(())
}

#[tokio::test]
async fn keeps_the_saved_snapshot_when_a_delta_fails() -> anyhow::Result<()> {
    let db = linked_db().await?;
    initial_sync(&db).await?;
    let mut later = activities("2026-05-05T00:00:00Z");
    set(
        &mut later,
        &["anime", "watching"],
        json!("2026-05-05T00:00:00Z"),
    );
    let (result, _) = sync_routed(&db, move |path| match path {
        "/sync/activities" => (200, later.clone()),
        _ => (503, json!("down")),
    })
    .await?;
    assert_eq!(result.get("stale"), Some(&Value::Bool(true)), "stale");
    let saved = load_previous(&db, USER)
        .await?
        .and_then(|p| p.activities)
        .unwrap_or_default();
    let saved: Value = serde_json::from_str(&saved)?;
    assert_eq!(
        saved.get("all"),
        Some(&json!("2026-05-01T00:00:00Z")),
        "the next poll resends the same date_from"
    );
    Ok(())
}

#[tokio::test]
async fn pulls_everything_again_when_a_delta_answers_max_items() -> anyhow::Result<()> {
    let db = linked_db().await?;
    initial_sync(&db).await?;
    let mut later = activities("2026-05-06T00:00:00Z");
    set(
        &mut later,
        &["tv_shows", "watching"],
        json!("2026-05-06T00:00:00Z"),
    );
    let (result, calls) = sync_routed(&db, move |path| match path {
        "/sync/activities" => (200, later.clone()),
        "/sync/all-items" => (
            400,
            json!({"error": "max_items", "message": "Too many episodes"}),
        ),
        "/sync/all-items/shows" => (200, json!({"shows": [show(3, &json!({}))]})),
        _ => (200, json!({})),
    })
    .await?;
    assert_eq!(result.get("stale"), Some(&Value::Bool(false)), "synced");
    assert_eq!(
        calls,
        [
            "/sync/activities",
            "/sync/all-items?date_from=2026-05-01T00%3A00%3A00Z&extended=full&include_all_episodes=yes",
            "/sync/all-items/shows?extended=full&include_all_episodes=yes",
            "/sync/all-items/movies",
            "/sync/all-items/anime?extended=full&include_all_episodes=yes",
        ],
        "requests"
    );
    assert_eq!(
        cached(&db).await?,
        ["show:3:watching"],
        "the full pull also drops what left Simkl"
    );
    Ok(())
}

#[tokio::test]
async fn splits_a_type_by_status_when_simkl_answers_max_items() -> anyhow::Result<()> {
    let db = linked_db().await?;
    let (result, calls) = sync_routed(&db, |path| match path {
        "/sync/activities" => (200, activities("2026-05-01T00:00:00Z")),
        "/sync/all-items/shows" => (
            400,
            json!({"error": "max_items", "message": "Too many episodes"}),
        ),
        "/sync/all-items/shows/watching" => (200, json!({"shows": [show(1, &json!({}))]})),
        _ => (200, json!({})),
    })
    .await?;
    assert_eq!(result.get("stale"), Some(&Value::Bool(false)), "synced");
    let params = "?extended=full&include_all_episodes=yes";
    let mut expected = vec![
        String::from("/sync/activities"),
        format!("/sync/all-items/shows{params}"),
    ];
    for status in STATUSES {
        expected.push(format!("/sync/all-items/shows/{status}{params}"));
    }
    expected.push(String::from("/sync/all-items/movies"));
    expected.push(format!("/sync/all-items/anime{params}"));
    assert_eq!(calls, expected, "requests");
    assert_eq!(cached(&db).await?, ["show:1:watching"], "cached");
    Ok(())
}

#[tokio::test]
async fn a_full_pull_drops_items_no_longer_on_simkl() -> anyhow::Result<()> {
    let db = linked_db().await?;
    initial_sync(&db).await?;
    db.execute(
        r#"UPDATE "simkl_sync_state" SET "initialSyncComplete" = 0"#,
        &[],
    )
    .await?;
    sync_routed(&db, |path| match path {
        "/sync/activities" => (200, activities("2026-05-01T00:00:00Z")),
        "/sync/all-items/movies" => (200, json!({"movies": [movie(2, &json!({}))]})),
        _ => (200, json!({})),
    })
    .await?;
    assert_eq!(cached(&db).await?, ["movie:2:completed"], "show 1 dropped");
    Ok(())
}

#[tokio::test]
async fn reads_cached_episodes_of_shows_and_anime_only() -> anyhow::Result<()> {
    let db = linked_db().await?;
    for (id, kind, episodes) in [
        ("1", "show", Some("[[1,1],[1,\"2\"],[2,3.5],3,[0,4]]")),
        ("2", "anime", Some("not json")),
        ("3", "anime", None),
        ("4", "movie", Some("[[9,9]]")),
        ("5", "anime", Some("[[2,1]]")),
    ] {
        db.execute(
            r#"INSERT INTO "simkl_sync_item" ("simklId", "simklType", "tmdbId", "title", "status", "userId", "watchedEpisodes")
               VALUES (?1, ?2, 42, 'x', 'watching', ?3, ?4)"#,
            &[
                Bind::Text(id.to_owned()),
                Bind::Text(kind.to_owned()),
                Bind::Int(USER),
                Bind::OptText(episodes.map(str::to_owned)),
            ],
        )
        .await?;
    }
    assert_eq!(
        cached_watched_coordinates(&db, USER, 42).await?,
        [(1, 1), (0, 4), (2, 1)],
        "integer pairs of shows and anime"
    );
    assert!(
        cached_watched_coordinates(&db, USER + 1, 42)
            .await?
            .is_empty(),
        "another user's"
    );
    Ok(())
}
