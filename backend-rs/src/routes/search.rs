//! `GET /search`, `GET /search/keyword` and `GET /search/company`.

use std::future::Future;
use std::pin::Pin;

use serde_json::{Map, Value};

use super::blocklist::plain_integer;
use super::movie::{languages, map_movie_result, RelatedTitles};
use super::ratingsenrich::enrich_results_with_ratings;
use super::tv::map_tv_result;
use super::{Outcome, Ready};
use crate::settings::public::truthy;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// `GET /search`: TMDB's multi search with the local state of each title,
/// or one of the `tmdb:`, `imdb:`, `tvdb:` and `year:` providers.
pub(super) fn multi<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user = match ctx.authenticated(0) {
            Ok(user) => user,
            Err(why) => return Outcome::forward(why),
        };
        let (query, page, language) = match query_of(ctx, true) {
            Ok(parsed) => parsed,
            Err(why) => return Outcome::forward(why),
        };
        let (main_locale, language) = languages(ctx, user.locale.as_deref(), language.as_deref());
        let data = match search_provider(&query.to_lowercase()) {
            Some((provider, id)) => {
                let found = provider_search(ctx, provider, &id, (&query, &language, &main_locale));
                let Ok(data) = found.await else {
                    return ctx.error(500, "Unable to retrieve search results.");
                };
                data
            }
            None => ctx.state.tmdb.search_multi(&query, page, &language).await,
        };
        let results: Vec<Value> = data
            .get("results")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let of_type = |kind: &str| -> Vec<Value> {
            results
                .iter()
                .filter(|r| r.get("media_type").and_then(Value::as_str) == Some(kind))
                .cloned()
                .collect()
        };
        let movies =
            match RelatedTitles::load_plain(ctx, &of_type("movie"), "movie", Some(user.id)).await {
                Ok(related) => related,
                Err(why) => return Outcome::forward(why),
            };
        let shows = match RelatedTitles::load_plain(ctx, &of_type("tv"), "tv", Some(user.id)).await
        {
            Ok(related) => related,
            Err(why) => return Outcome::forward(why),
        };
        let mut mapped = Vec::with_capacity(results.len());
        for result in &results {
            let item = match result.get("media_type").and_then(Value::as_str) {
                Some("movie") => map_movie_result(result, movies.media_info(ctx, result, "movie")),
                Some("tv") => map_tv_result(result, shows.media_info(ctx, result, "tv")),
                Some("collection") => map_collection_result(result),
                _ => {
                    let Some(person) = map_person_result(result) else {
                        tracing::debug!("a person result without known_for");
                        return ctx.error(500, "Unable to retrieve search results.");
                    };
                    person
                }
            };
            mapped.push(item);
        }
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
        let Ok(mapped) = enrich_results_with_ratings(ctx, mapped, None, false).await else {
            return ctx.error(500, "Unable to retrieve search results.");
        };
        out.insert(String::from("results"), Value::Array(mapped));
        ctx.json(&Value::Object(out))
    })
}

/// `GET /search/keyword`.
pub(super) fn keyword<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(plain(
        ctx,
        "keyword",
        "Unable to retrieve keyword search results.",
    ))
}

/// `GET /search/company`.
pub(super) fn company<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(plain(
        ctx,
        "company",
        "Unable to retrieve company search results.",
    ))
}

/// TMDB's own page for a keyword or company search.
async fn plain(ctx: &Ready<'_>, kind: &str, failure: &str) -> Outcome {
    if let Err(why) = ctx.authenticated(0) {
        return Outcome::forward(why);
    }
    let (query, page, _) = match query_of(ctx, false) {
        Ok(parsed) => parsed,
        Err(why) => return Outcome::forward(why),
    };
    match ctx.state.tmdb.search_plain(kind, &query, page).await {
        Ok(data) => ctx.json(&data),
        Err(e) => {
            tracing::debug!("TMDB {kind} search failed: {e:#}");
            ctx.error(500, failure)
        }
    }
}

/// The search providers of `server/lib/search.ts`, in the order
/// `findSearchProvider` tries them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Provider {
    Tmdb,
    Imdb,
    Tvdb,
    Year,
}

