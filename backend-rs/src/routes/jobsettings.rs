//! Settings routes over Node's process state.
//!
//! The job scheduler, the full library scans, the in-memory caches and the
//! integration health cache live in Node; its `/internal` routes act on
//! them. Validation, settings.json writes and response shapes are here.

use axum::http::Method;
use serde_json::{Map, Value};

use super::nodestate::{
    admin, decode_segment, node_call, object_body, pick, raw_segment, save, NativeFut,
};
use super::{Outcome, Ready, Table};
use crate::jobs::execution::Weight;
use crate::jobs::scanbase::{self, Kind};
use crate::jobs::scheduler::{self, rust_jobs, JobAnswer};
use crate::settings::public::truthy;

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/settings/jobs", Method::GET, jobs),
    ("/api/v1/settings/jobs/{id}/run", Method::POST, job_run),
    (
        "/api/v1/settings/jobs/{id}/cancel",
        Method::POST,
        job_cancel,
    ),
    (
        "/api/v1/settings/jobs/{id}/schedule",
        Method::POST,
        job_schedule,
    ),
    ("/api/v1/settings/plex/sync", Method::GET, plex_sync_status),
    ("/api/v1/settings/plex/sync", Method::POST, plex_sync),
    (
        "/api/v1/settings/jellyfin/sync",
        Method::GET,
        jellyfin_sync_status,
    ),
    (
        "/api/v1/settings/jellyfin/sync",
        Method::POST,
        jellyfin_sync,
    ),
    ("/api/v1/settings/cache", Method::GET, cache),
    (
        "/api/v1/settings/cache/{id}/flush",
        Method::POST,
        cache_flush,
    ),
    (
        "/api/v1/settings/cache/dns/{entry}/flush",
        Method::POST,
        dns_flush,
    ),
    (
        "/api/v1/settings/integrations/status",
        Method::GET,
        integrations,
    ),
    (
        "/api/v1/settings/integrations/status/refresh",
        Method::POST,
        integrations_refresh,
    ),
];

/// The fields of a job in Node's answers.
const JOB_FIELDS: [&str; 7] = [
    "id",
    "name",
    "type",
    "interval",
    "cronSchedule",
    "nextExecutionTime",
    "running",
];

/// The fields of a scanner's `status()`.
const SCAN_FIELDS: [&str; 5] = [
    "running",
    "progress",
    "total",
    "currentLibrary",
    "libraries",
];

/// `cacheManager`'s caches.
const CACHE_IDS: [&str; 13] = [
    "tmdb",
    "tmdbscan",
    "radarr",
    "sonarr",
    "rt",
    "imdb",
    "mdblist",
    "github",
    "plextv",
    "plexwatchlist",
    "tvdb",
    "trakt",
    "anilist",
];

/// Names `availableCaches[id]` finds on `Object.prototype`: Node then calls
/// `flush` on a function and answers 500.
const PROTOTYPE_KEYS: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

/// `GET /settings/jobs`.
fn jobs<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(async move {
        if let Err(why) = admin(ctx) {
            return Outcome::forward(why);
        }
        if rust_jobs() {
            return match scheduler::list() {
                Ok(list) => ctx.json(&Value::Array(list)),
                Err(message) => ctx.error(500, message),
            };
        }
        match node_call(ctx, Method::GET, "/jobs", None).await {
            Ok((200, Value::Array(list))) => {
                let shaped: Vec<Value> = list
                    .iter()
                    .map(|job| Value::Object(pick(job, &JOB_FIELDS)))
                    .collect();
                ctx.json(&Value::Array(shaped))
            }
            Ok((status, _)) => Outcome::forward(format!("the internal job list answered {status}")),
            Err(e) => Outcome::forward(format!("{e:#}")),
        }
    })
}

