//! `GET /calendar` (`server/routes/calendar.ts`, `server/lib/calendar`,
//! `server/lib/releases/relevance.ts`): release occurrences in a range,
//! with request relevance, watch links and TMDB posters.
//!
//! The `OpenAPI` validator coerces `serverId`, `is4k`, `includeEpisodes`
//! and `includeUnmonitored` to numbers and booleans before the route reads
//! them, and the route only reads strings, so those filters never apply
//! (and the administrator-only 403 never fires); this port does the same.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::http::Method;
use serde_json::{Map, Value};

use super::{Outcome, Ready, Table, ADMIN};
use crate::clock::{days_from_civil, Utc};
use crate::db::{sqlite_datetime_to_iso, Bind, Db, MediaRow};
use crate::settings::public::truthy;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// This module's routes.
pub(super) const ROUTES: &Table = &[("/api/v1/calendar", Method::GET, calendar)];

const DAY_MS: i64 = 86_400_000;
/// `MAX_RANGE_DAYS`.
const MAX_RANGE_DAYS: i64 = 366;
/// The TTL of `getMovieBrowseMetadata` / `getTvBrowseMetadata`.
const BROWSE_TTL: u64 = 43_200;
/// `attachPosters` fetches this many posters at once.
const POSTER_CONCURRENCY: usize = 8;

/// The filters that take effect.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Filters {
    start: i64,
    end: i64,
    all: bool,
    media_type: Option<String>,
    source: Option<String>,
}

/// What the query means for Node: filters, or the 400 its handler sends.
#[derive(Debug, PartialEq, Eq)]
enum Parsed {
    Filters(Filters),
    Reject(&'static str),
}

/// `parseCalendarQuery` after the validator. `Err` for anything the
/// validator might reject or JavaScript's `Date` might read differently.
#[cfg(test)]
fn parse_query(raw: &str) -> Result<Parsed, String> {
    parse_query_with(raw, false)
}

/// [`parse_query`], once the validator passed the request
/// (`ctx_validated`) or not.
fn parse_query_with(raw: &str, ctx_validated: bool) -> Result<Parsed, String> {
    let mut seen: Vec<&str> = Vec::new();
    let (mut start, mut end) = (None, None);
    let mut filters = Filters {
        start: 0,
        end: 0,
        all: false,
        media_type: None,
        source: None,
    };
    for pair in raw.split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if seen.contains(&key) {
            return Err(String::from("a repeated query key"));
        }
        seen.push(key);
        let value = super::user::decode_query_value(value)
            .filter(|v| !v.is_empty())
            .ok_or_else(|| String::from("an empty or unencoded query value"))?;
        let one_of = |allowed: &[&str]| {
            if allowed.contains(&value.as_str()) {
                Ok(value.clone())
            } else {
                Err(format!("{key} outside the validator's enum"))
            }
        };
        match key {
            "start" => start = Some(parse_instant(&value).ok_or("an unported start")?),
            "end" => end = Some(parse_instant(&value).ok_or("an unported end")?),
            "scope" => filters.all = one_of(&["mine", "all"])? == "all",
            "mediaType" => filters.media_type = Some(one_of(&["movie", "tv"])?),
            "source" => filters.source = Some(one_of(&["sonarr", "radarr"])?),
            // The validator holds it as a number (`Infinity` included), which
            // `readSingle` ignores; a value it rejects never gets here.
            "serverId" if ctx_validated => {}
            "serverId" => {
                if !value.bytes().all(|b| b.is_ascii_digit()) {
                    return Err(String::from("serverId isn't a plain integer"));
                }
            }
            "is4k" | "includeEpisodes" | "includeUnmonitored" => {
                one_of(&["true", "false"])?;
            }
            _ => return Err(format!("{key} is unknown to the validator")),
        }
    }
    let (Some(start), Some(end)) = (start, end) else {
        return Err(String::from("start and end are required by the validator"));
    };
    if end <= start {
        return Ok(Parsed::Reject(
            "start and end must define a valid, non-empty range.",
        ));
    }
    if end - start > MAX_RANGE_DAYS * DAY_MS {
        return Ok(Parsed::Reject("Calendar range cannot exceed 366 days."));
    }
    filters.start = start;
    filters.end = end;
    Ok(Parsed::Filters(filters))
}

