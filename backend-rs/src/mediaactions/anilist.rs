//! `anilist.ts`: `AniList` list status and scores.
//!
//! Read from the warm sync snapshot and patched after each write. Also
//! the user client (`createAnilistUserClient`, `getAnilistUserContext`)
//! the episode actions share.

use std::sync::Arc;

use serde_json::Value;

use super::dispatcher::{Fut, MarkOptions, Provider, Thrown, Write};
use super::env::{stored_false, Env};
use super::score::{provider_to_score_raw, stars_to_provider};
use super::types::{Capabilities, Item, ProviderId, Status, FULL};
use crate::anilist::actions::{self, Save};
use crate::anilist::Anilist;
use crate::db::Bind;
use crate::mappinglayer::synccache::{self, AnilistEntry, AnilistPatch, AnilistSnapshot};

/// The error of a title the mapping layer can't place on `AniList`.
pub const NOT_MAPPED: &str = "No AniList mapping for item";

const NOT_CONFIGURED: &str = "AniList application credentials are not configured";
const NOT_LINKED: &str = "User has not linked an AniList account";
const EXPIRED: &str = "AniList authorization expired; reconnect your account";

/// Why there is no user client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientError {
    /// `AnilistNotConfiguredError`.
    NotConfigured,
    /// `AnilistNotLinkedError`, with its message.
    NotLinked(&'static str),
    /// Anything else (a database failure).
    Other(String),
}

impl ClientError {
    /// `error.message`.
    #[must_use]
    pub fn message(&self) -> String {
        match self {
            Self::NotConfigured => String::from(NOT_CONFIGURED),
            Self::NotLinked(message) => (*message).to_owned(),
            Self::Other(message) => message.clone(),
        }
    }
}

/// `getAnilistAppCredentials()` holds.
fn configured(env: &Env<'_>) -> bool {
    let set = |pointer: &str| {
        env.settings
            .get(pointer)
            .and_then(Value::as_str)
            .is_some_and(|s| !crate::jsval::trim(s).is_empty())
    };
    set("/anilist/clientId") && set("/anilist/clientSecret")
}

/// `isAnilistTokenExpired(expiresAt)`.
pub(crate) fn token_expired(value: Option<&str>) -> bool {
    let Some(text) = value.filter(|t| !t.is_empty()) else {
        return false;
    };
    let expires = crate::jsval::number_of_str(text);
    if !expires.is_finite() || expires <= 0.0 {
        return false;
    }
    expires <= (crate::jsnum::now() / 1000.0).floor() + 60.0
}

/// The linked row: settings id, trimmed token, expiry, account id.
async fn link_row(env: &Env<'_>) -> Result<Option<serde_json::Map<String, Value>>, ClientError> {
    env.user_settings(
        r#"CAST("id" AS BIGINT) AS "id", "anilistAccessToken", CAST("anilistTokenExpiresAt" AS TEXT) AS "expires", "anilistUserId""#,
    )
    .await
    .map_err(ClientError::Other)
}

/// `createAnilistUserClient(userId)`: an expired token is cleared on the
/// way.
///
/// # Errors
///
/// Not configured, not linked (or just expired), database failures.
pub async fn user_client(env: &Env<'_>) -> Result<Anilist, ClientError> {
    if !configured(env) {
        return Err(ClientError::NotConfigured);
    }
    let row = link_row(env).await?;
    let token = row
        .as_ref()
        .and_then(|r| r.get("anilistAccessToken"))
        .and_then(Value::as_str)
        .map(crate::jsval::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned);
    let (Some(row), Some(token)) = (row, token) else {
        return Err(ClientError::NotLinked(NOT_LINKED));
    };
    if token_expired(row.get("expires").and_then(Value::as_str)) {
        clear_expired_link(env.state, &row, env.user)
            .await
            .map_err(ClientError::Other)?;
        return Err(ClientError::NotLinked(EXPIRED));
    }
    Ok(Anilist::new(&env.state.outbound, Some(token)))
}

