//! The device-style account links of `server/routes/user/usersettings.ts`.
//!
//! Trakt's device OAuth (`POST .../linked-accounts/trakt/device/code` and
//! `/token`, with `server/lib/trakt/deviceAuthThrottle.ts`) and Simkl's PIN
//! flow (`/simkl/pin/code` and `/token`).
//!
//! Both keep sessions, poll intervals and rate-limit buckets in process
//! memory. With Node behind this server that memory is Node's, so these
//! routes go to Node; standalone, the state lives here.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use axum::http::Method;
use serde_json::{json, Map, Value};

use super::accountlink::{forward, guard, js_eq, validated_body, Guard, UserParam};
use super::authcommon::{axios_data, Native};
use super::{Outcome, Ready, Table};
use crate::db::Bind;
use crate::jsnum;
use crate::typeorm::{self, Changes};

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    (
        "/api/v1/user/{id}/settings/linked-accounts/trakt/device/code",
        Method::POST,
        trakt_code,
    ),
    (
        "/api/v1/user/{id}/settings/linked-accounts/trakt/device/token",
        Method::POST,
        trakt_token,
    ),
    (
        "/api/v1/user/{id}/settings/linked-accounts/simkl/pin/code",
        Method::POST,
        simkl_code,
    ),
    (
        "/api/v1/user/{id}/settings/linked-accounts/simkl/pin/token",
        Method::POST,
        simkl_token,
    ),
];

macro_rules! try_outcome {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(outcome) => return *outcome,
        }
    };
}

const TRAKT_BASE_URL: &str = "https://api.trakt.tv";
/// The user agent of Trakt's bare `axios.create()` client.
const AXIOS_USER_AGENT: &str = "axios/1.18.0";
const TRAKT_TIMEOUT: Duration = Duration::from_secs(15);
const TRAKT_REFRESH_WINDOW_SECONDS: f64 = 300.0;
const TRAKT_RETRY_AFTER_MAX_SECONDS: u64 = 5;
const TRAKT_RATE_LIMIT_FALLBACK_SECONDS: u64 = 1;
const TRAKT_DEVICE_CODE_MAX_PER_WINDOW: u32 = 5;
const TRAKT_DEVICE_CODE_WINDOW_MS: f64 = 15.0 * 60.0 * 1000.0;
const TRAKT_DEVICE_POLL_MAX_PER_MINUTE: u32 = 30;
const TRAKT_DEVICE_POLL_WINDOW_MS: f64 = 60.0 * 1000.0;
const TRAKT_DEVICE_SLOW_DOWN_SECONDS: f64 = 10.0;
const JELLYFIN_PROVIDER: &str =
    "Trakt is provided by Better Trakt through Jellyfin. Link Trakt in Jellyfin instead.";
const TRAKT_START_FAILED: &str = "Unable to start Trakt device authorization.";
const TRAKT_FINISH_FAILED: &str = "Unable to complete Trakt device authorization.";
const SIMKL_NOT_CONFIGURED: &str = "Simkl application Client ID is not configured";

// ---------------------------------------------------------------------------
// Process state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
struct DeviceSession {
    interval_seconds: f64,
    expires_at: f64,
}

#[derive(Debug, Clone, Copy)]
struct PollState {
    last_poll_at: f64,
    interval_seconds: f64,
}

#[derive(Debug, Clone, Copy)]
struct Bucket {
    count: u32,
    window_start: f64,
}

/// `deviceAuthThrottle.ts`'s maps.
#[derive(Debug, Default)]
struct TraktThrottle {
    sessions: HashMap<String, DeviceSession>,
    polls: HashMap<String, PollState>,
    code_buckets: HashMap<String, Bucket>,
    poll_buckets: HashMap<String, Bucket>,
}

/// AUTH V2 device flow, or the V1 PIN flow for apps registered before V2.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PinFlow {
    Device,
    Pin,
}

/// `simklPinSessions`' entries.
#[derive(Debug, Clone)]
struct PinSession {
    flow: PinFlow,
    /// V2's secret `device_code`, or V1's user code; never sent to the
    /// browser.
    poll_code: String,
    expires_at: f64,
    interval_seconds: f64,
    last_poll_at: f64,
}

static TRAKT: LazyLock<Mutex<TraktThrottle>> = LazyLock::new(Mutex::default);
static SIMKL_PINS: LazyLock<Mutex<HashMap<String, PinSession>>> = LazyLock::new(Mutex::default);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `Math.max(a, b)`: `NaN` wins.
const fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// A JSON value's JavaScript truthiness.
fn truthy(value: Option<&Value>) -> bool {
    crate::settings::public::truthy(value)
}

/// `a ?? b` over JSON (missing and `null` are nullish).
fn nullish_or<'v>(a: Option<&'v Value>, b: Option<&'v Value>) -> Option<&'v Value> {
    a.filter(|v| !v.is_null()).or(b)
}

/// `value.key` where the value may be anything.
fn prop<'v>(value: Option<&'v Value>, key: &str) -> Option<&'v Value> {
    value.and_then(Value::as_object).and_then(|m| m.get(key))
}

