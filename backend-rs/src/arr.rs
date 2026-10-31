//! `RadarrAPI.addMovie`, `SonarrAPI.addSeries` and the calls they make,
//! with the same request bodies and fallbacks.

use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use reqwest::Method;
use serde_json::{json, Map, Value};

use crate::episodeorder::{self, AiredSource};
use crate::servarr::ServarrClient;
use crate::sonarrv5::ApiVersion;

/// `RadarrMovieOptions`.
#[derive(Debug, Clone)]
pub struct MovieOptions {
    /// `profileId` and `qualityProfileId`.
    pub quality_profile: Value,
    /// `rootFolderPath`.
    pub root_folder: Value,
    /// `minimumAvailability`.
    pub minimum_availability: Value,
    /// `title`.
    pub title: Value,
    /// `tmdbId`.
    pub tmdb_id: i64,
    /// `year`: `Number(release_date.slice(0, 4))`.
    pub year: Value,
    /// `tags`.
    pub tags: Vec<Value>,
    /// `searchNow`.
    pub search_now: bool,
}

/// `AddSeriesOptions`.
#[derive(Debug, Clone)]
pub struct SeriesOptions {
    /// `profileId`.
    pub quality_profile: Value,
    /// `languageProfileId`.
    pub language_profile: Value,
    /// `rootFolderPath`.
    pub root_folder: Value,
    /// `title`.
    pub title: Value,
    /// `tvdbid`.
    pub tvdb_id: i64,
    /// `seasons`.
    pub seasons: Vec<i64>,
    /// `episodeTvdbIds`.
    pub episode_tvdb_ids: Option<Vec<i64>>,
    /// `seasonFolder`.
    pub season_folder: Value,
    /// `seriesType`.
    pub series_type: Value,
    /// `tags`.
    pub tags: Vec<Value>,
    /// `monitorNewItems`.
    pub monitor_new_items: Value,
    /// `searchNow`.
    pub search_now: bool,
}

/// One Radarr or Sonarr server.
#[derive(Debug, Clone)]
pub struct Arr<'a> {
    /// The shared client.
    pub client: &'a ServarrClient,
    /// The server's settings entry.
    pub server: &'a Value,
    /// `network.apiRequestTimeout`.
    pub timeout: Option<Duration>,
}

fn object(pairs: Vec<(&str, Value)>) -> Value {
    let mut out = Map::new();
    for (k, v) in pairs {
        out.insert(k.to_owned(), v);
    }
    Value::Object(out)
}

