//! `/settings/mapping/*` (`server/routes/settings/mapping.ts`).
//!
//! Resolutions and corrections are read and written here; Node keeps the
//! state around them (batched miss sightings, refresh progress, dataset
//! generations, lookup caches), reached over its `/internal` routes.

use anyhow::Result;
use axum::http::Method;
use serde_json::{Map, Value};

use super::nodestate::{
    admin, decode_segment, js_trim, node_call, object_body, object_body_or_empty, pick,
    raw_segment, NativeFut,
};
use super::{Outcome, Ready, Table};
use crate::clock::Utc;
use crate::db::{Bind, Db};
use crate::settings::public::truthy;

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/settings/mapping/status", Method::GET, status),
    (
        "/api/v1/settings/mapping/resolutions",
        Method::GET,
        resolutions,
    ),
    (
        "/api/v1/settings/mapping/resolutions/{id}",
        Method::DELETE,
        delete_resolution,
    ),
    (
        "/api/v1/settings/mapping/corrections",
        Method::POST,
        correction,
    ),
    (
        "/api/v1/settings/mapping/corrections/import",
        Method::POST,
        import,
    ),
    (
        "/api/v1/settings/mapping/datasets/{key}",
        Method::POST,
        dataset_toggle,
    ),
    (
        "/api/v1/settings/mapping/datasets/{key}/refresh",
        Method::POST,
        dataset_refresh,
    ),
];

/// `NAMESPACES`.
const NAMESPACES: [&str; 10] = [
    "tmdb_movie",
    "tmdb_show",
    "tvdb_movie",
    "tvdb_show",
    "imdb",
    "anidb",
    "anilist",
    "mal",
    "simkl",
    "trakt",
];

/// `DATASETS` keys.
const DATASET_KEYS: [&str; 2] = ["anibridge", "fribb"];

/// `MappingDataset`'s columns, in declaration order.
const DATASET_FIELDS: [&str; 10] = [
    "key",
    "enabled",
    "generation",
    "edgeCount",
    "version",
    "etag",
    "lastModified",
    "lastFetchedAt",
    "lastSuccessAt",
    "lastError",
];

/// What `/status` lists per dataset.
const STATUS_FIELDS: [&str; 9] = [
    "key",
    "enabled",
    "licence",
    "note",
    "edgeCount",
    "version",
    "lastFetchedAt",
    "lastSuccessAt",
    "lastError",
];

/// The three lists and the origins each holds.
const LISTS: [(&str, &str); 3] = [
    ("unmapped", "'miss'"),
    ("manual", "'manual'"),
    ("guessed", "'title', 'prequel'"),
];

/// Node's mapping-layer `/internal` routes, answered in this process when
/// it owns the mapping state.
async fn mapping_call(
    ctx: &Ready<'_>,
    method: Method,
    path: &str,
    body: Option<&Value>,
) -> Result<(u16, Value)> {
    if crate::mappinglayer::owned() {
        if let Some(answer) = crate::mappinglayer::answer(ctx.state, &method, path, body).await {
            return Ok((answer.status, answer.body));
        }
    }
    node_call(ctx, method, path, body).await
}

/// `GET /settings/mapping/status`.
fn status<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(async move {
        if let Err(why) = admin(ctx) {
            return Outcome::forward(why);
        }
        let state = match mapping_call(ctx, Method::GET, "/mapping/status", None).await {
            Ok((200, state)) => state,
            Ok((status, _)) => {
                tracing::error!("Node's mapping status answered {status}");
                return ctx.error(500, "Unable to retrieve mapping status.");
            }
            Err(e) => return Outcome::forward(format!("{e:#}")),
        };
        let empty = Vec::new();
        let refreshes = state
            .get("refreshes")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        let datasets: Vec<Value> = state
            .get("datasets")
            .and_then(Value::as_array)
            .unwrap_or(&empty)
            .iter()
            .map(|dataset| {
                let mut out = pick(dataset, &STATUS_FIELDS);
                let refresh = refreshes
                    .iter()
                    .find(|r| super::nodestate::js_strict_eq(r.get("key"), dataset.get("key")));
                if let Some(refresh) = refresh {
                    out.insert(String::from("refresh"), refresh.clone());
                }
                Value::Object(out)
            })
            .collect();
        let mut counts = Map::new();
        for (list, origins) in LISTS {
            let sql = format!(
                "SELECT COUNT(*) FROM \"mapping_resolution\" WHERE \"origin\" IN ({origins})"
            );
            match ctx.state.db.scalar(&sql, &[]).await {
                Ok(n) => {
                    counts.insert(list.to_owned(), Value::from(n));
                }
                Err(e) => {
                    tracing::error!("counting mapping resolutions failed: {e:#}");
                    return ctx.error(500, "Unable to retrieve mapping status.");
                }
            }
        }
        let mut out = Map::new();
        out.insert(String::from("datasets"), Value::Array(datasets));
        out.insert(String::from("counts"), Value::Object(counts));
        ctx.json(&Value::Object(out))
    })
}

