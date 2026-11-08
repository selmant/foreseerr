//! AI recommendations for the signed-in user: start a run and follow it,
//! the Discover row's daily picks, feedback on titles, and the taste card.
//!
//! Like `/ai/me`, every route acts on the signed-in user only.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use axum::http::Method;
use serde_json::{json, Map, Value};

use super::movie::{map_movie_result, RelatedTitles};
use super::ratingsenrich::enrich_results_with_ratings;
use super::tv::map_tv_result;
use super::{params, Outcome, Ready, Table};
use crate::ai::recs::retrieve::kind_of;
use crate::ai::recs::store::{self, Origin, Verdict};
use crate::ai::recs::{self, prompts::TASTE_MAX_CHARS, Request};
use crate::ai::{AiError, Policy};
use crate::auth::CurrentUser;
use crate::db::Bind;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/ai/recommend", Method::POST, recommend),
    ("/api/v1/ai/runs", Method::GET, runs),
    ("/api/v1/ai/runs", Method::DELETE, runs_delete),
    ("/api/v1/ai/runs/{runId}", Method::GET, run_get),
    ("/api/v1/ai/runs/{runId}", Method::DELETE, run_delete),
    ("/api/v1/ai/weekly", Method::GET, weekly),
    ("/api/v1/ai/row", Method::GET, row_cached),
    ("/api/v1/ai/row", Method::POST, row),
    ("/api/v1/ai/feedback", Method::GET, feedback_list),
    ("/api/v1/ai/feedback", Method::POST, feedback_set),
    ("/api/v1/ai/feedback", Method::DELETE, feedback_clear),
    ("/api/v1/ai/taste", Method::GET, taste_get),
    ("/api/v1/ai/taste", Method::PUT, taste_put),
];

fn fail(ctx: &Ready<'_>, e: &AiError) -> Outcome {
    ctx.json_with(e.status(), &e.to_json())
}

fn db_err(e: &anyhow::Error) -> AiError {
    AiError::internal(format!("{e:#}"))
}

