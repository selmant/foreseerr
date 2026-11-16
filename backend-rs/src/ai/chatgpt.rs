//! Sign in with `ChatGPT` for open-source apps: the user's `ChatGPT` plan pays
//! for Responses API requests.
//!
//! The flow follows <https://developers.openai.com/siwc/token-sharing-open-source>:
//! dynamic client registration on first sign-in (`dynamic_agent_client`),
//! PKCE (S256), an ID token checked against `OpenAI`'s `JWKS`, the plan scope
//! checked before use, rotating refresh tokens replaced as a set under a
//! per-connection lock, and revocation on sign-out.
//!
//! `OpenAI` only accepts a loopback redirect (`http://127.0.0.1:<port>/auth/callback`).
//! A server can't receive that callback, so the browser ends on a page
//! that doesn't load and the user pastes its address back into Foreseerr,
//! which finishes the exchange here. The PKCE verifier never leaves the
//! server, so the pasted code is useless to anyone else.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use base64::prelude::*;
use ring::rand::{SecureRandom, SystemRandom};
use serde_json::{json, Value};

use super::store::{self, Connection, Credentials, Identity, Owner, Status, TokenSet};
use super::AiError;
use crate::sync::lock;
use crate::vault::{Secret, Vault};

const ISSUER: &str = "https://auth.openai.com";
const AUTHORIZE_URL: &str = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL: &str = "https://auth.openai.com/api/accounts/oauth/token";
const REVOKE_URL: &str = "https://auth.openai.com/api/accounts/oauth/revoke";
const JWKS_URL: &str = "https://auth.openai.com/.well-known/jwks.json";
/// The Responses API base, also the token `resource`.
pub const API_BASE: &str = "https://api.openai.com/v1";
/// The loopback callback `OpenAI` requires. Nothing listens there; the user
/// copies the address the browser lands on.
pub const REDIRECT_URI: &str = "http://127.0.0.1:1455/auth/callback";
const SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
/// The scope that allows using the `ChatGPT` plan.
const PLAN_SCOPE: &str = "chatgpt.tokens.use.direct";
const FIRST_CLIENT: &str = "dynamic_agent_client";
const AGENT_NAME: &str = "Foreseerr";
/// How long a started sign-in stays valid.
const ATTEMPT_TTL: Duration = Duration::from_mins(15);
/// Started sign-ins one user may have open at once.
const ATTEMPTS_PER_USER: usize = 3;
/// Refresh this long before the access token expires.
const REFRESH_MARGIN_SECS: i64 = 300;
/// Clock skew allowed on ID token expiry.
const SKEW_SECS: i64 = 120;
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);

/// A started sign-in, kept in memory until the user pastes the callback.
#[derive(Debug)]
struct Attempt {
    owner: Owner,
    started_by: i64,
    verifier: String,
    nonce: String,
    /// The issued client id for a returning account, else `None`
    /// (dynamic registration).
    client_id: Option<String>,
    /// The verified subject a returning account must match.
    subject: Option<String>,
    created: Instant,
}

static ATTEMPTS: LazyLock<Mutex<HashMap<String, Attempt>>> = LazyLock::new(Mutex::default);

/// One refresh at a time per connection: refresh tokens rotate.
static REFRESHING: LazyLock<Mutex<HashMap<i64, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(Mutex::default);

fn session_gate(id: i64) -> Arc<tokio::sync::Mutex<()>> {
    Arc::clone(lock(&REFRESHING).entry(id).or_default())
}

/// `OpenAI`'s signing keys, with when they were fetched.
static JWKS: LazyLock<Mutex<Option<(Instant, Value)>>> = LazyLock::new(Mutex::default);
const JWKS_TTL: Duration = Duration::from_hours(1);

fn random_token(bytes: usize) -> Result<String, AiError> {
    let mut buf = vec![0u8; bytes];
    SystemRandom::new()
        .fill(&mut buf)
        .map_err(|_| AiError::internal("the system random source failed"))?;
    Ok(BASE64_URL_SAFE_NO_PAD.encode(buf))
}

