//! `trakt.ts` and `traktEpisodes.ts`: Trakt history and ratings, read
//! from the warm sync snapshot and patched after each write.

use serde_json::Value;

use super::dispatcher::{Fut, MarkOptions, Provider, Thrown, Write};
use super::env::{stored_false, text, Env};
use super::score::stars_to_provider;
use super::types::{Capabilities, EpisodeWrite, Item, ProviderId, Status, FULL};
use crate::mappinglayer::synccache::{self, TraktPatch, TraktSnapshot};
use crate::settings::Settings;
use crate::state::AppState;
use crate::trakt::actions;
use crate::trakt::{NodeRefresh, TraktClient, TraktError};

/// `createTraktUserClient(userId)` for a direct Trakt link.
///
/// # Errors
///
/// Not configured, not linked, or a database failure.
pub async fn client(env: &Env<'_>) -> Result<TraktClient, TraktError> {
    user_client(env.state, &env.settings, env.user).await
}

/// [`client`] for any user, outside a media action (the watched-title
/// filter's).
///
/// # Errors
///
/// As [`client`].
pub async fn user_client(
    state: &AppState,
    settings: &Settings,
    user: i64,
) -> Result<TraktClient, TraktError> {
    if crate::traktbridge::enabled(settings) {
        return crate::traktbridge::user_client(state, settings, user).await;
    }
    let (client_id, _secret) = crate::trakt::app_credentials(settings)?;
    let row = Env::user_settings_of(
        state,
        user,
        r#""traktAccessToken" AS "access", "traktRefreshToken" AS "refresh", CAST("traktTokenExpiresAt" AS TEXT) AS "expires""#,
    )
    .await
    .map_err(TraktError::Other)?;
    let row = row.as_ref();
    let (Some(access), Some(refresh)) = (text(row, "access"), text(row, "refresh")) else {
        return Err(TraktError::NotLinked);
    };
    let expires_at = text(row, "expires").map_or(0.0, |t| crate::jsval::number_of_str(&t));
    let node = NodeRefresh {
        client: state.internal.clone(),
        url: format!(
            "{}/internal/trakt/refresh",
            state.env.node_url.trim_end_matches('/')
        ),
        api_key: settings.api_key().to_owned(),
        user_id: user,
    };
    Ok(TraktClient::user(
        state.outbound.clone(),
        client_id,
        access,
        refresh,
        expires_at,
        node,
    ))
}

/// `isTraktMediaActionsAvailable(userId)` for a direct Trakt link.
///
/// # Errors
///
/// What `traktAvailabilityFromError` rethrows.
pub async fn available(env: &Env<'_>) -> Result<bool, Thrown> {
    if env.provider_off("trakt") {
        return Ok(false);
    }
    let bridge = crate::traktbridge::enabled(&env.settings);
    if !bridge {
        match crate::trakt::app_credentials(&env.settings) {
            Ok(_) => {}
            Err(TraktError::NotConfigured) => return Ok(false),
            Err(e) => return Err(e.message()),
        }
    }
    let row = env.user_settings(r#""mediaActionsTraktEnabled""#).await?;
    if stored_false(row.as_ref(), "mediaActionsTraktEnabled") {
        return Ok(false);
    }
    // `traktAvailabilityFromError`: not configured, not linked and the
    // Jellyfin provider's errors mean unavailable; anything else throws.
    match client(env).await {
        Ok(_) => Ok(true),
        Err(TraktError::NotConfigured | TraktError::NotLinked) => Ok(false),
        Err(e) if crate::traktbridge::is_provider_error(&e) => Ok(false),
        Err(e) => Err(e.message()),
    }
}

/// `watchedAtIso(watchedAt)`: now, unless the release date is wanted.
fn watched_at(at_release: bool) -> Option<String> {
    (!at_release)
        .then(|| crate::clock::Utc::from_unix_millis(crate::clock::now_millis()).iso_string())
}

/// `TraktMediaActionProvider`.
#[derive(Debug)]
pub struct TraktProvider<'a> {
    env: &'a Env<'a>,
}

impl<'a> TraktProvider<'a> {
    /// For one request.
    #[must_use]
    pub const fn new(env: &'a Env<'a>) -> Self {
        Self { env }
    }

