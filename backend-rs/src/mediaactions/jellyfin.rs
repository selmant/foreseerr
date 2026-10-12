//! `jellyfin.ts`: played state on the media server, through the user's
//! linked Jellyfin session.

use std::collections::HashMap;

use serde_json::Value;

use super::dispatcher::{Fut, Provider, Thrown, Write};
use super::env::Env;
use super::jellyfincache;
use super::types::{Capabilities, EpisodeWrite, Item, ProviderId, Status, WATCHED_ONLY};
use crate::db::Bind;
use crate::jellyfin::actions::{self, Failed};
use crate::jellyfin::JellyfinClient;
use crate::library::{Lib, Link};
use crate::mappinglayer::MediaType;
use crate::settings::public::truthy;

/// The error of a title without a Jellyfin item.
pub const NOT_MAPPED: &str = "No Jellyfin mapping for item";

/// `JELLYFIN_STATUS_BATCH_CHUNK_SIZE`.
pub const CHUNK_SIZE: usize = 50;

/// `Error('').message`: Node's `ApiError` carries no message.
const fn api_error(_: Failed) -> Thrown {
    String::new()
}

/// `fetchJellyfinStatusChunks(ids, fetch)`: bounded chunks, one failure
/// not erasing the others. `(entries, failedIds)`.
pub async fn fetch_chunks<F, Fut2>(ids: &[String], fetch: F) -> (Vec<Value>, Vec<String>)
where
    F: Fn(Vec<String>) -> Fut2,
    Fut2: std::future::Future<Output = Result<Vec<Value>, Failed>>,
{
    let mut unique: Vec<String> = Vec::new();
    for id in ids {
        if !unique.contains(id) {
            unique.push(id.clone());
        }
    }
    let mut entries = Vec::new();
    let mut failed = Vec::new();
    for chunk in unique.chunks(CHUNK_SIZE) {
        match fetch(chunk.to_vec()).await {
            Ok(found) => entries.extend(found),
            Err(Failed) => failed.extend(chunk.iter().cloned()),
        }
    }
    (entries, failed)
}

/// `createUserJellyfinClient(userId)`: the client, or `None` when the
/// server isn't Jellyfin or the user isn't linked.
async fn user_client(env: &Env<'_>) -> Result<Option<JellyfinClient>, Thrown> {
    let lib = Lib {
        state: env.state,
        settings: &env.settings,
        user_id: env.user,
    };
    Ok(match lib.link().await? {
        Link::Linked(linked) => Some(linked.client),
        Link::Code(_) => None,
    })
}

/// `getJellyfinEpisodeClient(userId)`.
async fn episode_client(env: &Env<'_>) -> Result<Option<JellyfinClient>, Thrown> {
    if env.provider_off("jellyfin") || !env.jellyfin_server() {
        return Ok(None);
    }
    user_client(env).await
}

/// `media?.jellyfinMediaId ?? media?.jellyfinMediaId4k` of a row.
fn jellyfin_id(row: &serde_json::Map<String, Value>) -> Option<String> {
    let pick = |key: &str| row.get(key).and_then(Value::as_str).map(str::to_owned);
    pick("jellyfinMediaId").or_else(|| pick("jellyfinMediaId4k"))
}

/// The title's Jellyfin item (`findOne({ tmdbId, mediaType })`), when it
/// has a non-empty one.
async fn media_item(
    env: &Env<'_>,
    media_type: MediaType,
    tmdb_id: i64,
) -> Result<Option<String>, Thrown> {
    let rows = env
        .state
        .db
        .rows(
            r#"SELECT "jellyfinMediaId", "jellyfinMediaId4k" FROM "media" WHERE "tmdbId" = ?1 AND "mediaType" = ?2 LIMIT 1"#,
            &[Bind::Int(tmdb_id), Bind::Text(media_type.as_str().to_owned())],
        )
        .await
        .map_err(|e| format!("{e:#}"))?;
    Ok(rows
        .first()
        .and_then(jellyfin_id)
        .filter(|id| !id.is_empty()))
}

