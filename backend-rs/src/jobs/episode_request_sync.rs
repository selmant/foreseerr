//! `episode-request-sync`: `server/job/episodeRequestSync.ts` with the
//! parts of `server/lib/watchAhead.ts` and `Tvdb.getEpisodeCatalog` it
//! uses.
//!
//! Approved episode-selection requests are reconciled with Sonarr: ongoing
//! (`after`) requests pick up new episodes, watch-ahead requests extend
//! their window past what the requester has played in Jellyfin, episodes
//! with files complete, missing ones are monitored and searched, and a
//! request whose episodes are all done completes (through
//! `crate::lifecycle`, which runs the request hooks). Watch-ahead episodes
//! are monitored once; one that is unmonitored again before it has a file
//! was removed by someone else, so it is marked instead of fetched again.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use reqwest::Method;
use serde_json::{Map, Value};

use super::syncutil::{axios_message, date_ph, int, iso, now_ms, opt_date_bind, parse_js_date, Tx};
use super::JobCtx;
use crate::db::{Bind, Db};
use crate::library::{Lib, Link};
use crate::lifecycle::{Entity, Lc, APPROVED, COMPLETED};
use crate::settings::public::truthy;

/// `DEFAULT_WATCH_AHEAD_EPISODE_COUNT` and its bounds.
const DEFAULT_WATCH_AHEAD: i64 = 10;
const MIN_WATCH_AHEAD: i64 = 1;
const MAX_WATCH_AHEAD: i64 = 50;
/// `getEpisodeCatalog` reads at most this many pages.
const MAX_PAGES: u32 = 50;

static RUNNING: AtomicBool = AtomicBool::new(false);

/// `episodeRequestSync.running`.
#[must_use]
pub fn running() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

/// `TvdbEpisodeCatalogItem`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogEpisode {
    /// `tvdbId`.
    pub tvdb_id: i64,
    /// `seasonNumber`.
    pub season: i64,
    /// `episodeNumber`.
    pub episode: i64,
    /// `title`.
    pub title: String,
    /// `airDate`.
    pub air_date: Option<String>,
}

/// `watchAheadEpisodeCount(value)` for a stored count.
#[must_use]
pub fn watch_ahead_count(value: Option<i64>) -> i64 {
    value.map_or(DEFAULT_WATCH_AHEAD, |n| {
        n.clamp(MIN_WATCH_AHEAD, MAX_WATCH_AHEAD)
    })
}

/// A Jellyfin episode as `playedTvdbIdsFromJellyfin` reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlayedEpisode {
    /// `ProviderIds.Tvdb`.
    pub tvdb_id: Option<String>,
    /// `ParentIndexNumber`.
    pub season: Option<i64>,
    /// `IndexNumber`.
    pub episode: Option<i64>,
    /// `UserData.Played === true`.
    pub played: bool,
}

/// `playedTvdbIdsFromJellyfin(catalog, items)`.
#[must_use]
pub fn played_tvdb_ids(catalog: &[CatalogEpisode], items: &[PlayedEpisode]) -> HashSet<i64> {
    let known: HashSet<i64> = catalog.iter().map(|e| e.tvdb_id).collect();
    let mut by_number: HashMap<(i64, i64), i64> = HashMap::new();
    for e in catalog.iter().filter(|e| e.season > 0) {
        by_number.insert((e.season, e.episode), e.tvdb_id);
    }
    let mut played = HashSet::new();
    for item in items.iter().filter(|i| i.played) {
        let raw = item
            .tvdb_id
            .as_deref()
            .filter(|t| !t.is_empty())
            .and_then(|t| t.trim().parse::<i64>().ok());
        if let Some(id) = raw.filter(|id| known.contains(id)) {
            played.insert(id);
            continue;
        }
        if let (Some(s), Some(e)) = (item.season, item.episode) {
            if let Some(mapped) = by_number.get(&(s, e)) {
                played.insert(*mapped);
            }
        }
    }
    played
}

/// `resolveWatchAheadWindow(...).desired`, with whether the regular
/// catalog is empty.
#[must_use]
pub fn watch_ahead_window<S: std::hash::BuildHasher>(
    catalog: &[CatalogEpisode],
    count: i64,
    played: &HashSet<i64, S>,
) -> Vec<CatalogEpisode> {
    let regular: Vec<&CatalogEpisode> = catalog.iter().filter(|e| e.season > 0).collect();
    let last = regular
        .iter()
        .rposition(|e| played.contains(&e.tvdb_id))
        .map_or(0, |i| i + 1);
    let take = usize::try_from(watch_ahead_count(Some(count))).unwrap_or(0);
    regular.into_iter().skip(last).take(take).cloned().collect()
}

