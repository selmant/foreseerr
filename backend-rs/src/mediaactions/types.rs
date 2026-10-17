//! `types.ts`, `writeOutcome.ts` and `episodeWrite.ts`: the shapes the
//! routes print and how a write's outcome is judged.

use serde_json::{Map, Value};

use crate::mappinglayer::MediaType;

/// `MediaActionProviderId`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProviderId {
    /// Trakt.
    Trakt,
    /// The media server.
    Jellyfin,
    /// `AniList`.
    Anilist,
    /// Simkl.
    Simkl,
}

impl ProviderId {
    /// The id the API prints.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Trakt => "trakt",
            Self::Jellyfin => "jellyfin",
            Self::Anilist => "anilist",
            Self::Simkl => "simkl",
        }
    }
}

/// `MediaActionOperationCapabilities`. Every provider reads what it
/// writes, so one flag stands for the read and the write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capabilities {
    /// `readWatched` and `writeWatched`.
    pub watched: bool,
    /// `readRating` and `writeRating`.
    pub rating: bool,
}

/// Every operation (Trakt, `AniList`, Simkl).
pub const FULL: Capabilities = Capabilities {
    watched: true,
    rating: true,
};

/// `JELLYFIN_MEDIA_ACTION_CAPABILITIES`: no ratings.
pub const WATCHED_ONLY: Capabilities = Capabilities {
    watched: true,
    rating: false,
};

/// `MediaActionOperationCapability`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Capability {
    /// `writeWatched`.
    WriteWatched,
    /// `writeRating`.
    WriteRating,
}

impl Capabilities {
    /// `capabilities[capability]`.
    #[must_use]
    pub const fn has(self, capability: Capability) -> bool {
        match capability {
            Capability::WriteWatched => self.watched,
            Capability::WriteRating => self.rating,
        }
    }

    /// `supportsRead`.
    #[must_use]
    pub const fn reads(self) -> bool {
        self.watched || self.rating
    }

    /// The capability object the API prints.
    #[must_use]
    pub fn to_json(self) -> Value {
        let mut out = Map::new();
        out.insert(String::from("readWatched"), Value::Bool(self.watched));
        out.insert(String::from("writeWatched"), Value::Bool(self.watched));
        out.insert(String::from("readRating"), Value::Bool(self.rating));
        out.insert(String::from("writeRating"), Value::Bool(self.rating));
        Value::Object(out)
    }
}

/// `MediaItemRef`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Item {
    /// `movie` or `tv`.
    pub media_type: MediaType,
    /// The TMDB id.
    pub tmdb_id: i64,
}

impl Item {
    /// `${mediaType}:${tmdbId}`.
    #[must_use]
    pub fn key(self) -> String {
        format!("{}:{}", self.media_type.as_str(), self.tmdb_id)
    }
}

/// `MediaActionStatus`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Status {
    /// `watched`.
    pub watched: bool,
    /// The provider's 1–10 score.
    pub rating: Option<f64>,
    /// Half-stars.
    pub rating_stars: Option<f64>,
    /// A read failure for this provider and item.
    pub error: Option<String>,
}

impl Status {
    /// `toStatus(watched, rating)`.
    #[must_use]
    pub fn of(watched: bool, rating: Option<f64>) -> Self {
        Self {
            watched,
            rating,
            rating_stars: rating.map(super::score::provider_to_stars),
            error: None,
        }
    }

    /// `{ ...emptyStatus(), error }`.
    #[must_use]
    pub fn failed(error: &str) -> Self {
        Self {
            error: Some(error.to_owned()),
            ..Self::default()
        }
    }

    /// `withStars`.
    #[must_use]
    pub fn with_stars(self) -> Self {
        Self {
            rating_stars: self
                .rating_stars
                .or_else(|| self.rating.map(super::score::provider_to_stars)),
            error: self.error.filter(|e| !e.is_empty()),
            ..self
        }
    }
}

/// `MediaActionProviderResult`.
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderResult {
    /// Which provider.
    pub provider: ProviderId,
    /// Whether it succeeded.
    pub ok: bool,
    /// What it reported.
    pub status: Status,
}

impl ProviderResult {
    /// `{ provider, ok: !status.error, ...withStars(status) }`.
    #[must_use]
    pub fn from_status(provider: ProviderId, status: Status) -> Self {
        let status = status.with_stars();
        Self {
            provider,
            ok: status.error.is_none(),
            status,
        }
    }

