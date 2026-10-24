//! `GET /request`, `GET /request/count` and `GET /request/{id}`.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

use serde_json::{Map, Value};
use tokio::task::JoinSet;

use super::blocklist::plain_integer;
use super::related::Related;
use super::{Outcome, Ready};
use crate::db::{EpisodeRequestRow, RequestListQuery, RequestRow, RequestSort, SeasonRequestRow};
use crate::servarr::api_timeout;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// `Permission.MANAGE_REQUESTS` and `REQUEST_VIEW`.
const MANAGE_REQUESTS: i64 = 16;
const REQUEST_VIEW: i64 = 16384;

/// `MediaRequestStatus`.
const PENDING: i64 = 1;
const APPROVED: i64 = 2;
const DECLINED: i64 = 3;
const FAILED: i64 = 4;
const COMPLETED: i64 = 5;

/// `MediaStatus` values the `filter` parameter maps to.
const MEDIA_UNKNOWN: i64 = 1;
const MEDIA_PENDING: i64 = 2;
const MEDIA_PROCESSING: i64 = 3;
const MEDIA_PARTIALLY_AVAILABLE: i64 = 4;
const MEDIA_AVAILABLE: i64 = 5;
const MEDIA_DELETED: i64 = 7;

/// The quality profiles of one configured server, or none when the call
/// failed (`serviceErrors` lists those).
pub(super) struct ServerProfiles {
    server: Value,
    profiles: Option<Vec<Value>>,
}

/// `GET /request`: one page of requests with their media, users and the
/// quality profile names from every Radarr and Sonarr server.
pub(super) fn list<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user = match ctx.require(0) {
            Ok(user) => user,
            Err(answer) => return *answer,
        };
        let (mut query, page) = match super::params::query(ctx) {
            Some(validated) => match validated_query(&validated) {
                Ok(read) => read,
                Err(why) => return Outcome::forward(why),
            },
            None => match parse_query(ctx.req.uri.query().unwrap_or("")) {
                Ok(query) => {
                    let page = JsPage::of(query.take, query.skip, query.requested_by);
                    (query, page)
                }
                Err(why) => return Outcome::forward(why),
            },
        };
        let sees_all = user.has_permission(MANAGE_REQUESTS | REQUEST_VIEW);
        if !sees_all {
            if page.requested_by.is_some_and(|id| id != user.id) {
                return ctx.error(
                    403,
                    "You do not have permission to view this user's requests.",
                );
            }
            query.requested_by = Some(user.id);
        }
        let db = &ctx.state.db;
        query.take = page.take;
        query.skip = page.skip;
        if let (true, Some(id)) = (sees_all, page.requested_by) {
            query.requested_by = Some(id);
        }
        let (requests, total) = match db.request_list(&query).await {
            Ok(page) => page,
            Err(e) => return Outcome::forward(format!("listing requests failed: {e:#}")),
        };
        if let Some(odd) = requests
            .iter()
            .find(|r| !matches!(r.request_type.as_str(), "movie" | "tv"))
        {
            return Outcome::forward(format!(
                "request {} has the unknown type {:?}",
                odd.id, odd.request_type
            ));
        }
        let media_ids: Vec<i64> = requests.iter().filter_map(|r| r.media_id).collect();
        let mut user_ids: Vec<i64> = Vec::new();
        for request in &requests {
            user_ids.extend(request.requested_by_id);
            user_ids.extend(request.modified_by_id);
        }
        let related = match Related::load(ctx, &media_ids, &user_ids, false).await {
            Ok(related) => related,
            Err(why) => return Outcome::forward(why),
        };
        let sonarr = profiles(ctx, "/sonarr").await;
        let radarr = profiles(ctx, "/radarr").await;
        let can_remove = user.has_permission(MANAGE_REQUESTS);
        let mut results = Vec::with_capacity(requests.len());
        for request in &requests {
            let servers = if request.request_type == "movie" {
                &radarr
            } else {
                &sonarr
            };
            match request_json(ctx, &related, request, servers, can_remove) {
                Ok(json) => results.push(json),
                Err(why) => return Outcome::forward(why),
            }
        }
        let page_info = page.info(total);
        let mut errors = Map::new();
        errors.insert(String::from("radarr"), service_errors(&radarr, "Radarr"));
        errors.insert(String::from("sonarr"), service_errors(&sonarr, "Sonarr"));
        let mut body = Map::new();
        body.insert(String::from("pageInfo"), Value::Object(page_info));
        body.insert(String::from("results"), Value::Array(results));
        body.insert(String::from("serviceErrors"), Value::Object(errors));
        ctx.json(&Value::Object(body))
    })
}