fn now_secs() -> i64 {
    crate::clock::now_millis() / 1000
}

/// What starting a sign-in returns.
#[derive(Debug)]
pub struct Started {
    /// Open this in the browser.
    pub authorize_url: String,
}

/// Begin a sign-in for `owner`, started by `user_id`. A returning account
/// reuses its issued client id (no new registration, no consent screen).
///
/// # Errors
///
/// Fails when too many sign-ins are open or randomness fails.
pub fn start(
    owner: Owner,
    user_id: i64,
    host_id: &str,
    existing: Option<&Connection>,
    force_consent: bool,
) -> Result<Started, AiError> {
    let state = random_token(32)?;
    let nonce = random_token(32)?;
    let verifier = random_token(48)?;
    let challenge = BASE64_URL_SAFE_NO_PAD.encode(ring::digest::digest(
        &ring::digest::SHA256,
        verifier.as_bytes(),
    ));
    let returning = existing.and_then(|c| c.client_id.clone().map(|id| (id, c)));
    let mut url = reqwest::Url::parse(AUTHORIZE_URL)
        .map_err(|_| AiError::internal("the authorize URL doesn't parse"))?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("response_type", "code");
        if let Some((client_id, conn)) = &returning {
            q.append_pair("client_id", client_id);
            if let Some(email) = conn.account_email.as_deref() {
                q.append_pair("login_hint", email);
            }
        } else {
            q.append_pair("client_id", FIRST_CLIENT);
            q.append_pair("agent_name_hint", AGENT_NAME);
        }
        q.append_pair("ext_agent_host_id", host_id);
        q.append_pair("redirect_uri", REDIRECT_URI);
        q.append_pair("scope", SCOPES);
        q.append_pair("resource", API_BASE);
        q.append_pair("state", &state);
        q.append_pair("nonce", &nonce);
        q.append_pair("code_challenge_method", "S256");
        q.append_pair("code_challenge", &challenge);
        if force_consent {
            q.append_pair("prompt", "consent");
        }
    }
    let mut attempts = lock(&ATTEMPTS);
    attempts.retain(|_, a| a.created.elapsed() < ATTEMPT_TTL);
    let open = attempts
        .values()
        .filter(|a| a.started_by == user_id)
        .count();
    if open >= ATTEMPTS_PER_USER {
        // Drop this user's oldest attempt rather than refuse: a user who
        // closed the dialog and tries again shouldn't be stuck.
        if let Some(oldest) = attempts
            .iter()
            .filter(|(_, a)| a.started_by == user_id)
            .min_by_key(|(_, a)| a.created)
            .map(|(k, _)| k.clone())
        {
            attempts.remove(&oldest);
        }
    }
    attempts.insert(
        state,
        Attempt {
            owner,
            started_by: user_id,
            verifier,
            nonce,
            client_id: returning.as_ref().map(|(id, _)| id.clone()),
            subject: returning.and_then(|(_, c)| c.account_subject.clone()),
            created: Instant::now(),
        },
    );
    drop(attempts);
    Ok(Started {
        authorize_url: url.into(),
    })
}

/// The query of what the user pasted: the whole callback address, or
/// just its query string.
fn callback_params(pasted: &str) -> Option<HashMap<String, String>> {
    let pasted = pasted.trim();
    let normalized = if pasted.starts_with("127.0.0.1:") {
        format!("http://{pasted}")
    } else {
        pasted.to_owned()
    };
    let url = reqwest::Url::parse(&normalized).ok().or_else(|| {
        let query = pasted.trim_start_matches('?');
        reqwest::Url::parse(&format!("http://127.0.0.1/?{query}")).ok()
    })?;
    let params: HashMap<String, String> = url.query_pairs().into_owned().collect();
    ["state", "code", "error"]
        .iter()
        .any(|k| params.contains_key(*k))
        .then_some(params)
}

/// What finishing a sign-in stored.
#[derive(Debug)]
pub struct Finished {
    /// Whose connection it is.
    pub owner: Owner,
    /// Login revision, unaffected by token refresh.
    pub session_version: i64,
    /// Whether the `ChatGPT` plan may be used (the scope was granted).
    pub plan_enabled: bool,
}

