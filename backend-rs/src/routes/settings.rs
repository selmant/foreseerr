//! Admin reads of settings.json from `server/routes/settings`. Every route
//! here sits behind `isAuthenticated(Permission.ADMIN)` in Node.

use std::future::Future;
use std::pin::Pin;

use base64::prelude::*;
use serde_json::{Map, Value};

use super::{Outcome, Ready};
use crate::settings::public::truthy;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// `Permission.ADMIN`.
const ADMIN: i64 = 2;
/// `ANILIST_OAUTH_PIN_REDIRECT`.
const ANILIST_REDIRECT: &str = "https://anilist.co/api/v2/oauth/pin";
/// What secrets are shown as.
const MASK: &str = "********";

/// A route that answers with one section of settings.json, by JSON pointer.
pub(super) fn section(pointer: &'static str) -> super::Native {
    // A fn pointer can't capture, so the pointer travels in a table.
    SECTION_ROUTES
        .iter()
        .find(|(p, _)| *p == pointer)
        .map_or(unknown_section, |(_, f)| *f)
}

fn unknown_section<'a>(_ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async { Outcome::forward(String::from("no such settings section")) })
}

macro_rules! section_route {
    ($name:ident, $pointer:literal) => {
        fn $name<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
            Box::pin(async move { respond_section(ctx, $pointer) })
        }
    };
}

section_route!(network, "/network");
section_route!(servarr_interventions, "/servarrInterventions");
section_route!(plex, "/plex");
section_route!(plex_libraries, "/plex/libraries");
section_route!(jellyfin_libraries, "/jellyfin/libraries");
section_route!(jellyfin, "/jellyfin");
section_route!(tautulli, "/tautulli");
section_route!(radarr, "/radarr");
section_route!(sonarr, "/sonarr");
section_route!(discord, "/notifications/agents/discord");
section_route!(slack, "/notifications/agents/slack");
section_route!(telegram, "/notifications/agents/telegram");
section_route!(pushbullet, "/notifications/agents/pushbullet");
section_route!(pushover, "/notifications/agents/pushover");
section_route!(email, "/notifications/agents/email");
section_route!(webpush, "/notifications/agents/webpush");
section_route!(gotify, "/notifications/agents/gotify");
section_route!(ntfy, "/notifications/agents/ntfy");

const SECTION_ROUTES: [(&str, super::Native); 18] = [
    ("/network", network),
    ("/plex/libraries", plex_libraries),
    ("/jellyfin/libraries", jellyfin_libraries),
    ("/servarrInterventions", servarr_interventions),
    ("/plex", plex),
    ("/jellyfin", jellyfin),
    ("/tautulli", tautulli),
    ("/radarr", radarr),
    ("/sonarr", sonarr),
    ("/notifications/agents/discord", discord),
    ("/notifications/agents/slack", slack),
    ("/notifications/agents/telegram", telegram),
    ("/notifications/agents/pushbullet", pushbullet),
    ("/notifications/agents/pushover", pushover),
    ("/notifications/agents/email", email),
    ("/notifications/agents/webpush", webpush),
    ("/notifications/agents/gotify", gotify),
    ("/notifications/agents/ntfy", ntfy),
];

/// The admin check and the bare-request check every route here starts with.
fn admin(ctx: &Ready<'_>) -> Result<(), super::Fallback> {
    ctx.no_query()?;
    ctx.authenticated(ADMIN).map(|_| ())
}

fn respond_section(ctx: &Ready<'_>, pointer: &str) -> Outcome {
    if let Err(why) = admin(ctx) {
        return Outcome::forward(why);
    }
    // `res.json(undefined)` sends an empty body; nothing in defaults.json
    // is missing, so a missing section means the defaults are stale.
    ctx.settings.get(pointer).map_or_else(
        || Outcome::forward(format!("{pointer} is not in the settings")),
        |value| ctx.json(value),
    )
}

/// `GET /settings/main`: `main` with the API key in effect (`API_KEY`
/// replaces the stored one in Node's memory).
pub(super) fn main<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = admin(ctx) {
            return Outcome::forward(why);
        }
        let Some(Value::Object(main)) = ctx.settings.get("/main") else {
            return Outcome::forward(String::from("main is not an object"));
        };
        let mut main = main.clone();
        main.insert(String::from("apiKey"), Value::from(ctx.settings.api_key()));
        ctx.json(&Value::Object(main))
    })
}

