//! The desktop runtime's behaviour inside the server.
//!
//! - The guard state: the loopback origin the child listens on and
//!   `stopping` (`desktopState.ts`), read by [`super::http`] and
//!   `GET /status` (`runtime`, `managed`, `jobsStarted`, `stopping`).
//! - The volatile `applicationUrl`: while listening, every reader of
//!   `settings.main.applicationUrl` sees the loopback origin, and a save
//!   never writes it (a value with that origin keeps the stored one).
//! - `desktopLogin.ts`: the signed-in user is remembered in
//!   `<CONFIG_DIRECTORY>/state/desktop-login.json` and a request without a
//!   session gets one for that user again (a new port after a restart is a
//!   new cookie origin).
//! - The request log: `API <method> <path>` when an `/api` request starts
//!   and `API <method> <path> <status> <ms>ms` when it ends.
//! - The jobs: none at startup; they start three seconds after a sign-in
//!   (five after `GET /auth/me`), and thirty seconds later one catch-up
//!   pass runs: a fresh download poll, the heavy jobs deferred by playback,
//!   then every job whose cron fired while the app was closed. Heavy jobs
//!   that fire during playback wait for it to end.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Instant;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderMap, HeaderValue, Method, Response, StatusCode};
use axum::middleware::Next;
use serde_json::{Map, Value};

use crate::db::Bind;
use crate::jobs::execution::Weight;
use crate::jobs::scheduler::{self, JobDef};
use crate::settings::Settings;
use crate::state::AppState;

static ORIGIN: RwLock<Option<String>> = RwLock::new(None);
static STOPPING: AtomicBool = AtomicBool::new(false);
static PLAYBACK: AtomicBool = AtomicBool::new(false);
static STATE: OnceLock<Arc<AppState>> = OnceLock::new();
/// `cachedUserId`.
static REMEMBERED: Mutex<Remembered> = Mutex::new(Remembered::Unread);

/// `cachedUserId`: `undefined`, `null` or the user id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Remembered {
    Unread,
    SignedOut,
    User(i64),
}
/// `deferredHeavyJobs`, in first-deferral order.
static DEFERRED: Mutex<Vec<&'static JobDef>> = Mutex::new(Vec::new());
/// `desktopCatchUpTimer` is pending.
static CATCH_UP_PENDING: Mutex<Option<tokio::task::AbortHandle>> = Mutex::new(None);
static DOWNLOAD_STARTUP_RUN: AtomicBool = AtomicBool::new(false);
/// The settings last overlaid with the origin, and the overlay.
static OVERLAY: Mutex<Option<(Arc<Settings>, Arc<Settings>)>> = Mutex::new(None);

fn on() -> bool {
    super::active() && super::desktop_runtime()
}

/// Give the jobs started from requests and control messages the state.
pub fn attach(state: &Arc<AppState>) {
    STATE.set(Arc::clone(state)).ok();
}

/// `desktopOrigin` and `setDesktopApplicationUrl(origin)`.
pub fn set_origin(origin: &str) {
    *crate::sync::write(&ORIGIN) = Some(origin.to_owned());
    *crate::sync::lock(&OVERLAY) = None;
}

/// The loopback origin, once listening.
#[must_use]
pub fn origin() -> Option<String> {
    crate::sync::read(&ORIGIN).clone()
}

/// `setDesktopStopping`.
pub fn set_stopping(value: bool) {
    STOPPING.store(value, Ordering::SeqCst);
}

/// `isDesktopStopping()`.
#[must_use]
pub fn stopping() -> bool {
    STOPPING.load(Ordering::SeqCst)
}

/// A `runtime-state` message: `setDesktopPlaybackActive`, and going idle
/// queues the catch-up.
pub fn set_playback(active: bool) {
    PLAYBACK.store(active, Ordering::SeqCst);
    if !active {
        start_catch_up();
    }
}

/// The desktop fields of `GET /status`.
pub fn status_fields(body: &mut Map<String, Value>) {
    if !on() {
        return;
    }
    let jobs_started = scheduler::list().map_or(true, |jobs| !jobs.is_empty());
    body.insert(String::from("runtime"), Value::from("desktop"));
    body.insert(String::from("managed"), Value::Bool(true));
    body.insert(String::from("jobsStarted"), Value::Bool(jobs_started));
    body.insert(String::from("stopping"), Value::Bool(stopping()));
}

// --- applicationUrl ---------------------------------------------------

