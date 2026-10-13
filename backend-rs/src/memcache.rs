//! `server/lib/cache.ts` and `server/lib/cacheStore.ts`: the named
//! response caches the API clients share, and the library artwork of
//! `server/lib/libraryImageCache.ts`.
//!
//! They count the way Node's `WeightedLruCacheStore` counts (hits, misses,
//! keys, key and value bytes), under one memory budget with
//! least-recently-used eviction across every cache; the artwork store
//! answers to that budget too, as Node's does, besides its own limits.
//!
//! Stored values are immutable and shared: a hit hands out another
//! reference, and a caller that changes an answer copies it first. Sizes
//! are measured before the lock is taken, and what an eviction frees is
//! dropped after it is released.
//!
//! A JSON value's size is its UTF-8 length as a string, otherwise its
//! `JSON.stringify` length (Node caps that at 1 MiB; this counts it in
//! full). The budget covers these stores alone: the provider-row and
//! per-user snapshot caches keep their data outside it, and a parsed value
//! takes more memory than its JSON text, so the statistics measure the
//! budget, not the process.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

use crate::libraryimagecache::Artwork;
use crate::sync::lock;

/// `CacheBudget`'s default limit.
const LIMIT_BYTES: u64 = 256 * 1024 * 1024;
/// `estimateSize`'s answer for a value that doesn't serialise.
const UNSIZED: u64 = 1024;
/// `ensureCapacity`'s iteration bound.
const CAPACITY_ROUNDS: u32 = 10_000;
/// The library artwork store, after the API caches.
const ARTWORK: usize = CacheId::ALL.len();

/// Node's `AvailableCacheIds`, in `CacheManager`'s order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CacheId {
    /// `tmdb`.
    Tmdb,
    /// `tmdbscan`.
    TmdbScan,
    /// `radarr`.
    Radarr,
    /// `sonarr`.
    Sonarr,
    /// `rt`.
    Rt,
    /// `imdb`.
    Imdb,
    /// `mdblist`.
    Mdblist,
    /// `github`.
    Github,
    /// `plextv`.
    PlexTv,
    /// `plexwatchlist`.
    PlexWatchlist,
    /// `tvdb`.
    Tvdb,
    /// `trakt`.
    Trakt,
    /// `anilist`.
    Anilist,
}

impl CacheId {
    /// Every cache, in the order `getAllCaches()` lists them.
    pub const ALL: [Self; 13] = [
        Self::Tmdb,
        Self::TmdbScan,
        Self::Radarr,
        Self::Sonarr,
        Self::Rt,
        Self::Imdb,
        Self::Mdblist,
        Self::Github,
        Self::PlexTv,
        Self::PlexWatchlist,
        Self::Tvdb,
        Self::Trakt,
        Self::Anilist,
    ];

