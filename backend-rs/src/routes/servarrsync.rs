//! The Arr side of the download tracker's poll.
//!
//! The Radarr/Sonarr half of `server/lib/downloadtracker.ts` and the queue-warning reconciliation it
//! runs after every successful poll (`reconcileServarrWarnings` in
//! `server/lib/servarrInterventions.ts`), including the automatic
//! rejection of overdue warnings. Not a route module: it lives here to use
//! the Arr client and intervention record helpers the routes share.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde_json::{Map, Value};

use super::arrcall::ArrServer;
use super::interventions::{
    date_bind, date_param, js_slice, load, mapped_to_service, rejection_timeout, rejection_work,
    save, RejectError,
};
use super::mediawrite::timeout_ms;
use crate::clock::Utc;
use crate::db::{Bind, Db, MediaRow};
use crate::settings::public::truthy;
use crate::settings::Settings;
use crate::state::AppState;

/// `INTERVENTION_IMPORT_TIMEOUT_MS`.
const IMPORT_TIMEOUT_MS: i64 = 2 * 60 * 60 * 1000;

/// The two services, as the tracker and the interventions name them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Service {
    /// Movies.
    Radarr,
    /// Series.
    Sonarr,
}

impl Service {
    /// `radarr` / `sonarr`: the settings key and `serviceType`.
    #[must_use]
    pub const fn key(self) -> &'static str {
        match self {
            Self::Radarr => "radarr",
            Self::Sonarr => "sonarr",
        }
    }

    /// The API name in the clients' messages.
    #[must_use]
    pub const fn api_name(self) -> &'static str {
        match self {
            Self::Radarr => "Radarr",
            Self::Sonarr => "Sonarr",
        }
    }

    /// The queue item's id of the title.
    #[must_use]
    pub const fn external_key(self) -> &'static str {
        match self {
            Self::Radarr => "movieId",
            Self::Sonarr => "seriesId",
        }
    }

    const fn media_type(self) -> &'static str {
        match self {
            Self::Radarr => "movie",
            Self::Sonarr => "tv",
        }
    }
}

/// One deduplicated server's poll.
///
/// `refreshMonitoredDownloads()`, `getQueue()`, then the warning reconciliation for it and every other
/// enabled server on the same host (`matching`). The queue items come back.
///
/// # Errors
///
/// The Arr call's or the reconciliation's failure; the tracker then keeps
/// what it had for this server.
pub async fn poll_server(
    state: &Arc<AppState>,
    settings: &Arc<Settings>,
    service: Service,
    server: &Value,
    matching: &[Value],
) -> Result<Vec<Value>> {
    let arr = ArrServer {
        client: &state.outbound,
        server,
        timeout_ms: timeout_ms(settings),
        api_name: service.api_name(),
    };
    let mut command = Map::new();
    command.insert(
        String::from("name"),
        Value::from("RefreshMonitoredDownloads"),
    );
    arr.command(&Value::Object(command))
        .await
        .map_err(|e| anyhow!(e.message()))?;
    let queue = arr.queue().await.map_err(|e| anyhow!(e.message()))?;
    // `Promise.all`: every server is reconciled; the first failure counts.
    let mut first_error = None;
    for target in std::iter::once(server).chain(matching) {
        if let Err(e) = reconcile(state, settings, service, target, &queue).await {
            first_error.get_or_insert(e);
        }
    }
    first_error.map_or(Ok(queue), Err)
}

/// A `servarr_intervention` row as the reconciliation reads it.
#[derive(Debug)]
struct Existing {
    id: i64,
    state: String,
    queue_id: i64,
    acted_by_user_id: Option<i64>,
    release_title: Option<String>,
    warning_messages: String,
    manual_import_capable: bool,
    download_id: Option<String>,
    output_path: Option<String>,
    cleanup_error: Option<String>,
    updated_at: Option<i64>,
}

fn flag(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_i64().is_some_and(|n| n != 0),
        _ => false,
    }
}

