//! `GET /movie/{id}`: TMDB's movie details with the local media state,
//! the user's watchlist flag and ratings.

use std::future::Future;
use std::pin::Pin;

use serde_json::{Map, Value};

use super::blocklist::plain_integer;
use super::ratingsenrich::enrich_results_with_ratings;
use super::related::Related;
use super::{issue, request, Outcome, Ready};
use crate::db::{IssueRow, MediaRow, RelatedMedia, RequestRow, WatchlistRow};
use crate::ratings::Title;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// `GET /movie/{id}`.
pub(super) fn detail<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user = match ctx.authenticated(0) {
            Ok(user) => user,
            Err(why) => return Outcome::forward(why),
        };
        let language = match language_of(ctx) {
            Ok(language) => language,
            Err(why) => return Outcome::forward(why),
        };
        let id = match path_number(ctx, 0) {
            Ok(id) => id,
            Err(why) => return Outcome::forward(why),
        };
        let (main_locale, language) = languages(ctx, user.locale.as_deref(), language.as_deref());
        let movie = match ctx.state.tmdb.movie(id, &language).await {
            Ok(movie) => movie,
            Err(e) => {
                tracing::debug!("TMDB movie {id} failed: {e:#}");
                return ctx.error(500, "Unable to retrieve movie.");
            }
        };
        let tmdb_id = movie.get("id").and_then(Value::as_i64).unwrap_or(id);
        // `Media.getMedia` logs and returns undefined on a database error.
        let media = ctx
            .state
            .db
            .media_by_tmdb(tmdb_id, "movie")
            .await
            .ok()
            .flatten();
        let on_watchlist = match on_watchlist(ctx, id, "movie", user.id).await {
            Ok(exists) => exists,
            Err(e) => {
                tracing::debug!("watchlist lookup failed: {e}");
                return ctx.error(500, "Unable to retrieve movie.");
            }
        };
        let media_info = match &media {
            Some(media) => match media_info_json(ctx, media).await {
                Ok(json) => Some(json),
                Err(why) => return Outcome::forward(why),
            },
            None => None,
        };
        let mut data = match map_movie_details(&movie, media_info, on_watchlist) {
            Ok(data) => data,
            Err(why) => {
                tracing::debug!("mapping movie {id} failed: {why}");
                return ctx.error(500, "Unable to retrieve movie.");
            }
        };
        let ratings = match ratings_for(ctx, &data, "movie", tmdb_id).await {
            Ok(ratings) => ratings,
            Err(Fail::Forward(why)) => return Outcome::forward(why),
            Err(Fail::Error(e)) => {
                tracing::debug!("ratings for movie {id} failed: {e:#}");
                return ctx.error(500, "Unable to retrieve movie.");
            }
        };
        data.insert(String::from("ratings"), ratings.unwrap_or(Value::Null));
        if !crate::settings::public::truthy(data.get("overview")) {
            match ctx.state.tmdb.movie(id, &main_locale).await {
                Ok(fallback) => {
                    data.insert(
                        String::from("overview"),
                        fallback.get("overview").cloned().unwrap_or(Value::Null),
                    );
                }
                Err(e) => {
                    tracing::debug!("TMDB overview fallback for {id} failed: {e:#}");
                    return ctx.error(500, "Unable to retrieve movie.");
                }
            }
        }
        ctx.json(&Value::Object(data))
    })
}

/// `GET /movie/{id}/recommendations`.
pub(super) fn recommendations<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(movie_list(
        ctx,
        "recommendations",
        "Unable to retrieve movie recommendations.",
    ))
}

/// `GET /movie/{id}/similar`.
pub(super) fn similar<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(movie_list(
        ctx,
        "similar",
        "Unable to retrieve similar movies.",
    ))
}