    /// The cache id.
    #[must_use]
    pub const fn id(self) -> &'static str {
        match self {
            Self::Tmdb => "tmdb",
            Self::TmdbScan => "tmdbscan",
            Self::Radarr => "radarr",
            Self::Sonarr => "sonarr",
            Self::Rt => "rt",
            Self::Imdb => "imdb",
            Self::Mdblist => "mdblist",
            Self::Github => "github",
            Self::PlexTv => "plextv",
            Self::PlexWatchlist => "plexwatchlist",
            Self::Tvdb => "tvdb",
            Self::Trakt => "trakt",
            Self::Anilist => "anilist",
        }
    }

    /// The display name.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Tmdb => "The Movie Database API",
            Self::TmdbScan => "The Movie Database API (Library Scans)",
            Self::Radarr => "Radarr API",
            Self::Sonarr => "Sonarr API",
            Self::Rt => "Rotten Tomatoes API",
            Self::Imdb => "IMDB Radarr Proxy",
            Self::Mdblist => "MDBList API",
            Self::Github => "GitHub API",
            Self::PlexTv => "Plex TV",
            Self::PlexWatchlist => "Plex Watchlist",
            Self::Tvdb => "The TVDB API",
            Self::Trakt => "Trakt API",
            Self::Anilist => "AniList API",
        }
    }

    /// `stdTtl`, the TTL of a `set` that names none.
    #[must_use]
    pub const fn default_ttl(self) -> Duration {
        Duration::from_secs(match self {
            Self::Tmdb | Self::Github | Self::Tvdb => 21_600,
            Self::TmdbScan => 900,
            Self::Rt | Self::Imdb => 43_200,
            Self::Mdblist => 172_800,
            Self::PlexTv => 604_800,
            Self::Radarr | Self::Sonarr | Self::PlexWatchlist | Self::Trakt | Self::Anilist => 300,
        })
    }

    const fn max_entries(self) -> Option<usize> {
        match self {
            Self::TmdbScan => Some(2000),
            Self::Tmdb
            | Self::Radarr
            | Self::Sonarr
            | Self::Rt
            | Self::Imdb
            | Self::Mdblist
            | Self::Github
            | Self::PlexTv
            | Self::PlexWatchlist
            | Self::Tvdb
            | Self::Trakt
            | Self::Anilist => None,
        }
    }

    /// The cache with this id (`hasOwnProperty` on `getAllCaches()`).
    #[must_use]
    pub fn parse(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|c| c.id() == id)
    }

    fn index(self) -> usize {
        Self::ALL.iter().position(|c| *c == self).unwrap_or(0)
    }
}

/// A store's own caps (`maxEntries`, `maxBytes`), under the shared budget.
#[derive(Debug, Clone, Copy, Default)]
pub struct Limits {
    /// `maxEntries`.
    pub max_entries: Option<usize>,
    /// `maxBytes`.
    pub max_bytes: Option<u64>,
}

/// What a store keeps.
#[derive(Debug, Clone)]
enum Payload {
    /// A provider's answer.
    Json(Arc<Value>),
    /// Library artwork.
    Artwork(Arc<Artwork>),
}

#[derive(Debug)]
struct Entry {
    payload: Payload,
    size: u64,
    expires_at: Instant,
    /// The access stamp it was stored under: unique, so it orders entries
    /// expiring at the same instant.
    stored_at: u64,
    accessed_at: u64,
}

#[derive(Debug, Default)]
struct Store {
    entries: HashMap<Arc<str>, Entry>,
    /// Keys by last access, least recent first.
    recency: BTreeMap<u64, Arc<str>>,
    /// Keys by expiry, soonest first.
    expiry: BTreeMap<(Instant, u64), Arc<str>>,
    bytes: u64,
    hits: u64,
    misses: u64,
    limits: Limits,
}

/// Every store under the shared budget (`CacheBudget`).
#[derive(Debug)]
struct Registry {
    stores: Vec<Store>,
    used_bytes: u64,
    evictions: u64,
    access: u64,
    limit_bytes: u64,
    /// What evictions took out under the lock, to drop once it's released.
    dropped: Vec<Payload>,
}

static REGISTRY: LazyLock<Mutex<Registry>> =
    LazyLock::new(|| Mutex::new(Registry::new(LIMIT_BYTES)));

impl Registry {
    fn new(limit_bytes: u64) -> Self {
        let api = CacheId::ALL.iter().map(|id| Limits {
            max_entries: id.max_entries(),
            max_bytes: None,
        });
        Self {
            stores: api
                .chain([crate::libraryimagecache::LIMITS])
                .map(|limits| Store {
                    limits,
                    ..Store::default()
                })
                .collect(),
            used_bytes: 0,
            evictions: 0,
            access: 0,
            limit_bytes,
            dropped: Vec::new(),
        }
    }

    const fn next_access(&mut self) -> u64 {
        self.access += 1;
        self.access
    }

    fn evict(&mut self, store: usize, key: &str, count: bool) {
        let Some(s) = self.stores.get_mut(store) else {
            return;
        };
        let Some(entry) = s.entries.remove(key) else {
            return;
        };
        s.recency.remove(&entry.accessed_at);
        s.expiry.remove(&(entry.expires_at, entry.stored_at));
        s.bytes = s.bytes.saturating_sub(entry.size);
        self.used_bytes = self.used_bytes.saturating_sub(entry.size);
        if count {
            self.evictions += 1;
        }
        self.dropped.push(entry.payload);
    }

