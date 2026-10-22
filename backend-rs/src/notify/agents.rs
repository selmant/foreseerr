//! The agents that post to a service: webhook, Discord, Slack, Telegram,
//! Pushbullet, Pushover, Gotify and ntfy, plus web push (see
//! [`super::webpush`]).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use anyhow::{Context, Result};
use base64::prelude::*;
use serde_json::{Map, Value};

use super::{has_type, issue_type_name, request_status, Env, Kind, Payload, Person};
use crate::media::js_string;
use crate::settings::public::truthy;

/// An agent: runs to completion in its own task.
pub type Agent = fn(Env, Kind, Arc<Payload>) -> Pin<Box<dyn Future<Output = Result<()>> + Send>>;

/// Every agent, in Node's registration order.
pub const ALL: [Agent; 10] = [
    |e, k, p| Box::pin(discord(e, k, p)),
    |e, k, p| Box::pin(super::email::send(e, k, p)),
    |e, k, p| Box::pin(super::webpush::send(e, k, p)),
    |e, k, p| Box::pin(gotify(e, k, p, true)),
    |e, k, p| Box::pin(ntfy(e, k, p, true)),
    |e, k, p| Box::pin(pushbullet(e, k, p)),
    |e, k, p| Box::pin(pushover(e, k, p, true)),
    |e, k, p| Box::pin(slack(e, k, p)),
    |e, k, p| Box::pin(telegram(e, k, p, true)),
    |e, k, p| Box::pin(webhook(e, k, p)),
];

/// A string setting by pointer within an agent section.
fn opt<'a>(agent: &'a Value, pointer: &str) -> Option<&'a Value> {
    agent.pointer(pointer)
}

fn text(agent: &Value, pointer: &str) -> String {
    match opt(agent, pointer) {
        None | Some(Value::Null) => String::new(),
        other => js_string(other).into_owned(),
    }
}

fn is_set(agent: &Value, pointer: &str) -> bool {
    truthy(opt(agent, pointer))
}

/// A setting in a template literal: `undefined` and `null` spelled out.
fn template(agent: &Value, pointer: &str) -> String {
    match opt(agent, pointer) {
        None => String::from("undefined"),
        Some(Value::Null) => String::from("null"),
        other => js_string(other).into_owned(),
    }
}

/// `agent.send(type, payload)` without `shouldSend()`, as the test route
/// calls it.
///
/// For the agents whose `send` goes on where their gate stops: Telegram
/// without a bot token, Gotify without a priority, ntfy without a topic,
/// Pushover without the system keys. `None` for the others.
pub async fn send_ungated(
    name: &str,
    env: Env,
    kind: Kind,
    payload: Arc<Payload>,
) -> Option<Result<()>> {
    Some(match name {
        "telegram" => telegram(env, kind, payload, false).await,
        "gotify" => gotify(env, kind, payload, false).await,
        "ntfy" => ntfy(env, kind, payload, false).await,
        "pushover" => pushover(env, kind, payload, false).await,
        _ => return None,
    })
}

/// The system (channel) gate: `notifySystem` and the agent's type mask.
fn system_wants(agent: &Value, kind: Kind, payload: &Payload) -> bool {
    payload.notify_system
        && has_type(
            kind,
            opt(agent, "/types").and_then(Value::as_i64).unwrap_or(0),
        )
}

/// `axios.post(url, body, { headers })`.
async fn post(env: &Env, url: &str, body: &Value, headers: &[(String, String)]) -> Result<()> {
    let mut request = env
        .state
        .outbound
        .post(url)
        .header(reqwest::header::ACCEPT, "application/json, text/plain, */*")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body.to_string());
    for (name, value) in headers {
        request = request.header(name.as_str(), value.as_str());
    }
    // Webhook paths and queries carry tokens (Telegram's bot token,
    // Gotify's `?token=`), so errors name the host only.
    let origin = reqwest::Url::parse(url).map_or_else(
        |_| String::from("(an invalid URL)"),
        |u| u.origin().ascii_serialization(),
    );
    request
        .send()
        .await
        .map_err(reqwest::Error::without_url)
        .with_context(|| format!("POST {origin}"))?
        .error_for_status()
        .map_err(reqwest::Error::without_url)
        .with_context(|| format!("POST {origin}"))?;
    Ok(())
}

fn common(intl: &crate::i18n::Intl, key: &str, args: &[(&str, &str)]) -> String {
    intl.format(&format!("notifications.common.{key}"), args)
}

/// Append formatted text without an intermediate `String`.
fn push(out: &mut String, args: std::fmt::Arguments<'_>) {
    if std::fmt::Write::write_fmt(out, args).is_err() {
        tracing::error!("formatting into a String failed");
    }
}

fn open_or_resolved(intl: &crate::i18n::Intl, status: i64) -> String {
    if status == 1 {
        common(intl, "open", &[])
    } else {
        common(intl, "resolved", &[])
    }
}

fn view_label(intl: &crate::i18n::Intl, payload: &Payload, title: &str) -> String {
    if payload.issue.is_some() {
        common(intl, "viewIssue", &[("applicationTitle", title)])
    } else {
        common(intl, "viewMedia", &[("applicationTitle", title)])
    }
}

fn insert_some(out: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        out.insert(key.to_owned(), value);
    }
}

// ---------------------------------------------------------------- Discord

/// `EmbedColors`.
const DARK_PURPLE: i64 = 7_419_530;
const ORANGE: i64 = 15_105_570;
const PURPLE: i64 = 10_181_046;
const GREEN: i64 = 3_066_993;
const RED: i64 = 15_158_332;

/// `DISCORD_SNOWFLAKE_REGEX`.
fn snowflake(id: &str) -> bool {
    (17..=20).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit())
}