/// `sessionKey(userId, deviceCode)` / `simklPinKey`.
fn session_key(user: f64, device_code: &str) -> String {
    format!("{}:{device_code}", jsnum::to_string(user))
}

/// `consumeRateLimit`.
fn consume(buckets: &mut HashMap<String, Bucket>, key: String, max: u32, window_ms: f64) -> bool {
    let now = jsnum::now();
    match buckets.get_mut(&key) {
        Some(bucket) if now - bucket.window_start < window_ms => {
            if bucket.count >= max {
                return false;
            }
            bucket.count += 1;
            true
        }
        Some(_) | None => {
            buckets.insert(
                key,
                Bucket {
                    count: 1,
                    window_start: now,
                },
            );
            true
        }
    }
}

/// `String(req.body.deviceCode ?? '').trim()`.
fn body_device_code(body: &Map<String, Value>) -> String {
    let value = match body.get("deviceCode") {
        None | Some(Value::Null) => String::new(),
        Some(v) => jsnum::value_string(Some(v)),
    };
    crate::jsval::trim(&value).to_owned()
}

fn message(ctx: &Ready<'_>, status: u16, text: &str) -> Outcome {
    ctx.error(status, text)
}

fn standalone_only() -> Result<(), Box<Outcome>> {
    if crate::standalone::enabled() {
        Ok(())
    } else {
        Err(Box::new(forward("device authorization is not available")))
    }
}

fn jellyfin_provider(ctx: &Ready<'_>) -> bool {
    ctx.settings.get("/trakt/provider").and_then(Value::as_str) == Some("jellyfin")
}

// ---------------------------------------------------------------------------
// Trakt
// ---------------------------------------------------------------------------

/// Trakt's raw axios client: a request and its answer, any status.
async fn trakt_send(
    ctx: &Ready<'_>,
    method: Method,
    path: &str,
    client_id: &str,
    access_token: Option<&str>,
    body: Option<&Value>,
) -> Result<(u16, Option<String>, Value), String> {
    let mut req = ctx
        .state
        .outbound
        .request(method, format!("{TRAKT_BASE_URL}{path}"))
        .timeout(TRAKT_TIMEOUT)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("trakt-api-version", "2")
        .header("trakt-api-key", client_id)
        .header("User-Agent", AXIOS_USER_AGENT);
    if let Some(token) = access_token {
        req = req.header("Authorization", format!("Bearer {token}"));
    }
    if let Some(body) = body {
        req = req.body(serde_json::to_vec(body).unwrap_or_default());
    }
    let res = req
        .send()
        .await
        .map_err(|e| crate::outbound::describe(&e))?;
    let status = res.status().as_u16();
    let retry_after = res
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let bytes = res
        .bytes()
        .await
        .map_err(|e| crate::outbound::describe(&e))?;
    Ok((status, retry_after, axios_data(&bytes)))
}

/// `getTraktAppCredentials()`: `Err(true)` for `TraktNotConfiguredError`,
/// `Err(false)` for anything else it throws.
fn trakt_credentials(ctx: &Ready<'_>) -> Result<(String, String), bool> {
    crate::trakt::app_credentials(&ctx.settings)
        .map_err(|e| matches!(e, crate::trakt::TraktError::NotConfigured))
}

/// A user's `TraktAPI` built from fresh device tokens, for
/// `getUserSettings()`.
#[derive(Debug, Clone)]
struct TraktUser {
    client_id: String,
    client_secret: String,
    access_token: Option<String>,
    refresh_token: Option<Value>,
    expires_at: f64,
}

/// A token value as the client's template strings print it.
fn token_text(value: Option<&Value>) -> Option<String> {
    truthy(value).then(|| jsnum::value_string(value))
}

/// `applyTokens(payload)`'s `expiresAt`, starting from `current`.
fn applied_expires_at(payload: &Value, current: f64) -> f64 {
    let number = |key: &str| {
        let v = payload.get(key);
        if truthy(v) {
            jsnum::value_number(v)
        } else {
            0.0
        }
    };
    let expires_in = number("expires_in");
    if expires_in == 0.0 || expires_in.is_nan() {
        return current;
    }
    let created_at = number("created_at");
    let base = if created_at.is_finite() && created_at > 0.0 {
        created_at
    } else {
        (jsnum::now() / 1000.0).floor()
    };
    base + expires_in
}

impl TraktUser {
    /// `refreshAccessToken()` without a `refreshTokens` hook.
    async fn refresh(&mut self, ctx: &Ready<'_>) -> Result<(), String> {
        if !truthy(self.refresh_token.as_ref()) {
            return Err(String::from(
                "Cannot refresh Trakt token without a refresh token",
            ));
        }
        let body = json!({
            "refresh_token": self.refresh_token,
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "redirect_uri": "urn:ietf:wg:oauth:2.0:oob",
            "grant_type": "refresh_token",
        });
        let (status, _, data) = trakt_send(
            ctx,
            Method::POST,
            "/oauth/token",
            &self.client_id,
            None,
            Some(&body),
        )
        .await?;
        if !(200..300).contains(&status) {
            return Err(format!("Trakt token refresh failed with status {status}"));
        }
        if let Some(token) = token_text(data.get("access_token")) {
            self.access_token = Some(token);
        }
        if truthy(data.get("refresh_token")) {
            self.refresh_token = data.get("refresh_token").cloned();
        }
        self.expires_at = applied_expires_at(&data, self.expires_at);
        Ok(())
    }

