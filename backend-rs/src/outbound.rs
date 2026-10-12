//! The client for outgoing calls, set up like Node's axios instances: the
//! `network.proxy` settings with their bypass rules, the extra CA file and
//! a `Foreseerr/<version>` user agent.
//!
//! Like Node, the proxy is read once at startup; changing it needs a
//! restart (see `restartFlag`).

use std::path::Path;

use anyhow::{Context, Result};
use serde_json::Value;

use crate::settings::public::truthy;
use crate::settings::Settings;
use crate::version::AppVersion;

/// A failed outgoing call in plain words, for logs and error messages:
/// the status a server refused it with, a timeout, or the error and its
/// causes.
#[must_use]
pub fn describe(e: &reqwest::Error) -> String {
    if let Some(status) = e.status() {
        return format!("Request failed with status code {}", status.as_u16());
    }
    if e.is_timeout() {
        return String::from("The request timed out");
    }
    let mut message = e.to_string();
    let mut source = std::error::Error::source(e);
    while let Some(cause) = source {
        message.push_str(": ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    message
}

/// [`describe`] for the first outgoing-call failure in an `anyhow` chain.
#[must_use]
pub fn failure_in(err: &anyhow::Error) -> Option<String> {
    err.chain()
        .find_map(|e| e.downcast_ref::<reqwest::Error>())
        .map(describe)
}

/// Build the client.
///
/// # Errors
///
/// Fails when the CA file can't be read or the client can't be built.
pub fn client(
    settings: &Settings,
    version: &AppVersion,
    extra_ca: Option<&Path>,
) -> Result<reqwest::Client> {
    builder(settings, version, extra_ca)?
        .build()
        .context("building the outgoing HTTP client")
}

/// The client's builder, for callers that change more (redirects,
/// timeouts) before building.
///
/// # Errors
///
/// Fails when the CA file can't be read.
pub fn builder(
    settings: &Settings,
    version: &AppVersion,
    extra_ca: Option<&Path>,
) -> Result<reqwest::ClientBuilder> {
    let mut builder = reqwest::Client::builder().user_agent(version.user_agent());
    if let Some(path) = extra_ca {
        let pem = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
        for cert in reqwest::Certificate::from_pem_bundle(&pem)
            .with_context(|| format!("parsing {}", path.display()))?
        {
            builder = builder.add_root_certificate(cert);
        }
    }
    if let Some(proxy) = proxy(settings.get("/network/proxy")) {
        builder = builder.proxy(proxy);
    }
    if let Some(resolver) = crate::dnsresolve::resolver(settings) {
        builder = builder.dns_resolver(resolver);
    }
    Ok(builder)
}

/// `createCustomProxyAgent`: the proxy to use, or none when it is off or
/// misconfigured (Node logs and carries on without one too).
fn proxy(cfg: Option<&Value>) -> Option<reqwest::Proxy> {
    let cfg = cfg?;
    if !truthy(cfg.get("enabled")) {
        return None;
    }
    let hostname = cfg
        .get("hostname")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if hostname.is_empty() {
        tracing::error!("network.proxy is enabled but has no hostname; going without a proxy");
        return None;
    }
    let scheme = if truthy(cfg.get("useSsl")) {
        "https"
    } else {
        "http"
    };
    let port = cfg.get("port").and_then(Value::as_u64).unwrap_or(8080);
    let url = format!("{scheme}://{hostname}:{port}");
    let rules = BypassRules::from_settings(cfg);
    let mut proxy = reqwest::Proxy::custom(move |target: &reqwest::Url| {
        let host = target.host_str().unwrap_or("");
        if rules.bypasses(host) {
            None
        } else {
            Some(url.clone())
        }
    });
    let user = cfg.get("user").and_then(Value::as_str).unwrap_or("");
    let password = cfg.get("password").and_then(Value::as_str).unwrap_or("");
    if !user.is_empty() && !password.is_empty() {
        proxy = proxy.basic_auth(user, password);
    }
    Some(proxy)
}

/// `skipUrl` from `server/utils/customProxyAgent.ts`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct BypassRules {
    local_addresses: bool,
    filter: Vec<String>,
}

impl BypassRules {
    fn from_settings(cfg: &Value) -> Self {
        Self {
            local_addresses: truthy(cfg.get("bypassLocalAddresses")),
            filter: cfg
                .get("bypassFilter")
                .and_then(Value::as_str)
                .unwrap_or("")
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect(),
        }
    }

    fn bypasses(&self, hostname: &str) -> bool {
        if self.local_addresses && is_local_address(hostname) {
            return true;
        }
        self.filter.iter().any(|rule| {
            rule.strip_prefix('*')
                .map_or_else(|| hostname == rule, |suffix| hostname.ends_with(suffix))
        })
    }
}

/// `isLocalAddress`: loopback names and the RFC 1918 ranges, by prefix.
fn is_local_address(hostname: &str) -> bool {
    if matches!(hostname, "localhost" | "127.0.0.1" | "::1") {
        return true;
    }
    if hostname.starts_with("10.") || hostname.starts_with("192.168.") {
        return true;
    }
    hostname
        .strip_prefix("172.")
        .and_then(|rest| rest.split_once('.'))
        .and_then(|(second, _)| second.parse::<u8>().ok())
        .is_some_and(|n| (16..=31).contains(&n) && n.to_string().len() == 2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_addresses() {
        for host in [
            "localhost",
            "127.0.0.1",
            "::1",
            "10.1.2.3",
            "172.16.0.1",
            "172.31.9.9",
            "192.168.1.1",
        ] {
            assert!(is_local_address(host), "{host} is local");
        }
        for host in [
            "172.15.0.1",
            "172.32.0.1",
            "8.8.8.8",
            "example.com",
            "127.0.0.2",
        ] {
            assert!(!is_local_address(host), "{host} is not local");
        }
    }

    #[test]
    fn bypass_filter() {
        let rules = BypassRules {
            local_addresses: false,
            filter: vec![String::from("*.internal"), String::from("plex.example")],
        };
        assert!(rules.bypasses("sonarr.internal"), "wildcard suffix");
        assert!(rules.bypasses("plex.example"), "exact host");
        assert!(!rules.bypasses("plex.example.com"), "exact host only");
        assert!(!rules.bypasses("10.0.0.1"), "local addresses off");
    }
}
