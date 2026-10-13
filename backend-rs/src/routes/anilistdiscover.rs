//! `GET /discover/anilist/*` (`server/routes/discover/anilist.ts`).
//!
//! A linked token that has expired makes Node clear the user's `AniList`
//! credentials and its sync cache; those requests go to Node before
//! anything is fetched.

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::LazyLock;

use axum::http::Method;
use serde_json::{json, Map, Value};

use super::discoverkit::{
    anilist_media_list, annotate_provider_active_requests, confirm_or_repair, has_discover_tmdb_id,
    omit_unmapped, record_unmapped, route_error, with_tmdb_posters, Kind, Param, Query,
};
use super::providerkit::{fallback_error, page_body, prepare, provider_row};
use super::{Outcome, Ready, Table};
use crate::anilist::{
    current_season, next_season, parse_list_url, status_list_name, Anilist, AnilistError, Season,
};
use crate::jsval;
use crate::rowcache::RowCache;
use crate::settings::public::truthy;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// A season picker: `currentSeason` or `nextSeason` by month and year.
type SeasonPick = fn(i64, i64) -> Season;

/// Where Node mounts `anilistDiscoverRoutes`; `discoverSource` is
/// `anilist${req.path}` below it.
const MOUNT: &str = "/api/v1/discover/anilist";

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/discover/anilist/trending", Method::GET, trending),
    ("/api/v1/discover/anilist/season", Method::GET, season),
    ("/api/v1/discover/anilist/popular", Method::GET, popular),
    ("/api/v1/discover/anilist/top", Method::GET, top),
    (
        "/api/v1/discover/anilist/next-season",
        Method::GET,
        next_season_row,
    ),
    ("/api/v1/discover/anilist/watching", Method::GET, watching),
    ("/api/v1/discover/anilist/planning", Method::GET, planning),
    ("/api/v1/discover/anilist/completed", Method::GET, completed),
    ("/api/v1/discover/anilist/paused", Method::GET, paused),
    ("/api/v1/discover/anilist/dropped", Method::GET, dropped),
    ("/api/v1/discover/anilist/lists", Method::GET, lists),
    ("/api/v1/discover/anilist/list", Method::GET, list),
];

const PAGE_PARAMS: [Param; 3] = [
    ("page", Kind::Int),
    ("hideUnmapped", Kind::Bool),
    ("ignoreDiscoverDefaults", Kind::Bool),
];
const LIST_PARAMS: [Param; 2] = [("name", Kind::Str), ("url", Kind::Str)];
const NOT_LINKED: &str = "User has not linked an AniList account";
const NOT_FOUND: &str = "AniList user not found, or their list is private.";

macro_rules! try_forward {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(why) => return Outcome::forward(why),
        }
    };
}

