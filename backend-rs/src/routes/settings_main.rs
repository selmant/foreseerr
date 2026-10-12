//! Main, metadata, Tautulli, Servarr cleanup and discover slider writes.
//!
//! From `server/routes/settings/index.ts`, `metadata.ts` and
//! `discover.ts`: main settings, the API key, setup, metadata providers,
//! Tautulli, Servarr cleanup and the discover sliders. Every route here
//! sits behind `isAuthenticated(Permission.ADMIN)`.

use std::future::Future;
use std::pin::Pin;

use axum::http::Method;
use base64::prelude::*;
use serde_json::{json, Map, Value};

use super::settings_util::{
    assign_merged, body_undefined, conforms, js_integer, json_body, no_body, node_memory, Ty,
};
use super::settingswrite::lodash_merge;
use super::{Outcome, Ready, Table, ADMIN};
use crate::db::Bind;
use crate::settings::public::truthy;
use crate::tmdb::{axios_encode, js_numbers};

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/settings/main", Method::POST, main),
    ("/api/v1/settings/main/regenerate", Method::POST, regenerate),
    ("/api/v1/settings/initialize", Method::POST, initialize),
    ("/api/v1/settings/metadatas", Method::PUT, metadata),
    (
        "/api/v1/settings/metadatas/test",
        Method::POST,
        metadata_test,
    ),
    ("/api/v1/settings/tautulli", Method::POST, tautulli),
    (
        "/api/v1/settings/servarr-interventions",
        Method::POST,
        servarr_interventions,
    ),
    ("/api/v1/settings/discover", Method::POST, discover),
    (
        "/api/v1/settings/discover/reset",
        Method::GET,
        discover_reset,
    ),
];

macro_rules! try_forward {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(why) => return Outcome::forward(why),
        }
    };
}

/// `no_query` and the admin check.
fn admin(ctx: &Ready<'_>) -> Result<(), super::Fallback> {
    ctx.no_query()?;
    ctx.authenticated(ADMIN).map(|_| ())
}

/// Save, or hand the request on when nothing could be written.
macro_rules! save_or_forward {
    ($ctx:expr, $data:expr) => {
        if let Err(e) = $ctx.save_settings(&$data).await {
            return Outcome::forward(format!("saving settings failed: {e:#}"));
        }
    };
}

/// `MainSettings` in the spec.
const MAIN_SCHEMA: &[(&str, Ty)] = &[
    ("apiKey", Ty::ReadOnly),
    ("appLanguage", Ty::Str),
    ("applicationTitle", Ty::Str),
    ("applicationUrl", Ty::Str),
    ("hideAvailable", Ty::Bool),
    ("hideRequested", Ty::Bool),
    ("partialRequestsEnabled", Ty::Bool),
    ("episodeRequestsEnabled", Ty::Bool),
    ("localLogin", Ty::Bool),
    ("mediaServerType", Ty::Num),
    ("newPlexLogin", Ty::Bool),
    ("defaultPermissions", Ty::Num),
    ("enableSpecialEpisodes", Ty::Bool),
    ("versionCheck", Ty::Bool),
    ("cacheImages", Ty::Bool),
    ("imageCacheIdleDays", Ty::IntRange(1, 90)),
];

/// `clampImageCacheIdleDays` for what JSON can hold; strings and objects
/// go through `Number()`, which isn't reproduced.
fn clamp_idle_days(value: &Value) -> Option<i64> {
    match value {
        Value::Null | Value::Bool(_) => Some(1),
        Value::Number(n) => {
            let rounded = n.as_i64().or_else(|| {
                n.as_f64()
                    .map(|f| (f + 0.5).floor())
                    .filter(|f| f.abs() < 1e15)
                    .and_then(|f| format!("{f:.0}").parse().ok())
            })?;
            Some(rounded.clamp(1, 90))
        }
        Value::String(_) | Value::Array(_) | Value::Object(_) => None,
    }
}