/// Finish a sign-in with the address the browser landed on.
///
/// # Errors
///
/// Fails when the attempt is unknown, expired or another user's, the user
/// declined, the exchange fails, or the ID token doesn't verify.
pub async fn complete(
    client: &reqwest::Client,
    db: &crate::db::Db,
    vault: &Vault,
    user_id: i64,
    pasted: &str,
    model: Option<String>,
) -> Result<Finished, AiError> {
    let params = callback_params(pasted).ok_or_else(|| {
        AiError::input("That doesn't look like the address from the sign-in page. Copy the whole address from the browser's address bar.")
    })?;
    if !params.contains_key("code") && !params.contains_key("error") {
        return Err(AiError::input(
            "The pasted address is incomplete. Copy the whole address.",
        ));
    }
    let state = params.get("state").ok_or_else(|| {
        AiError::input("The pasted address has no state. Copy the whole address.")
    })?;
    let attempt = {
        let mut attempts = lock(&ATTEMPTS);
        attempts.retain(|_, a| a.created.elapsed() < ATTEMPT_TTL);
        match attempts.get(state) {
            Some(a) if a.started_by == user_id => attempts.remove(state),
            Some(_) | None => None,
        }
    }
    .ok_or_else(|| AiError::input("This sign-in expired or was started elsewhere. Start again."))?;
    if let Some(error) = params.get("error") {
        return Err(if error == "access_denied" {
            AiError::input("Sign-in was cancelled in ChatGPT.")
        } else {
            AiError::input(format!("ChatGPT sign-in failed ({error})."))
        });
    }
    let code = params
        .get("code")
        .ok_or_else(|| AiError::input("The pasted address has no code. Copy the whole address."))?;
    let client_id =
        match (&attempt.client_id, params.get("client_id")) {
            (Some(saved), Some(given)) if saved != given => return Err(AiError::input(
                "ChatGPT returned a different app registration than this account's. Start again.",
            )),
            (Some(saved), _) => saved.clone(),
            (None, Some(given)) if given != FIRST_CLIENT => given.clone(),
            (None, Some(_) | None) => {
                return Err(AiError::input(
                    "ChatGPT didn't finish registering Foreseerr. Start again.",
                ))
            }
        };
    let response = token_request(
        client,
        &[
            ("grant_type", "authorization_code"),
            ("client_id", &client_id),
            ("code", code),
            ("code_verifier", &attempt.verifier),
            ("redirect_uri", REDIRECT_URI),
            ("resource", API_BASE),
        ],
    )
    .await?;
    let tokens = token_set(&response, None)?;
    let claims =
        verify_id_token(client, tokens.id_token.expose(), &client_id, &attempt.nonce).await?;
    let subject = claim(&claims, "sub")
        .ok_or_else(|| AiError::upstream("The ChatGPT ID token has no subject."))?;
    let different_account = || {
        AiError::input(
            "You signed in to a different ChatGPT account than the connected one. Disconnect first to switch accounts.",
        )
    };
    if attempt.subject.as_deref().is_some_and(|s| s != subject) {
        revoke_token(client, &tokens.refresh_token, &client_id).await;
        return Err(different_account());
    }
    let plan_enabled = tokens.scopes.iter().any(|s| s == PLAN_SCOPE);
    // Checked again under the write lock, against what's stored now: two
    // first-time sign-ins can't have the later one replace the earlier
    // account's tokens without revoking them.
    let held = store::lock().await;
    let current = match store::load(db, attempt.owner).await {
        Ok(current) => current,
        Err(e) => {
            drop(held);
            revoke_token(client, &tokens.refresh_token, &client_id).await;
            return Err(AiError::internal(format!("{e:#}")));
        }
    };
    if current
        .as_ref()
        .filter(|c| c.kind == store::Kind::ChatGpt)
        .and_then(|c| c.account_subject.as_deref())
        .is_some_and(|s| s != subject)
    {
        drop(held);
        revoke_token(client, &tokens.refresh_token, &client_id).await;
        return Err(different_account());
    }
    if current.as_ref().is_some_and(|c| {
        c.kind == store::Kind::ChatGpt
            && c.has_credentials()
            && c.client_id.as_deref() != Some(client_id.as_str())
    }) {
        drop(held);
        revoke_token(client, &tokens.refresh_token, &client_id).await;
        return Err(AiError::input(
            "Another ChatGPT sign-in finished first. Start again.",
        ));
    }
    let refresh = tokens.refresh_token.clone();
    let saved = store::save(
        db,
        vault,
        attempt.owner,
        store::Write {
            kind: store::Kind::ChatGpt,
            base_url: None,
            model,
            credentials: Some(Some(Credentials::ChatGpt(tokens))),
            identity: Some(Identity {
                client_id: client_id.clone(),
                subject,
                email: claim(&claims, "email"),
                name: claim(&claims, "name"),
            }),
            status: if plan_enabled {
                Status::Ok
            } else {
                Status::PlanDisabled
            },
        },
        &held,
    )
    .await;
    drop(held);
    if let Err(e) = saved {
        // Tokens that couldn't be kept shouldn't stay live at OpenAI.
        revoke_token(client, &refresh, &client_id).await;
        return Err(AiError::internal(format!(
            "saving the connection failed: {e:#}"
        )));
    }
    Ok(Finished {
        owner: attempt.owner,
        session_version: current.as_ref().map_or(0, |c| c.session_version + 1),
        plan_enabled,
    })
}

