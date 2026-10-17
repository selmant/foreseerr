//! The `AniList` and episode lookups the episode actions use.
//!
//! From `server/lib/anilist/mapping.ts`: `getAnilistId`,
//! `getAnilistSeasonEntries`, `fribbSeasonCandidates` and
//! `pickFribbSeasonEntry`; from `server/lib/mapping/episodes.ts`:
//! `translateEpisodeBridged` and `findEpisodeRules`.

use std::collections::HashSet;

use anyhow::Result;

use crate::db::Db;
use crate::mappinglayer::edges::{
    apply_episode_rule, edges_from, edges_to, parse_episode_range, parse_range_pair, Edge,
    RangeRule,
};
use crate::mappinglayer::{int_of, scope_season, season_scope, IdRef, MediaType};

/// `Number(text)` as an integer id, when it is a positive one.
fn positive_id(text: &str) -> Option<i64> {
    let n = crate::jsval::number_of_str(text);
    if !(n.is_finite() && n > 0.0) {
        return None;
    }
    int_of(n)
}

/// `getAnilistIds(mediaType, tmdbId)`.
///
/// # Errors
///
/// Database failures.
pub async fn anilist_ids(db: &Db, media_type: MediaType, tmdb_id: i64) -> Result<Vec<i64>> {
    let edges = edges_from(db, media_type.namespace(), &tmdb_id.to_string()).await?;
    let mut ids = Vec::new();
    for edge in edges_to(&edges, "anilist") {
        if let Some(id) = positive_id(&edge.dst_id) {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    Ok(ids)
}

/// `getAnilistId(mediaType, tmdbId)`.
///
/// # Errors
///
/// Database failures.
pub async fn anilist_id(db: &Db, media_type: MediaType, tmdb_id: i64) -> Result<Option<i64>> {
    Ok(anilist_ids(db, media_type, tmdb_id).await?.first().copied())
}

/// `AnilistSeasonMapping`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeasonMapping {
    /// `anilistId`.
    pub anilist_id: i64,
    /// `type: 'SPECIAL'` for a season-0 entry.
    pub special: bool,
    /// `seasonTmdb`.
    pub season_tmdb: Option<i64>,
    /// `seasonTvdb`.
    pub season_tvdb: Option<i64>,
    /// `offsetTmdb`.
    pub offset_tmdb: i64,
    /// `offsetTvdb`.
    pub offset_tvdb: i64,
}

/// `'tmdb' | 'tvdb'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Catalog {
    /// TMDB seasons.
    Tmdb,
    /// TVDB seasons.
    Tvdb,
}

/// `'in-season' | 'absolute'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Episode numbers within the season.
    InSeason,
    /// One entry across every season.
    Absolute,
}

impl SeasonMapping {
    /// `offsetForCatalog(entry, catalog)`.
    #[must_use]
    pub const fn offset(&self, catalog: Catalog) -> i64 {
        match catalog {
            Catalog::Tmdb => self.offset_tmdb,
            Catalog::Tvdb => self.offset_tvdb,
        }
    }

    /// The season the entry sits in on a catalogue.
    #[must_use]
    pub const fn season(&self, catalog: Catalog) -> Option<i64> {
        match catalog {
            Catalog::Tmdb => self.season_tmdb,
            Catalog::Tvdb => self.season_tvdb,
        }
    }
}

/// `rangeStart(range)`.
fn range_start(range: Option<&str>) -> i64 {
    parse_episode_range(range.unwrap_or("")).map_or(crate::jellyfin::MAX_SAFE_INTEGER, |r| r.start)
}

/// `offsetOf(entryRange, seasonRange)`.
fn offset_of(entry_range: Option<&str>, season_range: Option<&str>) -> i64 {
    let (Some(entry), Some(season)) = (
        entry_range.filter(|r| !r.is_empty()),
        season_range.filter(|r| !r.is_empty()),
    ) else {
        return 0;
    };
    parse_range_pair(entry, season)
        .first()
        .map_or(0, |rule| rule.target.start - rule.source.start)
}

