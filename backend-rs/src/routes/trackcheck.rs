//! Imported Sonarr episodes without a required audio or subtitle
//! language (see [`crate::sonarrtracks`]).
//!
//! Sonarr can refuse a release by its audio language before grabbing it
//! (a Language custom format), but it can't see subtitles before a file
//! is imported and never refuses an import over its tracks. So after each
//! import Foreseerr reads the file's tracks, and a file of a mapped series
//! that lacks a required language becomes a `tracks` intervention. An
//! admin replaces it (the file is deleted, the release blocklisted and the
//! episode searched again) or keeps it.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use axum::http::Method;
use serde_json::{json, Map, Value};

use super::interventions::{
    date_bind, date_param, js_slice, load, public_json, save, Intervention, TRACKS,
};
use super::mediawrite::MANAGE_REQUESTS;
use super::{Outcome, Ready, Table};
use crate::clock::Utc;
use crate::db::{Bind, Db};
use crate::jobs::syncutil::http_status;
use crate::settings::public::truthy;
use crate::settings::Settings;
use crate::sonarrtracks::{file_tracks, messages, missing, rule_for, server_has_rule};
use crate::state::AppState;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    (
        "/api/v1/servarr/interventions/{id}/replace",
        Method::POST,
        replace,
    ),
    (
        "/api/v1/servarr/interventions/{id}/keep",
        Method::POST,
        keep,
    ),
];

/// How often a server's imports are checked.
const INTERVAL: Duration = Duration::from_secs(5 * 60);
/// How far back the first check after a start looks.
const FIRST_LOOKBACK_MS: i64 = 24 * 3_600_000;
/// How far each check reaches back into the previous one, for imports
/// Sonarr dates a little before it lists them.
const OVERLAP_MS: i64 = 10 * 60_000;
/// Sonarr's `EpisodeHistoryEventType.DownloadFolderImported`.
const IMPORTED: i64 = 3;

/// Server id → when it was last checked and where the next check starts.
static WATERMARKS: LazyLock<Mutex<HashMap<i64, (Instant, i64)>>> = LazyLock::new(Mutex::default);

