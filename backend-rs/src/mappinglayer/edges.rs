//! `server/lib/mapping/edges.ts` and the episode-range half of
//! `episodes.ts` the scanners use.
//!
//! Edges are read from the database for the generation each enabled
//! dataset currently points at (Node keeps that pointer in memory and
//! reloads it on every change; the join reads the same rows), behind a
//! bounded cache that a dataset change clears.

use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use anyhow::Result;
use serde_json::{Map, Value};

use super::lru::BoundedLru;
use super::{scope_season, season_scope, IdRef, MediaType};
use crate::db::{Bind, Db};
use crate::sync::lock;

/// One `mapping_edge` row as the lookups read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edge {
    /// Dataset key.
    pub dataset: String,
    /// Source namespace.
    pub src_ns: String,
    /// Source id.
    pub src_id: String,
    /// Source scope (`s1`, `R`, or empty).
    pub src_scope: String,
    /// Target namespace.
    pub dst_ns: String,
    /// Target id.
    pub dst_id: String,
    /// Target scope.
    pub dst_scope: String,
    /// Source episode range.
    pub src_range: Option<String>,
    /// Target episode range.
    pub dst_range: Option<String>,
}

static CACHE: LazyLock<Mutex<BoundedLru<String, Vec<Edge>>>> =
    LazyLock::new(|| Mutex::new(BoundedLru::new(20_000, Some(Duration::from_secs(15 * 60)))));

/// `clearEdgeCache`.
pub fn clear_edge_cache() {
    lock(&CACHE).clear();
}

/// `datasetRank(key)`.
fn rank(key: &str) -> i64 {
    crate::mappingdatasets::definition(key).map_or(i64::MAX, |d| d.rank)
}

fn text(row: &Map<String, Value>, key: &str) -> String {
    row.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn edge_of(row: &Map<String, Value>) -> Edge {
    let range = |key: &str| row.get(key).and_then(Value::as_str).map(str::to_owned);
    Edge {
        dataset: text(row, "dataset"),
        src_ns: text(row, "srcNs"),
        src_id: text(row, "srcId"),
        src_scope: text(row, "srcScope"),
        dst_ns: text(row, "dstNs"),
        dst_id: text(row, "dstId"),
        dst_scope: text(row, "dstScope"),
        src_range: range("srcRange"),
        dst_range: range("dstRange"),
    }
}

/// `edgesFrom(ns, id)`: every statement about one source id, across the
/// enabled datasets.
///
/// # Errors
///
/// Fails on database errors.
pub async fn edges_from(db: &Db, ns: &str, id: &str) -> Result<Vec<Edge>> {
    super::ensure(db).await?;
    let key = format!("{ns}:{id}");
    let cached = lock(&CACHE).get(&key);
    if let Some(cached) = cached {
        return Ok(cached);
    }
    let rows = db
        .rows(
            r#"SELECT e."dataset", e."srcNs", e."srcId", e."srcScope", e."dstNs", e."dstId", e."dstScope", e."srcRange", e."dstRange" FROM "mapping_edge" e JOIN "mapping_dataset" d ON d."key" = e."dataset" AND d."generation" = e."generation" AND d."enabled" = ?3 AND d."generation" > 0 WHERE e."srcNs" = ?1 AND e."srcId" = ?2 ORDER BY e."id""#,
            &[
                Bind::Text(ns.to_owned()),
                Bind::Text(id.to_owned()),
                Bind::Bool(true),
            ],
        )
        .await?;
    let edges: Vec<Edge> = rows
        .iter()
        .map(edge_of)
        .filter(|edge| crate::mappingdatasets::definition(&edge.dataset).is_some())
        .collect();
    lock(&CACHE).set(key, edges.clone());
    Ok(edges)
}

/// `edgesTo(edges, ns)`: for each source scope, the edges of the
/// best-ranked dataset that reaches `ns`.
#[must_use]
pub fn edges_to(edges: &[Edge], ns: &str) -> Vec<Edge> {
    let reaching: Vec<&Edge> = edges.iter().filter(|e| e.dst_ns == ns).collect();
    let mut best: Vec<(&str, i64)> = Vec::new();
    for edge in &reaching {
        let r = rank(&edge.dataset);
        match best.iter_mut().find(|(scope, _)| *scope == edge.src_scope) {
            Some(entry) if r < entry.1 => entry.1 = r,
            Some(_) => {}
            None => best.push((&edge.src_scope, r)),
        }
    }
    reaching
        .into_iter()
        .filter(|edge| {
            best.iter()
                .any(|(scope, r)| *scope == edge.src_scope && *r == rank(&edge.dataset))
        })
        .cloned()
        .collect()
}

/// `edgesFor(ref)`: narrowed to the reference's season, or for `AniDB`
/// to its regular episodes when it has any.
///
/// # Errors
///
/// Fails on database errors.
pub async fn edges_for(db: &Db, r: &IdRef) -> Result<Vec<Edge>> {
    let edges = edges_from(db, &r.ns, &r.id).await?;
    if let Some(season) = r.season {
        let scope = season_scope(season);
        return Ok(edges.into_iter().filter(|e| e.src_scope == scope).collect());
    }
    if r.ns == "anidb" {
        let regular: Vec<Edge> = edges
            .iter()
            .filter(|e| e.src_scope == "R")
            .cloned()
            .collect();
        if !regular.is_empty() {
            return Ok(regular);
        }
    }
    Ok(edges)
}

/// One `EdgeTarget`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    /// Target id.
    pub id: String,
    /// Set when every edge to this id names the same season.
    pub season: Option<i64>,
}