/// Whether lodash `merge` of `body` into `current` is what
/// [`lodash_merge`] does: it isn't when an object meets an array (lodash
/// writes the keys onto the array).
fn merges_plainly(current: &Value, body: &Value) -> bool {
    match (current, body) {
        (Value::Object(c), Value::Object(b)) => b
            .iter()
            .all(|(k, v)| c.get(k).is_none_or(|cv| merges_plainly(cv, v))),
        (Value::Array(c), Value::Array(b)) => c.iter().zip(b).all(|(cv, v)| merges_plainly(cv, v)),
        (Value::Array(_), Value::Object(_)) => false,
        _ => true,
    }
}

/// `POST /settings/main`: lodash `merge` into `main`, then the setter's
/// clamp of `imageCacheIdleDays`.
fn main<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(admin(ctx));
        // `merge(settings.main, undefined)` changes nothing.
        let empty = Value::Object(Map::new());
        let body = if body_undefined(ctx) {
            &empty
        } else {
            try_forward!(json_body(ctx))
        };
        if !conforms(body, MAIN_SCHEMA, &[]) {
            return Outcome::forward(String::from("a body the validator may reject"));
        }
        let body = js_numbers(body.clone());
        let mut data = node_memory(ctx);
        let Some(main) = data.get_mut("main") else {
            return Outcome::forward(String::from("no main settings"));
        };
        if !merges_plainly(main, &body) {
            return Outcome::forward(String::from("lodash would merge an object into an array"));
        }
        lodash_merge(main, &body);
        if let Some(days) = main.get_mut("imageCacheIdleDays") {
            let Some(clamped) = clamp_idle_days(days) else {
                return Outcome::forward(String::from("imageCacheIdleDays needs Number()"));
            };
            *days = Value::from(clamped);
        }
        let mut main = main.clone();
        save_or_forward!(ctx, data);
        crate::runtime::desktop::effective_main(&mut main);
        ctx.json(&main)
    })
}

/// `crypto.randomUUID()`.
fn uuid_v4() -> String {
    let mut bytes: [u8; 16] = rand::random();
    if let Some(b) = bytes.get_mut(6) {
        *b = (*b & 0x0f) | 0x40;
    }
    if let Some(b) = bytes.get_mut(8) {
        *b = (*b & 0x3f) | 0x80;
    }
    let mut out = String::with_capacity(36);
    for (i, b) in bytes.iter().enumerate() {
        if matches!(i, 4 | 6 | 8 | 10) {
            out.push('-');
        }
        out.push(char::from_digit(u32::from(b >> 4), 16).unwrap_or('0'));
        out.push(char::from_digit(u32::from(b & 0xf), 16).unwrap_or('0'));
    }
    out
}

/// `generateApiKey`: `API_KEY` when set, else
/// `base64(Date.now() + randomUUID())`.
fn generate_api_key() -> String {
    match std::env::var("API_KEY") {
        Ok(key) if !key.is_empty() => key,
        _ => {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_millis());
            BASE64_STANDARD.encode(format!("{now}{}", uuid_v4()))
        }
    }
}

/// `POST /settings/main/regenerate`: a new API key, saved; Node is told
/// with the old key it still holds.
fn regenerate<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(admin(ctx));
        try_forward!(no_body(ctx));
        let mut data = node_memory(ctx);
        let Some(main) = data.get_mut("main").and_then(Value::as_object_mut) else {
            return Outcome::forward(String::from("main is not an object"));
        };
        main.insert(String::from("apiKey"), Value::from(generate_api_key()));
        let main = Value::Object(main.clone());
        save_or_forward!(ctx, data);
        ctx.json(&main)
    })
}