/// `findSearchProvider(query)` and the id its pattern matches first
/// (`(?<=tmdb:)\d+`, `(?<=imdb:)(tt|nm)\d+`, `(?<=tvdb:)\d+`,
/// `(?<=year:)\d{4}`).
fn search_provider(query: &str) -> Option<(Provider, String)> {
    let digits_after = |prefix: &str, exact: Option<usize>| {
        query.match_indices(prefix).find_map(|(i, _)| {
            let rest = query.get(i + prefix.len()..)?;
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            match exact {
                Some(n) => (digits.len() >= n).then(|| digits.chars().take(n).collect()),
                None => (!digits.is_empty()).then_some(digits),
            }
        })
    };
    let imdb = || {
        query.match_indices("imdb:").find_map(|(i, _)| {
            let rest = query.get(i + 5..)?;
            let prefix = rest.get(..2).filter(|p| *p == "tt" || *p == "nm")?;
            let digits: String = rest
                .get(2..)?
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            (!digits.is_empty()).then(|| format!("{prefix}{digits}"))
        })
    };
    digits_after("tmdb:", None)
        .map(|id| (Provider::Tmdb, id))
        .or_else(|| imdb().map(|id| (Provider::Imdb, id)))
        .or_else(|| digits_after("tvdb:", None).map(|id| (Provider::Tvdb, id)))
        .or_else(|| digits_after("year:", Some(4)).map(|id| (Provider::Year, id)))
}

/// `{ page: 1, total_pages: 1, total_results, results }`.
fn single_page(results: Vec<Value>) -> Value {
    let mut out = Map::new();
    out.insert(String::from("page"), Value::from(1));
    out.insert(String::from("total_pages"), Value::from(1));
    out.insert(String::from("total_results"), Value::from(results.len()));
    out.insert(String::from("results"), Value::Array(results));
    Value::Object(out)
}

/// The list at `key` with `media_type` set on every item.
fn typed(data: &Value, key: &str, media_type: &str) -> Vec<Value> {
    data.get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    let mut item = item.clone();
                    if let Value::Object(map) = &mut item {
                        map.insert(String::from("media_type"), Value::from(media_type));
                    }
                    item
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Copy `keys` of `from` (those present) into a new object after
/// `id` and `media_type`.
fn result_of(from: &Value, media_type: &str, keys: &[&str]) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert(
        String::from("id"),
        from.get("id").cloned().unwrap_or(Value::Null),
    );
    out.insert(String::from("media_type"), Value::from(media_type));
    for key in keys {
        if let Some(v) = from.get(*key) {
            out.insert((*key).to_owned(), v.clone());
        }
    }
    out
}

/// `genres.map((genre) => genre.id)`.
fn genre_ids(details: &Value) -> Value {
    Value::Array(
        details
            .get("genres")
            .and_then(Value::as_array)
            .map(|g| {
                g.iter()
                    .map(|x| x.get("id").cloned().unwrap_or(Value::Null))
                    .collect()
            })
            .unwrap_or_default(),
    )
}

/// `mapMovieDetailsToResult` / `mapTvDetailsToResult` /
/// `mapPersonDetailsToResult`, picked as `isMovieDetails` (a `title`)
/// and `isTvDetails` (a `number_of_seasons`) tell them apart.
fn details_to_result(details: &Value) -> Value {
    if details.get("title").is_some() {
        let mut out = result_of(details, "movie", &["adult"]);
        out.insert(String::from("genre_ids"), genre_ids(details));
        for key in ["original_language", "original_title"] {
            if let Some(v) = details.get(key) {
                out.insert(String::from(key), v.clone());
            }
        }
        let overview = details.get("overview").filter(|v| !v.is_null()).cloned();
        out.insert(
            String::from("overview"),
            overview.unwrap_or_else(|| Value::from("")),
        );
        for key in [
            "popularity",
            "release_date",
            "title",
            "video",
            "vote_average",
            "vote_count",
            "backdrop_path",
            "poster_path",
        ] {
            if let Some(v) = details.get(key) {
                out.insert(String::from(key), v.clone());
            }
        }
        return Value::Object(out);
    }
    if details.get("number_of_seasons").is_some() {
        let mut out = result_of(details, "tv", &["first_air_date"]);
        out.insert(String::from("genre_ids"), genre_ids(details));
        for key in [
            "name",
            "origin_country",
            "original_language",
            "original_name",
            "overview",
            "popularity",
            "vote_average",
            "vote_count",
            "backdrop_path",
            "poster_path",
        ] {
            if let Some(v) = details.get(key) {
                out.insert(String::from(key), v.clone());
            }
        }
        return Value::Object(out);
    }
    let mut out = result_of(
        details,
        "person",
        &["name", "popularity", "adult", "profile_path"],
    );
    out.insert(String::from("known_for"), Value::Array(Vec::new()));
    Value::Object(out)
}

