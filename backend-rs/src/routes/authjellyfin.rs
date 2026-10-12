//! `POST /auth/jellyfin` (with the first-admin setup it doubles as),
//! `POST /auth/jellyfin/plugin`, the three Quick Connect routes, and the
//! Jellyfin device cleanup `POST /auth/logout` does.

use axum::http::Method;
use serde_json::{Map, Value};

use super::authcommon::{
    assign, authorization, avatar_check, avatar_url, base64, client_ip, client_version,
    current_type, default_permissions, error_body, finish, hidden_columns, hostname_of, js_int,
    js_length, media_server_type, prop, settings_hostname, signed_in, start_jobs, update_user,
    user_count, CallError, Entity, Jellyfin, Native, NewUser, Step, EMBY, JELLYFIN, NOT_CONFIGURED,
    USER_EMBY, USER_JELLYFIN,
};
use super::{Outcome, Ready, Table, ADMIN};
use crate::db::Bind;
use crate::settings::public::truthy;

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/auth/jellyfin", Method::POST, jellyfin),
    ("/api/v1/auth/jellyfin/plugin", Method::POST, plugin),
    (
        "/api/v1/auth/jellyfin/quickconnect/initiate",
        Method::POST,
        quickconnect_initiate,
    ),
    (
        "/api/v1/auth/jellyfin/quickconnect/check",
        Method::GET,
        quickconnect_check,
    ),
    (
        "/api/v1/auth/jellyfin/quickconnect/authenticate",
        Method::POST,
        quickconnect_authenticate,
    ),
];

/// An `ApiError`: status and `ApiErrorCode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ApiError {
    status: u16,
    code: &'static str,
}

const INVALID_URL: &str = "INVALID_URL";
const INVALID_CREDENTIALS: &str = "INVALID_CREDENTIALS";
const INVALID_AUTH_TOKEN: &str = "INVALID_AUTH_TOKEN";
const NOT_ADMIN: &str = "NOT_ADMIN";
const NO_ADMIN_USER: &str = "NO_ADMIN_USER";
const CONNECTION_ERROR: &str = "CONNECTION_ERROR";
const UNKNOWN: &str = "UNKNOWN";

/// What the `/auth/jellyfin` handler's catch answers for an error: the
/// known codes keep their status, everything else is a 500.
fn caught(ctx: &Ready<'_>, error: Option<ApiError>, why: &str) -> Outcome {
    match error {
        Some(e)
            if matches!(
                e.code,
                INVALID_URL | CONNECTION_ERROR | INVALID_CREDENTIALS | NOT_ADMIN | NO_ADMIN_USER
            ) =>
        {
            tracing::warn!("Jellyfin sign-in failed: {} ({why})", e.code);
            ctx.error(e.status, e.code)
        }
        Some(_) | None => {
            tracing::error!("{why}");
            ctx.error(500, "Something went wrong.")
        }
    }
}

/// An `ApiError` from a failed `JellyfinAPI` call: no response is a 502
/// `CONNECTION_ERROR`, a status keeps the method's code.
const fn api_error(e: &CallError, code: &'static str) -> ApiError {
    match e {
        CallError::NoResponse(_) => ApiError {
            status: 502,
            code: CONNECTION_ERROR,
        },
        CallError::Status(status) => ApiError {
            status: *status,
            code,
        },
    }
}

/// `jellyfinserver.login(username, password, clientIp)`: once with
/// `X-Forwarded-For`, then once without unless the first answer settles it.
async fn login(
    jf: &Jellyfin<'_>,
    username: &str,
    password: &str,
    client_ip: &str,
) -> Result<Value, ApiError> {
    let mut body = Map::new();
    body.insert(String::from("Username"), Value::from(username));
    body.insert(String::from("Pw"), Value::from(password));
    let body = Value::Object(body);
    let first = jf
        .call(
            Method::POST,
            "/Users/AuthenticateByName",
            Some(&body),
            &[("X-Forwarded-For", client_ip)],
        )
        .await;
    match first {
        Ok(data) => return Ok(data),
        Err(CallError::NoResponse(_)) => {
            return Err(ApiError {
                status: 404,
                code: INVALID_URL,
            })
        }
        Err(CallError::Status(401)) => {
            return Err(ApiError {
                status: 401,
                code: INVALID_CREDENTIALS,
            })
        }
        Err(CallError::Status(_)) => {}
    }
    match jf
        .call(Method::POST, "/Users/AuthenticateByName", Some(&body), &[])
        .await
    {
        Ok(data) => Ok(data),
        Err(CallError::Status(401)) => Err(ApiError {
            status: 401,
            code: INVALID_CREDENTIALS,
        }),
        Err(e) => {
            tracing::error!(
                "Something went wrong while authenticating with the Jellyfin server: {e:?}"
            );
            Err(api_error(&e, UNKNOWN))
        }
    }
}

/// The parts of a `JellyfinLoginResponse` the handlers read.
#[derive(Debug, Clone)]
struct Account {
    id: String,
    name: String,
    /// `User.Policy.IsAdministrator === false`.
    not_admin: bool,
    server_id: Option<Value>,
    access_token: String,
}

