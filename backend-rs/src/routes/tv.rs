//! `GET /tv/{id}` and its `recommendations`, `similar` and `ratings`
//! lists, through TMDB or, for shows whose metadata provider is TVDB,
//! through [`super::procstate::tvdbshow`].

use std::future::Future;
use std::pin::Pin;

use serde_json::{Map, Value};

use super::movie::{
    languages, map_cast_aggregate, map_crew, map_external_ids, map_videos, map_watch_providers,
    media_info_json, picked, ratings_for, Fail, RelatedTitles,
};
use super::procstate::tvdbshow;
use super::ratingsenrich::enrich_results_with_ratings;
use super::{Outcome, Ready};
use crate::settings::public::truthy;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// TMDB's `Animation` genre and `anime` keyword.
const ANIMATION_GENRE_ID: i64 = 16;
const ANIME_KEYWORD_ID: i64 = 210_024;

/// `GET /tv/{id}`.
pub(super) fn detail<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user = match ctx.require(0) {
            Ok(user) => user,
            Err(answer) => return *answer,
        };
        let language = match super::movie::language_of(ctx) {
            Ok(language) => language,
            Err(why) => return Outcome::forward(why),
        };
        let id = match super::movie::path_number(ctx, 0) {
            Ok(id) => id,
            Err(why) => return Outcome::forward(why),
        };
        let (main_locale, language) = languages(ctx, user.locale.as_deref(), language.as_deref());
        // The first lookup, in the main locale, only decides the provider.
        let probe = match ctx.state.tmdb.tv(id, &main_locale).await {
            Ok(show) => show,
            Err(e) => {
                tracing::debug!("TMDB show {id} failed: {e:#}");
                return ctx.error(500, "Unable to retrieve series.");
            }
        };
        let tvdb = tvdbshow::provider_is_tvdb(ctx.state, &ctx.settings, is_anime(&probe)).await;
        let fetched = if tvdb {
            tvdbshow::tv_show(ctx.state, id, &language)
                .await
                .map_err(anyhow::Error::msg)
        } else {
            ctx.state.tmdb.tv(id, &language).await
        };
        let show = match fetched {
            Ok(show) => show,
            Err(e) => {
                tracing::debug!("TMDB show {id} failed: {e:#}");
                return ctx.error(500, "Unable to retrieve series.");
            }
        };
        let tmdb_id = show.get("id").and_then(Value::as_i64).unwrap_or(id);
        let media = ctx
            .state
            .db
            .media_by_tmdb(tmdb_id, "tv")
            .await
            .ok()
            .flatten();
        let on_watchlist = match super::movie::on_watchlist(ctx, id, "tv", user.id).await {
            Ok(exists) => exists,
            Err(e) => {
                tracing::debug!("watchlist lookup failed: {e}");
                return ctx.error(500, "Unable to retrieve series.");
            }
        };
        let media_info = match &media {
            Some(media) => match media_info_json(ctx, media).await {
                Ok(json) => Some(json),
                Err(why) => return Outcome::forward(why),
            },
            None => None,
        };
        let mut data = match map_tv_details(&show, media_info, on_watchlist) {
            Ok(data) => data,
            Err(why) => {
                tracing::debug!("mapping show {id} failed: {why}");
                return ctx.error(500, "Unable to retrieve series.");
            }
        };
        // `metadataProvider instanceof Tvdb && main.partialRequestsEnabled`.
        if !tvdb {
            data.insert(String::from("episodeRequestsEnabled"), Value::Bool(false));
        } else if let Some(partial) = ctx.settings.get("/main/partialRequestsEnabled") {
            data.insert(String::from("episodeRequestsEnabled"), partial.clone());
        }
        let ratings = match ratings_for(ctx, &data, "tv", tmdb_id).await {
            Ok(ratings) => ratings,
            Err(Fail::Forward(why)) => return Outcome::forward(why),
            Err(Fail::Error(e)) => {
                tracing::debug!("ratings for show {id} failed: {e:#}");
                return ctx.error(500, "Unable to retrieve series.");
            }
        };
        data.insert(String::from("ratings"), ratings.unwrap_or(Value::Null));
        if !truthy(data.get("overview")) {
            // `metadataProvider.getTvShow({ tvId })` in the main locale.
            let english = if tvdb {
                let show_id = id;
                match tvdbshow::tv_show(ctx.state, show_id, &main_locale).await {
                    Ok(show) => show,
                    Err(e) => {
                        tracing::debug!("TVDB show {id} failed: {e}");
                        return ctx.error(500, "Unable to retrieve series.");
                    }
                }
            } else {
                probe
            };
            data.insert(
                String::from("overview"),
                english.get("overview").cloned().unwrap_or(Value::Null),
            );
        }
        ctx.json(&Value::Object(data))
    })
}

