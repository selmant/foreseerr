//! `lib/library.ts`: the library payloads, built from the signed-in user's
//! Jellyfin view and the media table. Every function only reads, so any
//! `Err` (a reason) can still hand the request to Node.

use std::collections::HashMap;

use serde_json::{json, Map, Value};

use crate::db::Bind;
use crate::jellyfin::{authorization, hostname, join_all, Item, JellyfinClient, JfError, Job};
use crate::librarymap::{
    apply_play_target, filter_playable, has_play_target, hydrate_forgotten, library_item_image_url,
    media_url_for_item, next_up_target, num, progress_from_item, quick_targets,
    resolve_series_play_target, resumable, safe_integer, series_of, sxe, title_from_item,
    tmdb_from_providers, tmdb_from_raw, BrowseQuery, JsObj, MediaInfo, PlayTarget, MEDIA_COLUMNS,
};
use crate::settings::public::truthy;
use crate::settings::Settings;
use crate::state::AppState;

/// One series' episode lookup: title index, series id, result.
type EpisodeLookup<'a> = (usize, &'a str, Result<Vec<Item>, JfError>);

/// `PLAY_TARGET_CONCURRENCY`.
const PLAY_TARGET_CONCURRENCY: usize = 4;

/// A failed Jellyfin call.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Failure {
    status: Option<u16>,
    message: String,
}

/// Split a Jellyfin result into what Node would see (a value or a thrown
/// error) and what it might not (`Err`, so Node answers).
fn sure<T>(result: Result<T, JfError>) -> Result<Result<T, Failure>, String> {
    match result {
        Ok(value) => Ok(Ok(value)),
        Err(JfError::Failed { status, message }) => Ok(Err(Failure { status, message })),
        Err(JfError::Unsure(why)) => Err(why),
    }
}

/// `createUserJellyfinClient`'s result.
#[derive(Debug)]
pub enum Link {
    /// The user's client.
    Linked(Box<Linked>),
    /// `not_linked` or `unsupported_media_server`.
    Code(&'static str),
}

/// A linked user.
#[derive(Debug)]
pub struct Linked {
    /// The client acting as the user.
    pub client: JellyfinClient,
    /// `user.settings.autoCompleteSkippedEpisodeEndings === true`.
    pub auto_complete: bool,
}

/// The image route's result.
#[derive(Debug)]
pub enum ImageOutcome {
    /// The bytes and their content type.
    Image(bytes::Bytes, String),
    /// `next({ status, message })`.
    Error(u16, &'static str),
}

/// One page of `/library/available` or `/library/browse`.
#[derive(Debug)]
pub struct Page {
    /// The titles.
    pub results: Vec<Value>,
    /// `total`.
    pub total: f64,
    /// `code`, when there is one.
    pub code: Option<&'static str>,
}

impl Page {
    const fn empty(code: &'static str) -> Self {
        Self {
            results: Vec::new(),
            total: 0.0,
            code: Some(code),
        }
    }
}

fn to_f64(n: i64) -> f64 {
    n.to_string().parse().unwrap_or(0.0)
}

fn values(titles: &[JsObj]) -> Vec<Value> {
    titles.iter().map(JsObj::to_value).collect()
}

/// The library work for one signed-in user.
#[derive(Debug)]
pub struct Lib<'a> {
    /// Shared state (database, outgoing client, version).
    pub state: &'a AppState,
    /// settings.json as this request sees it.
    pub settings: &'a Settings,
    /// `req.user.id`.
    pub user_id: i64,
}

impl Lib<'_> {
    /// `createUserJellyfinClient`.
    ///
    /// # Errors
    ///
    /// Database errors and credentials that can't be sent as Node would.
    pub async fn link(&self) -> Result<Link, String> {
        if self
            .settings
            .get("/main/mediaServerType")
            .and_then(Value::as_i64)
            != Some(2)
        {
            return Ok(Link::Code("unsupported_media_server"));
        }
        let rows = self
            .state
            .db
            .rows(
                r#"SELECT u."jellyfinUserId" AS "jellyfinUserId", u."jellyfinAuthToken" AS "jellyfinAuthToken", u."jellyfinDeviceId" AS "jellyfinDeviceId", s."autoCompleteSkippedEpisodeEndings" AS "autoComplete" FROM "user" u LEFT JOIN "user_settings" s ON s."userId" = u."id" WHERE u."id" = ?1"#,
                &[Bind::Int(self.user_id)],
            )
            .await
            .map_err(|e| format!("loading the Jellyfin link failed: {e:#}"))?;
        let Some(row) = rows.first() else {
            return Ok(Link::Code("not_linked"));
        };
        let text = |key: &str| {
            row.get(key)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
        };
        let (Some(user_id), Some(token), Some(device_id)) = (
            text("jellyfinUserId"),
            text("jellyfinAuthToken"),
            text("jellyfinDeviceId"),
        ) else {
            return Ok(Link::Code("not_linked"));
        };
        let auto_complete = match row.get("autoComplete") {
            Some(Value::Bool(b)) => *b,
            Some(Value::Number(n)) => n.as_i64() == Some(1),
            _ => false,
        };
        let client = JellyfinClient::new(
            self.state.outbound.clone(),
            hostname(self.settings),
            &authorization(token, device_id, &self.state.version.version),
            user_id.to_owned(),
        )?;
        Ok(Link::Linked(Box::new(Linked {
            client,
            auto_complete,
        })))
    }

