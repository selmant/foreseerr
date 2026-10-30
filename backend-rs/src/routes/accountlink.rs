//! Linking media-server accounts from `server/routes/user/usersettings.ts`:
//! `POST .../linked-accounts/plex`, `/jellyfin`, `/jellyfin/quickconnect`,
//! and `POST .../linked-accounts/simkl/sync`.

use axum::body::Body;
use axum::http::{Method, Response, StatusCode};
use serde_json::{json, Map, Value};

use super::authcommon::{
    authorization, axios_send, base64, client_ip, client_version, current_type, settings_hostname,
    CallError, Jellyfin, Native, EMBY, JELLYFIN, PLEX, USER_EMBY, USER_JELLYFIN, USER_PLEX,
};
use super::{Outcome, Ready, Table};
use crate::auth::CurrentUser;
use crate::db::Bind;
use crate::typeorm::{self, Changes};

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    (
        "/api/v1/user/{id}/settings/linked-accounts/plex",
        Method::POST,
        plex_link,
    ),
    (
        "/api/v1/user/{id}/settings/linked-accounts/jellyfin",
        Method::POST,
        jellyfin_link,
    ),
    (
        "/api/v1/user/{id}/settings/linked-accounts/jellyfin/quickconnect",
        Method::POST,
        quickconnect_link,
    ),
    (
        "/api/v1/user/{id}/settings/linked-accounts/simkl/sync",
        Method::POST,
        simkl_sync,
    ),
];

/// `Permission.MANAGE_USERS`.
const MANAGE_USERS: i64 = 8;
const ALREADY_LINKED: &str = "The specified account is already linked to a Seerr user";

macro_rules! try_outcome {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(outcome) => return *outcome,
        }
    };
}

/// Which profile middleware guards a route.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Guard {
    /// `isOwnProfile()`.
    Own,
    /// `isOwnProfileOrAdmin()`.
    OwnOrAdmin,
}

/// The `:id` route parameter: the decoded segment and `Number()` of it.
#[derive(Debug, Clone)]
pub(super) struct UserParam {
    pub(super) raw: String,
    pub(super) number: f64,
}

/// `isAuthenticated()` (answered by `require` once the validator ran) and
/// the profile middleware with its error-handler 403. A request the
/// validator didn't judge goes to Node.
pub(super) fn guard<'a>(
    ctx: &'a Ready<'a>,
    guard: Guard,
) -> Result<(&'a CurrentUser, UserParam), Box<Outcome>> {
    let viewer = ctx.require(0)?;
    if !ctx.passed() {
        return Err(Box::new(forward("the validator didn't judge this request")));
    }
    let segment = ctx.req.uri.path().split('/').nth(4).unwrap_or("");
    let raw = crate::jsval::decode_uri_component(segment)
        .ok_or_else(|| Box::new(forward("a path id Express can't decode")))?;
    let number = crate::jsval::number_of_str(&raw);
    let own = js_eq(crate::jsnum::from_i64(viewer.id), number);
    let allowed = match guard {
        Guard::Own => own,
        Guard::OwnOrAdmin => own || viewer.has_permission(MANAGE_USERS),
    };
    if !allowed {
        return Err(Box::new(ctx.error(
            403,
            "You do not have permission to view this user's settings.",
        )));
    }
    Ok((viewer, UserParam { raw, number }))
}

/// `Outcome::Forward`.
pub(super) fn forward(why: &str) -> Outcome {
    Outcome::forward(why.to_owned())
}

/// JavaScript `===` between numbers.
pub(super) fn js_eq(a: f64, b: f64) -> bool {
    a.partial_cmp(&b) == Some(std::cmp::Ordering::Equal)
}

/// `req.body` as the validator left it, as an object.
pub(super) fn validated_body<'a>(
    ctx: &'a Ready<'a>,
) -> Result<&'a Map<String, Value>, Box<Outcome>> {
    match ctx.validated().and_then(|v| v.body.as_ref()) {
        Some(Value::Object(map)) => Ok(map),
        _ => Err(Box::new(forward("a body that isn't an object"))),
    }
}

/// An optional string body field; anything else is the validator's.
fn optional_text<'a>(
    body: &'a Map<String, Value>,
    key: &str,
) -> Result<Option<&'a str>, Box<Outcome>> {
    match body.get(key) {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(_) => Err(Box::new(forward(&format!("{key} is the validator's")))),
    }
}

/// `res.status(status).send()`: no body.
fn empty(status: u16) -> Outcome {
    let mut res = Response::new(Body::empty());
    *res.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    Outcome::Done(res)
}

