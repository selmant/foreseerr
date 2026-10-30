//! Node's mapping-layer `/internal` routes (`server/routes/internal.ts`),
//! answered in this process.

use std::sync::Arc;

use axum::http::Method;
use serde_json::{Map, Value};

use super::{animelist, discover, resolutions, simklresolve, watched, Ctx};
use crate::jobs::scanbase::AnidbItem;
use crate::settings::public::truthy;
use crate::standalone::internal::Answer;
use crate::state::AppState;

fn failed(e: &anyhow::Error) -> Answer {
    Answer::message(500, &format!("{e:#}"))
}

fn json_items(result: anyhow::Result<Vec<Value>>) -> Answer {
    match result {
        Ok(items) => Answer::json(200, Value::Array(items)),
        Err(e) => failed(&e),
    }
}

fn array(body: Option<&Value>, key: &str) -> Vec<Value> {
    body.and_then(|b| b.get(key))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// `{ item: AnidbItem | null }`, keys in the order Node builds them.
fn anidb_json(item: Option<AnidbItem>, special: bool) -> Value {
    let Some(item) = item else {
        let mut out = Map::new();
        out.insert(String::from("item"), Value::Null);
        return Value::Object(out);
    };
    let mut map = Map::new();
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            map.insert(key.to_owned(), value);
        }
    };
    if special {
        put("imdbId", item.imdb_id.map(Value::from));
        put("tmdbId", item.tmdb_id.map(Value::from));
    } else {
        put("tvdbId", item.tvdb_id.map(Value::from));
        put("tvdbSeason", item.tvdb_season.map(Value::from));
        put("tmdbId", item.tmdb_id.map(Value::from));
        put("imdbId", item.imdb_id.map(Value::from));
    }
    let mut out = Map::new();
    out.insert(String::from("item"), Value::Object(map));
    Value::Object(out)
}

/// `Number(param)` as an integer.
fn int_param(text: &str) -> Option<i64> {
    super::int_of(crate::jsval::number_of_str(text))
}

/// The dataset routes, which need the shared state for their background
/// refresh.
async fn datasets(
    state: &AppState,
    method: &Method,
    rest: &[&str],
    body: Option<&Value>,
) -> Option<Answer> {
    if *method != Method::POST {
        return None;
    }
    let shared =
        || super::shared().ok_or_else(|| Answer::message(500, "The mapping layer is not running."));
    match rest {
        ["changed"] => Some(
            match crate::mappingdatasets::load_active_generations(&state.db, true).await {
                Ok(()) => {
                    super::edges::clear_edge_cache();
                    super::resolve::invalidate_resolutions();
                    Answer::no_content()
                }
                Err(e) => failed(&e),
            },
        ),
        [key] => {
            let key = crate::jsval::decode_uri_component(key).unwrap_or_default();
            let enabled = body.and_then(|b| b.get("enabled")).and_then(Value::as_bool);
            let (Some(_), Some(enabled)) = (crate::mappingdatasets::definition(&key), enabled)
            else {
                return Some(Answer::message(400, "Unknown dataset or bad body."));
            };
            let state = match shared() {
                Ok(state) => state,
                Err(answer) => return Some(answer),
            };
            Some(
                match crate::mappingdatasets::toggle_dataset(&state, &key, enabled).await {
                    Ok(dataset) => {
                        let mut out = Map::new();
                        out.insert(String::from("dataset"), dataset.unwrap_or(Value::Null));
                        Answer::json(200, Value::Object(out))
                    }
                    Err(e) => failed(&e),
                },
            )
        }
        [key, "refresh"] => {
            let key = crate::jsval::decode_uri_component(key).unwrap_or_default();
            if crate::mappingdatasets::definition(&key).is_none() {
                return Some(Answer::message(400, "Unknown dataset."));
            }
            let state: Arc<AppState> = match shared() {
                Ok(state) => state,
                Err(answer) => return Some(answer),
            };
            Some(
                match crate::mappingdatasets::refresh_dataset(&state, &key, true).await {
                    Ok(result) => Answer::json(200, result.to_value()),
                    Err(e) => failed(&e),
                },
            )
        }
        _ => None,
    }
}