/// The login answer in the shape Node's handler expects, or `None`.
fn parse_account(data: &Value) -> Option<Account> {
    let user = data.get("User")?.as_object()?;
    let policy = user.get("Policy")?.as_object()?;
    Some(Account {
        id: user
            .get("Id")?
            .as_str()
            .filter(|s| !s.is_empty())?
            .to_owned(),
        name: user.get("Name")?.as_str()?.to_owned(),
        not_admin: policy.get("IsAdministrator") == Some(&Value::Bool(false)),
        server_id: user.get("ServerId").cloned(),
        access_token: data.get("AccessToken")?.as_str()?.to_owned(),
    })
}

/// The validated `/auth/jellyfin` body.
#[derive(Debug, Clone)]
struct LoginBody {
    username: String,
    password: String,
    hostname: Option<String>,
    email: Option<String>,
    /// `serverType` when it is a whole number.
    server_type: Option<i64>,
    port: Option<Value>,
    url_base: Option<Value>,
    use_ssl: Option<Value>,
}

/// The body as the `OpenAPI` validator lets it through, with the
/// unvalidated `port`, `urlBase` and `useSsl` in the shapes the UI sends.
fn login_body(ctx: &Ready<'_>) -> Result<LoginBody, String> {
    let Some(Value::Object(body)) = &ctx.body else {
        return Err(String::from("a body that isn't an object"));
    };
    let string = |key: &str, required: bool| match body.get(key) {
        Some(Value::String(s)) => Ok(Some(s.clone())),
        None if !required => Ok(None),
        _ => Err(format!("{key} is the validator's")),
    };
    let server_type = match body.get("serverType") {
        None => None,
        Some(v @ Value::Number(_)) => js_int(v),
        Some(_) => return Err(String::from("serverType is the validator's")),
    };
    // Kept as sent (a number, or the text of the setup form's field), as
    // Node keeps `body.port`.
    let port = match body.get("port") {
        None => None,
        Some(v @ Value::Number(n)) if n.is_i64() => Some(v.clone()),
        Some(v @ Value::String(_)) => Some(v.clone()),
        Some(_) => return Err(String::from("an unusual port")),
    };
    let url_base = match body.get("urlBase") {
        None => None,
        Some(v @ Value::String(_)) => Some(v.clone()),
        Some(_) => return Err(String::from("an unusual urlBase")),
    };
    let use_ssl = match body.get("useSsl") {
        None => None,
        Some(v @ Value::Bool(_)) => Some(v.clone()),
        Some(_) => return Err(String::from("an unusual useSsl")),
    };
    Ok(LoginBody {
        username: string("username", true)?.unwrap_or_default(),
        password: string("password", true)?.unwrap_or_default(),
        hostname: string("hostname", false)?,
        email: string("email", false)?,
        server_type,
        port,
        url_base,
        use_ssl,
    })
}

fn jellyfin<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move { finish(login_route(ctx).await) })
}

/// `POST /auth/jellyfin`.
async fn login_route(ctx: &Ready<'_>) -> Step {
    ctx.no_query()?;
    let body = login_body(ctx)?;
    let server_type = media_server_type(ctx)?;
    if server_type != NOT_CONFIGURED
        && (ctx.settings.get("/main/mediaServerLogin") == Some(&Value::Bool(false))
            || (server_type != JELLYFIN && server_type != EMBY))
    {
        return Ok(error_body(ctx, 500, "Jellyfin login is disabled"));
    }
    let ip_configured = ctx.settings.get("/jellyfin/ip") != Some(&Value::String(String::new()));
    let hostname_given = body.hostname.as_deref().is_some_and(|h| !h.is_empty());
    if body.username.is_empty() {
        return Ok(error_body(ctx, 500, "You must provide an username"));
    } else if ip_configured && hostname_given {
        return Ok(error_body(ctx, 500, "Jellyfin hostname already configured"));
    } else if !ip_configured && !hostname_given {
        return Ok(error_body(ctx, 500, "No hostname provided."));
    }
    let hostname = if ip_configured {
        settings_hostname(ctx)
    } else {
        hostname_of(
            body.use_ssl.as_ref(),
            body.hostname.clone().map(Value::from).as_ref(),
            body.port.as_ref(),
            body.url_base.as_ref(),
        )
    };
    let device_id = device_for(ctx, &body.username).await?;
    let ip = client_ip(ctx)?;
    let client_ip = match ip.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(_)) => ip,
        _ => ip
            .strip_prefix("::ffff:")
            .map_or_else(|| ip.clone(), str::to_owned),
    };
    let version = client_version(ctx, current_type(ctx));
    let server = Jellyfin::new(
        &ctx.state.outbound,
        &hostname,
        authorization(None, Some(&device_id), &version),
        crate::runtime::jellyfin_timeout(),
    );
    let data = match login(&server, &body.username, &body.password, &client_ip).await {
        Ok(data) => data,
        Err(e) => return Ok(caught(ctx, Some(e), "Jellyfin login failed")),
    };
    let Some(account) = parse_account(&data) else {
        return Err(String::from("a Jellyfin login answer of another shape").into());
    };
    let flow = Flow {
        ctx,
        body: &body,
        account: &account,
        device_id: &device_id,
        hostname: &hostname,
        server: &server,
        server_type,
    };
    flow.run().await
}

