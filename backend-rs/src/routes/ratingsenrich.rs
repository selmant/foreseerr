//! `enrichResultsWithRatings` and `fetchBatchCombinedRatings`
//! (`server/lib/ratings/index.ts`).
//!
//! `MDBList` ratings merged into list
//! results through the shared batch client (`crate::mdblist`), or the
//! per-title sources when no `MDBList` key is set.

use std::collections::HashMap;

use serde_json::{Map, Value};

use super::discoverkit::{needs_mdblist_enrichment, Query};
use super::Ready;
use crate::mdblist::Mdblist;
use crate::ratings::{has_any_rating, map_mdblist, mdblist_ttl, parse_mdblist, Title};
use crate::settings::public::truthy;

/// `ratingResultTmdbId(result)`: `Ok(None)` when the result has no usable
/// id, `Err` for ids JavaScript would compare loosely.
fn result_tmdb_id(result: &Value) -> Result<Option<f64>, String> {
    let read = |v: &Value| v.as_f64().ok_or_else(|| String::from("a non-numeric id"));
    match result.get("tmdbId") {
        Some(Value::Null) | None => match result.get("id") {
            None | Some(Value::Null) => Ok(None),
            Some(id) => Ok(Some(read(id)?).filter(|n| *n > 0.0)),
        },
        Some(id) => Ok(Some(read(id)?).filter(|n| *n > 0.0)),
    }
}

/// The map key `${mediaType}:${tmdbId}`.
fn key(media_type: &str, tmdb_id: f64) -> String {
    format!("{media_type}:{}", crate::jsval::number_string(tmdb_id))
}

/// `enrichResultsWithRatings(results, { query, skipExisting })`.
///
/// `Err` means Node has to answer: an id shape compared loosely, or a
/// per-title source that failed (Node's promise rejects too).
pub(super) async fn enrich_results_with_ratings(
    ctx: &Ready<'_>,
    results: Vec<Value>,
    query: Option<&Query>,
    skip_existing: bool,
) -> Result<Vec<Value>, String> {
    if !needs_mdblist_enrichment(ctx, query) {
        return Ok(results);
    }
    let mut batch_items = Vec::new();
    for result in &results {
        let media_type = result.get("mediaType").and_then(Value::as_str);
        if !matches!(media_type, Some("movie" | "tv")) {
            continue;
        }
        if skip_existing && result.get("ratings").is_some() {
            continue;
        }
        let Some(tmdb_id) = result_tmdb_id(result)? else {
            continue;
        };
        let release = if media_type == Some("movie") {
            result.get("releaseDate")
        } else {
            result.get("firstAirDate")
        };
        let mut item = Map::new();
        item.insert(String::from("mediaType"), Value::from(media_type));
        item.insert(String::from("tmdbId"), crate::jsval::num(tmdb_id));
        if let Some(title) = result
            .get("title")
            .filter(|t| !t.is_null())
            .or_else(|| result.get("name"))
        {
            item.insert(String::from("title"), title.clone());
        }
        if let Some(release) = release {
            item.insert(String::from("releaseDate"), release.clone());
        }
        if truthy(release) {
            let text = crate::jsval::string_of(release);
            let head = String::from_utf16_lossy(&text.encode_utf16().take(4).collect::<Vec<u16>>());
            let year = crate::jsval::number_of_str(&head);
            if year.is_nan() {
                return Err(String::from("a release date whose year is NaN"));
            }
            item.insert(String::from("year"), crate::jsval::num(year));
        }
        batch_items.push(Value::Object(item));
    }
    if batch_items.is_empty() || ctx.settings.str("/mdblist/apiKey").trim().is_empty() {
        return Ok(results);
    }
    let batch = fetch_batch_combined_ratings(ctx, batch_items).await?;
    let mut by_key: HashMap<String, Value> = HashMap::new();
    for item in batch {
        let (Some(kind), Some(id)) = (
            item.get("mediaType").and_then(Value::as_str),
            item.get("tmdbId").and_then(Value::as_f64),
        ) else {
            continue;
        };
        by_key.insert(
            key(kind, id),
            item.get("ratings").cloned().unwrap_or(Value::Null),
        );
    }
    let mut out = Vec::with_capacity(results.len());
    for result in results {
        let media_type = result
            .get("mediaType")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let tmdb_id = result_tmdb_id(&result)?;
        match (media_type.as_deref(), tmdb_id, result) {
            (Some(kind @ ("movie" | "tv")), Some(id), Value::Object(mut map)) => {
                let ratings = by_key.get(&key(kind, id)).cloned().unwrap_or(Value::Null);
                map.insert(String::from("ratings"), ratings);
                out.push(Value::Object(map));
            }
            (_, _, other) => out.push(other),
        }
    }
    Ok(out)
}

