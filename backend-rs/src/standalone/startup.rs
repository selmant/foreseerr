//! `startServer()` in `server/index.ts` up to `listen()`, for a process
//! with no Node behind it.
//!
//! Before the application state exists ([`before_state`]): the Overseerr
//! merge, the database migrations (production only) and the schema guard,
//! then `getSettings().load()` with the settings migrations and the key
//! generation. After it ([`after_state`]): the Overseerr media status remap,
//! the Plex library type migration, the jobs (through the scheduler's own
//! start), `DiscoverSlider.bootstrapSliders()` and
//! `ImageProxy.maintainCache()`.
//!
//! Not run, with why:
//! - `initI18n()`: the Rust catalogue is embedded and built on first use.
//! - DNS cache, `forceIpv4First` and the proxy: applied to every outgoing
//!   client when it is built (`src/outbound.rs`, `src/dnsresolve.rs`).
//! - the notification agents' registration: Rust's agents are static.
//!
//! The plugin's host bootstrap, its admin user and its secret check, and
//! the desktop's schema exit code are `src/runtime/` hooks; the desktop
//! lock is taken before this runs (`runtime::process::before_startup`).

use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result};
use serde_json::Value;

use super::settingsmigrations::MigrationCtx;
use super::{overseerr, settingsfile};
use crate::db::Db;
use crate::dbmigrate;
use crate::env::Env;
use crate::state::AppState;
use crate::version::AppVersion;

/// What [`before_state`] leaves for [`after_state`].
#[derive(Debug, Clone, Copy)]
pub struct Boot {
    /// The Overseerr merge ran; its media status remap is still due.
    merged: bool,
}

/// Everything `startServer()` does before the settings are in memory.
///
/// # Errors
///
/// Where Node stops: an unreadable or newer settings.json, a failing
/// migration, an unknown newer schema.
pub async fn before_state() -> Result<Boot> {
    let env = Env::from_env()?;
    tokio::fs::create_dir_all(&env.config_dir)
        .await
        .with_context(|| format!("creating {}", env.config_dir.display()))?;
    let db = Db::open(&env.config_dir)?;
    if let Db::Sqlite(_) = db {
        create_sqlite(&env.config_dir).await?;
    }
    let version = AppVersion::load(&env.app_root);
    let http = reqwest::Client::builder()
        .user_agent(version.user_agent())
        .build()
        .context("building the client for the settings migrations")?;
    let ctx = MigrationCtx {
        db: &db,
        http: &http,
        version: &version.version,
    };
    let settings_path = env.config_dir.join("settings.json");
    let merge = overseerr::check(&settings_path, &db, ctx).await?;
    // server/datasource.ts: production runs the migrations; development
    // runs them on Postgres (`migrationsRun`) and synchronizes `SQLite`.
    if super::production() || db.is_postgres() {
        dbmigrate::run(&db, &merge.migrations).await?;
    } else {
        dbmigrate::devschema::synchronize(&db).await?;
    }
    dbmigrate::assert_supported_schema(&db, &merge.migrations)
        .await
        .map_err(crate::runtime::process::schema_error)?;
    let data = settingsfile::load(&settings_path, false, ctx).await?;
    crate::runtime::plugin::bootstrap(&settings_path, &env.config_dir, data).await?;
    match &db {
        Db::Sqlite(pool) => pool.close().await,
        Db::Postgres(pool) => pool.close().await,
    }
    Ok(Boot {
        merged: merge.merged,
    })
}

/// `TypeORM`'s `SQLite` driver creates the database directory and file.
async fn create_sqlite(config_dir: &Path) -> Result<()> {
    use sqlx::sqlite::SqliteConnectOptions;
    use sqlx::ConnectOptions;
    let dir = config_dir.join("db");
    tokio::fs::create_dir_all(&dir)
        .await
        .with_context(|| format!("creating {}", dir.display()))?;
    let conn = SqliteConnectOptions::new()
        .filename(dir.join("db.sqlite3"))
        .create_if_missing(true)
        .connect()
        .await
        .context("creating the SQLite database")?;
    sqlx::Connection::close(conn)
        .await
        .context("closing the SQLite database")
}