/// The Sonarr servers whose imports are due a check: synced, with a rule.
fn due_servers(settings: &Settings) -> Vec<Value> {
    let marks = crate::sync::lock(&WATERMARKS);
    settings
        .get("/sonarr")
        .and_then(Value::as_array)
        .map(|servers| {
            servers
                .iter()
                .filter(|s| truthy(s.get("syncEnabled")) && server_has_rule(s))
                .filter(|s| {
                    s.get("id").and_then(Value::as_i64).is_some_and(|id| {
                        marks
                            .get(&id)
                            .is_none_or(|(at, _)| at.elapsed() >= INTERVAL)
                    })
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

/// Checks every due Sonarr server's recent imports; run with each
/// download poll. A server that fails is logged and asked again next time
/// from the same point.
pub async fn check_servers(state: &Arc<AppState>, settings: &Arc<Settings>) {
    for server in due_servers(settings) {
        let Some(id) = server.get("id").and_then(Value::as_i64) else {
            continue;
        };
        let since = crate::sync::lock(&WATERMARKS).get(&id).map_or_else(
            || crate::clock::now_millis() - FIRST_LOOKBACK_MS,
            |(_, s)| *s,
        );
        let started = crate::clock::now_millis();
        let next = match check_server(state, settings, &server, since).await {
            Ok(()) => started - OVERLAP_MS,
            Err(e) => {
                tracing::warn!(
                    label = "Track Check",
                    errorMessage = %format!("{e:#}"),
                    "Unable to check the tracks of imports on Sonarr server: {}",
                    crate::media::js_string(server.get("name"))
                );
                since
            }
        };
        crate::sync::lock(&WATERMARKS).insert(id, (Instant::now(), next));
    }
}

/// A Sonarr history record's `data` value, whatever the key's case.
fn data_text<'a>(record: &'a Value, key: &str) -> Option<&'a str> {
    let data = record.get("data")?.as_object()?;
    data.iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .and_then(|(_, v)| v.as_str())
}

/// An import record's episode file id.
fn imported_file_id(record: &Value) -> Option<i64> {
    data_text(record, "fileId")?.parse().ok()
}

/// Whether a history record is an import (v3 and v5 name the type; a
/// number is accepted too).
fn is_import(record: &Value) -> bool {
    match record.get("eventType") {
        Some(Value::String(t)) => t.eq_ignore_ascii_case("downloadFolderImported"),
        Some(Value::Number(n)) => n.as_i64() == Some(IMPORTED),
        _ => false,
    }
}

/// The Foreseerr media a Sonarr series is mapped to on this server:
/// `(id, tmdbId)`.
async fn mapped_media(db: &Db, server_id: i64, series_id: i64) -> Result<Option<(i64, i64)>> {
    let rows = db
        .rows(
            r#"SELECT CAST("id" AS BIGINT) AS "id", CAST("tmdbId" AS BIGINT) AS "tmdbId" FROM "media" WHERE "mediaType" = 'tv' AND (("serviceId" = ?1 AND "externalServiceId" = ?2) OR ("serviceId4k" = ?1 AND "externalServiceId4k" = ?2)) ORDER BY "id" LIMIT 1"#,
            &[Bind::Int(server_id), Bind::Int(series_id)],
        )
        .await?;
    Ok(rows.first().and_then(|r| {
        Some((
            r.get("id").and_then(Value::as_i64)?,
            r.get("tmdbId").and_then(Value::as_i64)?,
        ))
    }))
}

/// Whether a file already has a record (in any state: a kept file isn't
/// flagged again).
async fn recorded(db: &Db, server_id: i64, file_id: i64) -> Result<bool> {
    Ok(db
        .scalar(
            r#"SELECT COUNT(*) FROM "servarr_intervention" WHERE "serviceId" = ?1 AND "episodeFileId" = ?2 AND "kind" = 'tracks'"#,
            &[Bind::Int(server_id), Bind::Int(file_id)],
        )
        .await?
        > 0)
}

/// One import that lacks a required language.
struct Finding<'a> {
    server: &'a Value,
    server_id: i64,
    series_id: i64,
    media: (i64, i64),
    file_id: i64,
    record: &'a Value,
    release_title: String,
    messages: Vec<String>,
}

async fn insert(db: &Db, f: Finding<'_>) -> Result<()> {
    let now = Utc::now();
    db.execute(
        &format!(
            r#"INSERT INTO "servarr_intervention" ("serviceType", "serviceId", "serviceName", "is4k", "queueId", "downloadId", "externalServiceId", "mediaId", "tmdbId", "mediaType", "releaseTitle", "warningMessages", "manualImportCapable", "state", "firstSeenAt", "cleanupDeadlineAt", "kind", "episodeFileId", "historyId") VALUES ('sonarr', ?1, ?2, ?3, 0, ?4, ?5, ?6, ?7, 'tv', ?8, ?9, ?10, 'active', {}, {}, 'tracks', ?13, ?14)"#,
            date_param(db, 11),
            date_param(db, 12)
        ),
        &[
            Bind::Int(f.server_id),
            Bind::Text(crate::media::js_string(f.server.get("name")).into_owned()),
            Bind::Bool(truthy(f.server.get("is4k"))),
            Bind::OptText(
                f.record
                    .get("downloadId")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned),
            ),
            Bind::Int(f.series_id),
            Bind::Int(f.media.0),
            Bind::Int(f.media.1),
            Bind::Text(f.release_title),
            Bind::Text(Value::from(f.messages).to_string()),
            Bind::Bool(false),
            date_bind(db, &now),
            date_bind(db, &now),
            Bind::Int(f.file_id),
            Bind::OptInt(f.record.get("id").and_then(Value::as_i64)),
        ],
    )
    .await?;
    Ok(())
}

/// The name a file is shown by: the release it came from, else its path
/// in the series folder.
fn release_title(file: &Value, record: &Value) -> String {
    [
        file.get("sceneName"),
        record.get("sourceTitle"),
        file.get("relativePath"),
    ]
    .into_iter()
    .flatten()
    .filter_map(Value::as_str)
    .find(|s| !s.is_empty())
    .unwrap_or("")
    .to_owned()
}

/// One server's imports since `since` (Unix ms), and the end of records
/// whose file is gone.
async fn check_server(
    state: &Arc<AppState>,
    settings: &Settings,
    server: &Value,
    since: i64,
) -> Result<()> {
    let server_id = server
        .get("id")
        .and_then(Value::as_i64)
        .ok_or_else(|| anyhow!("a Sonarr server without an id"))?;
    let timeout = crate::servarr::api_timeout(settings);
    let client = &state.servarr;
    let history = client
        .call(
            server,
            Method::GET,
            "/history/since",
            &[
                ("date", Utc::from_unix_millis(since).iso_string()),
                ("eventType", IMPORTED.to_string()),
            ],
            None,
            timeout,
        )
        .await?;
    let mut series: HashMap<i64, Option<Value>> = HashMap::new();
    let mut seen: Vec<i64> = Vec::new();
    for record in history
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| is_import(r))
    {
        let (Some(file_id), Some(series_id)) = (
            imported_file_id(record),
            record.get("seriesId").and_then(Value::as_i64),
        ) else {
            continue;
        };
        if seen.contains(&file_id) {
            continue;
        }
        seen.push(file_id);
        let Some(media) = mapped_media(&state.db, server_id, series_id).await? else {
            continue;
        };
        if recorded(&state.db, server_id, file_id).await? {
            continue;
        }
        if let std::collections::hash_map::Entry::Vacant(slot) = series.entry(series_id) {
            let found = match client
                .call(
                    server,
                    Method::GET,
                    &format!("/series/{series_id}"),
                    &[],
                    None,
                    timeout,
                )
                .await
            {
                Ok(s) => Some(s),
                Err(e) if http_status(&e) == Some(404) => None,
                Err(e) => return Err(e),
            };
            slot.insert(found);
        }
        let Some(Some(show)) = series.get(&series_id) else {
            continue;
        };
        let anime = show.get("seriesType").and_then(Value::as_str) == Some("anime");
        let rule = rule_for(server, anime);
        if rule.is_empty() {
            continue;
        }
        let file = match client
            .call(
                server,
                Method::GET,
                &format!("/episodefile/{file_id}"),
                &[],
                None,
                timeout,
            )
            .await
        {
            Ok(f) => f,
            // Replaced or deleted since.
            Err(e) if http_status(&e) == Some(404) => continue,
            Err(e) => return Err(e),
        };
        let Some(tracks) = file_tracks(&file) else {
            continue;
        };
        let Some(lacking) = missing(&rule, &tracks) else {
            continue;
        };
        let messages = messages(&lacking, &tracks);
        tracing::info!(
            label = "Track Check",
            "{} lacks required tracks: {}",
            release_title(&file, record),
            messages.join("; ")
        );
        insert(
            &state.db,
            Finding {
                server,
                server_id,
                series_id,
                media,
                file_id,
                record,
                release_title: release_title(&file, record),
                messages,
            },
        )
        .await?;
    }
    resolve_gone(state, server, server_id, timeout).await
}

