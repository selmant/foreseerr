//! `server/routes/mediaActions.ts`: watched and rating actions fanned out
//! to the user's linked Trakt, Jellyfin, `AniList` and Simkl accounts
//! (`crate::mediaactions`).
//!
//! The provider snapshots these routes read and patch are the mapping
//! layer's sync caches, which belong to whichever process runs the jobs.
//! When that is Node ([`crate::mappinglayer::owned`] is false), a request
//! that would reach a provider goes to Node so its caches stay the ones
//! the actions patch; only the no-provider answers are given here. Trakt
//! through the Better Trakt Jellyfin plugin takes its token from the
//! plugin's bridge (`crate::traktbridge`).

use std::future::Future;
use std::pin::Pin;

use axum::http::Method;
use serde_json::{Map, Value};

use super::{Outcome, Ready, Table};
use crate::db::Bind;
use crate::jellyfin::{join_all, Job};
use crate::mappinglayer::MediaType;
use crate::mediaactions::anilist::AnilistProvider;
use crate::mediaactions::dispatcher::{Dispatcher, MarkOptions, Thrown, Write};
use crate::mediaactions::jellyfin::JellyfinProvider;
use crate::mediaactions::simkl::SimklProvider;
use crate::mediaactions::trakt::TraktProvider;
use crate::mediaactions::types::{
    episode_write_aggregate, episode_write_result, Aggregate, EpisodeWrite, Item, ProviderId,
    ProviderResult, Status, FULL, WATCHED_ONLY,
};
use crate::mediaactions::{anilist, anilistepisodes, jellyfin, simkl, simklepisodes, trakt, Env};
use crate::settings::public::truthy;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// This module's routes. The per-title routes are registered per media
/// type, so other values (which the validator rejects) go to Node.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/media-actions/capabilities", Method::GET, capabilities),
    ("/api/v1/media-actions/status-batch", Method::POST, status_batch),
    ("/api/v1/media-actions/movie/{tmdbId}/status", Method::GET, status),
    ("/api/v1/media-actions/tv/{tmdbId}/status", Method::GET, status),
    ("/api/v1/media-actions/movie/{tmdbId}/watched", Method::POST, watched),
    ("/api/v1/media-actions/tv/{tmdbId}/watched", Method::POST, watched),
    ("/api/v1/media-actions/movie/{tmdbId}/unwatched", Method::POST, unwatched),
    ("/api/v1/media-actions/tv/{tmdbId}/unwatched", Method::POST, unwatched),
    ("/api/v1/media-actions/movie/{tmdbId}/rate", Method::POST, rate),
    ("/api/v1/media-actions/tv/{tmdbId}/rate", Method::POST, rate),
    (
        "/api/v1/media-actions/tv/{tmdbId}/seasons/{seasonNumber}/episodes/status",
        Method::GET,
        episode_status,
    ),
    (
        "/api/v1/media-actions/tv/{tmdbId}/seasons/{seasonNumber}/episodes/{episodeNumber}/watched",
        Method::POST,
        episode_watched,
    ),
    (
        "/api/v1/media-actions/tv/{tmdbId}/seasons/{seasonNumber}/episodes/{episodeNumber}/unwatched",
        Method::POST,
        episode_watched,
    ),
    (
        "/api/v1/media-actions/episodes/jellyfin/{jellyfinItemId}/watched",
        Method::POST,
        jellyfin_item_watched,
    ),
    (
        "/api/v1/media-actions/episodes/jellyfin/{jellyfinItemId}/unwatched",
        Method::POST,
        jellyfin_item_watched,
    ),
];

macro_rules! try_forward {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(why) => return Outcome::forward(why),
        }
    };
}

/// `handleActionError(e, next, fallbackMessage)`.
fn action_error(ctx: &Ready<'_>, error: &str, fallback: &str) -> Outcome {
    if error.starts_with("ratingStars must be") {
        return ctx.error(400, error);
    }
    tracing::error!(label = "API", error_message = error, "{fallback}");
    ctx.error(500, fallback)
}

