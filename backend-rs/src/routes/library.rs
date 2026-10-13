//! `GET /library/*` (`server/routes/library.ts`): the Library tab, read
//! from the signed-in user's linked Jellyfin account. Mounted behind
//! `isAuthenticated()`, so any signed-in user.

use std::future::Future;
use std::pin::Pin;

use axum::body::Body;
use axum::http::{header, HeaderValue, Method, Response};
use serde_json::{Map, Value};

use super::blocklist::plain_integer;
use super::{Outcome, Ready, Table};
use crate::auth::CurrentUser;
use crate::jellyfin::{js_trim, MAX_SAFE_INTEGER};
use crate::library::{ImageOutcome, Lib, Page, WatchNowFail};
use crate::librarymap::{is_jellyfin_item_id, BrowseQuery};
use crate::tmdb::js_numbers;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/library/watch-now", Method::GET, watch_now),
    ("/api/v1/library/available", Method::GET, available),
    ("/api/v1/library/search", Method::GET, search),
    ("/api/v1/library/browse", Method::GET, browse),
    ("/api/v1/library/facets", Method::GET, facets),
    ("/api/v1/library/items/{id}", Method::GET, item),
    (
        "/api/v1/library/items/{id}/images/{image_type}",
        Method::GET,
        image,
    ),
    ("/api/v1/library/series/{id}", Method::GET, series),
    (
        "/api/v1/library/series/{id}/seasons/{season}/episodes",
        Method::GET,
        episodes,
    ),
];

/// Most `genre` values taken here; more go to Node.
const MAX_GENRES: usize = 20;

fn lib<'a>(ctx: &'a Ready<'a>, user: &CurrentUser) -> Lib<'a> {
    Lib {
        state: ctx.state,
        settings: &ctx.settings,
        user_id: user.id,
    }
}

/// The JSON answer for a payload, or Node for a reason.
fn answer(ctx: &Ready<'_>, result: Result<Value, String>) -> Outcome {
    match result {
        Ok(value) => ctx.json(&js_numbers(value)),
        Err(why) => Outcome::forward(why),
    }
}

/// A path segment `depth` places from the end, decoded as Express hands
/// it over (one it can't decode is Node's).
fn segment(ctx: &Ready<'_>, depth: usize) -> Result<String, String> {
    ctx.req
        .uri
        .path()
        .rsplit('/')
        .nth(depth)
        .and_then(super::nodestate::decode_segment)
        .ok_or_else(|| String::from("a path segment Express can't decode"))
}

/// The pairs of a query string, decoded. Characters the validator calls
/// "not url encoded" and empty values (which it may reject) go to Node.
fn query_pairs(raw: &str) -> Result<Vec<(&str, String)>, String> {
    let mut pairs = Vec::new();
    for pair in raw.split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let Some(value) = super::user::decode_query_value(value) else {
            return Err(String::from(
                "a reserved or malformed character in a query value",
            ));
        };
        if value.is_empty() {
            return Err(String::from("an empty query value"));
        }
        pairs.push((key, value));
    }
    Ok(pairs)
}

/// A non-negative safe integer as the validator coerces it.
fn safe_int(value: &str) -> Result<i64, String> {
    plain_integer(value)
        .filter(|n| *n <= MAX_SAFE_INTEGER)
        .ok_or_else(|| String::from("a number that isn't a plain integer"))
}

