//! The TMDB-backed `/discover` routes (`server/routes/discover/tmdb.ts`),
//! filtered or not.
//!
//! The query is read as the `OpenAPI` validator leaves it, then the
//! user's saved filter defaults are merged in as `server/routes/discover.ts`
//! does. `paginateTmdbDiscover` then either maps one upstream page, or,
//! when browse filters or `ignoreWatched` apply, walks up to ten upstream
//! pages filtering as it goes.

use std::future::Future;
use std::pin::Pin;

use serde_json::{Map, Value};

use super::browsefilter::{filter_discover_results, to_tmdb_discover_genres};
use super::calendarquery::JsDate;
use super::discoverkit::{
    region_language, watched_sets, BrowseFilters, Kind, Param, Query, RegionLanguage, FLAG_PARAMS,
    RATING_PARAMS,
};
use super::metadata::http_status;
use super::movie::{languages, map_movie_result, picked, RelatedTitles};
use super::ratingsenrich::enrich_results_with_ratings;
use super::search::{map_collection_result, map_person_result};
use super::tv::map_tv_result;
use super::{params, Outcome, Ready};

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// `ExternalAPI`'s default TTL.
const DEFAULT_TTL: u64 = 300;
/// A week, the TTL of keyword details.
const WEEK: u64 = 604_800;
/// `TMDB_DISCOVER_ITEMS_PER_PAGE`.
const PER_PAGE: usize = 20;
/// `MAX_TMDB_UPSTREAM_PAGES`.
const MAX_UPSTREAM_PAGES: i64 = 10;

const PAGE_LANGUAGE: [Param; 2] = [("page", Kind::Int), ("language", Kind::Str)];

/// `/discover/movies` parameters besides the shared groups.
const MOVIE_PARAMS: [Param; 22] = [
    ("page", Kind::Int),
    ("language", Kind::Str),
    ("genre", Kind::Str),
    ("studio", Kind::Num),
    ("keywords", Kind::Str),
    ("excludeKeywords", Kind::Str),
    ("sortBy", Kind::Str),
    ("primaryReleaseDateGte", Kind::Str),
    ("primaryReleaseDateLte", Kind::Str),
    ("withRuntimeGte", Kind::Num),
    ("withRuntimeLte", Kind::Num),
    ("voteAverageGte", Kind::Num),
    ("voteAverageLte", Kind::Num),
    ("voteCountGte", Kind::Num),
    ("voteCountLte", Kind::Num),
    ("watchRegion", Kind::Str),
    ("watchProviders", Kind::Str),
    ("certification", Kind::Str),
    ("certificationGte", Kind::Str),
    ("certificationLte", Kind::Str),
    ("certificationCountry", Kind::Str),
    ("certificationMode", Kind::Enum(&["exact", "range"])),
];

/// `/discover/tv` parameters besides the shared groups.
const TV_PARAMS: [Param; 23] = [
    ("page", Kind::Int),
    ("language", Kind::Str),
    ("genre", Kind::Str),
    ("network", Kind::Num),
    ("keywords", Kind::Str),
    ("excludeKeywords", Kind::Str),
    ("sortBy", Kind::Str),
    ("firstAirDateGte", Kind::Str),
    ("firstAirDateLte", Kind::Str),
    ("withRuntimeGte", Kind::Num),
    ("withRuntimeLte", Kind::Num),
    ("voteAverageGte", Kind::Num),
    ("voteAverageLte", Kind::Num),
    ("voteCountGte", Kind::Num),
    ("voteCountLte", Kind::Num),
    ("watchRegion", Kind::Str),
    ("watchProviders", Kind::Str),
    ("status", Kind::Str),
    ("certification", Kind::Str),
    ("certificationGte", Kind::Str),
    ("certificationLte", Kind::Str),
    ("certificationCountry", Kind::Str),
    ("certificationMode", Kind::Enum(&["exact", "range"])),
];

/// `/discover/trending` parameters besides the shared groups.
const TRENDING_PARAMS: [Param; 16] = [
    ("page", Kind::Int),
    ("language", Kind::Str),
    ("mediaType", Kind::Enum(&["all", "movie", "tv"])),
    ("timeWindow", Kind::Enum(&["day", "week"])),
    ("genre", Kind::Str),
    ("primaryReleaseDateGte", Kind::Str),
    ("primaryReleaseDateLte", Kind::Str),
    ("firstAirDateGte", Kind::Str),
    ("firstAirDateLte", Kind::Str),
    ("voteAverageGte", Kind::Num),
    ("voteAverageLte", Kind::Num),
    ("voteCountGte", Kind::Num),
    ("voteCountLte", Kind::Num),
    ("withRuntimeGte", Kind::Num),
    ("withRuntimeLte", Kind::Num),
    ("status", Kind::Str),
];

