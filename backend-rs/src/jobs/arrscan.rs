//! The Radarr and Sonarr scanners (`server/lib/scanners/radarr`, `sonarr`).
//!
//! Every title of every sync-enabled server
//! updates its media (processing, available, service ids), then titles left
//! processing that no server knows any more are reset to unknown and their
//! approved requests declined — only when every server of that quality was
//! scanned and none came back empty.

use std::collections::HashSet;
use std::sync::Mutex;

use anyhow::{anyhow, Context, Result};
use serde_json::Value;

use super::scanbase::{array_of, js_truthy, str_of, uniq_with, Kind, Scan, PROCESSING, UNKNOWN};
use super::scanmedia::{MovieOpts, ProcessableSeason, ShowOpts};
use super::scantmdb::{provider_show, seasons_of, show_by_tvdb, tv_for_scan};
use super::JobCtx;
use crate::db::{Bind, MediaRow};
use crate::media::js_string;
use crate::servarr::api_timeout;
use crate::sync::lock;
use crate::typeorm::strict_eq;

/// `radarrScanner`.
pub static RADARR: Kind = Kind::server("radarr-scan", "Radarr Scan");
/// `sonarrScanner`.
pub static SONARR: Kind = Kind::server("sonarr-scan", "Sonarr Scan");

/// The *arr scanners' bundle size.
const BUNDLE: usize = 50;

/// `radarrScanner.run()` (job `radarr-scan`).
///
/// # Errors
///
/// None: like Node's, a failed scan is logged.
pub async fn run_radarr(job: &JobCtx) -> Result<()> {
    Box::pin(run(job, Arr::Radarr)).await;
    Ok(())
}

/// `sonarrScanner.run()` (job `sonarr-scan`).
///
/// # Errors
///
/// None: like Node's, a failed scan is logged.
pub async fn run_sonarr(job: &JobCtx) -> Result<()> {
    Box::pin(run(job, Arr::Sonarr)).await;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Arr {
    Radarr,
    Sonarr,
}

impl Arr {
    const fn kind(self) -> &'static Kind {
        match self {
            Self::Radarr => &RADARR,
            Self::Sonarr => &SONARR,
        }
    }

    const fn name(self) -> &'static str {
        match self {
            Self::Radarr => "Radarr",
            Self::Sonarr => "Sonarr",
        }
    }
}

async fn run(job: &JobCtx, arr: Arr) {
    let scan = Scan::start(job, arr.kind());
    let mut run = ArrRun {
        scan: &scan,
        arr,
        servers: Vec::new(),
        current: Value::Null,
        scanned: Mutex::new(HashSet::new()),
        scanned_4k: Mutex::new(HashSet::new()),
    };
    if let Err(e) = Box::pin(run.servers_scan()).await {
        scan.error("Scan interrupted", &e);
    }
    scan.end();
}

/// Which qualities the orphan cleanup may run for.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Cleanup {
    standard: bool,
    uhd: bool,
}

/// `didScanStandard` / `didScan4k` after the servers loop: a quality is
/// cleaned up when one of its servers was scanned, all of them have sync
/// enabled, and none returned an empty list. `scanned` holds, per server,
/// whether it was scanned and returned nothing.
fn cleanup_flags(servers: &[Value], enable4k: bool, results: &[(bool, bool)]) -> Cleanup {
    let is_4k = |s: &Value| enable4k && js_truthy(s.get("is4k"));
    let mut flags = Cleanup::default();
    let mut empty = Cleanup::default();
    for (server, (scanned, was_empty)) in servers.iter().zip(results) {
        if !scanned {
            continue;
        }
        if is_4k(server) {
            flags.uhd = true;
            empty.uhd |= was_empty;
        } else {
            flags.standard = true;
            empty.standard |= was_empty;
        }
    }
    let all_synced = |four_k: bool| {
        servers
            .iter()
            .filter(|s| is_4k(s) == four_k)
            .all(|s| js_truthy(s.get("syncEnabled")))
    };
    Cleanup {
        standard: flags.standard && all_synced(false) && !empty.standard,
        uhd: flags.uhd && all_synced(true) && !empty.uhd,
    }
}

