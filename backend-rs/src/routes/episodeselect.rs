//! Episode selections for `POST /request` and `PUT /request/{id}`.
//!
//! `parseEpisodeSelection`, `episodeRequestsAvailable`, the TVDB episode
//! catalog and `resolveEpisodeSelection` (`server/lib/episodeRequests.ts`,
//! `server/lib/watchAhead.ts`), the coverage rules of
//! `buildEpisodeRequestPlan`, and the episode rows a save writes.

use std::collections::HashSet;

use serde_json::{json, Map, Value};

use super::draft::Draft;
use super::{Outcome, Ready};
use crate::db::{Bind, EpisodeRequestRow, MediaRow, RequestRow};
use crate::jobs::episode_request_sync::{
    played_tvdb_ids, watch_ahead_window, CatalogEpisode, PlayedEpisode,
};
use crate::library::{Lib, Link};
use crate::lifecycle::{COMPLETED, DECLINED};
use crate::settings::public::truthy;
use crate::settings::Settings;

/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE: u64 = 9_007_199_254_740_991;
/// The schema's `max(2_147_483_647)`.
const MAX_ID: u64 = 2_147_483_647;
/// `MediaStatus.AVAILABLE`.
const M_AVAILABLE: i64 = 5;

/// A parsed `episodeSelection`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Selection {
    Single(i64),
    Range(i64, i64),
    After(i64),
    WatchAhead(i64),
}

/// Why a selection can't be used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Refused {
    /// The thrown message (`InvalidEpisodeSelectionError`, a 400).
    Invalid(String),
    /// A case Node words or decides in a way not reproduced here.
    Forward(String),
}

fn forward(why: &str) -> Refused {
    Refused::Forward(why.to_owned())
}

/// One id field of a selection: its zod issues (the safe-integer check,
/// then the maximum) and the id when there are none.
fn id_field(
    obj: &Map<String, Value>,
    key: &str,
    issues: &mut Vec<Value>,
) -> Result<Option<i64>, Refused> {
    let Some(Value::Number(n)) = obj.get(key) else {
        return Err(forward("an episode id the validator rejects"));
    };
    let (unsafe_int, too_big) = if let Some(u) = n.as_u64() {
        (u > MAX_SAFE, u > MAX_ID)
    } else {
        match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f >= 1.0 => {
                (f > 9_007_199_254_740_991.0, f > 2_147_483_647.0)
            }
            _ => return Err(forward("an episode id the validator rejects")),
        }
    };
    if unsafe_int {
        issues.push(json!({
            "code": "too_big",
            "maximum": MAX_SAFE,
            "note": "Integers must be within the safe integer range.",
            "origin": "int",
            "inclusive": true,
            "path": [key],
            "message": "Too big: expected int to be <=9007199254740991",
        }));
    }
    if too_big {
        issues.push(json!({
            "origin": "number",
            "code": "too_big",
            "maximum": MAX_ID,
            "inclusive": true,
            "path": [key],
            "message": "Too big: expected number to be <=2147483647",
        }));
    }
    if unsafe_int || too_big {
        return Ok(None);
    }
    let id = n
        .as_i64()
        .or_else(|| n.as_f64().and_then(|f| format!("{f:.0}").parse().ok()));
    match id {
        Some(id) if id >= 1 => Ok(Some(id)),
        _ => Err(forward("an episode id the validator rejects")),
    }
}

