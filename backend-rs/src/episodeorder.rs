//! Sonarr's episode orders (`seasonType`).
//!
//! Sonarr 5 lets a series follow another order than the aired one: DVD,
//! absolute, story, streaming. The episodes stay the same (one TVDB id
//! each), only their season and episode numbers change. Foreseerr
//! requests, stores and shows aired-order numbers, so on such a series
//! Sonarr's season N holds other episodes than the aired season N. These
//! helpers match the two orders by episode TVDB id: the aired order comes
//! from the TVDB catalog, and Sonarr's episodes carry their `tvdbId`.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{LazyLock, Mutex};

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use crate::jobs::episode_request_sync::CatalogEpisode;
use crate::settings::public::truthy;

/// `SeasonType.Official`: the aired order, in Sonarr and in TVDB.
pub const OFFICIAL: &str = "official";

/// TVDB's `default` season type: the order a series' TVDB editors chose,
/// the aired one for most series. The request UI lists episodes in it.
pub const TVDB_DEFAULT: &str = "default";

/// `getEpisodeCatalog` reads at most this many pages.
const MAX_PAGES: u32 = 50;

/// The order a Sonarr series is numbered in when that isn't the aired one
/// (its `seasonType`); `None` for the aired order and for a Sonarr that
/// has no orders.
#[must_use]
pub fn other_order(series: &Value) -> Option<&str> {
    series
        .get("seasonType")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty() && !t.eq_ignore_ascii_case(OFFICIAL))
}

/// The aired order of a TVDB series in TVDB's default language.
///
/// The episodes of its official seasons numbered as aired (TVDB's
/// `official` season type, which Sonarr's aired order follows), sorted by
/// season and episode.
///
/// # Errors
///
/// When TVDB can't be logged in to or asked.
pub async fn aired_catalog(client: &reqwest::Client, tvdb_id: i64) -> Result<Vec<CatalogEpisode>> {
    catalog_in(client, tvdb_id, OFFICIAL).await
}

/// `Tvdb.getEpisodeCatalog` of a TVDB series in TVDB's default language,
/// numbered in TVDB's `season_type` order: the episodes of its official
/// seasons, sorted by season and episode.
///
/// # Errors
///
/// When TVDB can't be logged in to or asked.
pub async fn catalog_in(
    client: &reqwest::Client,
    tvdb_id: i64,
    season_type: &str,
) -> Result<Vec<CatalogEpisode>> {
    crate::tvdb::ensure_instance(client).await?;
    crate::tvdb::refresh_token(client).await?;
    let extended = crate::tvdb::get(
        client,
        &format!("/series/{tvdb_id}/extended?meta=episodes&short=true"),
    )
    .await?;
    let official: Vec<i64> = extended
        .pointer("/data/seasons")
        .and_then(Value::as_array)
        .map(|seasons| {
            seasons
                .iter()
                .filter(|s| s.pointer("/type/type").and_then(Value::as_str) == Some(OFFICIAL))
                .filter_map(|s| s.get("number").and_then(Value::as_i64))
                .collect()
        })
        .unwrap_or_default();
    let mut raw: Vec<Value> = Vec::new();
    for page in 0..MAX_PAGES {
        let response = crate::tvdb::get(client, &episodes_path(tvdb_id, season_type, page)).await?;
        let episodes = response
            .pointer("/data/episodes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let empty = episodes.is_empty();
        raw.extend(episodes);
        if !truthy(response.pointer("/links/next")) || empty {
            break;
        }
    }
    Ok(catalog_of(&raw, &official))
}

/// A page of a TVDB series' episodes in the `season_type` order.
fn episodes_path(tvdb_id: i64, season_type: &str, page: u32) -> String {
    format!(
        "/series/{tvdb_id}/episodes/{season_type}/{}?page={page}",
        crate::tvdb::DEFAULT_LANGUAGE
    )
}

/// The raw TVDB episodes of the `official` seasons as catalog entries,
/// sorted.
fn catalog_of(raw: &[Value], official: &[i64]) -> Vec<CatalogEpisode> {
    let mut catalog: Vec<CatalogEpisode> = raw
        .iter()
        .filter_map(|e| {
            let season = e.get("seasonNumber").and_then(Value::as_i64)?;
            if !official.contains(&season) {
                return None;
            }
            let number = e.get("number").and_then(Value::as_i64)?;
            let title = match e.get("name") {
                Some(Value::String(s)) if !s.is_empty() => s.clone(),
                _ => format!("Episode {number}"),
            };
            Some(CatalogEpisode {
                tvdb_id: e.get("id").and_then(Value::as_i64)?,
                season,
                episode: number,
                title,
                air_date: e
                    .get("aired")
                    .and_then(Value::as_str)
                    .filter(|a| !a.is_empty())
                    .map(str::to_owned),
            })
        })
        .collect();
    catalog.sort_by(|a, b| a.season.cmp(&b.season).then(a.episode.cmp(&b.episode)));
    catalog
}

/// A future of an aired-order catalog.
pub type CatalogFuture<'a> = Pin<Box<dyn Future<Output = Result<Vec<CatalogEpisode>>> + Send + 'a>>;

/// Where the aired order of a series comes from: TVDB, or a fixed catalog
/// in tests.
pub trait AiredSource: Sync {
    /// The aired-order catalog of the TVDB series `tvdb_id`.
    fn aired(&self, tvdb_id: i64) -> CatalogFuture<'_>;
}

/// TVDB through the outgoing HTTP client.
#[derive(Debug, Clone, Copy)]
pub struct Tvdb<'c>(pub &'c reqwest::Client);