const COMMON_SORTS: [&str; 6] = [
    "popularity.desc",
    "popularity.asc",
    "vote_average.desc",
    "vote_average.asc",
    "vote_count.desc",
    "vote_count.asc",
];
const MOVIE_SORTS: [&str; 8] = [
    "release_date.desc",
    "release_date.asc",
    "revenue.desc",
    "revenue.asc",
    "primary_release_date.desc",
    "primary_release_date.asc",
    "original_title.desc",
    "original_title.asc",
];
const TV_SORTS: [&str; 4] = [
    "first_air_date.desc",
    "first_air_date.asc",
    "original_name.desc",
    "original_name.asc",
];

/// Why a route stops: Node has to answer, or Node's own 500.
enum Fail {
    Forward(String),
    Error(String),
}

impl From<String> for Fail {
    fn from(why: String) -> Self {
        Self::Forward(why)
    }
}

/// What every discover route prepares: the user, the query as the
/// handler reads it, `req.locale` and the region preferences.
struct Prelude {
    user_id: i64,
    query: Query,
    /// `settings.main.locale || 'en'`, the TMDB client's default language.
    main_locale: String,
    /// `req.locale`: the user's locale, else `settings.main.locale` as it
    /// is (possibly empty or missing).
    req_locale: Option<String>,
    region: RegionLanguage,
}

impl Prelude {
    /// `(req.query.language as string) ?? req.locale`, the client's
    /// default when both are missing.
    fn language(&self) -> String {
        self.query.get("language").map_or_else(
            || {
                self.req_locale
                    .clone()
                    .unwrap_or_else(|| self.main_locale.clone())
            },
            |v| crate::media::js_string(Some(v)).into_owned(),
        )
    }

    /// `req.locale ?? query.language`, the client's default when both are
    /// missing.
    fn locale_first(&self) -> String {
        self.req_locale
            .clone()
            .or_else(|| coerced(&self.query, "language"))
            .unwrap_or_else(|| self.main_locale.clone())
    }

    /// `Number(req.query.page) || 1`, then `Math.max(1, page)`.
    fn page(&self) -> i64 {
        self.query.page_number().max(1)
    }
}

async fn prelude(
    ctx: &Ready<'_>,
    params: &[&[Param]],
    defaults: &[(&str, Value)],
) -> Result<Prelude, super::Fallback> {
    let user = ctx.authenticated(0)?;
    let query = Query::of(ctx, params, defaults)?;
    let profile = ctx
        .state
        .db
        .user_profile(user.id)
        .await
        .map_err(|e| format!("database: {e:#}"))?
        .ok_or_else(|| String::from("the user is gone"))?;
    let settings = profile.settings.as_ref();
    let query =
        query.with_filter_defaults(settings.and_then(|s| s.discover_filter_defaults.as_deref()));
    let region = region_language(
        ctx,
        settings.and_then(|s| s.streaming_region.as_deref()),
        settings.and_then(|s| s.original_language.as_deref()),
    );
    let (main_locale, _) = languages(ctx, None, None);
    let req_locale = user.locale.clone().or_else(|| {
        ctx.settings
            .get("/main/locale")
            .and_then(Value::as_str)
            .map(str::to_owned)
    });
    Ok(Prelude {
        user_id: user.id,
        query,
        main_locale,
        req_locale,
        region,
    })
}

/// The validator's defaults: `page` is 1 everywhere; the routes with the
/// rating parameters also get `includeNoRating=true`.
fn defaults(rating: bool) -> Vec<(&'static str, Value)> {
    let mut out = vec![("page", Value::from(1))];
    if rating {
        out.push(("includeNoRating", Value::Bool(true)));
    }
    out
}

/// The options of `getDiscoverMovies` / `getDiscoverTv` the routes use.
#[derive(Default)]
struct DiscoverOptions {
    sort_by: Option<String>,
    language: String,
    /// `this.discoverRegion || ''`.
    region: String,
    /// `this.originalLanguage`.
    client_original_language: Option<String>,
    original_language: Option<String>,
    date_gte: Option<String>,
    date_lte: Option<String>,
    genre: Option<String>,
    company_or_network: Option<String>,
    keywords: Option<String>,
    exclude_keywords: Option<String>,
    runtime_gte: Option<String>,
    runtime_lte: Option<String>,
    vote_average_gte: Option<String>,
    vote_average_lte: Option<String>,
    vote_count_gte: Option<String>,
    vote_count_lte: Option<String>,
    watch_region: Option<String>,
    watch_providers: Option<String>,
    with_status: Option<String>,
    certification: Option<String>,
    certification_gte: Option<String>,
    certification_lte: Option<String>,
    certification_country: Option<String>,
}

