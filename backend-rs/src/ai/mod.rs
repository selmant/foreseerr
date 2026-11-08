//! AI connections: who may use which provider, with which model.
//!
//! Two layers:
//!
//! - the **server connection**, set up by an admin: an OpenAI-compatible
//!   endpoint (an `OpenAI` API key, `Ollama`, `OpenRouter`, ...) with Fast /
//!   Balanced / Best model presets. Everyone uses it by default when the
//!   admin shares it.
//! - a user's **own connection**: their `ChatGPT` account (Sign in with
//!   `ChatGPT`, using their plan) or, when the admin allows it, their own
//!   endpoint and key, with any model they like.
//!
//! A `ChatGPT` sign-in only ever serves the person who signed in: `OpenAI`'s
//! terms don't allow making an account available to others, so it can't
//! be the server connection.
//!
//! Nothing falls back silently: when a user chose their own connection and
//! it fails, they get the error, not the server's quota.

pub mod chatgpt;
pub mod compat;
pub mod dispatch;
pub mod recs;
pub mod responses;
pub mod store;

#[cfg(test)]
mod dispatchtests;

use std::fmt;

use serde_json::{json, Map, Value};

use crate::auth::CurrentUser;
use crate::settings::Settings;
use crate::state::AppState;
use crate::vault::{Secret, Vault};
use store::{Connection, Credentials, Kind, Owner, Prefs, Status};

/// `Permission.ADMIN`.
const ADMIN: i64 = 2;

/// What went wrong, in words fit for the person who asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    /// The request itself is wrong (bad URL, wrong model, cancelled sign-in).
    Input,
    /// No usable connection.
    NotConfigured,
    /// The `ChatGPT` sign-in has to be repeated.
    Reauth,
    /// The `ChatGPT` plan's (or this app's) usage limit was reached.
    UsageLimit,
    /// The account or workspace can't use `ChatGPT` plan usage.
    NotEligible,
    /// This server's daily limit on recommendation runs was reached.
    DailyLimit,
    /// Couldn't reach the provider, or it is temporarily unavailable.
    Network,
    /// The provider returned an error.
    Upstream,
    /// Something on this server failed.
    Internal,
}

impl ErrorKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Input => "input",
            Self::NotConfigured => "not_configured",
            Self::Reauth => "reauth",
            Self::UsageLimit => "usage_limit",
            Self::NotEligible => "not_eligible",
            Self::DailyLimit => "daily_limit",
            Self::Network => "unavailable",
            Self::Upstream => "upstream",
            Self::Internal => "internal",
        }
    }
}

/// An AI failure.
#[derive(Debug, Clone)]
pub struct AiError {
    /// The kind, which picks the HTTP status and the UI's recovery action.
    pub kind: ErrorKind,
    /// What to tell the user.
    pub message: String,
    /// An `OAuth` token endpoint error code, when there was one.
    token_code: Option<String>,
}

