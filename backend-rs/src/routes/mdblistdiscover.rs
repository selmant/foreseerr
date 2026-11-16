//! `GET /discover/mdblist/list` and `/discover/mdblist/lists/search`
//! (`server/routes/discover/mdblist.ts`).

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::LazyLock;
use std::time::Duration;

use axum::http::Method;
use serde_json::{json, Map, Value};

use super::discoverkit::{
    annotate_provider_active_requests, omit_unmapped, record_unmapped, resolve_discover_items,
    route_error, Kind, Param, Query,
};
use super::providerkit::{fallback_error, page_body, prepare, provider_row};
use super::{Outcome, Ready, Table};
use crate::jsval;
use crate::mdblist::{
    parse_list_ref, ListError, ListFilter, ListItem, ListMedia, ListPage, ListRef, Mdblist,
    RatingRange, RefError, LIST_SORTS, RATING_FILTERS,
};
use crate::rowcache::RowCache;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/discover/mdblist/lists/search", Method::GET, search),
    ("/api/v1/discover/mdblist/list", Method::GET, list),
    ("/api/v1/discover/mdblist/filters", Method::GET, filters),
];

const SEARCH_PARAMS: [Param; 1] = [("query", Kind::Str)];
const LIST_PARAMS: [Param; 4] = [
    ("url", Kind::Str),
    ("page", Kind::Int),
    ("hideUnmapped", Kind::Bool),
    ("ignoreDiscoverDefaults", Kind::Bool),
];
/// What `MDBList` itself filters and sorts a list by.
const FILTER_PARAMS: [Param; 24] = [
    ("mediaType", Kind::Enum(&["movie", "tv"])),
    ("sort", Kind::Enum(&LIST_SORTS)),
    ("order", Kind::Enum(&["asc", "desc"])),
    ("title", Kind::Str),
    ("genres", Kind::Str),
    ("genreMode", Kind::Enum(&["or", "and"])),
    ("releasedFrom", Kind::Str),
    ("releasedTo", Kind::Str),
    ("scoreMin", Kind::Int),
    ("scoreMax", Kind::Int),
    ("imdbRatingMin", Kind::Int),
    ("imdbRatingMax", Kind::Int),
    ("tmdbRatingMin", Kind::Int),
    ("tmdbRatingMax", Kind::Int),
    ("metacriticMin", Kind::Int),
    ("metacriticMax", Kind::Int),
    ("rtCriticsMin", Kind::Int),
    ("rtCriticsMax", Kind::Int),
    ("rtAudienceMin", Kind::Int),
    ("rtAudienceMax", Kind::Int),
    ("letterboxdMin", Kind::Int),
    ("letterboxdMax", Kind::Int),
    ("malMin", Kind::Int),
    ("malMax", Kind::Int),
];
const MAX_GENRES: usize = 20;
const MAX_TITLE_CHARS: usize = 200;
/// How far a backend rating filter reads into a list, so one page costs
/// at most a handful of list and rating requests against the daily quota.
const SCAN_LIMIT: i64 = 1000;
/// List items read per step of that scan, one batch of rating lookups.
const SCAN_STEP: i64 = 200;
/// Tiles per page.
const PAGE_SIZE: i64 = 20;
const NOT_CONFIGURED: &str = "MDBList API key is not configured";

macro_rules! try_forward {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(why) => return Outcome::forward(why),
        }
    };
}

/// `handleMdblistDiscoverRouteError`.
fn list_error(ctx: &Ready<'_>, error: ListError, fallback: &str) -> Outcome {
    match error {
        ListError::NotConfigured => route_error(ctx, 400, NOT_CONFIGURED, None),
        ListError::NotFound => route_error(ctx, 404, "MDBList list not found", None),
        ListError::Unavailable(message) => {
            let status = if message.to_ascii_lowercase().contains("quota") {
                429
            } else {
                503
            };
            route_error(ctx, status, &message, None)
        }
        ListError::Internal(why) => fallback_error(ctx, fallback, &why),
        ListError::Forward(why) => Outcome::forward(why),
    }
}