    /// `getUserSettings()`: `ensureFreshToken()`, then `GET /users/settings`
    /// with one refresh on a 401 and one wait on a short 429.
    async fn user_settings(&mut self, ctx: &Ready<'_>) -> Result<(Value, String), String> {
        let refresh_due = |user: &Self| {
            truthy(user.refresh_token.as_ref())
                && user.expires_at != 0.0
                && !user.expires_at.is_nan()
                && user.expires_at <= (jsnum::now() / 1000.0).floor() + TRAKT_REFRESH_WINDOW_SECONDS
        };
        if refresh_due(self) {
            self.refresh(ctx).await?;
        }
        let mut retry_auth = true;
        let mut retry_rate = true;
        let payload = loop {
            if refresh_due(self) {
                self.refresh(ctx).await?;
            }
            let (status, retry_after, data) = trakt_send(
                ctx,
                Method::GET,
                "/users/settings",
                &self.client_id,
                self.access_token.as_deref(),
                None,
            )
            .await?;
            if (200..300).contains(&status) {
                break data;
            }
            if status == 429 {
                let wait = crate::trakt::parse_retry_after(retry_after.as_deref());
                if retry_rate && wait <= TRAKT_RETRY_AFTER_MAX_SECONDS {
                    let wait = if wait == 0 {
                        TRAKT_RATE_LIMIT_FALLBACK_SECONDS
                    } else {
                        wait
                    };
                    tokio::time::sleep(Duration::from_secs(wait)).await;
                    retry_rate = false;
                    continue;
                }
                return Err(String::from("Trakt API rate limited"));
            }
            if status == 401 && self.access_token.is_some() && retry_auth {
                self.refresh(ctx).await?;
                retry_auth = false;
                continue;
            }
            return Err(format!(
                "Trakt API request failed: GET /users/settings returned {status}"
            ));
        };
        Ok(profile_of(&payload))
    }
}

/// `getUserSettings()`'s `{ username, traktUserId }` from the payload.
fn profile_of(payload: &Value) -> (Value, String) {
    let user = nullish_or(payload.get("user"), None);
    let ids = nullish_or(prop(user, "ids"), None);
    let first = |values: &[Option<&Value>]| {
        values
            .iter()
            .copied()
            .find(|v| truthy(*v))
            .flatten()
            .cloned()
    };
    let username = first(&[
        prop(user, "username"),
        prop(user, "name"),
        prop(user, "slug"),
        prop(ids, "slug"),
    ])
    .unwrap_or_else(|| Value::from(""));
    let user_id = first(&[
        prop(ids, "uuid"),
        prop(ids, "slug"),
        prop(ids, "trakt"),
        prop(user, "username"),
    ])
    .unwrap_or_else(|| username.clone());
    (username, jsnum::value_string(Some(&user_id)))
}

/// `rememberTraktDeviceAuthSession`.
fn remember_session(user: f64, device_code: &str, interval: f64, expires_in: f64) {
    let interval = js_max(1.0, interval.trunc());
    let key = session_key(user, device_code);
    let mut state = lock(&TRAKT);
    state.sessions.insert(
        key.clone(),
        DeviceSession {
            interval_seconds: interval,
            expires_at: jsnum::now() + js_max(1.0, expires_in) * 1000.0,
        },
    );
    state.polls.insert(
        key,
        PollState {
            last_poll_at: 0.0,
            interval_seconds: interval,
        },
    );
}

/// `clearTraktDeviceAuthSession`.
fn clear_session(state: &mut TraktThrottle, key: &str) {
    state.sessions.remove(key);
    state.polls.remove(key);
}

/// `enforceTraktDevicePollInterval`: `Some` answer when it stops the
/// request.
fn enforce_poll_interval(ctx: &Ready<'_>, user: f64, device_code: &str) -> Option<Outcome> {
    if user == 0.0 || user.is_nan() || device_code.is_empty() {
        return None;
    }
    let key = session_key(user, device_code);
    let mut state = lock(&TRAKT);
    let session = state.sessions.get(&key).copied();
    if session.is_some_and(|s| s.expires_at <= jsnum::now()) {
        clear_session(&mut state, &key);
        return Some(ctx.json_with(410, &json!({ "status": "expired" })));
    }
    let poll = state.polls.get(&key).copied();
    let interval = js_max(
        1.0,
        poll.map(|p| p.interval_seconds)
            .or_else(|| session.map(|s| s.interval_seconds))
            .unwrap_or(5.0),
    );
    let now = jsnum::now();
    let last = poll.map_or(0.0, |p| p.last_poll_at);
    let elapsed = if last == 0.0 || last.is_nan() {
        f64::INFINITY
    } else {
        now - last
    };
    let required = interval * 1000.0;
    if last != 0.0 && !last.is_nan() && elapsed < required {
        let retry = js_max(1.0, ((required - elapsed) / 1000.0).ceil());
        return Some(ctx.json_with(
            429,
            &json!({ "status": "pending", "retryAfterSeconds": jsnum::json(retry) }),
        ));
    }
    state.polls.insert(
        key,
        PollState {
            last_poll_at: now,
            interval_seconds: interval,
        },
    );
    None
}