impl AiredSource for Tvdb<'_> {
    fn aired(&self, tvdb_id: i64) -> CatalogFuture<'_> {
        Box::pin(aired_catalog(self.0, tvdb_id))
    }
}

/// The TVDB id of a Sonarr episode; Sonarr sends 0 for none.
fn tvdb_of(episode: &Value) -> Option<i64> {
    episode
        .get("tvdbId")
        .and_then(Value::as_i64)
        .filter(|t| *t > 0)
}

/// The TVDB ids of the episodes of aired seasons, in aired order.
#[must_use]
pub fn season_episodes(catalog: &[CatalogEpisode], seasons: &[i64]) -> Vec<i64> {
    catalog
        .iter()
        .filter(|e| seasons.contains(&e.season))
        .map(|e| e.tvdb_id)
        .collect()
}

/// The requested aired seasons as the order a Sonarr series uses holds
/// them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SeasonSplit {
    /// Seasons it has an episode of.
    pub kept: Vec<i64>,
    /// Seasons with aired episodes, none of which it has: Sonarr can't
    /// download them.
    pub left_out: Vec<i64>,
    /// Seasons the aired catalog lists no aired episode of yet (none, or
    /// only future ones) and it has nothing of: nothing to monitor now,
    /// but they may come.
    pub unlisted: Vec<i64>,
}

/// The requested aired `seasons` split by Sonarr's order of the series,
/// each list in their order; an episode has aired when its air date is
/// at or before `now_ms`.
#[must_use]
pub fn seasons_in_order(
    catalog: &[CatalogEpisode],
    seasons: &[i64],
    episodes: &[Value],
    now_ms: i64,
) -> SeasonSplit {
    let known: HashSet<i64> = episodes.iter().filter_map(tvdb_of).collect();
    let mut split = SeasonSplit::default();
    for &season in seasons {
        let mut of_season = catalog.iter().filter(|e| e.season == season);
        if of_season.clone().any(|e| known.contains(&e.tvdb_id)) {
            split.kept.push(season);
        } else if of_season.any(|e| has_aired(e, now_ms)) {
            split.left_out.push(season);
        } else {
            split.unlisted.push(season);
        }
    }
    split
}