fn page_defaults() -> [(&'static str, Value); 1] {
    [("page", json!(1))]
}

/// `getAnilistAppCredentials()` succeeds.
fn configured(ctx: &Ready<'_>) -> bool {
    !jsval::trim(ctx.settings.str("/anilist/clientId")).is_empty()
        && !jsval::trim(ctx.settings.str("/anilist/clientSecret")).is_empty()
}

fn not_configured(ctx: &Ready<'_>) -> Outcome {
    route_error(
        ctx,
        400,
        "AniList application credentials are not configured",
        None,
    )
}

/// `isAnilistTokenExpired(expiresAt)`.
fn token_expired(expires_at: Option<&Value>) -> bool {
    if !truthy(expires_at) {
        return false;
    }
    let expires = jsval::number_of(expires_at);
    if !expires.is_finite() || expires <= 0.0 {
        return false;
    }
    let now = crate::clock::now_millis().div_euclid(1000) + 60;
    expires <= now.to_string().parse::<f64>().unwrap_or(f64::MAX)
}

/// The linked token, trimmed, when there is one.
fn linked_token(row: &Map<String, Value>) -> Option<String> {
    row.get("anilistAccessToken")
        .and_then(Value::as_str)
        .map(jsval::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
}

/// `clearUserAnilistCredentials(settings.id, userId)` for an expired token.
async fn clear_expired(ctx: &Ready<'_>, row: &Map<String, Value>) -> Result<(), String> {
    let user_id = row
        .get("userId")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    tracing::info!("AniList token expired; clearing linked account");
    ctx.state
        .db
        .execute(
            r#"UPDATE "user_settings" SET "anilistAccessToken" = NULL, "anilistTokenExpiresAt" = NULL, "anilistUsername" = NULL, "anilistUserId" = NULL WHERE "userId" = ?1"#,
            &[crate::db::Bind::Int(user_id)],
        )
        .await
        .map_err(|e| format!("database: {e:#}"))?;
    crate::mappinglayer::synccache::invalidate_user_anilist_sync_cache(user_id);
    Ok(())
}

/// The message `createAnilistUserClient` throws for an expired token.
const EXPIRED: &str = "AniList authorization expired; reconnect your account";

/// `createAnilistDiscoverClient(userId)` once the credentials are known
/// to be set: the user's client, or the app client when none is linked
/// (an expired link is cleared first).
async fn discover_client(ctx: &Ready<'_>, row: &Map<String, Value>) -> Result<Anilist, String> {
    let token = linked_token(row);
    if token.is_some() && token_expired(row.get("anilistTokenExpiresAt")) {
        clear_expired(ctx, row).await?;
        return Ok(Anilist::new(&ctx.state.outbound, None));
    }
    Ok(Anilist::new(&ctx.state.outbound, token))
}

/// `getAnilistUserContext(userId)`: the client and the `AniList` account
/// id, or the 404 for an unlinked account.
async fn user_context(
    ctx: &Ready<'_>,
    row: &Map<String, Value>,
) -> Result<Result<(Anilist, f64), Outcome>, String> {
    let Some(token) = linked_token(row) else {
        return Ok(Err(route_error(ctx, 404, NOT_LINKED, None)));
    };
    if token_expired(row.get("anilistTokenExpiresAt")) {
        clear_expired(ctx, row).await?;
        return Ok(Err(route_error(ctx, 404, EXPIRED, None)));
    }
    let account = match row.get("anilistUserId") {
        None => f64::NAN,
        v => jsval::number_of(v),
    };
    if !account.is_finite() || account <= 0.0 {
        return Ok(Err(route_error(ctx, 404, NOT_LINKED, None)));
    }
    Ok(Ok((
        Anilist::new(&ctx.state.outbound, Some(token)),
        account,
    )))
}

/// `handleAnilistDiscoverRouteError`, plus the public list's 404s.
fn anilist_error(
    ctx: &Ready<'_>,
    error: AnilistError,
    fallback: &str,
    public_list: bool,
) -> Outcome {
    match error {
        AnilistError::Forward(why) => Outcome::forward(why),
        AnilistError::Outage(message) => route_error(ctx, 503, &message, None),
        AnilistError::Auth(message) => route_error(ctx, 401, &message, None),
        AnilistError::RateLimited(seconds) => route_error(
            ctx,
            429,
            &AnilistError::RateLimited(seconds).message(),
            Some(seconds),
        ),
        AnilistError::GraphQl(_) | AnilistError::Http(404) if public_list => {
            route_error(ctx, 404, NOT_FOUND, None)
        }
        other @ (AnilistError::GraphQl(_) | AnilistError::Http(_) | AnilistError::Network(_)) => {
            fallback_error(ctx, fallback, &other.message())
        }
    }
}

/// `new Date()`'s month (0-based) and year in the process's local time
/// zone (`TZ`, else /etc/localtime), as `getMonth()` reads them.
fn local_month_year() -> (i64, i64) {
    use chrono::{DateTime, Datelike as _, Local};
    let now = DateTime::from_timestamp_millis(crate::clock::now_millis())
        .map_or_else(Local::now, |t| t.with_timezone(&Local));
    (i64::from(now.month0()), i64::from(now.year()))
}

fn trending<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(public_page(
        ctx,
        "/trending",
        "Unable to retrieve AniList trending anime.",
    ))
}

fn season<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(public_page(
        ctx,
        "/season",
        "Unable to retrieve AniList seasonal anime.",
    ))
}

fn popular<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(public_page(
        ctx,
        "/popular",
        "Unable to retrieve AniList popular anime.",
    ))
}

fn top<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(public_page(
        ctx,
        "/top",
        "Unable to retrieve AniList top anime.",
    ))
}

fn next_season_row<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(public_page(
        ctx,
        "/next-season",
        "Unable to retrieve AniList next-season anime.",
    ))
}

/// A public page as stored: before the sightings, `hideUnmapped` and the
/// request annotations every serve applies.
#[derive(Debug, Clone)]
struct PublicRow {
    has_more: bool,
    tiles: Vec<Value>,
}

/// Why a public page could not be computed, as the route answers it.
#[derive(Debug, Clone)]
enum PublicFail {
    /// Node's to answer.
    Forward(String),
    /// The `AniList` call failed.
    Anilist(AnilistError),
    /// Mapping or confirming the tiles failed.
    Mapping(String),
}

static PUBLIC_ROWS: LazyLock<RowCache<PublicRow, PublicFail>> = LazyLock::new(RowCache::new);

