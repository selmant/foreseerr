//! `server/lib/discover/rowCache.ts`: stale-while-revalidate for computed
//! provider rows (a Trakt chart page, an `AniList` public page, a Simkl
//! trending page, an `MDBList` list page).
//!
//! A row within its freshness window is served as is. Past it, the stored
//! row is still served at once and one refresh runs in the background; a
//! failed refresh keeps the stored row. Past the hard maximum age a row is a
//! plain miss. Misses and refreshes are single-flight per key.
//!
//! What is stored is the row before anything request-specific: the unmapped
//! sightings, `hideUnmapped` and the request annotations run on every serve.

use std::collections::HashMap;
use std::fmt::Debug;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use tokio::sync::watch;

use crate::mappinglayer::lru::BoundedLru;

/// `PROVIDER_ROW_MAX_AGE_SECONDS`: older than this, a row is a miss
/// however it got there.
pub const MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// Rows kept per cache: pages of a handful of rows per user.
const MAX_ROWS: usize = 500;

/// What a clear and a stale mark bump. Every cache of the process shares
/// one set, so a single call reaches all of them.
#[derive(Debug, Default)]
pub struct Marks {
    /// Bumped by a clear: rows and flights from before it count as absent.
    generation: AtomicU64,
    /// Bumped when every stored row should count as stale.
    stale_epoch: AtomicU64,
}

impl Marks {
    /// A fresh set, for tests and for [`MARKS`].
    #[must_use]
    pub const fn new() -> Self {
        Self {
            generation: AtomicU64::new(0),
            stale_epoch: AtomicU64::new(0),
        }
    }

    fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    fn stale_epoch(&self) -> u64 {
        self.stale_epoch.load(Ordering::SeqCst)
    }

    /// `clearProviderRowCache`.
    pub fn clear(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    /// `markProviderRowsStale`.
    pub fn mark_stale(&self) {
        self.stale_epoch.fetch_add(1, Ordering::SeqCst);
    }
}

/// The process's marks.
pub static MARKS: Marks = Marks::new();

/// Drop every row: a mapping correction changes what a row resolves to.
pub fn clear() {
    MARKS.clear();
}

/// Serve every row once more, refreshing it: the datasets changed.
pub fn mark_stale() {
    MARKS.mark_stale();
}

/// A background refresh, built from owned parts.
pub type Refresh<V, E> = Pin<Box<dyn Future<Output = Result<V, E>> + Send + 'static>>;

type Answer<V, E> = Option<Result<V, E>>;

#[derive(Debug, Clone)]
struct Row<V> {
    value: V,
    stored: Instant,
    generation: u64,
    epoch: u64,
}

#[derive(Debug)]
struct Flight<V, E> {
    id: u64,
    generation: u64,
    answer: watch::Receiver<Answer<V, E>>,
}

#[derive(Debug)]
struct Inner<V, E> {
    rows: BoundedLru<String, Row<V>>,
    flights: HashMap<String, Flight<V, E>>,
    next_id: u64,
}

/// One kind of row (its stored value and its error).
#[derive(Debug)]
pub struct RowCache<V, E> {
    inner: Mutex<Inner<V, E>>,
    marks: &'static Marks,
}

/// A computation this call owns: its flight, and the marks it started under.
struct Owned<V, E> {
    id: u64,
    generation: u64,
    epoch: u64,
    answer: watch::Sender<Answer<V, E>>,
}

/// What a lookup does once no other request's computation is awaited.
enum Plan<V, E> {
    Serve(V),
    ServeAndRefresh(V, Owned<V, E>),
    Compute(Owned<V, E>),
}

/// A lookup: act, or await another request's computation.
enum Lookup<V, E> {
    Act(Plan<V, E>),
    Join(watch::Receiver<Answer<V, E>>),
}

/// Drops the flight when its computation ends or is abandoned.
struct Landing<'a, V, E> {
    cache: &'a RowCache<V, E>,
    key: &'a str,
    id: u64,
}

impl<V, E> Drop for Landing<'_, V, E> {
    fn drop(&mut self) {
        let mut inner = self
            .cache
            .inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if inner.flights.get(self.key).is_some_and(|f| f.id == self.id) {
            inner.flights.remove(self.key);
        }
    }
}