fn discord_embed(env: &Env, kind: Kind, payload: &Payload, locale: Option<&str>) -> Value {
    let intl = env.intl(locale);
    let application_url = env.settings.str("/main/applicationUrl");
    let embed_poster = truthy(
        env.settings
            .get("/notifications/agents/discord/embedPoster"),
    );
    let app_url = if application_url.is_empty() {
        String::from("http://localhost:5055")
    } else {
        application_url.to_owned()
    };
    let mut color = DARK_PURPLE;
    let mut fields = Vec::new();
    let field = |name: String, value: String, inline: bool| {
        let mut f = Map::new();
        f.insert(String::from("name"), Value::from(name));
        f.insert(String::from("value"), Value::from(value));
        f.insert(String::from("inline"), Value::Bool(inline));
        Value::Object(f)
    };
    if let Some(request) = &payload.request {
        fields.push(field(
            common(&intl, "requestedBy", &[]),
            request.requested_by.display_name.clone(),
            true,
        ));
        let status = match kind {
            Kind::MediaPending => {
                color = ORANGE;
                format!(
                    "[{}]({app_url}/requests)",
                    common(&intl, "pendingApproval", &[])
                )
            }
            Kind::MediaApproved | Kind::MediaAutoApproved => {
                color = PURPLE;
                common(&intl, "processing", &[])
            }
            Kind::MediaAvailable => {
                color = GREEN;
                common(&intl, "available", &[])
            }
            Kind::MediaDeclined => {
                color = RED;
                common(&intl, "declined", &[])
            }
            Kind::MediaFailed => {
                color = RED;
                common(&intl, "failed", &[])
            }
            Kind::Test
            | Kind::IssueCreated
            | Kind::IssueComment
            | Kind::IssueResolved
            | Kind::IssueReopened
            | Kind::MediaAutoRequested
            | Kind::NewSeason
            | Kind::ReleaseDateChanged => String::new(),
        };
        if !status.is_empty() {
            fields.push(field(common(&intl, "requestStatus", &[]), status, true));
        }
    } else if let Some(comment) = &payload.comment {
        fields.push(field(
            common(
                &intl,
                "commentFrom",
                &[("userName", &comment.user.display_name)],
            ),
            comment.message.clone(),
            false,
        ));
    } else if let Some(issue) = &payload.issue {
        fields.push(field(
            common(&intl, "reportedBy", &[]),
            issue.created_by.display_name.clone(),
            true,
        ));
        fields.push(field(
            common(&intl, "issueType", &[]),
            issue_type_name(issue.issue_type).to_owned(),
            true,
        ));
        fields.push(field(
            common(&intl, "issueStatus", &[]),
            open_or_resolved(&intl, issue.status),
            true,
        ));
        color = match kind {
            Kind::IssueCreated | Kind::IssueReopened => RED,
            Kind::IssueComment => ORANGE,
            Kind::IssueResolved => GREEN,
            Kind::MediaPending
            | Kind::MediaApproved
            | Kind::MediaAvailable
            | Kind::MediaFailed
            | Kind::Test
            | Kind::MediaDeclined
            | Kind::MediaAutoApproved
            | Kind::MediaAutoRequested
            | Kind::NewSeason
            | Kind::ReleaseDateChanged => color,
        };
    }
    for (name, value) in &payload.extra {
        fields.push(field(name.clone(), value.clone(), true));
    }
    let url = payload.watch_url.clone().or_else(|| {
        if application_url.is_empty() {
            None
        } else {
            payload.link(application_url)
        }
    });
    let mut embed = Map::new();
    embed.insert(
        String::from("title"),
        Value::from(payload.event.as_ref().map_or_else(
            || payload.subject.clone(),
            |event| format!("{event}: {}", payload.subject),
        )),
    );
    insert_some(&mut embed, "url", url.map(Value::from));
    insert_some(
        &mut embed,
        "description",
        payload.message.clone().map(Value::from),
    );
    embed.insert(String::from("color"), Value::from(color));
    embed.insert(
        String::from("timestamp"),
        Value::from(crate::clock::Utc::now().iso_string()),
    );
    embed.insert(String::from("fields"), Value::Array(fields));
    if embed_poster {
        let mut thumbnail = Map::new();
        insert_some(
            &mut thumbnail,
            "url",
            payload.image.clone().map(Value::from),
        );
        embed.insert(String::from("thumbnail"), Value::Object(thumbnail));
    }
    Value::Object(embed)
}

async fn discord(env: Env, kind: Kind, payload: Arc<Payload>) -> Result<()> {
    let agent = env.agent("discord");
    if !(is_set(&agent, "/enabled") && is_set(&agent, "/options/webhookUrl")) {
        return Ok(());
    }
    if !system_wants(&agent, kind, &payload) {
        return Ok(());
    }
    let mut mentions: Vec<String> = Vec::new();
    if is_set(&agent, "/options/enableMentions") {
        if let Some(user) = &payload.notify_user {
            if user.wants("discord", kind) == Some(true) {
                if let Some(s) = &user.settings {
                    mentions.extend(
                        s.discord_ids
                            .iter()
                            .filter(|id| snowflake(id))
                            .map(|id| format!("<@{id}>")),
                    );
                }
            }
        }
        if payload.notify_admin {
            for user in env.users().await? {
                if user.wants("discord", kind) == Some(true)
                    && user
                        .settings
                        .as_ref()
                        .is_some_and(|s| !s.discord_ids.is_empty())
                    && payload.admin_should_get(kind, &user)
                {
                    if let Some(s) = &user.settings {
                        mentions.extend(
                            s.discord_ids
                                .iter()
                                .filter(|id| snowflake(id))
                                .map(|id| format!("<@{id}>")),
                        );
                    }
                }
            }
        }
    }
    let users: Vec<Value> = mentions
        .iter()
        .map(|m| Value::from(m.replace(['<', '@', '>'], "")))
        .collect();
    let mut roles = Vec::new();
    let role = text(&agent, "/options/webhookRoleId");
    if !role.is_empty() && snowflake(&role) {
        mentions.push(format!("<@&{role}>"));
        roles.push(Value::from(role));
    }
    let locale = if is_set(&agent, "/options/useUserLocale") {
        payload
            .notify_user
            .as_ref()
            .and_then(Person::locale)
            .map(str::to_owned)
    } else {
        Some(text(&agent, "/options/locale"))
    };
    let mut url =
        reqwest::Url::parse(&text(&agent, "/options/webhookUrl")).context("webhook URL")?;
    let thread = text(&agent, "/options/webhookThreadId");
    if !thread.is_empty() {
        let others: Vec<(String, String)> = url
            .query_pairs()
            .filter(|(k, _)| k != "thread_id")
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        url.query_pairs_mut()
            .clear()
            .extend_pairs(others)
            .append_pair("thread_id", &thread);
    }
    let mut body = Map::new();
    let bot = text(&agent, "/options/botUsername");
    body.insert(
        String::from("username"),
        Value::from(if bot.is_empty() {
            env.settings.str("/main/applicationTitle").to_owned()
        } else {
            bot
        }),
    );
    insert_some(
        &mut body,
        "avatar_url",
        opt(&agent, "/options/botAvatarUrl")
            .filter(|v| !v.is_null())
            .cloned(),
    );
    body.insert(
        String::from("embeds"),
        Value::Array(vec![discord_embed(&env, kind, &payload, locale.as_deref())]),
    );
    body.insert(String::from("content"), Value::from(mentions.join(" ")));
    let mut allowed = Map::new();
    allowed.insert(String::from("users"), Value::Array(users));
    allowed.insert(String::from("roles"), Value::Array(roles));
    body.insert(String::from("allowed_mentions"), Value::Object(allowed));
    post(&env, url.as_str(), &Value::Object(body), &[]).await
}

// ------------------------------------------------------------------ Slack

