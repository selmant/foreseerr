//! Notification agent settings and test notifications.
//!
//! From `server/routes/settings/notifications.ts` (behind
//! `isAuthenticated(Permission.ADMIN)`): saving each agent's
//! section, sending a test notification through an agent built from the
//! submitted settings, and the Pushover sound list from
//! `server/routes/index.ts` (any signed-in user).
//!
//! Node's `agent.send()` skips the `shouldSend()` gate the Rust agents
//! start with. Agents whose `send` ignores `enabled` are run with it set;
//! when the rest of the gate (a webhook URL, a bot token...) would still
//! stop the Rust agent, the agent runs without it, as Node's `send` does.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use axum::http::Method;
use base64::prelude::*;
use serde_json::{Map, Value};

use super::settings_util::{body_undefined, conforms, json_body, Ty};
use super::{Outcome, Ready, Table, ADMIN};
use crate::notify::{agents, Env, Kind, Payload, Person};
use crate::settings::public::truthy;
use crate::tmdb::{axios_encode, js_numbers};

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

macro_rules! try_forward {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(why) => return Outcome::forward(why),
        }
    };
}

/// One notification agent: its settings key, its spec, its index in
/// [`agents::ALL`] and the error a failed test reports.
#[derive(Debug, Clone, Copy)]
struct Agent {
    name: &'static str,
    schema: &'static [(&'static str, Ty)],
    index: usize,
    failure: &'static str,
    gate: Gate,
}

/// What the Rust agent checks before sending that Node's `send` doesn't.
#[derive(Debug, Clone, Copy)]
enum Gate {
    /// `send` ignores `enabled`; the other options must be truthy.
    Options(&'static [&'static str]),
    /// Gotify: URL and token truthy, priority present.
    Gotify,
    /// `send` checks the whole gate for the system part only, then goes
    /// on to the user: the gate must pass as it is.
    AsIs(&'static [&'static str]),
    /// No gate.
    None,
}

const BASE: [(&str, Ty); 2] = [("enabled", Ty::Bool), ("types", Ty::Num)];

macro_rules! schema {
    ($($opt:expr),* $(,)?) => {
        &[BASE[0], BASE[1], ("options", Ty::Obj(&[$($opt),*]))]
    };
}

const DISCORD: Agent = Agent {
    name: "discord",
    schema: schema![
        ("botUsername", Ty::Str),
        ("botAvatarUrl", Ty::Str),
        ("webhookUrl", Ty::Str),
        ("webhookRoleId", Ty::Str),
        ("enableMentions", Ty::Bool),
    ],
    index: 0,
    failure: "Failed to send Discord notification.",
    gate: Gate::Options(&["webhookUrl"]),
};
const EMAIL: Agent = Agent {
    name: "email",
    schema: schema![
        ("emailFrom", Ty::Str),
        ("senderName", Ty::Str),
        ("smtpHost", Ty::Str),
        ("smtpPort", Ty::Num),
        ("secure", Ty::Bool),
        ("ignoreTls", Ty::Bool),
        ("requireTls", Ty::Bool),
        ("authUser", Ty::NullStr),
        ("authPass", Ty::NullStr),
        ("allowSelfSigned", Ty::Bool),
    ],
    index: 1,
    failure: "Failed to send email notification.",
    gate: Gate::Options(&["emailFrom", "smtpHost", "smtpPort"]),
};
const WEBPUSH: Agent = Agent {
    name: "webpush",
    schema: &[BASE[0], BASE[1]],
    index: 2,
    failure: "Failed to send web push notification.",
    gate: Gate::Options(&[]),
};
const GOTIFY: Agent = Agent {
    name: "gotify",
    schema: schema![("url", Ty::Str), ("token", Ty::Str)],
    index: 3,
    failure: "Failed to send Gotify notification.",
    gate: Gate::Gotify,
};
const NTFY: Agent = Agent {
    name: "ntfy",
    schema: schema![
        ("url", Ty::Str),
        ("topic", Ty::Str),
        ("tags", Ty::Str),
        ("authMethodUsernamePassword", Ty::Bool),
        ("username", Ty::Str),
        ("password", Ty::Str),
        ("authMethodToken", Ty::Bool),
        ("token", Ty::Str),
        ("priority", Ty::Num),
        ("locale", Ty::Str),
    ],
    index: 4,
    failure: "Failed to send ntfy notification.",
    gate: Gate::Options(&["url", "topic"]),
};
const PUSHBULLET: Agent = Agent {
    name: "pushbullet",
    schema: schema![("accessToken", Ty::Str), ("channelTag", Ty::NullStr)],
    index: 5,
    failure: "Failed to send Pushbullet notification.",
    gate: Gate::None,
};
const PUSHOVER: Agent = Agent {
    name: "pushover",
    schema: schema![
        ("accessToken", Ty::Str),
        ("userToken", Ty::Str),
        ("sound", Ty::Str),
    ],
    index: 6,
    failure: "Failed to send Pushover notification.",
    gate: Gate::AsIs(&["accessToken", "userToken"]),
};
const SLACK: Agent = Agent {
    name: "slack",
    schema: schema![("webhookUrl", Ty::Str)],
    index: 7,
    failure: "Failed to send Slack notification.",
    gate: Gate::Options(&["webhookUrl"]),
};
const TELEGRAM: Agent = Agent {
    name: "telegram",
    schema: schema![
        ("botUsername", Ty::Str),
        ("botAPI", Ty::Str),
        ("chatId", Ty::Str),
        ("messageThreadId", Ty::Str),
        ("sendSilently", Ty::Bool),
    ],
    index: 8,
    failure: "Failed to send Telegram notification.",
    gate: Gate::Options(&["botAPI"]),
};
const WEBHOOK: Agent = Agent {
    name: "webhook",
    schema: schema![
        ("webhookUrl", Ty::Str),
        ("authHeader", Ty::Str),
        ("jsonPayload", Ty::Str),
        ("supportVariables", Ty::Bool),
    ],
    index: 9,
    failure: "Failed to send webhook notification.",
    gate: Gate::Options(&["webhookUrl"]),
};

