//! Watchlist and blocklist writes.
//!
//! `POST /watchlist`, `DELETE /watchlist/{tmdbId}`, `POST /blocklist`,
//! `GET /blocklist/{tmdbId}`, `POST` and `DELETE
//! /blocklist/collection/{id}`, and the deprecated `/blacklist` aliases
//! (`server/routes/watchlist.ts`, `blocklist.ts`,
//! `Watchlist.createWatchlist`, `Blocklist.addToBlocklist`).

use std::future::Future;
use std::pin::Pin;

use axum::body::Body;
use axum::http::{HeaderValue, Method, Response, StatusCode};
use serde_json::{Map, Value};

use super::draft::{
    body_object, current_user, fail_on_err, forward_on_err, inserted_media_json, known_keys,
    media_type, media_type_query, not_found, opt_text, user_json, Draft, RETURNING_ID,
};
use super::{Outcome, Ready, Table};
use crate::db::{Bind, MediaRow};

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// `Permission.MANAGE_BLOCKLIST`.
const MANAGE_BLOCKLIST: i64 = 268_435_456;
/// `MediaStatus.BLOCKLISTED` and `UNKNOWN`.
const BLOCKLISTED: i64 = 6;
const UNKNOWN: i64 = 1;

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/watchlist", Method::POST, watchlist_add),
    ("/api/v1/watchlist/{id}", Method::DELETE, watchlist_delete),
    ("/api/v1/blocklist", Method::POST, blocklist_add),
    (
        "/api/v1/blocklist/collection/{id}",
        Method::POST,
        collection_add,
    ),
    (
        "/api/v1/blocklist/collection/{id}",
        Method::DELETE,
        collection_remove,
    ),
    ("/api/v1/blacklist", Method::GET, blacklist_list),
    ("/api/v1/blacklist", Method::POST, blacklist_add),
    ("/api/v1/blacklist/{id}", Method::GET, blacklist_get),
    ("/api/v1/blacklist/{id}", Method::DELETE, blacklist_delete),
];

/// `settings.main.locale`, or `en`.
pub(super) fn main_locale(ctx: &Ready<'_>) -> String {
    let locale = ctx.settings.str("/main/locale");
    if locale.is_empty() {
        String::from("en")
    } else {
        locale.to_owned()
    }
}

/// `res.status(201).send()`.
fn created_empty() -> Outcome {
    let mut res = Response::new(Body::empty());
    *res.status_mut() = StatusCode::CREATED;
    Outcome::Done(res)
}

/// A new `media` row as the entity's save inserts it.
pub(super) async fn insert_media(
    ctx: &Ready<'_>,
    media_type: &str,
    ids: (i64, Option<i64>),
    status: (i64, i64),
) -> anyhow::Result<i64> {
    let mut exec = crate::dbtx::Exec::Db(&ctx.state.db);
    insert_media_in(&mut exec, media_type, ids, status).await
}

/// [`insert_media`] on the pool or inside a transaction.
pub(super) async fn insert_media_in(
    exec: &mut crate::dbtx::Exec<'_>,
    media_type: &str,
    ids: (i64, Option<i64>),
    status: (i64, i64),
) -> anyhow::Result<i64> {
    exec.scalar(
            &format!(
                r#"INSERT INTO "media" ("mediaType", "tmdbId", "tvdbId", "status", "status4k", "createdAt", "updatedAt", "lastSeasonChange", "mediaAddedAt") VALUES (?1, ?2, ?3, ?4, ?5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP){RETURNING_ID}"#
            ),
            &[
                Bind::Text(media_type.to_owned()),
                Bind::Int(ids.0),
                Bind::OptInt(ids.1),
                Bind::Int(status.0),
                Bind::Int(status.1),
            ],
        )
        .await
}