/// Active records whose file Sonarr no longer has (upgraded or deleted)
/// are resolved as disappeared.
async fn resolve_gone(
    state: &Arc<AppState>,
    server: &Value,
    server_id: i64,
    timeout: Option<Duration>,
) -> Result<()> {
    let rows = state
        .db
        .rows(
            r#"SELECT CAST("id" AS BIGINT) AS "id", CAST("episodeFileId" AS BIGINT) AS "episodeFileId" FROM "servarr_intervention" WHERE "serviceId" = ?1 AND "kind" = 'tracks' AND "state" = 'active' ORDER BY "id""#,
            &[Bind::Int(server_id)],
        )
        .await?;
    for row in rows {
        let (Some(id), Some(file_id)) = (
            row.get("id").and_then(Value::as_i64),
            row.get("episodeFileId").and_then(Value::as_i64),
        ) else {
            continue;
        };
        match state
            .servarr
            .call(
                server,
                Method::GET,
                &format!("/episodefile/{file_id}"),
                &[],
                None,
                timeout,
            )
            .await
        {
            Err(e) if http_status(&e) == Some(404) => {
                let Some(mut record) = load(&state.db, id).await? else {
                    continue;
                };
                let now = Utc::now();
                record.state = String::from("resolved");
                record.resolution = Some(String::from("disappeared"));
                record.resolved_at = Some(now.iso_string());
                save(&state.db, &record, Some(&now)).await?;
            }
            Ok(_) | Err(_) => {}
        }
    }
    Ok(())
}

