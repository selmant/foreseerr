//! Trakt, Simkl, `AniList` and `MDBList` settings writes.
//!
//! From `server/routes/settings/index.ts`: credentials and media-action
//! switches. The caches these reset (integration health, sync caches,
//! `MDBList` provider state) live in Node and are reset through
//! `POST /internal/settings/effects`.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use axum::http::Method;
use serde_json::{json, Map, Value};

use super::settings_util::{
    assign_merged, body_text, body_undefined, conforms, is_true, js_trim, json_body, linked,
    masked, node_effects, node_memory, not_false, provider_enabled, set_provider, Ty,
};
use super::{Outcome, Ready, Table, ADMIN};
use crate::db::LinkedAccounts;
use crate::settings::public::truthy;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/settings/trakt", Method::POST, trakt),
    (
        "/api/v1/settings/trakt/actions",
        Method::POST,
        trakt_actions,
    ),
    ("/api/v1/settings/simkl", Method::POST, simkl),
    (
        "/api/v1/settings/simkl/actions",
        Method::POST,
        simkl_actions,
    ),
    ("/api/v1/settings/anilist", Method::POST, anilist),
    (
        "/api/v1/settings/anilist/actions",
        Method::POST,
        anilist_actions,
    ),
    ("/api/v1/settings/mdblist", Method::POST, mdblist),
];

/// `ANILIST_OAUTH_PIN_REDIRECT`.
const ANILIST_REDIRECT: &str = "https://anilist.co/api/v2/oauth/pin";
/// What a masked secret is submitted as.
const MASK: &str = "********";

macro_rules! try_forward {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(why) => return Outcome::forward(why),
        }
    };
}

/// Save, or a logged 500: a failed save may have written part of the
/// file, so the request is never handed on.
macro_rules! save_or_fail {
    ($ctx:expr, $data:expr) => {
        if let Err(outcome) = super::nodestate::save($ctx, &$data).await {
            return outcome;
        }
    };
}

fn admin(ctx: &Ready<'_>) -> Result<(), super::Fallback> {
    ctx.no_query()?;
    ctx.authenticated(ADMIN).map(|_| ())
}

/// The body of a route that takes `{ actionsEnabled: boolean }` (required).
fn actions_body<'a>(ctx: &'a Ready<'a>) -> Result<bool, super::Fallback> {
    admin(ctx)?;
    let body = json_body(ctx)?;
    if !conforms(body, &[("actionsEnabled", Ty::Bool)], &["actionsEnabled"]) {
        return Err(String::from("a body the validator rejects").into());
    }
    body.get("actionsEnabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| "a body the validator rejects".into())
}

/// The `/{provider}/actions` routes: one media-actions switch.
async fn set_actions(ctx: &Ready<'_>, provider: &str) -> Outcome {
    let enabled = try_forward!(actions_body(ctx));
    let mut data = node_memory(ctx);
    set_provider(&mut data, provider, enabled);
    save_or_fail!(ctx, data);
    ctx.json(&json!({ "actionsEnabled": enabled }))
}

/// `POST /settings/trakt/actions`.
fn trakt_actions<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(set_actions(ctx, "trakt"))
}

/// `POST /settings/simkl/actions`.
fn simkl_actions<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(set_actions(ctx, "simkl"))
}

/// `POST /settings/anilist/actions`.
fn anilist_actions<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(set_actions(ctx, "anilist"))
}

/// Node's side effects after a save. Failing to reach Node is answered
/// with the route's error, as a throw there would be.
/// Cache resets can't fail in Node, so failing to reach it is only
/// logged; a disconnect that didn't happen is an error.
async fn effects_or_error(ctx: &Ready<'_>, effects: &[&str], message: &str) -> Option<Outcome> {
    match node_effects(ctx, effects).await {
        Ok(results) => {
            for (effect, label) in [
                ("disconnectAllSimklLinks", "Simkl"),
                ("disconnectAllAnilistLinks", "AniList"),
            ] {
                if let Some(count) = results.get(effect) {
                    tracing::info!(
                        "Disconnected {label} accounts after credential change: {count}"
                    );
                }
            }
            None
        }
        Err(e) if effects.iter().any(|e| e.starts_with("disconnect")) => {
            tracing::error!("{message}: {e:#}");
            Some(ctx.error(500, message))
        }
        Err(e) => {
            tracing::warn!("settings side effects did not run: {e:#}");
            None
        }
    }
}