    /// A thrown error: `{ provider, ok: false, ...emptyStatus(), error }`.
    #[must_use]
    pub fn thrown(provider: ProviderId, error: String) -> Self {
        Self {
            provider,
            ok: false,
            status: Status {
                error: Some(error),
                ..Status::default()
            },
        }
    }

    /// The object `toResponse` prints per provider.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert(
            String::from("provider"),
            Value::from(self.provider.as_str()),
        );
        out.insert(String::from("ok"), Value::Bool(self.ok));
        out.insert(String::from("watched"), Value::Bool(self.status.watched));
        out.insert(String::from("rating"), number(self.status.rating));
        out.insert(
            String::from("ratingStars"),
            number(self.status.rating_stars),
        );
        if let Some(error) = &self.status.error {
            out.insert(String::from("error"), Value::from(error.as_str()));
        }
        Value::Object(out)
    }
}

fn number(n: Option<f64>) -> Value {
    n.map_or(Value::Null, crate::jsval::num)
}

/// `MediaActionUnavailableReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    /// `no_provider`.
    NoProvider,
    /// `not_mapped`.
    NotMapped,
    /// `provider_error`.
    ProviderError,
    /// `unsupported`.
    Unsupported,
}

impl Reason {
    const fn as_str(self) -> &'static str {
        match self {
            Self::NoProvider => "no_provider",
            Self::NotMapped => "not_mapped",
            Self::ProviderError => "provider_error",
            Self::Unsupported => "unsupported",
        }
    }
}

/// `MediaActionOperationAvailability`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Availability {
    /// `available`.
    pub available: bool,
    /// `reason`, when there is one.
    pub reason: Option<Reason>,
}

impl Availability {
    fn to_json(self) -> Value {
        let mut out = Map::new();
        out.insert(String::from("available"), Value::Bool(self.available));
        if let Some(reason) = self.reason {
            out.insert(String::from("reason"), Value::from(reason.as_str()));
        }
        Value::Object(out)
    }
}

/// `MediaActionWriteOutcome`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Every attempted provider succeeded.
    Success,
    /// Some did.
    Partial,
    /// None did, or none ran.
    Failure,
}

impl Outcome {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Partial => "partial",
            Self::Failure => "failure",
        }
    }

    /// `writeHttpStatus`.
    #[must_use]
    pub const fn http_status(self) -> u16 {
        match self {
            Self::Success => 200,
            Self::Partial => 207,
            Self::Failure => 502,
        }
    }
}

/// `MediaActionAggregate`.
#[derive(Debug, Clone, PartialEq)]
pub struct Aggregate {
    /// The TMDB id the route echoes.
    pub tmdb_id: i64,
    /// `movie` or `tv`.
    pub media_type: MediaType,
    /// `watched`, `rating` and `ratingStars`.
    pub status: Status,
    /// Per provider.
    pub providers: Vec<ProviderResult>,
    /// `actions.watched`.
    pub watched_action: Availability,
    /// `actions.rating`.
    pub rating_action: Availability,
}

impl Aggregate {
    /// `classifyWriteOutcome`.
    #[must_use]
    pub fn outcome(&self) -> Outcome {
        let ok = self.providers.iter().filter(|p| p.ok).count();
        if self.providers.is_empty() || ok == 0 {
            Outcome::Failure
        } else if ok < self.providers.len() {
            Outcome::Partial
        } else {
            Outcome::Success
        }
    }

    /// `toResponse(result, includeOutcome)`.
    #[must_use]
    pub fn to_json(&self, outcome: Option<Outcome>) -> Value {
        let mut out = Map::new();
        out.insert(String::from("tmdbId"), Value::from(self.tmdb_id));
        out.insert(
            String::from("mediaType"),
            Value::from(self.media_type.as_str()),
        );
        out.insert(String::from("watched"), Value::Bool(self.status.watched));
        out.insert(String::from("rating"), number(self.status.rating));
        out.insert(
            String::from("ratingStars"),
            number(self.status.rating_stars),
        );
        let mut actions = Map::new();
        actions.insert(String::from("watched"), self.watched_action.to_json());
        actions.insert(String::from("rating"), self.rating_action.to_json());
        out.insert(String::from("actions"), Value::Object(actions));
        out.insert(
            String::from("providers"),
            Value::Array(self.providers.iter().map(ProviderResult::to_json).collect()),
        );
        if let Some(outcome) = outcome {
            out.insert(String::from("outcome"), Value::from(outcome.as_str()));
        }
        Value::Object(out)
    }
}

/// An episode write's result: done, refused, or not this provider's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EpisodeWrite {
    /// `true` / `false`.
    Done(bool),
    /// `'skipped'`.
    Skipped,
}

