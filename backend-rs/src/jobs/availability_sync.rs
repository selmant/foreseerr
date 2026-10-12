//! `availability-sync`: `server/lib/availabilitySync.ts`.
//!
//! Every title marked available (or with an available season) is looked up
//! in Radarr/Sonarr and the media server; what can no longer be found is
//! marked deleted. The saves go through `routes::mediasave`, which runs
//! `MediaSubscriber`'s request completion.
//!
//! Like Node's `find`, a title's eager seasons are only those whose joined
//! row passed the availability filter, and the save detaches the rest
//! (`TypeORM`'s orphan handling sets their `mediaId` to null).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use reqwest::Method;
use serde_json::{Map, Value};

use super::syncutil::{http_status, int, text};
use super::JobCtx;
use crate::db::{Bind, MediaRow, SeasonRow};
use crate::jellyfin::{hostname, Item, JellyfinClient, JfError};
use crate::lifecycle::{Lc, APPROVED};
use crate::routes::mediasave::{self, MediaEdit};
use crate::settings::public::truthy;

const PAGE_SIZE: i64 = 50;
/// `MediaStatus`.
const PARTIAL: i64 = 4;
const AVAILABLE: i64 = 5;
const DELETED: i64 = 7;
/// `MediaServerType`.
const PLEX: i64 = 1;
const JELLYFIN: i64 = 2;
const EMBY: i64 = 3;

static RUNNING: AtomicBool = AtomicBool::new(false);

/// `availabilitySync.running`.
#[must_use]
pub fn running() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

const fn available_or_partial(status: i64) -> bool {
    status == AVAILABLE || status == PARTIAL
}

const fn season_status(season: &SeasonRow, four_k: bool) -> i64 {
    if four_k {
        season.status4k
    } else {
        season.status
    }
}

const fn media_status(media: &MediaRow, four_k: bool) -> i64 {
    if four_k {
        media.status4k
    } else {
        media.status
    }
}

/// `PlexAPI` for the admin's token.
struct Plex {
    http: reqwest::Client,
    base: String,
    token: String,
    client_id: String,
}

/// A failed call: `true` when the message would contain `404`.
struct CallError {
    not_found: bool,
    message: String,
}