macro_rules! agent_routes {
    ($save:ident, $test:ident, $agent:expr) => {
        fn $save<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
            Box::pin(save(ctx, $agent))
        }
        fn $test<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
            Box::pin(test(ctx, $agent))
        }
    };
}

agent_routes!(discord_save, discord_test, DISCORD);
agent_routes!(email_save, email_test, EMAIL);
agent_routes!(webpush_save, webpush_test, WEBPUSH);
agent_routes!(gotify_save, gotify_test, GOTIFY);
agent_routes!(ntfy_save, ntfy_test, NTFY);
agent_routes!(pushbullet_save, pushbullet_test, PUSHBULLET);
agent_routes!(pushover_save, pushover_test, PUSHOVER);
agent_routes!(slack_save, slack_test, SLACK);
agent_routes!(telegram_save, telegram_test, TELEGRAM);

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    (
        "/api/v1/settings/notifications/discord",
        Method::POST,
        discord_save,
    ),
    (
        "/api/v1/settings/notifications/discord/test",
        Method::POST,
        discord_test,
    ),
    (
        "/api/v1/settings/notifications/email",
        Method::POST,
        email_save,
    ),
    (
        "/api/v1/settings/notifications/email/test",
        Method::POST,
        email_test,
    ),
    (
        "/api/v1/settings/notifications/webpush",
        Method::POST,
        webpush_save,
    ),
    (
        "/api/v1/settings/notifications/webpush/test",
        Method::POST,
        webpush_test,
    ),
    (
        "/api/v1/settings/notifications/gotify",
        Method::POST,
        gotify_save,
    ),
    (
        "/api/v1/settings/notifications/gotify/test",
        Method::POST,
        gotify_test,
    ),
    (
        "/api/v1/settings/notifications/ntfy",
        Method::POST,
        ntfy_save,
    ),
    (
        "/api/v1/settings/notifications/ntfy/test",
        Method::POST,
        ntfy_test,
    ),
    (
        "/api/v1/settings/notifications/pushbullet",
        Method::POST,
        pushbullet_save,
    ),
    (
        "/api/v1/settings/notifications/pushbullet/test",
        Method::POST,
        pushbullet_test,
    ),
    (
        "/api/v1/settings/notifications/pushover",
        Method::POST,
        pushover_save,
    ),
    (
        "/api/v1/settings/notifications/pushover/test",
        Method::POST,
        pushover_test,
    ),
    (
        "/api/v1/settings/notifications/pushover/sounds",
        Method::GET,
        pushover_sounds,
    ),
    (
        "/api/v1/settings/notifications/slack",
        Method::POST,
        slack_save,
    ),
    (
        "/api/v1/settings/notifications/slack/test",
        Method::POST,
        slack_test,
    ),
    (
        "/api/v1/settings/notifications/telegram",
        Method::POST,
        telegram_save,
    ),
    (
        "/api/v1/settings/notifications/telegram/test",
        Method::POST,
        telegram_test,
    ),
    (
        "/api/v1/settings/notifications/webhook",
        Method::POST,
        webhook_save,
    ),
    (
        "/api/v1/settings/notifications/webhook/test",
        Method::POST,
        webhook_test,
    ),
];