impl fmt::Display for AiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl AiError {
    fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            token_code: None,
        }
    }

    /// A bad request.
    pub fn input(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Input, message)
    }

    /// No usable connection.
    #[must_use]
    pub fn not_configured() -> Self {
        Self::new(ErrorKind::NotConfigured, "No AI connection is set up.")
    }

    /// Sign in again.
    pub fn reauth(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Reauth, message)
    }

    /// The `ChatGPT` usage limit.
    #[must_use]
    pub fn usage_limit() -> Self {
        Self::new(
            ErrorKind::UsageLimit,
            "You've reached the ChatGPT usage limit for your plan or for Foreseerr. Review it in ChatGPT settings.",
        )
    }

    /// This server's daily limit for the person was reached.
    #[must_use]
    pub fn daily_limit(limit: u32) -> Self {
        Self::new(
            ErrorKind::DailyLimit,
            format!("You've used today's {limit} AI requests on the server connection. They reset at midnight UTC, or connect your own account in Profile → AI."),
        )
    }

    /// The server connection's monthly token budget is used up.
    #[must_use]
    pub fn monthly_budget() -> Self {
        Self::new(
            ErrorKind::DailyLimit,
            "This server's AI budget for the month is used up. It resets on the 1st, or connect your own account in Profile → AI.",
        )
    }

    /// Not eligible for plan usage.
    pub fn not_eligible(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::NotEligible, message)
    }

    /// Unreachable or temporarily unavailable.
    pub fn network(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Network, message)
    }

    /// The provider's error.
    pub fn upstream(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Upstream, message)
    }

    /// This server's failure. The detail goes to the log, not the user.
    pub fn internal(detail: impl Into<String>) -> Self {
        let detail = detail.into();
        tracing::error!("AI: {detail}");
        Self::new(ErrorKind::Internal, "Something went wrong on the server.")
    }

    /// A token endpoint failure with its `OAuth` error code.
    #[must_use]
    pub fn token(code: String, status: u16) -> Self {
        let message = match code.as_str() {
            "invalid_grant" => "That sign-in code was already used or expired. Start again.",
            "invalid_client" => "ChatGPT didn't recognize Foreseerr's registration. Start again.",
            _ if status >= 500 => "ChatGPT's sign-in service had a problem. Try again shortly.",
            _ => "ChatGPT sign-in failed. Start again.",
        };
        Self {
            kind: if status >= 500 {
                ErrorKind::Network
            } else {
                ErrorKind::Input
            },
            message: message.to_owned(),
            token_code: Some(code),
        }
    }

    /// The `OAuth` error code, for token endpoint failures.
    #[must_use]
    pub fn token_code(&self) -> Option<&str> {
        self.token_code.as_deref()
    }

    /// The HTTP status the API answers with.
    #[must_use]
    pub const fn status(&self) -> u16 {
        match self.kind {
            ErrorKind::Input => 400,
            ErrorKind::NotConfigured | ErrorKind::Reauth => 409,
            ErrorKind::UsageLimit | ErrorKind::DailyLimit => 429,
            ErrorKind::NotEligible => 403,
            ErrorKind::Network | ErrorKind::Upstream => 502,
            ErrorKind::Internal => 500,
        }
    }

    /// The API body: `{message, code}`, plus where to manage `ChatGPT` usage
    /// when that's the way out.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut out = json!({"message": self.message, "code": self.kind.as_str()});
        if self.kind == ErrorKind::UsageLimit {
            if let Some(obj) = out.as_object_mut() {
                obj.insert(
                    String::from("manageUsageUrl"),
                    Value::from(MANAGE_USAGE_URL),
                );
            }
        }
        out
    }
}

/// Where `ChatGPT` users review and limit app usage.
pub const MANAGE_USAGE_URL: &str = "https://chatgpt.com/settings/usage";

/// At most `max` characters of `text`, with an ellipsis when cut.
#[must_use]
pub fn clip(text: &str, max: usize) -> String {
    let mut out: String = text.chars().take(max).collect();
    if text.chars().nth(max).is_some() {
        out.push('…');
    }
    out
}

/// Recommendation runs per person per day on the server connection, unless
/// the admin sets another limit.
pub const DEFAULT_DAILY_LIMIT: u32 = 30;
/// Discover AI rows are refreshed every this many days unless set.
pub const DEFAULT_ROW_REFRESH_DAYS: i64 = 3;
/// Finished requests are kept this many days unless set.
pub const DEFAULT_HISTORY_DAYS: i64 = 90;
/// The highest daily limit an admin may set.
pub const MAX_DAILY_LIMIT: u64 = 1000;

/// One request to a model.
#[derive(Debug, Clone, Copy)]
pub struct Prompt<'a> {
    /// The system instructions.
    pub instructions: &'a str,
    /// The user's input.
    pub input: &'a str,
    /// A JSON schema the answer must follow, with its name.
    pub schema: Option<(&'a str, &'a Value)>,
}

/// A model preset on the server connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Preset {
    /// Quick and cheap.
    Fast,
    /// The default.
    Balanced,
    /// The strongest model the admin offers.
    Best,
}

impl Preset {
    /// Every preset, in display order.
    pub const ALL: [Self; 3] = [Self::Fast, Self::Balanced, Self::Best];

    /// The API name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Fast => "fast",
            Self::Balanced => "balanced",
            Self::Best => "best",
        }
    }

    /// From the API name.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|p| p.as_str() == text)
    }
}