/// One page of a movie's TMDB list with the local state of each title.
async fn movie_list(ctx: &Ready<'_>, kind: &str, failure: &str) -> Outcome {
    let user = match ctx.authenticated(0) {
        Ok(user) => user,
        Err(why) => return Outcome::forward(why),
    };
    let (page, language) = match page_language_of(ctx) {
        Ok(query) => query,
        Err(why) => return Outcome::forward(why),
    };
    let id = match path_number(ctx, 1) {
        Ok(id) => id,
        Err(why) => return Outcome::forward(why),
    };
    let (_, language) = languages(ctx, user.locale.as_deref(), language.as_deref());
    let data = match ctx
        .state
        .tmdb
        .title_list("movie", id, kind, page, &language)
        .await
    {
        Ok(data) => data,
        Err(e) => {
            tracing::debug!("TMDB {kind} for movie {id} failed: {e:#}");
            return ctx.error(500, failure);
        }
    };
    let results: Vec<Value> = data
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let related = match RelatedTitles::load(ctx, &results, "movie", Some(user.id)).await {
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
        .map(|result| map_movie_result(result, related.media_info(ctx, result, "movie")))
        .collect();
    let Ok(mapped) = enrich_results_with_ratings(ctx, mapped, None, false).await else {
        return ctx.error(500, failure);
    };
    out.insert(String::from("results"), Value::Array(mapped));
    ctx.json(&Value::Object(out))
}

/// `GET /movie/{id}/ratings`: Rotten Tomatoes only, in the main locale.
pub(super) fn rt_ratings<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = ctx
            .no_query()
            .and_then(|()| ctx.authenticated(0).map(|_| ()))
        {
            return Outcome::forward(why);
        }
        let id = match path_number(ctx, 1) {
            Ok(id) => id,
            Err(why) => return Outcome::forward(why),
        };
        let (main_locale, _) = languages(ctx, None, None);
        let movie = match ctx.state.tmdb.movie(id, &main_locale).await {
            Ok(movie) => movie,
            Err(e) => {
                tracing::debug!("TMDB movie {id} failed: {e:#}");
                return ctx.error(500, "Unable to retrieve movie ratings.");
            }
        };
        let Some(release_date) = movie.get("release_date").and_then(Value::as_str) else {
            return ctx.error(500, "Unable to retrieve movie ratings.");
        };
        let year = release_date.get(..4).map_or(Some(0), |y| {
            if y.is_empty() {
                Some(0)
            } else {
                y.parse::<i64>().ok()
            }
        });
        let Some(year) = year else {
            return Outcome::forward(String::from(
                "the release date doesn't start with a year; Number() gives NaN",
            ));
        };
        let title = movie.get("title").and_then(Value::as_str).unwrap_or("");
        match ctx.state.ratings.rt_movie(&ctx.settings, title, year).await {
            Ok(Some(ratings)) => ctx.json(&ratings),
            Ok(None) => ctx.error(404, "Rotten Tomatoes ratings not found."),
            Err(e) => {
                tracing::debug!("RT ratings for movie {id} failed: {e:#}");
                ctx.error(500, "Unable to retrieve movie ratings.")
            }
        }
    })
}

/// `page` (the validator's default is 1) and `language`.
pub(super) fn page_query(raw: &str) -> Result<(i64, Option<String>), String> {
    let (mut page, mut language) = (1, None);
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
            "page" => match plain_integer(&value) {
                Some(n) => page = n,
                None => return forward("page must be a non-negative integer"),
            },
            "language" => {
                if value.is_empty() {
                    return forward("an empty language; the validator answers 400");
                }
                language = Some(value);
            }
            _ => return forward("an unknown query key"),
        }
    }
    Ok((page, language))
}

/// `Media.getRelatedMedia` for a page of results: the matching media rows
/// with the user's watchlist entries and, when `main.hideRequested` is on,
/// whether an active request exists.
pub(super) struct RelatedTitles {
    rows: Vec<RelatedMedia>,
    active: Option<Vec<i64>>,
    related: Related,
}

impl RelatedTitles {
    /// `getRelatedMedia` without `includeActiveRequest`.
    pub(super) async fn load_plain(
        ctx: &Ready<'_>,
        results: &[Value],
        media_type: &str,
        user_id: Option<i64>,
    ) -> Result<Self, String> {
        let mut loaded = Self::load(ctx, results, media_type, user_id).await?;
        loaded.active = None;
        Ok(loaded)
    }

