//! The rows a request or issue page points at: media with the download
//! tracker, and users, loaded once per page.

use std::collections::HashMap;

use serde_json::Value;

use super::Ready;
use crate::db::{MediaRow, UserRecord};
use crate::downloads::Downloads;
use crate::media::{media_json, tracks_downloads};
use crate::user::{embedded_json, filtered_json};

/// The media rows, users and download tracker a page refers to.
pub(super) struct Related {
    /// Media rows by id.
    pub(super) media: HashMap<i64, MediaRow>,
    users: HashMap<i64, UserRecord>,
    downloads: Downloads,
}

impl Related {
    /// Load these media rows (with their seasons when asked, as the `find`
    /// path does) and users; the tracker only when a media row needs it.
    pub(super) async fn load(
        ctx: &Ready<'_>,
        media_ids: &[i64],
        user_ids: &[i64],
        with_seasons: bool,
    ) -> Result<Self, String> {
        let mut media_ids = media_ids.to_vec();
        media_ids.sort_unstable();
        media_ids.dedup();
        let media = ctx
            .state
            .db
            .media_by_ids(&media_ids, with_seasons)
            .await
            .map_err(|e| format!("loading the related media failed: {e:#}"))?;
        let downloads = if media.iter().any(tracks_downloads) {
            Downloads::current()
        } else {
            Downloads::default()
        };
        let mut users = HashMap::new();
        for id in user_ids.iter().copied() {
            if users.contains_key(&id) {
                continue;
            }
            match ctx.state.db.user_record(id).await {
                Ok(Some((record, _settings))) => {
                    users.insert(id, record);
                }
                Ok(None) => {}
                Err(e) => return Err(format!("loading user {id} failed: {e:#}")),
            }
        }
        Ok(Self {
            media: media.into_iter().map(|m| (m.id, m)).collect(),
            users,
            downloads,
        })
    }

    /// The tracker snapshot this page was built with.
    pub(super) const fn downloads(&self) -> &Downloads {
        &self.downloads
    }

    /// A media relation, or null when unset or the row is gone.
    pub(super) fn media_json(&self, ctx: &Ready<'_>, id: Option<i64>, with_seasons: bool) -> Value {
        id.and_then(|id| self.media.get(&id))
            .map_or(Value::Null, |m| {
                media_json(m, &ctx.settings, &self.downloads, with_seasons)
            })
    }

    /// A user relation as it serializes nested in another entity
    /// (`User.toJSON`): null when unset or the row is gone, never with its
    /// eager `settings` (GHSA-8j73-j6rc-q8xh).
    pub(super) fn user_json(&self, id: Option<i64>) -> Result<Value, String> {
        id.and_then(|id| self.users.get(&id))
            .map_or(Ok(Value::Null), |user| {
                embedded_json(user).map_err(str::to_owned)
            })
    }

    /// A user relation passed through `User.filter()`: also without the
    /// email and Plex id, for viewers who aren't owed them.
    pub(super) fn public_user_json(&self, id: Option<i64>) -> Result<Value, String> {
        id.and_then(|id| self.users.get(&id))
            .map_or(Ok(Value::Null), |user| {
                filtered_json(user, None, false).map_err(str::to_owned)
            })
    }
}
