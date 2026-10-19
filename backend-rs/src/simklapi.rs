//! The authenticated half of `server/api/simkl` (`SimklAPI.request`, the
//! PIN and AUTH V2 endpoints) and the token helpers of
//! `server/lib/simkl.ts`: user clients, refresh, and clearing a link.
//!
//! AUTH V2 access tokens last seven days. A client built for a V2 link
//! refreshes a day before expiry (best-effort while the token still
//! works) and once after a 401; refreshes for one user are serialized,
//! because a refresh kills the grant's previous access token.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex, PoisonError};
use std::time::Duration;

use serde_json::{Map, Value};

use crate::db::{Bind, Db};
use crate::routes::procstate::KeyLock;
use crate::settings::Settings;

/// `SIMKL_BASE_URL`.
pub const BASE_URL: &str = "https://api.simkl.com";
/// `SIMKL_OAUTH2_SCOPE`: Foreseerr writes history and ratings.
const SCOPE: &str = "media:read media:write";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
/// `SIMKL_REFRESH_WINDOW_SECONDS`: Simkl suggests refreshing a day early.
const REFRESH_WINDOW_SECONDS: i64 = 24 * 60 * 60;
/// `SIMKL_ERROR_DETAIL_LIMIT`.
const DETAIL_LIMIT: usize = 200;

/// `SimklNotConfiguredError`'s message.
pub const NOT_CONFIGURED: &str = "Simkl is turned off";

/// `SIMKL_BUILTIN_CLIENT_ID`: Foreseerr's own Simkl AUTH V2 app.
///
/// "TV, devices & command line", no secret. Simkl wants one Client ID per
/// app rather than one per install: AUTH V2 counts quota per user, and a
/// public client ID is meant to ship.
pub const BUILTIN_CLIENT_ID: &str =
    "7bb0499fc59c9bbd0f6112270b389aa2500efd1b0c2d47ee7167358c9c056b38";
pub const NOT_LINKED: &str = "User has not linked a Simkl account";

/// `simklRefreshLock`.
static REFRESH_LOCK: LazyLock<KeyLock> = LazyLock::new(KeyLock::default);

/// The errors `SimklAPI` throws.
#[derive(Debug, Clone, PartialEq)]
pub enum Failure {
    /// `SimklRateLimitedError`, with its retry delay in seconds.
    RateLimited(f64),
    /// `SimklUnauthorizedError`.
    Unauthorized,
    /// `SimklTemporarilyUnavailableError`.
    Unavailable,
    /// `SimklRequestError`: Simkl (or a proxy) refused the request.
    Rejected { status: u16, detail: Option<String> },
    /// `SimklOAuthError`: an AUTH V2 endpoint answered an RFC 6749 error.
    OAuth {
        status: u16,
        code: String,
        detail: Option<String>,
    },
    /// Anything else (database failures), as text.
    Other(String),
}

impl Failure {
    /// The error's `message`.
    #[must_use]
    pub fn message(&self) -> String {
        match self {
            Self::RateLimited(seconds) => format!(
                "Simkl API rate limited; retry after {}s",
                crate::jsnum::to_string(*seconds)
            ),
            Self::Unauthorized => {
                String::from("Simkl authorization was rejected; reconnect the linked account")
            }
            Self::Unavailable => String::from("Simkl is temporarily unavailable"),
            Self::Rejected { status, detail } | Self::OAuth { status, detail, .. } => {
                format!(
                    "Simkl rejected the request (HTTP {status}){}",
                    detail
                        .as_deref()
                        .map(|d| format!(": {d}"))
                        .unwrap_or_default()
                )
            }
            Self::Other(text) => text.clone(),
        }
    }

    /// `instanceof SimklRequestError` (which `SimklOAuthError` extends).
    #[must_use]
    pub const fn is_request_error(&self) -> bool {
        matches!(self, Self::Rejected { .. } | Self::OAuth { .. })
    }

