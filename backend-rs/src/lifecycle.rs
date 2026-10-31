//! What happens around a `MediaRequest` save in Node.
//!
//! That is the entity's own listeners (`notifyNewRequest`, `notifyApprovedOrDeclined`), the
//! request subscriber (`sendToRadarr`, `sendToSonarr`,
//! `updateParentStatus`, the availability notifications) and the request
//! notifications they send.
//!
//! The entity is passed by `&mut` through the chain because Node shares
//! one object: a nested save (marking a request `FAILED` or `COMPLETED`)
//! changes what the outer steps and the route's answer see.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use anyhow::{Context, Result};
use serde_json::Value;

use crate::arr::{Arr, MovieOptions, SeriesOptions};
use crate::db::{Bind, Db, MediaRow, RequestRow, UserRecord, UserSettingsRecord};
use crate::dbtx::Exec;
use crate::jobs::syncutil::Tx;
use crate::media::js_string;
use crate::notify::{self, Kind, Payload, Person, RequestInfo};
use crate::settings::public::truthy;
use crate::settings::Settings;
use crate::state::AppState;

/// `MediaRequestStatus`.
pub const PENDING: i64 = 1;
/// `APPROVED`.
pub const APPROVED: i64 = 2;
/// `DECLINED`.
pub const DECLINED: i64 = 3;
/// `FAILED`.
pub const FAILED: i64 = 4;
/// `COMPLETED`.
pub const COMPLETED: i64 = 5;

/// `MediaStatus`.
const M_UNKNOWN: i64 = 1;
const M_PENDING: i64 = 2;
const M_PROCESSING: i64 = 3;
const M_PARTIAL: i64 = 4;
const M_AVAILABLE: i64 = 5;
const M_DELETED: i64 = 7;

type Boxed<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Shared state and the settings in force.
#[derive(Debug, Clone)]
pub struct Lc {
    /// Database and clients.
    pub state: Arc<AppState>,
    /// settings.json.
    pub settings: Arc<Settings>,
}

/// A user relation as loaded.
pub type UserRel = (UserRecord, Option<UserSettingsRecord>);

/// The in-memory `MediaRequest` with the relations the hooks read.
#[derive(Debug, Clone)]
pub struct Entity {
    /// The row with its seasons and episodes.
    pub row: RequestRow,
    /// The eager `media` relation, as loaded with the request.
    pub media: Option<MediaRow>,
    /// `requestedBy`.
    pub requested_by: Option<UserRel>,
    /// `modifiedBy`.
    pub modified_by: Option<UserRel>,
}

impl Entity {
    fn person((u, s): &UserRel) -> Person {
        Person::from_records(u, s.as_ref())
    }

    fn info(&self) -> RequestInfo {
        RequestInfo {
            id: self.row.id,
            is4k: self.row.is4k,
            requested_by: self
                .requested_by
                .as_ref()
                .map(Self::person)
                .unwrap_or_default(),
            modified_by: self.modified_by.as_ref().map(Self::person),
        }
    }

    const fn key_4k(&self) -> bool {
        self.row.is4k
    }
}

/// Which media status column a request drives.
const fn status_of(media: &MediaRow, four_k: bool) -> i64 {
    if four_k {
        media.status4k
    } else {
        media.status
    }
}

