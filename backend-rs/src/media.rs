//! `Media` as Node serialises it: the entity's columns plus what its
//! `@AfterLoad` hooks add, namely links into Radarr, Sonarr, Plex, Jellyfin
//! and Tautulli and the download tracker's progress items.

use std::borrow::Cow;

use serde_json::{Map, Value};

use crate::db::{MediaRow, SeasonRow};
use crate::downloads::Downloads;
use crate::settings::public::truthy;
use crate::settings::Settings;

/// `MediaServerType.PLEX`.
const PLEX: i64 = 1;
/// `MediaServerType.EMBY`.
const EMBY: i64 = 3;

/// The entity as `res.json` prints it.
///
/// Keys follow the class declaration: the computed fields first, then the
/// columns, then `seasons`, which is left out when `with_seasons` is false
/// (the `mediaAddedAt` query builder doesn't load the eager relation, so
/// Node never sets it).
#[must_use]
pub fn media_json(
    row: &MediaRow,
    settings: &Settings,
    downloads: &Downloads,
    with_seasons: bool,
) -> Value {
    let links = Links::of(row, settings);
    let mut out = Map::new();
    insert_text(&mut out, "serviceUrl", links.service_url.as_deref());
    insert_text(&mut out, "serviceUrl4k", links.service_url4k.as_deref());
    out.insert(
        String::from("downloadStatus"),
        Value::Array(progress(row, downloads, false)),
    );
    out.insert(
        String::from("downloadStatus4k"),
        Value::Array(progress(row, downloads, true)),
    );
    insert_text(&mut out, "mediaUrl", links.media_url.as_deref());
    insert_text(&mut out, "mediaUrl4k", links.media_url4k.as_deref());
    insert_text(&mut out, "iOSPlexUrl", links.ios_plex_url.as_deref());
    insert_text(&mut out, "iOSPlexUrl4k", links.ios_plex_url4k.as_deref());
    insert_text(&mut out, "tautulliUrl", links.tautulli_url.as_deref());
    insert_text(&mut out, "tautulliUrl4k", links.tautulli_url4k.as_deref());
    out.insert(String::from("id"), Value::from(row.id));
    out.insert(
        String::from("mediaType"),
        Value::from(row.media_type.as_str()),
    );
    out.insert(String::from("tmdbId"), Value::from(row.tmdb_id));
    out.insert(String::from("tvdbId"), nullable_number(row.tvdb_id));
    out.insert(
        String::from("imdbId"),
        nullable_text(row.imdb_id.as_deref()),
    );
    out.insert(String::from("status"), Value::from(row.status));
    out.insert(String::from("status4k"), Value::from(row.status4k));
    out.insert(
        String::from("createdAt"),
        nullable_text(row.created_at.as_deref()),
    );
    out.insert(
        String::from("updatedAt"),
        nullable_text(row.updated_at.as_deref()),
    );
    out.insert(
        String::from("lastSeasonChange"),
        nullable_text(row.last_season_change.as_deref()),
    );
    out.insert(
        String::from("mediaAddedAt"),
        nullable_text(row.media_added_at.as_deref()),
    );
    out.insert(String::from("serviceId"), nullable_number(row.service_id));
    out.insert(
        String::from("serviceId4k"),
        nullable_number(row.service_id4k),
    );
    out.insert(
        String::from("externalServiceId"),
        nullable_number(row.external_service_id),
    );
    out.insert(
        String::from("externalServiceId4k"),
        nullable_number(row.external_service_id4k),
    );
    out.insert(
        String::from("externalServiceSlug"),
        nullable_text(row.external_service_slug.as_deref()),
    );
    out.insert(
        String::from("externalServiceSlug4k"),
        nullable_text(row.external_service_slug4k.as_deref()),
    );
    out.insert(
        String::from("ratingKey"),
        nullable_text(row.rating_key.as_deref()),
    );
    out.insert(
        String::from("ratingKey4k"),
        nullable_text(row.rating_key4k.as_deref()),
    );
    out.insert(
        String::from("jellyfinMediaId"),
        nullable_text(row.jellyfin_media_id.as_deref()),
    );
    out.insert(
        String::from("jellyfinMediaId4k"),
        nullable_text(row.jellyfin_media_id4k.as_deref()),
    );
    if with_seasons {
        out.insert(
            String::from("seasons"),
            Value::Array(row.seasons.iter().map(season_json).collect()),
        );
    }
    Value::Object(out)
}