/// Whether another media row already holds this (unique) TVDB id.
pub(super) async fn tvdb_taken(ctx: &Ready<'_>, tvdb_id: Option<i64>) -> Result<bool, String> {
    let Some(tvdb_id) = tvdb_id else {
        return Ok(false);
    };
    ctx.state
        .db
        .scalar(
            r#"SELECT COUNT(*) FROM "media" WHERE "tvdbId" = ?1"#,
            &[Bind::Int(tvdb_id)],
        )
        .await
        .map(|n| n > 0)
        .map_err(|e| format!("database: {e:#}"))
}

/// `mediaRepository.findOne({ where: { tmdbId, mediaType } })`.
async fn media_by_tmdb(
    ctx: &Ready<'_>,
    tmdb_id: i64,
    media_type: &str,
) -> Result<Option<MediaRow>, String> {
    ctx.state
        .db
        .media_by_tmdb(tmdb_id, media_type)
        .await
        .map_err(|e| format!("database: {e:#}"))
}

/// One media row by id, with seasons.
pub(super) async fn media_row(ctx: &Ready<'_>, id: i64) -> Result<MediaRow, String> {
    ctx.state
        .db
        .media_by_ids(&[id], true)
        .await
        .map_err(|e| format!("database: {e:#}"))?
        .pop()
        .ok_or_else(|| String::from("the media row vanished"))
}

/// The message for a watchlist body without a `tmdbId` and/or with a
/// `mediaType` that isn't `movie` or `tv`.
fn watchlist_body_message(no_tmdb_id: bool, bad_media_type: bool) -> String {
    let mut issues = Vec::new();
    if no_tmdb_id {
        issues.push("tmdbId must be a number");
    }
    if bad_media_type {
        issues.push("mediaType must be movie or tv");
    }
    format!("Invalid watchlist item: {}.", issues.join("; "))
}