/// `parseEpisodeSelection(input)`: the selection, or the `ZodError`
/// message. Shapes the validator refuses go to Node.
pub(super) fn parse(input: &Value) -> Result<Selection, Refused> {
    let Value::Object(obj) = input else {
        return Err(forward("an episode selection the validator rejects"));
    };
    let kind = obj.get("type").and_then(Value::as_str);
    let keys: &[&str] = match kind {
        Some("single") => &["type", "episodeTvdbId"],
        Some("range") => &["type", "startEpisodeTvdbId", "endEpisodeTvdbId"],
        Some("after") => &["type", "startEpisodeTvdbId"],
        Some("watchAhead") => &["type", "count"],
        _ => return Err(forward("an episode selection the validator rejects")),
    };
    if obj.len() != keys.len() || !keys.iter().all(|k| obj.contains_key(*k)) {
        return Err(forward("an episode selection the validator rejects"));
    }
    let mut issues = Vec::new();
    let selection = match kind {
        Some("single") => id_field(obj, "episodeTvdbId", &mut issues)?.map(Selection::Single),
        Some("range") => {
            let start = id_field(obj, "startEpisodeTvdbId", &mut issues)?;
            let end = id_field(obj, "endEpisodeTvdbId", &mut issues)?;
            start.zip(end).map(|(s, e)| Selection::Range(s, e))
        }
        Some("after") => id_field(obj, "startEpisodeTvdbId", &mut issues)?.map(Selection::After),
        _ => {
            let count = obj.get("count").and_then(|c| {
                c.as_i64().or_else(|| {
                    c.as_f64()
                        .filter(|f| f.fract() == 0.0)
                        .and_then(|f| format!("{f:.0}").parse().ok())
                })
            });
            match count {
                Some(count) if (1..=50).contains(&count) => Some(Selection::WatchAhead(count)),
                _ => return Err(forward("a watch-ahead count the validator rejects")),
            }
        }
    };
    match selection {
        Some(selection) if issues.is_empty() => Ok(selection),
        _ => serde_json::to_string_pretty(&Value::Array(issues))
            .map_err(|e| Refused::Forward(format!("wording the zod issues failed: {e}")))
            .and_then(|message| Err(Refused::Invalid(message))),
    }
}

/// `[TMDB] Failed to fetch ...: <message>`, the 500 Node answers when
/// TMDB fails.
pub(super) fn tmdb_failed(ctx: &Ready<'_>, movie: bool, error: &anyhow::Error) -> Outcome {
    let what = if movie { "movie" } else { "TV show" };
    let message = crate::outbound::failure_in(error).unwrap_or_else(|| format!("{error:#}"));
    ctx.error(
        500,
        &format!("[TMDB] Failed to fetch {what} details: {message}"),
    )
}

/// `episodeRequestsAvailable(settings, media)`: partial requests on and
/// TVDB the metadata provider for this kind of show.
pub(super) fn available(settings: &Settings, details: &Value) -> bool {
    let provider = if super::tv::is_anime(details) {
        "/metadataSettings/anime"
    } else {
        "/metadataSettings/tv"
    };
    truthy(settings.get("/main/partialRequestsEnabled")) && settings.str(provider) == "tvdb"
}

/// One catalog entry as `getEpisodeCatalog` maps it, when its fields have
/// the types the entities store.
fn catalog_episode(item: &Value) -> Option<CatalogEpisode> {
    let int = |key: &str| item.get(key).and_then(Value::as_i64);
    let title = match item.get("title") {
        Some(Value::String(title)) => title.clone(),
        _ => return None,
    };
    let air_date = match item.get("airDate") {
        None => None,
        Some(Value::String(date)) => Some(date.clone()),
        Some(_) => return None,
    };
    Some(CatalogEpisode {
        tvdb_id: int("tvdbId")?,
        season: int("seasonNumber")?,
        episode: int("episodeNumber")?,
        title,
        air_date,
    })
}

