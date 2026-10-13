//! What the sign-in routes share.
//!
//! Used by `/auth/plex`, `/auth/jellyfin*`, `/auth/reset-password*` and
//! `/desktop/auth-tickets*`: express-session's preconditions, `req.ip`,
//! the `User` entity as `toPublicJSON` prints it, users inserted the way
//! `userRepository.save(new User(...))` inserts them, the calls Node's
//! `JellyfinAPI` makes, and Node's job scheduler and avatar check over the
//! internal routes.

use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::time::Duration;

use axum::extract::ConnectInfo;
use axum::http::{header, HeaderValue, Method};
use base64::prelude::*;
use serde_json::{Map, Value};

use super::{Outcome, Ready};
use crate::db::{Bind, Db};

pub(super) type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// `MediaServerType`.
pub(super) const PLEX: i64 = 1;
pub(super) const JELLYFIN: i64 = 2;
pub(super) const EMBY: i64 = 3;
pub(super) const NOT_CONFIGURED: i64 = 4;
/// `UserType`.
pub(super) const USER_PLEX: i64 = 1;
pub(super) const USER_JELLYFIN: i64 = 3;
pub(super) const USER_EMBY: i64 = 4;

/// A handler's result: an answer, or why Node has to give it.
pub(super) type Step = Result<Outcome, super::Fallback>;

/// Turn a [`Step`] into what the router expects.
pub(super) fn finish(step: Step) -> Outcome {
    step.unwrap_or_else(Outcome::forward)
}

/// Whether the request carries a cookie named `name` at all.
pub(super) fn has_cookie(ctx: &Ready<'_>, name: &str) -> bool {
    ctx.req
        .headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|h| h.split(';'))
        .any(|pair| pair.split_once('=').is_some_and(|(k, _)| k.trim() == name))
}

/// `settings.main.mediaServerType`, when it is a plain integer.
pub(super) fn media_server_type(ctx: &Ready<'_>) -> Result<i64, String> {
    ctx.settings
        .get("/main/mediaServerType")
        .and_then(Value::as_i64)
        .ok_or_else(|| String::from("mediaServerType isn't an integer"))
}

/// `settings.main.defaultPermissions`, when it is a plain integer.
pub(super) fn default_permissions(ctx: &Ready<'_>) -> Result<i64, String> {
    ctx.settings
        .get("/main/defaultPermissions")
        .and_then(Value::as_i64)
        .ok_or_else(|| String::from("defaultPermissions isn't an integer"))
}

/// `net.isIP`: `Some(true)` for an address, `None` where Node and Rust
/// might disagree (zone ids).
fn is_ip(text: &str) -> Option<bool> {
    if text.contains('%') {
        return None;
    }
    Some(text.parse::<IpAddr>().is_ok())
}

/// `removePortFrom` of `@supercharge/request-ip`.
fn remove_port(ip: &str) -> Option<&str> {
    if text_is_v6(ip)? {
        return Some(ip);
    }
    Some(ip.split(':').next().unwrap_or(ip))
}

fn text_is_v6(text: &str) -> Option<bool> {
    if text.contains('%') {
        return None;
    }
    Some(text.parse::<std::net::Ipv6Addr>().is_ok())
}

/// `req.ip` as Node computes it behind this server: `getClientIp` takes
/// the first address in `X-Forwarded-For`, to which the proxy here
/// appends the peer, so there always is one.
pub(super) fn client_ip(ctx: &Ready<'_>) -> Result<String, String> {
    let peer = ctx
        .req
        .extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0.ip())
        .ok_or_else(|| String::from("no peer address"))?;
    let combined = match ctx
        .req
        .headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
    {
        Some(existing) if !existing.is_empty() => format!("{existing}, {peer}"),
        Some(_) | None => peer.to_string(),
    };
    first_ip(&combined).ok_or_else(|| String::from("an unsupported X-Forwarded-For entry"))
}

/// `findIp(header.split(','))`; `None` when an entry is ambiguous.
fn first_ip(header: &str) -> Option<String> {
    for candidate in header.split(',') {
        let ip = remove_port(candidate.trim())?;
        if is_ip(ip)? {
            return Some(ip.to_owned());
        }
    }
    None
}

