//! On-disk formats shared by `record`, `replay` and `compare`.
//!
//! A recording directory looks like:
//!
//! ```text
//! recording/
//!   meta.json         when and against what the recording was made
//!   traffic.jsonl     inbound requests (and detected job runs), one per line
//!   upstream.jsonl    every outgoing call the backend made while recording
//!   snapshot/config/  copy of the config directory (settings.json + SQLite DB)
//! ```

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, Result};
use base64::Engine;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::httpx::lock;

/// Header list in arrival order, names as sent.
pub type Headers = Vec<(String, String)>;

/// A captured HTTP body. Small bodies are stored inline (as text when they are
/// UTF-8), large ones only by length and hash.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Body {
    /// Size in bytes.
    pub len: usize,
    /// Hex SHA-256 of the bytes (empty when the body was too large to hash).
    pub sha256: String,
    /// The body, when it is valid UTF-8.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// The body in base64, when it is binary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub b64: Option<String>,
    /// The body was larger than the capture limit and is not stored.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    /// Content-Encoding that was removed before storing (gzip, br, deflate).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decoded_from: Option<String>,
}

impl Body {
    /// Capture `bytes`, keeping the content only up to `max` bytes.
    #[must_use]
    pub fn capture(bytes: &[u8], max: usize) -> Self {
        let sha256 = sha256_hex(bytes);
        if bytes.len() > max {
            return Self {
                len: bytes.len(),
                sha256,
                truncated: true,
                ..Default::default()
            };
        }
        std::str::from_utf8(bytes).map_or_else(
            |_| Self {
                len: bytes.len(),
                sha256: sha256.clone(),
                b64: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
                ..Default::default()
            },
            |text| Self {
                len: bytes.len(),
                sha256: sha256.clone(),
                text: Some(text.to_owned()),
                ..Default::default()
            },
        )
    }

    /// Whether the body had no bytes.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// The stored bytes, or `None` when the body was too large to keep.
    #[must_use]
    pub fn bytes(&self) -> Option<Vec<u8>> {
        if let Some(text) = &self.text {
            return Some(text.as_bytes().to_vec());
        }
        if let Some(b64) = &self.b64 {
            return base64::engine::general_purpose::STANDARD.decode(b64).ok();
        }
        (self.len == 0).then(Vec::new)
    }

    /// The body parsed as JSON, when it is JSON.
    #[must_use]
    pub fn json(&self) -> Option<serde_json::Value> {
        self.text
            .as_deref()
            .filter(|t| !t.trim().is_empty())
            .and_then(|t| serde_json::from_str(t).ok())
    }
}

/// Lowercase hex SHA-256.
#[must_use]
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// Lowercase hex encoding.
#[must_use]
pub fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(char::from_digit(u32::from(b >> 4), 16).unwrap_or('0'));
        out.push(char::from_digit(u32::from(b & 0x0f), 16).unwrap_or('0'));
    }
    out
}

/// An inbound request as the backend received it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordedRequest {
    /// HTTP method.
    pub method: String,
    /// Path and query, e.g. `/api/v1/request?take=10`.
    pub uri: String,
    /// Headers as forwarded to the backend.
    pub headers: Headers,
    /// Request body.
    pub body: Body,
}

/// The backend's answer to a [`RecordedRequest`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordedResponse {
    /// HTTP status code.
    pub status: u16,
    /// Response headers.
    pub headers: Headers,
    /// Response body, decoded if it was compressed.
    pub body: Body,
}

/// One line of `traffic.jsonl`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TrafficEvent {
    /// An HTTP request and its response.
    Http(Box<HttpEvent>),
    /// A scheduled job starting.
    Job(JobEvent),
}

impl TrafficEvent {
    /// Arrival order while recording.
    #[must_use]
    pub const fn seq(&self) -> u64 {
        match self {
            Self::Http(e) => e.seq,
            Self::Job(e) => e.seq,
        }
    }

    /// When the event started (unix ms).
    #[must_use]
    pub const fn ts_ms(&self) -> i64 {
        match self {
            Self::Http(e) => e.ts_ms,
            Self::Job(e) => e.ts_ms,
        }
    }
}

/// A recorded request/response pair.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpEvent {
    /// Arrival order while recording.
    pub seq: u64,
    /// When the request arrived (unix ms).
    pub ts_ms: i64,
    /// How long the backend took.
    pub duration_ms: u64,
    /// Client address as seen by the recorder.
    pub client: String,
    /// What was asked.
    pub request: RecordedRequest,
    /// What the backend answered, if it answered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response: Option<RecordedResponse>,
    /// The backend could not be reached or the connection broke.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The response was a stream (e.g. server-sent events) or the client
    /// disconnected before it finished; replay skips these.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub streaming: bool,
}