/// `Tvdb.getInstance()` and `getEpisodeCatalog({ tvId })` in TVDB's
/// default language. Failures of TVDB or TMDB themselves go to Node.
pub(super) async fn catalog(
    ctx: &Ready<'_>,
    tv_id: impl crate::tmdb::PathNumber,
) -> Result<Vec<CatalogEpisode>, Refused> {
    let client = &ctx.state.outbound;
    if let Err(e) = crate::tvdb::ensure_instance(client).await {
        return Err(Refused::Forward(format!("the TVDB login failed: {e:#}")));
    }
    let show = ctx
        .state
        .tmdb
        .tv(tv_id, crate::tvdb::DEFAULT_LANGUAGE)
        .await
        .map_err(|e| Refused::Forward(format!("TMDB failed: {e:#}")))?;
    let tvdb_id = match show.pointer("/external_ids/tvdb_id") {
        None | Some(Value::Null) => None,
        Some(v) => match v.as_i64() {
            Some(-1) => None,
            Some(id) => Some(id),
            None => return Err(forward("a TVDB id that isn't an integer")),
        },
    };
    let Some(tvdb_id) = tvdb_id else {
        return Err(Refused::Invalid(String::from(
            "[TVDB] TVDB ID not found for series",
        )));
    };
    let entries = match super::episodes::tvdb_episodes(
        client,
        tvdb_id,
        crate::tvdb::DEFAULT_LANGUAGE,
    )
    .await
    {
        Ok(Ok(entries)) => entries,
        Ok(Err(why)) => return Err(Refused::Forward(why)),
        Err(e) => return Err(Refused::Forward(format!("TVDB failed: {e:#}"))),
    };
    entries
        .iter()
        .map(|(_, _, item)| {
            catalog_episode(item).ok_or_else(|| forward("a catalog entry with odd field types"))
        })
        .collect()
}

/// `loadPlayedTvdbIdsForSeries`: what the user has played of the series in
/// Jellyfin; nothing without a series id, a linked user or an answer.
pub(super) async fn played(
    ctx: &Ready<'_>,
    user_id: i64,
    series_id: Option<&str>,
    catalog: &[CatalogEpisode],
) -> HashSet<i64> {
    let Some(series_id) = series_id.filter(|s| !s.is_empty()) else {
        return HashSet::new();
    };
    let lib = Lib {
        state: ctx.state,
        settings: &ctx.settings,
        user_id,
    };
    let items = match lib.link().await {
        Ok(Link::Linked(linked)) => linked
            .client
            .series_episodes(series_id)
            .await
            .map_err(|e| format!("{e:?}")),
        Ok(Link::Code(_)) => return HashSet::new(),
        Err(why) => Err(why),
    };
    match items {
        Ok(items) => {
            let items: Vec<PlayedEpisode> = items
                .iter()
                .map(|i| PlayedEpisode {
                    tvdb_id: i.provider("Tvdb").map(str::to_owned),
                    season: i.int("ParentIndexNumber"),
                    episode: i.int("IndexNumber"),
                    played: i.played(),
                })
                .collect();
            played_tvdb_ids(catalog, &items)
        }
        Err(why) => {
            tracing::warn!(
                "Failed to load Jellyfin watch progress for watch-ahead: user {user_id}, series {series_id}: {why}"
            );
            HashSet::new()
        }
    }
}

/// A resolved selection.
#[derive(Debug, Clone)]
pub(super) struct Resolved {
    pub(super) kind: &'static str,
    pub(super) start: i64,
    pub(super) end: Option<i64>,
    pub(super) watch_ahead: Option<i64>,
    pub(super) episodes: Vec<CatalogEpisode>,
}

/// The number of distinct seasons among `episodes`.
pub(super) fn quota_units(episodes: &[CatalogEpisode]) -> i64 {
    let seasons: HashSet<i64> = episodes.iter().map(|e| e.season).collect();
    i64::try_from(seasons.len()).unwrap_or(i64::MAX)
}