/// `Tvdb.getEpisodeCatalog({ tvId })` in its default language.
async fn episode_catalog(job: &JobCtx, show_id: i64) -> Result<Vec<CatalogEpisode>> {
    let client = &job.state.outbound;
    crate::tvdb::ensure_instance(client).await?;
    let show = job
        .state
        .tmdb
        .tv(show_id, crate::tvdb::DEFAULT_LANGUAGE)
        .await?;
    let tvdb_id = show
        .pointer("/external_ids/tvdb_id")
        .and_then(Value::as_i64)
        .filter(|id| *id != 0 && *id != -1)
        .ok_or_else(|| anyhow!("[TVDB] TVDB ID not found for series"))?;
    crate::tvdb::refresh_token(client).await?;
    let extended = crate::tvdb::get(
        client,
        &format!("/series/{tvdb_id}/extended?meta=episodes&short=true"),
    )
    .await?;
    let official: Vec<i64> = extended
        .pointer("/data/seasons")
        .and_then(Value::as_array)
        .map(|seasons| {
            seasons
                .iter()
                .filter(|s| s.pointer("/type/type").and_then(Value::as_str) == Some("official"))
                .filter_map(|s| s.get("number").and_then(Value::as_i64))
                .collect()
        })
        .unwrap_or_default();
    let mut raw: Vec<Value> = Vec::new();
    for page in 0..MAX_PAGES {
        let response = crate::tvdb::get(
            client,
            &format!(
                "/series/{tvdb_id}/episodes/default/{}?page={page}",
                crate::tvdb::DEFAULT_LANGUAGE
            ),
        )
        .await?;
        let episodes = response
            .pointer("/data/episodes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let empty = episodes.is_empty();
        raw.extend(episodes);
        if !truthy(response.pointer("/links/next")) || empty {
            break;
        }
    }
    let mut catalog: Vec<CatalogEpisode> = raw
        .iter()
        .filter_map(|e| {
            let season = e.get("seasonNumber").and_then(Value::as_i64)?;
            if !official.contains(&season) {
                return None;
            }
            let number = e.get("number").and_then(Value::as_i64)?;
            let title = match e.get("name") {
                Some(Value::String(s)) if !s.is_empty() => s.clone(),
                _ => format!("Episode {number}"),
            };
            Some(CatalogEpisode {
                tvdb_id: e.get("id").and_then(Value::as_i64)?,
                season,
                episode: number,
                title,
                air_date: e
                    .get("aired")
                    .and_then(Value::as_str)
                    .filter(|a| !a.is_empty())
                    .map(str::to_owned),
            })
        })
        .collect();
    catalog.sort_by(|a, b| a.season.cmp(&b.season).then(a.episode.cmp(&b.episode)));
    Ok(catalog)
}

/// A Sonarr series and its episodes for one server.
#[derive(Clone)]
struct Context {
    server: Value,
    series: Value,
    episodes: Vec<Value>,
    prevent_search: bool,
}

/// `episodeRequestSync.run()`.
///
/// # Errors
///
/// Database errors listing the requests.
pub async fn run(job: &JobCtx) -> Result<()> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let _running = super::Running::new(&RUNNING, job);
    sync(job).await
}

async fn sync(job: &JobCtx) -> Result<()> {
    let lc = Lc {
        state: Arc::clone(&job.state),
        settings: Arc::clone(&job.settings),
    };
    let ids = job
        .state
        .db
        .rows(
            r#"SELECT CAST("id" AS BIGINT) AS "id" FROM "media_request" WHERE "type" = 'tv' AND "status" = ?1 AND "episodeSelectionType" IS NOT NULL ORDER BY "id" ASC"#,
            &[Bind::Int(APPROVED)],
        )
        .await?;
    let mut cache: HashMap<String, Context> = HashMap::new();
    for id in ids.iter().filter_map(|r| int(r, "id")) {
        if job.cancelled() {
            break;
        }
        let outcome = async {
            let Some(mut request) = lc.load(id).await? else {
                return Ok(());
            };
            let Some(context) = sonarr_context(job, &request, &mut cache).await? else {
                return Ok(());
            };
            reconcile(job, &lc, &mut request, &context).await
        }
        .await;
        if let Err(e) = outcome {
            tracing::warn!(
                label = "Episode Request Sync",
                request_id = id,
                error_message = %e,
                "Failed to synchronize episode request"
            );
        }
    }
    Ok(())
}

async fn sonarr_get(
    job: &JobCtx,
    server: &Value,
    path: &str,
    query: &[(&str, String)],
) -> Result<Value> {
    job.state
        .servarr
        .call(
            server,
            Method::GET,
            path,
            query,
            None,
            crate::servarr::api_timeout(&job.settings),
        )
        .await
}