/// The device id the handler logs in with: the admin's is always
/// `BOT_seerr`, a known user keeps theirs, others get one from their name.
async fn device_for(ctx: &Ready<'_>, username: &str) -> Result<String, String> {
    let rows = ctx
        .state
        .db
        .rows(
            r#"SELECT CAST("id" AS BIGINT) AS "id", "jellyfinDeviceId" FROM "user" WHERE "jellyfinUsername" = ?1 ORDER BY "id" ASC LIMIT 1"#,
            &[Bind::Text(username.to_owned())],
        )
        .await
        .map_err(|e| format!("database: {e:#}"))?;
    let row = rows.first();
    let id = row.and_then(|r| r.get("id")).and_then(Value::as_i64);
    let known = row
        .and_then(|r| r.get("jellyfinDeviceId"))
        .and_then(Value::as_str)
        .filter(|d| !d.is_empty());
    Ok(match (id, known) {
        (Some(1), _) => String::from("BOT_seerr"),
        (Some(_), Some(device)) => device.to_owned(),
        _ => base64(&format!("BOT_seerr_{username}")),
    })
}

/// The id of the user linked to a Jellyfin account, as `findOne` picks it.
async fn linked_user(ctx: &Ready<'_>, jellyfin_user_id: &str) -> anyhow::Result<Option<i64>> {
    Ok(ctx
        .state
        .db
        .rows(
            r#"SELECT CAST("id" AS BIGINT) AS "id" FROM "user" WHERE "jellyfinUserId" = ?1 ORDER BY "id" ASC LIMIT 1"#,
            &[Bind::Text(jellyfin_user_id.to_owned())],
        )
        .await?
        .first()
        .and_then(|r| r.get("id"))
        .and_then(Value::as_i64))
}

/// What a sign-in branch decided: the entity (with the properties the
/// handler's copy holds stale, if any), or an answer.
type Branch = Result<(Entity, Option<Map<String, Value>>), Outcome>;

/// Everything after a successful `/auth/jellyfin` login.
struct Flow<'r, 'a> {
    ctx: &'r Ready<'a>,
    body: &'r LoginBody,
    account: &'r Account,
    device_id: &'r str,
    hostname: &'r str,
    server: &'r Jellyfin<'r>,
    server_type: i64,
}

impl Flow<'_, '_> {
    async fn run(&self) -> Step {
        let ctx = self.ctx;
        let db = &ctx.state.db;
        let db_err = |e: anyhow::Error| format!("database: {e:#}");
        let user = match linked_user(ctx, &self.account.id).await.map_err(db_err)? {
            Some(id) => Some((
                id,
                Entity::find(db, id)
                    .await
                    .map_err(db_err)??
                    .ok_or_else(|| String::from("the user vanished"))?,
            )),
            None => None,
        };
        let missing_admin = user.is_none() && user_count(db).await.map_err(db_err)? == 0;
        let branch = if missing_admin || self.server_type == NOT_CONFIGURED {
            self.setup(missing_admin).await?
        } else if let Some((id, entity)) = user {
            self.refresh(id, entity).await?
        } else if !truthy(ctx.settings.get("/main/newPlexLogin")) {
            tracing::warn!(
                "Failed sign-in attempt by unimported Jellyfin user with access to the media server"
            );
            Err(ctx.error(403, "Access denied."))
        } else {
            self.create().await?
        };
        match branch {
            Ok((entity, overrides)) => finish_login(ctx, entity, overrides).await,
            Err(outcome) => Ok(outcome),
        }
    }

    /// The first sign-in: the Jellyfin administrator becomes (or replaces)
    /// user 1, an API key is made, and the server is saved to settings.
    async fn setup(&self, missing_admin: bool) -> Result<Branch, String> {
        let ctx = self.ctx;
        let account = self.account;
        if account.not_admin {
            let e = ApiError {
                status: 403,
                code: NOT_ADMIN,
            };
            return Ok(Err(caught(ctx, Some(e), "not an administrator")));
        }
        let Some(server_type) = self
            .body
            .server_type
            .filter(|t| *t == JELLYFIN || *t == EMBY)
        else {
            let e = ApiError {
                status: 500,
                code: NO_ADMIN_USER,
            };
            return Ok(Err(caught(ctx, Some(e), "no admin user")));
        };
        let user_type = if server_type == JELLYFIN {
            USER_JELLYFIN
        } else {
            USER_EMBY
        };
        let email = self
            .body
            .email
            .clone()
            .filter(|e| !e.is_empty())
            .unwrap_or_else(|| account.name.clone());
        let saved = if missing_admin {
            tracing::info!("Sign-in attempt from Jellyfin user with access to the media server; creating initial admin user for Foreseerr");
            NewUser {
                id: Some(1),
                email: Some(email),
                jellyfin_username: Some(account.name.clone()),
                jellyfin_user_id: Some(account.id.clone()),
                jellyfin_device_id: Some(self.device_id.to_owned()),
                jellyfin_auth_token: Some(account.access_token.clone()),
                permissions: ADMIN,
                user_type,
                avatar: avatar_url(Some(&Value::from(account.id.as_str())), None),
                ..NewUser::default()
            }
            .insert(&ctx.state.db)
            .await
        } else {
            tracing::info!("Sign-in attempt from Jellyfin user with access to the media server; editing admin user for Foreseerr");
            self.edit_admin(email, user_type).await?
        };
        let entity = match saved {
            Ok(entity) => entity,
            Err(e) => return Ok(Err(caught(ctx, None, &format!("{e:#}")))),
        };
        Ok(match self.save_server(server_type).await {
            Ok(()) => Ok((entity, None)),
            Err(outcome) => Err(outcome),
        })
    }

