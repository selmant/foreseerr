//! Node's cache routes under `/internal/cache`.
//!
//! `GET /internal/cache` and `POST /internal/cache/{:cacheId,images,all}/flush`
//! and `/internal/cache/dns/:dnsEntry/flush`: the response caches
//! ([`crate::memcache`]), the image cache and the DNS cache.

use std::path::Path;

use serde_json::{Map, Value};

use crate::memcache::{self, CacheId};
use crate::standalone::internal::Answer;
use crate::state::AppState;

/// The parts of `GET /settings/cache` the caches hold.
pub async fn stats(state: &AppState) -> Answer {
    let settings = match super::settings(state).await {
        Ok(settings) => settings,
        Err(e) => return Answer::message(500, &format!("{e:#}")),
    };
    let config_dir = &state.env.config_dir;
    let api_caches = memcache::api_caches();
    let (images, image_cache) = tokio::join!(
        crate::imagecache::combined_stats(config_dir, &settings),
        crate::imagecache::image_cache_stats(config_dir)
    );
    let mut dns = Map::new();
    if crate::dnscache::initialized() {
        dns.insert(String::from("stats"), crate::dnscache::stats());
        dns.insert(String::from("entries"), crate::dnscache::entries());
    }
    let mut out = Map::new();
    out.insert(String::from("apiCaches"), api_caches);
    out.insert(String::from("imageCache"), image_cache);
    // The shared budget of the response caches and library artwork, as
    // Node's `getMemoryCacheStats()` reports it: the provider rows and the
    // per-user sync snapshots have their own bounds outside it, so this
    // isn't the process's memory.
    out.insert(String::from("memory"), memcache::memory_stats());
    out.insert(String::from("images"), images);
    out.insert(String::from("dnsCache"), Value::Object(dns));
    Answer::json(200, Value::Object(out))
}

/// `cacheManager.getCache(id).flush()`.
#[must_use]
pub fn flush(id: &str) -> Answer {
    CacheId::parse(id).map_or_else(
        || Answer::message(404, "Cache not found."),
        |id| {
            memcache::flush(id);
            Answer::no_content()
        },
    )
}

/// `ImageProxy.clearAll()` and `resetLibraryImageCache()`.
pub async fn flush_images(config_dir: &Path) -> Answer {
    match crate::imagecache::flush_images(config_dir).await {
        Ok(()) => Answer::no_content(),
        Err(e) => Answer::message(500, &format!("{e:#}")),
    }
}

/// Every `cacheManager` cache flushed, then [`flush_images`].
pub async fn flush_all(config_dir: &Path) -> Answer {
    for id in CacheId::ALL {
        memcache::flush(id);
    }
    flush_images(config_dir).await
}

/// `dnsCache.clear(entry)`.
#[must_use]
pub fn flush_dns(entry: &str) -> Answer {
    if !crate::dnscache::initialized() {
        return Answer::message(404, "Cache not found.");
    }
    crate::dnscache::clear_host(entry);
    Answer::no_content()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flushing_needs_a_known_cache() {
        assert_eq!(flush("github").status, 204, "known");
        assert_eq!(
            flush("toString").status,
            404,
            "prototype keys aren't caches"
        );
        assert_eq!(flush("plexguid").status, 404, "not one of Node's");
    }

    #[tokio::test]
    async fn flushing_images_clears_the_directory_and_library_artwork() -> anyhow::Result<()> {
        if std::env::var_os("CACHE_DIRECTORY").is_some() {
            // The cache would be that directory's, not this test's.
            return Ok(());
        }
        let config =
            std::env::temp_dir().join(format!("foreseerr-flush-images-{}", std::process::id()));
        let group = crate::imagecache::cache_root(&config).join("tmdb");
        tokio::fs::create_dir_all(&group).await?;
        tokio::fs::write(group.join("poster.jpg"), b"image").await?;
        let item = "flush-images-test";
        crate::libraryimagecache::set(
            1,
            item,
            true,
            bytes::Bytes::from_static(b"art"),
            "image/jpeg",
        );

        assert_eq!(flush_images(&config).await.status, 204, "flushed");
        assert!(!group.exists(), "the image directory is removed");
        assert!(
            crate::libraryimagecache::get(1, item, true).is_none(),
            "library artwork is dropped"
        );
        assert_eq!(
            flush_images(&config).await.status,
            204,
            "nothing left to remove"
        );
        tokio::fs::remove_dir_all(&config).await?;
        Ok(())
    }
}