/// `fetchBatchCombinedRatings(items)`: each `{mediaType, tmdbId, title,
/// year, releaseDate}` item with its `ratings` (or `null`).
///
/// `Err` where Node would reject (a per-title source failing) or where an
/// item has a shape only Node handles.
pub(super) async fn fetch_batch_combined_ratings(
    ctx: &Ready<'_>,
    items: Vec<Value>,
) -> Result<Vec<Value>, String> {
    if ctx.settings.str("/mdblist/apiKey").trim().is_empty() {
        return legacy_batch(ctx, items).await;
    }
    let mdblist = Mdblist::new(&ctx.state.outbound, &ctx.settings);
    let mut parsed: HashMap<&str, HashMap<i64, Option<Value>>> = HashMap::new();
    for kind in ["movie", "tv"] {
        let mut group = Vec::new();
        for item in items
            .iter()
            .filter(|i| i.get("mediaType").and_then(Value::as_str) == Some(kind))
        {
            let id = item
                .get("tmdbId")
                .and_then(Value::as_i64)
                .ok_or_else(|| String::from("a batch item without an integer TMDB id"))?;
            let release = item.get("releaseDate").and_then(Value::as_str);
            group.push((id, mdblist_ttl(release).as_secs()));
        }
        if !group.is_empty() {
            parsed.insert(kind, mdblist.batch_ratings(kind, &group).await);
        }
    }
    Ok(items
        .into_iter()
        .map(|item| {
            let kind = item.get("mediaType").and_then(Value::as_str).unwrap_or("");
            let payload = parsed
                .get(kind)
                .and_then(|m| {
                    item.get("tmdbId")
                        .and_then(Value::as_i64)
                        .and_then(|id| m.get(&id))
                })
                .cloned()
                .flatten();
            let ratings = payload.map_or(Value::Null, |payload| {
                let title = item.get("title").filter(|t| truthy(Some(t))).map_or_else(
                    || String::from(if kind == "movie" { "Movie" } else { "Series" }),
                    |t| crate::jsval::string_of(Some(t)),
                );
                let mut mapped = map_mdblist(&parse_mdblist(&payload), &title, None);
                let year = item
                    .get("year")
                    .filter(|y| !y.is_null())
                    .cloned()
                    .unwrap_or_else(|| Value::from(0));
                if let Some(Value::Object(rt)) = mapped.get_mut("rt") {
                    rt.insert(String::from("year"), year);
                }
                if has_any_rating(&mapped) {
                    mapped
                } else {
                    Value::Null
                }
            });
            let mut out = match item {
                Value::Object(map) => map,
                Value::Null
                | Value::Bool(_)
                | Value::Number(_)
                | Value::String(_)
                | Value::Array(_) => Map::new(),
            };
            out.insert(String::from("ratings"), ratings);
            Value::Object(out)
        })
        .collect())
}

/// The branch without `MDBList`: `fetchCombinedRatings` per item, two at a
/// time.
async fn legacy_batch(ctx: &Ready<'_>, items: Vec<Value>) -> Result<Vec<Value>, String> {
    let mut out = Vec::with_capacity(items.len());
    for pair in items.chunks(2) {
        let fetched = match pair {
            [a, b] => {
                let (ra, rb) = tokio::join!(legacy_one(ctx, a), legacy_one(ctx, b));
                vec![ra?, rb?]
            }
            [a] => vec![legacy_one(ctx, a).await?],
            _ => Vec::new(),
        };
        out.extend(fetched);
    }
    Ok(out)
}

async fn legacy_one(ctx: &Ready<'_>, item: &Value) -> Result<Value, String> {
    let media_type = item
        .get("mediaType")
        .and_then(Value::as_str)
        .ok_or_else(|| String::from("a batch item without a media type"))?;
    let tmdb_id = item
        .get("tmdbId")
        .and_then(Value::as_i64)
        .ok_or_else(|| String::from("a batch item without an integer TMDB id"))?;
    let year = match item.get("year") {
        None | Some(Value::Null) => None,
        Some(y) => Some(
            y.as_i64()
                .ok_or_else(|| String::from("a batch item with a non-integer year"))?,
        ),
    };
    let title = item.get("title").filter(|t| truthy(Some(t))).map_or_else(
        || {
            String::from(if media_type == "movie" {
                "Movie"
            } else {
                "Series"
            })
        },
        |t| crate::jsval::string_of(Some(t)),
    );
    let release = match item.get("releaseDate") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.as_str()),
        Some(_) => return Err(String::from("a release date that isn't text")),
    };
    let ratings = ctx
        .state
        .ratings
        .combined(
            &ctx.settings,
            &Title {
                media_type,
                tmdb_id,
                title: &title,
                year,
                release_date: release,
                imdb_id: None,
            },
        )
        .await
        .map_err(|e| format!("{e:#}"))?;
    let mut out = Map::new();
    for key in ["mediaType", "tmdbId", "title", "year", "releaseDate"] {
        if let Some(v) = item.get(key) {
            out.insert(String::from(key), v.clone());
        }
    }
    out.insert(String::from("ratings"), ratings.unwrap_or(Value::Null));
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn result_ids() {
        assert_eq!(
            result_tmdb_id(&json!({"tmdbId": 5, "id": 9})),
            Ok(Some(5.0)),
            "tmdbId wins"
        );
        assert_eq!(
            result_tmdb_id(&json!({"tmdbId": 0, "id": 9})),
            Ok(None),
            "zero tmdbId"
        );
        assert_eq!(result_tmdb_id(&json!({"id": 9})), Ok(Some(9.0)), "id");
        assert!(
            result_tmdb_id(&json!({"id": "9"})).is_err(),
            "loose comparison"
        );
        assert_eq!(key("movie", 550.0), "movie:550", "key");
    }
}
