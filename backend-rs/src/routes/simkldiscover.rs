//! `GET /discover/simkl/library` and `/discover/simkl/trending`
//! (`server/routes/discover/simkl.ts`).
//!
//! The library sync (its per-user lock
//! and throttle) and the TMDB resolution (mapping layer, corrections, miss
//! counters) run in Node; reading Simkl and the local mirror happens here.

use std::future::Future;
use std::pin::Pin;
use std::sync::LazyLock;
use std::time::Duration;

use axum::http::Method;
use serde_json::{json, Map, Value};

use super::discoverkit::{has_discover_tmdb_id, route_error, Kind, Param};
use super::providerkit::{prepare, provider_row};
use super::{Outcome, Ready, Table};
use crate::db::Bind;
use crate::mappinglayer::simklresolve::{resolve_page, ResolvedPage};
use crate::rowcache::RowCache;
use crate::simkl::{
    catalog_candidates, hydrate, paginate, sync_candidate, trending_file, Simkl, SyncRow,
};

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/discover/simkl/library", Method::GET, library),
    ("/api/v1/discover/simkl/trending", Method::GET, trending),
];

const MEDIA_TYPES: &[&str] = &["movie", "tv", "anime", "all"];
const LIBRARY_PARAMS: [Param; 4] = [
    (
        "status",
        Kind::Enum(&["watching", "plantowatch", "hold", "completed", "dropped"]),
    ),
    ("mediaType", Kind::Enum(MEDIA_TYPES)),
    ("page", Kind::Int),
    ("hideUnmapped", Kind::Bool),
];
const TRENDING_PARAMS: [Param; 4] = [
    ("mediaType", Kind::Enum(MEDIA_TYPES)),
    ("period", Kind::Enum(&["day", "week", "month"])),
    ("page", Kind::Int),
    ("hideUnmapped", Kind::Bool),
];

macro_rules! try_forward {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(why) => return Outcome::forward(why),
        }
    };
}

/// POST to one of the internal Simkl routes, answered in-process. A
/// failure carries the message Node's error handler wrote, which is what
/// the route surfaces.
async fn internal_simkl(ctx: &Ready<'_>, path: &str, body: &Value) -> Result<Value, String> {
    let answer =
        crate::standalone::internal::call(ctx.state, &Method::POST, path, Some(body)).await;
    if answer.is_success() {
        return Ok(answer.body);
    }
    Err(answer
        .body
        .get("message")
        .and_then(Value::as_str)
        .map_or_else(|| format!("the internal {path} failed"), str::to_owned))
}

/// What Node's `/internal/simkl/resolve` did: resolution, miss records
/// and `toSimklWatchlistItems` for one page of hydrated candidates.
async fn resolve(
    ctx: &Ready<'_>,
    candidates: Vec<Value>,
    discover_source: &str,
    hide_unmapped: bool,
) -> Vec<Value> {
    let mapping = crate::mappinglayer::Ctx::with_settings(ctx.state, &ctx.settings);
    let items = crate::mappinglayer::simklresolve::resolve(
        &mapping,
        candidates,
        discover_source,
        hide_unmapped,
    )
    .await;
    super::discoverkit::annotate_provider_active_requests(ctx, items).await
}

