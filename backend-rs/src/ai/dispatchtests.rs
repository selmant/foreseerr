//! Regression coverage for removal before dispatch and during a rejected POST.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::{json, Value};
use tokio::sync::{mpsc, Notify};
use tokio::time::timeout;

use super::store::{self, Connection, Kind, Owner, Status, Write};
use super::{AiError, Prompt};
use crate::dbtx::scratch::{self, Scratch};
use crate::state::AppState;

async fn setup(owner: Owner, url: &str) -> Result<(Scratch, Arc<AppState>, Connection, PathBuf)> {
    let scratch = scratch::sqlite(&format!(
        "ai-dispatch-{}",
        crate::standalone::settingsfile::uuid_v4()?
    ))
    .await?;
    scratch.db.execute(r#"INSERT INTO "user" ("id", "email", "permissions", "userType", "avatar") VALUES (1, 'dispatch@example.test', 0, 1, '')"#, &[]).await?;
    let dir = std::env::temp_dir().join(format!(
        "foreseerr-ai-dispatch-{}",
        crate::standalone::settingsfile::uuid_v4()?
    ));
    std::fs::create_dir_all(&dir)?;
    let state = Arc::new(AppState::for_tests(scratch.db.clone(), &dir)?);
    let vault = super::vault(&state).map_err(|e| anyhow::anyhow!("{e}"))?;
    let held = store::lock().await;
    store::save(
        &state.db,
        &vault,
        owner,
        Write {
            kind: Kind::OpenAi,
            base_url: Some(url.to_owned()),
            model: Some(String::from("test")),
            credentials: Some(None),
            identity: None,
            status: Status::Ok,
        },
        &held,
    )
    .await?;
    let conn = store::load(&state.db, owner)
        .await?
        .context("saved connection")?;
    Ok((scratch, state, conn, dir))
}

async fn answer(state: &AppState, conn: &Connection) -> Result<String, AiError> {
    let schema = json!({"type":"object"});
    super::complete(
        state,
        conn,
        Some("test"),
        &Prompt {
            instructions: "Return JSON",
            input: "Private taste sentinel",
            schema: Some(("test", &schema)),
        },
    )
    .await
}

#[tokio::test]
async fn removal_cancels_an_in_flight_post_before_any_fallback() -> Result<()> {
    for owner in [Owner::Server, Owner::User(1)] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}", listener.local_addr()?);
        let calls = Arc::new(AtomicUsize::new(0));
        let release = Arc::new(Notify::new());
        let (started_tx, mut started) = mpsc::unbounded_channel();
        let app = axum::Router::new().route(
            "/chat/completions",
            axum::routing::post({
                let calls = Arc::clone(&calls);
                let release = Arc::clone(&release);
                move |axum::Json(body): axum::Json<Value>| {
                    let (calls, release, started_tx) =
                        (Arc::clone(&calls), Arc::clone(&release), started_tx.clone());
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        drop(started_tx.send(body));
                        release.notified().await;
                        (
                            axum::http::StatusCode::BAD_REQUEST,
                            axum::Json(json!({"error":"unsupported schema"})),
                        )
                    }
                }
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await });
        let (_scratch, state, conn, dir) = setup(owner, &url).await?;
        let task = tokio::spawn({
            let state = Arc::clone(&state);
            let conn = conn.clone();
            async move { answer(&state, &conn).await }
        });
        let body = timeout(Duration::from_secs(3), started.recv())
            .await
            .context("waiting for the first POST")?
            .context("first POST")?;
        assert_eq!(
            body.pointer("/response_format/type")
                .and_then(Value::as_str),
            Some("json_schema")
        );
        let removal = timeout(Duration::from_secs(3), state.ai_dispatch.stop(owner))
            .await
            .context("cancelling provider dispatch")?;
        let held = store::lock().await;
        store::delete(&state.db, owner).await?;
        drop(held);
        drop(removal);
        // A rejection arriving after DELETE cannot start the looser-mode POST.
        release.notify_one();
        assert_eq!(
            timeout(Duration::from_secs(3), task)
                .await
                .context("provider operation stopped")??
                .err()
                .context("cancelled operation")?
                .kind,
            super::ErrorKind::Input
        );
        assert!(
            answer(&state, &conn).await.is_err(),
            "stale snapshot after removal"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        server.abort();
        std::fs::remove_dir_all(dir)?;
    }
    Ok(())
}

#[tokio::test]
async fn removal_before_dispatch_rejects_a_queued_stale_connection() -> Result<()> {
    for owner in [Owner::Server, Owner::User(1)] {
        // No listener: any attempted provider call would fail as a network
        // error rather than the expected missing-connection error.
        let (_scratch, state, conn, dir) = setup(owner, "http://127.0.0.1:1").await?;
        let removal = state.ai_dispatch.stop(owner).await;
        let task = tokio::spawn({
            let state = Arc::clone(&state);
            async move { answer(&state, &conn).await }
        });
        let held = store::lock().await;
        store::delete(&state.db, owner).await?;
        drop(held);
        drop(removal);
        let error = timeout(Duration::from_secs(3), task)
            .await??
            .err()
            .context("deleted connection")?;
        assert_eq!(error.kind, super::ErrorKind::NotConfigured);
        std::fs::remove_dir_all(dir)?;
    }
    Ok(())
}
