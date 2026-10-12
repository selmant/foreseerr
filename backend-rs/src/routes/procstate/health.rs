//! `server/lib/integrationHealth.ts`: the Trakt (direct and Better Trakt
//! through Jellyfin), `MDBList`, `AniList` and Simkl checks behind
//! `GET /settings/integrations/status`, cached for five minutes.

use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

use crate::settings::public::truthy;
use crate::settings::Settings;
use crate::standalone::internal::Answer;
use crate::state::AppState;
use crate::sync::lock;

/// `MediaServerType.EMBY`.
const EMBY: i64 = 3;
/// `HEALTH_CHECK_TTL_MS`.
const TTL: Duration = Duration::from_secs(300);
const TRAKT_BASE: &str = "https://api.trakt.tv";
/// The `rawAxios` instance's timeout and user agent.
const RAW_TIMEOUT: Duration = Duration::from_secs(15);
const RAW_USER_AGENT: &str = "axios/1.18.0";
/// `resolveJellyfinTraktUserState` and the reachability probe.
const JELLYFIN_TIMEOUT: Duration = Duration::from_secs(5);

/// `cachedHealth`.
static CACHED: LazyLock<Mutex<Option<(Instant, Value)>>> = LazyLock::new(Mutex::default);

/// `clearIntegrationHealthCache()`.
pub fn clear() {
    *lock(&CACHED) = None;
}

/// `GET /internal/integrations/health` (after a cache reset for
/// `/refresh`).
pub async fn answer(state: &AppState, refresh: bool) -> Answer {
    if refresh {
        clear();
    }
    match integration_health(state).await {
        Ok(value) => Answer::json(200, value),
        Err(message) => Answer::message(500, &message),
    }
}

/// `getIntegrationHealth()`.
///
/// # Errors
///
/// When settings.json can't be read or `simkl.clientId` isn't a string
/// (Node's `trim()` throws).
pub async fn integration_health(state: &AppState) -> Result<Value, String> {
    let cached = lock(&CACHED)
        .as_ref()
        .filter(|(expires, _)| *expires > Instant::now())
        .map(|(_, value)| value.clone());
    if let Some(value) = cached {
        return Ok(value);
    }
    let settings = super::settings(state).await.map_err(|e| format!("{e:#}"))?;
    let jellyfin_provider = settings.str("/trakt/provider") == "jellyfin";
    let (direct, jellyfin, mdblist, anilist, simkl) = tokio::join!(
        direct_trakt(state, &settings),
        jellyfin_trakt(state, &settings),
        check_mdblist(state, &settings),
        check_anilist(state, &settings),
        check_simkl(state, &settings),
    );
    let simkl = simkl?;
    let active = if jellyfin_provider {
        &jellyfin
    } else {
        &direct
    };
    let mut trakt = Map::new();
    trakt.insert(
        String::from("provider"),
        Value::from(if jellyfin_provider {
            "jellyfin"
        } else {
            "direct"
        }),
    );
    for (k, v) in active {
        trakt.insert(k.clone(), v.clone());
    }
    trakt.insert(String::from("direct"), Value::Object(direct));
    trakt.insert(String::from("jellyfin"), Value::Object(jellyfin));
    let mut value = Map::new();
    value.insert(String::from("trakt"), Value::Object(trakt));
    value.insert(String::from("mdblist"), Value::Object(mdblist));
    value.insert(String::from("anilist"), Value::Object(anilist));
    value.insert(String::from("simkl"), Value::Object(simkl));
    let value = Value::Object(value);
    *lock(&CACHED) = Some((Instant::now() + TTL, value.clone()));
    Ok(value)
}

fn health(state: &str, detail: &str, checked: bool) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert(String::from("state"), Value::from(state));
    out.insert(String::from("detail"), Value::from(detail));
    out.insert(
        String::from("checkedAt"),
        if checked {
            Value::from(crate::clock::Utc::now().iso_string())
        } else {
            Value::Null
        },
    );
    out
}

fn healthy(detail: &str) -> Map<String, Value> {
    health("healthy", detail, true)
}

fn degraded(detail: &str) -> Map<String, Value> {
    health("degraded", detail, true)
}

fn not_configured(detail: &str) -> Map<String, Value> {
    health("not_configured", detail, false)
}

