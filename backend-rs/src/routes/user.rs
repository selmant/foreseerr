//! `GET /user` and `GET /user/:id` from `server/routes/user/index.ts`.

use std::future::Future;
use std::pin::Pin;

use serde_json::{Map, Value};

use super::{Outcome, Ready};
use crate::db::{UserListQuery, UserSort};
use crate::user::filtered_json;

/// `Permission.MANAGE_USERS`.
const MANAGE_USERS: i64 = 8;

/// `GET /user/:id`: the user, with the sensitive fields for admins and the
/// user themselves.
pub(super) fn detail<'a>(ctx: &'a Ready<'a>) -> Pin<Box<dyn Future<Output = Outcome> + Send + 'a>> {
    Box::pin(async move {
        if let Err(why) = ctx.no_query() {
            return Outcome::forward(why);
        }
        let viewer = match ctx.require(0) {
            Ok(user) => user,
            Err(answer) => return *answer,
        };
        // `findOneOrFail({ where: { id: Number(req.params.id) } })`.
        let id = match super::params::path_int(ctx, 0) {
            Ok(id) => id,
            Err(why) => return Outcome::forward(why),
        };
        let loaded = match ctx.state.db.user_record(id).await {
            Ok(loaded) => loaded,
            Err(e) => return Outcome::forward(format!("loading the user failed: {e:#}")),
        };
        let Some((user, settings)) = loaded else {
            return ctx.error(404, "User not found.");
        };
        let show_filtered = viewer.id == user.id || viewer.has_permission(MANAGE_USERS);
        match filtered_json(&user, Some(settings.as_ref()), show_filtered) {
            Ok(body) => ctx.json(&body),
            Err(why) => Outcome::forward(why.to_owned()),
        }
    })
}

/// `GET /user`: one page of users.
pub(super) fn list<'a>(ctx: &'a Ready<'a>) -> Pin<Box<dyn Future<Output = Outcome> + Send + 'a>> {
    Box::pin(async move {
        let viewer = match ctx.require(0) {
            Ok(user) => user,
            Err(answer) => return *answer,
        };
        let js = match super::params::query(ctx) {
            Some(validated) => match js_query(&validated) {
                Ok(js) => js,
                Err(answer) => return *answer,
            },
            None => match parse_query(ctx.req.uri.query().unwrap_or("")) {
                Ok(query) => JsList::of(query),
                Err(why) => return Outcome::forward(why),
            },
        };
        let (users, total) = if js.nothing_matches {
            (Vec::new(), 0)
        } else {
            match ctx.state.db.user_list(&js.query).await {
                Ok(page) => page,
                Err(e) => return Outcome::forward(format!("listing users failed: {e:#}")),
            }
        };
        let show_filtered = viewer.has_permission(MANAGE_USERS);
        let mut results = Vec::with_capacity(users.len());
        for user in &users {
            match filtered_json(user, None, show_filtered) {
                Ok(body) => results.push(body),
                Err(why) => return Outcome::forward(why.to_owned()),
            }
        }
        let mut page_info = Map::new();
        let size = js.page_size.max(1);
        page_info.insert(
            String::from("pages"),
            Value::from((total + size - 1) / size),
        );
        page_info.insert(String::from("pageSize"), Value::from(js.page_size));
        page_info.insert(String::from("results"), Value::from(total));
        page_info.insert(
            String::from("page"),
            Value::from((js.skip + size - 1) / size + 1),
        );
        let mut body = Map::new();
        body.insert(String::from("pageInfo"), Value::Object(page_info));
        body.insert(String::from("results"), Value::Array(results));
        ctx.json(&Value::Object(body))
    })
}

