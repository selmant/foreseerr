//! `server/routes/mediaServarr.ts`, first half.
//!
//! The Radarr/Sonarr context of a mapped media item and the interactive
//! release search and grab. The manual import routes are in
//! `mediaimports`; both share the helpers here.
//!
//! Errors follow `routeError`: an error thrown with a status keeps it, an
//! Arr error answer passes its status and message through, anything else
//! is a 502. Before any token is issued or redeemed, a request whose Arr
//! call got no answer at all is handed to Node, so the message is Node's
//! own; later failures carry the closest message reqwest gives.

use std::future::Future;
use std::pin::Pin;

use axum::http::Method;
use serde_json::{Map, Value};

use super::arrcall::{ArrError, ArrServer};
use super::mediawrite::{load_media, timeout_ms, MANAGE_REQUESTS};
use super::servarrtokens::{self, Token};
use super::{Outcome, Ready, Table};
use crate::settings::public::truthy;

pub(super) type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// This module's and `mediaimports`'s routes.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/media/{id}/servarr/context", Method::GET, context),
    ("/api/v1/media/{id}/servarr/releases", Method::GET, releases),
    ("/api/v1/media/{id}/servarr/releases", Method::POST, grab),
    (
        "/api/v1/media/{id}/servarr/imports/sources",
        Method::GET,
        super::mediaimports::sources,
    ),
    (
        "/api/v1/media/{id}/servarr/imports/scan",
        Method::POST,
        super::mediaimports::scan,
    ),
    (
        "/api/v1/media/{id}/servarr/imports/reprocess",
        Method::POST,
        super::mediaimports::reprocess,
    ),
    (
        "/api/v1/media/{id}/servarr/imports",
        Method::GET,
        super::mediaimports::list,
    ),
    (
        "/api/v1/media/{id}/servarr/imports",
        Method::POST,
        super::mediaimports::import,
    ),
    (
        "/api/v1/media/{id}/servarr/commands/{token}",
        Method::GET,
        super::mediaimports::command,
    ),
];

/// Why a route stops.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Fail {
    /// An error thrown with a status.
    Status(u16, String),
    /// An Arr call failed.
    Arr(ArrError),
    /// Node has to answer.
    Forward(String),
}

pub(super) type Step<T> = Result<T, Fail>;

impl From<ArrError> for Fail {
    fn from(e: ArrError) -> Self {
        Self::Arr(e)
    }
}

/// The answer for a failure. A server that gave no answer is the route's
/// 502 with axios's message, as for any other `*arr` failure
/// (`_may_forward`, whether nothing was written yet, no longer matters).
pub(super) fn answer(ctx: &Ready<'_>, fail: Fail, _may_forward: bool) -> Outcome {
    match fail {
        Fail::Status(status, message) => ctx.error(status, &message),
        Fail::Forward(why) => Outcome::forward(why),
        Fail::Arr(e) => {
            let (status, message) = e.route_error(502);
            let mut body = Map::new();
            body.insert(String::from("message"), message);
            ctx.json_with(status, &Value::Object(body))
        }
    }
}

/// The resolved media item and its Arr.
#[derive(Debug, Clone)]
pub(super) struct Context {
    pub(super) media_id: i64,
    pub(super) is4k: bool,
    pub(super) radarr: bool,
    pub(super) external_id: i64,
    pub(super) service_id: i64,
    pub(super) service_name: Option<Value>,
    pub(super) native_url: Option<String>,
    pub(super) server: Value,
}

impl Context {
    pub(super) const fn service(&self) -> &'static str {
        if self.radarr {
            "radarr"
        } else {
            "sonarr"
        }
    }

    pub(super) fn arr<'a>(&'a self, ctx: &'a Ready<'_>) -> ArrServer<'a> {
        ArrServer {
            client: &ctx.state.outbound,
            server: &self.server,
            timeout_ms: timeout_ms(&ctx.settings),
            api_name: if self.radarr { "Radarr" } else { "Sonarr" },
        }
    }

    /// A token record for this context.
    pub(super) const fn token(&self, user_id: i64, kind: &'static str, value: Value) -> Token {
        Token {
            user_id,
            media_id: self.media_id,
            is4k: self.is4k,
            service: self.service(),
            external_id: self.external_id,
            kind,
            value,
            episode_id: None,
            season_number: None,
        }
    }

    /// `{ type, name }`.
    fn service_json(&self) -> Value {
        let mut out = Map::new();
        out.insert(String::from("type"), Value::from(self.service()));
        if let Some(name) = &self.service_name {
            out.insert(String::from("name"), name.clone());
        }
        Value::Object(out)
    }
}