    /// `getRelatedMedia` with `includeActiveRequest`.
    pub(super) async fn load(
        ctx: &Ready<'_>,
        results: &[Value],
        media_type: &str,
        user_id: Option<i64>,
    ) -> Result<Self, String> {
        let mut tmdb_ids: Vec<i64> = results
            .iter()
            .filter_map(|r| r.get("id").and_then(Value::as_i64))
            .collect();
        tmdb_ids.sort_unstable();
        tmdb_ids.dedup();
        // `getRelatedMedia` logs and returns [] on a database error.
        let rows = ctx
            .state
            .db
            .related_media(&tmdb_ids, media_type, user_id)
            .await
            .unwrap_or_default();
        let media_ids: Vec<i64> = rows.iter().map(|r| r.media.id).collect();
        let active = if crate::settings::public::truthy(ctx.settings.get("/main/hideRequested"))
            && !rows.is_empty()
        {
            Some(
                ctx.state
                    .db
                    .media_with_active_requests(&media_ids)
                    .await
                    .unwrap_or_default(),
            )
        } else {
            None
        };
        let related = Related::load(ctx, &media_ids, &[], false).await?;
        Ok(Self {
            rows,
            active,
            related,
        })
    }

    /// The `mediaInfo` of one result, if a media row matches its id.
    pub(super) fn media_info(
        &self,
        ctx: &Ready<'_>,
        result: &Value,
        media_type: &str,
    ) -> Option<Value> {
        self.media_info_of(ctx, result, media_type, false)
    }

    /// Like `media_info`, but the last matching row wins, as in the
    /// `Map` that `getRelatedMediaIndex` builds.
    pub(super) fn media_info_last(
        &self,
        ctx: &Ready<'_>,
        result: &Value,
        media_type: &str,
    ) -> Option<Value> {
        self.media_info_of(ctx, result, media_type, true)
    }

    fn media_info_of(
        &self,
        ctx: &Ready<'_>,
        result: &Value,
        media_type: &str,
        last: bool,
    ) -> Option<Value> {
        let id = result.get("id").and_then(Value::as_i64)?;
        let matches = |r: &&RelatedMedia| r.media.tmdb_id == id && r.media.media_type == media_type;
        let row = if last {
            self.rows.iter().rev().find(matches)?
        } else {
            self.rows.iter().find(matches)?
        };
        let Value::Object(media) =
            crate::media::media_json(&row.media, &ctx.settings, self.related.downloads(), false)
        else {
            return None;
        };
        let mut out = Map::with_capacity(media.len() + 2);
        for (key, value) in media {
            if key == "downloadStatus" {
                if let Some(active) = &self.active {
                    out.insert(
                        String::from("hasActiveRequest"),
                        Value::Bool(active.contains(&row.media.id)),
                    );
                }
            }
            out.insert(key, value);
        }
        out.insert(
            String::from("watchlists"),
            Value::Array(row.watchlists.iter().map(watchlist_json).collect()),
        );
        Some(Value::Object(out))
    }
}

/// A `Watchlist` row as its entity prints: the initialised fields first.
fn watchlist_json(w: &WatchlistRow) -> Value {
    let text = |v: &Option<String>| v.as_deref().map_or(Value::Null, Value::from);
    let mut out = Map::new();
    out.insert(
        String::from("ratingKey"),
        Value::from(w.rating_key.as_str()),
    );
    out.insert(String::from("title"), Value::from(w.title.as_str()));
    out.insert(String::from("id"), Value::from(w.id));
    out.insert(
        String::from("mediaType"),
        Value::from(w.media_type.as_str()),
    );
    out.insert(String::from("tmdbId"), Value::from(w.tmdb_id));
    out.insert(String::from("createdAt"), text(&w.created_at));
    out.insert(String::from("updatedAt"), text(&w.updated_at));
    Value::Object(out)
}

/// `mapMovieResult`.
pub(super) fn map_movie_result(result: &Value, media_info: Option<Value>) -> Value {
    let mut out = Map::new();
    if let Some(id) = result.get("id") {
        out.insert(String::from("id"), id.clone());
    }
    out.insert(String::from("mediaType"), Value::from("movie"));
    for (key, source) in [
        ("adult", "adult"),
        ("genreIds", "genre_ids"),
        ("originalLanguage", "original_language"),
        ("originalTitle", "original_title"),
        ("overview", "overview"),
        ("popularity", "popularity"),
        ("releaseDate", "release_date"),
        ("title", "title"),
        ("video", "video"),
        ("voteAverage", "vote_average"),
        ("voteCount", "vote_count"),
        ("backdropPath", "backdrop_path"),
        ("posterPath", "poster_path"),
    ] {
        if let Some(value) = result.get(source) {
            out.insert(String::from(key), value.clone());
        }
    }
    if let Some(media_info) = media_info {
        out.insert(String::from("mediaInfo"), media_info);
    }
    Value::Object(out)
}

