//! Issue writes: `POST /issue`, `POST /issue/{id}/comment`, `POST
//! /issue/{id}/{open|resolved}` and `DELETE /issue/{id}`.
//!
//! The saves run `IssueSubscriber` (`ISSUE_CREATED`, `ISSUE_RESOLVED`,
//! `ISSUE_REOPENED`) and `IssueCommentSubscriber` (`ISSUE_COMMENT`).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use axum::http::Method;
use serde_json::{Map, Value};

use super::draft::{
    body_object, current_user, downloads_for, fail_on_err, forward_on_err, known_keys, opt_text,
    user_json, Draft, RETURNING_ID,
};
use super::{Outcome, Ready, Table};
use crate::db::{Bind, IssueRow, MediaRow};
use crate::lifecycle::UserRel;
use crate::media::js_string;
use crate::notify::{self, issue_type_name, CommentInfo, IssueInfo, Kind, Payload, Person};
use crate::settings::Settings;
use crate::state::AppState;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// `MANAGE_ISSUES` and `CREATE_ISSUES`.
const MANAGE_ISSUES: i64 = 1_048_576;
const CREATE_ISSUES: i64 = 4_194_304;
/// `IssueStatus`.
const OPEN: i64 = 1;
const RESOLVED: i64 = 2;
/// `IssueType.OTHER`.
const OTHER: i64 = 4;

/// This module's routes. `/issue/{id}/comment` shares the pattern of the
/// status route, as in Node, where it is declared first.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/issue", Method::POST, create),
    ("/api/v1/issue/{id}/{action}", Method::POST, action),
    ("/api/v1/issue/{id}", Method::DELETE, remove),
];

/// An issue with every eager relation, as `findOneOrFail` loads it.
struct Loaded {
    row: IssueRow,
    media: Option<MediaRow>,
    created_by: Option<UserRel>,
    modified_by: Option<UserRel>,
    /// Comment users by comment, in comment order.
    comment_users: Vec<Option<UserRel>>,
}

async fn user_of(ctx: &Ready<'_>, id: Option<i64>) -> Result<Option<UserRel>, String> {
    match id {
        Some(id) => ctx
            .state
            .db
            .user_record(id)
            .await
            .map_err(|e| format!("database: {e:#}")),
        None => Ok(None),
    }
}

async fn load(ctx: &Ready<'_>, id: i64) -> Result<Option<Loaded>, String> {
    let db = &ctx.state.db;
    let Some(row) = db
        .issue_by_id(id)
        .await
        .map_err(|e| format!("database: {e:#}"))?
    else {
        return Ok(None);
    };
    let media = match row.media_id {
        Some(mid) => db
            .media_by_ids(&[mid], true)
            .await
            .map_err(|e| format!("database: {e:#}"))?
            .pop(),
        None => None,
    };
    let created_by = user_of(ctx, row.created_by_id).await?;
    let modified_by = user_of(ctx, row.modified_by_id).await?;
    let mut comment_users = Vec::with_capacity(row.comments.len());
    for comment in &row.comments {
        comment_users.push(user_of(ctx, comment.user_id).await?);
    }
    Ok(Some(Loaded {
        row,
        media,
        created_by,
        modified_by,
        comment_users,
    }))
}

fn rel_json(rel: Option<&UserRel>) -> Result<Value, String> {
    rel.map_or(Ok(Value::Null), user_json)
}

/// The loaded issue as `res.json` prints it.
async fn loaded_json(ctx: &Ready<'_>, l: &Loaded) -> Result<Map<String, Value>, String> {
    let media: Vec<&MediaRow> = l.media.iter().collect();
    let downloads = downloads_for(ctx, &media).await?;
    let mut out = Map::new();
    super::issue::columns(&mut out, &l.row);
    out.insert(
        String::from("media"),
        l.media.as_ref().map_or(Value::Null, |m| {
            crate::media::media_json(m, &ctx.settings, &downloads, true)
        }),
    );
    out.insert(String::from("createdBy"), rel_json(l.created_by.as_ref())?);
    out.insert(
        String::from("modifiedBy"),
        rel_json(l.modified_by.as_ref())?,
    );
    let mut comments = Vec::with_capacity(l.row.comments.len());
    for (comment, user) in l.row.comments.iter().zip(&l.comment_users) {
        comments.push(super::issue::comment_json(
            comment,
            Some(rel_json(user.as_ref())?),
        ));
    }
    out.insert(String::from("comments"), Value::Array(comments));
    Ok(out)
}

