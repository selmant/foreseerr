//! `PUT /request/{id}` (movies and whole seasons; episode selections in
//! `super::requestepisodes`) and `DELETE /request/{id}` with the
//! subscriber's `afterRemove`.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use axum::http::Method;
use serde_json::{Map, Value};

use super::draft::{body_object, downloads_for, forward_on_err, known_keys, opt_text, user_json};
use super::requestcreate::has_all;
use super::{Outcome, Ready, Table};
use crate::db::{Bind, Db, SeasonRequestRow};
use crate::dbtx::Exec;
use crate::jobs::syncutil::Tx;
use crate::lifecycle::{Entity, Lc, UserRel, COMPLETED, DECLINED, PENDING};

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// `Permission` bits.
const MANAGE_USERS: i64 = 8;
const MANAGE_REQUESTS: i64 = 16;
const REQUEST_ADVANCED: i64 = 8192;

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/request/{id}", Method::PUT, edit),
    ("/api/v1/request/{id}", Method::DELETE, remove),
];

pub(super) fn lc(ctx: &Ready<'_>) -> Lc {
    Lc {
        state: Arc::clone(&ctx.shared),
        settings: Arc::clone(&ctx.settings),
    }
}

/// The edit body as the spec lets it through.
pub(super) struct Body {
    media_type: String,
    pub(super) seasons: Option<Vec<i64>>,
    pub(super) server_id: Option<i64>,
    pub(super) profile_id: Option<i64>,
    pub(super) root_folder: Option<String>,
    pub(super) language_profile_id: Option<i64>,
    /// `metadataLanguageId`: absent keeps the stored one, `null` clears it.
    pub(super) metadata_language_id: super::params::Assign,
    user_id: Option<i64>,
    pub(super) tags: Option<Vec<i64>>,
    /// `episodeSelection`, when sent.
    pub(super) episode_selection: Option<Value>,
}

fn int_list(value: &Value, what: &str) -> Result<Vec<i64>, String> {
    value
        .as_array()
        .ok_or_else(|| format!("{what} isn't a list"))?
        .iter()
        .map(|v| {
            v.as_i64()
                .ok_or_else(|| format!("{what} has a non-integer"))
        })
        .collect()
}

fn parse_body(ctx: &Ready<'_>) -> Result<Body, super::Fallback> {
    use super::params::body_int;
    let body = body_object(ctx)?;
    known_keys(
        body,
        &[
            "mediaType",
            "seasons",
            "is4k",
            "serverId",
            "profileId",
            "rootFolder",
            "languageProfileId",
            "metadataLanguageId",
            "userId",
            "tags",
            "episodeSelection",
        ],
    )?;
    let media_type = match body.get("mediaType").and_then(Value::as_str) {
        Some(t @ ("movie" | "tv")) => t.to_owned(),
        _ => return Err(String::from("mediaType is the validator's").into()),
    };
    if body.get("is4k").is_some_and(|v| !v.is_boolean()) {
        return Err(String::from("is4k isn't a boolean").into());
    }
    let seasons = body
        .get("seasons")
        .map(|v| int_list(v, "seasons"))
        .transpose()?;
    if seasons.as_ref().is_some_and(|s| s.iter().any(|n| *n < 0)) {
        return Err(String::from("a negative season; the validator answers").into());
    }
    let user_id = match body.get("userId") {
        None | Some(Value::Null) => None,
        Some(_) => body_int(body, "userId")?,
    };
    Ok(Body {
        media_type,
        seasons,
        server_id: body_int(body, "serverId")?,
        profile_id: body_int(body, "profileId")?,
        root_folder: opt_text(body, "rootFolder")?,
        language_profile_id: body_int(body, "languageProfileId")?,
        metadata_language_id: super::params::body_id_assign(body, "metadataLanguageId")?,
        user_id: user_id.filter(|id| *id != 0),
        tags: body.get("tags").map(|v| int_list(v, "tags")).transpose()?,
        episode_selection: body.get("episodeSelection").cloned(),
    })
}