/// `checkDirectTrakt`.
async fn direct_trakt(state: &AppState, settings: &Settings) -> Map<String, Value> {
    if settings.str("/trakt/provider") == "jellyfin" {
        return not_configured("Direct Trakt is not the active connection method.");
    }
    let client_id = settings.get("/trakt/clientId");
    let client_secret = settings.get("/trakt/clientSecret");
    if !truthy(client_id) || !truthy(client_secret) {
        return not_configured("Trakt application credentials are not configured.");
    }
    let id = crate::media::js_string(client_id).into_owned();
    let secret = crate::media::js_string(client_secret).into_owned();
    if validate_trakt_credentials(&state.outbound, &id, &secret).await {
        healthy("Trakt is reachable and the Client ID was accepted.")
    } else {
        degraded("Trakt could not accept the saved application settings.")
    }
}

/// A `rawAxios` POST to Trakt; the status, `None` without an answer.
async fn trakt_raw_post(
    client: &reqwest::Client,
    client_id: &str,
    path: &str,
    body: &Value,
) -> Option<u16> {
    client
        .post(format!("{TRAKT_BASE}{path}"))
        .timeout(RAW_TIMEOUT)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "application/json")
        .header("trakt-api-version", "2")
        .header("trakt-api-key", client_id)
        .header(reqwest::header::USER_AGENT, RAW_USER_AGENT)
        .body(body.to_string())
        .send()
        .await
        .ok()
        .map(|res| res.status().as_u16())
}

/// `validateApplicationCredentials()`: a device code for the client id,
/// then a refresh with a dummy token that only a wrong secret answers with
/// 401 or 403.
pub(crate) async fn validate_trakt_credentials(
    client: &reqwest::Client,
    client_id: &str,
    secret: &str,
) -> bool {
    let mut code = Map::new();
    code.insert(String::from("client_id"), Value::from(client_id));
    let code_ok = trakt_raw_post(
        client,
        client_id,
        "/oauth/device/code",
        &Value::Object(code),
    )
    .await
    .is_some_and(|status| (200..300).contains(&status));
    if !code_ok {
        return false;
    }
    let mut token = Map::new();
    token.insert(
        String::from("refresh_token"),
        Value::from("foreseerr-credential-validation"),
    );
    token.insert(String::from("client_id"), Value::from(client_id));
    token.insert(String::from("client_secret"), Value::from(secret));
    token.insert(
        String::from("redirect_uri"),
        Value::from("urn:ietf:wg:oauth:2.0:oob"),
    );
    token.insert(String::from("grant_type"), Value::from("refresh_token"));
    trakt_raw_post(client, client_id, "/oauth/token", &Value::Object(token))
        .await
        .is_some_and(|status| status != 401 && status != 403)
}

/// `getHostname()` for the Jellyfin settings.
fn jellyfin_host(settings: &Settings) -> String {
    let get = |key: &str| settings.get(&format!("/jellyfin/{key}"));
    super::super::authcommon::hostname_of(get("useSsl"), get("ip"), get("port"), get("urlBase"))
}

fn empty_readiness() -> Value {
    readiness(0, 0, Vec::new())
}

fn readiness(eligible: usize, ready: usize, users: Vec<Value>) -> Value {
    let mut out = Map::new();
    out.insert(String::from("eligibleUsers"), Value::from(eligible));
    out.insert(String::from("readyUsers"), Value::from(ready));
    out.insert(String::from("users"), Value::Array(users));
    Value::Object(out)
}

fn with_readiness(mut health: Map<String, Value>, readiness: Value) -> Map<String, Value> {
    health.insert(String::from("readiness"), readiness);
    health
}

