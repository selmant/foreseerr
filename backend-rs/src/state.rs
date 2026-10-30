//! What every handler can reach.

use anyhow::{Context, Result};
use serde_json::Value;

use crate::db::Db;
use crate::env::Env;
use crate::github::GithubApi;
use crate::proxy::NodeProxy;
use crate::ratings::Ratings;
use crate::servarr::ServarrClient;
use crate::settings::{Settings, SettingsStore};
use crate::tmdb::TmdbClient;
use crate::version::AppVersion;

/// The network settings that only take effect at startup, as
/// `server/utils/restartFlag.ts` snapshots them.
#[derive(Debug, Clone, PartialEq, Eq)]
struct NetworkSnapshot {
    csrf_protection: Option<Value>,
    trust_proxy: Option<Value>,
    proxy_enabled: Option<Value>,
}

impl NetworkSnapshot {
    fn of(settings: &Settings) -> Self {
        let (csrf_protection, trust_proxy, proxy_enabled) = settings.restart_relevant_network();
        Self {
            csrf_protection: csrf_protection.cloned(),
            trust_proxy: trust_proxy.cloned(),
            proxy_enabled: proxy_enabled.cloned(),
        }
    }
}

/// Shared, read-mostly state built once at startup.
#[derive(Debug)]
pub struct AppState {
    /// Process configuration.
    pub env: Env,
    /// Version and commit tag.
    pub version: AppVersion,
    /// settings.json.
    pub settings: SettingsStore,
    /// The database Node created.
    pub db: Db,
    /// The Node server behind this one.
    pub node: NodeProxy,
    /// The update check.
    pub github: GithubApi,
    /// TMDB lookups.
    pub tmdb: TmdbClient,
    /// Radarr and Sonarr lookups.
    pub servarr: ServarrClient,
    /// The outgoing HTTP client (proxy and CA settings applied).
    pub outbound: reqwest::Client,
    /// Rotten Tomatoes, `IMDb` and `MDBList` ratings.
    pub ratings: Ratings,
    /// A plain client for Node's `/internal` routes on loopback: no proxy,
    /// no extra CA, so a replay proxy never sees these calls.
    pub internal: reqwest::Client,
    startup_network: NetworkSnapshot,
}

impl AppState {
    /// Build the state from the environment and settings.json.
    ///
    /// # Errors
    ///
    /// Fails when the environment, settings.json or the database settings
    /// can't be read.
    pub async fn from_env() -> Result<Self> {
        let env = Env::from_env()?;
        let version = AppVersion::load(&env.app_root);
        let settings = SettingsStore::new(&env.config_dir);
        let current = settings.current().await?;
        let startup_network = NetworkSnapshot::of(&current);
        let db = Db::open(&env.config_dir)?;
        let node = NodeProxy::new(&env.node_url)?;
        let outbound = crate::outbound::client(&current, &version, env.extra_ca_file.as_deref())?;
        let github = GithubApi::new(outbound.clone());
        let servarr = ServarrClient::new(outbound.clone());
        let ratings = Ratings::new(outbound.clone());
        let outbound_shared = outbound.clone();
        let tmdb = TmdbClient::new(outbound);
        let internal = reqwest::Client::builder()
            .no_proxy()
            .default_headers(crate::csrf::internal_headers())
            .build()
            .context("building the client for Node's internal routes")?;
        Ok(Self {
            env,
            version,
            settings,
            db,
            node,
            github,
            tmdb,
            servarr,
            ratings,
            outbound: outbound_shared,
            internal,
            startup_network,
        })
    }

    /// A state over `db` for tests of the jobs: settings.json is read from
    /// `config_dir`, and no Node server listens behind it.
    ///
    /// # Errors
    ///
    /// Fails when a client can't be built.
    #[cfg(test)]
    pub fn for_tests(db: Db, config_dir: &std::path::Path) -> Result<Self> {
        if rustls::crypto::ring::default_provider()
            .install_default()
            .is_err()
        {
            tracing::trace!("a provider was installed");
        }
        let env = Env {
            listen: std::net::SocketAddr::from(([127, 0, 0, 1], 0)),
            config_dir: config_dir.to_owned(),
            node_url: String::from("http://127.0.0.1:9"),
            app_root: config_dir.to_owned(),
            plugin_mode: false,
            desktop_runtime: false,
            extra_ca_file: None,
        };
        let version = AppVersion {
            version: String::from("0.0.0"),
            commit_tag: String::from("local"),
        };
        let current = Settings::from_file_value(Value::Object(serde_json::Map::new()), None)?;
        let outbound = crate::outbound::client(&current, &version, None)?;
        Ok(Self {
            settings: SettingsStore::new(config_dir),
            db,
            node: NodeProxy::new(&env.node_url)?,
            github: GithubApi::new(outbound.clone()),
            tmdb: TmdbClient::new(outbound.clone()),
            servarr: ServarrClient::new(outbound.clone()),
            ratings: Ratings::new(outbound.clone()),
            outbound,
            internal: reqwest::Client::builder().no_proxy().build()?,
            startup_network: NetworkSnapshot::of(&current),
            env,
            version,
        })
    }

    /// `settings.network.csrfProtection` as Node read it when it mounted
    /// csurf at startup.
    #[must_use]
    pub fn csrf_at_startup(&self) -> bool {
        crate::settings::public::truthy(self.startup_network.csrf_protection.as_ref())
    }

    /// `settings.network.trustProxy` as Node read it at startup.
    #[must_use]
    pub fn trust_proxy_at_startup(&self) -> bool {
        crate::settings::public::truthy(self.startup_network.trust_proxy.as_ref())
    }

    /// `restartFlag.isSet()`: a network setting that only applies at
    /// startup has changed since then.
    #[must_use]
    pub fn restart_required(&self, current: &Settings) -> bool {
        NetworkSnapshot::of(current) != self.startup_network
    }
}