/// Why ratings couldn't be added: Node would answer, or Node must answer.
pub(super) enum Fail {
    /// Node's own 500.
    Error(anyhow::Error),
    /// Something this port doesn't reproduce.
    Forward(String),
}

/// `settings.main.locale` (or `en`) and the language to ask TMDB for: the
/// query's, else the user's settings locale, else the main one.
pub(super) fn languages(
    ctx: &Ready<'_>,
    user_locale: Option<&str>,
    query_language: Option<&str>,
) -> (String, String) {
    let main = ctx.settings.str("/main/locale");
    let main = if main.is_empty() { "en" } else { main };
    let locale = user_locale.filter(|l| !l.is_empty()).unwrap_or(main);
    (main.to_owned(), query_language.unwrap_or(locale).to_owned())
}

/// `fetchCombinedRatings` for mapped details: `None` is Node's `null`.
pub(super) async fn ratings_for(
    ctx: &Ready<'_>,
    data: &Map<String, Value>,
    media_type: &str,
    tmdb_id: i64,
) -> Result<Option<Value>, Fail> {
    let title = data
        .get("title")
        .or_else(|| data.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let release_date = data
        .get("releaseDate")
        .or_else(|| data.get("firstAirDate"))
        .and_then(Value::as_str)
        .filter(|d| !d.is_empty());
    let year = release_date
        .and_then(|d| d.get(..4))
        .and_then(|y| y.parse::<i64>().ok());
    if release_date.is_some() && year.is_none() {
        return Err(Fail::Forward(String::from(
            "the release date doesn't start with a year; Number() gives NaN",
        )));
    }
    let imdb_id = data.get("imdbId").and_then(Value::as_str);
    ctx.state
        .ratings
        .combined(
            &ctx.settings,
            &Title {
                media_type,
                tmdb_id,
                title,
                year,
                release_date,
                imdb_id,
            },
        )
        .await
        .map_err(Fail::Error)
}

/// The optional `language` parameter; any other key is the validator's.
/// `req.query.language` from what the validator left, or the raw query
/// read with [`language_query`] when it didn't run.
pub(super) fn language_of(ctx: &Ready<'_>) -> Result<Option<String>, String> {
    super::params::query(ctx).map_or_else(
        || language_query(ctx.req.uri.query().unwrap_or("")),
        |q| Ok(q.get("language").and_then(Value::as_str).map(str::to_owned)),
    )
}

/// `Number(req.query.page)` (1 when missing) and `req.query.language`
/// from what the validator left, or the raw query read with
/// [`page_query`].
pub(super) fn page_language_of(ctx: &Ready<'_>) -> Result<(i64, Option<String>), super::Fallback> {
    match super::params::query(ctx) {
        None => Ok(page_query(ctx.req.uri.query().unwrap_or(""))?),
        Some(q) => Ok((
            super::params::int(q.get("page"), "page")?.unwrap_or(1),
            q.get("language").and_then(Value::as_str).map(str::to_owned),
        )),
    }
}

/// The id in the path segment `depth` places from the end.
pub(super) fn path_number(ctx: &Ready<'_>, depth: usize) -> Result<i64, super::Fallback> {
    super::params::path_int(ctx, depth)
}

/// `Watchlist.exist({ where: { tmdbId, mediaType, requestedBy } })`.
pub(super) async fn on_watchlist(
    ctx: &Ready<'_>,
    tmdb_id: i64,
    kind: &str,
    user_id: i64,
) -> Result<bool, String> {
    ctx.state
        .db
        .watchlist_exists(tmdb_id, kind, Some(user_id))
        .await
        .map_err(|e| format!("{e:#}"))
}

pub(super) fn language_query(raw: &str) -> Result<Option<String>, String> {
    let mut language = None;
    for pair in raw.split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if key != "language" || language.is_some() {
            return Err(String::from("the query needs the OpenAPI validator"));
        }
        let Some(value) = super::user::decode_query_value(value) else {
            return Err(String::from(
                "a reserved or malformed character in a query value",
            ));
        };
        if value.is_empty() {
            return Err(String::from("an empty language; the validator answers 400"));
        }
        language = Some(value);
    }
    Ok(language)
}

