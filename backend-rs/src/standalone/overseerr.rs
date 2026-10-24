//! `checkOverseerrMerge()` (`server/lib/overseerrMerge.ts`).
//!
//! A settings.json without `main.mediaServerType` comes from Overseerr; its `SQLite`
//! database gets the Jellyseerr migration records, the
//! `SeerrMigration1759769291608` schema change and the quota and status
//! fixes, and the settings become a Plex install.
//!
//! Node remaps `MediaStatus.Blacklisted` (6) to `Deleted` (7) through
//! `mediaRepository.save()`, so `MediaSubscriber` runs; that needs the full
//! application state, so it happens in [`remap_blacklisted_status`] right
//! after the state is built.

use std::path::Path;
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use serde_json::Value;

use super::settingsfile;
use super::settingsmigrations::MigrationCtx;
use crate::db::Db;
use crate::dbmigrate::{self, Migration, JELLYSEERR_MIGRATIONS};
use crate::settings::public::truthy;
use crate::state::AppState;

/// What the merge decided for the rest of startup.
#[derive(Debug)]
pub(crate) struct Merge {
    /// The migration list the process uses from here on.
    pub(crate) migrations: Vec<&'static Migration>,
    /// Whether the Overseerr merge ran (the status remap is still due).
    pub(crate) merged: bool,
}

/// `checkOverseerrMerge()` up to the media status remap.
///
/// # Errors
///
/// Where Node exits: unreadable settings, a database that can't take the
/// migration records, a failing migration, settings that can't be saved.
pub(crate) async fn check(path: &Path, db: &Db, ctx: MigrationCtx<'_>) -> Result<Merge> {
    // `new Settings().load(undefined, true)`: no migrations, keys generated.
    let mut settings = settingsfile::load(path, true, ctx).await?;
    let server_type = settings
        .pointer("/main")
        .context("mediaServerType is missing")?
        .get("mediaServerType");
    if truthy(server_type) {
        return Ok(Merge {
            migrations: dbmigrate::migrations(db),
            merged: false,
        });
    }
    let Db::Sqlite(pool) = db else {
        bail!("the Overseerr merge only supports SQLite databases");
    };
    let migrations = dbmigrate::overseerr_merge_migrations();
    let values: Vec<String> = JELLYSEERR_MIGRATIONS
        .iter()
        .map(|(timestamp, name)| format!("({timestamp}, '{name}')"))
        .collect();
    let insert = format!(
        "INSERT INTO migrations (timestamp,name) VALUES\n        {}\n      ",
        values.join(", ")
    );
    if let Err(e) = sqlx::raw_sql(sqlx::AssertSqlSafe(insert))
        .execute(pool)
        .await
    {
        tracing::error!(
            label = "Seerr Migration",
            "Failed to insert migration records: {e}"
        );
        bail!("Failed to insert migration records: {e}");
    }
    if super::production() {
        dbmigrate::run(db, &migrations).await?;
    }
    for column in [
        "movieQuotaLimit",
        "movieQuotaDays",
        "tvQuotaLimit",
        "tvQuotaDays",
    ] {
        let sql = format!("UPDATE user SET {column} = NULL WHERE typeof({column}) = 'text'");
        if let Err(e) = sqlx::raw_sql(sqlx::AssertSqlSafe(sql)).execute(pool).await {
            tracing::error!(
                label = "Seerr Migration",
                "Failed to clean up corrupted quota values: {e}"
            );
            break;
        }
    }
    apply_settings(&mut settings)?;
    if let Err(e) = settingsfile::save(path, &settings).await {
        tracing::error!(
            label = "Seerr Migration",
            "Failed to save updated settings for Overseerr merge: {e:#}"
        );
        return Err(e);
    }
    tracing::info!(
        label = "Seerr Migration",
        "Yeah! Overseerr to Seerr migration completed successfully!"
    );
    Ok(Merge {
        migrations,
        merged: true,
    })
}

/// Plex as the media server, and Foreseerr where Overseerr's defaults were.
fn apply_settings(settings: &mut Value) -> Result<()> {
    let main = settings
        .get_mut("main")
        .and_then(Value::as_object_mut)
        .context("settings.main")?;
    main.insert(String::from("mediaServerType"), Value::from(1));
    if main.get("applicationTitle").and_then(Value::as_str) == Some("Overseerr") {
        main.insert(String::from("applicationTitle"), Value::from("Foreseerr"));
    }
    let options = settings
        .pointer_mut("/notifications/agents/email/options")
        .and_then(Value::as_object_mut)
        .context("senderName is missing")?;
    if options.get("senderName").and_then(Value::as_str) == Some("Overseerr") {
        options.insert(String::from("senderName"), Value::from("Foreseerr"));
    }
    Ok(())
}

/// `MediaStatus.Blacklisted` (6) became `Deleted` (7): each such media is
/// saved with the new status (4K too), `MediaSubscriber` included. Node
/// does this before any notification agent is registered, so none sends.
///
/// # Errors
///
/// Fails like Node's save loop, which stops the process.
pub(crate) async fn remap_blacklisted_status(state: &Arc<AppState>) -> Result<()> {
    use crate::routes::mediasave::{save, MediaEdit};
    let settings = state.settings.current().await?;
    let mut quiet = settings.data().clone();
    if let Some(agents) = quiet
        .pointer_mut("/notifications/agents")
        .and_then(Value::as_object_mut)
    {
        for agent in agents.values_mut() {
            if let Some(agent) = agent.as_object_mut() {
                agent.insert(String::from("enabled"), Value::Bool(false));
            }
        }
    }
    let lc = crate::lifecycle::Lc {
        state: Arc::clone(state),
        settings: Arc::new(settings.with_data(quiet)),
    };
    for column in ["status", "status4k"] {
        let ids = state
            .db
            .rows(
                &format!(r#"SELECT "id" FROM "media" WHERE "{column}" = 6 ORDER BY "id""#),
                &[],
            )
            .await?;
        let ids: Vec<i64> = ids
            .iter()
            .filter_map(|r| r.get("id").and_then(Value::as_i64))
            .collect();
        for media in state.db.media_by_ids(&ids, true).await? {
            let mut edit = MediaEdit::new(media);
            if column == "status" {
                edit.after.status = 7;
            } else {
                edit.after.status4k = 7;
            }
            if let Err(e) = save(&lc, &mut edit).await {
                tracing::error!(
                    label = "Seerr Migration",
                    "Failed to update Media status from Blacklisted to Deleted: {e:#}"
                );
                return Err(e);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn settings_become_foreseerr() -> Result<()> {
        let mut s = json!({
            "main": {"applicationTitle": "Overseerr"},
            "notifications": {"agents": {"email": {"options": {"senderName": "Overseerr"}}}}
        });
        apply_settings(&mut s)?;
        assert_eq!(
            s,
            json!({
                "main": {"applicationTitle": "Foreseerr", "mediaServerType": 1},
                "notifications": {"agents": {"email": {"options": {"senderName": "Foreseerr"}}}}
            }),
            "renamed"
        );
        Ok(())
    }
}
