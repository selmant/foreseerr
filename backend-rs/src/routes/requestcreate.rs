//! `POST /request`: `MediaRequest.request()` for movies, seasons and
//! episode selections.
//!
//! Permission, quota, blocklist and duplicate checks, override rules and
//! Sonarr defaults, then the media row and the request are written and the
//! insert hooks run (`crate::lifecycle`). Episode selections resolve the
//! TVDB episode catalog (`super::episodeselect`); replacing an ongoing
//! episode request stays with Node.

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use axum::http::Method;
use serde_json::{Map, Value};

use super::draft::{
    body_object, current_user, fail_on_err, forward_on_err, inserted_media_json, media_type,
    opt_text, user_json, Column, Draft, RETURNING_ID,
};
use super::episodeselect::{self, Refused, Resolved, Selection};
use super::listwrite::{insert_media_in, main_locale, media_row};
use super::related::Related;
use super::{Outcome, Ready, Table};
use crate::auth::CurrentUser;
use crate::db::{Bind, MediaRow, OverrideRuleRow, QuotaWindow, RequestRow};
use crate::dbtx::Exec;
use crate::jobs::episode_request_sync::CatalogEpisode;
use crate::jobs::syncutil::Tx;
use crate::lifecycle::{Lc, UserRel, APPROVED, COMPLETED, DECLINED, PENDING};
use crate::settings::public::truthy;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// `Permission` bits.
const ADMIN: i64 = 2;
const MANAGE_USERS: i64 = 8;
const MANAGE_REQUESTS: i64 = 16;
const REQUEST: i64 = 32;
const AUTO_APPROVE: i64 = 128;
const AUTO_APPROVE_MOVIE: i64 = 256;
const AUTO_APPROVE_TV: i64 = 512;
const REQUEST_4K: i64 = 1024;
const REQUEST_4K_MOVIE: i64 = 2048;
const REQUEST_4K_TV: i64 = 4096;
const AUTO_APPROVE_4K: i64 = 32_768;
const AUTO_APPROVE_4K_MOVIE: i64 = 65_536;
const AUTO_APPROVE_4K_TV: i64 = 131_072;
const REQUEST_MOVIE: i64 = 262_144;
const REQUEST_TV: i64 = 524_288;

/// `MediaStatus`.
const M_UNKNOWN: i64 = 1;
const M_PENDING: i64 = 2;
const M_PROCESSING: i64 = 3;
const M_AVAILABLE: i64 = 5;
const M_BLOCKLISTED: i64 = 6;
const M_DELETED: i64 = 7;

/// TMDB's `anime` keyword.
const ANIME_KEYWORD_ID: i64 = 210_024;

/// `requestLock`: one request created at a time.
static CREATE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// This module's routes.
pub(super) const ROUTES: &Table = &[("/api/v1/request", Method::POST, create)];

/// `MediaRequest`'s columns in declaration order.
pub(super) const REQUEST_COLUMNS: [Column; 21] = [
    ("id", false, true),
    ("status", false, false),
    ("createdAt", false, true),
    ("updatedAt", false, true),
    ("type", false, false),
    ("episodeSelectionType", true, false),
    ("episodeStartTvdbId", true, false),
    ("episodeEndTvdbId", true, false),
    ("watchAheadCount", true, false),
    ("watchAheadInactiveAt", true, false),
    ("ongoingEpisodeRequestKey", true, false),
    ("tvQuotaUnits", false, true),
    ("is4k", false, true),
    ("serverId", true, false),
    ("profileId", true, false),
    ("rootFolder", true, false),
    ("languageProfileId", true, false),
    ("metadataLanguageId", true, false),
    ("tags", true, false),
    ("isAutoRequest", false, true),
    ("ignoreQuota", false, true),
];

/// `hasPermission(bits, value, { type: 'or' })`.
pub(super) const fn has_any(permissions: i64, bits: i64) -> bool {
    bits == 0 || permissions & ADMIN != 0 || permissions & bits != 0
}

/// `hasPermission([...], value)`: every bit.
pub(super) const fn has_all(permissions: i64, bits: i64) -> bool {
    permissions & ADMIN != 0 || permissions & bits == bits
}

/// `seasons`: a list or `all`.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Seasons {
    All,
    List(Vec<i64>),
}

/// The body as the spec lets it through, minus episode selections.
#[derive(Debug, Clone)]
struct Body {
    media_type: &'static str,
    media_id: i64,
    tvdb_id: Option<i64>,
    seasons: Option<Seasons>,
    /// `is4k ?? false`.
    is4k: bool,
    /// Whether `is4k` was sent: an undefined one matches no request in
    /// Node's `request.is4k = :is4k` queries and `=== requestBody.is4k`
    /// filters.
    is4k_given: bool,
    server_id: Option<i64>,
    profile_id: Option<i64>,
    root_folder: Option<String>,
    language_profile_id: Option<i64>,
    /// `metadataLanguageId`: an explicit Sonarr 5 metadata language.
    metadata_language_id: Option<i64>,
    user_id: Option<i64>,
    ignore_quota: Option<bool>,
    tags: Option<Vec<i64>>,
    /// `options.isAutoRequest` (the Plex watchlist sync).
    is_auto_request: bool,
    /// `episodeSelection`, when sent.
    episode_selection: Option<Value>,
}

fn int_list(value: &Value, what: &str) -> Result<Vec<i64>, String> {
    value
        .as_array()
        .ok_or_else(|| format!("{what} isn't a list"))?
        .iter()
        .map(|v| {
            v.as_i64()
                .ok_or_else(|| format!("{what} has a non-integer"))
        })
        .collect()
}

/// The body as `createRequest` reads it; keys it doesn't read (even
/// `__proto__`, which `JSON.parse` makes an own property) change nothing.
fn parse_body(body: &Map<String, Value>) -> Result<Body, super::Fallback> {
    use super::params::body_int;
    let seasons = match body.get("seasons") {
        None => None,
        Some(Value::String(s)) if s == "all" => Some(Seasons::All),
        Some(v) => {
            let list = int_list(v, "seasons")?;
            if list.iter().any(|n| *n < 0) {
                return Err(String::from("a negative season; the validator answers").into());
            }
            Some(Seasons::List(list))
        }
    };
    let user_id = match body.get("userId") {
        None | Some(Value::Null) => None,
        Some(_) => body_int(body, "userId")?,
    };
    let ignore_quota = match body.get("ignoreQuota") {
        None => None,
        Some(Value::Bool(b)) => Some(*b),
        Some(_) => return Err(String::from("ignoreQuota isn't a boolean").into()),
    };
    let is4k = match body.get("is4k") {
        None => None,
        Some(Value::Bool(b)) => Some(*b),
        Some(_) => {
            return Err(String::from("is4k isn't a boolean; the validator's to check").into())
        }
    };
    Ok(Body {
        media_type: media_type(body.get("mediaType"))?,
        media_id: body_int(body, "mediaId")?
            .ok_or_else(|| super::Fallback::status(400, "mediaId is required."))?,
        tvdb_id: body_int(body, "tvdbId")?,
        seasons,
        is4k: is4k.unwrap_or(false),
        is4k_given: is4k.is_some(),
        server_id: body_int(body, "serverId")?,
        profile_id: body_int(body, "profileId")?,
        root_folder: opt_text(body, "rootFolder")?,
        language_profile_id: body_int(body, "languageProfileId")?,
        metadata_language_id: super::params::body_id_assign(body, "metadataLanguageId")?.value(),
        user_id: user_id.filter(|id| *id != 0),
        ignore_quota,
        tags: body.get("tags").map(|v| int_list(v, "tags")).transpose()?,
        is_auto_request: false,
        episode_selection: body.get("episodeSelection").cloned(),
    })
}