/// `GET /discover/simkl/library`.
fn library<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let (user_id, _, query) = try_forward!(prepare(ctx, &[&LIBRARY_PARAMS], &[]).await);
        let simkl = Simkl::new(
            &ctx.state.outbound,
            &ctx.settings,
            &ctx.state.version.version,
        );
        let status = query.str("status").map(str::to_owned);
        let media_type = query.str("mediaType").unwrap_or("all");
        let types: &[&str] = match media_type {
            "movie" => &["movie"],
            "anime" => &["anime"],
            "tv" => &["show"],
            _ => &["movie", "show", "anime"],
        };
        let page = super::providerkit::page(&query);
        let hide = query.truthy("hideUnmapped");
        let sync = if simkl.is_none() {
            match super::simklunconfigured::sync(ctx, user_id).await {
                Ok(()) => Value::Null,
                Err(why) => return internal_error(ctx, &why),
            }
        } else {
            match internal_simkl(ctx, "/simkl/sync", &json!({ "userId": user_id })).await {
                Ok(result) => result,
                Err(why) => return internal_error(ctx, &why),
            }
        };
        let rows = match library_rows(ctx, user_id, types, status.as_deref()).await {
            Ok(rows) => rows,
            Err(why) => return internal_error(ctx, &why),
        };
        // Without a Client ID, Node syncs and reads the rows, then
        // `new SimklAPI()` throws its `SimklNotConfiguredError`.
        let Some(simkl) = simkl else {
            return ctx.error(500, super::simklunconfigured::NOT_CONFIGURED);
        };
        let total = rows.len();
        // `Math.max(1, Number(req.query.page) || 1)`.
        let page = page.max(1);
        let start = (page - 1).saturating_mul(20);
        let range = super::params::slice_range(rows.len(), start, start + 20);
        let slice: Vec<Value> = rows
            .iter()
            .skip(range.start)
            .take(range.len())
            .map(sync_candidate)
            .collect();
        let hydrated = hydrate(&simkl, slice).await;
        let results = resolve(ctx, hydrated, "simkl/library", hide).await;
        for item in &results {
            let (Some(tmdb), Some(source_id)) = (
                item.get("tmdbId")
                    .filter(|t| has_discover_tmdb_id(Some(t)))
                    .and_then(Value::as_i64),
                item.get("sourceId")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty()),
            ) else {
                continue;
            };
            let updated = ctx
                .state
                .db
                .execute(
                    r#"UPDATE "simkl_sync_item" SET "tmdbId" = ?1 WHERE "simklId" = ?2 AND "userId" = ?3"#,
                    &[Bind::Int(tmdb), Bind::Text(source_id.to_owned()), Bind::Int(user_id)],
                )
                .await;
            if let Err(e) = updated {
                return internal_error(ctx, &format!("updating simkl_sync_item failed: {e:#}"));
            }
        }
        let total_i = i64::try_from(total).unwrap_or(i64::MAX);
        let mut provider = Map::new();
        provider.insert(String::from("source"), Value::from("simkl"));
        provider.insert(
            String::from("stale"),
            sync.get("stale").cloned().unwrap_or(Value::Bool(false)),
        );
        if let Some(at) = sync.get("lastSuccessfulSyncAt").filter(|v| !v.is_null()) {
            provider.insert(String::from("lastSuccessfulSyncAt"), at.clone());
        }
        let mut body = Map::new();
        body.insert(String::from("page"), Value::from(page));
        body.insert(String::from("totalResults"), Value::from(total_i));
        body.insert(
            String::from("totalPages"),
            Value::from(((total_i + 19) / 20).max(1)),
        );
        body.insert(String::from("hasMore"), Value::Bool(start + 20 < total_i));
        body.insert(String::from("results"), Value::Array(results));
        body.insert(String::from("providerState"), Value::Object(provider));
        ctx.json(&Value::Object(body))
    })
}

/// An error past the sync: Node's handler has no catch, so Express answers
/// 500 with the error's message.
fn internal_error(ctx: &Ready<'_>, why: &str) -> Outcome {
    tracing::error!("[Simkl] {why}");
    route_error(ctx, 500, why, None)
}