fn body(ctx: &Ready<'_>) -> Map<String, Value> {
    ctx.body
        .as_ref()
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// Run `work` for the signed-in user with AI turned on, answering its
/// JSON or its error.
fn answer<'a, F, Fut>(ctx: &'a Ready<'a>, work: F) -> Native<'a>
where
    F: FnOnce(&'a Ready<'a>, &'a CurrentUser) -> Fut + Send + 'a,
    Fut: Future<Output = Result<Value, AiError>> + Send + 'a,
{
    respond(ctx, true, work)
}

/// [`answer`] for deleting someone's own data, which works with AI turned
/// off too.
fn answer_always<'a, F, Fut>(ctx: &'a Ready<'a>, work: F) -> Native<'a>
where
    F: FnOnce(&'a Ready<'a>, &'a CurrentUser) -> Fut + Send + 'a,
    Fut: Future<Output = Result<Value, AiError>> + Send + 'a,
{
    respond(ctx, false, work)
}

fn respond<'a, F, Fut>(ctx: &'a Ready<'a>, needs_ai: bool, work: F) -> Native<'a>
where
    F: FnOnce(&'a Ready<'a>, &'a CurrentUser) -> Fut + Send + 'a,
    Fut: Future<Output = Result<Value, AiError>> + Send + 'a,
{
    Box::pin(async move {
        let user = match ctx.require(0) {
            Ok(u) => u,
            Err(out) => return *out,
        };
        if needs_ai && !Policy::of(&ctx.settings).enabled {
            return fail(
                ctx,
                &AiError::not_eligible("AI features are turned off on this server."),
            );
        }
        match work(ctx, user).await {
            Ok(v) => ctx.json(&v),
            Err(e) => fail(ctx, &e),
        }
    })
}

/// A run as the API returns it, its picks as title cards with the
/// person's current feedback on each.
///
/// Fails when the picks' library status can't be read: without it the
/// blocklist and availability filters can't hide anything.
async fn run_view(ctx: &Ready<'_>, user_id: i64, run: &store::Run) -> Result<Value, AiError> {
    let mut request = run.request.clone();
    if let Some(obj) = request.as_object_mut() {
        obj.remove("row");
    }
    let result = match &run.result {
        Some(result) => Some(hydrate(ctx, user_id, result).await?),
        None => None,
    };
    Ok(json!({
        "id": run.id,
        "stage": run.stage,
        "createdAt": run.created_at,
        "request": request,
        "source": run.source,
        "model": run.model,
        "origin": run.origin,
        "result": result,
        "error": run.error,
    }))
}

async fn hydrate(ctx: &Ready<'_>, user_id: i64, result: &Value) -> Result<Value, AiError> {
    let picks: Vec<Value> = result
        .get("picks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let keys: Vec<(String, i64)> = picks
        .iter()
        .filter_map(|p| {
            Some((
                p.get("mediaType")?.as_str()?.to_owned(),
                p.get("tmdbId")?.as_i64()?,
            ))
        })
        .collect();
    let verdicts = store::feedback_for(&ctx.state.db, user_id, &keys)
        .await
        .map_err(|e| db_err(&e))?;
    let mut related: HashMap<&'static str, RelatedTitles> = HashMap::new();
    for kind in ["movie", "tv"] {
        let raws: Vec<Value> = picks
            .iter()
            .filter(|p| p.get("mediaType").and_then(Value::as_str) == Some(kind))
            .filter_map(|p| p.get("tmdb").cloned())
            .collect();
        if !raws.is_empty() {
            let loaded = RelatedTitles::load(ctx, &raws, kind, Some(user_id))
                .await
                .map_err(|_| AiError::internal("loading the picks' library status failed"))?;
            related.insert(kind, loaded);
        }
    }
    let mut out_picks = Vec::new();
    for p in &picks {
        let kind = kind_of(
            p.get("mediaType")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        );
        let Some(raw) = p.get("tmdb") else {
            continue;
        };
        let Some(tmdb_id) = p.get("tmdbId").and_then(Value::as_i64) else {
            continue;
        };
        let info = related
            .get(kind)
            .and_then(|r| r.media_info_last(ctx, raw, kind));
        let item = if kind == "tv" {
            map_tv_result(raw, info)
        } else {
            map_movie_result(raw, info)
        };
        out_picks.push(json!({
            "mediaType": kind,
            "tmdbId": tmdb_id,
            "why": p.get("why").cloned().unwrap_or(Value::Null),
            "source": p.get("source").cloned().unwrap_or(Value::Null),
            "feedback": verdicts.get(&(kind.to_owned(), tmdb_id)),
            "item": item,
        }));
    }
    // The same rating badges as any other poster (IMDb, Rotten Tomatoes…).
    let items: Vec<Value> = out_picks
        .iter()
        .filter_map(|p| p.get("item").cloned())
        .collect();
    match enrich_results_with_ratings(ctx, items, None, true).await {
        Ok(rated) if rated.len() == out_picks.len() => {
            for (pick, item) in out_picks.iter_mut().zip(rated) {
                if let Some(obj) = pick.as_object_mut() {
                    obj.insert(String::from("item"), item);
                }
            }
        }
        Ok(_) => {}
        Err(e) => tracing::info!("rating AI picks failed: {e}"),
    }
    let mut out = result.clone();
    if let Some(obj) = out.as_object_mut() {
        obj.insert(String::from("picks"), Value::Array(out_picks));
    }
    Ok(out)
}

async fn load_run(ctx: &Ready<'_>, user_id: i64, run_id: i64) -> Result<Value, AiError> {
    recs::sweep_stale(ctx.state).await;
    let run = store::run(&ctx.state.db, user_id, run_id)
        .await
        .map_err(|e| db_err(&e))?
        .ok_or_else(|| AiError::input("That request wasn't found."))?;
    run_view(ctx, user_id, &run).await
}

/// `POST /ai/recommend`: start a run; answer it (still working).
fn recommend<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    answer(ctx, |ctx, user| async move {
        let request = Request::parse(&body(ctx))?;
        active(ctx, user.id).await;
        let run_id = recs::start(
            Arc::clone(&ctx.shared),
            Arc::clone(&ctx.settings),
            user.clone(),
            request,
            Origin::Manual,
        )
        .await?;
        load_run(ctx, user.id, run_id).await
    })
}

/// `GET /ai/runs/{runId}`.
fn run_get<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    answer(ctx, |ctx, user| async move {
        let run_id = ctx
            .path_id(0)
            .map_err(|_| AiError::input("The request id must be a number."))?;
        load_run(ctx, user.id, run_id).await
    })
}

/// Note that someone uses AI picks (the nightly job prepares picks only for
/// people who do). Failures only lose that note.
async fn active(ctx: &Ready<'_>, user_id: i64) {
    if let Err(e) = store::touch_active(&ctx.state.db, user_id).await {
        tracing::info!("noting AI activity for user {user_id} failed: {e:#}");
    }
}

/// Per run, how many of its titles this person requested and liked.
async fn run_outcomes(ctx: &Ready<'_>, user_id: i64) -> Result<HashMap<i64, (i64, i64)>, AiError> {
    let mut out: HashMap<i64, (i64, i64)> = HashMap::new();
    for (sql, liked) in [
        (
            r#"SELECT CAST(p."runId" AS BIGINT) AS "runId", CAST(COUNT(*) AS BIGINT) AS "n" FROM "ai_pick" p JOIN "ai_signal" s ON s."userId" = p."userId" AND s."mediaType" = p."mediaType" AND s."tmdbId" = p."tmdbId" AND s."kind" = 'requested' WHERE p."userId" = ?1 GROUP BY p."runId""#,
            false,
        ),
        (
            r#"SELECT CAST(p."runId" AS BIGINT) AS "runId", CAST(COUNT(*) AS BIGINT) AS "n" FROM "ai_pick" p JOIN "ai_feedback" f ON f."userId" = p."userId" AND f."mediaType" = p."mediaType" AND f."tmdbId" = p."tmdbId" AND f."kind" = 'like' WHERE p."userId" = ?1 GROUP BY p."runId""#,
            true,
        ),
    ] {
        for r in ctx
            .state
            .db
            .rows(sql, &[Bind::Int(user_id)])
            .await
            .map_err(|e| db_err(&e))?
        {
            if let (Some(id), Some(n)) = (
                r.get("runId").and_then(Value::as_i64),
                r.get("n").and_then(Value::as_i64),
            ) {
                let entry = out.entry(id).or_default();
                if liked {
                    entry.1 = n;
                } else {
                    entry.0 = n;
                }
            }
        }
    }
    Ok(out)
}

/// `GET /ai/runs`: recent requests of their own (not Discover rows or
/// weekly picks), with what they asked, a few posters and how they went.
fn runs<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    answer(ctx, |ctx, user| async move {
        recs::sweep_stale(ctx.state).await;
        active(ctx, user.id).await;
        let list = store::personal_runs(&ctx.state.db, user.id, 20)
            .await
            .map_err(|e| db_err(&e))?;
        let outcomes = run_outcomes(ctx, user.id).await?;
        let items: Vec<Value> = list
            .iter()
            .map(|r| {
                let picks = r
                    .result
                    .as_ref()
                    .and_then(|x| x.get("picks"))
                    .and_then(Value::as_array);
                let posters: Vec<Value> = picks
                    .into_iter()
                    .flatten()
                    .filter_map(|p| p.pointer("/tmdb/poster_path").cloned())
                    .filter(Value::is_string)
                    .take(4)
                    .collect();
                let (requested, liked) = outcomes.get(&r.id).copied().unwrap_or_default();
                json!({
                    "id": r.id,
                    "stage": r.stage,
                    "createdAt": r.created_at,
                    "prompt": r.request.get("prompt").cloned().unwrap_or_else(|| Value::from("")),
                    "seedTitle": r.request.pointer("/seed/title").cloned(),
                    "seed": r.request.get("seed").filter(|s| s.is_object()).map(|s| json!({
                        "mediaType": s.get("mediaType"),
                        "tmdbId": s.get("tmdbId"),
                    })),
                    "error": r.error.as_ref().and_then(|e| e.get("message")).cloned(),
                    "only": r.request.get("only").cloned(),
                    "anime": r.request.get("anime").cloned(),
                    "availability": r.request.get("availability").cloned(),
                    "refinements": r.request.get("refinements").cloned(),
                    "headline": r.result.as_ref().and_then(|x| x.get("headline")).cloned(),
                    "pickCount": picks.map_or(0, Vec::len),
                    "posters": posters,
                    "requested": requested,
                    "liked": liked,
                    "model": r.model,
                })
            })
            .collect();
        Ok(Value::Array(items))
    })
}

/// `DELETE /ai/runs/{runId}`: forget one request and its picks.
fn run_delete<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    answer_always(ctx, |ctx, user| async move {
        let run_id = ctx
            .path_id(0)
            .map_err(|_| AiError::input("The request id must be a number."))?;
        let deleted = store::delete_run(&ctx.state.db, user.id, run_id)
            .await
            .map_err(|e| db_err(&e))?;
        if !deleted {
            return Err(AiError::input("That request wasn't found."));
        }
        Ok(json!({"deleted": 1}))
    })
}

/// `DELETE /ai/runs`: forget every request, Discover rows and weekly picks
/// included (feedback and the taste card stay; they have their own reset).
fn runs_delete<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    answer_always(ctx, |ctx, user| async move {
        let deleted = store::delete_runs(&ctx.state.db, user.id)
            .await
            .map_err(|e| db_err(&e))?;
        tracing::info!("user {} deleted their AI request history", user.id);
        Ok(json!({"deleted": deleted}))
    })
}

