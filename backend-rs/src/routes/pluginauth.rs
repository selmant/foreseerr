//! The Jellyfin plugin's accounts.
//!
//! `POST /auth/jellyfin/plugin` in plugin mode (the plugin mints a session for the Jellyfin user it already
//! authenticated) and `ensurePluginAdminUser()` at startup, with
//! `syncPluginAdmin` and `availablePluginEmail` from
//! `server/lib/jellyfinHostBootstrap.ts`.
//!
//! Outside plugin mode the route answers 404 (`authjellyfin.rs`).

use std::net::SocketAddr;
use std::ops::ControlFlow;
use std::sync::Arc;

use axum::extract::ConnectInfo;
use axum::http::{header, HeaderValue};
use serde_json::{Map, Value};

use super::authcommon::{
    avatar_url, base64, default_permissions, js_length, start_jobs, update_user, user_count,
    Entity, NewUser, Step, USER_JELLYFIN,
};
use super::{Outcome, Ready};
use crate::db::{Bind, Db};
use crate::settings::public::truthy;
use crate::state::AppState;

/// `Permission.ADMIN`.
const ADMIN: i64 = 2;

/// `pluginAdminPermissions(current, isAdministrator, grantedByPlugin,
/// defaults)`: the permissions and whether the plugin granted ADMIN.
const fn admin_permissions(
    current: i64,
    is_administrator: bool,
    granted_by_plugin: bool,
    defaults: i64,
) -> (i64, bool) {
    if is_administrator {
        return if current & ADMIN != 0 {
            (current, granted_by_plugin)
        } else {
            (current | ADMIN, true)
        };
    }
    if !granted_by_plugin || current & ADMIN == 0 {
        return (current, false);
    }
    let without = current & !ADMIN;
    (if without == 0 { defaults } else { without }, false)
}

/// `syncPluginAdmin(user, jellyfinUserId, isAdministrator)`: the user's
/// permissions after a sign-in; settings.json records who the plugin made
/// an administrator.
async fn sync_admin(
    state: &AppState,
    current: i64,
    jellyfin_user_id: &str,
    is_administrator: bool,
) -> anyhow::Result<i64> {
    // Read, decide and save on the latest settings under the mutation
    // lock: Node does all of it on its shared settings object at once.
    let flow = state
        .settings
        .mutate(|doc| {
            // `new Set(settings.plugin.jellyfinAdmins)`.
            let mut admins: Vec<Value> = Vec::new();
            for id in doc
                .pointer("/plugin/jellyfinAdmins")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if !admins.contains(id) {
                    admins.push(id.clone());
                }
            }
            let key = Value::from(jellyfin_user_id);
            let had = admins.contains(&key);
            let defaults = doc
                .pointer("/main/defaultPermissions")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let (permissions, granted) =
                admin_permissions(current, is_administrator, had, defaults);
            if granted == had {
                return ControlFlow::Break(permissions);
            }
            if granted {
                admins.push(key);
            } else {
                admins.retain(|id| *id != key);
            }
            if let Some(root) = doc.as_object_mut() {
                let plugin = root
                    .entry(String::from("plugin"))
                    .or_insert_with(|| Value::Object(Map::new()));
                if let Some(plugin) = plugin.as_object_mut() {
                    plugin.insert(String::from("jellyfinAdmins"), Value::Array(admins));
                }
            }
            ControlFlow::Continue(permissions)
        })
        .await?;
    Ok(match flow {
        ControlFlow::Break(permissions) | ControlFlow::Continue(permissions) => permissions,
    })
}