macro_rules! try_forward {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(why) => return Outcome::forward(why),
        }
    };
}

/// The active `tracks` record a route acts on, or the answer.
async fn active_record(ctx: &Ready<'_>, id: i64) -> Result<Intervention, Outcome> {
    let record = load(&ctx.state.db, id)
        .await
        .map_err(|e| ctx.error(500, &format!("{e:#}")))?;
    let Some(record) = record.filter(|r| r.kind == TRACKS) else {
        return Err(ctx.error(404, "Intervention not found."));
    };
    if record.state != "active" {
        return Err(ctx.error(409, "This file is no longer waiting for a decision."));
    }
    Ok(record)
}

/// `POST /servarr/interventions/{id}/keep`: the file stays.
fn keep<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let user = try_forward!(ctx.authenticated(MANAGE_REQUESTS));
        let id = try_forward!(ctx.path_id(1));
        let mut record = match active_record(ctx, id).await {
            Ok(r) => r,
            Err(answer) => return answer,
        };
        let now = Utc::now();
        record.state = String::from("resolved");
        record.resolution = Some(String::from("kept"));
        record.acted_by_user_id = Some(user.id);
        record.cleanup_error = None;
        record.resolved_at = Some(now.iso_string());
        if let Err(e) = save(&ctx.state.db, &record, Some(&now)).await {
            return ctx.error(500, &format!("{e:#}"));
        }
        ctx.json(&Value::Object(public_json(&record)))
    })
}

/// `POST /servarr/interventions/{id}/replace`: the file is deleted, the
/// release it came from blocklisted, and the episodes searched again.
fn replace<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let user = try_forward!(ctx.authenticated(MANAGE_REQUESTS));
        let id = try_forward!(ctx.path_id(1));
        let mut record = match active_record(ctx, id).await {
            Ok(r) => r,
            Err(answer) => return answer,
        };
        let db = &ctx.state.db;
        let claimed = match db
            .execute(
                r#"UPDATE "servarr_intervention" SET "state" = 'rejecting', "cleanupError" = NULL, "actedByUserId" = ?1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?2 AND "state" = 'active'"#,
                &[Bind::Int(user.id), Bind::Int(id)],
            )
            .await
        {
            Ok(n) => n,
            Err(e) => return ctx.error(500, &format!("{e:#}")),
        };
        if claimed == 0 {
            return ctx.error(409, "This file is already being replaced.");
        }
        let outcome = replace_file(ctx.state, &ctx.settings, &record).await;
        let now = Utc::now();
        record.acted_by_user_id = Some(user.id);
        match outcome {
            Ok(()) => {
                record.state = String::from("resolved");
                record.resolution = Some(String::from("replaced"));
                record.cleanup_error = None;
                record.resolved_at = Some(now.iso_string());
                if let Err(e) = save(db, &record, Some(&now)).await {
                    return ctx.error(500, &format!("{e:#}"));
                }
                ctx.json(&Value::Object(public_json(&record)))
            }
            Err(e) => {
                let message = format!("{e:#}");
                record.state = String::from("active");
                record.cleanup_error = Some(js_slice(&message, 2000));
                if let Err(e) = save(db, &record, None).await {
                    return ctx.error(500, &format!("{e:#}"));
                }
                tracing::error!(
                    "Unable to replace the file of Servarr intervention {}: {message}",
                    record.id
                );
                ctx.error(502, &message)
            }
        }
    })
}