/// `GET /ai/weekly`: their latest weekly picks, if any.
fn weekly<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    answer(ctx, |ctx, user| async move {
        active(ctx, user.id).await;
        let run = store::latest_weekly(&ctx.state.db, user.id)
            .await
            .map_err(|e| db_err(&e))?;
        Ok(json!({"run": match run {
            Some(r) => Some(run_view(ctx, user.id, &r).await?),
            None => None,
        }}))
    })
}

/// `GET /ai/row?sliderId=` (or legacy prompt/only parameters).
/// A saved run seeds the owner's cache; refreshes repeat the full request.
fn row_cached<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    row_response(ctx, false)
}

fn row<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    row_response(ctx, true)
}

fn row_response<'a>(ctx: &'a Ready<'a>, create: bool) -> Native<'a> {
    answer(ctx, move |ctx, user| async move {
        if create
            && ctx
                .req
                .headers
                .get("x-foreseerr-ai")
                .and_then(|v| v.to_str().ok())
                != Some("1")
        {
            return Err(AiError::not_eligible(
                "AI row refreshes require the X-Foreseerr-AI header.",
            ));
        }
        let query = params::query(ctx).unwrap_or_default();
        let (config, enabled) = if let Some(id) = query.get("sliderId").and_then(Value::as_i64) {
            let slider = ctx
                .state
                .db
                .discover_slider(id)
                .await
                .map_err(|e| db_err(&e))?
                .filter(|s| s.slider_type == recs::rows::SLIDER_TYPE)
                .ok_or_else(|| AiError::input("This AI slider no longer exists."))?;
            (
                recs::rows::Config::parse(slider.data.as_deref().unwrap_or_default())?,
                slider.enabled,
            )
        } else {
            (
                recs::rows::Config {
                    request: Request::parse(&query)?,
                    ..recs::rows::Config::default()
                },
                true,
            )
        };
        let request = &config.request;
        active(ctx, user.id).await;
        let recent = store::row_runs(&ctx.state.db, user.id, request)
            .await
            .map_err(|e| db_err(&e))?;
        let mut matching: Vec<(store::Run, String)> = recent
            .into_iter()
            .filter(|r| recs::rows::matches_request(r, request))
            .map(|r| {
                let at = r.created_at.clone();
                (r, at)
            })
            .collect();
        if let Some(id) = config.initial_run {
            // A global slider must never share its creator's results with another user.
            if let Some(run) = store::run(&ctx.state.db, user.id, id)
                .await
                .map_err(|e| db_err(&e))?
                .filter(|r| {
                    r.stage == "done"
                        && r.result.is_some()
                        && recs::rows::matches_request(r, request)
                })
            {
                let at = config
                    .saved_at
                    .clone()
                    .unwrap_or_else(|| run.created_at.clone());
                matching.push((run, at));
            }
        }
        matching.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.0.id.cmp(&a.0.id)));
        let fresh_since =
            recs::iso_since(Some(Policy::of(&ctx.settings).row_refresh_days * 24 * 60));
        let working_since = recs::iso_since(Some(10));
        let current = matching.iter().find(|(r, at)| {
            (r.stage == "done" && at >= &fresh_since)
                || (matches!(r.stage.as_str(), "planning" | "searching" | "ranking")
                    && r.created_at >= working_since)
        });
        if let Some((run, _)) = current {
            return Ok(json!({"run": run_view(ctx, user.id, run).await?, "notice": null}));
        }
        let last = matching.iter().find(|(r, _)| r.stage == "done");
        if !enabled || !create {
            let run = match last {
                Some((r, _)) => Some(run_view(ctx, user.id, r).await?),
                None => None,
            };
            return Ok(json!({"run": run, "notice": null}));
        }
        let mut request = config.request.clone();
        request.row = true;
        match recs::start(
            Arc::clone(&ctx.shared),
            Arc::clone(&ctx.settings),
            user.clone(),
            request,
            Origin::Row,
        )
        .await
        {
            Ok(run_id) => Ok(json!({"run": load_run(ctx, user.id, run_id).await?, "notice": null})),
            Err(e) => {
                let run = match last {
                    Some((r, _)) => Some(run_view(ctx, user.id, r).await?),
                    None => None,
                };
                Ok(json!({"run": run, "notice": e.to_json()}))
            }
        }
    })
}

