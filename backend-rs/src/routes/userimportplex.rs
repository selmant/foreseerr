//! `POST /user/import-from-plex` (`server/routes/user/index.ts`): refresh
//! the users already linked to a shared Plex account and create the ones
//! asked for (or all) who can reach this server.
//!
//! Node walks the shared list one user at a time, writing as it goes, so
//! every input it would throw on part-way through is refused up front
//! and handed to Node before anything is written.

use std::future::Future;
use std::pin::Pin;

use axum::http::Method;
use serde_json::{Map, Value};

use super::plexsettings::check_user_access;
use super::plexsettings::{plex_tv, PlexTv};
use super::plexxml::{self, Element};
use super::userwrite::{append_created, MANAGE_USERS, USER_TYPE_LOCAL, USER_TYPE_PLEX};
use super::{Outcome, Ready, Table};
use crate::db::Bind;
use crate::typeorm::{self, Changes};

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

pub(super) const ROUTES: &Table = &[(
    "/api/v1/user/import-from-plex",
    Method::POST,
    import_from_plex,
)];

/// One shared Plex user with an email, as the loop reads it.
struct Shared<'a> {
    id: i64,
    raw_id: &'a str,
    email: &'a str,
    username: &'a str,
    thumb: &'a str,
}

/// The users of the shared list that have an email, or why Node must
/// answer: a list or a user Node's loop would throw on.
fn shared_users(root: &Element) -> Result<Vec<Shared<'_>>, String> {
    if root.name != "MediaContainer" {
        return Err(String::from("a plex.tv answer that isn't a MediaContainer"));
    }
    let users: Vec<&Element> = root.children_named("User").collect();
    if users.is_empty() {
        return Err(String::from("no shared users;"));
    }
    let mut shared = Vec::new();
    for user in users {
        if !user.has_attrs() {
            return Err(String::from("a shared user without attributes"));
        }
        let Some(email) = user.attr("email").filter(|e| !e.is_empty()) else {
            continue;
        };
        let Some(raw_id) = user
            .attr("id")
            .filter(|id| !id.is_empty() && id.len() < 10 && id.bytes().all(|b| b.is_ascii_digit()))
        else {
            return Err(String::from("a Plex user id parseInt may read differently"));
        };
        let (Some(username), Some(thumb)) = (user.attr("username"), user.attr("thumb")) else {
            return Err(String::from("a shared user without a username or thumb"));
        };
        let Ok(id) = raw_id.parse::<i64>() else {
            return Err(String::from("a Plex user id that doesn't parse"));
        };
        shared.push(Shared {
            id,
            raw_id,
            email,
            username,
            thumb,
        });
    }
    Ok(shared)
}

/// The `plexIds` filter: `None` for no body (import everyone).
fn wanted_ids(ctx: &Ready<'_>) -> Result<Option<Vec<String>>, String> {
    let Some(body) = &ctx.body else {
        return Ok(None);
    };
    let Some(Value::Array(ids)) = body.as_object().and_then(|b| b.get("plexIds")) else {
        return Err(String::from("a body without a plexIds array"));
    };
    ids.iter()
        .map(|v| v.as_str().map(str::to_owned))
        .collect::<Option<Vec<String>>>()
        .map(Some)
        .ok_or_else(|| String::from("plexIds that aren't all strings"))
}

/// What the import does with one shared user.
enum Step {
    Refreshed,
    Created(Value),
    Skipped,
}

fn import_from_plex<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = ctx.no_query() {
            return Outcome::forward(why);
        }
        if let Err(why) = ctx.authenticated(MANAGE_USERS) {
            return Outcome::forward(why);
        }
        // Node reads `body.plexIds` only for a new user, after plex.tv
        // answered.
        let wanted = wanted_ids(ctx);
        let Some(permissions) = ctx
            .settings
            .get("/main/defaultPermissions")
            .filter(|v| v.as_i64().is_some())
            .cloned()
        else {
            return Outcome::forward(String::from("defaultPermissions isn't an integer"));
        };
        let token = match ctx
            .state
            .db
            .rows(r#"SELECT "plexToken" FROM "user" WHERE "id" = 1"#, &[])
            .await
        {
            Ok(rows) => match rows.first() {
                Some(row) => row
                    .get("plexToken")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                None => return Outcome::forward(String::from("no user 1; findOneOrFail throws")),
            },
            Err(e) => return Outcome::forward(format!("database: {e:#}")),
        };
        let client = &ctx.state.outbound;
        // The handler's catch reports the error's message.
        let root = match plex_tv(client, &token, "/api/users").await {
            PlexTv::Text(text) => {
                let Some(root) = plexxml::parse(&text) else {
                    return ctx.error(500, "plex.tv answered with XML that could not be read");
                };
                root
            }
            PlexTv::Status(status) => {
                return ctx.error(500, &format!("Request failed with status code {status}"))
            }
            PlexTv::Network(e) => return ctx.error(500, &crate::outbound::describe(&e)),
        };
        let shared = match shared_users(&root) {
            Ok(shared) => shared,
            Err(why) => return Outcome::forward(why),
        };
        let wanted = match wanted {
            Ok(wanted) => wanted,
            Err(why) => return Outcome::forward(why),
        };
        let machine_id = ctx
            .settings
            .get("/plex/machineId")
            .cloned()
            .unwrap_or(Value::Null);
        let mut created = Vec::new();
        let mut refreshed = 0_i64;
        for user in &shared {
            let step = import_one(
                ctx,
                user,
                wanted.as_deref(),
                &permissions,
                &token,
                &machine_id,
            );
            match step.await {
                Ok(Step::Refreshed) => refreshed += 1,
                Ok(Step::Created(json)) => created.push(json),
                Ok(Step::Skipped) => {}
                Err(e) => return ctx.error(500, &format!("{e:#}")),
            }
        }
        let mut out = Map::new();
        out.insert(String::from("createdUsers"), Value::Array(created));
        out.insert(String::from("refreshedUsers"), Value::from(refreshed));
        ctx.json_with(201, &Value::Object(out))
    })
}

