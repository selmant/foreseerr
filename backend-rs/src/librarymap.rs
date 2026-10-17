//! The pure parts of the library routes: Jellyfin items to `LibraryTitle`
//! objects (`lib/library.ts`, `lib/libraryBrowse.ts`), series play targets
//! (`lib/libraryPlayTarget.ts`) and the browse parameters.
//!
//! Titles are kept as [`JsObj`]s, which remember keys whose value is
//! `undefined`: spreading such an object and overriding a key keeps the
//! key where it first appeared, and that decides the JSON key order.

use serde_json::{Map, Value};

use crate::db::MediaRow;
use crate::jellyfin::{hostname, js_trim, Item, MAX_SAFE_INTEGER};
use crate::media::{js_string, media_url};
use crate::settings::public::truthy;
use crate::settings::Settings;

/// A JavaScript object literal: keys in insertion order, `None` for a key
/// that is present but `undefined` (left out of the JSON).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JsObj(Vec<(&'static str, Option<Value>)>);

impl JsObj {
    /// `obj[key] = value`, keeping the key's place when it exists.
    pub fn set(&mut self, key: &'static str, value: Option<Value>) {
        if let Some(slot) = self.0.iter_mut().find(|(k, _)| *k == key) {
            slot.1 = value;
        } else {
            self.0.push((key, value));
        }
    }

    /// `obj[key] = value` for a defined value.
    pub fn put(&mut self, key: &'static str, value: Value) {
        self.set(key, Some(value));
    }

    /// `obj[key]`, `None` when missing or `undefined`.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0
            .iter()
            .find(|(k, _)| *k == key)
            .and_then(|(_, v)| v.as_ref())
    }

    /// A string value.
    #[must_use]
    pub fn str(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Value::as_str)
    }

    /// The object as `res.json` prints it.
    #[must_use]
    pub fn to_value(&self) -> Value {
        let mut out = Map::new();
        for (key, value) in &self.0 {
            if let Some(value) = value {
                out.insert((*key).to_owned(), value.clone());
            }
        }
        Value::Object(out)
    }
}

/// A JavaScript number as JSON (non-finite ones print as `null`).
#[must_use]
pub fn num(x: f64) -> Value {
    serde_json::Number::from_f64(x).map_or(Value::Null, Value::Number)
}

/// `Math.round`.
#[must_use]
pub fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

fn percent(x: f64) -> f64 {
    js_round(x).clamp(0.0, 100.0)
}

/// `Number(text)` for a string: `NaN` when JavaScript wouldn't read it.
#[must_use]
pub fn js_number(text: &str) -> f64 {
    let t = js_trim(text);
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = t.strip_prefix(prefix) {
            if digits.is_empty() {
                return f64::NAN;
            }
            let mut value = 0.0_f64;
            for c in digits.chars() {
                let Some(d) = c.to_digit(radix) else {
                    return f64::NAN;
                };
                value = value.mul_add(f64::from(radix), f64::from(d));
            }
            return value;
        }
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let body = t.strip_prefix(['+', '-']).unwrap_or(t);
    let (mantissa, exponent) = body
        .split_once(['e', 'E'])
        .map_or((body, None), |(m, e)| (m, Some(e)));
    let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    let mantissa_ok = digits(int) && digits(frac) && !(int.is_empty() && frac.is_empty());
    let exponent_ok = exponent.is_none_or(|e| {
        let e = e.strip_prefix(['+', '-']).unwrap_or(e);
        !e.is_empty() && digits(e)
    });
    if !(mantissa_ok && exponent_ok) {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// A JavaScript number that is a safe integer, as one.
#[must_use]
pub fn safe_integer(x: f64) -> Option<i64> {
    if !x.is_finite() || x.fract() != 0.0 || x.abs() > 9_007_199_254_740_991.0 {
        return None;
    }
    format!("{x:.0}")
        .parse::<i64>()
        .ok()
        .filter(|n| n.abs() <= MAX_SAFE_INTEGER)
}

/// `encodeURIComponent`.
#[must_use]
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(char::from(byte));
        } else {
            out.push('%');
            for nibble in [byte >> 4, byte & 0x0F] {
                out.push(
                    char::from_digit(u32::from(nibble), 16).map_or('0', |c| c.to_ascii_uppercase()),
                );
            }
        }
    }
    out
}

/// `JELLYFIN_ITEM_ID_PATTERN`: 32 hex digits, either case.
#[must_use]
pub fn is_jellyfin_item_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `libraryItemImageUrl`.
#[must_use]
pub fn library_item_image_url(item_id: &str, image_type: &str) -> String {
    format!("/api/v1/library/items/{item_id}/images/{image_type}")
}