/// `Media.getMedia` as `mediaInfo`: the media with its `requests` (each
/// with its own media, users, seasons and episodes), `issues` (with
/// media, users and comments) and `seasons`.
pub(super) async fn media_info_json(ctx: &Ready<'_>, media: &MediaRow) -> Result<Value, String> {
    let mut requests = ctx
        .state
        .db
        .requests_of_media(media.id)
        .await
        .map_err(|e| format!("loading the media's requests failed: {e:#}"))?;
    let mut issues = ctx
        .state
        .db
        .issues_of_media(media.id)
        .await
        .map_err(|e| format!("loading the media's issues failed: {e:#}"))?;
    let mut media = media.clone();
    crate::pgorder::media_details(&ctx.state.db, &mut media, &mut requests, &mut issues)
        .await
        .map_err(|e| format!("ordering the media's relations failed: {e:#}"))?;
    let media = &media;
    let mut user_ids: Vec<i64> = Vec::new();
    for request in &requests {
        user_ids.extend(request.requested_by_id);
        user_ids.extend(request.modified_by_id);
    }
    for issue in &issues {
        user_ids.extend(issue.created_by_id);
        user_ids.extend(issue.modified_by_id);
    }
    let related = Related::load(ctx, &[media.id], &user_ids, false).await?;
    let Value::Object(mut out) =
        crate::media::media_json(media, &ctx.settings, related.downloads(), false)
    else {
        return Err(String::from("media_json is not an object"));
    };
    let mut request_list = Vec::with_capacity(requests.len());
    for request in &requests {
        request_list.push(nested_request_json(ctx, &related, request)?);
    }
    out.insert(String::from("requests"), Value::Array(request_list));
    let mut issue_list = Vec::with_capacity(issues.len());
    for issue in &issues {
        issue_list.push(nested_issue_json(ctx, &related, issue)?);
    }
    out.insert(String::from("issues"), Value::Array(issue_list));
    out.insert(
        String::from("seasons"),
        Value::Array(
            media
                .seasons
                .iter()
                .map(crate::media::season_json)
                .collect(),
        ),
    );
    Ok(Value::Object(out))
}

/// A request as the eager relation of its media prints it: its own copy
/// of the media (without seasons), users without settings.
fn nested_request_json(
    ctx: &Ready<'_>,
    related: &Related,
    request: &RequestRow,
) -> Result<Value, String> {
    let mut out = Map::new();
    request::columns(&mut out, request);
    out.insert(
        String::from("media"),
        related.media_json(ctx, request.media_id, false),
    );
    out.insert(
        String::from("requestedBy"),
        related.user_json(request.requested_by_id, false)?,
    );
    out.insert(
        String::from("modifiedBy"),
        related.user_json(request.modified_by_id, false)?,
    );
    out.insert(
        String::from("seasons"),
        request::seasons_json(&request.seasons),
    );
    out.insert(
        String::from("episodes"),
        request::episodes_json(&request.episodes),
    );
    out.insert(
        String::from("seasonCount"),
        request::count_of(&request.seasons),
    );
    Ok(Value::Object(out))
}

/// An issue as the eager relation of its media prints it.
fn nested_issue_json(
    ctx: &Ready<'_>,
    related: &Related,
    issue: &IssueRow,
) -> Result<Value, String> {
    let mut out = Map::new();
    issue::columns(&mut out, issue);
    out.insert(
        String::from("media"),
        related.media_json(ctx, issue.media_id, false),
    );
    out.insert(
        String::from("createdBy"),
        related.user_json(issue.created_by_id, false)?,
    );
    out.insert(
        String::from("modifiedBy"),
        related.user_json(issue.modified_by_id, false)?,
    );
    out.insert(
        String::from("comments"),
        Value::Array(
            issue
                .comments
                .iter()
                .map(|c| issue::comment_json(c, None))
                .collect(),
        ),
    );
    Ok(Value::Object(out))
}