/// A public row's sort and, for the seasonal rows, its season now.
fn public_query(path: &str) -> (&'static str, Option<Season>) {
    let (sort, pick): (&str, Option<SeasonPick>) = match path {
        "/trending" => ("TRENDING_DESC", None),
        "/season" => ("POPULARITY_DESC", Some(current_season)),
        "/popular" => ("POPULARITY_DESC", None),
        "/top" => ("SCORE_DESC", None),
        _ => ("POPULARITY_DESC", Some(next_season)),
    };
    let season = pick.map(|pick| {
        let (month, year) = local_month_year();
        pick(month, year)
    });
    (sort, season)
}

/// `anilistPublicRowKey`: the user's own client answers when one is
/// linked, and the seasonal rows name their season so a new one is not
/// served stale.
fn public_row_key(path: &str, user_id: i64, season: Option<Season>, page: i64) -> String {
    let season = season.map_or_else(String::new, |s| format!("{}-{}", s.name, s.year));
    format!("anilist{path}|user:{user_id}|{season}|page:{page}")
}

/// The five public rows.
async fn public_page(ctx: &Ready<'_>, path: &str, message: &str) -> Outcome {
    let (user_id, row, query) = try_forward!(prepare(ctx, &[&PAGE_PARAMS], &page_defaults()).await);
    let page = super::providerkit::page(&query);
    let (sort, season) = public_query(path);
    if !configured(ctx) {
        return not_configured(ctx);
    }
    let source = format!("anilist{}", ctx.path_below(MOUNT));
    let stored = provider_row(
        ctx,
        &PUBLIC_ROWS,
        &public_row_key(path, user_id, season, page),
        crate::anilist::PAGE_TTL,
        Box::pin(public_tiles(ctx, &row, (sort, season), page, &source)),
        refresh_public,
    )
    .await;
    let stored = match stored {
        Ok(stored) => stored,
        Err(PublicFail::Forward(why)) => return Outcome::forward(why),
        Err(PublicFail::Anilist(e)) => return anilist_error(ctx, e, message, false),
        Err(PublicFail::Mapping(why)) => return fallback_error(ctx, message, &why),
    };
    match serve_tiles(ctx, stored.tiles.clone(), &source, &query).await {
        Ok(results) => ctx.json(&page_body(page, stored.has_more, results, &[])),
        Err(why) => fallback_error(ctx, message, &why),
    }
}

/// A public page computed: the `AniList` page, mapped, confirmed, drawn.
async fn public_tiles(
    ctx: &Ready<'_>,
    row: &Map<String, Value>,
    (sort, season): (&str, Option<Season>),
    page: i64,
    source: &str,
) -> Result<PublicRow, PublicFail> {
    let client = discover_client(ctx, row)
        .await
        .map_err(PublicFail::Forward)?;
    let media_page = client
        .media_page(page, sort, season)
        .await
        .map_err(PublicFail::Anilist)?;
    let mapped = map_media(ctx, media_page.media)
        .await
        .map_err(PublicFail::Mapping)?;
    Ok(PublicRow {
        has_more: media_page.has_next_page,
        tiles: anilist_tiles(ctx, mapped, source)
            .await
            .map_err(PublicFail::Mapping)?,
    })
}

/// A stale public page computed again from its request.
fn refresh_public<'a>(
    ctx: &'a Ready<'a>,
) -> Pin<Box<dyn Future<Output = Result<PublicRow, PublicFail>> + Send + 'a>> {
    Box::pin(async move {
        let (_, row, query) = prepare(ctx, &[&PAGE_PARAMS], &page_defaults())
            .await
            .map_err(|why| PublicFail::Forward(why.why))?;
        let path = ctx.path_below(MOUNT);
        public_tiles(
            ctx,
            &row,
            public_query(&path),
            super::providerkit::page(&query),
            &format!("anilist{path}"),
        )
        .await
    })
}

/// `mapAnilistMediaList(media)` in bodies Node's JSON parser accepts: a
/// hundred media at a time, deduplicated across chunks as one pass would.
async fn map_media(ctx: &Ready<'_>, media: Vec<Value>) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for chunk in media.chunks(100) {
        append_unique(
            &mut out,
            &mut seen,
            anilist_media_list(ctx, chunk.to_vec()).await?,
        );
    }
    Ok(out)
}

/// `appendUnique`: mapped entries in order, without a repeat of an
/// `AniList` id or of a TMDB id.
fn append_unique(out: &mut Vec<Value>, seen: &mut HashSet<String>, items: Vec<Value>) {
    for item in items {
        let anilist_key = format!("anilist:{}", jsval::string_of(item.get("anilistId")));
        if !seen.insert(anilist_key) {
            continue;
        }
        if has_discover_tmdb_id(item.get("tmdbId")) {
            let tmdb_key = format!(
                "{}:{}",
                jsval::string_of(item.get("mediaType")),
                jsval::string_of(item.get("tmdbId"))
            );
            if !seen.insert(tmdb_key) {
                continue;
            }
        }
        out.push(item);
    }
}

