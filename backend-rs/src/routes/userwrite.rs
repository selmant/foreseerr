//! User writes from `server/routes/user/index.ts`.
//!
//! Create, update, bulk permissions, delete, push subscription
//! registration, the Jellyfin lookup and import, plus the helpers the other
//! user write modules share.

use std::future::Future;
use std::pin::Pin;

use axum::http::Method;
use base64::prelude::*;
use serde_json::{Map, Value};

use super::draft::fail_on_err;
use super::{Outcome, Ready, Table};
use crate::auth::CurrentUser;
use crate::db::{Bind, UserRecord, UserSettingsRecord};
use crate::settings::public::truthy;
use crate::typeorm::{self, Changes, USER_HIDDEN_COLUMNS};
use crate::user::filtered_json;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// `Permission.ADMIN` and `MANAGE_USERS`.
pub(super) const ADMIN: i64 = 2;
pub(super) const MANAGE_USERS: i64 = 8;
/// `UserType`.
pub(super) const USER_TYPE_PLEX: i64 = 1;
pub(super) const USER_TYPE_LOCAL: i64 = 2;
const USER_TYPE_JELLYFIN: i64 = 3;
const USER_TYPE_EMBY: i64 = 4;
/// `MediaServerType.JELLYFIN` and `EMBY`.
pub(super) const SERVER_JELLYFIN: i64 = 2;
pub(super) const SERVER_EMBY: i64 = 3;

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/user", Method::POST, create),
    ("/api/v1/user", Method::PUT, bulk_update),
    ("/api/v1/user/{id}", Method::PUT, update),
    ("/api/v1/user/{id}", Method::DELETE, delete),
    (
        "/api/v1/user/registerPushSubscription",
        Method::POST,
        register_push_subscription,
    ),
    ("/api/v1/user/jellyfin/{id}", Method::GET, by_jellyfin_id),
    (
        "/api/v1/user/import-from-jellyfin",
        Method::POST,
        import_from_jellyfin,
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

macro_rules! try_db {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(e) => return Outcome::forward(format!("database: {e:#}")),
        }
    };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// `hasPermission(required, value)` on a stored bitmask.
pub(super) const fn has_permission(value: i64, required: i64) -> bool {
    required == 0 || value & ADMIN != 0 || value & required != 0
}

/// `canMakePermissionsChange`: only the owner may grant admin.
pub(super) const fn can_make_permissions_change(permissions: i64, viewer: &CurrentUser) -> bool {
    !(permissions & ADMIN != 0 && viewer.id != 1)
}

/// `isOwnProfileOrAdmin()`.
pub(super) fn own_or_admin<'a>(
    ctx: &'a Ready<'_>,
    id: i64,
) -> Result<&'a CurrentUser, super::Fallback> {
    let viewer = ctx.authenticated(0)?;
    if viewer.id == id || viewer.has_permission(MANAGE_USERS) {
        Ok(viewer)
    } else {
        Err(super::Fallback::not_own_profile())
    }
}

/// `isOwnProfile()`.
pub(super) fn own_profile<'a>(
    ctx: &'a Ready<'_>,
    id: i64,
) -> Result<&'a CurrentUser, super::Fallback> {
    let viewer = ctx.authenticated(0)?;
    if viewer.id == id {
        Ok(viewer)
    } else {
        Err(super::Fallback::not_own_profile())
    }
}

/// The body as an object.
pub(super) fn body_object<'a>(ctx: &'a Ready<'_>) -> Result<&'a Map<String, Value>, String> {
    match &ctx.body {
        Some(Value::Object(map)) => Ok(map),
        _ => Err(String::from("a body that isn't an object")),
    }
}

/// The JSON kinds a body field may have; anything else is the validator's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Null,
    Text,
    Bool,
    /// A whole number that fits the int32 math Node does on it.
    Int,
    /// Any number.
    Number,
}

impl Kind {
    fn matches(self, v: &Value) -> bool {
        match (self, v) {
            (Self::Null, Value::Null)
            | (Self::Text, Value::String(_))
            | (Self::Bool, Value::Bool(_))
            | (Self::Number, Value::Number(_)) => true,
            (Self::Int, Value::Number(n)) => n
                .as_i64()
                .is_some_and(|n| (0..=i64::from(i32::MAX)).contains(&n)),
            _ => false,
        }
    }
}

/// Every listed field is absent or of one of its kinds.
pub(super) fn check_fields(
    body: &Map<String, Value>,
    fields: &[(&str, &[Kind])],
) -> Result<(), super::Fallback> {
    for (key, kinds) in fields {
        if let Some(v) = body.get(*key) {
            if !kinds.iter().any(|k| k.matches(v)) {
                return Err(super::Fallback::status(
                    400,
                    format!("{key} has an unexpected type."),
                ));
            }
        }
    }
    Ok(())
}

pub(super) fn text(v: Option<&String>) -> Value {
    v.map_or(Value::Null, |s| Value::from(s.as_str()))
}

pub(super) fn int(v: Option<i64>) -> Value {
    v.map_or(Value::Null, Value::from)
}