/// The signed-in user's row as `req.user` holds it.
async fn user_row(ctx: &Ready<'_>, id: i64) -> Result<Map<String, Value>, Box<Outcome>> {
    let rows = ctx
        .state
        .db
        .rows(
            r#"SELECT CAST("id" AS BIGINT) AS "id", "email", "username", CAST("userType" AS BIGINT) AS "userType", CAST("plexId" AS BIGINT) AS "plexId", "plexUsername", "jellyfinUserId", "jellyfinUsername" FROM "user" WHERE "id" = ?1"#,
            &[Bind::Int(id)],
        )
        .await
        .map_err(|e| Box::new(forward(&format!("database: {e:#}"))))?;
    rows.into_iter()
        .next()
        .ok_or_else(|| Box::new(forward("the signed-in user vanished")))
}

/// `userRepository.exist({ where })` with `id: Not(me)`; `None` columns
/// are `undefined` and drop out of the condition.
async fn exists_other(
    ctx: &Ready<'_>,
    column: &str,
    value: Option<&str>,
    me: i64,
) -> anyhow::Result<bool> {
    let count = match value {
        Some(value) => {
            let sql =
                format!(r#"SELECT COUNT(*) FROM "user" WHERE "{column}" = ?1 AND "id" != ?2"#);
            ctx.state
                .db
                .scalar(&sql, &[Bind::Text(value.to_owned()), Bind::Int(me)])
                .await?
        }
        None => {
            ctx.state
                .db
                .scalar(
                    r#"SELECT COUNT(*) FROM "user" WHERE "id" != ?1"#,
                    &[Bind::Int(me)],
                )
                .await?
        }
    };
    Ok(count > 0)
}

/// `userRepository.save(req.user)`: visible columns compare with the row,
/// hidden ones (not loaded) always count as changed.
async fn save_user(
    ctx: &Ready<'_>,
    row: &Map<String, Value>,
    id: i64,
    visible: &[(&'static str, Option<Value>)],
    hidden: &[(&'static str, Option<Value>)],
) -> anyhow::Result<()> {
    let mut changes = Changes::default();
    for (column, value) in visible {
        changes.assign(
            column,
            value.as_ref(),
            row.get(*column).unwrap_or(&Value::Null),
        );
    }
    for (column, value) in hidden {
        if let Some(value) = value {
            changes.set(column, value.clone());
        }
    }
    typeorm::run(&ctx.state.db, changes.update_sql("user", id, true)?).await
}

// ---------------------------------------------------------------------------
// Plex
// ---------------------------------------------------------------------------

fn plex_link<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let (viewer, _) = try_outcome!(guard(ctx, Guard::Own));
        let body = try_outcome!(validated_body(ctx));
        let Some(Value::String(plex_token)) = body.get("authToken") else {
            return Outcome::forward(String::from("authToken is the validator's"));
        };
        if current_type(ctx) != Some(PLEX) {
            return ctx.error(500, "Plex login is disabled");
        }
        let req = ctx
            .state
            .outbound
            .get("https://plex.tv/users/account.json")
            .header("X-Plex-Token", plex_token.as_str())
            .header("Content-Type", "application/json")
            .header("Accept", "application/json");
        let data = match axios_send(req).await {
            Ok(data) => data,
            Err(e) => {
                tracing::error!(
                    label = "Plex.tv API",
                    "Something went wrong while getting the account from plex.tv: {e:?}"
                );
                // The route doesn't catch: the error handler answers.
                return ctx.error(500, "Invalid auth token");
            }
        };
        // `getUser()` returns `account.data.user`; the handler then reads
        // `account.id`.
        let account = match (&data, data.get("user")) {
            (_, Some(Value::Object(account))) => account,
            // `null.user` throws inside `getUser`'s try.
            (Value::Null, _) => return ctx.error(500, "Invalid auth token"),
            _ => return ctx.error(500, "plex.tv answered without a user."),
        };
        let plex_id = match account.get("id") {
            None => None,
            Some(v) => match v.as_i64() {
                Some(n) => Some(n),
                None => {
                    return Outcome::forward(String::from("a plex.tv id that isn't an integer"))
                }
            },
        };
        let scalar = |key: &str| match account.get(key) {
            None => Ok(None),
            Some(v @ (Value::String(_) | Value::Null)) => Ok(Some(v.clone())),
            Some(_) => Err(Box::new(forward(&format!(
                "a plex.tv {key} of another type"
            )))),
        };
        let username = try_outcome!(scalar("username"));
        let auth_token = try_outcome!(scalar("authToken"));
        let taken = match plex_id {
            Some(plex_id) => {
                ctx.state
                    .db
                    .scalar(
                        r#"SELECT COUNT(*) FROM "user" WHERE "plexId" = ?1"#,
                        &[Bind::Int(plex_id)],
                    )
                    .await
            }
            // `where: { plexId: undefined }` matches every user.
            None => {
                ctx.state
                    .db
                    .scalar(r#"SELECT COUNT(*) FROM "user""#, &[])
                    .await
            }
        };
        match taken {
            Ok(0) => {}
            Ok(_) => {
                return ctx.error(422, "This Plex account is already linked to a Seerr user");
            }
            Err(e) => return ctx.error(500, &format!("{e:#}")),
        }
        let row = try_outcome!(user_row(ctx, viewer.id).await);
        if row.get("email").and_then(Value::as_str) != account.get("email").and_then(Value::as_str)
        {
            return ctx.error(
                422,
                "This Plex account is registered under a different email address.",
            );
        }
        let saved = save_user(
            ctx,
            &row,
            viewer.id,
            &[
                ("userType", Some(Value::from(USER_PLEX))),
                ("plexId", plex_id.map(Value::from)),
                ("plexUsername", username),
            ],
            &[("plexToken", auth_token)],
        )
        .await;
        match saved {
            Ok(()) => Ready::no_content(),
            Err(e) => ctx.error(500, &format!("{e:#}")),
        }
    })
}

// ---------------------------------------------------------------------------
// Jellyfin
// ---------------------------------------------------------------------------

/// What `jellyfinserver.login()` threw: an `ApiError` with
/// `INVALID_CREDENTIALS`, or anything else (the route's bare 500).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LoginError {
    InvalidCredentials,
    Other,
}

/// `JellyfinAPI.login(username, password, clientIp)`: once with
/// `X-Forwarded-For` (when there is an address), then once without unless
/// the first answer settles it.
async fn login(
    jf: &Jellyfin<'_>,
    username: Option<&str>,
    password: Option<&str>,
    client_ip: Option<&str>,
) -> Result<Value, LoginError> {
    let mut body = Map::new();
    if let Some(username) = username {
        body.insert(String::from("Username"), Value::from(username));
    }
    if let Some(password) = password {
        body.insert(String::from("Pw"), Value::from(password));
    }
    let body = Value::Object(body);
    let path = "/Users/AuthenticateByName";
    let first = match client_ip {
        Some(ip) => {
            jf.call(Method::POST, path, Some(&body), &[("X-Forwarded-For", ip)])
                .await
        }
        None => jf.call(Method::POST, path, Some(&body), &[]).await,
    };
    match first {
        Ok(data) => return Ok(data),
        // `ApiError(404, InvalidUrl)`.
        Err(CallError::NoResponse(_)) => return Err(LoginError::Other),
        Err(CallError::Status(401)) => return Err(LoginError::InvalidCredentials),
        Err(CallError::Status(_)) => {}
    }
    match jf.call(Method::POST, path, Some(&body), &[]).await {
        Ok(data) => Ok(data),
        Err(CallError::Status(401)) => Err(LoginError::InvalidCredentials),
        Err(e) => {
            tracing::error!(
                label = "Jellyfin API",
                "Something went wrong while authenticating with the Jellyfin server: {e:?}"
            );
            Err(LoginError::Other)
        }
    }
}

/// `req.ip` narrowed as the link route does: IPv4 as it is, IPv6 without
/// a `::ffff:` prefix, anything else `undefined`.
fn link_client_ip(ctx: &Ready<'_>) -> Result<Option<String>, Box<Outcome>> {
    let ip = client_ip(ctx).map_err(|why| Box::new(forward(&why)))?;
    if ip.parse::<std::net::Ipv4Addr>().is_ok() {
        return Ok(Some(ip));
    }
    if ip.parse::<std::net::Ipv6Addr>().is_ok() {
        return Ok(Some(ip.strip_prefix("::ffff:").unwrap_or(&ip).to_owned()));
    }
    Ok(None)
}

/// The link routes' device id: base64 of `BOT_seerr` for the owner,
/// `BOT_seerr_<username>` for everyone else.
fn device_id(row: &Map<String, Value>, id: i64) -> String {
    if id == 1 {
        return base64("BOT_seerr");
    }
    let username = match row.get("username") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => crate::jsnum::value_string(Some(other)),
    };
    base64(&format!("BOT_seerr_{username}"))
}

/// The parts of a `JellyfinLoginResponse` the link routes store.
#[derive(Debug, Clone)]
struct LinkAccount {
    /// `account.User.Id`; `None` when undefined.
    id: Option<String>,
    /// `account.User.Name`; `None` when undefined.
    name: Option<Value>,
    /// `account.AccessToken`; `None` when undefined.
    access_token: Option<Value>,
}

/// The answer in the shapes followed here. `Err(true)`: a `TypeError`
/// inside the route's `try` (its bare 500); `Err(false)`: a shape not
/// reproduced.
fn link_account(data: &Value) -> Result<LinkAccount, bool> {
    let user = match data {
        Value::Object(map) => match map.get("User") {
            Some(Value::Object(user)) => user,
            None => return Err(true),
            Some(_) => return Err(false),
        },
        Value::String(_) => return Err(true),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::Array(_) => return Err(false),
    };
    let id = match user.get("Id") {
        None => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => return Err(false),
    };
    let scalar = |v: Option<&Value>| match v {
        None => Ok(None),
        Some(v @ (Value::String(_) | Value::Null)) => Ok(Some(v.clone())),
        Some(_) => Err(false),
    };
    Ok(LinkAccount {
        id,
        name: scalar(user.get("Name"))?,
        access_token: scalar(data.get("AccessToken"))?,
    })
}

/// The shared tail of both Jellyfin link routes: the linked-elsewhere
/// check and the save. `Err` is the route's catch.
async fn store_link(
    ctx: &Ready<'_>,
    row: &Map<String, Value>,
    me: i64,
    account: LinkAccount,
    user_type: i64,
    device: String,
) -> Result<Outcome, String> {
    let taken = exists_other(ctx, "jellyfinUserId", account.id.as_deref(), me)
        .await
        .map_err(|e| format!("{e:#}"))?;
    if taken {
        return Ok(ctx.error(422, ALREADY_LINKED));
    }
    save_user(
        ctx,
        row,
        me,
        &[
            ("userType", Some(Value::from(user_type))),
            ("jellyfinUserId", account.id.map(Value::from)),
            ("jellyfinUsername", account.name),
        ],
        &[
            ("jellyfinAuthToken", account.access_token),
            ("jellyfinDeviceId", Some(Value::from(device))),
        ],
    )
    .await
    .map_err(|e| format!("{e:#}"))?;
    Ok(Ready::no_content())
}

fn jellyfin_link<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let (viewer, _) = try_outcome!(guard(ctx, Guard::Own));
        let body = try_outcome!(validated_body(ctx));
        let username = try_outcome!(optional_text(body, "username"));
        let password = try_outcome!(optional_text(body, "password"));
        let server = current_type(ctx);
        if server != Some(JELLYFIN) && server != Some(EMBY) {
            return ctx.error(500, "Jellyfin/Emby login is disabled");
        }
        match exists_other(ctx, "jellyfinUsername", username, viewer.id).await {
            Ok(false) => {}
            Ok(true) => return ctx.error(422, ALREADY_LINKED),
            Err(e) => return ctx.error(500, &format!("{e:#}")),
        }
        let row = try_outcome!(user_row(ctx, viewer.id).await);
        let device = device_id(&row, viewer.id);
        let ip = try_outcome!(link_client_ip(ctx));
        let jf = Jellyfin::new(
            &ctx.state.outbound,
            &settings_hostname(ctx),
            authorization(None, Some(&device), &client_version(ctx, server)),
            None,
        );
        let caught = |why: &str| {
            tracing::error!(label = "API", "Failed to link account to user. {why}");
            empty(500)
        };
        let data = match login(&jf, username, password, ip.as_deref()).await {
            Ok(data) => data,
            Err(LoginError::InvalidCredentials) => {
                tracing::error!(label = "API", "Failed to link account to user.");
                return ctx.json_with(401, &json!({ "code": "INVALID_CREDENTIALS" }));
            }
            Err(LoginError::Other) => return caught("the Jellyfin login failed"),
        };
        let account = match link_account(&data) {
            Ok(account) => account,
            Err(true) => return caught("the login answer has no User"),
            // Jellyfin has signed in: answered here, not replayed.
            Err(false) => return caught("a Jellyfin login answer of another shape"),
        };
        let user_type = if server == Some(EMBY) {
            USER_EMBY
        } else {
            USER_JELLYFIN
        };
        match store_link(ctx, &row, viewer.id, account, user_type, device).await {
            Ok(outcome) => outcome,
            Err(why) => caught(&why),
        }
    })
}