/// `findMediaItems(items)`: each title's row by `movie:id` / `tv:id`.
async fn media_items(
    env: &Env<'_>,
    items: &[Item],
) -> Result<HashMap<String, Option<String>>, Thrown> {
    let mut out = HashMap::new();
    for media_type in [MediaType::Movie, MediaType::Tv] {
        let ids: Vec<i64> = items
            .iter()
            .filter(|i| i.media_type == media_type)
            .map(|i| i.tmdb_id)
            .collect();
        if ids.is_empty() {
            continue;
        }
        let marks: Vec<String> = (2..ids.len() + 2).map(|n| format!("?{n}")).collect();
        let sql = format!(
            r#"SELECT "tmdbId", "jellyfinMediaId", "jellyfinMediaId4k" FROM "media" WHERE "mediaType" = ?1 AND "tmdbId" IN ({})"#,
            marks.join(", ")
        );
        let mut binds = vec![Bind::Text(media_type.as_str().to_owned())];
        binds.extend(ids.into_iter().map(Bind::Int));
        let rows = env
            .state
            .db
            .rows(&sql, &binds)
            .await
            .map_err(|e| format!("{e:#}"))?;
        for row in rows {
            let tmdb = crate::jsval::number_of(row.get("tmdbId"));
            out.insert(
                format!("{}:{}", media_type.as_str(), crate::jsnum::to_string(tmdb)),
                jellyfin_id(&row),
            );
        }
    }
    Ok(out)
}

/// `UserData?.Played ?? false`.
fn played(item: &Value) -> bool {
    item.get("UserData")
        .and_then(|d| d.get("Played"))
        .is_some_and(|p| truthy(Some(p)))
}

/// `JellyfinMediaActionProvider`.
#[derive(Debug)]
pub struct JellyfinProvider<'a> {
    env: &'a Env<'a>,
}

impl<'a> JellyfinProvider<'a> {
    /// For one request.
    #[must_use]
    pub const fn new(env: &'a Env<'a>) -> Self {
        Self { env }
    }

    /// `getClient(userId)`.
    async fn client(&self) -> Result<JellyfinClient, Thrown> {
        user_client(self.env)
            .await?
            .ok_or_else(|| String::from("Jellyfin client not available"))
    }

    async fn mapped(&self, item: Item) -> Result<String, Thrown> {
        media_item(self.env, item.media_type, item.tmdb_id)
            .await?
            .ok_or_else(|| String::from(NOT_MAPPED))
    }

    async fn read(&self, item: Item) -> Result<Status, Thrown> {
        let id = self.mapped(item).await?;
        let client = self.client().await?;
        let data = actions::item_data(&client, &id).await.map_err(api_error)?;
        Ok(Status::of(data.as_ref().is_some_and(played), None))
    }

    async fn read_many(&self, items: &[Item]) -> Result<Vec<(Item, Status)>, Thrown> {
        if items.is_empty() {
            return Ok(Vec::new());
        }
        let client = self.client().await?;
        let media = media_items(self.env, items).await?;
        let mut results = Vec::new();
        let mut to_fetch: Vec<String> = Vec::new();
        let mut by_id: Vec<(String, Vec<Item>)> = Vec::new();
        for item in items {
            let id = media
                .get(&item.key())
                .cloned()
                .flatten()
                .filter(|id| !id.is_empty());
            let Some(id) = id else {
                results.push((*item, Status::failed(NOT_MAPPED)));
                continue;
            };
            if let Some(watched) = jellyfincache::get(self.env.user, &id) {
                results.push((*item, Status::of(watched, None)));
                continue;
            }
            if let Some((_, mapped)) = by_id.iter_mut().find(|(known, _)| *known == id) {
                mapped.push(*item);
            } else {
                to_fetch.push(id.clone());
                by_id.push((id, vec![*item]));
            }
        }
        let client = &client;
        let (entries, failed) = fetch_chunks(&to_fetch, |chunk| async move {
            actions::items_data(client, &chunk).await
        })
        .await;
        for (id, mapped) in by_id {
            let entry = entries
                .iter()
                .find(|e| e.get("Id").and_then(Value::as_str) == Some(id.as_str()));
            let Some(entry) = entry else {
                let error = if failed.contains(&id) {
                    "Failed to read Jellyfin watch state"
                } else {
                    "Jellyfin did not return item status"
                };
                results.extend(mapped.into_iter().map(|item| (item, Status::failed(error))));
                continue;
            };
            let watched = played(entry);
            jellyfincache::set(self.env.user, &id, watched);
            results.extend(
                mapped
                    .into_iter()
                    .map(|item| (item, Status::of(watched, None))),
            );
        }
        Ok(results)
    }

