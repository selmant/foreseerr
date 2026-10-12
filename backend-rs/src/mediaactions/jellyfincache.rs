//! `jellyfinStatusCache.ts`: what a user's Jellyfin said an item's
//! played state was, for thirty seconds.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::sync::lock;

const TTL: Duration = Duration::from_secs(30);

static CACHE: LazyLock<Mutex<HashMap<String, (bool, Instant)>>> = LazyLock::new(Mutex::default);

fn key(user: i64, jellyfin_id: &str) -> String {
    format!("{user}:{jellyfin_id}")
}

/// `getCachedJellyfinWatched(userId, jellyfinId)`.
#[must_use]
pub fn get(user: i64, jellyfin_id: &str) -> Option<bool> {
    let entry_key = key(user, jellyfin_id);
    let mut cache = lock(&CACHE);
    let (watched, expires) = *cache.get(&entry_key)?;
    if expires <= Instant::now() {
        cache.remove(&entry_key);
        drop(cache);
        return None;
    }
    drop(cache);
    Some(watched)
}

/// `setCachedJellyfinWatched(userId, jellyfinId, watched)`.
pub fn set(user: i64, jellyfin_id: &str, watched: bool) {
    lock(&CACHE).insert(key(user, jellyfin_id), (watched, Instant::now() + TTL));
}

/// `invalidateJellyfinStatusCache(userId)`; `None` clears every user.
pub fn invalidate(user: Option<i64>) {
    let mut cache = lock(&CACHE);
    match user {
        None => cache.clear(),
        Some(user) => {
            let prefix = format!("{user}:");
            cache.retain(|k, _| !k.starts_with(&prefix));
        }
    }
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
}
