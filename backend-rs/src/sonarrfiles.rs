//! What Sonarr reports about a series' files beyond whether they exist.
//!
//! The qualities and release types in each season and when a missing
//! episode was grabbed (both Sonarr 5 only), and the audio and subtitle
//! languages of each file (Sonarr 4 and 5).

use serde_json::{json, Map, Value};

/// How long a grab may go without a download before it counts as stuck.
pub const STALLED_GRAB_MS: i64 = 6 * 60 * 60 * 1000;

/// Release types that say nothing about the files.
const UNKNOWN_RELEASE_TYPE: &str = "unknown";

/// Sonarr 5's summary of a season's files.
///
/// The names of their qualities, in the order of the series' quality
/// profile, and their release types (`singleEpisode`, `seasonPack`,
/// ...). Each is left out where Sonarr doesn't report it (Sonarr 4).
#[must_use]
pub fn season_files(season: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(stats) = season.get("statistics") else {
        return out;
    };
    if let Some(list) = stats.get("episodeFileQualities").and_then(Value::as_array) {
        let mut names: Vec<Value> = Vec::new();
        for name in list
            .iter()
            .filter_map(|q| q.get("name").and_then(Value::as_str))
            .filter(|n| !n.is_empty())
        {
            if !names.iter().any(|n| n.as_str() == Some(name)) {
                names.push(Value::from(name));
            }
        }
        out.insert(String::from("fileQualities"), Value::Array(names));
    }
    if let Some(list) = stats.get("releaseTypes").and_then(Value::as_array) {
        let mut types: Vec<Value> = Vec::new();
        for kind in list
            .iter()
            .filter_map(Value::as_str)
            .filter(|t| !t.is_empty() && *t != UNKNOWN_RELEASE_TYPE)
        {
            if !types.iter().any(|t| t.as_str() == Some(kind)) {
                types.push(Value::from(kind));
            }
        }
        out.insert(String::from("releaseTypes"), Value::Array(types));
    }
    out
}

/// Lowercased language codes, blanks dropped, each once, in order.
fn codes<'a>(found: impl Iterator<Item = &'a str>) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for code in found
        .map(|c| c.trim().to_lowercase())
        .filter(|c| !c.is_empty())
    {
        if !out.iter().any(|c| c.as_str() == Some(code.as_str())) {
            out.push(Value::from(code));
        }
    }
    out
}

/// One side of a file's tracks: v5's streams (`audioStreams`,
/// `subtitleStreams`, each with a `language`), else v4's `/`-separated
/// text (`audioLanguages`, `subtitles`). `None` when the media info has
/// neither.
fn languages(media_info: &Value, streams: &str, text: &str) -> Option<Vec<Value>> {
    if let Some(list) = media_info.get(streams).and_then(Value::as_array) {
        return Some(codes(
            list.iter()
                .filter_map(|s| s.get("language").and_then(Value::as_str)),
        ));
    }
    media_info
        .get(text)
        .and_then(Value::as_str)
        .map(|joined| codes(joined.split('/')))
}

/// The audio and subtitle languages of an episode file.
///
/// They are the ISO 639-2 codes Sonarr reads from the file (`jpn`,
/// `eng`, `und` for a track that names none): `{ audioLanguages,
/// subtitleLanguages }`. Only embedded tracks: Sonarr doesn't list
/// subtitle files next to the video. `None` without media info, which
/// Sonarr has yet to read.
#[must_use]
pub fn file_tracks(file: &Value) -> Option<Value> {
    let media_info = file.get("mediaInfo").filter(|m| m.is_object())?;
    let audio = languages(media_info, "audioStreams", "audioLanguages");
    let subtitles = languages(media_info, "subtitleStreams", "subtitles");
    if audio.is_none() && subtitles.is_none() {
        return None;
    }
    Some(json!({
        "audioLanguages": audio.unwrap_or_default(),
        "subtitleLanguages": subtitles.unwrap_or_default(),
    }))
}

/// When Sonarr 5 grabbed a wanted episode that never arrived.
///
/// The episode is missing and has been waiting for its download longer
/// than [`STALLED_GRAB_MS`] with nothing in Sonarr's queue (`queued`):
/// the grab went missing, the download client dropped it, or it failed
/// without Sonarr noticing. `None` otherwise, and always on Sonarr 4,
/// which has no grab date.
#[must_use]
pub fn stalled_grab(episode: &Value, queued: bool, now_ms: i64) -> Option<i64> {
    if queued
        || episode.get("hasFile").and_then(Value::as_bool) != Some(false)
        || episode.get("monitored").and_then(Value::as_bool) != Some(true)
    {
        return None;
    }
    let grabbed = episode
        .get("grabDate")
        .and_then(Value::as_str)
        .and_then(crate::clock::parse_date_millis)?;
    (now_ms - grabbed > STALLED_GRAB_MS).then_some(grabbed)
}