    /// The OAuth `error` code, when this is one.
    #[must_use]
    pub fn oauth_code(&self) -> Option<&str> {
        match self {
            Self::OAuth { code, .. } => Some(code),
            Self::RateLimited(_)
            | Self::Unauthorized
            | Self::Unavailable
            | Self::Rejected { .. }
            | Self::Other(_) => None,
        }
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

impl std::error::Error for Failure {}

/// `isSimklV1ClientError`: V2 rejects a V1 Client ID (and an unknown one)
/// as `invalid_client`.
#[must_use]
pub fn is_v1_client_error(failure: &Failure) -> bool {
    failure.oauth_code() == Some("invalid_client")
}

/// What axios would hand back as `data`: JSON when it parses, else text.
fn response_data(text: &str) -> Value {
    serde_json::from_str::<Value>(text)
        .map_or_else(|_| Value::String(text.to_owned()), crate::tmdb::js_numbers)
}

/// `simklErrorDetail`: `{ error, message }` (V1), `{ error,
/// error_description }` (V2), or a proxy's HTML or text.
#[must_use]
pub fn error_detail(data: &Value) -> Option<String> {
    static TAGS: LazyLock<Option<regex::Regex>> =
        LazyLock::new(|| regex::Regex::new(r"<[^>]*>").ok());
    let text = match data {
        Value::Object(map) => {
            let description = match map.get("error_description") {
                None | Some(Value::Null) => map.get("message"),
                other => other,
            };
            [map.get("error"), description]
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" — ")
        }
        Value::String(text) => TAGS
            .as_ref()
            .map_or(std::borrow::Cow::Borrowed(text.as_str()), |tags| {
                tags.replace_all(text, " ")
            })
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" "),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::Array(_) => String::new(),
    };
    (!text.is_empty()).then(|| text.chars().take(DETAIL_LIMIT).collect())
}

/// The `Retry-After` delay Node reads: at least a second.
fn retry_after(res: &reqwest::Response) -> f64 {
    let after = res
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .map_or(f64::NAN, crate::jsval::number_of_str);
    if after.is_nan() || after == 0.0 {
        1.0
    } else {
        after.max(1.0)
    }
}

/// `simklClientIdFor(clientId)`: the administrator's own Client ID, else
/// the built-in one.
#[must_use]
pub fn client_id_for(client_id: &str) -> String {
    let own = crate::jsval::trim(client_id);
    if own.is_empty() {
        String::from(BUILTIN_CLIENT_ID)
    } else {
        own.to_owned()
    }
}

/// `effectiveSimklClientId(settings.simkl)` over the `simkl` object: the
/// Client ID Simkl calls use, or `""` while Simkl is turned off. `None`
/// for a `clientId` that isn't text (Node's `trim()` throws).
#[must_use]
pub fn effective_client_id_of(simkl: Option<&Value>) -> Option<String> {
    if simkl.and_then(|s| s.get("enabled")) == Some(&Value::Bool(false)) {
        return Some(String::new());
    }
    match simkl.and_then(|s| s.get("clientId")) {
        None | Some(Value::Null) => Some(String::from(BUILTIN_CLIENT_ID)),
        Some(Value::String(own)) => Some(client_id_for(own)),
        Some(_) => None,
    }
}

/// [`effective_client_id_of`] for the loaded settings.
#[must_use]
pub fn effective_client_id(settings: &Settings) -> Option<String> {
    effective_client_id_of(settings.get("/simkl"))
}

/// The `network.apiRequestTimeout` setting.
#[must_use]
pub fn timeout_of(settings: &Settings) -> Option<Duration> {
    settings
        .get("/network/apiRequestTimeout")
        .and_then(Value::as_u64)
        .filter(|ms| *ms > 0)
        .map(Duration::from_millis)
}

/// What every Simkl client shares: the app's credentials and transport.
#[derive(Debug, Clone)]
pub struct Config {
    http: reqwest::Client,
    base: String,
    client_id: String,
    version: String,
    timeout: Option<Duration>,
}

impl Config {
    /// A client for `client_id` (already trimmed and non-empty).
    #[must_use]
    pub fn new(
        http: &reqwest::Client,
        client_id: &str,
        version: &str,
        timeout: Option<Duration>,
    ) -> Self {
        Self {
            http: http.clone(),
            base: String::from(BASE_URL),
            client_id: client_id.to_owned(),
            version: version.to_owned(),
            timeout,
        }
    }