    /// Settings exist without a media server: user 1 takes the account.
    async fn edit_admin(
        &self,
        email: String,
        user_type: i64,
    ) -> Result<anyhow::Result<Entity>, String> {
        let db = &self.ctx.state.db;
        let account = self.account;
        let mut entity = match Entity::find(db, 1).await {
            Ok(Ok(Some(entity))) => entity,
            Ok(Ok(None)) => return Ok(Err(anyhow::anyhow!("Unable to find admin user to edit"))),
            Ok(Err(why)) => return Err(why),
            Err(e) => return Ok(Err(e)),
        };
        let hidden = match hidden_columns(db, 1).await {
            Ok(hidden) => hidden,
            Err(e) => return Ok(Err(e)),
        };
        let avatar = avatar_url(
            Some(&Value::from(account.id.as_str())),
            Some(&hidden.avatar_version.map_or(Value::Null, Value::from)),
        );
        let sets = vec![
            ("email", Bind::Text(email.to_lowercase())),
            ("jellyfinUsername", Bind::Text(account.name.clone())),
            ("jellyfinUserId", Bind::Text(account.id.clone())),
            ("jellyfinDeviceId", Bind::Text(self.device_id.to_owned())),
            (
                "jellyfinAuthToken",
                Bind::Text(account.access_token.clone()),
            ),
            ("permissions", Bind::Int(ADMIN)),
            ("avatar", Bind::Text(avatar.clone())),
            ("userType", Bind::Int(user_type)),
        ];
        Ok(update_user(db, 1, sets).await.map(|updated_at| {
            entity.set("email", Value::from(email));
            entity.set("jellyfinUsername", Value::from(account.name.as_str()));
            entity.set("permissions", Value::from(ADMIN));
            entity.set("avatar", Value::from(avatar));
            entity.set("userType", Value::from(user_type));
            entity.set("updatedAt", updated_at);
            entity
        }))
    }

    /// `createApiToken`, the server name, and the settings save that ends
    /// the setup. The user is written by now, so every failure is answered
    /// here.
    async fn save_server(&self, server_type: i64) -> Result<(), Outcome> {
        let ctx = self.ctx;
        let account = self.account;
        let admin_client = Jellyfin::new(
            &ctx.state.outbound,
            self.hostname,
            authorization(
                Some(&account.access_token),
                Some(self.device_id),
                &client_version(ctx, Some(server_type)),
            ),
            crate::runtime::jellyfin_timeout(),
        );
        let api_key = create_api_token(&admin_client)
            .await
            .map_err(|e| caught(ctx, Some(e), "creating the API key failed"))?;
        let server_name = server_name(self.server)
            .await
            .map_err(|e| caught(ctx, Some(e), "reading the server name failed"))?;
        let mut data = ctx.settings.data().clone();
        let body = self.body;
        let shape = || {
            caught(
                ctx,
                None,
                "settings.main or settings.jellyfin isn't an object",
            )
        };
        let main = data
            .get_mut("main")
            .and_then(Value::as_object_mut)
            .ok_or_else(shape)?;
        assign(main, "mediaServerType", Some(Value::from(server_type)));
        let jf = data
            .get_mut("jellyfin")
            .and_then(Value::as_object_mut)
            .ok_or_else(shape)?;
        assign(jf, "name", server_name);
        assign(jf, "serverId", account.server_id.clone());
        let hostname = body.hostname.clone().unwrap_or_default();
        assign(jf, "ip", Some(Value::from(hostname)));
        let port = body.port.clone().unwrap_or_else(|| Value::from(8096));
        assign(jf, "port", Some(port));
        let url_base = body.url_base.clone().unwrap_or_else(|| Value::from(""));
        assign(jf, "urlBase", Some(url_base));
        let use_ssl = body.use_ssl.clone().unwrap_or(Value::Bool(false));
        assign(jf, "useSsl", Some(use_ssl));
        assign(jf, "apiKey", api_key);
        ctx.save_settings(&data)
            .await
            .map_err(|e| caught(ctx, None, &format!("{e:#}")))?;
        start_jobs(ctx).await;
        Ok(())
    }

