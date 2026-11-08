//! AI settings: the admin's policy and server connection
//! (`/settings/ai/...`), and each user's own connection and preferences
//! (`/ai/me/...`).
//!
//! The user routes only ever act on the signed-in user ("me"); no route
//! takes another user's id, so an admin can't read or change someone
//! else's connection through the API. Credentials are write-only: no
//! response carries a key or token, only whether one is set.

use std::future::Future;
use std::ops::ControlFlow;
use std::pin::Pin;

use axum::http::Method;
use serde_json::{json, Map, Value};

use super::{Outcome, Ready, Table, ADMIN};
use crate::ai::store::{self, Connection, Credentials, Kind, Owner, PrefsChange, Status};
use crate::ai::{self, chatgpt, compat, AiError, Policy, Preset};
use crate::auth::CurrentUser;
use crate::vault::{KeySource, Secret};

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/settings/ai", Method::GET, admin_get),
    ("/api/v1/settings/ai", Method::POST, admin_policy),
    ("/api/v1/settings/ai/connection", Method::PUT, admin_put),
    (
        "/api/v1/settings/ai/connection",
        Method::DELETE,
        admin_delete,
    ),
    (
        "/api/v1/settings/ai/connection/model",
        Method::POST,
        admin_model,
    ),
    (
        "/api/v1/settings/ai/connection/test",
        Method::POST,
        admin_test,
    ),
    (
        "/api/v1/settings/ai/connection/models",
        Method::GET,
        admin_models,
    ),
    (
        "/api/v1/settings/ai/searxng/test",
        Method::POST,
        searxng_test,
    ),
    ("/api/v1/ai/me", Method::GET, me_get),
    ("/api/v1/ai/me", Method::POST, me_prefs),
    ("/api/v1/ai/me/connection", Method::PUT, me_put),
    ("/api/v1/ai/me/connection", Method::DELETE, me_delete),
    ("/api/v1/ai/me/connection/model", Method::POST, me_model),
    ("/api/v1/ai/me/connection/test", Method::POST, me_test),
    ("/api/v1/ai/me/connection/models", Method::GET, me_models),
    (
        "/api/v1/ai/me/chatgpt/start",
        Method::POST,
        me_chatgpt_start,
    ),
    (
        "/api/v1/ai/me/chatgpt/complete",
        Method::POST,
        me_chatgpt_complete,
    ),
];

/// The longest model id accepted.
const MAX_MODEL_LEN: usize = 200;

fn fail(ctx: &Ready<'_>, e: &AiError) -> Outcome {
    ctx.json_with(e.status(), &e.to_json())
}

fn admin<'c>(ctx: &'c Ready<'_>) -> Result<&'c CurrentUser, Box<Outcome>> {
    ctx.require(ADMIN)
}

fn signed_in<'c>(ctx: &'c Ready<'_>) -> Result<&'c CurrentUser, Box<Outcome>> {
    ctx.require(0)
}