/// The issue's own body fields as the spec and handler read them.
struct NewIssue {
    issue_type: i64,
    message: String,
    media_id: i64,
    user_id: Option<i64>,
    problem_season: Option<i64>,
    problem_episode: Option<i64>,
}

fn new_issue(ctx: &Ready<'_>) -> Result<NewIssue, super::Fallback> {
    use super::params::body_int;
    let body = body_object(ctx)?;
    known_keys(
        body,
        &[
            "issueType",
            "message",
            "mediaId",
            "userId",
            "problemSeason",
            "problemEpisode",
        ],
    )?;
    let user_id = match body.get("userId") {
        None | Some(Value::Null) => None,
        Some(_) => body_int(body, "userId")?,
    };
    let required = |key: &str| super::Fallback::status(400, format!("{key} is required."));
    Ok(NewIssue {
        issue_type: body_int(body, "issueType")?.ok_or_else(|| required("issueType"))?,
        message: opt_text(body, "message")?.ok_or_else(|| required("message"))?,
        media_id: body_int(body, "mediaId")?.ok_or_else(|| required("mediaId"))?,
        user_id,
        problem_season: body_int(body, "problemSeason")?,
        problem_episode: body_int(body, "problemEpisode")?,
    })
}

/// `POST /issue`: the issue with its first comment.
fn create<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        forward_on_err!(ctx.no_query());
        let user = forward_on_err!(ctx.authenticated(MANAGE_ISSUES | CREATE_ISSUES));
        let body = forward_on_err!(new_issue(ctx));
        let viewer = forward_on_err!(current_user(ctx, user.id).await);
        let db = &ctx.state.db;
        let media = forward_on_err!(db
            .media_by_ids(&[body.media_id], true)
            .await
            .map_err(|e| format!("database: {e:#}")))
        .pop();
        let Some(media) = media else {
            return ctx.error(404, "Media does not exist.");
        };
        let mut created_by = viewer;
        if let Some(uid) = body.user_id.filter(|uid| *uid != user.id) {
            if !user.has_permission(MANAGE_ISSUES) {
                return ctx.error(
                    403,
                    "You do not have permission to create an issue on behalf of another user.",
                );
            }
            match forward_on_err!(user_of(ctx, Some(uid)).await) {
                Some(rel) => created_by = rel,
                None => return ctx.error(404, "Issue user not found"),
            }
        }
        let downloads = forward_on_err!(downloads_for(ctx, &[&media]).await);
        let creator_json = forward_on_err!(user_json(&created_by));
        let media_json = crate::media::media_json(&media, &ctx.settings, &downloads, true);
        // The cascaded `save` runs in one transaction.
        let mut tx = match crate::jobs::syncutil::Tx::begin(db).await {
            Ok(tx) => tx,
            Err(e) => return Outcome::forward(format!("database: {e:#}")),
        };
        let issue_id = crate::dbtx::Exec::Tx(&mut tx)
            .scalar(
                &format!(
                    r#"INSERT INTO "issue" ("issueType", "status", "problemSeason", "problemEpisode", "createdAt", "updatedAt", "mediaId", "createdById") VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?5, ?6){RETURNING_ID}"#
                ),
                &[
                    Bind::Int(body.issue_type),
                    Bind::Int(OPEN),
                    Bind::Int(body.problem_season.unwrap_or_default()),
                    Bind::Int(body.problem_episode.unwrap_or_default()),
                    Bind::Int(media.id),
                    Bind::Int(created_by.0.id),
                ],
            )
            .await;
        let issue_id =
            forward_on_err!(issue_id.map_err(|e| format!("inserting the issue failed: {e:#}")));
        let comment_id = crate::dbtx::Exec::Tx(&mut tx)
            .scalar(
                &format!(
                    r#"INSERT INTO "issue_comment" ("message", "createdAt", "updatedAt", "userId", "issueId") VALUES (?1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?2, ?3){RETURNING_ID}"#
                ),
                &[
                    Bind::Text(body.message.clone()),
                    Bind::Int(created_by.0.id),
                    Bind::Int(issue_id),
                ],
            )
            .await;
        if let Err(e) = comment_id {
            tracing::error!("inserting the first comment failed: {e:#}");
            return ctx.error(500, &format!("{e:#}"));
        }
        if let Err(e) = tx.commit().await {
            tracing::error!("saving the issue failed: {e:#}");
            return ctx.error(500, &format!("{e:#}"));
        }
        let Some(stored) = fail_on_err!(ctx, load(ctx, issue_id).await) else {
            return ctx.error(500, "the new issue vanished");
        };
        spawn_issue_notification(
            ctx,
            Kind::IssueCreated,
            issue_info(&stored.row, &created_by, None),
            media,
            (
                body.message.clone(),
                (stored.row.problem_season, stored.row.problem_episode),
            ),
        );
        let text = |v: &Option<String>| v.as_deref().map_or(Value::Null, Value::from);
        let mut comment = Draft::default();
        comment.put("user", creator_json.clone());
        comment.put("message", Value::from(body.message.as_str()));
        if let Some(c) = stored.row.comments.first() {
            comment.put("id", Value::from(c.id));
            comment.put("createdAt", text(&c.created_at));
            comment.put("updatedAt", text(&c.updated_at));
        }
        let mut issue = Draft::default();
        issue.put("createdBy", creator_json);
        issue.put("issueType", Value::from(body.issue_type));
        issue.put("problemSeason", Value::from(stored.row.problem_season));
        issue.put("problemEpisode", Value::from(stored.row.problem_episode));
        issue.put("media", media_json);
        issue.put("comments", Value::Array(vec![comment.json()]));
        issue.put("id", Value::from(stored.row.id));
        issue.put("status", Value::from(stored.row.status));
        issue.put("createdAt", text(&stored.row.created_at));
        issue.put("updatedAt", text(&stored.row.updated_at));
        ctx.json_with(201, &issue.json())
    })
}