    /// A known user: the session fields are written with `update()`, and
    /// the handler keeps the entity as loaded.
    async fn refresh(&self, id: i64, entity: Entity) -> Result<Branch, String> {
        let ctx = self.ctx;
        let db = &ctx.state.db;
        let account = self.account;
        tracing::info!(
            "Found matching {} user; updating user with {}",
            server_label(self.server_type),
            server_label(self.server_type)
        );
        let hidden = hidden_columns(db, id)
            .await
            .map_err(|e| format!("database: {e:#}"))?;
        let avatar = avatar_url(
            Some(&hidden.jellyfin_user_id.map_or(Value::Null, Value::from)),
            Some(&hidden.avatar_version.map_or(Value::Null, Value::from)),
        );
        let mut sets = vec![
            ("avatar", Bind::Text(avatar)),
            ("jellyfinUsername", Bind::Text(account.name.clone())),
            (
                "jellyfinAuthToken",
                Bind::Text(account.access_token.clone()),
            ),
            ("jellyfinDeviceId", Bind::Text(self.device_id.to_owned())),
        ];
        if entity.get("username").and_then(Value::as_str) == Some(account.name.as_str()) {
            sets.push(("username", Bind::Text(String::new())));
        }
        if let Err(e) = update_user(db, id, sets).await {
            return Ok(Err(caught(ctx, None, &format!("{e:#}"))));
        }
        let mut overrides = Map::new();
        for key in ["avatar", "jellyfinUsername", "username", "updatedAt"] {
            overrides.insert(
                key.to_owned(),
                entity.get(key).cloned().unwrap_or(Value::Null),
            );
        }
        Ok(Ok((entity, Some(overrides))))
    }

    /// `newPlexLogin`: a new user for the Jellyfin account, with the
    /// password as a local one too.
    async fn create(&self) -> Result<Branch, String> {
        let ctx = self.ctx;
        let account = self.account;
        let permissions = default_permissions(ctx)?;
        tracing::info!("Sign-in attempt from Jellyfin user with access to the media server; creating new Foreseerr user");
        let password = if self.body.password.is_empty() {
            None
        } else {
            match super::authcommon::hash_password(self.body.password.clone()).await {
                Ok(hash) => Some(hash),
                Err(why) => return Ok(Err(caught(ctx, None, &why))),
            }
        };
        let new_user = NewUser {
            email: self.body.email.clone(),
            jellyfin_username: Some(account.name.clone()),
            jellyfin_user_id: Some(account.id.clone()),
            jellyfin_device_id: Some(self.device_id.to_owned()),
            jellyfin_auth_token: Some(account.access_token.clone()),
            permissions,
            user_type: if self.server_type == JELLYFIN {
                USER_JELLYFIN
            } else {
                USER_EMBY
            },
            avatar: avatar_url(Some(&Value::from(account.id.as_str())), None),
            password,
            ..NewUser::default()
        };
        Ok(match new_user.insert(&ctx.state.db).await {
            Ok(entity) => Ok((entity, None)),
            Err(e) => Err(caught(ctx, None, &format!("{e:#}"))),
        })
    }
}

const fn server_label(server_type: i64) -> &'static str {
    if server_type == JELLYFIN {
        "Jellyfin"
    } else {
        "Emby"
    }
}

/// The avatar check, the session and the user, as every Jellyfin sign-in
/// ends.
async fn finish_login(
    ctx: &Ready<'_>,
    mut entity: Entity,
    overrides: Option<Map<String, Value>>,
) -> Step {
    let Some(id) = entity.get("id").and_then(Value::as_i64) else {
        return Ok(ctx.error(500, "Something went wrong."));
    };
    let linked = hidden_columns(&ctx.state.db, id)
        .await
        .is_ok_and(|h| h.jellyfin_user_id.is_some_and(|j| !j.is_empty()));
    // The desktop runtime skips the optional avatar refresh.
    if linked && !crate::runtime::desktop_links_internal() {
        if let Some(result) = avatar_check(ctx, id, overrides).await {
            entity.set("avatar", result.avatar);
            entity.set("updatedAt", result.updated_at);
        }
    }
    Ok(signed_in(ctx, id, &entity.public_json()).await)
}

/// `createApiToken('Foreseerr')`: make a key, then find it in the list.
async fn create_api_token(jf: &Jellyfin<'_>) -> Result<Option<Value>, ApiError> {
    let fail = |e: &CallError| {
        tracing::error!(
            "Something went wrong while creating an API key from the Jellyfin server: {e:?}"
        );
        api_error(e, INVALID_AUTH_TOKEN)
    };
    let type_error = ApiError {
        status: 502,
        code: CONNECTION_ERROR,
    };
    jf.call(Method::POST, "/Auth/Keys?App=Foreseerr", None, &[])
        .await
        .map_err(|e| fail(&e))?;
    let keys = jf
        .call(Method::GET, "/Auth/Keys", None, &[])
        .await
        .map_err(|e| fail(&e))?;
    let Ok(Some(Value::Array(items))) = prop(&keys, "Items") else {
        return Err(type_error);
    };
    for item in items.iter().rev() {
        let Ok(app) = prop(item, "AppName") else {
            return Err(type_error);
        };
        if app == Some(&Value::String(String::from("Foreseerr"))) {
            return Ok(prop(item, "AccessToken").ok().flatten().cloned());
        }
    }
    Err(type_error)
}

