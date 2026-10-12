//! TMDB metadata lookups from `server/routes/index.ts`: genres,
//! certifications, keywords, networks, studios and the login backdrops.

use std::future::Future;
use std::pin::Pin;

use axum::http::Method;
use serde_json::Value;

use super::movie::{languages, picked};
use super::{Outcome, Ready, Table};
use crate::settings::public::truthy;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// `ExternalAPI`'s default TTL.
const DEFAULT_TTL: u64 = 300;
/// Seven days, the TTL of certifications and keywords.
const WEEK: u64 = 604_800;

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/genres/movie", Method::GET, genres_movie),
    ("/api/v1/genres/tv", Method::GET, genres_tv),
    (
        "/api/v1/certifications/movie",
        Method::GET,
        certifications_movie,
    ),
    ("/api/v1/certifications/tv", Method::GET, certifications_tv),
    ("/api/v1/keyword/{keywordId}", Method::GET, keyword),
    ("/api/v1/network/{id}", Method::GET, network),
    ("/api/v1/studio/{id}", Method::GET, studio),
    ("/api/v1/backdrops", Method::GET, backdrops),
];

/// The id in the path segment `depth` places from the end.
pub(super) fn safe_path_id(ctx: &Ready<'_>, depth: usize) -> Result<i64, super::Fallback> {
    super::movie::path_number(ctx, depth)
}

/// `req.locale`: the user's settings locale, else `settings.main.locale`
/// as it is (empty included). Without a main locale the TMDB and TVDB
/// clients use their default, English.
pub(super) fn request_locale(ctx: &Ready<'_>, user_locale: Option<&str>) -> String {
    user_locale
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            ctx.settings
                .get("/main/locale")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| String::from("en"))
}

fn genres_movie<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    genres(ctx, "movie", "Unable to retrieve movie genres.")
}

fn genres_tv<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    genres(ctx, "tv", "Unable to retrieve series genres.")
}

/// `GET /genres/{movie,tv}`: `language` from the query, else `req.locale`.
fn genres<'a>(ctx: &'a Ready<'a>, kind: &'static str, failure: &'static str) -> Native<'a> {
    Box::pin(async move {
        let user = match ctx.authenticated(0) {
            Ok(user) => user,
            Err(why) => return Outcome::forward(why),
        };
        let query = match super::movie::language_of(ctx) {
            Ok(language) => language,
            Err(why) => return Outcome::forward(why),
        };
        let language = query.unwrap_or_else(|| request_locale(ctx, user.locale.as_deref()));
        match ctx.state.tmdb.genres(kind, &language).await {
            Ok(items) => ctx.json(&Value::Array(items)),
            Err(e) => failed(ctx, failure, &e),
        }
    })
}

fn certifications_movie<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    certifications(ctx, "movie", "Unable to retrieve movie certifications.")
}

fn certifications_tv<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    certifications(ctx, "tv", "Unable to retrieve TV certifications.")
}

/// `GET /certifications/{movie,tv}`: TMDB's list as it is.
fn certifications<'a>(ctx: &'a Ready<'a>, kind: &'static str, failure: &'static str) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = ctx
            .no_query()
            .and_then(|()| ctx.authenticated(0).map(|_| ()))
        {
            return Outcome::forward(why);
        }
        let path = format!("/certification/{kind}/list");
        match ctx.state.tmdb.raw(&path, &[], WEEK).await {
            Ok(data) => ctx.json(&data),
            Err(e) => failed(ctx, failure, &e),
        }
    })
}

/// `GET /keyword/{id}`: the keyword, or `null` when TMDB doesn't know it.
fn keyword<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = ctx.no_query().and_then(|()| ctx.credential_present()) {
            return Outcome::forward(why);
        }
        let id = match safe_path_id(ctx, 0) {
            Ok(id) => id,
            Err(why) => return Outcome::forward(why),
        };
        match ctx
            .state
            .tmdb
            .raw(&format!("/keyword/{id}"), &[], WEEK)
            .await
        {
            Ok(data) => ctx.json(&data),
            Err(e) if http_status(&e) == Some(404) => ctx.json(&Value::Null),
            Err(e) => failed(ctx, "Unable to retrieve keyword data.", &e),
        }
    })
}