impl Arr<'_> {
    async fn get(&self, path: &str, query: &[(&str, String)]) -> Result<Value> {
        self.client
            .call(self.server, Method::GET, path, query, None, self.timeout)
            .await
    }

    async fn send(&self, method: Method, path: &str, body: &Value) -> Result<Value> {
        self.client
            .call(self.server, method, path, &[], Some(body), self.timeout)
            .await
    }

    /// `getTags`.
    ///
    /// # Errors
    ///
    /// Fails when the call fails.
    pub async fn tags(&self) -> Result<Vec<Value>> {
        Ok(self
            .get("/tag", &[])
            .await?
            .as_array()
            .cloned()
            .unwrap_or_default())
    }

    /// `createTag`.
    ///
    /// # Errors
    ///
    /// Fails when the call fails.
    pub async fn create_tag(&self, label: &str) -> Result<Value> {
        self.send(
            Method::POST,
            "/tag",
            &object(vec![("label", Value::from(label))]),
        )
        .await
    }

    /// `runCommand`.
    async fn command(&self, name: &str, options: Vec<(&str, Value)>) -> Result<Value> {
        let mut body = vec![("name", Value::from(name))];
        body.extend(options);
        self.send(Method::POST, "/command", &object(body)).await
    }

    /// `getMovieByTmdbId`: the first lookup result.
    async fn movie_lookup(&self, tmdb_id: i64) -> Result<Value> {
        let found = self
            .get("/movie/lookup", &[("term", format!("tmdb:{tmdb_id}"))])
            .await?;
        found
            .as_array()
            .and_then(|a| a.first())
            .cloned()
            .ok_or_else(|| anyhow!("Movie not found"))
    }

    /// `searchMovie`: fire and forget, failures logged.
    async fn search_movie(&self, id: &Value) {
        if let Err(e) = self
            .command(
                "MoviesSearch",
                vec![("movieIds", Value::Array(vec![id.clone()]))],
            )
            .await
        {
            tracing::error!("Something went wrong while executing Radarr movie search: {e:#}");
        }
    }

    /// `RadarrAPI.addMovie`.
    ///
    /// # Errors
    ///
    /// `Failed to add movie to Radarr` when any step fails.
    pub async fn add_movie(&self, o: &MovieOptions) -> Result<Value> {
        self.add_movie_inner(o)
            .await
            .map_err(|e| e.context("Failed to add movie to Radarr"))
    }

    async fn add_movie_inner(&self, o: &MovieOptions) -> Result<Value> {
        let movie = self.movie_lookup(o.tmdb_id).await?;
        let truthy = |k: &str| crate::settings::public::truthy(movie.get(k));
        if truthy("hasFile") {
            return Ok(movie);
        }
        let id = movie.get("id").cloned().unwrap_or(Value::Null);
        if truthy("id") && !truthy("monitored") {
            let mut body = movie.as_object().cloned().unwrap_or_default();
            let mut tags: Vec<Value> = movie
                .get("tags")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for tag in &o.tags {
                if !tags.contains(tag) {
                    tags.push(tag.clone());
                }
            }
            for (k, v) in [
                ("title", o.title.clone()),
                ("qualityProfileId", o.quality_profile.clone()),
                ("profileId", o.quality_profile.clone()),
                ("titleSlug", Value::from(o.tmdb_id.to_string())),
                ("minimumAvailability", o.minimum_availability.clone()),
                ("tmdbId", Value::from(o.tmdb_id)),
                ("year", o.year.clone()),
                ("tags", Value::Array(tags)),
                ("rootFolderPath", o.root_folder.clone()),
                ("monitored", Value::Bool(true)),
                (
                    "addOptions",
                    object(vec![("searchForMovie", Value::Bool(o.search_now))]),
                ),
            ] {
                body.insert(k.to_owned(), v);
            }
            let updated = self
                .send(Method::PUT, "/movie", &Value::Object(body))
                .await?;
            if crate::settings::public::truthy(updated.get("monitored")) {
                if o.search_now {
                    let id = updated.get("id").cloned().unwrap_or(Value::Null);
                    self.search_movie(&id).await;
                }
                return Ok(updated);
            }
            bail!("Failed to update existing movie in Radarr");
        }
        if truthy("id") {
            if o.search_now && !truthy("hasFile") {
                self.search_movie(&id).await;
            }
            return Ok(movie);
        }
        let body = object(vec![
            ("title", o.title.clone()),
            ("qualityProfileId", o.quality_profile.clone()),
            ("profileId", o.quality_profile.clone()),
            ("titleSlug", Value::from(o.tmdb_id.to_string())),
            ("minimumAvailability", o.minimum_availability.clone()),
            ("tmdbId", Value::from(o.tmdb_id)),
            ("year", o.year.clone()),
            ("rootFolderPath", o.root_folder.clone()),
            ("monitored", Value::Bool(true)),
            ("tags", Value::Array(o.tags.clone())),
            (
                "addOptions",
                object(vec![("searchForMovie", Value::Bool(o.search_now))]),
            ),
        ]);
        let created = self.send(Method::POST, "/movie", &body).await?;
        if !crate::settings::public::truthy(created.get("id")) {
            bail!("Failed to add movie to Radarr");
        }
        Ok(created)
    }

    /// `getEpisodes`.
    ///
    /// # Errors
    ///
    /// Fails when the call fails.
    pub async fn episodes(&self, series_id: &Value) -> Result<Vec<Value>> {
        let id = crate::media::js_string(Some(series_id)).into_owned();
        Ok(self
            .get("/episode", &[("seriesId", id)])
            .await?
            .as_array()
            .cloned()
            .unwrap_or_default())
    }

    async fn monitor_episodes(&self, ids: Vec<Value>) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        self.send(
            Method::PUT,
            "/episode/monitor",
            &object(vec![
                ("episodeIds", Value::Array(ids)),
                ("monitored", Value::Bool(true)),
            ]),
        )
        .await?;
        Ok(())
    }

    /// `buildSeasonList`.
    fn season_list(seasons: &[i64], existing: Option<Vec<Value>>) -> Value {
        existing.map_or_else(
            || {
                Value::Array(
                    seasons
                        .iter()
                        .map(|n| {
                            object(vec![
                                ("seasonNumber", Value::from(*n)),
                                ("monitored", Value::Bool(true)),
                            ])
                        })
                        .collect(),
                )
            },
            |existing| {
                Value::Array(
                    existing
                        .into_iter()
                        .map(|mut season| {
                            let n = season.get("seasonNumber").and_then(Value::as_i64);
                            if n.is_some_and(|n| seasons.contains(&n)) {
                                if let Value::Object(map) = &mut season {
                                    map.insert(String::from("monitored"), Value::Bool(true));
                                }
                            }
                            season
                        })
                        .collect(),
                )
            },
        )
    }

    /// Monitor an existing series, add `tags` to it and monitor its
    /// `seasons` by number; the series as it is now.
    async fn update_existing(
        &self,
        existing: &Value,
        tags: &[Value],
        seasons: &[i64],
    ) -> Result<Value> {
        let api = self.client.api_version(self.server, self.timeout).await;
        let patched = patched_series(existing, tags, seasons);
        let mut answer = Value::Null;
        for (method, path, body) in series_writes(api, existing, &patched, tags, seasons) {
            answer = self.send(method, &path, &body).await?;
        }
        Ok(match api {
            ApiVersion::V3 => answer,
            ApiVersion::V5 => patched,
        })
    }

    /// Monitor the episodes of the requested aired seasons on a series
    /// Sonarr numbers in another `order`, matched by TVDB episode id: its
    /// own seasons of the same numbers hold other episodes. The requested
    /// aired seasons the order leaves out entirely come back: nothing of
    /// them is monitored, and Sonarr can't download them.
    ///
    /// # Errors
    ///
    /// When TVDB or Sonarr can't be asked, or the order leaves out every
    /// requested season.
    async fn monitor_aired_seasons(
        &self,
        series_id: &Value,
        o: &SeriesOptions,
        order: &str,
        aired: &dyn AiredSource,
    ) -> Result<Vec<i64>> {
        let series = crate::media::js_string(Some(series_id));
        let catalog = aired.aired(o.tvdb_id).await.map_err(|e| {
            e.context(format!(
                "[TVDB] TVDB couldn't be reached for the aired episode order of TVDB series {}, which series {series} needs as Sonarr numbers it in the {order} order; the request can be retried once TVDB answers",
                o.tvdb_id
            ))
        })?;
        let episodes = self.episodes(series_id).await?;
        let (kept, left_out) = episodeorder::seasons_in_order(&catalog, &o.seasons, &episodes);
        if kept.is_empty() {
            bail!(
                "None of the requested aired seasons ({}) have episodes in the {order} episode order series {series} uses in Sonarr, so Sonarr can't download them",
                joined(&left_out)
            );
        }
        if !left_out.is_empty() {
            tracing::warn!(
                "[Sonarr] Aired season(s) {} have no episodes in the {order} episode order of series {series}, so Sonarr can't download them; monitoring aired season(s) {} only",
                joined(&left_out),
                joined(&kept)
            );
        }
        let wanted = episodeorder::season_episodes(&catalog, &kept);
        let missing = episodeorder::missing(&wanted, &episodes);
        if !missing.is_empty() {
            tracing::warn!(
                "[Sonarr] {} episode(s) of aired season(s) {} are not in the {order} episode order of series {series}, so Sonarr can't download them (TVDB {})",
                missing.len(),
                joined(&kept),
                joined(&missing)
            );
        }
        let found = episodeorder::by_tvdb(&episodes);
        let ids: Vec<Value> = wanted
            .iter()
            .filter_map(|t| found.get(t))
            .filter(|e| !crate::settings::public::truthy(e.get("monitored")))
            .filter_map(|e| e.get("id").cloned())
            .collect();
        self.monitor_episodes(ids).await?;
        Ok(left_out)
    }

    /// `applyEpisodeSelection`. On a series Sonarr numbers in another
    /// `order` than the aired one, requested episodes that order leaves
    /// out are skipped rather than waited for: no refresh brings them.
    async fn apply_episode_selection(
        &self,
        series_id: &Value,
        wanted: &[i64],
        search_now: bool,
        attempts: u32,
        wait_add_options: bool,
        order: Option<&str>,
    ) -> Result<()> {
        if wait_add_options {
            for attempt in 1..=attempts {
                let series = self
                    .get(
                        &format!("/series/{}", crate::media::js_string(Some(series_id))),
                        &[],
                    )
                    .await?;
                if !crate::settings::public::truthy(series.get("addOptions")) || attempt == attempts
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
        let mut episodes = Vec::new();
        for attempt in 1..=attempts {
            episodes = self
                .episodes(series_id)
                .await?
                .into_iter()
                .filter(|e| {
                    e.get("tvdbId")
                        .and_then(Value::as_i64)
                        .is_some_and(|t| wanted.contains(&t))
                })
                .collect();
            let resolved: Vec<i64> = episodes
                .iter()
                .filter_map(|e| e.get("tvdbId").and_then(Value::as_i64))
                .collect();
            let unresolved: Vec<i64> = wanted
                .iter()
                .copied()
                .filter(|w| !resolved.contains(w))
                .collect();
            if unresolved.is_empty() {
                break;
            }
            if let Some(order) = order {
                tracing::debug!(
                    "[Sonarr] TVDB episodes {} are not in the {order} episode order of series {}; they are left out",
                    unresolved
                        .iter()
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                        .join(", "),
                    crate::media::js_string(Some(series_id))
                );
                break;
            }
            if attempt == attempts {
                bail!(
                    "[Sonarr] Failed to resolve TVDB episode IDs: {}",
                    unresolved
                        .iter()
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                );
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let truthy = |e: &Value, k: &str| crate::settings::public::truthy(e.get(k));
        let missing: Vec<&Value> = episodes.iter().filter(|e| !truthy(e, "hasFile")).collect();
        let unmonitored: Vec<Value> = missing
            .iter()
            .filter(|e| !truthy(e, "monitored"))
            .filter_map(|e| e.get("id").cloned())
            .collect();
        self.monitor_episodes(unmonitored).await?;
        if search_now {
            let now = crate::clock::now_millis();
            let aired: Vec<Value> = missing
                .iter()
                .filter(|e| aired(e, now))
                .filter_map(|e| e.get("id").cloned())
                .collect();
            if !aired.is_empty() {
                self.command("EpisodeSearch", vec![("episodeIds", Value::Array(aired))])
                    .await?;
            }
        }
        Ok(())
    }

    /// `SonarrAPI.addSeries`. `aired` gives the aired order of a series
    /// Sonarr numbers in another one.
    ///
    /// # Errors
    ///
    /// `Failed to add series` when any step fails.
    pub async fn add_series(
        &self,
        o: &SeriesOptions,
        aired: &dyn AiredSource,
    ) -> Result<SeriesAdded> {
        self.add_series_inner(o, aired)
            .await
            .map_err(|e| e.context("Failed to add series"))
    }

    async fn add_series_inner(
        &self,
        o: &SeriesOptions,
        aired: &dyn AiredSource,
    ) -> Result<SeriesAdded> {
        let found = self
            .get("/series/lookup", &[("term", format!("tvdb:{}", o.tvdb_id))])
            .await?;
        let series = found
            .as_array()
            .and_then(|a| a.first())
            .cloned()
            .ok_or_else(|| anyhow!("Series not found"))?;
        let episode_ids = o.episode_tvdb_ids.as_ref().filter(|ids| !ids.is_empty());
        if crate::settings::public::truthy(series.get("id")) {
            let id = crate::media::js_string(series.get("id")).into_owned();
            let existing = self.get(&format!("/series/{id}"), &[]).await?;
            // The requested seasons are aired seasons: in another order,
            // Sonarr's seasons of those numbers hold other episodes.
            let order = episodeorder::other_order(&existing).map(str::to_owned);
            let by_number: &[i64] = if order.is_none() { &o.seasons } else { &[] };
            let updated = self.update_existing(&existing, &o.tags, by_number).await?;
            let Some(updated_id) = updated
                .get("id")
                .filter(|v| crate::settings::public::truthy(Some(v)))
                .cloned()
            else {
                bail!("Failed to update series in Sonarr");
            };
            let mut left_out_seasons = Vec::new();
            if let Some(ids) = episode_ids {
                self.apply_episode_selection(
                    &updated_id,
                    ids,
                    o.search_now,
                    1,
                    false,
                    order.as_deref(),
                )
                .await?;
            } else {
                // A rolling request created without episodes asks for no
                // season: its episode sync monitors the episodes later.
                let by_season = !o.seasons.is_empty();
                if let Some(order) = order.as_deref().filter(|_| by_season) {
                    left_out_seasons = self
                        .monitor_aired_seasons(&updated_id, o, order, aired)
                        .await?;
                } else if by_season {
                    match self.episodes(&updated_id).await {
                        Ok(episodes) => {
                            let ids: Vec<Value> = episodes
                                .iter()
                                .filter(|e| {
                                    e.get("seasonNumber")
                                        .and_then(Value::as_i64)
                                        .is_some_and(|n| o.seasons.contains(&n))
                                        && !crate::settings::public::truthy(e.get("monitored"))
                                })
                                .filter_map(|e| e.get("id").cloned())
                                .collect();
                            if let Err(e) = self.monitor_episodes(ids).await {
                                tracing::error!("Sonarr re-monitoring failed: {e:#}");
                            }
                        }
                        Err(e) => tracing::error!("Sonarr episodes failed: {e:#}"),
                    }
                }
                if o.search_now {
                    if let Err(e) = self
                        .command(
                            "MissingEpisodeSearch",
                            vec![("seriesId", updated_id.clone())],
                        )
                        .await
                    {
                        tracing::error!("Something went wrong while executing Sonarr missing episode search: {e:#}");
                    }
                }
            }
            return Ok(SeriesAdded {
                series: updated,
                left_out_seasons,
            });
        }
        let lookup_seasons: Vec<Value> = series
            .get("seasons")
            .and_then(Value::as_array)
            .map(|seasons| {
                seasons
                    .iter()
                    .map(|s| {
                        object(vec![
                            (
                                "seasonNumber",
                                s.get("seasonNumber").cloned().unwrap_or(Value::Null),
                            ),
                            ("monitored", Value::Bool(false)),
                        ])
                    })
                    .collect()
            })
            .unwrap_or_default();
        let search_missing = if episode_ids.is_none() {
            o.search_now
        } else {
            false
        };
        let mut fields = vec![
            ("tvdbId", Value::from(o.tvdb_id)),
            ("title", o.title.clone()),
            ("qualityProfileId", o.quality_profile.clone()),
        ];
        if !o.language_profile.is_null() {
            fields.push(("languageProfileId", o.language_profile.clone()));
        }
        // Sonarr 5 requires both. The lookup carries the server's preferred
        // metadata language (English, which v3 adds with, when it doesn't);
        // aired order keeps the season and episode numbers TMDB uses.
        let language = series
            .get("language")
            .filter(|l| !l.is_null())
            .cloned()
            .unwrap_or_else(|| serde_json::json!({ "id": 1, "name": "English" }));
        fields.push(("language", language));
        fields.push(("seasonType", Value::from("official")));
        fields.extend([
            (
                "seasons",
                Self::season_list(&o.seasons, Some(lookup_seasons)),
            ),
            ("tags", Value::Array(o.tags.clone())),
            ("seasonFolder", o.season_folder.clone()),
            ("monitored", Value::Bool(true)),
        ]);
        if !o.monitor_new_items.is_null() {
            fields.push(("monitorNewItems", o.monitor_new_items.clone()));
        }
        fields.extend([
            ("rootFolderPath", o.root_folder.clone()),
            ("seriesType", o.series_type.clone()),
            (
                "addOptions",
                object(vec![
                    ("ignoreEpisodesWithFiles", Value::Bool(true)),
                    ("searchForMissingEpisodes", Value::Bool(search_missing)),
                ]),
            ),
        ]);
        let created = self.send(Method::POST, "/series", &object(fields)).await?;
        let Some(created_id) = created
            .get("id")
            .filter(|v| crate::settings::public::truthy(Some(v)))
            .cloned()
        else {
            bail!("Failed to add series to Sonarr");
        };
        if let Some(ids) = episode_ids {
            self.apply_episode_selection(
                &created_id,
                ids,
                o.search_now,
                30,
                true,
                episodeorder::other_order(&created),
            )
            .await?;
        }
        Ok(SeriesAdded {
            series: created,
            left_out_seasons: Vec::new(),
        })
    }
}

/// What `addSeries` left in Sonarr.
#[derive(Debug, Clone)]
pub struct SeriesAdded {
    /// The series as Sonarr has it now.
    pub series: Value,
    /// The requested aired seasons the order the series uses in Sonarr
    /// leaves out entirely: nothing of them is monitored, and Sonarr can't
    /// download them.
    pub left_out_seasons: Vec<i64>,
}

/// Numbers for a log line: `1, 2, 3`.
fn joined(numbers: &[i64]) -> String {
    numbers
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

/// An existing series as `addSeries` leaves it: monitored, with the
/// request's `tags` added and its `seasons` monitored by number.
fn patched_series(existing: &Value, tags: &[Value], seasons: &[i64]) -> Value {
    let mut body = existing.as_object().cloned().unwrap_or_default();
    let mut merged: Vec<Value> = existing
        .get("tags")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for tag in tags {
        if !merged.contains(tag) {
            merged.push(tag.clone());
        }
    }
    body.insert(String::from("monitored"), Value::Bool(true));
    body.insert(String::from("tags"), Value::Array(merged));
    body.insert(
        String::from("seasons"),
        Arr::season_list(
            seasons,
            existing.get("seasons").and_then(Value::as_array).cloned(),
        ),
    );
    body.shift_remove("addOptions");
    Value::Object(body)
}

/// The writes, in order, that leave `existing` as `patched`: method, path
/// and body.
///
/// Sonarr 5 takes each change on its own. Its series editor sets
/// `monitored` and adds the tags, and `PUT /series/{id}/season` monitors one
/// season, and that season's episodes, under Sonarr's lock of the series;
/// changes made in Sonarr since `existing` was read survive. Older Sonarrs
/// only take the whole series back.
fn series_writes(
    api: ApiVersion,
    existing: &Value,
    patched: &Value,
    tags: &[Value],
    seasons: &[i64],
) -> Vec<(Method, String, Value)> {
    if api == ApiVersion::V3 {
        return vec![(Method::PUT, String::from("/series"), patched.clone())];
    }
    let id = existing.get("id").cloned().unwrap_or(Value::Null);
    let current: &[Value] = existing
        .get("tags")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice);
    let mut added: Vec<Value> = Vec::new();
    for tag in tags {
        if !current.contains(tag) && !added.contains(tag) {
            added.push(tag.clone());
        }
    }
    let mut writes = Vec::new();
    if !crate::settings::public::truthy(existing.get("monitored")) || !added.is_empty() {
        writes.push((
            Method::PUT,
            String::from("/series/editor"),
            json!({ "seriesIds": [id], "monitored": true, "tags": added, "applyTags": "add" }),
        ));
    }
    let path = format!("/series/{}/season", crate::media::js_string(Some(&id)));
    for season in existing
        .get("seasons")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
    {
        let Some(number) = season.get("seasonNumber").and_then(Value::as_i64) else {
            continue;
        };
        if seasons.contains(&number) && !crate::settings::public::truthy(season.get("monitored")) {
            writes.push((
                Method::PUT,
                path.clone(),
                json!({ "seasonNumber": number, "monitored": true }),
            ));
        }
    }
    writes
}

/// `!airDateUtc || new Date(airDateUtc) <= now`.
#[must_use]
pub fn aired(episode: &Value, now_ms: i64) -> bool {
    match episode.get("airDateUtc").and_then(Value::as_str) {
        None | Some("") => true,
        Some(date) => crate::clock::parse_date_millis(date).is_some_and(|t| t <= now_ms),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::episodeorder::CatalogFuture;
    use crate::jobs::episode_request_sync::CatalogEpisode;

    /// A request the fake Sonarr got: method, path (no query) and body.
    type Seen = (String, String, Value);

    /// A Sonarr offering API `api` ("v3" or "v5") that answers each other
    /// request with the route of the same method and path (`{}` when none
    /// matches) and records it; its port and what it got.
    async fn fake_sonarr(
        api: &'static str,
        routes: Vec<(&'static str, String, Value)>,
    ) -> std::io::Result<(u16, Arc<Mutex<Vec<Seen>>>)> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
        let log = Arc::clone(&seen);
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut buf: Vec<u8> = Vec::new();
                let mut chunk = [0_u8; 4096];
                let mut wanted: Option<usize> = None;
                loop {
                    if wanted.is_none() {
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
                    if wanted.is_some_and(|w| buf.len() >= w) {
                        break;
                    }
                    match stream.read(&mut chunk).await {
                        Ok(n) if n > 0 => buf.extend_from_slice(chunk.get(..n).unwrap_or_default()),
                        _ => break,
                    }
                }
                let text = String::from_utf8_lossy(&buf).into_owned();
                let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
                let mut line = head.split(' ');
                let method = line.next().unwrap_or_default().to_owned();
                let target = line.next().unwrap_or_default();
                let path = target.split('?').next().unwrap_or_default().to_owned();
                let answer = if path == "/api" {
                    json!({ "current": api })
                } else {
                    let body: Value = serde_json::from_str(body).unwrap_or(Value::Null);
                    crate::sync::lock(&log).push((method.clone(), path.clone(), body));
                    routes
                        .iter()
                        .find(|(m, p, _)| *m == method && *p == path)
                        .map_or_else(|| json!({}), |(_, _, v)| v.clone())
                };
                let answer = answer.to_string();
                let reply = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}",
                    answer.len()
                );
                stream.write_all(reply.as_bytes()).await.ok();
            }
        });
        Ok((port, seen))
    }

    /// The aired order from a fixed catalog.
    struct Fixed(Vec<CatalogEpisode>);

    impl AiredSource for Fixed {
        fn aired(&self, _tvdb_id: i64) -> CatalogFuture<'_> {
            let catalog = self.0.clone();
            Box::pin(async move { Ok(catalog) })
        }
    }

    fn ep(tvdb_id: i64, season: i64, episode: i64) -> CatalogEpisode {
        CatalogEpisode {
            tvdb_id,
            season,
            episode,
            title: String::new(),
            air_date: None,
        }
    }

    /// TVDB down.
    struct Down;

    impl AiredSource for Down {
        fn aired(&self, _tvdb_id: i64) -> CatalogFuture<'_> {
            Box::pin(async { Err(anyhow!("connect timed out")) })
        }
    }

    /// Firefly-like: aired season 1 is 101 (aired first, the DVD's second),
    /// 102 (the pilot, the DVD's first), 103; aired season 2 is 201; aired
    /// season 3 is 301, which the DVD order leaves out.
    fn aired_order() -> Fixed {
        Fixed(vec![
            ep(101, 1, 1),
            ep(102, 1, 2),
            ep(103, 1, 3),
            ep(201, 2, 1),
            ep(301, 3, 1),
        ])
    }

    /// Sonarr's episodes of series 7 in DVD order: its season 1 holds the
    /// pilot and the aired S2E1, its season 2 the rest of aired season 1.
    fn dvd_episodes() -> Value {
        json!([
            {"id": 71, "tvdbId": 102, "seasonNumber": 1, "episodeNumber": 1, "hasFile": false, "monitored": false},
            {"id": 72, "tvdbId": 201, "seasonNumber": 1, "episodeNumber": 2, "hasFile": false, "monitored": false},
            {"id": 73, "tvdbId": 101, "seasonNumber": 2, "episodeNumber": 1, "hasFile": false, "monitored": false},
            {"id": 74, "tvdbId": 103, "seasonNumber": 2, "episodeNumber": 2, "hasFile": false, "monitored": true},
        ])
    }

    fn series(season_type: Option<&str>) -> Value {
        let mut series = json!({
            "id": 7, "tvdbId": 78874, "title": "Firefly", "titleSlug": "firefly",
            "monitored": false, "tags": [1], "status": "ended",
            "seasons": [
                {"seasonNumber": 1, "monitored": false},
                {"seasonNumber": 2, "monitored": false},
            ],
        });
        if let (Some(t), Some(map)) = (season_type, series.as_object_mut()) {
            map.insert(String::from("seasonType"), Value::from(t));
        }
        series
    }

    fn options(seasons: Vec<i64>, episodes: Option<Vec<i64>>) -> SeriesOptions {
        SeriesOptions {
            quality_profile: Value::from(1),
            language_profile: Value::Null,
            root_folder: Value::from("/tv"),
            title: Value::from("Firefly"),
            tvdb_id: 78874,
            seasons,
            episode_tvdb_ids: episodes,
            season_folder: Value::Bool(true),
            series_type: Value::from("standard"),
            tags: vec![Value::from(1), Value::from(2)],
            monitor_new_items: Value::Null,
            search_now: false,
        }
    }

    /// `addSeries` of `o` against an existing series 7 on a fake Sonarr
    /// offering `api`; the writes it got (`GET`s left out).
    async fn add_existing(
        api: &'static str,
        existing: Value,
        o: &SeriesOptions,
    ) -> Result<Vec<Seen>> {
        let (seen, _) = add_to(api, existing, dvd_episodes(), &aired_order(), o).await?;
        Ok(seen.into_iter().filter(|(m, _, _)| m != "GET").collect())
    }

    /// `addSeries` of `o` against an existing series 7, whose episodes
    /// Sonarr answers with `episodes`, on a fake Sonarr offering `api`;
    /// what Sonarr got and the aired seasons left out.
    async fn add_to(
        api: &'static str,
        existing: Value,
        episodes: Value,
        aired: &dyn AiredSource,
        o: &SeriesOptions,
    ) -> Result<(Vec<Seen>, Vec<i64>)> {
        if rustls::crypto::ring::default_provider()
            .install_default()
            .is_err()
        {
            tracing::trace!("a provider was installed");
        }
        let prefix = format!("/api/{api}");
        let (port, seen) = fake_sonarr(
            api,
            vec![
                (
                    "GET",
                    format!("{prefix}/series/lookup"),
                    json!([{"id": 7, "tvdbId": 78874}]),
                ),
                ("GET", format!("{prefix}/series/7"), existing.clone()),
                ("PUT", format!("{prefix}/series"), existing),
                ("GET", format!("{prefix}/episode"), episodes),
            ],
        )
        .await?;
        let client = ServarrClient::new(reqwest::Client::new());
        let server = json!({
            "hostname": "127.0.0.1", "port": port, "apiKey": "k", "useSsl": false,
            "baseUrl": "", "seriesType": "standard",
        });
        let arr = Arr {
            client: &client,
            server: &server,
            timeout: None,
        };
        let added = arr.add_series(o, aired).await?;
        assert_eq!(
            added.series.get("id"),
            Some(&json!(7)),
            "the series comes back"
        );
        let seen = crate::sync::lock(&seen).clone();
        Ok((seen, added.left_out_seasons))
    }

    /// The error text of a failed add.
    fn failure(result: Result<(Vec<Seen>, Vec<i64>)>) -> String {
        result.err().map(|e| format!("{e:#}")).unwrap_or_default()
    }

    fn write(method: &str, path: &str, body: Value) -> Seen {
        (method.to_owned(), path.to_owned(), body)
    }

    #[tokio::test]
    async fn sonarr5_toggles_seasons_on_their_own() -> Result<()> {
        let writes = add_existing("v5", series(Some("official")), &options(vec![1], None)).await?;
        assert_eq!(
            writes,
            vec![
                write(
                    "PUT",
                    "/api/v5/series/editor",
                    json!({"seriesIds": [7], "monitored": true, "tags": [2], "applyTags": "add"})
                ),
                write(
                    "PUT",
                    "/api/v5/series/7/season",
                    json!({"seasonNumber": 1, "monitored": true})
                ),
                write(
                    "PUT",
                    "/api/v5/episode/monitor",
                    json!({"episodeIds": [71, 72], "monitored": true})
                ),
            ],
            "the editor, season 1 by number, then its unmonitored episodes; never the whole series"
        );
        Ok(())
    }

    #[tokio::test]
    async fn sonarr4_puts_the_whole_series() -> Result<()> {
        let writes = add_existing("v3", series(None), &options(vec![1], None)).await?;
        let mut whole = series(None);
        if let Some(map) = whole.as_object_mut() {
            map.insert(String::from("monitored"), Value::Bool(true));
            map.insert(String::from("tags"), json!([1, 2]));
            map.insert(
                String::from("seasons"),
                json!([{"seasonNumber": 1, "monitored": true}, {"seasonNumber": 2, "monitored": false}]),
            );
        }
        assert_eq!(
            writes,
            vec![
                write("PUT", "/api/v3/series", whole),
                write(
                    "PUT",
                    "/api/v3/episode/monitor",
                    json!({"episodeIds": [71, 72], "monitored": true})
                ),
            ],
            "one PUT of the series as read, season 1 monitored"
        );
        Ok(())
    }

    #[tokio::test]
    async fn another_order_monitors_aired_episodes_by_tvdb_id() -> Result<()> {
        let writes = add_existing("v5", series(Some("dvd")), &options(vec![1], None)).await?;
        assert_eq!(
            writes,
            vec![
                write(
                    "PUT",
                    "/api/v5/series/editor",
                    json!({"seriesIds": [7], "monitored": true, "tags": [2], "applyTags": "add"})
                ),
                write(
                    "PUT",
                    "/api/v5/episode/monitor",
                    json!({"episodeIds": [73, 71], "monitored": true})
                ),
            ],
            "aired season 1 is the DVD's S02E01 and S01E01 (S02E02 already monitored); no season by number"
        );
        Ok(())
    }

    #[tokio::test]
    async fn sonarr4_api_on_another_order_leaves_seasons_alone() -> Result<()> {
        let writes = add_existing("v3", series(Some("dvd")), &options(vec![1], None)).await?;
        let seasons: Vec<Value> = writes
            .first()
            .and_then(|(_, _, body)| body.get("seasons"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert!(
            seasons
                .iter()
                .all(|s| s.get("monitored") == Some(&Value::Bool(false))),
            "no season monitored by number: {seasons:?}"
        );
        assert_eq!(
            writes.get(1),
            Some(&write(
                "PUT",
                "/api/v3/episode/monitor",
                json!({"episodeIds": [73, 71], "monitored": true})
            )),
            "the aired episodes instead"
        );
        Ok(())
    }

    #[tokio::test]
    async fn episodes_another_order_leaves_out_are_skipped() -> Result<()> {
        let o = options(Vec::new(), Some(vec![101, 999]));
        let writes = add_existing("v5", series(Some("dvd")), &o).await?;
        assert_eq!(
            writes.last(),
            Some(&write(
                "PUT",
                "/api/v5/episode/monitor",
                json!({"episodeIds": [73], "monitored": true})
            )),
            "the one Sonarr has is monitored, the missing one doesn't fail the add"
        );
        Ok(())
    }

    #[tokio::test]
    async fn aired_seasons_the_order_lacks_are_left_out() -> Result<()> {
        let dvd = series(Some("dvd"));
        let (seen, left_out) = add_to(
            "v5",
            dvd.clone(),
            dvd_episodes(),
            &aired_order(),
            &options(vec![1, 3], None),
        )
        .await?;
        assert_eq!(left_out, vec![3], "aired season 3 isn't in the DVD order");
        assert_eq!(
            seen.last(),
            Some(&write(
                "PUT",
                "/api/v5/episode/monitor",
                json!({"episodeIds": [73, 71], "monitored": true})
            )),
            "aired season 1 is monitored all the same"
        );
        let none = add_to(
            "v5",
            dvd,
            dvd_episodes(),
            &aired_order(),
            &options(vec![3], None),
        )
        .await;
        assert!(
            failure(none).contains(
                "None of the requested aired seasons (3) have episodes in the dvd episode order"
            ),
            "nothing to monitor fails the request"
        );
        Ok(())
    }

    #[tokio::test]
    async fn rolling_requests_without_seasons_need_no_tvdb() -> Result<()> {
        let dvd = series(Some("dvd"));
        let (seen, left_out) = add_to(
            "v5",
            dvd.clone(),
            dvd_episodes(),
            &Down,
            &options(Vec::new(), None),
        )
        .await?;
        assert!(left_out.is_empty(), "nothing asked for, nothing left out");
        assert!(
            seen.iter()
                .all(|(_, path, _)| !path.ends_with("/episode")
                    && !path.ends_with("/episode/monitor")),
            "no episodes read or monitored: {seen:?}"
        );
        let down = add_to("v5", dvd, dvd_episodes(), &Down, &options(vec![1], None)).await;
        let text = failure(down);
        assert!(
            text.contains("TVDB couldn't be reached") && text.contains("can be retried"),
            "says what failed and that a retry may work: {text}"
        );
        Ok(())
    }

    #[tokio::test]
    async fn missing_episodes_still_fail_in_aired_order() -> Result<()> {
        let o = options(Vec::new(), Some(vec![101, 999]));
        let failed = add_existing("v5", series(Some("official")), &o).await;
        assert!(
            failed.is_err_and(
                |e| format!("{e:#}").contains("Failed to resolve TVDB episode IDs: 999")
            ),
            "aired order should have it"
        );
        Ok(())
    }

    #[test]
    fn writes_by_api() {
        let existing = json!({
            "id": 3, "monitored": true, "tags": [1],
            "seasons": [{"seasonNumber": 1, "monitored": true}, {"seasonNumber": 2, "monitored": false}],
        });
        let patched = patched_series(&existing, &[Value::from(1)], &[1, 2, 9]);
        let v5 = series_writes(
            ApiVersion::V5,
            &existing,
            &patched,
            &[Value::from(1)],
            &[1, 2, 9],
        );
        assert_eq!(
            v5,
            vec![(
                Method::PUT,
                String::from("/series/3/season"),
                json!({"seasonNumber": 2, "monitored": true})
            )],
            "monitored with its tags: only the unmonitored season Sonarr has"
        );
        assert_eq!(
            patched.pointer("/seasons/1/monitored"),
            Some(&Value::Bool(true)),
            "the answer shows it monitored"
        );
        let v3 = series_writes(ApiVersion::V3, &existing, &patched, &[], &[2]);
        assert_eq!(
            v3,
            vec![(Method::PUT, String::from("/series"), patched)],
            "the whole series"
        );
    }
}