    /// The same against another host (tests).
    #[must_use]
    pub fn with_base(mut self, base: &str) -> Self {
        base.clone_into(&mut self.base);
        self
    }

    /// A client without a user token (`new SimklAPI()`).
    #[must_use]
    pub fn anonymous(&self) -> Client {
        Client::new(self.clone(), None, None, None)
    }

    /// A client with `accessToken` and nothing to refresh or clear.
    #[must_use]
    pub fn with_token(&self, token: &str) -> Client {
        Client::new(self.clone(), Some(token.to_owned()), None, None)
    }

    /// `client_id`, `app-name`, `app-version` as a query.
    fn required_parameters(&self) -> String {
        format!(
            "client_id={}&app-name=foreseerr&app-version={}",
            crate::jsval::form_encode(&self.client_id),
            crate::jsval::form_encode(&self.version)
        )
    }

    fn builder(&self, method: reqwest::Method, url: &str) -> reqwest::RequestBuilder {
        let mut req = self
            .http
            .request(method, url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header("simkl-api-key", &self.client_id)
            .header("app-name", "foreseerr")
            .header("app-version", &self.version)
            .header(
                reqwest::header::USER_AGENT,
                format!("Foreseerr/{} (Simkl integration)", self.version),
            );
        if let Some(timeout) = self.timeout {
            req = req.timeout(timeout);
        }
        req
    }
}

/// An access token and when it expires (Unix seconds; `None` for V1
/// tokens, which do not).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenState {
    pub access_token: String,
    pub expires_at: Option<i64>,
}

/// The stored link a user client belongs to.
#[derive(Debug, Clone)]
struct Link {
    db: Db,
    settings_id: i64,
    user_id: i64,
    /// A V2 link: it carries a refresh token.
    refreshable: bool,
}

/// A `SimklAPI` instance.
#[derive(Debug)]
pub struct Client {
    config: Config,
    token: Mutex<Option<TokenState>>,
    link: Option<Link>,
    unauthorized_handled: AtomicBool,
    next_at: tokio::sync::Mutex<Option<tokio::time::Instant>>,
}

fn guard<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Unix seconds now.
fn now_seconds() -> i64 {
    crate::clock::now_millis().div_euclid(1000)
}

impl Client {
    fn new(
        config: Config,
        access_token: Option<String>,
        expires_at: Option<i64>,
        link: Option<Link>,
    ) -> Self {
        Self {
            config,
            token: Mutex::new(access_token.map(|access_token| TokenState {
                access_token,
                expires_at,
            })),
            link,
            unauthorized_handled: AtomicBool::new(false),
            next_at: tokio::sync::Mutex::new(None),
        }
    }

    fn access_token(&self) -> Option<String> {
        guard(&self.token).as_ref().map(|t| t.access_token.clone())
    }

    /// `pace(post)`: requests of one client at least 100 ms (1 s after a
    /// POST) apart.
    async fn pace(&self, post: bool) {
        let mut next = self.next_at.lock().await;
        if let Some(at) = *next {
            tokio::time::sleep_until(at).await;
        }
        let interval = Duration::from_millis(if post { 1000 } else { 100 });
        *next = Some(tokio::time::Instant::now() + interval);
    }

    /// `refresh()`: swap in the token `refreshUserSimklTokens` returns.
    async fn refresh(&self) -> Result<(), Failure> {
        let Some(link) = self.link.as_ref().filter(|l| l.refreshable) else {
            return Ok(());
        };
        let Some(stale) = self.access_token() else {
            return Ok(());
        };
        let fresh = refresh_user_tokens(&link.db, &self.config, link.user_id, &stale).await?;
        *guard(&self.token) = Some(fresh);
        Ok(())
    }

