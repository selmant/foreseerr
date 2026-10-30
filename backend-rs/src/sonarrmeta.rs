//! Sonarr reads beyond adding a series: the series lookup by other ids
//! (`tmdb:`, `anilist:`, `mal:`, on Sonarr 4 and 5 alike), and, through
//! API v5 only, the metadata language.

use anyhow::Result;
use reqwest::Method;
use serde_json::{Map, Value};

use crate::arr::Arr;
use crate::settings::public::truthy;
use crate::sonarrv5::ApiVersion;

async fn read(arr: &Arr<'_>, path: &str, query: &[(&str, String)]) -> Result<Value> {
    arr.client
        .call(arr.server, Method::GET, path, query, None, arr.timeout)
        .await
}

/// Whether the server is talked to through API v5.
pub async fn is_v5(arr: &Arr<'_>) -> bool {
    arr.client.api(arr.server, arr.timeout).await == ApiVersion::V5
}

/// `GET /series/lookup?term={term}`: Sonarr's search, which takes `tvdb:`,
/// `tmdb:`, `imdb:`, `anilist:` and `mal:` ids as well as titles.
///
/// # Errors
///
/// Fails when the call fails.
pub async fn lookup_series(arr: &Arr<'_>, term: &str) -> Result<Vec<Value>> {
    Ok(
        match read(arr, "/series/lookup", &[("term", term.to_owned())]).await? {
            Value::Array(found) => found,
            Value::Null
            | Value::Bool(_)
            | Value::Number(_)
            | Value::String(_)
            | Value::Object(_) => Vec::new(),
        },
    )
}

/// The `tmdb:` lookup, keeping only series whose `tmdbId` is that id:
/// Sonarr resolves it through TVDB's own TMDB links.
///
/// # Errors
///
/// Fails when the call fails.
pub async fn series_by_tmdb(arr: &Arr<'_>, tmdb_id: i64) -> Result<Vec<Value>> {
    let found = lookup_series(arr, &format!("tmdb:{tmdb_id}")).await?;
    Ok(with_tmdb_id(found, tmdb_id))
}

/// v5's `preferredMetadataLanguage`; none on an older Sonarr.
///
/// # Errors
///
/// Fails when the call fails.
pub async fn preferred_metadata_language(arr: &Arr<'_>) -> Result<Option<i64>> {
    if !is_v5(arr).await {
        return Ok(None);
    }
    let settings = read(arr, "/settings/metadata", &[]).await?;
    Ok(settings
        .get("preferredMetadataLanguage")
        .and_then(Value::as_i64)
        .filter(|id| *id > 0))
}

/// The `language` a new series is added with on Sonarr 5: the one chosen
/// (the request's or the server's language slot), else the server's
/// preferred metadata language, else the lookup's.
pub async fn add_language(arr: &Arr<'_>, chosen: &Value, lookup: &Value) -> Option<Value> {
    if let Some(id) = chosen.as_i64().filter(|id| *id > 0) {
        return Some(language_ref(id));
    }
    match preferred_metadata_language(arr).await {
        Ok(Some(id)) => return Some(language_ref(id)),
        Ok(None) => {}
        Err(e) => tracing::warn!(
            label = "Sonarr API",
            "Could not read Sonarr's metadata language, using the lookup's: {e:#}"
        ),
    }
    lookup.get("language").filter(|l| !l.is_null()).cloned()
}

/// The metadata languages a v5 server offers, as its own picker lists
/// them; none on an older Sonarr.
///
/// # Errors
///
/// Fails when the call fails.
pub async fn metadata_languages(arr: &Arr<'_>) -> Result<Option<MetadataLanguages>> {
    if !is_v5(arr).await {
        return Ok(None);
    }
    let languages = arr
        .client
        .get_rolling(arr.server, "/language", arr.timeout)
        .await?;
    let preferred = arr
        .client
        .get_rolling(arr.server, "/settings/metadata", arr.timeout)
        .await?;
    Ok(Some(MetadataLanguages {
        languages: language_list(&languages),
        preferred: preferred
            .get("preferredMetadataLanguage")
            .and_then(Value::as_i64)
            .filter(|id| *id > 0),
    }))
}

/// What the Sonarr settings show for the metadata language.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetadataLanguages {
    /// `{ id, name }` per language, by name.
    pub languages: Vec<Value>,
    /// The server's `preferredMetadataLanguage`.
    pub preferred: Option<i64>,
}

impl MetadataLanguages {
    /// `metadataLanguages` and `defaultMetadataLanguageId` of a settings
    /// answer; both null for a server without them.
    pub fn insert_into(this: Option<&Self>, out: &mut Map<String, Value>) {
        out.insert(
            String::from("metadataLanguages"),
            this.map_or(Value::Null, |m| Value::Array(m.languages.clone())),
        );
        out.insert(
            String::from("defaultMetadataLanguageId"),
            this.and_then(|m| m.preferred)
                .map_or(Value::Null, Value::from),
        );
    }
}

/// The `language` v5 reads on a series: Sonarr compares languages by id.
fn language_ref(id: i64) -> Value {
    let mut out = Map::new();
    out.insert(String::from("id"), Value::from(id));
    Value::Object(out)
}