/// `TraktSettings` in the spec.
const TRAKT_SCHEMA: &[(&str, Ty)] = &[
    ("provider", Ty::Enum(&["direct", "jellyfin"])),
    ("clientId", Ty::Str),
    ("clientSecret", Ty::Str),
    ("configured", Ty::Bool),
    ("actionsEnabled", Ty::Bool),
    ("linkedAccountCount", Ty::Int),
    ("confirmDisconnectLinkedAccounts", Ty::Bool),
    ("confirmProviderSwitch", Ty::Bool),
];

/// `POST /settings/trakt`. New direct credentials are checked against
/// Trakt (`validateApplicationCredentials`, outside the rate-limit
/// circuit); switching to Better Trakt checks that Jellyfin answers.
fn trakt<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(admin(ctx));
        if body_undefined(ctx) {
            // Reading `req.body` throws inside the handler's try.
            return ctx.error(500, "Unable to save Trakt settings.");
        }
        let body = try_forward!(json_body(ctx));
        if !conforms(body, TRAKT_SCHEMA, &[]) {
            return Outcome::forward(String::from("a body the validator may reject"));
        }
        let mut data = node_memory(ctx);
        let jellyfin = body.get("provider").and_then(Value::as_str) == Some("jellyfin");
        let provider = if jellyfin { "jellyfin" } else { "direct" };
        let was_jellyfin =
            data.pointer("/trakt/provider").and_then(Value::as_str) == Some("jellyfin");
        let previous_id = data.pointer("/trakt/clientId").cloned();
        let previous_secret = data.pointer("/trakt/clientSecret").cloned();
        let (client_id, client_secret) = if jellyfin {
            (Value::from(""), Value::from(""))
        } else {
            let secret = body_text(body, "clientSecret");
            let secret = if secret.is_empty() || secret == MASK {
                previous_secret.clone().unwrap_or(Value::Null)
            } else {
                Value::from(secret)
            };
            (Value::from(body_text(body, "clientId")), secret)
        };
        let credentials_changing = previous_id.as_ref() != Some(&client_id)
            || previous_secret.as_ref() != Some(&client_secret);
        let provider_changing = was_jellyfin != jellyfin;
        if !(jellyfin || truthy(Some(&client_id)) && truthy(Some(&client_secret))) {
            return ctx.error(400, "A Trakt Client ID and Client Secret are required.");
        }
        if jellyfin && provider_changing {
            if !is_true(body, "confirmProviderSwitch") {
                return ctx.error(400, "Switching to Better Trakt clears Direct Trakt credentials and linked accounts. Set confirmProviderSwitch to true to proceed.");
            }
            if !truthy(data.pointer("/jellyfin/ip")) || !truthy(data.pointer("/jellyfin/apiKey")) {
                return ctx.error(400, "Configure Jellyfin before switching to Better Trakt.");
            }
            // `new JellyfinAPI(getHostname(), apiKey).getSystemInfo()`.
            let jellyfin = data.get("jellyfin").cloned().unwrap_or(Value::Null);
            let client = super::jellyfinsettings::Jellyfin::new(ctx, &jellyfin, None);
            match client.get(ctx, "/System/Info").await {
                super::nodestate::Upstream::Json(_) | super::nodestate::Upstream::NotJson => {}
                super::nodestate::Upstream::Status(_) | super::nodestate::Upstream::Network(_) => {
                    return ctx.error(
                        400,
                        "Jellyfin could not be reached. Fix the Jellyfin connection before switching.",
                    );
                }
            }
        }
        if !jellyfin && credentials_changing {
            let count = try_forward!(linked(ctx, LinkedAccounts::Trakt).await);
            if count > 0 && !is_true(body, "confirmDisconnectLinkedAccounts") {
                return ctx.json_with(400, &json!({
                    "message": "Changing Trakt credentials will disconnect all linked user accounts. Set confirmDisconnectLinkedAccounts to true to proceed.",
                    "linkedAccountCount": count,
                }));
            }
            // `new TraktAPI(...)` trims both; anything but text throws.
            let (Some(id), Some(secret)) = (client_id.as_str(), client_secret.as_str()) else {
                return Outcome::forward(String::from("a stored Trakt secret that isn't text"));
            };
            let client = &ctx.state.outbound;
            if !super::procstate::health::validate_trakt_credentials(client, id, secret).await {
                tracing::error!(
                    "Something went wrong saving Trakt settings: invalid Trakt credentials"
                );
                return ctx.error(500, "Unable to save Trakt settings.");
            }
        }
        assign_merged(
            &mut data,
            "trakt",
            json!({ "provider": provider, "clientId": client_id, "clientSecret": client_secret }),
        );
        set_provider(&mut data, "trakt", not_false(body, "actionsEnabled"));
        save_or_fail!(ctx, data);
        let mut effects = vec!["clearIntegrationHealthCache"];
        if !jellyfin && credentials_changing {
            effects.extend(["disconnectAllTraktLinks", "clearSyncCache"]);
        } else if jellyfin && provider_changing {
            effects.push("disconnectAllTraktLinks");
        }
        if provider_changing {
            effects.push("clearSyncCache");
        }
        if let Some(error) = effects_or_error(ctx, &effects, "Unable to save Trakt settings.").await
        {
            return error;
        }
        let count = match linked(ctx, LinkedAccounts::Trakt).await {
            Ok(count) => count,
            Err(why) => {
                tracing::error!("Unable to save Trakt settings. {why}");
                return ctx.error(500, "Unable to save Trakt settings.");
            }
        };
        let configured = if jellyfin {
            truthy(data.pointer("/jellyfin/ip"))
        } else {
            truthy(data.pointer("/trakt/clientId")) && truthy(data.pointer("/trakt/clientSecret"))
        };
        let mut out = Map::new();
        out.insert(String::from("provider"), Value::from(provider));
        out.insert(
            String::from("clientId"),
            data.pointer("/trakt/clientId")
                .cloned()
                .unwrap_or(Value::Null),
        );
        out.insert(
            String::from("clientSecret"),
            masked(data.pointer("/trakt/clientSecret")),
        );
        out.insert(String::from("configured"), Value::Bool(configured));
        out.insert(
            String::from("actionsEnabled"),
            Value::Bool(provider_enabled(&data, "trakt")),
        );
        out.insert(String::from("linkedAccountCount"), Value::from(count));
        ctx.json(&Value::Object(out))
    })
}

