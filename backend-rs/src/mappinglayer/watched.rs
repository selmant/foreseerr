//! `loadCombinedWatchedIdSets(userId)` (`lib/trakt/hideWatched.ts`): the
//! TMDB ids the user watched on Trakt, Jellyfin and `AniList`.

use serde_json::Value;

use super::synccache::{self, TraktSnapshot};
use super::{Ctx, MediaType};
use crate::anilist::Anilist;
use crate::db::Bind;
use crate::library::{Lib, Link};
use crate::settings::Settings;
use crate::state::AppState;
use crate::trakt::TraktError;

/// `WatchedIdSets`, each in insertion order (`Set` semantics, so `NaN`
/// appears once).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WatchedSets {
    /// Movie ids.
    pub movie: Vec<f64>,
    /// Show ids.
    pub tv: Vec<f64>,
}

impl WatchedSets {
    fn add(list: &mut Vec<f64>, id: f64) {
        let same = |x: &f64| {
            x.partial_cmp(&id) == Some(std::cmp::Ordering::Equal) || (x.is_nan() && id.is_nan())
        };
        if !list.iter().any(same) {
            list.push(id);
        }
    }

    fn add_movie(&mut self, id: f64) {
        Self::add(&mut self.movie, id);
    }

    fn add_tv(&mut self, id: f64) {
        Self::add(&mut self.tv, id);
    }

    /// `unionWatchedIdSets(...sets)`.
    fn union(sets: [Self; 3]) -> Self {
        let mut out = Self::default();
        for set in sets {
            for id in set.movie {
                out.add_movie(id);
            }
            for id in set.tv {
                out.add_tv(id);
            }
        }
        out
    }

    /// `{ movie: [...sets.movie], tv: [...sets.tv] }` as `res.json` prints it.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let list = |ids: &[f64]| Value::Array(ids.iter().map(|n| crate::jsval::num(*n)).collect());
        let mut out = serde_json::Map::new();
        out.insert(String::from("movie"), list(&self.movie));
        out.insert(String::from("tv"), list(&self.tv));
        Value::Object(out)
    }
}

/// `buildWatchedIdSets(snapshot)`.
fn from_trakt(snapshot: &TraktSnapshot) -> WatchedSets {
    let mut sets = WatchedSets::default();
    let id = |entry: &Value, key: &str| -> Option<f64> {
        let tmdb = entry
            .get(key)?
            .get("ids")?
            .get("tmdb")
            .filter(|v| !v.is_null())?;
        Some(crate::jsval::number_of(Some(tmdb)))
    };
    for entry in &snapshot.watched_movies {
        if let Some(n) = id(entry, "movie") {
            sets.add_movie(n);
        }
    }
    for entry in &snapshot.watched_shows {
        if let Some(n) = id(entry, "show") {
            sets.add_tv(n);
        }
    }
    sets
}