/// `getSonarrContext`.
async fn sonarr_context(
    job: &JobCtx,
    request: &Entity,
    cache: &mut HashMap<String, Context>,
) -> Result<Option<Context>> {
    let Some(media) = &request.media else {
        return Err(anyhow!("serviceId is missing"));
    };
    let four_k = request.row.is4k;
    let service_id = if four_k {
        media.service_id4k
    } else {
        media.service_id
    };
    let external = if four_k {
        media.external_service_id4k
    } else {
        media.external_service_id
    };
    let servers = job
        .settings
        .get("/sonarr")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let id_of = |s: &Value| s.get("id").and_then(Value::as_i64);
    let server = servers
        .iter()
        .find(|s| {
            request
                .row
                .server_id
                .is_some_and(|id| s.get("id").and_then(Value::as_i64) == Some(id))
        })
        .or_else(|| {
            servers
                .iter()
                .find(|s| service_id.is_some() && id_of(s) == service_id)
        })
        .or_else(|| {
            servers
                .iter()
                .find(|s| truthy(s.get("isDefault")) && s.get("is4k") == Some(&Value::Bool(four_k)))
        });
    let Some(server) = server.cloned() else {
        return Ok(None);
    };
    let external_id = if service_id == id_of(&server) {
        external
    } else {
        let Some(tvdb_id) = media.tvdb_id.filter(|t| *t != 0) else {
            return Ok(None);
        };
        let all = sonarr_get(job, &server, "/series", &[])
            .await
            .map_err(|e| anyhow!("[Sonarr] Failed to retrieve series: {}", axios_message(&e)))?;
        let found = all
            .as_array()
            .and_then(|list| {
                list.iter()
                    .find(|s| s.get("tvdbId").and_then(Value::as_i64) == Some(tvdb_id))
            })
            .and_then(|s| s.get("id").and_then(Value::as_i64));
        let Some(found) = found else {
            return Ok(None);
        };
        Some(found)
    };
    let Some(external_id) = external_id.filter(|id| *id != 0) else {
        return Ok(None);
    };
    let key = format!(
        "{}:{external_id}",
        crate::media::js_string(server.get("id"))
    );
    if let Some(cached) = cache.get(&key) {
        return Ok(Some(cached.clone()));
    }
    let series = sonarr_get(job, &server, &format!("/series/{external_id}"), &[])
        .await
        .map_err(|e| {
            anyhow!(
                "[Sonarr] Failed to retrieve series by ID: {}",
                axios_message(&e)
            )
        })?;
    let episodes = match sonarr_get(
        job,
        &server,
        "/episode",
        &[("seriesId", external_id.to_string())],
    )
    .await
    {
        Ok(Value::Array(list)) => list,
        Ok(_) => Vec::new(),
        Err(e) => {
            tracing::error!(
                label = "Sonarr API",
                error_message = %axios_message(&e),
                series_id = external_id,
                "Failed to retrieve episodes"
            );
            return Err(anyhow!("Failed to get episodes"));
        }
    };
    let context = Context {
        prevent_search: truthy(server.get("preventSearch")),
        server,
        series,
        episodes,
    };
    cache.insert(key, context.clone());
    Ok(Some(context))
}

/// A new `EpisodeRequest` row.
struct NewEpisode {
    tvdb_id: i64,
    season: i64,
    episode: i64,
    title: Option<String>,
    air_date: Option<String>,
    status: i64,
}

/// `episodeRepository.save([...new EpisodeRequest(...)])`.
async fn insert_episodes(job: &JobCtx, request_id: i64, episodes: &[NewEpisode]) -> Result<()> {
    if episodes.is_empty() {
        return Ok(());
    }
    let mut tx = Tx::begin(&job.state.db).await?;
    for e in episodes {
        tx.insert_id(
            r#"INSERT INTO "episode_request" ("tvdbId", "seasonNumber", "episodeNumber", "title", "airDate", "status", "requestId") VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING CAST("id" AS BIGINT) AS "id""#,
            &[
                Bind::Int(e.tvdb_id),
                Bind::Int(e.season),
                Bind::Int(e.episode),
                Bind::OptText(e.title.clone()),
                Bind::OptText(e.air_date.clone()),
                Bind::Int(e.status),
                Bind::Int(request_id),
            ],
        )
        .await?;
    }
    tx.commit().await
}

fn episode_int(e: &Value, key: &str) -> Option<i64> {
    e.get(key).and_then(Value::as_i64)
}