/// `episodeWriteResult(provider, watched, write)`.
#[must_use]
pub fn episode_write_result(
    provider: ProviderId,
    watched: bool,
    write: Result<EpisodeWrite, String>,
) -> Option<ProviderResult> {
    match write {
        Ok(EpisodeWrite::Skipped) => None,
        Ok(EpisodeWrite::Done(ok)) => Some(ProviderResult {
            provider,
            ok,
            status: Status {
                watched: if ok { watched } else { !watched },
                error: (!ok).then(|| format!("{} episode update was rejected", provider.as_str())),
                ..Status::default()
            },
        }),
        Err(error) => Some(ProviderResult {
            provider,
            ok: false,
            status: Status {
                watched: !watched,
                error: Some(error),
                ..Status::default()
            },
        }),
    }
}

/// `episodeWriteAggregate(tmdbId, watched, providers)`.
#[must_use]
pub fn episode_write_aggregate(
    tmdb_id: i64,
    watched: bool,
    providers: Vec<ProviderResult>,
) -> Aggregate {
    let succeeded = providers.iter().any(|p| p.ok);
    let watched_action = if succeeded {
        Availability {
            available: true,
            reason: None,
        }
    } else {
        Availability {
            available: false,
            reason: Some(if providers.is_empty() {
                Reason::NoProvider
            } else {
                Reason::ProviderError
            }),
        }
    };
    Aggregate {
        tmdb_id,
        media_type: MediaType::Tv,
        status: Status {
            watched,
            ..Status::default()
        },
        providers,
        watched_action,
        rating_action: Availability {
            available: false,
            reason: Some(Reason::Unsupported),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(provider: ProviderId, ok: bool, error: Option<&str>) -> ProviderResult {
        ProviderResult {
            provider,
            ok,
            status: Status {
                watched: ok,
                error: error.map(str::to_owned),
                ..Status::default()
            },
        }
    }

    fn aggregate(providers: Vec<ProviderResult>) -> Aggregate {
        let available = providers.iter().any(|p| p.ok);
        Aggregate {
            tmdb_id: 550,
            media_type: MediaType::Movie,
            status: Status::default(),
            providers,
            watched_action: Availability {
                available,
                reason: None,
            },
            rating_action: Availability {
                available: false,
                reason: Some(Reason::Unsupported),
            },
        }
    }

    #[test]
    fn classifies_write_outcomes() {
        let none = aggregate(Vec::new());
        assert_eq!(none.outcome(), Outcome::Failure, "no providers ran");
        assert_eq!(Outcome::Failure.http_status(), 502, "failure status");
        let rejected = aggregate(vec![result(ProviderId::Trakt, false, Some("mark failed"))]);
        assert_eq!(
            rejected.outcome(),
            Outcome::Failure,
            "every provider rejects"
        );
        let ok = aggregate(vec![result(ProviderId::Trakt, true, None)]);
        assert_eq!(ok.outcome(), Outcome::Success, "every provider succeeds");
        assert_eq!(Outcome::Success.http_status(), 200, "success status");
        let partial = aggregate(vec![
            result(ProviderId::Trakt, true, None),
            result(ProviderId::Jellyfin, false, Some("downstream failed")),
        ]);
        assert_eq!(partial.outcome(), Outcome::Partial, "some succeed");
        assert_eq!(Outcome::Partial.http_status(), 207, "partial status");
    }

    #[test]
    fn episode_results() {
        assert_eq!(
            episode_write_result(ProviderId::Trakt, true, Ok(EpisodeWrite::Skipped)),
            None,
            "skipped"
        );
        let rejected =
            episode_write_result(ProviderId::Anilist, true, Ok(EpisodeWrite::Done(false)));
        assert_eq!(
            rejected.map(|r| r.to_json()),
            Some(serde_json::json!({
                "provider": "anilist", "ok": false, "watched": false, "rating": null,
                "ratingStars": null, "error": "anilist episode update was rejected"
            })),
            "rejected"
        );
        let empty = episode_write_aggregate(5, false, Vec::new());
        assert_eq!(
            empty.to_json(Some(empty.outcome())),
            serde_json::json!({
                "tmdbId": 5, "mediaType": "tv", "watched": false, "rating": null,
                "ratingStars": null,
                "actions": {
                    "watched": {"available": false, "reason": "no_provider"},
                    "rating": {"available": false, "reason": "unsupported"}
                },
                "providers": [], "outcome": "failure"
            }),
            "no provider"
        );
    }
}
