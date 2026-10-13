//! Bounded admission for CPU-heavy work (bcrypt, mapping packs, `OpenPGP`).
//!
//! A permit is taken before the work reaches Tokio's blocking pool, so a
//! burst can't start more of it at once than there are cores to run it.

use std::sync::LazyLock;

use anyhow::anyhow;
use tokio::sync::Semaphore;

/// One permit per core, between one and four.
static PERMITS: LazyLock<Semaphore> = LazyLock::new(|| {
    let cores = std::thread::available_parallelism().map_or(1, std::num::NonZeroUsize::get);
    Semaphore::new(cores.clamp(1, 4))
});

/// Run `f` on the blocking pool once one of the shared permits is free.
///
/// # Errors
///
/// Fails when the work panics or the runtime is shutting down.
pub async fn run<F, R>(f: F) -> anyhow::Result<R>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    let permit = PERMITS
        .acquire()
        .await
        .map_err(|e| anyhow!("CPU pool closed: {e}"))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        f()
    })
    .await
    .map_err(|e| anyhow!("CPU task failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[tokio::test]
    async fn runs_and_reports_panics() {
        assert_eq!(run(|| 6 * 7).await.ok(), Some(42), "result");
        assert!(
            run(|| std::panic::resume_unwind(Box::new("boom")))
                .await
                .is_err(),
            "panic is an error"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn admission_is_bounded() {
        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let jobs: Vec<_> = (0..16)
            .map(|_| {
                let (running, peak) = (Arc::clone(&running), Arc::clone(&peak));
                tokio::spawn(run(move || {
                    let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    std::thread::sleep(std::time::Duration::from_millis(20));
                    running.fetch_sub(1, Ordering::SeqCst);
                }))
            })
            .collect();
        for job in jobs {
            assert!(matches!(job.await, Ok(Ok(()))), "job finished");
        }
        assert!(
            (1..=4).contains(&peak.load(Ordering::SeqCst)),
            "peak within the clamp"
        );
    }
}