fn claim(claims: &Value, key: &str) -> Option<String> {
    claims
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn form_body(fields: &[(&str, &str)]) -> String {
    fields
        .iter()
        .map(|(k, v)| {
            format!(
                "{}={}",
                crate::jsval::form_encode(k),
                crate::jsval::form_encode(v)
            )
        })
        .collect::<Vec<_>>()
        .join("&")
}

/// POST to the token endpoint. Errors carry `OpenAI`'s `error` code.
async fn token_request(
    client: &reqwest::Client,
    fields: &[(&str, &str)],
) -> Result<Value, AiError> {
    let res = client
        .post(TOKEN_URL)
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .header(reqwest::header::ACCEPT, "application/json")
        .timeout(HTTP_TIMEOUT)
        .body(form_body(fields))
        .send()
        .await
        .map_err(|_| AiError::network("ChatGPT's sign-in service couldn't be reached."))?;
    let status = res.status();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(body);
    }
    let code = body
        .get("error")
        .and_then(|e| e.as_str().or_else(|| e.get("code").and_then(Value::as_str)))
        .unwrap_or("unknown_error")
        .to_owned();
    Err(AiError::token(code, status.as_u16()))
}

/// The token set in a token response; `previous` supplies an ID token
/// when a refresh response has none.
fn token_set(body: &Value, previous: Option<&TokenSet>) -> Result<TokenSet, AiError> {
    let text = |key: &str| {
        body.get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    };
    let access = text("access_token")
        .ok_or_else(|| AiError::upstream("ChatGPT returned no access token."))?;
    let refresh = text("refresh_token")
        .ok_or_else(|| AiError::upstream("ChatGPT returned no refresh token."))?;
    let id_token = text("id_token")
        .map(|t| Secret::new(t.to_owned()))
        .or_else(|| previous.map(|p| p.id_token.clone()))
        .ok_or_else(|| AiError::upstream("ChatGPT returned no ID token."))?;
    let expires_in = body
        .get("expires_in")
        .and_then(Value::as_i64)
        .unwrap_or(3600);
    let scopes = text("scope")
        .map(|s| s.split_whitespace().map(str::to_owned).collect())
        .or_else(|| previous.map(|p| p.scopes.clone()))
        .unwrap_or_default();
    Ok(TokenSet {
        access_token: Secret::new(access.to_owned()),
        refresh_token: Secret::new(refresh.to_owned()),
        id_token,
        expires_at: now_secs().saturating_add(expires_in),
        scopes,
    })
}