/// `POST /request`.
fn create<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        forward_on_err!(ctx.no_query());
        let user = forward_on_err!(ctx.authenticated(0));
        let raw = forward_on_err!(body_object(ctx));
        let body = forward_on_err!(parse_body(raw));
        let _guard = CREATE_LOCK.lock().await;
        create_request(ctx, user, &body).await
    })
}

/// `MediaRequest.request(body, user, { isAutoRequest: true })` for a job:
/// the same checks and writes as `POST /request` by the signed-in `ctx`
/// user, answered as that route would answer.
pub(super) async fn create_auto_request(ctx: &Ready<'_>, raw: &Map<String, Value>) -> Outcome {
    let user = forward_on_err!(ctx.authenticated(0));
    let mut body = forward_on_err!(parse_body(raw));
    body.is_auto_request = true;
    let _guard = CREATE_LOCK.lock().await;
    create_request(ctx, user, &body).await
}

/// One media type's quota as `User.getQuota` reports it.
#[derive(Debug, Clone, Copy, Default)]
pub(super) struct Quota {
    pub(super) limit: i64,
    pub(super) remaining: Option<i64>,
    restricted: bool,
}

impl Quota {
    /// Whether an edit of a request that already counts `held` units, to
    /// `units`, goes past the quota; the edits' `Series Quota exceeded.`.
    pub(super) fn edit_exceeds(&self, ignore_quota: bool, units: i64, held: i64) -> bool {
        !ignore_quota && self.limit != 0 && units > self.remaining.unwrap_or(0) + held
    }
}

/// A `defaultQuotas` value: a whole number or nothing.
fn default_quota(ctx: &Ready<'_>, path: &str) -> Result<Option<i64>, String> {
    match ctx.settings.get(&format!("/main/defaultQuotas/{path}")) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n
            .as_i64()
            .map(Some)
            .ok_or_else(|| String::from("a fractional quota default")),
        Some(_) => Err(String::from("a quota default that is not a number")),
    }
}

/// `User.getQuota` for the user being requested for.
pub(super) async fn quotas(ctx: &Ready<'_>, rel: &UserRel) -> Result<(Quota, Quota), String> {
    let u = &rel.0;
    let bypass = has_any(u.permissions, MANAGE_USERS);
    let now = crate::clock::now_millis();
    let window = |days: Option<i64>| QuotaWindow::days_before(now, days);
    let pick = |own: Option<i64>, path: &str| -> Result<Option<i64>, String> {
        own.map_or_else(|| default_quota(ctx, path), |v| Ok(Some(v)))
    };
    let movie_limit = if bypass {
        0
    } else {
        pick(u.movie_quota_limit, "movie/quotaLimit")?.unwrap_or(0)
    };
    let movie_days = pick(u.movie_quota_days, "movie/quotaDays")?;
    let tv_limit = if bypass {
        0
    } else {
        pick(u.tv_quota_limit, "tv/quotaLimit")?.unwrap_or(0)
    };
    let tv_days = pick(u.tv_quota_days, "tv/quotaDays")?;
    let db = &ctx.state.db;
    let movie_used = if movie_limit == 0 {
        0
    } else {
        db.movie_quota_used(u.id, window(movie_days))
            .await
            .map_err(|e| format!("counting movie requests failed: {e:#}"))?
    };
    let tv_used = if tv_limit == 0 {
        0
    } else {
        db.tv_quota_used(u.id, window(tv_days))
            .await
            .map_err(|e| format!("summing tv requests failed: {e:#}"))?
    };
    let quota = |limit: i64, used: i64| Quota {
        limit,
        remaining: (limit != 0).then(|| (limit - used).max(0)),
        restricted: limit != 0 && limit - used <= 0,
    };
    Ok((quota(movie_limit, movie_used), quota(tv_limit, tv_used)))
}

/// What the request will be written with.
#[derive(Debug, Clone, Default)]
struct Routing {
    server_id: Option<i64>,
    profile_id: Option<i64>,
    root_folder: Option<String>,
    language_profile_id: Option<i64>,
    /// Only the requester's own choice: the server's setting is read when
    /// the request is sent, so it isn't copied here.
    metadata_language_id: Option<i64>,
    tags: Option<Vec<i64>>,
}

/// `Number(piece)` for the id lists override rules store; anything but
/// digits (or nothing, which is 0) is left to Node.
fn rule_number(piece: &str) -> Result<i64, String> {
    let trimmed = piece.trim();
    if trimmed.is_empty() {
        return Ok(0);
    }
    trimmed
        .strip_prefix('-')
        .unwrap_or(trimmed)
        .bytes()
        .all(|b| b.is_ascii_digit())
        .then(|| trimmed.parse::<i64>().ok())
        .flatten()
        .ok_or_else(|| format!("an override rule id {trimmed:?} Number() reads oddly"))
}

fn rule_numbers(list: &str) -> Result<Vec<i64>, String> {
    list.split(',').map(rule_number).collect()
}

/// The ids of a list of `{ id }` objects.
fn ids_of(list: Option<&Value>) -> Vec<i64> {
    list.and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|i| i.get("id").and_then(Value::as_i64))
                .collect()
        })
        .unwrap_or_default()
}