pub(super) fn flag(v: Option<bool>) -> Value {
    v.map_or(Value::Null, Value::Bool)
}

/// The user's display name as `@AfterLoad` computed it.
fn display_name(user: &UserRecord) -> String {
    [&user.username, &user.plex_username, &user.jellyfin_username]
        .into_iter()
        .find_map(|v| v.as_deref().filter(|s| !s.is_empty()))
        .map_or_else(
            || user.email.as_deref().unwrap_or("").to_lowercase(),
            str::to_owned,
        )
}

/// Load a user with the eager settings, or the 404 Node sends.
pub(super) async fn load_user(
    ctx: &Ready<'_>,
    id: i64,
) -> Result<Result<(UserRecord, Option<UserSettingsRecord>), Outcome>, String> {
    let loaded = ctx
        .state
        .db
        .user_record(id)
        .await
        .map_err(|e| format!("loading the user failed: {e:#}"))?;
    Ok(loaded.ok_or_else(|| ctx.error(404, "User not found.")))
}

/// Drop a user's in-memory media-action sync cache
/// (`invalidateUserSyncCache` / `invalidateUserAnilistSyncCache`).
pub(super) fn invalidate_sync_cache(user_id: i64, provider: &str) {
    match provider {
        "trakt" => crate::mappinglayer::synccache::invalidate_user_sync_cache(user_id),
        "anilist" => crate::mappinglayer::synccache::invalidate_user_anilist_sync_cache(user_id),
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// POST /user
// ---------------------------------------------------------------------------

/// A non-empty string, as `||` picks it.
fn truthy_text(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// `POST /user`: a local user, with a generated password mailed to them
/// unless one was given.
fn create<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        try_forward!(ctx.authenticated(MANAGE_USERS));
        let body = try_forward!(body_object(ctx));
        try_forward!(check_fields(
            body,
            &[
                ("email", &[Kind::Text]),
                ("username", &[Kind::Text]),
                ("permissions", &[Kind::Number]),
                ("password", &[Kind::Text, Kind::Null]),
                ("avatar", &[Kind::Text, Kind::Null]),
            ],
        ));
        // `body.email || body.username`: an empty username is still a
        // string, a missing one makes `email.toLowerCase()` throw.
        let Some(email) =
            truthy_text(body.get("email")).or_else(|| body.get("username").and_then(Value::as_str))
        else {
            return ctx.error(500, "An email or a username is required.");
        };
        let Some(default_permissions) = ctx
            .settings
            .get("/main/defaultPermissions")
            .filter(|v| v.as_i64().is_some())
            .cloned()
        else {
            return Outcome::forward(String::from("defaultPermissions isn't an integer"));
        };
        let existing = try_db!(
            ctx.state
                .db
                .scalar(
                    r#"SELECT COUNT(*) FROM "user" WHERE "email" = ?1"#,
                    &[Bind::Text(email.to_lowercase())],
                )
                .await
        );
        if existing > 0 {
            let mut out = Map::new();
            out.insert(
                String::from("message"),
                Value::from("User already exists with submitted email."),
            );
            out.insert(String::from("errors"), Value::from(vec!["USER_EXISTS"]));
            return ctx.json_with(409, &Value::Object(out));
        }
        if email.is_empty() {
            // `gravatarUrl('')` throws.
            return ctx.error(
                500,
                "Please specify an identifier, such as an email address",
            );
        }
        let explicit = body
            .get("password")
            .and_then(Value::as_str)
            .filter(|p| typeorm::js_length(p) > 0);
        let avatar = body
            .get("avatar")
            .and_then(Value::as_str)
            .map_or_else(|| typeorm::gravatar_url(email), str::to_owned);
        if explicit.is_none() && !truthy(ctx.settings.get("/notifications/agents/email/enabled")) {
            return ctx.error(500, "Email notifications must be enabled");
        }
        let username = body.get("username").and_then(Value::as_str);
        let hash = if let Some(password) = explicit {
            try_forward!(typeorm::hash_password(password.to_owned())
                .await
                .map_err(|e| format!("{e:#}")))
        } else {
            let password = typeorm::nanoid16();
            let hash = try_forward!(typeorm::hash_password(password.clone())
                .await
                .map_err(|e| format!("{e:#}")));
            send_generated_password(ctx, email, username, &password).await;
            hash
        };
        let id = match typeorm::insert(
            &ctx.state.db,
            "user",
            &[
                ("email", Value::from(email.to_lowercase())),
                ("avatar", Value::from(avatar.as_str())),
                ("username", username.map_or(Value::Null, Value::from)),
                ("password", Value::from(hash)),
                ("permissions", default_permissions.clone()),
                ("plexToken", Value::from("")),
                ("userType", Value::from(USER_TYPE_LOCAL)),
            ],
        )
        .await
        {
            Ok(id) => id,
            Err(e) => {
                tracing::error!("creating the user failed: {e:#}");
                return ctx.error(500, &format!("{e:#}"));
            }
        };
        let mut out = Map::new();
        out.insert(String::from("warnings"), Value::Array(Vec::new()));
        out.insert(String::from("permissions"), default_permissions);
        out.insert(String::from("avatar"), Value::from(avatar));
        out.insert(
            String::from("username"),
            username.map_or(Value::Null, Value::from),
        );
        out.insert(String::from("userType"), Value::from(USER_TYPE_LOCAL));
        let early_nulls = [
            "plexUsername",
            "jellyfinUsername",
            "recoveryLinkExpirationDate",
            "jellyfinUserId",
        ];
        match append_created(ctx, &mut out, id, &early_nulls).await {
            Ok(()) => ctx.json_with(201, &Value::Object(out)),
            Err(e) => ctx.error(500, &format!("{e:#}")),
        }
    })
}

