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

use crate::db::{Bind, Db};

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
            r#"INSERT INTO "ai_run" ("userId", "stage", "request", "source", "model") VALUES (?1, ?2, ?3, ?4, ?5) RETURNING CAST("id" AS BIGINT) AS "id""#,
            &[
                Bind::Int(user_id),
                Bind::Text(Stage::Planning.as_str().to_owned()),
                Bind::Text(request.to_string()),
                Bind::Text(source.to_owned()),
                Bind::OptText(model.map(str::to_owned)),
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
    db.execute(
        r#"UPDATE "ai_run" SET "stage" = ?1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?2"#,
        &[Bind::Text(stage.as_str().to_owned()), Bind::Int(run_id)],
    )
    .await?;
    Ok(())
}

/// Finish a run with its result.
///
/// # Errors
///
/// Fails on database errors.
pub async fn finish(db: &Db, run_id: i64, result: &Value) -> Result<()> {
    db.execute(
        r#"UPDATE "ai_run" SET "stage" = 'done', "result" = ?1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?2"#,
        &[Bind::Text(result.to_string()), Bind::Int(run_id)],
    )
    .await?;
    Ok(())
}

/// Finish a run with an error (the AI error's JSON).
///
/// # Errors
///
/// Fails on database errors.
pub async fn fail(db: &Db, run_id: i64, error: &Value) -> Result<()> {
    db.execute(
        r#"UPDATE "ai_run" SET "stage" = 'failed', "error" = ?1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?2"#,
        &[Bind::Text(error.to_string()), Bind::Int(run_id)],
    )
    .await?;
    Ok(())
}

fn run_columns(db: &Db) -> String {
    let created = db.iso_sql(r#""createdAt""#);
    format!(
        r#"CAST("id" AS BIGINT) AS "id", "stage", "request", "result", "error", "source", "model", {created} AS "createdAt""#
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
                r#"SELECT CAST(COUNT(*) AS BIGINT) AS "n" FROM "ai_run" WHERE "userId" = ?1 AND "source" = 'server' AND {created} >= ?2"#
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
    let updated = db
        .execute(
            r#"UPDATE "ai_feedback" SET "kind" = ?1, "title" = ?2, "updatedAt" = CURRENT_TIMESTAMP WHERE "userId" = ?3 AND "mediaType" = ?4 AND "tmdbId" = ?5"#,
            &binds,
        )
        .await?;
    if updated == 0 {
        db.execute(
            r#"INSERT INTO "ai_feedback" ("kind", "title", "userId", "mediaType", "tmdbId") VALUES (?1, ?2, ?3, ?4, ?5)"#,
            &binds,
        )
        .await?;
    }
    Ok(())
}

/// Remove a user's verdict on a title.
///
/// # Errors
///
/// Fails on database errors.
pub async fn clear_feedback(db: &Db, user_id: i64, media_type: &str, tmdb_id: i64) -> Result<()> {
    db.execute(
        r#"DELETE FROM "ai_feedback" WHERE "userId" = ?1 AND "mediaType" = ?2 AND "tmdbId" = ?3"#,
        &[
            Bind::Int(user_id),
            Bind::Text(media_type.to_owned()),
            Bind::Int(tmdb_id),
        ],
    )
    .await?;
    Ok(())
}

/// Remove all of a user's feedback.
///
/// # Errors
///
/// Fails on database errors.
pub async fn clear_all_feedback(db: &Db, user_id: i64) -> Result<()> {
    db.execute(
        r#"DELETE FROM "ai_feedback" WHERE "userId" = ?1"#,
        &[Bind::Int(user_id)],
    )
    .await?;
    Ok(())
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
                r#"SELECT "mediaType", CAST("tmdbId" AS BIGINT) AS "tmdbId", "kind", "title", {updated} AS "updatedAt" FROM "ai_feedback" WHERE "userId" = ?1 ORDER BY "updatedAt" DESC, "id" DESC LIMIT ?2"#
            ),
            &[Bind::Int(user_id), Bind::Int(limit)],
        )
        .await?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            Some(Feedback {
                media_type: text(r, "mediaType")?,
                tmdb_id: r.get("tmdbId").and_then(Value::as_i64)?,
                kind: text(r, "kind")?,
                title: text(r, "title").unwrap_or_default(),
                updated_at: text(r, "updatedAt").unwrap_or_default(),
            })
        })
        .collect())
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
    if card.trim().is_empty() {
        db.execute(
            r#"DELETE FROM "ai_taste" WHERE "userId" = ?1"#,
            &[Bind::Int(user_id)],
        )
        .await?;
        return Ok(());
    }
    let binds = [Bind::Text(card.trim().to_owned()), Bind::Int(user_id)];
    let updated = db
        .execute(
            r#"UPDATE "ai_taste" SET "card" = ?1, "updatedAt" = CURRENT_TIMESTAMP WHERE "userId" = ?2"#,
            &binds,
        )
        .await?;
    if updated == 0 {
        db.execute(
            r#"INSERT INTO "ai_taste" ("card", "userId") VALUES (?1, ?2)"#,
            &binds,
        )
        .await?;
    }
    Ok(())
}