fn one_of(value: &str, allowed: &[&'static str]) -> Result<&'static str, String> {
    allowed
        .iter()
        .find(|a| **a == value)
        .copied()
        .ok_or_else(|| String::from("a value outside the enum; the validator answers 400"))
}

fn repeated(seen: &mut Vec<String>, key: &str) -> Result<(), String> {
    if seen.iter().any(|k| k == key) {
        return Err(String::from("a repeated query key"));
    }
    seen.push(key.to_owned());
    Ok(())
}

/// `parseAvailableQuery` plus `q`.
#[derive(Debug, Clone, PartialEq)]
struct AvailableQuery {
    /// `Math.min(Math.max(Number(take) || 20, 1), 50)`.
    take: i64,
    /// `Math.max(Number(skip) || 0, 0)`.
    skip: i64,
    media_type: Option<&'static str>,
    q: Option<String>,
}

fn parse_available(raw: &str) -> Result<AvailableQuery, String> {
    let mut query = AvailableQuery {
        take: 20,
        skip: 0,
        media_type: None,
        q: None,
    };
    let mut seen = Vec::new();
    for (key, value) in query_pairs(raw)? {
        repeated(&mut seen, key)?;
        match key {
            "take" => {
                query.take = match safe_int(&value)? {
                    0 => 20,
                    n => n.clamp(1, 50),
                };
            }
            "skip" => query.skip = safe_int(&value)?,
            "mediaType" => query.media_type = Some(one_of(&value, &["movie", "tv"])?),
            "q" => query.q = Some(value),
            _ => {
                return Err(String::from(
                    "an unknown query key; the validator answers 400",
                ))
            }
        }
    }
    Ok(query)
}

/// `parseLibraryBrowseQuery`.
fn parse_browse(raw: &str) -> Result<BrowseQuery, String> {
    let mut query = BrowseQuery {
        q: None,
        media_type: None,
        watched: None,
        genre: None,
        year_from: None,
        year_to: None,
        sort: "dateAdded",
        order: "desc",
        take: 24,
        skip: 0,
    };
    let mut seen = Vec::new();
    let mut genres: Vec<String> = Vec::new();
    let mut genre_values = 0;
    for (key, value) in query_pairs(raw)? {
        if key == "genre" {
            genre_values += 1;
            if genre_values > MAX_GENRES {
                return Err(String::from("many genre values"));
            }
            genres.extend(
                value
                    .split(',')
                    .map(js_trim)
                    .filter(|g| !g.is_empty())
                    .map(str::to_owned),
            );
            continue;
        }
        repeated(&mut seen, key)?;
        match key {
            "q" => query.q = Some(js_trim(&value).to_owned()).filter(|q| !q.is_empty()),
            "mediaType" => query.media_type = Some(one_of(&value, &["movie", "tv"])?),
            "watched" => {
                query.watched = Some(one_of(&value, &["unwatched", "inProgress", "played"])?);
            }
            "sort" => {
                query.sort = one_of(
                    &value,
                    &["dateAdded", "title", "premiereDate", "lastPlayed"],
                )?;
            }
            "order" => query.order = one_of(&value, &["asc", "desc"])?,
            "yearFrom" => query.year_from = Some(safe_int(&value)?),
            "yearTo" => query.year_to = Some(safe_int(&value)?),
            "take" => query.take = safe_int(&value)?.clamp(1, 50),
            "skip" => query.skip = safe_int(&value)?,
            _ => {
                return Err(String::from(
                    "an unknown query key; the validator answers 400",
                ))
            }
        }
    }
    if !genres.is_empty() {
        query.genre = Some(genres);
    }
    Ok(query)
}

/// `GET /library/facets`'s only parameter.
fn parse_facets(raw: &str) -> Result<Option<&'static str>, String> {
    let mut media_type = None;
    let mut seen = Vec::new();
    for (key, value) in query_pairs(raw)? {
        repeated(&mut seen, key)?;
        match key {
            "mediaType" => media_type = Some(one_of(&value, &["movie", "tv"])?),
            _ => {
                return Err(String::from(
                    "an unknown query key; the validator answers 400",
                ))
            }
        }
    }
    Ok(media_type)
}

/// `parseAvailableQuery` and `q` on what the validator left.
fn validated_available(q: &Map<String, Value>) -> Result<AvailableQuery, super::Fallback> {
    use super::params::int_or;
    let media_type = match q.get("mediaType").and_then(Value::as_str) {
        Some("movie") => Some("movie"),
        Some("tv") => Some("tv"),
        Some(_) | None => None,
    };
    Ok(AvailableQuery {
        take: int_or(q.get("take"), "take", 20)?.clamp(1, 50),
        skip: int_or(q.get("skip"), "skip", 0)?.max(0),
        media_type,
        q: q.get("q").and_then(Value::as_str).map(str::to_owned),
    })
}

/// `first(value)` of `parseLibraryBrowseQuery`: the first of an array, a
/// string or number as `String()`, else nothing.
fn first(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::Array(items) => first(items.first()),
        v @ (Value::String(_) | Value::Number(_)) => {
            Some(crate::media::js_string(Some(v)).into_owned())
        }
        Value::Null | Value::Bool(_) | Value::Object(_) => None,
    }
}