/// `GET /tv/{id}/recommendations`.
pub(super) fn recommendations<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(tv_list(
        ctx,
        "recommendations",
        "Unable to retrieve series recommendations.",
    ))
}

/// `GET /tv/{id}/similar`.
pub(super) fn similar<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(tv_list(
        ctx,
        "similar",
        "Unable to retrieve similar series.",
    ))
}

async fn tv_list(ctx: &Ready<'_>, kind: &str, failure: &str) -> Outcome {
    let user = match ctx.authenticated(0) {
        Ok(user) => user,
        Err(why) => return Outcome::forward(why),
    };
    let (page, language) = match super::movie::page_language_of(ctx) {
        Ok(query) => query,
        Err(why) => return Outcome::forward(why),
    };
    let id = match super::movie::path_number(ctx, 1) {
        Ok(id) => id,
        Err(why) => return Outcome::forward(why),
    };
    let (_, language) = languages(ctx, user.locale.as_deref(), language.as_deref());
    let data = match ctx
        .state
        .tmdb
        .title_list("tv", id, kind, page, &language)
        .await
    {
        Ok(data) => data,
        Err(e) => {
            tracing::debug!("TMDB {kind} for show {id} failed: {e:#}");
            return ctx.error(500, failure);
        }
    };
    let results: Vec<Value> = data
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let related = match RelatedTitles::load(ctx, &results, "tv", Some(user.id)).await {
        Ok(related) => related,
        Err(why) => return Outcome::forward(why),
    };
    let mut out = Map::new();
    for (key, source) in [
        ("page", "page"),
        ("totalPages", "total_pages"),
        ("totalResults", "total_results"),
    ] {
        if let Some(value) = data.get(source) {
            out.insert(String::from(key), value.clone());
        }
    }
    let mapped: Vec<Value> = results
        .iter()
        .map(|result| map_tv_result(result, related.media_info(ctx, result, "tv")))
        .collect();
    let Ok(mapped) = enrich_results_with_ratings(ctx, mapped, None, false).await else {
        return ctx.error(500, failure);
    };
    out.insert(String::from("results"), Value::Array(mapped));
    ctx.json(&Value::Object(out))
}

/// `GET /tv/{id}/ratings`: Rotten Tomatoes only, in the main locale.
pub(super) fn rt_ratings<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = ctx
            .no_query()
            .and_then(|()| ctx.authenticated(0).map(|_| ()))
        {
            return Outcome::forward(why);
        }
        let id = match super::movie::path_number(ctx, 1) {
            Ok(id) => id,
            Err(why) => return Outcome::forward(why),
        };
        let (main_locale, _) = languages(ctx, None, None);
        let show = match ctx.state.tmdb.tv(id, &main_locale).await {
            Ok(show) => show,
            Err(e) => {
                tracing::debug!("TMDB show {id} failed: {e:#}");
                return ctx.error(500, "Unable to retrieve series ratings.");
            }
        };
        let first_air = show
            .get("first_air_date")
            .and_then(Value::as_str)
            .filter(|d| !d.is_empty());
        let year = match first_air {
            None => None,
            Some(date) => match date.get(..4).and_then(|y| y.parse::<i64>().ok()) {
                Some(year) => Some(year),
                None => {
                    return Outcome::forward(String::from(
                        "the air date doesn't start with a year; Number() gives NaN",
                    ))
                }
            },
        };
        let name = show.get("name").and_then(Value::as_str).unwrap_or("");
        match ctx
            .state
            .ratings
            .rt_tv(&ctx.settings, name, year.filter(|y| *y != 0))
            .await
        {
            Ok(Some(ratings)) => ctx.json(&ratings),
            Ok(None) => ctx.error(404, "Rotten Tomatoes ratings not found."),
            Err(e) => {
                tracing::debug!("RT ratings for show {id} failed: {e:#}");
                ctx.error(500, "Unable to retrieve series ratings.")
            }
        }
    })
}