impl Plex {
    async fn get(&self, path: &str) -> Result<Value, CallError> {
        let response = self
            .http
            .get(format!("{}{path}", self.base))
            .header("X-Plex-Token", &self.token)
            .header("X-Plex-Client-Identifier", &self.client_id)
            .header("X-Plex-Product", "Foreseerr")
            .header("X-Plex-Device-Name", "Foreseerr")
            .header("X-Plex-Platform", "Foreseerr")
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .send()
            .await
            .map_err(|e| CallError {
                not_found: false,
                message: crate::outbound::describe(&e),
            })?;
        let status = response.status().as_u16();
        if !response.status().is_success() {
            return Err(CallError {
                not_found: status == 404,
                message: format!("Request failed with status code {status}"),
            });
        }
        let bytes = response.bytes().await.map_err(|e| CallError {
            not_found: false,
            message: crate::outbound::describe(&e),
        })?;
        Ok(serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    /// `getMetadata(key)`: `MediaContainer.Metadata[0]`.
    async fn metadata(&self, key: &str) -> Result<Option<Value>, CallError> {
        let body = self.get(&format!("/library/metadata/{key}")).await?;
        match body.pointer("/MediaContainer/Metadata") {
            Some(Value::Array(items)) => Ok(items.first().cloned()),
            _ => Err(CallError {
                not_found: false,
                message: String::from("0 is missing"),
            }),
        }
    }

    /// `getChildrenMetadata(key)`: `MediaContainer.Metadata`.
    async fn children(&self, key: &str) -> Result<Option<Vec<Value>>, CallError> {
        let body = self
            .get(&format!("/library/metadata/{key}/children"))
            .await?;
        match body.get("MediaContainer") {
            Some(Value::Object(c)) => Ok(c.get("Metadata").and_then(Value::as_array).cloned()),
            _ => Err(CallError {
                not_found: false,
                message: String::from("Metadata is missing"),
            }),
        }
    }
}

fn widths(item: &Value) -> Vec<f64> {
    item.get("Media")
        .and_then(Value::as_array)
        .map(|m| {
            m.iter()
                .map(|v| v.get("width").and_then(Value::as_f64).unwrap_or(0.0))
                .collect()
        })
        .unwrap_or_default()
}

fn plex_key(v: Option<&Value>) -> String {
    crate::media::js_string(v).into_owned()
}

/// One run's state (`AvailabilitySync`'s fields).
struct Sync<'a> {
    job: &'a JobCtx,
    lc: Lc,
    server_type: i64,
    plex: Option<Plex>,
    jellyfin: Option<JellyfinClient>,
    radarr: Vec<Value>,
    sonarr: Vec<Value>,
    enable_4k_movie: bool,
    enable_4k_show: bool,
    plex_seasons: HashMap<String, Option<Vec<Value>>>,
    plex_episode_exists: HashMap<String, bool>,
    jellyfin_seasons: HashMap<String, Vec<Item>>,
    jellyfin_episode_exists: HashMap<String, bool>,
    sonarr_seasons: HashMap<String, Value>,
}

/// `availabilitySync.run()`.
///
/// # Errors
///
/// Never: failures are logged as Node logs them.
pub async fn run(job: &JobCtx) -> Result<()> {
    RUNNING.store(true, Ordering::SeqCst);
    let _running = super::Running::new(&RUNNING, job);
    tracing::info!(label = "AvailabilitySync", "Starting availability sync...");
    if let Err(e) = sync(job).await {
        tracing::error!(
            label = "AvailabilitySync",
            error_message = %format!("{e:#}"),
            "Failed to complete availability sync."
        );
    }
    tracing::info!(label = "AvailabilitySync", "Availability sync complete.");
    Ok(())
}

fn servers(job: &JobCtx, kind: &str) -> Vec<Value> {
    job.settings
        .get(&format!("/{kind}"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

async fn sync(job: &JobCtx) -> Result<()> {
    let settings = &job.settings;
    let server_type = settings
        .get("/main/mediaServerType")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let radarr = servers(job, "radarr");
    let sonarr = servers(job, "sonarr");
    let mut s = Sync {
        job,
        lc: Lc {
            state: Arc::clone(&job.state),
            settings: Arc::clone(&job.settings),
        },
        server_type,
        plex: None,
        jellyfin: None,
        enable_4k_movie: radarr.iter().any(|r| truthy(r.get("is4k"))),
        enable_4k_show: sonarr.iter().any(|r| truthy(r.get("is4k"))),
        radarr,
        sonarr,
        plex_seasons: HashMap::new(),
        plex_episode_exists: HashMap::new(),
        jellyfin_seasons: HashMap::new(),
        jellyfin_episode_exists: HashMap::new(),
        sonarr_seasons: HashMap::new(),
    };
    if !s.connect().await? {
        return Ok(());
    }
    let mut offset = 0;
    loop {
        let page = load_page(job, offset).await?;
        if page.is_empty() {
            break;
        }
        for (media, detach) in page {
            if job.cancelled() {
                return Err(anyhow!("Job aborted"));
            }
            if media.media_type == "movie" {
                s.check_movie(media, detach).await;
            } else if media.media_type == "tv" {
                s.check_show(media, detach).await;
            }
        }
        offset += PAGE_SIZE;
    }
    Ok(())
}

/// One page of `loadAvailableMediaPaginated`: each title with the seasons
/// its `find` loads, and the ids of the stored seasons it leaves out.
async fn load_page(job: &JobCtx, offset: i64) -> Result<Vec<(MediaRow, Vec<i64>)>> {
    let db = &job.state.db;
    let rows = db
        .rows(
            r#"SELECT DISTINCT CAST("m"."id" AS BIGINT) AS "id" FROM "media" "m" LEFT JOIN "season" "s" ON "s"."mediaId" = "m"."id" WHERE "m"."status" IN (5, 4) OR "m"."status4k" IN (5, 4) OR "s"."status" IN (5, 4) OR "s"."status4k" IN (5, 4) ORDER BY 1 ASC LIMIT ?1 OFFSET ?2"#,
            &[Bind::Int(PAGE_SIZE), Bind::Int(offset)],
        )
        .await?;
    let ids: Vec<i64> = rows.iter().filter_map(|r| int(r, "id")).collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut media = db.media_by_ids(&ids, true).await?;
    media.sort_by_key(|m| m.id);
    Ok(media
        .into_iter()
        .map(|mut m| {
            let whole = available_or_partial(m.status) || available_or_partial(m.status4k);
            let mut detach = Vec::new();
            if !whole {
                let (kept, left): (Vec<SeasonRow>, Vec<SeasonRow>) =
                    m.seasons.into_iter().partition(|s| {
                        available_or_partial(s.status) || available_or_partial(s.status4k)
                    });
                detach = left.iter().map(|s| s.id).collect();
                m.seasons = kept;
            }
            m.seasons.sort_by_key(|s| s.id);
            (m, detach)
        })
        .collect())
}

impl Sync<'_> {
    /// The media server client for the admin; `false` when the sync stops.
    async fn connect(&mut self) -> Result<bool> {
        let db = &self.job.state.db;
        let admin = db
            .rows(
                r#"SELECT "plexToken", "jellyfinUserId", "jellyfinDeviceId" FROM "user" WHERE "id" = 1 LIMIT 1"#,
                &[],
            )
            .await?
            .into_iter()
            .next();
        let settings = &self.job.settings;
        match self.server_type {
            PLEX => {
                if let Some(token) = admin
                    .as_ref()
                    .and_then(|a| text(a, "plexToken"))
                    .filter(|t| !t.is_empty())
                {
                    let scheme = if truthy(settings.get("/plex/useSsl")) {
                        "https"
                    } else {
                        "http"
                    };
                    self.plex = Some(Plex {
                        http: self.job.state.outbound.clone(),
                        base: format!(
                            "{scheme}://{}:{}",
                            crate::media::js_string(settings.get("/plex/ip")),
                            crate::media::js_string(settings.get("/plex/port"))
                        ),
                        token,
                        client_id: settings.str("/clientId").to_owned(),
                    });
                } else {
                    tracing::error!("Plex admin is not configured.");
                }
                Ok(true)
            }
            JELLYFIN | EMBY => {
                let Some(admin) = admin else {
                    tracing::error!("Jellyfin admin is not configured.");
                    return Ok(false);
                };
                self.connect_jellyfin(&admin).await
            }
            _ => {
                tracing::error!("An admin is not configured.");
                Ok(false)
            }
        }
    }

    async fn connect_jellyfin(&mut self, admin: &Map<String, Value>) -> Result<bool> {
        let settings = &self.job.settings;
        let device = text(admin, "jellyfinDeviceId").filter(|d| !d.is_empty());
        let device = device.unwrap_or_else(|| String::from("Qk9UX3NlZXJy"));
        let version = if self.server_type == EMBY {
            String::from("1.0.0")
        } else {
            self.job.state.version.version.clone()
        };
        let token = settings.str("/jellyfin/apiKey");
        let token_part = if token.is_empty() {
            String::new()
        } else {
            format!(r#", Token="{token}""#)
        };
        let auth = format!(
            r#"MediaBrowser Client="Foreseerr", Device="Foreseerr", DeviceId="{device}", Version="{version}"{token_part}"#
        );
        let base = hostname(settings);
        let info = self
            .job
            .state
            .outbound
            .get(format!("{base}/System/Info"))
            .header(reqwest::header::AUTHORIZATION, &auth)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .send()
            .await;
        let failure = match info {
            Ok(r) if r.status().is_success() => None,
            Ok(r) => Some(r.status().as_u16()),
            Err(_) => Some(502),
        };
        if let Some(status) = failure {
            tracing::error!(
                label = "AvailabilitySync",
                status,
                error = "apiError",
                "Sync interrupted."
            );
            return Ok(false);
        }
        let user = text(admin, "jellyfinUserId").unwrap_or_default();
        match JellyfinClient::new(self.job.state.outbound.clone(), base, &auth, user) {
            Ok(client) => {
                self.jellyfin = Some(client);
                Ok(true)
            }
            Err(why) => Err(anyhow!("the Jellyfin client can't be built: {why}")),
        }
    }

    const fn server_name(&self) -> &'static str {
        match self.server_type {
            PLEX => "plex",
            JELLYFIN => "jellyfin",
            _ => "emby",
        }
    }

    const fn uses_plex(&self) -> bool {
        self.server_type == PLEX
    }

    const fn uses_jellyfin(&self) -> bool {
        self.server_type == JELLYFIN || self.server_type == EMBY
    }

    async fn check_movie(&mut self, mut media: MediaRow, mut detach: Vec<i64>) {
        let radarr = self.exists_in_radarr(&media, false).await;
        let radarr4k = self.exists_in_radarr(&media, true).await;
        let (exists, exists4k) = if self.uses_plex() {
            let plex = self.exists_in_plex(&media, false).await.0;
            let plex4k = self.exists_in_plex(&media, true).await.0;
            (plex || radarr, plex4k || radarr4k)
        } else if self.uses_jellyfin() {
            let jf = self.exists_in_jellyfin(&media, false).await.0;
            let jf4k = self.exists_in_jellyfin(&media, true).await.0;
            (jf || radarr, jf4k || radarr4k)
        } else {
            (false, false)
        };
        if !exists && media.status == AVAILABLE {
            media = self.media_updater(media, false, &mut detach).await;
        }
        if !exists4k && media.status4k == AVAILABLE {
            self.media_updater(media, true, &mut detach).await;
        }
    }

    async fn check_show(&mut self, mut media: MediaRow, mut detach: Vec<i64>) {
        let (plex, plex_seasons) = self.exists_in_plex(&media, false).await;
        let (plex4k, plex_seasons4k) = self.exists_in_plex(&media, true).await;
        let (jf, jf_seasons) = self.exists_in_jellyfin(&media, false).await;
        let (jf4k, jf_seasons4k) = self.exists_in_jellyfin(&media, true).await;
        let (sonarr, sonarr_seasons) = self.exists_in_sonarr(&media, false).await;
        let (sonarr4k, sonarr_seasons4k) = self.exists_in_sonarr(&media, true).await;
        let (exists, exists4k) = if self.uses_plex() {
            (plex || sonarr, plex4k || sonarr4k)
        } else if self.uses_jellyfin() {
            (jf || sonarr, jf4k || sonarr4k)
        } else {
            (false, false)
        };
        let filtered = |four_k: bool| -> Vec<(i64, bool)> {
            let mut out: Vec<(i64, bool)> = Vec::new();
            for s in media
                .seasons
                .iter()
                .filter(|s| available_or_partial(season_status(s, four_k)))
            {
                merge(&mut out, &[(s.season_number, false)]);
            }
            out
        };
        let mut finals = filtered(false);
        let mut finals4k = filtered(true);
        if self.uses_plex() {
            merge(&mut finals, &plex_seasons);
            merge(&mut finals4k, &plex_seasons4k);
        } else {
            merge(&mut finals, &jf_seasons);
            merge(&mut finals4k, &jf_seasons4k);
        }
        merge(&mut finals, &sonarr_seasons);
        merge(&mut finals4k, &sonarr_seasons4k);
        if let Some(show) = self.tmdb_show(&media).await {
            for season in media.seasons.iter().filter(|s| s.season_number != 0) {
                let has_episodes = show
                    .get("seasons")
                    .and_then(Value::as_array)
                    .and_then(|list| {
                        list.iter().find(|t| {
                            t.get("season_number").and_then(Value::as_i64)
                                == Some(season.season_number)
                        })
                    })
                    .is_some_and(|t| truthy(t.get("episode_count")));
                if has_episodes {
                    if !finals.iter().any(|(n, _)| *n == season.season_number) {
                        finals.push((season.season_number, false));
                    }
                    if !finals4k.iter().any(|(n, _)| *n == season.season_number) {
                        finals4k.push((season.season_number, false));
                    }
                }
            }
        }
        for four_k in [false, true] {
            let exists = if four_k { exists4k } else { exists };
            let any_season = |status: i64| {
                media
                    .seasons
                    .iter()
                    .any(|s| season_status(s, four_k) == status)
            };
            if !exists
                && (available_or_partial(media_status(&media, four_k))
                    || any_season(AVAILABLE)
                    || any_season(PARTIAL))
            {
                media = self.media_updater(media, four_k, &mut detach).await;
            }
        }
        if finals.iter().any(|(_, e)| !e) {
            media = self
                .season_updater(media, &finals, false, &mut detach)
                .await;
        }
        if finals4k.iter().any(|(_, e)| !e) {
            self.season_updater(media, &finals4k, true, &mut detach)
                .await;
        }
    }

    /// `getTvShowForScan` / `getShowByTvdbIdForScan`, `None` on failure.
    async fn tmdb_show(&self, media: &MediaRow) -> Option<Value> {
        let tmdb = &self.job.state.tmdb;
        let locale = match self.job.settings.str("/main/locale") {
            "" => "en",
            other => other,
        };
        let details = |id: i64| async move {
            tmdb.raw(
                &format!("/tv/{id}"),
                &[
                    ("language", locale.to_owned()),
                    ("append_to_response", String::from("keywords,external_ids")),
                ],
                900,
            )
            .await
        };
        let result = if media.tmdb_id != 0 {
            details(media.tmdb_id).await
        } else {
            let tvdb_id = media.tvdb_id.filter(|t| *t != 0)?;
            let found = tmdb
                .raw(
                    &format!("/find/{tvdb_id}"),
                    &[
                        ("external_source", String::from("tvdb_id")),
                        ("language", locale.to_owned()),
                    ],
                    900,
                )
                .await;
            match found.map(|f| f.pointer("/tv_results/0/id").and_then(Value::as_i64)) {
                Ok(Some(id)) => details(id).await,
                Ok(None) => Err(anyhow!("No show returned from API for ID {tvdb_id}")),
                Err(e) => Err(e),
            }
        };
        match result {
            Ok(show) => Some(show),
            Err(e) => {
                tracing::debug!(
                    label = "AvailabilitySync",
                    error_message = %format!("{e:#}"),
                    "Failed to fetch TMDB data for show [TMDB ID {}]. Skipping season enrichment.",
                    media.tmdb_id
                );
                None
            }
        }
    }

    /// `mediaUpdater`: the quality marked deleted, its service data cleared
    /// unless an approved request is still in flight.
    async fn media_updater(
        &self,
        media: MediaRow,
        four_k: bool,
        detach: &mut Vec<i64>,
    ) -> MediaRow {
        let processing = self
            .job
            .state
            .db
            .scalar(
                r#"SELECT COUNT(*) FROM "media_request" WHERE "mediaId" = ?1 AND "is4k" = ?2 AND "status" = ?3"#,
                &[Bind::Int(media.id), Bind::Bool(four_k), Bind::Int(APPROVED)],
            )
            .await;
        let processing = match processing {
            Ok(n) => n > 0,
            Err(e) => {
                log_failure(&media, four_k, &e);
                return media;
            }
        };
        let mut edit = MediaEdit::new(media);
        let m = &mut edit.after;
        if four_k {
            m.status4k = DELETED;
        } else {
            m.status = DELETED;
        }
        if !processing {
            if four_k {
                m.service_id4k = None;
                m.external_service_id4k = None;
                m.external_service_slug4k = None;
            } else {
                m.service_id = None;
                m.external_service_id = None;
                m.external_service_slug = None;
            }
            match (self.uses_plex(), self.uses_jellyfin(), four_k) {
                (true, _, true) => m.rating_key4k = None,
                (true, _, false) => m.rating_key = None,
                (false, true, true) => m.jellyfin_media_id4k = None,
                (false, true, false) => m.jellyfin_media_id = None,
                (false, false, _) => {}
            }
        }
        let movie = edit.after.media_type == "movie";
        tracing::debug!(
            label = "AvailabilitySync",
            "The {} {} [TMDB ID {}] was not found in any {} and {} instance. Status will be changed to deleted.",
            if four_k { "4K" } else { "non-4K" },
            if movie { "movie" } else { "show" },
            edit.after.tmdb_id,
            if movie { "Radarr" } else { "Sonarr" },
            self.server_name()
        );
        self.save(edit, four_k, detach).await
    }

    /// The save; the first one of a title also detaches the seasons its
    /// `find` left out.
    async fn save(&self, mut edit: MediaEdit, four_k: bool, detach: &mut Vec<i64>) -> MediaRow {
        let orphans = std::mem::take(detach);
        if let Err(e) = mediasave::save_with_orphans(&self.lc, &mut edit, &orphans).await {
            log_failure(&edit.after, four_k, &e);
        }
        edit.after
    }

    /// `seasonUpdater`.
    async fn season_updater(
        &self,
        media: MediaRow,
        seasons: &[(i64, bool)],
        four_k: bool,
        detach: &mut Vec<i64>,
    ) -> MediaRow {
        let pending: Vec<i64> = seasons
            .iter()
            .filter(|(_, e)| !e)
            .map(|(n, _)| *n)
            .collect();
        let non_special: Vec<i64> = pending.iter().copied().filter(|n| *n != 0).collect();
        let mut edit = MediaEdit::new(media);
        for season in &mut edit.after.seasons {
            if pending.contains(&season.season_number)
                && available_or_partial(season_status(season, four_k))
            {
                if four_k {
                    season.status4k = DELETED;
                } else {
                    season.status = DELETED;
                }
            }
        }
        if !non_special.is_empty() && media_status(&edit.after, four_k) == AVAILABLE {
            if four_k {
                edit.after.status4k = PARTIAL;
            } else {
                edit.after.status = PARTIAL;
            }
            tracing::debug!(
                label = "AvailabilitySync",
                "Marking the {} show [TMDB ID {}] as PARTIALLY_AVAILABLE because season(s) [{}] was not found in any Sonarr and {} instance.",
                if four_k { "4K" } else { "non-4K" },
                edit.after.tmdb_id,
                non_special.iter().map(i64::to_string).collect::<Vec<_>>().join(","),
                self.server_name()
            );
        }
        edit.after.last_season_change = Some(super::syncutil::iso(super::syncutil::now_ms()));
        self.save(edit, four_k, detach).await
    }

    /// `mediaExistsInRadarr`.
    async fn exists_in_radarr(&self, media: &MediaRow, four_k: bool) -> bool {
        let same_server_both = self.radarr.iter().any(|a| {
            self.radarr.iter().any(|b| {
                truthy(a.get("is4k")) != truthy(b.get("is4k"))
                    && a.get("hostname") == b.get("hostname")
                    && a.get("port") == b.get("port")
            })
        });
        let timeout = crate::servarr::api_timeout(&self.job.settings);
        let external = if four_k {
            media.external_service_id4k
        } else {
            media.external_service_id
        };
        let mut exists = false;
        for server in self
            .radarr
            .iter()
            .filter(|s| s.get("is4k") == Some(&Value::Bool(four_k)))
        {
            let Some(id) = external.filter(|id| *id != 0) else {
                continue;
            };
            match self
                .job
                .state
                .servarr
                .call(
                    server,
                    Method::GET,
                    &format!("/movie/{id}"),
                    &[],
                    None,
                    timeout,
                )
                .await
            {
                Ok(movie) => {
                    if movie.is_null()
                        || movie.get("tmdbId").and_then(Value::as_i64) != Some(media.tmdb_id)
                    {
                        continue;
                    }
                    if truthy(movie.get("hasFile")) {
                        let resolution = movie
                            .pointer("/movieFile/mediaInfo/resolution")
                            .and_then(Value::as_str)
                            .map(|r| r.split('x').map(str::to_owned).collect::<Vec<_>>());
                        let pair = resolution.filter(|r| r.len() == 2);
                        exists = match (&pair, same_server_both) {
                            (Some(r), true) => {
                                let wide = r
                                    .first()
                                    .map(|w| crate::jobs::syncutil::js_number_text(w))
                                    .and_then(|w| w.parse::<f64>().ok())
                                    .is_some_and(|w| w >= 2000.0);
                                if four_k {
                                    wide
                                } else {
                                    !wide
                                }
                            }
                            _ => true,
                        };
                    }
                }
                Err(e) => {
                    if http_status(&e) != Some(404) {
                        exists = true;
                        tracing::debug!(
                            label = "AvailabilitySync",
                            error_message = %format!("[Radarr] Failed to retrieve movie: {}", super::syncutil::axios_message(&e)),
                            "Failure retrieving the {} movie [TMDB ID {}] from Radarr.",
                            if four_k { "4K" } else { "non-4K" },
                            media.tmdb_id
                        );
                    }
                }
            }
            if exists {
                break;
            }
        }
        exists
    }

    /// `mediaExistsInSonarr`: whether the show exists and which of its
    /// seasons do.
    async fn exists_in_sonarr(
        &mut self,
        media: &MediaRow,
        four_k: bool,
    ) -> (bool, Vec<(i64, bool)>) {
        let timeout = crate::servarr::api_timeout(&self.job.settings);
        let external = if four_k {
            media.external_service_id4k
        } else {
            media.external_service_id
        };
        let mut exists = false;
        let mut prevent = false;
        let servers: Vec<Value> = self
            .sonarr
            .iter()
            .filter(|s| s.get("is4k") == Some(&Value::Bool(four_k)))
            .cloned()
            .collect();
        for server in &servers {
            let Some(id) = external.filter(|id| *id != 0) else {
                continue;
            };
            match self
                .job
                .state
                .servarr
                .call(
                    server,
                    Method::GET,
                    &format!("/series/{id}"),
                    &[],
                    None,
                    timeout,
                )
                .await
            {
                Ok(series) if series.is_null() => {}
                Ok(series) => {
                    if media.tvdb_id.is_some()
                        && series.get("tvdbId").and_then(Value::as_i64) != media.tvdb_id
                    {
                        continue;
                    }
                    let key = format!("{}-{id}", crate::media::js_string(server.get("id")));
                    self.sonarr_seasons
                        .insert(key, series.get("seasons").cloned().unwrap_or(Value::Null));
                    if let Some(Value::Object(stats)) = series.pointer("/statistics") {
                        if stats
                            .get("episodeFileCount")
                            .and_then(Value::as_f64)
                            .is_some_and(|n| n > 0.0)
                        {
                            exists = true;
                        }
                    } else {
                        exists = true;
                        prevent = true;
                    }
                }
                Err(e) => {
                    if http_status(&e) != Some(404) {
                        exists = true;
                        prevent = true;
                        tracing::debug!(
                            label = "AvailabilitySync",
                            error_message = %format!("[Sonarr] Failed to retrieve series by ID: {}", super::syncutil::axios_message(&e)),
                            "Failure retrieving the {} show [TMDB ID {}] from Sonarr.",
                            if four_k { "4K" } else { "non-4K" },
                            media.tmdb_id
                        );
                    }
                }
            }
        }
        let mut seasons = Vec::new();
        if !prevent {
            for season in media
                .seasons
                .iter()
                .filter(|s| available_or_partial(season_status(s, four_k)))
            {
                if self.season_in_sonarr(&servers, external, season.season_number) {
                    merge(&mut seasons, &[(season.season_number, true)]);
                }
            }
        }
        (exists, seasons)
    }

    fn season_in_sonarr(&self, servers: &[Value], external: Option<i64>, number: i64) -> bool {
        let Some(id) = external.filter(|id| *id != 0) else {
            return false;
        };
        servers.iter().any(|server| {
            let key = format!("{}-{id}", crate::media::js_string(server.get("id")));
            self.sonarr_seasons
                .get(&key)
                .and_then(Value::as_array)
                .is_some_and(|list| {
                    list.iter().any(|s| {
                        s.get("seasonNumber").and_then(Value::as_i64) == Some(number)
                            && s.pointer("/statistics/episodeFileCount")
                                .and_then(Value::as_f64)
                                .is_some_and(|n| n > 0.0)
                    })
                })
        })
    }

    /// `mediaExistsInPlex`.
    async fn exists_in_plex(&mut self, media: &MediaRow, four_k: bool) -> (bool, Vec<(i64, bool)>) {
        let (exists, prevent) = match self.plex_lookup(media, four_k).await {
            Ok(found) => (found, false),
            Err(e) if e.not_found => (false, false),
            Err(e) => {
                tracing::debug!(
                    label = "AvailabilitySync",
                    error_message = %e.message,
                    "Failure retrieving the {} {} [TMDB ID {}] from Plex.",
                    if four_k { "4K" } else { "non-4K" },
                    if media.media_type == "tv" { "show" } else { "movie" },
                    media.tmdb_id
                );
                (true, true)
            }
        };
        let mut seasons = Vec::new();
        if media.media_type == "tv" && !prevent {
            for season in media
                .seasons
                .iter()
                .filter(|s| available_or_partial(season_status(s, four_k)))
            {
                if self
                    .season_in_plex(media, season.season_number, four_k)
                    .await
                {
                    merge(&mut seasons, &[(season.season_number, true)]);
                }
            }
        }
        (exists, seasons)
    }

    async fn plex_lookup(&mut self, media: &MediaRow, four_k: bool) -> Result<bool, CallError> {
        let Some(plex) = &self.plex else {
            if media.media_type == "tv" {
                let key = if four_k {
                    &media.rating_key4k
                } else {
                    &media.rating_key
                };
                if let Some(key) = key.as_ref().filter(|k| !k.is_empty()) {
                    self.plex_seasons.insert(key.clone(), None);
                }
            }
            return Ok(false);
        };
        let tv = media.media_type == "tv";
        let mut found: Option<Value> = None;
        if !four_k {
            if let Some(key) = media.rating_key.as_ref().filter(|k| !k.is_empty()) {
                found = plex.metadata(key).await?;
                if tv {
                    let children = plex.children(key).await?;
                    self.plex_seasons.insert(key.clone(), children);
                }
                if let Some(item) = &found {
                    let w = widths(item);
                    if !tv
                        && self.enable_4k_movie
                        && !w.is_empty()
                        && !w.iter().any(|x| *x < 2000.0)
                    {
                        found = None;
                    }
                }
            }
        } else if let Some(key) = media.rating_key4k.as_ref().filter(|k| !k.is_empty()) {
            found = plex.metadata(key).await?;
            if tv {
                let children = plex.children(key).await?;
                self.plex_seasons.insert(key.clone(), children);
            }
            if let Some(item) = &found {
                let w = widths(item);
                if !tv && !w.is_empty() && !w.iter().any(|x| *x >= 2000.0) {
                    found = None;
                }
            }
            if found.is_some() && tv {
                let cached = self
                    .plex_seasons
                    .get(key)
                    .cloned()
                    .flatten()
                    .unwrap_or_default();
                if !cached.is_empty() {
                    let mut has_4k = false;
                    let mut verified = false;
                    for season in &cached {
                        if let Ok(Some(episodes)) =
                            plex.children(&plex_key(season.get("ratingKey"))).await
                        {
                            if episodes.iter().any(|e| !widths(e).is_empty()) {
                                verified = true;
                            }
                            if episodes
                                .iter()
                                .any(|e| widths(e).iter().any(|x| *x >= 2000.0))
                            {
                                has_4k = true;
                                break;
                            }
                        }
                    }
                    if verified && !has_4k {
                        found = None;
                    }
                }
            }
        }
        Ok(found.is_some())
    }

    /// `seasonExistsInPlex`.
    async fn season_in_plex(&mut self, media: &MediaRow, number: i64, four_k: bool) -> bool {
        let key = if four_k {
            &media.rating_key4k
        } else {
            &media.rating_key
        };
        let Some(key) = key.as_ref().filter(|k| !k.is_empty()) else {
            return false;
        };
        let Some(meta) = self
            .plex_seasons
            .get(key)
            .cloned()
            .flatten()
            .and_then(|list| {
                list.into_iter()
                    .find(|s| s.get("index").and_then(Value::as_i64) == Some(number))
            })
        else {
            return false;
        };
        let season_key = plex_key(meta.get("ratingKey"));
        let cache_key = format!("{}-{season_key}", if four_k { "4k" } else { "std" });
        if let Some(known) = self.plex_episode_exists.get(&cache_key) {
            return *known;
        }
        let Some(plex) = &self.plex else {
            return false;
        };
        let exists = match plex.children(&season_key).await {
            Ok(episodes) => {
                let versions: Vec<f64> = episodes
                    .unwrap_or_default()
                    .iter()
                    .flat_map(widths)
                    .collect();
                if four_k {
                    versions.iter().any(|w| *w >= 2000.0)
                } else if self.enable_4k_show {
                    versions.iter().any(|w| *w < 2000.0)
                } else {
                    !versions.is_empty()
                }
            }
            Err(_) => true,
        };
        self.plex_episode_exists.insert(cache_key, exists);
        exists
    }

    /// `mediaExistsInJellyfin`.
    async fn exists_in_jellyfin(
        &mut self,
        media: &MediaRow,
        four_k: bool,
    ) -> (bool, Vec<(i64, bool)>) {
        let (exists, prevent) = match self.jellyfin_lookup(media, four_k).await {
            Ok(found) => (found, false),
            Err(e) => {
                tracing::debug!(
                    label = "AvailabilitySync",
                    error_message = %e,
                    "Failure retrieving the {} {} [TMDB ID {}] from Jellyfin.",
                    if four_k { "4K" } else { "non-4K" },
                    if media.media_type == "tv" { "show" } else { "movie" },
                    media.tmdb_id
                );
                (true, true)
            }
        };
        let mut seasons = Vec::new();
        if media.media_type == "tv" && !prevent {
            for season in media
                .seasons
                .iter()
                .filter(|s| available_or_partial(season_status(s, four_k)))
            {
                if self
                    .season_in_jellyfin(media, season.season_number, four_k)
                    .await
                {
                    merge(&mut seasons, &[(season.season_number, true)]);
                }
            }
        }
        (exists, seasons)
    }

    async fn jellyfin_lookup(&mut self, media: &MediaRow, four_k: bool) -> Result<bool, String> {
        let Some(client) = &self.jellyfin else {
            return Ok(false);
        };
        let key = if four_k {
            &media.jellyfin_media_id4k
        } else {
            &media.jellyfin_media_id
        };
        let Some(key) = key.as_ref().filter(|k| !k.is_empty()) else {
            return Ok(false);
        };
        let item = match client.item_data(key).await {
            Ok(item) => item,
            Err(JfError::Failed {
                status: Some(500), ..
            }) => None,
            Err(JfError::Failed { message, .. }) => return Err(message),
            Err(JfError::Unsure(why)) => return Err(why),
        };
        if media.media_type == "tv" && item.is_some() {
            let seasons = client.seasons(key).await.map_err(|e| match e {
                JfError::Failed { message, .. } => message,
                JfError::Unsure(why) => why,
            })?;
            self.jellyfin_seasons.insert(key.clone(), seasons);
        }
        Ok(item.is_some())
    }

    /// `seasonExistsInJellyfin`.
    async fn season_in_jellyfin(&mut self, media: &MediaRow, number: i64, four_k: bool) -> bool {
        let key = if four_k {
            &media.jellyfin_media_id4k
        } else {
            &media.jellyfin_media_id
        };
        let Some(series) = key.as_ref().filter(|k| !k.is_empty()) else {
            return false;
        };
        let Some(meta) = self
            .jellyfin_seasons
            .get(series)
            .and_then(|list| list.iter().find(|s| s.int("IndexNumber") == Some(number)))
        else {
            return false;
        };
        let cache_key = format!("{series}-{}", meta.id());
        if let Some(known) = self.jellyfin_episode_exists.get(&cache_key) {
            return *known;
        }
        let season_id = meta.id().to_owned();
        let exists = match &self.jellyfin {
            Some(client) => client
                .episodes(series, &season_id)
                .await
                .map_or(true, |episodes| !episodes.is_empty()),
            None => true,
        };
        self.jellyfin_episode_exists.insert(cache_key, exists);
        exists
    }
}

fn log_failure(media: &MediaRow, four_k: bool, e: &anyhow::Error) {
    tracing::debug!(
        label = "AvailabilitySync",
        error_message = %format!("{e:#}"),
        "Failure updating the {} {} [TMDB ID {}].",
        if four_k { "4K" } else { "non-4K" },
        if media.media_type == "tv" { "show" } else { "movie" },
        media.tmdb_id
    );
}

/// `new Map([...a, ...b])`: later values win, first positions stay.
fn merge(into: &mut Vec<(i64, bool)>, from: &[(i64, bool)]) {
    for (number, exists) in from {
        if let Some(slot) = into.iter_mut().find(|(n, _)| n == number) {
            slot.1 = *exists;
        } else {
            into.push((*number, *exists));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_merge_like_spread() {
        let mut finals = vec![(1, false), (2, false)];
        merge(&mut finals, &[(2, true), (3, true)]);
        assert_eq!(
            finals,
            vec![(1, false), (2, true), (3, true)],
            "later wins, order kept"
        );
    }

    #[test]
    fn plex_widths() {
        let item = json!({"Media": [{"width": 3840}, {}]});
        assert_eq!(widths(&item), vec![3840.0, 0.0], "missing width is 0");
        assert!(widths(&json!({})).is_empty(), "no versions");
    }
}
