//! How the Trakt discover routes fill a page.
//!
//! `resolveTraktDiscoverPage` (`routes/discover/trakt.ts`),
//! `lib/discover/traktDiscoverPagination.ts`, `lib/trakt/animeFilter.ts` and
//! `filterTraktDiscoverItems` (`lib/requestFilters/browse.ts`).

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::time::Duration;

use serde_json::{Map, Value};

use super::browsefilter::{external_ratings, matches_browse_filters, BrowseItem, ExternalRatings};
use super::discoverkit::{has_discover_tmdb_id, trakt_tmdb_ids, watched_sets, BrowseFilters};
use super::ratingsenrich::fetch_batch_combined_ratings;
use super::trakt::{Browse, Fail, Run};
use super::traktrecs::{recommendation_page, RecsOptions};
use crate::media::js_string;
use crate::ratings::Title;
use crate::settings::public::truthy;
use crate::traktitems::{js_number, paginate_sorted, plain_page, Paged, SortBy};

/// `MAX_TRAKT_PAGES` / `MAX_TRAKT_DISCOVER_UPSTREAM_PAGES`.
const MAX_UPSTREAM_PAGES: i64 = 10;
/// `ANIME_KEYWORD_ID`.
const ANIME_KEYWORD_ID: f64 = 210_024.0;
/// `ANIME_CACHE_TTL_SECONDS`: a week.
const ANIME_CACHE_TTL: Duration = Duration::from_secs(604_800);
/// `mediaHasKeyword`'s TMDB TTL, a week.
const KEYWORDS_TTL_SECS: u64 = 604_800;
/// The browse metadata TTL, twelve hours.
const BROWSE_METADATA_TTL_SECS: u64 = 43_200;