/// The `/discover/movie` or `/discover/tv` parameters in axios order,
/// `undefined` ones left out.
fn discover_params(tv: bool, page: i64, o: &DiscoverOptions) -> Vec<(&'static str, String)> {
    let mut p: Vec<(&'static str, Option<String>)> = vec![
        (
            "sort_by",
            Some(
                o.sort_by
                    .clone()
                    .unwrap_or_else(|| String::from("popularity.desc")),
            ),
        ),
        ("page", Some(page.to_string())),
    ];
    if !tv {
        p.push(("include_adult", Some(String::from("false"))));
        p.push(("include_video", Some(String::from("true"))));
    }
    p.push(("language", Some(o.language.clone())));
    p.push(("region", Some(o.region.clone())));
    let original = match o.original_language.as_deref() {
        Some("all") => None,
        Some(lang) if !lang.is_empty() => Some(lang.to_owned()),
        Some(_) | None => o.client_original_language.clone(),
    };
    let future = crate::clock::now_millis() + 1000 * 60 * 60 * 24 * 547 + 1000 * 60 * 60 * 12;
    let future = crate::clock::Utc::from_unix_millis(future).iso_string();
    let gte = match (&o.date_gte, &o.date_lte) {
        (None, Some(_)) => Some(String::from("1900-01-01")),
        (gte, _) => gte.clone(),
    };
    let lte = match (&o.date_lte, &o.date_gte) {
        (None, Some(_)) => Some(future.get(..10).unwrap_or("").to_owned()),
        (lte, _) => lte.clone(),
    };
    if tv {
        p.push(("first_air_date.gte", gte));
        p.push(("first_air_date.lte", lte));
        p.push(("with_original_language", original));
        p.push(("include_null_first_air_dates", Some(String::from("false"))));
        p.push(("with_genres", o.genre.clone()));
        p.push(("with_networks", o.company_or_network.clone()));
    } else {
        p.push(("with_original_language", original));
        p.push(("primary_release_date.gte", gte));
        p.push(("primary_release_date.lte", lte));
        p.push(("with_genres", o.genre.clone()));
        p.push(("with_companies", o.company_or_network.clone()));
    }
    p.extend([
        ("with_keywords", o.keywords.clone()),
        ("without_keywords", o.exclude_keywords.clone()),
        ("with_runtime.gte", o.runtime_gte.clone()),
        ("with_runtime.lte", o.runtime_lte.clone()),
        ("vote_average.gte", o.vote_average_gte.clone()),
        ("vote_average.lte", o.vote_average_lte.clone()),
        ("vote_count.gte", o.vote_count_gte.clone()),
        ("vote_count.lte", o.vote_count_lte.clone()),
    ]);
    if tv {
        p.push(("with_watch_providers", o.watch_providers.clone()));
        p.push(("watch_region", o.watch_region.clone()));
        p.push(("with_status", o.with_status.clone()));
    } else {
        p.push(("watch_region", o.watch_region.clone()));
        p.push(("with_watch_providers", o.watch_providers.clone()));
    }
    p.extend([
        ("certification", o.certification.clone()),
        ("certification.gte", o.certification_gte.clone()),
        ("certification.lte", o.certification_lte.clone()),
        ("certification_country", o.certification_country.clone()),
    ]);
    p.into_iter()
        .filter_map(|(k, v)| v.map(|v| (k, v)))
        .collect()
}

/// Where a route's upstream pages come from.
enum Source {
    Discover {
        tv: bool,
        options: Box<DiscoverOptions>,
    },
    Trending {
        kind: &'static str,
        window: &'static str,
        language: String,
        region: String,
    },
    Keyword {
        /// The keyword id in the path.
        id: i64,
        language: String,
    },
}

impl Source {
    /// The mapped kind of every result, or `None` for mixed results.
    const fn kind(&self) -> Option<&'static str> {
        match self {
            Self::Discover { tv: true, .. } => Some("tv"),
            Self::Discover { tv: false, .. } | Self::Keyword { .. } => Some("movie"),
            Self::Trending { kind, .. } => match kind.as_bytes() {
                b"all" => None,
                _ => Some(*kind),
            },
        }
    }

    fn request(&self, page: i64) -> (String, Vec<(&'static str, String)>) {
        match self {
            Self::Discover { tv, options } => (
                String::from(if *tv {
                    "/discover/tv"
                } else {
                    "/discover/movie"
                }),
                discover_params(*tv, page, options),
            ),
            Self::Trending {
                kind,
                window,
                language,
                region,
            } => {
                let mut params = vec![("page", page.to_string()), ("language", language.clone())];
                if *kind == "all" {
                    params.push(("region", region.clone()));
                }
                (format!("/trending/{kind}/{window}"), params)
            }
            Self::Keyword { id, language } => (
                format!("/keyword/{id}/movies"),
                vec![("page", page.to_string()), ("language", language.clone())],
            ),
        }
    }
}

/// One upstream page, mapped.
struct Upstream {
    items: Vec<Value>,
    total_pages: Option<Value>,
    total_results: Option<Value>,
}

