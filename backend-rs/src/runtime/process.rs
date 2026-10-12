//! The process contract of the managed runtimes (`startForeseerr` in
//! `server/index.ts`).
//!
//! - Both bind exact IPv4 loopback, `127.0.0.1`, whatever `HOST` says, on
//!   `PORT` as `Number(process.env.PORT)` reads it (`0` lets the system
//!   pick).
//! - The plugin writes `FORESEERR_PLUGIN_READY {"port":<port>,"instance":
//!   <FORESEERR_PLUGIN_INSTANCE>}` on stdout once listening, then logs
//!   `Server ready on 127.0.0.1 port <port>/Foreseerr`; its console logs
//!   follow winston's split (errors and warnings on stderr, the rest on
//!   stdout).
//! - The desktop child logs `Server ready ...` (all of its console output is
//!   on stderr) and then writes its only stdout line,
//!   `FORESEERR_DESKTOP_READY {"protocolVersion":1,"pid":…,"origin":
//!   "http://127.0.0.1:<port>","foreseerrVersion":…,"commit":
//!   <FORESEERR_COMMIT or "unknown">,"schemaVersion":<latest migration>}`.
//! - A failed start logs the error and exits with its code: 73 for the
//!   desktop lock (`DESKTOP_LOCK_EXIT_CODE`), 74 for a database schema the
//!   desktop can't use (`DESKTOP_SCHEMA_EXIT_CODE`), 1 otherwise.
//! - `SIGTERM` and `SIGINT` stop the server gracefully (the requests in
//!   flight finish) and the process exits with 0; the desktop child stops
//!   through its control channel ([`super::control`]).

use std::io::Write;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use serde_json::{Map, Value};
use tokio::net::TcpListener;

use super::lock::DesktopLock;
use crate::state::AppState;

/// An error that ends the process with a specific code
/// (`DesktopRuntimeError.exitCode`).
#[derive(Debug, Clone)]
pub struct ExitError {
    message: String,
    code: u8,
}

impl ExitError {
    /// `desktopError(message, exitCode)`.
    #[must_use]
    pub fn new(message: &str, code: i32) -> Self {
        Self {
            message: message.to_owned(),
            code: u8::try_from(code).unwrap_or(1),
        }
    }
}

impl std::fmt::Display for ExitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ExitError {}

/// The exit code of a failed start: `error.exitCode ?? 1`.
#[must_use]
pub fn exit_code(error: &anyhow::Error) -> u8 {
    error
        .chain()
        .find_map(|e| e.downcast_ref::<ExitError>())
        .map_or(1, |e| e.code)
}

static LOCK: Mutex<Option<DesktopLock>> = Mutex::new(None);

/// What `startForeseerr` does before anything else: in the desktop
/// runtime, the control channel and the instance lock.
///
/// # Errors
///
/// The lock's [`ExitError`].
pub fn before_startup() -> Result<()> {
    if !super::active() {
        return Ok(());
    }
    let root = crate::env::Env::from_env()?.app_root;
    tracing::info!(
        "Starting Seerr version {}",
        crate::version::AppVersion::load(&root).version
    );
    if !super::desktop_runtime() {
        return Ok(());
    }
    super::control::install();
    let lock = DesktopLock::acquire()?;
    *crate::sync::lock(&LOCK) = Some(lock);
    Ok(())
}

/// `releaseDesktopLock()`; nothing when no lock is held.
pub fn release_lock() {
    let held = crate::sync::lock(&LOCK).take();
    if let Some(mut lock) = held {
        lock.release();
    }
}

/// A failed start: Node logs the error, releases what the desktop start
/// took (`cleanupFailedDesktopStart`) and exits with the error's code.
#[must_use]
pub fn failed(error: &anyhow::Error) -> u8 {
    if super::active() && super::desktop_runtime() {
        tracing::info!(label = "Jobs", "Scheduled jobs stopped");
    }
    tracing::error!("Error: {error:#}");
    release_lock();
    exit_code(error)
}

/// The schema guard's failure, as the desktop runtime reports it.
#[must_use]
pub fn schema_error(error: anyhow::Error) -> anyhow::Error {
    if super::active() && super::desktop_runtime() {
        release_lock();
        return ExitError::new(
            &format!("Desktop database schema is incompatible: {error:#}"),
            super::lock::DESKTOP_SCHEMA_EXIT_CODE,
        )
        .into();
    }
    error
}

