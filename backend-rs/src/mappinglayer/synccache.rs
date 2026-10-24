//! The per-user warm sync caches.
//!
//! `lib/mediaActions/syncCache.ts` (Trakt) and `anilistSyncCache.ts`
//! (`AniList`), over `userSnapshotCache.ts` (invalidation generations,
//! shared in-flight fetches, scoped and global clearing). Snapshots live
//! for two hours.
//!
//! The media actions lay their writes over a snapshot ([`patch_trakt`],
//! [`patch_anilist`]) and keep them as pending patches until the
//! provider's answers reflect them, as Node's do.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};

use serde_json::{Map, Value};
use tokio::sync::watch;

use super::{discover, Ctx, MediaType};
use crate::anilist::Anilist;
use crate::sync::lock;
use crate::trakt::{TraktClient, TraktError};

const DEFAULT_TTL_SECONDS: f64 = 7200.0;

/// A shared in-flight fetch: its result once it settles. The sender
/// going away without a result (a fetch whose caller was dropped) leaves
/// the next caller to fetch again.
type Flight<T, E> = watch::Receiver<Option<Result<T, E>>>;
/// The side of a [`Flight`] that settles it.
type Lead<T, E> = watch::Sender<Option<Result<T, E>>>;

/// `UserSnapshotCache`.
#[derive(Debug)]
struct UserCache<T, E> {
    snapshots: HashMap<i64, T>,
    inflight: HashMap<i64, Flight<T, E>>,
    users: HashMap<i64, u64>,
    global: u64,
}

impl<T, E> Default for UserCache<T, E> {
    fn default() -> Self {
        Self {
            snapshots: HashMap::new(),
            inflight: HashMap::new(),
            users: HashMap::new(),
            global: 0,
        }
    }
}

impl<T: Clone, E> UserCache<T, E> {
    fn generation(&self, user: i64) -> (u64, u64) {
        (self.users.get(&user).copied().unwrap_or(0), self.global)
    }

    fn is_stale(&self, user: i64, generation: (u64, u64)) -> bool {
        generation != self.generation(user)
    }

    fn invalidate_user(&mut self, user: i64) {
        *self.users.entry(user).or_insert(0) += 1;
        self.snapshots.remove(&user);
        self.inflight.remove(&user);
    }

    fn clear(&mut self) {
        self.global += 1;
        self.snapshots.clear();
        self.inflight.clear();
    }

    /// The in-flight fetch to join, or a new one this caller leads (with
    /// the sender that settles it).
    fn flight(&mut self, user: i64) -> (Flight<T, E>, Option<Lead<T, E>>) {
        if let Some(flight) = self.inflight.get(&user) {
            if flight.has_changed().is_ok() || flight.borrow().is_some() {
                return (flight.clone(), None);
            }
        }
        let (lead, flight) = watch::channel(None);
        self.inflight.insert(user, flight.clone());
        (flight, Some(lead))
    }

    /// `.finally(() => inflight.delete(userId))`: forget `flight` once it
    /// settled, unless a newer fetch replaced it.
    fn settle(&mut self, user: i64, flight: &Flight<T, E>) {
        if self
            .inflight
            .get(&user)
            .is_some_and(|f| f.same_channel(flight))
        {
            self.inflight.remove(&user);
        }
    }
}

/// Wait for a flight's result; `None` when its fetch was dropped unsettled.
async fn landed<T: Clone + Send + Sync, E: Clone + Send + Sync>(
    mut flight: Flight<T, E>,
) -> Option<Result<T, E>> {
    let settled = flight.wait_for(Option::is_some).await.ok()?;
    settled.as_ref().cloned()
}

fn now_seconds() -> f64 {
    crate::jsnum::now() / 1000.0
}

fn expired(fetched_at: f64) -> bool {
    now_seconds() - fetched_at > DEFAULT_TTL_SECONDS
}

// ---------------------------------------------------------------------------
// Trakt.

/// `UserSyncSnapshot`.
#[derive(Debug, Clone, Default)]
pub struct TraktSnapshot {
    /// `/sync/watched/movies`.
    pub watched_movies: Vec<Value>,
    /// `/sync/watched/shows`.
    pub watched_shows: Vec<Value>,
    /// `/sync/ratings/movies`.
    pub ratings_movies: Vec<Value>,
    /// `/sync/ratings/shows`.
    pub ratings_shows: Vec<Value>,
    /// Seconds since the epoch.
    pub fetched_at: f64,
}

/// `SyncItemPatch`: what a media action changed on one title.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct TraktPatch {
    /// `watched`, when set.
    pub watched: Option<bool>,
    /// `rating`, when set: a 1–10 score or `null` to clear.
    pub rating: Option<Option<f64>>,
}

/// `PendingPatch`.
#[derive(Debug, Clone, Copy, PartialEq)]
struct TraktPending {
    media_type: MediaType,
    tmdb_id: i64,
    update: TraktPatch,
}

type TraktCache = UserCache<Arc<TraktSnapshot>, TraktError>;

static TRAKT: LazyLock<Mutex<TraktCache>> = LazyLock::new(|| Mutex::new(UserCache::default()));