    async fn set_watched(&self, item: Item, watched: bool) -> Result<Status, Thrown> {
        let id = self.mapped(item).await?;
        let client = self.client().await?;
        actions::set_played(&client, &id, watched)
            .await
            .map_err(api_error)?;
        jellyfincache::invalidate(Some(self.env.user));
        jellyfincache::set(self.env.user, &id, watched);
        Ok(Status::of(watched, None))
    }
}

impl Provider for JellyfinProvider<'_> {
    fn id(&self) -> ProviderId {
        ProviderId::Jellyfin
    }

    fn capabilities(&self) -> Capabilities {
        WATCHED_ONLY
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
                Write::Mark(_) => self.set_watched(item, true).await,
                Write::Unmark { .. } => self.set_watched(item, false).await,
                Write::Rate(_) => Err(String::from("Jellyfin does not support rating writes")),
            }
        })
    }
}

/// `JellyfinMediaActionProvider.isAvailable(userId)`.
///
/// # Errors
///
/// Database failures.
pub async fn available(env: &Env<'_>) -> Result<bool, Thrown> {
    if env.provider_off("jellyfin") || !env.jellyfin_server() {
        return Ok(false);
    }
    let rows = env
        .state
        .db
        .rows(
            r#"SELECT "jellyfinUserId", "jellyfinAuthToken", "jellyfinDeviceId" FROM "user" WHERE "id" = ?1"#,
            &[Bind::Int(env.user)],
        )
        .await
        .map_err(|e| format!("{e:#}"))?;
    let row = rows.first();
    Ok(["jellyfinUserId", "jellyfinAuthToken", "jellyfinDeviceId"]
        .iter()
        .all(|k| truthy(row.and_then(|r| r.get(*k)))))
}

/// `jellyfinEpisodeActions.isAvailable(userId)`.
///
/// # Errors
///
/// Database failures.
pub async fn episode_available(env: &Env<'_>) -> Result<bool, Thrown> {
    Ok(episode_client(env).await?.is_some())
}

/// `list.find(x => x.IndexNumber === n)`, throwing (`Err`) on a null
/// element before the match as Node's property read does.
fn find_index_number(list: &[Value], number: i64) -> Result<Option<&Value>, Failed> {
    for entry in list {
        if entry.is_null() {
            return Err(Failed);
        }
        let index = entry.get("IndexNumber").and_then(Value::as_f64);
        if index.is_some_and(|i| crate::jsval::same(i, crate::jsnum::from_i64(number))) {
            return Ok(Some(entry));
        }
    }
    Ok(None)
}

fn id_of(item: &Value) -> String {
    crate::jsnum::value_string(item.get("Id"))
}

/// `jellyfinEpisodeActions.setEpisodeWatched`.
///
/// # Errors
///
/// Database failures.
pub async fn set_episode_watched(
    env: &Env<'_>,
    tmdb_id: i64,
    season: i64,
    episode: i64,
    watched: bool,
) -> Result<EpisodeWrite, Thrown> {
    let Some(client) = episode_client(env).await? else {
        return Ok(EpisodeWrite::Skipped);
    };
    let Some(series) = media_item(env, MediaType::Tv, tmdb_id).await? else {
        return Ok(EpisodeWrite::Skipped);
    };
    let attempt = async {
        let seasons = actions::seasons(&client, &series).await?;
        let Some(found) = find_index_number(&seasons, season)? else {
            return Ok(EpisodeWrite::Skipped);
        };
        let episodes = actions::episodes(&client, &series, &id_of(found)).await?;
        let Some(found) = find_index_number(&episodes, episode)? else {
            return Ok(EpisodeWrite::Skipped);
        };
        let id = id_of(found);
        actions::set_played(&client, &id, watched).await?;
        jellyfincache::invalidate(Some(env.user));
        jellyfincache::set(env.user, &id, watched);
        Ok::<_, Failed>(EpisodeWrite::Done(true))
    };
    Ok(attempt.await.unwrap_or(EpisodeWrite::Done(false)))
}