async fn slack(env: Env, kind: Kind, payload: Arc<Payload>) -> Result<()> {
    let agent = env.agent("slack");
    let configured = is_set(&agent, "/enabled") && is_set(&agent, "/options/webhookUrl");
    if !configured || !system_wants(&agent, kind, &payload) {
        return Ok(());
    }
    let intl = env.intl(Some(&text(&agent, "/options/locale")));
    let application_url = env.settings.str("/main/applicationUrl");
    let title = env.settings.str("/main/applicationTitle");
    let embed_poster = is_set(&agent, "/embedPoster");
    let mrkdwn = |t: String| {
        let mut f = Map::new();
        f.insert(String::from("type"), Value::from("mrkdwn"));
        f.insert(String::from("text"), Value::from(t));
        Value::Object(f)
    };
    let mut fields = Vec::new();
    if let Some(request) = &payload.request {
        fields.push(mrkdwn(format!(
            "*{}*\n{}",
            common(&intl, "requestedBy", &[]),
            request.requested_by.display_name
        )));
        if let Some(status) = request_status(kind, &payload, &intl) {
            fields.push(mrkdwn(format!(
                "*{}*\n{status}",
                common(&intl, "requestStatus", &[])
            )));
        }
    } else if let Some(comment) = &payload.comment {
        fields.push(mrkdwn(format!(
            "*{}*\n{}",
            common(
                &intl,
                "commentFrom",
                &[("userName", &comment.user.display_name)]
            ),
            comment.message
        )));
    } else if let Some(issue) = &payload.issue {
        fields.push(mrkdwn(format!(
            "*{}*\n{}",
            common(&intl, "reportedBy", &[]),
            issue.created_by.display_name
        )));
        fields.push(mrkdwn(format!(
            "*{}*\n{}",
            common(&intl, "issueType", &[]),
            issue_type_name(issue.issue_type)
        )));
        fields.push(mrkdwn(format!(
            "*{}*\n{}",
            common(&intl, "issueStatus", &[]),
            open_or_resolved(&intl, issue.status)
        )));
    }
    for (name, value) in &payload.extra {
        fields.push(mrkdwn(format!("*{name}*\n{value}")));
    }
    let mut blocks = Vec::new();
    let block = |kind: &str| {
        let mut b = Map::new();
        b.insert(String::from("type"), Value::from(kind));
        b
    };
    if let Some(event) = &payload.event {
        let mut b = block("context");
        b.insert(
            String::from("elements"),
            Value::Array(vec![mrkdwn(format!("*{event}*"))]),
        );
        blocks.push(Value::Object(b));
    }
    let plain = |t: &str| {
        let mut f = Map::new();
        f.insert(String::from("type"), Value::from("plain_text"));
        f.insert(String::from("text"), Value::from(t));
        Value::Object(f)
    };
    let mut header = block("header");
    header.insert(String::from("text"), plain(&payload.subject));
    blocks.push(Value::Object(header));
    if let Some(message) = &payload.message {
        let mut b = block("section");
        b.insert(String::from("text"), mrkdwn(message.clone()));
        if let (true, Some(image)) = (embed_poster, &payload.image) {
            let mut accessory = Map::new();
            accessory.insert(String::from("type"), Value::from("image"));
            accessory.insert(String::from("image_url"), Value::from(image.as_str()));
            accessory.insert(
                String::from("alt_text"),
                Value::from(payload.subject.as_str()),
            );
            b.insert(String::from("accessory"), Value::Object(accessory));
        }
        blocks.push(Value::Object(b));
    }
    if !fields.is_empty() {
        let mut b = block("section");
        b.insert(String::from("fields"), Value::Array(fields));
        blocks.push(Value::Object(b));
    }
    if let Some(url) = payload.link(application_url) {
        let mut button = Map::new();
        button.insert(String::from("action_id"), Value::from("open-in-seerr"));
        button.insert(String::from("type"), Value::from("button"));
        button.insert(String::from("url"), Value::from(url));
        button.insert(
            String::from("text"),
            plain(&view_label(&intl, &payload, title)),
        );
        let mut b = block("actions");
        b.insert(
            String::from("elements"),
            Value::Array(vec![Value::Object(button)]),
        );
        blocks.push(Value::Object(b));
    }
    let mut body = Map::new();
    body.insert(
        String::from("text"),
        Value::from(
            payload
                .event
                .clone()
                .unwrap_or_else(|| payload.subject.clone()),
        ),
    );
    body.insert(String::from("blocks"), Value::Array(blocks));
    post(
        &env,
        &text(&agent, "/options/webhookUrl"),
        &Value::Object(body),
        &[],
    )
    .await
}

// --------------------------------------------------------------- Telegram

/// `escapeText`: the reserved characters of Telegram's `MarkdownV2`.
fn telegram_escape(text: &str) -> String {
    telegram_escape_chars(text, "_*[]()~`>#+=|{}.!-\\")
}

/// `escapeUrl`: inside a link's `(...)`, only `)` and `\` are reserved.
fn telegram_escape_url(url: &str) -> String {
    telegram_escape_chars(url, ")\\")
}

