//! The rows a request or issue page points at: media with the download
//! tracker, and users, loaded once per page.

use std::collections::HashMap;

use serde_json::Value;

use super::Ready;
use crate::db::{MediaRow, UserRecord, UserSettingsRecord};
use crate::downloads::Downloads;
use crate::media::{media_json, tracks_downloads};
use crate::user::filtered_json;

/// The media rows, users and download tracker a page refers to.
pub(super) struct Related {
    /// Media rows by id.
    pub(super) media: HashMap<i64, MediaRow>,
    users: HashMap<i64, (UserRecord, Option<UserSettingsRecord>)>,
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
            Downloads::fetch(
                &ctx.state.internal,
                &ctx.state.env.node_url,
                ctx.settings.api_key(),
            )
            .await
            .map_err(|e| format!("reading the download tracker failed: {e:#}"))?
        } else {
            Downloads::default()
        };
        let mut users = HashMap::new();
        for id in user_ids.iter().copied() {
            if users.contains_key(&id) {
                continue;
            }
            match ctx.state.db.user_record(id).await {
                Ok(Some(record)) => {
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

    /// A user relation: null when unset or the row is gone; with its
    /// `settings` relation when `with_settings` (the `find` path loads it).
    pub(super) fn user_json(&self, id: Option<i64>, with_settings: bool) -> Result<Value, String> {
        let Some((user, settings)) = id.and_then(|id| self.users.get(&id)) else {
            return Ok(Value::Null);
        };
        let settings = with_settings.then_some(settings.as_ref());
        filtered_json(user, settings, true).map_err(str::to_owned)
    }
}