/// The admin's AI policy, from settings.json `ai`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[expect(clippy::struct_excessive_bools, reason = "independent admin switches")]
pub struct Policy {
    /// AI features are on.
    pub enabled: bool,
    /// Every user may use the server connection (else admins only).
    pub share_server_connection: bool,
    /// Users may connect their own `ChatGPT` account.
    pub allow_user_chatgpt: bool,
    /// Users may add their own endpoint. Off by default: it lets a user
    /// make this server call any address they choose.
    pub allow_user_endpoints: bool,
    /// Users may pick Fast / Balanced / Best on the server connection.
    pub allow_user_model_choice: bool,
    /// Preset models on the server connection (Balanced is its default
    /// model, kept on the connection row).
    pub fast_model: Option<String>,
    /// The Best preset's model.
    pub best_model: Option<String>,
    /// `SearXNG` web search is on.
    pub searxng_enabled: bool,
    /// The `SearXNG` base URL.
    pub searxng_url: String,
    /// Recommendation runs per person per day on the server connection
    /// (0: no limit). Admins and own connections aren't limited.
    pub daily_limit: u32,
    /// Tokens the server connection may use per month (0: no budget).
    pub monthly_token_budget: i64,
    /// Discover AI rows are refreshed after this many days.
    pub row_refresh_days: i64,
    /// The nightly job prepares rows ahead of time and makes weekly picks.
    pub auto_picks: bool,
    /// Finished requests are deleted after this many days (0: kept).
    pub history_days: i64,
}

impl Policy {
    /// The policy in these settings, defaults filled in.
    #[must_use]
    pub fn of(settings: &Settings) -> Self {
        let flag = |key: &str, default: bool| {
            settings
                .get(&format!("/ai/{key}"))
                .and_then(Value::as_bool)
                .unwrap_or(default)
        };
        let text = |pointer: &str| {
            settings
                .get(pointer)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        };
        Self {
            enabled: flag("enabled", false),
            share_server_connection: flag("shareServerConnection", true),
            allow_user_chatgpt: flag("allowUserChatgpt", true),
            allow_user_endpoints: flag("allowUserEndpoints", false),
            allow_user_model_choice: flag("allowUserModelChoice", true),
            fast_model: text("/ai/models/fast"),
            best_model: text("/ai/models/best"),
            searxng_enabled: settings
                .get("/ai/searxng/enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            searxng_url: text("/ai/searxng/url").unwrap_or_default(),
            daily_limit: settings
                .get("/ai/dailyLimit")
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n).ok())
                .unwrap_or(DEFAULT_DAILY_LIMIT),
            monthly_token_budget: settings
                .get("/ai/monthlyTokenBudget")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                .max(0),
            row_refresh_days: settings
                .get("/ai/rowRefreshDays")
                .and_then(Value::as_i64)
                .unwrap_or(DEFAULT_ROW_REFRESH_DAYS)
                .clamp(1, 30),
            auto_picks: flag("autoPicks", true),
            history_days: settings
                .get("/ai/historyDays")
                .and_then(Value::as_i64)
                .unwrap_or(DEFAULT_HISTORY_DAYS)
                .max(0),
        }
    }

    /// Whether this user may use their own connection of `kind`.
    #[must_use]
    pub const fn allows_own(&self, kind: Kind, user: &CurrentUser) -> bool {
        if user.permissions & ADMIN != 0 {
            return true;
        }
        match kind {
            Kind::ChatGpt => self.allow_user_chatgpt,
            Kind::OpenAi => self.allow_user_endpoints,
        }
    }

    /// Whether this user may use the server connection.
    #[must_use]
    pub const fn allows_server(&self, user: &CurrentUser) -> bool {
        self.share_server_connection || user.permissions & ADMIN != 0
    }

    fn preset_model(&self, preset: Preset, server: &Connection) -> Option<String> {
        match preset {
            Preset::Fast => self.fast_model.clone().or_else(|| server.model.clone()),
            Preset::Balanced => server.model.clone(),
            Preset::Best => self.best_model.clone().or_else(|| server.model.clone()),
        }
    }

    /// The presets as the API shows them: which exist and their models.
    #[must_use]
    pub fn presets_json(&self, server: Option<&Connection>) -> Value {
        let balanced = server.and_then(|c| c.model.clone());
        json!({
            "fast": self.fast_model.clone().or_else(|| balanced.clone()),
            "balanced": balanced,
            "best": self.best_model.clone().or_else(|| balanced.clone()),
        })
    }
}

/// Where a user's requests go.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// Their own connection.
    Own,
    /// The server connection.
    Server,
}