/// `ANILIST_LIST_PAGE_SIZE`.
const LIST_PAGE_SIZE: i64 = 20;

/// `mapAnilistMediaPage(media, page)`: the page `mapAnilistMediaList`
/// over the whole list and then `paginateItems` would give, mapping only
/// the entries up to the end of that page and one more (for `hasMore`), in
/// order, a batch at a time. A batch is never larger than the tiles still
/// missing (an entry yields at most one) nor than a hundred media.
async fn map_media_page<F, Fut>(
    media: Vec<Value>,
    page: i64,
    mut map_batch: F,
) -> Result<(Vec<Value>, bool, i64), String>
where
    F: FnMut(Vec<Value>) -> Fut,
    Fut: Future<Output = Result<Vec<Value>, String>>,
{
    let page = page.max(1);
    let start = (page - 1).saturating_mul(LIST_PAGE_SIZE);
    let wanted = usize::try_from(start.saturating_add(LIST_PAGE_SIZE + 1)).unwrap_or(usize::MAX);
    let mut mapped = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut next = 0;
    while mapped.len() < wanted && next < media.len() {
        let take = (wanted - mapped.len()).min(100).min(media.len() - next);
        let batch = media.get(next..next + take).unwrap_or_default().to_vec();
        next += take;
        append_unique(&mut mapped, &mut seen, map_batch(batch).await?);
    }
    let has_more = start + LIST_PAGE_SIZE < super::params::count(mapped.len());
    let range = super::params::slice_range(mapped.len(), start, start + LIST_PAGE_SIZE);
    Ok((
        mapped
            .into_iter()
            .skip(range.start)
            .take(range.len())
            .collect(),
        has_more,
        page,
    ))
}

/// `toWatchlistItems(items)`.
fn to_watchlist_item(item: &Value) -> Value {
    let anilist_id = item.get("anilistId").cloned().unwrap_or(Value::Null);
    let id_text = jsval::string_of(Some(&anilist_id));
    let tmdb = item.get("tmdbId").filter(|t| has_discover_tmdb_id(Some(t)));
    let mut out = Map::new();
    out.insert(
        String::from("id"),
        tmdb.cloned().unwrap_or_else(|| anilist_id.clone()),
    );
    out.insert(
        String::from("ratingKey"),
        Value::from(format!("anilist-{id_text}")),
    );
    if let Some(tmdb) = tmdb {
        out.insert(String::from("tmdbId"), tmdb.clone());
    }
    for key in ["mediaType", "title"] {
        if let Some(v) = item.get(key) {
            out.insert(String::from(key), v.clone());
        }
    }
    out.insert(String::from("source"), Value::from("anilist"));
    out.insert(String::from("sourceId"), Value::from(id_text.as_str()));
    out.insert(
        String::from("sourceUrl"),
        Value::from(format!("https://anilist.co/anime/{id_text}")),
    );
    if let Some(image) = item.get("image").filter(|i| truthy(Some(i))) {
        out.insert(String::from("image"), image.clone());
    }
    Value::Object(out)
}

/// `anilistResults(items, req)`.
async fn anilist_results(
    ctx: &Ready<'_>,
    mapped: Vec<Value>,
    source: &str,
    query: &Query,
) -> Result<Vec<Value>, String> {
    let tiles = anilist_tiles(ctx, mapped, source).await?;
    serve_tiles(ctx, tiles, source, query).await
}

/// `anilistTiles`: the tiles of `mapped`, confirmed and drawn, the part
/// of a row worth storing.
async fn anilist_tiles(
    ctx: &Ready<'_>,
    mapped: Vec<Value>,
    source: &str,
) -> Result<Vec<Value>, String> {
    let items: Vec<Value> = mapped.iter().map(to_watchlist_item).collect();
    let wanted: Vec<usize> = items
        .iter()
        .enumerate()
        .filter(|(_, i)| truthy(i.get("tmdbId")) && truthy(i.get("mediaType")))
        .map(|(n, _)| n)
        .collect();
    let requests: Vec<Value> = wanted
        .iter()
        .filter_map(|n| items.get(*n))
        .map(|item| {
            let mut req = Map::new();
            for key in ["tmdbId", "mediaType", "title"] {
                if let Some(v) = item.get(key) {
                    req.insert(String::from(key), v.clone());
                }
            }
            let source_id = item.get("sourceId").cloned().unwrap_or(Value::Null);
            let refs = if truthy(Some(&source_id)) {
                vec![json!({"ns": "anilist", "id": source_id})]
            } else {
                Vec::new()
            };
            req.insert(String::from("refs"), Value::Array(refs));
            Value::Object(req)
        })
        .collect();
    let confirmed = if requests.is_empty() {
        Vec::new()
    } else {
        confirm_or_repair(ctx, requests, json!({ "discoverSource": source })).await?
    };
    let merged: Vec<Value> = items
        .into_iter()
        .enumerate()
        .map(|(n, item)| {
            let result = wanted
                .iter()
                .position(|w| *w == n)
                .and_then(|p| confirmed.get(p))
                .filter(|c| c.is_object());
            merge_confirmed(item, result)
        })
        .collect();
    with_tmdb_posters(ctx, merged).await
}