/// `getAnilistSeasonEntries('tv', tmdbId)`.
///
/// # Errors
///
/// Database failures.
pub async fn season_entries(db: &Db, tmdb_id: i64) -> Result<Vec<SeasonMapping>> {
    let edges = edges_from(db, "tmdb_show", &tmdb_id.to_string()).await?;
    let mut sorted = edges_to(&edges, "anilist");
    sorted.sort_by_key(|e| range_start(e.src_range.as_deref()));
    let mut seen = HashSet::new();
    let mut first: Vec<Edge> = Vec::new();
    for edge in sorted {
        if seen.insert(format!("{}:{}", edge.dst_id, edge.src_scope)) {
            first.push(edge);
        }
    }
    let mut entries = Vec::new();
    for edge in first {
        let Some(anilist_id) = positive_id(&edge.dst_id) else {
            continue;
        };
        let season_tmdb = scope_season(&edge.src_scope);
        let tvdb_edges = edges_to(&edges_from(db, "anilist", &edge.dst_id).await?, "tvdb_show");
        let entry_start = range_start(edge.dst_range.as_deref());
        let tvdb = tvdb_edges
            .iter()
            .find(|c| {
                parse_episode_range(c.src_range.as_deref().unwrap_or("")).is_some_and(|r| {
                    r.start <= entry_start && r.end.is_none_or(|end| entry_start <= end)
                })
            })
            .or_else(|| tvdb_edges.first());
        entries.push(SeasonMapping {
            anilist_id,
            special: season_tmdb == Some(0),
            season_tmdb,
            season_tvdb: tvdb.and_then(|t| scope_season(&t.dst_scope)),
            offset_tmdb: offset_of(edge.dst_range.as_deref(), edge.src_range.as_deref()),
            offset_tvdb: offset_of(
                tvdb.and_then(|t| t.src_range.as_deref()),
                tvdb.and_then(|t| t.dst_range.as_deref()),
            ),
        });
    }
    Ok(entries)
}

/// What `fribbSeasonCandidates` answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidates {
    /// Which catalogue's seasons the entries are placed in.
    pub catalog: Catalog,
    /// How episodes map onto them.
    pub mode: Mode,
    /// The entries.
    pub entries: Vec<SeasonMapping>,
}

/// `fribbSeasonCandidates(entries, seasonNumber)`.
#[must_use]
pub fn season_candidates(entries: &[SeasonMapping], season: i64) -> Candidates {
    let series: Vec<SeasonMapping> = entries
        .iter()
        .filter(|e| !e.special && e.anilist_id > 0)
        .cloned()
        .collect();
    if season < 1 || series.is_empty() {
        return Candidates {
            catalog: Catalog::Tmdb,
            mode: Mode::InSeason,
            entries: Vec::new(),
        };
    }
    if series.len() == 1 {
        return Candidates {
            catalog: Catalog::Tmdb,
            mode: Mode::Absolute,
            entries: series,
        };
    }
    let hits = |catalog: Catalog| -> Vec<SeasonMapping> {
        series
            .iter()
            .filter(|e| e.season(catalog) == Some(season))
            .cloned()
            .collect()
    };
    let distinct = |catalog: Catalog| -> usize {
        series
            .iter()
            .filter_map(|e| e.season(catalog))
            .filter(|s| *s > 0)
            .collect::<HashSet<i64>>()
            .len()
    };
    let collapsed = distinct(Catalog::Tmdb) <= 1 && distinct(Catalog::Tvdb) > 1;
    let on_tmdb = hits(Catalog::Tmdb);
    let (catalog, entries) = if collapsed {
        (Catalog::Tvdb, hits(Catalog::Tvdb))
    } else if !on_tmdb.is_empty() {
        (Catalog::Tmdb, on_tmdb)
    } else {
        (Catalog::Tvdb, hits(Catalog::Tvdb))
    };
    Candidates {
        catalog,
        mode: Mode::InSeason,
        entries,
    }
}