/// The `tags` column transformer's `to`.
fn tags_column(tags: &[i64]) -> String {
    let joined = tags
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(",");
    if joined.is_empty() {
        String::from("none")
    } else {
        joined
    }
}

/// The columns a save writes: those assigned a defined value that differs
/// from the row, plus `modifiedById` when it is null (`TypeORM` always
/// counts a null relation as changed).
pub(super) fn changed_columns(
    e: &Entity,
    body: &Body,
    tv: bool,
    requested_by: i64,
) -> Vec<(&'static str, Bind)> {
    let row = &e.row;
    let mut sets = Vec::new();
    if let Some(v) = body.server_id.filter(|v| row.server_id != Some(*v)) {
        sets.push(("serverId", Bind::Int(v)));
    }
    if let Some(v) = body.profile_id.filter(|v| row.profile_id != Some(*v)) {
        sets.push(("profileId", Bind::Int(v)));
    }
    if let Some(v) = body
        .root_folder
        .as_ref()
        .filter(|v| row.root_folder.as_ref() != Some(*v))
    {
        sets.push(("rootFolder", Bind::Text(v.clone())));
    }
    if tv {
        if let Some(v) = body
            .language_profile_id
            .filter(|v| row.language_profile_id != Some(*v))
        {
            sets.push(("languageProfileId", Bind::Int(v)));
        }
        if body.metadata_language_id.changes(row.metadata_language_id) {
            sets.push((
                "metadataLanguageId",
                Bind::OptInt(body.metadata_language_id.value()),
            ));
        }
    }
    if let Some(tags) = &body.tags {
        let stored = tags_column(tags);
        if row.tags.as_ref() != Some(&stored) {
            sets.push(("tags", Bind::Text(stored)));
        }
    }
    if row.requested_by_id != Some(requested_by) {
        sets.push(("requestedById", Bind::Int(requested_by)));
    }
    if row.modified_by_id.is_none() {
        sets.push(("modifiedById", Bind::OptInt(None)));
    }
    sets
}

/// The seasons of a series edit: kept, added and orphaned.
struct SeasonEdit {
    keep: Vec<SeasonRequestRow>,
    add: Vec<i64>,
    orphaned: Vec<i64>,
    units: i64,
}

/// `PUT /request/{id}`'s series branch up to the save, or the answer.
async fn season_edit(
    ctx: &Ready<'_>,
    e: &Entity,
    requested: &[i64],
) -> Result<Result<SeasonEdit, Outcome>, String> {
    let tmdb_id = e.media.as_ref().map_or(0, |m| m.tmdb_id);
    let db = &ctx.state.db;
    let Some(media) = db
        .media_by_tmdb(tmdb_id, "tv")
        .await
        .map_err(|err| format!("database: {err:#}"))?
    else {
        return Err(String::from("the request could not be loaded"));
    };
    let others = db
        .requests_of_media(media.id)
        .await
        .map_err(|err| format!("database: {err:#}"))?;
    let existing: Vec<i64> = others
        .iter()
        .filter(|r| {
            r.is4k == e.row.is4k
                && r.id != e.row.id
                && r.status != DECLINED
                && r.status != COMPLETED
        })
        .flat_map(|r| r.seasons.iter().map(|s| s.season_number))
        .collect();
    let filtered: Vec<i64> = requested
        .iter()
        .copied()
        .filter(|s| !existing.contains(s))
        .collect();
    if filtered.is_empty() {
        return Ok(Err(ctx.error(202, "No seasons available to request")));
    }
    let current: Vec<i64> = e.row.seasons.iter().map(|s| s.season_number).collect();
    let add: Vec<i64> = filtered
        .iter()
        .copied()
        .filter(|s| !current.contains(s))
        .collect();
    let (keep, orphaned): (Vec<SeasonRequestRow>, Vec<SeasonRequestRow>) = e
        .row
        .seasons
        .iter()
        .cloned()
        .partition(|s| filtered.contains(&s.season_number));
    Ok(Ok(SeasonEdit {
        keep,
        add,
        orphaned: orphaned.iter().map(|s| s.id).collect(),
        units: i64::try_from(filtered.len()).unwrap_or(i64::MAX),
    }))
}

