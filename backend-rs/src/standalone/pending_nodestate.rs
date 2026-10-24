//! SEAM (Node process state).
//!
//! Node's routes over in-memory state, answered in-process:
//! `/internal/settings/effects`, `/internal/auth/avatar-check`,
//! `/internal/cache*`, `/internal/integrations/health*`,
//! `/internal/metadata/tv/*`, `/internal/trakt/refresh`,
//! `/internal/simkl/sync` and `/internal/user/:id/sync-cache/*`, by
//! [`crate::routes::procstate`]. The Trakt client reaches its refresh
//! through [`crate::routes::procstate::trakt_refresh`].

use axum::http::Method;
use serde_json::Value;

use super::internal::Answer;
use crate::state::AppState;

/// `/internal{path}` for the Node process-state routes.
pub async fn call(state: &AppState, method: &Method, path: &str, body: Option<&Value>) -> Answer {
    crate::routes::procstate::call(state, method, path, body).await
}