/// A scheduled job run noticed by polling the backend's job list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobEvent {
    /// Arrival order while recording.
    pub seq: u64,
    /// When the job started (unix ms).
    pub ts_ms: i64,
    /// The backend's job id, e.g. `radarr-scan`.
    pub job_id: String,
}

/// One line of `upstream.jsonl`: a call the backend made to TMDB, Sonarr, Plex...
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpstreamCall {
    /// Recording order.
    pub id: u64,
    /// When the call started (unix ms).
    pub ts_ms: i64,
    /// How long the service took.
    pub duration_ms: u64,
    /// HTTP method.
    pub method: String,
    /// Absolute URL.
    pub url: String,
    /// Headers the backend sent.
    pub request_headers: Headers,
    /// Body the backend sent.
    pub request_body: Body,
    /// Status the service answered with; absent when the call failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    /// Headers the service answered with.
    #[serde(default)]
    pub response_headers: Headers,
    /// Body the service answered with, as received.
    #[serde(default)]
    pub response_body: Body,
    /// Why the call failed, if it did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `meta.json` of a recording.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingMeta {
    /// Version of this tool that made the recording.
    pub tool_version: String,
    /// Start time, RFC 3339.
    pub started_at: String,
    /// Start time, unix ms.
    pub started_ms: i64,
    /// The backend that was recorded.
    pub primary: String,
    /// Snapshot directory, relative to the recording.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<String>,
    /// Stop time, RFC 3339, when the recorder shut down cleanly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped_at: Option<String>,
}

/// How a target's outgoing call was answered during replay.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MatchKind {
    /// Same method, URL and body as a recorded call.
    Exact,
    /// Same method and URL, different body.
    Url,
    /// Same method, host, path and query keys; only date-like values differ.
    Fuzzy,
    /// Nothing recorded looked like it; the target got a 502.
    None,
}

/// An outgoing call a target made during replay.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutgoingCall {
    /// HTTP method.
    pub method: String,
    /// Absolute URL.
    pub url: String,
    /// Body the target sent.
    pub body: Body,
    /// How it was answered.
    pub matched: MatchKind,
    /// The recorded call used as the answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recorded_id: Option<u64>,
}

/// One line of a target's `results.jsonl`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReplayResult {
    /// The recorded event's sequence number.
    pub seq: u64,
    /// `http` or `job`.
    pub kind: String,
    /// `GET /api/v1/movie/550` or `job radarr-scan`.
    pub label: String,
    /// Response status, absent when the request failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    /// Response headers.
    #[serde(default)]
    pub headers: Headers,
    /// Response body.
    #[serde(default)]
    pub body: Body,
    /// Why the request failed, if it did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Time spent on this event, including settling.
    pub duration_ms: u64,
    /// Calls the target made while handling the event.
    #[serde(default)]
    pub outgoing: Vec<OutgoingCall>,
    /// Per-table digests taken after this event (only for writes, when enabled).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub db_digest: Option<BTreeMap<String, String>>,
}

/// `run.json` of a replay run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunMeta {
    /// Recording that was replayed.
    pub recording: String,
    /// Start time, RFC 3339.
    pub started_at: String,
    /// Number of events replayed.
    pub events: usize,
    /// Targets in config order.
    pub targets: Vec<RunTarget>,
}

/// A target as listed in `run.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunTarget {
    /// Target name.
    pub name: String,
    /// What the target is compared as.
    pub role: crate::replay::Role,
    /// Directory of its results, relative to the run.
    pub dir: String,
}

/// Append-only JSON Lines writer that can be shared between tasks.
#[derive(Debug)]
pub struct JsonlWriter {
    inner: Mutex<BufWriter<File>>,
}

impl JsonlWriter {
    /// Create (or truncate) `path`.
    ///
    /// # Errors
    ///
    /// Fails when the file can't be opened.
    pub fn create(path: &Path) -> Result<Self> {
        let file = open_private(path, false)?;
        Ok(Self {
            inner: Mutex::new(BufWriter::new(file)),
        })
    }

    /// Open `path` for appending, creating it if needed.
    ///
    /// # Errors
    ///
    /// Fails when the file can't be opened.
    pub fn append(path: &Path) -> Result<Self> {
        let file = open_private(path, true)?;
        Ok(Self {
            inner: Mutex::new(BufWriter::new(file)),
        })
    }

    /// Write one value as a line and flush.
    ///
    /// # Errors
    ///
    /// Fails when serialising or writing fails.
    pub fn write<T: Serialize>(&self, value: &T) -> Result<()> {
        let line = serde_json::to_string(value)?;
        let mut w = lock(&self.inner);
        w.write_all(line.as_bytes())?;
        w.write_all(b"\n")?;
        w.flush()?;
        drop(w);
        Ok(())
    }
}

