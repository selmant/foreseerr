//! `GET /user/{id}/sonarr-storage`: what a user's requests take up in
//! Sonarr, read from Sonarr 5's statistics for the requester tag that
//! `tagRequests` puts on each series sent there.

use std::future::Future;
use std::pin::Pin;

use axum::http::Method;
use serde_json::{Map, Value};

use super::{Outcome, Ready, Table};
use crate::arr::Arr;
use crate::settings::public::truthy;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// `Permission.MANAGE_USERS` and `Permission.MANAGE_REQUESTS`, which let
/// a viewer see someone else's numbers, as for the quota.
const MANAGE_USERS: i64 = 8;
const MANAGE_REQUESTS: i64 = 16;

/// This module's routes.
pub(super) const ROUTES: &Table = &[("/api/v1/user/{id}/sonarr-storage", Method::GET, storage)];

/// `GET /user/{id}/sonarr-storage`: one entry per Sonarr server that tags
/// requests and speaks API v5; the others can't say, and are left out.
fn storage<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = ctx.no_query() {
            return Outcome::forward(why);
        }
        let viewer = match ctx.authenticated(0) {
            Ok(viewer) => viewer,
            Err(why) => return Outcome::forward(why),
        };
        let id = match super::params::path_int(ctx, 1) {
            Ok(id) => id,
            Err(why) => return Outcome::forward(why),
        };
        if id != viewer.id && !viewer.has_all_permissions(MANAGE_USERS | MANAGE_REQUESTS) {
            return ctx.error(
                403,
                "You do not have permission to view this user's storage.",
            );
        }
        match ctx.state.db.user_record(id).await {
            Ok(Some(_)) => {}
            Ok(None) => return ctx.error(404, "User not found."),
            Err(e) => return Outcome::forward(format!("loading the user failed: {e:#}")),
        }
        let servers = ctx
            .settings
            .get("/sonarr")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let timeout = crate::servarr::api_timeout(&ctx.settings);
        let mut usage = Vec::new();
        for server in servers.iter().filter(|s| truthy(s.get("tagRequests"))) {
            let arr = Arr {
                client: &ctx.state.servarr,
                server,
                timeout,
            };
            match server_usage(&arr, id).await {
                Ok(Some(entry)) => usage.push(entry),
                Ok(None) => {}
                Err(e) => tracing::warn!(
                    label = "Sonarr API",
                    "Could not read Sonarr's statistics for user {id}: {e:#}"
                ),
            }
        }
        let mut out = Map::new();
        out.insert(String::from("servers"), Value::Array(usage));
        ctx.json(&Value::Object(out))
    })
}

/// The user's usage on one server; none on a Sonarr without API v5.
async fn server_usage(arr: &Arr<'_>, user_id: i64) -> anyhow::Result<Option<Value>> {
    if !crate::sonarrmeta::is_v5(arr).await {
        return Ok(None);
    }
    let tags = arr.tags().await?;
    let stats = match crate::sonarrmeta::requester_tag_id(&tags, user_id) {
        Some(tag) => Some(crate::sonarrmeta::tag_statistics(arr, tag).await?),
        None => None,
    };
    Ok(Some(usage_json(arr.server, stats.as_ref())))
}

/// One server's entry; no statistics (the user has no tag there yet) reads
/// as nothing stored.
fn usage_json(server: &Value, stats: Option<&Value>) -> Value {
    let count = |key: &str| {
        stats
            .and_then(|s| s.get(key))
            .and_then(Value::as_i64)
            .unwrap_or(0)
    };
    let mut out = Map::new();
    for key in ["id", "name", "is4k"] {
        out.insert(
            key.to_owned(),
            server.get(key).cloned().unwrap_or(Value::Null),
        );
    }
    out.insert(
        String::from("seriesCount"),
        Value::from(count("seriesCount")),
    );
    out.insert(
        String::from("episodeCount"),
        Value::from(count("downloadedEpisodeCount")),
    );
    for key in ["episodeFileCount", "sizeOnDisk"] {
        out.insert(key.to_owned(), Value::from(count(key)));
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn entries() {
        let server = json!({"id": 1, "name": "Sonarr 5", "is4k": false, "apiKey": "secret"});
        assert_eq!(
            usage_json(
                &server,
                Some(&json!({
                    "seriesCount": 2, "downloadedEpisodeCount": 15, "episodeFileCount": 14,
                    "sizeOnDisk": 7_516_192_768_i64, "tagStatistics": []
                }))
            ),
            json!({
                "id": 1, "name": "Sonarr 5", "is4k": false, "seriesCount": 2,
                "episodeCount": 15, "episodeFileCount": 14, "sizeOnDisk": 7_516_192_768_i64
            }),
            "the totals, and nothing else of the server"
        );
        assert_eq!(
            usage_json(&server, None),
            json!({
                "id": 1, "name": "Sonarr 5", "is4k": false,
                "seriesCount": 0, "episodeCount": 0, "episodeFileCount": 0, "sizeOnDisk": 0
            }),
            "no tag yet"
        );
    }
}
