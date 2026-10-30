//! `/settings/jellyfin` writes and reads that go to the Jellyfin server
//! (`server/routes/settings/index.ts`, `JellyfinAPI`).

use axum::http::Method;
use serde_json::{Map, Value};

use super::nodestate::{
    admin, admin_columns, assign, fits, internal_call, js_key_order, mutate, object_body_or_empty,
    opt, upstream_get, Field, NativeFut, Ty, Upstream,
};
use super::plexsettings::merge_libraries;
use super::{Outcome, Ready, Table};
use crate::media::js_string;
use crate::settings::public::truthy;

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/settings/jellyfin", Method::POST, jellyfin_save),
    (
        "/api/v1/settings/jellyfin/library/sync",
        Method::POST,
        library_sync,
    ),
    ("/api/v1/settings/jellyfin/users", Method::GET, users),
];

/// `JellyfinSettings` in the spec (`name`, `libraries`, `serverID` are
/// read-only).
const JELLYFIN_FIELDS: [Field; 5] = [
    opt("hostname", Ty::Str),
    opt("externalHostname", Ty::Str),
    opt("jellyfinForgotPasswordUrl", Ty::Str),
    opt("adminUser", Ty::Str),
    opt("adminPass", Ty::Str),
];

/// `mapLibraries`' excluded collection types.
const EXCLUDED_TYPES: [&str; 5] = ["music", "books", "musicvideos", "homevideos", "boxsets"];

/// A client as `new JellyfinAPI(host, token, deviceId)` builds it.
pub(super) struct Jellyfin {
    host: String,
    authorization: String,
}

impl Jellyfin {
    /// `getHostname(settings)` and `buildJellyfinAuthorizationHeader`.
    pub(super) fn new(ctx: &Ready<'_>, settings: &Value, device_id: Option<&str>) -> Self {
        let scheme = if truthy(settings.get("useSsl")) {
            "https"
        } else {
            "http"
        };
        let host = format!(
            "{scheme}://{}:{}{}",
            js_string(settings.get("ip")),
            js_string(settings.get("port")),
            js_string(settings.get("urlBase"))
        );
        let device = device_id
            .filter(|d| !d.is_empty())
            .unwrap_or("Qk9UX3NlZXJy");
        let emby = ctx
            .settings
            .get("/main/mediaServerType")
            .and_then(Value::as_i64)
            == Some(3);
        let version = if emby {
            "1.0.0"
        } else {
            ctx.state.version.version.as_str()
        };
        let mut authorization = format!(
            "MediaBrowser Client=\"Foreseerr\", Device=\"Foreseerr\", DeviceId=\"{device}\", Version=\"{version}\""
        );
        let token = settings.get("apiKey");
        if truthy(token) {
            authorization.push_str(", Token=\"");
            authorization.push_str(&js_string(token));
            authorization.push('"');
        }
        Self {
            host,
            authorization,
        }
    }

    pub(super) async fn get(&self, ctx: &Ready<'_>, path: &str) -> Upstream {
        upstream_get(
            ctx.state
                .outbound
                .get(format!("{}{path}", self.host))
                .header("Authorization", &self.authorization)
                .header("Content-Type", "application/json")
                .header("Accept", "application/json"),
        )
        .await
    }
}

/// The admin's Jellyfin device and user ids, or why Node has to answer.
async fn admin_ids(ctx: &Ready<'_>) -> Result<(Option<String>, Option<String>), String> {
    match admin_columns(ctx, &["jellyfinDeviceId", "jellyfinUserId"]).await {
        Ok(Some(row)) => {
            let text = |k: &str| row.get(k).and_then(Value::as_str).map(str::to_owned);
            Ok((text("jellyfinDeviceId"), text("jellyfinUserId")))
        }
        Ok(None) => Err(String::from("no admin user; findOneOrFail throws")),
        Err(e) => Err(format!("loading the admin failed: {e:#}")),
    }
}

