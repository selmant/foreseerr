//! The Plex scanners (`server/lib/scanners/plex`).
//!
//! `plex-full-scan` pages
//! through every enabled library, `plex-recently-added-scan` reads what was
//! added since each library's `lastScan` (less ten minutes) and records the
//! new `lastScan`. Plex is called as `PlexAPI` does: JSON, the admin's
//! token and the `X-Plex-*` headers, no timeout.

use anyhow::{anyhow, Context, Result};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, CONTENT_TYPE};
use serde_json::Value;

use super::scanbase::{
    anime_special, anime_sync, array_of, js_truthy, mutate_settings, str_of, uniq_with, AnidbItem,
    Kind, Scan,
};
use super::scanmedia::{MovieOpts, ProcessableSeason, ShowOpts};
use super::scantmdb::{resolve_imdb, seasons_of, show_by_tvdb, tv_for_scan, tv_show, tvdb_show_id};
use super::JobCtx;
use crate::db::Bind;
use crate::media::js_string;

/// `plexFullScanner`.
pub static FULL: Kind = Kind::library("plex-full-scan", "Plex Scan");
/// `plexRecentScanner`.
pub static RECENT: Kind = Kind::library("plex-recently-added-scan", "Plex Scan");

/// The Plex scanners' bundle (and page) size.
const BUNDLE: usize = 50;
const HAMA_AGENT: &str = "com.plexapp.agents.hama";

/// `plexFullScanner.run()` (job `plex-full-scan`).
///
/// # Errors
///
/// None: like Node's, a failed scan is logged.
pub async fn run_full(job: &JobCtx) -> Result<()> {
    Box::pin(run(job, &FULL, false)).await;
    Ok(())
}

/// `plexRecentScanner.run()` (job `plex-recently-added-scan`).
///
/// # Errors
///
/// None: like Node's, a failed scan is logged.
pub async fn run_recent(job: &JobCtx) -> Result<()> {
    Box::pin(run(job, &RECENT, true)).await;
    Ok(())
}

async fn run(job: &JobCtx, kind: &'static Kind, recent: bool) {
    let scan = Scan::start(job, kind);
    match Box::pin(scan_libraries(&scan, recent)).await {
        Ok(()) => {}
        Err(e) => scan.error("Scan interrupted", &e),
    }
    scan.end();
}

/// The `PlexAPI` client of a run.
#[derive(Clone)]
struct PlexClient {
    http: reqwest::Client,
    base: String,
    headers: HeaderMap,
}