/// Where a route's raw pages come from.
#[derive(Debug)]
pub(super) enum Upstream {
    /// `getWatchlistItems('me', ...)`.
    Watchlist,
    /// `getHistoryItems`.
    History,
    /// `getChartItems(chart, ...)`.
    Chart(&'static str),
    /// A public list or a user's watchlist by URL.
    List {
        username: Option<String>,
        list_ref: String,
        sort_inside: Option<SortBy>,
    },
    /// `getTraktRecommendationPage`, as the recommendations route's
    /// post-filter loop reads it.
    Recommendations(RecsOptions),
}

/// One raw upstream page.
async fn raw_page(run: &Run<'_>, upstream: &Upstream, trakt_page: i64) -> Result<Paged, Fail> {
    let client = &run.client;
    let fetch = run.media.fetch();
    let per_page = super::trakt::ITEMS_PER_PAGE;
    let paged = match upstream {
        Upstream::Watchlist => {
            client
                .watchlist_items("me", fetch, trakt_page, per_page, run.extended)
                .await?
        }
        Upstream::History => {
            client
                .history_items(fetch, trakt_page, per_page, run.extended)
                .await?
        }
        Upstream::Chart(chart) => {
            client
                .chart_items(chart, fetch, trakt_page, per_page, run.extended)
                .await?
        }
        Upstream::List {
            username,
            list_ref,
            sort_inside,
        } => {
            if list_ref == "watchlist" {
                client
                    .watchlist_items(
                        username.as_deref().unwrap_or(""),
                        fetch,
                        trakt_page,
                        per_page,
                        run.extended,
                    )
                    .await?
            } else {
                client
                    .list_items(
                        username.as_deref(),
                        list_ref,
                        fetch,
                        trakt_page,
                        run.extended,
                        *sort_inside,
                    )
                    .await?
            }
        }
        Upstream::Recommendations(options) => {
            let page = recommendation_page(run, options, trakt_page, per_page).await?;
            return Ok(Paged {
                items: page.items,
                has_more: page.has_more,
            });
        }
    };
    Ok(paged)
}

/// `fetchUpstreamPage`: the raw page through
/// `loadTraktMediaTypeFilteredPage` (the recommendation pages arrive
/// filtered already).
async fn upstream_page(run: &Run<'_>, upstream: &Upstream, trakt_page: i64) -> Result<Paged, Fail> {
    let page = raw_page(run, upstream, trakt_page).await?;
    if matches!(upstream, Upstream::Recommendations(_)) {
        return Ok(page);
    }
    match run.media {
        Browse::Anime => Ok(Paged {
            items: anime_filter(run, page.items, true).await?,
            has_more: page.has_more,
        }),
        Browse::Tv => Ok(Paged {
            items: anime_filter(run, page.items, false).await?,
            has_more: page.has_more,
        }),
        Browse::Movie | Browse::All => Ok(page),
    }
}

/// `needsTraktDiscoverPostFilters(user, query, skipWatchedFilter)`.
pub(super) fn needs_post_filters(run: &Run<'_>, skip_watched: bool) -> bool {
    BrowseFilters::parse(&run.query).any() || (!skip_watched && run.query.truthy("ignoreWatched"))
}

/// `resolveTraktDiscoverPage`.
pub(super) async fn resolve_page(
    run: &Run<'_>,
    upstream: &Upstream,
    page: i64,
    per_page: i64,
    skip_watched: bool,
    list_sort: Option<SortBy>,
) -> Result<Paged, Fail> {
    if needs_post_filters(run, skip_watched) {
        return post_filtered(run, upstream, page, per_page, skip_watched, list_sort).await;
    }
    match run.media {
        Browse::Anime => filtered_pages(run, upstream, page, per_page, true, list_sort).await,
        Browse::Tv => filtered_pages(run, upstream, page, per_page, false, list_sort).await,
        Browse::Movie | Browse::All => upstream_page(run, upstream, page).await,
    }
}

/// `fetchPaginatedTraktAnimeItems` / `fetchPaginatedTraktNonAnimeItems`
/// (`fetchPaginatedTraktFilteredItems`), over pages that were filtered once
/// already, as Node composes them.
async fn filtered_pages(
    run: &Run<'_>,
    upstream: &Upstream,
    page: i64,
    per_page: i64,
    keep_anime: bool,
    sort_by: Option<SortBy>,
) -> Result<Paged, Fail> {
    let needed = usize::try_from(page.saturating_mul(per_page)).unwrap_or(usize::MAX);
    let (filtered, has_more, trakt_page) = fill_pages(
        needed,
        sort_by.is_none(),
        |n| upstream_page(run, upstream, n),
        |batch| anime_filter(run, batch, keep_anime),
    )
    .await?;
    let extra = has_more && trakt_page <= MAX_UPSTREAM_PAGES;
    Ok(page_of(&filtered, page, per_page, sort_by, extra))
}

/// The loop both page fillers share: upstream pages through `filter` until
/// the upstream's own `hasMore` runs out, the page cap, or (`stop_when_full`)
/// `needed` items. A page the media-type or post filters shortened or
/// emptied is not the end of the upstream. Gives the items, the last
/// `hasMore` and the page number the loop stopped on.
async fn fill_pages<F, FFut, G, GFut>(
    needed: usize,
    stop_when_full: bool,
    mut fetch: F,
    mut filter: G,
) -> Result<(Vec<Value>, bool, i64), Fail>
where
    F: FnMut(i64) -> FFut,
    FFut: Future<Output = Result<Paged, Fail>>,
    G: FnMut(Vec<Value>) -> GFut,
    GFut: Future<Output = Result<Vec<Value>, Fail>>,
{
    let mut filtered: Vec<Value> = Vec::new();
    let mut number = 1;
    let mut has_more = false;
    while number <= MAX_UPSTREAM_PAGES {
        let fetched = fetch(number).await?;
        has_more = fetched.has_more;
        if !fetched.items.is_empty() {
            filtered.extend(filter(fetched.items).await?);
        }
        if !has_more {
            break;
        }
        if stop_when_full && filtered.len() >= needed {
            break;
        }
        number += 1;
    }
    Ok((filtered, has_more, number))
}

/// The requested page of collected items, sorted first when asked.
fn page_of(
    items: &[Value],
    page: i64,
    per_page: i64,
    sort_by: Option<SortBy>,
    extra: bool,
) -> Paged {
    sort_by.map_or_else(
        || plain_page(items, page, per_page, extra),
        |sort_by| paginate_sorted(items, page, per_page, sort_by, extra),
    )
}

/// `fetchPaginatedTraktDiscoverWithPostFilters`.
pub(super) async fn post_filtered(
    run: &Run<'_>,
    upstream: &Upstream,
    page: i64,
    per_page: i64,
    skip_watched: bool,
    sort_by: Option<SortBy>,
) -> Result<Paged, Fail> {
    let page = page.max(1);
    let per_page = per_page.max(1);
    let needed = usize::try_from(page.saturating_mul(per_page)).unwrap_or(usize::MAX);
    let (filtered, has_more, upstream_number) = fill_pages(
        needed,
        sort_by.is_none(),
        |n| upstream_page(run, upstream, n),
        |items| filter_page_items(run, items, skip_watched),
    )
    .await?;
    let extra = has_more && upstream_number < MAX_UPSTREAM_PAGES;
    Ok(page_of(&filtered, page, per_page, sort_by, extra))
}

/// `filterTraktDiscoverPageItems`.
async fn filter_page_items(
    run: &Run<'_>,
    items: Vec<Value>,
    skip_watched: bool,
) -> Result<Vec<Value>, Fail> {
    let filtered = filter_discover_items(run, items).await?;
    if skip_watched || !run.query.truthy("ignoreWatched") {
        return Ok(filtered);
    }
    let sets = watched_sets(run.ctx, run.user_id)
        .await
        .map_err(Fail::Error)?;
    Ok(filter_watched(filtered, &sets))
}

/// `filterWatchedTraktItems`.
pub(super) fn filter_watched(items: Vec<Value>, sets: &(Vec<i64>, Vec<i64>)) -> Vec<Value> {
    let movies: HashSet<i64> = sets.0.iter().copied().collect();
    let shows: HashSet<i64> = sets.1.iter().copied().collect();
    items
        .into_iter()
        .filter(|item| {
            let tmdb = item.get("tmdbId");
            if !truthy(tmdb) || js_number(tmdb) <= 0.0 {
                return true;
            }
            let bucket = if item.get("mediaType").and_then(Value::as_str) == Some("movie") {
                &movies
            } else {
                &shows
            };
            !tmdb
                .and_then(Value::as_i64)
                .is_some_and(|id| bucket.contains(&id))
        })
        .collect()
}

/// `mapWithConcurrency(items, 2, f)`: two at a time, in order.
async fn pairwise<T, F, Fut>(items: Vec<Value>, f: F) -> Result<Vec<T>, Fail>
where
    F: Fn(Value) -> Fut,
    Fut: Future<Output = Result<T, Fail>>,
{
    let mut out = Vec::with_capacity(items.len());
    let mut iter = items.into_iter();
    while let Some(a) = iter.next() {
        if let Some(b) = iter.next() {
            let (ra, rb) = tokio::join!(f(a), f(b));
            out.push(ra?);
            out.push(rb?);
        } else {
            out.push(f(a).await?);
        }
    }
    Ok(out)
}

/// `hasAnimeKeyword`: TMDB's keyword list, remembered for a week.
async fn has_anime_keyword(run: &Run<'_>, item: &Value) -> Result<bool, Fail> {
    let tmdb = item.get("tmdbId");
    if !truthy(tmdb) || js_number(tmdb) <= 0.0 {
        return Ok(false);
    }
    let media_type = js_string(item.get("mediaType")).into_owned();
    let id = js_string(tmdb).into_owned();
    let key = format!("anime-keyword:{media_type}:{id}");
    // The `anime-keyword:<type>:<id>` entries of the shared `tmdb` cache.
    let cached = crate::memcache::get(crate::memcache::CacheId::Tmdb, &key);
    if let Some(anime) = cached.and_then(|v| v.as_bool()) {
        return Ok(anime);
    }
    let kind = if media_type == "movie" { "movie" } else { "tv" };
    let data = run
        .ctx
        .state
        .tmdb
        .raw(&format!("/{kind}/{id}/keywords"), &[], KEYWORDS_TTL_SECS)
        .await
        .map_err(|e| {
            Fail::Error(format!(
                "[TMDB] Failed to fetch keywords for {media_type}/{id}: {e:#}"
            ))
        })?;
    let list = match &*data {
        Value::Array(list) => Some(list),
        Value::Object(_) => data
            .get("keywords")
            .and_then(Value::as_array)
            .or_else(|| data.get("results").and_then(Value::as_array)),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => None,
    };
    let is_anime = list.is_some_and(|list| {
        list.iter()
            .any(|k| k.get("id").and_then(Value::as_f64) == Some(ANIME_KEYWORD_ID))
    });
    remember_anime(key, is_anime);
    Ok(is_anime)
}

/// Store a verdict for a week.
fn remember_anime(key: String, is_anime: bool) {
    crate::memcache::set(
        crate::memcache::CacheId::Tmdb,
        key,
        Value::Bool(is_anime),
        ANIME_CACHE_TTL,
    );
}

/// `classifyTraktItemsByAnime`: hydrated ids, then each item's verdict.
async fn classify(run: &Run<'_>, items: Vec<Value>) -> Result<Vec<(Value, bool)>, Fail> {
    let hydrated = if items.iter().any(|item| !truthy(item.get("tmdbId"))) {
        trakt_tmdb_ids(run.ctx, items, "trakt", false)
            .await
            .map_err(Fail::Error)?
    } else {
        items
    };
    pairwise(hydrated, |item| async move {
        let anime = has_anime_keyword(run, &item).await?;
        Ok((item, anime))
    })
    .await
}

/// `filterTraktAnimeItems` (`keep_anime`) or `excludeTraktAnimeItems`.
pub(super) async fn anime_filter(
    run: &Run<'_>,
    items: Vec<Value>,
    keep_anime: bool,
) -> Result<Vec<Value>, Fail> {
    if items.is_empty() {
        return Ok(items);
    }
    Ok(classify(run, items)
        .await?
        .into_iter()
        .filter(|(_, anime)| *anime == keep_anime)
        .map(|(item, _)| item)
        .collect())
}

/// What `getMovieBrowseMetadata` / `getTvBrowseMetadata` give the filter.
struct Metadata {
    vote_average: Option<f64>,
    vote_count: Option<f64>,
    release_date: Option<String>,
    genre_ids: Vec<f64>,
    original_language: Option<String>,
    runtime: Option<f64>,
    status: Option<String>,
    title: String,
}

/// The slim title lookup; `None` where Node's `try` drops the item.
async fn browse_metadata(run: &Run<'_>, tv: bool, id: &str) -> Option<Metadata> {
    let kind = if tv { "tv" } else { "movie" };
    let data = run
        .ctx
        .state
        .tmdb
        .raw(
            &format!("/{kind}/{id}"),
            &[("language", run.locale.clone())],
            BROWSE_METADATA_TTL_SECS,
        )
        .await
        .ok()?;
    if !data.is_object() {
        return None;
    }
    let genre_ids = match data.get("genres") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(genres)) => {
            let mut ids = Vec::with_capacity(genres.len());
            for genre in genres {
                if genre.is_null() {
                    return None;
                }
                if let Some(id) = genre.get("id").and_then(Value::as_f64) {
                    ids.push(id);
                }
            }
            ids
        }
        Some(Value::Bool(_) | Value::Number(_) | Value::String(_) | Value::Object(_)) => {
            return None
        }
    };
    let text = |key: &str| data.get(key).and_then(Value::as_str).map(str::to_owned);
    let (date_key, title_key) = if tv {
        ("first_air_date", "name")
    } else {
        ("release_date", "title")
    };
    let runtime = if tv {
        data.get("episode_run_time")
            .and_then(Value::as_array)
            .and_then(|r| r.first())
            .and_then(Value::as_f64)
    } else {
        data.get("runtime").and_then(Value::as_f64)
    };
    Some(Metadata {
        vote_average: data.get("vote_average").and_then(Value::as_f64),
        vote_count: data.get("vote_count").and_then(Value::as_f64),
        release_date: text(date_key).filter(|d| !d.is_empty()),
        genre_ids,
        original_language: text("original_language"),
        runtime,
        status: if tv { text("status") } else { None },
        title: js_string(data.get(title_key)).into_owned(),
    })
}

