//! `lib/trakt/recommendations.ts`: the user's raw Trakt recommendation
//! pool, kept an hour, classified for anime chunk by chunk as pages need
//! it, with watched titles hidden at serve time.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde_json::Value;

use super::discoverkit::watched_sets;
use super::trakt::{Browse, Fail, Run};
use super::traktpages::{anime_filter, filter_watched};
use crate::sync::lock;

/// `TRAKT_RECOMMENDATIONS_CACHE_TTL_SECONDS`.
const POOL_TTL: Duration = Duration::from_secs(3600);
/// `TRAKT_RECS_CLASSIFY_CHUNK`.
const CLASSIFY_CHUNK: usize = 20;

/// `TraktRecommendationQueryOptions`.
#[derive(Debug, Clone, Copy)]
pub(super) struct RecsOptions {
    pub(super) media: Browse,
    pub(super) ignore_collected: bool,
    pub(super) ignore_watchlisted: bool,
    pub(super) ignore_watched: bool,
    pub(super) extended: &'static str,
}

/// One page of recommendations.
#[derive(Debug)]
pub(super) struct RecsPage {
    pub(super) items: Vec<Value>,
    pub(super) has_more: bool,
    pub(super) total_pages: Option<i64>,
    pub(super) total_results: Option<i64>,
}

/// `RecsPoolCache`.
#[derive(Debug)]
struct Pool {
    raw: Vec<Value>,
    kept: Vec<Value>,
    cursor: usize,
    complete: bool,
}

type SharedPool = Arc<tokio::sync::Mutex<Pool>>;

/// The pool objects of the entries Node keeps in its `trakt` cache, by
/// `recommendationsCacheKey`. The cache itself (expiry, eviction, flushes
/// and the statistics) holds the entry; this holds the object it stands
/// for, shared and mutated in place as in Node.
static POOLS: LazyLock<Mutex<HashMap<String, SharedPool>>> = LazyLock::new(Mutex::default);

/// `inflightRaw`: one raw fetch per key at a time.
static RAW_LOCKS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(Mutex::default);

/// `cache.data.get(cacheKey)`.
fn pool_get(key: &str) -> Option<SharedPool> {
    if crate::memcache::get(crate::memcache::CacheId::Trakt, key).is_none() {
        lock(&POOLS).remove(key);
        return None;
    }
    lock(&POOLS).get(key).map(Arc::clone)
}

/// `cache.data.set(cacheKey, pool, TRAKT_RECOMMENDATIONS_CACHE_TTL_SECONDS)`.
fn pool_set(key: &str, pool: &SharedPool, snapshot: &Pool) {
    let mut value = serde_json::Map::new();
    value.insert(String::from("raw"), Value::Array(snapshot.raw.clone()));
    value.insert(String::from("kept"), Value::Array(snapshot.kept.clone()));
    value.insert(String::from("cursor"), Value::from(snapshot.cursor));
    value.insert(String::from("complete"), Value::Bool(snapshot.complete));
    crate::memcache::set(
        crate::memcache::CacheId::Trakt,
        key.to_owned(),
        Value::Object(value),
        POOL_TTL,
    );
    lock(&POOLS).insert(key.to_owned(), Arc::clone(pool));
}

/// `recommendationsCacheKey` (without `ignoreWatched`).
fn cache_key(user_id: i64, options: &RecsOptions) -> String {
    format!(
        "recommendations:{user_id}:{}:{}:{}:{}",
        options.media.as_str(),
        options.ignore_collected,
        options.ignore_watchlisted,
        options.extended
    )
}

/// `fetchRawTraktRecommendations`: one type, or both interleaved.
async fn fetch_raw(run: &Run<'_>, options: &RecsOptions) -> Result<Vec<Value>, Fail> {
    let fetch = |kind: &'static str| {
        run.client.recommendations(
            kind,
            options.ignore_collected,
            options.ignore_watchlisted,
            options.extended,
        )
    };
    match options.media {
        Browse::Movie => Ok(fetch("movie").await?),
        Browse::Tv => Ok(fetch("tv").await?),
        Browse::Anime | Browse::All => {
            let (movies, shows) = tokio::join!(fetch("movie"), fetch("tv"));
            let (movies, shows) = (movies?, shows?);
            let mut items = Vec::with_capacity(movies.len() + shows.len());
            let mut movies = movies.into_iter();
            let mut shows = shows.into_iter();
            loop {
                let (movie, show) = (movies.next(), shows.next());
                if movie.is_none() && show.is_none() {
                    break;
                }
                items.extend(movie);
                items.extend(show);
            }
            Ok(items)
        }
    }
}

