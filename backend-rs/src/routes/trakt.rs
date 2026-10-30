//! `GET /api/v1/discover/trakt/*` (`server/routes/discover/trakt.ts`).
//!
//! Everything that would make the answer depend on something not ported
//! (`MDBList` enrichment while it is a stub,
//! query strings the `OpenAPI` validator might reject) gets the fallback
//! answer before the first call into the mapping layer; after that,
//! failures are this route's own error answers.

use std::future::Future;
use std::pin::Pin;
use std::sync::LazyLock;
use std::time::Duration;

use axum::http::Method;
use serde_json::{Map, Value};

use super::discoverkit::{
    annotate_provider_active_requests, has_discover_tmdb_id, omit_unmapped, record_unmapped,
    route_error, trakt_tmdb_ids, with_tmdb_posters, BrowseFilters, Kind, Param, Query,
    RATING_PARAMS,
};
use super::providerkit::{provider_row, Recompute};
use super::ratingsenrich::{enrich_results_with_ratings, fetch_batch_combined_ratings};
use super::traktpages::{needs_post_filters, post_filtered, resolve_page, Upstream};
use super::traktrecs::{recommendation_page, RecsOptions};
use super::{Outcome, Ready, Table};
use crate::db::Bind;
use crate::media::js_string;
use crate::rowcache::RowCache;
use crate::settings::public::truthy;
use crate::trakt::{app_credentials, FetchType, TraktClient, TraktError, UserRefresh};
use crate::traktitems::{js_number_of_text, parse_list_url, ListUrlError, SortBy};

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    (
        "/api/v1/discover/trakt/recommendations",
        Method::GET,
        recommendations,
    ),
    ("/api/v1/discover/trakt/watchlist", Method::GET, watchlist),
    ("/api/v1/discover/trakt/history", Method::GET, history),
    ("/api/v1/discover/trakt/trending", Method::GET, trending),
    ("/api/v1/discover/trakt/popular", Method::GET, popular),
    (
        "/api/v1/discover/trakt/anticipated",
        Method::GET,
        anticipated,
    ),
    ("/api/v1/discover/trakt/lists", Method::GET, lists),
    (
        "/api/v1/discover/trakt/lists/search",
        Method::GET,
        lists_search,
    ),
    ("/api/v1/discover/trakt/list", Method::GET, list),
];

/// The page size of every Trakt discover row.
pub(super) const ITEMS_PER_PAGE: i64 = 20;

const MEDIA_TYPES: &[&str] = &["movie", "tv", "all", "anime"];

const PAGE_TYPE: [Param; 2] = [("page", Kind::Int), ("type", Kind::Enum(MEDIA_TYPES))];

/// `DiscoverGenre` ... `DiscoverVoteCountLte`.
const BROWSE: [Param; 10] = [
    ("genre", Kind::Str),
    ("language", Kind::Str),
    ("primaryReleaseDateGte", Kind::Str),
    ("primaryReleaseDateLte", Kind::Str),
    ("firstAirDateGte", Kind::Str),
    ("firstAirDateLte", Kind::Str),
    ("voteAverageGte", Kind::Num),
    ("voteAverageLte", Kind::Num),
    ("voteCountGte", Kind::Num),
    ("voteCountLte", Kind::Num),
];

/// `DiscoverIgnoreWatched`, `DiscoverIgnoreDefaults`, `DiscoverHideUnmapped`.
const TAIL: [Param; 3] = [
    ("ignoreWatched", Kind::Bool),
    ("ignoreDiscoverDefaults", Kind::Bool),
    ("hideUnmapped", Kind::Bool),
];

const RECS: [Param; 2] = [
    ("ignoreCollected", Kind::Bool),
    ("ignoreWatchlisted", Kind::Bool),
];

const LIST: [Param; 5] = [
    ("url", Kind::Str),
    ("sort", Kind::Enum(&["added", "released"])),
    ("withRuntimeGte", Kind::Num),
    ("withRuntimeLte", Kind::Num),
    ("status", Kind::Str),
];

const SEARCH: [Param; 1] = [("query", Kind::Str)];

/// `TraktBrowseMediaType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Browse {
    Movie,
    Tv,
    Anime,
    All,
}

impl Browse {
    /// `parseTraktMediaTypeQuery`.
    fn parse(query: &Query) -> Self {
        match query.get("type").and_then(Value::as_str) {
            Some("movie") => Self::Movie,
            Some("tv") => Self::Tv,
            Some("anime") => Self::Anime,
            _ => Self::All,
        }
    }