/// `targetsIn(edges, ns)`: distinct ids the edges reach in one namespace,
/// in first-seen order.
#[must_use]
pub fn targets_in(edges: &[Edge], ns: &str) -> Vec<Target> {
    let mut scopes: Vec<(String, Vec<String>)> = Vec::new();
    for edge in edges_to(edges, ns) {
        match scopes.iter_mut().find(|(id, _)| *id == edge.dst_id) {
            Some((_, seen)) => {
                if !seen.contains(&edge.dst_scope) {
                    seen.push(edge.dst_scope);
                }
            }
            None => scopes.push((edge.dst_id, vec![edge.dst_scope])),
        }
    }
    scopes
        .into_iter()
        .map(|(id, seen)| {
            let season = match seen.as_slice() {
                [only] => scope_season(only),
                _ => None,
            };
            Target { id, season }
        })
        .collect()
}

/// `DatasetTmdb`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DatasetTmdb {
    /// The TMDB id.
    pub tmdb_id: i64,
    /// Its namespace.
    pub media_type: MediaType,
    /// Set when the edge names one season.
    pub season: Option<i64>,
}

const ENTRY_NAMESPACES: [&str; 3] = ["anilist", "mal", "anidb"];

/// `Number(text)` as an integer, when it is one.
pub(super) fn js_int(text: &str) -> Option<i64> {
    let n = crate::jsval::number_of_str(text);
    super::int_of(n)
}

fn single(edges: &[Edge], media_type: MediaType) -> Option<DatasetTmdb> {
    let targets = targets_in(edges, media_type.namespace());
    let [target] = targets.as_slice() else {
        return None;
    };
    let n = crate::jsval::number_of_str(&target.id);
    if n.is_nan() || n <= 0.0 {
        return None;
    }
    Some(DatasetTmdb {
        tmdb_id: super::int_of(n)?,
        media_type,
        season: target.season,
    })
}

/// The same anime entry under its other ids.
async fn pivot_edges(db: &Db, r: &IdRef, edges: &[Edge]) -> Result<Vec<Edge>> {
    if !ENTRY_NAMESPACES.contains(&r.ns.as_str()) {
        return Ok(Vec::new());
    }
    let mut pivots: Vec<(String, IdRef)> = Vec::new();
    for edge in edges {
        let is_entry = edge.dst_ns != r.ns
            && (edge.dst_ns == "mal"
                || edge.dst_ns == "anilist"
                || (edge.dst_ns == "anidb" && edge.dst_scope == "R"));
        if is_entry {
            let key = format!("{}:{}", edge.dst_ns, edge.dst_id);
            let pivot = IdRef::new(&edge.dst_ns, &edge.dst_id);
            match pivots.iter_mut().find(|(k, _)| *k == key) {
                Some(entry) => entry.1 = pivot,
                None => pivots.push((key, pivot)),
            }
        }
    }
    let mut out = Vec::new();
    for (_, pivot) in pivots {
        out.extend(edges_for(db, &pivot).await?);
    }
    Ok(out)
}

