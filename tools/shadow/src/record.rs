//! `shadow record`: sit in front of the real backend and write down everything.
//!
//! ```text
//! browser/apps ──► :5056 recorder ──► :5055 backend ──► :8899 forward proxy ──► TMDB, Sonarr, ...
//!                      │                                     │
//!                 traffic.jsonl                         upstream.jsonl
//! ```

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use bytes::Bytes;
use clap::Args;
use http_body_util::{BodyExt, Full};
use hyper::body::{Frame, Incoming};
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::{TokioExecutor, TokioIo};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

use crate::ca::CertAuthority;
use crate::httpx::{is_hop_by_hop, millis, text_response, BoxErr, ChannelBody, RespBody};
use crate::model::{
    decode_body, header, headers_from, now_ms, now_rfc3339, write_json, Body, Headers, HttpEvent,
    JobEvent, JsonlWriter, RecordedRequest, RecordedResponse, RecordingMeta, TrafficEvent,
    UpstreamCall,
};
use crate::upstream::{bind, error_chain, ForwardProxy, Mode, RecordMode};

/// Options for `shadow record`.
#[derive(Args, Debug)]
pub struct RecordArgs {
    /// Where clients connect (put this where the backend used to be).
    #[arg(long, default_value = "0.0.0.0:5056")]
    pub listen: SocketAddr,
    /// The real backend.
    #[arg(long, default_value = "http://127.0.0.1:5055")]
    pub primary: String,
    /// Forward proxy for the backend's outgoing calls. Set the backend's
    /// Settings → Network → HTTP(S) proxy to this address. It is an open
    /// proxy: only widen it when the backend can't reach loopback.
    #[arg(long, default_value = "127.0.0.1:8899")]
    pub upstream_listen: SocketAddr,
    /// Don't run the forward proxy (inbound traffic only).
    #[arg(long)]
    pub no_upstream: bool,
    /// Output directory for this recording.
    #[arg(long)]
    pub out: PathBuf,
    /// The backend's config directory. Used for the starting snapshot and to
    /// read the API key for job polling.
    #[arg(long)]
    pub config_dir: Option<PathBuf>,
    /// Top-level entries of the config directory to leave out of the snapshot.
    #[arg(long, value_delimiter = ',', default_value = "logs,cache")]
    pub snapshot_exclude: Vec<String>,
    /// Postgres URL; when set the snapshot includes a `pg_dump`.
    #[arg(long)]
    pub pg_url: Option<String>,
    /// API key for polling scheduled jobs (defaults to settings.json `main.apiKey`).
    #[arg(long, env = "SHADOW_API_KEY")]
    pub api_key: Option<String>,
    /// How often to poll the job list; 0 turns job recording off.
    #[arg(long, default_value_t = 5)]
    pub jobs_poll_secs: u64,
    /// Only requests whose path starts with one of these are recorded; the
    /// rest (static frontend files) are passed through.
    #[arg(
        long,
        value_delimiter = ',',
        default_value = "/api/,/imageproxy/,/avatarproxy/"
    )]
    pub record_prefix: Vec<String>,
    /// Largest inbound body (request or response) stored in full, in bytes.
    #[arg(long, default_value_t = 8 * 1024 * 1024)]
    pub max_body: usize,
    /// Largest upstream response stored in full. Larger ones cannot be replayed.
    #[arg(long, default_value_t = 32 * 1024 * 1024)]
    pub max_upstream_body: usize,
    /// Accept invalid TLS certificates from upstream services (self-signed LAN apps).
    #[arg(long)]
    pub insecure_upstream: bool,
    /// Directory holding ca.pem / ca.key (created if missing). The backend
    /// must trust ca.pem, e.g. `SHADOW_CA_FILE=<dir>/ca.pem`.
    #[arg(long, default_value = "shadow-ca")]
    pub ca_dir: PathBuf,
}

#[derive(Debug)]
struct Recorder {
    primary: String,
    client: Client<HttpConnector, Full<Bytes>>,
    traffic: Arc<JsonlWriter>,
    seq: Arc<AtomicU64>,
    prefixes: Vec<String>,
    max_body: usize,
}

