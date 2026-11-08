//! The `ai_connection` and `ai_user_settings` tables.
//!
//! A connection belongs to the server (`userId` NULL, at most one) or to
//! one user. Its credentials (an API key, or a `ChatGPT` token set) are kept
//! sealed with [`crate::vault`], bound to the owner, and only opened to
//! make a request for that owner.

use std::sync::LazyLock;

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Map, Value};

use crate::db::{Bind, Db};
use crate::vault::{Purpose, Secret, Vault};

/// Serializes connection writes, so the server's single row can't be
/// inserted twice by two admins at once.
static WRITES: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

/// Who a connection belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Owner {
    /// The server's connection, set up by an admin.
    Server,
    /// One user's own connection.
    User(i64),
}

impl Owner {
    /// What sealed values of this owner are bound to.
    #[must_use]
    pub fn context(self) -> String {
        match self {
            Self::Server => String::from("ai-connection:server"),
            Self::User(id) => format!("ai-connection:user:{id}"),
        }
    }

    fn filter(self) -> (&'static str, Vec<Bind>) {
        match self {
            Self::Server => (r#""userId" IS NULL"#, vec![]),
            Self::User(id) => (r#""userId" = ?1"#, vec![Bind::Int(id)]),
        }
    }
}

/// The kind of provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Sign in with `ChatGPT`: the account's `ChatGPT` plan, Responses API.
    ChatGpt,
    /// Any OpenAI-compatible endpoint: base URL, optional key.
    OpenAi,
}

impl Kind {
    /// The stored and API name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ChatGpt => "chatgpt",
            Self::OpenAi => "openai",
        }
    }

    /// From the stored or API name.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "chatgpt" => Some(Self::ChatGpt),
            "openai" => Some(Self::OpenAi),
            _ => None,
        }
    }
}

/// Whether a connection can be used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// Usable.
    Ok,
    /// `ChatGPT`: the token set expired or was revoked; sign in again.
    Reauth,
    /// `ChatGPT`: signed in, but use of the `ChatGPT` plan wasn't allowed.
    PlanDisabled,
    /// `ChatGPT`: signed out; the registration is kept for the next sign-in.
    SignedOut,
}

impl Status {
    /// The stored and API name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Reauth => "reauth",
            Self::PlanDisabled => "plan_disabled",
            Self::SignedOut => "signed_out",
        }
    }

    fn parse(text: &str) -> Self {
        match text {
            "reauth" => Self::Reauth,
            "plan_disabled" => Self::PlanDisabled,
            "signed_out" => Self::SignedOut,
            _ => Self::Ok,
        }
    }
}

/// A connection row, credentials still sealed.
#[derive(Debug, Clone)]
pub struct Connection {
    /// Row id.
    pub id: i64,
    /// Whose it is.
    pub owner: Owner,
    /// Provider kind.
    pub kind: Kind,
    /// `OpenAI`-compatible base URL (ending in `/v1` or similar).
    pub base_url: Option<String>,
    /// The connection's default model.
    pub model: Option<String>,
    sealed: Option<String>,
    /// `ChatGPT`: the issued `OAuth` client id of this account's registration.
    pub client_id: Option<String>,
    /// `ChatGPT`: the verified account subject.
    pub account_subject: Option<String>,
    /// `ChatGPT`: the account email, for display.
    pub account_email: Option<String>,
    /// `ChatGPT`: the account name, for display.
    pub account_name: Option<String>,
    /// Usability.
    pub status: Status,
    /// The last failure, for the owner's settings page.
    pub last_error: Option<String>,
    /// When it last changed (ISO).
    pub updated_at: Option<String>,
    /// When it last served a request (ISO).
    pub last_used_at: Option<String>,
}

/// Opened credentials.
#[derive(Debug, Clone)]
pub enum Credentials {
    /// An API key (may be empty for keyless local servers).
    ApiKey(Secret),
    /// A `ChatGPT` token set.
    ChatGpt(TokenSet),
}

/// A `ChatGPT` `OAuth` token set.
#[derive(Debug, Clone)]
pub struct TokenSet {
    /// Bearer token for the Responses API (one hour).
    pub access_token: Secret,
    /// Rotating refresh token (30 days).
    pub refresh_token: Secret,
    /// The last ID token, kept for `id_token_hint`.
    pub id_token: Secret,
    /// Access token expiry, Unix seconds.
    pub expires_at: i64,
    /// Granted scopes.
    pub scopes: Vec<String>,
}