/// `noteTraktDevicePollSlowDown`.
fn note_slow_down(user: f64, device_code: &str) {
    let key = session_key(user, device_code);
    let mut state = lock(&TRAKT);
    let current = state.polls.get(&key).map_or(5.0, |p| p.interval_seconds);
    state.polls.insert(
        key,
        PollState {
            last_poll_at: jsnum::now(),
            interval_seconds: js_max(current, TRAKT_DEVICE_SLOW_DOWN_SECONDS),
        },
    );
}

/// The rate limiter's key: `trakt-device-<suffix>:<req.params.id>`.
fn throttle_key(suffix: &str, param: &UserParam) -> String {
    format!("trakt-device-{suffix}:{}", param.raw)
}

fn trakt_code<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_outcome!(standalone_only());
        let (_, param) = try_outcome!(guard(ctx, Guard::Own));
        let allowed = consume(
            &mut lock(&TRAKT).code_buckets,
            throttle_key("code", &param),
            TRAKT_DEVICE_CODE_MAX_PER_WINDOW,
            TRAKT_DEVICE_CODE_WINDOW_MS,
        );
        if !allowed {
            return message(
                ctx,
                429,
                "Too many Trakt device authorization attempts. Try again later.",
            );
        }
        if jellyfin_provider(ctx) {
            return message(ctx, 409, JELLYFIN_PROVIDER);
        }
        let (client_id, _) = match trakt_credentials(ctx) {
            Ok(credentials) => credentials,
            Err(true) => {
                return message(ctx, 400, "Trakt application credentials are not configured")
            }
            Err(false) => return message(ctx, 500, TRAKT_START_FAILED),
        };
        let body = json!({ "client_id": client_id });
        let sent = trakt_send(
            ctx,
            Method::POST,
            "/oauth/device/code",
            &client_id,
            None,
            Some(&body),
        )
        .await;
        let data = match sent {
            Ok((status, _, data)) if (200..300).contains(&status) => data,
            Ok((status, _, _)) => {
                tracing::error!(
                    label = "API",
                    "Failed to start Trakt device auth: Request failed with status code {status}"
                );
                return message(ctx, 500, TRAKT_START_FAILED);
            }
            Err(e) => {
                tracing::error!(label = "API", "Failed to start Trakt device auth: {e}");
                return message(ctx, 500, TRAKT_START_FAILED);
            }
        };
        let device_code = jsnum::value_string(prop(Some(&data), "device_code"));
        remember_session(
            param.number,
            &device_code,
            jsnum::value_number(prop(Some(&data), "interval")),
            jsnum::value_number(prop(Some(&data), "expires_in")),
        );
        ctx.json(&crate::tmdb::js_numbers(data))
    })
}

/// `pollForToken(deviceCode)`'s outcome.
enum Poll {
    Answer(u16, Value),
    SlowDown,
    Authorized(Value),
}

async fn poll_for_token(
    ctx: &Ready<'_>,
    client_id: &str,
    client_secret: &str,
    device_code: &str,
) -> Result<Poll, String> {
    let body = json!({
        "code": device_code,
        "client_id": client_id,
        "client_secret": client_secret,
    });
    let (status, _, data) = trakt_send(
        ctx,
        Method::POST,
        "/oauth/device/token",
        client_id,
        None,
        Some(&body),
    )
    .await
    .map_err(|e| format!("Trakt API request failed: POST /oauth/device/token: {e}"))?;
    let answer = |status: u16, text: &str| Ok(Poll::Answer(status, json!({ "status": text })));
    match status {
        200..=299 => Ok(Poll::Authorized(data)),
        400 => answer(202, "pending"),
        429 => Ok(Poll::SlowDown),
        409 => answer(409, "already_used"),
        404 => answer(400, "invalid"),
        410 => answer(410, "expired"),
        418 => answer(409, "denied"),
        _ => Err(format!(
            "Trakt device authorization failed (status {status})"
        )),
    }
}

/// What finishing the link decided.
enum Finish {
    Done(Outcome),
    Failed(String),
}