/// `POST /settings/initialize`: `public.initialized = true`.
fn initialize<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(admin(ctx));
        try_forward!(no_body(ctx));
        let mut data = node_memory(ctx);
        let Some(public) = data.get_mut("public").and_then(Value::as_object_mut) else {
            return Outcome::forward(String::from("public is not an object"));
        };
        public.insert(String::from("initialized"), Value::Bool(true));
        let public = Value::Object(public.clone());
        save_or_forward!(ctx, data);
        ctx.json(&public)
    })
}

/// `getTestResultString`.
const fn test_result(value: i8) -> &'static str {
    match value {
        -1 => "not tested",
        0 => "failed",
        _ => "ok",
    }
}

/// The TVDB check both metadata routes run: `Tvdb.getInstance()` (its
/// first login), then `test()`, another login.
async fn tvdb_works(ctx: &Ready<'_>) -> bool {
    let client = &ctx.state.outbound;
    let tested = match crate::tvdb::ensure_instance(client).await {
        Ok(()) => crate::tvdb::test(client).await,
        Err(e) => Err(e),
    };
    match tested {
        Ok(()) => true,
        Err(e) => {
            tracing::error!("Failed to test metadata provider: {e:#}");
            false
        }
    }
}

/// The TMDB check both metadata routes run: show 1054 in the server
/// locale.
async fn tmdb_works(ctx: &Ready<'_>) -> bool {
    let locale = match ctx.settings.str("/main/locale") {
        "" => "en",
        other => other,
    };
    match ctx.state.tmdb.tv(1054, locale).await {
        Ok(_) => true,
        Err(e) => {
            tracing::error!("Failed to test metadata provider: {e:#}");
            false
        }
    }
}

/// `PUT /settings/metadatas`: test the providers chosen, then save.
fn metadata<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(admin(ctx));
        if body_undefined(ctx) {
            return ctx.error(500, "The request body is missing.");
        }
        let body = try_forward!(json_body(ctx));
        let Some(object) = body.as_object() else {
            return Outcome::forward(String::from("a body that isn't an object"));
        };
        // Only `tv` and `anime` are read; anything else the validator let
        // through is ignored.
        let tv = object.get("tv");
        let anime = object.get("anime");
        if [tv, anime].iter().flatten().any(|v| !v.is_string()) {
            return Outcome::forward(String::from("a provider that isn't a string"));
        }
        let is = |v: Option<&Value>, name: &str| v.and_then(Value::as_str) == Some(name);
        let tvdb_test: i8 = if is(tv, "tvdb") || is(anime, "tvdb") {
            i8::from(tvdb_works(ctx).await)
        } else {
            -1
        };
        let tmdb: i8 = if is(tv, "tmdb") || is(anime, "tmdb") {
            i8::from(tmdb_works(ctx).await)
        } else {
            -1
        };
        let tests = json!({ "tvdb": test_result(tvdb_test), "tmdb": test_result(tmdb) });
        if tvdb_test == 0 || tmdb == 0 {
            return ctx.json_with(500, &json!({ "success": false, "tests": tests }));
        }
        let mut incoming = Map::new();
        let mut out = Map::new();
        out.insert(String::from("success"), Value::Bool(true));
        for (key, value) in [("tv", tv), ("anime", anime)] {
            if let Some(value) = value {
                incoming.insert(String::from(key), value.clone());
                out.insert(String::from(key), value.clone());
            }
        }
        out.insert(String::from("tests"), tests);
        let mut data = node_memory(ctx);
        assign_merged(&mut data, "metadataSettings", Value::Object(incoming));
        save_or_forward!(ctx, data);
        ctx.json(&Value::Object(out))
    })
}