/// `new Date(text).getTime()` for `YYYY-MM-DD` (UTC midnight) and
/// `YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM)`, valid fields only, between
/// 1970 and 9999. Other shapes are `None`.
fn parse_instant(text: &str) -> Option<i64> {
    let number = |s: Option<&str>| -> Option<i64> {
        let s = s?;
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        s.parse().ok()
    };
    let sep = |i: usize, c: u8| text.as_bytes().get(i) == Some(&c);
    if !(sep(4, b'-') && sep(7, b'-')) {
        return None;
    }
    let year = number(text.get(..4))?;
    let month = number(text.get(5..7))?;
    let day = number(text.get(8..10))?;
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    let mut ms = days_from_civil(year, month, day) * DAY_MS;
    let rest = text.get(10..)?;
    if !rest.is_empty() {
        let time = rest.strip_prefix('T')?;
        let tsep = |i: usize| time.as_bytes().get(i) == Some(&b':');
        if !(tsep(2) && tsep(5)) {
            return None;
        }
        let hour = number(time.get(..2))?;
        let minute = number(time.get(3..5))?;
        let second = number(time.get(6..8))?;
        if hour > 23 || minute > 59 || second > 59 {
            return None;
        }
        let mut zone = time.get(8..)?;
        let mut millis = 0;
        if let Some(fraction) = zone.strip_prefix('.') {
            let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
            if digits == 0 {
                return None;
            }
            let kept: String = fraction.chars().take(digits.min(3)).collect();
            millis = format!("{kept:0<3}").parse::<i64>().ok()?;
            zone = fraction.get(digits..)?;
        }
        let offset = if zone == "Z" {
            0
        } else {
            let sign = match zone.as_bytes().first() {
                Some(b'+') => 1,
                Some(b'-') => -1,
                _ => return None,
            };
            if zone.len() != 6 || zone.as_bytes().get(3) != Some(&b':') {
                return None;
            }
            let oh = number(zone.get(1..3))?;
            let om = number(zone.get(4..6))?;
            if oh > 23 || om > 59 {
                return None;
            }
            sign * (oh * 3_600_000 + om * 60_000)
        };
        ms += hour * 3_600_000 + minute * 60_000 + second * 1000 + millis - offset;
    }
    let year = Utc::from_unix_millis(ms).year;
    (ms >= 0 && year <= 9999).then_some(ms)
}

const fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 => {
            if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// A `release_occurrence` row, as the calendar reads it.
#[derive(Debug, Clone)]
struct Occurrence {
    id: i64,
    source: String,
    server_id: Value,
    item_id: Value,
    media_type: String,
    tmdb_id: Option<i64>,
    tvdb_id: Option<i64>,
    media_id: Option<i64>,
    title: Value,
    subtitle: Value,
    season: Option<i64>,
    episode: Option<i64>,
    date_type: String,
    starts_at: String,
    all_day: bool,
    /// `monitored` and `hasFile` as JSON booleans.
    monitored: Value,
    has_file: Value,
    is4k: bool,
    source_url: Value,
    first_seen_ms: i64,
}

impl Occurrence {
    /// `${sourceServerId}:${sourceItemId}`.
    fn key(&self) -> String {
        format!(
            "{}:{}",
            crate::media::js_string(Some(&self.server_id)),
            crate::media::js_string(Some(&self.item_id))
        )
    }

    /// `startsAt` as the calendar prints it: the date alone for all-day
    /// entries.
    fn shown(&self, iso: &str) -> String {
        if self.all_day {
            iso.get(..10).unwrap_or(iso).to_owned()
        } else {
            iso.to_owned()
        }
    }
}

/// A database boolean: `SQLite` gives 0/1.
fn flag(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_i64() != Some(0),
        Some(Value::Null | Value::String(_) | Value::Array(_) | Value::Object(_)) | None => false,
    }
}

/// A date column as `toISOString` prints the hydrated `Date`.
fn date_iso(db: &Db, v: Option<&Value>) -> Result<Option<String>> {
    let Some(text) = v.and_then(Value::as_str) else {
        return Ok(None);
    };
    if db.is_postgres() {
        return Ok(Some(text.to_owned()));
    }
    sqlite_datetime_to_iso(text)
        .map(Some)
        .with_context(|| format!("{text:?} is not a datetime TypeORM wrote"))
}

