//! `GET /tv/{id}/episodes` (the TVDB episode catalog, `server/routes/tv.ts`)
//! and `GET /service/sonarr/lookup/{tmdbId}` (`server/routes/service.ts`).

use std::future::Future;
use std::pin::Pin;

use axum::http::Method;
use serde_json::{Map, Value};

use super::metadata::{request_locale, safe_path_id};
use super::movie::languages;
use super::tv::is_anime;
use super::{Outcome, Ready, Table};
use crate::media::js_string;
use crate::settings::public::truthy;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// `getEpisodeCatalog` reads at most this many pages.
const MAX_PAGES: u32 = 50;

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/tv/{id}/episodes", Method::GET, catalog),
    (
        "/api/v1/service/sonarr/lookup/{tmdbId}",
        Method::GET,
        sonarr_lookup,
    ),
];

const CATALOG_FAILED: &str = "Unable to retrieve episode catalog.";

/// `GET /tv/{id}/episodes`: the official TVDB episodes of a show whose
/// metadata provider is TVDB, with partial requests on. Anything that
/// depends on Node's own TVDB session (logins, its response cache) going
/// wrong is handed to Node, which answers from its own state.
fn catalog<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user = match ctx.require(0) {
            Ok(user) => user,
            Err(answer) => return *answer,
        };
        if let Err(why) = ctx.no_query() {
            return Outcome::forward(why);
        }
        let id = match safe_path_id(ctx, 1) {
            Ok(id) => id,
            Err(why) => return Outcome::forward(why),
        };
        let (main_locale, _) = languages(ctx, None, None);
        let probe = match ctx.state.tmdb.tv(id, &main_locale).await {
            Ok(show) => show,
            Err(e) => return catalog_failed(ctx, &e),
        };
        let provider = if is_anime(&probe) {
            "/metadataSettings/anime"
        } else {
            "/metadataSettings/tv"
        };
        let tvdb = ctx.settings.str(provider) == "tvdb";
        if !tvdb || !truthy(ctx.settings.get("/main/partialRequestsEnabled")) {
            return ctx.error(409, "Episode requests require the TVDB metadata provider.");
        }
        let client = &ctx.state.outbound;
        if let Err(e) = crate::tvdb::ensure_instance(client).await {
            // `getMetadataProvider` falls back to TMDB when the first
            // login fails.
            tracing::error!("Failed to get metadata provider: {e:#}");
            return ctx.error(409, "Episode requests require the TVDB metadata provider.");
        }
        let Some(language) = request_locale(ctx, user.locale.as_deref()) else {
            return Outcome::forward(String::from("no main locale; the TVDB default applies"));
        };
        let Some(wanted) = crate::tvdb::tvdb_language(&language) else {
            return Outcome::forward(String::from("a locale named like an Object property"));
        };
        let show = match ctx.state.tmdb.tv(id, &language).await {
            Ok(show) => show,
            Err(e) => return catalog_failed(ctx, &e),
        };
        let tvdb_id = match show.pointer("/external_ids/tvdb_id") {
            None | Some(Value::Null) => {
                tracing::warn!("Unable to retrieve TVDB episode catalog: no TVDB id for {id}");
                return ctx.error(502, CATALOG_FAILED);
            }
            Some(v) => match v.as_i64() {
                Some(-1) => return ctx.error(502, CATALOG_FAILED),
                Some(tvdb_id) => tvdb_id,
                None => return Outcome::forward(String::from("a TVDB id that isn't an integer")),
            },
        };
        let episodes = match tvdb_episodes(client, tvdb_id, wanted).await {
            Ok(Ok(episodes)) => episodes,
            Ok(Err(why)) => return Outcome::forward(why),
            // Whatever TVDB failed with lands in the route's catch.
            Err(e) => return catalog_failed(ctx, &e),
        };
        let specials = truthy(ctx.settings.get("/main/enableSpecialEpisodes"));
        let episodes: Vec<Value> = episodes
            .into_iter()
            .filter(|(season, _, _)| specials || *season > 0.0)
            .map(|(_, _, episode)| episode)
            .collect();
        let mut out = Map::new();
        out.insert(String::from("tvdbSeriesId"), Value::from(tvdb_id));
        out.insert(String::from("episodes"), Value::Array(episodes));
        ctx.json(&Value::Object(out))
    })
}

fn catalog_failed(ctx: &Ready<'_>, error: &anyhow::Error) -> Outcome {
    tracing::warn!("Unable to retrieve TVDB episode catalog: {error:#}");
    ctx.error(502, CATALOG_FAILED)
}