/// One request of a list: the entity spread with `profileName` (when a
/// server in `servers` knows the profile) and, when `can_remove`,
/// `canRemove`.
pub(super) fn request_json(
    ctx: &Ready<'_>,
    related: &Related,
    request: &RequestRow,
    servers: &[ServerProfiles],
    can_remove: bool,
) -> Result<Value, String> {
    let mut out = Map::new();
    columns(&mut out, request);
    out.insert(
        String::from("media"),
        related.media_json(ctx, request.media_id, false),
    );
    out.insert(String::from("seasons"), seasons_json(&request.seasons));
    out.insert(String::from("episodes"), episodes_json(&request.episodes));
    out.insert(
        String::from("modifiedBy"),
        related.user_json(request.modified_by_id, false)?,
    );
    out.insert(
        String::from("requestedBy"),
        related.user_json(request.requested_by_id, false)?,
    );
    out.insert(String::from("seasonCount"), count_of(&request.seasons));
    if let Some(name) = profile_name(servers, request) {
        out.insert(String::from("profileName"), name);
    }
    if can_remove {
        let media = request.media_id.and_then(|id| related.media.get(&id));
        let service_id = media.and_then(|m| {
            if request.is4k {
                m.service_id4k
            } else {
                m.service_id
            }
        });
        let configured = servers.iter().any(|s| {
            s.server
                .get("id")
                .and_then(Value::as_i64)
                .is_some_and(|id| Some(id) == service_id)
        });
        out.insert(String::from("canRemove"), Value::Bool(configured));
    }
    Ok(Value::Object(out))
}

/// `GET /user/{id}/requests`: the user's requests, newest first, as the
/// list route prints them but without profile names or `canRemove`.
pub(super) fn of_user<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let viewer = match ctx.require(0) {
            Ok(user) => user,
            Err(answer) => return *answer,
        };
        let page = match super::params::query(ctx) {
            Some(q) => match super::params::take_skip(&q, 20) {
                Ok((take, skip)) => JsPage::of(take, skip, None),
                Err(why) => return Outcome::forward(why),
            },
            None => match parse_page(ctx.req.uri.query().unwrap_or("")) {
                Ok((take, skip)) => JsPage::of(take, skip, None),
                Err(why) => return Outcome::forward(why),
            },
        };
        // `findOne({ where: { id: Number(req.params.id) } })`.
        let id = match super::params::path_int(ctx, 1) {
            Ok(id) => id,
            Err(why) => return Outcome::forward(why),
        };
        match ctx.state.db.user(id).await {
            Ok(Some(_)) => {}
            Ok(None) => return ctx.error(404, "User not found."),
            Err(e) => return Outcome::forward(format!("loading user {id} failed: {e:#}")),
        }
        if id != viewer.id && !viewer.has_permission(MANAGE_REQUESTS | REQUEST_VIEW) {
            return ctx.error(
                403,
                "You do not have permission to view this user's requests.",
            );
        }
        let (requests, total) = match ctx
            .state
            .db
            .requests_of_user(id, page.take, page.skip)
            .await
        {
            Ok(page) => page,
            Err(e) => {
                return Outcome::forward(format!("listing the user's requests failed: {e:#}"))
            }
        };
        let media_ids: Vec<i64> = requests.iter().filter_map(|r| r.media_id).collect();
        let mut user_ids: Vec<i64> = Vec::new();
        for request in &requests {
            user_ids.extend(request.requested_by_id);
            user_ids.extend(request.modified_by_id);
        }
        let related = match Related::load(ctx, &media_ids, &user_ids, false).await {
            Ok(related) => related,
            Err(why) => return Outcome::forward(why),
        };
        let mut results = Vec::with_capacity(requests.len());
        for request in &requests {
            match request_json(ctx, &related, request, &[], false) {
                Ok(json) => results.push(json),
                Err(why) => return Outcome::forward(why),
            }
        }
        let page_info = page.info(total);
        let mut body = Map::new();
        body.insert(String::from("pageInfo"), Value::Object(page_info));
        body.insert(String::from("results"), Value::Array(results));
        ctx.json(&Value::Object(body))
    })
}