/// `needsMdblistFetchForItem`.
fn needs_ratings_fetch(f: &BrowseFilters, community: Option<f64>) -> bool {
    f.needs_non_trakt_mdblist()
        || (f.needs_trakt_rating() && community.is_none_or(|c| !c.is_finite()))
}

/// `releaseYearFromDate`.
fn release_year(date: Option<&str>) -> Option<i64> {
    let year = js_number(Some(&Value::from(
        date?.chars().take(4).collect::<String>(),
    )));
    (year.is_finite() && year > 0.0 && year.fract() == 0.0)
        .then(|| format!("{year:.0}").parse().ok())
        .flatten()
}

/// The ratings of the items the batch fetched, by `mediaType:tmdbId`
/// (`undefined` ratings are left out, as `Map.get` can't tell them apart
/// from a miss).
type RatingsByKey = HashMap<String, Value>;

/// `filterTraktDiscoverItems(items, tmdb, query)`.
async fn filter_discover_items(run: &Run<'_>, items: Vec<Value>) -> Result<Vec<Value>, Fail> {
    let f = BrowseFilters::parse(&run.query);
    if !f.any() || items.is_empty() {
        return Ok(items);
    }
    let configured = !run.ctx.settings.str("/mdblist/apiKey").trim().is_empty();
    let needing: Vec<Value> = items
        .iter()
        .filter(|item| {
            has_discover_tmdb_id(item.get("tmdbId"))
                && needs_ratings_fetch(&f, community_rating(item))
        })
        .map(|item| {
            let mut row = Map::new();
            for key in ["mediaType", "tmdbId", "title", "year"] {
                if let Some(v) = item.get(key) {
                    row.insert(String::from(key), v.clone());
                }
            }
            Value::Object(row)
        })
        .collect();
    let mut by_key = RatingsByKey::new();
    if configured && !needing.is_empty() {
        for row in fetch_batch_combined_ratings(run.ctx, needing)
            .await
            .map_err(Fail::Error)?
        {
            let key = format!(
                "{}:{}",
                js_string(row.get("mediaType")),
                js_string(row.get("tmdbId"))
            );
            if let Some(ratings) = row.get("ratings") {
                by_key.insert(key, ratings.clone());
            }
        }
    }
    let (f, by_key) = (&f, &by_key);
    let kept = pairwise(items, |item| async move {
        let keep = keeps_item(run, f, by_key, &item).await;
        Ok((item, keep))
    })
    .await?;
    Ok(kept
        .into_iter()
        .filter(|(_, keep)| *keep)
        .map(|(item, _)| item)
        .collect())
}

