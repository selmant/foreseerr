//! `GET /user/{id}/watchlist` (local rows), the push subscription routes
//! and the Trakt and Simkl linked-account reads.

use std::future::Future;
use std::pin::Pin;

use serde_json::{Map, Value};

use super::related::Related;
use super::{Outcome, Ready};
use crate::db::{Bind, PushSubscriptionRow};

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

const MANAGE_USERS: i64 = 8;
const MANAGE_REQUESTS: i64 = 16;
const WATCHLIST_VIEW: i64 = 134_217_728;

macro_rules! try_forward {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(why) => return Outcome::forward(why),
        }
    };
}

macro_rules! try_db {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(e) => return Outcome::forward(format!("database: {e:#}")),
        }
    };
}

/// `isOwnProfileOrAdmin`: the user named in the path or a `MANAGE_USERS`
/// holder; anyone else gets Node's 403.
fn own_or_admin(ctx: &Ready<'_>, id: i64) -> Result<(), super::Fallback> {
    let viewer = ctx.authenticated(0)?;
    if viewer.id == id || viewer.has_permission(MANAGE_USERS) {
        Ok(())
    } else {
        Err(super::Fallback::not_own_profile())
    }
}

/// `plexTV.getWatchlist({ offset })` for a user with a Plex token, as the
/// watchlist route prints it.
async fn plex_watchlist(ctx: &Ready<'_>, id: i64, page: i64, offset: i64) -> Outcome {
    let rows = try_db!(
        ctx.state
            .db
            .rows(
                r#"SELECT "plexToken" FROM "user" WHERE "id" = ?1"#,
                &[Bind::Int(id)]
            )
            .await
    );
    let token = rows
        .first()
        .and_then(|r| r.get("plexToken"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let offset = crate::jsnum::from_i64(offset);
    let watchlist = match crate::plexwatchlist::watchlist(&ctx.state.outbound, &token, offset).await
    {
        Ok(watchlist) => watchlist,
        Err(crate::plexwatchlist::Unportable(why)) => return Outcome::forward(why),
    };
    let total = watchlist.total_size.as_f64().unwrap_or(f64::NAN);
    let results: Vec<Value> = watchlist
        .items
        .iter()
        .map(|item| {
            let found = item.tmdb_id != 0.0 && !item.tmdb_id.is_nan();
            let mut out = Map::new();
            out.insert(
                String::from("id"),
                if found {
                    crate::jsnum::json(item.tmdb_id)
                } else {
                    Value::from(0)
                },
            );
            if let Some(key) = &item.rating_key {
                out.insert(String::from("ratingKey"), key.clone());
            }
            if let Some(title) = &item.title {
                out.insert(String::from("title"), title.clone());
            }
            let show = item.kind.as_ref().and_then(Value::as_str) == Some("show");
            out.insert(
                String::from("mediaType"),
                Value::from(if show { "tv" } else { "movie" }),
            );
            if found {
                out.insert(String::from("tmdbId"), crate::jsnum::json(item.tmdb_id));
            }
            out.insert(String::from("source"), Value::from("plex"));
            if let Some(key) = &item.rating_key {
                out.insert(String::from("sourceId"), key.clone());
            }
            Value::Object(out)
        })
        .collect();
    let mut out = Map::new();
    out.insert(String::from("page"), Value::from(page));
    out.insert(
        String::from("totalPages"),
        crate::jsnum::json((total / 20.0).ceil()),
    );
    out.insert(String::from("totalResults"), watchlist.total_size);
    out.insert(String::from("results"), Value::Array(results));
    ctx.json(&Value::Object(out))
}

/// `GET /user/{id}/watchlist`: the user's local watchlist rows, each with
/// its user and media; without local rows, their Plex watchlist (none
/// without a Plex token).
pub(super) fn watchlist<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let viewer = try_forward!(ctx.authenticated(0));
        let id = try_forward!(super::params::path_int(ctx, 1));
        let own = id == viewer.id;
        if !own && !viewer.has_permission(MANAGE_REQUESTS | WATCHLIST_VIEW) {
            return ctx.error(
                403,
                "You do not have permission to view this user's Watchlist.",
            );
        }
        // `req.query.page ? Number(req.query.page) : 1`.
        let Some(query) = super::params::query(ctx) else {
            return Outcome::forward("the query string could not be validated");
        };
        let page = try_forward!(super::params::int_or(query.get("page"), "page", 1));
        let offset = page.saturating_sub(1).saturating_mul(20).max(0);
        // No try/catch: a failure reaches the error handler as a 500.
        if try_db!(ctx.state.db.user(id).await).is_none() {
            return ctx.error(500, "User not found.");
        }
        let (rows, total) = try_db!(ctx.state.db.watchlist_page(id, 20, offset).await);
        if total == 0 {
            if try_db!(ctx.state.db.user_has_plex_token(id).await) {
                return plex_watchlist(ctx, id, page, offset).await;
            }
            let mut out = Map::new();
            out.insert(String::from("page"), Value::from(1));
            out.insert(String::from("totalPages"), Value::from(1));
            out.insert(String::from("totalResults"), Value::from(0));
            out.insert(String::from("results"), Value::Array(Vec::new()));
            return ctx.json(&Value::Object(out));
        }
        let media_ids: Vec<i64> = rows.iter().filter_map(|r| r.media_id).collect();
        let related = try_forward!(Related::load(ctx, &media_ids, &[id], true).await);
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
                try_forward!(related.user_json(Some(id), true)),
            );
            item.insert(
                String::from("media"),
                related.media_json(ctx, w.media_id, true),
            );
            results.push(Value::Object(item));
        }
        let mut out = Map::new();
        out.insert(String::from("page"), Value::from(page));
        out.insert(String::from("totalPages"), Value::from((total + 19) / 20));
        out.insert(String::from("totalResults"), Value::from(total));
        out.insert(String::from("results"), Value::Array(results));
        ctx.json(&Value::Object(out))
    })
}