fn body(ctx: &Ready<'_>) -> Map<String, Value> {
    ctx.body
        .as_ref()
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn text(body: &Map<String, Value>, key: &str) -> Option<String> {
    body.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn db_err(e: &anyhow::Error) -> AiError {
    AiError::internal(format!("{e:#}"))
}

/// What a body says about a model field.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Change {
    /// Absent: keep the current value.
    Keep,
    /// `null` or blank: clear it.
    Clear,
    /// A model id.
    Set(String),
}

impl Change {
    fn or_keep(self, current: Option<String>) -> Option<String> {
        match self {
            Self::Keep => current,
            Self::Clear => None,
            Self::Set(m) => Some(m),
        }
    }
}

/// A model id from the body.
fn model_field(body: &Map<String, Value>, key: &str) -> Result<Change, AiError> {
    match body.get(key) {
        None => Ok(Change::Keep),
        Some(Value::Null) => Ok(Change::Clear),
        Some(Value::String(s)) if s.trim().is_empty() => Ok(Change::Clear),
        Some(Value::String(s)) if s.trim().chars().count() <= MAX_MODEL_LEN => {
            Ok(Change::Set(s.trim().to_owned()))
        }
        Some(_) => Err(AiError::input("That isn't a valid model id.")),
    }
}

fn models_json(list: &[(String, String)]) -> Value {
    Value::Array(
        list.iter()
            .map(|(id, label)| json!({"id": id, "label": label}))
            .collect(),
    )
}

fn key_source(source: &KeySource) -> Value {
    let name = match source {
        KeySource::Env => "env",
        KeySource::File(_) => "file",
        KeySource::ConfigFile(_) | KeySource::Generated(_) => "config",
    };
    json!({"source": name, "besideDatabase": source.beside_database()})
}

// ---------------------------------------------------------------------------
// Admin: policy and the server connection.

async fn admin_view(ctx: &Ready<'_>) -> Result<Value, AiError> {
    let settings = ctx.state.settings.current().await.map_err(|e| db_err(&e))?;
    let policy = Policy::of(&settings);
    let vault = ai::vault(ctx.state)?;
    let server = store::load(&ctx.state.db, Owner::Server)
        .await
        .map_err(|e| db_err(&e))?;
    Ok(json!({
        "enabled": policy.enabled,
        "shareServerConnection": policy.share_server_connection,
        "allowUserChatgpt": policy.allow_user_chatgpt,
        "allowUserEndpoints": policy.allow_user_endpoints,
        "allowUserModelChoice": policy.allow_user_model_choice,
        "models": {"fast": policy.fast_model, "best": policy.best_model},
        "presets": policy.presets_json(server.as_ref()),
        "searxng": {"enabled": policy.searxng_enabled, "url": policy.searxng_url},
        "dailyLimit": policy.daily_limit,
        "connection": server.as_ref().map(|c| ai::connection_json(c, &vault)),
        "secretKey": key_source(vault.source()),
    }))
}

/// `GET /settings/ai`.
fn admin_get<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(out) = admin(ctx) {
            return *out;
        }
        match admin_view(ctx).await {
            Ok(v) => ctx.json(&v),
            Err(e) => fail(ctx, &e),
        }
    })
}

fn bool_field(body: &Map<String, Value>, key: &str, into: &mut Map<String, Value>) {
    if let Some(Value::Bool(b)) = body.get(key) {
        into.insert(key.to_owned(), Value::Bool(*b));
    }
}

/// The policy fields a `POST /settings/ai` body sets, checked.
fn policy_changes(body: &Map<String, Value>) -> Result<Map<String, Value>, AiError> {
    let mut out = Map::new();
    for key in [
        "enabled",
        "shareServerConnection",
        "allowUserChatgpt",
        "allowUserEndpoints",
        "allowUserModelChoice",
    ] {
        bool_field(body, key, &mut out);
    }
    if let Some(limit) = body.get("dailyLimit") {
        let n = limit
            .as_u64()
            .filter(|n| *n <= ai::MAX_DAILY_LIMIT)
            .ok_or_else(|| {
                AiError::input("The daily limit must be a whole number from 0 to 1000.")
            })?;
        out.insert(String::from("dailyLimit"), Value::from(n));
    }
    if let Some(models) = body.get("models").and_then(Value::as_object) {
        let mut m = Map::new();
        for key in ["fast", "best"] {
            match model_field(models, key)? {
                Change::Keep => {}
                Change::Clear => {
                    m.insert(key.to_owned(), Value::Null);
                }
                Change::Set(model) => {
                    m.insert(key.to_owned(), Value::from(model));
                }
            }
        }
        out.insert(String::from("models"), Value::Object(m));
    }
    if let Some(search) = body.get("searxng").and_then(Value::as_object) {
        let mut s = Map::new();
        bool_field(search, "enabled", &mut s);
        match search.get("url") {
            Some(Value::String(url)) if url.trim().is_empty() => {
                s.insert(String::from("url"), Value::from(""));
            }
            Some(Value::String(url)) => {
                let url = crate::searxng::normalize_url(url).map_err(|e| AiError::input(e.0))?;
                s.insert(String::from("url"), Value::from(url));
            }
            Some(_) | None => {}
        }
        if s.get("enabled") == Some(&Value::Bool(true))
            && s.get("url")
                .and_then(Value::as_str)
                .is_some_and(str::is_empty)
        {
            return Err(AiError::input(
                "Enter the SearXNG address to turn web search on.",
            ));
        }
        out.insert(String::from("searxng"), Value::Object(s));
    }
    Ok(out)
}