/// `POST /watchlist`: `Watchlist.createWatchlist`.
fn watchlist_add<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        forward_on_err!(ctx.no_query());
        let user = forward_on_err!(ctx.authenticated(0));
        let body = forward_on_err!(body_object(ctx));
        // zod's object strips keys it doesn't know.
        let rating_key = forward_on_err!(opt_text(body, "ratingKey"));
        let tmdb_id = forward_on_err!(super::params::body_int(body, "tmdbId"));
        let kind = media_type(body.get("mediaType")).ok();
        let (Some(tmdb_id), Some(kind)) = (tmdb_id, kind) else {
            return ctx.error(
                500,
                &watchlist_body_message(tmdb_id.is_none(), kind.is_none()),
            );
        };
        let title = forward_on_err!(opt_text(body, "title"));
        let locale = main_locale(ctx);
        let details = if kind == "movie" {
            ctx.state.tmdb.movie(tmdb_id, &locale).await
        } else {
            ctx.state.tmdb.tv(tmdb_id, &locale).await
        };
        let details = forward_on_err!(details.map_err(|e| format!("TMDB failed: {e:#}")));
        let viewer = forward_on_err!(current_user(ctx, user.id).await);
        let db = &ctx.state.db;
        let duplicate = forward_on_err!(db
            .watchlist_exists(tmdb_id, kind, Some(user.id))
            .await
            .map_err(|e| format!("database: {e:#}")));
        if duplicate {
            tracing::warn!("Duplicate request for watchlist blocked");
            return ctx.error(409, "");
        }
        let existing = forward_on_err!(media_by_tmdb(ctx, tmdb_id, kind).await);
        let tvdb = details
            .pointer("/external_ids/tvdb_id")
            .and_then(Value::as_i64);
        if existing.is_none() && forward_on_err!(tvdb_taken(ctx, tvdb).await) {
            tracing::warn!("Something wrong with data watchlist");
            return ctx.error(409, "Something wrong");
        }
        let downloads = existing
            .as_ref()
            .map_or_else(crate::downloads::Downloads::default, |m| {
                super::draft::downloads_for(&[m])
            });
        let media_json = existing.as_ref().map_or(Value::Null, |m| {
            crate::media::media_json(m, &ctx.settings, &downloads, true)
        });
        let media_id = if let Some(m) = &existing {
            m.id
        } else {
            let found = details.get("id").and_then(Value::as_i64).unwrap_or(tmdb_id);
            match insert_media(ctx, kind, (found, tvdb), (UNKNOWN, UNKNOWN)).await {
                Ok(id) => id,
                // A `QueryFailedError` in Node: its 409.
                Err(e) => {
                    tracing::error!(
                        "Something wrong with data watchlist: inserting media failed: {e:#}"
                    );
                    return ctx.error(409, "Something wrong");
                }
            }
        };
        let inserted = db
            .scalar(
                &format!(
                    r#"INSERT INTO "watchlist" ("ratingKey", "mediaType", "title", "tmdbId", "createdAt", "updatedAt", "requestedById", "mediaId") VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?5, ?6){RETURNING_ID}"#
                ),
                &[
                    Bind::Text(rating_key.clone().unwrap_or_default()),
                    Bind::Text(kind.to_owned()),
                    Bind::Text(title.clone().unwrap_or_default()),
                    Bind::Int(tmdb_id),
                    Bind::Int(user.id),
                    Bind::Int(media_id),
                ],
            )
            .await;
        let id = match inserted {
            Ok(id) => id,
            Err(e) => {
                tracing::warn!("Something wrong with data watchlist: {e:#}");
                return ctx.error(409, "Something wrong");
            }
        };
        let media_json = if existing.is_some() {
            media_json
        } else {
            let row = fail_on_err!(ctx, media_row(ctx, media_id).await);
            inserted_media_json(&row, &ctx.settings, &["tmdbId", "tvdbId", "mediaType"])
        };
        let stored = fail_on_err!(ctx, db
            .rows(
                &format!(
                    r#"SELECT {} AS "createdAt", {} AS "updatedAt" FROM "watchlist" WHERE "id" = ?1"#,
                    db.iso_sql(r#""createdAt""#),
                    db.iso_sql(r#""updatedAt""#)
                ),
                &[Bind::Int(id)],
            )
            .await
            .map_err(|e| format!("database: {e:#}")))
        .pop()
        .unwrap_or_default();
        let mut draft = Draft::default();
        draft.put(
            "ratingKey",
            Value::from(rating_key.as_deref().unwrap_or("")),
        );
        draft.put("title", Value::from(title.as_deref().unwrap_or("")));
        draft.put("tmdbId", Value::from(tmdb_id));
        draft.put("mediaType", Value::from(kind));
        draft.put("requestedBy", fail_on_err!(ctx, user_json(&viewer)));
        draft.put("media", media_json);
        draft.put("id", Value::from(id));
        for key in ["createdAt", "updatedAt"] {
            draft.put(key, stored.get(key).cloned().unwrap_or(Value::Null));
        }
        ctx.json_with(201, &draft.json())
    })
}

/// `DELETE /watchlist/{tmdbId}?mediaType=`: the user's own entry.
fn watchlist_delete<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user = forward_on_err!(ctx.authenticated(0));
        let kind = forward_on_err!(media_type_query(ctx));
        let tmdb_id = forward_on_err!(super::params::path_int(ctx, 0));
        let removed = fail_on_err!(ctx, ctx
            .state
            .db
            .execute(
                r#"DELETE FROM "watchlist" WHERE "id" = (SELECT "id" FROM "watchlist" WHERE "tmdbId" = ?1 AND "mediaType" = ?2 AND "requestedById" = ?3 ORDER BY "id" LIMIT 1)"#,
                &[Bind::Int(tmdb_id), Bind::Text(kind.to_owned()), Bind::Int(user.id)],
            )
            .await
            .map_err(|e| format!("database: {e:#}")));
        if removed == 0 {
            return ctx.error(404, "not Found");
        }
        Ready::no_content()
    })
}