async fn jwks(client: &reqwest::Client, refetch: bool) -> Result<Value, AiError> {
    if !refetch {
        if let Some((at, keys)) = lock(&JWKS).as_ref() {
            if at.elapsed() < JWKS_TTL {
                return Ok(keys.clone());
            }
        }
    }
    let keys: Value = client
        .get(JWKS_URL)
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|_| AiError::network("OpenAI's signing keys couldn't be fetched."))?
        .json()
        .await
        .map_err(|_| AiError::upstream("OpenAI's signing keys didn't parse."))?;
    *lock(&JWKS) = Some((Instant::now(), keys.clone()));
    Ok(keys)
}

fn b64(part: &str) -> Result<Vec<u8>, AiError> {
    BASE64_URL_SAFE_NO_PAD
        .decode(part.trim_end_matches('='))
        .map_err(|_| AiError::upstream("The ChatGPT ID token is malformed."))
}

/// Verify an ID token's RS256 signature against `OpenAI`'s keys and check
/// issuer, audience, expiry and nonce. Returns its claims.
async fn verify_id_token(
    client: &reqwest::Client,
    token: &str,
    client_id: &str,
    nonce: &str,
) -> Result<Value, AiError> {
    let mut parts = token.split('.');
    let (Some(head), Some(body), Some(sig), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(AiError::upstream("The ChatGPT ID token is malformed."));
    };
    let header: Value = serde_json::from_slice(&b64(head)?)
        .map_err(|_| AiError::upstream("The ChatGPT ID token is malformed."))?;
    if header.get("alg").and_then(Value::as_str) != Some("RS256") {
        return Err(AiError::upstream("The ChatGPT ID token isn't RS256."));
    }
    let kid = header.get("kid").and_then(Value::as_str).unwrap_or("");
    let find = |keys: &Value| {
        keys.get("keys")
            .and_then(Value::as_array)
            .and_then(|ks| {
                ks.iter()
                    .find(|k| k.get("kid").and_then(Value::as_str) == Some(kid))
            })
            .cloned()
    };
    let key = match find(&jwks(client, false).await?) {
        Some(key) => key,
        None => find(&jwks(client, true).await?)
            .ok_or_else(|| AiError::upstream("The ChatGPT ID token's key is unknown."))?,
    };
    let n = b64(key.get("n").and_then(Value::as_str).unwrap_or(""))?;
    let e = b64(key.get("e").and_then(Value::as_str).unwrap_or(""))?;
    let signed = format!("{head}.{body}");
    ring::signature::RsaPublicKeyComponents { n: &n, e: &e }
        .verify(
            &ring::signature::RSA_PKCS1_2048_8192_SHA256,
            signed.as_bytes(),
            &b64(sig)?,
        )
        .map_err(|_| AiError::upstream("The ChatGPT ID token's signature doesn't verify."))?;
    let claims: Value = serde_json::from_slice(&b64(body)?)
        .map_err(|_| AiError::upstream("The ChatGPT ID token is malformed."))?;
    check_claims(&claims, client_id, nonce, now_secs())?;
    Ok(claims)
}

fn check_claims(claims: &Value, client_id: &str, nonce: &str, now: i64) -> Result<(), AiError> {
    if claims.get("iss").and_then(Value::as_str) != Some(ISSUER) {
        return Err(AiError::upstream(
            "The ChatGPT ID token has the wrong issuer.",
        ));
    }
    let aud_ok = match claims.get("aud") {
        Some(Value::String(a)) => a == client_id,
        Some(Value::Array(list)) => list.iter().any(|a| a.as_str() == Some(client_id)),
        Some(_) | None => false,
    };
    if !aud_ok {
        return Err(AiError::upstream(
            "The ChatGPT ID token is for another app.",
        ));
    }
    let exp = claims.get("exp").and_then(Value::as_i64).unwrap_or(0);
    if exp.saturating_add(SKEW_SECS) < now {
        return Err(AiError::upstream("The ChatGPT ID token expired."));
    }
    if claims.get("nonce").and_then(Value::as_str) != Some(nonce) {
        return Err(AiError::upstream(
            "The ChatGPT ID token doesn't match this sign-in.",
        ));
    }
    Ok(())
}