/// `safeExternalUrl`: an `http(s)` external URL as `new URL(v).toString()`
/// prints it.
fn safe_external_url(value: Option<&Value>) -> Option<String> {
    let text = value.and_then(Value::as_str).filter(|s| !s.is_empty())?;
    let url = reqwest::Url::parse(text).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.to_string())
}

/// `resolveContext(mediaId, is4k)`.
pub(super) async fn resolve(ctx: &Ready<'_>, media_id: i64, is4k: bool) -> Step<Context> {
    let media = load_media(ctx, media_id)
        .await
        .map_err(Fail::Forward)?
        .ok_or_else(|| Fail::Status(404, String::from("Media does not exist.")))?;
    let (service_id, external_id) = if is4k {
        (media.service_id4k, media.external_service_id4k)
    } else {
        (media.service_id, media.external_service_id)
    };
    let (Some(service_id), Some(external_id)) = (service_id, external_id) else {
        return Err(Fail::Status(
            409,
            String::from("This media is not mapped to a Servarr instance."),
        ));
    };
    let radarr = media.media_type == "movie";
    let (section, name) = if radarr {
        ("/radarr", "Radarr")
    } else {
        ("/sonarr", "Sonarr")
    };
    let server = ctx
        .settings
        .get(section)
        .and_then(Value::as_array)
        .and_then(|list| {
            list.iter()
                .find(|s| s.get("id").and_then(Value::as_i64) == Some(service_id))
        })
        .cloned()
        .ok_or_else(|| {
            Fail::Status(
                409,
                format!("The mapped {name} instance is no longer configured."),
            )
        })?;
    Ok(Context {
        media_id: media.id,
        is4k,
        radarr,
        external_id,
        service_id,
        service_name: server.get("name").cloned(),
        native_url: safe_external_url(server.get("externalUrl")),
        server,
    })
}

/// `getToken(token, context, userId, kind)`.
pub(super) fn redeem(token: &str, c: &Context, user_id: i64, kind: &str) -> Step<Token> {
    servarrtokens::get(token)
        .filter(|t| {
            t.user_id == user_id
                && t.media_id == c.media_id
                && t.is4k == c.is4k
                && t.service == c.service()
                && t.external_id == c.external_id
                && t.kind == kind
        })
        .ok_or_else(|| {
            Fail::Status(
                409,
                String::from("This operation has expired. Refresh and try again."),
            )
        })
}

/// The query keys a route accepts, decoded; repeated, unknown or
/// undecodable ones are the validator's.
pub(super) fn query(ctx: &Ready<'_>, allowed: &[&str]) -> Result<Vec<(String, String)>, String> {
    let mut out: Vec<(String, String)> = Vec::new();
    for pair in ctx
        .req
        .uri
        .query()
        .unwrap_or("")
        .split('&')
        .filter(|p| !p.is_empty())
    {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if !allowed.contains(&key) || out.iter().any(|(k, _)| k == key) {
            return Err(String::from("a query the validator judges"));
        }
        let value = super::user::decode_query_value(value)
            .ok_or_else(|| String::from("a query value the validator judges"))?;
        out.push((key.to_owned(), value));
    }
    Ok(out)
}

pub(super) fn query_value<'a>(q: &'a [(String, String)], key: &str) -> Option<&'a str> {
    q.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

/// `parseIs4k(req.query.is4k)` after the validator's boolean coercion.
pub(super) fn query_is4k(q: &[(String, String)]) -> Result<bool, String> {
    match query_value(q, "is4k") {
        None | Some("false") => Ok(false),
        Some("true") => Ok(true),
        Some(_) => Err(String::from("is4k isn't a boolean")),
    }
}

/// The body as an object.
pub(super) fn body<'a>(ctx: &'a Ready<'_>) -> Result<&'a Map<String, Value>, String> {
    match &ctx.body {
        Some(Value::Object(map)) => Ok(map),
        _ => Err(String::from("a body that isn't an object")),
    }
}