fn telegram_escape_chars(text: &str, reserved: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if reserved.contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn telegram_payload(
    env: &Env,
    kind: Kind,
    payload: &Payload,
    locale: Option<&str>,
) -> Map<String, Value> {
    let intl = env.intl(locale);
    let application_url = env.settings.str("/main/applicationUrl");
    let title = env.settings.str("/main/applicationTitle");
    let embed_poster = truthy(
        env.settings
            .get("/notifications/agents/telegram/embedPoster"),
    );
    let headline = payload.event.as_ref().map_or_else(
        || payload.subject.clone(),
        |e| format!("{e} - {}", payload.subject),
    );
    let mut message = format!("*{}*", telegram_escape(&headline));
    if let Some(m) = &payload.message {
        push(&mut message, format_args!("\n{}", telegram_escape(m)));
    }
    if let Some(request) = &payload.request {
        push(
            &mut message,
            format_args!(
                "\n\n*{}:* {}",
                telegram_escape(&common(&intl, "requestedBy", &[])),
                telegram_escape(&request.requested_by.display_name)
            ),
        );
        if let Some(status) = request_status(kind, payload, &intl) {
            push(
                &mut message,
                format_args!(
                    "\n*{}:* {}",
                    telegram_escape(&common(&intl, "requestStatus", &[])),
                    telegram_escape(&status)
                ),
            );
        }
    } else if let Some(comment) = &payload.comment {
        push(
            &mut message,
            format_args!(
                "\n\n*{}:* {}",
                telegram_escape(&common(
                    &intl,
                    "commentFrom",
                    &[("userName", &comment.user.display_name)]
                )),
                telegram_escape(&comment.message)
            ),
        );
    } else if let Some(issue) = &payload.issue {
        push(
            &mut message,
            format_args!(
                "\n\n*{}:* {}",
                telegram_escape(&common(&intl, "reportedBy", &[])),
                telegram_escape(&issue.created_by.display_name)
            ),
        );
        push(
            &mut message,
            format_args!(
                "\n*{}:* {}",
                telegram_escape(&common(&intl, "issueType", &[])),
                telegram_escape(issue_type_name(issue.issue_type))
            ),
        );
        push(
            &mut message,
            format_args!(
                "\n*{}:* {}",
                telegram_escape(&common(&intl, "issueStatus", &[])),
                telegram_escape(&open_or_resolved(&intl, issue.status))
            ),
        );
    }
    for (name, value) in &payload.extra {
        push(&mut message, format_args!("\n*{name}:* {value}"));
    }
    if let Some(url) = payload.link(application_url) {
        push(
            &mut message,
            format_args!(
                "\n\n[{}]({})",
                telegram_escape(&view_label(&intl, payload, title)),
                telegram_escape_url(&url)
            ),
        );
    }
    let mut out = Map::new();
    match (embed_poster, &payload.image) {
        (true, Some(image)) => {
            out.insert(String::from("photo"), Value::from(image.as_str()));
            out.insert(String::from("caption"), Value::from(message));
        }
        _ => {
            out.insert(String::from("text"), Value::from(message));
        }
    }
    out.insert(String::from("parse_mode"), Value::from("MarkdownV2"));
    out
}

async fn telegram(env: Env, kind: Kind, payload: Arc<Payload>, gated: bool) -> Result<()> {
    let agent = env.agent("telegram");
    if gated && !(is_set(&agent, "/enabled") && is_set(&agent, "/options/botAPI")) {
        return Ok(());
    }
    let method = if is_set(&agent, "/embedPoster") && payload.image.is_some() {
        "sendPhoto"
    } else {
        "sendMessage"
    };
    let endpoint = format!(
        "https://api.telegram.org/bot{}/{method}",
        template(&agent, "/options/botAPI")
    );
    let chat_id = text(&agent, "/options/chatId");
    let with = |mut body: Map<String, Value>, chat: &str, thread: Option<Value>, silent: bool| {
        body.insert(String::from("chat_id"), Value::from(chat));
        insert_some(&mut body, "message_thread_id", thread);
        body.insert(String::from("disable_notification"), Value::Bool(silent));
        Value::Object(body)
    };
    if system_wants(&agent, kind, &payload) && !chat_id.is_empty() {
        let body = with(
            telegram_payload(&env, kind, &payload, None),
            &chat_id,
            opt(&agent, "/options/messageThreadId")
                .filter(|v| !v.is_null())
                .cloned(),
            is_set(&agent, "/options/sendSilently"),
        );
        post(&env, &endpoint, &body, &[]).await?;
    }
    let deliver = |user: &Person| -> Option<Value> {
        let s = user.settings.as_ref()?;
        let chat = s
            .telegram_chat_id
            .as_deref()
            .filter(|c| !c.is_empty() && *c != chat_id)?;
        Some(with(
            telegram_payload(&env, kind, &payload, user.locale()),
            chat,
            s.telegram_thread_id.clone().map(Value::from),
            s.telegram_silent.unwrap_or(false),
        ))
    };
    if let Some(user) = &payload.notify_user {
        if user.wants("telegram", kind) == Some(true) {
            if let Some(body) = deliver(user) {
                post(&env, &endpoint, &body, &[]).await?;
            }
        }
    }
    if payload.notify_admin {
        for user in env.users().await? {
            if user.wants("telegram", kind) == Some(true) && payload.admin_should_get(kind, &user) {
                if let Some(body) = deliver(&user) {
                    if let Err(e) = post(&env, &endpoint, &body, &[]).await {
                        tracing::error!("telegram: {e:#}");
                    }
                }
            }
        }
    }
    Ok(())
}

// ------------------------------------------------------------- Pushbullet

fn plain_body(env: &Env, kind: Kind, payload: &Payload, locale: Option<&str>) -> String {
    let intl = env.intl(locale);
    let mut body = payload.message.clone().unwrap_or_default();
    if let Some(request) = &payload.request {
        push(
            &mut body,
            format_args!(
                "\n\n{}: {}",
                common(&intl, "requestedBy", &[]),
                request.requested_by.display_name
            ),
        );
        if let Some(status) = request_status(kind, payload, &intl) {
            push(
                &mut body,
                format_args!("\n{}: {status}", common(&intl, "requestStatus", &[])),
            );
        }
    } else if let Some(comment) = &payload.comment {
        push(
            &mut body,
            format_args!(
                "\n\n{}:\n{}",
                common(
                    &intl,
                    "commentFrom",
                    &[("userName", &comment.user.display_name)]
                ),
                comment.message
            ),
        );
    } else if let Some(issue) = &payload.issue {
        push(
            &mut body,
            format_args!(
                "\n\n{}: {}",
                common(&intl, "reportedBy", &[]),
                issue.created_by.display_name
            ),
        );
        push(
            &mut body,
            format_args!(
                "\n{}: {}",
                common(&intl, "issueType", &[]),
                issue_type_name(issue.issue_type)
            ),
        );
        push(
            &mut body,
            format_args!(
                "\n{}: {}",
                common(&intl, "issueStatus", &[]),
                open_or_resolved(&intl, issue.status)
            ),
        );
    }
    for (name, value) in &payload.extra {
        push(&mut body, format_args!("\n{name}: {value}"));
    }
    body
}

fn pushbullet_payload(
    env: &Env,
    kind: Kind,
    payload: &Payload,
    locale: Option<&str>,
) -> Map<String, Value> {
    let title = payload.event.as_ref().map_or_else(
        || payload.subject.clone(),
        |e| format!("{e} - {}", payload.subject),
    );
    let mut out = Map::new();
    out.insert(
        String::from("type"),
        Value::from(if payload.watch_url.is_some() {
            "link"
        } else {
            "note"
        }),
    );
    out.insert(String::from("title"), Value::from(title));
    out.insert(
        String::from("body"),
        Value::from(plain_body(env, kind, payload, locale)),
    );
    insert_some(&mut out, "url", payload.watch_url.clone().map(Value::from));
    out
}

const PUSHBULLET: &str = "https://api.pushbullet.com/v2/pushes";

async fn pushbullet(env: Env, kind: Kind, payload: Arc<Payload>) -> Result<()> {
    let agent = env.agent("pushbullet");
    let token = text(&agent, "/options/accessToken");
    if system_wants(&agent, kind, &payload) && is_set(&agent, "/enabled") && !token.is_empty() {
        let mut body = pushbullet_payload(&env, kind, &payload, None);
        insert_some(
            &mut body,
            "channel_tag",
            opt(&agent, "/options/channelTag")
                .filter(|v| !v.is_null())
                .cloned(),
        );
        post(
            &env,
            PUSHBULLET,
            &Value::Object(body),
            &[(String::from("Access-Token"), token.clone())],
        )
        .await?;
    }
    if let Some(user) = &payload.notify_user {
        if let (Some(true), Some(s)) = (user.wants("pushbullet", kind), &user.settings) {
            if let Some(user_token) = s
                .pushbullet_token
                .as_deref()
                .filter(|t| !t.is_empty() && *t != token)
            {
                let body = pushbullet_payload(&env, kind, &payload, user.locale());
                post(
                    &env,
                    PUSHBULLET,
                    &Value::Object(body),
                    &[(String::from("Access-Token"), user_token.to_owned())],
                )
                .await?;
            }
        }
    }
    if payload.notify_admin {
        let channel = is_set(&agent, "/options/channelTag");
        for user in env.users().await? {
            if user.wants("pushbullet", kind) != Some(true)
                || !payload.admin_should_get(kind, &user)
            {
                continue;
            }
            let Some(user_token) = user
                .settings
                .as_ref()
                .and_then(|s| s.pushbullet_token.clone())
                .filter(|t| !t.is_empty())
            else {
                continue;
            };
            if channel || user_token != token {
                let body = pushbullet_payload(&env, kind, &payload, user.locale());
                if let Err(e) = post(
                    &env,
                    PUSHBULLET,
                    &Value::Object(body),
                    &[(String::from("Access-Token"), user_token)],
                )
                .await
                {
                    tracing::error!("pushbullet: {e:#}");
                }
            }
        }
    }
    Ok(())
}

// --------------------------------------------------------------- Pushover

async fn pushover_payload(
    env: &Env,
    kind: Kind,
    payload: &Payload,
    locale: Option<&str>,
) -> Map<String, Value> {
    let intl = env.intl(locale);
    let application_url = env.settings.str("/main/applicationUrl");
    let app_title = env.settings.str("/main/applicationTitle");
    let embed_poster = truthy(
        env.settings
            .get("/notifications/agents/pushover/embedPoster"),
    );
    let title = payload
        .event
        .clone()
        .unwrap_or_else(|| payload.subject.clone());
    let mut message = if payload.event.is_some() {
        format!("<b>{}</b>", payload.subject)
    } else {
        String::new()
    };
    let mut priority = 0;
    if let Some(m) = &payload.message {
        let sep = if message.is_empty() { "" } else { "\n" };
        push(&mut message, format_args!("<small>{sep}{m}</small>"));
    }
    if let Some(request) = &payload.request {
        push(
            &mut message,
            format_args!(
                "<small>\n\n<b>{}:</b> {}</small>",
                common(&intl, "requestedBy", &[]),
                request.requested_by.display_name
            ),
        );
        if matches!(kind, Kind::MediaDeclined | Kind::MediaFailed) {
            priority = 1;
        }
        if let Some(status) = request_status(kind, payload, &intl) {
            push(
                &mut message,
                format_args!(
                    "<small>\n<b>{}:</b> {status}</small>",
                    common(&intl, "requestStatus", &[])
                ),
            );
        }
    } else if let Some(comment) = &payload.comment {
        push(
            &mut message,
            format_args!(
                "<small>\n\n<b>{}:</b> {}</small>",
                common(
                    &intl,
                    "commentFrom",
                    &[("userName", &comment.user.display_name)]
                ),
                comment.message
            ),
        );
    } else if let Some(issue) = &payload.issue {
        push(
            &mut message,
            format_args!(
                "<small>\n\n<b>{}:</b> {}</small>",
                common(&intl, "reportedBy", &[]),
                issue.created_by.display_name
            ),
        );
        push(
            &mut message,
            format_args!(
                "<small>\n<b>{}:</b> {}</small>",
                common(&intl, "issueType", &[]),
                issue_type_name(issue.issue_type)
            ),
        );
        push(
            &mut message,
            format_args!(
                "<small>\n<b>{}:</b> {}</small>",
                common(&intl, "issueStatus", &[]),
                open_or_resolved(&intl, issue.status)
            ),
        );
        if kind == Kind::IssueCreated {
            priority = 1;
        }
    }
    for (name, value) in &payload.extra {
        push(
            &mut message,
            format_args!("<small>\n<b>{name}:</b> {value}</small>"),
        );
    }
    let url = payload.link(application_url);
    let mut out = Map::new();
    out.insert(String::from("title"), Value::from(title));
    out.insert(String::from("message"), Value::from(message));
    insert_some(&mut out, "url", url.clone().map(Value::from));
    insert_some(
        &mut out,
        "url_title",
        url.map(|_| Value::from(view_label(&intl, payload, app_title))),
    );
    out.insert(String::from("priority"), Value::from(priority));
    out.insert(String::from("html"), Value::from(1));
    if let (true, Some(image)) = (embed_poster, &payload.image) {
        if let Ok(response) = env
            .state
            .outbound
            .get(image)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
        {
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);
            if let (Ok(bytes), Some(content_type)) = (response.bytes().await, content_type) {
                if !bytes.is_empty() && !content_type.is_empty() {
                    out.insert(
                        String::from("attachment_base64"),
                        Value::from(BASE64_STANDARD.encode(bytes)),
                    );
                    out.insert(String::from("attachment_type"), Value::from(content_type));
                }
            }
        }
    }
    out
}

