//! `POST /auth/plex`: a Plex token sign-in.
//!
//! On an empty database it makes the first admin and switches the server
//! to Plex; otherwise it signs in users with access to the configured
//! server, creating them when `newPlexLogin` allows.

use axum::http::Method;
use serde_json::Value;

use super::authcommon::{
    default_permissions, error_body, finish, media_server_type, signed_in, start_jobs, update_user,
    user_count, Entity, Native, NewUser, Step, NOT_CONFIGURED, PLEX, USER_PLEX,
};
use super::{Ready, Table, ADMIN};
use crate::db::Bind;
use crate::settings::public::truthy;

/// This module's routes.
pub(super) const ROUTES: &Table = &[("/api/v1/auth/plex", Method::POST, plex)];

/// `PlexTvAPI`'s base URL.
const PLEX_TV: &str = "https://plex.tv";

fn plex<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move { finish(run(ctx).await) })
}

/// The `plex.tv` account the token belongs to.
#[derive(Debug, Clone)]
struct Account {
    id: i64,
    email: String,
    username: String,
    thumb: String,
    auth_token: String,
}

/// Why the account couldn't be used.
enum AccountError {
    /// Node's handler catches it: 500 `Unable to authenticate.`
    Unable(String),
    /// A shape this port doesn't follow.
    Forward(String),
}

/// `new PlexTvAPI(token)`'s request headers on a GET.
fn plex_get(ctx: &Ready<'_>, path: &str, token: &str) -> reqwest::RequestBuilder {
    ctx.state
        .outbound
        .get(format!("{PLEX_TV}{path}"))
        .header("X-Plex-Token", token)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
}

/// `plextv.getUser()` and what the handler reads from it before writing.
async fn account(ctx: &Ready<'_>, token: &str) -> Result<Account, AccountError> {
    let data = super::authcommon::axios_send(plex_get(ctx, "/users/account.json", token))
        .await
        .map_err(|e| {
            AccountError::Unable(format!(
                "Something went wrong while getting the account from plex.tv: {e:?}"
            ))
        })?;
    let user = match &data {
        Value::Object(map) => map.get("user"),
        Value::Null => {
            return Err(AccountError::Unable(String::from(
                "the account answer is null",
            )))
        }
        Value::Bool(_) | Value::Number(_) | Value::String(_) | Value::Array(_) => None,
    };
    let Some(Value::Object(user)) = user else {
        return Err(AccountError::Unable(String::from(
            "the account answer has no user",
        )));
    };
    let Some(Value::String(email)) = user.get("email") else {
        return Err(AccountError::Unable(String::from(
            "the account has no email to lowercase",
        )));
    };
    let text = |key: &str| match user.get(key) {
        Some(Value::String(s)) => Ok(s.clone()),
        _ => Err(AccountError::Forward(format!(
            "plex.tv account {key} isn't a string"
        ))),
    };
    let id = user.get("id").and_then(Value::as_i64).ok_or_else(|| {
        AccountError::Forward(String::from("plex.tv account id isn't an integer"))
    })?;
    Ok(Account {
        id,
        email: email.clone(),
        username: text("username")?,
        thumb: text("thumb")?,
        auth_token: text("authToken")?,
    })
}

async fn run(ctx: &Ready<'_>) -> Step {
    ctx.no_query()?;
    let Some(Value::Object(body)) = &ctx.body else {
        return Err(String::from("a body that isn't an object").into());
    };
    let Some(Value::String(token)) = body.get("authToken") else {
        return Err(String::from("authToken is the validator's").into());
    };
    if token.is_empty() {
        return Ok(ctx.error(500, "Authentication token required."));
    }
    let server_type = media_server_type(ctx)?;
    if server_type != NOT_CONFIGURED
        && (ctx.settings.get("/main/mediaServerLogin") == Some(&Value::Bool(false))
            || server_type != PLEX)
    {
        return Ok(error_body(ctx, 500, "Plex login is disabled"));
    }
    let account = match account(ctx, token).await {
        Ok(account) => account,
        Err(AccountError::Unable(why)) => return Ok(unable(ctx, &why)),
        Err(AccountError::Forward(why)) => return Err(why.into()),
    };
    let db = &ctx.state.db;
    let db_err = |e: anyhow::Error| format!("database: {e:#}");
    let found = db
        .rows(
            r#"SELECT CAST("id" AS BIGINT) AS "id" FROM "user" WHERE "plexId" = ?1 OR "email" = ?2"#,
            &[
                Bind::Int(account.id),
                Bind::Text(account.email.to_lowercase()),
            ],
        )
        .await
        .map_err(db_err)?
        .first()
        .and_then(|r| r.get("id"))
        .and_then(Value::as_i64);
    let user = match found {
        Some(id) => Some(
            Entity::find_bare(db, id)
                .await
                .map_err(db_err)??
                .ok_or_else(|| String::from("the user vanished"))?,
        ),
        None => None,
    };
    if user.is_none() && user_count(db).await.map_err(db_err)? == 0 {
        return first_user(ctx, &account).await;
    }
    existing(ctx, &account, token, user).await
}

