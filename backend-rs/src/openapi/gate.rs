//! The validator in front of the router, in Express's order: after the
//! body parsers and the session (whose touch is reproduced), before every
//! `/api/v1` route.
//!
//! `FORESEERR_OPENAPI_VALIDATOR` picks the mode:
//! - `proxy` (default): Node is behind. Rejections are answered here when
//!   they are certainly Node's, everything uncertain goes to Node as
//!   before, and requests that pass reach the native handlers with the
//!   [`Validated`] query and body in the request extensions.
//! - `standalone`: no Node. Every decision is answered here, uncertain
//!   ones included.
//! - `off`: the validator doesn't run (the behaviour before it existed).
//!   Not allowed in standalone mode, whose native routes only answer what
//!   it has validated.

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;

use anyhow::{bail, Result};
use axum::body::Body;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, Response};
use axum::middleware::Next;

use super::{Decision, Rejection, Validated, Validator};
use crate::state::AppState;

/// How the validator's decisions are used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Off,
    Proxy,
    Standalone,
}

impl Mode {
    /// `FORESEERR_OPENAPI_VALIDATOR`; standalone mode defaults to `Standalone`.
    #[must_use]
    pub fn from_env() -> Self {
        match std::env::var("FORESEERR_OPENAPI_VALIDATOR").as_deref() {
            Ok("off") => Self::Off,
            Ok("standalone") => Self::Standalone,
            Ok(_) | Err(_) if crate::standalone::enabled() => Self::Standalone,
            Ok(_) | Err(_) => Self::Proxy,
        }
    }
}

/// The middleware's state.
#[derive(Debug, Clone)]
pub struct Gate {
    validator: Option<Arc<Validator>>,
    mode: Mode,
    state: Arc<AppState>,
}

impl Gate {
    /// Load seerr-api.yml from the app root. Behind Node a spec that can't
    /// be loaded turns the validator off (Node still validates behind it).
    ///
    /// # Errors
    ///
    /// Without Node (standalone mode, or the `standalone` validator mode),
    /// when the spec doesn't load or the validator is `off`.
    pub fn new(state: Arc<AppState>) -> Result<Self> {
        let mode = Mode::from_env();
        if mode == Mode::Off && crate::standalone::enabled() {
            bail!("standalone mode needs the OpenAPI validator (FORESEERR_OPENAPI_VALIDATOR=off)");
        }
        let validator = if mode == Mode::Off {
            None
        } else {
            let path = state.env.app_root.join("seerr-api.yml");
            load(&path, mode)?
        };
        Ok(Self {
            validator,
            mode,
            state,
        })
    }
}

fn load(path: &Path, mode: Mode) -> Result<Option<Arc<Validator>>> {
    match Validator::load(path) {
        Ok(v) => Ok(Some(Arc::new(v))),
        Err(e) if mode == Mode::Standalone => Err(e.context("the OpenAPI validator didn't load")),
        Err(e) => {
            tracing::error!(
                "the OpenAPI validator is off, {} didn't load: {e:#}",
                path.display()
            );
            Ok(None)
        }
    }
}

/// The middleware.
pub async fn gate(
    State(gate): State<Gate>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
    next: Next,
) -> Response<Body> {
    let Some(validator) = gate.validator.as_deref() else {
        return next.run(req).await;
    };
    let under_api = req
        .uri()
        .path()
        .get(..4)
        .is_some_and(|p| p.eq_ignore_ascii_case("/api"));
    if !under_api || !gate.state.env.native_routes() {
        return next.run(req).await;
    }
    let (parts, body) = req.into_parts();
    let (bytes, body) = if Validator::needs_body(&parts.headers) {
        match super::request::buffer(body).await {
            Ok(bytes) => (Some(bytes.clone()), Body::from(bytes)),
            Err(super::request::Unbuffered::TooLarge) => {
                let req = Request::from_parts(parts, Body::empty());
                touch_session(&gate.state, req.headers()).await;
                let rejection = Rejection {
                    status: 413,
                    body: super::request::Unbuffered::too_large_body(),
                };
                return respond(&req, &rejection);
            }
            Err(failed) => return failed.response(&parts.method, &parts.headers),
        }
    } else {
        (None, body)
    };
    let verdict = validator.decide(&parts.method, &parts.uri, &parts.headers, bytes.as_deref());
    let proxy = gate.mode == Mode::Proxy;
    let mut req = Request::from_parts(parts, body);
    if let (Some(why), true) = (&verdict.unsure, proxy) {
        tracing::debug!(
            "{} {} goes to Node: the validator is unsure ({why})",
            req.method(),
            req.uri()
        );
        return gate.state.node.forward(req, peer.ip()).await;
    }
    let unsure = verdict.unsure.is_some();
    match verdict.decision {
        Decision::Unvalidated => next.run(req).await,
        Decision::Pass(validated) => {
            req.extensions_mut().insert::<Validated>(*validated);
            if unsure {
                // What it left may not be Node's (an `Infinity` it can't
                // hold, say): handlers don't read it.
                req.extensions_mut().insert(super::Unsure);
                if verdict.unsure.as_deref() == Some(super::NON_FINITE) {
                    req.extensions_mut().insert(super::NonFiniteOnly);
                }
            }
            next.run(req).await
        }
        Decision::Reject(rejection) => {
            if proxy {
                if let Some(why) = node_answers(&gate.state).await {
                    tracing::debug!("{} {} goes to Node: {why}", req.method(), req.uri());
                    return gate.state.node.forward(req, peer.ip()).await;
                }
            }
            touch_session(&gate.state, req.headers()).await;
            respond(&req, &rejection)
        }
    }
}

/// The conditions under which the native routes hand everything to Node
/// (see `routes::prepare`), checked only for rejections.
async fn node_answers(state: &AppState) -> Option<&'static str> {
    if !state.node.is_ready() {
        return Some("Node has not answered yet");
    }
    match state.settings.current().await {
        Ok(_) => None,
        Err(_) => Some("settings.json is unreadable"),
    }
}

/// express-session touches a stored session on every `/api` response.
async fn touch_session(state: &AppState, headers: &HeaderMap) {
    let Ok(settings) = state.settings.current().await else {
        return;
    };
    if let Err(e) = crate::auth::check_user(&state.db, &settings, headers).await {
        tracing::debug!("touching the session failed: {e:#}");
    }
}

/// The error handler's `res.status(err.status).json({ message, errors })`.
fn respond(req: &Request, rejection: &Rejection) -> Response<Body> {
    let mut res = crate::respond::json_status(
        rejection.status,
        req.method(),
        req.headers(),
        &rejection.body,
    );
    res.extensions_mut()
        .insert(crate::runtime::desktop::Unrouted);
    res
}
