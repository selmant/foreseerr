//! The TVDB metadata provider (`server/api/tvdb/index.ts`).
//!
//! `getTvShow`, which replaces TMDB's season list with TVDB's official seasons, and
//! `getTvSeason`, a season's episodes from TVDB. `getMetadataProvider`
//! (`server/api/metadata.ts`) picks it per show kind.

use std::time::Duration;

use serde_json::{Map, Value};

use crate::settings::public::truthy;
use crate::settings::Settings;
use crate::standalone::internal::Answer;
use crate::state::AppState;

/// `Tvdb.DEFAULT_CACHE_TTL` is the client's; calls that name no TTL use
/// `ExternalAPI`'s five minutes.
const DEFAULT_GET_TTL: Duration = Duration::from_secs(300);
/// Episode pages a season reads at most.
const MAX_PAGES: i64 = 50;
const ARTWORK_BASE: &str = "https://artworks.thetvdb.com";

/// `getMetadataProvider(kind) instanceof Tvdb`: the settings name TVDB
/// for the kind and `Tvdb.getInstance()` didn't throw (its first login
/// failing falls back to TMDB, as Node's catch does).
pub async fn provider_is_tvdb(state: &AppState, settings: &Settings, anime: bool) -> bool {
    let key = if anime {
        "/metadataSettings/anime"
    } else {
        "/metadataSettings/tv"
    };
    if settings.str(key) != "tvdb" {
        return false;
    }
    match crate::tvdb::ensure_instance(&state.outbound).await {
        Ok(()) => true,
        Err(e) => {
            tracing::error!("Failed to get metadata provider: {e:#}");
            false
        }
    }
}

/// `GET /internal/metadata/tv/:kind/:tvId`: `{ show }`, `null` when the
/// provider is TMDB.
pub async fn answer(state: &AppState, kind: &str, tv_id: &str) -> Answer {
    let settings = match super::settings(state).await {
        Ok(settings) => settings,
        Err(e) => return Answer::message(500, &format!("{e:#}")),
    };
    let mut out = Map::new();
    if !provider_is_tvdb(state, &settings, kind == "anime").await {
        out.insert(String::from("show"), Value::Null);
        return Answer::json(200, Value::Object(out));
    }
    let Ok(id) = tv_id.parse::<i64>() else {
        return Answer::message(
            500,
            "[TVDB] Failed to fetch TV show details: Request failed with status code 404",
        );
    };
    let locale = default_locale(&settings);
    match tv_show(state, id, &locale).await {
        Ok(show) => {
            out.insert(String::from("show"), show);
            Answer::json(200, Value::Object(out))
        }
        Err(message) => Answer::message(500, &message),
    }
}

/// `TheMovieDb`'s locale: `main.locale`, or `en`.
#[must_use]
pub fn default_locale(settings: &Settings) -> String {
    let locale = settings.str("/main/locale");
    if locale.is_empty() {
        String::from("en")
    } else {
        locale.to_owned()
    }
}

/// `throw new Error(`[TVDB] ${context}: ${message}`)`.
fn tvdb_error(context: &str, message: &str) -> String {
    format!("[TVDB] {context}: {message}")
}

/// `refreshToken()`, which reports its failure as `handleError` does.
async fn refresh(state: &AppState) -> Result<(), String> {
    crate::tvdb::refresh_token(&state.outbound)
        .await
        .map_err(|e| tvdb_error("Failed to refresh token", &format!("{e:#}")))
}

/// `getTvdbIdFromTmdb`: `external_ids.tvdb_id`, absent or null when the
/// show has none.
fn tvdb_id_of(show: &Value) -> Option<Value> {
    show.pointer("/external_ids/tvdb_id")
        .filter(|v| !v.is_null())
        .cloned()
}

/// `getTvShow({ tvId, language })`.
///
/// # Errors
///
/// TMDB failing, or the token refresh failing (Node's handlers rethrow
/// it, twice wrapped).
pub async fn tv_show(state: &AppState, tv_id: i64, language: &str) -> Result<Value, String> {
    const CONTEXT: &str = "Failed to fetch TV show details";
    let show = state
        .tmdb
        .tv(tv_id, language)
        .await
        .map_err(|e| tvdb_error(CONTEXT, &format!("{e:#}")))?;
    if let Err(message) = refresh(state).await {
        let inner = tvdb_error(CONTEXT, &message);
        return Err(tvdb_error(CONTEXT, &inner));
    }
    let Some(tvdb_id) = tvdb_id_of(&show) else {
        return Ok(show);
    };
    Ok(enrich(state, show, &tvdb_id).await)
}