/// `datasetTmdb(ref, mediaType, { crossType })`: what the datasets say
/// this id is on TMDB.
///
/// # Errors
///
/// Fails on database errors.
pub async fn dataset_tmdb(
    db: &Db,
    r: &IdRef,
    media_type: Option<MediaType>,
    cross_type: bool,
) -> Result<Option<DatasetTmdb>> {
    let edges = edges_for(db, r).await?;
    if edges.is_empty() {
        return Ok(None);
    }
    let fixed = match r.ns.as_str() {
        "tvdb_show" => Some(MediaType::Tv),
        "tvdb_movie" => Some(MediaType::Movie),
        _ => None,
    };
    if let (Some(fixed), Some(wanted)) = (fixed, media_type) {
        if fixed != wanted {
            return Ok(None);
        }
    }
    let wanted: Vec<MediaType> = fixed
        .or(media_type)
        .map_or_else(|| vec![MediaType::Tv, MediaType::Movie], |t| vec![t]);
    let crosses = cross_type && ENTRY_NAMESPACES.contains(&r.ns.as_str());
    for kind in &wanted {
        let Some(direct) = single(&edges, *kind) else {
            continue;
        };
        if crosses && direct.media_type == MediaType::Tv && direct.season == Some(0) {
            if let Some(film) = single(&edges, MediaType::Movie) {
                return Ok(Some(film));
            }
        }
        return Ok(Some(direct));
    }
    let pivoted = pivot_edges(db, r, &edges).await?;
    for kind in &wanted {
        if let Some(found) = single(&pivoted, *kind) {
            return Ok(Some(found));
        }
    }
    if let (Some(kind), true) = (media_type, crosses) {
        return Ok(single(&edges, kind.other()));
    }
    Ok(None)
}

// ---------------------------------------------------------------------------
// Episode ranges (`episodes.ts`).

/// `EpisodeRange`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EpisodeRange {
    /// First episode.
    pub start: i64,
    /// Last episode; `None` for an open range such as `13-`.
    pub end: Option<i64>,
}

/// `parseEpisodeRange`: `1-13`, `13-`, `5` or `-13`.
#[must_use]
pub fn parse_episode_range(range: &str) -> Option<EpisodeRange> {
    let text = crate::jsval::trim(range);
    if text.is_empty() {
        return None;
    }
    if let Some((a, b)) = text.split_once('-') {
        // `^(\d+)?\s*-\s*(\d+)?$`
        let a = a.trim_end_matches(is_regex_space);
        let b = b.trim_start_matches(is_regex_space);
        let digits = |s: &str| s.bytes().all(|c| c.is_ascii_digit());
        if digits(a) && digits(b) {
            let start = if a.is_empty() {
                1.0
            } else {
                crate::jsval::number_of_str(a)
            };
            let end = (!b.is_empty()).then(|| crate::jsval::number_of_str(b));
            if !start.is_finite() {
                return None;
            }
            if let Some(end) = end {
                if !end.is_finite() || end < start {
                    return None;
                }
            }
            return Some(EpisodeRange {
                start: super::int_of(start)?,
                end: match end {
                    Some(e) => Some(super::int_of(e)?),
                    None => None,
                },
            });
        }
    }
    let single = crate::jsval::number_of_str(text);
    if !crate::jsnum::is_integer(single) || single < 0.0 {
        return None;
    }
    let n = super::int_of(single)?;
    Some(EpisodeRange {
        start: n,
        end: Some(n),
    })
}

/// `\s` in a JavaScript regular expression.
fn is_regex_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