/// `POST /settings/metadatas/test`.
fn metadata_test<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(admin(ctx));
        if body_undefined(ctx) {
            // Each test's TypeError is caught and logged: nothing tested.
            return ctx.json(&json!({
                "success": true,
                "tests": { "tmdb": test_result(-1), "tvdb": test_result(-1) },
            }));
        }
        let body = try_forward!(json_body(ctx));
        if !conforms(body, &[("tmdb", Ty::Bool), ("tvdb", Ty::Bool)], &[]) {
            return Outcome::forward(String::from("a body the validator may reject"));
        }
        let tmdb: i8 = if truthy(body.get("tmdb")) {
            i8::from(tmdb_works(ctx).await)
        } else {
            -1
        };
        let tvdb_test: i8 = if truthy(body.get("tvdb")) {
            i8::from(tvdb_works(ctx).await)
        } else {
            -1
        };
        let success = tvdb_test != 0 && tmdb != 0;
        let out = json!({
            "success": success,
            "tests": { "tmdb": test_result(tmdb), "tvdb": test_result(tvdb_test) },
        });
        ctx.json_with(if success { 200 } else { 500 }, &out)
    })
}

/// `TautulliSettings` in the spec.
const TAUTULLI_SCHEMA: &[(&str, Ty)] = &[
    ("hostname", Ty::NullStr),
    ("port", Ty::NullNum),
    ("useSsl", Ty::NullBool),
    ("apiKey", Ty::NullStr),
    ("externalUrl", Ty::NullStr),
];

/// `semver.gte(semver.coerce(version), '2.9.0')`, or `None` where the
/// coercion isn't reproduced (or yields nothing, which).
fn tautulli_supported(version: &str) -> Option<bool> {
    let bytes = version.as_bytes();
    let start = bytes.iter().position(u8::is_ascii_digit)?;
    let rest = version.get(start..)?;
    let mut parts = [0_u64; 3];
    let mut chars = rest.chars().peekable();
    for (i, part) in parts.iter_mut().enumerate() {
        if i > 0 {
            let mut probe = chars.clone();
            if probe.next() != Some('.') || !probe.peek().is_some_and(char::is_ascii_digit) {
                break;
            }
            chars.next();
        }
        let mut digits = String::new();
        while let Some(c) = chars.peek().filter(|c| c.is_ascii_digit()) {
            digits.push(*c);
            chars.next();
        }
        if digits.len() > 16 {
            return None;
        }
        *part = digits.parse().ok()?;
    }
    Some(parts >= [2, 9, 0])
}

/// Whether `http://${hostname}:${port}` can't be a URL because of the port
/// alone: a plain host name followed by `undefined`, `null`, a fraction or
/// a number outside 0-65535.
fn port_breaks_url(t: &Map<String, Value>) -> bool {
    let plain_host = t.get("hostname").and_then(Value::as_str).is_some_and(|h| {
        !h.is_empty()
            && h.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
    });
    let bad_port = match t.get("port") {
        None | Some(Value::Null) => true,
        Some(Value::Number(n)) => n.as_u64().is_none_or(|p| p > 65535),
        Some(_) => false,
    };
    plain_host && bad_port
}

/// axios's `combineURLs(baseURL, '/api/v2')`.
fn tautulli_url(t: &Map<String, Value>) -> Option<String> {
    let scheme = if truthy(t.get("useSsl")) {
        "https"
    } else {
        "http"
    };
    let hostname = t.get("hostname")?.as_str()?;
    let port = match t.get("port") {
        Some(Value::Number(n)) if n.as_i64().is_some() => n.to_string(),
        _ => return None,
    };
    let url_base = match t.get("urlBase") {
        None | Some(Value::Null) => "",
        Some(Value::String(s)) => s.as_str(),
        Some(_) => return None,
    };
    let base = format!("{scheme}://{hostname}:{port}{url_base}");
    let base = base
        .strip_suffix('/')
        .map_or(base.as_str(), |b| b.strip_suffix('/').unwrap_or(b));
    let mut url = format!("{base}/api/v2?");
    match t.get("apiKey") {
        None | Some(Value::Null) => {}
        Some(Value::String(key)) => {
            url.push_str("apikey=");
            url.push_str(&axios_encode(key));
            url.push('&');
        }
        Some(_) => return None,
    }
    url.push_str("cmd=get_tautulli_info");
    Some(url)
}

