//! `server/api/servarr/sonarrV5.ts`: Sonarr's API v5.
//!
//! Sonarr 5 serves API v5 next to a deprecated v3. The Sonarr calls keep
//! being built for v3 and read as v3; these helpers detect which API a
//! server offers and translate the calls whose v5 shape differs.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

/// The Sonarr API a server is talked to through.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiVersion {
    V3,
    V5,
}

impl ApiVersion {
    /// The path prefix of the API.
    #[must_use]
    pub const fn prefix(self) -> &'static str {
        match self {
            Self::V3 => "/api/v3",
            Self::V5 => "/api/v5",
        }
    }
}

/// `API_VERSION_TTL_MS`: how long a detected version is trusted.
const API_VERSION_TTL: Duration = Duration::from_secs(600);
/// `API_VERSION_RETRY_MS`: how long the v3 fallback is kept after
/// `GET /api` failed.
const API_VERSION_RETRY: Duration = Duration::from_secs(60);
/// The longest `GET /api` may take, whatever `apiRequestTimeout` says:
/// every request to the server waits for it.
const API_VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// Server root URL → (expiry, version).
static API_VERSIONS: LazyLock<Mutex<HashMap<String, (Instant, ApiVersion)>>> =
    LazyLock::new(Mutex::default);

/// Server root URL → the lock its `GET /api` runs under: callers arriving
/// meanwhile wait for that answer instead of asking again, as they share
/// the pending promise in Node.
static PROBES: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(Mutex::default);

/// `apiVersionFromInfo`: v5 whenever Sonarr's `GET /api` answer (e.g.
/// `{"current": "v5", "deprecated": ["v3"]}`) offers it.
#[must_use]
pub fn api_version_from_info(info: &Value) -> ApiVersion {
    let offers = |v: &Value| v.as_str() == Some("v5");
    let current = info.get("current").is_some_and(offers);
    let deprecated = info
        .get("deprecated")
        .and_then(Value::as_array)
        .is_some_and(|list| list.iter().any(offers));
    if current || deprecated {
        ApiVersion::V5
    } else {
        ApiVersion::V3
    }
}

/// `cachedApiVersion`: the API of the Sonarr at `root`.
///
/// `root` is the scheme, host, port and base URL. The server is asked once
/// with `GET {root}/api` and the answer shared by every caller; a failed
/// answer falls back to v3 and is asked again after a minute.
pub async fn api_version(
    client: &reqwest::Client,
    root: &str,
    api_key: Option<&str>,
    timeout: Option<Duration>,
) -> ApiVersion {
    if let Some(version) = cached(root) {
        return version;
    }
    let probe = Arc::clone(
        crate::sync::lock(&PROBES)
            .entry(root.to_owned())
            .or_default(),
    );
    let _probing = probe.lock().await;
    if let Some(version) = cached(root) {
        release_probe(root, &probe);
        return version;
    }
    let mut url = format!("{root}/api");
    if let Some(key) = api_key {
        url.push_str("?apikey=");
        url.push_str(&crate::tmdb::axios_encode(key));
    }
    let request = client
        .get(&url)
        .header(reqwest::header::ACCEPT, "application/json")
        .timeout(timeout.map_or(API_VERSION_PROBE_TIMEOUT, |t| {
            t.min(API_VERSION_PROBE_TIMEOUT)
        }));
    let answer = match request
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
    {
        Ok(response) => response.json::<Value>().await.ok(),
        Err(_) => None,
    };
    // An answer without the version fields (a proxy's error page served
    // with 200, say) is a failed probe, not a v3 server.
    let (version, ttl) = match answer {
        Some(info) if info.get("current").is_some() || info.get("deprecated").is_some() => {
            (api_version_from_info(&info), API_VERSION_TTL)
        }
        Some(_) | None => (ApiVersion::V3, API_VERSION_RETRY),
    };
    let now = Instant::now();
    {
        let mut versions = crate::sync::lock(&API_VERSIONS);
        versions.retain(|_, (expires, _)| *expires > now);
        versions.insert(root.to_owned(), (now + ttl, version));
    }
    release_probe(root, &probe);
    version
}

/// Callers from now on find the answer cached, so the last one through the
/// probe lock drops it (only the map's reference and the caller's left).
fn release_probe(root: &str, probe: &Arc<tokio::sync::Mutex<()>>) {
    let mut probes = crate::sync::lock(&PROBES);
    if probes
        .get(root)
        .is_some_and(|held| Arc::ptr_eq(held, probe) && Arc::strong_count(held) == 2)
    {
        probes.remove(root);
    }
}