/// `asInt`: the value as an integer, when it is one.
fn as_int(value: Option<&Value>) -> Option<i64> {
    super::params::integer(first(value)?.trim())
}

/// `parseLibraryBrowseQuery` on what the validator left: the query (`Err`
/// with a reason when a number is past what this port carries), and
/// `take` and `skip` as the page info prints them.
fn validated_browse(q: &Map<String, Value>) -> (Result<BrowseQuery, String>, i64, i64) {
    let take = as_int(q.get("take")).unwrap_or(24).clamp(1, 50);
    let skip = as_int(q.get("skip")).unwrap_or(0).max(0);
    (browse_query(q, take, skip), take, skip)
}

fn browse_query(q: &Map<String, Value>, take: i64, skip: i64) -> Result<BrowseQuery, String> {
    let as_enum = |key: &str, allowed: &[&'static str]| -> Option<&'static str> {
        let raw = first(q.get(key))?;
        allowed.iter().find(|a| **a == raw).copied()
    };
    let genres: Vec<String> = match q.get("genre") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::String(s)) if s.is_empty() => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .flat_map(|item| {
                crate::media::js_string(Some(item))
                    .split(',')
                    .map(|g| js_trim(g).to_owned())
                    .collect::<Vec<_>>()
            })
            .filter(|g| !g.is_empty())
            .collect(),
        Some(other) => crate::media::js_string(Some(other))
            .split(',')
            .map(|g| js_trim(g).to_owned())
            .filter(|g| !g.is_empty())
            .collect(),
    };
    if genres.len() > MAX_GENRES {
        return Err(String::from("many genre values"));
    }
    Ok(BrowseQuery {
        q: first(q.get("q"))
            .map(|v| js_trim(&v).to_owned())
            .filter(|v| !v.is_empty()),
        media_type: as_enum("mediaType", &["movie", "tv"]),
        watched: as_enum("watched", &["unwatched", "inProgress", "played"]),
        genre: (!genres.is_empty()).then_some(genres),
        year_from: as_int(q.get("yearFrom")),
        year_to: as_int(q.get("yearTo")),
        sort: as_enum(
            "sort",
            &["dateAdded", "title", "premiereDate", "lastPlayed"],
        )
        .unwrap_or("dateAdded"),
        order: as_enum("order", &["asc", "desc"]).unwrap_or("desc"),
        take,
        skip,
    })
}

/// The empty page of a user without a linked Jellyfin (`None` when there
/// is one).
async fn unlinked(lib: &Lib<'_>) -> Result<Option<Page>, String> {
    Ok(match lib.link().await? {
        crate::library::Link::Code(code) => Some(Page {
            results: Vec::new(),
            total: 0.0,
            code: Some(code),
        }),
        crate::library::Link::Linked(_) => None,
    })
}

/// `availablePage`'s `pageInfo` (at least one page).
fn js_page_info(total: f64, take: i64, skip: i64) -> Value {
    let size = take.max(1);
    let pages = (total / crate::jsnum::from_i64(size)).ceil();
    let pages = if pages >= 1.0 { pages } else { 1.0 };
    let mut info = Map::new();
    info.insert(String::from("pages"), crate::jsval::num(pages));
    info.insert(String::from("pageSize"), Value::from(take));
    info.insert(String::from("results"), crate::jsval::num(total));
    info.insert(String::from("page"), Value::from(skip / size + 1));
    Value::Object(info)
}

/// `{ pageInfo, results, ...(code ? { code } : {}) }`.
fn page_json(page: Page, take: i64, skip: i64) -> Value {
    let mut out = Map::new();
    out.insert(
        String::from("pageInfo"),
        js_page_info(page.total, take, skip),
    );
    out.insert(String::from("results"), Value::Array(page.results));
    if let Some(code) = page.code {
        out.insert(String::from("code"), Value::from(code));
    }
    Value::Object(out)
}

