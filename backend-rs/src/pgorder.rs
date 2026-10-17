//! Row orders `TypeORM` leaves to Postgres.
//!
//! An eager or explicit relation loaded through joins comes back in the
//! order of the joined rows, and a query without `ORDER BY` (or with ties
//! in it) gets whatever order the plan produces. `SQLite`'s plans happen to
//! give id order; Postgres's do not. Where Node's answer shows such an
//! order, the same `FROM`/`JOIN`/`WHERE` is run here and the order of
//! first appearance is applied to the rows loaded separately.

use anyhow::Result;
use sqlx::{AssertSqlSafe, Row};

use crate::db::{Db, IssueRow, MediaRow, RequestRow};

/// The order `Media.getMedia`'s `findOne` (relations `requests` and
/// `issues`, eager `seasons`, and theirs) gives the media's requests,
/// issues, issue comments and seasons. Nothing changes on `SQLite`.
///
/// # Errors
///
/// Fails on database errors.
pub async fn media_details(
    db: &Db,
    media: &mut MediaRow,
    requests: &mut Vec<RequestRow>,
    issues: &mut Vec<IssueRow>,
) -> Result<()> {
    let Db::Postgres(pool) = db else {
        return Ok(());
    };
    let sql = format!(
        r#"SELECT "Media__Media_requests"."id"::bigint AS "request", "Media__Media_issues"."id"::bigint AS "issue", "Media__Media_issues__Media__Media_issues_comments"."id"::bigint AS "comment", "Media__seasons"."id"::bigint AS "season" FROM "media" "Media" LEFT JOIN "media_request" "Media__Media_requests" ON "Media__Media_requests"."mediaId"="Media"."id"  LEFT JOIN "issue" "Media__Media_issues" ON "Media__Media_issues"."mediaId"="Media"."id"  LEFT JOIN "media" "Media__Media_requests__Media__Media_requests_media" ON "Media__Media_requests__Media__Media_requests_media"."id"="Media__Media_requests"."mediaId"  LEFT JOIN "user" "Media__Media_requests__Media__Media_requests_requestedBy" ON "Media__Media_requests__Media__Media_requests_requestedBy"."id"="Media__Media_requests"."requestedById"  LEFT JOIN "user" "Media__Media_requests__Media__Media_requests_modifiedBy" ON "Media__Media_requests__Media__Media_requests_modifiedBy"."id"="Media__Media_requests"."modifiedById"  LEFT JOIN "season_request" "Media__Media_requests__Media__Media_requests_seasons" ON "Media__Media_requests__Media__Media_requests_seasons"."requestId"="Media__Media_requests"."id"  LEFT JOIN "episode_request" "Media__Media_requests__Media__Media_requests_episodes" ON "Media__Media_requests__Media__Media_requests_episodes"."requestId"="Media__Media_requests"."id"  LEFT JOIN "media" "Media__Media_issues__Media__Media_issues_media" ON "Media__Media_issues__Media__Media_issues_media"."id"="Media__Media_issues"."mediaId"  LEFT JOIN "user" "Media__Media_issues__Media__Media_issues_createdBy" ON "Media__Media_issues__Media__Media_issues_createdBy"."id"="Media__Media_issues"."createdById"  LEFT JOIN "user" "Media__Media_issues__Media__Media_issues_modifiedBy" ON "Media__Media_issues__Media__Media_issues_modifiedBy"."id"="Media__Media_issues"."modifiedById"  LEFT JOIN "issue_comment" "Media__Media_issues__Media__Media_issues_comments" ON "Media__Media_issues__Media__Media_issues_comments"."issueId"="Media__Media_issues"."id"  LEFT JOIN "season" "Media__seasons" ON "Media__seasons"."mediaId"="Media"."id" WHERE ( (("Media"."tmdbId" = $1) AND ("Media"."mediaType" = $2)) ) AND ( "Media"."id" IN ({}) )"#,
        media.id
    );
    let rows = sqlx::query(AssertSqlSafe(sql))
        .bind(media.tmdb_id)
        .bind(&media.media_type)
        .fetch_all(pool)
        .await?;
    let mut order = Order::default();
    for row in &rows {
        push_new(&mut order.requests, row.try_get("request")?);
        order.see_issue(row.try_get("issue")?, row.try_get("comment")?);
        push_new(&mut order.seasons, row.try_get("season")?);
    }
    arrange(requests, &order.requests, |r| r.id);
    arrange(issues, &order.issues, |i| i.id);
    for issue in issues.iter_mut() {
        if let Some((_, comments)) = order.comments.iter().find(|(id, _)| *id == issue.id) {
            arrange(&mut issue.comments, comments, |c| c.id);
        }
    }
    arrange(&mut media.seasons, &order.seasons, |s| s.id);
    Ok(())
}

/// First appearances, per relation.
#[derive(Debug, Default)]
struct Order {
    requests: Vec<i64>,
    issues: Vec<i64>,
    comments: Vec<(i64, Vec<i64>)>,
    seasons: Vec<i64>,
}

impl Order {
    fn see_issue(&mut self, issue: Option<i64>, comment: Option<i64>) {
        let Some(issue) = issue else {
            return;
        };
        if !self.issues.contains(&issue) {
            self.issues.push(issue);
            self.comments.push((issue, Vec::new()));
        }
        if let Some((_, list)) = self.comments.iter_mut().find(|(id, _)| *id == issue) {
            push_new(list, comment);
        }
    }
}

fn push_new(list: &mut Vec<i64>, id: Option<i64>) {
    if let Some(id) = id.filter(|id| !list.contains(id)) {
        list.push(id);
    }
}

/// Put `items` in the order of `ids`; ids not seen keep their place after.
fn arrange<T>(items: &mut Vec<T>, ids: &[i64], id: impl Fn(&T) -> i64) {
    let mut left: Vec<Option<T>> = items.drain(..).map(Some).collect();
    for wanted in ids {
        if let Some(item) = left
            .iter_mut()
            .find(|item| item.as_ref().is_some_and(|item| id(item) == *wanted))
            .and_then(Option::take)
        {
            items.push(item);
        }
    }
    items.extend(left.into_iter().flatten());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arrange_follows_first_appearance() {
        let mut items = vec![1, 2, 3, 4];
        arrange(&mut items, &[3, 1], |n| *n);
        assert_eq!(items, vec![3, 1, 2, 4]);
    }

    #[test]
    fn issues_collect_their_comments() {
        let mut order = Order::default();
        order.see_issue(Some(2), Some(9));
        order.see_issue(Some(1), None);
        order.see_issue(Some(2), Some(7));
        order.see_issue(Some(2), Some(9));
        assert_eq!(order.issues, vec![2, 1]);
        assert_eq!(order.comments, vec![(2, vec![9, 7]), (1, vec![])]);
    }
}