/// Recordings hold session cookies, API keys and passwords, so keep them
/// readable by the owner only.
fn open_private(path: &Path, append: bool) -> Result<File> {
    let mut opts = OpenOptions::new();
    opts.create(true).write(true);
    if append {
        opts.append(true);
    } else {
        opts.truncate(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)
        .with_context(|| format!("opening {}", path.display()))
}

/// Read a JSON Lines file, skipping lines that don't parse.
///
/// # Errors
///
/// Fails when the file can't be read.
pub fn read_jsonl<T: DeserializeOwned>(path: &Path) -> Result<Vec<T>> {
    let file = File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let mut out = Vec::new();
    for (i, line) in BufReader::new(file).lines().enumerate() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        // A recorder killed mid-write can leave a partial last line.
        match serde_json::from_str(&line) {
            Ok(v) => out.push(v),
            Err(e) => tracing::warn!(
                "{}:{}: skipping unreadable line: {e}",
                path.display(),
                i + 1
            ),
        }
    }
    Ok(out)
}

/// Write `value` as pretty JSON, readable by the owner only.
///
/// # Errors
///
/// Fails when serialising or writing fails.
pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let file = open_private(path, false)?;
    let mut w = BufWriter::new(file);
    serde_json::to_writer_pretty(&mut w, value)?;
    w.write_all(b"\n")?;
    w.flush()?;
    Ok(())
}

/// Read a JSON file.
///
/// # Errors
///
/// Fails when the file can't be read or parsed.
pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let text =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))
}

/// Current time in unix milliseconds.
#[must_use]
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

/// Current time, RFC 3339.
#[must_use]
pub fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

/// First header named `name`, case-insensitively.
#[must_use]
pub fn header<'h>(headers: &'h [(String, String)], name: &str) -> Option<&'h str> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

/// Copy a header map into a [`Headers`] list.
#[must_use]
pub fn headers_from(map: &http::HeaderMap) -> Headers {
    map.iter()
        .map(|(k, v)| {
            (
                k.as_str().to_owned(),
                String::from_utf8_lossy(v.as_bytes()).into_owned(),
            )
        })
        .collect()
}

/// Remove a Content-Encoding so stored bodies are readable and comparable.
#[must_use]
pub fn decode_body(encoding: Option<&str>, bytes: &[u8]) -> Option<(Vec<u8>, String)> {
    use std::io::Read;
    let enc = encoding?.trim().to_ascii_lowercase();
    let mut out = Vec::new();
    let ok = match enc.as_str() {
        "gzip" | "x-gzip" => flate2::read::GzDecoder::new(bytes)
            .read_to_end(&mut out)
            .is_ok(),
        "deflate" => {
            if flate2::read::ZlibDecoder::new(bytes)
                .read_to_end(&mut out)
                .is_ok()
            {
                true
            } else {
                // Some servers send raw deflate without the zlib header.
                out.clear();
                flate2::read::DeflateDecoder::new(bytes)
                    .read_to_end(&mut out)
                    .is_ok()
            }
        }
        "br" => brotli::Decompressor::new(bytes, 4096)
            .read_to_end(&mut out)
            .is_ok(),
        _ => false,
    };
    ok.then_some((out, enc))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_roundtrip() {
        let b = Body::capture(b"hello", 10);
        assert_eq!(b.text.as_deref(), Some("hello"), "text stored inline");
        assert_eq!(b.bytes(), Some(b"hello".to_vec()), "text round-trips");
        let bin = Body::capture(&[0xff, 0x00, 0x10], 10);
        assert!(bin.text.is_none(), "binary is not text");
        assert_eq!(
            bin.bytes(),
            Some(vec![0xff, 0x00, 0x10]),
            "binary round-trips"
        );
        let big = Body::capture(b"0123456789abc", 10);
        assert!(big.truncated, "over the limit is truncated");
        assert!(big.bytes().is_none(), "truncated bodies have no bytes");
    }

    #[test]
    fn gzip_is_decoded() -> Result<()> {
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(b"{\"a\":1}")?;
        let gz = enc.finish()?;
        let (plain, from) = decode_body(Some("gzip"), &gz).context("gzip decodes")?;
        assert_eq!(plain, b"{\"a\":1}", "content restored");
        assert_eq!(from, "gzip", "encoding reported");
        Ok(())
    }

    #[test]
    fn hex_encodes() {
        assert_eq!(
            hex(&[0x00, 0x0f, 0xab]),
            "000fab",
            "two lowercase digits per byte"
        );
    }
}