/// `enrichTmdbShowWithTvdbData`: TVDB's official seasons in place of
/// TMDB's; the TMDB show as it is on any failure.
async fn enrich(state: &AppState, show: Value, tvdb_id: &Value) -> Value {
    let data = match refresh(state).await {
        Ok(()) => show_data(state, tvdb_id).await,
        Err(message) => Err(message),
    };
    let data = match data {
        Ok(data) => data,
        Err(message) => {
            tracing::error!("Failed to enrich TMDB show with TVDB data: {message}");
            return show;
        }
    };
    let seasons = process_seasons(&data);
    if seasons.is_empty() {
        return show;
    }
    let mut show = show;
    if let Value::Object(map) = &mut show {
        map.insert(String::from("seasons"), Value::Array(seasons));
    }
    show
}

/// `fetchTvdbShowData`: the series with its episodes, `data` of the answer.
async fn show_data(state: &AppState, tvdb_id: &Value) -> Result<Value, String> {
    let id = crate::media::js_string(Some(tvdb_id)).into_owned();
    crate::tvdb::get(
        &state.outbound,
        &format!("/series/{id}/extended?meta=episodes&short=true"),
    )
    .await
    .map(|answer| answer.get("data").cloned().unwrap_or(Value::Null))
    .map_err(|e| format!("{e:#}"))
}

fn is_official(season: &Value) -> bool {
    season.pointer("/type/type").and_then(Value::as_str) == Some("official")
}

fn number_of(value: Option<&Value>) -> f64 {
    crate::jsval::number_of(value)
}

/// `processSeasons`: official seasons by number, as TMDB season results.
#[must_use]
pub fn process_seasons(data: &Value) -> Vec<Value> {
    let (Some(seasons), Some(episodes)) = (
        data.get("seasons").filter(|v| truthy(Some(v))),
        data.get("episodes").filter(|v| truthy(Some(v))),
    ) else {
        return Vec::new();
    };
    let Some(seasons) = seasons.as_array() else {
        return Vec::new();
    };
    let episodes = episodes.as_array().map_or(&[][..], Vec::as_slice);
    let mut official: Vec<&Value> = seasons
        .iter()
        .filter(|s| truthy(s.get("type")) && is_official(s))
        .collect();
    official.sort_by(|a, b| number_of(a.get("number")).total_cmp(&number_of(b.get("number"))));
    official
        .into_iter()
        .filter_map(|season| {
            let number = season.get("number").filter(|n| !n.is_null());
            let n = number.map_or(-1.0, |n| number_of(Some(n)));
            // `createSeasonData`'s placeholder for a negative number is
            // dropped by the `season_number >= 0` filter.
            if n < 0.0 || n.is_nan() {
                return None;
            }
            let number = number?;
            let count = episodes
                .iter()
                .filter(|e| {
                    e.get("seasonNumber")
                        .is_some_and(|s| crate::typeorm::strict_eq(s, number))
                })
                .count();
            let mut out = Map::new();
            if let Some(id) = data.get("id") {
                out.insert(String::from("id"), id.clone());
            }
            out.insert(String::from("episode_count"), Value::from(count));
            out.insert(
                String::from("name"),
                Value::from(crate::media::js_string(Some(number)).into_owned()),
            );
            out.insert(String::from("overview"), Value::from(""));
            out.insert(String::from("season_number"), number.clone());
            out.insert(String::from("poster_path"), Value::from(""));
            out.insert(String::from("air_date"), Value::from(""));
            Some(Value::Object(out))
        })
        .collect()
}

/// `getTvSeason({ tvId, seasonNumber, language })`: `None` when the show
/// has no TVDB id (the TMDB season answers then).
///
/// # Errors
///
/// TMDB or TVDB failing, as Node's handlers rethrow.
pub async fn tv_season(
    state: &AppState,
    tv_id: i64,
    season_number: i64,
    language: &str,
) -> Result<Option<Value>, String> {
    const CONTEXT: &str = "Failed to fetch TV season details";
    let show = state
        .tmdb
        .tv(tv_id, language)
        .await
        .map_err(|e| tvdb_error("Failed to fetch TV show details", &format!("{e:#}")))?;
    let inner = async {
        refresh(state).await?;
        let Some(tvdb_id) = tvdb_id_of(&show) else {
            return Ok(None);
        };
        season_data(state, &tvdb_id, season_number, tv_id, language)
            .await
            .map(Some)
    };
    inner.await.map_err(|message| tvdb_error(CONTEXT, &message))
}

