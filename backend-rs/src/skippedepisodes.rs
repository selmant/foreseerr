//! `skippedEpisodeEndings.ts` and `skippedEpisodeCleanup.ts`: episodes left
//! in Continue Watching because the user skipped the credits.
//!
//! Once a later episode of the series has been started, such an episode is
//! marked watched on Trakt, then played on Jellyfin, and leaves the resume
//! list.
//!
//! The classification is pure; the calls out go through [`Deps`] ([`Live`]
//! in the app, a fake in the tests), as Node's injectable dependencies do.
//! Every failure is logged and keeps its episode in the list.

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::Value;

use crate::db::{Bind, Db};
use crate::jellyfin::{actions, Item, JellyfinClient, JfError};
use crate::librarymap::{js_number, js_round, safe_integer, tmdb_from_raw};
use crate::mediaactions::dispatcher::{Fut, Thrown};
use crate::mediaactions::types::EpisodeWrite;
use crate::mediaactions::{jellyfincache, trakt, Env};

/// `DEFAULT_SKIPPED_EPISODE_PROGRESS_THRESHOLD`.
pub const DEFAULT_THRESHOLD: f64 = 50.0;

/// `SERIES_HYDRATION_CONCURRENCY`.
const SERIES_CONCURRENCY: usize = 4;

/// `skippedEpisodeProgressThreshold(value)`: a whole percentage from 1 to
/// 100, the default for anything that isn't a number.
#[must_use]
pub fn progress_threshold(value: Option<&Value>) -> f64 {
    let parsed = match value {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => js_number(s),
        _ => f64::NAN,
    };
    if parsed.is_finite() {
        js_round(parsed).clamp(1.0, 100.0)
    } else {
        DEFAULT_THRESHOLD
    }
}

/// `episodeProgress(episode)`: `PlayedPercentage`, else the position over
/// the runtime, as a percentage from 0 to 100.
#[must_use]
pub fn episode_progress(item: &Item) -> Option<f64> {
    if let Some(percentage) = item.user_num("PlayedPercentage") {
        return Some(percentage.clamp(0.0, 100.0));
    }
    let position = item.user_num("PlaybackPositionTicks")?;
    let runtime = item
        .user_num("RunTimeTicks")
        .or_else(|| item.num("RunTimeTicks"))
        .filter(|r| *r > 0.0)?;
    Some((position / runtime * 100.0).clamp(0.0, 100.0))
}

/// `(season, episode)` of a regular episode (season 1 or later).
fn coordinate(item: &Item) -> Option<(i64, i64)> {
    let season = item.int("ParentIndexNumber")?;
    let episode = item.int("IndexNumber")?;
    (season >= 1 && episode >= 0).then_some((season, episode))
}

/// Some progress recorded, played or not.
fn started(item: &Item) -> bool {
    item.user_num("PlayedPercentage").unwrap_or(0.0) > 0.0
        || item.user_num("PlaybackPositionTicks").unwrap_or(0.0) > 0.0
}

fn viewed(item: &Item) -> bool {
    item.played() || started(item)
}

fn in_progress(item: &Item) -> bool {
    !item.played() && started(item)
}

fn last_played_ms(item: &Item) -> i64 {
    item.user_raw("LastPlayedDate")
        .and_then(Value::as_str)
        .and_then(crate::clock::parse_date_millis)
        .unwrap_or(0)
}

/// `isLaterViewingActivity`: the later episode was started after the
/// candidate, not merely watched at some point before it.
fn later_viewing_activity(later: &Item, candidate: &Item) -> bool {
    if !viewed(later) {
        return false;
    }
    if in_progress(later) {
        return true;
    }
    let (later_ms, candidate_ms) = (last_played_ms(later), last_played_ms(candidate));
    later_ms != 0 && candidate_ms != 0 && later_ms > candidate_ms
}

/// `frontierEpisodeId(seriesEpisodes)`: the furthest in-progress episode
/// of a series, which is never auto-completed.
#[must_use]
pub fn frontier_episode_id(episodes: &[Item]) -> Option<&str> {
    let mut frontier: Option<(&Item, (i64, i64))> = None;
    for episode in episodes {
        if !episode.is("Episode") || !in_progress(episode) {
            continue;
        }
        let Some(coord) = coordinate(episode) else {
            continue;
        };
        if frontier.is_none_or(|(_, current)| coord > current) {
            frontier = Some((episode, coord));
        }
    }
    frontier.map(|(episode, _)| episode.id())
}

/// The candidate's series id, when it has one.
fn series_of(item: &Item) -> Option<&str> {
    item.str("SeriesId").filter(|s| !s.is_empty())
}

/// `isStaleSkippedEpisode(candidate, seriesEpisodes, minProgress)`.
///
/// Past the threshold, with a later episode of the same series started
/// after it. `Played` alone doesn't take an item off Jellyfin's resume
/// list, so it isn't checked here.
#[must_use]
pub fn is_stale(candidate: &Item, episodes: &[Item], min_progress: f64) -> bool {
    let Some(series) = series_of(candidate) else {
        return false;
    };
    if !candidate.is("Episode") {
        return false;
    }
    let Some(current) = coordinate(candidate) else {
        return false;
    };
    if !episode_progress(candidate).is_some_and(|p| p >= min_progress) {
        return false;
    }
    episodes.iter().any(|episode| {
        episode.id() != candidate.id()
            && episode.is("Episode")
            && episode.str("SeriesId") == Some(series)
            && coordinate(episode).is_some_and(|next| next > current)
            && later_viewing_activity(episode, candidate)
    })
}