/// `GET /library/watch-now`.
fn watch_now<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user = match ctx.no_query().and_then(|()| ctx.authenticated(0)) {
            Ok(user) => user,
            Err(why) => return Outcome::forward(why),
        };
        match lib(ctx, user).watch_now().await {
            Ok(value) => ctx.json(&js_numbers(value)),
            Err(WatchNowFail::Forward(why)) => Outcome::forward(why),
            // The skipped-episode cleanup has marked episodes watched.
            Err(WatchNowFail::Failed(why)) => {
                tracing::error!("Failed to load library shelves after the cleanup: {why}");
                ctx.error(500, "Failed to load library shelves")
            }
        }
    })
}

/// `listAvailableRoute`: `/available` and `/search` (which needs `q`).
async fn list_available(ctx: &Ready<'_>, require_query: bool) -> Outcome {
    let user = match ctx.authenticated(0) {
        Ok(user) => user,
        Err(why) => return Outcome::forward(why),
    };
    let validated = super::params::query(ctx);
    let query = validated.as_ref().map_or_else(
        || parse_available(ctx.req.uri.query().unwrap_or("")).map_err(super::Fallback::from),
        validated_available,
    );
    let query = match query {
        Ok(query) => query,
        Err(why) => return Outcome::forward(why),
    };
    if require_query && query.q.is_none() && validated.is_none() {
        return Outcome::forward(String::from("q is required; the validator answers 400"));
    }
    let q = query.q.as_deref().map_or("", js_trim);
    if require_query && q.is_empty() {
        let empty = Page {
            results: Vec::new(),
            total: 0.0,
            code: None,
        };
        return ctx.json(&js_numbers(page_json(empty, query.take, query.skip)));
    }
    let result = lib(ctx, user)
        .available(
            query.take,
            query.skip,
            query.media_type,
            (!q.is_empty()).then_some(q),
        )
        .await;
    answer(
        ctx,
        result.map(|page| page_json(page, query.take, query.skip)),
    )
}

/// `GET /library/available`.
fn available<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(list_available(ctx, false))
}

/// `GET /library/search`.
fn search<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(list_available(ctx, true))
}

/// `GET /library/browse`.
fn browse<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user = match ctx.authenticated(0) {
            Ok(user) => user,
            Err(why) => return Outcome::forward(why),
        };
        let (parsed, take, skip) = super::params::query(ctx).map_or_else(
            || {
                let parsed = parse_browse(ctx.req.uri.query().unwrap_or(""));
                let (take, skip) = parsed.as_ref().map_or((24, 0), |q| (q.take, q.skip));
                (parsed, take, skip)
            },
            |q| validated_browse(&q),
        );
        let lib = lib(ctx, user);
        let result = match parsed {
            Ok(query) => lib.browse(&query).await,
            // The numbers only reach a linked Jellyfin; without one the
            // answer is the empty page.
            Err(why) => match unlinked(&lib).await {
                Ok(Some(page)) => Ok(page),
                Ok(None) => Err(why),
                Err(e) => Err(e),
            },
        };
        answer(ctx, result.map(|page| page_json(page, take, skip)))
    })
}

/// `GET /library/facets`.
fn facets<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user = match ctx.authenticated(0) {
            Ok(user) => user,
            Err(why) => return Outcome::forward(why),
        };
        let media_type = match parse_facets(ctx.req.uri.query().unwrap_or("")) {
            Ok(media_type) => media_type,
            Err(why) => return Outcome::forward(why),
        };
        answer(ctx, lib(ctx, user).facets(media_type).await)
    })
}

/// `GET /library/items/{jellyfinItemId}`.
fn item<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let found = ctx
            .no_query()
            .and_then(|()| ctx.authenticated(0))
            .and_then(|user| Ok((user, segment(ctx, 0)?)));
        let (user, id) = match found {
            Ok(found) => found,
            Err(why) => return Outcome::forward(why),
        };
        if !is_jellyfin_item_id(&id) {
            return ctx.error(404, "Not found");
        }
        answer(ctx, lib(ctx, user).inspector(&id).await)
    })
}