/// `fetchMappedPage`: one TMDB page with each result mapped and its
/// related media attached.
async fn fetch_mapped_page(
    ctx: &Ready<'_>,
    pre: &Prelude,
    source: &Source,
    page: i64,
) -> Result<Upstream, Fail> {
    let (path, params) = source.request(page);
    let data = ctx
        .state
        .tmdb
        .raw(&path, &params, DEFAULT_TTL)
        .await
        .map_err(|e| Fail::Error(format!("{e:#}")))?;
    let Some(results) = data.get("results").and_then(Value::as_array) else {
        return Err(Fail::Error(String::from("TMDB answered without results")));
    };
    let kind = source.kind();
    let is_movie = |r: &Value| r.get("title").is_some();
    let of_type = |movie: bool| -> Vec<Value> {
        results
            .iter()
            .filter(|r| match kind {
                Some("movie") => movie,
                Some(_) => !movie,
                None => is_movie(r) == movie,
            })
            .cloned()
            .collect()
    };
    let movies = RelatedTitles::load(ctx, &of_type(true), "movie", Some(pre.user_id)).await?;
    let shows = RelatedTitles::load(ctx, &of_type(false), "tv", Some(pre.user_id)).await?;
    let mut items = Vec::with_capacity(results.len());
    for r in results {
        let item = match kind {
            Some("movie") => map_movie_result(r, movies.media_info_last(ctx, r, "movie")),
            Some(_) => map_tv_result(r, shows.media_info_last(ctx, r, "tv")),
            None => {
                if is_movie(r) {
                    map_movie_result(r, movies.media_info_last(ctx, r, "movie"))
                } else if r.get("known_for").is_some() {
                    map_person_result(r)
                        .ok_or_else(|| String::from("a person without known_for"))?
                } else if r.get("media_type").and_then(Value::as_str) == Some("collection") {
                    map_collection_result(r)
                } else {
                    map_tv_result(r, shows.media_info_last(ctx, r, "tv"))
                }
            }
        };
        items.push(item);
    }
    Ok(Upstream {
        items,
        total_pages: data.get("total_pages").cloned(),
        total_results: data.get("total_results").cloned(),
    })
}

/// `needsDiscoverPostFilters`.
fn needs_post_filters(pre: &Prelude) -> bool {
    BrowseFilters::parse_tmdb_discover(&pre.query).any() || pre.query.truthy("ignoreWatched")
}

/// `filterDiscoverPageResults`: ratings when needed, the browse filters,
/// then the user's watched titles under `ignoreWatched`.
async fn filter_page(
    ctx: &Ready<'_>,
    pre: &Prelude,
    items: Vec<Value>,
) -> Result<Vec<Value>, Fail> {
    let working = enrich_results_with_ratings(ctx, items, Some(&pre.query), false).await?;
    let filtered = filter_discover_results(working, &pre.query);
    if !pre.query.truthy("ignoreWatched") {
        return Ok(filtered);
    }
    let (movies, shows) = watched_sets(ctx, pre.user_id).await?;
    Ok(filtered
        .into_iter()
        .filter(|item| {
            let bucket = match item.get("mediaType").and_then(Value::as_str) {
                Some("movie") => &movies,
                Some("tv") => &shows,
                _ => return true,
            };
            match item.get("id") {
                None | Some(Value::Null) => true,
                Some(id) => id.as_i64().is_none_or(|id| !bucket.contains(&id)),
            }
        })
        .collect())
}

/// `paginateTmdbDiscover`.
async fn paginate(
    ctx: &Ready<'_>,
    pre: &Prelude,
    source: &Source,
) -> Result<Map<String, Value>, Fail> {
    let requested = pre.page();
    let mut out = Map::new();
    out.insert(String::from("page"), Value::from(requested));
    if !needs_post_filters(pre) {
        let upstream = fetch_mapped_page(ctx, pre, source, requested).await?;
        if let Some(v) = upstream.total_pages {
            out.insert(String::from("totalPages"), v);
        }
        if let Some(v) = upstream.total_results {
            out.insert(String::from("totalResults"), v);
        }
        let results =
            enrich_results_with_ratings(ctx, upstream.items, Some(&pre.query), false).await?;
        out.insert(String::from("results"), Value::Array(results));
        return Ok(out);
    }
    // `requestedPage * itemsPerPage` and `(requestedPage - 1) * itemsPerPage`.
    let per_page = params::count(PER_PAGE);
    let needed = requested.saturating_mul(per_page);
    let start = (requested - 1).saturating_mul(per_page);
    let mut filtered: Vec<Value> = Vec::new();
    let mut upstream_page: i64 = 1;
    let mut upstream_has_more = false;
    while upstream_page <= MAX_UPSTREAM_PAGES {
        let upstream = fetch_mapped_page(ctx, pre, source, upstream_page).await?;
        if upstream.items.is_empty() {
            upstream_has_more = false;
            break;
        }
        upstream_has_more = upstream
            .total_pages
            .as_ref()
            .and_then(Value::as_f64)
            .is_some_and(|total| crate::jsnum::from_i64(upstream_page) < total);
        filtered.extend(filter_page(ctx, pre, upstream.items).await?);
        if !upstream_has_more || params::count(filtered.len()) >= needed {
            break;
        }
        upstream_page += 1;
    }
    let has_more = params::count(filtered.len()) > start + per_page
        || (upstream_has_more && upstream_page < MAX_UPSTREAM_PAGES);
    let range = params::slice_range(filtered.len(), start, start + per_page);
    let page_items: Vec<Value> = filtered
        .into_iter()
        .skip(range.start)
        .take(range.len())
        .collect();
    out.insert(String::from("hasMore"), Value::Bool(has_more));
    let results = enrich_results_with_ratings(ctx, page_items, Some(&pre.query), true).await?;
    out.insert(String::from("results"), Value::Array(results));
    Ok(out)
}