/// The resolutions query: which list, `take` and `skip` as
/// `listResolutions` clamps them.
fn parse_list_query(raw: &str) -> Result<(usize, i64, i64), String> {
    let (mut list, mut take, mut skip) = (None, 50, 0);
    let mut seen: Vec<&str> = Vec::new();
    for pair in raw.split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if seen.contains(&key) {
            return Err(String::from("a repeated query key"));
        }
        seen.push(key);
        let value = super::user::decode_query_value(value)
            .ok_or_else(|| String::from("a reserved or malformed query value"))?;
        let number = || {
            super::blocklist::plain_integer(&value)
                .filter(|n| *n <= 1_000_000_000)
                .ok_or_else(|| String::from("an unsupported number"))
        };
        match key {
            "list" => {
                list = Some(
                    LISTS
                        .iter()
                        .position(|(name, _)| *name == value)
                        .ok_or_else(|| String::from("an unknown list; the validator answers"))?,
                );
            }
            "take" => take = number()?,
            "skip" => skip = number()?,
            _ => return Err(String::from("an unknown query key")),
        }
    }
    let list = list.ok_or_else(|| String::from("list is required"))?;
    let take = if take == 0 { 50 } else { take.clamp(1, 1000) };
    Ok((list, take, skip))
}

/// One `MappingResolution` row as `TypeORM` serialises the entity.
fn resolution_columns(db: &Db) -> String {
    format!(
        "\"id\", \"srcNs\", \"srcId\", \"mediaType\", \"tmdbId\", \"tmdbType\", \"origin\", \
         \"title\", \"year\", \"discoverSource\", \"detail\", \"hitCount\", \"createdByUserId\", \
         {} AS \"checkedAt\", {} AS \"createdAt\", {} AS \"updatedAt\"",
        db.iso_sql("\"checkedAt\""),
        db.iso_sql("\"createdAt\""),
        db.iso_sql("\"updatedAt\"")
    )
}

/// `GET /settings/mapping/resolutions`.
fn resolutions<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(async move {
        if let Err(why) = ctx.authenticated(super::ADMIN) {
            return Outcome::forward(why);
        }
        let (list, take, skip) = match super::params::query(ctx) {
            Some(q) => {
                // `LISTS.find((candidate) => candidate === req.query.list)`.
                let Some(list) = q
                    .get("list")
                    .and_then(Value::as_str)
                    .and_then(|v| LISTS.iter().position(|(name, _)| *name == v))
                else {
                    return ctx.error(400, "Unknown mapping list.");
                };
                // `Number(take) || 50` and `Number(skip) || 0`, clamped by
                // `listResolutions`.
                let take = match super::params::int_or(q.get("take"), "take", 50) {
                    Ok(take) => take.clamp(1, 1000),
                    Err(why) => return Outcome::forward(why),
                };
                let skip = match super::params::int_or(q.get("skip"), "skip", 0) {
                    Ok(skip) => skip.max(0),
                    Err(why) => return Outcome::forward(why),
                };
                (list, take, skip)
            }
            None => match parse_list_query(ctx.req.uri.query().unwrap_or("")) {
                Ok(parsed) => parsed,
                Err(why) => return Outcome::forward(why),
            },
        };
        let Some(&(name, origins)) = LISTS.get(list) else {
            return Outcome::forward(String::from("unknown list"));
        };
        if name == "unmapped" {
            match mapping_call(ctx, Method::POST, "/mapping/flush", None).await {
                Ok((204, _)) => {}
                Ok((status, _)) => {
                    tracing::error!("Node's mapping flush answered {status}");
                    return ctx.error(500, "Unable to retrieve mappings.");
                }
                Err(e) => return Outcome::forward(format!("{e:#}")),
            }
        }
        let db = &ctx.state.db;
        let order = if name == "unmapped" {
            "\"hitCount\" DESC, \"updatedAt\" DESC"
        } else {
            "\"updatedAt\" DESC"
        };
        let sql = format!(
            "SELECT {} FROM \"mapping_resolution\" WHERE \"origin\" IN ({origins}) \
             ORDER BY {order} LIMIT ?1 OFFSET ?2",
            resolution_columns(db)
        );
        let count_sql =
            format!("SELECT COUNT(*) FROM \"mapping_resolution\" WHERE \"origin\" IN ({origins})");
        let binds = [Bind::Int(take), Bind::Int(skip)];
        let rows = db.rows(&sql, &binds).await;
        let total = db.scalar(&count_sql, &[]).await;
        match (rows, total) {
            (Ok(rows), Ok(total)) => {
                let mut out = Map::new();
                out.insert(
                    String::from("results"),
                    Value::Array(rows.into_iter().map(Value::Object).collect()),
                );
                out.insert(String::from("total"), Value::from(total));
                ctx.json(&Value::Object(out))
            }
            (Err(e), _) | (_, Err(e)) => {
                tracing::error!("listing mapping resolutions failed: {e:#}");
                ctx.error(500, "Unable to retrieve mappings.")
            }
        }
    })
}

