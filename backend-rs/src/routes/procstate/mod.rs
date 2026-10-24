//! Node's process-state routes (`server/routes/internal.ts`) answered in
//! this process.
//!
//! The response caches, integration health, the settings
//! side effects, the TVDB metadata provider, the Trakt token refresh, the
//! Simkl sync and the login avatar check.
//!
//! The state is this process's whenever it runs the jobs
//! ([`crate::jobs::scheduler::rust_jobs`], which standalone mode implies):
//! the call sites then come here ([`in_process`]) instead of asking Node.
//! The per-user media-action sync caches stay Node's until the mapping
//! port has them ([`synccache`]).

pub mod avatar;
pub mod caches;
pub mod effects;
pub mod health;
pub mod simklsync;
pub mod synccache;
pub mod traktrefresh;
pub mod tvdbshow;

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock, Weak};

use axum::http::Method;
use serde_json::{Map, Value};

use crate::standalone::internal::{group, Answer, Group};
use crate::state::AppState;
use crate::sync::lock;

static APP: OnceLock<Weak<AppState>> = OnceLock::new();

/// Remember the application state for work reached without it (the Trakt
/// client's token refresh, the image cache behind the avatar check).
pub fn register(state: &Arc<AppState>) {
    // A second registration keeps the first.
    let _first = APP.set(Arc::downgrade(state)).is_ok();
}

/// The registered application state.
#[must_use]
pub fn app() -> Option<Arc<AppState>> {
    APP.get().and_then(Weak::upgrade)
}

/// Whether `/internal{path}` is answered here rather than by Node.
///
/// Always without Node, and for the process state this process owns when
/// it runs the jobs. The sync caches (`/user/:id/sync-cache/*`) stay Node's while
/// Node runs.
#[must_use]
pub fn in_process(path: &str) -> bool {
    crate::standalone::enabled() || (crate::jobs::scheduler::rust_jobs() && owned(path))
}

fn owned(path: &str) -> bool {
    group(path) == Some(Group::NodeState) && !path.starts_with("/user/")
}

/// `/internal{path}` for the Node process-state routes.
pub async fn call(state: &AppState, method: &Method, path: &str, body: Option<&Value>) -> Answer {
    let clean = path.split('?').next().unwrap_or("");
    let raw: Vec<&str> = clean.trim_start_matches('/').split('/').collect();
    // Express decodes every parameter; one it can't decode is a 400.
    let Some(segments) = raw
        .iter()
        .map(|s| super::nodestate::decode_segment(s))
        .collect::<Option<Vec<String>>>()
    else {
        return Answer::message(400, &format!("Failed to decode param '{clean}'"));
    };
    let segments: Vec<&str> = segments.iter().map(String::as_str).collect();
    let post = *method == Method::POST;
    let get = *method == Method::GET;
    match segments.as_slice() {
        ["cache"] if get => caches::stats(state).await,
        ["cache", "dns", entry, "flush"] if post => caches::flush_dns(entry),
        ["cache", "images", "flush"] if post => caches::flush_images(&state.env.config_dir).await,
        ["cache", "all", "flush"] if post => caches::flush_all(&state.env.config_dir).await,
        ["cache", id, "flush"] if post => caches::flush(id),
        ["integrations", "health"] if get => health::answer(state, false).await,
        ["integrations", "health", "refresh"] if post => health::answer(state, true).await,
        ["integrations", "health", "clear"] if post => {
            health::clear();
            Answer::no_content()
        }
        ["settings", "effects"] if post => effects::answer(state, body).await,
        ["metadata", "tv", kind, id] if get => tvdbshow::answer(state, kind, id).await,
        ["trakt", "refresh"] if post => traktrefresh::answer(state, body).await,
        ["simkl", "sync"] if post => simklsync::answer(state, body).await,
        ["auth", "avatar-check"] if post => avatar::answer(state, body).await,
        ["user", id, "sync-cache", provider, "invalidate"] if post => {
            synccache::answer(state, id, provider).await
        }
        _ => Answer::message(404, "Unknown internal route"),
    }
}

/// `POST /internal/trakt/refresh` for the Trakt client, which holds no
/// application state.
///
/// Boxed: the refresh's profile lookup goes through a Trakt client again.
#[must_use]
pub fn trakt_refresh(body: &Value) -> Pin<Box<dyn Future<Output = Answer> + Send + '_>> {
    Box::pin(async move {
        match app() {
            Some(state) => traktrefresh::answer(&state, Some(body)).await,
            None => Answer::message(503, "The application state isn't ready"),
        }
    })
}

/// `AsyncLock`: work for one key runs one at a time, in arrival order.
#[derive(Debug, Default)]
pub struct KeyLock(Mutex<HashMap<i64, Arc<tokio::sync::Mutex<()>>>>);

impl KeyLock {
    /// The lock for `key`, held until the guard drops.
    pub async fn acquire(&self, key: i64) -> tokio::sync::OwnedMutexGuard<()> {
        let mutex = Arc::clone(lock(&self.0).entry(key).or_default());
        mutex.lock_owned().await
    }
}

/// `JSON.stringify` of a parsed response: JavaScript key order and number
/// printing.
#[must_use]
pub fn js_stringify(value: &Value) -> String {
    fn order(value: Value) -> Value {
        match value {
            Value::Object(map) => Value::Object(super::nodestate::js_key_order(
                map.into_iter().map(|(k, v)| (k, order(v))).collect(),
            )),
            Value::Array(items) => Value::Array(items.into_iter().map(order).collect()),
            other @ (Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)) => other,
        }
    }
    order(crate::tmdb::js_numbers(value.clone())).to_string()
}

/// `{ name, message }` of a thrown error, as the internal routes report it.
#[must_use]
pub fn error_object(name: &str, message: &str) -> Value {
    let mut out = Map::new();
    out.insert(String::from("name"), Value::from(name));
    out.insert(String::from("message"), Value::from(message));
    Value::Object(out)
}

/// The current settings, or the reason they can't be read.
///
/// # Errors
///
/// When settings.json can't be read.
pub async fn settings(state: &AppState) -> anyhow::Result<Arc<crate::settings::Settings>> {
    state.settings.current().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn owns_the_node_state_routes_but_the_sync_caches() {
        for path in [
            "/cache",
            "/cache/tmdb/flush",
            "/integrations/health",
            "/settings/effects",
            "/metadata/tv/tv/1",
            "/trakt/refresh",
            "/simkl/sync",
            "/auth/avatar-check",
        ] {
            assert!(owned(path), "{path}");
        }
        for path in [
            "/user/1/sync-cache/trakt/invalidate",
            "/simkl/resolve",
            "/mapping/confirm",
            "/settings/reload",
            "/jobs",
        ] {
            assert!(!owned(path), "{path}");
        }
    }

    #[test]
    fn stringifies_like_javascript() {
        assert_eq!(
            js_stringify(&json!({"b": 1.0, "2": "x", "a": [1.5, {"10": 0, "1": 0}]})),
            r#"{"2":"x","b":1,"a":[1.5,{"1":0,"10":0}]}"#,
            "index keys first, integral floats as integers"
        );
    }
}