/// `resolveEpisodeSelection(selection, catalog, allowSpecials, played)`.
pub(super) fn resolve(
    selection: Selection,
    catalog: &[CatalogEpisode],
    allow_specials: bool,
    played: &HashSet<i64>,
) -> Result<Resolved, Refused> {
    let invalid = |m: &str| Err(Refused::Invalid(m.to_owned()));
    let none_left = "No episodes are available for this selection.";
    if let Selection::WatchAhead(count) = selection {
        let Some(first) = catalog.iter().find(|e| e.season > 0) else {
            return invalid(none_left);
        };
        let desired = watch_ahead_window(catalog, count, played);
        return Ok(Resolved {
            kind: "watchAhead",
            start: desired.first().unwrap_or(first).tvdb_id,
            end: None,
            watch_ahead: Some(count),
            episodes: desired,
        });
    }
    // `new Map(...)`: the last entry with an id wins.
    let index_of = |id: i64| catalog.iter().rposition(|e| e.tvdb_id == id);
    let (kind, start_id) = match selection {
        Selection::Single(id) => ("single", id),
        Selection::Range(id, _) => ("range", id),
        Selection::After(id) | Selection::WatchAhead(id) => ("after", id),
    };
    let Some((start_index, start)) = index_of(start_id).and_then(|i| Some((i, catalog.get(i)?)))
    else {
        return invalid("The selected TVDB episode does not exist.");
    };
    if start.season == 0 && !allow_specials {
        return invalid("Special episode requests are disabled.");
    }
    let mut end = None;
    let episodes: Vec<CatalogEpisode> = if let Selection::Single(_) = selection {
        vec![start.clone()]
    } else {
        if start.season == 0 {
            return invalid("Ranges and ongoing requests cannot start with a special.");
        }
        let last = if let Selection::Range(_, end_id) = selection {
            let Some(end_index) = index_of(end_id) else {
                return invalid("The selected TVDB range endpoint does not exist.");
            };
            let end_episode = catalog.get(end_index);
            if end_episode.is_none_or(|e| e.season == 0) || end_index < start_index {
                return invalid("Episode range endpoints are invalid or reversed.");
            }
            end = end_episode.map(|e| e.tvdb_id);
            end_index + 1
        } else {
            catalog.len()
        };
        catalog
            .get(start_index..last)
            .unwrap_or_default()
            .iter()
            .filter(|e| e.season > 0)
            .cloned()
            .collect()
    };
    if episodes.is_empty() {
        return invalid(none_left);
    }
    Ok(Resolved {
        kind,
        start: start.tvdb_id,
        end,
        watch_ahead: None,
        episodes,
    })
}

/// `buildEpisodeRequestPlan`'s episode list: everything for `after`;
/// otherwise what no other active request of this quality covers (by
/// season or episode) and the library doesn't have.
pub(super) fn uncovered(
    resolved: &Resolved,
    coverage: &[&RequestRow],
    media: Option<&MediaRow>,
    four_k: bool,
) -> Vec<CatalogEpisode> {
    if resolved.kind == "after" {
        return resolved.episodes.clone();
    }
    let seasons: HashSet<i64> = coverage
        .iter()
        .flat_map(|r| r.seasons.iter().map(|s| s.season_number))
        .collect();
    let episodes: HashSet<i64> = coverage
        .iter()
        .flat_map(|r| r.episodes.iter().map(|e| e.tvdb_id))
        .collect();
    resolved
        .episodes
        .iter()
        .filter(|e| {
            !seasons.contains(&e.season)
                && !episodes.contains(&e.tvdb_id)
                && !media.is_some_and(|m| {
                    m.seasons.iter().any(|s| {
                        s.season_number == e.season
                            && (if four_k { s.status4k } else { s.status }) == M_AVAILABLE
                    })
                })
        })
        .cloned()
        .collect()
}

/// The active requests of one quality (`status` neither declined nor
/// completed); none when `is4k` was undefined.
pub(super) fn active(requests: &[RequestRow], four_k: Option<bool>) -> Vec<&RequestRow> {
    let Some(four_k) = four_k else {
        return Vec::new();
    };
    requests
        .iter()
        .filter(|r| r.is4k == four_k && r.status != DECLINED && r.status != COMPLETED)
        .collect()
}

/// `ongoingEpisodeRequestLockKey(tmdbId, is4k)`.
pub(super) fn lock_key(tmdb_id: i64, four_k: bool) -> String {
    format!("{tmdb_id}:{}", if four_k { "4k" } else { "sd" })
}

