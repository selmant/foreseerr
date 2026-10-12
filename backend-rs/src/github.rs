//! `server/api/github.ts`: the update check against the GitHub API, with
//! the same five minute response cache as `ExternalAPI.get`.

use std::time::Duration;

use serde_json::Value;

use crate::memcache::{self, CacheId};

const BASE_URL: &str = "https://api.github.com";
const REPO: &str = "selmant/foreseerr";
/// `DEFAULT_TTL` in `ExternalAPI`.
const CACHE_TTL: Duration = Duration::from_secs(300);

/// A GitHub client over the shared `github` response cache.
#[derive(Debug)]
pub struct GithubApi {
    client: reqwest::Client,
}

impl GithubApi {
    /// A client that sends through `client`.
    #[must_use]
    pub const fn new(client: reqwest::Client) -> Self {
        Self { client }
    }

    /// `getSeerrReleases`: the latest releases whose tag looks like `vX`,
    /// or nothing when GitHub can't be reached.
    pub async fn releases(&self) -> Vec<Value> {
        let path = format!("/repos/{REPO}/releases");
        match self.get(&path, "per_page=20").await {
            Ok(Value::Array(items)) => items.into_iter().filter(is_app_release).collect(),
            Ok(_) => Vec::new(),
            Err(e) => {
                tracing::warn!(
                    "Failed to retrieve GitHub releases. This may be an issue on GitHub's end. Foreseerr can't check if it's on the latest version. {e}"
                );
                Vec::new()
            }
        }
    }

    /// `getSeerrCommits`: the latest commits on `develop`, or nothing when
    /// GitHub can't be reached.
    pub async fn commits(&self) -> Vec<Value> {
        let path = format!("/repos/{REPO}/commits");
        match self.get(&path, "per_page=20&branch=develop").await {
            Ok(Value::Array(items)) => items,
            Ok(_) => Vec::new(),
            Err(e) => {
                tracing::warn!(
                    "Failed to retrieve GitHub commits. This may be an issue on GitHub's end. Foreseerr can't check if it's on the latest version. {e}"
                );
                Vec::new()
            }
        }
    }

    /// `query` is already encoded; it only ever holds fixed values here.
    async fn get(&self, path: &str, query: &str) -> reqwest::Result<Value> {
        // The request URL is the cache key.
        let url = format!("{BASE_URL}{path}?{query}");
        if let Some(value) = memcache::get(CacheId::Github, &url) {
            return Ok(value);
        }
        let value: Value = self
            .client
            .get(&url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        memcache::set(CacheId::Github, url, value.clone(), CACHE_TTL);
        Ok(value)
    }
}

/// `isAppRelease`: tags like `v1.2.3`, not the `jellyfin-plugin-v*` ones.
fn is_app_release(release: &Value) -> bool {
    release
        .get("tag_name")
        .and_then(Value::as_str)
        .and_then(|t| t.strip_prefix('v'))
        .is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_releases() {
        let tag = |t: &str| serde_json::json!({ "tag_name": t });
        assert!(is_app_release(&tag("v0.13.1")), "app tag");
        assert!(!is_app_release(&tag("jellyfin-plugin-v1.0")), "plugin tag");
        assert!(!is_app_release(&tag("vnext")), "needs a digit");
        assert!(!is_app_release(&serde_json::json!({})), "no tag");
    }
}
