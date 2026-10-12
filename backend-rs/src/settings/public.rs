//! `fullPublicSettings` from `server/lib/settings/index.ts`.

use serde_json::{Map, Value};

use super::Settings;

/// Rating badge defaults (`DEFAULT_RATING_BADGE_SETTINGS`).
const RATING_BADGE_DEFAULTS: [(&str, bool); 12] = [
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

/// JavaScript truthiness.
#[must_use]
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `x?.trim()` truthiness: a non-blank string.
fn non_blank(v: Option<&Value>) -> bool {
    v.and_then(Value::as_str)
        .is_some_and(|s| !s.trim().is_empty())
}

/// `value !== false`.
const fn not_false(v: Option<&Value>) -> bool {
    !matches!(v, Some(Value::Bool(false)))
}

/// `value ?? fallback` for JSON values.
fn or_default(v: Option<&Value>, fallback: Value) -> Value {
    match v {
        None | Some(Value::Null) => fallback,
        Some(x) => x.clone(),
    }
}

/// The default server (non-4k or 4k) of a servarr list.
fn default_server<'a>(settings: &'a Settings, list: &str, four_k: bool) -> Option<&'a Value> {
    settings
        .get(list)?
        .as_array()?
        .iter()
        .find(|s| truthy(s.get("is4k")) == four_k && truthy(s.get("isDefault")))
}

fn has_default_4k(settings: &Settings, list: &str) -> bool {
    settings
        .get(list)
        .and_then(Value::as_array)
        .is_some_and(|servers| {
            servers
                .iter()
                .any(|s| truthy(s.get("is4k")) && truthy(s.get("isDefault")))
        })
}

fn instant_requests(settings: &Settings, list: &str, four_k: bool) -> bool {
    default_server(settings, list, four_k)
        .is_some_and(|s| not_false(s.get("enableInstantRequests")))
}

/// Everything the frontend may read without logging in.
#[must_use]
pub fn full_public_settings(settings: &Settings, plugin_mode: bool) -> Map<String, Value> {
    let mut out = settings
        .get("/public")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for (k, v) in main_fields(settings)
        .into_iter()
        .chain(integration_fields(settings, plugin_mode))
    {
        out.insert(k.to_owned(), v);
    }
    out
}

/// The `main` settings and the servarr-derived flags, in Node's order.
fn main_fields(settings: &Settings) -> Vec<(&'static str, Value)> {
    let field = |p: &str| settings.get(p).cloned().unwrap_or(Value::Null);
    let tvdb_metadata = settings.str("/metadataSettings/tv") == "tvdb";
    vec![
        ("applicationTitle", field("/main/applicationTitle")),
        ("applicationUrl", field("/main/applicationUrl")),
        ("hideAvailable", field("/main/hideAvailable")),
        ("hideBlocklisted", field("/main/hideBlocklisted")),
        ("hideRequested", field("/main/hideRequested")),
        ("localLogin", field("/main/localLogin")),
        ("mediaServerLogin", field("/main/mediaServerLogin")),
        ("jellyfinExternalHost", field("/jellyfin/externalHostname")),
        (
            "jellyfinForgotPasswordUrl",
            field("/jellyfin/jellyfinForgotPasswordUrl"),
        ),
        (
            "movie4kEnabled",
            Value::Bool(has_default_4k(settings, "/radarr")),
        ),
        (
            "series4kEnabled",
            Value::Bool(has_default_4k(settings, "/sonarr")),
        ),
        (
            "movieInstantRequestEnabled",
            Value::Bool(instant_requests(settings, "/radarr", false)),
        ),
        (
            "movie4kInstantRequestEnabled",
            Value::Bool(instant_requests(settings, "/radarr", true)),
        ),
        (
            "seriesInstantRequestEnabled",
            Value::Bool(instant_requests(settings, "/sonarr", false)),
        ),
        (
            "series4kInstantRequestEnabled",
            Value::Bool(instant_requests(settings, "/sonarr", true)),
        ),
        ("discoverRegion", field("/main/discoverRegion")),
        ("streamingRegion", field("/main/streamingRegion")),
        ("originalLanguage", field("/main/originalLanguage")),
        ("mediaServerType", field("/main/mediaServerType")),
        (
            "partialRequestsEnabled",
            field("/main/partialRequestsEnabled"),
        ),
        (
            "episodeRequestsEnabled",
            // `a && b` yields `a` when it is falsy.
            if truthy(settings.get("/main/partialRequestsEnabled")) {
                Value::Bool(tvdb_metadata)
            } else {
                field("/main/partialRequestsEnabled")
            },
        ),
        (
            "enableSpecialEpisodes",
            field("/main/enableSpecialEpisodes"),
        ),
        ("cacheImages", field("/main/cacheImages")),
        ("vapidPublic", field("/vapidPublic")),
        (
            "enablePushRegistration",
            field("/notifications/agents/webpush/enabled"),
        ),
        ("locale", field("/main/locale")),
        ("emailEnabled", field("/notifications/agents/email/enabled")),
        (
            "userEmailRequired",
            field("/notifications/agents/email/options/userEmailRequired"),
        ),
        ("newPlexLogin", field("/main/newPlexLogin")),
        ("youtubeUrl", field("/main/youtubeUrl")),
        ("versionCheck", field("/main/versionCheck")),
        ("plexClientIdentifier", field("/clientId")),
    ]
}

/// Which integrations are configured, in Node's order.
fn integration_fields(settings: &Settings, plugin_mode: bool) -> Vec<(&'static str, Value)> {
    let trakt_configured = if settings.str("/trakt/provider") == "jellyfin" {
        truthy(settings.get("/jellyfin/ip"))
    } else {
        truthy(settings.get("/trakt/clientId")) && truthy(settings.get("/trakt/clientSecret"))
    };
    let provider_enabled = |name: &str| {
        Value::Bool(not_false(
            settings.get(&format!("/mediaActions/providers/{name}")),
        ))
    };
    vec![
        ("traktConfigured", Value::Bool(trakt_configured)),
        (
            "anilistConfigured",
            Value::Bool(
                truthy(settings.get("/anilist/clientId"))
                    && truthy(settings.get("/anilist/clientSecret")),
            ),
        ),
        (
            "simklConfigured",
            Value::Bool(non_blank(settings.get("/simkl/clientId"))),
        ),
        ("mediaActionsTraktEnabled", provider_enabled("trakt")),
        ("mediaActionsJellyfinEnabled", provider_enabled("jellyfin")),
        ("mediaActionsAnilistEnabled", provider_enabled("anilist")),
        ("mediaActionsSimklEnabled", provider_enabled("simkl")),
        (
            "mdblistConfigured",
            Value::Bool(non_blank(settings.get("/mdblist/apiKey"))),
        ),
        ("pluginMode", Value::Bool(plugin_mode)),
        ("ratingBadges", Value::Object(rating_badges(settings))),
    ]
}

fn rating_badges(settings: &Settings) -> Map<String, Value> {
    RATING_BADGE_DEFAULTS
        .iter()
        .map(|(key, default)| {
            let v = or_default(
                settings.get(&format!("/mdblist/{key}")),
                Value::Bool(*default),
            );
            ((*key).to_owned(), v)
        })
        .collect()
}