/// `mapMovieDetails`, in its key order; a property TMDB left out stays out
/// (JavaScript's `undefined`), a null stays null.
fn map_movie_details(
    movie: &Value,
    media_info: Option<Value>,
    on_watchlist: bool,
) -> Result<Map<String, Value>, String> {
    let mut out = Map::new();
    let copy = |out: &mut Map<String, Value>, key: &str, source: &str| {
        if let Some(value) = movie.get(source) {
            out.insert(key.to_owned(), value.clone());
        }
    };
    copy(&mut out, "id", "id");
    copy(&mut out, "adult", "adult");
    copy(&mut out, "budget", "budget");
    copy(&mut out, "genres", "genres");
    if let Some(videos) = map_videos(movie.get("videos")) {
        out.insert(String::from("relatedVideos"), videos);
    }
    copy(&mut out, "originalLanguage", "original_language");
    copy(&mut out, "originalTitle", "original_title");
    copy(&mut out, "popularity", "popularity");
    let companies = movie
        .get("production_companies")
        .and_then(Value::as_array)
        .ok_or("production_companies is not a list")?;
    out.insert(
        String::from("productionCompanies"),
        Value::Array(
            companies
                .iter()
                .map(|c| {
                    picked(
                        c,
                        &[
                            ("id", "id"),
                            ("name", "name"),
                            ("originCountry", "origin_country"),
                            ("description", "description"),
                            ("headquarters", "headquarters"),
                            ("homepage", "homepage"),
                            ("logoPath", "logo_path"),
                        ],
                    )
                })
                .collect(),
        ),
    );
    copy(&mut out, "productionCountries", "production_countries");
    copy(&mut out, "releaseDate", "release_date");
    copy(&mut out, "releases", "release_dates");
    copy(&mut out, "revenue", "revenue");
    copy(&mut out, "spokenLanguages", "spoken_languages");
    copy(&mut out, "status", "status");
    copy(&mut out, "title", "title");
    copy(&mut out, "video", "video");
    copy(&mut out, "voteAverage", "vote_average");
    copy(&mut out, "voteCount", "vote_count");
    copy(&mut out, "backdropPath", "backdrop_path");
    copy(&mut out, "homepage", "homepage");
    copy(&mut out, "imdbId", "imdb_id");
    copy(&mut out, "overview", "overview");
    copy(&mut out, "posterPath", "poster_path");
    copy(&mut out, "runtime", "runtime");
    copy(&mut out, "tagline", "tagline");
    map_movie_tail(movie, media_info, &mut out)?;
    out.insert(String::from("onUserWatchlist"), Value::Bool(on_watchlist));
    Ok(out)
}

/// The second half of `mapMovieDetails`: credits, collection, external
/// ids, media info, watch providers and keywords.
fn map_movie_tail(
    movie: &Value,
    media_info: Option<Value>,
    out: &mut Map<String, Value>,
) -> Result<(), String> {
    let cast = movie
        .pointer("/credits/cast")
        .and_then(Value::as_array)
        .ok_or("credits.cast is not a list")?;
    let crew = movie
        .pointer("/credits/crew")
        .and_then(Value::as_array)
        .ok_or("credits.crew is not a list")?;
    let mut credits = Map::new();
    credits.insert(
        String::from("cast"),
        Value::Array(cast.iter().map(map_cast).collect()),
    );
    credits.insert(
        String::from("crew"),
        Value::Array(crew.iter().map(map_crew).collect()),
    );
    out.insert(String::from("credits"), Value::Object(credits));
    if let Some(collection) = movie
        .get("belongs_to_collection")
        .filter(|c| crate::settings::public::truthy(Some(c)))
    {
        out.insert(
            String::from("collection"),
            picked(
                collection,
                &[
                    ("id", "id"),
                    ("name", "name"),
                    ("posterPath", "poster_path"),
                    ("backdropPath", "backdrop_path"),
                ],
            ),
        );
    }
    let external_ids = movie.get("external_ids").ok_or("external_ids is missing")?;
    out.insert(String::from("externalIds"), map_external_ids(external_ids));
    if let Some(media_info) = media_info {
        out.insert(String::from("mediaInfo"), media_info);
    }
    out.insert(
        String::from("watchProviders"),
        map_watch_providers(movie.get("watch/providers").and_then(|w| w.get("results"))),
    );
    let keywords = movie
        .pointer("/keywords/keywords")
        .and_then(Value::as_array)
        .ok_or("keywords.keywords is not a list")?;
    out.insert(
        String::from("keywords"),
        Value::Array(
            keywords
                .iter()
                .map(|k| picked(k, &[("id", "id"), ("name", "name")]))
                .collect(),
        ),
    );
    Ok(())
}

