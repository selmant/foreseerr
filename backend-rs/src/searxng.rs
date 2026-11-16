//! `SearXNG`, the self-hosted metasearch engine, as the AI features' web
//! search.
//!
//! Its JSON API has to be enabled (`search.formats: [html, json]`
//! in its `settings.yml`); it has no authentication of its own, so it
//! should only be reachable from Foreseerr's network.

use std::time::Duration;

use serde_json::Value;

const TIMEOUT: Duration = Duration::from_secs(15);

/// One search result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    /// Page title.
    pub title: String,
    /// Page address.
    pub url: String,
    /// The engine's snippet.
    pub snippet: String,
}

/// Why a search failed, in words for the settings page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchError(pub String);

/// Check a `SearXNG` base URL: `http(s)`, a host, no credentials, query or
/// fragment. Returns it without a trailing slash.
///
/// # Errors
///
/// Explains what's wrong with it.
pub fn normalize_url(input: &str) -> Result<String, SearchError> {
    let trimmed = input.trim().trim_end_matches('/');
    let url = reqwest::Url::parse(trimmed).map_err(|_| {
        SearchError(String::from(
            "Enter the full SearXNG address, like http://searxng:8080.",
        ))
    })?;
    let ok = matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some_and(|h| !h.is_empty())
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none();
    if ok {
        Ok(trimmed.to_owned())
    } else {
        Err(SearchError(String::from(
            "The SearXNG address must be a plain http(s) URL without credentials or a query.",
        )))
    }
}

/// Search and return at most `limit` results.
///
/// # Errors
///
/// Fails when `SearXNG` can't be reached, refuses JSON, or rate-limits.
pub async fn search(
    client: &reqwest::Client,
    base_url: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<Hit>, SearchError> {
    let mut url = reqwest::Url::parse(&format!("{}/search", base_url.trim().trim_end_matches('/')))
        .map_err(|_| SearchError(String::from("The SearXNG URL isn't valid.")))?;
    url.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("format", "json")
        .append_pair("categories", "general")
        .append_pair("safesearch", "1");
    let res = client
        .get(url)
        .timeout(TIMEOUT)
        .send()
        .await
        .map_err(|_| SearchError(String::from("SearXNG couldn't be reached at this URL.")))?;
    match res.status().as_u16() {
        200..=299 => {}
        403 => {
            return Err(SearchError(String::from(
                "SearXNG refused JSON. Add json to search.formats in its settings.yml.",
            )))
        }
        429 => {
            return Err(SearchError(String::from(
                "SearXNG is rate-limiting. Turn its limiter off for a private instance (server.limiter: false).",
            )))
        }
        status => return Err(SearchError(format!("SearXNG returned an error ({status})."))),
    }
    let body: Value = res.json().await.map_err(|_| {
        SearchError(String::from(
            "SearXNG didn't return JSON. Is this the right URL?",
        ))
    })?;
    Ok(hits(&body, limit))
}

fn hits(body: &Value, limit: usize) -> Vec<Hit> {
    body.get("results")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|r| {
                    let text = |key: &str| r.get(key).and_then(Value::as_str).map(str::trim);
                    Some(Hit {
                        title: text("title").filter(|t| !t.is_empty())?.to_owned(),
                        url: text("url").filter(|u| u.starts_with("http"))?.to_owned(),
                        snippet: text("content").unwrap_or("").to_owned(),
                    })
                })
                .take(limit)
                .collect()
        })
        .unwrap_or_default()
}

/// Check an instance with a real query; the number of results.
///
/// # Errors
///
/// The search's failure.
pub async fn test(client: &reqwest::Client, base_url: &str) -> Result<usize, SearchError> {
    search(client, base_url, "Arrival 2016 film", 10)
        .await
        .map(|h| h.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_results() {
        let body = json!({"results": [
            {"title": "Arrival (film)", "url": "https://en.wikipedia.org/wiki/Arrival_(film)", "content": "2016 film"},
            {"title": "", "url": "https://x"},
            {"title": "No url"},
            {"title": "Second", "url": "https://b", "content": " s "}
        ]});
        let got = hits(&body, 10);
        assert_eq!(got.len(), 2, "incomplete results dropped");
        assert_eq!(
            got.first().map(|h| h.snippet.as_str()),
            Some("2016 film"),
            "snippet"
        );
        assert_eq!(hits(&body, 1).len(), 1, "limit");
    }
}