/// What `save()` adds to a freshly inserted user: `null` for every nullable
/// column the entity never set (the filtered ones left out), in column
/// order, then the id and the reloaded dates.
pub(super) async fn append_created(
    ctx: &Ready<'_>,
    out: &mut Map<String, Value>,
    id: i64,
    early_nulls: &[&str],
) -> anyhow::Result<()> {
    let db = &ctx.state.db;
    let created_at = typeorm::date_of(db, "user", "createdAt", id).await?;
    let updated_at = typeorm::date_of(db, "user", "updatedAt", id).await?;
    for key in early_nulls {
        out.insert((*key).to_owned(), Value::Null);
    }
    for key in [
        "avatarETag",
        "avatarVersion",
        "movieQuotaLimit",
        "movieQuotaDays",
        "tvQuotaLimit",
        "tvQuotaDays",
    ] {
        out.insert(String::from(key), Value::Null);
    }
    out.insert(String::from("id"), Value::from(id));
    out.insert(String::from("createdAt"), created_at);
    out.insert(String::from("updatedAt"), updated_at);
    Ok(())
}

/// `generatePassword`'s email: the `generatedpassword` template without a
/// logo, greeting the username when there is one.
async fn send_generated_password(
    ctx: &Ready<'_>,
    email: &str,
    username: Option<&str>,
    password: &str,
) {
    tracing::info!("Sending generated password email for {email}");
    let frame = crate::email::Frame {
        application_url: ctx.settings.str("/main/applicationUrl").to_owned(),
        application_title: ctx.settings.str("/main/applicationTitle").to_owned(),
        logo_url: None,
        // `recipientName !== recipientEmail` with no recipientEmail local:
        // a greeting whenever the username is defined.
        recipient_name: username.unwrap_or("").to_owned(),
        recipient_email: if username.is_some() {
            String::from("\u{0}undefined")
        } else {
            String::new()
        },
    };
    let rendered = crate::email::generated_password(&frame, password);
    if let Err(e) = crate::email::send(&ctx.settings, email, &rendered, None).await {
        tracing::error!("Failed to send out generated password email: {e:#}");
    }
}

// ---------------------------------------------------------------------------
// PUT /user, PUT /user/{id}, DELETE /user/{id}
// ---------------------------------------------------------------------------

/// The permissions in a body: an integer, or none, which the save leaves
/// alone and the answer leaves out (`undefined`).
fn permissions_field(body: &Map<String, Value>) -> Result<Option<i64>, super::Fallback> {
    super::params::body_int(body, "permissions")
}

/// `user.permissions` as stored.
pub(super) fn stored_permissions(user: &UserRecord) -> Value {
    Value::from(user.permissions)
}

/// `PUT /user`: the same permissions for many users; each comes back as
/// the saved object, unfiltered.
fn bulk_update<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let viewer = try_forward!(ctx.authenticated(MANAGE_USERS));
        let body = try_forward!(body_object(ctx));
        let permissions = try_forward!(permissions_field(body));
        let raw_ids = match body.get("ids") {
            Some(Value::Array(raw_ids)) => Some(raw_ids),
            None => None,
            Some(_) => return Outcome::forward(String::from("ids isn't an array")),
        };
        let mut ids = Vec::new();
        for id in raw_ids.into_iter().flatten() {
            match id.as_i64() {
                Some(id) => ids.push(id),
                None => return Outcome::forward(String::from("ids aren't integers")),
            }
        }
        // `undefined & ADMIN` is 0.
        if !can_make_permissions_change(permissions.unwrap_or(0), viewer) {
            return ctx.error(
                403,
                "You do not have permission to grant this level of access",
            );
        }
        if raw_ids.is_none() {
            return ctx.error(500, "The request body has no ids.");
        }
        if viewer.id != 1 {
            ids.retain(|id| *id != 1);
        }
        ids.sort_unstable();
        ids.dedup();
        let mut users = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(loaded) = try_db!(ctx.state.db.user_record(id).await) {
                users.push(loaded);
            }
        }
        // By id; Node answers in the order the database returns them.
        let mut out = Vec::with_capacity(users.len());
        for (mut user, settings) in users {
            let mut changes = Changes::default();
            changes.assign(
                "permissions",
                permissions.map(Value::from).as_ref(),
                &stored_permissions(&user),
            );
            let dirty = changes.any();
            if let Some(n) = permissions {
                user.permissions = n;
            }
            if dirty {
                // Earlier users may be saved already: no forwarding now.
                let update = fail_on_err!(
                    ctx,
                    changes
                        .update_sql("user", user.id, true)
                        .map_err(|e| format!("{e:#}"))
                );
                if let Err(e) = typeorm::run(&ctx.state.db, update).await {
                    tracing::error!("updating user {} failed: {e:#}", user.id);
                    return ctx.error(500, &format!("{e:#}"));
                }
                match typeorm::date_of(&ctx.state.db, "user", "updatedAt", user.id).await {
                    Ok(Value::String(at)) => user.updated_at = Some(at),
                    Ok(_) => user.updated_at = None,
                    Err(e) => return ctx.error(500, &format!("{e:#}")),
                }
            }
            let mut json = match filtered_json(&user, Some(settings.as_ref()), true) {
                Ok(Value::Object(map)) => map,
                Ok(_) => Map::new(),
                Err(why) => return ctx.error(500, why),
            };
            if let (Some(Value::Object(s)), Some(record)) =
                (json.get_mut("settings"), settings.as_ref())
            {
                saved_settings_json(s, record);
            }
            if dirty {
                for key in USER_HIDDEN_COLUMNS {
                    json.insert(String::from(key), Value::Null);
                }
            }
            if permissions.is_none() {
                json.shift_remove("permissions");
            }
            out.push(Value::Object(json));
        }
        ctx.json(&Value::Array(out))
    })
}