/// A subscription with its user (eager, with settings).
fn push_json(related: &Related, s: &PushSubscriptionRow) -> Result<Value, String> {
    let mut out = Map::new();
    out.insert(String::from("id"), Value::from(s.id));
    out.insert(String::from("endpoint"), Value::from(s.endpoint.as_str()));
    out.insert(String::from("p256dh"), Value::from(s.p256dh.as_str()));
    out.insert(String::from("auth"), Value::from(s.auth.as_str()));
    out.insert(
        String::from("userAgent"),
        s.user_agent.as_deref().map_or(Value::Null, Value::from),
    );
    out.insert(
        String::from("createdAt"),
        s.created_at.as_deref().map_or(Value::Null, Value::from),
    );
    out.insert(String::from("user"), related.user_json(s.user_id, true)?);
    Ok(Value::Object(out))
}

/// `GET /user/{id}/pushSubscriptions`.
pub(super) fn push_subscriptions<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let id = try_forward!(super::params::path_int(ctx, 1));
        try_forward!(own_or_admin(ctx, id));
        let subs = try_db!(ctx.state.db.push_subscriptions(id, None).await);
        let related = try_forward!(Related::load(ctx, &[], &[id], false).await);
        let mut out = Vec::with_capacity(subs.len());
        for s in &subs {
            out.push(try_forward!(push_json(&related, s)));
        }
        ctx.json(&Value::Array(out))
    })
}

/// The decoded endpoint, the last path segment.
fn endpoint(ctx: &Ready<'_>) -> Result<String, String> {
    let raw = ctx.req.uri.path().rsplit('/').next().unwrap_or("");
    percent_decode(raw).ok_or_else(|| String::from("an endpoint Express can't decode"))
}

/// `decodeURIComponent` for a path segment.
fn percent_decode(raw: &str) -> Option<String> {
    let mut out = Vec::with_capacity(raw.len());
    let mut bytes = raw.bytes();
    while let Some(b) = bytes.next() {
        if b == b'%' {
            let hi = char::from(bytes.next()?).to_digit(16)?;
            let lo = char::from(bytes.next()?).to_digit(16)?;
            out.push(u8::try_from(hi * 16 + lo).ok()?);
        } else {
            out.push(b);
        }
    }
    String::from_utf8(out).ok()
}