/// `getServerName()`: `ServerName` of `/System/Info/Public`.
async fn server_name(jf: &Jellyfin<'_>) -> Result<Option<Value>, ApiError> {
    let data = jf
        .call(Method::GET, "/System/Info/Public", None, &[])
        .await
        .map_err(|e| api_error(&e, UNKNOWN))?;
    prop(&data, "ServerName")
        .map(Option::<&Value>::cloned)
        .map_err(|()| ApiError {
            status: 502,
            code: CONNECTION_ERROR,
        })
}

fn plugin<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if crate::runtime::active() && crate::runtime::plugin_mode() {
            return finish(super::pluginauth::mint(ctx).await);
        }
        finish(plugin_route(ctx))
    })
}

/// `POST /auth/jellyfin/plugin`: outside plugin mode (the only mode
/// answered here) it is disabled, once the validator passed the body.
fn plugin_route(ctx: &Ready<'_>) -> Step {
    ctx.no_query()?;
    let Some(Value::Object(body)) = &ctx.body else {
        return Err(String::from("a body that isn't an object").into());
    };
    for key in ["jellyfinUserId", "jellyfinUsername", "jellyfinAccessToken"] {
        if !matches!(body.get(key), Some(Value::String(_))) {
            return Err(format!("{key} is the validator's").into());
        }
    }
    if !matches!(body.get("isAdministrator"), None | Some(Value::Bool(_))) {
        return Err(String::from("isAdministrator is the validator's").into());
    }
    Ok(ctx.error(404, "Plugin auth is disabled."))
}

/// A `JellyfinAPI(getHostname())` without token or device id.
fn anonymous_client<'a>(ctx: &'a Ready<'a>) -> Jellyfin<'a> {
    Jellyfin::new(
        &ctx.state.outbound,
        &settings_hostname(ctx),
        authorization(None, None, &client_version(ctx, current_type(ctx))),
        None,
    )
}

/// `quickConnectSecret`: 8 to 128 hex digits.
fn valid_secret(secret: &str) -> bool {
    (8..=128).contains(&js_length(secret)) && secret.bytes().all(|b| b.is_ascii_hexdigit())
}

fn quickconnect_initiate<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move { finish(initiate_route(ctx).await) })
}

/// `POST /auth/jellyfin/quickconnect/initiate`.
async fn initiate_route(ctx: &Ready<'_>) -> Step {
    ctx.no_query()?;
    // A body the validator passed is one the handler ignores.
    if !ctx.passed() && !matches!(&ctx.body, Some(Value::Object(m)) if m.is_empty()) {
        return Err(String::from("a body the spec doesn't describe").into());
    }
    if media_server_type(ctx)? != JELLYFIN {
        return Ok(ctx.error(403, "Quick Connect is only supported by Jellyfin."));
    }
    let failed = |why: &str| {
        tracing::error!("Error initiating Jellyfin quick connect: {why}");
        ctx.error(500, "Failed to initiate quick connect.")
    };
    let data = match anonymous_client(ctx)
        .call(Method::POST, "/QuickConnect/Initiate", None, &[])
        .await
    {
        Ok(data) => data,
        Err(e) => return Ok(failed(&format!("{e:?}"))),
    };
    let (Ok(code), Ok(secret)) = (prop(&data, "Code"), prop(&data, "Secret")) else {
        return Ok(failed("the answer is null"));
    };
    let mut out = Map::new();
    assign(&mut out, "code", code.cloned());
    assign(&mut out, "secret", secret.cloned());
    Ok(ctx.json(&Value::Object(out)))
}

fn quickconnect_check<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move { finish(check_route(ctx).await) })
}

/// The `secret` of a query string that is only `secret=...` with nothing
/// to decode.
fn query_secret(query: Option<&str>) -> Option<&str> {
    let value = query?.strip_prefix("secret=")?;
    (!value.contains(['&', '%', '+', '=', '#', '[', ']'])).then_some(value)
}

/// `GET /auth/jellyfin/quickconnect/check`.
async fn check_route(ctx: &Ready<'_>) -> Step {
    // Once the validator passed the query, `req.query.secret` is its
    // decoded value; zod refuses anything but a string.
    let secret = match ctx.validated().map(|v| &v.query) {
        Some(query) => query.get("secret").and_then(Value::as_str),
        None => Some(
            query_secret(ctx.req.uri.query())
                .ok_or_else(|| String::from("a query string for the validator"))?,
        ),
    };
    if media_server_type(ctx)? != JELLYFIN {
        return Ok(ctx.error(403, "Quick Connect is only supported by Jellyfin."));
    }
    let Some(secret) = secret.filter(|s| valid_secret(s)) else {
        return Ok(ctx.error(400, "Invalid secret format"));
    };
    let failed = "Failed to check Quick Connect status";
    let data = match anonymous_client(ctx)
        .call(
            Method::GET,
            &format!("/QuickConnect/Connect?secret={secret}"),
            None,
            &[],
        )
        .await
    {
        Ok(data) => data,
        Err(e) => {
            tracing::error!("Something went wrong while getting Quick Connect status: {e:?}");
            return Ok(ctx.error(api_error(&e, UNKNOWN).status, failed));
        }
    };
    let Ok(authenticated) = prop(&data, "Authenticated") else {
        return Ok(ctx.error(500, failed));
    };
    let mut out = Map::new();
    assign(&mut out, "authenticated", authenticated.cloned());
    Ok(ctx.json(&Value::Object(out)))
}

