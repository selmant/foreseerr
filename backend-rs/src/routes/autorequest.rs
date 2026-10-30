//! `MediaRequest.request(body, user, { isAutoRequest: true })` for the Plex
//! watchlist sync, through `POST /request`'s port (`requestcreate`) acting
//! as the watchlist's owner.

use std::sync::Arc;

use anyhow::{anyhow, Result};
use axum::http::Method;
use http_body_util::BodyExt;
use serde_json::Value;

use super::{requestcreate, Outcome, Ready};
use crate::auth::Identity;
use crate::settings::Settings;
use crate::state::AppState;

/// How the request went.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutoRequest {
    /// Created (201).
    Created,
    /// Refused the way Node's request errors are answered: 403 for
    /// permissions, quotas and blocklisted titles, 409 for duplicates, 202
    /// when no seasons are left; anything else is an unexpected failure.
    Refused {
        /// The status the route answers with.
        status: u16,
        /// Its `message`.
        message: String,
    },
    /// A case the port leaves to Node (nothing was written).
    Unported(String),
}

/// Create the request as user `user_id`.
///
/// # Errors
///
/// Fails on database errors loading the user.
pub async fn create(
    state: Arc<AppState>,
    settings: Arc<Settings>,
    user_id: i64,
    body: Value,
) -> Result<AutoRequest> {
    let user = match crate::auth::load_user(&state.db, user_id).await? {
        Identity::User(user) => user,
        Identity::Anonymous => return Ok(AutoRequest::Unported(String::from("the user is gone"))),
        Identity::Unportable(why) => return Ok(AutoRequest::Unported(why.to_owned())),
    };
    let (parts, ()) = axum::http::Request::builder()
        .method(Method::POST)
        .uri("/api/v1/request")
        .body(())
        .map_err(|e| anyhow!("{e}"))?
        .into_parts();
    let Value::Object(raw) = body.clone() else {
        return Ok(AutoRequest::Unported(String::from(
            "a body that isn't an object",
        )));
    };
    let ready = Ready {
        state: &state,
        shared: Arc::clone(&state),
        settings,
        user: Some(user),
        req: &parts,
        body: Some(body),
    };
    match requestcreate::create_auto_request(&ready, &raw).await {
        Outcome::Forward(fallback) => Ok(AutoRequest::Unported(fallback.why)),
        Outcome::Done(response) => {
            let status = response.status().as_u16();
            if status == 201 {
                return Ok(AutoRequest::Created);
            }
            let bytes = response
                .into_body()
                .collect()
                .await
                .map(http_body_util::Collected::to_bytes)
                .unwrap_or_default();
            let message = serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_owned))
                .unwrap_or_default();
            Ok(AutoRequest::Refused { status, message })
        }
    }
}