/// Why the watched sets have to come from Node after all.
#[derive(Debug)]
pub struct NodeOnly(pub &'static str);

/// `loadTraktWatchedIdSets(userId)`.
async fn trakt_sets(state: &AppState, settings: &Settings, user: i64) -> WatchedSets {
    let loaded = match crate::mediaactions::trakt::user_client(state, settings, user).await {
        Ok(client) => synccache::warm_trakt(&client, user).await,
        Err(e) => Err(e),
    };
    match loaded {
        Ok(snapshot) => from_trakt(&snapshot),
        Err(TraktError::NotConfigured | TraktError::NotLinked) => WatchedSets::default(),
        Err(e) => {
            tracing::debug!(
                label = "API",
                "Skipping Trakt watched-title filtering: {}",
                e.message()
            );
            WatchedSets::default()
        }
    }
}

/// `loadJellyfinWatchedIdSets(userId)`: the user's played movies and
/// series (`getPlayedLibraryItems`, at most 5000).
async fn jellyfin_sets(state: &AppState, settings: &Settings, user: i64) -> WatchedSets {
    let lib = Lib {
        state,
        settings,
        user_id: user,
    };
    let client = match lib.link().await {
        Ok(Link::Linked(linked)) => linked.client,
        Ok(Link::Code(_)) => return WatchedSets::default(),
        Err(e) => {
            tracing::debug!(
                label = "API",
                "Skipping Jellyfin watched-title filtering: {e}"
            );
            return WatchedSets::default();
        }
    };
    let mut sets = WatchedSets::default();
    let max_items = 5000;
    let mut count = 0;
    let mut start = 0;
    while count < max_items {
        let take = (max_items - count).min(250);
        let params = [
            ("userId", client.user_id().to_owned()),
            ("Recursive", String::from("true")),
            ("IncludeItemTypes", String::from("Movie,Series")),
            ("Filters", String::from("IsPlayed")),
            ("Fields", String::from("ProviderIds")),
            ("EnableUserData", String::from("true")),
            ("StartIndex", start.to_string()),
            ("Limit", take.to_string()),
        ];
        let (items, total) = match client.browse(&params).await {
            Ok(page) => page,
            Err(e) => {
                tracing::debug!(
                    label = "API",
                    "Skipping Jellyfin watched-title filtering: {e:?}"
                );
                return WatchedSets::default();
            }
        };
        let got = items.len();
        for item in &items {
            let raw = item
                .provider("Tmdb")
                .or_else(|| item.provider("TheMovieDb"))
                .filter(|r| !r.is_empty());
            let Some(raw) = raw else {
                continue;
            };
            let n = crate::jsval::number_of_str(raw);
            if !(n.is_finite() && n > 0.0) {
                continue;
            }
            if item.is("Movie") {
                sets.add_movie(n);
            } else if item.is("Series") {
                sets.add_tv(n);
            }
        }
        count += got;
        let seen = count.to_string().parse::<f64>().unwrap_or(f64::MAX);
        if got == 0 || seen >= total || got < take {
            break;
        }
        start += got;
    }
    sets
}

enum AnilistLoad {
    /// Not configured or not linked: no log.
    Unavailable,
    /// Anything else.
    Failed(String),
}

/// `createAnilistUserClient(userId)` and the linked account id.
async fn anilist_client(
    state: &AppState,
    settings: &Settings,
    user: i64,
) -> Result<Option<(Anilist, f64)>, AnilistLoad> {
    let configured = |pointer: &str| {
        settings
            .get(pointer)
            .and_then(Value::as_str)
            .is_some_and(|s| !crate::jsval::trim(s).is_empty())
    };
    if !configured("/anilist/clientId") || !configured("/anilist/clientSecret") {
        return Err(AnilistLoad::Unavailable);
    }
    let rows = state
        .db
        .rows(
            r#"SELECT "id", "anilistAccessToken" AS "token", CAST("anilistTokenExpiresAt" AS TEXT) AS "expires", "anilistUserId" AS "account" FROM "user_settings" WHERE "userId" = ?1"#,
            &[Bind::Int(user)],
        )
        .await
        .map_err(|e| AnilistLoad::Failed(format!("{e:#}")))?;
    let Some(row) = rows.first() else {
        return Err(AnilistLoad::Unavailable);
    };
    let stored = row.get("token").and_then(Value::as_str);
    let token = stored
        .map(crate::jsval::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned);
    let (Some(stored), Some(token)) = (stored, token) else {
        return Err(AnilistLoad::Unavailable);
    };
    if crate::mediaactions::anilist::token_expired(row.get("expires").and_then(Value::as_str)) {
        crate::mediaactions::anilist::clear_expired_link(state, stored, user)
            .await
            .map_err(AnilistLoad::Failed)?;
        return Err(AnilistLoad::Unavailable);
    }
    let account = crate::jsval::number_of(row.get("account"));
    if !account.is_finite() || account <= 0.0 {
        return Ok(None);
    }
    Ok(Some((Anilist::new(&state.outbound, Some(token)), account)))
}

/// `loadAnilistWatchedIdSets(userId)`.
async fn anilist_sets(state: &AppState, settings: &Settings, user: i64) -> WatchedSets {
    let ctx = Ctx::with_settings(state, settings);
    let loaded = match anilist_client(state, settings, user).await {
        Ok(Some((client, account))) => {
            synccache::warm_anilist(&ctx, &client, user, &crate::jsval::num(account))
                .await
                .map(Some)
                .map_err(AnilistLoad::Failed)
        }
        Ok(None) => Ok(None),
        Err(e) => Err(e),
    };
    let mut sets = WatchedSets::default();
    match loaded {
        Ok(Some(snapshot)) => {
            for entry in &snapshot.entries {
                if !synccache::is_anilist_watched_status(entry.status.as_deref()) {
                    continue;
                }
                let id = crate::jsnum::from_i64(entry.tmdb_id);
                match entry.media_type {
                    MediaType::Movie => sets.add_movie(id),
                    MediaType::Tv => sets.add_tv(id),
                }
            }
        }
        Ok(None) | Err(AnilistLoad::Unavailable) => {}
        Err(AnilistLoad::Failed(message)) => {
            tracing::debug!(
                label = "API",
                "Skipping AniList watched-title filtering: {message}"
            );
        }
    }
    sets
}

/// `loadCombinedWatchedIdSets(userId)`.
///
/// # Errors
///
/// Never fails since the Better Trakt token bridge is ported; callers
/// still take [`NodeOnly`].
pub async fn load_combined(
    state: &AppState,
    settings: &Settings,
    user: i64,
) -> Result<WatchedSets, NodeOnly> {
    let trakt = trakt_sets(state, settings, user);
    let (trakt, jellyfin, anilist) = tokio::join!(
        trakt,
        jellyfin_sets(state, settings, user),
        anilist_sets(state, settings, user)
    );
    let sets: [WatchedSets; 3] = (trakt, jellyfin, anilist).into();
    Ok(WatchedSets::union(sets))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_sets_from_a_snapshot() {
        let snapshot = TraktSnapshot {
            watched_movies: vec![
                json!({"movie": {"ids": {"tmdb": 10}}}),
                json!({"movie": {"ids": {"tmdb": null}}}),
                json!({"movie": {"ids": {"tmdb": 10}}}),
            ],
            watched_shows: vec![json!({"show": {"ids": {"tmdb": 20}}})],
            fetched_at: 0.0,
            ..TraktSnapshot::default()
        };
        let sets = from_trakt(&snapshot);
        assert_eq!(sets.movie, vec![10.0], "movies, once");
        assert_eq!(sets.tv, vec![20.0], "shows");
        let jellyfin = WatchedSets {
            movie: vec![11.0, 10.0],
            tv: Vec::new(),
        };
        let union = WatchedSets::union([sets, jellyfin, WatchedSets::default()]);
        assert_eq!(
            union.to_json().to_string(),
            r#"{"movie":[10,11],"tv":[20]}"#,
            "union in insertion order"
        );
    }
}