/// Whether a rule applies to this title and user.
fn rule_applies(
    rule: &OverrideRuleRow,
    details: &Value,
    tv_anime: bool,
    user_id: i64,
) -> Result<bool, String> {
    let set = |v: &Option<String>| v.clone().filter(|s| !s.is_empty());
    if tv_anime {
        match set(&rule.keywords) {
            Some(k) if rule_numbers(&k)?.contains(&ANIME_KEYWORD_ID) => {}
            _ => return Ok(false),
        }
    }
    if let Some(users) = set(&rule.users) {
        if !rule_numbers(&users)?.contains(&user_id) {
            return Ok(false);
        }
    }
    if let Some(genres) = set(&rule.genre) {
        let ids = ids_of(details.get("genres"));
        if !rule_numbers(&genres)?.iter().any(|g| ids.contains(g)) {
            return Ok(false);
        }
    }
    if let Some(languages) = set(&rule.language) {
        let original = details.get("original_language").and_then(Value::as_str);
        if !languages.split('|').any(|l| Some(l) == original) {
            return Ok(false);
        }
    }
    if let Some(keywords) = set(&rule.keywords) {
        let list = details.get("keywords").and_then(|k| {
            k.get("keywords")
                .filter(|v| v.is_array())
                .or_else(|| k.get("results"))
        });
        let ids = ids_of(list);
        if !rule_numbers(&keywords)?.iter().any(|k| ids.contains(k)) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// The override rules for the default server of this kind and quality,
/// most specific first; the first one that applies is used.
async fn apply_rules(
    ctx: &Ready<'_>,
    body: &Body,
    details: &Value,
    anime: bool,
    user_id: i64,
    routing: &mut Routing,
) -> Result<(), String> {
    let (section, field) = if body.media_type == "movie" {
        ("/radarr", "radarr")
    } else {
        ("/sonarr", "sonarr")
    };
    let default_id = ctx
        .settings
        .get(section)
        .and_then(Value::as_array)
        .and_then(|servers| {
            servers.iter().find(|s| {
                s.get("is4k").and_then(Value::as_bool) == Some(body.is4k)
                    && truthy(s.get("isDefault"))
            })
        })
        .and_then(|s| s.get("id"));
    let Some(default_id) = default_id else {
        return Ok(());
    };
    let Some(default_id) = default_id.as_i64() else {
        return Err(String::from("a server id that isn't a whole number"));
    };
    let rules = ctx
        .state
        .db
        .override_rules()
        .await
        .map_err(|e| format!("loading override rules failed: {e:#}"))?;
    let mut applied = Vec::new();
    for rule in rules {
        let service = if field == "radarr" {
            rule.radarr_service_id
        } else {
            rule.sonarr_service_id
        };
        if service == Some(default_id)
            && rule_applies(&rule, details, body.media_type == "tv" && anime, user_id)?
        {
            applied.push(rule);
        }
    }
    let specificity = |r: &OverrideRuleRow| {
        [&r.genre, &r.language, &r.keywords]
            .iter()
            .filter(|v| v.is_some())
            .count()
    };
    applied.sort_by_key(|r| std::cmp::Reverse(specificity(r)));
    let Some(rule) = applied.first() else {
        return Ok(());
    };
    if let Some(root) = rule.root_folder.as_ref().filter(|r| !r.is_empty()) {
        routing.root_folder = Some(root.clone());
    }
    if let Some(profile) = rule.profile_id.filter(|p| *p != 0) {
        routing.profile_id = Some(profile);
    }
    if let Some(tags) = rule.tags.as_ref().filter(|t| !t.is_empty()) {
        let mut merged = routing.tags.clone().unwrap_or_default();
        merged.extend(rule_numbers(tags)?);
        let mut unique: Vec<i64> = Vec::with_capacity(merged.len());
        for tag in merged {
            if !unique.contains(&tag) {
                unique.push(tag);
            }
        }
        routing.tags = Some(unique);
    }
    tracing::debug!("Override rule applied.");
    Ok(())
}

/// An optional whole number from settings.
fn setting_int(server: &Value, key: &str) -> Result<Option<i64>, String> {
    match server.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v
            .as_i64()
            .map(Some)
            .ok_or_else(|| format!("sonarr {key} isn't a whole number")),
    }
}

/// `applySonarrRequestDefaults` with `resolveSonarrSeriesRouting`.
fn sonarr_defaults(
    ctx: &Ready<'_>,
    body: &Body,
    anime: bool,
    routing: &mut Routing,
) -> Result<(), String> {
    let servers = ctx
        .settings
        .get("/sonarr")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let server = routing.server_id.map_or_else(
        || {
            servers.iter().find(|s| {
                truthy(s.get("isDefault"))
                    && s.get("is4k").and_then(Value::as_bool) == Some(body.is4k)
            })
        },
        |id| {
            servers
                .iter()
                .find(|s| s.get("id").and_then(Value::as_i64) == Some(id))
        },
    );
    let Some(server) = server else {
        return Ok(());
    };
    let anime_or = |anime_key: &str, key: &str| {
        if anime && truthy(server.get(anime_key)) {
            anime_key.to_owned()
        } else {
            key.to_owned()
        }
    };
    if routing.server_id.is_none() {
        routing.server_id = setting_int(server, "id")?;
    }
    if routing.profile_id.is_none() {
        routing.profile_id =
            setting_int(server, &anime_or("activeAnimeProfileId", "activeProfileId"))?;
    }
    if routing.root_folder.as_ref().is_none_or(String::is_empty) {
        routing.root_folder = match server.get(anime_or("activeAnimeDirectory", "activeDirectory"))
        {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.clone()),
            Some(_) => return Err(String::from("a sonarr directory that isn't text")),
        };
    }
    if routing.language_profile_id.is_none() {
        routing.language_profile_id = setting_int(
            server,
            &anime_or("activeAnimeLanguageProfileId", "activeLanguageProfileId"),
        )?;
    }
    if routing.tags.is_none() {
        let key = if anime { "animeTags" } else { "tags" };
        routing.tags = Some(match server.get(key) {
            Some(v) if truthy(Some(v)) => int_list(v, "sonarr tags")?,
            _ => Vec::new(),
        });
    }
    Ok(())
}

/// The requests of the media row (as its `requests` relation loads them)
/// and the other request rows sharing its TMDB id, type and quality.
async fn same_title(
    ctx: &Ready<'_>,
    tmdb_id: i64,
    body: &Body,
) -> Result<Vec<Map<String, Value>>, String> {
    if !body.is4k_given {
        // `request.is4k = NULL` matches nothing.
        return Ok(Vec::new());
    }
    ctx.state
        .db
        .rows(
            r#"SELECT CAST(r."status" AS BIGINT) AS "status", r."isAutoRequest" AS "auto", CAST(r."requestedById" AS BIGINT) AS "user", CAST(m."status" AS BIGINT) AS "media", CAST(m."status4k" AS BIGINT) AS "media4k" FROM "media_request" r INNER JOIN "media" m ON m."id" = r."mediaId" WHERE r."is4k" = ?1 AND m."tmdbId" = ?2 AND m."mediaType" = ?3 ORDER BY r."id" ASC"#,
            &[
                Bind::Bool(body.is4k),
                Bind::Int(tmdb_id),
                Bind::Text(body.media_type.to_owned()),
            ],
        )
        .await
        .map_err(|e| format!("database: {e:#}"))
}

/// The duplicate checks: an open movie request, or this user's own
/// auto-request for a title that isn't deleted.
fn duplicate(rows: &[Map<String, Value>], body: &Body, user_id: i64) -> Option<&'static str> {
    let int = |r: &Map<String, Value>, k: &str| r.get(k).and_then(Value::as_i64);
    if body.media_type == "movie" {
        if let Some(first) = rows.first() {
            if !matches!(int(first, "status"), Some(DECLINED | COMPLETED)) {
                tracing::warn!("Duplicate request for media blocked");
                return Some("Request for this media already exists.");
            }
        }
    }
    let media_key = if body.is4k { "media4k" } else { "media" };
    rows.iter()
        .any(|r| {
            int(r, "user") == Some(user_id)
                && truthy(r.get("auto"))
                && int(r, media_key) != Some(M_DELETED)
        })
        .then_some("Auto-request for this media and user already exists.")
}

/// `autoApprovalStatus`: approved, with the actor as modifier, when the
/// actor may auto-approve this kind of request.
const fn auto_approved(actor: &CurrentUser, movie: bool, four_k: bool) -> bool {
    let general = if four_k {
        AUTO_APPROVE_4K
    } else {
        AUTO_APPROVE
    };
    let specific = match (movie, four_k) {
        (true, true) => AUTO_APPROVE_4K_MOVIE,
        (true, false) => AUTO_APPROVE_MOVIE,
        (false, true) => AUTO_APPROVE_4K_TV,
        (false, false) => AUTO_APPROVE_TV,
    };
    actor.has_permission(general | specific | MANAGE_REQUESTS)
}

/// `buildSeasonRequestPlan`'s season list: requested seasons minus those
/// an active request or the library already covers.
fn plan_seasons(
    requested: &[i64],
    media: Option<&MediaRow>,
    requests: &[RequestRow],
    four_k: bool,
) -> Vec<i64> {
    let active: Vec<&RequestRow> = requests
        .iter()
        .filter(|r| r.is4k == four_k && r.status != DECLINED && r.status != COMPLETED)
        .collect();
    let mut covered: Vec<i64> = active
        .iter()
        .flat_map(|r| r.seasons.iter().map(|s| s.season_number))
        .collect();
    let episode_seasons: Vec<i64> = active
        .iter()
        .flat_map(|r| r.episodes.iter().map(|x| x.season_number))
        .collect();
    if let Some(media) = media {
        for season in &media.seasons {
            let status = if four_k {
                season.status4k
            } else {
                season.status
            };
            if status == M_AVAILABLE
                || (status == M_PROCESSING && !episode_seasons.contains(&season.season_number))
            {
                covered.push(season.season_number);
            }
        }
    }
    requested
        .iter()
        .copied()
        .filter(|s| !covered.contains(s))
        .collect()
}