/// A date column in the select list: ISO already on Postgres, as stored
/// on `SQLite` (converted after reading).
fn date_select(db: &Db, alias: &str, column: &str) -> String {
    let expr = format!(r#""{alias}"."{column}""#);
    if db.is_postgres() {
        format!(r#"{} AS "{column}""#, db.iso_sql(&expr))
    } else {
        format!(r#"{expr} AS "{column}""#)
    }
}

/// `findCalendarOccurrences` with the filters that apply.
async fn occurrences(db: &Db, filters: &Filters) -> Result<Vec<Occurrence>> {
    let columns = [
        "id",
        "source",
        "sourceServerId",
        "sourceItemId",
        "mediaType",
        "tmdbId",
        "tvdbId",
        "mediaId",
        "title",
        "subtitle",
        "seasonNumber",
        "episodeNumber",
        "dateType",
        "allDay",
        "monitored",
        "hasFile",
        "is4k",
        "sourceUrl",
    ]
    .iter()
    .map(|c| format!(r#""occurrence"."{c}" AS "{c}""#))
    .chain([
        date_select(db, "occurrence", "startsAt"),
        date_select(db, "occurrence", "firstSeenAt"),
    ])
    .collect::<Vec<_>>()
    .join(", ");
    let (bound, binds_range) = if db.is_postgres() {
        (
            ("CAST(?1 AS timestamptz)", "CAST(?2 AS timestamptz)"),
            [
                Utc::from_unix_millis(filters.start).iso_string(),
                Utc::from_unix_millis(filters.end).iso_string(),
            ],
        )
    } else {
        (
            ("?1", "?2"),
            [
                Utc::from_unix_millis(filters.start).typeorm_string(),
                Utc::from_unix_millis(filters.end).typeorm_string(),
            ],
        )
    };
    let [start, end] = binds_range;
    let mut binds = vec![Bind::Text(start), Bind::Text(end), Bind::Bool(true)];
    let mut sql = format!(
        r#"SELECT {columns} FROM "release_occurrence" "occurrence" WHERE ("occurrence"."startsAt" >= {} AND "occurrence"."startsAt" < {}) AND ("occurrence"."missingSince" IS NULL) AND ("occurrence"."monitored" = ?3)"#,
        bound.0, bound.1
    );
    for (column, value) in [
        ("mediaType", &filters.media_type),
        ("source", &filters.source),
    ] {
        if let Some(value) = value {
            binds.push(Bind::Text(value.clone()));
            sql.push_str(r#" AND ("occurrence".""#);
            sql.push_str(column);
            sql.push_str(r#"" = ?"#);
            sql.push_str(&binds.len().to_string());
            sql.push(')');
        }
    }
    sql.push_str(r#" ORDER BY "occurrence"."startsAt" ASC"#);
    let rows = db.rows(&sql, &binds).await?;
    rows.iter().map(|row| occurrence(db, row)).collect()
}

fn occurrence(db: &Db, row: &Map<String, Value>) -> Result<Occurrence> {
    let int = |k: &str| row.get(k).and_then(Value::as_i64);
    let text = |k: &str| {
        row.get(k)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .with_context(|| format!("release_occurrence.{k} is not text"))
    };
    let starts_at = date_iso(db, row.get("startsAt"))?.context("no startsAt")?;
    let first_seen = date_iso(db, row.get("firstSeenAt"))?.context("no firstSeenAt")?;
    Ok(Occurrence {
        id: int("id").context("no id")?,
        source: text("source")?,
        server_id: row.get("sourceServerId").cloned().unwrap_or(Value::Null),
        item_id: row.get("sourceItemId").cloned().unwrap_or(Value::Null),
        media_type: text("mediaType")?,
        tmdb_id: int("tmdbId"),
        tvdb_id: int("tvdbId"),
        media_id: int("mediaId"),
        title: row.get("title").cloned().unwrap_or(Value::Null),
        subtitle: row.get("subtitle").cloned().unwrap_or(Value::Null),
        season: int("seasonNumber"),
        episode: int("episodeNumber"),
        date_type: text("dateType")?,
        first_seen_ms: crate::clock::parse_date_millis(&first_seen)
            .context("an unreadable firstSeenAt")?,
        starts_at,
        all_day: flag(row.get("allDay")),
        monitored: Value::Bool(flag(row.get("monitored"))),
        has_file: Value::Bool(flag(row.get("hasFile"))),
        is4k: flag(row.get("is4k")),
        source_url: row.get("sourceUrl").cloned().unwrap_or(Value::Null),
    })
}

/// `selectPrimaryRadarrDates(items, 'digital')`.
fn primary_radarr_dates(items: &[Occurrence]) -> Vec<Occurrence> {
    let rank = |date_type: &str| {
        ["digital", "physical", "theatrical"]
            .iter()
            .position(|d| *d == date_type)
            .and_then(|p| i64::try_from(p).ok())
            .unwrap_or(-1)
    };
    let mut preferred: HashMap<String, (i64, i64)> = HashMap::new();
    for item in items.iter().filter(|i| i.source == "radarr") {
        let key = item.key();
        let better = preferred
            .get(&key)
            .is_none_or(|(_, current)| rank(&item.date_type) < *current);
        if better {
            preferred.insert(key, (item.id, rank(&item.date_type)));
        }
    }
    items
        .iter()
        .filter(|i| i.source != "radarr" || preferred.get(&i.key()).map(|p| p.0) == Some(i.id))
        .cloned()
        .collect()
}

/// `collectMovieDates`: every Radarr date of each movie, in query order.
fn movie_dates(items: &[Occurrence]) -> HashMap<String, Vec<Value>> {
    let mut dates: HashMap<String, Vec<Value>> = HashMap::new();
    for item in items.iter().filter(|i| i.source == "radarr") {
        let mut date = Map::new();
        date.insert(
            String::from("dateType"),
            Value::from(item.date_type.clone()),
        );
        date.insert(
            String::from("startsAt"),
            Value::from(item.shown(&item.starts_at)),
        );
        date.insert(String::from("allDay"), Value::Bool(item.all_day));
        dates
            .entry(item.key())
            .or_default()
            .push(Value::Object(date));
    }
    dates
}

/// The latest date change of an occurrence.
#[derive(Debug, Clone)]
struct Change {
    old_starts_at: Option<String>,
    kind: Value,
}

/// `findCalendarJoinData`'s changes: the first row per occurrence when
/// ordered by `detectedAt` descending.
async fn latest_changes(db: &Db, ids: &[i64]) -> Result<HashMap<i64, Change>> {
    let mut out = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let sql = format!(
        r#"SELECT "ReleaseDateChange"."occurrenceId" AS "occurrenceId", {}, "ReleaseDateChange"."changeKind" AS "changeKind" FROM "release_date_change" "ReleaseDateChange" WHERE ("ReleaseDateChange"."occurrenceId" IN ({})) ORDER BY "ReleaseDateChange"."detectedAt" DESC"#,
        date_select(db, "ReleaseDateChange", "oldStartsAt"),
        id_list(ids)
    );
    for row in db.rows(&sql, &[]).await? {
        let Some(id) = row.get("occurrenceId").and_then(Value::as_i64) else {
            continue;
        };
        if out.contains_key(&id) {
            continue;
        }
        out.insert(
            id,
            Change {
                old_starts_at: date_iso(db, row.get("oldStartsAt"))?,
                kind: row.get("changeKind").cloned().unwrap_or(Value::Null),
            },
        );
    }
    Ok(out)
}

fn id_list(ids: &[i64]) -> String {
    ids.iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

/// A request as relevance reads it.
#[derive(Debug, Clone, Default)]
struct Request {
    status: i64,
    is4k: bool,
    media_id: i64,
    user_id: Option<i64>,
    selection: bool,
    seasons: Vec<i64>,
    episodes: Vec<i64>,
}

/// Every request of these media, by id, with season numbers and episode
/// TVDB ids.
async fn requests(db: &Db, media_ids: &[i64]) -> Result<Vec<Request>> {
    if media_ids.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        r#"SELECT r."id" AS "id", r."status" AS "status", r."is4k" AS "is4k", r."mediaId" AS "mediaId", r."requestedById" AS "requestedById", r."episodeSelectionType" AS "episodeSelectionType" FROM "media_request" r WHERE r."mediaId" IN ({}) ORDER BY r."id" ASC"#,
        id_list(media_ids)
    );
    let rows = db.rows(&sql, &[]).await?;
    let mut ids = Vec::with_capacity(rows.len());
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let int = |k: &str| row.get(k).and_then(Value::as_i64);
        ids.push(int("id").context("a request without id")?);
        out.push(Request {
            status: int("status").unwrap_or(0),
            is4k: flag(row.get("is4k")),
            media_id: int("mediaId").unwrap_or(0),
            user_id: int("requestedById"),
            selection: truthy(row.get("episodeSelectionType")),
            ..Request::default()
        });
    }
    if ids.is_empty() {
        return Ok(out);
    }
    let list = id_list(&ids);
    for (table, column) in [
        ("season_request", "seasonNumber"),
        ("episode_request", "tvdbId"),
    ] {
        let sql = format!(
            r#"SELECT c."requestId" AS "requestId", c."{column}" AS "value" FROM "{table}" c WHERE c."requestId" IN ({list})"#
        );
        for row in db.rows(&sql, &[]).await? {
            let request = row.get("requestId").and_then(Value::as_i64);
            let value = row.get("value").and_then(Value::as_i64);
            let (Some(request), Some(value)) = (request, value) else {
                continue;
            };
            let Some(pos) = ids.iter().position(|id| *id == request) else {
                continue;
            };
            if let Some(target) = out.get_mut(pos) {
                if table == "season_request" {
                    target.seasons.push(value);
                } else {
                    target.episodes.push(value);
                }
            }
        }
    }
    Ok(out)
}

/// `getRequestRelevanceReason(...) !== undefined`.
fn relevant(occurrence: &Occurrence, request: &Request) -> bool {
    if matches!(request.status, 3 | 4) {
        return false;
    }
    if occurrence.media_type == "movie" {
        return true;
    }
    if occurrence
        .tvdb_id
        .is_some_and(|t| t != 0 && request.episodes.contains(&t))
    {
        return true;
    }
    if occurrence
        .season
        .is_some_and(|s| request.seasons.contains(&s))
    {
        return true;
    }
    !request.selection && request.episodes.is_empty()
}

/// The current user's relevance for one occurrence: the status of their
/// first relevant request (by id; Node takes the database's order). `Err`
/// where Node would throw (a relevant request without requester).
fn user_relevance(
    occurrence: &Occurrence,
    requests: &[Request],
    user_id: i64,
) -> Result<Option<i64>, String> {
    let Some(media_id) = occurrence.media_id.filter(|id| *id != 0) else {
        return Ok(None);
    };
    let mut statuses = Vec::new();
    for request in requests
        .iter()
        .filter(|r| r.media_id == media_id && r.is4k == occurrence.is4k)
    {
        if !relevant(occurrence, request) {
            continue;
        }
        match request.user_id {
            None => return Err(String::from("a relevant request without requester")),
            Some(id) if id == user_id => statuses.push(request.status),
            Some(_) => {}
        }
    }
    Ok(statuses.first().copied())
}

/// `safeExternalHttpUrl`: the WHATWG serialisation of an http(s) URL.
fn safe_url(value: Option<&str>) -> Option<String> {
    let value = value.filter(|v| !v.is_empty())?;
    let url = reqwest::Url::parse(value).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.as_str().to_owned())
}

/// What mapping every occurrence needs.
struct Mapping<'a> {
    admin: bool,
    user_id: i64,
    jellyfin: bool,
    now_ms: i64,
    movie_dates: &'a HashMap<String, Vec<Value>>,
    changes: &'a HashMap<i64, Change>,
    media: &'a HashMap<i64, MediaRow>,
}

/// `mapCalendarOccurrence`, `undefined` fields left out.
fn item_json(
    ctx: &Ready<'_>,
    c: &Mapping<'_>,
    o: &Occurrence,
    status: Option<i64>,
) -> Map<String, Value> {
    let media = o
        .media_id
        .filter(|id| *id != 0)
        .and_then(|id| c.media.get(&id));
    let mut out = Map::new();
    let mut put = |k: &str, v: Value| {
        out.insert(k.to_owned(), v);
    };
    put("id", Value::from(o.id));
    put("mediaType", Value::from(o.media_type.clone()));
    put("source", Value::from(o.source.clone()));
    if c.admin {
        put("sourceServerId", o.server_id.clone());
    }
    put("title", o.title.clone());
    if !o.subtitle.is_null() {
        put("subtitle", o.subtitle.clone());
    }
    if let Some(season) = o.season {
        put("seasonNumber", Value::from(season));
    }
    if let Some(episode) = o.episode {
        put("episodeNumber", Value::from(episode));
    }
    put("dateType", Value::from(o.date_type.clone()));
    if o.source == "radarr" {
        if let Some(dates) = c.movie_dates.get(&o.key()) {
            put("dates", Value::Array(dates.clone()));
        }
    }
    put("startsAt", Value::from(o.shown(&o.starts_at)));
    put("allDay", Value::Bool(o.all_day));
    put("monitored", o.monitored.clone());
    put("available", o.has_file.clone());
    let raw_url = media.and_then(|m| crate::media::media_url(m, &ctx.settings, o.is4k));
    if let Some(url) = safe_url(raw_url.as_deref()) {
        put("watchUrl", Value::from(url));
    }
    if c.jellyfin {
        if let Some(m) = media {
            let id = if o.is4k {
                &m.jellyfin_media_id4k
            } else {
                &m.jellyfin_media_id
            };
            put(
                "jellyfinItemId",
                id.as_deref().map_or(Value::Null, Value::from),
            );
        }
    }
    put("is4k", Value::Bool(o.is4k));
    let tmdb_id = o.tmdb_id.or_else(|| media.map(|m| m.tmdb_id));
    if let Some(tmdb_id) = tmdb_id {
        put("tmdbId", Value::from(tmdb_id));
    }
    if o.tmdb_id.is_some_and(|t| t != 0) || media.is_some_and(|m| m.tmdb_id != 0) {
        if let Some(tmdb_id) = tmdb_id {
            put(
                "detailUrl",
                Value::from(format!("/{}/{tmdb_id}", o.media_type)),
            );
        }
    }
    if c.admin && truthy(Some(&o.source_url)) {
        put("sourceUrl", o.source_url.clone());
    }
    put("requestedByCurrentUser", Value::Bool(status.is_some()));
    if let Some(status) = status {
        put("requestStatus", Value::from(status));
        put(
            "requestedQuality",
            Value::from(if o.is4k { "4k" } else { "standard" }),
        );
    }
    let new_season = o.source == "sonarr"
        && o.season.is_some_and(|s| s > 0)
        && o.episode == Some(1)
        && c.now_ms - o.first_seen_ms < 7 * DAY_MS;
    put("isNewSeason", Value::Bool(new_season));
    if let Some(change) = c.changes.get(&o.id) {
        if let Some(old) = &change.old_starts_at {
            put("previousStartsAt", Value::from(o.shown(old)));
        }
        put("changeKind", change.kind.clone());
    }
    out
}

/// `GET /calendar`.
fn calendar<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user = match ctx.authenticated(0) {
            Ok(user) => user,
            Err(why) => return Outcome::forward(why),
        };
        let admin = user.has_permission(ADMIN);
        let query = ctx.validated().map(|v| v.query.clone());
        let filters = if let Some(query) = query {
            match super::calendarquery::parse(&query, admin) {
                super::calendarquery::Parsed::Query(q) => Filters {
                    start: q.start,
                    end: q.end,
                    all: q.all,
                    media_type: q.media_type,
                    source: q.source,
                },
                super::calendarquery::Parsed::Refuse(status, message) => {
                    return ctx.error(status, message)
                }
                super::calendarquery::Parsed::Unported(why) => {
                    return Outcome::forward(why.to_owned())
                }
            }
        } else {
            match parse_query_with(ctx.req.uri.query().unwrap_or(""), ctx.judged().is_some()) {
                Ok(Parsed::Filters(filters)) => filters,
                Ok(Parsed::Reject(message)) => return ctx.error(400, message),
                Err(why) => return Outcome::forward(why),
            }
        };
        let partial = match partial_sources(ctx, admin).await {
            Ok(partial) => partial,
            Err(e) => return Outcome::forward(format!("source statuses: {e:#}")),
        };
        match results(ctx, &filters, user.id, admin).await {
            Ok(Ok(results)) => {
                let mut out = Map::new();
                out.insert(String::from("results"), Value::Array(results));
                out.insert(String::from("partialSources"), Value::Array(partial));
                ctx.json(&Value::Object(out))
            }
            Ok(Err(why)) => Outcome::forward(why),
            Err(e) => Outcome::forward(format!("calendar: {e:#}")),
        }
    })
}

/// `getCalendarItems`. `Ok(Err(why))` for what has to go to Node.
async fn results(
    ctx: &Ready<'_>,
    filters: &Filters,
    user_id: i64,
    admin: bool,
) -> Result<Result<Vec<Value>, String>> {
    let db = &ctx.state.db;
    let all = occurrences(db, filters).await?;
    let dates = movie_dates(&all);
    let selected = primary_radarr_dates(&all);
    let ids: Vec<i64> = selected.iter().map(|o| o.id).collect();
    let changes = latest_changes(db, &ids).await?;
    let mut media_ids: Vec<i64> = selected
        .iter()
        .filter_map(|o| o.media_id)
        .filter(|id| *id != 0)
        .collect();
    media_ids.sort_unstable();
    media_ids.dedup();
    let media: HashMap<i64, MediaRow> = db
        .media_by_ids(&media_ids, false)
        .await?
        .into_iter()
        .map(|m| (m.id, m))
        .collect();
    let requests = requests(db, &media_ids).await?;
    let jellyfin = ctx
        .settings
        .get("/main/mediaServerType")
        .and_then(Value::as_f64)
        .is_some_and(|t| t.to_bits() == 2.0_f64.to_bits());
    let context = Mapping {
        admin,
        user_id,
        jellyfin,
        now_ms: crate::clock::now_millis(),
        movie_dates: &dates,
        changes: &changes,
        media: &media,
    };
    let mut items = Vec::new();
    for occurrence in &selected {
        let status = match user_relevance(occurrence, &requests, context.user_id) {
            Ok(status) => status,
            Err(why) => return Ok(Err(why)),
        };
        if !filters.all && status.is_none() {
            continue;
        }
        let item = item_json(ctx, &context, occurrence, status);
        items.push((occurrence.media_type.clone(), item));
    }
    Ok(Ok(attach_posters(ctx, items).await))
}

/// `attachPosters`: the poster of each title from TMDB's cached browse
/// metadata, appended where there is one.
async fn attach_posters(ctx: &Ready<'_>, items: Vec<(String, Map<String, Value>)>) -> Vec<Value> {
    let mut keys: Vec<(bool, i64)> = Vec::new();
    for (media_type, item) in &items {
        if let Some(id) = item
            .get("tmdbId")
            .and_then(Value::as_i64)
            .filter(|id| *id != 0)
        {
            let key = (media_type == "movie", id);
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
    }
    let (locale, _) = super::movie::languages(ctx, None, None);
    let limit = Arc::new(tokio::sync::Semaphore::new(POSTER_CONCURRENCY));
    let mut tasks = tokio::task::JoinSet::new();
    for (movie, id) in keys {
        let shared = Arc::clone(&ctx.shared);
        let limit = Arc::clone(&limit);
        let locale = locale.clone();
        tasks.spawn(async move {
            let permit = limit.acquire_owned().await;
            let path = if movie {
                format!("/movie/{id}")
            } else {
                format!("/tv/{id}")
            };
            let poster = match shared
                .tmdb
                .raw(&path, &[("language", locale)], BROWSE_TTL)
                .await
            {
                Ok(data) => data.get("poster_path").cloned(),
                Err(e) => {
                    tracing::debug!("Unable to load calendar poster for {path}: {e:#}");
                    None
                }
            };
            drop(permit);
            ((movie, id), poster)
        });
    }
    let mut posters: HashMap<(bool, i64), Value> = HashMap::new();
    while let Some(done) = tasks.join_next().await {
        if let Ok((key, Some(poster))) = done {
            posters.insert(key, poster);
        }
    }
    items
        .into_iter()
        .map(|(media_type, mut item)| {
            let poster = item
                .get("tmdbId")
                .and_then(Value::as_i64)
                .filter(|id| *id != 0)
                .and_then(|id| posters.get(&(media_type == "movie", id)))
                .filter(|p| truthy(Some(p)));
            if let Some(poster) = poster {
                item.insert(String::from("posterPath"), poster.clone());
            }
            Value::Object(item)
        })
        .collect()
}

/// The release sync statuses from Node, which runs the jobs.
async fn node_source_statuses(ctx: &Ready<'_>) -> Result<Value> {
    ctx.state
        .internal
        .get(format!(
            "{}/internal/calendar/source-statuses",
            ctx.state.env.node_url.trim_end_matches('/')
        ))
        .header("X-API-Key", ctx.settings.api_key())
        .send()
        .await
        .context("asking Node for the release sync statuses")?
        .error_for_status()
        .context("Node refused the release sync statuses")?
        .json::<Value>()
        .await
        .context("the release sync statuses are not JSON")
}

/// `releaseCalendarSync.getSourceStatuses()`, from whichever process runs
/// the jobs, reduced to the sources whose last sync failed.
async fn partial_sources(ctx: &Ready<'_>, admin: bool) -> Result<Vec<Value>> {
    let statuses: Value = if crate::jobs::scheduler::rust_jobs() {
        Value::Array(crate::jobs::release_calendar::source_statuses())
    } else {
        node_source_statuses(ctx).await?
    };

    let statuses = statuses
        .as_array()
        .context("the release sync statuses are not a list")?;
    Ok(statuses
        .iter()
        .filter(|s| truthy(s.get("lastErrorAt")) && !truthy(s.get("lastSuccessAt")))
        .map(|s| {
            let mut out = Map::new();
            let keys: &[&str] = if admin {
                &["source", "serverId"]
            } else {
                &["source"]
            };
            for key in keys {
                if let Some(v) = s.get(*key) {
                    out.insert((*key).to_owned(), v.clone());
                }
            }
            Value::Object(out)
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn occ(id: i64, source: &str, item: i64, date_type: &str) -> Occurrence {
        Occurrence {
            id,
            source: source.to_owned(),
            server_id: Value::from(1),
            item_id: Value::from(item),
            media_type: String::from(if source == "radarr" { "movie" } else { "tv" }),
            tmdb_id: None,
            tvdb_id: None,
            media_id: Some(5),
            title: Value::from("t"),
            subtitle: Value::Null,
            season: Some(2),
            episode: Some(1),
            date_type: date_type.to_owned(),
            starts_at: String::from("2026-08-01T10:00:00.000Z"),
            all_day: false,
            monitored: Value::Bool(true),
            has_file: Value::Bool(false),
            is4k: false,
            source_url: Value::Null,
            first_seen_ms: 0,
        }
    }

    #[test]
    fn parses_instants_like_date() {
        assert_eq!(
            parse_instant("1970-01-02"),
            Some(DAY_MS),
            "date only is UTC"
        );
        assert_eq!(
            parse_instant("2026-08-01T00:00:00.123456+02:00"),
            parse_instant("2026-07-31T22:00:00.123Z"),
            "offsets and long fractions"
        );
        assert_eq!(
            parse_instant("2026-08-01T00:00:00.1Z"),
            parse_instant("2026-08-01").map(|d| d + 100),
            "short fraction"
        );
        for odd in [
            "2026-02-30",
            "2026-13-01",
            "2026-08-01T24:00:00Z",
            "2026-08-01T10:00:00",
            "2026-08-01T10:00Z",
            "2026-08-01t10:00:00z",
            "1969-12-31",
            "2026-8-1",
        ] {
            assert_eq!(parse_instant(odd), None, "{odd} is left to Node");
        }
        assert!(parse_instant("2028-02-29").is_some(), "leap day");
    }

    #[test]
    fn parses_the_query() {
        let parsed = parse_query(
            "start=2026-08-01&end=2026-09-01&scope=all&mediaType=tv&is4k=true&serverId=3",
        );
        assert_eq!(
            parsed,
            Ok(Parsed::Filters(Filters {
                start: parse_instant("2026-08-01").unwrap_or(0),
                end: parse_instant("2026-09-01").unwrap_or(0),
                all: true,
                media_type: Some(String::from("tv")),
                source: None,
            })),
            "coerced filters are ignored"
        );
        assert_eq!(
            parse_query("start=2026-09-01&end=2026-09-01"),
            Ok(Parsed::Reject(
                "start and end must define a valid, non-empty range."
            )),
            "empty range"
        );
        assert_eq!(
            parse_query("start=2025-01-01&end=2026-09-01"),
            Ok(Parsed::Reject("Calendar range cannot exceed 366 days.")),
            "too long"
        );
        assert!(parse_query("start=2026-08-01").is_err(), "missing end");
        assert!(
            parse_query("start=2026-08-01&end=2026-09-01&scope=x").is_err(),
            "enum"
        );
        assert!(
            parse_query("start=2026-08-01T00:00:00Z&end=2026-09-01").is_err(),
            "unencoded colon"
        );
        assert!(
            parse_query("start=2026-08-01T00%3A00%3A00Z&end=2026-09-01").is_ok(),
            "encoded colon"
        );
    }

    #[test]
    fn picks_the_digital_radarr_date() {
        let items = vec![
            occ(1, "radarr", 7, "theatrical"),
            occ(2, "radarr", 7, "digital"),
            occ(3, "radarr", 7, "physical"),
            occ(4, "sonarr", 7, "air"),
            occ(5, "radarr", 8, "physical"),
        ];
        let ids: Vec<i64> = primary_radarr_dates(&items).iter().map(|o| o.id).collect();
        assert_eq!(ids, vec![2, 4, 5], "one date per movie, sonarr kept");
        assert_eq!(
            movie_dates(&items).get("1:7").map(Vec::len),
            Some(3),
            "all dates of the movie"
        );
    }

    #[test]
    fn relevance_follows_node() {
        let o = occ(1, "sonarr", 7, "air");
        let series = Request {
            status: 2,
            media_id: 5,
            user_id: Some(9),
            seasons: vec![1],
            ..Request::default()
        };
        assert!(relevant(&o, &series), "series request covers new seasons");
        let declined = Request {
            status: 3,
            ..series.clone()
        };
        assert!(!relevant(&o, &declined), "declined");
        let episodic = Request {
            episodes: vec![100],
            ..series.clone()
        };
        assert!(!relevant(&o, &episodic), "episode requests are specific");
        let pending = Request {
            status: 1,
            seasons: vec![2],
            ..series.clone()
        };
        assert_eq!(
            user_relevance(&o, &[series, pending], 9),
            Ok(Some(2)),
            "first relevant request wins"
        );
    }

    #[test]
    fn safe_urls() {
        assert_eq!(
            safe_url(Some("HTTP://Example.com:80/a b")),
            Some(String::from("http://example.com/a%20b")),
            "WHATWG serialisation"
        );
        assert_eq!(safe_url(Some("plex://preplay/")), None, "other schemes");
        assert_eq!(safe_url(Some("")), None, "empty");
        assert_eq!(
            safe_url(Some("http://undefined:undefined/")),
            None,
            "invalid"
        );
    }
}