/// Record until Ctrl-C or SIGTERM.
///
/// # Errors
///
/// Fails when the output can't be written, a port can't be bound or the
/// snapshot fails.
pub async fn run(args: RecordArgs) -> Result<()> {
    crate::snapshot::create_private_dir(&args.out)?;
    let started_ms = now_ms();
    let primary = args.primary.trim_end_matches('/').to_owned();

    let mut meta = RecordingMeta {
        tool_version: env!("CARGO_PKG_VERSION").into(),
        started_at: now_rfc3339(),
        started_ms,
        primary: primary.clone(),
        snapshot: take_snapshot(&args)?,
        stopped_at: None,
    };
    write_json(&args.out.join("meta.json"), &meta)?;

    let traffic = Arc::new(JsonlWriter::append(&args.out.join("traffic.jsonl"))?);
    let seq = Arc::new(AtomicU64::new(1));

    if !args.no_upstream {
        start_forward_proxy(&args).await?;
    }
    if args.jobs_poll_secs > 0 {
        if args.api_key.is_none() && args.config_dir.is_none() {
            tracing::warn!(
                "no API key (pass --api-key or --config-dir): scheduled jobs won't be recorded"
            );
        } else {
            let poller = JobPoller {
                primary: primary.clone(),
                api_key: args.api_key.clone(),
                settings: args.config_dir.as_ref().map(|d| d.join("settings.json")),
                interval: Duration::from_secs(args.jobs_poll_secs),
                traffic: Arc::clone(&traffic),
                seq: Arc::clone(&seq),
            };
            tokio::spawn(poller.run());
        }
    }

    let recorder = Arc::new(Recorder {
        primary,
        client: Client::builder(TokioExecutor::new()).build_http(),
        traffic,
        seq,
        prefixes: args.record_prefix.clone(),
        max_body: args.max_body,
    });
    let listener = bind(args.listen).await?;
    tracing::info!(
        "recording {} -> {} into {}",
        args.listen,
        recorder.primary,
        args.out.display()
    );

    tokio::select! {
        r = accept_clients(listener, recorder) => r?,
        () = shutdown_signal() => tracing::info!("stopping"),
    }
    meta.stopped_at = Some(now_rfc3339());
    write_json(&args.out.join("meta.json"), &meta)?;
    Ok(())
}

fn take_snapshot(args: &RecordArgs) -> Result<Option<String>> {
    let snapshot = if let Some(dir) = &args.config_dir {
        let dest = args.out.join("snapshot/config");
        tracing::info!("snapshotting {} -> {}", dir.display(), dest.display());
        crate::snapshot::snapshot_config(dir, &dest, &args.snapshot_exclude)?;
        Some(String::from("snapshot/config"))
    } else {
        tracing::warn!(
            "no --config-dir: the recording has no starting snapshot, replay will need one"
        );
        None
    };
    if let Some(url) = &args.pg_url {
        std::fs::create_dir_all(args.out.join("snapshot"))?;
        crate::snapshot::pg_dump(url, &args.out.join("snapshot/postgres.dump"))?;
    }
    Ok(snapshot)
}

async fn start_forward_proxy(args: &RecordArgs) -> Result<()> {
    let ca = Arc::new(CertAuthority::load_or_create(&args.ca_dir)?);
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .danger_accept_invalid_certs(args.insecure_upstream)
        .build()?;
    let pem = ca.pem_path().display().to_string();
    let proxy = Arc::new(ForwardProxy {
        ca,
        mode: Mode::Record(RecordMode {
            writer: JsonlWriter::append(&args.out.join("upstream.jsonl"))?,
            client,
            next_id: AtomicU64::new(next_upstream_id(&args.out)),
        }),
        max_body: args.max_upstream_body,
        ignore_params: Vec::new(),
    });
    let listener = bind(args.upstream_listen).await?;
    tracing::info!(
        "forward proxy on {} (backend must trust {pem})",
        args.upstream_listen
    );
    tokio::spawn(async move {
        if let Err(e) = proxy.serve(listener).await {
            tracing::error!("forward proxy stopped: {e}");
        }
    });
    Ok(())
}