/// Whether `getDownloadingItem` consults the tracker for this row, so the
/// caller knows if it has to be fetched at all.
#[must_use]
pub fn tracks_downloads(row: &MediaRow) -> bool {
    matches!(row.media_type.as_str(), "movie" | "tv")
        && ((row.service_id.is_some() && row.external_service_id.is_some())
            || (row.service_id4k.is_some() && row.external_service_id4k.is_some()))
}

/// A `Season` row as its entity prints.
#[must_use]
pub fn season_json(season: &SeasonRow) -> Value {
    let mut out = Map::new();
    out.insert(String::from("id"), Value::from(season.id));
    out.insert(
        String::from("seasonNumber"),
        Value::from(season.season_number),
    );
    out.insert(String::from("status"), Value::from(season.status));
    out.insert(String::from("status4k"), Value::from(season.status4k));
    out.insert(
        String::from("createdAt"),
        nullable_text(season.created_at.as_deref()),
    );
    out.insert(
        String::from("updatedAt"),
        nullable_text(season.updated_at.as_deref()),
    );
    Value::Object(out)
}

/// `getDownloadingItem`: the tracker's items for this row's server and
/// external id, or `[]` (the field's initialiser) when either is missing.
fn progress(row: &MediaRow, downloads: &Downloads, four_k: bool) -> Vec<Value> {
    let tv = match row.media_type.as_str() {
        "movie" => false,
        "tv" => true,
        _ => return Vec::new(),
    };
    let (service, external) = if four_k {
        (row.service_id4k, row.external_service_id4k)
    } else {
        (row.service_id, row.external_service_id)
    };
    match (service, external) {
        (Some(service), Some(external)) => downloads.progress(tv, service, external),
        (None, _) | (_, None) => Vec::new(),
    }
}

/// `media.mediaUrl` (or `mediaUrl4k`) as `setPlexUrls` computes it.
#[must_use]
pub fn media_url(row: &MediaRow, settings: &Settings, four_k: bool) -> Option<String> {
    let links = Links::of(row, settings);
    if four_k {
        links.media_url4k
    } else {
        links.media_url
    }
}

/// The links `setPlexUrls` and `setServiceUrl` compute.
#[derive(Debug, Default)]
struct Links {
    service_url: Option<String>,
    service_url4k: Option<String>,
    media_url: Option<String>,
    media_url4k: Option<String>,
    ios_plex_url: Option<String>,
    ios_plex_url4k: Option<String>,
    tautulli_url: Option<String>,
    tautulli_url4k: Option<String>,
}

impl Links {
    fn of(row: &MediaRow, settings: &Settings) -> Self {
        let mut links = Self {
            service_url: service_url(
                settings,
                &row.media_type,
                row.service_id,
                row.external_service_slug.as_deref(),
            ),
            service_url4k: service_url(
                settings,
                &row.media_type,
                row.service_id4k,
                row.external_service_slug4k.as_deref(),
            ),
            ..Self::default()
        };
        links.media_urls(row, settings);
        links
    }

    /// `setPlexUrls`: Plex web, Plex iOS and Tautulli links from the rating
    /// key, or a Jellyfin/Emby web link from the Jellyfin item id for every
    /// other server type (`NOT_CONFIGURED` included).
    fn media_urls(&mut self, row: &MediaRow, settings: &Settings) {
        let server_type = settings.get("/main/mediaServerType");
        if loose_eq(server_type, PLEX) {
            let machine = js_string(settings.get("/plex/machineId"));
            let web_app = settings.get("/plex/webAppUrl");
            let web_app = if truthy(web_app) {
                js_string(web_app)
            } else {
                Cow::Borrowed("https://app.plex.tv/desktop")
            };
            let tautulli = settings.get("/tautulli/externalUrl");
            let plex = |key: Option<&str>| {
                let Some(key) = key.filter(|k| !k.is_empty()) else {
                    return (None, None, None);
                };
                (
                    Some(format!(
                        "{web_app}#!/server/{machine}/details?key=%2Flibrary%2Fmetadata%2F{key}"
                    )),
                    Some(format!(
                        "plex://preplay/?metadataKey=%2Flibrary%2Fmetadata%2F{key}&server={machine}"
                    )),
                    truthy(tautulli)
                        .then(|| format!("{}/info?rating_key={key}", js_string(tautulli))),
                )
            };
            (self.media_url, self.ios_plex_url, self.tautulli_url) =
                plex(row.rating_key.as_deref());
            (self.media_url4k, self.ios_plex_url4k, self.tautulli_url4k) =
                plex(row.rating_key4k.as_deref());
        } else {
            let page = if loose_eq(server_type, EMBY) {
                "item"
            } else {
                "details"
            };
            let server_id = js_string(settings.get("/jellyfin/serverId"));
            let external = settings.get("/jellyfin/externalHostname");
            let plugin_host = crate::runtime::plugin_link_host(settings);
            let host = if truthy(external) {
                js_string(external).into_owned()
            } else if let Some(plugin_host) = plugin_host {
                plugin_host
            } else {
                let scheme = if truthy(settings.get("/jellyfin/useSsl")) {
                    "https"
                } else {
                    "http"
                };
                format!(
                    "{scheme}://{}:{}{}",
                    js_string(settings.get("/jellyfin/ip")),
                    js_string(settings.get("/jellyfin/port")),
                    js_string(settings.get("/jellyfin/urlBase"))
                )
            };
            let jellyfin = |id: Option<&str>| {
                id.filter(|i| !i.is_empty()).map(|id| {
                    format!(
                        "{host}/web/index.html#!/{page}?id={id}&context=home&serverId={server_id}"
                    )
                })
            };
            self.media_url = jellyfin(row.jellyfin_media_id.as_deref());
            self.media_url4k = jellyfin(row.jellyfin_media_id4k.as_deref());
        }
    }
}

