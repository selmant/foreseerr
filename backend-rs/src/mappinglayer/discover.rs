//! The discover side of the mapping layer.
//!
//! `lib/discover/validity.ts`, `posters.ts`, `resolveItems.ts`,
//! `unmapped.ts`, `lib/trakt/mapping.ts` and `mapAnilistMediaList`
//! (`lib/anilist/discover.ts` over `lib/anilist/mapping.ts`). Items are the
//! JSON objects Node's functions take and return, so keys keep their order.

use std::collections::HashSet;

use anyhow::Result;
use serde_json::{Map, Value};

use super::derive::AnimeHints;
use super::resolutions::{self, Observation};
use super::resolve::{self, Request};
use super::{probe, Ctx, IdRef, MediaType, NAMESPACES};
use crate::concurrency::{map_with_concurrency, PROVIDER_ROW_CONCURRENCY};
use crate::settings::public::truthy;

/// `hasDiscoverTmdbId(value)`: a finite number above zero.
#[must_use]
pub fn has_discover_tmdb_id(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_f64)
        .is_some_and(|n| n.is_finite() && n > 0.0)
}

fn text(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_owned)
}

fn year(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_f64).and_then(super::int_of)
}

/// `value` unless it is `null`.
fn non_null(value: Option<&Value>) -> Option<&Value> {
    value.filter(|v| !v.is_null())
}

/// `{ namespace, externalId }` of an identity.
fn source_of(identity: Option<&IdRef>) -> Map<String, Value> {
    let mut source = Map::new();
    if let Some(identity) = identity {
        source.insert(String::from("namespace"), Value::from(identity.ns.as_str()));
        source.insert(
            String::from("externalId"),
            Value::from(identity.id.as_str()),
        );
    }
    source
}

fn mapping_state(state: &str, source_key: Option<&str>, source: Map<String, Value>) -> Value {
    let mut out = Map::new();
    out.insert(String::from("state"), Value::from(state));
    if let Some(key) = source_key {
        out.insert(String::from("sourceKey"), Value::from(key));
    }
    out.extend(source);
    Value::Object(out)
}

/// What `confirmOrRepair` is given about an item.
#[derive(Debug, Clone, Default)]
pub struct Confirmable {
    /// `tmdbId`.
    pub tmdb_id: Option<f64>,
    /// `mediaType` as the source gave it.
    pub media_type: Value,
    /// `title`.
    pub title: Value,
    /// `year`.
    pub year: Value,
    /// `refs`.
    pub refs: Vec<IdRef>,
}

impl Confirmable {
    /// From the JSON item of `POST /internal/mapping/confirm`.
    #[must_use]
    pub fn of(item: &Value) -> Self {
        Self {
            tmdb_id: item.get("tmdbId").and_then(Value::as_f64),
            media_type: item.get("mediaType").cloned().unwrap_or(Value::Null),
            title: item.get("title").cloned().unwrap_or(Value::Null),
            year: item.get("year").cloned().unwrap_or(Value::Null),
            refs: refs_of(item.get("refs")),
        }
    }
}

fn refs_of(value: Option<&Value>) -> Vec<IdRef> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(|r| IdRef::of(Some(r))).collect())
        .unwrap_or_default()
}

/// `confirmOrRepair` options.
#[derive(Debug, Clone, Default)]
pub struct ConfirmOptions {
    /// `discoverSource`.
    pub discover_source: Option<String>,
    /// `offline`.
    pub offline: bool,
    /// `namespace` (the identity).
    pub namespace: Option<IdRef>,
}

impl ConfirmOptions {
    /// From the route's `options` object.
    #[must_use]
    pub fn of(options: Option<&Value>) -> Self {
        Self {
            discover_source: text(options.and_then(|o| o.get("discoverSource"))),
            offline: truthy(options.and_then(|o| o.get("offline"))),
            namespace: IdRef::of(options.and_then(|o| o.get("namespace"))),
        }
    }
}