/// The Sonarr side of a replace.
///
/// 1. The file's episodes are read, then the file is deleted.
/// 2. The import is marked failed, which blocklists the release it came
///    from (Sonarr finds the grab by its download id).
/// 3. Episodes that were monitored are monitored again: deleting a file
///    unmonitors its episodes when Sonarr's "Unmonitor Deleted Episodes"
///    is on.
/// 4. Watch-ahead episodes the request had completed wait for the new
///    file again, so the watch-ahead sync doesn't let them go.
/// 5. The episodes are searched, unless the server prevents searches.
async fn replace_file(state: &AppState, settings: &Settings, record: &Intervention) -> Result<()> {
    let server = settings
        .get("/sonarr")
        .and_then(Value::as_array)
        .and_then(|servers| {
            servers.iter().find(|s| {
                s.get("id").and_then(Value::as_i64) == Some(record.service_id)
                    && truthy(s.get("syncEnabled"))
            })
        })
        .cloned()
        .ok_or_else(|| anyhow!("The mapped Sonarr server is disabled or missing."))?;
    let file_id = record
        .episode_file_id
        .ok_or_else(|| anyhow!("The record names no file."))?;
    let timeout = crate::servarr::api_timeout(settings);
    let client = &state.servarr;
    let episodes = client
        .call(
            &server,
            Method::GET,
            "/episode",
            &[
                ("seriesId", record.external_service_id.to_string()),
                ("episodeFileId", file_id.to_string()),
            ],
            None,
            timeout,
        )
        .await?;
    let episodes: Vec<&Value> = episodes
        .as_array()
        .into_iter()
        .flatten()
        .filter(|e| e.get("episodeFileId").and_then(Value::as_i64) == Some(file_id))
        .collect();
    match client
        .call(
            &server,
            Method::DELETE,
            &format!("/episodefile/{file_id}"),
            &[],
            None,
            timeout,
        )
        .await
    {
        Ok(_) => {}
        Err(e) if http_status(&e) == Some(404) => {
            return Err(anyhow!("Sonarr no longer has this file."));
        }
        Err(e) => return Err(e),
    }
    if let Some(history_id) = record.history_id {
        // A manual import has no grab to blocklist.
        if let Err(e) = client
            .call(
                &server,
                Method::POST,
                &format!("/history/failed/{history_id}"),
                &[],
                None,
                timeout,
            )
            .await
        {
            tracing::warn!(
                label = "Track Check",
                errorMessage = %format!("{e:#}"),
                "Sonarr couldn't blocklist the release of {}",
                record.release_title
            );
        }
    }
    let ids = |pick: &dyn Fn(&Value) -> bool| -> Vec<Value> {
        episodes
            .iter()
            .filter(|e| pick(e))
            .filter_map(|e| e.get("id").cloned())
            .collect()
    };
    let monitored = ids(&|e| truthy(e.get("monitored")));
    if !monitored.is_empty() {
        client
            .call(
                &server,
                Method::PUT,
                "/episode/monitor",
                &[],
                Some(&json!({"episodeIds": monitored, "monitored": true})),
                timeout,
            )
            .await?;
    }
    let tvdb_ids: Vec<i64> = episodes
        .iter()
        .filter_map(|e| e.get("tvdbId").and_then(Value::as_i64))
        .filter(|id| *id > 0)
        .collect();
    reopen_watch_ahead(&state.db, record, &tvdb_ids).await?;
    let wanted = ids(&|_| true);
    if !truthy(server.get("preventSearch")) && !wanted.is_empty() {
        let mut body = Map::new();
        body.insert(String::from("name"), Value::from("EpisodeSearch"));
        body.insert(String::from("episodeIds"), Value::Array(wanted));
        client
            .call(
                &server,
                Method::POST,
                "/command",
                &[],
                Some(&Value::Object(body)),
                timeout,
            )
            .await?;
    }
    Ok(())
}