/// `searchProvider.search({ id, language, query })`; `Err` where it
/// rejects (a failed `getByExternalId`).
async fn provider_search(
    ctx: &Ready<'_>,
    provider: Provider,
    id: &str,
    (query, language, main_locale): (&str, &str, &str),
) -> Result<Value, ()> {
    let tmdb = &ctx.state.tmdb;
    match provider {
        Provider::Tmdb => {
            let n = crate::jsval::parse_int(id, Some(10));
            let (movie, tv, person) = tokio::join!(
                tmdb.movie(n, language),
                tmdb.tv(n, language),
                tmdb.person(n, language)
            );
            let results = <[_; 3]>::from((movie, tv, person))
                .into_iter()
                .filter_map(Result::ok)
                .map(|details| details_to_result(&details))
                .collect();
            Ok(single_page(results))
        }
        Provider::Imdb | Provider::Tvdb => {
            let (external, source) = if provider == Provider::Imdb {
                (id.to_owned(), "imdb_id")
            } else {
                (
                    crate::jsval::number_string(crate::jsval::parse_int(id, Some(10))),
                    "tvdb_id",
                )
            };
            let params = [
                ("external_source", String::from(source)),
                ("language", language.to_owned()),
            ];
            let found = tmdb
                .raw(&format!("/find/{external}"), &params, 300)
                .await
                .map_err(|e| {
                    tracing::debug!("[TMDB] Failed to find by external ID: {e:#}");
                })?;
            let mut results = typed(&found, "movie_results", "movie");
            results.extend(typed(&found, "tv_results", "tv"));
            results.extend(typed(&found, "person_results", "person"));
            Ok(single_page(results))
        }
        Provider::Year => {
            // `query.replace(/year:\d{4}/, '')` on the text as typed.
            let stripped = strip_year(query);
            let year = crate::jsval::number_string(crate::jsval::parse_int(id, Some(10)));
            let search = |path: &'static str, year_key: &'static str| {
                let params = vec![
                    ("query", stripped.clone()),
                    ("page", String::from("1")),
                    ("include_adult", String::from("false")),
                    ("language", main_locale.to_owned()),
                    (year_key, year.clone()),
                ];
                async move { tmdb.raw(path, &params, 300).await.unwrap_or(Value::Null) }
            };
            let (movies, shows) = tokio::join!(
                search("/search/movie", "primary_release_year"),
                search("/search/tv", "first_air_date_year")
            );
            let mut results = Vec::new();
            for data in [&movies, &shows] {
                for item in data
                    .get("results")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let kind = if item.get("title").is_some() {
                        "movie"
                    } else {
                        "tv"
                    };
                    let mut item = item.clone();
                    if let Value::Object(map) = &mut item {
                        map.insert(String::from("media_type"), Value::from(kind));
                    }
                    results.push(item);
                }
            }
            Ok(single_page(results))
        }
    }
}

/// The first `year:` followed by four digits removed.
fn strip_year(query: &str) -> String {
    for (i, _) in query.match_indices("year:") {
        let digits = query.get(i + 5..i + 9);
        if digits.is_some_and(|d| d.bytes().all(|b| b.is_ascii_digit())) {
            return format!(
                "{}{}",
                query.get(..i).unwrap_or(""),
                query.get(i + 9..).unwrap_or("")
            );
        }
    }
    query.to_owned()
}

/// `req.query.query`, `Number(req.query.page)` and `req.query.language`
/// from what the validator left, or [`parse_query`] when it didn't run.
fn query_of(
    ctx: &Ready<'_>,
    with_language: bool,
) -> Result<(String, i64, Option<String>), super::Fallback> {
    let Some(q) = super::params::query(ctx) else {
        return Ok(parse_query(
            ctx.req.uri.query().unwrap_or(""),
            with_language,
        )?);
    };
    let text = |key: &str| q.get(key).and_then(Value::as_str).map(str::to_owned);
    let query = text("query").ok_or_else(|| String::from("query isn't text"))?;
    let language = if with_language {
        text("language")
    } else {
        None
    };
    let page = super::params::int(q.get("page"), "page")?.unwrap_or(1);
    Ok((query, page, language))
}