/// `GET /discover/mdblist/lists/search`.
fn search<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let (_, _, query) = try_forward!(prepare(ctx, &[&SEARCH_PARAMS], &[]).await);
        if !query.has("query") {
            return Outcome::forward(String::from("query is required; the validator answers"));
        }
        let mdblist = Mdblist::new(&ctx.state.outbound, &ctx.settings);
        if !mdblist.is_configured() {
            return route_error(ctx, 400, NOT_CONFIGURED, None);
        }
        let text = jsval::trim(&query.text("query")).to_owned();
        let results = if text.is_empty() {
            Vec::new()
        } else {
            match mdblist.search_lists(&text).await {
                Ok(results) => results,
                Err(e) => return list_error(ctx, e, "Unable to search MDBList lists."),
            }
        };
        let mut body = Map::new();
        body.insert(String::from("results"), Value::Array(results));
        ctx.json(&Value::Object(body))
    })
}

/// `YYYY-MM-DD`.
fn is_date(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
}

/// The list filters a request asks for, or the 400 message.
fn list_filter(query: &Query) -> Result<ListFilter, String> {
    let text = |key: &str| {
        query
            .has(key)
            .then(|| jsval::trim(&query.text(key)).to_owned())
            .filter(|t| !t.is_empty())
    };
    let pick = |key: &str, allowed: &[&'static str]| {
        text(key).and_then(|t| allowed.iter().copied().find(|a| *a == t))
    };
    let media = match text("mediaType").as_deref() {
        Some("movie") => Some(ListMedia::Movie),
        Some("tv") => Some(ListMedia::Show),
        _ => None,
    };
    let title = text("title");
    if title
        .as_ref()
        .is_some_and(|t| t.chars().count() > MAX_TITLE_CHARS)
    {
        return Err(format!(
            "title must be at most {MAX_TITLE_CHARS} characters"
        ));
    }
    let mut genres: Vec<String> = Vec::new();
    for slug in text("genres").unwrap_or_default().split(',') {
        let slug = slug.trim().to_ascii_lowercase();
        if slug.is_empty() || genres.contains(&slug) {
            continue;
        }
        if !slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Err(format!("{slug} is not an MDBList genre"));
        }
        genres.push(slug);
    }
    if genres.len() > MAX_GENRES {
        return Err(format!("pick at most {MAX_GENRES} genres"));
    }
    let date = |key: &str| match text(key) {
        Some(d) if !is_date(&d) => Err(format!("{key} must be a YYYY-MM-DD date")),
        d => Ok(d),
    };
    let released_from = date("releasedFrom")?;
    let released_to = date("releasedTo")?;
    let mut ratings = Vec::new();
    for (prefix, source) in RATING_FILTERS {
        let bound = |suffix: &str| -> Result<Option<u8>, String> {
            let key = format!("{prefix}{suffix}");
            query.get(&key).map_or(Ok(None), |v| {
                // Digits only, so `Number()` and the integer parse agree.
                jsval::string_of(Some(v))
                    .parse::<u8>()
                    .ok()
                    .filter(|n| *n <= 100)
                    .map(Some)
                    .ok_or_else(|| format!("{key} must be a whole number from 0 to 100"))
            })
        };
        let (min, max) = (bound("Min")?, bound("Max")?);
        if min.is_some() || max.is_some() {
            ratings.push(RatingRange { source, min, max });
        }
    }
    Ok(ListFilter {
        media,
        sort: pick("sort", &LIST_SORTS),
        order: pick("order", &["asc", "desc"]),
        title,
        genres,
        all_genres: text("genreMode").as_deref() == Some("and"),
        released_from,
        released_to,
        ratings,
    })
}

/// `GET /discover/mdblist/filters`: the genre catalog and whether the
/// account can use rating filters.
fn filters<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(prepare(ctx, &[], &[]).await);
        let mdblist = Mdblist::new(&ctx.state.outbound, &ctx.settings);
        if !mdblist.is_configured() {
            return route_error(ctx, 400, NOT_CONFIGURED, None);
        }
        let genres = match mdblist.genres().await {
            Ok(genres) => genres,
            Err(e) => return list_error(ctx, e, "Unable to retrieve MDBList genres."),
        };
        let supporter = mdblist.supporter().await;
        ctx.json(&json!({
            "genres": genres,
            "sorts": LIST_SORTS,
            "supporter": supporter,
        }))
    })
}

const LIST_FAILED: &str = "Unable to retrieve MDBList list.";