impl PlexClient {
    fn new(job: &JobCtx, token: &str) -> Result<Self> {
        let s = &job.settings;
        let scheme = if crate::settings::public::truthy(s.get("/plex/useSsl")) {
            "https"
        } else {
            "http"
        };
        let base = format!(
            "{scheme}://{}:{}",
            js_string(s.get("/plex/ip")),
            js_string(s.get("/plex/port"))
        );
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        let mut put = |name: &'static str, value: &str| -> Result<()> {
            headers.insert(
                HeaderName::from_static(name),
                HeaderValue::from_str(value).context("a Plex header value")?,
            );
            Ok(())
        };
        put("x-plex-token", token)?;
        if let Some(id) = s.get("/clientId").filter(|v| !v.is_null()) {
            put("x-plex-client-identifier", &js_string(Some(id)))?;
        }
        put("x-plex-product", "Foreseerr")?;
        put("x-plex-device-name", "Foreseerr")?;
        put("x-plex-platform", "Foreseerr")?;
        Ok(Self {
            http: job.state.outbound.clone(),
            base,
            headers,
        })
    }

    async fn get(&self, path: &str, container: Option<(usize, usize)>) -> Result<Value> {
        let mut request = self
            .http
            .get(format!("{}{path}", self.base))
            .headers(self.headers.clone());
        if let Some((start, size)) = container {
            request = request
                .header("X-Plex-Container-Start", start.to_string())
                .header("X-Plex-Container-Size", size.to_string());
        }
        let value: Value = request
            .send()
            .await
            .with_context(|| format!("GET {path}"))?
            .error_for_status()
            .with_context(|| format!("GET {path}"))?
            .json()
            .await
            .with_context(|| format!("GET {path}: not JSON"))?;
        Ok(value.get("MediaContainer").cloned().unwrap_or(Value::Null))
    }

    /// `getLibraries()`.
    async fn libraries(&self) -> Result<Vec<Value>> {
        let container = self.get("/library/sections", None).await?;
        container
            .get("Directory")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| anyhow!("some is missing"))
    }

    /// `getLibraryContents(id, { offset, size })`: `(totalSize, items)`.
    async fn library_contents(&self, id: &str, offset: usize) -> Result<(Value, Vec<Value>)> {
        let container = self
            .get(
                &format!("/library/sections/{id}/all?includeGuids=1"),
                Some((offset, BUNDLE)),
            )
            .await?;
        let total = container.get("totalSize").cloned().unwrap_or(Value::Null);
        Ok((total, array_of(&container, "Metadata").to_vec()))
    }

    /// `getMetadata(key, { includeChildren })`.
    async fn metadata(&self, key: &str, children: bool) -> Result<Value> {
        let suffix = if children { "?includeChildren=1" } else { "" };
        let container = self
            .get(&format!("/library/metadata/{key}{suffix}"), None)
            .await?;
        array_of(&container, "Metadata")
            .first()
            .cloned()
            .ok_or_else(|| anyhow!("guid is missing"))
    }

    /// `getChildrenMetadata(key)`; `None` when Plex lists none.
    async fn children(&self, key: &str) -> Result<Option<Vec<Value>>> {
        let container = self
            .get(&format!("/library/metadata/{key}/children"), None)
            .await?;
        Ok(container.get("Metadata").and_then(Value::as_array).cloned())
    }

    /// `getRecentlyAdded(id, { addedAt }, type)`.
    async fn recently_added(
        &self,
        id: &str,
        added_at_ms: i64,
        library_type: &str,
    ) -> Result<Vec<Value>> {
        let path = format!(
            "/library/sections/{id}/all?type={}{}&sort=addedAt%3Adesc&addedAt>>={}",
            if library_type == "show" { "4" } else { "1" },
            if library_type == "movie" {
                "&includeGuids=1"
            } else {
                ""
            },
            added_at_ms.div_euclid(1000)
        );
        let container = self.get(&path, Some((0, 500))).await?;
        Ok(array_of(&container, "Metadata").to_vec())
    }
}

/// What `getMediaIds` found.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct MediaIds {
    tmdb_id: Option<i64>,
    imdb_id: Option<String>,
    tvdb_id: Option<i64>,
    is_hama: bool,
}

/// The digits right after the first `prefix` followed by at least one.
fn digits_after<'t>(text: &'t str, prefix: &str) -> Option<&'t str> {
    text.match_indices(prefix).find_map(|(at, _)| {
        let rest = text.get(at + prefix.len()..)?;
        let end = rest
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(rest.len());
        rest.get(..end).filter(|d| !d.is_empty())
    })
}

/// `/imdb:\/\/(tt[0-9]+)/`.
fn imdb_match(text: &str) -> Option<String> {
    digits_after(text, "imdb://tt").map(|d| format!("tt{d}"))
}

/// `/hama:\/\/<kind>[0-9]?-([0-9]+)/`.
fn hama_match<'t>(text: &'t str, kind: &str) -> Option<&'t str> {
    let prefix = format!("hama://{kind}");
    text.match_indices(prefix.as_str()).find_map(|(at, _)| {
        let rest = text.get(at + prefix.len()..)?;
        let mut chars = rest.chars();
        let after_digit = match chars.next() {
            Some(c) if c.is_ascii_digit() && chars.next() == Some('-') => rest.get(1..),
            _ => Some(rest),
        }?;
        let digits = after_digit.strip_prefix('-')?;
        let end = digits
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(digits.len());
        digits.get(..end).filter(|d| !d.is_empty())
    })
}