/// `PUT /request/{id}`.
fn edit<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        forward_on_err!(ctx.no_query());
        let user = forward_on_err!(ctx.authenticated(0));
        let id = forward_on_err!(super::params::path_int(ctx, 0));
        let body = forward_on_err!(parse_body(ctx));
        let lc = lc(ctx);
        let mut e = match lc.load(id).await {
            Ok(Some(e)) => e,
            Ok(None) => return ctx.error(404, "Request not found."),
            Err(err) => return Outcome::forward(format!("loading request {id} failed: {err:#}")),
        };
        let Some(media_type) = e.media.as_ref().map(|m| m.media_type.clone()) else {
            return Outcome::forward(String::from("the request has no media"));
        };
        if body.media_type != media_type {
            return ctx.error(400, "A request cannot change its media type.");
        }
        let Some(owner) = e.row.requested_by_id else {
            return Outcome::forward(String::from("the request has no requester"));
        };
        let tv = media_type == "tv";
        if (owner != user.id || (!tv && !user.has_permission(REQUEST_ADVANCED)))
            && !user.has_permission(MANAGE_REQUESTS)
        {
            return ctx.error(403, "You do not have permission to modify this request.");
        }
        if e.row.status != PENDING {
            return ctx.error(409, "Only pending requests can be modified.");
        }
        let mut request_user: Option<UserRel> = e.requested_by.clone();
        if let Some(uid) = body.user_id {
            if uid != owner && !has_all(user.permissions, MANAGE_USERS | MANAGE_REQUESTS) {
                return ctx.error(
                    403,
                    "You do not have permission to modify the request user.",
                );
            }
            match ctx.state.db.user_record(uid).await {
                Ok(Some(rel)) => request_user = Some(rel),
                // `findOneOrFail` throws into the handler's catch.
                Ok(None) => return ctx.error(500, "User not found."),
                Err(e) => return ctx.error(500, &crate::db::failure_message(&e)),
            }
        }
        let Some(request_user) = request_user else {
            return Outcome::forward(String::from("the requester is gone"));
        };
        let episodic = e
            .row
            .episode_selection_type
            .as_ref()
            .is_some_and(|t| !t.is_empty())
            || body
                .episode_selection
                .as_ref()
                .is_some_and(|s| !s.is_null());
        if tv && episodic {
            return super::requestepisodes::edit(ctx, &e, &body, &request_user).await;
        }
        let seasons = if tv {
            let Some(requested) = body.seasons.clone().filter(|s| !s.is_empty()) else {
                return ctx.error(
                    500,
                    "Missing seasons. If you want to cancel a series request, use the DELETE method.",
                );
            };
            let edit = match forward_on_err!(season_edit(ctx, &e, &requested).await) {
                Ok(edit) => edit,
                Err(answer) => return answer,
            };
            let (_, tv_quota) =
                forward_on_err!(super::requestcreate::quotas(ctx, &request_user).await);
            if tv_quota.edit_exceeds(e.row.ignore_quota, edit.units, e.row.tv_quota_units) {
                return ctx.error(403, "Series Quota exceeded.");
            }
            Some(edit)
        } else {
            None
        };
        let mut sets = changed_columns(&e, &body, tv, request_user.0.id);
        if let Some(edit) = &seasons {
            if edit.units != e.row.tv_quota_units {
                sets.push(("tvQuotaUnits", Bind::Int(edit.units)));
            }
        }
        let seasons_change = seasons
            .as_ref()
            .is_some_and(|s| !s.add.is_empty() || !s.orphaned.is_empty());
        let loaded_json = forward_on_err!(loaded_json(ctx, &e, &request_user).await);
        let unchanged = sets.is_empty() && !seasons_change;
        if unchanged {
            return ctx.json(&edited_json(loaded_json, &e, &body, tv, seasons.as_ref()));
        }
        if let Err(err) = save(&ctx.state.db, &mut e, &sets, seasons.as_ref()).await {
            tracing::error!("editing request {id} failed: {err:#}");
            return ctx.error(500, &format!("{err:#}"));
        }
        ctx.json(&edited_json(loaded_json, &e, &body, tv, seasons.as_ref()))
    })
}

