//! Mapping dataset files: the parsers (`server/lib/mapping/parsers.ts`),
//! the refresh progress snapshot (`progress.ts`) and the mirror download
//! with its last-good copy (`download.ts`).

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::jsnum;

// ---------------------------------------------------------------------------
// Parsers.

/// One directed statement, as stored in `mapping_edge`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EdgeRow {
    /// Source namespace.
    pub src_ns: String,
    /// Source id.
    pub src_id: String,
    /// Source scope (`s2`, `R`, or empty).
    pub src_scope: String,
    /// Target namespace.
    pub dst_ns: String,
    /// Target id.
    pub dst_id: String,
    /// Target scope.
    pub dst_scope: String,
    /// Source episode range.
    pub src_range: Option<String>,
    /// Target range as published.
    pub dst_range: Option<String>,
}

/// A parsed dataset.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedDataset {
    /// Every edge, in file order.
    pub edges: Vec<EdgeRow>,
    /// Upstream's own build stamp, when the file carries one.
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Descriptor {
    ns: String,
    id: String,
    scope: String,
}

/// `ANIBRIDGE_PROVIDERS`.
const ANIBRIDGE_PROVIDERS: [(&str, &str); 9] = [
    ("anidb", "anidb"),
    ("anilist", "anilist"),
    ("mal", "mal"),
    ("imdb_movie", "imdb"),
    ("imdb_show", "imdb"),
    ("tmdb_movie", "tmdb_movie"),
    ("tmdb_show", "tmdb_show"),
    ("tvdb_movie", "tvdb_movie"),
    ("tvdb_show", "tvdb_show"),
];

/// `parseDescriptor`: `provider:id[:scope]`.
fn parse_descriptor(token: &str) -> Option<Descriptor> {
    let mut parts = token.split(':');
    let provider = parts.next()?;
    let id = parts.next().filter(|id| !id.is_empty())?;
    let scope = parts.next().unwrap_or("");
    let ns = ANIBRIDGE_PROVIDERS
        .iter()
        .find(|(p, _)| *p == provider)
        .map(|(_, ns)| *ns)?;
    Some(Descriptor {
        ns: ns.to_owned(),
        id: id.to_owned(),
        scope: scope.to_owned(),
    })
}

/// An array index key (`CanonicalNumericIndexString` below 2^32 - 1).
fn array_index(key: &str) -> Option<u32> {
    let n: u32 = key.parse().ok()?;
    (n != u32::MAX && n.to_string() == key).then_some(n)
}

/// `Object.entries(value)` for a JSON object or array: index keys first in
/// numeric order, then the rest in insertion order.
fn js_entries(value: &Value) -> Vec<(String, &Value)> {
    match value {
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v))
            .collect(),
        Value::Object(map) => {
            let mut indexed: Vec<(u32, &String, &Value)> = map
                .iter()
                .filter_map(|(k, v)| array_index(k).map(|n| (n, k, v)))
                .collect();
            indexed.sort_by_key(|(n, _, _)| *n);
            indexed
                .into_iter()
                .map(|(_, k, v)| (k.clone(), v))
                .chain(
                    map.iter()
                        .filter(|(k, _)| array_index(k).is_none())
                        .map(|(k, v)| (k.clone(), v)),
                )
                .collect()
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => Vec::new(),
    }
}

/// `value && typeof value === 'object'`.
const fn is_object_like(value: &Value) -> bool {
    matches!(value, Value::Object(_) | Value::Array(_))
}

/// `JSON.parse` with the error `JSON.parse` would throw replaced by serde's.
fn parse_json(body: &str) -> Result<Value> {
    serde_json::from_str(body).map_err(|e| anyhow!("{e}"))
}