/// The `blocklistAdd` body, as the spec and zod let it through.
struct BlocklistBody {
    tmdb_id: i64,
    media_type: &'static str,
    title: Option<String>,
    user: i64,
    tags: Option<String>,
}

fn blocklist_body(ctx: &Ready<'_>) -> Result<BlocklistBody, super::Fallback> {
    use super::params::body_int;
    let body = body_object(ctx)?;
    known_keys(
        body,
        &["tmdbId", "mediaType", "title", "user", "blocklistedTags"],
    )?;
    Ok(BlocklistBody {
        tmdb_id: body_int(body, "tmdbId")?
            .ok_or_else(|| super::Fallback::status(400, "tmdbId is required."))?,
        media_type: media_type(body.get("mediaType"))?,
        title: opt_text(body, "title")?,
        user: body_int(body, "user")?
            .ok_or_else(|| super::Fallback::status(400, "user is required."))?,
        tags: opt_text(body, "blocklistedTags")?,
    })
}

/// Point a blocklist entry at its media row, which becomes (or is
/// created) `BLOCKLISTED` in both qualities.
async fn blocklist_media(
    db: &mut crate::dbtx::Exec<'_>,
    entry: i64,
    media: Option<&MediaRow>,
    media_type: &str,
    tmdb_id: i64,
) -> anyhow::Result<()> {
    let media_id = match media {
        None => {
            insert_media_in(db, media_type, (tmdb_id, None), (BLOCKLISTED, BLOCKLISTED)).await?
        }
        Some(m) => {
            if m.status != BLOCKLISTED || m.status4k != BLOCKLISTED {
                db.execute(
                    r#"UPDATE "media" SET "status" = ?1, "status4k" = ?1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?2"#,
                    &[Bind::Int(BLOCKLISTED), Bind::Int(m.id)],
                )
                .await?;
            }
            m.id
        }
    };
    db.execute(
        r#"UPDATE "blocklist" SET "mediaId" = ?1 WHERE "id" = ?2"#,
        &[Bind::Int(media_id), Bind::Int(entry)],
    )
    .await?;
    Ok(())
}

async fn blocklist_entry_exists(ctx: &Ready<'_>, tmdb_id: i64, kind: &str) -> Result<bool, String> {
    ctx.state
        .db
        .scalar(
            r#"SELECT COUNT(*) FROM "blocklist" WHERE "tmdbId" = ?1 AND "mediaType" = ?2"#,
            &[Bind::Int(tmdb_id), Bind::Text(kind.to_owned())],
        )
        .await
        .map(|n| n > 0)
        .map_err(|e| format!("database: {e:#}"))
}