impl<V, E> RowCache<V, E>
where
    V: Clone + Debug + Send + Sync + 'static,
    E: Clone + Debug + Send + Sync + 'static,
{
    /// A cache answering to the process's [`MARKS`].
    #[must_use]
    pub fn new() -> Self {
        Self::with(MAX_AGE, &MARKS)
    }

    /// A cache with its own maximum age and marks.
    #[must_use]
    pub fn with(max_age: Duration, marks: &'static Marks) -> Self {
        Self {
            inner: Mutex::new(Inner {
                rows: BoundedLru::new(MAX_ROWS, Some(max_age)),
                flights: HashMap::new(),
                next_id: 0,
            }),
            marks,
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner<V, E>> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Start a flight for `key` under the current marks.
    fn take_off(&self, inner: &mut Inner<V, E>, key: &str) -> Owned<V, E> {
        inner.next_id += 1;
        let (answer, receiver) = watch::channel(None);
        let owned = Owned {
            id: inner.next_id,
            generation: self.marks.generation(),
            epoch: self.marks.stale_epoch(),
            answer,
        };
        inner.flights.insert(
            key.to_owned(),
            Flight {
                id: owned.id,
                generation: owned.generation,
                answer: receiver,
            },
        );
        owned
    }

    fn look(&self, key: &str, fresh: Duration) -> Lookup<V, E> {
        let generation = self.marks.generation();
        let mut inner = self.lock();
        let flying = inner
            .flights
            .get(key)
            .filter(|f| f.generation == generation)
            .map(|f| f.answer.clone());
        let row = inner
            .rows
            .get(&key.to_owned())
            .filter(|r| r.generation == generation);
        let lookup = match (row, flying) {
            (Some(row), flying) => {
                let is_fresh =
                    row.epoch == self.marks.stale_epoch() && row.stored.elapsed() < fresh;
                if is_fresh || flying.is_some() {
                    Lookup::Act(Plan::Serve(row.value))
                } else {
                    let owned = self.take_off(&mut inner, key);
                    Lookup::Act(Plan::ServeAndRefresh(row.value, owned))
                }
            }
            (None, Some(answer)) => Lookup::Join(answer),
            (None, None) => Lookup::Act(Plan::Compute(self.take_off(&mut inner, key))),
        };
        drop(inner);
        lookup
    }

    /// Store a computed row, unless a clear came after it started.
    fn land(&self, key: &str, owned: &Owned<V, E>, result: &Result<V, E>) {
        if let Ok(value) = result {
            if owned.generation == self.marks.generation() {
                self.lock().rows.set(
                    key.to_owned(),
                    Row {
                        value: value.clone(),
                        stored: Instant::now(),
                        generation: owned.generation,
                        epoch: owned.epoch,
                    },
                );
            }
        }
    }

    /// `cachedProviderRow(key, freshSeconds, run)`: `inline` computes a
    /// miss in the request; `refresh` builds the background refresh of a
    /// stale row.
    ///
    /// # Errors
    ///
    /// A miss's computation failed (this request's, or the one it joined).
    pub async fn get<Fut, R>(
        &'static self,
        key: &str,
        fresh: Duration,
        inline: Fut,
        refresh: R,
    ) -> Result<V, E>
    where
        Fut: Future<Output = Result<V, E>> + Send,
        R: FnOnce() -> Refresh<V, E> + Send,
    {
        let plan = loop {
            match self.look(key, fresh) {
                Lookup::Act(plan) => break plan,
                Lookup::Join(mut answer) => {
                    if let Ok(done) = answer.wait_for(Option::is_some).await {
                        if let Some(result) = done.as_ref() {
                            return result.clone();
                        }
                    }
                    // The computing request went away: look again.
                }
            }
        };
        match plan {
            Plan::Serve(value) => Ok(value),
            Plan::ServeAndRefresh(value, owned) => {
                self.spawn_refresh(key.to_owned(), owned, refresh());
                Ok(value)
            }
            Plan::Compute(owned) => {
                let _landing = Landing {
                    cache: self,
                    key,
                    id: owned.id,
                };
                let result = inline.await;
                self.land(key, &owned, &result);
                owned.answer.send_replace(Some(result.clone()));
                result
            }
        }
    }

    fn spawn_refresh(&'static self, key: String, owned: Owned<V, E>, work: Refresh<V, E>) {
        tokio::spawn(async move {
            let _landing = Landing {
                cache: self,
                key: &key,
                id: owned.id,
            };
            let result = work.await;
            if let Err(e) = &result {
                tracing::warn!(key = %key, "Provider row refresh failed; serving the stored row: {e:?}");
            }
            self.land(&key, &owned, &result);
            owned.answer.send_replace(Some(result));
        });
    }
}

impl<V, E> Default for RowCache<V, E>
where
    V: Clone + Debug + Send + Sync + 'static,
    E: Clone + Debug + Send + Sync + 'static,
{
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    use super::*;

    type Cache = RowCache<i64, String>;

    fn cache(max_age: Duration) -> (&'static Cache, &'static Marks) {
        let marks: &'static Marks = Box::leak(Box::new(Marks::new()));
        (Box::leak(Box::new(Cache::with(max_age, marks))), marks)
    }

    fn never() -> Refresh<i64, String> {
        Box::pin(async { Err(String::from("no refresh expected")) })
    }

    /// A refresh answering `value` and counting itself.
    fn counted(calls: &Arc<AtomicUsize>, value: Result<i64, String>) -> Refresh<i64, String> {
        let calls = Arc::clone(calls);
        Box::pin(async move {
            calls.fetch_add(1, Ordering::SeqCst);
            value
        })
    }

    async fn settle() {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    const MIN: Duration = Duration::from_secs(60);

    #[tokio::test]
    async fn fresh_rows_are_served_as_is() {
        let (c, _) = cache(MAX_AGE);
        assert_eq!(c.get("k", MIN, async { Ok(1) }, never).await, Ok(1), "miss");
        assert_eq!(c.get("k", MIN, async { Ok(2) }, never).await, Ok(1), "hit");
        assert_eq!(
            c.get("j", MIN, async { Ok(3) }, never).await,
            Ok(3),
            "keys apart"
        );
    }

    #[tokio::test]
    async fn stale_rows_are_served_while_one_refresh_runs() {
        let (c, _) = cache(MAX_AGE);
        let calls = Arc::new(AtomicUsize::new(0));
        c.get("k", Duration::ZERO, async { Ok(1) }, never)
            .await
            .ok();
        for _ in 0..3 {
            let served = c
                .get("k", Duration::ZERO, async { Ok(9) }, || {
                    counted(&calls, Ok(2))
                })
                .await;
            assert_eq!(served, Ok(1), "the stored row, at once");
        }
        settle().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1, "one refresh");
        assert_eq!(
            c.get("k", MIN, async { Ok(9) }, never).await,
            Ok(2),
            "refreshed"
        );
    }

    #[tokio::test]
    async fn a_failed_refresh_keeps_the_row() {
        let (c, _) = cache(MAX_AGE);
        let calls = Arc::new(AtomicUsize::new(0));
        c.get("k", Duration::ZERO, async { Ok(1) }, never)
            .await
            .ok();
        let served = c
            .get("k", Duration::ZERO, async { Ok(9) }, || {
                counted(&calls, Err(String::from("down")))
            })
            .await;
        assert_eq!(served, Ok(1), "stale");
        settle().await;
        assert_eq!(c.get("k", MIN, async { Ok(9) }, never).await, Ok(1), "kept");
        assert_eq!(calls.load(Ordering::SeqCst), 1, "it ran");
    }

    #[tokio::test]
    async fn concurrent_misses_share_one_computation() {
        let (c, _) = cache(MAX_AGE);
        let calls = AtomicUsize::new(0);
        let run = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(10)).await;
            Err::<i64, String>(String::from("upstream down"))
        };
        let (a, b) = tokio::join!(c.get("k", MIN, run(), never), c.get("k", MIN, run(), never));
        assert_eq!(calls.load(Ordering::SeqCst), 1, "one computation");
        assert_eq!(a, Err(String::from("upstream down")), "first");
        assert_eq!(
            b,
            Err(String::from("upstream down")),
            "joined, error included"
        );
        assert!(
            c.get("k", MIN, run(), never).await.is_err(),
            "nothing stored"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2, "computed again");
    }

    #[tokio::test]
    async fn an_abandoned_miss_hands_over() {
        let (c, _) = cache(MAX_AGE);
        let first = tokio::spawn(c.get(
            "k",
            MIN,
            async {
                tokio::time::sleep(Duration::from_secs(60)).await;
                Ok(1)
            },
            never,
        ));
        tokio::time::sleep(Duration::from_millis(5)).await;
        let second = tokio::spawn(c.get("k", MIN, async { Ok(2) }, never));
        tokio::time::sleep(Duration::from_millis(5)).await;
        first.abort();
        let second = second.await.ok();
        assert_eq!(second, Some(Ok(2)), "the waiter computes");
    }

    #[tokio::test]
    async fn rows_past_the_maximum_age_are_misses() {
        let (c, _) = cache(Duration::from_millis(10));
        c.get("k", MIN, async { Ok(1) }, never).await.ok();
        settle().await;
        assert_eq!(c.get("k", MIN, async { Ok(2) }, never).await, Ok(2), "miss");
    }

    #[tokio::test]
    async fn a_clear_drops_rows_and_late_computations() {
        let (c, marks) = cache(MAX_AGE);
        c.get("k", MIN, async { Ok(1) }, never).await.ok();
        marks.clear();
        let (release, wait) = tokio::sync::oneshot::channel::<()>();
        let slow = tokio::spawn(c.get(
            "k",
            MIN,
            async {
                wait.await.ok();
                Ok(2)
            },
            never,
        ));
        tokio::time::sleep(Duration::from_millis(5)).await;
        marks.clear();
        release.send(()).ok();
        assert_eq!(slow.await.ok(), Some(Ok(2)), "its caller still gets it");
        assert_eq!(
            c.get("k", MIN, async { Ok(3) }, never).await,
            Ok(3),
            "not stored"
        );
    }

    #[tokio::test]
    async fn marked_rows_are_served_once_more_and_refreshed() {
        let (c, marks) = cache(MAX_AGE);
        let calls = Arc::new(AtomicUsize::new(0));
        let hour = Duration::from_secs(3600);
        c.get("k", hour, async { Ok(1) }, never).await.ok();
        marks.mark_stale();
        let served = c
            .get("k", hour, async { Ok(9) }, || counted(&calls, Ok(2)))
            .await;
        assert_eq!(served, Ok(1), "stale");
        settle().await;
        assert_eq!(
            c.get("k", hour, async { Ok(9) }, never).await,
            Ok(2),
            "fresh"
        );
    }
}