/// `SkippedEpisodeCleanupDependencies` for one user and their Jellyfin
/// client.
pub trait Deps: Send + Sync {
    /// `providersAvailable(userId)`.
    fn providers_available(&self) -> Fut<'_, Result<bool, Thrown>>;
    /// `loadSeriesEpisodes(client, seriesId)`.
    fn series_episodes<'a>(&'a self, series_id: &'a str) -> Fut<'a, Result<Vec<Item>, Thrown>>;
    /// `loadMappedTmdbIds(seriesIds)`: the series' TMDB ids from the media
    /// table.
    fn mapped_tmdb_ids<'a>(
        &'a self,
        series_ids: &'a [String],
    ) -> Fut<'a, Result<HashMap<String, i64>, Thrown>>;
    /// `loadSeriesItem(client, seriesId)`.
    fn series_item<'a>(&'a self, series_id: &'a str) -> Fut<'a, Result<Option<Item>, Thrown>>;
    /// `getTraktSeasonStatus(userId, tmdbId, season)`: whether Trakt is
    /// available, and the season's watched episode numbers.
    fn trakt_season_status(
        &self,
        tmdb_id: i64,
        season: i64,
    ) -> Fut<'_, Result<(bool, Vec<f64>), Thrown>>;
    /// `setTraktWatched(...)`: `false` when Trakt took no write.
    fn set_trakt_watched(
        &self,
        tmdb_id: i64,
        season: i64,
        episode: i64,
    ) -> Fut<'_, Result<bool, Thrown>>;
    /// `removeTraktPlayback(...)`.
    fn remove_trakt_playback(
        &self,
        tmdb_id: i64,
        season: i64,
        episode: i64,
    ) -> Fut<'_, Result<(), Thrown>>;
    /// `markJellyfinPlayed(client, userId, episodeId)`.
    fn mark_jellyfin_played<'a>(&'a self, episode_id: &'a str) -> Fut<'a, Result<(), Thrown>>;
}

/// The default dependencies: the user's Trakt link, their Jellyfin client
/// and the media table.
#[derive(Debug)]
pub struct Live<'a> {
    env: Env<'a>,
    client: &'a JellyfinClient,
}

impl<'a> Live<'a> {
    /// For the user of `env`, acting through `client`.
    #[must_use]
    pub const fn new(env: Env<'a>, client: &'a JellyfinClient) -> Self {
        Self { env, client }
    }
}

fn jf_message(error: JfError) -> Thrown {
    match error {
        JfError::Failed { message, .. } => message,
        JfError::Unsure(why) => why,
    }
}

impl Deps for Live<'_> {
    fn providers_available(&self) -> Fut<'_, Result<bool, Thrown>> {
        Box::pin(async move {
            if self.env.provider_off("jellyfin") {
                return Ok(false);
            }
            trakt::available(&self.env).await
        })
    }

    fn series_episodes<'a>(&'a self, series_id: &'a str) -> Fut<'a, Result<Vec<Item>, Thrown>> {
        Box::pin(async move {
            self.client
                .series_episodes(series_id)
                .await
                .map_err(jf_message)
        })
    }

    fn mapped_tmdb_ids<'a>(
        &'a self,
        series_ids: &'a [String],
    ) -> Fut<'a, Result<HashMap<String, i64>, Thrown>> {
        Box::pin(mapped_tmdb_ids(&self.env.state.db, series_ids))
    }

    fn series_item<'a>(&'a self, series_id: &'a str) -> Fut<'a, Result<Option<Item>, Thrown>> {
        Box::pin(async move { self.client.item_data(series_id).await.map_err(jf_message) })
    }

    fn trakt_season_status(
        &self,
        tmdb_id: i64,
        season: i64,
    ) -> Fut<'_, Result<(bool, Vec<f64>), Thrown>> {
        Box::pin(trakt::season_status(&self.env, tmdb_id, season))
    }

    fn set_trakt_watched(
        &self,
        tmdb_id: i64,
        season: i64,
        episode: i64,
    ) -> Fut<'_, Result<bool, Thrown>> {
        Box::pin(async move {
            let write =
                trakt::set_episode_watched(&self.env, tmdb_id, season, episode, true).await?;
            Ok(write == EpisodeWrite::Done(true))
        })
    }

    fn remove_trakt_playback(
        &self,
        tmdb_id: i64,
        season: i64,
        episode: i64,
    ) -> Fut<'_, Result<(), Thrown>> {
        Box::pin(trakt::remove_episode_playback(
            &self.env, tmdb_id, season, episode,
        ))
    }

    fn mark_jellyfin_played<'a>(&'a self, episode_id: &'a str) -> Fut<'a, Result<(), Thrown>> {
        Box::pin(async move {
            actions::set_played(self.client, episode_id, true)
                .await
                .map_err(|actions::Failed| String::from("Jellyfin didn't mark it played"))?;
            jellyfincache::invalidate(Some(self.env.user));
            jellyfincache::set(self.env.user, episode_id, true);
            Ok(())
        })
    }
}

