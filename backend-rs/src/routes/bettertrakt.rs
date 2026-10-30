//! Trakt through the Better Trakt Jellyfin plugin (`trakt.provider:
//! 'jellyfin'`): the linked-account payload `getTraktLinkedAccountPayload`
//! builds, with `resolveJellyfinTraktUserState`'s plugin check.

use std::time::Duration;

use serde_json::{Map, Value};

use super::Ready;
use crate::db::Bind;

/// `MediaServerType.EMBY`.
const EMBY: i64 = 3;

/// The user's Jellyfin link columns.
struct JellyfinLink {
    user_id: Option<String>,
    token: Option<String>,
    device: Option<String>,
    username: Option<String>,
}

async fn link(ctx: &Ready<'_>, user_id: i64) -> anyhow::Result<JellyfinLink> {
    let rows = ctx
        .state
        .db
        .rows(
            r#"SELECT "jellyfinUserId", "jellyfinAuthToken", "jellyfinDeviceId", "jellyfinUsername" FROM "user" WHERE "id" = ?1"#,
            &[Bind::Int(user_id)],
        )
        .await?;
    let row = rows.into_iter().next().unwrap_or_default();
    let text = |key: &str| row.get(key).and_then(Value::as_str).map(str::to_owned);
    Ok(JellyfinLink {
        user_id: text("jellyfinUserId"),
        token: text("jellyfinAuthToken"),
        device: text("jellyfinDeviceId"),
        username: text("jellyfinUsername"),
    })
}

fn set(value: Option<&String>) -> bool {
    value.is_some_and(|v| !v.is_empty())
}

/// `resolveJellyfinTraktUserState(user)`: `GET /Trakt/me` through the
/// user's Jellyfin session.
async fn plugin_state(ctx: &Ready<'_>, user: &JellyfinLink) -> &'static str {
    let (Some(token), Some(device)) = (
        user.token.as_deref().filter(|t| !t.is_empty()),
        user.device.as_deref().filter(|d| !d.is_empty()),
    ) else {
        return "needs_session_refresh";
    };
    let version = if ctx
        .settings
        .get("/main/mediaServerType")
        .and_then(Value::as_i64)
        == Some(EMBY)
    {
        String::from("1.0.0")
    } else {
        ctx.state.version.version.clone()
    };
    let url = format!("{}/Trakt/me", crate::jellyfin::hostname(&ctx.settings));
    let sent = ctx
        .state
        .outbound
        .get(&url)
        .header(
            "Authorization",
            crate::jellyfin::authorization(token, device, &version),
        )
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(5))
        .send()
        .await;
    let response = match sent {
        Ok(response) => response,
        Err(e) => {
            tracing::warn!(
                "Better Trakt user readiness check failed: {}",
                crate::outbound::describe(&e)
            );
            return "unavailable";
        }
    };
    let status = response.status().as_u16();
    if !response.status().is_success() {
        tracing::warn!("Better Trakt user readiness check failed: status {status}");
        return if status == 401 || status == 403 {
            "needs_session_refresh"
        } else {
            "unavailable"
        };
    }
    let data: Value = response
        .bytes()
        .await
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null);
    if data.get("IsLinked") != Some(&Value::Bool(true)) {
        "needs_trakt_link"
    } else if data.get("AllowExternalTokenAccess") != Some(&Value::Bool(true)) {
        "needs_access"
    } else {
        "ready"
    }
}

/// `getTraktLinkedAccountPayload(userId, { includePluginStatus })` for the
/// Jellyfin provider.
///
/// # Errors
///
/// Database failures.
pub(super) async fn linked_payload(
    ctx: &Ready<'_>,
    user_id: i64,
    include_plugin_status: bool,
    actions_enabled: bool,
) -> anyhow::Result<Value> {
    let user = link(ctx, user_id).await?;
    let connected = set(user.user_id.as_ref()) && set(user.token.as_ref());
    let mut out = Map::new();
    out.insert(String::from("provider"), Value::from("jellyfin"));
    out.insert(String::from("connected"), Value::Bool(connected));
    out.insert(
        String::from("needsJellyfinSessionRefresh"),
        Value::Bool(set(user.user_id.as_ref()) && !set(user.token.as_ref())),
    );
    out.insert(
        String::from("username"),
        if connected {
            Value::from(
                user.username
                    .clone()
                    .unwrap_or_else(|| String::from("Jellyfin")),
            )
        } else {
            Value::Null
        },
    );
    out.insert(String::from("actionsEnabled"), Value::Bool(actions_enabled));
    if include_plugin_status {
        let state = if set(user.user_id.as_ref()) {
            plugin_state(ctx, &user).await
        } else {
            "needs_jellyfin"
        };
        out.insert(String::from("pluginState"), Value::from(state));
        out.insert(
            String::from("needsJellyfinSessionRefresh"),
            Value::Bool(state == "needs_session_refresh"),
        );
    }
    Ok(Value::Object(out))
}