/// Watch-ahead children of the media's requests on this quality that were
/// completed by the deleted file: approved again, waiting for its
/// replacement (`monitoredAt` stays, so they aren't monitored twice).
async fn reopen_watch_ahead(db: &Db, record: &Intervention, tvdb_ids: &[i64]) -> Result<()> {
    if tvdb_ids.is_empty() {
        return Ok(());
    }
    let list = tvdb_ids
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    db.execute(
        &format!(
            r#"UPDATE "episode_request" SET "status" = 2, "updatedAt" = CURRENT_TIMESTAMP WHERE "status" = 5 AND "tvdbId" IN ({list}) AND "requestId" IN (SELECT "id" FROM "media_request" WHERE "mediaId" = ?1 AND "is4k" = ?2)"#
        ),
        &[Bind::Int(record.media_id), Bind::Bool(record.is4k)],
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_import_records() {
        let v3 = json!({"id": 9, "eventType": "downloadFolderImported", "seriesId": 4, "data": {"fileId": "77"}});
        assert!(is_import(&v3));
        assert_eq!(imported_file_id(&v3), Some(77));
        let upper = json!({"eventType": 3, "data": {"FileId": "5"}});
        assert!(is_import(&upper));
        assert_eq!(imported_file_id(&upper), Some(5));
        assert!(!is_import(&json!({"eventType": "grabbed"})));
    }

    /// What Sonarr was sent (method, path, body).
    type Writes = Arc<Mutex<Vec<(String, String, Value)>>>;

    /// A Sonarr 4 with one series (7, anime) whose episode 11 (TVDB 101)
    /// was imported from an English dub without subtitles (file 77).
    async fn fake_sonarr() -> Result<(u16, Writes)> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let writes: Writes = Arc::default();
        let log = Arc::clone(&writes);
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut buf: Vec<u8> = Vec::new();
                let mut chunk = [0_u8; 4096];
                let mut wanted: Option<usize> = None;
                while wanted.is_none_or(|w| buf.len() < w) {
                    match stream.read(&mut chunk).await {
                        Ok(n) if n > 0 => buf.extend_from_slice(chunk.get(..n).unwrap_or_default()),
                        _ => break,
                    }
                    if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(buf.get(..at).unwrap_or_default());
                        let length = head
                            .lines()
                            .filter_map(|l| l.split_once(':'))
                            .find(|(k, _)| k.trim().eq_ignore_ascii_case("content-length"))
                            .and_then(|(_, v)| v.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        wanted = Some(at + 4 + length);
                    }
                }
                let text = String::from_utf8_lossy(&buf).into_owned();
                let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
                let mut line = head.split(' ');
                let method = line.next().unwrap_or_default().to_owned();
                let path = line
                    .next()
                    .unwrap_or_default()
                    .split('?')
                    .next()
                    .unwrap_or_default()
                    .to_owned();
                let answer = match (method.as_str(), path.as_str()) {
                    ("GET", "/api") => json!({"current": "v3"}),
                    ("GET", "/api/v3/history/since") => json!([
                        {"id": 9, "eventType": "downloadFolderImported", "seriesId": 7, "episodeId": 11,
                         "downloadId": "abc", "sourceTitle": "[Dub] Show - 01", "data": {"fileId": "77"}},
                        {"id": 10, "eventType": "downloadFolderImported", "seriesId": 8, "episodeId": 12,
                         "data": {"fileId": "78"}}
                    ]),
                    ("GET", "/api/v3/series/7") => json!({"id": 7, "seriesType": "anime"}),
                    ("GET", "/api/v3/episodefile/77") => json!({
                        "id": 77, "sceneName": "[Dub] Show - 01",
                        "mediaInfo": {"audioLanguages": "eng", "subtitles": ""}
                    }),
                    ("GET", "/api/v3/episode") => json!([
                        {"id": 11, "tvdbId": 101, "episodeFileId": 77, "monitored": true}
                    ]),
                    _ => {
                        let body = serde_json::from_str(body).unwrap_or(Value::Null);
                        crate::sync::lock(&log).push((method, path, body));
                        json!({})
                    }
                };
                let answer = answer.to_string();
                let reply = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}",
                    answer.len()
                );
                stream.write_all(reply.as_bytes()).await.ok();
            }
        });
        Ok((port, writes))
    }

    #[tokio::test]
    async fn flags_then_replaces_a_dub_without_subtitles() -> Result<()> {
        use crate::dbtx::scratch;

        let scratch = scratch::sqlite("trackcheck").await?;
        let db = &scratch.db;
        scratch::run(
            db,
            &[
                r#"INSERT INTO "user" ("id", "email", "avatar", "permissions") VALUES (1, 'owner@example.test', '', 2)"#,
                r#"INSERT INTO "media" ("id", "mediaType", "tmdbId", "status", "serviceId", "externalServiceId") VALUES (1, 'tv', 55, 3, 1, 7)"#,
                r#"INSERT INTO "media_request" ("id", "status", "type", "mediaId", "requestedById", "episodeSelectionType") VALUES (1, 2, 'tv', 1, 1, 'watchAhead')"#,
                r#"INSERT INTO "episode_request" ("id", "tvdbId", "seasonNumber", "episodeNumber", "status", "requestId") VALUES (1, 101, 1, 1, 5, 1), (2, 102, 1, 2, 5, 1)"#,
            ],
        )
        .await?;
        let (port, writes) = fake_sonarr().await?;
        let server = json!({
            "id": 1, "name": "Sonarr", "hostname": "127.0.0.1", "port": port, "apiKey": "k",
            "useSsl": false, "baseUrl": "", "syncEnabled": true, "is4k": false,
            "animeRequiredAudioLanguages": ["jpn"], "animeRequiredSubtitleLanguages": ["eng"]
        });
        let dir = std::env::temp_dir().join(format!(
            "foreseerr-trackcheck-{}-{}",
            std::process::id(),
            crate::clock::now_millis()
        ));
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("settings.json"), "{}")?;
        let state = Arc::new(AppState::for_tests(db.clone(), &dir)?);
        let settings = Settings::from_file_value(json!({"sonarr": [server.clone()]}), None)?;

        // Twice: the second check finds the file recorded. Series 8 isn't
        // mapped, so its import is never read.
        for _ in 0..2 {
            check_server(&state, &settings, &server, 0).await?;
        }
        let rows = db
            .rows(
                r#"SELECT CAST("id" AS BIGINT) AS "id" FROM "servarr_intervention""#,
                &[],
            )
            .await?;
        assert_eq!(rows.len(), 1, "one record");
        let id = rows
            .first()
            .and_then(|r| r.get("id"))
            .and_then(Value::as_i64)
            .unwrap_or_default();
        let record = load(db, id).await?.ok_or_else(|| anyhow!("record"))?;
        assert_eq!(record.kind, TRACKS);
        assert_eq!(record.episode_file_id, Some(77));
        assert_eq!(record.history_id, Some(9));
        assert_eq!(record.release_title, json!("[Dub] Show - 01"));
        assert_eq!(
            record.warning_messages,
            json!([
                "No Japanese audio (audio: English)",
                "No English subtitles (subtitles: none)"
            ])
        );
        assert!(
            crate::sync::lock(&writes).is_empty(),
            "the check only reads"
        );

        replace_file(&state, &settings, &record).await?;
        let sent: Vec<(String, String, Value)> = crate::sync::lock(&writes).clone();
        assert_eq!(
            sent,
            vec![
                (
                    String::from("DELETE"),
                    String::from("/api/v3/episodefile/77"),
                    Value::Null
                ),
                (
                    String::from("POST"),
                    String::from("/api/v3/history/failed/9"),
                    Value::Null
                ),
                (
                    String::from("PUT"),
                    String::from("/api/v3/episode/monitor"),
                    json!({"episodeIds": [11], "monitored": true})
                ),
                (
                    String::from("POST"),
                    String::from("/api/v3/command"),
                    json!({"name": "EpisodeSearch", "episodeIds": [11]})
                ),
            ]
        );
        let statuses = db
            .rows(
                r#"SELECT CAST("status" AS BIGINT) AS "status" FROM "episode_request" ORDER BY "id""#,
                &[],
            )
            .await?;
        let statuses: Vec<Option<i64>> = statuses
            .iter()
            .map(|r| r.get("status").and_then(Value::as_i64))
            .collect();
        assert_eq!(statuses, vec![Some(2), Some(5)], "episode 101 waits again");
        std::fs::remove_dir_all(&dir)?;
        Ok(())
    }

    #[test]
    fn release_title_prefers_the_release() {
        let file = json!({"sceneName": "", "relativePath": "Season 1/E01.mkv"});
        assert_eq!(
            release_title(&file, &json!({"sourceTitle": "[Group] Show - 01"})),
            "[Group] Show - 01"
        );
        assert_eq!(release_title(&file, &json!({})), "Season 1/E01.mkv");
    }
}