/// `createEmptySeasonResponse(tvId)`.
fn empty_season(tv_id: i64) -> Value {
    let mut ids = Map::new();
    ids.insert(String::from("tvdb_id"), Value::from(tv_id));
    season_value(
        Vec::new(),
        Value::Object(ids),
        Some(Value::from(0)),
        Some(Value::from("")),
    )
}

fn season_value(
    episodes: Vec<Value>,
    external_ids: Value,
    id: Option<Value>,
    air_date: Option<Value>,
) -> Value {
    let count = episodes.len();
    let mut out = Map::new();
    out.insert(String::from("episodes"), Value::Array(episodes));
    out.insert(String::from("external_ids"), external_ids);
    out.insert(String::from("name"), Value::from(""));
    out.insert(String::from("overview"), Value::from(""));
    if let Some(id) = id {
        out.insert(String::from("id"), id);
    }
    if let Some(air_date) = air_date {
        out.insert(String::from("air_date"), air_date);
    }
    out.insert(String::from("season_number"), Value::from(count));
    Value::Object(out)
}

/// `getTvdbSeasonData` and `getSeasonWithTranslation` (the translation
/// filter always yields an array, so the original-language branch never
/// runs).
async fn season_data(
    state: &AppState,
    tvdb_id: &Value,
    season_number: i64,
    tv_id: i64,
    language: &str,
) -> Result<Value, String> {
    let data = show_data(state, tvdb_id).await?;
    if !truthy(Some(&data)) {
        tracing::error!(
            "Failed to fetch TVDB data for ID: {}",
            crate::media::js_string(Some(tvdb_id))
        );
        return Ok(empty_season(tv_id));
    }
    let Some(seasons) = data.get("seasons").and_then(Value::as_array) else {
        return Err(String::from("the TVDB show has no seasons"));
    };
    let wanted = Value::from(season_number);
    let mut found = None;
    for season in seasons {
        let Some(kind) = season.get("type").filter(|t| !t.is_null()) else {
            return Err(String::from("a TVDB season has no type"));
        };
        let same = season
            .get("number")
            .is_some_and(|n| crate::typeorm::strict_eq(n, &wanted));
        if same && kind.get("type").and_then(Value::as_str) == Some("official") {
            found = Some(season);
            break;
        }
    }
    let Some(season) = found else {
        tracing::error!(
            "Failed to find season {season_number} for TVDB ID: {}",
            crate::media::js_string(Some(tvdb_id))
        );
        return Ok(empty_season(tv_id));
    };
    if !season.get("nameTranslations").is_some_and(Value::is_array) {
        return Err(String::from("the TVDB season has no name translations"));
    }
    let Some(wanted_language) = crate::tvdb::tvdb_language(language) else {
        return Err(String::from("a language named like an Object property"));
    };
    let episodes = season_episodes(state, tvdb_id, season_number, wanted_language).await?;
    let mapped = episodes
        .iter()
        .filter(|e| {
            e.get("seasonNumber")
                .is_some_and(|s| crate::typeorm::strict_eq(s, &wanted))
        })
        .enumerate()
        .map(|(index, episode)| episode_data(episode, index, tv_id))
        .collect();
    let mut ids = Map::new();
    ids.insert(String::from("tvdb_id"), tvdb_id.clone());
    Ok(season_value(
        mapped,
        Value::Object(ids),
        season.get("id").cloned(),
        season.get("firstAired").cloned(),
    ))
}

/// Every page of `/series/:id/episodes/default/:language`.
async fn season_episodes(
    state: &AppState,
    tvdb_id: &Value,
    season_number: i64,
    language: &str,
) -> Result<Vec<Value>, String> {
    let id = crate::media::js_string(Some(tvdb_id)).into_owned();
    let mut all = Vec::new();
    let mut page = 0;
    while page < MAX_PAGES {
        let answer = crate::tvdb::get_ttl(
            &state.outbound,
            &format!("/series/{id}/episodes/default/{language}?page={page}"),
            DEFAULT_GET_TTL,
        )
        .await
        .map_err(|e| format!("{e:#}"))?;
        let Some(episodes) = answer.pointer("/data/episodes").filter(|e| truthy(Some(e))) else {
            tracing::warn!(
                "No episodes found for TVDB ID: {id} on page {page} for season {season_number}"
            );
            break;
        };
        let list = episodes.as_array().cloned().unwrap_or_default();
        let more = truthy(answer.pointer("/links/next")) && !list.is_empty();
        all.extend(list);
        if !more {
            break;
        }
        page += 1;
    }
    if page >= MAX_PAGES {
        tracing::warn!(
            "Reached max pages ({MAX_PAGES}) for TVDB ID: {id} on season {season_number} with language {language}. There might be more episodes available."
        );
    }
    Ok(all)
}