/// The settings as runtime readers see them (`get main()`): with the
/// loopback origin as `applicationUrl` while the desktop child listens.
#[must_use]
pub fn effective(settings: Arc<Settings>) -> Arc<Settings> {
    if !on() {
        return settings;
    }
    let Some(origin) = origin() else {
        return settings;
    };
    if settings.get("/main/applicationUrl").and_then(Value::as_str) == Some(origin.as_str()) {
        return settings;
    }
    let mut cache = crate::sync::lock(&OVERLAY);
    if let Some((source, overlay)) = cache.as_ref() {
        if Arc::ptr_eq(source, &settings) {
            return Arc::clone(overlay);
        }
    }
    let mut data = settings.data().clone();
    if let Some(main) = data.get_mut("main").and_then(Value::as_object_mut) {
        main.insert(String::from("applicationUrl"), Value::from(origin));
    }
    let overlay = Arc::new(settings.with_data(data));
    *cache = Some((settings, Arc::clone(&overlay)));
    overlay
}

/// `settings.main` as a handler reads it back after a save: the loopback
/// origin as `applicationUrl` while the desktop child listens.
pub fn effective_main(main: &mut Value) {
    if !on() {
        return;
    }
    if let (Some(origin), Some(map)) = (origin(), main.as_object_mut()) {
        map.insert(String::from("applicationUrl"), Value::from(origin));
    }
}

/// `isManagedApplicationUrl(value, origin)`: a URL with the origin.
fn managed_url(value: &Value, origin: &str) -> bool {
    value
        .as_str()
        .and_then(|v| reqwest::Url::parse(v).ok())
        .is_some_and(|url| url.origin().ascii_serialization() == origin)
}

/// The document a save writes: an `applicationUrl` with the loopback
/// origin is replaced by the stored one. `None` when nothing changes.
#[must_use]
pub fn durable_document(data: &Value, stored: Option<Value>) -> Option<Value> {
    if !on() {
        return None;
    }
    let origin = origin()?;
    let current = data.pointer("/main/applicationUrl")?;
    if !managed_url(current, &origin) {
        return None;
    }
    let mut owned = data.clone();
    if let Some(main) = owned.get_mut("main").and_then(Value::as_object_mut) {
        main.insert(
            String::from("applicationUrl"),
            stored.unwrap_or_else(|| Value::from("")),
        );
    }
    Some(owned)
}

// --- desktopLogin.ts ----------------------------------------------------

fn login_state_path() -> Option<PathBuf> {
    std::env::var_os("CONFIG_DIRECTORY")
        .map(|dir| PathBuf::from(dir).join("state").join("desktop-login.json"))
}

/// `rememberDesktopUser(userId)`.
pub fn remember(user_id: i64) {
    if !on() || user_id <= 0 {
        return;
    }
    let mut cached = crate::sync::lock(&REMEMBERED);
    if *cached == Remembered::User(user_id) {
        return;
    }
    *cached = Remembered::User(user_id);
    drop(cached);
    let Some(file) = login_state_path() else {
        return;
    };
    if let Err(e) = write_private(&file, &format!("{{\"userId\":{user_id}}}\n")) {
        tracing::error!(label = "Desktop", "Saving the desktop login failed: {e}");
    }
}

fn write_private(file: &std::path::Path, text: &str) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    std::io::Write::write_all(&mut options.open(file)?, text.as_bytes())
}

/// `forgetDesktopUser()`: every sign-out, in any runtime.
pub fn forget() {
    *crate::sync::lock(&REMEMBERED) = Remembered::SignedOut;
    if let Some(file) = login_state_path() {
        if let Err(e) = std::fs::remove_file(file) {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::debug!("removing the desktop login state failed: {e}");
            }
        }
    }
}

/// `recalledDesktopUserId()`.
fn recall() -> Option<i64> {
    if !on() {
        return None;
    }
    let mut cached = crate::sync::lock(&REMEMBERED);
    match *cached {
        Remembered::User(id) => return Some(id),
        Remembered::SignedOut => return None,
        Remembered::Unread => {}
    }
    let found = login_state_path()
        .and_then(|file| std::fs::read_to_string(file).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|v| v.get("userId").and_then(remembered_id));
    *cached = found.map_or(Remembered::SignedOut, Remembered::User);
    drop(cached);
    found
}

/// `typeof userId === 'number' && Number.isInteger(userId) && userId > 0`.
fn remembered_id(value: &Value) -> Option<i64> {
    let n = value.as_f64()?;
    (n > 0.0 && n.fract() == 0.0 && n <= 9_007_199_254_740_991.0)
        .then(|| format!("{n}").parse::<i64>().ok())
        .flatten()
}

