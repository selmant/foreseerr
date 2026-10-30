//! `server/lib/downloadtracker.ts`: the download tracker.
//!
//! What each Radarr and Sonarr server is downloading, polled by `download-sync` and cleared by
//! `download-sync-reset`; `downloadStatus` is read from it.

use std::sync::{Arc, LazyLock, RwLock};

use serde_json::{Map, Value};

use super::JobCtx;
use crate::downloads::Downloads;
use crate::media::js_string;
use crate::routes::servarrsync::{poll_server, Service};
use crate::settings::public::truthy;
use crate::settings::Settings;
use crate::state::AppState;

/// `radarrServers` and `sonarrServers`: server id → `DownloadingItem`s.
#[derive(Debug, Default)]
struct Tracker {
    radarr: Map<String, Value>,
    sonarr: Map<String, Value>,
}

impl Tracker {
    const fn servers(&mut self, service: Service) -> &mut Map<String, Value> {
        match service {
            Service::Radarr => &mut self.radarr,
            Service::Sonarr => &mut self.sonarr,
        }
    }
}

static TRACKER: LazyLock<RwLock<Tracker>> = LazyLock::new(RwLock::default);

/// `snapshot()`: everything tracked now.
#[must_use]
pub fn snapshot() -> Downloads {
    let tracker = crate::sync::read(&TRACKER);
    Downloads::from_parts(
        Value::Object(tracker.radarr.clone()),
        Value::Object(tracker.sonarr.clone()),
    )
}

/// `download-sync-reset`: `resetDownloadTracker()`.
pub fn reset() {
    let mut tracker = crate::sync::write(&TRACKER);
    tracker.radarr.clear();
    tracker.sonarr.clear();
}

/// `download-sync`: `updateDownloads()`, Radarr and Sonarr at once.
///
/// # Errors
///
/// Only when settings.json can't be read; a server that fails is logged.
pub async fn update(job: &JobCtx) -> anyhow::Result<()> {
    let settings = job.current_settings().await?;
    tokio::join!(
        update_service(&job.state, &settings, Service::Radarr),
        update_service(&job.state, &settings, Service::Sonarr)
    );
    Ok(())
}

/// The servers are the same instance (`hostname`, `port` and `baseUrl`
/// strictly equal).
fn same_instance(a: &Value, b: &Value) -> bool {
    ["hostname", "port", "baseUrl"]
        .iter()
        .all(|key| a.get(key) == b.get(key))
}

/// `updateRadarrDownloads` / `updateSonarrDownloads`.
async fn update_service(state: &Arc<AppState>, settings: &Arc<Settings>, service: Service) {
    let all: Vec<Value> = settings
        .get(&format!("/{}", service.key()))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut filtered: Vec<&Value> = Vec::new();
    for server in all.iter().filter(|s| truthy(s.get("syncEnabled"))) {
        if !filtered.iter().any(|kept| same_instance(kept, server)) {
            filtered.push(server);
        }
    }
    let mut tasks = tokio::task::JoinSet::new();
    for server in filtered {
        let matching: Vec<Value> = all
            .iter()
            .filter(|other| {
                same_instance(other, server)
                    && other.get("id") != server.get("id")
                    && truthy(other.get("syncEnabled"))
            })
            .cloned()
            .collect();
        tasks.spawn(update_server(
            Arc::clone(state),
            Arc::clone(settings),
            service,
            server.clone(),
            matching,
        ));
    }
    while let Some(joined) = tasks.join_next().await {
        if let Err(e) = joined {
            tracing::error!(label = "Download Tracker", "a download poll failed: {e}");
        }
    }
}

/// One deduplicated server: poll, record its items, copy them to the
/// servers on the same instance.
async fn update_server(
    state: Arc<AppState>,
    settings: Arc<Settings>,
    service: Service,
    server: Value,
    matching: Vec<Value>,
) {
    let key = js_string(server.get("id")).into_owned();
    let name = js_string(server.get("name")).into_owned();
    match poll_server(&state, &settings, service, &server, &matching).await {
        Ok(queue) => {
            let items: Vec<Value> = queue
                .iter()
                .flat_map(|item| downloading_items(service, item))
                .collect();
            crate::sync::write(&TRACKER)
                .servers(service)
                .insert(key.clone(), Value::Array(items));
            if !queue.is_empty() {
                tracing::debug!(
                    label = "Download Tracker",
                    "Found {} item(s) in progress on {} server: {name}",
                    queue.len(),
                    service.api_name()
                );
            }
        }
        // Node logs no cause. Neither the Arr call's message
        // (`outbound::describe` leaves the URL out) nor a database
        // failure carries the API key.
        Err(e) => tracing::error!(
            label = "Download Tracker",
            errorMessage = %format!("{e:#}"),
            "Unable to get queue from {} server: {name}",
            service.api_name()
        ),
    }
    if !matching.is_empty() {
        tracing::debug!(
            label = "Download Tracker",
            "Matching download data to {} other {} server(s)",
            matching.len(),
            service.api_name()
        );
    }
    let mut tracker = crate::sync::write(&TRACKER);
    let servers = tracker.servers(service);
    let items = servers.get(&key).cloned();
    for other in &matching {
        let other_key = js_string(other.get("id")).into_owned();
        match &items {
            Some(items) => {
                servers.insert(other_key, items.clone());
            }
            None => {
                servers.shift_remove(&other_key);
            }
        }
    }
    drop(tracker);
}

