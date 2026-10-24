//! The list writes of `server/api/anilist` the media actions make
//! (`saveMediaListEntry`, `deleteMediaListEntry`) and `getMedia`.

use serde_json::{Map, Value};

use super::{Anilist, AnilistError};

/// `MEDIA_QUERY`, byte for byte.
const MEDIA_QUERY: &str = concat!(
    "\n  query Media($id: Int) {\n    Media(id: $id) { ",
    media_fields!(),
    " }\n  }\n"
);

/// `SAVE_MEDIA_LIST_ENTRY_MUTATION`, byte for byte.
const SAVE_MUTATION: &str = concat!(
    "\n  mutation SaveMediaListEntry(\n    $mediaId: Int\n    $status: MediaListStatus\n    $scoreRaw: Int\n    $progress: Int\n  ) {\n    SaveMediaListEntry(\n      mediaId: $mediaId\n      status: $status\n      scoreRaw: $scoreRaw\n      progress: $progress\n    ) {\n      id\n      status\n      progress\n      score(format: POINT_10)\n      scoreRaw: score(format: POINT_100)\n      media { ",
    media_fields!(),
    " }\n    }\n  }\n"
);

/// `DELETE_MEDIA_LIST_ENTRY_MUTATION`, byte for byte.
const DELETE_MUTATION: &str =
    "\n  mutation DeleteMediaListEntry($id: Int) {\n    DeleteMediaListEntry(id: $id) { deleted }\n  }\n";

/// `saveMediaListEntry`'s options.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Save<'s> {
    /// `mediaId`.
    pub media_id: i64,
    /// `status`, sent when set.
    pub status: Option<&'s str>,
    /// `scoreRaw`, sent when set.
    pub score_raw: Option<f64>,
    /// `progress`, sent when set.
    pub progress: Option<f64>,
}

/// The variables `saveMediaListEntry` sends.
#[must_use]
pub fn save_variables(save: &Save<'_>) -> Map<String, Value> {
    let mut variables = Map::new();
    variables.insert(String::from("mediaId"), Value::from(save.media_id));
    if let Some(status) = save.status.filter(|s| !s.is_empty()) {
        variables.insert(String::from("status"), Value::from(status));
    }
    if let Some(score) = save.score_raw {
        variables.insert(String::from("scoreRaw"), crate::jsval::num(score));
    }
    if let Some(progress) = save.progress {
        variables.insert(String::from("progress"), crate::jsval::num(progress));
    }
    variables
}

/// `saveMediaListEntry(options)`: the saved entry (`None` when `AniList`
/// answers without one).
///
/// # Errors
///
/// Fails as Node's `graphql` does.
pub async fn save_media_list_entry(
    client: &Anilist,
    save: &Save<'_>,
) -> Result<Option<Value>, AnilistError> {
    let data = client
        .graphql(SAVE_MUTATION, save_variables(save), None)
        .await?;
    Ok(data
        .get("SaveMediaListEntry")
        .filter(|e| !e.is_null())
        .cloned())
}

/// `deleteMediaListEntry(entryId)`.
///
/// # Errors
///
/// Fails as Node's `graphql` does.
pub async fn delete_media_list_entry(
    client: &Anilist,
    entry_id: i64,
) -> Result<bool, AnilistError> {
    let mut variables = Map::new();
    variables.insert(String::from("id"), Value::from(entry_id));
    let data = client.graphql(DELETE_MUTATION, variables, None).await?;
    Ok(data
        .get("DeleteMediaListEntry")
        .and_then(|d| d.get("deleted"))
        .is_some_and(|d| crate::settings::public::truthy(Some(d))))
}

/// `getMedia(id)`.
///
/// # Errors
///
/// Fails as Node's `graphql` does.
pub async fn media(client: &Anilist, id: i64) -> Result<Option<Value>, AnilistError> {
    let mut variables = Map::new();
    variables.insert(String::from("id"), Value::from(id));
    let data = client.graphql(MEDIA_QUERY, variables, None).await?;
    Ok(data.get("Media").filter(|m| !m.is_null()).cloned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn variables() {
        let save = Save {
            media_id: 164,
            status: Some("PLANNING"),
            score_raw: Some(80.0),
            progress: None,
        };
        assert_eq!(
            Value::Object(save_variables(&save)),
            json!({"mediaId": 164, "status": "PLANNING", "scoreRaw": 80}),
            "set fields only"
        );
        assert!(
            SAVE_MUTATION.contains("media { \n  id\n"),
            "media fields inline"
        );
    }
}
