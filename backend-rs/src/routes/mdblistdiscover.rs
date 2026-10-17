//! `GET /discover/mdblist/list` and `/discover/mdblist/lists/search`
//! (`server/routes/discover/mdblist.ts`).

use std::future::Future;
use std::pin::Pin;
use std::sync::LazyLock;
use std::time::Duration;

use axum::http::Method;
use serde_json::{json, Map, Value};

use super::discoverkit::{
    annotate_provider_active_requests, omit_unmapped, record_unmapped, resolve_discover_items,
    route_error, Kind, Param,
};
use super::providerkit::{fallback_error, page_body, prepare, provider_row};
use super::{Outcome, Ready, Table};
use crate::jsval;
use crate::mdblist::{parse_list_ref, ListError, ListItem, ListRef, Mdblist, RefError};
use crate::rowcache::RowCache;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/discover/mdblist/lists/search", Method::GET, search),
    ("/api/v1/discover/mdblist/list", Method::GET, list),
];

const SEARCH_PARAMS: [Param; 1] = [("query", Kind::Str)];
const LIST_PARAMS: [Param; 4] = [
    ("url", Kind::Str),
    ("page", Kind::Int),
    ("hideUnmapped", Kind::Bool),
    ("ignoreDiscoverDefaults", Kind::Bool),
];
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

const LIST_FAILED: &str = "Unable to retrieve MDBList list.";

/// `GET /discover/mdblist/list`.
fn list<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let (_, _, query) =
            try_forward!(prepare(ctx, &[&LIST_PARAMS], &[("page", json!(1))]).await);
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
        let list_ref = match parse_list_ref(&url) {
            Ok(r) => r,
            Err(RefError::Invalid(message)) => return route_error(ctx, 400, &message, None),
            Err(RefError::Forward(why)) => return Outcome::forward(why),
        };
        let stored = provider_row(
            ctx,
            &LIST_ROWS,
            &format!("mdblist/list|{url}|page:{page}"),
            Duration::from_secs(crate::mdblist::LIST_ITEMS_TTL_SECS),
            Box::pin(list_tiles(ctx, &mdblist, &list_ref, page)),
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
            &[("title", Value::from(page_data.title.as_str()))],
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
) -> Result<ListRow, ListFail> {
    let offset = crate::jsnum::from_i64(page.saturating_sub(1).saturating_mul(20));
    let page_data = mdblist
        .list_items(list_ref, 20, offset)
        .await
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
        let (_, _, query) = prepare(ctx, &[&LIST_PARAMS], &[("page", json!(1))])
            .await
            .map_err(|why| ListFail::Mapping(why.why))?;
        let url = jsval::trim(&query.text("url")).to_owned();
        let list_ref = parse_list_ref(&url)
            .map_err(|e| ListFail::Mapping(format!("the list reference no longer reads: {e:?}")))?;
        let mdblist = Mdblist::new(&ctx.state.outbound, &ctx.settings);
        list_tiles(ctx, &mdblist, &list_ref, super::providerkit::page(&query)).await
    })
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