/// The session cookie [`api_layer`] restored for this request; handlers
/// see the user it belongs to (`req.session.userId`), the validator
/// doesn't see a cookie.
#[derive(Debug, Clone)]
pub struct Restored {
    /// `connect.sid=<signed id>`.
    pair: String,
}

/// The request headers the handlers' `checkUser` reads: with a restored
/// session's cookie in place of the request's own.
#[must_use]
pub fn session_headers(head: &Parts) -> std::borrow::Cow<'_, HeaderMap> {
    let Some(restored) = head.extensions.get::<Restored>() else {
        return std::borrow::Cow::Borrowed(&head.headers);
    };
    let mut headers = head.headers.clone();
    headers.remove(header::COOKIE);
    if let Ok(v) = HeaderValue::from_str(&restored.pair) {
        headers.insert(header::COOKIE, v);
    }
    std::borrow::Cow::Owned(headers)
}

/// `restoreDesktopSession`: the session id and `Set-Cookie` of a session
/// made for the remembered user.
async fn restore(state: &AppState, parts: &mut Parts) -> Option<(String, String)> {
    let api_key = parts
        .headers
        .get("x-api-key")
        .is_some_and(|v| !v.as_bytes().is_empty());
    if api_key {
        return None;
    }
    let settings = state.settings.current().await.ok()?;
    if let Some(sid) = crate::auth::session_id(&parts.headers, settings.session_secret()) {
        let session = state
            .db
            .session_user_id(&sid, crate::auth::now_ms())
            .await
            .ok()
            .flatten();
        if let Some(id) = session.and_then(|s| s.user_id).filter(|id| *id != 0) {
            remember(id);
            return None;
        }
    }
    let recalled = recall()?;
    let exists = state
        .db
        .rows(
            r#"SELECT "id" FROM "user" WHERE "id" = ?1"#,
            &[Bind::Int(recalled)],
        )
        .await
        .ok()
        .is_some_and(|rows| !rows.is_empty());
    if !exists {
        forget();
        return None;
    }
    match super::session::sign_in(state, &settings, &parts.headers, recalled).await {
        Ok(saved) => {
            let cookie = saved.cookie?;
            let pair = cookie.split(';').next().unwrap_or("").to_owned();
            parts.extensions.insert(Restored { pair });
            Some((saved.sid, cookie))
        }
        Err(e) => {
            tracing::error!(
                label = "Desktop",
                "Restoring the desktop session failed: {e}"
            );
            None
        }
    }
}

// --- the /api middleware ------------------------------------------------

/// Marks a response the `OpenAPI` validator or Express's 404 produced: its
/// request left every router, so the end-of-request log shows the full
/// path.
#[derive(Debug, Clone, Copy)]
pub struct Unrouted;

/// `path` is `/api` or below it (case-insensitive, as Express mounts).
fn under_api(path: &str) -> bool {
    path.get(..4)
        .is_some_and(|p| p.eq_ignore_ascii_case("/api"))
        && matches!(path.as_bytes().get(4), None | Some(b'/'))
}

/// The sign-in routes that start the jobs once answered.
const SIGN_INS: [&str; 4] = [
    "/api/v1/auth/plex",
    "/api/v1/auth/jellyfin",
    "/api/v1/auth/jellyfin/quickconnect/authenticate",
    "/api/v1/auth/local",
];

/// Express's route matching: case-insensitive, one optional trailing slash.
fn route_is(path: &str, route: &str) -> bool {
    let trimmed = if path.len() > 1 {
        path.strip_suffix('/').unwrap_or(path)
    } else {
        path
    };
    trimmed.eq_ignore_ascii_case(route)
}

