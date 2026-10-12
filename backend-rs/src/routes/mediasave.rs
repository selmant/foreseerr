//! `mediaRepository.save(media)` for a loaded `Media` a handler changed.
//!
//! The writes `TypeORM` computes (new seasons inserted, changed columns
//! updated with `updatedAt`) wrapped in `MediaSubscriber`'s `beforeUpdate`
//! and `afterUpdate`. Those approve pending requests when a title becomes
//! available and complete the approved or failed ones whose titles or
//! seasons are now available or deleted; the request saves go through
//! `crate::lifecycle`, which runs the request hooks and notifications.

use std::sync::Arc;

use anyhow::{Context, Result};
use serde_json::{Map, Value};

use crate::db::{Bind, MediaRow, SeasonRow};
use crate::lifecycle::{Entity, Lc, APPROVED, COMPLETED, FAILED, PENDING};

/// `MediaStatus` values.
pub(super) const M_PENDING: i64 = 2;
pub(super) const M_PARTIAL: i64 = 4;
pub(super) const M_AVAILABLE: i64 = 5;
pub(super) const M_DELETED: i64 = 7;

/// A loaded media row and the same row after the handler's changes.
///
/// New seasons sit at the end of `after.seasons` with id 0; `fresh` says which
/// status column the handler set on each (it decides their key order).
#[derive(Debug, Clone)]
pub struct MediaEdit {
    pub before: MediaRow,
    pub after: MediaRow,
    pub fresh: Vec<FreshSeason>,
}

/// A season the handler created: its index in `after.seasons` and whether
/// `status4k` (rather than `status`) was the column it set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FreshSeason {
    pub index: usize,
    pub four_k: bool,
}

impl MediaEdit {
    #[must_use]
    pub fn new(row: MediaRow) -> Self {
        Self {
            before: row.clone(),
            after: row,
            fresh: Vec::new(),
        }
    }

    /// Set a season's status column, creating the season
    /// (`seasonRepository.create({ seasonNumber })`) when the media has
    /// none with this number.
    pub(super) fn set_season_status(&mut self, number: i64, four_k: bool, status: i64) {
        let season = if let Some(season) = self
            .after
            .seasons
            .iter_mut()
            .find(|s| s.season_number == number)
        {
            season
        } else {
            self.fresh.push(FreshSeason {
                index: self.after.seasons.len(),
                four_k,
            });
            self.after.seasons.push(SeasonRow {
                id: 0,
                season_number: number,
                status: 1,
                status4k: 1,
                created_at: None,
                updated_at: None,
                media_id: Some(self.after.id),
            });
            let Some(season) = self.after.seasons.last_mut() else {
                return;
            };
            season
        };
        if four_k {
            season.status4k = status;
        } else {
            season.status = status;
        }
    }
}

const fn status_of(media: &MediaRow, four_k: bool) -> i64 {
    if four_k {
        media.status4k
    } else {
        media.status
    }
}

const fn season_status(season: &SeasonRow, four_k: bool) -> i64 {
    if four_k {
        season.status4k
    } else {
        season.status
    }
}

/// The media columns a save writes because they differ from the loaded row.
fn media_changes(before: &MediaRow, after: &MediaRow) -> Vec<(&'static str, Bind)> {
    let mut out = Vec::new();
    let mut int = |col: &'static str, b: Option<i64>, a: Option<i64>| {
        if a != b {
            out.push((col, Bind::OptInt(a)));
        }
    };
    int("status", Some(before.status), Some(after.status));
    int("status4k", Some(before.status4k), Some(after.status4k));
    int("serviceId", before.service_id, after.service_id);
    int("serviceId4k", before.service_id4k, after.service_id4k);
    int(
        "externalServiceId",
        before.external_service_id,
        after.external_service_id,
    );
    int(
        "externalServiceId4k",
        before.external_service_id4k,
        after.external_service_id4k,
    );
    let mut text = |col: &'static str, b: &Option<String>, a: &Option<String>| {
        if a != b {
            out.push((col, Bind::OptText(a.clone())));
        }
    };
    text(
        "externalServiceSlug",
        &before.external_service_slug,
        &after.external_service_slug,
    );
    text(
        "externalServiceSlug4k",
        &before.external_service_slug4k,
        &after.external_service_slug4k,
    );
    text("imdbId", &before.imdb_id, &after.imdb_id);
    text(
        "lastSeasonChange",
        &before.last_season_change,
        &after.last_season_change,
    );
    text(
        "mediaAddedAt",
        &before.media_added_at,
        &after.media_added_at,
    );
    text("ratingKey", &before.rating_key, &after.rating_key);
    text("ratingKey4k", &before.rating_key4k, &after.rating_key4k);
    text(
        "jellyfinMediaId",
        &before.jellyfin_media_id,
        &after.jellyfin_media_id,
    );
    text(
        "jellyfinMediaId4k",
        &before.jellyfin_media_id4k,
        &after.jellyfin_media_id4k,
    );
    out
}

