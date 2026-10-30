//! The Radarr and Sonarr reads ported so far, through `ServarrBase`'s
//! client: `apikey` as a query parameter and `ExternalAPI`'s response
//! cache, including `getRolling`'s background refresh.
//!
//! A Sonarr that offers API v5 is talked to through it (see `sonarrv5`).

use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::Value;

use crate::media::js_string;
use crate::memcache::{self, CacheId};
use crate::outbound;
use crate::settings::public::truthy;
use crate::sonarrv5::{self, ApiVersion};
use crate::tmdb::axios_encode;

/// `getProfiles`, `getRootFolders` and `getLanguageProfiles` cache for an
/// hour.
const PROFILES_TTL: Duration = Duration::from_secs(3600);
/// `DEFAULT_ROLLING_BUFFER`: a cached answer older than this is refreshed in
/// the background while it is served.
const ROLLING_BUFFER: Duration = Duration::from_secs(10);

/// A client shared by every Radarr and Sonarr server, over the shared
/// `radarr` and `sonarr` caches keyed by URL.
#[derive(Debug, Clone)]
pub struct ServarrClient {
    client: reqwest::Client,
    /// Every server is a Sonarr: for the Sonarr settings test, whose body
    /// carries none of Sonarr's settings keys.
    sonarr: bool,
}

/// The cache a server's client uses: `sonarr` for a server with Sonarr's
/// settings, `radarr` otherwise.
fn cache_for(server: &Value) -> CacheId {
    let sonarr = ["seriesType", "animeSeriesType", "enableSeasonFolders"]
        .iter()
        .any(|k| server.get(*k).is_some());
    if sonarr {
        CacheId::Sonarr
    } else {
        CacheId::Radarr
    }
}

impl ServarrClient {
    /// A client over the outgoing HTTP client (proxy and CA settings apply).
    #[must_use]
    pub const fn new(client: reqwest::Client) -> Self {
        Self {
            client,
            sonarr: false,
        }
    }

    /// This client for servers known to be Sonarr.
    #[must_use]
    pub fn for_sonarr(&self) -> Self {
        Self {
            client: self.client.clone(),
            sonarr: true,
        }
    }

    /// The API a server is talked to through: v5 for a Sonarr that offers
    /// it, v3 otherwise.
    async fn api(&self, server: &Value, timeout: Option<Duration>) -> ApiVersion {
        if !self.sonarr && cache_for(server) != CacheId::Sonarr {
            return ApiVersion::V3;
        }
        let api_key = match server.get("apiKey") {
            None | Some(Value::Null) => None,
            other => Some(js_string(other)),
        };
        sonarrv5::api_version(
            &self.client,
            &build_url(server, ""),
            api_key.as_deref(),
            timeout,
        )
        .await
    }

    /// `getProfiles`: the server's quality profiles, through `getRolling`
    /// with its hour-long cache. `timeout` is `network.apiRequestTimeout`.
    ///
    /// # Errors
    ///
    /// Fails when the server can't be reached or doesn't answer JSON, as
    /// the callers' `.catch(() => undefined)` expects.
    pub async fn profiles(&self, server: &Value, timeout: Option<Duration>) -> Result<Vec<Value>> {
        self.get_rolling(server, "/qualityProfile", timeout)
            .await
            .map(as_array)
    }

    /// `getRootFolders`, cached for an hour like the profiles.
    ///
    /// # Errors
    ///
    /// Fails when the server can't be reached or doesn't answer JSON.
    pub async fn root_folders(
        &self,
        server: &Value,
        timeout: Option<Duration>,
    ) -> Result<Vec<Value>> {
        self.get_rolling(server, "/rootfolder", timeout)
            .await
            .map(as_array)
    }