/// Drop Node's lookup caches after a write here.
async fn invalidate(ctx: &Ready<'_>) {
    match mapping_call(ctx, Method::POST, "/mapping/invalidate", None).await {
        Ok((204, _)) => {}
        Ok((status, _)) => tracing::warn!("Node refused to drop mapping caches: {status}"),
        Err(e) => tracing::warn!("Node could not be told to drop mapping caches: {e:#}"),
    }
}

/// `DELETE /settings/mapping/resolutions/{id}`.
fn delete_resolution<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(async move {
        if let Err(why) = admin(ctx) {
            return Outcome::forward(why);
        }
        let id = match super::params::param(ctx, 0)
            .as_deref()
            .and_then(super::params::integer)
        {
            Some(id) if id > 0 => id,
            _ => return ctx.error(400, "A mapping id is required."),
        };
        let deleted = ctx
            .state
            .db
            .execute(
                "DELETE FROM \"mapping_resolution\" WHERE \"id\" IN (?1)",
                &[Bind::Int(id)],
            )
            .await
            .map_err(|e| format!("{e:#}"));
        if let Err(e) = deleted {
            tracing::error!("deleting a mapping resolution failed: {e}");
            return ctx.error(500, "Unable to delete the mapping.");
        }
        invalidate(ctx).await;
        Ready::no_content()
    })
}

/// A parsed correction.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Correction {
    src_ns: String,
    src_id: String,
    tmdb_id: Option<i64>,
    tmdb_type: Option<String>,
    note: Option<String>,
}

/// `a ?? b`.
const fn coalesce<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    match a {
        None | Some(Value::Null) => b,
        some @ Some(_) => some,
    }
}

/// Whether the validator accepts a correction (`MappingCorrection`).
fn correction_fits(body: &Map<String, Value>) -> bool {
    let ok = |key: &str, check: &dyn Fn(&Value) -> bool| body.get(key).is_none_or(check);
    ok("srcNs", &|v| {
        v.as_str().is_some_and(|s| NAMESPACES.contains(&s))
    }) && ok("srcId", &Value::is_string)
        && ok("tmdbId", &|v| v.is_number() || v.is_null())
        && ok("tmdbType", &|v| {
            v.is_null() || matches!(v.as_str(), Some("movie" | "tv"))
        })
        && ok("note", &Value::is_string)
}

/// `String(value)` for an id; none where that isn't followed here.
fn id_text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) if n.is_i64() || n.is_u64() => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(_) | Value::Null | Value::Array(_) | Value::Object(_) => None,
    }
}