/// The request's provider environment.
fn env<'a>(ctx: &'a Ready<'a>, user: i64) -> Env<'a> {
    Env {
        state: ctx.state,
        settings: std::sync::Arc::clone(&ctx.settings),
        user,
    }
}

/// `getMediaActionDispatcher()` over this request's providers.
fn dispatcher<'a>(env: &'a Env<'a>) -> Dispatcher<'a> {
    Dispatcher::new(vec![
        Box::new(TraktProvider::new(env)),
        Box::new(JellyfinProvider::new(env)),
        Box::new(AnilistProvider::new(env)),
        Box::new(SimklProvider::new(env)),
    ])
}

/// Whether Node has to answer: while Node owns the sync caches, any
/// linked provider.
async fn node_answers(ctx: &Ready<'_>, user: i64) -> Result<(), String> {
    if crate::mappinglayer::owned() {
        return Ok(());
    }
    if linked_somewhere(ctx, user).await? {
        return Err(String::from("this linked provider action is not supported"));
    }
    Ok(())
}

/// `settings.mediaActions.providers[id] === false`.
fn provider_off(ctx: &Ready<'_>, id: &str) -> bool {
    ctx.settings.get(&format!("/mediaActions/providers/{id}")) == Some(&Value::Bool(false))
}

/// A non-blank trimmed setting, as the app-credential checks want.
fn configured(ctx: &Ready<'_>, pointer: &str) -> bool {
    ctx.settings
        .get(pointer)
        .and_then(Value::as_str)
        .is_some_and(|s| !s.trim().is_empty())
}

/// Whether any provider's `isAvailable` might hold, read without side
/// effects (an expired `AniList` token, which Node clears, counts).
async fn linked_somewhere(ctx: &Ready<'_>, user_id: i64) -> Result<bool, String> {
    let db = &ctx.state.db;
    let settings_rows = db
        .rows(
            r#"SELECT "traktAccessToken", "traktRefreshToken", "mediaActionsTraktEnabled", "anilistAccessToken", "mediaActionsAnilistEnabled", "simklAccessToken", "mediaActionsSimklEnabled" FROM "user_settings" WHERE "userId" = ?1"#,
            &[Bind::Int(user_id)],
        )
        .await
        .map_err(|e| format!("database: {e:#}"))?;
    let user_rows = db
        .rows(
            r#"SELECT "jellyfinUserId", "jellyfinAuthToken", "jellyfinDeviceId" FROM "user" WHERE "id" = ?1"#,
            &[Bind::Int(user_id)],
        )
        .await
        .map_err(|e| format!("database: {e:#}"))?;
    let s = settings_rows.first();
    let field = |key: &str| s.and_then(|r| r.get(key));
    let off = |key: &str| crate::mediaactions::env::stored_false(s, key);
    let trakt = !provider_off(ctx, "trakt")
        && configured(ctx, "/trakt/clientId")
        && configured(ctx, "/trakt/clientSecret")
        && !off("mediaActionsTraktEnabled")
        && truthy(field("traktAccessToken"))
        && truthy(field("traktRefreshToken"));
    let anilist = !provider_off(ctx, "anilist")
        && configured(ctx, "/anilist/clientId")
        && configured(ctx, "/anilist/clientSecret")
        && !off("mediaActionsAnilistEnabled")
        && field("anilistAccessToken")
            .and_then(Value::as_str)
            .is_some_and(|t| !t.trim().is_empty());
    let jellyfin = !provider_off(ctx, "jellyfin")
        && ctx
            .settings
            .get("/main/mediaServerType")
            .is_some_and(|v| v.is_number() && v.as_i64() == Some(2))
        && ["jellyfinUserId", "jellyfinAuthToken", "jellyfinDeviceId"]
            .iter()
            .all(|k| truthy(user_rows.first().and_then(|r| r.get(*k))));
    let simkl = !provider_off(ctx, "simkl")
        && truthy(field("simklAccessToken"))
        && !off("mediaActionsSimklEnabled");
    Ok(trakt || anilist || jellyfin || simkl)
}