    fn remove_expired(&mut self, store: usize, now: Instant) {
        while let Some(s) = self.stores.get_mut(store) {
            let Some(soonest) = s.expiry.first_entry() else {
                return;
            };
            if soonest.key().0 > now {
                return;
            }
            let key = soonest.remove();
            self.evict(store, &key, false);
        }
    }

    fn count(&mut self, store: usize, now: Instant) -> usize {
        self.remove_expired(store, now);
        self.stores.get(store).map_or(0, |s| s.entries.len())
    }

    /// `oldest()[0]` of one store, after dropping expired entries.
    fn oldest(&mut self, store: usize, now: Instant) -> Option<(u64, Arc<str>)> {
        self.remove_expired(store, now);
        self.stores
            .get(store)
            .and_then(|s| s.recency.first_key_value())
            .map(|(accessed, key)| (*accessed, Arc::clone(key)))
    }

    fn get(&mut self, store: usize, key: &str, now: Instant) -> Option<Payload> {
        let expired = match self.stores.get(store).and_then(|s| s.entries.get(key)) {
            None => {
                self.bump(store, false);
                return None;
            }
            Some(entry) => entry.expires_at <= now,
        };
        if expired {
            self.evict(store, key, false);
            self.bump(store, false);
            return None;
        }
        let access = self.next_access();
        self.bump(store, true);
        let s = self.stores.get_mut(store)?;
        let entry = s.entries.get_mut(key)?;
        let previous = std::mem::replace(&mut entry.accessed_at, access);
        let payload = entry.payload.clone();
        if let Some(key) = s.recency.remove(&previous) {
            s.recency.insert(access, key);
        }
        Some(payload)
    }

    fn bump(&mut self, store: usize, hit: bool) {
        if let Some(s) = self.stores.get_mut(store) {
            if hit {
                s.hits += 1;
            } else {
                s.misses += 1;
            }
        }
    }

    fn set(&mut self, store: usize, key: String, payload: Payload, size: u64, ttl: Duration) {
        let now = Instant::now();
        self.evict(store, &key, false);
        let stamp = self.next_access();
        let Some(s) = self.stores.get_mut(store) else {
            self.dropped.push(payload);
            return;
        };
        let key: Arc<str> = Arc::from(key);
        let expires_at = now + ttl;
        s.recency.insert(stamp, Arc::clone(&key));
        s.expiry.insert((expires_at, stamp), Arc::clone(&key));
        s.entries.insert(
            key,
            Entry {
                payload,
                size,
                expires_at,
                stored_at: stamp,
                accessed_at: stamp,
            },
        );
        s.bytes += size;
        self.used_bytes += size;
        self.remove_expired(store, now);
        self.trim_to_local_limits(store, now);
        self.ensure_capacity(now);
    }

    /// `trimToLocalLimits`.
    fn trim_to_local_limits(&mut self, store: usize, now: Instant) {
        while self.stores.get(store).is_some_and(|s| {
            s.limits
                .max_entries
                .is_some_and(|max| s.entries.len() > max)
                || s.limits.max_bytes.is_some_and(|max| s.bytes > max)
        }) {
            let Some((_, oldest)) = self.oldest(store, now) else {
                break;
            };
            self.evict(store, &oldest, true);
        }
    }

    fn ensure_capacity(&mut self, now: Instant) {
        let mut remaining = CAPACITY_ROUNDS;
        while self.used_bytes > self.limit_bytes && remaining > 0 {
            remaining -= 1;
            let before = self.used_bytes;
            for store in 0..self.stores.len() {
                self.remove_expired(store, now);
            }
            if self.used_bytes <= self.limit_bytes {
                return;
            }
            let candidate = (0..self.stores.len())
                .filter_map(|store| {
                    self.oldest(store, now)
                        .map(|(accessed, key)| (accessed, store, key))
                })
                .min_by_key(|(accessed, _, _)| *accessed);
            let Some((_, store, key)) = candidate else {
                return;
            };
            self.evict(store, &key, true);
            if self.used_bytes >= before {
                return;
            }
        }
    }