/// The query string as the handler reads it, or why Node should parse it
/// instead: anything the `OpenAPI` validator might reject (unknown keys,
/// values outside an enum, reserved characters left unencoded), anything
/// `Number` would turn into something other than a plain non-negative
/// integer, and repeated keys (Express would turn those into arrays).
///
/// The validator also fills in `sort=created` when it is missing, so the
/// handler's own "no sort" branch never runs.
fn parse_query(raw: &str) -> Result<UserListQuery, String> {
    let mut take: Option<i64> = None;
    let mut skip: Option<i64> = None;
    let mut sort: Option<&str> = None;
    let mut direction: Option<String> = None;
    let mut search: Option<String> = None;
    let mut include_ids: Vec<i64> = Vec::new();
    let mut seen: Vec<&str> = Vec::new();
    let forward = |why: &str| Err(why.to_owned());
    for pair in raw.split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if seen.contains(&key) {
            return forward("a repeated query key");
        }
        seen.push(key);
        let Some(value) = decode(value) else {
            return forward("a reserved or malformed character in a query value");
        };
        match key {
            "take" | "skip" => {
                let Some(n) = plain_integer(&value) else {
                    return forward("take/skip not a plain integer");
                };
                if key == "take" {
                    // `take=0` is falsy: the default page size.
                    take = (n != 0).then_some(n);
                } else {
                    skip = Some(n);
                }
            }
            "sort" => {
                sort = Some(match value.as_str() {
                    "created" => "created",
                    "updated" => "updated",
                    "requests" => "requests",
                    "displayname" => "displayname",
                    "usertype" => "usertype",
                    "role" => "role",
                    _ => return forward("sort outside the enum"),
                });
            }
            "sortDirection" => match value.as_str() {
                "asc" | "desc" => direction = Some(value),
                _ => return forward("sortDirection outside the enum"),
            },
            "q" => search = (!value.is_empty()).then(|| value.to_lowercase()),
            "includeIds" => {
                for id in value.split(',').filter(|_| !value.is_empty()) {
                    match plain_integer(id) {
                        Some(n) if !include_ids.contains(&n) => include_ids.push(n),
                        Some(_) => {}
                        None => return forward("includeIds not plain integers"),
                    }
                }
            }
            _ => return forward("an unknown query key"),
        }
    }
    let sort_key = match sort {
        Some("updated") => UserSort::Updated,
        Some("requests") => UserSort::Requests,
        Some("displayname") => UserSort::DisplayName,
        Some("usertype") => UserSort::UserType,
        Some("role") => UserSort::Role,
        Some(_) | None => UserSort::Created,
    };
    let ascending = match direction.as_deref() {
        Some("asc") => true,
        Some("desc") => false,
        Some(_) | None => !matches!(sort_key, UserSort::Requests | UserSort::Updated),
    };
    let ids = i64::try_from(include_ids.len()).unwrap_or(i64::MAX);
    Ok(UserListQuery {
        search,
        include_ids,
        sort: sort_key,
        ascending,
        take: take.unwrap_or_else(|| ids.max(10)),
        skip: skip.unwrap_or(0),
    })
}

/// The list query with the numbers as the handler holds them.
struct JsList {
    /// What the database is asked (`LIMIT`/`OFFSET` as it reads them).
    query: UserListQuery,
    /// `pageSize`.
    page_size: i64,
    /// `skip`.
    skip: i64,
    /// `includeIds` were given and none can match a row.
    nothing_matches: bool,
}

impl JsList {
    const fn of(query: UserListQuery) -> Self {
        Self {
            page_size: query.take,
            skip: query.skip,
            query,
            nothing_matches: false,
        }
    }
}