/// The handler's catch: logged, then 500.
fn unable(ctx: &Ready<'_>, why: &str) -> super::Outcome {
    tracing::error!("Something went wrong authenticating with Plex account: {why}");
    ctx.error(500, "Unable to authenticate.")
}

/// No users yet: settings switch to Plex, then the admin is created.
async fn first_user(ctx: &Ready<'_>, account: &Account) -> Step {
    let mut data = ctx.settings.data().clone();
    let Some(main) = data.get_mut("main").and_then(Value::as_object_mut) else {
        return Err(String::from("settings.main isn't an object").into());
    };
    main.insert(String::from("mediaServerType"), Value::from(PLEX));
    if let Err(e) = ctx.save_settings(&data).await {
        return Ok(unable(ctx, &format!("{e:#}")));
    }
    let new_user = NewUser {
        email: Some(account.email.clone()),
        plex_username: Some(account.username.clone()),
        plex_id: Some(account.id),
        plex_token: Some(account.auth_token.clone()),
        permissions: ADMIN,
        avatar: account.thumb.clone(),
        user_type: USER_PLEX,
        ..NewUser::default()
    };
    let entity = match new_user.insert(&ctx.state.db).await {
        Ok(entity) => entity,
        Err(e) => return Ok(unable(ctx, &format!("{e:#}"))),
    };
    start_jobs(ctx).await;
    respond(ctx, &entity).await
}

/// The session and the user, as the handler ends.
async fn respond(ctx: &Ready<'_>, entity: &Entity) -> Step {
    let Some(id) = entity.get("id").and_then(Value::as_i64) else {
        return Ok(ctx.error(500, "Unable to authenticate."));
    };
    Ok(signed_in(ctx, id, &entity.public_json()).await)
}

/// The admin's id, Plex token, Plex id and email.
#[derive(Debug, Clone, Default)]
struct MainUser {
    plex_token: String,
    plex_id: Option<i64>,
    email: String,
}

/// `findOneOrFail({ select: { id, plexToken, plexId, email }, where: { id: 1 } })`.
async fn main_user(ctx: &Ready<'_>) -> anyhow::Result<Option<MainUser>> {
    let rows = ctx
        .state
        .db
        .rows(
            r#"SELECT "plexToken", CAST("plexId" AS BIGINT) AS "plexId", "email" FROM "user" WHERE "id" = 1"#,
            &[],
        )
        .await?;
    Ok(rows.first().map(|r| MainUser {
        plex_token: r
            .get("plexToken")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        plex_id: r.get("plexId").and_then(Value::as_i64),
        email: r
            .get("email")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase(),
    }))
}