    /// The client and the warm snapshot.
    async fn snapshot(&self) -> Result<(TraktClient, std::sync::Arc<TraktSnapshot>), Thrown> {
        let client = client(self.env).await.map_err(|e| e.message())?;
        let snapshot = synccache::warm_trakt(&client, self.env.user)
            .await
            .map_err(|e| e.message())?;
        Ok((client, snapshot))
    }

    async fn mark(&self, item: Item, options: MarkOptions) -> Result<Status, Thrown> {
        let (client, snapshot) = self.snapshot().await?;
        let (_, current) = synccache::lookup_trakt(&snapshot, item.media_type, item.tmdb_id);
        let rating = options.rating_stars.map(stars_to_provider).transpose()?;
        let at = watched_at(options.at_release);
        actions::add_to_history(&client, item.media_type, item.tmdb_id, at.as_deref())
            .await
            .map_err(|e| e.message())?;
        if let Some(rating) = rating {
            actions::add_rating(&client, item.media_type, item.tmdb_id, rating)
                .await
                .map_err(|e| e.message())?;
        }
        synccache::patch_trakt(
            self.env.user,
            item.media_type,
            item.tmdb_id,
            TraktPatch {
                watched: Some(true),
                rating: rating.map(Some),
            },
        );
        Ok(Status::of(true, rating.or(current)))
    }

    async fn unmark(&self, item: Item, remove_rating: bool) -> Result<Status, Thrown> {
        let (client, snapshot) = self.snapshot().await?;
        let (_, current) = synccache::lookup_trakt(&snapshot, item.media_type, item.tmdb_id);
        actions::remove_from_history(&client, item.media_type, item.tmdb_id)
            .await
            .map_err(|e| e.message())?;
        if remove_rating {
            actions::remove_rating(&client, item.media_type, item.tmdb_id)
                .await
                .map_err(|e| e.message())?;
        }
        synccache::patch_trakt(
            self.env.user,
            item.media_type,
            item.tmdb_id,
            TraktPatch {
                watched: Some(false),
                rating: remove_rating.then_some(None),
            },
        );
        Ok(Status::of(
            false,
            if remove_rating { None } else { current },
        ))
    }

    async fn rate(&self, item: Item, stars: f64) -> Result<Status, Thrown> {
        let rating = stars_to_provider(stars)?;
        let (client, snapshot) = self.snapshot().await?;
        let (watched, _) = synccache::lookup_trakt(&snapshot, item.media_type, item.tmdb_id);
        actions::add_rating(&client, item.media_type, item.tmdb_id, rating)
            .await
            .map_err(|e| e.message())?;
        synccache::patch_trakt(
            self.env.user,
            item.media_type,
            item.tmdb_id,
            TraktPatch {
                watched: None,
                rating: Some(Some(rating)),
            },
        );
        Ok(Status::of(watched, Some(rating)))
    }
}

impl Provider for TraktProvider<'_> {
    fn id(&self) -> ProviderId {
        ProviderId::Trakt
    }

    fn capabilities(&self) -> Capabilities {
        FULL
    }

    fn is_available(&self) -> Fut<'_, Result<bool, Thrown>> {
        Box::pin(available(self.env))
    }

    fn status(&self, item: Item) -> Fut<'_, Result<Status, Thrown>> {
        Box::pin(async move {
            let (_, snapshot) = self.snapshot().await?;
            let (watched, rating) =
                synccache::lookup_trakt(&snapshot, item.media_type, item.tmdb_id);
            Ok(Status::of(watched, rating))
        })
    }

    fn statuses<'b>(&'b self, items: &'b [Item]) -> Fut<'b, Result<Vec<(Item, Status)>, Thrown>> {
        Box::pin(async move {
            if items.is_empty() {
                return Ok(Vec::new());
            }
            let (_, snapshot) = self.snapshot().await?;
            Ok(items
                .iter()
                .map(|item| {
                    let (watched, rating) =
                        synccache::lookup_trakt(&snapshot, item.media_type, item.tmdb_id);
                    (*item, Status::of(watched, rating))
                })
                .collect())
        })
    }

    fn write(&self, item: Item, write: Write) -> Fut<'_, Result<Status, Thrown>> {
        Box::pin(async move {
            match write {
                Write::Mark(options) => self.mark(item, options).await,
                Write::Unmark { remove_rating } => self.unmark(item, remove_rating).await,
                Write::Rate(stars) => self.rate(item, stars).await,
            }
        })
    }
}