    fn flush(&mut self, store: usize) {
        let keys: Vec<Arc<str>> = self
            .stores
            .get(store)
            .map_or_else(Vec::new, |s| s.entries.keys().cloned().collect());
        for key in keys {
            self.evict(store, &key, false);
        }
    }

    fn budget(&mut self, now: Instant) -> [(&'static str, u64); 4] {
        let entries = (0..self.stores.len())
            .map(|s| self.count(s, now))
            .sum::<usize>();
        [
            ("usedBytes", self.used_bytes),
            ("limitBytes", self.limit_bytes),
            ("entries", u64::try_from(entries).unwrap_or(u64::MAX)),
            ("evictions", self.evictions),
        ]
    }

    fn stats(&mut self, store: usize, now: Instant) -> Map<String, Value> {
        let budget = self.budget(now);
        let keys = self.count(store, now);
        let mut out = Map::new();
        if let Some(s) = self.stores.get(store) {
            let ksize: usize = s.entries.keys().map(|k| k.len()).sum();
            out.insert(String::from("hits"), Value::from(s.hits));
            out.insert(String::from("misses"), Value::from(s.misses));
            out.insert(String::from("keys"), Value::from(keys));
            out.insert(String::from("ksize"), Value::from(ksize));
            out.insert(String::from("vsize"), Value::from(s.bytes));
        }
        for (k, v) in budget {
            out.insert(k.to_owned(), Value::from(v));
        }
        out
    }
}

/// Run `f` on the registry, then drop what it evicted once the lock is
/// released: freeing a large answer shouldn't hold up every other cache.
fn with_registry<T>(f: impl FnOnce(&mut Registry) -> T) -> T {
    let mut registry = lock(&REGISTRY);
    let out = f(&mut registry);
    let dropped = std::mem::take(&mut registry.dropped);
    drop(registry);
    drop(dropped);
    out
}

/// Counts what is written to it.
#[derive(Debug, Default)]
struct ByteCount(u64);

impl std::io::Write for ByteCount {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0 = self
            .0
            .saturating_add(u64::try_from(buf.len()).unwrap_or(u64::MAX));
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// `estimateSize`, without its 1 MiB cap: the serialised length is
/// counted, not built.
fn estimate_size(value: &Value) -> u64 {
    match value {
        Value::String(s) => u64::try_from(s.len()).unwrap_or(u64::MAX),
        other @ (Value::Null
        | Value::Bool(_)
        | Value::Number(_)
        | Value::Array(_)
        | Value::Object(_)) => {
            let mut count = ByteCount::default();
            serde_json::to_writer(&mut count, other).map_or(UNSIZED, |()| count.0)
        }
    }
}

/// `cache.get(key)`: a fresh value (counting a hit) or none (a miss). The
/// value is the stored one, shared; copy it to change it.
#[must_use]
pub fn get(id: CacheId, key: &str) -> Option<Arc<Value>> {
    match with_registry(|r| r.get(id.index(), key, Instant::now()))? {
        Payload::Json(value) => Some(value),
        Payload::Artwork(_) => None,
    }
}

/// `cache.set(key, value, ttl)`.
pub fn set(id: CacheId, key: String, value: impl Into<Arc<Value>>, ttl: Duration) {
    let value = value.into();
    let size = estimate_size(&value);
    with_registry(|r| r.set(id.index(), key, Payload::Json(value), size, ttl));
}

/// `cache.set(key, value)` with the cache's `stdTtl`.
pub fn set_default(id: CacheId, key: String, value: impl Into<Arc<Value>>) {
    set(id, key, value, id.default_ttl());
}

/// `cache.getTtl(key)`: when the entry expires, if it is stored.
#[must_use]
pub fn expires_at(id: CacheId, key: &str) -> Option<Instant> {
    lock(&REGISTRY)
        .stores
        .get(id.index())
        .and_then(|s| s.entries.get(key))
        .map(|e| e.expires_at)
}

/// `cache.delete(key)`.
pub fn delete(id: CacheId, key: &str) {
    with_registry(|r| r.evict(id.index(), key, false));
}

/// `cache.keys()`: the live keys.
#[must_use]
pub fn keys(id: CacheId) -> Vec<String> {
    with_registry(|r| {
        r.remove_expired(id.index(), Instant::now());
        r.stores.get(id.index()).map_or_else(Vec::new, |s| {
            s.entries.keys().map(|k| String::from(&**k)).collect()
        })
    })
}

/// `cache.flush()`: every entry dropped; the hit and miss counts stay.
pub fn flush(id: CacheId) {
    with_registry(|r| r.flush(id.index()));
}

/// `cache.getStats()`.
#[must_use]
pub fn stats(id: CacheId) -> Value {
    Value::Object(with_registry(|r| r.stats(id.index(), Instant::now())))
}

/// `getMemoryCacheStats()`: the shared budget (the API caches and library
/// artwork), not the process's memory; see the module notes.
#[must_use]
pub fn memory_stats() -> Value {
    let budget = with_registry(|r| r.budget(Instant::now()));
    Value::Object(
        budget
            .into_iter()
            .map(|(k, v)| (k.to_owned(), Value::from(v)))
            .collect(),
    )
}

/// `apiCaches` in `GET /settings/cache`: `{ id, name, stats }` per cache.
#[must_use]
pub fn api_caches() -> Value {
    Value::Array(
        CacheId::ALL
            .into_iter()
            .map(|id| {
                let mut out = Map::new();
                out.insert(String::from("id"), Value::from(id.id()));
                out.insert(String::from("name"), Value::from(id.name()));
                out.insert(String::from("stats"), stats(id));
                Value::Object(out)
            })
            .collect(),
    )
}

/// Library artwork, while fresh.
#[must_use]
pub fn artwork(key: &str) -> Option<Arc<Artwork>> {
    match with_registry(|r| r.get(ARTWORK, key, Instant::now()))? {
        Payload::Artwork(artwork) => Some(artwork),
        Payload::Json(_) => None,
    }
}

/// Store library artwork: its bytes and content type count against the
/// shared budget.
pub fn set_artwork(key: String, artwork: Artwork, ttl: Duration) {
    let size = artwork.size();
    let artwork = Payload::Artwork(Arc::new(artwork));
    with_registry(|r| r.set(ARTWORK, key, artwork, size, ttl));
}

/// Drop all library artwork.
pub fn flush_artwork() {
    with_registry(|r| r.flush(ARTWORK));
}

/// How many library images are fresh.
#[must_use]
pub fn artwork_count() -> usize {
    with_registry(|r| r.count(ARTWORK, Instant::now()))
}

#[cfg(test)]
mod tests {
    //! `server/lib/cacheStore.test.ts`.
    use super::*;
    use serde_json::json;