    /// Sonarr's `getLanguageProfiles`, cached for an hour.
    ///
    /// # Errors
    ///
    /// Fails when the server can't be reached or doesn't answer JSON.
    pub async fn language_profiles(
        &self,
        server: &Value,
        timeout: Option<Duration>,
    ) -> Result<Vec<Value>> {
        self.get_rolling(server, "/languageprofile", timeout)
            .await
            .map(as_array)
    }

    /// `getTags`: not cached.
    ///
    /// # Errors
    ///
    /// Fails when the server can't be reached or doesn't answer JSON.
    pub async fn tags(&self, server: &Value, timeout: Option<Duration>) -> Result<Value> {
        let api = self.api(server, timeout).await.prefix();
        self.fetch(
            &with_api_key(&build_url(server, &format!("{api}/tag")), server),
            timeout,
        )
        .await
    }

    /// `getSystemStatus`: not cached.
    ///
    /// # Errors
    ///
    /// Fails when the server can't be reached or doesn't answer JSON.
    pub async fn system_status(&self, server: &Value, timeout: Option<Duration>) -> Result<Value> {
        let api = self.api(server, timeout).await.prefix();
        self.fetch(
            &with_api_key(&build_url(server, &format!("{api}/system/status")), server),
            timeout,
        )
        .await
    }

    /// `getRolling` with an hour's TTL: a fresh cached answer is returned
    /// as is; one older than ten seconds is also refreshed in the
    /// background; an expired or missing one is fetched first.
    ///
    /// # Errors
    ///
    /// Fails when the server can't be reached or doesn't answer JSON.
    pub async fn get_rolling(
        &self,
        server: &Value,
        endpoint: &str,
        timeout: Option<Duration>,
    ) -> Result<Value> {
        let api = self.api(server, timeout).await.prefix();
        let base = build_url(server, &format!("{api}{endpoint}"));
        let url = with_api_key(&base, server);
        // Keyed by the URL without the API key.
        let key = base.clone();
        let cache = cache_for(server);
        if let Some(value) = memcache::get(cache, &key).filter(|v| truthy(Some(v))) {
            // `getTtl(key) - ttl` is when the answer was stored.
            let stale = memcache::expires_at(cache, &key)
                .and_then(|expires| expires.checked_sub(PROFILES_TTL))
                .is_none_or(|stored| stored.elapsed() > ROLLING_BUFFER);
            if stale {
                let refresh = self.clone();
                let url = url.clone();
                tokio::spawn(async move {
                    if let Ok(value) = refresh.fetch(&url, timeout).await {
                        memcache::set(cache, key, value, PROFILES_TTL);
                    }
                });
            }
            return Ok(std::sync::Arc::unwrap_or_clone(value));
        }
        let value = self.fetch(&url, timeout).await?;
        memcache::set(cache, key, value.clone(), PROFILES_TTL);
        Ok(value)
    }

    /// One call to `/api/v3{path}` with `apikey` and `query` (axios order),
    /// an optional JSON body, and the server's timeout; translated to
    /// `/api/v5` for a Sonarr that offers it.
    ///
    /// # Errors
    ///
    /// Fails when the server can't be reached or answers an error status.
    pub async fn call(
        &self,
        server: &Value,
        method: reqwest::Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<&Value>,
        timeout: Option<Duration>,
    ) -> Result<Value> {
        let api = self.api(server, timeout).await;
        let query: Vec<(String, String)> = query
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect();
        let (query, body) = match api {
            ApiVersion::V3 => (query, body.cloned()),
            ApiVersion::V5 => sonarrv5::to_v5_request(method.as_str(), path, query, body.cloned()),
        };
        let mut url = with_api_key(
            &build_url(server, &format!("{}{path}", api.prefix())),
            server,
        );
        for (k, v) in &query {
            url.push(if url.contains('?') { '&' } else { '?' });
            url.push_str(k);
            url.push('=');
            url.push_str(&axios_encode(v));
        }
        let mut request = self
            .client
            .request(method.clone(), &url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CONTENT_TYPE, "application/json");
        if let Some(timeout) = timeout {
            request = request.timeout(timeout);
        }
        if let Some(body) = &body {
            request = request.body(body.to_string());
        }
        let response = request
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(outbound::redact)
            .with_context(|| format!("{method} {path}"))?;
        let bytes = response
            .bytes()
            .await
            .map_err(outbound::redact)
            .with_context(|| format!("{method} {path}"))?;
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        let value = crate::tmdb::js_numbers(value);
        Ok(match api {
            ApiVersion::V3 => value,
            ApiVersion::V5 => sonarrv5::from_v5_response(method.as_str(), path, value),
        })
    }