/// `uniqWith(settings.radarr, same hostname, port and baseUrl)`.
fn unique_servers(servers: &[Value]) -> Vec<Value> {
    let same = |a: &Value, b: &Value, key: &str| match (a.get(key), b.get(key)) {
        (None, None) => true,
        (Some(x), Some(y)) => strict_eq(x, y),
        _ => false,
    };
    uniq_with(servers, |a, b| {
        same(a, b, "hostname") && same(a, b, "port") && same(a, b, "baseUrl")
    })
}

struct ArrRun<'s> {
    scan: &'s Scan<'s>,
    arr: Arr,
    servers: Vec<Value>,
    current: Value,
    scanned: Mutex<HashSet<i64>>,
    scanned_4k: Mutex<HashSet<i64>>,
}

impl ArrRun<'_> {
    const fn enable4k(&self) -> bool {
        match self.arr {
            Arr::Radarr => self.scan.enable4k_movie,
            Arr::Sonarr => self.scan.enable4k_show,
        }
    }

    fn server_4k(&self, server: &Value) -> bool {
        self.enable4k() && js_truthy(server.get("is4k"))
    }

    async fn call(
        &self,
        server: &Value,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<Vec<Value>> {
        let job = self.scan.job;
        let answer = job
            .state
            .servarr
            .call(
                server,
                reqwest::Method::GET,
                path,
                query,
                None,
                api_timeout(&job.settings),
            )
            .await?;
        match answer {
            Value::Array(items) => Ok(items),
            Value::Null
            | Value::Bool(_)
            | Value::Number(_)
            | Value::String(_)
            | Value::Object(_) => Err(anyhow!("an answer that isn't a list")),
        }
    }

    async fn servers_scan(&mut self) -> Result<()> {
        let scan = self.scan;
        let key = match self.arr {
            Arr::Radarr => "/radarr",
            Arr::Sonarr => "/sonarr",
        };
        let all = scan
            .job
            .settings
            .get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        self.servers = unique_servers(&all);
        scan.set_list(&self.servers);
        let name = self.arr.name();
        let mut results = Vec::new();
        for server in self.servers.clone() {
            scan.set_current(&server);
            self.current = server.clone();
            let server_name = js_string(server.get("name"));
            if !js_truthy(server.get("syncEnabled")) {
                scan.debug(&format!(
                    "Sync not enabled. Skipping {name} server: {server_name}"
                ));
                results.push((false, false));
                continue;
            }
            scan.info(&format!(
                "Beginning to process {name} server: {server_name}"
            ));
            let (path, what) = match self.arr {
                Arr::Radarr => ("/movie", "[Radarr] Failed to retrieve movies"),
                Arr::Sonarr => ("/series", "[Sonarr] Failed to retrieve series"),
            };
            let items = self.call(&server, path, &[]).await.context(what)?;
            scan.set_total(i64::try_from(items.len()).unwrap_or(i64::MAX));
            results.push((true, items.is_empty()));
            if items.is_empty() {
                let noun = match self.arr {
                    Arr::Radarr => "movies",
                    Arr::Sonarr => "series",
                };
                scan.warn(&format!("{name} server {server_name} returned no {noun}. Orphan cleanup for this profile type will be skipped."));
            }
            let this = &*self;
            scan.bundles(&items, BUNDLE, |item| async move {
                match this.arr {
                    Arr::Radarr => this.process_movie(&item).await,
                    Arr::Sonarr => this.process_series(&item).await,
                }
            })
            .await?;
        }
        let flags = cleanup_flags(&self.servers, self.enable4k(), &results);
        self.cleanup(flags).await?;
        scan.info(&format!("{name} scan complete"));
        Ok(())
    }

    fn mark_scanned(&self, id: i64) {
        let set = if self.server_4k(&self.current) {
            &self.scanned_4k
        } else {
            &self.scanned
        };
        lock(set).insert(id);
    }

    fn service_opts(&self, item: &Value) -> (Option<i64>, Option<i64>, Option<String>) {
        (
            self.current.get("id").and_then(Value::as_i64),
            item.get("id").and_then(Value::as_i64),
            str_of(item, "titleSlug").map(str::to_owned),
        )
    }

    /// `processRadarrMovie(movie)`.
    async fn process_movie(&self, movie: &Value) {
        let tmdb_id = movie.get("tmdbId").and_then(Value::as_i64);
        if let Some(id) = tmdb_id {
            self.mark_scanned(id);
        }
        let title = js_string(movie.get("title")).into_owned();
        let result = async {
            let tmdb_id = tmdb_id.ok_or_else(|| anyhow!("a movie without a TMDB id"))?;
            let has_file = movie.get("hasFile").is_none_or(|v| js_truthy(Some(v)));
            let processing = !has_file && js_truthy(movie.get("monitored"));
            let (service_id, external_service_id, external_service_slug) = self.service_opts(movie);
            let o = MovieOpts {
                is4k: self.server_4k(&self.current),
                service_id,
                external_service_id,
                external_service_slug,
                processing,
                has_file,
                ..MovieOpts::new(&title)
            };
            self.scan.process_movie(tmdb_id, &o).await
        };
        if let Err(e) = result.await {
            tracing::error!(
                label = self.scan.kind.label,
                errorMessage = %format!("{e:#}"),
                title = %title,
                "Failed to process Radarr media"
            );
        }
    }

    /// `processSonarrSeries(series)`.
    async fn process_series(&self, series: &Value) {
        let tvdb_id = series.get("tvdbId").and_then(Value::as_i64);
        if let Some(id) = tvdb_id {
            self.mark_scanned(id);
        }
        if let Err(e) = Box::pin(self.try_series(series, tvdb_id)).await {
            tracing::error!(
                label = self.scan.kind.label,
                errorMessage = %format!("{e:#}"),
                title = %js_string(series.get("title")),
                "Failed to process Sonarr media"
            );
        }
    }

    async fn try_series(&self, series: &Value, tvdb_known: Option<i64>) -> Result<()> {
        let job = self.scan.job;
        let tvdb = tvdb_known.ok_or_else(|| anyhow!("a series without a TVDB id"))?;
        crate::episodeorder::track_order(&self.current, series);
        let known = job
            .state
            .db
            .rows(
                r#"SELECT CAST("tmdbId" AS BIGINT) AS "tmdbId" FROM "media" WHERE "tvdbId" = ?1 LIMIT 1"#,
                &[Bind::Int(tvdb)],
            )
            .await?;
        let known = known
            .first()
            .and_then(|r| r.get("tmdbId"))
            .and_then(Value::as_i64)
            .filter(|id| *id != 0);
        let show = match show_tmdb_id(known, series) {
            Some(id) if known.is_some() => tv_for_scan(job, id).await?,
            // Sonarr's id saves TMDB's find by TVDB id, which stays the
            // fallback should TMDB not know it.
            Some(id) => match tv_for_scan(job, id).await {
                Ok(show) => show,
                Err(e) => {
                    tracing::debug!(
                        label = self.scan.kind.label,
                        errorMessage = %format!("{e:#}"),
                        "TMDB doesn't know Sonarr's TMDB ID {id} of TVDB ID {tvdb}; finding the show by TVDB ID"
                    );
                    show_by_tvdb(job, tvdb).await?
                }
            },
            None => show_by_tvdb(job, tvdb).await?,
        };
        let tmdb_id = show
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| anyhow!("TMDB answered without an id"))?;
        let show = provider_show(job, show).await?;
        let settings = job.current_settings().await?;
        let specials = js_truthy(settings.get("/main/enableSpecialEpisodes"));
        let four_k = self.server_4k(&self.current);
        let aired;
        let sonarr = if crate::episodeorder::other_order(series).is_some() {
            aired = self.aired_seasons(series, tvdb).await?;
            aired.as_slice()
        } else {
            array_of(series, "seasons")
        };
        let seasons = sonarr_seasons(&seasons_of(&show, specials), sonarr, four_k);
        let (service_id, external_service_id, external_service_slug) = self.service_opts(series);
        let o = ShowOpts {
            service_id,
            external_service_id,
            external_service_slug,
            title: js_string(series.get("title")).into_owned(),
            is4k: four_k,
            ..ShowOpts::default()
        };
        self.scan
            .process_show(tmdb_id, Some(tvdb), &seasons, &o)
            .await
    }

    /// The seasons of a series Sonarr numbers in another order than the
    /// aired one, counted per aired season: Sonarr's own season N holds
    /// other episodes than the aired season N the provider lists.
    async fn aired_seasons(&self, series: &Value, tvdb: i64) -> Result<Vec<Value>> {
        let id = js_string(series.get("id")).into_owned();
        let episodes = self
            .call(&self.current, "/episode", &[("seriesId", id)])
            .await
            .context("[Sonarr] Failed to retrieve episodes")?;
        let catalog = crate::episodeorder::aired_catalog(&self.scan.job.state.outbound, tvdb)
            .await
            .context("[TVDB] Failed to load the aired episode order")?;
        Ok(crate::episodeorder::aired_seasons(&catalog, &episodes))
    }

    /// `existsInAnyServer(id, is4k)`.
    async fn exists_in_any_server(&self, id: i64, four_k: bool) -> bool {
        let (path, key, noun) = match self.arr {
            Arr::Radarr => ("/movie", "tmdbId", "movie"),
            Arr::Sonarr => ("/series", "tvdbId", "series"),
        };
        for server in self
            .servers
            .iter()
            .filter(|s| js_truthy(s.get("syncEnabled")) && self.server_4k(s) == four_k)
        {
            match self.call(server, path, &[(key, id.to_string())]).await {
                Ok(items) => {
                    if items
                        .iter()
                        .any(|i| i.get(key).and_then(Value::as_i64) == Some(id))
                    {
                        return true;
                    }
                }
                Err(e) => {
                    tracing::warn!(
                        label = self.scan.kind.label,
                        errorMessage = %format!("{e:#}"),
                        "Could not confirm {noun} {id} against {} server {}. Skipping cleanup for it.",
                        self.arr.name(),
                        js_string(server.get("name"))
                    );
                    return true;
                }
            }
        }
        false
    }

    /// The titles of this scanner's type still processing in one quality.
    async fn processing_media(&self, four_k: bool) -> Result<Vec<MediaRow>> {
        let db = &self.scan.job.state.db;
        let media_type = match self.arr {
            Arr::Radarr => "movie",
            Arr::Sonarr => "tv",
        };
        let column = if four_k { "status4k" } else { "status" };
        let rows = db
            .rows(
                &format!(
                    r#"SELECT CAST("id" AS BIGINT) AS "id" FROM "media" WHERE "mediaType" = ?1 AND "{column}" = ?2 ORDER BY "id" ASC"#
                ),
                &[Bind::Text(media_type.to_owned()), Bind::Int(PROCESSING)],
            )
            .await?;
        let ids: Vec<i64> = rows
            .iter()
            .filter_map(|r| r.get("id").and_then(Value::as_i64))
            .collect();
        db.media_by_ids(&ids, true).await
    }

    /// `cleanupOrphanedMovies` / `cleanupOrphanedShows`.
    async fn cleanup(&self, flags: Cleanup) -> Result<()> {
        let (noun, title_kind) = match self.arr {
            Arr::Radarr => ("movie", "Movie"),
            Arr::Sonarr => ("show", "Show"),
        };
        for four_k in [false, true] {
            let enabled = if four_k { flags.uhd } else { flags.standard };
            if !enabled {
                if !four_k {
                    self.scan.info(&format!(
                        "Skipping orphaned {noun} cleanup: no standard {} servers were scanned.",
                        self.arr.name()
                    ));
                } else if self.enable4k() {
                    self.scan.info(&format!(
                        "Skipping orphaned 4K {noun} cleanup: no 4K {} servers were scanned.",
                        self.arr.name()
                    ));
                }
                continue;
            }
            for media in self.processing_media(four_k).await? {
                self.cleanup_one(media, four_k, title_kind).await?;
            }
        }
        Ok(())
    }

    async fn cleanup_one(&self, media: MediaRow, four_k: bool, title_kind: &str) -> Result<()> {
        let set = if four_k {
            &self.scanned_4k
        } else {
            &self.scanned
        };
        let id = match self.arr {
            Arr::Radarr => Some(media.tmdb_id),
            Arr::Sonarr => media.tvdb_id.filter(|t| *t != 0),
        };
        let Some(id) = id else {
            return Ok(());
        };
        if lock(set).contains(&id) || self.exists_in_any_server(id, four_k).await {
            return Ok(());
        }
        let requests = self.scan.approved_requests(media.id, four_k).await?;
        let after = orphaned(&media, four_k);
        super::scanmedia::save_existing(self.scan, media.clone(), after.clone(), Vec::new())
            .await?;
        self.scan.decline_orphaned(&after, &requests).await?;
        let server = if four_k {
            format!("4K {}", self.arr.name())
        } else {
            self.arr.name().to_owned()
        };
        let reset = if four_k { "4K status" } else { "Status" };
        let label = match self.arr {
            Arr::Radarr => format!("{title_kind} {}", media.tmdb_id),
            Arr::Sonarr => format!("{title_kind} {} (tvdb: {id})", media.tmdb_id),
        };
        self.scan.info(&format!(
            "{label} not found in any {server} server. {reset} reset to UNKNOWN."
        ));
        Ok(())
    }
}

