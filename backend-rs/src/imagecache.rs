//! The transient image cache of `server/lib/imageproxy.ts`.
//!
//! Images are fetched once from TMDB, TVDB, `AniList`, Simkl or a Jellyfin/Emby avatar URL and
//! kept on disk under `<config>/cache/images/<group>/<cacheKey>/` (or
//! `$CACHE_DIRECTORY/images`), one file per entry named
//! `<maxAge>.<expireAt>.<etag>.<extension>`. Node and this process share
//! that directory, so the layout, the cache keys and the file names are
//! Node's.
//!
//! Like Node, recently served images are also kept in memory (256 entries
//! across groups). Since Node may replace or delete an entry on disk, an
//! entry remembered here is only served while its file is still the one on
//! disk.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use base64::prelude::*;
use bytes::Bytes;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::concurrency::RpsWindow;
use crate::jsnum;
use crate::settings::Settings;
use crate::state::AppState;

/// `IMAGE_CACHE_STAT_SOURCES`: the groups `/settings/cache` reports.
pub const STAT_SOURCES: [&str; 5] = ["tmdb", "tvdb", "avatar", "anilist", "simkl"];

const IDLE_DAYS_DEFAULT: i64 = 7;
const IDLE_DAYS_MIN: f64 = 1.0;
const IDLE_DAYS_MAX: f64 = 90.0;
const DEFAULT_TRANSIENT_CACHE_BYTES: f64 = 2.0 * 1024.0 * 1024.0 * 1024.0;
const MIN_TRANSIENT_CACHE_BYTES: f64 = 128.0 * 1024.0 * 1024.0;
const MEMORY_CACHE_MAX_ENTRIES: usize = 256;
const DAY_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
/// A file's access time is only bumped when it is older than this.
const ATIME_REFRESH_MS: f64 = 60.0 * 60.0 * 1000.0;

/// One image cache instance (`new ImageProxy(key, baseUrl, options)`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Proxy {
    /// The group: the directory under the cache root.
    pub key: &'static str,
    /// axios' `baseURL`.
    pub base_url: &'static str,
    /// `maxRedirects: 0` (the image proxy) or axios' default of 5.
    pub follow_redirects: bool,
    /// The image proxy's `axios-rate-limit` (50 requests a second).
    pub rate_limited: bool,
}

/// The avatar proxy's instance.
pub const AVATAR: Proxy = Proxy {
    key: "avatar",
    base_url: "",
    follow_redirects: true,
    rate_limited: false,
};

/// What an image's file name and fetch said about it.
#[derive(Debug, Clone, PartialEq)]
pub struct Meta {
    /// `curRevalidate`: the max-age the image was cached with.
    pub cur_revalidate: f64,
    /// Past its expiry; served while it is fetched again.
    pub is_stale: bool,
    /// The upstream `ETag`, sanitised (`None` when the file name has none).
    pub etag: Option<String>,
    /// The file extension (`None` when the file name has none).
    pub extension: Option<String>,
    /// The cache key.
    pub cache_key: String,
    /// Fetched for this request.
    pub cache_miss: bool,
}

/// An image and what is known about it.
#[derive(Debug, Clone)]
pub struct Image {
    /// About the image.
    pub meta: Meta,
    /// The bytes.
    pub bytes: Bytes,
}

/// `String(value)` for an optional file-name part.
#[must_use]
pub fn part_text(part: Option<&str>) -> &str {
    part.unwrap_or("undefined")
}

/// `imageCacheDirectory()`.
#[must_use]
pub fn cache_root(config_dir: &Path) -> PathBuf {
    match std::env::var_os("CACHE_DIRECTORY") {
        Some(dir) if !dir.is_empty() => {
            let mut path = dir;
            path.push("/images");
            PathBuf::from(path)
        }
        Some(_) | None => config_dir.join("cache/images"),
    }
}

/// `clampImageCacheIdleDays`.
#[must_use]
pub fn clamp_idle_days(value: Option<&Value>) -> i64 {
    let parsed = jsnum::value_number(value);
    if !parsed.is_finite() {
        return IDLE_DAYS_DEFAULT;
    }
    let days = crate::librarymap::js_round(parsed).clamp(IDLE_DAYS_MIN, IDLE_DAYS_MAX);
    crate::librarymap::safe_integer(days).unwrap_or(IDLE_DAYS_DEFAULT)
}