/// After an authorized poll: the profile, the linked-elsewhere check and
/// the save.
async fn finish_trakt(
    ctx: &Ready<'_>,
    id: i64,
    client_id: String,
    client_secret: String,
    data: &Value,
) -> Finish {
    let expires_at = applied_expires_at(data, 0.0);
    let mut user = TraktUser {
        client_id,
        client_secret,
        access_token: token_text(data.get("access_token")),
        refresh_token: data.get("refresh_token").cloned(),
        expires_at,
    };
    let (username, trakt_user_id) = match user.user_settings(ctx).await {
        Ok(profile) => profile,
        Err(e) => return Finish::Failed(e),
    };
    let taken = ctx
        .state
        .db
        .scalar(
            r#"SELECT COUNT(*) FROM "user_settings" s LEFT JOIN "user" u ON u."id" = s."userId" WHERE s."traktUserId" = ?1 AND u."id" != ?2"#,
            &[Bind::Text(trakt_user_id.clone()), Bind::Int(id)],
        )
        .await;
    match taken {
        Ok(0) => {}
        Ok(_) => {
            return Finish::Done(message(
                ctx,
                409,
                "This Trakt account is already linked to another Foreseerr user",
            ))
        }
        Err(e) => return Finish::Failed(format!("{e:#}")),
    }
    let settings_id = match typeorm::ensure_user_settings(&ctx.state.db, id).await {
        Ok(Some(settings_id)) => settings_id,
        Ok(None) => return Finish::Failed(String::from("User not found")),
        Err(e) => return Finish::Failed(format!("{e:#}")),
    };
    let mut changes = Changes::default();
    for (column, key) in [
        ("traktAccessToken", "access_token"),
        ("traktRefreshToken", "refresh_token"),
    ] {
        if let Some(value) = data.get(key) {
            changes.set(column, crate::tmdb::js_numbers(value.clone()));
        }
    }
    changes.set(
        "traktTokenExpiresAt",
        Value::from(jsnum::to_string(expires_at)),
    );
    changes.set("traktUsername", username.clone());
    changes.set("traktUserId", Value::from(trakt_user_id));
    let saved = match changes.update_sql("user_settings", settings_id, false) {
        Ok(update) => typeorm::run(&ctx.state.db, update).await,
        Err(e) => Err(e),
    };
    if let Err(e) = saved {
        return Finish::Failed(format!("{e:#}"));
    }
    super::userwrite::invalidate_sync_cache(ctx, id, "trakt").await;
    Finish::Done(ctx.json(&json!({ "status": "authorized", "username": username })))
}

fn trakt_token<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_outcome!(standalone_only());
        let (viewer, param) = try_outcome!(guard(ctx, Guard::Own));
        let body = try_outcome!(validated_body(ctx));
        let allowed = consume(
            &mut lock(&TRAKT).poll_buckets,
            throttle_key("poll", &param),
            TRAKT_DEVICE_POLL_MAX_PER_MINUTE,
            TRAKT_DEVICE_POLL_WINDOW_MS,
        );
        if !allowed {
            return message(
                ctx,
                429,
                "Trakt device authorization polling rate limit exceeded.",
            );
        }
        let device_code = body_device_code(body);
        if let Some(answer) = enforce_poll_interval(ctx, param.number, &device_code) {
            return answer;
        }
        if jellyfin_provider(ctx) {
            return message(ctx, 409, JELLYFIN_PROVIDER);
        }
        if device_code.is_empty() {
            return message(ctx, 400, "deviceCode is required");
        }
        let (client_id, client_secret) = match trakt_credentials(ctx) {
            Ok(credentials) => credentials,
            Err(true) => {
                return message(ctx, 400, "Trakt application credentials are not configured")
            }
            Err(false) => return message(ctx, 500, TRAKT_FINISH_FAILED),
        };
        let failed = |why: &str| {
            tracing::error!(label = "API", "Failed to complete Trakt device auth: {why}");
            message(ctx, 500, TRAKT_FINISH_FAILED)
        };
        let data = match poll_for_token(ctx, &client_id, &client_secret, &device_code).await {
            Ok(Poll::Authorized(data)) => data,
            Ok(Poll::Answer(status, body)) => return ctx.json_with(status, &body),
            Ok(Poll::SlowDown) => {
                note_slow_down(param.number, &device_code);
                return ctx.json_with(
                    202,
                    &json!({
                        "status": "pending",
                        "retryAfterSeconds": jsnum::json(TRAKT_DEVICE_SLOW_DOWN_SECONDS),
                    }),
                );
            }
            Err(e) => return failed(&e),
        };
        // The own-profile guard makes the id the viewer's.
        match finish_trakt(ctx, viewer.id, client_id, client_secret, &data).await {
            Finish::Done(outcome) => {
                clear_session(&mut lock(&TRAKT), &session_key(param.number, &device_code));
                outcome
            }
            Finish::Failed(why) => failed(&why),
        }
    })
}

// ---------------------------------------------------------------------------
// Simkl
// ---------------------------------------------------------------------------

/// `new SimklAPI()`: `None` for `SimklNotConfiguredError`.
fn simkl_config(ctx: &Ready<'_>) -> Result<Option<crate::simklapi::Config>, Box<Outcome>> {
    let client_id = match ctx.settings.get("/simkl/clientId") {
        Some(Value::String(s)) => crate::jsval::trim(s).to_owned(),
        _ => return Err(Box::new(forward("a simkl.clientId that isn't a string"))),
    };
    if client_id.is_empty() {
        return Ok(None);
    }
    Ok(Some(crate::simklapi::Config::new(
        &ctx.state.outbound,
        &client_id,
        &ctx.state.version.version,
        crate::simklapi::timeout_of(&ctx.settings),
    )))
}

