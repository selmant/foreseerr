//! What the provider rows (`AniList`, `MDBList`, Simkl, the Plex
//! watchlist) share: the signed-in user's settings row and the query as
//! the validator and the discover router leave it.

use serde_json::{Map, Value};

use super::discoverkit::{Param, Query};
use super::{Outcome, Ready};
use crate::db::Bind;

/// The `user_settings` columns these rows read (the row of `req.user`,
/// eager in Node, plus the `select: false` `AniList` token columns its
/// client loads on purpose). No row is an empty map.
pub(super) async fn user_settings(
    ctx: &Ready<'_>,
    user_id: i64,
) -> Result<Map<String, Value>, String> {
    let rows = ctx
        .state
        .db
        .rows(
            r#"SELECT "discoverFilterDefaults", "anilistAccessToken", "anilistTokenExpiresAt", "anilistUserId", CAST("userId" AS BIGINT) AS "userId" FROM "user_settings" WHERE "userId" = ?1"#,
            &[Bind::Int(user_id)],
        )
        .await
        .map_err(|e| format!("loading the user's settings failed: {e:#}"))?;
    Ok(rows.into_iter().next().unwrap_or_default())
}

/// The signed-in user, their settings row, and `req.query` after the
/// validator and the router's saved filter defaults.
pub(super) async fn prepare(
    ctx: &Ready<'_>,
    params: &[&[Param]],
    defaults: &[(&str, Value)],
) -> Result<(i64, Map<String, Value>, Query), super::Fallback> {
    let user_id = ctx.authenticated(0)?.id;
    let query = Query::of(ctx, params, defaults)?;
    let row = user_settings(ctx, user_id).await?;
    let query =
        query.with_filter_defaults(row.get("discoverFilterDefaults").and_then(Value::as_str));
    Ok((user_id, row, query))
}

/// `req.query.page ? Number(req.query.page) : 1`.
pub(super) fn page(query: &Query) -> i64 {
    query.page_number()
}

/// A failure after Node's mapping layer was involved: the handler's
/// fallback 500, logged as Node logs it.
pub(super) fn fallback_error(ctx: &Ready<'_>, message: &str, why: &str) -> Outcome {
    tracing::error!("[API] {message} ({why})");
    super::discoverkit::route_error(ctx, 500, message, None)
}

/// `{ page, hasMore, results }` plus any extra keys, in that order.
pub(super) fn page_body(
    page: i64,
    has_more: bool,
    results: Vec<Value>,
    extra: &[(&str, Value)],
) -> Value {
    let mut body = Map::new();
    body.insert(String::from("page"), Value::from(page));
    body.insert(String::from("hasMore"), Value::Bool(has_more));
    body.insert(String::from("results"), Value::Array(results));
    for (k, v) in extra {
        body.insert((*k).to_owned(), v.clone());
    }
    Value::Object(body)
}