/// `createEpisodeData`.
fn episode_data(episode: &Value, index: usize, tv_id: i64) -> Value {
    let mut out = Map::new();
    let mut copy = |key: &str, source: &str| {
        if let Some(value) = episode.get(source) {
            out.insert(key.to_owned(), value.clone());
        }
    };
    copy("id", "id");
    copy("air_date", "aired");
    copy("episode_number", "number");
    let name = episode
        .get("name")
        .filter(|n| truthy(Some(n)))
        .cloned()
        .unwrap_or_else(|| Value::from(format!("Episode {}", index + 1)));
    out.insert(String::from("name"), name);
    let overview = episode
        .get("overview")
        .filter(|o| truthy(Some(o)))
        .cloned()
        .unwrap_or_else(|| Value::from(""));
    out.insert(String::from("overview"), overview);
    if let Some(season) = episode.get("seasonNumber") {
        out.insert(String::from("season_number"), season.clone());
    }
    out.insert(String::from("production_code"), Value::from(""));
    out.insert(String::from("show_id"), Value::from(tv_id));
    let still = episode
        .get("image")
        .filter(|i| truthy(Some(i)))
        .map(|i| crate::media::js_string(Some(i)).into_owned())
        .filter(|i| !i.starts_with("https://"))
        .map_or_else(String::new, |i| format!("{ARTWORK_BASE}{i}"));
    out.insert(String::from("still_path"), Value::from(still));
    out.insert(String::from("vote_average"), Value::from(1));
    out.insert(String::from("vote_count"), Value::from(1));
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn official_seasons_replace_tmdbs() {
        let data = json!({
            "id": 81189,
            "seasons": [
                {"number": 2, "type": {"type": "official"}},
                {"number": 0, "type": {"type": "official"}},
                {"number": 1, "type": {"type": "official"}},
                {"number": 1, "type": {"type": "dvd"}},
                {"number": null, "type": {"type": "official"}}
            ],
            "episodes": [
                {"seasonNumber": 1}, {"seasonNumber": 1}, {"seasonNumber": 2}, {"seasonNumber": 0}
            ]
        });
        let seasons = process_seasons(&data);
        assert_eq!(
            Value::Array(seasons),
            json!([
                {"id": 81189, "episode_count": 1, "name": "0", "overview": "", "season_number": 0, "poster_path": "", "air_date": ""},
                {"id": 81189, "episode_count": 2, "name": "1", "overview": "", "season_number": 1, "poster_path": "", "air_date": ""},
                {"id": 81189, "episode_count": 1, "name": "2", "overview": "", "season_number": 2, "poster_path": "", "air_date": ""}
            ]),
            "sorted official seasons with their episode counts"
        );
        assert!(
            process_seasons(&json!({"seasons": []})).is_empty(),
            "no episodes"
        );
    }

    #[test]
    fn episodes_map_like_tmdbs() {
        let episode = json!({"id": 7, "aired": "2020-01-02", "number": 3, "name": "", "seasonNumber": 1, "image": "/banners/x.jpg"});
        assert_eq!(
            episode_data(&episode, 2, 99),
            json!({"id": 7, "air_date": "2020-01-02", "episode_number": 3, "name": "Episode 3",
                   "overview": "", "season_number": 1, "production_code": "", "show_id": 99,
                   "still_path": "https://artworks.thetvdb.com/banners/x.jpg", "vote_average": 1, "vote_count": 1}),
            "mapped"
        );
        let remote = json!({"image": "https://x/y.jpg"});
        assert_eq!(
            episode_data(&remote, 0, 1).get("still_path"),
            Some(&json!("")),
            "absolute images are dropped"
        );
        assert_eq!(
            empty_season(5),
            json!({"episodes": [], "external_ids": {"tvdb_id": 5}, "name": "", "overview": "", "id": 0, "air_date": "", "season_number": 0}),
            "empty season"
        );
    }
}