/// `serveAnilistTiles`: what every serve does with stored tiles
/// (sightings, `hideUnmapped`, requests).
async fn serve_tiles(
    ctx: &Ready<'_>,
    tiles: Vec<Value>,
    source: &str,
    query: &Query,
) -> Result<Vec<Value>, String> {
    record_unmapped(
        ctx,
        &tiles,
        json!({ "namespace": "anilist", "discoverSource": source }),
    )
    .await?;
    let shown = omit_unmapped(tiles, query.truthy("hideUnmapped"));
    Ok(annotate_provider_active_requests(ctx, shown).await)
}

/// The spread in `anilistResults`: a repaired id replaces `tmdbId` and
/// `id`, then `mappingState` goes last.
fn merge_confirmed(item: Value, confirmed: Option<&Value>) -> Value {
    let Value::Object(mut map) = item else {
        return item;
    };
    let had_tmdb = truthy(map.get("tmdbId"));
    let source_id = map.get("sourceId").cloned();
    if let Some(confirmed) = confirmed {
        if let Some(tmdb) = confirmed.get("tmdbId").filter(|v| !v.is_null()) {
            map.insert(String::from("tmdbId"), tmdb.clone());
            map.insert(String::from("id"), tmdb.clone());
        } else {
            map.shift_remove("tmdbId");
            let n = jsval::number_of(source_id.as_ref());
            map.insert(String::from("id"), jsval::num(n));
        }
        if let Some(kind) = confirmed.get("mediaType").filter(|k| truthy(Some(k))) {
            map.insert(String::from("mediaType"), kind.clone());
        }
    }
    let state = confirmed
        .and_then(|c| c.get("mappingState"))
        .filter(|s| !s.is_null())
        .cloned();
    let state = state.unwrap_or_else(|| {
        let mut s = Map::new();
        s.insert(
            String::from("state"),
            Value::from(if had_tmdb { "mapped" } else { "unmapped" }),
        );
        s.insert(String::from("namespace"), Value::from("anilist"));
        if let Some(id) = source_id.filter(|v| truthy(Some(v))) {
            s.insert(String::from("externalId"), id);
        }
        Value::Object(s)
    });
    map.insert(String::from("mappingState"), state);
    Value::Object(map)
}

/// A list matcher; `Err` where Node's matcher would throw.
type Matcher<'m> =
    dyn Fn(Option<&Value>, Option<&Value>) -> Result<bool, String> + Send + Sync + 'm;

/// `list.status === STATUS || list.name.toLowerCase() === name`.
fn status_matcher(
    status: &'static str,
    name: &'static str,
) -> impl Fn(Option<&Value>, Option<&Value>) -> Result<bool, String> + Send + Sync {
    move |list_name, list_status| {
        if list_status.and_then(Value::as_str) == Some(status) {
            return Ok(true);
        }
        match list_name {
            Some(Value::String(n)) => Ok(n.to_lowercase() == name),
            _ => Err(String::from("a list name that isn't text")),
        }
    }
}

/// `matchesListName(list, name)`.
fn matches_list_name(
    list_name: Option<&Value>,
    status: Option<&Value>,
    name: &str,
) -> Result<bool, String> {
    let requested = jsval::trim(name).to_lowercase();
    if requested.is_empty() {
        return Ok(false);
    }
    let Some(Value::String(list_name)) = list_name else {
        return Err(String::from("a list name that isn't text"));
    };
    if jsval::trim(list_name).to_lowercase() == requested {
        return Ok(true);
    }
    let status = status.filter(|s| truthy(Some(s)));
    let Some(status) = status else {
        return Ok(false);
    };
    let Some(text) = status.as_str() else {
        return Err(String::from("a list status that isn't text"));
    };
    let Some(label) = status_list_name(text) else {
        return Err(String::from("a list status without a name"));
    };
    Ok(label.to_lowercase() == requested || text.to_lowercase() == requested)
}

