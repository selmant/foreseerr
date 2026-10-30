//! `dns-caching`'s `DnsCacheManager` as `server/utils/dnsCache.ts` sets it
//! up.
//!
//! One process-wide cache of host lookups (at most 500, least recently
//! used out first) with its counters, `getStats()`, `getCacheEntries()`
//! and `clear(hostname)` for `GET /settings/cache` and the DNS flush.
//!
//! Lookups ask the DNS servers for A and AAAA records
//! ([`crate::dnsquery`], as `resolveWithTtl` does) and an answer lives for
//! its lowest record TTL raised to `forceMinTtl`. A name DNS doesn't know
//! (a hosts-file name) fails those four attempts and falls back to the
//! system lookup, stored for `min(max(forceMinTtl, 60 s), forceMaxTtl)`.
//! A positive `forceMaxTtl` is the LRU's own TTL: an entry is gone that
//! long after it was stored, and between its TTL and that it is served
//! stale while a background lookup refreshes it.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

use crate::sync::lock;

/// `cacheMaxEntries`.
const MAX_ENTRIES: usize = 500;
/// `maxRetries`.
const MAX_RETRIES: u32 = 3;
/// `resolveWithTtl`'s TTL when the answer carries none.
pub const DEFAULT_TTL: Duration = Duration::from_secs(300);

/// The cache's TTL settings, from `network.dnsCache`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ttl {
    /// `forceMinTtl` (zero when unset).
    pub min: Duration,
    /// A positive `forceMaxTtl`.
    pub max: Option<Duration>,
}

impl Ttl {
    /// `Math.max(forceMinTtl, result.ttl)` for an answer without a TTL.
    #[must_use]
    pub fn entry(self) -> Duration {
        self.min.max(DEFAULT_TTL)
    }

    /// The TTL of an entry the native-lookup fallback stores:
    /// `Math.min(Math.max(forceMinTtl, 60000), forceMaxTtl)` (an unset
    /// `forceMaxTtl` is -1), then `Math.max(forceMinTtl, ttl)`.
    #[must_use]
    pub fn fallback(self) -> Duration {
        let ttl = self.max.map_or(Duration::ZERO, |max| {
            self.min.max(Duration::from_secs(60)).min(max)
        });
        self.min.max(ttl)
    }
}

#[derive(Debug, Clone)]
struct Entry {
    ipv4: Vec<IpAddr>,
    ipv6: Vec<IpAddr>,
    active: IpAddr,
    stored: Instant,
    ttl: Duration,
    hits: u64,
    misses: u64,
    used: u64,
}

#[derive(Debug, Default)]
struct Cache {
    entries: HashMap<String, Entry>,
    hits: u64,
    misses: u64,
    failures: u64,
    ipv4_fallbacks: u64,
    clock: u64,
    setup: Option<Ttl>,
}

static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(Mutex::default);

impl Cache {
    const fn tick(&mut self) -> u64 {
        self.clock += 1;
        self.clock
    }

    /// The LRU's view: an entry past `forceMaxTtl` no longer exists.
    fn purge_stale(&mut self, ttl: Ttl, now: Instant) {
        if let Some(max) = ttl.max {
            self.entries
                .retain(|_, e| now.saturating_duration_since(e.stored) < max);
        }
    }

    fn insert(&mut self, host: String, mut entry: Entry) {
        if !self.entries.contains_key(&host) && self.entries.len() >= MAX_ENTRIES {
            let oldest = self
                .entries
                .iter()
                .min_by_key(|(_, e)| e.used)
                .map(|(k, _)| k.clone());
            if let Some(oldest) = oldest {
                self.entries.remove(&oldest);
            }
        }
        entry.used = self.tick();
        self.entries.insert(host, entry);
    }
}

/// Set the cache up (`initializeDnsCache` at startup).
pub fn initialize(ttl: Ttl) {
    lock(&CACHE).setup = Some(ttl);
}

/// Whether the cache was set up at startup (`dnsCache` is defined).
#[must_use]
pub fn initialized() -> bool {
    lock(&CACHE).setup.is_some()
}

