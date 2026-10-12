//! Request status changes: approve, decline and retry.
//!
//! The save runs the
//! request lifecycle (`crate::lifecycle`), which sends to Radarr or Sonarr
//! and notifies, and the answer is the entity as Node leaves it.

use std::future::Future;
use std::pin::Pin;

use serde_json::{Map, Value};

use super::blocklist::plain_integer;
use super::request::{columns, count_of, episodes_json, seasons_json};
use super::{Outcome, Ready};
use crate::downloads::Downloads;
use crate::lifecycle::{Entity, Lc, APPROVED, DECLINED, FAILED, PENDING};
use crate::media::{media_json, tracks_downloads};
use crate::user::filtered_json;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// `Permission.MANAGE_REQUESTS`.
const MANAGE_REQUESTS: i64 = 16;

/// `POST /request/{id}/approve`, `/decline` and `/retry`.
pub(super) fn status<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let viewer = match ctx
            .no_query()
            .and_then(|()| ctx.authenticated(MANAGE_REQUESTS))
        {
            Ok(user) => user.id,
            Err(why) => return Outcome::forward(why),
        };
        let mut parts = ctx.req.uri.path().rsplit('/');
        let action = parts.next().unwrap_or("");
        let Some(id) = parts.next().and_then(plain_integer) else {
            return Outcome::forward(String::from("the id must be an integer"));
        };
        let (from, to, conflict) = match action {
            "approve" => (
                PENDING,
                APPROVED,
                "Only pending requests can be approved or declined.",
            ),
            "decline" => (
                PENDING,
                DECLINED,
                "Only pending requests can be approved or declined.",
            ),
            "retry" => (FAILED, APPROVED, "Only failed requests can be retried."),
            _ => return Outcome::forward(String::from("the validator rejects other statuses")),
        };
        let lc = Lc {
            state: std::sync::Arc::clone(&ctx.shared),
            settings: std::sync::Arc::clone(&ctx.settings),
        };
        let mut entity = match lc.load(id).await {
            Ok(Some(entity)) => entity,
            Ok(None) => return ctx.error(404, "Request not found."),
            Err(e) => return Outcome::forward(format!("loading request {id} failed: {e:#}")),
        };
        let viewer_record = match ctx.state.db.user_record(viewer).await {
            Ok(Some(record)) => record,
            Ok(None) => return Outcome::forward(String::from("the viewer vanished")),
            Err(e) => return Outcome::forward(format!("loading the viewer failed: {e:#}")),
        };
        if entity.row.status != from {
            return ctx.error(409, conflict);
        }
        let downloads = if entity.media.as_ref().is_some_and(tracks_downloads) {
            match Downloads::fetch(
                &ctx.state.internal,
                &ctx.state.env.node_url,
                ctx.settings.api_key(),
            )
            .await
            {
                Ok(d) => d,
                Err(e) => {
                    return Outcome::forward(format!("reading the download tracker failed: {e:#}"))
                }
            }
        } else {
            Downloads::default()
        };
        entity.row.status = to;
        entity.row.modified_by_id = Some(viewer);
        entity.modified_by = Some(viewer_record);
        if let Err(e) = lc.save(&mut entity).await {
            tracing::error!("Error processing request update: {e:#}");
            if crate::db::is_unique_violation(&e) {
                return ctx.error(
                    409,
                    "An ongoing episode request already exists for this series.",
                );
            }
            return ctx.error(404, "Request not found.");
        }
        match entity_json(ctx, &entity, &downloads) {
            Ok(json) => ctx.json(&json),
            Err(why) => Outcome::forward(why),
        }
    })
}

/// The request as `findOne` with `requestedBy` and `modifiedBy` builds it,
/// after the handler and the hooks changed it.
fn entity_json(ctx: &Ready<'_>, e: &Entity, downloads: &Downloads) -> Result<Value, String> {
    let user = |rel: Option<&crate::lifecycle::UserRel>| -> Result<Value, String> {
        rel.map_or(Ok(Value::Null), |(u, s)| {
            filtered_json(u, Some(s.as_ref()), true).map_err(str::to_owned)
        })
    };
    let mut out = Map::new();
    columns(&mut out, &e.row);
    out.insert(String::from("requestedBy"), user(e.requested_by.as_ref())?);
    out.insert(String::from("modifiedBy"), user(e.modified_by.as_ref())?);
    out.insert(
        String::from("media"),
        e.media.as_ref().map_or(Value::Null, |m| {
            media_json(m, &ctx.settings, downloads, true)
        }),
    );
    out.insert(String::from("seasons"), seasons_json(&e.row.seasons));
    out.insert(String::from("episodes"), episodes_json(&e.row.episodes));
    out.insert(String::from("seasonCount"), count_of(&e.row.seasons));
    Ok(Value::Object(out))
}