/// `GET /tv/{id}/season/{n}`: `mapSeasonWithEpisodes` of the metadata
/// provider's season (TMDB's, or TVDB's episodes).
pub(super) fn season<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user = match ctx.require(0) {
            Ok(user) => user,
            Err(answer) => return *answer,
        };
        let language = match super::movie::language_of(ctx) {
            Ok(language) => language,
            Err(why) => return Outcome::forward(why),
        };
        let (id, season_number) = match (
            super::movie::path_number(ctx, 2),
            super::movie::path_number(ctx, 0),
        ) {
            (Ok(id), Ok(season)) => (id, season),
            (Err(why), _) | (_, Err(why)) => return Outcome::forward(why),
        };
        let (main_locale, language) = languages(ctx, user.locale.as_deref(), language.as_deref());
        let probe = match ctx.state.tmdb.tv(id, &main_locale).await {
            Ok(show) => show,
            Err(e) => {
                tracing::debug!("TMDB show {id} failed: {e:#}");
                return ctx.error(500, "Unable to retrieve season.");
            }
        };
        let tvdb = tvdbshow::provider_is_tvdb(ctx.state, &ctx.settings, is_anime(&probe)).await;
        let from_tvdb = if tvdb {
            match tvdbshow::tv_season(ctx.state, id, season_number, &language).await {
                Ok(season) => season,
                Err(e) => {
                    tracing::debug!("TVDB season {season_number} of {id} failed: {e}");
                    return ctx.error(500, "Unable to retrieve season.");
                }
            }
        } else {
            None
        };
        let fetched = match from_tvdb {
            Some(season) => Ok(season),
            None => ctx.state.tmdb.tv_season(id, season_number, &language).await,
        };
        let season = match fetched {
            Ok(season) => season,
            Err(e) => {
                tracing::debug!("TMDB season {season_number} of {id} failed: {e:#}");
                return ctx.error(500, "Unable to retrieve season.");
            }
        };
        let Some(episodes) = season.get("episodes").and_then(Value::as_array) else {
            return ctx.error(500, "Unable to retrieve season.");
        };
        let Some(external_ids) = season.get("external_ids") else {
            return ctx.error(500, "Unable to retrieve season.");
        };
        let mut out = Map::new();
        if let Some(air_date) = season.get("air_date") {
            out.insert(String::from("airDate"), air_date.clone());
        }
        out.insert(
            String::from("episodes"),
            Value::Array(episodes.iter().map(map_episode).collect()),
        );
        out.insert(String::from("externalIds"), map_external_ids(external_ids));
        for (key, source) in [
            ("id", "id"),
            ("name", "name"),
            ("overview", "overview"),
            ("seasonNumber", "season_number"),
            ("posterPath", "poster_path"),
        ] {
            if let Some(value) = season.get(source) {
                out.insert(String::from(key), value.clone());
            }
        }
        ctx.json(&Value::Object(out))
    })
}