/// What a cached lookup found.
enum Cached {
    Fresh(Vec<IpAddr>),
    Stale(Vec<IpAddr>),
    Missing,
}

fn addresses(entry: &Entry, ipv4_only: bool) -> Vec<IpAddr> {
    if ipv4_only {
        entry.ipv4.clone()
    } else {
        entry.ipv4.iter().chain(&entry.ipv6).copied().collect()
    }
}

fn cached(host: &str, ttl: Ttl, ipv4_only: bool) -> Cached {
    let mut cache = lock(&CACHE);
    let now = Instant::now();
    cache.purge_stale(ttl, now);
    let used = cache.tick();
    let Some(entry) = cache.entries.get_mut(host) else {
        return Cached::Missing;
    };
    entry.used = used;
    let age = now.saturating_duration_since(entry.stored);
    if age < entry.ttl {
        let found = addresses(entry, ipv4_only);
        if ipv4_only && entry.active.is_ipv6() && !entry.ipv4.is_empty() {
            // "Switching from IPv6 to IPv4": a copy is handed out, the
            // entry's own hits stay as they are.
            cache.ipv4_fallbacks += 1;
            return Cached::Fresh(found);
        }
        entry.hits += 1;
        cache.hits += 1;
        return Cached::Fresh(found);
    }
    if ttl.max.is_some_and(|max| age < max) {
        entry.misses += 1;
        let found = addresses(entry, ipv4_only);
        cache.misses += 1;
        return Cached::Stale(found);
    }
    cache.misses += 1;
    cache.entries.remove(host);
    Cached::Missing
}

async fn system_lookup(host: &str) -> std::io::Result<(Vec<IpAddr>, Vec<IpAddr>)> {
    let (v4, v6): (Vec<IpAddr>, Vec<IpAddr>) = tokio::net::lookup_host((host, 0))
        .await?
        .map(|a: SocketAddr| a.ip())
        .partition(IpAddr::is_ipv4);
    if v4.is_empty() && v6.is_empty() {
        return Err(std::io::Error::other(format!(
            "No DNS records found for {host}"
        )));
    }
    Ok((v4, v6))
}

/// `resolveWithTtl`: the A and AAAA records, and their lowest TTL (300 s
/// when there is none).
async fn resolve_with_ttl(host: &str) -> std::io::Result<(Vec<IpAddr>, Vec<IpAddr>, Duration)> {
    use crate::dnsquery::{resolve, Family};
    let (a, aaaa) = tokio::join!(resolve(host, Family::V4), resolve(host, Family::V6));
    let (a, aaaa) = (a.unwrap_or_default(), aaaa.unwrap_or_default());
    if a.is_empty() && aaaa.is_empty() {
        return Err(std::io::Error::other(format!(
            "No DNS records found for {host}"
        )));
    }
    let ttl = a
        .iter()
        .chain(&aaaa)
        .map(|(_, ttl)| *ttl)
        .min()
        .map_or(DEFAULT_TTL, |secs| Duration::from_secs(u64::from(secs)));
    let ips =
        |records: Vec<crate::dnsquery::Record>| records.into_iter().map(|(ip, _)| ip).collect();
    Ok((ips(a), ips(aaaa), ttl))
}

/// `selectActiveAddress`.
fn active(v4: &[IpAddr], v6: &[IpAddr], prefer_v4: bool) -> IpAddr {
    let (first, second) = if prefer_v4 { (v4, v6) } else { (v6, v4) };
    first
        .first()
        .or_else(|| second.first())
        .copied()
        .unwrap_or_else(|| IpAddr::from([127, 0, 0, 1]))
}

/// A lookup and the entry it stores, carrying the previous entry's
/// counters as `dns-caching` does.
async fn resolve_and_store(host: &str, ttl: Ttl, ipv4_only: bool) -> std::io::Result<()> {
    let (v4, v6, record_ttl) = resolve_with_ttl(host).await?;
    let mut cache = lock(&CACHE);
    let existing = cache.entries.get(host).map(|e| (e.hits, e.misses));
    let entry = Entry {
        active: active(&v4, &v6, ipv4_only),
        ipv4: v4,
        ipv6: v6,
        stored: Instant::now(),
        ttl: ttl.min.max(record_ttl),
        hits: existing.map_or(0, |(h, _)| h),
        misses: existing.map_or(0, |(_, m)| m) + 1,
        used: 0,
    };
    cache.insert(host.to_owned(), entry);
    drop(cache);
    Ok(())
}