/// The signed-in user (any user may act on their own providers).
fn user_id(ctx: &Ready<'_>) -> Result<i64, super::Fallback> {
    Ok(ctx.authenticated(0)?.id)
}

fn object(pairs: Vec<(&str, Value)>) -> Value {
    let mut out = Map::new();
    for (k, v) in pairs {
        out.insert(k.to_owned(), v);
    }
    Value::Object(out)
}

/// `GET /media-actions/capabilities`.
fn capabilities<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let user = try_forward!(user_id(ctx));
        try_forward!(node_answers(ctx, user).await);
        let env = env(ctx, user);
        match capability_body(&env).await {
            Ok(body) => ctx.json(&body),
            Err(e) => action_error(ctx, &e, "Unable to retrieve media action capabilities."),
        }
    })
}

/// `getMediaActionCapabilities(userId)`.
async fn capability_body(env: &Env<'_>) -> Result<Value, Thrown> {
    let linked = [
        trakt::available(env).await?,
        jellyfin::available(env).await?,
        anilist::available(env).await?,
        simkl::available(env).await?,
    ];
    let episode = trakt::available(env).await?
        || jellyfin::episode_available(env).await?
        || anilist::available(env).await?;
    let caps = [FULL, WATCHED_ONLY, FULL, FULL];
    let ids = [
        ProviderId::Trakt,
        ProviderId::Jellyfin,
        ProviderId::Anilist,
        ProviderId::Simkl,
    ];
    let any = |pick: fn(&crate::mediaactions::types::Capabilities) -> bool| {
        linked.iter().zip(caps.iter()).any(|(l, c)| *l && pick(c))
    };
    let watched = any(|c| c.watched);
    let rating = any(|c| c.rating);
    let surface = || {
        object(vec![
            ("watched", Value::Bool(watched)),
            ("rating", Value::Bool(rating)),
        ])
    };
    let providers = ids
        .iter()
        .zip(linked.iter().zip(caps.iter()))
        .map(|(id, (linked, caps))| {
            object(vec![
                ("id", Value::from(id.as_str())),
                ("linked", Value::Bool(*linked)),
                ("capabilities", caps.to_json()),
            ])
        })
        .collect();
    Ok(object(vec![
        ("movie", surface()),
        ("tv", surface()),
        (
            "episode",
            object(vec![
                ("watched", Value::Bool(episode)),
                ("rating", Value::Bool(false)),
            ]),
        ),
        ("providers", Value::Array(providers)),
    ]))
}

/// `parseTmdbId` of a path segment: a positive integer, or `None` (the
/// handler's 400).
fn tmdb_id(raw: &str) -> Option<i64> {
    crate::jsval::decode_uri_component(raw)
        .as_deref()
        .and_then(super::params::integer)
        .filter(|n| *n > 0)
}

/// The media type and id of a per-title route.
fn title(ctx: &Ready<'_>) -> Result<Result<Item, ()>, String> {
    let mut parts = ctx.req.uri.path().rsplit('/');
    parts.next();
    let id = parts.next().unwrap_or("");
    let media_type = match parts.next() {
        Some("movie") => MediaType::Movie,
        Some("tv") => MediaType::Tv,
        _ => return Err(String::from("an unexpected path")),
    };
    Ok(tmdb_id(id).map_or(Err(()), |tmdb_id| {
        Ok(Item {
            media_type,
            tmdb_id,
        })
    }))
}

/// `GET /media-actions/{mediaType}/{tmdbId}/status`.
fn status<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let user = try_forward!(user_id(ctx));
        let Ok(item) = try_forward!(title(ctx)) else {
            return ctx.error(400, "tmdbId must be a positive number");
        };
        try_forward!(node_answers(ctx, user).await);
        let env = env(ctx, user);
        let result = dispatcher(&env).status(item).await;
        match result {
            Ok(result) => ctx.json(&result.to_json(None)),
            Err(e) => action_error(ctx, &e, "Unable to retrieve media action status."),
        }
    })
}