/// `notificationManager.registerAgents(...)`'s log; the agents themselves
/// are static here.
pub fn agents_registered() {
    if super::active() {
        tracing::info!(label = "Notifications", "Registered notification agents");
    }
}

/// The last startup steps of the runtimes: the plugin refuses to run
/// without its shared secret, the desktop announces its session store.
///
/// # Errors
///
/// `Plugin mode requires FORESEERR_PLUGIN_SECRET`.
pub fn after_startup() -> Result<()> {
    if !super::active() {
        return Ok(());
    }
    if super::plugin_mode() && super::plugin_secret().is_empty() {
        anyhow::bail!("Plugin mode requires FORESEERR_PLUGIN_SECRET");
    }
    if super::plugin_mode() {
        // `pluginIndexHtml` runs on index.html before the listener opens.
        super::plugin::check_index_base()?;
    }
    if super::desktop_runtime() {
        tracing::info!(label = "Server", "Desktop session store is sqlite");
    }
    Ok(())
}

/// The listener: exact IPv4 loopback in the runtimes, `HOST`/`PORT`
/// otherwise.
///
/// # Errors
///
/// The port is taken or refused.
pub async fn bind(state: &AppState) -> Result<TcpListener> {
    let address = if super::active() {
        SocketAddr::new(
            Ipv4Addr::LOCALHOST.into(),
            super::node_port(std::env::var("PORT").ok().as_deref())?,
        )
    } else {
        state.env.listen
    };
    let listener = TcpListener::bind(address)
        .await
        .with_context(|| format!("listening on {address}"))?;
    if super::active() {
        super::control::serving();
    }
    Ok(listener)
}

/// Serve until the process should end, with the readiness records of the
/// runtimes. Returns the exit code.
///
/// # Errors
///
/// The listener fails.
pub async fn serve(state: Arc<AppState>, listener: TcpListener, app: axum::Router) -> Result<u8> {
    let bound = listener.local_addr().context("reading the bound address")?;
    if !super::active() {
        if crate::standalone::enabled() {
            tracing::info!("listening on {bound}, standalone (no Node behind this server)");
        } else {
            tracing::info!(
                "listening on {bound}, forwarding routes not ported yet to {}",
                state.env.node_url
            );
        }
        serve_until(listener, app, shutdown_signal()).await?;
        return Ok(0);
    }
    announce(&state, bound).await;
    if super::desktop_runtime() {
        super::control::attach_state(&state);
        let served = serve_until(listener, app, super::control::graceful()).await;
        super::control::finished();
        served?;
        // The stop task ends the process.
        return Ok(super::control::exit_requested().await);
    }
    serve_until(listener, app, shutdown_signal()).await?;
    Ok(0)
}

/// `axum::serve` with the peer address for [`ConnectInfo`], until
/// `shutdown` resolves; the requests in flight then finish.
///
/// [`ConnectInfo`]: axum::extract::ConnectInfo
async fn serve_until<F>(listener: TcpListener, app: axum::Router, shutdown: F) -> Result<()>
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    use axum::serve::ListenerExt as _;
    let listener = listener.tap_io(|tcp| {
        if let Err(e) = tcp.set_nodelay(true) {
            tracing::debug!("TCP_NODELAY: {e}");
        }
    });
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown)
    .await
    .context("serving")
}