/// A boolean body field as the validator lets it through.
pub(super) fn body_flag(body: &Map<String, Value>, key: &str) -> Result<bool, String> {
    match body.get(key) {
        None => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(format!("{key} isn't a boolean")),
    }
}

/// A required string body field.
pub(super) fn body_text<'a>(body: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    body.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{key} isn't a string; the validator decides"))
}

/// `a?.b?.c`: `None` (undefined) as soon as a step isn't an object.
pub(super) fn chain(value: &Value, keys: &[&str]) -> Option<Value> {
    let mut current = value;
    for key in keys {
        current = current.as_object()?.get(*key)?;
    }
    Some(current.clone())
}

/// `a || b`.
pub(super) fn js_or(a: Option<&Value>, b: Option<&Value>) -> Option<Value> {
    if truthy(a) {
        a.cloned()
    } else {
        b.cloned()
    }
}

/// `v ?? []`.
pub(super) fn or_empty_list(v: Option<&Value>) -> Value {
    match v {
        None | Some(Value::Null) => Value::Array(Vec::new()),
        Some(other) => other.clone(),
    }
}

/// Insert unless `undefined`.
pub(super) fn put(out: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        out.insert(key.to_owned(), value);
    }
}

/// `episodeQueueStatus(item)`; `Err` where the call would throw.
fn episode_queue_status(item: &Value) -> Result<Option<&'static str>, ()> {
    let status = match item.get("status") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.to_lowercase()),
        Some(_) => return Err(()),
    };
    let warning = item.get("trackedDownloadStatus") == Some(&Value::from("warning"));
    Ok(match status.as_deref() {
        Some("completed") if warning => Some("manual-import"),
        Some("importing") => Some("importing"),
        Some("downloading") => Some("downloading"),
        Some("queued" | "paused" | "delay") => Some("queued"),
        _ => None,
    })
}

/// `GET /media/{id}/servarr/context`.
fn context<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = ctx.authenticated(MANAGE_REQUESTS) {
            return Outcome::forward(why);
        }
        let q = match query(ctx, &["is4k"]) {
            Ok(q) => q,
            Err(why) => return Outcome::forward(why),
        };
        let (id, is4k) = match (ctx.path_id(2), query_is4k(&q)) {
            (Ok(id), Ok(is4k)) => (id, is4k),
            (Err(why), _) => return Outcome::forward(why),
            (_, Err(why)) => return Outcome::forward(why),
        };
        match context_json(ctx, id, is4k).await {
            Ok(body) => ctx.json(&body),
            Err(fail) => answer(ctx, fail, true),
        }
    })
}