/// The `User` properties `toPublicJSON` prints, in its order.
const PUBLIC_KEYS: [&str; 15] = [
    "id",
    "email",
    "username",
    "plexUsername",
    "jellyfinUsername",
    "displayName",
    "avatar",
    "permissions",
    "userType",
    "createdAt",
    "updatedAt",
    "requestCount",
    "warnings",
    "plexId",
    "settings",
];

/// A `User` entity as a handler holds it: the properties `toPublicJSON`
/// reads that are defined (an absent key is `undefined`).
#[derive(Debug, Clone, Default)]
pub(super) struct Entity(Map<String, Value>);

impl Entity {
    pub(super) fn set(&mut self, key: &str, value: Value) {
        self.0.insert(key.to_owned(), value);
    }

    pub(super) fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(key)
    }

    /// `user.toPublicJSON()` through Node's JSON serialisation.
    pub(super) fn public_json(&self) -> Value {
        let mut out = Map::new();
        for key in PUBLIC_KEYS {
            if let Some(value) = self.0.get(key) {
                out.insert(key.to_owned(), value.clone());
            }
        }
        Value::Object(out)
    }

    /// `findOne({ where: { id } })`: every selectable column, the eager
    /// settings, the request count and `displayName`.
    ///
    /// # Errors
    ///
    /// The outer error is a database failure; the inner one a stored value
    /// that while loading.
    pub(super) async fn find(db: &Db, id: i64) -> anyhow::Result<Result<Option<Self>, String>> {
        let Some(profile) = db.user_profile(id).await? else {
            return Ok(Ok(None));
        };
        Ok(match crate::user::public_json(&profile) {
            Ok(Value::Object(map)) => Ok(Some(Self(map))),
            Ok(_) => Err(String::from("the profile isn't an object")),
            Err(why) => Err(why.to_owned()),
        })
    }

    /// A query builder's `getOne()`: the same without eager relations.
    ///
    /// # Errors
    ///
    /// As [`Entity::find`].
    pub(super) async fn find_bare(
        db: &Db,
        id: i64,
    ) -> anyhow::Result<Result<Option<Self>, String>> {
        Ok(Self::find(db, id).await?.map(|found| {
            found.map(|mut entity| {
                entity.0.shift_remove("settings");
                entity
            })
        }))
    }
}

/// `getUserAvatarUrl`: `/avatarproxy/${jellyfinUserId}?v=${avatarVersion}`.
pub(super) fn avatar_url(
    jellyfin_user_id: Option<&Value>,
    avatar_version: Option<&Value>,
) -> String {
    format!(
        "/avatarproxy/{}?v={}",
        crate::media::js_string(jellyfin_user_id),
        crate::media::js_string(avatar_version)
    )
}

/// `Buffer.from(text).toString('base64')`.
pub(super) fn base64(text: &str) -> String {
    BASE64_STANDARD.encode(text.as_bytes())
}

/// The columns of a `user` row that aren't in `toPublicJSON` but drive the
/// sign-in flows.
#[derive(Debug, Clone, Default)]
pub(super) struct Hidden {
    pub(super) jellyfin_user_id: Option<String>,
    pub(super) avatar_version: Option<String>,
}