/// `repairDeadTmdbId`: the first of the item's other ids that resolves
/// to a different, live record.
async fn repair(
    ctx: &Ctx<'_>,
    item: &Confirmable,
    identity: Option<&IdRef>,
    dead: i64,
    options: &ConfirmOptions,
) -> Result<Option<(i64, String)>> {
    let declared = item.media_type.as_str().unwrap_or_default();
    for r in &item.refs {
        let resolution = resolve::resolve_tmdb(
            ctx,
            Request {
                refs: vec![r.clone()],
                identity: identity.cloned(),
                media_type: MediaType::parse(declared),
                title: text(Some(&item.title)),
                year: year(Some(&item.year)),
                discover_source: options.discover_source.clone(),
                offline: options.offline,
                ..Request::default()
            },
        )
        .await?;
        let Some(resolution) = resolution else {
            continue;
        };
        if resolution.media_type.as_str() != declared || resolution.tmdb_id == dead {
            continue;
        }
        if !probe::confirm_tmdb_id(ctx, declared, resolution.tmdb_id).await {
            continue;
        }
        return Ok(Some((resolution.tmdb_id, resolution.origin)));
    }
    Ok(None)
}

/// `confirmOrRepair(item, options)`: `None` when the id is fine, else the
/// replacement (`ConfirmedItem` as JSON).
///
/// # Errors
///
/// Fails on database errors.
pub async fn confirm_or_repair(
    ctx: &Ctx<'_>,
    item: &Confirmable,
    options: &ConfirmOptions,
) -> Result<Option<Value>> {
    let Some(tmdb_id) = item.tmdb_id.filter(|n| *n > 0.0).and_then(super::int_of) else {
        return Ok(None);
    };
    let identity = options
        .namespace
        .clone()
        .or_else(|| item.refs.first().cloned());
    let source = source_of(identity.as_ref());
    let mut ordered: Vec<Option<&IdRef>> = vec![identity.as_ref()];
    ordered.extend(item.refs.iter().map(Some));
    let declared = item.media_type.as_str().unwrap_or_default();

    if let Some(correction) = resolutions::correction_for(ctx.db, &ordered).await? {
        let corrected_type = correction.tmdb_type.as_deref().unwrap_or(declared);
        if correction.tmdb_id == Some(tmdb_id) && corrected_type == declared {
            return Ok(None);
        }
        let mut out = Map::new();
        if let Some(id) = correction.tmdb_id {
            out.insert(String::from("tmdbId"), Value::from(id));
        }
        if let Some(kind) = correction.tmdb_type.as_deref().filter(|k| !k.is_empty()) {
            out.insert(String::from("mediaType"), Value::from(kind));
        }
        let state = if correction.tmdb_id.is_some_and(|id| id != 0) {
            "mapped"
        } else {
            "unmapped"
        };
        out.insert(
            String::from("mappingState"),
            mapping_state(state, Some("manual"), source),
        );
        return Ok(Some(Value::Object(out)));
    }

    if probe::probe(ctx, declared, tmdb_id).await.alive {
        return Ok(None);
    }

    if let Some((repaired, origin)) = repair(ctx, item, identity.as_ref(), tmdb_id, options).await?
    {
        tracing::debug!(
            label = "Mapping",
            was = format!(
                "{}:{tmdb_id}",
                MediaType::parse(declared)
                    .unwrap_or(MediaType::Tv)
                    .namespace()
            ),
            now = repaired,
            "Recovered a dead TMDB id from the source ids"
        );
        let mut out = Map::new();
        out.insert(String::from("tmdbId"), Value::from(repaired));
        out.insert(
            String::from("mappingState"),
            mapping_state("mapped", Some(&origin), source),
        );
        return Ok(Some(Value::Object(out)));
    }

    if let Some(identity) = identity {
        resolutions::record_miss(
            ctx.db,
            Observation::new(identity)
                .with("mediaType", item.media_type.clone())
                .with("title", item.title.clone())
                .with("year", item.year.clone())
                .with(
                    "discoverSource",
                    options
                        .discover_source
                        .clone()
                        .map_or(Value::Null, Value::from),
                )
                .with(
                    "detail",
                    Value::from(format!(
                        "TMDB {} {tmdb_id} no longer exists",
                        crate::jsnum::value_string(Some(&item.media_type))
                    )),
                ),
        );
    }
    let mut out = Map::new();
    out.insert(
        String::from("mappingState"),
        mapping_state("unmapped", Some("tmdb-confirm"), source),
    );
    Ok(Some(Value::Object(out)))
}

