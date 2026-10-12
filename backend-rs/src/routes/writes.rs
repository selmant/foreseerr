//! Writes answered here: override rules, issue comments, discover sliders
//! and blocklist removals. Each runs the same statements `TypeORM` would
//! and prints the entity the way Node's handler leaves it.

use std::future::Future;
use std::pin::Pin;

use axum::http::Method;
use serde_json::{Map, Value};

use super::{Native as NativeFn, Outcome, Ready};
use crate::db::{Bind, DiscoverSliderRow, IssueCommentRow, OverrideRuleRow};
use crate::user::filtered_json;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// `Permission.ADMIN`.
const ADMIN: i64 = 2;
/// `MANAGE_ISSUES`, `VIEW_ISSUES`, `CREATE_ISSUES`.
const MANAGE_ISSUES: i64 = 1_048_576;
const VIEW_ISSUES: i64 = 2_097_152;
const CREATE_ISSUES: i64 = 4_194_304;
/// `MANAGE_BLOCKLIST`.
const MANAGE_BLOCKLIST: i64 = 268_435_456;

/// Every write answered here: path, method, handler.
pub(super) const WRITES: [(&str, Method, NativeFn); 15] = [
    ("/api/v1/auth/local", Method::POST, super::login::local),
    ("/api/v1/auth/logout", Method::POST, super::login::logout),
    ("/api/v1/overrideRule", Method::POST, rule_create),
    ("/api/v1/overrideRule/{id}", Method::PUT, rule_update),
    ("/api/v1/overrideRule/{id}", Method::DELETE, rule_delete),
    ("/api/v1/issueComment/{id}", Method::GET, comment_get),
    ("/api/v1/issueComment/{id}", Method::PUT, comment_update),
    ("/api/v1/issueComment/{id}", Method::DELETE, comment_delete),
    ("/api/v1/settings/discover/add", Method::POST, slider_add),
    ("/api/v1/settings/discover/{id}", Method::PUT, slider_update),
    (
        "/api/v1/settings/discover/{id}",
        Method::DELETE,
        slider_delete,
    ),
    (
        "/api/v1/request/{id}/{status}",
        Method::POST,
        super::requestwrite::status,
    ),
    ("/api/v1/blocklist/{id}", Method::DELETE, blocklist_delete),
    (
        "/api/v1/blocklist/{id}",
        Method::GET,
        super::listwrite::blocklist_get,
    ),
    (
        "/api/v1/user/{id}/pushSubscription/{endpoint}",
        Method::DELETE,
        super::userextra::push_subscription_delete,
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

/// The body as an object.
fn body_object<'a>(ctx: &'a Ready<'_>) -> Result<&'a Map<String, Value>, String> {
    match &ctx.body {
        Some(Value::Object(map)) => Ok(map),
        _ => Err(String::from("a body that isn't an object")),
    }
}

/// A body field: absent (`undefined`), or a value of the expected kind.
/// Anything else is Node's to judge.
#[derive(Debug, Clone, PartialEq)]
enum Field {
    Missing,
    Null,
    Text(String),
    Int(i64),
}

fn text_field(body: &Map<String, Value>, key: &str) -> Result<Field, super::Fallback> {
    match body.get(key) {
        None => Ok(Field::Missing),
        Some(Value::Null) => Ok(Field::Null),
        Some(Value::String(s)) => Ok(Field::Text(s.clone())),
        Some(_) => Err(super::Fallback::status(400, format!("{key} must be text."))),
    }
}

fn int_field(body: &Map<String, Value>, key: &str) -> Result<Field, super::Fallback> {
    match body.get(key) {
        None => Ok(Field::Missing),
        Some(Value::Null) => Ok(Field::Null),
        Some(v) => v
            .as_i64()
            .map(Field::Int)
            .ok_or_else(|| super::Fallback::status(400, format!("{key} must be an integer."))),
    }
}

impl Field {
    fn json(&self) -> Option<Value> {
        match self {
            Self::Missing => None,
            Self::Null => Some(Value::Null),
            Self::Text(t) => Some(Value::from(t.as_str())),
            Self::Int(n) => Some(Value::from(*n)),
        }
    }

    fn text_bind(&self) -> Bind {
        match self {
            Self::Text(t) => Bind::OptText(Some(t.clone())),
            Self::Missing | Self::Null | Self::Int(_) => Bind::OptText(None),
        }
    }

    const fn int_bind(&self) -> Bind {
        match self {
            Self::Int(n) => Bind::OptInt(Some(*n)),
            Self::Missing | Self::Null | Self::Text(_) => Bind::OptInt(None),
        }
    }
}

const RULE_INT: [&str; 3] = ["profileId", "radarrServiceId", "sonarrServiceId"];

/// The rule's body fields in the order the handler assigns them.
fn rule_fields(ctx: &Ready<'_>) -> Result<Vec<(&'static str, Field, bool)>, super::Fallback> {
    let body = body_object(ctx)?;
    let order = [
        "users",
        "genre",
        "language",
        "keywords",
        "profileId",
        "rootFolder",
        "tags",
        "radarrServiceId",
        "sonarrServiceId",
    ];
    order
        .iter()
        .map(|key| {
            if RULE_INT.contains(key) {
                int_field(body, key).map(|f| (*key, f, true))
            } else {
                text_field(body, key).map(|f| (*key, f, false))
            }
        })
        .collect()
}

/// `POST /overrideRule`.
fn rule_create<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.authenticated(ADMIN));
        let fields = try_forward!(rule_fields(ctx));
        let binds: Vec<Bind> = fields
            .iter()
            .map(|(_, f, int)| if *int { f.int_bind() } else { f.text_bind() })
            .collect();
        let id = try_db!(
            ctx.state
                .db
                .scalar(
                    r#"INSERT INTO "override_rule" ("users", "genre", "language", "keywords", "profileId", "rootFolder", "tags", "radarrServiceId", "sonarrServiceId") VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) RETURNING CAST("id" AS BIGINT)"#,
                    &binds,
                )
                .await
        );
        let Some(rule) = try_db!(ctx.state.db.override_rule(id).await) else {
            return Outcome::forward(String::from("the new rule vanished"));
        };
        let mut out = Map::new();
        for (key, field, _) in &fields {
            out.insert((*key).to_owned(), field.json().unwrap_or(Value::Null));
        }
        out.insert(String::from("id"), Value::from(rule.id));
        out.insert(String::from("createdAt"), text(rule.created_at.as_ref()));
        out.insert(String::from("updatedAt"), text(rule.updated_at.as_ref()));
        ctx.json(&Value::Object(out))
    })
}