    /// `ensureFreshToken()`: refreshing early is a courtesy; until it
    /// expires the current token still serves the request.
    async fn ensure_fresh_token(&self) -> Result<(), Failure> {
        let now = now_seconds();
        let expires_at = guard(&self.token).as_ref().and_then(|t| t.expires_at);
        let Some(expires_at) = expires_at else {
            return Ok(());
        };
        if !self.link.as_ref().is_some_and(|l| l.refreshable)
            || expires_at > now + REFRESH_WINDOW_SECONDS
        {
            return Ok(());
        }
        match self.refresh().await {
            Err(e) if e == Failure::Unauthorized || expires_at <= now => Err(e),
            Ok(()) | Err(_) => Ok(()),
        }
    }

    /// `onUnauthorized`, once: drop the link and the user's synced rows.
    async fn unauthorized(&self) {
        let Some(link) = &self.link else {
            return;
        };
        if self.unauthorized_handled.swap(true, Ordering::SeqCst) {
            return;
        }
        let cleared = async {
            clear_credentials(&link.db, link.settings_id, None).await?;
            clear_sync_cache(&link.db, link.user_id).await
        };
        if let Err(e) = cleared.await {
            tracing::error!("clearing the rejected Simkl link failed: {e:#}");
        }
    }

    /// `request(method, path, body)`: a POST when there is a body; one
    /// retry for a GET that got no answer or a 5xx, and one after a 401
    /// with a refreshed token (a 401 rejected the request before applying
    /// it, so even a write is safe to repeat).
    ///
    /// # Errors
    ///
    /// Node's Simkl errors.
    pub async fn request(&self, path: &str, body: Option<&Value>) -> Result<Value, Failure> {
        let post = body.is_some();
        self.pace(post).await;
        let separator = if path.contains('?') { '&' } else { '?' };
        let url = format!(
            "{}{path}{separator}{}",
            self.config.base,
            self.config.required_parameters()
        );
        self.ensure_fresh_token().await?;
        let mut refreshed_after_unauthorized = false;
        let mut first = true;
        loop {
            let method = if post {
                reqwest::Method::POST
            } else {
                reqwest::Method::GET
            };
            let mut req = self
                .config
                .builder(method, &url)
                .header(reqwest::header::CONTENT_TYPE, "application/json");
            if let Some(token) = self.access_token() {
                req = req.header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"));
            }
            if let Some(body) = body {
                req = req.body(body.to_string());
            }
            let (status, data) = match req.send().await {
                Ok(res) if res.status().is_success() => {
                    let text = res.text().await.unwrap_or_default();
                    return Ok(response_data(&text));
                }
                Ok(res) => {
                    let status = res.status().as_u16();
                    if status == 429 {
                        return Err(Failure::RateLimited(retry_after(&res)));
                    }
                    let text = res.text().await.unwrap_or_default();
                    (Some(status), response_data(&text))
                }
                Err(_) => (None, Value::Null),
            };
            if status == Some(401) {
                if !refreshed_after_unauthorized
                    && self.link.as_ref().is_some_and(|l| l.refreshable)
                {
                    refreshed_after_unauthorized = true;
                    self.refresh().await?;
                    continue;
                }
                self.unauthorized().await;
                return Err(Failure::Unauthorized);
            }
            let temporary = status.is_none_or(|s| s >= 500);
            if !post && first && temporary {
                first = false;
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }
            return Err(match status {
                Some(status) if !temporary => Failure::Rejected {
                    status,
                    detail: error_detail(&data),
                },
                _ => Failure::Unavailable,
            });
        }
    }

