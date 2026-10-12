//! The Jellyfin and Emby scanners (`server/lib/scanners/jellyfin`).
//!
//! `jellyfin-full-scan` reads every enabled library, the recently-added
//! scan the newest hundred titles of each. Calls are `JellyfinAPI`'s: the
//! server API key with the admin's device id, the admin's user id, no
//! timeout.

use std::collections::HashMap;
use std::sync::Mutex;

use anyhow::{anyhow, Result};
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde_json::Value;

use super::scanbase::{
    anime_from_anidb, anime_sync, array_of, js_id, js_truthy, parse_date, str_of, uniq_with, Kind,
    Scan, BUNDLE_SIZE,
};
use super::scanmedia::{MovieOpts, ProcessableSeason, ShowOpts};
use super::scantmdb::{resolve_imdb, seasons_of, show_by_tvdb, tv_show};
use super::JobCtx;
use crate::db::Bind;
use crate::jellyfin::{axios_url, hostname, BROWSE_ITEM_FIELDS};
use crate::media::js_string;

/// `jellyfinFullScanner`.
pub static FULL: Kind = Kind::library("jellyfin-full-scan", "Jellyfin Sync");
/// `jellyfinRecentScanner`.
pub static RECENT: Kind = Kind::library("jellyfin-recently-added-scan", "Jellyfin Sync");

/// `MediaServerType.JELLYFIN`.
const JELLYFIN: i64 = 2;
/// `MediaServerType.EMBY`.
const EMBY: i64 = 3;

/// `jellyfinFullScanner.run()` (job `jellyfin-full-scan`).
///
/// # Errors
///
/// None: like Node's, a failed scan is logged.
pub async fn run_full(job: &JobCtx) -> Result<()> {
    Box::pin(run(job, &FULL, false)).await;
    Ok(())
}

/// `jellyfinRecentScanner.run()` (job `jellyfin-recently-added-scan`).
///
/// # Errors
///
/// None: like Node's, a failed scan is logged.
pub async fn run_recent(job: &JobCtx) -> Result<()> {
    Box::pin(run(job, &RECENT, true)).await;
    Ok(())
}

async fn run(job: &JobCtx, kind: &'static Kind, recent: bool) {
    let server = job
        .settings
        .get("/main/mediaServerType")
        .and_then(Value::as_i64);
    if !matches!(server, Some(JELLYFIN | EMBY)) {
        return;
    }
    let scan = Scan::start(job, kind);
    if let Err(e) = Box::pin(scan_libraries(&scan, recent)).await {
        scan.error("Sync interrupted", &e);
    }
    scan.end();
}

/// `buildJellyfinAuthorizationHeader(apiKey, deviceId)`.
fn authorization(job: &JobCtx, token: Option<&str>, device_id: Option<&str>) -> String {
    use base64::Engine as _;
    let device = device_id.filter(|d| !d.is_empty()).map_or_else(
        || base64::engine::general_purpose::STANDARD.encode("BOT_seerr"),
        str::to_owned,
    );
    let version = if job
        .settings
        .get("/main/mediaServerType")
        .and_then(Value::as_i64)
        == Some(EMBY)
    {
        String::from("1.0.0")
    } else {
        job.state.version.version.clone()
    };
    let mut header = format!(
        r#"MediaBrowser Client="Foreseerr", Device="Foreseerr", DeviceId="{device}", Version="{version}""#
    );
    if let Some(token) = token.filter(|t| !t.is_empty()) {
        header.push_str(", Token=\"");
        header.push_str(token);
        header.push('"');
    }
    header
}

/// The `JellyfinAPI` client of a run.
struct JfClient {
    http: reqwest::Client,
    base: String,
    auth: String,
    user_id: String,
    emby: bool,
}