/// `SimklAPI.validateClientId()`: a CDN catalogue only a real client id
/// may read.
async fn simkl_valid(ctx: &Ready<'_>, client_id: &str) -> bool {
    let version = &ctx.state.version.version;
    let query = [
        ("client_id", client_id),
        ("app-name", "foreseerr"),
        ("app-version", version.as_str()),
    ];
    let query: Vec<String> = query
        .iter()
        .map(|(k, v)| format!("{k}={}", url_search_param(v)))
        .collect();
    let url = format!(
        "https://data.simkl.in/discover/trending/tv/week_100.json?{}",
        query.join("&")
    );
    let mut request = ctx
        .state
        .outbound
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header("simkl-api-key", client_id)
        .header("app-name", "foreseerr")
        .header("app-version", version.as_str())
        .header(
            reqwest::header::USER_AGENT,
            format!("Foreseerr/{version} (Simkl integration)"),
        );
    if let Some(ms) = ctx
        .settings
        .get("/network/apiRequestTimeout")
        .and_then(Value::as_u64)
        .filter(|ms| *ms > 0)
    {
        request = request.timeout(Duration::from_millis(ms));
    }
    match request
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
    {
        Ok(_) => true,
        Err(e) => {
            tracing::error!("Unable to save Simkl settings: {e:#}");
            false
        }
    }
}

/// `URLSearchParams` value encoding (`application/x-www-form-urlencoded`).
fn url_search_param(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(char::from(byte));
            }
            b' ' => out.push('+'),
            other => {
                out.push('%');
                out.push(hex(other >> 4));
                out.push(hex(other & 0xf));
            }
        }
    }
    out
}

/// An upper-case hex digit.
fn hex(nibble: u8) -> char {
    char::from_digit(u32::from(nibble), 16).map_or('0', |c| c.to_ascii_uppercase())
}

