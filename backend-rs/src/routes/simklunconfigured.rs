//! `syncSimklUser` without a Simkl Client ID (`server/lib/simklSync.ts`):
//! `createSimklUserClient` throws `SimklNotConfiguredError`, and the catch
//! stamps an existing sync state with the time and the error unless it was
//! checked in the last 15 minutes (no `refresh` reaches the library route).

use serde_json::Value;

use super::Ready;
use crate::db::Bind;

/// `SimklNotConfiguredError`'s message.
pub(super) const NOT_CONFIGURED: &str = "Simkl application Client ID is not configured";
/// `AUTO_SYNC_MIN_INTERVAL_MS`.
const AUTO_SYNC_MIN_INTERVAL_MS: i64 = 15 * 60 * 1000;

/// Run the failing sync for `user_id`.
pub(super) async fn sync(ctx: &Ready<'_>, user_id: i64) -> Result<(), String> {
    let db = &ctx.state.db;
    let rows = db
        .rows(
            &format!(
                r#"SELECT CAST("id" AS BIGINT) AS "id", {} AS "lastCheckedAt" FROM "simkl_sync_state" WHERE "userId" = ?1"#,
                crate::naivetime::select(db, r#""lastCheckedAt""#)
            ),
            &[Bind::Int(user_id)],
        )
        .await
        .map_err(|e| format!("database: {e:#}"))?;
    let Some(previous) = rows.first() else {
        return Ok(());
    };
    let Some(id) = previous.get("id").and_then(Value::as_i64) else {
        return Err(String::from("a sync state without an id"));
    };
    let checked = previous
        .get("lastCheckedAt")
        .and_then(Value::as_str)
        .and_then(|text| crate::naivetime::read_millis(db, text));
    if checked.is_some_and(|at| crate::clock::now_millis() - at < AUTO_SYNC_MIN_INTERVAL_MS) {
        return Ok(());
    }
    db.execute(
        &format!(
            r#"UPDATE "simkl_sync_state" SET "lastCheckedAt" = {}, "lastError" = ?2 WHERE "id" = ?3"#,
            crate::naivetime::param(db, 1)
        ),
        &[
            crate::naivetime::bind(db, crate::clock::now_millis()),
            Bind::Text(NOT_CONFIGURED.to_owned()),
            Bind::Int(id),
        ],
    )
    .await
    .map_err(|e| format!("database: {e:#}"))?;
    Ok(())
}