    async fn fetch(&self, url: &str, timeout: Option<Duration>) -> Result<Value> {
        let mut request = self
            .client
            .get(url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CONTENT_TYPE, "application/json");
        if let Some(timeout) = timeout {
            request = request.timeout(timeout);
        }
        // The URL carries the API key.
        let value = request
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(outbound::redact)
            .with_context(|| format!("GET {}", outbound::redact_url(url)))?
            .bytes()
            .await
            .map_err(outbound::redact)
            .with_context(|| format!("GET {}", outbound::redact_url(url)))
            .map(|bytes| axios_data(&bytes))?;
        Ok(value)
    }
}

/// axios's `transformResponse`: the parsed JSON, or the text as it came
/// (empty included) where it isn't JSON.
fn axios_data(bytes: &[u8]) -> Value {
    if bytes.is_empty() {
        return Value::from("");
    }
    serde_json::from_slice::<Value>(bytes).map_or_else(
        |_| Value::from(String::from_utf8_lossy(bytes).into_owned()),
        crate::tmdb::js_numbers,
    )
}

/// `ServarrBase.buildUrl`: scheme, host, port and base URL from a server's
/// settings, printed as the template literal does.
#[must_use]
pub fn build_url(server: &Value, path: &str) -> String {
    let scheme = if truthy(server.get("useSsl")) {
        "https"
    } else {
        "http"
    };
    let base_url = match server.get("baseUrl") {
        None | Some(Value::Null) => std::borrow::Cow::Borrowed(""),
        other => js_string(other),
    };
    format!(
        "{scheme}://{}:{}{base_url}{path}",
        js_string(server.get("hostname")),
        js_string(server.get("port"))
    )
}

/// The `apikey` parameter axios appends from the client's defaults; left
/// out when the setting is missing or null, as axios drops those.
fn with_api_key(url: &str, server: &Value) -> String {
    match server.get("apiKey") {
        None | Some(Value::Null) => url.to_owned(),
        other => format!("{url}?apikey={}", axios_encode(&js_string(other))),
    }
}

/// `network.apiRequestTimeout` in milliseconds, or none when it isn't a
/// positive number (axios then waits forever).
#[must_use]
pub fn api_timeout(settings: &crate::settings::Settings) -> Option<Duration> {
    settings
        .get("/network/apiRequestTimeout")
        .and_then(Value::as_u64)
        .filter(|ms| *ms > 0)
        .map(Duration::from_millis)
}

fn as_array(value: Value) -> Vec<Value> {
    match value {
        Value::Array(items) => items,
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) | Value::Object(_) => {
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn urls() {
        let server = json!({"hostname": "127.0.0.1", "port": 7878, "useSsl": false, "baseUrl": "/radarr", "apiKey": "k=1"});
        assert_eq!(
            with_api_key(&build_url(&server, "/api/v3/qualityProfile"), &server),
            "http://127.0.0.1:7878/radarr/api/v3/qualityProfile?apikey=k%3D1",
            "base url and encoded key"
        );
        let bare = json!({"hostname": "h", "port": 443, "useSsl": true});
        assert_eq!(
            with_api_key(&build_url(&bare, "/api/v3"), &bare),
            "https://h:443/api/v3",
            "no baseUrl, no key"
        );
    }
}