/// `quickConnectSecret`: 8 to 128 hex digits.
fn valid_secret(secret: &str) -> bool {
    (8..=128).contains(&secret.len()) && secret.bytes().all(|b| b.is_ascii_hexdigit())
}

fn quickconnect_link<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let (viewer, _) = try_outcome!(guard(ctx, Guard::Own));
        let body = try_outcome!(validated_body(ctx));
        let secret = match body.get("secret") {
            Some(Value::String(s)) if valid_secret(s) => s.clone(),
            Some(Value::String(_)) | None => return ctx.error(400, "Invalid secret format"),
            Some(_) => return Outcome::forward(String::from("secret is the validator's")),
        };
        let server = current_type(ctx);
        if server != Some(JELLYFIN) && server != Some(EMBY) {
            return ctx.error(500, "Jellyfin/Emby login is disabled");
        }
        if server != Some(JELLYFIN) {
            return ctx.error(403, "Quick Connect is only supported by Jellyfin.");
        }
        let jf = Jellyfin::new(
            &ctx.state.outbound,
            &settings_hostname(ctx),
            authorization(None, None, &client_version(ctx, server)),
            None,
        );
        let caught = |status: u16, why: &str| {
            tracing::error!(
                label = "API",
                "Failed to link account with Quick Connect. {why}"
            );
            empty(status)
        };
        let mut payload = Map::new();
        payload.insert(String::from("Secret"), Value::from(secret));
        let result = jf
            .call(
                Method::POST,
                "/Users/AuthenticateWithQuickConnect",
                Some(&Value::Object(payload)),
                &[],
            )
            .await;
        let data = match result {
            Ok(data) => data,
            Err(CallError::NoResponse(e)) => return caught(502, &e),
            Err(CallError::Status(status)) => {
                return caught(status, "Jellyfin refused the Quick Connect secret")
            }
        };
        let account = match link_account(&data) {
            Ok(account) => account,
            Err(true) => return caught(500, "the answer has no User"),
            // The secret is spent: answered here, not replayed.
            Err(false) => return caught(500, "a Quick Connect answer of another shape"),
        };
        let row = match user_row(ctx, viewer.id).await {
            Ok(row) => row,
            Err(outcome) => match *outcome {
                Outcome::Forward(why) => return caught(500, &why.why),
                done @ Outcome::Done(_) => return done,
            },
        };
        let device = device_id(&row, viewer.id);
        match store_link(ctx, &row, viewer.id, account, USER_JELLYFIN, device).await {
            Ok(outcome) => outcome,
            Err(why) => caught(500, &why),
        }
    })
}