/// An orphaned title reset: the quality's status, and its processing
/// seasons, back to unknown.
fn orphaned(media: &MediaRow, four_k: bool) -> MediaRow {
    let mut after = media.clone();
    if four_k {
        after.status4k = UNKNOWN;
    } else {
        after.status = UNKNOWN;
    }
    for season in &mut after.seasons {
        let status = if four_k {
            &mut season.status4k
        } else {
            &mut season.status
        };
        if *status == PROCESSING {
            *status = UNKNOWN;
        }
    }
    after
}

/// The TMDB show a Sonarr series is: the one a title with its TVDB id
/// already has, else the `tmdbId` Sonarr knows it by; `None` leaves it to
/// TMDB's find by TVDB id.
fn show_tmdb_id(known: Option<i64>, series: &Value) -> Option<i64> {
    known.or_else(|| {
        series
            .get("tmdbId")
            .and_then(Value::as_i64)
            .filter(|id| *id > 0)
    })
}

/// The seasons `processSonarrSeries` builds from the provider's seasons and
/// Sonarr's (seasons Sonarr doesn't list count as unmonitored and empty).
fn sonarr_seasons(
    provider: &[(i64, i64)],
    sonarr: &[Value],
    four_k: bool,
) -> Vec<ProcessableSeason> {
    provider
        .iter()
        .map(|&(number, episode_count)| {
            let found = sonarr
                .iter()
                .find(|s| s.get("seasonNumber").and_then(Value::as_i64) == Some(number));
            let (monitored, files, total) = found.map_or((false, 0, episode_count), |s| {
                let stats = s.get("statistics");
                let n = |key: &str| {
                    stats
                        .and_then(|st| st.get(key))
                        .and_then(Value::as_i64)
                        .unwrap_or(0)
                };
                (
                    js_truthy(s.get("monitored")),
                    n("episodeFileCount"),
                    n("totalEpisodeCount"),
                )
            });
            ProcessableSeason {
                season_number: number,
                total_episodes: total,
                episodes: if four_k { 0 } else { files },
                episodes4k: if four_k { files } else { 0 },
                is4k_override: four_k,
                processing: monitored && files == 0,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::SeasonRow;
    use serde_json::json;

    #[test]
    fn cleanup_needs_every_server() {
        let servers = [
            json!({ "is4k": false, "syncEnabled": true }),
            json!({ "is4k": false, "syncEnabled": false }),
        ];
        assert_eq!(
            cleanup_flags(&servers, false, &[(true, false), (false, false)]),
            Cleanup::default(),
            "a standard server with sync disabled skips cleanup"
        );
        let servers = [
            json!({ "is4k": false, "syncEnabled": true }),
            json!({ "is4k": true, "syncEnabled": true }),
        ];
        assert_eq!(
            cleanup_flags(&servers, true, &[(true, false), (true, false)]),
            Cleanup {
                standard: true,
                uhd: true
            },
            "both qualities"
        );
        assert_eq!(
            cleanup_flags(&servers, true, &[(true, true), (true, false)]),
            Cleanup {
                standard: false,
                uhd: true
            },
            "an empty list skips its quality"
        );
        assert_eq!(
            cleanup_flags(&servers, false, &[(true, false), (true, false)]),
            Cleanup {
                standard: true,
                uhd: false
            },
            "without 4K detection every server is standard"
        );
    }

    #[test]
    fn unique_and_orphaned() {
        let servers = [
            json!({ "hostname": "a", "port": 1, "id": 0 }),
            json!({ "hostname": "a", "port": 1, "id": 1 }),
            json!({ "hostname": "a", "port": 2, "id": 2 }),
        ];
        assert_eq!(unique_servers(&servers).len(), 2, "same host and port");
        let media = MediaRow {
            status: PROCESSING,
            status4k: PROCESSING,
            seasons: vec![
                SeasonRow {
                    season_number: 1,
                    status: PROCESSING,
                    status4k: PROCESSING,
                    ..SeasonRow::default()
                },
                SeasonRow {
                    season_number: 2,
                    status: 5,
                    status4k: PROCESSING,
                    ..SeasonRow::default()
                },
            ],
            ..MediaRow::default()
        };
        let after = orphaned(&media, false);
        assert_eq!(
            (after.status, after.status4k),
            (UNKNOWN, PROCESSING),
            "only standard"
        );
        assert_eq!(
            after.seasons.iter().map(|s| s.status).collect::<Vec<_>>(),
            vec![UNKNOWN, 5],
            "only processing seasons reset"
        );
    }

    #[test]
    fn tmdb_id_from_sonarr() {
        let series = json!({ "tvdbId": 81797, "tmdbId": 37854 });
        assert_eq!(
            show_tmdb_id(None, &series),
            Some(37854),
            "Sonarr's id, no TMDB find"
        );
        assert_eq!(
            show_tmdb_id(Some(1), &series),
            Some(1),
            "the title's own id first"
        );
        assert_eq!(
            show_tmdb_id(None, &json!({ "tmdbId": 0 })),
            None,
            "0 is none"
        );
        assert_eq!(
            show_tmdb_id(None, &json!({ "tvdbId": 1 })),
            None,
            "an older Sonarr"
        );
    }

    #[test]
    fn aired_season_counts_for_another_order() {
        use crate::jobs::episode_request_sync::CatalogEpisode;
        let ep = |tvdb_id: i64, season: i64, episode: i64| CatalogEpisode {
            tvdb_id,
            season,
            episode,
            title: String::new(),
            air_date: None,
        };
        // Aired: S1 = 11, 12; S2 = 21, 22. DVD order: one season of all four,
        // where Sonarr's season 2 would be an unrelated, empty one.
        let catalog = [ep(11, 1, 1), ep(12, 1, 2), ep(21, 2, 1), ep(22, 2, 2)];
        let dvd = [
            json!({"id": 1, "tvdbId": 12, "seasonNumber": 1, "episodeNumber": 1, "hasFile": true, "monitored": true}),
            json!({"id": 2, "tvdbId": 11, "seasonNumber": 1, "episodeNumber": 2, "hasFile": true, "monitored": true}),
            json!({"id": 3, "tvdbId": 21, "seasonNumber": 1, "episodeNumber": 3, "hasFile": false, "monitored": true}),
            json!({"id": 4, "tvdbId": 22, "seasonNumber": 1, "episodeNumber": 4, "hasFile": false, "monitored": true}),
        ];
        let aired = crate::episodeorder::aired_seasons(&catalog, &dvd);
        let seasons = sonarr_seasons(&[(1, 2), (2, 2)], &aired, false);
        assert_eq!(
            seasons,
            vec![
                ProcessableSeason {
                    season_number: 1,
                    total_episodes: 2,
                    episodes: 2,
                    ..ProcessableSeason::default()
                },
                ProcessableSeason {
                    season_number: 2,
                    total_episodes: 2,
                    processing: true,
                    ..ProcessableSeason::default()
                }
            ],
            "aired season 1 is downloaded, season 2 is wanted"
        );
    }

    #[test]
    fn sonarr_season_counts() {
        let sonarr = [json!({
            "seasonNumber": 1,
            "monitored": true,
            "statistics": { "episodeFileCount": 0, "totalEpisodeCount": 8 }
        })];
        let seasons = sonarr_seasons(&[(1, 10), (2, 6)], &sonarr, false);
        assert_eq!(
            seasons,
            vec![
                ProcessableSeason {
                    season_number: 1,
                    total_episodes: 8,
                    processing: true,
                    ..ProcessableSeason::default()
                },
                ProcessableSeason {
                    season_number: 2,
                    total_episodes: 6,
                    ..ProcessableSeason::default()
                }
            ],
            "Sonarr's totals, missing seasons unmonitored"
        );
    }
}
