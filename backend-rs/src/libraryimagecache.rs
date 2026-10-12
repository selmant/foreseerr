//! `server/lib/libraryImageCache.ts`: library artwork fetched from a
//! user's Jellyfin, kept in memory for six hours, at most 256 images and
//! 64 MiB, least recently used out first.
//!
//! Node's copy also answers to a process-wide memory budget that can
//! reclaim it early; this one keeps only its own limits.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use bytes::Bytes;

/// `LIBRARY_IMAGE_CACHE_TTL_MS`.
const TTL: Duration = Duration::from_secs(6 * 60 * 60);
/// `LIBRARY_IMAGE_CACHE_MAX_ENTRIES`.
const MAX_ENTRIES: usize = 256;
/// `LIBRARY_IMAGE_CACHE_MAX_BYTES`.
const MAX_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug)]
struct Entry {
    key: String,
    bytes: Bytes,
    content_type: String,
    expires_at: Instant,
    accessed_at: u64,
}

impl Entry {
    fn size(&self) -> usize {
        self.bytes.len().saturating_add(self.content_type.len())
    }
}

#[derive(Debug)]
struct Store {
    entries: Vec<Entry>,
    clock: u64,
}

static STORE: Mutex<Store> = Mutex::new(Store {
    entries: Vec::new(),
    clock: 0,
});

/// `libraryImageCacheKey`.
fn key(user_id: i64, item_id: &str, primary: bool) -> String {
    let kind = if primary { "primary" } else { "backdrop" };
    format!("{user_id}:{item_id}:{kind}")
}

/// `getCachedLibraryImage`: the bytes and content type, while fresh.
#[must_use]
pub fn get(user_id: i64, item_id: &str, primary: bool) -> Option<(Bytes, String)> {
    let key = key(user_id, item_id, primary);
    let mut store = crate::sync::lock(&STORE);
    let now = Instant::now();
    let index = store.entries.iter().position(|e| e.key == key)?;
    if store
        .entries
        .get(index)
        .is_some_and(|e| e.expires_at <= now)
    {
        store.entries.remove(index);
        return None;
    }
    store.clock += 1;
    let clock = store.clock;
    let entry = store.entries.get_mut(index)?;
    entry.accessed_at = clock;
    let found = (entry.bytes.clone(), entry.content_type.clone());
    drop(store);
    Some(found)
}

/// `setCachedLibraryImage`.
pub fn set(user_id: i64, item_id: &str, primary: bool, bytes: Bytes, content_type: &str) {
    let key = key(user_id, item_id, primary);
    let mut store = crate::sync::lock(&STORE);
    let now = Instant::now();
    store.entries.retain(|e| e.key != key && e.expires_at > now);
    store.clock += 1;
    let accessed_at = store.clock;
    store.entries.push(Entry {
        key,
        bytes,
        content_type: content_type.to_owned(),
        expires_at: now + TTL,
        accessed_at,
    });
    loop {
        let total: usize = store.entries.iter().map(Entry::size).sum();
        if store.entries.len() <= MAX_ENTRIES && total <= MAX_BYTES {
            break;
        }
        let oldest = store
            .entries
            .iter()
            .enumerate()
            .min_by_key(|(_, e)| e.accessed_at)
            .map(|(i, _)| i);
        match oldest {
            Some(i) => {
                store.entries.remove(i);
            }
            None => break,
        }
    }
}

/// `resetLibraryImageCache`.
pub fn reset() {
    crate::sync::lock(&STORE).entries.clear();
}

/// `libraryImageCacheSize`: fresh entries.
#[must_use]
pub fn size() -> usize {
    let now = Instant::now();
    let mut store = crate::sync::lock(&STORE);
    store.entries.retain(|e| e.expires_at > now);
    store.entries.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_and_evicts() {
        reset();
        set(1, "abc", true, Bytes::from_static(b"img"), "image/jpeg");
        assert_eq!(
            get(1, "abc", true),
            Some((Bytes::from_static(b"img"), String::from("image/jpeg"))),
            "cached"
        );
        assert_eq!(get(1, "abc", false), None, "other image type");
        assert_eq!(get(2, "abc", true), None, "other user");
        for i in 0..300 {
            set(9, &i.to_string(), false, Bytes::from_static(b"x"), "t");
        }
        assert!(size() <= MAX_ENTRIES, "entry limit");
        assert_eq!(get(1, "abc", true), None, "least recently used went first");
        set(3, "big", true, Bytes::from(vec![0_u8; MAX_BYTES]), "t");
        assert_eq!(get(3, "big", true), None, "over the byte limit by itself");
        reset();
        assert_eq!(size(), 0, "reset");
    }
}