/// `POST /issue/{id}/comment` and `POST /issue/{id}/{open|resolved}`.
fn action<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        match ctx.req.uri.path().rsplit('/').next().unwrap_or("") {
            // Express matches the literal `/:issueId/comment` without regard
            // to case, before `/:issueId/:status`.
            last if last.eq_ignore_ascii_case("comment") => comment(ctx).await,
            "open" => set_status(ctx, OPEN).await,
            "resolved" => set_status(ctx, RESOLVED).await,
            _ => Outcome::forward(String::from("the validator rejects other statuses")),
        }
    })
}

/// `POST /issue/{id}/comment`: a new comment, and the issue's
/// `updatedAt` set by hand.
async fn comment(ctx: &Ready<'_>) -> Outcome {
    forward_on_err!(ctx.no_query());
    let user = forward_on_err!(ctx.authenticated(MANAGE_ISSUES | CREATE_ISSUES));
    let id = forward_on_err!(ctx.path_id(1));
    let body = forward_on_err!(body_object(ctx));
    forward_on_err!(known_keys(body, &["message"]));
    let Some(message) = forward_on_err!(opt_text(body, "message")) else {
        return Outcome::forward(String::from("message is required by the validator"));
    };
    let viewer = forward_on_err!(current_user(ctx, user.id).await);
    let Some(loaded) = forward_on_err!(load(ctx, id).await) else {
        return ctx.error(500, "Issue not found.");
    };
    let Some(creator) = loaded.row.created_by_id else {
        return ctx.error(500, "Issue not found.");
    };
    if creator != user.id && !user.has_permission(MANAGE_ISSUES) {
        return ctx.error(403, "You do not have permission to comment on this issue.");
    }
    let mut out = forward_on_err!(loaded_json(ctx, &loaded).await);
    let viewer_json = forward_on_err!(user_json(&viewer));
    let db = &ctx.state.db;
    let comment_id = db
        .scalar(
            &format!(
                r#"INSERT INTO "issue_comment" ("message", "createdAt", "updatedAt", "userId", "issueId") VALUES (?1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?2, ?3){RETURNING_ID}"#
            ),
            &[Bind::Text(message.clone()), Bind::Int(user.id), Bind::Int(id)],
        )
        .await;
    let comment_id =
        forward_on_err!(comment_id.map_err(|e| format!("inserting the comment failed: {e:#}")));
    let now = crate::clock::Utc::now();
    let (placeholder, stamp) = if db.is_postgres() {
        ("CAST(?1 AS TIMESTAMPTZ)", now.iso_string())
    } else {
        ("?1", now.typeorm_string())
    };
    let updated = db
        .execute(
            &format!(r#"UPDATE "issue" SET "updatedAt" = {placeholder} WHERE "id" = ?2"#),
            &[Bind::Text(stamp), Bind::Int(id)],
        )
        .await;
    if let Err(e) = updated {
        tracing::debug!("Something went wrong creating an issue comment: {e:#}");
        return ctx.error(500, "Issue not found.");
    }
    out.insert(String::from("updatedAt"), Value::from(now.iso_string()));
    let stored = fail_on_err!(
        ctx,
        db.issue_comment(comment_id)
            .await
            .map_err(|e| format!("database: {e:#}"))
    );
    let text = |v: Option<&String>| v.map_or(Value::Null, |s| Value::from(s.as_str()));
    let mut fresh = Draft::default();
    fresh.put("message", Value::from(message.as_str()));
    fresh.put("user", viewer_json);
    fresh.put("id", Value::from(comment_id));
    fresh.put(
        "createdAt",
        text(stored.as_ref().and_then(|c| c.created_at.as_ref())),
    );
    fresh.put(
        "updatedAt",
        text(stored.as_ref().and_then(|c| c.updated_at.as_ref())),
    );
    if let Some(Value::Array(comments)) = out.get_mut("comments") {
        comments.push(fresh.json());
    }
    spawn_comment_notification(ctx, id, comment_id, message, viewer);
    ctx.json(&Value::Object(out))
}

/// `POST /issue/{id}/{open|resolved}`: the save sets `modifiedBy`, and
/// `IssueSubscriber.beforeUpdate` tells about a changed status.
async fn set_status(ctx: &Ready<'_>, status: i64) -> Outcome {
    forward_on_err!(ctx.no_query());
    let user = forward_on_err!(ctx.authenticated(MANAGE_ISSUES | CREATE_ISSUES));
    let id = forward_on_err!(ctx.path_id(1));
    let viewer = forward_on_err!(current_user(ctx, user.id).await);
    let Some(mut loaded) = forward_on_err!(load(ctx, id).await) else {
        return ctx.error(500, "Issue not found.");
    };
    if !user.has_permission(MANAGE_ISSUES) {
        match loaded.row.created_by_id {
            Some(creator) if creator == user.id => {}
            Some(_) => {
                return ctx.error(401, "You do not have permission to modify this issue.");
            }
            None => return ctx.error(500, "Issue not found."),
        }
    }
    let before = loaded.row.status;
    // A null `modifiedBy` always counts as changed when the entity is saved.
    let changed = before != status || loaded.row.modified_by_id != Some(user.id);
    if changed {
        let updated = ctx
            .state
            .db
            .execute(
                r#"UPDATE "issue" SET "modifiedById" = ?1, "status" = ?2, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?3"#,
                &[Bind::Int(user.id), Bind::Int(status), Bind::Int(id)],
            )
            .await;
        if let Err(e) = updated {
            tracing::debug!("Something went wrong updating an issue: {e:#}");
            return ctx.error(500, "Issue not found.");
        }
        let kind = match (status, before) {
            (RESOLVED, b) if b != RESOLVED => Some(Kind::IssueResolved),
            (OPEN, b) if b != OPEN => Some(Kind::IssueReopened),
            _ => None,
        };
        if let (Some(kind), Some(media), Some(creator)) =
            (kind, loaded.media.clone(), loaded.created_by.as_ref())
        {
            let mut row = loaded.row.clone();
            row.status = status;
            let problem = (row.problem_season, row.problem_episode);
            if let Some(first) = row.comments.first().map(|c| c.message.clone()) {
                spawn_issue_notification(
                    ctx,
                    kind,
                    issue_info(&row, creator, Some(&viewer)),
                    media,
                    (first, problem),
                );
            } else {
                // `firstComment.message` throws inside Node's try.
                tracing::error!("Something went wrong sending issue notification(s): no comments");
            }
        }
        match ctx.state.db.issue_by_id(id).await {
            Ok(Some(row)) => loaded.row.updated_at = row.updated_at,
            Ok(None) => {}
            Err(e) => tracing::warn!("re-reading issue {id} failed: {e:#}"),
        }
    }
    loaded.row.status = status;
    loaded.row.modified_by_id = Some(user.id);
    loaded.modified_by = Some(viewer);
    let out = loaded_json(ctx, &loaded).await;
    let out = if changed {
        fail_on_err!(ctx, out)
    } else {
        forward_on_err!(out)
    };
    ctx.json(&Value::Object(out))
}

/// `DELETE /issue/{id}`: the reporter may remove an issue nobody else
/// commented on.
fn remove<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        forward_on_err!(ctx.no_query());
        let user = forward_on_err!(ctx.authenticated(MANAGE_ISSUES | CREATE_ISSUES));
        let id = forward_on_err!(ctx.path_id(0));
        let issue = match ctx.state.db.issue_by_id(id).await {
            Ok(Some(issue)) => issue,
            Ok(None) => return ctx.error(404, "Issue not found."),
            Err(e) => return Outcome::forward(format!("database: {e:#}")),
        };
        if !user.has_permission(MANAGE_ISSUES) {
            match issue.created_by_id {
                Some(creator) if creator == user.id && issue.comments.len() <= 1 => {}
                Some(_) => {
                    return ctx.error(401, "You do not have permission to delete this issue.");
                }
                None => return ctx.error(404, "Issue not found."),
            }
        }
        let removed = ctx
            .state
            .db
            .execute(r#"DELETE FROM "issue" WHERE "id" = ?1"#, &[Bind::Int(id)])
            .await;
        if let Err(e) = removed {
            tracing::error!("Something went wrong deleting an issue: {e:#}");
            return ctx.error(404, "Issue not found.");
        }
        Ready::no_content()
    })
}