async fn context_json(ctx: &Ready<'_>, id: i64, is4k: bool) -> Step<Value> {
    let c = resolve(ctx, id, is4k).await?;
    let mut out = Map::new();
    out.insert(String::from("mediaId"), Value::from(c.media_id));
    out.insert(
        String::from("mediaType"),
        Value::from(if c.radarr { "movie" } else { "tv" }),
    );
    out.insert(String::from("is4k"), Value::Bool(c.is4k));
    out.insert(String::from("service"), c.service_json());
    put(&mut out, "nativeUrl", c.native_url.clone().map(Value::from));
    if c.radarr {
        return Ok(Value::Object(out));
    }
    let arr = c.arr(ctx);
    let series_path = format!("/series/{}", c.external_id);
    let (series, episodes, queue) = tokio::join!(
        arr.get(&series_path, &[]),
        arr.episodes(c.external_id),
        arr.queue()
    );
    let series = series.map_err(|e| e.wrapped("[Sonarr] Failed to retrieve series by ID: "))?;
    let episodes = episodes?;
    let queue = queue?;
    let odd = || Fail::Forward(String::from("a Sonarr shape the handler would trip over"));
    if queue.iter().any(Value::is_null) {
        return Err(odd());
    }
    let queue: Vec<Value> = queue
        .into_iter()
        .filter(|item| item.get("seriesId").and_then(Value::as_i64) == Some(c.external_id))
        .collect();
    let mut status_by_episode: Vec<(Value, Option<&'static str>)> = Vec::new();
    for item in &queue {
        // Sonarr 5 lists a multi-episode download once with all episodes.
        for episode in crate::sonarrv5::queue_item_episodes(item) {
            let Some(episode_id) = episode.get("id").filter(|v| truthy(Some(v))) else {
                continue;
            };
            let status = episode_queue_status(item).map_err(|()| odd())?;
            status_by_episode.retain(|(k, _)| k != episode_id);
            status_by_episode.push((episode_id.clone(), status));
        }
    }
    let Some(seasons) = series.get("seasons").and_then(Value::as_array) else {
        return Err(odd());
    };
    if episodes.iter().any(|e| !e.is_object()) || seasons.iter().any(|s| !s.is_object()) {
        return Err(odd());
    }
    let seasons: Vec<Value> = seasons
        .iter()
        .map(|season| {
            let number = season.get("seasonNumber");
            let list: Vec<Value> = episodes
                .iter()
                .filter(|e| e.get("seasonNumber") == number)
                .map(|e| {
                    let mut e = e.as_object().cloned().unwrap_or_default();
                    let status = e.get("id").and_then(|id| {
                        status_by_episode
                            .iter()
                            .find(|(k, _)| k == id)
                            .and_then(|(_, s)| *s)
                    });
                    match status {
                        Some(s) => {
                            e.insert(String::from("queueStatus"), Value::from(s));
                        }
                        None => {
                            e.shift_remove("queueStatus");
                        }
                    }
                    Value::Object(e)
                })
                .collect();
            let mut s = season.as_object().cloned().unwrap_or_default();
            s.insert(String::from("episodes"), Value::Array(list));
            Value::Object(s)
        })
        .collect();
    out.insert(String::from("seasons"), Value::Array(seasons));
    Ok(Value::Object(out))
}

/// One release as the search answers it, with its token.
fn release_json(token: String, release: &Value) -> Value {
    let mut out = Map::new();
    out.insert(String::from("token"), Value::from(token));
    put(&mut out, "title", release.get("title").cloned());
    put(
        &mut out,
        "quality",
        chain(release, &["quality", "quality", "name"]),
    );
    for key in ["size", "ageHours", "indexer", "protocol", "seeders"] {
        put(&mut out, key, release.get(key).cloned());
    }
    out.insert(
        String::from("rejections"),
        or_empty_list(release.get("rejections")),
    );
    put(
        &mut out,
        "rejected",
        js_or(release.get("rejected"), release.get("temporarilyRejected")),
    );
    put(
        &mut out,
        "downloadAllowed",
        release.get("downloadAllowed").cloned(),
    );
    put(&mut out, "rejectionDetails", rejection_details(release));
    put(&mut out, "history", release_history(release));
    if truthy(release.get("multiSeason")) {
        out.insert(String::from("multiSeason"), Value::Bool(true));
        put(
            &mut out,
            "seasonNumbers",
            release
                .get("seasonNumbers")
                .filter(|v| v.is_array())
                .cloned(),
        );
    }
    Value::Object(out)
}

/// Sonarr 5's typed rejections (`{ message, code, type }`), text fields
/// only; `None` on Sonarr 4 and Radarr, which send only the messages.
fn rejection_details(release: &Value) -> Option<Value> {
    let list: Vec<Value> = release
        .get("rejectionDetails")?
        .as_array()?
        .iter()
        .filter_map(|detail| {
            let detail = detail.as_object()?;
            let mut out = Map::new();
            for key in ["message", "code", "type"] {
                if let Some(text) = detail.get(key).filter(|v| v.is_string()) {
                    out.insert(key.to_owned(), text.clone());
                }
            }
            out.contains_key("message").then_some(Value::Object(out))
        })
        .collect();
    (!list.is_empty()).then_some(Value::Array(list))
}

/// Sonarr 5's history of the release: when it was grabbed before and when
/// that download failed.
fn release_history(release: &Value) -> Option<Value> {
    let history = release.get("history")?.as_object()?;
    let mut out = Map::new();
    for key in ["grabbed", "failed"] {
        if let Some(at) = history.get(key).filter(|v| v.is_string()) {
            out.insert(key.to_owned(), at.clone());
        }
    }
    (!out.is_empty()).then_some(Value::Object(out))
}


/// The search target of `GET /releases` for a series.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Target {
    Episode(i64),
    Season(i64),
    Missing,
}

