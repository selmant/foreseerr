//! `PUT /request/{id}` for an episode request (or one becoming one): the
//! selection is resolved against the TVDB catalog again and replaces the
//! request's episodes (`server/routes/request.ts`).

use std::collections::HashSet;

use serde_json::{Map, Value};

use super::draft::{fail_on_err, forward_on_err};
use super::episodeselect::{self, Refused, Resolved, Selection};
use super::requestedit::{changed_columns, loaded_json, Body};
use super::{Outcome, Ready};
use crate::db::{Bind, RequestRow};
use crate::jobs::syncutil::Tx;
use crate::lifecycle::{Entity, UserRel, PENDING};
use crate::settings::public::truthy;

/// A refused selection: the route's 400 with the thrown message.
fn refused(ctx: &Ready<'_>, refused: Refused) -> Outcome {
    match refused {
        Refused::Invalid(message) => ctx.error(400, &message),
        Refused::Forward(why) => Outcome::forward(why),
    }
}

/// `getResolvedTvdbEpisodeSelection` with the requester's Jellyfin
/// progress for a watch-ahead.
async fn resolve(
    ctx: &Ready<'_>,
    e: &Entity,
    selection: Selection,
    request_user: i64,
) -> Result<Resolved, Outcome> {
    let tmdb_id = e.media.as_ref().map_or(0, |m| m.tmdb_id);
    let catalog = episodeselect::catalog(ctx, tmdb_id)
        .await
        .map_err(|r| refused(ctx, r))?;
    let played = if let Selection::WatchAhead(_) = selection {
        let series = e.media.as_ref().and_then(|m| {
            if e.row.is4k {
                m.jellyfin_media_id4k.as_deref()
            } else {
                m.jellyfin_media_id.as_deref()
            }
        });
        episodeselect::played(ctx, request_user, series, &catalog).await
    } else {
        HashSet::new()
    };
    let specials = truthy(ctx.settings.get("/main/enableSpecialEpisodes"));
    episodeselect::resolve(selection, &catalog, specials, &played).map_err(|r| refused(ctx, r))
}

/// The columns of the episode assignments a save writes: defined values
/// that differ from the row (`undefined` leaves a column as it is).
pub(super) fn episode_columns(
    row: &RequestRow,
    r: &Resolved,
    key: Option<&str>,
) -> Vec<(&'static str, Bind)> {
    let mut sets = Vec::new();
    if row.episode_selection_type.as_deref() != Some(r.kind) {
        sets.push(("episodeSelectionType", Bind::Text(r.kind.to_owned())));
    }
    if row.episode_start_tvdb_id != Some(r.start) {
        sets.push(("episodeStartTvdbId", Bind::Int(r.start)));
    }
    if let Some(end) = r.end.filter(|end| row.episode_end_tvdb_id != Some(*end)) {
        sets.push(("episodeEndTvdbId", Bind::Int(end)));
    }
    if let Some(count) = r
        .watch_ahead
        .filter(|count| row.watch_ahead_count != Some(*count))
    {
        sets.push(("watchAheadCount", Bind::Int(count)));
    }
    let units = episodeselect::quota_units(&r.episodes);
    if row.tv_quota_units != units {
        sets.push(("tvQuotaUnits", Bind::Int(units)));
    }
    if let Some(key) = key.filter(|key| row.ongoing_episode_request_key.as_deref() != Some(*key)) {
        sets.push(("ongoingEpisodeRequestKey", Bind::Text(key.to_owned())));
    }
    sets
}

/// The `UNIQUE` failure of the ongoing-request index.
pub(super) fn conflict(ctx: &Ready<'_>) -> Outcome {
    ctx.error(
        409,
        "An ongoing episode request already exists for this series.",
    )
}