/// A `ratingStars` body value the validator lets through.
fn rating_stars(v: Option<&Value>, required: bool) -> Result<Option<f64>, String> {
    match v {
        None if !required => Ok(None),
        Some(n) if n.as_f64().is_some_and(|f| (0.5..=5.0).contains(&f)) => Ok(n.as_f64()),
        _ => Err(String::from("ratingStars the validator judges")),
    }
}

/// The body as an object (none reads as an empty one, as `req.body?.x`).
fn body(ctx: &Ready<'_>) -> Result<Map<String, Value>, String> {
    match &ctx.body {
        None => Ok(Map::new()),
        Some(Value::Object(map)) => Ok(map.clone()),
        Some(_) => Err(String::from("a body that isn't an object")),
    }
}

/// `respondWrite(res, result)`.
fn respond_write(ctx: &Ready<'_>, result: &Aggregate) -> Outcome {
    let outcome = result.outcome();
    ctx.json_with(outcome.http_status(), &result.to_json(Some(outcome)))
}

/// The shared head and tail of the title writes.
async fn title_write(ctx: &Ready<'_>, write: Write, fallback: &str) -> Outcome {
    try_forward!(ctx.no_query());
    let user = try_forward!(user_id(ctx));
    let Ok(item) = try_forward!(title(ctx)) else {
        return ctx.error(400, "tmdbId must be a positive number");
    };
    try_forward!(node_answers(ctx, user).await);
    let env = env(ctx, user);
    let result = dispatcher(&env).write(item, write).await;
    match result {
        Ok(result) => respond_write(ctx, &result),
        Err(e) => action_error(ctx, &e, fallback),
    }
}

/// `POST /media-actions/{mediaType}/{tmdbId}/watched`.
fn watched<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let b = try_forward!(body(ctx));
        let at_release = match b.get("watchedAt") {
            None => false,
            Some(Value::String(s)) if s == "now" || s == "release" => s == "release",
            Some(_) => return Outcome::forward(String::from("watchedAt the validator judges")),
        };
        let stars = try_forward!(rating_stars(b.get("ratingStars"), false));
        let write = Write::Mark(MarkOptions {
            at_release,
            rating_stars: stars,
        });
        title_write(ctx, write, "Unable to mark media as watched.").await
    })
}

/// `POST /media-actions/{mediaType}/{tmdbId}/unwatched`.
fn unwatched<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let b = try_forward!(body(ctx));
        let remove_rating = match b.get("removeRating") {
            None => false,
            Some(Value::Bool(v)) => *v,
            Some(_) => return Outcome::forward(String::from("removeRating the validator judges")),
        };
        title_write(
            ctx,
            Write::Unmark { remove_rating },
            "Unable to mark media as unwatched.",
        )
        .await
    })
}

/// `POST /media-actions/{mediaType}/{tmdbId}/rate`.
fn rate<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let b = try_forward!(body(ctx));
        let Some(stars) = try_forward!(rating_stars(b.get("ratingStars"), true)) else {
            return Outcome::forward(String::from("ratingStars the validator judges"));
        };
        title_write(ctx, Write::Rate(stars), "Unable to rate media.").await
    })
}

/// One `status-batch` item: `Err` for the validator, `Ok(None)` for the
/// handler's 400.
fn batch_item(entry: &Value) -> Result<Option<Item>, String> {
    let media_type = match entry.get("mediaType").and_then(Value::as_str) {
        Some("movie") => MediaType::Movie,
        Some("tv") => MediaType::Tv,
        _ => return Err(String::from("an item the validator judges")),
    };
    let Some(n) = entry.get("tmdbId").and_then(Value::as_i64) else {
        return Err(String::from("tmdbId must be an integer"));
    };
    if n <= 0 {
        return Ok(None);
    }
    Ok(Some(Item {
        media_type,
        tmdb_id: n,
    }))
}