/// `parseAnibridge`: anibridge-mappings v3.
///
/// # Errors
///
/// Fails when the body isn't JSON or not an object.
pub fn parse_anibridge(body: &str) -> Result<ParsedDataset> {
    let parsed = parse_json(body)?;
    let Value::Object(graph) = &parsed else {
        anyhow::bail!("anibridge dataset is not an object");
    };
    let mut edges = Vec::new();
    for (source_token, targets) in js_entries(&parsed) {
        if source_token == "$meta" {
            continue;
        }
        let Some(source) = parse_descriptor(&source_token) else {
            continue;
        };
        if !is_object_like(targets) {
            continue;
        }
        for (target_token, ranges) in js_entries(targets) {
            let Some(target) = parse_descriptor(&target_token) else {
                continue;
            };
            let pairs: Vec<(String, String)> = js_entries(ranges)
                .into_iter()
                .filter_map(|(k, v)| v.as_str().map(|v| (k, v.to_owned())))
                .collect();
            let base = EdgeRow {
                src_ns: source.ns.clone(),
                src_id: source.id.clone(),
                src_scope: source.scope.clone(),
                dst_ns: target.ns.clone(),
                dst_id: target.id.clone(),
                dst_scope: target.scope.clone(),
                src_range: None,
                dst_range: None,
            };
            if pairs.is_empty() {
                edges.push(base);
                continue;
            }
            for (src_range, dst_range) in pairs {
                edges.push(EdgeRow {
                    src_range: Some(src_range),
                    dst_range: Some(dst_range),
                    ..base.clone()
                });
            }
        }
    }
    let version = graph
        .get("$meta")
        .filter(|meta| is_object_like(meta))
        .and_then(|meta| meta.get("generated_on"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    Ok(ParsedDataset { edges, version })
}

/// `positiveInt`.
fn positive_int(value: Option<&Value>) -> Option<String> {
    let n = jsnum::value_number(value);
    (jsnum::is_integer(n) && n > 0.0).then(|| jsnum::to_string(n))
}

/// `seasonOf`.
fn season_of(value: Option<&Value>) -> String {
    match value {
        Some(Value::Number(n)) => n
            .as_f64()
            .filter(|n| jsnum::is_integer(*n) && *n >= 0.0)
            .map_or_else(String::new, |n| format!("s{}", jsnum::to_string(n))),
        _ => String::new(),
    }
}

/// `row.key && typeof row.key === 'object'`, read as an object.
fn object_field<'a>(row: &'a Map<String, Value>, key: &str) -> Option<&'a Map<String, Value>> {
    row.get(key).and_then(Value::as_object)
}

struct Target {
    descriptor: Descriptor,
    offset: f64,
}

/// The targets of one fribb row.
fn fribb_targets(row: &Map<String, Value>) -> Vec<Target> {
    let kind = row
        .get("type")
        .and_then(Value::as_str)
        .map_or_else(String::new, str::to_uppercase);
    let tmdb = object_field(row, "themoviedb_id");
    let season = object_field(row, "season");
    let offset = object_field(row, "episode_offset");
    let show = positive_int(tmdb.and_then(|t| t.get("tv")));
    let movie_field = tmdb.and_then(|t| t.get("movie"));
    let movies: Vec<String> = match movie_field {
        Some(Value::Array(items)) => items.iter().filter_map(|v| positive_int(Some(v))).collect(),
        other => positive_int(other).into_iter().collect(),
    };
    let mut targets = Vec::new();
    let wants_movie = kind == "MOVIE" || (show.is_none() && kind != "TV" && kind != "ONA");
    if let Some(show) = &show {
        if kind != "MOVIE" || movies.is_empty() {
            targets.push(Target {
                descriptor: Descriptor {
                    ns: String::from("tmdb_show"),
                    id: show.clone(),
                    scope: season_of(season.and_then(|s| s.get("tmdb"))),
                },
                offset: jsnum::value_number(offset.and_then(|o| o.get("tmdb"))),
            });
        }
    }
    if let (true, [movie]) = (wants_movie, movies.as_slice()) {
        targets.push(Target {
            descriptor: Descriptor {
                ns: String::from("tmdb_movie"),
                id: movie.clone(),
                scope: String::new(),
            },
            offset: f64::NAN,
        });
    }
    if let Some(tvdb) = positive_int(row.get("tvdb_id")) {
        targets.push(Target {
            descriptor: Descriptor {
                ns: String::from("tvdb_show"),
                id: tvdb,
                scope: season_of(season.and_then(|s| s.get("tvdb"))),
            },
            offset: jsnum::value_number(offset.and_then(|o| o.get("tvdb"))),
        });
    }
    let imdb: Option<&Value> = match row.get("imdb_id") {
        Some(Value::Array(items)) => match items.as_slice() {
            [one] => Some(one),
            _ => None,
        },
        other => other,
    };
    if let Some(Value::String(imdb)) = imdb {
        if !imdb.is_empty() {
            targets.push(Target {
                descriptor: Descriptor {
                    ns: String::from("imdb"),
                    id: imdb.clone(),
                    scope: String::new(),
                },
                offset: f64::NAN,
            });
        }
    }
    targets
}

