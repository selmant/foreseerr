//! `/settings/radarr` and `/settings/sonarr` writes and tests
//! (`server/routes/settings/radarr.ts`, `sonarr.ts`).

use axum::http::Method;
use serde_json::{Map, Value};

use super::nodestate::{
    admin, fits, js_key_order, js_strict_eq, json_safe, mutate, nullable, object_body, opt, req,
    Field, NativeFut, Ty,
};
use super::{Outcome, Ready, Table};
use crate::servarr::api_timeout;
use crate::settings::public::truthy;

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/settings/radarr", Method::POST, radarr_create),
    ("/api/v1/settings/radarr/test", Method::POST, radarr_test),
    ("/api/v1/settings/radarr/{id}", Method::PUT, radarr_update),
    (
        "/api/v1/settings/radarr/{id}",
        Method::DELETE,
        radarr_delete,
    ),
    (
        "/api/v1/settings/radarr/{id}/profiles",
        Method::GET,
        radarr_profiles,
    ),
    ("/api/v1/settings/sonarr", Method::POST, sonarr_create),
    ("/api/v1/settings/sonarr/test", Method::POST, sonarr_test),
    ("/api/v1/settings/sonarr/{id}", Method::PUT, sonarr_update),
    (
        "/api/v1/settings/sonarr/{id}",
        Method::DELETE,
        sonarr_delete,
    ),
];

/// `RadarrSettings` in the spec.
const RADARR_FIELDS: [Field; 16] = [
    req("name", Ty::Str),
    req("hostname", Ty::Str),
    req("port", Ty::Num),
    req("apiKey", Ty::Str),
    req("useSsl", Ty::Bool),
    opt("baseUrl", Ty::Str),
    req("activeProfileId", Ty::Num),
    req("activeProfileName", Ty::Str),
    req("activeDirectory", Ty::Str),
    req("is4k", Ty::Bool),
    req("minimumAvailability", Ty::Str),
    req("isDefault", Ty::Bool),
    opt("externalUrl", Ty::Str),
    opt("syncEnabled", Ty::Bool),
    opt("preventSearch", Ty::Bool),
    opt("enableInstantRequests", Ty::Bool),
];

/// `SonarrSettings` in the spec.
const SONARR_FIELDS: [Field; 21] = [
    req("name", Ty::Str),
    req("hostname", Ty::Str),
    req("port", Ty::Num),
    req("apiKey", Ty::Str),
    req("useSsl", Ty::Bool),
    opt("baseUrl", Ty::Str),
    req("activeProfileId", Ty::Num),
    req("activeProfileName", Ty::Str),
    req("activeDirectory", Ty::Str),
    opt("activeLanguageProfileId", Ty::Num),
    nullable("activeAnimeProfileId", Ty::Num),
    nullable("activeAnimeLanguageProfileId", Ty::Num),
    nullable("activeAnimeProfileName", Ty::Str),
    nullable("activeAnimeDirectory", Ty::Str),
    req("is4k", Ty::Bool),
    req("enableSeasonFolders", Ty::Bool),
    req("isDefault", Ty::Bool),
    opt("externalUrl", Ty::Str),
    opt("syncEnabled", Ty::Bool),
    opt("preventSearch", Ty::Bool),
    opt("enableInstantRequests", Ty::Bool),
];

/// The test routes' body schema (both servers).
const TEST_FIELDS: [Field; 5] = [
    req("hostname", Ty::Str),
    req("port", Ty::Num),
    req("apiKey", Ty::Str),
    req("useSsl", Ty::Bool),
    opt("baseUrl", Ty::Str),
];

/// Which list of servers a route works on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Radarr,
    Sonarr,
}

impl Kind {
    const fn key(self) -> &'static str {
        match self {
            Self::Radarr => "radarr",
            Self::Sonarr => "sonarr",
        }
    }

    const fn fields(self) -> &'static [Field] {
        match self {
            Self::Radarr => &RADARR_FIELDS,
            Self::Sonarr => &SONARR_FIELDS,
        }
    }
}