/// `mediaUrlForItem`: a Jellyfin web link for an item, through
/// `getHostname()` in the desktop runtime and `getJellyfinLinkHost()`
/// otherwise.
#[must_use]
pub fn media_url_for_item(settings: &Settings, item_id: &str) -> Option<String> {
    let external = settings.get("/jellyfin/externalHostname");
    if !truthy(settings.get("/jellyfin/ip")) && !truthy(external) {
        return None;
    }
    let host = if crate::runtime::desktop_links_internal() {
        hostname(settings)
    } else if truthy(external) {
        js_string(external).into_owned()
    } else if let Some(plugin_host) = crate::runtime::plugin_link_host(settings) {
        plugin_host
    } else {
        hostname(settings)
    };
    let host = host.strip_suffix('/').unwrap_or(&host);
    let server_id = match settings.get("/jellyfin/serverId") {
        None | Some(Value::Null) => std::borrow::Cow::Borrowed(""),
        other => js_string(other),
    };
    Some(format!(
        "{host}/web/index.html#!/details?id={}&context=home&serverId={}",
        encode_uri_component(item_id),
        encode_uri_component(&server_id)
    ))
}

/// The `Media` columns the library routes read, with the `@AfterLoad`
/// links.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaInfo {
    /// `media.id`.
    pub id: i64,
    /// `media.tmdbId`.
    pub tmdb_id: i64,
    /// `media.mediaType`.
    pub media_type: String,
    /// `media.status`.
    pub status: i64,
    /// `media.jellyfinMediaId`.
    pub jellyfin_media_id: Option<String>,
    /// `media.jellyfinMediaId4k`.
    pub jellyfin_media_id4k: Option<String>,
    /// `media.mediaUrl`.
    pub media_url: Option<String>,
    /// `media.mediaUrl4k`.
    pub media_url4k: Option<String>,
}

/// The select list [`MediaInfo::from_row`] reads, for a `media` alias `m`.
pub const MEDIA_COLUMNS: &str = r#"m."id" AS "id", m."mediaType" AS "mediaType", m."tmdbId" AS "tmdbId", m."status" AS "status", m."ratingKey" AS "ratingKey", m."ratingKey4k" AS "ratingKey4k", m."jellyfinMediaId" AS "jellyfinMediaId", m."jellyfinMediaId4k" AS "jellyfinMediaId4k""#;

impl MediaInfo {
    /// Read a row selected with [`MEDIA_COLUMNS`].
    ///
    /// # Errors
    ///
    /// Fails when a column is missing or of another type.
    pub fn from_row(row: &Map<String, Value>, settings: &Settings) -> Result<Self, String> {
        let int = |key: &str| {
            row.get(key)
                .and_then(Value::as_i64)
                .ok_or_else(|| format!("media.{key} isn't a number"))
        };
        let text = |key: &str| -> Result<Option<String>, String> {
            match row.get(key) {
                Some(Value::String(s)) => Ok(Some(s.clone())),
                Some(Value::Null) => Ok(None),
                _ => Err(format!("media.{key} isn't text")),
            }
        };
        let media = MediaRow {
            id: int("id")?,
            media_type: text("mediaType")?.unwrap_or_default(),
            tmdb_id: int("tmdbId")?,
            status: int("status")?,
            rating_key: text("ratingKey")?,
            rating_key4k: text("ratingKey4k")?,
            jellyfin_media_id: text("jellyfinMediaId")?,
            jellyfin_media_id4k: text("jellyfinMediaId4k")?,
            ..MediaRow::default()
        };
        Ok(Self {
            id: media.id,
            tmdb_id: media.tmdb_id,
            media_type: media.media_type.clone(),
            status: media.status,
            media_url: media_url(&media, settings, false),
            media_url4k: media_url(&media, settings, true),
            jellyfin_media_id: media.jellyfin_media_id,
            jellyfin_media_id4k: media.jellyfin_media_id4k,
        })
    }
}

/// `tmdbIdFromProviders`: `Tmdb ?? TheMovieDb` read with `Number`, kept
/// when finite and positive.
///
/// # Errors
///
/// A fractional or huge id, which JavaScript would carry on with, goes to
/// Node.
pub fn tmdb_from_providers(item: &Item) -> Result<Option<i64>, String> {
    let raw = item
        .provider("Tmdb")
        .or_else(|| item.provider("TheMovieDb"));
    tmdb_from_raw(raw)
}

