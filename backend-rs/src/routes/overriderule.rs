//! `server/lib/overrideRules` and `POST /overrideRule/advancedRequest`.
//!
//! Override rules pick a root folder, quality profile and tags for a
//! title by its genres, language, keywords and requester. Request creation
//! applies them for users who can't choose these themselves; the advanced
//! requester asks this route what they would pick, so the modal starts
//! from the same values. Ported from seerr-team/seerr#2164.

use std::future::Future;
use std::pin::Pin;

use axum::http::Method;
use serde_json::{Map, Value};

use super::draft::{body_object, forward_on_err};
use super::{Outcome, Ready, Table};
use crate::auth::CurrentUser;
use crate::db::OverrideRuleRow;
use crate::settings::public::truthy;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// `Permission` bits.
const MANAGE_USERS: i64 = 8;
const MANAGE_REQUESTS: i64 = 16;
const REQUEST_ADVANCED: i64 = 8192;

/// TMDB's `anime` keyword.
const ANIME_KEYWORD_ID: i64 = 210_024;

/// This module's routes.
pub(super) const ROUTES: &Table = &[(
    "/api/v1/overrideRule/advancedRequest",
    Method::POST,
    advanced_request,
)];

/// `OverrideRulesResult`: what the most specific matching rule sets.
/// `tags` is the given tags with the rule's merged in, or the given tags
/// as they were when the rule sets none.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct RuleResult {
    pub(super) root_folder: Option<String>,
    pub(super) profile_id: Option<i64>,
    pub(super) tags: Option<Vec<i64>>,
}

impl RuleResult {
    fn json(&self) -> Value {
        let mut out = Map::new();
        out.insert(
            String::from("rootFolder"),
            self.root_folder.as_deref().map_or(Value::Null, Value::from),
        );
        out.insert(
            String::from("profileId"),
            self.profile_id.map_or(Value::Null, Value::from),
        );
        out.insert(
            String::from("tags"),
            self.tags.as_ref().map_or(Value::Null, |t| {
                Value::Array(t.iter().copied().map(Value::from).collect())
            }),
        );
        Value::Object(out)
    }
}

/// What the rules are evaluated for.
#[derive(Debug, Clone, Copy)]
pub(super) struct RuleInput<'a> {
    /// Radarr's rules for a movie, Sonarr's for anything else.
    pub(super) movie: bool,
    pub(super) is4k: bool,
    /// The server whose rules apply; `None` is the default server of this
    /// kind and quality.
    pub(super) service_id: Option<i64>,
    /// TMDB's details, with keywords.
    pub(super) details: &'a Value,
    /// The title is anime (only read for TV).
    pub(super) anime: bool,
    /// The user the request is for.
    pub(super) user_id: i64,
}

/// `Number(piece)` for the id lists override rules store; anything but
/// digits (or nothing, which is 0) is an error.
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

