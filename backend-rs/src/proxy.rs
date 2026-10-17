//! Forwarding to the Node server for everything not ported yet.

use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{Context, Result};
use axum::body::Body;
use axum::http::{
    header, HeaderMap, HeaderName, HeaderValue, Request, Response, StatusCode, Uri, Version,
};
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;

/// Headers that describe one hop and are dropped in both directions
/// (RFC 9110 §7.6.1).
const HOP_BY_HOP: [HeaderName; 8] = [
    header::CONNECTION,
    HeaderName::from_static("keep-alive"),
    header::PROXY_AUTHENTICATE,
    header::PROXY_AUTHORIZATION,
    header::TE,
    header::TRAILER,
    header::TRANSFER_ENCODING,
    header::UPGRADE,
];

/// Where the client's address is appended on the way to Node.
const X_FORWARDED_FOR: HeaderName = HeaderName::from_static("x-forwarded-for");

/// Marks a response Node produced (or the 502 for a Node that didn't
/// answer), so outer layers leave it as it is.
#[derive(Debug, Clone, Copy)]
pub struct Forwarded;

/// An HTTP client pointed at the Node server.
#[derive(Debug)]
pub struct NodeProxy {
    client: Client<HttpConnector, Body>,
    base: String,
    /// Node has answered at least once. Express only listens after Node's
    /// startup work is done, so one answer means it is ready.
    answered: AtomicBool,
}

impl NodeProxy {
    /// A proxy for the Node server at `node_url` (`http://host:port`).
    ///
    /// # Errors
    ///
    /// Fails when `node_url` isn't a plain `http://` URL.
    pub fn new(node_url: &str) -> Result<Self> {
        let uri: Uri = node_url
            .parse()
            .with_context(|| format!("FORESEERR_NODE_URL={node_url} is not a URL"))?;
        anyhow::ensure!(
            uri.scheme_str() == Some("http") && uri.host().is_some(),
            "FORESEERR_NODE_URL={node_url} must be an http:// URL with a host"
        );
        let mut connector = HttpConnector::new();
        connector.set_nodelay(true);
        let client = Client::builder(TokioExecutor::new()).build(connector);
        Ok(Self {
            client,
            base: node_url.trim_end_matches('/').to_owned(),
            // Standalone: nothing to wait for; the router never forwards.
            answered: AtomicBool::new(crate::standalone::enabled()),
        })
    }

    /// Whether Node is up. Until it is, nothing is answered natively, so
    /// this server looks as unavailable as Node while Node starts.
    pub fn is_ready(&self) -> bool {
        self.answered.load(Ordering::Relaxed)
    }

    /// Send the request to Node as it arrived and stream the answer back.
    /// `client` is appended to `X-Forwarded-For`.
    pub async fn forward(&self, req: Request<Body>, client: IpAddr) -> Response<Body> {
        let mut res = self.send(req, client).await;
        res.extensions_mut().insert(Forwarded);
        res
    }

    async fn send(&self, mut req: Request<Body>, client: IpAddr) -> Response<Body> {
        let path = req
            .uri()
            .path_and_query()
            .map_or("/", axum::http::uri::PathAndQuery::as_str);
        let target: Uri = match format!("{}{path}", self.base).parse() {
            Ok(uri) => uri,
            Err(e) => {
                tracing::error!("cannot build the Node URL for {path}: {e}");
                return bad_gateway();
            }
        };
        *req.uri_mut() = target;
        *req.version_mut() = Version::HTTP_11;
        strip_hop_by_hop(req.headers_mut());
        append_forwarded_for(req.headers_mut(), client);
        match self.client.request(req).await {
            Ok(res) => {
                self.answered.store(true, Ordering::Relaxed);
                let (mut parts, body) = res.into_parts();
                strip_hop_by_hop(&mut parts.headers);
                Response::from_parts(parts, Body::new(body))
            }
            Err(e) => {
                tracing::error!("Node did not answer: {e}");
                bad_gateway()
            }
        }
    }
}

fn strip_hop_by_hop(headers: &mut HeaderMap) {
    for name in &HOP_BY_HOP {
        headers.remove(name);
    }
}

fn append_forwarded_for(headers: &mut HeaderMap, client: IpAddr) {
    let value = match headers.get(X_FORWARDED_FOR).and_then(|v| v.to_str().ok()) {
        Some(existing) if !existing.is_empty() => format!("{existing}, {client}"),
        Some(_) | None => client.to_string(),
    };
    if let Ok(value) = HeaderValue::from_str(&value) {
        headers.insert(X_FORWARDED_FOR, value);
    }
}

fn bad_gateway() -> Response<Body> {
    let mut res = Response::new(Body::from(r#"{"message":"The backend is not available"}"#));
    *res.status_mut() = StatusCode::BAD_GATEWAY;
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    res
}