/// A code to show the user, from either flow.
struct StartedPin {
    flow: PinFlow,
    poll_code: Option<String>,
    user_code: Option<Value>,
    verification_uri: Value,
    expires_in: Value,
    interval: Value,
}

/// `value ?? fallback`.
fn or_default(value: Option<&Value>, fallback: Value) -> Value {
    value.filter(|v| !v.is_null()).cloned().unwrap_or(fallback)
}

/// The device flow, falling back to the V1 PIN flow when Simkl answers
/// `invalid_client` (Simkl retires AUTH V1 around April 2027; until then
/// apps registered before V2 keep linking through it).
async fn start_pin(
    config: &crate::simklapi::Config,
) -> Result<Option<StartedPin>, crate::simklapi::Failure> {
    let client = config.anonymous();
    match client.request_device_code().await {
        Ok(device) => {
            let device = Some(&device);
            let user_code = prop(device, "user_code").filter(|v| !v.is_null()).cloned();
            let poll_code = prop(device, "device_code")
                .filter(|v| truthy(Some(v)))
                .map(|v| jsnum::value_string(Some(v)));
            // The complete URI pre-fills the code; the user still has to
            // approve.
            let verification_uri = or_default(
                nullish_or(
                    prop(device, "verification_uri_complete"),
                    prop(device, "verification_uri"),
                ),
                Value::from("https://simkl.com/pin"),
            );
            Ok(Some(StartedPin {
                flow: PinFlow::Device,
                poll_code,
                user_code,
                verification_uri,
                expires_in: or_default(prop(device, "expires_in"), Value::from(900)),
                interval: or_default(prop(device, "interval"), Value::from(5)),
            }))
        }
        Err(e) if crate::simklapi::is_v1_client_error(&e) => {
            let pin = client.request_pin_code().await?;
            if pin.is_null() {
                return Ok(None);
            }
            let pin = Some(&pin);
            let user_code = nullish_or(prop(pin, "user_code"), prop(pin, "code"))
                .filter(|v| !v.is_null())
                .cloned();
            Ok(Some(StartedPin {
                flow: PinFlow::Pin,
                poll_code: user_code
                    .as_ref()
                    .filter(|v| truthy(Some(v)))
                    .map(|v| jsnum::value_string(Some(v))),
                user_code,
                verification_uri: or_default(
                    prop(pin, "url"),
                    Value::from("https://simkl.com/pin/"),
                ),
                expires_in: or_default(
                    nullish_or(prop(pin, "expires_in"), prop(pin, "expires")),
                    Value::from(600),
                ),
                interval: or_default(prop(pin, "interval"), Value::from(5)),
            }))
        }
        Err(e) => Err(e),
    }
}

/// `randomUUID()` for the browser's opaque session id.
fn session_id() -> String {
    let n: u128 = rand::random();
    let hex = format!("{n:032x}");
    let mut out = String::with_capacity(36);
    for (i, c) in hex.chars().enumerate() {
        if matches!(i, 8 | 12 | 16 | 20) {
            out.push('-');
        }
        out.push(c);
    }
    out
}

fn simkl_code<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_outcome!(standalone_only());
        let (_, param) = try_outcome!(guard(ctx, Guard::Own));
        let Some(config) = try_outcome!(simkl_config(ctx)) else {
            return message(ctx, 400, SIMKL_NOT_CONFIGURED);
        };
        let started = match start_pin(&config).await {
            Ok(Some(started)) => started,
            Ok(None) => {
                return Outcome::forward(String::from(
                    "Simkl answered the PIN request with nothing",
                ))
            }
            Err(e) => {
                tracing::error!("Failed to start Simkl PIN authorization: {}", e.message());
                return message(ctx, 500, &e.message());
            }
        };
        let (Some(user_code), Some(poll_code)) = (
            started.user_code.filter(|v| truthy(Some(v))),
            started.poll_code,
        ) else {
            return message(ctx, 502, "Simkl returned an invalid PIN response.");
        };
        let session_id = session_id();
        let now = jsnum::now();
        {
            let mut pins = lock(&SIMKL_PINS);
            pins.retain(|_, session| session.expires_at > now);
            pins.insert(
                session_key(param.number, &session_id),
                PinSession {
                    flow: started.flow,
                    poll_code,
                    expires_at: now
                        + js_max(1.0, jsnum::value_number(Some(&started.expires_in))) * 1000.0,
                    interval_seconds: js_max(1.0, jsnum::value_number(Some(&started.interval))),
                    last_poll_at: 0.0,
                },
            );
        }
        let mut out = Map::new();
        out.insert(String::from("userCode"), user_code);
        out.insert(String::from("verificationUri"), started.verification_uri);
        out.insert(String::from("expiresIn"), started.expires_in);
        out.insert(String::from("interval"), started.interval);
        // Opaque value only consumed by the server on the token endpoint.
        out.insert(String::from("deviceCode"), Value::from(session_id));
        ctx.json(&crate::tmdb::js_numbers(Value::Object(out)))
    })
}