/// The session restore, the request log and the job start after sign-in,
/// for `/api` requests in the desktop runtime (after csurf, before the
/// validator, as `server/index.ts` mounts them).
pub async fn api_layer(
    State(state): State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Response<Body> {
    if !on() || !under_api(req.uri().path()) {
        return next.run(req).await;
    }
    let started = Instant::now();
    let method = req.method().clone();
    let path = req.uri().path().to_owned();
    let below = path
        .get(4..)
        .filter(|p| !p.is_empty())
        .unwrap_or("/")
        .to_owned();
    tracing::info!(label = "Desktop", "API {method} {below}");
    let (mut parts, body) = req.into_parts();
    let restored = restore(&state, &mut parts).await;
    let mut res = next.run(Request::from_parts(parts, body)).await;
    if let Some((sid, cookie)) = restored {
        let sent = res
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .any(|v| v.as_bytes().starts_with(b"connect.sid="));
        // A session the handler destroyed (sign-out) sends no cookie.
        let live = state
            .db
            .session_user_id(&sid, crate::auth::now_ms())
            .await
            .ok()
            .flatten()
            .is_some();
        if !sent && live {
            if let Ok(v) = HeaderValue::from_str(&cookie) {
                res.headers_mut().append(header::SET_COOKIE, v);
            }
        }
    }
    let ok = res.status() == StatusCode::OK;
    if ok && method == Method::GET && route_is(&path, "/api/v1/auth/me") {
        res = auth_me(res).await;
        schedule_jobs(5_000);
    } else if ok && method == Method::POST && SIGN_INS.iter().any(|r| route_is(&path, r)) {
        schedule_jobs(3_000);
    }
    let shown = finish_path(&path, &res);
    tracing::info!(
        label = "Desktop",
        "API {method} {shown} {} {}ms",
        res.status().as_u16(),
        started.elapsed().as_millis()
    );
    res
}

/// `logger.info('GET /auth/me', { label: 'Auth', userId })`, with the id
/// from the answer.
async fn auth_me(res: Response<Body>) -> Response<Body> {
    use http_body_util::BodyExt;
    let (parts, body) = res.into_parts();
    let Ok(collected) = body.collect().await else {
        return Response::from_parts(parts, Body::empty());
    };
    let bytes = collected.to_bytes();
    let id = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|v| v.get("id").and_then(Value::as_i64));
    if let Some(id) = id {
        tracing::info!(label = "Auth", userId = id, "GET /auth/me");
    }
    Response::from_parts(parts, Body::from(bytes))
}

/// The routers `server/routes` mounts under `/api/v1`, deepest first; a
/// handler's `req.path` is relative to the router it is defined in.
const MOUNTS: [&str; 34] = [
    "/settings/notifications",
    "/settings/radarr",
    "/settings/sonarr",
    "/settings/discover",
    "/settings/metadatas",
    "/settings/mapping",
    "/discover/anilist",
    "/discover/mdblist",
    "/discover/watchlist",
    "/discover/trakt",
    "/discover/simkl",
    "/servarr/interventions",
    "/settings",
    "/user",
    "/search",
    "/discover",
    "/request",
    "/watchlist",
    "/blocklist",
    "/blacklist",
    "/movie",
    "/tv",
    "/media-actions",
    "/media",
    "/library",
    "/person",
    "/collection",
    "/calendar",
    "/service",
    "/issueComment",
    "/issue",
    "/auth",
    "/desktop",
    "/overrideRule",
];

/// Routes defined on the `/api/v1` router itself although a mount shares
/// their prefix.
const TOP_LEVEL: [&str; 3] = [
    "/settings/public",
    "/settings/discover",
    "/settings/notifications/pushover/sounds",
];

fn mount_matches(path: &str, mount: &str) -> bool {
    path.get(..mount.len())
        .is_some_and(|p| p.eq_ignore_ascii_case(mount))
        && matches!(path.as_bytes().get(mount.len()), None | Some(b'/'))
}

/// `req.path` when the response is finished.
fn finish_path(path: &str, res: &Response<Body>) -> String {
    let html_404 = res.status() == StatusCode::NOT_FOUND
        && res
            .headers()
            .get(header::CONTENT_TYPE)
            .is_some_and(|v| v.as_bytes().starts_with(b"text/html"));
    if html_404 || res.extensions().get::<Unrouted>().is_some() {
        return path.to_owned();
    }
    let Some(v1) = path
        .get(..7)
        .filter(|p| p.eq_ignore_ascii_case("/api/v1"))
        .and_then(|_| path.get(7..))
    else {
        return path.to_owned();
    };
    if TOP_LEVEL.iter().any(|t| route_is(v1, t)) {
        return v1.to_owned();
    }
    // isAuthenticated's 401/403 at a mount answer before the inner routers.
    let first_level = matches!(res.status().as_u16(), 401 | 403);
    let mut rest = v1.to_owned();
    for mount in MOUNTS {
        if first_level && mount.matches('/').count() > 1 {
            continue;
        }
        if mount_matches(&rest, mount) {
            let tail = rest.get(mount.len()..).unwrap_or("").to_owned();
            rest = tail;
            if mount == "/user" && !first_level {
                rest = strip_user_settings(&rest);
            }
            break;
        }
    }
    if rest.is_empty() {
        String::from("/")
    } else {
        rest
    }
}