/// `POST /settings/ai`: the policy switches, preset models and `SearXNG`.
fn admin_policy<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user = match admin(ctx) {
            Ok(u) => u.id,
            Err(out) => return *out,
        };
        let changes = match policy_changes(&body(ctx)) {
            Ok(c) => c,
            Err(e) => return fail(ctx, &e),
        };
        // Checked on the merged result, under the settings lock: a partial
        // update can't turn search on without an address, or clear the
        // address while search stays on.
        let saved = ctx
            .state
            .settings
            .mutate(|doc| {
                let Some(root) = doc.as_object_mut() else {
                    return ControlFlow::Continue(());
                };
                let mut current = root.get("ai").cloned().unwrap_or_else(|| json!({}));
                crate::settings::merge(&mut current, Value::Object(changes));
                let search_on = current.pointer("/searxng/enabled") == Some(&Value::Bool(true));
                let no_url = current
                    .pointer("/searxng/url")
                    .and_then(Value::as_str)
                    .is_none_or(|u| u.trim().is_empty());
                if search_on && no_url {
                    return ControlFlow::Break(());
                }
                root.insert(String::from("ai"), current);
                ControlFlow::Continue(())
            })
            .await;
        match saved {
            Ok(ControlFlow::Continue(())) => {}
            Ok(ControlFlow::Break(())) => {
                return fail(
                    ctx,
                    &AiError::input("Enter the SearXNG address to turn web search on."),
                );
            }
            Err(e) => return fail(ctx, &db_err(&e)),
        }
        tracing::info!("AI settings changed by user {user}");
        match admin_view(ctx).await {
            Ok(v) => ctx.json(&v),
            Err(e) => fail(ctx, &e),
        }
    })
}

/// Save an endpoint connection for `owner` from a request body. A stored
/// key is never sent to a different destination: moving the endpoint means
/// entering the key again.
async fn save_endpoint(
    ctx: &Ready<'_>,
    owner: Owner,
    body: &Map<String, Value>,
    held: &store::WriteGuard,
) -> Result<(), AiError> {
    let base = compat::normalize_base_url(
        &text(body, "baseUrl").ok_or_else(|| AiError::input("Enter the endpoint's base URL."))?,
    )?;
    let vault = ai::vault(ctx.state)?;
    let existing = store::load(&ctx.state.db, owner)
        .await
        .map_err(|e| db_err(&e))?
        .filter(|c| c.kind == Kind::OpenAi);
    let clearing = body.get("clearApiKey") == Some(&Value::Bool(true));
    let new_key = text(body, "apiKey");
    let moved = existing
        .as_ref()
        .is_some_and(|c| c.base_url.as_deref().and_then(compat::host_of) != compat::host_of(&base));
    let has_key = existing.as_ref().is_some_and(|c| c.has_api_key(&vault));
    let credentials = if let Some(key) = new_key.filter(|_| !clearing) {
        Some(Some(Credentials::ApiKey(Secret::new(key))))
    } else if !clearing && existing.is_some() {
        if moved && has_key {
            return Err(AiError::input(
                "The endpoint moved to another address. Enter the API key again so the saved one isn't sent there.",
            ));
        }
        None
    } else {
        Some(Some(Credentials::ApiKey(Secret::new(String::new()))))
    };
    let model =
        model_field(body, "model")?.or_keep(existing.as_ref().and_then(|c| c.model.clone()));
    store::save(
        &ctx.state.db,
        &vault,
        owner,
        store::Write {
            kind: Kind::OpenAi,
            base_url: Some(base),
            model,
            credentials,
            identity: None,
            status: Status::Ok,
        },
        held,
    )
    .await
    .map_err(|e| db_err(&e))
}