/// `GET /ai/feedback`.
fn feedback_list<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    answer(ctx, |ctx, user| async move {
        let list = store::feedback(&ctx.state.db, user.id, 500)
            .await
            .map_err(|e| db_err(&e))?;
        Ok(Value::Array(
            list.iter()
                .map(|f| {
                    json!({
                        "mediaType": f.media_type,
                        "tmdbId": f.tmdb_id,
                        "kind": f.kind,
                        "title": f.title,
                        "updatedAt": f.updated_at,
                    })
                })
                .collect(),
        ))
    })
}

/// `POST /ai/feedback`: set (or with `kind: null`, clear) a verdict.
fn feedback_set<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    answer(ctx, |ctx, user| async move {
        let body = body(ctx);
        let kind = match body.get("mediaType").and_then(Value::as_str) {
            Some(k @ ("movie" | "tv")) => kind_of(k),
            Some(_) | None => return Err(AiError::input("mediaType must be movie or tv.")),
        };
        let tmdb_id = body
            .get("tmdbId")
            .and_then(Value::as_i64)
            .filter(|id| *id > 0)
            .ok_or_else(|| AiError::input("tmdbId must be a positive number."))?;
        match body.get("kind") {
            None | Some(Value::Null) => {
                store::clear_feedback(&ctx.state.db, user.id, kind, tmdb_id)
                    .await
                    .map_err(|e| db_err(&e))?;
            }
            Some(Value::String(k)) => {
                let verdict = Verdict::parse(k)
                    .ok_or_else(|| AiError::input("That feedback kind isn't known."))?;
                let title: String = body
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .chars()
                    .take(200)
                    .collect();
                store::set_feedback(&ctx.state.db, user.id, kind, tmdb_id, verdict, &title)
                    .await
                    .map_err(|e| db_err(&e))?;
            }
            Some(_) => return Err(AiError::input("That feedback kind isn't known.")),
        }
        taste_view(ctx, user.id).await
    })
}