/// `GET /discover/mdblist/list`.
fn list<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let (_, _, query) = try_forward!(
            prepare(ctx, &[&LIST_PARAMS, &FILTER_PARAMS], &[("page", json!(1))]).await
        );
        if !query.has("url") {
            return Outcome::forward(String::from("url is required; the validator answers"));
        }
        let mdblist = Mdblist::new(&ctx.state.outbound, &ctx.settings);
        if !mdblist.is_configured() {
            return route_error(ctx, 400, NOT_CONFIGURED, None);
        }
        let url = jsval::trim(&query.text("url")).to_owned();
        if url.is_empty() {
            return route_error(ctx, 400, "url query parameter is required", None);
        }
        let page = super::providerkit::page(&query);
        let filter = match list_filter(&query) {
            Ok(filter) => filter,
            Err(message) => return route_error(ctx, 400, &message, None),
        };
        let local = rates_locally(&mdblist, &filter).await;
        let list_ref = match parse_list_ref(&url) {
            Ok(r) => r,
            Err(RefError::Invalid(message)) => return route_error(ctx, 400, &message, None),
            Err(RefError::Forward(why)) => return Outcome::forward(why),
        };
        let stored = provider_row(
            ctx,
            &LIST_ROWS,
            &format!(
                "mdblist/list|{url}|{}{}|page:{page}",
                filter.key(),
                if local { "|local" } else { "" }
            ),
            Duration::from_secs(crate::mdblist::LIST_ITEMS_TTL_SECS),
            Box::pin(list_tiles(ctx, &mdblist, &list_ref, page, &filter, local)),
            refresh_list,
        )
        .await;
        let page_data = match stored {
            Ok(stored) => stored,
            Err(ListFail::List(e)) => return list_error(ctx, e, LIST_FAILED),
            Err(ListFail::Mapping(why)) => return fallback_error(ctx, LIST_FAILED, &why),
        };
        let source = json!({ "discoverSource": "mdblist/list" });
        if let Err(why) = record_unmapped(ctx, &page_data.tiles, source).await {
            return fallback_error(ctx, LIST_FAILED, &why);
        }
        let annotated = annotate_provider_active_requests(ctx, page_data.tiles.clone()).await;
        let results = omit_unmapped(annotated, query.truthy("hideUnmapped"));
        ctx.json(&page_body(
            page,
            page_data.has_more,
            results,
            &[
                ("title", Value::from(page_data.title.as_str())),
                ("ratingsFilteredLocally", Value::Bool(local)),
            ],
        ))
    })
}

/// A list page as stored: before the sightings, the request annotations
/// and `hideUnmapped` every serve applies.
#[derive(Debug, Clone)]
struct ListRow {
    title: String,
    has_more: bool,
    tiles: Vec<Value>,
}

/// Why a list page could not be computed, as the route answers it.
#[derive(Debug, Clone)]
enum ListFail {
    /// The `MDBList` call failed.
    List(ListError),
    /// Resolving the tiles failed (or, refreshing, the request no longer
    /// reads as it did).
    Mapping(String),
}

static LIST_ROWS: LazyLock<RowCache<ListRow, ListFail>> = LazyLock::new(RowCache::new);

/// A list page computed: the `MDBList` page, its tiles resolved.
async fn list_tiles(
    ctx: &Ready<'_>,
    mdblist: &Mdblist,
    list_ref: &ListRef,
    page: i64,
    filter: &ListFilter,
    local: bool,
) -> Result<ListRow, ListFail> {
    let page_data = if local {
        rated_page(mdblist, list_ref, page, filter).await
    } else {
        let offset = crate::jsnum::from_i64(page.saturating_sub(1).saturating_mul(PAGE_SIZE));
        mdblist
            .list_items(list_ref, PAGE_SIZE, offset, filter)
            .await
    }
    .map_err(ListFail::List)?;
    let items: Vec<Value> = page_data.items.iter().map(tile).collect();
    let tiles = resolve_discover_items(ctx, items, json!({ "discoverSource": "mdblist/list" }))
        .await
        .map_err(ListFail::Mapping)?;
    Ok(ListRow {
        title: page_data.title,
        has_more: page_data.has_more,
        tiles,
    })
}

