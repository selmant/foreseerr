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

/// Serializes connection and preference writes that read before they
/// write (check a destination or an account, then save), so two requests
/// can't interleave: the server's single row can't be inserted twice, and a
/// stale edit can't save over a newer one.
static WRITES: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

/// Proof that [`lock`] is held. Hold it across the read and the write it
/// guards; never across a network call.
#[derive(Debug)]
pub struct WriteGuard(
    #[expect(dead_code, reason = "held only for its drop, which releases the lock")]
    tokio::sync::MutexGuard<'static, ()>,
);

/// Take the connection write lock.
pub async fn lock() -> WriteGuard {
    WriteGuard(WRITES.lock().await)
}

/// The SQL condition (and its bind) that a row still holds the credentials
/// a request read, so a write based on that read can't undo a newer
/// sign-in, sign-out or refresh.
fn same_generation(conn: &Connection, param: usize) -> (String, Option<Bind>) {
    conn.sealed.as_ref().map_or_else(
        || (String::from(r#""credentials" IS NULL"#), None),
        |sealed| {
            (
                format!(r#""credentials" = ?{param}"#),
                Some(Bind::Text(sealed.clone())),
            )
        },
    )
}

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
    /// The last ID token (refreshes may omit a new one).
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

/// Insert or replace an owner's connection.
///
/// Changing the kind drops the other kind's leftovers (credentials and
/// identity). The caller holds [`lock`] from the checks this write depends
/// on until it returns.
///
/// # Errors
///
/// Fails on database errors or when sealing fails.
pub async fn save(
    db: &Db,
    vault: &Vault,
    owner: Owner,
    write: Write,
    _held: &WriteGuard,
) -> Result<()> {
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
    Ok(())
}

/// Replace a `ChatGPT` connection's token set after a refresh.
///
/// All fields change together, unless the row changed since `conn` was
/// read (signed out, signed in again, or refreshed by another request).
/// Returns whether it was written.
///
/// # Errors
///
/// Fails on database errors or when sealing fails.
pub async fn replace_tokens(
    db: &Db,
    vault: &Vault,
    conn: &Connection,
    tokens: &TokenSet,
    status: Status,
) -> Result<bool> {
    let sealed = vault.seal(
        Purpose::AiCredential,
        &conn.owner.context(),
        &Credentials::ChatGpt(tokens.clone()).to_secret(),
    )?;
    let (same, bind) = same_generation(conn, 4);
    let mut binds = vec![
        Bind::Text(sealed),
        Bind::Text(status.as_str().to_owned()),
        Bind::Int(conn.id),
    ];
    binds.extend(bind);
    let written = db
        .execute(
            &format!(
                r#"UPDATE "ai_connection" SET "credentials" = ?1, "status" = ?2, "lastError" = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?3 AND {same}"#
            ),
            &binds,
        )
        .await?;
    Ok(written > 0)
}

/// Set a connection's status, dropping its credentials when `clear`,
/// unless the row's credentials changed since `conn` was read. Returns
/// whether it was written.
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
) -> Result<bool> {
    let creds = if clear {
        r#", "credentials" = NULL"#
    } else {
        ""
    };
    let (same, bind) = same_generation(conn, 4);
    let mut binds = vec![
        Bind::Text(status.as_str().to_owned()),
        Bind::OptText(error.map(str::to_owned)),
        Bind::Int(conn.id),
    ];
    binds.extend(bind);
    let written = db
        .execute(
            &format!(
                r#"UPDATE "ai_connection" SET "status" = ?1, "lastError" = ?2{creds}, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?3 AND {same}"#
            ),
            &binds,
        )
        .await?;
    Ok(written > 0)
}

/// Record the last failure without changing the status.
///
/// # Errors
///
/// Fails on database errors.
pub async fn set_error(db: &Db, conn: &Connection, error: Option<&str>) -> Result<()> {
    let (same, bind) = same_generation(conn, 3);
    let mut binds = vec![Bind::OptText(error.map(str::to_owned)), Bind::Int(conn.id)];
    binds.extend(bind);
    db.execute(
        &format!(r#"UPDATE "ai_connection" SET "lastError" = ?1 WHERE "id" = ?2 AND {same}"#),
        &binds,
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
    let (same, bind) = same_generation(conn, 2);
    let mut binds = vec![Bind::Int(conn.id)];
    binds.extend(bind);
    db.execute(
        &format!(r#"UPDATE "ai_connection" SET "lastUsedAt" = CURRENT_TIMESTAMP, "lastError" = NULL WHERE "id" = ?1 AND {same}"#),
        &binds,
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

/// A change to some of a user's preferences; `None` leaves a field as it is.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PrefsChange {
    /// Use their own connection.
    pub use_own_connection: Option<bool>,
    /// The preset on the server connection (`Some(None)` clears it).
    pub model: Option<Option<String>>,
    /// Send their history.
    pub use_history: Option<bool>,
}

/// Apply a change to a user's preferences in one statement.
///
/// Fields the change doesn't name are never rewritten from a stale read.
/// Turning history on stamps the consent time (kept if it was already on);
/// turning it off clears it.
///
/// # Errors
///
/// Fails on database errors.
pub async fn update_prefs(db: &Db, user_id: i64, change: &PrefsChange) -> Result<()> {
    // The row first, if missing; a concurrent first save just finds it.
    db.execute(
        r#"INSERT INTO "ai_user_settings" ("useOwnConnection", "model", "useHistory", "historyConsentAt", "userId") VALUES (?1, NULL, ?2, NULL, ?3) ON CONFLICT ("userId") DO NOTHING"#,
        &[Bind::Bool(false), Bind::Bool(false), Bind::Int(user_id)],
    )
    .await?;
    let mut sets: Vec<String> = Vec::new();
    let mut binds = vec![Bind::Int(user_id)];
    if let Some(own) = change.use_own_connection {
        binds.push(Bind::Bool(own));
        sets.push(format!(r#""useOwnConnection" = ?{}"#, binds.len()));
    }
    if let Some(model) = &change.model {
        binds.push(Bind::OptText(model.clone()));
        sets.push(format!(r#""model" = ?{}"#, binds.len()));
    }
    if let Some(history) = change.use_history {
        // SET reads the old row, so this sees whether it was already on.
        sets.push(String::from(if history {
            r#""historyConsentAt" = CASE WHEN "useHistory" THEN "historyConsentAt" ELSE CURRENT_TIMESTAMP END"#
        } else {
            r#""historyConsentAt" = NULL"#
        }));
        binds.push(Bind::Bool(history));
        sets.push(format!(r#""useHistory" = ?{}"#, binds.len()));
    }
    if sets.is_empty() {
        return Ok(());
    }
    db.execute(
        &format!(
            r#"UPDATE "ai_user_settings" SET {}, "updatedAt" = CURRENT_TIMESTAMP WHERE "userId" = ?1"#,
            sets.join(", ")
        ),
        &binds,
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::KeySource;

    async fn database() -> Result<Db> {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?;
        let db = Db::Sqlite(pool);
        crate::dbmigrate::run(&db, &crate::dbmigrate::migrations(&db)).await?;
        db.execute(r#"INSERT INTO "user" ("id", "email", "permissions", "userType", "avatar") VALUES (1, 'test@example.test', 0, 1, '')"#, &[]).await?;
        Ok(db)
    }

    fn tokens(label: &str) -> TokenSet {
        TokenSet {
            access_token: Secret::new(format!("access-{label}")),
            refresh_token: Secret::new(format!("refresh-{label}")),
            id_token: Secret::new(format!("id-{label}")),
            expires_at: i64::MAX,
            scopes: vec![String::from("test")],
        }
    }

    async fn save_session(db: &Db, vault: &Vault, label: &str) -> Result<Connection> {
        let held = lock().await;
        save(
            db,
            vault,
            Owner::User(1),
            Write {
                kind: Kind::ChatGpt,
                base_url: None,
                model: None,
                credentials: Some(Some(Credentials::ChatGpt(tokens(label)))),
                identity: None,
                status: Status::Ok,
            },
            &held,
        )
        .await?;
        load(db, Owner::User(1))
            .await?
            .ok_or_else(|| anyhow!("missing saved connection"))
    }

    #[tokio::test]
    async fn stale_refresh_and_signout_preserve_new_sessions() -> Result<()> {
        let db = database().await?;
        let vault = Vault::from_master(&[7; 32], KeySource::Env)?;
        let old = save_session(&db, &vault, "old").await?;
        assert!(set_status(&db, &old, Status::SignedOut, None, true).await?);
        assert!(!replace_tokens(&db, &vault, &old, &tokens("stale"), Status::Ok).await?);
        assert_eq!(
            load(&db, old.owner).await?.map(|c| c.status),
            Some(Status::SignedOut)
        );
        let new = save_session(&db, &vault, "new").await?;
        assert!(!set_status(&db, &old, Status::SignedOut, None, true).await?);
        assert!(!set_status(&db, &old, Status::Reauth, None, true).await?);
        assert!(!replace_tokens(&db, &vault, &old, &tokens("stale"), Status::Ok).await?);
        let current = load(&db, old.owner)
            .await?
            .ok_or_else(|| anyhow!("missing connection"))?;
        assert_eq!(current.sealed, new.sealed);
        assert_eq!(current.status, Status::Ok);
        Ok(())
    }

    #[tokio::test]
    async fn overlapping_preference_changes_preserve_history_optout() -> Result<()> {
        let db = database().await?;
        let own = PrefsChange {
            use_own_connection: Some(true),
            ..PrefsChange::default()
        };
        let history = PrefsChange {
            use_history: Some(true),
            ..PrefsChange::default()
        };
        let (a, b) = tokio::join!(update_prefs(&db, 1, &own), update_prefs(&db, 1, &history));
        a?;
        b?;
        let before = prefs(&db, 1).await?;
        assert!(before.use_own_connection && before.use_history);
        assert!(before.history_consent_at.is_some());
        let model = PrefsChange {
            model: Some(Some(String::from("fast"))),
            ..PrefsChange::default()
        };
        let off = PrefsChange {
            use_history: Some(false),
            ..PrefsChange::default()
        };
        let (a, b) = tokio::join!(update_prefs(&db, 1, &model), update_prefs(&db, 1, &off));
        a?;
        b?;
        let after = prefs(&db, 1).await?;
        assert!(after.use_own_connection);
        assert!(!after.use_history);
        assert_eq!(after.history_consent_at, None);
        assert_eq!(after.model.as_deref(), Some("fast"));
        Ok(())
    }

    #[tokio::test]
    async fn database_enforces_one_server_connection() -> Result<()> {
        let db = database().await?;
        let sql = r#"INSERT INTO "ai_connection" ("kind", "userId") VALUES ('openai', NULL)"#;
        db.execute(sql, &[]).await?;
        assert!(db.execute(sql, &[]).await.is_err());
        db.execute(
            r#"INSERT INTO "ai_connection" ("kind", "userId") VALUES ('openai', 1)"#,
            &[],
        )
        .await?;
        Ok(())
    }
}