/// `pageSize`, `skip` and `requestedBy` as the handlers read them.
struct JsPage {
    take: i64,
    skip: i64,
    /// `requestedBy` when truthy.
    requested_by: Option<i64>,
}

impl JsPage {
    const fn of(take: i64, skip: i64, requested_by: Option<i64>) -> Self {
        Self {
            take,
            skip,
            requested_by,
        }
    }

    /// `{ pages, pageSize, results, page }`.
    fn info(&self, total: i64) -> Map<String, Value> {
        super::params::page_info(self.take, self.skip, total)
    }
}

/// The list handler's reading of what the validator left: the numbers
/// as `x ? Number(x) : default`, the `filter` switches, `sort`,
/// `sortDirection` and `mediaType || 'all'`.
fn validated_query(q: &Map<String, Value>) -> Result<(RequestListQuery, JsPage), super::Fallback> {
    let (take, skip) = super::params::take_skip(q, 10)?;
    let requested_by =
        super::params::int(q.get("requestedBy"), "requestedBy")?.filter(|id| *id != 0);
    let mut query = parse_query("").unwrap_or_else(|_| RequestListQuery {
        statuses: Vec::new(),
        media_statuses: Vec::new(),
        sort: RequestSort::Id,
        ascending: false,
        requested_by: None,
        media_type: None,
        take: 10,
        skip: 0,
    });
    if let Some(Filter::Narrow(statuses, media)) =
        q.get("filter").and_then(Value::as_str).map(filter_statuses)
    {
        query.statuses = statuses;
        if let Some(media) = media {
            query.media_statuses = media;
        }
    }
    query.sort = if q.get("sort").and_then(Value::as_str) == Some("modified") {
        RequestSort::UpdatedAt
    } else {
        RequestSort::Id
    };
    query.ascending = q.get("sortDirection").and_then(Value::as_str) == Some("asc");
    query.media_type = match q.get("mediaType").and_then(Value::as_str) {
        Some(kind @ ("movie" | "tv")) => Some(kind.to_owned()),
        Some(_) | None => None,
    };
    Ok((query, JsPage::of(take, skip, requested_by)))
}

/// `take` (default 20, `0` counts as unset) and `skip`, both plain
/// non-negative integers; anything else goes to Node.
fn parse_page(raw: &str) -> Result<(i64, i64), String> {
    let (mut take, mut skip) = (20, 0);
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
            "take" => match plain_integer(&value) {
                Some(0) => {}
                Some(n) => take = n,
                None => return forward("take must be a non-negative integer"),
            },
            "skip" => match plain_integer(&value) {
                Some(n) => skip = n,
                None => return forward("skip must be a non-negative integer"),
            },
            _ => return forward("an unknown query key"),
        }
    }
    Ok((take, skip))
}

/// `GET /request/count`.
pub(super) fn count<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = ctx
            .no_query()
            .and_then(|()| ctx.authenticated(0).map(|_| ()))
        {
            return Outcome::forward(why);
        }
        let counts = match ctx.state.db.request_counts().await {
            Ok(counts) => counts,
            Err(e) => return Outcome::forward(format!("counting requests failed: {e:#}")),
        };
        let mut out = Map::new();
        for (key, value) in [
            ("total", counts.total),
            ("movie", counts.movie),
            ("tv", counts.tv),
            ("pending", counts.pending),
            ("approved", counts.approved),
            ("declined", counts.declined),
            ("processing", counts.processing),
            ("available", counts.available),
            ("completed", counts.completed),
        ] {
            out.insert(String::from(key), Value::from(value));
        }
        ctx.json(&Value::Object(out))
    })
}