    /// `oauth2Post(path, params)`: a form POST to an AUTH V2 endpoint.
    /// Their 401 is about the app, not a user, so it never clears a link.
    async fn oauth2_post(&self, path: &str, params: &[(&str, &str)]) -> Result<Value, Failure> {
        self.pace(true).await;
        let url = format!(
            "{}{path}?{}",
            self.config.base,
            self.config.required_parameters()
        );
        let form = std::iter::once(("client_id", self.config.client_id.as_str()))
            .chain(params.iter().copied())
            .map(|(k, v)| {
                format!(
                    "{}={}",
                    crate::jsval::form_encode(k),
                    crate::jsval::form_encode(v)
                )
            })
            .collect::<Vec<_>>()
            .join("&");
        let mut req = self
            .config
            .builder(reqwest::Method::POST, &url)
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/x-www-form-urlencoded",
            )
            .body(form);
        if let Some(token) = self.access_token() {
            req = req.header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"));
        }
        let Ok(res) = req.send().await else {
            return Err(Failure::Unavailable);
        };
        let status = res.status().as_u16();
        if res.status().is_success() {
            let text = res.text().await.unwrap_or_default();
            return Ok(response_data(&text));
        }
        if status == 429 {
            return Err(Failure::RateLimited(retry_after(&res)));
        }
        let text = res.text().await.unwrap_or_default();
        let data = response_data(&text);
        let code = data
            .get("error")
            .and_then(Value::as_str)
            .filter(|c| !c.is_empty());
        if let Some(code) = code {
            return Err(Failure::OAuth {
                status,
                code: code.to_owned(),
                detail: error_detail(&data),
            });
        }
        if status >= 500 {
            return Err(Failure::Unavailable);
        }
        Err(Failure::Rejected {
            status,
            detail: error_detail(&data),
        })
    }

    /// `validateClientId()`: both PIN endpoints check the Client ID. V2
    /// answers `invalid_client` for V1 apps and unknown IDs alike, so the
    /// V1 endpoint (412 `client_id_failed`) settles which one it is.
    ///
    /// # Errors
    ///
    /// Simkl's refusal.
    pub async fn validate_client_id(&self) -> Result<(), Failure> {
        match self.request_device_code().await {
            Ok(_) => Ok(()),
            Err(e) if is_v1_client_error(&e) => self.request_pin_code().await.map(drop),
            Err(e) => Err(e),
        }
    }

    /// `requestDeviceCode()`: AUTH V2 device flow.
    ///
    /// # Errors
    ///
    /// `invalid_client` for a V1 Client ID.
    pub async fn request_device_code(&self) -> Result<Value, Failure> {
        self.oauth2_post("/oauth2/device", &[("scope", SCOPE)])
            .await
    }

    /// `pollDeviceToken(deviceCode)`.
    ///
    /// # Errors
    ///
    /// `authorization_pending`, `slow_down` or `expired_token` until done.
    pub async fn poll_device_token(&self, device_code: &str) -> Result<Value, Failure> {
        self.oauth2_post(
            "/oauth2/token",
            &[("grant_type", DEVICE_GRANT), ("device_code", device_code)],
        )
        .await
    }

    /// `refreshAccessToken(refreshToken)`: non-rotating.
    ///
    /// # Errors
    ///
    /// `invalid_grant` once the grant is gone.
    pub async fn refresh_access_token(&self, refresh_token: &str) -> Result<Value, Failure> {
        self.oauth2_post(
            "/oauth2/token",
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token),
            ],
        )
        .await
    }

    /// `revokeToken(token)`: revokes the whole grant.
    ///
    /// # Errors
    ///
    /// Transport failures.
    pub async fn revoke_token(&self, token: &str) -> Result<(), Failure> {
        self.oauth2_post("/oauth2/revoke", &[("token", token)])
            .await
            .map(drop)
    }

    /// `requestPinCode()`: the V1 PIN flow.
    ///
    /// # Errors
    ///
    /// Node's Simkl errors.
    pub async fn request_pin_code(&self) -> Result<Value, Failure> {
        self.request("/oauth/pin", None).await
    }

    /// `pollPinToken(userCode)`.
    ///
    /// # Errors
    ///
    /// Node's Simkl errors.
    pub async fn poll_pin_token(&self, user_code: &str) -> Result<Value, Failure> {
        let path = format!(
            "/oauth/pin/{}",
            crate::ratings::encode_uri_component(user_code)
        );
        self.request(&path, None).await
    }

    /// `getUserSettings()`.
    ///
    /// # Errors
    ///
    /// Node's Simkl errors.
    pub async fn user_settings(&self) -> Result<Value, Failure> {
        self.request("/users/settings", Some(&Value::Object(Map::new())))
            .await
    }
}

