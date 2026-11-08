//! The nightly AI job, so people rarely wait for picks and the AI isn't
//! asked every time someone opens Discover:
//!
//! - deletes finished requests older than the history setting;
//! - finds what people did with their picks ([`super::signals`]);
//! - for people who looked at AI picks in the last week, refreshes their
//!   Discover AI rows that would go stale during the day;
//! - makes each of them a weekly "picks for you" set (unless they turned it
//!   off) and tells them with a web push.
//!
//! Work is one person and one request at a time, and stops when the job is
//! cancelled. Automatic requests don't count toward anyone's daily limit;
//! they do count toward the server's monthly token budget.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::rows::{self, Config};
use super::store::{self, Origin};
use super::{iso_since, signals, Request};
use crate::ai::Policy;
use crate::auth::CurrentUser;
use crate::db::Bind;
use crate::settings::Settings;
use crate::state::AppState;

/// Only people who looked at AI picks this recently get automatic picks.
const ACTIVE_DAYS: i64 = 7;
/// A row is refreshed tonight when it would go stale within this long.
pub const REFRESH_AHEAD_MINUTES: i64 = 12 * 60;
/// Weekly picks are made when the last ones are at least this old.
const WEEKLY_MINUTES: i64 = 7 * 24 * 60 - 12 * 60;
/// What weekly picks ask for.
pub const WEEKLY_PROMPT: &str = "Fresh picks for this week, based on my taste";
/// One automatic request gets this long before the job moves on.
const WAIT_FOR_RUN: Duration = Duration::from_mins(10);

/// What one night did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Summary {
    /// Old requests deleted.
    pub pruned: u64,
    /// People looked at.
    pub people: usize,
    /// Discover rows refreshed.
    pub rows: usize,
    /// Weekly picks made.
    pub weekly: usize,
    /// Requests that failed.
    pub failed: usize,
}

