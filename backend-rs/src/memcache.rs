//! `server/lib/cache.ts` and `server/lib/cacheStore.ts`: the named
//! response caches the API clients share.
//!
//! They count the way Node's `WeightedLruCacheStore` counts (hits, misses,
//! keys, key and value bytes), under one memory budget with
//! least-recently-used eviction across every cache.
//!
//! Values are JSON documents; a value's size is its UTF-8 length as a
//! string, otherwise its `JSON.stringify` length capped at 1 MiB, as
//! `estimateSize` measures it.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

use crate::sync::lock;

/// `CacheBudget`'s default limit.
const LIMIT_BYTES: u64 = 256 * 1024 * 1024;
/// `estimateSize`'s cap for serialised values.
const MAX_ESTIMATE: u64 = 1024 * 1024;
/// `ensureCapacity`'s iteration bound.
const CAPACITY_ROUNDS: u32 = 10_000;

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

#[derive(Debug)]
struct Entry {
    value: Value,
    size: u64,
    expires_at: Instant,
    accessed_at: u64,
}

#[derive(Debug, Default)]
struct Store {
    entries: HashMap<String, Entry>,
    hits: u64,
    misses: u64,
}

/// Every store under the shared budget (`CacheBudget`).
#[derive(Debug)]
struct Registry {
    stores: Vec<Store>,
    used_bytes: u64,
    evictions: u64,
    access: u64,
    limit_bytes: u64,
}

static REGISTRY: LazyLock<Mutex<Registry>> =
    LazyLock::new(|| Mutex::new(Registry::new(LIMIT_BYTES)));

impl Registry {
    fn new(limit_bytes: u64) -> Self {
        Self {
            stores: CacheId::ALL.iter().map(|_| Store::default()).collect(),
            used_bytes: 0,
            evictions: 0,
            access: 0,
            limit_bytes,
        }
    }

    const fn next_access(&mut self) -> u64 {
        self.access += 1;
        self.access
    }

    fn evict(&mut self, store: usize, key: &str, count: bool) {
        let Some(entry) = self
            .stores
            .get_mut(store)
            .and_then(|s| s.entries.remove(key))
        else {
            return;
        };
        self.used_bytes = self.used_bytes.saturating_sub(entry.size);
        if count {
            self.evictions += 1;
        }
    }

    fn remove_expired(&mut self, store: usize, now: Instant) {
        let expired: Vec<String> = self.stores.get(store).map_or_else(Vec::new, |s| {
            s.entries
                .iter()
                .filter(|(_, e)| e.expires_at <= now)
                .map(|(k, _)| k.clone())
                .collect()
        });
        for key in expired {
            self.evict(store, &key, false);
        }
    }

    fn count(&mut self, store: usize, now: Instant) -> usize {
        self.remove_expired(store, now);
        self.stores.get(store).map_or(0, |s| s.entries.len())
    }

    /// `oldest()[0]` of one store, after dropping expired entries.
    fn oldest(&mut self, store: usize, now: Instant) -> Option<(u64, String)> {
        self.remove_expired(store, now);
        self.stores.get(store).and_then(|s| {
            s.entries
                .iter()
                .min_by_key(|(_, e)| e.accessed_at)
                .map(|(k, e)| (e.accessed_at, k.clone()))
        })
    }

    fn get(&mut self, store: usize, key: &str, now: Instant) -> Option<Value> {
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
        let entry = self.stores.get_mut(store)?.entries.get_mut(key)?;
        entry.accessed_at = access;
        Some(entry.value.clone())
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

    fn set(&mut self, id: CacheId, key: String, value: Value, size: u64, ttl: Duration) {
        let store = id.index();
        let now = Instant::now();
        self.evict(store, &key, false);
        let accessed_at = self.next_access();
        if let Some(s) = self.stores.get_mut(store) {
            s.entries.insert(
                key,
                Entry {
                    value,
                    size,
                    expires_at: now + ttl,
                    accessed_at,
                },
            );
        }
        self.used_bytes += size;
        self.remove_expired(store, now);
        if let Some(max) = id.max_entries() {
            while self
                .stores
                .get(store)
                .is_some_and(|s| s.entries.len() > max)
            {
                let Some((_, oldest)) = self.oldest(store, now) else {
                    break;
                };
                self.evict(store, &oldest, true);
            }
        }
        self.ensure_capacity(now);
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
            let ksize: usize = s.entries.keys().map(String::len).sum();
            let vsize: u64 = s.entries.values().map(|e| e.size).sum();
            out.insert(String::from("hits"), Value::from(s.hits));
            out.insert(String::from("misses"), Value::from(s.misses));
            out.insert(String::from("keys"), Value::from(keys));
            out.insert(String::from("ksize"), Value::from(ksize));
            out.insert(String::from("vsize"), Value::from(vsize));
        }
        for (k, v) in budget {
            out.insert(k.to_owned(), Value::from(v));
        }
        out
    }
}

/// `estimateSize`.
fn estimate_size(value: &Value) -> u64 {
    let len = match value {
        Value::String(s) => return u64::try_from(s.len()).unwrap_or(u64::MAX),
        other @ (Value::Null
        | Value::Bool(_)
        | Value::Number(_)
        | Value::Array(_)
        | Value::Object(_)) => serde_json::to_string(other).map_or(1024, |s| s.len()),
    };
    u64::try_from(len).unwrap_or(u64::MAX).min(MAX_ESTIMATE)
}