/// `TautulliAPI.getInfo()` and the version check: whether it passed.
async fn tautulli_check(ctx: &Ready<'_>, url: &str) -> bool {
    let response = match ctx
        .state
        .outbound
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json, text/plain, */*")
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
    {
        Ok(response) => response,
        Err(e) => {
            tracing::debug!("Tautulli check failed: {e:#}");
            return false;
        }
    };
    let Ok(body) = response.json::<Value>().await else {
        return false;
    };
    body.pointer("/response/data/tautulli_version")
        .and_then(Value::as_str)
        .and_then(tautulli_supported)
        == Some(true)
}

/// `POST /settings/tautulli`. Node assigns the body into its in-memory
/// settings before checking the connection and keeps it there unsaved
/// when there is no hostname or the check fails (in proxy mode only Node
/// has that memory, so those cases go to Node and the check runs again).
fn tautulli<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(admin(ctx));
        // `Object.assign(settings.tautulli, undefined)` changes nothing.
        let empty = Value::Object(Map::new());
        let body = if body_undefined(ctx) {
            &empty
        } else {
            try_forward!(json_body(ctx))
        };
        if !conforms(body, TAUTULLI_SCHEMA, &[]) {
            return Outcome::forward(String::from("a body the validator may reject"));
        }
        let Value::Object(body) = js_numbers(body.clone()) else {
            return Outcome::forward(String::from("a body that isn't an object"));
        };
        let mut data = node_memory(ctx);
        let Some(current) = data.get_mut("tautulli").and_then(Value::as_object_mut) else {
            return Outcome::forward(String::from("tautulli is not an object"));
        };
        let before = current.clone();
        for (k, v) in body {
            current.insert(k, v);
        }
        // Node's in-memory copy only differs from the file when the body
        // changed something.
        let unchanged = *current == before;
        // `Object.assign(settings.tautulli, req.body)` lands in Node's
        // shared settings before anything else; requests in between see it.
        if !unchanged && crate::standalone::enabled() {
            let base = node_memory(ctx);
            let assigned =
                crate::settings::delta::with_key(&base, "tautulli", Value::Object(current.clone()));
            if let Err(e) = ctx.state.settings.keep_unsaved_from(&base, &assigned).await {
                return Outcome::forward(format!("reading the settings failed: {e:#}"));
            }
        }
        if !truthy(current.get("hostname")) {
            let answer = Value::Object(current.clone());
            if !unchanged && !crate::standalone::enabled() {
                return Outcome::forward(String::from("the application URL has no hostname"));
            }
            return ctx.json(&answer);
        }
        let url = match tautulli_url(current) {
            Some(url) => Some(url),
            // `new URL` throws on the port, so axios never sends anything.
            None if port_breaks_url(current) => None,
            None => {
                return Outcome::forward(String::from("a Tautulli URL axios would build oddly"));
            }
        };
        let current = Value::Object(current.clone());
        let passed = match url {
            Some(url) => tautulli_check(ctx, &url).await,
            None => false,
        };
        if !passed {
            if !unchanged && !crate::standalone::enabled() {
                return Outcome::forward(String::from("the Tautulli connection test failed"));
            }
            return ctx.error(500, "Unable to connect to Tautulli.");
        }
        save_or_forward!(ctx, data);
        ctx.json(&current)
    })
}

/// `POST /settings/servarr-interventions`. The spec and the handler check
/// the same things; anything they'd refuse is Node's to word.
fn servarr_interventions<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(admin(ctx));
        let body = try_forward!(json_body(ctx));
        let schema = [
            ("automaticCleanupEnabled", Ty::Bool),
            ("cleanupGraceHours", Ty::IntRange(1, 720)),
        ];
        // Once the validator passed the body, the handler's own check
        // decides.
        let validated = ctx.validated().is_some();
        if !validated
            && !conforms(
                body,
                &schema,
                &["automaticCleanupEnabled", "cleanupGraceHours"],
            )
        {
            return Outcome::forward(String::from("a body the validator rejects"));
        }
        let (Some(enabled), Some(hours)) = (
            body.get("automaticCleanupEnabled").and_then(Value::as_bool),
            body.get("cleanupGraceHours")
                .and_then(js_integer)
                .filter(|h| (1..=720).contains(h)),
        ) else {
            if validated {
                return ctx.error(
                    400,
                    "automaticCleanupEnabled must be boolean and cleanupGraceHours must be an integer from 1 to 720.",
                );
            }
            return Outcome::forward(String::from("a body the validator rejects"));
        };
        let mut data = node_memory(ctx);
        assign_merged(
            &mut data,
            "servarrInterventions",
            json!({ "automaticCleanupEnabled": enabled, "cleanupGraceHours": hours }),
        );
        let saved = data
            .get("servarrInterventions")
            .cloned()
            .unwrap_or(Value::Null);
        save_or_forward!(ctx, data);
        ctx.json(&saved)
    })
}

/// One slider of the batch, checked against the spec before anything is
/// written.
/// `sort`: missing (`TypeORM` leaves the column alone) or a value.
enum Sort {
    Missing,
    Set(Option<String>),
}

struct SliderIn {
    id: Option<i64>,
    kind: i64,
    enabled: bool,
    title: Option<String>,
    data: Option<String>,
    /// What to do with `sort`.
    sort: Sort,
}

fn nullable_text(v: Option<&Value>) -> Result<Option<String>, ()> {
    match v {
        Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        _ => Err(()),
    }
}

/// An int4 column value.
fn int4(v: &Value) -> Option<i64> {
    js_integer(v).filter(|i| i32::try_from(*i).is_ok())
}

fn slider_in(v: &Value) -> Option<SliderIn> {
    let schema = [
        ("id", Ty::Num),
        ("type", Ty::Num),
        ("isBuiltIn", Ty::Bool),
        ("enabled", Ty::Bool),
        ("endpoint", Ty::Str),
        ("defaultTitle", Ty::Str),
    ];
    if !conforms(v, &schema, &["type", "enabled", "title", "data"]) {
        return None;
    }
    let id = match v.get("id") {
        None => None,
        Some(id) => Some(int4(id)?),
    };
    Some(SliderIn {
        id,
        kind: int4(v.get("type")?)?,
        enabled: v.get("enabled")?.as_bool()?,
        title: nullable_text(v.get("title")).ok()?,
        data: nullable_text(v.get("data")).ok()?,
        sort: match v.get("sort") {
            None => Sort::Missing,
            other => Sort::Set(nullable_text(other).ok()?),
        },
    })
}

fn text_bind(v: Option<&String>) -> Bind {
    Bind::OptText(v.cloned())
}

/// `sliderRepository.save(existing)` after the batch handler's changes:
/// only changed columns, `updatedAt` bumped when anything changed.
async fn slider_save(ctx: &Ready<'_>, s: &SliderIn, order: i64) -> anyhow::Result<()> {
    let existing = match s.id.filter(|id| *id != 0) {
        Some(id) => ctx.state.db.discover_slider(id).await?,
        None => None,
    };
    let Some(row) = existing else {
        ctx.state
            .db
            .execute(
                r#"INSERT INTO "discover_slider" ("isBuiltIn", "data", "sort", "title", "enabled", "order", "type") VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"#,
                &[
                    Bind::Bool(false),
                    text_bind(s.data.as_ref()),
                    text_bind(match &s.sort {
                        Sort::Set(sort) => sort.as_ref(),
                        Sort::Missing => None,
                    }),
                    text_bind(s.title.as_ref()),
                    Bind::Bool(s.enabled),
                    Bind::Int(order),
                    Bind::Int(s.kind),
                ],
            )
            .await?;
        return Ok(());
    };
    let mut sets: Vec<&str> = Vec::new();
    let mut binds: Vec<Bind> = Vec::new();
    if row.enabled != s.enabled {
        sets.push("enabled");
        binds.push(Bind::Bool(s.enabled));
    }
    if row.order != order {
        sets.push("order");
        binds.push(Bind::Int(order));
    }
    if !row.is_built_in {
        if row.title != s.title {
            sets.push("title");
            binds.push(text_bind(s.title.as_ref()));
        }
        if row.data != s.data {
            sets.push("data");
            binds.push(text_bind(s.data.as_ref()));
        }
        if let Sort::Set(sort) = &s.sort {
            if row.sort != *sort {
                sets.push("sort");
                binds.push(text_bind(sort.as_ref()));
            }
        }
        if row.slider_type != s.kind {
            sets.push("type");
            binds.push(Bind::Int(s.kind));
        }
    }
    if sets.is_empty() {
        return Ok(());
    }
    let assignments: Vec<String> = sets
        .iter()
        .enumerate()
        .map(|(i, col)| format!(r#""{col}" = ?{}"#, i + 1))
        .collect();
    binds.push(Bind::Int(row.id));
    let sql = format!(
        r#"UPDATE "discover_slider" SET {}, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?{}"#,
        assignments.join(", "),
        binds.len()
    );
    ctx.state.db.execute(&sql, &binds).await?;
    Ok(())
}

/// `POST /settings/discover`: every slider saved in turn (existing ones
/// updated, the rest created at their position); the body comes back.
fn discover<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(admin(ctx));
        if body_undefined(ctx) {
            return ctx.error(400, "Invalid request body.");
        }
        let body = try_forward!(json_body(ctx));
        let Some(items) = body.as_array() else {
            return Outcome::forward(String::from("a body that isn't an array"));
        };
        let Some(sliders) = items.iter().map(slider_in).collect::<Option<Vec<_>>>() else {
            return Outcome::forward(String::from("a slider the validator may reject"));
        };
        for (x, slider) in sliders.iter().enumerate() {
            let order = i64::try_from(x).unwrap_or(i64::MAX);
            if let Err(e) = slider_save(ctx, slider, order).await {
                if x == 0 {
                    return Outcome::forward(format!("saving a slider failed: {e:#}"));
                }
                tracing::error!("saving discover slider {x} failed: {e:#}");
                return ctx.error(500, &format!("{e:#}"));
            }
        }
        ctx.json(&js_numbers(body.clone()))
    })
}

/// `defaultSliders`: type and order of each built-in slider.
const DEFAULT_SLIDERS: [(i64, i64); 29] = [
    (1, 0),
    (2, 1),
    (3, 2),
    (4, 3),
    (5, 4),
    (6, 5),
    (7, 6),
    (8, 7),
    (9, 8),
    (10, 9),
    (11, 10),
    (12, 11),
    (1001, 12),
    (1002, 13),
    (1004, 14),
    (1005, 15),
    (1006, 16),
    (1011, 17),
    (1012, 18),
    (1013, 19),
    (1007, 20),
    (1008, 21),
    (1009, 22),
    (1015, 23),
    (1016, 24),
    (1023, 25),
    (1024, 26),
    (1025, 27),
    (1026, 28),
];

/// `clear()` then `DiscoverSlider.bootstrapSliders()`.
async fn reset_sliders(ctx: &Ready<'_>) -> anyhow::Result<()> {
    let db = &ctx.state.db;
    let clear = if db.is_postgres() {
        r#"TRUNCATE TABLE "discover_slider""#
    } else {
        r#"DELETE FROM "discover_slider""#
    };
    db.execute(clear, &[]).await?;
    bootstrap_sliders(db).await
}

/// `DiscoverSlider.bootstrapSliders()`, also run at startup.
///
/// # Errors
///
/// Fails when a query does.
pub(crate) async fn bootstrap_sliders(db: &crate::db::Db) -> anyhow::Result<()> {
    db.execute(
        r#"UPDATE "discover_slider" SET "type" = "type" + 979 WHERE "type" >= 22 AND "type" < 1001"#,
        &[],
    )
    .await?;
    db.execute(
        r#"DELETE FROM "discover_slider" WHERE "type" IN (?1, ?2, ?3, ?4, ?5, ?6)"#,
        &(1017..=1022).map(Bind::Int).collect::<Vec<_>>(),
    )
    .await?;
    for (kind, order) in DEFAULT_SLIDERS {
        let existing = db
            .scalar(
                r#"SELECT COUNT(*) FROM "discover_slider" WHERE "type" = ?1 AND "isBuiltIn" = ?2"#,
                &[Bind::Int(kind), Bind::Bool(true)],
            )
            .await?;
        if existing == 0 {
            tracing::info!("Creating built-in discovery slider: type {kind}, order {order}");
            db.execute(
                r#"INSERT INTO "discover_slider" ("type", "order", "isBuiltIn", "enabled") VALUES (?1, ?2, ?3, ?4)"#,
                &[
                    Bind::Int(kind),
                    Bind::Int(order),
                    Bind::Bool(true),
                    Bind::Bool(true),
                ],
            )
            .await?;
        }
    }
    Ok(())
}

/// `GET /settings/discover/reset`.
fn discover_reset<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(admin(ctx));
        if let Err(e) = reset_sliders(ctx).await {
            tracing::error!("resetting discover sliders failed: {e:#}");
            return ctx.error(500, &format!("{e:#}"));
        }
        Ready::no_content()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coerces_versions_like_semver() {
        assert_eq!(tautulli_supported("v2.13.4"), Some(true), "prefixed");
        assert_eq!(tautulli_supported("2.9"), Some(true), "two parts");
        assert_eq!(tautulli_supported("2.8.9-beta"), Some(false), "older");
        assert_eq!(tautulli_supported("3"), Some(true), "major only");
        assert_eq!(tautulli_supported("beta"), None, "no digits");
    }

    #[test]
    fn builds_tautulli_urls() {
        let t = json!({"hostname": "t.local", "port": 8181, "useSsl": true, "urlBase": "/tau/", "apiKey": "a b"});
        assert_eq!(
            t.as_object().and_then(tautulli_url).as_deref(),
            Some("https://t.local:8181/tau/api/v2?apikey=a+b&cmd=get_tautulli_info"),
            "url"
        );
        let no_port = json!({"hostname": "t.local"});
        assert_eq!(no_port.as_object().and_then(tautulli_url), None, "no port");
    }

    #[test]
    fn clamps_idle_days() {
        assert_eq!(clamp_idle_days(&json!(7)), Some(7), "in range");
        assert_eq!(clamp_idle_days(&json!(200)), Some(90), "max");
        assert_eq!(clamp_idle_days(&json!(2.5)), Some(3), "rounds half up");
        assert_eq!(clamp_idle_days(&Value::Null), Some(1), "null");
        assert_eq!(clamp_idle_days(&json!("7")), None, "string");
    }

    #[test]
    fn makes_uuids() {
        let id = uuid_v4();
        assert_eq!(id.len(), 36, "length");
        assert_eq!(id.chars().nth(14), Some('4'), "version");
    }

    #[test]
    fn reads_sliders() {
        let s =
            slider_in(&json!({"id": 3, "type": 1, "enabled": true, "title": null, "data": "x"}));
        assert!(
            s.as_ref()
                .is_some_and(|s| s.id == Some(3) && matches!(s.sort, Sort::Missing)),
            "ok"
        );
        assert!(
            slider_in(&json!({"type": 1, "enabled": true, "data": "x"})).is_none(),
            "title required"
        );
        assert!(
            slider_in(&json!({"type": 1.5, "enabled": true, "title": "t", "data": "x"})).is_none(),
            "integer type"
        );
    }
}