/// `POST /media-actions/status-batch`.
fn status_batch<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let user = try_forward!(user_id(ctx));
        let b = try_forward!(body(ctx));
        let Some(items) = b.get("items").and_then(Value::as_array) else {
            return Outcome::forward(String::from("items the validator judges"));
        };
        if items.len() > 100 || items.iter().any(|i| !i.is_object()) {
            return Outcome::forward(String::from("items the validator judges"));
        }
        let checked: Vec<Option<Item>> = try_forward!(items.iter().map(batch_item).collect());
        let mut parsed: Vec<Item> = Vec::new();
        for item in checked {
            let Some(item) = item else {
                return ctx.error(400, "each item requires mediaType (movie|tv) and tmdbId");
            };
            if !parsed.contains(&item) {
                parsed.push(item);
            }
        }
        if !parsed.is_empty() {
            try_forward!(node_answers(ctx, user).await);
        }
        let env = env(ctx, user);
        let results = dispatcher(&env).statuses(&parsed).await;
        match results {
            Ok(results) => ctx.json(&object(vec![(
                "results",
                Value::Array(results.iter().map(|r| r.to_json(None)).collect()),
            )])),
            Err(e) => action_error(ctx, &e, "Unable to retrieve media action statuses."),
        }
    })
}

/// The episode path: tmdb id, season and (for writes) episode, as the
/// validator and then zod read them. `Ok(None)` is the handler's 400.
fn episode_path(ctx: &Ready<'_>, with_episode: bool) -> Result<Option<(i64, i64, i64)>, String> {
    let segments: Vec<&str> = ctx.req.uri.path().split('/').collect();
    // /api/v1/media-actions/tv/{tmdbId}/seasons/{season}/episodes[/{episode}]/...
    // `z.coerce.number().int()` with its bounds, on Express's params.
    let number = |i: usize| -> Result<f64, String> {
        segments
            .get(i)
            .and_then(|s| crate::jsval::decode_uri_component(s))
            .map(|s| crate::jsval::number_of_str(&s))
            .ok_or_else(|| String::from("a path segment that doesn't decode"))
    };
    let within = |n: f64, low: f64, high: f64| crate::jsnum::is_integer(n) && n >= low && n <= high;
    let tmdb = number(5)?;
    let season = number(7)?;
    let episode = if with_episode { number(9)? } else { 0.0 };
    let valid = within(tmdb, 1.0, 2_147_483_647.0)
        && within(season, 0.0, 10_000.0)
        && (!with_episode || within(episode, 0.0, 10_000.0));
    if !valid {
        return Ok(None);
    }
    let int = |n: f64| crate::jsval::to_i64(n).ok_or_else(|| String::from("an odd number"));
    Ok(Some((int(tmdb)?, int(season)?, int(episode)?)))
}

/// One provider's `getSeasonStatus`.
type SeasonStatus = Result<(bool, Vec<f64>), Thrown>;