/// `parseFribb`: Fribb/anime-lists `anime-list-full.json`.
///
/// # Errors
///
/// Fails when the body isn't JSON or not an array.
pub fn parse_fribb(body: &str) -> Result<ParsedDataset> {
    let parsed = parse_json(body)?;
    let Value::Array(entries) = parsed else {
        anyhow::bail!("fribb dataset is not an array");
    };
    let mut edges = Vec::new();
    for entry in &entries {
        let Value::Object(row) = entry else {
            continue;
        };
        let mut sources = Vec::new();
        if let Some(id) = positive_int(row.get("anilist_id")) {
            sources.push(("anilist", id, ""));
        }
        if let Some(id) = positive_int(row.get("mal_id")) {
            sources.push(("mal", id, ""));
        }
        if let Some(id) = positive_int(row.get("anidb_id")) {
            sources.push(("anidb", id, "R"));
        }
        if sources.is_empty() {
            continue;
        }
        let targets = fribb_targets(row);
        for (ns, id, scope) in &sources {
            for target in &targets {
                let ranged = jsnum::is_integer(target.offset) && target.offset > 0.0;
                let (src_range, dst_range) = if ranged {
                    (
                        Some(String::from("1-")),
                        Some(format!("{}-", jsnum::to_string(target.offset + 1.0))),
                    )
                } else {
                    (None, None)
                };
                let forward = EdgeRow {
                    src_ns: (*ns).to_owned(),
                    src_id: id.clone(),
                    src_scope: (*scope).to_owned(),
                    dst_ns: target.descriptor.ns.clone(),
                    dst_id: target.descriptor.id.clone(),
                    dst_scope: target.descriptor.scope.clone(),
                    src_range,
                    dst_range,
                };
                let reverse = EdgeRow {
                    src_ns: forward.dst_ns.clone(),
                    src_id: forward.dst_id.clone(),
                    src_scope: forward.dst_scope.clone(),
                    dst_ns: forward.src_ns.clone(),
                    dst_id: forward.src_id.clone(),
                    dst_scope: forward.src_scope.clone(),
                    src_range: forward.dst_range.clone(),
                    dst_range: forward.src_range.clone(),
                };
                edges.push(forward);
                edges.push(reverse);
            }
        }
    }
    Ok(ParsedDataset {
        edges,
        version: None,
    })
}

// ---------------------------------------------------------------------------
// Refresh progress.

/// One in-flight refresh: `PackRefreshProgress`, its keys in the order
/// Node's object spreads leave them (an unset key keeps its place).
#[derive(Debug, Clone)]
struct PackProgress {
    key: String,
    fields: Vec<(&'static str, Option<Value>)>,
    last_byte_emit: Option<(f64, f64)>,
    last_log_at: Option<f64>,
}

impl PackProgress {
    fn set(&mut self, name: &'static str, value: Option<Value>) {
        if let Some(slot) = self.fields.iter_mut().find(|(n, _)| *n == name) {
            slot.1 = value;
        } else {
            self.fields.push((name, value));
        }
    }