/// `createAnilistUserClient`'s answer to an expired token: the link
/// (`row` is its `user_settings` row, with `id`) is cleared.
///
/// # Errors
///
/// Database failures, as their message.
pub(crate) async fn clear_expired_link(
    state: &crate::state::AppState,
    row: &serde_json::Map<String, Value>,
    user: i64,
) -> Result<(), String> {
    tracing::info!(
        label = "AniList",
        user,
        "AniList token expired; clearing linked account"
    );
    let id = row.get("id").and_then(Value::as_i64).unwrap_or(0);
    state
        .db
        .execute(
            r#"UPDATE "user_settings" SET "anilistAccessToken" = NULL, "anilistTokenExpiresAt" = NULL, "anilistUsername" = NULL, "anilistUserId" = NULL WHERE "id" = ?1"#,
            &[Bind::Int(id)],
        )
        .await
        .map_err(|e| format!("{e:#}"))?;
    synccache::invalidate_user_anilist_sync_cache(user);
    Ok(())
}

/// `getAnilistUserContext(userId)`: the client and the account id.
///
/// # Errors
///
/// As [`user_client`], or not linked without an account id.
pub async fn user_context(env: &Env<'_>) -> Result<(Anilist, f64), Thrown> {
    let client = user_client(env).await.map_err(|e| e.message())?;
    let row = link_row(env).await.map_err(|e| e.message())?;
    let account = match row.as_ref().and_then(|r| r.get("anilistUserId")) {
        None => f64::NAN,
        value => crate::jsval::number_of(value),
    };
    if !account.is_finite() || account <= 0.0 {
        return Err(String::from(NOT_LINKED));
    }
    Ok((client, account))
}

/// The warm snapshot of the user's lists.
///
/// # Errors
///
/// `AniList` and database failures.
pub async fn warm(
    env: &Env<'_>,
    client: &Anilist,
    account: f64,
) -> Result<Arc<AnilistSnapshot>, Thrown> {
    synccache::warm_anilist(&env.ctx(), client, env.user, &crate::jsval::num(account)).await
}

