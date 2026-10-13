//! `server/lib/libraryImageCache.ts`: library artwork fetched from a
//! user's Jellyfin, kept in memory for six hours, at most 256 images and
//! 64 MiB, least recently used out first.
//!
//! The images live in a store of [`crate::memcache`], so they also answer
//! to the response caches' shared budget, which can reclaim them early,
//! as Node's do.

use std::time::Duration;

use bytes::Bytes;

use crate::memcache::{self, Limits};

/// `LIBRARY_IMAGE_CACHE_TTL_MS`.
const TTL: Duration = Duration::from_secs(6 * 60 * 60);
/// `LIBRARY_IMAGE_CACHE_MAX_ENTRIES`.
const MAX_ENTRIES: usize = 256;
/// `LIBRARY_IMAGE_CACHE_MAX_BYTES`.
const MAX_BYTES: u64 = 64 * 1024 * 1024;

/// The store's own limits under the shared budget.
pub(crate) const LIMITS: Limits = Limits {
    max_entries: Some(MAX_ENTRIES),
    max_bytes: Some(MAX_BYTES),
};

/// `LibraryImageCacheEntry`.
#[derive(Debug)]
pub struct Artwork {
    /// The image.
    pub bytes: Bytes,
    /// Its content type.
    pub content_type: String,
}

impl Artwork {
    /// What it weighs: the image and its content type.
    #[must_use]
    pub fn size(&self) -> u64 {
        u64::try_from(self.bytes.len().saturating_add(self.content_type.len())).unwrap_or(u64::MAX)
    }
}

/// `libraryImageCacheKey`.
fn key(user_id: i64, item_id: &str, primary: bool) -> String {
    let kind = if primary { "primary" } else { "backdrop" };
    format!("{user_id}:{item_id}:{kind}")
}

/// `getCachedLibraryImage`: the bytes and content type, while fresh.
#[must_use]
pub fn get(user_id: i64, item_id: &str, primary: bool) -> Option<(Bytes, String)> {
    memcache::artwork(&key(user_id, item_id, primary))
        .map(|artwork| (artwork.bytes.clone(), artwork.content_type.clone()))
}

/// `setCachedLibraryImage`.
pub fn set(user_id: i64, item_id: &str, primary: bool, bytes: Bytes, content_type: &str) {
    memcache::set_artwork(
        key(user_id, item_id, primary),
        Artwork {
            bytes,
            content_type: content_type.to_owned(),
        },
        TTL,
    );
}

/// `resetLibraryImageCache`.
pub fn reset() {
    memcache::flush_artwork();
}

/// `libraryImageCacheSize`: fresh entries.
#[must_use]
pub fn size() -> usize {
    memcache::artwork_count()
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
        let big = usize::try_from(MAX_BYTES).unwrap_or(usize::MAX);
        set(3, "big", true, Bytes::from(vec![0_u8; big]), "t");
        assert_eq!(get(3, "big", true), None, "over the byte limit by itself");
        reset();
        assert_eq!(size(), 0, "reset");
    }
}
