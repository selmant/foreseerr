//! Forward proxy for the backend's outgoing calls (TMDB, Sonarr, Plex, ...).
//!
//! Point the backend's Settings → Network → HTTP(S) proxy at it. HTTPS calls
//! arrive as `CONNECT` tunnels; the proxy terminates TLS with a certificate
//! from [`CertAuthority`] so it can see the request.
//!
//! * **Record** mode forwards every call to the real service and appends it to
//!   `upstream.jsonl`.
//! * **Replay** mode never touches the network. It answers from a recording
//!   and logs what the target asked for, so side effects (adding a series to
//!   Sonarr, sending a notification) are captured instead of performed.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use bytes::Bytes;
use http_body_util::BodyExt;
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper::{Method, Request, Response};
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

use crate::ca::CertAuthority;
use crate::httpx::{full, is_hop_by_hop, lock, millis, text_response, RespBody};
use crate::model::{
    headers_from, now_ms, Body, JsonlWriter, MatchKind, OutgoingCall, UpstreamCall,
};
use crate::urlnorm::{fuzzy_url, normalize_url};

/// State for recording calls to the real services.
#[derive(Debug)]
pub struct RecordMode {
    /// Destination of `upstream.jsonl` lines.
    pub writer: JsonlWriter,
    /// Client used to reach the real services.
    pub client: reqwest::Client,
    /// Next call id.
    pub next_id: AtomicU64,
}

/// What the proxy does with a call.
#[derive(Debug)]
pub enum Mode {
    /// Forward it and write it down.
    Record(RecordMode),
    /// Answer it from a recording.
    Replay(Arc<ReplayTarget>),
}

/// The forward proxy itself.
#[derive(Debug)]
pub struct ForwardProxy {
    /// Mints certificates for intercepted HTTPS hosts.
    pub ca: Arc<CertAuthority>,
    /// Record or replay.
    pub mode: Mode,
    /// Largest body stored in full.
    pub max_body: usize,
    /// Query parameters ignored when matching calls.
    pub ignore_params: Vec<String>,
}