impl Credentials {
    fn to_secret(&self) -> Secret {
        let value = match self {
            Self::ApiKey(key) => json!({"apiKey": key.expose()}),
            Self::ChatGpt(t) => json!({
                "accessToken": t.access_token.expose(),
                "refreshToken": t.refresh_token.expose(),
                "idToken": t.id_token.expose(),
                "expiresAt": t.expires_at,
                "scopes": t.scopes,
            }),
        };
        Secret::new(value.to_string())
    }

    fn from_secret(kind: Kind, secret: &Secret) -> Result<Self> {
        let value: Value =
            serde_json::from_str(secret.expose()).context("stored credentials are not JSON")?;
        let text = |key: &str| {
            value
                .get(key)
                .and_then(Value::as_str)
                .map(|s| Secret::new(s.to_owned()))
                .ok_or_else(|| anyhow!("stored credentials lack {key}"))
        };
        match kind {
            Kind::OpenAi => Ok(Self::ApiKey(text("apiKey")?)),
            Kind::ChatGpt => Ok(Self::ChatGpt(TokenSet {
                access_token: text("accessToken")?,
                refresh_token: text("refreshToken")?,
                id_token: text("idToken")?,
                expires_at: value.get("expiresAt").and_then(Value::as_i64).unwrap_or(0),
                scopes: value
                    .get("scopes")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default(),
            })),
        }
    }
}

impl Connection {
    /// Whether credentials are stored.
    #[must_use]
    pub const fn has_credentials(&self) -> bool {
        self.sealed.is_some()
    }

    /// Open the stored credentials.
    ///
    /// # Errors
    ///
    /// Fails when they don't open (another key, another row) or don't parse.
    pub fn credentials(&self, vault: &Vault) -> Result<Option<Credentials>> {
        let Some(sealed) = self.sealed.as_deref() else {
            return Ok(None);
        };
        let secret = vault.open(Purpose::AiCredential, &self.owner.context(), sealed)?;
        Credentials::from_secret(self.kind, &secret).map(Some)
    }

    /// Whether an API key is stored and non-empty (for display only).
    #[must_use]
    pub fn has_api_key(&self, vault: &Vault) -> bool {
        matches!(self.credentials(vault), Ok(Some(Credentials::ApiKey(k))) if !k.is_empty())
    }

    fn from_row(row: &Map<String, Value>) -> Option<Self> {
        let text = |key: &str| row.get(key).and_then(Value::as_str).map(str::to_owned);
        let owner = row
            .get("userId")
            .and_then(Value::as_i64)
            .map_or(Owner::Server, Owner::User);
        Some(Self {
            id: row.get("id").and_then(Value::as_i64)?,
            owner,
            kind: Kind::parse(row.get("kind").and_then(Value::as_str)?)?,
            base_url: text("baseUrl"),
            model: text("model").filter(|m| !m.is_empty()),
            sealed: text("credentials").filter(|c| !c.is_empty()),
            client_id: text("clientId"),
            account_subject: text("accountSubject"),
            account_email: text("accountEmail"),
            account_name: text("accountName"),
            status: Status::parse(row.get("status").and_then(Value::as_str).unwrap_or("ok")),
            last_error: text("lastError"),
            updated_at: text("updatedAt"),
            last_used_at: text("lastUsedAt"),
        })
    }
}

/// The `ChatGPT` account a token set belongs to.
#[derive(Debug, Clone)]
pub struct Identity {
    /// Issued client id.
    pub client_id: String,
    /// Verified `sub`.
    pub subject: String,
    /// Email claim.
    pub email: Option<String>,
    /// Name claim.
    pub name: Option<String>,
}

