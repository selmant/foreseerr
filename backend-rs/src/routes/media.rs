//! `GET /media`: one page of the media table.

use std::future::Future;
use std::pin::Pin;

use serde_json::{Map, Value};

use super::blocklist::plain_integer;
use super::{Outcome, Ready};
use crate::db::{MediaListQuery, MediaSort};
use crate::downloads::Downloads;
use crate::media::{media_json, tracks_downloads};

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// `MediaStatus` values the `filter` parameter maps to.
const PENDING: i64 = 2;
const PROCESSING: i64 = 3;
const PARTIALLY_AVAILABLE: i64 = 4;
const AVAILABLE: i64 = 5;

/// `GET /media`: any signed-in user. The download tracker lives in Node's
/// memory, so it is read over `/internal/downloads` when a row needs it.
pub(super) fn list<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = ctx.authenticated(0) {
            return Outcome::forward(why);
        }
        let query = super::params::query(ctx).map_or_else(
            || parse_query(ctx.req.uri.query().unwrap_or("")).map_err(super::Fallback::from),
            |validated| validated_query(&validated),
        );
        let query = match query {
            Ok(query) => query,
            Err(why) => return Outcome::forward(why),
        };
        let (rows, total) = match ctx.state.db.media_list(&query).await {
            Ok(page) => page,
            Err(e) => return Outcome::forward(format!("listing media failed: {e:#}")),
        };
        let downloads = if rows.iter().any(tracks_downloads) {
            Downloads::current()
        } else {
            Downloads::default()
        };
        let with_seasons = query.sort != MediaSort::MediaAddedAt;
        let results: Vec<Value> = rows
            .iter()
            .map(|row| media_json(row, &ctx.settings, &downloads, with_seasons))
            .collect();
        let page_info = super::params::page_info(query.take, query.skip, total);
        let mut body = Map::new();
        body.insert(String::from("pageInfo"), Value::Object(page_info));
        body.insert(String::from("results"), Value::Array(results));
        ctx.json(&Value::Object(body))
    })
}

/// The handler's reading of what the validator left:
/// `take ? Number(take) : 20`, `skip ? Number(skip) : 0`, the `filter`
/// switch and the `sort` comparisons.
fn validated_query(q: &Map<String, Value>) -> Result<MediaListQuery, super::Fallback> {
    let (take, skip) = super::params::take_skip(q, 20)?;
    let statuses = match q.get("filter").and_then(Value::as_str) {
        Some("available") => vec![AVAILABLE],
        Some("partial") => vec![PARTIALLY_AVAILABLE],
        Some("allavailable") => vec![AVAILABLE, PARTIALLY_AVAILABLE],
        Some("processing") => vec![PROCESSING],
        Some("pending") => vec![PENDING],
        Some(_) | None => Vec::new(),
    };
    let sort = match q.get("sort").and_then(Value::as_str) {
        Some("modified") => MediaSort::UpdatedAt,
        Some("mediaAdded") => MediaSort::MediaAddedAt,
        Some(_) | None => MediaSort::Id,
    };
    Ok(MediaListQuery {
        statuses,
        sort,
        take,
        skip,
    })
}

/// The query as the validator and the handler read it: `take` and `skip`
/// non-negative integers (`take=0` falls back to 20 like a missing one),
/// `filter` and `sort` in their enums. Anything else, including negative
/// or fractional numbers that make Node answer oddly, is left to Node.
fn parse_query(raw: &str) -> Result<MediaListQuery, String> {
    let mut query = MediaListQuery {
        statuses: Vec::new(),
        sort: MediaSort::Id,
        take: 20,
        skip: 0,
    };
    let mut seen: Vec<&str> = Vec::new();
    let forward = |why: &str| Err(why.to_owned());
    for pair in raw.split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if seen.contains(&key) {
            return forward("a repeated query key");
        }
        seen.push(key);
        let Some(value) = super::user::decode_query_value(value) else {
            return forward("a reserved or malformed character in a query value");
        };
        match key {
            "take" => match plain_integer(&value) {
                Some(0) => {}
                Some(n) => query.take = n,
                None => return forward("take must be a non-negative integer"),
            },
            "skip" => match plain_integer(&value) {
                Some(n) => query.skip = n,
                None => return forward("skip must be a non-negative integer"),
            },
            "filter" => {
                query.statuses = match value.as_str() {
                    "all" | "deleted" => Vec::new(),
                    "available" => vec![AVAILABLE],
                    "partial" => vec![PARTIALLY_AVAILABLE],
                    "allavailable" => vec![AVAILABLE, PARTIALLY_AVAILABLE],
                    "processing" => vec![PROCESSING],
                    "pending" => vec![PENDING],
                    _ => return forward("filter outside the enum"),
                };
            }
            "sort" => {
                query.sort = match value.as_str() {
                    "added" => MediaSort::Id,
                    "modified" => MediaSort::UpdatedAt,
                    "mediaAdded" => MediaSort::MediaAddedAt,
                    _ => return forward("sort outside the enum"),
                };
            }
            _ => return forward("an unknown query key"),
        }
    }
    Ok(query)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_parsing() {
        let q = parse_query("").ok();
        assert_eq!(
            q,
            Some(MediaListQuery {
                statuses: Vec::new(),
                sort: MediaSort::Id,
                take: 20,
                skip: 0,
            }),
            "defaults"
        );
        let q = parse_query("sort=mediaAdded&filter=allavailable&take=4&skip=1").ok();
        assert_eq!(
            q,
            Some(MediaListQuery {
                statuses: vec![AVAILABLE, PARTIALLY_AVAILABLE],
                sort: MediaSort::MediaAddedAt,
                take: 4,
                skip: 1,
            }),
            "explicit values"
        );
        assert_eq!(
            parse_query("take=0&filter=deleted&sort=added").ok(),
            parse_query("").ok(),
            "take=0 and the enum values without a filter are the defaults"
        );
        for raw in [
            "take=-1",
            "take=1.5",
            "take=",
            "skip=-3",
            "filter=nope",
            "filter=",
            "sort=x",
            "foo=1",
            "take=1&take=2",
            "filter=all+",
        ] {
            assert!(parse_query(raw).is_err(), "{raw} is forwarded");
        }
    }
}