/// The seasons asked for: `all` is every TMDB season with episodes but
/// specials; specials go unless enabled.
fn requested_seasons(ctx: &Ready<'_>, body: &Body, details: &Value) -> Result<Vec<i64>, String> {
    let list = match &body.seasons {
        Some(Seasons::List(list)) => list.clone(),
        Some(Seasons::All) => details
            .get("seasons")
            .and_then(Value::as_array)
            .ok_or_else(|| String::from("TMDB lists no seasons"))?
            .iter()
            .filter(|s| {
                s.get("season_number").and_then(Value::as_i64) != Some(0)
                    && s.get("episode_count").and_then(Value::as_i64).unwrap_or(0) > 0
            })
            .map(|s| {
                s.get("season_number")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| String::from("a season number that isn't whole"))
            })
            .collect::<Result<Vec<_>, _>>()?,
        None => return Err(String::from("a series request needs seasons")),
    };
    if truthy(ctx.settings.get("/main/enableSpecialEpisodes")) {
        Ok(list)
    } else {
        Ok(list.into_iter().filter(|s| *s > 0).collect())
    }
}

/// The media row as the request will reference it, and how its JSON
/// starts.
struct MediaPlan {
    existing: Option<MediaRow>,
    status: (i64, i64),
    tmdb_id: i64,
    tvdb_id: Option<i64>,
}

fn media_plan(
    existing: Option<MediaRow>,
    body: &Body,
    details: &Value,
) -> Result<MediaPlan, &'static str> {
    let found = details
        .get("id")
        .and_then(Value::as_i64)
        .unwrap_or(body.media_id);
    let tvdb = body.tvdb_id.or_else(|| {
        details
            .pointer("/external_ids/tvdb_id")
            .and_then(Value::as_i64)
    });
    let Some(media) = existing else {
        let pending = |four_k: bool| {
            if four_k == body.is4k {
                M_PENDING
            } else {
                M_UNKNOWN
            }
        };
        return Ok(MediaPlan {
            existing: None,
            status: (pending(false), pending(true)),
            tmdb_id: found,
            tvdb_id: tvdb,
        });
    };
    if media.status == M_BLOCKLISTED {
        tracing::warn!("Request for media blocked due to being blocklisted");
        return Err("This media is blocklisted.");
    }
    let bump = |status: i64, four_k: bool| {
        if four_k == body.is4k && (status == M_UNKNOWN || status == M_DELETED) {
            M_PENDING
        } else {
            status
        }
    };
    Ok(MediaPlan {
        status: (bump(media.status, false), bump(media.status4k, true)),
        existing: Some(media),
        tmdb_id: found,
        tvdb_id: tvdb,
    })
}

/// `Err` as the answer itself.
macro_rules! answer_on_err {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(why) => return Err(Outcome::forward(why)),
        }
    };
}

/// Everything `createRequest` decides before it writes.
struct Prepared {
    actor: UserRel,
    request_user: UserRel,
    plan: MediaPlan,
    routing: Routing,
    approved: bool,
    ignore_quota: bool,
    seasons: Vec<i64>,
    media_requests: Vec<RequestRow>,
    /// The episodes of an episode selection.
    episodes: Option<EpisodePlan>,
}

/// What an episode request is written with.
struct EpisodePlan {
    resolved: Resolved,
    episodes: Vec<CatalogEpisode>,
    units: i64,
    key: Option<String>,
    /// The active ongoing request this one replaces.
    replace: Option<RequestRow>,
}

/// A refused selection as the route answers it: `InvalidEpisodeSelectionError`
/// is a 400.
fn refused(ctx: &Ready<'_>, refused: Refused) -> Outcome {
    match refused {
        Refused::Invalid(message) => ctx.error(400, &message),
        Refused::Forward(why) => Outcome::forward(why),
    }
}

/// The checks of an `episodeSelection` once TMDB answered, and the
/// selection resolved unless it is a watch-ahead (that waits for the media
/// row).
async fn early_selection(
    ctx: &Ready<'_>,
    body: &Body,
    details: &Value,
) -> Result<Option<(Selection, Option<Resolved>)>, Outcome> {
    let Some(raw) = &body.episode_selection else {
        return Ok(None);
    };
    if body.media_type != "tv" || body.seasons.is_some() {
        return Err(ctx.error(
            400,
            "Episode selections are only valid for TV requests and cannot be combined with seasons.",
        ));
    }
    if !episodeselect::available(&ctx.settings, details) {
        return Err(ctx.error(
            409,
            "Episode requests require partial requests and the TVDB metadata provider.",
        ));
    }
    let selection = episodeselect::parse(raw).map_err(|r| refused(ctx, r))?;
    if let Selection::WatchAhead(_) = selection {
        return Ok(Some((selection, None)));
    }
    let catalog = episodeselect::catalog(ctx, body.media_id)
        .await
        .map_err(|r| refused(ctx, r))?;
    let resolved = episodeselect::resolve(selection, &catalog, specials(ctx), &HashSet::new())
        .map_err(|r| refused(ctx, r))?;
    Ok(Some((selection, Some(resolved))))
}

/// `settings.main.enableSpecialEpisodes`.
fn specials(ctx: &Ready<'_>) -> bool {
    truthy(ctx.settings.get("/main/enableSpecialEpisodes"))
}

/// `buildEpisodeRequestPlan` for a new request (replacing an ongoing one
/// is Node's).
fn episode_plan(
    ctx: &Ready<'_>,
    (user, request_user): (&CurrentUser, i64),
    body: &Body,
    p: (&MediaPlan, &[RequestRow], Quota, bool),
    resolved: Resolved,
) -> Result<EpisodePlan, Box<Outcome>> {
    let (plan, media_requests, tv_quota, ignore_quota) = p;
    let active = episodeselect::active(media_requests, body.is4k_given.then_some(body.is4k));
    let rolling = matches!(resolved.kind, "after" | "watchAhead");
    let existing_rolling = active.iter().find(|r| {
        matches!(
            r.episode_selection_type.as_deref(),
            Some("after" | "watchAhead")
        )
    });
    let replace = if let (true, Some(existing)) = (rolling, existing_rolling) {
        if existing.requested_by_id != Some(request_user) && !user.has_permission(MANAGE_REQUESTS) {
            return Err(Box::new(ctx.error(
                409,
                "An ongoing episode request already exists for this series.",
            )));
        }
        Some((*existing).clone())
    } else {
        None
    };
    let replaced = replace.as_ref().map(|r| r.id);
    let coverage: Vec<&RequestRow> = active
        .iter()
        .copied()
        .filter(|r| Some(r.id) != replaced)
        .collect();
    let episodes =
        episodeselect::uncovered(&resolved, &coverage, plan.existing.as_ref(), body.is4k);
    if episodes.is_empty() && resolved.kind != "watchAhead" {
        return Err(Box::new(ctx.error(202, "No episodes available to request")));
    }
    let units = episodeselect::quota_units(&episodes);
    let remaining =
        tv_quota.remaining.unwrap_or(0) + replace.as_ref().map_or(0, |r| r.tv_quota_units);
    if !ignore_quota && tv_quota.limit != 0 && units > remaining {
        return Err(Box::new(ctx.error(403, "Series Quota exceeded.")));
    }
    Ok(EpisodePlan {
        key: rolling.then(|| episodeselect::lock_key(plan.tmdb_id, body.is4k)),
        resolved,
        episodes,
        units,
        replace,
    })
}