/// `POST /settings/simkl`.
fn simkl<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(admin(ctx));
        if body_undefined(ctx) {
            // Reading `req.body` throws inside the handler's try.
            return ctx.error(500, "Unable to save Simkl settings.");
        }
        let body = try_forward!(json_body(ctx));
        let schema = [
            ("clientId", Ty::Str),
            ("actionsEnabled", Ty::Bool),
            ("showCommunityRating", Ty::Bool),
            ("posterCommunityRating", Ty::Bool),
            ("confirmDisconnectLinkedAccounts", Ty::Bool),
        ];
        if !conforms(body, &schema, &[]) {
            return Outcome::forward(String::from("a body the validator may reject"));
        }
        let mut data = node_memory(ctx);
        let client_id = body_text(body, "clientId");
        let changing = data.pointer("/simkl/clientId").and_then(Value::as_str) != Some(&client_id);
        let count = try_forward!(linked(ctx, LinkedAccounts::Simkl).await);
        if changing && count > 0 && !is_true(body, "confirmDisconnectLinkedAccounts") {
            return ctx.json_with(400, &json!({
                "message": "Changing Simkl credentials disconnects linked user accounts. Set confirmDisconnectLinkedAccounts to true to proceed.",
                "linkedAccountCount": count,
            }));
        }
        if !client_id.is_empty() && !simkl_valid(ctx, &client_id).await {
            return ctx.error(500, "Unable to save Simkl settings.");
        }
        let show = not_false(body, "showCommunityRating");
        let poster = is_true(body, "posterCommunityRating");
        assign_merged(
            &mut data,
            "simkl",
            json!({ "clientId": client_id, "showCommunityRating": show, "posterCommunityRating": poster }),
        );
        set_provider(&mut data, "simkl", not_false(body, "actionsEnabled"));
        save_or_fail!(ctx, data);
        let mut effects = vec!["clearIntegrationHealthCache"];
        if changing && count > 0 {
            effects.push("disconnectAllSimklLinks");
        }
        if let Some(error) = effects_or_error(ctx, &effects, "Unable to save Simkl settings.").await
        {
            return error;
        }
        let count = match linked(ctx, LinkedAccounts::Simkl).await {
            Ok(count) => count,
            Err(why) => {
                tracing::error!("Unable to save Simkl settings. {why}");
                return ctx.error(500, "Unable to save Simkl settings.");
            }
        };
        let mut out = Map::new();
        out.insert(String::from("clientId"), Value::from(client_id.as_str()));
        out.insert(
            String::from("configured"),
            Value::Bool(!client_id.is_empty()),
        );
        out.insert(
            String::from("actionsEnabled"),
            Value::Bool(provider_enabled(&data, "simkl")),
        );
        for key in ["showCommunityRating", "posterCommunityRating"] {
            if let Some(v) = data.pointer(&format!("/simkl/{key}")) {
                out.insert(String::from(key), v.clone());
            }
        }
        out.insert(String::from("linkedAccountCount"), Value::from(count));
        ctx.json(&Value::Object(out))
    })
}

