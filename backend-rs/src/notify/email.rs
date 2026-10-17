//! The email agent: the system never gets mail, only the notified user and
//! the admins who want it.

use std::sync::Arc;

use anyhow::Result;

use super::{issue_type_name, Env, Kind, Payload, Person};
use crate::email::{self, Frame, MediaIssueMail, MediaRequestMail, Rendered};
use crate::settings::public::truthy;

/// Whether the agent is configured: `shouldSend`.
fn configured(env: &Env) -> bool {
    let get = |p: &str| truthy(env.settings.get(&format!("/notifications/agents/email{p}")));
    get("/enabled")
        && get("/options/emailFrom")
        && get("/options/smtpHost")
        && get("/options/smtpPort")
}

/// `buildMessage` for one recipient.
fn build(env: &Env, kind: Kind, payload: &Payload, user: &Person) -> Option<Rendered> {
    let intl = env.intl(user.locale());
    let frame = Frame::new(&env.settings, &user.email, &user.display_name);
    if kind == Kind::Test {
        return Some(email::test_email(
            &frame,
            payload.message.as_deref().unwrap_or("undefined"),
        ));
    }
    let embed_poster = truthy(env.settings.get("/notifications/agents/email/embedPoster"));
    let media_type = payload.media.as_ref().map(|m| {
        let key = if m.media_type == "movie" {
            "movie"
        } else {
            "series"
        };
        intl.format(&format!("notifications.common.{key}"), &[])
    });
    let msg = |key: &str, args: &[(&str, Option<&str>)]| {
        intl.format_strict(&format!("notifications.agents.email.{key}"), args)
    };
    let timestamp = local_time_string();
    let application_url = env.settings.str("/main/applicationUrl");
    if let Some(request) = &payload.request {
        let k4 = if request.is4k { "4k" } else { "" };
        let mt = media_type.as_deref();
        let body = match kind {
            Kind::MediaPending => msg(&format!("pendingRequest{k4}"), &[("mediaType", mt)]),
            Kind::MediaAutoRequested => msg(&format!("autoRequested{k4}"), &[("mediaType", mt)]),
            Kind::MediaApproved => msg(&format!("approvedRequest{k4}"), &[("mediaType", mt)]),
            Kind::MediaAutoApproved => msg(&format!("autoApproved{k4}"), &[("mediaType", mt)]),
            Kind::MediaAvailable => msg(&format!("availableRequest{k4}"), &[("mediaType", mt)]),
            Kind::MediaDeclined => msg(&format!("declinedRequest{k4}"), &[("mediaType", mt)]),
            Kind::MediaFailed => {
                let service = if payload
                    .media
                    .as_ref()
                    .is_some_and(|m| m.media_type == "movie")
                {
                    "Radarr"
                } else {
                    "Sonarr"
                };
                msg(
                    &format!("failedRequest{k4}"),
                    &[("mediaType", mt), ("service", Some(service))],
                )
            }
            Kind::Test
            | Kind::IssueCreated
            | Kind::IssueComment
            | Kind::IssueResolved
            | Kind::IssueReopened
            | Kind::NewSeason
            | Kind::ReleaseDateChanged => String::new(),
        };
        let action_url = payload.watch_url.clone().or_else(|| {
            (!application_url.is_empty()).then(|| {
                let m = payload.media.as_ref();
                format!(
                    "{application_url}/{}/{}",
                    m.map_or("undefined", |m| m.media_type.as_str()),
                    m.map_or_else(|| String::from("undefined"), |m| m.tmdb_id.to_string())
                )
            })
        });
        return Some(email::media_request(
            &frame,
            &MediaRequestMail {
                event: payload.event.clone(),
                body,
                media_name: payload.subject.clone(),
                extra: payload.extra.clone(),
                image_url: if embed_poster {
                    payload.image.clone()
                } else {
                    None
                },
                timestamp,
                requested_by: request.requested_by.display_name.clone(),
                action_url,
            },
        ));
    }
    let issue = payload.issue.as_ref()?;
    let issue_type = if issue.issue_type == 4 {
        msg("issue", &[])
    } else {
        intl.format(
            "notifications.agents.email.issueType",
            &[("type", &issue_type_name(issue.issue_type).to_lowercase())],
        )
    };
    let mt = media_type.as_deref();
    let subject = Some(payload.subject.as_str());
    let it = Some(issue_type.as_str());
    let modified = issue.modified_by.as_ref().map(|m| m.display_name.as_str());
    let body = match kind {
        Kind::IssueCreated => msg(
            "issueCreated",
            &[
                ("issueType", it),
                ("userName", Some(&issue.created_by.display_name)),
                ("mediaType", mt),
                ("subject", subject),
            ],
        ),
        Kind::IssueComment => msg(
            "issueComment",
            &[
                (
                    "userName",
                    payload
                        .comment
                        .as_ref()
                        .map(|c| c.user.display_name.as_str()),
                ),
                ("issueType", it),
                ("mediaType", mt),
                ("subject", subject),
            ],
        ),
        Kind::IssueResolved => msg(
            "issueResolved",
            &[
                ("issueType", it),
                ("userName", modified),
                ("mediaType", mt),
                ("subject", subject),
            ],
        ),
        Kind::IssueReopened => msg(
            "issueReopened",
            &[
                ("issueType", it),
                ("userName", modified),
                ("mediaType", mt),
                ("subject", subject),
            ],
        ),
        Kind::MediaPending
        | Kind::MediaApproved
        | Kind::MediaAvailable
        | Kind::MediaFailed
        | Kind::Test
        | Kind::MediaDeclined
        | Kind::MediaAutoApproved
        | Kind::MediaAutoRequested
        | Kind::NewSeason
        | Kind::ReleaseDateChanged => String::new(),
    };
    Some(email::media_issue(
        &frame,
        &MediaIssueMail {
            event: payload.event.clone(),
            body,
            issue_description: payload.message.clone(),
            issue_comment: payload.comment.as_ref().map(|c| c.message.clone()),
            media_name: payload.subject.clone(),
            action_url: (!application_url.is_empty())
                .then(|| format!("{application_url}/issues/{}", issue.id)),
        },
    ))
}