/// `jellyfinEpisodeActions.setItemWatched`: an episode by its Jellyfin
/// id.
///
/// # Errors
///
/// Database failures.
pub async fn set_item_watched(env: &Env<'_>, item_id: &str, watched: bool) -> Result<bool, Thrown> {
    let Some(client) = episode_client(env).await? else {
        return Ok(false);
    };
    let attempt = async {
        let item = actions::item_data(&client, item_id).await?;
        if item.is_none_or(|i| i.get("Type").and_then(Value::as_str) != Some("Episode")) {
            return Ok(false);
        }
        actions::set_played(&client, item_id, watched).await?;
        jellyfincache::invalidate(Some(env.user));
        jellyfincache::set(env.user, item_id, watched);
        Ok::<_, Failed>(true)
    };
    Ok(attempt.await.unwrap_or(false))
}

/// `jellyfinEpisodeActions.getSeasonStatus`.
///
/// # Errors
///
/// Database failures.
pub async fn season_status(
    env: &Env<'_>,
    tmdb_id: i64,
    season: i64,
) -> Result<(bool, Vec<f64>), Thrown> {
    let Some(client) = episode_client(env).await? else {
        return Ok((false, Vec::new()));
    };
    let Some(series) = media_item(env, MediaType::Tv, tmdb_id).await? else {
        return Ok((false, Vec::new()));
    };
    let attempt = async {
        let seasons = actions::seasons(&client, &series).await?;
        let Some(found) = find_index_number(&seasons, season)? else {
            return Ok((true, Vec::new()));
        };
        let episodes = actions::episodes(&client, &series, &id_of(found)).await?;
        let mut numbers: Vec<f64> = episodes
            .iter()
            .filter(|e| played(e))
            .filter_map(|e| e.get("IndexNumber").and_then(Value::as_f64))
            .collect();
        numbers.sort_by(f64::total_cmp);
        Ok::<_, Failed>((true, numbers))
    };
    Ok(attempt.await.unwrap_or((false, Vec::new())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn run<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .map_or_else(|_| std::process::abort(), |rt| rt.block_on(future))
    }

    #[test]
    fn chunks_at_the_bound() {
        let calls = Mutex::new(Vec::new());
        let ids: Vec<String> = (0..100).map(|i| format!("item-{i}")).collect();
        let (entries, failed) = run(fetch_chunks(&ids, |chunk| {
            crate::sync::lock(&calls).push(chunk.len());
            async move { Ok(chunk.into_iter().map(Value::from).collect()) }
        }));
        assert_eq!(
            *crate::sync::lock(&calls),
            vec![CHUNK_SIZE, CHUNK_SIZE],
            "two full chunks"
        );
        assert_eq!(entries.len(), 100, "every entry");
        assert!(failed.is_empty(), "no failures");
    }

    #[test]
    fn isolates_a_failed_chunk() {
        let mut ids: Vec<String> = (0..50).map(|i| format!("first-{i}")).collect();
        ids.extend((0..50).map(|i| format!("second-{i}")));
        ids.push(String::from("first-0"));
        let (entries, failed) = run(fetch_chunks(&ids, |chunk| async move {
            if chunk.first().map(String::as_str) == Some("first-0") {
                Err(Failed)
            } else {
                Ok(chunk.into_iter().map(Value::from).collect())
            }
        }));
        assert_eq!(failed.len(), 50, "first chunk failed");
        assert_eq!(entries.len(), 50, "second chunk kept, deduplicated");
    }

    #[test]
    fn index_lookup() {
        let list = vec![
            serde_json::json!({"IndexNumber": 1, "Id": "a"}),
            Value::Null,
        ];
        assert!(
            find_index_number(&list, 1).is_ok_and(|f| f.is_some()),
            "found first"
        );
        assert_eq!(find_index_number(&list, 2), Err(Failed), "null throws");
    }
}