/// Whether saving a row with `key` and `kind` would break
/// `IDX_media_request_active_ongoing_episode` (as this database defines
/// it) against another active request.
///
/// # Errors
///
/// Database errors.
pub(super) async fn ongoing_conflict(
    ctx: &Ready<'_>,
    key: &str,
    kind: &str,
    own_id: Option<i64>,
) -> anyhow::Result<bool> {
    let db = &ctx.state.db;
    let definition = if db.is_postgres() {
        r#"SELECT CAST(COUNT(*) AS BIGINT) FROM "pg_indexes" WHERE "indexname" = 'IDX_media_request_active_ongoing_episode' AND "indexdef" LIKE '%watchAhead%'"#
    } else {
        r#"SELECT COUNT(*) FROM "sqlite_master" WHERE "name" = 'IDX_media_request_active_ongoing_episode' AND "sql" LIKE '%watchAhead%'"#
    };
    let exists = if db.is_postgres() {
        r#"SELECT CAST(COUNT(*) AS BIGINT) FROM "pg_indexes" WHERE "indexname" = 'IDX_media_request_active_ongoing_episode'"#
    } else {
        r#"SELECT COUNT(*) FROM "sqlite_master" WHERE "name" = 'IDX_media_request_active_ongoing_episode'"#
    };
    if db.scalar(exists, &[]).await? == 0 {
        return Ok(false);
    }
    let kinds: &[&str] = if db.scalar(definition, &[]).await? > 0 {
        &["after", "watchAhead"]
    } else {
        &["after"]
    };
    if !kinds.contains(&kind) {
        return Ok(false);
    }
    let list = kinds
        .iter()
        .map(|k| format!("'{k}'"))
        .collect::<Vec<_>>()
        .join(", ");
    let count = db
        .scalar(
            &format!(
                r#"SELECT CAST(COUNT(*) AS BIGINT) FROM "media_request" WHERE "ongoingEpisodeRequestKey" = ?1 AND "episodeSelectionType" IN ({list}) AND "status" NOT IN (3, 5) AND "id" <> ?2"#
            ),
            &[Bind::Text(key.to_owned()), Bind::Int(own_id.unwrap_or(-1))],
        )
        .await?;
    Ok(count > 0)
}

/// Insert the episode rows of a request (the cascade of its save), in
/// order.
///
/// # Errors
///
/// Database errors.
pub(super) async fn insert_episodes(
    exec: &mut crate::dbtx::Exec<'_>,
    request_id: i64,
    episodes: &[CatalogEpisode],
    status: i64,
) -> anyhow::Result<()> {
    for e in episodes {
        exec.execute(
                r#"INSERT INTO "episode_request" ("tvdbId", "seasonNumber", "episodeNumber", "title", "airDate", "status", "createdAt", "updatedAt", "requestId") VALUES (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?7)"#,
                &[
                    Bind::Int(e.tvdb_id),
                    Bind::Int(e.season),
                    Bind::Int(e.episode),
                    Bind::Text(e.title.clone()),
                    Bind::OptText(e.air_date.clone()),
                    Bind::Int(status),
                    Bind::Int(request_id),
                ],
            )
            .await?;
    }
    Ok(())
}