/// An object with the listed keys renamed, in that order; keys the source
/// lacks are left out.
pub(super) fn picked(source: &Value, keys: &[(&str, &str)]) -> Value {
    let mut out = Map::new();
    for (key, from) in keys {
        if let Some(value) = source.get(*from) {
            out.insert((*key).to_owned(), value.clone());
        }
    }
    Value::Object(out)
}

/// `mapCast`.
pub(super) fn map_cast(person: &Value) -> Value {
    picked(
        person,
        &[
            ("castId", "cast_id"),
            ("character", "character"),
            ("creditId", "credit_id"),
            ("id", "id"),
            ("name", "name"),
            ("order", "order"),
            ("gender", "gender"),
            ("profilePath", "profile_path"),
        ],
    )
}

/// `mapAggregateCast`: the character and credit come from the first role,
/// which Node assumes exists.
pub(super) fn map_cast_aggregate(person: &Value) -> Result<Value, String> {
    let role = person
        .get("roles")
        .and_then(Value::as_array)
        .and_then(|roles| roles.first())
        .ok_or("an aggregate cast entry has no roles")?;
    let mut out = Map::new();
    if let Some(cast_id) = person.get("cast_id") {
        out.insert(String::from("castId"), cast_id.clone());
    }
    for (key, source) in [("character", "character"), ("creditId", "credit_id")] {
        if let Some(value) = role.get(source) {
            out.insert(String::from(key), value.clone());
        }
    }
    for (key, source) in [
        ("id", "id"),
        ("name", "name"),
        ("order", "order"),
        ("gender", "gender"),
        ("profilePath", "profile_path"),
    ] {
        if let Some(value) = person.get(source) {
            out.insert(String::from(key), value.clone());
        }
    }
    Ok(Value::Object(out))
}

/// `mapCrew`.
pub(super) fn map_crew(person: &Value) -> Value {
    picked(
        person,
        &[
            ("creditId", "credit_id"),
            ("department", "department"),
            ("id", "id"),
            ("job", "job"),
            ("name", "name"),
            ("gender", "gender"),
            ("profilePath", "profile_path"),
        ],
    )
}

/// `mapExternalIds`.
pub(super) fn map_external_ids(ids: &Value) -> Value {
    picked(
        ids,
        &[
            ("facebookId", "facebook_id"),
            ("freebaseId", "freebase_id"),
            ("freebaseMid", "freebase_mid"),
            ("imdbId", "imdb_id"),
            ("instagramId", "instagram_id"),
            ("tvdbId", "tvdb_id"),
            ("tvrageId", "tvrage_id"),
            ("twitterId", "twitter_id"),
        ],
    )
}

/// `mapVideos`: `None` when TMDB sent no `videos` (the property is then
/// `undefined`).
pub(super) fn map_videos(videos: Option<&Value>) -> Option<Value> {
    let videos = videos.filter(|v| !v.is_null())?;
    let results = videos.get("results").and_then(Value::as_array)?;
    Some(Value::Array(
        results
            .iter()
            .map(|video| {
                let mut out = Map::new();
                for key in ["site", "key", "name", "size", "type"] {
                    if let Some(value) = video.get(key) {
                        out.insert(key.to_owned(), value.clone());
                    }
                }
                if video.get("site").and_then(Value::as_str) == Some("YouTube") {
                    out.insert(
                        String::from("url"),
                        Value::from(format!(
                            "https://www.youtube.com/watch?v={}",
                            crate::media::js_string(video.get("key"))
                        )),
                    );
                }
                Value::Object(out)
            })
            .collect(),
    ))
}

