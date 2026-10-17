//! `POST /internal/simkl/resolve`, up to the posters.
//!
//! `resolveSimklCandidates` (`lib/simklCatalog.ts`) with `tmdbResolvers`,
//! `recordSimklGaps` and `toSimklWatchlistItems` (`routes/discover/simkl.ts`).
//! The caller adds `annotateProviderActiveRequests`.

use serde_json::{Map, Value};

use super::derive::AnimeHints;
use super::discover::{has_discover_tmdb_id, with_tmdb_posters};
use super::resolutions::{self, Observation};
use super::resolve::{self, Request};
use super::{probe, Ctx, IdRef, MediaType};
use crate::concurrency::{map_with_concurrency, PROVIDER_ROW_CONCURRENCY};
use crate::settings::public::truthy;

/// `SimklTmdbResolution`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Resolution {
    tmdb_id: Option<i64>,
    source_key: String,
    ambiguous: bool,
    media_type: Option<String>,
}

impl Resolution {
    fn unresolved() -> Self {
        Self {
            tmdb_id: None,
            source_key: String::from("simkl:unresolved"),
            ambiguous: false,
            media_type: None,
        }
    }

    fn ambiguous(source_key: &str) -> Self {
        Self {
            source_key: source_key.to_owned(),
            ambiguous: true,
            ..Self::unresolved()
        }
    }

    fn found(tmdb_id: i64, source_key: String, media_type: &str) -> Self {
        Self {
            tmdb_id: Some(tmdb_id),
            source_key,
            ambiguous: false,
            media_type: Some(media_type.to_owned()),
        }
    }
}

fn id_of(ids: Option<&Value>, key: &str) -> Option<Value> {
    ids.and_then(|i| i.get(key))
        .filter(|v| truthy(Some(v)))
        .cloned()
}

/// `mappingRefs(candidate)`: `AniList`, `AniDB`, MAL.
fn mapping_refs(ids: Option<&Value>) -> Vec<IdRef> {
    ["anilist", "anidb", "mal"]
        .iter()
        .filter_map(|ns| {
            id_of(ids, ns).map(|v| IdRef::new(ns, &crate::jsnum::value_string(Some(&v))))
        })
        .collect()
}

/// `tmdbResolvers(tmdb).findByExternalId`: through the mapping layer's
/// `/find`, so an id TMDB does not know is remembered for hours.
async fn find_ids(ctx: &Ctx<'_>, source: &str, external_id: &str, media_type: &str) -> Vec<i64> {
    if source == "tvdb" && media_type == "movie" {
        return Vec::new();
    }
    let Ok(found) = probe::tmdb_find(ctx, source, external_id).await else {
        return Vec::new();
    };
    let ids = if media_type == "movie" {
        found.movies
    } else {
        found.shows
    };
    ids.into_iter().filter(|id| *id > 0).collect()
}

/// A TVDB answer can only change the outcome when the IMDB one has not
/// already settled it: agreeing with Simkl's own id, or (without one)
/// naming a single record.
fn settled_by(found: &[i64], simkl_tmdb: Option<i64>) -> bool {
    simkl_tmdb.map_or(found.len() == 1, |tmdb| found.contains(&tmdb))
}