fn quickconnect_authenticate<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move { finish(authenticate_route(ctx).await) })
}

/// `POST /auth/jellyfin/quickconnect/authenticate`.
async fn authenticate_route(ctx: &Ready<'_>) -> Step {
    ctx.no_query()?;
    let Some(Value::Object(body)) = &ctx.body else {
        return Err(String::from("a body that isn't an object").into());
    };
    let Some(Value::String(secret)) = body.get("secret") else {
        return Err(String::from("secret is the validator's").into());
    };
    if !valid_secret(secret) {
        return Ok(ctx.error(400, "Secret required"));
    }
    let server_type = media_server_type(ctx)?;
    let permissions = default_permissions(ctx)?;
    let db = &ctx.state.db;
    if server_type == NOT_CONFIGURED
        || user_count(db)
            .await
            .map_err(|e| format!("database: {e:#}"))?
            == 0
    {
        return Ok(ctx.error(403, "Quick Connect is not available during initial setup."));
    }
    if server_type != JELLYFIN {
        return Ok(ctx.error(403, "Quick Connect is only supported by Jellyfin."));
    }
    let mut payload = Map::new();
    payload.insert(String::from("Secret"), Value::from(secret.as_str()));
    let result = anonymous_client(ctx)
        .call(
            Method::POST,
            "/Users/AuthenticateWithQuickConnect",
            Some(&Value::Object(payload)),
            &[],
        )
        .await;
    // The secret is spent from here on: nothing may go to Node.
    let fail = |status: u16, why: &str| {
        tracing::error!("Quick Connect authentication failed: {why}");
        Ok(ctx.error(status, INVALID_CREDENTIALS))
    };
    let data = match result {
        Ok(data) => data,
        Err(e) => return fail(api_error(&e, UNKNOWN).status, &format!("{e:?}")),
    };
    let Some(account) = quick_account(&data) else {
        return fail(500, "an answer of another shape");
    };
    let entity = match quick_user(ctx, &account, permissions).await {
        Ok(Ok(entity)) => entity,
        Ok(Err(outcome)) => return Ok(outcome),
        Err(why) => return fail(500, &why),
    };
    finish_login(ctx, entity, None).await
}

/// The Quick Connect account: id, name (`undefined` and `null` kept
/// apart) and token.
#[derive(Debug, Clone)]
struct QuickAccount {
    id: String,
    name: QuickName,
    access_token: String,
}

/// `account.User.Name`: missing, `null`, or a string.
#[derive(Debug, Clone, PartialEq, Eq)]
enum QuickName {
    Undefined,
    Null,
    Text(String),
}

fn quick_account(data: &Value) -> Option<QuickAccount> {
    let user = data.get("User")?.as_object()?;
    let name = match user.get("Name") {
        None => QuickName::Undefined,
        Some(Value::Null) => QuickName::Null,
        Some(Value::String(s)) => QuickName::Text(s.clone()),
        Some(_) => return None,
    };
    Some(QuickAccount {
        id: user.get("Id")?.as_str()?.to_owned(),
        name,
        access_token: data.get("AccessToken")?.as_str()?.to_owned(),
    })
}

/// The user a Quick Connect sign-in lands on: updated when linked,
/// created when `newPlexLogin` allows. `Err` is the handler's catch.
async fn quick_user(
    ctx: &Ready<'_>,
    account: &QuickAccount,
    permissions: i64,
) -> Result<Result<Entity, Outcome>, String> {
    let db = &ctx.state.db;
    let db_err = |e: anyhow::Error| format!("database: {e:#}");
    let name = match &account.name {
        QuickName::Text(s) => Some(s.clone()),
        QuickName::Undefined | QuickName::Null => None,
    };
    let device_id = base64(&format!("BOT_seerr_{}", name.as_deref().unwrap_or("")));
    if let Some(id) = linked_user(ctx, &account.id).await.map_err(db_err)? {
        let mut entity = Entity::find(db, id)
            .await
            .map_err(db_err)??
            .ok_or_else(|| String::from("the user vanished"))?;
        tracing::info!("Quick Connect sign-in from existing user");
        let hidden = hidden_columns(db, id).await.map_err(db_err)?;
        let avatar = avatar_url(
            Some(&hidden.jellyfin_user_id.map_or(Value::Null, Value::from)),
            Some(&hidden.avatar_version.map_or(Value::Null, Value::from)),
        );
        let sets = vec![
            (
                "jellyfinAuthToken",
                Bind::Text(account.access_token.clone()),
            ),
            ("jellyfinDeviceId", Bind::Text(device_id)),
            ("avatar", Bind::Text(avatar.clone())),
        ];
        let updated_at = update_user(db, id, sets).await.map_err(db_err)?;
        entity.set("avatar", Value::from(avatar));
        entity.set("updatedAt", updated_at);
        return Ok(Ok(entity));
    }
    if !truthy(ctx.settings.get("/main/newPlexLogin")) {
        tracing::warn!("Failed Quick Connect sign-in attempt by unimported Jellyfin user");
        return Ok(Err(ctx.error(403, "Access denied.")));
    }
    tracing::info!("Quick Connect sign-in from new Jellyfin user; creating new Foreseerr user");
    let mut entity = NewUser {
        email: name.clone(),
        jellyfin_username: name,
        jellyfin_user_id: Some(account.id.clone()),
        jellyfin_device_id: Some(device_id),
        jellyfin_auth_token: Some(account.access_token.clone()),
        permissions,
        user_type: USER_JELLYFIN,
        avatar: avatar_url(Some(&Value::from(account.id.as_str())), None),
        ..NewUser::default()
    }
    .insert(db)
    .await
    .map_err(db_err)?;
    if account.name == QuickName::Null {
        entity.set("email", Value::Null);
        entity.set("jellyfinUsername", Value::Null);
    }
    Ok(Ok(entity))
}