/// The default `loadMappedTmdbIds`: TV media rows by either Jellyfin id.
async fn mapped_tmdb_ids(db: &Db, series_ids: &[String]) -> Result<HashMap<String, i64>, Thrown> {
    let mut found = HashMap::new();
    if series_ids.is_empty() {
        return Ok(found);
    }
    let placeholders = (2..=series_ids.len() + 1)
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        r#"SELECT "jellyfinMediaId", "jellyfinMediaId4k", "tmdbId" FROM "media" WHERE "mediaType" = ?1 AND ("jellyfinMediaId" IN ({placeholders}) OR "jellyfinMediaId4k" IN ({placeholders})) ORDER BY "id" ASC"#
    );
    let mut binds = vec![Bind::Text(String::from("tv"))];
    binds.extend(series_ids.iter().map(|id| Bind::Text(id.clone())));
    let rows = db.rows(&sql, &binds).await.map_err(|e| format!("{e:#}"))?;
    for row in &rows {
        let Some(tmdb_id) = row.get("tmdbId").and_then(Value::as_i64).filter(|t| *t > 0) else {
            continue;
        };
        for key in ["jellyfinMediaId", "jellyfinMediaId4k"] {
            if let Some(id) = row
                .get(key)
                .and_then(Value::as_str)
                .filter(|id| series_ids.iter().any(|s| s == id))
            {
                found.insert(id.to_owned(), tmdb_id);
            }
        }
    }
    Ok(found)
}

/// `providerTmdbId(series)`.
fn provider_tmdb_id(series: &Item) -> Option<i64> {
    let raw = series
        .provider("Tmdb")
        .or_else(|| series.provider("TheMovieDb"));
    tmdb_from_raw(raw).ok().flatten()
}

/// `mapWithConcurrency(items, SERIES_HYDRATION_CONCURRENCY, f)`: workers
/// take the next item in order; the results come back in item order.
async fn map_concurrently<'a, T, R, F, Fut2>(items: &'a [T], f: F) -> Vec<R>
where
    T: Sync,
    R: Send,
    F: Fn(&'a T) -> Fut2 + Sync,
    Fut2: Future<Output = R> + Send,
{
    let next = AtomicUsize::new(0);
    let worker = || async {
        let mut done = Vec::new();
        loop {
            let index = next.fetch_add(1, Ordering::SeqCst);
            let Some(item) = items.get(index) else {
                break;
            };
            done.push((index, f(item).await));
        }
        done
    };
    debug_assert_eq!(SERIES_CONCURRENCY, 4, "four workers below");
    let (first, second, third, fourth) = tokio::join!(worker(), worker(), worker(), worker());
    let mut all: Vec<(usize, R)> = first
        .into_iter()
        .chain(second)
        .chain(third)
        .chain(fourth)
        .collect();
    all.sort_by_key(|(index, _)| *index);
    all.into_iter().map(|(_, result)| result).collect()
}

/// The first occurrence of each series id.
fn unique_series<'a>(items: impl Iterator<Item = &'a Item>) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for id in items.filter_map(series_of) {
        if !ids.iter().any(|s| s == id) {
            ids.push(id.to_owned());
        }
    }
    ids
}

/// The pass's counts, logged at the end.
#[derive(Debug, Default)]
struct Summary {
    candidates: usize,
    completed: usize,
    skipped: usize,
    failed: usize,
}

impl Summary {
    fn log(&self, user: i64, providers_unavailable: bool) {
        tracing::info!(
            user,
            candidates = self.candidates,
            completed = self.completed,
            skipped = self.skipped,
            failed = self.failed,
            providers_unavailable,
            "Skipped episode cleanup pass"
        );
    }
}