/// `cache.get(key)`: a fresh value (counting a hit) or none (a miss).
#[must_use]
pub fn get(id: CacheId, key: &str) -> Option<Value> {
    lock(&REGISTRY).get(id.index(), key, Instant::now())
}

/// `cache.set(key, value, ttl)`.
pub fn set(id: CacheId, key: String, value: Value, ttl: Duration) {
    let size = estimate_size(&value);
    lock(&REGISTRY).set(id, key, value, size, ttl);
}

/// `cache.set(key, value)` with the cache's `stdTtl`.
pub fn set_default(id: CacheId, key: String, value: Value) {
    set(id, key, value, id.default_ttl());
}

/// Replace a stored value in place, keeping its expiry, size and recency:
/// what mutating the object Node's cache handed out does.
pub fn replace(id: CacheId, key: &str, value: Value) {
    let mut registry = lock(&REGISTRY);
    if let Some(entry) = registry
        .stores
        .get_mut(id.index())
        .and_then(|s| s.entries.get_mut(key))
    {
        entry.value = value;
    }
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
    lock(&REGISTRY).evict(id.index(), key, false);
}

/// `cache.keys()`: the live keys.
#[must_use]
pub fn keys(id: CacheId) -> Vec<String> {
    let mut registry = lock(&REGISTRY);
    registry.remove_expired(id.index(), Instant::now());
    registry
        .stores
        .get(id.index())
        .map_or_else(Vec::new, |s| s.entries.keys().cloned().collect())
}

/// `cache.flush()`: every entry dropped; the hit and miss counts stay.
pub fn flush(id: CacheId) {
    let mut registry = lock(&REGISTRY);
    let keys: Vec<String> = registry
        .stores
        .get(id.index())
        .map_or_else(Vec::new, |s| s.entries.keys().cloned().collect());
    for key in keys {
        registry.evict(id.index(), &key, false);
    }
}

/// `cache.getStats()`.
#[must_use]
pub fn stats(id: CacheId) -> Value {
    Value::Object(lock(&REGISTRY).stats(id.index(), Instant::now()))
}

/// `getMemoryCacheStats()`.
#[must_use]
pub fn memory_stats() -> Value {
    let budget = lock(&REGISTRY).budget(Instant::now());
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

#[cfg(test)]
mod tests {
    //! `server/lib/cacheStore.test.ts`.
    use super::*;
    use serde_json::json;

    fn registry(limit: u64) -> Registry {
        Registry::new(limit)
    }

    fn put(r: &mut Registry, id: CacheId, key: &str, value: &Value, ttl: Duration) {
        r.set(id, key.to_owned(), value.clone(), estimate_size(value), ttl);
    }

    const MIN: Duration = Duration::from_secs(60);

    #[test]
    fn counts_hits_misses_and_sizes_like_node() {
        let mut r = registry(LIMIT_BYTES);
        let tmdb = CacheId::Tmdb.index();
        let now = Instant::now();
        assert_eq!(r.get(tmdb, "a", now), None, "a miss");
        put(&mut r, CacheId::Tmdb, "a", &json!("xyz"), MIN);
        put(&mut r, CacheId::Tmdb, "bb", &json!({"k": 1}), MIN);
        assert_eq!(r.get(tmdb, "a", now), Some(json!("xyz")), "a hit");
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
        let rt = CacheId::Rt.index();
        put(&mut r, CacheId::Rt, "k", &json!("value"), Duration::ZERO);
        assert_eq!(r.get(rt, "k", Instant::now()), None, "expired");
        assert_eq!(r.used_bytes, 0, "bytes released");
        assert_eq!(r.evictions, 0, "expiry isn't an eviction");
    }

    #[test]
    fn evicts_the_least_recently_used_entry_across_caches() {
        let mut r = registry(10);
        put(&mut r, CacheId::Tmdb, "old", &json!("aaaa"), MIN);
        put(&mut r, CacheId::Trakt, "mid", &json!("bbbb"), MIN);
        assert!(
            r.get(CacheId::Tmdb.index(), "old", Instant::now())
                .is_some(),
            "touch old"
        );
        put(&mut r, CacheId::Anilist, "new", &json!("cccc"), MIN);
        let now = Instant::now();
        assert_eq!(
            r.get(CacheId::Trakt.index(), "mid", now),
            None,
            "LRU evicted"
        );
        assert!(
            r.get(CacheId::Tmdb.index(), "old", now).is_some(),
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
        assert_eq!(r.get(CacheId::Tmdb.index(), "first", now), None, "evicted");
        assert_eq!(
            r.get(CacheId::Tvdb.index(), "second", now),
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
        assert_eq!(
            r.get(CacheId::Tmdb.index(), "expired", now),
            None,
            "expired"
        );
        assert_eq!(
            r.get(CacheId::Tvdb.index(), "live", now),
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
        assert_eq!(r.get(scan, "k0", Instant::now()), None, "oldest went");
        assert_eq!(r.evictions, 1, "counted");
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