/// `query` (required, non-empty), `page` (the validator's default is 1)
/// and, when `with_language`, `language`.
fn parse_query(raw: &str, with_language: bool) -> Result<(String, i64, Option<String>), String> {
    let (mut query, mut page, mut language) = (None, 1, None);
    let mut seen: Vec<&str> = Vec::new();
    let forward = |why: &str| Err(why.to_owned());
    for pair in raw.split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if seen.contains(&key) {
            return forward("a repeated query key");
        }
        seen.push(key);
        let Some(value) = super::user::decode_query_value(value) else {
            return forward("a reserved or malformed character in a query value");
        };
        match key {
            "query" => {
                if value.is_empty() {
                    return forward("an empty query; the validator answers 400");
                }
                query = Some(value);
            }
            "page" => match plain_integer(&value) {
                Some(n) => page = n,
                None => return forward("page must be a non-negative integer"),
            },
            "language" if with_language => {
                if value.is_empty() {
                    return forward("an empty language; the validator answers 400");
                }
                language = Some(value);
            }
            _ => return forward("an unknown query key"),
        }
    }
    let Some(query) = query else {
        return forward("query is required");
    };
    Ok((query, page, language))
}

/// `mapCollectionResult`.
pub(super) fn map_collection_result(result: &Value) -> Value {
    let mut out = Map::new();
    if let Some(id) = result.get("id") {
        out.insert(String::from("id"), id.clone());
    }
    out.insert(
        String::from("mediaType"),
        match result.get("media_type") {
            Some(kind) if truthy(Some(kind)) => kind.clone(),
            _ => Value::from("collection"),
        },
    );
    for (key, source) in [
        ("adult", "adult"),
        ("originalLanguage", "original_language"),
        ("originalTitle", "original_title"),
        ("title", "title"),
        ("overview", "overview"),
        ("backdropPath", "backdrop_path"),
        ("posterPath", "poster_path"),
    ] {
        if let Some(value) = result.get(source) {
            out.insert(String::from(key), value.clone());
        }
    }
    Value::Object(out)
}

/// `mapPersonResult`; `None` when `known_for` isn't a list, which makes
/// Node throw.
pub(super) fn map_person_result(result: &Value) -> Option<Value> {
    let known_for = result.get("known_for").and_then(Value::as_array)?;
    let mut out = Map::new();
    for (key, source) in [
        ("id", "id"),
        ("name", "name"),
        ("popularity", "popularity"),
        ("adult", "adult"),
        ("mediaType", "media_type"),
        ("profilePath", "profile_path"),
    ] {
        if let Some(value) = result.get(source) {
            out.insert(String::from(key), value.clone());
        }
    }
    out.insert(
        String::from("knownFor"),
        Value::Array(
            known_for
                .iter()
                .map(|item| {
                    if item.get("media_type").and_then(Value::as_str) == Some("movie") {
                        map_movie_result(item, None)
                    } else {
                        map_tv_result(item, None)
                    }
                })
                .collect(),
        ),
    );
    Some(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_detection() {
        for q in [
            "tmdb:550",
            "find imdb:tt0137523",
            "tvdb:12",
            "x year:1999",
            "imdb:nm0000093",
        ] {
            assert!(search_provider(q).is_some(), "{q} is a provider search");
        }
        for q in [
            "fight club",
            "tmdb:",
            "year:99",
            "imdb:x1",
            "the tmdb: story",
        ] {
            assert!(search_provider(q).is_none(), "{q} is a plain search");
        }
    }

    #[test]
    fn query_parsing() {
        assert_eq!(
            parse_query("query=fight%20club&page=2&language=de", true).ok(),
            Some((String::from("fight club"), 2, Some(String::from("de")))),
            "all three"
        );
        assert!(parse_query("page=1", true).is_err(), "query required");
        assert!(parse_query("query=", true).is_err(), "empty query");
        assert!(
            parse_query("query=x&language=de", false).is_err(),
            "no language here"
        );
    }
}