const PUSHOVER: &str = "https://api.pushover.net/1/messages.json";

/// A user's own Pushover keys reach someone the system send did not: they
/// are skipped only when both the app token and the user key match it.
fn pushover_distinct(ua: &str, uk: &str, app: &str, key: &str) -> bool {
    ua != app || uk != key
}

async fn pushover(env: Env, kind: Kind, payload: Arc<Payload>, gated: bool) -> Result<()> {
    let agent = env.agent("pushover");
    let (app, key) = (
        text(&agent, "/options/accessToken"),
        text(&agent, "/options/userToken"),
    );
    let system_keys = is_set(&agent, "/enabled") && !app.is_empty() && !key.is_empty();
    if gated && !system_keys {
        return Ok(());
    }
    if system_keys && system_wants(&agent, kind, &payload) {
        let mut body = pushover_payload(&env, kind, &payload, None).await;
        body.insert(String::from("token"), Value::from(app.as_str()));
        body.insert(String::from("user"), Value::from(key.as_str()));
        insert_some(
            &mut body,
            "sound",
            opt(&agent, "/options/sound")
                .filter(|v| !v.is_null())
                .cloned(),
        );
        post(&env, PUSHOVER, &Value::Object(body), &[]).await?;
    }
    if let Some(user) = &payload.notify_user {
        if let (Some(true), Some(s)) = (user.wants("pushover", kind), &user.settings) {
            if let (Some(ua), Some(uk)) = (
                s.pushover_app.as_deref().filter(|v| !v.is_empty()),
                s.pushover_key.as_deref().filter(|v| !v.is_empty()),
            ) {
                if pushover_distinct(ua, uk, &app, &key) {
                    let mut body = pushover_payload(&env, kind, &payload, user.locale()).await;
                    body.insert(String::from("token"), Value::from(ua));
                    body.insert(String::from("user"), Value::from(uk));
                    insert_some(
                        &mut body,
                        "sound",
                        s.pushover_sound.clone().map(Value::from),
                    );
                    post(&env, PUSHOVER, &Value::Object(body), &[]).await?;
                }
            }
        }
    }
    if payload.notify_admin {
        for user in env.users().await? {
            if user.wants("pushover", kind) != Some(true) || !payload.admin_should_get(kind, &user)
            {
                continue;
            }
            let Some(s) = &user.settings else { continue };
            if let (Some(ua), Some(uk)) = (
                s.pushover_app.as_deref().filter(|v| !v.is_empty()),
                s.pushover_key.as_deref().filter(|v| !v.is_empty()),
            ) {
                if pushover_distinct(ua, uk, &app, &key) {
                    let mut body = pushover_payload(&env, kind, &payload, user.locale()).await;
                    body.insert(String::from("token"), Value::from(ua));
                    body.insert(String::from("user"), Value::from(uk));
                    if let Err(e) = post(&env, PUSHOVER, &Value::Object(body), &[]).await {
                        tracing::error!("pushover: {e:#}");
                    }
                }
            }
        }
    }
    Ok(())
}