/// `transientCacheBytes()`.
fn transient_cache_bytes() -> f64 {
    let configured = std::env::var("FORESEER_CACHE_LIMIT_BYTES")
        .map_or(DEFAULT_TRANSIENT_CACHE_BYTES, |v| {
            crate::librarymap::js_number(&v)
        });
    if configured.is_finite() {
        configured.max(MIN_TRANSIENT_CACHE_BYTES)
    } else {
        DEFAULT_TRANSIENT_CACHE_BYTES
    }
}

fn high_water_bytes() -> f64 {
    (transient_cache_bytes() * 0.625).floor()
}

fn trim_target_bytes() -> f64 {
    (transient_cache_bytes() * 0.5).floor()
}

/// `getCacheKey`: base64 SHA-256 of the group, the cache version (1) and
/// the request path, with `/` made `-`.
#[must_use]
pub fn cache_key(group: &str, path: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(group.as_bytes());
    hash.update(b"1");
    hash.update(path.as_bytes());
    BASE64_STANDARD.encode(hash.finalize()).replace('/', "-")
}

/// `.replace(/[^\w-]/g, '')`.
#[must_use]
pub fn word_chars(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect()
}

/// `mime.getExtension(contentType)`.
#[must_use]
pub fn mime_extension(content_type: &str) -> Option<&'static str> {
    let essence = content_type.split(';').next()?;
    let essence = crate::jellyfin::js_trim(essence).to_lowercase();
    if essence.is_empty() {
        return None;
    }
    crate::mimetable::EXTENSIONS
        .binary_search_by(|(t, _)| (*t).cmp(essence.as_str()))
        .ok()
        .and_then(|i| crate::mimetable::EXTENSIONS.get(i))
        .map(|(_, ext)| *ext)
}

/// The file name parts `[maxAge, expireAt, etag, extension]`.
#[derive(Debug, Clone, PartialEq)]
struct FileName {
    max_age: f64,
    expire_at: f64,
    etag: Option<String>,
    extension: Option<String>,
}

impl FileName {
    /// `file.split('.')` read as `get()` reads it.
    fn parse(name: &str) -> Self {
        let mut parts = name.split('.');
        let max_age = parts.next().map_or(f64::NAN, crate::librarymap::js_number);
        let expire_at = parts.next().map_or(f64::NAN, crate::librarymap::js_number);
        Self {
            max_age,
            expire_at,
            etag: parts.next().map(str::to_owned),
            extension: parts.next().map(str::to_owned),
        }
    }
}

// ---------------------------------------------------------------------------
// The in-memory copy (`rememberImage` / `recallImage`).

#[derive(Debug, Clone)]
struct Hot {
    key: String,
    image: Image,
    expire_at: f64,
    file: PathBuf,
}

static HOT: Mutex<VecDeque<Hot>> = Mutex::new(VecDeque::new());

fn remember(group: &str, cache_key: &str, image: &Image, expire_at: f64, file: PathBuf) {
    let key = format!("{group}:{cache_key}");
    let entry = Hot {
        key,
        image: image.clone(),
        expire_at,
        file,
    };
    let mut hot = crate::sync::lock(&HOT);
    hot.retain(|e| e.key != entry.key);
    hot.push_back(entry);
    while hot.len() > MEMORY_CACHE_MAX_ENTRIES {
        hot.pop_front();
    }
    drop(hot);
}

fn recall(group: &str, cache_key: &str) -> Option<Hot> {
    let key = format!("{group}:{cache_key}");
    let mut hot = crate::sync::lock(&HOT);
    let index = hot.iter().position(|entry| entry.key == key)?;
    let entry = hot.remove(index)?;
    hot.push_back(entry.clone());
    drop(hot);
    Some(entry)
}

fn forget(group: &str, cache_key: &str) {
    let key = format!("{group}:{cache_key}");
    crate::sync::lock(&HOT).retain(|entry| entry.key != key);
}

/// Drop every image held in memory (after the directory was cleared).
pub fn forget_all() {
    crate::sync::lock(&HOT).clear();
}

// ---------------------------------------------------------------------------
// Fetching.

static CLIENT_NO_REDIRECTS: OnceLock<reqwest::Client> = OnceLock::new();
static CLIENT_REDIRECTS: OnceLock<reqwest::Client> = OnceLock::new();