    /// `toTraktFetchMediaType`.
    pub(super) const fn fetch(self) -> FetchType {
        match self {
            Self::Movie => FetchType::Movie,
            Self::Tv => FetchType::Tv,
            Self::Anime | Self::All => FetchType::All,
        }
    }

    pub(super) const fn as_str(self) -> &'static str {
        match self {
            Self::Movie => "movie",
            Self::Tv => "tv",
            Self::Anime => "anime",
            Self::All => "all",
        }
    }
}

/// What a failing step means for the route.
#[derive(Debug, Clone)]
pub(super) enum Fail {
    /// A Trakt client error, classified as Node's handler does.
    Trakt(TraktError),
    /// Anything else: the route's 500.
    Error(String),
}

impl From<TraktError> for Fail {
    fn from(e: TraktError) -> Self {
        Self::Trakt(e)
    }
}

/// One request's Trakt client, query and settings.
pub(super) struct Run<'a> {
    pub(super) ctx: &'a Ready<'a>,
    pub(super) client: TraktClient,
    pub(super) query: Query,
    pub(super) user_id: i64,
    pub(super) media: Browse,
    pub(super) extended: &'static str,
    /// `TheMovieDb`'s `this.locale`: `main.locale || 'en'`.
    pub(super) locale: String,
}

/// The request after sign-in, query validation and the router's filter
/// defaults.
struct Start {
    user_id: i64,
    query: Query,
}

/// Sign-in, the query, the provider and (for item rows) the `MDBList`
/// checks; an `Err` sends the request to Node.
async fn start(
    ctx: &Ready<'_>,
    params: &[&[Param]],
    defaults: &[(&str, Value)],
    items: bool,
) -> Result<Start, super::Fallback> {
    let user = ctx.authenticated(0)?;
    let query = Query::of(ctx, params, defaults)?;
    let profile = ctx
        .state
        .db
        .user_profile(user.id)
        .await
        .map_err(|e| format!("database: {e:#}"))?
        .ok_or_else(|| String::from("the user is gone"))?;
    let stored = profile
        .settings
        .as_ref()
        .and_then(|s| s.discover_filter_defaults.as_deref());
    let query = query.with_filter_defaults(stored);
    if items {
        if enrich_results_with_ratings(ctx, Vec::new(), Some(&query), true)
            .await
            .is_err()
        {
            return Err(String::from("MDBList enrichment isn't available here").into());
        }
        let f = BrowseFilters::parse(&query);
        let configured = !ctx.settings.str("/mdblist/apiKey").trim().is_empty();
        if configured
            && f.any()
            && f.needs_mdblist()
            && fetch_batch_combined_ratings(ctx, Vec::new()).await.is_err()
        {
            return Err(String::from("batch MDBList ratings aren't available here").into());
        }
    }
    Ok(Start {
        user_id: user.id,
        query,
    })
}