/// Refresh-token errors after which the token set is unusable.
const TERMINAL_REFRESH: &[&str] = &[
    "invalid_grant",
    "invalid_refresh_token",
    "token_expired",
    "refresh_token_expired",
    "refresh_token_invalidated",
    "refresh_token_reused",
];

/// A usable access token for this `ChatGPT` connection, refreshed first when
/// it's about to expire. A refresh that can't succeed marks the connection
/// for a new sign-in.
///
/// # Errors
///
/// Fails when the connection isn't usable or the refresh fails.
pub async fn access_token(
    client: &reqwest::Client,
    db: &crate::db::Db,
    vault: &Vault,
    conn: &Connection,
) -> Result<Secret, AiError> {
    let tokens = tokens_of(vault, conn)?;
    if tokens.expires_at.saturating_sub(now_secs()) > REFRESH_MARGIN_SECS {
        return Ok(tokens.access_token);
    }
    let gate = session_gate(conn.id);
    let _held = gate.lock().await;
    // Another request may have refreshed while this one waited.
    let fresh = store::load(db, conn.owner)
        .await
        .map_err(|e| AiError::internal(format!("{e:#}")))?
        .ok_or_else(AiError::not_configured)?;
    if fresh.id != conn.id || fresh.session_version != conn.session_version {
        return Err(AiError::reauth(
            "This ChatGPT connection changed. Try again.",
        ));
    }
    let tokens = tokens_of(vault, &fresh)?;
    if tokens.expires_at.saturating_sub(now_secs()) > REFRESH_MARGIN_SECS {
        return Ok(tokens.access_token);
    }
    let client_id = fresh.client_id.clone().ok_or_else(|| {
        AiError::reauth("This ChatGPT connection has no registration. Sign in again.")
    })?;
    let result = token_request(
        client,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", &client_id),
            ("refresh_token", tokens.refresh_token.expose()),
            ("resource", API_BASE),
        ],
    )
    .await;
    match result {
        Ok(body) => {
            let next = token_set(&body, Some(&tokens))?;
            // The same scope check as after sign-in: a refresh that comes
            // back without plan access can't be used for requests.
            let plan_enabled = next.scopes.iter().any(|s| s == PLAN_SCOPE);
            let status = if plan_enabled {
                Status::Ok
            } else {
                Status::PlanDisabled
            };
            let written = store::replace_tokens(db, vault, &fresh, &next, status)
                .await
                .map_err(|e| AiError::internal(format!("{e:#}")))?;
            if !written {
                // Signed out or signed in again meanwhile: these tokens
                // belong to a session that's no longer stored.
                revoke_token(client, &next.refresh_token, &client_id).await;
                return Err(AiError::reauth(
                    "This ChatGPT connection changed while it was in use. Try again.",
                ));
            }
            if !plan_enabled {
                return Err(AiError::reauth(
                    "ChatGPT plan use is no longer allowed for Foreseerr. Sign in again and allow it.",
                ));
            }
            Ok(next.access_token)
        }
        Err(e)
            if e.token_code()
                .is_some_and(|c| TERMINAL_REFRESH.contains(&c)) =>
        {
            if let Err(err) = store::set_status(
                db,
                &fresh,
                Status::Reauth,
                Some("ChatGPT ended this session. Sign in again."),
                true,
            )
            .await
            {
                tracing::warn!("marking a ChatGPT connection for sign-in failed: {err:#}");
            }
            Err(AiError::reauth(
                "ChatGPT ended this session. Sign in again.",
            ))
        }
        Err(e) => Err(e),
    }
}

