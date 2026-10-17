//! `mapping-pack-refresh`: `refreshAllDatasets()`.

use std::sync::Arc;

use super::JobCtx;

/// Refresh every mapping dataset by rank, stopping between datasets when
/// cancelled.
///
/// # Errors
///
/// Fails on database errors; a dead upstream only records its error.
pub async fn run(job: &JobCtx) -> anyhow::Result<()> {
    crate::mappingdatasets::refresh_all(&Arc::clone(&job.state), false, Some(job)).await?;
    Ok(())
}