/// `collectUserListItems`'s walk: the matching lists' media, each once.
fn collect_media(lists: &[Value], matcher: &Matcher<'_>) -> Result<Vec<Value>, String> {
    let mut media = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for list in lists {
        let Value::Object(list) = list else {
            return Err(String::from("a list that isn't an object"));
        };
        let status = list.get("status").filter(|s| !s.is_null());
        if !matcher(list.get("name"), status)? {
            continue;
        }
        let entries = match list.get("entries") {
            None | Some(Value::Null) => continue,
            Some(Value::Array(entries)) => entries,
            Some(_) => return Err(String::from("entries that aren't an array")),
        };
        for entry in entries {
            if entry.is_null() {
                return Err(String::from("a null list entry"));
            }
            let entry_media = entry.get("media").filter(|m| !m.is_null());
            let id = entry_media.and_then(|m| m.get("id"));
            if !truthy(id) {
                continue;
            }
            let key = id.map(Value::to_string).unwrap_or_default();
            if !seen.insert(key) {
                continue;
            }
            if let Some(m) = entry_media {
                media.push(m.clone());
            }
        }
    }
    Ok(media)
}

fn watching<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move { user_list(ctx, &status_matcher("CURRENT", "watching")).await })
}

fn planning<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move { user_list(ctx, &status_matcher("PLANNING", "planning")).await })
}

fn completed<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move { user_list(ctx, &status_matcher("COMPLETED", "completed")).await })
}

fn paused<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move { user_list(ctx, &status_matcher("PAUSED", "paused")).await })
}

fn dropped<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move { user_list(ctx, &status_matcher("DROPPED", "dropped")).await })
}

const LIST_FAILED: &str = "Unable to retrieve AniList list.";

/// `userList`: one of the linked account's status lists.
async fn user_list(ctx: &Ready<'_>, matcher: &Matcher<'_>) -> Outcome {
    let (_, row, query) = try_forward!(prepare(ctx, &[&PAGE_PARAMS], &page_defaults()).await);
    linked_list(ctx, &row, &query, matcher, &[]).await
}

/// A list of the linked account: context, collection, page, tiles.
async fn linked_list(
    ctx: &Ready<'_>,
    row: &Map<String, Value>,
    query: &Query,
    matcher: &Matcher<'_>,
    extra: &[(&str, Value)],
) -> Outcome {
    let page = super::providerkit::page(query);
    if !configured(ctx) {
        return not_configured(ctx);
    }
    let (client, account) = match try_forward!(user_context(ctx, row).await) {
        Ok(context) => context,
        Err(outcome) => return outcome,
    };
    let lists = match client.media_list_collection(&jsval::num(account)).await {
        Ok(lists) => lists,
        Err(e) => return anilist_error(ctx, e, LIST_FAILED, false),
    };
    let media = try_forward!(collect_media(&lists, matcher));
    // Only the requested page is mapped, not the whole list.
    let paged = map_media_page(media, page, |batch| anilist_media_list(ctx, batch)).await;
    let (slice, has_more, page) = match paged {
        Ok(paged) => paged,
        Err(why) => return fallback_error(ctx, LIST_FAILED, &why),
    };
    match anilist_results(
        ctx,
        slice,
        &format!("anilist{}", ctx.path_below(MOUNT)),
        query,
    )
    .await
    {
        Ok(results) => ctx.json(&page_body(page, has_more, results, extra)),
        Err(why) => fallback_error(ctx, LIST_FAILED, &why),
    }
}

/// `GET /discover/anilist/lists`.
fn lists<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let user_id = try_forward!(ctx.authenticated(0)).id;
        let row = try_forward!(super::providerkit::user_settings(ctx, user_id).await);
        if !configured(ctx) {
            return not_configured(ctx);
        }
        let (client, account) = match try_forward!(user_context(ctx, &row).await) {
            Ok(context) => context,
            Err(outcome) => return outcome,
        };
        let lists = match client.media_list_collection(&jsval::num(account)).await {
            Ok(lists) => lists,
            Err(e) => return anilist_error(ctx, e, "Unable to retrieve AniList lists.", false),
        };
        let mut results = Vec::with_capacity(lists.len());
        for list in &lists {
            let Value::Object(list) = list else {
                return Outcome::forward(String::from("a list that isn't an object"));
            };
            results.push(list_summary(list));
        }
        let mut body = Map::new();
        body.insert(String::from("results"), Value::Array(results));
        ctx.json(&Value::Object(body))
    })
}

