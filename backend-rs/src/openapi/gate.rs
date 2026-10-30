//! The validator in front of the router, in Express's order: after the
//! body parsers and the session (whose touch is reproduced), before every
//! `/api/v1` route.
//!
//! Every decision is answered here: rejections as the validator's error
//! handler words them, and requests that pass reach the handlers with the
//! [`Validated`] query and body in the request extensions. Requests the
//! validator is unsure of carry [`super::Unsure`], so handlers don't read
//! what it left. It always runs: the handlers only answer what it has
//! validated.

use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Response};
use axum::middleware::Next;

use super::{Decision, Rejection, Validated, Validator};
use crate::state::AppState;

/// The middleware's state.
#[derive(Debug, Clone)]
pub struct Gate {
    validator: Arc<Validator>,
    state: Arc<AppState>,
}

impl Gate {
    /// Load seerr-api.yml from the app root.
    ///
    /// # Errors
    ///
    /// When the spec doesn't load.
    pub fn new(state: Arc<AppState>) -> Result<Self> {
        let path = state.env.app_root.join("seerr-api.yml");
        let validator = load(&path)?;
        Ok(Self { validator, state })
    }
}

fn load(path: &Path) -> Result<Arc<Validator>> {
    Validator::load(path)
        .map(Arc::new)
        .context("the OpenAPI validator didn't load")
}

/// The middleware.
pub async fn gate(State(gate): State<Gate>, req: Request, next: Next) -> Response<Body> {
    let validator = &gate.validator;
    let under_api = req
        .uri()
        .path()
        .get(..4)
        .is_some_and(|p| p.eq_ignore_ascii_case("/api"));
    if !under_api {
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
    let mut req = Request::from_parts(parts, body);
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
            touch_session(&gate.state, req.headers()).await;
            respond(&req, &rejection)
        }
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