/// The date columns `media_changes` compares as ISO strings.
const DATE_COLUMNS: [&str; 2] = ["lastSeasonChange", "mediaAddedAt"];

/// An ISO date as `TypeORM` writes it: `YYYY-MM-DD HH:MM:SS.SSS` on
/// `SQLite`, the ISO string (cast) on Postgres.
fn date_bind(db: &crate::db::Db, bind: &Bind) -> Bind {
    match bind {
        Bind::OptText(Some(iso)) | Bind::Text(iso) if !db.is_postgres() => {
            Bind::OptText(Some(crate::clock::parse_date_millis(iso).map_or_else(
                || iso.clone(),
                |ms| crate::clock::Utc::from_unix_millis(ms).typeorm_string(),
            )))
        }
        other @ (Bind::Int(_)
        | Bind::Text(_)
        | Bind::OptInt(_)
        | Bind::OptText(_)
        | Bind::Bool(_)) => other.clone(),
    }
}

/// `resetServiceData(is4k)`: `None` clears both qualities.
pub(super) fn reset_service_data(media: &mut MediaRow, four_k: Option<bool>) {
    if four_k != Some(true) {
        media.service_id = None;
        media.external_service_id = None;
        media.external_service_slug = None;
        media.rating_key = None;
        media.jellyfin_media_id = None;
    }
    if four_k != Some(false) {
        media.service_id4k = None;
        media.external_service_id4k = None;
        media.external_service_slug4k = None;
        media.rating_key4k = None;
        media.jellyfin_media_id4k = None;
    }
}

/// The save, hooks included. Afterwards `edit.after` holds what the
/// entity holds in Node: the reloaded `updatedAt` values and the new
/// seasons' ids and defaults.
///
/// # Errors
///
/// Database errors.
pub async fn save(lc: &Lc, edit: &mut MediaEdit) -> Result<()> {
    save_with_orphans(lc, edit, &[]).await
}

/// [`save`] for an entity whose `seasons` lack some stored seasons
/// (`orphans`, by id): `TypeORM`'s orphan handling sets their `mediaId` to
/// null in the same save, before `afterUpdate`.
///
/// # Errors
///
/// Database errors.
pub async fn save_with_orphans(lc: &Lc, edit: &mut MediaEdit, orphans: &[i64]) -> Result<()> {
    let changes = media_changes(&edit.before, &edit.after);
    let media_changed = !changes.is_empty();
    let db_seasons = if media_changed {
        before_update(lc, edit).await?
    } else {
        Vec::new()
    };
    write(lc, edit, &changes).await?;
    for id in orphans {
        lc.state
            .db
            .execute(
                r#"UPDATE "season" SET "mediaId" = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?1"#,
                &[Bind::Int(*id)],
            )
            .await
            .context("detaching a season")?;
    }
    if media_changed {
        after_update(lc, edit, &db_seasons).await;
    }
    Ok(())
}