/// The startup tasks that need the application state.
///
/// # Errors
///
/// Where Node stops: the Overseerr status remap or the slider bootstrap
/// failing.
pub async fn after_state(state: &Arc<AppState>, boot: Boot) -> Result<()> {
    if boot.merged {
        overseerr::remap_blacklisted_status(state).await?;
    }
    crate::routes::pluginauth::ensure_admin_user(state).await;
    let settings = state.settings.current().await?;
    if truthy_path(&settings, "/network/dnsCache/enabled") {
        tracing::info!(label = "DNS Cache", "Initializing DNS Cache");
    }
    migrate_plex_library_types(state).await;
    crate::runtime::process::agents_registered();
    let users = state
        .db
        .scalar(r#"SELECT CAST(COUNT(*) AS BIGINT) FROM "user""#, &[])
        .await?;
    // The desktop starts its jobs after a sign-in.
    if users == 0 || (crate::runtime::active() && crate::runtime::desktop_runtime()) {
        tracing::info!(
            label = "Server",
            "Skipping starting the scheduled jobs as we have no Plex/Jellyfin/Emby servers setup yet"
        );
    }
    crate::routes::settings_main::bootstrap_sliders(&state.db).await?;
    crate::imagecache::maintain_cache(&state.env.config_dir, Some(&settings), None).await;
    crate::runtime::process::after_startup()
}

fn truthy_path(settings: &crate::settings::Settings, pointer: &str) -> bool {
    crate::settings::public::truthy(settings.get(pointer))
}

/// "Migrate library types": libraries saved before they carried a type are
/// synced again with the admin's Plex token.
async fn migrate_plex_library_types(state: &AppState) {
    let Ok(settings) = state.settings.current().await else {
        return;
    };
    let Some(libraries) = settings.get("/plex/libraries").and_then(Value::as_array) else {
        return;
    };
    let untyped = libraries
        .first()
        .is_some_and(|l| !crate::settings::public::truthy(l.get("type")));
    if libraries.len() <= 1 || !untyped {
        return;
    }
    let admin = state
        .db
        .rows(
            r#"SELECT "id", "plexToken" FROM "user" WHERE "id" = 1 LIMIT 1"#,
            &[],
        )
        .await;
    let Some(admin) = admin.ok().and_then(|rows| rows.into_iter().next()) else {
        return;
    };
    tracing::info!(
        label = "Settings",
        "Migrating Plex libraries to include media type"
    );
    let token = admin
        .get("plexToken")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    if let Err(e) = sync_plex_libraries(state, &settings, &token).await {
        tracing::error!(label = "Plex API", "Failed to fetch Plex libraries: {e:#}");
        tracing::warn!(
            label = "Settings",
            "Failed to migrate Plex libraries; will retry on next startup"
        );
    }
}

/// `PlexAPI.syncLibraries()`.
async fn sync_plex_libraries(
    state: &AppState,
    settings: &crate::settings::Settings,
    token: &str,
) -> Result<()> {
    use crate::routes::plexsettings::{merge_libraries, plex_base, plex_libraries, plex_request};
    let plex = settings.get("/plex").cloned().unwrap_or(Value::Null);
    let client_id = settings
        .get("/clientId")
        .map(|v| crate::media::js_string(Some(v)).into_owned());
    let url = format!("{}/library/sections", plex_base(&plex));
    let answer: Value = plex_request(&state.outbound, &url, token, client_id.as_deref())
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let found = answer
        .pointer("/MediaContainer/Directory")
        .and_then(plex_libraries)
        .context("filter is missing")?;
    let existing = plex
        .get("libraries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let libraries = merge_libraries(&found, &existing).context("a null library")?;
    state
        .settings
        .update(|doc| {
            if let Some(plex) = doc.get_mut("plex").and_then(Value::as_object_mut) {
                plex.insert(String::from("libraries"), Value::Array(libraries));
            }
        })
        .await
}