impl JfClient {
    async fn get(&self, path: &str, params: &[(&str, String)]) -> Result<Value> {
        let url = axios_url(&self.base, path, params);
        let value: Value = self
            .http
            .get(&url)
            .header(AUTHORIZATION, &self.auth)
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, "application/json")
            .send()
            .await
            .map_err(|e| anyhow!("{e}"))?
            .error_for_status()
            .map_err(anyhow::Error::new)?
            .json()
            .await
            .map_err(|e| anyhow!("{e}"))?;
        Ok(value)
    }

    /// `getLibraryContents(id)`.
    async fn library_contents(&self, id: &str) -> Result<Vec<Value>> {
        let body = self
            .get(
                &format!("/Items?SortBy=SortName&SortOrder=Ascending&IncludeItemTypes=Series,Movie,Others&Recursive=true&StartIndex=0&ParentId={id}&collapseBoxSetItems=false"),
                &[],
            )
            .await?;
        let items = body
            .get("Items")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("filter is missing"))?;
        Ok(not_virtual(items))
    }

    /// `getRecentlyAdded(id)`.
    async fn recently_added(&self, id: &str) -> Result<Vec<Value>> {
        if !self.emby {
            let body = self
                .get(
                    "/Items",
                    &[
                        ("userId", self.user_id.clone()),
                        ("ParentId", id.to_owned()),
                        ("IncludeItemTypes", String::from("Movie,Series")),
                        ("Recursive", String::from("true")),
                        ("SortBy", String::from("DateCreated")),
                        ("SortOrder", String::from("Descending")),
                        ("Limit", String::from("100")),
                        ("Fields", String::from("ProviderIds,DateCreated")),
                    ],
                )
                .await?;
            return Ok(array_of(&body, "Items").to_vec());
        }
        let body = self
            .get(
                &format!(
                    "/Users/{}/Items/Latest?Limit=100&ParentId={id}",
                    self.user_id
                ),
                &[],
            )
            .await?;
        Ok(body.as_array().cloned().unwrap_or_default())
    }

    /// `getItemData(id)`.
    async fn item_data(&self, id: &str) -> Result<Option<Value>> {
        if id.is_empty() {
            return Ok(None);
        }
        let body = self
            .get(
                "/Items",
                &[
                    ("ids", id.to_owned()),
                    ("userId", self.user_id.clone()),
                    ("EnableUserData", String::from("true")),
                    (
                        "fields",
                        format!("{BROWSE_ITEM_FIELDS},MediaSources,Width,Height,IsHD"),
                    ),
                ],
            )
            .await;
        // `getItemsData` answers `[]` to a 500 while the availability sync
        // runs.
        let body = match body {
            Ok(body) => body,
            Err(e)
                if crate::jobs::syncutil::http_status(&e) == Some(500)
                    && crate::jobs::availability_sync::running() =>
            {
                return Ok(None);
            }
            Err(e) => return Err(e),
        };
        Ok(array_of(&body, "Items").first().cloned())
    }

    /// `getSeasons(seriesId)`.
    async fn seasons(&self, series_id: &str) -> Result<Vec<Value>> {
        let body = self
            .get(
                &format!("/Shows/{series_id}/Seasons"),
                &[
                    ("userId", self.user_id.clone()),
                    ("EnableUserData", String::from("true")),
                    ("Fields", String::from("ProviderIds,Overview")),
                ],
            )
            .await?;
        Ok(array_of(&body, "Items").to_vec())
    }

    /// `getEpisodes(seriesId, seasonId, { includeMediaInfo })`.
    async fn episodes(
        &self,
        series_id: &str,
        season_id: &str,
        media_info: bool,
    ) -> Result<Vec<Value>> {
        let body = self
            .get(
                &format!("/Shows/{series_id}/Episodes"),
                &[
                    ("seasonId", season_id.to_owned()),
                    ("userId", self.user_id.clone()),
                    ("EnableUserData", String::from("true")),
                    (
                        "Fields",
                        String::from(if media_info {
                            "MediaSources,ProviderIds,Overview"
                        } else {
                            "ProviderIds,Overview"
                        }),
                    ),
                ],
            )
            .await?;
        let items = body
            .get("Items")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("filter is missing"))?;
        Ok(not_virtual(items))
    }
}

/// `processedAnidbSeason`: add a season's episodes to what other entries
/// of the show brought; the running total.
fn remember_anidb(
    seen: &Mutex<HashMap<i64, HashMap<i64, i64>>>,
    show_id: i64,
    season: i64,
    episodes: i64,
) -> i64 {
    let mut seen = crate::sync::lock(seen);
    let counts = seen.entry(show_id).or_default();
    let total = counts.get(&season).copied().unwrap_or(0) + episodes;
    counts.insert(season, total);
    drop(seen);
    total
}

