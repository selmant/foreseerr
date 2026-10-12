//! `server/routes/servarrInterventions.ts`: Radarr and Sonarr queue
//! warnings for mapped titles.
//!
//! They are listed, counted, marked seen and rejected (removed from the
//! client and blocklisted). Also the record helpers of
//! `lib/servarrInterventions.ts` the manual import routes use.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use axum::http::Method;
use serde_json::{Map, Value};

use super::arrcall::{ArrError, ArrServer};
use super::mediawrite::{timeout_ms, MANAGE_REQUESTS};
use super::{Outcome, Ready, Table};
use crate::clock::Utc;
use crate::db::{Bind, Db};
use crate::settings::public::truthy;
use crate::state::AppState;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// `INTERVENTION_REJECTION_TIMEOUT_MS`.
const REJECTION_TIMEOUT_MS: u64 = 120_000;

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/servarr/interventions", Method::GET, list),
    ("/api/v1/servarr/interventions/count", Method::GET, count),
    ("/api/v1/servarr/interventions/seen", Method::POST, seen),
    (
        "/api/v1/servarr/interventions/{id}/reject",
        Method::POST,
        reject,
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

/// A `servarr_intervention` row as the entity holds it.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Intervention {
    pub(super) id: i64,
    pub(super) service_type: String,
    pub(super) service_id: i64,
    pub(super) service_name: Value,
    pub(super) is4k: bool,
    pub(super) queue_id: i64,
    pub(super) download_id: Option<String>,
    pub(super) external_service_id: i64,
    pub(super) media_id: i64,
    pub(super) tmdb_id: i64,
    pub(super) media_type: Value,
    pub(super) release_title: Value,
    pub(super) warning_messages: Value,
    pub(super) manual_import_capable: bool,
    pub(super) state: String,
    pub(super) resolution: Option<String>,
    pub(super) acted_by_user_id: Option<i64>,
    pub(super) cleanup_error: Option<String>,
    pub(super) first_seen_at: Value,
    pub(super) cleanup_deadline_at: Value,
    pub(super) resolved_at: Option<String>,
}