/// `GET /user/{id}/pushSubscription/{endpoint}`.
pub(super) fn push_subscription<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let id = try_forward!(super::params::path_int(ctx, 2));
        try_forward!(own_or_admin(ctx, id));
        let endpoint = try_forward!(endpoint(ctx));
        let subs = try_db!(ctx.state.db.push_subscriptions(id, Some(&endpoint)).await);
        let Some(sub) = subs.first() else {
            return ctx.error(404, "User subscription not found.");
        };
        let related = try_forward!(Related::load(ctx, &[], &[id], false).await);
        ctx.json(&try_forward!(push_json(&related, sub)))
    })
}

/// `DELETE /user/{id}/pushSubscription/{endpoint}`: 204 either way.
pub(super) fn push_subscription_delete<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let id = try_forward!(super::params::path_int(ctx, 2));
        try_forward!(own_or_admin(ctx, id));
        let endpoint = try_forward!(endpoint(ctx));
        let removed = ctx
            .state
            .db
            .execute(
                r#"DELETE FROM "user_push_subscription" WHERE "id" = (SELECT "id" FROM "user_push_subscription" WHERE "userId" = ?1 AND "endpoint" = ?2 ORDER BY "id" LIMIT 1)"#,
                &[Bind::Int(id), Bind::Text(endpoint)],
            )
            .await;
        if let Err(e) = removed {
            tracing::error!("Something went wrong deleting the user push subscription: {e:#}");
            return ctx.error(500, "User push subscription not found");
        }
        Ready::no_content()
    })
}

/// `GET /user/{id}/settings/linked-accounts/trakt`, direct Trakt only.
pub(super) fn trakt<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        // `includePluginStatus` only matters to the Jellyfin provider.
        if ctx.judged().is_none() {
            try_forward!(ctx.no_query());
        }
        let id = try_forward!(super::params::path_int(ctx, 3));
        try_forward!(own_or_admin(ctx, id));
        let row = try_db!(ctx.state.db.linked_accounts(id).await).unwrap_or_default();
        if ctx.settings.str("/trakt/provider") == "jellyfin" {
            // `String(req.query.includePluginStatus) === 'true'`.
            let include = ctx
                .judged()
                .and_then(|v| v.query.get("includePluginStatus"))
                .is_some_and(|v| crate::media::js_string(Some(v)) == "true");
            let actions = row.trakt_actions != Some(false);
            return match super::bettertrakt::linked_payload(ctx, id, include, actions).await {
                Ok(payload) => ctx.json(&payload),
                Err(e) => ctx.error(500, &format!("{e:#}")),
            };
        }
        let connected = row.trakt_access && row.trakt_refresh;
        let mut out = Map::new();
        out.insert(String::from("provider"), Value::from("direct"));
        out.insert(String::from("connected"), Value::Bool(connected));
        out.insert(
            String::from("username"),
            if connected {
                row.trakt_username.map_or(Value::Null, Value::from)
            } else {
                Value::Null
            },
        );
        out.insert(
            String::from("actionsEnabled"),
            Value::Bool(row.trakt_actions != Some(false)),
        );
        ctx.json(&Value::Object(out))
    })
}

/// `GET /user/{id}/settings/linked-accounts/simkl`.
pub(super) fn simkl<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let id = try_forward!(super::params::path_int(ctx, 3));
        try_forward!(own_or_admin(ctx, id));
        let row = try_db!(ctx.state.db.linked_accounts(id).await).unwrap_or_default();
        let connected = row.simkl_access;
        let mut out = Map::new();
        out.insert(String::from("connected"), Value::Bool(connected));
        out.insert(
            String::from("username"),
            if connected {
                row.simkl_username.map_or(Value::Null, Value::from)
            } else {
                Value::Null
            },
        );
        out.insert(
            String::from("actionsEnabled"),
            Value::Bool(row.simkl_actions != Some(false)),
        );
        ctx.json(&Value::Object(out))
    })
}