/// The admin check and the body every route here needs, checked against
/// the agent's spec (numbers normalised as JavaScript holds them).
fn admin_body(ctx: &Ready<'_>, agent: Agent) -> Result<Value, super::Fallback> {
    ctx.no_query()?;
    ctx.authenticated(ADMIN)?;
    let body = json_body(ctx)?;
    if !conforms(body, agent.schema, &[]) {
        return Err(String::from("a body the validator may reject").into());
    }
    Ok(js_numbers(body.clone()))
}

/// The settings document with one agent section replaced.
fn with_agent(ctx: &Ready<'_>, name: &str, section: Value) -> Option<Value> {
    let mut data = super::settings_util::node_memory(ctx);
    data.pointer_mut("/notifications/agents")?
        .as_object_mut()?
        .insert(name.to_owned(), section);
    Some(data)
}

/// Save one agent section and answer with it.
async fn store(ctx: &Ready<'_>, name: &str, section: Value) -> Outcome {
    let Some(data) = with_agent(ctx, name, section.clone()) else {
        return Outcome::forward(String::from("notifications.agents is not an object"));
    };
    if let Err(e) = ctx.save_settings(&data).await {
        return Outcome::forward(format!("saving settings failed: {e:#}"));
    }
    ctx.json(&section)
}

/// `POST /settings/notifications/{agent}`: the body replaces the section.
async fn save(ctx: &Ready<'_>, agent: Agent) -> Outcome {
    if body_undefined(ctx) {
        try_forward!(admin_only(ctx));
        return drop_agent(ctx, agent.name).await;
    }
    let body = try_forward!(admin_body(ctx, agent));
    store(ctx, agent.name, body).await
}

/// The query and admin checks of [`admin_body`] alone.
fn admin_only(ctx: &Ready<'_>) -> Result<(), super::Fallback> {
    ctx.no_query()?;
    ctx.authenticated(ADMIN).map(|_| ())
}

/// The section set to `undefined`: `settings.json` loses the key and
/// `res.json(undefined)` sends an empty JSON answer.
async fn drop_agent(ctx: &Ready<'_>, name: &str) -> Outcome {
    let mut data = super::settings_util::node_memory(ctx);
    let Some(agents) = data
        .pointer_mut("/notifications/agents")
        .and_then(Value::as_object_mut)
    else {
        return Outcome::forward(String::from("notifications.agents is not an object"));
    };
    agents.shift_remove(name);
    if let Err(e) = ctx.save_settings(&data).await {
        return Outcome::forward(format!("saving settings failed: {e:#}"));
    }
    super::empty_json()
}

/// `sendTestNotification`'s recipient: the signed-in user as loaded.
async fn recipient(ctx: &Ready<'_>) -> Result<Person, super::Fallback> {
    let user = ctx.authenticated(ADMIN)?;
    match ctx.state.db.user_record(user.id).await {
        Ok(Some((record, settings))) => Ok(Person::from_records(&record, settings.as_ref())),
        Ok(None) => Err(String::from("the user vanished").into()),
        Err(e) => Err(format!("loading the user failed: {e:#}").into()),
    }
}

/// Whether the Rust agent's gate passes for these settings (after
/// `enabled` is set where `send` ignores it).
fn gate_passes(gate: Gate, section: &mut Value) -> bool {
    let option = |s: &Value, key: &str| truthy(s.pointer(&format!("/options/{key}")));
    match gate {
        Gate::None => true,
        Gate::AsIs(keys) => {
            truthy(section.get("enabled")) && keys.iter().all(|k| option(section, k))
        }
        Gate::Options(keys) => {
            if let Some(object) = section.as_object_mut() {
                object.insert(String::from("enabled"), Value::Bool(true));
            }
            keys.iter().all(|k| option(section, k))
        }
        Gate::Gotify => {
            if let Some(object) = section.as_object_mut() {
                object.insert(String::from("enabled"), Value::Bool(true));
            }
            option(section, "url")
                && option(section, "token")
                && section.pointer("/options/priority").is_some()
        }
    }
}