/// Node's handler on the query the validator left: `take` and `skip` as
/// whole numbers, `includeIds` as integer ids (one that isn't matches no
/// user).
fn js_query(q: &Map<String, Value>) -> Result<JsList, Box<Outcome>> {
    use super::params::{int, truthy};
    let text = |key: &str| crate::media::js_string(q.get(key)).into_owned();
    let mut given: Vec<String> = Vec::new();
    if truthy(q.get("includeIds")) {
        for id in text("includeIds").split(',') {
            if !given.iter().any(|seen| seen == id) {
                given.push(id.to_owned());
            }
        }
    }
    let mut include_ids: Vec<i64> = Vec::new();
    for id in given.iter().filter_map(|id| super::params::integer(id)) {
        if !include_ids.contains(&id) {
            include_ids.push(id);
        }
    }
    let bad = |why| Box::new(Outcome::forward(why));
    let page_size = match int(q.get("take"), "take").map_err(bad)? {
        Some(n) if n > 0 => n,
        Some(0) | None => super::params::count(given.len()).max(10),
        Some(_) => {
            return Err(Box::new(Outcome::fail(
                400,
                "take must be a positive integer.",
            )))
        }
    };
    let skip = match int(q.get("skip"), "skip").map_err(bad)? {
        Some(n) if n >= 0 => n,
        None => 0,
        Some(_) => return Err(Box::new(Outcome::fail(400, "skip must not be negative."))),
    };
    let search = truthy(q.get("q")).then(|| text("q").to_lowercase());
    let sort = match q.get("sort").and_then(Value::as_str) {
        Some("updated") => UserSort::Updated,
        Some("requests") => UserSort::Requests,
        Some("displayname") => UserSort::DisplayName,
        Some("usertype") => UserSort::UserType,
        Some("role") => UserSort::Role,
        Some(_) | None => UserSort::Created,
    };
    let direction = truthy(q.get("sortDirection")).then(|| text("sortDirection").to_lowercase());
    let ascending = match direction.as_deref() {
        Some("asc") => true,
        Some("desc") => false,
        Some(_) | None => !matches!(sort, UserSort::Requests | UserSort::Updated),
    };
    Ok(JsList {
        nothing_matches: !given.is_empty() && include_ids.is_empty(),
        query: UserListQuery {
            search,
            include_ids,
            sort,
            ascending,
            take: page_size,
            skip,
        },
        page_size,
        skip,
    })
}

/// A non-negative integer written with digits only, as both the validator
/// and `Number` agree on.
fn plain_integer(text: &str) -> Option<i64> {
    (!text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()))
        .then(|| text.parse().ok())
        .flatten()
}

/// Percent-decoding for values made of unreserved characters and escapes.
/// Anything else (`+`, a bare comma, `@`, ...) is what the validator calls
/// "not url encoded" and answers 400 to, so it is left to Node.
pub(super) fn decode_query_value(value: &str) -> Option<String> {
    decode(value)
}

fn decode(value: &str) -> Option<String> {
    if !value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~' | b'%'))
    {
        return None;
    }
    if !value.contains('%') {
        return Some(value.to_owned());
    }
    let mut out = Vec::with_capacity(value.len());
    let mut bytes = value.bytes();
    while let Some(b) = bytes.next() {
        if b != b'%' {
            out.push(b);
            continue;
        }
        let hex = [bytes.next()?, bytes.next()?];
        let digit = |c: u8| char::from(c).to_digit(16);
        out.push(u8::try_from(digit(hex[0])? * 16 + digit(hex[1])?).ok()?);
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    type Parsed = (i64, i64, UserSort, bool, Vec<i64>, Option<String>);

    fn parsed(raw: &str) -> Option<Parsed> {
        parse_query(raw)
            .ok()
            .map(|q| (q.take, q.skip, q.sort, q.ascending, q.include_ids, q.search))
    }

    #[test]
    fn query_defaults() {
        assert_eq!(
            parsed(""),
            Some((10, 0, UserSort::Created, true, Vec::new(), None)),
            "defaults"
        );
        assert_eq!(
            parsed("sort=requests").map(|p| p.3),
            Some(false),
            "requests sorts descending by default"
        );
        assert_eq!(
            parsed("includeIds=1%2C2%2C2%2C3&q=Ab%20c&take=2&skip=4&sortDirection=desc"),
            Some((
                2,
                4,
                UserSort::Created,
                false,
                vec![1, 2, 3],
                Some(String::from("ab c"))
            )),
            "ids deduplicated, search lower-cased and decoded, paging"
        );
        assert_eq!(
            parsed("includeIds=1%2C2%2C3%2C4%2C5%2C6%2C7%2C8%2C9%2C10%2C11%2C12").map(|p| p.0),
            Some(12),
            "page size grows with the id list"
        );
    }

    #[test]
    fn query_goes_to_node_when_unsure() {
        assert_eq!(
            parse_query("take=0").map(|q| q.take),
            Ok(10),
            "take=0 is the default page size"
        );
        for raw in [
            "take=1.5",
            "take=-1",
            "sort=name",
            "sortDirection=ASC",
            "x=1",
            "q=a+b",
            "take=1&take=2",
            "includeIds=a",
            "includeIds=1,2",
            "q=a@b",
        ] {
            assert!(parse_query(raw).is_err(), "{raw} is forwarded");
        }
    }
}
