//! `dispatcher.ts`: the fan-out over the available providers and the
//! aggregate the routes print.
//!
//! Aggregation: watched when any successful provider says so; the rating
//! of the first successful provider that has one.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::types::{
    Aggregate, Availability, Capabilities, Capability, Item, ProviderId, ProviderResult, Reason,
    Status,
};
use crate::jellyfin::{join_all, Job};

/// A boxed provider future.
pub type Fut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A thrown error's message.
pub type Thrown = String;

/// `MarkWatchedOptions`.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct MarkOptions {
    /// `watchedAt === 'release'`.
    pub at_release: bool,
    /// `ratingStars`.
    pub rating_stars: Option<f64>,
}

/// One write, as `runOnProviders` hands it to each provider.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Write {
    /// `markWatched(userId, item, options)`.
    Mark(MarkOptions),
    /// `unmarkWatched(userId, item, { removeRating })`.
    Unmark {
        /// `removeRating`.
        remove_rating: bool,
    },
    /// `rate(userId, item, { ratingStars })`.
    Rate(f64),
}

impl Write {
    const fn capability(self) -> Capability {
        match self {
            Self::Mark(_) | Self::Unmark { .. } => Capability::WriteWatched,
            Self::Rate(_) => Capability::WriteRating,
        }
    }
}

/// `MediaActionProvider`.
pub trait Provider: Send + Sync {
    /// `id`.
    fn id(&self) -> ProviderId;
    /// `capabilities`.
    fn capabilities(&self) -> Capabilities;
    /// `isAvailable(userId)`.
    fn is_available(&self) -> Fut<'_, Result<bool, Thrown>>;
    /// `getStatus(userId, item)`.
    fn status(&self, item: Item) -> Fut<'_, Result<Status, Thrown>>;
    /// `getStatuses(userId, items)`.
    fn statuses<'a>(&'a self, items: &'a [Item]) -> Fut<'a, Result<Vec<(Item, Status)>, Thrown>>;
    /// `markWatched`, `unmarkWatched` or `rate`.
    fn write(&self, item: Item, write: Write) -> Fut<'_, Result<Status, Thrown>>;
}

/// `unavailableReason(providers, matching)`.
fn unavailable_reason(all: &[ProviderResult], matching: &[&ProviderResult]) -> Option<Reason> {
    if matching.iter().any(|p| p.ok) {
        return None;
    }
    if matching.is_empty() {
        return Some(if all.is_empty() {
            Reason::NoProvider
        } else {
            Reason::Unsupported
        });
    }
    let unmapped = matching.iter().all(|p| {
        matches!(
            p.status.error.as_deref(),
            Some(super::jellyfin::NOT_MAPPED | super::anilist::NOT_MAPPED)
        )
    });
    Some(if unmapped {
        Reason::NotMapped
    } else {
        Reason::ProviderError
    })
}

/// `actionAvailability(providers, providerDefinitions)`.
fn availability(
    results: &[ProviderResult],
    definitions: &[(ProviderId, Capabilities)],
    capability: Capability,
) -> Availability {
    let matching: Vec<&ProviderResult> = results
        .iter()
        .filter(|r| {
            definitions
                .iter()
                .any(|(id, caps)| *id == r.provider && caps.has(capability))
        })
        .collect();
    let available = matching.iter().any(|p| p.ok);
    Availability {
        available,
        reason: if available {
            None
        } else {
            unavailable_reason(results, &matching)
        },
    }
}

/// `aggregateFromProviders(item, providers, providerDefinitions)`.
#[must_use]
pub fn aggregate(
    item: Item,
    results: Vec<ProviderResult>,
    definitions: &[(ProviderId, Capabilities)],
) -> Aggregate {
    let successful: Vec<&ProviderResult> = results.iter().filter(|p| p.ok).collect();
    let watched = successful.iter().any(|p| p.status.watched);
    let status = successful
        .iter()
        .find(|p| p.status.rating.is_some())
        .map_or_else(
            || Status::of(watched, None),
            |p| {
                Status {
                    watched,
                    rating: p.status.rating,
                    rating_stars: p.status.rating_stars,
                    error: None,
                }
                .with_stars()
            },
        );
    Aggregate {
        tmdb_id: item.tmdb_id,
        media_type: item.media_type,
        status,
        watched_action: availability(&results, definitions, Capability::WriteWatched),
        rating_action: availability(&results, definitions, Capability::WriteRating),
        providers: results,
    }
}