/// The eager settings object after a cascaded `save()`: the transformer
/// dropped unknown notification agents from it, and when the row compared
/// as changed the hidden columns were set to `null`.
pub(super) fn saved_settings_json(s: &mut Map<String, Value>, record: &UserSettingsRecord) {
    if let Some(Value::Object(types)) = s.get_mut("notificationTypes") {
        typeorm::strip_unknown_agents(types);
    }
    if typeorm::settings_change_by_itself(record) {
        for key in typeorm::SETTINGS_HIDDEN_COLUMNS {
            s.insert(String::from(key), Value::Null);
        }
    }
}

/// `PUT /user/{id}`: username and permissions.
fn update<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let viewer = try_forward!(ctx.authenticated(MANAGE_USERS));
        // A failed lookup lands in the catch-all 404.
        let id = try_forward!(super::params::path_int(ctx, 0));
        let body = try_forward!(body_object(ctx));
        if body.keys().any(|k| k != "username" && k != "permissions") {
            return Outcome::forward(String::from("other User fields are the validator's"));
        }
        try_forward!(check_fields(body, &[("username", &[Kind::Text])]));
        let permissions = try_forward!(permissions_field(body));
        let (mut user, _) = match try_forward!(load_user(ctx, id).await) {
            Ok(loaded) => loaded,
            Err(outcome) => return outcome,
        };
        if user.id == 1 && viewer.id != 1 {
            return ctx.error(403, "You do not have permission to modify this user");
        }
        if !can_make_permissions_change(permissions.unwrap_or(0), viewer) {
            return ctx.error(
                403,
                "You do not have permission to grant this level of access",
            );
        }
        let old_display_name = display_name(&user);
        let username = body.get("username");
        let mut changes = Changes::default();
        changes.assign("username", username, &text(user.username.as_ref()));
        changes.assign(
            "permissions",
            permissions.map(Value::from).as_ref(),
            &stored_permissions(&user),
        );
        let dirty = changes.any();
        if let Some(name) = username.and_then(Value::as_str) {
            user.username = Some(name.to_owned());
        }
        if let Some(n) = permissions {
            user.permissions = n;
        }
        if dirty {
            let update = try_forward!(changes
                .update_sql("user", user.id, true)
                .map_err(|e| format!("{e:#}")));
            if let Err(e) = typeorm::run(&ctx.state.db, update).await {
                // The save throws; the catch-all answers 404.
                tracing::debug!("updating the user failed: {e:#}");
                return ctx.error(404, "User not found.");
            }
            match typeorm::date_of(&ctx.state.db, "user", "updatedAt", user.id).await {
                Ok(Value::String(at)) => user.updated_at = Some(at),
                Ok(_) => user.updated_at = None,
                Err(_) => return ctx.error(404, "User not found."),
            }
        }
        let Ok(Value::Object(mut json)) = filtered_json(&user, None, false) else {
            return ctx.error(404, "User not found.");
        };
        json.insert(String::from("displayName"), Value::from(old_display_name));
        if username.is_none() {
            if dirty {
                json.insert(String::from("username"), Value::Null);
            } else {
                json.shift_remove("username");
            }
        }
        // The non-nullable column stays `undefined` either way.
        if permissions.is_none() {
            json.shift_remove("permissions");
        }
        ctx.json(&Value::Object(json))
    })
}