/// Lookup results for `tmdb_id` only.
#[must_use]
pub fn with_tmdb_id(found: Vec<Value>, tmdb_id: i64) -> Vec<Value> {
    found
        .into_iter()
        .filter(|s| s.get("tmdbId").and_then(Value::as_i64) == Some(tmdb_id))
        .collect()
}

/// The first TVDB id among lookup results.
#[must_use]
pub fn first_tvdb_id(found: &[Value]) -> Option<i64> {
    found
        .iter()
        .find_map(|s| s.get("tvdbId").and_then(Value::as_i64).filter(|id| *id > 0))
}

/// `GET /language` as a picker: real languages only (Sonarr's own list
/// leaves out Any, Original and Unknown, ids below 1), `{ id, name }`,
/// by name.
#[must_use]
pub fn language_list(languages: &Value) -> Vec<Value> {
    let mut list: Vec<(String, i64)> = languages
        .as_array()
        .map(|all| {
            all.iter()
                .filter_map(|l| {
                    let id = l.get("id").and_then(Value::as_i64).filter(|id| *id > 0)?;
                    let name = l.get("name").and_then(Value::as_str)?;
                    Some((name.to_owned(), id))
                })
                .collect()
        })
        .unwrap_or_default();
    list.sort();
    list.into_iter()
        .map(|(name, id)| {
            let mut out = Map::new();
            out.insert(String::from("id"), Value::from(id));
            out.insert(String::from("name"), Value::from(name));
            Value::Object(out)
        })
        .collect()
}

/// A series' episode order (`seasonType`) and its display name from
/// `seasonTypes`, when Sonarr reports one (Sonarr 5).
#[must_use]
pub fn season_order(series: &Value) -> Option<Value> {
    let kind = series
        .get("seasonType")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())?;
    let name = series
        .get("seasonTypes")
        .and_then(Value::as_array)
        .and_then(|types| {
            types
                .iter()
                .find(|t| t.get("type").and_then(Value::as_str) == Some(kind))
        })
        .and_then(|t| t.get("name"))
        .and_then(Value::as_str);
    let mut out = Map::new();
    out.insert(String::from("type"), Value::from(kind));
    if let Some(name) = name {
        out.insert(String::from("name"), Value::from(name));
    }
    Some(Value::Object(out))
}

/// The Sonarr server lookups go to when nothing picks one: the default
/// non-4K server, else the first non-4K one, else the first.
#[must_use]
pub fn lookup_server(settings: &crate::settings::Settings) -> Option<Value> {
    let servers = settings.get("/sonarr").and_then(Value::as_array)?;
    let hd = |s: &&Value| s.get("is4k").and_then(Value::as_bool) != Some(true);
    servers
        .iter()
        .filter(hd)
        .find(|s| truthy(s.get("isDefault")))
        .or_else(|| servers.iter().find(hd))
        .or_else(|| servers.first())
        .filter(|s| s.is_object())
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tmdb_matches_only() {
        let found = vec![
            json!({"title": "Firefly", "tvdbId": 78874, "tmdbId": 1437}),
            json!({"title": "Firefly Lane", "tvdbId": 1, "tmdbId": 2}),
            json!({"title": "No TMDB", "tvdbId": 3}),
        ];
        let kept = with_tmdb_id(found, 1437);
        assert_eq!(kept.len(), 1, "only the requested show");
        assert_eq!(first_tvdb_id(&kept), Some(78874));
        assert_eq!(first_tvdb_id(&[json!({"tvdbId": 0})]), None, "no id");
    }

    #[test]
    fn languages_as_sonarr_lists_them() {
        let all = json!([
            {"id": -2, "name": "Original"},
            {"id": 0, "name": "Unknown"},
            {"id": 8, "name": "Japanese", "nameLower": "japanese"},
            {"id": 1, "name": "English"},
            {"id": -1, "name": "Any"},
        ]);
        assert_eq!(
            Value::Array(language_list(&all)),
            json!([{"id": 1, "name": "English"}, {"id": 8, "name": "Japanese"}])
        );
        assert!(language_list(&json!("<html>")).is_empty());
    }

    #[test]
    fn season_orders() {
        let series = json!({
            "seasonType": "dvd",
            "seasonTypes": [
                {"name": "Aired Order", "type": "official"},
                {"name": "DVD Order", "type": "dvd"}
            ]
        });
        assert_eq!(
            season_order(&series),
            Some(json!({"type": "dvd", "name": "DVD Order"}))
        );
        assert_eq!(
            season_order(&json!({"seasonType": "official"})),
            Some(json!({"type": "official"}))
        );
        assert_eq!(season_order(&json!({"title": "v4"})), None, "Sonarr 4");
    }

    #[test]
    fn language_slots_in_answers() {
        let mut out = Map::new();
        MetadataLanguages::insert_into(None, &mut out);
        assert_eq!(
            Value::Object(out),
            json!({"metadataLanguages": null, "defaultMetadataLanguageId": null})
        );
        let mut out = Map::new();
        let v5 = MetadataLanguages {
            languages: vec![json!({"id": 1, "name": "English"})],
            preferred: Some(1),
        };
        MetadataLanguages::insert_into(Some(&v5), &mut out);
        assert_eq!(
            Value::Object(out),
            json!({"metadataLanguages": [{"id": 1, "name": "English"}], "defaultMetadataLanguageId": 1})
        );
        assert_eq!(language_ref(8), json!({"id": 8}));
    }
}