pub(super) fn rule_numbers(list: &str) -> Result<Vec<i64>, String> {
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
    // Anime TV is routed by the server's anime settings; only rules that
    // name the anime keyword apply to it.
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

/// How many of genre, language and keywords a rule names (blank values
/// don't count).
fn specificity(rule: &OverrideRuleRow) -> usize {
    [&rule.genre, &rule.language, &rule.keywords]
        .iter()
        .filter(|v| v.as_deref().is_some_and(|s| !s.trim().is_empty()))
        .count()
}

/// The id of the default server of this kind and quality, if there is one.
fn default_service(ctx: &Ready<'_>, movie: bool, is4k: bool) -> Result<Option<i64>, String> {
    let section = if movie { "/radarr" } else { "/sonarr" };
    let id = ctx
        .settings
        .get(section)
        .and_then(Value::as_array)
        .and_then(|servers| {
            servers
                .iter()
                .find(|s| truthy(s.get("is4k")) == is4k && truthy(s.get("isDefault")))
        })
        .and_then(|s| s.get("id"));
    id.map_or(Ok(None), |id| {
        id.as_i64()
            .map(Some)
            .ok_or_else(|| String::from("a server id that isn't a whole number"))
    })
}

/// The most specific rule of the server (`input.service_id`, or the
/// default of this kind and quality) that applies to this title and user.
pub(super) async fn matching_rule(
    ctx: &Ready<'_>,
    input: RuleInput<'_>,
) -> Result<Option<OverrideRuleRow>, String> {
    let service_id = match input.service_id {
        Some(id) => id,
        None => match default_service(ctx, input.movie, input.is4k)? {
            Some(id) => id,
            None => return Ok(None),
        },
    };
    let rules = ctx
        .state
        .db
        .override_rules()
        .await
        .map_err(|e| format!("loading override rules failed: {e:#}"))?;
    let tv_anime = !input.movie && input.anime;
    let mut applied = Vec::new();
    for rule in rules {
        let service = if input.movie {
            rule.radarr_service_id
        } else {
            rule.sonarr_service_id
        };
        if service == Some(service_id)
            && rule_applies(&rule, input.details, tv_anime, input.user_id)?
        {
            applied.push(rule);
        }
    }
    // Stable, so rules equally specific keep their table order.
    applied.sort_by_key(|r| std::cmp::Reverse(specificity(r)));
    Ok(applied.into_iter().next())
}

/// `overrideRules()`: what the matching rule sets, its tags merged over
/// `tags`.
pub(super) async fn evaluate(
    ctx: &Ready<'_>,
    input: RuleInput<'_>,
    tags: Option<Vec<i64>>,
) -> Result<RuleResult, String> {
    let mut result = RuleResult {
        tags,
        ..RuleResult::default()
    };
    let Some(rule) = matching_rule(ctx, input).await? else {
        return Ok(result);
    };
    if let Some(root) = rule.root_folder.as_ref().filter(|r| !r.is_empty()) {
        result.root_folder = Some(root.clone());
    }
    if let Some(profile) = rule.profile_id.filter(|p| *p != 0) {
        result.profile_id = Some(profile);
    }
    if let Some(tags) = rule.tags.as_ref().filter(|t| !t.is_empty()) {
        let mut merged = result.tags.take().unwrap_or_default();
        merged.extend(rule_numbers(tags)?);
        let mut unique: Vec<i64> = Vec::with_capacity(merged.len());
        for tag in merged {
            if !unique.contains(&tag) {
                unique.push(tag);
            }
        }
        result.tags = Some(unique);
    }
    Ok(result)
}

/// The body of `POST /overrideRule/advancedRequest`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Body {
    movie: bool,
    tmdb_id: i64,
    is4k: bool,
    /// `requestId`, when truthy.
    request_id: Option<i64>,
    /// `requestUser`, when truthy.
    request_user: Option<i64>,
    tags: Option<Vec<i64>>,
    /// `serviceId`; missing and `null` both mean the default server.
    service_id: Option<i64>,
}

/// An optional whole number: missing and `null` are `None`.
fn opt_int(body: &Map<String, Value>, key: &str) -> Result<Option<i64>, super::Fallback> {
    match body.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => super::params::body_int(body, key),
    }
}

fn parse_body(body: &Map<String, Value>) -> Result<Body, super::Fallback> {
    let media_type = match body.get("mediaType") {
        Some(Value::String(s)) => s.as_str(),
        _ => return Err(super::Fallback::status(400, "mediaType is required.")),
    };
    let tmdb_id = opt_int(body, "tmdbId")?
        .ok_or_else(|| super::Fallback::status(400, "tmdbId is required."))?;
    let is4k = match body.get("is4k") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err(super::Fallback::status(400, "is4k must be a boolean.")),
    };
    let tags = match body.get("tags") {
        None | Some(Value::Null) => None,
        Some(Value::Array(items)) => Some(
            items
                .iter()
                .map(Value::as_i64)
                .collect::<Option<Vec<i64>>>()
                .ok_or_else(|| super::Fallback::status(400, "tags must be integers."))?,
        ),
        Some(_) => return Err(super::Fallback::status(400, "tags must be a list.")),
    };
    Ok(Body {
        movie: media_type == "movie",
        tmdb_id,
        is4k,
        request_id: opt_int(body, "requestId")?.filter(|id| *id != 0),
        request_user: opt_int(body, "requestUser")?.filter(|id| *id != 0),
        tags,
        service_id: opt_int(body, "serviceId")?,
    })
}