/// `parseCorrection`: the correction, `None` when it is invalid, or why
/// Node has to judge it.
fn parse_correction(body: &Map<String, Value>) -> Result<Option<Correction>, String> {
    let src_ns = coalesce(body.get("srcNs"), body.get("fromNamespace"));
    let src_id = coalesce(body.get("srcId"), body.get("fromExternalId"));
    let Some(src_ns) = src_ns
        .and_then(Value::as_str)
        .filter(|s| NAMESPACES.contains(s))
    else {
        return Ok(None);
    };
    if !truthy(src_id) {
        return Ok(None);
    }
    let src_id = src_id
        .and_then(id_text)
        .ok_or_else(|| String::from("a source id String() isn't followed here"))?;
    let to_namespace = body.get("toNamespace");
    let legacy_type = match to_namespace {
        Some(Value::String(ns)) if ns == "tmdb_movie" => Some("movie"),
        Some(Value::String(ns)) if ns == "tmdb_show" => Some("tv"),
        _ => None,
    };
    if to_namespace.is_some() && legacy_type.is_none() {
        return Ok(None);
    }
    let tmdb_type = match body.get("tmdbType").and_then(Value::as_str) {
        Some(t @ ("movie" | "tv")) => Some(t),
        _ => legacy_type,
    };
    let raw_id = coalesce(body.get("tmdbId"), body.get("toExternalId"));
    let raw_note = match body.get("note") {
        Some(Value::String(_)) => body.get("note"),
        _ => body.get("detail"),
    };
    let note = raw_note
        .and_then(Value::as_str)
        .map(js_trim)
        .filter(|n| !n.is_empty())
        .map(str::to_owned);
    let unset = match raw_id {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s.is_empty(),
        Some(_) => false,
    };
    if unset {
        return Ok(Some(Correction {
            src_ns: src_ns.to_owned(),
            src_id,
            tmdb_id: None,
            tmdb_type: None,
            note,
        }));
    }
    let tmdb_id = match raw_id {
        Some(Value::Number(n)) => match n.as_i64() {
            Some(id) => Some(id),
            None if n.as_f64().is_some_and(|f| f.fract() != 0.0 || f < 0.0) => None,
            None => return Err(String::from("a TMDB id out of range")),
        },
        Some(Value::String(s)) => {
            let t = js_trim(s);
            if !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit()) {
                Some(
                    t.parse::<i64>()
                        .map_err(|_| String::from("a TMDB id out of range"))?,
                )
            } else {
                None
            }
        }
        Some(Value::Array(_)) => return Err(String::from("an array TMDB id")),
        _ => None,
    };
    let (Some(tmdb_type), Some(tmdb_id)) = (tmdb_type, tmdb_id.filter(|id| *id > 0)) else {
        return Ok(None);
    };
    if tmdb_id > i64::from(i32::MAX) {
        return Err(String::from("a TMDB id the integer column can't hold"));
    }
    Ok(Some(Correction {
        src_ns: src_ns.to_owned(),
        src_id,
        tmdb_id: Some(tmdb_id),
        tmdb_type: Some(tmdb_type.to_owned()),
        note,
    }))
}

/// A timestamp bind and its SQL as `TypeORM` writes a `Date` there.
fn timestamp(db: &Db, now: &Utc, index: usize) -> (String, Bind) {
    if db.is_postgres() {
        (
            format!("CAST(?{index} AS timestamptz)"),
            Bind::Text(now.iso_string()),
        )
    } else {
        (format!("?{index}"), Bind::Text(now.typeorm_string()))
    }
}

/// What the sightings knew about an item, carried into its correction.
#[derive(Debug, Default)]
struct Known {
    title: Option<String>,
    year: Option<i64>,
    discover_source: Option<String>,
}

/// `saveManual`: drop what was inferred for the id, then store the
/// correction over any earlier one.
async fn save_manual(db: &Db, c: &Correction, user_id: i64) -> Result<()> {
    let inferred = db
        .rows(
            "SELECT \"id\", \"title\", \"year\", \"discoverSource\" FROM \"mapping_resolution\" \
             WHERE \"srcNs\" = ?1 AND \"srcId\" = ?2 AND \"origin\" != 'manual'",
            &[Bind::Text(c.src_ns.clone()), Bind::Text(c.src_id.clone())],
        )
        .await?;
    let known_row = inferred
        .iter()
        .find(|row| truthy(row.get("title")))
        .or_else(|| inferred.first());
    let known = known_row.map_or_else(Known::default, |row| Known {
        title: row.get("title").and_then(Value::as_str).map(str::to_owned),
        year: row.get("year").and_then(Value::as_i64),
        discover_source: row
            .get("discoverSource")
            .and_then(Value::as_str)
            .map(str::to_owned),
    });
    let ids: Vec<i64> = inferred
        .iter()
        .filter_map(|row| row.get("id").and_then(Value::as_i64))
        .collect();
    if !ids.is_empty() {
        let marks: Vec<String> = (1..=ids.len()).map(|i| format!("?{i}")).collect();
        let sql = format!(
            "DELETE FROM \"mapping_resolution\" WHERE \"id\" IN ({})",
            marks.join(", ")
        );
        let binds: Vec<Bind> = ids.into_iter().map(Bind::Int).collect();
        db.execute(&sql, &binds).await?;
    }
    let mut last_error = None;
    for _attempt in 0..2 {
        match save_resolution(db, c, &known, user_id).await {
            Ok(()) => return Ok(()),
            Err(e) => last_error = Some(e),
        }
    }
    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("saving the correction failed")))
}