fn item_defaults() -> [(&'static str, Value); 3] {
    [
        ("page", Value::from(1)),
        ("type", Value::from("all")),
        ("includeNoRating", Value::Bool(true)),
    ]
}

/// `createTraktUserClient(userId)`: a direct Trakt link, or the Better
/// Trakt token bridge. The outer `Err` (a database failure) sends the
/// request to Node.
async fn user_client(
    ctx: &Ready<'_>,
    user_id: i64,
) -> Result<Result<TraktClient, TraktError>, String> {
    if crate::traktbridge::enabled(&ctx.settings) {
        return Ok(crate::traktbridge::user_client(ctx.state, &ctx.settings, user_id).await);
    }
    let (client_id, _secret) = match app_credentials(&ctx.settings) {
        Ok(credentials) => credentials,
        Err(e) => return Ok(Err(e)),
    };
    let rows = ctx
        .state
        .db
        .rows(
            r#"SELECT "traktAccessToken" AS "access", "traktRefreshToken" AS "refresh",
               CAST("traktTokenExpiresAt" AS TEXT) AS "expires"
               FROM "user_settings" WHERE "userId" = ?1"#,
            &[Bind::Int(user_id)],
        )
        .await
        .map_err(|e| format!("reading the Trakt tokens failed: {e:#}"))?;
    let row = rows.first();
    let text = |key: &str| {
        row.and_then(|r| r.get(key))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let (Some(access), Some(refresh)) = (text("access"), text("refresh")) else {
        return Ok(Err(TraktError::NotLinked));
    };
    let expires_at = text("expires").map_or(0.0, |t| js_number_of_text(&t));
    let refresher = UserRefresh { user_id };
    Ok(Ok(TraktClient::user(
        ctx.state.outbound.clone(),
        client_id,
        access,
        refresh,
        expires_at,
        refresher,
    )))
}

/// `traktClientForRequest`: the user's client, else the app client.
async fn client_for_request(
    ctx: &Ready<'_>,
    user_id: i64,
) -> Result<Result<TraktClient, TraktError>, String> {
    match user_client(ctx, user_id).await? {
        Err(TraktError::NotLinked) => Ok(app_credentials(&ctx.settings)
            .map(|(id, _)| TraktClient::app(ctx.state.outbound.clone(), id))),
        other => Ok(other),
    }
}

/// `traktExtendedForBrowseQuery`.
fn extended_for(query: &Query) -> &'static str {
    if BrowseFilters::parse(query).needs_trakt_rating() {
        "full"
    } else {
        "min"
    }
}

fn locale(ctx: &Ready<'_>) -> String {
    let locale = ctx.settings.str("/main/locale");
    if locale.is_empty() {
        String::from("en")
    } else {
        locale.to_owned()
    }
}

fn run<'a>(
    ctx: &'a Ready<'a>,
    client: TraktClient,
    start: Start,
    extended: &'static str,
) -> Run<'a> {
    Run {
        ctx,
        client,
        media: Browse::parse(&start.query),
        query: start.query,
        user_id: start.user_id,
        extended,
        locale: locale(ctx),
    }
}

/// The answer, or the error as `handleTraktDiscoverRouteError` shapes it.
fn finish(ctx: &Ready<'_>, fallback: &str, result: Result<Value, Fail>) -> Outcome {
    match result {
        Ok(value) => ctx.json(&value),
        Err(Fail::Trakt(e)) => {
            if let Some((status, retry)) = e.route_status() {
                let retry = retry.map(|s| f64::from(u32::try_from(s).unwrap_or(u32::MAX)));
                return route_error(ctx, status, &e.message(), retry);
            }
            tracing::error!(error_message = %e.message(), "{fallback}");
            route_error(ctx, 500, fallback, None)
        }
        Err(Fail::Error(message)) => {
            tracing::error!(error_message = %message, "{fallback}");
            route_error(ctx, 500, fallback, None)
        }
    }
}

/// `traktSourceUrl`.
fn source_url(media_type: &str, permalink: &Value) -> String {
    let kind = if media_type == "movie" {
        "movies"
    } else {
        "shows"
    };
    format!("https://trakt.tv/{kind}/{}", js_string(Some(permalink)))
}

/// `mapTraktItems`.
pub(super) fn map_trakt_items(items: &[Value]) -> Vec<Value> {
    items
        .iter()
        .map(|item| {
            let tmdb = item.get("tmdbId");
            let mapped = has_discover_tmdb_id(tmdb);
            let slug = item.get("traktSlug").filter(|v| truthy(Some(v)));
            let trakt = item.get("traktId").filter(|v| truthy(Some(v)));
            let source_id = slug.cloned().or_else(|| {
                trakt
                    .map(|t| Value::from(js_string(Some(t)).into_owned()))
                    .or_else(|| {
                        if mapped {
                            Some(Value::from(js_string(tmdb).into_owned()))
                        } else {
                            item.get("title").cloned()
                        }
                    })
            });
            let media_type = js_string(item.get("mediaType")).into_owned();
            let mut out = Map::new();
            let id = [tmdb, item.get("traktId")]
                .into_iter()
                .flatten()
                .find(|v| !v.is_null())
                .cloned()
                .unwrap_or_else(|| Value::from(0));
            out.insert(String::from("id"), id);
            out.insert(
                String::from("ratingKey"),
                Value::from(format!(
                    "trakt-{media_type}-{}",
                    js_string(source_id.as_ref())
                )),
            );
            if mapped {
                if let Some(tmdb) = tmdb {
                    out.insert(String::from("tmdbId"), tmdb.clone());
                }
            }
            if let Some(kind) = item.get("mediaType") {
                out.insert(String::from("mediaType"), kind.clone());
            }
            if let Some(title) = item.get("title") {
                out.insert(String::from("title"), title.clone());
            }
            out.insert(String::from("source"), Value::from("trakt"));
            if let Some(source_id) = &source_id {
                out.insert(String::from("sourceId"), source_id.clone());
            }
            if let Some(permalink) = slug.or(trakt) {
                out.insert(
                    String::from("sourceUrl"),
                    Value::from(source_url(&media_type, permalink)),
                );
            }
            let mut state = Map::new();
            state.insert(
                String::from("state"),
                Value::from(if mapped { "mapped" } else { "unmapped" }),
            );
            state.insert(String::from("namespace"), Value::from("trakt"));
            if let Some(source_id) = source_id.filter(|v| truthy(Some(v))) {
                state.insert(String::from("externalId"), source_id);
            }
            out.insert(String::from("mappingState"), Value::Object(state));
            Value::Object(out)
        })
        .collect()
}