/// `/plex:\/\//` or `/tv\.plex\.agents\.custom(\.[a-zA-Z0-9]+)+:\/\//`.
fn is_plex_agent(guid: &str) -> bool {
    guid.contains("plex://")
        || guid.match_indices("tv.plex.agents.custom").any(|(at, m)| {
            let mut rest = guid.get(at + m.len()..).unwrap_or_default();
            let mut parts = 0;
            while let Some(after) = rest.strip_prefix('.') {
                let end = after
                    .find(|c: char| !c.is_ascii_alphanumeric())
                    .unwrap_or(after.len());
                if end == 0 {
                    return false;
                }
                parts += 1;
                rest = after.get(end..).unwrap_or_default();
            }
            parts > 0 && rest.starts_with("://")
        })
}

/// `Number(md.index)`.
fn index_of(md: &Value) -> Option<i64> {
    match md.get("index")? {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.trim().parse().ok(),
        Value::Null | Value::Bool(_) | Value::Array(_) | Value::Object(_) => None,
    }
}

fn parse_id(digits: &str) -> Option<i64> {
    digits.parse().ok().filter(|n| *n != 0)
}

/// `media.videoResolution === '4k'` for some media of an item.
fn has_4k(item: &Value) -> Result<bool> {
    let media = item
        .get("Media")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("some is missing"))?;
    Ok(media
        .iter()
        .any(|m| str_of(m, "videoResolution") == Some("4k")))
}

fn rating_key(item: &Value) -> String {
    js_string(item.get("ratingKey")).into_owned()
}

/// The first of `grandparentRatingKey ?? parentRatingKey ?? ratingKey`.
fn show_key(item: &Value) -> String {
    ["grandparentRatingKey", "parentRatingKey", "ratingKey"]
        .iter()
        .find_map(|k| item.get(*k).filter(|v| !v.is_null()))
        .map(|v| js_string(Some(v)).into_owned())
        .unwrap_or_default()
}

/// `new Date(addedAt * 1000)`.
fn added_at(item: &Value) -> Option<i64> {
    item.get("addedAt")
        .and_then(Value::as_f64)
        .and_then(|s| format!("{:.0}", s * 1000.0).parse().ok())
}

/// The recently-added grouping: same show, same season, or same item.
fn same_group(a: &Value, b: &Value) -> bool {
    for key in ["grandparentRatingKey", "parentRatingKey"] {
        if js_truthy(a.get(key)) && js_truthy(b.get(key)) {
            return a.get(key) == b.get(key);
        }
    }
    a.get("ratingKey") == b.get("ratingKey")
}

/// The Plex library is the settings library and uses the HAMA agent.
fn is_hama_library(library: &Value, plex: &Value) -> bool {
    let agent = str_of(plex, "agent");
    agent == Some(HAMA_AGENT) && library.get("id") == plex.get("key")
}

/// One run's scanner with its client.
struct Plex<'s> {
    scan: &'s Scan<'s>,
    client: PlexClient,
}