/// `DELETE /ai/feedback`: forget all their feedback.
fn feedback_clear<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    answer_always(ctx, |ctx, user| async move {
        store::clear_all_feedback(&ctx.state.db, user.id)
            .await
            .map_err(|e| db_err(&e))?;
        tracing::info!("user {} cleared their AI feedback", user.id);
        taste_view(ctx, user.id).await
    })
}

async fn taste_view(ctx: &Ready<'_>, user_id: i64) -> Result<Value, AiError> {
    let taste = store::taste(&ctx.state.db, user_id)
        .await
        .map_err(|e| db_err(&e))?;
    let (count, pending) = recs::pending_feedback(ctx.state, user_id)
        .await
        .map_err(|e| db_err(&e))?;
    let outcomes =
        recs::signals::user_outcomes(&ctx.state.db, &recs::iso_since(Some(30 * 24 * 60)), user_id)
            .await
            .map_err(|e| db_err(&e))?;
    Ok(json!({
        "card": taste.as_ref().map(|(c, _)| c.as_str()).unwrap_or_default(),
        "updatedAt": taste.as_ref().map(|(_, at)| at.as_str()),
        "feedbackCount": count,
        "pendingFeedback": pending,
        "outcomes": outcomes.to_json(),
    }))
}

/// `GET /ai/taste`.
fn taste_get<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    answer(
        ctx,
        |ctx, user| async move { taste_view(ctx, user.id).await },
    )
}