/// `GET /request/{id}`: one request as `findOneOrFail` with its eager
/// relations loads it: the users carry their settings, the media its
/// seasons.
pub(super) fn detail<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user = match ctx.no_query().and_then(|()| ctx.authenticated(0)) {
            Ok(user) => user,
            Err(why) => return Outcome::forward(why),
        };
        let id = match super::params::path_int(ctx, 0) {
            Ok(id) => id,
            Err(why) => return Outcome::forward(why),
        };
        let request = match ctx.state.db.request_by_id(id).await {
            Ok(Some(request)) => request,
            Ok(None) => return ctx.error(404, "Request not found."),
            Err(e) => return Outcome::forward(format!("loading request {id} failed: {e:#}")),
        };
        if request.requested_by_id != Some(user.id)
            && !user.has_permission(MANAGE_REQUESTS | REQUEST_VIEW)
        {
            return ctx.error(403, "You do not have permission to view this request.");
        }
        let media_ids: Vec<i64> = request.media_id.into_iter().collect();
        let user_ids: Vec<i64> = [request.requested_by_id, request.modified_by_id]
            .into_iter()
            .flatten()
            .collect();
        let related = match Related::load(ctx, &media_ids, &user_ids, true).await {
            Ok(related) => related,
            Err(why) => return Outcome::forward(why),
        };
        let request = &request;
        let mut out = Map::new();
        columns(&mut out, request);
        let requested_by = match related.user_json(request.requested_by_id, true) {
            Ok(json) => json,
            Err(why) => return Outcome::forward(why),
        };
        out.insert(String::from("requestedBy"), requested_by);
        let modified_by = match related.user_json(request.modified_by_id, true) {
            Ok(json) => json,
            Err(why) => return Outcome::forward(why),
        };
        out.insert(String::from("modifiedBy"), modified_by);
        out.insert(
            String::from("media"),
            related.media_json(ctx, request.media_id, true),
        );
        out.insert(String::from("seasons"), seasons_json(&request.seasons));
        out.insert(String::from("episodes"), episodes_json(&request.episodes));
        out.insert(String::from("seasonCount"), count_of(&request.seasons));
        ctx.json(&Value::Object(out))
    })
}

/// The entity's own columns, in declaration order.
pub(super) fn columns(out: &mut Map<String, Value>, r: &RequestRow) {
    let text = |v: &Option<String>| v.as_deref().map_or(Value::Null, Value::from);
    let number = |v: Option<i64>| v.map_or(Value::Null, Value::from);
    out.insert(String::from("id"), Value::from(r.id));
    out.insert(String::from("status"), Value::from(r.status));
    out.insert(String::from("createdAt"), text(&r.created_at));
    out.insert(String::from("updatedAt"), text(&r.updated_at));
    out.insert(String::from("type"), Value::from(r.request_type.as_str()));
    out.insert(
        String::from("episodeSelectionType"),
        text(&r.episode_selection_type),
    );
    out.insert(
        String::from("episodeStartTvdbId"),
        number(r.episode_start_tvdb_id),
    );
    out.insert(
        String::from("episodeEndTvdbId"),
        number(r.episode_end_tvdb_id),
    );
    out.insert(String::from("watchAheadCount"), number(r.watch_ahead_count));
    out.insert(
        String::from("watchAheadInactiveAt"),
        text(&r.watch_ahead_inactive_at),
    );
    out.insert(
        String::from("ongoingEpisodeRequestKey"),
        text(&r.ongoing_episode_request_key),
    );
    out.insert(String::from("tvQuotaUnits"), Value::from(r.tv_quota_units));
    out.insert(String::from("is4k"), Value::Bool(r.is4k));
    out.insert(String::from("serverId"), opt_int(r.server_id));
    out.insert(String::from("profileId"), opt_int(r.profile_id));
    out.insert(String::from("rootFolder"), text(&r.root_folder));
    out.insert(
        String::from("languageProfileId"),
        opt_int(r.language_profile_id),
    );
    out.insert(String::from("tags"), tags_json(r.tags.as_deref()));
    out.insert(
        String::from("isAutoRequest"),
        Value::Bool(r.is_auto_request),
    );
    out.insert(String::from("ignoreQuota"), Value::Bool(r.ignore_quota));
}