fn person(rel: &UserRel) -> Person {
    Person::from_records(&rel.0, rel.1.as_ref())
}

fn issue_info(row: &IssueRow, created_by: &UserRel, modified_by: Option<&UserRel>) -> IssueInfo {
    IssueInfo {
        id: row.id,
        issue_type: row.issue_type,
        status: row.status,
        created_by: person(created_by),
        modified_by: modified_by.map(person),
    }
}

/// `IssueTypeName[type] + ' '`, or nothing for `OTHER`.
fn type_prefix(issue_type: i64) -> String {
    if issue_type == OTHER {
        String::new()
    } else {
        format!("{} ", issue_type_name(issue_type))
    }
}

/// The subject (title and year) and poster of the issue's title.
async fn title_and_image(
    state: &AppState,
    settings: &Settings,
    media: &MediaRow,
) -> anyhow::Result<(String, String)> {
    let locale = settings.str("/main/locale");
    let locale = if locale.is_empty() { "en" } else { locale };
    let (details, name_key, date_key) = if media.media_type == "movie" {
        (
            state.tmdb.movie(media.tmdb_id, locale).await?,
            "title",
            "release_date",
        )
    } else {
        (
            state.tmdb.tv(media.tmdb_id, locale).await?,
            "name",
            "first_air_date",
        )
    };
    let name = js_string(details.get(name_key)).into_owned();
    let title = match details
        .get(date_key)
        .and_then(Value::as_str)
        .filter(|d| !d.is_empty())
    {
        Some(d) => format!("{name} ({})", d.chars().take(4).collect::<String>()),
        None => name,
    };
    let image = format!(
        "https://image.tmdb.org/t/p/w600_and_h900_bestv2{}",
        js_string(details.get("poster_path"))
    );
    Ok((title, image))
}