fn tokens_of(vault: &Vault, conn: &Connection) -> Result<TokenSet, AiError> {
    match conn.status {
        Status::Ok => {}
        Status::Reauth | Status::SignedOut => {
            return Err(AiError::reauth(
                "Sign in to ChatGPT again to use this connection.",
            ))
        }
        Status::PlanDisabled => {
            return Err(AiError::reauth(
                "ChatGPT plan use wasn't allowed for Foreseerr. Sign in again and allow it.",
            ))
        }
    }
    match conn.credentials(vault) {
        Ok(Some(Credentials::ChatGpt(t))) => Ok(t),
        Ok(Some(Credentials::ApiKey(_)) | None) => Err(AiError::reauth(
            "Sign in to ChatGPT again to use this connection.",
        )),
        Err(e) => {
            tracing::error!("AI credentials didn't open: {e:#}");
            Err(AiError::internal(
                "Saved credentials couldn't be decrypted (was the secret key changed?). Sign in again.",
            ))
        }
    }
}

/// Revoke one refresh token at `OpenAI`, retrying transient failures.
/// Returns whether `OpenAI` confirmed it.
pub async fn revoke_token(
    client: &reqwest::Client,
    refresh_token: &Secret,
    client_id: &str,
) -> bool {
    let body = form_body(&[
        ("token", refresh_token.expose()),
        ("token_type_hint", "refresh_token"),
        ("client_id", client_id),
    ]);
    for attempt in 0..3u64 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(500 * attempt)).await;
        }
        let sent = client
            .post(REVOKE_URL)
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/x-www-form-urlencoded",
            )
            .timeout(HTTP_TIMEOUT)
            .body(body.clone())
            .send()
            .await;
        match sent {
            Ok(res) if res.status().is_success() => return true,
            Ok(res) if res.status().is_client_error() => return false,
            Ok(_) | Err(_) => {}
        }
    }
    false
}

/// Revoke a connection's renewable session at `OpenAI`.
///
/// Returns whether that's confirmed: true only when `OpenAI` confirmed it
/// or nothing was stored to revoke; false when the credentials don't open
/// (the secret key changed) or have no registration, since nothing was sent.
pub async fn revoke(client: &reqwest::Client, vault: &Vault, conn: &Connection) -> bool {
    match (conn.credentials(vault), conn.client_id.as_deref()) {
        (Ok(Some(Credentials::ChatGpt(tokens))), Some(client_id)) => {
            revoke_token(client, &tokens.refresh_token, client_id).await
        }
        (Ok(None | Some(Credentials::ApiKey(_))), _) => true,
        (Ok(Some(Credentials::ChatGpt(_))), None) | (Err(_), _) => false,
    }
}

/// Sign out: detach the stored session atomically, then revoke it at `OpenAI`.
///
/// The registration is kept for the next sign-in. Returns whether `OpenAI`
/// confirmed the revocation. A sign-in that lands while the revocation is
/// pending is kept: the local update only applies to the tokens it revoked.
///
/// # Errors
///
/// Fails when the local update fails.
pub async fn sign_out(
    client: &reqwest::Client,
    db: &crate::db::Db,
    vault: &Vault,
    conn: &Connection,
) -> anyhow::Result<bool> {
    let gate = session_gate(conn.id);
    let _held = gate.lock().await;
    let Some(current) = store::take_session_for_signout(db, conn).await? else {
        return Ok(true);
    };
    let confirmed = revoke(client, vault, &current).await;
    Ok(confirmed)
}

/// The account's model catalog, as `(slug, display name)` in `OpenAI`'s order.
///
/// # Errors
///
/// Fails when the request fails.
pub async fn models(
    client: &reqwest::Client,
    token: &Secret,
) -> Result<Vec<(String, String)>, AiError> {
    let res = client
        .get(format!("{API_BASE}/models"))
        .bearer_auth(token.expose())
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .map_err(|_| AiError::network("OpenAI couldn't be reached."))?;
    let status = res.status();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(super::responses::error_of(status.as_u16(), &body));
    }
    Ok(body
        .get("models")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter(|m| {
                    m.get("visibility")
                        .and_then(Value::as_str)
                        .is_none_or(|v| v == "list")
                })
                .filter_map(|m| {
                    let slug = m.get("slug").and_then(Value::as_str)?;
                    let name = m
                        .get("display_name")
                        .and_then(Value::as_str)
                        .unwrap_or(slug);
                    Some((slug.to_owned(), name.to_owned()))
                })
                .collect()
        })
        .unwrap_or_default())
}