fn sonarr_text(e: &Value, key: &str) -> Option<String> {
    e.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// `awaitingMonitor`. Watch-ahead children are monitored once. After that
/// Sonarr's flag wins: an episode someone else unmonitored, or a completed
/// child whose file was deleted on purpose, stays unmonitored. Only
/// children in the current window are monitored: older ones are behind the
/// viewer and may have been cleaned up already.
const fn awaits_monitor(in_window: bool, has_file: bool, status: i64, monitored_at: bool) -> bool {
    in_window && !has_file && status != COMPLETED && !monitored_at
}

/// Whether a missing episode is a search candidate. A completed child lost
/// its file on purpose, so it is skipped even when Sonarr still monitors it.
const fn wants_search(is_new: bool, monitored: bool, awaiting: bool, status: i64) -> bool {
    (is_new || monitored || awaiting) && status != COMPLETED
}

/// Whether a window child was removed by someone else: Foreseerr already
/// monitored it (or it was downloaded) and it is now unmonitored without a
/// file. It is shown instead of fetched again.
const fn removed_externally(
    has_file: bool,
    monitored: bool,
    status: i64,
    monitored_at: bool,
) -> bool {
    !has_file && !monitored && (status == COMPLETED || monitored_at)
}

/// Whether every episode of a non-empty watch-ahead window was removed.
fn window_inactive(window: &HashSet<i64>, removed: &HashSet<i64>) -> bool {
    !window.is_empty() && window.iter().all(|t| removed.contains(t))
}

/// `reconcileRequest`.
async fn reconcile(job: &JobCtx, lc: &Lc, request: &mut Entity, context: &Context) -> Result<()> {
    let mut by_tvdb: HashMap<i64, &Value> = HashMap::new();
    for e in &context.episodes {
        if let Some(t) = episode_int(e, "tvdbId") {
            by_tvdb.insert(t, e);
        }
    }
    let selection = request.row.episode_selection_type.clone();
    let mut additions: HashSet<i64> = HashSet::new();
    let mut inserted = false;
    let mut catalog_ready = true;
    let mut caught_up = false;
    let mut window: Option<HashSet<i64>> = None;
    if selection.as_deref() == Some("after") {
        let boundary = by_tvdb
            .get(&request.row.episode_start_tvdb_id.unwrap_or(-1))
            .ok_or_else(|| anyhow!("Sonarr does not contain the ongoing request boundary"))?;
        let (b_season, b_episode) = (
            episode_int(boundary, "seasonNumber").unwrap_or(0),
            episode_int(boundary, "episodeNumber").unwrap_or(0),
        );
        let known: HashSet<i64> = request.row.episodes.iter().map(|e| e.tvdb_id).collect();
        let fresh: Vec<NewEpisode> = context
            .episodes
            .iter()
            .filter_map(|e| {
                let season = episode_int(e, "seasonNumber")?;
                let number = episode_int(e, "episodeNumber")?;
                let tvdb_id = episode_int(e, "tvdbId")?;
                let after = season > 0
                    && (season > b_season || (season == b_season && number >= b_episode));
                (after && !known.contains(&tvdb_id)).then(|| NewEpisode {
                    tvdb_id,
                    season,
                    episode: number,
                    title: sonarr_text(e, "title"),
                    air_date: sonarr_text(e, "airDate"),
                    status: if truthy(e.get("hasFile")) {
                        COMPLETED
                    } else {
                        APPROVED
                    },
                })
            })
            .collect();
        insert_episodes(job, request.row.id, &fresh).await?;
        inserted = !fresh.is_empty();
        additions.extend(fresh.iter().map(|e| e.tvdb_id));
    } else if selection.as_deref() == Some("watchAhead") {
        let expansion = expand_watch_ahead(job, request, &by_tvdb, &mut additions).await?;
        catalog_ready = expansion.ready;
        caught_up = expansion.caught_up;
        inserted = expansion.inserted;
        window = expansion.window;
    }
    if inserted {
        if let Some(fresh) = lc.load(request.row.id).await? {
            *request = fresh;
        }
    }
    let now = now_ms();
    let mut unmonitored: Vec<Value> = Vec::new();
    let mut newly_monitored: Vec<i64> = Vec::new();
    let mut searchable: Vec<(i64, Value)> = Vec::new();
    let mut removed_changed: Vec<(i64, Option<i64>)> = Vec::new();
    let mut removed: HashSet<i64> = HashSet::new();
    let db = &job.state.db;
    for child in &mut request.row.episodes {
        let Some(episode) = by_tvdb.get(&child.tvdb_id) else {
            continue;
        };
        let is_new = additions.contains(&child.tvdb_id);
        let has_file = truthy(episode.get("hasFile"));
        let monitored = truthy(episode.get("monitored"));
        let monitored_at = child.monitored_at.is_some();
        let in_window = window.as_ref().is_some_and(|w| w.contains(&child.tvdb_id));
        let awaiting = awaits_monitor(in_window, has_file, child.status, monitored_at);
        if (is_new || awaiting) && !monitored {
            unmonitored.push(episode.get("id").cloned().unwrap_or(Value::Null));
        }
        if awaiting {
            newly_monitored.push(child.id);
        }
        if let Some(window) = &window {
            let gone = window.contains(&child.tvdb_id)
                && removed_externally(has_file, monitored, child.status, monitored_at);
            if gone {
                removed.insert(child.tvdb_id);
            }
            if gone != child.unmonitored_at.is_some() {
                let at = gone.then_some(now);
                child.unmonitored_at = at.map(iso);
                removed_changed.push((child.id, at));
            }
        }
        if has_file {
            if child.status != COMPLETED {
                child.status = COMPLETED;
                db.execute(
                    r#"UPDATE "episode_request" SET "status" = ?1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?2"#,
                    &[Bind::Int(COMPLETED), Bind::Int(child.id)],
                )
                .await?;
            }
            continue;
        }
        let aired = episode
            .get("airDateUtc")
            .filter(|v| truthy(Some(v)))
            .is_none_or(|v| {
                v.as_str()
                    .and_then(parse_js_date)
                    .is_some_and(|at| at <= now)
            });
        if wants_search(is_new, monitored, awaiting, child.status)
            && !context.prevent_search
            && child.search_triggered_at.is_none()
            && aired
        {
            searchable.push((child.id, episode.get("id").cloned().unwrap_or(Value::Null)));
        }
    }
    save_child_dates(db, "unmonitoredAt", &removed_changed).await?;
    if let Some(window) = &window {
        let inactive = window_inactive(window, &removed);
        if inactive != request.row.watch_ahead_inactive_at.is_some() {
            let at = inactive.then_some(now);
            save_inactive_at(db, request.row.id, at).await?;
            request.row.watch_ahead_inactive_at = at.map(iso);
        }
    }
    monitor_and_search(job, context, unmonitored, &newly_monitored, &searchable).await?;
    let complete = request.row.episodes.iter().all(|e| e.status == COMPLETED);
    let reads_status = match selection.as_deref() {
        Some("after") => true,
        Some("watchAhead") => catalog_ready && caught_up,
        _ => false,
    };
    let ended = if reads_status {
        match context.series.get("status") {
            Some(Value::String(s)) => s.to_lowercase() == "ended",
            _ => return Err(anyhow!("toLowerCase is missing")),
        }
    } else {
        false
    };
    let may_complete = match selection.as_deref() {
        Some("after" | "watchAhead") => ended,
        _ => true,
    };
    if complete && may_complete {
        if let Some(mut fresh) = lc.load(request.row.id).await? {
            fresh.row.status = COMPLETED;
            lc.save(&mut fresh).await?;
        }
    }
    Ok(())
}

/// `monitorEpisodes` and the `monitoredAt` stamps, then `searchEpisodes`
/// and the `searchTriggeredAt` stamps.
async fn monitor_and_search(
    job: &JobCtx,
    context: &Context,
    unmonitored: Vec<Value>,
    newly_monitored: &[i64],
    searchable: &[(i64, Value)],
) -> Result<()> {
    let timeout = crate::servarr::api_timeout(&job.settings);
    let client = &job.state.servarr;
    if !unmonitored.is_empty() {
        let mut body = Map::new();
        body.insert(
            String::from("episodeIds"),
            Value::Array(unmonitored.clone()),
        );
        body.insert(String::from("monitored"), Value::Bool(true));
        if let Err(e) = client
            .call(
                &context.server,
                Method::PUT,
                "/episode/monitor",
                &[],
                Some(&Value::Object(body)),
                timeout,
            )
            .await
        {
            let ids = Value::Array(unmonitored);
            tracing::error!(
                label = "Sonarr API",
                error_message = %axios_message(&e),
                episode_ids = %ids,
                "Failed to monitor episodes"
            );
            return Err(anyhow!("Failed to monitor episodes"));
        }
    }
    let monitored_at = Some(now_ms());
    let monitored: Vec<(i64, Option<i64>)> =
        newly_monitored.iter().map(|c| (*c, monitored_at)).collect();
    save_child_dates(&job.state.db, "monitoredAt", &monitored).await?;
    if searchable.is_empty() {
        return Ok(());
    }
    let mut body = Map::new();
    body.insert(String::from("name"), Value::from("EpisodeSearch"));
    body.insert(
        String::from("episodeIds"),
        Value::Array(searchable.iter().map(|(_, id)| id.clone()).collect()),
    );
    client
        .call(
            &context.server,
            Method::POST,
            "/command",
            &[],
            Some(&Value::Object(body)),
            timeout,
        )
        .await
        .map_err(|e| anyhow!("[Sonarr] Failed to run command: {}", axios_message(&e)))?;
    let searched_at = Some(now_ms());
    let searched: Vec<(i64, Option<i64>)> =
        searchable.iter().map(|(c, _)| (*c, searched_at)).collect();
    save_child_dates(&job.state.db, "searchTriggeredAt", &searched).await
}

/// Set a date column of episode children (`None` clears it), in one
/// transaction as `episodeRepository.save([...])` writes them.
async fn save_child_dates(db: &Db, column: &str, dates: &[(i64, Option<i64>)]) -> Result<()> {
    if dates.is_empty() {
        return Ok(());
    }
    let pg = db.is_postgres();
    let mut tx = Tx::begin(db).await?;
    for (child, at) in dates {
        tx.execute(
            &format!(
                r#"UPDATE "episode_request" SET "{column}" = {}, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?2"#,
                date_ph(pg, 1)
            ),
            &[opt_date_bind(pg, *at), Bind::Int(*child)],
        )
        .await?;
    }
    tx.commit().await
}

/// `watchAheadInactiveAt` alone, outside `crate::lifecycle`: saving the
/// request would run its hooks and send it to Sonarr again.
async fn save_inactive_at(db: &Db, request_id: i64, at: Option<i64>) -> Result<()> {
    let pg = db.is_postgres();
    db.execute(
        &format!(
            r#"UPDATE "media_request" SET "watchAheadInactiveAt" = {}, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?2"#,
            date_ph(pg, 1)
        ),
        &[opt_date_bind(pg, at), Bind::Int(request_id)],
    )
    .await?;
    Ok(())
}

/// What `expandWatchAhead` found.
#[derive(Default)]
struct Expansion {
    /// `ready`: the catalog and the play history were read.
    ready: bool,
    /// `caughtUp`: nothing is left to watch ahead.
    caught_up: bool,
    /// Whether children were added.
    inserted: bool,
    /// `window`: the tvdb ids of the desired window, once ready.
    window: Option<HashSet<i64>>,
}

/// `expandWatchAhead`.
async fn expand_watch_ahead(
    job: &JobCtx,
    request: &Entity,
    by_tvdb: &HashMap<i64, &Value>,
    additions: &mut HashSet<i64>,
) -> Result<Expansion> {
    let Some(media) = request.media.as_ref().filter(|m| m.tmdb_id != 0) else {
        return Ok(Expansion::default());
    };
    let catalog = match episode_catalog(job, media.tmdb_id).await {
        Ok(catalog) => catalog,
        Err(e) => {
            tracing::warn!(
                label = "Episode Request Sync",
                request_id = request.row.id,
                tmdb_id = media.tmdb_id,
                error_message = %format!("{e:#}"),
                "Failed to load TVDB catalog for watch-ahead sync"
            );
            return Ok(Expansion::default());
        }
    };
    let series_id = if request.row.is4k {
        media.jellyfin_media_id4k.clone()
    } else {
        media.jellyfin_media_id.clone()
    };
    let user_id = request.row.requested_by_id.unwrap_or(0);
    let Some(played) = played_for_series(job, user_id, series_id.as_deref(), &catalog).await else {
        return Ok(Expansion::default());
    };
    let desired = watch_ahead_window(
        &catalog,
        watch_ahead_count(request.row.watch_ahead_count),
        &played,
    );
    let window: HashSet<i64> = desired.iter().map(|e| e.tvdb_id).collect();
    let known: HashSet<i64> = request.row.episodes.iter().map(|e| e.tvdb_id).collect();
    // Downloaded window episodes are tracked too, as completed children, so
    // a file deleted before it was watched is not requested again later.
    let fresh: Vec<NewEpisode> = desired
        .iter()
        .filter(|e| !known.contains(&e.tvdb_id))
        .map(|e| {
            let sonarr = by_tvdb.get(&e.tvdb_id);
            NewEpisode {
                tvdb_id: e.tvdb_id,
                season: e.season,
                episode: e.episode,
                title: Some(e.title.clone()),
                air_date: e
                    .air_date
                    .clone()
                    .or_else(|| sonarr.and_then(|s| sonarr_text(s, "airDate"))),
                status: if sonarr.is_some_and(|s| truthy(s.get("hasFile"))) {
                    COMPLETED
                } else {
                    APPROVED
                },
            }
        })
        .collect();
    if fresh.is_empty() {
        return Ok(Expansion {
            ready: true,
            caught_up: desired.is_empty(),
            inserted: false,
            window: Some(window),
        });
    }
    insert_episodes(job, request.row.id, &fresh).await?;
    additions.extend(
        fresh
            .iter()
            .filter(|e| e.status != COMPLETED)
            .map(|e| e.tvdb_id),
    );
    Ok(Expansion {
        ready: true,
        caught_up: false,
        inserted: true,
        window: Some(window),
    })
}

/// `loadPlayedTvdbIdsForSeries`: `None` when the play history couldn't be
/// read. Unknown progress is not "nothing watched": an empty set would move
/// the window back to the first episodes and download them again.
async fn played_for_series(
    job: &JobCtx,
    user_id: i64,
    series_id: Option<&str>,
    catalog: &[CatalogEpisode],
) -> Option<HashSet<i64>> {
    let Some(series_id) = series_id.filter(|s| !s.is_empty()) else {
        return Some(HashSet::new());
    };
    let lib = Lib {
        state: &job.state,
        settings: &job.settings,
        user_id,
    };
    let items = match lib.link().await {
        Ok(Link::Linked(linked)) => linked
            .client
            .series_episodes(series_id)
            .await
            .map_err(|e| format!("{e:?}")),
        Ok(Link::Code(_)) => return Some(HashSet::new()),
        Err(why) => Err(why),
    };
    match items {
        Ok(items) => {
            let items: Vec<PlayedEpisode> = items
                .iter()
                .map(|i| PlayedEpisode {
                    tvdb_id: i.provider("Tvdb").map(str::to_owned),
                    season: i.int("ParentIndexNumber"),
                    episode: i.int("IndexNumber"),
                    played: i.played(),
                })
                .collect();
            Some(played_tvdb_ids(catalog, &items))
        }
        Err(why) => {
            tracing::warn!(
                label = "Watch Ahead",
                user_id,
                jellyfin_series_id = series_id,
                error_message = %why,
                "Failed to load Jellyfin watch progress for watch-ahead"
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ep(tvdb_id: i64, season: i64, episode: i64) -> CatalogEpisode {
        CatalogEpisode {
            tvdb_id,
            season,
            episode,
            title: format!("Episode {episode}"),
            air_date: None,
        }
    }

    fn catalog() -> Vec<CatalogEpisode> {
        vec![
            ep(100, 0, 1),
            ep(101, 1, 1),
            ep(102, 1, 2),
            ep(103, 1, 3),
            ep(201, 2, 1),
        ]
    }

    #[test]
    fn counts_are_clamped() {
        assert_eq!(watch_ahead_count(None), 10, "default");
        assert_eq!(watch_ahead_count(Some(0)), 1, "minimum");
        assert_eq!(watch_ahead_count(Some(99)), 50, "maximum");
    }

    #[test]
    fn window_starts_after_the_last_played_episode() {
        let played: HashSet<i64> = std::iter::once(102).collect();
        let window = watch_ahead_window(&catalog(), 2, &played);
        let ids: Vec<i64> = window.iter().map(|e| e.tvdb_id).collect();
        assert_eq!(ids, vec![103, 201], "two after the played one");
        let none = watch_ahead_window(&catalog(), 3, &HashSet::new());
        assert_eq!(
            none.first().map(|e| e.tvdb_id),
            Some(101),
            "specials skipped"
        );
    }

    #[test]
    fn played_ids_from_jellyfin() {
        let items = vec![
            PlayedEpisode {
                tvdb_id: Some(String::from("101")),
                season: None,
                episode: None,
                played: true,
            },
            PlayedEpisode {
                tvdb_id: Some(String::from("999")),
                season: Some(1),
                episode: Some(3),
                played: true,
            },
            PlayedEpisode {
                tvdb_id: None,
                season: Some(2),
                episode: Some(1),
                played: false,
            },
        ];
        let played = played_tvdb_ids(&catalog(), &items);
        let mut ids: Vec<i64> = played.into_iter().collect();
        ids.sort_unstable();
        assert_eq!(ids, vec![101, 103], "by id, then by number");
    }

    fn node_catalog() -> Vec<CatalogEpisode> {
        vec![
            ep(10, 0, 1),
            ep(11, 1, 1),
            ep(12, 1, 2),
            ep(21, 2, 1),
            ep(22, 2, 2),
        ]
    }

    fn window(count: i64, played: &[i64]) -> Vec<i64> {
        let played: HashSet<i64> = played.iter().copied().collect();
        watch_ahead_window(&node_catalog(), count, &played)
            .iter()
            .map(|e| e.tvdb_id)
            .collect()
    }

    #[test]
    fn node_watch_ahead_cases() {
        assert_eq!(
            window(2, &[]),
            vec![11, 12],
            "starts from the first episode"
        );
        assert_eq!(
            window(10, &[12]),
            vec![21, 22],
            "slides from the last played"
        );
        assert_eq!(window(2, &[11, 21]), vec![22], "highest watched index");
        assert!(window(10, &[22]).is_empty(), "empty after the last episode");
        assert_eq!(window(1, &[11]), vec![12], "never more than N");
        let items = vec![
            PlayedEpisode {
                tvdb_id: Some(String::from("12")),
                season: None,
                episode: None,
                played: true,
            },
            PlayedEpisode {
                tvdb_id: None,
                season: Some(2),
                episode: Some(1),
                played: true,
            },
            PlayedEpisode {
                tvdb_id: Some(String::from("99")),
                season: Some(1),
                episode: Some(1),
                played: true,
            },
            PlayedEpisode {
                tvdb_id: Some(String::from("22")),
                season: None,
                episode: None,
                played: false,
            },
        ];
        let mut ids: Vec<i64> = played_tvdb_ids(&node_catalog(), &items)
            .into_iter()
            .collect();
        ids.sort_unstable();
        assert_eq!(ids, vec![11, 12, 21], "provider ids, then numbers");
    }

    #[test]
    fn deleted_watch_ahead_episodes_stay_unmonitored() {
        assert!(
            awaits_monitor(true, false, APPROVED, false),
            "missing and never monitored"
        );
        assert!(
            !awaits_monitor(true, false, APPROVED, true),
            "monitored once, then unmonitored by someone else"
        );
        assert!(
            !awaits_monitor(true, false, COMPLETED, false),
            "downloaded, then deleted"
        );
        assert!(
            !awaits_monitor(true, true, APPROVED, false),
            "already has its file"
        );
        assert!(
            !awaits_monitor(false, false, APPROVED, false),
            "behind the window, or not a watch-ahead request"
        );
    }

    #[test]
    fn completed_episodes_are_not_searched_after_deletion() {
        assert!(
            wants_search(false, true, false, APPROVED),
            "monitored, never downloaded"
        );
        assert!(
            !wants_search(false, true, false, COMPLETED),
            "still monitored after its file was deleted"
        );
        assert!(
            !wants_search(true, false, true, COMPLETED),
            "completed children are never searched"
        );
        assert!(
            !wants_search(false, false, false, APPROVED),
            "unmonitored and not kept"
        );
    }

    #[test]
    fn removed_window_episodes() {
        assert!(
            removed_externally(false, false, APPROVED, true),
            "monitored by Foreseerr, then unmonitored without a file"
        );
        assert!(
            removed_externally(false, false, COMPLETED, false),
            "downloaded, then deleted and unmonitored"
        );
        assert!(
            !removed_externally(false, false, APPROVED, false),
            "not monitored yet, so not removed"
        );
        assert!(
            !removed_externally(false, true, APPROVED, true),
            "monitored again in Sonarr"
        );
        assert!(
            !removed_externally(true, false, COMPLETED, true),
            "still has its file"
        );
    }

    #[test]
    fn inactive_when_the_whole_window_was_removed() {
        let set = |ids: &[i64]| ids.iter().copied().collect::<HashSet<i64>>();
        assert!(window_inactive(&set(&[1, 2]), &set(&[1, 2])), "all removed");
        assert!(!window_inactive(&set(&[1, 2]), &set(&[1])), "one left");
        assert!(!window_inactive(&set(&[]), &set(&[])), "empty window");
    }

    #[tokio::test]
    async fn watch_ahead_dates_read_back() -> Result<()> {
        use crate::dbtx::scratch::{self, PENDING_SEASON_ONE};
        use anyhow::Context;

        let scratch = scratch::sqlite("episode-sync-dates").await?;
        let db = &scratch.db;
        scratch::run(db, &PENDING_SEASON_ONE).await?;
        scratch::run(
            db,
            &[r#"INSERT INTO "episode_request" ("id", "tvdbId", "seasonNumber", "episodeNumber", "status", "requestId") VALUES (1, 101, 1, 1, 2, 1), (2, 102, 1, 2, 2, 1)"#],
        )
        .await?;
        let at = 1_790_000_000_123;
        save_child_dates(db, "monitoredAt", &[(1, Some(at)), (2, Some(at))]).await?;
        save_child_dates(db, "unmonitoredAt", &[(1, Some(at))]).await?;
        save_inactive_at(db, 1, Some(at)).await?;
        let row = db.request_by_id(1).await?.context("request 1")?;
        let stamped = Some(iso(at));
        assert_eq!(row.watch_ahead_inactive_at, stamped, "request marked");
        let dates: Vec<_> = row
            .episodes
            .iter()
            .map(|e| (e.monitored_at.clone(), e.unmonitored_at.clone()))
            .collect();
        assert_eq!(
            dates,
            [(stamped.clone(), stamped.clone()), (stamped.clone(), None)],
            "both monitored, the first removed"
        );

        save_child_dates(db, "unmonitoredAt", &[(1, None)]).await?;
        save_inactive_at(db, 1, None).await?;
        let row = db.request_by_id(1).await?.context("request 1")?;
        assert_eq!(row.watch_ahead_inactive_at, None, "request cleared");
        assert!(
            row.episodes.iter().all(|e| e.unmonitored_at.is_none()),
            "episode cleared"
        );
        Ok(())
    }
}