fn release_target(q: &[(String, String)]) -> Result<Target, String> {
    let int = |key: &str| -> Result<Option<i64>, String> {
        query_value(q, key).map_or(Ok(None), |v| {
            super::blocklist::plain_integer(v)
                .map(Some)
                .ok_or_else(|| format!("{key} isn't a plain integer"))
        })
    };
    let episode = int("episodeId")?;
    let season = int("seasonNumber")?;
    Ok(match (query_value(q, "target"), episode, season) {
        (Some("episode"), Some(id), _) => Target::Episode(id),
        (Some("season"), _, Some(n)) => Target::Season(n),
        (None | Some("episode" | "season"), _, _) => Target::Missing,
        (Some(_), _, _) => return Err(String::from("target outside the enum")),
    })
}

/// `GET /media/{id}/servarr/releases`.
fn releases<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user_id = match ctx.authenticated(MANAGE_REQUESTS) {
            Ok(user) => user.id,
            Err(why) => return Outcome::forward(why),
        };
        let parsed = query(ctx, &["is4k", "target", "episodeId", "seasonNumber"])
            .map_err(super::Fallback::from)
            .and_then(|q| Ok((ctx.path_id(2)?, query_is4k(&q)?, release_target(&q)?)));
        let (id, is4k, target) = match parsed {
            Ok(p) => p,
            Err(why) => return Outcome::forward(why),
        };
        match search(ctx, id, is4k, target, user_id).await {
            Ok(body) => ctx.json(&body),
            Err(fail) => answer(ctx, fail, true),
        }
    })
}

async fn search(ctx: &Ready<'_>, id: i64, is4k: bool, target: Target, user_id: i64) -> Step<Value> {
    let c = resolve(ctx, id, is4k).await?;
    let arr = c.arr(ctx);
    let timeout = arr.release_search_timeout();
    let (path_query, episode_id, season_number) = if c.radarr {
        (vec![("movieId", c.external_id.to_string())], None, None)
    } else {
        match target {
            Target::Episode(episode_id) => {
                let episodes = arr.episodes(c.external_id).await?;
                if !episodes
                    .iter()
                    .any(|e| e.get("id").and_then(Value::as_i64) == Some(episode_id))
                {
                    return Err(Fail::Status(
                        400,
                        String::from("Episode does not belong to this series."),
                    ));
                }
                (
                    vec![("episodeId", episode_id.to_string())],
                    Some(episode_id),
                    None,
                )
            }
            Target::Season(n) => (
                vec![
                    ("seriesId", c.external_id.to_string()),
                    ("seasonNumber", n.to_string()),
                ],
                None,
                Some(n),
            ),
            Target::Missing => {
                return Err(Fail::Status(
                    400,
                    String::from("Select an episode or season to search."),
                ))
            }
        }
    };
    let found = arr
        .request(Method::GET, "/release", &path_query, None, timeout)
        .await?;
    let Some(list) = found.as_array().filter(|l| l.iter().all(Value::is_object)) else {
        return Err(Fail::Forward(String::from(
            "a release list the handler would trip over",
        )));
    };
    let results: Vec<Value> = list
        .iter()
        .map(|release| {
            let mut token = c.token(user_id, "release", release.clone());
            token.episode_id = episode_id;
            token.season_number = season_number;
            release_json(servarrtokens::issue(token, 1500), release)
        })
        .collect();
    let mut out = Map::new();
    out.insert(String::from("results"), Value::Array(results));
    Ok(Value::Object(out))
}