/// `pickFribbSeasonEntry(entries, seasonNumber, episodeNumber)`:
/// `(mapping, progress, mode)`.
#[must_use]
pub fn pick_season_entry(
    entries: &[SeasonMapping],
    season: i64,
    episode: i64,
) -> Option<(SeasonMapping, i64, Mode)> {
    if episode < 1 {
        return None;
    }
    let Candidates {
        catalog,
        mode,
        entries: hits,
    } = season_candidates(entries, season);
    if mode == Mode::Absolute {
        return hits.into_iter().next().map(|first| (first, episode, mode));
    }
    let mut sorted = hits;
    sorted.sort_by(|a, b| {
        a.offset(catalog)
            .cmp(&b.offset(catalog))
            .then(a.anilist_id.cmp(&b.anilist_id))
    });
    let picked = if sorted.len() == 1 {
        sorted.first()
    } else {
        sorted.iter().enumerate().find_map(|(index, entry)| {
            let start = entry.offset(catalog) + 1;
            let end = sorted.get(index + 1).map(|next| next.offset(catalog));
            (episode >= start && end.is_none_or(|end| episode <= end)).then_some(entry)
        })
    }?;
    let progress = episode - picked.offset(catalog);
    (progress >= 1).then(|| (picked.clone(), progress, mode))
}

/// `EpisodeTranslation` (with the target's scope).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Translation {
    /// `target`.
    pub target: IdRef,
    /// The target edge's scope.
    pub target_scope: String,
    /// `season`.
    pub season: i64,
    /// `episode`.
    pub episode: i64,
    /// `dataset`.
    pub dataset: String,
}

/// `refOf(ns, id, scope)`.
fn ref_of(ns: &str, id: &str, scope: &str) -> IdRef {
    IdRef {
        season: scope_season(scope),
        ..IdRef::new(ns, id)
    }
}

/// `scopedEdges(from, scope)`.
async fn scoped_edges(db: &Db, from: &IdRef, scope: Option<&str>) -> Result<Vec<Edge>> {
    let edges = edges_from(db, &from.ns, &from.id).await?;
    let wanted = scope.map(str::to_owned).or_else(|| {
        from.season
            .map(season_scope)
            .or_else(|| (from.ns == "anidb").then(|| String::from("R")))
    });
    Ok(match wanted {
        None => edges,
        Some(wanted) => edges
            .into_iter()
            .filter(|e| e.src_scope == wanted)
            .collect(),
    })
}

/// `rulesOf(edges, to)`: each rule with its edge.
fn rules_of(edges: &[Edge], to: &str) -> Vec<(RangeRule, Edge)> {
    let ranged: Vec<Edge> = edges
        .iter()
        .filter(|e| {
            e.src_range.as_deref().is_some_and(|r| !r.is_empty())
                && e.dst_range.as_deref().is_some_and(|r| !r.is_empty())
        })
        .cloned()
        .collect();
    let mut out = Vec::new();
    for edge in edges_to(&ranged, to) {
        let (Some(src), Some(dst)) = (edge.src_range.as_deref(), edge.dst_range.as_deref()) else {
            continue;
        };
        for rule in parse_range_pair(src, dst) {
            out.push((rule, edge.clone()));
        }
    }
    out
}

/// `translate(from, to, scope)`.
async fn translate(
    db: &Db,
    from: &IdRef,
    episode: i64,
    to: &str,
    scope: Option<&str>,
) -> Result<Vec<Translation>> {
    let mut results = Vec::new();
    let mut seen = HashSet::new();
    for (rule, edge) in rules_of(&scoped_edges(db, from, scope).await?, to) {
        let Some(mapped) = apply_episode_rule(&rule, episode) else {
            continue;
        };
        let target = ref_of(&edge.dst_ns, &edge.dst_id, &edge.dst_scope);
        let season = target.season.or(from.season).unwrap_or(1);
        if !seen.insert(format!("{}:{}:e{mapped}", target.key(), edge.dst_scope)) {
            continue;
        }
        results.push(Translation {
            target,
            target_scope: edge.dst_scope.clone(),
            season,
            episode: mapped,
            dataset: edge.dataset.clone(),
        });
    }
    Ok(results)
}