/// `pendingPatches`: local writes laid over Trakt's answers until Trakt
/// reflects them.
static TRAKT_PENDING: LazyLock<Mutex<HashMap<i64, Vec<TraktPending>>>> =
    LazyLock::new(Mutex::default);

/// `invalidateUserSyncCache(userId)`.
pub fn invalidate_user_sync_cache(user_id: i64) {
    lock(&TRAKT).invalidate_user(user_id);
    lock(&TRAKT_PENDING).remove(&user_id);
}

/// `clearSyncCache()`.
pub fn clear_sync_cache() {
    lock(&TRAKT).clear();
    lock(&TRAKT_PENDING).clear();
}

/// `getUserSyncSnapshot(userId)`.
#[must_use]
pub fn trakt_snapshot(user_id: i64) -> Option<Arc<TraktSnapshot>> {
    lock(&TRAKT).snapshots.get(&user_id).cloned()
}

/// `seedUserSyncCache(userId, snapshot)`.
pub fn seed_trakt(user_id: i64, snapshot: TraktSnapshot) {
    lock(&TRAKT).snapshots.insert(user_id, Arc::new(snapshot));
}

/// `getPendingPatchCount(userId)`.
#[must_use]
pub fn trakt_pending_count(user_id: i64) -> usize {
    lock(&TRAKT_PENDING).get(&user_id).map_or(0, Vec::len)
}

const fn item_key(media_type: MediaType) -> &'static str {
    match media_type {
        MediaType::Movie => "movie",
        MediaType::Tv => "show",
    }
}

/// `entry?.[key]?.ids?.tmdb`, unless null.
fn tmdb_of<'v>(entry: &'v Value, key: &str) -> Option<&'v Value> {
    entry
        .get(key)
        .and_then(|item| item.get("ids"))
        .and_then(|ids| ids.get("tmdb"))
        .filter(|tmdb| !tmdb.is_null())
}

/// `entryMatchesTmdb`: `Number(ids.tmdb) === Number(tmdbId)`.
fn matches_number(entry: &Value, key: &str, tmdb_id: i64) -> bool {
    tmdb_of(entry, key).is_some_and(|tmdb| {
        crate::jsval::same(
            crate::jsval::number_of(Some(tmdb)),
            crate::jsnum::from_i64(tmdb_id),
        )
    })
}

/// `String(ids.tmdb) === String(tmdbId)` (`payloadContainsTmdb`).
fn matches_text(entry: &Value, key: &str, tmdb_id: i64) -> bool {
    tmdb_of(entry, key)
        .is_some_and(|tmdb| crate::jsnum::value_string(Some(tmdb)) == tmdb_id.to_string())
}

/// `lookupItemStatus(snapshot, mediaType, tmdbId)`: watched, and the
/// rating (`Number(entry.rating)`) of the first matching rating entry.
#[must_use]
pub fn lookup_trakt(
    snapshot: &TraktSnapshot,
    media_type: MediaType,
    tmdb_id: i64,
) -> (bool, Option<f64>) {
    let key = item_key(media_type);
    let (watched, ratings) = match media_type {
        MediaType::Movie => (&snapshot.watched_movies, &snapshot.ratings_movies),
        MediaType::Tv => (&snapshot.watched_shows, &snapshot.ratings_shows),
    };
    let is_watched = watched.iter().any(|e| matches_text(e, key, tmdb_id));
    let rating = ratings
        .iter()
        .find(|e| matches_text(e, key, tmdb_id))
        .and_then(|e| e.get("rating").filter(|r| !r.is_null()))
        .map(|r| crate::jsval::number_of(Some(r)));
    (is_watched, rating)
}

fn stub_entry(key: &str, tmdb_id: i64, rating: Option<f64>) -> Value {
    let mut ids = Map::new();
    ids.insert(String::from("tmdb"), Value::from(tmdb_id));
    let mut item = Map::new();
    item.insert(String::from("ids"), Value::Object(ids));
    let mut entry = Map::new();
    entry.insert(key.to_owned(), Value::Object(item));
    if let Some(rating) = rating {
        entry.insert(String::from("rating"), crate::jsval::num(rating));
    }
    Value::Object(entry)
}

/// `applyPatchToSnapshot`.
fn apply_trakt_patch(snapshot: &mut TraktSnapshot, pending: &TraktPending) {
    let key = item_key(pending.media_type);
    let id = pending.tmdb_id;
    let (watched, ratings) = match pending.media_type {
        MediaType::Movie => (&mut snapshot.watched_movies, &mut snapshot.ratings_movies),
        MediaType::Tv => (&mut snapshot.watched_shows, &mut snapshot.ratings_shows),
    };
    match pending.update.watched {
        Some(true) => {
            if !watched.iter().any(|e| matches_number(e, key, id)) {
                watched.push(stub_entry(key, id, None));
            }
        }
        Some(false) => watched.retain(|e| !matches_number(e, key, id)),
        None => {}
    }
    match pending.update.rating {
        Some(None) => ratings.retain(|e| !matches_number(e, key, id)),
        Some(Some(rating)) => {
            ratings.retain(|e| !matches_number(e, key, id));
            ratings.push(stub_entry(key, id, Some(rating)));
        }
        None => {}
    }
}