/// `mapFilteredTraktItems(items, { skipPostFilters: true })`.
pub(super) async fn map_filtered(run: &Run<'_>, items: Vec<Value>) -> Result<Vec<Value>, Fail> {
    let tiles = trakt_tiles(run, items).await?;
    serve_tiles(run, tiles).await
}

/// `traktTiles`: the tiles of `items`, resolved, rated and drawn, the
/// part of a row worth storing.
async fn trakt_tiles(run: &Run<'_>, items: Vec<Value>) -> Result<Vec<Value>, Fail> {
    let ctx = run.ctx;
    let hydrated = if items.is_empty() {
        items
    } else {
        trakt_tmdb_ids(ctx, items, "trakt", true)
            .await
            .map_err(Fail::Error)?
    };
    let enriched =
        enrich_results_with_ratings(ctx, map_trakt_items(&hydrated), Some(&run.query), true)
            .await
            .map_err(Fail::Error)?;
    with_tmdb_posters(ctx, enriched).await.map_err(Fail::Error)
}

/// `serveTraktTiles`: what every serve does with stored tiles
/// (sightings, `hideUnmapped`, requests).
async fn serve_tiles(run: &Run<'_>, mapped: Vec<Value>) -> Result<Vec<Value>, Fail> {
    let ctx = run.ctx;
    if mapped
        .iter()
        .any(|item| !has_discover_tmdb_id(item.get("tmdbId")))
    {
        let mut options = Map::new();
        options.insert(String::from("namespace"), Value::from("trakt"));
        options.insert(String::from("discoverSource"), Value::from("trakt"));
        record_unmapped(ctx, &mapped, Value::Object(options))
            .await
            .map_err(Fail::Error)?;
    }
    let hide = run.query.truthy("hideUnmapped");
    Ok(annotate_provider_active_requests(ctx, omit_unmapped(mapped, hide)).await)
}

/// A chart or list page as stored: before the sightings, `hideUnmapped`
/// and the request annotations every serve applies.
#[derive(Debug, Clone)]
struct TraktRow {
    has_more: bool,
    /// The list's title (the list route only).
    title: Option<Value>,
    tiles: Vec<Value>,
}

static TRAKT_ROWS: LazyLock<RowCache<TraktRow, Fail>> = LazyLock::new(RowCache::new);

/// The freshness of a stored page: the Trakt client's own page cache.
const ROW_FRESH: Duration = Duration::from_secs(crate::trakt::GET_CACHE_TTL);

/// Where Node mounts `traktDiscoverRoutes`.
const MOUNT: &str = "/api/v1/discover/trakt";

/// `traktRowKey`: the user (their token, locale and region answer) and
/// every query key but `hideUnmapped`, which only applies on serve.
fn row_key(run: &Run<'_>) -> String {
    format!(
        "trakt{}|user:{}|{}",
        run.ctx.path_below(MOUNT),
        run.user_id,
        run.query.row_key()
    )
}

/// The stored page of `run`, then what every serve does with it.
async fn stored_page<Fut>(
    run: &Run<'_>,
    page: i64,
    compute: Fut,
    recompute: Recompute<TraktRow, Fail>,
) -> Result<Value, Fail>
where
    Fut: Future<Output = Result<TraktRow, Fail>> + Send,
{
    let stored = provider_row(
        run.ctx,
        &TRAKT_ROWS,
        &row_key(run),
        ROW_FRESH,
        compute,
        recompute,
    )
    .await?;
    let results = serve_tiles(run, stored.tiles.clone()).await?;
    let mut body = page_body(page, stored.has_more, results);
    if let Some(title) = &stored.title {
        body.insert(String::from("title"), title.clone());
    }
    Ok(Value::Object(body))
}