    fn to_value(&self) -> Value {
        let mut out = Map::new();
        out.insert(String::from("key"), Value::from(self.key.as_str()));
        for (name, value) in &self.fields {
            if let Some(value) = value {
                out.insert((*name).to_owned(), value.clone());
            }
        }
        Value::Object(out)
    }
}

static PROGRESS: Mutex<Vec<PackProgress>> = Mutex::new(Vec::new());

fn now_iso() -> Value {
    Value::from(crate::clock::Utc::now().iso_string())
}

/// `snapshotPackProgress`: every refresh in flight.
#[must_use]
pub fn snapshot_pack_progress() -> Vec<Value> {
    crate::sync::lock(&PROGRESS)
        .iter()
        .map(PackProgress::to_value)
        .collect()
}

/// `beginPackProgress`.
pub fn begin_pack_progress(key: &str) {
    let now = now_iso();
    let entry = PackProgress {
        key: key.to_owned(),
        fields: vec![
            ("phase", Some(Value::from("downloading"))),
            ("startedAt", Some(now.clone())),
            ("updatedAt", Some(now)),
        ],
        last_byte_emit: None,
        last_log_at: None,
    };
    let mut progress = crate::sync::lock(&PROGRESS);
    if let Some(existing) = progress.iter_mut().find(|p| p.key == key) {
        *existing = entry;
    } else {
        progress.push(entry);
    }
}

/// `updatePackProgress`: the patch's keys, then `updatedAt`.
pub fn update_pack_progress(key: &str, patch: &[(&'static str, Option<Value>)]) {
    let updated = now_iso();
    let mut progress = crate::sync::lock(&PROGRESS);
    if let Some(entry) = progress.iter_mut().find(|p| p.key == key) {
        for (name, value) in patch {
            entry.set(name, value.clone());
        }
        entry.set("updatedAt", Some(updated));
    }
    drop(progress);
}

/// `endPackProgress`.
pub fn end_pack_progress(key: &str) {
    crate::sync::lock(&PROGRESS).retain(|p| p.key != key);
}

fn format_mb(bytes: f64) -> String {
    format!("{:.1} MB", bytes / (1024.0 * 1024.0))
}

/// What one byte report decided: whether the snapshot changed and the
/// log line to write.
#[derive(Debug, PartialEq)]
struct ByteReport {
    total: Option<f64>,
    log: Option<String>,
}

/// The throttling of `reportDownloadBytes`, at time `now`.
fn decide_bytes(
    entry: &mut PackProgress,
    received: f64,
    reported_total: Option<f64>,
    now: f64,
) -> Option<ByteReport> {
    let total = reported_total.filter(|t| received <= *t);
    let finished = total.is_some_and(|t| received >= t);
    if let Some((at, previous)) = entry.last_byte_emit {
        if !finished && now - at < 250.0 && received - previous < 256.0 * 1024.0 {
            return None;
        }
    }
    entry.last_byte_emit = Some((now, received));
    let last_log = entry.last_log_at.unwrap_or(0.0);
    let log = (finished || now - last_log >= 2000.0).then(|| {
        entry.last_log_at = Some(now);
        let percent = total
            .filter(|t| *t > 0.0)
            .map(|t| crate::librarymap::js_round(100.0 * received / t));
        let key = &entry.key;
        percent.map_or_else(
            || format!("Downloading mapping dataset {key}: {}", format_mb(received)),
            |p| {
                format!(
                    "Downloading mapping dataset {key}: {} / {} ({}%)",
                    format_mb(received),
                    format_mb(total.unwrap_or(0.0)),
                    jsnum::to_string(p)
                )
            },
        )
    });
    Some(ByteReport { total, log })
}

/// `reportDownloadBytes`: throttled byte progress and log lines.
pub fn report_download_bytes(key: &str, received: f64, total: Option<f64>, mirror: &str) {
    let now = jsnum::now();
    let mut progress = crate::sync::lock(&PROGRESS);
    let Some(entry) = progress.iter_mut().find(|p| p.key == key) else {
        // Node still logs without a snapshot entry; nothing to throttle on.
        return;
    };
    let Some(report) = decide_bytes(entry, received, total, now) else {
        return;
    };
    entry.set("phase", Some(Value::from("downloading")));
    entry.set("bytesReceived", Some(jsnum::json(received)));
    entry.set("bytesTotal", report.total.map(jsnum::json));
    entry.set("mirror", Some(Value::from(mirror)));
    entry.set("updatedAt", Some(now_iso()));
    drop(progress);
    if let Some(line) = report.log {
        tracing::info!(label = "Mapping", pack = key, mirror, "{line}");
    }
}

// ---------------------------------------------------------------------------
// Download.

/// `getPackDirectory()`.
#[must_use]
pub fn pack_directory(config_dir: &Path) -> PathBuf {
    config_dir.join("mapping-packs")
}

/// `packPath(key, 'json')`.
#[must_use]
pub fn pack_path(config_dir: &Path, key: &str) -> PathBuf {
    pack_directory(config_dir).join(format!("{key}.json"))
}

fn last_good_path(config_dir: &Path, key: &str) -> PathBuf {
    pack_directory(config_dir).join(format!("{key}.json.last-good"))
}

/// What a fetch found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchStatus {
    /// A new copy was downloaded.
    Downloaded,
    /// The mirror said the local copy is current.
    NotModified,
    /// Every mirror failed; a copy on disk is served.
    LastGood,
}

impl FetchStatus {
    /// Node's name for it.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Downloaded => "downloaded",
            Self::NotModified => "notModified",
            Self::LastGood => "lastGood",
        }
    }
}