/// The user router's `/:id/settings` mount.
fn strip_user_settings(rest: &str) -> String {
    let mut segments = rest.splitn(4, '/');
    let (Some(""), Some(id), Some(settings)) = (segments.next(), segments.next(), segments.next())
    else {
        return rest.to_owned();
    };
    if id.is_empty() || !settings.eq_ignore_ascii_case("settings") {
        return rest.to_owned();
    }
    segments
        .next()
        .map_or_else(|| String::from("/"), |tail| format!("/{tail}"))
}

// --- jobs -----------------------------------------------------------------

/// `setTimeout(() => { startJobs(); startDesktopCatchUp(); }, delay)`.
fn schedule_jobs(delay_ms: u64) {
    let Some(state) = STATE.get().cloned() else {
        return;
    };
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        // `stopJobs()` ran meanwhile; Node's process is exiting by now.
        if stopping() {
            return;
        }
        scheduler::start(Arc::clone(&state)).await;
        start_catch_up();
    });
}

/// `startJobs(); startDesktopCatchUp();` right away (the first account).
pub fn start_jobs_now(state: &Arc<AppState>) {
    if !on() {
        return;
    }
    attach(state);
    start_catch_up();
}

/// `startDesktopCatchUp()`: one pass, thirty seconds from now, unless one
/// is already queued.
pub fn start_catch_up() {
    if !on() || stopping() {
        return;
    }
    let Some(state) = STATE.get().cloned() else {
        return;
    };
    let mut pending = crate::sync::lock(&CATCH_UP_PENDING);
    if pending.is_some() {
        return;
    }
    let task = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        *crate::sync::lock(&CATCH_UP_PENDING) = None;
        if let Err(e) = catch_up(&state).await {
            tracing::warn!(
                label = "Jobs",
                message = %format!("{e:#}"),
                "Desktop catch-up evaluation failed"
            );
        }
    });
    *pending = Some(task.abort_handle());
}

/// `stopJobs()` as the desktop shutdown runs it.
///
/// The catch-up and the deferred heavy jobs are dropped and the scheduler
/// stops (its timers, queue and active runs). The runs end on their own;
/// the shutdown waits for them with [`scheduler::idle`].
pub fn stop_jobs() {
    let pending = crate::sync::lock(&CATCH_UP_PENDING).take();
    if let Some(task) = pending {
        task.abort();
    }
    DOWNLOAD_STARTUP_RUN.store(false, Ordering::SeqCst);
    crate::sync::lock(&DEFERRED).clear();
    scheduler::stop();
    tracing::info!(label = "Jobs", "Scheduled jobs stopped");
}

/// The cron callback's `runScheduledJob` check: a heavy job firing during
/// playback is kept (once per id) for the catch-up. True when deferred.
#[must_use]
pub fn defer(def: &'static JobDef) -> bool {
    if !on() || def.weight != Weight::Heavy || !PLAYBACK.load(Ordering::SeqCst) {
        return false;
    }
    let mut deferred = crate::sync::lock(&DEFERRED);
    if !deferred.iter().any(|d| d.id == def.id) {
        deferred.push(def);
    }
    drop(deferred);
    tracing::info!(
        label = "Jobs",
        "Deferring heavy job while desktop playback is active: {}",
        def.log_name
    );
    true
}

/// `runScheduledJobById(id)` (without the cron callback's log).
async fn run_scheduled(state: &Arc<AppState>, def: &'static JobDef) {
    if defer(def) {
        return;
    }
    if let Err(e) = scheduler::execute_managed(Arc::clone(state), def.id, def.weight).await {
        tracing::error!(
            label = "Jobs",
            message = %e,
            "Failed to record scheduled job: {}",
            def.log_name
        );
    }
}

/// `runDeferredHeavyJobs()`: one at a time, unless playback resumed.
async fn run_deferred(state: &Arc<AppState>) -> anyhow::Result<()> {
    if PLAYBACK.load(Ordering::SeqCst) {
        return Ok(());
    }
    let jobs = std::mem::take(&mut *crate::sync::lock(&DEFERRED));
    for def in jobs {
        tracing::info!(
            label = "Jobs",
            "Resuming heavy job deferred by desktop playback: {}",
            def.log_name
        );
        scheduler::execute_managed(Arc::clone(state), def.id, Weight::Heavy).await?;
    }
    Ok(())
}