/// The route's answer: Node's for a forward, its 500 for a failure.
fn finish(ctx: &Ready<'_>, result: Result<Value, Fail>, message: &str) -> Outcome {
    match result {
        Ok(body) => ctx.json(&body),
        Err(Fail::Forward(why)) => Outcome::forward(why),
        Err(Fail::Error(e)) => {
            tracing::debug!("{message} {e}");
            ctx.error(500, message)
        }
    }
}

/// A date filter as `new Date(value).toISOString().split('T')[0]` gives
/// it; an invalid date throws `RangeError` inside the handler's `try`.
fn iso_date(value: Option<String>) -> Result<Option<String>, Fail> {
    let Some(value) = value.filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    match super::calendarquery::js_date(&value) {
        JsDate::Ms(ms) => {
            let t = crate::clock::Utc::from_unix_millis(ms);
            if (0..=9999).contains(&t.year) {
                Ok(Some(format!("{:04}-{:02}-{:02}", t.year, t.month, t.day)))
            } else {
                Err(Fail::Forward(String::from(
                    "a date toISOString writes with a sign",
                )))
            }
        }
        JsDate::Invalid => Err(Fail::Error(String::from("Invalid Date"))),
        JsDate::Unknown => Err(Fail::Forward(String::from("an unsupported date"))),
    }
}

/// `MovieApiQuerySchema` / `TvApiQuerySchema`: `z.coerce.string()` of a
/// present value.
fn coerced(query: &Query, key: &str) -> Option<String> {
    query
        .get(key)
        .filter(|v| !v.is_null())
        .map(|v| crate::media::js_string(Some(v)).into_owned())
}

/// `getKeywordDetails` for each id of `keywords`: TMDB's keyword, or
/// nothing when TMDB answers 404.
async fn keyword_details(ctx: &Ready<'_>, keywords: &str) -> Result<Vec<Value>, Fail> {
    let mut out = Vec::new();
    for id in keywords.split(',') {
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) || id.len() > 15 {
            return Err(Fail::Forward(String::from("an unsupported keyword id")));
        }
        let id = id
            .parse::<i64>()
            .map_err(|e| Fail::Forward(e.to_string()))?;
        match ctx
            .state
            .tmdb
            .raw(&format!("/keyword/{id}"), &[], WEEK)
            .await
        {
            Ok(keyword) => out.push(std::sync::Arc::unwrap_or_clone(keyword)),
            Err(e) if http_status(&e) == Some(404) => {}
            Err(e) => return Err(Fail::Error(format!("{e:#}"))),
        }
    }
    Ok(out)
}

/// `GET /discover/movies` and `/discover/tv`.
fn popular<'a>(ctx: &'a Ready<'a>, tv: bool) -> Native<'a> {
    Box::pin(async move {
        let message = if tv {
            "Unable to retrieve popular series."
        } else {
            "Unable to retrieve popular movies."
        };
        let params: &[Param] = if tv { &TV_PARAMS } else { &MOVIE_PARAMS };
        let pre = match prelude(
            ctx,
            &[params, &FLAG_PARAMS, &RATING_PARAMS],
            &defaults(true),
        )
        .await
        {
            Ok(pre) => pre,
            Err(why) => return Outcome::forward(why),
        };
        let result = popular_body(ctx, &pre, tv).await;
        finish(ctx, result, message)
    })
}

async fn popular_body(ctx: &Ready<'_>, pre: &Prelude, tv: bool) -> Result<Value, Fail> {
    let q = &pre.query;
    let sorts: &[&str] = if tv { &TV_SORTS } else { &MOVIE_SORTS };
    let sort_by = coerced(q, "sortBy")
        .filter(|s| COMMON_SORTS.contains(&s.as_str()) || sorts.contains(&s.as_str()));
    let (gte_key, lte_key) = if tv {
        ("firstAirDateGte", "firstAirDateLte")
    } else {
        ("primaryReleaseDateGte", "primaryReleaseDateLte")
    };
    let genre = to_tmdb_discover_genres(coerced(q, "genre").as_deref(), tv)?;
    let since = iso_date(coerced(q, gte_key))?;
    let until = iso_date(coerced(q, lte_key))?;
    let keywords = coerced(q, "keywords");
    let company_or_network = if tv {
        coerced(q, "network").filter(|n| !n.is_empty())
    } else {
        coerced(q, "studio")
    };
    let keyword_data = match keywords.as_deref().filter(|k| !k.is_empty()) {
        Some(k) => keyword_details(ctx, k).await?,
        None => Vec::new(),
    };
    let options = DiscoverOptions {
        sort_by,
        language: pre.locale_first(),
        region: pre.region.region.clone(),
        client_original_language: pre.region.original_language.clone(),
        original_language: coerced(q, "language"),
        date_gte: since,
        date_lte: until,
        genre,
        company_or_network,
        keywords,
        exclude_keywords: coerced(q, "excludeKeywords"),
        runtime_gte: coerced(q, "withRuntimeGte"),
        runtime_lte: coerced(q, "withRuntimeLte"),
        vote_average_gte: coerced(q, "voteAverageGte"),
        vote_average_lte: coerced(q, "voteAverageLte"),
        vote_count_gte: coerced(q, "voteCountGte"),
        vote_count_lte: coerced(q, "voteCountLte"),
        watch_region: coerced(q, "watchRegion"),
        watch_providers: coerced(q, "watchProviders"),
        with_status: if tv { coerced(q, "status") } else { None },
        certification: coerced(q, "certification"),
        certification_gte: coerced(q, "certificationGte"),
        certification_lte: coerced(q, "certificationLte"),
        certification_country: coerced(q, "certificationCountry"),
    };
    let source = Source::Discover {
        tv,
        options: Box::new(options),
    };
    let mut out = paginate(ctx, pre, &source).await?;
    out.insert(String::from("keywords"), Value::Array(keyword_data));
    Ok(Value::Object(out))
}