async fn accept_clients(listener: TcpListener, recorder: Arc<Recorder>) -> Result<()> {
    loop {
        let (stream, peer) = listener.accept().await?;
        let recorder = Arc::clone(&recorder);
        tokio::spawn(async move {
            let svc = service_fn(move |req| {
                let recorder = Arc::clone(&recorder);
                async move { Ok::<_, hyper::Error>(recorder.handle(req, peer).await) }
            });
            if let Err(e) = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(stream), svc)
                .await
            {
                tracing::debug!("client connection: {e}");
            }
        });
    }
}

/// Ctrl-C, or SIGTERM from `kill` / `docker stop`.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    r = tokio::signal::ctrl_c() => {
                        if let Err(e) = r {
                            tracing::warn!("listening for Ctrl-C: {e}");
                        }
                    }
                    _ = term.recv() => {}
                }
                return;
            }
            Err(e) => tracing::warn!("cannot listen for SIGTERM, only Ctrl-C stops recording: {e}"),
        }
    }
    if let Err(e) = tokio::signal::ctrl_c().await {
        tracing::warn!("listening for Ctrl-C: {e}");
    }
}

/// Continue numbering when appending to an existing recording.
fn next_upstream_id(out: &Path) -> u64 {
    crate::model::read_jsonl::<UpstreamCall>(&out.join("upstream.jsonl"))
        .ok()
        .and_then(|c| c.iter().map(|c| c.id).max())
        .map_or(1, |m| m + 1)
}

/// The backend's API key from its settings.json.
///
/// # Errors
///
/// Fails when the file can't be read or has no key yet.
pub fn read_api_key(settings: &Path) -> Result<String> {
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(settings)?)?;
    v.pointer("/main/apiKey")
        .and_then(serde_json::Value::as_str)
        .filter(|k| !k.is_empty())
        .map(str::to_owned)
        .context("settings.json has no main.apiKey")
}

/// What is being captured from one response body.
#[derive(Debug)]
struct Capture {
    seq: u64,
    ts_ms: i64,
    started: Instant,
    client: String,
    request: RecordedRequest,
    status: u16,
    headers: Headers,
}

impl Recorder {
    async fn handle(
        self: Arc<Self>,
        req: Request<Incoming>,
        peer: SocketAddr,
    ) -> Response<RespBody> {
        let started = Instant::now();
        let ts_ms = now_ms();
        let seq = self.seq.fetch_add(1, Ordering::SeqCst);
        let (parts, body) = req.into_parts();
        let path_q = parts
            .uri
            .path_and_query()
            .map_or_else(|| String::from("/"), |p| p.as_str().to_owned());
        let record = self.prefixes.iter().any(|p| path_q.starts_with(p.as_str()));

        let body = match body.collect().await {
            Ok(b) => b.to_bytes(),
            Err(e) => return text_response(400, &format!("reading request body: {e}")),
        };
        let out = match self.forward_request(&parts, &path_q, peer, body.clone()) {
            Ok(r) => r,
            Err(e) => return text_response(400, &format!("bad request: {e}")),
        };
        let request = RecordedRequest {
            method: parts.method.to_string(),
            uri: path_q,
            headers: headers_from(out.headers()),
            body: Body::capture(&body, self.max_body),
        };

        let resp = match self.client.request(out).await {
            Ok(r) => r,
            Err(e) => {
                let msg = error_chain(&e);
                if record {
                    self.write(&TrafficEvent::Http(Box::new(HttpEvent {
                        seq,
                        ts_ms,
                        duration_ms: millis(started.elapsed()),
                        client: peer.ip().to_string(),
                        request,
                        response: None,
                        error: Some(msg.clone()),
                        streaming: false,
                    })));
                }
                return text_response(502, &format!("backend unreachable: {msg}"));
            }
        };

        let (mut rparts, rbody) = resp.into_parts();
        let hop: Vec<_> = rparts
            .headers
            .keys()
            .filter(|k| is_hop_by_hop(k.as_str()))
            .cloned()
            .collect();
        for k in hop {
            rparts.headers.remove(k);
        }
        if !record {
            return Response::from_parts(rparts, rbody.map_err(Into::into).boxed());
        }
        let capture = Capture {
            seq,
            ts_ms,
            started,
            client: peer.ip().to_string(),
            request,
            status: rparts.status.as_u16(),
            headers: headers_from(&rparts.headers),
        };
        Response::from_parts(rparts, self.tee(rbody, capture).boxed())
    }