/// Whether Node's `agent.send()` fails for a test where the Rust agent's
/// gate (its `shouldSend`) fails, before anything else: the test
/// notification always passes the type check, so the webhook-style agents
/// post to the missing URL and fail. The other agents' `send` goes on
/// without the gate ([`agents::send_ungated`], and the email test path,
/// which never had one).
fn gate_fails_send(agent: Agent) -> bool {
    matches!(agent.name, "discord" | "slack" | "webhook")
}

/// Run the test notification through `agent` with `section` as its
/// settings.
async fn send_test(ctx: &Ready<'_>, agent: Agent, mut section: Value) -> Outcome {
    let person = try_forward!(recipient(ctx).await);
    let gated = gate_passes(agent.gate, &mut section);
    if !gated && gate_fails_send(agent) {
        tracing::error!("{}", agent.failure);
        return ctx.error(500, agent.failure);
    }
    let Some(data) = with_agent(ctx, agent.name, section) else {
        return Outcome::forward(String::from("notifications.agents is not an object"));
    };
    let settings = Arc::new(ctx.settings.with_data(data));
    let intl = crate::i18n::Intl::new(person.locale(), settings.str("/main/locale"));
    let payload = Payload {
        subject: intl.format("notifications.test.subject", &[]),
        message: Some(intl.format("notifications.test.message", &[])),
        notify_system: true,
        notify_admin: false,
        notify_user: Some(person),
        ..Payload::default()
    };
    let result = if agent.index == EMAIL.index {
        email(&settings, &payload).await
    } else {
        let env = Env {
            state: Arc::clone(&ctx.shared),
            settings,
        };
        let payload = Arc::new(payload);
        if gated {
            let Some(run) = agents::ALL.get(agent.index) else {
                return Outcome::forward(String::from("no such agent"));
            };
            run(env, Kind::Test, payload).await
        } else {
            match agents::send_ungated(agent.name, env, Kind::Test, payload).await {
                Some(result) => result,
                None => {
                    return Outcome::forward(String::from(
                        "this notification agent is not configured to send",
                    ))
                }
            }
        }
    };
    match result {
        Ok(()) => Ready::no_content(),
        Err(e) => {
            tracing::error!("{} {e:#}", agent.failure);
            ctx.error(500, agent.failure)
        }
    }
}

/// `EmailAgent.send` for the test notification: only the user gets mail,
/// and a failed send is reported (the shared agent only logs it).
async fn email(settings: &crate::settings::Settings, payload: &Payload) -> anyhow::Result<()> {
    let Some(user) = &payload.notify_user else {
        return Ok(());
    };
    if !crate::email::is_email(&user.email) {
        tracing::warn!(
            "Invalid email address provided for user {}",
            user.display_name
        );
        return Ok(());
    }
    let frame = crate::email::Frame::new(settings, &user.email, &user.display_name);
    let rendered =
        crate::email::test_email(&frame, payload.message.as_deref().unwrap_or("undefined"));
    let pgp = user.settings.as_ref().and_then(|s| s.pgp_key.as_deref());
    crate::email::send(settings, &user.email, &rendered, pgp).await
}

/// `POST /settings/notifications/{agent}/test`.
async fn test(ctx: &Ready<'_>, agent: Agent) -> Outcome {
    if body_undefined(ctx) {
        // `new Agent(undefined)` falls back to the saved section.
        try_forward!(admin_only(ctx));
        let Some(saved) = ctx
            .settings
            .get(&format!("/notifications/agents/{}", agent.name))
            .cloned()
        else {
            return Outcome::forward(String::from("no saved section"));
        };
        return send_test(ctx, agent, saved).await;
    }
    let body = try_forward!(admin_body(ctx, agent));
    send_test(ctx, agent, body).await
}

/// Both webhook routes read `req.body.options` first.
const WEBHOOK_UNDEFINED: &str = "The webhook settings need a body with options.";

/// Why a webhook body doesn't make a section: Node's 500 with the thrown
/// message, or a case only Node words.
enum NoSection {
    Thrown(String),
    Forward(String),
}