async fn connection_view(ctx: &Ready<'_>, owner: Owner) -> Result<Value, AiError> {
    let vault = ai::vault(ctx.state)?;
    let conn = store::load(&ctx.state.db, owner)
        .await
        .map_err(|e| db_err(&e))?;
    Ok(conn.map_or(Value::Null, |c| ai::connection_json(&c, &vault)))
}

/// `PUT /settings/ai/connection`: the server's endpoint.
fn admin_put<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user = match admin(ctx) {
            Ok(u) => u.id,
            Err(out) => return *out,
        };
        let held = store::lock().await;
        let saved = save_endpoint(ctx, Owner::Server, &body(ctx), &held).await;
        drop(held);
        if let Err(e) = saved {
            return fail(ctx, &e);
        }
        tracing::info!("AI server connection saved by user {user}");
        match admin_view(ctx).await {
            Ok(v) => ctx.json(&v),
            Err(e) => fail(ctx, &e),
        }
    })
}

/// `DELETE /settings/ai/connection`.
fn admin_delete<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user = match admin(ctx) {
            Ok(u) => u.id,
            Err(out) => return *out,
        };
        let held = store::lock().await;
        let removed = store::delete(&ctx.state.db, Owner::Server).await;
        drop(held);
        if let Err(e) = removed {
            return fail(ctx, &db_err(&e));
        }
        tracing::info!("AI server connection removed by user {user}");
        match admin_view(ctx).await {
            Ok(v) => ctx.json(&v),
            Err(e) => fail(ctx, &e),
        }
    })
}

async fn load_required(ctx: &Ready<'_>, owner: Owner) -> Result<Connection, AiError> {
    store::load(&ctx.state.db, owner)
        .await
        .map_err(|e| db_err(&e))?
        .ok_or_else(AiError::not_configured)
}

async fn set_model(ctx: &Ready<'_>, owner: Owner) -> Result<Value, AiError> {
    let _held = store::lock().await;
    let conn = load_required(ctx, owner).await?;
    // An omitted field keeps the model; `null` or blank clears it.
    let model = match model_field(&body(ctx), "model")? {
        Change::Keep => return connection_view(ctx, owner).await,
        change @ (Change::Clear | Change::Set(_)) => change.or_keep(None),
    };
    store::set_model(&ctx.state.db, &conn, model.as_deref())
        .await
        .map_err(|e| db_err(&e))?;
    connection_view(ctx, owner).await
}

/// `POST /settings/ai/connection/model`: the Balanced (default) model.
fn admin_model<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(out) = admin(ctx) {
            return *out;
        }
        if let Err(e) = set_model(ctx, Owner::Server).await {
            return fail(ctx, &e);
        }
        match admin_view(ctx).await {
            Ok(v) => ctx.json(&v),
            Err(e) => fail(ctx, &e),
        }
    })
}

async fn run_test(ctx: &Ready<'_>, owner: Owner) -> Result<Value, AiError> {
    let conn = load_required(ctx, owner).await?;
    let model = model_field(&body(ctx), "model")?.or_keep(conn.model.clone());
    ai::test(ctx.state, &conn, model.as_deref()).await
}

/// `POST /settings/ai/connection/test`.
fn admin_test<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(out) = admin(ctx) {
            return *out;
        }
        match run_test(ctx, Owner::Server).await {
            Ok(v) => ctx.json(&v),
            Err(e) => fail(ctx, &e),
        }
    })
}

async fn list_models(ctx: &Ready<'_>, owner: Owner) -> Result<Value, AiError> {
    let conn = load_required(ctx, owner).await?;
    ai::models(ctx.state, &conn).await.map(|m| models_json(&m))
}

/// `GET /settings/ai/connection/models`.
fn admin_models<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(out) = admin(ctx) {
            return *out;
        }
        match list_models(ctx, Owner::Server).await {
            Ok(v) => ctx.json(&v),
            Err(e) => fail(ctx, &e),
        }
    })
}