/// A catalog entry with its sort key.
pub(super) type Entry = (f64, f64, Value);

/// The rest of `getEpisodeCatalog` once the TVDB id is known: the token
/// refresh, the official seasons and every episode page. `Ok(Err(why))`
/// when the answers have a shape Node would trip over or sort oddly.
pub(super) async fn tvdb_episodes(
    client: &reqwest::Client,
    tvdb_id: i64,
    language: &str,
) -> anyhow::Result<Result<Vec<Entry>, String>> {
    crate::tvdb::refresh_token(client).await?;
    let show = crate::tvdb::get(
        client,
        &format!("/series/{tvdb_id}/extended?meta=episodes&short=true"),
    )
    .await?;
    let Some(seasons) = show.pointer("/data/seasons").and_then(Value::as_array) else {
        return Ok(Err(String::from("the TVDB show has no seasons list")));
    };
    let mut official: Vec<Option<Value>> = Vec::new();
    for season in seasons {
        let Value::Object(season) = season else {
            return Ok(Err(String::from("a TVDB season that isn't an object")));
        };
        if season.get("type").and_then(|t| t.get("type")) == Some(&Value::from("official")) {
            official.push(season.get("number").cloned());
        }
    }
    let mut raw = Vec::new();
    for page in 0..MAX_PAGES {
        let response = crate::tvdb::get(
            client,
            &format!("/series/{tvdb_id}/episodes/default/{language}?page={page}"),
        )
        .await?;
        let Value::Object(response) = response else {
            return Ok(Err(String::from(
                "a TVDB episode page that isn't an object",
            )));
        };
        let episodes = match response.get("data").and_then(|d| d.get("episodes")) {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(items)) => items.clone(),
            Some(_) => return Ok(Err(String::from("TVDB episodes that aren't a list"))),
        };
        let empty = episodes.is_empty();
        raw.extend(episodes);
        let next = response.get("links").and_then(|l| l.get("next"));
        if !truthy(next) || empty {
            break;
        }
    }
    Ok(catalog_entries(&raw, &official))
}

/// Map, filter to official seasons and sort the raw TVDB episodes.
fn catalog_entries(raw: &[Value], official: &[Option<Value>]) -> Result<Vec<Entry>, String> {
    let mut entries = Vec::new();
    for episode in raw {
        let Value::Object(episode) = episode else {
            return Err(String::from("a TVDB episode that isn't an object"));
        };
        let season = episode.get("seasonNumber");
        if !official.iter().any(|o| same_value_zero(o.as_ref(), season)) {
            continue;
        }
        let number = episode.get("number");
        let (Some(season_key), Some(number_key)) = (
            season.and_then(Value::as_f64),
            number.and_then(Value::as_f64),
        ) else {
            return Err(String::from(
                "an episode without numbers; the sort compares NaN",
            ));
        };
        let mut item = Map::new();
        if let Some(id) = episode.get("id") {
            item.insert(String::from("tvdbId"), id.clone());
        }
        if let Some(season) = season {
            item.insert(String::from("seasonNumber"), season.clone());
        }
        if let Some(number) = number {
            item.insert(String::from("episodeNumber"), number.clone());
        }
        let title = match episode.get("name") {
            Some(name) if truthy(Some(name)) => name.clone(),
            _ => Value::from(format!("Episode {}", js_string(number))),
        };
        item.insert(String::from("title"), title);
        if let Some(aired) = episode.get("aired").filter(|a| truthy(Some(a))) {
            item.insert(String::from("airDate"), aired.clone());
        }
        entries.push((season_key, number_key, Value::Object(item)));
    }
    // `a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber`
    // over numbers that aren't NaN; the sort is stable, like V8's.
    let order = |x: f64, y: f64| x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal);
    entries.sort_by(|a, b| order(a.0, b.0).then(order(a.1, b.1)));
    Ok(entries)
}

/// `Set.has`'s `SameValueZero` over JSON values; `None` is `undefined`.
fn same_value_zero(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(x @ (Value::Null | Value::Bool(_) | Value::String(_))), Some(y)) => x == y,
        _ => false,
    }
}

const LOOKUP_FAILED: &str = "Something went wrong trying to fetch series information";