/// `AnilistMediaActionProvider.isAvailable(userId)`.
///
/// # Errors
///
/// What `anilistAvailabilityFromError` rethrows.
pub async fn available(env: &Env<'_>) -> Result<bool, Thrown> {
    if env.provider_off("anilist") || !configured(env) {
        return Ok(false);
    }
    let row = env.user_settings(r#""mediaActionsAnilistEnabled""#).await?;
    if stored_false(row.as_ref(), "mediaActionsAnilistEnabled") {
        return Ok(false);
    }
    match user_client(env).await {
        Ok(_) => Ok(true),
        Err(ClientError::NotConfigured | ClientError::NotLinked(_)) => Ok(false),
        Err(ClientError::Other(e)) => Err(e),
    }
}

/// `resolveMappedItem(item)`: the `AniList` id.
async fn mapped(env: &Env<'_>, item: Item) -> Result<Option<i64>, Thrown> {
    crate::mappinglayer::ensure(&env.state.db)
        .await
        .map_err(|e| format!("{e:#}"))?;
    super::anilistmapping::anilist_id(&env.state.db, item.media_type, item.tmdb_id)
        .await
        .map_err(|e| format!("{e:#}"))
}

/// `saved?.id`.
fn saved_id(saved: Option<&Value>) -> Option<i64> {
    saved
        .and_then(|s| s.get("id"))
        .filter(|id| !id.is_null())
        .and_then(Value::as_i64)
}

/// `saved?.status`.
fn saved_status(saved: Option<&Value>) -> Option<String> {
    saved
        .and_then(|s| s.get("status"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// `{ watched, rating, entry }` of `lookupAnilistItemStatus`.
fn current(snapshot: &AnilistSnapshot, item: Item) -> (bool, Option<f64>, Option<AnilistEntry>) {
    let entry = synccache::lookup_anilist(snapshot, item.media_type, item.tmdb_id).cloned();
    let watched =
        synccache::is_anilist_watched_status(entry.as_ref().and_then(|e| e.status.as_deref()));
    let rating = entry.as_ref().and_then(|e| e.rating);
    (watched, rating, entry)
}

/// `AnilistMediaActionProvider`.
#[derive(Debug)]
pub struct AnilistProvider<'a> {
    env: &'a Env<'a>,
}

impl<'a> AnilistProvider<'a> {
    /// For one request.
    #[must_use]
    pub const fn new(env: &'a Env<'a>) -> Self {
        Self { env }
    }

    async fn read(&self, item: Item) -> Result<Status, Thrown> {
        if mapped(self.env, item).await?.is_none() {
            return Ok(Status::failed(NOT_MAPPED));
        }
        let (client, account) = user_context(self.env).await?;
        let snapshot = warm(self.env, &client, account).await?;
        let (watched, rating, _) = current(&snapshot, item);
        Ok(Status::of(watched, rating))
    }

    async fn read_many(&self, items: &[Item]) -> Result<Vec<(Item, Status)>, Thrown> {
        if items.is_empty() {
            return Ok(Vec::new());
        }
        let (client, account) = user_context(self.env).await?;
        let snapshot = warm(self.env, &client, account).await?;
        crate::mappinglayer::ensure(&self.env.state.db)
            .await
            .map_err(|e| format!("{e:#}"))?;
        let mut out = Vec::new();
        for item in items {
            let id = super::anilistmapping::anilist_id(
                &self.env.state.db,
                item.media_type,
                item.tmdb_id,
            )
            .await
            .map_err(|e| format!("{e:#}"))?;
            if id.is_none() {
                out.push((*item, Status::failed(NOT_MAPPED)));
                continue;
            }
            let (watched, rating, _) = current(&snapshot, *item);
            out.push((*item, Status::of(watched, rating)));
        }
        Ok(out)
    }

    async fn mark(&self, item: Item, options: MarkOptions) -> Result<Status, Thrown> {
        let Some(anilist_id) = mapped(self.env, item).await? else {
            return Ok(Status::failed(NOT_MAPPED));
        };
        let (client, account) = user_context(self.env).await?;
        let snapshot = warm(self.env, &client, account).await?;
        let (_, rating_now, entry) = current(&snapshot, item);
        let rating = options.rating_stars.map(stars_to_provider).transpose()?;
        let save = Save {
            media_id: anilist_id,
            status: Some("COMPLETED"),
            score_raw: rating.map(provider_to_score_raw),
            progress: None,
        };
        let saved = actions::save_media_list_entry(&client, &save)
            .await
            .map_err(|e| e.message())?;
        synccache::patch_anilist(
            self.env.user,
            item.media_type,
            item.tmdb_id,
            AnilistPatch {
                watched: Some(true),
                status: Some(Some(String::from("COMPLETED"))),
                anilist_id: Some(anilist_id),
                list_entry_id: Some(
                    saved_id(saved.as_ref()).or_else(|| entry.and_then(|e| e.list_entry_id)),
                ),
                rating: rating.map(Some),
                ..AnilistPatch::default()
            },
        );
        Ok(Status::of(true, rating.or(rating_now)))
    }

    async fn unmark(&self, item: Item, remove_rating: bool) -> Result<Status, Thrown> {
        let Some(anilist_id) = mapped(self.env, item).await? else {
            return Ok(Status::failed(NOT_MAPPED));
        };
        let (client, account) = user_context(self.env).await?;
        let snapshot = warm(self.env, &client, account).await?;
        let (_, rating_now, entry) = current(&snapshot, item);
        let entry_id = entry.and_then(|e| e.list_entry_id).filter(|id| *id != 0);
        let mut saved = None;
        if let Some(entry_id) = entry_id {
            if remove_rating {
                actions::delete_media_list_entry(&client, entry_id)
                    .await
                    .map_err(|e| e.message())?;
            } else {
                // AniList keeps watched state in the list status: back to
                // planning, keeping the score and the entry.
                let save = Save {
                    media_id: anilist_id,
                    status: Some("PLANNING"),
                    score_raw: rating_now.map(provider_to_score_raw),
                    progress: None,
                };
                saved = actions::save_media_list_entry(&client, &save)
                    .await
                    .map_err(|e| e.message())?;
            }
        }
        let rating = if remove_rating { None } else { rating_now };
        let status = saved_status(saved.as_ref())
            .or_else(|| (!remove_rating).then(|| String::from("PLANNING")));
        synccache::patch_anilist(
            self.env.user,
            item.media_type,
            item.tmdb_id,
            AnilistPatch {
                watched: Some(false),
                status: Some(status),
                rating: Some(rating),
                anilist_id: Some(anilist_id),
                list_entry_id: Some(saved_id(saved.as_ref()).or(entry_id)),
                ..AnilistPatch::default()
            },
        );
        Ok(Status::of(false, rating))
    }

    async fn rate(&self, item: Item, stars: f64) -> Result<Status, Thrown> {
        let Some(anilist_id) = mapped(self.env, item).await? else {
            return Ok(Status::failed(NOT_MAPPED));
        };
        let (client, account) = user_context(self.env).await?;
        let snapshot = warm(self.env, &client, account).await?;
        let (watched, _, entry) = current(&snapshot, item);
        let rating = stars_to_provider(stars)?;
        let save = Save {
            media_id: anilist_id,
            status: entry.is_none().then_some("PLANNING"),
            score_raw: Some(provider_to_score_raw(rating)),
            progress: None,
        };
        let saved = actions::save_media_list_entry(&client, &save)
            .await
            .map_err(|e| e.message())?;
        let status = saved_status(saved.as_ref())
            .or_else(|| entry.as_ref().and_then(|e| e.status.clone()))
            .unwrap_or_else(|| String::from("PLANNING"));
        synccache::patch_anilist(
            self.env.user,
            item.media_type,
            item.tmdb_id,
            AnilistPatch {
                watched: Some(watched),
                status: Some(Some(status)),
                rating: Some(Some(rating)),
                anilist_id: Some(anilist_id),
                list_entry_id: Some(
                    saved_id(saved.as_ref()).or_else(|| entry.and_then(|e| e.list_entry_id)),
                ),
                ..AnilistPatch::default()
            },
        );
        Ok(Status::of(watched, Some(rating)))
    }
}

impl Provider for AnilistProvider<'_> {
    fn id(&self) -> ProviderId {
        ProviderId::Anilist
    }

    fn capabilities(&self) -> Capabilities {
        FULL
    }

    fn is_available(&self) -> Fut<'_, Result<bool, Thrown>> {
        Box::pin(available(self.env))
    }

    fn status(&self, item: Item) -> Fut<'_, Result<Status, Thrown>> {
        Box::pin(self.read(item))
    }

    fn statuses<'b>(&'b self, items: &'b [Item]) -> Fut<'b, Result<Vec<(Item, Status)>, Thrown>> {
        Box::pin(self.read_many(items))
    }

    fn write(&self, item: Item, write: Write) -> Fut<'_, Result<Status, Thrown>> {
        Box::pin(async move {
            match write {
                Write::Mark(options) => self.mark(item, options).await,
                Write::Unmark { remove_rating } => self.unmark(item, remove_rating).await,
                Write::Rate(stars) => self.rate(item, stars).await,
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mappinglayer::MediaType;

    #[test]
    fn expiry() {
        assert!(token_expired(Some("100")), "long past");
        assert!(!token_expired(Some("")), "empty");
        assert!(!token_expired(Some("x")), "not a number");
        assert!(!token_expired(None), "none");
        assert!(!token_expired(Some("99999999999")), "far future");
    }

    #[test]
    fn reads_completed_entries_with_scores() {
        let snapshot = AnilistSnapshot {
            entries: vec![AnilistEntry {
                anilist_id: 164,
                list_entry_id: Some(99),
                tmdb_id: 128,
                media_type: MediaType::Movie,
                status: Some(String::from("COMPLETED")),
                rating: Some(8.0),
                progress: None,
                episode_count: None,
            }],
            fetched_at: 0.0,
        };
        let movie = Item {
            media_type: MediaType::Movie,
            tmdb_id: 128,
        };
        let (watched, rating, entry) = current(&snapshot, movie);
        let status = Status::of(watched, rating);
        assert!(status.watched, "completed is watched");
        assert_eq!(status.rating, Some(8.0), "score");
        assert_eq!(status.rating_stars, Some(4.0), "stars");
        assert_eq!(entry.and_then(|e| e.list_entry_id), Some(99), "entry");
    }
}