/// `PUT /ai/taste`: replace the card (empty clears it).
fn taste_put<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    answer(ctx, |ctx, user| async move {
        let card = body(ctx)
            .get("card")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_owned();
        if card.chars().count() > TASTE_MAX_CHARS {
            return Err(AiError::input(format!(
                "Keep the taste card under {TASTE_MAX_CHARS} characters."
            )));
        }
        store::save_taste(&ctx.state.db, user.id, &card)
            .await
            .map_err(|e| db_err(&e))?;
        taste_view(ctx, user.id).await
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dbtx::scratch;
    use crate::routes::testkit::Kit;

    #[tokio::test]
    async fn row_get_is_read_only_and_post_requires_the_custom_header() -> anyhow::Result<()> {
        let scratch = scratch::sqlite("ai-row-methods").await?;
        scratch.db.execute(r#"INSERT INTO "user" ("id", "email", "permissions", "userType", "avatar") VALUES (1, 'row@example.test', 0, 1, '')"#, &[]).await?;
        let kit = Kit::new(
            "ai-row-methods",
            scratch.db.clone(),
            json!({"ai":{"enabled":true}}),
        )?;
        let (status, body) = kit
            .call(
                row_cached,
                (Method::GET, "/api/v1/ai/row?prompt=cozy"),
                Some((1, 0)),
                None,
            )
            .await?;
        assert_eq!(status, 200);
        assert_eq!(body, json!({"run":null,"notice":null}));
        let (status, _) = kit
            .call(
                row,
                (Method::POST, "/api/v1/ai/row?prompt=cozy"),
                Some((1, 0)),
                Some(json!({})),
            )
            .await?;
        assert_eq!(status, 403);
        assert_eq!(store::server_runs_since(&scratch.db, 1, "2000").await?, 0);
        Ok(())
    }
}