/// `DELETE /user/{id}`. Users with requests go to Node, which removes each
/// request through its entity hooks first.
fn delete<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let viewer = try_forward!(ctx.authenticated(MANAGE_USERS));
        let id = try_forward!(super::params::path_int(ctx, 0));
        let (user, _) = match try_forward!(load_user(ctx, id).await) {
            Ok(loaded) => loaded,
            Err(outcome) => return outcome,
        };
        if user.id == 1 {
            return ctx.error(405, "This account cannot be deleted.");
        }
        if has_permission(user.permissions, ADMIN) && viewer.id != 1 {
            return ctx.error(
                405,
                "You cannot delete users with administrative privileges.",
            );
        }
        let Ok(Value::Object(mut json)) = filtered_json(&user, None, false) else {
            return Outcome::forward(String::from("a stored value of an unexpected shape"));
        };
        let requests = match remove_requests(ctx, user.id).await {
            Ok(requests) => requests,
            Err(e) => {
                tracing::error!("Something went wrong deleting a user: {e:#}");
                return ctx.error(500, "Something went wrong deleting the user");
            }
        };
        if let Err(e) = ctx
            .state
            .db
            .execute(
                r#"DELETE FROM "user" WHERE "id" = ?1"#,
                &[Bind::Int(user.id)],
            )
            .await
        {
            tracing::error!("Something went wrong deleting a user: {e:#}");
            return ctx.error(500, "Something went wrong deleting the user");
        }
        let count = json
            .shift_remove("requestCount")
            .unwrap_or_else(|| Value::from(0));
        json.insert(String::from("requests"), Value::Array(requests));
        json.insert(String::from("requestCount"), count);
        ctx.json(&Value::Object(json))
    })
}

/// `requestRepository.remove(user.requests)`: every request of the user
/// deleted, then each one's `afterRemove`, all in one transaction.
///
/// The requests come back as the response prints them: loaded with their
/// eager relations, without the ids `remove()` drops.
async fn remove_requests(ctx: &Ready<'_>, user_id: i64) -> anyhow::Result<Vec<Value>> {
    let rows = ctx
        .state
        .db
        .rows(
            r#"SELECT CAST("id" AS BIGINT) AS "id" FROM "media_request" WHERE "requestedById" = ?1 ORDER BY "id" ASC"#,
            &[Bind::Int(user_id)],
        )
        .await?;
    let lc = super::requestedit::lc(ctx);
    let mut entities = Vec::with_capacity(rows.len());
    let mut printed = Vec::with_capacity(rows.len());
    for id in rows
        .iter()
        .filter_map(|r| r.get("id").and_then(Value::as_i64))
    {
        let Some(e) = lc.load(id).await? else {
            continue;
        };
        let Some(requested_by) = e.requested_by.clone() else {
            continue;
        };
        let mut json = super::requestedit::loaded_json(ctx, &e, &requested_by)
            .await
            .map_err(anyhow::Error::msg)?;
        json.shift_remove("id");
        // Loaded as a relation of the user, the request's own relations
        // come without theirs (no media seasons, no user settings).
        if let Some(Value::Object(media)) = json.get_mut("media") {
            media.shift_remove("seasons");
        }
        for key in ["requestedBy", "modifiedBy"] {
            if let Some(Value::Object(user)) = json.get_mut(key) {
                user.shift_remove("settings");
            }
        }
        printed.push(Value::Object(json));
        entities.push(e);
    }
    let removed: Vec<i64> = entities.iter().map(|e| e.row.id).collect();
    let mut hooks = Vec::new();
    for e in &entities {
        hooks.extend(crate::lifecycle::after_remove(&ctx.state.db, e, &removed).await?);
    }
    let mut tx = crate::jobs::syncutil::Tx::begin(&ctx.state.db).await?;
    for e in &entities {
        tx.execute(
            r#"DELETE FROM "media_request" WHERE "id" = ?1"#,
            &[Bind::Int(e.row.id)],
        )
        .await?;
    }
    for (sql, binds) in &hooks {
        tx.execute(sql, binds).await?;
    }
    tx.commit().await?;
    Ok(printed)
}

// ---------------------------------------------------------------------------
// POST /user/registerPushSubscription
// ---------------------------------------------------------------------------

/// `POST /user/registerPushSubscription`.
fn register_push_subscription<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let viewer = try_forward!(ctx.authenticated(0));
        let body = try_forward!(body_object(ctx));
        let field = |k: &str| body.get(k).and_then(Value::as_str);
        let (Some(endpoint), Some(auth), Some(p256dh)) =
            (field("endpoint"), field("auth"), field("p256dh"))
        else {
            return Outcome::forward(String::from("required fields are the validator's"));
        };
        try_forward!(check_fields(body, &[("userAgent", &[Kind::Text])]));
        let user_agent = body.get("userAgent");
        let fields = (endpoint, auth, p256dh, user_agent);
        match register_in_transaction(&ctx.state.db, viewer.id, fields).await {
            Ok(()) => Ready::no_content(),
            Err(e) => {
                tracing::error!("Failed to register user push subscription: {e:#}");
                ctx.error(500, "Failed to register subscription.")
            }
        }
    })
}