/// `Number(raw)` kept when finite and positive.
///
/// # Errors
///
/// A fractional or huge id goes to Node.
pub fn tmdb_from_raw(raw: Option<&str>) -> Result<Option<i64>, String> {
    let Some(raw) = raw.filter(|r| !r.is_empty()) else {
        return Ok(None);
    };
    let n = js_number(raw);
    if !(n.is_finite() && n > 0.0) {
        return Ok(None);
    }
    safe_integer(n)
        .map(Some)
        .ok_or_else(|| String::from("a TMDB provider id that isn't a safe integer"))
}

/// `S1E2`, when both numbers are there.
#[must_use]
pub fn sxe(item: &Item) -> Option<String> {
    match (item.int("ParentIndexNumber"), item.int("IndexNumber")) {
        (Some(season), Some(episode)) => Some(format!("S{season}E{episode}")),
        _ => None,
    }
}

/// `formatSxE`.
fn format_sxe(item: &Item) -> String {
    sxe(item).unwrap_or_else(|| {
        item.str("Name")
            .filter(|n| !n.is_empty())
            .unwrap_or("Episode")
            .to_owned()
    })
}

/// `subtitleForItem`.
#[must_use]
pub fn subtitle_for_item(item: &Item) -> Option<String> {
    if !item.is("Episode") {
        return None;
    }
    let series = item.str("SeriesName");
    sxe(item).map_or_else(
        || series.map(str::to_owned),
        |code| {
            Some(
                series
                    .filter(|s| !s.is_empty())
                    .map_or_else(|| code.clone(), |name| format!("{code} · {name}")),
            )
        },
    )
}

/// `titleForItem`.
#[must_use]
pub fn title_for_item(item: &Item) -> Option<String> {
    if item.is("Episode") {
        let name = [item.str("SeriesName"), item.str("Name")]
            .into_iter()
            .flatten()
            .find(|s| !s.is_empty())
            .unwrap_or("Episode");
        return Some(name.to_owned());
    }
    item.str("Name").map(str::to_owned)
}

/// `progressFromItem`.
#[must_use]
pub fn progress_from_item(item: &Item) -> Option<f64> {
    if let Some(pct) = item.user_num("PlayedPercentage") {
        return Some(percent(pct));
    }
    let position = item.user_num("PlaybackPositionTicks");
    let runtime = item
        .user_num("RunTimeTicks")
        .or_else(|| item.num("RunTimeTicks"));
    match (position, runtime) {
        (Some(p), Some(r)) if p != 0.0 && r != 0.0 => {
            let pct = js_round(p / r * 100.0);
            pct.is_finite().then(|| pct.clamp(0.0, 100.0))
        }
        _ => None,
    }
}

/// `runtimeMinutesFromTicks`.
#[must_use]
pub fn runtime_minutes(ticks: Option<f64>) -> Option<f64> {
    let ticks = ticks.filter(|t| *t > 0.0)?;
    Some(js_round(ticks / 10_000_000.0 / 60.0).max(1.0))
}

/// `...libraryTitleDisplayFields(item)` onto `title`.
pub fn display_fields(title: &mut JsObj, item: &Item) {
    let played = item.played();
    let percentage = item.user_num("PlayedPercentage");
    let is_series = item.is("Series");
    let in_progress = !is_series
        && !played
        && (percentage.is_some_and(|p| p > 0.0 && p < 95.0)
            || item.user_num("PlaybackPositionTicks").unwrap_or(0.0) > 0.0);
    let episode_series = if item.is("Episode") {
        item.str("SeriesId").filter(|s| !s.is_empty())
    } else {
        None
    };
    let poster_item = episode_series.unwrap_or_else(|| item.id());
    title.set("year", item.raw("ProductionYear").cloned());
    title.set(
        "genres",
        item.raw("Genres")
            .filter(|g| g.as_array().is_some_and(|a| !a.is_empty()))
            .cloned(),
    );
    title.put("watched", Value::Bool(played));
    title.put("inProgress", Value::Bool(in_progress));
    title.set("addedAt", item.raw("DateCreated").cloned());
    title.set("lastPlayedAt", item.user_raw("LastPlayedDate").cloned());
    title.put(
        "posterUrl",
        Value::from(library_item_image_url(poster_item, "primary")),
    );
    let has_backdrop = item
        .raw("BackdropImageTags")
        .and_then(Value::as_array)
        .is_some_and(|tags| !tags.is_empty());
    title.set(
        "backdropUrl",
        has_backdrop.then(|| Value::from(library_item_image_url(item.id(), "backdrop"))),
    );
    title.set(
        "runtimeMinutes",
        runtime_minutes(
            item.user_num("RunTimeTicks")
                .or_else(|| item.num("RunTimeTicks")),
        )
        .map(num),
    );
    title.put("inspectorItemId", Value::from(poster_item));
    if is_series {
        if let Some(count) = item.user_raw("UnplayedItemCount") {
            title.put("unplayedItemCount", count.clone());
        }
        if let Some(count) = item.raw("RecursiveItemCount") {
            title.put("availableEpisodeCount", count.clone());
        }
    }
}

