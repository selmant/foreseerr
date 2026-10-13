//! The parts of Node's `JellyfinAPI` (`server/api/jellyfin.ts`) the library
//! routes use.
//!
//! Same URLs, parameter order, headers and timeout, with each method's
//! error behaviour. Answers whose shape Node would trip over in a
//! way that is hard to mirror are reported as [`JfError::Unsure`], so the
//! caller hands the request to Node (all of these calls only read).

use std::future::Future;
use std::pin::Pin;
use std::task::Poll;
use std::time::Duration;

use reqwest::header::{HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{Map, Value};

use crate::media::js_string;
use crate::settings::public::truthy;
use crate::settings::Settings;
use crate::tmdb::axios_encode;

pub mod actions;

/// `JELLYFIN_LIBRARY_TIMEOUT_MS`.
pub const LIBRARY_TIMEOUT: Duration = Duration::from_secs(15);

/// `BROWSE_ITEM_FIELDS`.
pub const BROWSE_ITEM_FIELDS: &str =
    "ProviderIds,Overview,Genres,ProductionYear,DateCreated,PremiereDate,RunTimeTicks,RecursiveItemCount";

/// `Number.MAX_SAFE_INTEGER`.
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// Why a Jellyfin call gave no answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JfError {
    /// The call failed the way Node's method throws (network error,
    /// timeout, an error status).
    Failed {
        /// The HTTP status, when there was a response.
        status: Option<u16>,
        /// What happened, for the log.
        message: String,
    },
    /// An answer Node might handle differently; Node has to answer.
    Unsure(String),
}

impl JfError {
    fn unsure(why: &str) -> Self {
        Self::Unsure(format!("{why}; Node handles that Jellyfin answer"))
    }
}

/// A boxed future, for [`join_all`].
pub type Job<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

enum Slot<'a, T> {
    Pending(Job<'a, T>),
    Done(Option<T>),
}

/// `Promise.all` without the short-circuit: run every future at once and
/// collect the outputs in order.
pub async fn join_all<'a, T: Send>(jobs: Vec<Job<'a, T>>) -> Vec<T> {
    let mut slots: Vec<Slot<'a, T>> = jobs.into_iter().map(Slot::Pending).collect();
    std::future::poll_fn(move |cx| {
        let mut done = true;
        for slot in &mut slots {
            let ready = match slot {
                Slot::Pending(job) => match job.as_mut().poll(cx) {
                    Poll::Ready(value) => Some(value),
                    Poll::Pending => {
                        done = false;
                        None
                    }
                },
                Slot::Done(_) => None,
            };
            if let Some(value) = ready {
                *slot = Slot::Done(Some(value));
            }
        }
        if done {
            Poll::Ready(
                slots
                    .iter_mut()
                    .filter_map(|slot| match slot {
                        Slot::Done(value) => value.take(),
                        Slot::Pending(_) => None,
                    })
                    .collect(),
            )
        } else {
            Poll::Pending
        }
    })
    .await
}

/// `getHostname()`: the Jellyfin server from `settings.jellyfin`, printed
/// as the template literal does.
#[must_use]
pub fn hostname(settings: &Settings) -> String {
    let scheme = if truthy(settings.get("/jellyfin/useSsl")) {
        "https"
    } else {
        "http"
    };
    format!(
        "{scheme}://{}:{}{}",
        js_string(settings.get("/jellyfin/ip")),
        js_string(settings.get("/jellyfin/port")),
        js_string(settings.get("/jellyfin/urlBase"))
    )
}

/// `buildJellyfinAuthorizationHeader` for a Jellyfin server (Emby would send
/// version `1.0.0`) with a device id and a token.
#[must_use]
pub fn authorization(token: &str, device_id: &str, version: &str) -> String {
    format!(
        r#"MediaBrowser Client="Foreseerr", Device="Foreseerr", DeviceId="{device_id}", Version="{version}", Token="{token}""#
    )
}

/// axios: `combineURLs(baseURL, url)` and `buildURL` with its encoder.
#[must_use]
pub fn axios_url(base: &str, path: &str, params: &[(&str, String)]) -> String {
    let base = base
        .strip_suffix("//")
        .or_else(|| base.strip_suffix('/'))
        .unwrap_or(base);
    let mut url = format!("{base}/{}", path.trim_start_matches('/'));
    if params.is_empty() {
        return url;
    }
    let serialized = params
        .iter()
        .map(|(k, v)| format!("{}={}", axios_encode(k), axios_encode(v)))
        .collect::<Vec<_>>()
        .join("&");
    if let Some(hash) = url.find('#') {
        url.truncate(hash);
    }
    url.push(if url.contains('?') { '&' } else { '?' });
    url.push_str(&serialized);
    url
}