/// The request as `findOne` loads it, with the new requester.
pub(super) async fn loaded_json(
    ctx: &Ready<'_>,
    e: &Entity,
    requested_by: &UserRel,
) -> Result<Map<String, Value>, String> {
    let media: Vec<&crate::db::MediaRow> = e.media.iter().collect();
    let downloads = downloads_for(&media);
    let mut out = Map::new();
    super::request::columns(&mut out, &e.row);
    out.insert(
        String::from("media"),
        e.media.as_ref().map_or(Value::Null, |m| {
            crate::media::media_json(m, &ctx.settings, &downloads, true)
        }),
    );
    out.insert(String::from("requestedBy"), user_json(requested_by)?);
    out.insert(
        String::from("modifiedBy"),
        e.modified_by.as_ref().map_or(Ok(Value::Null), user_json)?,
    );
    out.insert(
        String::from("seasons"),
        super::request::seasons_json(&e.row.seasons),
    );
    out.insert(
        String::from("episodes"),
        super::request::episodes_json(&e.row.episodes),
    );
    out.insert(
        String::from("seasonCount"),
        super::request::count_of(&e.row.seasons),
    );
    Ok(out)
}

/// The writes of the save: new seasons, the row, orphaned seasons, in
/// one transaction as the cascaded `requestRepository.save` runs them.
async fn save(
    db: &Db,
    e: &mut Entity,
    sets: &[(&'static str, Bind)],
    seasons: Option<&SeasonEdit>,
) -> anyhow::Result<()> {
    let mut tx = Tx::begin(db).await?;
    let added = save_rows(&mut Exec::Tx(&mut tx), e.row.id, sets, seasons).await?;
    tx.commit().await?;
    if let Some(fresh) = db.request_by_id(e.row.id).await? {
        if !sets.is_empty() {
            e.row.updated_at = fresh.updated_at;
        }
        e.row.seasons = fresh
            .seasons
            .into_iter()
            .filter(|s| added.contains(&s.id))
            .collect();
    }
    Ok(())
}

/// The statements of [`save`]; the ids of the added seasons.
async fn save_rows(
    exec: &mut Exec<'_>,
    request_id: i64,
    sets: &[(&'static str, Bind)],
    seasons: Option<&SeasonEdit>,
) -> anyhow::Result<Vec<i64>> {
    let mut added = Vec::new();
    if let Some(edit) = seasons {
        for number in &edit.add {
            let sid = exec
                .scalar(
                    &format!(
                        r#"INSERT INTO "season_request" ("seasonNumber", "status", "createdAt", "updatedAt", "requestId") VALUES (?1, ?2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?3){}"#,
                        super::draft::RETURNING_ID
                    ),
                    &[Bind::Int(*number), Bind::Int(PENDING), Bind::Int(request_id)],
                )
                .await?;
            added.push(sid);
        }
    }
    if !sets.is_empty() {
        let mut binds: Vec<Bind> = sets.iter().map(|(_, b)| b.clone()).collect();
        let assignments: Vec<String> = sets
            .iter()
            .enumerate()
            .map(|(i, (column, _))| format!(r#""{column}" = ?{}"#, i + 1))
            .collect();
        binds.push(Bind::Int(request_id));
        exec.execute(
            &format!(
                r#"UPDATE "media_request" SET {}, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?{}"#,
                assignments.join(", "),
                binds.len()
            ),
            &binds,
        )
        .await?;
    }
    if let Some(edit) = seasons {
        for sid in &edit.orphaned {
            exec.execute(
                r#"UPDATE "season_request" SET "requestId" = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?1"#,
                &[Bind::Int(*sid)],
            )
            .await?;
        }
    }
    Ok(added)
}

/// The loaded JSON after the handler's assignments and the save.
fn edited_json(
    mut out: Map<String, Value>,
    e: &Entity,
    body: &Body,
    tv: bool,
    seasons: Option<&SeasonEdit>,
) -> Value {
    let number = |n: Option<i64>| n.map_or(Value::Null, Value::from);
    out.insert(String::from("serverId"), number(body.server_id));
    out.insert(String::from("profileId"), number(body.profile_id));
    out.insert(
        String::from("rootFolder"),
        body.root_folder.as_deref().map_or(Value::Null, Value::from),
    );
    out.insert(
        String::from("tags"),
        body.tags.as_ref().map_or(Value::Null, |t| {
            Value::Array(t.iter().copied().map(Value::from).collect())
        }),
    );
    out.insert(
        String::from("updatedAt"),
        e.row.updated_at.as_deref().map_or(Value::Null, Value::from),
    );
    if tv {
        out.insert(
            String::from("languageProfileId"),
            number(body.language_profile_id),
        );
        if body.metadata_language_id != super::params::Assign::Keep {
            out.insert(
                String::from("metadataLanguageId"),
                number(body.metadata_language_id.value()),
            );
        }
        out.insert(String::from("ongoingEpisodeRequestKey"), Value::Null);
    }
    if let Some(edit) = seasons {
        out.insert(String::from("tvQuotaUnits"), Value::from(edit.units));
        let text = |v: &Option<String>| v.as_deref().map_or(Value::Null, Value::from);
        let mut list = match super::request::seasons_json(&edit.keep) {
            Value::Array(list) => list,
            Value::Null
            | Value::Bool(_)
            | Value::Number(_)
            | Value::String(_)
            | Value::Object(_) => Vec::new(),
        };
        for s in &e.row.seasons {
            let mut item = Map::new();
            item.insert(String::from("seasonNumber"), Value::from(s.season_number));
            item.insert(String::from("status"), Value::from(s.status));
            item.insert(String::from("id"), Value::from(s.id));
            item.insert(String::from("createdAt"), text(&s.created_at));
            item.insert(String::from("updatedAt"), text(&s.updated_at));
            list.push(Value::Object(item));
        }
        out.insert(String::from("seasons"), Value::Array(list));
    }
    Value::Object(out)
}

/// `DELETE /request/{id}`: the requester may withdraw a pending request;
/// request managers any. The media and its seasons fall back afterwards.
fn remove<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        forward_on_err!(ctx.no_query());
        let user = forward_on_err!(ctx.authenticated(0));
        let id = forward_on_err!(super::params::path_int(ctx, 0));
        let lc = lc(ctx);
        let e = match lc.load(id).await {
            Ok(Some(e)) => e,
            Ok(None) => return ctx.error(404, "Request not found."),
            Err(err) => return Outcome::forward(format!("loading request {id} failed: {err:#}")),
        };
        if !user.has_permission(MANAGE_REQUESTS) {
            match e.row.requested_by_id {
                Some(owner) if owner == user.id && e.row.status == PENDING => {}
                Some(_) => {
                    return ctx.error(401, "You do not have permission to delete this request.");
                }
                None => return ctx.error(404, "Request not found."),
            }
        }
        if e.media.is_none() {
            return ctx.error(404, "Request not found.");
        }
        // `remove` runs the subscriber's `afterRemove` in its transaction:
        // when the media can't be updated, the request stays.
        if let Err(err) = remove_with_hook(&ctx.state.db, &e).await {
            tracing::error!("Something went wrong deleting a request: {err:#}");
            return ctx.error(404, "Request not found.");
        }
        Ready::no_content()
    })
}

/// The request's delete and `afterRemove`'s writes, in one transaction.
async fn remove_with_hook(db: &Db, e: &Entity) -> anyhow::Result<()> {
    let hook = crate::lifecycle::after_remove(db, e, &[e.row.id]).await?;
    let mut tx = Tx::begin(db).await?;
    tx.execute(
        r#"DELETE FROM "media_request" WHERE "id" = ?1"#,
        &[Bind::Int(e.row.id)],
    )
    .await?;
    for (sql, binds) in &hook {
        tx.execute(sql, binds).await?;
    }
    tx.commit().await
}

#[cfg(test)]
mod tests {
    use super::*;

    use anyhow::Context;

    use crate::dbtx::scratch::{self, ints, PENDING_SEASON_ONE};

    #[test]
    fn tags_transformer() {
        assert_eq!(tags_column(&[]), "none", "empty list");
        assert_eq!(tags_column(&[1, 2]), "1,2", "joined");
    }

    async fn entity(db: &Db) -> anyhow::Result<Entity> {
        Ok(Entity {
            row: db.request_by_id(1).await?.context("request 1")?,
            media: None,
            requested_by: None,
            modified_by: None,
        })
    }

    #[tokio::test]
    async fn a_failed_parent_update_keeps_no_added_season() -> anyhow::Result<()> {
        let scratch = scratch::sqlite("requestedit-save").await?;
        let db = &scratch.db;
        scratch::run(db, &PENDING_SEASON_ONE).await?;
        scratch::run(
            db,
            &[r#"CREATE TRIGGER "refuse_parent" BEFORE UPDATE ON "media_request" BEGIN SELECT RAISE(ABORT, 'parent update refused'); END"#],
        )
        .await?;
        // Season 1 becomes seasons 1 and 2.
        let mut e = entity(db).await?;
        let edit = SeasonEdit {
            keep: e.row.seasons.clone(),
            add: vec![2],
            orphaned: Vec::new(),
            units: 2,
        };
        let sets = [("tvQuotaUnits", Bind::Int(2))];
        assert!(
            save(db, &mut e, &sets, Some(&edit)).await.is_err(),
            "the parent update fails"
        );
        let seasons = r#"SELECT "seasonNumber" FROM "season_request" WHERE "requestId" = 1 ORDER BY "seasonNumber""#;
        assert_eq!(ints(db, seasons).await?, [1], "season 2 rolled back");
        let units = r#"SELECT "tvQuotaUnits" FROM "media_request" WHERE "id" = 1"#;
        assert_eq!(ints(db, units).await?, [1], "the row as it was");

        scratch::run(db, &[r#"DROP TRIGGER "refuse_parent""#]).await?;
        save(db, &mut e, &sets, Some(&edit)).await?;
        assert_eq!(ints(db, seasons).await?, [1, 2], "saved together");
        assert_eq!(ints(db, units).await?, [2], "two units");
        assert_eq!(
            e.row
                .seasons
                .iter()
                .map(|s| s.season_number)
                .collect::<Vec<_>>(),
            [2],
            "the added season read back"
        );
        Ok(())
    }

    #[tokio::test]
    async fn a_failed_after_remove_keeps_the_request() -> anyhow::Result<()> {
        let scratch = scratch::sqlite("requestedit-remove").await?;
        let db = &scratch.db;
        scratch::run(db, &PENDING_SEASON_ONE).await?;
        scratch::run(
            db,
            &[r#"CREATE TRIGGER "refuse_media" BEFORE UPDATE ON "media" BEGIN SELECT RAISE(ABORT, 'media update refused'); END"#],
        )
        .await?;
        let e = entity(db).await?;
        assert!(
            remove_with_hook(db, &e).await.is_err(),
            "the media update fails"
        );
        let requests = r#"SELECT "id" FROM "media_request""#;
        assert_eq!(ints(db, requests).await?, [1], "the delete rolled back");

        scratch::run(db, &[r#"DROP TRIGGER "refuse_media""#]).await?;
        remove_with_hook(db, &e).await?;
        assert!(ints(db, requests).await?.is_empty(), "deleted");
        let status = r#"SELECT "status" FROM "media" WHERE "id" = 1"#;
        assert_eq!(ints(db, status).await?, [1], "the media fell back");
        let season = r#"SELECT "status" FROM "season" WHERE "mediaId" = 1"#;
        assert_eq!(ints(db, season).await?, [1], "and its season");
        Ok(())
    }
}