/// `resolveViaMappingLayer`.
async fn via_mapping_layer(ctx: &Ctx<'_>, candidate: &Value) -> Option<Resolution> {
    let ids = candidate.get("ids");
    let refs = mapping_refs(ids);
    let is_anime = truthy(candidate.get("isAnime"));
    if refs.is_empty() && !is_anime {
        return None;
    }
    let item = candidate.get("item");
    let source_id = item
        .and_then(|i| i.get("sourceId"))
        .filter(|s| truthy(Some(s)));
    let title = item
        .and_then(|i| i.get("title"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let declared = item.and_then(|i| i.get("mediaType"));
    let anime = is_anime.then(|| AnimeHints {
        anilist_id: id_of(ids, "anilist")
            .and_then(|v| v.as_f64())
            .and_then(super::int_of),
        titles: Some(
            title
                .clone()
                .filter(|t| !crate::jsval::trim(t).is_empty())
                .into_iter()
                .collect(),
        ),
        ..AnimeHints::default()
    });
    let resolution = resolve::resolve_tmdb(
        ctx,
        Request {
            refs,
            identity: source_id.map(|s| IdRef::new("simkl", &crate::jsnum::value_string(Some(s)))),
            media_type: MediaType::of(declared),
            title,
            year: candidate
                .get("year")
                .and_then(Value::as_f64)
                .and_then(super::int_of),
            discover_source: Some(String::from("simkl")),
            anime,
            ..Request::default()
        },
    )
    .await;
    let resolution = match resolution {
        Ok(Some(r)) => r,
        Ok(None) => return None,
        Err(e) => {
            tracing::debug!(
                label = "Mapping",
                "Simkl mapping-layer fallthrough failed: {e:#}"
            );
            return None;
        }
    };
    if !probe::confirm_tmdb_id(ctx, resolution.media_type.as_str(), resolution.tmdb_id).await {
        return None;
    }
    Some(Resolution::found(
        resolution.tmdb_id,
        format!("mapping:{}", resolution.origin),
        resolution.media_type.as_str(),
    ))
}

/// `resolveSimklTmdbId(candidate, resolvers)`.
async fn resolve_one(ctx: &Ctx<'_>, candidate: &Value) -> anyhow::Result<Resolution> {
    let item = candidate.get("item");
    let ids = candidate.get("ids");
    let declared = crate::jsnum::value_string(item.and_then(|i| i.get("mediaType")));
    let simkl_tmdb = id_of(ids, "tmdb").and_then(|v| v.as_f64());
    let imdb = id_of(ids, "imdb").map(|v| crate::jsnum::value_string(Some(&v)));
    let tv_db = id_of(ids, "tvdb").map(|v| crate::jsnum::value_string(Some(&v)));

    let simkl = item
        .and_then(|i| i.get("sourceId"))
        .filter(|s| truthy(Some(s)))
        .map(|s| IdRef::new("simkl", &crate::jsnum::value_string(Some(s))));
    let mapping = mapping_refs(ids);
    let ordered: Vec<Option<&IdRef>> = simkl.iter().chain(mapping.iter()).map(Some).collect();
    if let Some(correction) = resolutions::correction_for(ctx.db, &ordered).await? {
        return Ok(
            match (
                correction.tmdb_id.filter(|id| *id != 0),
                correction.tmdb_type.filter(|t| !t.is_empty()),
            ) {
                (Some(id), Some(kind)) => Resolution::found(id, String::from("manual"), &kind),
                _ => Resolution {
                    source_key: String::from("manual"),
                    ..Resolution::unresolved()
                },
            },
        );
    }

    let mut corroborating: Vec<(&str, Vec<i64>, String)> = Vec::new();
    if let Some(imdb) = &imdb {
        let found = find_ids(ctx, "imdb", imdb, &declared).await;
        corroborating.push(("tmdb-find:imdb", found, declared.clone()));
    }
    let tmdb_int = simkl_tmdb.and_then(super::int_of);
    let settled = corroborating
        .iter()
        .any(|(_, found, _)| settled_by(found, tmdb_int));
    if let Some(tvdb) = tv_db.as_ref().filter(|_| declared == "tv" && !settled) {
        let found = find_ids(ctx, "tvdb", tvdb, "tv").await;
        corroborating.push(("tmdb-find:tvdb", found, String::from("tv")));
    }
    if let (Some(tmdb_id), Some((key, _, kind))) = (
        tmdb_int,
        corroborating
            .iter()
            .find(|(_, found, _)| tmdb_int.is_some_and(|t| found.contains(&t))),
    ) {
        return Ok(Resolution::found(
            tmdb_id,
            format!("simkl:tmdb+{key}"),
            kind,
        ));
    }
    if let Some((key, found, kind)) = corroborating.iter().find(|(_, found, _)| found.len() == 1) {
        if let Some(id) = found.first() {
            return Ok(Resolution::found(*id, (*key).to_owned(), kind));
        }
    }
    if let Some((key, _, _)) = corroborating.iter().find(|(_, found, _)| found.len() > 1) {
        return Ok(Resolution::ambiguous(key));
    }
    if let Some(mapped) = via_mapping_layer(ctx, candidate).await {
        return Ok(mapped);
    }
    let Some(tmdb_id) = tmdb_int else {
        return Ok(Resolution::unresolved());
    };
    if truthy(candidate.get("isAnime")) {
        return Ok(Resolution::ambiguous("simkl:tmdb"));
    }
    if probe::confirm_tmdb_id(ctx, &declared, tmdb_id).await {
        return Ok(Resolution::found(
            tmdb_id,
            String::from("simkl:tmdb"),
            &declared,
        ));
    }
    Ok(Resolution::ambiguous("simkl:tmdb"))
}

/// One resolved candidate: the tile, how it resolved, its candidate.
type Resolved = (Map<String, Value>, Resolution, Value);

fn resolved_item(candidate: &Value, resolution: &Resolution) -> Map<String, Value> {
    let mut item = candidate
        .get("item")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(tmdb_id) = resolution.tmdb_id.filter(|id| *id > 0) {
        {
            let kind = resolution
                .media_type
                .clone()
                .map(Value::from)
                .or_else(|| item.get("mediaType").cloned())
                .unwrap_or(Value::Null);
            item.insert(String::from("tmdbId"), Value::from(tmdb_id));
            item.insert(String::from("id"), Value::from(tmdb_id));
            if kind.is_null() {
                item.shift_remove("mediaType");
            } else {
                item.insert(String::from("mediaType"), kind);
            }
        }
    } else {
        {
            let n = crate::jsval::number_of(item.get("sourceId"));
            let id = if n.is_nan() || n == 0.0 {
                Value::from(0)
            } else {
                crate::jsval::num(n)
            };
            item.insert(String::from("id"), id);
            if item.contains_key("tmdbId") {
                item.shift_remove("tmdbId");
            }
        }
    }
    item
}

/// `resolveSimklCandidates(candidates, tmdbResolvers(tmdb))`: a few at a
/// time, in order.
async fn resolve_candidates(ctx: &Ctx<'_>, candidates: Vec<Value>) -> Vec<Resolved> {
    map_with_concurrency(
        candidates,
        PROVIDER_ROW_CONCURRENCY,
        |candidate| async move {
            let resolution = resolve_one(ctx, &candidate)
                .await
                .unwrap_or_else(|_| Resolution::unresolved());
            let item = resolved_item(&candidate, &resolution);
            (item, resolution, candidate)
        },
    )
    .await
}

/// `recordSimklGaps(resolved, discoverSource)`.
fn record_gaps(ctx: &Ctx<'_>, resolved: &[Resolved], discover_source: &str) {
    for (item, resolution, candidate) in resolved {
        let source_id = item.get("sourceId").filter(|s| truthy(Some(s)));
        if has_discover_tmdb_id(item.get("tmdbId")) {
            continue;
        }
        let Some(source_id) = source_id else {
            continue;
        };
        let mut observation = Observation::new(IdRef::new(
            "simkl",
            &crate::jsnum::value_string(Some(source_id)),
        ))
        .with("title", item.get("title").cloned().unwrap_or(Value::Null))
        .with(
            "mediaType",
            item.get("mediaType").cloned().unwrap_or(Value::Null),
        )
        .with("discoverSource", Value::from(discover_source));
        let suggested = candidate
            .get("ids")
            .and_then(|i| i.get("tmdb"))
            .filter(|t| truthy(Some(t)));
        if let (true, Some(tmdb)) = (resolution.ambiguous, suggested) {
            observation = observation.with(
                "detail",
                Value::from(format!(
                    "Simkl suggests TMDB {}, unconfirmed",
                    crate::jsnum::value_string(Some(tmdb))
                )),
            );
        }
        resolutions::record_miss(ctx.db, observation);
    }
}

/// `withMappingState(resolved)`, then `omitUnmappedDiscoverItems`.
fn with_mapping_state(resolved: Vec<Resolved>, hide_unmapped: bool) -> Vec<Value> {
    resolved
        .into_iter()
        .map(|(mut item, resolution, _)| {
            let state = if has_discover_tmdb_id(item.get("tmdbId")) {
                "mapped"
            } else if resolution.ambiguous {
                "ambiguous"
            } else {
                "unmapped"
            };
            let mut mapping = Map::new();
            mapping.insert(String::from("state"), Value::from(state));
            mapping.insert(
                String::from("sourceKey"),
                Value::from(resolution.source_key),
            );
            mapping.insert(String::from("namespace"), Value::from("simkl"));
            if let Some(source_id) = item.get("sourceId").filter(|s| truthy(Some(s))) {
                mapping.insert(String::from("externalId"), source_id.clone());
            }
            item.insert(String::from("mappingState"), Value::Object(mapping));
            Value::Object(item)
        })
        .filter(|item| {
            !hide_unmapped
                || (has_discover_tmdb_id(item.get("tmdbId"))
                    && matches!(
                        item.get("mediaType").and_then(Value::as_str),
                        Some("movie" | "tv")
                    ))
        })
        .collect()
}

/// One trending page resolved and drawn, before anything request-specific:
/// the gap sightings and `hideUnmapped` run on every serve
/// ([`ResolvedPage::serve`]).
#[derive(Debug, Clone)]
pub struct ResolvedPage {
    /// The unresolved items, for the sightings.
    gaps: Vec<Resolved>,
    /// Every tile, with its mapping state and art.
    tiles: Vec<Value>,
}

impl ResolvedPage {
    /// `recordSimklGaps`, then `omitUnmappedDiscoverItems`.
    #[must_use]
    pub fn serve(&self, ctx: &Ctx<'_>, discover_source: &str, hide_unmapped: bool) -> Vec<Value> {
        record_gaps(ctx, &self.gaps, discover_source);
        self.tiles
            .iter()
            .filter(|item| {
                !hide_unmapped
                    || (has_discover_tmdb_id(item.get("tmdbId"))
                        && matches!(
                            item.get("mediaType").and_then(Value::as_str),
                            Some("movie" | "tv")
                        ))
            })
            .cloned()
            .collect()
    }
}

/// `resolveCatalogPage` past the hydration: resolve, then draw every tile.
/// Art is per tile, so drawing every tile and dropping some afterwards
/// leaves the same tiles as dropping first.
pub async fn resolve_page(ctx: &Ctx<'_>, candidates: Vec<Value>) -> ResolvedPage {
    let resolved = resolve_candidates(ctx, candidates).await;
    let gaps = resolved
        .iter()
        .filter(|(item, _, _)| !has_discover_tmdb_id(item.get("tmdbId")))
        .cloned()
        .collect();
    ResolvedPage {
        gaps,
        tiles: with_tmdb_posters(ctx, with_mapping_state(resolved, false)).await,
    }
}

/// The `/internal/simkl/resolve` work before `annotateProviderActiveRequests`.
pub async fn resolve(
    ctx: &Ctx<'_>,
    candidates: Vec<Value>,
    discover_source: &str,
    hide_unmapped: bool,
) -> Vec<Value> {
    let resolved = resolve_candidates(ctx, candidates).await;
    record_gaps(ctx, &resolved, discover_source);
    with_tmdb_posters(ctx, with_mapping_state(resolved, hide_unmapped)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tiles_carry_the_resolution() {
        let candidate = json!({"item": {"id": 7, "ratingKey": "simkl-7", "mediaType": "tv", "title": "X", "source": "simkl", "sourceId": "7"}, "ids": {}, "isAnime": false, "typedFromSource": true});
        let found = Resolution::found(42, String::from("simkl:tmdb"), "movie");
        let item = resolved_item(&candidate, &found);
        assert_eq!(
            Value::Object(item).to_string(),
            r#"{"id":42,"ratingKey":"simkl-7","mediaType":"movie","title":"X","source":"simkl","sourceId":"7","tmdbId":42}"#,
            "mapped tile"
        );
        let missed = resolved_item(&candidate, &Resolution::ambiguous("simkl:tmdb"));
        let tiles = with_mapping_state(
            vec![(missed, Resolution::ambiguous("simkl:tmdb"), candidate)],
            false,
        );
        assert_eq!(
            tiles.first().map(ToString::to_string).as_deref(),
            Some(
                r#"{"id":7,"ratingKey":"simkl-7","mediaType":"tv","title":"X","source":"simkl","sourceId":"7","mappingState":{"state":"ambiguous","sourceKey":"simkl:tmdb","namespace":"simkl","externalId":"7"}}"#
            ),
            "ambiguous tile"
        );
    }

    #[test]
    fn tvdb_only_when_imdb_left_it_open() {
        assert!(settled_by(&[1429], Some(1429)), "imdb agrees with simkl");
        assert!(!settled_by(&[500], Some(1429)), "tvdb may still agree");
        assert!(
            settled_by(&[500], None),
            "one record, nothing to agree with"
        );
        assert!(!settled_by(&[], None), "no answer");
        assert!(!settled_by(&[1, 2], None), "a split");
    }

    #[test]
    fn mapping_refs_in_order() {
        let ids = json!({"mal": 3, "anilist": 1, "anidb": 2, "tmdb": 9});
        let keys: Vec<String> = mapping_refs(Some(&ids)).iter().map(IdRef::key).collect();
        assert_eq!(
            keys,
            vec!["anilist:1", "anidb:2", "mal:3"],
            "anilist, anidb, mal"
        );
    }
}