/// `GET /settings/metadatas`.
pub(super) fn metadata<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = admin(ctx) {
            return Outcome::forward(why);
        }
        let field = |name: &str| {
            ctx.settings
                .get(&format!("/metadataSettings/{name}"))
                .cloned()
        };
        let mut out = Map::new();
        // `undefined` fields are dropped by JSON.
        if let Some(tv) = field("tv") {
            out.insert(String::from("tv"), tv);
        }
        if let Some(anime) = field("anime") {
            out.insert(String::from("anime"), anime);
        }
        ctx.json(&Value::Object(out))
    })
}

/// `GET /settings/notifications/webhook`: the agent settings with the
/// base64 payload template decoded and two optional fields defaulted.
pub(super) fn webhook<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = admin(ctx) {
            return Outcome::forward(why);
        }
        let agent = ctx.settings.get("/notifications/agents/webhook");
        let Some(Value::Object(options)) = agent.and_then(|a| a.get("options")) else {
            return Outcome::forward(String::from("webhook options are not an object"));
        };
        let Some(encoded) = options.get("jsonPayload").and_then(Value::as_str) else {
            return Outcome::forward(String::from("webhook jsonPayload is not a string"));
        };
        let payload = BASE64_STANDARD
            .decode(encoded)
            .or_else(|_| BASE64_STANDARD_NO_PAD.decode(encoded))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        let Some(payload) = payload else {
            return Outcome::forward(String::from("webhook jsonPayload is not base64 JSON"));
        };
        let mut options = options.clone();
        options.insert(String::from("jsonPayload"), payload);
        if matches!(options.get("customHeaders"), None | Some(Value::Null)) {
            options.insert(String::from("customHeaders"), Value::Array(Vec::new()));
        }
        if matches!(options.get("supportVariables"), None | Some(Value::Null)) {
            options.insert(String::from("supportVariables"), Value::Bool(false));
        }
        let field = |name: &str| agent.and_then(|a| a.get(name)).cloned();
        let mut out = Map::new();
        for name in ["enabled", "embedPoster", "types"] {
            if let Some(v) = field(name) {
                out.insert(String::from(name), v);
            }
        }
        out.insert(String::from("options"), Value::Object(options));
        ctx.json(&Value::Object(out))
    })
}

/// `GET /settings/trakt`.
pub(super) fn trakt<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = admin(ctx) {
            return Outcome::forward(why);
        }
        let s = &ctx.settings;
        let provider = if s.str("/trakt/provider") == "jellyfin" {
            "jellyfin"
        } else {
            "direct"
        };
        let count = match ctx
            .state
            .db
            .count_user_settings(crate::db::LinkedAccounts::Trakt)
            .await
        {
            Ok(count) => count,
            Err(e) => return Outcome::forward(format!("counting Trakt accounts failed: {e:#}")),
        };
        let configured = if provider == "jellyfin" {
            truthy(s.get("/jellyfin/ip"))
        } else {
            truthy(s.get("/trakt/clientId")) && truthy(s.get("/trakt/clientSecret"))
        };
        let mut out = Map::new();
        out.insert(String::from("provider"), Value::from(provider));
        out.insert(
            String::from("clientId"),
            s.get("/trakt/clientId").cloned().unwrap_or(Value::Null),
        );
        out.insert(
            String::from("clientSecret"),
            masked(s.get("/trakt/clientSecret")),
        );
        out.insert(String::from("configured"), Value::Bool(configured));
        out.insert(
            String::from("actionsEnabled"),
            Value::Bool(!matches!(
                s.get("/mediaActions/providers/trakt"),
                Some(Value::Bool(false))
            )),
        );
        out.insert(String::from("linkedAccountCount"), Value::from(count));
        ctx.json(&Value::Object(out))
    })
}

/// `GET /settings/simkl`.
pub(super) fn simkl<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = admin(ctx) {
            return Outcome::forward(why);
        }
        let s = &ctx.settings;
        // `clientId?.trim()` throws on anything but a string or nothing.
        let client_id = match s.get("/simkl/clientId") {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(own)) => crate::simklapi::legacy_client_id(own),
            Some(_) => {
                return Outcome::forward(String::from("simkl clientId is not a string"));
            }
        };
        let count = match ctx
            .state
            .db
            .count_user_settings(crate::db::LinkedAccounts::Simkl)
            .await
        {
            Ok(count) => count,
            Err(e) => return Outcome::forward(format!("counting Simkl accounts failed: {e:#}")),
        };
        let mut out = Map::new();
        out.insert(
            String::from("enabled"),
            Value::Bool(s.get("/simkl/enabled") != Some(&Value::Bool(false))),
        );
        out.insert(String::from("clientId"), Value::from(client_id));
        out.insert(
            String::from("configured"),
            Value::Bool(crate::simklapi::effective_client_id(s).is_some_and(|id| !id.is_empty())),
        );
        out.insert(
            String::from("actionsEnabled"),
            Value::Bool(!matches!(
                s.get("/mediaActions/providers/simkl"),
                Some(Value::Bool(false))
            )),
        );
        for name in ["showCommunityRating", "posterCommunityRating"] {
            if let Some(v) = s.get(&format!("/simkl/{name}")) {
                out.insert(String::from(name), v.clone());
            }
        }
        out.insert(String::from("linkedAccountCount"), Value::from(count));
        ctx.json(&Value::Object(out))
    })
}