/// `GET /service/sonarr/lookup/{tmdbId}`: the first Sonarr server's
/// lookup for the show's English name.
fn sonarr_lookup<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = ctx
            .no_query()
            .and_then(|()| ctx.authenticated(0).map(|_| ()))
        {
            return Outcome::forward(why);
        }
        let id = match safe_path_id(ctx, 0) {
            Ok(id) => id,
            Err(why) => return Outcome::forward(why),
        };
        let Some(servers) = ctx.settings.get("/sonarr").and_then(Value::as_array) else {
            return Outcome::forward(String::from("settings.sonarr is not a list"));
        };
        let server = match servers.first() {
            None => {
                tracing::error!("No sonarr server has been setup");
                return ctx.error(404, "No sonarr server has been setup");
            }
            Some(server @ Value::Object(_)) => server,
            Some(_) => return Outcome::forward(String::from("an odd first Sonarr server")),
        };
        let show = match ctx.state.tmdb.tv(id, "en").await {
            Ok(show) => show,
            Err(e) => return lookup_failed(ctx, &e),
        };
        let query = match show.get("name") {
            None | Some(Value::Null) => Vec::new(),
            Some(name @ (Value::String(_) | Value::Number(_))) => {
                vec![("term", js_string(Some(name)).into_owned())]
            }
            Some(_) => return Outcome::forward(String::from("a show name that isn't text")),
        };
        let found = ctx
            .state
            .servarr
            .call(
                server,
                Method::GET,
                "/series/lookup",
                &query,
                None,
                crate::servarr::api_timeout(&ctx.settings),
            )
            .await;
        let data = match found {
            Ok(data) => data,
            Err(e) => return lookup_failed(ctx, &e),
        };
        match lookup_result(&data) {
            Some(true) => ctx.json(&data),
            Some(false) => {
                tracing::error!("Failed to fetch tvdb search results: No series found");
                ctx.error(500, LOOKUP_FAILED)
            }
            None => Outcome::forward(String::from("an empty or non-JSON lookup answer")),
        }
    })
}

/// Whether `response.data[0]` is truthy; `None` when the body was empty or
/// not JSON (axios then hands over a string this port doesn't keep).
fn lookup_result(data: &Value) -> Option<bool> {
    match data {
        Value::Null => None,
        Value::Array(items) => Some(truthy(items.first())),
        Value::Object(map) => Some(truthy(map.get("0"))),
        Value::String(s) => Some(!s.is_empty()),
        Value::Bool(_) | Value::Number(_) => Some(false),
    }
}

fn lookup_failed(ctx: &Ready<'_>, error: &anyhow::Error) -> Outcome {
    tracing::error!("Failed to fetch tvdb search results: {error:#}");
    ctx.error(500, LOOKUP_FAILED)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn catalog_filters_maps_and_sorts() {
        let raw = vec![
            json!({"id": 3, "seasonNumber": 2, "number": 1, "name": "", "aired": "2021-01-01"}),
            json!({"id": 1, "seasonNumber": 1, "number": 2, "name": "B", "aired": null}),
            json!({"id": 2, "seasonNumber": 1, "number": 1, "name": "A", "aired": ""}),
            json!({"id": 9, "seasonNumber": 7, "number": 1}),
        ];
        let official = vec![Some(json!(1)), Some(json!(2))];
        let entries = catalog_entries(&raw, &official).unwrap_or_default();
        let items: Vec<Value> = entries.into_iter().map(|e| e.2).collect();
        assert_eq!(
            items,
            vec![
                json!({"tvdbId": 2, "seasonNumber": 1, "episodeNumber": 1, "title": "A"}),
                json!({"tvdbId": 1, "seasonNumber": 1, "episodeNumber": 2, "title": "B"}),
                json!({"tvdbId": 3, "seasonNumber": 2, "episodeNumber": 1, "title": "Episode 1", "airDate": "2021-01-01"}),
            ],
            "official seasons only, by season then number"
        );
        assert!(
            catalog_entries(&[json!({"seasonNumber": 1})], &official).is_err(),
            "a missing number would sort as NaN"
        );
    }

    #[test]
    fn same_value_zero_matches_set_has() {
        assert!(same_value_zero(None, None), "undefined");
        assert!(
            same_value_zero(Some(&json!(1)), Some(&json!(1.0))),
            "numbers"
        );
        assert!(
            !same_value_zero(Some(&json!(1)), Some(&json!("1"))),
            "types"
        );
        assert!(
            !same_value_zero(Some(&json!(null)), None),
            "null isn't undefined"
        );
    }

    #[test]
    fn lookup_needs_a_truthy_first_item() {
        assert_eq!(lookup_result(&json!([{"title": "x"}])), Some(true), "found");
        assert_eq!(lookup_result(&json!([])), Some(false), "empty");
        assert_eq!(lookup_result(&json!([null, 1])), Some(false), "falsy first");
        assert_eq!(lookup_result(&Value::Null), None, "no body");
    }
}