/// The checked body of a create or update, in JavaScript key order with
/// numbers as JavaScript prints them.
fn server_body(ctx: &Ready<'_>, kind: Kind) -> Result<Map<String, Value>, super::Fallback> {
    admin(ctx)?;
    let body = object_body(ctx)?;
    if !fits(body, kind.fields(), &["id"]) {
        return Err(String::from("a body the validator may reject").into());
    }
    match crate::tmdb::js_numbers(Value::Object(js_key_order(body.clone()))) {
        Value::Object(map) => Ok(map),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) | Value::Array(_) => {
            Err(String::from("a body that isn't an object").into())
        }
    }
}

/// "If we are setting this as the default, clear any previous defaults for
/// the same type first."
fn clear_defaults(list: &mut [Value], body: &Map<String, Value>) {
    if !truthy(body.get("isDefault")) {
        return;
    }
    for server in list.iter_mut() {
        if js_strict_eq(server.get("is4k"), body.get("is4k")) {
            if let Some(map) = server.as_object_mut() {
                map.insert(String::from("isDefault"), Value::Bool(false));
            }
        }
    }
}

/// `settings.<kind>.findIndex((r) => r.id === Number(req.params.id))`.
/// `list.findIndex((r) => r.id === Number(req.params.id))`.
fn find_index(list: &[Value], id: i64) -> Option<usize> {
    list.iter()
        .position(|server| server.get("id").and_then(Value::as_i64) == Some(id))
}

/// The id in the path segment `depth` places from the end.
fn path_number(ctx: &Ready<'_>, depth: usize) -> Result<i64, super::Fallback> {
    super::params::path_int(ctx, depth)
}

/// The 404 for an unknown id.
fn not_found(ctx: &Ready<'_>) -> Outcome {
    let mut body = Map::new();
    body.insert(String::from("status"), Value::from("404"));
    body.insert(
        String::from("message"),
        Value::from("Settings instance not found"),
    );
    ctx.json_with(404, &Value::Object(body))
}

/// `settings.<kind>` in the latest settings, when it is a list of objects.
fn server_list(doc: &mut Value, kind: Kind) -> Result<&mut Vec<Value>, Box<Outcome>> {
    doc.get_mut(kind.key())
        .and_then(Value::as_array_mut)
        .filter(|l| l.iter().all(Value::is_object))
        .ok_or_else(|| {
            Box::new(Outcome::forward(format!(
                "settings.{} is not a list of objects",
                kind.key()
            )))
        })
}

/// `body` appended to `settings.<kind>` with the next id
/// (`lastItem ? lastItem.id + 1 : 0`): the server as saved.
fn append_server(
    doc: &mut Value,
    kind: Kind,
    mut body: Map<String, Value>,
) -> Result<Value, Box<Outcome>> {
    let list = server_list(doc, kind)?;
    let id = match list.last() {
        None => 0,
        Some(final_server) => match final_server.get("id").and_then(Value::as_i64) {
            Some(id) => id + 1,
            None => {
                return Err(Box::new(Outcome::forward(String::from(
                    "the last server's id isn't an integer",
                ))))
            }
        },
    };
    body.insert(String::from("id"), Value::from(id));
    clear_defaults(list, &body);
    let created = Value::Object(body);
    list.push(created.clone());
    Ok(created)
}

/// `POST /settings/<kind>`: append with the next id. The id is taken from
/// the latest list under the settings mutation lock, so concurrent adds
/// get distinct ids as they do in Node.
async fn create(ctx: &Ready<'_>, kind: Kind) -> Outcome {
    let body = match server_body(ctx, kind) {
        Ok(body) => body,
        Err(why) => return Outcome::forward(why),
    };
    match mutate(ctx, |doc| append_server(doc, kind, body)).await {
        Ok(created) => ctx.json_with(201, &created),
        Err(outcome) => outcome,
    }
}

/// `PUT /settings/<kind>/{id}`: replace the server, keeping its id.
async fn update(ctx: &Ready<'_>, kind: Kind) -> Outcome {
    let mut body = match server_body(ctx, kind) {
        Ok(body) => body,
        Err(why) => return Outcome::forward(why),
    };
    let id = match path_number(ctx, 0) {
        Ok(id) => id,
        Err(why) => return Outcome::forward(why),
    };
    let updated = mutate(ctx, |doc| {
        let list = server_list(doc, kind)?;
        let Some(index) = find_index(list, id) else {
            return Err(Box::new(not_found(ctx)));
        };
        clear_defaults(list, &body);
        body.insert(String::from("id"), Value::from(id));
        let updated = Value::Object(body);
        let Some(slot) = list.get_mut(index) else {
            return Err(Box::new(Outcome::forward(String::from(
                "the server vanished",
            ))));
        };
        *slot = updated.clone();
        Ok(updated)
    })
    .await;
    match updated {
        Ok(updated) => ctx.json(&updated),
        Err(outcome) => outcome,
    }
}