/// `POST /settings/jellyfin`: test the merged settings, then save the body
/// with the server's id and name.
fn jellyfin_save<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(async move {
        if let Err(why) = admin(ctx) {
            return Outcome::forward(why);
        }
        let body = match object_body_or_empty(ctx) {
            Ok(body) => body,
            Err(why) => return Outcome::forward(why),
        };
        if !fits(body, &JELLYFIN_FIELDS, &["name", "libraries", "serverID"]) {
            return Outcome::forward(String::from("a body the validator may reject"));
        }
        let (device_id, _) = match admin_ids(ctx).await {
            Ok(ids) => ids,
            Err(why) => return Outcome::forward(why),
        };
        let Value::Object(body) =
            crate::tmdb::js_numbers(Value::Object(js_key_order(body.clone())))
        else {
            return Outcome::forward(String::from("a body that isn't an object"));
        };
        let Some(jellyfin) = ctx.settings.get("/jellyfin").and_then(Value::as_object) else {
            return Outcome::forward(String::from("settings.jellyfin isn't an object"));
        };
        let mut temp = jellyfin.clone();
        assign(&mut temp, &body);
        let client = Jellyfin::new(ctx, &Value::Object(temp), device_id.as_deref());
        let info = match client.get(ctx, "/System/Info").await {
            Upstream::Json(info) => info,
            Upstream::Network(e) => {
                tracing::error!("Something went wrong testing Jellyfin connection: {e}");
                return ctx.error(502, "INVALID_URL");
            }
            Upstream::Status(status) => {
                tracing::error!("Something went wrong testing Jellyfin connection: {status}");
                return ctx.error(status, "INVALID_URL");
            }
            Upstream::NotJson => return ctx.error(500, "INVALID_URL"),
        };
        let Some(id) = info.get("Id").filter(|id| truthy(Some(id))) else {
            return match info.get("status") {
                None | Some(Value::Null | Value::Bool(false)) => ctx.error(500, "INVALID_URL"),
                Some(Value::Number(n)) if n.as_f64() == Some(0.0) => ctx.error(500, "INVALID_URL"),
                Some(_) => Outcome::forward(String::from("a status field Express may reject")),
            };
        };
        let saved = mutate(ctx, |doc| {
            let Some(jellyfin) = doc.get_mut("jellyfin").and_then(Value::as_object_mut) else {
                return Err(Box::new(Outcome::forward(String::from(
                    "settings.jellyfin isn't an object",
                ))));
            };
            assign(jellyfin, &body);
            jellyfin.insert(String::from("serverId"), id.clone());
            match info.get("ServerName") {
                Some(name) => {
                    jellyfin.insert(String::from("name"), name.clone());
                }
                None => {
                    jellyfin.shift_remove("name");
                }
            }
            Ok(Value::Object(jellyfin.clone()))
        })
        .await;
        let saved = match saved {
            Ok(saved) => saved,
            Err(outcome) => return outcome,
        };
        clear_integration_health(ctx).await;
        ctx.json(&saved)
    })
}

/// `clearIntegrationHealthCache()`.
async fn clear_integration_health(ctx: &Ready<'_>) {
    match internal_call(ctx, Method::POST, "/integrations/health/clear", None).await {
        (204, _) => {}
        (status, _) => tracing::warn!("Integration health was not cleared: {status}"),
    }
}

/// `mapLibraries`, or none where it throws.
fn map_libraries(items: Option<&Value>) -> Option<Vec<Value>> {
    let items = items?.as_array()?;
    let mut out = Vec::new();
    for item in items {
        if item.is_null() {
            return None;
        }
        let folder = item.get("Type").and_then(Value::as_str) == Some("CollectionFolder");
        let collection = item.get("CollectionType");
        let excluded = collection
            .and_then(Value::as_str)
            .is_some_and(|c| EXCLUDED_TYPES.contains(&c));
        if !folder || excluded {
            continue;
        }
        let mut library = Map::new();
        if let Some(id) = item.get("Id") {
            library.insert(String::from("key"), id.clone());
        }
        if let Some(name) = item.get("Name") {
            library.insert(String::from("title"), name.clone());
        }
        let kind = if collection.and_then(Value::as_str) == Some("movies") {
            "movie"
        } else {
            "show"
        };
        library.insert(String::from("type"), Value::from(kind));
        library.insert(String::from("agent"), Value::from("jellyfin"));
        out.push(Value::Object(library));
    }
    Some(out)
}

/// How `getLibraries` ended.
enum Libraries {
    Found(Vec<Value>),
    /// `ApiError(502, CONNECTION_ERROR)`.
    ConnectionError,
}

/// `getLibraries`: media folders, falling back to the user's views.
async fn get_libraries(ctx: &Ready<'_>, client: &Jellyfin, user_id: &str) -> Libraries {
    if let Upstream::Json(v) = client.get(ctx, "/Library/MediaFolders").await {
        if let Some(found) = map_libraries(v.get("Items")) {
            return Libraries::Found(found);
        }
    }
    match client.get(ctx, &format!("/Users/{user_id}/Views")).await {
        Upstream::Json(v) => {
            map_libraries(v.get("Items")).map_or(Libraries::ConnectionError, Libraries::Found)
        }
        Upstream::Status(_) => Libraries::Found(Vec::new()),
        Upstream::NotJson | Upstream::Network(_) => Libraries::ConnectionError,
    }
}

/// Whether `account.Configuration.GroupedFolders?.length > 0`; none where
/// that throws or isn't followed here.
fn grouped_folders(account: &Value) -> Result<bool, Option<()>> {
    let configuration = account.get("Configuration").ok_or(Some(()))?;
    if configuration.is_null() {
        return Err(Some(()));
    }
    match configuration.get("GroupedFolders") {
        Some(Value::Array(items)) => Ok(!items.is_empty()),
        Some(Value::String(s)) => Ok(!s.is_empty()),
        Some(Value::Object(_)) => Err(None),
        None | Some(Value::Null | Value::Bool(_) | Value::Number(_)) => Ok(false),
    }
}