/// Whether a catalog episode has aired by `now_ms`; one without an air
/// date hasn't.
fn has_aired(episode: &CatalogEpisode, now_ms: i64) -> bool {
    episode
        .air_date
        .as_deref()
        .and_then(crate::clock::parse_date_millis)
        .is_some_and(|at| at <= now_ms)
}

/// Sonarr's episodes by their TVDB id.
#[must_use]
pub fn by_tvdb(episodes: &[Value]) -> HashMap<i64, &Value> {
    episodes
        .iter()
        .filter_map(|e| Some((tvdb_of(e)?, e)))
        .collect()
}

/// The TVDB ids, in their order, that Sonarr has no episode for: episodes
/// the order the series is numbered in leaves out.
#[must_use]
pub fn missing(ids: &[i64], episodes: &[Value]) -> Vec<i64> {
    let known: HashSet<i64> = episodes.iter().filter_map(tvdb_of).collect();
    ids.iter()
        .copied()
        .filter(|id| !known.contains(id))
        .collect()
}

/// Sonarr's `seasons` list (number, `monitored`, `statistics`) counted per
/// aired season instead of per season of the series' own order.
///
/// An aired season holds the episodes of Sonarr's order that the aired
/// catalog places in it: `totalEpisodeCount` counts them (as Sonarr counts
/// the episodes it knows), `episodeFileCount` those with a file, and the
/// season is `monitored` when one of them is. Aired episodes the order
/// leaves out can't be downloaded, so they aren't counted.
#[must_use]
pub fn aired_seasons(catalog: &[CatalogEpisode], episodes: &[Value]) -> Vec<Value> {
    let sonarr = by_tvdb(episodes);
    let mut numbers: Vec<i64> = Vec::new();
    for e in catalog {
        if !numbers.contains(&e.season) {
            numbers.push(e.season);
        }
    }
    numbers
        .into_iter()
        .map(|number| {
            let matched: Vec<&Value> = catalog
                .iter()
                .filter(|e| e.season == number)
                .filter_map(|e| sonarr.get(&e.tvdb_id).copied())
                .collect();
            let files = matched.iter().filter(|e| truthy(e.get("hasFile"))).count();
            json!({
                "seasonNumber": number,
                "monitored": matched.iter().any(|e| truthy(e.get("monitored"))),
                "statistics": {
                    "episodeFileCount": files,
                    "totalEpisodeCount": matched.len(),
                },
            })
        })
        .collect()
}

/// Aired season and episode numbers by episode TVDB id.
pub type AiredNumbers = HashMap<i64, (i64, i64)>;

/// Each aired episode's aired season and number, by TVDB id.
#[must_use]
pub fn aired_numbers(catalog: &[CatalogEpisode]) -> AiredNumbers {
    catalog
        .iter()
        .map(|e| (e.tvdb_id, (e.season, e.episode)))
        .collect()
}

/// The aired-order episodes from `start` (its TVDB id) onward, specials
/// left out, as the catalog orders them.
///
/// # Errors
///
/// When the catalog doesn't have the starting episode.
pub fn aired_from(catalog: &[CatalogEpisode], start: i64) -> Result<Vec<&CatalogEpisode>> {
    let boundary = catalog
        .iter()
        .find(|e| e.tvdb_id == start)
        .ok_or_else(|| anyhow!("TVDB does not contain the ongoing request boundary"))?;
    let from = (boundary.season, boundary.episode);
    Ok(catalog
        .iter()
        .filter(|e| e.season > 0 && (e.season, e.episode) >= from)
        .collect())
}

/// What a scan found about a series' order compared with the last scan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OrderNews {
    /// Same order as last time, or first seen in aired order.
    Unchanged,
    /// First seen, in another order than the aired one.
    FirstOther(String),
    /// The order changed: before, now.
    Changed(String, String),
}