/// The `IncludeItemTypes` value for an optional media type.
#[must_use]
pub fn include_types(media_type: Option<&str>) -> &'static str {
    match media_type {
        Some("movie") => "Movie",
        Some("tv") => "Series",
        _ => "Movie,Series",
    }
}

/// A Jellyfin item whose fields the library code reads have the types it
/// expects (no nulls: Jellyfin leaves those out).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item(Map<String, Value>);

const STR_FIELDS: [&str; 9] = [
    "Id",
    "Name",
    "Type",
    "SeriesName",
    "SeriesId",
    "Overview",
    "DateCreated",
    "PremiereDate",
    "LocationType",
];
const NUM_FIELDS: [&str; 3] = ["RunTimeTicks", "ProductionYear", "RecursiveItemCount"];
const INT_FIELDS: [&str; 2] = ["ParentIndexNumber", "IndexNumber"];
const USER_NUM_FIELDS: [&str; 4] = [
    "PlaybackPositionTicks",
    "PlayedPercentage",
    "RunTimeTicks",
    "UnplayedItemCount",
];

fn finite(v: &Value) -> bool {
    v.as_f64().is_some_and(f64::is_finite)
}

/// A whole number JavaScript prints as an integer.
fn safe_int(v: &Value) -> Option<i64> {
    if let Some(n) = v.as_i64() {
        return (n.abs() <= MAX_SAFE_INTEGER).then_some(n);
    }
    let f = v.as_f64()?;
    if f.fract() != 0.0 || f.abs() > 9_007_199_254_740_991.0 {
        return None;
    }
    format!("{f:.0}").parse().ok()
}

fn fields_ok(map: &Map<String, Value>, strs: &[&str], nums: &[&str], ints: &[&str]) -> bool {
    map.iter().all(|(key, value)| {
        let key = key.as_str();
        if strs.contains(&key) {
            value.is_string()
        } else if nums.contains(&key) {
            finite(value)
        } else if ints.contains(&key) {
            safe_int(value).is_some()
        } else {
            true
        }
    })
}

impl Item {
    /// Check an item's shape. `require_id` is off for seasons, which Node
    /// filters by `Id` itself.
    ///
    /// # Errors
    ///
    /// [`JfError::Unsure`] for anything off.
    pub fn parse(value: &Value, require_id: bool) -> Result<Self, JfError> {
        let Value::Object(map) = value else {
            return Err(JfError::unsure("an item that isn't an object"));
        };
        if !fields_ok(map, &STR_FIELDS, &NUM_FIELDS, &INT_FIELDS) {
            return Err(JfError::unsure("an item field of an unexpected type"));
        }
        if require_id && !map.contains_key("Id") {
            return Err(JfError::unsure("an item without an Id"));
        }
        let arrays_ok = ["Genres", "BackdropImageTags"]
            .iter()
            .all(|key| match map.get(*key) {
                None => true,
                Some(Value::Array(items)) => *key != "Genres" || items.iter().all(Value::is_string),
                Some(_) => false,
            });
        let providers_ok = match map.get("ProviderIds") {
            None => true,
            Some(Value::Object(ids)) => fields_ok(ids, &["Tmdb", "TheMovieDb"], &[], &[]),
            Some(_) => false,
        };
        let user_ok = match map.get("UserData") {
            None => true,
            Some(Value::Object(data)) => {
                fields_ok(data, &["LastPlayedDate"], &USER_NUM_FIELDS, &[])
                    && data.get("Played").is_none_or(Value::is_boolean)
            }
            Some(_) => false,
        };
        if arrays_ok && providers_ok && user_ok {
            Ok(Self(map.clone()))
        } else {
            Err(JfError::unsure("an item field of an unexpected type"))
        }
    }

    /// `item.Id` (empty only for seasons without one).
    #[must_use]
    pub fn id(&self) -> &str {
        self.str("Id").unwrap_or("")
    }

    /// A string field.
    #[must_use]
    pub fn str(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(Value::as_str)
    }

