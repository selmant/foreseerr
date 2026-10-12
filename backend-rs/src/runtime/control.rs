//! The desktop child's control channel (`installDesktopControlHandlers`) and
//! its shutdown (`stopManagedRuntime` + `process.exit(0)`).
//!
//! The host writes one JSON object per line on stdin:
//! - `{"type":"shutdown","deadlineMs":n}`: stop (below), waiting at most
//!   `deadlineMs` (default 10 s) for open requests;
//! - `{"type":"runtime-state","playbackActive":bool}`: heavy jobs wait
//!   while playback is active; going idle queues the launch catch-up.
//!
//! Anything else is logged and ignored. End of stdin, `SIGTERM` and
//! `SIGINT` stop like a `shutdown` without a deadline. A second stop
//! request while the first is still running (a second signal included)
//! exits at once with 0, as Node's second `requestManagedShutdown` does
//! (`stopping` is already set, so it goes straight to `process.exit(0)`).
//!
//! Stopping: `stopping` is set (every request but `/api/v1/status` gets
//! 503), the jobs stop, the listener closes and open requests get until the
//! deadline, then `SQLite` is checkpointed (`wal_checkpoint(TRUNCATE)`),
//! the database closed and the instance lock released; the process exits
//! with 0.

use std::io::BufRead;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::{mpsc, watch};

use crate::state::AppState;

/// `requestManagedShutdown`'s default deadline.
const DEFAULT_DEADLINE_MS: u64 = 10_000;

struct Channels {
    requests: mpsc::UnboundedSender<u64>,
    /// Set once the listener should stop accepting.
    graceful: watch::Sender<bool>,
    /// Set once the process may exit, with its code.
    exit: watch::Sender<Option<u8>>,
    /// Set by the server once it closed.
    finished: watch::Sender<bool>,
}

static CHANNELS: OnceLock<Channels> = OnceLock::new();
static STATE: OnceLock<Arc<AppState>> = OnceLock::new();
static SERVING: AtomicBool = AtomicBool::new(false);
static STOP_REQUESTED: AtomicBool = AtomicBool::new(false);

/// Start reading stdin and the signals, and the task that stops the
/// process. Desktop runtime only.
pub fn install() {
    let (requests, rx) = mpsc::unbounded_channel();
    let (graceful, _) = watch::channel(false);
    let (exit, _) = watch::channel(None);
    let (finished, _) = watch::channel(false);
    if CHANNELS
        .set(Channels {
            requests,
            graceful,
            exit,
            finished,
        })
        .is_err()
    {
        return;
    }
    tokio::spawn(stopper(rx));
    tokio::spawn(signals());
    // stdin blocks; a plain thread ends with the process.
    drop(std::thread::spawn(read_stdin));
}

/// Hand the stop task the state whose database it closes.
pub fn attach_state(state: &Arc<AppState>) {
    STATE.set(Arc::clone(state)).ok();
}

/// `requestManagedShutdown(deadlineMs)`.
pub fn request(deadline_ms: u64) {
    if STOP_REQUESTED.swap(true, Ordering::SeqCst) {
        // `stopping` is already set: straight to `process.exit(0)`.
        if let Some(channels) = CHANNELS.get() {
            channels.exit.send_replace(Some(0));
        }
        return;
    }
    if let Some(channels) = CHANNELS.get() {
        channels.requests.send(deadline_ms).ok();
    }
}

/// Resolves when the listener should close (graceful shutdown).
pub async fn graceful() {
    let Some(channels) = CHANNELS.get() else {
        return std::future::pending().await;
    };
    let mut rx = channels.graceful.subscribe();
    rx.wait_for(|stop| *stop).await.ok();
}

/// The server is accepting connections.
pub fn serving() {
    SERVING.store(true, Ordering::SeqCst);
}

/// The server closed (every connection finished).
pub fn finished() {
    if let Some(channels) = CHANNELS.get() {
        channels.finished.send_replace(true);
    }
}

/// Resolves with the exit code once the process should exit; never
/// outside the desktop runtime.
pub async fn exit_requested() -> u8 {
    let Some(channels) = CHANNELS.get() else {
        return std::future::pending().await;
    };
    let mut rx = channels.exit.subscribe();
    let code = rx
        .wait_for(Option::is_some)
        .await
        .map(|code| code.unwrap_or(0));
    match code {
        Ok(code) => code,
        Err(_) => std::future::pending().await,
    }
}

/// The stop sequence, run once.
async fn stopper(mut rx: mpsc::UnboundedReceiver<u64>) {
    let Some(deadline) = rx.recv().await else {
        return;
    };
    super::desktop::set_stopping(true);
    super::desktop::stop_jobs();
    let Some(channels) = CHANNELS.get() else {
        return;
    };
    channels.graceful.send_replace(true);
    if SERVING.load(Ordering::SeqCst) {
        let mut done = channels.finished.subscribe();
        let wait = done.wait_for(|finished| *finished);
        if tokio::time::timeout(Duration::from_millis(deadline), wait)
            .await
            .is_err()
        {
            tracing::debug!(label = "Desktop", "closing the remaining connections");
        }
    }
    if let Some(state) = STATE.get() {
        close_database(state).await;
    }
    super::process::release_lock();
    channels.exit.send_replace(Some(0));
}

