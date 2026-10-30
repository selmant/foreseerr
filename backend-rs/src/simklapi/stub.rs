//! A Simkl stand-in for tests: a local HTTP server answering through a
//! handler and logging every request.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::{guard, Config};

/// One request the stub received.
#[derive(Debug, Clone)]
pub struct Seen {
    pub path: String,
    /// The query, without the `?` and Simkl's required parameters.
    pub query: String,
    pub authorization: Option<String>,
    pub body: String,
}

impl Seen {
    /// The path and query, as the Node tests log a request.
    #[must_use]
    pub fn call(&self) -> String {
        if self.query.is_empty() {
            self.path.clone()
        } else {
            format!("{}?{}", self.path, self.query)
        }
    }

    /// A form field of the body.
    #[must_use]
    pub fn form(&self, key: &str) -> Option<String> {
        self.body.split('&').find_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            (k == key).then(|| v.replace('+', " ").replace("%3A", ":"))
        })
    }
}

/// A handler's answer: status and JSON body.
pub type Reply = Pin<Box<dyn Future<Output = (u16, Value)> + Send>>;
/// Answers one request.
pub type Handler = Arc<dyn Fn(Seen) -> Reply + Send + Sync>;

/// A Simkl stand-in answering every request through `handler`; the
/// requests it saw, in order.
pub struct Stub {
    base: String,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl std::fmt::Debug for Stub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Stub")
            .field("base", &self.base)
            .finish_non_exhaustive()
    }
}

impl Stub {
    /// Listens on a free local port.
    ///
    /// # Errors
    ///
    /// The port could not be bound.
    pub async fn start(handler: Handler) -> std::io::Result<Self> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", listener.local_addr()?);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let handler = Arc::clone(&handler);
                let log = Arc::clone(&log);
                tokio::spawn(async move {
                    let Some(request) = read_request(&mut stream).await else {
                        return;
                    };
                    guard(&log).push(request.clone());
                    let (status, body) = handler(request).await;
                    let body = body.to_string();
                    let reply = format!(
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    stream.write_all(reply.as_bytes()).await.ok();
                });
            }
        });
        Ok(Self { base, seen })
    }

    /// The paths requested, in order.
    #[must_use]
    pub fn paths(&self) -> Vec<String> {
        guard(&self.seen).iter().map(|s| s.path.clone()).collect()
    }

    /// The requests, in order.
    #[must_use]
    pub fn requests(&self) -> Vec<Seen> {
        guard(&self.seen).clone()
    }
}

async fn read_request(stream: &mut tokio::net::TcpStream) -> Option<Seen> {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buffer.extend_from_slice(chunk.get(..n)?);
        let text = String::from_utf8_lossy(&buffer).into_owned();
        let Some((head, body)) = text.split_once("\r\n\r\n") else {
            continue;
        };
        let length = head
            .lines()
            .find_map(|l| {
                let (k, v) = l.split_once(':')?;
                k.eq_ignore_ascii_case("content-length")
                    .then(|| v.trim().parse::<usize>().ok())
                    .flatten()
            })
            .unwrap_or(0);
        if body.len() < length {
            continue;
        }
        let target = head.lines().next()?.split(' ').nth(1)?;
        let authorization = head.lines().find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.eq_ignore_ascii_case("authorization")
                .then(|| v.trim().to_owned())
        });
        let (path, query) = target.split_once('?').unwrap_or((target, ""));
        let query: Vec<&str> = query
            .split('&')
            .filter(|pair| {
                let key = pair.split_once('=').map_or(*pair, |(k, _)| k);
                !pair.is_empty() && !["client_id", "app-name", "app-version"].contains(&key)
            })
            .collect();
        return Some(Seen {
            path: path.to_owned(),
            query: query.join("&"),
            authorization,
            body: body.to_owned(),
        });
    }
}

/// A handler answering synchronously.
pub fn handler<F>(f: F) -> Handler
where
    F: Fn(&Seen) -> (u16, Value) + Send + Sync + 'static,
{
    Arc::new(move |seen| {
        let answer = f(&seen);
        Box::pin(async move { answer })
    })
}

/// A client configuration pointed at `stub`.
#[must_use]
pub fn config(stub: &Stub) -> Config {
    if rustls::crypto::ring::default_provider()
        .install_default()
        .is_err()
    {
        tracing::trace!("a provider was installed");
    }
    Config::new(&reqwest::Client::new(), "test-client", "1.0.0", None).with_base(&stub.base)
}