/// The handler's `dataSource.transaction(...)`: the lookup by endpoint,
/// then the key refresh or the new subscription, on one transaction so
/// two registrations can't both pass the checks.
async fn register_in_transaction(
    db: &crate::db::Db,
    user_id: i64,
    (endpoint, auth, p256dh, user_agent): (&str, &str, &str, Option<&Value>),
) -> anyhow::Result<()> {
    let mut tx = crate::jobs::syncutil::Tx::begin(db).await?;
    let existing = tx
        .rows(
            r#"SELECT CAST("id" AS BIGINT) AS "id", "auth", "p256dh", "userAgent" FROM "user_push_subscription" WHERE "endpoint" = ?1 AND "userId" = ?2 ORDER BY "id" ASC LIMIT 1"#,
            &[Bind::Text(endpoint.to_owned()), Bind::Int(user_id)],
        )
        .await?;
    if let Some(row) = existing.first() {
        if row.get("auth").and_then(Value::as_str) == Some(auth) {
            tracing::debug!("Duplicate subscription detected. Skipping registration.");
        } else {
            let mut changes = Changes::default();
            let null = Value::Null;
            changes.assign(
                "auth",
                Some(&Value::from(auth)),
                row.get("auth").unwrap_or(&null),
            );
            changes.assign(
                "p256dh",
                Some(&Value::from(p256dh)),
                row.get("p256dh").unwrap_or(&null),
            );
            changes.assign(
                "userAgent",
                user_agent,
                row.get("userAgent").unwrap_or(&null),
            );
            let row_id = row.get("id").and_then(Value::as_i64).unwrap_or(0);
            if let Some((sql, binds)) =
                changes.update_sql("user_push_subscription", row_id, false)?
            {
                tx.execute(&sql, &binds).await?;
            }
            tracing::debug!("Updated existing push subscription with new keys for same endpoint.");
        }
    } else {
        if !auth.is_empty() {
            let removed = tx
                .execute(
                    r#"DELETE FROM "user_push_subscription" WHERE "userId" = ?1 AND "auth" = ?2 AND "endpoint" != ?3"#,
                    &[
                        Bind::Int(user_id),
                        Bind::Text(auth.to_owned()),
                        Bind::Text(endpoint.to_owned()),
                    ],
                )
                .await?;
            if removed > 0 {
                tracing::debug!("Removed {removed} stale push subscription(s) from same device.");
            }
        }
        crate::dbtx::insert(
            &mut crate::dbtx::Exec::Tx(&mut tx),
            "user_push_subscription",
            &[
                ("endpoint", Value::from(endpoint)),
                ("p256dh", Value::from(p256dh)),
                ("auth", Value::from(auth)),
                ("userAgent", user_agent.cloned().unwrap_or(Value::Null)),
                ("userId", Value::from(user_id)),
            ],
        )
        .await?;
    }
    tx.commit().await
}

// ---------------------------------------------------------------------------
// GET /user/jellyfin/{id}, POST /user/import-from-jellyfin
// ---------------------------------------------------------------------------

/// `normalizeJellyfinGuid`: 32 hex digits once dashes are gone.
pub(super) fn normalize_jellyfin_guid(value: &str) -> Option<String> {
    let normalized: String = value
        .chars()
        .filter(|c| *c != '-')
        .collect::<String>()
        .to_lowercase();
    (normalized.len() == 32 && normalized.bytes().all(|b| b.is_ascii_hexdigit()))
        .then_some(normalized)
}

/// `GET /user/jellyfin/{jellyfinUserId}`.
fn by_jellyfin_id<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let viewer = try_forward!(ctx.authenticated(0));
        let raw = ctx.req.uri.path().rsplit('/').next().unwrap_or("");
        let Some(decoded) = super::nodestate::decode_segment(raw) else {
            return Outcome::forward(String::from("a path segment Express can't decode"));
        };
        let Some(guid) = normalize_jellyfin_guid(&decoded) else {
            return ctx.error(400, "Invalid Jellyfin User ID.");
        };
        let rows = try_db!(
            ctx.state
                .db
                .rows(
                    r#"SELECT CAST("id" AS BIGINT) AS "id" FROM "user" WHERE "jellyfinUserId" = ?1"#,
                    &[Bind::Text(guid)],
                )
                .await
        );
        let id = match rows.as_slice() {
            [] => return ctx.error(404, "User not found."),
            [row] => row.get("id").and_then(Value::as_i64).unwrap_or(0),
            _ => return Outcome::forward(String::from("several users share the Jellyfin id")),
        };
        let (user, settings) = match try_forward!(load_user(ctx, id).await) {
            Ok(loaded) => loaded,
            Err(outcome) => return outcome,
        };
        match filtered_json(
            &user,
            Some(settings.as_ref()),
            viewer.has_permission(MANAGE_USERS),
        ) {
            Ok(body) => ctx.json(&body),
            Err(why) => Outcome::forward(why.to_owned()),
        }
    })
}

/// `getHostname()` for the Jellyfin settings, as the template literal
/// prints each part.
pub(super) fn jellyfin_hostname(ctx: &Ready<'_>) -> String {
    let part =
        |p: &str| crate::media::js_string(ctx.settings.get(&format!("/jellyfin/{p}"))).into_owned();
    format!(
        "{}://{}:{}{}",
        if truthy(ctx.settings.get("/jellyfin/useSsl")) {
            "https"
        } else {
            "http"
        },
        part("ip"),
        part("port"),
        part("urlBase")
    )
}