/// The requesting user: the signed-in one, or `userId` for those who may
/// request on behalf of others; then their permission to request.
async fn request_user(
    ctx: &Ready<'_>,
    user: &CurrentUser,
    body: &Body,
    actor: &UserRel,
) -> Result<UserRel, Outcome> {
    let request_user = match body.user_id {
        Some(_) if !has_all(user.permissions, MANAGE_USERS | MANAGE_REQUESTS) => {
            return Err(ctx.error(
                403,
                "You do not have permission to modify the request user.",
            ));
        }
        Some(uid) => match ctx.state.db.user_record(uid).await {
            Ok(Some(rel)) => rel,
            // `findOneOrFail` throws into the handler's catch.
            Ok(None) => return Err(ctx.error(500, "User not found.")),
            Err(e) => return Err(ctx.error(500, &crate::db::failure_message(&e))),
        },
        None => actor.clone(),
    };
    let movie = body.media_type == "movie";
    let needed = match (movie, body.is4k) {
        (true, true) => REQUEST_4K | REQUEST_4K_MOVIE,
        (true, false) => REQUEST | REQUEST_MOVIE,
        (false, true) => REQUEST_4K | REQUEST_4K_TV,
        (false, false) => REQUEST | REQUEST_TV,
    };
    if !has_any(request_user.0.permissions, needed) {
        let four = if body.is4k { "4K " } else { "" };
        let what = if movie { "movie" } else { "series" };
        return Err(ctx.error(
            403,
            &format!("You do not have permission to make {four}{what} requests."),
        ));
    }
    Ok(request_user)
}

/// The quota checks (their failures are 403s); whether the request
/// ignores the quota.
fn quota_checks(user: &CurrentUser, body: &Body, quota: Quota) -> Result<bool, &'static str> {
    let can_bypass = user.has_permission(MANAGE_REQUESTS);
    let ignore_quota = body.ignore_quota == Some(true) && can_bypass && quota.limit > 0;
    if !ignore_quota {
        if body.ignore_quota == Some(true) && !can_bypass {
            return Err("You do not have permission to bypass user quota limits.");
        }
        if quota.restricted {
            return Err(if body.media_type == "movie" {
                "Movie Quota exceeded."
            } else {
                "Series Quota exceeded."
            });
        }
    }
    Ok(ignore_quota)
}

/// `createRequest` up to `persistPlan`: every check and decision.
async fn prepare(ctx: &Ready<'_>, user: &CurrentUser, body: &Body) -> Result<Prepared, Outcome> {
    let actor = answer_on_err!(current_user(ctx, user.id).await);
    let request_user = request_user(ctx, user, body, &actor).await?;
    let movie = body.media_type == "movie";
    let (movie_quota, tv_quota) = answer_on_err!(quotas(ctx, &request_user).await);
    let ignore_quota = quota_checks(user, body, if movie { movie_quota } else { tv_quota })
        .map_err(|m| ctx.error(403, m))?;
    let locale = main_locale(ctx);
    let details = if movie {
        ctx.state.tmdb.movie(body.media_id, &locale).await
    } else {
        ctx.state.tmdb.tv(body.media_id, &locale).await
    };
    let details = details.map_err(|e| episodeselect::tmdb_failed(ctx, movie, &e))?;
    let anime = super::tv::is_anime(&details);
    let early = early_selection(ctx, body, &details).await?;
    let db = &ctx.state.db;
    let existing = answer_on_err!(db
        .media_by_tmdb(body.media_id, body.media_type)
        .await
        .map_err(|e| format!("database: {e:#}")));
    let plan = media_plan(existing, body, &details).map_err(|m| ctx.error(403, m))?;
    let resolved = match early {
        Some((_, Some(resolved))) => Some(resolved),
        Some((selection, None)) => {
            Some(watch_ahead(ctx, body, &plan, selection, request_user.0.id).await?)
        }
        None => None,
    };
    let rows = answer_on_err!(same_title(ctx, plan.tmdb_id, body).await);
    if let Some(message) = duplicate(&rows, body, request_user.0.id) {
        return Err(ctx.error(409, message));
    }
    let mut routing = Routing {
        server_id: body.server_id,
        profile_id: body.profile_id,
        root_folder: body.root_folder.clone(),
        language_profile_id: body.language_profile_id,
        metadata_language_id: if movie {
            None
        } else {
            body.metadata_language_id
        },
        tags: body.tags.clone(),
    };
    if !user.has_permission(MANAGE_REQUESTS) {
        answer_on_err!(
            apply_rules(ctx, body, &details, anime, request_user.0.id, &mut routing).await
        );
    }
    if !movie {
        answer_on_err!(sonarr_defaults(ctx, body, anime, &mut routing));
    }
    let media_requests = match &plan.existing {
        Some(m) => answer_on_err!(db
            .requests_of_media(m.id)
            .await
            .map_err(|e| format!("database: {e:#}"))),
        None => Vec::new(),
    };
    let mut episodes = None;
    let seasons = if movie {
        Vec::new()
    } else if let Some(resolved) = resolved {
        episodes = Some(
            episode_plan(
                ctx,
                (user, request_user.0.id),
                body,
                (&plan, &media_requests, tv_quota, ignore_quota),
                resolved,
            )
            .map_err(|answer| *answer)?,
        );
        Vec::new()
    } else {
        let requested = answer_on_err!(requested_seasons(ctx, body, &details));
        // `request.is4k === undefined` holds for no loaded request.
        let compared: &[RequestRow] = if body.is4k_given {
            &media_requests
        } else {
            &[]
        };
        let seasons = plan_seasons(&requested, plan.existing.as_ref(), compared, body.is4k);
        if seasons.is_empty() {
            return Err(ctx.error(202, "No seasons available to request"));
        }
        let units = i64::try_from(seasons.len()).unwrap_or(i64::MAX);
        if !ignore_quota && tv_quota.limit != 0 && units > tv_quota.remaining.unwrap_or(0) {
            return Err(ctx.error(403, "Series Quota exceeded."));
        }
        seasons
    };
    Ok(Prepared {
        actor,
        request_user,
        plan,
        routing,
        approved: auto_approved(user, movie, body.is4k),
        ignore_quota,
        seasons,
        media_requests,
        episodes,
    })
}

/// A watch-ahead selection resolved once the media row is known: past
/// what the requester played of the series in Jellyfin.
async fn watch_ahead(
    ctx: &Ready<'_>,
    body: &Body,
    plan: &MediaPlan,
    selection: Selection,
    request_user: i64,
) -> Result<Resolved, Outcome> {
    let catalog = episodeselect::catalog(ctx, body.media_id)
        .await
        .map_err(|r| refused(ctx, r))?;
    let series = plan.existing.as_ref().and_then(|m| {
        if body.is4k {
            m.jellyfin_media_id4k.as_deref()
        } else {
            m.jellyfin_media_id.as_deref()
        }
    });
    let played = episodeselect::played(ctx, request_user, series, &catalog).await;
    episodeselect::resolve(selection, &catalog, specials(ctx), &played).map_err(|r| refused(ctx, r))
}