/// The connection as its owner sees it.
#[must_use]
pub fn describe(conn: &Connection) -> Value {
    json!({
        "accountEmail": conn.account_email,
        "accountName": conn.account_name,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_pasted_callbacks() {
        let full = "http://127.0.0.1:1455/auth/callback?code=abc&scope=openid+email&state=xyz&client_id=oaiapp_1";
        let p = callback_params(full).unwrap_or_default();
        assert_eq!(p.get("code").map(String::as_str), Some("abc"), "code");
        assert_eq!(p.get("state").map(String::as_str), Some("xyz"), "state");
        assert_eq!(
            p.get("scope").map(String::as_str),
            Some("openid email"),
            "plus decodes to space"
        );
        let bare = callback_params("?code=c&state=s").unwrap_or_default();
        assert_eq!(
            bare.get("code").map(String::as_str),
            Some("c"),
            "query only"
        );
        assert!(callback_params("hello").is_none(), "no query");
    }

    #[test]
    fn checks_claims() {
        let good = json!({"iss": ISSUER, "aud": "oaiapp_1", "exp": 2000, "nonce": "n", "sub": "s"});
        assert!(check_claims(&good, "oaiapp_1", "n", 1000).is_ok(), "valid");
        let list = json!({"iss": ISSUER, "aud": ["x", "oaiapp_1"], "exp": 2000, "nonce": "n"});
        assert!(
            check_claims(&list, "oaiapp_1", "n", 1000).is_ok(),
            "aud list"
        );
        assert!(check_claims(&good, "other", "n", 1000).is_err(), "audience");
        assert!(check_claims(&good, "oaiapp_1", "m", 1000).is_err(), "nonce");
        assert!(
            check_claims(&good, "oaiapp_1", "n", 3000).is_err(),
            "expired"
        );
        let bad_iss = json!({"iss": "https://evil", "aud": "oaiapp_1", "exp": 2000, "nonce": "n"});
        assert!(
            check_claims(&bad_iss, "oaiapp_1", "n", 1000).is_err(),
            "issuer"
        );
    }

    #[test]
    fn starts_with_pkce_and_registration() -> Result<(), AiError> {
        let started = start(Owner::User(42), 42, "urn:uuid:test", None, false)?;
        let url = reqwest::Url::parse(&started.authorize_url).ok();
        let params: HashMap<String, String> = url
            .map(|u| u.query_pairs().into_owned().collect())
            .unwrap_or_default();
        assert_eq!(
            params.get("client_id").map(String::as_str),
            Some(FIRST_CLIENT),
            "dynamic"
        );
        assert_eq!(
            params.get("agent_name_hint").map(String::as_str),
            Some(AGENT_NAME),
            "name"
        );
        assert_eq!(
            params.get("code_challenge_method").map(String::as_str),
            Some("S256"),
            "pkce"
        );
        assert_eq!(
            params.get("redirect_uri").map(String::as_str),
            Some(REDIRECT_URI),
            "loopback"
        );
        assert!(
            !started.authorize_url.contains("code_verifier"),
            "verifier stays here"
        );
        Ok(())
    }

    #[test]
    fn reads_token_sets() -> Result<(), AiError> {
        let body = json!({"access_token": "a", "refresh_token": "r", "id_token": "i", "expires_in": 3600, "scope": "openid chatgpt.tokens.use.direct"});
        let t = token_set(&body, None)?;
        assert_eq!(t.access_token.expose(), "a", "access");
        assert!(t.scopes.iter().any(|s| s == PLAN_SCOPE), "scopes");
        let refreshed = json!({"access_token": "a2", "refresh_token": "r2", "expires_in": 3600});
        let t2 = token_set(&refreshed, Some(&t))?;
        assert_eq!(t2.id_token.expose(), "i", "ID token kept");
        assert_eq!(t2.refresh_token.expose(), "r2", "rotated");
        Ok(())
    }
}