/// The webhook section both webhook routes build from the body:
/// `jsonPayload` must parse, and is stored as base64 of its JSON string.
fn webhook_section(body: &Value) -> Result<Value, NoSection> {
    let options = match body.get("options") {
        Some(Value::Object(options)) => options,
        None => {
            return Err(NoSection::Thrown(String::from(
                "The webhook settings need options.",
            )))
        }
        Some(_) => return Err(NoSection::Forward(String::from("options isn't an object"))),
    };
    let template = match options.get("jsonPayload") {
        Some(Value::String(template)) => template.as_str(),
        None => {
            return Err(NoSection::Thrown(String::from(
                "The webhook settings need a jsonPayload.",
            )))
        }
        Some(_) => {
            return Err(NoSection::Forward(String::from(
                "a jsonPayload that isn't text; the validator's to check",
            )))
        }
    };
    if let Err(e) = serde_json::from_str::<serde::de::IgnoredAny>(template) {
        return Err(NoSection::Thrown(format!(
            "jsonPayload is not valid JSON: {e}"
        )));
    }
    let encoded = serde_json::to_string(&Value::from(template))
        .map_err(|e| NoSection::Forward(format!("encoding jsonPayload failed: {e}")))?;
    let mut out = Map::new();
    for key in ["enabled", "embedPoster", "types"] {
        if let Some(v) = body.get(key) {
            out.insert(String::from(key), v.clone());
        }
    }
    let mut opts = Map::new();
    opts.insert(
        String::from("jsonPayload"),
        Value::from(BASE64_STANDARD.encode(encoded)),
    );
    for key in ["webhookUrl", "authHeader"] {
        if let Some(v) = options.get(key) {
            opts.insert(String::from(key), v.clone());
        }
    }
    let or = |key: &str, fallback: Value| match options.get(key) {
        None | Some(Value::Null) => fallback,
        Some(v) => v.clone(),
    };
    opts.insert(
        String::from("customHeaders"),
        or("customHeaders", Value::Array(Vec::new())),
    );
    opts.insert(
        String::from("supportVariables"),
        or("supportVariables", Value::Bool(false)),
    );
    out.insert(String::from("options"), Value::Object(opts));
    Ok(Value::Object(out))
}

/// `POST /settings/notifications/webhook`.
fn webhook_save<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if body_undefined(ctx) {
            try_forward!(admin_only(ctx));
            return ctx.error(500, WEBHOOK_UNDEFINED);
        }
        let body = try_forward!(admin_body(ctx, WEBHOOK));
        match webhook_section(&body) {
            Ok(section) => store(ctx, WEBHOOK.name, section).await,
            Err(NoSection::Thrown(message)) => thrown(ctx, &message),
            Err(NoSection::Forward(why)) => Outcome::forward(why),
        }
    })
}

/// `POST /settings/notifications/webhook/test`.
fn webhook_test<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if body_undefined(ctx) {
            try_forward!(admin_only(ctx));
            return ctx.error(500, WEBHOOK_UNDEFINED);
        }
        let body = try_forward!(admin_body(ctx, WEBHOOK));
        match webhook_section(&body) {
            Ok(section) => send_test(ctx, WEBHOOK, section).await,
            Err(NoSection::Thrown(message)) => thrown(ctx, &message),
            Err(NoSection::Forward(why)) => Outcome::forward(why),
        }
    })
}

/// The `token` of a `?token=...` query, decoded; anything else is the
/// validator's.
fn sounds_token(query: Option<&str>) -> Option<String> {
    let url = reqwest::Url::parse(&format!("http://localhost/?{}", query?)).ok()?;
    let mut pairs = url.query_pairs();
    let (key, value) = pairs.next()?;
    if pairs.next().is_some() || key != "token" || value.is_empty() {
        return None;
    }
    Some(value.into_owned())
}

/// Whether `key` is an array index, which JavaScript objects list first.
fn array_index(key: &str) -> Option<u32> {
    key.parse::<u32>()
        .ok()
        .filter(|n| *n != u32::MAX && n.to_string() == key)
}

/// `Object.entries(sounds).map(([name, description]) => ({ name, description }))`,
/// in JavaScript's key order; `None` where Node would throw or do
/// something not reproduced.
fn map_sounds(sounds: Option<&Value>) -> Option<Value> {
    let entries: Vec<(String, Value)> = match sounds? {
        Value::Object(map) => {
            let mut indexed: Vec<(u32, String, Value)> = Vec::new();
            let mut named: Vec<(String, Value)> = Vec::new();
            for (k, v) in map {
                match array_index(k) {
                    Some(n) => indexed.push((n, k.clone(), v.clone())),
                    None => named.push((k.clone(), v.clone())),
                }
            }
            indexed.sort_by_key(|(n, _, _)| *n);
            indexed
                .into_iter()
                .map(|(_, k, v)| (k, v))
                .chain(named)
                .collect()
        }
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v.clone()))
            .collect(),
        Value::Bool(_) | Value::Number(_) => Vec::new(),
        Value::Null | Value::String(_) => return None,
    };
    Some(Value::Array(
        entries
            .into_iter()
            .map(|(name, description)| {
                let mut o = Map::new();
                o.insert(String::from("name"), Value::from(name));
                o.insert(String::from("description"), description);
                Value::Object(o)
            })
            .collect(),
    ))
}