/// `isAnimeMedia` over TMDB's show details.
pub fn is_anime(show: &Value) -> bool {
    let keywords: Vec<&Value> = match show.get("keywords") {
        Some(Value::Array(items)) => items.iter().collect(),
        Some(Value::Object(map)) => map
            .get("keywords")
            .or_else(|| map.get("results"))
            .and_then(Value::as_array)
            .map(|items| items.iter().collect())
            .unwrap_or_default(),
        Some(Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)) | None => {
            Vec::new()
        }
    };
    if keywords
        .iter()
        .any(|k| k.get("id").and_then(Value::as_i64) == Some(ANIME_KEYWORD_ID))
    {
        return true;
    }
    if keywords.iter().any(|k| {
        let name = crate::media::js_string(k.get("name").or(Some(&Value::Null)));
        let name = if k.get("name").is_none() {
            String::new()
        } else {
            name.into_owned()
        };
        matches!(
            name.trim().to_lowercase().as_str(),
            "anime" | "japanese animation"
        )
    }) {
        return true;
    }
    let animated = show
        .get("genres")
        .and_then(Value::as_array)
        .is_some_and(|genres| {
            genres.iter().any(|g| {
                g.as_i64() == Some(ANIMATION_GENRE_ID)
                    || g.get("id").and_then(Value::as_i64) == Some(ANIMATION_GENRE_ID)
            })
        });
    if !animated {
        return false;
    }
    let language = show
        .get("original_language")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if language == "ja" {
        return true;
    }
    let mut codes: Vec<String> = show
        .get("origin_country")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|c| truthy(Some(c)))
                .map(|c| crate::media::js_string(Some(c)).trim().to_uppercase())
                .collect()
        })
        .unwrap_or_default();
    if let Some(countries) = show.get("production_countries").and_then(Value::as_array) {
        codes.extend(countries.iter().filter_map(|c| {
            c.get("iso_3166_1")
                .filter(|code| truthy(Some(code)))
                .map(|code| crate::media::js_string(Some(code)).trim().to_uppercase())
        }));
    }
    codes.iter().any(|c| c == "JP")
}

/// `mapTvDetails`, in its key order.
fn map_tv_details(
    show: &Value,
    media_info: Option<Value>,
    on_watchlist: bool,
) -> Result<Map<String, Value>, String> {
    let mut out = Map::new();
    let copy = |out: &mut Map<String, Value>, key: &str, source: &str| {
        if let Some(value) = show.get(source) {
            out.insert(key.to_owned(), value.clone());
        }
    };
    let list = |source: &str| -> Result<&Vec<Value>, String> {
        show.get(source)
            .and_then(Value::as_array)
            .ok_or_else(|| format!("{source} is not a list"))
    };
    map_tv_head(show, &mut out)?;
    copy(&mut out, "numberOfEpisodes", "number_of_episodes");
    copy(&mut out, "numberOfSeasons", "number_of_seasons");
    copy(&mut out, "originCountry", "origin_country");
    copy(&mut out, "originalLanguage", "original_language");
    copy(&mut out, "originalName", "original_name");
    copy(&mut out, "tagline", "tagline");
    copy(&mut out, "overview", "overview");
    copy(&mut out, "popularity", "popularity");
    out.insert(
        String::from("productionCompanies"),
        Value::Array(
            list("production_companies")?
                .iter()
                .map(|c| {
                    picked(
                        c,
                        &[
                            ("id", "id"),
                            ("name", "name"),
                            ("originCountry", "origin_country"),
                            ("logoPath", "logo_path"),
                        ],
                    )
                })
                .collect(),
        ),
    );
    copy(&mut out, "productionCountries", "production_countries");
    copy(&mut out, "contentRatings", "content_ratings");
    out.insert(
        String::from("spokenLanguages"),
        Value::Array(
            list("spoken_languages")?
                .iter()
                .map(|l| {
                    picked(
                        l,
                        &[
                            ("englishName", "english_name"),
                            ("iso_639_1", "iso_639_1"),
                            ("name", "name"),
                        ],
                    )
                })
                .collect(),
        ),
    );
    out.insert(
        String::from("seasons"),
        Value::Array(list("seasons")?.iter().map(map_season).collect()),
    );
    map_tv_tail(show, media_info, &mut out)?;
    out.insert(String::from("onUserWatchlist"), Value::Bool(on_watchlist));
    Ok(out)
}