/// `saveResolution` for a manual write: update the row filed without a
/// media type, or insert it.
async fn save_resolution(db: &Db, c: &Correction, known: &Known, user_id: i64) -> Result<()> {
    let now = Utc::now();
    let existing = db
        .rows(
            "SELECT \"id\", \"hitCount\" FROM \"mapping_resolution\" \
             WHERE \"srcNs\" = ?1 AND \"srcId\" = ?2 AND \"mediaType\" = '' LIMIT 1",
            &[Bind::Text(c.src_ns.clone()), Bind::Text(c.src_id.clone())],
        )
        .await?;
    if let Some(row) = existing.first() {
        // An update only carries what is truthy (`...(write.title ? ...)`).
        let title = known.title.clone().filter(|t| !t.is_empty());
        let year = known.year.filter(|y| *y != 0);
        let source = known.discover_source.clone().filter(|s| !s.is_empty());
        let id = row.get("id").and_then(Value::as_i64).unwrap_or(0);
        let hits = row.get("hitCount").and_then(Value::as_i64).unwrap_or(0);
        let mut sets = vec![
            String::from("\"tmdbId\" = ?1"),
            String::from("\"tmdbType\" = ?2"),
            String::from("\"origin\" = 'manual'"),
            String::from("\"hitCount\" = ?3"),
        ];
        let mut binds = vec![
            Bind::OptInt(c.tmdb_id),
            Bind::OptText(c.tmdb_type.clone()),
            Bind::Int(hits),
        ];
        let (checked, checked_bind) = timestamp(db, &now, binds.len() + 1);
        sets.push(format!("\"checkedAt\" = {checked}"));
        binds.push(checked_bind);
        let (updated, updated_bind) = timestamp(db, &now, binds.len() + 1);
        sets.push(format!("\"updatedAt\" = {updated}"));
        binds.push(updated_bind);
        let optional = [
            ("title", title.map(Bind::Text)),
            ("year", year.map(Bind::Int)),
            ("discoverSource", source.map(Bind::Text)),
            ("detail", c.note.clone().map(Bind::Text)),
            (
                "createdByUserId",
                Some(user_id).filter(|u| *u != 0).map(Bind::Int),
            ),
        ];
        for (column, bind) in optional {
            if let Some(bind) = bind {
                binds.push(bind);
                sets.push(format!("\"{column}\" = ?{}", binds.len()));
            }
        }
        binds.push(Bind::Int(id));
        let sql = format!(
            "UPDATE \"mapping_resolution\" SET {} WHERE \"id\" = ?{}",
            sets.join(", "),
            binds.len()
        );
        db.execute(&sql, &binds).await?;
        return Ok(());
    }
    let mut binds = vec![
        Bind::Text(c.src_ns.clone()),
        Bind::Text(c.src_id.clone()),
        Bind::OptInt(c.tmdb_id),
        Bind::OptText(c.tmdb_type.clone()),
        Bind::OptText(known.title.clone()),
        Bind::OptInt(known.year),
        Bind::OptText(known.discover_source.clone()),
        Bind::OptText(c.note.clone()),
        Bind::OptInt(Some(user_id)),
    ];
    let mut stamps = Vec::new();
    for _ in 0..3 {
        let (sql, bind) = timestamp(db, &now, binds.len() + 1);
        stamps.push(sql);
        binds.push(bind);
    }
    let sql = format!(
        "INSERT INTO \"mapping_resolution\" (\"srcNs\", \"srcId\", \"mediaType\", \"tmdbId\", \
         \"tmdbType\", \"origin\", \"title\", \"year\", \"discoverSource\", \"detail\", \
         \"hitCount\", \"createdByUserId\", \"checkedAt\", \"createdAt\", \"updatedAt\") \
         VALUES (?1, ?2, '', ?3, ?4, 'manual', ?5, ?6, ?7, ?8, 0, ?9, {})",
        stamps.join(", ")
    );
    db.execute(&sql, &binds).await?;
    Ok(())
}