pub(super) fn movies<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    popular(ctx, false)
}

pub(super) fn tv<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    popular(ctx, true)
}

/// Plain `getDiscoverMovies` / `getDiscoverTv` options in the requested
/// language, with the region-aware client unless `plain`.
fn plain_options(pre: &Prelude, plain: bool) -> DiscoverOptions {
    DiscoverOptions {
        language: pre.language(),
        region: if plain {
            String::new()
        } else {
            pre.region.region.clone()
        },
        client_original_language: if plain {
            None
        } else {
            pre.region.original_language.clone()
        },
        ..DiscoverOptions::default()
    }
}

/// `GET /discover/movies/upcoming` and `/discover/tv/upcoming`: from today
/// on, "today" being the date in the server's time zone.
fn upcoming<'a>(ctx: &'a Ready<'a>, tv: bool) -> Native<'a> {
    Box::pin(async move {
        let message = if tv {
            "Unable to retrieve upcoming series."
        } else {
            "Unable to retrieve upcoming movies."
        };
        let pre = match prelude(ctx, &[&PAGE_LANGUAGE], &defaults(false)).await {
            Ok(pre) => pre,
            Err(why) => return Outcome::forward(why),
        };
        let mut options = plain_options(&pre, false);
        options.date_gte = Some(chrono::Local::now().format("%Y-%m-%d").to_string());
        let source = Source::Discover {
            tv,
            options: Box::new(options),
        };
        let result = paginate(ctx, &pre, &source).await.map(Value::Object);
        finish(ctx, result, message)
    })
}

pub(super) fn movies_upcoming<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    upcoming(ctx, false)
}

pub(super) fn tv_upcoming<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    upcoming(ctx, true)
}

/// The last path segment, as written.
fn last_segment(ctx: &Ready<'_>) -> String {
    ctx.req
        .uri
        .path()
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_owned()
}

/// `/discover/{movies,tv}/language/{iso}`.
fn by_language<'a>(ctx: &'a Ready<'a>, tv: bool) -> Native<'a> {
    Box::pin(async move {
        let message = if tv {
            "Unable to retrieve series by language."
        } else {
            "Unable to retrieve movies by language."
        };
        let pre = match prelude(ctx, &[&PAGE_LANGUAGE], &defaults(false)).await {
            Ok(pre) => pre,
            Err(why) => return Outcome::forward(why),
        };
        let Some(iso) = super::nodestate::decode_segment(&last_segment(ctx)) else {
            return Outcome::forward(String::from("a path segment Express can't decode"));
        };
        let languages = match ctx.state.tmdb.languages().await {
            Ok(languages) => languages,
            Err(e) => return finish(ctx, Err(Fail::Error(format!("{e:#}"))), message),
        };
        let Some(language) = languages
            .iter()
            .find(|l| l.get("iso_639_1").and_then(Value::as_str) == Some(iso.as_str()))
            .cloned()
        else {
            return ctx.error(404, "Language not found.");
        };
        let mut options = plain_options(&pre, false);
        options.original_language = Some(iso);
        let source = Source::Discover {
            tv,
            options: Box::new(options),
        };
        let result = paginate(ctx, &pre, &source).await.map(|mut out| {
            out.insert(String::from("language"), language);
            Value::Object(out)
        });
        finish(ctx, result, message)
    })
}

pub(super) fn movies_language<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    by_language(ctx, false)
}

pub(super) fn tv_language<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    by_language(ctx, true)
}

/// `/discover/{movies,tv}/genre/{id}`.
fn by_genre<'a>(ctx: &'a Ready<'a>, tv: bool) -> Native<'a> {
    Box::pin(async move {
        let (kind, message) = if tv {
            ("tv", "Unable to retrieve series by genre.")
        } else {
            ("movie", "Unable to retrieve movies by genre.")
        };
        let pre = match prelude(ctx, &[&PAGE_LANGUAGE], &defaults(false)).await {
            Ok(pre) => pre,
            Err(why) => return Outcome::forward(why),
        };
        // `genre.id === Number(req.params.genreId)`.
        let id = match params::path_int(ctx, 0) {
            Ok(id) => id,
            Err(why) => return Outcome::forward(why),
        };
        let genres = match ctx.state.tmdb.genres(kind, &pre.language()).await {
            Ok(genres) => genres,
            Err(e) => return finish(ctx, Err(Fail::Error(format!("{e:#}"))), message),
        };
        let Some(genre) = genres
            .iter()
            .find(|g| g.get("id").and_then(Value::as_i64) == Some(id))
            .cloned()
        else {
            return ctx.error(404, "Genre not found.");
        };
        let mut options = plain_options(&pre, false);
        options.genre = Some(id.to_string());
        let source = Source::Discover {
            tv,
            options: Box::new(options),
        };
        let result = paginate(ctx, &pre, &source).await.map(|mut out| {
            out.insert(String::from("genre"), genre);
            Value::Object(out)
        });
        finish(ctx, result, message)
    })
}