/// One title of `mapJellyfinItemsToLibraryTitles`, given the item's media
/// row (when one matched).
///
/// # Errors
///
/// A TMDB provider id JavaScript would read as a fraction goes to Node.
pub fn title_from_item(
    item: &Item,
    media: Option<&MediaInfo>,
    settings: &Settings,
) -> Result<JsObj, String> {
    let tmdb_id = match media {
        Some(m) => Some(m.tmdb_id),
        None => tmdb_from_providers(item)?,
    };
    let media_type = match media.map(|m| m.media_type.as_str()) {
        Some("movie") => "movie",
        Some("tv") => "tv",
        _ if item.is("Movie") => "movie",
        _ => "tv",
    };
    let series_id = if item.is("Series") {
        Some(item.id())
    } else if item.is("Episode") {
        item.str("SeriesId")
    } else {
        None
    };
    let play_item = (item.is("Movie") || item.is("Episode")).then(|| item.id());
    let media_url = media
        .and_then(|m| m.media_url.clone())
        .or_else(|| media_url_for_item(settings, item.id()));
    let mut title = JsObj::default();
    title.set("mediaId", media.map(|m| Value::from(m.id)));
    title.set("tmdbId", tmdb_id.map(Value::from));
    title.put("mediaType", Value::from(media_type));
    title.put("jellyfinItemId", Value::from(item.id()));
    title.set("playItemId", play_item.map(Value::from));
    title.set("jellyfinSeriesId", series_id.map(Value::from));
    title.set("title", title_for_item(item).map(Value::from));
    title.set("subtitle", subtitle_for_item(item).map(Value::from));
    title.set("overview", item.raw("Overview").cloned());
    title.set("mediaUrl", media_url.map(Value::from));
    title.set("status", media.map(|m| Value::from(m.status)));
    title.set("progressPercent", progress_from_item(item).map(num));
    title.set(
        "startPositionTicks",
        item.user_raw("PlaybackPositionTicks").cloned(),
    );
    display_fields(&mut title, item);
    Ok(title)
}

/// What Play should start for a series (`SeriesPlayTarget`).
#[derive(Debug, Clone, PartialEq)]
pub struct PlayTarget {
    /// `playItemId`.
    pub play_item_id: String,
    /// `subtitle`.
    pub subtitle: String,
    /// `progressPercent`.
    pub progress: Option<f64>,
    /// `startPositionTicks`.
    pub start: Option<Value>,
}

fn in_progress_episode(episode: &Item) -> bool {
    if !episode.has_user_data() || episode.played() {
        return false;
    }
    if episode
        .user_num("PlayedPercentage")
        .is_some_and(|p| p > 0.0 && p < 95.0)
    {
        return true;
    }
    episode.user_num("PlaybackPositionTicks").unwrap_or(0.0) > 0.0
}

fn watched_episode(episode: &Item) -> bool {
    episode.played() || episode.user_num("PlayedPercentage").unwrap_or(0.0) >= 95.0
}

fn sort_episodes<'a>(episodes: &[&'a Item]) -> Vec<&'a Item> {
    let mut sorted = episodes.to_vec();
    sorted.sort_by_key(|e| {
        (
            e.int("ParentIndexNumber").unwrap_or(MAX_SAFE_INTEGER),
            e.int("IndexNumber").unwrap_or(MAX_SAFE_INTEGER),
        )
    });
    sorted
}

fn up_next(episode: &Item) -> PlayTarget {
    PlayTarget {
        play_item_id: episode.id().to_owned(),
        subtitle: format!("Up next {}", format_sxe(episode)),
        progress: episode.user_num("PlayedPercentage").map(percent),
        start: episode.user_raw("PlaybackPositionTicks").cloned(),
    }
}