/// `GET /media-actions/tv/{tmdbId}/seasons/{seasonNumber}/episodes/status`.
fn episode_status<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let user = try_forward!(user_id(ctx));
        let Some((tmdb, season, _)) = try_forward!(episode_path(ctx, false)) else {
            return ctx.error(400, "Invalid episode identifiers.");
        };
        try_forward!(node_answers(ctx, user).await);
        let env = env(ctx, user);
        let env = &env;
        let jobs: Vec<Job<'_, SeasonStatus>> = vec![
            Box::pin(trakt::season_status(env, tmdb, season)),
            Box::pin(jellyfin::season_status(env, tmdb, season)),
            Box::pin(anilistepisodes::season_status(env, tmdb, season)),
            Box::pin(simklepisodes::season_status(env, tmdb, season)),
        ];
        let results = join_all(jobs).await;
        if results.iter().all(Result::is_err) {
            let first = results
                .into_iter()
                .find_map(Result::err)
                .unwrap_or_default();
            return action_error(ctx, &first, "Unable to retrieve episode watch status.");
        }
        let names = ["trakt", "jellyfin", "anilist", "simkl"];
        let mut available = false;
        let mut all: Vec<f64> = Vec::new();
        for (name, result) in names.iter().zip(results) {
            match result {
                Ok((ok, episodes)) => {
                    available |= ok;
                    for episode in episodes {
                        if !all.contains(&episode) {
                            all.push(episode);
                        }
                    }
                }
                Err(e) => tracing::warn!(
                    label = "Media Actions",
                    provider = name,
                    tmdb_id = tmdb,
                    season_number = season,
                    error_message = e,
                    "Episode watch status provider failed"
                ),
            }
        }
        all.sort_by(f64::total_cmp);
        ctx.json(&object(vec![
            ("available", Value::Bool(available)),
            (
                "watchedEpisodeNumbers",
                Value::Array(all.into_iter().map(crate::jsval::num).collect()),
            ),
        ]))
    })
}

/// Whether the path ends in `/watched` (rather than `/unwatched`).
fn marks_watched(ctx: &Ready<'_>) -> bool {
    ctx.req.uri.path().ends_with("/watched")
}

/// `jellyfinItemIdSchema.safeParse(value)`: the trimmed id of 1–255
/// UTF-16 units.
fn jellyfin_item_id(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    let trimmed = super::nodestate::js_trim(text);
    (1..=255)
        .contains(&trimmed.encode_utf16().count())
        .then(|| trimmed.to_owned())
}

/// The availability of each episode provider, in route order.
async fn episode_availability(env: &Env<'_>) -> Result<[bool; 4], Thrown> {
    let jobs: Vec<Job<'_, Result<bool, Thrown>>> = vec![
        Box::pin(trakt::available(env)),
        Box::pin(jellyfin::episode_available(env)),
        Box::pin(anilist::available(env)),
        Box::pin(simkl::available(env)),
    ];
    let mut out = [false; 4];
    for (slot, result) in out.iter_mut().zip(join_all(jobs).await) {
        *slot = result?;
    }
    Ok(out)
}

/// One provider's episode write.
type EpisodeResult = Result<EpisodeWrite, Thrown>;

/// `POST /media-actions/tv/{tmdbId}/seasons/{n}/episodes/{e}/watched` and
/// `/unwatched`.
fn episode_watched<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let user = try_forward!(user_id(ctx));
        let b = try_forward!(body(ctx));
        let Some((tmdb, season, episode)) = try_forward!(episode_path(ctx, true)) else {
            return ctx.error(400, "Invalid episode identifiers.");
        };
        try_forward!(node_answers(ctx, user).await);
        let watched = marks_watched(ctx);
        let fallback = if watched {
            "Unable to mark episode as watched."
        } else {
            "Unable to mark episode as unwatched."
        };
        let env = env(ctx, user);
        let env = &env;
        let [trakt_on, jellyfin_on, anilist_on, simkl_on] = match episode_availability(env).await {
            Ok(flags) => flags,
            Err(e) => return action_error(ctx, &e, fallback),
        };
        let direct = jellyfin_item_id(b.get("jellyfinItemId"));
        let mut jobs: Vec<Job<'_, (ProviderId, EpisodeResult)>> = Vec::new();
        if trakt_on {
            jobs.push(Box::pin(async move {
                (
                    ProviderId::Trakt,
                    trakt::set_episode_watched(env, tmdb, season, episode, watched).await,
                )
            }));
        }
        if jellyfin_on {
            let direct = direct.clone();
            jobs.push(Box::pin(async move {
                let result = match direct {
                    Some(id) => jellyfin::set_item_watched(env, &id, watched)
                        .await
                        .map(EpisodeWrite::Done),
                    None => {
                        jellyfin::set_episode_watched(env, tmdb, season, episode, watched).await
                    }
                };
                (ProviderId::Jellyfin, result)
            }));
        }
        if anilist_on {
            jobs.push(Box::pin(async move {
                (
                    ProviderId::Anilist,
                    anilistepisodes::set_watched(env, tmdb, season, episode, watched).await,
                )
            }));
        }
        if simkl_on {
            jobs.push(Box::pin(async move {
                (
                    ProviderId::Simkl,
                    simklepisodes::set_watched(env, tmdb, season, episode, watched).await,
                )
            }));
        }
        let providers: Vec<ProviderResult> = join_all(jobs)
            .await
            .into_iter()
            .filter_map(|(id, result)| episode_write_result(id, watched, result))
            .collect();
        respond_write(ctx, &episode_write_aggregate(tmdb, watched, providers))
    })
}