/// `POST /blocklist`: `Blocklist.addToBlocklist`. A second entry for the
/// same title fails the unique index, which Node answers with 409.
fn blocklist_add<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        forward_on_err!(ctx.no_query());
        forward_on_err!(ctx.authenticated(MANAGE_BLOCKLIST));
        let body = forward_on_err!(blocklist_body(ctx));
        let db = &ctx.state.db;
        let known_user = forward_on_err!(db
            .user_record(body.user)
            .await
            .map_err(|e| format!("database: {e:#}")));
        let Some(user_id) = known_user.as_ref().map(|(u, _)| u.id) else {
            // The insert breaks the foreign key: a `QueryFailedError` whose
            // errno (787) isn't 19, which the catch answers 409.
            tracing::warn!("Something wrong with data blocklist");
            return ctx.error(409, "Something wrong");
        };
        let media = forward_on_err!(media_by_tmdb(ctx, body.tmdb_id, body.media_type).await);
        if forward_on_err!(blocklist_entry_exists(ctx, body.tmdb_id, body.media_type).await) {
            tracing::warn!("Something wrong with data blocklist");
            return ctx.error(409, "Something wrong");
        }
        // The entry and its media row commit together, so a failed media save
        // never leaves an orphaned blocklist entry behind.
        let mut tx = match crate::jobs::syncutil::Tx::begin(db).await {
            Ok(tx) => tx,
            Err(e) => return Outcome::forward(format!("database: {e:#}")),
        };
        let entry = crate::dbtx::Exec::Tx(&mut tx)
            .scalar(
                &format!(
                    r#"INSERT INTO "blocklist" ("mediaType", "title", "tmdbId", "blocklistedTags", "createdAt", "userId") VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP, ?5){RETURNING_ID}"#
                ),
                &[
                    Bind::Text(body.media_type.to_owned()),
                    Bind::OptText(body.title.clone()),
                    Bind::Int(body.tmdb_id),
                    Bind::OptText(body.tags.clone()),
                    Bind::Int(user_id),
                ],
            )
            .await;
        let entry = match entry {
            Ok(id) => id,
            Err(e) => {
                tracing::warn!("Something wrong with data blocklist: {e:#}");
                return ctx.error(409, "Something wrong");
            }
        };
        let mut exec = crate::dbtx::Exec::Tx(&mut tx);
        if let Err(e) = blocklist_media(
            &mut exec,
            entry,
            media.as_ref(),
            body.media_type,
            body.tmdb_id,
        )
        .await
        {
            tracing::error!("blocklisting the media failed: {e:#}");
            return ctx.error(500, &format!("{e:#}"));
        }
        if let Err(e) = tx.commit().await {
            tracing::error!("blocklisting the media failed: {e:#}");
            return ctx.error(500, &format!("{e:#}"));
        }
        created_empty()
    })
}

/// The collection's parts: the first position of each id with its last
/// value, as `new Map(parts.map((p) => [p.id, p]))` keeps them.
fn unique_parts(collection: &Value) -> Result<Vec<(i64, Option<String>)>, String> {
    let parts = collection
        .get("parts")
        .and_then(Value::as_array)
        .ok_or_else(|| String::from("the collection has no parts"))?;
    let mut out: Vec<(i64, Option<String>)> = Vec::new();
    for part in parts {
        let id = part
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| String::from("a part without a whole id"))?;
        let title = match part.get("title") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.clone()),
            Some(_) => return Err(String::from("a part title that isn't text")),
        };
        if let Some(slot) = out.iter_mut().find(|(i, _)| *i == id) {
            slot.1 = title;
        } else {
            out.push((id, title));
        }
    }
    Ok(out)
}

/// The collection from TMDB in the user's language.
async fn collection(ctx: &Ready<'_>, locale: Option<&str>) -> Result<Value, super::Fallback> {
    let id = ctx.path_id(0)?;
    let (_, language) = super::movie::languages(ctx, locale, None);
    ctx.state
        .tmdb
        .collection(id, &language)
        .await
        .map_err(|e| format!("TMDB collection {id} failed: {e:#}").into())
}