/// `POST /settings/mapping/corrections`.
fn correction<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(async move {
        let user = match admin(ctx).and_then(|()| ctx.authenticated(super::ADMIN)) {
            Ok(user) => user,
            Err(why) => return Outcome::forward(why),
        };
        let body = match object_body_or_empty(ctx) {
            Ok(body) => body,
            Err(why) => return Outcome::forward(why),
        };
        if !correction_fits(body) {
            return Outcome::forward(String::from("a correction the validator may reject"));
        }
        let parsed = match parse_correction(body) {
            Ok(Some(c)) => c,
            Ok(None) => {
                return ctx.error(
                    400,
                    "A source namespace, source id and TMDB type are required.",
                )
            }
            Err(why) => return Outcome::forward(why),
        };
        let saved = save_manual(&ctx.state.db, &parsed, user.id).await;
        invalidate(ctx).await;
        if let Err(e) = saved {
            tracing::error!("saving a mapping correction failed: {e:#}");
            return ctx.error(500, "Unable to save the mapping correction.");
        }
        let mut out = Map::new();
        out.insert(String::from("status"), Value::from("saved"));
        ctx.json(&Value::Object(out))
    })
}

/// `POST /settings/mapping/corrections/import`.
fn import<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(async move {
        let user = match admin(ctx).and_then(|()| ctx.authenticated(super::ADMIN)) {
            Ok(user) => user,
            Err(why) => return Outcome::forward(why),
        };
        let body = match object_body_or_empty(ctx) {
            Ok(body) => body,
            Err(why) => return Outcome::forward(why),
        };
        let empty = Vec::new();
        let rows = match body.get("corrections") {
            None => &empty,
            Some(Value::Array(rows)) => rows,
            Some(_) => return Outcome::forward(String::from("corrections that aren't a list")),
        };
        let mut parsed = Vec::with_capacity(rows.len());
        for row in rows {
            let Some(row) = row.as_object().filter(|r| correction_fits(r)) else {
                return Outcome::forward(String::from("a correction the validator may reject"));
            };
            match parse_correction(row) {
                Ok(c) => parsed.push(c),
                Err(why) => return Outcome::forward(why),
            }
        }
        let (mut imported, mut skipped) = (0_i64, 0_i64);
        let mut failure = None;
        for c in &parsed {
            let Some(c) = c else {
                skipped += 1;
                continue;
            };
            if let Err(e) = save_manual(&ctx.state.db, c, user.id).await {
                failure = Some(e);
                break;
            }
            imported += 1;
        }
        invalidate(ctx).await;
        if let Some(e) = failure {
            tracing::error!("importing mapping corrections failed: {e:#}");
            return ctx.error(500, "Unable to import mapping corrections.");
        }
        let mut out = Map::new();
        out.insert(String::from("imported"), Value::from(imported));
        out.insert(String::from("skipped"), Value::from(skipped));
        ctx.json(&Value::Object(out))
    })
}

/// The dataset key of `/datasets/{key}[/refresh]`, decoded, if known.
fn dataset_key(raw: &str) -> Result<Option<String>, String> {
    let key = decode_segment(raw).ok_or_else(|| String::from("a key Express can't decode"))?;
    Ok(DATASET_KEYS.contains(&key.as_str()).then_some(key))
}

/// `POST /settings/mapping/datasets/{key}`: Node toggles the dataset (and
/// starts its download when enabled); the row comes back.
fn dataset_toggle<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(async move {
        if let Err(why) = admin(ctx) {
            return Outcome::forward(why);
        }
        let body = match object_body(ctx) {
            Ok(body) => body,
            Err(why) => return Outcome::forward(why),
        };
        let Some(Value::Bool(enabled)) = body.get("enabled") else {
            return Outcome::forward(String::from(
                "enabled isn't a boolean; the validator answers",
            ));
        };
        let key = match dataset_key(raw_segment(ctx, 0)) {
            Ok(Some(key)) => key,
            Ok(None) => return ctx.error(404, "Mapping dataset not found."),
            Err(why) => return Outcome::forward(why),
        };
        let mut request = Map::new();
        request.insert(String::from("enabled"), Value::Bool(*enabled));
        let path = format!("/mapping/datasets/{key}");
        match mapping_call(ctx, Method::POST, &path, Some(&Value::Object(request))).await {
            Ok((200, answer)) if answer.get("dataset").is_some_and(Value::is_object) => {
                let dataset = answer.get("dataset").unwrap_or(&Value::Null);
                ctx.json(&Value::Object(pick(dataset, &DATASET_FIELDS)))
            }
            Ok((status @ (400 | 403 | 404), _)) => Outcome::forward(format!(
                "the internal dataset toggle refused the call: {status}"
            )),
            Ok((status, _)) => {
                tracing::error!("the internal dataset toggle answered {status}");
                ctx.error(500, "Unable to update the mapping dataset.")
            }
            Err(e) => Outcome::forward(format!("{e:#}")),
        }
    })
}