/// `POST /settings/jobs/{id}/run` and `/cancel`: the action happens in
/// Node; the job as it is afterwards comes back.
async fn job_action(ctx: &Ready<'_>, action: &str) -> Outcome {
    if let Err(why) = admin(ctx) {
        return Outcome::forward(why);
    }
    let raw = raw_segment(ctx, 1);
    let Some(id) = decode_segment(raw) else {
        return Outcome::forward(String::from("a job id Express can't decode"));
    };
    if rust_jobs() {
        let answer = if action == "run" {
            scheduler::run_now(&ctx.shared, &id)
        } else {
            scheduler::cancel(&id)
        };
        return job_answer(ctx, answer);
    }
    let path = format!("/jobs/{raw}/{action}");
    match node_call(ctx, Method::POST, &path, None).await {
        Ok((200, job)) => ctx.json(&Value::Object(pick(&job, &JOB_FIELDS))),
        Ok((404, _)) => ctx.error(404, "Job not found."),
        Ok((status @ (400 | 403), _)) => Outcome::forward(format!(
            "the internal job {action} refused the call: {status}"
        )),
        Ok((status, _)) => {
            tracing::error!("the internal job {action} answered {status}");
            ctx.error(500, "Unable to reach the job scheduler.")
        }
        Err(e) => Outcome::forward(format!("{e:#}")),
    }
}

fn job_run<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(job_action(ctx, "run"))
}

fn job_cancel<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(job_action(ctx, "cancel"))
}

/// `POST /settings/jobs/{id}/schedule`: Node reschedules; a schedule it
/// accepts is written to `settings.jobs[id].schedule` here.
fn job_schedule<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(async move {
        if let Err(why) = admin(ctx) {
            return Outcome::forward(why);
        }
        if rust_jobs() && ctx.body.is_none() {
            // The job is looked up first; then `req.body.schedule` throws.
            let Some(id) = decode_segment(raw_segment(ctx, 1)) else {
                return Outcome::forward(String::from("a job id Express can't decode"));
            };
            if !scheduler::scheduled().iter().any(|(def, _)| def.id == id) {
                return ctx.error(404, "Job not found.");
            }
            return ctx.error(500, "The request body is missing.");
        }
        let body = match object_body(ctx) {
            Ok(body) => body,
            Err(why) => return Outcome::forward(why),
        };
        if rust_jobs() {
            return rust_schedule(ctx, body).await;
        }
        let Some(Value::String(schedule)) = body.get("schedule") else {
            return Outcome::forward(String::from("a missing or non-string schedule"));
        };
        let raw = raw_segment(ctx, 1);
        let Some(id) = decode_segment(raw) else {
            return Outcome::forward(String::from("a job id Express can't decode"));
        };
        let mut data = ctx.settings.data().clone();
        if !data
            .get("jobs")
            .and_then(|j| j.get(&id))
            .is_some_and(Value::is_object)
        {
            return Outcome::forward(String::from("no settings for this job"));
        }
        let mut request = Map::new();
        request.insert(String::from("schedule"), Value::from(schedule.as_str()));
        let path = format!("/jobs/{raw}/schedule");
        let job = match node_call(ctx, Method::POST, &path, Some(&Value::Object(request))).await {
            Ok((200, answer)) if answer.get("rescheduled") == Some(&Value::Bool(true)) => {
                answer.get("job").cloned().unwrap_or(Value::Null)
            }
            Ok((200, _)) => return ctx.error(400, "Invalid job schedule."),
            Ok((404, _)) => return ctx.error(404, "Job not found."),
            Ok((status, _)) => {
                return Outcome::forward(format!("the internal reschedule answered {status}"))
            }
            Err(e) => return Outcome::forward(format!("{e:#}")),
        };
        if let Some(Value::Object(settings)) = data.get_mut("jobs").and_then(|j| j.get_mut(&id)) {
            settings.insert(String::from("schedule"), Value::from(schedule.as_str()));
        }
        if let Err(outcome) = save(ctx, &data).await {
            return outcome;
        }
        ctx.json(&Value::Object(pick(&job, &JOB_FIELDS)))
    })
}

/// A job route's answer from the Rust scheduler.
fn job_answer(ctx: &Ready<'_>, answer: JobAnswer) -> Outcome {
    match answer {
        JobAnswer::NotFound => ctx.error(404, "Job not found."),
        JobAnswer::Invalid => ctx.error(400, "Invalid job schedule."),
        JobAnswer::Throws(message) => ctx.error(500, message),
        JobAnswer::Job(job) => ctx.json(&Value::Object(job)),
    }
}