/// `DELETE /settings/<kind>/{id}`: the removed server.
async fn delete(ctx: &Ready<'_>, kind: Kind) -> Outcome {
    if let Err(why) = admin(ctx) {
        return Outcome::forward(why);
    }
    let id = match path_number(ctx, 0) {
        Ok(id) => id,
        Err(why) => return Outcome::forward(why),
    };
    let removed = mutate(ctx, |doc| {
        let list = server_list(doc, kind)?;
        let Some(index) = find_index(list, id) else {
            return Err(Box::new(not_found(ctx)));
        };
        Ok(list.remove(index))
    })
    .await;
    match removed {
        Ok(removed) => ctx.json(&removed),
        Err(outcome) => outcome,
    }
}

fn radarr_create<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(create(ctx, Kind::Radarr))
}

fn sonarr_create<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(create(ctx, Kind::Sonarr))
}

fn radarr_update<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(update(ctx, Kind::Radarr))
}

fn sonarr_update<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(update(ctx, Kind::Sonarr))
}

fn radarr_delete<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(delete(ctx, Kind::Radarr))
}

fn sonarr_delete<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(delete(ctx, Kind::Sonarr))
}

/// How one *arr call ended, in the terms axios would have reported.
enum Fetched {
    Ok(Value),
    /// axios rejected too: a network error or a non-2xx status.
    Failed(String),
}

/// Map a client result. A body that isn't JSON (an HTML page behind a
/// wrong URL base) is a string to axios, which Node's handler then trips
/// over: a failure here too.
fn classify(result: anyhow::Result<Value>) -> Fetched {
    match result {
        Ok(value) => Fetched::Ok(json_safe(value)),
        Err(e) => {
            let decode = e
                .downcast_ref::<reqwest::Error>()
                .is_some_and(reqwest::Error::is_decode);
            Fetched::Failed(if decode {
                String::from("an *arr answer that isn't JSON")
            } else {
                format!("{e:#}")
            })
        }
    }
}

/// `folders.map((folder) => ({ id: folder.id, path: folder.path }))`, or
/// none where that throws.
fn root_folders(folders: &Value) -> Option<Value> {
    let items = folders.as_array()?;
    let mut out = Vec::with_capacity(items.len());
    for folder in items {
        if folder.is_null() {
            return None;
        }
        let mut entry = Map::new();
        for key in ["id", "path"] {
            if let Some(v) = folder.as_object().and_then(|m| m.get(key)) {
                entry.insert(key.to_owned(), v.clone());
            }
        }
        out.push(Value::Object(entry));
    }
    Some(Value::Array(out))
}

/// The checked body of a test call.
fn test_body(ctx: &Ready<'_>) -> Result<Value, super::Fallback> {
    admin(ctx)?;
    let body = object_body(ctx)?;
    if !fits(body, &TEST_FIELDS, &[]) {
        return Err(String::from("a body the validator may reject").into());
    }
    Ok(crate::tmdb::js_numbers(Value::Object(body.clone())))
}