/// A chart page computed: the upstream pages, then the tiles.
async fn chart_tiles(
    run: &Run<'_>,
    upstream: &Upstream,
    page: i64,
    skip_watched: bool,
) -> Result<TraktRow, Fail> {
    let paged = resolve_page(run, upstream, page, ITEMS_PER_PAGE, skip_watched, None).await?;
    Ok(TraktRow {
        has_more: paged.has_more,
        title: None,
        tiles: trakt_tiles(run, paged.items).await?,
    })
}

/// A stale chart page computed again from its request.
fn refresh_chart<'a>(
    ctx: &'a Ready<'a>,
) -> Pin<Box<dyn Future<Output = Result<TraktRow, Fail>> + Send + 'a>> {
    Box::pin(async move {
        let chart = match ctx.path_below(MOUNT).as_str() {
            "/trending" => "trending",
            "/popular" => "popular",
            "/anticipated" => "anticipated",
            other => return Err(Fail::Error(format!("{other} is not a chart"))),
        };
        let params: [&[Param]; 4] = [&PAGE_TYPE, &BROWSE, &RATING_PARAMS, &TAIL];
        let start = start(ctx, &params, &item_defaults(), true)
            .await
            .map_err(|why| Fail::Error(why.why))?;
        let client = client_for_request(ctx, start.user_id)
            .await
            .map_err(Fail::Error)??;
        let extended = extended_for(&start.query);
        let run = run(ctx, client, start, extended);
        let page = run.query.page_number();
        chart_tiles(&run, &Upstream::Chart(chart), page, false).await
    })
}

/// `{ page, hasMore, results }`.
fn page_body(page: i64, has_more: bool, results: Vec<Value>) -> Map<String, Value> {
    let mut body = Map::new();
    body.insert(String::from("page"), Value::from(page));
    body.insert(String::from("hasMore"), Value::Bool(has_more));
    body.insert(String::from("results"), Value::Array(results));
    body
}

/// Which client an item row is answered with.
#[derive(Clone, Copy)]
enum Who {
    /// `createTraktUserClient`.
    User,
    /// `traktClientForRequest`.
    Either,
}

/// The rows that page one upstream (`watchlist`, `history`, the charts).
fn item_row<'a>(
    ctx: &'a Ready<'a>,
    upstream: Upstream,
    who: Who,
    skip_watched: bool,
    fallback: &'static str,
) -> Native<'a> {
    Box::pin(async move {
        let params: [&[Param]; 4] = [&PAGE_TYPE, &BROWSE, &RATING_PARAMS, &TAIL];
        let start = match start(ctx, &params, &item_defaults(), true).await {
            Ok(start) => start,
            Err(why) => return Outcome::forward(why),
        };
        let client = match who {
            Who::User => user_client(ctx, start.user_id).await,
            Who::Either => client_for_request(ctx, start.user_id).await,
        };
        let client = match client {
            Ok(Ok(client)) => client,
            Ok(Err(e)) => return finish(ctx, fallback, Err(e.into())),
            Err(why) => return Outcome::forward(why),
        };
        let extended = extended_for(&start.query);
        let run = run(ctx, client, start, extended);
        let page = run.query.page_number();
        let result = if matches!(upstream, Upstream::Chart(_))
            && !needs_post_filters(&run, skip_watched)
        {
            let compute = Box::pin(chart_tiles(&run, &upstream, page, skip_watched));
            stored_page(&run, page, compute, refresh_chart).await
        } else {
            async {
                let paged =
                    resolve_page(&run, &upstream, page, ITEMS_PER_PAGE, skip_watched, None).await?;
                let results = map_filtered(&run, paged.items).await?;
                Ok(Value::Object(page_body(page, paged.has_more, results)))
            }
            .await
        };
        finish(ctx, fallback, result)
    })
}

fn watchlist<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    item_row(
        ctx,
        Upstream::Watchlist,
        Who::User,
        false,
        "Unable to retrieve Trakt watchlist.",
    )
}

fn history<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    item_row(
        ctx,
        Upstream::History,
        Who::User,
        true,
        "Unable to retrieve Trakt history.",
    )
}

fn trending<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    item_row(
        ctx,
        Upstream::Chart("trending"),
        Who::Either,
        false,
        "Unable to retrieve Trakt trending titles.",
    )
}

fn popular<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    item_row(
        ctx,
        Upstream::Chart("popular"),
        Who::Either,
        false,
        "Unable to retrieve Trakt popular titles.",
    )
}