/// `POST /internal/mapping/confirm`: `confirmOrRepair` for each item, a
/// few at a time, `null` where the id is fine.
///
/// # Errors
///
/// Fails when any item fails (as `Promise.all` rejects).
pub async fn confirm_items(
    ctx: &Ctx<'_>,
    items: &[Value],
    options: Option<&Value>,
) -> Result<Vec<Value>> {
    let options = ConfirmOptions::of(options);
    let options = &options;
    map_with_concurrency(
        items.iter().collect(),
        PROVIDER_ROW_CONCURRENCY,
        |item: &Value| async move { confirm_or_repair(ctx, &Confirmable::of(item), options).await },
    )
    .await
    .into_iter()
    .map(|r| r.map(|v| v.unwrap_or(Value::Null)))
    .collect()
}

/// `withTmdbPoster(item)`: the poster, backdrop, date and score
/// (`voteAverage`) the confirm probe already fetched, on a tile that has
/// none.
pub async fn with_tmdb_poster(ctx: &Ctx<'_>, item: Value) -> Value {
    let Value::Object(mut map) = item else {
        return item;
    };
    let tmdb_id = map
        .get("tmdbId")
        .and_then(Value::as_f64)
        .and_then(super::int_of);
    let kind = map
        .get("mediaType")
        .filter(|k| truthy(Some(k)))
        .map(|k| crate::jsnum::value_string(Some(k)));
    if truthy(map.get("posterPath")) || !has_discover_tmdb_id(map.get("tmdbId")) {
        return Value::Object(map);
    }
    let (Some(kind), Some(tmdb_id)) = (kind, tmdb_id) else {
        return Value::Object(map);
    };
    let record = probe::probe(ctx, &kind, tmdb_id).await;
    if !record.alive {
        return Value::Object(map);
    }
    if let Some(poster) = record.poster_path {
        map.insert(String::from("posterPath"), Value::from(poster));
    }
    if let Some(backdrop) = record.backdrop_path {
        map.insert(String::from("backdropPath"), Value::from(backdrop));
    }
    if kind == "movie" {
        if let Some(date) = record.release_date {
            map.insert(String::from("releaseDate"), Value::from(date));
        }
    }
    if kind == "tv" {
        if let Some(date) = record.first_air_date {
            map.insert(String::from("firstAirDate"), Value::from(date));
        }
    }
    if let Some(score) = record.vote_average {
        map.insert(String::from("voteAverage"), Value::Number(score));
    }
    Value::Object(map)
}

/// `withTmdbPosters(items)`, a few at a time.
pub async fn with_tmdb_posters(ctx: &Ctx<'_>, items: Vec<Value>) -> Vec<Value> {
    map_with_concurrency(items, PROVIDER_ROW_CONCURRENCY, |item| {
        with_tmdb_poster(ctx, item)
    })
    .await
}

/// `resolveDiscoverItems(items, { discoverSource, offline })`.
///
/// # Errors
///
/// Fails on database errors.
pub async fn resolve_discover_items(
    ctx: &Ctx<'_>,
    items: Vec<Value>,
    discover_source: Option<String>,
    offline: bool,
) -> Result<Vec<Value>> {
    let source = discover_source.as_deref();
    let resolved = map_with_concurrency(items, PROVIDER_ROW_CONCURRENCY, |item| {
        resolve_discover_item(ctx, item, source, offline)
    })
    .await
    .into_iter()
    .collect::<Result<Vec<Value>>>()?;
    Ok(with_tmdb_posters(ctx, resolved).await)
}