/// `setServiceUrl` for one quality: the Radarr (movies) or Sonarr (series)
/// server with this id, through its `externalUrl` when set and otherwise
/// `ServarrBase.buildUrl`. Nothing when the id or slug is null or no server
/// has the id.
fn service_url(
    settings: &Settings,
    media_type: &str,
    service_id: Option<i64>,
    slug: Option<&str>,
) -> Option<String> {
    let (section, segment) = match media_type {
        "movie" => ("/radarr", "movie"),
        "tv" => ("/sonarr", "series"),
        _ => return None,
    };
    let (service_id, slug) = (service_id?, slug?);
    let server = settings
        .get(section)
        .and_then(Value::as_array)?
        .iter()
        .find(|s| s.get("id").and_then(Value::as_i64) == Some(service_id))?;
    let path = format!("/{segment}/{slug}");
    let external = server.get("externalUrl");
    if truthy(external) {
        return Some(format!("{}{path}", js_string(external)));
    }
    Some(crate::servarr::build_url(server, &path))
}

/// JavaScript's `==` against a small integer, for `mediaServerType`.
fn loose_eq(v: Option<&Value>, n: i64) -> bool {
    match v {
        Some(Value::Number(num)) => num.as_i64() == Some(n),
        Some(Value::String(s)) => s.trim().parse::<i64>().ok() == Some(n),
        Some(Value::Bool(b)) => i64::from(*b) == n,
        None | Some(Value::Null | Value::Array(_) | Value::Object(_)) => false,
    }
}

/// A settings value as a JavaScript template literal prints it, including
/// `undefined` for a missing key.
#[must_use]
pub fn js_string(v: Option<&Value>) -> Cow<'_, str> {
    match v {
        None => Cow::Borrowed("undefined"),
        Some(Value::Null) => Cow::Borrowed("null"),
        Some(Value::Bool(b)) => Cow::Borrowed(if *b { "true" } else { "false" }),
        Some(Value::Number(n)) => {
            Cow::Owned(crate::jsval::number_string(crate::jsval::json_number(n)))
        }
        Some(Value::String(s)) => Cow::Borrowed(s),
        Some(Value::Array(items)) => Cow::Owned(
            items
                .iter()
                .map(|item| js_string(Some(item)))
                .collect::<Vec<_>>()
                .join(","),
        ),
        Some(Value::Object(_)) => Cow::Borrowed("[object Object]"),
    }
}

fn insert_text(out: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        out.insert(key.to_owned(), Value::from(value));
    }
}

fn nullable_text(value: Option<&str>) -> Value {
    value.map_or(Value::Null, Value::from)
}

