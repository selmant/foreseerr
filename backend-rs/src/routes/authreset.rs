//! `POST /auth/reset-password` (the recovery email) and
//! `POST /auth/reset-password/{guid}` (the new password).

use axum::http::Method;
use serde_json::{Map, Value};

use super::authcommon::{
    date_bind, date_param, finish, hash_password, js_length, random_bytes, Entity, Native, Step,
};
use super::{Ready, Table};
use crate::db::Bind;

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/auth/reset-password", Method::POST, request_reset),
    ("/api/v1/auth/reset-password/{guid}", Method::POST, reset),
];

/// A day, which `setDate(getDate() + 1)` adds on a server in UTC.
const DAY_MS: i64 = 86_400_000;

fn ok(ctx: &Ready<'_>) -> super::Outcome {
    let mut body = Map::new();
    body.insert(String::from("status"), Value::from("ok"));
    ctx.json(&Value::Object(body))
}

fn request_reset<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move { finish(request_reset_route(ctx).await) })
}

/// `crypto.randomUUID()`.
fn random_uuid() -> Result<String, String> {
    let mut b = random_bytes(16)?;
    if let Some(v) = b.get_mut(6) {
        *v = (*v & 0x0F) | 0x40;
    }
    if let Some(v) = b.get_mut(8) {
        *v = (*v & 0x3F) | 0x80;
    }
    let hex = super::authcommon::hex(&b);
    let part = |from: usize, to: usize| hex.get(from..to).unwrap_or("");
    Ok(format!(
        "{}-{}-{}-{}-{}",
        part(0, 8),
        part(8, 12),
        part(12, 16),
        part(16, 20),
        part(20, 32)
    ))
}

/// `POST /auth/reset-password`: a recovery link by email when the address
/// belongs to a user; the answer is the same either way.
async fn request_reset_route(ctx: &Ready<'_>) -> Step {
    ctx.no_query()?;
    let Some(Value::Object(body)) = &ctx.body else {
        return Err(String::from("a body that isn't an object").into());
    };
    let Some(Value::String(email)) = body.get("email") else {
        return Err(String::from("email is the validator's").into());
    };
    if email.is_empty() {
        return Ok(ctx.error(500, "Email address required."));
    }
    let db = &ctx.state.db;
    let db_err = |e: anyhow::Error| format!("database: {e:#}");
    let id = db
        .rows(
            r#"SELECT CAST("id" AS BIGINT) AS "id" FROM "user" WHERE "email" = ?1"#,
            &[Bind::Text(email.to_lowercase())],
        )
        .await
        .map_err(db_err)?
        .first()
        .and_then(|r| r.get("id"))
        .and_then(Value::as_i64);
    let Some(id) = id else {
        tracing::error!("Something went wrong sending password reset link");
        return Ok(ok(ctx));
    };
    let user = Entity::find_bare(db, id)
        .await
        .map_err(db_err)??
        .ok_or_else(|| String::from("the user vanished"))?;
    let guid = random_uuid()?;
    let expires = crate::clock::now_millis() + DAY_MS;
    let address = user
        .get("email")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let name = user
        .get("displayName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    tracing::info!("Sending reset password email for {address}");
    let frame = crate::email::Frame::new(&ctx.settings, &address, &name);
    let link = format!(
        "{}/resetpassword/{guid}",
        ctx.settings.str("/main/applicationUrl")
    );
    let rendered = crate::email::reset_password(&frame, &link);
    if let Err(e) = crate::email::send(&ctx.settings, &address, &rendered, None).await {
        tracing::error!("Failed to send out reset password email: {e:#}");
    }
    let sql = format!(
        r#"UPDATE "user" SET "resetPasswordGuid" = ?1, "recoveryLinkExpirationDate" = {}, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?3"#,
        date_param(db, 2)
    );
    if let Err(e) = db
        .execute(
            &sql,
            &[Bind::Text(guid), date_bind(db, expires), Bind::Int(id)],
        )
        .await
    {
        tracing::error!("saving the recovery link failed: {e:#}");
        return Ok(ctx.error(500, "Unable to save the password reset link."));
    }
    tracing::info!("Successfully sent password reset link");
    Ok(ok(ctx))
}

fn reset<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move { finish(reset_route(ctx).await) })
}

/// `POST /auth/reset-password/{guid}`: a new password through a recovery
/// link that hasn't expired.
async fn reset_route(ctx: &Ready<'_>) -> Step {
    ctx.no_query()?;
    let raw = ctx.req.uri.path().rsplit('/').next().unwrap_or("");
    // Express hands the handler the decoded parameter.
    let Some(guid) = super::nodestate::decode_segment(raw) else {
        return Err(String::from("a guid Express can't decode").into());
    };
    let Some(Value::Object(body)) = &ctx.body else {
        return Err(String::from("a body that isn't an object").into());
    };
    let password = match body.get("password") {
        None => "",
        Some(Value::String(p)) => p.as_str(),
        Some(_) => return Err(String::from("password is the validator's").into()),
    };
    if password.is_empty() || js_length(password) < 8 {
        tracing::warn!("Failed password reset attempt using invalid new password");
        return Ok(ctx.error(500, "Password must be at least 8 characters long."));
    }
    let db = &ctx.state.db;
    let db_err = |e: anyhow::Error| format!("database: {e:#}");
    let sql = format!(
        r#"SELECT CAST("id" AS BIGINT) AS "id", {} AS "expires" FROM "user" WHERE "resetPasswordGuid" = ?1 ORDER BY "id" ASC LIMIT 1"#,
        db.iso_sql(r#""recoveryLinkExpirationDate""#)
    );
    let rows = db.rows(&sql, &[Bind::Text(guid)]).await.map_err(db_err)?;
    let Some(row) = rows.first() else {
        tracing::warn!("Failed password reset attempt using invalid recovery link");
        return Ok(ctx.error(500, "Invalid password reset link."));
    };
    let id = row
        .get("id")
        .and_then(Value::as_i64)
        .ok_or_else(|| String::from("a user without an id"))?;
    // `findOne` loads the eager settings too; a row Node can't load is its.
    Entity::find(db, id).await.map_err(db_err)??;
    let expires = match row.get("expires") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(
            crate::clock::parse_date_millis(text)
                .ok_or_else(|| String::from("an unreadable expiry date"))?,
        ),
        Some(_) => return Err(String::from("an unreadable expiry date").into()),
    };
    if expires.is_none_or(|ms| ms <= crate::clock::now_millis()) {
        tracing::warn!("Failed password reset attempt using expired recovery link");
        return Ok(ctx.error(500, "Invalid password reset link."));
    }
    let hash = hash_password(password.to_owned()).await?;
    db.execute(
        r#"UPDATE "user" SET "recoveryLinkExpirationDate" = NULL, "password" = ?1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?2"#,
        &[Bind::Text(hash), Bind::Int(id)],
    )
    .await
    .map_err(db_err)?;
    tracing::info!("Successfully reset password");
    Ok(ok(ctx))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuids_are_version_four() {
        let id = random_uuid().unwrap_or_default();
        assert_eq!(id.len(), 36, "length");
        assert_eq!(id.get(14..15), Some("4"), "version");
        assert!(
            matches!(id.get(19..20), Some("8" | "9" | "a" | "b")),
            "variant"
        );
    }
}