/// `listUserAniListLists`' summary of one list.
fn list_summary(list: &Map<String, Value>) -> Value {
    let mut out = Map::new();
    if let Some(name) = list.get("name") {
        out.insert(String::from("name"), name.clone());
    }
    out.insert(
        String::from("status"),
        list.get("status").cloned().unwrap_or(Value::Null),
    );
    out.insert(
        String::from("isCustomList"),
        Value::Bool(truthy(list.get("isCustomList"))),
    );
    let count = match list.get("entries") {
        Some(Value::Array(entries)) => entries.len(),
        Some(Value::String(s)) => s.encode_utf16().count(),
        None | Some(Value::Null | Value::Bool(_) | Value::Number(_) | Value::Object(_)) => 0,
    };
    out.insert(String::from("itemCount"), Value::from(count));
    Value::Object(out)
}

/// `GET /discover/anilist/list`: by name from the linked account, or
/// anyone's public list by link.
fn list<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let (_, row, query) =
            try_forward!(prepare(ctx, &[&PAGE_PARAMS, &LIST_PARAMS], &page_defaults()).await);
        let url = jsval::trim(&query.text("url")).to_owned();
        if !url.is_empty() {
            return public_list(ctx, &row, &query, &url).await;
        }
        let name = jsval::trim(&query.text("name")).to_owned();
        if name.is_empty() {
            return route_error(ctx, 400, "name query parameter is required", None);
        }
        let matcher = |list_name: Option<&Value>, status: Option<&Value>| {
            matches_list_name(list_name, status, &name)
        };
        let title = Value::from(name.as_str());
        linked_list(ctx, &row, &query, &matcher, &[("title", title)]).await
    })
}