    /// The request to send to the backend: same method, path and headers,
    /// plus the usual forwarding headers.
    fn forward_request(
        &self,
        parts: &http::request::Parts,
        path_q: &str,
        peer: SocketAddr,
        body: Bytes,
    ) -> Result<Request<Full<Bytes>>> {
        let mut out = Request::builder()
            .method(parts.method.clone())
            .uri(format!("{}{path_q}", self.primary));
        let mut forwarded_for = None;
        for (name, value) in &parts.headers {
            if is_hop_by_hop(name.as_str()) {
                continue;
            }
            if name == "x-forwarded-for" {
                forwarded_for = value.to_str().ok().map(str::to_owned);
                continue;
            }
            out = out.header(name, value);
        }
        let xff = forwarded_for.map_or_else(
            || peer.ip().to_string(),
            |prev| format!("{prev}, {}", peer.ip()),
        );
        out = out.header("x-forwarded-for", xff);
        if !parts.headers.contains_key("x-forwarded-proto") {
            out = out.header("x-forwarded-proto", "http");
        }
        Ok(out.body(Full::new(body))?)
    }

    /// Stream the backend's body to the client and keep a copy for the recording.
    fn tee(self: Arc<Self>, body: Incoming, capture: Capture) -> ChannelBody {
        let (tx, rx) = mpsc::channel::<Result<Frame<Bytes>, BoxErr>>(32);
        tokio::spawn(async move {
            let mut body = body;
            let mut buf: Vec<u8> = Vec::new();
            let mut over = false;
            let mut total = 0usize;
            let mut client_gone = false;
            let mut error = None;
            while let Some(frame) = body.frame().await {
                match frame {
                    Ok(frame) => {
                        if let Some(data) = frame.data_ref() {
                            total += data.len();
                            if !over && buf.len() + data.len() > self.max_body {
                                over = true;
                                buf = Vec::new();
                            } else if !over {
                                buf.extend_from_slice(data);
                            }
                        }
                        if tx.send(Ok(frame)).await.is_err() {
                            client_gone = true;
                            break;
                        }
                    }
                    Err(e) => {
                        error = Some(e.to_string());
                        if tx.send(Err(e.into())).await.is_err() {
                            client_gone = true;
                        }
                        break;
                    }
                }
            }
            let stored = if over {
                Body {
                    len: total,
                    truncated: true,
                    ..Default::default()
                }
            } else {
                self.stored_body(&capture.headers, &buf)
            };
            let event_stream = header(&capture.headers, "content-type")
                .is_some_and(|c| c.starts_with("text/event-stream"));
            self.write(&TrafficEvent::Http(Box::new(HttpEvent {
                seq: capture.seq,
                ts_ms: capture.ts_ms,
                duration_ms: millis(capture.started.elapsed()),
                client: capture.client,
                request: capture.request,
                response: Some(RecordedResponse {
                    status: capture.status,
                    headers: capture.headers,
                    body: stored,
                }),
                error,
                streaming: event_stream || client_gone,
            })));
        });
        ChannelBody(rx)
    }

    fn stored_body(&self, headers: &[(String, String)], buf: &[u8]) -> Body {
        decode_body(header(headers, "content-encoding"), buf).map_or_else(
            || Body::capture(buf, self.max_body),
            |(plain, from)| Body {
                decoded_from: Some(from),
                ..Body::capture(&plain, self.max_body)
            },
        )
    }

    fn write(&self, event: &TrafficEvent) {
        if let Err(e) = self.traffic.write(event) {
            tracing::error!("writing traffic.jsonl: {e}");
        }
    }
}

