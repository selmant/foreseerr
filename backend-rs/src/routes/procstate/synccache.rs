//! The media-action sync caches (`server/lib/mediaActions/syncCache.ts`,
//! `anilistSyncCache.ts`): the per-user snapshots the media actions read,
//! kept in [`crate::mappinglayer::synccache`].

use crate::standalone::internal::Answer;

/// Which provider's snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    /// `invalidateUserSyncCache` / `clearSyncCache` (Trakt).
    Trakt,
    /// `invalidateUserAnilistSyncCache` / `clearAnilistSyncCache`.
    Anilist,
}

/// What to drop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// `invalidateUser…SyncCache(userId)`.
    User(i64, Provider),
    /// `clear…SyncCache()`.
    All(Provider),
}

/// Drop the snapshots.
pub fn apply(action: Action) {
    use crate::mappinglayer::synccache;
    match action {
        Action::User(id, Provider::Trakt) => synccache::invalidate_user_sync_cache(id),
        Action::User(id, Provider::Anilist) => synccache::invalidate_user_anilist_sync_cache(id),
        Action::All(Provider::Trakt) => synccache::clear_sync_cache(),
        Action::All(Provider::Anilist) => synccache::clear_anilist_sync_cache(),
    }
}

/// `clearSyncCache()`.
pub fn clear_all() {
    apply(Action::All(Provider::Trakt));
}

/// `clearAnilistSyncCache()`.
pub fn clear_anilist() {
    apply(Action::All(Provider::Anilist));
}

/// `invalidateUserSyncCache(userId)` / `invalidateUserAnilistSyncCache`.
pub fn invalidate_user(user_id: i64, provider: Provider) {
    apply(Action::User(user_id, provider));
}

/// `POST /internal/user/:id/sync-cache/:provider/invalidate`, as Node
/// answered it.
#[must_use]
pub fn answer(id: &str, provider: &str) -> Answer {
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
    invalidate_user(user_id, provider);
    Answer::no_content()
}