/// `POST /settings/anilist`.
fn anilist<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(admin(ctx));
        if body_undefined(ctx) {
            // Reading `req.body` throws inside the handler's try.
            return ctx.error(500, "Unable to save AniList settings.");
        }
        let body = try_forward!(json_body(ctx));
        let schema = [
            ("clientId", Ty::Str),
            ("clientSecret", Ty::Str),
            ("configured", Ty::Bool),
            ("actionsEnabled", Ty::Bool),
            ("redirectUrl", Ty::Str),
            ("linkedAccountCount", Ty::Int),
        ];
        if !conforms(body, &schema, &[]) {
            return Outcome::forward(String::from("a body the validator may reject"));
        }
        let mut data = node_memory(ctx);
        let previous_id = data.pointer("/anilist/clientId").cloned();
        let previous_secret = data.pointer("/anilist/clientSecret").cloned();
        let mut client_id = Value::from(body_text(body, "clientId"));
        let secret = body_text(body, "clientSecret");
        let mut client_secret = if secret.is_empty() || secret == MASK {
            previous_secret.clone().unwrap_or(Value::Null)
        } else {
            Value::from(secret)
        };
        let clearing = is_true(body, "clearCredentials")
            || (!truthy(Some(&client_id)) && !truthy(Some(&client_secret)));
        if clearing {
            client_id = Value::from("");
            client_secret = Value::from("");
        }
        if !(clearing || truthy(Some(&client_id)) && truthy(Some(&client_secret))) {
            return ctx.error(400, "An AniList Client ID and Client Secret are required.");
        }
        let changing = previous_id.as_ref() != Some(&client_id)
            || previous_secret.as_ref() != Some(&client_secret);
        if changing && !clearing {
            let count = try_forward!(linked(ctx, LinkedAccounts::Anilist).await);
            if count > 0 && !is_true(body, "confirmDisconnectLinkedAccounts") {
                return ctx.json_with(400, &json!({
                    "message": "Changing AniList credentials will disconnect all linked user accounts. Set confirmDisconnectLinkedAccounts to true to proceed.",
                    "linkedAccountCount": count,
                }));
            }
        }
        assign_merged(
            &mut data,
            "anilist",
            json!({ "clientId": client_id, "clientSecret": client_secret }),
        );
        set_provider(&mut data, "anilist", not_false(body, "actionsEnabled"));
        save_or_fail!(ctx, data);
        let mut effects = vec!["clearIntegrationHealthCache"];
        if changing {
            effects.extend(["disconnectAllAnilistLinks", "clearAnilistSyncCache"]);
        }
        if let Some(error) =
            effects_or_error(ctx, &effects, "Unable to save AniList settings.").await
        {
            return error;
        }
        let count = match linked(ctx, LinkedAccounts::Anilist).await {
            Ok(count) => count,
            Err(why) => {
                tracing::error!("Unable to save AniList settings. {why}");
                return ctx.error(500, "Unable to save AniList settings.");
            }
        };
        let mut out = Map::new();
        out.insert(
            String::from("clientId"),
            data.pointer("/anilist/clientId")
                .cloned()
                .unwrap_or(Value::Null),
        );
        out.insert(
            String::from("clientSecret"),
            masked(data.pointer("/anilist/clientSecret")),
        );
        out.insert(
            String::from("configured"),
            Value::Bool(
                truthy(data.pointer("/anilist/clientId"))
                    && truthy(data.pointer("/anilist/clientSecret")),
            ),
        );
        out.insert(
            String::from("actionsEnabled"),
            Value::Bool(provider_enabled(&data, "anilist")),
        );
        out.insert(String::from("redirectUrl"), Value::from(ANILIST_REDIRECT));
        out.insert(String::from("linkedAccountCount"), Value::from(count));
        ctx.json(&Value::Object(out))
    })
}

/// `DEFAULT_RATING_BADGE_SETTINGS`, in declaration order.
const BADGES: [(&str, bool); 12] = [
    ("showTmdb", true),
    ("showImdb", true),
    ("showRt", true),
    ("showRtUser", true),
    ("showMetacritic", true),
    ("showTraktCommunity", true),
    ("posterTmdb", true),
    ("posterImdb", true),
    ("posterRt", true),
    ("posterRtUser", false),
    ("posterMetacritic", false),
    ("posterTraktCommunity", false),
];

/// The `mdblist` getter: `{ ...DEFAULT_RATING_BADGE_SETTINGS, ...mdblist }`
/// written back, which moves the badge keys first.
fn mdblist_backfilled(data: &mut Value) -> Option<&mut Map<String, Value>> {
    let current = data.get("mdblist")?.as_object()?.clone();
    let mut out = Map::new();
    for (key, default) in BADGES {
        out.insert(String::from(key), Value::Bool(default));
    }
    for (k, v) in current {
        out.insert(k, v);
    }
    let slot = data.get_mut("mdblist")?;
    *slot = Value::Object(out);
    slot.as_object_mut()
}