/// One item of `resolveDiscoverItems`, before its poster.
async fn resolve_discover_item(
    ctx: &Ctx<'_>,
    item: Value,
    discover_source: Option<&str>,
    offline: bool,
) -> Result<Value> {
    let Value::Object(mut item) = item else {
        return Ok(item);
    };
    let from = IdRef::of(item.get("from"));
    let from_given = item.get("from").is_some_and(|f| truthy(Some(f)));
    item.shift_remove("from");
    if has_discover_tmdb_id(item.get("tmdbId")) {
        let confirmed = if truthy(item.get("mediaType")) {
            let confirmable = Confirmable {
                tmdb_id: item.get("tmdbId").and_then(Value::as_f64),
                media_type: item.get("mediaType").cloned().unwrap_or(Value::Null),
                title: item.get("title").cloned().unwrap_or(Value::Null),
                year: Value::Null,
                refs: from.iter().cloned().collect(),
            };
            let options = ConfirmOptions {
                discover_source: discover_source.map(str::to_owned),
                offline,
                namespace: from.clone(),
            };
            confirm_or_repair(ctx, &confirmable, &options).await?
        } else {
            None
        };
        let state = match confirmed {
            Some(Value::Object(mut confirmed)) => {
                match confirmed.get("tmdbId").cloned() {
                    Some(id) => {
                        item.insert(String::from("tmdbId"), id.clone());
                        item.insert(String::from("id"), id);
                    }
                    None => {
                        item.shift_remove("tmdbId");
                    }
                }
                if let Some(kind) = confirmed.get("mediaType").cloned() {
                    item.insert(String::from("mediaType"), kind);
                }
                confirmed
                    .shift_remove("mappingState")
                    .unwrap_or(Value::Null)
            }
            _ => mapping_state("mapped", None, Map::new()),
        };
        item.insert(String::from("mappingState"), state);
        return Ok(Value::Object(item));
    }
    let Some(from) = from.filter(|_| from_given) else {
        item.insert(
            String::from("mappingState"),
            mapping_state("unmapped", None, Map::new()),
        );
        return Ok(Value::Object(item));
    };
    let declared = item
        .get("mediaType")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let resolution = resolve::resolve_tmdb(
        ctx,
        Request {
            refs: vec![from.clone()],
            media_type: declared.as_deref().and_then(MediaType::parse),
            title: text(item.get("title")),
            discover_source: discover_source.map(str::to_owned),
            offline,
            ..Request::default()
        },
    )
    .await?;
    let source = source_of(Some(&from));
    let confirmed = match &resolution {
        Some(r) => probe::confirm_tmdb_id(ctx, r.media_type.as_str(), r.tmdb_id).await,
        None => false,
    };
    match resolution.filter(|_| confirmed) {
        Some(r) => {
            item.insert(String::from("tmdbId"), Value::from(r.tmdb_id));
            item.insert(String::from("id"), Value::from(r.tmdb_id));
            item.insert(
                String::from("mediaType"),
                Value::from(r.media_type.as_str()),
            );
            item.insert(
                String::from("mappingState"),
                mapping_state("mapped", Some(&r.origin), source),
            );
        }
        None => {
            item.insert(
                String::from("mappingState"),
                mapping_state("unmapped", None, source),
            );
        }
    }
    Ok(Value::Object(item))
}

/// `SOURCE_NAMESPACE[source]`.
fn source_namespace(source: &str) -> Option<&'static str> {
    match source {
        "trakt" => Some("trakt"),
        "anilist" => Some("anilist"),
        "simkl" => Some("simkl"),
        "mdblist" | "plex" => Some("imdb"),
        _ => None,
    }
}