/// The first part of `mapTvDetails`: creators through networks.
fn map_tv_head(show: &Value, out: &mut Map<String, Value>) -> Result<(), String> {
    let copy = |out: &mut Map<String, Value>, key: &str, source: &str| {
        if let Some(value) = show.get(source) {
            out.insert(key.to_owned(), value.clone());
        }
    };
    let list = |source: &str| -> Result<&Vec<Value>, String> {
        show.get(source)
            .and_then(Value::as_array)
            .ok_or_else(|| format!("{source} is not a list"))
    };
    copy(out, "createdBy", "created_by");
    copy(out, "episodeRunTime", "episode_run_time");
    copy(out, "firstAirDate", "first_air_date");
    out.insert(
        String::from("genres"),
        Value::Array(
            list("genres")?
                .iter()
                .map(|g| picked(g, &[("id", "id"), ("name", "name")]))
                .collect(),
        ),
    );
    if let Some(videos) = map_videos(show.get("videos")) {
        out.insert(String::from("relatedVideos"), videos);
    }
    copy(out, "homepage", "homepage");
    copy(out, "id", "id");
    copy(out, "inProduction", "in_production");
    copy(out, "languages", "languages");
    copy(out, "lastAirDate", "last_air_date");
    copy(out, "name", "name");
    out.insert(
        String::from("networks"),
        Value::Array(
            list("networks")?
                .iter()
                .map(|n| {
                    picked(
                        n,
                        &[
                            ("id", "id"),
                            ("name", "name"),
                            ("originCountry", "origin_country"),
                            ("headquarters", "headquarters"),
                            ("homepage", "homepage"),
                            ("logoPath", "logo_path"),
                        ],
                    )
                })
                .collect(),
        ),
    );
    Ok(())
}

/// The second half of `mapTvDetails`: status, the episodes to air, credits,
/// external ids, keywords, media info and watch providers.
fn map_tv_tail(
    show: &Value,
    media_info: Option<Value>,
    out: &mut Map<String, Value>,
) -> Result<(), String> {
    let copy = |out: &mut Map<String, Value>, key: &str, source: &str| {
        if let Some(value) = show.get(source) {
            out.insert(key.to_owned(), value.clone());
        }
    };
    copy(out, "status", "status");
    copy(out, "type", "type");
    copy(out, "voteAverage", "vote_average");
    copy(out, "voteCount", "vote_count");
    copy(out, "backdropPath", "backdrop_path");
    if let Some(episode) = show.get("last_episode_to_air").filter(|e| truthy(Some(e))) {
        out.insert(String::from("lastEpisodeToAir"), map_episode(episode));
    }
    if let Some(episode) = show.get("next_episode_to_air").filter(|e| truthy(Some(e))) {
        out.insert(String::from("nextEpisodeToAir"), map_episode(episode));
    }
    copy(out, "posterPath", "poster_path");
    let cast = show
        .pointer("/aggregate_credits/cast")
        .and_then(Value::as_array)
        .ok_or("aggregate_credits.cast is not a list")?;
    let crew = show
        .pointer("/credits/crew")
        .and_then(Value::as_array)
        .ok_or("credits.crew is not a list")?;
    let mut credits = Map::new();
    credits.insert(
        String::from("cast"),
        Value::Array(
            cast.iter()
                .map(map_cast_aggregate)
                .collect::<Result<Vec<_>, _>>()?,
        ),
    );
    credits.insert(
        String::from("crew"),
        Value::Array(crew.iter().map(map_crew).collect()),
    );
    out.insert(String::from("credits"), Value::Object(credits));
    let external_ids = show.get("external_ids").ok_or("external_ids is missing")?;
    out.insert(String::from("externalIds"), map_external_ids(external_ids));
    let keywords = show
        .pointer("/keywords/results")
        .and_then(Value::as_array)
        .ok_or("keywords.results is not a list")?;
    out.insert(
        String::from("keywords"),
        Value::Array(
            keywords
                .iter()
                .map(|k| picked(k, &[("id", "id"), ("name", "name")]))
                .collect(),
        ),
    );
    if let Some(media_info) = media_info {
        out.insert(String::from("mediaInfo"), media_info);
    }
    out.insert(
        String::from("watchProviders"),
        map_watch_providers(show.get("watch/providers").and_then(|w| w.get("results"))),
    );
    Ok(())
}