/// The `listening` callbacks: the plugin's readiness record and the log,
/// or the log and the desktop's readiness record.
async fn announce(state: &AppState, bound: SocketAddr) {
    let port = bound.port();
    if super::plugin_mode() {
        let mut ready = Map::new();
        ready.insert(String::from("port"), Value::from(port));
        if let Ok(instance) = std::env::var("FORESEERR_PLUGIN_INSTANCE") {
            ready.insert(String::from("instance"), Value::from(instance));
        }
        stdout_line(&format!("FORESEERR_PLUGIN_READY {}", Value::Object(ready)));
    }
    tracing::info!(
        label = "Server",
        "Server ready on 127.0.0.1 port {port}{}",
        super::plugin_base_path()
    );
    if !super::desktop_runtime() {
        return;
    }
    let origin = format!("http://127.0.0.1:{port}");
    super::desktop::set_origin(&origin);
    let mut ready = Map::new();
    ready.insert(String::from("protocolVersion"), Value::from(1));
    ready.insert(String::from("pid"), Value::from(std::process::id()));
    ready.insert(String::from("origin"), Value::from(origin));
    ready.insert(
        String::from("foreseerrVersion"),
        Value::from(state.version.version.as_str()),
    );
    ready.insert(
        String::from("commit"),
        Value::from(std::env::var("FORESEERR_COMMIT").unwrap_or_else(|_| String::from("unknown"))),
    );
    ready.insert(
        String::from("schemaVersion"),
        Value::from(schema_version(state).await),
    );
    stdout_line(&format!("FORESEERR_DESKTOP_READY {}", Value::Object(ready)));
}

/// `getDatabaseSchemaVersion()`: the latest applied migration's timestamp,
/// 0 without a migrations table or a usable value.
async fn schema_version(state: &AppState) -> i64 {
    let rows = state
        .db
        .rows(
            r#"SELECT CAST(MAX(timestamp) AS BIGINT) AS "schemaVersion" FROM migrations"#,
            &[],
        )
        .await;
    rows.ok()
        .and_then(|rows| rows.into_iter().next())
        .and_then(|row| row.get("schemaVersion").and_then(Value::as_i64))
        .filter(|v| (0..=9_007_199_254_740_991).contains(v))
        .unwrap_or(0)
}

/// `process.stdout.write(line + '\n')`.
fn stdout_line(line: &str) {
    let mut out = std::io::stdout().lock();
    if out
        .write_all(format!("{line}\n").as_bytes())
        .and_then(|()| out.flush())
        .is_err()
    {
        tracing::debug!("stdout is closed");
    }
}

/// Resolves on Ctrl-C or SIGTERM, so in-flight requests finish before exit.
pub async fn shutdown_signal() {
    let interrupt = async {
        if let Err(e) = tokio::signal::ctrl_c().await {
            tracing::warn!("ctrl-c handler failed: {e}");
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(e) => {
                tracing::warn!("SIGTERM handler failed: {e}");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = interrupt => {}
        () = terminate => {}
    }
    tracing::info!("shutting down");
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::extract::ConnectInfo;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    async fn exchange(port: u16, request: &str) -> std::io::Result<String> {
        let mut stream = tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await?;
        stream.write_all(request.as_bytes()).await?;
        let mut answer = Vec::new();
        stream.read_to_end(&mut answer).await?;
        Ok(String::from_utf8_lossy(&answer).into_owned())
    }

    #[tokio::test]
    async fn serves_with_the_peer_and_stops_gracefully() -> Result<()> {
        let app = axum::Router::new().route(
            "/peer",
            axum::routing::get(|ConnectInfo(peer): ConnectInfo<SocketAddr>| async move {
                peer.ip().to_string()
            }),
        );
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let port = listener.local_addr()?.port();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(serve_until(listener, app, async move {
            stopped.await.ok();
        }));
        let answer = exchange(
            port,
            "GET /peer HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n",
        )
        .await?;
        assert!(answer.starts_with("HTTP/1.1 200 OK\r\n"), "{answer}");
        assert!(answer.ends_with("127.0.0.1"), "{answer}");
        let answer = exchange(
            port,
            "HEAD /peer HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n",
        )
        .await?;
        assert!(answer.ends_with("\r\n\r\n"), "HEAD has no body: {answer}");
        stop.send(()).ok();
        let ended = tokio::time::timeout(std::time::Duration::from_secs(5), server).await;
        assert!(
            matches!(ended, Ok(Ok(Ok(())))),
            "stops once asked: {ended:?}"
        );
        Ok(())
    }

    #[test]
    fn exit_codes() {
        let lock: anyhow::Error = ExitError::new("locked", 73).into();
        assert_eq!(exit_code(&lock), 73, "lock");
        assert_eq!(exit_code(&lock.context("starting")), 73, "through context");
        assert_eq!(exit_code(&anyhow::anyhow!("other")), 1, "default");
    }
}