fn text(row: &Map<String, Value>, key: &str) -> Option<String> {
    row.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// The `stringArray` transformer's view of a stored value, written back as
/// `JSON.stringify` would (what `TypeORM` compares).
fn normalized_messages(stored: Option<&str>) -> String {
    let list = stored
        .filter(|s| !s.is_empty())
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .unwrap_or_else(|| Value::Array(Vec::new()));
    list.to_string()
}

async fn existing_records(db: &Db, service: Service, server_id: i64) -> Result<Vec<Existing>> {
    let rows = db
        .rows(
            &format!(
                r#"SELECT CAST("id" AS BIGINT) AS "id", "state", CAST("queueId" AS BIGINT) AS "queueId", CAST("actedByUserId" AS BIGINT) AS "actedByUserId", "releaseTitle", "warningMessages", "manualImportCapable", "downloadId", "outputPath", "cleanupError", {} AS "updatedAt" FROM "servarr_intervention" WHERE "serviceType" = ?1 AND "serviceId" = ?2 ORDER BY "id""#,
                db.iso_sql(r#""updatedAt""#)
            ),
            &[Bind::Text(service.key().to_owned()), Bind::Int(server_id)],
        )
        .await?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            Some(Existing {
                id: row.get("id").and_then(Value::as_i64)?,
                state: text(row, "state")?,
                queue_id: row.get("queueId").and_then(Value::as_i64)?,
                acted_by_user_id: row.get("actedByUserId").and_then(Value::as_i64),
                release_title: text(row, "releaseTitle"),
                warning_messages: normalized_messages(
                    row.get("warningMessages").and_then(Value::as_str),
                ),
                manual_import_capable: flag(row.get("manualImportCapable")),
                download_id: text(row, "downloadId"),
                output_path: text(row, "outputPath"),
                cleanup_error: text(row, "cleanupError"),
                updated_at: row
                    .get("updatedAt")
                    .and_then(Value::as_str)
                    .and_then(crate::clock::parse_date_millis),
            })
        })
        .collect())
}

async fn mapped_media(db: &Db, service: Service, server_id: i64) -> Result<Vec<MediaRow>> {
    let rows = db
        .rows(
            r#"SELECT CAST("id" AS BIGINT) AS "id" FROM "media" WHERE ("mediaType" = ?1 AND "serviceId" = ?2) OR ("mediaType" = ?1 AND "serviceId4k" = ?2) ORDER BY "id""#,
            &[Bind::Text(service.media_type().to_owned()), Bind::Int(server_id)],
        )
        .await?;
    let ids: Vec<i64> = rows
        .iter()
        .filter_map(|r| r.get("id").and_then(Value::as_i64))
        .collect();
    let mut media = db.media_by_ids(&ids, false).await?;
    media.sort_by_key(|m| m.id);
    Ok(media)
}

/// `warningMessages(item)`.
fn warning_messages(item: &Value) -> Result<Vec<String>> {
    let statuses = match item.get("statusMessages") {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(list)) => list,
        Some(_) => return Err(anyhow!("statusMessages is not a list")),
    };
    let mut out = Vec::new();
    for status in statuses {
        let Value::Object(status) = status else {
            return Err(anyhow!("a status message is not an object"));
        };
        let messages: Vec<&Value> = match status.get("messages") {
            Some(Value::Array(list)) if !list.is_empty() => list.iter().collect(),
            _ => vec![status.get("title").unwrap_or(&Value::Null)],
        };
        for message in messages {
            if !truthy(Some(message)) {
                continue;
            }
            let Some(message) = message.as_str() else {
                return Err(anyhow!("a status message is not text"));
            };
            out.push(js_slice(message, 1000));
        }
    }
    Ok(out)
}

fn lower_eq(item: &Value, key: &str, expected: &str) -> bool {
    item.get(key)
        .and_then(Value::as_str)
        .is_some_and(|s| s.to_lowercase() == expected)
}

/// `value || null` for a string column.
fn or_null(item: &Value, key: &str) -> Option<String> {
    item.get(key)
        .filter(|v| truthy(Some(v)))
        .map(|v| crate::media::js_string(Some(v)).into_owned())
}