/// `PUT /overrideRule/{id}`: fields missing from the body are left alone
/// in the database and, being `undefined`, out of the answer.
fn rule_update<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.authenticated(ADMIN));
        let id = try_forward!(ctx.path_id(0));
        let fields = try_forward!(rule_fields(ctx));
        let Some(rule) = try_db!(ctx.state.db.override_rule(id).await) else {
            return ctx.error(404, "Override Rule not found.");
        };
        let current = rule_json(&rule, true);
        let mut sets = Vec::new();
        let mut binds = Vec::new();
        for (key, field, int) in &fields {
            let Some(value) = field.json() else { continue };
            if current.get(*key) != Some(&value) {
                binds.push(if *int {
                    field.int_bind()
                } else {
                    field.text_bind()
                });
                sets.push(format!(r#""{key}" = ?{}"#, binds.len()));
            }
        }
        if !sets.is_empty() {
            binds.push(Bind::Int(id));
            let sql = format!(
                r#"UPDATE "override_rule" SET {}, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?{}"#,
                sets.join(", "),
                binds.len()
            );
            try_db!(ctx.state.db.execute(&sql, &binds).await);
        }
        let Some(rule) = try_db!(ctx.state.db.override_rule(id).await) else {
            return Outcome::forward(String::from("the rule vanished"));
        };
        let mut out = rule_json(&rule, true);
        let updated = !sets.is_empty();
        for (key, field, _) in &fields {
            if *field == Field::Missing {
                // Once an UPDATE ran, `TypeORM` sets the `undefined` (all
                // nullable) columns to null; the row keeps its values.
                if updated {
                    out.insert((*key).to_owned(), Value::Null);
                } else {
                    out.shift_remove(*key);
                }
            }
        }
        ctx.json(&Value::Object(out))
    })
}