/// `GET /settings/notifications/pushover/sounds?token=`.
fn pushover_sounds<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.authenticated(0));
        let Some(token) = sounds_token(ctx.req.uri.query()) else {
            return Outcome::forward(String::from("the query is the validator's"));
        };
        let url = format!(
            "https://api.pushover.net/1/sounds.json?token={}",
            axios_encode(&token)
        );
        let response = ctx
            .state
            .outbound
            .get(url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .send()
            .await
            .and_then(reqwest::Response::error_for_status);
        let body = match response {
            Ok(response) => response.json::<Value>().await.ok(),
            Err(e) => {
                tracing::debug!("Something went wrong retrieving Pushover sounds: {e:#}");
                None
            }
        };
        match body {
            Some(Value::Object(body)) => match body.get("sounds") {
                Some(Value::String(_)) => {
                    Outcome::forward(String::from("sounds is a string; Object.entries splits it"))
                }
                sounds => map_sounds(sounds).map_or_else(
                    || ctx.error(500, "Unable to retrieve Pushover sounds."),
                    |list| ctx.json(&list),
                ),
            },
            _ => ctx.error(500, "Unable to retrieve Pushover sounds."),
        }
    })
}

/// The error handler's 500 for a thrown error.
fn thrown(ctx: &Ready<'_>, message: &str) -> Outcome {
    ctx.error(500, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn orders_sounds_like_javascript() {
        let sounds: Value = serde_json::from_str(
            r#"{"pushover": "Pushover", "10": "Ten", "2": "Two", "01": "Zero one"}"#,
        )
        .unwrap_or_default();
        let names: Vec<Value> = map_sounds(Some(&sounds))
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|s| s.get("name").cloned())
            .collect();
        assert_eq!(
            names,
            vec![json!("2"), json!("10"), json!("pushover"), json!("01")],
            "indices first"
        );
        assert_eq!(map_sounds(None), None, "missing sounds throw");
    }

    #[test]
    fn reads_the_token() {
        assert_eq!(
            sounds_token(Some("token=a%20b")).as_deref(),
            Some("a b"),
            "decoded"
        );
        assert_eq!(sounds_token(Some("token=")), None, "empty");
        assert_eq!(sounds_token(Some("token=a&x=1")), None, "extra");
        assert_eq!(sounds_token(None), None, "missing");
    }

    #[test]
    fn builds_the_webhook_section() {
        let body = json!({"enabled": true, "types": 4, "options": {"webhookUrl": "http://x", "jsonPayload": "{\"a\":1}", "customHeaders": null}});
        let section = webhook_section(&body).unwrap_or(Value::Null);
        assert_eq!(
            section.pointer("/options/jsonPayload"),
            Some(&json!(BASE64_STANDARD.encode("\"{\\\"a\\\":1}\""))),
            "base64 of the JSON string"
        );
        assert_eq!(
            section.pointer("/options/customHeaders"),
            Some(&json!([])),
            "defaulted"
        );
        assert_eq!(
            section.pointer("/options/supportVariables"),
            Some(&json!(false)),
            "defaulted"
        );
        assert!(
            section.pointer("/options/authHeader").is_none(),
            "undefined dropped"
        );
        assert!(
            webhook_section(&json!({"options": {"jsonPayload": "{"}})).is_err(),
            "bad JSON"
        );
    }

    #[test]
    fn gates_like_node_send() {
        let mut discord = json!({"enabled": false, "options": {"webhookUrl": "http://x"}});
        assert!(
            gate_passes(DISCORD.gate, &mut discord),
            "enabled is ignored"
        );
        let mut pushover =
            json!({"enabled": false, "options": {"accessToken": "a", "userToken": "u"}});
        assert!(
            !gate_passes(PUSHOVER.gate, &mut pushover),
            "pushover keeps its gate"
        );
        let mut gotify = json!({"options": {"url": "u", "token": "t"}});
        assert!(!gate_passes(GOTIFY.gate, &mut gotify), "priority required");
    }
}