/// The id of the user the rules are evaluated for, or the answer to give.
async fn rule_user(ctx: &Ready<'_>, user: &CurrentUser, body: &Body) -> Result<i64, Outcome> {
    let user_id = user.id;
    let has = |bits: i64| user.has_permission(bits);
    let may_pick_user = user.has_all_permissions(MANAGE_USERS | MANAGE_REQUESTS);
    let failed = || ctx.error(500, "Unable to evaluate override rules.");
    let mut rule_user = user_id;
    if let Some(request_id) = body.request_id {
        let request = match ctx.state.db.request_by_id(request_id).await {
            Ok(Some(request)) => request,
            Ok(None) => return Err(ctx.error(404, "Request not found.")),
            Err(e) => {
                tracing::error!("loading request {request_id} failed: {e:#}");
                return Err(failed());
            }
        };
        let Some(owner) = request.requested_by_id else {
            return Err(failed());
        };
        // An edit is only offered to the requester (TV for anyone, other
        // media with advanced requests) or to request managers.
        if (owner != user_id || (body.movie && !has(REQUEST_ADVANCED))) && !has(MANAGE_REQUESTS) {
            return Err(ctx.error(403, "You do not have permission to modify this request."));
        }
        rule_user = owner;
        if let Some(requested) = body.request_user {
            if requested != owner && !may_pick_user {
                return Err(ctx.error(
                    403,
                    "You do not have permission to modify the request user.",
                ));
            }
            rule_user = requested;
        }
    } else if let Some(requested) = body.request_user.filter(|id| *id != user_id) {
        if !may_pick_user {
            return Err(ctx.error(
                403,
                "You do not have permission to modify the request user.",
            ));
        }
        rule_user = requested;
    }
    if rule_user != user_id {
        // `findOneOrFail`: a user that isn't there fails the route.
        match ctx.state.db.user_record(rule_user).await {
            Ok(Some(_)) => {}
            Ok(None) => return Err(failed()),
            Err(e) => {
                tracing::error!("loading user {rule_user} failed: {e:#}");
                return Err(failed());
            }
        }
    }
    Ok(rule_user)
}