/// `PackFetchResult`, plus what `validate` parsed on the way.
#[derive(Debug, Clone)]
pub struct Fetched {
    /// What happened.
    pub status: FetchStatus,
    /// The file's text.
    pub body: Option<String>,
    /// The `ETag` to send next time.
    pub etag: Option<String>,
    /// The `Last-Modified` to send next time.
    pub last_modified: Option<String>,
    /// The mirror that answered.
    pub mirror: Option<String>,
    /// SHA-256 of a downloaded body, hex.
    pub sha256: Option<String>,
    /// What validation parsed (downloads and last-good copies).
    pub parsed: Option<ParsedDataset>,
}

/// One dataset fetch.
#[derive(Debug)]
pub struct FetchPack<'a> {
    /// Dataset key.
    pub key: &'a str,
    /// Mirrors in order.
    pub mirrors: &'a [String],
    /// Conditional request validators.
    pub cache: Option<(Option<String>, Option<String>)>,
    /// The config directory.
    pub config_dir: &'a Path,
}

/// `axios.get(mirror, { timeout: 60000, maxRedirects: 5 })`'s client.
///
/// # Errors
///
/// Fails when the client can't be built.
pub async fn download_client(state: &crate::state::AppState) -> Result<reqwest::Client> {
    let settings = state.settings.current().await?;
    Ok(crate::outbound::builder(
        &settings,
        &state.version,
        state.env.extra_ca_file.as_deref(),
    )?
    .redirect(reqwest::redirect::Policy::limited(5))
    .connect_timeout(Duration::from_secs(60))
    .read_timeout(Duration::from_secs(60))
    .build()?)
}

fn random_hex() -> String {
    let mut bytes = [0_u8; 8];
    if ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes).is_err() {
        tracing::error!("the system random source failed");
    }
    hex(&bytes)
}

/// Lower-case hex.
fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let digit = |n: u8| DIGITS.get(usize::from(n)).map_or('0', |d| char::from(*d));
    bytes
        .iter()
        .flat_map(|b| [digit(b >> 4), digit(b & 15)])
        .collect()
}

async fn read_if_present(file: &Path) -> Option<String> {
    tokio::fs::read(file)
        .await
        .ok()
        .map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// `contentLength(headers)`.
fn content_length(response: &reqwest::Response) -> Option<f64> {
    let headers = response.headers();
    if headers
        .get(reqwest::header::CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|e| !e.is_empty() && e != "identity")
    {
        return None;
    }
    let raw = headers
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())?;
    let n = crate::librarymap::js_number(raw);
    (n.is_finite() && n > 0.0).then_some(n)
}

