//! Node's in-memory download tracker, read over the internal route so
//! `downloadStatus` can be serialised exactly as Node would.

use anyhow::{Context, Result};
use serde_json::Value;

/// One fetch of the tracker: `radarr` and `sonarr` maps from server id to
/// the items being downloaded.
#[derive(Debug, Clone, Default)]
pub struct Downloads {
    radarr: Value,
    sonarr: Value,
}

impl Downloads {
    /// Fetch the tracker from Node with the API key.
    ///
    /// # Errors
    ///
    /// Fails when Node can't be reached, refuses the key or answers
    /// something that isn't the expected JSON.
    pub async fn fetch(client: &reqwest::Client, node_url: &str, api_key: &str) -> Result<Self> {
        if crate::jobs::scheduler::rust_jobs() {
            return Ok(crate::jobs::downloadtracker::snapshot());
        }
        let mut body: Value = client
            .get(format!(
                "{}/internal/downloads",
                node_url.trim_end_matches('/')
            ))
            .header("X-API-Key", api_key)
            .send()
            .await
            .context("asking Node for the download tracker")?
            .error_for_status()
            .context("Node refused the download tracker request")?
            .json()
            .await
            .context("the download tracker answer is not JSON")?;
        Ok(Self {
            radarr: body.get_mut("radarr").map(Value::take).unwrap_or_default(),
            sonarr: body.get_mut("sonarr").map(Value::take).unwrap_or_default(),
        })
    }

    /// A tracker from its `radarr` and `sonarr` maps.
    #[must_use]
    pub const fn from_parts(radarr: Value, sonarr: Value) -> Self {
        Self { radarr, sonarr }
    }

    /// `getMovieProgress` / `getSeriesProgress`: the items for one external
    /// id on one server, in tracker order; empty when the server is unknown.
    #[must_use]
    pub fn progress(&self, tv: bool, service_id: i64, external_service_id: i64) -> Vec<Value> {
        let servers = if tv { &self.sonarr } else { &self.radarr };
        servers
            .get(service_id.to_string())
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter(|item| {
                        item.get("externalId").and_then(Value::as_i64) == Some(external_service_id)
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn filters_by_server_and_external_id() {
        let d = Downloads {
            radarr: json!({"1": [{"externalId": 7, "title": "a"}, {"externalId": 8, "title": "b"}]}),
            sonarr: json!({}),
        };
        assert_eq!(
            d.progress(false, 1, 7),
            vec![json!({"externalId": 7, "title": "a"})],
            "match"
        );
        assert!(d.progress(false, 2, 7).is_empty(), "unknown server");
        assert!(d.progress(true, 1, 7).is_empty(), "wrong kind");
    }
}