/// `lookup(hostname)`: the cached addresses, or a fresh lookup (retried
/// with `dns-caching`'s backoff) that is then cached.
///
/// # Errors
///
/// Fails when every attempt failed.
pub async fn lookup(host: &str, ttl: Ttl, ipv4_only: bool) -> std::io::Result<Vec<IpAddr>> {
    if host == "localhost" || host == "::1" {
        let (v4, v6) = system_lookup(host).await?;
        return Ok(if ipv4_only {
            v4
        } else {
            v4.into_iter().chain(v6).collect()
        });
    }
    match cached(host, ttl, ipv4_only) {
        Cached::Fresh(found) => return Ok(found),
        Cached::Stale(found) => {
            let host = host.to_owned();
            tokio::spawn(async move {
                if let Err(e) = resolve_and_store(&host, ttl, ipv4_only).await {
                    tracing::error!("Failed to refresh DNS for {host}: {e}");
                }
            });
            return Ok(found);
        }
        Cached::Missing => {}
    }
    let mut attempt = 0_u32;
    let mut prefer_v4 = ipv4_only;
    loop {
        match resolve_and_store(host, ttl, prefer_v4).await {
            Ok(()) => break,
            Err(e) => {
                lock(&CACHE).failures += 1;
                if attempt >= MAX_RETRIES {
                    tracing::debug!(
                        "Cached DNS lookup failed for {host}, falling back to native DNS: {e}"
                    );
                    return native_fallback(host, ttl, ipv4_only).await;
                }
                let backoff = (100_u64 << attempt).min(2000);
                tokio::time::sleep(Duration::from_millis(backoff)).await;
                // The last retry asks for IPv4 first.
                prefer_v4 = prefer_v4 || attempt + 1 == MAX_RETRIES;
                attempt += 1;
            }
        }
    }
    let cache = lock(&CACHE);
    Ok(cache
        .entries
        .get(host)
        .map(|e| addresses(e, ipv4_only))
        .unwrap_or_default())
}

/// The wrapped lookup's fallback once the cached lookup gave up: the
/// system lookup, whose answer is stored (merged into an entry that
/// reappeared meanwhile) for [`Ttl::fallback`].
async fn native_fallback(host: &str, ttl: Ttl, ipv4_only: bool) -> std::io::Result<Vec<IpAddr>> {
    let found: Vec<IpAddr> = tokio::net::lookup_host((host, 0))
        .await?
        .map(|a: SocketAddr| a.ip())
        .collect();
    let Some(first) = found.first().copied() else {
        return Err(std::io::Error::other(format!(
            "No DNS records found for {host}"
        )));
    };
    let (v4, v6): (Vec<IpAddr>, Vec<IpAddr>) = found.iter().copied().partition(IpAddr::is_ipv4);
    let mut cache = lock(&CACHE);
    let merge = |old: &[IpAddr], new: &[IpAddr]| {
        let mut out = old.to_vec();
        for ip in new {
            if !out.contains(ip) {
                out.push(*ip);
            }
        }
        out
    };
    let (v4_all, v6_all) = cache.entries.get(host).map_or_else(
        || (v4.clone(), v6.clone()),
        |existing| (merge(&existing.ipv4, &v4), merge(&existing.ipv6, &v6)),
    );
    let entry = Entry {
        ipv4: v4_all,
        ipv6: v6_all,
        active: first,
        stored: Instant::now(),
        ttl: ttl.fallback(),
        hits: 0,
        misses: 0,
        used: 0,
    };
    cache.insert(host.to_owned(), entry);
    drop(cache);
    Ok(if ipv4_only { v4 } else { found })
}

