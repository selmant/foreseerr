//! `GET /discover/watchlist` (`server/routes/discover/plex.ts`): the local
//! watchlist rows of users without a Plex token, otherwise their Plex
//! watchlist.

use std::future::Future;
use std::pin::Pin;

use axum::http::Method;
use serde_json::{json, Map, Value};

use super::discoverkit::{annotate_provider_active_requests, omit_unmapped, Kind, Param};
use super::providerkit::prepare;
use super::ratingsenrich::enrich_results_with_ratings;
use super::related::Related;
use super::{Outcome, Ready, Table};
use crate::db::Bind;
use crate::plexwatchlist::{tile, watchlist};

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// This module's routes.
pub(super) const ROUTES: &Table = &[("/api/v1/discover/watchlist", Method::GET, plex_watchlist)];

const PARAMS: [Param; 3] = [
    ("page", Kind::Int),
    ("hideUnmapped", Kind::Bool),
    ("ignoreDiscoverDefaults", Kind::Bool),
];

macro_rules! try_forward {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(why) => return Outcome::forward(why),
        }
    };
}

fn body(page: i64, total_pages: Value, total: Value, results: Vec<Value>) -> Value {
    let mut out = Map::new();
    out.insert(String::from("page"), Value::from(page));
    out.insert(String::from("totalPages"), total_pages);
    out.insert(String::from("totalResults"), total);
    out.insert(String::from("results"), Value::Array(results));
    Value::Object(out)
}

/// `GET /discover/watchlist`.
fn plex_watchlist<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let (user_id, _, query) =
            try_forward!(prepare(ctx, &[&PARAMS], &[("page", json!(1))]).await);
        // `req.query.page ? Number(req.query.page) : 1`.
        let page = query.page_number();
        let offset = page.saturating_sub(1).saturating_mul(20).max(0);
        let rows = try_forward!(ctx
            .state
            .db
            .rows(
                r#"SELECT "plexToken" FROM "user" WHERE "id" = ?1"#,
                &[Bind::Int(user_id)],
            )
            .await
            .map_err(|e| format!("loading the user failed: {e:#}")));
        let Some(user) = rows.into_iter().next() else {
            return Outcome::forward(String::from("the user vanished"));
        };
        let token = user
            .get("plexToken")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .map(str::to_owned);
        let Some(token) = token else {
            return local_watchlist(ctx, user_id, page, offset).await;
        };
        let page_data =
            match watchlist(&ctx.state.outbound, &token, crate::jsnum::from_i64(offset)).await {
                Ok(p) => p,
                Err(why) => return Outcome::forward(why.0),
            };
        let items: Vec<Value> = page_data.items.iter().map(tile).collect();
        let enriched = try_forward!(enrich_results_with_ratings(ctx, items, None, false).await);
        let shown = omit_unmapped(enriched, query.truthy("hideUnmapped"));
        let results = annotate_provider_active_requests(ctx, shown).await;
        let total = page_data.total_size.as_f64().unwrap_or(0.0);
        ctx.json(&body(
            page,
            crate::jsval::num((total / 20.0).ceil()),
            page_data.total_size,
            results,
        ))
    })
}

/// The local rows of a user without a Plex token, or the empty answer.
async fn local_watchlist(ctx: &Ready<'_>, user_id: i64, page: i64, offset: i64) -> Outcome {
    // `findAndCount({ take: 20, skip: offset })`.
    let (rows, total) = match ctx.state.db.watchlist_page(user_id, 20, offset).await {
        Ok(found) => found,
        Err(e) => return Outcome::forward(format!("database: {e:#}")),
    };
    if total == 0 {
        return ctx.json(&body(1, json!(1), json!(0), Vec::new()));
    }
    let media_ids: Vec<i64> = rows.iter().filter_map(|r| r.media_id).collect();
    let related = try_forward!(Related::load(ctx, &media_ids, &[user_id], true).await);
    let text = |v: Option<&String>| v.map_or(Value::Null, |s| Value::from(s.as_str()));
    let mut results = Vec::with_capacity(rows.len());
    for w in &rows {
        let mut item = Map::new();
        item.insert(
            String::from("ratingKey"),
            Value::from(w.rating_key.as_str()),
        );
        item.insert(String::from("title"), Value::from(w.title.as_str()));
        item.insert(String::from("id"), Value::from(w.id));
        item.insert(
            String::from("mediaType"),
            Value::from(w.media_type.as_str()),
        );
        item.insert(String::from("tmdbId"), Value::from(w.tmdb_id));
        item.insert(String::from("createdAt"), text(w.created_at.as_ref()));
        item.insert(String::from("updatedAt"), text(w.updated_at.as_ref()));
        item.insert(
            String::from("requestedBy"),
            try_forward!(related.user_json(Some(user_id), true)),
        );
        item.insert(
            String::from("media"),
            related.media_json(ctx, w.media_id, true),
        );
        results.push(Value::Object(item));
    }
    let results = annotate_provider_active_requests(ctx, results).await;
    ctx.json(&body(page, json!((total + 19) / 20), json!(total), results))
}