/// `MediaRequest.createRequest`: the checks, the writes, the insert hooks
/// and the entity as Node answers with it.
async fn create_request(ctx: &Ready<'_>, user: &CurrentUser, body: &Body) -> Outcome {
    let p = match prepare(ctx, user, body).await {
        Ok(p) => p,
        Err(answer) => return answer,
    };
    let media_head = forward_on_err!(
        existing_media_json(ctx, p.plan.existing.as_ref(), &p.media_requests).await
    );
    let requested_by = forward_on_err!(user_json(&p.request_user));
    let modified_by = if p.approved {
        Some(forward_on_err!(user_json(&p.actor)))
    } else {
        None
    };
    let status = if p.approved { APPROVED } else { PENDING };
    // Postgres's `int4` refuses a fraction and the save's transaction rolls
    // back: the new media row's `tvdbId` goes first, then the request's.
    if let Some(plan) = &p.episodes {
        if let Some(old) = &plan.replace {
            // The requester's JSON is built before any write.
            let people = (requested_by, modified_by);
            return replace_request(ctx, user, &p, plan, old, media_head, people).await;
        }
        if let Some(key) = &plan.key {
            // Node's insert breaks the unique index and its transaction
            // rolls back; nothing is written here.
            match episodeselect::ongoing_conflict(ctx, key, plan.resolved.kind, None).await {
                Ok(true) => return super::requestepisodes::conflict(ctx),
                Ok(false) => {}
                Err(e) => return Outcome::forward(format!("database: {e:#}")),
            }
        }
    }
    let written = write(ctx, body, &p, (status, p.approved.then_some(user.id))).await;
    let (request_id, media_id) = match written {
        Ok(ids) => ids,
        Err(e) => {
            // The transaction rolled back (a catalog repeating a TVDB id,
            // say); the catch answers with the error's message.
            tracing::error!("creating the request failed: {e:#}");
            return ctx.error(500, &crate::db::failure_message(&e));
        }
    };
    let media_now = fail_on_err!(ctx, media_row(ctx, media_id).await);
    let mut media_json = after_save_media_json(ctx, media_head, &media_now);
    // The answer and the insert hooks see the saved entities as they are
    // in memory: a new media row's `tvdbId` and the request's routing as
    // sent, where a read would `parseInt` them.
    if let (None, Some(tvdb), Value::Object(media)) =
        (&p.plan.existing, p.plan.tvdb_id, &mut media_json)
    {
        media.insert(String::from("tvdbId"), Value::from(tvdb));
    }
    let lc = Lc {
        state: Arc::clone(&ctx.shared),
        settings: Arc::clone(&ctx.settings),
    };
    let mut entity = match lc.load(request_id).await {
        Ok(Some(entity)) => entity,
        Ok(None) => return ctx.error(500, "the new request vanished"),
        Err(e) => return ctx.error(500, &format!("loading the new request failed: {e:#}")),
    };
    entity.row.server_id = p.routing.server_id;
    entity.row.profile_id = p.routing.profile_id;
    entity.row.language_profile_id = p.routing.language_profile_id;
    entity.row.metadata_language_id = p.routing.metadata_language_id;
    entity.media = Some(media_now);
    entity.requested_by = Some(p.request_user.clone());
    entity.modified_by = p.approved.then(|| p.actor.clone());
    let episode_rows = entity.row.episodes.clone();
    lc.after_insert(&mut entity).await;
    let mut draft = Draft::default();
    draft.put("type", Value::from(body.media_type));
    draft.put("media", media_json);
    draft.put("requestedBy", requested_by);
    draft.put("status", Value::from(entity.row.status));
    if let Some(modified_by) = modified_by {
        draft.put("modifiedBy", modified_by);
    }
    let episodes = p.episodes.as_ref().map(|plan| {
        (
            plan,
            episodeselect::episodes_json(&plan.episodes, status, &episode_rows),
        )
    });
    ctx.json_with(201, &request_json(draft, &entity.row, body, &p, episodes))
}

