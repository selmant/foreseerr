//! The `ai_run`, `ai_feedback` and `ai_taste` tables.
//!
//! - A **run** is one recommendation request: its parameters, its stage while
//!   it works, and its picks when done. Runs on the server connection count
//!   toward the daily limit.
//! - **Feedback** is one verdict per user and title (`like`, `dislike`,
//!   `seen`, `not_interested`); the latest wins.
//! - The **taste card** is a short text the model keeps about what a user
//!   likes, rebuilt from new feedback and readable and editable by them.

use anyhow::Result;
use serde_json::{Map, Value};

use super::{retrieve::Key, Request};
use crate::db::{Bind, Db};
use crate::dbtx::Exec;
use crate::jobs::syncutil::Tx;
use std::collections::HashSet;

/// A run's stage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    /// Planning the search.
    Planning,
    /// Looking up candidates.
    Searching,
    /// Ranking them.
    Ranking,
    /// Finished with picks.
    Done,
    /// Finished with an error.
    Failed,
}

impl Stage {
    /// The stored and API name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Planning => "planning",
            Self::Searching => "searching",
            Self::Ranking => "ranking",
            Self::Done => "done",
            Self::Failed => "failed",
        }
    }
}

/// What started a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Origin {
    /// The person asked on the AI Picks page.
    #[default]
    Manual,
    /// A Discover row, refreshed when they viewed it.
    Row,
    /// A Discover row, refreshed ahead of time by the nightly job.
    Scheduled,
    /// Their weekly picks, made by the nightly job.
    Weekly,
}

impl Origin {
    /// The stored and API name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Row => "row",
            Self::Scheduled => "scheduled",
            Self::Weekly => "weekly",
        }
    }

    /// Started by Foreseerr rather than by the person (not counted toward
    /// their daily limit).
    #[must_use]
    pub const fn is_automatic(self) -> bool {
        matches!(self, Self::Scheduled | Self::Weekly)
    }
}

/// How one run may be reserved.
#[derive(Debug, Clone, Copy)]
pub struct Reserve<'a> {
    /// `own` or `server`.
    pub source: &'a str,
    /// The model it uses.
    pub model: Option<&'a str>,
    /// The person's daily limit (None: unlimited).
    pub daily_limit: Option<u32>,
    /// The server connection's monthly token budget (None: unlimited).
    pub monthly_tokens: Option<i64>,
    /// What started it.
    pub origin: Origin,
    /// A Discover row's picks are reused for this long (minutes).
    pub fresh_minutes: i64,
}

/// One run as stored.
#[derive(Debug, Clone)]
pub struct Run {
    /// Row id.
    pub id: i64,
    /// Its stage name.
    pub stage: String,
    /// The request parameters (JSON).
    pub request: Value,
    /// The result (JSON), when done.
    pub result: Option<Value>,
    /// The error, when failed.
    pub error: Option<Value>,
    /// `own` or `server`.
    pub source: String,
    /// The model used.
    pub model: Option<String>,
    /// When it started (ISO).
    pub created_at: String,
    /// What started it (`manual`, `row`, `scheduled`, `weekly`).
    pub origin: String,
    /// Prompt tokens the provider reported.
    pub input_tokens: i64,
    /// Answer tokens the provider reported.
    pub output_tokens: i64,
}