/// `POST /overrideRule/advancedRequest`: what the override rules would
/// set for this request, for the advanced requester to start from.
fn advanced_request<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        forward_on_err!(ctx.no_query());
        let user = forward_on_err!(ctx.authenticated(REQUEST_ADVANCED | MANAGE_REQUESTS));
        let raw = forward_on_err!(body_object(ctx));
        let body = forward_on_err!(parse_body(raw));
        let locale = super::listwrite::main_locale(ctx);
        let details = if body.movie {
            ctx.state.tmdb.movie(body.tmdb_id, &locale).await
        } else {
            ctx.state.tmdb.tv(body.tmdb_id, &locale).await
        };
        let details = match details {
            Ok(details) => details,
            Err(e) => {
                tracing::debug!("TMDB lookup of {} failed: {e:#}", body.tmdb_id);
                return ctx.error(404, "Media not found");
            }
        };
        let user_id = match rule_user(ctx, user, &body).await {
            Ok(id) => id,
            Err(answer) => return answer,
        };
        let input = RuleInput {
            movie: body.movie,
            is4k: body.is4k,
            service_id: body.service_id,
            details: &details,
            anime: super::tv::is_anime(&details),
            user_id,
        };
        match evaluate(ctx, input, body.tags.clone()).await {
            Ok(result) => ctx.json(&result.json()),
            Err(why) => {
                tracing::error!(
                    "Something went wrong evaluating override rules for {}: {why}",
                    body.tmdb_id
                );
                ctx.error(500, "Unable to evaluate override rules.")
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::json;

    use crate::dbtx::scratch;
    use crate::routes::testkit::Kit;

    const URI: &str = "/api/v1/overrideRule/advancedRequest";
    const ADMIN: (i64, i64) = (1, 2);
    const ADVANCED: (i64, i64) = (2, 32 | REQUEST_ADVANCED);
    const PLAIN: (i64, i64) = (3, 32);
    const MANAGER: (i64, i64) = (4, MANAGE_REQUESTS);

    /// A movie in genre 28, one in no genre, and an anime show.
    const ACTION_MOVIE: i64 = 9_100_001;
    const PLAIN_MOVIE: i64 = 9_100_002;
    const ANIME_SHOW: i64 = 9_100_003;

    const SEED: [&str; 13] = [
        r#"INSERT INTO "user" ("id", "email", "avatar", "permissions") VALUES (1, 'admin@example.test', '', 2)"#,
        r#"INSERT INTO "user" ("id", "email", "avatar", "permissions") VALUES (2, 'advanced@example.test', '', 8224)"#,
        r#"INSERT INTO "user" ("id", "email", "avatar", "permissions") VALUES (3, 'plain@example.test', '', 32)"#,
        r#"INSERT INTO "user" ("id", "email", "avatar", "permissions") VALUES (4, 'manager@example.test', '', 16)"#,
        r#"INSERT INTO "media" ("id", "mediaType", "tmdbId", "status") VALUES (1, 'movie', 9100002, 2)"#,
        r#"INSERT INTO "media_request" ("id", "status", "type", "mediaId", "requestedById") VALUES (1, 1, 'movie', 1, 2)"#,
        r#"INSERT INTO "media_request" ("id", "status", "type", "mediaId", "requestedById") VALUES (2, 1, 'movie', 1, 3)"#,
        // The default Radarr: by genre, and for user 3 alone.
        r#"INSERT INTO "override_rule" ("radarrServiceId", "genre", "rootFolder", "profileId", "tags") VALUES (0, '28', '/action', 7, '3')"#,
        r#"INSERT INTO "override_rule" ("radarrServiceId", "users", "rootFolder") VALUES (0, '3', '/user3')"#,
        // An empty genre is no more specific than none, so the rule
        // above, first in the table, wins.
        r#"INSERT INTO "override_rule" ("radarrServiceId", "users", "genre", "rootFolder") VALUES (0, '3', '', '/blank')"#,
        // Another Radarr.
        r#"INSERT INTO "override_rule" ("radarrServiceId", "rootFolder", "tags") VALUES (1, '/other', '4,4')"#,
        // The default Sonarr: anime only by keyword.
        r#"INSERT INTO "override_rule" ("sonarrServiceId", "rootFolder") VALUES (0, '/tv')"#,
        r#"INSERT INTO "override_rule" ("sonarrServiceId", "keywords", "rootFolder") VALUES (0, '210024', '/anime')"#,
    ];

    async fn kit(tag: &str) -> anyhow::Result<(scratch::Scratch, Kit)> {
        let scratch = scratch::sqlite(tag).await?;
        scratch::run(&scratch.db, &SEED).await?;
        let kit = Kit::new(
            tag,
            scratch.db.clone(),
            json!({
                "radarr": [
                    {"id": 0, "is4k": false, "isDefault": true},
                    {"id": 1, "is4k": false, "isDefault": false},
                ],
                "sonarr": [{"id": 0, "is4k": false, "isDefault": true}],
            }),
        )?;
        let movie = |id: i64, genres: Value| json!({"id": id, "title": "M", "genres": genres, "original_language": "en", "keywords": {"keywords": []}});
        crate::tmdb::remember_title_for_tests(
            "movie",
            ACTION_MOVIE,
            "en",
            movie(ACTION_MOVIE, json!([{"id": 28, "name": "Action"}])),
        );
        crate::tmdb::remember_title_for_tests(
            "movie",
            PLAIN_MOVIE,
            "en",
            movie(PLAIN_MOVIE, json!([])),
        );
        crate::tmdb::remember_title_for_tests(
            "tv",
            ANIME_SHOW,
            "en",
            json!({"id": ANIME_SHOW, "name": "A", "genres": [], "original_language": "ja", "keywords": {"results": [{"id": ANIME_KEYWORD_ID, "name": "anime"}]}}),
        );
        Ok((scratch, kit))
    }

    async fn post(kit: &Kit, user: (i64, i64), body: Value) -> anyhow::Result<(u16, Value)> {
        kit.call(
            advanced_request,
            (Method::POST, URI),
            Some(user),
            Some(body),
        )
        .await
    }

    fn answer(root: Option<&str>, profile: Option<i64>, tags: Option<&Value>) -> Value {
        json!({"rootFolder": root, "profileId": profile, "tags": tags})
    }

    #[test]
    fn rule_numbers_read_like_number() {
        assert_eq!(rule_numbers("1, 2,").ok(), Some(vec![1, 2, 0]), "lists");
        assert!(rule_numbers("1e2").is_err(), "odd shapes are refused");
    }

    #[tokio::test]
    async fn only_advanced_requesters_and_managers_may_ask() -> anyhow::Result<()> {
        let (_scratch, kit) = kit("advreq-perm").await?;
        let body = json!({"mediaType": "movie", "tmdbId": ACTION_MOVIE});
        let (status, json) = post(&kit, PLAIN, body.clone()).await?;
        assert_eq!(status, 403, "a plain requester");
        assert_eq!(
            json.get("error").and_then(Value::as_str),
            Some("You do not have permission to access this endpoint"),
            "isAuthenticated's answer"
        );
        let (status, _) = kit
            .call(
                advanced_request,
                (Method::POST, URI),
                None,
                Some(body.clone()),
            )
            .await?;
        assert_eq!(status, 403, "nobody signed in");
        assert_eq!(post(&kit, MANAGER, body.clone()).await?.0, 200, "a manager");
        assert_eq!(post(&kit, ADVANCED, body).await?.0, 200, "advanced");
        Ok(())
    }

    #[tokio::test]
    async fn the_default_servers_most_specific_rule() -> anyhow::Result<()> {
        let (_scratch, kit) = kit("advreq-default").await?;
        let (status, json) = post(
            &kit,
            ADVANCED,
            json!({"mediaType": "movie", "tmdbId": ACTION_MOVIE, "is4k": false, "tags": [1, 3]}),
        )
        .await?;
        assert_eq!(status, 200, "evaluated");
        assert_eq!(
            json,
            answer(Some("/action"), Some(7), Some(&json!([1, 3]))),
            "the genre rule, its tag merged once"
        );
        let (_, json) = post(
            &kit,
            ADVANCED,
            json!({"mediaType": "movie", "tmdbId": PLAIN_MOVIE}),
        )
        .await?;
        assert_eq!(json, answer(None, None, None), "no rule applies");
        let (_, json) = post(
            &kit,
            ADVANCED,
            json!({"mediaType": "movie", "tmdbId": PLAIN_MOVIE, "is4k": true, "tags": [5]}),
        )
        .await?;
        assert_eq!(
            json,
            answer(None, None, Some(&json!([5]))),
            "no 4K default server: the tags as given"
        );
        Ok(())
    }

    #[tokio::test]
    async fn the_chosen_server_and_anime() -> anyhow::Result<()> {
        let (_scratch, kit) = kit("advreq-server").await?;
        let (_, json) = post(
            &kit,
            ADVANCED,
            json!({"mediaType": "movie", "tmdbId": ACTION_MOVIE, "serviceId": 1, "requestId": null}),
        )
        .await?;
        assert_eq!(
            json,
            answer(Some("/other"), None, Some(&json!([4]))),
            "server 1's rule"
        );
        let (_, json) = post(
            &kit,
            ADVANCED,
            json!({"mediaType": "movie", "tmdbId": ACTION_MOVIE, "serviceId": null}),
        )
        .await?;
        assert_eq!(
            json.get("rootFolder"),
            Some(&json!("/action")),
            "null is the default server"
        );
        let (_, json) = post(
            &kit,
            ADVANCED,
            json!({"mediaType": "tv", "tmdbId": ANIME_SHOW}),
        )
        .await?;
        assert_eq!(
            json,
            answer(Some("/anime"), None, None),
            "only the anime keyword rule"
        );
        Ok(())
    }

    #[tokio::test]
    async fn rules_for_another_requester() -> anyhow::Result<()> {
        let (_scratch, kit) = kit("advreq-user").await?;
        let for_user =
            |user: Value| json!({"mediaType": "movie", "tmdbId": PLAIN_MOVIE, "requestUser": user});
        let (_, json) = post(&kit, ADMIN, for_user(json!(3))).await?;
        assert_eq!(
            json.get("rootFolder"),
            Some(&json!("/user3")),
            "user 3's rule; the empty genre counts for nothing"
        );
        let (_, json) = post(&kit, ADMIN, for_user(json!(null))).await?;
        assert_eq!(json, answer(None, None, None), "the admin's own");
        let (status, json) = post(&kit, ADVANCED, for_user(json!(3))).await?;
        assert_eq!(status, 403, "an advanced requester can't pick the user");
        assert_eq!(
            json.get("message").and_then(Value::as_str),
            Some("You do not have permission to modify the request user."),
            "the message"
        );
        assert_eq!(
            post(&kit, MANAGER, for_user(json!(3))).await?.0,
            403,
            "managing users too is needed"
        );
        assert_eq!(
            post(&kit, ADVANCED, for_user(json!(2))).await?.0,
            200,
            "naming oneself is fine"
        );
        let (status, json) = post(&kit, ADMIN, for_user(json!(99))).await?;
        assert_eq!(status, 500, "an unknown user fails the route");
        assert_eq!(
            json.get("message").and_then(Value::as_str),
            Some("Unable to evaluate override rules."),
            "the message"
        );
        Ok(())
    }

    #[tokio::test]
    async fn rules_for_an_existing_request() -> anyhow::Result<()> {
        let (_scratch, kit) = kit("advreq-request").await?;
        let edit = |id: i64| json!({"mediaType": "movie", "tmdbId": PLAIN_MOVIE, "requestId": id});
        let (status, json) = post(&kit, ADVANCED, edit(99)).await?;
        assert_eq!(status, 404, "no such request");
        assert_eq!(
            json.get("message").and_then(Value::as_str),
            Some("Request not found."),
            "the message"
        );
        let (status, json) = post(&kit, ADVANCED, edit(2)).await?;
        assert_eq!(status, 403, "someone else's request");
        assert_eq!(
            json.get("message").and_then(Value::as_str),
            Some("You do not have permission to modify this request."),
            "the message"
        );
        let (status, json) = post(&kit, ADVANCED, edit(1)).await?;
        assert_eq!(
            (status, json),
            (200, answer(None, None, None)),
            "one's own request"
        );
        let (status, json) = post(&kit, MANAGER, edit(2)).await?;
        assert_eq!(status, 200, "a manager edits anyone's");
        assert_eq!(
            json.get("rootFolder"),
            Some(&json!("/user3")),
            "for its requester"
        );
        let mut body = edit(2);
        if let Some(map) = body.as_object_mut() {
            map.insert(String::from("requestUser"), json!(2));
        }
        assert_eq!(
            post(&kit, MANAGER, body.clone()).await?.0,
            403,
            "but can't move it to another user"
        );
        let (_, json) = post(&kit, ADMIN, body).await?;
        assert_eq!(
            json,
            answer(None, None, None),
            "an admin can: user 2's rules"
        );
        Ok(())
    }

    #[tokio::test]
    async fn odd_bodies() -> anyhow::Result<()> {
        let (_scratch, kit) = kit("advreq-body").await?;
        let (status, _) =
            post(&kit, ADVANCED, json!({"mediaType": "movie", "tmdbId": 1.5})).await?;
        assert_eq!(status, 400, "a fractional id");
        let (status, _) = post(
            &kit,
            ADVANCED,
            json!({"mediaType": "movie", "tmdbId": 1, "tags": ["x"]}),
        )
        .await?;
        assert_eq!(status, 400, "a tag that isn't a number");
        Ok(())
    }
}