/// Load an owner's connection.
///
/// # Errors
///
/// Fails on database errors.
pub async fn load(db: &Db, owner: Owner) -> Result<Option<Connection>> {
    let (filter, binds) = owner.filter();
    let updated = db.iso_sql(r#""updatedAt""#);
    let used = db.iso_sql(r#""lastUsedAt""#);
    let sql = format!(
        r#"SELECT "id", "userId", "kind", "baseUrl", "model", "credentials", "clientId", "accountSubject", "accountEmail", "accountName", "status", "lastError", {updated} AS "updatedAt", {used} AS "lastUsedAt" FROM "ai_connection" WHERE {filter} ORDER BY "id" LIMIT 1"#
    );
    let rows = db.rows(&sql, &binds).await?;
    Ok(rows.first().and_then(Connection::from_row))
}

/// What a write sets on an owner's connection.
#[derive(Debug, Clone)]
pub struct Write {
    /// Provider kind.
    pub kind: Kind,
    /// Base URL (`OpenAI`-compatible only).
    pub base_url: Option<String>,
    /// Default model.
    pub model: Option<String>,
    /// New credentials, or `None` to keep the stored ones.
    pub credentials: Option<Option<Credentials>>,
    /// `ChatGPT` identity, or `None` to keep it.
    pub identity: Option<Identity>,
    /// Status after the write.
    pub status: Status,
}

/// Insert or replace an owner's connection. Changing the kind drops the
/// other kind's leftovers (credentials and identity).
///
/// # Errors
///
/// Fails on database errors or when sealing fails.
pub async fn save(db: &Db, vault: &Vault, owner: Owner, write: Write) -> Result<()> {
    let guard = WRITES.lock().await;
    let existing = load(db, owner).await?;
    let same_kind = existing.as_ref().is_some_and(|c| c.kind == write.kind);
    let sealed = match &write.credentials {
        Some(Some(creds)) => {
            Some(vault.seal(Purpose::AiCredential, &owner.context(), &creds.to_secret())?)
        }
        None if same_kind => existing.as_ref().and_then(|c| c.sealed.clone()),
        Some(None) | None => None,
    };
    let keep =
        |f: fn(&Connection) -> Option<String>| existing.as_ref().filter(|_| same_kind).and_then(f);
    let (client_id, subject, email, name) = write.identity.as_ref().map_or_else(
        || {
            (
                keep(|c| c.client_id.clone()),
                keep(|c| c.account_subject.clone()),
                keep(|c| c.account_email.clone()),
                keep(|c| c.account_name.clone()),
            )
        },
        |i| {
            (
                Some(i.client_id.clone()),
                Some(i.subject.clone()),
                i.email.clone(),
                i.name.clone(),
            )
        },
    );
    let user = match owner {
        Owner::Server => None,
        Owner::User(id) => Some(id),
    };
    let binds = [
        Bind::Text(write.kind.as_str().to_owned()),
        Bind::OptText(write.base_url),
        Bind::OptText(write.model),
        Bind::OptText(sealed),
        Bind::OptText(client_id),
        Bind::OptText(subject),
        Bind::OptText(email),
        Bind::OptText(name),
        Bind::Text(write.status.as_str().to_owned()),
        Bind::OptInt(user),
    ];
    if let Some(row) = existing {
        let mut binds = binds.to_vec();
        binds.push(Bind::Int(row.id));
        db.execute(
            r#"UPDATE "ai_connection" SET "kind" = ?1, "baseUrl" = ?2, "model" = ?3, "credentials" = ?4, "clientId" = ?5, "accountSubject" = ?6, "accountEmail" = ?7, "accountName" = ?8, "status" = ?9, "lastError" = NULL, "userId" = ?10, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?11"#,
            &binds,
        )
        .await?;
    } else {
        db.execute(
            r#"INSERT INTO "ai_connection" ("kind", "baseUrl", "model", "credentials", "clientId", "accountSubject", "accountEmail", "accountName", "status", "userId") VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"#,
            &binds,
        )
        .await?;
    }
    drop(guard);
    Ok(())
}

/// Replace a `ChatGPT` connection's token set after a refresh, all fields
/// together.
///
/// # Errors
///
/// Fails on database errors or when sealing fails.
pub async fn replace_tokens(
    db: &Db,
    vault: &Vault,
    conn: &Connection,
    tokens: &TokenSet,
) -> Result<()> {
    let sealed = vault.seal(
        Purpose::AiCredential,
        &conn.owner.context(),
        &Credentials::ChatGpt(tokens.clone()).to_secret(),
    )?;
    db.execute(
        r#"UPDATE "ai_connection" SET "credentials" = ?1, "status" = 'ok', "lastError" = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?2"#,
        &[Bind::Text(sealed), Bind::Int(conn.id)],
    )
    .await?;
    Ok(())
}

/// Set a connection's status, dropping its credentials when `clear`.
///
/// # Errors
///
/// Fails on database errors.
pub async fn set_status(
    db: &Db,
    conn: &Connection,
    status: Status,
    error: Option<&str>,
    clear: bool,
) -> Result<()> {
    let sql = if clear {
        r#"UPDATE "ai_connection" SET "status" = ?1, "lastError" = ?2, "credentials" = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?3"#
    } else {
        r#"UPDATE "ai_connection" SET "status" = ?1, "lastError" = ?2, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?3"#
    };
    db.execute(
        sql,
        &[
            Bind::Text(status.as_str().to_owned()),
            Bind::OptText(error.map(str::to_owned)),
            Bind::Int(conn.id),
        ],
    )
    .await?;
    Ok(())
}

/// Record the last failure without changing the status.
///
/// # Errors
///
/// Fails on database errors.
pub async fn set_error(db: &Db, conn: &Connection, error: Option<&str>) -> Result<()> {
    db.execute(
        r#"UPDATE "ai_connection" SET "lastError" = ?1 WHERE "id" = ?2"#,
        &[Bind::OptText(error.map(str::to_owned)), Bind::Int(conn.id)],
    )
    .await?;
    Ok(())
}

/// Note that a connection served a request.
///
/// # Errors
///
/// Fails on database errors.
pub async fn touch(db: &Db, conn: &Connection) -> Result<()> {
    db.execute(
        r#"UPDATE "ai_connection" SET "lastUsedAt" = CURRENT_TIMESTAMP, "lastError" = NULL WHERE "id" = ?1"#,
        &[Bind::Int(conn.id)],
    )
    .await?;
    Ok(())
}

/// Set a connection's default model.
///
/// # Errors
///
/// Fails on database errors.
pub async fn set_model(db: &Db, conn: &Connection, model: Option<&str>) -> Result<()> {
    db.execute(
        r#"UPDATE "ai_connection" SET "model" = ?1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?2"#,
        &[Bind::OptText(model.map(str::to_owned)), Bind::Int(conn.id)],
    )
    .await?;
    Ok(())
}

/// Delete an owner's connection.
///
/// # Errors
///
/// Fails on database errors.
pub async fn delete(db: &Db, owner: Owner) -> Result<()> {
    let (filter, binds) = owner.filter();
    db.execute(
        &format!(r#"DELETE FROM "ai_connection" WHERE {filter}"#),
        &binds,
    )
    .await?;
    Ok(())
}

/// A user's AI preferences.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Prefs {
    /// Use their own connection instead of the server's.
    pub use_own_connection: bool,
    /// The model they picked on the server connection.
    pub model: Option<String>,
    /// They agreed to send their watch history and ratings to the provider.
    pub use_history: bool,
    /// When they agreed (ISO).
    pub history_consent_at: Option<String>,
}

impl Prefs {
    /// As the API returns it.
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "useOwnConnection": self.use_own_connection,
            "model": self.model,
            "useHistory": self.use_history,
            "historyConsentAt": self.history_consent_at,
        })
    }
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_i64().is_some_and(|n| n != 0),
        Some(_) | None => false,
    }
}

