//! Trakt through the Better Trakt Jellyfin plugin (`trakt.provider:
//! 'jellyfin'`).
//!
//! `createTraktUserClient` takes the user's Trakt token from the plugin's
//! token bridge (`GET {jellyfin}/Trakt/me/Token` with the user's Jellyfin
//! session), and asks it again whenever `TraktAPI` would refresh
//! (`server/lib/trakt.ts`, `getJellyfinTraktToken`).

use std::time::Duration;

use serde_json::Value;

use crate::db::Bind;
use crate::settings::Settings;
use crate::state::AppState;
use crate::trakt::{TraktClient, TraktError};

/// The refresh token `getJellyfinTraktToken` hands `TraktAPI`: it makes
/// the client call back here before expiry; nothing is sent with it.
pub const REFRESH_SENTINEL: &str = "jellyfin-provider";

/// `TraktJellyfinProviderError`'s messages.
const NOT_LINKED: &str = "Link your Jellyfin account to Foreseer before using Better Trakt.";
const NOT_AVAILABLE: &str = "Better Trakt is not available for this Jellyfin user. Link Jellyfin, link Trakt in Better Trakt, and ask an administrator to enable Foreseer access.";
const INCOMPLETE: &str =
    "Better Trakt returned an incomplete token bridge response. Update Better Trakt and try again.";
const UNREACHABLE: &str =
    "Unable to reach Better Trakt through Jellyfin. Check the Jellyfin connection and plugin setup.";

/// `MediaServerType.EMBY`.
const EMBY: i64 = 3;

/// One user's way to the token bridge.
#[derive(Debug, Clone)]
pub struct Bridge {
    http: reqwest::Client,
    /// `getHostname()`.
    hostname: String,
    /// `buildJellyfinAuthorizationHeader(token, deviceId)`.
    authorization: String,
    user_id: i64,
}

/// What the bridge answered: `{ clientId, accessToken, expiresAt }`.
#[derive(Debug, Clone, PartialEq)]
pub struct BridgeToken {
    pub client_id: String,
    pub access: String,
    /// Seconds since the epoch.
    pub expires_at: f64,
}

/// `new TraktJellyfinProviderError(message)`: the routes answer it with
/// their 500, the watched filters skip the source.
fn provider_error(message: &str) -> TraktError {
    TraktError::Other(message.to_owned())
}

impl Bridge {
    /// The user's Jellyfin session, when it has the columns
    /// `getJellyfinTraktToken` needs (`jellyfinUserId`, `jellyfinAuthToken`,
    /// `jellyfinDeviceId`).
    ///
    /// # Errors
    ///
    /// `TraktJellyfinProviderError` when one is missing; a database
    /// failure as itself.
    pub async fn for_user(
        state: &AppState,
        settings: &Settings,
        user_id: i64,
    ) -> Result<Self, TraktError> {
        let rows = state
            .db
            .rows(
                r#"SELECT "jellyfinUserId", "jellyfinAuthToken", "jellyfinDeviceId" FROM "user" WHERE "id" = ?1"#,
                &[Bind::Int(user_id)],
            )
            .await
            .map_err(|e| TraktError::Other(format!("{e:#}")))?;
        let row = rows.into_iter().next().unwrap_or_default();
        let text = |key: &str| {
            row.get(key)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        };
        let (Some(_), Some(token), Some(device)) = (
            text("jellyfinUserId"),
            text("jellyfinAuthToken"),
            text("jellyfinDeviceId"),
        ) else {
            return Err(provider_error(NOT_LINKED));
        };
        let emby = settings
            .get("/main/mediaServerType")
            .and_then(Value::as_i64)
            == Some(EMBY);
        let version = if emby {
            String::from("1.0.0")
        } else {
            state.version.version.clone()
        };
        Ok(Self {
            http: state.outbound.clone(),
            hostname: crate::jellyfin::hostname(settings),
            authorization: crate::jellyfin::authorization(&token, &device, &version),
            user_id,
        })
    }