/// `new Date(value)` as `JSON.stringify` prints it: ISO, or null when
/// invalid.
fn date_json(value: Option<&Value>) -> Value {
    let millis = match value {
        Some(Value::Null) => Some(0),
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::String(s)) => crate::clock::parse_date_millis(s),
        None | Some(Value::Bool(_) | Value::Array(_) | Value::Object(_)) => None,
    };
    millis.map_or(Value::Null, |ms| {
        Value::from(crate::clock::Utc::from_unix_millis(ms).iso_string())
    })
}

/// The `DownloadingItem`s of a queue record: one per episode for Sonarr,
/// which lists a multi-episode download once on v5 (Sonarr 4 listed it per
/// episode).
fn downloading_items(service: Service, item: &Value) -> Vec<Value> {
    let episodes = match service {
        Service::Radarr => Vec::new(),
        Service::Sonarr => crate::sonarrv5::queue_item_episodes(item),
    };
    if episodes.is_empty() {
        return vec![downloading_item(service, item)];
    }
    // The record without its episode list, copied once per episode.
    let mut base = item.clone();
    if let Some(o) = base.as_object_mut() {
        o.remove("episodes");
    }
    episodes
        .into_iter()
        .map(|episode| {
            let mut one = base.clone();
            if let Some(o) = one.as_object_mut() {
                o.insert(String::from("episode"), episode);
            }
            downloading_item(service, &one)
        })
        .collect()
}

/// The `DownloadingItem` of a queue record, keys in Node's order, absent
/// properties left out.
fn downloading_item(service: Service, item: &Value) -> Value {
    let mut out = Map::new();
    let copy = |to: &str, from: &str, out: &mut Map<String, Value>| {
        if let Some(v) = item.get(from) {
            out.insert(to.to_owned(), v.clone());
        }
    };
    copy("externalId", service.external_key(), &mut out);
    out.insert(
        String::from("estimatedCompletionTime"),
        date_json(item.get("estimatedCompletionTime")),
    );
    out.insert(
        String::from("mediaType"),
        Value::from(match service {
            Service::Radarr => "movie",
            Service::Sonarr => "tv",
        }),
    );
    copy("size", "size", &mut out);
    copy("sizeLeft", "sizeleft", &mut out);
    copy("status", "status", &mut out);
    copy("timeLeft", "timeleft", &mut out);
    copy("title", "title", &mut out);
    if service == Service::Sonarr {
        copy("episode", "episode", &mut out);
    }
    copy("downloadId", "downloadId", &mut out);
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_queue_records() {
        let movie = json!({
            "movieId": 12, "size": 100, "sizeleft": 40, "status": "downloading",
            "timeleft": "00:10:00", "title": "A", "downloadId": "x",
            "estimatedCompletionTime": "2026-10-11T12:00:00.1234567Z", "id": 5
        });
        assert_eq!(
            downloading_item(Service::Radarr, &movie),
            json!({
                "externalId": 12, "estimatedCompletionTime": "2026-10-11T12:00:00.123Z",
                "mediaType": "movie", "size": 100, "sizeLeft": 40, "status": "downloading",
                "timeLeft": "00:10:00", "title": "A", "downloadId": "x"
            }),
            "movie"
        );
        let episode = json!({"seriesId": 3, "title": "B", "episode": {"seasonNumber": 1}});
        let mapped = downloading_item(Service::Sonarr, &episode);
        assert_eq!(
            mapped
                .as_object()
                .map(|o| o.keys().cloned().collect::<Vec<_>>()),
            Some(vec![
                String::from("externalId"),
                String::from("estimatedCompletionTime"),
                String::from("mediaType"),
                String::from("title"),
                String::from("episode")
            ]),
            "series keys"
        );
        assert_eq!(
            mapped.get("estimatedCompletionTime"),
            Some(&Value::Null),
            "invalid date"
        );
        assert_eq!(
            date_json(Some(&Value::Null)),
            json!("1970-01-01T00:00:00.000Z"),
            "new Date(null)"
        );
    }

    #[test]
    fn expands_grouped_records() {
        let grouped = json!({
            "seriesId": 3, "title": "Pack", "episodeIds": [10, 11],
            "episodes": [
                {"id": 10, "seasonNumber": 1, "episodeNumber": 2},
                {"id": 11, "seasonNumber": 1, "episodeNumber": 3}
            ]
        });
        let items = downloading_items(Service::Sonarr, &grouped);
        assert_eq!(
            items
                .iter()
                .map(|i| i.pointer("/episode/episodeNumber").cloned())
                .collect::<Vec<_>>(),
            vec![Some(json!(2)), Some(json!(3))],
            "one item per episode of a v5 record"
        );
        let single = json!({"seriesId": 3, "title": "One", "episode": {"seasonNumber": 1}});
        assert_eq!(
            downloading_items(Service::Sonarr, &single).len(),
            1,
            "a v4 record"
        );
        let movie = json!({"movieId": 12, "title": "A"});
        assert_eq!(
            downloading_items(Service::Radarr, &movie).len(),
            1,
            "a movie"
        );
    }

    #[test]
    fn instances() {
        let a = json!({"hostname": "h", "port": 7878, "id": 1});
        let b = json!({"hostname": "h", "port": 7878, "id": 2});
        let c = json!({"hostname": "h", "port": 7878, "baseUrl": "", "id": 3});
        assert!(same_instance(&a, &b), "same");
        assert!(!same_instance(&a, &c), "undefined !== ''");
    }
}
