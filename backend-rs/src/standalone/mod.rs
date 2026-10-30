//! Standalone: this process is the whole backend.
//!
//! It runs what Node's `server/index.ts` ran before listening (database
//! migrations, the settings bootstrap, the Overseerr merge, the startup
//! tasks), answers what Node answered for requests no Rust handler takes,
//! serves the built frontend, and answers the `/internal` calls Node used
//! to serve in-process.

pub mod apidocs;
mod apiroutes;
pub mod fallback;
pub mod internal;
pub mod overseerr;
pub mod pending_mapping;
pub mod pending_nodestate;
pub mod settingsfile;
pub mod settingsmigrations;
mod startup;
mod statics;

use std::path::PathBuf;

pub use startup::{after_state, before_state, Boot};

/// `process.env.NODE_ENV === 'production'`: migrations run and the
/// frontend is served only then, as in Node.
#[must_use]
pub fn production() -> bool {
    std::env::var("NODE_ENV").is_ok_and(|v| v == "production")
}

/// Node's `PUBLIC_PATH` (`dist/public` next to the compiled server), or
/// `FORESEERR_PUBLIC_PATH`.
#[must_use]
pub fn public_path(app_root: &std::path::Path) -> PathBuf {
    std::env::var_os("FORESEERR_PUBLIC_PATH")
        .filter(|p| !p.is_empty())
        .map_or_else(|| app_root.join("dist").join("public"), PathBuf::from)
}
