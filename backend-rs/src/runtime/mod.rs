//! The two managed runtimes.
//!
//! They are the Jellyfin plugin sidecar (`FORESEERR_PLUGIN`,
//! `server/lib/pluginMode.ts`, `server/lib/jellyfinHostBootstrap.ts`) and
//! the desktop child (`FORESEERR_RUNTIME=desktop`,
//! `server/lib/desktopRuntime.ts`, `desktopState.ts`, `desktopLogin.ts`).
//!
//! - [`process`]: the listener (exact IPv4 loopback), the readiness records
//!   on stdout, the desktop control channel on stdin, signals and the exit
//!   codes.
//! - [`http`]: the middleware in front of everything (the plugin mount and
//!   its proxy check, the desktop request guard).
//! - [`desktop`]: the desktop session restore, request log, job start after
//!   sign-in, launch catch-up and playback deferral, the volatile
//!   `applicationUrl`.
//! - [`session`]: express-session's cookie and store writes, with the
//!   per-mode cookie options.
//! - [`plugin`]: the host bootstrap file and the plugin's `index.html`.
//! - [`lock`]: the desktop instance lock.
//! - [`console`]: winston's console transport, for the runtimes whose
//!   launchers read the console.

pub mod console;
pub mod control;
pub mod desktop;
pub mod http;
pub mod lock;
pub mod plugin;
pub mod process;
pub mod session;

use std::net::IpAddr;
use std::sync::LazyLock;
use std::time::Duration;

/// `PLUGIN_PUBLIC_BASE_PATH`.
pub const PLUGIN_PUBLIC_BASE_PATH: &str = "/Foreseerr";

/// The process configuration both runtimes read at startup.
#[derive(Debug, Clone)]
struct Mode {
    plugin: bool,
    desktop: bool,
    base_path: String,
    secret: String,
}

static MODE: LazyLock<Mode> = LazyLock::new(|| {
    let plugin = is_plugin_flag(std::env::var("FORESEERR_PLUGIN").ok().as_deref());
    Mode {
        plugin,
        desktop: std::env::var("FORESEERR_RUNTIME").is_ok_and(|v| v == "desktop"),
        base_path: if plugin {
            base_path(std::env::var("FORESEERR_BASE_PATH").ok().as_deref())
        } else {
            String::new()
        },
        secret: std::env::var("FORESEERR_PLUGIN_SECRET")
            .map(|s| js_trim(&s).to_owned())
            .unwrap_or_default(),
    }
});

/// `isPluginMode()`: `FORESEERR_PLUGIN` is `1` or `true` (any case).
#[must_use]
pub fn is_plugin_flag(flag: Option<&str>) -> bool {
    flag.is_some_and(|v| v == "1" || v.to_lowercase() == "true")
}

/// `isPluginMode()`.
#[must_use]
pub fn plugin_mode() -> bool {
    MODE.plugin
}

/// `isDesktopRuntime()`: the process was started as the desktop child.
#[must_use]
pub fn desktop_runtime() -> bool {
    MODE.desktop
}

/// Either managed runtime.
#[must_use]
pub fn active() -> bool {
    MODE.plugin || MODE.desktop
}

/// `pluginPublicBasePath()`: where the plugin mounts the app, `""`
/// outside plugin mode.
#[must_use]
pub fn plugin_base_path() -> &'static str {
    &MODE.base_path
}

/// `pluginCookiePath()`.
#[must_use]
pub fn cookie_path() -> &'static str {
    if MODE.base_path.is_empty() {
        "/"
    } else {
        &MODE.base_path
    }
}

/// `pluginSharedSecret()`.
#[must_use]
pub fn plugin_secret() -> &'static str {
    &MODE.secret
}

/// The base of the `OpenAPI` validator's `servers` entry
/// (`pluginApiSpec`): the plugin mount in plugin mode, nothing otherwise.
#[must_use]
pub fn api_server_prefix() -> &'static str {
    if active() {
        plugin_base_path()
    } else {
        ""
    }
}

/// The base path from `FORESEERR_BASE_PATH`: `/Foreseerr` when unset,
/// blank or `/`, otherwise with one leading slash and no trailing one.
fn base_path(raw: Option<&str>) -> String {
    let raw = raw.map_or("", js_trim);
    if raw.is_empty() || raw == "/" {
        return String::from(PLUGIN_PUBLIC_BASE_PATH);
    }
    let without = raw.strip_suffix('/').unwrap_or(raw);
    if raw.starts_with('/') {
        without.to_owned()
    } else {
        format!("/{without}")
    }
}

/// `String.prototype.trim`: JavaScript's whitespace, Unicode spaces and
/// line terminators included.
#[must_use]
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// `isLoopbackAddress(req.socket.remoteAddress)`: `127.0.0.1` or `::1`,
/// also as an IPv4-mapped address.
#[must_use]
pub fn is_loopback(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4 == std::net::Ipv4Addr::LOCALHOST,
        IpAddr::V6(v6) => {
            v6 == std::net::Ipv6Addr::LOCALHOST
                || v6
                    .to_ipv4_mapped()
                    .is_some_and(|v4| v4 == std::net::Ipv4Addr::LOCALHOST)
        }
    }
}

/// `verifyPluginSecret(provided)`: same length and bytes, in constant time.
#[must_use]
pub fn verify_secret(provided: Option<&[u8]>) -> bool {
    use subtle::ConstantTimeEq;
    let expected = plugin_secret().as_bytes();
    match provided {
        Some(given) if !given.is_empty() && !expected.is_empty() => {
            given.len() == expected.len() && bool::from(given.ct_eq(expected))
        }
        Some(_) | None => false,
    }
}