/// How one episode's completion ended.
#[derive(Debug, PartialEq, Eq)]
enum Step {
    /// Trakt has it (`updated` or `already_watched`) and Jellyfin too.
    Completed(&'static str),
    /// Trakt isn't available for the season lookup; nothing written.
    TraktUnavailable,
    /// The Trakt read or write failed; Jellyfin not attempted.
    TraktFailed(Thrown),
    /// Trakt has it, the Jellyfin write failed.
    JellyfinFailed(&'static str, Thrown),
}

/// Trakt first (history unless the season already has the episode, else
/// only its paused playback), then Jellyfin.
async fn complete_episode(
    deps: &impl Deps,
    watched_by_season: &mut HashMap<(i64, i64), HashSet<i64>>,
    show: i64,
    (season, episode): (i64, i64),
    episode_id: &str,
) -> Step {
    let watched = match watched_by_season.entry((show, season)) {
        Entry::Occupied(known) => known.into_mut(),
        Entry::Vacant(slot) => match deps.trakt_season_status(show, season).await {
            Ok((false, _)) => return Step::TraktUnavailable,
            Ok((true, numbers)) => {
                slot.insert(numbers.into_iter().filter_map(safe_integer).collect())
            }
            Err(e) => return Step::TraktFailed(e),
        },
    };
    let trakt_state = if watched.contains(&episode) {
        if let Err(e) = deps.remove_trakt_playback(show, season, episode).await {
            tracing::warn!(
                show,
                season,
                episode,
                "Skipped episode Trakt playback clear failed: {e}"
            );
        }
        "already_watched"
    } else {
        match deps.set_trakt_watched(show, season, episode).await {
            Ok(true) => {}
            Ok(false) => {
                return Step::TraktFailed(String::from("Trakt episode action unavailable"))
            }
            Err(e) => return Step::TraktFailed(e),
        }
        watched.insert(episode);
        "updated"
    };
    match deps.mark_jellyfin_played(episode_id).await {
        Ok(()) => Step::Completed(trakt_state),
        Err(e) => Step::JellyfinFailed(trakt_state, e),
    }
}

/// `cleanupSkippedEpisodeEndings(userId, client, resume, deps, threshold)`
/// with `min_progress` from [`progress_threshold`]: the resume list without
/// the episodes completed here.
pub async fn cleanup(
    user: i64,
    deps: &impl Deps,
    resume: Vec<Item>,
    min_progress: f64,
) -> Vec<Item> {
    let preliminary: Vec<&Item> = resume
        .iter()
        .filter(|item| item.is("Episode") && episode_progress(item).unwrap_or(-1.0) >= min_progress)
        .collect();
    let mut summary = Summary {
        candidates: preliminary.len(),
        ..Summary::default()
    };
    if preliminary.is_empty() {
        summary.log(user, false);
        return resume;
    }
    let available = deps.providers_available().await.unwrap_or_else(|e| {
        tracing::warn!(
            user,
            "Skipped episode provider availability check failed: {e}"
        );
        false
    });
    if !available {
        summary.skipped = preliminary.len();
        summary.log(user, true);
        return resume;
    }

    let series_ids = unique_series(preliminary.iter().copied());
    let mut episodes_by_series: HashMap<&str, Vec<Item>> = HashMap::new();
    let loaded = map_concurrently(&series_ids, |id| async move {
        (id.as_str(), deps.series_episodes(id).await)
    })
    .await;
    for (series, result) in loaded {
        match result {
            Ok(episodes) => {
                episodes_by_series.insert(series, episodes);
            }
            Err(e) => tracing::warn!(user, series, "Skipped episode series hydration failed: {e}"),
        }
    }

    let classified: Vec<&Item> = preliminary
        .iter()
        .copied()
        .filter(|item| {
            let Some(series) = series_of(item) else {
                return false;
            };
            let episodes = episodes_by_series
                .get(series)
                .map_or(&[][..], Vec::as_slice);
            if frontier_episode_id(episodes).is_some_and(|f| !f.is_empty() && f == item.id()) {
                return false;
            }
            is_stale(item, episodes, min_progress)
        })
        .collect();
    summary.skipped += preliminary.len() - classified.len();

    let classified_series = unique_series(classified.iter().copied());
    let mut tmdb_by_series = deps
        .mapped_tmdb_ids(&classified_series)
        .await
        .unwrap_or_else(|e| {
            tracing::warn!(user, "Skipped episode media mapping lookup failed: {e}");
            HashMap::new()
        });
    let unmapped: Vec<String> = classified_series
        .iter()
        .filter(|series| !tmdb_by_series.contains_key(*series))
        .cloned()
        .collect();
    let loaded = map_concurrently(&unmapped, |id| async move {
        (id.as_str(), deps.series_item(id).await)
    })
    .await;
    for (series, result) in loaded {
        match result {
            Ok(item) => {
                if let Some(tmdb_id) = item.as_ref().and_then(provider_tmdb_id) {
                    tmdb_by_series.insert(series.to_owned(), tmdb_id);
                }
            }
            Err(e) => tracing::warn!(user, series, "Skipped episode series mapping failed: {e}"),
        }
    }

    let classified_ids: HashSet<&str> = classified.iter().map(|item| item.id()).collect();
    let mut completed_ids: HashSet<String> = HashSet::new();
    let mut watched_by_season: HashMap<(i64, i64), HashSet<i64>> = HashMap::new();
    for item in &resume {
        if !classified_ids.contains(item.id()) {
            continue;
        }
        let (Some(series), Some(coord)) = (series_of(item), coordinate(item)) else {
            summary.skipped += 1;
            continue;
        };
        let (season, episode) = coord;
        let id = item.id();
        let progress = episode_progress(item);
        let Some(show) = tmdb_by_series.get(series).copied() else {
            summary.skipped += 1;
            tracing::warn!(
                user,
                series,
                id,
                season,
                episode,
                progress,
                "Skipped episode has no safe series TMDB mapping"
            );
            continue;
        };
        match complete_episode(deps, &mut watched_by_season, show, coord, id).await {
            Step::Completed(trakt) => {
                completed_ids.insert(id.to_owned());
                summary.completed += 1;
                tracing::info!(
                    user,
                    series,
                    id,
                    season,
                    episode,
                    progress,
                    trakt,
                    "Skipped episode completed"
                );
            }
            Step::TraktUnavailable => {
                summary.skipped += 1;
                tracing::warn!(
                    user,
                    series,
                    id,
                    season,
                    episode,
                    progress,
                    "Skipped episode Trakt status unavailable; Jellyfin not attempted"
                );
            }
            Step::TraktFailed(e) => {
                summary.failed += 1;
                tracing::warn!(
                    user,
                    series,
                    id,
                    season,
                    episode,
                    progress,
                    "Skipped episode Trakt update failed; Jellyfin not attempted: {e}"
                );
            }
            Step::JellyfinFailed(trakt, e) => {
                summary.failed += 1;
                tracing::warn!(
                    user,
                    series,
                    id,
                    season,
                    episode,
                    progress,
                    trakt,
                    "Skipped episode Jellyfin update failed: {e}"
                );
            }
        }
    }
    summary.log(user, false);
    resume
        .into_iter()
        .filter(|item| !completed_ids.contains(item.id()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    use crate::sync::lock;

    fn episode(
        id: &str,
        season: Option<i64>,
        number: Option<i64>,
        user_data: &Value,
        series: &str,
    ) -> Result<Item, String> {
        let mut value = json!({
            "Id": id,
            "Name": id,
            "Type": "Episode",
            "LocationType": "FileSystem",
            "ProviderIds": {"Tmdb": format!("episode-{id}")},
            "SeriesId": series,
            "UserData": user_data,
        });
        if let Value::Object(map) = &mut value {
            if let Some(season) = season {
                map.insert(String::from("ParentIndexNumber"), Value::from(season));
            }
            if let Some(number) = number {
                map.insert(String::from("IndexNumber"), Value::from(number));
            }
        }
        Item::parse(&value, true).map_err(|e| format!("{e:?}"))
    }

    fn ep(id: &str, number: i64, user_data: &Value) -> Result<Item, String> {
        episode(id, Some(1), Some(number), user_data, "series")
    }

    /// The cleanup tests' `item(id, number, percentage)`.
    fn pct(id: &str, number: i64, percentage: f64) -> Result<Item, String> {
        ep(id, number, &json!({ "PlayedPercentage": percentage }))
    }

    fn series(provider: &str, tmdb: &str) -> Result<Item, String> {
        Item::parse(
            &json!({"Id": "series", "Type": "Series", "ProviderIds": {provider: tmdb}}),
            true,
        )
        .map_err(|e| format!("{e:?}"))
    }

    fn ids(items: &[Item]) -> Vec<&str> {
        items.iter().map(Item::id).collect()
    }

    #[test]
    fn clamps_the_threshold() {
        assert!(
            (progress_threshold(None) - 50.0).abs() < f64::EPSILON,
            "missing"
        );
        for (value, expected) in [
            (Value::Null, 50.0),
            (json!(80.4), 80.0),
            (json!(0), 1.0),
            (json!(140), 100.0),
            (json!("60"), 60.0),
            (json!("x"), 50.0),
        ] {
            assert!(
                (progress_threshold(Some(&value)) - expected).abs() < f64::EPSILON,
                "{value}"
            );
        }
    }

    #[test]
    fn tick_progress_is_clamped() -> Result<(), String> {
        let half = ep(
            "e1",
            1,
            &json!({"PlaybackPositionTicks": 50, "RunTimeTicks": 100}),
        )?;
        assert_eq!(episode_progress(&half), Some(50.0), "ticks");
        let over = ep(
            "e1",
            1,
            &json!({"PlaybackPositionTicks": 200, "RunTimeTicks": 100}),
        )?;
        assert_eq!(episode_progress(&over), Some(100.0), "clamped");
        assert_eq!(episode_progress(&ep("e1", 1, &json!({}))?), None, "none");
        Ok(())
    }

    #[test]
    fn needs_the_threshold_and_later_viewing() -> Result<(), String> {
        let later = ep(
            "e2",
            2,
            &json!({"Played": true, "LastPlayedDate": "2026-08-23T19:00:00Z"}),
        )?;
        let below = ep(
            "e1",
            1,
            &json!({"PlayedPercentage": 49, "LastPlayedDate": "2026-08-23T18:00:00Z"}),
        )?;
        let at = ep(
            "e1",
            1,
            &json!({"PlayedPercentage": 50, "LastPlayedDate": "2026-08-23T18:00:00Z"}),
        )?;
        let later_slice = [later];
        assert!(
            !is_stale(&below, &later_slice, DEFAULT_THRESHOLD),
            "below 50"
        );
        assert!(is_stale(&at, &later_slice, DEFAULT_THRESHOLD), "at 50");
        assert!(
            !is_stale(
                &pct("e1", 1, 50.0)?,
                &[ep("e2", 2, &json!({}))?],
                DEFAULT_THRESHOLD
            ),
            "later episode never viewed"
        );
        Ok(())
    }

    #[test]
    fn later_seasons_count() -> Result<(), String> {
        let candidate = pct("e1", 12, 50.0)?;
        let next = episode(
            "e2",
            Some(2),
            Some(1),
            &json!({"PlaybackPositionTicks": 1}),
            "series",
        )?;
        assert!(
            is_stale(&candidate, &[next], DEFAULT_THRESHOLD),
            "partial playback of season 2"
        );
        Ok(())
    }

    #[test]
    fn ignores_other_series_specials_movies_and_missing_numbers() -> Result<(), String> {
        let candidate = pct("e1", 1, 75.0)?;
        let played = json!({"Played": true});
        let other = episode("other", Some(1), Some(2), &played, "other-series")?;
        assert!(
            !is_stale(&candidate, &[other], DEFAULT_THRESHOLD),
            "other series"
        );
        let special = episode("special", Some(0), Some(99), &played, "series")?;
        assert!(
            !is_stale(&candidate, &[special], DEFAULT_THRESHOLD),
            "special"
        );
        let movie = Item::parse(
            &json!({"Id": "e1", "Type": "Movie", "SeriesId": "series", "ParentIndexNumber": 1, "IndexNumber": 1, "UserData": {"PlayedPercentage": 75}}),
            true,
        )
        .map_err(|e| format!("{e:?}"))?;
        let next = ep("e2", 2, &played)?;
        assert!(
            !is_stale(&movie, std::slice::from_ref(&next), DEFAULT_THRESHOLD),
            "movie"
        );
        let missing = episode(
            "missing",
            None,
            Some(1),
            &json!({"PlayedPercentage": 75}),
            "series",
        )?;
        assert!(
            !is_stale(&missing, &[next], DEFAULT_THRESHOLD),
            "no season number"
        );
        Ok(())
    }

    #[test]
    fn several_stale_but_not_the_newest_active() -> Result<(), String> {
        let all = [
            pct("e1", 1, 70.0)?,
            pct("e2", 2, 60.0)?,
            pct("e3", 3, 20.0)?,
        ];
        let stale: Vec<bool> = all
            .iter()
            .map(|e| is_stale(e, &all, DEFAULT_THRESHOLD))
            .collect();
        assert_eq!(stale, vec![true, true, false], "e1 and e2");
        Ok(())
    }

    #[test]
    fn later_viewing_must_come_after() -> Result<(), String> {
        let finale = episode(
            "finale",
            Some(5),
            Some(10),
            &json!({"PlayedPercentage": 60, "LastPlayedDate": "2026-08-23T20:00:00Z"}),
            "series",
        )?;
        let next_season = episode(
            "s6e1",
            Some(6),
            Some(1),
            &json!({"Played": true, "LastPlayedDate": "2026-06-01T12:00:00Z"}),
            "series",
        )?;
        assert!(
            !is_stale(&finale, &[finale.clone(), next_season], DEFAULT_THRESHOLD),
            "the later season was watched before"
        );
        let skipped = ep(
            "e5",
            5,
            &json!({"PlayedPercentage": 70, "LastPlayedDate": "2026-08-23T18:00:00.0000000Z"}),
        )?;
        let started_later = ep(
            "e6",
            6,
            &json!({"Played": true, "LastPlayedDate": "2026-08-23T19:00:00.0000000Z"}),
        )?;
        assert!(
            is_stale(
                &skipped,
                &[skipped.clone(), started_later],
                DEFAULT_THRESHOLD
            ),
            "started after"
        );
        Ok(())
    }

    #[test]
    fn frontier_and_played_leftovers() -> Result<(), String> {
        let frontier = pct("e10", 10, 65.0)?;
        assert!(
            !is_stale(
                &frontier,
                std::slice::from_ref(&frontier),
                DEFAULT_THRESHOLD
            ),
            "nothing later"
        );
        let leftover = ep(
            "e1",
            1,
            &json!({"Played": true, "PlayedPercentage": 88, "LastPlayedDate": "2026-08-25T14:42:00Z"}),
        )?;
        let later = ep("e2", 2, &json!({"PlaybackPositionTicks": 1}))?;
        assert!(
            is_stale(&leftover, &[leftover.clone(), later], DEFAULT_THRESHOLD),
            "played leftover"
        );
        Ok(())
    }

    #[test]
    fn custom_threshold() -> Result<(), String> {
        let leftover = pct("e1", 1, 40.0)?;
        let all = [
            leftover.clone(),
            ep("e2", 2, &json!({"PlaybackPositionTicks": 1}))?,
        ];
        assert!(!is_stale(&leftover, &all, DEFAULT_THRESHOLD), "50");
        assert!(is_stale(&leftover, &all, 40.0), "40");
        assert!(!is_stale(&leftover, &all, 41.0), "41");
        Ok(())
    }

    #[test]
    fn picks_the_leading_frontier() -> Result<(), String> {
        let mut all = vec![
            pct("e10", 10, 70.0)?,
            pct("e12", 12, 65.0)?,
            pct("e13", 13, 60.0)?,
            pct("e15", 15, 55.0)?,
        ];
        assert_eq!(frontier_episode_id(&all), Some("e15"), "e15");
        all.push(ep("e16", 16, &json!({"PlaybackPositionTicks": 1}))?);
        assert_eq!(frontier_episode_id(&all), Some("e16"), "e16");
        Ok(())
    }

    /// The tests' dependencies, recording every call.
    #[derive(Debug)]
    struct Fake {
        available: bool,
        episodes: Result<Vec<Item>, Thrown>,
        mapped: Result<HashMap<String, i64>, Thrown>,
        series: Option<Item>,
        season: (bool, Vec<f64>),
        trakt_write: bool,
        jellyfin_fails: bool,
        calls: Mutex<Vec<String>>,
    }

    impl Fake {
        fn new() -> Result<Self, String> {
            Ok(Self {
                available: true,
                episodes: Ok(vec![pct("e1", 1, 75.0)?, pct("e2", 2, 10.0)?]),
                mapped: Ok(HashMap::from([(String::from("series"), 123)])),
                series: None,
                season: (true, Vec::new()),
                trakt_write: true,
                jellyfin_fails: false,
                calls: Mutex::new(Vec::new()),
            })
        }

        fn call(&self, call: String) {
            lock(&self.calls).push(call);
        }

        fn calls(&self, prefix: &str) -> Vec<String> {
            lock(&self.calls)
                .iter()
                .filter(|c| c.starts_with(prefix))
                .cloned()
                .collect()
        }
    }

    impl Deps for Fake {
        fn providers_available(&self) -> Fut<'_, Result<bool, Thrown>> {
            Box::pin(async move { Ok(self.available) })
        }

        fn series_episodes<'a>(&'a self, series_id: &'a str) -> Fut<'a, Result<Vec<Item>, Thrown>> {
            Box::pin(async move {
                self.call(format!("episodes {series_id}"));
                self.episodes.clone()
            })
        }

        fn mapped_tmdb_ids<'a>(
            &'a self,
            _series_ids: &'a [String],
        ) -> Fut<'a, Result<HashMap<String, i64>, Thrown>> {
            Box::pin(async move { self.mapped.clone() })
        }

        fn series_item<'a>(&'a self, _series_id: &'a str) -> Fut<'a, Result<Option<Item>, Thrown>> {
            Box::pin(async move { Ok(self.series.clone()) })
        }

        fn trakt_season_status(
            &self,
            tmdb_id: i64,
            season: i64,
        ) -> Fut<'_, Result<(bool, Vec<f64>), Thrown>> {
            Box::pin(async move {
                self.call(format!("status {tmdb_id} {season}"));
                Ok(self.season.clone())
            })
        }

        fn set_trakt_watched(
            &self,
            _tmdb_id: i64,
            _season: i64,
            episode: i64,
        ) -> Fut<'_, Result<bool, Thrown>> {
            Box::pin(async move {
                self.call(format!("trakt {episode}"));
                Ok(self.trakt_write)
            })
        }