/// `POST /settings/ai/searxng/test`: the given address, or the saved one.
fn searxng_test<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(out) = admin(ctx) {
            return *out;
        }
        let url = text(&body(ctx), "url").unwrap_or_else(|| Policy::of(&ctx.settings).searxng_url);
        let checked = match crate::searxng::normalize_url(&url) {
            Ok(u) => u,
            Err(e) => return fail(ctx, &AiError::input(e.0)),
        };
        match crate::searxng::test(&ctx.state.outbound, &checked).await {
            Ok(results) => ctx.json(&json!({"ok": true, "results": results})),
            Err(e) => fail(ctx, &AiError::upstream(e.0)),
        }
    })
}

// ---------------------------------------------------------------------------
// Users: their own connection and preferences.

async fn me_view(ctx: &Ready<'_>, user: &CurrentUser) -> Result<Value, AiError> {
    let settings = ctx.state.settings.current().await.map_err(|e| db_err(&e))?;
    let policy = Policy::of(&settings);
    let vault = ai::vault(ctx.state)?;
    let db = &ctx.state.db;
    let own = store::load(db, Owner::User(user.id))
        .await
        .map_err(|e| db_err(&e))?;
    let server = store::load(db, Owner::Server)
        .await
        .map_err(|e| db_err(&e))?
        .filter(|_| policy.allows_server(user));
    let prefs = store::prefs(db, user.id).await.map_err(|e| db_err(&e))?;
    let effective = ai::effective(ctx.state, &settings, user)
        .await
        .map_err(|e| db_err(&e))?;
    let used_today = ai::recs::store::server_runs_since(db, user.id, &ai::recs::iso_since(None))
        .await
        .map_err(|e| db_err(&e))?;
    let daily_limit = effective
        .as_ref()
        .ok()
        .and_then(|eff| ai::recs::daily_limit(&policy, eff, user));
    let server_view = server.as_ref().map(|c| {
        json!({
            "kind": c.kind.as_str(),
            "status": c.status.as_str(),
            "providerLabel": compat::provider_label(c.base_url.as_deref().unwrap_or("")),
            "presets": policy.presets_json(Some(c)),
        })
    });
    Ok(json!({
        "enabled": policy.enabled,
        "policy": {
            "allowChatgpt": policy.allows_own(Kind::ChatGpt, user),
            "allowEndpoints": policy.allows_own(Kind::OpenAi, user),
            "allowModelChoice": policy.allow_user_model_choice,
        },
        "server": server_view,
        "own": own.as_ref().map(|c| ai::connection_json(c, &vault)),
        "preferences": prefs.to_json(),
        "effective": ai::effective_json(&effective),
        "chatgptRedirectUri": chatgpt::REDIRECT_URI,
        "usage": {"dailyLimit": daily_limit, "usedToday": used_today},
    }))
}

fn me_answer(ctx: &Ready<'_>, result: Result<Value, AiError>) -> Outcome {
    match result {
        Ok(v) => ctx.json(&v),
        Err(e) => fail(ctx, &e),
    }
}

/// `GET /ai/me`.
fn me_get<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user = match signed_in(ctx) {
            Ok(u) => u,
            Err(out) => return *out,
        };
        me_answer(ctx, me_view(ctx, user).await)
    })
}

async fn save_prefs(ctx: &Ready<'_>, user: &CurrentUser) -> Result<(), AiError> {
    let body = body(ctx);
    let db = &ctx.state.db;
    let mut change = PrefsChange::default();
    match body.get("model") {
        Some(Value::String(p)) if Preset::parse(p).is_some() => {
            change.model = Some(Some(p.clone()));
        }
        Some(Value::Null) => change.model = Some(None),
        Some(_) => return Err(AiError::input("Pick fast, balanced or best.")),
        None => {}
    }
    if let Some(Value::Bool(history)) = body.get("useHistory") {
        change.use_history = Some(*history);
    }
    // Held so a removal can't land between the check and the switch.
    let held = store::lock().await;
    if let Some(Value::Bool(own)) = body.get("useOwnConnection") {
        if *own
            && store::load(db, Owner::User(user.id))
                .await
                .map_err(|e| db_err(&e))?
                .is_none()
        {
            return Err(AiError::input("Connect your own account first."));
        }
        change.use_own_connection = Some(*own);
    }
    store::update_prefs(db, user.id, &change)
        .await
        .map_err(|e| db_err(&e))?;
    drop(held);
    Ok(())
}