impl Lc {
    /// Load a request with the relations a `find` with eager relations
    /// gives.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn load(&self, id: i64) -> Result<Option<Entity>> {
        let db = &self.state.db;
        let Some(row) = db.request_by_id(id).await? else {
            return Ok(None);
        };
        let media = match row.media_id {
            Some(media_id) => db.media_by_ids(&[media_id], true).await?.pop(),
            None => None,
        };
        let requested_by = match row.requested_by_id {
            Some(uid) => db.user_record(uid).await?,
            None => None,
        };
        let modified_by = match row.modified_by_id {
            Some(uid) => db.user_record(uid).await?,
            None => None,
        };
        Ok(Some(Entity {
            row,
            media,
            requested_by,
            modified_by,
        }))
    }

    fn main_locale(&self) -> String {
        let locale = self.settings.str("/main/locale");
        if locale.is_empty() {
            String::from("en")
        } else {
            locale.to_owned()
        }
    }

    /// `requestRepository.save(entity)` for an existing request: writes
    /// what changed (the row and its cascaded seasons and episodes) and,
    /// when the row itself changed, runs the update hooks.
    pub fn save<'a>(&'a self, e: &'a mut Entity) -> Boxed<'a, Result<()>> {
        Box::pin(async move {
            let changed = self.write(e, true).await?;
            if changed {
                self.after_update(e).await;
            }
            Ok(())
        })
    }

    /// The writes of a save ([`write_request`]); whether the request row
    /// changed.
    async fn write(&self, e: &mut Entity, with_row: bool) -> Result<bool> {
        write_request(&self.state.db, e, with_row).await
    }

    /// `@AfterUpdate` listener, then the subscriber's `afterUpdate`.
    pub async fn after_update(&self, e: &mut Entity) {
        self.notify_approved_or_declined(e, false);
        if let Err(err) = self.send_to_radarr(e).await {
            tracing::error!("Error while sending to *arr in afterUpdate subscriber: {err:#}");
        }
        if let Err(err) = self.send_to_sonarr(e).await {
            tracing::error!("Error while sending to *arr in afterUpdate subscriber: {err:#}");
        }
        match self.update_parent_status(e).await {
            Ok(()) => {
                if e.row.status == COMPLETED {
                    let tv = e.media.as_ref().is_some_and(|m| m.media_type == "tv");
                    let result = if tv {
                        self.notify_available_series(e).await
                    } else {
                        self.notify_available_movie(e).await
                    };
                    if let Err(err) = result {
                        tracing::error!(
                            "Something went wrong sending media notification(s): {err:#}"
                        );
                    }
                }
            }
            Err(err) => tracing::error!(
                "Error while updating parent status in afterUpdate subscriber: {err:#}"
            ),
        }
    }

    /// What follows the insert of a new request: the entity's
    /// `@AfterInsert` listeners (`notifyNewRequest`,
    /// `autoapprovalNotification`), then the subscriber's `afterInsert`
    /// (`sendToRadarr`, `sendToSonarr`, `updateParentStatus`). A nested
    /// save (`COMPLETED`, `FAILED`) runs the update hooks as usual.
    pub async fn after_insert(&self, e: &mut Entity) {
        if e.row.status == PENDING {
            if let Some(media) = e.media.clone() {
                self.send_request_notification(e, media.clone(), Kind::MediaPending);
                if e.row.is_auto_request {
                    self.send_request_notification(e, media, Kind::MediaAutoRequested);
                }
            } else {
                tracing::error!("Media data not found");
            }
        }
        if e.row.status == APPROVED {
            self.notify_approved_or_declined(e, true);
        }
        let mut sent = self.send_to_radarr(e).await;
        if sent.is_ok() {
            sent = self.send_to_sonarr(e).await;
        }
        if let Err(err) = sent {
            tracing::error!("Error while sending to *arr in afterInsert subscriber: {err:#}");
        }
        if let Err(err) = self.update_parent_status(e).await {
            tracing::error!(
                "Error while updating parent status in afterInsert subscriber: {err:#}"
            );
        }
    }

    /// `notifyApprovedOrDeclined`.
    fn notify_approved_or_declined(&self, e: &Entity, auto_approved: bool) {
        if e.row.status != APPROVED && e.row.status != DECLINED {
            return;
        }
        let Some(media) = e.media.clone() else {
            tracing::error!("Media data not found");
            return;
        };
        if e.row.status == APPROVED && status_of(&media, e.key_4k()) == M_AVAILABLE {
            self.send_request_notification(e, media, Kind::MediaAvailable);
            return;
        }
        let kind = match (e.row.status, auto_approved) {
            (APPROVED, true) => Kind::MediaAutoApproved,
            (APPROVED, false) => Kind::MediaApproved,
            _ => Kind::MediaDeclined,
        };
        self.send_request_notification(e, media.clone(), kind);
        if e.row.status == APPROVED && auto_approved && e.row.is_auto_request {
            self.send_request_notification(e, media, Kind::MediaAutoRequested);
        }
    }

    /// `MediaRequest.sendNotification`: in the background, as Node does not
    /// await it.
    pub fn send_request_notification(&self, e: &Entity, media: MediaRow, kind: Kind) {
        let lc = self.clone();
        let e = e.clone();
        tokio::spawn(async move {
            if let Err(err) = lc.request_notification(&e, media, kind).await {
                tracing::error!("Something went wrong sending media notification(s): {err:#}");
            }
        });
    }

    async fn request_notification(&self, e: &Entity, media: MediaRow, kind: Kind) -> Result<()> {
        let four = if e.row.is4k { "4K " } else { "" };
        let media_type = if e.row.request_type == "movie" {
            "Movie"
        } else {
            "Series"
        };
        let (event, notify_admin, notify_system) = match kind {
            Kind::MediaAvailable => (
                Some(format!("{four}{media_type} Now Available")),
                false,
                true,
            ),
            Kind::MediaApproved => (
                Some(format!("{four}{media_type} Request Approved")),
                false,
                true,
            ),
            Kind::MediaDeclined => (
                Some(format!("{four}{media_type} Request Declined")),
                false,
                true,
            ),
            Kind::MediaPending => (Some(format!("New {four}{media_type} Request")), true, true),
            Kind::MediaAutoRequested => (
                Some(format!(
                    "{four}{media_type} Request Automatically Submitted"
                )),
                false,
                false,
            ),
            Kind::MediaAutoApproved => (
                Some(format!("{four}{media_type} Request Automatically Approved")),
                true,
                true,
            ),
            Kind::MediaFailed => (
                Some(format!("{four}{media_type} Request Failed")),
                true,
                true,
            ),
            Kind::Test
            | Kind::IssueCreated
            | Kind::IssueComment
            | Kind::IssueResolved
            | Kind::IssueReopened
            | Kind::NewSeason
            | Kind::ReleaseDateChanged => (None, true, true),
        };
        let info = e.info();
        let notify_user = if notify_admin {
            None
        } else {
            Some(info.requested_by.clone())
        };
        let mut payload = Payload {
            event,
            notify_admin,
            notify_system,
            notify_user,
            request: Some(info),
            ..Payload::default()
        };
        if e.row.request_type == "movie" {
            let movie = self
                .state
                .tmdb
                .movie(media.tmdb_id, &self.main_locale())
                .await?;
            fill_title(&mut payload, &movie, "title", "release_date");
        } else if e.row.request_type == "tv" {
            let tv = self
                .state
                .tmdb
                .tv(media.tmdb_id, &self.main_locale())
                .await?;
            fill_title(&mut payload, &tv, "name", "first_air_date");
            payload.extra = vec![requested_extra(&e.row)];
        } else {
            return Ok(());
        }
        payload.media = Some(media);
        notify::send(
            Arc::clone(&self.state),
            Arc::clone(&self.settings),
            kind,
            payload,
        );
        Ok(())
    }

    /// `notifyAvailableMovie`.
    async fn notify_available_movie(&self, e: &Entity) -> Result<()> {
        let Some(media_id) = e.row.media_id else {
            return Ok(());
        };
        let Some(latest) = self.state.db.media_by_ids(&[media_id], true).await?.pop() else {
            return Ok(());
        };
        if status_of(&latest, e.key_4k()) != M_AVAILABLE {
            return Ok(());
        }
        let tmdb_id = e.media.as_ref().map_or(latest.tmdb_id, |m| m.tmdb_id);
        let movie = self.state.tmdb.movie(tmdb_id, &self.main_locale()).await?;
        let info = e.info();
        let mut payload = Payload {
            event: Some(format!(
                "{}Movie Request Now Available",
                if e.row.is4k { "4K " } else { "" }
            )),
            notify_admin: false,
            notify_system: true,
            notify_user: Some(info.requested_by.clone()),
            request: Some(info),
            watch_url: crate::media::media_url(&latest, &self.settings, e.row.is4k),
            ..Payload::default()
        };
        fill_title(&mut payload, &movie, "title", "release_date");
        payload.media = Some(latest);
        notify::send(
            Arc::clone(&self.state),
            Arc::clone(&self.settings),
            Kind::MediaAvailable,
            payload,
        );
        Ok(())
    }

    /// `notifyAvailableSeries`.
    async fn notify_available_series(&self, e: &Entity) -> Result<()> {
        let Some(media_id) = e.row.media_id else {
            return Ok(());
        };
        let Some(latest) = self.state.db.media_by_ids(&[media_id], true).await?.pop() else {
            return Ok(());
        };
        let requested: Vec<i64> = e.row.seasons.iter().map(|s| s.season_number).collect();
        let available = latest
            .seasons
            .iter()
            .filter(|s| {
                (if e.row.is4k { s.status4k } else { s.status }) == M_AVAILABLE
                    && requested.contains(&s.season_number)
            })
            .count();
        let ready = if e.row.episodes.is_empty() {
            available > 0 && available == requested.len()
        } else {
            e.row.episodes.iter().all(|x| x.status == COMPLETED)
        };
        if !ready {
            return Ok(());
        }
        let tmdb_id = e.media.as_ref().map_or(latest.tmdb_id, |m| m.tmdb_id);
        let tv = self.state.tmdb.tv(tmdb_id, &self.main_locale()).await?;
        let info = e.info();
        let mut payload = Payload {
            event: Some(format!(
                "{}Series Request Now Available",
                if e.row.is4k { "4K " } else { "" }
            )),
            notify_admin: false,
            notify_system: true,
            notify_user: Some(info.requested_by.clone()),
            extra: vec![requested_extra(&e.row)],
            request: Some(info),
            watch_url: crate::media::media_url(&latest, &self.settings, e.row.is4k),
            ..Payload::default()
        };
        fill_title(&mut payload, &tv, "name", "first_air_date");
        payload.media = Some(latest);
        notify::send(
            Arc::clone(&self.state),
            Arc::clone(&self.settings),
            Kind::MediaAvailable,
            payload,
        );
        Ok(())
    }

    /// `updateParentStatus`: [`update_parent_status`].
    async fn update_parent_status(&self, e: &mut Entity) -> Result<()> {
        update_parent_status(&self.state.db, e).await
    }

    /// The configured server for a request: the default for its quality,
    /// or the request's override.
    fn pick_server(&self, section: &str, e: &Entity) -> Option<Value> {
        let servers = self.settings.get(section).and_then(Value::as_array)?;
        let mut server = servers
            .iter()
            .find(|s| {
                truthy(s.get("isDefault"))
                    && s.get("is4k").and_then(Value::as_bool) == Some(e.row.is4k)
            })
            .cloned();
        if let Some(id) = e.row.server_id.filter(|id| *id >= 0) {
            let has_id = |s: &Value| s.get("id").and_then(Value::as_i64) == Some(id);
            if !server.as_ref().is_some_and(has_id) {
                server = servers.iter().find(|s| has_id(s)).cloned();
            }
        }
        server
    }

    /// The TVDB id of a show TMDB has none for, from the request's Sonarr:
    /// its `tmdb:` lookup, trusting only a series with the same TMDB id.
    async fn tvdb_from_sonarr(&self, e: &Entity, tmdb_id: i64) -> Option<i64> {
        let server = self.pick_server("/sonarr", e)?;
        let arr = Arr {
            client: &self.state.servarr,
            server: &server,
            timeout: crate::servarr::api_timeout(&self.settings),
        };
        match crate::sonarrmeta::series_by_tmdb(&arr, tmdb_id).await {
            Ok(found) => {
                let found = crate::sonarrmeta::first_tvdb_id(&found);
                if let Some(id) = found {
                    tracing::info!(
                        "TMDB has no TVDB ID for TMDB {tmdb_id}; Sonarr's lookup found TVDB {id}"
                    );
                }
                found
            }
            Err(err) => {
                tracing::warn!("Sonarr's tmdb:{tmdb_id} lookup failed: {err:#}");
                None
            }
        }
    }

    /// The requester's tag on a server with `tagRequests`, created if
    /// missing.
    async fn requester_tag(&self, arr: &Arr<'_>, e: &Entity, tags: &mut Vec<Value>) -> Result<()> {
        let Some((user, settings)) = &e.requested_by else {
            return Ok(());
        };
        let existing = arr.tags().await?;
        let old = format!("{} - ", user.id);
        let new = format!("{}-", user.id);
        let label_of = |t: &Value| {
            t.get("label")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned()
        };
        let mut tag = existing
            .iter()
            .find(|t| label_of(t).starts_with(&old))
            .cloned();
        if tag.is_none() {
            tag = existing
                .iter()
                .find(|t| label_of(t).starts_with(&new))
                .cloned();
        }
        let tag = if let Some(tag) = tag {
            tag
        } else {
            let name = Person::from_records(user, settings.as_ref()).display_name;
            arr.create_tag(&format!("{}-{}", user.id, sanitize_display_name(&name)))
                .await?
        };
        if let Some(id) = tag.get("id").filter(|v| truthy(Some(v))) {
            if !tags.contains(id) {
                tags.push(id.clone());
            }
        } else {
            tracing::warn!("Requester has no tag and failed to add one");
        }
        Ok(())
    }

    /// `sendToRadarr`.
    fn send_to_radarr<'a>(&'a self, e: &'a mut Entity) -> Boxed<'a, Result<()>> {
        Box::pin(async move {
            if e.row.status != APPROVED || e.row.request_type != "movie" {
                return Ok(());
            }
            if let Err(err) = self.send_to_radarr_inner(e).await {
                tracing::warn!("Failed to send movie request to Radarr due to connection or configuration error, marking status as FAILED: {err:#}");
                let media = match e.row.media_id {
                    Some(id) => self.state.db.media_by_ids(&[id], true).await?.pop(),
                    None => None,
                };
                if let Some(media) = media {
                    e.row.status = FAILED;
                    self.save(e).await?;
                    self.send_request_notification(e, media, Kind::MediaFailed);
                }
            }
            Ok(())
        })
    }

    async fn send_to_radarr_inner(&self, e: &mut Entity) -> Result<()> {
        if self
            .settings
            .get("/radarr")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
        {
            tracing::info!("No Radarr server configured, skipping request processing");
            return Ok(());
        }
        let Some(server) = self.pick_server("/radarr", e) else {
            tracing::warn!("There is no default Radarr server configured.");
            return Ok(());
        };
        let mut root = server
            .get("activeDirectory")
            .cloned()
            .unwrap_or(Value::Null);
        let mut profile = server
            .get("activeProfileId")
            .cloned()
            .unwrap_or(Value::Null);
        let mut tags: Vec<Value> = server
            .get("tags")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if let Some(r) = e.row.root_folder.as_ref().filter(|r| !r.is_empty()) {
            if Some(r.as_str()) != server.get("activeDirectory").and_then(Value::as_str) {
                root = Value::from(r.as_str());
            }
        }
        if let Some(p) = e.row.profile_id.filter(|p| *p != 0) {
            if server.get("activeProfileId").and_then(Value::as_i64) != Some(p) {
                profile = Value::from(p);
            }
        }
        if let Value::Array(request_tags) = crate::routes::request::tags_json(e.row.tags.as_deref())
        {
            if Some(&request_tags) != server.get("tags").and_then(Value::as_array) {
                tags = request_tags;
            }
        }
        let media_id = e.row.media_id.context("media data not found")?;
        let Some(media) = self.state.db.media_by_ids(&[media_id], true).await?.pop() else {
            tracing::error!("Media data not found");
            return Ok(());
        };
        if status_of(&media, e.row.is4k) == M_AVAILABLE {
            tracing::warn!("Media already exists, marking request as COMPLETED");
            e.row.status = COMPLETED;
            self.save(e).await?;
            return Ok(());
        }
        let tmdb_id = e.media.as_ref().map_or(media.tmdb_id, |m| m.tmdb_id);
        let movie = self.state.tmdb.movie(tmdb_id, &self.main_locale()).await?;
        let timeout = crate::servarr::api_timeout(&self.settings);
        let arr = Arr {
            client: &self.state.servarr,
            server: &server,
            timeout,
        };
        if truthy(server.get("tagRequests")) {
            self.requester_tag(&arr, e, &mut tags).await?;
        }
        let release = movie
            .get("release_date")
            .and_then(Value::as_str)
            .context("release_date")?;
        let year = js_year(release);
        let options = MovieOptions {
            quality_profile: profile,
            root_folder: root,
            minimum_availability: server
                .get("minimumAvailability")
                .cloned()
                .unwrap_or(Value::Null),
            title: movie.get("title").cloned().unwrap_or(Value::Null),
            tmdb_id: movie.get("id").and_then(Value::as_i64).unwrap_or(tmdb_id),
            year,
            tags,
            search_now: !truthy(server.get("preventSearch")),
        };
        let lc = self.clone();
        let snapshot = e.clone();
        tokio::spawn(async move {
            let arr = Arr {
                client: &lc.state.servarr,
                server: &server,
                timeout,
            };
            match arr.add_movie(&options).await {
                Ok(added) => {
                    if let Err(err) = lc.record_service(&snapshot, &server, &added).await {
                        tracing::error!("recording the Radarr movie failed: {err:#}");
                    }
                }
                Err(err) => {
                    tracing::warn!("Something went wrong sending movie request to Radarr, marking status as FAILED: {err:#}");
                    let mut failed = snapshot;
                    if failed.row.status != FAILED {
                        failed.row.status = FAILED;
                        if let Err(err) = lc.save(&mut failed).await {
                            tracing::error!("Failed to mark request as FAILED: {err:#}");
                        }
                    }
                    lc.send_request_notification(&failed, media, Kind::MediaFailed);
                }
            }
        });
        tracing::info!("Sent request to Radarr");
        Ok(())
    }

    /// The `.then` of an add: the media row learns its server, id and slug.
    async fn record_service(&self, e: &Entity, server: &Value, added: &Value) -> Result<()> {
        let media_id = e.row.media_id.context("Media data not found")?;
        let suffix = if e.row.is4k { "4k" } else { "" };
        self.state
            .db
            .execute(
                &format!(
                    r#"UPDATE "media" SET "externalServiceId{suffix}" = ?1, "externalServiceSlug{suffix}" = ?2, "serviceId{suffix}" = ?3, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?4"#
                ),
                &[
                    Bind::OptInt(added.get("id").and_then(Value::as_i64)),
                    Bind::OptText(added.get("titleSlug").and_then(Value::as_str).map(str::to_owned)),
                    Bind::OptInt(server.get("id").and_then(Value::as_i64)),
                    Bind::Int(media_id),
                ],
            )
            .await?;
        Ok(())
    }

    /// `sendToSonarr`.
    fn send_to_sonarr<'a>(&'a self, e: &'a mut Entity) -> Boxed<'a, Result<()>> {
        Box::pin(async move {
            if e.row.status != APPROVED || e.row.request_type != "tv" {
                return Ok(());
            }
            if let Err(err) = self.send_to_sonarr_inner(e).await {
                tracing::warn!("Failed to send series request to Sonarr due to connection or configuration error, marking status as FAILED: {err:#}");
                let media = match e.row.media_id {
                    Some(id) => self.state.db.media_by_ids(&[id], true).await?.pop(),
                    None => None,
                };
                if let Some(media) = media {
                    e.row.status = FAILED;
                    self.mark_failed_quietly(e.row.id).await?;
                    self.send_request_notification(e, media, Kind::MediaFailed);
                }
            }
            Ok(())
        })
    }

    /// `requestRepository.update(id, { status: FAILED })`: no hooks.
    async fn mark_failed_quietly(&self, id: i64) -> Result<()> {
        self.state
            .db
            .execute(
                r#"UPDATE "media_request" SET "status" = ?1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?2"#,
                &[Bind::Int(FAILED), Bind::Int(id)],
            )
            .await?;
        Ok(())
    }

    async fn send_to_sonarr_inner(&self, e: &mut Entity) -> Result<()> {
        if self
            .settings
            .get("/sonarr")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
        {
            tracing::warn!("No Sonarr server configured, skipping request processing");
            return Ok(());
        }
        let db = &self.state.db;
        let media_id = e.row.media_id.context("Media data not found")?;
        let media = db
            .media_by_ids(&[media_id], true)
            .await?
            .pop()
            .context("Media data not found")?;
        let selection = e
            .row
            .episode_selection_type
            .as_ref()
            .is_some_and(|t| !t.is_empty())
            || !e.row.episodes.is_empty();
        if status_of(&media, e.row.is4k) == M_AVAILABLE && !selection {
            tracing::warn!("Media already exists, marking request as COMPLETED");
            e.row.status = COMPLETED;
            for season in &mut e.row.seasons {
                season.status = COMPLETED;
            }
            for episode in &mut e.row.episodes {
                episode.status = COMPLETED;
            }
            self.save(e).await?;
            return Ok(());
        }
        let series = self
            .state
            .tmdb
            .tv(media.tmdb_id, &self.main_locale())
            .await?;
        let tvdb_id = series
            .pointer("/external_ids/tvdb_id")
            .and_then(Value::as_i64)
            .or(media.tvdb_id);
        let tvdb_id = match tvdb_id {
            Some(id) => Some(id),
            None => self.tvdb_from_sonarr(e, media.tmdb_id).await,
        };
        let Some(tvdb_id) = tvdb_id else {
            // Both removes run in the save's transaction in Node.
            let mut tx = Tx::begin(db).await?;
            tx.execute(
                r#"DELETE FROM "media" WHERE "id" = ?1"#,
                &[Bind::Int(media_id)],
            )
            .await?;
            tx.execute(
                r#"DELETE FROM "media_request" WHERE "id" = ?1"#,
                &[Bind::Int(e.row.id)],
            )
            .await?;
            tx.commit().await?;
            anyhow::bail!("TVDB ID not found");
        };
        let anime = crate::routes::tv::is_anime(&series);
        let Some(server) = self.pick_server("/sonarr", e) else {
            tracing::warn!("There is no default Sonarr server configured.");
            return Ok(());
        };
        let field = |k: &str| server.get(k).cloned().unwrap_or(Value::Null);
        let anime_or = |anime_key: &str, key: &str| {
            if anime && truthy(server.get(anime_key)) {
                field(anime_key)
            } else {
                field(key)
            }
        };
        let series_type = if anime {
            server
                .get("animeSeriesType")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or_else(|| Value::from("anime"))
        } else {
            server
                .get("seriesType")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or_else(|| Value::from("standard"))
        };
        let mut root = anime_or("activeAnimeDirectory", "activeDirectory");
        let mut profile = anime_or("activeAnimeProfileId", "activeProfileId");
        let mut language = anime_or("activeAnimeLanguageProfileId", "activeLanguageProfileId");
        let routing_tags: Vec<Value> = server
            .get(if anime { "animeTags" } else { "tags" })
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut tags = routing_tags.clone();
        if let Some(r) = e.row.root_folder.as_ref().filter(|r| !r.is_empty()) {
            if Some(r.as_str()) != root.as_str() {
                root = Value::from(r.as_str());
            }
        }
        if let Some(p) = e.row.profile_id.filter(|p| *p != 0) {
            if profile.as_i64() != Some(p) {
                profile = Value::from(p);
            }
        }
        if let Some(l) = e.row.language_profile_id.filter(|l| *l != 0) {
            if language.as_i64() != Some(l) {
                language = Value::from(l);
            }
        }
        if let Value::Array(request_tags) = crate::routes::request::tags_json(e.row.tags.as_deref())
        {
            if request_tags != routing_tags {
                tags = request_tags;
            }
        }
        let timeout = crate::servarr::api_timeout(&self.settings);
        let arr = Arr {
            client: &self.state.servarr,
            server: &server,
            timeout,
        };
        if truthy(server.get("tagRequests")) {
            self.requester_tag(&arr, e, &mut tags).await?;
        }
        let seasons = if selection {
            Vec::new()
        } else {
            let numbers: Vec<i64> = e.row.seasons.iter().map(|s| s.season_number).collect();
            crate::mapping::sonarr_seasons(db, media.tmdb_id, &numbers)
                .await
                .unwrap_or(numbers)
        };
        let options = SeriesOptions {
            quality_profile: profile,
            language_profile: language,
            metadata_language: crate::sonarrmeta::chosen_metadata_language(
                &server,
                anime,
                e.row.metadata_language_id,
            ),
            root_folder: root,
            title: series.get("name").cloned().unwrap_or(Value::Null),
            tvdb_id,
            seasons,
            episode_tvdb_ids: selection.then(|| e.row.episodes.iter().map(|x| x.tvdb_id).collect()),
            season_folder: field("enableSeasonFolders"),
            series_type,
            tags,
            monitor_new_items: if selection {
                Value::from("none")
            } else {
                field("monitorNewItems")
            },
            search_now: !truthy(server.get("preventSearch")),
        };
        self.spawn_series_add(e.clone(), server, options, media, timeout);
        tracing::info!("Sent request to Sonarr");
        Ok(())
    }

    /// The background `addSeries` of `sendToSonarr` and what follows it.
    fn spawn_series_add(
        &self,
        snapshot: Entity,
        server: Value,
        options: SeriesOptions,
        media: MediaRow,
        timeout: Option<std::time::Duration>,
    ) {
        let lc = self.clone();
        tokio::spawn(async move {
            let arr = Arr {
                client: &lc.state.servarr,
                server: &server,
                timeout,
            };
            let result = async {
                let added = arr.add_series(&options).await?;
                lc.record_service(&snapshot, &server, &added).await?;
                let mut entity = snapshot.clone();
                if !entity.row.episodes.is_empty() && truthy(added.get("id")) {
                    let episodes = arr
                        .episodes(added.get("id").unwrap_or(&Value::Null))
                        .await?;
                    let now = crate::clock::now_millis();
                    let prevent = truthy(server.get("preventSearch"));
                    for child in &mut entity.row.episodes {
                        let Some(found) = episodes.iter().find(|x| {
                            x.get("tvdbId").and_then(Value::as_i64) == Some(child.tvdb_id)
                        }) else {
                            continue;
                        };
                        let has_file = truthy(found.get("hasFile"));
                        child.status = if has_file { COMPLETED } else { APPROVED };
                        if !prevent && !has_file && crate::arr::aired(found, now) {
                            child.search_triggered_at = Some(crate::clock::Utc::now().iso_string());
                        }
                    }
                    lc.write(&mut entity, false).await?;
                    let all_complete = entity.row.episodes.iter().all(|x| x.status == COMPLETED);
                    let rolling = matches!(
                        entity.row.episode_selection_type.as_deref(),
                        Some("after" | "watchAhead")
                    );
                    let ended = js_string(added.get("status")).to_lowercase() == "ended";
                    let may_complete = !rolling
                        || (entity.row.episode_selection_type.as_deref() == Some("after") && ended);
                    if all_complete && may_complete {
                        entity.row.status = COMPLETED;
                        lc.save(&mut entity).await?;
                    }
                }
                anyhow::Ok(())
            }
            .await;
            if let Err(err) = result {
                tracing::warn!("Something went wrong sending series request to Sonarr, marking status as FAILED: {err:#}");
                let mut failed = snapshot;
                if failed.row.status != FAILED {
                    failed.row.status = FAILED;
                    if let Err(err) = lc.mark_failed_quietly(failed.row.id).await {
                        tracing::error!("Failed to mark request as FAILED: {err:#}");
                    }
                }
                lc.send_request_notification(&failed, media, Kind::MediaFailed);
            }
        });
    }
}