/// `resolveSeriesPlayTarget`: in progress, then next unwatched, then the
/// first non-special episode to rewatch.
#[must_use]
pub fn resolve_series_play_target(
    series_id: &str,
    episodes: &[&Item],
    resume: &[&Item],
) -> Option<PlayTarget> {
    let belongs = |e: &&Item| {
        e.str("SeriesId")
            .is_none_or(|s| s.is_empty() || s == series_id)
    };
    let ordered = sort_episodes(&episodes.iter().copied().filter(belongs).collect::<Vec<_>>());
    let first = *ordered.first()?;
    let resumed = sort_episodes(&resume.iter().copied().filter(belongs).collect::<Vec<_>>());
    if let Some(hit) = resumed.into_iter().find(|e| in_progress_episode(e)) {
        return Some(up_next(hit));
    }
    if let Some(hit) = ordered.iter().find(|e| in_progress_episode(e)) {
        return Some(up_next(hit));
    }
    if let Some(hit) = ordered.iter().find(|e| !watched_episode(e)) {
        return Some(up_next(hit));
    }
    let rewatch = ordered
        .iter()
        .find(|e| e.int("ParentIndexNumber").unwrap_or(0) >= 1)
        .copied()
        .unwrap_or(first);
    Some(PlayTarget {
        play_item_id: rewatch.id().to_owned(),
        subtitle: format!("Rewatch {}", format_sxe(rewatch)),
        progress: None,
        start: None,
    })
}

/// The next-up episode as a play target (`progressFromItem` here, not the
/// percentage-only variant).
#[must_use]
pub fn next_up_target(item: &Item) -> PlayTarget {
    PlayTarget {
        play_item_id: item.id().to_owned(),
        subtitle: format!("Up next {}", format_sxe(item)),
        progress: progress_from_item(item),
        start: item.user_raw("PlaybackPositionTicks").cloned(),
    }
}

/// `applyPlayTarget`.
pub fn apply_play_target(title: &mut JsObj, target: Option<PlayTarget>) {
    let Some(target) = target else {
        return;
    };
    let subtitle = title
        .get("subtitle")
        .cloned()
        .or_else(|| Some(Value::from(target.subtitle)));
    let progress = title
        .get("progressPercent")
        .cloned()
        .or_else(|| target.progress.map(num));
    let start = title.get("startPositionTicks").cloned().or(target.start);
    title.put("playItemId", Value::from(target.play_item_id));
    title.set("subtitle", subtitle);
    title.set("progressPercent", progress);
    title.set("startPositionTicks", start);
}

/// An episode started and not nearly finished, as the resume lookups test.
#[must_use]
pub fn resumable(item: &Item) -> bool {
    let pct = item.user_num("PlayedPercentage").unwrap_or(0.0);
    item.user_num("PlaybackPositionTicks").unwrap_or(0.0) > 0.0 || (pct > 0.0 && pct < 95.0)
}

fn by_series(items: &[Item], keep: impl Fn(&Item) -> bool) -> Vec<(&str, &Item)> {
    let mut map: Vec<(&str, &Item)> = Vec::new();
    for item in items {
        let Some(series) = item.str("SeriesId").filter(|s| !s.is_empty()) else {
            continue;
        };
        if item.is("Episode") && !map.iter().any(|(k, _)| *k == series) && keep(item) {
            map.push((series, item));
        }
    }
    map
}

/// `title.mediaType !== 'tv' || title.playItemId`.
#[must_use]
pub fn has_play_target(title: &JsObj) -> bool {
    title.str("mediaType") != Some("tv") || truthy(title.get("playItemId"))
}

/// `title.jellyfinSeriesId ?? title.jellyfinItemId`.
#[must_use]
pub fn series_of(title: &JsObj) -> String {
    title
        .get("jellyfinSeriesId")
        .or_else(|| title.get("jellyfinItemId"))
        .map(|v| js_string(Some(v)).into_owned())
        .unwrap_or_default()
}

/// The first pass of `enrichSeriesPlayTargets`: series rows take a target
/// from the resume or next-up lists when they have one.
#[must_use]
pub fn quick_targets(titles: Vec<JsObj>, resume: &[Item], next_up: &[Item]) -> Vec<JsObj> {
    let resume_map = by_series(resume, resumable);
    let next_map = by_series(next_up, |_| true);
    titles
        .into_iter()
        .map(|mut title| {
            if has_play_target(&title) {
                return title;
            }
            let series = series_of(&title);
            let find = |map: &[(&str, &Item)]| {
                map.iter()
                    .find(|(k, _)| *k == series)
                    .map(|(_, item)| (*item).clone())
            };
            title.put("jellyfinSeriesId", Value::from(series.clone()));
            if let Some(hit) = find(&resume_map) {
                let target = resolve_series_play_target(&series, &[&hit], &[&hit]);
                apply_play_target(&mut title, target);
            } else if let Some(hit) = find(&next_map) {
                apply_play_target(&mut title, Some(next_up_target(&hit)));
            }
            title
        })
        .collect()
}