/// `checkJellyfinTrakt`.
async fn jellyfin_trakt(state: &AppState, settings: &Settings) -> Map<String, Value> {
    if !truthy(settings.get("/jellyfin/ip")) {
        return with_readiness(
            not_configured("Jellyfin is not configured."),
            empty_readiness(),
        );
    }
    let host = jellyfin_host(settings);
    let sql = r#"SELECT "id", "email", "username", "plexUsername", "jellyfinUsername",
        "jellyfinAuthToken", "jellyfinDeviceId" FROM "user" WHERE "jellyfinUserId" IS NOT NULL"#;
    let users = match state.db.rows(sql, &[]).await {
        Ok(users) => users,
        Err(e) => {
            tracing::warn!("Better Trakt health check failed: {e:#} (hostname {host})");
            return with_readiness(
                degraded("Better Trakt could not be checked through Jellyfin."),
                empty_readiness(),
            );
        }
    };
    if users.is_empty() {
        let reached = state
            .outbound
            .get(format!("{host}/System/Info/Public"))
            .timeout(JELLYFIN_TIMEOUT)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status);
        return match reached {
            Ok(_) => with_readiness(
                degraded("Jellyfin is reachable, but no Foreseer users are linked to Jellyfin."),
                empty_readiness(),
            ),
            Err(e) => {
                tracing::warn!(
                    "Better Trakt health check could not reach Jellyfin: {e} (hostname {host})"
                );
                with_readiness(
                    degraded(&format!("Foreseer could not reach Jellyfin at {host}.")),
                    empty_readiness(),
                )
            }
        };
    }
    // `buildJellyfinAuthorizationHeader`'s version: `1.0.0` for Emby.
    let version = if settings
        .get("/main/mediaServerType")
        .and_then(Value::as_i64)
        == Some(EMBY)
    {
        String::from("1.0.0")
    } else {
        state.version.version.clone()
    };
    // `mapWithConcurrency(users, 4, ...)`, in order.
    let mut checked = Vec::with_capacity(users.len());
    for chunk in users.chunks(4) {
        let futures = chunk
            .iter()
            .map(|user| {
                user_readiness(
                    state.outbound.clone(),
                    host.clone(),
                    version.clone(),
                    user.clone(),
                )
            })
            .collect();
        checked.extend(super::super::nodestate::join_ordered(futures).await);
    }
    let users = checked;
    let ready = users
        .iter()
        .filter(|u| u.get("state").and_then(Value::as_str) == Some("ready"))
        .count();
    let eligible = users.len();
    let readiness = readiness(eligible, ready, users);
    if ready != eligible {
        let noun = if eligible == 1 {
            "user is"
        } else {
            "users are"
        };
        return with_readiness(
            degraded(&format!(
                "{ready} of {eligible} {noun} ready for Better Trakt."
            )),
            readiness,
        );
    }
    let detail = if ready == 1 {
        String::from("Jellyfin and Better Trakt are ready for the linked user.")
    } else {
        format!("Jellyfin and Better Trakt are ready for all {ready} linked users.")
    };
    with_readiness(healthy(&detail), readiness)
}

/// The `@AfterLoad` display name: username, Plex name, Jellyfin name or
/// the (lowercased) email.
fn display_name(user: &Map<String, Value>) -> String {
    ["username", "plexUsername", "jellyfinUsername"]
        .iter()
        .find_map(|k| {
            user.get(*k)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
        })
        .map_or_else(
            || {
                user.get("email")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_lowercase()
            },
            str::to_owned,
        )
}

/// `checkJellyfinUserReadiness`: `{ userId, displayName, state }`.
async fn user_readiness(
    client: reqwest::Client,
    host: String,
    version: String,
    user: Map<String, Value>,
) -> Value {
    let id = user.get("id").cloned().unwrap_or(Value::Null);
    let text = |k: &str| {
        user.get(k)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let verdict = match (text("jellyfinAuthToken"), text("jellyfinDeviceId")) {
        (Some(token), Some(device)) => {
            let call = TraktMe {
                client: &client,
                host: &host,
                version: &version,
                token: &token,
                device: &device,
            };
            call.state(&id).await
        }
        _ => "needs_session_refresh",
    };
    let mut out = Map::new();
    out.insert(String::from("userId"), id);
    out.insert(
        String::from("displayName"),
        Value::from(display_name(&user)),
    );
    out.insert(String::from("state"), Value::from(verdict));
    Value::Object(out)
}

/// Better Trakt's `/Trakt/me` for one Jellyfin session.
struct TraktMe<'a> {
    client: &'a reqwest::Client,
    host: &'a str,
    version: &'a str,
    token: &'a str,
    device: &'a str,
}