/// `releaseGrabRequest` folded into `grabRelease`'s body.
fn grab_body(
    release: &Value,
    radarr: bool,
    external_id: i64,
    episode_ids: Option<&[Value]>,
    acknowledge: bool,
) -> Value {
    let mut body = Map::new();
    put(&mut body, "guid", release.get("guid").cloned());
    put(&mut body, "indexerId", release.get("indexerId").cloned());
    body.insert(
        String::from(if radarr { "movieId" } else { "seriesId" }),
        Value::from(external_id),
    );
    let from_release = || match release.get("mappedEpisodeInfo") {
        Some(Value::Array(info)) => Some(
            info.iter()
                .map(|e| e.get("id").cloned().unwrap_or(Value::Null))
                .collect(),
        ),
        None | Some(Value::Null) => match release.get("episodeIds") {
            Some(Value::Array(ids)) => Some(ids.clone()),
            None | Some(Value::Null) => match release.get("episodeId") {
                None | Some(Value::Null) => None,
                Some(id) => Some(vec![id.clone()]),
            },
            Some(_) => None,
        },
        Some(_) => None,
    };
    let ids: Option<Vec<Value>> = episode_ids
        .filter(|ids| !ids.is_empty())
        .map_or_else(from_release, |ids| Some(ids.to_vec()));
    let has_ids = ids.as_ref().is_some_and(|ids| !ids.is_empty());
    if acknowledge
        && truthy(release.get("quality"))
        && truthy(release.get("languages"))
        && (radarr || has_ids)
    {
        if !radarr && has_ids {
            body.insert(
                String::from("episodeIds"),
                Value::Array(ids.unwrap_or_default()),
            );
        }
        body.insert(String::from("shouldOverride"), Value::Bool(true));
        put(&mut body, "quality", release.get("quality").cloned());
        put(&mut body, "languages", release.get("languages").cloned());
    }
    Value::Object(body)
}

/// `POST /media/{id}/servarr/releases`.
fn grab<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user_id = match ctx
            .no_query()
            .and_then(|()| ctx.authenticated(MANAGE_REQUESTS))
        {
            Ok(user) => user.id,
            Err(why) => return Outcome::forward(why),
        };
        let parsed = body(ctx).map_err(super::Fallback::from).and_then(|b| {
            Ok((
                ctx.path_id(2)?,
                body_text(b, "token")?.to_owned(),
                body_flag(b, "is4k")?,
                body_flag(b, "acknowledgeRejections")?,
            ))
        });
        let (id, token, is4k, acknowledge) = match parsed {
            Ok(p) => p,
            Err(why) => return Outcome::forward(why),
        };
        match grab_release(ctx, id, &token, is4k, acknowledge, user_id).await {
            Ok(()) => {
                let mut out = Map::new();
                out.insert(String::from("accepted"), Value::Bool(true));
                ctx.json(&Value::Object(out))
            }
            Err(fail) => answer(ctx, fail, false),
        }
    })
}