pub(super) fn movies_genre<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    by_genre(ctx, false)
}

pub(super) fn tv_genre<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    by_genre(ctx, true)
}

/// `/discover/movies/studio/{id}` and `/discover/tv/network/{id}`: a plain
/// client, so no region preferences. The studio goes to TMDB as written
/// in the path; the network as `Number()` reads it.
fn by_company<'a>(ctx: &'a Ready<'a>, tv: bool) -> Native<'a> {
    Box::pin(async move {
        let (lookup, message, key) = if tv {
            (
                "network",
                "Unable to retrieve series by network.",
                "network",
            )
        } else {
            ("company", "Unable to retrieve movies by studio.", "studio")
        };
        let pre = match prelude(ctx, &[&PAGE_LANGUAGE], &defaults(false)).await {
            Ok(pre) => pre,
            Err(why) => return Outcome::forward(why),
        };
        // `getStudio(Number(id))` / `getNetwork(Number(id))`.
        let id = match params::path_int(ctx, 0) {
            Ok(id) => id,
            Err(why) => return Outcome::forward(why),
        };
        let entity = match ctx
            .state
            .tmdb
            .raw(&format!("/{lookup}/{id}"), &[], DEFAULT_TTL)
            .await
        {
            Ok(entity) => entity,
            Err(e) => return finish(ctx, Err(Fail::Error(format!("{e:#}"))), message),
        };
        let mut options = plain_options(&pre, true);
        options.company_or_network = Some(id.to_string());
        let source = Source::Discover {
            tv,
            options: Box::new(options),
        };
        let mut fields = vec![
            ("id", "id"),
            ("name", "name"),
            ("originCountry", "origin_country"),
        ];
        if !tv {
            fields.push(("description", "description"));
        }
        fields.extend([
            ("headquarters", "headquarters"),
            ("homepage", "homepage"),
            ("logoPath", "logo_path"),
        ]);
        let result = paginate(ctx, &pre, &source).await.map(|mut out| {
            out.insert(String::from(key), picked(&entity, &fields));
            Value::Object(out)
        });
        finish(ctx, result, message)
    })
}

pub(super) fn movies_studio<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    by_company(ctx, false)
}

pub(super) fn tv_network<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    by_company(ctx, true)
}

/// `GET /discover/trending`.
pub(super) fn trending<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let defaults = [
            ("page", Value::from(1)),
            ("mediaType", Value::from("all")),
            ("timeWindow", Value::from("day")),
            ("includeNoRating", Value::Bool(true)),
        ];
        let pre = match prelude(
            ctx,
            &[&TRENDING_PARAMS, &FLAG_PARAMS, &RATING_PARAMS],
            &defaults,
        )
        .await
        {
            Ok(pre) => pre,
            Err(why) => return Outcome::forward(why),
        };
        let kind = match pre.query.str("mediaType") {
            Some("movie") => "movie",
            Some("tv") => "tv",
            Some("all") => "all",
            _ => return Outcome::forward(String::from("mediaType outside the enum")),
        };
        let window = if pre.query.str("timeWindow") == Some("week") {
            "week"
        } else {
            "day"
        };
        let source = Source::Trending {
            kind,
            window,
            language: pre.language(),
            region: pre.region.region.clone(),
        };
        let result = paginate(ctx, &pre, &source).await.map(Value::Object);
        finish(ctx, result, "Unable to retrieve trending items.")
    })
}

/// `GET /discover/keyword/{id}/movies`.
pub(super) fn keyword_movies<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let pre = match prelude(ctx, &[&PAGE_LANGUAGE], &defaults(false)).await {
            Ok(pre) => pre,
            Err(why) => return Outcome::forward(why),
        };
        let id = match params::path_int(ctx, 1) {
            Ok(id) => id,
            Err(why) => return Outcome::forward(why),
        };
        let source = Source::Keyword {
            id,
            language: pre.language(),
        };
        let result = paginate(ctx, &pre, &source).await.map(Value::Object);
        finish(ctx, result, "Unable to retrieve movies by keyword.")
    })
}

/// `/discover/genreslider/{movie,tv}`: each genre with the backdrops of its
/// first popular page (the plain client in the default language), by name.
fn genre_slider<'a>(ctx: &'a Ready<'a>, tv: bool) -> Native<'a> {
    Box::pin(async move {
        let (kind, message) = if tv {
            ("tv", "Unable to retrieve series genre slider.")
        } else {
            ("movie", "Unable to retrieve movie genre slider.")
        };
        let pre = match prelude(ctx, &[&[("language", Kind::Str)]], &[]).await {
            Ok(pre) => pre,
            Err(why) => return Outcome::forward(why),
        };
        let result = genre_slider_body(ctx, &pre, kind, tv).await;
        finish(ctx, result, message)
    })
}