/// `/internal{path}` for the mapping layer, as Node answers it.
///
/// `None` for a path Node had no such route for, or when the watched
/// titles can't be loaded.
pub async fn answer(
    state: &AppState,
    method: &Method,
    path: &str,
    body: Option<&Value>,
) -> Option<Answer> {
    let path = path.split('?').next().unwrap_or_default();
    let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    let settings = match state.settings.current().await {
        Ok(settings) => settings,
        Err(e) => return Some(failed(&e)),
    };
    let ctx = Ctx::with_settings(state, &settings);
    let get = *method == Method::GET;
    let post = *method == Method::POST;
    let options = body.and_then(|b| b.get("options")).filter(|o| !o.is_null());
    Some(match segments.as_slice() {
        ["mapping", "flush"] if post => {
            resolutions::flush_misses(ctx.db).await;
            Answer::no_content()
        }
        ["mapping", "status"] if get => {
            resolutions::flush_misses(ctx.db).await;
            let refreshes = crate::mappingpacks::snapshot_pack_progress();
            match crate::mappingdatasets::list_datasets(ctx.db).await {
                Ok(datasets) => {
                    let mut out = Map::new();
                    out.insert(String::from("refreshes"), Value::Array(refreshes));
                    out.insert(String::from("datasets"), Value::Array(datasets));
                    Answer::json(200, Value::Object(out))
                }
                Err(e) => failed(&e),
            }
        }
        ["mapping", "invalidate"] if post => {
            super::resolve::invalidate_resolutions();
            Answer::no_content()
        }
        ["mapping", "datasets", rest @ ..] => return datasets(state, method, rest, body).await,
        ["mapping", "confirm"] if post => {
            json_items(discover::confirm_items(&ctx, &array(body, "items"), options).await)
        }
        ["mapping", "resolve-items"] if post => {
            let items = array(body, "items");
            if !items.is_empty() && options.is_none() {
                return Some(Answer::message(
                    500,
                    "options are required to resolve items",
                ));
            }
            let source = options
                .and_then(|o| o.get("discoverSource"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let offline = truthy(options.and_then(|o| o.get("offline")));
            json_items(discover::resolve_discover_items(&ctx, items, source, offline).await)
        }
        ["mapping", "posters"] if post => Answer::json(
            200,
            Value::Array(discover::with_tmdb_posters(&ctx, array(body, "items")).await),
        ),
        ["mapping", "unmapped"] if post => {
            discover::record_unmapped_items(&ctx, &array(body, "items"), options);
            Answer::no_content()
        }
        ["mapping", "trakt-ids"] if post => {
            let source = options
                .and_then(|o| o.get("discoverSource"))
                .filter(|s| !s.is_null())
                .map_or_else(
                    || String::from("trakt"),
                    |s| crate::jsnum::value_string(Some(s)),
                );
            let hydrated =
                discover::hydrate_trakt_tmdb_ids(&ctx, array(body, "items"), &source).await;
            match hydrated {
                Ok(items) if truthy(options.and_then(|o| o.get("confirm"))) => {
                    json_items(discover::confirm_trakt_tmdb_ids(&ctx, items, &source).await)
                }
                other => json_items(other),
            }
        }
        ["mapping", "anilist-media"] if post => {
            json_items(discover::map_anilist_media_list(&ctx, &array(body, "media")).await)
        }
        ["animelist", "sync"] if post => match animelist::sync(&ctx).await {
            Ok(()) => Answer::no_content(),
            Err(e) => failed(&e),
        },
        ["animelist", "anidb", id] if get => {
            let found = match int_param(id) {
                Some(id) => animelist::from_anidb(&ctx, id).await,
                None => Ok(None),
            };
            match found {
                Ok(item) => Answer::json(200, anidb_json(item, false)),
                Err(e) => failed(&e),
            }
        }
        ["animelist", "special", tvdb, episode] if get => {
            let found = match (int_param(tvdb), int_param(episode)) {
                (Some(tvdb), Some(episode)) => {
                    animelist::special_episode(&ctx, tvdb, episode).await
                }
                _ => Ok(None),
            };
            match found {
                Ok(item) => Answer::json(200, anidb_json(item, true)),
                Err(e) => failed(&e),
            }
        }
        ["discover", "watched", user] if get => {
            let user = int_param(user).unwrap_or(0);
            match watched::load_combined(state, &settings, user).await {
                Ok(sets) => Answer::json(200, sets.to_json()),
                Err(_) => return None,
            }
        }
        ["simkl", "resolve"] if post => {
            let candidates = array(body, "candidates");
            let source = crate::jsnum::value_string(body.and_then(|b| b.get("discoverSource")));
            let hide = truthy(body.and_then(|b| b.get("hideUnmapped")));
            let items = simklresolve::resolve(&ctx, candidates, &source, hide).await;
            let items = crate::routes::discoverkit::annotate_with(state, &settings, items).await;
            Answer::json(200, Value::Array(items))
        }
        _ => return None,
    })
}