/// `mapSeasonResult`.
fn map_season(season: &Value) -> Value {
    picked(
        season,
        &[
            ("airDate", "air_date"),
            ("episodeCount", "episode_count"),
            ("id", "id"),
            ("name", "name"),
            ("overview", "overview"),
            ("seasonNumber", "season_number"),
            ("posterPath", "poster_path"),
        ],
    )
}

/// `mapEpisodeResult`.
pub(super) fn map_episode(episode: &Value) -> Value {
    picked(
        episode,
        &[
            ("id", "id"),
            ("airDate", "air_date"),
            ("episodeNumber", "episode_number"),
            ("name", "name"),
            ("overview", "overview"),
            ("productionCode", "production_code"),
            ("seasonNumber", "season_number"),
            ("showId", "show_id"),
            ("voteAverage", "vote_average"),
            ("voteCount", "vote_count"),
            ("stillPath", "still_path"),
        ],
    )
}

/// `mapTvResult`.
pub(super) fn map_tv_result(result: &Value, media_info: Option<Value>) -> Value {
    let mut out = Map::new();
    let copy = |out: &mut Map<String, Value>, key: &str, source: &str| {
        if let Some(value) = result.get(source) {
            out.insert(key.to_owned(), value.clone());
        }
    };
    copy(&mut out, "id", "id");
    copy(&mut out, "firstAirDate", "first_air_date");
    copy(&mut out, "genreIds", "genre_ids");
    out.insert(
        String::from("mediaType"),
        match result.get("media_type") {
            Some(kind) if truthy(Some(kind)) => kind.clone(),
            _ => Value::from("tv"),
        },
    );
    for (key, source) in [
        ("name", "name"),
        ("originCountry", "origin_country"),
        ("originalLanguage", "original_language"),
        ("originalName", "original_name"),
        ("overview", "overview"),
        ("popularity", "popularity"),
        ("voteAverage", "vote_average"),
        ("voteCount", "vote_count"),
        ("backdropPath", "backdrop_path"),
        ("posterPath", "poster_path"),
    ] {
        copy(&mut out, key, source);
    }
    if let Some(media_info) = media_info {
        out.insert(String::from("mediaInfo"), media_info);
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn anime_detection() {
        assert!(
            is_anime(&json!({"keywords": {"results": [{"id": ANIME_KEYWORD_ID, "name": "x"}]}})),
            "keyword id"
        );
        assert!(
            is_anime(&json!({"keywords": {"results": [{"name": " Japanese Animation "}]}})),
            "keyword name"
        );
        assert!(
            is_anime(&json!({"genres": [{"id": 16}], "original_language": "JA"})),
            "animated and japanese"
        );
        assert!(
            is_anime(
                &json!({"genres": [16], "original_language": "en", "production_countries": [{"iso_3166_1": "jp"}]})
            ),
            "animated from japan"
        );
        assert!(
            !is_anime(
                &json!({"genres": [{"id": 16}], "original_language": "en", "origin_country": ["US"]})
            ),
            "western animation"
        );
        assert!(
            !is_anime(&json!({"original_language": "ja"})),
            "not animated"
        );
    }

    #[test]
    fn maps_results() {
        let out = map_tv_result(
            &json!({"id": 1, "name": "N", "media_type": "", "origin_country": ["US"]}),
            None,
        );
        assert_eq!(
            out,
            json!({"id": 1, "mediaType": "tv", "name": "N", "originCountry": ["US"]}),
            "an empty media_type falls back to tv"
        );
    }
}