async fn genre_slider_body(
    ctx: &Ready<'_>,
    pre: &Prelude,
    kind: &str,
    tv: bool,
) -> Result<Value, Fail> {
    let genres = ctx
        .state
        .tmdb
        .genres(kind, &pre.language())
        .await
        .map_err(|e| Fail::Error(format!("{e:#}")))?;
    let mut out = Vec::with_capacity(genres.len());
    for genre in &genres {
        let options = DiscoverOptions {
            language: pre.main_locale.clone(),
            genre: Some(crate::media::js_string(genre.get("id")).into_owned()),
            ..DiscoverOptions::default()
        };
        let source = Source::Discover {
            tv,
            options: Box::new(options),
        };
        let (path, params) = source.request(1);
        let data = ctx
            .state
            .tmdb
            .raw(&path, &params, DEFAULT_TTL)
            .await
            .map_err(|e| Fail::Error(format!("{e:#}")))?;
        let Some(results) = data.get("results").and_then(Value::as_array) else {
            return Err(Fail::Error(String::from("TMDB answered without results")));
        };
        let backdrops: Vec<Value> = results
            .iter()
            .filter_map(|t| t.get("backdrop_path"))
            .filter(|b| crate::settings::public::truthy(Some(b)))
            .cloned()
            .collect();
        let mut item = Map::new();
        item.insert(
            String::from("id"),
            genre.get("id").cloned().unwrap_or(Value::Null),
        );
        item.insert(
            String::from("name"),
            genre.get("name").cloned().unwrap_or(Value::Null),
        );
        item.insert(String::from("backdrops"), Value::Array(backdrops));
        out.push(Value::Object(item));
    }
    Ok(Value::Array(out))
}

pub(super) fn genre_slider_movie<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    genre_slider(ctx, false)
}

pub(super) fn genre_slider_tv<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    genre_slider(ctx, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn movie_params_in_axios_order() {
        let options = DiscoverOptions {
            language: String::from("en"),
            region: String::from("US"),
            client_original_language: Some(String::new()),
            date_gte: Some(String::from("2020-01-01")),
            genre: Some(String::from("28|12")),
            keywords: Some(String::from("1,2")),
            vote_average_gte: Some(String::from("7")),
            watch_region: Some(String::from("US")),
            watch_providers: Some(String::from("8|9")),
            ..DiscoverOptions::default()
        };
        let keys: Vec<&str> = discover_params(false, 2, &options)
            .iter()
            .map(|(k, _)| *k)
            .collect();
        assert_eq!(
            keys,
            vec![
                "sort_by",
                "page",
                "include_adult",
                "include_video",
                "language",
                "region",
                "with_original_language",
                "primary_release_date.gte",
                "primary_release_date.lte",
                "with_genres",
                "with_keywords",
                "vote_average.gte",
                "watch_region",
                "with_watch_providers",
            ],
            "movie order"
        );
        let tv: Vec<&str> = discover_params(true, 1, &options)
            .iter()
            .map(|(k, _)| *k)
            .collect();
        assert_eq!(
            tv,
            vec![
                "sort_by",
                "page",
                "language",
                "region",
                "first_air_date.gte",
                "first_air_date.lte",
                "with_original_language",
                "include_null_first_air_dates",
                "with_genres",
                "with_keywords",
                "vote_average.gte",
                "with_watch_providers",
                "watch_region",
            ],
            "tv order"
        );
    }

    #[test]
    fn past_date_fills_in() {
        let options = DiscoverOptions {
            date_lte: Some(String::from("2020-01-01")),
            ..DiscoverOptions::default()
        };
        let params = discover_params(false, 1, &options);
        assert!(
            params.contains(&("primary_release_date.gte", String::from("1900-01-01"))),
            "1900 when only the end is set"
        );
    }

    #[test]
    fn dates() {
        assert!(
            matches!(iso_date(Some(String::from("2024-02-29"))), Ok(Some(_))),
            "leap day"
        );
        assert!(matches!(iso_date(None), Ok(None)), "none");
        for (text, day) in [
            ("2023-02-29", "2023-03-01"),
            ("2024-01-01T23:00:00-02:00", "2024-01-02"),
            ("0999-01-01", "0999-01-01"),
        ] {
            assert!(
                matches!(iso_date(Some(String::from(text))), Ok(Some(d)) if d == day),
                "{text} is {day}"
            );
        }
        assert!(
            matches!(iso_date(Some(String::from("abc"))), Err(Fail::Error(_))),
            "an invalid date throws"
        );
        for unknown in ["2024-1-01", "Jan 1 2024"] {
            assert!(
                matches!(iso_date(Some(String::from(unknown))), Err(Fail::Forward(_))),
                "{unknown} is not supported"
            );
        }
    }
}