/// `new Date().toTimeString()` in UTC, which is what Node prints when the
/// server runs in UTC.
fn local_time_string() -> String {
    let t = crate::clock::Utc::now();
    format!(
        "{:02}:{:02}:{:02} GMT+0000 (Coordinated Universal Time)",
        t.hour, t.minute, t.second
    )
}

async fn mail(env: &Env, kind: Kind, payload: &Payload, user: &Person) {
    if !email::is_email(&user.email) {
        tracing::warn!(
            "not sending email to {}: invalid address",
            user.display_name
        );
        return;
    }
    let Some(rendered) = build(env, kind, payload, user) else {
        return;
    };
    let pgp = user.settings.as_ref().and_then(|s| s.pgp_key.as_deref());
    if let Err(e) = email::send(&env.settings, &user.email, &rendered, pgp).await {
        tracing::error!(
            "Error sending email notification to {}: {e:#}",
            user.display_name
        );
    }
}

/// The email agent.
///
/// # Errors
///
/// Fails on database errors.
pub async fn send(env: Env, kind: Kind, payload: Arc<Payload>) -> Result<()> {
    if !configured(&env) {
        return Ok(());
    }
    if let Some(user) = &payload.notify_user {
        if user.wants("email", kind).unwrap_or(true) {
            mail(&env, kind, &payload, user).await;
        }
    }
    if payload.notify_admin {
        for user in env.users().await? {
            if user.wants("email", kind).unwrap_or(true) && payload.admin_should_get(kind, &user) {
                mail(&env, kind, &payload, &user).await;
            }
        }
    }
    Ok(())
}