fn not_virtual(items: &[Value]) -> Vec<Value> {
    items
        .iter()
        .filter(|i| str_of(i, "LocationType") != Some("Virtual"))
        .cloned()
        .collect()
}

/// Whether a video stream of some media source is wider than 2000 pixels
/// (`wide`) or not; `None` without `MediaSources`.
fn video_width(item: &Value, wide: bool) -> Option<bool> {
    let sources = item.get("MediaSources")?.as_array()?;
    Some(sources.iter().any(|source| {
        array_of(source, "MediaStreams")
            .iter()
            .filter(|s| str_of(s, "Type") == Some("Video"))
            .any(|s| {
                let width = s.get("Width").and_then(Value::as_f64).unwrap_or(0.0);
                (width > 2000.0) == wide
            })
    }))
}

/// How many episodes an item stands for (`IndexNumberEnd - IndexNumber + 1`
/// for combined episodes).
fn episode_count(episode: &Value) -> i64 {
    match (episode.get("IndexNumber"), episode.get("IndexNumberEnd")) {
        (Some(start), Some(end)) => {
            let n = |v: &Value| v.as_i64().unwrap_or(0);
            n(end) - n(start) + 1
        }
        _ => 1,
    }
}

fn provider<'v>(item: &'v Value, key: &str) -> Option<&'v Value> {
    item.get("ProviderIds").and_then(|p| p.get(key))
}

/// `Id` of an item as a string.
fn id_of(item: &Value) -> String {
    js_string(item.get("Id")).into_owned()
}

/// One run's scanner with its client.
struct Jellyfin<'s> {
    scan: &'s Scan<'s>,
    client: JfClient,
    /// `processedAnidbSeason`: per show, per season, the episodes seen.
    anidb_seasons: Mutex<HashMap<i64, HashMap<i64, i64>>>,
}