/// The `tags` column transformer: null or empty stays null, `none` is an
/// empty list, anything else is split on commas and read with `Number()`.
pub fn tags_json(stored: Option<&str>) -> Value {
    match stored {
        None | Some("") => Value::Null,
        Some("none") => Value::Array(Vec::new()),
        Some(list) => Value::Array(list.split(',').map(js_number).collect()),
    }
}

/// `Number(text)` as JSON prints it: an integer, a float, or null for NaN.
fn js_number(text: &str) -> Value {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Value::from(0);
    }
    if let Ok(n) = trimmed.parse::<i64>() {
        return Value::from(n);
    }
    trimmed
        .parse::<f64>()
        .ok()
        .filter(|f| f.is_finite())
        .map_or(Value::Null, Value::from)
}

pub(super) fn seasons_json(seasons: &[SeasonRequestRow]) -> Value {
    let text = |v: &Option<String>| v.as_deref().map_or(Value::Null, Value::from);
    Value::Array(
        seasons
            .iter()
            .map(|s| {
                let mut out = Map::new();
                out.insert(String::from("id"), Value::from(s.id));
                out.insert(String::from("seasonNumber"), Value::from(s.season_number));
                out.insert(String::from("status"), Value::from(s.status));
                out.insert(String::from("createdAt"), text(&s.created_at));
                out.insert(String::from("updatedAt"), text(&s.updated_at));
                Value::Object(out)
            })
            .collect(),
    )
}

pub(super) fn episodes_json(episodes: &[EpisodeRequestRow]) -> Value {
    let text = |v: &Option<String>| v.as_deref().map_or(Value::Null, Value::from);
    Value::Array(
        episodes
            .iter()
            .map(|e| {
                let mut out = Map::new();
                out.insert(String::from("id"), Value::from(e.id));
                out.insert(String::from("tvdbId"), Value::from(e.tvdb_id));
                out.insert(String::from("seasonNumber"), Value::from(e.season_number));
                out.insert(String::from("episodeNumber"), Value::from(e.episode_number));
                out.insert(String::from("title"), text(&e.title));
                out.insert(String::from("airDate"), text(&e.air_date));
                out.insert(String::from("status"), Value::from(e.status));
                out.insert(
                    String::from("searchTriggeredAt"),
                    text(&e.search_triggered_at),
                );
                out.insert(String::from("monitoredAt"), text(&e.monitored_at));
                out.insert(String::from("unmonitoredAt"), text(&e.unmonitored_at));
                out.insert(String::from("createdAt"), text(&e.created_at));
                out.insert(String::from("updatedAt"), text(&e.updated_at));
                Value::Object(out)
            })
            .collect(),
    )
}

/// `@RelationCount` over `seasons`.
pub(super) fn count_of(seasons: &[SeasonRequestRow]) -> Value {
    Value::from(i64::try_from(seasons.len()).unwrap_or(i64::MAX))
}

/// `getProfiles` for every server in a settings section, all at once as
/// `Promise.all` runs them, in the section's order.
async fn profiles(ctx: &Ready<'_>, section: &str) -> Vec<ServerProfiles> {
    let servers: Vec<Value> = ctx
        .settings
        .get(section)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let timeout = api_timeout(&ctx.settings);
    let mut set = JoinSet::new();
    for (index, server) in servers.iter().cloned().enumerate() {
        let client = ctx.state.servarr.clone();
        set.spawn(async move {
            let profiles = client.profiles(&server, timeout).await.ok();
            (index, profiles)
        });
    }
    let mut fetched: HashMap<usize, Option<Vec<Value>>> = HashMap::new();
    while let Some(done) = set.join_next().await {
        if let Ok((index, profiles)) = done {
            fetched.insert(index, profiles);
        }
    }
    servers
        .into_iter()
        .enumerate()
        .map(|(index, server)| ServerProfiles {
            profiles: fetched.remove(&index).flatten(),
            server,
        })
        .collect()
}