/// `POST /settings/radarr/test`: profiles, root folders, tags and the URL
/// base the server reports.
fn radarr_test<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(async move {
        let server = match test_body(ctx) {
            Ok(server) => server,
            Err(why) => return Outcome::forward(why),
        };
        let timeout = api_timeout(&ctx.settings);
        let client = &ctx.state.servarr;
        let fail = |why: &str| {
            tracing::error!("Failed to test Radarr: {why}");
            ctx.error(500, "Failed to connect to Radarr")
        };
        // `.then((value) => value.urlBase).catch(() => req.body.baseUrl)`
        let url_base = match classify(client.system_status(&server, timeout).await) {
            Fetched::Ok(Value::Null) | Fetched::Failed(_) => server.get("baseUrl").cloned(),
            Fetched::Ok(Value::Object(status)) => status.get("urlBase").cloned(),
            Fetched::Ok(_) => None,
        };
        let profiles = match classify(
            client
                .get_rolling(&server, "/qualityProfile", timeout)
                .await,
        ) {
            Fetched::Failed(why) => return fail(&why),
            Fetched::Ok(v) => v,
        };
        let folders = match classify(client.get_rolling(&server, "/rootfolder", timeout).await) {
            Fetched::Failed(why) => return fail(&why),
            Fetched::Ok(v) => v,
        };
        let tags = match classify(client.tags(&server, timeout).await) {
            Fetched::Failed(why) => return fail(&why),
            Fetched::Ok(v) => v,
        };
        let Some(root_folders) = root_folders(&folders) else {
            return fail("the root folders are not a list");
        };
        let mut out = Map::new();
        out.insert(String::from("profiles"), profiles);
        out.insert(String::from("rootFolders"), root_folders);
        out.insert(String::from("tags"), tags);
        if let Some(url_base) = url_base {
            out.insert(String::from("urlBase"), url_base);
        }
        ctx.json(&Value::Object(out))
    })
}

/// `Number(systemStatus.version.split('.')[0])` compared with 3, for the
/// spellings both agree on; none for anything else.
fn major_at_most_3(version: &str) -> Option<bool> {
    let first = version.split('.').next().unwrap_or("");
    let trimmed = super::nodestate::js_trim(first);
    if trimmed.is_empty() {
        return Some(true);
    }
    if trimmed.bytes().all(|b| b.is_ascii_digit()) {
        return Some(trimmed.parse::<u64>().is_ok_and(|n| n <= 3));
    }
    None
}

/// `POST /settings/sonarr/test`: also language profiles for Sonarr v3.
fn sonarr_test<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(async move {
        let server = match test_body(ctx) {
            Ok(server) => server,
            Err(why) => return Outcome::forward(why),
        };
        let timeout = api_timeout(&ctx.settings);
        let client = &ctx.state.servarr.for_sonarr();
        let fail = |why: &str| {
            tracing::error!("Failed to test Sonarr: {why}");
            ctx.error(500, "Failed to connect to Sonarr")
        };
        let status = match classify(client.system_status(&server, timeout).await) {
            Fetched::Failed(why) => return fail(&why),
            Fetched::Ok(v) => v,
        };
        let Some(version) = status.get("version") else {
            return fail("the system status has no version");
        };
        let Some(version) = version.as_str() else {
            return Outcome::forward(String::from("a version that isn't a string"));
        };
        let Some(v3) = major_at_most_3(version) else {
            return Outcome::forward(String::from("a version Number() may read differently"));
        };
        let url_base = status.get("urlBase").cloned();
        let profiles = match classify(
            client
                .get_rolling(&server, "/qualityProfile", timeout)
                .await,
        ) {
            Fetched::Failed(why) => return fail(&why),
            Fetched::Ok(v) => v,
        };
        let folders = match classify(client.get_rolling(&server, "/rootfolder", timeout).await) {
            Fetched::Failed(why) => return fail(&why),
            Fetched::Ok(v) => v,
        };
        let language_profiles = if v3 {
            match classify(
                client
                    .get_rolling(&server, "/languageprofile", timeout)
                    .await,
            ) {
                Fetched::Failed(why) => return fail(&why),
                Fetched::Ok(v) => v,
            }
        } else {
            Value::Null
        };
        let tags = match classify(client.tags(&server, timeout).await) {
            Fetched::Failed(why) => return fail(&why),
            Fetched::Ok(v) => v,
        };
        let Some(root_folders) = root_folders(&folders) else {
            return fail("the root folders are not a list");
        };
        let mut out = Map::new();
        out.insert(String::from("profiles"), profiles);
        out.insert(String::from("rootFolders"), root_folders);
        out.insert(String::from("languageProfiles"), language_profiles);
        out.insert(String::from("tags"), tags);
        if let Some(url_base) = url_base {
            out.insert(String::from("urlBase"), url_base);
        }
        ctx.json(&Value::Object(out))
    })
}

