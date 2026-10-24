//! `GET /issue`, `GET /issue/count` and `GET /issue/{id}`.

use std::future::Future;
use std::pin::Pin;

use serde_json::{Map, Value};

use super::blocklist::plain_integer;
use super::related::Related;
use super::{Outcome, Ready};
use crate::db::{IssueCommentRow, IssueListQuery, IssueRow, IssueSort};

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// `Permission.MANAGE_ISSUES`, `VIEW_ISSUES` and `CREATE_ISSUES`.
const MANAGE_ISSUES: i64 = 1_048_576;
const VIEW_ISSUES: i64 = 2_097_152;
const CREATE_ISSUES: i64 = 4_194_304;

/// `IssueStatus`.
const OPEN: i64 = 1;
const RESOLVED: i64 = 2;

/// `GET /issue`: one page of issues with their media, users and comments.
/// The spec's `requestedBy` parameter is accepted and, as in Node (which
/// reads `createdBy`, a name the validator rejects), ignored.
pub(super) fn list<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user = match ctx.require(MANAGE_ISSUES | VIEW_ISSUES | CREATE_ISSUES) {
            Ok(user) => user,
            Err(answer) => return *answer,
        };
        let mut query = match parse_query(ctx.req.uri.query().unwrap_or("")) {
            Ok(query) => query,
            Err(why) => return Outcome::forward(why),
        };
        if !user.has_permission(MANAGE_ISSUES | VIEW_ISSUES) {
            query.created_by = Some(user.id);
        }
        let (issues, total) = match ctx.state.db.issue_list(&query).await {
            Ok(page) => page,
            Err(e) => return Outcome::forward(format!("listing issues failed: {e:#}")),
        };
        let media_ids: Vec<i64> = issues.iter().filter_map(|i| i.media_id).collect();
        let mut user_ids: Vec<i64> = Vec::new();
        for issue in &issues {
            user_ids.extend(issue.created_by_id);
            user_ids.extend(issue.modified_by_id);
        }
        let related = match Related::load(ctx, &media_ids, &user_ids, false).await {
            Ok(related) => related,
            Err(why) => return Outcome::forward(why),
        };
        let mut results = Vec::with_capacity(issues.len());
        for issue in &issues {
            let mut out = Map::new();
            columns(&mut out, issue);
            let created_by = match related.user_json(issue.created_by_id, false) {
                Ok(json) => json,
                Err(why) => return Outcome::forward(why),
            };
            out.insert(String::from("createdBy"), created_by);
            out.insert(
                String::from("media"),
                related.media_json(ctx, issue.media_id, false),
            );
            let modified_by = match related.user_json(issue.modified_by_id, false) {
                Ok(json) => json,
                Err(why) => return Outcome::forward(why),
            };
            out.insert(String::from("modifiedBy"), modified_by);
            out.insert(
                String::from("comments"),
                Value::Array(
                    issue
                        .comments
                        .iter()
                        .map(|c| comment_json(c, None))
                        .collect(),
                ),
            );
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

/// `GET /issue/count`: any signed-in user.
pub(super) fn count<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = ctx
            .no_query()
            .and_then(|()| ctx.authenticated(0).map(|_| ()))
        {
            return Outcome::forward(why);
        }
        let counts = match ctx.state.db.issue_counts().await {
            Ok(counts) => counts,
            Err(e) => return Outcome::forward(format!("counting issues failed: {e:#}")),
        };
        let mut out = Map::new();
        for (key, value) in [
            ("total", counts.total),
            ("video", counts.video),
            ("audio", counts.audio),
            ("subtitles", counts.subtitles),
            ("others", counts.others),
            ("open", counts.open),
            ("closed", counts.closed),
        ] {
            out.insert(String::from(key), Value::from(value));
        }
        ctx.json(&Value::Object(out))
    })
}