/// `recordUnmappedItems(items, { discoverSource, namespace })`: count every
/// item without a usable TMDB id.
pub fn record_unmapped_items(ctx: &Ctx<'_>, items: &[Value], options: Option<&Value>) {
    let option_source = options
        .and_then(|o| o.get("discoverSource"))
        .filter(|v| !v.is_null());
    let option_namespace = options
        .and_then(|o| o.get("namespace"))
        .filter(|v| !v.is_null());
    for item in items {
        if has_discover_tmdb_id(item.get("tmdbId")) {
            continue;
        }
        let state = item.get("mappingState").filter(|s| !s.is_null());
        let mapped = state
            .and_then(|s| s.get("namespace"))
            .and_then(Value::as_str)
            .filter(|ns| NAMESPACES.contains(ns));
        let source = item.get("source").filter(|s| truthy(Some(s)));
        let namespace = mapped
            .map(str::to_owned)
            .or_else(|| option_namespace.map(|ns| crate::jsnum::value_string(Some(ns))))
            .or_else(|| {
                source
                    .and_then(Value::as_str)
                    .and_then(source_namespace)
                    .map(str::to_owned)
            });
        let external = state
            .and_then(|s| s.get("externalId"))
            .filter(|v| !v.is_null())
            .or_else(|| item.get("sourceId"));
        let external = super::id_text(external);
        let Some(namespace) = namespace.filter(|ns| !ns.is_empty()) else {
            continue;
        };
        if external.is_empty() {
            continue;
        }
        let discover_source = option_source
            .cloned()
            .or_else(|| item.get("source").cloned())
            .unwrap_or(Value::Null);
        resolutions::record_miss(
            ctx.db,
            Observation::new(IdRef::new(&namespace, &external))
                .with("title", item.get("title").cloned().unwrap_or(Value::Null))
                .with(
                    "mediaType",
                    item.get("mediaType").cloned().unwrap_or(Value::Null),
                )
                .with("discoverSource", discover_source),
        );
    }
}

// ---------------------------------------------------------------------------
// Trakt (`lib/trakt/mapping.ts`).

/// `traktRef(item)`.
fn trakt_ref(item: &Value) -> Option<IdRef> {
    let slug = item.get("traktSlug").filter(|s| !s.is_null());
    let id = slug.map_or_else(
        || {
            let trakt = item.get("traktId");
            if truthy(trakt) {
                crate::jsnum::value_string(trakt)
            } else {
                String::new()
            }
        },
        |slug| crate::jsnum::value_string(Some(slug)),
    );
    (!id.is_empty()).then(|| IdRef::new("trakt", &id))
}

/// `sourceRefs(item)`: `IMDb`, then TVDB for a show.
fn trakt_source_refs(item: &Value) -> Vec<IdRef> {
    let mut refs = Vec::new();
    if let Some(imdb) = item.get("imdbId").filter(|v| truthy(Some(v))) {
        refs.push(IdRef::new("imdb", &crate::jsnum::value_string(Some(imdb))));
    }
    let tvdb = item.get("tvdbId");
    if truthy(tvdb) && item.get("mediaType").and_then(Value::as_str) == Some("tv") {
        refs.push(IdRef::new("tvdb_show", &crate::jsnum::value_string(tvdb)));
    }
    refs
}

/// `hydrateTraktTmdbIds(items, { discoverSource })`.
///
/// # Errors
///
/// Fails when the mapping layer can't be loaded.
pub async fn hydrate_trakt_tmdb_ids(
    ctx: &Ctx<'_>,
    items: Vec<Value>,
    discover_source: &str,
) -> Result<Vec<Value>> {
    map_with_concurrency(items, PROVIDER_ROW_CONCURRENCY, |item| async move {
        if truthy(item.get("tmdbId")) {
            return Ok(item);
        }
        let declared = item.get("mediaType").and_then(Value::as_str);
        let resolution = resolve::resolve_tmdb(
            ctx,
            Request {
                refs: trakt_source_refs(&item),
                identity: trakt_ref(&item),
                media_type: declared.and_then(MediaType::parse),
                title: text(item.get("title")),
                year: year(item.get("year")),
                discover_source: Some(discover_source.to_owned()),
                ..Request::default()
            },
        )
        .await?;
        Ok(match (resolution, item) {
            (Some(r), Value::Object(mut map))
                if Some(r.media_type.as_str()) == map.get("mediaType").and_then(Value::as_str)
                    && r.tmdb_id != 0 =>
            {
                map.insert(String::from("tmdbId"), Value::from(r.tmdb_id));
                Value::Object(map)
            }
            (_, item) => item,
        })
    })
    .await
    .into_iter()
    .collect()
}