    /// A number field.
    #[must_use]
    pub fn num(&self, key: &str) -> Option<f64> {
        self.0.get(key).and_then(Value::as_f64)
    }

    /// `ParentIndexNumber` / `IndexNumber`.
    #[must_use]
    pub fn int(&self, key: &str) -> Option<i64> {
        self.0.get(key).and_then(safe_int)
    }

    /// A field as it is.
    #[must_use]
    pub fn raw(&self, key: &str) -> Option<&Value> {
        self.0.get(key)
    }

    /// `item.UserData` exists.
    #[must_use]
    pub fn has_user_data(&self) -> bool {
        self.0.contains_key("UserData")
    }

    /// A `UserData` field as it is.
    #[must_use]
    pub fn user_raw(&self, key: &str) -> Option<&Value> {
        self.0.get("UserData").and_then(|data| data.get(key))
    }

    /// A numeric `UserData` field.
    #[must_use]
    pub fn user_num(&self, key: &str) -> Option<f64> {
        self.user_raw(key).and_then(Value::as_f64)
    }

    /// `Boolean(item.UserData?.Played)`.
    #[must_use]
    pub fn played(&self) -> bool {
        self.user_raw("Played").and_then(Value::as_bool) == Some(true)
    }

    /// A `ProviderIds` entry.
    #[must_use]
    pub fn provider(&self, key: &str) -> Option<&str> {
        self.0
            .get("ProviderIds")
            .and_then(|ids| ids.get(key))
            .and_then(Value::as_str)
    }

    /// `item.Type === ty`.
    #[must_use]
    pub fn is(&self, ty: &str) -> bool {
        self.str("Type") == Some(ty)
    }
}

/// `response.Items ?? []` with every item checked.
fn items_or_empty(body: &Map<String, Value>) -> Result<Vec<Item>, JfError> {
    match body.get("Items") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => items.iter().map(|v| Item::parse(v, true)).collect(),
        Some(_) => Err(JfError::unsure("Items that isn't a list")),
    }
}

fn not_virtual(items: Vec<Item>) -> Vec<Item> {
    items
        .into_iter()
        .filter(|item| item.str("LocationType") != Some("Virtual"))
        .collect()
}

/// `sortResumeItemsByDatePlayed`: newest `LastPlayedDate` first, items
/// without one last, stable.
///
/// # Errors
///
/// [`JfError::Unsure`] for a date `Date.parse` may read differently.
pub fn sort_resume(items: Vec<Item>) -> Result<Vec<Item>, JfError> {
    let mut keyed = items
        .into_iter()
        .map(|item| {
            let ms = match item.user_raw("LastPlayedDate").and_then(Value::as_str) {
                None | Some("") => 0,
                Some(text) => crate::clock::parse_date_millis(text)
                    .ok_or_else(|| JfError::unsure("a LastPlayedDate of an unusual shape"))?,
            };
            Ok((ms, item))
        })
        .collect::<Result<Vec<_>, JfError>>()?;
    keyed.sort_by_key(|k| std::cmp::Reverse(k.0));
    Ok(keyed.into_iter().map(|(_, item)| item).collect())
}

/// One user's Jellyfin client, as `createUserJellyfinClient` builds it.
#[derive(Debug, Clone)]
pub struct JellyfinClient {
    http: reqwest::Client,
    base: String,
    auth: HeaderValue,
    user_id: String,
}

const fn failed(status: Option<u16>, message: String) -> JfError {
    JfError::Failed { status, message }
}