/// `patchIsReflected`.
fn trakt_reflected(snapshot: &TraktSnapshot, pending: &TraktPending) -> bool {
    let (watched, rating) = lookup_trakt(snapshot, pending.media_type, pending.tmdb_id);
    if pending.update.watched.is_some_and(|w| w != watched) {
        return false;
    }
    match pending.update.rating {
        Some(None) => rating.is_none(),
        Some(Some(wanted)) => rating == Some(wanted),
        None => true,
    }
}

/// `applyPendingPatches(userKey, snapshot)`: lay the unreflected patches
/// over `snapshot`, dropping the ones Trakt caught up with.
fn apply_trakt_pending(user: i64, snapshot: &mut TraktSnapshot) {
    let mut pending = lock(&TRAKT_PENDING);
    let Some(patches) = pending.get(&user).filter(|p| !p.is_empty()).cloned() else {
        return;
    };
    let mut remaining = Vec::new();
    for patch in patches {
        if !trakt_reflected(snapshot, &patch) {
            apply_trakt_patch(snapshot, &patch);
            remaining.push(patch);
        }
    }
    if remaining.is_empty() {
        pending.remove(&user);
    } else {
        pending.insert(user, remaining);
    }
}

/// `coalescePending`: one patch per title, later fields winning, in
/// first-seen order.
fn coalesce_trakt(patches: Vec<TraktPending>) -> Vec<TraktPending> {
    let mut out: Vec<TraktPending> = Vec::new();
    for patch in patches {
        match out
            .iter_mut()
            .find(|p| p.media_type == patch.media_type && p.tmdb_id == patch.tmdb_id)
        {
            Some(previous) => {
                previous.update = TraktPatch {
                    watched: patch.update.watched.or(previous.update.watched),
                    rating: patch.update.rating.or(previous.update.rating),
                };
            }
            None => out.push(patch),
        }
    }
    out
}

/// `patchUserSyncItem(userId, mediaType, tmdbId, update)`: change one
/// title in the snapshot (seeding an empty one) and keep the change
/// until Trakt reflects it.
pub fn patch_trakt(user: i64, media_type: MediaType, tmdb_id: i64, update: TraktPatch) {
    let pending = TraktPending {
        media_type,
        tmdb_id,
        update,
    };
    {
        let mut cache = lock(&TRAKT);
        let mut snapshot = cache.snapshots.get(&user).map_or_else(
            || TraktSnapshot {
                fetched_at: now_seconds(),
                ..TraktSnapshot::default()
            },
            |s| TraktSnapshot::clone(s),
        );
        apply_trakt_patch(&mut snapshot, &pending);
        cache.snapshots.insert(user, Arc::new(snapshot));
    }
    let mut all = lock(&TRAKT_PENDING);
    let mut patches = all.remove(&user).unwrap_or_default();
    patches.push(pending);
    all.insert(user, coalesce_trakt(patches));
}

/// The fresh snapshot with the pending patches laid over it (stored
/// back), when there is one.
fn fresh_trakt(user: i64, generation: (u64, u64)) -> Option<Arc<TraktSnapshot>> {
    let current = {
        let cache = lock(&TRAKT);
        cache
            .snapshots
            .get(&user)
            .filter(|s| !expired(s.fetched_at) && !cache.is_stale(user, generation))
            .cloned()
    }?;
    if trakt_pending_count(user) == 0 {
        return Some(current);
    }
    let mut patched = TraktSnapshot::clone(&current);
    apply_trakt_pending(user, &mut patched);
    let patched = Arc::new(patched);
    let mut cache = lock(&TRAKT);
    if cache
        .snapshots
        .get(&user)
        .is_some_and(|s| Arc::ptr_eq(s, &current))
    {
        cache.snapshots.insert(user, Arc::clone(&patched));
    }
    drop(cache);
    Some(patched)
}

async fn load_trakt(client: &TraktClient, user: i64) -> Result<Arc<TraktSnapshot>, TraktError> {
    let generation = lock(&TRAKT).generation(user);
    if let Some(cached) = fresh_trakt(user, generation) {
        return Ok(cached);
    }
    let (watched_movies, watched_shows, ratings_movies, ratings_shows) = tokio::join!(
        client.sync_list("watched", false),
        client.sync_list("watched", true),
        client.sync_list("ratings", false),
        client.sync_list("ratings", true),
    );
    let mut snapshot = TraktSnapshot {
        watched_movies: watched_movies?,
        watched_shows: watched_shows?,
        ratings_movies: ratings_movies?,
        ratings_shows: ratings_shows?,
        fetched_at: now_seconds(),
    };
    if lock(&TRAKT).is_stale(user, generation) {
        return Ok(Arc::new(snapshot));
    }
    // Re-apply local writes Trakt has not caught up with, including ones
    // made while this fetch was in flight.
    apply_trakt_pending(user, &mut snapshot);
    let snapshot = Arc::new(snapshot);
    let mut cache = lock(&TRAKT);
    if !cache.is_stale(user, generation) {
        cache.snapshots.insert(user, Arc::clone(&snapshot));
    }
    drop(cache);
    Ok(snapshot)
}