        fn remove_trakt_playback(
            &self,
            _tmdb_id: i64,
            _season: i64,
            episode: i64,
        ) -> Fut<'_, Result<(), Thrown>> {
            Box::pin(async move {
                self.call(format!("playback {episode}"));
                Ok(())
            })
        }

        fn mark_jellyfin_played<'a>(&'a self, episode_id: &'a str) -> Fut<'a, Result<(), Thrown>> {
            Box::pin(async move {
                self.call(format!("jellyfin {episode_id}"));
                if self.jellyfin_fails {
                    Err(String::from("no"))
                } else {
                    Ok(())
                }
            })
        }
    }

    #[tokio::test]
    async fn nothing_without_providers() -> Result<(), String> {
        let fake = Fake {
            available: false,
            ..Fake::new()?
        };
        let out = cleanup(7, &fake, vec![pct("e1", 1, 75.0)?], DEFAULT_THRESHOLD).await;
        assert_eq!(ids(&out), vec!["e1"], "unchanged");
        assert!(lock(&fake.calls).is_empty(), "nothing hydrated");
        Ok(())
    }

    #[tokio::test]
    async fn trakt_then_jellyfin() -> Result<(), String> {
        let fake = Fake::new()?;
        let resume = vec![pct("e1", 1, 75.0)?, pct("e2", 2, 10.0)?];
        let out = cleanup(7, &fake, resume, DEFAULT_THRESHOLD).await;
        assert_eq!(ids(&out), vec!["e2"], "the completed one leaves");
        assert_eq!(
            *lock(&fake.calls),
            vec!["episodes series", "status 123 1", "trakt 1", "jellyfin e1"],
            "Trakt before Jellyfin"
        );
        Ok(())
    }

    #[tokio::test]
    async fn already_on_trakt() -> Result<(), String> {
        let fake = Fake {
            season: (true, vec![1.0]),
            ..Fake::new()?
        };
        let out = cleanup(7, &fake, vec![pct("e1", 1, 75.0)?], DEFAULT_THRESHOLD).await;
        assert!(out.is_empty(), "completed");
        assert!(fake.calls("trakt").is_empty(), "no history write");
        assert_eq!(fake.calls("playback"), vec!["playback 1"], "paused cleared");
        assert_eq!(fake.calls("jellyfin"), vec!["jellyfin e1"], "Jellyfin");
        Ok(())
    }

    #[tokio::test]
    async fn failures_keep_the_episode() -> Result<(), String> {
        let resume = || pct("e1", 1, 75.0).map(|e| vec![e]);
        let unmapped = Fake {
            mapped: Ok(HashMap::new()),
            ..Fake::new()?
        };
        let out = cleanup(7, &unmapped, resume()?, DEFAULT_THRESHOLD).await;
        assert_eq!(ids(&out), vec!["e1"], "no mapping");
        assert!(unmapped.calls("status").is_empty(), "no Trakt call");

        let refused = Fake {
            trakt_write: false,
            ..Fake::new()?
        };
        let out = cleanup(7, &refused, resume()?, DEFAULT_THRESHOLD).await;
        assert_eq!(ids(&out), vec!["e1"], "Trakt took no write");
        assert!(
            refused.calls("jellyfin").is_empty(),
            "Jellyfin not attempted"
        );

        let unavailable = Fake {
            season: (false, Vec::new()),
            ..Fake::new()?
        };
        let out = cleanup(7, &unavailable, resume()?, DEFAULT_THRESHOLD).await;
        assert_eq!(ids(&out), vec!["e1"], "Trakt unavailable");
        assert!(
            unavailable.calls("trakt").is_empty() && unavailable.calls("jellyfin").is_empty(),
            "nothing written"
        );

        let jellyfin = Fake {
            jellyfin_fails: true,
            ..Fake::new()?
        };
        let out = cleanup(7, &jellyfin, resume()?, DEFAULT_THRESHOLD).await;
        assert_eq!(ids(&out), vec!["e1"], "Jellyfin failed");
        Ok(())
    }

    #[tokio::test]
    async fn the_show_id_comes_from_the_series() -> Result<(), String> {
        let fake = Fake {
            mapped: Ok(HashMap::new()),
            series: Some(series("Tmdb", "456")?),
            season: (true, vec![1.0]),
            ..Fake::new()?
        };
        cleanup(7, &fake, vec![pct("e1", 1, 75.0)?], DEFAULT_THRESHOLD).await;
        assert_eq!(fake.calls("status"), vec!["status 456 1"], "series id");

        let failed_query = Fake {
            mapped: Err(String::from("database unavailable")),
            series: Some(series("TheMovieDb", "789")?),
            season: (true, vec![1.0]),
            ..Fake::new()?
        };
        cleanup(
            7,
            &failed_query,
            vec![pct("e1", 1, 75.0)?],
            DEFAULT_THRESHOLD,
        )
        .await;
        assert_eq!(
            failed_query.calls("status"),
            vec!["status 789 1"],
            "the series item after a failed query"
        );
        Ok(())
    }

    #[tokio::test]
    async fn keeps_the_frontier() -> Result<(), String> {
        let all = vec![
            pct("e10", 10, 70.0)?,
            pct("e12", 12, 65.0)?,
            pct("e13", 13, 60.0)?,
            pct("e15", 15, 55.0)?,
        ];
        let fake = Fake {
            episodes: Ok(all.clone()),
            ..Fake::new()?
        };
        let out = cleanup(7, &fake, all, DEFAULT_THRESHOLD).await;
        assert_eq!(ids(&out), vec!["e15"], "the frontier stays");
        assert_eq!(
            fake.calls("jellyfin"),
            vec!["jellyfin e10", "jellyfin e12", "jellyfin e13"],
            "older ones marked"
        );
        assert_eq!(
            fake.calls("status"),
            vec!["status 123 1"],
            "one season read"
        );
        Ok(())
    }

    #[tokio::test]
    async fn clears_played_leftovers() -> Result<(), String> {
        let e1 = ep("e1", 1, &json!({"Played": true, "PlayedPercentage": 88}))?;
        let e2 = pct("e2", 2, 10.0)?;
        let fake = Fake {
            episodes: Ok(vec![e1.clone(), e2.clone()]),
            season: (true, vec![1.0]),
            ..Fake::new()?
        };
        let out = cleanup(7, &fake, vec![e1, e2], DEFAULT_THRESHOLD).await;
        assert_eq!(ids(&out), vec!["e2"], "the leftover leaves");
        assert!(fake.calls("trakt").is_empty(), "no history write");
        assert_eq!(fake.calls("playback"), vec!["playback 1"], "paused cleared");
        assert_eq!(fake.calls("jellyfin"), vec!["jellyfin e1"], "Jellyfin");
        Ok(())
    }

    #[tokio::test]
    async fn uses_the_threshold() -> Result<(), String> {
        let e1 = pct("e1", 1, 40.0)?;
        let e2 = pct("e2", 2, 10.0)?;
        let fake = Fake {
            episodes: Ok(vec![e1.clone(), e2.clone()]),
            ..Fake::new()?
        };
        let both = vec![e1, e2];
        let out = cleanup(7, &fake, both.clone(), DEFAULT_THRESHOLD).await;
        assert_eq!(ids(&out), vec!["e1", "e2"], "below the default");
        assert!(fake.calls("jellyfin").is_empty(), "nothing written");
        let out = cleanup(7, &fake, both, 40.0).await;
        assert_eq!(ids(&out), vec!["e2"], "at 40");
        assert_eq!(fake.calls("jellyfin"), vec!["jellyfin e1"], "written");
        Ok(())
    }

    #[tokio::test]
    async fn failed_hydration_keeps_everything() -> Result<(), String> {
        let fake = Fake {
            episodes: Err(String::from("down")),
            ..Fake::new()?
        };
        let out = cleanup(7, &fake, vec![pct("e1", 1, 75.0)?], DEFAULT_THRESHOLD).await;
        assert_eq!(ids(&out), vec!["e1"], "nothing classified");
        assert!(fake.calls("status").is_empty(), "no Trakt call");
        Ok(())
    }

    #[tokio::test]
    async fn maps_series_through_the_media_table() -> anyhow::Result<()> {
        let db = Db::Sqlite(
            sqlx::sqlite::SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await?,
        );
        db.execute(
            r#"CREATE TABLE "media" ("id" INTEGER PRIMARY KEY, "mediaType" TEXT, "tmdbId" INTEGER, "jellyfinMediaId" TEXT, "jellyfinMediaId4k" TEXT)"#,
            &[],
        )
        .await?;
        db.execute(
            r#"INSERT INTO "media" VALUES (1, 'tv', 10, 'a', NULL), (2, 'tv', 20, 'x', 'b'), (3, 'movie', 30, 'c', NULL), (4, 'tv', 0, 'd', NULL), (5, 'tv', 50, 'other', NULL)"#,
            &[],
        )
        .await?;
        let ids = ["a", "b", "c", "d"].map(String::from);
        let found = mapped_tmdb_ids(&db, &ids)
            .await
            .map_err(anyhow::Error::msg)?;
        assert_eq!(
            found,
            HashMap::from([(String::from("a"), 10), (String::from("b"), 20)]),
            "TV rows by either id, with a TMDB id"
        );
        assert!(
            mapped_tmdb_ids(&db, &[])
                .await
                .map_err(anyhow::Error::msg)?
                .is_empty(),
            "no ids, no query"
        );
        Ok(())
    }

    #[tokio::test]
    async fn concurrent_map_keeps_order() {
        let items: Vec<u64> = (0..10).collect();
        let out = map_concurrently(&items, |n| async move {
            tokio::time::sleep(std::time::Duration::from_millis(10 - n)).await;
            n * 2
        })
        .await;
        assert_eq!(out, (0..10).map(|n| n * 2).collect::<Vec<_>>(), "in order");
    }
}
