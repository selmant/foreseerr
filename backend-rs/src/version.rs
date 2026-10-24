//! The app version and commit tag, as Node reports them.

use std::path::Path;

/// package.json of the app this binary ships with.
const PACKAGE_JSON: &str = include_str!("../../package.json");

/// Version information, read once at startup.
#[derive(Debug, Clone)]
pub struct AppVersion {
    /// `0.13.1`, or `develop-<commit>` for unversioned builds.
    pub version: String,
    /// The commit the build was made from, or `local`.
    pub commit_tag: String,
}

impl AppVersion {
    /// Read committag.json next to package.json, like Node does.
    #[must_use]
    pub fn load(app_root: &Path) -> Self {
        let commit_tag = std::fs::read_to_string(app_root.join("committag.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|v| {
                v.get("commitTag")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| String::from("local"));
        let package_version = serde_json::from_str::<serde_json::Value>(PACKAGE_JSON)
            .ok()
            .and_then(|v| {
                v.get("version")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_default();
        let version = if package_version == "0.1.0" {
            format!("develop-{commit_tag}")
        } else {
            package_version
        };
        Self {
            version,
            commit_tag,
        }
    }

    /// `Foreseerr/<version>`, sent on every outgoing call.
    #[must_use]
    pub fn user_agent(&self) -> String {
        format!("Foreseerr/{}", self.version)
    }
}