/// `warmUserSyncCache(client, userId)`: the cached snapshot while fresh,
/// else one shared fetch of the four sync lists.
///
/// # Errors
///
/// Trakt's failures.
pub async fn warm_trakt(client: &TraktClient, user: i64) -> Result<Arc<TraktSnapshot>, TraktError> {
    let generation = lock(&TRAKT).generation(user);
    if let Some(cached) = fresh_trakt(user, generation) {
        return Ok(cached);
    }
    loop {
        let (flight, lead) = lock(&TRAKT).flight(user);
        if let Some(lead) = lead {
            let result = load_trakt(client, user).await;
            lead.send_replace(Some(result.clone()));
            lock(&TRAKT).settle(user, &flight);
            return result;
        }
        if let Some(result) = landed(flight).await {
            return result;
        }
    }
}

// ---------------------------------------------------------------------------
// AniList.

/// One `AnilistSyncEntry`.
#[derive(Debug, Clone, PartialEq)]
pub struct AnilistEntry {
    /// `anilistId`.
    pub anilist_id: i64,
    /// `listEntryId`.
    pub list_entry_id: Option<i64>,
    /// `tmdbId`.
    pub tmdb_id: i64,
    /// `mediaType`.
    pub media_type: MediaType,
    /// `status`.
    pub status: Option<String>,
    /// `rating`: the 1–10 score.
    pub rating: Option<f64>,
    /// `progress`: the watched-episode watermark.
    pub progress: Option<f64>,
    /// `episodeCount`.
    pub episode_count: Option<f64>,
}

/// `AnilistUserSnapshot`.
#[derive(Debug, Clone, Default)]
pub struct AnilistSnapshot {
    /// The mapped list entries.
    pub entries: Vec<AnilistEntry>,
    /// Seconds since the epoch.
    pub fetched_at: f64,
}

/// `AnilistSyncItemPatch`. A doubled `Option` is a field that can be set
/// to `null`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AnilistPatch {
    /// `watched`.
    pub watched: Option<bool>,
    /// `rating`.
    pub rating: Option<Option<f64>>,
    /// `listEntryId`.
    pub list_entry_id: Option<Option<i64>>,
    /// `status`.
    pub status: Option<Option<String>>,
    /// `anilistId`.
    pub anilist_id: Option<i64>,
    /// `progress`.
    pub progress: Option<Option<f64>>,
    /// `episodeCount`.
    pub episode_count: Option<Option<f64>>,
}