/// One provider's batch, with the order it settled in.
type Settled = (usize, Vec<(Item, ProviderResult)>);

/// The fan-out over a request's providers.
pub struct Dispatcher<'a> {
    providers: Vec<Box<dyn Provider + 'a>>,
}

impl std::fmt::Debug for Dispatcher<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list()
            .entries(self.providers.iter().map(|p| p.id()))
            .finish()
    }
}

impl<'a> Dispatcher<'a> {
    /// Over `providers`, in `getDefaultMediaActionProviders` order.
    #[must_use]
    pub fn new(providers: Vec<Box<dyn Provider + 'a>>) -> Self {
        Self { providers }
    }

    fn definitions(&self) -> Vec<(ProviderId, Capabilities)> {
        self.providers
            .iter()
            .map(|p| (p.id(), p.capabilities()))
            .collect()
    }

    /// `filterAvailableProviders`: one `isAvailable` after another.
    async fn available(
        &self,
        capability: Option<Capability>,
    ) -> Result<Vec<&(dyn Provider + 'a)>, Thrown> {
        let mut enabled = Vec::new();
        for provider in &self.providers {
            if capability.is_some_and(|c| !provider.capabilities().has(c)) {
                continue;
            }
            if provider.is_available().await? {
                enabled.push(provider.as_ref());
            }
        }
        Ok(enabled)
    }

    fn empty(&self, item: Item) -> Aggregate {
        aggregate(item, Vec::new(), &self.definitions())
    }

    /// `getStatus(userId, item)`.
    ///
    /// # Errors
    ///
    /// An `isAvailable` that throws.
    pub async fn status(&self, item: Item) -> Result<Aggregate, Thrown> {
        let enabled: Vec<_> = self
            .available(None)
            .await?
            .into_iter()
            .filter(|p| p.capabilities().reads())
            .collect();
        if enabled.is_empty() {
            return Ok(self.empty(item));
        }
        let jobs: Vec<Job<'_, ProviderResult>> = enabled
            .into_iter()
            .map(|provider| -> Job<'_, ProviderResult> {
                Box::pin(async move {
                    match provider.status(item).await {
                        Ok(status) => ProviderResult::from_status(provider.id(), status),
                        Err(e) => ProviderResult::thrown(provider.id(), e),
                    }
                })
            })
            .collect();
        let results = join_all(jobs).await;
        Ok(aggregate(item, results, &self.definitions()))
    }

    /// `getStatuses(userId, items)`.
    ///
    /// # Errors
    ///
    /// An `isAvailable` that throws.
    pub async fn statuses(&self, items: &[Item]) -> Result<Vec<Aggregate>, Thrown> {
        if items.is_empty() {
            return Ok(Vec::new());
        }
        let enabled: Vec<_> = self
            .available(None)
            .await?
            .into_iter()
            .filter(|p| p.capabilities().reads())
            .collect();
        if enabled.is_empty() {
            return Ok(items.iter().map(|item| self.empty(*item)).collect());
        }
        // Node pushes each provider's results as its batch settles, so a
        // title's provider list is in settling order.
        let settled = AtomicUsize::new(0);
        let settled = &settled;
        let jobs: Vec<Job<'_, Settled>> = enabled
            .into_iter()
            .map(|provider| -> Job<'_, Settled> {
                Box::pin(async move {
                    let results = batch_results(provider, items).await;
                    (settled.fetch_add(1, Ordering::SeqCst), results)
                })
            })
            .collect();
        let mut batches = join_all(jobs).await;
        batches.sort_by_key(|(order, _)| *order);
        let batches: Vec<Vec<(Item, ProviderResult)>> =
            batches.into_iter().map(|(_, results)| results).collect();
        let definitions = self.definitions();
        Ok(items
            .iter()
            .map(|item| {
                let results = batches
                    .iter()
                    .flatten()
                    .filter(|(i, _)| i == item)
                    .map(|(_, r)| r.clone())
                    .collect();
                aggregate(*item, results, &definitions)
            })
            .collect())
    }

    /// `runOnProviders` for a write.
    ///
    /// # Errors
    ///
    /// An `isAvailable` that throws.
    pub async fn write(&self, item: Item, write: Write) -> Result<Aggregate, Thrown> {
        let enabled = self.available(Some(write.capability())).await?;
        if enabled.is_empty() {
            return Ok(self.empty(item));
        }
        let jobs: Vec<Job<'_, ProviderResult>> = enabled
            .into_iter()
            .map(|provider| -> Job<'_, ProviderResult> {
                Box::pin(async move {
                    match provider.write(item, write).await {
                        Ok(status) => ProviderResult::from_status(provider.id(), status),
                        Err(e) => ProviderResult::thrown(provider.id(), e),
                    }
                })
            })
            .collect();
        let results = join_all(jobs).await;
        Ok(aggregate(item, results, &self.definitions()))
    }
}