impl ForwardProxy {
    /// Accept connections forever.
    ///
    /// # Errors
    ///
    /// Fails when accepting a connection fails.
    pub async fn serve(self: Arc<Self>, listener: TcpListener) -> Result<()> {
        loop {
            let (stream, _peer) = listener.accept().await?;
            let proxy = Arc::clone(&self);
            tokio::spawn(async move {
                let svc = service_fn(move |req| {
                    let proxy = Arc::clone(&proxy);
                    async move { Ok::<_, hyper::Error>(proxy.handle_outer(req).await) }
                });
                if let Err(e) = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), svc)
                    .with_upgrades()
                    .await
                {
                    tracing::debug!("forward proxy connection: {e}");
                }
            });
        }
    }

    async fn handle_outer(self: Arc<Self>, req: Request<Incoming>) -> Response<RespBody> {
        if req.method() == Method::CONNECT {
            let Some(authority) = req.uri().authority().map(ToString::to_string) else {
                return text_response(400, "CONNECT without host:port");
            };
            tokio::spawn(async move {
                match hyper::upgrade::on(req).await {
                    Ok(upgraded) => {
                        if let Err(e) = Arc::clone(&self).serve_tunnel(upgraded, &authority).await {
                            tracing::debug!("tunnel {authority}: {e}");
                        }
                    }
                    Err(e) => tracing::warn!("CONNECT upgrade failed: {e}"),
                }
            });
            return Response::new(full(Bytes::new()));
        }
        // Plain-HTTP proxying uses absolute-form URIs.
        if req.uri().scheme().is_some() {
            let url = req.uri().to_string();
            return self.handle_call(req, url).await;
        }
        text_response(
            400,
            "this is a forward proxy; send absolute URLs or CONNECT",
        )
    }

    async fn serve_tunnel(
        self: Arc<Self>,
        upgraded: hyper::upgrade::Upgraded,
        authority: &str,
    ) -> Result<()> {
        let host = authority
            .rsplit_once(':')
            .map_or(authority, |(h, _)| h)
            .trim_start_matches('[')
            .trim_end_matches(']');
        let acceptor = TlsAcceptor::from(self.ca.server_config(host)?);
        let tls = acceptor.accept(TokioIo::new(upgraded)).await?;
        let authority = authority.to_owned();
        let svc = service_fn(move |req: Request<Incoming>| {
            let proxy = Arc::clone(&self);
            let authority = authority.clone();
            async move {
                let host = req
                    .headers()
                    .get(http::header::HOST)
                    .and_then(|h| h.to_str().ok())
                    .map_or(authority, str::to_owned);
                let path = req
                    .uri()
                    .path_and_query()
                    .map_or("/", http::uri::PathAndQuery::as_str);
                let url = format!("https://{host}{path}");
                Ok::<_, hyper::Error>(proxy.handle_call(req, url).await)
            }
        });
        hyper::server::conn::http1::Builder::new()
            .serve_connection(TokioIo::new(tls), svc)
            .await?;
        Ok(())
    }

    async fn handle_call(&self, req: Request<Incoming>, url: String) -> Response<RespBody> {
        let (parts, body) = req.into_parts();
        let body = match body.collect().await {
            Ok(b) => b.to_bytes(),
            Err(e) => return text_response(400, &format!("reading request body: {e}")),
        };
        match &self.mode {
            Mode::Record(rec) => self.record_call(rec, parts, body, url).await,
            Mode::Replay(target) => target.answer(&parts.method, &url, &body, self),
        }
    }

    async fn record_call(
        &self,
        rec: &RecordMode,
        parts: http::request::Parts,
        body: Bytes,
        url: String,
    ) -> Response<RespBody> {
        let started = Instant::now();
        let mut call = UpstreamCall {
            id: rec.next_id.fetch_add(1, Ordering::SeqCst),
            ts_ms: now_ms(),
            duration_ms: 0,
            method: parts.method.to_string(),
            url,
            request_headers: headers_from(&parts.headers),
            request_body: Body::capture(&body, self.max_body),
            status: None,
            response_headers: Vec::new(),
            response_body: Body::default(),
            error: None,
        };
        let mut builder = rec.client.request(parts.method, &call.url);
        for (name, value) in &parts.headers {
            let n = name.as_str();
            // Ask for identity encoding so stored bodies stay readable.
            if is_hop_by_hop(n) || n == "host" || n == "content-length" || n == "accept-encoding" {
                continue;
            }
            builder = builder.header(name, value);
        }
        let response = match builder.body(body).send().await {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let headers = headers_from(resp.headers());
                match resp.bytes().await {
                    Ok(bytes) => {
                        call.status = Some(status);
                        call.response_body = Body::capture(&bytes, self.max_body);
                        let r = build_response(status, &headers, bytes);
                        call.response_headers = headers;
                        r
                    }
                    Err(e) => {
                        call.error = Some(format!("reading upstream body: {e}"));
                        text_response(502, &format!("upstream body error: {e}"))
                    }
                }
            }
            Err(e) => {
                let msg = error_chain(&e);
                let r = text_response(502, &format!("upstream error: {msg}"));
                call.error = Some(msg);
                r
            }
        };
        call.duration_ms = millis(started.elapsed());
        if call.response_body.truncated {
            tracing::warn!(
                "{} {}: response body over the capture limit, replay cannot serve it",
                call.method,
                call.url
            );
        }
        if let Err(e) = rec.writer.write(&call) {
            tracing::error!("writing upstream.jsonl: {e}");
        }
        response
    }
}

/// A response with recorded status, headers and body.
#[must_use]
pub fn build_response(
    status: u16,
    headers: &[(String, String)],
    body: Bytes,
) -> Response<RespBody> {
    let mut builder = Response::builder().status(status);
    for (k, v) in headers {
        if is_hop_by_hop(k) || k.eq_ignore_ascii_case("content-length") {
            continue;
        }
        builder = builder.header(k.as_str(), v.as_str());
    }
    builder
        .body(full(body))
        .unwrap_or_else(|_| text_response(502, "bad recorded headers"))
}

/// An error and all of its causes on one line.
#[must_use]
pub fn error_chain(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut src = e.source();
    while let Some(s) = src {
        out.push_str(": ");
        out.push_str(&s.to_string());
        src = s.source();
    }
    out
}

/// Recorded upstream calls indexed three ways, from strict to loose.
#[derive(Debug)]
pub struct ReplayStore {
    /// All recorded calls, oldest first.
    pub calls: Vec<UpstreamCall>,
    exact: HashMap<String, Vec<usize>>,
    by_url: HashMap<String, Vec<usize>>,
    fuzzy: HashMap<String, Vec<usize>>,
}