fn cached(root: &str) -> Option<ApiVersion> {
    crate::sync::lock(&API_VERSIONS)
        .get(root)
        .filter(|(expires, _)| *expires > Instant::now())
        .map(|(_, version)| *version)
}

/// A query as the clients build it.
pub type Query = Vec<(String, String)>;

/// `toV5Request`: the query and body v5 expects for a v3 call.
#[must_use]
pub fn to_v5_request(
    method: &str,
    path: &str,
    query: Query,
    body: Option<Value>,
) -> (Query, Option<Value>) {
    let verb = method.to_ascii_lowercase();
    let take = |query: &mut Query, key: &str| -> Option<String> {
        let at = query.iter().position(|(k, _)| k == key)?;
        Some(query.remove(at).1)
    };
    let mut query = query;
    match (verb.as_str(), path) {
        ("get", "/queue") => {
            let include_episode = take(&mut query, "includeEpisode").is_some_and(|v| v == "true");
            if !query.iter().any(|(k, _)| k == "includeUnknownSeriesItems") {
                query.insert(
                    0,
                    (
                        String::from("includeUnknownSeriesItems"),
                        String::from("false"),
                    ),
                );
            }
            if include_episode {
                query.push((
                    String::from("includeSubresources"),
                    String::from("episodes"),
                ));
            }
            (query, body)
        }
        ("delete", _) if is_queue_item(path) => {
            let flag = |query: &mut Query, key: &str, default: bool| {
                take(query, key).map_or(default, |v| v == "true")
            };
            let remove_from_client = flag(&mut query, "removeFromClient", true);
            let blocklist = flag(&mut query, "blocklist", false);
            let skip_redownload = flag(&mut query, "skipRedownload", false);
            let change_category = flag(&mut query, "changeCategory", false);
            let removal = if change_category {
                "changeCategory"
            } else if remove_from_client {
                "removeFromClient"
            } else {
                "ignore"
            };
            let blocklist = match (blocklist, skip_redownload) {
                (false, _) => "doNotBlocklist",
                (true, true) => "blocklistOnly",
                (true, false) => "blocklistAndSearch",
            };
            query.push((String::from("removalMethod"), String::from(removal)));
            query.push((String::from("blocklistMethod"), String::from(blocklist)));
            (query, body)
        }
        ("get", "/calendar") => {
            if let Some(unmonitored) = take(&mut query, "unmonitored") {
                query.push((String::from("includeUnmonitored"), unmonitored));
            }
            query.push((String::from("includeSubresources"), String::from("series")));
            (query, body)
        }
        ("get", "/manualimport") => {
            if let Some(id) = take(&mut query, "downloadId") {
                query.push((String::from("downloadIds"), id));
            }
            (query, body)
        }
        // v5 reads rejections back as typed reasons; the v3-shaped ones
        // `from_v5_response` built would not parse, and Sonarr recomputes
        // them anyway.
        ("post", "/manualimport") => {
            let body = body.map(|body| match body {
                Value::Array(items) => Value::Array(
                    items
                        .into_iter()
                        .map(|mut item| {
                            if let Some(item) = item.as_object_mut() {
                                item.shift_remove("rejections");
                            }
                            item
                        })
                        .collect(),
                ),
                other @ (Value::Null
                | Value::Bool(_)
                | Value::Number(_)
                | Value::String(_)
                | Value::Object(_)) => other,
            });
            (query, body)
        }
        ("post", "/release") => (query, body.map(|body| to_v5_release_grab(&body))),
        _ => (query, body),
    }
}