/// `PRAGMA wal_checkpoint(TRUNCATE)` on `SQLite`, then `dataSource.destroy()`.
async fn close_database(state: &AppState) {
    match &state.db {
        crate::db::Db::Sqlite(pool) => {
            if let Err(e) = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
                .execute(pool)
                .await
            {
                tracing::debug!("checkpointing the database failed: {e}");
            }
            pool.close().await;
        }
        crate::db::Db::Postgres(pool) => pool.close().await,
    }
}

/// `SIGTERM` and `SIGINT` request the stop; a second one, like any second
/// request, exits at once.
async fn signals() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let (Ok(mut term), Ok(mut int)) = (
            signal(SignalKind::terminate()),
            signal(SignalKind::interrupt()),
        ) else {
            tracing::warn!("installing the signal handlers failed");
            return;
        };
        loop {
            tokio::select! {
                _ = term.recv() => {}
                _ = int.recv() => {}
            }
            request(DEFAULT_DEADLINE_MS);
        }
    }
    #[cfg(not(unix))]
    {
        loop {
            if tokio::signal::ctrl_c().await.is_err() {
                return;
            }
            request(DEFAULT_DEADLINE_MS);
        }
    }
}

/// `process.stdin.on('data' | 'end')`: complete lines are handled, a
/// partial last line is dropped at the end.
fn read_stdin() {
    let stdin = std::io::stdin();
    let mut lock = stdin.lock();
    let mut line = Vec::new();
    loop {
        line.clear();
        match lock.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if line.last() == Some(&b'\n') {
                    line.pop();
                    handle(&String::from_utf8_lossy(&line));
                }
            }
        }
    }
    request(DEFAULT_DEADLINE_MS);
}

/// What one control line asks for.
#[derive(Debug, Clone, PartialEq)]
enum Message {
    Shutdown(u64),
    Playback(bool),
    Unknown,
    Malformed,
}

/// `JSON.parse(line)` and the dispatch on `message.type`.
fn parse(line: &str) -> Message {
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        return Message::Malformed;
    };
    // `null.type` and `undefined.type` throw inside the try.
    if message.is_null() {
        return Message::Malformed;
    }
    match message.get("type").and_then(Value::as_str) {
        Some("shutdown") => Message::Shutdown(deadline(message.get("deadlineMs"))),
        Some("runtime-state") => match message.get("playbackActive") {
            Some(Value::Bool(active)) => Message::Playback(*active),
            _ => Message::Unknown,
        },
        _ => Message::Unknown,
    }
}

/// `setTimeout(..., deadlineMs)` with `deadlineMs = 10_000` as default
/// parameter: `undefined` is the default, and whatever isn't a delay of
/// 1 ms to 2^31 - 1 ms becomes 1 ms.
fn deadline(value: Option<&Value>) -> u64 {
    let number = match value {
        None => return DEFAULT_DEADLINE_MS,
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => {
            let t = super::js_trim(s);
            if t.is_empty() {
                Some(0.0)
            } else {
                t.parse::<f64>().ok()
            }
        }
        Some(Value::Bool(b)) => Some(if *b { 1.0 } else { 0.0 }),
        Some(Value::Null) => Some(0.0),
        Some(Value::Array(_) | Value::Object(_)) => None,
    };
    match number {
        Some(n) if (1.0..=2_147_483_647.0).contains(&n) => {
            format!("{}", n.trunc()).parse::<u64>().unwrap_or(1)
        }
        Some(_) | None => 1,
    }
}

fn handle(line: &str) {
    match parse(line) {
        Message::Shutdown(deadline) => request(deadline),
        Message::Playback(active) => super::desktop::set_playback(active),
        Message::Unknown => {
            tracing::warn!(
                label = "Desktop",
                "Ignoring unknown desktop control message"
            );
        }
        Message::Malformed => {
            tracing::warn!(
                label = "Desktop",
                "Ignoring malformed desktop control message"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_messages() {
        assert_eq!(
            parse(r#"{"type":"shutdown","deadlineMs":2000}"#),
            Message::Shutdown(2000),
            "shutdown"
        );
        assert_eq!(
            parse(r#"{"type":"shutdown"}"#),
            Message::Shutdown(10_000),
            "default deadline"
        );
        assert_eq!(
            parse(r#"{"type":"shutdown","deadlineMs":"x"}"#),
            Message::Shutdown(1),
            "NaN delay"
        );
        assert_eq!(
            parse(r#"{"type":"runtime-state","playbackActive":false}"#),
            Message::Playback(false),
            "playback"
        );
        assert_eq!(
            parse(r#"{"type":"runtime-state","playbackActive":"no"}"#),
            Message::Unknown,
            "not a boolean"
        );
        assert_eq!(parse("5"), Message::Unknown, "a number");
        assert_eq!(parse("null"), Message::Malformed, "null throws");
        assert_eq!(parse("garbage"), Message::Malformed, "not JSON");
        assert_eq!(parse(""), Message::Malformed, "empty line");
    }
}