/// `GET /settings/radarr/{id}/profiles`: each profile's id and name.
/// Failures surface axios's message in Node, so they go there.
fn radarr_profiles<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(async move {
        if let Err(why) = admin(ctx) {
            return Outcome::forward(why);
        }
        let id = match path_number(ctx, 1) {
            Ok(id) => id,
            Err(why) => return Outcome::forward(why),
        };
        let Some(list) = ctx.settings.get("/radarr").and_then(Value::as_array) else {
            return Outcome::forward(String::from("settings.radarr is not a list"));
        };
        let Some(server) = find_index(list, id).and_then(|i| list.get(i)) else {
            return not_found(ctx);
        };
        let timeout = api_timeout(&ctx.settings);
        let profiles = match classify(
            ctx.state
                .servarr
                .get_rolling(server, "/qualityProfile", timeout)
                .await,
        ) {
            Fetched::Ok(v) => v,
            Fetched::Failed(why) => {
                return Outcome::forward(format!("fetching profiles failed: {why}"));
            }
        };
        let Some(items) = profiles.as_array() else {
            return Outcome::forward(String::from("profiles that aren't a list"));
        };
        let mut out = Vec::with_capacity(items.len());
        for profile in items {
            if profile.is_null() {
                return Outcome::forward(String::from("a null profile"));
            }
            out.push(Value::Object(super::nodestate::pick(
                profile,
                &["id", "name"],
            )));
        }
        ctx.json(&Value::Array(out))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::ops::ControlFlow;

    #[test]
    fn helpers() {
        let mut list = vec![
            json!({"id": 0, "is4k": false, "isDefault": true}),
            json!({"id": 1, "is4k": true, "isDefault": true}),
        ];
        let body = json!({"isDefault": true, "is4k": false});
        if let Some(body) = body.as_object() {
            clear_defaults(&mut list, body);
        }
        assert_eq!(
            list.first(),
            Some(&json!({"id": 0, "is4k": false, "isDefault": false})),
            "cleared"
        );
        assert_eq!(
            list.get(1),
            Some(&json!({"id": 1, "is4k": true, "isDefault": true})),
            "kept"
        );
        assert_eq!(find_index(&list, 1), Some(1), "found");
        assert_eq!(find_index(&list, 7), None, "missing");
        assert_eq!(major_at_most_3("3.0.10"), Some(true), "v3");
        assert_eq!(major_at_most_3("4.0.0"), Some(false), "v4");
        assert_eq!(major_at_most_3("v4"), None, "unclear");
        assert_eq!(
            root_folders(&json!([{"id": 1, "path": "/m", "freeSpace": 2}, 5])),
            Some(json!([{"id": 1, "path": "/m"}, {}])),
            "folders"
        );
        assert_eq!(root_folders(&json!([null])), None, "null folder throws");
    }

    /// Concurrent adds each take the next id from the latest list and all
    /// of them stay (they used to share one id, and only one was kept).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_adds_keep_every_server() -> anyhow::Result<()> {
        let dir = std::env::temp_dir().join(format!(
            "foreseerr-arrsettings-{}-{}",
            std::process::id(),
            crate::clock::now_millis()
        ));
        std::fs::create_dir_all(&dir)?;
        let store = std::sync::Arc::new(crate::settings::SettingsStore::new(&dir));
        let mut adds = tokio::task::JoinSet::new();
        for n in 0..20 {
            let store = std::sync::Arc::clone(&store);
            let body = json!({"name": format!("radarr {n}"), "isDefault": false});
            let body = body.as_object().cloned().unwrap_or_default();
            adds.spawn(async move {
                let added = store
                    .mutate(|doc| {
                        append_server(doc, Kind::Radarr, body)
                            .map_or(ControlFlow::Break(()), ControlFlow::Continue)
                    })
                    .await
                    .ok()?;
                added.continue_value()?.get("id").and_then(Value::as_i64)
            });
        }
        let mut ids = Vec::new();
        while let Some(id) = adds.join_next().await {
            ids.extend(id?);
        }
        ids.sort_unstable();
        assert_eq!(ids, (0..20).collect::<Vec<_>>(), "distinct ids");
        let file: Value = serde_json::from_slice(&std::fs::read(dir.join("settings.json"))?)?;
        let mut saved: Vec<i64> = file
            .get("radarr")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|server| server.get("id").and_then(Value::as_i64))
            .collect();
        saved.sort_unstable();
        assert_eq!(saved, ids, "every server saved");
        std::fs::remove_dir_all(&dir).ok();
        Ok(())
    }
}
