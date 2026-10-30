//! The download tracker as `downloadStatus` reads it, so it can be
//! serialised exactly as Node did.

use serde_json::Value;

/// One read of the tracker: `radarr` and `sonarr` maps from server id to
/// the items being downloaded.
#[derive(Debug, Clone, Default)]
pub struct Downloads {
    radarr: Value,
    sonarr: Value,
}

impl Downloads {
    /// The tracker as the download sync job left it.
    #[must_use]
    pub fn current() -> Self {
        crate::jobs::downloadtracker::snapshot()
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
