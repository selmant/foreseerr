//! The `JellyfinAPI` calls the media actions make: marking items played
//! or unplayed, and the item, season and episode reads they need, with
//! Jellyfin's answers read as loosely as Node reads them.
//!
//! Every failure is Node's `ApiError`, whose message is empty.

use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{Map, Value};

use super::{axios_url, JellyfinClient, BROWSE_ITEM_FIELDS, LIBRARY_TIMEOUT};

/// A failed call (Node's `ApiError`, message `''`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Failed;

/// `this.get(path, { params })`: the parsed body, or the status of a
/// failed call (`None` without a response).
async fn get(
    client: &JellyfinClient,
    path: &str,
    params: &[(&str, String)],
) -> Result<Value, Option<u16>> {
    let url = axios_url(&client.base, path, params);
    let res = client
        .http
        .get(&url)
        .header(AUTHORIZATION, client.auth.clone())
        .header(CONTENT_TYPE, "application/json")
        .header(ACCEPT, "application/json")
        .timeout(LIBRARY_TIMEOUT)
        .send()
        .await
        .map_err(|_| None)?;
    if !res.status().is_success() {
        return Err(Some(res.status().as_u16()));
    }
    let text = res.text().await.map_err(|_| None)?;
    Ok(serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text)))
}

/// `response.Items` as a list (`?? []` when `missing_ok`; a missing list
/// otherwise throws there, which ends as an `ApiError` too).
fn items(body: &Value, missing_ok: bool) -> Result<Vec<Value>, Failed> {
    match body.get("Items") {
        Some(Value::Array(items)) => Ok(items.clone()),
        None | Some(Value::Null) if missing_ok => Ok(Vec::new()),
        _ => Err(Failed),
    }
}

/// `getItemsData(ids)`: the user's view of each item (`Items ?? []`).
///
/// # Errors
///
/// [`Failed`] when the call fails.
pub async fn items_data(client: &JellyfinClient, ids: &[String]) -> Result<Vec<Value>, Failed> {
    let mut unique: Vec<&str> = Vec::new();
    for id in ids {
        if !id.is_empty() && !unique.contains(&id.as_str()) {
            unique.push(id);
        }
    }
    if unique.is_empty() {
        return Ok(Vec::new());
    }
    let body = get(
        client,
        "/Items",
        &[
            ("ids", unique.join(",")),
            ("userId", client.user_id.clone()),
            ("EnableUserData", String::from("true")),
            (
                "fields",
                format!("{BROWSE_ITEM_FIELDS},MediaSources,Width,Height,IsHD"),
            ),
        ],
    )
    .await;
    match body {
        Ok(body) => items(&body, true),
        Err(Some(500)) if crate::jobs::availability_sync::running() => Ok(Vec::new()),
        Err(_) => Err(Failed),
    }
}

/// `getItemData(id)`: the first item.
///
/// # Errors
///
/// [`Failed`] when the call fails.
pub async fn item_data(client: &JellyfinClient, id: &str) -> Result<Option<Value>, Failed> {
    Ok(items_data(client, &[id.to_owned()])
        .await?
        .into_iter()
        .next())
}

/// `getSeasons(seriesId)`: `Items` as Jellyfin sent it (`None` when it
/// left it out, where Node's `find` then throws).
///
/// # Errors
///
/// [`Failed`] when the call fails.
pub async fn seasons(client: &JellyfinClient, series_id: &str) -> Result<Vec<Value>, Failed> {
    let body = get(
        client,
        &format!("/Shows/{series_id}/Seasons"),
        &[
            ("userId", client.user_id.clone()),
            ("EnableUserData", String::from("true")),
            ("Fields", String::from("ProviderIds,Overview")),
        ],
    )
    .await
    .map_err(|_| Failed)?;
    items(&body, false)
}

/// `getEpisodes(seriesId, seasonId, { includeMediaInfo: true })`: the
/// episodes that aren't virtual.
///
/// # Errors
///
/// [`Failed`] when the call fails or `Items` is missing.
pub async fn episodes(
    client: &JellyfinClient,
    series_id: &str,
    season_id: &str,
) -> Result<Vec<Value>, Failed> {
    let body = get(
        client,
        &format!("/Shows/{series_id}/Episodes"),
        &[
            ("seasonId", season_id.to_owned()),
            ("userId", client.user_id.clone()),
            ("EnableUserData", String::from("true")),
            ("Fields", String::from("MediaSources,ProviderIds,Overview")),
        ],
    )
    .await
    .map_err(|_| Failed)?;
    Ok(items(&body, false)?
        .into_iter()
        .filter(|item| item.get("LocationType").and_then(Value::as_str) != Some("Virtual"))
        .collect())
}

/// `markPlayed(itemId)` (`true`) or `markUnplayed(itemId)`. The id is a
/// request parameter, so it goes in as one path segment.
///
/// # Errors
///
/// [`Failed`] when Jellyfin refuses or can't be reached.
pub async fn set_played(
    client: &JellyfinClient,
    item_id: &str,
    played: bool,
) -> Result<(), Failed> {
    let url = format!(
        "{}/Users/{}/PlayedItems/{}",
        client.base,
        client.user_id,
        crate::librarymap::encode_uri_component(item_id)
    );
    let req = if played {
        client
            .http
            .post(&url)
            .header(CONTENT_TYPE, "application/json")
            .body(Value::Object(Map::new()).to_string())
    } else {
        client.http.delete(&url)
    };
    let res = req
        .header(AUTHORIZATION, client.auth.clone())
        .header(ACCEPT, "application/json")
        .timeout(LIBRARY_TIMEOUT)
        .send()
        .await
        .map_err(|_| Failed)?;
    if res.status().is_success() {
        Ok(())
    } else {
        Err(Failed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_items_loosely() {
        assert_eq!(
            items(&json!({"Items": [1]}), false),
            Ok(vec![json!(1)]),
            "list"
        );
        assert_eq!(items(&json!({}), true), Ok(Vec::new()), "missing is empty");
        assert_eq!(items(&json!({}), false), Err(Failed), "missing throws");
    }
}