/// The connection and model a user's requests use.
#[derive(Debug, Clone)]
pub struct Effective {
    /// Own or server.
    pub source: Source,
    /// The connection.
    pub connection: Connection,
    /// The model (None when none was chosen yet).
    pub model: Option<String>,
    /// The preset picked on the server connection.
    pub preset: Option<Preset>,
}

/// Why a user has no usable connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unavailable {
    /// AI features are off.
    Disabled,
    /// They chose their own connection, and it's missing or not allowed.
    OwnMissing,
    /// They chose their own connection, and it needs a new sign-in.
    OwnNeedsSignIn,
    /// There's no server connection they may use.
    NoServerConnection,
}

impl Unavailable {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::OwnMissing => "own_missing",
            Self::OwnNeedsSignIn => "own_needs_sign_in",
            Self::NoServerConnection => "no_server_connection",
        }
    }
}

/// Resolve the connection a user's requests use.
///
/// # Errors
///
/// Fails on database errors.
pub async fn effective(
    state: &AppState,
    settings: &Settings,
    user: &CurrentUser,
) -> anyhow::Result<Result<Effective, Unavailable>> {
    let policy = Policy::of(settings);
    if !policy.enabled {
        return Ok(Err(Unavailable::Disabled));
    }
    let prefs = store::prefs(&state.db, user.id).await?;
    if prefs.use_own_connection {
        let own = store::load(&state.db, Owner::User(user.id)).await?;
        return Ok(match own {
            Some(c) if !policy.allows_own(c.kind, user) => Err(Unavailable::OwnMissing),
            Some(c) if c.status != Status::Ok => Err(Unavailable::OwnNeedsSignIn),
            Some(c) => Ok(Effective {
                source: Source::Own,
                model: c.model.clone(),
                connection: c,
                preset: None,
            }),
            None => Err(Unavailable::OwnMissing),
        });
    }
    if !policy.allows_server(user) {
        return Ok(Err(Unavailable::NoServerConnection));
    }
    let Some(server) = store::load(&state.db, Owner::Server).await? else {
        return Ok(Err(Unavailable::NoServerConnection));
    };
    let preset = policy
        .allow_user_model_choice
        .then(|| prefs.model.as_deref().and_then(Preset::parse))
        .flatten()
        .unwrap_or(Preset::Balanced);
    Ok(Ok(Effective {
        source: Source::Server,
        model: policy.preset_model(preset, &server),
        preset: Some(preset),
        connection: server,
    }))
}

/// The effective connection as the UI shows it on every AI surface:
/// whose connection, which provider, which model, whose quota.
#[must_use]
pub fn effective_json(resolved: &Result<Effective, Unavailable>) -> Value {
    match resolved {
        Ok(e) => json!({
            "available": true,
            "source": match e.source { Source::Own => "own", Source::Server => "server" },
            "kind": e.connection.kind.as_str(),
            "model": e.model,
            "preset": e.preset.map(Preset::as_str),
            "accountEmail": match e.source {
                Source::Own => e.connection.account_email.clone(),
                Source::Server => None,
            },
            "usesChatgptPlan": e.connection.kind == Kind::ChatGpt,
            "manageUsageUrl": (e.connection.kind == Kind::ChatGpt).then_some(MANAGE_USAGE_URL),
        }),
        Err(why) => json!({"available": false, "reason": why.as_str()}),
    }
}

/// A connection as its owner (or, for the server's, an admin) sees it:
/// never the credentials, only whether they're set.
#[must_use]
pub fn connection_json(conn: &Connection, vault: &Vault) -> Value {
    let mut out = Map::new();
    out.insert(String::from("kind"), Value::from(conn.kind.as_str()));
    out.insert(String::from("status"), Value::from(conn.status.as_str()));
    out.insert(String::from("model"), json!(conn.model));
    out.insert(String::from("lastError"), json!(conn.last_error));
    out.insert(String::from("updatedAt"), json!(conn.updated_at));
    out.insert(String::from("lastUsedAt"), json!(conn.last_used_at));
    match conn.kind {
        Kind::OpenAi => {
            out.insert(
                String::from("providerLabel"),
                Value::from(compat::provider_label(
                    conn.base_url.as_deref().unwrap_or(""),
                )),
            );
            out.insert(String::from("baseUrl"), json!(conn.base_url));
            out.insert(
                String::from("hasApiKey"),
                Value::Bool(conn.has_api_key(vault)),
            );
        }
        Kind::ChatGpt => {
            if let Value::Object(more) = chatgpt::describe(conn) {
                out.extend(more);
            }
            out.insert(
                String::from("manageUsageUrl"),
                Value::from(MANAGE_USAGE_URL),
            );
        }
    }
    Value::Object(out)
}