const fn range_contains(range: EpisodeRange, episode: i64) -> bool {
    episode >= range.start
        && match range.end {
            None => true,
            Some(end) => episode <= end,
        }
}

/// One range rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RangeRule {
    /// Source range.
    pub source: EpisodeRange,
    /// Target range.
    pub target: EpisodeRange,
    /// Source episodes per target episode.
    pub ratio: i64,
    /// Target episodes per source episode.
    pub expand: Option<i64>,
}

/// `applyEpisodeRule(rule, episode)`.
#[must_use]
pub fn apply_episode_rule(rule: &RangeRule, episode: i64) -> Option<i64> {
    if !range_contains(rule.source, episode) {
        return None;
    }
    let offset = episode - rule.source.start;
    let ratio = if rule.ratio > 0 { rule.ratio } else { 1 };
    let expand = rule.expand.filter(|e| *e > 0).unwrap_or(1);
    let mapped = rule.target.start + offset.div_euclid(ratio) * expand;
    if rule.target.end.is_some_and(|end| mapped > end) {
        return None;
    }
    Some(mapped)
}

/// `parseRangePair(sourceRange, targetRange)`.
#[must_use]
pub fn parse_range_pair(source_range: &str, target_range: &str) -> Vec<RangeRule> {
    let Some(source) = parse_episode_range(source_range) else {
        return Vec::new();
    };
    let mut parts = target_range.split('|');
    let range_part = parts.next().unwrap_or_default();
    let ratio_part = parts.next();
    let signed = ratio_part.map_or(f64::NAN, crate::jsval::number_of_str);
    let (ratio, expand) = if crate::jsnum::is_integer(signed) && signed > 1.0 {
        (super::int_of(signed).unwrap_or(1), None)
    } else if crate::jsnum::is_integer(signed) && signed < -1.0 {
        (1, super::int_of(-signed))
    } else {
        (1, None)
    };
    let mut targets = Vec::new();
    for segment in range_part.split(',') {
        let Some(parsed) = parse_episode_range(segment) else {
            return Vec::new();
        };
        targets.push(parsed);
    }
    if let [target] = targets.as_slice() {
        return vec![RangeRule {
            source,
            target: *target,
            ratio,
            expand,
        }];
    }
    if ratio_part.is_some() {
        return Vec::new();
    }
    let mut rules = Vec::new();
    let mut start = source.start;
    for target in targets {
        let Some(end) = target.end else {
            return Vec::new();
        };
        let length = end - target.start + 1;
        rules.push(RangeRule {
            source: EpisodeRange {
                start,
                end: Some(start + length - 1),
            },
            target,
            ratio: 1,
            expand: None,
        });
        start += length;
    }
    rules
}