async fn scan_libraries(scan: &Scan<'_>, recent: bool) -> Result<()> {
    let job = scan.job;
    let rows = job
        .state
        .db
        .rows(
            r#"SELECT "id", "jellyfinUserId", "jellyfinDeviceId" FROM "user" WHERE "id" = ?1 ORDER BY "id" ASC LIMIT 1"#,
            &[Bind::Int(1)],
        )
        .await?;
    let Some(admin) = rows.first() else {
        scan.warn("No admin configured. Jellyfin sync skipped.");
        return Ok(());
    };
    let client = JfClient {
        http: job.state.outbound.clone(),
        base: hostname(&job.settings),
        auth: authorization(
            job,
            job.settings.get("/jellyfin/apiKey").and_then(Value::as_str),
            admin.get("jellyfinDeviceId").and_then(Value::as_str),
        ),
        user_id: admin
            .get("jellyfinUserId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        emby: job
            .settings
            .get("/main/mediaServerType")
            .and_then(Value::as_i64)
            != Some(JELLYFIN),
    };
    let libraries: Vec<Value> = job
        .settings
        .get("/jellyfin/libraries")
        .and_then(Value::as_array)
        .map(|all| {
            all.iter()
                .filter(|l| js_truthy(l.get("enabled")))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    scan.set_list(&libraries);
    anime_sync(job).await?;
    let jf = Jellyfin {
        scan,
        client,
        anidb_seasons: Mutex::new(HashMap::new()),
    };
    for library in &libraries {
        scan.set_current(library);
        crate::sync::lock(&jf.anidb_seasons).clear();
        let name = js_string(library.get("name"));
        let id = js_string(library.get("id"));
        let items = if recent {
            scan.info(&format!(
                "Beginning to process recently added for library: {name}"
            ));
            let items = jf.client.recently_added(&id).await?;
            uniq_with(&items, same_group)
        } else {
            scan.info(&format!("Beginning to process library: {name}"));
            jf.client.library_contents(&id).await?
        };
        scan.set_total(i64::try_from(items.len()).unwrap_or(i64::MAX));
        scan.bundles(&items, BUNDLE_SIZE, |item| jf.process_item(item))
            .await?;
    }
    scan.info(if recent {
        "Recently Added Scan Complete"
    } else {
        "Full Scan Complete"
    });
    Ok(())
}

/// The recently-added grouping: same series, same season, or same item.
fn same_group(a: &Value, b: &Value) -> bool {
    for key in ["SeriesId", "SeasonId"] {
        if js_truthy(a.get(key)) && js_truthy(b.get(key)) {
            return a.get(key) == b.get(key);
        }
    }
    a.get("Id") == b.get("Id")
}

/// What `extractMovieIds` found.
struct MovieIds {
    tmdb_id: i64,
    imdb_id: Option<String>,
    metadata: Value,
}

impl Jellyfin<'_> {
    async fn process_item(&self, item: Value) {
        match str_of(&item, "Type") {
            Some("Movie") => self.process_movie(&item).await,
            Some("Series") => self.process_show(&item).await,
            _ => {}
        }
    }

    fn debug_item(&self, message: &str, item: &Value) {
        tracing::debug!(label = self.scan.kind.label, jellyfinitem = %item, "{message}");
    }

    /// `extractMovieIds(item)`.
    async fn movie_ids(&self, item: &Value) -> Result<Option<MovieIds>> {
        let job = self.scan.job;
        let item_id = id_of(item);
        let metadata = self.client.item_data(&item_id).await?;
        let Some(mut metadata) = metadata.filter(|m| js_truthy(m.get("Id"))) else {
            tracing::debug!(
                label = self.scan.kind.label,
                jellyfinItemId = %item_id,
                "No Id metadata for this title. Skipping"
            );
            return Ok(None);
        };
        if metadata.get("ProviderIds").is_none_or(Value::is_null) {
            return Err(anyhow!("AniDB is missing"));
        }
        let anidb_id = js_id(provider(&metadata, "AniDB"));
        let mut tmdb_id = [
            provider(&metadata, "Tmdb"),
            provider(&metadata, "TheMovieDb"),
        ]
        .into_iter()
        .find(|v| js_truthy(*v))
        .and_then(js_id);
        let mut imdb_id = provider(&metadata, "Imdb").map(|v| js_string(Some(v)).into_owned());
        let has_imdb = imdb_id.as_deref().is_some_and(|i| !i.is_empty());
        if let (Some(anidb), false, None) = (anidb_id, has_imdb, tmdb_id) {
            let result = anime_from_anidb(job, anidb).await?;
            tmdb_id = result.as_ref().and_then(|r| r.tmdb_id).filter(|t| *t != 0);
            imdb_id = result.and_then(|r| r.imdb_id);
        }
        if let (Some(imdb), None) = (imdb_id.as_ref().filter(|i| !i.is_empty()), tmdb_id) {
            tmdb_id = Some(resolve_imdb(job, imdb).await?);
        }
        let tmdb_id = tmdb_id.ok_or_else(|| anyhow!("Unable to find TMDb ID"))?;
        if anidb_id.is_some() && str_of(&metadata, "Type") == Some("Series") {
            let seasons = self.client.seasons(&item_id).await?;
            let Some(season) = seasons
                .iter()
                .find(|s| s.get("IndexNumber").and_then(Value::as_i64) == Some(1))
            else {
                self.debug_item("No season found for anidb movie", item);
                return Ok(None);
            };
            let episodes = self
                .client
                .episodes(&item_id, &id_of(season), false)
                .await?;
            let Some(first) = episodes.first() else {
                self.debug_item("No episode found for anidb movie", item);
                return Ok(None);
            };
            let Some(episode) = self.client.item_data(&id_of(first)).await? else {
                self.debug_item("No metadata found for anidb movie", item);
                return Ok(None);
            };
            metadata = episode;
        }
        Ok(Some(MovieIds {
            tmdb_id,
            imdb_id,
            metadata,
        }))
    }

    /// `processJellyfinMovie(item)`.
    async fn process_movie(&self, item: &Value) {
        if let Err(e) = self.try_movie(item).await {
            tracing::error!(
                label = self.scan.kind.label,
                errorMessage = %format!("{e:#}"),
                jellyfinitem = %item,
                "Failed to process Jellyfin item, id: {}",
                id_of(item)
            );
        }
    }

    async fn try_movie(&self, item: &Value) -> Result<()> {
        let Some(ids) = self.movie_ids(item).await? else {
            return Ok(());
        };
        let metadata = &ids.metadata;
        let four_k = video_width(metadata, true) == Some(true);
        let other = video_width(metadata, false) == Some(true);
        let enable4k = self.scan.enable4k_movie;
        let base = MovieOpts {
            media_added_at: str_of(metadata, "DateCreated")
                .filter(|d| !d.is_empty())
                .and_then(parse_date),
            jellyfin_media_id: Some(id_of(metadata)),
            imdb_id: ids.imdb_id.clone(),
            ..MovieOpts::new(&js_string(metadata.get("Name")))
        };
        if other || (!enable4k && four_k) {
            self.scan.process_movie(ids.tmdb_id, &base).await?;
        }
        if four_k && enable4k {
            let o = MovieOpts { is4k: true, ..base };
            self.scan.process_movie(ids.tmdb_id, &o).await?;
        }
        Ok(())
    }

    /// `processJellyfinShow(item)`.
    async fn process_show(&self, item: &Value) {
        if let Err(e) = self.try_show(item).await {
            let id = ["SeriesId", "SeasonId", "Id"]
                .iter()
                .find_map(|k| item.get(*k).filter(|v| !v.is_null()))
                .map(|v| js_string(Some(v)).into_owned())
                .unwrap_or_default();
            tracing::error!(
                label = self.scan.kind.label,
                errorMessage = %format!("{e:#}"),
                jellyfinitem = %item,
                "Failed to process Jellyfin item. Id: {id}"
            );
        }
    }

    async fn try_show(&self, item: &Value) -> Result<()> {
        let job = self.scan.job;
        let id = ["SeriesId", "SeasonId", "Id"]
            .iter()
            .find_map(|k| item.get(*k).filter(|v| !v.is_null()))
            .map(|v| js_string(Some(v)).into_owned())
            .unwrap_or_default();
        let metadata = self.client.item_data(&id).await?;
        let Some(metadata) = metadata.filter(|m| js_truthy(m.get("Id"))) else {
            tracing::debug!(
                label = self.scan.kind.label,
                jellyfinItemId = %id_of(item),
                "No Id metadata for this title. Skipping"
            );
            return Ok(());
        };
        if metadata.get("ProviderIds").is_none_or(Value::is_null) {
            return Err(anyhow!("Tmdb is missing"));
        }
        let mut show = None;
        let tmdb = [
            provider(&metadata, "Tmdb"),
            provider(&metadata, "TheMovieDb"),
        ]
        .into_iter()
        .find(|v| js_truthy(*v))
        .flatten();
        if let Some(tmdb) = tmdb {
            match tv_show(job, js_id(Some(tmdb)), None).await {
                Ok(found) => show = Some(found),
                Err(_) => self.debug_item("Unable to find TMDb ID for this title.", item),
            }
        }
        if show.is_none() && js_truthy(provider(&metadata, "Tvdb")) {
            match tv_show(job, None, js_id(provider(&metadata, "Tvdb"))).await {
                Ok(found) => show = Some(found),
                Err(_) => self.debug_item("Unable to find TVDb ID for this title.", item),
            }
        }
        let mut anidb_season = None;
        if show.is_none() && js_truthy(provider(&metadata, "AniDB")) {
            let anidb = js_id(provider(&metadata, "AniDB")).unwrap_or(0);
            let result = anime_from_anidb(job, anidb).await?.unwrap_or_default();
            anidb_season = result.tvdb_season.filter(|s| *s != 0);
            if let Some(tvdb) = result.tvdb_id.filter(|t| *t != 0) {
                match show_by_tvdb(job, tvdb).await {
                    Ok(found) => show = Some(found),
                    Err(_) => self.debug_item("Unable to find AniDB ID for this title.", item),
                }
            } else if result.imdb_id.is_some_and(|i| !i.is_empty())
                || result.tmdb_id.is_some_and(|t| t != 0)
            {
                self.process_movie(item).await;
                return Ok(());
            }
        }
        let Some(show) = show else {
            self.debug_item(
                &format!(
                    "No information found for the show: {}",
                    js_string(metadata.get("Name"))
                ),
                item,
            );
            return Ok(());
        };
        let seasons = self.scan_seasons(&show, &id, anidb_season).await?;
        let o = ShowOpts {
            media_added_at: str_of(&metadata, "DateCreated")
                .filter(|d| !d.is_empty())
                .and_then(parse_date),
            jellyfin_media_id: Some(id),
            title: js_string(show.get("name")).into_owned(),
            ..ShowOpts::default()
        };
        let show_id = show
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| anyhow!("TMDB answered without an id"))?;
        let tvdb_id = show
            .get("external_ids")
            .and_then(|e| e.get("tvdb_id"))
            .and_then(Value::as_i64);
        self.scan.process_show(show_id, tvdb_id, &seasons, &o).await
    }

    /// The seasons of `processJellyfinShow`.
    async fn scan_seasons(
        &self,
        show: &Value,
        series_id: &str,
        anidb_season: Option<i64>,
    ) -> Result<Vec<ProcessableSeason>> {
        let jellyfin_seasons = self.client.seasons(series_id).await?;
        let settings = self.scan.job.current_settings().await?;
        let specials = js_truthy(settings.get("/main/enableSpecialEpisodes"));
        let show_id = show.get("id").and_then(Value::as_i64).unwrap_or(0);
        let mut out = Vec::new();
        for (number, total) in seasons_of(show, specials) {
            let matched = jellyfin_seasons.iter().find(|md| {
                let index = md.get("IndexNumber");
                anidb_season.map_or_else(
                    || js_id(index).unwrap_or(0) == number,
                    |season| season == number && index.and_then(Value::as_i64) == Some(1),
                )
            });
            let Some(matched) = matched else {
                out.push(ProcessableSeason {
                    season_number: number,
                    total_episodes: total,
                    ..ProcessableSeason::default()
                });
                continue;
            };
            let (mut standard, uhd) = self.count_episodes(series_id, &id_of(matched)).await?;
            if anidb_season.is_some() {
                standard = remember_anidb(&self.anidb_seasons, show_id, number, standard);
            }
            out.push(ProcessableSeason {
                season_number: number,
                total_episodes: total,
                episodes: standard,
                episodes4k: uhd,
                ..ProcessableSeason::default()
            });
        }
        Ok(out)
    }

    /// The standard and 4K episodes of a Jellyfin season.
    async fn count_episodes(&self, series_id: &str, season_id: &str) -> Result<(i64, i64)> {
        let enable4k = self.scan.enable4k_show;
        let episodes = self.client.episodes(series_id, season_id, enable4k).await?;
        let mut standard = 0;
        let mut uhd = 0;
        for episode in &episodes {
            let count = episode_count(episode);
            if !enable4k {
                standard += count;
                continue;
            }
            if video_width(episode, false) == Some(true) {
                standard += count;
            }
            if video_width(episode, true) == Some(true) {
                uhd += count;
            }
        }
        Ok((standard, uhd))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn episodes_and_widths() {
        assert_eq!(
            episode_count(&json!({ "IndexNumber": 3, "IndexNumberEnd": 4 })),
            2,
            "combined episode"
        );
        assert_eq!(episode_count(&json!({ "IndexNumber": 3 })), 1, "single");
        let item = json!({ "MediaSources": [{ "MediaStreams": [
            { "Type": "Audio", "Width": 4000 },
            { "Type": "Video", "Width": 3840 }
        ] }] });
        assert_eq!(video_width(&item, true), Some(true), "4K");
        assert_eq!(video_width(&item, false), Some(false), "no HD stream");
        assert_eq!(video_width(&json!({}), true), None, "no sources");
    }

    #[test]
    fn grouping() {
        let a = json!({ "Id": "1", "SeriesId": "s" });
        let b = json!({ "Id": "2", "SeriesId": "s" });
        let c = json!({ "Id": "3" });
        assert_eq!(
            uniq_with(&[a.clone(), b, c.clone()], same_group),
            vec![a, c],
            "series grouped"
        );
    }
}