fn community_rating(item: &Value) -> Option<f64> {
    match item.get("traktCommunityRating") {
        None | Some(Value::Null) => None,
        v @ Some(_) => Some(js_number(v)),
    }
}

/// One item's verdict in `filterTraktDiscoverItems`.
async fn keeps_item(run: &Run<'_>, f: &BrowseFilters, by_key: &RatingsByKey, item: &Value) -> bool {
    let tmdb = item.get("tmdbId");
    if !has_discover_tmdb_id(tmdb) {
        return false;
    }
    let tv = item.get("mediaType").and_then(Value::as_str) != Some("movie");
    let year = item.get("year").filter(|y| !y.is_null());
    let mut meta = Metadata {
        vote_average: Some(0.0),
        vote_count: Some(0.0),
        release_date: year.map(|y| format!("{}-01-01", js_string(Some(y)))),
        genre_ids: Vec::new(),
        original_language: None,
        runtime: None,
        status: None,
        title: js_string(item.get("title")).into_owned(),
    };
    let id = js_string(tmdb).into_owned();
    if f.needs_tmdb() {
        let Some(found) = browse_metadata(run, tv, &id).await else {
            return false;
        };
        meta = Metadata {
            release_date: found.release_date.or(meta.release_date),
            ..found
        };
    }
    let community = community_rating(item);
    let mut external: ExternalRatings = [None; 6];
    external[5] = community;
    if needs_ratings_fetch(f, community) {
        let key = format!("{}:{id}", js_string(item.get("mediaType")));
        if let Some(cached) = by_key.get(&key) {
            let mut fetched = external_ratings(Some(cached));
            fetched[5] = community.or(fetched[5]);
            external = fetched;
        } else if let Some(tmdb_id) = tmdb.and_then(Value::as_i64) {
            let title = Title {
                media_type: if tv { "tv" } else { "movie" },
                tmdb_id,
                title: &meta.title,
                year: release_year(meta.release_date.as_deref())
                    .or_else(|| year.and_then(Value::as_i64)),
                release_date: meta.release_date.as_deref(),
                imdb_id: None,
            };
            if let Ok(found) = run
                .ctx
                .state
                .ratings
                .combined(&run.ctx.settings, &title)
                .await
            {
                let mut fetched = external_ratings(found.as_ref());
                fetched[5] = community.or(fetched[5]);
                external = fetched;
            }
        }
    }
    let browse = BrowseItem {
        vote_average: meta.vote_average,
        vote_count: meta.vote_count,
        genre_ids: meta.genre_ids,
        original_language: meta.original_language.as_deref(),
        release_date: meta.release_date.as_deref(),
        runtime: meta.runtime,
        status: meta.status.as_deref(),
        tv,
    };
    matches_browse_filters(&browse, f, &external)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn filters_watched_titles() {
        let items = vec![
            json!({"mediaType": "movie", "tmdbId": 1}),
            json!({"mediaType": "tv", "tmdbId": 1}),
            json!({"mediaType": "movie", "title": "unmapped"}),
        ];
        let kept = filter_watched(items, &(vec![1], vec![]));
        assert_eq!(
            kept.len(),
            2,
            "the watched movie goes, the show and unmapped stay"
        );
    }

    /// `fill_pages` over raw pages of `20` items each, `has_more` on all but
    /// the last, the filter keeping `kept[n - 1]` items of page `n`.
    async fn fill(kept: &[usize], needed: usize) -> (usize, bool, i64) {
        let last = i64::try_from(kept.len()).unwrap_or(i64::MAX);
        let (items, has_more, number) = fill_pages(
            needed,
            true,
            |n| async move {
                let index = usize::try_from(n - 1).unwrap_or(usize::MAX);
                let keep = kept.get(index).copied().unwrap_or(0);
                Ok(Paged {
                    items: (0..20).map(|i| json!({ "keep": i < keep })).collect(),
                    has_more: n < last,
                })
            },
            |batch: Vec<Value>| async move {
                Ok(batch
                    .into_iter()
                    .filter(|item| item.get("keep") == Some(&Value::Bool(true)))
                    .collect())
            },
        )
        .await
        .unwrap_or_default();
        (items.len(), has_more, number)
    }

    #[tokio::test]
    async fn short_filtered_pages_are_not_the_upstream_end() {
        assert_eq!(
            fill(&[19, 20], 20).await,
            (39, false, 2),
            "a page the filter shortened goes on to the next"
        );
        assert_eq!(
            fill(&[0, 0, 5], 20).await,
            (5, false, 3),
            "pages the filter emptied go on too"
        );
        assert_eq!(
            fill(&[20, 20, 20], 20).await,
            (20, true, 1),
            "enough items stop early with more to come"
        );
        assert_eq!(
            fill(&[0; 12], 20).await,
            (0, true, MAX_UPSTREAM_PAGES + 1),
            "the page cap still holds"
        );
    }

    #[test]
    fn release_years() {
        assert_eq!(release_year(Some("2020-05-01")), Some(2020), "year");
        assert_eq!(release_year(Some("abcd")), None, "NaN");
        assert_eq!(release_year(None), None, "null");
    }
}
