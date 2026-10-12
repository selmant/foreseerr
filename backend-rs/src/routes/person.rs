//! `GET /person/{id}` and `GET /person/{id}/combined_credits`.

use std::future::Future;
use std::pin::Pin;

use serde_json::{Map, Value};

use super::movie::{languages, picked, RelatedTitles};
use super::ratingsenrich::enrich_results_with_ratings;
use super::{Outcome, Ready};
use crate::settings::public::truthy;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// `GET /person/{id}`: `mapPersonDetails`.
pub(super) fn detail<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let (id, language) = match person_request(ctx, 0) {
            Ok(parsed) => parsed,
            Err(why) => return Outcome::forward(why),
        };
        let person = match ctx.state.tmdb.person(id, &language).await {
            Ok(person) => person,
            Err(e) => {
                tracing::debug!("TMDB person {id} failed: {e:#}");
                return ctx.error(500, "Unable to retrieve person.");
            }
        };
        ctx.json(&picked(
            &person,
            &[
                ("id", "id"),
                ("name", "name"),
                ("birthday", "birthday"),
                ("deathday", "deathday"),
                ("knownForDepartment", "known_for_department"),
                ("alsoKnownAs", "also_known_as"),
                ("gender", "gender"),
                ("biography", "biography"),
                ("popularity", "popularity"),
                ("placeOfBirth", "place_of_birth"),
                ("profilePath", "profile_path"),
                ("adult", "adult"),
                ("imdbId", "imdb_id"),
                ("homepage", "homepage"),
            ],
        ))
    })
}

/// `GET /person/{id}/combined_credits`: cast and crew credits with the
/// local state of each title, minus adult titles and "Thanks" credits.
pub(super) fn combined_credits<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let (id, language) = match person_request(ctx, 1) {
            Ok(parsed) => parsed,
            Err(why) => return Outcome::forward(why),
        };
        let user_id = ctx.user.as_ref().map(|u| u.id);
        let credits = match ctx.state.tmdb.person_combined_credits(id, &language).await {
            Ok(credits) => credits,
            Err(e) => {
                tracing::debug!("TMDB combined credits {id} failed: {e:#}");
                return ctx.error(500, "Unable to retrieve combined credits.");
            }
        };
        let list = |key: &str| -> Vec<Value> {
            credits
                .get(key)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        };
        let (cast, crew) = (list("cast"), list("crew"));
        let mut out_cast = Vec::with_capacity(cast.len());
        let mut out_crew = Vec::with_capacity(crew.len());
        for (source, sink, extra, skip_key, skip_value) in [
            (&cast, &mut out_cast, "character", "character", "Thanks"),
            (&crew, &mut out_crew, "job", "job", "Thanks"),
        ] {
            let typed: Vec<Value> = source
                .iter()
                .filter(|c| truthy(c.get("media_type")))
                .cloned()
                .collect();
            let mut by_type: Vec<(String, RelatedTitles)> = Vec::new();
            for media_type in ["movie", "tv"] {
                let subset: Vec<Value> = typed
                    .iter()
                    .filter(|c| c.get("media_type").and_then(Value::as_str) == Some(media_type))
                    .cloned()
                    .collect();
                match RelatedTitles::load_plain(ctx, &subset, media_type, user_id).await {
                    Ok(related) => by_type.push((media_type.to_owned(), related)),
                    Err(why) => return Outcome::forward(why),
                }
            }
            for credit in source {
                let media_type = credit.get("media_type").and_then(Value::as_str);
                let media_info = media_type.and_then(|kind| {
                    by_type
                        .iter()
                        .find(|(k, _)| k == kind)
                        .and_then(|(_, related)| related.media_info(ctx, credit, kind))
                });
                let mapped = map_credit(credit, extra, media_info);
                let adult = truthy(mapped.get("adult"));
                let skipped = mapped.get(skip_key).and_then(Value::as_str) == Some(skip_value);
                if !adult && !skipped {
                    sink.push(mapped);
                }
            }
        }
        // `enrichResultsWithRatings([...cast, ...crew])`, split again.
        let cast_len = out_cast.len();
        let mut all = out_cast;
        all.extend(out_crew);
        let Ok(mut all) = enrich_results_with_ratings(ctx, all, None, false).await else {
            return ctx.error(500, "Unable to retrieve combined credits.");
        };
        let out_crew = all.split_off(cast_len.min(all.len()));
        let out_cast = all;
        let mut out = Map::new();
        out.insert(String::from("cast"), Value::Array(out_cast));
        out.insert(String::from("crew"), Value::Array(out_crew));
        out.insert(
            String::from("id"),
            credits.get("id").cloned().unwrap_or(Value::Null),
        );
        ctx.json(&Value::Object(out))
    })
}

/// The signed-in check, the `language` query and the person id, which is
/// `depth` segments before the end of the path.
fn person_request(ctx: &Ready<'_>, depth: usize) -> Result<(i64, String), super::Fallback> {
    let user = ctx.authenticated(0)?;
    let language = super::movie::language_of(ctx)?;
    let id = super::movie::path_number(ctx, depth)?;
    let (_, language) = languages(ctx, user.locale.as_deref(), language.as_deref());
    Ok((id, language))
}

/// `mapCastCredits` / `mapCrewCredits`: the shared fields, then
/// `character` or `department` and `job`, then `mediaInfo`.
fn map_credit(credit: &Value, extra: &str, media_info: Option<Value>) -> Value {
    let mut out = Map::new();
    for (key, source) in [
        ("id", "id"),
        ("originalLanguage", "original_language"),
        ("episodeCount", "episode_count"),
        ("overview", "overview"),
        ("originCountry", "origin_country"),
        ("originalName", "original_name"),
        ("voteCount", "vote_count"),
        ("name", "name"),
        ("mediaType", "media_type"),
        ("popularity", "popularity"),
        ("creditId", "credit_id"),
        ("backdropPath", "backdrop_path"),
        ("firstAirDate", "first_air_date"),
        ("voteAverage", "vote_average"),
        ("genreIds", "genre_ids"),
        ("posterPath", "poster_path"),
        ("originalTitle", "original_title"),
        ("video", "video"),
        ("title", "title"),
        ("adult", "adult"),
        ("releaseDate", "release_date"),
    ] {
        if let Some(value) = credit.get(source) {
            out.insert(String::from(key), value.clone());
        }
    }
    if extra == "character" {
        if let Some(value) = credit.get("character") {
            out.insert(String::from("character"), value.clone());
        }
    } else {
        for key in ["department", "job"] {
            if let Some(value) = credit.get(key) {
                out.insert(String::from(key), value.clone());
            }
        }
    }
    if let Some(media_info) = media_info {
        out.insert(String::from("mediaInfo"), media_info);
    }
    Value::Object(out)
}