fn anticipated<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    item_row(
        ctx,
        Upstream::Chart("anticipated"),
        Who::Either,
        false,
        "Unable to retrieve Trakt anticipated titles.",
    )
}

fn recommendations<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    const FALLBACK: &str = "Unable to retrieve Trakt recommendations.";
    Box::pin(async move {
        let params: [&[Param]; 5] = [&PAGE_TYPE, &RECS, &BROWSE, &RATING_PARAMS, &TAIL];
        let defaults = [
            ("page", Value::from(1)),
            ("type", Value::from("all")),
            ("ignoreCollected", Value::Bool(false)),
            ("ignoreWatchlisted", Value::Bool(false)),
            ("includeNoRating", Value::Bool(true)),
        ];
        let start = match start(ctx, &params, &defaults, true).await {
            Ok(start) => start,
            Err(why) => return Outcome::forward(why),
        };
        let client = match user_client(ctx, start.user_id).await {
            Ok(Ok(client)) => client,
            Ok(Err(e)) => return finish(ctx, FALLBACK, Err(e.into())),
            Err(why) => return Outcome::forward(why),
        };
        let extended = extended_for(&start.query);
        let run = run(ctx, client, start, extended);
        let page = run.query.page_number();
        let options = RecsOptions {
            media: run.media,
            ignore_collected: run.query.truthy("ignoreCollected"),
            ignore_watchlisted: run.query.truthy("ignoreWatchlisted"),
            ignore_watched: run.query.truthy("ignoreWatched"),
            extended,
        };
        let result = async {
            let first = recommendation_page(&run, &options, page, ITEMS_PER_PAGE).await?;
            let (items, has_more) = if needs_post_filters(&run, true) {
                let paged = post_filtered(
                    &run,
                    &Upstream::Recommendations(options),
                    page,
                    ITEMS_PER_PAGE,
                    true,
                    None,
                )
                .await?;
                (paged.items, paged.has_more)
            } else {
                (first.items, first.has_more)
            };
            let results = map_filtered(&run, items).await?;
            let mut body = page_body(page, has_more, results);
            if let Some(total) = first.total_pages {
                body.insert(String::from("totalPages"), Value::from(total));
            }
            if let Some(total) = first.total_results {
                body.insert(String::from("totalResults"), Value::from(total));
            }
            Ok(Value::Object(body))
        }
        .await;
        finish(ctx, FALLBACK, result)
    })
}

fn lists<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    const FALLBACK: &str = "Unable to retrieve Trakt lists.";
    Box::pin(async move {
        let user = match ctx
            .authenticated(0)
            .and_then(|u| ctx.no_query().map(|()| u))
        {
            Ok(user) => user,
            Err(why) => return Outcome::forward(why),
        };
        let client = match user_client(ctx, user.id).await {
            Ok(Ok(client)) => client,
            Ok(Err(e)) => return finish(ctx, FALLBACK, Err(e.into())),
            Err(why) => return Outcome::forward(why),
        };
        let (own, liked) = tokio::join!(client.user_lists(), client.liked_lists());
        let result = own.and_then(|own| liked.map(|liked| (own, liked)));
        let result = result.map_err(Fail::from).map(|(own, liked)| {
            let mut watchlist = Map::new();
            watchlist.insert(String::from("id"), Value::from("watchlist"));
            watchlist.insert(String::from("slug"), Value::from("watchlist"));
            watchlist.insert(String::from("name"), Value::from("Watchlist"));
            watchlist.insert(String::from("itemCount"), Value::from(0));
            watchlist.insert(String::from("isWatchlist"), Value::Bool(true));
            let mut results = vec![Value::Object(watchlist)];
            results.extend(own);
            results.extend(liked);
            let mut body = Map::new();
            body.insert(String::from("results"), Value::Array(results));
            Value::Object(body)
        });
        finish(ctx, FALLBACK, result)
    })
}

fn results_body(results: Vec<Value>) -> Value {
    let mut body = Map::new();
    body.insert(String::from("results"), Value::Array(results));
    Value::Object(body)
}