/// `POST /blocklist/collection/{id}`: every part not yet blocklisted gets
/// an entry by the signed-in user and a `BLOCKLISTED` media row.
fn collection_add<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        forward_on_err!(ctx.no_query());
        let user = forward_on_err!(ctx.authenticated(MANAGE_BLOCKLIST));
        forward_on_err!(body_object(ctx));
        let collection = forward_on_err!(collection(ctx, user.locale.as_deref()).await);
        let parts = forward_on_err!(unique_parts(&collection));
        let db = &ctx.state.db;
        // `dataSource.transaction(...)` around the saves.
        let mut tx = match crate::jobs::syncutil::Tx::begin(db).await {
            Ok(tx) => tx,
            Err(e) => return Outcome::forward(format!("database: {e:#}")),
        };
        let mut fresh: Vec<(i64, i64, Option<MediaRow>)> = Vec::new();
        for (tmdb_id, title) in &parts {
            let exists = blocklist_entry_exists(ctx, *tmdb_id, "movie").await;
            let exists = if fresh.is_empty() {
                forward_on_err!(exists)
            } else {
                fail_on_err!(ctx, exists)
            };
            if exists {
                continue;
            }
            let media = db
                .media_by_tmdb(*tmdb_id, "movie")
                .await
                .map_err(|e| format!("database: {e:#}"));
            let media = if fresh.is_empty() {
                forward_on_err!(media)
            } else {
                fail_on_err!(ctx, media)
            };
            let entry = crate::dbtx::Exec::Tx(&mut tx)
                .scalar(
                    &format!(
                        r#"INSERT INTO "blocklist" ("mediaType", "title", "tmdbId", "createdAt", "userId") VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP, ?4){RETURNING_ID}"#
                    ),
                    &[
                        Bind::Text(String::from("movie")),
                        Bind::OptText(title.clone()),
                        Bind::Int(*tmdb_id),
                        Bind::Int(user.id),
                    ],
                )
                .await;
            match entry {
                Ok(entry) => fresh.push((*tmdb_id, entry, media)),
                Err(e) => {
                    tracing::error!("Error blocklisting collection: {e:#}");
                    return ctx.error(500, &format!("{e:#}"));
                }
            }
        }
        for (tmdb_id, entry, media) in &fresh {
            let mut exec = crate::dbtx::Exec::Tx(&mut tx);
            if let Err(e) =
                blocklist_media(&mut exec, *entry, media.as_ref(), "movie", *tmdb_id).await
            {
                tracing::error!("Error blocklisting collection: {e:#}");
                return ctx.error(500, &format!("{e:#}"));
            }
        }
        if let Err(e) = tx.commit().await {
            tracing::error!("Error blocklisting collection: {e:#}");
            return ctx.error(500, &format!("{e:#}"));
        }
        created_empty()
    })
}

/// `DELETE /blocklist/collection/{id}`: each blocklisted part loses its
/// entry and its media row.
fn collection_remove<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        forward_on_err!(ctx.no_query());
        let user = forward_on_err!(ctx.authenticated(MANAGE_BLOCKLIST));
        let collection = forward_on_err!(collection(ctx, user.locale.as_deref()).await);
        let Some(parts) = collection.get("parts").and_then(Value::as_array) else {
            return Outcome::forward(String::from("the collection has no parts"));
        };
        let mut ids = Vec::with_capacity(parts.len());
        for part in parts {
            match part.get("id").and_then(Value::as_i64) {
                Some(id) => ids.push(id),
                None => return Outcome::forward(String::from("a part without a whole id")),
            }
        }
        let mut tx = match crate::jobs::syncutil::Tx::begin(&ctx.state.db).await {
            Ok(tx) => tx,
            Err(e) => return Outcome::forward(format!("database: {e:#}")),
        };
        let db = &mut tx;
        for tmdb_id in ids {
            let binds = [Bind::Int(tmdb_id), Bind::Text(String::from("movie"))];
            let removed = db
                .execute(
                    r#"DELETE FROM "blocklist" WHERE "id" = (SELECT "id" FROM "blocklist" WHERE "tmdbId" = ?1 AND "mediaType" = ?2 ORDER BY "id" LIMIT 1)"#,
                    &binds,
                )
                .await;
            let result = match removed {
                Ok(0) => Ok(0),
                Ok(_) => db
                    .execute(
                        r#"DELETE FROM "media" WHERE "id" = (SELECT "id" FROM "media" WHERE "tmdbId" = ?1 AND "mediaType" = ?2 ORDER BY "id" LIMIT 1)"#,
                        &binds,
                    )
                    .await,
                Err(e) => Err(e),
            };
            if let Err(e) = result {
                tracing::error!("Error unblocklisting collection: {e:#}");
                return ctx.error(500, &format!("{e:#}"));
            }
        }
        if let Err(e) = tx.commit().await {
            tracing::error!("Error unblocklisting collection: {e:#}");
            return ctx.error(500, &format!("{e:#}"));
        }
        Ready::no_content()
    })
}

