//! Standalone mode: this process is the whole backend, with no Node behind
//! it.
//!
//! It runs what `server/index.ts` runs before listening (database
//! migrations, the settings bootstrap, the Overseerr merge, the startup
//! tasks), answers what Node would answer for requests no Rust handler
//! takes, serves the built frontend, and answers Node's `/internal` calls
//! in-process.
//!
//! On when `FORESEERR_STANDALONE=1`, or when `FORESEERR_NODE_URL` is unset;
//! `FORESEERR_STANDALONE=0` keeps the old default (Node on 127.0.0.1:5056).
//! Standalone implies `FORESEERR_RUST_JOBS`.

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
use std::sync::LazyLock;

pub use startup::{after_state, before_state, Boot};

static ENABLED: LazyLock<bool> = LazyLock::new(|| {
    decide(
        std::env::var("FORESEERR_STANDALONE").ok().as_deref(),
        std::env::var("FORESEERR_NODE_URL").ok().as_deref(),
    )
});

/// Whether this process runs without Node.
#[must_use]
pub fn enabled() -> bool {
    *ENABLED
}

fn decide(flag: Option<&str>, node_url: Option<&str>) -> bool {
    match flag.map(str::trim) {
        Some(v) if v == "1" || v.eq_ignore_ascii_case("true") => true,
        Some(v) if v == "0" || v.eq_ignore_ascii_case("false") => false,
        Some(_) | None => node_url.is_none_or(|u| u.trim().is_empty()),
    }
}

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

#[cfg(test)]
mod tests {
    use super::decide;

    #[test]
    fn standalone_switch() {
        assert!(decide(None, None), "no Node configured");
        assert!(decide(None, Some(" ")), "an empty Node URL");
        assert!(
            !decide(None, Some("http://127.0.0.1:5056")),
            "Node configured"
        );
        assert!(
            decide(Some("1"), Some("http://127.0.0.1:5056")),
            "forced on"
        );
        assert!(decide(Some("TRUE"), None), "forced on");
        assert!(!decide(Some("0"), None), "forced off");
        assert!(!decide(Some("false"), None), "forced off");
        assert!(
            !decide(Some("yes"), Some("http://n")),
            "unknown values follow the URL"
        );
    }
}