/// `DELETE /overrideRule/{id}`: the removed rule, whose id `TypeORM`
/// clears on removal.
fn rule_delete<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.authenticated(ADMIN));
        let id = try_forward!(ctx.path_id(0));
        let Some(rule) = try_db!(ctx.state.db.override_rule(id).await) else {
            return ctx.error(404, "Override Rule not found.");
        };
        try_db!(
            ctx.state
                .db
                .execute(
                    r#"DELETE FROM "override_rule" WHERE "id" = ?1"#,
                    &[Bind::Int(id)]
                )
                .await
        );
        ctx.json(&Value::Object(rule_json(&rule, false)))
    })
}

/// An override rule as hydrated: column order.
fn rule_json(r: &OverrideRuleRow, with_id: bool) -> Map<String, Value> {
    let number = |n: Option<i64>| n.map_or(Value::Null, Value::from);
    let mut out = Map::new();
    if with_id {
        out.insert(String::from("id"), Value::from(r.id));
    }
    out.insert(String::from("radarrServiceId"), number(r.radarr_service_id));
    out.insert(String::from("sonarrServiceId"), number(r.sonarr_service_id));
    out.insert(String::from("users"), text(r.users.as_ref()));
    out.insert(String::from("genre"), text(r.genre.as_ref()));
    out.insert(String::from("language"), text(r.language.as_ref()));
    out.insert(String::from("keywords"), text(r.keywords.as_ref()));
    out.insert(String::from("profileId"), number(r.profile_id));
    out.insert(String::from("rootFolder"), text(r.root_folder.as_ref()));
    out.insert(String::from("tags"), text(r.tags.as_ref()));
    out.insert(String::from("createdAt"), text(r.created_at.as_ref()));
    out.insert(String::from("updatedAt"), text(r.updated_at.as_ref()));
    out
}

fn text(v: Option<&String>) -> Value {
    v.map_or(Value::Null, |s| Value::from(s.as_str()))
}

/// The comment with its user (and the user's settings, both eager).
async fn comment_json(ctx: &Ready<'_>, c: &IssueCommentRow) -> Result<Value, String> {
    let user_id = c
        .user_id
        .ok_or_else(|| String::from("a comment without a user"))?;
    let (user, settings) = ctx
        .state
        .db
        .user_record(user_id)
        .await
        .map_err(|e| format!("database: {e:#}"))?
        .ok_or_else(|| String::from("a comment whose user is gone"))?;
    let mut out = Map::new();
    out.insert(String::from("id"), Value::from(c.id));
    out.insert(String::from("message"), Value::from(c.message.as_str()));
    out.insert(String::from("createdAt"), text(c.created_at.as_ref()));
    out.insert(String::from("updatedAt"), text(c.updated_at.as_ref()));
    out.insert(
        String::from("user"),
        filtered_json(&user, Some(settings.as_ref()), true).map_err(str::to_owned)?,
    );
    Ok(Value::Object(out))
}

/// `GET /issueComment/{id}`.
fn comment_get<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let user = try_forward!(ctx.authenticated(MANAGE_ISSUES | VIEW_ISSUES | CREATE_ISSUES));
        let id = try_forward!(ctx.path_id(0));
        let Some(comment) = try_db!(ctx.state.db.issue_comment(id).await) else {
            return ctx.error(404, "Issue comment not found.");
        };
        if !user.has_permission(MANAGE_ISSUES | VIEW_ISSUES) && comment.user_id != Some(user.id) {
            return ctx.error(403, "You do not have permission to view this comment.");
        }
        ctx.json(&try_forward!(comment_json(ctx, &comment).await))
    })
}

/// `PUT /issueComment/{id}`: only the author edits.
fn comment_update<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let user = try_forward!(ctx.authenticated(MANAGE_ISSUES | CREATE_ISSUES));
        let id = try_forward!(ctx.path_id(0));
        let body = try_forward!(body_object(ctx));
        let Some(Value::String(message)) = body.get("message") else {
            return Outcome::forward(String::from("message isn't text"));
        };
        let Some(comment) = try_db!(ctx.state.db.issue_comment(id).await) else {
            return ctx.error(404, "Issue comment not found.");
        };
        if comment.user_id != Some(user.id) {
            return ctx.error(403, "You can only edit your own comments.");
        }
        if *message != comment.message {
            try_db!(
                ctx.state
                    .db
                    .execute(
                        r#"UPDATE "issue_comment" SET "message" = ?1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?2"#,
                        &[Bind::Text(message.clone()), Bind::Int(id)],
                    )
                    .await
            );
        }
        let Some(comment) = try_db!(ctx.state.db.issue_comment(id).await) else {
            return Outcome::forward(String::from("the comment vanished"));
        };
        ctx.json(&try_forward!(comment_json(ctx, &comment).await))
    })
}