/// The writes of a save, in one transaction as `TypeORM`'s cascaded
/// save runs them; whether the request row changed. Without
/// `with_row` only the seasons and episodes are saved (their own
/// repositories' `save`), leaving the request row as it is.
async fn write_request(db: &Db, e: &mut Entity, with_row: bool) -> Result<bool> {
    let Some(current) = db.request_by_id(e.row.id).await? else {
        return Ok(false);
    };
    let mut tx = Tx::begin(db).await?;
    let row_changed = write_rows(&mut Exec::Tx(&mut tx), e, &current, with_row).await?;
    tx.commit().await?;
    reload_dates(db, e, with_row).await?;
    Ok(row_changed)
}

/// The dates `TypeORM` reads back after a save.
async fn reload_dates(db: &Db, e: &mut Entity, with_row: bool) -> Result<()> {
    if let Some(fresh) = db.request_by_id(e.row.id).await? {
        if with_row {
            e.row.updated_at = fresh.updated_at;
        }
        for season in &mut e.row.seasons {
            if let Some(f) = fresh.seasons.iter().find(|s| s.id == season.id) {
                season.updated_at.clone_from(&f.updated_at);
            }
        }
        for episode in &mut e.row.episodes {
            if let Some(f) = fresh.episodes.iter().find(|x| x.id == episode.id) {
                episode.updated_at.clone_from(&f.updated_at);
                episode
                    .search_triggered_at
                    .clone_from(&f.search_triggered_at);
            }
        }
    }
    Ok(())
}