/// The name of the request's quality profile on its server, when both are
/// known.
fn profile_name(servers: &[ServerProfiles], request: &RequestRow) -> Option<Value> {
    let server = servers.iter().find(|s| {
        request
            .server_id
            .is_some_and(|id| s.server.get("id").and_then(Value::as_i64) == Some(id))
    })?;
    let profile = server.profiles.as_ref()?.iter().find(|p| {
        request
            .profile_id
            .is_some_and(|id| p.get("id").and_then(Value::as_i64) == Some(id))
    })?;
    profile.get("name").cloned()
}

/// A nullable integer column as JSON.
fn opt_int(n: Option<i64>) -> Value {
    n.map_or(Value::Null, Value::from)
}

/// `serviceErrors`: the servers whose profiles couldn't be fetched.
fn service_errors(servers: &[ServerProfiles], kind: &str) -> Value {
    Value::Array(
        servers
            .iter()
            .filter(|s| s.profiles.is_none())
            .map(|s| {
                let id = s.server.get("id").cloned().unwrap_or(Value::Null);
                let name = s.server.get("name");
                let name = if crate::settings::public::truthy(name) {
                    crate::media::js_string(name).into_owned()
                } else {
                    format!("{kind} {}", crate::media::js_string(s.server.get("id")))
                };
                let mut out = Map::new();
                out.insert(String::from("id"), id);
                out.insert(String::from("name"), Value::from(name));
                Value::Object(out)
            })
            .collect(),
    )
}

/// The query as the validator and the handler read it. `take`, `skip` and
/// `requestedBy` have to be plain non-negative integers (`0` counts as
/// unset, as it is falsy); `filter`, `sort`, `sortDirection` and
/// `mediaType` stay in their enums. Anything else goes to Node.
fn parse_query(raw: &str) -> Result<RequestListQuery, String> {
    let mut query = RequestListQuery {
        statuses: vec![PENDING, APPROVED, DECLINED, FAILED, COMPLETED],
        media_statuses: vec![
            MEDIA_UNKNOWN,
            MEDIA_PENDING,
            MEDIA_PROCESSING,
            MEDIA_PARTIALLY_AVAILABLE,
            MEDIA_AVAILABLE,
            MEDIA_DELETED,
        ],
        sort: RequestSort::Id,
        ascending: false,
        requested_by: None,
        media_type: None,
        take: 10,
        skip: 0,
    };
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
            "take" => match plain_integer(&value) {
                Some(0) => {}
                Some(n) => query.take = n,
                None => return forward("take must be a non-negative integer"),
            },
            "skip" => match plain_integer(&value) {
                Some(n) => query.skip = n,
                None => return forward("skip must be a non-negative integer"),
            },
            "requestedBy" => match plain_integer(&value) {
                Some(0) => {}
                Some(n) => query.requested_by = Some(n),
                None => return forward("requestedBy must be a non-negative integer"),
            },
            "filter" => match filter_statuses(&value) {
                Filter::Narrow(statuses, media) => {
                    query.statuses = statuses;
                    if let Some(media) = media {
                        query.media_statuses = media;
                    }
                }
                Filter::Everything => {}
                Filter::Unknown => return forward("filter outside the enum"),
            },
            "sort" => {
                query.sort = match value.as_str() {
                    "added" => RequestSort::Id,
                    "modified" => RequestSort::UpdatedAt,
                    _ => return forward("sort outside the enum"),
                };
            }
            "sortDirection" => {
                query.ascending = match value.as_str() {
                    "asc" => true,
                    "desc" => false,
                    _ => return forward("sortDirection outside the enum"),
                };
            }
            "mediaType" => {
                query.media_type = match value.as_str() {
                    "all" => None,
                    "movie" | "tv" => Some(value.clone()),
                    _ => return forward("mediaType outside the enum"),
                };
            }
            _ => return forward("an unknown query key"),
        }
    }
    Ok(query)
}

/// What a `filter` value selects.
enum Filter {
    /// Request statuses and, when the filter narrows it, media statuses.
    Narrow(Vec<i64>, Option<Vec<i64>>),
    /// `all`: the defaults.
    Everything,
    /// Outside the enum: the validator answers 400.
    Unknown,
}

