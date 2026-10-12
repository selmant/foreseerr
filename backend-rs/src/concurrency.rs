//! `server/lib/concurrency.ts`: bounded, order-preserving fan-out.

use std::future::Future;

use crate::jellyfin::{join_all, Job};

/// `PROVIDER_ROW_CONCURRENCY`: items of one provider row page in flight.
///
/// Per-item work (mapping lookups, TMDB confirm probes, tile art). TMDB answers quickly
/// with a handful of requests in flight and slows sharply past ~20, so a
/// 20-item page runs in a few waves rather than one burst or one item at a
/// time.
pub const PROVIDER_ROW_CONCURRENCY: usize = 8;

/// `mapWithConcurrency(items, limit, f)`: `f` over every item with at most
/// `limit` running at once, the outputs in the items' order.
pub async fn map_with_concurrency<'a, T, R, F, Fut>(items: Vec<T>, limit: usize, f: F) -> Vec<R>
where
    T: Send + 'a,
    R: Send + 'a,
    F: Fn(T) -> Fut + Sync + 'a,
    Fut: Future<Output = R> + Send + 'a,
{
    if items.is_empty() {
        return Vec::new();
    }
    let gate = tokio::sync::Semaphore::new(limit.max(1));
    let gate = &gate;
    let f = &f;
    let jobs: Vec<Job<'_, R>> = items
        .into_iter()
        .map(|item| {
            let job: Job<'_, R> = Box::pin(async move {
                // The semaphore is never closed, so this always waits its turn.
                let _permit = gate.acquire().await.ok();
                f(item).await
            });
            job
        })
        .collect();
    join_all(jobs).await
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[tokio::test]
    async fn bounded_and_in_order() {
        let running = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let out = map_with_concurrency((0..20).collect(), PROVIDER_ROW_CONCURRENCY, |n: u64| {
            let running = &running;
            let peak = &peak;
            async move {
                let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(20 - n)).await;
                running.fetch_sub(1, Ordering::SeqCst);
                n * 2
            }
        })
        .await;
        assert_eq!(out, (0..20).map(|n| n * 2).collect::<Vec<_>>(), "in order");
        assert_eq!(
            peak.load(Ordering::SeqCst),
            PROVIDER_ROW_CONCURRENCY,
            "never more than the limit"
        );
        let none: Vec<u8> = map_with_concurrency(Vec::new(), 4, |n: u8| async move { n }).await;
        assert!(none.is_empty(), "nothing to do");
    }
}