fn is_queue_item(path: &str) -> bool {
    path.strip_prefix("/queue/")
        .is_some_and(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
}

/// `fromV5Response`: a v5 answer reshaped to the v3 fields the callers
/// read.
#[must_use]
pub fn from_v5_response(method: &str, path: &str, data: Value) -> Value {
    let verb = method.to_ascii_lowercase();
    match (verb.as_str(), path, data) {
        ("get", "/queue", Value::Object(mut page)) => {
            if let Some(Value::Array(records)) = page.get_mut("records") {
                for record in records.iter_mut() {
                    to_v3_queue_item(record);
                }
            }
            Value::Object(page)
        }
        ("get", "/queue/details", Value::Array(mut records)) => {
            records.iter_mut().for_each(to_v3_queue_item);
            Value::Array(records)
        }
        ("get", "/release", Value::Array(releases)) => {
            Value::Array(releases.into_iter().map(to_v3_release).collect())
        }
        ("get" | "post", "/manualimport", Value::Array(mut candidates)) => {
            candidates.iter_mut().for_each(to_v3_import_candidate);
            Value::Array(candidates)
        }
        (_, _, data) => data,
    }
}

/// v5 lists one queue entry per download with all of its episodes; v3
/// names the first one in `episodeId`/`episode` and spells two fields
/// differently.
fn to_v3_queue_item(item: &mut Value) {
    let Some(item) = item.as_object_mut() else {
        return;
    };
    let first = |key: &str| {
        item.get(key)
            .and_then(Value::as_array)
            .and_then(|list| list.first())
            .cloned()
    };
    let episode_id = first("episodeIds");
    let episode = first("episodes");
    let size_left = item.get("sizeLeft").cloned();
    let time_left = item.get("timeLeft").cloned();
    if let Some(v) = size_left {
        item.insert(String::from("sizeleft"), v);
    }
    if let Some(v) = time_left {
        item.insert(String::from("timeleft"), v);
    }
    if let Some(v) = episode_id {
        item.insert(String::from("episodeId"), v);
    }
    if let Some(v) = episode {
        item.insert(String::from("episode"), v);
    }
}

/// A typed v5 rejection (`{ message, reason, type }`) as Foreseerr passes
/// it on: `{ message, code, type }`, `code` being Sonarr's reason (e.g.
/// `blocklisted`). Fields that aren't text are left out.
fn rejection_detail(rejection: &Value) -> Option<Value> {
    let r = rejection.as_object()?;
    let text = |key: &str| r.get(key).and_then(Value::as_str).map(Value::from);
    let message = text("message").or_else(|| text("reason"))?;
    let mut out = Map::new();
    out.insert(String::from("message"), message);
    if let Some(code) = text("reason") {
        out.insert(String::from("code"), code);
    }
    if let Some(kind) = text("type") {
        out.insert(String::from("type"), kind);
    }
    Some(Value::Object(out))
}

/// The `code` of a typed rejection Foreseerr passes on.
#[must_use]
pub fn rejection_code(detail: &Value) -> Option<&str> {
    detail.get("code").and_then(Value::as_str)
}

/// v5 nests a release in `release`, `parsedInfo` and `decision`.
///
/// The rejections stay v3's list of messages; next to them,
/// `rejectionDetails` keeps v5's typed reasons, and `multiSeason` marks a
/// pack of several seasons, which Sonarr 5 won't import automatically.
/// v5's `history` (when it grabbed the release before, and whether that
/// download failed) is kept as it is.
fn to_v3_release(item: Value) -> Value {
    let Value::Object(mut item) = item else {
        return item;
    };
    let take = |item: &mut Map<String, Value>, key: &str| match item.shift_remove(key) {
        Some(Value::Object(o)) => o,
        _ => Map::new(),
    };
    let release = take(&mut item, "release");
    let parsed = take(&mut item, "parsedInfo");
    let decision = take(&mut item, "decision");
    let mut out = item;
    out.extend(release);
    let parsed_field = |key: &str| parsed.get(key).cloned().unwrap_or(Value::Null);
    let season_numbers = parsed
        .get("seasonNumbers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let several_seasons = season_numbers.len() > 1;
    out.insert(String::from("quality"), parsed_field("quality"));
    out.insert(String::from("releaseGroup"), parsed_field("releaseGroup"));
    out.insert(String::from("releaseHash"), parsed_field("releaseHash"));
    out.insert(
        String::from("fullSeason"),
        parsed
            .get("fullSeason")
            .cloned()
            .unwrap_or(Value::Bool(false)),
    );
    out.insert(
        String::from("seasonNumber"),
        season_numbers.first().cloned().unwrap_or(Value::Null),
    );
    out.insert(String::from("seasonNumbers"), Value::Array(season_numbers));
    out.insert(String::from("seriesTitle"), parsed_field("seriesTitle"));
    out.insert(
        String::from("episodeNumbers"),
        parsed_field("episodeNumbers"),
    );
    out.insert(
        String::from("absoluteEpisodeNumbers"),
        parsed_field("absoluteEpisodeNumbers"),
    );
    out.insert(String::from("airDate"), parsed_field("airDate"));
    for key in ["approved", "rejected", "temporarilyRejected"] {
        out.insert(
            key.to_owned(),
            decision.get(key).cloned().unwrap_or(Value::Bool(false)),
        );
    }
    let listed = decision
        .get("rejections")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let rejections = listed
        .iter()
        .map(|r| r.get("message").cloned().unwrap_or_else(|| r.clone()))
        .collect();
    let details: Vec<Value> = listed.iter().filter_map(rejection_detail).collect();
    let multi_season = several_seasons
        || details
            .iter()
            .any(|d| rejection_code(d) == Some(MULTI_SEASON));
    out.insert(String::from("rejections"), Value::Array(rejections));
    if !details.is_empty() {
        out.insert(String::from("rejectionDetails"), Value::Array(details));
    }
    if multi_season {
        out.insert(String::from("multiSeason"), Value::Bool(true));
    }
    // Absent fields stay absent, as `undefined` does in the Node answer.
    out.retain(|_, v| !v.is_null());
    Value::Object(out)
}

/// The rejection reason of a multi-season release or download.
pub const MULTI_SEASON: &str = "multiSeason";

/// v5 rejections carry a reason code and the text in `message`.
fn to_v3_import_candidate(item: &mut Value) {
    let Some(Value::Array(rejections)) = item.get_mut("rejections") else {
        return;
    };
    for rejection in rejections.iter_mut() {
        let Some(r) = rejection.as_object() else {
            continue;
        };
        let reason = r
            .get("message")
            .or_else(|| r.get("reason"))
            .cloned()
            .unwrap_or(Value::Null);
        let mut v3 = Map::new();
        v3.insert(String::from("reason"), reason);
        if let Some(kind) = r.get("type") {
            v3.insert(String::from("type"), kind.clone());
        }
        *rejection = Value::Object(v3);
    }
}

/// v3 puts the series/episode hint and the override on the grab itself;
/// v5 splits them into `searchInfo` and `override`.
fn to_v5_release_grab(body: &Value) -> Value {
    let field = |key: &str| body.get(key).filter(|v| !v.is_null()).cloned();
    let mut grab = Map::new();
    for key in ["guid", "indexerId"] {
        if let Some(v) = field(key) {
            grab.insert(key.to_owned(), v);
        }
    }
    let series_id = field("seriesId");
    let episode_id = field("episodeId");
    if series_id.is_some() || episode_id.is_some() {
        let mut info = Map::new();
        if let Some(v) = &series_id {
            info.insert(String::from("seriesId"), v.clone());
        }
        if let Some(v) = &episode_id {
            info.insert(String::from("episodeId"), v.clone());
        }
        grab.insert(String::from("searchInfo"), Value::Object(info));
    }
    if crate::settings::public::truthy(body.get("shouldOverride")) {
        let episode_ids = match field("episodeIds") {
            Some(Value::Array(ids)) if !ids.is_empty() => ids,
            _ => episode_id.into_iter().collect(),
        };
        let mut over = Map::new();
        if let Some(v) = series_id {
            over.insert(String::from("seriesId"), v);
        }
        over.insert(String::from("episodeIds"), Value::Array(episode_ids));
        if let Some(v) = field("quality") {
            over.insert(String::from("quality"), v);
        }
        over.insert(
            String::from("languages"),
            field("languages").unwrap_or_else(|| Value::Array(Vec::new())),
        );
        if let Some(v) = field("downloadClientId") {
            over.insert(String::from("downloadClientId"), v);
        }
        grab.insert(String::from("override"), Value::Object(over));
    }
    Value::Object(grab)
}

/// `queueItemEpisodes`: the episodes a queue entry downloads, one on v3,
/// all of them on v5.
#[must_use]
pub fn queue_item_episodes(item: &Value) -> Vec<Value> {
    match item.get("episodes").and_then(Value::as_array) {
        Some(list) if !list.is_empty() => list.clone(),
        _ => item
            .get("episode")
            .filter(|e| crate::settings::public::truthy(Some(e)))
            .cloned()
            .into_iter()
            .collect(),
    }
}

/// Sonarr 5 removes a download from the client before blocklisting it and
/// then fails when no grab is on record; Sonarr 4 skipped the blocklist
/// silently. Whether an error answer is that case.
#[must_use]
pub fn removed_without_grab(status: u16, data: &Value) -> bool {
    status == 400
        && data
            .get("message")
            .and_then(Value::as_str)
            .is_some_and(|m| m.contains("no grabbed history"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn q(pairs: &[(&str, &str)]) -> Query {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn detection() {
        assert_eq!(
            api_version_from_info(&json!({"current": "v5", "deprecated": ["v3"]})),
            ApiVersion::V5
        );
        assert_eq!(
            api_version_from_info(&json!({"current": "v6", "deprecated": ["v5"]})),
            ApiVersion::V5
        );
        assert_eq!(
            api_version_from_info(&json!({"current": "v3", "deprecated": []})),
            ApiVersion::V3
        );
        assert_eq!(api_version_from_info(&json!("<html>")), ApiVersion::V3);
    }

    /// Answers `GET /api` as Sonarr 5 does, slowly enough for callers to
    /// overlap; the port and the number of requests served.
    async fn sonarr5() -> std::io::Result<(u16, Arc<std::sync::atomic::AtomicUsize>)> {
        fake_api("200 OK", r#"{"current":"v5","deprecated":["v3"]}"#).await
    }

    /// A server answering every request with `status` and `body`, slowly
    /// enough for concurrent callers to overlap, counting the requests.
    async fn fake_api(
        status: &'static str,
        body: &'static str,
    ) -> std::io::Result<(u16, Arc<std::sync::atomic::AtomicUsize>)> {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let served = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&served);
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let count = Arc::clone(&count);
                tokio::spawn(async move {
                    let mut request = [0_u8; 4096];
                    // One read takes the whole small request.
                    let _read = stream.read(&mut request).await.ok();
                    count.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    let answer = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    stream.write_all(answer.as_bytes()).await.ok();
                });
            }
        });
        Ok((port, served))
    }

    #[tokio::test]
    async fn one_probe_for_concurrent_callers() -> std::io::Result<()> {
        if rustls::crypto::ring::default_provider()
            .install_default()
            .is_err()
        {
            tracing::trace!("a provider was installed");
        }
        let (port, served) = sonarr5().await?;
        let client = reqwest::Client::new();
        let root = format!("http://127.0.0.1:{port}");
        let ask = || api_version(&client, &root, Some("k"), None);
        let versions = tokio::join!(ask(), ask(), ask());
        assert_eq!(
            versions,
            (ApiVersion::V5, ApiVersion::V5, ApiVersion::V5),
            "every caller gets the answer"
        );
        assert_eq!(
            served.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "asked once"
        );
        assert_eq!(ask().await, ApiVersion::V5, "cached");
        assert_eq!(
            served.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "still once"
        );
        assert!(
            !crate::sync::lock(&PROBES).contains_key(&root),
            "the probe lock is dropped once nobody waits on it"
        );
        Ok(())
    }

    #[tokio::test]
    async fn failed_probes_fall_back_to_v3() -> std::io::Result<()> {
        if rustls::crypto::ring::default_provider()
            .install_default()
            .is_err()
        {
            tracing::trace!("a provider was installed");
        }
        let client = reqwest::Client::new();
        for (status, body, what) in [
            ("500 Internal Server Error", "{}", "an error status"),
            (
                "200 OK",
                r#"{"error":"bad gateway"}"#,
                "an answer without versions",
            ),
        ] {
            let (port, served) = fake_api(status, body).await?;
            let root = format!("http://127.0.0.1:{port}");
            let ask = || api_version(&client, &root, None, None);
            assert_eq!(ask().await, ApiVersion::V3, "{what}");
            assert_eq!(ask().await, ApiVersion::V3, "{what}: kept a while");
            assert_eq!(
                served.load(std::sync::atomic::Ordering::SeqCst),
                1,
                "{what}: not asked again at once"
            );
            let retry = crate::sync::lock(&API_VERSIONS)
                .get(&root)
                .map(|(expires, _)| expires.saturating_duration_since(Instant::now()));
            assert!(
                retry.is_some_and(|left| left <= API_VERSION_RETRY),
                "{what}: asked again after the retry delay, not the full TTL"
            );
        }
        Ok(())
    }

    #[test]
    fn requests() {
        assert_eq!(
            to_v5_request(
                "GET",
                "/queue",
                q(&[("page", "1"), ("includeEpisode", "true")]),
                None
            )
            .0,
            q(&[
                ("includeUnknownSeriesItems", "false"),
                ("page", "1"),
                ("includeSubresources", "episodes")
            ])
        );
        let remove = |pairs: &[(&str, &str)]| to_v5_request("DELETE", "/queue/7", q(pairs), None).0;
        assert_eq!(
            remove(&[
                ("removeFromClient", "true"),
                ("blocklist", "true"),
                ("skipRedownload", "false")
            ]),
            q(&[
                ("removalMethod", "removeFromClient"),
                ("blocklistMethod", "blocklistAndSearch")
            ])
        );
        assert_eq!(
            remove(&[("removeFromClient", "false")]),
            q(&[
                ("removalMethod", "ignore"),
                ("blocklistMethod", "doNotBlocklist")
            ])
        );
        assert_eq!(
            to_v5_request(
                "GET",
                "/calendar",
                q(&[("start", "s"), ("unmonitored", "true")]),
                None
            )
            .0,
            q(&[
                ("start", "s"),
                ("includeUnmonitored", "true"),
                ("includeSubresources", "series")
            ])
        );
        assert_eq!(
            to_v5_request(
                "GET",
                "/manualimport",
                q(&[("filterExistingFiles", "true"), ("downloadId", "ABC")]),
                None
            )
            .0,
            q(&[("filterExistingFiles", "true"), ("downloadIds", "ABC")])
        );
        assert_eq!(
            to_v5_request(
                "POST",
                "/manualimport",
                Vec::new(),
                Some(json!([{"path": "/a", "rejections": [{"reason": "x"}]}]))
            )
            .1,
            Some(json!([{"path": "/a"}]))
        );
        assert_eq!(
            to_v5_request(
                "POST",
                "/release",
                Vec::new(),
                Some(json!({"guid": "g", "indexerId": 2, "seriesId": 3}))
            )
            .1,
            Some(json!({"guid": "g", "indexerId": 2, "searchInfo": {"seriesId": 3}}))
        );
        assert_eq!(
            to_v5_request(
                "POST",
                "/release",
                Vec::new(),
                Some(json!({
                    "guid": "g", "indexerId": 2, "seriesId": 3, "episodeId": 4,
                    "shouldOverride": true, "quality": {"quality": {"id": 1}},
                    "languages": [{"id": 1}]
                }))
            )
            .1,
            Some(json!({
                "guid": "g", "indexerId": 2,
                "searchInfo": {"seriesId": 3, "episodeId": 4},
                "override": {
                    "seriesId": 3, "episodeIds": [4],
                    "quality": {"quality": {"id": 1}}, "languages": [{"id": 1}]
                }
            }))
        );
        let same = q(&[("seriesId", "1")]);
        assert_eq!(
            to_v5_request("GET", "/episode", same.clone(), None),
            (same, None)
        );
    }

    #[test]
    fn responses() {
        assert_eq!(
            from_v5_response(
                "GET",
                "/queue",
                json!({"records": [{
                    "id": 5, "sizeLeft": 10, "timeLeft": "00:01:00",
                    "episodeIds": [11, 12], "episodes": [{"id": 11}, {"id": 12}]
                }]})
            ),
            json!({"records": [{
                "id": 5, "sizeLeft": 10, "timeLeft": "00:01:00",
                "sizeleft": 10, "timeleft": "00:01:00",
                "episodeIds": [11, 12], "episodeId": 11,
                "episodes": [{"id": 11}, {"id": 12}], "episode": {"id": 11}
            }]})
        );
        let release = from_v5_response(
            "GET",
            "/release",
            json!([{
                "release": {"guid": "g", "indexerId": 2, "title": "Show.S01", "size": 9},
                "parsedInfo": {
                    "quality": {"quality": {"name": "HDTV-720p"}}, "releaseGroup": "GRP",
                    "fullSeason": true, "seasonNumbers": [1]
                },
                "decision": {
                    "approved": false, "rejected": true, "temporarilyRejected": false,
                    "rejections": [{"message": "Not an upgrade", "reason": "notUpgrade", "type": "permanent"}]
                },
                "downloadAllowed": true, "mappedEpisodeInfo": [{"id": 4}]
            }]),
        );
        let release = release.pointer("/0").cloned().unwrap_or_default();
        assert_eq!(release.get("guid").cloned().unwrap_or_default(), json!("g"));
        assert_eq!(
            release.get("title").cloned().unwrap_or_default(),
            json!("Show.S01")
        );
        assert_eq!(
            release.get("quality").cloned().unwrap_or_default(),
            json!({"quality": {"name": "HDTV-720p"}})
        );
        assert_eq!(
            release.get("fullSeason").cloned().unwrap_or_default(),
            json!(true)
        );
        assert_eq!(
            release.get("seasonNumber").cloned().unwrap_or_default(),
            json!(1)
        );
        assert_eq!(
            release.get("rejected").cloned().unwrap_or_default(),
            json!(true)
        );
        assert_eq!(
            release.get("rejections").cloned().unwrap_or_default(),
            json!(["Not an upgrade"])
        );
        assert_eq!(
            release.get("rejectionDetails").cloned().unwrap_or_default(),
            json!([{"message": "Not an upgrade", "code": "notUpgrade", "type": "permanent"}]),
            "the typed reason next to the message"
        );
        assert!(release.get("multiSeason").is_none(), "one season");
        assert!(release.get("history").is_none(), "never grabbed");
        assert_eq!(
            release
                .get("mappedEpisodeInfo")
                .cloned()
                .unwrap_or_default(),
            json!([{"id": 4}])
        );
        assert!(release.get("releaseHash").is_none(), "absent stays absent");
        assert_eq!(
            from_v5_response(
                "GET",
                "/manualimport",
                json!([{"path": "/a", "rejections": [
                    {"reason": "unknownSeries", "message": "Unknown Series", "type": "permanent"}
                ]}])
            ),
            json!([{"path": "/a", "rejections": [{"reason": "Unknown Series", "type": "permanent"}]}])
        );
    }

    #[test]
    fn release_rejections_and_history() {
        let flatten = |item: Value| {
            from_v5_response("GET", "/release", json!([item]))
                .pointer("/0")
                .cloned()
                .unwrap_or_default()
        };
        let pack = flatten(json!({
            "release": {"guid": "g", "title": "Show.S01-S02"},
            "parsedInfo": {"fullSeason": true, "seasonNumbers": [1, 2]},
            "decision": {"rejected": true, "rejections": [
                {"message": "Multi-season releases are not supported", "reason": "multiSeason", "type": "permanent"},
                {"message": "Blocklisted", "reason": "blocklisted", "type": "permanent"},
                "an odd one"
            ]},
            "history": {"grabbed": "2026-10-30T10:00:00Z", "failed": "2026-10-30T11:00:00Z"}
        }));
        assert_eq!(
            pack.get("multiSeason"),
            Some(&json!(true)),
            "several seasons"
        );
        assert_eq!(
            pack.get("rejections"),
            Some(&json!([
                "Multi-season releases are not supported",
                "Blocklisted",
                "an odd one"
            ])),
            "every message, as v3 lists them"
        );
        assert_eq!(
            pack.get("rejectionDetails")
                .and_then(Value::as_array)
                .map(|list| list.iter().filter_map(rejection_code).collect::<Vec<_>>()),
            Some(vec!["multiSeason", "blocklisted"]),
            "only the typed ones"
        );
        assert_eq!(
            pack.get("history"),
            Some(&json!({"grabbed": "2026-10-30T10:00:00Z", "failed": "2026-10-30T11:00:00Z"})),
            "v5's release history is kept"
        );
        let rejected_pack = flatten(json!({
            "parsedInfo": {"seasonNumbers": [1]},
            "decision": {"rejections": [{"message": "m", "reason": "multiSeason"}]},
            "history": null
        }));
        assert_eq!(
            rejected_pack.get("multiSeason"),
            Some(&json!(true)),
            "Sonarr's own verdict counts"
        );
        assert!(rejected_pack.get("history").is_none(), "null is absent");
        let plain = flatten(json!({"decision": {"rejections": []}}));
        assert!(plain.get("rejectionDetails").is_none(), "nothing typed");
        assert!(plain.get("multiSeason").is_none(), "no seasons");
    }

    #[test]
    fn queue_episodes() {
        let grouped = json!({"episode": {"id": 1}, "episodes": [{"id": 1}, {"id": 2}]});
        assert_eq!(queue_item_episodes(&grouped).len(), 2);
        assert_eq!(queue_item_episodes(&json!({"episode": {"id": 1}})).len(), 1);
        assert!(queue_item_episodes(&json!({})).is_empty());
        assert!(removed_without_grab(
            400,
            &json!({"message": "Unable to mark download as failed, no grabbed history available"})
        ));
        assert!(!removed_without_grab(404, &json!({})));
    }
}