/// One provider's part of `getStatuses`: a result per requested item.
async fn batch_results(provider: &dyn Provider, items: &[Item]) -> Vec<(Item, ProviderResult)> {
    let id = provider.id();
    match provider.statuses(items).await {
        Ok(statuses) => {
            let mut out = Vec::new();
            let mut returned = Vec::new();
            for (item, status) in statuses {
                if !items.contains(&item) {
                    continue;
                }
                returned.push(item);
                out.push((item, ProviderResult::from_status(id, status)));
            }
            for item in items {
                if !returned.contains(item) {
                    out.push((
                        *item,
                        ProviderResult::thrown(
                            id,
                            String::from("Provider did not return a status for item"),
                        ),
                    ));
                }
            }
            out
        }
        Err(e) => items
            .iter()
            .map(|item| (*item, ProviderResult::thrown(id, e.clone())))
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::mappinglayer::MediaType;
    use crate::mediaactions::types::{FULL, WATCHED_ONLY};

    const ITEM: Item = Item {
        media_type: MediaType::Movie,
        tmdb_id: 550,
    };

    struct Stub {
        id: ProviderId,
        available: bool,
        status: Result<Status, Thrown>,
        write: Result<Status, Thrown>,
        calls: Mutex<Vec<&'static str>>,
    }

    fn stub(id: ProviderId) -> Stub {
        Stub {
            id,
            available: true,
            status: Ok(Status::of(true, Some(8.0))),
            write: Ok(Status::of(true, None)),
            calls: Mutex::new(Vec::new()),
        }
    }

    impl Provider for Stub {
        fn id(&self) -> ProviderId {
            self.id
        }
        fn capabilities(&self) -> Capabilities {
            if self.id == ProviderId::Jellyfin {
                WATCHED_ONLY
            } else {
                FULL
            }
        }
        fn is_available(&self) -> Fut<'_, Result<bool, Thrown>> {
            Box::pin(async move { Ok(self.available) })
        }
        fn status(&self, _item: Item) -> Fut<'_, Result<Status, Thrown>> {
            Box::pin(async move { self.status.clone() })
        }
        fn statuses<'a>(
            &'a self,
            items: &'a [Item],
        ) -> Fut<'a, Result<Vec<(Item, Status)>, Thrown>> {
            Box::pin(async move {
                Ok(items
                    .iter()
                    .map(|i| (*i, Status::of(true, Some(8.0))))
                    .collect())
            })
        }
        fn write(&self, _item: Item, _write: Write) -> Fut<'_, Result<Status, Thrown>> {
            Box::pin(async move {
                crate::sync::lock(&self.calls).push(self.id.as_str());
                self.write.clone()
            })
        }
    }

    fn dispatcher(stubs: Vec<Stub>) -> Dispatcher<'static> {
        Dispatcher::new(
            stubs
                .into_iter()
                .map(|s| -> Box<dyn Provider> { Box::new(s) })
                .collect(),
        )
    }

    fn run<T>(future: impl Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .map_or_else(|_| std::process::abort(), |rt| rt.block_on(future))
    }

    #[test]
    fn fans_out_and_skips_unavailable() {
        let result = run(dispatcher(vec![stub(ProviderId::Trakt)])
            .write(ITEM, Write::Mark(MarkOptions::default())));
        let result = result.unwrap_or_else(|_| std::process::abort());
        assert!(result.status.watched, "watched");
        assert_eq!(result.providers.len(), 1, "one provider");
        assert!(result.providers.first().is_some_and(|p| p.ok), "ok");
        let unavailable = Stub {
            available: false,
            ..stub(ProviderId::Trakt)
        };
        let result =
            run(dispatcher(vec![unavailable]).write(ITEM, Write::Mark(MarkOptions::default())));
        let result = result.unwrap_or_else(|_| std::process::abort());
        assert!(result.providers.is_empty(), "skipped");
        assert!(!result.status.watched, "not watched");
    }

    #[test]
    fn records_failures_without_throwing() {
        for write in [
            Write::Mark(MarkOptions::default()),
            Write::Unmark {
                remove_rating: false,
            },
            Write::Unmark {
                remove_rating: true,
            },
            Write::Rate(4.0),
        ] {
            let failing = Stub {
                write: Err(String::from("trakt mark failed")),
                ..stub(ProviderId::Trakt)
            };
            let result = run(dispatcher(vec![failing]).write(ITEM, write))
                .unwrap_or_else(|_| std::process::abort());
            let first = result.providers.first();
            assert!(first.is_some_and(|p| !p.ok), "{write:?}");
            assert_eq!(
                first.and_then(|p| p.status.error.as_deref()),
                Some("trakt mark failed"),
                "{write:?}"
            );
            assert!(!result.status.watched, "{write:?}");
        }
    }

    #[test]
    fn aggregates_batches_and_reads() {
        let tv = Item {
            media_type: MediaType::Tv,
            tmdb_id: 1399,
        };
        let results = run(dispatcher(vec![stub(ProviderId::Trakt)]).statuses(&[ITEM, tv]))
            .unwrap_or_else(|_| std::process::abort());
        assert_eq!(results.len(), 2, "two items");
        assert!(results.first().is_some_and(|r| r.status.watched), "watched");
        assert_eq!(
            results.first().and_then(|r| r.status.rating_stars),
            Some(4.0),
            "stars"
        );
        assert_eq!(
            results.get(1).map(|r| r.media_type),
            Some(MediaType::Tv),
            "tv"
        );

        let trakt = Stub {
            status: Ok(Status::of(false, None)),
            ..stub(ProviderId::Trakt)
        };
        let jellyfin = Stub {
            status: Ok(Status::of(true, None)),
            ..stub(ProviderId::Jellyfin)
        };
        let result = run(dispatcher(vec![trakt, jellyfin]).status(ITEM))
            .unwrap_or_else(|_| std::process::abort());
        assert!(result.status.watched, "any provider watched");
        assert_eq!(result.status.rating, None, "no rating");
        assert_eq!(result.providers.len(), 2, "both");

        let jellyfin = Stub {
            status: Ok(Status::of(false, None)),
            ..stub(ProviderId::Jellyfin)
        };
        let result = run(dispatcher(vec![stub(ProviderId::Trakt), jellyfin]).status(ITEM))
            .unwrap_or_else(|_| std::process::abort());
        assert_eq!(result.status.rating, Some(8.0), "first rating");
        assert_eq!(result.status.rating_stars, Some(4.0), "its stars");
    }

    #[test]
    fn rating_writes_skip_jellyfin() {
        let trakt = stub(ProviderId::Trakt);
        let jellyfin = stub(ProviderId::Jellyfin);
        let both = dispatcher(vec![trakt, jellyfin]);
        let result =
            run(both.write(ITEM, Write::Rate(5.0))).unwrap_or_else(|_| std::process::abort());
        assert_eq!(result.providers.len(), 1, "only Trakt");
        assert_eq!(
            result.providers.first().map(|p| p.provider),
            Some(ProviderId::Trakt),
            "Trakt"
        );
        let trakt = Stub {
            available: false,
            ..stub(ProviderId::Trakt)
        };
        let only_jellyfin = dispatcher(vec![trakt, stub(ProviderId::Jellyfin)]);
        let result = run(only_jellyfin.write(ITEM, Write::Rate(4.0)))
            .unwrap_or_else(|_| std::process::abort());
        assert!(result.providers.is_empty(), "nothing rates");
        assert_eq!(result.status.rating, None, "no rating");
        assert_eq!(
            result.outcome(),
            crate::mediaactions::types::Outcome::Failure,
            "failure"
        );
    }

    #[test]
    fn unmapped_items_are_not_mapped() {
        let results = vec![ProviderResult::thrown(
            ProviderId::Jellyfin,
            String::from(crate::mediaactions::jellyfin::NOT_MAPPED),
        )];
        let definitions = [(ProviderId::Jellyfin, WATCHED_ONLY)];
        let out = aggregate(ITEM, results, &definitions);
        assert_eq!(
            out.watched_action.reason,
            Some(Reason::NotMapped),
            "not mapped"
        );
        assert_eq!(
            out.rating_action.reason,
            Some(Reason::Unsupported),
            "unsupported"
        );
        let none = aggregate(ITEM, Vec::new(), &definitions);
        assert_eq!(
            none.watched_action.reason,
            Some(Reason::NoProvider),
            "no provider"
        );
    }
}