/// `POST /settings/jobs/{id}/schedule` against the Rust scheduler: a
/// missing schedule is one node-schedule rejects; a non-string one is the
/// validator's to reject.
async fn rust_schedule(ctx: &Ready<'_>, body: &Map<String, Value>) -> Outcome {
    let schedule = match body.get("schedule") {
        None => None,
        Some(Value::String(s)) => Some(s.as_str()),
        Some(_) => {
            return Outcome::forward(String::from(
                "a non-string schedule; the validator rejects it",
            ))
        }
    };
    let Some(id) = decode_segment(raw_segment(ctx, 1)) else {
        return Outcome::forward(String::from("a job id Express can't decode"));
    };
    let answer = scheduler::reschedule(&ctx.shared, &id, schedule);
    let JobAnswer::Job(job) = answer else {
        return job_answer(ctx, answer);
    };
    let mut data = ctx.settings.data().clone();
    if let Some(Value::Object(settings)) = data.get_mut("jobs").and_then(|j| j.get_mut(&id)) {
        settings.insert(
            String::from("schedule"),
            Value::from(schedule.unwrap_or_default()),
        );
    }
    if let Err(outcome) = save(ctx, &data).await {
        return outcome;
    }
    ctx.json(&Value::Object(job))
}

/// The Rust full scanner behind `/settings/{server}/sync` when Rust runs
/// the jobs.
fn rust_scanner(server: &str) -> &'static Kind {
    if server == "plex" {
        &crate::jobs::plexscan::FULL
    } else {
        &crate::jobs::jellyfinscan::FULL
    }
}

/// The scanner's status as the sync routes print it.
fn rust_scan_status(ctx: &Ready<'_>, server: &str) -> Outcome {
    let status = Value::Object(scanbase::status(rust_scanner(server)));
    ctx.json(&Value::Object(pick(&status, &SCAN_FIELDS)))
}

/// `GET /settings/{server}/sync`: the full scanner's status.
async fn scan_status(ctx: &Ready<'_>, server: &str) -> Outcome {
    if let Err(why) = admin(ctx) {
        return Outcome::forward(why);
    }
    if rust_jobs() {
        return rust_scan_status(ctx, server);
    }
    let path = format!("/scanners/{server}");
    match node_call(ctx, Method::GET, &path, None).await {
        Ok((200, status)) => ctx.json(&Value::Object(pick(&status, &SCAN_FIELDS))),
        Ok((status, _)) => {
            Outcome::forward(format!("the internal scanner status answered {status}"))
        }
        Err(e) => Outcome::forward(format!("{e:#}")),
    }
}

/// `POST /settings/{server}/sync`: `cancel` wins over `start`; either way
/// the status afterwards.
async fn scan_control(ctx: &Ready<'_>, server: &str) -> Outcome {
    if let Err(why) = admin(ctx) {
        return Outcome::forward(why);
    }
    if ctx.validated().is_some() && ctx.body.is_none() {
        return ctx.error(500, "The request body is missing.");
    }
    let body = match object_body(ctx) {
        Ok(body) => body,
        Err(why) => return Outcome::forward(why),
    };
    let flag_ok = |key: &str| matches!(body.get(key), None | Some(Value::Bool(_)));
    if !flag_ok("cancel") || !flag_ok("start") {
        return Outcome::forward(String::from("a cancel or start the validator rejects"));
    }
    let action = if truthy(body.get("cancel")) {
        Value::from("cancel")
    } else if truthy(body.get("start")) {
        Value::from("start")
    } else {
        Value::Null
    };
    if rust_jobs() {
        let kind = rust_scanner(server);
        match action.as_str() {
            Some("cancel") => scheduler::cancel_managed(kind.id),
            Some("start") => {
                let state = std::sync::Arc::clone(&ctx.shared);
                tokio::spawn(async move {
                    if let Err(e) = scheduler::execute_managed(state, kind.id, Weight::Heavy).await
                    {
                        tracing::error!(label = "Jobs", "Unable to start {}: {e:#}", kind.id);
                    }
                });
            }
            _ => {}
        }
        return rust_scan_status(ctx, server);
    }
    let mut request = Map::new();
    request.insert(String::from("action"), action);
    let path = format!("/scanners/{server}");
    match node_call(ctx, Method::POST, &path, Some(&Value::Object(request))).await {
        Ok((200, status)) => ctx.json(&Value::Object(pick(&status, &SCAN_FIELDS))),
        Ok((status @ (400 | 403 | 404), _)) => Outcome::forward(format!(
            "the internal scanner control refused the call: {status}"
        )),
        Ok((status, _)) => {
            tracing::error!("the internal scanner control answered {status}");
            ctx.error(500, "Unable to reach the library scanner.")
        }
        Err(e) => Outcome::forward(format!("{e:#}")),
    }
}