/// What the last poll said about a job.
#[derive(Debug, Clone, Copy)]
struct JobSeen {
    /// Latest known start (unix ms), 0 when unknown.
    last_start: i64,
    running: bool,
    next: Option<i64>,
}

/// Watches the backend's job list and records when scheduled jobs start, so
/// replay can run the same job at the same point.
#[derive(Debug)]
struct JobPoller {
    primary: String,
    api_key: Option<String>,
    /// settings.json to read the key from; a fresh backend only writes it on
    /// first start, which may be after the recorder started.
    settings: Option<PathBuf>,
    interval: Duration,
    traffic: Arc<JsonlWriter>,
    seq: Arc<AtomicU64>,
}

impl JobPoller {
    async fn run(mut self) {
        let client = match reqwest::Client::builder().no_proxy().build() {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("job polling disabled, no HTTP client: {e}");
                return;
            }
        };
        let mut seen: HashMap<String, JobSeen> = HashMap::new();
        let mut initial = true;
        let mut ticker = tokio::time::interval(self.interval);
        loop {
            ticker.tick().await;
            if self.api_key.is_none() {
                self.api_key = self.settings.as_deref().and_then(|p| read_api_key(p).ok());
            }
            let Some(key) = self.api_key.clone() else {
                continue;
            };
            let jobs = match fetch_jobs(&client, &self.primary, &key).await {
                Ok(j) => j,
                Err(e) => {
                    tracing::warn!("job list: {e}");
                    continue;
                }
            };
            self.observe(&jobs, &mut seen, initial, now_ms());
            initial = false;
        }
    }

    /// Emit an event for every job that started since the last poll.
    ///
    /// Three signals, best first: the job's `history.lastStartedAt` (newer
    /// backends), its `nextExecutionTime` moving forward after the old one
    /// passed (scheduled runs on any backend), and `running` turning on.
    fn observe(
        &self,
        jobs: &[serde_json::Value],
        seen: &mut HashMap<String, JobSeen>,
        initial: bool,
        now: i64,
    ) {
        let interval_ms = i64::try_from(self.interval.as_millis()).unwrap_or(i64::MAX);
        for job in jobs {
            let Some(id) = job.get("id").and_then(serde_json::Value::as_str) else {
                continue;
            };
            let current = JobSeen {
                last_start: job
                    .pointer("/history/lastStartedAt")
                    .and_then(serde_json::Value::as_str)
                    .and_then(parse_ms)
                    .unwrap_or(0),
                running: job
                    .get("running")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
                next: job
                    .get("nextExecutionTime")
                    .and_then(serde_json::Value::as_str)
                    .and_then(parse_ms),
            };
            let Some(prev) = seen.get(id).copied().filter(|_| !initial) else {
                seen.insert(id.to_owned(), current);
                continue;
            };
            let mut last_start = prev.last_start.max(current.last_start);
            if current.last_start > prev.last_start {
                self.emit(id, current.last_start);
            } else if let Some(fired) = prev
                .next
                .filter(|&p| current.next != Some(p) && p <= now && p > prev.last_start)
            {
                self.emit(id, fired);
                last_start = fired;
            } else if current.running
                && !prev.running
                && now - prev.last_start > interval_ms.saturating_mul(2)
            {
                // Started, but neither history nor schedule shows it yet.
                self.emit(id, now);
                last_start = now;
            }
            seen.insert(
                id.to_owned(),
                JobSeen {
                    last_start,
                    ..current
                },
            );
        }
    }

    fn emit(&self, job_id: &str, ts_ms: i64) {
        tracing::info!("job started: {job_id}");
        let event = TrafficEvent::Job(JobEvent {
            seq: self.seq.fetch_add(1, Ordering::SeqCst),
            ts_ms,
            job_id: job_id.to_owned(),
        });
        if let Err(e) = self.traffic.write(&event) {
            tracing::error!("writing traffic.jsonl: {e}");
        }
    }
}