/// `publicList`.
async fn public_list(
    ctx: &Ready<'_>,
    row: &Map<String, Value>,
    query: &Query,
    url: &str,
) -> Outcome {
    let (user_name, list_name) = match parse_list_url(url) {
        Ok(owner) => owner,
        Err(message) => return route_error(ctx, 400, &message, None),
    };
    let page = super::providerkit::page(query);
    if !configured(ctx) {
        return not_configured(ctx);
    }
    let client = try_forward!(discover_client(ctx, row).await);
    let lists = match client
        .media_list_collection(&Value::from(user_name.as_str()))
        .await
    {
        Ok(lists) => lists,
        Err(e) => return anilist_error(ctx, e, LIST_FAILED, true),
    };
    let matcher = |name: Option<&Value>, status: Option<&Value>| {
        list_name
            .as_ref()
            .map_or(Ok(true), |wanted| matches_list_name(name, status, wanted))
    };
    let media = try_forward!(collect_media(&lists, &matcher));
    let paged = map_media_page(media, page, |batch| anilist_media_list(ctx, batch)).await;
    let (slice, has_more, page) = match paged {
        Ok(paged) => paged,
        Err(why) => return fallback_error(ctx, LIST_FAILED, &why),
    };
    let title = list_name.as_ref().map_or_else(
        || format!("{user_name}'s Anime List"),
        |l| format!("{l} · {user_name}"),
    );
    match anilist_results(ctx, slice, "anilist/list", query).await {
        Ok(results) => ctx.json(&page_body(
            page,
            has_more,
            results,
            &[("title", Value::from(title))],
        )),
        Err(why) => fallback_error(ctx, LIST_FAILED, &why),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watchlist_items() {
        let mapped = json!({"anilistId": 21, "tmdbId": 37854, "mediaType": "tv", "title": "One Piece", "image": "https://img/x.jpg"});
        assert_eq!(
            to_watchlist_item(&mapped),
            json!({"id": 37854, "ratingKey": "anilist-21", "tmdbId": 37854, "mediaType": "tv", "title": "One Piece",
                   "source": "anilist", "sourceId": "21", "sourceUrl": "https://anilist.co/anime/21", "image": "https://img/x.jpg"}),
            "mapped tile"
        );
        let unmapped =
            to_watchlist_item(&json!({"anilistId": 5, "mediaType": "movie", "title": "X"}));
        assert_eq!(unmapped.get("id"), Some(&json!(5)), "anilist id stands in");
        let merged = merge_confirmed(unmapped, None);
        assert_eq!(
            merged.get("mappingState"),
            Some(&json!({"state": "unmapped", "namespace": "anilist", "externalId": "5"})),
            "default mapping state"
        );
        let repaired = merge_confirmed(
            to_watchlist_item(&mapped),
            Some(
                &json!({"mediaType": "movie", "mappingState": {"state": "unmapped", "sourceKey": "manual"}}),
            ),
        );
        assert_eq!(
            repaired,
            json!({"id": 21, "ratingKey": "anilist-21", "mediaType": "movie", "title": "One Piece", "source": "anilist",
                   "sourceId": "21", "sourceUrl": "https://anilist.co/anime/21", "image": "https://img/x.jpg",
                   "mappingState": {"state": "unmapped", "sourceKey": "manual"}}),
            "dead id falls back to the AniList id"
        );
    }

    /// What mapping the whole list and then paging gave: entries divisible
    /// by 7 drop out, every fifth shares a TMDB show with the one before.
    fn fake_map(seen: &std::sync::Mutex<Vec<i64>>, batch: &[Value]) -> Vec<Value> {
        batch
            .iter()
            .filter_map(|m| {
                let id = m.get("id").and_then(Value::as_i64).unwrap_or_default();
                crate::sync::lock(seen).push(id);
                let tmdb = if id % 5 == 0 { 999 + id } else { 1000 + id };
                (id % 7 != 0).then(|| json!({"anilistId": id, "tmdbId": tmdb, "mediaType": "tv"}))
            })
            .collect()
    }

    #[tokio::test]
    async fn pages_like_the_whole_list() {
        let media: Vec<Value> = (1..=95).map(|id| json!({"id": id})).collect();
        let none = std::sync::Mutex::new(Vec::new());
        let mut all = Vec::new();
        append_unique(&mut all, &mut HashSet::new(), fake_map(&none, &media));
        for page in [0, 1, 2, 3, 4, 5, 6] {
            let got = map_media_page(media.clone(), page, |batch| {
                let out = fake_map(&none, &batch);
                async move { Ok(out) }
            })
            .await;
            let start = usize::try_from((page.max(1) - 1) * 20).unwrap_or_default();
            let want: Vec<Value> = all.iter().skip(start).take(20).cloned().collect();
            assert_eq!(
                got,
                Ok((want, start + 20 < all.len(), page.max(1))),
                "page {page}"
            );
        }
        let mapped = std::sync::Mutex::new(Vec::new());
        let first = map_media_page(media, 1, |batch| {
            let out = fake_map(&mapped, &batch);
            async move { Ok(out) }
        })
        .await;
        assert_eq!(
            first.map(|(tiles, more, _)| (tiles.len(), more)),
            Ok((20, true)),
            "first page"
        );
        let mapped = crate::sync::lock(&mapped).clone();
        assert!(mapped.len() < 30, "mapped {} of 95", mapped.len());
        assert_eq!(
            mapped,
            (1..=crate::routes::params::count(mapped.len())).collect::<Vec<_>>(),
            "a prefix, once each"
        );
    }

    #[test]
    fn public_row_keys() {
        let winter = Season {
            name: "WINTER",
            year: 2026,
        };
        assert_eq!(
            public_row_key("/season", 4, Some(winter), 2),
            "anilist/season|user:4|WINTER-2026|page:2",
            "a seasonal row names its season"
        );
        assert_eq!(
            public_row_key("/trending", 0, None, 1),
            "anilist/trending|user:0||page:1",
            "trending"
        );
        let (_, season) = public_query("/next-season");
        assert!(season.is_some(), "next season is seasonal");
        assert_eq!(public_query("/top"), ("SCORE_DESC", None), "top");
    }

    #[test]
    fn list_matching() {
        let watching = status_matcher("CURRENT", "watching");
        assert_eq!(
            watching(Some(&json!("Watching")), None),
            Ok(true),
            "by name"
        );
        assert_eq!(
            watching(None, Some(&json!("CURRENT"))),
            Ok(true),
            "by status"
        );
        assert!(
            watching(None, Some(&json!("PAUSED"))).is_err(),
            "no name throws"
        );
        assert_eq!(
            matches_list_name(Some(&json!("Custom")), Some(&json!("PAUSED")), " paused "),
            Ok(true),
            "status label"
        );
        assert_eq!(
            matches_list_name(Some(&json!(" My List ")), None, "my list"),
            Ok(true),
            "trimmed name"
        );
        let lists = vec![
            json!({"name": "Watching", "status": "CURRENT", "entries": [{"media": {"id": 1}}, {"media": {"id": 2}}]}),
            json!({"name": "Rewatch", "status": "REPEATING", "entries": [{"media": {"id": 1}}, {"media": null}]}),
        ];
        let all = |_: Option<&Value>, _: Option<&Value>| Ok(true);
        assert_eq!(
            collect_media(&lists, &all).map(|m| m.len()),
            Ok(2),
            "deduplicated"
        );
        let empty = Map::new();
        assert_eq!(
            list_summary(lists.first().and_then(Value::as_object).unwrap_or(&empty)),
            json!({"name": "Watching", "status": "CURRENT", "isCustomList": false, "itemCount": 2}),
            "summary"
        );
        assert!(!token_expired(Some(&json!("0"))), "zero never expires");
        assert!(token_expired(Some(&json!(1))), "the past");
    }
}