/// `buildJellyfinAuthorizationHeader`.
pub(super) fn jellyfin_authorization(
    ctx: &Ready<'_>,
    token: Option<&str>,
    device_id: Option<&str>,
) -> String {
    let device = device_id
        .filter(|d| !d.is_empty())
        .map_or_else(|| BASE64_STANDARD.encode("BOT_seerr"), str::to_owned);
    let version = if ctx
        .settings
        .get("/main/mediaServerType")
        .and_then(Value::as_i64)
        == Some(SERVER_EMBY)
    {
        String::from("1.0.0")
    } else {
        ctx.state.version.version.clone()
    };
    let mut header = format!(
        "MediaBrowser Client=\"Foreseerr\", Device=\"Foreseerr\", DeviceId=\"{device}\", Version=\"{version}\""
    );
    if let Some(token) = token.filter(|t| !t.is_empty()) {
        header.push_str(", Token=\"");
        header.push_str(token);
        header.push('"');
    }
    header
}

/// One Jellyfin user `import-from-jellyfin` will create.
struct Import {
    name: String,
    jellyfin_id: String,
}

/// `POST /user/import-from-jellyfin`.
fn import_from_jellyfin<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        try_forward!(ctx.authenticated(MANAGE_USERS));
        let body = try_forward!(body_object(ctx));
        let Some(Value::Array(raw_ids)) = body.get("jellyfinUserIds") else {
            return Outcome::forward(String::from("jellyfinUserIds isn't an array"));
        };
        let Some(raw_ids) = raw_ids
            .iter()
            .map(Value::as_str)
            .collect::<Option<Vec<&str>>>()
        else {
            return Outcome::forward(String::from("jellyfinUserIds aren't strings"));
        };
        let Some(default_permissions) = ctx
            .settings
            .get("/main/defaultPermissions")
            .filter(|v| v.as_i64().is_some())
            .cloned()
        else {
            return Outcome::forward(String::from("defaultPermissions isn't an integer"));
        };
        let admin = try_db!(
            ctx.state
                .db
                .rows(
                    r#"SELECT "jellyfinDeviceId", "jellyfinUserId" FROM "user" WHERE "id" = 1"#,
                    &[],
                )
                .await
        );
        let Some(admin) = admin.first() else {
            return Outcome::forward(String::from("no user 1; findOneOrFail throws"));
        };
        let device = admin.get("jellyfinDeviceId").and_then(Value::as_str);
        let api_key = ctx.settings.str("/jellyfin/apiKey").to_owned();
        let users = match jellyfin_users(ctx, &api_key, device).await {
            Ok(users) => users,
            Err(e) => {
                tracing::error!(
                    "Something went wrong while getting the account from the Jellyfin server: {e:#}"
                );
                return ctx.error(500, "");
            }
        };
        let imports = try_forward!(plan_imports(ctx, &raw_ids, &users).await);
        let user_type = if ctx
            .settings
            .get("/main/mediaServerType")
            .and_then(Value::as_i64)
            == Some(SERVER_JELLYFIN)
        {
            USER_TYPE_JELLYFIN
        } else {
            USER_TYPE_EMBY
        };
        let mut created = Vec::with_capacity(imports.len());
        for import in imports {
            let avatar = format!("/avatarproxy/{}", import.jellyfin_id);
            let id = match typeorm::insert(
                &ctx.state.db,
                "user",
                &[
                    ("email", Value::from(import.name.to_lowercase())),
                    ("jellyfinUsername", Value::from(import.name.as_str())),
                    ("jellyfinUserId", Value::from(import.jellyfin_id.as_str())),
                    (
                        "jellyfinDeviceId",
                        Value::from(BASE64_STANDARD.encode(format!("BOT_seerr_{}", import.name))),
                    ),
                    ("permissions", default_permissions.clone()),
                    ("avatar", Value::from(avatar.as_str())),
                    ("userType", Value::from(user_type)),
                ],
            )
            .await
            {
                Ok(id) => id,
                // The users saved before stay; the catch answers 500.
                Err(e) => return ctx.error(500, &crate::db::failure_message(&e)),
            };
            let mut out = Map::new();
            out.insert(String::from("warnings"), Value::Array(Vec::new()));
            out.insert(String::from("permissions"), default_permissions.clone());
            out.insert(String::from("jellyfinUsername"), Value::from(import.name));
            out.insert(
                String::from("jellyfinUserId"),
                Value::from(import.jellyfin_id),
            );
            out.insert(String::from("avatar"), Value::from(avatar));
            out.insert(String::from("userType"), Value::from(user_type));
            if let Err(e) = append_created(
                ctx,
                &mut out,
                id,
                &["plexUsername", "username", "recoveryLinkExpirationDate"],
            )
            .await
            {
                return ctx.error(500, &format!("{e:#}"));
            }
            created.push(Value::Object(out));
        }
        ctx.json_with(201, &Value::Array(created))
    })
}