/// `translateOnce(from, to, scope)`: the translation, unless the ranges
/// disagree.
async fn translate_once(
    db: &Db,
    from: &IdRef,
    episode: i64,
    to: &str,
    scope: Option<&str>,
) -> Result<Option<Translation>> {
    let results = translate(db, from, episode, to, scope).await?;
    let distinct: HashSet<String> = results
        .iter()
        .map(|r| format!("{}:{}:{}", r.target.id, r.season, r.episode))
        .collect();
    if distinct.len() > 1 {
        tracing::debug!(
            from = %from.key(),
            episode,
            to,
            "Ambiguous episode translation"
        );
        return Ok(None);
    }
    Ok(results.into_iter().next())
}

/// `translateEpisodeBridged(from, to, bridges)`: direct, else through
/// each bridge namespace in turn.
///
/// # Errors
///
/// Database failures.
pub async fn translate_bridged(
    db: &Db,
    from: &IdRef,
    episode: i64,
    to: &str,
    bridges: &[&str],
) -> Result<Option<Translation>> {
    if let Some(direct) = translate_once(db, from, episode, to, None).await? {
        return Ok(Some(direct));
    }
    for bridge in bridges {
        if *bridge == to || *bridge == from.ns {
            continue;
        }
        let Some(hop) = translate_once(db, from, episode, bridge, None).await? else {
            continue;
        };
        let landed =
            translate_once(db, &hop.target, hop.episode, to, Some(&hop.target_scope)).await?;
        if let Some(landed) = landed {
            return Ok(Some(Translation {
                dataset: format!("{}+{}", hop.dataset, landed.dataset),
                ..landed
            }));
        }
    }
    Ok(None)
}

/// `findEpisodeRules(from, to)`: each rule with its target (with the
/// season its scope names).
///
/// # Errors
///
/// Database failures.
pub async fn episode_rules(db: &Db, from: &IdRef, to: &str) -> Result<Vec<(RangeRule, IdRef)>> {
    Ok(rules_of(&scoped_edges(db, from, None).await?, to)
        .into_iter()
        .map(|(rule, edge)| (rule, ref_of(&edge.dst_ns, &edge.dst_id, &edge.dst_scope)))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mapping(id: i64, seasons: (Option<i64>, Option<i64>), offsets: (i64, i64)) -> SeasonMapping {
        SeasonMapping {
            anilist_id: id,
            special: seasons.0 == Some(0),
            season_tmdb: seasons.0,
            season_tvdb: seasons.1,
            offset_tmdb: offsets.0,
            offset_tvdb: offsets.1,
        }
    }

    #[test]
    fn candidates() {
        let single = [mapping(1, (Some(1), Some(1)), (0, 0))];
        let c = season_candidates(&single, 2);
        assert_eq!(c.mode, Mode::Absolute, "one entry is absolute");
        assert!(season_candidates(&single, 0).entries.is_empty(), "season 0");
        let split = [
            mapping(1, (Some(1), Some(1)), (0, 0)),
            mapping(2, (Some(1), Some(2)), (12, 0)),
        ];
        let c = season_candidates(&split, 2);
        assert_eq!(
            (c.catalog, c.entries.len()),
            (Catalog::Tvdb, 1),
            "TMDB collapsed"
        );
        let cours = [
            mapping(1, (Some(1), None), (0, 0)),
            mapping(2, (Some(1), None), (12, 0)),
            mapping(3, (Some(2), None), (0, 0)),
        ];
        assert_eq!(
            pick_season_entry(&cours, 1, 14).map(|(m, p, _)| (m.anilist_id, p)),
            Some((2, 2)),
            "second cour"
        );
        assert_eq!(
            pick_season_entry(&cours, 1, 3).map(|(m, p, _)| (m.anilist_id, p)),
            Some((1, 3)),
            "first cour"
        );
        assert_eq!(pick_season_entry(&cours, 1, 0), None, "episode 0");
    }

    #[test]
    fn offsets() {
        assert_eq!(offset_of(Some("1-12"), Some("13-24")), 12, "starts later");
        assert_eq!(offset_of(Some("27-"), Some("1-")), -26, "carries on");
        assert_eq!(offset_of(None, Some("1-")), 0, "no range");
        assert_eq!(range_start(Some("5-9")), 5, "start");
        assert_eq!(
            range_start(None),
            crate::jellyfin::MAX_SAFE_INTEGER,
            "none sorts last"
        );
    }
}