/// The episode ids Sonarr's queue (`GET /queue/details`) downloads: every
/// one of a Sonarr 5 entry, the one of a Sonarr 4 entry.
#[must_use]
pub fn queued_episode_ids(items: &[Value]) -> Vec<i64> {
    let mut ids: Vec<i64> = Vec::new();
    for item in items {
        let listed = item
            .get("episodeIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_i64);
        let single = item.get("episodeId").and_then(Value::as_i64);
        let nested = crate::sonarrv5::queue_item_episodes(item)
            .into_iter()
            .filter_map(|e| e.get("id").and_then(Value::as_i64));
        for id in listed.chain(single).chain(nested) {
            if id > 0 && !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    ids
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn season_files_from_sonarr5_statistics() {
        let season = json!({"statistics": {
            "episodeFileQualities": [
                {"id": 3, "name": "WEBDL-1080p", "resolution": 1080},
                {"id": 18, "name": "WEBDL-2160p", "resolution": 2160},
                {"id": 3, "name": "WEBDL-1080p", "resolution": 1080},
                {"id": 0, "name": ""}
            ],
            "releaseTypes": ["seasonPack", "unknown", "singleEpisode", "seasonPack"]
        }});
        assert_eq!(
            Value::Object(season_files(&season)),
            json!({
                "fileQualities": ["WEBDL-1080p", "WEBDL-2160p"],
                "releaseTypes": ["seasonPack", "singleEpisode"]
            })
        );
        assert!(
            season_files(&json!({"statistics": {"episodeFileCount": 3}})).is_empty(),
            "Sonarr 4 reports neither"
        );
        assert!(season_files(&json!({})).is_empty());
    }

    #[test]
    fn tracks_from_sonarr5_streams() {
        let file = json!({"mediaInfo": {
            "audioStreams": [{"language": "jpn"}, {"language": "ENG"}, {"language": "jpn"}, {"language": ""}],
            "subtitleStreams": [{"language": "eng", "forced": false}, {"language": "und"}, {}]
        }});
        assert_eq!(
            file_tracks(&file),
            Some(json!({"audioLanguages": ["jpn", "eng"], "subtitleLanguages": ["eng", "und"]}))
        );
    }

    #[test]
    fn tracks_from_sonarr4_text() {
        let file =
            json!({"mediaInfo": {"audioLanguages": "jpn/eng", "subtitles": "eng / spa/ /und"}});
        assert_eq!(
            file_tracks(&file),
            Some(
                json!({"audioLanguages": ["jpn", "eng"], "subtitleLanguages": ["eng", "spa", "und"]})
            )
        );
        assert_eq!(
            file_tracks(&json!({"mediaInfo": {"audioLanguages": "", "subtitles": ""}})),
            Some(json!({"audioLanguages": [], "subtitleLanguages": []})),
            "read, with no languages"
        );
        assert_eq!(
            file_tracks(&json!({"mediaInfo": {"videoCodec": "x265"}})),
            None
        );
        assert_eq!(file_tracks(&json!({"mediaInfo": null})), None);
        assert_eq!(file_tracks(&json!({})), None);
    }

    #[test]
    fn stalled_grabs() {
        let now = crate::clock::parse_date_millis("2026-11-05T12:00:00Z").unwrap_or_default();
        let episode = |grab: Option<&str>, has_file: bool, monitored: bool| json!({"hasFile": has_file, "monitored": monitored, "grabDate": grab});
        let old = Some("2026-11-05T05:00:00Z");
        assert_eq!(
            stalled_grab(&episode(old, false, true), false, now),
            crate::clock::parse_date_millis("2026-11-05T05:00:00Z")
        );
        assert_eq!(
            stalled_grab(
                &episode(Some("2026-11-05T07:00:00Z"), false, true),
                false,
                now
            ),
            None,
            "five hours is still downloading"
        );
        assert_eq!(
            stalled_grab(&episode(old, false, true), true, now),
            None,
            "queued"
        );
        assert_eq!(
            stalled_grab(&episode(old, true, true), false, now),
            None,
            "downloaded"
        );
        assert_eq!(
            stalled_grab(&episode(old, false, false), false, now),
            None,
            "not wanted"
        );
        assert_eq!(
            stalled_grab(&episode(None, false, true), false, now),
            None,
            "Sonarr 4"
        );
    }

    #[test]
    fn queued_episodes_on_both_apis() {
        let items = [
            json!({"episodeIds": [4, 5], "episodes": [{"id": 4}, {"id": 5}], "episodeId": 4}),
            json!({"episodeId": 7, "episode": {"id": 7}}),
            json!({"episodeId": 0}),
        ];
        assert_eq!(queued_episode_ids(&items), vec![4, 5, 7]);
    }
}
