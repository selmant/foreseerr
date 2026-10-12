//! The web push agent: the payload the service worker reads, encrypted
//! with `aes128gcm` (RFC 8291) and signed with VAPID, as the `web-push`
//! package sends it.

use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use base64::prelude::*;
use ring::rand::SystemRandom;
use ring::{aead, agreement, hkdf, signature};
use serde_json::{Map, Value};

use super::{issue_type_name, Env, Kind, Payload, Person};
use crate::db::PushSubscriptionRow;
use crate::settings::public::truthy;

/// `web-push`'s default TTL: four weeks.
const TTL: &str = "2419200";
/// `aes128gcm`'s record size.
const RECORD_SIZE: u32 = 4096;

/// The JSON the service worker gets.
fn push_payload(env: &Env, kind: Kind, payload: &Payload, locale: Option<&str>) -> Value {
    let intl = env.intl(locale);
    let msg = |key: &str, args: &[(&str, Option<&str>)]| {
        intl.format_strict(&format!("notifications.agents.webpush.{key}"), args)
    };
    let common = |key: &str, args: &[(&str, &str)]| {
        intl.format(&format!("notifications.common.{key}"), args)
    };
    let embed_poster = truthy(
        env.settings
            .get("/notifications/agents/webpush/embedPoster"),
    );
    let media_type = payload.media.as_ref().map(|m| {
        if m.media_type == "movie" {
            common("movie", &[])
        } else {
            common("series", &[])
        }
    });
    let quality = if payload.request.as_ref().is_some_and(|r| r.is4k) {
        "4K "
    } else {
        ""
    };
    let issue_type = payload.issue.as_ref().map(|i| {
        if i.issue_type == 4 {
            common("issue", &[])
        } else {
            common(
                "issueTypeName",
                &[("type", &issue_type_name(i.issue_type).to_lowercase())],
            )
        }
    });
    let mt = media_type.as_deref();
    let requester = payload
        .request
        .as_ref()
        .map(|r| r.requested_by.display_name.as_str());
    let message = match kind {
        Kind::Test | Kind::NewSeason | Kind::ReleaseDateChanged => payload.message.clone(),
        Kind::MediaAutoRequested => Some(msg(
            "autoRequested",
            &[("quality", Some(quality)), ("mediaType", mt)],
        )),
        Kind::MediaApproved => Some(msg(
            "approved",
            &[("quality", Some(quality)), ("mediaType", mt)],
        )),
        Kind::MediaAutoApproved => Some(msg(
            "autoApproved",
            &[
                ("quality", Some(quality)),
                ("mediaType", mt),
                ("userName", requester),
            ],
        )),
        Kind::MediaAvailable => Some(msg(
            "available",
            &[("quality", Some(quality)), ("mediaType", mt)],
        )),
        Kind::MediaDeclined => Some(msg(
            "declined",
            &[("quality", Some(quality)), ("mediaType", mt)],
        )),
        Kind::MediaFailed => Some(msg(
            "failed",
            &[("quality", Some(quality)), ("mediaType", mt)],
        )),
        Kind::MediaPending => Some(msg(
            "pending",
            &[
                ("quality", Some(quality)),
                ("mediaType", mt),
                ("userName", requester),
            ],
        )),
        Kind::IssueCreated => Some(msg(
            "issueCreated",
            &[
                ("issueType", issue_type.as_deref()),
                (
                    "userName",
                    payload
                        .issue
                        .as_ref()
                        .map(|i| i.created_by.display_name.as_str()),
                ),
            ],
        )),
        Kind::IssueComment => Some(msg(
            "issueComment",
            &[
                (
                    "userName",
                    payload
                        .comment
                        .as_ref()
                        .map(|c| c.user.display_name.as_str()),
                ),
                ("issueType", issue_type.as_deref()),
            ],
        )),
        Kind::IssueResolved => Some(msg(
            "issueResolved",
            &[
                ("issueType", issue_type.as_deref()),
                (
                    "userName",
                    payload
                        .issue
                        .as_ref()
                        .and_then(|i| i.modified_by.as_ref())
                        .map(|m| m.display_name.as_str()),
                ),
            ],
        )),
        Kind::IssueReopened => Some(msg(
            "issueReopened",
            &[
                ("issueType", issue_type.as_deref()),
                (
                    "userName",
                    payload
                        .issue
                        .as_ref()
                        .and_then(|i| i.modified_by.as_ref())
                        .map(|m| m.display_name.as_str()),
                ),
            ],
        )),
    };
    let action_url = payload.watch_url.clone().or_else(|| {
        payload
            .issue
            .as_ref()
            .map(|i| format!("/issues/{}", i.id))
            .or_else(|| {
                payload
                    .media
                    .as_ref()
                    .map(|m| format!("/{}/{}", m.media_type, m.tmdb_id))
            })
    });
    let mut out = Map::new();
    out.insert(String::from("notificationType"), Value::from(kind.name()));
    if let Some(message) = message {
        out.insert(String::from("message"), Value::from(message));
    }
    if let (true, Some(image)) = (embed_poster, &payload.image) {
        out.insert(String::from("image"), Value::from(image.as_str()));
    }
    if let Some(request) = &payload.request {
        out.insert(String::from("requestId"), Value::from(request.id));
    }
    if let Some(url) = action_url {
        out.insert(String::from("actionUrl"), Value::from(url));
        let title = if payload.issue.is_some() {
            msg("viewIssue", &[])
        } else {
            msg("viewMedia", &[])
        };
        out.insert(String::from("actionUrlTitle"), Value::from(title));
    }
    if let Some(count) = payload.pending_requests_count {
        out.insert(String::from("pendingRequestsCount"), Value::from(count));
    }
    if let Some(admin) = payload.is_admin {
        out.insert(String::from("isAdmin"), Value::Bool(admin));
    }
    Value::Object(out)
}