    fn registry(limit: u64) -> Registry {
        Registry::new(limit)
    }

    fn put(r: &mut Registry, id: CacheId, key: &str, value: &Value, ttl: Duration) {
        let size = estimate_size(value);
        let payload = Payload::Json(Arc::new(value.clone()));
        r.set(id.index(), key.to_owned(), payload, size, ttl);
    }

    /// A lookup's JSON value.
    fn look(r: &mut Registry, id: CacheId, key: &str, now: Instant) -> Option<Value> {
        match r.get(id.index(), key, now)? {
            Payload::Json(value) => Some(Value::clone(&value)),
            Payload::Artwork(_) => None,
        }
    }

    const MIN: Duration = Duration::from_secs(60);

    #[test]
    fn counts_hits_misses_and_sizes_like_node() {
        let mut r = registry(LIMIT_BYTES);
        let tmdb = CacheId::Tmdb.index();
        let now = Instant::now();
        assert_eq!(look(&mut r, CacheId::Tmdb, "a", now), None, "a miss");
        put(&mut r, CacheId::Tmdb, "a", &json!("xyz"), MIN);
        put(&mut r, CacheId::Tmdb, "bb", &json!({"k": 1}), MIN);
        assert_eq!(
            look(&mut r, CacheId::Tmdb, "a", now),
            Some(json!("xyz")),
            "a hit"
        );
        let stats = Value::Object(r.stats(tmdb, now));
        assert_eq!(
            stats,
            json!({"hits": 1, "misses": 1, "keys": 2, "ksize": 3, "vsize": 10,
                   "usedBytes": 10, "limitBytes": LIMIT_BYTES, "entries": 2, "evictions": 0}),
            "stats"
        );
        let keys: Vec<&String> = stats
            .as_object()
            .map(|m| m.keys().collect())
            .unwrap_or_default();
        assert_eq!(
            keys,
            [
                "hits",
                "misses",
                "keys",
                "ksize",
                "vsize",
                "usedBytes",
                "limitBytes",
                "entries",
                "evictions"
            ],
            "key order"
        );
    }

