//! `image-cache-cleanup`: `ImageProxy.maintainCache()`.

use super::JobCtx;

/// Drop expired, idle and over-budget image cache entries.
///
/// # Errors
///
/// Never: like Node, failures are only logged.
pub async fn run(job: &JobCtx) -> anyhow::Result<()> {
    let settings = job.current_settings().await.ok();
    crate::imagecache::maintain_cache(&job.state.env.config_dir, settings.as_deref(), None).await;
    Ok(())
}
