//! The media-action sync caches (`server/lib/mediaActions/syncCache.ts`,
//! `anilistSyncCache.ts`): the per-user snapshots the media actions read.
//!
//! They belong to the mapping port. [`rust_side`] is **the stub** that
//! port's merge fills in (its `mappinglayer::synccache` functions, when
//! `mappinglayer::owned()`). While Node runs it keeps its own copy for the
//! media-action routes it serves, so Node is told too, through its
//! `/internal` routes for that (which touch nothing else).

use serde_json::{json, Value};

use crate::standalone::internal::Answer;
use crate::state::AppState;

/// Which provider's snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    /// `invalidateUserSyncCache` / `clearSyncCache` (Trakt).
    Trakt,
    /// `invalidateUserAnilistSyncCache` / `clearAnilistSyncCache`.
    Anilist,
}

impl Provider {
    const fn path(self) -> &'static str {
        match self {
            Self::Trakt => "trakt",
            Self::Anilist => "anilist",
        }
    }
}

/// What to drop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// `invalidateUser…SyncCache(userId)`.
    User(i64, Provider),
    /// `clear…SyncCache()`.
    All(Provider),
}

/// Drop this process's snapshots, when the mapping layer here owns them.
fn rust_side(action: Action) {
    use crate::mappinglayer::synccache;
    if !crate::mappinglayer::owned() {
        return;
    }
    match action {
        Action::User(id, Provider::Trakt) => synccache::invalidate_user_sync_cache(id),
        Action::User(id, Provider::Anilist) => synccache::invalidate_user_anilist_sync_cache(id),
        Action::All(Provider::Trakt) => synccache::clear_sync_cache(),
        Action::All(Provider::Anilist) => synccache::clear_anilist_sync_cache(),
    }
}

/// Drop the snapshots here and, while Node runs, Node's copy.
pub async fn apply(state: &AppState, action: Action) {
    rust_side(action);
    if crate::standalone::enabled() {
        return;
    }
    match action {
        Action::User(user_id, provider) => {
            let path = format!("/user/{user_id}/sync-cache/{}/invalidate", provider.path());
            post_node(state, &path, None).await;
        }
        Action::All(provider) => {
            let effect = match provider {
                Provider::Trakt => "clearSyncCache",
                Provider::Anilist => "clearAnilistSyncCache",
            };
            let body = json!({ "effects": [effect] });
            post_node(state, "/settings/effects", Some(&body)).await;
        }
    }
}

/// `clearSyncCache()`.
pub async fn clear_all(state: &AppState) {
    apply(state, Action::All(Provider::Trakt)).await;
}

/// `clearAnilistSyncCache()`.
pub async fn clear_anilist(state: &AppState) {
    apply(state, Action::All(Provider::Anilist)).await;
}

/// `invalidateUserSyncCache(userId)` / `invalidateUserAnilistSyncCache`.
pub async fn invalidate_user(state: &AppState, user_id: i64, provider: Provider) {
    apply(state, Action::User(user_id, provider)).await;
}

/// `POST /internal/user/:id/sync-cache/:provider/invalidate`, as Node
/// answers it (only reached without Node).
pub async fn answer(state: &AppState, id: &str, provider: &str) -> Answer {
    let number = crate::jsval::number_of_str(id);
    if !number.is_finite() || number.fract() != 0.0 {
        return Answer::message(400, "Invalid user id");
    }
    let provider = match provider {
        "trakt" => Provider::Trakt,
        "anilist" => Provider::Anilist,
        _ => return Answer::message(404, "Unknown provider"),
    };
    let user_id = format!("{number:.0}").parse().unwrap_or(0);
    invalidate_user(state, user_id, provider).await;
    Answer::no_content()
}

/// Tell Node; failures are only logged, as a cache reset can't fail there.
async fn post_node(state: &AppState, path: &str, body: Option<&Value>) {
    let Ok(settings) = super::settings(state).await else {
        tracing::warn!("Node's sync cache could not be reset: settings unreadable");
        return;
    };
    let url = format!(
        "{}/internal{path}",
        state.env.node_url.trim_end_matches('/')
    );
    let mut request = state
        .internal
        .post(url)
        .header("X-API-Key", settings.api_key());
    if let Some(body) = body {
        request = request.json(body);
    }
    match request.send().await {
        Ok(res) if res.status().is_success() => {}
        Ok(res) => tracing::warn!("Node refused {path}: {}", res.status()),
        Err(e) => tracing::warn!("Node could not be asked for {path}: {e:#}"),
    }
}