/// The inserts and updates, then the values `TypeORM` reads back.
async fn write(lc: &Lc, edit: &mut MediaEdit, changes: &[(&'static str, Bind)]) -> Result<()> {
    let db = &lc.state.db;
    let media_id = edit.after.id;
    for fresh in &edit.fresh {
        let Some(season) = edit.after.seasons.get_mut(fresh.index) else {
            continue;
        };
        let id = db
            .scalar(
                r#"INSERT INTO "season" ("seasonNumber", "status", "status4k", "mediaId") VALUES (?1, ?2, ?3, ?4) RETURNING CAST("id" AS BIGINT)"#,
                &[
                    Bind::Int(season.season_number),
                    Bind::Int(season.status),
                    Bind::Int(season.status4k),
                    Bind::Int(media_id),
                ],
            )
            .await
            .context("inserting a season")?;
        season.id = id;
    }
    if !changes.is_empty() {
        let mut sets = Vec::new();
        let mut binds = Vec::new();
        for (col, bind) in changes {
            if DATE_COLUMNS.contains(col) {
                binds.push(date_bind(db, bind));
                sets.push(if db.is_postgres() {
                    format!(r#""{col}" = CAST(?{} AS timestamptz)"#, binds.len())
                } else {
                    format!(r#""{col}" = ?{}"#, binds.len())
                });
                continue;
            }
            binds.push(bind.clone());
            sets.push(format!(r#""{col}" = ?{}"#, binds.len()));
        }
        binds.push(Bind::Int(media_id));
        let sql = format!(
            r#"UPDATE "media" SET {}, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?{}"#,
            sets.join(", "),
            binds.len()
        );
        db.execute(&sql, &binds).await.context("updating media")?;
    }
    let mut touched: Vec<i64> = edit
        .fresh
        .iter()
        .filter_map(|f| edit.after.seasons.get(f.index).map(|s| s.id))
        .collect();
    for season in &edit.after.seasons {
        let Some(old) = edit.before.seasons.iter().find(|s| s.id == season.id) else {
            continue;
        };
        let mut sets = Vec::new();
        let mut binds = Vec::new();
        if old.status != season.status {
            binds.push(Bind::Int(season.status));
            sets.push(format!(r#""status" = ?{}"#, binds.len()));
        }
        if old.status4k != season.status4k {
            binds.push(Bind::Int(season.status4k));
            sets.push(format!(r#""status4k" = ?{}"#, binds.len()));
        }
        if sets.is_empty() {
            continue;
        }
        binds.push(Bind::Int(season.id));
        let sql = format!(
            r#"UPDATE "season" SET {}, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?{}"#,
            sets.join(", "),
            binds.len()
        );
        db.execute(&sql, &binds)
            .await
            .context("updating a season")?;
        touched.push(season.id);
    }
    if changes.is_empty() && touched.is_empty() {
        return Ok(());
    }
    let Some(fresh_row) = db.media_by_ids(&[media_id], true).await?.pop() else {
        return Ok(());
    };
    if !changes.is_empty() {
        edit.after.updated_at.clone_from(&fresh_row.updated_at);
    }
    for season in &mut edit.after.seasons {
        if !touched.contains(&season.id) {
            continue;
        }
        if let Some(stored) = fresh_row.seasons.iter().find(|s| s.id == season.id) {
            season.updated_at.clone_from(&stored.updated_at);
            if season.created_at.is_none() {
                season.created_at.clone_from(&stored.created_at);
                season.status = stored.status;
                season.status4k = stored.status4k;
            }
        }
    }
    Ok(())
}

/// The ids of a media's requests matching `filter` (SQL over `r`), in
/// table order, loaded with their relations before any of them is saved.
async fn load_requests(
    lc: &Lc,
    media_id: i64,
    filter: &str,
    binds: Vec<Bind>,
) -> Result<Vec<Entity>> {
    let mut all = vec![Bind::Int(media_id)];
    all.extend(binds);
    let rows = lc
        .state
        .db
        .rows(
            &format!(
                r#"SELECT CAST(r."id" AS BIGINT) AS "id" FROM "media_request" r WHERE r."mediaId" = ?1{filter} ORDER BY r."id" ASC"#
            ),
            &all,
        )
        .await?;
    let mut out = Vec::new();
    for row in rows {
        if let Some(id) = row.get("id").and_then(Value::as_i64) {
            if let Some(entity) = lc.load(id).await? {
                out.push(entity);
            }
        }
    }
    Ok(out)
}

/// `beforeUpdate`: approve the pending requests of a title that turned
/// available, then the seasons as stored, which `afterUpdate` compares
/// against.
async fn before_update(lc: &Lc, edit: &MediaEdit) -> Result<Vec<SeasonRow>> {
    for four_k in [false, true] {
        if status_of(&edit.after, four_k) == M_AVAILABLE
            && status_of(&edit.before, four_k) == M_PENDING
        {
            if let Err(e) = approve_children(lc, edit.after.id, four_k).await {
                tracing::error!(
                    "Error while updating child request status in beforeUpdate subscriber: {e:#}"
                );
            }
        }
    }
    Ok(lc
        .state
        .db
        .media_by_ids(&[edit.after.id], true)
        .await?
        .pop()
        .map(|m| m.seasons)
        .unwrap_or_default())
}

/// `updateChildRequestStatus`.
async fn approve_children(lc: &Lc, media_id: i64, four_k: bool) -> Result<()> {
    for mut entity in load_requests(lc, media_id, "", Vec::new()).await? {
        if entity.row.is4k == four_k && entity.row.status == PENDING {
            entity.row.status = APPROVED;
            lc.save(&mut entity).await?;
        }
    }
    Ok(())
}

/// `afterUpdate`.
async fn after_update(lc: &Lc, edit: &MediaEdit, db_seasons: &[SeasonRow]) {
    let tv = edit.after.media_type == "tv";
    for four_k in [false, true] {
        let changed = status_of(&edit.after, four_k) != status_of(&edit.before, four_k);
        let seasons_changed = edit.after.seasons.iter().enumerate().any(|(i, s)| {
            Some(season_status(s, four_k)) != db_seasons.get(i).map(|p| season_status(p, four_k))
        });
        if (changed || (tv && seasons_changed))
            && matches!(
                status_of(&edit.after, four_k),
                M_PARTIAL | M_AVAILABLE | M_DELETED
            )
        {
            if let Err(e) = complete_related(lc, edit, db_seasons, four_k).await {
                tracing::error!(
                    "Error while updating related requests in afterUpdate subscriber: {e:#}"
                );
            }
        }
    }
}

/// `updateRelatedMediaRequest`.
async fn complete_related(
    lc: &Lc,
    edit: &MediaEdit,
    db_seasons: &[SeasonRow],
    four_k: bool,
) -> Result<()> {
    let entities = load_requests(
        lc,
        edit.after.id,
        r#" AND r."status" IN (?2, ?3) AND r."is4k" = ?4"#,
        vec![Bind::Int(APPROVED), Bind::Int(FAILED), Bind::Bool(four_k)],
    )
    .await?;
    let mut completed = Vec::new();
    for mut entity in entities {
        let key = entity.row.is4k;
        let mut should_complete = false;
        if matches!(status_of(&edit.after, key), M_AVAILABLE | M_DELETED)
            && edit.after.media_type == "movie"
        {
            should_complete = true;
        } else if edit.after.media_type == "tv" {
            if !entity.row.episodes.is_empty() {
                continue;
            }
            let mut all_ready = true;
            let mut seasons_touched = false;
            for request_season in &mut entity.row.seasons {
                let Some(current) = edit
                    .after
                    .seasons
                    .iter()
                    .find(|s| s.season_number == request_season.season_number)
                else {
                    all_ready = false;
                    continue;
                };
                let previous = db_seasons
                    .iter()
                    .find(|s| s.season_number == request_season.season_number)
                    .map(|s| season_status(s, key));
                let now = season_status(current, key);
                let status_changed = Some(now) != previous;
                if (status_changed || request_season.status == COMPLETED)
                    && matches!(now, M_AVAILABLE | M_DELETED)
                {
                    if request_season.status != COMPLETED {
                        seasons_touched = true;
                    }
                    request_season.status = COMPLETED;
                } else {
                    all_ready = false;
                }
            }
            should_complete = all_ready;
            if !should_complete && seasons_touched {
                lc.save(&mut entity).await?;
            }
        }
        if should_complete {
            entity.row.status = COMPLETED;
            completed.push(entity);
        }
    }
    for mut entity in completed {
        lc.save(&mut entity).await?;
    }
    Ok(())
}

/// The media as `res.json` prints the saved entity: loaded seasons in
/// column order, created ones in the order their properties were set.
pub(super) fn saved_json(
    edit: &MediaEdit,
    settings: &crate::settings::Settings,
    downloads: &crate::downloads::Downloads,
) -> Value {
    let mut json = crate::media::media_json(&edit.after, settings, downloads, true);
    let seasons: Vec<Value> = edit
        .after
        .seasons
        .iter()
        .enumerate()
        .map(|(i, season)| {
            edit.fresh.iter().find(|f| f.index == i).map_or_else(
                || crate::media::season_json(season),
                |f| fresh_season_json(season, f.four_k),
            )
        })
        .collect();
    if let Some(obj) = json.as_object_mut() {
        obj.insert(String::from("seasons"), Value::Array(seasons));
    }
    json
}

/// A season created by `seasonRepository.create({ seasonNumber })`, its
/// status set, then merged with the inserted id and the defaults read back.
fn fresh_season_json(season: &SeasonRow, four_k: bool) -> Value {
    let text = |v: &Option<String>| v.as_deref().map_or(Value::Null, Value::from);
    let mut out = Map::new();
    out.insert(
        String::from("seasonNumber"),
        Value::from(season.season_number),
    );
    let (first, second) = if four_k {
        (("status4k", season.status4k), ("status", season.status))
    } else {
        (("status", season.status), ("status4k", season.status4k))
    };
    out.insert(first.0.to_owned(), Value::from(first.1));
    out.insert(String::from("id"), Value::from(season.id));
    out.insert(second.0.to_owned(), Value::from(second.1));
    out.insert(String::from("createdAt"), text(&season.created_at));
    out.insert(String::from("updatedAt"), text(&season.updated_at));
    Value::Object(out)
}

/// The lifecycle handle for a request.
pub(super) fn lc_of(ctx: &super::Ready<'_>) -> Lc {
    Lc {
        state: Arc::clone(&ctx.shared),
        settings: Arc::clone(&ctx.settings),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_seasons_and_resets() {
        let mut edit = MediaEdit::new(MediaRow {
            id: 3,
            media_type: String::from("tv"),
            seasons: vec![SeasonRow {
                id: 9,
                season_number: 1,
                status: 1,
                status4k: 1,
                ..SeasonRow::default()
            }],
            service_id: Some(1),
            rating_key4k: Some(String::from("k")),
            ..MediaRow::default()
        });
        edit.set_season_status(1, false, M_AVAILABLE);
        edit.set_season_status(2, true, M_AVAILABLE);
        assert_eq!(edit.after.seasons.len(), 2, "one season created");
        assert_eq!(
            edit.fresh,
            vec![FreshSeason {
                index: 1,
                four_k: true
            }],
            "the created season"
        );
        let json = edit
            .after
            .seasons
            .last()
            .map(|s| fresh_season_json(s, true))
            .unwrap_or_default();
        let keys: Vec<&String> = json
            .as_object()
            .map(|o| o.keys().collect())
            .unwrap_or_default();
        assert_eq!(
            keys,
            [
                "seasonNumber",
                "status4k",
                "id",
                "status",
                "createdAt",
                "updatedAt"
            ],
            "set order, then the merged values"
        );
        reset_service_data(&mut edit.after, Some(false));
        assert_eq!(edit.after.service_id, None, "regular cleared");
        assert_eq!(edit.after.rating_key4k.as_deref(), Some("k"), "4k kept");
        let changes = media_changes(&edit.before, &edit.after);
        assert_eq!(changes.len(), 1, "only serviceId changed");
    }
}