/// `filterPlayableLibraryTitles`.
#[must_use]
pub fn filter_playable(titles: Vec<JsObj>) -> Vec<JsObj> {
    titles.into_iter().filter(has_play_target).collect()
}

/// `hydrateForgottenLibraryTitles`.
#[must_use]
pub fn hydrate_forgotten(titles: Vec<JsObj>, items: &[Item]) -> Vec<JsObj> {
    titles
        .into_iter()
        .map(|mut title| {
            let id = title.str("jellyfinItemId").unwrap_or("").to_owned();
            match items.iter().rev().find(|item| item.id() == id) {
                None => {
                    for (key, kind) in [("posterUrl", "primary"), ("backdropUrl", "backdrop")] {
                        let value = title
                            .get(key)
                            .cloned()
                            .unwrap_or_else(|| Value::from(library_item_image_url(&id, kind)));
                        title.put(key, value);
                    }
                }
                Some(item) => {
                    let overview = item
                        .raw("Overview")
                        .or_else(|| title.get("overview"))
                        .cloned();
                    title.set("title", title_for_item(item).map(Value::from));
                    title.set("subtitle", subtitle_for_item(item).map(Value::from));
                    title.set("overview", overview);
                    display_fields(&mut title, item);
                }
            }
            title
        })
        .collect()
}

/// `parseLibraryBrowseQuery`'s result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowseQuery {
    /// `q`, trimmed and non-empty.
    pub q: Option<String>,
    /// `mediaType`.
    pub media_type: Option<&'static str>,
    /// `watched`.
    pub watched: Option<&'static str>,
    /// `genre`.
    pub genre: Option<Vec<String>>,
    /// `yearFrom`.
    pub year_from: Option<i64>,
    /// `yearTo`.
    pub year_to: Option<i64>,
    /// `sort`.
    pub sort: &'static str,
    /// `order`.
    pub order: &'static str,
    /// `take`, 1 to 50.
    pub take: i64,
    /// `skip`, not negative.
    pub skip: i64,
}

/// The longest `Years` list built here; a wider range goes to Node.
const MAX_YEARS: i64 = 10_000;

/// `productionYearsFilter`.
///
/// # Errors
///
/// A range wider than [`MAX_YEARS`] goes to Node.
pub fn production_years(
    from: Option<i64>,
    to: Option<i64>,
    current_year: i64,
) -> Result<Option<String>, String> {
    if from.is_none() && to.is_none() {
        return Ok(None);
    }
    let raw_start = from.unwrap_or(1900);
    let raw_end = to.unwrap_or(current_year + 1);
    let (start, end) = (raw_start.min(raw_end), raw_start.max(raw_end));
    if end - start > MAX_YEARS {
        return Err(String::from("a very wide year range"));
    }
    Ok(Some(
        (start..=end)
            .map(|y| y.to_string())
            .collect::<Vec<_>>()
            .join(","),
    ))
}

/// `buildJellyfinBrowseParams`.
///
/// # Errors
///
/// A year range too wide to build here.
pub fn browse_params(
    query: &BrowseQuery,
    user_id: &str,
    current_year: i64,
) -> Result<Vec<(&'static str, String)>, String> {
    let sort_by = match query.sort {
        "title" => "SortName",
        "premiereDate" => "PremiereDate",
        "lastPlayed" => "DatePlayed",
        _ => "DateCreated",
    };
    let mut params = vec![
        ("userId", user_id.to_owned()),
        (
            "IncludeItemTypes",
            String::from(crate::jellyfin::include_types(query.media_type)),
        ),
        ("Recursive", String::from("true")),
        ("EnableUserData", String::from("true")),
        ("SortBy", String::from(sort_by)),
        (
            "SortOrder",
            String::from(if query.order == "asc" {
                "Ascending"
            } else {
                "Descending"
            }),
        ),
        ("StartIndex", query.skip.to_string()),
        ("Limit", query.take.to_string()),
        ("Fields", String::from(crate::jellyfin::BROWSE_ITEM_FIELDS)),
    ];
    if let Some(q) = &query.q {
        params.push(("SearchTerm", q.clone()));
    }
    if let Some(watched) = query.watched {
        let filter = match watched {
            "unwatched" => "IsUnplayed",
            "inProgress" => "IsResumable",
            _ => "IsPlayed",
        };
        params.push(("Filters", String::from(filter)));
    }
    if let Some(genres) = query.genre.as_ref().filter(|g| !g.is_empty()) {
        params.push(("Genres", genres.join(",")));
    }
    if let Some(years) = production_years(query.year_from, query.year_to, current_year)? {
        params.push(("Years", years));
    }
    Ok(params)
}

