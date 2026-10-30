//! The mapping layer's `/internal` routes.
//!
//! `/internal/mapping/*` (confirm, resolve-items, posters, unmapped,
//! trakt-ids, anilist-media, flush, status, invalidate, datasets),
//! `/internal/animelist/*`, `/internal/discover/watched/:userId` and
//! `/internal/simkl/resolve`, answered by [`crate::mappinglayer`].

use axum::http::Method;
use serde_json::Value;

use super::internal::{pending, Answer};
use crate::state::AppState;

/// `/internal{path}` for the mapping routes.
pub async fn call(state: &AppState, method: &Method, path: &str, body: Option<&Value>) -> Answer {
    // Boxed: the dispatcher's future is large, and every internal call
    // site embeds this one.
    Box::pin(crate::mappinglayer::answer(state, method, path, body))
        .await
        .unwrap_or_else(|| pending("mapping", path))
}