/// The web push agent.
///
/// # Errors
///
/// Fails on database errors; delivery failures are logged per
/// subscription.
pub async fn send(env: Env, kind: Kind, payload: Arc<Payload>) -> Result<()> {
    if !truthy(env.settings.get("/notifications/agents/webpush/enabled")) {
        return Ok(());
    }
    let db = &env.state.db;
    let main_email = db
        .user_record(1)
        .await?
        .map(|(u, _)| u.email.unwrap_or_default().to_lowercase());
    let pending = db
        .scalar(
            r#"SELECT COUNT(*) FROM "media_request" WHERE "status" = 1"#,
            &[],
        )
        .await?;
    let mut targets: Vec<(PushSubscriptionRow, Option<String>)> = Vec::new();
    if let Some(user) = &payload.notify_user {
        if user.wants("webpush", kind).unwrap_or(true) {
            for sub in db.push_subscriptions(user.id, None).await? {
                targets.push((sub, user.locale().map(str::to_owned)));
            }
        }
    }
    if payload.notify_admin || matches!(kind, Kind::MediaApproved | Kind::MediaDeclined) {
        let users = env.users().await?;
        let admins: Vec<&Person> = users
            .iter()
            .filter(|u| {
                u.wants("webpush", kind).unwrap_or(true) && payload.admin_should_get(kind, u)
            })
            .collect();
        let mut subs = Vec::new();
        for admin in &admins {
            for sub in db.push_subscriptions(admin.id, None).await? {
                subs.push((sub, admin.locale().map(str::to_owned)));
            }
        }
        if matches!(kind, Kind::MediaApproved | Kind::MediaDeclined) {
            if let Some(email) = &main_email {
                for (sub, locale) in subs {
                    let badge = Payload {
                        notify_admin: true,
                        is_admin: Some(true),
                        pending_requests_count: Some(pending),
                        ..Payload::default()
                    };
                    let body = push_payload(&env, kind, &badge, locale.as_deref());
                    deliver(&env, email, &sub, &body).await;
                }
            }
        } else {
            targets.extend(subs);
        }
    }
    let Some(email) = main_email else {
        return Ok(());
    };
    if targets.is_empty() {
        return Ok(());
    }
    let payload = if kind == Kind::MediaPending {
        Arc::new(Payload {
            pending_requests_count: Some(pending),
            ..(*payload).clone()
        })
    } else {
        payload
    };
    for (sub, locale) in targets {
        let body = push_payload(&env, kind, &payload, locale.as_deref());
        deliver(&env, &email, &sub, &body).await;
    }
    Ok(())
}

/// Send one push; a 404 or 410 removes the subscription.
async fn deliver(env: &Env, email: &str, sub: &PushSubscriptionRow, body: &Value) {
    match push(env, email, sub, body.to_string().as_bytes()).await {
        Ok(()) => {}
        Err(PushError::Gone(status)) => {
            tracing::warn!("web push answered {status}; removing the subscription");
            if let Err(e) = env
                .state
                .db
                .execute(
                    r#"DELETE FROM "user_push_subscription" WHERE "id" = ?1"#,
                    &[crate::db::Bind::Int(sub.id)],
                )
                .await
            {
                tracing::error!("removing a push subscription failed: {e:#}");
            }
        }
        Err(PushError::Other(e)) => tracing::error!("web push failed: {e:#}"),
    }
}

enum PushError {
    Gone(u16),
    Other(anyhow::Error),
}

impl From<anyhow::Error> for PushError {
    fn from(e: anyhow::Error) -> Self {
        Self::Other(e)
    }
}

async fn push(
    env: &Env,
    email: &str,
    sub: &PushSubscriptionRow,
    plaintext: &[u8],
) -> Result<(), PushError> {
    let body = encrypt(sub, plaintext)?;
    let endpoint = reqwest::Url::parse(&sub.endpoint).context("endpoint")?;
    let audience = endpoint.origin().ascii_serialization();
    let jwt = vapid_jwt(env, &audience, email)?;
    let public = env.settings.str("/vapidPublic");
    let response = env
        .state
        .outbound
        .post(endpoint)
        .header("TTL", TTL)
        .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
        .header("Content-Encoding", "aes128gcm")
        .header(
            reqwest::header::AUTHORIZATION,
            format!("vapid t={jwt}, k={public}"),
        )
        .body(body)
        .send()
        .await
        .context("web push")?;
    let status = response.status().as_u16();
    if status == 404 || status == 410 {
        return Err(PushError::Gone(status));
    }
    if !(200..300).contains(&status) {
        return Err(PushError::Other(anyhow!("web push answered {status}")));
    }
    Ok(())
}

