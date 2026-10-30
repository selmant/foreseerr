//! Process configuration, read from the same environment variables the Node
//! server used, so existing container definitions keep working.

use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;

use anyhow::{Context, Result};

/// Everything read from the environment at startup.
#[derive(Debug, Clone)]
pub struct Env {
    /// Where clients connect (`HOST`/`PORT`, default all interfaces, 5055).
    pub listen: SocketAddr,
    /// The config directory holding settings.json and the `SQLite` DB.
    pub config_dir: PathBuf,
    /// Directory with package.json and committag.json.
    pub app_root: PathBuf,
    /// `FORESEERR_PLUGIN`: the Jellyfin plugin sidecar mode.
    pub plugin_mode: bool,
    /// `FORESEERR_RUNTIME=desktop`: the managed desktop runtime.
    pub desktop_runtime: bool,
    /// Extra CA certificates to trust for outgoing calls (PEM file).
    pub extra_ca_file: Option<PathBuf>,
}

impl Env {
    /// Read the environment.
    ///
    /// # Errors
    ///
    /// Fails when `PORT` or `HOST` can't be parsed.
    pub fn from_env() -> Result<Self> {
        let runtime =
            crate::runtime::is_plugin_flag(std::env::var("FORESEERR_PLUGIN").ok().as_deref())
                || std::env::var("FORESEERR_RUNTIME").is_ok_and(|v| v == "desktop");
        let port = match std::env::var("PORT") {
            // The managed runtimes read `Number(PORT)` and bind loopback.
            p if runtime => crate::runtime::node_port(p.ok().as_deref())?,
            Ok(p) => p
                .parse::<u16>()
                .with_context(|| format!("PORT={p} is not a port"))?,
            Err(_) => 5055,
        };
        let host = match std::env::var("HOST") {
            _ if runtime => IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
            Ok(h) if !h.trim().is_empty() => h
                .trim()
                .parse::<IpAddr>()
                .with_context(|| format!("HOST={h} is not an IP address"))?,
            Ok(_) | Err(_) => IpAddr::V6(Ipv6Addr::UNSPECIFIED),
        };
        let app_root = std::env::var_os("FORESEERR_APP_ROOT").map_or_else(
            || std::env::current_dir().unwrap_or_default(),
            PathBuf::from,
        );
        let config_dir = std::env::var_os("CONFIG_DIRECTORY")
            .map_or_else(|| app_root.join("config"), PathBuf::from);
        let plugin_mode = std::env::var("FORESEERR_PLUGIN")
            .is_ok_and(|v| v == "1" || v.eq_ignore_ascii_case("true"));
        Ok(Self {
            listen: SocketAddr::new(host, port),
            config_dir,
            app_root,
            plugin_mode,
            desktop_runtime: std::env::var("FORESEERR_RUNTIME").is_ok_and(|v| v == "desktop"),
            extra_ca_file: std::env::var_os("SHADOW_CA_FILE")
                .or_else(|| std::env::var_os("NODE_EXTRA_CA_CERTS"))
                .map(PathBuf::from),
        })
    }
}