// ----------------------------------------------------------------- Gotify

async fn gotify(env: Env, kind: Kind, payload: Arc<Payload>, gated: bool) -> Result<()> {
    let agent = env.agent("gotify");
    let priority = opt(&agent, "/options/priority");
    let configured = is_set(&agent, "/enabled")
        && is_set(&agent, "/options/url")
        && is_set(&agent, "/options/token")
        && priority.is_some();
    if (gated && !configured) || !system_wants(&agent, kind, &payload) {
        return Ok(());
    }
    let intl = env.intl(Some(&text(&agent, "/options/locale")));
    let application_url = env.settings.str("/main/applicationUrl");
    let app_title = env.settings.str("/main/applicationTitle");
    let embed_poster = is_set(&agent, "/embedPoster");
    let title = payload.event.as_ref().map_or_else(
        || payload.subject.clone(),
        |e| format!("{e} - {}", payload.subject),
    );
    let mut message = payload
        .message
        .as_ref()
        .map_or_else(String::new, |m| format!("{m}  \n\n"));
    if let Some(request) = &payload.request {
        push(
            &mut message,
            format_args!(
                "\n**{}:** {}  ",
                common(&intl, "requestedBy", &[]),
                request.requested_by.display_name
            ),
        );
        if let Some(status) = request_status(kind, &payload, &intl) {
            push(
                &mut message,
                format_args!("\n**{}:** {status}  ", common(&intl, "requestStatus", &[])),
            );
        }
    } else if let Some(comment) = &payload.comment {
        push(
            &mut message,
            format_args!(
                "\n{}:\n{}  ",
                common(
                    &intl,
                    "commentFrom",
                    &[("userName", &comment.user.display_name)]
                ),
                comment.message
            ),
        );
    } else if let Some(issue) = &payload.issue {
        push(
            &mut message,
            format_args!(
                "\n\n**{}:** {}  ",
                common(&intl, "reportedBy", &[]),
                issue.created_by.display_name
            ),
        );
        push(
            &mut message,
            format_args!(
                "\n**{}:** {}  ",
                common(&intl, "issueType", &[]),
                issue_type_name(issue.issue_type)
            ),
        );
        push(
            &mut message,
            format_args!(
                "\n**{}:** {}  ",
                common(&intl, "issueStatus", &[]),
                open_or_resolved(&intl, issue.status)
            ),
        );
    }
    for (name, value) in &payload.extra {
        push(&mut message, format_args!("\n\n**{name}**\n{value}  "));
    }
    if let (true, Some(image)) = (embed_poster, &payload.image) {
        push(&mut message, format_args!("\n\n![]({image})  "));
    }
    if (!application_url.is_empty() && payload.media.is_some()) || payload.watch_url.is_some() {
        let action = payload.watch_url.clone().unwrap_or_else(|| {
            let m = payload.media.as_ref();
            format!(
                "{application_url}/{}/{}",
                m.map_or("undefined", |m| m.media_type.as_str()),
                m.map_or_else(|| String::from("undefined"), |m| m.tmdb_id.to_string())
            )
        });
        let units: Vec<u16> = action.encode_utf16().collect();
        let display = if units.len() > 40 {
            format!(
                "{}...",
                String::from_utf16_lossy(units.get(..41).unwrap_or(&units))
            )
        } else {
            action.clone()
        };
        push(
            &mut message,
            format_args!(
                "\n\n**{}:** [{display}]({action})  ",
                common(&intl, "openIn", &[("applicationTitle", app_title)])
            ),
        );
    }
    let mut extras = Map::new();
    let mut display = Map::new();
    display.insert(String::from("contentType"), Value::from("text/markdown"));
    extras.insert(String::from("client::display"), Value::Object(display));
    if let (true, Some(image)) = (embed_poster, &payload.image) {
        let mut notification = Map::new();
        notification.insert(String::from("bigImageUrl"), Value::from(image.as_str()));
        extras.insert(
            String::from("client::notification"),
            Value::Object(notification),
        );
    }
    let mut body = Map::new();
    body.insert(String::from("extras"), Value::Object(extras));
    body.insert(String::from("title"), Value::from(title));
    body.insert(String::from("message"), Value::from(message));
    body.insert(
        String::from("priority"),
        priority
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| Value::from(1)),
    );
    let endpoint = format!(
        "{}/message?token={}",
        template(&agent, "/options/url"),
        template(&agent, "/options/token")
    );
    post(&env, &endpoint, &Value::Object(body), &[]).await
}

// ------------------------------------------------------------------- ntfy

/// `escapeMarkdown`.
fn ntfy_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if "\\`*_{}[]()#+-.!|>~<".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