/// The server's credentials vault.
///
/// # Errors
///
/// Fails when the secret key can't be loaded.
pub fn vault(state: &AppState) -> Result<std::sync::Arc<Vault>, AiError> {
    crate::vault::get(&state.env.config_dir)
        .map_err(|e| AiError::internal(format!("the secret key didn't load: {e:#}")))
}

/// This installation's `ext_agent_host_id`, created on first use.
///
/// # Errors
///
/// Fails when settings can't be saved.
pub async fn host_id(state: &AppState) -> Result<String, AiError> {
    let current = state
        .settings
        .current()
        .await
        .map_err(|e| AiError::internal(format!("{e:#}")))?;
    if let Some(id) = current
        .get("/ai/hostId")
        .and_then(Value::as_str)
        .filter(|s| s.starts_with("urn:uuid:"))
    {
        return Ok(id.to_owned());
    }
    let fresh = format!(
        "urn:uuid:{}",
        crate::standalone::settingsfile::uuid_v4()
            .map_err(|e| AiError::internal(format!("{e:#}")))?
    );
    let mut chosen = fresh.clone();
    state
        .settings
        .update(|doc| {
            if let Some(obj) = doc.as_object_mut() {
                let ai = obj.entry("ai").or_insert_with(|| Value::Object(Map::new()));
                if let Some(ai) = ai.as_object_mut() {
                    match ai.get("hostId").and_then(Value::as_str) {
                        Some(existing) if existing.starts_with("urn:uuid:") => {
                            existing.clone_into(&mut chosen);
                        }
                        Some(_) | None => {
                            ai.insert(String::from("hostId"), Value::from(fresh));
                        }
                    }
                }
            }
        })
        .await
        .map_err(|e| AiError::internal(format!("saving the host id failed: {e:#}")))?;
    Ok(chosen)
}

fn api_key(conn: &Connection, vault: &Vault) -> Result<Option<Secret>, AiError> {
    match conn.credentials(vault) {
        Ok(Some(Credentials::ApiKey(k))) => Ok(Some(k)),
        Ok(Some(Credentials::ChatGpt(_)) | None) => Ok(None),
        Err(e) => Err(AiError::internal(format!(
            "AI credentials didn't open (was the secret key changed?): {e:#}"
        ))),
    }
}

/// The models a connection offers, as `(id, label)`.
///
/// # Errors
///
/// Fails when the provider can't be reached or refuses.
pub async fn models(state: &AppState, conn: &Connection) -> Result<Vec<(String, String)>, AiError> {
    let mut dispatch = state.ai_dispatch.request(conn.owner).await;
    dispatch.run(Box::pin(models_inner(state, conn))).await
}

/// Reload under the dispatch gate; a request queued behind removal must not
/// use its stale connection snapshot after that removal completes.
async fn connected(state: &AppState, conn: &Connection) -> Result<Connection, AiError> {
    let current = store::load(&state.db, conn.owner)
        .await
        .map_err(|e| AiError::internal(format!("{e:#}")))?
        .ok_or_else(AiError::not_configured)?;
    if current.id != conn.id
        || current.session_version != conn.session_version
        || current.base_url != conn.base_url
        || current.kind != conn.kind
        || current.status != conn.status
    {
        return Err(AiError::input(
            "Your AI connection changed while this request was working. Try again.",
        ));
    }
    Ok(current)
}