/// `confirmTraktTmdbIds(items, { discoverSource })`.
///
/// # Errors
///
/// Fails on database errors.
pub async fn confirm_trakt_tmdb_ids(
    ctx: &Ctx<'_>,
    items: Vec<Value>,
    discover_source: &str,
) -> Result<Vec<Value>> {
    let options: Vec<ConfirmOptions> = items
        .iter()
        .map(|item| ConfirmOptions {
            discover_source: Some(discover_source.to_owned()),
            offline: false,
            namespace: trakt_ref(item),
        })
        .collect();
    let mut replacements = Vec::new();
    let pending = map_with_concurrency(
        items.iter().zip(&options).collect(),
        PROVIDER_ROW_CONCURRENCY,
        |(item, options): (&Value, &ConfirmOptions)| async move {
            if !truthy(item.get("tmdbId")) {
                return Ok(None);
            }
            let confirmable = Confirmable {
                tmdb_id: item.get("tmdbId").and_then(Value::as_f64),
                media_type: item.get("mediaType").cloned().unwrap_or(Value::Null),
                title: item.get("title").cloned().unwrap_or(Value::Null),
                year: item.get("year").cloned().unwrap_or(Value::Null),
                refs: trakt_source_refs(item),
            };
            confirm_or_repair(ctx, &confirmable, options).await
        },
    )
    .await;
    for result in pending {
        replacements.push(result?);
    }
    Ok(items
        .into_iter()
        .zip(replacements)
        .map(|(item, replacement)| match (item, replacement) {
            (Value::Object(mut map), Some(confirmed)) => {
                match confirmed.get("tmdbId") {
                    Some(id) => {
                        map.insert(String::from("tmdbId"), id.clone());
                    }
                    None => {
                        map.shift_remove("tmdbId");
                    }
                }
                if let Some(kind) = confirmed.get("mediaType") {
                    map.insert(String::from("mediaType"), kind.clone());
                }
                Value::Object(map)
            }
            (item, _) => item,
        })
        .collect())
}

// ---------------------------------------------------------------------------
// AniList (`mapAnilistMediaList`).

/// `anilistMediaTitle(media)`.
#[must_use]
pub fn anilist_media_title(media: &Value) -> String {
    let title = media.get("title").filter(|t| !t.is_null());
    ["english", "romaji", "native"]
        .iter()
        .filter_map(|k| title.and_then(|t| t.get(*k)).and_then(Value::as_str))
        .map(crate::jsval::trim)
        .find(|t| !t.is_empty())
        .unwrap_or_default()
        .to_owned()
}

fn cover_image(media: &Value) -> Option<String> {
    let cover = media.get("coverImage").filter(|c| !c.is_null());
    ["large", "medium"]
        .iter()
        .filter_map(|k| cover.and_then(|c| c.get(*k)).and_then(Value::as_str))
        .map(crate::jsval::trim)
        .find(|t| !t.is_empty())
        .map(str::to_owned)
}