/// `findWatchedEpisodeNumbers(watchedShows, tmdbId, seasonNumber)`.
#[must_use]
pub fn watched_episode_numbers(watched_shows: &[Value], tmdb_id: i64, season: i64) -> Vec<f64> {
    let show = watched_shows.iter().find(|entry| {
        let tmdb = entry
            .get("show")
            .and_then(|s| s.get("ids"))
            .and_then(|i| i.get("tmdb"));
        crate::jsval::same(
            crate::jsval::number_of(tmdb),
            crate::jsnum::from_i64(tmdb_id),
        )
    });
    let season = show
        .and_then(|s| s.get("seasons"))
        .and_then(Value::as_array)
        .and_then(|seasons| {
            seasons.iter().find(|s| {
                s.get("number")
                    .and_then(Value::as_f64)
                    .is_some_and(|n| crate::jsval::same(n, crate::jsnum::from_i64(season)))
            })
        });
    let mut numbers: Vec<f64> = Vec::new();
    for episode in season
        .and_then(|s| s.get("episodes"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let plays = episode
            .get("plays")
            .filter(|p| !p.is_null())
            .map_or(1.0, |p| crate::jsval::number_of(Some(p)));
        if plays <= 0.0 || plays.is_nan() {
            continue;
        }
        let Some(number) = episode.get("number").and_then(Value::as_f64) else {
            continue;
        };
        if !numbers.contains(&number) {
            numbers.push(number);
        }
    }
    numbers.sort_by(f64::total_cmp);
    numbers
}

/// `traktEpisodeActions.getSeasonStatus`: `(available, episodes)`.
///
/// # Errors
///
/// What the availability check or the snapshot throws.
pub async fn season_status(
    env: &Env<'_>,
    tmdb_id: i64,
    season: i64,
) -> Result<(bool, Vec<f64>), Thrown> {
    if !available(env).await? {
        return Ok((false, Vec::new()));
    }
    let client = client(env).await.map_err(|e| e.message())?;
    let snapshot = synccache::warm_trakt(&client, env.user)
        .await
        .map_err(|e| e.message())?;
    Ok((
        true,
        watched_episode_numbers(&snapshot.watched_shows, tmdb_id, season),
    ))
}

/// `traktEpisodeActions.setWatched`.
///
/// # Errors
///
/// Trakt's failures.
pub async fn set_episode_watched(
    env: &Env<'_>,
    tmdb_id: i64,
    season: i64,
    episode: i64,
    watched: bool,
) -> Result<EpisodeWrite, Thrown> {
    if !available(env).await? {
        return Ok(EpisodeWrite::Done(false));
    }
    let client = client(env).await.map_err(|e| e.message())?;
    let written = if watched {
        actions::add_episode_to_history(&client, tmdb_id, season, episode).await
    } else {
        actions::remove_episode_from_history(&client, tmdb_id, season, episode).await
    };
    written.map_err(|e| e.message())?;
    synccache::invalidate_user_sync_cache(env.user);
    Ok(EpisodeWrite::Done(true))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_watched_episodes() {
        let shows = vec![json!({
            "show": {"ids": {"tmdb": 42}},
            "seasons": [
                {"number": 1, "episodes": [
                    {"number": 1, "plays": 1},
                    {"number": 2, "plays": 2},
                    {"number": 2, "plays": 2},
                    {"number": 3, "plays": 0}
                ]},
                {"number": 2, "episodes": [{"number": 1, "plays": 1}]}
            ]
        })];
        assert_eq!(
            watched_episode_numbers(&shows, 42, 1),
            vec![1.0, 2.0],
            "unique, played"
        );
        assert_eq!(
            watched_episode_numbers(&shows, 42, 2),
            vec![1.0],
            "other season"
        );
        assert!(
            watched_episode_numbers(&shows, 99, 1).is_empty(),
            "other show"
        );
    }
}