/// `GET /issue/{id}`: the issue with its comments (each with its user),
/// reporter and media; `modifiedBy` isn't joined there, so it is absent.
/// An unknown id is a 500 in Node.
pub(super) fn detail<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user = match ctx
            .no_query()
            .and_then(|()| ctx.authenticated(MANAGE_ISSUES | VIEW_ISSUES | CREATE_ISSUES))
        {
            Ok(user) => user,
            Err(why) => return Outcome::forward(why),
        };
        let id = ctx
            .req
            .uri
            .path()
            .rsplit('/')
            .next()
            .and_then(plain_integer);
        let Some(id) = id else {
            return Outcome::forward(String::from(
                "the id isn't a plain integer; the validator and Number() decide",
            ));
        };
        let issue = match ctx.state.db.issue_by_id(id).await {
            Ok(Some(issue)) => issue,
            Ok(None) => return ctx.error(500, "Issue not found."),
            Err(e) => return Outcome::forward(format!("loading issue {id} failed: {e:#}")),
        };
        if issue.created_by_id != Some(user.id) && !user.has_permission(MANAGE_ISSUES | VIEW_ISSUES)
        {
            return ctx.error(403, "You do not have permission to view this issue.");
        }
        let media_ids: Vec<i64> = issue.media_id.into_iter().collect();
        let mut user_ids: Vec<i64> = issue.created_by_id.into_iter().collect();
        user_ids.extend(issue.comments.iter().filter_map(|c| c.user_id));
        let related = match Related::load(ctx, &media_ids, &user_ids, false).await {
            Ok(related) => related,
            Err(why) => return Outcome::forward(why),
        };
        let mut out = Map::new();
        columns(&mut out, &issue);
        let mut comments = Vec::with_capacity(issue.comments.len());
        for comment in &issue.comments {
            match related.user_json(comment.user_id, false) {
                Ok(user) => comments.push(comment_json(comment, Some(user))),
                Err(why) => return Outcome::forward(why),
            }
        }
        out.insert(String::from("comments"), Value::Array(comments));
        let created_by = match related.user_json(issue.created_by_id, false) {
            Ok(json) => json,
            Err(why) => return Outcome::forward(why),
        };
        out.insert(String::from("createdBy"), created_by);
        out.insert(
            String::from("media"),
            related.media_json(ctx, issue.media_id, false),
        );
        ctx.json(&Value::Object(out))
    })
}

/// The entity's own columns, in declaration order.
pub(super) fn columns(out: &mut Map<String, Value>, i: &IssueRow) {
    let text = |v: &Option<String>| v.as_deref().map_or(Value::Null, Value::from);
    out.insert(String::from("id"), Value::from(i.id));
    out.insert(String::from("issueType"), Value::from(i.issue_type));
    out.insert(String::from("status"), Value::from(i.status));
    out.insert(String::from("problemSeason"), Value::from(i.problem_season));
    out.insert(
        String::from("problemEpisode"),
        Value::from(i.problem_episode),
    );
    out.insert(String::from("createdAt"), text(&i.created_at));
    out.insert(String::from("updatedAt"), text(&i.updated_at));
}

/// A comment, with its user when that relation was joined.
pub(super) fn comment_json(c: &IssueCommentRow, user: Option<Value>) -> Value {
    let text = |v: &Option<String>| v.as_deref().map_or(Value::Null, Value::from);
    let mut out = Map::new();
    out.insert(String::from("id"), Value::from(c.id));
    out.insert(String::from("message"), Value::from(c.message.as_str()));
    out.insert(String::from("createdAt"), text(&c.created_at));
    out.insert(String::from("updatedAt"), text(&c.updated_at));
    if let Some(user) = user {
        out.insert(String::from("user"), user);
    }
    Value::Object(out)
}

/// The query as the validator and the handler read it: `take` and `skip`
/// non-negative integers, `sort` and `filter` in their enums (the
/// validator fills in `filter=open`), `requestedBy` a number Node ignores.
fn parse_query(raw: &str) -> Result<IssueListQuery, String> {
    let mut query = IssueListQuery {
        statuses: vec![OPEN],
        sort: IssueSort::CreatedAt,
        created_by: None,
        take: 10,
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
            "requestedBy" => {
                if plain_integer(&value).is_none() {
                    return forward("requestedBy must be a number");
                }
            }
            "filter" => {
                query.statuses = match value.as_str() {
                    "all" => vec![OPEN, RESOLVED],
                    "open" => vec![OPEN],
                    "resolved" => vec![RESOLVED],
                    _ => return forward("filter outside the enum"),
                };
            }
            "sort" => {
                query.sort = match value.as_str() {
                    "added" => IssueSort::CreatedAt,
                    "modified" => IssueSort::UpdatedAt,
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
        assert_eq!(
            parse_query("").ok(),
            Some(IssueListQuery {
                statuses: vec![OPEN],
                sort: IssueSort::CreatedAt,
                created_by: None,
                take: 10,
                skip: 0,
            }),
            "the validator's filter=open default"
        );
        assert_eq!(
            parse_query("filter=all&sort=modified&take=2&skip=1&requestedBy=2").ok(),
            Some(IssueListQuery {
                statuses: vec![OPEN, RESOLVED],
                sort: IssueSort::UpdatedAt,
                created_by: None,
                take: 2,
                skip: 1,
            }),
            "requestedBy is accepted and ignored"
        );
        for raw in [
            "createdBy=2",
            "filter=closed",
            "sort=x",
            "take=-1",
            "requestedBy=x",
        ] {
            assert!(parse_query(raw).is_err(), "{raw} is forwarded");
        }
    }
}