fn text(row: &Map<String, Value>, key: &str) -> Option<String> {
    row.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn parsed(row: &Map<String, Value>, key: &str) -> Option<Value> {
    row.get(key)
        .and_then(Value::as_str)
        .and_then(|s| serde_json::from_str(s).ok())
}

fn run_of(row: &Map<String, Value>) -> Option<Run> {
    Some(Run {
        id: row.get("id").and_then(Value::as_i64)?,
        stage: text(row, "stage")?,
        request: parsed(row, "request").unwrap_or(Value::Null),
        result: parsed(row, "result"),
        error: parsed(row, "error"),
        source: text(row, "source").unwrap_or_default(),
        model: text(row, "model"),
        created_at: text(row, "createdAt").unwrap_or_default(),
        origin: text(row, "origin").unwrap_or_else(|| String::from("manual")),
        input_tokens: row.get("inputTokens").and_then(Value::as_i64).unwrap_or(0),
        output_tokens: row.get("outputTokens").and_then(Value::as_i64).unwrap_or(0),
    })
}

/// Start a run.
///
/// # Errors
///
/// Fails on database errors.
pub async fn create_run(
    db: &Db,
    user_id: i64,
    request: &Value,
    source: &str,
    model: Option<&str>,
) -> Result<i64> {
    let rows = db
        .rows(
            r#"INSERT INTO "ai_run" ("userId", "stage", "request", "source", "model", "origin") VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING CAST("id" AS BIGINT) AS "id""#,
            &[
                Bind::Int(user_id),
                Bind::Text(Stage::Planning.as_str().to_owned()),
                Bind::Text(request.to_string()),
                Bind::Text(source.to_owned()),
                Bind::OptText(model.map(str::to_owned)),
                Bind::Text(
                    if request.get("row").and_then(Value::as_bool) == Some(true) {
                        Origin::Row
                    } else {
                        Origin::Manual
                    }
                    .as_str()
                    .to_owned(),
                ),
            ],
        )
        .await?;
    rows.first()
        .and_then(|r| r.get("id"))
        .and_then(Value::as_i64)
        .ok_or_else(|| anyhow::anyhow!("insert into ai_run returned no id"))
}

/// Move a run to another stage.
///
/// # Errors
///
/// Fails on database errors.
pub async fn set_stage(db: &Db, run_id: i64, stage: Stage) -> Result<()> {
    let changed = db.execute(
        r#"UPDATE "ai_run" SET "stage" = ?1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?2 AND "stage" IN ('planning', 'searching', 'ranking')"#,
        &[Bind::Text(stage.as_str().to_owned()), Bind::Int(run_id)],
    )
    .await?;
    anyhow::ensure!(changed > 0, "This recommendation run has stopped.");
    Ok(())
}

/// Finish a run with its result.
///
/// # Errors
///
/// Fails on database errors.
pub async fn finish(db: &Db, run_id: i64, result: &Value) -> Result<()> {
    let mut tx = Tx::begin(db).await?;
    let changed = tx.execute(
        r#"UPDATE "ai_run" SET "stage" = 'done', "result" = ?1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?2 AND "stage" IN ('planning', 'searching', 'ranking')"#,
        &[Bind::Text(result.to_string()), Bind::Int(run_id)],
    )
    .await?;
    if changed > 0 {
        // One row per pick, so "requested after it was suggested" and hit
        // rates are plain joins instead of re-reading result blobs.
        for pick in result
            .get("picks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let (Some(kind), Some(id)) = (
                pick.get("mediaType").and_then(Value::as_str),
                pick.get("tmdbId").and_then(Value::as_i64),
            ) else {
                continue;
            };
            let title = pick
                .pointer("/tmdb/title")
                .or_else(|| pick.pointer("/tmdb/name"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            tx.execute(
                r#"INSERT INTO "ai_pick" ("runId", "userId", "mediaType", "tmdbId", "title") SELECT "id", "userId", ?2, ?3, ?4 FROM "ai_run" WHERE "id" = ?1"#,
                &[
                    Bind::Int(run_id),
                    Bind::Text(kind.to_owned()),
                    Bind::Int(id),
                    Bind::Text(super::super::clip(title, 200)),
                ],
            )
            .await?;
        }
    }
    tx.commit().await
}

/// Add the tokens a prompt used to a run.
///
/// # Errors
///
/// Fails on database errors.
pub async fn add_tokens(db: &Db, run_id: i64, tokens: crate::ai::Tokens) -> Result<()> {
    if tokens == crate::ai::Tokens::default() {
        return Ok(());
    }
    db.execute(
        r#"UPDATE "ai_run" SET "inputTokens" = "inputTokens" + ?1, "outputTokens" = "outputTokens" + ?2 WHERE "id" = ?3"#,
        &[Bind::Int(tokens.input), Bind::Int(tokens.output), Bind::Int(run_id)],
    )
    .await?;
    Ok(())
}

/// Delete one of a user's runs (and its picks). Returns whether it existed.
///
/// # Errors
///
/// Fails on database errors.
pub async fn delete_run(db: &Db, user_id: i64, run_id: i64) -> Result<bool> {
    let mut tx = Tx::begin(db).await?;
    tx.execute(
        r#"DELETE FROM "ai_pick" WHERE "runId" = ?1 AND "userId" = ?2"#,
        &[Bind::Int(run_id), Bind::Int(user_id)],
    )
    .await?;
    let n = tx
        .execute(
            r#"DELETE FROM "ai_run" WHERE "id" = ?1 AND "userId" = ?2"#,
            &[Bind::Int(run_id), Bind::Int(user_id)],
        )
        .await?;
    tx.commit().await?;
    Ok(n > 0)
}

/// Delete all of a user's runs, Discover rows and weekly picks included.
/// Returns how many.
///
/// # Errors
///
/// Fails on database errors.
pub async fn delete_runs(db: &Db, user_id: i64) -> Result<u64> {
    let mut tx = Tx::begin(db).await?;
    tx.execute(
        r#"DELETE FROM "ai_pick" WHERE "userId" = ?1"#,
        &[Bind::Int(user_id)],
    )
    .await?;
    let n = tx
        .execute(
            r#"DELETE FROM "ai_run" WHERE "userId" = ?1 AND "stage" NOT IN ('planning', 'searching', 'ranking')"#,
            &[Bind::Int(user_id)],
        )
        .await?;
    tx.commit().await?;
    Ok(n)
}

/// Delete everyone's finished runs older than `before_iso`. Returns how many.
///
/// # Errors
///
/// Fails on database errors.
pub async fn prune_runs(db: &Db, before_iso: &str) -> Result<u64> {
    let created = db.iso_sql(r#""createdAt""#);
    let mut tx = Tx::begin(db).await?;
    tx.execute(
        &format!(
            r#"DELETE FROM "ai_pick" WHERE "runId" IN (SELECT "id" FROM "ai_run" WHERE "stage" NOT IN ('planning', 'searching', 'ranking') AND {created} < ?1)"#
        ),
        &[Bind::Text(before_iso.to_owned())],
    )
    .await?;
    let n = tx
        .execute(
            &format!(
                r#"DELETE FROM "ai_run" WHERE "stage" NOT IN ('planning', 'searching', 'ranking') AND {created} < ?1"#
            ),
            &[Bind::Text(before_iso.to_owned())],
        )
        .await?;
    tx.commit().await?;
    Ok(n)
}

/// A user's latest finished weekly picks.
///
/// # Errors
///
/// Fails on database errors.
pub async fn latest_weekly(db: &Db, user_id: i64) -> Result<Option<Run>> {
    Ok(db
        .rows(
            &format!(
                r#"SELECT {} FROM "ai_run" WHERE "userId" = ?1 AND "origin" = 'weekly' AND "stage" = 'done' ORDER BY "id" DESC LIMIT 1"#,
                run_columns(db)
            ),
            &[Bind::Int(user_id)],
        )
        .await?
        .first()
        .and_then(run_of))
}

/// When this user's last weekly picks started (ISO), finished or not.
///
/// # Errors
///
/// Fails on database errors.
pub async fn last_weekly_at(db: &Db, user_id: i64) -> Result<Option<String>> {
    let created = db.iso_sql(r#""createdAt""#);
    Ok(db
        .rows(
            &format!(
                r#"SELECT {created} AS "at" FROM "ai_run" WHERE "userId" = ?1 AND "origin" = 'weekly' ORDER BY "id" DESC LIMIT 1"#
            ),
            &[Bind::Int(user_id)],
        )
        .await?
        .first()
        .and_then(|r| text(r, "at")))
}

/// Note that the user looked at AI picks (the nightly job only prepares
/// picks for people who do).
///
/// # Errors
///
/// Fails on database errors.
pub async fn touch_active(db: &Db, user_id: i64) -> Result<()> {
    db.execute(
        r#"INSERT INTO "ai_user_settings" ("useOwnConnection", "model", "useHistory", "historyConsentAt", "userId") VALUES (?1, NULL, ?1, NULL, ?2) ON CONFLICT ("userId") DO NOTHING"#,
        &[Bind::Bool(false), Bind::Int(user_id)],
    )
    .await?;
    db.execute(
        r#"UPDATE "ai_user_settings" SET "lastActiveAt" = CURRENT_TIMESTAMP WHERE "userId" = ?1"#,
        &[Bind::Int(user_id)],
    )
    .await?;
    Ok(())
}

/// Tokens used on the server connection since `since_iso`.
///
/// # Errors
///
/// Fails on database errors.
pub async fn server_tokens_since(db: &Db, since_iso: &str) -> Result<i64> {
    let created = db.iso_sql(r#""createdAt""#);
    let rows = db
        .rows(
            &format!(
                r#"SELECT CAST(COALESCE(SUM("inputTokens" + "outputTokens"), 0) AS BIGINT) AS "n" FROM "ai_run" WHERE "source" = 'server' AND {created} >= ?1"#
            ),
            &[Bind::Text(since_iso.to_owned())],
        )
        .await?;
    Ok(rows
        .first()
        .and_then(|r| r.get("n"))
        .and_then(Value::as_i64)
        .unwrap_or(0))
}

/// Finish a run with an error (the AI error's JSON).
///
/// # Errors
///
/// Fails on database errors.
pub async fn fail(db: &Db, run_id: i64, error: &Value) -> Result<()> {
    db.execute(
        r#"UPDATE "ai_run" SET "stage" = 'failed', "error" = ?1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?2 AND "stage" IN ('planning', 'searching', 'ranking')"#,
        &[Bind::Text(error.to_string()), Bind::Int(run_id)],
    )
    .await?;
    Ok(())
}

fn run_columns(db: &Db) -> String {
    let created = db.iso_sql(r#""createdAt""#);
    format!(
        r#"CAST("id" AS BIGINT) AS "id", "stage", "request", "result", "error", "source", "model", {created} AS "createdAt", "origin", CAST("inputTokens" AS BIGINT) AS "inputTokens", CAST("outputTokens" AS BIGINT) AS "outputTokens""#
    )
}

/// One of a user's runs.
///
/// # Errors
///
/// Fails on database errors.
pub async fn run(db: &Db, user_id: i64, run_id: i64) -> Result<Option<Run>> {
    let rows = db
        .rows(
            &format!(
                r#"SELECT {} FROM "ai_run" WHERE "id" = ?1 AND "userId" = ?2"#,
                run_columns(db)
            ),
            &[Bind::Int(run_id), Bind::Int(user_id)],
        )
        .await?;
    Ok(rows.first().and_then(run_of))
}

/// A user's most recent runs, newest first.
///
/// # Errors
///
/// Fails on database errors.
pub async fn recent_runs(db: &Db, user_id: i64, limit: i64) -> Result<Vec<Run>> {
    let rows = db
        .rows(
            &format!(
                r#"SELECT {} FROM "ai_run" WHERE "userId" = ?1 ORDER BY "id" DESC LIMIT ?2"#,
                run_columns(db)
            ),
            &[Bind::Int(user_id), Bind::Int(limit)],
        )
        .await?;
    Ok(rows.iter().filter_map(run_of).collect())
}

/// Matching row runs, without allowing unrelated runs to exhaust a scan limit.
///
/// # Errors
///
/// Fails on database errors.
pub async fn row_runs(db: &Db, user_id: i64, request: &Request) -> Result<Vec<Run>> {
    row_runs_in(db, &mut Exec::Db(db), user_id, request).await
}

async fn row_runs_in(
    db: &Db,
    exec: &mut Exec<'_>,
    user_id: i64,
    request: &Request,
) -> Result<Vec<Run>> {
    let key_sql = if db.is_postgres() {
        r#"CAST("request" AS JSONB)->>'rowKey'"#
    } else {
        r#"json_extract("request", '$.rowKey')"#
    };
    let created = db.iso_sql(r#""createdAt""#);
    let mut before = i64::MAX;
    let mut selected = Vec::new();
    let mut done = false;
    let mut active = false;
    let working_since = super::iso_since(Some(10));
    loop {
        // Page only request metadata, never every historical result blob.
        let active_filter =
            format!(r#""stage" IN ('planning', 'searching', 'ranking') AND {created} >= ?4"#);
        let stages = if done {
            active_filter
        } else if active {
            String::from(r#""stage" = 'done'"#)
        } else {
            format!(r#"("stage" = 'done' OR ({active_filter}))"#)
        };
        let mut binds = vec![
            Bind::Int(user_id),
            Bind::Text(request.cache_key()),
            Bind::Int(before),
        ];
        if done || !active {
            binds.push(Bind::Text(working_since.clone()));
        }
        let rows = exec.rows(&format!(r#"SELECT CAST("id" AS BIGINT) AS "id", "stage", "request", {created} AS "createdAt" FROM "ai_run" WHERE "userId" = ?1 AND "id" < ?3 AND ({stages}) AND ({key_sql} = ?2 OR ({key_sql} IS NULL AND "request" LIKE '%"row":true%')) ORDER BY "id" DESC LIMIT 64"#), &binds).await?;
        if rows.is_empty() {
            break;
        }
        for row in &rows {
            let Some(run) = run_of(row) else { continue };
            before = run.id;
            if super::rows::matches_request(&run, request) {
                if run.stage == "done" && !done {
                    selected.push(run.id);
                    done = true;
                } else if run.stage != "done" && run.created_at >= working_since && !active {
                    selected.push(run.id);
                    active = true;
                }
            }
            if done && (active || run.created_at < working_since) {
                break;
            }
        }
        if rows.len() < 64
            || done
                && (active
                    || rows
                        .last()
                        .and_then(|r| text(r, "createdAt"))
                        .is_some_and(|at| at < working_since))
        {
            break;
        }
    }
    let mut runs = Vec::new();
    for id in selected {
        let rows = exec
            .rows(
                &format!(
                    r#"SELECT {} FROM "ai_run" WHERE "id" = ?1 AND "userId" = ?2"#,
                    run_columns(db)
                ),
                &[Bind::Int(id), Bind::Int(user_id)],
            )
            .await?;
        if let Some(run) = rows.first().and_then(run_of) {
            runs.push(run);
        }
    }
    Ok(runs)
}

/// Atomically reuse a row or reserve one run against the user's allowance.
/// Returns the id and whether this caller owns the new worker.
///
/// # Errors
/// Fails on exhausted allowance, overlapping personal work or database errors.
pub async fn reserve_run(
    db: &Db,
    user_id: i64,
    request: &Request,
    seed_title: Option<&str>,
    how: Reserve<'_>,
) -> Result<(i64, bool), crate::ai::AiError> {
    let Reserve {
        source,
        model,
        daily_limit: limit,
        monthly_tokens,
        origin,
        fresh_minutes,
    } = how;
    let err = |e: anyhow::Error| crate::ai::AiError::internal(format!("{e:#}"));
    let mut tx = Tx::begin(db).await.map_err(err)?;
    // SQLite begins IMMEDIATE; on PostgreSQL this locks the user across processes.
    let locked = tx
        .execute(
            r#"UPDATE "user" SET "id" = "id" WHERE "id" = ?1"#,
            &[Bind::Int(user_id)],
        )
        .await
        .map_err(err)?;
    if locked == 0 {
        return Err(crate::ai::AiError::not_configured());
    }
    let created = db.iso_sql(r#""createdAt""#);
    let mut exec = Exec::Tx(&mut tx);
    if request.row {
        let fresh = super::iso_since(Some(fresh_minutes));
        if let Some(run) = row_runs_in(db, &mut exec, user_id, request)
            .await
            .map_err(err)?
            .into_iter()
            .find(|r| r.stage != "done" || r.created_at >= fresh)
        {
            tx.commit().await.map_err(err)?;
            return Ok((run.id, false));
        }
    } else {
        let n = exec.scalar(&format!(r#"SELECT CAST(COUNT(*) AS BIGINT) FROM "ai_run" WHERE "userId" = ?1 AND "stage" IN ('planning', 'searching', 'ranking') AND "origin" = ?3 AND {created} >= ?2"#), &[Bind::Int(user_id), Bind::Text(super::iso_since(Some(10))), Bind::Text(origin.as_str().to_owned())]).await.map_err(err)?;
        if n > 0 {
            return Err(crate::ai::AiError::input(
                "Your last request is still working. Wait for it to finish.",
            ));
        }
    }
    if let Some(limit) = limit.filter(|_| !origin.is_automatic()) {
        let n = exec.scalar(&format!(r#"SELECT CAST(COUNT(*) AS BIGINT) FROM "ai_run" WHERE "userId" = ?1 AND "source" = 'server' AND "origin" NOT IN ('scheduled', 'weekly') AND {created} >= ?2"#), &[Bind::Int(user_id), Bind::Text(super::iso_since(None))]).await.map_err(err)?;
        if n >= i64::from(limit) {
            return Err(crate::ai::AiError::daily_limit(limit));
        }
    }
    if let Some(budget) = monthly_tokens.filter(|_| source == "server") {
        let used = exec.scalar(&format!(r#"SELECT CAST(COALESCE(SUM("inputTokens" + "outputTokens"), 0) AS BIGINT) FROM "ai_run" WHERE "source" = 'server' AND {created} >= ?1"#), &[Bind::Text(super::month_start())]).await.map_err(err)?;
        if used >= budget {
            return Err(crate::ai::AiError::monthly_budget());
        }
    }
    let id = exec.scalar(r#"INSERT INTO "ai_run" ("userId", "stage", "request", "source", "model", "origin") VALUES (?1, 'planning', ?2, ?3, ?4, ?5) RETURNING CAST("id" AS BIGINT)"#, &[Bind::Int(user_id), Bind::Text(request.to_json(seed_title).to_string()), Bind::Text(source.to_owned()), Bind::OptText(model.map(str::to_owned)), Bind::Text(origin.as_str().to_owned())]).await.map_err(err)?;
    tx.commit().await.map_err(err)?;
    Ok((id, true))
}

/// Personal history, excluding automatic rows before the limit.
/// # Errors
/// Fails on database errors.
pub async fn personal_runs(db: &Db, user_id: i64, limit: i64) -> Result<Vec<Run>> {
    Ok(db.rows(&format!(r#"SELECT {} FROM "ai_run" WHERE "userId" = ?1 AND "origin" = 'manual' ORDER BY "id" DESC LIMIT ?2"#, run_columns(db)), &[Bind::Int(user_id), Bind::Int(limit)]).await?.iter().filter_map(run_of).collect())
}

/// A request of this user's own (not a Discover row's) that's still
/// working and started in the last few minutes, if any.
///
/// # Errors
///
/// Fails on database errors.
pub async fn active_run(db: &Db, user_id: i64, since_iso: &str) -> Result<Option<i64>> {
    let created = db.iso_sql(r#""createdAt""#);
    let rows = db
        .rows(
            &format!(
                r#"SELECT CAST("id" AS BIGINT) AS "id" FROM "ai_run" WHERE "userId" = ?1 AND "stage" IN ('planning', 'searching', 'ranking') AND "request" NOT LIKE '%"row":true%' AND {created} >= ?2 ORDER BY "id" DESC LIMIT 1"#
            ),
            &[Bind::Int(user_id), Bind::Text(since_iso.to_owned())],
        )
        .await?;
    Ok(rows
        .first()
        .and_then(|r| r.get("id"))
        .and_then(Value::as_i64))
}

/// Runs this user started on the server connection since `since_iso`.
///
/// # Errors
///
/// Fails on database errors.
pub async fn server_runs_since(db: &Db, user_id: i64, since_iso: &str) -> Result<i64> {
    let created = db.iso_sql(r#""createdAt""#);
    let rows = db
        .rows(
            &format!(
                r#"SELECT CAST(COUNT(*) AS BIGINT) AS "n" FROM "ai_run" WHERE "userId" = ?1 AND "source" = 'server' AND "origin" NOT IN ('scheduled', 'weekly') AND {created} >= ?2"#
            ),
            &[Bind::Int(user_id), Bind::Text(since_iso.to_owned())],
        )
        .await?;
    Ok(rows
        .first()
        .and_then(|r| r.get("n"))
        .and_then(Value::as_i64)
        .unwrap_or(0))
}

/// Mark runs left working by a restart as failed.
///
/// # Errors
///
/// Fails on database errors.
pub async fn fail_stale_runs(db: &Db, before_iso: &str) -> Result<u64> {
    let created = db.iso_sql(r#""createdAt""#);
    db.execute(
        &format!(
            r#"UPDATE "ai_run" SET "stage" = 'failed', "error" = ?1, "updatedAt" = CURRENT_TIMESTAMP WHERE "stage" IN ('planning', 'searching', 'ranking') AND {created} < ?2"#
        ),
        &[
            Bind::Text(String::from(
                r#"{"message":"This request stopped before it finished. Try again.","code":"unavailable"}"#,
            )),
            Bind::Text(before_iso.to_owned()),
        ],
    )
    .await
}

/// A verdict on a title.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// More like this.
    Like,
    /// Not for me.
    Dislike,
    /// Already watched it.
    Seen,
    /// Don't suggest it.
    NotInterested,
}

impl Verdict {
    /// The stored and API name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Like => "like",
            Self::Dislike => "dislike",
            Self::Seen => "seen",
            Self::NotInterested => "not_interested",
        }
    }

    /// From the API name.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        [Self::Like, Self::Dislike, Self::Seen, Self::NotInterested]
            .into_iter()
            .find(|v| v.as_str() == text)
    }
}

/// One feedback row.
#[derive(Debug, Clone)]
pub struct Feedback {
    /// `movie` or `tv`.
    pub media_type: String,
    /// Revision used to acknowledge exactly the feedback read by the model.
    pub version: i64,
    /// TMDB id.
    pub tmdb_id: i64,
    /// The verdict's name.
    pub kind: String,
    /// The title when it was given.
    pub title: String,
    /// When it was given (ISO).
    pub updated_at: String,
}

/// Record (or replace) a user's verdict on a title.
///
/// # Errors
///
/// Fails on database errors.
pub async fn set_feedback(
    db: &Db,
    user_id: i64,
    media_type: &str,
    tmdb_id: i64,
    verdict: Verdict,
    title: &str,
) -> Result<()> {
    let binds = [
        Bind::Text(verdict.as_str().to_owned()),
        Bind::Text(title.to_owned()),
        Bind::Int(user_id),
        Bind::Text(media_type.to_owned()),
        Bind::Int(tmdb_id),
    ];
    db.execute(r#"INSERT INTO "ai_feedback" ("kind", "title", "userId", "mediaType", "tmdbId") VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT ("userId", "mediaType", "tmdbId") DO UPDATE SET "kind" = excluded."kind", "title" = excluded."title", "version" = "ai_feedback"."version" + 1, "updatedAt" = CURRENT_TIMESTAMP"#, &binds).await?;
    Ok(())
}

/// Remove a user's verdict on a title.
///
/// # Errors
///
/// Fails on database errors.
pub async fn clear_feedback(db: &Db, user_id: i64, media_type: &str, tmdb_id: i64) -> Result<()> {
    let mut tx = Tx::begin(db).await?;
    // A removed/recreated rating must not reuse a revision an in-flight model read.
    tx.execute(
        r#"UPDATE "ai_taste" SET "version" = "version" + 1 WHERE "userId" = ?1"#,
        &[Bind::Int(user_id)],
    )
    .await?;
    tx.execute(
        r#"DELETE FROM "ai_feedback" WHERE "userId" = ?1 AND "mediaType" = ?2 AND "tmdbId" = ?3"#,
        &[
            Bind::Int(user_id),
            Bind::Text(media_type.to_owned()),
            Bind::Int(tmdb_id),
        ],
    )
    .await?;
    tx.commit().await
}

/// Remove all of a user's feedback.
///
/// # Errors
///
/// Fails on database errors.
pub async fn clear_all_feedback(db: &Db, user_id: i64) -> Result<()> {
    let mut tx = Tx::begin(db).await?;
    tx.execute(
        r#"UPDATE "ai_taste" SET "version" = "version" + 1 WHERE "userId" = ?1"#,
        &[Bind::Int(user_id)],
    )
    .await?;
    tx.execute(
        r#"DELETE FROM "ai_feedback" WHERE "userId" = ?1"#,
        &[Bind::Int(user_id)],
    )
    .await?;
    tx.execute(
        r#"DELETE FROM "ai_signal" WHERE "userId" = ?1"#,
        &[Bind::Int(user_id)],
    )
    .await?;
    tx.commit().await
}

/// A user's feedback, newest first.
///
/// # Errors
///
/// Fails on database errors.
pub async fn feedback(db: &Db, user_id: i64, limit: i64) -> Result<Vec<Feedback>> {
    let updated = db.iso_sql(r#""updatedAt""#);
    let rows = db
        .rows(
            &format!(
                r#"SELECT "mediaType", CAST("version" AS BIGINT) AS "version", CAST("tmdbId" AS BIGINT) AS "tmdbId", "kind", "title", {updated} AS "updatedAt" FROM "ai_feedback" WHERE "userId" = ?1 ORDER BY "updatedAt" DESC, "id" DESC LIMIT ?2"#
            ),
            &[Bind::Int(user_id), Bind::Int(limit)],
        )
        .await?;
    Ok(rows.iter().filter_map(feedback_of).collect())
}

fn feedback_of(r: &Map<String, Value>) -> Option<Feedback> {
    Some(Feedback {
        version: r.get("version").and_then(Value::as_i64).unwrap_or(1),
        media_type: text(r, "mediaType")?,
        tmdb_id: r.get("tmdbId").and_then(Value::as_i64)?,
        kind: text(r, "kind")?,
        title: text(r, "title").unwrap_or_default(),
        updated_at: text(r, "updatedAt").unwrap_or_default(),
    })
}

/// A user's taste card and when it was last rebuilt (ISO).
///
/// # Errors
///
/// Fails on database errors.
pub async fn taste(db: &Db, user_id: i64) -> Result<Option<(String, String)>> {
    let updated = db.iso_sql(r#""updatedAt""#);
    let rows = db
        .rows(
            &format!(
                r#"SELECT "card", {updated} AS "updatedAt" FROM "ai_taste" WHERE "userId" = ?1"#
            ),
            &[Bind::Int(user_id)],
        )
        .await?;
    Ok(rows
        .first()
        .and_then(|r| Some((text(r, "card")?, text(r, "updatedAt").unwrap_or_default()))))
}

/// Save a user's taste card (empty clears it).
///
/// # Errors
///
/// Fails on database errors.
pub async fn save_taste(db: &Db, user_id: i64, card: &str) -> Result<()> {
    let mut tx = Tx::begin(db).await?;
    tx.execute(r#"INSERT INTO "ai_taste" ("card", "userId") VALUES (?1, ?2) ON CONFLICT ("userId") DO UPDATE SET "card" = excluded."card", "version" = "ai_taste"."version" + 1, "updatedAt" = CURRENT_TIMESTAMP"#, &[Bind::Text(card.trim().to_owned()), Bind::Int(user_id)]).await?;
    tx.execute(
        r#"UPDATE "ai_feedback" SET "learnedVersion" = "version" WHERE "userId" = ?1"#,
        &[Bind::Int(user_id)],
    )
    .await?;
    tx.commit().await
}

/// A stable snapshot of the taste card, including clears.
/// # Errors
/// Fails on database errors.
pub async fn taste_snapshot(db: &Db, user_id: i64) -> Result<(String, i64)> {
    db.execute(r#"INSERT INTO "ai_taste" ("card", "userId") VALUES ('', ?1) ON CONFLICT ("userId") DO NOTHING"#, &[Bind::Int(user_id)]).await?;
    let rows = db.rows(r#"SELECT "card", CAST("version" AS BIGINT) AS "version" FROM "ai_taste" WHERE "userId" = ?1"#, &[Bind::Int(user_id)]).await?;
    let row = rows
        .first()
        .ok_or_else(|| anyhow::anyhow!("taste snapshot missing"))?;
    Ok((
        text(row, "card").unwrap_or_default(),
        row.get("version").and_then(Value::as_i64).unwrap_or(1),
    ))
}

/// Oldest unprocessed ratings, so a backlog never silently loses older entries.
/// # Errors
/// Fails on database errors.
pub async fn pending_batch(db: &Db, user_id: i64) -> Result<Vec<Feedback>> {
    let updated = db.iso_sql(r#""updatedAt""#);
    let rows = db.rows(&format!(r#"SELECT "mediaType", CAST("tmdbId" AS BIGINT) AS "tmdbId", CAST("version" AS BIGINT) AS "version", "kind", "title", {updated} AS "updatedAt" FROM "ai_feedback" WHERE "userId" = ?1 AND "learnedVersion" < "version" ORDER BY "updatedAt", "id" LIMIT 60"#), &[Bind::Int(user_id)]).await?;
    Ok(rows.iter().filter_map(feedback_of).collect())
}

/// Save derived taste only if nobody edited/cleared it, acknowledging exact revisions.
/// # Errors
/// Fails on database errors.
pub async fn apply_taste(
    db: &Db,
    user_id: i64,
    version: i64,
    card: &str,
    consumed: &[Feedback],
) -> Result<bool> {
    let mut tx = Tx::begin(db).await?;
    let changed = tx.execute(r#"UPDATE "ai_taste" SET "card" = ?1, "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP WHERE "userId" = ?2 AND "version" = ?3"#, &[Bind::Text(card.to_owned()), Bind::Int(user_id), Bind::Int(version)]).await?;
    if changed == 0 {
        return Ok(false);
    }
    for f in consumed {
        tx.execute(r#"UPDATE "ai_feedback" SET "learnedVersion" = ?1 WHERE "userId" = ?2 AND "mediaType" = ?3 AND "tmdbId" = ?4 AND "version" = ?1"#, &[Bind::Int(f.version), Bind::Int(user_id), Bind::Text(f.media_type.clone()), Bind::Int(f.tmdb_id)]).await?;
    }
    tx.commit().await?;
    Ok(true)
}

/// Exact feedback totals without a prompt/list limit.
/// # Errors
/// Fails on database errors.
pub async fn feedback_counts(db: &Db, user_id: i64) -> Result<(usize, usize)> {
    let rows = db.rows(r#"SELECT CAST(COUNT(*) AS BIGINT) AS "total", CAST(COALESCE(SUM(CASE WHEN "learnedVersion" < "version" THEN 1 ELSE 0 END), 0) AS BIGINT) AS "pending" FROM "ai_feedback" WHERE "userId" = ?1"#, &[Bind::Int(user_id)]).await?;
    let get = |key| {
        rows.first()
            .and_then(|r| r.get(key))
            .and_then(Value::as_u64)
            .and_then(|n| usize::try_from(n).ok())
            .unwrap_or(0)
    };
    Ok((get("total"), get("pending")))
}

/// Current verdicts for a result's titles, without a global feedback scan limit.
/// # Errors
/// Fails on database errors.
pub async fn feedback_for(
    db: &Db,
    user_id: i64,
    keys: &[(String, i64)],
) -> Result<std::collections::HashMap<(String, i64), String>> {
    if keys.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let mut binds = vec![Bind::Int(user_id)];
    let filters: Vec<String> = keys
        .iter()
        .map(|(kind, id)| {
            let first = binds.len() + 1;
            binds.extend([Bind::Text(kind.clone()), Bind::Int(*id)]);
            format!(r#"("mediaType" = ?{first} AND "tmdbId" = ?{})"#, first + 1)
        })
        .collect();
    let rows = db.rows(&format!(r#"SELECT "mediaType", CAST("tmdbId" AS BIGINT) AS "tmdbId", "kind" FROM "ai_feedback" WHERE "userId" = ?1 AND ({})"#, filters.join(" OR ")), &binds).await?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            Some((
                (text(r, "mediaType")?, r.get("tmdbId")?.as_i64()?),
                text(r, "kind")?,
            ))
        })
        .collect())
}

/// Every rated title, independently of prompt context limits.
/// # Errors
/// Fails on database errors.
pub async fn feedback_keys(db: &Db, user_id: i64) -> Result<HashSet<Key>> {
    Ok(db.rows(r#"SELECT "mediaType", CAST("tmdbId" AS BIGINT) AS "tmdbId" FROM "ai_feedback" WHERE "userId" = ?1"#, &[Bind::Int(user_id)]).await?.iter().filter_map(|r| Some((super::retrieve::kind_of(r.get("mediaType")?.as_str()?), r.get("tmdbId")?.as_i64()?))).collect())
}

#[cfg(test)]
mod review_tests {
    use super::*;
    use crate::dbtx::scratch;
    use anyhow::Context;
    use serde_json::json;

    const fn test_reserve() -> Reserve<'static> {
        Reserve {
            source: "server",
            model: None,
            daily_limit: Some(1),
            monthly_tokens: None,
            origin: Origin::Row,
            fresh_minutes: 24 * 60,
        }
    }

    async fn database(tag: &str) -> Result<scratch::Scratch> {
        let scratch = scratch::sqlite(tag).await?;
        scratch.db.execute(r#"INSERT INTO "user" ("id", "email", "permissions", "userType", "avatar") VALUES (1, 'ai@example.test', 0, 1, '')"#, &[]).await?;
        Ok(scratch)
    }

    #[tokio::test]
    #[ignore = "requires an empty scratch database at FORESEERR_AI_TEST_POSTGRES_URL"]
    async fn postgres_migrations_reservations_feedback_and_signout() -> Result<()> {
        use crate::ai::store as connections;
        use crate::vault::{KeySource, Vault};

        let url = std::env::var("FORESEERR_AI_TEST_POSTGRES_URL")?;
        let db = Db::Postgres(sqlx::PgPool::connect(&url).await?);
        let all = crate::dbmigrate::migrations(&db);
        let boundary = all
            .iter()
            .position(|m| m.name == "UniqueAiServerConnection1790100000000")
            .context("singleton migration")?;
        crate::dbmigrate::run(&db, all.get(..boundary).context("earlier migrations")?).await?;
        db.execute(r#"INSERT INTO "ai_connection" ("kind", "model") VALUES ('openai', 'selected'), ('openai', 'duplicate')"#, &[]).await?;
        crate::dbmigrate::run(&db, all.get(boundary..).context("remaining migrations")?).await?;
        assert_eq!(
            connections::load(&db, connections::Owner::Server)
                .await?
                .and_then(|c| c.model),
            Some(String::from("selected"))
        );
        db.execute(r#"INSERT INTO "user" ("id", "email", "permissions", "userType", "avatar") VALUES (1, 'pg@example.test', 0, 1, '')"#, &[]).await?;
        let request = Request {
            row: true,
            ..Request::default()
        };
        let (a, b) = tokio::join!(
            reserve_run(&db, 1, &request, None, test_reserve()),
            reserve_run(&db, 1, &request, None, test_reserve())
        );
        let a = a.map_err(|e| anyhow::anyhow!("{e}"))?;
        let b = b.map_err(|e| anyhow::anyhow!("{e}"))?;
        assert_eq!(a.0, b.0);
        assert_ne!(a.1, b.1);
        finish(&db, a.0, &serde_json::json!({"picks":[]})).await?;
        // Force another metadata page after finding the active run.
        let mut unrelated = request.to_json(None);
        let unrelated_body = unrelated.as_object_mut().context("legacy request object")?;
        unrelated_body.insert(String::from("prompt"), Value::from("Other legacy row"));
        unrelated_body.insert(String::from("rowKey"), Value::Null);
        for _ in 0..65 {
            create_run(&db, 1, &unrelated, "server", None).await?;
        }
        let mut legacy = request.to_json(None);
        legacy
            .as_object_mut()
            .context("legacy request object")?
            .insert(String::from("rowKey"), Value::Null);
        create_run(&db, 1, &legacy, "server", None).await?;
        assert_eq!(row_runs(&db, 1, &request).await?.len(), 2);
        assert_eq!(personal_runs(&db, 1, 20).await?.len(), 0);
        set_feedback(&db, 1, "movie", 1, Verdict::Like, "First").await?;
        let (_, version) = taste_snapshot(&db, 1).await?;
        let batch = pending_batch(&db, 1).await?;
        set_feedback(&db, 1, "movie", 1, Verdict::Dislike, "Changed").await?;
        assert!(apply_taste(&db, 1, version, "taste", &batch).await?);
        assert_eq!(feedback_counts(&db, 1).await?, (1, 1));
        clear_feedback(&db, 1, "movie", 1).await?;
        assert_eq!(feedback_counts(&db, 1).await?, (0, 0));
        let vault = Vault::from_master(&[7; 32], KeySource::Env)?;
        let held = connections::lock().await;
        connections::save(
            &db,
            &vault,
            connections::Owner::User(1),
            connections::Write {
                kind: connections::Kind::OpenAi,
                base_url: None,
                model: None,
                credentials: None,
                identity: None,
                status: connections::Status::Ok,
            },
            &held,
        )
        .await?;
        drop(held);
        let conn = connections::load(&db, connections::Owner::User(1))
            .await?
            .context("saved connection")?;
        assert!(connections::take_session_for_signout(&db, &conn)
            .await?
            .is_some());
        assert_eq!(
            connections::load(&db, conn.owner).await?.map(|c| c.status),
            Some(connections::Status::SignedOut)
        );
        Ok(())
    }

    #[tokio::test]
    async fn concurrent_rows_share_one_reservation() -> Result<()> {
        let scratch = database("row-reservation").await?;
        let request = Request {
            row: true,
            prompt: String::from("cozy"),
            ..Request::default()
        };
        let (a, b) = tokio::join!(
            reserve_run(&scratch.db, 1, &request, None, test_reserve()),
            reserve_run(&scratch.db, 1, &request, None, test_reserve())
        );
        let (a, b) = (
            a.map_err(|e| anyhow::anyhow!("{e}"))?,
            b.map_err(|e| anyhow::anyhow!("{e}"))?,
        );
        assert_eq!(a.0, b.0);
        assert_ne!(a.1, b.1);
        assert_eq!(server_runs_since(&scratch.db, 1, "2000").await?, 1);
        Ok(())
    }

    #[tokio::test]
    async fn concurrent_requests_cannot_exceed_the_daily_allowance() -> Result<()> {
        let scratch = database("quota-reservation").await?;
        let a = Request {
            row: true,
            prompt: String::from("cozy"),
            ..Request::default()
        };
        let b = Request {
            row: true,
            prompt: String::from("dark"),
            ..Request::default()
        };
        let (a, b) = tokio::join!(
            reserve_run(&scratch.db, 1, &a, None, test_reserve()),
            reserve_run(&scratch.db, 1, &b, None, test_reserve())
        );
        assert_ne!(a.is_ok(), b.is_ok());
        assert_eq!(
            a.err().or_else(|| b.err()).map(|e| e.kind),
            Some(crate::ai::ErrorKind::DailyLimit)
        );
        Ok(())
    }

    #[tokio::test]
    async fn automatic_runs_skip_the_daily_limit_and_the_budget_stops_server_runs() -> Result<()> {
        let scratch = database("ai-budget").await?;
        let db = &scratch.db;
        let weekly = Reserve {
            origin: Origin::Weekly,
            ..test_reserve()
        };
        let (id, created) = reserve_run(db, 1, &Request::default(), None, weekly)
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        assert!(created);
        finish(db, id, &json!({"picks": []})).await?;
        assert_eq!(server_runs_since(db, 1, "2000").await?, 0, "not counted");
        let manual = Reserve {
            origin: Origin::Manual,
            ..test_reserve()
        };
        let (id, _) = reserve_run(db, 1, &Request::default(), None, manual)
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        finish(db, id, &json!({"picks": []})).await?;
        add_tokens(
            db,
            id,
            crate::ai::Tokens {
                input: 900,
                output: 200,
            },
        )
        .await?;
        assert_eq!(server_tokens_since(db, "2000").await?, 1100);
        let budgeted = Reserve {
            origin: Origin::Weekly,
            monthly_tokens: Some(1000),
            ..test_reserve()
        };
        let refused = reserve_run(db, 1, &Request::default(), None, budgeted).await;
        assert_eq!(
            refused.err().map(|e| e.kind),
            Some(crate::ai::ErrorKind::DailyLimit),
            "over the monthly budget"
        );
        let own = Reserve {
            source: "own",
            ..budgeted
        };
        assert!(
            reserve_run(db, 1, &Request::default(), None, own)
                .await
                .is_ok(),
            "own connections aren't budgeted"
        );
        Ok(())
    }

    #[tokio::test]
    async fn swept_runs_stay_failed() -> Result<()> {
        let scratch = database("terminal-runs").await?;
        let id = create_run(&scratch.db, 1, &json!({}), "own", None).await?;
        fail_stale_runs(&scratch.db, "9999").await?;
        assert!(set_stage(&scratch.db, id, Stage::Ranking).await.is_err());
        finish(&scratch.db, id, &json!({"picks": []})).await?;
        assert_eq!(
            run(&scratch.db, 1, id).await?.map(|r| r.stage),
            Some(String::from("failed"))
        );
        Ok(())
    }

    #[tokio::test]
    async fn taste_acknowledges_only_consumed_feedback_revisions() -> Result<()> {
        let scratch = database("taste-feedback").await?;
        let db = &scratch.db;
        for id in 1..=61 {
            set_feedback(db, 1, "movie", id, Verdict::Like, "Title").await?;
        }
        let (_, version) = taste_snapshot(db, 1).await?;
        let batch = pending_batch(db, 1).await?;
        assert_eq!(batch.len(), 60);
        set_feedback(
            db,
            1,
            "movie",
            batch.first().context("pending feedback")?.tmdb_id,
            Verdict::Dislike,
            "Changed",
        )
        .await?;
        set_feedback(db, 1, "movie", 62, Verdict::Like, "During generation").await?;
        assert!(apply_taste(db, 1, version, "likes mysteries", &batch).await?);
        assert_eq!(feedback_counts(db, 1).await?, (62, 3));
        let (_, version) = taste_snapshot(db, 1).await?;
        let batch = pending_batch(db, 1).await?;
        assert!(apply_taste(db, 1, version, "updated", &batch).await?);
        assert_eq!(feedback_counts(db, 1).await?, (62, 0));
        Ok(())
    }

    #[tokio::test]
    async fn manual_edits_clears_and_forgetting_fence_background_taste() -> Result<()> {
        let scratch = database("taste-revision").await?;
        let db = &scratch.db;
        for card in ["manual", ""] {
            let (_, version) = taste_snapshot(db, 1).await?;
            save_taste(db, 1, card).await?;
            assert!(!apply_taste(db, 1, version, "stale model response", &[]).await?);
            assert_eq!(taste_snapshot(db, 1).await?.0, card);
        }
        set_feedback(db, 1, "movie", 1, Verdict::Like, "Original").await?;
        let (_, version) = taste_snapshot(db, 1).await?;
        let batch = pending_batch(db, 1).await?;
        clear_feedback(db, 1, "movie", 1).await?;
        set_feedback(db, 1, "movie", 1, Verdict::Dislike, "Recreated").await?;
        assert!(!apply_taste(db, 1, version, "removed rating", &batch).await?);
        assert_eq!(feedback_counts(db, 1).await?, (1, 1));
        let (_, version) = taste_snapshot(db, 1).await?;
        clear_all_feedback(db, 1).await?;
        assert!(!apply_taste(db, 1, version, "forgotten ratings", &[]).await?);
        Ok(())
    }

    #[tokio::test]
    async fn totals_and_exclusions_are_not_limited_by_prompt_context() -> Result<()> {
        let scratch = database("all-feedback").await?;
        let db = &scratch.db;
        let mut tx = Tx::begin(db).await?;
        for id in 1..=1001 {
            tx.execute(r#"INSERT INTO "ai_feedback" ("userId", "mediaType", "tmdbId", "kind") VALUES (1, 'movie', ?1, 'not_interested')"#, &[Bind::Int(id)]).await?;
        }
        tx.commit().await?;
        assert_eq!(feedback_counts(db, 1).await?, (1001, 1001));
        assert_eq!(feedback_keys(db, 1).await?.len(), 1001);
        assert!(feedback_keys(db, 1).await?.contains(&("movie", 1)));
        assert_eq!(
            feedback_for(db, 1, &[(String::from("movie"), 1)])
                .await?
                .get(&(String::from("movie"), 1))
                .map(String::as_str),
            Some("not_interested")
        );
        Ok(())
    }

    #[tokio::test]
    async fn personal_history_survives_newer_automatic_rows() -> Result<()> {
        let scratch = database("personal-history").await?;
        let db = &scratch.db;
        let own = create_run(db, 1, &Request::default().to_json(None), "own", None).await?;
        for _ in 0..65 {
            create_run(
                db,
                1,
                &Request {
                    row: true,
                    ..Request::default()
                }
                .to_json(None),
                "own",
                None,
            )
            .await?;
        }
        assert_eq!(
            personal_runs(db, 1, 20)
                .await?
                .iter()
                .map(|r| r.id)
                .collect::<Vec<_>>(),
            [own]
        );
        Ok(())
    }
}
