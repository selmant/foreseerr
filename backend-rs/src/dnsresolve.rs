//! Name resolution for the outgoing clients.
//!
//! As Node sets it up at startup: `network.forceIpv4First` (Node's agents connect with
//! `family: 4`, so only IPv4 addresses are used) and `network.dnsCache`
//! (`dns-caching`'s `DnsCacheManager`, in [`crate::dnscache`]).
//!
//! A cached lookup lives for its records' TTL, raised to `forceMinTtl` and
//! capped by a positive `forceMaxTtl` (both in seconds, as in
//! settings.json); see [`crate::dnscache`].

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use serde_json::Value;

use crate::dnscache::Ttl;
use crate::settings::public::truthy;
use crate::settings::Settings;

/// The resolver the settings ask for, or `None` for the default one.
#[must_use]
pub fn resolver(settings: &Settings) -> Option<Arc<NetResolver>> {
    let ipv4_only = truthy(settings.get("/network/forceIpv4First"));
    let cache = settings.get("/network/dnsCache");
    let ttl = cache
        .filter(|c| truthy(c.get("enabled")))
        .map(|c| cache_ttl(c.get("forceMinTtl"), c.get("forceMaxTtl")));
    if let Some(ttl) = ttl {
        crate::dnscache::initialize(ttl);
    }
    (ipv4_only || ttl.is_some()).then(|| Arc::new(NetResolver { ipv4_only, ttl }))
}

/// The cache's TTL bounds.
fn cache_ttl(min: Option<&Value>, max: Option<&Value>) -> Ttl {
    let seconds = |v: Option<&Value>| v.and_then(Value::as_f64).filter(|s| s.is_finite());
    Ttl {
        min: seconds(min)
            .filter(|s| *s > 0.0)
            .map_or(Duration::ZERO, Duration::from_secs_f64),
        max: seconds(max)
            .filter(|s| *s > 0.0)
            .map(Duration::from_secs_f64),
    }
}

/// A resolver over the system's `getaddrinfo`.
#[derive(Debug)]
pub struct NetResolver {
    ipv4_only: bool,
    ttl: Option<Ttl>,
}

impl Resolve for NetResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        let ipv4_only = self.ipv4_only;
        let ttl = self.ttl;
        Box::pin(async move {
            let found: Vec<SocketAddr> = if let Some(ttl) = ttl {
                crate::dnscache::lookup(&host, ttl, ipv4_only)
                    .await?
                    .into_iter()
                    .map(|ip| SocketAddr::new(ip, 0))
                    .collect()
            } else {
                tokio::net::lookup_host((host.as_str(), 0))
                    .await?
                    .filter(|a| !ipv4_only || a.is_ipv4())
                    .collect()
            };
            if found.is_empty() {
                return Err(format!("no usable address for {host}").into());
            }
            let addrs: Addrs = Box::new(found.into_iter());
            Ok(addrs)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dnscache::DEFAULT_TTL;
    use serde_json::json;

    #[test]
    fn ttl_follows_the_forced_bounds() {
        let ttl = cache_ttl(Some(&json!(0)), Some(&json!(-1)));
        assert_eq!((ttl.entry(), ttl.max), (DEFAULT_TTL, None), "defaults");
        assert_eq!(
            cache_ttl(Some(&json!(600)), None).entry(),
            Duration::from_secs(600),
            "raised"
        );
        assert_eq!(
            cache_ttl(None, Some(&json!(30))).max,
            Some(Duration::from_secs(30)),
            "capped by the LRU"
        );
    }

    #[test]
    fn only_when_asked() -> anyhow::Result<()> {
        let plain = Settings::from_file_value(json!({}), None)?;
        assert!(
            resolver(&plain).is_none(),
            "defaults keep the system resolver"
        );
        let v4 = Settings::from_file_value(json!({"network": {"forceIpv4First": true}}), None)?;
        assert!(
            resolver(&v4).is_some_and(|r| r.ipv4_only && r.ttl.is_none()),
            "IPv4 only"
        );
        let cached =
            Settings::from_file_value(json!({"network": {"dnsCache": {"enabled": true}}}), None)?;
        assert!(
            resolver(&cached).is_some_and(|r| !r.ipv4_only && r.ttl.is_some()),
            "cache"
        );
        Ok(())
    }
}