/// One mirror: download to a temporary file, validate, publish.
async fn try_mirror(
    client: &reqwest::Client,
    pack: &FetchPack<'_>,
    mirror: &str,
    temporary: &Path,
    validate: &(dyn Fn(&str) -> Result<ParsedDataset> + Sync),
) -> Result<Fetched> {
    let target = pack_path(pack.config_dir, pack.key);
    let mut request = client.get(mirror);
    if let Some((etag, last_modified)) = &pack.cache {
        if let Some(etag) = etag.as_deref().filter(|e| !e.is_empty()) {
            request = request.header("If-None-Match", etag);
        }
        if let Some(lm) = last_modified.as_deref().filter(|l| !l.is_empty()) {
            request = request.header("If-Modified-Since", lm);
        }
    }
    let mut response = request
        .send()
        .await
        .map_err(|e| anyhow!(crate::outbound::describe(&e)))?;
    let status = response.status().as_u16();
    if status == 304 {
        let existing = read_if_present(&target).await.filter(|b| !b.is_empty());
        let Some(existing) = existing else {
            anyhow::bail!("mirror answered 304 but no local copy exists");
        };
        let (etag, last_modified) = pack.cache.clone().unwrap_or((None, None));
        return Ok(Fetched {
            status: FetchStatus::NotModified,
            body: Some(existing),
            etag,
            last_modified,
            mirror: Some(mirror.to_owned()),
            sha256: None,
            parsed: None,
        });
    }
    if status >= 400 {
        anyhow::bail!("Request failed with status code {status}");
    }
    let total = content_length(&response);
    let header = |name: reqwest::header::HeaderName| {
        response
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };
    let etag = header(reqwest::header::ETAG);
    let last_modified = header(reqwest::header::LAST_MODIFIED);
    let mut data: Vec<u8> = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| anyhow!(crate::outbound::describe(&e)))?
    {
        data.extend_from_slice(&chunk);
        let received = jsnum::from_i64(i64::try_from(data.len()).unwrap_or(i64::MAX));
        report_download_bytes(pack.key, received, total, mirror);
    }
    tokio::fs::write(temporary, &data).await?;
    let body = String::from_utf8_lossy(&data).into_owned();
    drop(data);
    if body.is_empty() {
        anyhow::bail!("empty response body");
    }
    let parsed = validate(&body)?;
    if let Some(previous) = read_if_present(&target).await.filter(|p| !p.is_empty()) {
        tokio::fs::write(last_good_path(pack.config_dir, pack.key), previous).await?;
    }
    tokio::fs::rename(temporary, &target).await?;
    let sha256 = hex(&Sha256::digest(body.as_bytes()));
    Ok(Fetched {
        status: FetchStatus::Downloaded,
        body: Some(body),
        etag,
        last_modified,
        mirror: Some(mirror.to_owned()),
        sha256: Some(sha256),
        parsed: Some(parsed),
    })
}

