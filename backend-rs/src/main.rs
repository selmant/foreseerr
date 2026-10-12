//! Foreseerr's Rust backend. It listens where Node used to, answers the
//! routes ported so far itself and forwards everything else to Node, which
//! keeps running behind it on `FORESEERR_NODE_URL`.
#![recursion_limit = "256"]

pub mod anilist;
pub mod arr;
pub mod auth;
pub mod clock;
pub mod concurrency;
pub mod csrf;
pub mod db;
pub mod dbmigrate;
pub mod dbtx;
pub mod discover;
pub mod dnscache;
pub mod dnsquery;
pub mod dnsresolve;
pub mod downloads;
pub mod email;
pub mod env;
pub mod github;
pub mod i18n;
pub mod imagecache;
pub mod isemail;
pub mod jellyfin;
pub mod jobs;
pub mod jsnum;
pub mod jsval;
pub mod library;
pub mod libraryimagecache;
pub mod librarymap;
pub mod lifecycle;
pub mod logfile;
pub mod mapping;
pub mod mappingdatasets;
pub mod mappinglayer;
pub mod mappingpacks;
pub mod mdblist;
pub mod media;
pub mod mediaactions;
pub mod memcache;
pub mod mimetable;
pub mod naivetime;
pub mod notify;
pub mod openapi;
pub mod outbound;
pub mod pgorder;
pub mod plexwatchlist;
pub mod proxy;
pub mod ratings;
pub mod respond;
pub mod routes;
pub mod runtime;
pub mod servarr;
pub mod settings;
pub mod simkl;
pub mod skippedepisodes;
pub mod standalone;
pub mod state;
pub mod sync;
pub mod tmdb;
pub mod trakt;
pub mod traktbridge;
pub mod traktitems;
pub mod tvdb;
pub mod typeorm;
pub mod user;
pub mod version;

use std::process::ExitCode;
use std::sync::Arc;

use anyhow::{Context, Result};
use tracing_subscriber::filter::Targets;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

use crate::state::AppState;

/// The console, from `RUST_LOG`; in standalone mode also Node's log files
/// at `LOG_LEVEL`, for this crate's events.
fn init_logging() {
    // The managed runtimes print winston's console lines (their launchers
    // read them); everything else keeps tracing's format.
    let winston = runtime::active();
    let console = (!winston).then(|| {
        tracing_subscriber::fmt::layer().with_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
    });
    let runtime_console = winston.then(|| {
        runtime::console::layer(runtime::desktop_runtime()).with_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                EnvFilter::new(format!(
                    "foreseerr={}",
                    logfile::level_from_env().as_str().to_lowercase()
                ))
            }),
        )
    });
    let files = standalone::enabled().then(|| {
        let config_dir = env::Env::from_env()
            .map_or_else(|_| std::path::PathBuf::from("config"), |e| e.config_dir);
        logfile::layer(logfile::directory(&config_dir))
            .with_filter(Targets::new().with_target("foreseerr", logfile::level_from_env()))
    });
    tracing_subscriber::registry()
        .with(console)
        .with(runtime_console)
        .with(files)
        .init();
}

fn main() -> ExitCode {
    init_logging();
    if rustls::crypto::ring::default_provider()
        .install_default()
        .is_err()
    {
        tracing::debug!("a TLS crypto provider was already installed");
    }
    let started = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("starting the runtime");
    let result = started.and_then(|rt| {
        rt.block_on(async {
            runtime::process::before_startup()?;
            // A desktop stop requested while starting ends the start too.
            tokio::select! {
                result = run() => result,
                code = runtime::control::exit_requested() => Ok(code),
            }
        })
    });
    match result {
        Ok(code) => ExitCode::from(code),
        Err(e) => ExitCode::from(runtime::process::failed(&e)),
    }
}

async fn run() -> Result<u8> {
    let boot = if standalone::enabled() {
        Some(standalone::before_state().await?)
    } else {
        None
    };
    let state = Arc::new(AppState::from_env().await?);
    routes::procstate::register(&state);
    runtime::desktop::attach(&state);
    if let Some(boot) = boot {
        standalone::after_state(&state, boot).await?;
    }
    jobs::scheduler::start_at_boot(&state);
    if jobs::scheduler::rust_jobs() {
        // Node's `ensureMappingLayer()` at startup; the dataset downloads
        // belong to whichever process runs the jobs. The desktop runtime
        // skips it with the other startup jobs.
        mappinglayer::register(&state);
        if !runtime::desktop_links_internal() {
            let mapping = Arc::clone(&state);
            tokio::spawn(async move {
                // Node starts it with the jobs: only once a user exists.
                let users = mapping
                    .db
                    .scalar(r#"SELECT CAST(COUNT(*) AS BIGINT) FROM "user""#, &[])
                    .await;
                if !matches!(users, Ok(n) if n > 0) {
                    return;
                }
                if let Err(e) = mappingdatasets::ensure_mapping_layer(mapping).await {
                    tracing::error!(label = "Mapping", "Unable to load the mapping layer: {e:#}");
                }
            });
        }
    }
    let listener = runtime::process::bind(&state).await?;
    let app = routes::router(Arc::clone(&state))?;
    runtime::process::serve(state, listener, app).await
}