/// `availablePluginEmail(username, jellyfinUserId)`: the lower-cased name,
/// then with the first eight characters of the id, then the whole id.
async fn available_email(
    db: &Db,
    username: &str,
    jellyfin_user_id: &str,
) -> anyhow::Result<String> {
    let name = username.to_lowercase();
    let short: String = char::decode_utf16(jellyfin_user_id.encode_utf16().take(8))
        .map(|unit| unit.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect();
    for email in [name.clone(), format!("{name}+{short}")] {
        let taken = db
            .scalar(
                r#"SELECT CAST(COUNT(*) AS BIGINT) FROM "user" WHERE "email" = ?1"#,
                &[Bind::Text(email.clone())],
            )
            .await?;
        if taken == 0 {
            return Ok(email);
        }
    }
    Ok(format!("{name}+{jellyfin_user_id}"))
}

/// The user with this Jellyfin id: id and permissions.
async fn by_jellyfin_id(db: &Db, jellyfin_user_id: &str) -> anyhow::Result<Option<(i64, i64)>> {
    let rows = db
        .rows(
            r#"SELECT CAST("id" AS BIGINT) AS "id", CAST("permissions" AS BIGINT) AS "permissions" FROM "user" WHERE "jellyfinUserId" = ?1 LIMIT 1"#,
            &[Bind::Text(jellyfin_user_id.to_owned())],
        )
        .await?;
    Ok(rows.into_iter().next().and_then(|row| {
        Some((
            row.get("id").and_then(Value::as_i64)?,
            row.get("permissions").and_then(Value::as_i64).unwrap_or(0),
        ))
    }))
}

/// `ensurePluginAdminUser()`: the Jellyfin administrator named in
/// jellyfin-host.json exists and is an administrator here. Failures are
/// logged; the first administrator sign-in creates the owner too.
pub async fn ensure_admin_user(state: &Arc<AppState>) {
    if !(crate::runtime::active() && crate::runtime::plugin_mode()) {
        return;
    }
    if let Err(e) = ensure_admin(state).await {
        tracing::error!(
            label = "Plugin",
            errorMessage = %format!("{e:#}"),
            "Could not create the plugin admin user"
        );
    }
}

async fn ensure_admin(state: &AppState) -> anyhow::Result<()> {
    let path = state.env.config_dir.join("jellyfin-host.json");
    let Some(host) = crate::runtime::plugin::read_host_file(&path).await else {
        return Ok(());
    };
    let admin = host.get("adminUser");
    let field = |key: &str| admin.and_then(|a| a.get(key)).filter(|v| truthy(Some(v)));
    let (Some(jellyfin_user_id), Some(username)) =
        (field("jellyfinUserId"), field("jellyfinUsername"))
    else {
        return Ok(());
    };
    let (Some(jellyfin_user_id), Some(username)) = (jellyfin_user_id.as_str(), username.as_str())
    else {
        anyhow::bail!("the Jellyfin host's admin user isn't text");
    };
    let db = &state.db;
    if let Some((id, current)) = by_jellyfin_id(db, jellyfin_user_id).await? {
        let permissions = sync_admin(state, current, jellyfin_user_id, true).await?;
        if permissions != current {
            update_user(db, id, vec![("permissions", Bind::Int(permissions))]).await?;
        }
        return Ok(());
    }
    let first = user_count(db).await? == 0;
    let label = field("email")
        .and_then(Value::as_str)
        .unwrap_or(username)
        .to_owned();
    let email = available_email(db, &label, jellyfin_user_id).await?;
    let settings = state.settings.current().await?;
    let defaults = settings
        .get("/main/defaultPermissions")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let permissions = sync_admin(state, defaults, jellyfin_user_id, true).await?;
    NewUser {
        id: first.then_some(1),
        email: Some(email),
        jellyfin_username: Some(username.to_owned()),
        jellyfin_user_id: Some(jellyfin_user_id.to_owned()),
        jellyfin_device_id: Some(String::from("BOT_seerr")),
        permissions,
        user_type: USER_JELLYFIN,
        avatar: format!("/avatarproxy/{jellyfin_user_id}"),
        ..NewUser::default()
    }
    .insert(db)
    .await?;
    tracing::info!(
        label = "Plugin",
        jellyfinUsername = username,
        "Created plugin admin user from Jellyfin host bootstrap"
    );
    Ok(())
}

/// The mint body as zod parses it.
struct MintBody {
    jellyfin_user_id: String,
    jellyfin_username: String,
    access_token: String,
    is_administrator: bool,
}

fn text_between(body: &Map<String, Value>, key: &str, max: usize) -> Option<String> {
    let text = body.get(key)?.as_str()?;
    (1..=max)
        .contains(&js_length(text))
        .then(|| text.to_owned())
}

fn mint_body(body: Option<&Value>) -> Option<MintBody> {
    let Some(Value::Object(body)) = body else {
        return None;
    };
    Some(MintBody {
        jellyfin_user_id: text_between(body, "jellyfinUserId", 128)?,
        jellyfin_username: text_between(body, "jellyfinUsername", 256)?,
        access_token: text_between(body, "jellyfinAccessToken", 4096)?,
        is_administrator: match body.get("isAdministrator") {
            None => false,
            Some(Value::Bool(b)) => *b,
            Some(_) => return None,
        },
    })
}

/// `POST /auth/jellyfin/plugin` in plugin mode.
pub(super) async fn mint(ctx: &Ready<'_>) -> Step {
    if crate::runtime::plugin_secret().is_empty() {
        return Ok(ctx.error(503, "Plugin secret is not configured."));
    }
    let secret = ctx
        .req
        .headers
        .get("x-foreseerr-plugin-secret")
        .map(HeaderValue::as_bytes);
    let minting = ctx
        .req
        .headers
        .get("x-foreseerr-mint")
        .is_some_and(|v| v.as_bytes() == b"1");
    let loopback = ctx
        .req
        .extensions
        .get::<ConnectInfo<SocketAddr>>()
        .is_some_and(|c| crate::runtime::is_loopback(c.0.ip()));
    if !crate::runtime::verify_secret(secret) || !minting || !loopback {
        return Ok(ctx.error(403, "Plugin auth is loopback-only."));
    }
    let Some(body) = mint_body(ctx.body.as_ref()) else {
        return Ok(ctx.error(400, "Invalid plugin mint payload."));
    };
    match mint_user(ctx, &body).await {
        Ok(outcome) => Ok(outcome),
        Err(e) => {
            tracing::error!(label = "Plugin auth", "{e:#}");
            Ok(ctx.error(500, "Plugin sign-in failed."))
        }
    }
}

/// The handler's `try` block.
async fn mint_user(ctx: &Ready<'_>, body: &MintBody) -> anyhow::Result<Outcome> {
    let state = ctx.state;
    let db = &state.db;
    let jellyfin_user_id = body.jellyfin_user_id.as_str();
    let device_id = base64(&format!("BOT_seerr_{}", body.jellyfin_username));
    let entity = if let Some((id, current)) = by_jellyfin_id(db, jellyfin_user_id).await? {
        let rows = db
            .rows(
                r#"SELECT "avatarVersion" FROM "user" WHERE "id" = ?1"#,
                &[Bind::Int(id)],
            )
            .await?;
        let version = rows
            .first()
            .and_then(|r| r.get("avatarVersion"))
            .cloned()
            .unwrap_or(Value::Null);
        let avatar = avatar_url(Some(&Value::from(jellyfin_user_id)), Some(&version));
        let permissions =
            sync_admin(state, current, jellyfin_user_id, body.is_administrator).await?;
        update_user(
            db,
            id,
            vec![
                (
                    "jellyfinUsername",
                    Bind::Text(body.jellyfin_username.clone()),
                ),
                ("jellyfinAuthToken", Bind::Text(body.access_token.clone())),
                ("jellyfinDeviceId", Bind::Text(device_id)),
                ("avatar", Bind::Text(avatar)),
                ("permissions", Bind::Int(permissions)),
            ],
        )
        .await?;
        match Entity::find(db, id).await? {
            Ok(Some(entity)) => entity,
            Ok(None) => {
                anyhow::bail!("the new user row is missing")
            }
            Err(why) => anyhow::bail!(why),
        }
    } else {
        let first = user_count(db).await? == 0;
        if first && !body.is_administrator {
            return Ok(ctx.error(403, "A Jellyfin administrator must open Foreseerr first."));
        }
        if !first && !truthy(ctx.settings.get("/main/newPlexLogin")) {
            return Ok(ctx.error(
                403,
                "Foreseerr is not open to new Jellyfin users. Ask an administrator to import your account.",
            ));
        }
        let email = available_email(db, &body.jellyfin_username, jellyfin_user_id).await?;
        let defaults = default_permissions(ctx).map_err(anyhow::Error::msg)?;
        let permissions =
            sync_admin(state, defaults, jellyfin_user_id, body.is_administrator).await?;
        let mut entity = NewUser {
            id: first.then_some(1),
            email: Some(email),
            jellyfin_username: Some(body.jellyfin_username.clone()),
            jellyfin_user_id: Some(jellyfin_user_id.to_owned()),
            jellyfin_device_id: Some(device_id),
            jellyfin_auth_token: Some(body.access_token.clone()),
            permissions,
            user_type: USER_JELLYFIN,
            avatar: avatar_url(Some(&Value::from(jellyfin_user_id)), None),
            ..NewUser::default()
        }
        .insert(db)
        .await?;
        // The insert reads every column back; toPublicJSON prints these.
        for key in ["username", "plexUsername", "plexId"] {
            if entity.get(key).is_none() {
                entity.set(key, Value::Null);
            }
        }
        if first {
            start_jobs(ctx).await;
        }
        entity
    };
    let id = entity
        .get("id")
        .and_then(Value::as_i64)
        .ok_or_else(|| anyhow::anyhow!("the user has no id"))?;
    let saved = crate::runtime::session::regenerate(state, &ctx.settings, &ctx.req.headers, id)
        .await
        .map_err(anyhow::Error::msg)?;
    let mut outcome = ctx.json(&entity.public_json());
    if let (Outcome::Done(res), Some(cookie)) = (&mut outcome, saved.cookie) {
        if let Ok(value) = HeaderValue::from_str(&cookie) {
            res.headers_mut().append(header::SET_COOKIE, value);
        }
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admin_permissions_like_the_plugin() {
        assert_eq!(
            admin_permissions(32, true, false, 32),
            (34, true),
            "granted"
        );
        assert_eq!(
            admin_permissions(34, true, false, 32),
            (34, false),
            "already admin"
        );
        assert_eq!(
            admin_permissions(34, false, true, 32),
            (32, false),
            "revoked"
        );
        assert_eq!(
            admin_permissions(2, false, true, 32),
            (32, false),
            "revoked to defaults"
        );
        assert_eq!(
            admin_permissions(34, false, false, 32),
            (34, false),
            "granted here"
        );
    }

    #[test]
    fn mint_bodies() {
        let ok = serde_json::json!({"jellyfinUserId": "u", "jellyfinUsername": "B", "jellyfinAccessToken": "t"});
        assert!(
            mint_body(Some(&ok)).is_some_and(|b| !b.is_administrator),
            "defaults"
        );
        let empty = serde_json::json!({"jellyfinUserId": "", "jellyfinUsername": "B", "jellyfinAccessToken": "t"});
        assert!(mint_body(Some(&empty)).is_none(), "empty id");
        let null_admin = serde_json::json!({"jellyfinUserId": "u", "jellyfinUsername": "B", "jellyfinAccessToken": "t", "isAdministrator": null});
        assert!(
            mint_body(Some(&null_admin)).is_none(),
            "null isn't a boolean"
        );
        assert!(mint_body(None).is_none(), "no body");
    }
}
