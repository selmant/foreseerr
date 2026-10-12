//! `GET /blocklist` and `GET /overrideRule`.

use std::future::Future;
use std::pin::Pin;

use serde_json::{Map, Value};

use super::{Outcome, Ready};
use crate::db::BlocklistQuery;
use crate::user::filtered_json;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// `Permission.ADMIN`, `MANAGE_BLOCKLIST` and `VIEW_BLOCKLIST`.
const ADMIN: i64 = 2;
const MANAGE_BLOCKLIST: i64 = 268_435_456;
const VIEW_BLOCKLIST: i64 = 1_073_741_824;

/// `GET /overrideRule`: every rule, for admins.
pub(super) fn override_rules<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = ctx
            .no_query()
            .and_then(|()| ctx.authenticated(ADMIN).map(|_| ()))
        {
            return Outcome::forward(why);
        }
        let rules = match ctx.state.db.override_rules().await {
            Ok(rules) => rules,
            Err(e) => return Outcome::forward(format!("loading override rules failed: {e:#}")),
        };
        let text = |v: &Option<String>| v.as_deref().map_or(Value::Null, Value::from);
        let number = |n: Option<i64>| n.map_or(Value::Null, Value::from);
        let body: Vec<Value> = rules
            .iter()
            .map(|r| {
                let mut out = Map::new();
                out.insert(String::from("id"), Value::from(r.id));
                out.insert(String::from("radarrServiceId"), number(r.radarr_service_id));
                out.insert(String::from("sonarrServiceId"), number(r.sonarr_service_id));
                out.insert(String::from("users"), text(&r.users));
                out.insert(String::from("genre"), text(&r.genre));
                out.insert(String::from("language"), text(&r.language));
                out.insert(String::from("keywords"), text(&r.keywords));
                out.insert(String::from("profileId"), number(r.profile_id));
                out.insert(String::from("rootFolder"), text(&r.root_folder));
                out.insert(String::from("tags"), text(&r.tags));
                out.insert(String::from("createdAt"), text(&r.created_at));
                out.insert(String::from("updatedAt"), text(&r.updated_at));
                Value::Object(out)
            })
            .collect();
        ctx.json(&Value::Array(body))
    })
}

/// `GET /blocklist`: one page, newest first, with each entry's user.
pub(super) fn list<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = ctx.authenticated(MANAGE_BLOCKLIST | VIEW_BLOCKLIST) {
            return Outcome::forward(why);
        }
        let query = match parse_query(ctx.req.uri.query().unwrap_or("")) {
            Ok(query) => query,
            Err(why) => return Outcome::forward(why),
        };
        let (items, total) = match ctx.state.db.blocklist(&query).await {
            Ok(page) => page,
            Err(e) => return Outcome::forward(format!("listing the blocklist failed: {e:#}")),
        };
        let text = |v: &Option<String>| v.as_deref().map_or(Value::Null, Value::from);
        let mut results = Vec::with_capacity(items.len());
        for item in &items {
            let user = match &item.user {
                Some(user) => match filtered_json(user, None, true) {
                    Ok(json) => json,
                    Err(why) => return Outcome::forward(why.to_owned()),
                },
                None => Value::Null,
            };
            let mut out = Map::new();
            out.insert(String::from("id"), Value::from(item.id));
            out.insert(
                String::from("mediaType"),
                Value::from(item.media_type.as_str()),
            );
            out.insert(String::from("title"), text(&item.title));
            out.insert(String::from("tmdbId"), Value::from(item.tmdb_id));
            out.insert(
                String::from("blocklistedTags"),
                text(&item.blocklisted_tags),
            );
            out.insert(String::from("createdAt"), text(&item.created_at));
            out.insert(String::from("user"), user);
            results.push(Value::Object(out));
        }
        let ceil_div = |a: i64, b: i64| (a + b - 1) / b;
        let mut page_info = Map::new();
        page_info.insert(
            String::from("pages"),
            Value::from(ceil_div(total, query.take)),
        );
        page_info.insert(String::from("pageSize"), Value::from(query.take));
        page_info.insert(String::from("results"), Value::from(total));
        page_info.insert(
            String::from("page"),
            Value::from(ceil_div(query.skip, query.take) + 1),
        );
        let mut body = Map::new();
        body.insert(String::from("pageInfo"), Value::Object(page_info));
        body.insert(String::from("results"), Value::Array(results));
        ctx.json(&Value::Object(body))
    })
}

/// The query as `blocklistGet` (zod) and the validator read it: `take` a
/// positive integer (default 25), `skip` non-negative (default 0), `search`
/// text, `filter` in its enum with the validator's default `manual`.
/// Anything the two might reject is left to Node.
fn parse_query(raw: &str) -> Result<BlocklistQuery, String> {
    let mut query = BlocklistQuery {
        search: None,
        tagged: Some(false),
        take: 25,
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
                Some(n) if n > 0 => query.take = n,
                _ => return forward("take must be a positive integer"),
            },
            "skip" => match plain_integer(&value) {
                Some(n) => query.skip = n,
                None => return forward("skip must be a non-negative integer"),
            },
            "search" => query.search = (!value.is_empty()).then_some(value),
            "filter" => {
                query.tagged = match value.as_str() {
                    "all" => None,
                    "manual" => Some(false),
                    "blocklistedTags" => Some(true),
                    _ => return forward("filter outside the enum"),
                };
            }
            _ => return forward("an unknown query key"),
        }
    }
    Ok(query)
}

/// A string of ASCII digits as a number; anything else is `None`.
pub(super) fn plain_integer(text: &str) -> Option<i64> {
    (!text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()))
        .then(|| text.parse().ok())
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_parsing() {
        let q = parse_query("").ok();
        assert_eq!(
            q.as_ref()
                .map(|q| (q.take, q.skip, q.tagged, q.search.clone())),
            Some((25, 0, Some(false), None)),
            "defaults, with the validator's filter=manual"
        );
        let q = parse_query("filter=all&search=Al%20pha&take=2&skip=4").ok();
        assert_eq!(
            q.as_ref()
                .map(|q| (q.take, q.skip, q.tagged, q.search.clone())),
            Some((2, 4, None, Some(String::from("Al pha")))),
            "explicit values"
        );
        for raw in [
            "take=0",
            "take=-1",
            "take=1.5",
            "filter=x",
            "x=1",
            "search=a+b",
            "take=1&take=2",
        ] {
            assert!(parse_query(raw).is_err(), "{raw} is forwarded");
        }
    }
}
