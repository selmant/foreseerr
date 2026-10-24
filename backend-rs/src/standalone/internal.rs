//! Node's `/internal` routes (`server/routes/internal.ts`) answered
//! in-process.
//!
//! Every Rust call site that would call Node over HTTP calls
//! [`call`] instead in standalone mode, with the same method, path (below
//! `/internal`) and JSON body, and reads the [`Answer`] like the HTTP
//! response it replaces.
//!
//! Three groups:
//! - core, answered here: `POST /settings/reload` is a no-op (the settings
//!   store re-reads settings.json when it changes). The download tracker,
//!   the job and scanner state and the calendar source statuses are the
//!   Rust scheduler's in standalone mode (it implies `FORESEERR_RUST_JOBS`),
//!   so their call sites read them directly and never get here.
//! - mapping layer: [`super::pending_mapping`].
//! - Node process state: [`super::pending_nodestate`].

use axum::http::Method;
use serde_json::{json, Value};

use crate::state::AppState;

/// What an internal route answered: the status and the JSON body (`Null`
/// for an empty one).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Answer {
    /// The HTTP status Node would send.
    pub status: u16,
    /// The JSON body, `Null` when there is none.
    pub body: Value,
}

impl Answer {
    /// A JSON answer.
    #[must_use]
    pub const fn json(status: u16, body: Value) -> Self {
        Self { status, body }
    }

    /// `res.status(204).end()`.
    #[must_use]
    pub const fn no_content() -> Self {
        Self {
            status: 204,
            body: Value::Null,
        }
    }

    /// `{ message }` with a status, as Node's internal routes fail.
    #[must_use]
    pub fn message(status: u16, message: &str) -> Self {
        Self::json(status, json!({ "message": message }))
    }

    /// A 2xx.
    #[must_use]
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// The body of a 2xx, or the failure as `reqwest`'s `error_for_status`
    /// would report it (with Node's message when there is one).
    ///
    /// # Errors
    ///
    /// Any status outside 2xx.
    pub fn into_result(self, path: &str) -> anyhow::Result<Value> {
        if self.is_success() {
            return Ok(self.body);
        }
        let message = self
            .body
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("no message");
        Err(anyhow::anyhow!(
            "/internal{path} answered {} in-process: {message}",
            self.status
        ))
    }
}

/// Which side owns an internal route.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Group {
    /// Answered in this module.
    Core,
    /// The mapping layer ([`super::pending_mapping`]).
    Mapping,
    /// Node process state ([`super::pending_nodestate`]).
    NodeState,
}

/// The group an internal path belongs to; `None` for a path Node has no
/// route for.
#[must_use]
pub fn group(path: &str) -> Option<Group> {
    let path = path.split('?').next().unwrap_or("");
    let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    let first = segments.first().copied().unwrap_or("");
    let second = segments.get(1).copied();
    match (first, second) {
        ("settings", Some("reload"))
        | ("downloads" | "jobs" | "scanners", _)
        | ("calendar", Some("source-statuses")) => Some(Group::Core),
        ("mapping" | "animelist", _)
        | ("simkl", Some("resolve"))
        | ("discover", Some("watched")) => Some(Group::Mapping),
        ("settings", Some("effects"))
        | ("auth", Some("avatar-check"))
        | ("cache" | "integrations" | "metadata" | "user", _)
        | ("trakt", Some("refresh"))
        | ("simkl", Some("sync")) => Some(Group::NodeState),
        _ => None,
    }
}

/// `/internal{path}` answered in-process.
pub async fn call(state: &AppState, method: &Method, path: &str, body: Option<&Value>) -> Answer {
    match group(path) {
        Some(Group::Core) => core(method, path),
        Some(Group::Mapping) => super::pending_mapping::call(state, method, path, body).await,
        Some(Group::NodeState) => super::pending_nodestate::call(state, method, path, body).await,
        None => Answer::message(404, "Unknown internal route"),
    }
}

fn core(method: &Method, path: &str) -> Answer {
    let path = path.split('?').next().unwrap_or("");
    if *method == Method::POST && path == "/settings/reload" {
        // settings.json was written by this process; the store reloads it.
        return Answer::no_content();
    }
    // Downloads, jobs, scanners and calendar statuses: the call sites read
    // the Rust scheduler's state directly when it owns the jobs, which it
    // always does in standalone mode.
    tracing::warn!("/internal{path} reached the in-process dispatcher; its caller should read the Rust scheduler instead");
    Answer::message(501, "Answered by the Rust scheduler at the call site")
}

/// The answer a group that is not ported yet gives: 501 with a message the
/// call sites log.
#[must_use]
pub fn pending(group: &str, path: &str) -> Answer {
    tracing::warn!(
        "/internal{path} needs the {group} port, which standalone mode doesn't have yet"
    );
    Answer::message(
        501,
        &format!("/internal{path} is not available in standalone mode yet ({group})"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_every_node_route() {
        let core = [
            "/settings/reload",
            "/downloads",
            "/jobs",
            "/jobs/plex-sync/run",
            "/scanners/plex",
            "/calendar/source-statuses",
            "/jobs/start",
        ];
        for path in core {
            assert_eq!(group(path), Some(Group::Core), "{path}");
        }
        let mapping = [
            "/mapping/confirm",
            "/mapping/datasets/changed",
            "/animelist/sync",
            "/animelist/anidb/1",
            "/discover/watched/3",
            "/simkl/resolve",
        ];
        for path in mapping {
            assert_eq!(group(path), Some(Group::Mapping), "{path}");
        }
        let node_state = [
            "/settings/effects",
            "/auth/avatar-check",
            "/cache",
            "/cache/tmdb/flush",
            "/integrations/health/clear",
            "/metadata/tv/anime/1",
            "/trakt/refresh",
            "/simkl/sync",
            "/user/1/sync-cache/trakt/invalidate",
        ];
        for path in node_state {
            assert_eq!(group(path), Some(Group::NodeState), "{path}");
        }
        assert_eq!(group("/nope"), None, "unknown");
        assert_eq!(group("/settings/other"), None, "unknown settings route");
    }

    #[test]
    fn answers_read_like_responses() {
        assert_eq!(
            Answer::no_content().into_result("/x").ok(),
            Some(Value::Null),
            "204"
        );
        let failed = Answer::message(501, "later").into_result("/x");
        assert!(
            failed.is_err_and(|e| e.to_string().contains("501") && e.to_string().contains("later")),
            "the status and message"
        );
    }
}