/// The HTTP status of a failed upstream call, if it got that far.
pub(super) fn http_status(error: &anyhow::Error) -> Option<u16> {
    error
        .chain()
        .find_map(|cause| cause.downcast_ref::<reqwest::Error>())
        .and_then(reqwest::Error::status)
        .map(|s| s.as_u16())
}

/// `GET /network/{id}`: `mapNetwork`.
fn network<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    company(
        ctx,
        "network",
        "Unable to retrieve network.",
        &[
            ("id", "id"),
            ("name", "name"),
            ("originCountry", "origin_country"),
            ("headquarters", "headquarters"),
            ("homepage", "homepage"),
            ("logoPath", "logo_path"),
        ],
    )
}

/// `GET /studio/{id}`: `mapProductionCompany`.
fn studio<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    company(
        ctx,
        "company",
        "Unable to retrieve studio.",
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
}

fn company<'a>(
    ctx: &'a Ready<'a>,
    lookup: &'static str,
    failure: &'static str,
    fields: &'static [(&'static str, &'static str)],
) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = ctx.no_query().and_then(|()| ctx.credential_present()) {
            return Outcome::forward(why);
        }
        let id = match safe_path_id(ctx, 0) {
            Ok(id) => id,
            Err(why) => return Outcome::forward(why),
        };
        match ctx
            .state
            .tmdb
            .raw(&format!("/{lookup}/{id}"), &[], DEFAULT_TTL)
            .await
        {
            Ok(data) => ctx.json(&picked(&data, fields)),
            Err(e) => failed(ctx, failure, &e),
        }
    })
}

/// `GET /backdrops`: the backdrops of this week's trending titles. The
/// route is public (`security: []`).
fn backdrops<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = ctx.no_query() {
            return Outcome::forward(why);
        }
        let (locale, _) = languages(ctx, None, None);
        let mut params = vec![("page", String::from("1")), ("language", locale)];
        match ctx.settings.get("/main/discoverRegion") {
            None | Some(Value::Null) => {}
            Some(v @ (Value::String(_) | Value::Number(_))) => {
                params.push(("region", crate::media::js_string(Some(v)).into_owned()));
            }
            Some(Value::Bool(_) | Value::Array(_) | Value::Object(_)) => {
                return Outcome::forward(String::from("an odd discoverRegion"));
            }
        }
        let data = match ctx
            .state
            .tmdb
            .raw("/trending/all/week", &params, DEFAULT_TTL)
            .await
        {
            Ok(data) => data,
            Err(e) => return failed(ctx, "Unable to retrieve backdrops.", &e),
        };
        backdrop_paths(&data).map_or_else(
            || ctx.error(500, "Unable to retrieve backdrops."),
            |paths| ctx.json(&Value::Array(paths)),
        )
    })
}

/// The truthy `backdrop_path`s of every result that isn't a person; `None`
/// where Node's code would throw (no results list, a null result).
fn backdrop_paths(data: &Value) -> Option<Vec<Value>> {
    let results = data.get("results")?.as_array()?;
    let mut out = Vec::new();
    for result in results {
        match result {
            Value::Null => return None,
            Value::Object(map) => {
                if map.contains_key("known_for") {
                    continue;
                }
                if let Some(path) = map.get("backdrop_path").filter(|p| truthy(Some(p))) {
                    out.push(path.clone());
                }
            }
            Value::Bool(_) | Value::Number(_) | Value::String(_) | Value::Array(_) => {}
        }
    }
    Some(out)
}

/// The 500 Node's error handler sends after `next({ status: 500, message })`.
fn failed(ctx: &Ready<'_>, message: &str, error: &anyhow::Error) -> Outcome {
    tracing::debug!("{message} {error:#}");
    ctx.error(500, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn backdrops_skip_people_and_empty_paths() {
        let data = json!({"results": [
            {"backdrop_path": "/a.jpg", "title": "A"},
            {"known_for": [], "backdrop_path": "/person.jpg"},
            {"backdrop_path": null},
            {"backdrop_path": ""},
            {"name": "no path"},
            {"backdrop_path": "/b.jpg"}
        ]});
        assert_eq!(
            backdrop_paths(&data),
            Some(vec![json!("/a.jpg"), json!("/b.jpg")]),
            "paths in order"
        );
        assert_eq!(
            backdrop_paths(&json!({"results": [null]})),
            None,
            "a null result throws"
        );
        assert_eq!(backdrop_paths(&json!({})), None, "no results throws");
    }
}
