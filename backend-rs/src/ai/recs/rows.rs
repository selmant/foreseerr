//! Saved AI sliders retain their request and the owner's initial completed run.

use serde_json::{json, Value};

use super::{store, Request};
use crate::ai::AiError;
use crate::db::Db;

/// The Discover slider type for AI recommendations.
pub const SLIDER_TYPE: i64 = 1027;

/// The request a slider repeats, and optional picks chosen when it was saved.
#[derive(Debug, Clone, Default)]
pub struct Config {
    /// The full request, without personal history or credentials.
    pub request: Request,
    /// The initial run. Looked up with the current user's id before reuse.
    pub initial_run: Option<i64>,
    /// When the owner saved those picks, starting their initial cache period.
    pub saved_at: Option<String>,
}

impl Config {
    /// Read either a legacy plain prompt or the structured saved request.
    ///
    /// # Errors
    ///
    /// Fails if the saved request is malformed.
    pub fn parse(data: &str) -> Result<Self, AiError> {
        let value = serde_json::from_str::<Value>(data).ok();
        if let Some(value) = value.filter(|v| v.get("version").and_then(Value::as_u64) == Some(1)) {
            let body = value
                .get("request")
                .and_then(Value::as_object)
                .ok_or_else(|| AiError::input("This AI slider has an invalid request."))?;
            return Ok(Self {
                request: Request::parse(body)?,
                initial_run: value
                    .get("initialRunId")
                    .and_then(Value::as_i64)
                    .filter(|id| *id > 0),
                saved_at: value
                    .get("savedAt")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            });
        }
        Ok(Self {
            request: Request::parse(&serde_json::Map::from_iter([(
                String::from("prompt"),
                Value::from(data),
            )]))?,
            ..Self::default()
        })
    }
}

/// Save an existing completed run as slider configuration, without creating a run.
///
/// # Errors
///
/// Rejects another person's run, unfinished runs and malformed requests.
pub async fn from_run(db: &Db, user_id: i64, run_id: i64) -> Result<String, AiError> {
    let run = store::run(db, user_id, run_id)
        .await
        .map_err(|e| AiError::internal(format!("{e:#}")))?
        .filter(|r| r.stage == "done" && r.result.is_some())
        .ok_or_else(|| AiError::input("Choose one of your completed recommendation runs."))?;
    let body = run
        .request
        .as_object()
        .ok_or_else(|| AiError::input("This run has an invalid request."))?;
    let request = Request::parse(body)?;
    Ok(json!({
        "version": 1,
        "request": request.to_json(None),
        "initialRunId": run.id,
        "savedAt": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
    })
    .to_string())
}

/// Whether this run used exactly the same request, ignoring display-only seed titles.
#[must_use]
pub fn matches_request(run: &store::Run, request: &Request) -> bool {
    run.request
        .as_object()
        .and_then(|body| Request::parse(body).ok())
        .is_some_and(|r| r.cache_key() == request.cache_key())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Bind, Db};
    use crate::dbtx::scratch;

    async fn users(db: &Db) -> anyhow::Result<()> {
        db.execute(r#"INSERT INTO "user" ("id", "email", "permissions", "userType", "avatar") VALUES (1, 'owner@example.test', 2, 1, ''), (2, 'other@example.test', 0, 1, '')"#, &[]).await?;
        Ok(())
    }

    #[tokio::test]
    async fn saving_reuses_a_completed_run_without_creating_or_sharing_work() -> anyhow::Result<()>
    {
        let scratch = scratch::sqlite("ai-slider-save").await?;
        let db = &scratch.db;
        users(db).await?;
        let request = Request {
            prompt: String::from("Based on my taste"),
            seed: Some(("tv", 123)),
            only: Some("tv"),
            anime: true,
            refinements: vec![String::from("Twistier mysteries")],
            ..Request::default()
        };
        let id = store::create_run(
            db,
            1,
            &request.to_json(Some("Seed title")),
            "server",
            Some("test-model"),
        )
        .await?;
        assert!(
            from_run(db, 1, id).await.is_err(),
            "unfinished runs cannot seed sliders"
        );
        store::finish(db, id, &json!({"picks": []})).await?;
        let saved = Config::parse(
            &from_run(db, 1, id)
                .await
                .map_err(|e| anyhow::anyhow!("{e}"))?,
        )
        .map_err(|e| anyhow::anyhow!("{e}"))?;
        assert_eq!(saved.initial_run, Some(id), "reuse the original run id");
        assert_eq!(
            saved.request.cache_key(),
            request.cache_key(),
            "retain all constraints"
        );
        assert!(saved.saved_at.is_some(), "cache starts when saving");
        assert!(
            from_run(db, 2, id).await.is_err(),
            "other users cannot save or reuse this run"
        );
        assert!(
            store::run(db, 2, id).await?.is_none(),
            "owner-scoped initial lookup"
        );
        assert_eq!(
            store::server_runs_since(db, 1, "2000").await?,
            1,
            "saving costs no extra run"
        );
        Ok(())
    }

    #[tokio::test]
    async fn row_lookup_matches_full_constraints_before_any_scan_limit() -> anyhow::Result<()> {
        let scratch = scratch::sqlite("ai-slider-matching").await?;
        let db = &scratch.db;
        users(db).await?;
        let request = Request {
            prompt: String::from("Mysteries"),
            only: Some("tv"),
            row: true,
            ..Request::default()
        };
        let wanted = store::create_run(db, 1, &request.to_json(None), "own", None).await?;
        let mut other = request.clone();
        other.anime = true;
        for _ in 0..105 {
            store::create_run(db, 1, &other.to_json(None), "own", None).await?;
        }
        store::create_run(db, 2, &request.to_json(None), "own", None).await?;
        let found = store::row_runs(db, 1, &request.cache_key()).await?;
        assert_eq!(found.iter().map(|r| r.id).collect::<Vec<_>>(), [wanted]);
        assert_ne!(
            request.cache_key(),
            other.cache_key(),
            "anime affects identity"
        );
        other = request.clone();
        other.refinements.push(String::from("Slower"));
        assert_ne!(
            request.cache_key(),
            other.cache_key(),
            "refinements affect identity"
        );
        // Legacy rows (before rowKey) remain reusable.
        db.execute(
            r#"UPDATE "ai_run" SET "request" = ?1 WHERE "id" = ?2"#,
            &[
                Bind::Text(String::from(
                    r#"{"prompt":"Mysteries","only":"tv","row":true}"#,
                )),
                Bind::Int(wanted),
            ],
        )
        .await?;
        let legacy = store::row_runs(db, 1, &request.cache_key()).await?;
        assert!(legacy.first().is_some_and(|r| matches_request(r, &request)));
        Ok(())
    }

    #[test]
    fn accepts_legacy_and_empty_prompts() -> anyhow::Result<()> {
        for prompt in ["", "Cozy mysteries"] {
            let config = Config::parse(prompt).map_err(|e| anyhow::anyhow!("{e}"))?;
            assert_eq!(config.request.prompt, prompt);
            assert!(config.initial_run.is_none());
        }
        Ok(())
    }
}