    #[test]
    fn expired_entries_miss_and_free_their_bytes() {
        let mut r = registry(LIMIT_BYTES);
        put(&mut r, CacheId::Rt, "k", &json!("value"), Duration::ZERO);
        assert_eq!(
            look(&mut r, CacheId::Rt, "k", Instant::now()),
            None,
            "expired"
        );
        assert_eq!(r.used_bytes, 0, "bytes released");
        assert_eq!(r.evictions, 0, "expiry isn't an eviction");
    }

    #[test]
    fn evicts_the_least_recently_used_entry_across_caches() {
        let mut r = registry(10);
        put(&mut r, CacheId::Tmdb, "old", &json!("aaaa"), MIN);
        put(&mut r, CacheId::Trakt, "mid", &json!("bbbb"), MIN);
        assert!(
            look(&mut r, CacheId::Tmdb, "old", Instant::now()).is_some(),
            "touch old"
        );
        put(&mut r, CacheId::Anilist, "new", &json!("cccc"), MIN);
        let now = Instant::now();
        assert_eq!(
            look(&mut r, CacheId::Trakt, "mid", now),
            None,
            "LRU evicted"
        );
        assert!(
            look(&mut r, CacheId::Tmdb, "old", now).is_some(),
            "recently used kept"
        );
        assert_eq!(r.evictions, 1, "counted");
        assert_eq!(r.used_bytes, 8, "budget");
    }

    /// `enforces one shared byte budget across provider stores`.
    #[test]
    fn one_budget_across_stores() {
        let mut r = registry(5);
        put(&mut r, CacheId::Tmdb, "first", &json!("four"), MIN);
        put(&mut r, CacheId::Tvdb, "second", &json!("four"), MIN);
        let now = Instant::now();
        assert_eq!(look(&mut r, CacheId::Tmdb, "first", now), None, "evicted");
        assert_eq!(
            look(&mut r, CacheId::Tvdb, "second", now),
            Some(json!("four")),
            "kept"
        );
        assert_eq!((r.used_bytes, r.evictions), (4, 1), "budget stats");
    }

    /// `removes expired values before evicting live values`.
    #[test]
    fn expired_go_before_live_ones() {
        let mut r = registry(5);
        put(
            &mut r,
            CacheId::Tmdb,
            "expired",
            &json!("four"),
            Duration::ZERO,
        );
        put(&mut r, CacheId::Tvdb, "live", &json!("four"), MIN);
        let now = Instant::now();
        assert_eq!(look(&mut r, CacheId::Tmdb, "expired", now), None, "expired");
        assert_eq!(
            look(&mut r, CacheId::Tvdb, "live", now),
            Some(json!("four")),
            "live"
        );
        assert_eq!(r.evictions, 0, "nothing evicted");
    }

    #[test]
    fn local_entry_limit() {
        let mut r = registry(LIMIT_BYTES);
        for i in 0..2001 {
            put(&mut r, CacheId::TmdbScan, &format!("k{i}"), &json!(1), MIN);
        }
        let scan = CacheId::TmdbScan.index();
        assert_eq!(r.count(scan, Instant::now()), 2000, "capped");
        assert_eq!(
            look(&mut r, CacheId::TmdbScan, "k0", Instant::now()),
            None,
            "oldest went"
        );
        assert_eq!(r.evictions, 1, "counted");
    }