fn lists_search<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    const FALLBACK: &str = "Unable to search Trakt lists.";
    Box::pin(async move {
        let start = match start(ctx, &[&SEARCH], &[], false).await {
            Ok(start) => start,
            Err(why) => return Outcome::forward(why),
        };
        if !start.query.has("query") {
            return Outcome::forward(String::from("a missing query; the validator answers 400"));
        }
        let text = start.query.text("query");
        let text = crate::traktitems::js_trim(&text);
        if text.is_empty() {
            return ctx.json(&results_body(Vec::new()));
        }
        let client = match client_for_request(ctx, start.user_id).await {
            Ok(Ok(client)) => client,
            Ok(Err(e)) => return finish(ctx, FALLBACK, Err(e.into())),
            Err(why) => return Outcome::forward(why),
        };
        let result = client
            .search_lists(text)
            .await
            .map(results_body)
            .map_err(Fail::from);
        finish(ctx, FALLBACK, result)
    })
}

/// The list route's checks passed: its run and what it reads.
struct ListPlan<'a> {
    run: Run<'a>,
    owner: (Option<String>, String),
    page: i64,
    list_sort: Option<SortBy>,
    sort_inside: Option<SortBy>,
    use_post: bool,
}

/// How the list route's checks ended early.
enum ListEarly {
    /// Node's to answer.
    Forward(String),
    /// The route's 400, with its message.
    Bad(String),
    /// A client error, answered as `handleTraktDiscoverRouteError` does.
    Fail(Fail),
}

/// The list route up to its first Trakt call.
async fn plan_list<'a>(ctx: &'a Ready<'a>) -> Result<ListPlan<'a>, ListEarly> {
    let params: [&[Param]; 5] = [&PAGE_TYPE, &LIST, &BROWSE, &RATING_PARAMS, &TAIL];
    let start = start(ctx, &params, &item_defaults(), true)
        .await
        .map_err(|why| ListEarly::Forward(why.why))?;
    if !start.query.has("url") {
        return Err(ListEarly::Forward(String::from(
            "a missing url; the validator answers 400",
        )));
    }
    let url = start.query.text("url");
    let url = crate::traktitems::js_trim(&url).to_owned();
    if url.is_empty() {
        return Err(ListEarly::Bad(String::from(
            "url query parameter is required",
        )));
    }
    let (username, list_ref) = match parse_list_url(&url) {
        Ok(parsed) => parsed,
        Err(ListUrlError::Bad(message)) => return Err(ListEarly::Bad(message)),
    };
    let client = match client_for_request(ctx, start.user_id).await {
        Ok(Ok(client)) => client,
        Ok(Err(e)) => return Err(ListEarly::Fail(e.into())),
        Err(why) => return Err(ListEarly::Forward(why)),
    };
    let list_sort = match start.query.get("sort").and_then(Value::as_str) {
        Some("added") => Some(SortBy::Added),
        Some("released") => Some(SortBy::Released),
        _ => None,
    };
    let mut run = run(ctx, client, start, "min");
    let use_post = needs_post_filters(&run, false);
    let sort_inside = list_sort.filter(|_| !use_post);
    run.extended = if list_sort.is_some() || use_post {
        "full"
    } else {
        extended_for(&run.query)
    };
    if list_ref == "watchlist" && username.is_none() {
        return Err(ListEarly::Bad(String::from(
            "Watchlist URL must include a username",
        )));
    }
    let page = run.query.page_number();
    Ok(ListPlan {
        run,
        owner: (username, list_ref),
        page,
        list_sort,
        sort_inside,
        use_post,
    })
}

fn list<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    const FALLBACK: &str = "Unable to retrieve Trakt public list.";
    Box::pin(async move {
        let plan = match plan_list(ctx).await {
            Ok(plan) => plan,
            Err(ListEarly::Forward(why)) => return Outcome::forward(why),
            Err(ListEarly::Bad(message)) => return route_error(ctx, 400, &message, None),
            Err(ListEarly::Fail(fail)) => return finish(ctx, FALLBACK, Err(fail)),
        };
        let run = &plan.run;
        let compute = Box::pin(list_tiles(
            run,
            plan.owner,
            plan.page,
            plan.list_sort,
            plan.sort_inside,
        ));
        let result = if plan.use_post {
            async {
                let stored = compute.await?;
                let results = serve_tiles(run, stored.tiles).await?;
                let mut body = page_body(plan.page, stored.has_more, results);
                body.insert(String::from("title"), stored.title.unwrap_or(Value::Null));
                Ok(Value::Object(body))
            }
            .await
        } else {
            stored_page(run, plan.page, compute, refresh_list).await
        };
        match result {
            // An AxiosError carries `status`, so the route's own `status ===
            // 400` check passes Trakt's 400 straight to Express.
            Err(Fail::Trakt(e @ TraktError::Axios(400))) => {
                route_error(ctx, 400, &e.message(), None)
            }
            result => finish(ctx, FALLBACK, result),
        }
    })
}