/// `GET /library/items/{jellyfinItemId}/images/{imageType}`: the bytes
/// with `Content-Type` and `Cache-Control` only (`res.end` adds no `ETag`).
fn image<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let found = ctx
            .no_query()
            .and_then(|()| ctx.authenticated(0))
            .and_then(|user| Ok((user, segment(ctx, 2)?, segment(ctx, 0)?)));
        let (user, id, image_type) = match found {
            Ok(found) => found,
            Err(why) => return Outcome::forward(why),
        };
        let primary = match image_type.as_str() {
            "primary" => true,
            "backdrop" => false,
            _ => {
                return Outcome::forward(String::from(
                    "an imageType outside the enum; the validator answers 400",
                ))
            }
        };
        if !is_jellyfin_item_id(&id) {
            return ctx.error(404, "Not found");
        }
        match lib(ctx, user).image(&id, primary).await {
            Ok(ImageOutcome::Image(bytes, content_type)) => {
                let Ok(content_type) = HeaderValue::from_str(&content_type) else {
                    return Outcome::forward(String::from("an unsupported image content type"));
                };
                let mut res = Response::new(Body::from(bytes));
                res.headers_mut().insert(header::CONTENT_TYPE, content_type);
                res.headers_mut().insert(
                    header::CACHE_CONTROL,
                    HeaderValue::from_static("private, max-age=21600"),
                );
                Outcome::Done(res)
            }
            Ok(ImageOutcome::Error(status, message)) => ctx.error(status, message),
            Err(why) => Outcome::forward(why),
        }
    })
}

/// `GET /library/series/{jellyfinSeriesId}`.
fn series<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let found = ctx
            .no_query()
            .and_then(|()| ctx.authenticated(0))
            .and_then(|user| Ok((user, segment(ctx, 0)?)));
        let (user, id) = match found {
            Ok(found) => found,
            Err(why) => return Outcome::forward(why),
        };
        if !is_jellyfin_item_id(&id) {
            return ctx.error(404, "Not found");
        }
        let result = lib(ctx, user).series_detail(&id).await;
        answer(ctx, result.map(|detail| detail.to_value()))
    })
}

/// `GET /library/series/{jellyfinSeriesId}/seasons/{seasonId}/episodes`.
fn episodes<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let found = ctx
            .no_query()
            .and_then(|()| ctx.authenticated(0))
            .and_then(|user| Ok((user, segment(ctx, 3)?, segment(ctx, 1)?)));
        let (user, series_id, season_id) = match found {
            Ok(found) => found,
            Err(why) => return Outcome::forward(why),
        };
        if !is_jellyfin_item_id(&series_id) || !is_jellyfin_item_id(&season_id) {
            return ctx.error(404, "Not found");
        }
        answer(
            ctx,
            lib(ctx, user).season_episodes(&series_id, &season_id).await,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn available_query() {
        assert_eq!(
            parse_available("take=0&skip=40&mediaType=tv&q=Star%20Wars"),
            Ok(AvailableQuery {
                take: 20,
                skip: 40,
                media_type: Some("tv"),
                q: Some(String::from("Star Wars")),
            }),
            "parsed"
        );
        assert_eq!(
            parse_available("take=500").map(|q| q.take),
            Ok(50),
            "capped"
        );
        for raw in [
            "take=1.5",
            "take=-1",
            "mediaType=music",
            "q=a+b",
            "q=",
            "take=1&take=2",
            "other=1",
        ] {
            assert!(parse_available(raw).is_err(), "{raw} goes to Node");
        }
    }

    #[test]
    fn browse_query() {
        let parsed = parse_browse(
            "genre=Drama&genre=War%2C%20Politics&take=0&yearFrom=1990&sort=title&order=asc&q=%20x%20",
        );
        assert_eq!(
            parsed,
            Ok(BrowseQuery {
                q: Some(String::from("x")),
                media_type: None,
                watched: None,
                genre: Some(vec![
                    String::from("Drama"),
                    String::from("War"),
                    String::from("Politics")
                ]),
                year_from: Some(1990),
                year_to: None,
                sort: "title",
                order: "asc",
                take: 1,
                skip: 0,
            }),
            "parsed"
        );
        assert_eq!(
            parse_browse("").map(|q| (q.take, q.sort, q.order)),
            Ok((24, "dateAdded", "desc")),
            "defaults"
        );
        assert!(parse_browse("watched=all").is_err(), "enum");
        assert!(parse_browse("sort=title&sort=title").is_err(), "repeated");
    }

    #[test]
    fn facets_query() {
        assert_eq!(parse_facets(""), Ok(None), "none");
        assert_eq!(parse_facets("mediaType=movie"), Ok(Some("movie")), "movie");
        assert!(parse_facets("q=x").is_err(), "unknown key");
    }
}