/// `POST /media-actions/episodes/jellyfin/{jellyfinItemId}/watched` and
/// `/unwatched`.
fn jellyfin_item_watched<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        let user = try_forward!(user_id(ctx));
        let raw = ctx.req.uri.path().rsplit('/').nth(1).unwrap_or("");
        let Some(decoded) = super::nodestate::decode_segment(raw) else {
            return Outcome::forward(String::from("an item id Express can't decode"));
        };
        let Some(item) = jellyfin_item_id(Some(&Value::String(decoded))) else {
            return ctx.error(400, "Invalid Jellyfin item identifier.");
        };
        try_forward!(node_answers(ctx, user).await);
        let watched = marks_watched(ctx);
        let fallback = if watched {
            "Unable to mark Jellyfin episode as watched."
        } else {
            "Unable to mark Jellyfin episode as unwatched."
        };
        let env = env(ctx, user);
        let outcome: Result<Vec<ProviderResult>, Thrown> = async {
            if !jellyfin::episode_available(&env).await? {
                return Ok(Vec::new());
            }
            let ok = jellyfin::set_item_watched(&env, &item, watched).await?;
            Ok(vec![ProviderResult {
                provider: ProviderId::Jellyfin,
                ok,
                status: Status {
                    watched: if ok { watched } else { !watched },
                    error: (!ok).then(|| String::from("Jellyfin episode item is unavailable")),
                    ..Status::default()
                },
            }])
        }
        .await;
        match outcome {
            Ok(providers) => respond_write(ctx, &episode_write_aggregate(0, watched, providers)),
            Err(e) => action_error(ctx, &e, fallback),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parsing() {
        assert_eq!(tmdb_id("550"), Some(550), "plain");
        assert_eq!(tmdb_id("%35%35%30"), Some(550), "decoded");
        assert_eq!(tmdb_id("0"), None, "zero is the handler's 400");
        assert_eq!(tmdb_id("-3"), None, "negative");
        for odd in [
            "1.5",
            "abc",
            "1e3",
            "0x10",
            "%20",
            "Infinity",
            "99999999999999999999",
        ] {
            assert_eq!(tmdb_id(odd), None, "{odd} is the handler's 400");
        }
        assert_eq!(
            batch_item(&json!({"mediaType": "tv", "tmdbId": 1399})),
            Ok(Some(Item {
                media_type: MediaType::Tv,
                tmdb_id: 1399
            })),
            "batch item"
        );
        assert_eq!(
            batch_item(&json!({"mediaType": "tv", "tmdbId": 0})),
            Ok(None),
            "zero"
        );
        assert!(
            batch_item(&json!({"mediaType": "book", "tmdbId": 1})).is_err(),
            "enum"
        );
        assert_eq!(
            jellyfin_item_id(Some(&json!("  abc "))),
            Some(String::from("abc")),
            "trimmed"
        );
        assert_eq!(jellyfin_item_id(Some(&json!("   "))), None, "blank");
        assert_eq!(jellyfin_item_id(Some(&json!(5))), None, "not text");
    }
}