/// The axios instance's client: the outgoing proxy and user agent, and
/// either no redirects or axios' five.
async fn client(state: &AppState, follow_redirects: bool) -> Result<reqwest::Client> {
    let cell = if follow_redirects {
        &CLIENT_REDIRECTS
    } else {
        &CLIENT_NO_REDIRECTS
    };
    if let Some(client) = cell.get() {
        return Ok(client.clone());
    }
    let settings = state.settings.current().await?;
    let policy = if follow_redirects {
        reqwest::redirect::Policy::limited(5)
    } else {
        reqwest::redirect::Policy::none()
    };
    let built = crate::outbound::builder(
        &settings,
        &state.version,
        state.env.extra_ca_file.as_deref(),
    )?
    .redirect(policy)
    .build()
    .context("building the image proxy client")?;
    Ok(cell.get_or_init(|| built).clone())
}

/// Request start times per rate-limited group, for `axios-rate-limit`'s
/// `maxRPS: 50`.
static STARTED: Mutex<Vec<(&'static str, RpsWindow)>> = Mutex::new(Vec::new());
const MAX_RPS: usize = 50;

/// Take a request slot now, or say how long until one frees up.
fn take_slot(group: &'static str) -> Option<Duration> {
    let now = Instant::now();
    let mut started = crate::sync::lock(&STARTED);
    if !started.iter().any(|(g, _)| *g == group) {
        started.push((group, RpsWindow::new()));
    }
    let wait = started
        .iter_mut()
        .find(|(g, _)| *g == group)
        .and_then(|(_, window)| window.take(MAX_RPS, now));
    drop(started);
    wait
}

async fn throttle(group: &'static str) {
    while let Some(wait) = take_slot(group) {
        tokio::time::sleep(wait).await;
    }
}

/// `headerToString(response.headers[name], fallback)`.
fn header_text(response: &reqwest::Response, name: &str, fallback: &str) -> String {
    response.headers().get(name).map_or_else(
        || fallback.to_owned(),
        |v| v.as_bytes().iter().map(|b| char::from(*b)).collect(),
    )
}

/// `set()`: fetch, write to disk, remember. `None` when anything fails.
async fn store(state: &Arc<AppState>, proxy: Proxy, path: &str, cache_key: &str) -> Option<Image> {
    match fetch_and_store(state, proxy, path, cache_key).await {
        Ok(image) => Some(image),
        Err(e) => {
            tracing::debug!(
                label = "Image Cache",
                "Something went wrong caching image. {e:#}"
            );
            None
        }
    }
}

async fn fetch_and_store(
    state: &Arc<AppState>,
    proxy: Proxy,
    path: &str,
    cache_key: &str,
) -> Result<Image> {
    if proxy.rate_limited {
        throttle(proxy.key).await;
    }
    let client = client(state, proxy.follow_redirects).await?;
    let url = format!("{}{path}", proxy.base_url);
    let response = client.get(&url).send().await?;
    let status = response.status();
    anyhow::ensure!(
        status.is_success(),
        "Request failed with status code {}",
        status.as_u16()
    );
    let content_type = header_text(&response, "content-type", "");
    let extension = word_chars(mime_extension(&content_type).unwrap_or(""));
    let cache_control = header_text(&response, "cache-control", "0");
    let mut max_age = cache_control
        .split('=')
        .nth(1)
        .map_or(f64::NAN, crate::librarymap::js_number);
    if max_age.is_nan() || max_age == 0.0 {
        max_age = 86_400.0;
    }
    let expire_at = jsnum::now() + max_age * 1000.0;
    let etag = word_chars(&header_text(&response, "etag", ""));
    let bytes = response.bytes().await?;
    let directory = cache_root(&state.env.config_dir)
        .join(proxy.key)
        .join(cache_key);
    let file = directory.join(format!(
        "{}.{}.{etag}.{extension}",
        jsnum::to_string(max_age),
        jsnum::to_string(expire_at)
    ));
    if let Err(e) = tokio::fs::remove_dir_all(&directory).await {
        tracing::trace!("clearing {}: {e}", directory.display());
    }
    tokio::fs::create_dir_all(&directory).await?;
    tokio::fs::write(&file, &bytes).await?;
    let config_dir = state.env.config_dir.clone();
    let settings = state.settings.current().await.ok();
    tokio::spawn(async move {
        maintain_cache(&config_dir, settings.as_deref(), None).await;
    });
    let image = Image {
        meta: Meta {
            cur_revalidate: max_age,
            is_stale: false,
            etag: Some(etag),
            extension: Some(extension),
            cache_key: cache_key.to_owned(),
            cache_miss: true,
        },
        bytes,
    };
    remember(proxy.key, cache_key, &image, expire_at, file);
    Ok(image)
}

/// Milliseconds since the epoch of a file time, as `stat` reports it.
fn time_ms(time: std::io::Result<SystemTime>) -> f64 {
    time.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

/// The entry's files in name order.
async fn file_names(directory: &Path) -> std::io::Result<Vec<String>> {
    let mut names = Vec::new();
    let mut entries = tokio::fs::read_dir(directory).await?;
    while let Some(entry) = entries.next_entry().await? {
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    names.sort_unstable();
    Ok(names)
}

/// `get()`: the entry on disk, remembered on the way.
async fn load(root: &Path, proxy: Proxy, cache_key: &str) -> Option<Image> {
    let directory = root.join(proxy.key).join(cache_key);
    let names = file_names(&directory).await.ok()?;
    let name = names.first()?;
    let file = directory.join(name);
    let bytes = tokio::fs::read(&file).await.ok()?;
    let meta = tokio::fs::metadata(&file).await.ok()?;
    let now = jsnum::now();
    if now - time_ms(meta.accessed()) > ATIME_REFRESH_MS {
        if let Ok(modified) = meta.modified() {
            let times = std::fs::FileTimes::new()
                .set_accessed(SystemTime::now())
                .set_modified(modified);
            let target = file.clone();
            let touched = tokio::task::spawn_blocking(move || {
                std::fs::File::open(&target).and_then(|f| f.set_times(times))
            })
            .await;
            if !matches!(touched, Ok(Ok(()))) {
                tracing::trace!("could not touch {}", file.display());
            }
        }
    }
    let parts = FileName::parse(name);
    let image = Image {
        meta: Meta {
            cur_revalidate: parts.max_age,
            is_stale: now > parts.expire_at,
            etag: parts.etag,
            extension: parts.extension,
            cache_key: cache_key.to_owned(),
            cache_miss: false,
        },
        bytes: Bytes::from(bytes),
    };
    remember(proxy.key, cache_key, &image, parts.expire_at, file);
    Some(image)
}

/// The remembered copy, while its file is still the one on disk.
async fn recall_current(proxy: Proxy, cache_key: &str) -> Option<Image> {
    let hot = recall(proxy.key, cache_key)?;
    let current = match hot.file.parent() {
        Some(directory) => file_names(directory)
            .await
            .ok()
            .and_then(|names| names.into_iter().next())
            .is_some_and(|name| {
                hot.file
                    .file_name()
                    .is_some_and(|f| f.to_string_lossy() == name)
            }),
        None => false,
    };
    if !current {
        forget(proxy.key, cache_key);
        return None;
    }
    let mut image = hot.image;
    image.meta.is_stale = jsnum::now() > hot.expire_at;
    image.meta.cache_miss = false;
    Some(image)
}

fn revalidate(state: &Arc<AppState>, proxy: Proxy, path: &str, cache_key: &str) {
    let state = Arc::clone(state);
    let path = path.to_owned();
    let cache_key = cache_key.to_owned();
    tokio::spawn(async move {
        store(&state, proxy, &path, &cache_key).await;
    });
}

/// `getImage(path, fallbackPath)`.
///
/// # Errors
///
/// `Failed to load image` when neither the path nor the fallback could be
/// fetched.
pub async fn get_image(
    state: &Arc<AppState>,
    proxy: Proxy,
    path: &str,
    fallback: Option<&str>,
) -> Result<Image> {
    let root = cache_root(&state.env.config_dir);
    for path in std::iter::once(path).chain(fallback) {
        let cache_key = cache_key(proxy.key, path);
        if let Some(image) = recall_current(proxy, &cache_key).await {
            if image.meta.is_stale {
                revalidate(state, proxy, path, &cache_key);
            }
            return Ok(image);
        }
        if let Some(image) = load(&root, proxy, &cache_key).await {
            if image.meta.is_stale {
                revalidate(state, proxy, path, &cache_key);
            }
            return Ok(image);
        }
        if let Some(image) = store(state, proxy, path, &cache_key).await {
            return Ok(image);
        }
    }
    anyhow::bail!("Failed to load image")
}

// ---------------------------------------------------------------------------
// Maintenance and statistics.

/// One valid entry on disk.
#[derive(Debug, Clone)]
struct Entry {
    directory: PathBuf,
    size: f64,
    accessed_at: f64,
}

async fn remove_quiet(directory: &Path) {
    if let Err(e) = tokio::fs::remove_dir_all(directory).await {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::debug!("removing {}: {e}", directory.display());
        }
    }
}

async fn dir_names(directory: &Path) -> Option<Vec<String>> {
    file_names(directory).await.ok()
}

/// `listEntries(removeInvalid)`: unexpired entries with their size and
/// last access; expired or unreadable ones are removed when asked.
async fn list_entries(root: &Path, remove_invalid: bool) -> Vec<Entry> {
    let mut result = Vec::new();
    let Some(groups) = dir_names(root).await else {
        return result;
    };
    for group in groups {
        let Some(keys) = dir_names(&root.join(&group)).await else {
            continue;
        };
        for key in keys {
            let directory = root.join(&group).join(key);
            let Some(files) = dir_names(&directory).await else {
                continue;
            };
            let expires_at = files.first().map_or(f64::NAN, |f| {
                f.split('.')
                    .nth(1)
                    .map_or(f64::NAN, crate::librarymap::js_number)
            });
            let Some(file) = files.first() else {
                if remove_invalid {
                    remove_quiet(&directory).await;
                }
                continue;
            };
            if !expires_at.is_finite() || jsnum::now() > expires_at {
                if remove_invalid {
                    remove_quiet(&directory).await;
                }
                continue;
            }
            match tokio::fs::metadata(directory.join(file)).await {
                Ok(meta) => {
                    let accessed = time_ms(meta.accessed());
                    let accessed_at = if accessed == 0.0 {
                        time_ms(meta.modified())
                    } else {
                        accessed
                    };
                    result.push(Entry {
                        directory,
                        size: jsnum::from_i64(i64::try_from(meta.len()).unwrap_or(i64::MAX)),
                        accessed_at,
                    });
                }
                Err(_) => {
                    if remove_invalid {
                        remove_quiet(&directory).await;
                    }
                }
            }
        }
    }
    result
}

static CLEANUP_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// Limits for one maintenance run (`maintainCache(options)`).
#[derive(Debug, Clone, Copy, Default)]
pub struct Limits {
    /// Entries unused for longer are removed.
    pub idle_ms: Option<f64>,
    /// Above this many bytes, the least recently used go...
    pub high_water_bytes: Option<f64>,
    /// ...until this many are left.
    pub trim_target_bytes: Option<f64>,
}

/// `ImageProxy.maintainCache()`: drop expired, idle and, above the high
/// water mark, least recently used entries. One run at a time; failures
/// are only logged.
pub async fn maintain_cache(
    config_dir: &Path,
    settings: Option<&Settings>,
    limits: Option<Limits>,
) {
    if CLEANUP_IN_PROGRESS.swap(true, Ordering::SeqCst) {
        return;
    }
    let limits = limits.unwrap_or_default();
    let idle_days = clamp_idle_days(settings.and_then(|s| s.get("/main/imageCacheIdleDays")));
    let idle_ms = limits
        .idle_ms
        .unwrap_or_else(|| jsnum::from_i64(idle_days) * DAY_MS);
    let high_water = limits.high_water_bytes.unwrap_or_else(high_water_bytes);
    let trim_target = limits.trim_target_bytes.unwrap_or_else(trim_target_bytes);
    let entries = list_entries(&cache_root(config_dir), true).await;
    let mut used: f64 = entries.iter().map(|e| e.size).sum();
    let mut remaining = Vec::new();
    let now = jsnum::now();
    for entry in entries {
        if now - entry.accessed_at > idle_ms {
            remove_quiet(&entry.directory).await;
            used -= entry.size;
        } else {
            remaining.push(entry);
        }
    }
    if used > high_water {
        remaining.sort_by(|a, b| a.accessed_at.total_cmp(&b.accessed_at));
        for entry in remaining {
            if used <= trim_target {
                break;
            }
            remove_quiet(&entry.directory).await;
            used -= entry.size;
        }
    }
    CLEANUP_IN_PROGRESS.store(false, Ordering::SeqCst);
}

/// `ImageProxy.getCombinedStats()`: `images` in `/settings/cache`.
pub async fn combined_stats(config_dir: &Path, settings: &Settings) -> Value {
    let entries = list_entries(&cache_root(config_dir), false).await;
    let used: f64 = entries.iter().map(|e| e.size).sum();
    let mut out = Map::new();
    out.insert(String::from("usedBytes"), jsnum::json(used));
    out.insert(String::from("entries"), Value::from(entries.len()));
    out.insert(
        String::from("highWaterBytes"),
        jsnum::json(high_water_bytes()),
    );
    out.insert(
        String::from("trimTargetBytes"),
        jsnum::json(trim_target_bytes()),
    );
    out.insert(
        String::from("idleDays"),
        Value::from(clamp_idle_days(settings.get("/main/imageCacheIdleDays"))),
    );
    Value::Object(out)
}

/// `getDirectorySize`: every regular file below `dir`.
fn directory_size(
    dir: PathBuf,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = u64> + Send>> {
    Box::pin(async move {
        let Ok(mut entries) = tokio::fs::read_dir(&dir).await else {
            return 0;
        };
        let mut total = 0_u64;
        while let Ok(Some(entry)) = entries.next_entry().await {
            let Ok(kind) = entry.file_type().await else {
                continue;
            };
            if kind.is_dir() {
                total = total.saturating_add(directory_size(entry.path()).await);
            } else if kind.is_file() {
                if let Ok(meta) = tokio::fs::metadata(entry.path()).await {
                    total = total.saturating_add(meta.len());
                }
            }
        }
        total
    })
}

/// `ImageProxy.getImageStats(key)`: `{ size, imageCount }`.
pub async fn group_stats(config_dir: &Path, group: &str) -> Value {
    let directory = cache_root(config_dir).join(group);
    let size = directory_size(directory.clone()).await;
    let count = match tokio::fs::read_dir(&directory).await {
        Ok(mut entries) => {
            let mut n = 0_u64;
            while let Ok(Some(_)) = entries.next_entry().await {
                n += 1;
            }
            n
        }
        Err(_) => 0,
    };
    let mut out = Map::new();
    out.insert(String::from("size"), Value::from(size));
    out.insert(String::from("imageCount"), Value::from(count));
    Value::Object(out)
}

/// `imageCache` in `/settings/cache`: every stat group's `{ size, imageCount }`.
pub async fn image_cache_stats(config_dir: &Path) -> Value {
    let mut out = Map::new();
    for group in STAT_SOURCES {
        out.insert(group.to_owned(), group_stats(config_dir, group).await);
    }
    Value::Object(out)
}

/// `ImageProxy.clearAll()`: remove the whole cache directory (and what is
/// held in memory here).
///
/// # Errors
///
/// Fails when the directory exists but can't be removed.
pub async fn clear_all(config_dir: &Path) -> Result<()> {
    forget_all();
    match tokio::fs::remove_dir_all(cache_root(config_dir)).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// `POST /settings/cache/images/flush`'s work: `ImageProxy.clearAll()` and
/// `resetLibraryImageCache()`.
///
/// # Errors
///
/// Fails when the cache directory can't be removed.
pub async fn flush_images(config_dir: &Path) -> Result<()> {
    clear_all(config_dir).await?;
    crate::libraryimagecache::reset();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cache_keys_match_node() {
        // createHash('sha256').update('tmdb').update('1').update('/t/p/w500/a.jpg')
        //   .digest('base64').replace(/\//g, '-')
        let key = cache_key("tmdb", "/t/p/w500/a.jpg");
        assert_eq!(key.len(), 44, "padded base64 of 32 bytes");
        assert!(!key.contains('/'), "no slashes");
        let mut hash = Sha256::new();
        hash.update(b"tmdb1/t/p/w500/a.jpg");
        assert_eq!(
            key,
            BASE64_STANDARD.encode(hash.finalize()).replace('/', "-"),
            "the parts are hashed back to back"
        );
    }

    #[test]
    fn idle_days_clamp() {
        assert_eq!(clamp_idle_days(None), 7, "undefined");
        assert_eq!(clamp_idle_days(Some(&json!(null))), 1, "null is 0");
        assert_eq!(clamp_idle_days(Some(&json!(3.5))), 4, "rounded");
        assert_eq!(clamp_idle_days(Some(&json!("200"))), 90, "string, clamped");
        assert_eq!(clamp_idle_days(Some(&json!("x"))), 7, "NaN");
    }

    #[test]
    fn mime_extensions() {
        assert_eq!(mime_extension("image/jpeg"), Some("jpg"), "jpeg");
        assert_eq!(
            mime_extension(" Image/PNG ; charset=x"),
            Some("png"),
            "params"
        );
        assert_eq!(mime_extension("image/webp"), Some("webp"), "webp");
        assert_eq!(mime_extension("application/json"), Some("json"), "json");
        assert_eq!(mime_extension(""), None, "empty");
        assert_eq!(mime_extension("image/nope"), None, "unknown");
        assert!(
            crate::mimetable::EXTENSIONS
                .windows(2)
                .all(|w| matches!(w, [a, b] if a.0 < b.0)),
            "the table is sorted"
        );
    }

    #[test]
    fn file_names_split_like_node() {
        let parts = FileName::parse("86400.1791661865758.abc.jpg");
        assert!((parts.max_age - 86_400.0).abs() < f64::EPSILON, "max age");
        assert!(
            (parts.expire_at - 1_791_661_865_758.0).abs() < f64::EPSILON,
            "expiry"
        );
        assert_eq!(parts.etag.as_deref(), Some("abc"), "etag");
        assert_eq!(parts.extension.as_deref(), Some("jpg"), "extension");
        let short = FileName::parse("5");
        assert!(short.expire_at.is_nan(), "no expiry");
        assert_eq!(part_text(short.etag.as_deref()), "undefined", "no etag");
        assert_eq!(word_chars("W/\"a-b_c.d\""), "Wa-b_cd", "sanitised");
    }

    #[tokio::test]
    async fn maintenance_and_stats() {
        let root = std::env::temp_dir().join(format!(
            "foreseerr-imagecache-{}-{}",
            std::process::id(),
            crate::clock::now_millis()
        ));
        let images = root.join("cache/images");
        let now = crate::clock::now_millis();
        let fresh = images.join("tmdb/k1");
        let expired = images.join("tmdb/k2");
        let empty = images.join("avatar/k3");
        for dir in [&fresh, &expired, &empty] {
            std::fs::create_dir_all(dir).ok();
        }
        std::fs::write(
            fresh.join(format!("86400.{}.e.jpg", now + 100_000)),
            b"abcd",
        )
        .ok();
        std::fs::write(expired.join(format!("86400.{}.e.jpg", now - 1)), b"xy").ok();
        let groups = image_cache_stats(&root).await;
        assert_eq!(
            groups.pointer("/tmdb/size"),
            Some(&json!(6)),
            "both files count"
        );
        assert_eq!(
            groups.pointer("/tmdb/imageCount"),
            Some(&json!(2)),
            "two entries"
        );
        assert_eq!(
            groups.pointer("/avatar/imageCount"),
            Some(&json!(1)),
            "an empty entry"
        );
        assert_eq!(
            groups.pointer("/simkl/size"),
            Some(&json!(0)),
            "missing group"
        );
        maintain_cache(&root, None, None).await;
        assert!(fresh.exists(), "fresh entry kept");
        assert!(!expired.exists(), "expired entry removed");
        assert!(!empty.exists(), "empty entry removed");
        let settings = Settings::from_file_value(json!({"main": {}}), None);
        if let Ok(settings) = settings {
            let combined = combined_stats(&root, &settings).await;
            assert_eq!(combined.get("usedBytes"), Some(&json!(4)), "used bytes");
            assert_eq!(combined.get("entries"), Some(&json!(1)), "entries");
            assert_eq!(
                combined.get("idleDays"),
                Some(&json!(7)),
                "default idle days"
            );
        }
        maintain_cache(
            &root,
            None,
            Some(Limits {
                idle_ms: None,
                high_water_bytes: Some(1.0),
                trim_target_bytes: Some(0.0),
            }),
        )
        .await;
        assert!(!fresh.exists(), "trimmed above the high water mark");
        assert!(clear_all(&root).await.is_ok(), "clearing works");
        assert!(!images.exists(), "directory gone");
        std::fs::remove_dir_all(&root).ok();
    }
}