/// `anilistIdMapping.getFromAnilistId(anilistId, preferred, { title, media, offline })`.
///
/// # Errors
///
/// Fails when the mapping layer can't be loaded.
pub async fn tmdb_for_anilist(
    ctx: &Ctx<'_>,
    anilist_id: i64,
    preferred: Option<MediaType>,
    title_hint: Option<&str>,
    media: Option<&Value>,
    offline: bool,
) -> Result<Option<(i64, MediaType)>> {
    let format = media.and_then(|m| m.get("format")).and_then(Value::as_str);
    let declared = preferred.or_else(|| {
        format.filter(|f| !f.is_empty()).map(|f| {
            if f == "MOVIE" {
                MediaType::Movie
            } else {
                MediaType::Tv
            }
        })
    });
    let order = declared.map_or_else(|| vec![MediaType::Tv, MediaType::Movie], |t| vec![t]);
    let title = media.and_then(|m| m.get("title")).filter(|t| !t.is_null());
    let field = |k: &str| title.and_then(|t| t.get(k)).and_then(Value::as_str);
    let titles: Vec<String> = [
        field("native"),
        field("romaji"),
        field("english"),
        title_hint,
    ]
    .into_iter()
    .flatten()
    .filter(|t| !crate::jsval::trim(t).is_empty())
    .map(str::to_owned)
    .collect();
    let year = media
        .and_then(|m| non_null(non_null(m.get("startDate")).and_then(|d| d.get("year"))))
        .or_else(|| media.and_then(|m| non_null(m.get("seasonYear"))))
        .and_then(Value::as_f64)
        .and_then(super::int_of);
    let relations = media
        .and_then(|m| m.get("relations"))
        .filter(|r| truthy(Some(r)))
        .map(|r| {
            r.get("edges")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        });
    for kind in order {
        let resolution = resolve::resolve_tmdb(
            ctx,
            Request {
                refs: vec![IdRef::new("anilist", &anilist_id.to_string())],
                media_type: Some(kind),
                title: title_hint
                    .map(str::to_owned)
                    .or_else(|| titles.first().cloned()),
                year,
                discover_source: Some(String::from("anilist")),
                offline,
                anime: Some(AnimeHints {
                    anilist_id: Some(anilist_id),
                    titles: Some(titles.clone()),
                    year,
                    format: format.map(str::to_owned),
                    relations: relations.clone(),
                }),
                ..Request::default()
            },
        )
        .await?;
        let Some(resolution) = resolution else {
            continue;
        };
        if !probe::confirm_tmdb_id(ctx, resolution.media_type.as_str(), resolution.tmdb_id).await {
            continue;
        }
        return Ok(Some((resolution.tmdb_id, resolution.media_type)));
    }
    Ok(None)
}

/// `mapAnilistMedia(media)`.
async fn map_anilist_media(ctx: &Ctx<'_>, media: &Value) -> Result<Option<Map<String, Value>>> {
    let Some(id) = media
        .get("id")
        .filter(|id| truthy(Some(id)))
        .and_then(Value::as_i64)
    else {
        return Ok(None);
    };
    let format = media.get("format").and_then(Value::as_str);
    if format == Some("MUSIC") {
        return Ok(None);
    }
    super::ensure(ctx.db).await?;
    let preferred = if format == Some("MOVIE") {
        MediaType::Movie
    } else {
        MediaType::Tv
    };
    let mut title = anilist_media_title(media);
    if title.is_empty() {
        title = format!("AniList {id}");
    }
    let mapped =
        tmdb_for_anilist(ctx, id, Some(preferred), Some(&title), Some(media), false).await?;
    let mut out = Map::new();
    out.insert(String::from("anilistId"), Value::from(id));
    let kind = match mapped {
        Some((tmdb_id, kind)) => {
            out.insert(String::from("tmdbId"), Value::from(tmdb_id));
            kind
        }
        None => preferred,
    };
    out.insert(String::from("mediaType"), Value::from(kind.as_str()));
    out.insert(String::from("title"), Value::from(title));
    if let Some(image) = cover_image(media) {
        out.insert(String::from("image"), Value::from(image));
    }
    Ok(Some(out))
}