/// `POST /settings/mapping/datasets/{key}/refresh`: a forced download,
/// answered when it is done.
fn dataset_refresh<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(async move {
        if let Err(why) = admin(ctx) {
            return Outcome::forward(why);
        }
        let key = match dataset_key(raw_segment(ctx, 1)) {
            Ok(Some(key)) => key,
            Ok(None) => return ctx.error(404, "Mapping dataset not found."),
            Err(why) => return Outcome::forward(why),
        };
        let path = format!("/mapping/datasets/{key}/refresh");
        match mapping_call(ctx, Method::POST, &path, None).await {
            Ok((200, result)) => ctx.json(&Value::Object(pick(
                &result,
                &["key", "status", "edges", "error"],
            ))),
            Ok((status @ (400 | 403 | 404), _)) => Outcome::forward(format!(
                "the internal dataset refresh refused the call: {status}"
            )),
            Ok((status, _)) => {
                tracing::error!("the internal dataset refresh answered {status}");
                ctx.error(500, "Unable to refresh the mapping dataset.")
            }
            Err(e) => Outcome::forward(format!("{e:#}")),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(v: &Value) -> Result<Option<Correction>, String> {
        v.as_object()
            .map_or_else(|| Err(String::from("not an object")), parse_correction)
    }

    #[test]
    fn corrections() {
        let full = parse(
            &json!({"srcNs": "anilist", "srcId": "5", "tmdbId": 10, "tmdbType": "tv", "note": "  hi "}),
        );
        assert_eq!(
            full,
            Ok(Some(Correction {
                src_ns: String::from("anilist"),
                src_id: String::from("5"),
                tmdb_id: Some(10),
                tmdb_type: Some(String::from("tv")),
                note: Some(String::from("hi")),
            })),
            "full"
        );
        let legacy = parse(
            &json!({"fromNamespace": "mal", "fromExternalId": 7, "toNamespace": "tmdb_movie", "toExternalId": " 12 "}),
        );
        assert_eq!(
            legacy
                .ok()
                .flatten()
                .map(|c| (c.src_id, c.tmdb_id, c.tmdb_type)),
            Some((String::from("7"), Some(12), Some(String::from("movie")))),
            "legacy"
        );
        let none = parse(&json!({"srcNs": "imdb", "srcId": "tt1"}));
        assert_eq!(
            none.ok().flatten().map(|c| c.tmdb_id),
            Some(None),
            "no counterpart"
        );
        assert_eq!(
            parse(&json!({"srcNs": "imdb", "srcId": "tt1", "tmdbId": 5})),
            Ok(None),
            "no type"
        );
        assert_eq!(
            parse(&json!({"srcNs": "imdb", "srcId": "tt1", "toNamespace": "tvdb"})),
            Ok(None),
            "tvdb target"
        );
        assert_eq!(
            parse(&json!({"srcNs": "x", "srcId": "1"})),
            Ok(None),
            "bad namespace"
        );
        assert!(
            json!({"srcId": "1", "tmdbType": null})
                .as_object()
                .is_some_and(correction_fits),
            "fits"
        );
        assert!(
            !json!({"srcId": 1}).as_object().is_some_and(correction_fits),
            "srcId type"
        );
    }

    #[test]
    fn list_query() {
        assert_eq!(parse_list_query("list=manual"), Ok((1, 50, 0)), "defaults");
        assert_eq!(
            parse_list_query("list=guessed&take=5000&skip=3"),
            Ok((2, 1000, 3)),
            "clamped"
        );
        assert_eq!(
            parse_list_query("list=unmapped&take=0"),
            Ok((0, 50, 0)),
            "take 0"
        );
        assert!(parse_list_query("take=1").is_err(), "list required");
        assert!(parse_list_query("list=other").is_err(), "unknown list");
    }
}
