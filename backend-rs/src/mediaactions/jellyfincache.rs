//! `jellyfinStatusCache.ts`: what a user's Jellyfin said an item's
//! played state was, for thirty seconds.
//!
//! Node's map only drops an expired key when that key is read again; this
//! one also sweeps expired keys as it grows and holds at most [`CAPACITY`]
//! entries, so one-off reads across a large library are reclaimed.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::sync::lock;

const TTL: Duration = Duration::from_secs(30);

/// Size at which the first expiry sweep runs.
const SWEEP_FLOOR: usize = 1024;

/// Most entries kept; past it the soonest-to-expire are dropped.
const CAPACITY: usize = 10_000;

static CACHE: LazyLock<Mutex<Store>> = LazyLock::new(|| Mutex::new(Store::new()));

/// The keyed entries plus the size that triggers the next sweep.
struct Store {
    entries: HashMap<String, (bool, Instant)>,
    sweep_at: usize,
}

impl Store {
    fn new() -> Self {
        Self {
            entries: HashMap::new(),
            sweep_at: SWEEP_FLOOR,
        }
    }

    fn get(&mut self, entry_key: &str, now: Instant) -> Option<bool> {
        let (watched, expires) = *self.entries.get(entry_key)?;
        if expires <= now {
            self.entries.remove(entry_key);
            return None;
        }
        Some(watched)
    }

    fn insert(&mut self, entry_key: String, watched: bool, now: Instant) {
        if self.entries.len() >= self.sweep_at && !self.entries.contains_key(&entry_key) {
            self.sweep(now);
        }
        self.entries.insert(entry_key, (watched, now + TTL));
    }

    /// Drops expired entries, then the soonest-to-expire until there is
    /// room for one more. The next sweep waits until the map doubles, so
    /// inserts stay amortized constant time.
    fn sweep(&mut self, now: Instant) {
        self.entries.retain(|_, (_, expires)| *expires > now);
        if self.entries.len() >= CAPACITY {
            let mut by_expiry: Vec<(Instant, String)> = self
                .entries
                .iter()
                .map(|(k, (_, expires))| (*expires, k.clone()))
                .collect();
            by_expiry.sort_unstable();
            // Free a quarter so a full cache does not sweep on every insert.
            let excess = self.entries.len() + 1 - CAPACITY + CAPACITY / 4;
            for (_, k) in by_expiry.into_iter().take(excess) {
                self.entries.remove(&k);
            }
        }
        self.sweep_at = (self.entries.len() * 2).clamp(SWEEP_FLOOR, CAPACITY);
    }

    fn invalidate(&mut self, user: Option<i64>) {
        match user {
            None => self.entries.clear(),
            Some(user) => {
                let prefix = format!("{user}:");
                self.entries.retain(|k, _| !k.starts_with(&prefix));
            }
        }
    }
}

fn key(user: i64, jellyfin_id: &str) -> String {
    format!("{user}:{jellyfin_id}")
}

/// `getCachedJellyfinWatched(userId, jellyfinId)`.
#[must_use]
pub fn get(user: i64, jellyfin_id: &str) -> Option<bool> {
    lock(&CACHE).get(&key(user, jellyfin_id), Instant::now())
}

/// `setCachedJellyfinWatched(userId, jellyfinId, watched)`.
pub fn set(user: i64, jellyfin_id: &str, watched: bool) {
    lock(&CACHE).insert(key(user, jellyfin_id), watched, Instant::now());
}

/// `invalidateJellyfinStatusCache(userId)`; `None` clears every user.
pub fn invalidate(user: Option<i64>) {
    lock(&CACHE).invalidate(user);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_until_invalidated() {
        set(7, "item-1", true);
        assert_eq!(get(7, "item-1"), Some(true), "stored");
        invalidate(Some(7));
        assert_eq!(get(7, "item-1"), None, "invalidated");
    }

    #[test]
    fn expires_after_ttl() {
        let mut store = Store::new();
        let start = Instant::now();
        store.insert(key(1, "a"), true, start);
        assert_eq!(store.get(&key(1, "a"), start + TTL / 2), Some(true));
        assert_eq!(store.get(&key(1, "a"), start + TTL), None);
        assert!(store.entries.is_empty(), "expired read drops the key");
    }

    #[test]
    fn expired_keys_are_reclaimed_on_insert() {
        let mut store = Store::new();
        let start = Instant::now();
        for i in 0..5_000 {
            store.insert(key(1, &format!("item-{i}")), true, start);
        }
        let later = start + TTL + Duration::from_secs(1);
        for i in 0..5_000 {
            store.insert(key(2, &format!("item-{i}")), false, later);
        }
        assert!(
            store.entries.keys().all(|k| k.starts_with("2:")),
            "every expired user-1 key was swept"
        );
        assert_eq!(store.entries.len(), 5_000);
    }

    #[test]
    fn live_entries_are_capped() {
        let mut store = Store::new();
        let start = Instant::now();
        for i in 0..(CAPACITY * 3) {
            let at = start + Duration::from_millis(u64::try_from(i).unwrap_or(0));
            store.insert(key(1, &format!("item-{i}")), true, at);
            assert!(store.entries.len() <= CAPACITY, "bounded at {i}");
        }
        let newest = format!("item-{}", CAPACITY * 3 - 1);
        assert!(store.entries.contains_key(&key(1, &newest)), "newest kept");
    }
}