/// The new episode entities as the response prints them after the
/// insert: the assigned fields, then the unset nullable dates, `id` and the
/// dates read back. `rows` are the stored rows of the request.
pub(super) fn episodes_json(
    episodes: &[CatalogEpisode],
    status: i64,
    rows: &[EpisodeRequestRow],
) -> Value {
    let text = |v: &Option<String>| v.as_deref().map_or(Value::Null, Value::from);
    Value::Array(
        episodes
            .iter()
            .map(|e| {
                let row = rows.iter().find(|r| r.tvdb_id == e.tvdb_id);
                let mut d = Draft::default();
                d.put("tvdbId", Value::from(e.tvdb_id));
                d.put("seasonNumber", Value::from(e.season));
                d.put("episodeNumber", Value::from(e.episode));
                d.put("title", Value::from(e.title.as_str()));
                d.put(
                    "airDate",
                    e.air_date.as_deref().map_or(Value::Null, Value::from),
                );
                d.put("status", Value::from(status));
                d.put("searchTriggeredAt", Value::Null);
                d.put("monitoredAt", Value::Null);
                d.put("unmonitoredAt", Value::Null);
                d.put("id", row.map_or(Value::Null, |r| Value::from(r.id)));
                d.put(
                    "createdAt",
                    row.map_or(Value::Null, |r| text(&r.created_at)),
                );
                d.put(
                    "updatedAt",
                    row.map_or(Value::Null, |r| text(&r.updated_at)),
                );
                d.json()
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ep(tvdb_id: i64, season: i64, episode: i64) -> CatalogEpisode {
        CatalogEpisode {
            tvdb_id,
            season,
            episode,
            title: format!("Episode {episode}"),
            air_date: None,
        }
    }

    fn catalog() -> Vec<CatalogEpisode> {
        vec![ep(900, 0, 1), ep(101, 1, 1), ep(102, 1, 2), ep(201, 2, 1)]
    }

    #[test]
    fn parses_like_zod() {
        assert_eq!(
            parse(&json!({"type": "single", "episodeTvdbId": 5})),
            Ok(Selection::Single(5)),
            "single"
        );
        assert_eq!(
            parse(&json!({"type": "watchAhead", "count": 50})),
            Ok(Selection::WatchAhead(50)),
            "watch ahead"
        );
        assert_eq!(
            parse(&json!({"type": "range", "startEpisodeTvdbId": 5, "endEpisodeTvdbId": 2_147_483_649_u64})),
            Err(Refused::Invalid(String::from(
                "[\n  {\n    \"origin\": \"number\",\n    \"code\": \"too_big\",\n    \"maximum\": 2147483647,\n    \"inclusive\": true,\n    \"path\": [\n      \"endEpisodeTvdbId\"\n    ],\n    \"message\": \"Too big: expected number to be <=2147483647\"\n  }\n]"
            ))),
            "too big"
        );
        let unsafe_id = parse(&json!({"type": "single", "episodeTvdbId": 1e20}));
        assert!(
            matches!(&unsafe_id, Err(Refused::Invalid(m)) if m.contains("\"origin\": \"int\"")),
            "the safe-integer issue comes first"
        );
        assert!(
            matches!(parse(&json!({"type": "single"})), Err(Refused::Forward(_))),
            "the validator's"
        );
    }

    #[test]
    fn resolves_like_node() {
        let none: HashSet<i64> = HashSet::new();
        let r = resolve(Selection::Range(101, 201), &catalog(), false, &none);
        assert_eq!(
            r.map(|r| (r.kind, r.end, r.episodes.len())),
            Ok(("range", Some(201), 3)),
            "a range"
        );
        assert_eq!(
            resolve(Selection::Single(900), &catalog(), false, &none).map(|r| r.start),
            Err(Refused::Invalid(String::from(
                "Special episode requests are disabled."
            ))),
            "specials"
        );
        assert_eq!(
            resolve(Selection::Range(201, 101), &catalog(), false, &none).map(|r| r.start),
            Err(Refused::Invalid(String::from(
                "Episode range endpoints are invalid or reversed."
            ))),
            "reversed"
        );
        let played: HashSet<i64> = std::iter::once(102).collect();
        let r = resolve(Selection::WatchAhead(5), &catalog(), false, &played);
        assert_eq!(
            r.map(|r| (r.start, r.episodes.len(), r.watch_ahead)),
            Ok((201, 1, Some(5))),
            "after the played episode"
        );
        assert_eq!(quota_units(&catalog()), 3, "three seasons");
        assert_eq!(lock_key(5, true), "5:4k", "the lock key");
    }
}