    /// `resolveMediaRows`: each item's media row by Jellyfin id (item or
    /// series), else by TMDB id. Rows whose order would decide the match
    /// go to Node.
    async fn media_rows(&self, items: &[Item]) -> Result<HashMap<String, MediaInfo>, String> {
        let mut ids: Vec<&str> = Vec::new();
        for item in items {
            for id in [Some(item.id()), item.str("SeriesId")]
                .into_iter()
                .flatten()
            {
                if !id.is_empty() && !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
        let mut by_jellyfin: HashMap<String, MediaInfo> = HashMap::new();
        if !ids.is_empty() {
            let placeholders = (1..=ids.len())
                .map(|i| format!("?{i}"))
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                r#"SELECT {MEDIA_COLUMNS} FROM "media" m WHERE m."jellyfinMediaId" IN ({placeholders}) OR m."jellyfinMediaId4k" IN ({placeholders}) ORDER BY m."id" ASC"#
            );
            let binds: Vec<Bind> = ids.iter().map(|id| Bind::Text((*id).to_owned())).collect();
            let rows = self
                .state
                .db
                .rows(&sql, &binds)
                .await
                .map_err(|e| format!("loading media by Jellyfin id failed: {e:#}"))?;
            for row in &rows {
                let media = MediaInfo::from_row(row, self.settings)?;
                for key in [&media.jellyfin_media_id, &media.jellyfin_media_id4k]
                    .into_iter()
                    .flatten()
                    .filter(|k| !k.is_empty())
                {
                    if by_jellyfin.get(key).is_some_and(|m| m.id != media.id) {
                        return Err(String::from("two media rows share a Jellyfin id"));
                    }
                    by_jellyfin.insert(key.clone(), media.clone());
                }
            }
        }
        let mut item_media: HashMap<String, MediaInfo> = HashMap::new();
        let mut lookups: Vec<(i64, &'static str, &str)> = Vec::new();
        for item in items {
            let series = item.str("SeriesId").filter(|s| !s.is_empty());
            let found = by_jellyfin
                .get(item.id())
                .or_else(|| series.and_then(|s| by_jellyfin.get(s)));
            if let Some(media) = found {
                item_media.insert(item.id().to_owned(), media.clone());
            }
        }
        for item in items {
            if item_media.contains_key(item.id()) {
                continue;
            }
            if let Some(tmdb_id) = tmdb_from_providers(item)? {
                let media_type = if item.is("Movie") { "movie" } else { "tv" };
                lookups.push((tmdb_id, media_type, item.id()));
            }
        }
        if lookups.is_empty() {
            return Ok(item_media);
        }
        let mut tmdb_ids: Vec<i64> = Vec::new();
        for (id, _, _) in &lookups {
            if !tmdb_ids.contains(id) {
                tmdb_ids.push(*id);
            }
        }
        let list = tmdb_ids
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            r#"SELECT {MEDIA_COLUMNS} FROM "media" m WHERE m."tmdbId" IN ({list}) ORDER BY m."id" ASC"#
        );
        let rows = self
            .state
            .db
            .rows(&sql, &[])
            .await
            .map_err(|e| format!("loading related media failed: {e:#}"))?;
        let related = rows
            .iter()
            .map(|row| MediaInfo::from_row(row, self.settings))
            .collect::<Result<Vec<_>, _>>()?;
        for (tmdb_id, media_type, item_id) in lookups {
            let mut matches = related
                .iter()
                .filter(|m| m.tmdb_id == tmdb_id && m.media_type == media_type);
            let first = matches.next();
            if matches.next().is_some() {
                return Err(String::from("two media rows share a TMDB id and type"));
            }
            if let Some(media) = first {
                item_media.insert(item_id.to_owned(), media.clone());
            }
        }
        Ok(item_media)
    }

    /// `mapJellyfinItemsToLibraryTitles`.
    ///
    /// # Errors
    ///
    /// Database errors and shapes Node has to judge.
    pub async fn map_titles(&self, items: &[Item]) -> Result<Vec<JsObj>, String> {
        let media = self.media_rows(items).await?;
        items
            .iter()
            .map(|item| title_from_item(item, media.get(item.id()), self.settings))
            .collect()
    }

    /// `enrichSeriesPlayTargets`.
    async fn enrich(
        &self,
        client: &JellyfinClient,
        titles: Vec<JsObj>,
        lists: Option<(&[Item], &[Item])>,
        resolve_missing: bool,
    ) -> Result<Vec<JsObj>, String> {
        let fetched;
        let (resume, next_up): (&[Item], &[Item]) = if let Some(lists) = lists {
            lists
        } else {
            let resume = sure(client.resume_items(32).await)?.unwrap_or_default();
            let next = sure(client.next_up(48, None).await)?.unwrap_or_default();
            fetched = (resume, next);
            (&fetched.0, &fetched.1)
        };
        let mut titles = quick_targets(titles, resume, next_up);
        if !resolve_missing {
            return Ok(titles);
        }
        let missing: Vec<(usize, String)> = titles
            .iter()
            .enumerate()
            .filter(|(_, title)| !has_play_target(title))
            .map(|(i, title)| (i, series_of(title)))
            .collect();
        for chunk in missing.chunks(PLAY_TARGET_CONCURRENCY) {
            let jobs: Vec<Job<'_, EpisodeLookup<'_>>> = chunk
                .iter()
                .map(|(i, series)| {
                    let job: Job<'_, _> = Box::pin(async move {
                        (*i, series.as_str(), client.series_episodes(series).await)
                    });
                    job
                })
                .collect();
            for (index, series, result) in join_all(jobs).await {
                let Some(title) = titles.get_mut(index) else {
                    continue;
                };
                title.put("jellyfinSeriesId", Value::from(series));
                match sure(result)? {
                    Ok(episodes) => {
                        let refs: Vec<&Item> = episodes.iter().collect();
                        let resumed: Vec<&Item> = resume
                            .iter()
                            .filter(|e| e.str("SeriesId") == Some(series))
                            .collect();
                        apply_play_target(
                            title,
                            resolve_series_play_target(series, &refs, &resumed),
                        );
                    }
                    Err(failure) => tracing::debug!(
                        "Failed to resolve series play target {series}: {}",
                        failure.message
                    ),
                }
            }
        }
        Ok(titles)
    }

    /// `buildForgottenRequestsShelf(userId, limit)`.
    async fn forgotten_requests(&self, limit: usize) -> Result<Vec<JsObj>, String> {
        let sql = format!(
            r#"SELECT r."is4k" AS "is4k", {MEDIA_COLUMNS} FROM "media_request" r LEFT JOIN "media" m ON m."id" = r."mediaId" WHERE r."requestedById" = ?1 AND r."status" IN (2, 5) AND m."status" IN (5, 4) AND (m."jellyfinMediaId" IS NOT NULL OR m."jellyfinMediaId4k" IS NOT NULL) ORDER BY r."updatedAt" DESC, r."id" ASC LIMIT {}"#,
            limit * 2
        );
        let rows = self
            .state
            .db
            .rows(&sql, &[Bind::Int(self.user_id)])
            .await
            .map_err(|e| format!("loading forgotten requests failed: {e:#}"))?;
        let mut titles = Vec::new();
        let mut seen: Vec<i64> = Vec::new();
        for row in &rows {
            let media = MediaInfo::from_row(row, self.settings)?;
            if seen.contains(&media.id) {
                continue;
            }
            seen.push(media.id);
            let is4k = match row.get("is4k") {
                Some(Value::Bool(b)) => *b,
                Some(Value::Number(n)) => n.as_i64() != Some(0),
                _ => false,
            };
            let preferred = if is4k {
                &media.jellyfin_media_id4k
            } else {
                &media.jellyfin_media_id
            };
            let Some(item_id) = preferred
                .clone()
                .or_else(|| media.jellyfin_media_id.clone())
                .or_else(|| media.jellyfin_media_id4k.clone())
                .filter(|id| !id.is_empty())
            else {
                continue;
            };
            let movie = media.media_type == "movie";
            let mut title = JsObj::default();
            title.put("mediaId", Value::from(media.id));
            title.put("tmdbId", Value::from(media.tmdb_id));
            title.put("mediaType", Value::from(if movie { "movie" } else { "tv" }));
            title.put("jellyfinItemId", Value::from(item_id.as_str()));
            title.set(
                "jellyfinSeriesId",
                (media.media_type == "tv").then(|| Value::from(item_id.as_str())),
            );
            title.put("title", Value::from(if movie { "Movie" } else { "Series" }));
            let url = if is4k {
                &media.media_url4k
            } else {
                &media.media_url
            };
            title.set("mediaUrl", url.clone().map(Value::from));
            title.put("status", Value::from(media.status));
            title.put(
                "posterUrl",
                Value::from(library_item_image_url(&item_id, "primary")),
            );
            title.put(
                "backdropUrl",
                Value::from(library_item_image_url(&item_id, "backdrop")),
            );
            titles.push(title);
            if titles.len() >= limit {
                break;
            }
        }
        Ok(titles)
    }

    /// The enabled show libraries, for the latest-episode lookups.
    fn tv_library_ids(&self) -> Result<Vec<String>, String> {
        let libraries = match self.settings.get("/jellyfin/libraries") {
            None | Some(Value::Null) => return Ok(Vec::new()),
            Some(Value::Array(libraries)) => libraries,
            Some(_) => return Err(String::from("jellyfin.libraries isn't a list")),
        };
        let mut ids = Vec::new();
        for library in libraries {
            if !library.is_object() {
                return Err(String::from(
                    "a jellyfin library entry Node would trip over",
                ));
            }
            if !truthy(library.get("enabled"))
                || library.get("type").and_then(Value::as_str) != Some("show")
            {
                continue;
            }
            match library.get("id") {
                Some(Value::String(id)) => {
                    if !id.is_empty() {
                        ids.push(id.clone());
                    }
                }
                None | Some(Value::Null) => {}
                Some(_) => return Err(String::from("a library id that isn't a string")),
            }
        }
        Ok(ids)
    }

    /// `buildWatchNowResponse` without the skipped-episode cleanup, which
    /// writes to Jellyfin under a per-user lock: those users go to Node.
    ///
    /// # Errors
    ///
    /// Reasons for Node to answer.
    pub async fn watch_now(&self) -> Result<Value, String> {
        let linked = match self.link().await? {
            Link::Code(code) => return Ok(json!({"shelves": [], "code": code})),
            Link::Linked(linked) => linked,
        };
        if linked.auto_complete {
            return Err(String::from(
                "autoCompleteSkippedEpisodeEndings cleans up through Jellyfin; Node runs it",
            ));
        }
        let client = &linked.client;
        let libraries = self.tv_library_ids()?;
        let mut jobs: Vec<Job<'_, Result<Vec<Item>, JfError>>> = vec![
            Box::pin(client.resume_items(16)),
            Box::pin(client.latest_items(16)),
            Box::pin(client.next_up(48, None)),
        ];
        if libraries.is_empty() {
            jobs.push(Box::pin(client.latest_episodes(32, None)));
        } else {
            for id in libraries {
                jobs.push(Box::pin(client.latest_episodes(32, Some(id))));
            }
        }
        let mut lists = Vec::new();
        let mut failures = Vec::new();
        for result in join_all(jobs).await {
            match sure(result)? {
                Ok(items) => lists.push(Some(items)),
                Err(failure) => {
                    failures.push(failure.message);
                    lists.push(None);
                }
            }
        }
        if !failures.is_empty() {
            tracing::error!(
                "Failed to load some Jellyfin watch-now sources: {}",
                failures.join("; ")
            );
        }
        let mut lists = lists.into_iter();
        let resume = lists.next().flatten().unwrap_or_default();
        let latest = lists.next().flatten().unwrap_or_default();
        let next_up = lists.next().flatten().unwrap_or_default();
        let latest_episodes = latest_episodes(lists.flatten())?;
        let (continuing, recent, recent_episodes, forgotten) = tokio::join!(
            self.map_titles(&resume),
            self.recently_added(client, &latest, &resume, &next_up),
            self.recent_episodes(client, &latest_episodes),
            self.ready_to_watch(client, &resume, &next_up)
        );
        let shelves: Vec<Value> = [
            ("continue", "Continue Watching", continuing?),
            ("recent", "Recently Added", recent?),
            (
                "recent-episodes",
                "Recently Added Episodes",
                recent_episodes?,
            ),
            ("forgotten", "Ready to Watch", forgotten?),
        ]
        .into_iter()
        .filter(|(_, _, items)| !items.is_empty())
        .map(|(id, title, items)| json!({"id": id, "title": title, "items": values(&items)}))
        .collect();
        if shelves.is_empty() && !failures.is_empty() {
            return Ok(json!({"shelves": [], "code": "server_unreachable"}));
        }
        Ok(json!({ "shelves": shelves }))
    }

    async fn recently_added(
        &self,
        client: &JellyfinClient,
        latest: &[Item],
        resume: &[Item],
        next_up: &[Item],
    ) -> Result<Vec<JsObj>, String> {
        let titles = self.map_titles(latest).await?;
        Ok(filter_playable(
            self.enrich(client, titles, Some((resume, next_up)), true)
                .await?,
        ))
    }

    async fn recent_episodes(
        &self,
        client: &JellyfinClient,
        episodes: &[Item],
    ) -> Result<Vec<JsObj>, String> {
        let mut titles = self.map_titles(episodes).await?;
        let mut series_ids: Vec<String> = Vec::new();
        for title in &titles {
            if truthy(title.get("tmdbId")) {
                continue;
            }
            if let Some(series) = title.str("jellyfinSeriesId").filter(|s| !s.is_empty()) {
                if !series_ids.iter().any(|s| s == series) {
                    series_ids.push(series.to_owned());
                }
            }
        }
        if series_ids.is_empty() {
            return Ok(titles);
        }
        let jobs: Vec<Job<'_, Result<Option<Item>, JfError>>> = series_ids
            .iter()
            .map(|id| {
                let job: Job<'_, _> = Box::pin(client.item_data(id));
                job
            })
            .collect();
        let mut tmdb_by_series: Vec<(String, i64)> = Vec::new();
        for (id, result) in series_ids.iter().zip(join_all(jobs).await) {
            let Ok(Some(item)) = sure(result)? else {
                continue;
            };
            let raw = item
                .provider("Tmdb")
                .or_else(|| item.provider("TheMovieDb"));
            if let Some(tmdb_id) = tmdb_from_raw(raw)? {
                tmdb_by_series.push((id.clone(), tmdb_id));
            }
        }
        for title in &mut titles {
            if truthy(title.get("tmdbId")) {
                continue;
            }
            let Some(series) = title.str("jellyfinSeriesId").map(str::to_owned) else {
                continue;
            };
            if let Some((_, tmdb_id)) = tmdb_by_series.iter().find(|(s, _)| *s == series) {
                title.put("tmdbId", Value::from(*tmdb_id));
            }
        }
        Ok(titles)
    }

    async fn ready_to_watch(
        &self,
        client: &JellyfinClient,
        resume: &[Item],
        next_up: &[Item],
    ) -> Result<Vec<JsObj>, String> {
        let base = self.forgotten_requests(16).await?;
        let base = filter_playable(
            self.enrich(client, base, Some((resume, next_up)), true)
                .await?,
        );
        let ids: Vec<String> = base
            .iter()
            .filter_map(|t| t.str("jellyfinItemId").map(str::to_owned))
            .collect();
        let items = match sure(client.items_data(&ids).await)? {
            Ok(items) => items,
            Err(failure) => {
                tracing::debug!(
                    "Failed to hydrate Ready to Watch items from Jellyfin: {}",
                    failure.message
                );
                Vec::new()
            }
        };
        Ok(hydrate_forgotten(base, &items))
    }

    /// `listAvailableLibrary`.
    ///
    /// # Errors
    ///
    /// Reasons for Node to answer.
    pub async fn available(
        &self,
        take: i64,
        skip: i64,
        media_type: Option<&'static str>,
        query: Option<&str>,
    ) -> Result<Page, String> {
        let query = query
            .map(crate::jellyfin::js_trim)
            .filter(|q| !q.is_empty());
        let numeric = query.filter(|q| q.bytes().all(|b| b.is_ascii_digit()));
        if let (Some(q), None) = (query, numeric) {
            let linked = match self.link().await? {
                Link::Code(code) => return Ok(Page::empty(code)),
                Link::Linked(linked) => linked,
            };
            let client = &linked.client;
            let items = match sure(client.search(q, take, skip, media_type).await)? {
                Ok(items) => items,
                Err(failure) => {
                    tracing::error!("Failed to search Jellyfin library: {}", failure.message);
                    return Ok(Page::empty("server_unreachable"));
                }
            };
            let titles = self.map_titles(&items).await?;
            let mapped = filter_playable(self.enrich(client, titles, None, true).await?);
            return Ok(Page {
                total: to_f64(i64::try_from(mapped.len()).unwrap_or(i64::MAX)),
                results: values(&mapped),
                code: None,
            });
        }
        let mut filter = String::from(
            r#"m."status" IN (5, 4) AND (m."jellyfinMediaId" IS NOT NULL OR m."jellyfinMediaId4k" IS NOT NULL)"#,
        );
        let mut binds = Vec::new();
        if let Some(media_type) = media_type {
            binds.push(Bind::Text(media_type.to_owned()));
            filter = format!(r#"{filter} AND m."mediaType" = ?{}"#, binds.len());
        }
        if let Some(q) = numeric {
            let tmdb_id = q
                .parse::<i64>()
                .ok()
                .and_then(|n| safe_integer(to_f64(n)))
                .ok_or_else(|| String::from("a numeric q beyond safe integers"))?;
            binds.push(Bind::Int(tmdb_id));
            filter = format!(r#"{filter} AND m."tmdbId" = ?{}"#, binds.len());
        }
        let db = &self.state.db;
        let total = db
            .scalar(
                &format!(r#"SELECT COUNT(*) FROM "media" m WHERE {filter}"#),
                &binds,
            )
            .await
            .map_err(|e| format!("counting available media failed: {e:#}"))?;
        let rows = db
            .rows(
                &format!(
                    r#"SELECT {MEDIA_COLUMNS} FROM "media" m WHERE {filter} ORDER BY m."mediaAddedAt" DESC NULLS LAST, m."updatedAt" DESC LIMIT {take} OFFSET {skip}"#
                ),
                &binds,
            )
            .await
            .map_err(|e| format!("listing available media failed: {e:#}"))?;
        let mut titles = Vec::new();
        for row in &rows {
            let media = MediaInfo::from_row(row, self.settings)?;
            let item_id = media
                .jellyfin_media_id
                .clone()
                .or_else(|| media.jellyfin_media_id4k.clone())
                .unwrap_or_default();
            let movie = media.media_type == "movie";
            let mut title = JsObj::default();
            title.put("mediaId", Value::from(media.id));
            title.put("tmdbId", Value::from(media.tmdb_id));
            title.put("mediaType", Value::from(if movie { "movie" } else { "tv" }));
            title.put("jellyfinItemId", Value::from(item_id.as_str()));
            title.set(
                "jellyfinSeriesId",
                (media.media_type == "tv").then(|| Value::from(item_id.as_str())),
            );
            title.put("title", Value::from(if movie { "Movie" } else { "Series" }));
            title.set(
                "mediaUrl",
                media.media_url.or(media.media_url4k).map(Value::from),
            );
            title.put("status", Value::from(media.status));
            titles.push(title);
        }
        let total = to_f64(total);
        if let Link::Linked(linked) = self.link().await? {
            let enriched = filter_playable(self.enrich(&linked.client, titles, None, true).await?);
            return Ok(Page {
                results: values(&enriched),
                total,
                code: None,
            });
        }
        Ok(Page {
            results: values(&titles),
            total,
            code: None,
        })
    }

    /// `listBrowseLibrary`.
    ///
    /// # Errors
    ///
    /// Reasons for Node to answer.
    pub async fn browse(&self, query: &BrowseQuery) -> Result<Page, String> {
        let linked = match self.link().await? {
            Link::Code(code) => return Ok(Page::empty(code)),
            Link::Linked(linked) => linked,
        };
        let year = crate::clock::Utc::now().year;
        let params = crate::librarymap::browse_params(query, linked.client.user_id(), year)?;
        match sure(linked.client.browse(&params).await)? {
            Ok((items, total)) => {
                let titles = self.map_titles(&items).await?;
                Ok(Page {
                    results: values(&titles),
                    total,
                    code: None,
                })
            }
            Err(failure) => {
                tracing::error!("Failed to browse Jellyfin library: {}", failure.message);
                Ok(Page::empty("server_unreachable"))
            }
        }
    }

    /// `getLibraryFacetsForUser`.
    ///
    /// # Errors
    ///
    /// Reasons for Node to answer.
    pub async fn facets(&self, media_type: Option<&str>) -> Result<Value, String> {
        let linked = match self.link().await? {
            Link::Code(code) => return Ok(json!({"genres": [], "code": code})),
            Link::Linked(linked) => linked,
        };
        match sure(linked.client.facets(media_type).await)? {
            Ok((genres, min, max)) => {
                let mut out = Map::new();
                out.insert(String::from("genres"), json!(genres));
                if let Some(min) = min {
                    out.insert(String::from("yearMin"), num(min));
                }
                if let Some(max) = max {
                    out.insert(String::from("yearMax"), num(max));
                }
                Ok(Value::Object(out))
            }
            Err(failure) => {
                tracing::error!("Failed to load library facets: {}", failure.message);
                Ok(json!({"genres": [], "code": "server_unreachable"}))
            }
        }
    }

    /// `getLibraryItemInspector`.
    ///
    /// # Errors
    ///
    /// Reasons for Node to answer.
    pub async fn inspector(&self, item_id: &str) -> Result<Value, String> {
        let stub = |id: &str, media_type: &str, title: &str, code: &str| json!({"jellyfinItemId": id, "mediaType": media_type, "title": title, "code": code});
        let linked = match self.link().await? {
            Link::Code(code) => return Ok(stub(item_id, "movie", "Title", code)),
            Link::Linked(linked) => linked,
        };
        let client = &linked.client;
        let unreachable = |failure: &Failure| -> Result<Value, String> {
            tracing::error!(
                "Failed to load library inspector {item_id}: {}",
                failure.message
            );
            Ok(stub(item_id, "movie", "Title", "server_unreachable"))
        };
        let item = match sure(client.item_data(item_id).await)? {
            Ok(Some(item)) => item,
            Ok(None) => return Ok(stub(item_id, "movie", "Title", "not_found")),
            Err(failure) => return unreachable(&failure),
        };
        let target_id = match item.str("SeriesId").filter(|s| !s.is_empty()) {
            Some(series) if item.is("Episode") => series.to_owned(),
            _ => item.id().to_owned(),
        };
        let target = if target_id == item.id() {
            item
        } else {
            match sure(client.item_data(&target_id).await)? {
                Ok(Some(target)) => target,
                Ok(None) => return Ok(stub(&target_id, "tv", "Series", "not_found")),
                Err(failure) => return unreachable(&failure),
            }
        };
        let is_series = target.is("Series");
        let series_id = target.id().to_owned();
        let targets = [target];
        if is_series {
            let (mapped, series) =
                tokio::join!(self.map_titles(&targets), self.series_detail(&series_id));
            let (mapped, series) = (mapped?, series?);
            let title = mapped.first().cloned().unwrap_or_default();
            let extras = Extras {
                seasons: series.get("seasons").cloned(),
                play_item_id: series.get("playItemId").cloned(),
                play_url: series.get("playUrl").cloned(),
                subtitle: series.get("subtitle").cloned(),
                start: series.get("startPositionTicks").cloned(),
                code: series.get("code").cloned(),
            };
            return Ok(inspector_response(&title, extras));
        }
        let mapped = self.map_titles(&targets).await?;
        let title = mapped.first().cloned().unwrap_or_default();
        let play_url = title
            .str("playItemId")
            .filter(|id| !id.is_empty())
            .and_then(|id| media_url_for_item(self.settings, id))
            .map(Value::from);
        Ok(inspector_response(
            &title,
            Extras {
                play_url,
                ..Extras::default()
            },
        ))
    }

    /// `getLibrarySeriesDetail`.
    ///
    /// # Errors
    ///
    /// Reasons for Node to answer.
    pub async fn series_detail(&self, series_id: &str) -> Result<JsObj, String> {
        let stub = |code: &str| {
            let mut out = JsObj::default();
            out.put("jellyfinSeriesId", Value::from(series_id));
            out.put("title", Value::from("Series"));
            out.put("seasons", json!([]));
            out.put("code", Value::from(code));
            out
        };
        let linked = match self.link().await? {
            Link::Code(code) => return Ok(stub(code)),
            Link::Linked(linked) => linked,
        };
        let client = &linked.client;
        let (seasons, next_up, resume, series_item) = tokio::join!(
            client.seasons(series_id),
            client.next_up(8, Some(series_id)),
            client.resume_items(32),
            client.item_data(series_id)
        );
        let (seasons, next_up, resume, series_item) = (
            sure(seasons)?,
            sure(next_up)?,
            sure(resume)?,
            sure(series_item)?,
        );
        let (Ok(seasons), Ok(next_up), Ok(resume), Ok(series_item)) =
            (seasons, next_up, resume, series_item)
        else {
            tracing::error!("Failed to load library series detail {series_id}");
            return Ok(stub("server_unreachable"));
        };
        let seasons: Vec<Value> = seasons
            .iter()
            .map(|season| {
                let name = season.str("Name").filter(|n| !n.is_empty()).map_or_else(
                    || {
                        format!(
                            "Season {}",
                            season
                                .int("IndexNumber")
                                .map(|n| n.to_string())
                                .unwrap_or_default()
                        )
                    },
                    str::to_owned,
                );
                let mut out = JsObj::default();
                out.put("jellyfinSeasonId", Value::from(season.id()));
                out.put("name", Value::from(name));
                out.set("indexNumber", season.raw("IndexNumber").cloned());
                out.to_value()
            })
            .collect();
        let series_title = series_item
            .as_ref()
            .and_then(|item| item.str("Name"))
            .filter(|n| !n.is_empty())
            .unwrap_or("Series")
            .to_owned();
        let mut target: Option<PlayTarget> = next_up.first().map(next_up_target);
        if target.is_none() {
            let hit = resume
                .iter()
                .find(|e| e.str("SeriesId") == Some(series_id) && e.is("Episode") && resumable(e));
            if let Some(hit) = hit {
                target = resolve_series_play_target(series_id, &[hit], &[hit]);
            }
        }
        if target.is_none() {
            match sure(client.series_episodes(series_id).await)? {
                Ok(episodes) => {
                    let refs: Vec<&Item> = episodes.iter().collect();
                    let resumed: Vec<&Item> = resume
                        .iter()
                        .filter(|e| e.str("SeriesId") == Some(series_id))
                        .collect();
                    target = resolve_series_play_target(series_id, &refs, &resumed);
                }
                Err(failure) => tracing::debug!(
                    "Failed to resolve series rewatch target {series_id}: {}",
                    failure.message
                ),
            }
        }
        let fake = Item::parse(
            &json!({"Id": series_id, "Type": "Series", "ProviderIds": {}}),
            true,
        )
        .map_err(|e| format!("{e:?}"))?;
        let media = self.media_rows(&[fake]).await?;
        let mut out = JsObj::default();
        out.put("jellyfinSeriesId", Value::from(series_id));
        out.set(
            "tmdbId",
            media.get(series_id).map(|m| Value::from(m.tmdb_id)),
        );
        out.put("title", Value::from(series_title));
        out.set(
            "playItemId",
            target
                .as_ref()
                .map(|t| Value::from(t.play_item_id.as_str())),
        );
        out.set(
            "playUrl",
            target
                .as_ref()
                .and_then(|t| media_url_for_item(self.settings, &t.play_item_id))
                .map(Value::from),
        );
        out.set(
            "subtitle",
            target.as_ref().map(|t| Value::from(t.subtitle.as_str())),
        );
        out.set("startPositionTicks", target.and_then(|t| t.start));
        out.put("seasons", Value::Array(seasons));
        Ok(out)
    }

    /// `getLibrarySeasonEpisodes`.
    ///
    /// # Errors
    ///
    /// Reasons for Node to answer.
    pub async fn season_episodes(&self, series_id: &str, season_id: &str) -> Result<Value, String> {
        let stub = |code: &str| json!({"jellyfinSeriesId": series_id, "jellyfinSeasonId": season_id, "episodes": [], "code": code});
        let linked = match self.link().await? {
            Link::Code(code) => return Ok(stub(code)),
            Link::Linked(linked) => linked,
        };
        let items = match sure(linked.client.episodes(series_id, season_id).await)? {
            Ok(items) => items,
            Err(failure) => {
                tracing::error!(
                    "Failed to load library season episodes {series_id}/{season_id}: {}",
                    failure.message
                );
                return Ok(stub("server_unreachable"));
            }
        };
        let episodes: Vec<Value> = items
            .iter()
            .map(|item| {
                let mut out = JsObj::default();
                out.put("jellyfinItemId", Value::from(item.id()));
                out.put(
                    "name",
                    Value::from(
                        item.str("Name")
                            .filter(|n| !n.is_empty())
                            .unwrap_or("Episode"),
                    ),
                );
                out.set("indexNumber", item.raw("IndexNumber").cloned());
                out.set("parentIndexNumber", item.raw("ParentIndexNumber").cloned());
                out.set("subtitle", sxe(item).map(Value::from));
                out.set("overview", item.raw("Overview").cloned());
                out.set(
                    "mediaUrl",
                    media_url_for_item(self.settings, item.id()).map(Value::from),
                );
                out.set("progressPercent", progress_from_item(item).map(num));
                out.set(
                    "startPositionTicks",
                    item.user_raw("PlaybackPositionTicks").cloned(),
                );
                out.put(
                    "watched",
                    Value::Bool(
                        item.played() || item.user_num("PlayedPercentage").unwrap_or(0.0) >= 95.0,
                    ),
                );
                out.to_value()
            })
            .collect();
        Ok(
            json!({"jellyfinSeriesId": series_id, "jellyfinSeasonId": season_id, "episodes": episodes}),
        )
    }

    /// `getLibraryItemImage`, through this process' library image cache.
    ///
    /// # Errors
    ///
    /// Reasons for Node to answer.
    pub async fn image(&self, item_id: &str, primary: bool) -> Result<ImageOutcome, String> {
        if let Some((bytes, content_type)) =
            crate::libraryimagecache::get(self.user_id, item_id, primary)
        {
            return Ok(ImageOutcome::Image(bytes, content_type));
        }
        let linked = match self.link().await? {
            Link::Code(code) => return Ok(ImageOutcome::Error(401, code)),
            Link::Linked(linked) => linked,
        };
        match sure(linked.client.image(item_id, primary).await)? {
            Ok(Some((bytes, content_type))) => {
                crate::libraryimagecache::set(
                    self.user_id,
                    item_id,
                    primary,
                    bytes.clone(),
                    &content_type,
                );
                Ok(ImageOutcome::Image(bytes, content_type))
            }
            Ok(None) => Ok(ImageOutcome::Error(404, "not_found")),
            Err(failure) => {
                tracing::error!(
                    "Failed to proxy library image {item_id}: {}",
                    failure.message
                );
                Ok(ImageOutcome::Error(502, "Failed to load image"))
            }
        }
    }
}

/// `latestEpisodes` of `loadWatchNowSources`: the first episode per series
/// across the lists, newest `DateCreated` first, at most 16.
fn latest_episodes(lists: impl Iterator<Item = Vec<Item>>) -> Result<Vec<Item>, String> {
    let mut by_series: Vec<(String, Item)> = Vec::new();
    for items in lists {
        for item in items {
            let key = item.str("SeriesId").unwrap_or_else(|| item.id()).to_owned();
            if !by_series.iter().any(|(k, _)| *k == key) {
                by_series.push((key, item));
            }
        }
    }
    let mut keyed = by_series
        .into_iter()
        .map(|(_, item)| {
            let ms = match item.str("DateCreated").filter(|d| !d.is_empty()) {
                None => 0,
                Some(date) => crate::clock::parse_date_millis(date)
                    .ok_or_else(|| String::from("a DateCreated of an unusual shape"))?,
            };
            Ok((ms, item))
        })
        .collect::<Result<Vec<_>, String>>()?;
    keyed.sort_by_key(|k| std::cmp::Reverse(k.0));
    Ok(keyed.into_iter().take(16).map(|(_, item)| item).collect())
}

/// The extras `toInspectorResponse` takes.
#[derive(Debug, Default)]
struct Extras {
    seasons: Option<Value>,
    play_url: Option<Value>,
    play_item_id: Option<Value>,
    subtitle: Option<Value>,
    start: Option<Value>,
    code: Option<Value>,
}

/// `toInspectorResponse`.
fn inspector_response(title: &JsObj, extras: Extras) -> Value {
    let field = |key: &str| title.get(key).cloned();
    let mut out = JsObj::default();
    out.set("jellyfinItemId", field("jellyfinItemId"));
    out.set("jellyfinSeriesId", field("jellyfinSeriesId"));
    out.set("mediaType", field("mediaType"));
    out.set("title", field("title"));
    out.set("subtitle", extras.subtitle.or_else(|| field("subtitle")));
    for key in [
        "overview",
        "year",
        "runtimeMinutes",
        "genres",
        "posterUrl",
        "backdropUrl",
        "progressPercent",
        "watched",
        "inProgress",
    ] {
        out.set(key, field(key));
    }
    out.set(
        "startPositionTicks",
        extras.start.or_else(|| field("startPositionTicks")),
    );
    out.set(
        "playItemId",
        extras.play_item_id.or_else(|| field("playItemId")),
    );
    out.set("playUrl", extras.play_url);
    for key in ["mediaUrl", "mediaId", "tmdbId", "status"] {
        out.set(key, field(key));
    }
    out.set("seasons", extras.seasons);
    out.set("code", extras.code);
    out.to_value()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(v: &Value) -> Result<Item, String> {
        Item::parse(v, true).map_err(|e| format!("{e:?}"))
    }

    #[test]
    fn latest_episode_per_series() -> Result<(), String> {
        let lists = vec![
            vec![
                item(
                    &json!({"Id": "a1", "SeriesId": "A", "DateCreated": "2024-01-01T00:00:00.0000000Z"}),
                )?,
                item(
                    &json!({"Id": "a2", "SeriesId": "A", "DateCreated": "2025-01-01T00:00:00.0000000Z"}),
                )?,
            ],
            vec![
                item(
                    &json!({"Id": "b1", "SeriesId": "B", "DateCreated": "2024-06-01T00:00:00.0000000Z"}),
                )?,
                item(&json!({"Id": "c1"}))?,
            ],
        ];
        let ids: Vec<String> = latest_episodes(lists.into_iter())?
            .iter()
            .map(|i| i.id().to_owned())
            .collect();
        assert_eq!(
            ids,
            vec!["b1", "a1", "c1"],
            "first per series, newest first"
        );
        Ok(())
    }

    #[test]
    fn inspector_key_order() {
        let mut title = JsObj::default();
        title.put("mediaId", Value::from(3));
        title.put("mediaType", Value::from("movie"));
        title.put("jellyfinItemId", Value::from("x"));
        title.put("title", Value::from("T"));
        title.put("watched", Value::Bool(false));
        let out = inspector_response(
            &title,
            Extras {
                play_url: Some(Value::from("u")),
                ..Extras::default()
            },
        );
        assert_eq!(
            out.to_string(),
            r#"{"jellyfinItemId":"x","mediaType":"movie","title":"T","watched":false,"playUrl":"u","mediaId":3}"#,
            "toInspectorResponse order"
        );
    }
}