/// Users exist: sign in someone with access to the admin's server.
async fn existing(ctx: &Ready<'_>, account: &Account, token: &str, user: Option<Entity>) -> Step {
    let main = match main_user(ctx).await {
        Ok(Some(main)) => main,
        Ok(None) => return Ok(unable(ctx, "the admin user is missing")),
        Err(e) => return Err(format!("database: {e:#}").into()),
    };
    if account.id == 0 {
        tracing::error!("Plex ID was missing from Plex.tv response");
        return Ok(ctx.error(500, "Something went wrong. Try again."));
    }
    let access = account.id == main.plex_id.unwrap_or_default() && main.plex_id.is_some()
        || (account.email == main.email && main.plex_id.unwrap_or_default() == 0)
        || check_user_access(ctx, &main.plex_token, account.id).await?;
    if !access {
        tracing::warn!("Failed sign-in attempt by Plex user without access to the media server");
        return Ok(ctx.error(403, "Access denied."));
    }
    if let Some(mut entity) = user {
        let Some(id) = entity.get("id").and_then(Value::as_i64) else {
            return Err(String::from("the user has no id").into());
        };
        let sets = vec![
            ("plexToken", Bind::Text(token.to_owned())),
            ("plexId", Bind::Int(account.id)),
            ("avatar", Bind::Text(account.thumb.clone())),
            ("email", Bind::Text(account.email.to_lowercase())),
            ("plexUsername", Bind::Text(account.username.clone())),
            ("userType", Bind::Int(USER_PLEX)),
        ];
        let updated_at = match update_user(&ctx.state.db, id, sets).await {
            Ok(updated_at) => updated_at,
            Err(e) => return Ok(unable(ctx, &format!("{e:#}"))),
        };
        entity.set("plexId", Value::from(account.id));
        entity.set("avatar", Value::from(account.thumb.as_str()));
        entity.set("email", Value::from(account.email.as_str()));
        entity.set("plexUsername", Value::from(account.username.as_str()));
        entity.set("userType", Value::from(USER_PLEX));
        entity.set("updatedAt", updated_at);
        return respond(ctx, &entity).await;
    }
    if !truthy(ctx.settings.get("/main/newPlexLogin")) {
        tracing::warn!(
            "Failed sign-in attempt by unimported Plex user with access to the media server"
        );
        return Ok(ctx.error(403, "Access denied."));
    }
    let new_user = NewUser {
        email: Some(account.email.clone()),
        plex_username: Some(account.username.clone()),
        plex_id: Some(account.id),
        plex_token: Some(account.auth_token.clone()),
        permissions: default_permissions(ctx)?,
        avatar: account.thumb.clone(),
        user_type: USER_PLEX,
        ..NewUser::default()
    };
    match new_user.insert(&ctx.state.db).await {
        Ok(entity) => respond(ctx, &entity).await,
        Err(e) => Ok(unable(ctx, &format!("{e:#}"))),
    }
}

/// `mainPlexTv.checkUserAccess(userId)`: whether the user shares the
/// configured server. Failures are `false`, as in Node; XML this parser
/// isn't sure about goes to Node (nothing has been written yet).
async fn check_user_access(
    ctx: &Ready<'_>,
    main_token: &str,
    user_id: i64,
) -> Result<bool, String> {
    let machine_id = ctx.settings.get("/plex/machineId");
    if !truthy(machine_id) {
        tracing::error!("Error checking user access: Plex is not configured!");
        return Ok(false);
    }
    let sent = plex_get(ctx, "/api/users", main_token).send().await;
    let text = match sent {
        Ok(res) if res.status().is_success() => match res.text().await {
            Ok(text) => text,
            Err(e) => {
                tracing::error!("Error checking user access: {e:#}");
                return Ok(false);
            }
        },
        Ok(res) => {
            tracing::error!("Error checking user access: {}", res.status());
            return Ok(false);
        }
        Err(e) => {
            tracing::error!("Error checking user access: {e:#}");
            return Ok(false);
        }
    };
    let Ok(root) = parse_xml(&text) else {
        return Err(String::from("plex.tv users XML this parser can't follow"));
    };
    shares_server(&root, user_id, machine_id)
        .map_err(|()| String::from("a Plex user id too long to compare"))
}

/// One XML element: name, attributes and child elements.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Element {
    name: String,
    attrs: Vec<(String, String)>,
    children: Vec<Self>,
}