/// A user's preferences (defaults when none were saved).
///
/// # Errors
///
/// Fails on database errors.
pub async fn prefs(db: &Db, user_id: i64) -> Result<Prefs> {
    let consent = db.iso_sql(r#""historyConsentAt""#);
    let rows = db
        .rows(
            &format!(
                r#"SELECT "useOwnConnection", "model", "useHistory", {consent} AS "historyConsentAt" FROM "ai_user_settings" WHERE "userId" = ?1"#
            ),
            &[Bind::Int(user_id)],
        )
        .await?;
    Ok(rows.first().map_or_else(Prefs::default, |row| Prefs {
        use_own_connection: truthy(row.get("useOwnConnection")),
        model: row
            .get("model")
            .and_then(Value::as_str)
            .filter(|m| !m.is_empty())
            .map(str::to_owned),
        use_history: truthy(row.get("useHistory")),
        history_consent_at: row
            .get("historyConsentAt")
            .and_then(Value::as_str)
            .map(str::to_owned),
    }))
}

/// Save a user's preferences. Turning history on stamps the consent time;
/// turning it off clears it.
///
/// # Errors
///
/// Fails on database errors.
pub async fn save_prefs(db: &Db, user_id: i64, prefs: &Prefs) -> Result<()> {
    let previous = self::prefs(db, user_id).await?;
    let consent_sql = match (previous.use_history, prefs.use_history) {
        (false, true) => "CURRENT_TIMESTAMP",
        (true, true) => r#""historyConsentAt""#,
        (_, false) => "NULL",
    };
    let binds = [
        Bind::Bool(prefs.use_own_connection),
        Bind::OptText(prefs.model.clone()),
        Bind::Bool(prefs.use_history),
        Bind::Int(user_id),
    ];
    let updated = db
        .execute(
            &format!(
                r#"UPDATE "ai_user_settings" SET "useOwnConnection" = ?1, "model" = ?2, "useHistory" = ?3, "historyConsentAt" = {consent_sql}, "updatedAt" = CURRENT_TIMESTAMP WHERE "userId" = ?4"#
            ),
            &binds,
        )
        .await?;
    if updated == 0 {
        let consent_sql = if prefs.use_history {
            "CURRENT_TIMESTAMP"
        } else {
            "NULL"
        };
        db.execute(
            &format!(
                r#"INSERT INTO "ai_user_settings" ("useOwnConnection", "model", "useHistory", "historyConsentAt", "userId") VALUES (?1, ?2, ?3, {consent_sql}, ?4)"#
            ),
            &binds,
        )
        .await?;
    }
    Ok(())
}