/// `mapAnilistMediaList(media)`: each entry mapped, without repeats of an
/// `AniList` id or of a TMDB id.
///
/// # Errors
///
/// Fails when the mapping layer can't be loaded.
pub async fn map_anilist_media_list(ctx: &Ctx<'_>, media: &[Value]) -> Result<Vec<Value>> {
    let mapped = map_with_concurrency(media.iter().collect(), PROVIDER_ROW_CONCURRENCY, |entry| {
        map_anilist_media(ctx, entry)
    })
    .await;
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for item in mapped {
        let Some(item) = item? else {
            continue;
        };
        let anilist_key = format!(
            "anilist:{}",
            crate::jsnum::value_string(item.get("anilistId"))
        );
        if !seen.insert(anilist_key) {
            continue;
        }
        if has_discover_tmdb_id(item.get("tmdbId")) {
            let tmdb_key = format!(
                "{}:{}",
                crate::jsnum::value_string(item.get("mediaType")),
                crate::jsnum::value_string(item.get("tmdbId"))
            );
            if !seen.insert(tmdb_key) {
                continue;
            }
        }
        out.push(Value::Object(item));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn posters_carry_the_score() {
        crate::tmdb::remember_for_tests(
            "/movie/9700101",
            &[("language", "en")],
            json!({"id": 9_700_101, "title": "Scored", "poster_path": "/s.jpg", "backdrop_path": "/b.jpg",
                   "release_date": "2020-01-02", "vote_average": 7.25}),
        );
        crate::tmdb::remember_for_tests(
            "/tv/9700102",
            &[("language", "en")],
            json!({"id": 9_700_102, "name": "Unscored", "poster_path": "/u.jpg", "first_air_date": "2021-03-04"}),
        );
        let db = crate::db::Db::Sqlite(
            sqlx::sqlite::SqlitePoolOptions::new()
                .connect_lazy_with(sqlx::sqlite::SqliteConnectOptions::new().filename(":memory:")),
        );
        if rustls::crypto::ring::default_provider()
            .install_default()
            .is_err()
        {
            tracing::trace!("a provider was installed");
        }
        let http = reqwest::Client::new();
        let tmdb = crate::tmdb::TmdbClient::new(http.clone());
        let ctx = Ctx {
            db: &db,
            tmdb: &tmdb,
            http: &http,
            locale: String::from("en"),
        };
        let movie = with_tmdb_poster(
            &ctx,
            json!({"id": 9_700_101, "tmdbId": 9_700_101, "mediaType": "movie", "title": "Scored"}),
        )
        .await;
        assert_eq!(
            movie.to_string(),
            r#"{"id":9700101,"tmdbId":9700101,"mediaType":"movie","title":"Scored","posterPath":"/s.jpg","backdropPath":"/b.jpg","releaseDate":"2020-01-02","voteAverage":7.25}"#,
            "art, date and score in Node's order"
        );
        let show = with_tmdb_poster(
            &ctx,
            json!({"id": 9_700_102, "tmdbId": 9_700_102, "mediaType": "tv", "title": "Unscored"}),
        )
        .await;
        assert_eq!(
            show.to_string(),
            r#"{"id":9700102,"tmdbId":9700102,"mediaType":"tv","title":"Unscored","posterPath":"/u.jpg","firstAirDate":"2021-03-04"}"#,
            "no score, no field"
        );
    }

    #[test]
    fn tmdb_ids() {
        assert!(has_discover_tmdb_id(Some(&json!(5))), "positive");
        for bad in [json!(0), json!(-1), json!("5"), Value::Null] {
            assert!(!has_discover_tmdb_id(Some(&bad)), "{bad}");
        }
        assert!(!has_discover_tmdb_id(None), "missing");
    }

    #[test]
    fn trakt_refs() {
        let item = json!({"traktSlug": "the-thing", "traktId": 3, "imdbId": "tt1", "tvdbId": 9, "mediaType": "tv"});
        assert_eq!(
            trakt_ref(&item).map(|r| r.key()).as_deref(),
            Some("trakt:the-thing"),
            "slug"
        );
        let by_id = json!({"traktId": 3});
        assert_eq!(
            trakt_ref(&by_id).map(|r| r.key()).as_deref(),
            Some("trakt:3"),
            "id"
        );
        assert_eq!(trakt_ref(&json!({"traktSlug": ""})), None, "empty slug");
        let keys: Vec<String> = trakt_source_refs(&item).iter().map(IdRef::key).collect();
        assert_eq!(keys, vec!["imdb:tt1", "tvdb_show:9"], "imdb then tvdb");
        let movie = json!({"tvdbId": 9, "mediaType": "movie"});
        assert!(trakt_source_refs(&movie).is_empty(), "no tvdb for a film");
    }

    #[test]
    fn anilist_titles() {
        let media = json!({"title": {"english": "  ", "romaji": " Frieren ", "native": "フリーレン"}, "coverImage": {"large": "", "medium": "m.jpg"}});
        assert_eq!(anilist_media_title(&media), "Frieren", "first non-blank");
        assert_eq!(
            cover_image(&media).as_deref(),
            Some("m.jpg"),
            "medium cover"
        );
        assert_eq!(anilist_media_title(&json!({})), "", "none");
    }
}