/// The user's link columns.
#[derive(Debug, Clone, Default)]
struct StoredLink {
    settings_id: i64,
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_at: Option<i64>,
}

fn non_empty(row: &Map<String, Value>, key: &str) -> Option<String> {
    row.get(key)
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
}

/// `getUserSimklSettings(userId)`.
async fn stored_link(db: &Db, user_id: i64) -> anyhow::Result<Option<StoredLink>> {
    let rows = db
        .rows(
            r#"SELECT CAST("id" AS BIGINT) AS "id", "simklAccessToken", "simklRefreshToken",
                      CAST("simklTokenExpiresAt" AS BIGINT) AS "simklTokenExpiresAt"
               FROM "user_settings" WHERE "userId" = ?1 LIMIT 1"#,
            &[Bind::Int(user_id)],
        )
        .await?;
    Ok(rows.into_iter().next().map(|row| StoredLink {
        settings_id: row.get("id").and_then(Value::as_i64).unwrap_or(0),
        access_token: non_empty(&row, "simklAccessToken"),
        refresh_token: non_empty(&row, "simklRefreshToken"),
        expires_at: row
            .get("simklTokenExpiresAt")
            .and_then(Value::as_i64)
            .filter(|n| *n != 0),
    }))
}

/// `createSimklUserClient(userId)` for an app `config`.
///
/// # Errors
///
/// `User has not linked a Simkl account`, or a database failure.
pub async fn user_client(db: &Db, config: &Config, user_id: i64) -> Result<Client, String> {
    let link = stored_link(db, user_id)
        .await
        .map_err(|e| format!("{e:#}"))?;
    let Some((link, token)) = link.and_then(|l| l.access_token.clone().map(|t| (l, t))) else {
        return Err(String::from(NOT_LINKED));
    };
    Ok(Client::new(
        config.clone(),
        Some(token),
        link.expires_at,
        Some(Link {
            db: db.clone(),
            settings_id: link.settings_id,
            user_id,
            refreshable: link.refresh_token.is_some(),
        }),
    ))
}

/// `simklTokenColumns(tokens)`: the access token, plus the refresh token
/// and expiry (Unix seconds) only for a V2 token response.
#[must_use]
pub fn token_columns(tokens: &Value) -> (Value, Value, Value) {
    let access = tokens.get("access_token").cloned().unwrap_or(Value::Null);
    let refresh = tokens
        .get("refresh_token")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(Value::Null);
    let expires_in = tokens
        .get("expires_in")
        .and_then(Value::as_f64)
        .filter(|n| *n != 0.0 && !n.is_nan());
    let expires_at = match (crate::settings::public::truthy(Some(&refresh)), expires_in) {
        (true, Some(seconds)) => {
            crate::jsval::to_i64((crate::jsnum::from_i64(now_seconds()) + seconds).floor())
                .map_or(Value::Null, Value::from)
        }
        _ => Value::Null,
    };
    (access, refresh, expires_at)
}