/// The Jellyfin half of `POST /auth/logout` (outside plugin mode): the
/// user's device is deleted with the server's API key. Failures are only
/// logged, as in Node.
///
/// # Errors
///
/// Fails when the user can't be read.
pub(super) async fn forget_device(ctx: &Ready<'_>, user_id: i64) -> Result<(), String> {
    let rows = ctx
        .state
        .db
        .rows(
            r#"SELECT "jellyfinUserId", "jellyfinDeviceId" FROM "user" WHERE "id" = ?1"#,
            &[Bind::Int(user_id)],
        )
        .await
        .map_err(|e| format!("database: {e:#}"))?;
    let row = rows.first();
    let text = |key: &str| {
        row.and_then(|r| r.get(key))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    };
    let (Some(_), Some(device)) = (text("jellyfinUserId"), text("jellyfinDeviceId")) else {
        return Ok(());
    };
    let api_key = ctx.settings.get("/jellyfin/apiKey").and_then(Value::as_str);
    let url = devices_url(&settings_hostname(ctx), device);
    let sent = ctx
        .state
        .outbound
        .delete(url)
        .header("Accept", "application/json, text/plain, */*")
        .header(
            "Authorization",
            authorization(
                api_key,
                Some("foreseerr"),
                &client_version(ctx, current_type(ctx)),
            ),
        )
        .send()
        .await;
    match sent {
        Ok(res) if res.status().is_success() => {}
        Ok(res) => tracing::error!("Failed to delete Jellyfin device: {}", res.status()),
        Err(e) => tracing::error!("Failed to delete Jellyfin device: {e:#}"),
    }
    Ok(())
}

/// `${getHostname()}/Devices` with axios's `params: { Id }`.
fn devices_url(hostname: &str, device_id: &str) -> String {
    let mut url = format!("{hostname}/Devices");
    if let Some(hash) = url.find('#') {
        url.truncate(hash);
    }
    let separator = if url.contains('?') { '&' } else { '?' };
    format!("{url}{separator}Id={}", axios_encode(device_id))
}

/// axios's `encode` for query values.
fn axios_encode(value: &str) -> String {
    crate::ratings::encode_uri_component(value)
        .replace("%3A", ":")
        .replace("%24", "$")
        .replace("%2C", ",")
        .replace("%20", "+")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_login_answers() {
        let data = json!({
            "User": {"Name": "ann", "ServerId": "s", "Id": "abc", "Policy": {"IsAdministrator": false}},
            "AccessToken": "tok"
        });
        let account = parse_account(&data);
        assert_eq!(account.as_ref().map(|a| a.id.as_str()), Some("abc"), "id");
        assert_eq!(
            account.as_ref().map(|a| a.not_admin),
            Some(true),
            "not admin"
        );
        assert!(parse_account(&json!("<html>")).is_none(), "text");
        assert!(
            parse_account(
                &json!({"User": {"Id": "", "Name": "a", "Policy": {}}, "AccessToken": "t"})
            )
            .is_none(),
            "empty id"
        );
    }

    #[test]
    fn quick_connect_inputs() {
        assert!(valid_secret("abcdef0123456789"), "hex");
        assert!(!valid_secret("abc"), "short");
        assert!(!valid_secret("ghijklmnop"), "not hex");
        assert_eq!(
            query_secret(Some("secret=abcd1234")),
            Some("abcd1234"),
            "plain"
        );
        assert_eq!(query_secret(Some("secret=a%20b")), None, "encoded");
        assert_eq!(query_secret(Some("secret=a&x=1")), None, "extra parameter");
        assert_eq!(query_secret(None), None, "missing");
    }

    #[test]
    fn device_urls() {
        assert_eq!(
            devices_url("http://10.0.0.2:8096", "Qk9UX3NlZXJyX2E+Yi8="),
            "http://10.0.0.2:8096/Devices?Id=Qk9UX3NlZXJyX2E%2BYi8%3D",
            "encoded id"
        );
        assert_eq!(
            axios_encode("a b:c,$"),
            "a+b:c,$",
            "axios keeps some characters"
        );
        assert_eq!(base64("BOT_seerr_ann"), "Qk9UX3NlZXJyX2Fubg==", "device id");
    }
}