async fn scan_libraries(scan: &Scan<'_>, recent: bool) -> Result<()> {
    let job = scan.job;
    let admin = job
        .state
        .db
        .rows(
            r#"SELECT "id", "plexToken" FROM "user" WHERE "id" = ?1 LIMIT 1"#,
            &[Bind::Int(1)],
        )
        .await?;
    let Some(admin) = admin.first() else {
        scan.warn("No admin configured. Plex scan skipped.");
        return Ok(());
    };
    let token = admin
        .get("plexToken")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let plex = Plex {
        scan,
        client: PlexClient::new(job, token)?,
    };
    let libraries: Vec<Value> = job
        .settings
        .get("/plex/libraries")
        .and_then(Value::as_array)
        .map(|all| {
            all.iter()
                .filter(|l| js_truthy(l.get("enabled")))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    scan.set_list(&libraries);
    if plex.has_hama(&libraries).await? {
        anime_sync(job).await?;
    }
    for library in &libraries {
        scan.set_current(library);
        let name = js_string(library.get("name"));
        if recent {
            let last_scan = library.get("lastScan").cloned().unwrap_or(Value::Null);
            tracing::info!(
                label = scan.kind.label,
                lastScan = %last_scan,
                "Beginning to process recently added for library: {name}"
            );
            plex.recent(library).await?;
        } else {
            scan.info(&format!("Beginning to process library: {name}"));
            plex.paginate(library).await?;
        }
    }
    scan.info(if recent {
        "Recently Added Scan Complete"
    } else {
        "Full Scan Complete"
    });
    Ok(())
}

impl Plex<'_> {
    /// `hasHamaAgent()`.
    async fn has_hama(&self, libraries: &[Value]) -> Result<bool> {
        let plex_libraries = self.client.libraries().await?;
        Ok(libraries
            .iter()
            .any(|library| plex_libraries.iter().any(|p| is_hama_library(library, p))))
    }

    async fn recent(&self, library: &Value) -> Result<()> {
        let id = js_string(library.get("id")).into_owned();
        let added = library
            .get("lastScan")
            .filter(|v| js_truthy(Some(v)))
            .and_then(Value::as_i64)
            .map_or_else(
                || crate::clock::now_millis() - 60 * 60 * 1000,
                |last| last - 10 * 60 * 1000,
            );
        let library_type = js_string(library.get("type")).into_owned();
        let items = self
            .client
            .recently_added(&id, added, &library_type)
            .await?;
        let items = uniq_with(&items, same_group);
        self.scan
            .bundles(&items, BUNDLE, |item| self.process_item(item))
            .await?;
        let job = self.scan.job;
        mutate_settings(job, |doc| {
            if let Some(all) = doc
                .pointer_mut("/plex/libraries")
                .and_then(Value::as_array_mut)
            {
                for lib in all.iter_mut() {
                    if lib.get("id") == library.get("id") {
                        if let Some(obj) = lib.as_object_mut() {
                            obj.insert(
                                String::from("lastScan"),
                                Value::from(crate::clock::now_millis()),
                            );
                        }
                    }
                }
            }
        })
        .await
    }

    /// `paginateLibrary(library)`.
    async fn paginate(&self, library: &Value) -> Result<()> {
        let id = js_string(library.get("id")).into_owned();
        let mut start = 0;
        loop {
            self.scan.check()?;
            let (total, items) = self.client.library_contents(&id, start).await?;
            self.scan.set_progress(start);
            self.scan.set_total(total.as_i64().unwrap_or(0));
            if items.is_empty() {
                return Ok(());
            }
            super::scanbase::concurrently(&items, &|item| self.process_item(item)).await;
            if items.len() < BUNDLE {
                return Ok(());
            }
            Scan::pause().await;
            start += BUNDLE;
        }
    }

    /// `processItem(plexitem)`.
    async fn process_item(&self, item: Value) {
        let result = match str_of(&item, "type") {
            Some("movie") => self.process_movie(&item).await,
            Some("show" | "episode" | "season") => self.process_show(&item).await,
            _ => Ok(()),
        };
        if let Err(e) = result {
            tracing::error!(
                label = self.scan.kind.label,
                errorMessage = %format!("{e:#}"),
                title = %js_string(item.get("title")),
                "Failed to process Plex media"
            );
        }
    }

    async fn process_movie(&self, item: &Value) -> Result<()> {
        let ids = self.media_ids(item).await?;
        let tmdb_id = ids
            .tmdb_id
            .ok_or_else(|| anyhow!("Unable to find TMDB ID"))?;
        self.movie_by_tmdb_id(item, tmdb_id).await
    }

    /// `processPlexMovieByTmdbId(item, tmdbId)`.
    async fn movie_by_tmdb_id(&self, item: &Value, tmdb_id: i64) -> Result<()> {
        let four_k = has_4k(item)?;
        let o = MovieOpts {
            is4k: four_k && self.scan.enable4k_movie,
            media_added_at: added_at(item),
            rating_key: Some(rating_key(item)),
            ..MovieOpts::new(&js_string(item.get("title")))
        };
        self.scan.process_movie(tmdb_id, &o).await
    }

    async fn process_show(&self, item: &Value) -> Result<()> {
        let key = show_key(item);
        let metadata = self.client.metadata(&key, true).await?;
        let ids = self.media_ids(&metadata).await?;
        let tmdb_id = ids
            .tmdb_id
            .ok_or_else(|| anyhow!("Unable to find TMDB ID"))?;
        if ids.tvdb_id.is_none() && ids.is_hama {
            // `this.processHamaMovie(metadata, tmdbId)` isn't awaited: the
            // scan moves on (and may finish) while it runs.
            let detached = self.scan.detach();
            let client = self.client.clone();
            tokio::spawn(async move {
                let scan = detached.scan();
                let plex = Plex {
                    scan: &scan,
                    client,
                };
                if let Err(e) = plex.hama_movie(&metadata, tmdb_id).await {
                    scan.debug(&format!("HAMA movie failed: {e:#}"));
                }
            });
            return Ok(());
        }
        if let (Some(tvdb), true) = (ids.tvdb_id, ids.is_hama) {
            self.hama_specials(&metadata, tvdb).await?;
        }
        let show = tv_show(self.scan.job, Some(tmdb_id), None).await?;
        let settings = self.scan.job.current_settings().await?;
        let specials = js_truthy(settings.get("/main/enableSpecialEpisodes"));
        let children = metadata
            .get("Children")
            .map(|c| array_of(c, "Metadata"))
            .unwrap_or_default();
        let mut seasons = Vec::new();
        for (number, total) in seasons_of(&show, specials) {
            let matched = children.iter().find(|md| index_of(md) == Some(number));
            let (episodes, episodes4k) = match matched {
                Some(season) => self.count_episodes(&rating_key(season)).await?,
                None => (0, 0),
            };
            seasons.push(ProcessableSeason {
                season_number: number,
                total_episodes: total,
                episodes,
                episodes4k,
                ..ProcessableSeason::default()
            });
        }
        let tvdb = ids.tvdb_id.or_else(|| {
            show.get("external_ids")
                .and_then(|e| e.get("tvdb_id"))
                .and_then(Value::as_i64)
        });
        let o = ShowOpts {
            media_added_at: added_at(&metadata),
            rating_key: Some(key),
            title: js_string(metadata.get("title")).into_owned(),
            ..ShowOpts::default()
        };
        self.scan.process_show(tmdb_id, tvdb, &seasons, &o).await
    }

    /// The standard and 4K episodes of a Plex season.
    async fn count_episodes(&self, season_key: &str) -> Result<(i64, i64)> {
        let episodes = self
            .client
            .children(season_key)
            .await?
            .ok_or_else(|| anyhow!("filter is missing"))?;
        let enable4k = self.scan.enable4k_show;
        let mut standard = 0;
        let mut uhd = 0;
        for episode in &episodes {
            let media = array_of(episode, "Media");
            if !enable4k
                || media
                    .iter()
                    .any(|m| str_of(m, "videoResolution") != Some("4k"))
            {
                standard += 1;
            }
            if enable4k
                && media
                    .iter()
                    .any(|m| str_of(m, "videoResolution") == Some("4k"))
            {
                uhd += 1;
            }
        }
        Ok((standard, uhd))
    }

    /// `getMediaIds(plexitem)`.
    async fn media_ids(&self, item: &Value) -> Result<MediaIds> {
        let guid = str_of(item, "guid").ok_or_else(|| anyhow!("match is missing"))?;
        let job = self.scan.job;
        let mut ids = MediaIds::default();
        if is_plex_agent(guid) {
            let has_guids = !array_of(item, "Guid").is_empty();
            let fetched;
            let metadata = if has_guids {
                item
            } else {
                fetched = self.client.metadata(&rating_key(item), false).await?;
                &fetched
            };
            let refs = metadata.get("Guid").and_then(Value::as_array).ok_or_else(|| {
                anyhow!("No Guid metadata for this title. Skipping. (Try refreshing the metadata in Plex for this media!)")
            })?;
            for reference in refs {
                let id = str_of(reference, "id").unwrap_or_default();
                if let Some(imdb) = imdb_match(id) {
                    ids.imdb_id = Some(imdb);
                } else if let Some(tmdb) = digits_after(id, "tmdb://") {
                    ids.tmdb_id = parse_id(tmdb);
                } else if let Some(tvdb) = digits_after(id, "tvdb://") {
                    ids.tvdb_id = parse_id(tvdb);
                }
            }
            if let (Some(imdb), None) = (&ids.imdb_id, ids.tmdb_id) {
                ids.tmdb_id = Some(resolve_imdb(job, imdb).await?);
            }
            if let (Some(tvdb), None) = (ids.tvdb_id, ids.tmdb_id) {
                ids.tmdb_id = show_by_tvdb(job, tvdb)
                    .await?
                    .get("id")
                    .and_then(Value::as_i64);
            }
        } else if let Some(imdb) = imdb_match(guid) {
            ids.tmdb_id = Some(resolve_imdb(job, &imdb).await?);
            ids.imdb_id = Some(imdb);
        } else if let Some(tmdb) = digits_after(guid, "tmdb://") {
            ids.tmdb_id = parse_id(tmdb);
        } else if let Some(tvdb) = digits_after(guid, "tvdb://") {
            let tvdb = parse_id(tvdb);
            if let Some(tvdb) = tvdb {
                ids.tmdb_id = show_by_tvdb(job, tvdb)
                    .await?
                    .get("id")
                    .and_then(Value::as_i64);
            }
            ids.tvdb_id = tvdb;
        } else if let Some(tmdb) = digits_after(guid, "themoviedb://") {
            ids.tmdb_id = parse_id(tmdb);
        } else if let Some(tvdb) = hama_match(guid, "tvdb") {
            let tvdb = parse_id(tvdb);
            if let Some(tvdb) = tvdb {
                ids.tmdb_id = show_by_tvdb(job, tvdb)
                    .await?
                    .get("id")
                    .and_then(Value::as_i64);
            }
            ids.tvdb_id = tvdb;
            ids.is_hama = true;
        } else if let Some(anidb) = hama_match(guid, "anidb") {
            self.hama_anidb(anidb.parse().unwrap_or(0), &mut ids)
                .await?;
        }
        if ids.tmdb_id.is_none() {
            return Err(anyhow!("Unable to find TMDB ID"));
        }
        Ok(ids)
    }

    /// The HAMA `AniDB` branch of `getMediaIds`.
    async fn hama_anidb(&self, anidb_id: i64, ids: &mut MediaIds) -> Result<()> {
        let job = self.scan.job;
        let result = super::scanbase::anime_from_anidb(job, anidb_id).await?;
        ids.is_hama = true;
        let mut found_show = false;
        if let Some(tvdb) = result.as_ref().and_then(|r| r.tvdb_id).filter(|t| *t != 0) {
            if let Some(show_id) = tvdb_show_id(job, tvdb).await? {
                let show = tv_for_scan(job, show_id).await?;
                ids.tvdb_id = Some(tvdb);
                ids.tmdb_id = show.get("id").and_then(Value::as_i64);
                found_show = true;
            } else {
                self.scan.debug(&format!(
                    "Missing TVDB {tvdb} entry in TMDB for AniDB {anidb_id}"
                ));
            }
        }
        if !found_show {
            let r = result.unwrap_or_default();
            if let Some(tmdb) = r.tmdb_id.filter(|t| *t != 0) {
                ids.tmdb_id = Some(tmdb);
                ids.imdb_id = r.imdb_id;
            } else if let Some(imdb) = r.imdb_id.filter(|i| !i.is_empty()) {
                ids.tmdb_id = Some(resolve_imdb(job, &imdb).await?);
                ids.imdb_id = Some(imdb);
            }
        }
        Ok(())
    }

    /// `processHamaMovie(metadata, tmdbId)`: the first episode of the first
    /// season is the movie.
    async fn hama_movie(&self, metadata: &Value, tmdb_id: i64) -> Result<()> {
        let children = metadata
            .get("Children")
            .map(|c| array_of(c, "Metadata"))
            .unwrap_or_default();
        let Some(season) = children.first() else {
            return Ok(());
        };
        if let Some(episodes) = self.client.children(&rating_key(season)).await? {
            let first = episodes
                .first()
                .ok_or_else(|| anyhow!("Media is missing"))?;
            self.movie_by_tmdb_id(first, tmdb_id).await?;
        }
        Ok(())
    }

    /// `processHamaSpecials(metadata, tvdbId)`: specials that are movies.
    async fn hama_specials(&self, metadata: &Value, tvdb_id: i64) -> Result<()> {
        let children = metadata
            .get("Children")
            .map(|c| array_of(c, "Metadata"))
            .unwrap_or_default();
        let Some(specials) = children.iter().find(|md| index_of(md) == Some(0)) else {
            return Ok(());
        };
        let Some(episodes) = self.client.children(&rating_key(specials)).await? else {
            return Ok(());
        };
        for episode in &episodes {
            let index = episode.get("index").and_then(Value::as_i64).unwrap_or(0);
            let special = anime_special(self.scan.job, tvdb_id, index).await?;
            match special {
                Some(AnidbItem {
                    tmdb_id: Some(tmdb),
                    ..
                }) if tmdb != 0 => self.movie_by_tmdb_id(episode, tmdb).await?,
                Some(AnidbItem {
                    imdb_id: Some(imdb),
                    ..
                }) if !imdb.is_empty() => {
                    let tmdb = resolve_imdb(self.scan.job, &imdb).await?;
                    self.movie_by_tmdb_id(episode, tmdb).await?;
                }
                _ => {}
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn guid_patterns() {
        assert_eq!(
            imdb_match("com.plexapp.agents.imdb://tt0111161?lang=en").as_deref(),
            Some("tt0111161"),
            "imdb agent"
        );
        assert_eq!(digits_after("tmdb://603", "tmdb://"), Some("603"), "tmdb");
        assert_eq!(
            digits_after("com.plexapp.agents.themoviedb://1399?lang=en", "tmdb://"),
            None,
            "themoviedb is not tmdb"
        );
        assert!(is_plex_agent("plex://movie/5d776"), "new agent");
        assert!(
            is_plex_agent("tv.plex.agents.custom.foo.bar2://x"),
            "custom provider"
        );
        assert!(!is_plex_agent("tv.plex.agents.custom://x"), "needs a part");
        assert_eq!(
            hama_match("hama://tvdb-81797", "tvdb"),
            Some("81797"),
            "hama"
        );
        assert_eq!(
            hama_match("hama://tvdb2-81797", "tvdb"),
            Some("81797"),
            "hama digit"
        );
        assert_eq!(hama_match("hama://anidb4-69", "anidb"), Some("69"), "anidb");
        assert_eq!(hama_match("hama://anidb-x", "anidb"), None, "no digits");
        assert_eq!(
            hama_match("hama://anidb-x-5", "anidb"),
            None,
            "digits right after"
        );
        assert_eq!(
            hama_match("hama://tvdb22-5", "tvdb"),
            None,
            "one digit at most"
        );
    }

    #[test]
    fn grouping_and_keys() {
        let a = json!({ "ratingKey": "1", "grandparentRatingKey": "9" });
        let b = json!({ "ratingKey": "2", "grandparentRatingKey": "9" });
        let c = json!({ "ratingKey": "3", "parentRatingKey": "8" });
        let items = uniq_with(&[a.clone(), b, c.clone()], same_group);
        assert_eq!(items, vec![a.clone(), c], "episodes of a show grouped");
        assert_eq!(show_key(&a), "9", "show key");
        assert_eq!(
            added_at(&json!({ "addedAt": 1_700_000_000 })),
            Some(1_700_000_000_000),
            "ms"
        );
    }
}