/// The Jellyfin client timeout of the sign-in flows: 15 s in the desktop
/// runtime, axios's default (none) otherwise.
#[must_use]
pub fn jellyfin_timeout() -> Option<Duration> {
    (active() && desktop_runtime()).then_some(Duration::from_secs(15))
}

/// `getJellyfinLinkHost()`'s plugin rule.
///
/// Without an external hostname the plugin serves Jellyfin from the browser's own origin, so links use the
/// configured `urlBase` (`urlBase ?? ''`). `None` outside plugin mode.
#[must_use]
pub fn plugin_link_host(settings: &crate::settings::Settings) -> Option<String> {
    if !(active() && plugin_mode()) {
        return None;
    }
    Some(match settings.get("/jellyfin/urlBase") {
        None | Some(serde_json::Value::Null) => String::new(),
        other => crate::media::js_string(other).into_owned(),
    })
}

/// `mediaUrlForItem` in the desktop runtime links through `getHostname()`,
/// never the external hostname.
#[must_use]
pub fn desktop_links_internal() -> bool {
    active() && desktop_runtime()
}

/// `Number(process.env.PORT)` as `startForeseerr` reads it: a whole number
/// `>= 0` is the port, anything else (unset, `NaN`, fractions, negatives)
/// means 5055. Ports past 65535 make `listen` throw.
///
/// # Errors
///
/// A port `listen` refuses.
pub fn node_port(raw: Option<&str>) -> anyhow::Result<u16> {
    let Some(raw) = raw else {
        return Ok(5055);
    };
    match js_number(raw) {
        Some(n) if n >= 0.0 && n.fract() == 0.0 && n.is_finite() => {
            if n > 65535.0 {
                anyhow::bail!(
                    "RangeError [ERR_SOCKET_BAD_PORT]: options.port should be >= 0 and < 65536. Received type number ({raw})."
                );
            }
            Ok(format!("{n}").parse::<u16>().unwrap_or(5055))
        }
        Some(_) | None => Ok(5055),
    }
}

/// `Number(text)` for the forms a port can take: blank is 0, decimal with
/// an optional sign, fraction and exponent, `0x`/`0o`/`0b` integers and
/// `Infinity`. `None` is `NaN`.
fn js_number(text: &str) -> Option<f64> {
    let t = js_trim(text);
    if t.is_empty() {
        return Some(0.0);
    }
    let radix = |prefix: &[&str], base: u32| -> Option<Option<f64>> {
        let digits = prefix.iter().find_map(|p| t.strip_prefix(p))?;
        Some(
            (!digits.is_empty())
                .then(|| u64::from_str_radix(digits, base).ok())
                .flatten()
                .map(|n| format!("{n}").parse::<f64>().unwrap_or(f64::NAN)),
        )
    };
    if let Some(n) = radix(&["0x", "0X"], 16)
        .or_else(|| radix(&["0o", "0O"], 8))
        .or_else(|| radix(&["0b", "0B"], 2))
    {
        return n;
    }
    let unsigned = t.strip_prefix(['+', '-']).unwrap_or(t);
    if unsigned == "Infinity" {
        return Some(if t.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        });
    }
    let valid = !unsigned.is_empty()
        && unsigned
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'))
        && unsigned
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_digit() || b == b'.');
    if !valid {
        return None;
    }
    t.parse::<f64>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_paths_like_plugin_public_base_path() {
        assert_eq!(base_path(None), "/Foreseerr", "unset");
        assert_eq!(base_path(Some(" / ")), "/Foreseerr", "root");
        assert_eq!(base_path(Some("x/")), "/x", "no leading slash");
        assert_eq!(base_path(Some("/a/b/")), "/a/b", "trailing slash");
        assert_eq!(base_path(Some("/a//")), "/a/", "only one slash dropped");
    }

    #[test]
    fn plugin_flag() {
        assert!(is_plugin_flag(Some("1")), "1");
        assert!(is_plugin_flag(Some("TRUE")), "true");
        assert!(!is_plugin_flag(Some("yes")), "yes");
        assert!(!is_plugin_flag(None), "unset");
    }

    #[test]
    fn ports_like_number() -> anyhow::Result<()> {
        assert_eq!(node_port(None)?, 5055, "unset");
        assert_eq!(node_port(Some(""))?, 0, "blank is zero");
        assert_eq!(node_port(Some(" 7500 "))?, 7500, "trimmed");
        assert_eq!(node_port(Some("0x1d4c"))?, 7500, "hex");
        assert_eq!(node_port(Some("7.5e3"))?, 7500, "exponent");
        assert_eq!(node_port(Some("abc"))?, 5055, "NaN");
        assert_eq!(node_port(Some("-1"))?, 5055, "negative");
        assert_eq!(node_port(Some("1.5"))?, 5055, "fraction");
        assert!(node_port(Some("70000")).is_err(), "too large");
        Ok(())
    }

    #[test]
    fn loopback_addresses() {
        assert!(
            is_loopback(
                "127.0.0.1"
                    .parse()
                    .unwrap_or(IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED))
            ),
            "v4"
        );
        assert!(is_loopback(IpAddr::V6(std::net::Ipv6Addr::LOCALHOST)), "v6");
        assert!(
            is_loopback(IpAddr::V6(std::net::Ipv4Addr::LOCALHOST.to_ipv6_mapped())),
            "mapped"
        );
        assert!(
            !is_loopback(IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 2))),
            "127.0.0.2"
        );
    }
}
