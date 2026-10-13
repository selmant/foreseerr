//! `GET /internal/cache`, `POST /internal/cache/:cacheId/flush` and
//! `POST /internal/cache/dns/:dnsEntry/flush`: the response caches
//! ([`crate::memcache`]), the image cache and the DNS cache.

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
}