impl AnilistPatch {
    /// `{ ...previous, ...self }`.
    fn over(self, previous: Self) -> Self {
        Self {
            watched: self.watched.or(previous.watched),
            rating: self.rating.or(previous.rating),
            list_entry_id: self.list_entry_id.or(previous.list_entry_id),
            status: self.status.or(previous.status),
            anilist_id: self.anilist_id.or(previous.anilist_id),
            progress: self.progress.or(previous.progress),
            episode_count: self.episode_count.or(previous.episode_count),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
struct AnilistPending {
    media_type: MediaType,
    tmdb_id: i64,
    update: AnilistPatch,
}

impl AnilistPending {
    /// The entry this patch is about: by `AniList` id when it names one,
    /// else by title.
    fn targets(&self, entry: &AnilistEntry) -> bool {
        self.update.anilist_id.map_or_else(
            || entry.media_type == self.media_type && entry.tmdb_id == self.tmdb_id,
            |id| entry.anilist_id == id,
        )
    }
}

type AnilistCache = UserCache<Arc<AnilistSnapshot>, String>;

static ANILIST: LazyLock<Mutex<AnilistCache>> = LazyLock::new(|| Mutex::new(UserCache::default()));

static ANILIST_PENDING: LazyLock<Mutex<HashMap<i64, Vec<AnilistPending>>>> =
    LazyLock::new(Mutex::default);

/// `invalidateUserAnilistSyncCache(userId)`.
pub fn invalidate_user_anilist_sync_cache(user_id: i64) {
    lock(&ANILIST).invalidate_user(user_id);
    lock(&ANILIST_PENDING).remove(&user_id);
}

/// `clearAnilistSyncCache()`.
pub fn clear_anilist_sync_cache() {
    lock(&ANILIST).clear();
    lock(&ANILIST_PENDING).clear();
}

/// `getUserAnilistSnapshot(userId)`.
#[must_use]
pub fn anilist_snapshot(user_id: i64) -> Option<Arc<AnilistSnapshot>> {
    lock(&ANILIST).snapshots.get(&user_id).cloned()
}

/// `seedUserAnilistSyncCache(userId, snapshot)`.
pub fn seed_anilist(user_id: i64, snapshot: AnilistSnapshot) {
    lock(&ANILIST).snapshots.insert(user_id, Arc::new(snapshot));
}

/// `isAnilistWatchedStatus(status)`.
#[must_use]
pub fn is_anilist_watched_status(status: Option<&str>) -> bool {
    matches!(status, Some("COMPLETED" | "REPEATING"))
}

/// `lookupAnilistItemStatus(snapshot, mediaType, tmdbId)`.
#[must_use]
pub fn lookup_anilist(
    snapshot: &AnilistSnapshot,
    media_type: MediaType,
    tmdb_id: i64,
) -> Option<&AnilistEntry> {
    snapshot
        .entries
        .iter()
        .find(|e| e.media_type == media_type && e.tmdb_id == tmdb_id)
}

/// `lookupAnilistEntryByAnilistId(snapshot, anilistId)`.
#[must_use]
pub fn lookup_anilist_id(snapshot: &AnilistSnapshot, anilist_id: i64) -> Option<&AnilistEntry> {
    snapshot.entries.iter().find(|e| e.anilist_id == anilist_id)
}

/// `applyPatchToEntries(entries, patch)`.
fn apply_anilist_patch(entries: &mut Vec<AnilistEntry>, pending: &AnilistPending) {
    let update = &pending.update;
    let index = entries.iter().position(|e| pending.targets(e));
    let current = index.and_then(|i| entries.get(i)).cloned();
    let watched = update.watched.unwrap_or_else(|| {
        current
            .as_ref()
            .is_some_and(|c| is_anilist_watched_status(c.status.as_deref()))
    });
    let status = update
        .status
        .clone()
        .flatten()
        .or_else(|| match update.watched {
            Some(true) => Some(String::from("COMPLETED")),
            Some(false) => None,
            None => current.as_ref().and_then(|c| c.status.clone()),
        });
    let Some(anilist_id) = update
        .anilist_id
        .or_else(|| current.as_ref().map(|c| c.anilist_id))
        .filter(|id| *id != 0)
    else {
        return;
    };
    let next = AnilistEntry {
        anilist_id,
        list_entry_id: update
            .list_entry_id
            .unwrap_or_else(|| current.as_ref().and_then(|c| c.list_entry_id)),
        tmdb_id: pending.tmdb_id,
        media_type: pending.media_type,
        status: if watched {
            status.or_else(|| Some(String::from("COMPLETED")))
        } else {
            status
        },
        rating: update
            .rating
            .unwrap_or_else(|| current.as_ref().and_then(|c| c.rating)),
        progress: update
            .progress
            .unwrap_or_else(|| current.as_ref().and_then(|c| c.progress)),
        episode_count: update
            .episode_count
            .unwrap_or_else(|| current.as_ref().and_then(|c| c.episode_count)),
    };
    if update.watched == Some(false) && update.list_entry_id == Some(None) {
        if let Some(i) = index {
            entries.remove(i);
        }
        return;
    }
    match index.and_then(|i| entries.get_mut(i)) {
        Some(slot) => *slot = next,
        None => entries.push(next),
    }
}

/// `patchIsReflected(entries, patch)`.
fn anilist_reflected(entries: &[AnilistEntry], pending: &AnilistPending) -> bool {
    let entry = entries.iter().find(|e| pending.targets(e));
    let update = &pending.update;
    if let Some(watched) = update.watched {
        if is_anilist_watched_status(entry.and_then(|e| e.status.as_deref())) != watched {
            return false;
        }
    }
    let differs =
        |wanted: Option<Option<f64>>, have: Option<f64>| wanted.is_some_and(|w| w != have);
    if differs(update.rating, entry.and_then(|e| e.rating))
        || differs(update.progress, entry.and_then(|e| e.progress))
        || differs(update.episode_count, entry.and_then(|e| e.episode_count))
    {
        return false;
    }
    if update
        .list_entry_id
        .is_some_and(|w| w != entry.and_then(|e| e.list_entry_id))
    {
        return false;
    }
    if let Some(wanted) = &update.status {
        if wanted.as_deref() != entry.and_then(|e| e.status.as_deref()) {
            return false;
        }
    }
    true
}

/// `applyPendingPatches(snapshot, userId)`: a copy with the unreflected
/// patches laid over it.
fn apply_anilist_pending(user: i64, snapshot: &AnilistSnapshot) -> AnilistSnapshot {
    let mut all = lock(&ANILIST_PENDING);
    let Some(patches) = all.get(&user).filter(|p| !p.is_empty()).cloned() else {
        return snapshot.clone();
    };
    let mut entries = snapshot.entries.clone();
    let mut remaining = Vec::new();
    for patch in patches {
        if !anilist_reflected(&entries, &patch) {
            apply_anilist_patch(&mut entries, &patch);
            remaining.push(patch);
        }
    }
    if remaining.is_empty() {
        all.remove(&user);
    } else {
        all.insert(user, remaining);
    }
    drop(all);
    AnilistSnapshot {
        entries,
        fetched_at: snapshot.fetched_at,
    }
}

/// `coalescePending`.
fn coalesce_anilist(patches: Vec<AnilistPending>) -> Vec<AnilistPending> {
    let mut out: Vec<AnilistPending> = Vec::new();
    for patch in patches {
        match out
            .iter_mut()
            .find(|p| p.media_type == patch.media_type && p.tmdb_id == patch.tmdb_id)
        {
            Some(previous) => {
                previous.update = patch.update.over(previous.update.clone());
            }
            None => out.push(patch),
        }
    }
    out
}

/// `patchUserAnilistSyncItem(userId, mediaType, tmdbId, update)`.
pub fn patch_anilist(user: i64, media_type: MediaType, tmdb_id: i64, update: AnilistPatch) {
    {
        let mut all = lock(&ANILIST_PENDING);
        let mut patches = all.remove(&user).unwrap_or_default();
        patches.push(AnilistPending {
            media_type,
            tmdb_id,
            update,
        });
        all.insert(user, coalesce_anilist(patches));
    }
    let current = anilist_snapshot(user);
    if let Some(current) = current {
        let patched = Arc::new(apply_anilist_pending(user, &current));
        lock(&ANILIST).snapshots.insert(user, patched);
    }
}

/// The 1–10 score of a list entry (`scoreRaw`, else `score`).
fn entry_rating(entry: &Value) -> Option<f64> {
    let number = |key: &str| {
        entry
            .get(key)
            .filter(|v| !v.is_null())
            .map(|v| crate::jsval::number_of(Some(v)))
    };
    crate::mediaactions::score::score_raw_to_provider(number("scoreRaw")).or_else(|| {
        number("score")
            .filter(|s| *s > 0.0)
            .map(|s| crate::mediaactions::score::js_round(s).clamp(1.0, 10.0))
    })
}

/// `fetchSnapshot(client, anilistUserId)`: every list entry with a TMDB
/// id the mapping layer knows offline.
async fn fetch_anilist(
    ctx: &Ctx<'_>,
    client: &Anilist,
    anilist_user: &Value,
) -> Result<AnilistSnapshot, String> {
    super::ensure(ctx.db).await.map_err(|e| format!("{e:#}"))?;
    let lists = client
        .media_list_collection(anilist_user)
        .await
        .map_err(|e| e.message())?;
    let mut seen = HashSet::new();
    let mut entries = Vec::new();
    for list in &lists {
        let Some(list_entries) = list.get("entries").and_then(Value::as_array) else {
            continue;
        };
        for entry in list_entries {
            let media = entry.get("media").filter(|m| !m.is_null());
            let Some(anilist_id) = media
                .and_then(|m| m.get("id"))
                .filter(|id| crate::settings::public::truthy(Some(id)))
                .and_then(Value::as_i64)
            else {
                continue;
            };
            let mapped = discover::tmdb_for_anilist(ctx, anilist_id, None, None, media, true)
                .await
                .map_err(|e| format!("{e:#}"))?;
            let Some((tmdb_id, media_type)) = mapped else {
                continue;
            };
            if !seen.insert(anilist_id) {
                continue;
            }
            let status = entry
                .get("status")
                .filter(|s| !s.is_null())
                .or_else(|| list.get("status").filter(|s| !s.is_null()))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let optional = |v: Option<&Value>| {
                v.filter(|v| !v.is_null())
                    .map(|v| crate::jsval::number_of(Some(v)))
            };
            entries.push(AnilistEntry {
                anilist_id,
                list_entry_id: entry.get("id").and_then(Value::as_i64),
                tmdb_id,
                media_type,
                status,
                rating: entry_rating(entry),
                progress: Some(optional(entry.get("progress")).unwrap_or(0.0)),
                episode_count: optional(media.and_then(|m| m.get("episodes"))),
            });
        }
    }
    Ok(AnilistSnapshot {
        entries,
        fetched_at: now_seconds(),
    })
}

/// `warmUserAnilistSyncCache(client, userId, anilistUserId)`.
///
/// # Errors
///
/// `AniList` and database failures, as their message.
pub async fn warm_anilist(
    ctx: &Ctx<'_>,
    client: &Anilist,
    user: i64,
    anilist_user: &Value,
) -> Result<Arc<AnilistSnapshot>, String> {
    let cached = anilist_snapshot(user).filter(|s| !expired(s.fetched_at));
    if let Some(cached) = cached {
        let patched = Arc::new(apply_anilist_pending(user, &cached));
        lock(&ANILIST).snapshots.insert(user, Arc::clone(&patched));
        return Ok(patched);
    }
    loop {
        let (flight, lead) = lock(&ANILIST).flight(user);
        if let Some(lead) = lead {
            // Node's shared promise runs to the end whoever awaits it, so
            // the fetch is a task of its own that a dropped request can't
            // cancel.
            let generation = lock(&ANILIST).generation(user);
            let (db, tmdb, http) = (ctx.db.clone(), ctx.tmdb.clone(), ctx.http.clone());
            let locale = ctx.locale.clone();
            let (client, account) = (client.clone(), anilist_user.clone());
            let settled = flight.clone();
            tokio::spawn(async move {
                let ctx = Ctx {
                    db: &db,
                    tmdb: &tmdb,
                    http: &http,
                    locale,
                };
                let result = load_anilist(&ctx, &client, user, &account, generation).await;
                lead.send_replace(Some(result));
                lock(&ANILIST).settle(user, &settled);
            });
        }
        if let Some(result) = landed(flight).await {
            return result.map(|snapshot| Arc::new(apply_anilist_pending(user, &snapshot)));
        }
    }
}

/// The shared fetch of [`warm_anilist`], stored unless the user's cache
/// was invalidated meanwhile.
async fn load_anilist(
    ctx: &Ctx<'_>,
    client: &Anilist,
    user: i64,
    anilist_user: &Value,
    generation: (u64, u64),
) -> Result<Arc<AnilistSnapshot>, String> {
    let snapshot = fetch_anilist(ctx, client, anilist_user).await?;
    if lock(&ANILIST).is_stale(user, generation) {
        return Ok(anilist_snapshot(user).unwrap_or_else(|| {
            Arc::new(AnilistSnapshot {
                entries: Vec::new(),
                fetched_at: now_seconds(),
            })
        }));
    }
    let patched = Arc::new(apply_anilist_pending(user, &snapshot));
    lock(&ANILIST).snapshots.insert(user, Arc::clone(&patched));
    Ok(patched)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalidation_bumps_generations() {
        let mut cache: UserCache<u8, ()> = UserCache::default();
        let before = cache.generation(1);
        cache.snapshots.insert(1, 9);
        let (_, leader) = cache.flight(1);
        assert!(leader.is_some(), "first caller leads");
        let (_, follower) = cache.flight(1);
        assert!(follower.is_none(), "second caller joins");
        cache.invalidate_user(1);
        assert!(cache.is_stale(1, before), "user generation moved");
        assert!(
            cache.snapshots.is_empty() && cache.inflight.is_empty(),
            "dropped"
        );
        let before = cache.generation(2);
        cache.clear();
        assert!(cache.is_stale(2, before), "global generation moved");
        assert!(is_anilist_watched_status(Some("REPEATING")), "repeating");
        assert!(!is_anilist_watched_status(Some("CURRENT")), "watching");
        assert!(!is_anilist_watched_status(None), "none");
    }

    fn movie(tmdb: i64) -> Value {
        serde_json::json!({"movie": {"ids": {"tmdb": tmdb}}})
    }

    fn rated(tmdb: i64, rating: i64) -> Value {
        serde_json::json!({"movie": {"ids": {"tmdb": tmdb}}, "rating": rating})
    }

    fn status(user: i64, media_type: MediaType, tmdb: i64) -> (bool, Option<f64>) {
        trakt_snapshot(user).map_or((false, None), |s| lookup_trakt(&s, media_type, tmdb))
    }

    // `syncCache.test.ts`; each case uses its own user ids, as the caches
    // are process-wide.
    #[test]
    fn looks_up_watched_and_rating() {
        let snapshot = TraktSnapshot {
            watched_movies: vec![movie(550)],
            ratings_movies: vec![rated(550, 9)],
            ..TraktSnapshot::default()
        };
        assert_eq!(
            lookup_trakt(&snapshot, MediaType::Movie, 550),
            (true, Some(9.0)),
            "known"
        );
        assert_eq!(
            lookup_trakt(&snapshot, MediaType::Movie, 999),
            (false, None),
            "unknown"
        );
    }

    #[test]
    fn patches_keep_other_items() {
        seed_trakt(
            9001,
            TraktSnapshot {
                watched_movies: vec![movie(111)],
                ratings_movies: vec![rated(111, 6)],
                fetched_at: 1_700_000_000.0,
                ..TraktSnapshot::default()
            },
        );
        let both = TraktPatch {
            watched: Some(true),
            rating: Some(Some(8.0)),
        };
        patch_trakt(9001, MediaType::Movie, 550, both);
        assert_eq!(
            trakt_snapshot(9001).map(|s| s.fetched_at.to_bits()),
            Some(1_700_000_000.0_f64.to_bits()),
            "fetchedAt kept"
        );
        assert_eq!(
            status(9001, MediaType::Movie, 550),
            (true, Some(8.0)),
            "patched"
        );
        assert_eq!(
            status(9001, MediaType::Movie, 111),
            (true, Some(6.0)),
            "untouched"
        );

        seed_trakt(
            9002,
            TraktSnapshot {
                watched_movies: vec![movie(550), movie(111)],
                ratings_movies: vec![rated(550, 9), rated(111, 7)],
                fetched_at: 42.0,
                ..TraktSnapshot::default()
            },
        );
        let clear = TraktPatch {
            watched: Some(false),
            rating: Some(None),
        };
        patch_trakt(9002, MediaType::Movie, 550, clear);
        assert_eq!(
            status(9002, MediaType::Movie, 550),
            (false, None),
            "unwatched, unrated"
        );
        assert_eq!(
            status(9002, MediaType::Movie, 111),
            (true, Some(7.0)),
            "other kept"
        );

        seed_trakt(9003, TraktSnapshot::default());
        patch_trakt(9003, MediaType::Tv, 1399, both);
        assert_eq!(
            status(9003, MediaType::Tv, 1399),
            (true, Some(8.0)),
            "show key"
        );

        let watched = TraktPatch {
            watched: Some(true),
            rating: None,
        };
        patch_trakt(9004, MediaType::Movie, 550, watched);
        assert_eq!(
            status(9004, MediaType::Movie, 550),
            (true, None),
            "seeded snapshot"
        );

        seed_trakt(
            9005,
            TraktSnapshot {
                watched_movies: vec![movie(550)],
                ratings_movies: vec![rated(550, 4)],
                fetched_at: 1.0,
                ..TraktSnapshot::default()
            },
        );
        let rating = TraktPatch {
            watched: None,
            rating: Some(Some(10.0)),
        };
        patch_trakt(9005, MediaType::Movie, 550, rating);
        assert_eq!(
            status(9005, MediaType::Movie, 550),
            (true, Some(10.0)),
            "rating only"
        );
    }

    #[test]
    fn pending_patches_survive_a_stale_fetch() {
        let watched = TraktPatch {
            watched: Some(true),
            rating: None,
        };
        patch_trakt(9042, MediaType::Movie, 550, watched);
        assert_eq!(
            status(9042, MediaType::Movie, 550),
            (true, None),
            "local mark"
        );
        // A fetch that has not caught up (as `warmUserSyncCache` lays the
        // pending patches over it).
        let mut fetched = TraktSnapshot {
            watched_movies: vec![movie(111)],
            ..TraktSnapshot::default()
        };
        apply_trakt_pending(9042, &mut fetched);
        assert_eq!(
            lookup_trakt(&fetched, MediaType::Movie, 550),
            (true, None),
            "kept"
        );
        assert_eq!(
            lookup_trakt(&fetched, MediaType::Movie, 111),
            (true, None),
            "fetched"
        );
        assert_eq!(trakt_pending_count(9042), 1, "still pending");
        // Once Trakt reflects it, the patch goes.
        let mut caught_up = TraktSnapshot {
            watched_movies: vec![movie(550)],
            ..TraktSnapshot::default()
        };
        apply_trakt_pending(9042, &mut caught_up);
        assert_eq!(trakt_pending_count(9042), 0, "reflected");
    }

    #[test]
    fn invalidation_drops_snapshot_and_patches() {
        let watched = TraktPatch {
            watched: Some(true),
            rating: None,
        };
        let generation = lock(&TRAKT).generation(9088);
        patch_trakt(9088, MediaType::Movie, 550, watched);
        assert_eq!(trakt_pending_count(9088), 1, "pending");
        invalidate_user_sync_cache(9088);
        assert!(trakt_snapshot(9088).is_none(), "snapshot gone");
        assert_eq!(trakt_pending_count(9088), 0, "patches gone");
        // A fetch that started before the invalidation is stale and is
        // not stored.
        assert!(lock(&TRAKT).is_stale(9088, generation), "stale warm");
    }

    fn entry(anilist_id: i64, status: &str, rating: Option<f64>) -> AnilistEntry {
        AnilistEntry {
            anilist_id,
            list_entry_id: Some(99),
            tmdb_id: 128,
            media_type: MediaType::Movie,
            status: Some(status.to_owned()),
            rating,
            progress: None,
            episode_count: None,
        }
    }

    // `anilist.test.ts`'s cache side.
    #[test]
    fn anilist_patches() {
        seed_anilist(
            9107,
            AnilistSnapshot {
                entries: vec![entry(164, "COMPLETED", Some(8.0))],
                fetched_at: now_seconds(),
            },
        );
        patch_anilist(
            9107,
            MediaType::Movie,
            128,
            AnilistPatch {
                watched: Some(false),
                status: Some(Some(String::from("PLANNING"))),
                rating: Some(Some(8.0)),
                anilist_id: Some(164),
                list_entry_id: Some(Some(99)),
                ..AnilistPatch::default()
            },
        );
        let snapshot = anilist_snapshot(9107).unwrap_or_default();
        let found = lookup_anilist(&snapshot, MediaType::Movie, 128);
        assert_eq!(
            found.and_then(|e| e.status.as_deref()),
            Some("PLANNING"),
            "planning"
        );
        assert_eq!(found.and_then(|e| e.rating), Some(8.0), "score kept");

        // A default unwatch of an absent item adds no entry.
        seed_anilist(9108, AnilistSnapshot::default());
        patch_anilist(
            9108,
            MediaType::Movie,
            128,
            AnilistPatch {
                watched: Some(false),
                status: Some(Some(String::from("PLANNING"))),
                rating: Some(None),
                anilist_id: Some(164),
                list_entry_id: Some(None),
                ..AnilistPatch::default()
            },
        );
        assert!(
            anilist_snapshot(9108).is_some_and(|s| s.entries.is_empty()),
            "no synthetic entry"
        );

        // Removing with the rating drops the entry.
        seed_anilist(
            9109,
            AnilistSnapshot {
                entries: vec![entry(164, "COMPLETED", Some(8.0))],
                fetched_at: now_seconds(),
            },
        );
        patch_anilist(
            9109,
            MediaType::Movie,
            128,
            AnilistPatch {
                watched: Some(false),
                status: Some(None),
                rating: Some(None),
                anilist_id: Some(164),
                list_entry_id: Some(None),
                ..AnilistPatch::default()
            },
        );
        assert!(
            anilist_snapshot(9109).is_some_and(|s| s.entries.is_empty()),
            "entry removed"
        );
        invalidate_user_anilist_sync_cache(9109);
        assert!(anilist_snapshot(9109).is_none(), "invalidated");
    }
}