// ---------------------------------------------------------------------------
// Simkl sync
// ---------------------------------------------------------------------------

/// `POST .../linked-accounts/simkl/sync`: `syncSimklUser(id, true)`, 503
/// when the result is stale.
///
/// With Node behind, Node runs it (its per-user lock and throttle live
/// there). Standalone, it goes through the same in-process seam the
/// Simkl discover route uses (`/internal/simkl/sync`, the node-state
/// port).
fn simkl_sync<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let (_, param) = try_outcome!(guard(ctx, Guard::OwnOrAdmin));
        if !crate::standalone::enabled() {
            return Outcome::forward(String::from("the Simkl sync is not available"));
        }
        let body = json!({ "userId": crate::jsnum::json(param.number), "force": true });
        let answer =
            crate::standalone::internal::call(ctx.state, &Method::POST, "/simkl/sync", Some(&body))
                .await;
        if !answer.is_success() {
            // A rejection reaches the error handler: `{ message }`.
            let message = answer
                .body
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("syncSimklUser failed");
            return ctx.error(answer.status, message);
        }
        let stale = crate::settings::public::truthy(answer.body.get("stale"));
        ctx.json_with(if stale { 503 } else { 200 }, &answer.body)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_answers_read_like_node() {
        let ok = link_account(&json!({"User": {"Id": "a", "Name": null}, "AccessToken": "t"}));
        assert!(
            ok.is_ok_and(|a| a.id.as_deref() == Some("a")
                && a.name == Some(Value::Null)
                && a.access_token == Some(Value::from("t"))),
            "a login answer"
        );
        assert!(
            matches!(link_account(&json!("text")), Err(true)),
            "text has no User"
        );
        assert!(
            matches!(link_account(&json!({"AccessToken": "t"})), Err(true)),
            "no User"
        );
        assert!(
            link_account(&json!({"User": {}})).is_ok_and(|a| a.id.is_none()),
            "an undefined id"
        );
        assert!(valid_secret("abcdef12"), "eight hex digits");
        assert!(!valid_secret("abcdefg1"), "not hex");
        assert!(!valid_secret("abc"), "too short");
        let row: Map<String, Value> =
            serde_json::from_value(json!({"username": null})).unwrap_or_default();
        assert_eq!(device_id(&row, 1), base64("BOT_seerr"), "the owner");
        assert_eq!(device_id(&row, 5), base64("BOT_seerr_"), "no username");
    }
}