/// What a warning's record is refreshed with.
#[derive(Debug, PartialEq, Eq)]
struct Fields {
    release_title: String,
    warning_messages: String,
    manual_import_capable: bool,
    download_id: Option<String>,
    output_path: Option<String>,
}

fn fields_of(item: &Value) -> Result<Fields> {
    let title = item
        .get("title")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("a status message is missing"))?;
    let messages = warning_messages(item)?;
    Ok(Fields {
        release_title: js_slice(title, 500),
        warning_messages: Value::from(messages).to_string(),
        manual_import_capable: lower_eq(item, "status", "completed")
            && truthy(item.get("downloadId"))
            && truthy(item.get("outputPath")),
        download_id: or_null(item, "downloadId"),
        output_path: or_null(item, "outputPath"),
    })
}

/// `repository.save(record)` of a refreshed record: the changed columns,
/// with `updatedAt`, when anything changed.
async fn refresh_record(db: &Db, record: &Existing, fields: &Fields) -> Result<()> {
    let mut sets = Vec::new();
    let mut binds = Vec::new();
    if record.release_title.as_deref() != Some(fields.release_title.as_str()) {
        binds.push(Bind::Text(fields.release_title.clone()));
        sets.push(format!(r#""releaseTitle" = ?{}"#, binds.len()));
    }
    if record.warning_messages != fields.warning_messages {
        binds.push(Bind::Text(fields.warning_messages.clone()));
        sets.push(format!(r#""warningMessages" = ?{}"#, binds.len()));
    }
    if record.manual_import_capable != fields.manual_import_capable {
        binds.push(Bind::Bool(fields.manual_import_capable));
        sets.push(format!(r#""manualImportCapable" = ?{}"#, binds.len()));
    }
    if record.download_id != fields.download_id {
        binds.push(Bind::OptText(fields.download_id.clone()));
        sets.push(format!(r#""downloadId" = ?{}"#, binds.len()));
    }
    if record.output_path != fields.output_path {
        binds.push(Bind::OptText(fields.output_path.clone()));
        sets.push(format!(r#""outputPath" = ?{}"#, binds.len()));
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

/// A new warning's record.
struct NewRecord<'a> {
    service: Service,
    server: &'a Value,
    server_id: i64,
    media: &'a MediaRow,
    is4k: bool,
    queue_id: i64,
    external_id: i64,
    fields: Fields,
}

/// `now + graceHours * 60 * 60 * 1000`, as a `Date` truncates it.
fn deadline(settings: &Settings, now: i64) -> i64 {
    let hours = settings.get("/servarrInterventions/cleanupGraceHours");
    if let Some(h) = hours.and_then(Value::as_i64) {
        return now + h * 3_600_000;
    }
    let h = hours.and_then(Value::as_f64).unwrap_or(0.0);
    let offset = format!("{:.0}", (h * 3_600_000.0).trunc());
    now + offset.parse::<i64>().unwrap_or(0)
}

async fn insert_record(db: &Db, settings: &Settings, now: i64, new: NewRecord<'_>) -> Result<()> {
    let server_name = crate::media::js_string(new.server.get("name")).into_owned();
    let first_seen = Utc::from_unix_millis(now);
    let deadline_at = Utc::from_unix_millis(deadline(settings, now));
    db.execute(
        &format!(
            r#"INSERT INTO "servarr_intervention" ("serviceType", "serviceId", "serviceName", "is4k", "queueId", "downloadId", "outputPath", "externalServiceId", "mediaId", "tmdbId", "mediaType", "releaseTitle", "warningMessages", "manualImportCapable", "state", "firstSeenAt", "cleanupDeadlineAt") VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, {}, {})"#,
            date_param(db, 16),
            date_param(db, 17)
        ),
        &[
            Bind::Text(new.service.key().to_owned()),
            Bind::Int(new.server_id),
            Bind::Text(server_name),
            Bind::Bool(new.is4k),
            Bind::Int(new.queue_id),
            Bind::OptText(new.fields.download_id),
            Bind::OptText(new.fields.output_path),
            Bind::Int(new.external_id),
            Bind::Int(new.media.id),
            Bind::Int(new.media.tmdb_id),
            Bind::Text(new.media.media_type.clone()),
            Bind::Text(new.fields.release_title),
            Bind::Text(new.fields.warning_messages),
            Bind::Bool(new.fields.manual_import_capable),
            Bind::Text(String::from("active")),
            date_bind(db, &first_seen),
            date_bind(db, &deadline_at),
        ],
    )
    .await?;
    Ok(())
}

/// The resolution of a record whose warning is gone.
fn resolution(record: &Existing, queue_ids: &HashSet<i64>) -> &'static str {
    match record.state.as_str() {
        "importing" => "manual_import",
        "rejecting" if record.acted_by_user_id.is_some_and(|u| u != 0) => "manual_blocklist",
        "rejecting" => "automatic_blocklist",
        _ if queue_ids.contains(&record.queue_id) => "recovered",
        _ => "disappeared",
    }
}

async fn resolve_record(db: &Db, record: &Existing, resolution: &str, now: &Utc) -> Result<()> {
    db.execute(
        &format!(
            r#"UPDATE "servarr_intervention" SET "state" = ?1, "resolution" = ?2, "resolvedAt" = {}, "cleanupError" = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?4"#,
            date_param(db, 3)
        ),
        &[
            Bind::Text(String::from("resolved")),
            Bind::Text(resolution.to_owned()),
            date_bind(db, now),
            Bind::Int(record.id),
        ],
    )
    .await?;
    Ok(())
}

/// A rejecting or importing record that has waited too long goes back to
/// active with an error.
async fn time_out_record(db: &Db, record: &Existing, message: &str) -> Result<()> {
    let mut sets = vec![String::from(r#""state" = ?1"#)];
    let mut binds = vec![Bind::Text(String::from("active"))];
    if record.cleanup_error.as_deref() != Some(message) {
        binds.push(Bind::Text(message.to_owned()));
        sets.push(format!(r#""cleanupError" = ?{}"#, binds.len()));
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

/// `reconcileServarrWarnings(type, server, queue)`.
async fn reconcile(
    state: &Arc<AppState>,
    settings: &Arc<Settings>,
    service: Service,
    server: &Value,
    queue: &[Value],
) -> Result<()> {
    let db = &state.db;
    let server_id = server
        .get("id")
        .and_then(Value::as_i64)
        .context("a server without an integer id")?;
    let now = crate::clock::now_millis();
    let now_utc = Utc::from_unix_millis(now);
    let external_key = service.external_key();
    let mut external_ids: Vec<i64> = Vec::new();
    for item in queue {
        if let Some(id) = item.get(external_key).and_then(Value::as_i64) {
            if !external_ids.contains(&id) {
                external_ids.push(id);
            }
        }
    }
    let media = if external_ids.is_empty() {
        Vec::new()
    } else {
        mapped_media(db, service, server_id).await?
    };
    let mut mapped: HashMap<i64, (&MediaRow, bool)> = HashMap::new();
    for item in &media {
        for external_id in &external_ids {
            if mapped_to_service(item, server_id, *external_id) {
                let is4k = item.service_id4k == Some(server_id)
                    && item.external_service_id4k == Some(*external_id);
                mapped.insert(*external_id, (item, is4k));
            }
        }
    }
    let existing = existing_records(db, service, server_id).await?;
    let mut by_queue_id: HashMap<i64, usize> = HashMap::new();
    for (i, record) in existing.iter().enumerate() {
        if record.state != "resolved" {
            by_queue_id.insert(record.queue_id, i);
        }
    }
    let queue_ids: HashSet<i64> = queue
        .iter()
        .filter_map(|item| item.get("id").and_then(Value::as_i64))
        .collect();
    let mut current_warnings: HashSet<i64> = HashSet::new();
    let rejection_ms = i64::try_from(rejection_timeout(settings)).unwrap_or(i64::MAX);
    for item in queue {
        let external_id = item.get(external_key).and_then(Value::as_i64);
        let Some((media_item, is4k)) = external_id.and_then(|id| mapped.get(&id)).copied() else {
            continue;
        };
        if !lower_eq(item, "trackedDownloadStatus", "warning") {
            continue;
        }
        let queue_id = item
            .get("id")
            .and_then(Value::as_i64)
            .context("a queue item without an id")?;
        current_warnings.insert(queue_id);
        if let Some(record) = by_queue_id.get(&queue_id).and_then(|i| existing.get(*i)) {
            if record.state == "rejecting" || record.state == "importing" {
                let importing = record.state == "importing";
                let timeout = if importing {
                    IMPORT_TIMEOUT_MS
                } else {
                    rejection_ms
                };
                if record.updated_at.is_some_and(|at| now - at >= timeout) {
                    let message = if importing {
                        "Import timed out."
                    } else {
                        "Rejection timed out."
                    };
                    time_out_record(db, record, message).await?;
                }
                continue;
            }
            refresh_record(db, record, &fields_of(item)?).await?;
            continue;
        }
        insert_record(
            db,
            settings,
            now,
            NewRecord {
                service,
                server,
                server_id,
                media: media_item,
                is4k,
                queue_id,
                external_id: external_id.unwrap_or_default(),
                fields: fields_of(item)?,
            },
        )
        .await?;
    }
    for record in existing.iter().filter(|r| r.state != "resolved") {
        if !current_warnings.contains(&record.queue_id) {
            resolve_record(db, record, resolution(record, &queue_ids), &now_utc).await?;
        }
    }
    if truthy(settings.get("/servarrInterventions/automaticCleanupEnabled")) {
        clean_up_overdue(state, settings, service, server_id, now).await?;
    }
    Ok(())
}

/// The automatic-cleanup pass: every active record past its deadline is
/// rejected; one failure doesn't stop the rest.
async fn clean_up_overdue(
    state: &Arc<AppState>,
    settings: &Arc<Settings>,
    service: Service,
    server_id: i64,
    now: i64,
) -> Result<()> {
    let db = &state.db;
    let rows = db
        .rows(
            &format!(
                r#"SELECT CAST("id" AS BIGINT) AS "id", {} AS "cleanupDeadlineAt" FROM "servarr_intervention" WHERE "serviceType" = ?1 AND "serviceId" = ?2 AND "state" = ?3 ORDER BY "id""#,
                db.iso_sql(r#""cleanupDeadlineAt""#)
            ),
            &[
                Bind::Text(service.key().to_owned()),
                Bind::Int(server_id),
                Bind::Text(String::from("active")),
            ],
        )
        .await?;
    for row in rows {
        let Some(id) = row.get("id").and_then(Value::as_i64) else {
            continue;
        };
        let due = row
            .get("cleanupDeadlineAt")
            .and_then(Value::as_str)
            .and_then(crate::clock::parse_date_millis)
            .is_some_and(|at| at <= now);
        if due {
            if let Err(e) = reject_automatically(state, settings, id).await {
                tracing::debug!("automatic rejection of intervention {id} stopped: {e:#}");
            }
        }
    }
    Ok(())
}

/// `rejectServarrIntervention(id, undefined, true)`.
async fn reject_automatically(state: &Arc<AppState>, settings: &Settings, id: i64) -> Result<()> {
    let db = &state.db;
    let Some(mut record) = load(db, id).await? else {
        return Err(anyhow!("Intervention not found."));
    };
    if record.state == "resolved" {
        return Ok(());
    }
    let claimed = db
        .execute(
            r#"UPDATE "servarr_intervention" SET "state" = ?1, "cleanupError" = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?2 AND "state" = ?3"#,
            &[
                Bind::Text(String::from("rejecting")),
                Bind::Int(id),
                Bind::Text(String::from("active")),
            ],
        )
        .await?;
    if claimed == 0 {
        return Err(anyhow!("This warning is already being rejected."));
    }
    record.state = String::from("rejecting");
    record.cleanup_error = None;
    let section = if record.service_type == "radarr" {
        "/radarr"
    } else {
        "/sonarr"
    };
    let server = settings
        .get(section)
        .and_then(Value::as_array)
        .and_then(|servers| {
            servers.iter().find(|s| {
                s.get("id").and_then(Value::as_i64) == Some(record.service_id)
                    && truthy(s.get("syncEnabled"))
            })
        })
        .cloned();
    let outcome = match server {
        None => Err(RejectError::Status(
            409,
            String::from("The mapped Arr service is disabled or missing."),
        )),
        Some(server) => {
            let timeout = rejection_timeout(settings);
            let work = tokio::spawn(rejection_work(
                Arc::clone(state),
                server,
                record.clone(),
                timeout_ms(settings),
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
    };
    match outcome {
        Ok(()) => {
            let now = Utc::now();
            record.state = String::from("resolved");
            record.resolution = Some(String::from("automatic_blocklist"));
            record.acted_by_user_id = None;
            record.resolved_at = Some(now.iso_string());
            record.cleanup_error = None;
            save(db, &record, Some(&now)).await
        }
        Err(error) => {
            record.state = String::from("active");
            record.cleanup_error = Some(js_slice(&error.message(), 2000));
            save(db, &record, None).await?;
            tracing::error!(
                label = "Servarr Interventions",
                interventionId = id,
                errorMessage = %error.message(),
                "Unable to reject Servarr intervention"
            );
            Err(anyhow!(error.message()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn queue_item_fields() {
        let item = json!({
            "title": "Some.Movie.2026",
            "status": "Completed",
            "downloadId": "abc",
            "outputPath": "/downloads/x",
            "statusMessages": [
                {"title": "one", "messages": []},
                {"title": "two", "messages": ["a", "", "b"]},
                {"title": "", "messages": []}
            ]
        });
        let fields = fields_of(&item).ok();
        assert_eq!(
            fields,
            Some(Fields {
                release_title: String::from("Some.Movie.2026"),
                warning_messages: String::from(r#"["one","a","b"]"#),
                manual_import_capable: true,
                download_id: Some(String::from("abc")),
                output_path: Some(String::from("/downloads/x")),
            }),
            "fields"
        );
        let bare =
            fields_of(&json!({"title": "t", "status": "downloading", "downloadId": ""})).ok();
        assert_eq!(
            bare.map(|f| (f.warning_messages, f.manual_import_capable, f.download_id)),
            Some((String::from("[]"), false, None)),
            "no messages, not importable"
        );
        assert!(
            fields_of(&json!({"status": "x"})).is_err(),
            "no title throws"
        );
        assert_eq!(normalized_messages(Some("")), "[]", "empty");
        assert_eq!(normalized_messages(Some("nope")), "[]", "unparseable");
        assert_eq!(normalized_messages(Some(r#"["a"]"#)), r#"["a"]"#, "stored");
    }

    #[test]
    fn resolutions() {
        let record = |state: &str, acted: Option<i64>| Existing {
            id: 1,
            state: state.to_owned(),
            queue_id: 7,
            acted_by_user_id: acted,
            release_title: None,
            warning_messages: String::from("[]"),
            manual_import_capable: false,
            download_id: None,
            output_path: None,
            cleanup_error: None,
            updated_at: None,
        };
        let present: HashSet<i64> = std::iter::once(7).collect();
        let gone = HashSet::new();
        assert_eq!(
            resolution(&record("importing", None), &gone),
            "manual_import",
            "import"
        );
        assert_eq!(
            resolution(&record("rejecting", Some(3)), &gone),
            "manual_blocklist",
            "by a user"
        );
        assert_eq!(
            resolution(&record("rejecting", None), &gone),
            "automatic_blocklist",
            "automatic"
        );
        assert_eq!(
            resolution(&record("active", None), &present),
            "recovered",
            "still queued"
        );
        assert_eq!(
            resolution(&record("active", None), &gone),
            "disappeared",
            "gone"
        );
    }
}