/// `IssueSubscriber.sendIssueNotification`, in the background.
fn spawn_issue_notification(
    ctx: &Ready<'_>,
    kind: Kind,
    issue: IssueInfo,
    media: MediaRow,
    texts: (String, (i64, i64)),
) {
    let (first_message, problem) = texts;
    let state = Arc::clone(&ctx.shared);
    let settings = Arc::clone(&ctx.settings);
    tokio::spawn(async move {
        let (title, image) = match title_and_image(&state, &settings, &media).await {
            Ok(found) => found,
            Err(e) => {
                tracing::error!("Something went wrong sending issue notification(s): {e:#}");
                return;
            }
        };
        let prefix = type_prefix(issue.issue_type);
        let event = match kind {
            Kind::IssueCreated => format!("New {prefix}Issue Reported"),
            Kind::IssueResolved => format!("{prefix}Issue Resolved"),
            Kind::IssueReopened
            | Kind::IssueComment
            | Kind::MediaPending
            | Kind::MediaApproved
            | Kind::MediaAvailable
            | Kind::MediaFailed
            | Kind::Test
            | Kind::MediaDeclined
            | Kind::MediaAutoApproved
            | Kind::MediaAutoRequested
            | Kind::NewSeason
            | Kind::ReleaseDateChanged => format!("{prefix}Issue Reopened"),
        };
        let notify_user = (matches!(kind, Kind::IssueResolved | Kind::IssueReopened)
            && !issue.created_by.has_permission(MANAGE_ISSUES)
            && issue.modified_by.as_ref().map(|m| m.id) != Some(issue.created_by.id))
        .then(|| issue.created_by.clone());
        let payload = Payload {
            event: Some(event),
            subject: title,
            message: Some(first_message),
            image: Some(image),
            extra: issue_extra(&media, problem),
            notify_admin: true,
            notify_system: true,
            notify_user,
            media: Some(media),
            issue: Some(issue),
            ..Payload::default()
        };
        notify::send(state, settings, kind, payload);
    });
}