impl JellyfinClient {
    /// A client for `base` (`getHostname()`) acting as `user_id`.
    ///
    /// # Errors
    ///
    /// Fails when the authorization header can't be sent as is, or the
    /// user id would need escaping in a path.
    pub fn new(
        http: reqwest::Client,
        base: String,
        authorization: &str,
        user_id: String,
    ) -> Result<Self, String> {
        let auth = HeaderValue::from_str(authorization)
            .map_err(|_| String::from("a Jellyfin token or device id that isn't header-safe"))?;
        if !user_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(String::from("a Jellyfin user id with unusual characters"));
        }
        Ok(Self {
            http,
            base,
            auth,
            user_id,
        })
    }

    /// `this.userId ?? 'Me'`.
    #[must_use]
    pub fn user_id(&self) -> &str {
        &self.user_id
    }

    async fn send(
        &self,
        path: &str,
        params: &[(&str, String)],
        accept: &'static str,
    ) -> Result<reqwest::Response, JfError> {
        let url = axios_url(&self.base, path, params);
        let response = self
            .http
            .get(&url)
            .header(AUTHORIZATION, self.auth.clone())
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, accept)
            .timeout(LIBRARY_TIMEOUT)
            .send()
            .await
            .map_err(|e| failed(None, crate::outbound::describe(&e)))?;
        Ok(response)
    }

    async fn get(
        &self,
        path: &str,
        params: &[(&str, String)],
    ) -> Result<Map<String, Value>, JfError> {
        let response = self.send(path, params, "application/json").await?;
        let status = response.status().as_u16();
        if !response.status().is_success() {
            return Err(failed(
                Some(status),
                format!("Request failed with status code {status}"),
            ));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|e| failed(None, crate::outbound::describe(&e)))?;
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Object(body)) => Ok(body),
            Ok(_) | Err(_) => Err(JfError::unsure("an answer that isn't a JSON object")),
        }
    }

    fn user(&self) -> String {
        self.user_id.clone()
    }

    /// `getResumeItems(limit)`.
    ///
    /// # Errors
    ///
    /// When the call fails or the answer is unusual.
    pub async fn resume_items(&self, limit: i64) -> Result<Vec<Item>, JfError> {
        let path = format!("/Users/{}/Items/Resume", self.user_id);
        let body = self
            .get(
                &path,
                &[
                    ("Limit", limit.to_string()),
                    ("Fields", String::from("ProviderIds,Overview")),
                    ("IncludeItemTypes", String::from("Movie,Episode")),
                    ("EnableUserData", String::from("true")),
                    ("SortBy", String::from("DatePlayed")),
                    ("SortOrder", String::from("Descending")),
                ],
            )
            .await?;
        sort_resume(items_or_empty(&body)?)
    }

    /// `getUserLatestItems(limit)`.
    ///
    /// # Errors
    ///
    /// When the call fails or the answer is unusual.
    pub async fn latest_items(&self, limit: i64) -> Result<Vec<Item>, JfError> {
        let body = self
            .get(
                "/Items",
                &[
                    ("userId", self.user()),
                    ("IncludeItemTypes", String::from("Movie,Series")),
                    ("Recursive", String::from("true")),
                    ("SortBy", String::from("DateCreated")),
                    ("SortOrder", String::from("Descending")),
                    ("Limit", limit.to_string()),
                    ("Fields", String::from(BROWSE_ITEM_FIELDS)),
                    ("EnableUserData", String::from("true")),
                ],
            )
            .await?;
        items_or_empty(&body)
    }

    /// `getUserLatestEpisodes(limit, parentId)`.
    ///
    /// # Errors
    ///
    /// When the call fails or the answer is unusual.
    pub async fn latest_episodes(
        &self,
        limit: i64,
        parent_id: Option<String>,
    ) -> Result<Vec<Item>, JfError> {
        let mut params = vec![
            ("userId", self.user()),
            ("IncludeItemTypes", String::from("Episode")),
            ("Recursive", String::from("true")),
            ("SortBy", String::from("DateCreated")),
            ("SortOrder", String::from("Descending")),
            ("Limit", limit.to_string()),
            (
                "Fields",
                String::from("ProviderIds,Overview,DateCreated,PremiereDate"),
            ),
            ("EnableUserData", String::from("true")),
        ];
        if let Some(parent) = parent_id.filter(|p| !p.is_empty()) {
            params.push(("ParentId", parent));
        }
        let body = self.get("/Items", &params).await?;
        Ok(items_or_empty(&body)?
            .into_iter()
            .filter(|item| item.is("Episode"))
            .collect())
    }

    /// `getNextUpEpisodes(limit, seriesId)`.
    ///
    /// # Errors
    ///
    /// When the call fails or the answer is unusual.
    pub async fn next_up(&self, limit: i64, series_id: Option<&str>) -> Result<Vec<Item>, JfError> {
        let mut params = vec![
            ("UserId", self.user()),
            ("Limit", limit.to_string()),
            ("Fields", String::from("ProviderIds,Overview")),
            ("EnableUserData", String::from("true")),
        ];
        if let Some(series) = series_id.filter(|s| !s.is_empty()) {
            params.push(("SeriesId", series.to_owned()));
        }
        let body = self.get("/Shows/NextUp", &params).await?;
        items_or_empty(&body)
    }

    /// `getItemsData(ids)`. While the availability sync runs, a 500 is an
    /// empty list, as in Node.
    ///
    /// # Errors
    ///
    /// When the call fails or the answer is unusual.
    pub async fn items_data(&self, ids: &[String]) -> Result<Vec<Item>, JfError> {
        let mut unique: Vec<&str> = Vec::new();
        for id in ids {
            if !id.is_empty() && !unique.contains(&id.as_str()) {
                unique.push(id);
            }
        }
        if unique.is_empty() {
            return Ok(Vec::new());
        }
        let body = self
            .get(
                "/Items",
                &[
                    ("ids", unique.join(",")),
                    ("userId", self.user()),
                    ("EnableUserData", String::from("true")),
                    (
                        "fields",
                        format!("{BROWSE_ITEM_FIELDS},MediaSources,Width,Height,IsHD"),
                    ),
                ],
            )
            .await;
        let body = match body {
            Ok(body) => body,
            Err(JfError::Failed {
                status: Some(500), ..
            }) if crate::jobs::availability_sync::running() => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        items_or_empty(&body)
    }

    /// `getItemData(id)`: the first item of the answer.
    ///
    /// # Errors
    ///
    /// When the call fails or the answer is unusual.
    pub async fn item_data(&self, id: &str) -> Result<Option<Item>, JfError> {
        Ok(self.items_data(&[id.to_owned()]).await?.into_iter().next())
    }

    /// `getSeasons(seriesId)`, then `(seasons ?? []).filter(s => s?.Id)`.
    ///
    /// # Errors
    ///
    /// When the call fails or the answer is unusual.
    pub async fn seasons(&self, series_id: &str) -> Result<Vec<Item>, JfError> {
        let path = format!("/Shows/{series_id}/Seasons");
        let body = self
            .get(
                &path,
                &[
                    ("userId", self.user()),
                    ("EnableUserData", String::from("true")),
                    ("Fields", String::from("ProviderIds,Overview")),
                ],
            )
            .await?;
        let raw = match body.get("Items") {
            None | Some(Value::Null) => return Ok(Vec::new()),
            Some(Value::Array(items)) => items,
            Some(_) => return Err(JfError::unsure("Items that isn't a list")),
        };
        let mut seasons = Vec::new();
        for value in raw.iter().filter(|v| !v.is_null()) {
            let season = Item::parse(value, false)?;
            if !season.id().is_empty() {
                seasons.push(season);
            }
        }
        Ok(seasons)
    }

    /// `getEpisodes(seriesId, seasonId)`: a missing `Items` throws there.
    ///
    /// # Errors
    ///
    /// When the call fails or the answer is unusual.
    pub async fn episodes(&self, series_id: &str, season_id: &str) -> Result<Vec<Item>, JfError> {
        let path = format!("/Shows/{series_id}/Episodes");
        let body = self
            .get(
                &path,
                &[
                    ("seasonId", season_id.to_owned()),
                    ("userId", self.user()),
                    ("EnableUserData", String::from("true")),
                    ("Fields", String::from("ProviderIds,Overview")),
                ],
            )
            .await?;
        match body.get("Items") {
            None | Some(Value::Null) => Err(failed(None, String::from("Items is missing"))),
            Some(_) => Ok(not_virtual(items_or_empty(&body)?)),
        }
    }

    /// `getSeriesEpisodes(seriesId)`.
    ///
    /// # Errors
    ///
    /// When the call fails or the answer is unusual.
    pub async fn series_episodes(&self, series_id: &str) -> Result<Vec<Item>, JfError> {
        let path = format!("/Shows/{series_id}/Episodes");
        let body = self
            .get(
                &path,
                &[
                    ("userId", self.user()),
                    ("EnableUserData", String::from("true")),
                    (
                        "Fields",
                        String::from("ProviderIds,Overview,ProductionYear"),
                    ),
                ],
            )
            .await?;
        Ok(not_virtual(items_or_empty(&body)?))
    }

    /// `searchLibraryItems(query, { limit, startIndex, mediaType })`.
    ///
    /// # Errors
    ///
    /// When the call fails or the answer is unusual.
    pub async fn search(
        &self,
        query: &str,
        limit: i64,
        start_index: i64,
        media_type: Option<&str>,
    ) -> Result<Vec<Item>, JfError> {
        let body = self
            .get(
                "/Items",
                &[
                    ("SearchTerm", query.to_owned()),
                    ("Recursive", String::from("true")),
                    ("StartIndex", start_index.max(0).to_string()),
                    ("Limit", limit.to_string()),
                    ("Fields", String::from(BROWSE_ITEM_FIELDS)),
                    ("IncludeItemTypes", String::from(include_types(media_type))),
                    ("EnableUserData", String::from("true")),
                    ("userId", self.user()),
                ],
            )
            .await?;
        items_or_empty(&body)
    }

    /// `browseLibraryItems(params)`: the items and `TotalRecordCount ?? 0`.
    ///
    /// # Errors
    ///
    /// When the call fails or the answer is unusual.
    pub async fn browse(&self, params: &[(&str, String)]) -> Result<(Vec<Item>, f64), JfError> {
        let body = self.get("/Items", params).await?;
        let total = match body.get("TotalRecordCount") {
            None | Some(Value::Null) => 0.0,
            Some(v) if finite(v) => v.as_f64().unwrap_or(0.0),
            Some(_) => return Err(JfError::unsure("a TotalRecordCount that isn't a number")),
        };
        Ok((items_or_empty(&body)?, total))
    }

    /// `getLibraryGenres(mediaType)`: `Filters2`, then `Filters`, then
    /// `Genres`, each tried while the previous gave nothing.
    ///
    /// # Errors
    ///
    /// When the last call fails or an answer is unusual.
    pub async fn genres(&self, media_type: Option<&str>) -> Result<Vec<String>, JfError> {
        let params = [
            ("userId", self.user()),
            ("IncludeItemTypes", String::from(include_types(media_type))),
            ("Recursive", String::from("true")),
        ];
        match self.get("/Items/Filters2", &params).await {
            Ok(body) => {
                let genres = unique_sorted_genres(named(body.get("Genres"))?);
                if !genres.is_empty() {
                    return Ok(genres);
                }
            }
            Err(JfError::Failed { message, .. }) => {
                tracing::debug!(
                    "Jellyfin Filters2 unavailable, falling back to Filters: {message}"
                );
            }
            Err(unsure @ JfError::Unsure(_)) => return Err(unsure),
        }
        match self.get("/Items/Filters", &params).await {
            Ok(body) => {
                let names = match body.get("Genres") {
                    None | Some(Value::Null) => Vec::new(),
                    Some(Value::Array(names)) => names
                        .iter()
                        .filter(|v| !v.is_null())
                        .map(|v| {
                            v.as_str()
                                .map(str::to_owned)
                                .ok_or_else(|| JfError::unsure("a genre that isn't a string"))
                        })
                        .collect::<Result<Vec<_>, _>>()?,
                    Some(_) => return Err(JfError::unsure("Genres that isn't a list")),
                };
                let genres = unique_sorted_genres(names);
                if !genres.is_empty() {
                    return Ok(genres);
                }
            }
            Err(JfError::Failed { message, .. }) => {
                tracing::debug!("Jellyfin Filters unavailable, falling back to Genres: {message}");
            }
            Err(unsure @ JfError::Unsure(_)) => return Err(unsure),
        }
        match self.get("/Genres", &params).await {
            Ok(body) => Ok(unique_sorted_genres(named(body.get("Items"))?)),
            Err(e) => {
                if let JfError::Failed { message, .. } = &e {
                    tracing::error!(
                        "Something went wrong while getting Jellyfin genres: {message}"
                    );
                }
                Err(e)
            }
        }
    }

    /// `getLibraryYearBound(order, mediaType)`.
    ///
    /// # Errors
    ///
    /// When the call fails or the answer is unusual.
    pub async fn year_bound(
        &self,
        order: &str,
        media_type: Option<&str>,
    ) -> Result<Option<f64>, JfError> {
        let body = self
            .get(
                "/Items",
                &[
                    ("userId", self.user()),
                    ("IncludeItemTypes", String::from(include_types(media_type))),
                    ("Recursive", String::from("true")),
                    ("SortBy", String::from("ProductionYear")),
                    ("SortOrder", order.to_owned()),
                    ("Limit", String::from("1")),
                    ("Fields", String::from("PremiereDate,ProductionYear")),
                ],
            )
            .await?;
        let Some(item) = items_or_empty(&body)?.into_iter().next() else {
            return Ok(None);
        };
        if let Some(year) = item.num("ProductionYear").filter(|y| *y != 0.0) {
            return Ok(Some(year));
        }
        match item.str("PremiereDate").filter(|d| !d.is_empty()) {
            None => Ok(None),
            Some(date) => {
                let ms = crate::clock::parse_date_millis(date)
                    .ok_or_else(|| JfError::unsure("a PremiereDate of an unusual shape"))?;
                let year = crate::clock::Utc::from_unix_millis(ms).year;
                Ok(Some(year.to_string().parse::<f64>().unwrap_or(0.0)))
            }
        }
    }

    /// `getLibraryFacets(mediaType)`: genres and the year bounds, all at
    /// once; any failure fails the lot.
    ///
    /// # Errors
    ///
    /// When a call fails or an answer is unusual.
    pub async fn facets(
        &self,
        media_type: Option<&str>,
    ) -> Result<(Vec<String>, Option<f64>, Option<f64>), JfError> {
        let (genres, min, max) = tokio::join!(
            self.genres(media_type),
            self.year_bound("Ascending", media_type),
            self.year_bound("Descending", media_type)
        );
        for result in [
            genres.as_ref().err(),
            min.as_ref().err(),
            max.as_ref().err(),
        ] {
            if let Some(unsure @ JfError::Unsure(_)) = result {
                return Err(unsure.clone());
            }
        }
        Ok((genres?, min?, max?))
    }

    /// `getItemImage(id, imageType)`: the bytes and content type, or none
    /// on a 404. Only 200 and 404 count as answers.
    ///
    /// # Errors
    ///
    /// When the call fails or the content type can't be passed on.
    pub async fn image(
        &self,
        item_id: &str,
        primary: bool,
    ) -> Result<Option<(bytes::Bytes, String)>, JfError> {
        let (name, width) = if primary {
            ("Primary", "400")
        } else {
            ("Backdrop", "1280")
        };
        let path = format!("/Items/{item_id}/Images/{name}");
        let response = self
            .send(
                &path,
                &[
                    ("maxWidth", String::from(width)),
                    ("quality", String::from("90")),
                ],
                "image/*",
            )
            .await?;
        let status = response.status().as_u16();
        if status == 404 {
            return Ok(None);
        }
        if status != 200 {
            return Err(failed(
                Some(status),
                format!("Request failed with status code {status}"),
            ));
        }
        let content_type = match response.headers().get(CONTENT_TYPE) {
            None => String::from("image/jpeg"),
            Some(value) => value
                .to_str()
                .map_err(|_| JfError::unsure("an image content type that isn't plain ASCII"))?
                .to_owned(),
        };
        let bytes = response
            .bytes()
            .await
            .map_err(|e| failed(None, crate::outbound::describe(&e)))?;
        Ok(Some((bytes, content_type)))
    }
}