/// `POST /ai/me`: which connection to use, the preset, and history consent.
fn me_prefs<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user = match signed_in(ctx) {
            Ok(u) => u,
            Err(out) => return *out,
        };
        if let Err(e) = save_prefs(ctx, user).await {
            return fail(ctx, &e);
        }
        me_answer(ctx, me_view(ctx, user).await)
    })
}

/// Switch a user to their own connection after they set one up.
async fn use_own(ctx: &Ready<'_>, user_id: i64, on: bool) -> Result<(), AiError> {
    let change = PrefsChange {
        use_own_connection: Some(on),
        ..PrefsChange::default()
    };
    store::update_prefs(&ctx.state.db, user_id, &change)
        .await
        .map_err(|e| db_err(&e))
}

fn require_enabled(ctx: &Ready<'_>) -> Result<Policy, AiError> {
    let policy = Policy::of(&ctx.settings);
    if policy.enabled {
        Ok(policy)
    } else {
        Err(AiError::input("AI features are turned off on this server."))
    }
}

/// Their own connection, when AI is on and the admin still allows its
/// provider: a provider turned off later can't be used to send requests.
async fn usable_own(ctx: &Ready<'_>, user: &CurrentUser) -> Result<Connection, AiError> {
    let policy = require_enabled(ctx)?;
    let conn = load_required(ctx, Owner::User(user.id)).await?;
    if policy.allows_own(conn.kind, user) {
        Ok(conn)
    } else {
        Err(AiError::not_eligible(match conn.kind {
            Kind::ChatGpt => "Your admin no longer allows connecting ChatGPT accounts.",
            Kind::OpenAi => "Your admin no longer allows personal endpoints.",
        }))
    }
}

/// `PUT /ai/me/connection`: the user's own endpoint, when allowed.
fn me_put<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user = match signed_in(ctx) {
            Ok(u) => u,
            Err(out) => return *out,
        };
        let result = async {
            let policy = require_enabled(ctx)?;
            if !policy.allows_own(Kind::OpenAi, user) {
                return Err(AiError::not_eligible(
                    "Your admin hasn't allowed personal endpoints.",
                ));
            }
            // Replacing a live ChatGPT sign-in would drop its tokens without
            // revoking them at OpenAI; signing out first does. The lock keeps
            // a sign-in from landing between this check and the save.
            let held = store::lock().await;
            let signed_in_chatgpt = store::load(&ctx.state.db, Owner::User(user.id))
                .await
                .map_err(|e| db_err(&e))?
                .is_some_and(|c| c.kind == Kind::ChatGpt && c.status != Status::SignedOut);
            if signed_in_chatgpt {
                return Err(AiError::input(
                    "Sign out of ChatGPT before adding an endpoint.",
                ));
            }
            save_endpoint(ctx, Owner::User(user.id), &body(ctx), &held).await?;
            use_own(ctx, user.id, true).await?;
            drop(held);
            tracing::info!("User {} saved their own AI endpoint", user.id);
            me_view(ctx, user).await
        }
        .await;
        me_answer(ctx, result)
    })
}

/// `DELETE /ai/me/connection`: sign out of `ChatGPT` (revoking the session,
/// keeping the registration for a later sign-in), or remove the
/// connection when it's an endpoint or already signed out.
fn me_delete<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user = match signed_in(ctx) {
            Ok(u) => u,
            Err(out) => return *out,
        };
        let result = async {
            let owner = Owner::User(user.id);
            let held = store::lock().await;
            let conn = load_required(ctx, owner).await?;
            let mut revoked = None;
            if conn.kind == Kind::ChatGpt && conn.status != Status::SignedOut {
                drop(held);
                let vault = ai::vault(ctx.state)?;
                let confirmed =
                    chatgpt::sign_out(&ctx.state.outbound, &ctx.state.db, &vault, &conn)
                        .await
                        .map_err(|e| db_err(&e))?;
                revoked = Some(confirmed);
                tracing::info!(
                    "User {} signed out of ChatGPT (revocation confirmed: {confirmed})",
                    user.id
                );
            } else {
                store::delete(&ctx.state.db, owner)
                    .await
                    .map_err(|e| db_err(&e))?;
                use_own(ctx, user.id, false).await?;
                drop(held);
                tracing::info!("User {} removed their own AI connection", user.id);
            }
            let mut view = me_view(ctx, user).await?;
            if let Some(obj) = view.as_object_mut() {
                obj.insert(String::from("revoked"), json!(revoked));
            }
            Ok(view)
        }
        .await;
        me_answer(ctx, result)
    })
}