/// A key length for `ring`'s HKDF expansion.
struct Len(usize);

impl hkdf::KeyType for Len {
    fn len(&self) -> usize {
        self.0
    }
}

fn expand(prk: &hkdf::Prk, info: &[u8], len: usize) -> Result<Vec<u8>> {
    let mut out = vec![0_u8; len];
    prk.expand(&[info], Len(len))
        .map_err(|_| anyhow!("hkdf expand"))?
        .fill(&mut out)
        .map_err(|_| anyhow!("hkdf fill"))?;
    Ok(out)
}

/// RFC 8291: one `aes128gcm` record for the subscription's keys.
fn encrypt(sub: &PushSubscriptionRow, plaintext: &[u8]) -> Result<Vec<u8>> {
    let rng = SystemRandom::new();
    let ua_public = BASE64_URL_SAFE_NO_PAD
        .decode(sub.p256dh.trim_end_matches('='))
        .context("p256dh")?;
    let auth = BASE64_URL_SAFE_NO_PAD
        .decode(sub.auth.trim_end_matches('='))
        .context("auth")?;
    let private = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng)
        .map_err(|_| anyhow!("key generation"))?;
    let as_public = private
        .compute_public_key()
        .map_err(|_| anyhow!("public key"))?;
    let as_public = as_public.as_ref().to_vec();
    let mut salt = [0_u8; 16];
    ring::rand::SecureRandom::fill(&rng, &mut salt).map_err(|_| anyhow!("salt"))?;
    let peer = agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, ua_public.clone());
    let secret =
        agreement::agree_ephemeral(private, &peer, <[u8]>::to_vec).map_err(|_| anyhow!("ecdh"))?;
    let mut key_info = b"WebPush: info\0".to_vec();
    key_info.extend_from_slice(&ua_public);
    key_info.extend_from_slice(&as_public);
    let prk_key = hkdf::Salt::new(hkdf::HKDF_SHA256, &auth).extract(&secret);
    let ikm = expand(&prk_key, &key_info, 32)?;
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, &salt).extract(&ikm);
    let cek = expand(&prk, b"Content-Encoding: aes128gcm\0", 16)?;
    let nonce = expand(&prk, b"Content-Encoding: nonce\0", 12)?;
    let key = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_128_GCM, &cek).map_err(|_| anyhow!("cek"))?,
    );
    let nonce = aead::Nonce::try_assume_unique_for_key(&nonce).map_err(|_| anyhow!("nonce"))?;
    let mut record = plaintext.to_vec();
    record.push(2);
    key.seal_in_place_append_tag(nonce, aead::Aad::empty(), &mut record)
        .map_err(|_| anyhow!("seal"))?;
    let mut out = Vec::with_capacity(16 + 4 + 1 + as_public.len() + record.len());
    out.extend_from_slice(&salt);
    out.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    out.push(u8::try_from(as_public.len()).unwrap_or(65));
    out.extend_from_slice(&as_public);
    out.extend_from_slice(&record);
    Ok(out)
}

/// The VAPID token: ES256 over the push service's origin, twelve hours.
fn vapid_jwt(env: &Env, audience: &str, email: &str) -> Result<String> {
    let private = BASE64_URL_SAFE_NO_PAD
        .decode(env.settings.str("/vapidPrivate").trim_end_matches('='))
        .context("vapidPrivate")?;
    let public = BASE64_URL_SAFE_NO_PAD
        .decode(env.settings.str("/vapidPublic").trim_end_matches('='))
        .context("vapidPublic")?;
    let rng = SystemRandom::new();
    let pair = signature::EcdsaKeyPair::from_private_key_and_public_key(
        &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
        &private,
        &public,
        &rng,
    )
    .map_err(|_| anyhow!("the VAPID key pair is invalid"))?;
    let exp = crate::clock::now_millis() / 1000 + 43_200;
    let header = BASE64_URL_SAFE_NO_PAD.encode(r#"{"typ":"JWT","alg":"ES256"}"#);
    let mut claims = Map::new();
    claims.insert(String::from("aud"), Value::from(audience));
    claims.insert(String::from("exp"), Value::from(exp));
    claims.insert(String::from("sub"), Value::from(format!("mailto:{email}")));
    let claims = BASE64_URL_SAFE_NO_PAD.encode(Value::Object(claims).to_string());
    let input = format!("{header}.{claims}");
    let sig = pair
        .sign(&rng, input.as_bytes())
        .map_err(|_| anyhow!("signing"))?;
    Ok(format!(
        "{input}.{}",
        BASE64_URL_SAFE_NO_PAD.encode(sig.as_ref())
    ))
}