/// `list.map(x => x.Name)` for `Filters2.Genres` and `Genres.Items`;
/// null entries and missing names are skipped like `raw?.trim()` does.
fn named(list: Option<&Value>) -> Result<Vec<String>, JfError> {
    let items = match list {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(items)) => items,
        Some(_) => return Err(JfError::unsure("a genre list that isn't a list")),
    };
    let mut names = Vec::new();
    for item in items {
        let Value::Object(entry) = item else {
            return Err(JfError::unsure("a genre entry that isn't an object"));
        };
        match entry.get("Name") {
            None | Some(Value::Null) => {}
            Some(Value::String(name)) => names.push(name.clone()),
            Some(_) => return Err(JfError::unsure("a genre name that isn't a string")),
        }
    }
    Ok(names)
}

/// JavaScript's `String.prototype.trim`: `WhiteSpace` and line terminators,
/// which is Unicode `White_Space` minus U+0085 plus U+FEFF.
#[must_use]
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

/// `uniqueSortedGenres`: trimmed, first spelling of each lower-cased name.
///
/// Sorted with `localeCompare(…, { sensitivity: 'base' })` as
/// [`crate::jsval::base_collation_key`] approximates it; ties keep their
/// order.
#[must_use]
pub fn unique_sorted_genres(names: Vec<String>) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    let mut unique: Vec<(Vec<(u8, u32)>, String)> = Vec::new();
    for raw in names {
        let name = js_trim(&raw);
        if name.is_empty() {
            continue;
        }
        let lower = name.to_lowercase();
        if seen.contains(&lower) {
            continue;
        }
        seen.push(lower);
        unique.push((crate::jsval::base_collation_key(name), name.to_owned()));
    }
    unique.sort_by(|a, b| a.0.cmp(&b.0));
    unique.into_iter().map(|(_, name)| name).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_urls_like_axios() {
        assert_eq!(
            axios_url(
                "http://jf:8096/",
                "/Items",
                &[("ids", String::from("a,b")), ("q", String::from("x y&z"))]
            ),
            "http://jf:8096/Items?ids=a,b&q=x+y%26z",
            "trailing slash, encoding"
        );
        assert_eq!(
            axios_url("http://jf:8096/base", "/Shows/NextUp", &[]),
            "http://jf:8096/base/Shows/NextUp",
            "no params"
        );
    }

    #[test]
    fn authorization_header() {
        assert_eq!(
            authorization("tok", "dev", "0.13.1"),
            r#"MediaBrowser Client="Foreseerr", Device="Foreseerr", DeviceId="dev", Version="0.13.1", Token="tok""#,
            "header"
        );
    }

    #[test]
    fn checks_item_shapes() {
        assert!(
            Item::parse(
                &json!({"Id": "a", "UserData": {"Played": true, "PlayedPercentage": 12.5}}),
                true
            )
            .is_ok(),
            "plain item"
        );
        assert!(
            Item::parse(&json!({"Id": "a", "Overview": null}), true).is_err(),
            "null"
        );
        assert!(
            Item::parse(&json!({"Id": "a", "IndexNumber": 1.5}), true).is_err(),
            "fractional index"
        );
        assert!(Item::parse(&json!({"Name": "x"}), true).is_err(), "no id");
        assert!(
            Item::parse(&json!({"Name": "x"}), false).is_ok(),
            "season without id"
        );
        assert!(
            Item::parse(&json!({"Id": "a", "ProviderIds": {"Tmdb": 5}}), true).is_err(),
            "numeric provider id"
        );
    }

    #[test]
    fn sorts_resume_items() -> Result<(), JfError> {
        let items = vec![
            Item::parse(
                &json!({"Id": "old", "UserData": {"LastPlayedDate": "2024-01-01T00:00:00.0000000Z"}}),
                true,
            )?,
            Item::parse(&json!({"Id": "none"}), true)?,
            Item::parse(
                &json!({"Id": "new", "UserData": {"LastPlayedDate": "2025-01-01T00:00:00.0000000Z"}}),
                true,
            )?,
        ];
        let ids: Vec<String> = sort_resume(items)?
            .iter()
            .map(|i| i.id().to_owned())
            .collect();
        assert_eq!(ids, vec!["new", "old", "none"], "newest first");
        Ok(())
    }

    #[test]
    fn genres_unique_and_sorted() {
        let names = [
            "drama",
            " Action ",
            "Action & Adventure",
            "action",
            "Sci-Fi",
            "Sci Fi",
            "10s",
            "",
        ]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
        assert_eq!(
            unique_sorted_genres(names),
            vec![
                "10s",
                "Action",
                "Action & Adventure",
                "drama",
                "Sci Fi",
                "Sci-Fi"
            ],
            "deduped, base collation"
        );
        let turkish = [
            "Suç",
            "Aile",
            "Çocuk",
            "Bilim Kurgu",
            "Belgesel",
            "Vahşi Batı",
            "Vahşi Batz",
            "cocuk",
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(
            unique_sorted_genres(turkish),
            vec![
                "Aile",
                "Belgesel",
                "Bilim Kurgu",
                "Çocuk",
                "cocuk",
                "Suç",
                "Vahşi Batı",
                "Vahşi Batz"
            ],
            "accents folded, ties in order, dotless i with i"
        );
    }

    #[test]
    fn trims_like_javascript() {
        assert_eq!(js_trim("\u{feff} a \n"), "a", "BOM and whitespace");
        assert_eq!(js_trim("\u{85}a"), "\u{85}a", "NEL is not JS whitespace");
    }

    #[test]
    fn include_type_values() {
        assert_eq!(include_types(Some("movie")), "Movie", "movie");
        assert_eq!(include_types(Some("tv")), "Series", "tv");
        assert_eq!(include_types(None), "Movie,Series", "both");
    }
}