fn nullable_number(value: Option<i64>) -> Value {
    value.map_or(Value::Null, Value::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings(file: Value) -> anyhow::Result<Settings> {
        Settings::from_file_value(file, None)
    }

    fn movie() -> MediaRow {
        MediaRow {
            id: 5,
            media_type: String::from("movie"),
            tmdb_id: 550,
            status: 5,
            status4k: 5,
            service_id: Some(0),
            service_id4k: Some(1),
            external_service_id: Some(10),
            external_service_id4k: Some(13),
            external_service_slug: Some(String::from("fight-club")),
            external_service_slug4k: Some(String::from("fight-club-4k")),
            rating_key: Some(String::from("12346")),
            rating_key4k: Some(String::from("12347")),
            ..MediaRow::default()
        }
    }

    #[test]
    fn plex_links_and_key_order() -> anyhow::Result<()> {
        let s = settings(json!({
            "main": {"mediaServerType": 1},
            "plex": {"machineId": "abc"},
            "tautulli": {"externalUrl": "http://t.example"},
            "radarr": [
                {"id": 0, "hostname": "127.0.0.1", "port": 17878, "useSsl": false, "baseUrl": "/radarr", "externalUrl": ""},
                {"id": 1, "hostname": "r4k", "port": 443, "useSsl": true, "externalUrl": "https://r4k.example"}
            ]
        }))?;
        let json = media_json(&movie(), &s, &Downloads::default(), true);
        let keys: Vec<&str> = json
            .as_object()
            .map(|o| o.keys().map(String::as_str).collect())
            .unwrap_or_default();
        assert_eq!(
            keys.iter().take(12).copied().collect::<Vec<_>>(),
            [
                "serviceUrl",
                "serviceUrl4k",
                "downloadStatus",
                "downloadStatus4k",
                "mediaUrl",
                "mediaUrl4k",
                "iOSPlexUrl",
                "iOSPlexUrl4k",
                "tautulliUrl",
                "tautulliUrl4k",
                "id",
                "mediaType"
            ],
            "computed fields first, in declaration order"
        );
        assert_eq!(keys.last().copied(), Some("seasons"), "seasons last");
        assert_eq!(
            json.get("serviceUrl").and_then(Value::as_str),
            Some("http://127.0.0.1:17878/radarr/movie/fight-club"),
            "buildUrl"
        );
        assert_eq!(
            json.get("serviceUrl4k").and_then(Value::as_str),
            Some("https://r4k.example/movie/fight-club-4k"),
            "externalUrl wins"
        );
        assert_eq!(
            json.get("mediaUrl").and_then(Value::as_str),
            Some("https://app.plex.tv/desktop#!/server/abc/details?key=%2Flibrary%2Fmetadata%2F12346"),
            "plex web"
        );
        assert_eq!(
            json.get("iOSPlexUrl4k").and_then(Value::as_str),
            Some("plex://preplay/?metadataKey=%2Flibrary%2Fmetadata%2F12347&server=abc"),
            "plex ios"
        );
        assert_eq!(
            json.get("tautulliUrl").and_then(Value::as_str),
            Some("http://t.example/info?rating_key=12346"),
            "tautulli"
        );
        assert_eq!(
            json.get("downloadStatus"),
            Some(&json!([])),
            "no tracker items"
        );
        Ok(())
    }

    #[test]
    fn jellyfin_links_and_missing_keys() -> anyhow::Result<()> {
        let s = settings(json!({
            "main": {"mediaServerType": 3},
            "jellyfin": {"serverId": "srv", "ip": "127.0.0.1", "port": 8096, "useSsl": false, "urlBase": "", "externalHostname": ""}
        }))?;
        let row = MediaRow {
            id: 7,
            media_type: String::from("tv"),
            jellyfin_media_id: Some(String::from("jf")),
            service_id: Some(0),
            external_service_slug: Some(String::from("x")),
            ..MediaRow::default()
        };
        let json = media_json(&row, &s, &Downloads::default(), false);
        assert_eq!(
            json.get("mediaUrl").and_then(Value::as_str),
            Some("http://127.0.0.1:8096/web/index.html#!/item?id=jf&context=home&serverId=srv"),
            "emby page name"
        );
        assert!(json.get("mediaUrl4k").is_none(), "no 4k item id");
        assert!(
            json.get("serviceUrl").is_none(),
            "no sonarr server with that id"
        );
        assert!(json.get("seasons").is_none(), "mediaAddedAt sort");
        let plex_without_machine = settings(json!({"main": {"mediaServerType": "1"}}))?;
        let row = MediaRow {
            media_type: String::from("movie"),
            rating_key: Some(String::from("9")),
            ..MediaRow::default()
        };
        let json = media_json(&row, &plex_without_machine, &Downloads::default(), true);
        assert_eq!(
            json.get("mediaUrl").and_then(Value::as_str),
            Some("https://app.plex.tv/desktop#!/server/undefined/details?key=%2Flibrary%2Fmetadata%2F9"),
            "a missing machineId prints as undefined, and \"1\" == 1"
        );
        assert!(json.get("tautulliUrl").is_none(), "no tautulli url");
        Ok(())
    }

    #[test]
    fn tracker_use() {
        assert!(tracks_downloads(&movie()), "ids on both qualities");
        assert!(
            !tracks_downloads(&MediaRow {
                media_type: String::from("movie"),
                service_id: Some(1),
                ..MediaRow::default()
            }),
            "no external id"
        );
    }
}