/// `POST /ai/me/connection/model`.
fn me_model<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user = match signed_in(ctx) {
            Ok(u) => u,
            Err(out) => return *out,
        };
        let result = async {
            set_model(ctx, Owner::User(user.id)).await?;
            me_view(ctx, user).await
        }
        .await;
        me_answer(ctx, result)
    })
}

/// `POST /ai/me/connection/test`.
fn me_test<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user = match signed_in(ctx) {
            Ok(u) => u,
            Err(out) => return *out,
        };
        let result = async {
            let conn = usable_own(ctx, user).await?;
            let model = model_field(&body(ctx), "model")?.or_keep(conn.model.clone());
            ai::test(ctx.state, &conn, model.as_deref()).await
        }
        .await;
        me_answer(ctx, result)
    })
}

/// `GET /ai/me/connection/models`.
fn me_models<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user = match signed_in(ctx) {
            Ok(u) => u,
            Err(out) => return *out,
        };
        let result = match usable_own(ctx, user).await {
            Ok(conn) => ai::models(ctx.state, &conn).await.map(|m| models_json(&m)),
            Err(e) => Err(e),
        };
        me_answer(ctx, result)
    })
}

/// `POST /ai/me/chatgpt/start`: the `ChatGPT` authorize URL to open.
fn me_chatgpt_start<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user = match signed_in(ctx) {
            Ok(u) => u,
            Err(out) => return *out,
        };
        let result = async {
            let policy = require_enabled(ctx)?;
            if !policy.allows_own(Kind::ChatGpt, user) {
                return Err(AiError::not_eligible(
                    "Your admin hasn't allowed connecting ChatGPT accounts.",
                ));
            }
            let host = ai::host_id(ctx.state).await?;
            let existing = store::load(&ctx.state.db, Owner::User(user.id))
                .await
                .map_err(|e| db_err(&e))?
                .filter(|c| c.kind == Kind::ChatGpt);
            let consent = body(ctx).get("consent") == Some(&Value::Bool(true));
            let started = chatgpt::start(
                Owner::User(user.id),
                user.id,
                &host,
                existing.as_ref(),
                consent,
            )?;
            Ok(json!({
                "authorizeUrl": started.authorize_url,
                "redirectUri": chatgpt::REDIRECT_URI,
            }))
        }
        .await;
        me_answer(ctx, result)
    })
}

/// After a first sign-in, pick the account's first listed model so the
/// connection works at once (the user can change it).
async fn default_model(ctx: &Ready<'_>, owner: Owner) {
    let Ok(Some(conn)) = store::load(&ctx.state.db, owner).await else {
        return;
    };
    if conn.model.is_some() || conn.status != Status::Ok {
        return;
    }
    match ai::models(ctx.state, &conn).await {
        Ok(list) => {
            if let Some((first, _)) = list.first() {
                let _held = store::lock().await;
                if let Ok(Some(current)) = store::load(&ctx.state.db, owner).await {
                    if current.id == conn.id
                        && current.session_version == conn.session_version
                        && current.model.is_none()
                    {
                        if let Err(e) = store::set_model(&ctx.state.db, &current, Some(first)).await
                        {
                            tracing::warn!("setting a default AI model failed: {e:#}");
                        }
                    }
                }
            }
        }
        Err(e) => tracing::info!("listing ChatGPT models after sign-in failed: {e}"),
    }
}