async fn fetch_jobs(
    client: &reqwest::Client,
    primary: &str,
    key: &str,
) -> Result<Vec<serde_json::Value>> {
    Ok(client
        .get(format!("{primary}/api/v1/settings/jobs"))
        .header("x-api-key", key)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?)
}

fn parse_ms(s: &str) -> Option<i64> {
    let t = time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339).ok()?;
    i64::try_from(t.unix_timestamp_nanos() / 1_000_000).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn poller(path: &Path) -> Result<JobPoller> {
        Ok(JobPoller {
            primary: String::new(),
            api_key: None,
            settings: None,
            interval: Duration::from_secs(5),
            traffic: Arc::new(JsonlWriter::create(path)?),
            seq: Arc::new(AtomicU64::new(1)),
        })
    }

    fn events(path: &Path) -> Result<Vec<(String, i64)>> {
        Ok(crate::model::read_jsonl::<TrafficEvent>(path)?
            .into_iter()
            .filter_map(|e| match e {
                TrafficEvent::Job(j) => Some((j.job_id, j.ts_ms)),
                TrafficEvent::Http(_) => None,
            })
            .collect())
    }

    #[test]
    fn job_starts_from_history() -> Result<()> {
        let dir = std::env::temp_dir().join(format!("shadow-jobs-h-{}", std::process::id()));
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("traffic.jsonl");
        let p = poller(&path)?;
        let mut seen = HashMap::new();
        let job = |at: &str| serde_json::json!({"id": "radarr-scan", "running": false, "history": {"lastStartedAt": at}});
        let now = parse_ms("2026-10-10T11:00:00Z").context("parse")?;
        p.observe(&[job("2026-10-10T10:00:00.000Z")], &mut seen, true, now);
        p.observe(&[job("2026-10-10T10:00:00.000Z")], &mut seen, false, now);
        p.observe(&[job("2026-10-10T10:15:00.000Z")], &mut seen, false, now);
        let got = events(&path)?;
        assert_eq!(
            got,
            vec![(
                String::from("radarr-scan"),
                parse_ms("2026-10-10T10:15:00Z").context("parse")?
            )],
            "only the second run is new, timed by its history"
        );
        std::fs::remove_dir_all(dir)?;
        Ok(())
    }

    #[test]
    fn job_starts_from_schedule() -> Result<()> {
        let dir = std::env::temp_dir().join(format!("shadow-jobs-s-{}", std::process::id()));
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("traffic.jsonl");
        let p = poller(&path)?;
        let mut seen = HashMap::new();
        let job = |next: &str| serde_json::json!({"id": "download-sync", "running": false, "nextExecutionTime": next});
        let t = |s: &str| parse_ms(s).context("parse");
        p.observe(
            &[job("2026-10-10T10:00:10Z")],
            &mut seen,
            true,
            t("2026-10-10T10:00:05Z")?,
        );
        p.observe(
            &[job("2026-10-10T10:00:10Z")],
            &mut seen,
            false,
            t("2026-10-10T10:00:07Z")?,
        );
        p.observe(
            &[job("2026-10-10T10:00:20Z")],
            &mut seen,
            false,
            t("2026-10-10T10:00:11Z")?,
        );
        p.observe(
            &[job("2026-10-10T10:00:20Z")],
            &mut seen,
            false,
            t("2026-10-10T10:00:13Z")?,
        );
        let got = events(&path)?;
        assert_eq!(
            got,
            vec![(String::from("download-sync"), t("2026-10-10T10:00:10Z")?)],
            "one run, at the time it was scheduled"
        );
        std::fs::remove_dir_all(dir)?;
        Ok(())
    }

    #[test]
    fn reads_api_key() -> Result<()> {
        let dir = std::env::temp_dir().join(format!("shadow-key-{}", std::process::id()));
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("settings.json");
        std::fs::write(&path, r#"{"main":{"apiKey":""}}"#)?;
        assert!(read_api_key(&path).is_err(), "empty key counts as missing");
        std::fs::write(&path, r#"{"main":{"apiKey":"abc"}}"#)?;
        assert_eq!(read_api_key(&path)?, "abc", "key read");
        std::fs::remove_dir_all(dir)?;
        Ok(())
    }
}