/// `persistEpisodeReplacement`: the active ongoing request takes the new
/// selection (its routing where the new one has a value, the requester,
/// the status unless already approved), its episodes are replaced, and
/// the update hooks run when the row changed. `people` is the
/// `requestedBy` and `modifiedBy` JSON.
async fn replace_request(
    ctx: &Ready<'_>,
    user: &CurrentUser,
    p: &Prepared,
    plan: &EpisodePlan,
    old: &RequestRow,
    media_head: Option<Map<String, Value>>,
    (requested_by, modified_by): (Value, Option<Value>),
) -> Outcome {
    let assigned = if p.approved { APPROVED } else { PENDING };
    let status = if old.status == APPROVED {
        APPROVED
    } else {
        assigned
    };
    let routing = &p.routing;
    let mut sets: Vec<(&'static str, Bind)> = Vec::new();
    if let Some(v) = routing.server_id.filter(|v| old.server_id != Some(*v)) {
        sets.push(("serverId", Bind::Int(v)));
    }
    if let Some(v) = routing.profile_id.filter(|v| old.profile_id != Some(*v)) {
        sets.push(("profileId", Bind::Int(v)));
    }
    if let Some(v) = routing
        .root_folder
        .as_ref()
        .filter(|v| old.root_folder.as_ref() != Some(*v))
    {
        sets.push(("rootFolder", Bind::Text(v.clone())));
    }
    if let Some(v) = routing
        .language_profile_id
        .filter(|v| old.language_profile_id != Some(*v))
    {
        sets.push(("languageProfileId", Bind::Int(v)));
    }
    if let Some(v) = routing
        .metadata_language_id
        .filter(|v| old.metadata_language_id != Some(*v))
    {
        sets.push(("metadataLanguageId", Bind::Int(v)));
    }
    if let Some(tags) = routing.tags.as_ref().map(|t| tags_text(t)) {
        if old.tags.as_ref() != Some(&tags) {
            sets.push(("tags", Bind::Text(tags)));
        }
    }
    if old.requested_by_id != Some(p.request_user.0.id) {
        sets.push(("requestedById", Bind::Int(p.request_user.0.id)));
    }
    if old.status != status {
        sets.push(("status", Bind::Int(status)));
    }
    if p.approved {
        if old.modified_by_id != Some(user.id) {
            sets.push(("modifiedById", Bind::Int(user.id)));
        }
    } else if old.modified_by_id.is_none() {
        // `TypeORM` counts an unset relation as changed.
        sets.push(("modifiedById", Bind::OptInt(None)));
    }
    let chosen = Resolved {
        episodes: plan.episodes.clone(),
        ..plan.resolved.clone()
    };
    sets.extend(super::requestepisodes::episode_columns(
        old,
        &chosen,
        plan.key.as_deref(),
    ));
    let written = replace_writes(ctx, p, old, &sets, (&plan.episodes, status)).await;
    if let Err(e) = written {
        tracing::error!("replacing request {} failed: {e:#}", old.id);
        return ctx.error(500, &crate::db::failure_message(&e));
    }
    let media_id = old.media_id.unwrap_or_default();
    let media_now = fail_on_err!(ctx, media_row(ctx, media_id).await);
    let media_json = after_save_media_json(ctx, media_head, &media_now);
    let lc = Lc {
        state: Arc::clone(&ctx.shared),
        settings: Arc::clone(&ctx.settings),
    };
    let mut entity = match lc.load(old.id).await {
        Ok(Some(entity)) => entity,
        Ok(None) => return ctx.error(500, "the request vanished"),
        Err(e) => return ctx.error(500, &format!("loading the request failed: {e:#}")),
    };
    let fresh = entity.row.clone();
    if !sets.is_empty() {
        // The update hooks see the routing as assigned in memory.
        let routing = &p.routing;
        entity.row.server_id = routing.server_id.or(entity.row.server_id);
        entity.row.profile_id = routing.profile_id.or(entity.row.profile_id);
        entity.row.language_profile_id = routing
            .language_profile_id
            .or(entity.row.language_profile_id);
        entity.row.metadata_language_id = routing
            .metadata_language_id
            .or(entity.row.metadata_language_id);
        entity.media = Some(media_now);
        lc.after_update(&mut entity).await;
    }
    let mut out = Map::new();
    super::request::columns(&mut out, old);
    let updated = !sets.is_empty();
    let number = |v: Option<i64>| v.map(Value::from);
    let given = |key: &str, value: Option<Value>, out: &mut Map<String, Value>| {
        if let Some(value) = value {
            out.insert(key.to_owned(), value);
        }
    };
    out.insert(String::from("status"), Value::from(status));
    if updated {
        out.insert(
            String::from("updatedAt"),
            fresh.updated_at.as_deref().map_or(Value::Null, Value::from),
        );
    }
    let r = &plan.resolved;
    out.insert(String::from("episodeSelectionType"), Value::from(r.kind));
    out.insert(String::from("episodeStartTvdbId"), Value::from(r.start));
    for (key, value) in [
        ("episodeEndTvdbId", number(r.end)),
        ("watchAheadCount", number(r.watch_ahead)),
        (
            "ongoingEpisodeRequestKey",
            plan.key.as_deref().map(Value::from),
        ),
    ] {
        match value {
            Some(value) => {
                out.insert(key.to_owned(), value);
            }
            None if updated => {
                out.insert(key.to_owned(), Value::Null);
            }
            None => {
                out.shift_remove(key);
            }
        }
    }
    out.insert(String::from("tvQuotaUnits"), Value::from(plan.units));
    given("serverId", routing.server_id.map(Value::from), &mut out);
    given("profileId", routing.profile_id.map(Value::from), &mut out);
    given(
        "rootFolder",
        routing.root_folder.clone().map(Value::from),
        &mut out,
    );
    given(
        "languageProfileId",
        routing.language_profile_id.map(Value::from),
        &mut out,
    );
    given(
        "metadataLanguageId",
        routing.metadata_language_id.map(Value::from),
        &mut out,
    );
    given(
        "tags",
        routing
            .tags
            .as_ref()
            .map(|t| Value::Array(t.iter().copied().map(Value::from).collect())),
        &mut out,
    );
    out.insert(String::from("media"), media_json);
    out.insert(String::from("requestedBy"), requested_by);
    out.insert(String::from("seasons"), Value::Array(Vec::new()));
    out.insert(
        String::from("episodes"),
        episodeselect::episodes_json(&plan.episodes, status, &fresh.episodes),
    );
    out.insert(
        String::from("seasonCount"),
        Value::from(i64::try_from(old.seasons.len()).unwrap_or(i64::MAX)),
    );
    if let Some(modified_by) = modified_by {
        out.insert(String::from("modifiedBy"), modified_by);
    }
    ctx.json_with(201, &Value::Object(out))
}

/// The `tags` column transformer's `to`.
fn tags_text(tags: &[i64]) -> String {
    let joined = tags
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(",");
    if joined.is_empty() {
        String::from("none")
    } else {
        joined
    }
}

/// The writes of a replacement: the media's status, the old episodes out,
/// the row's changed columns, the new episodes and the seasons let go.
async fn replace_writes(
    ctx: &Ready<'_>,
    p: &Prepared,
    old: &RequestRow,
    sets: &[(&'static str, Bind)],
    (episodes, status): (&[CatalogEpisode], i64),
) -> anyhow::Result<()> {
    let mut tx = Tx::begin(&ctx.state.db).await?;
    let db = &mut tx;
    if let Some(m) = &p.plan.existing {
        if (m.status, m.status4k) != p.plan.status {
            db.execute(
                r#"UPDATE "media" SET "status" = ?1, "status4k" = ?2, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?3"#,
                &[Bind::Int(p.plan.status.0), Bind::Int(p.plan.status.1), Bind::Int(m.id)],
            )
            .await?;
        }
    }
    db.execute(
        r#"DELETE FROM "episode_request" WHERE "requestId" = ?1"#,
        &[Bind::Int(old.id)],
    )
    .await?;
    if !sets.is_empty() {
        let mut binds: Vec<Bind> = sets.iter().map(|(_, b)| b.clone()).collect();
        let assignments: Vec<String> = sets
            .iter()
            .enumerate()
            .map(|(i, (column, _))| format!(r#""{column}" = ?{}"#, i + 1))
            .collect();
        binds.push(Bind::Int(old.id));
        db.execute(
            &format!(
                r#"UPDATE "media_request" SET {}, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?{}"#,
                assignments.join(", "),
                binds.len()
            ),
            &binds,
        )
        .await?;
    }
    episodeselect::insert_episodes(&mut Exec::Tx(db), old.id, episodes, status).await?;
    for season in &old.seasons {
        db.execute(
            r#"UPDATE "season_request" SET "requestId" = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?1"#,
            &[Bind::Int(season.id)],
        )
        .await?;
    }
    tx.commit().await
}

/// The media as the response prints it after the save: the loaded JSON
/// with the saved statuses, or the inserted row's.
fn after_save_media_json(
    ctx: &Ready<'_>,
    head: Option<Map<String, Value>>,
    media_now: &MediaRow,
) -> Value {
    head.map_or_else(
        || {
            inserted_media_json(
                media_now,
                &ctx.settings,
                &["tmdbId", "tvdbId", "status", "status4k", "mediaType"],
            )
        },
        |mut head| {
            head.insert(String::from("status"), Value::from(media_now.status));
            head.insert(String::from("status4k"), Value::from(media_now.status4k));
            head.insert(
                String::from("updatedAt"),
                media_now
                    .updated_at
                    .as_deref()
                    .map_or(Value::Null, Value::from),
            );
            Value::Object(head)
        },
    )
}

/// The rest of the new request's JSON after `type`, `media`,
/// `requestedBy`, `status` and `modifiedBy`.
fn request_json(
    mut draft: Draft,
    row: &RequestRow,
    body: &Body,
    p: &Prepared,
    episodes: Option<(&EpisodePlan, Value)>,
) -> Value {
    let routing = &p.routing;
    draft.put("is4k", Value::Bool(body.is4k));
    draft.set("serverId", routing.server_id.map(Value::from));
    draft.set("profileId", routing.profile_id.map(Value::from));
    draft.set("rootFolder", routing.root_folder.clone().map(Value::from));
    draft.set(
        "languageProfileId",
        routing.language_profile_id.map(Value::from),
    );
    draft.set(
        "metadataLanguageId",
        routing.metadata_language_id.map(Value::from),
    );
    draft.set(
        "tags",
        routing
            .tags
            .as_ref()
            .map(|t| Value::Array(t.iter().copied().map(Value::from).collect())),
    );
    draft.put("isAutoRequest", Value::Bool(body.is_auto_request));
    draft.put("ignoreQuota", Value::Bool(p.ignore_quota));
    if let Some((plan, list)) = episodes {
        let r = &plan.resolved;
        draft.put("seasons", Value::Array(Vec::new()));
        draft.put("episodes", list);
        draft.put("episodeSelectionType", Value::from(r.kind));
        draft.put("episodeStartTvdbId", Value::from(r.start));
        draft.set("episodeEndTvdbId", r.end.map(Value::from));
        draft.set("watchAheadCount", r.watch_ahead.map(Value::from));
        draft.set(
            "ongoingEpisodeRequestKey",
            plan.key.as_deref().map(Value::from),
        );
        draft.put("tvQuotaUnits", Value::from(plan.units));
    } else if body.media_type == "tv" {
        let text = |v: &Option<String>| v.as_deref().map_or(Value::Null, Value::from);
        let season_list: Vec<Value> = row
            .seasons
            .iter()
            .map(|s| {
                let mut out = Map::new();
                out.insert(String::from("seasonNumber"), Value::from(s.season_number));
                out.insert(String::from("status"), Value::from(s.status));
                out.insert(String::from("id"), Value::from(s.id));
                out.insert(String::from("createdAt"), text(&s.created_at));
                out.insert(String::from("updatedAt"), text(&s.updated_at));
                Value::Object(out)
            })
            .collect();
        draft.put("seasons", Value::Array(season_list));
        draft.put("episodes", Value::Array(Vec::new()));
        draft.put("tvQuotaUnits", Value::from(row.tv_quota_units));
    }
    let mut stored = Map::new();
    super::request::columns(&mut stored, row);
    draft.after_insert(&REQUEST_COLUMNS, &stored);
    draft.json()
}

/// The loaded media's JSON before the save: columns, `requests` (each with
/// its own media and users, as eager relations nest) and `seasons`.
async fn existing_media_json(
    ctx: &Ready<'_>,
    media: Option<&MediaRow>,
    requests: &[RequestRow],
) -> Result<Option<Map<String, Value>>, String> {
    let Some(media) = media else {
        return Ok(None);
    };
    let mut user_ids = Vec::new();
    for r in requests {
        user_ids.extend(r.requested_by_id);
        user_ids.extend(r.modified_by_id);
    }
    let related = Related::load(ctx, &[media.id], &user_ids, false).await?;
    let Value::Object(mut out) =
        crate::media::media_json(media, &ctx.settings, related.downloads(), false)
    else {
        return Err(String::from("media_json is not an object"));
    };
    let mut list = Vec::with_capacity(requests.len());
    for r in requests {
        let mut item = Map::new();
        super::request::columns(&mut item, r);
        item.insert(
            String::from("media"),
            related.media_json(ctx, r.media_id, false),
        );
        item.insert(
            String::from("requestedBy"),
            related.user_json(r.requested_by_id, false)?,
        );
        item.insert(
            String::from("modifiedBy"),
            related.user_json(r.modified_by_id, false)?,
        );
        item.insert(
            String::from("seasons"),
            super::request::seasons_json(&r.seasons),
        );
        item.insert(
            String::from("episodes"),
            super::request::episodes_json(&r.episodes),
        );
        item.insert(
            String::from("seasonCount"),
            super::request::count_of(&r.seasons),
        );
        list.push(Value::Object(item));
    }
    out.insert(String::from("requests"), Value::Array(list));
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
    Ok(Some(out))
}

/// `persistPlan`: the media row (inserted, or its status saved), the
/// request and its seasons. Returns the request and media ids.
async fn write(
    ctx: &Ready<'_>,
    body: &Body,
    p: &Prepared,
    (status, modified_by): (i64, Option<i64>),
) -> anyhow::Result<(i64, i64)> {
    // `dataSource.transaction` around the media and request saves.
    let mut tx = Tx::begin(&ctx.state.db).await?;
    let db = &mut tx;
    let (plan, routing, seasons) = (&p.plan, &p.routing, &p.seasons);
    let (ignore_quota, requested_by) = (p.ignore_quota, p.request_user.0.id);
    let media_id = match &plan.existing {
        None => {
            insert_media_in(
                &mut Exec::Tx(db),
                body.media_type,
                (plan.tmdb_id, plan.tvdb_id),
                plan.status,
            )
            .await?
        }
        Some(m) => {
            if (m.status, m.status4k) != plan.status {
                db.execute(
                    r#"UPDATE "media" SET "status" = ?1, "status4k" = ?2, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?3"#,
                    &[Bind::Int(plan.status.0), Bind::Int(plan.status.1), Bind::Int(m.id)],
                )
                .await?;
            }
            m.id
        }
    };
    let tags = routing.tags.as_ref().map(|t| {
        let joined = t.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
        if joined.is_empty() {
            String::from("none")
        } else {
            joined
        }
    });
    let episodes = p.episodes.as_ref();
    let units = episodes.map_or_else(
        || i64::try_from(seasons.len()).unwrap_or(i64::MAX),
        |e| e.units,
    );
    let request_id = Exec::Tx(db)
        .scalar(
            &format!(
                r#"INSERT INTO "media_request" ("status", "createdAt", "updatedAt", "type", "tvQuotaUnits", "is4k", "serverId", "profileId", "rootFolder", "languageProfileId", "tags", "isAutoRequest", "ignoreQuota", "mediaId", "requestedById", "modifiedById", "episodeSelectionType", "episodeStartTvdbId", "episodeEndTvdbId", "watchAheadCount", "ongoingEpisodeRequestKey", "metadataLanguageId") VALUES (?1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20){RETURNING_ID}"#
            ),
            &[
                Bind::Int(status),
                Bind::Text(body.media_type.to_owned()),
                Bind::Int(units),
                Bind::Bool(body.is4k),
                Bind::OptInt(routing.server_id),
                Bind::OptInt(routing.profile_id),
                Bind::OptText(routing.root_folder.clone()),
                Bind::OptInt(routing.language_profile_id),
                Bind::OptText(tags),
                Bind::Bool(body.is_auto_request),
                Bind::Bool(ignore_quota),
                Bind::Int(media_id),
                Bind::Int(requested_by),
                Bind::OptInt(modified_by),
                Bind::OptText(episodes.map(|e| e.resolved.kind.to_owned())),
                Bind::OptInt(episodes.map(|e| e.resolved.start)),
                Bind::OptInt(episodes.and_then(|e| e.resolved.end)),
                Bind::OptInt(episodes.and_then(|e| e.resolved.watch_ahead)),
                Bind::OptText(episodes.and_then(|e| e.key.clone())),
                Bind::OptInt(routing.metadata_language_id),
            ],
        )
        .await?;
    if let Some(plan) = episodes {
        episodeselect::insert_episodes(&mut Exec::Tx(db), request_id, &plan.episodes, status)
            .await?;
    }
    for season in seasons {
        db.execute(
            r#"INSERT INTO "season_request" ("seasonNumber", "status", "createdAt", "updatedAt", "requestId") VALUES (?1, ?2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?3)"#,
            &[Bind::Int(*season), Bind::Int(status), Bind::Int(request_id)],
        )
        .await?;
    }
    tx.commit().await?;
    Ok((request_id, media_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_edit_may_reuse_its_own_units() {
        let tv = Quota {
            limit: 2,
            remaining: Some(1),
            restricted: false,
        };
        assert!(!tv.edit_exceeds(false, 2, 1), "one more season fits");
        assert!(tv.edit_exceeds(false, 3, 1), "two more do not");
        assert!(!tv.edit_exceeds(true, 3, 1), "ignoreQuota");
        let spent = Quota {
            limit: 1,
            remaining: Some(0),
            restricted: true,
        };
        assert!(!spent.edit_exceeds(false, 1, 1), "keeping its own season");
        assert!(
            spent.edit_exceeds(false, 2, 1),
            "growing past a spent quota"
        );
        assert!(!Quota::default().edit_exceeds(false, 9, 0), "no limit");
    }

    #[test]
    fn rule_numbers_read_like_number() {
        assert_eq!(rule_numbers("1, 2,").ok(), Some(vec![1, 2, 0]), "lists");
        assert!(rule_numbers("1e2").is_err(), "odd shapes go to Node");
    }

    #[test]
    fn seasons_left_to_request() {
        let season = |id: i64, status: i64| crate::db::SeasonRow {
            id,
            season_number: id,
            status,
            status4k: M_UNKNOWN,
            created_at: None,
            updated_at: None,
            media_id: None,
        };
        let media = MediaRow {
            seasons: vec![season(1, M_AVAILABLE), season(2, M_PROCESSING)],
            ..MediaRow::default()
        };
        assert_eq!(
            plan_seasons(&[1, 2, 3], Some(&media), &[], false),
            vec![3],
            "available and processing seasons are covered"
        );
        assert_eq!(
            plan_seasons(&[1, 2, 3], Some(&media), &[], true),
            vec![1, 2, 3],
            "4K looks at the 4K status"
        );
    }

    #[test]
    fn body_shapes() {
        let Value::Object(ok) = json!({"mediaType": "tv", "mediaId": 5, "is4k": false, "seasons": "all", "userId": null})
        else {
            return;
        };
        let body = parse_body(&ok);
        assert_eq!(
            body.as_ref().ok().map(|b| (b.seasons.clone(), b.user_id)),
            Some((Some(Seasons::All), None)),
            "all seasons, no user"
        );
        let Value::Object(no_4k) = json!({"mediaType": "movie", "mediaId": 5}) else {
            return;
        };
        assert_eq!(
            parse_body(&no_4k).ok().map(|b| (b.is4k, b.is4k_given)),
            Some((false, false)),
            "an undefined is4k"
        );
    }
}
