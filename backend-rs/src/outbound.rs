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
///
/// The URL reqwest prints after its own message is left out, as axios'
/// message leaves it out: `*arr` and Tautulli URLs carry the API key and
/// others carry tokens.
#[must_use]
pub fn describe(e: &reqwest::Error) -> String {
    if let Some(status) = e.status() {
        return format!("Request failed with status code {}", status.as_u16());
    }
    if e.is_timeout() {
        return String::from("The request timed out");
    }
    let mut message = e.to_string();
    if e.url().is_some() {
        if let Some(at) = message.find(" for url (") {
            message.truncate(at);
        }
    }
    let mut source = std::error::Error::source(e);
    while let Some(cause) = source {
        message.push_str(": ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    message
}

/// A failed call's error with the credentials taken out of its URL (see
/// [`redact_url`]), for calls whose URL carries a key or token, so the
/// error can go into an `anyhow` chain that is logged or answered.
#[must_use]
pub fn redact(mut e: reqwest::Error) -> reqwest::Error {
    if let Some(url) = e.url_mut() {
        strip_credentials(url);
    }
    e
}

/// `url` for messages: the scheme, host, port and path, without the
/// query (`apikey`, `token`), user info or fragment.
#[must_use]
pub fn redact_url(url: &str) -> String {
    reqwest::Url::parse(url).map_or_else(
        |_| String::from("(an invalid URL)"),
        |mut url| {
            strip_credentials(&mut url);
            url.to_string()
        },
    )
}

fn strip_credentials(url: &mut reqwest::Url) {
    url.set_query(None);
    url.set_fragment(None);
    // Both fail only for URLs that can't have user info at all.
    url.set_username("").ok();
    url.set_password(None).ok();
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
    fn urls_without_credentials() {
        assert_eq!(
            redact_url("http://user:pass@127.0.0.1:7878/radarr/api/v3/tag?apikey=secret#x"),
            "http://127.0.0.1:7878/radarr/api/v3/tag",
            "query, user info and fragment left out"
        );
        assert_eq!(redact_url("not a url"), "(an invalid URL)", "unparseable");
    }

    #[tokio::test]
    async fn described_failures_leave_the_url_out() -> Result<(), Box<dyn std::error::Error>> {
        let port = {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
            listener.local_addr()?.port()
        };
        let url = format!("http://u:p@127.0.0.1:{port}/api/v3/tag?apikey=secret-key");
        let e = reqwest::Client::new()
            .get(&url)
            .send()
            .await
            .err()
            .ok_or("nothing listens on the port")?;
        assert!(e.to_string().contains("secret-key"), "reqwest prints it");
        let described = describe(&e);
        assert!(!described.contains("secret-key"), "{described}");
        let redacted = redact(e);
        for text in [format!("{redacted}"), format!("{redacted:?}")] {
            assert!(!text.contains("secret-key"), "{text}");
            assert!(!text.contains("u:p@"), "{text}");
        }
        Ok(())
    }

    /// Answer every connection with `body`, sent with `encoding`, and
    /// report the `Accept-Encoding` each request came with.
    async fn compressing(
        encoding: &'static str,
        body: Vec<u8>,
    ) -> std::io::Result<(u16, tokio::sync::mpsc::UnboundedReceiver<String>)> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let (sent, received) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut request = vec![0_u8; 4096];
                let n = stream.read(&mut request).await.unwrap_or(0);
                let request = String::from_utf8_lossy(request.get(..n).unwrap_or_default());
                let accepted = request
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("accept-encoding:")
                            .map(|v| v.trim().to_owned())
                    })
                    .unwrap_or_default();
                sent.send(accepted).ok();
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Encoding: {encoding}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream.write_all(head.as_bytes()).await.ok();
                stream.write_all(&body).await.ok();
            }
        });
        Ok((port, received))
    }

    #[tokio::test]
    async fn decodes_compressed_answers() -> Result<(), Box<dyn std::error::Error>> {
        use std::io::Write;
        let json = br#"{"version":"4.0.0","appName":"Sonarr"}"#;
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(json)?;
        let mut deflate =
            flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        deflate.write_all(json)?;
        let settings = Settings::from_file_value(serde_json::json!({}), None)?;
        let version = AppVersion {
            version: String::from("0.0.0"),
            commit_tag: String::from("local"),
        };
        let client = client(&settings, &version, None)?;
        for (encoding, body) in [("gzip", gzip.finish()?), ("deflate", deflate.finish()?)] {
            let (port, mut accepted) = compressing(encoding, body).await?;
            let response = client
                .get(format!("http://127.0.0.1:{port}/api/v3/system/status"))
                .send()
                .await?;
            for stale in [
                reqwest::header::CONTENT_ENCODING,
                reqwest::header::CONTENT_LENGTH,
            ] {
                assert!(
                    response.headers().get(&stale).is_none(),
                    "{encoding}: no {stale} for the decoded body"
                );
            }
            let value: Value = response.json().await?;
            assert_eq!(
                value.get("appName"),
                Some(&Value::from("Sonarr")),
                "{encoding}"
            );
            let accepted = accepted.recv().await.unwrap_or_default();
            for offered in ["gzip", "deflate", "br"] {
                assert!(accepted.contains(offered), "{offered} offered: {accepted}");
            }
        }
        Ok(())
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