/// A stale list page computed again from its request.
fn refresh_list<'a>(
    ctx: &'a Ready<'a>,
) -> Pin<Box<dyn Future<Output = Result<ListRow, ListFail>> + Send + 'a>> {
    Box::pin(async move {
        let (_, _, query) = prepare(ctx, &[&LIST_PARAMS, &FILTER_PARAMS], &[("page", json!(1))])
            .await
            .map_err(|why| ListFail::Mapping(why.why))?;
        let filter = list_filter(&query).map_err(ListFail::Mapping)?;
        let url = jsval::trim(&query.text("url")).to_owned();
        let list_ref = parse_list_ref(&url)
            .map_err(|e| ListFail::Mapping(format!("the list reference no longer reads: {e:?}")))?;
        let mdblist = Mdblist::new(&ctx.state.outbound, &ctx.settings);
        let local = rates_locally(&mdblist, &filter).await;
        list_tiles(
            ctx,
            &mdblist,
            &list_ref,
            super::providerkit::page(&query),
            &filter,
            local,
        )
        .await
    })
}

/// Whether Foreseerr checks the rating ranges itself: `MDBList` only
/// filters by ratings for supporters, so anything short of a confirmed
/// supporter plan is checked here (slower, never wrong).
async fn rates_locally(mdblist: &Mdblist, filter: &ListFilter) -> bool {
    filter.has_ratings() && mdblist.supporter().await != Some(true)
}

/// A page of the list with the rating ranges checked here: `MDBList`
/// applies the other filters and the order, and the list is read in
/// [`SCAN_STEP`] steps (each one batch of rating lookups, cached per
/// title) until the page and one more match are found, the list ends, or
/// [`SCAN_LIMIT`] items were read.
async fn rated_page(
    mdblist: &Mdblist,
    list_ref: &ListRef,
    page: i64,
    filter: &ListFilter,
) -> Result<ListPage, ListError> {
    let upstream = filter.without_ratings();
    let page = page.max(1);
    let start =
        usize::try_from(page.saturating_sub(1).saturating_mul(PAGE_SIZE)).unwrap_or(usize::MAX);
    let size = usize::try_from(PAGE_SIZE).unwrap_or(20);
    let wanted = start.saturating_add(size).saturating_add(1);
    let mut kept: Vec<ListItem> = Vec::new();
    let mut title = String::new();
    let mut offset = 0;
    while offset < SCAN_LIMIT {
        let step = mdblist
            .list_items(
                list_ref,
                SCAN_STEP,
                crate::jsnum::from_i64(offset),
                &upstream,
            )
            .await?;
        title = step.title;
        let ratings = step_ratings(mdblist, &step.items).await?;
        kept.extend(step.items.into_iter().filter(|item| {
            filter.passes_ratings(rating_key(item).and_then(|key| ratings.get(&key)))
        }));
        offset += SCAN_STEP;
        if !step.has_more || kept.len() >= wanted {
            break;
        }
    }
    let has_more = kept.len() > start.saturating_add(size);
    Ok(ListPage {
        title,
        items: kept.into_iter().skip(start).take(size).collect(),
        has_more,
    })
}

/// `(media type, TMDB id)` for a list item `MDBList` can rate.
fn rating_key(item: &ListItem) -> Option<(&'static str, i64)> {
    let id = item
        .tmdb_id
        .filter(|n| n.is_finite() && *n > 0.0 && n.fract() == 0.0)?;
    Some((item.media_type?, format!("{id:.0}").parse().ok()?))
}

/// The media payloads of one scan step, by [`rating_key`]. A lookup
/// that could not be made fails the page rather than filtering every
/// title out (and caching that empty page).
async fn step_ratings(
    mdblist: &Mdblist,
    items: &[ListItem],
) -> Result<HashMap<(&'static str, i64), Value>, ListError> {
    let mut out = HashMap::new();
    for kind in ["movie", "tv"] {
        let ids: Vec<(i64, u64)> = items
            .iter()
            .filter_map(rating_key)
            .filter(|(k, _)| *k == kind)
            .map(|(_, id)| (id, crate::ratings::mdblist_ttl(None).as_secs()))
            .collect();
        if ids.is_empty() {
            continue;
        }
        for (id, payload) in mdblist.batch_ratings_strict(kind, &ids).await? {
            if let Some(payload) = payload {
                out.insert((kind, id), payload);
            }
        }
    }
    Ok(out)
}

