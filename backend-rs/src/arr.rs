//! `RadarrAPI.addMovie`, `SonarrAPI.addSeries` and the calls they make,
//! with the same request bodies and fallbacks.

use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use reqwest::Method;
use serde_json::{Map, Value};

use crate::servarr::ServarrClient;

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
    /// `languageProfileId`: a language profile up to Sonarr 3, unused on
    /// Sonarr 4 and not sent to Sonarr 5.
    pub language_profile: Value,
    /// The metadata language a Sonarr 5 series is added with: the
    /// request's or the server's choice, else Sonarr's preferred one.
    pub metadata_language: Option<i64>,
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

    /// `applyEpisodeSelection`.
    async fn apply_episode_selection(
        &self,
        series_id: &Value,
        wanted: &[i64],
        search_now: bool,
        attempts: u32,
        wait_add_options: bool,
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

    /// `SonarrAPI.addSeries`.
    ///
    /// # Errors
    ///
    /// `Failed to add series` when any step fails.
    pub async fn add_series(&self, o: &SeriesOptions) -> Result<Value> {
        self.add_series_inner(o)
            .await
            .map_err(|e| e.context("Failed to add series"))
    }

    async fn add_series_inner(&self, o: &SeriesOptions) -> Result<Value> {
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
            let mut body = existing.as_object().cloned().unwrap_or_default();
            let mut tags: Vec<Value> = existing
                .get("tags")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for tag in &o.tags {
                if !tags.contains(tag) {
                    tags.push(tag.clone());
                }
            }
            body.insert(String::from("monitored"), Value::Bool(true));
            body.insert(String::from("tags"), Value::Array(tags));
            body.insert(
                String::from("seasons"),
                Self::season_list(
                    &o.seasons,
                    existing.get("seasons").and_then(Value::as_array).cloned(),
                ),
            );
            body.shift_remove("addOptions");
            let updated = self
                .send(Method::PUT, "/series", &Value::Object(body))
                .await?;
            let Some(updated_id) = updated
                .get("id")
                .filter(|v| crate::settings::public::truthy(Some(v)))
                .cloned()
            else {
                bail!("Failed to update series in Sonarr");
            };
            if let Some(ids) = episode_ids {
                self.apply_episode_selection(&updated_id, ids, o.search_now, 1, false)
                    .await?;
            } else {
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
            return Ok(updated);
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
        // Sonarr 5 requires both. It has no language profiles but a
        // metadata language (English, which v3 adds with, when nothing
        // names one); aired order keeps the season and episode numbers
        // TMDB uses.
        if crate::sonarrmeta::is_v5(self).await {
            let language = crate::sonarrmeta::add_language(self, o.metadata_language, &series)
                .await
                .unwrap_or_else(|| serde_json::json!({ "id": 1, "name": "English" }));
            fields.push(("language", language));
        } else {
            if !o.language_profile.is_null() {
                fields.push(("languageProfileId", o.language_profile.clone()));
            }
            if let Some(language) = series.get("language").filter(|l| !l.is_null()) {
                fields.push(("language", language.clone()));
            }
        }
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
            self.apply_episode_selection(&created_id, ids, o.search_now, 30, true)
                .await?;
        }
        Ok(created)
    }
}

/// `!airDateUtc || new Date(airDateUtc) <= now`.
#[must_use]
pub fn aired(episode: &Value, now_ms: i64) -> bool {
    match episode.get("airDateUtc").and_then(Value::as_str) {
        None | Some("") => true,
        Some(date) => crate::clock::parse_date_millis(date).is_some_and(|t| t <= now_ms),
    }
}