async fn ntfy(env: Env, kind: Kind, payload: Arc<Payload>, gated: bool) -> Result<()> {
    let agent = env.agent("ntfy");
    let configured = is_set(&agent, "/enabled")
        && is_set(&agent, "/options/url")
        && is_set(&agent, "/options/topic");
    if (gated && !configured) || !system_wants(&agent, kind, &payload) {
        return Ok(());
    }
    let intl = env.intl(Some(&text(&agent, "/options/locale")));
    let application_url = env.settings.str("/main/applicationUrl");
    let title = payload.event.as_ref().map_or_else(
        || payload.subject.clone(),
        |e| format!("{e} - {}", payload.subject),
    );
    let mut message = payload.message.clone().unwrap_or_default();
    if let Some(request) = &payload.request {
        let sep = if message.is_empty() { "" } else { "\n\n" };
        push(
            &mut message,
            format_args!(
                "{sep}**{}:** {}",
                common(&intl, "requestedBy", &[]),
                ntfy_escape(&request.requested_by.display_name)
            ),
        );
        if let Some(status) = request_status(kind, &payload, &intl) {
            push(
                &mut message,
                format_args!("\n**{}:** {status}", common(&intl, "requestStatus", &[])),
            );
        }
    } else if let Some(comment) = &payload.comment {
        push(
            &mut message,
            format_args!(
                "\n**{}:**\n{}",
                ntfy_escape(&common(
                    &intl,
                    "commentFrom",
                    &[("userName", &comment.user.display_name)]
                )),
                comment.message
            ),
        );
    } else if let Some(issue) = &payload.issue {
        push(
            &mut message,
            format_args!(
                "\n\n**{}:** {}",
                common(&intl, "reportedBy", &[]),
                ntfy_escape(&issue.created_by.display_name)
            ),
        );
        push(
            &mut message,
            format_args!(
                "\n**{}:** {}",
                common(&intl, "issueType", &[]),
                issue_type_name(issue.issue_type)
            ),
        );
        push(
            &mut message,
            format_args!(
                "\n**{}:** {}",
                common(&intl, "issueStatus", &[]),
                open_or_resolved(&intl, issue.status)
            ),
        );
    }
    for (name, value) in &payload.extra {
        push(&mut message, format_args!("\n\n**{name}**\n{value}"));
    }
    let mut body = Map::new();
    // `topic: settings.options.topic`: an absent one is left out.
    insert_some(&mut body, "topic", opt(&agent, "/options/topic").cloned());
    body.insert(
        String::from("priority"),
        opt(&agent, "/options/priority")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| Value::from(3)),
    );
    body.insert(String::from("title"), Value::from(title));
    body.insert(String::from("message"), Value::from(message));
    body.insert(String::from("markdown"), Value::Bool(true));
    if let Some(Value::String(tags)) = opt(&agent, "/options/tags") {
        let tags: Vec<Value> = tags
            .split(',')
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(Value::from)
            .collect();
        if !tags.is_empty() {
            body.insert(String::from("tags"), Value::Array(tags));
        }
    }
    if is_set(&agent, "/embedPoster") {
        if let Some(image) = payload.image.as_ref().filter(|i| !i.is_empty()) {
            body.insert(String::from("attach"), Value::from(image.as_str()));
        }
    }
    let click = payload
        .watch_url
        .clone()
        .filter(|u| !u.is_empty())
        .or_else(|| {
            (!application_url.is_empty())
                .then(|| {
                    payload
                        .media
                        .as_ref()
                        .map(|m| format!("{application_url}/{}/{}", m.media_type, m.tmdb_id))
                })
                .flatten()
        });
    insert_some(&mut body, "click", click.map(Value::from));
    let mut headers = Vec::new();
    if is_set(&agent, "/options/authMethodUsernamePassword")
        && is_set(&agent, "/options/username")
        && is_set(&agent, "/options/password")
    {
        let pair = format!(
            "{}:{}",
            text(&agent, "/options/username"),
            text(&agent, "/options/password")
        );
        headers.push((
            String::from("Authorization"),
            format!("Basic {}", BASE64_STANDARD.encode(pair)),
        ));
    } else if is_set(&agent, "/options/authMethodToken") {
        headers.push((
            String::from("Authorization"),
            format!("Bearer {}", text(&agent, "/options/token")),
        ));
    }
    post(
        &env,
        &text(&agent, "/options/url"),
        &Value::Object(body),
        &headers,
    )
    .await
}

// ---------------------------------------------------------------- Webhook

/// `MediaStatus[n]`.
const fn media_status_name(status: i64) -> &'static str {
    match status {
        1 => "UNKNOWN",
        2 => "PENDING",
        3 => "PROCESSING",
        4 => "PARTIALLY_AVAILABLE",
        5 => "AVAILABLE",
        6 => "BLOCKLISTED",
        7 => "DELETED",
        _ => "undefined",
    }
}

/// The webhook's `KeyMap`, in order: each variable's value, as the string
/// `replace` would insert. `None` is lodash `get` finding nothing.
fn keymap(kind: Kind, p: &Payload) -> Vec<(&'static str, Option<String>)> {
    let person = |u: Option<&Person>, f: fn(&Person) -> Option<String>| u.and_then(f);
    let name = |u: &Person| Some(u.display_name.clone());
    let email = |u: &Person| Some(u.email.clone());
    let avatar = |u: &Person| Some(u.avatar.clone());
    let discord = |u: &Person| u.settings.as_ref().map(|s| s.discord_ids.join(","));
    let telegram = |u: &Person| u.settings.as_ref().and_then(|s| s.telegram_chat_id.clone());
    let requested = p.request.as_ref().map(|r| &r.requested_by);
    let reported = p.issue.as_ref().map(|i| &i.created_by);
    let commenter = p.comment.as_ref().map(|c| &c.user);
    let notify = p.notify_user.as_ref();
    let media = p.media.as_ref();
    vec![
        ("notification_type", Some(kind.name().to_owned())),
        ("event", p.event.clone()),
        ("subject", Some(p.subject.clone())),
        ("message", p.message.clone()),
        ("image", p.image.clone()),
        ("notifyuser_username", person(notify, name)),
        ("notifyuser_email", person(notify, email)),
        ("notifyuser_avatar", person(notify, avatar)),
        ("notifyuser_settings_discordIds", person(notify, discord)),
        (
            "notifyuser_settings_telegramChatId",
            person(notify, telegram),
        ),
        ("media_imdbid", media.and_then(|m| m.imdb_id.clone())),
        ("media_tmdbid", media.map(|m| m.tmdb_id.to_string())),
        (
            "media_tvdbid",
            media.and_then(|m| m.tvdb_id.map(|v| v.to_string())),
        ),
        ("media_type", media.map(|m| m.media_type.clone())),
        (
            "media_jellyfinMediaId",
            Some(
                media
                    .and_then(|m| {
                        m.jellyfin_media_id
                            .clone()
                            .or_else(|| m.jellyfin_media_id4k.clone())
                    })
                    .unwrap_or_default(),
            ),
        ),
        (
            "media_status",
            Some(media.map_or("", |m| media_status_name(m.status)).to_owned()),
        ),
        (
            "media_status4k",
            Some(
                media
                    .map_or("", |m| media_status_name(m.status4k))
                    .to_owned(),
            ),
        ),
        (
            "media_plexRatingKey",
            Some(media.and_then(|m| m.rating_key.clone()).unwrap_or_default()),
        ),
        (
            "media_plexRatingKey4k",
            Some(
                media
                    .and_then(|m| m.rating_key4k.clone())
                    .unwrap_or_default(),
            ),
        ),
        ("request_id", p.request.as_ref().map(|r| r.id.to_string())),
        (
            "requestedBy_jellyfinUserId",
            requested.and_then(|u| u.jellyfin_user_id.clone()),
        ),
        ("requestedBy_username", person(requested, name)),
        ("requestedBy_email", person(requested, email)),
        ("requestedBy_avatar", person(requested, avatar)),
        (
            "requestedBy_settings_discordIds",
            person(requested, discord),
        ),
        (
            "requestedBy_settings_telegramChatId",
            person(requested, telegram),
        ),
        ("issue_id", p.issue.as_ref().map(|i| i.id.to_string())),
        (
            "issue_type",
            Some(
                p.issue
                    .as_ref()
                    .map_or("", |i| match i.issue_type {
                        1 => "VIDEO",
                        2 => "AUDIO",
                        3 => "SUBTITLES",
                        4 => "OTHER",
                        _ => "undefined",
                    })
                    .to_owned(),
            ),
        ),
        (
            "issue_status",
            Some(
                p.issue
                    .as_ref()
                    .map_or("", |i| match i.status {
                        1 => "OPEN",
                        2 => "RESOLVED",
                        _ => "undefined",
                    })
                    .to_owned(),
            ),
        ),
        ("reportedBy_username", person(reported, name)),
        ("reportedBy_email", person(reported, email)),
        ("reportedBy_avatar", person(reported, avatar)),
        ("reportedBy_settings_discordIds", person(reported, discord)),
        (
            "reportedBy_settings_telegramChatId",
            person(reported, telegram),
        ),
        (
            "comment_message",
            p.comment.as_ref().map(|c| c.message.clone()),
        ),
        ("commentedBy_username", person(commenter, name)),
        ("commentedBy_email", person(commenter, email)),
        ("commentedBy_avatar", person(commenter, avatar)),
        (
            "commentedBy_settings_discordIds",
            person(commenter, discord),
        ),
        (
            "commentedBy_settings_telegramChatId",
            person(commenter, telegram),
        ),
    ]
}