/// The route's `mapItems` for one list item.
fn tile(item: &ListItem) -> Value {
    let tmdb = item.tmdb_id.filter(|n| n.is_finite() && *n > 0.0);
    let source_id = tmdb.map_or_else(
        || {
            item.imdb_id.clone().unwrap_or_else(|| {
                item.tvdb_id
                    .map_or_else(|| item.title.clone(), jsval::number_string)
            })
        },
        jsval::number_string,
    );
    let source_url = match (&item.imdb_id, tmdb, item.media_type) {
        (Some(imdb), _, _) => Some(format!("https://www.imdb.com/title/{imdb}")),
        (None, Some(id), Some(kind)) => Some(format!(
            "https://www.themoviedb.org/{kind}/{}",
            jsval::number_string(id)
        )),
        _ => None,
    };
    let from = match (&item.imdb_id, item.tvdb_id) {
        (Some(imdb), _) => Some(json!({"ns": "imdb", "id": imdb})),
        (None, Some(series)) => {
            Some(json!({"ns": "tvdb_show", "id": jsval::number_string(series)}))
        }
        (None, None) => None,
    };
    let mut out = Map::new();
    out.insert(String::from("id"), jsval::num(item.tmdb_id.unwrap_or(0.0)));
    out.insert(
        String::from("ratingKey"),
        Value::from(format!(
            "mdblist-{}-{source_id}",
            item.media_type.unwrap_or("unknown")
        )),
    );
    if let Some(id) = tmdb {
        out.insert(String::from("tmdbId"), jsval::num(id));
    }
    if let Some(kind) = item.media_type {
        out.insert(String::from("mediaType"), Value::from(kind));
    }
    out.insert(String::from("title"), Value::from(item.title.as_str()));
    out.insert(String::from("source"), Value::from("mdblist"));
    out.insert(String::from("sourceId"), Value::from(source_id));
    if let Some(url) = source_url {
        out.insert(String::from("sourceUrl"), Value::from(url));
    }
    if let Some(from) = from {
        out.insert(String::from("from"), from);
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(pairs: &Value) -> Query {
        Query::from_map(pairs.as_object().cloned().unwrap_or_default())
    }

    #[test]
    fn filters_parse() {
        let none = list_filter(&query(&json!({"url": "x", "page": 1})));
        assert_eq!(none, Ok(ListFilter::default()), "no filters");
        let full = list_filter(&query(&json!({
            "mediaType": "tv", "sort": "imdbrating", "order": "desc",
            "title": "  star ", "genres": "Drama, anime-isekai,drama", "genreMode": "and",
            "releasedFrom": "2020-01-01", "imdbRatingMin": 70, "malMax": 90,
        })));
        assert_eq!(
            full,
            Ok(ListFilter {
                media: Some(ListMedia::Show),
                sort: Some("imdbrating"),
                order: Some("desc"),
                title: Some(String::from("star")),
                genres: vec![String::from("drama"), String::from("anime-isekai")],
                all_genres: true,
                released_from: Some(String::from("2020-01-01")),
                released_to: None,
                ratings: vec![
                    RatingRange {
                        source: "imdbrating",
                        min: Some(70),
                        max: None
                    },
                    RatingRange {
                        source: "malrating",
                        min: None,
                        max: Some(90)
                    },
                ],
            })
        );
        assert!(list_filter(&query(&json!({"releasedTo": "2020-1-1"}))).is_err());
        assert!(list_filter(&query(&json!({"genres": "sci fi"}))).is_err());
        assert!(list_filter(&query(&json!({"scoreMin": 101}))).is_err());
    }

    #[test]
    fn tiles() {
        let item = ListItem {
            tmdb_id: Some(550.0),
            media_type: Some("movie"),
            title: String::from("Fight Club"),
            rank: Some(1.0),
            imdb_id: Some(String::from("tt0137523")),
            tvdb_id: None,
        };
        assert_eq!(
            tile(&item),
            json!({"id": 550, "ratingKey": "mdblist-movie-550", "tmdbId": 550, "mediaType": "movie", "title": "Fight Club",
                   "source": "mdblist", "sourceId": "550", "sourceUrl": "https://www.imdb.com/title/tt0137523",
                   "from": {"ns": "imdb", "id": "tt0137523"}}),
            "imdb-backed tile"
        );
        let show = ListItem {
            tmdb_id: None,
            media_type: None,
            title: String::from("Show"),
            rank: None,
            imdb_id: None,
            tvdb_id: Some(81189.0),
        };
        assert_eq!(
            tile(&show),
            json!({"id": 0, "ratingKey": "mdblist-unknown-81189", "title": "Show", "source": "mdblist",
                   "sourceId": "81189", "from": {"ns": "tvdb_show", "id": "81189"}}),
            "untyped tvdb tile"
        );
    }
}