fn plex_sync_status<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(scan_status(ctx, "plex"))
}

fn plex_sync<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(scan_control(ctx, "plex"))
}

fn jellyfin_sync_status<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(scan_status(ctx, "jellyfin"))
}

fn jellyfin_sync<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(scan_control(ctx, "jellyfin"))
}

/// `GET /settings/cache`: Node's cache, image and DNS statistics, plus the
/// browser cache limit.
fn cache<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(async move {
        if let Err(why) = admin(ctx) {
            return Outcome::forward(why);
        }
        let stats = match node_call(ctx, Method::GET, "/cache", None).await {
            Ok((200, stats)) => stats,
            Ok((status, _)) => {
                return Outcome::forward(format!("the internal cache stats answered {status}"))
            }
            Err(e) => return Outcome::forward(format!("{e:#}")),
        };
        let mut out = pick(&stats, &["apiCaches", "imageCache", "memory", "images"]);
        let mut browser = Map::new();
        browser.insert(
            String::from("limitBytes"),
            Value::from(768_i64 * 1024 * 1024),
        );
        out.insert(String::from("browser"), Value::Object(browser));
        out.insert(
            String::from("dnsCache"),
            Value::Object(pick(
                stats.get("dnsCache").unwrap_or(&Value::Null),
                &["stats", "entries"],
            )),
        );
        ctx.json(&Value::Object(out))
    })
}

/// `POST /settings/cache/{id}/flush`.
fn cache_flush<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(async move {
        if let Err(why) = admin(ctx) {
            return Outcome::forward(why);
        }
        let raw = raw_segment(ctx, 1);
        let Some(id) = decode_segment(raw) else {
            return Outcome::forward(String::from("a cache id Express can't decode"));
        };
        if PROTOTYPE_KEYS.contains(&id.as_str()) {
            return Outcome::forward(String::from("an Object.prototype key"));
        }
        if !CACHE_IDS.contains(&id.as_str()) {
            return ctx.error(404, "Cache not found.");
        }
        let path = format!("/cache/{id}/flush");
        match node_call(ctx, Method::POST, &path, None).await {
            Ok((204, _)) => Ready::no_content(),
            Ok((404, _)) => ctx.error(404, "Cache not found."),
            Ok((status, _)) => {
                Outcome::forward(format!("the internal cache flush answered {status}"))
            }
            Err(e) => Outcome::forward(format!("{e:#}")),
        }
    })
}

/// `POST /settings/cache/dns/{entry}/flush`.
fn dns_flush<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(async move {
        if let Err(why) = admin(ctx) {
            return Outcome::forward(why);
        }
        let raw = raw_segment(ctx, 1);
        if decode_segment(raw).is_none() {
            return Outcome::forward(String::from("an entry Express can't decode"));
        }
        let path = format!("/cache/dns/{raw}/flush");
        match node_call(ctx, Method::POST, &path, None).await {
            Ok((204, _)) => Ready::no_content(),
            Ok((404, _)) => ctx.error(404, "Cache not found."),
            Ok((status, _)) => {
                Outcome::forward(format!("the internal DNS flush answered {status}"))
            }
            Err(e) => Outcome::forward(format!("{e:#}")),
        }
    })
}

/// The integration health from Node's cache (refreshed first when asked).
async fn health(ctx: &Ready<'_>, refresh: bool) -> Outcome {
    if let Err(why) = admin(ctx) {
        return Outcome::forward(why);
    }
    let (path, method, failure) = if refresh {
        (
            "/integrations/health/refresh",
            Method::POST,
            "Unable to refresh integration health.",
        )
    } else {
        (
            "/integrations/health",
            Method::GET,
            "Unable to check integration health.",
        )
    };
    match node_call(ctx, method, path, None).await {
        Ok((200, value)) => ctx.json(&value),
        Ok((500, answer)) => {
            let why = answer.get("message").and_then(Value::as_str).unwrap_or("");
            tracing::error!("{failure} {why}");
            ctx.error(500, failure)
        }
        Ok((status, _)) => {
            Outcome::forward(format!("the internal integration health answered {status}"))
        }
        Err(e) => Outcome::forward(format!("{e:#}")),
    }
}

fn integrations<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(health(ctx, false))
}

fn integrations_refresh<'a>(ctx: &'a Ready<'a>) -> NativeFut<'a> {
    Box::pin(health(ctx, true))
}