/// `jellyfinUserId` and `avatarVersion` of a user.
///
/// # Errors
///
/// Fails on database errors.
pub(super) async fn hidden_columns(db: &Db, id: i64) -> anyhow::Result<Hidden> {
    let rows = db
        .rows(
            r#"SELECT "jellyfinUserId", "avatarVersion" FROM "user" WHERE "id" = ?1"#,
            &[Bind::Int(id)],
        )
        .await?;
    let row = rows.first();
    let text = |key: &str| {
        row.and_then(|r| r.get(key))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    Ok(Hidden {
        jellyfin_user_id: text("jellyfinUserId"),
        avatar_version: text("avatarVersion"),
    })
}

/// A `new User({...})` about to be saved: what its initialiser sets.
#[derive(Debug, Clone, Default)]
pub(super) struct NewUser {
    pub(super) id: Option<i64>,
    pub(super) email: Option<String>,
    pub(super) plex_username: Option<String>,
    pub(super) jellyfin_username: Option<String>,
    pub(super) password: Option<String>,
    pub(super) user_type: i64,
    pub(super) plex_id: Option<i64>,
    pub(super) jellyfin_user_id: Option<String>,
    pub(super) jellyfin_device_id: Option<String>,
    pub(super) jellyfin_auth_token: Option<String>,
    pub(super) plex_token: Option<String>,
    pub(super) permissions: i64,
    pub(super) avatar: String,
}

/// Every insertable `user` column other than `id` and the two dates, in
/// entity order.
const INSERT_COLUMNS: &str = r#""email", "plexUsername", "jellyfinUsername", "username", "password", "resetPasswordGuid", "recoveryLinkExpirationDate", "userType", "plexId", "jellyfinUserId", "jellyfinDeviceId", "jellyfinAuthToken", "plexToken", "permissions", "avatar", "avatarETag", "avatarVersion", "movieQuotaLimit", "movieQuotaDays", "tvQuotaLimit", "tvQuotaDays""#;

impl NewUser {
    /// The INSERT `save()` runs (the email transformer lowercases, and
    /// turns a missing email into `''`), and the entity as `TypeORM`
    /// leaves it: the given properties plus the generated id and the
    /// columns with defaults.
    ///
    /// # Errors
    ///
    /// Fails on database errors, unique emails included.
    pub(super) async fn insert(&self, db: &Db) -> anyhow::Result<Entity> {
        let text = |v: &Option<String>| Bind::OptText(v.clone());
        let mut binds = vec![
            Bind::Text(self.email.as_deref().unwrap_or("").to_lowercase()),
            text(&self.plex_username),
            text(&self.jellyfin_username),
            text(&self.password),
            Bind::Int(self.user_type),
            Bind::OptInt(self.plex_id),
            text(&self.jellyfin_user_id),
            text(&self.jellyfin_device_id),
            text(&self.jellyfin_auth_token),
            text(&self.plex_token),
            Bind::Int(self.permissions),
            Bind::Text(self.avatar.clone()),
        ];
        let values = "?1, ?2, ?3, NULL, ?4, NULL, NULL, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL, NULL, NULL, NULL, NULL, NULL";
        let (id_column, id_value) = if self.id.is_some() {
            (r#""id", "#, "?13, ")
        } else {
            ("", "")
        };
        if let Some(id) = self.id {
            binds.push(Bind::Int(id));
        }
        let sql = format!(
            r#"INSERT INTO "user" ({id_column}{INSERT_COLUMNS}) VALUES ({id_value}{values}) RETURNING CAST("id" AS BIGINT)"#
        );
        let id = db.scalar(&sql, &binds).await?;
        let (created_at, updated_at) = dates(db, id).await?;
        let mut entity = Entity::default();
        entity.set("id", Value::from(id));
        if let Some(email) = &self.email {
            entity.set("email", Value::from(email.as_str()));
        }
        let mut opt = |key: &str, v: &Option<String>| {
            if let Some(v) = v {
                entity.set(key, Value::from(v.as_str()));
            }
        };
        opt("plexUsername", &self.plex_username);
        opt("jellyfinUsername", &self.jellyfin_username);
        entity.set("avatar", Value::from(self.avatar.as_str()));
        entity.set("permissions", Value::from(self.permissions));
        entity.set("userType", Value::from(self.user_type));
        entity.set("createdAt", created_at);
        entity.set("updatedAt", updated_at);
        entity.set("warnings", Value::Array(Vec::new()));
        if let Some(plex_id) = self.plex_id {
            entity.set("plexId", Value::from(plex_id));
        }
        Ok(entity)
    }
}

/// `createdAt` and `updatedAt` of a user, as JSON dates.
async fn dates(db: &Db, id: i64) -> anyhow::Result<(Value, Value)> {
    let sql = format!(
        r#"SELECT {} AS "createdAt", {} AS "updatedAt" FROM "user" WHERE "id" = ?1"#,
        db.iso_sql(r#""createdAt""#),
        db.iso_sql(r#""updatedAt""#)
    );
    let rows = db.rows(&sql, &[Bind::Int(id)]).await?;
    let row = rows.first();
    let get = |key: &str| row.and_then(|r| r.get(key)).cloned().unwrap_or(Value::Null);
    Ok((get("createdAt"), get("updatedAt")))
}

/// `save()` of a loaded user whose `sets` columns changed: one UPDATE
/// that also stamps `updatedAt`, then the new `updatedAt` as `TypeORM`
/// reads it back into the entity.
///
/// # Errors
///
/// Fails on database errors.
pub(super) async fn update_user(
    db: &Db,
    id: i64,
    sets: Vec<(&str, Bind)>,
) -> anyhow::Result<Value> {
    let mut assignments = Vec::with_capacity(sets.len() + 1);
    let mut binds = Vec::with_capacity(sets.len() + 1);
    for (i, (column, bind)) in sets.into_iter().enumerate() {
        assignments.push(format!(r#""{column}" = ?{}"#, i + 1));
        binds.push(bind);
    }
    assignments.push(String::from(r#""updatedAt" = CURRENT_TIMESTAMP"#));
    binds.push(Bind::Int(id));
    let sql = format!(
        r#"UPDATE "user" SET {} WHERE "id" = ?{}"#,
        assignments.join(", "),
        binds.len()
    );
    db.execute(&sql, &binds).await?;
    Ok(dates(db, id).await?.1)
}

/// `userRepository.count()`.
///
/// # Errors
///
/// Fails on database errors.
pub(super) async fn user_count(db: &Db) -> anyhow::Result<i64> {
    db.scalar(r#"SELECT CAST(COUNT(*) AS BIGINT) FROM "user""#, &[])
        .await
}

/// The JSON answer of a sign-in with the session cookie for `user_id`.
pub(super) async fn signed_in(ctx: &Ready<'_>, user_id: i64, body: &Value) -> Outcome {
    let cookie = match super::login::start_session(ctx, user_id).await {
        Ok(cookie) => cookie,
        Err(why) => {
            tracing::error!("saving the session failed: {why}");
            return ctx.error(500, &why);
        }
    };
    let mut outcome = ctx.json(body);
    if let (Outcome::Done(res), Some(cookie)) = (&mut outcome, cookie) {
        if let Ok(value) = HeaderValue::from_str(&cookie) {
            res.headers_mut().append(header::SET_COOKIE, value);
        }
    }
    outcome
}

/// `{ error }` with a status, as the handlers' `res.status(n).json(...)`.
pub(super) fn error_body(ctx: &Ready<'_>, status: u16, message: &str) -> Outcome {
    let mut body = Map::new();
    body.insert(String::from("error"), Value::from(message));
    ctx.json_with(status, &Value::Object(body))
}

fn internal_url(ctx: &Ready<'_>, path: &str) -> String {
    format!(
        "{}/internal{path}",
        ctx.state.env.node_url.trim_end_matches('/')
    )
}

/// `startJobs(); startDesktopCatchUp();` in Node, which owns the
/// scheduler. Node has already reloaded the settings by then.
pub(super) async fn start_jobs(ctx: &Ready<'_>) {
    if crate::jobs::scheduler::rust_jobs() {
        crate::jobs::scheduler::start(std::sync::Arc::clone(&ctx.shared)).await;
        crate::runtime::desktop::start_jobs_now(&ctx.shared);
        return;
    }
    let sent = ctx
        .state
        .internal
        .post(internal_url(ctx, "/jobs/start"))
        .header("X-API-Key", ctx.settings.api_key())
        .send()
        .await;
    match sent {
        Ok(res) if res.status().is_success() => {}
        Ok(res) => tracing::warn!("Node refused to start the jobs: {}", res.status()),
        Err(e) => tracing::warn!("Node could not be asked to start the jobs: {e:#}"),
    }
}

/// What the avatar check left in the entity: `avatar` and `updatedAt`.
#[derive(Debug, Clone)]
pub(super) struct AvatarResult {
    pub(super) avatar: Value,
    pub(super) updated_at: Value,
}

/// The login's `checkAvatarChanged(user)` and, when it changed, the
/// avatar save. The image cache is Node's, so Node runs both on the user
/// as loaded, with `overrides` for properties the handler's copy holds
/// stale. `None` when Node couldn't be asked; the entity is then left as
/// it is, like a failed check.
pub(super) async fn avatar_check(
    ctx: &Ready<'_>,
    user_id: i64,
    overrides: Option<Map<String, Value>>,
) -> Option<AvatarResult> {
    let mut body = Map::new();
    body.insert(String::from("userId"), Value::from(user_id));
    if let Some(overrides) = overrides {
        body.insert(String::from("overrides"), Value::Object(overrides));
    }
    if super::procstate::in_process("/auth/avatar-check") {
        let path = "/auth/avatar-check";
        let body = Value::Object(body);
        let answer =
            crate::standalone::internal::call(ctx.state, &Method::POST, path, Some(&body)).await;
        if !answer.is_success() {
            tracing::error!(
                "Error handling avatar during login: answered {}",
                answer.status
            );
            return None;
        }
        return Some(AvatarResult {
            avatar: answer.body.get("avatar").cloned()?,
            updated_at: answer.body.get("updatedAt").cloned()?,
        });
    }
    let sent = ctx
        .state
        .internal
        .post(internal_url(ctx, "/auth/avatar-check"))
        .header("X-API-Key", ctx.settings.api_key())
        .json(&Value::Object(body))
        .send()
        .await;
    let res = match sent {
        Ok(res) if res.status().is_success() => res,
        Ok(res) => {
            tracing::error!(
                "Error handling avatar during login: Node answered {}",
                res.status()
            );
            return None;
        }
        Err(e) => {
            tracing::error!("Error handling avatar during login: {e:#}");
            return None;
        }
    };
    let value: Value = res.json().await.ok()?;
    Some(AvatarResult {
        avatar: value.get("avatar").cloned()?,
        updated_at: value.get("updatedAt").cloned()?,
    })
}

/// `getHostname(params)`: `${useSsl ? 'https' : 'http'}://${ip}:${port}${urlBase}`.
pub(super) fn hostname_of(
    use_ssl: Option<&Value>,
    ip: Option<&Value>,
    port: Option<&Value>,
    url_base: Option<&Value>,
) -> String {
    let js = |v: Option<&Value>| {
        crate::media::js_string(v.map(|v| crate::tmdb::js_numbers(v.clone())).as_ref()).into_owned()
    };
    format!(
        "{}://{}:{}{}",
        if crate::settings::public::truthy(use_ssl) {
            "https"
        } else {
            "http"
        },
        js(ip),
        js(port),
        js(url_base)
    )
}

/// `getHostname()`: the configured Jellyfin server.
pub(super) fn settings_hostname(ctx: &Ready<'_>) -> String {
    let get = |key: &str| ctx.settings.get(&format!("/jellyfin/{key}"));
    hostname_of(get("useSsl"), get("ip"), get("port"), get("urlBase"))
}

/// axios `combineURLs(baseURL, url)`.
pub(super) fn combine_url(base: &str, path: &str) -> String {
    let base = base.strip_suffix('/').unwrap_or(base);
    let base = base.strip_suffix('/').unwrap_or(base);
    format!("{base}/{}", path.trim_start_matches('/'))
}

/// A JSON number JavaScript compares equal to an integer.
pub(super) fn js_int(value: &Value) -> Option<i64> {
    let Value::Number(n) = value else {
        return None;
    };
    n.as_i64().or_else(|| {
        let f = n.as_f64()?;
        (f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0)
            .then(|| format!("{f:.0}").parse().ok())
            .flatten()
    })
}

/// The `Version` `buildJellyfinAuthorizationHeader` puts in: `1.0.0` for
/// Emby, the app version otherwise.
pub(super) fn client_version(ctx: &Ready<'_>, media_server_type: Option<i64>) -> String {
    if media_server_type == Some(EMBY) {
        String::from("1.0.0")
    } else {
        ctx.state.version.version.clone()
    }
}

/// The current `mediaServerType`, for [`client_version`].
pub(super) fn current_type(ctx: &Ready<'_>) -> Option<i64> {
    ctx.settings.get("/main/mediaServerType").and_then(js_int)
}

/// `buildJellyfinAuthorizationHeader(authToken, deviceId)`.
pub(super) fn authorization(token: Option<&str>, device_id: Option<&str>, version: &str) -> String {
    let device = device_id
        .filter(|d| !d.is_empty())
        .map_or_else(|| base64("BOT_seerr"), str::to_owned);
    let mut out = format!(
        r#"MediaBrowser Client="Foreseerr", Device="Foreseerr", DeviceId="{device}", Version="{version}""#
    );
    if let Some(token) = token.filter(|t| !t.is_empty()) {
        out.push_str(", Token=\"");
        out.push_str(token);
        out.push('"');
    }
    out
}

/// How an axios call failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum CallError {
    /// No response: connection, URL or timeout trouble.
    NoResponse(String),
    /// A response outside 2xx.
    Status(u16),
}

/// One `JellyfinAPI` instance: base URL, `Authorization` and timeout.
#[derive(Debug, Clone)]
pub(super) struct Jellyfin<'a> {
    client: &'a reqwest::Client,
    base: String,
    authorization: String,
    timeout: Option<Duration>,
}

impl<'a> Jellyfin<'a> {
    pub(super) fn new(
        client: &'a reqwest::Client,
        base: &str,
        authorization: String,
        timeout: Option<Duration>,
    ) -> Self {
        Self {
            client,
            base: base.to_owned(),
            authorization,
            timeout,
        }
    }

    /// A request as the instance's axios sends it, with the body parsed
    /// as axios does (JSON when it parses, the text otherwise).
    pub(super) async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        extra: &[(&str, &str)],
    ) -> Result<Value, CallError> {
        let url = combine_url(&self.base, path);
        let mut req = self
            .client
            .request(method, url)
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .header("Authorization", self.authorization.as_str());
        for (name, value) in extra {
            req = req.header(*name, *value);
        }
        if let Some(body) = body {
            req = req.body(serde_json::to_vec(body).unwrap_or_default());
        }
        if let Some(timeout) = self.timeout {
            req = req.timeout(timeout);
        }
        axios_send(req).await
    }
}

/// Send a request and read the answer the way axios does.
pub(super) async fn axios_send(req: reqwest::RequestBuilder) -> Result<Value, CallError> {
    let res = req
        .send()
        .await
        .map_err(|e| CallError::NoResponse(crate::outbound::describe(&e)))?;
    let status = res.status();
    let bytes = res
        .bytes()
        .await
        .map_err(|e| CallError::NoResponse(crate::outbound::describe(&e)))?;
    if !status.is_success() {
        return Err(CallError::Status(status.as_u16()));
    }
    Ok(axios_data(&bytes))
}

/// axios's default `transformResponse`: JSON when it parses, the text
/// otherwise.
pub(super) fn axios_data(bytes: &[u8]) -> Value {
    let text = String::from_utf8_lossy(bytes);
    if text.is_empty() {
        return Value::String(String::new());
    }
    serde_json::from_str(&text).unwrap_or_else(|_| Value::String(text.into_owned()))
}

/// `value.key` in JavaScript: `Err` where it throws (`null`), `None`
/// where it is `undefined`.
pub(super) fn prop<'v>(value: &'v Value, key: &str) -> Result<Option<&'v Value>, ()> {
    match value {
        Value::Null => Err(()),
        Value::Object(map) => Ok(map.get(key)),
        Value::Bool(_) | Value::Number(_) | Value::String(_) | Value::Array(_) => Ok(None),
    }
}

/// Assign `obj.key = value` and let `JSON.stringify` drop `undefined`.
pub(super) fn assign(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    match value {
        Some(value) => {
            map.insert(key.to_owned(), crate::tmdb::js_numbers(value));
        }
        None => {
            map.shift_remove(key);
        }
    }
}

/// A date column value for an INSERT or UPDATE: `TypeORM` writes
/// `YYYY-MM-DD HH:MM:SS.SSS` on `SQLite` and a timestamp on Postgres.
pub(super) fn date_param(db: &Db, n: usize) -> String {
    if db.is_postgres() {
        format!("CAST(?{n} AS timestamptz)")
    } else {
        format!("?{n}")
    }
}

/// The bound value for [`date_param`].
pub(super) fn date_bind(db: &Db, ms: i64) -> Bind {
    let t = crate::clock::Utc::from_unix_millis(ms);
    Bind::Text(if db.is_postgres() {
        t.iso_string()
    } else {
        t.typeorm_string()
    })
}

/// Lowercase hex of some bytes.
pub(super) fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        for nibble in [b >> 4, b & 0x0F] {
            if let Some(&d) = DIGITS.get(usize::from(nibble)) {
                out.push(char::from(d));
            }
        }
    }
    out
}

/// `count` random bytes.
pub(super) fn random_bytes(count: usize) -> Result<Vec<u8>, String> {
    let mut bytes = vec![0_u8; count];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes)
        .map_err(|_| String::from("no randomness"))?;
    Ok(bytes)
}

/// The UTF-16 length JavaScript reports.
pub(super) fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `Bun.password.hash(password, { algorithm: 'bcrypt', cost: 12 })`.
pub(super) async fn hash_password(password: String) -> Result<String, String> {
    crate::typeorm::hash_password(password)
        .await
        .map_err(|e| format!("hashing: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn picks_the_client_ip() {
        assert_eq!(
            first_ip("garbage, 10.0.0.2:5000, 1.2.3.4").as_deref(),
            Some("10.0.0.2"),
            "port removed"
        );
        assert_eq!(
            first_ip("::ffff:1.2.3.4").as_deref(),
            Some("::ffff:1.2.3.4"),
            "v6 kept whole"
        );
        assert_eq!(
            first_ip("fe80::1%eth0, 1.2.3.4"),
            None,
            "zone ids are not supported"
        );
        assert_eq!(
            first_ip("01.2.3.4, 5.6.7.8").as_deref(),
            Some("5.6.7.8"),
            "leading zeros"
        );
    }

    #[test]
    fn hostnames_like_template_literals() {
        assert_eq!(
            hostname_of(
                Some(&json!(false)),
                Some(&json!("10.0.0.5")),
                Some(&json!(8096.0)),
                Some(&json!("/jf"))
            ),
            "http://10.0.0.5:8096/jf",
            "settings"
        );
        assert_eq!(
            hostname_of(Some(&json!(true)), Some(&json!("h")), None, None),
            "https://h:undefinedundefined",
            "undefined parts"
        );
        assert_eq!(
            hostname_of(
                None,
                Some(&json!("h")),
                Some(&json!("8920")),
                Some(&json!(""))
            ),
            "http://h:8920",
            "a port sent as text"
        );
        assert_eq!(
            combine_url("http://h:1//", "/Users/Me"),
            "http://h:1/Users/Me",
            "combine"
        );
        assert_eq!(
            combine_url("http://h:1///", "x"),
            "http://h:1//x",
            "two slashes only"
        );
    }

    #[test]
    fn authorization_header() {
        assert_eq!(
            authorization(None, None, "1.0.0"),
            r#"MediaBrowser Client="Foreseerr", Device="Foreseerr", DeviceId="Qk9UX3NlZXJy", Version="1.0.0""#,
            "default device"
        );
        assert_eq!(
            authorization(Some("tok"), Some("dev"), "0.13.1"),
            r#"MediaBrowser Client="Foreseerr", Device="Foreseerr", DeviceId="dev", Version="0.13.1", Token="tok""#,
            "token"
        );
    }

    #[test]
    fn entity_json_order() {
        let mut e = Entity::default();
        e.set("plexId", json!(5));
        e.set("id", json!(1));
        e.set("warnings", json!([]));
        assert_eq!(
            serde_json::to_string(&e.public_json()).unwrap_or_default(),
            r#"{"id":1,"warnings":[],"plexId":5}"#,
            "toPublicJSON order, undefined dropped"
        );
        assert_eq!(
            avatar_url(Some(&json!("abc")), None),
            "/avatarproxy/abc?v=undefined",
            "new user"
        );
        assert_eq!(
            avatar_url(Some(&json!("abc")), Some(&Value::Null)),
            "/avatarproxy/abc?v=null",
            "loaded user"
        );
    }

    #[test]
    fn axios_bodies() {
        assert_eq!(axios_data(b""), json!(""), "empty");
        assert_eq!(axios_data(b"{\"a\":1}"), json!({"a": 1}), "json");
        assert_eq!(axios_data(b"<html>"), json!("<html>"), "text");
        assert_eq!(js_length("a\u{1F600}"), 3, "utf-16 length");
        assert_eq!(hex(&[0, 255, 16]), "00ff10", "hex");
    }
}