/// `POST /settings/jellyfin/library/sync`.
fn library_sync<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(async move {
        if let Err(why) = admin(ctx) {
            return Outcome::forward(why);
        }
        let (device_id, user_id) = match admin_ids(ctx).await {
            Ok(ids) => ids,
            Err(why) => return Outcome::forward(why),
        };
        let user_id = user_id.unwrap_or_default();
        let Some(jellyfin) = ctx.settings.get("/jellyfin").cloned() else {
            return Outcome::forward(String::from("no jellyfin settings"));
        };
        let Some(existing) = jellyfin.get("libraries").and_then(Value::as_array).cloned() else {
            return Outcome::forward(String::from("jellyfin.libraries isn't a list"));
        };
        let client = Jellyfin::new(ctx, &jellyfin, device_id.as_deref());
        let found = match get_libraries(ctx, &client, &user_id).await {
            Libraries::Found(found) => found,
            Libraries::ConnectionError => return ctx.error(502, "CONNECTION_ERROR"),
        };
        if found.is_empty() {
            let account = match client.get(ctx, &format!("/Users/{user_id}")).await {
                Upstream::Json(account) => account,
                Upstream::NotJson => Value::Null,
                Upstream::Status(status) => return ctx.error(status, "INVALID_AUTH_TOKEN"),
                Upstream::Network(_) => return ctx.error(502, "CONNECTION_ERROR"),
            };
            return match grouped_folders(&account) {
                Ok(true) => ctx.error(501, "SYNC_ERROR_GROUPED_FOLDERS"),
                Ok(false) => ctx.error(404, "SYNC_ERROR_NO_LIBRARIES"),
                Err(Some(())) => ctx.error(500, "UNKNOWN"),
                Err(None) => Outcome::forward(String::from("GroupedFolders of an odd shape")),
            };
        }
        let Some(libraries) = merge_libraries(&found, &existing) else {
            return Outcome::forward(String::from("a null library; find throws"));
        };
        let saved = mutate(ctx, |doc| {
            if let Some(jellyfin) = doc.get_mut("jellyfin").and_then(Value::as_object_mut) {
                jellyfin.insert(String::from("libraries"), Value::Array(libraries.clone()));
            }
            Ok(())
        })
        .await;
        if let Err(outcome) = saved {
            return outcome;
        }
        ctx.json(&Value::Array(libraries))
    })
}

/// `GET /settings/jellyfin/users`. Failures throw an `ApiError` Express
/// reports with an empty message.
fn users<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(async move {
        if let Err(why) = admin(ctx) {
            return Outcome::forward(why);
        }
        let (device_id, _) = match admin_ids(ctx).await {
            Ok(ids) => ids,
            Err(why) => return Outcome::forward(why),
        };
        let settings = ctx
            .settings
            .get("/jellyfin")
            .cloned()
            .unwrap_or(Value::Null);
        let client = Jellyfin::new(ctx, &settings, device_id.as_deref());
        let list = match client.get(ctx, "/Users").await {
            Upstream::Json(Value::Array(list)) => list,
            // `getUsers` throws an `ApiError`: no `status`, an empty
            // message.
            Upstream::Status(_) | Upstream::Network(_) => return ctx.error(500, ""),
            Upstream::Json(_) | Upstream::NotJson => {
                return Outcome::forward(String::from(
                    "a Jellyfin user list that isn't an array; the map throws",
                ))
            }
        };
        let mut out = Vec::with_capacity(list.len());
        for user in &list {
            if user.is_null() {
                return Outcome::forward(String::from("a null user; the map throws"));
            }
            let mut entry = Map::new();
            if let Some(name) = user.get("Name") {
                entry.insert(String::from("username"), name.clone());
            }
            if let Some(id) = user.get("Id") {
                entry.insert(String::from("id"), id.clone());
            }
            entry.insert(
                String::from("thumb"),
                Value::from(format!("/avatarproxy/{}", js_string(user.get("Id")))),
            );
            if let Some(name) = user.get("Name") {
                entry.insert(String::from("email"), name.clone());
            }
            out.push(Value::Object(entry));
        }
        ctx.json(&Value::Array(out))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn libraries() {
        let items = json!([
            {"Type": "CollectionFolder", "CollectionType": "movies", "Id": "a", "Name": "Movies"},
            {"Type": "CollectionFolder", "CollectionType": "music", "Id": "b", "Name": "Music"},
            {"Type": "CollectionFolder", "Id": "c", "Name": "Mixed"},
            {"Type": "Folder", "Id": "d"}
        ]);
        assert_eq!(
            map_libraries(Some(&items)),
            Some(vec![
                json!({"key": "a", "title": "Movies", "type": "movie", "agent": "jellyfin"}),
                json!({"key": "c", "title": "Mixed", "type": "show", "agent": "jellyfin"}),
            ]),
            "mapped"
        );
        assert_eq!(map_libraries(Some(&json!([null]))), None, "null throws");
        assert_eq!(map_libraries(None), None, "missing throws");
        assert_eq!(
            grouped_folders(&json!({"Configuration": {"GroupedFolders": ["x"]}})),
            Ok(true),
            "grouped"
        );
        assert_eq!(
            grouped_folders(&json!({"Configuration": {}})),
            Ok(false),
            "none"
        );
        assert_eq!(grouped_folders(&json!({})), Err(Some(())), "throws");
    }
}