/// `refreshUserSimklTokens(userId, staleAccessToken)`: refresh one user's
/// AUTH V2 access token exactly once. Whoever queued behind a refresh
/// reuses the token it stored.
///
/// # Errors
///
/// `Unauthorized` once the link is gone or Simkl rejected the grant
/// (which unlinks it); the refresh's own failure otherwise.
pub async fn refresh_user_tokens(
    db: &Db,
    config: &Config,
    user_id: i64,
    stale_access_token: &str,
) -> Result<TokenState, Failure> {
    let _held = REFRESH_LOCK.acquire(user_id).await;
    let other = |e: anyhow::Error| Failure::Other(format!("{e:#}"));
    let link = stored_link(db, user_id).await.map_err(other)?;
    let Some((link, access, refresh)) = link.and_then(|l| {
        let access = l.access_token.clone()?;
        let refresh = l.refresh_token.clone()?;
        Some((l, access, refresh))
    }) else {
        return Err(Failure::Unauthorized);
    };
    if access != stale_access_token {
        return Ok(TokenState {
            access_token: access,
            expires_at: link.expires_at,
        });
    }
    let tokens = match config.anonymous().refresh_access_token(&refresh).await {
        Ok(tokens) => tokens,
        // `invalid_grant`: revoked, or idle past its 180 days.
        // `invalid_client`: the app itself is gone. Only a new link helps.
        Err(e) if matches!(e.oauth_code(), Some("invalid_grant" | "invalid_client")) => {
            tracing::warn!(
                "Simkl refresh token rejected; account must reconnect (user {user_id}, {})",
                e.oauth_code().unwrap_or_default()
            );
            // Unless the user relinked meanwhile: the new link is not affected.
            if clear_credentials(db, link.settings_id, Some(stale_access_token))
                .await
                .map_err(other)?
            {
                clear_sync_cache(db, user_id).await.map_err(other)?;
            }
            return Err(Failure::Unauthorized);
        }
        Err(e) => return Err(e),
    };
    let mut tokens = tokens;
    if let Value::Object(map) = &mut tokens {
        // Non-rotating, but keep ours should a response ever omit it.
        if map.get("refresh_token").is_none_or(Value::is_null) {
            map.insert(String::from("refresh_token"), Value::String(refresh));
        }
    }
    let (access, refresh, expires_at) = token_columns(&tokens);
    let Some(access_text) = access.as_str().map(str::to_owned) else {
        return Err(Failure::Other(String::from(
            "Simkl answered the refresh without an access token",
        )));
    };
    // Link and unlink do not take the lock; neither may be undone by a
    // refresh that was already in flight.
    let updated = db
        .execute(
            r#"UPDATE "user_settings" SET "simklAccessToken" = ?1, "simklRefreshToken" = ?2,
                   "simklTokenExpiresAt" = ?3 WHERE "id" = ?4 AND "simklAccessToken" = ?5"#,
            &[
                Bind::Text(access_text.clone()),
                Bind::OptText(refresh.as_str().map(str::to_owned)),
                Bind::OptInt(expires_at.as_i64()),
                Bind::Int(link.settings_id),
                Bind::Text(stale_access_token.to_owned()),
            ],
        )
        .await
        .map_err(other)?;
    if updated == 0 {
        return Err(Failure::Unauthorized);
    }
    Ok(TokenState {
        access_token: access_text,
        expires_at: expires_at.as_i64(),
    })
}

/// `clearUserSimklCredentials(settingsId, accessToken?)`: with a token,
/// only while that token is still the stored one. Whether a row changed.
///
/// # Errors
///
/// Database failures.
pub async fn clear_credentials(
    db: &Db,
    settings_id: i64,
    access_token: Option<&str>,
) -> anyhow::Result<bool> {
    const SET: &str = r#"UPDATE "user_settings" SET "simklAccessToken" = NULL, "simklRefreshToken" = NULL,
           "simklTokenExpiresAt" = NULL, "simklUsername" = NULL, "simklUserId" = NULL WHERE "id" = ?1"#;
    let changed = match access_token {
        Some(token) => {
            db.execute(
                &format!(r#"{SET} AND "simklAccessToken" = ?2"#),
                &[Bind::Int(settings_id), Bind::Text(token.to_owned())],
            )
            .await?
        }
        None => db.execute(SET, &[Bind::Int(settings_id)]).await?,
    };
    Ok(changed > 0)
}

/// `clearUserSimklSyncCache(userId)`.
///
/// # Errors
///
/// Database failures.
pub async fn clear_sync_cache(db: &Db, user_id: i64) -> anyhow::Result<()> {
    for table in ["simkl_sync_item", "simkl_sync_state"] {
        db.execute(
            &format!(r#"DELETE FROM "{table}" WHERE "userId" = ?1"#),
            &[Bind::Int(user_id)],
        )
        .await?;
    }
    Ok(())
}

/// The refresh token stored for a user, if any (to revoke on unlink).
///
/// # Errors
///
/// Database failures.
pub async fn stored_refresh_token(db: &Db, user_id: i64) -> anyhow::Result<Option<String>> {
    Ok(stored_link(db, user_id)
        .await?
        .and_then(|l| l.refresh_token))
}

#[cfg(test)]
mod tests;