impl ReplayStore {
    /// Index `calls` for lookup.
    #[must_use]
    pub fn new(mut calls: Vec<UpstreamCall>, ignore_params: &[String]) -> Self {
        calls.sort_by_key(|c| (c.ts_ms, c.id));
        let mut exact: HashMap<String, Vec<usize>> = HashMap::new();
        let mut by_url: HashMap<String, Vec<usize>> = HashMap::new();
        let mut fuzzy: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, c) in calls.iter().enumerate() {
            let url = normalize_url(&c.url, ignore_params);
            exact
                .entry(format!("{} {} {}", c.method, url, c.request_body.sha256))
                .or_default()
                .push(i);
            by_url
                .entry(format!("{} {}", c.method, url))
                .or_default()
                .push(i);
            fuzzy
                .entry(format!("{} {}", c.method, fuzzy_url(&c.url, ignore_params)))
                .or_default()
                .push(i);
        }
        Self {
            calls,
            exact,
            by_url,
            fuzzy,
        }
    }

    fn candidates(
        &self,
        method: &str,
        url: &str,
        body: &[u8],
        ignore: &[String],
    ) -> Option<(MatchKind, &[usize])> {
        let norm = normalize_url(url, ignore);
        let sha = crate::model::sha256_hex(body);
        self.exact
            .get(&format!("{method} {norm} {sha}"))
            .map(|c| (MatchKind::Exact, c.as_slice()))
            .or_else(|| {
                self.by_url
                    .get(&format!("{method} {norm}"))
                    .map(|c| (MatchKind::Url, c.as_slice()))
            })
            .or_else(|| {
                self.fuzzy
                    .get(&format!("{method} {}", fuzzy_url(url, ignore)))
                    .map(|c| (MatchKind::Fuzzy, c.as_slice()))
            })
    }

    fn ts(&self, i: usize) -> i64 {
        self.calls.get(i).map_or(i64::MAX, |c| c.ts_ms)
    }
}

/// How far before an event's recorded start a call may have happened and
/// still be considered part of it.
const MATCH_SLACK_MS: i64 = 1_000;

#[derive(Debug)]
struct ReplayState {
    consumed: HashSet<usize>,
    current_seq: u64,
    current_ts: i64,
    calls: Vec<OutgoingCall>,
    last_activity: Instant,
}

/// One target's view of the recording during replay.
#[derive(Debug)]
pub struct ReplayTarget {
    store: Arc<ReplayStore>,
    state: Mutex<ReplayState>,
}

impl ReplayTarget {
    /// A fresh view: nothing consumed yet.
    #[must_use]
    pub fn new(store: Arc<ReplayStore>) -> Self {
        Self {
            store,
            state: Mutex::new(ReplayState {
                consumed: HashSet::new(),
                current_seq: 0,
                current_ts: 0,
                calls: Vec::new(),
                last_activity: Instant::now(),
            }),
        }
    }

    /// Tell the proxy which recorded event is being replayed, so it serves the
    /// upstream responses that were current at that time.
    pub fn begin_event(&self, seq: u64, ts_ms: i64) {
        let mut s = lock(&self.state);
        s.current_seq = seq;
        s.current_ts = ts_ms;
        s.last_activity = Instant::now();
    }

    /// Outgoing calls logged since the last call to this function.
    pub fn take_calls(&self) -> Vec<OutgoingCall> {
        std::mem::take(&mut lock(&self.state).calls)
    }

    /// Wait until no outgoing call has started for `quiet`, capped at `max`.
    /// Catches work the backend does after it already answered.
    pub async fn wait_quiet(&self, quiet: Duration, max: Duration) {
        let started = Instant::now();
        loop {
            let idle_for = lock(&self.state).last_activity.elapsed();
            if idle_for >= quiet || started.elapsed() >= max {
                return;
            }
            let pause = quiet
                .saturating_sub(idle_for)
                .clamp(Duration::from_millis(5), Duration::from_millis(50));
            tokio::time::sleep(pause).await;
        }
    }

    /// Choose the recorded call that answers this one, if any.
    fn pick(&self, state: &mut ReplayState, cands: &[usize]) -> Option<usize> {
        let t = state.current_ts;
        let next = cands
            .iter()
            .copied()
            .find(|i| !state.consumed.contains(i) && self.store.ts(*i) >= t - MATCH_SLACK_MS);
        if let Some(i) = next {
            state.consumed.insert(i);
            return Some(i);
        }
        // Nothing new: repeat the most recent answer as of this event.
        cands
            .iter()
            .copied()
            .rfind(|&i| self.store.ts(i) <= t)
            .or_else(|| cands.last().copied())
    }