/// The select list, dates as `Date.toJSON` prints them.
fn columns(db: &Db) -> String {
    format!(
        r#"CAST("id" AS BIGINT) AS "id", "serviceType", CAST("serviceId" AS BIGINT) AS "serviceId", "serviceName", "is4k", CAST("queueId" AS BIGINT) AS "queueId", "downloadId", CAST("externalServiceId" AS BIGINT) AS "externalServiceId", CAST("mediaId" AS BIGINT) AS "mediaId", CAST("tmdbId" AS BIGINT) AS "tmdbId", "mediaType", "releaseTitle", "warningMessages", "manualImportCapable", "state", "resolution", CAST("actedByUserId" AS BIGINT) AS "actedByUserId", "cleanupError", {} AS "firstSeenAt", {} AS "cleanupDeadlineAt", {} AS "resolvedAt""#,
        db.iso_sql(r#""firstSeenAt""#),
        db.iso_sql(r#""cleanupDeadlineAt""#),
        db.iso_sql(r#""resolvedAt""#)
    )
}

/// The `stringArray` transformer: the stored JSON, `[]` when empty or
/// unparseable.
fn string_array(stored: Option<&str>) -> Value {
    stored
        .filter(|s| !s.is_empty())
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .map_or_else(|| Value::Array(Vec::new()), crate::tmdb::js_numbers)
}

fn flag(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_i64().is_some_and(|n| n != 0),
        _ => false,
    }
}

fn from_row(row: &Map<String, Value>) -> Option<Intervention> {
    let int = |k: &str| row.get(k).and_then(Value::as_i64);
    let text = |k: &str| row.get(k).and_then(Value::as_str).map(str::to_owned);
    let raw = |k: &str| row.get(k).cloned().unwrap_or(Value::Null);
    Some(Intervention {
        id: int("id")?,
        service_type: text("serviceType")?,
        service_id: int("serviceId")?,
        service_name: raw("serviceName"),
        is4k: flag(row.get("is4k")),
        queue_id: int("queueId")?,
        download_id: text("downloadId"),
        external_service_id: int("externalServiceId")?,
        media_id: int("mediaId")?,
        tmdb_id: int("tmdbId")?,
        media_type: raw("mediaType"),
        release_title: raw("releaseTitle"),
        warning_messages: string_array(row.get("warningMessages").and_then(Value::as_str)),
        manual_import_capable: flag(row.get("manualImportCapable")),
        state: text("state")?,
        resolution: text("resolution"),
        acted_by_user_id: int("actedByUserId"),
        cleanup_error: text("cleanupError"),
        first_seen_at: raw("firstSeenAt"),
        cleanup_deadline_at: raw("cleanupDeadlineAt"),
        resolved_at: text("resolvedAt"),
    })
}

/// `findOne({ where: { id } })`.
pub(super) async fn load(db: &Db, id: i64) -> anyhow::Result<Option<Intervention>> {
    let rows = db
        .rows(
            &format!(
                r#"SELECT {} FROM "servarr_intervention" WHERE "id" = ?1"#,
                columns(db)
            ),
            &[Bind::Int(id)],
        )
        .await?;
    Ok(rows.first().and_then(from_row))
}

/// `publicIntervention(item)`.
pub(super) fn public_json(i: &Intervention) -> Map<String, Value> {
    let opt_text = |v: &Option<String>| v.as_deref().map_or(Value::Null, Value::from);
    let mut out = Map::new();
    out.insert(String::from("id"), Value::from(i.id));
    out.insert(
        String::from("serviceType"),
        Value::from(i.service_type.as_str()),
    );
    out.insert(String::from("serviceId"), Value::from(i.service_id));
    out.insert(String::from("serviceName"), i.service_name.clone());
    out.insert(String::from("is4k"), Value::Bool(i.is4k));
    out.insert(String::from("mediaId"), Value::from(i.media_id));
    out.insert(String::from("tmdbId"), Value::from(i.tmdb_id));
    out.insert(String::from("mediaType"), i.media_type.clone());
    out.insert(String::from("releaseTitle"), i.release_title.clone());
    out.insert(String::from("warningMessages"), i.warning_messages.clone());
    out.insert(
        String::from("manualImportCapable"),
        Value::Bool(i.manual_import_capable),
    );
    out.insert(String::from("state"), Value::from(i.state.as_str()));
    out.insert(String::from("resolution"), opt_text(&i.resolution));
    out.insert(String::from("cleanupError"), opt_text(&i.cleanup_error));
    out.insert(String::from("firstSeenAt"), i.first_seen_at.clone());
    out.insert(
        String::from("cleanupDeadlineAt"),
        i.cleanup_deadline_at.clone(),
    );
    out.insert(String::from("resolvedAt"), opt_text(&i.resolved_at));
    out
}

/// A date parameter as `TypeORM` binds a `Date`: its UTC datetime text on
/// `SQLite`, a `timestamptz` on Postgres.
pub(super) fn date_param(db: &Db, n: usize) -> String {
    if db.is_postgres() {
        format!("CAST(?{n} AS timestamptz)")
    } else {
        format!("?{n}")
    }
}

/// The bound value for `date_param`.
pub(super) fn date_bind(db: &Db, at: &Utc) -> Bind {
    if db.is_postgres() {
        Bind::Text(at.iso_string())
    } else {
        Bind::Text(at.typeorm_string())
    }
}

/// `repository.save(record)`: the tracked columns that differ from the
/// stored row are written with `updatedAt`. `resolved_at` is the moment a
/// handler set (`None` leaves the column as stored).
pub(super) async fn save(
    db: &Db,
    record: &Intervention,
    resolved_at: Option<&Utc>,
) -> anyhow::Result<()> {
    let Some(stored) = load(db, record.id).await? else {
        return Ok(());
    };
    let mut sets = Vec::new();
    let mut binds = Vec::new();
    if record.state != stored.state {
        binds.push(Bind::Text(record.state.clone()));
        sets.push(format!(r#""state" = ?{}"#, binds.len()));
    }
    if record.resolution != stored.resolution {
        binds.push(Bind::OptText(record.resolution.clone()));
        sets.push(format!(r#""resolution" = ?{}"#, binds.len()));
    }
    if record.acted_by_user_id != stored.acted_by_user_id {
        binds.push(Bind::OptInt(record.acted_by_user_id));
        sets.push(format!(r#""actedByUserId" = ?{}"#, binds.len()));
    }
    if record.cleanup_error != stored.cleanup_error {
        binds.push(Bind::OptText(record.cleanup_error.clone()));
        sets.push(format!(r#""cleanupError" = ?{}"#, binds.len()));
    }
    if let Some(at) = resolved_at {
        if Some(at.iso_string()) != stored.resolved_at {
            binds.push(date_bind(db, at));
            sets.push(format!(r#""resolvedAt" = {}"#, date_param(db, binds.len())));
        }
    }
    if sets.is_empty() {
        return Ok(());
    }
    binds.push(Bind::Int(record.id));
    db.execute(
        &format!(
            r#"UPDATE "servarr_intervention" SET {}, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?{}"#,
            sets.join(", "),
            binds.len()
        ),
        &binds,
    )
    .await?;
    Ok(())
}

/// `message.slice(0, n)` in UTF-16 code units.
pub(super) fn js_slice(text: &str, n: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in text.chars() {
        units += c.len_utf16();
        if units > n {
            break;
        }
        out.push(c);
    }
    out
}

/// `startImportedIntervention`: claim an active record for an import.
pub(super) async fn start_import(db: &Db, id: i64, user_id: i64) -> anyhow::Result<bool> {
    let claimed = db
        .execute(
            r#"UPDATE "servarr_intervention" SET "state" = ?1, "actedByUserId" = ?2, "cleanupError" = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?3 AND "state" = ?4"#,
            &[
                Bind::Text(String::from("importing")),
                Bind::Int(user_id),
                Bind::Int(id),
                Bind::Text(String::from("active")),
            ],
        )
        .await?;
    Ok(claimed > 0)
}

/// `failImportedIntervention`.
pub(super) async fn fail_import(db: &Db, id: i64, message: Option<&str>) -> anyhow::Result<()> {
    let Some(mut record) = load(db, id).await? else {
        return Ok(());
    };
    if record.state != "importing" {
        return Ok(());
    }
    record.state = String::from("active");
    record.cleanup_error = Some(js_slice(message.unwrap_or("Manual import failed."), 2000));
    save(db, &record, None).await
}

/// `resolveImportedIntervention`.
pub(super) async fn resolve_import(db: &Db, id: i64, user_id: i64) -> anyhow::Result<()> {
    let Some(mut record) = load(db, id).await? else {
        return Ok(());
    };
    if record.state == "resolved" || record.state == "rejecting" {
        return Ok(());
    }
    record.state = String::from("resolved");
    record.resolution = Some(String::from("manual_import"));
    record.acted_by_user_id = Some(user_id);
    record.cleanup_error = None;
    save(db, &record, Some(&Utc::now())).await
}

/// One `key=value` pair of the list query, or the reason it is Node's.
fn list_query(raw: &str) -> Result<ListQuery, String> {
    let mut q = ListQuery {
        history: false,
        take: 25,
        skip: 0,
        service_type: None,
        service_id: None,
        media_type: None,
    };
    let mut seen: Vec<&str> = Vec::new();
    for pair in raw.split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if seen.contains(&key) {
            return Err(String::from("a repeated query key"));
        }
        seen.push(key);
        let value = super::user::decode_query_value(value)
            .ok_or_else(|| String::from("a query value the validator judges"))?;
        let number = || super::blocklist::plain_integer(&value);
        match (key, value.as_str()) {
            ("mode", "active") => q.history = false,
            ("mode", "history") => q.history = true,
            ("take", _) => match number() {
                Some(n @ 1..=100) => q.take = n,
                _ => return Err(String::from("take outside 1..100")),
            },
            ("skip", _) => {
                q.skip = number().ok_or_else(|| String::from("skip isn't a plain integer"))?;
            }
            ("serviceType", "radarr" | "sonarr") => q.service_type = Some(value.clone()),
            ("serviceId", _) => match number() {
                Some(n) if n > 0 => q.service_id = Some(n),
                _ => return Err(String::from("serviceId zod would reject")),
            },
            ("mediaType", "movie" | "tv") => q.media_type = Some(value.clone()),
            _ => return Err(String::from("a query the validator judges")),
        }
    }
    Ok(q)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ListQuery {
    history: bool,
    take: i64,
    skip: i64,
    service_type: Option<String>,
    service_id: Option<i64>,
    media_type: Option<String>,
}

/// `User.displayName`: username, Plex name, Jellyfin name, then the
/// lower-cased email.
fn display_name(user: &crate::db::UserRecord) -> String {
    let email = user.email.as_deref().unwrap_or("").to_lowercase();
    [&user.username, &user.plex_username, &user.jellyfin_username]
        .into_iter()
        .find_map(|v| v.as_deref().filter(|s| !s.is_empty()))
        .map_or(email, str::to_owned)
}

/// `GET /servarr/interventions`.
fn list<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.authenticated(MANAGE_REQUESTS));
        let q = try_forward!(list_query(ctx.req.uri.query().unwrap_or("")));
        let db = &ctx.state.db;
        let mut sql = String::from(if q.history {
            r#" WHERE "resolution" IN ('manual_blocklist', 'automatic_blocklist')"#
        } else {
            r#" WHERE "state" IN ('active', 'rejecting', 'importing')"#
        });
        let mut binds = Vec::new();
        if let Some(t) = &q.service_type {
            binds.push(Bind::Text(t.clone()));
            sql.push_str(r#" AND "serviceType" = ?"#);
            sql.push_str(&binds.len().to_string());
        }
        if let Some(id) = q.service_id {
            binds.push(Bind::Int(id));
            sql.push_str(r#" AND "serviceId" = ?"#);
            sql.push_str(&binds.len().to_string());
        }
        if let Some(t) = &q.media_type {
            binds.push(Bind::Text(t.clone()));
            sql.push_str(r#" AND "mediaType" = ?"#);
            sql.push_str(&binds.len().to_string());
        }
        let total = try_forward!(db
            .scalar(
                &format!(r#"SELECT COUNT(*) FROM "servarr_intervention"{sql}"#),
                &binds
            )
            .await
            .map_err(|e| format!("database: {e:#}")));
        let order = if q.history {
            "resolvedAt"
        } else {
            "firstSeenAt"
        };
        let rows = try_forward!(db
            .rows(
                &format!(
                    r#"SELECT {} FROM "servarr_intervention"{sql} ORDER BY "{order}" DESC LIMIT {} OFFSET {}"#,
                    columns(db),
                    q.take,
                    q.skip
                ),
                &binds,
            )
            .await
            .map_err(|e| format!("database: {e:#}")));
        let Some(items) = rows.iter().map(from_row).collect::<Option<Vec<_>>>() else {
            return Outcome::forward(String::from("an intervention row of an unexpected shape"));
        };
        let mut actors: Vec<(i64, String)> = Vec::new();
        for id in items.iter().filter_map(|i| i.acted_by_user_id) {
            if actors.iter().any(|(a, _)| *a == id) {
                continue;
            }
            if let Some((user, _)) = try_forward!(db
                .user_record(id)
                .await
                .map_err(|e| format!("database: {e:#}")))
            {
                actors.push((id, display_name(&user)));
            }
        }
        let results: Vec<Value> = items
            .iter()
            .map(|item| {
                let mut out = public_json(item);
                let actor = item
                    .acted_by_user_id
                    .filter(|id| *id != 0)
                    .and_then(|id| actors.iter().find(|(a, _)| *a == id))
                    .map_or(Value::Null, |(id, name)| {
                        let mut a = Map::new();
                        a.insert(String::from("id"), Value::from(*id));
                        a.insert(String::from("displayName"), Value::from(name.as_str()));
                        Value::Object(a)
                    });
                out.insert(String::from("actor"), actor);
                Value::Object(out)
            })
            .collect();
        let mut page = Map::new();
        page.insert(
            String::from("pages"),
            Value::from((total + q.take - 1) / q.take),
        );
        page.insert(String::from("pageSize"), Value::from(q.take));
        page.insert(String::from("results"), Value::from(total));
        page.insert(String::from("page"), Value::from(q.skip / q.take + 1));
        let mut body = Map::new();
        body.insert(String::from("pageInfo"), Value::Object(page));
        body.insert(String::from("results"), Value::Array(results));
        ctx.json(&Value::Object(body))
    })
}

/// The signed-in user's `servarrInterventionsSeenAt` as stored (ISO) and
/// the settings row id, or `None` without a settings row.
async fn seen_at(ctx: &Ready<'_>, user_id: i64) -> Result<Option<(i64, Option<String>)>, String> {
    let db = &ctx.state.db;
    let rows = db
        .rows(
            &format!(
                r#"SELECT CAST("id" AS BIGINT) AS "id", {} AS "seenAt" FROM "user_settings" WHERE "userId" = ?1"#,
                db.iso_sql(r#""servarrInterventionsSeenAt""#)
            ),
            &[Bind::Int(user_id)],
        )
        .await
        .map_err(|e| format!("database: {e:#}"))?;
    Ok(rows.first().and_then(|r| {
        Some((
            r.get("id").and_then(Value::as_i64)?,
            r.get("seenAt").and_then(Value::as_str).map(str::to_owned),
        ))
    }))
}

/// `GET /servarr/interventions/count`.
fn count<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let user = try_forward!(ctx.authenticated(MANAGE_REQUESTS));
        let db = &ctx.state.db;
        let active_sql = r#"SELECT COUNT(*) FROM "servarr_intervention" WHERE "state" IN ('active', 'rejecting', 'importing')"#;
        let active = try_forward!(db
            .scalar(active_sql, &[])
            .await
            .map_err(|e| format!("database: {e:#}")));
        let seen = try_forward!(seen_at(ctx, user.id).await).and_then(|(_, s)| s);
        let unseen = match seen {
            None => active,
            Some(iso) => {
                let Some(ms) = crate::clock::parse_date_millis(&iso) else {
                    return Outcome::forward(String::from("a seen date that doesn't parse"));
                };
                let at = Utc::from_unix_millis(ms);
                try_forward!(db
                    .scalar(
                        &format!(r#"{active_sql} AND "firstSeenAt" > {}"#, date_param(db, 1)),
                        &[date_bind(db, &at)],
                    )
                    .await
                    .map_err(|e| format!("database: {e:#}")))
            }
        };
        let mut body = Map::new();
        body.insert(String::from("active"), Value::from(active));
        body.insert(String::from("unseen"), Value::from(unseen));
        ctx.json(&Value::Object(body))
    })
}

/// `POST /servarr/interventions/seen`. A user without a settings row gets
/// one.
fn seen<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let user = try_forward!(ctx.authenticated(MANAGE_REQUESTS));
        let db = &ctx.state.db;
        let Some((settings_id, stored)) = try_forward!(seen_at(ctx, user.id).await) else {
            // `new UserSettings({ user })` saved with the date: the
            // `locale` default, the rest null.
            let now = Utc::now();
            if let Err(e) = db
                .execute(
                    &format!(
                        r#"INSERT INTO "user_settings" ("locale", "servarrInterventionsSeenAt", "userId") VALUES ('', {}, ?2)"#,
                        date_param(db, 1)
                    ),
                    &[date_bind(db, &now), Bind::Int(user.id)],
                )
                .await
            {
                return ctx.error(500, &format!("{e:#}"));
            }
            let mut body = Map::new();
            body.insert(String::from("seenAt"), Value::from(now.iso_string()));
            return ctx.json(&Value::Object(body));
        };
        let now = Utc::now();
        if stored.as_deref() != Some(now.iso_string().as_str()) {
            if let Err(e) = db
                .execute(
                    &format!(
                        r#"UPDATE "user_settings" SET "servarrInterventionsSeenAt" = {} WHERE "id" = ?2"#,
                        date_param(db, 1)
                    ),
                    &[date_bind(db, &now), Bind::Int(settings_id)],
                )
                .await
            {
                return ctx.error(500, &format!("{e:#}"));
            }
        }
        let mut body = Map::new();
        body.insert(String::from("seenAt"), Value::from(now.iso_string()));
        ctx.json(&Value::Object(body))
    })
}

/// An error thrown with a `status`, or an Arr failure.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum RejectError {
    Status(u16, String),
    Arr(ArrError),
}

impl RejectError {
    pub(super) fn message(&self) -> String {
        match self {
            Self::Status(_, m) => m.clone(),
            Self::Arr(e) => e.message(),
        }
    }

    /// The status Node answers with: the error's own, an Arr answer's, or
    /// 502.
    const fn status(&self) -> u16 {
        match self {
            Self::Status(s, _) => *s,
            Self::Arr(ArrError::Http { status, .. }) => *status,
            Self::Arr(ArrError::Transport(_) | ArrError::Plain(..)) => 502,
        }
    }
}

/// `interventionRejectionTimeout()`.
pub(super) fn rejection_timeout(settings: &crate::settings::Settings) -> u64 {
    match timeout_ms(settings) {
        0 => REJECTION_TIMEOUT_MS,
        n => n.max(REJECTION_TIMEOUT_MS),
    }
}

/// The Arr calls of a rejection: the exact queue item must still be a
/// warning for the mapped title, then it is removed and blocklisted.
pub(super) async fn rejection_work(
    state: Arc<AppState>,
    server: Value,
    record: Intervention,
    api_timeout: u64,
    timeout: u64,
) -> Result<(), RejectError> {
    let radarr = record.service_type == "radarr";
    let arr = ArrServer {
        client: &state.outbound,
        server: &server,
        timeout_ms: api_timeout,
        api_name: if radarr { "Radarr" } else { "Sonarr" },
    };
    let queue = arr.queue().await.map_err(RejectError::Arr)?;
    let exact = queue
        .iter()
        .find(|item| item.get("id").and_then(Value::as_i64) == Some(record.queue_id));
    let media = state
        .db
        .media_by_ids(&[record.media_id], false)
        .await
        .map_err(|e| RejectError::Status(500, format!("{e:#}")))?
        .pop();
    let external_key = if radarr { "movieId" } else { "seriesId" };
    let still_valid = match (exact, media.as_ref()) {
        (Some(item), Some(media)) => {
            item.get("trackedDownloadStatus")
                .and_then(Value::as_str)
                .is_some_and(|s| s.to_lowercase() == "warning")
                && item.get(external_key).and_then(Value::as_i64)
                    == Some(record.external_service_id)
                && mapped_to_service(media, record.service_id, record.external_service_id)
        }
        _ => false,
    };
    if !still_valid {
        return Err(RejectError::Status(
            409,
            String::from("The exact queue warning is no longer mapped and active."),
        ));
    }
    arr.request(
        Method::DELETE,
        &format!("/queue/{}", record.queue_id),
        &[
            ("removeFromClient", String::from("true")),
            ("blocklist", String::from("true")),
            ("skipRedownload", String::from("false")),
        ],
        None,
        timeout,
    )
    .await
    .map_err(RejectError::Arr)?;
    Ok(())
}

/// `mappedToService`.
pub(super) fn mapped_to_service(
    media: &crate::db::MediaRow,
    service_id: i64,
    external_id: i64,
) -> bool {
    (media.service_id == Some(service_id) && media.external_service_id == Some(external_id))
        || (media.service_id4k == Some(service_id)
            && media.external_service_id4k == Some(external_id))
}

/// `POST /servarr/interventions/{id}/reject`.
fn reject<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let user = try_forward!(ctx.authenticated(MANAGE_REQUESTS));
        let id = try_forward!(ctx.path_id(1));
        if id <= 0 {
            return Outcome::forward(String::from("zod rejects the id"));
        }
        let db = &ctx.state.db;
        let Some(mut record) =
            try_forward!(load(db, id).await.map_err(|e| format!("database: {e:#}")))
        else {
            return ctx.error(404, "Intervention not found.");
        };
        if record.state == "resolved" {
            if record
                .resolution
                .as_deref()
                .is_some_and(|r| r.ends_with("_blocklist"))
            {
                return ctx.json(&Value::Object(public_json(&record)));
            }
            return ctx.error(409, "This warning is no longer active.");
        }
        let claimed = try_forward!(db
            .execute(
                r#"UPDATE "servarr_intervention" SET "state" = ?1, "cleanupError" = NULL, "actedByUserId" = ?2, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?3 AND "state" = ?4"#,
                &[
                    Bind::Text(String::from("rejecting")),
                    Bind::Int(user.id),
                    Bind::Int(id),
                    Bind::Text(String::from("active")),
                ],
            )
            .await
            .map_err(|e| format!("database: {e:#}")));
        if claimed == 0 {
            return ctx.error(409, "This warning is already being rejected.");
        }
        record.state = String::from("rejecting");
        record.cleanup_error = None;
        let outcome = run_rejection(ctx, &record).await;
        finish_rejection(ctx, record, user.id, outcome).await
    })
}

/// The Arr side of a rejection under the rejection timeout. On timeout the
/// calls carry on in the background, as Node's `withTimeout` leaves them.
async fn run_rejection(ctx: &Ready<'_>, record: &Intervention) -> Result<(), RejectError> {
    let section = if record.service_type == "radarr" {
        "/radarr"
    } else {
        "/sonarr"
    };
    let server = ctx
        .settings
        .get(section)
        .and_then(Value::as_array)
        .and_then(|servers| {
            servers.iter().find(|s| {
                s.get("id").and_then(Value::as_i64) == Some(record.service_id)
                    && truthy(s.get("syncEnabled"))
            })
        })
        .cloned();
    let Some(server) = server else {
        return Err(RejectError::Status(
            409,
            String::from("The mapped Arr service is disabled or missing."),
        ));
    };
    let timeout = rejection_timeout(&ctx.settings);
    let work = tokio::spawn(rejection_work(
        Arc::clone(&ctx.shared),
        server,
        record.clone(),
        timeout_ms(&ctx.settings),
        timeout,
    ));
    match tokio::time::timeout(Duration::from_millis(timeout), work).await {
        Ok(Ok(result)) => result,
        Ok(Err(e)) => Err(RejectError::Status(500, format!("{e}"))),
        Err(_) => Err(RejectError::Status(
            504,
            String::from("Rejection timed out."),
        )),
    }
}

/// The record's save after the Arr calls, and the answer.
async fn finish_rejection(
    ctx: &Ready<'_>,
    mut record: Intervention,
    user_id: i64,
    outcome: Result<(), RejectError>,
) -> Outcome {
    let db = &ctx.state.db;
    match outcome {
        Ok(()) => {
            let now = Utc::now();
            record.state = String::from("resolved");
            record.resolution = Some(String::from("manual_blocklist"));
            record.acted_by_user_id = Some(user_id);
            record.resolved_at = Some(now.iso_string());
            record.cleanup_error = None;
            if let Err(e) = save(db, &record, Some(&now)).await {
                return ctx.error(500, &format!("{e:#}"));
            }
            ctx.json(&Value::Object(public_json(&record)))
        }
        Err(error) => {
            record.state = String::from("active");
            record.cleanup_error = Some(js_slice(&error.message(), 2000));
            if let Err(e) = save(db, &record, None).await {
                return ctx.error(500, &format!("{e:#}"));
            }
            tracing::error!(
                "Unable to reject Servarr intervention {}: {}",
                record.id,
                error.message()
            );
            ctx.error(error.status(), &error.message())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helpers() {
        assert_eq!(
            list_query("").ok(),
            Some(ListQuery {
                history: false,
                take: 25,
                skip: 0,
                service_type: None,
                service_id: None,
                media_type: None,
            }),
            "defaults"
        );
        assert!(list_query("take=0").is_err(), "take below 1");
        assert!(list_query("take=101").is_err(), "take above 100");
        assert!(list_query("serviceId=0").is_err(), "zod positive");
        assert!(list_query("mode=x").is_err(), "enum");
        assert!(list_query("x=1").is_err(), "unknown key");
        assert_eq!(
            list_query("mode=history&serviceType=sonarr&mediaType=tv&skip=5")
                .map(|q| (q.history, q.service_type, q.skip))
                .ok(),
            Some((true, Some(String::from("sonarr")), 5)),
            "filters"
        );
        assert_eq!(js_slice("abcdef", 3), "abc", "slice");
        assert_eq!(js_slice("a😀b", 2), "a", "a surrogate pair counts two");
        assert_eq!(
            string_array(Some("[\"x\"]")),
            serde_json::json!(["x"]),
            "stored list"
        );
        assert_eq!(
            string_array(Some("nope")),
            serde_json::json!([]),
            "bad json"
        );
        assert_eq!(string_array(None), serde_json::json!([]), "null");
    }
}