/// The two `switch (req.query.filter)` blocks.
fn filter_statuses(value: &str) -> Filter {
    let in_progress = || {
        vec![
            MEDIA_UNKNOWN,
            MEDIA_PENDING,
            MEDIA_PROCESSING,
            MEDIA_PARTIALLY_AVAILABLE,
        ]
    };
    match value {
        "all" => Filter::Everything,
        "approved" => Filter::Narrow(vec![APPROVED], None),
        "processing" => Filter::Narrow(vec![APPROVED], Some(in_progress())),
        "pending" => Filter::Narrow(vec![PENDING], None),
        "unavailable" => Filter::Narrow(vec![PENDING, APPROVED], Some(in_progress())),
        "failed" => Filter::Narrow(vec![FAILED], None),
        "completed" => Filter::Narrow(vec![COMPLETED], None),
        "available" => Filter::Narrow(vec![COMPLETED], Some(vec![MEDIA_AVAILABLE])),
        "deleted" => Filter::Narrow(vec![COMPLETED], Some(vec![MEDIA_DELETED])),
        _ => Filter::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn query_parsing() {
        let q = parse_query("filter=processing&sort=modified&sortDirection=asc&requestedBy=2&mediaType=tv&take=5&skip=5").ok();
        assert_eq!(
            q,
            Some(RequestListQuery {
                statuses: vec![APPROVED],
                media_statuses: vec![
                    MEDIA_UNKNOWN,
                    MEDIA_PENDING,
                    MEDIA_PROCESSING,
                    MEDIA_PARTIALLY_AVAILABLE
                ],
                sort: RequestSort::UpdatedAt,
                ascending: true,
                requested_by: Some(2),
                media_type: Some(String::from("tv")),
                take: 5,
                skip: 5,
            }),
            "explicit values"
        );
        assert_eq!(
            parse_query(
                "filter=all&requestedBy=0&take=0&mediaType=all&sort=added&sortDirection=desc"
            )
            .ok(),
            parse_query("").ok(),
            "the falsy and default values"
        );
        assert_eq!(
            parse_query("filter=available")
                .ok()
                .map(|q| (q.statuses, q.media_statuses)),
            Some((vec![COMPLETED], vec![MEDIA_AVAILABLE])),
            "available narrows the media status too"
        );
        for raw in [
            "take=-1",
            "requestedBy=x",
            "filter=",
            "sort=id",
            "sortDirection=up",
            "mediaType=book",
            "x=1",
        ] {
            assert!(parse_query(raw).is_err(), "{raw} is forwarded");
        }
    }

    #[test]
    fn tags_transformer() {
        assert_eq!(tags_json(None), Value::Null, "null");
        assert_eq!(tags_json(Some("")), Value::Null, "empty is falsy");
        assert_eq!(tags_json(Some("none")), json!([]), "none");
        assert_eq!(tags_json(Some("1,2")), json!([1, 2]), "numbers");
        assert_eq!(
            tags_json(Some("1,x")),
            json!([1, null]),
            "NaN prints as null"
        );
    }

    #[test]
    fn profile_lookup() {
        let servers = vec![
            ServerProfiles {
                server: json!({"id": 0, "name": ""}),
                profiles: Some(vec![json!({"id": 1, "name": "Any"})]),
            },
            ServerProfiles {
                server: json!({"id": 1, "name": "4K"}),
                profiles: None,
            },
        ];
        let request = RequestRow {
            server_id: Some(0.into()),
            profile_id: Some(1.into()),
            ..RequestRow::default()
        };
        assert_eq!(
            profile_name(&servers, &request),
            Some(json!("Any")),
            "found"
        );
        let other = RequestRow {
            server_id: Some(1.into()),
            profile_id: Some(1.into()),
            ..RequestRow::default()
        };
        assert_eq!(profile_name(&servers, &other), None, "server failed");
        assert_eq!(
            service_errors(&servers, "Radarr"),
            json!([{"id": 1, "name": "4K"}]),
            "only the failed server"
        );
        let unnamed = vec![ServerProfiles {
            server: json!({"id": 3, "name": ""}),
            profiles: None,
        }];
        assert_eq!(
            service_errors(&unnamed, "Radarr"),
            json!([{"id": 3, "name": "Radarr 3"}]),
            "fallback name"
        );
    }
}