/// `DELETE /issueComment/{id}`.
fn comment_delete<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let user = try_forward!(ctx.authenticated(MANAGE_ISSUES | CREATE_ISSUES));
        let id = try_forward!(ctx.path_id(0));
        let Some(comment) = try_db!(ctx.state.db.issue_comment(id).await) else {
            return ctx.error(404, "Issue comment not found.");
        };
        if !user.has_permission(MANAGE_ISSUES) && comment.user_id != Some(user.id) {
            return ctx.error(403, "You do not have permission to delete this comment.");
        }
        try_db!(
            ctx.state
                .db
                .execute(
                    r#"DELETE FROM "issue_comment" WHERE "id" = ?1"#,
                    &[Bind::Int(id)]
                )
                .await
        );
        Ready::no_content()
    })
}

/// A slider body: `title`, `data` and `type` as the spec types them, and
/// an optional `sort`.
fn slider_fields(ctx: &Ready<'_>) -> Result<[(&'static str, Field); 4], super::Fallback> {
    let body = body_object(ctx)?;
    let title = text_field(body, "title")?;
    let data = text_field(body, "data")?;
    let sort = text_field(body, "sort")?;
    let kind = int_field(body, "type")?;
    // Missing fields are `undefined` (the column is left out); a null
    // `type` would be written and refused.
    if matches!(title, Field::Null) || matches!(data, Field::Null) || kind == Field::Null {
        return Err(super::Fallback::status(
            400,
            "title, data and type must not be null.",
        ));
    }
    Ok([
        ("title", title),
        ("data", data),
        ("sort", sort),
        ("type", kind),
    ])
}

/// A slider as hydrated: column order.
fn slider_json(r: &DiscoverSliderRow) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert(String::from("id"), Value::from(r.id));
    out.insert(String::from("type"), Value::from(r.slider_type));
    out.insert(String::from("order"), Value::from(r.order));
    out.insert(String::from("isBuiltIn"), Value::Bool(r.is_built_in));
    out.insert(String::from("enabled"), Value::Bool(r.enabled));
    out.insert(String::from("title"), text(r.title.as_ref()));
    out.insert(String::from("data"), text(r.data.as_ref()));
    out.insert(String::from("sort"), text(r.sort.as_ref()));
    out.insert(String::from("createdAt"), text(r.created_at.as_ref()));
    out.insert(String::from("updatedAt"), text(r.updated_at.as_ref()));
    out
}

/// `POST /settings/discover/add`: a disabled custom slider at order -1.
fn slider_add<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        try_forward!(ctx.authenticated(ADMIN));
        let [(_, title), (_, data), (_, sort), (_, kind)] = try_forward!(slider_fields(ctx));
        let inserted = ctx
                .state
                .db
                .scalar(
                    r#"INSERT INTO "discover_slider" ("isBuiltIn", "data", "sort", "title", "enabled", "order", "type") VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING CAST("id" AS BIGINT)"#,
                    &[
                        Bind::Bool(false),
                        data.text_bind(),
                        sort.text_bind(),
                        title.text_bind(),
                        Bind::Bool(false),
                        Bind::Int(-1),
                        kind.int_bind(),
                    ],
                )
                .await;
        let id = match inserted {
            Ok(id) => id,
            // Without a `type` the NOT NULL column refuses the row.
            Err(e) => return ctx.error(500, &crate::db::failure_message(&e)),
        };
        let Some(row) = try_db!(ctx.state.db.discover_slider(id).await) else {
            return Outcome::forward(String::from("the new slider vanished"));
        };
        let mut out = Map::new();
        out.insert(String::from("isBuiltIn"), Value::Bool(false));
        out.insert(String::from("data"), data.json().unwrap_or(Value::Null));
        out.insert(String::from("sort"), sort.json().unwrap_or(Value::Null));
        out.insert(String::from("title"), title.json().unwrap_or(Value::Null));
        out.insert(String::from("enabled"), Value::Bool(false));
        out.insert(String::from("order"), Value::from(-1));
        out.insert(String::from("type"), kind.json().unwrap_or(Value::Null));
        out.insert(String::from("id"), Value::from(row.id));
        out.insert(String::from("createdAt"), text(row.created_at.as_ref()));
        out.insert(String::from("updatedAt"), text(row.updated_at.as_ref()));
        ctx.json(&Value::Object(out))
    })
}