async fn active_people(state: &AppState) -> anyhow::Result<Vec<(i64, bool)>> {
    let at = state.db.iso_sql(r#""lastActiveAt""#);
    Ok(state
        .db
        .rows(
            &format!(
                r#"SELECT CAST("userId" AS BIGINT) AS "userId", "weeklyPicks" FROM "ai_user_settings" WHERE "lastActiveAt" IS NOT NULL AND {at} >= ?1 ORDER BY "userId""#
            ),
            &[Bind::Text(iso_since(Some(ACTIVE_DAYS * 24 * 60)))],
        )
        .await?
        .iter()
        .filter_map(|r| {
            let id = r.get("userId")?.as_i64()?;
            let weekly = crate::settings::public::truthy(r.get("weeklyPicks"));
            Some((id, weekly))
        })
        .collect())
}

async fn person(state: &AppState, id: i64) -> anyhow::Result<Option<CurrentUser>> {
    Ok(state.db.user(id).await?.map(|u| CurrentUser {
        id,
        permissions: u.permissions,
        webpush_enabled: true,
        locale: None,
    }))
}

/// Wait for a run to finish; whether it ended with picks.
async fn finished(state: &AppState, user_id: i64, run_id: i64) -> bool {
    let deadline = tokio::time::Instant::now() + WAIT_FOR_RUN;
    while tokio::time::Instant::now() < deadline {
        match store::run(&state.db, user_id, run_id).await {
            Ok(Some(run)) if run.stage == "done" => return true,
            Ok(Some(run)) if run.stage == "failed" => return false,
            Ok(None) | Err(_) => return false,
            Ok(Some(_)) => tokio::time::sleep(Duration::from_secs(2)).await,
        }
    }
    false
}

/// When this row's newest picks for this person were made (ISO).
async fn row_made_at(state: &AppState, user_id: i64, config: &Config) -> Option<String> {
    let mut newest: Option<String> = store::row_runs(&state.db, user_id, &config.request)
        .await
        .ok()?
        .into_iter()
        .filter(|r| r.stage == "done" && rows::matches_request(r, &config.request))
        .map(|r| r.created_at)
        .max();
    if let Some(id) = config.initial_run {
        if let Ok(Some(run)) = store::run(&state.db, user_id, id).await {
            if run.stage == "done" && rows::matches_request(&run, &config.request) {
                let at = config.saved_at.clone().unwrap_or(run.created_at);
                newest = newest.max(Some(at));
            }
        }
    }
    newest
}

/// Start a request for this person and wait for it.
async fn request(
    state: &Arc<AppState>,
    settings: &Arc<Settings>,
    user: &CurrentUser,
    request: Request,
    origin: Origin,
) -> Option<i64> {
    match super::start(
        Arc::clone(state),
        Arc::clone(settings),
        user.clone(),
        request,
        origin,
    )
    .await
    {
        Ok(id) => finished(state, user.id, id).await.then_some(id),
        Err(e) => {
            tracing::info!(
                "automatic AI picks for user {} didn't start: {}",
                user.id,
                e.message
            );
            None
        }
    }
}

/// Tell someone their weekly picks are ready (web push, when they have it).
async fn announce(state: &Arc<AppState>, settings: &Arc<Settings>, user_id: i64, run_id: i64) {
    let Ok(Some(run)) = store::run(&state.db, user_id, run_id).await else {
        return;
    };
    let headline = run
        .result
        .as_ref()
        .and_then(|r| r.get("headline"))
        .and_then(Value::as_str)
        .filter(|h| !h.is_empty())
        .unwrap_or("A few titles picked for your taste");
    let count = run
        .result
        .as_ref()
        .and_then(|r| r.get("picks"))
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let base = settings.str("/main/applicationUrl");
    let url = format!("{}/discover/ai?run={run_id}", base.trim_end_matches('/'));
    let body = json!({
        "notificationType": "AI_WEEKLY_PICKS",
        "subject": "Your weekly picks are ready",
        "message": format!("{headline} — {count} picks"),
        "actionUrl": url,
        "actionUrlTitle": "See picks",
    });
    let env = crate::notify::Env {
        state: Arc::clone(state),
        settings: Arc::clone(settings),
    };
    if let Err(e) = crate::notify::webpush::send_to_user(&env, user_id, &body).await {
        tracing::info!("telling user {user_id} about weekly picks failed: {e:#}");
    }
}

/// The nightly pass.
///
/// # Errors
///
/// Fails on database errors.
pub async fn run(
    state: Arc<AppState>,
    settings: Arc<Settings>,
    cancelled: impl Fn() -> bool + Send + Sync,
) -> anyhow::Result<Summary> {
    let policy = Policy::of(&settings);
    let mut summary = Summary::default();
    let keep_before =
        (policy.history_days > 0).then(|| iso_since(Some(policy.history_days * 24 * 60)));
    summary.pruned = store::prune_runs(&state.db, keep_before.as_deref()).await?;
    if !policy.enabled {
        return Ok(summary);
    }
    let sliders: Vec<Config> = state
        .db
        .discover_sliders()
        .await?
        .into_iter()
        .filter(|s| s.slider_type == rows::SLIDER_TYPE && s.enabled)
        .filter_map(|s| Config::parse(s.data.as_deref().unwrap_or_default()).ok())
        .collect();
    let refresh_before = iso_since(Some(
        (policy.row_refresh_days * 24 * 60 - REFRESH_AHEAD_MINUTES).max(60),
    ));
    for (user_id, weekly) in active_people(&state).await? {
        if cancelled() {
            break;
        }
        let Some(user) = person(&state, user_id).await? else {
            continue;
        };
        summary.people += 1;
        let watched = tokio::time::timeout(
            Duration::from_secs(20),
            crate::mappinglayer::watched::load_combined(&state, &settings, user_id),
        )
        .await
        .ok()
        .and_then(Result::ok);
        if let Err(e) = signals::sync(&state, &settings, user_id, watched.as_ref(), true).await {
            tracing::info!("finding what user {user_id} did with their picks failed: {e:#}");
        }
        if !policy.auto_picks {
            continue;
        }
        for config in &sliders {
            if cancelled() {
                break;
            }
            if row_made_at(&state, user_id, config)
                .await
                .is_some_and(|at| at >= refresh_before)
            {
                continue;
            }
            let mut req = config.request.clone();
            req.row = true;
            if request(&state, &settings, &user, req, Origin::Scheduled)
                .await
                .is_some()
            {
                summary.rows += 1;
            } else {
                summary.failed += 1;
            }
        }
        let due = store::last_weekly_at(&state.db, user_id)
            .await?
            .is_none_or(|at| at < iso_since(Some(WEEKLY_MINUTES)));
        if weekly && due && !cancelled() {
            let weekly_request = Request {
                prompt: String::from(WEEKLY_PROMPT),
                ..Request::default()
            };
            match request(&state, &settings, &user, weekly_request, Origin::Weekly).await {
                Some(id) => {
                    summary.weekly += 1;
                    announce(&state, &settings, user_id, id).await;
                }
                None => summary.failed += 1,
            }
        }
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn history_expires_before_longer_row_refresh() -> anyhow::Result<()> {
        let scratch = crate::dbtx::scratch::sqlite("ai-retention").await?;
        let db = &scratch.db;
        db.execute(r#"INSERT INTO "user" ("id", "email", "permissions", "userType", "avatar") VALUES (1, 'retention@example.test', 0, 1, '')"#, &[]).await?;
        let id = store::create_run(
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
        store::finish(
            db,
            id,
            &json!({"picks": [{"mediaType": "movie", "tmdbId": 1}]}),
        )
        .await?;
        db.execute(
            r#"UPDATE "ai_run" SET "createdAt" = ?2 WHERE "id" = ?1"#,
            &[Bind::Int(id), Bind::Text(iso_since(Some(2 * 24 * 60)))],
        )
        .await?;
        let state = Arc::new(AppState::for_tests(db.clone(), &std::env::temp_dir())?);
        let settings = Arc::new(Settings::from_file_value(
            json!({"ai": {"enabled": false, "historyDays": 1, "rowRefreshDays": 30}}),
            None,
        )?);
        assert_eq!(run(state, settings, || false).await?.pruned, 1);
        assert!(store::run(db, 1, id).await?.is_none());
        assert!(db
            .rows(
                r#"SELECT "id" FROM "ai_pick" WHERE "runId" = ?1"#,
                &[Bind::Int(id)]
            )
            .await?
            .is_empty());
        Ok(())
    }
}