/// The token poll's answer before the account lookup: tokens, or the
/// route's reply.
async fn poll_tokens(
    ctx: &Ready<'_>,
    id: i64,
    key: &str,
    session: &PinSession,
    config: &crate::simklapi::Config,
) -> Result<Result<Value, Outcome>, crate::simklapi::Failure> {
    let client = config.anonymous();
    if session.flow == PinFlow::Device {
        let tokens = match client.poll_device_token(&session.poll_code).await {
            Ok(tokens) => tokens,
            // V2 has no deny signal: a declined request stays pending until
            // the session runs out.
            Err(e) => {
                return match e.oauth_code() {
                    Some("authorization_pending") => {
                        Ok(Err(ctx.json_with(202, &json!({ "status": "pending" }))))
                    }
                    Some("slow_down") => {
                        let interval = lock(&SIMKL_PINS).get_mut(key).map_or(
                            session.interval_seconds + 5.0,
                            |entry| {
                                entry.interval_seconds += 5.0;
                                entry.interval_seconds
                            },
                        );
                        Ok(Err(ctx.json_with(
                            429,
                            &json!({ "status": "pending", "retryAfterSeconds": jsnum::json(interval) }),
                        )))
                    }
                    Some("expired_token" | "invalid_grant") => {
                        lock(&SIMKL_PINS).remove(key);
                        Ok(Err(ctx.json_with(410, &json!({ "status": "expired" }))))
                    }
                    _ => Err(e),
                };
            }
        };
        let scope = tokens.get("scope").and_then(Value::as_str);
        if !scope.is_some_and(|s| s.split(' ').any(|part| part == "media:write")) {
            tracing::warn!(
                "Simkl granted read-only access; Simkl actions will fail (user {id}, scope {})",
                scope.unwrap_or("null")
            );
        }
        return Ok(Ok(tokens));
    }
    let result = client.poll_pin_token(&session.poll_code).await?;
    if result.is_null() {
        return Ok(Err(Outcome::forward(String::from(
            "Simkl answered the token request with nothing",
        ))));
    }
    let result = Some(&result);
    let access = nullish_or(prop(result, "access_token"), prop(result, "token"));
    if !truthy(access) {
        let error = prop(result, "error").and_then(Value::as_str);
        let answer = match error {
            Some("expired_token") => Some((410, "expired")),
            Some("access_denied") => Some((409, "denied")),
            _ => None,
        };
        if let Some((status, text)) = answer {
            lock(&SIMKL_PINS).remove(key);
            return Ok(Err(ctx.json_with(status, &json!({ "status": text }))));
        }
        return Ok(Err(ctx.json_with(202, &json!({ "status": "pending" }))));
    }
    Ok(Ok(
        json!({ "access_token": access.cloned().unwrap_or(Value::Null) }),
    ))
}

/// The token poll after the session checks; `Err` is the route's catch
/// (`message`, with whether it is `SimklNotConfiguredError`).
async fn poll_simkl(
    ctx: &Ready<'_>,
    id: i64,
    key: &str,
    session: &PinSession,
) -> Result<Outcome, (String, bool)> {
    let config = simkl_config(ctx)
        .map_err(|_| (String::from("a simkl.clientId that isn't a string"), false))?
        .ok_or_else(|| (String::from(SIMKL_NOT_CONFIGURED), true))?;
    let failure = |e: crate::simklapi::Failure| (e.message(), false);
    let tokens = match poll_tokens(ctx, id, key, session, &config)
        .await
        .map_err(failure)?
    {
        Ok(tokens) => tokens,
        Err(outcome) => return Ok(outcome),
    };
    let (access, refresh, expires_at) = crate::simklapi::token_columns(&tokens);
    let Some(access_text) = access.as_str().filter(|t| !t.is_empty()).map(str::to_owned) else {
        return Err((
            String::from("Simkl answered the token request without an access token"),
            false,
        ));
    };
    let profile = config
        .with_token(&access_text)
        .user_settings()
        .await
        .map_err(failure)?;
    if profile.is_null() {
        return Ok(Outcome::forward(String::from(
            "Simkl answered the settings request with nothing",
        )));
    }
    let profile = Some(&profile);
    let account_id = prop(prop(profile, "account"), "id").filter(|v| !v.is_null());
    let simkl_user_id = account_id.map_or_else(String::new, |v| jsnum::value_string(Some(v)));
    if simkl_user_id.is_empty() {
        return Ok(message(
            ctx,
            502,
            "Simkl returned an invalid account response.",
        ));
    }
    let db = &ctx.state.db;
    let db_err = |e: anyhow::Error| (format!("{e:#}"), false);
    let existing = db
        .rows(
            r#"SELECT "userId" FROM "user_settings" WHERE "simklUserId" = ?1 LIMIT 1"#,
            &[Bind::Text(simkl_user_id.clone())],
        )
        .await
        .map_err(db_err)?;
    if let Some(row) = existing.first() {
        let owner = jsnum::value_number(row.get("userId"));
        if !js_eq(owner, jsnum::from_i64(id)) {
            return Ok(message(
                ctx,
                409,
                "This Simkl account is already linked to another Foreseerr user",
            ));
        }
    }
    let settings_id = typeorm::ensure_user_settings(db, id)
        .await
        .map_err(db_err)?
        .ok_or_else(|| (String::from("User not found"), false))?;
    let user = prop(profile, "user");
    let username = nullish_or(prop(user, "username"), prop(user, "name")).filter(|v| !v.is_null());
    let mut changes = Changes::default();
    changes.set("simklAccessToken", crate::tmdb::js_numbers(access));
    changes.set("simklRefreshToken", refresh);
    changes.set("simklTokenExpiresAt", expires_at);
    changes.set("simklUserId", Value::from(simkl_user_id));
    let username = match username {
        Some(name) => {
            changes.set("simklUsername", crate::tmdb::js_numbers(name.clone()));
            name.clone()
        }
        None => db
            .rows(
                r#"SELECT "simklUsername" FROM "user_settings" WHERE "id" = ?1"#,
                &[Bind::Int(settings_id)],
            )
            .await
            .map_err(db_err)?
            .first()
            .and_then(|row| row.get("simklUsername").cloned())
            .unwrap_or(Value::Null),
    };
    let update = changes
        .update_sql("user_settings", settings_id, false)
        .map_err(db_err)?;
    typeorm::run(db, update).await.map_err(db_err)?;
    lock(&SIMKL_PINS).remove(key);
    Ok(ctx.json(&json!({ "status": "authorized", "username": crate::tmdb::js_numbers(username) })))
}