    fn answer(
        &self,
        method: &Method,
        url: &str,
        body: &[u8],
        proxy: &ForwardProxy,
    ) -> Response<RespBody> {
        let method = method.as_str();
        let found = self
            .store
            .candidates(method, url, body, &proxy.ignore_params);
        let mut s = lock(&self.state);
        s.last_activity = Instant::now();
        let (kind, idx) = match found {
            None => (MatchKind::None, None),
            Some((kind, cands)) => (kind, self.pick(&mut s, cands)),
        };
        let call = idx.and_then(|i| self.store.calls.get(i));
        let seq = s.current_seq;
        s.calls.push(OutgoingCall {
            method: method.to_owned(),
            url: url.to_owned(),
            body: Body::capture(body, proxy.max_body),
            matched: if call.is_some() {
                kind
            } else {
                MatchKind::None
            },
            recorded_id: call.map(|c| c.id),
        });
        drop(s);

        let Some(call) = call else {
            tracing::debug!("seq {seq}: unmatched upstream call {method} {url}");
            let mut r = text_response(502, "shadow replay: no recorded response for this call");
            r.headers_mut()
                .insert("x-shadow-unmatched", http::HeaderValue::from_static("1"));
            return r;
        };
        match (call.status, call.response_body.bytes()) {
            (Some(status), Some(bytes)) => {
                build_response(status, &call.response_headers, Bytes::from(bytes))
            }
            (Some(_), None) => {
                text_response(502, "shadow replay: recorded body was too large to keep")
            }
            (None, _) => text_response(
                502,
                &format!(
                    "shadow replay: recorded call failed: {}",
                    call.error.as_deref().unwrap_or("?")
                ),
            ),
        }
    }
}

/// Bind a TCP listener with a readable error.
///
/// # Errors
///
/// Fails when the address is in use or not available.
pub async fn bind(addr: SocketAddr) -> Result<TcpListener> {
    TcpListener::bind(addr)
        .await
        .with_context(|| format!("binding {addr}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(id: u64, ts_ms: i64, url: &str, body: &str) -> UpstreamCall {
        UpstreamCall {
            id,
            ts_ms,
            duration_ms: 1,
            method: "GET".into(),
            url: url.into(),
            request_headers: Vec::new(),
            request_body: Body::capture(b"", 1024),
            status: Some(200),
            response_headers: Vec::new(),
            response_body: Body::capture(body.as_bytes(), 1024),
            error: None,
        }
    }

    #[test]
    fn picks_the_answer_current_at_the_event() {
        let store = Arc::new(ReplayStore::new(
            vec![
                call(1, 1_000, "http://sonarr/api/v3/series", "old"),
                call(2, 10_000, "http://sonarr/api/v3/series", "new"),
            ],
            &[],
        ));
        let target = ReplayTarget::new(Arc::clone(&store));
        let ids = |t: &ReplayTarget| -> Vec<Option<u64>> {
            t.take_calls().iter().map(|c| c.recorded_id).collect()
        };
        let cands = store
            .candidates("GET", "http://sonarr/api/v3/series", b"", &[])
            .map(|(_, c)| c.to_vec())
            .unwrap_or_default();

        target.begin_event(1, 9_500);
        let first = target.pick(&mut lock(&target.state), &cands);
        assert_eq!(
            first,
            Some(1),
            "the later recording is the first unconsumed one in range"
        );
        target.begin_event(2, 20_000);
        let repeat = target.pick(&mut lock(&target.state), &cands);
        assert_eq!(
            repeat,
            Some(1),
            "nothing new after the event: repeat the latest past answer"
        );
        assert!(ids(&target).is_empty(), "pick alone logs nothing");
    }

    #[test]
    fn matching_falls_back_from_exact_to_fuzzy() {
        let store = ReplayStore::new(
            vec![call(
                1,
                0,
                "https://api.themoviedb.org/3/discover/movie?date=2026-10-10&page=1",
                "{}",
            )],
            &[],
        );
        let kind = |url: &str| store.candidates("GET", url, b"", &[]).map(|(k, _)| k);
        assert_eq!(
            kind("https://api.themoviedb.org/3/discover/movie?page=1&date=2026-10-10"),
            Some(MatchKind::Exact),
            "query order doesn't matter"
        );
        assert_eq!(
            kind("https://api.themoviedb.org/3/discover/movie?page=1&date=2026-12-24"),
            Some(MatchKind::Fuzzy),
            "a different date still matches loosely"
        );
        assert_eq!(
            kind("https://api.themoviedb.org/3/discover/movie?page=2&date=2026-10-10"),
            None,
            "a different page does not match"
        );
    }
}