/// `mapWatchProviders` over the `results` object, in its key order.
pub(super) fn map_watch_providers(results: Option<&Value>) -> Value {
    let Some(Value::Object(results)) = results else {
        return Value::Array(Vec::new());
    };
    Value::Array(
        results
            .iter()
            .map(|(region, provider)| {
                let mut out = Map::new();
                out.insert(String::from("iso_3166_1"), Value::from(region.as_str()));
                if let Some(link) = provider.get("link") {
                    out.insert(String::from("link"), link.clone());
                }
                let details = |kind: &str| {
                    Value::Array(
                        provider
                            .get(kind)
                            .and_then(Value::as_array)
                            .map(|items| {
                                items
                                    .iter()
                                    .map(|p| {
                                        picked(
                                            p,
                                            &[
                                                ("displayPriority", "display_priority"),
                                                ("logoPath", "logo_path"),
                                                ("id", "provider_id"),
                                                ("name", "provider_name"),
                                            ],
                                        )
                                    })
                                    .collect()
                            })
                            .unwrap_or_default(),
                    )
                };
                out.insert(String::from("buy"), details("buy"));
                out.insert(String::from("flatrate"), details("flatrate"));
                Value::Object(out)
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_details_in_order() {
        let movie = json!({
            "id": 1, "adult": false, "budget": 0, "genres": [], "original_language": "en",
            "original_title": "T", "popularity": 1.5, "production_companies": [{"id": 2, "name": "Co", "origin_country": "US", "logo_path": null}],
            "production_countries": [], "release_date": "1999-10-15", "release_dates": {"results": []}, "revenue": 1,
            "spoken_languages": [], "status": "Released", "title": "T", "video": false, "vote_average": 8.4, "vote_count": 10,
            "backdrop_path": null, "homepage": "", "imdb_id": "tt1", "overview": "", "poster_path": "/p.jpg", "runtime": 139, "tagline": "",
            "credits": {"cast": [{"cast_id": 4, "character": "N", "credit_id": "c", "id": 8, "name": "E", "order": 0, "gender": 2, "profile_path": null}], "crew": []},
            "belongs_to_collection": null, "external_ids": {"imdb_id": "tt1", "facebook_id": null},
            "videos": {"results": [{"site": "YouTube", "key": "k", "name": "n", "size": 1080, "type": "Trailer", "iso_639_1": "en"}]},
            "keywords": {"keywords": [{"id": 3, "name": "k"}]},
            "watch/providers": {"results": {"US": {"link": "l", "flatrate": [{"display_priority": 0, "logo_path": "/x", "provider_id": 8, "provider_name": "N"}]}}}
        });
        let out = map_movie_details(&movie, None, true).unwrap_or_default();
        let keys: Vec<&str> = out.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                "id",
                "adult",
                "budget",
                "genres",
                "relatedVideos",
                "originalLanguage",
                "originalTitle",
                "popularity",
                "productionCompanies",
                "productionCountries",
                "releaseDate",
                "releases",
                "revenue",
                "spokenLanguages",
                "status",
                "title",
                "video",
                "voteAverage",
                "voteCount",
                "backdropPath",
                "homepage",
                "imdbId",
                "overview",
                "posterPath",
                "runtime",
                "tagline",
                "credits",
                "externalIds",
                "watchProviders",
                "keywords",
                "onUserWatchlist"
            ],
            "mapMovieDetails order, without collection and mediaInfo"
        );
        assert_eq!(
            out.get("relatedVideos"),
            Some(
                &json!([{"site": "YouTube", "key": "k", "name": "n", "size": 1080, "type": "Trailer", "url": "https://www.youtube.com/watch?v=k"}])
            ),
            "videos"
        );
        assert_eq!(
            out.get("watchProviders"),
            Some(
                &json!([{"iso_3166_1": "US", "link": "l", "buy": [], "flatrate": [{"displayPriority": 0, "logoPath": "/x", "id": 8, "name": "N"}]}])
            ),
            "providers"
        );
        assert_eq!(
            out.get("externalIds"),
            Some(&json!({"facebookId": null, "imdbId": "tt1"})),
            "null kept, missing dropped"
        );
        assert_eq!(
            out.get("productionCompanies"),
            Some(&json!([{"id": 2, "name": "Co", "originCountry": "US", "logoPath": null}])),
            "companies"
        );
    }

    #[test]
    fn language_parsing() {
        assert_eq!(language_query("").ok(), Some(None), "none");
        assert_eq!(
            language_query("language=de").ok(),
            Some(Some(String::from("de"))),
            "given"
        );
        assert!(language_query("language=").is_err(), "empty");
        assert!(language_query("x=1").is_err(), "unknown");
    }
}