/// `GET /settings/anilist`.
pub(super) fn anilist<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = admin(ctx) {
            return Outcome::forward(why);
        }
        let s = &ctx.settings;
        let count = match ctx
            .state
            .db
            .count_user_settings(crate::db::LinkedAccounts::Anilist)
            .await
        {
            Ok(count) => count,
            Err(e) => return Outcome::forward(format!("counting AniList accounts failed: {e:#}")),
        };
        let mut out = Map::new();
        out.insert(
            String::from("clientId"),
            s.get("/anilist/clientId").cloned().unwrap_or(Value::Null),
        );
        out.insert(
            String::from("clientSecret"),
            masked(s.get("/anilist/clientSecret")),
        );
        out.insert(
            String::from("configured"),
            Value::Bool(
                truthy(s.get("/anilist/clientId")) && truthy(s.get("/anilist/clientSecret")),
            ),
        );
        out.insert(
            String::from("actionsEnabled"),
            Value::Bool(!matches!(
                s.get("/mediaActions/providers/anilist"),
                Some(Value::Bool(false))
            )),
        );
        out.insert(String::from("redirectUrl"), Value::from(ANILIST_REDIRECT));
        out.insert(String::from("linkedAccountCount"), Value::from(count));
        ctx.json(&Value::Object(out))
    })
}

/// `GET /settings/mdblist`.
pub(super) fn mdblist<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = admin(ctx) {
            return Outcome::forward(why);
        }
        let s = &ctx.settings;
        let api_key = s.get("/mdblist/apiKey");
        // `apiKey?.trim()` throws on a value that is neither nullish nor a string.
        let configured = match api_key {
            None | Some(Value::Null) => false,
            Some(Value::String(k)) => !k.trim().is_empty(),
            Some(_) => return Outcome::forward(String::from("mdblist apiKey is not a string")),
        };
        let mut out = Map::new();
        out.insert(String::from("apiKey"), masked(api_key));
        out.insert(String::from("configured"), Value::Bool(configured));
        for name in [
            "showTmdb",
            "showImdb",
            "showRt",
            "showRtUser",
            "showMetacritic",
            "showTraktCommunity",
            "posterTmdb",
            "posterImdb",
            "posterRt",
            "posterRtUser",
            "posterMetacritic",
            "posterTraktCommunity",
        ] {
            if let Some(v) = s.get(&format!("/mdblist/{name}")) {
                out.insert(String::from(name), v.clone());
            }
        }
        ctx.json(&Value::Object(out))
    })
}

/// `value ? '********' : ''`.
fn masked(value: Option<&Value>) -> Value {
    Value::from(if truthy(value) { MASK } else { "" })
}

/// `GET /settings/about`: version, row counts, `TZ` and the config
/// directory (`appDataPath()`: `CONFIG_DIRECTORY`, else `config/` under the
/// app root).
pub(super) fn about<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = ctx.no_query().and_then(|()| admin(ctx)) {
            return Outcome::forward(why);
        }
        let app_data = ctx.state.env.config_dir.to_string_lossy();
        let (media, requests) = match ctx.state.db.media_and_request_counts().await {
            Ok(counts) => counts,
            Err(e) => return Outcome::forward(format!("counting rows failed: {e:#}")),
        };
        let mut out = Map::new();
        out.insert(
            String::from("version"),
            Value::from(ctx.state.version.version.as_str()),
        );
        out.insert(String::from("totalMediaItems"), Value::from(media));
        out.insert(String::from("totalRequests"), Value::from(requests));
        if let Ok(tz) = std::env::var("TZ") {
            out.insert(String::from("tz"), Value::from(tz));
        }
        out.insert(String::from("appDataPath"), Value::from(app_data.as_ref()));
        ctx.json(&Value::Object(out))
    })
}