/// `GET /blocklist/{tmdbId}?mediaType=`: the entry with its user (and the
/// user's settings, both eager).
pub(super) fn blocklist_get<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        forward_on_err!(ctx.authenticated(MANAGE_BLOCKLIST));
        let kind = forward_on_err!(media_type_query(ctx));
        let key = forward_on_err!(super::draft::tmdb_path_key(ctx));
        let db = &ctx.state.db;
        let rows = forward_on_err!(db
            .rows(
                &format!(
                    r#"SELECT CAST("id" AS BIGINT) AS "id", "mediaType", "title", CAST("tmdbId" AS BIGINT) AS "tmdbId", "blocklistedTags", {} AS "createdAt", CAST("userId" AS BIGINT) AS "userId" FROM "blocklist" WHERE "tmdbId" = ?1 AND "mediaType" = ?2 ORDER BY "id" LIMIT 1"#,
                    db.iso_sql(r#""createdAt""#)
                ),
                &[key, Bind::Text(kind.to_owned())],
            )
            .await
            .map_err(|e| format!("database: {e:#}")));
        let Some(mut row) = rows.into_iter().next() else {
            return ctx.error(404, &not_found("Blocklist"));
        };
        let user = match row.shift_remove("userId").and_then(|v| v.as_i64()) {
            Some(uid) => match db.user_record(uid).await {
                Ok(Some(rel)) => forward_on_err!(user_json(&rel)),
                Ok(None) => Value::Null,
                Err(e) => return Outcome::forward(format!("database: {e:#}")),
            },
            None => Value::Null,
        };
        let mut out = Map::new();
        for key in [
            "id",
            "mediaType",
            "title",
            "tmdbId",
            "blocklistedTags",
            "createdAt",
        ] {
            out.insert(key.to_owned(), row.get(key).cloned().unwrap_or(Value::Null));
        }
        out.insert(String::from("user"), user);
        ctx.json(&Value::Object(out))
    })
}

/// The headers `deprecatedRoute` adds to every `/blacklist` answer.
fn deprecated(outcome: Outcome) -> Outcome {
    match outcome {
        Outcome::Done(mut res) => {
            let headers = res.headers_mut();
            headers.insert("deprecation", HeaderValue::from_static("true"));
            headers.insert(
                "link",
                HeaderValue::from_static("</api/v1/blocklist>; rel=\"successor-version\""),
            );
            headers.insert(
                "sunset",
                HeaderValue::from_static("Mon, 01 Jun 2026 00:00:00 GMT"),
            );
            Outcome::Done(res)
        }
        forward @ Outcome::Forward(_) => forward,
    }
}

/// `GET /blacklist`.
fn blacklist_list<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move { deprecated(super::blocklist::list(ctx).await) })
}

/// `POST /blacklist`.
fn blacklist_add<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move { deprecated(blocklist_add(ctx).await) })
}

/// `GET /blacklist/{tmdbId}`.
fn blacklist_get<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move { deprecated(blocklist_get(ctx).await) })
}

/// `DELETE /blacklist/{tmdbId}`.
fn blacklist_delete<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move { deprecated(super::writes::blocklist_delete(ctx).await) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parts_dedupe_like_a_map() {
        let collection = json!({"parts": [
            {"id": 1, "title": "A"}, {"id": 2, "title": "B"}, {"id": 1, "title": "A2"}
        ]});
        assert_eq!(
            unique_parts(&collection).ok(),
            Some(vec![
                (1, Some(String::from("A2"))),
                (2, Some(String::from("B")))
            ]),
            "first position, last value"
        );
        assert!(
            unique_parts(&json!({"parts": [{"id": "x"}]})).is_err(),
            "odd ids are refused"
        );
    }
}