impl Element {
    fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

/// The `xml2js` reading of `MediaContainer.User[].Server[]`: whether the
/// user with `user_id` lists the server. Where Node would throw (a
/// missing list, an element without attributes) the answer is `false`.
fn shares_server(root: &Element, user_id: i64, machine_id: Option<&Value>) -> Result<bool, ()> {
    if root.name != "MediaContainer" {
        return Ok(false);
    }
    let mut found = None;
    for user in root.children.iter().filter(|c| c.name == "User") {
        if user.attrs.is_empty() {
            return Ok(false);
        }
        if parse_int(user.attr("id"))? == Some(user_id) {
            found = Some(user);
            break;
        }
    }
    let Some(user) = found else {
        return Ok(false);
    };
    for server in user.children.iter().filter(|c| c.name == "Server") {
        if server.attrs.is_empty() {
            return Ok(false);
        }
        if let (Some(id), Some(Value::String(wanted))) =
            (server.attr("machineIdentifier"), machine_id)
        {
            if id == wanted {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// `parseInt(text)` as an integer; `Err` for digit runs too long to
/// compare exactly.
fn parse_int(text: Option<&str>) -> Result<Option<i64>, ()> {
    let Some(text) = text else {
        return Ok(None);
    };
    let trimmed = text.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    let (negative, rest) = match trimmed.as_bytes().first() {
        Some(b'-') => (true, trimmed.get(1..).unwrap_or("")),
        Some(b'+') => (false, trimmed.get(1..).unwrap_or("")),
        _ => (false, trimmed),
    };
    let (radix, rest) = match rest.get(..2) {
        Some("0x" | "0X") => (16, rest.get(2..).unwrap_or("")),
        _ => (10, rest),
    };
    let digits: String = rest.chars().take_while(|c| c.is_digit(radix)).collect();
    if digits.is_empty() {
        return Ok(None);
    }
    if digits.len() > 13 {
        return Err(());
    }
    let value = i64::from_str_radix(&digits, radix).map_err(|_| ())?;
    Ok(Some(if negative { -value } else { value }))
}

/// A small XML reader for the `plex.tv` users list: elements and
/// attributes, with prologs and comments skipped. Anything else (doctype,
/// CDATA, mismatched tags, text outside the root) is an error.
fn parse_xml(text: &str) -> Result<Element, ()> {
    let mut rest = text.trim_start_matches('\u{feff}');
    let mut stack: Vec<Element> = Vec::new();
    let mut root: Option<Element> = None;
    loop {
        let Some(open) = rest.find('<') else {
            if !rest.trim().is_empty() && stack.is_empty() {
                return Err(());
            }
            break;
        };
        let (before, after) = rest.split_at(open);
        if stack.is_empty() && !before.trim().is_empty() {
            return Err(());
        }
        rest = after;
        if let Some(r) = rest.strip_prefix("<?") {
            rest = r.split_once("?>").ok_or(())?.1;
            continue;
        }
        if let Some(r) = rest.strip_prefix("<!--") {
            rest = r.split_once("-->").ok_or(())?.1;
            continue;
        }
        if rest.starts_with("<!") {
            return Err(());
        }
        if let Some(r) = rest.strip_prefix("</") {
            let (name, r) = r.split_once('>').ok_or(())?;
            let element = stack.pop().ok_or(())?;
            if element.name != name.trim_end() {
                return Err(());
            }
            close(&mut stack, &mut root, element)?;
            rest = r;
            continue;
        }
        if root.is_some() {
            return Err(());
        }
        let (element, self_closing, r) = open_tag(rest.get(1..).ok_or(())?)?;
        rest = r;
        if self_closing {
            close(&mut stack, &mut root, element)?;
        } else {
            stack.push(element);
        }
    }
    if !stack.is_empty() {
        return Err(());
    }
    root.ok_or(())
}

/// A finished element goes to its parent, or becomes the root.
fn close(stack: &mut [Element], root: &mut Option<Element>, element: Element) -> Result<(), ()> {
    match stack.last_mut() {
        Some(parent) => parent.children.push(element),
        None if root.is_none() => *root = Some(element),
        None => return Err(()),
    }
    Ok(())
}

/// The inside of a start tag after `<`: the element, whether it closed
/// itself, and what follows the `>`.
fn open_tag(text: &str) -> Result<(Element, bool, &str), ()> {
    let end = text
        .find(|c: char| c.is_whitespace() || c == '/' || c == '>')
        .ok_or(())?;
    let (name, mut rest) = text.split_at(end);
    if name.is_empty() {
        return Err(());
    }
    let mut element = Element {
        name: name.to_owned(),
        ..Element::default()
    };
    loop {
        rest = rest.trim_start();
        if let Some(r) = rest.strip_prefix("/>") {
            return Ok((element, true, r));
        }
        if let Some(r) = rest.strip_prefix('>') {
            return Ok((element, false, r));
        }
        let eq = rest.find('=').ok_or(())?;
        let (key, r) = rest.split_at(eq);
        let key = key.trim();
        if key.is_empty() || key.contains(|c: char| c.is_whitespace() || c == '>' || c == '/') {
            return Err(());
        }
        let r = r.get(1..).ok_or(())?.trim_start();
        let quote = r
            .chars()
            .next()
            .filter(|c| *c == '"' || *c == '\'')
            .ok_or(())?;
        let r = r.get(1..).ok_or(())?;
        let (value, r) = r.split_once(quote).ok_or(())?;
        if element.attr(key).is_some() || value.contains('<') {
            return Err(());
        }
        element
            .attrs
            .push((key.to_owned(), decode_entities(value)?));
        rest = r;
    }
}

/// XML's predefined and numeric character references.
fn decode_entities(value: &str) -> Result<String, ()> {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(amp) = rest.find('&') {
        let (before, after) = rest.split_at(amp);
        out.push_str(before);
        let (entity, r) = after.get(1..).ok_or(())?.split_once(';').ok_or(())?;
        let c = match entity {
            "lt" => '<',
            "gt" => '>',
            "amp" => '&',
            "quot" => '"',
            "apos" => '\'',
            _ => {
                let code = if let Some(hex) = entity
                    .strip_prefix("#x")
                    .or_else(|| entity.strip_prefix("#X"))
                {
                    u32::from_str_radix(hex, 16).map_err(|_| ())?
                } else if let Some(dec) = entity.strip_prefix('#') {
                    dec.parse::<u32>().map_err(|_| ())?
                } else {
                    return Err(());
                };
                char::from_u32(code).ok_or(())?
            }
        };
        out.push(c);
        rest = r;
    }
    out.push_str(rest);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const USERS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<MediaContainer friendlyName="myPlex" identifier="com.plexapp.plugins.myplex" machineIdentifier="m" totalSize="2" size="2">
  <!-- shared users -->
  <User id="123" title="A &amp; B" username="ab" email="a@b.c" thumb="https://plex.tv/users/x/avatar?c=1">
    <Server id="9" serverId="9" machineIdentifier="other" name="Other" lastSeenAt="1" numLibraries="1" owned="0"/>
    <Server id="10" serverId="10" machineIdentifier="abc" name="Mine" lastSeenAt="1" numLibraries="3" owned="1"/>
  </User>
  <User id="456" title="C" username="c" email="c@d.e" thumb=""/>
</MediaContainer>"#;

    #[test]
    fn reads_the_users_list() {
        let root = parse_xml(USERS).unwrap_or_default();
        assert_eq!(root.name, "MediaContainer", "root");
        assert_eq!(root.children.len(), 2, "users");
        assert_eq!(
            root.children.first().and_then(|u| u.attr("title")),
            Some("A & B"),
            "entities decoded"
        );
        let mine = json!("abc");
        assert_eq!(shares_server(&root, 123, Some(&mine)), Ok(true), "shared");
        assert_eq!(
            shares_server(&root, 456, Some(&mine)),
            Ok(false),
            "no servers"
        );
        assert_eq!(
            shares_server(&root, 789, Some(&mine)),
            Ok(false),
            "unknown user"
        );
        assert_eq!(
            shares_server(&root, 123, Some(&json!(1))),
            Ok(false),
            "strict equality"
        );
    }

    #[test]
    fn refuses_what_it_cannot_follow() {
        assert!(parse_xml("<a><b></a>").is_err(), "mismatched");
        assert!(parse_xml("<!DOCTYPE x><a/>").is_err(), "doctype");
        assert!(parse_xml("<a/><b/>").is_err(), "two roots");
        assert!(parse_xml("text<a/>").is_err(), "text before root");
        assert!(parse_xml("<a x=1/>").is_err(), "unquoted");
        assert!(parse_xml("<a>").is_err(), "unclosed");
        let other = parse_xml("<Other><User id=\"1\"/></Other>").unwrap_or_default();
        assert_eq!(shares_server(&other, 1, None), Ok(false), "other root");
        let bare = parse_xml("<MediaContainer><User/></MediaContainer>").unwrap_or_default();
        assert_eq!(
            shares_server(&bare, 1, None),
            Ok(false),
            "user without attributes"
        );
    }

    #[test]
    fn parses_ints_like_javascript() {
        assert_eq!(parse_int(Some(" 42abc")), Ok(Some(42)), "prefix");
        assert_eq!(parse_int(Some("0x1A")), Ok(Some(26)), "hex");
        assert_eq!(parse_int(Some("-7")), Ok(Some(-7)), "negative");
        assert_eq!(parse_int(Some("abc")), Ok(None), "NaN");
        assert_eq!(parse_int(None), Ok(None), "undefined");
        assert!(parse_int(Some("12345678901234567890")).is_err(), "too long");
    }
}