    #[test]
    fn hits_share_the_stored_value() {
        let mut r = registry(LIMIT_BYTES);
        let stored = Arc::new(json!({"results": [1, 2, 3]}));
        let size = estimate_size(&stored);
        let payload = Payload::Json(Arc::clone(&stored));
        r.set(CacheId::Tmdb.index(), String::from("k"), payload, size, MIN);
        let now = Instant::now();
        for _ in 0..2 {
            let hit = r.get(CacheId::Tmdb.index(), "k", now);
            assert!(
                matches!(hit, Some(Payload::Json(hit)) if Arc::ptr_eq(&hit, &stored)),
                "the same allocation, not a copy"
            );
        }
        set(
            CacheId::Github,
            String::from("memcache-shared"),
            Arc::clone(&stored),
            MIN,
        );
        let hits = [
            get(CacheId::Github, "memcache-shared"),
            get(CacheId::Github, "memcache-shared"),
        ];
        assert!(
            hits.iter()
                .all(|hit| hit.as_ref().is_some_and(|hit| Arc::ptr_eq(hit, &stored))),
            "the public lookup shares it too"
        );
        delete(CacheId::Github, "memcache-shared");
    }

    #[test]
    fn large_values_count_in_full() {
        let big = json!({"results": vec!["x".repeat(1024); 3 * 1024]});
        let length = u64::try_from(serde_json::to_string(&big).map_or(0, |s| s.len())).unwrap_or(0);
        assert!(length > 3 * 1024 * 1024, "over 1 MiB");
        assert_eq!(estimate_size(&big), length, "its full JSON length");
        let mut r = registry(LIMIT_BYTES);
        put(&mut r, CacheId::Tmdb, "big", &big, MIN);
        put(&mut r, CacheId::Tmdb, "small", &json!("abc"), MIN);
        let stats = r.stats(CacheId::Tmdb.index(), Instant::now());
        assert_eq!(stats.get("vsize"), Some(&json!(length + 3)), "vsize");
        assert_eq!(
            stats.get("usedBytes"),
            Some(&json!(length + 3)),
            "usedBytes"
        );
        let mut tight = registry(2 * 1024 * 1024);
        put(&mut tight, CacheId::Tmdb, "big", &big, MIN);
        assert_eq!(
            (tight.used_bytes, tight.evictions),
            (0, 1),
            "a value over the budget doesn't fit"
        );
    }

    #[test]
    fn artwork_shares_the_budget() {
        let mut r = registry(10);
        let artwork = Artwork {
            bytes: bytes::Bytes::from_static(b"image"),
            content_type: String::from("a/b"),
        };
        let size = artwork.size();
        r.set(
            ARTWORK,
            String::from("1:item:primary"),
            Payload::Artwork(Arc::new(artwork)),
            size,
            MIN,
        );
        put(&mut r, CacheId::Tmdb, "k", &json!("four"), MIN);
        let now = Instant::now();
        assert!(
            r.get(ARTWORK, "1:item:primary", now).is_none(),
            "the older artwork made room"
        );
        assert_eq!(
            look(&mut r, CacheId::Tmdb, "k", now),
            Some(json!("four")),
            "kept"
        );
        assert_eq!(r.budget(now)[3], ("evictions", 1), "counted");
        assert_eq!(r.dropped.len(), 1, "freed once the lock is released");
    }

    #[test]
    fn sizes_and_ids() {
        assert_eq!(estimate_size(&json!("é")), 2, "string bytes");
        assert_eq!(estimate_size(&json!([1, 2])), 5, "JSON length");
        assert_eq!(
            CacheId::parse("plexwatchlist"),
            Some(CacheId::PlexWatchlist),
            "parse"
        );
        assert_eq!(CacheId::parse("dns"), None, "unknown");
        assert_eq!(
            CacheId::Mdblist.default_ttl(),
            Duration::from_secs(172_800),
            "48h"
        );
    }
}