/// `PUT /settings/discover/{id}`: built-in sliders stay as they are.
fn slider_update<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        try_forward!(ctx.authenticated(ADMIN));
        let id = try_forward!(super::params::path_int(ctx, 0));
        // The row is looked up first, and a built-in one never reads the
        // body.
        let Some(row) = try_db!(ctx.state.db.discover_slider(id).await) else {
            return ctx.error(404, "Slider not found or cannot be updated.");
        };
        if row.is_built_in {
            return ctx.json(&Value::Object(slider_json(&row)));
        }
        let fields = try_forward!(slider_fields(ctx));
        let current = slider_json(&row);
        let mut sets = Vec::new();
        let mut binds = Vec::new();
        for (key, field) in &fields {
            let Some(value) = field.json() else { continue };
            if current.get(*key) != Some(&value) {
                binds.push(if *key == "type" {
                    field.int_bind()
                } else {
                    field.text_bind()
                });
                sets.push(format!(r#""{key}" = ?{}"#, binds.len()));
            }
        }
        if !sets.is_empty() {
            binds.push(Bind::Int(id));
            let sql = format!(
                r#"UPDATE "discover_slider" SET {}, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?{}"#,
                sets.join(", "),
                binds.len()
            );
            try_db!(ctx.state.db.execute(&sql, &binds).await);
        }
        let Some(row) = try_db!(ctx.state.db.discover_slider(id).await) else {
            return Outcome::forward(String::from("the slider vanished"));
        };
        let mut out = slider_json(&row);
        let updated = !sets.is_empty();
        for (key, field) in &fields {
            if *field != Field::Missing {
                continue;
            }
            // The keys hold `undefined`; once an UPDATE ran, `TypeORM`
            // sets the nullable ones to null (the row keeps its values).
            if updated && *key != "type" {
                out.insert((*key).to_owned(), Value::Null);
            } else {
                out.shift_remove(*key);
            }
        }
        ctx.json(&Value::Object(out))
    })
}

/// `DELETE /settings/discover/{id}`: custom sliders only.
fn slider_delete<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        try_forward!(ctx.authenticated(ADMIN));
        let id = try_forward!(super::params::path_int(ctx, 0));
        let removed = try_db!(
            ctx.state
                .db
                .execute(
                    r#"DELETE FROM "discover_slider" WHERE "id" = ?1 AND "isBuiltIn" = ?2"#,
                    &[Bind::Int(id), Bind::Bool(false)],
                )
                .await
        );
        if removed == 0 {
            return ctx.error(404, "Slider not found or cannot be deleted.");
        }
        Ready::no_content()
    })
}

/// `DELETE /blocklist/{tmdbId}?mediaType=`: the entry, then its media row.
pub(super) fn blocklist_delete<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.authenticated(MANAGE_BLOCKLIST));
        let media_type = try_forward!(super::draft::media_type_query(ctx));
        let key = try_forward!(super::draft::tmdb_path_key(ctx));
        let binds = [key, Bind::Text(media_type.to_owned())];
        let found = try_db!(
            ctx.state
                .db
                .scalar(
                    r#"SELECT COUNT(*) FROM "blocklist" WHERE "tmdbId" = ?1 AND "mediaType" = ?2"#,
                    &binds,
                )
                .await
        );
        if found == 0 {
            return ctx.error(404, &super::draft::not_found("Blocklist"));
        }
        try_db!(
            ctx.state
                .db
                .execute(
                    r#"DELETE FROM "blocklist" WHERE "id" = (SELECT "id" FROM "blocklist" WHERE "tmdbId" = ?1 AND "mediaType" = ?2 ORDER BY "id" LIMIT 1)"#,
                    &binds,
                )
                .await
        );
        let removed = try_db!(
            ctx.state
                .db
                .execute(
                    r#"DELETE FROM "media" WHERE "id" = (SELECT "id" FROM "media" WHERE "tmdbId" = ?1 AND "mediaType" = ?2 ORDER BY "id" LIMIT 1)"#,
                    &binds,
                )
                .await
        );
        if removed == 0 {
            return ctx.error(404, &super::draft::not_found("Media"));
        }
        Ready::no_content()
    })
}