/// A list page computed: the title, the upstream pages, the tiles.
async fn list_tiles(
    run: &Run<'_>,
    (username, list_ref): (Option<String>, String),
    page: i64,
    list_sort: Option<SortBy>,
    sort_inside: Option<SortBy>,
) -> Result<TraktRow, Fail> {
    let title = if list_ref == "watchlist" {
        Value::from(format!("{}'s Watchlist", username.as_deref().unwrap_or("")))
    } else {
        match run
            .client
            .list_metadata(username.as_deref(), &list_ref)
            .await
        {
            Ok(meta) => meta
                .get("name")
                .filter(|n| truthy(Some(n)))
                .cloned()
                .unwrap_or_else(|| Value::from(list_ref.as_str())),
            Err(TraktError::RateLimited(seconds)) => {
                return Err(Fail::Trakt(TraktError::RateLimited(seconds)))
            }
            Err(_) => Value::from(list_ref.as_str()),
        }
    };
    let upstream = Upstream::List {
        username,
        list_ref,
        sort_inside,
    };
    let paged = resolve_page(run, &upstream, page, ITEMS_PER_PAGE, false, list_sort).await?;
    Ok(TraktRow {
        has_more: paged.has_more,
        title: Some(title),
        tiles: trakt_tiles(run, paged.items).await?,
    })
}

/// A stale list page computed again from its request.
fn refresh_list<'a>(
    ctx: &'a Ready<'a>,
) -> Pin<Box<dyn Future<Output = Result<TraktRow, Fail>> + Send + 'a>> {
    Box::pin(async move {
        let plan = match plan_list(ctx).await {
            Ok(plan) => plan,
            Err(ListEarly::Fail(fail)) => return Err(fail),
            Err(ListEarly::Forward(why) | ListEarly::Bad(why)) => return Err(Fail::Error(why)),
        };
        list_tiles(
            &plan.run,
            plan.owner,
            plan.page,
            plan.list_sort,
            plan.sort_inside,
        )
        .await
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_items_like_node() {
        let items = vec![
            json!({"tmdbId": 5, "mediaType": "movie", "title": "A", "year": 2020, "traktSlug": "a-2020", "traktId": 9}),
            json!({"mediaType": "tv", "title": "B", "traktId": 7}),
            json!({"mediaType": "tv", "title": "C"}),
        ];
        let mapped = map_trakt_items(&items);
        assert_eq!(
            mapped.first(),
            Some(
                &json!({"id": 5, "ratingKey": "trakt-movie-a-2020", "tmdbId": 5, "mediaType": "movie",
                "title": "A", "source": "trakt", "sourceId": "a-2020",
                "sourceUrl": "https://trakt.tv/movies/a-2020",
                "mappingState": {"state": "mapped", "namespace": "trakt", "externalId": "a-2020"}})
            ),
            "mapped"
        );
        assert_eq!(
            mapped.get(1),
            Some(
                &json!({"id": 7, "ratingKey": "trakt-tv-7", "mediaType": "tv", "title": "B",
                "source": "trakt", "sourceId": "7", "sourceUrl": "https://trakt.tv/shows/7",
                "mappingState": {"state": "unmapped", "namespace": "trakt", "externalId": "7"}})
            ),
            "unmapped"
        );
        assert_eq!(
            mapped.get(2),
            Some(
                &json!({"id": 0, "ratingKey": "trakt-tv-C", "mediaType": "tv", "title": "C",
                "source": "trakt", "sourceId": "C",
                "mappingState": {"state": "unmapped", "namespace": "trakt", "externalId": "C"}})
            ),
            "title fallback"
        );
    }

    #[test]
    fn parses_media_types() {
        let q =
            |t: &str| Query::from_map(json!({"type": t}).as_object().cloned().unwrap_or_default());
        assert_eq!(Browse::parse(&q("anime")), Browse::Anime, "anime");
        assert_eq!(Browse::parse(&q("all")).fetch(), FetchType::All, "all");
        assert_eq!(Browse::Anime.fetch(), FetchType::All, "anime fetches both");
        assert_eq!(extended_for(&q("all")), "min", "min");
        let rated = Query::from_map(
            json!({"traktRatingGte": 7})
                .as_object()
                .cloned()
                .unwrap_or_default(),
        );
        assert_eq!(extended_for(&rated), "full", "rating filter");
    }
}