/// `String.prototype.replace` with a string pattern: the first match, with
/// the replacement's `$$`, `$&`, `` $` `` and `$'` patterns.
fn js_replace_first(haystack: &str, needle: &str, replacement: &str) -> String {
    let Some(at) = haystack.find(needle) else {
        return haystack.to_owned();
    };
    let (before, rest) = haystack.split_at(at);
    let after = rest.get(needle.len()..).unwrap_or("");
    let mut expanded = String::with_capacity(replacement.len());
    let mut chars = replacement.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '$' {
            match chars.peek() {
                Some('$') => {
                    expanded.push('$');
                    chars.next();
                }
                Some('&') => {
                    expanded.push_str(needle);
                    chars.next();
                }
                Some('`') => {
                    expanded.push_str(before);
                    chars.next();
                }
                Some('\'') => {
                    expanded.push_str(after);
                    chars.next();
                }
                _ => expanded.push('$'),
            }
        } else {
            expanded.push(c);
        }
    }
    format!("{before}{expanded}{after}")
}

/// `parseKeys`.
fn parse_keys(value: Value, p: &Payload, map: &[(&str, Option<String>)]) -> Value {
    match value {
        Value::Object(object) => {
            let mut out = Map::new();
            for (key, v) in object {
                let (key, v) = match key.as_str() {
                    "{{extra}}" => (
                        String::from("extra"),
                        Value::Array(
                            p.extra
                                .iter()
                                .map(|(n, v)| {
                                    let mut e = Map::new();
                                    e.insert(String::from("name"), Value::from(n.as_str()));
                                    e.insert(String::from("value"), Value::from(v.as_str()));
                                    Value::Object(e)
                                })
                                .collect(),
                        ),
                    ),
                    "{{media}}" => (
                        String::from("media"),
                        if p.media.is_some() { v } else { Value::Null },
                    ),
                    "{{request}}" => (
                        String::from("request"),
                        if p.request.is_some() { v } else { Value::Null },
                    ),
                    "{{issue}}" => (
                        String::from("issue"),
                        if p.issue.is_some() { v } else { Value::Null },
                    ),
                    "{{comment}}" => (
                        String::from("comment"),
                        if p.comment.is_some() { v } else { Value::Null },
                    ),
                    _ => (key, v),
                };
                out.insert(key, parse_keys(v, p, map));
            }
            Value::Object(out)
        }
        Value::Array(items) => {
            Value::Array(items.into_iter().map(|v| parse_keys(v, p, map)).collect())
        }
        Value::String(mut s) => {
            for (name, value) in map {
                s = js_replace_first(
                    &s,
                    &format!("{{{{{name}}}}}"),
                    value.as_deref().unwrap_or(""),
                );
            }
            Value::String(s)
        }
        other @ (Value::Null | Value::Bool(_) | Value::Number(_)) => other,
    }
}

async fn webhook(env: Env, kind: Kind, payload: Arc<Payload>) -> Result<()> {
    let agent = env.agent("webhook");
    let configured = is_set(&agent, "/enabled") && is_set(&agent, "/options/webhookUrl");
    if !configured || !system_wants(&agent, kind, &payload) {
        return Ok(());
    }
    let map = keymap(kind, &payload);
    let mut url = text(&agent, "/options/webhookUrl");
    if is_set(&agent, "/options/supportVariables") {
        for (name, value) in &map {
            let value = if kind == Kind::Test {
                String::from("test")
            } else {
                value
                    .clone()
                    .filter(|v| !v.is_empty())
                    .unwrap_or_else(|| String::from("test"))
            };
            url = url.replace(
                &format!("{{{{{name}}}}}"),
                &crate::ratings::encode_uri_component(&value),
            );
        }
    }
    let template = BASE64_STANDARD
        .decode(text(&agent, "/options/jsonPayload"))
        .context("jsonPayload base64")?;
    let inner: String = serde_json::from_slice(&template).context("jsonPayload")?;
    let parsed: Value = serde_json::from_str(&inner).context("jsonPayload")?;
    let mut body = parse_keys(parsed, &payload, &map);
    if let (Value::Object(object), Some(watch)) = (&mut body, &payload.watch_url) {
        object.insert(String::from("watchUrl"), Value::from(watch.as_str()));
    }
    let mut headers: Vec<(String, String)> = Vec::new();
    let auth = text(&agent, "/options/authHeader");
    if !auth.is_empty() {
        headers.push((String::from("Authorization"), auth.clone()));
    }
    if let Some(Value::Array(custom)) = opt(&agent, "/options/customHeaders") {
        for header in custom {
            let key = header
                .get("key")
                .and_then(Value::as_str)
                .map_or("", str::trim);
            let value = header
                .get("value")
                .and_then(Value::as_str)
                .map_or("", str::trim);
            let is_auth = key.eq_ignore_ascii_case("authorization");
            let allowed = auth.is_empty() || !is_auth;
            if !key.is_empty() && !value.is_empty() && allowed {
                headers.retain(|(k, _)| k != key);
                headers.push((key.to_owned(), value.to_owned()));
            }
        }
    }
    post(&env, &url, &body, &headers).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replace_like_javascript() {
        assert_eq!(
            js_replace_first("a {{x}} b {{x}}", "{{x}}", "1"),
            "a 1 b {{x}}",
            "first only"
        );
        assert_eq!(
            js_replace_first("{{x}}", "{{x}}", "$$ and $&"),
            "$ and {{x}}",
            "patterns"
        );
        assert!(snowflake("123456789012345678"), "18 digits");
        assert!(!snowflake("12345"), "short");
        assert_eq!(telegram_escape("a.b-c!"), "a\\.b\\-c\\!", "markdown v2");
    }

    #[test]
    fn telegram_escapes_backticks_and_backslashes() {
        assert_eq!(telegram_escape("`a\\b`"), "\\`a\\\\b\\`", "markdown v2");
        assert_eq!(
            telegram_escape_url("http://x/a_(b)\\c"),
            "http://x/a_(b\\)\\\\c",
            "link url"
        );
    }

    #[test]
    fn pushover_dedupes_only_the_system_recipient() {
        assert!(!pushover_distinct("app", "key", "app", "key"), "same keys");
        assert!(
            pushover_distinct("app", "other", "app", "key"),
            "shared app"
        );
        assert!(pushover_distinct("own", "key", "app", "key"), "own app");
        assert!(pushover_distinct("own", "other", "app", "key"), "both own");
    }
}