/// `getStats()`.
#[must_use]
pub fn stats() -> Value {
    let (size, hits, misses, failures, fallbacks) = {
        let cache = lock(&CACHE);
        (
            cache.entries.len(),
            cache.hits,
            cache.misses,
            cache.failures,
            cache.ipv4_fallbacks,
        )
    };
    let total = if hits + misses == 0 { 1 } else { hits + misses };
    let ratio = crate::jsnum::from_i64(i64::try_from(hits).unwrap_or(i64::MAX))
        / crate::jsnum::from_i64(i64::try_from(total).unwrap_or(i64::MAX));
    let mut out = Map::new();
    out.insert(String::from("size"), Value::from(size));
    out.insert(String::from("cacheMaxEntries"), Value::from(MAX_ENTRIES));
    out.insert(String::from("hits"), Value::from(hits));
    out.insert(String::from("misses"), Value::from(misses));
    out.insert(String::from("failures"), Value::from(failures));
    out.insert(String::from("ipv4Fallbacks"), Value::from(fallbacks));
    out.insert(String::from("hitRate"), crate::jsnum::json(ratio));
    Value::Object(out)
}

fn millis(d: Duration) -> Value {
    Value::from(u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// `getCacheEntries()`: host → its addresses and counters, most recently
/// used first (the LRU's iteration order).
#[must_use]
pub fn entries() -> Value {
    let now = Instant::now();
    let mut list: Vec<(String, Entry)> = {
        let mut cache = lock(&CACHE);
        if let Some(ttl) = cache.setup {
            cache.purge_stale(ttl, now);
        }
        cache
            .entries
            .iter()
            .map(|(k, e)| (k.clone(), e.clone()))
            .collect()
    };
    list.sort_by_key(|(_, e)| std::cmp::Reverse(e.used));
    let mut out = Map::new();
    for (host, e) in list {
        let age = now.saturating_duration_since(e.stored);
        let mut addresses = Map::new();
        addresses.insert(String::from("ipv4"), Value::from(e.ipv4.len()));
        addresses.insert(String::from("ipv6"), Value::from(e.ipv6.len()));
        let mut item = Map::new();
        item.insert(String::from("addresses"), Value::Object(addresses));
        item.insert(
            String::from("activeAddress"),
            Value::from(e.active.to_string()),
        );
        item.insert(
            String::from("family"),
            Value::from(if e.active.is_ipv4() { 4 } else { 6 }),
        );
        item.insert(String::from("age"), millis(age));
        item.insert(String::from("ttl"), millis(e.ttl.saturating_sub(age)));
        item.insert(String::from("hits"), Value::from(e.hits));
        item.insert(String::from("misses"), Value::from(e.misses));
        out.insert(host, Value::Object(item));
    }
    Value::Object(out)
}

/// `clear(hostname)` for a named host: drop its entry.
pub fn clear_host(host: &str) {
    if host.is_empty() {
        return;
    }
    if lock(&CACHE).entries.remove(host).is_some() {
        tracing::debug!("Cleared DNS cache entry for {host}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_address_prefers_the_family() {
        let v4 = [IpAddr::from([10, 0, 0, 1])];
        let v6 = [IpAddr::from([0, 0, 0, 0, 0, 0, 0, 1])];
        assert_eq!(active(&v4, &v6, true), v4[0], "IPv4 first");
        assert_eq!(active(&v4, &v6, false), v6[0], "IPv6 first");
        assert_eq!(active(&[], &v6, true), v6[0], "the other family");
        assert_eq!(
            active(&[], &[], false),
            IpAddr::from([127, 0, 0, 1]),
            "none"
        );
    }

    #[test]
    fn entry_ttl() {
        let ttl = Ttl {
            min: Duration::from_secs(600),
            max: None,
        };
        assert_eq!(ttl.entry(), Duration::from_secs(600), "raised");
        let ttl = Ttl {
            min: Duration::ZERO,
            max: Some(Duration::from_secs(30)),
        };
        assert_eq!(ttl.entry(), DEFAULT_TTL, "the LRU TTL caps it instead");
        assert_eq!(
            ttl.fallback(),
            Duration::from_secs(30),
            "capped at forceMaxTtl"
        );
        let unset = Ttl {
            min: Duration::ZERO,
            max: None,
        };
        assert_eq!(unset.fallback(), Duration::ZERO, "expired at once");
    }
}