/// `POST /ai/me/chatgpt/complete`: finish with the pasted callback address.
fn me_chatgpt_complete<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user = match signed_in(ctx) {
            Ok(u) => u,
            Err(out) => return *out,
        };
        let result = async {
            // Rechecked here: the admin may have turned ChatGPT off since
            // this sign-in started.
            if !require_enabled(ctx)?.allows_own(Kind::ChatGpt, user) {
                return Err(AiError::not_eligible(
                    "Your admin hasn't allowed connecting ChatGPT accounts.",
                ));
            }
            let pasted = text(&body(ctx), "callbackUrl")
                .ok_or_else(|| AiError::input("Paste the address from the sign-in page."))?;
            let vault = ai::vault(ctx.state)?;
            let owner = Owner::User(user.id);
            let keep_model = store::load(&ctx.state.db, owner)
                .await
                .map_err(|e| db_err(&e))?
                .filter(|c| c.kind == Kind::ChatGpt)
                .and_then(|c| c.model);
            let finished = chatgpt::complete(
                &ctx.state.outbound,
                &ctx.state.db,
                &vault,
                user.id,
                &pasted,
                keep_model,
            )
            .await?;
            if finished.owner != owner {
                return Err(AiError::input(
                    "This sign-in belongs to another connection.",
                ));
            }
            tracing::info!(
                "User {} connected ChatGPT (plan use allowed: {})",
                user.id,
                finished.plan_enabled
            );
            default_model(ctx, owner).await;
            let held = store::lock().await;
            let current = load_required(ctx, owner).await?;
            if current.kind != Kind::ChatGpt
                || current.status == Status::SignedOut
                || current.session_version != finished.session_version
            {
                return Err(AiError::input(
                    "The ChatGPT connection changed. Start again.",
                ));
            }
            use_own(ctx, user.id, true).await?;
            drop(held);
            let mut view = me_view(ctx, user).await?;
            if let Some(obj) = view.as_object_mut() {
                obj.insert(
                    String::from("planEnabled"),
                    Value::Bool(finished.plan_enabled),
                );
            }
            Ok(view)
        }
        .await;
        me_answer(ctx, result)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_policy_changes() -> Result<(), AiError> {
        let body = json!({
            "enabled": true,
            "allowUserEndpoints": "yes",
            "models": {"fast": " gpt-mini ", "best": null},
            "searxng": {"enabled": true, "url": "http://searxng:8080/"}
        });
        let Some(obj) = body.as_object() else {
            return Err(AiError::input("fixture"));
        };
        let changes = Value::Object(policy_changes(obj)?);
        assert_eq!(
            changes.get("enabled"),
            Some(&Value::Bool(true)),
            "bool kept"
        );
        assert!(
            changes.get("allowUserEndpoints").is_none(),
            "non-bool ignored"
        );
        assert_eq!(
            changes.pointer("/models/fast").and_then(Value::as_str),
            Some("gpt-mini"),
            "trimmed model"
        );
        assert_eq!(
            changes.pointer("/models/best"),
            Some(&Value::Null),
            "cleared"
        );
        assert_eq!(
            changes.pointer("/searxng/url").and_then(Value::as_str),
            Some("http://searxng:8080"),
            "normalized"
        );
        Ok(())
    }

    #[test]
    fn refuses_search_without_address() {
        let body = json!({"searxng": {"enabled": true, "url": ""}});
        let refused = body.as_object().map(policy_changes);
        assert!(matches!(refused, Some(Err(_))), "needs an address");
    }

    #[test]
    fn reads_model_fields() -> Result<(), AiError> {
        let body = json!({"a": "m", "b": null, "c": "", "d": 3});
        let Some(obj) = body.as_object() else {
            return Err(AiError::input("fixture"));
        };
        assert_eq!(
            model_field(obj, "a")?,
            Change::Set(String::from("m")),
            "set"
        );
        assert_eq!(model_field(obj, "b")?, Change::Clear, "null clears");
        assert_eq!(model_field(obj, "c")?, Change::Clear, "blank clears");
        assert_eq!(model_field(obj, "x")?, Change::Keep, "absent keeps");
        assert!(model_field(obj, "d").is_err(), "wrong type");
        Ok(())
    }
}
