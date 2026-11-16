//! `ai-picks-refresh`: the nightly AI pass ([`crate::ai::recs::auto`]).

use std::sync::Arc;

use super::JobCtx;

/// Prune old AI requests, learn from what people did with their picks, and
/// prepare Discover rows and weekly picks ahead of time.
///
/// # Errors
///
/// Fails on database errors.
pub async fn run(job: &JobCtx) -> anyhow::Result<()> {
    let settings = job.current_settings().await?;
    let summary =
        crate::ai::recs::auto::run(Arc::clone(&job.state), settings, || job.cancelled()).await?;
    tracing::info!(
        label = "Jobs",
        "AI picks: {} people, {} rows refreshed, {} weekly picks, {} failed, {} old requests deleted",
        summary.people,
        summary.rows,
        summary.weekly,
        summary.failed,
        summary.pruned
    );
    Ok(())
}