/// The library rows, newest first, as the route's query builder reads them.
async fn library_rows(
    ctx: &Ready<'_>,
    user_id: i64,
    types: &[&str],
    status: Option<&str>,
) -> Result<Vec<SyncRow>, String> {
    let mut binds = vec![Bind::Int(user_id)];
    let mut placeholders = Vec::new();
    for t in types {
        binds.push(Bind::Text((*t).to_owned()));
        placeholders.push(format!("?{}", binds.len()));
    }
    let status_clause = status.map_or_else(
        || String::from("1=1"),
        |s| {
            binds.push(Bind::Text(s.to_owned()));
            format!(r#""item"."status" = ?{}"#, binds.len())
        },
    );
    let sql = format!(
        r#"SELECT "item"."simklId" AS "simklId", "item"."simklType" AS "simklType", "item"."tmdbId" AS "tmdbId", "item"."tvdbId" AS "tvdbId", "item"."slug" AS "slug", "item"."title" AS "title", "item"."posterPath" AS "posterPath" FROM "simkl_sync_item" "item" WHERE "item"."userId" = ?1 AND "item"."simklType" IN ({}) AND {status_clause} ORDER BY "item"."addedAt" DESC NULLS LAST"#,
        placeholders.join(", ")
    );
    let rows = ctx
        .state
        .db
        .rows(&sql, &binds)
        .await
        .map_err(|e| format!("loading the Simkl library failed: {e:#}"))?;
    Ok(rows
        .iter()
        .map(|r| {
            let text = |k: &str| r.get(k).and_then(Value::as_str).map(str::to_owned);
            SyncRow {
                simkl_id: text("simklId").unwrap_or_default(),
                simkl_type: text("simklType").unwrap_or_default(),
                tmdb_id: r.get("tmdbId").and_then(Value::as_f64),
                tvdb_id: r.get("tvdbId").and_then(Value::as_f64),
                slug: text("slug"),
                title: text("title").unwrap_or_default(),
                poster_path: text("posterPath"),
            }
        })
        .collect())
}

/// `GET /discover/simkl/trending`: every failure is a 503 with the error's
/// message.
fn trending<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let (_, _, query) = try_forward!(prepare(ctx, &[&TRENDING_PARAMS], &[]).await);
        let media_type = query.str("mediaType").unwrap_or("all").to_owned();
        let page = super::providerkit::page(&query);
        let period = query.str("period").unwrap_or("week").to_owned();
        let unavailable = |message: &str| route_error(ctx, 503, message, None);
        let Some(simkl) = Simkl::new(
            &ctx.state.outbound,
            &ctx.settings,
            &ctx.state.version.version,
        ) else {
            return unavailable(crate::simklapi::NOT_CONFIGURED);
        };
        let source = format!("simkl/trending/{media_type}");
        let page = page.max(1);
        let stored = provider_row(
            ctx,
            &TRENDING_ROWS,
            &format!("simkl/trending|{media_type}|{period}|page:{page}"),
            TRENDING_FRESH,
            Box::pin(trending_page(ctx, &simkl, (&media_type, &period), page)),
            refresh_trending,
        )
        .await;
        let stored = match stored {
            Ok(stored) => stored,
            Err(message) => return unavailable(&message),
        };
        let mapping = crate::mappinglayer::Ctx::with_settings(ctx.state, &ctx.settings);
        let items = stored
            .resolved
            .serve(&mapping, &source, query.truthy("hideUnmapped"));
        let results = super::discoverkit::annotate_provider_active_requests(ctx, items).await;
        ctx.json(&super::providerkit::page_body(
            stored.page,
            stored.has_more,
            results,
            &[],
        ))
    })
}

/// A trending page as stored: before the gap sightings, `hideUnmapped`
/// and the request annotations every serve applies.
#[derive(Debug, Clone)]
struct TrendingRow {
    page: i64,
    has_more: bool,
    resolved: ResolvedPage,
}

static TRENDING_ROWS: LazyLock<RowCache<TrendingRow, String>> = LazyLock::new(RowCache::new);

/// Nothing in front of the trending catalog caches it, so its row is never
/// fresh: every view gets the last page at once and refreshes it.
const TRENDING_FRESH: Duration = Duration::ZERO;

/// A trending page computed (with this process's mapping layer): the
/// catalog, its page hydrated, resolved and drawn. An error is the 503's
/// message.
async fn trending_page(
    ctx: &Ready<'_>,
    simkl: &Simkl,
    (media_type, period): (&str, &str),
    page: i64,
) -> Result<TrendingRow, String> {
    let payload = simkl
        .cdn_catalog(&trending_file(media_type, period))
        .await
        .map_err(|e| e.message().to_owned())?;
    let candidates = catalog_candidates(&payload, media_type, "simkl-public")?;
    let (slice, has_more, page) = paginate(candidates, page);
    let hydrated = hydrate(simkl, slice).await;
    let mapping = crate::mappinglayer::Ctx::with_settings(ctx.state, &ctx.settings);
    Ok(TrendingRow {
        page,
        has_more,
        resolved: resolve_page(&mapping, hydrated).await,
    })
}

/// A stale trending page computed again from its request.
fn refresh_trending<'a>(
    ctx: &'a Ready<'a>,
) -> Pin<Box<dyn Future<Output = Result<TrendingRow, String>> + Send + 'a>> {
    Box::pin(async move {
        let (_, _, query) = prepare(ctx, &[&TRENDING_PARAMS], &[])
            .await
            .map_err(|why| why.why)?;
        let simkl = Simkl::new(
            &ctx.state.outbound,
            &ctx.settings,
            &ctx.state.version.version,
        )
        .ok_or_else(|| String::from(crate::simklapi::NOT_CONFIGURED))?;
        let media_type = query.str("mediaType").unwrap_or("all");
        let period = query.str("period").unwrap_or("week");
        let page = super::providerkit::page(&query).max(1);
        trending_page(ctx, &simkl, (media_type, period), page).await
    })
}
