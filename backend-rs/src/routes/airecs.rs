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
use super::tv::map_tv_result;
use super::{params, Outcome, Ready, Table};
use crate::ai::recs::retrieve::kind_of;
use crate::ai::recs::store::{self, Verdict};
use crate::ai::recs::{self, prompts::TASTE_MAX_CHARS, Request};
use crate::ai::{AiError, Policy};
use crate::auth::CurrentUser;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/ai/recommend", Method::POST, recommend),
    ("/api/v1/ai/runs", Method::GET, runs),
    ("/api/v1/ai/runs/{runId}", Method::GET, run_get),
    ("/api/v1/ai/row", Method::GET, row),
    ("/api/v1/ai/feedback", Method::GET, feedback_list),
    ("/api/v1/ai/feedback", Method::POST, feedback_set),
    ("/api/v1/ai/feedback", Method::DELETE, feedback_clear),
    ("/api/v1/ai/taste", Method::GET, taste_get),
    ("/api/v1/ai/taste", Method::PUT, taste_put),
];

/// A Discover row's picks are reused for this long (minutes).
const ROW_FRESH_MINUTES: i64 = 24 * 60;

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
    Box::pin(async move {
        let user = match ctx.require(0) {
            Ok(u) => u,
            Err(out) => return *out,
        };
        if !Policy::of(&ctx.settings).enabled {
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
async fn run_view(ctx: &Ready<'_>, user_id: i64, run: &store::Run) -> Value {
    let mut request = run.request.clone();
    if let Some(obj) = request.as_object_mut() {
        obj.remove("row");
    }
    let result = match &run.result {
        Some(result) => Some(hydrate(ctx, user_id, result).await),
        None => None,
    };
    json!({
        "id": run.id,
        "stage": run.stage,
        "createdAt": run.created_at,
        "request": request,
        "source": run.source,
        "model": run.model,
        "result": result,
        "error": run.error,
    })
}

async fn hydrate(ctx: &Ready<'_>, user_id: i64, result: &Value) -> Value {
    let picks: Vec<Value> = result
        .get("picks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let verdicts: HashMap<(String, i64), String> = store::feedback(&ctx.state.db, user_id, 2000)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|f| ((f.media_type, f.tmdb_id), f.kind))
        .collect();
    let mut related: HashMap<&'static str, Option<RelatedTitles>> = HashMap::new();
    for kind in ["movie", "tv"] {
        let raws: Vec<Value> = picks
            .iter()
            .filter(|p| p.get("mediaType").and_then(Value::as_str) == Some(kind))
            .filter_map(|p| p.get("tmdb").cloned())
            .collect();
        if !raws.is_empty() {
            related.insert(
                kind,
                RelatedTitles::load(ctx, &raws, kind, Some(user_id))
                    .await
                    .ok(),
            );
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
            .and_then(Option::as_ref)
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
    let mut out = result.clone();
    if let Some(obj) = out.as_object_mut() {
        obj.insert(String::from("picks"), Value::Array(out_picks));
    }
    out
}

async fn load_run(ctx: &Ready<'_>, user_id: i64, run_id: i64) -> Result<Value, AiError> {
    let run = store::run(&ctx.state.db, user_id, run_id)
        .await
        .map_err(|e| db_err(&e))?
        .ok_or_else(|| AiError::input("That request wasn't found."))?;
    Ok(run_view(ctx, user_id, &run).await)
}

/// `POST /ai/recommend`: start a run; answer it (still working).
fn recommend<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    answer(ctx, |ctx, user| async move {
        let request = Request::parse(&body(ctx))?;
        let run_id = recs::start(
            Arc::clone(&ctx.shared),
            Arc::clone(&ctx.settings),
            user.clone(),
            request,
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

/// `GET /ai/runs`: recent requests of their own (not Discover rows).
fn runs<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    answer(ctx, |ctx, user| async move {
        let list = store::recent_runs(&ctx.state.db, user.id, 60)
            .await
            .map_err(|e| db_err(&e))?;
        let items: Vec<Value> = list
            .iter()
            .filter(|r| r.request.get("row").and_then(Value::as_bool) != Some(true))
            .take(20)
            .map(|r| {
                json!({
                    "id": r.id,
                    "stage": r.stage,
                    "createdAt": r.created_at,
                    "prompt": r.request.get("prompt").cloned().unwrap_or_else(|| Value::from("")),
                    "seedTitle": r.request.pointer("/seed/title").cloned(),
                    "headline": r.result.as_ref().and_then(|x| x.get("headline")).cloned(),
                })
            })
            .collect();
        Ok(Value::Array(items))
    })
}

fn same_row(run: &store::Run, prompt: &str, only: Option<&str>) -> bool {
    run.request.get("row").and_then(Value::as_bool) == Some(true)
        && run.request.get("prompt").and_then(Value::as_str) == Some(prompt)
        && run.request.get("only").and_then(Value::as_str) == only
}

/// `GET /ai/row?prompt=&only=`: a Discover row's picks for this person.
/// Reuses today's picks for the same prompt; otherwise starts a run
/// (counting toward their daily limit) and answers it while it works.
/// When a new run can't start, answers the last picks (if any) and why.
fn row<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    answer(ctx, |ctx, user| async move {
        let query = params::query(ctx).unwrap_or_default();
        let prompt = query
            .get("prompt")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_owned();
        let only = match query.get("only").and_then(Value::as_str) {
            Some("movie") => Some("movie"),
            Some("tv") => Some("tv"),
            Some(_) | None => None,
        };
        let recent = store::recent_runs(&ctx.state.db, user.id, 100)
            .await
            .map_err(|e| db_err(&e))?;
        let fresh_since = recs::iso_since(Some(ROW_FRESH_MINUTES));
        let working_since = recs::iso_since(Some(10));
        let matching: Vec<&store::Run> = recent
            .iter()
            .filter(|r| same_row(r, &prompt, only))
            .collect();
        let current = matching.iter().find(|r| {
            (r.stage == "done" && r.created_at >= fresh_since)
                || (matches!(r.stage.as_str(), "planning" | "searching" | "ranking")
                    && r.created_at >= working_since)
        });
        if let Some(run) = current {
            return Ok(json!({"run": run_view(ctx, user.id, run).await, "notice": null}));
        }
        let request = Request {
            prompt: prompt.chars().take(recs::MAX_PROMPT_CHARS).collect(),
            only,
            row: true,
            ..Request::default()
        };
        match recs::start(
            Arc::clone(&ctx.shared),
            Arc::clone(&ctx.settings),
            user.clone(),
            request,
        )
        .await
        {
            Ok(run_id) => Ok(json!({"run": load_run(ctx, user.id, run_id).await?, "notice": null})),
            Err(e) => {
                let last = matching.iter().find(|r| r.stage == "done");
                let run = match last {
                    Some(r) => Some(run_view(ctx, user.id, r).await),
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
    answer(ctx, |ctx, user| async move {
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
    Ok(json!({
        "card": taste.as_ref().map(|(c, _)| c.as_str()).unwrap_or_default(),
        "updatedAt": taste.as_ref().map(|(_, at)| at.as_str()),
        "feedbackCount": count,
        "pendingFeedback": pending,
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