/// `updateParentStatus`, in one transaction as Node's nested one
/// (`withNestedTransaction`): a failure leaves none of its writes.
async fn update_parent_status(db: &Db, e: &mut Entity) -> Result<()> {
    let Some(media_id) = e.row.media_id else {
        return Ok(());
    };
    let Some(media) = db.media_by_ids(&[media_id], true).await?.pop() else {
        tracing::error!("Media data not found");
        return Ok(());
    };
    let four = e.row.is4k;
    let column = if four { "status4k" } else { "status" };
    let current = status_of(&media, four);
    let cascades = media.media_type == "tv" && matches!(e.row.status, DECLINED | APPROVED);
    let stored = if cascades {
        db.request_by_id(e.row.id).await?
    } else {
        None
    };
    let mut tx = Tx::begin(db).await?;
    let exec = &mut Exec::Tx(&mut tx);
    if e.row.status == APPROVED && !matches!(current, M_AVAILABLE | M_PARTIAL | M_PROCESSING) {
        set_media_status(exec, media_id, four, M_PROCESSING).await?;
    }
    if media.media_type == "movie" && e.row.status == DECLINED && current != M_DELETED {
        set_media_status(exec, media_id, four, M_UNKNOWN).await?;
    }
    if media.media_type == "tv" && e.row.status == DECLINED {
        if current == M_PENDING {
            let others = exec
                .scalar(
                    r#"SELECT COUNT(*) FROM "media_request" WHERE "mediaId" = ?1 AND "status" = ?2 AND "is4k" = ?3 AND "id" != ?4"#,
                    &[Bind::Int(media_id), Bind::Int(PENDING), Bind::Bool(four), Bind::Int(e.row.id)],
                )
                .await?;
            if others == 0 {
                set_media_status(exec, media_id, four, M_UNKNOWN).await?;
            }
        }
        for season in &mut e.row.seasons {
            season.status = DECLINED;
            let actual = media
                .seasons
                .iter()
                .find(|s| s.season_number == season.season_number);
            if let Some(actual) = actual {
                if (if four { actual.status4k } else { actual.status }) == M_PENDING {
                    let others = exec
                        .scalar(
                            r#"SELECT COUNT(DISTINCT r."id") FROM "media_request" r LEFT JOIN "season_request" s ON s."requestId" = r."id" WHERE r."mediaId" = ?1 AND r."id" != ?2 AND r."is4k" = ?3 AND r."status" NOT IN (3, 5) AND s."seasonNumber" = ?4"#,
                            &[Bind::Int(media_id), Bind::Int(e.row.id), Bind::Bool(four), Bind::Int(season.season_number)],
                        )
                        .await?;
                    if others == 0 {
                        exec.execute(
                            &format!(r#"UPDATE "season" SET "{column}" = ?1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?2"#),
                            &[Bind::Int(M_UNKNOWN), Bind::Int(actual.id)],
                        )
                        .await?;
                    }
                }
            }
        }
        for episode in &mut e.row.episodes {
            episode.status = DECLINED;
        }
    }
    if media.media_type == "tv" && e.row.status == APPROVED {
        for season in &mut e.row.seasons {
            season.status = APPROVED;
        }
        for episode in &mut e.row.episodes {
            episode.status = APPROVED;
        }
    }
    if let Some(stored) = &stored {
        write_rows(exec, e, stored, false).await?;
    }
    tx.commit().await?;
    if stored.is_some() {
        reload_dates(db, e, false).await?;
    }
    Ok(())
}

/// The subscriber's `afterRemove` (`handleRemoveParentUpdate`) for a
/// request that was just deleted.
///
/// The media's status in that quality falls back when no active request
/// is left (`DELETED` when one had completed), and seasons only this
/// request asked for go back to `UNKNOWN`.
///
/// Node runs the hook inside `remove`'s transaction, so this only reads
/// (before that transaction opens, leaving out the requests the remove
/// deletes, `removed` by id) and returns the statements for the caller
/// to run in it after the delete.
///
/// # Errors
///
/// Fails on database errors or when the media row is gone.
pub async fn after_remove(
    db: &Db,
    e: &Entity,
    removed: &[i64],
) -> Result<Vec<(String, Vec<Bind>)>> {
    let media_id = e.row.media_id.context("Media data not found")?;
    let media = db
        .media_by_ids(&[media_id], true)
        .await?
        .pop()
        .context("Media data not found")?;
    let mut requests = db.requests_of_media(media_id).await?;
    requests.retain(|r| r.id != e.row.id && !removed.contains(&r.id));
    let active = |r: &RequestRow| r.status != COMPLETED && r.status != DECLINED;
    let fallback = |four_k: bool, current: i64| -> Option<i64> {
        let has_active = requests.iter().any(|r| r.is4k == four_k && active(r));
        if has_active || current == M_AVAILABLE || current == M_PARTIAL {
            return None;
        }
        let had_completed = requests
            .iter()
            .any(|r| r.is4k == four_k && r.status == COMPLETED);
        Some(if had_completed { M_DELETED } else { M_UNKNOWN })
    };
    let mut writes = Vec::new();
    let status = fallback(false, media.status).filter(|s| *s != media.status);
    let status4k = fallback(true, media.status4k).filter(|s| *s != media.status4k);
    if status.is_some() || status4k.is_some() {
        writes.push((
            String::from(
                r#"UPDATE "media" SET "status" = COALESCE(?1, "status"), "status4k" = COALESCE(?2, "status4k"), "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?3"#,
            ),
            vec![Bind::OptInt(status), Bind::OptInt(status4k), Bind::Int(media_id)],
        ));
    }
    if media.media_type == "tv" {
        let four = e.row.is4k;
        let numbers: Vec<i64> = e
            .row
            .seasons
            .iter()
            .map(|s| s.season_number)
            .chain(e.row.episodes.iter().map(|x| x.season_number))
            .collect();
        let still_active: Vec<i64> = requests
            .iter()
            .filter(|r| r.is4k == four && active(r))
            .flat_map(|r| {
                r.seasons
                    .iter()
                    .map(|s| s.season_number)
                    .chain(r.episodes.iter().map(|x| x.season_number))
            })
            .collect();
        let column = if four { "status4k" } else { "status" };
        for season in &media.seasons {
            let current = if four { season.status4k } else { season.status };
            if numbers.contains(&season.season_number)
                && !still_active.contains(&season.season_number)
                && (current == M_PENDING || current == M_PROCESSING)
            {
                writes.push((
                    format!(r#"UPDATE "season" SET "{column}" = ?1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?2"#),
                    vec![Bind::Int(M_UNKNOWN), Bind::Int(season.id)],
                ));
            }
        }
    }
    Ok(writes)
}

/// The statements of a request save against the row as stored
/// (`current`): the row when its status or modifier changed (and
/// `with_row`), then the seasons and episodes whose status changed;
/// whether the row was written.
async fn write_rows(
    exec: &mut Exec<'_>,
    e: &Entity,
    current: &RequestRow,
    with_row: bool,
) -> Result<bool> {
    let row_changed = with_row
        && (current.status != e.row.status || current.modified_by_id != e.row.modified_by_id);
    if row_changed {
        exec.execute(
            r#"UPDATE "media_request" SET "status" = ?1, "modifiedById" = ?2, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?3"#,
            &[Bind::Int(e.row.status), Bind::OptInt(e.row.modified_by_id), Bind::Int(e.row.id)],
        )
        .await?;
    }
    for season in &e.row.seasons {
        let before = current.seasons.iter().find(|s| s.id == season.id);
        if before.is_some_and(|b| b.status != season.status) {
            exec.execute(
                r#"UPDATE "season_request" SET "status" = ?1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?2"#,
                &[Bind::Int(season.status), Bind::Int(season.id)],
            )
            .await?;
        }
    }
    for episode in &e.row.episodes {
        let before = current.episodes.iter().find(|x| x.id == episode.id);
        if before.is_some_and(|b| {
            b.status != episode.status || b.search_triggered_at != episode.search_triggered_at
        }) {
            exec.execute(
                &format!(
                    r#"UPDATE "episode_request" SET "status" = ?1, "searchTriggeredAt" = {}, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?2"#,
                    if episode.search_triggered_at.is_some() { "CURRENT_TIMESTAMP" } else { "NULL" }
                ),
                &[Bind::Int(episode.status), Bind::Int(episode.id)],
            )
            .await?;
        }
    }
    Ok(row_changed)
}

/// Save a media row's status column.
async fn set_media_status(
    exec: &mut Exec<'_>,
    media_id: i64,
    four_k: bool,
    status: i64,
) -> Result<()> {
    let column = if four_k { "status4k" } else { "status" };
    exec.execute(
        &format!(
            r#"UPDATE "media" SET "{column}" = ?1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?2"#
        ),
        &[Bind::Int(status), Bind::Int(media_id)],
    )
    .await?;
    Ok(())
}

/// `Number(date.slice(0, 4))`.
fn js_year(date: &str) -> Value {
    let head: String = date.chars().take(4).collect();
    if head.trim().is_empty() {
        return Value::from(0);
    }
    head.trim().parse::<i64>().map_or(Value::Null, Value::from)
}

/// `sanitizeDisplayName`: NFD with the combining diacritics (U+0300 to
/// U+036F) dropped, spaces to hyphens, anything else outside `[a-z0-9-]`
/// (any case) dropped, hyphens collapsed and trimmed.
pub(crate) fn sanitize_display_name(name: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let mut out = String::new();
    let mut last_space = false;
    for base in name.nfd().filter(|c| !('\u{300}'..='\u{36f}').contains(c)) {
        if base.is_whitespace() {
            if !last_space {
                out.push('-');
            }
            last_space = true;
            continue;
        }
        last_space = false;
        if base.is_ascii_alphanumeric() || base == '-' {
            out.push(base);
        }
    }
    let mut collapsed = String::new();
    for c in out.chars() {
        if c == '-' && collapsed.ends_with('-') {
            continue;
        }
        collapsed.push(c);
    }
    collapsed.trim_matches('-').to_owned()
}

/// The subject, message and poster of a request notification.
fn fill_title(payload: &mut Payload, title: &Value, name_key: &str, date_key: &str) {
    let name = js_string(title.get(name_key)).into_owned();
    let date = title
        .get(date_key)
        .and_then(Value::as_str)
        .filter(|d| !d.is_empty());
    payload.subject = match date {
        Some(d) => format!("{name} ({})", d.chars().take(4).collect::<String>()),
        None => name,
    };
    let overview = title.get("overview").and_then(Value::as_str).unwrap_or("");
    payload.message = Some(truncate(overview));
    payload.image = Some(format!(
        "https://image.tmdb.org/t/p/w600_and_h900_bestv2{}",
        js_string(title.get("poster_path"))
    ));
}

/// lodash `truncate(text, { length: 500, separator: /\s/, omission: '…' })`.
#[must_use]
pub fn truncate(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= 500 {
        return text.to_owned();
    }
    let end = 499;
    let mut result: Vec<char> = chars.get(..end).map(<[char]>::to_vec).unwrap_or_default();
    let next_is_space = chars.get(end).is_some_and(|c| c.is_whitespace());
    if !next_is_space {
        if let Some(cut) = result.iter().rposition(|c| c.is_whitespace()) {
            result.truncate(cut);
        }
    }
    let mut out: String = result.into_iter().collect();
    out.push('…');
    out
}

/// `Requested Episodes` or `Requested Seasons` for a TV notification.
fn requested_extra(row: &RequestRow) -> (String, String) {
    let code = |s: i64, e: i64| format!("S{s:02}E{e:02}");
    if row.episodes.is_empty() {
        (
            String::from("Requested Seasons"),
            row.seasons
                .iter()
                .map(|s| s.season_number.to_string())
                .collect::<Vec<_>>()
                .join(", "),
        )
    } else {
        let value = match row.episode_selection_type.as_deref() {
            Some("after") => {
                let first = row.episodes.first();
                format!(
                    "{} onward",
                    code(
                        first.map_or(0, |x| x.season_number),
                        first.map_or(0, |x| x.episode_number)
                    )
                )
            }
            Some("watchAhead") => format!("Keep {} ahead", row.watch_ahead_count.unwrap_or(10)),
            _ => row
                .episodes
                .iter()
                .map(|x| code(x.season_number, x.episode_number))
                .collect::<Vec<_>>()
                .join(", "),
        };
        (String::from("Requested Episodes"), value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dbtx::scratch::{self, ints, PENDING_SEASON_ONE};

    #[test]
    fn helpers() {
        assert_eq!(
            sanitize_display_name("  José Álvarez!! "),
            "Jose-Alvarez",
            "display name"
        );
        assert_eq!(
            sanitize_display_name("Kōji Šťastný"),
            "Koji-Stastny",
            "letters outside Latin-1"
        );
        assert_eq!(js_year("1999-10-15"), Value::from(1999), "year");
        assert_eq!(js_year(""), Value::from(0), "empty year");
        let long = "word ".repeat(120);
        let t = truncate(&long);
        assert!(
            t.ends_with('…') && t.chars().count() <= 500,
            "truncated at a space"
        );
        assert_eq!(truncate("short"), "short", "short text");
    }

    async fn entity(db: &Db) -> Result<Entity> {
        Ok(Entity {
            row: db.request_by_id(1).await?.context("request 1")?,
            media: None,
            requested_by: None,
            modified_by: None,
        })
    }

    #[tokio::test]
    async fn a_failed_season_write_keeps_the_request_row() -> Result<()> {
        let scratch = scratch::sqlite("lifecycle-save").await?;
        let db = &scratch.db;
        scratch::run(db, &PENDING_SEASON_ONE).await?;
        scratch::run(
            db,
            &[r#"CREATE TRIGGER "refuse_season" BEFORE UPDATE ON "season_request" BEGIN SELECT RAISE(ABORT, 'season update refused'); END"#],
        )
        .await?;
        let mut e = entity(db).await?;
        e.row.status = APPROVED;
        for season in &mut e.row.seasons {
            season.status = APPROVED;
        }
        assert!(
            write_request(db, &mut e, true).await.is_err(),
            "the season update fails"
        );
        let status = r#"SELECT "status" FROM "media_request" WHERE "id" = 1"#;
        assert_eq!(ints(db, status).await?, [PENDING], "the row rolled back");

        scratch::run(db, &[r#"DROP TRIGGER "refuse_season""#]).await?;
        assert!(write_request(db, &mut e, true).await?, "the row changed");
        assert_eq!(ints(db, status).await?, [APPROVED], "saved");
        let seasons = r#"SELECT "status" FROM "season_request" WHERE "requestId" = 1"#;
        assert_eq!(ints(db, seasons).await?, [APPROVED], "with its season");
        Ok(())
    }

    #[tokio::test]
    async fn a_failed_parent_status_update_writes_nothing() -> Result<()> {
        let scratch = scratch::sqlite("lifecycle-parent").await?;
        let db = &scratch.db;
        scratch::run(db, &PENDING_SEASON_ONE).await?;
        scratch::run(
            db,
            &[
                r#"UPDATE "media_request" SET "status" = 3 WHERE "id" = 1"#,
                r#"CREATE TRIGGER "refuse_season" BEFORE UPDATE ON "season_request" BEGIN SELECT RAISE(ABORT, 'season update refused'); END"#,
            ],
        )
        .await?;
        // A declined series request: the media and its season fall back
        // to unknown, and the request's season is declined.
        let mut e = entity(db).await?;
        assert!(
            update_parent_status(db, &mut e).await.is_err(),
            "the season request update fails"
        );
        let media = r#"SELECT "status" FROM "media" WHERE "id" = 1"#;
        assert_eq!(ints(db, media).await?, [M_PENDING], "media rolled back");
        let season = r#"SELECT "status" FROM "season" WHERE "mediaId" = 1"#;
        assert_eq!(ints(db, season).await?, [M_PENDING], "season rolled back");

        scratch::run(db, &[r#"DROP TRIGGER "refuse_season""#]).await?;
        let mut e = entity(db).await?;
        update_parent_status(db, &mut e).await?;
        assert_eq!(ints(db, media).await?, [M_UNKNOWN], "media updated");
        assert_eq!(ints(db, season).await?, [M_UNKNOWN], "season updated");
        let requested = r#"SELECT "status" FROM "season_request" WHERE "requestId" = 1"#;
        assert_eq!(ints(db, requested).await?, [DECLINED], "declined");
        Ok(())
    }
}