/// `jellyfinClient.getUsers()`: `GET /Users` with the admin's device and
/// the server API key.
async fn jellyfin_users(
    ctx: &Ready<'_>,
    api_key: &str,
    device: Option<&str>,
) -> anyhow::Result<Vec<Value>> {
    let url = format!("{}/Users", jellyfin_hostname(ctx));
    let res = ctx
        .state
        .outbound
        .get(url)
        .header(
            "Authorization",
            jellyfin_authorization(ctx, Some(api_key), device),
        )
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .send()
        .await?
        .error_for_status()?;
    match res.json::<Value>().await? {
        Value::Array(users) => Ok(users),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) | Value::Object(_) => {
            Err(anyhow::anyhow!("/Users didn't answer with a list"))
        }
    }
}

/// Which body ids become new users, or why Node should do it (a missing
/// Jellyfin user, an email that would collide, an id stored unnormalized).
async fn plan_imports(
    ctx: &Ready<'_>,
    raw_ids: &[&str],
    users: &[Value],
) -> Result<Vec<Import>, String> {
    let mut by_id: Vec<(String, &Value)> = Vec::new();
    for user in users {
        let Some(id) = user.get("Id").and_then(Value::as_str) else {
            return Err(String::from("a Jellyfin user without an Id"));
        };
        if let Some(guid) = normalize_jellyfin_guid(id) {
            by_id.retain(|(g, _)| *g != guid);
            by_id.push((guid, user));
        }
    }
    let mut imports: Vec<Import> = Vec::new();
    for raw in raw_ids {
        let Some(guid) = normalize_jellyfin_guid(raw) else {
            continue;
        };
        if imports.iter().any(|i| i.jellyfin_id == guid) {
            continue;
        }
        let exists = ctx
            .state
            .db
            .scalar(
                r#"SELECT COUNT(*) FROM "user" WHERE "jellyfinUserId" = ?1"#,
                &[Bind::Text(guid.clone())],
            )
            .await
            .map_err(|e| format!("database: {e:#}"))?;
        if exists > 0 {
            continue;
        }
        let Some((_, user)) = by_id.iter().find(|(g, _)| *g == guid) else {
            return Err(String::from("an id Jellyfin doesn't list"));
        };
        let (Some(name), Some(id)) = (
            user.get("Name").and_then(Value::as_str),
            user.get("Id").and_then(Value::as_str),
        ) else {
            return Err(String::from("a Jellyfin user without a name"));
        };
        if id != guid {
            return Err(String::from("a Jellyfin id that isn't normalized"));
        }
        // A taken email fails that user's insert, after the ones before it.
        imports.push(Import {
            name: name.to_owned(),
            jellyfin_id: id.to_owned(),
        });
    }
    Ok(imports)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_route_registers() {
        let mut paths: Vec<&str> = crate::routes::ROUTES.iter().map(|(p, _)| *p).collect();
        paths.extend(crate::routes::SETTINGS_SECTIONS.iter().map(|(p, _)| *p));
        for table in crate::routes::TABLES {
            paths.extend(table.iter().map(|(p, _, _)| *p));
        }
        paths.sort_unstable();
        paths.dedup();
        let mut router: axum::Router = axum::Router::new();
        for path in paths {
            router = router.route(path, axum::routing::get(|| async {}));
        }
        drop(router);
    }

    #[test]
    fn jellyfin_guids() {
        assert_eq!(
            normalize_jellyfin_guid("0123456789AB-cdef0123456789abcdef"),
            Some(String::from("0123456789abcdef0123456789abcdef")),
            "dashes and case"
        );
        assert_eq!(normalize_jellyfin_guid("xyz"), None, "not hex");
        assert_eq!(normalize_jellyfin_guid(""), None, "empty");
    }

    #[test]
    fn permission_rules() {
        let viewer = |id| CurrentUser {
            id,
            permissions: 2,
            webpush_enabled: true,
            locale: None,
        };
        assert!(
            !can_make_permissions_change(2, &viewer(5)),
            "only the owner grants admin"
        );
        assert!(can_make_permissions_change(2, &viewer(1)), "owner");
        assert!(
            can_make_permissions_change(32, &viewer(5)),
            "non-admin bits"
        );
        assert!(has_permission(2, MANAGE_USERS), "admin has everything");
        assert!(!has_permission(32, MANAGE_USERS), "missing bit");
    }

    #[test]
    fn field_kinds() {
        let body = serde_json::json!({"a": 1, "b": "x", "c": 1.5});
        let body = body.as_object().cloned().unwrap_or_default();
        assert!(
            check_fields(&body, &[("a", &[Kind::Int]), ("b", &[Kind::Text])]).is_ok(),
            "kinds match"
        );
        assert!(
            check_fields(&body, &[("c", &[Kind::Int])]).is_err(),
            "a float isn't an int"
        );
        assert!(
            check_fields(&body, &[("z", &[Kind::Int])]).is_ok(),
            "absent is fine"
        );
    }
}