async fn models_inner(
    state: &AppState,
    conn: &Connection,
) -> Result<Vec<(String, String)>, AiError> {
    let current = connected(state, conn).await?;
    let conn = &current;
    let vault = vault(state)?;
    match conn.kind {
        Kind::ChatGpt => {
            let token = chatgpt::access_token(&state.outbound, &state.db, &vault, conn).await?;
            let result = chatgpt::models(&state.outbound, &token).await;
            if let Err(e) = &result {
                if e.kind == ErrorKind::Reauth {
                    if let Ok(Some(current)) = store::load(&state.db, conn.owner).await {
                        if matches!(current.credentials(&vault), Ok(Some(Credentials::ChatGpt(t))) if t.access_token == token)
                        {
                            if let Err(err) = store::set_status(
                                &state.db,
                                &current,
                                Status::Reauth,
                                Some(&e.message),
                                false,
                            )
                            .await
                            {
                                tracing::warn!("recording model-list rejection failed: {err:#}");
                            }
                        }
                    }
                }
            }
            result
        }
        Kind::OpenAi => {
            let base = conn
                .base_url
                .as_deref()
                .ok_or_else(AiError::not_configured)?;
            let key = api_key(conn, &vault)?;
            compat::models(&state.outbound, base, key.as_ref()).await
        }
    }
}

/// Tokens a provider reported for the prompts of one task.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Tokens {
    /// Prompt (input) tokens.
    pub input: i64,
    /// Answer (output) tokens.
    pub output: i64,
}

tokio::task_local! {
    static TOKENS: std::cell::Cell<Tokens>;
}

/// Add the usage a provider reported to the current [`counting`] scope (no
/// scope: nothing is kept).
pub fn note_tokens(input: i64, output: i64) {
    // Outside a scope there is nothing to add to.
    TOKENS
        .try_with(|cell| {
            let t = cell.get();
            cell.set(Tokens {
                input: t.input.saturating_add(input.max(0)),
                output: t.output.saturating_add(output.max(0)),
            });
        })
        .unwrap_or_default();
}

/// Run `work`, also returning the tokens its prompts used.
pub async fn counting<F: std::future::Future>(work: F) -> (F::Output, Tokens) {
    TOKENS
        .scope(std::cell::Cell::new(Tokens::default()), async {
            let out = work.await;
            (out, TOKENS.with(std::cell::Cell::get))
        })
        .await
}

/// Run one prompt on a connection and model. Records success (last used)
/// or the failure on the connection.
///
/// # Errors
///
/// Fails when no model is chosen or the provider fails.
pub async fn complete(
    state: &AppState,
    conn: &Connection,
    model: Option<&str>,
    prompt: &Prompt<'_>,
) -> Result<String, AiError> {
    let mut dispatch = state.ai_dispatch.request(conn.owner).await;
    dispatch
        .run(Box::pin(complete_inner(state, conn, model, prompt)))
        .await
}

async fn complete_inner(
    state: &AppState,
    conn: &Connection,
    model: Option<&str>,
    prompt: &Prompt<'_>,
) -> Result<String, AiError> {
    let current = connected(state, conn).await?;
    let conn = &current;
    let model = model
        .filter(|m| !m.is_empty())
        .ok_or_else(|| AiError::input("No model is chosen for this connection yet."))?;
    let vault = vault(state)?;
    let mut used_connection = conn.clone();
    // Token refreshes run inside, so their failures are recorded too.
    let result = async {
        match conn.kind {
            Kind::ChatGpt => {
                let token = chatgpt::access_token(&state.outbound, &state.db, &vault, conn).await?;
                // A refresh may have replaced the stored token set. Record
                // rejection against that generation, without touching a
                // different session that signed in meanwhile.
                if let Ok(Some(current)) = store::load(&state.db, conn.owner).await {
                    if matches!(current.credentials(&vault), Ok(Some(Credentials::ChatGpt(t))) if t.access_token == token) {
                        used_connection = current;
                    }
                }
                responses::complete(&state.outbound, &token, model, prompt).await
            }
            Kind::OpenAi => {
                let base = conn
                    .base_url
                    .as_deref()
                    .ok_or_else(AiError::not_configured)?;
                let key = api_key(conn, &vault)?;
                compat::complete(&state.outbound, base, key.as_ref(), model, prompt).await
            }
        }
    }
    .await;
    let recorded = match &result {
        Ok(_) => store::touch(&state.db, &used_connection).await,
        // OpenAI refused the token: show "Sign in again" instead of
        // "Connected" (credentials kept; only a new sign-in replaces them).
        Err(e)
            if e.kind == ErrorKind::Reauth
                && used_connection.kind == Kind::ChatGpt
                && used_connection.status == Status::Ok =>
        {
            store::set_status(
                &state.db,
                &used_connection,
                Status::Reauth,
                Some(&e.message),
                false,
            )
            .await
            .map(drop)
        }
        Err(e) if e.kind != ErrorKind::Input => {
            store::set_error(&state.db, &used_connection, Some(&e.message)).await
        }
        Err(_) => Ok(()),
    };
    if let Err(e) = recorded {
        tracing::warn!("recording AI connection use failed: {e:#}");
    }
    result
}