/// One turn of Node's loop: refresh the matching user, or create one.
async fn import_one(
    ctx: &Ready<'_>,
    user: &Shared<'_>,
    wanted: Option<&[String]>,
    permissions: &Value,
    token: &str,
    machine_id: &Value,
) -> anyhow::Result<Step> {
    let db = &ctx.state.db;
    let email = user.email.to_lowercase();
    let rows = db
        .rows(
            r#"SELECT "id", "email", "plexUsername", "avatar", "userType" FROM "user" WHERE "plexId" = ?1 OR "email" = ?2"#,
            &[Bind::Int(user.id), Bind::Text(email.clone())],
        )
        .await?;
    if let Some(row) = rows.first() {
        let id = row
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| anyhow::anyhow!("a user row without an id"))?;
        let stored = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
        let stored_email = stored("email")
            .as_str()
            .map_or(Value::Null, |e| Value::from(e.to_lowercase()));
        let mut changes = Changes::default();
        changes.assign("avatar", Some(&Value::from(user.thumb)), &stored("avatar"));
        changes.assign("email", Some(&Value::from(email)), &stored_email);
        changes.assign(
            "plexUsername",
            Some(&Value::from(user.username)),
            &stored("plexUsername"),
        );
        if stored("userType").as_i64() == Some(USER_TYPE_LOCAL) {
            changes.set("userType", Value::from(USER_TYPE_PLEX));
            changes.set("plexId", Value::from(user.id));
        }
        typeorm::run(db, changes.update_sql("user", id, true)?).await?;
        return Ok(Step::Refreshed);
    }
    if wanted.is_some_and(|ids| !ids.iter().any(|id| id == user.raw_id)) {
        return Ok(Step::Skipped);
    }
    let client = ctx.state.outbound.clone();
    if !check_user_access(client, token.to_owned(), machine_id.clone(), user.id).await {
        return Ok(Step::Skipped);
    }
    let id = typeorm::insert(
        db,
        "user",
        &[
            ("plexUsername", Value::from(user.username)),
            ("email", Value::from(email)),
            ("permissions", permissions.clone()),
            ("plexId", Value::from(user.id)),
            ("plexToken", Value::from("")),
            ("avatar", Value::from(user.thumb)),
            ("userType", Value::from(USER_TYPE_PLEX)),
        ],
    )
    .await?;
    let mut out = Map::new();
    out.insert(String::from("warnings"), Value::Array(Vec::new()));
    out.insert(String::from("permissions"), permissions.clone());
    out.insert(String::from("plexUsername"), Value::from(user.username));
    out.insert(String::from("avatar"), Value::from(user.thumb));
    out.insert(String::from("userType"), Value::from(USER_TYPE_PLEX));
    append_created(
        ctx,
        &mut out,
        id,
        &[
            "jellyfinUsername",
            "username",
            "recoveryLinkExpirationDate",
            "jellyfinUserId",
        ],
    )
    .await?;
    Ok(Step::Created(Value::Object(out)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn element(name: &str, attrs: &[(&str, &str)], children: Vec<Element>) -> Element {
        Element {
            name: name.to_owned(),
            attrs: attrs
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
            children,
        }
    }

    #[test]
    fn reads_only_users_with_an_email() {
        let root = element(
            "MediaContainer",
            &[("friendlyName", "x")],
            vec![
                element(
                    "User",
                    &[
                        ("id", "12"),
                        ("email", "A@b.c"),
                        ("username", "a"),
                        ("thumb", "t"),
                    ],
                    Vec::new(),
                ),
                element("User", &[("id", "13"), ("username", "managed")], Vec::new()),
            ],
        );
        let users = shared_users(&root);
        let ids: Vec<(i64, &str)> = users.iter().flatten().map(|u| (u.id, u.email)).collect();
        assert_eq!(ids, vec![(12, "A@b.c")]);
    }

    #[test]
    fn refuses_what_node_would_throw_on() {
        let empty = element("MediaContainer", &[], Vec::new());
        assert!(shared_users(&empty).is_err());
        let bare = element(
            "MediaContainer",
            &[],
            vec![element("User", &[], Vec::new())],
        );
        assert!(shared_users(&bare).is_err());
        let odd_id = element(
            "MediaContainer",
            &[],
            vec![element(
                "User",
                &[
                    ("id", "0x1"),
                    ("email", "a@b.c"),
                    ("username", "a"),
                    ("thumb", "t"),
                ],
                Vec::new(),
            )],
        );
        assert!(shared_users(&odd_id).is_err());
    }
}