/// `MdbListSettings` in the spec.
const MDBLIST_SCHEMA: &[(&str, Ty)] = &[
    ("apiKey", Ty::Str),
    ("configured", Ty::Bool),
    ("showTmdb", Ty::Bool),
    ("showImdb", Ty::Bool),
    ("showRt", Ty::Bool),
    ("showRtUser", Ty::Bool),
    ("showMetacritic", Ty::Bool),
    ("showTraktCommunity", Ty::Bool),
    ("posterTmdb", Ty::Bool),
    ("posterImdb", Ty::Bool),
    ("posterRt", Ty::Bool),
    ("posterRtUser", Ty::Bool),
    ("posterMetacritic", Ty::Bool),
    ("posterTraktCommunity", Ty::Bool),
    ("clearApiKey", Ty::Bool),
];

/// `mdblistSettingsResponse()`.
fn mdblist_response(m: &Map<String, Value>) -> Value {
    let api_key = m.get("apiKey");
    let mut out = Map::new();
    out.insert(String::from("apiKey"), masked(api_key));
    out.insert(
        String::from("configured"),
        Value::Bool(
            api_key
                .and_then(Value::as_str)
                .is_some_and(|k| !js_trim(k).is_empty()),
        ),
    );
    for (key, _) in BADGES {
        if let Some(v) = m.get(key) {
            out.insert(String::from(key), v.clone());
        }
    }
    Value::Object(out)
}

/// `POST /settings/mdblist`.
fn mdblist<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(admin(ctx));
        if body_undefined(ctx) {
            // Reading `req.body` throws inside the handler's try.
            return ctx.error(500, "Unable to save MDBList settings.");
        }
        let body = try_forward!(json_body(ctx));
        if !conforms(body, MDBLIST_SCHEMA, &[]) {
            return Outcome::forward(String::from("a body the validator may reject"));
        }
        let mut data = node_memory(ctx);
        let Some(current) = mdblist_backfilled(&mut data) else {
            return Outcome::forward(String::from("mdblist is not an object"));
        };
        let previous = current.get("apiKey").cloned();
        if !matches!(previous, None | Some(Value::Null | Value::String(_))) {
            return Outcome::forward(String::from("mdblist apiKey is not a string"));
        }
        let clearing = is_true(body, "clearApiKey");
        let submitted = body_text(body, "apiKey");
        let api_key = if clearing {
            Value::from("")
        } else if submitted.is_empty() || submitted == MASK {
            previous.clone().unwrap_or(Value::Null)
        } else {
            Value::from(submitted)
        };
        let mut incoming = Map::new();
        incoming.insert(String::from("apiKey"), api_key.clone());
        for (key, _) in BADGES {
            // `show*`: `!== false`; `poster*`: `boolOrDefault(body, current)`.
            let value = if key.starts_with("show") {
                Value::Bool(not_false(body, key))
            } else {
                match body.get(key) {
                    Some(Value::Bool(b)) => Value::Bool(*b),
                    _ => current.get(key).cloned().unwrap_or(Value::Null),
                }
            };
            incoming.insert(String::from(key), value);
        }
        let changed = clearing || previous.as_ref() != Some(&api_key);
        assign_merged(&mut data, "mdblist", Value::Object(incoming));
        save_or_fail!(ctx, data);
        let mut effects = vec!["clearIntegrationHealthCache"];
        if changed {
            effects.push("clearMdblistProviderState");
            tracing::info!(
                "Reset MDBList provider state after credential change (cleared: {clearing})"
            );
        }
        if let Err(e) = node_effects(ctx, &effects).await {
            tracing::warn!("MDBList side effects did not run: {e:#}");
        }
        let Some(saved) = data.get("mdblist").and_then(Value::as_object) else {
            return ctx.error(500, "Unable to save MDBList settings.");
        };
        ctx.json(&mdblist_response(saved))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backfills_mdblist_like_the_getter() {
        let mut data = json!({"mdblist": {"apiKey": "k", "showTmdb": false}});
        let keys: Vec<String> = mdblist_backfilled(&mut data)
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default();
        assert_eq!(
            keys.first().map(String::as_str),
            Some("showTmdb"),
            "badges first"
        );
        assert_eq!(
            keys.last().map(String::as_str),
            Some("apiKey"),
            "apiKey last"
        );
        assert_eq!(
            data.pointer("/mdblist/showTmdb"),
            Some(&json!(false)),
            "kept"
        );
    }

    #[test]
    fn encodes_search_params() {
        assert_eq!(url_search_param("a b/c~"), "a+b%2Fc%7E", "form encoding");
    }
}