/// `findEpisodeRules(from, to)` reduced to what callers read: each rule
/// with its target id, in order.
///
/// # Errors
///
/// Fails on database errors.
pub async fn find_episode_rules(
    db: &Db,
    from: &IdRef,
    to: &str,
) -> Result<Vec<(RangeRule, String)>> {
    let edges = edges_from(db, &from.ns, &from.id).await?;
    let wanted = from
        .season
        .map(season_scope)
        .or_else(|| (from.ns == "anidb").then(|| String::from("R")));
    let scoped: Vec<Edge> = edges
        .into_iter()
        .filter(|e| wanted.as_ref().is_none_or(|w| e.src_scope == *w))
        .filter(|e| {
            e.src_range.as_deref().is_some_and(|r| !r.is_empty())
                && e.dst_range.as_deref().is_some_and(|r| !r.is_empty())
        })
        .collect();
    let mut out = Vec::new();
    for edge in edges_to(&scoped, to) {
        let (Some(src), Some(dst)) = (edge.src_range.as_deref(), edge.dst_range.as_deref()) else {
            continue;
        };
        for rule in parse_range_pair(src, dst) {
            out.push((rule, edge.dst_id.clone()));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edge(dataset: &str, src: (&str, &str, &str), dst: (&str, &str, &str)) -> Edge {
        Edge {
            dataset: dataset.to_owned(),
            src_ns: src.0.to_owned(),
            src_id: src.1.to_owned(),
            src_scope: src.2.to_owned(),
            dst_ns: dst.0.to_owned(),
            dst_id: dst.1.to_owned(),
            dst_scope: dst.2.to_owned(),
            src_range: None,
            dst_range: None,
        }
    }

    #[test]
    fn parses_ranges() {
        let r = |start, end| Some(EpisodeRange { start, end });
        assert_eq!(parse_episode_range("1-13"), r(1, Some(13)), "closed");
        assert_eq!(parse_episode_range("13-"), r(13, None), "open");
        assert_eq!(parse_episode_range("5"), r(5, Some(5)), "single");
        assert_eq!(parse_episode_range("-13"), r(1, Some(13)), "from one");
        assert_eq!(parse_episode_range(" 2 - 4 "), r(2, Some(4)), "spaced");
        for bad in ["", "abc", "5-3", "1-2-3", "-1-", "1.5"] {
            assert_eq!(parse_episode_range(bad), None, "{bad}");
        }
    }

    #[test]
    fn range_pairs() {
        let rules = parse_range_pair("1-12", "13-24");
        assert_eq!(rules.len(), 1, "one rule");
        let apply = |episode| rules.first().and_then(|r| apply_episode_rule(r, episode));
        assert_eq!(apply(1), Some(13), "offset");
        assert_eq!(apply(12), Some(24), "end");
        assert_eq!(apply(13), None, "outside");
        let open = parse_range_pair("14-", "14-");
        assert_eq!(
            open.first().and_then(|r| apply_episode_rule(r, 30)),
            Some(30),
            "open-ended"
        );
        let folded = parse_range_pair("1-4", "1-2|2");
        assert_eq!(
            folded.first().and_then(|r| apply_episode_rule(r, 3)),
            Some(2),
            "two per target"
        );
        let expanded = parse_range_pair("1-3", "1-12|-4");
        assert_eq!(
            expanded.first().and_then(|r| apply_episode_rule(r, 2)),
            Some(5),
            "first of four"
        );
        let runs = parse_range_pair("1-21", "1-15,17-22");
        assert_eq!(runs.len(), 2, "two runs");
        assert_eq!(
            runs.get(1).and_then(|r| apply_episode_rule(r, 16)),
            Some(17),
            "second run"
        );
        assert!(parse_range_pair("x", "1").is_empty(), "bad source");
        assert!(parse_range_pair("1-4", "1-2,x").is_empty(), "bad target");
        assert!(
            parse_range_pair("1-4", "1-2,3-|2").is_empty(),
            "scaled runs"
        );
        assert!(parse_range_pair("1-4", "1-2,3-").is_empty(), "open run");
    }

    #[test]
    fn best_ranked_dataset_per_scope() {
        let edges = vec![
            edge("fribb", ("anilist", "1", ""), ("tmdb_show", "9", "s1")),
            edge("anibridge", ("anilist", "1", ""), ("tmdb_show", "8", "s2")),
            edge("fribb", ("anilist", "1", "x"), ("tmdb_show", "7", "s1")),
            edge("anibridge", ("anilist", "1", ""), ("tmdb_movie", "6", "")),
        ];
        let to = edges_to(&edges, "tmdb_show");
        assert_eq!(
            to.iter().map(|e| e.dst_id.as_str()).collect::<Vec<_>>(),
            vec!["8", "7"],
            "anibridge wins its scope; fribb fills another"
        );
        let targets = targets_in(&edges, "tmdb_show");
        assert_eq!(
            targets,
            vec![
                Target {
                    id: String::from("8"),
                    season: Some(2)
                },
                Target {
                    id: String::from("7"),
                    season: Some(1)
                }
            ],
            "targets with their season"
        );
        assert_eq!(
            single(&edges, MediaType::Movie),
            Some(DatasetTmdb {
                tmdb_id: 6,
                media_type: MediaType::Movie,
                season: None
            }),
            "one film"
        );
        assert_eq!(
            single(&edges, MediaType::Tv),
            None,
            "two shows is a question"
        );
    }
}
