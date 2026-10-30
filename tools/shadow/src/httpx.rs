//! Small hyper helpers shared by the proxies.

use std::pin::Pin;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll};

use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::Frame;
use tokio::sync::mpsc;

/// Error type carried by proxied bodies.
pub type BoxErr = Box<dyn std::error::Error + Send + Sync>;
/// Response body type used by every handler.
pub type RespBody = BoxBody<Bytes, BoxErr>;

/// A body holding `bytes` in full.
pub fn full(bytes: impl Into<Bytes>) -> RespBody {
    Full::new(bytes.into())
        .map_err(|never| match never {})
        .boxed()
}

/// A plain-text response marked with `x-shadow-error`, so it can't be
/// mistaken for something the backend said.
#[must_use]
pub fn text_response(status: u16, msg: &str) -> hyper::Response<RespBody> {
    let mut resp = hyper::Response::new(full(msg.to_owned()));
    *resp.status_mut() =
        hyper::StatusCode::from_u16(status).unwrap_or(hyper::StatusCode::BAD_GATEWAY);
    let headers = resp.headers_mut();
    headers.insert(
        http::header::CONTENT_TYPE,
        http::HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    headers.insert("x-shadow-error", http::HeaderValue::from_static("1"));
    resp
}

/// Headers that describe one connection and must not be forwarded.
#[must_use]
pub fn is_hop_by_hop(name: &str) -> bool {
    [
        "connection",
        "keep-alive",
        "proxy-connection",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ]
    .iter()
    .any(|h| h.eq_ignore_ascii_case(name))
}

/// Lock a mutex, carrying on with the data if another task panicked while
/// holding it. Everything guarded here stays consistent between statements.
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A response body fed from a channel, so a proxy can stream bytes to the
/// client while keeping a copy.
#[derive(Debug)]
pub struct ChannelBody(pub mpsc::Receiver<Result<Frame<Bytes>, BoxErr>>);

impl hyper::body::Body for ChannelBody {
    type Data = Bytes;
    type Error = BoxErr;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BoxErr>>> {
        self.0.poll_recv(cx)
    }
}

/// Elapsed time in whole milliseconds, saturating.
#[must_use]
pub fn millis(d: std::time::Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}