/// Check a connection end to end: list models, then (when a model is
/// chosen) send a tiny prompt.
///
/// # Errors
///
/// Fails with the first step that fails.
pub async fn test(
    state: &AppState,
    conn: &Connection,
    model: Option<&str>,
) -> Result<Value, AiError> {
    let model = model.filter(|m| !m.is_empty());
    // Some endpoints serve completions but not the model list: with a
    // model chosen, a listing failure doesn't stop the real check.
    let listed = match models(state, conn).await {
        Ok(list) => list.len(),
        Err(e) if model.is_none() || e.kind == ErrorKind::Reauth => return Err(e),
        Err(e) => {
            tracing::info!("listing models failed during a connection test: {e}");
            0
        }
    };
    let mut out = json!({"ok": true, "models": listed});
    if let Some(model) = model {
        let answer = complete(
            state,
            conn,
            Some(model),
            &Prompt {
                instructions: "You are a connectivity check. Reply with exactly: OK",
                input: "Reply with OK.",
                schema: None,
            },
        )
        .await?;
        if let Some(obj) = out.as_object_mut() {
            obj.insert(String::from("model"), Value::from(model));
            obj.insert(String::from("reply"), Value::from(clip(answer.trim(), 40)));
        }
    }
    Ok(out)
}

/// Before a user is deleted: revoke their `ChatGPT` session at `OpenAI`.
///
/// The row (and the refresh token) goes with the user and couldn't be
/// revoked afterwards. Best effort; an unconfirmed revocation is logged so
/// the admin can tell the person to remove Foreseerr in `ChatGPT`.
pub async fn revoke_for_deleted_user(state: &AppState, user_id: i64) {
    let conn = match store::load(&state.db, Owner::User(user_id)).await {
        Ok(Some(c)) if c.kind == Kind::ChatGpt && c.has_credentials() => c,
        Ok(_) => return,
        Err(e) => {
            tracing::warn!("loading the AI connection of deleted user {user_id} failed: {e:#}");
            return;
        }
    };
    let confirmed = match vault(state) {
        Ok(v) => chatgpt::revoke(&state.outbound, &v, &conn).await,
        Err(_) => false,
    };
    if confirmed {
        tracing::info!("Revoked the ChatGPT session of deleted user {user_id}");
    } else {
        tracing::warn!(
            "Couldn't confirm revoking the ChatGPT session of deleted user {user_id}. They can remove Foreseerr in their ChatGPT settings."
        );
    }
}

/// A user's preferences as the API returns them.
#[must_use]
pub fn prefs_json(prefs: &Prefs) -> Value {
    prefs.to_json()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(permissions: i64) -> CurrentUser {
        CurrentUser {
            id: 5,
            permissions,
            webpush_enabled: false,
            locale: None,
        }
    }

    #[test]
    fn policy_defaults_are_conservative() -> anyhow::Result<()> {
        let settings = Settings::from_file_value(json!({}), None)?;
        let p = Policy::of(&settings);
        assert!(!p.enabled, "off until an admin turns it on");
        assert!(p.allow_user_chatgpt, "own ChatGPT allowed");
        assert!(!p.allow_user_endpoints, "custom endpoints need opting in");
        assert!(
            !p.allows_own(Kind::OpenAi, &user(0)),
            "user endpoint blocked"
        );
        assert!(
            p.allows_own(Kind::OpenAi, &user(ADMIN)),
            "admins always may"
        );
        Ok(())
    }

    #[test]
    fn errors_carry_recovery() {
        let limit = AiError::usage_limit().to_json();
        assert_eq!(
            limit.get("manageUsageUrl").and_then(Value::as_str),
            Some(MANAGE_USAGE_URL),
            "manage link"
        );
        assert_eq!(AiError::reauth("x").status(), 409, "reauth status");
        assert_eq!(clip("abcdef", 3), "abc…", "clip");
        assert_eq!(clip("ab", 3), "ab", "short");
    }
}