impl TraktMe<'_> {
    /// `resolveJellyfinTraktUserState` once the session is there.
    async fn state(&self, user_id: &Value) -> &'static str {
        let header = super::super::authcommon::authorization(
            Some(self.token),
            Some(self.device),
            self.version,
        );
        let sent = self
            .client
            .get(format!("{}/Trakt/me", self.host))
            .timeout(JELLYFIN_TIMEOUT)
            .header(reqwest::header::AUTHORIZATION, header)
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await;
        let status = match sent {
            Ok(res) if res.status().is_success() => {
                let data: Value = res.json().await.unwrap_or(Value::Null);
                if data.get("IsLinked") != Some(&Value::Bool(true)) {
                    return "needs_trakt_link";
                }
                if data.get("AllowExternalTokenAccess") != Some(&Value::Bool(true)) {
                    return "needs_access";
                }
                return "ready";
            }
            Ok(res) => Some(res.status().as_u16()),
            Err(_) => None,
        };
        tracing::warn!(
            "Better Trakt user readiness check failed (user {user_id}, status {status:?})"
        );
        if matches!(status, Some(401 | 403)) {
            "needs_session_refresh"
        } else {
            "unavailable"
        }
    }
}

/// `checkMdblist`.
async fn check_mdblist(state: &AppState, settings: &Settings) -> Map<String, Value> {
    if crate::jsval::trim(settings.str("/mdblist/apiKey")).is_empty() {
        return not_configured("MDBList API key is not configured.");
    }
    let client = crate::mdblist::Mdblist::new(&state.outbound, settings);
    if client.validate_api_key().await {
        healthy("MDBList API key is valid and the service is reachable.")
    } else {
        degraded("MDBList could not validate the saved API key.")
    }
}

/// `checkAnilist`.
async fn check_anilist(state: &AppState, settings: &Settings) -> Map<String, Value> {
    let blank = |key: &str| crate::jsval::trim(settings.str(key)).is_empty();
    if blank("/anilist/clientId") || blank("/anilist/clientSecret") {
        return not_configured("AniList application credentials are not configured.");
    }
    match crate::anilist::Anilist::new(&state.outbound, None)
        .ping()
        .await
    {
        Ok(()) => healthy("AniList GraphQL API is reachable."),
        Err(e) => {
            tracing::warn!("AniList health check failed: {}", e.message());
            degraded("AniList GraphQL API could not be reached.")
        }
    }
}

/// `checkSimkl`.
///
/// # Errors
///
/// When `simkl.clientId` isn't a string: Node's `trim()` throws and the
/// whole check fails.
async fn check_simkl(state: &AppState, settings: &Settings) -> Result<Map<String, Value>, String> {
    let Some(client_id) = settings.get("/simkl/clientId").and_then(Value::as_str) else {
        return Err(String::from("simkl.clientId is not text"));
    };
    if crate::jsval::trim(client_id).is_empty() {
        return Ok(not_configured("Simkl Client ID is not configured."));
    }
    let Some(simkl) = crate::simkl::Simkl::new(&state.outbound, settings, &state.version.version)
    else {
        return Ok(not_configured("Simkl Client ID is not configured."));
    };
    Ok(
        match simkl
            .cdn_catalog("/discover/trending/tv/week_100.json")
            .await
        {
            Ok(_) => healthy("Simkl is reachable and the Client ID was accepted."),
            Err(_) => degraded("Simkl could not accept the saved Client ID."),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn health_shapes() {
        let off = Value::Object(not_configured("x"));
        assert_eq!(
            off,
            json!({"state": "not_configured", "detail": "x", "checkedAt": null}),
            "not configured carries no time"
        );
        let on = healthy("y");
        assert!(
            on.get("checkedAt")
                .and_then(Value::as_str)
                .is_some_and(|t| t.ends_with('Z')),
            "checked now"
        );
        let with = with_readiness(degraded("z"), empty_readiness());
        let keys: Vec<&String> = with.keys().collect();
        assert_eq!(keys, ["state", "detail", "checkedAt", "readiness"], "order");
    }

    #[test]
    fn display_names() {
        let empty = Map::new();
        let user = json!({"username": "", "plexUsername": null, "jellyfinUsername": "jf", "email": "A@B.c"});
        assert_eq!(
            display_name(user.as_object().unwrap_or(&empty)),
            "jf",
            "jellyfin name"
        );
        let user = json!({"email": "A@B.c"});
        assert_eq!(
            display_name(user.as_object().unwrap_or(&empty)),
            "a@b.c",
            "email"
        );
    }
}