/// `fetchPack`: each mirror in turn, then the copies on disk.
///
/// # Errors
///
/// `Unable to fetch mapping dataset "<key>" from any mirror: <mirror>
/// (<error>); …` when nothing usable was found (the message Node records).
pub async fn fetch_pack(
    client: &reqwest::Client,
    pack: &FetchPack<'_>,
    validate: &(dyn Fn(&str) -> Result<ParsedDataset> + Sync),
) -> Result<Fetched> {
    tokio::fs::create_dir_all(pack_directory(pack.config_dir)).await?;
    let target = pack_path(pack.config_dir, pack.key);
    let mut attempts: Vec<(String, String)> = Vec::new();
    for mirror in pack.mirrors {
        let mut temporary = target.clone().into_os_string();
        temporary.push(format!(".{}.{}.tmp", std::process::id(), random_hex()));
        let temporary = PathBuf::from(temporary);
        match try_mirror(client, pack, mirror, &temporary, validate).await {
            Ok(fetched) => return Ok(fetched),
            Err(e) => {
                if let Err(unlink) = tokio::fs::remove_file(&temporary).await {
                    tracing::trace!("{}: {unlink}", temporary.display());
                }
                let message = e.to_string();
                tracing::debug!(
                    label = "Mapping",
                    pack = pack.key,
                    mirror = mirror.as_str(),
                    "Mapping dataset mirror failed: {message}"
                );
                attempts.push((mirror.clone(), message));
            }
        }
    }
    for candidate in [target, last_good_path(pack.config_dir, pack.key)] {
        let Some(body) = read_if_present(&candidate).await.filter(|b| !b.is_empty()) else {
            continue;
        };
        if let Ok(parsed) = validate(&body) {
            tracing::warn!(
                label = "Mapping",
                pack = pack.key,
                file = %candidate.display(),
                "Serving the last known-good mapping dataset"
            );
            return Ok(Fetched {
                status: FetchStatus::LastGood,
                body: Some(body),
                etag: None,
                last_modified: None,
                mirror: None,
                sha256: None,
                parsed: Some(parsed),
            });
        }
    }
    let detail = attempts
        .iter()
        .map(|(mirror, error)| format!("{mirror} ({error})"))
        .collect::<Vec<_>>()
        .join("; ");
    Err(anyhow!(
        "Unable to fetch mapping dataset \"{}\" from any mirror: {detail}",
        pack.key
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn edge(e: &EdgeRow) -> String {
        format!(
            "{}:{}:{}>{}:{}:{} {:?} {:?}",
            e.src_ns,
            e.src_id,
            e.src_scope,
            e.dst_ns,
            e.dst_id,
            e.dst_scope,
            e.src_range,
            e.dst_range
        )
    }

    #[test]
    fn anibridge_range_pairs() {
        let body = json!({
            "$meta": { "generated_on": "2026-09-26T06:57:14Z" },
            "anilist:1225": {
                "tmdb_show:62913:s2": { "1-3": "1-3" },
                "anidb:3:R": { "1-3": "1-3" }
            }
        })
        .to_string();
        let parsed = parse_anibridge(&body).unwrap_or_default();
        assert_eq!(
            parsed.version.as_deref(),
            Some("2026-09-26T06:57:14Z"),
            "version"
        );
        assert_eq!(
            parsed.edges.first(),
            Some(&EdgeRow {
                src_ns: String::from("anilist"),
                src_id: String::from("1225"),
                src_scope: String::new(),
                dst_ns: String::from("tmdb_show"),
                dst_id: String::from("62913"),
                dst_scope: String::from("s2"),
                src_range: Some(String::from("1-3")),
                dst_range: Some(String::from("1-3")),
            }),
            "first edge"
        );
        assert_eq!(
            parsed.edges.get(1).map(|e| e.dst_scope.as_str()),
            Some("R"),
            "anidb scope"
        );
    }

    #[test]
    fn anibridge_imdb_and_unknown_providers() {
        let body = r#"{"anilist:5": {"imdb_movie:tt0275277": {"1": "1"}}, "imdb_show:tt0213338:s1": {"anilist:1": {"1-26": "1-26"}}}"#;
        let edges: Vec<String> = parse_anibridge(body)
            .map(|p| {
                p.edges
                    .iter()
                    .map(|e| format!("{}:{}>{}", e.src_ns, e.src_id, e.dst_ns))
                    .collect()
            })
            .unwrap_or_default();
        assert_eq!(
            edges,
            ["anilist:5>imdb", "imdb:tt0213338>anilist"],
            "both IMDb providers"
        );
        let body = r#"{"anilist:1": {"kitsu:1": {}, "mal:1": {}}, "kitsu:1": {"anilist:1": {}}}"#;
        let parsed = parse_anibridge(body).unwrap_or_default();
        assert_eq!(parsed.edges.len(), 1, "one known pair");
        assert_eq!(
            parsed
                .edges
                .first()
                .map(|e| (e.dst_ns.as_str(), e.src_range.clone())),
            Some(("mal", None)),
            "no range"
        );
        assert!(parse_anibridge("[]").is_err(), "an array");
        assert!(parse_anibridge(r#"{"anilist:1": {"#).is_err(), "truncated");
    }

    #[test]
    fn anibridge_orders_keys_like_javascript() {
        let body = r#"{"anilist:1": {"mal:1": {"b": "x", "10": "y", "2": "z"}}}"#;
        let ranges: Vec<Option<String>> = parse_anibridge(body)
            .unwrap_or_default()
            .edges
            .into_iter()
            .map(|e| e.src_range)
            .collect();
        assert_eq!(
            ranges,
            [
                Some(String::from("2")),
                Some(String::from("10")),
                Some(String::from("b"))
            ],
            "index keys first"
        );
    }

    fn targets(row: &Value) -> Vec<String> {
        parse_fribb(&json!([row]).to_string())
            .unwrap_or_default()
            .edges
            .iter()
            .filter(|e| e.src_ns == "anilist")
            .map(|e| {
                if e.dst_scope.is_empty() {
                    format!("{}:{}", e.dst_ns, e.dst_id)
                } else {
                    format!("{}:{}:{}", e.dst_ns, e.dst_id, e.dst_scope)
                }
            })
            .collect()
    }

    #[test]
    fn fribb_entries() {
        assert_eq!(
            targets(&json!({
                "type": "TV", "anilist_id": 290,
                "themoviedb_id": {"tv": 26209, "movie": [319_145]},
                "tvdb_id": 72025, "season": {"tvdb": 1, "tmdb": 1}
            })),
            ["tmdb_show:26209:s1", "tvdb_show:72025:s1"],
            "series to show and season"
        );
        assert_eq!(
            targets(&json!({
                "type": "MOVIE", "anilist_id": 5661,
                "themoviedb_id": {"tv": 99, "movie": [319_145]},
                "imdb_id": ["tt0419229"]
            })),
            ["tmdb_movie:319145", "imdb:tt0419229"],
            "film to its film"
        );
        assert!(
            targets(&json!({
                "type": "MOVIE", "anilist_id": 821,
                "themoviedb_id": {"movie": [19263, 34384]}
            }))
            .is_empty(),
            "several films answer nothing"
        );
    }

    #[test]
    fn fribb_ranges_and_anidb_scope() {
        let body = json!([{
            "type": "TV", "anilist_id": 190, "themoviedb_id": {"tv": 30992},
            "season": {"tmdb": 1}, "episode_offset": {"tmdb": 12}
        }])
        .to_string();
        let edges = parse_fribb(&body).unwrap_or_default().edges;
        let ranges: Vec<(String, Option<String>, Option<String>)> = edges
            .iter()
            .map(|e| (e.src_ns.clone(), e.src_range.clone(), e.dst_range.clone()))
            .collect();
        assert_eq!(
            ranges,
            [
                (
                    String::from("anilist"),
                    Some(String::from("1-")),
                    Some(String::from("13-"))
                ),
                (
                    String::from("tmdb_show"),
                    Some(String::from("13-")),
                    Some(String::from("1-"))
                ),
            ],
            "both directions"
        );
        let body = json!([{"type": "TV", "anidb_id": 1, "themoviedb_id": {"tv": 5}}]).to_string();
        let edges = parse_fribb(&body).unwrap_or_default().edges;
        assert_eq!(
            edges.first().map(edge),
            Some(String::from("anidb:1:R>tmdb_show:5: None None")),
            "regular-episode scope"
        );
        assert!(parse_fribb("{}").is_err(), "not an array");
        assert_eq!(
            positive_int(Some(&json!("12"))),
            Some(String::from("12")),
            "numeric string"
        );
        assert_eq!(positive_int(Some(&json!(1.5))), None, "fraction");
        assert_eq!(season_of(Some(&json!("1"))), "", "a string season");
    }

    fn entry(key: &str) -> PackProgress {
        PackProgress {
            key: key.to_owned(),
            fields: Vec::new(),
            last_byte_emit: None,
            last_log_at: None,
        }
    }

    #[test]
    fn compressed_length_is_dropped_and_logging_throttled() {
        let mut progress = entry("animeapi");
        let compressed = 3_000_000.0;
        let mut logs = 0;
        let mut last_total = Some(0.0);
        for chunk in 1..=200_u32 {
            let received = f64::from(chunk) * 64.0 * 1024.0;
            if let Some(report) = decide_bytes(&mut progress, received, Some(compressed), 1e12) {
                logs += usize::from(report.log.is_some());
                last_total = report.total;
            }
        }
        assert_eq!(logs, 1, "one log line");
        assert_eq!(last_total, None, "the outgrown total is dropped");
    }

    #[test]
    fn accurate_total_logs_completion() {
        let mut progress = entry("fribb");
        let mib = 1024.0 * 1024.0;
        let first = decide_bytes(&mut progress, 512.0 * 1024.0, Some(mib), 1e12);
        let second = decide_bytes(&mut progress, mib, Some(mib), 1e12 + 1.0);
        assert!(first.is_some_and(|r| r.log.is_some()), "first logs");
        let second = second.and_then(|r| r.log);
        assert_eq!(
            second.as_deref(),
            Some("Downloading mapping dataset fribb: 1.0 MB / 1.0 MB (100%)"),
            "completion"
        );
    }

    #[test]
    fn progress_snapshot_keeps_key_order() {
        begin_pack_progress("test-order");
        report_download_bytes("test-order", 10.0, None, "m");
        update_pack_progress(
            "test-order",
            &[
                ("phase", Some(Value::from("ingesting"))),
                ("recordsDone", Some(Value::from(1))),
                ("recordsTotal", Some(Value::from(2))),
            ],
        );
        let snapshot = snapshot_pack_progress();
        let ours = snapshot
            .iter()
            .find(|p| p.get("key") == Some(&Value::from("test-order")));
        let keys: Vec<String> = ours
            .and_then(Value::as_object)
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default();
        assert_eq!(
            keys,
            [
                "key",
                "phase",
                "startedAt",
                "updatedAt",
                "bytesReceived",
                "mirror",
                "recordsDone",
                "recordsTotal"
            ],
            "spread order, undefined total omitted"
        );
        end_pack_progress("test-order");
        assert!(
            !snapshot_pack_progress()
                .iter()
                .any(|p| p.get("key") == Some(&Value::from("test-order"))),
            "ended"
        );
    }
}