/// `Affected Season` and `Affected Episode` for a TV issue.
fn issue_extra(media: &MediaRow, (season, episode): (i64, i64)) -> Vec<(String, String)> {
    let mut extra = Vec::new();
    if media.media_type == "tv" && season > 0 {
        extra.push((String::from("Affected Season"), season.to_string()));
        if episode > 0 {
            extra.push((String::from("Affected Episode"), episode.to_string()));
        }
    }
    extra
}

/// `IssueCommentSubscriber.sendIssueCommentNotification`, in the
/// background: every comment but the first.
fn spawn_comment_notification(
    ctx: &Ready<'_>,
    issue_id: i64,
    comment_id: i64,
    message: String,
    author: UserRel,
) {
    let state = Arc::clone(&ctx.shared);
    let settings = Arc::clone(&ctx.settings);
    tokio::spawn(async move {
        let result = async {
            let db = &state.db;
            let issue = db
                .issue_by_id(issue_id)
                .await?
                .ok_or_else(|| anyhow::anyhow!("the issue is gone"))?;
            let creator = db
                .user_record(issue.created_by_id.unwrap_or_default())
                .await?
                .ok_or_else(|| anyhow::anyhow!("the issue's creator is gone"))?;
            let media = db
                .media_by_ids(&[issue.media_id.unwrap_or_default()], true)
                .await?
                .pop()
                .ok_or_else(|| anyhow::anyhow!("the issue's media is gone"))?;
            let (title, image) = title_and_image(&state, &settings, &media).await?;
            let Some(first) = issue.comments.first() else {
                return anyhow::Ok(());
            };
            if first.id == comment_id {
                return anyhow::Ok(());
            }
            let modified_by = match issue.modified_by_id {
                Some(uid) => db.user_record(uid).await?,
                None => None,
            };
            let created_by = person(&creator);
            let commenter = person(&author);
            let notify_user = (!created_by.has_permission(MANAGE_ISSUES)
                && created_by.id != commenter.id)
                .then(|| created_by.clone());
            let payload = Payload {
                event: Some(format!(
                    "New Comment on {}Issue",
                    type_prefix(issue.issue_type)
                )),
                subject: title,
                message: Some(first.message.clone()),
                image: Some(image),
                notify_admin: true,
                notify_system: true,
                notify_user,
                comment: Some(CommentInfo {
                    message,
                    user: commenter,
                }),
                issue: Some(IssueInfo {
                    id: issue.id,
                    issue_type: (issue.issue_type),
                    status: issue.status,
                    created_by,
                    modified_by: modified_by.as_ref().map(person),
                }),
                media: Some(media),
                ..Payload::default()
            };
            notify::send(
                Arc::clone(&state),
                Arc::clone(&settings),
                Kind::IssueComment,
                payload,
            );
            anyhow::Ok(())
        }
        .await;
        if let Err(e) = result {
            tracing::error!("Something went wrong sending issue comment notification(s): {e:#}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_prefixes() {
        assert_eq!(type_prefix(1), "Video ", "video");
        assert_eq!(type_prefix(OTHER), "", "other has none");
        assert_eq!(type_prefix(9), "undefined ", "an unknown type");
    }
}