/// `getOrFetchRawPool` + `getOrCreatePool`.
async fn pool_for(run: &Run<'_>, options: &RecsOptions, key: &str) -> Result<SharedPool, Fail> {
    // `getOrFetchRawPool`'s lookup, then (after the shared fetch)
    // `getOrCreatePool`'s.
    if let Some(pool) = pool_get(key) {
        return Ok(pool);
    }
    let gate = Arc::clone(lock(&RAW_LOCKS).entry(key.to_owned()).or_default());
    let _held = gate.lock().await;
    if let Some(pool) = pool_get(key) {
        return Ok(pool);
    }
    let raw = fetch_raw(run, options).await?;
    let pool = if matches!(options.media, Browse::Movie | Browse::All) {
        Pool {
            kept: raw.clone(),
            cursor: raw.len(),
            raw,
            complete: true,
        }
    } else {
        Pool {
            complete: raw.is_empty(),
            raw,
            kept: Vec::new(),
            cursor: 0,
        }
    };
    let snapshot = Pool {
        raw: pool.raw.clone(),
        kept: pool.kept.clone(),
        cursor: pool.cursor,
        complete: pool.complete,
    };
    let shared = Arc::new(tokio::sync::Mutex::new(pool));
    pool_set(key, &shared, &snapshot);
    Ok(shared)
}

/// `advanceRecsPoolClassification`: classify chunks until `needed` are
/// kept, then store the pool again (a fresh hour).
async fn advance(
    run: &Run<'_>,
    pool: &mut Pool,
    media: Browse,
    needed: usize,
    key: &str,
    shared: &SharedPool,
) -> Result<(), Fail> {
    if pool.complete || pool.kept.len() >= needed || matches!(media, Browse::Movie | Browse::All) {
        return Ok(());
    }
    while !pool.complete && pool.kept.len() < needed {
        let chunk: Vec<Value> = pool
            .raw
            .iter()
            .skip(pool.cursor)
            .take(CLASSIFY_CHUNK)
            .cloned()
            .collect();
        if chunk.is_empty() {
            pool.complete = true;
            break;
        }
        let len = chunk.len();
        let kept = anime_filter(run, chunk, media == Browse::Anime).await?;
        pool.kept.extend(kept);
        pool.cursor += len;
        if pool.cursor >= pool.raw.len() {
            pool.complete = true;
        }
    }
    pool_set(key, shared, pool);
    Ok(())
}

/// `getTraktRecommendationPage(userId, trakt, tmdb, options, page, size)`.
pub(super) async fn recommendation_page(
    run: &Run<'_>,
    options: &RecsOptions,
    page: i64,
    per_page: i64,
) -> Result<RecsPage, Fail> {
    let page = page.max(1);
    let size = usize::try_from(per_page.max(1)).unwrap_or(usize::MAX);
    let offset = usize::try_from(page - 1)
        .unwrap_or(usize::MAX)
        .saturating_mul(size);
    let needed = offset.saturating_add(size);
    let key = cache_key(run.user_id, options);
    let shared = pool_for(run, options, &key).await?;
    let watched = if options.ignore_watched {
        Some(
            watched_sets(run.ctx, run.user_id)
                .await
                .map_err(Fail::Error)?,
        )
    } else {
        None
    };
    let visible_of = |kept: &[Value]| {
        watched
            .as_ref()
            .map_or_else(|| kept.to_vec(), |sets| filter_watched(kept.to_vec(), sets))
    };
    let mut pool = shared.lock().await;
    let mut visible = visible_of(&pool.kept);
    while visible.len() < needed && !pool.complete {
        let target = needed.max(pool.kept.len() + CLASSIFY_CHUNK);
        advance(run, &mut pool, options.media, target, &key, &shared).await?;
        visible = visible_of(&pool.kept);
    }
    let complete = pool.complete;
    drop(pool);
    let items: Vec<Value> = visible.iter().skip(offset).take(size).cloned().collect();
    let has_more = visible.len() > needed || (!complete && !items.is_empty());
    if !complete {
        return Ok(RecsPage {
            items,
            has_more,
            total_pages: None,
            total_results: None,
        });
    }
    let count = i64::try_from(visible.len()).unwrap_or(i64::MAX);
    let size = i64::try_from(size).unwrap_or(i64::MAX);
    Ok(RecsPage {
        items,
        has_more,
        total_pages: Some(((count + size - 1) / size).max(1)),
        total_results: Some(count),
    })
}
