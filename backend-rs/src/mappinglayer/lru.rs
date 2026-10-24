//! `server/lib/mapping/lru.ts`: a bounded LRU with an optional TTL.

use std::collections::{HashMap, VecDeque};
use std::hash::Hash;
use std::time::{Duration, Instant};

/// `BoundedLru`: at most `max` entries, the least recently used dropped
/// first; an entry older than the TTL reads as absent.
#[derive(Debug)]
pub struct BoundedLru<K, V> {
    max: usize,
    ttl: Option<Duration>,
    entries: HashMap<K, (V, Option<Instant>, u64)>,
    /// Keys by recency (oldest first), with the stamp they were used at;
    /// a stale stamp is skipped when evicting.
    order: VecDeque<(K, u64)>,
    clock: u64,
}

impl<K: Eq + Hash + Clone, V: Clone> BoundedLru<K, V> {
    /// An empty cache.
    #[must_use]
    pub fn new(max: usize, ttl: Option<Duration>) -> Self {
        Self {
            max,
            ttl,
            entries: HashMap::new(),
            order: VecDeque::new(),
            clock: 0,
        }
    }

    fn touch(&mut self, key: &K) -> u64 {
        self.clock += 1;
        self.order.push_back((key.clone(), self.clock));
        self.clock
    }

    /// Drop the recency marks of keys used again since, once they pile up.
    fn compact(&mut self) {
        if self.order.len() > self.max.saturating_mul(4).max(64) {
            let entries = &self.entries;
            self.order
                .retain(|(k, stamp)| entries.get(k).is_some_and(|(_, _, s)| s == stamp));
        }
    }

    /// `get`: the value, moved to the most recent end; `None` when absent
    /// or expired (an expired entry is dropped).
    pub fn get(&mut self, key: &K) -> Option<V> {
        let expired = match self.entries.get(key) {
            None => return None,
            Some((_, expires, _)) => expires.is_some_and(|at| at <= Instant::now()),
        };
        if expired {
            self.entries.remove(key);
            return None;
        }
        let stamp = self.touch(key);
        let entry = self.entries.get_mut(key)?;
        entry.2 = stamp;
        let value = entry.0.clone();
        self.compact();
        Some(value)
    }

    /// `set`: store at the most recent end, then drop the oldest entries
    /// over the cap.
    pub fn set(&mut self, key: K, value: V) {
        let expires = self.ttl.map(|ttl| Instant::now() + ttl);
        let stamp = self.touch(&key);
        self.entries.insert(key, (value, expires, stamp));
        while self.entries.len() > self.max {
            let Some((oldest, stamp)) = self.order.pop_front() else {
                break;
            };
            if self
                .entries
                .get(&oldest)
                .is_some_and(|(_, _, s)| *s == stamp)
            {
                self.entries.remove(&oldest);
            }
        }
        self.compact();
    }

    /// `clear`.
    pub fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evicts_the_least_recently_used() {
        let mut lru = BoundedLru::new(2, None);
        lru.set("a", 1);
        lru.set("b", 2);
        assert_eq!(lru.get(&"a"), Some(1), "a is fresh again");
        lru.set("c", 3);
        assert_eq!(lru.get(&"b"), None, "b was the oldest");
        assert_eq!(lru.get(&"a"), Some(1), "a stays");
        assert_eq!(lru.get(&"c"), Some(3), "c stays");
        lru.set("a", 4);
        lru.set("d", 5);
        assert_eq!(lru.get(&"c"), None, "re-setting a made c the oldest");
        lru.clear();
        assert_eq!(lru.get(&"a"), None, "cleared");
    }

    #[test]
    fn expires() {
        let mut lru = BoundedLru::new(4, Some(Duration::ZERO));
        lru.set(1, true);
        assert_eq!(lru.get(&1), None, "expired at once");
    }
}