/// How the order `now` compares with the `before` of the last scan;
/// orders are named as Sonarr names them, `official` when missing.
#[must_use]
pub fn order_news(before: Option<&str>, now: &str) -> OrderNews {
    match before {
        Some(before) if !before.eq_ignore_ascii_case(now) => {
            OrderNews::Changed(before.to_owned(), now.to_owned())
        }
        Some(_) => OrderNews::Unchanged,
        None if now.eq_ignore_ascii_case(OFFICIAL) => OrderNews::Unchanged,
        None => OrderNews::FirstOther(now.to_owned()),
    }
}

/// The order each Sonarr series had at its last scan, by server and
/// series id.
static LAST_ORDER: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Mutex::default);

/// Remember the order a scan found `series` of `server` in, and log what
/// changed since the last scan of this process.
///
/// A series that switched order keeps its monitored flags on Sonarr's
/// episode rows, which Sonarr matches by number on refresh, so after the
/// switch they may sit on other episodes. Sonarr also stops using scene
/// numbering (XEM) for a series in another order than the aired one.
pub fn track_order(server: &Value, series: &Value) {
    let now = other_order(series).unwrap_or(OFFICIAL).to_owned();
    let key = format!(
        "{}:{}:{}",
        crate::media::js_string(server.get("hostname")),
        crate::media::js_string(server.get("port")),
        crate::media::js_string(series.get("id"))
    );
    let before = crate::sync::lock(&LAST_ORDER).insert(key, now.clone());
    let title = crate::media::js_string(series.get("title"));
    let tvdb_id = crate::media::js_string(series.get("tvdbId"));
    match order_news(before.as_deref(), &now) {
        OrderNews::Unchanged => {}
        OrderNews::FirstOther(order) => tracing::info!(
            label = "Sonarr Scan",
            "Sonarr series {title} [TVDB ID {tvdb_id}] uses the {order} episode order. Its episodes are matched to aired seasons by TVDB episode id; Sonarr doesn't use scene numbering (XEM) for it, so releases numbered by aired season may not be grabbed."
        ),
        OrderNews::Changed(before, now) => tracing::warn!(
            label = "Sonarr Scan",
            "Sonarr series {title} [TVDB ID {tvdb_id}] switched from the {before} to the {now} episode order since the last scan. Sonarr keeps its monitored flags on episode rows matched by number, so the episodes it monitors now may not be the requested ones; check them in Sonarr."
        ),
    }
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

    /// Firefly in aired order: "The Train Job" (297989) aired first, the
    /// pilot "Serenity" (297990) eleventh; one special.
    fn firefly_aired() -> Vec<CatalogEpisode> {
        let mut catalog = vec![ep(1000, 0, 1)];
        catalog.push(ep(297_989, 1, 1));
        for n in 2..=10 {
            catalog.push(ep(297_989 + n, 1, n));
        }
        catalog.push(ep(297_990, 1, 11));
        catalog
    }

    /// A Sonarr episode in its own order.
    fn sonarr(
        id: i64,
        tvdb_id: i64,
        season: i64,
        episode: i64,
        file: bool,
        monitored: bool,
    ) -> Value {
        json!({
            "id": id, "tvdbId": tvdb_id, "seasonNumber": season, "episodeNumber": episode,
            "hasFile": file, "monitored": monitored,
        })
    }

    /// Firefly in DVD order: the pilot first, "The Train Job" second.
    fn firefly_dvd() -> Vec<Value> {
        let mut episodes = vec![
            sonarr(1, 297_990, 1, 1, true, true),
            sonarr(2, 297_989, 1, 2, false, false),
        ];
        for n in 2..=10 {
            episodes.push(sonarr(n + 1, 297_989 + n, 1, n + 1, false, false));
        }
        episodes
    }

    #[test]
    fn orders() {
        assert_eq!(
            other_order(&json!({"seasonType": "dvd"})),
            Some("dvd"),
            "dvd"
        );
        assert_eq!(
            other_order(&json!({"seasonType": "official"})),
            None,
            "aired"
        );
        assert_eq!(
            other_order(&json!({"seasonType": "Official"})),
            None,
            "any case"
        );
        assert_eq!(other_order(&json!({"seasonType": ""})), None, "empty");
        assert_eq!(other_order(&json!({"title": "x"})), None, "Sonarr 4");
    }

    #[test]
    fn aired_season_to_dvd_episodes() {
        let catalog = firefly_aired();
        let wanted = season_episodes(&catalog, &[1]);
        assert_eq!(wanted.len(), 11, "the aired season's eleven episodes");
        assert_eq!(wanted.first(), Some(&297_989), "aired first");
        let dvd = firefly_dvd();
        let found = by_tvdb(&dvd);
        let ids: Vec<i64> = wanted
            .iter()
            .filter_map(|t| found.get(t))
            .filter_map(|e| e.get("id").and_then(Value::as_i64))
            .collect();
        assert_eq!(
            (ids.first(), ids.last(), ids.len()),
            (Some(&2), Some(&1), 11),
            "aired E1 is Sonarr's S01E02, the pilot (aired E11) Sonarr's S01E01"
        );
        assert!(missing(&wanted, &dvd).is_empty(), "DVD order has them all");
        assert_eq!(
            season_episodes(&catalog, &[0]),
            vec![1000],
            "specials only when asked for"
        );
    }

    #[test]
    fn absolute_order() {
        // Two aired seasons of three; Sonarr numbers them 1 to 6 in one season.
        let catalog = vec![
            ep(11, 1, 1),
            ep(12, 1, 2),
            ep(13, 1, 3),
            ep(21, 2, 1),
            ep(22, 2, 2),
            ep(23, 2, 3),
        ];
        let absolute: Vec<Value> = [11, 12, 13, 21, 22, 23]
            .iter()
            .zip(1..)
            .map(|(t, n)| sonarr(n, *t, 1, n, n <= 4, n >= 4))
            .collect();
        let ids: Vec<i64> = season_episodes(&catalog, &[2])
            .iter()
            .filter_map(|t| by_tvdb(&absolute).get(t).copied())
            .filter_map(|e| e.get("episodeNumber").and_then(Value::as_i64))
            .collect();
        assert_eq!(ids, vec![4, 5, 6], "aired season 2 is absolute 4 to 6");
        assert_eq!(
            aired_seasons(&catalog, &absolute),
            vec![
                json!({"seasonNumber": 1, "monitored": false, "statistics": {"episodeFileCount": 3, "totalEpisodeCount": 3}}),
                json!({"seasonNumber": 2, "monitored": true, "statistics": {"episodeFileCount": 1, "totalEpisodeCount": 3}}),
            ],
            "counted per aired season, not as Sonarr's one season"
        );
    }

    #[test]
    fn seasons_the_order_leaves_out() {
        let on = |tvdb_id: i64, season: i64, episode: i64, date: &str| CatalogEpisode {
            air_date: Some(date.to_owned()),
            ..ep(tvdb_id, season, episode)
        };
        let now = crate::clock::parse_date_millis("2026-10-31").unwrap_or_default();
        // Aired S1 = 11, 12 and S2 = 21 (all aired); S4 = 41, airing next
        // year; S5 = 51 without a date. The story order has 12 only, and
        // TVDB lists nothing for aired season 3 yet.
        let catalog = vec![
            on(11, 1, 1, "2020-01-01"),
            on(12, 1, 2, "2020-01-08"),
            on(21, 2, 1, "2021-01-01"),
            on(41, 4, 1, "2027-01-01"),
            ep(51, 5, 1),
        ];
        let story = vec![sonarr(1, 12, 1, 1, false, false)];
        assert_eq!(
            seasons_in_order(&catalog, &[1, 2, 3, 4, 5], &story, now),
            SeasonSplit {
                kept: vec![1],
                left_out: vec![2],
                unlisted: vec![3, 4, 5],
            },
            "one episode is enough; only aired episodes the order lacks leave a season out"
        );
        assert_eq!(
            seasons_in_order(&catalog, &[2], &[], now).left_out,
            vec![2],
            "an empty list holds nothing (callers refuse to decide on one)"
        );
    }

    #[test]
    fn aired_catalog_reads_the_official_order() {
        assert_eq!(
            episodes_path(81797, OFFICIAL, 2),
            "/series/81797/episodes/official/eng?page=2",
            "aired order, not the series' default one"
        );
        assert_eq!(
            episodes_path(81797, TVDB_DEFAULT, 0),
            "/series/81797/episodes/default/eng?page=0",
            "the request UI's order for watch-ahead"
        );
    }

    #[test]
    fn episodes_missing_from_the_order() {
        let catalog = vec![ep(11, 1, 1), ep(12, 1, 2), ep(13, 1, 3)];
        let story = vec![
            sonarr(1, 11, 1, 1, true, true),
            json!({"id": 9, "tvdbId": 0}),
        ];
        assert_eq!(
            missing(&[11, 12, 13], &story),
            vec![12, 13],
            "no Sonarr episode carries them"
        );
        assert_eq!(
            aired_seasons(&catalog, &story),
            vec![
                json!({"seasonNumber": 1, "monitored": true, "statistics": {"episodeFileCount": 1, "totalEpisodeCount": 1}})
            ],
            "only what the order holds counts"
        );
        assert!(!by_tvdb(&story).contains_key(&0), "no id is no match");
    }

    #[test]
    fn onward_in_aired_order() {
        let catalog = vec![ep(100, 0, 1), ep(11, 1, 1), ep(12, 1, 2), ep(21, 2, 1)];
        let from: Vec<i64> = aired_from(&catalog, 12)
            .unwrap_or_default()
            .iter()
            .map(|e| e.tvdb_id)
            .collect();
        assert_eq!(from, vec![12, 21], "from the start, no specials");
        assert!(aired_from(&catalog, 99).is_err(), "unknown start");
        assert_eq!(
            aired_numbers(&catalog).get(&21),
            Some(&(2, 1)),
            "aired numbers by id"
        );
    }

    #[test]
    fn catalog_from_tvdb_pages() {
        let raw = vec![
            json!({"id": 3, "seasonNumber": 2, "number": 1, "name": "", "aired": "2021-01-01"}),
            json!({"id": 1, "seasonNumber": 1, "number": 2, "name": "B"}),
            json!({"id": 2, "seasonNumber": 1, "number": 1, "name": "A", "aired": ""}),
            json!({"id": 9, "seasonNumber": 7, "number": 1}),
        ];
        let catalog = catalog_of(&raw, &[1, 2]);
        let ids: Vec<i64> = catalog.iter().map(|e| e.tvdb_id).collect();
        assert_eq!(ids, vec![2, 1, 3], "official seasons, sorted");
        assert_eq!(
            catalog
                .last()
                .map(|e| (e.title.as_str(), e.air_date.as_deref())),
            Some(("Episode 1", Some("2021-01-01"))),
            "titles and dates"
        );
    }

    #[test]
    fn order_changes() {
        assert_eq!(order_news(None, OFFICIAL), OrderNews::Unchanged, "aired");
        assert_eq!(
            order_news(None, "dvd"),
            OrderNews::FirstOther(String::from("dvd")),
            "first seen"
        );
        assert_eq!(order_news(Some("dvd"), "dvd"), OrderNews::Unchanged, "same");
        assert_eq!(
            order_news(Some(OFFICIAL), "absolute"),
            OrderNews::Changed(String::from(OFFICIAL), String::from("absolute")),
            "switched"
        );
    }
}