    /// `fetchJellyfinTraktJson(user, '/Trakt/me/Token', 10000)` and the
    /// checks `getJellyfinTraktToken` makes of the answer.
    ///
    /// # Errors
    ///
    /// `TraktJellyfinProviderError` with the message Node gives each case.
    pub async fn token(&self) -> Result<BridgeToken, TraktError> {
        let url = format!("{}/Trakt/me/Token", self.hostname);
        let sent = self
            .http
            .get(&url)
            .header("Authorization", &self.authorization)
            .header("Accept", "application/json")
            .timeout(Duration::from_secs(10))
            .send()
            .await;
        let response = match sent {
            Ok(response) => response,
            Err(e) => {
                tracing::warn!(
                    label = "Trakt API",
                    user_id = self.user_id,
                    "Failed to retrieve Better Trakt token bridge response: {}",
                    crate::outbound::describe(&e)
                );
                return Err(provider_error(UNREACHABLE));
            }
        };
        let status = response.status().as_u16();
        if !response.status().is_success() {
            if status == 401 || status == 403 {
                return Err(provider_error(NOT_AVAILABLE));
            }
            tracing::warn!(
                label = "Trakt API",
                user_id = self.user_id,
                "Failed to retrieve Better Trakt token bridge response: status {status}"
            );
            return Err(provider_error(UNREACHABLE));
        }
        let Ok(bytes) = response.bytes().await else {
            return Err(provider_error(UNREACHABLE));
        };
        token_of(&bytes)
    }
}

/// The answer as axios hands it over (JSON, else the text) read as
/// `getJellyfinTraktToken` reads it.
fn token_of(bytes: &[u8]) -> Result<BridgeToken, TraktError> {
    let data = serde_json::from_slice::<Value>(bytes)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(bytes).into_owned()));
    if data.is_null() {
        // `data.AccessToken` throws a TypeError, which isn't an AxiosError.
        return Err(provider_error(UNREACHABLE));
    }
    let trimmed = |key: &str| match data.get(key) {
        Some(Value::String(s)) => crate::traktitems::js_trim(s).to_owned(),
        _ => String::new(),
    };
    let access = trimmed("AccessToken");
    let client_id = trimmed("ClientId");
    // `new Date(String(data.AccessTokenExpiration ?? ''))`.
    let expiration = match data.get("AccessTokenExpiration") {
        None | Some(Value::Null) => String::new(),
        Some(v) => crate::media::js_string(Some(v)).into_owned(),
    };
    let expires_ms = crate::jobs::syncutil::parse_js_date(&expiration);
    let (false, false, Some(ms)) = (access.is_empty(), client_id.is_empty(), expires_ms) else {
        return Err(provider_error(INCOMPLETE));
    };
    let seconds = ms.div_euclid(1000);
    Ok(BridgeToken {
        client_id,
        access,
        expires_at: format!("{seconds}").parse().unwrap_or(0.0),
    })
}

/// `createTraktUserClient(userId)` with the Better Trakt provider.
///
/// # Errors
///
/// `TraktJellyfinProviderError` (as `TraktError::Other`), from the session
/// check or the first bridge call.
pub async fn user_client(
    state: &AppState,
    settings: &Settings,
    user_id: i64,
) -> Result<TraktClient, TraktError> {
    let bridge = Bridge::for_user(state, settings, user_id).await?;
    let token = bridge.token().await?;
    Ok(TraktClient::jellyfin(state.outbound.clone(), token, bridge))
}

/// `error instanceof TraktJellyfinProviderError` (what
/// `isTraktUnavailableError` / `traktAvailabilityFromError` treat as
/// "unavailable" rather than rethrowing).
#[must_use]
pub fn is_provider_error(error: &TraktError) -> bool {
    matches!(error, TraktError::Other(m) if [NOT_LINKED, NOT_AVAILABLE, INCOMPLETE, UNREACHABLE].contains(&m.as_str()))
}

/// `isJellyfinTraktProvider()`.
#[must_use]
pub fn enabled(settings: &Settings) -> bool {
    settings.get("/trakt/provider").and_then(Value::as_str) == Some("jellyfin")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_bridge_answer() {
        let ok = token_of(
            br#"{"AccessToken":" tok ","ClientId":"cid","AccessTokenExpiration":"2026-10-20T12:34:56.1234567Z"}"#,
        );
        assert_eq!(
            ok,
            Ok(BridgeToken {
                client_id: String::from("cid"),
                access: String::from("tok"),
                expires_at: 1_792_499_696.0,
            }),
            "trimmed, seconds"
        );
        let incomplete = Err(provider_error(INCOMPLETE));
        assert_eq!(
            token_of(br#"{"AccessToken":"t","ClientId":"c"}"#),
            incomplete,
            "no expiry"
        );
        assert_eq!(
            token_of(br#"{"AccessToken":5,"ClientId":"c","AccessTokenExpiration":"2026-10-20"}"#),
            incomplete,
            "not a string"
        );
        assert_eq!(token_of(b"<html>"), incomplete, "text");
        assert!(
            is_provider_error(&provider_error(INCOMPLETE)),
            "provider error"
        );
        assert!(
            !is_provider_error(&TraktError::Other(String::from("db"))),
            "other"
        );
        assert_eq!(
            token_of(b"null"),
            Err(provider_error(UNREACHABLE)),
            "null throws"
        );
    }
}