async fn grab_release(
    ctx: &Ready<'_>,
    id: i64,
    token: &str,
    is4k: bool,
    acknowledge: bool,
    user_id: i64,
) -> Step<()> {
    let c = resolve(ctx, id, is4k).await?;
    let record = redeem(token, &c, user_id, "release")?;
    let release = &record.value;
    let rejected = truthy(release.get("rejected")) || truthy(release.get("temporarilyRejected"));
    if !(truthy(release.get("downloadAllowed")) || rejected) {
        return Err(Fail::Status(
            409,
            String::from("This release cannot be downloaded by the configured client."),
        ));
    }
    if rejected && !acknowledge {
        return Err(Fail::Status(
            409,
            String::from("Confirm the release rejection warnings before grabbing."),
        ));
    }
    let arr = c.arr(ctx);
    let mut episode_ids: Option<Vec<Value>> = None;
    if !c.radarr && acknowledge {
        if let Some(episode_id) = record.episode_id {
            episode_ids = Some(vec![Value::from(episode_id)]);
        } else {
            let season = record.season_number.map(Value::from).or_else(|| {
                release
                    .get("seasonNumber")
                    .filter(|v| !v.is_null())
                    .cloned()
            });
            let episodes = arr.episodes(c.external_id).await?;
            episode_ids = Some(
                episodes
                    .iter()
                    .filter(|e| {
                        season.as_ref().map_or_else(
                            || {
                                e.get("seasonNumber")
                                    .and_then(Value::as_f64)
                                    .is_some_and(|n| n > 0.0)
                            },
                            |n| e.get("seasonNumber") == Some(n),
                        )
                    })
                    .map(|e| e.get("id").cloned().unwrap_or(Value::Null))
                    .collect(),
            );
        }
    }
    let body = grab_body(
        release,
        c.radarr,
        c.external_id,
        episode_ids.as_deref(),
        acknowledge,
    );
    tracing::info!(
        "Grabbing Servarr release for media {}: {}",
        c.media_id,
        crate::media::js_string(release.get("title"))
    );
    if let Err(e) = arr
        .request(Method::POST, "/release", &[], Some(&body), arr.timeout_ms)
        .await
    {
        tracing::error!(
            "Servarr rejected the release grab for media {}: {}",
            c.media_id,
            e.message()
        );
        return Err(Fail::Arr(e));
    }
    servarrtokens::remove(token);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn grab_bodies() {
        let release = json!({
            "guid": "g", "indexerId": 4, "quality": {"quality": {"name": "HD"}},
            "languages": [{"id": 1}], "mappedEpisodeInfo": [{"id": 11}, {"id": 12}]
        });
        assert_eq!(
            grab_body(&release, false, 7, None, false),
            json!({"guid": "g", "indexerId": 4, "seriesId": 7}),
            "a plain grab"
        );
        assert_eq!(
            grab_body(&release, false, 7, Some(&[json!(3)]), true),
            json!({"guid": "g", "indexerId": 4, "seriesId": 7, "episodeIds": [3], "shouldOverride": true, "quality": {"quality": {"name": "HD"}}, "languages": [{"id": 1}]}),
            "a forced grab with the chosen episodes"
        );
        assert_eq!(
            grab_body(&release, false, 7, Some(&[]), true)
                .get("episodeIds")
                .cloned(),
            Some(json!([11, 12])),
            "the release's mapped episodes when none were chosen"
        );
        assert_eq!(
            grab_body(&json!({"guid": "g"}), true, 9, None, true),
            json!({"guid": "g", "movieId": 9}),
            "no quality, no override"
        );
    }

    #[test]
    fn release_details() {
        let release = json!({
            "title": "Show.S01-S02", "rejected": true, "multiSeason": true, "seasonNumbers": [1, 2],
            "rejections": ["Multi-season releases are not supported"],
            "rejectionDetails": [
                {"message": "Multi-season releases are not supported", "code": "multiSeason", "type": "permanent"},
                {"code": "noMessage"},
                {"message": "Blocklisted", "code": 3}
            ],
            "history": {"grabbed": "2026-10-30T10:00:00Z", "failed": null}
        });
        let out = release_json(String::from("tok"), &release);
        assert_eq!(
            out.get("rejectionDetails"),
            Some(&json!([
                {"message": "Multi-season releases are not supported", "code": "multiSeason", "type": "permanent"},
                {"message": "Blocklisted"}
            ])),
            "text fields of the typed rejections"
        );
        assert_eq!(
            out.get("history"),
            Some(&json!({"grabbed": "2026-10-30T10:00:00Z"})),
            "grabbed, never failed"
        );
        assert_eq!(out.get("multiSeason"), Some(&json!(true)));
        assert_eq!(out.get("seasonNumbers"), Some(&json!([1, 2])));
        let v4 = release_json(
            String::from("tok"),
            &json!({"title": "t", "rejections": ["x"], "seasonNumbers": [1, 2], "history": {}}),
        );
        assert_eq!(
            v4,
            json!({"token": "tok", "title": "t", "rejections": ["x"]}),
            "Sonarr 4: messages only"
        );
    }

    #[test]
    fn query_helpers() {
        let q = vec![
            (String::from("target"), String::from("episode")),
            (String::from("episodeId"), String::from("12")),
        ];
        assert_eq!(release_target(&q), Ok(Target::Episode(12)), "episode");
        let q = vec![(String::from("target"), String::from("episode"))];
        assert_eq!(release_target(&q), Ok(Target::Missing), "no episode id");
        let q = vec![(String::from("target"), String::from("x"))];
        assert!(release_target(&q).is_err(), "enum");
        assert_eq!(
            safe_external_url(Some(&json!("http://Radarr.example:7878"))),
            Some(String::from("http://radarr.example:7878/")),
            "normalised"
        );
        assert_eq!(safe_external_url(Some(&json!("ftp://x"))), None, "not http");
        let item = json!({"status": "Completed", "trackedDownloadStatus": "warning"});
        assert_eq!(
            episode_queue_status(&item),
            Ok(Some("manual-import")),
            "manual import"
        );
        let release = json!({"title": "t", "rejected": false});
        let out = release_json(String::from("tok"), &release);
        assert_eq!(
            out,
            json!({"token": "tok", "title": "t", "rejections": []}),
            "false || undefined is undefined"
        );
    }
}