fn simkl_token<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_outcome!(standalone_only());
        let (viewer, param) = try_outcome!(guard(ctx, Guard::Own));
        let body = try_outcome!(validated_body(ctx));
        let device_code = body_device_code(body);
        let key = session_key(param.number, &device_code);
        let session = lock(&SIMKL_PINS).get(&key).cloned();
        let Some(session) = session.filter(|_| !device_code.is_empty()) else {
            return message(ctx, 400, "Invalid or missing PIN session.");
        };
        let now = jsnum::now();
        if session.expires_at <= now {
            lock(&SIMKL_PINS).remove(&key);
            return ctx.json_with(410, &json!({ "status": "expired" }));
        }
        let elapsed = now - session.last_poll_at;
        let required = session.interval_seconds * 1000.0;
        if session.last_poll_at != 0.0 && elapsed < required {
            let retry = ((required - elapsed) / 1000.0).ceil();
            return ctx.json_with(
                429,
                &json!({ "status": "pending", "retryAfterSeconds": jsnum::json(retry) }),
            );
        }
        if let Some(entry) = lock(&SIMKL_PINS).get_mut(&key) {
            entry.last_poll_at = jsnum::now();
        }
        match poll_simkl(ctx, viewer.id, &key, &session).await {
            Ok(outcome) => outcome,
            Err((text, not_configured)) => {
                tracing::error!("Failed to complete Simkl PIN authorization: {text}");
                message(ctx, if not_configured { 400 } else { 500 }, &text)
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiles_read_like_get_user_settings() {
        let (name, id) = profile_of(
            &json!({"user": {"username": "", "name": "N", "ids": {"slug": "s", "uuid": "u"}}}),
        );
        assert_eq!(name, Value::from("N"), "the first truthy name");
        assert_eq!(id, "u", "uuid first");
        let (name, id) = profile_of(&json!({"user": {"ids": {"trakt": 42}}}));
        assert_eq!(name, Value::from(""), "no name");
        assert_eq!(id, "42", "a numeric id as text");
        let (name, id) = profile_of(&json!("text"));
        assert_eq!((name, id), (Value::from(""), String::new()), "no user");
    }

    #[test]
    fn token_expiry_follows_apply_tokens() {
        assert!(
            (applied_expires_at(&json!({"expires_in": 100, "created_at": 1000}), 0.0) - 1100.0)
                .abs()
                < f64::EPSILON,
            "created_at plus expires_in"
        );
        assert!(
            applied_expires_at(&json!({"expires_in": "x"}), 7.0).to_bits() == 7.0_f64.to_bits(),
            "NaN keeps the current value"
        );
        assert!(js_max(1.0, f64::NAN).is_nan(), "Math.max with NaN");
        assert_eq!(session_key(3.0, "abc"), "3:abc", "the session key");
    }

    #[test]
    fn rate_limits_count_per_window() {
        let mut buckets = HashMap::new();
        for _ in 0..2 {
            assert!(
                consume(&mut buckets, String::from("k"), 2, 60_000.0),
                "within the limit"
            );
        }
        assert!(
            !consume(&mut buckets, String::from("k"), 2, 60_000.0),
            "over the limit"
        );
        assert!(
            consume(&mut buckets, String::from("other"), 2, 60_000.0),
            "per key"
        );
    }
}