/// A page's `pageInfo`.
#[must_use]
pub fn page_info(total: f64, take: i64, skip: i64) -> Value {
    let take_f = f64::from(i32::try_from(take).unwrap_or(i32::MAX));
    let skip_f = skip.to_string().parse::<f64>().unwrap_or(0.0);
    let pages = (total / take_f).ceil();
    let pages = if pages == 0.0 || pages.is_nan() {
        1.0
    } else {
        pages
    };
    let mut info = Map::new();
    info.insert(String::from("pages"), num(pages));
    info.insert(String::from("pageSize"), Value::from(take));
    info.insert(String::from("results"), num(total));
    info.insert(String::from("page"), num((skip_f / take_f).floor() + 1.0));
    Value::Object(info)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(v: &Value) -> Result<Item, String> {
        Item::parse(v, false).map_err(|e| format!("{e:?}"))
    }

    fn settings() -> Result<Settings, String> {
        Settings::from_file_value(
            json!({"main": {"mediaServerType": 2}, "jellyfin": {"ip": "jf", "port": 8096, "useSsl": false, "urlBase": "", "serverId": "srv id", "externalHostname": ""}}),
            None,
        )
        .map_err(|e| e.to_string())
    }

    #[test]
    fn numbers_like_javascript() {
        assert!((js_number(" 42 ") - 42.0).abs() < f64::EPSILON, "trimmed");
        assert!(js_number("0x1A") > 25.0, "hex");
        assert!(js_number("12abc").is_nan(), "garbage");
        assert!(js_number("1e3") > 999.0, "exponent");
        assert!(js_number("").abs() < f64::EPSILON, "empty");
        assert!(js_number(".").is_nan(), "lone dot");
        assert!((js_round(2.5) - 3.0).abs() < f64::EPSILON, "half up");
        assert!((js_round(-2.5) + 2.0).abs() < f64::EPSILON, "negative half");
        assert!(
            js_round(0.499_999_999_999_999_94).abs() < f64::EPSILON,
            "just below half"
        );
    }

    #[test]
    fn tmdb_ids() {
        assert_eq!(tmdb_from_raw(Some("550")), Ok(Some(550)), "digits");
        assert_eq!(tmdb_from_raw(Some("tt0137523")), Ok(None), "NaN");
        assert_eq!(tmdb_from_raw(Some("")), Ok(None), "empty");
        assert_eq!(tmdb_from_raw(Some("-3")), Ok(None), "negative");
        assert!(tmdb_from_raw(Some("1.5")).is_err(), "fraction to Node");
    }

    #[test]
    fn item_ids_and_urls() -> Result<(), String> {
        assert!(
            is_jellyfin_item_id("0123456789abcdefABCDEF0123456789"),
            "hex"
        );
        assert!(!is_jellyfin_item_id("0123456789abcdef"), "short");
        assert!(
            !is_jellyfin_item_id("0123456789abcdefABCDEF012345678g"),
            "not hex"
        );
        assert_eq!(encode_uri_component("a b/c'(x)"), "a%20b%2Fc'(x)", "encode");
        assert_eq!(
            media_url_for_item(&settings()?, "abc").as_deref(),
            Some("http://jf:8096/web/index.html#!/details?id=abc&context=home&serverId=srv%20id"),
            "playback url"
        );
        Ok(())
    }

    #[test]
    fn maps_an_episode() -> Result<(), String> {
        let episode = item(&json!({
            "Id": "ep", "Type": "Episode", "SeriesId": "ser", "SeriesName": "Show", "Name": "Pilot",
            "ParentIndexNumber": 1, "IndexNumber": 2, "RunTimeTicks": 27_000_000_000_u64,
            "ProviderIds": {"Tmdb": "77"},
            "UserData": {"PlaybackPositionTicks": 9_000_000_000_u64, "Played": false}
        }))?;
        let title = title_from_item(&episode, None, &settings()?)?;
        assert_eq!(
            crate::tmdb::js_numbers(title.to_value()).to_string(),
            r#"{"tmdbId":77,"mediaType":"tv","jellyfinItemId":"ep","playItemId":"ep","jellyfinSeriesId":"ser","title":"Show","subtitle":"S1E2 · Show","mediaUrl":"http://jf:8096/web/index.html#!/details?id=ep&context=home&serverId=srv%20id","progressPercent":33,"startPositionTicks":9000000000,"watched":false,"inProgress":true,"posterUrl":"/api/v1/library/items/ser/images/primary","runtimeMinutes":45,"inspectorItemId":"ser"}"#,
            "episode title"
        );
        Ok(())
    }

    #[test]
    fn play_targets() -> Result<(), String> {
        let eps = [
            item(
                &json!({"Id": "s0", "ParentIndexNumber": 0, "IndexNumber": 1, "UserData": {"Played": true}}),
            )?,
            item(
                &json!({"Id": "e2", "ParentIndexNumber": 1, "IndexNumber": 2, "UserData": {"Played": true}}),
            )?,
            item(
                &json!({"Id": "e1", "ParentIndexNumber": 1, "IndexNumber": 1, "UserData": {"Played": true}}),
            )?,
        ];
        let refs: Vec<&Item> = eps.iter().collect();
        let target = resolve_series_play_target("s", &refs, &[]);
        assert_eq!(
            target.map(|t| (t.play_item_id, t.subtitle)),
            Some((String::from("e1"), String::from("Rewatch S1E1"))),
            "rewatch skips specials"
        );
        let next = [
            item(
                &json!({"Id": "a", "ParentIndexNumber": 1, "IndexNumber": 1, "UserData": {"PlayedPercentage": 97.0}}),
            )?,
            item(
                &json!({"Id": "b", "ParentIndexNumber": 1, "IndexNumber": 2, "UserData": {"PlayedPercentage": 0.0}}),
            )?,
        ];
        let refs: Vec<&Item> = next.iter().collect();
        let target = resolve_series_play_target("s", &refs, &[]);
        assert_eq!(
            target.map(|t| (t.play_item_id, t.subtitle, t.progress)),
            Some((String::from("b"), String::from("Up next S1E2"), Some(0.0))),
            "next unwatched"
        );
        assert_eq!(
            resolve_series_play_target("s", &[], &[]),
            None,
            "no episodes"
        );
        Ok(())
    }

    #[test]
    fn apply_keeps_key_order() {
        let mut title = JsObj::default();
        title.put("mediaType", Value::from("tv"));
        title.set("subtitle", None);
        title.put("posterUrl", Value::from("p"));
        apply_play_target(
            &mut title,
            Some(PlayTarget {
                play_item_id: String::from("x"),
                subtitle: String::from("Up next S1E1"),
                progress: None,
                start: None,
            }),
        );
        assert_eq!(
            title.to_value().to_string(),
            r#"{"mediaType":"tv","subtitle":"Up next S1E1","posterUrl":"p","playItemId":"x"}"#,
            "subtitle keeps its place"
        );
    }

    #[test]
    fn browse_parameters() -> Result<(), String> {
        let query = BrowseQuery {
            q: Some(String::from("star")),
            media_type: Some("tv"),
            watched: Some("inProgress"),
            genre: Some(vec![String::from("Drama"), String::from("War")]),
            year_from: Some(2001),
            year_to: Some(1999),
            sort: "title",
            order: "asc",
            take: 24,
            skip: 48,
        };
        let params = browse_params(&query, "u1", 2026)?;
        let text: Vec<String> = params.iter().map(|(k, v)| format!("{k}={v}")).collect();
        assert_eq!(
            text.join("&"),
            "userId=u1&IncludeItemTypes=Series&Recursive=true&EnableUserData=true&SortBy=SortName&SortOrder=Ascending&StartIndex=48&Limit=24&Fields=ProviderIds,Overview,Genres,ProductionYear,DateCreated,PremiereDate,RunTimeTicks,RecursiveItemCount&SearchTerm=star&Filters=IsResumable&Genres=Drama,War&Years=1999,2000,2001",
            "params"
        );
        assert_eq!(
            production_years(None, Some(1901), 2026)?,
            Some(String::from("1900,1901")),
            "default start"
        );
        assert!(
            production_years(Some(0), Some(99_999), 2026).is_err(),
            "too wide"
        );
        Ok(())
    }

    #[test]
    fn pages() {
        assert_eq!(
            crate::tmdb::js_numbers(page_info(0.0, 20, 0)).to_string(),
            r#"{"pages":1,"pageSize":20,"results":0,"page":1}"#,
            "empty"
        );
        assert_eq!(
            crate::tmdb::js_numbers(page_info(41.0, 20, 40)).to_string(),
            r#"{"pages":3,"pageSize":20,"results":41,"page":3}"#,
            "third page"
        );
    }
}