/// The writes of the save: the old episodes deleted, the row's changed
/// columns, the new episodes and the seasons the request no longer holds.
async fn save(
    ctx: &Ready<'_>,
    e: &Entity,
    sets: &[(&'static str, Bind)],
    r: &Resolved,
) -> anyhow::Result<()> {
    // `dataSource.transaction` around the delete and the save.
    let mut tx = Tx::begin(&ctx.state.db).await?;
    let db = &mut tx;
    db.execute(
        r#"DELETE FROM "episode_request" WHERE "requestId" = ?1"#,
        &[Bind::Int(e.row.id)],
    )
    .await?;
    if !sets.is_empty() {
        let mut binds: Vec<Bind> = sets.iter().map(|(_, b)| b.clone()).collect();
        let assignments: Vec<String> = sets
            .iter()
            .enumerate()
            .map(|(i, (column, _))| format!(r#""{column}" = ?{}"#, i + 1))
            .collect();
        binds.push(Bind::Int(e.row.id));
        db.execute(
            &format!(
                r#"UPDATE "media_request" SET {}, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?{}"#,
                assignments.join(", "),
                binds.len()
            ),
            &binds,
        )
        .await?;
    }
    episodeselect::insert_episodes(
        &mut crate::dbtx::Exec::Tx(db),
        e.row.id,
        &r.episodes,
        PENDING,
    )
    .await?;
    for season in &e.row.seasons {
        db.execute(
            r#"UPDATE "season_request" SET "requestId" = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?1"#,
            &[Bind::Int(season.id)],
        )
        .await?;
    }
    tx.commit().await
}

/// Assign `value` to `key`; an `undefined` one prints as null once the row
/// was updated and not at all otherwise.
fn assign(out: &mut Map<String, Value>, key: &str, value: Option<Value>, updated: bool) {
    match value {
        Some(value) => {
            out.insert(key.to_owned(), value);
        }
        None if updated => {
            out.insert(key.to_owned(), Value::Null);
        }
        None => {
            out.shift_remove(key);
        }
    }
}

/// The checks before the selection is resolved: TVDB episode requests
/// must be available, and only a selection (no seasons) is accepted.
async fn preconditions(ctx: &Ready<'_>, e: &Entity, body: &Body) -> Result<Selection, Outcome> {
    let tmdb_id = e.media.as_ref().map_or(0, |m| m.tmdb_id);
    let locale = super::listwrite::main_locale(ctx);
    let details = ctx
        .state
        .tmdb
        .tv(tmdb_id, &locale)
        .await
        .map_err(|err| episodeselect::tmdb_failed(ctx, false, &err))?;
    if !episodeselect::available(&ctx.settings, &details) {
        return Err(ctx.error(
            400,
            "Episode requests require partial requests and the TVDB metadata provider.",
        ));
    }
    let Some(raw) = body
        .episode_selection
        .as_ref()
        .filter(|s| !s.is_null() && body.seasons.is_none())
    else {
        return Err(ctx.error(
            400,
            "Episode requests require an episode selection and cannot include seasons.",
        ));
    };
    episodeselect::parse(raw).map_err(|r| refused(ctx, r))
}

/// `PUT /request/{id}`'s episode branch, once the request, its requester
/// and the caller's rights are settled.
pub(super) async fn edit(
    ctx: &Ready<'_>,
    e: &Entity,
    body: &Body,
    request_user: &UserRel,
) -> Outcome {
    let selection = match preconditions(ctx, e, body).await {
        Ok(selection) => selection,
        Err(answer) => return answer,
    };
    let resolved = match resolve(ctx, e, selection, request_user.0.id).await {
        Ok(resolved) => resolved,
        Err(answer) => return answer,
    };
    let units = episodeselect::quota_units(&resolved.episodes);
    let (_, tv_quota) = forward_on_err!(super::requestcreate::quotas(ctx, request_user).await);
    if tv_quota.edit_exceeds(e.row.ignore_quota, units, e.row.tv_quota_units) {
        return ctx.error(403, "Series Quota exceeded.");
    }
    let tmdb_id = e.media.as_ref().map_or(0, |m| m.tmdb_id);
    let rolling = matches!(resolved.kind, "after" | "watchAhead");
    let key = rolling.then(|| episodeselect::lock_key(tmdb_id, e.row.is4k));
    if let Some(key) = &key {
        match episodeselect::ongoing_conflict(ctx, key, resolved.kind, Some(e.row.id)).await {
            Ok(true) => return conflict(ctx),
            Ok(false) => {}
            Err(err) => return Outcome::forward(format!("database: {err:#}")),
        }
    }
    let mut sets = changed_columns(e, body, true, request_user.0.id);
    sets.extend(episode_columns(&e.row, &resolved, key.as_deref()));
    let loaded = forward_on_err!(loaded_json(ctx, e, request_user).await);
    if let Err(err) = save(ctx, e, &sets, &resolved).await {
        tracing::error!("editing request {} failed: {err:#}", e.row.id);
        return ctx.error(500, &crate::db::failure_message(&err));
    }
    // Saved: from here on failures are answered here.
    let fresh = fail_on_err!(
        ctx,
        ctx.state
            .db
            .request_by_id(e.row.id)
            .await
            .map_err(|err| format!("database: {err:#}"))
    );
    let Some(fresh) = fresh else {
        tracing::error!("request {} vanished after its edit", e.row.id);
        return ctx.error(500, "the request vanished");
    };
    ctx.json(&edited_json(
        loaded,
        body,
        &resolved,
        key,
        &fresh,
        !sets.is_empty(),
    ))
}

/// The loaded request after the handler's assignments and the save.
fn edited_json(
    mut out: Map<String, Value>,
    body: &Body,
    r: &Resolved,
    key: Option<String>,
    fresh: &RequestRow,
    updated: bool,
) -> Value {
    assign(
        &mut out,
        "serverId",
        body.server_id.map(Value::from),
        updated,
    );
    assign(
        &mut out,
        "profileId",
        body.profile_id.map(Value::from),
        updated,
    );
    assign(
        &mut out,
        "rootFolder",
        body.root_folder.clone().map(Value::from),
        updated,
    );
    assign(
        &mut out,
        "languageProfileId",
        body.language_profile_id.map(Value::from),
        updated,
    );
    assign(
        &mut out,
        "tags",
        body.tags
            .as_ref()
            .map(|t| Value::Array(t.iter().copied().map(Value::from).collect())),
        updated,
    );
    out.insert(
        String::from("episodes"),
        episodeselect::episodes_json(&r.episodes, PENDING, &fresh.episodes),
    );
    out.insert(String::from("seasons"), Value::Array(Vec::new()));
    out.insert(String::from("episodeSelectionType"), Value::from(r.kind));
    out.insert(String::from("episodeStartTvdbId"), Value::from(r.start));
    assign(
        &mut out,
        "episodeEndTvdbId",
        r.end.map(Value::from),
        updated,
    );
    assign(
        &mut out,
        "watchAheadCount",
        r.watch_ahead.map(Value::from),
        updated,
    );
    out.insert(
        String::from("tvQuotaUnits"),
        Value::from(episodeselect::quota_units(&r.episodes)),
    );
    assign(
        &mut out,
        "ongoingEpisodeRequestKey",
        key.map(Value::from),
        updated,
    );
    out.insert(
        String::from("updatedAt"),
        fresh.updated_at.as_deref().map_or(Value::Null, Value::from),
    );
    Value::Object(out)
}