/// The catch-up pass of `startDesktopCatchUp`.
async fn catch_up(state: &Arc<AppState>) -> anyhow::Result<()> {
    if !DOWNLOAD_STARTUP_RUN.swap(true, Ordering::SeqCst) {
        scheduler::execute_managed(Arc::clone(state), "download-sync-reset", Weight::Light).await?;
        scheduler::execute_managed(Arc::clone(state), "download-sync", Weight::Light).await?;
    }
    run_deferred(state).await?;
    for (def, schedule) in scheduler::scheduled() {
        if matches!(
            def.id,
            "download-sync-reset" | "download-sync" | "image-cache-cleanup"
        ) {
            continue;
        }
        let recorded = execution_state(state, def.id).await?;
        let now = crate::clock::now_millis();
        if crate::jobs::catchup::can_run_launch_catch_up(&schedule, def.weight, recorded, now) {
            tracing::info!(label = "Jobs", "Running desktop catch-up: {}", def.name);
            run_scheduled(state, def).await;
        }
    }
    Ok(())
}

/// The job's `job_execution_state` row, as `CatchUpState`.
async fn execution_state(
    state: &AppState,
    id: &str,
) -> anyhow::Result<crate::jobs::catchup::CatchUpState> {
    let db = &state.db;
    let sql = format!(
        r#"SELECT {} AS "lastSucceededAt", {} AS "lastFailedAt" FROM "job_execution_state" WHERE "jobId" = ?1"#,
        crate::naivetime::select(db, r#""lastSucceededAt""#),
        crate::naivetime::select(db, r#""lastFailedAt""#)
    );
    let rows = db.rows(&sql, &[Bind::Text(id.to_owned())]).await?;
    let row = rows.into_iter().next().unwrap_or_default();
    let date = |key: &str| {
        row.get(key)
            .and_then(Value::as_str)
            .and_then(|text| crate::naivetime::read_millis(db, text))
    };
    Ok(crate::jobs::catchup::CatchUpState {
        last_succeeded_at: date("lastSucceededAt"),
        last_failed_at: date("lastFailedAt"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shown(path: &str, status: u16) -> String {
        let mut res = Response::new(Body::empty());
        *res.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::OK);
        finish_path(path, &res)
    }

    #[test]
    fn finish_paths_like_express() {
        assert_eq!(shown("/api/v1/status", 200), "/status", "top level");
        assert_eq!(shown("/api/v1/auth/me", 200), "/me", "auth router");
        assert_eq!(
            shown("/api/v1/desktop/browser-cache/redeem", 400),
            "/browser-cache/redeem",
            "desktop router"
        );
        assert_eq!(
            shown("/api/v1/settings/radarr/1", 200),
            "/1",
            "nested settings router"
        );
        assert_eq!(
            shown("/api/v1/settings/radarr/1", 403),
            "/radarr/1",
            "the mount's isAuthenticated"
        );
        assert_eq!(
            shown("/api/v1/user/1/settings/main", 200),
            "/main",
            "user settings router"
        );
        assert_eq!(shown("/api/v1/user/1", 200), "/1", "user router");
        assert_eq!(
            shown("/api/v1/settings/public", 200),
            "/settings/public",
            "defined on the v1 router"
        );
        assert_eq!(shown("/api/v1/auth", 200), "/", "mount root");
    }

    #[test]
    fn remembered_ids() {
        assert_eq!(remembered_id(&Value::from(3)), Some(3), "integer");
        assert_eq!(remembered_id(&Value::from(0)), None, "zero");
        assert_eq!(remembered_id(&Value::from(1.5)), None, "fraction");
        assert_eq!(remembered_id(&Value::from("3")), None, "string");
    }

    #[test]
    fn managed_urls_by_origin() {
        let origin = "http://127.0.0.1:7501";
        assert!(
            managed_url(&Value::from("http://127.0.0.1:7501/x"), origin),
            "path"
        );
        assert!(
            managed_url(&Value::from("http://127.0.0.1:7501"), origin),
            "bare"
        );
        assert!(
            !managed_url(&Value::from("http://127.0.0.1:7502"), origin),
            "port"
        );
        assert!(!managed_url(&Value::from("not a url"), origin), "invalid");
        assert!(!managed_url(&Value::from(5), origin), "not a string");
    }

    #[test]
    fn api_mount() {
        assert!(under_api("/api"), "root");
        assert!(under_api("/API/v1"), "case");
        assert!(!under_api("/apix"), "prefix only");
    }
}
