//! `syncSimklUser(userId, force)` (`server/lib/simklSync.ts`) behind
//! `POST /internal/simkl/sync`.
//!
//! One sync per user at a time, at most every
//! fifteen minutes unless forced, mirrored into `simkl_sync_item` and
//! `simkl_sync_state`.
//!
//! Node writes the items and the state in one transaction; the database
//! helpers here have none, so the same statements run one after another.

use std::collections::HashSet;
use std::sync::LazyLock;

use serde_json::{Map, Value};

// simkl_sync_state and simkl_sync_item dates are `timestamp` columns.
use super::KeyLock;
use crate::db::{Bind, Db};
use crate::jobs::syncutil::Tx;
use crate::naivetime::{bind as date_bind, param as date_param};
use crate::settings::public::truthy;
use crate::standalone::internal::Answer;
use crate::state::AppState;

/// `AUTO_SYNC_MIN_INTERVAL_MS`.
const MIN_INTERVAL_MS: i64 = 15 * 60 * 1000;
/// `TYPES`: upstream bucket and local type.
const TYPES: [(&str, &str); 3] = [("shows", "show"), ("movies", "movie"), ("anime", "anime")];
const STATUSES: [&str; 5] = ["watching", "plantowatch", "hold", "completed", "dropped"];
/// `MEDIA_ACTIVITIES`: the activity buckets per media type.
const MEDIA_ACTIVITIES: [&str; 3] = ["tv_shows", "anime", "movies"];
/// `EPISODE_PARAMS`: shows and anime carry their watched episodes; movies
/// have none.
const EPISODE_PARAMS: &str = "extended=full&include_all_episodes=yes";

/// `syncLock`.
static LOCKS: LazyLock<KeyLock> = LazyLock::new(KeyLock::default);

/// The route: `syncSimklUser(Number(userId), Boolean(force))`.
pub async fn answer(state: &AppState, body: Option<&Value>) -> Answer {
    let user_id = crate::jsval::number_of(body.and_then(|b| b.get("userId")));
    let force = truthy(body.and_then(|b| b.get("force")));
    match sync(state, user_id, force).await {
        Ok(result) => Answer::json(200, result),
        Err(e) => Answer::message(500, &format!("{e:#}")),
    }
}

/// The user's `simkl_sync_state` row.
#[derive(Debug, Clone)]
struct Previous {
    id: i64,
    activities: Option<String>,
    initial_sync_complete: bool,
    last_checked_ms: Option<i64>,
    last_success: Option<String>,
    last_error: Option<String>,
}

fn whole(value: f64) -> Option<i64> {
    (value.is_finite() && value.fract() == 0.0)
        .then(|| format!("{value:.0}").parse().ok())
        .flatten()
}

async fn load_previous(db: &Db, user_id: i64) -> anyhow::Result<Option<Previous>> {
    let sql = format!(
        r#"SELECT CAST("id" AS BIGINT) AS "id", "activities", "initialSyncComplete",
                  {} AS "lastCheckedAt", {} AS "lastSuccessfulSyncAt", "lastError"
           FROM "simkl_sync_state" WHERE "userId" = ?1 LIMIT 1"#,
        crate::naivetime::select(db, "\"lastCheckedAt\""),
        crate::naivetime::select(db, "\"lastSuccessfulSyncAt\"")
    );
    let rows = db.rows(&sql, &[Bind::Int(user_id)]).await?;
    Ok(rows.into_iter().next().map(|row| {
        let text = |k: &str| row.get(k).and_then(Value::as_str).map(str::to_owned);
        Previous {
            id: row.get("id").and_then(Value::as_i64).unwrap_or(0),
            activities: text("activities"),
            initial_sync_complete: truthy(row.get("initialSyncComplete")),
            last_checked_ms: text("lastCheckedAt")
                .and_then(|t| crate::naivetime::read_millis(db, &t)),
            last_success: text("lastSuccessfulSyncAt").and_then(|t| crate::naivetime::read(db, &t)),
            last_error: text("lastError"),
        }
    }))
}

fn result(performed: bool, stale: bool, last_success: Option<&str>, error: Option<&str>) -> Value {
    let mut out = Map::new();
    out.insert(String::from("performed"), Value::Bool(performed));
    out.insert(String::from("stale"), Value::Bool(stale));
    if let Some(at) = last_success {
        out.insert(String::from("lastSuccessfulSyncAt"), Value::from(at));
    }
    if let Some(error) = error {
        out.insert(String::from("error"), Value::from(error));
    }
    Value::Object(out)
}

/// `syncSimklUser`.
async fn sync(state: &AppState, user_id: f64, force: bool) -> anyhow::Result<Value> {
    let id = whole(user_id);
    let _guard = match id {
        Some(id) => Some(LOCKS.acquire(id).await),
        None => None,
    };
    let previous = match id {
        Some(id) => load_previous(&state.db, id).await?,
        None => None,
    };
    let now = crate::clock::now_millis();
    if let Some(previous) = &previous {
        let recent = previous
            .last_checked_ms
            .is_some_and(|at| now - at < MIN_INTERVAL_MS);
        if !force && recent {
            return Ok(result(false, false, previous.last_success.as_deref(), None));
        }
    }
    let outcome = attempt(state, id, previous.as_ref()).await;
    settle(&state.db, previous.as_ref(), outcome).await
}

/// The `catch` block: a failure is saved on the state row and answered
/// as stale.
async fn settle(
    db: &Db,
    previous: Option<&Previous>,
    outcome: Result<Value, String>,
) -> anyhow::Result<Value> {
    match outcome {
        Ok(value) => Ok(value),
        Err(message) => {
            if let Some(previous) = previous {
                save_failure(db, previous, &message).await?;
            }
            Ok(result(
                true,
                true,
                previous.and_then(|p| p.last_success.as_deref()),
                Some(&message),
            ))
        }
    }
}

/// The catch block's `stateRepository.save(previous)`: `lastCheckedAt`
/// and `lastError`, or the whole row again (without its user) when a
/// rejected token already deleted it.
async fn save_failure(db: &Db, previous: &Previous, message: &str) -> anyhow::Result<()> {
    let now = crate::clock::now_millis();
    let mut binds = vec![date_bind(db, now)];
    let mut sets = vec![format!("\"lastCheckedAt\" = {}", date_param(db, 1))];
    if previous.last_error.as_deref() != Some(message) {
        binds.push(Bind::Text(message.to_owned()));
        sets.push(String::from("\"lastError\" = ?2"));
    }
    binds.push(Bind::Int(previous.id));
    let sql = format!(
        "UPDATE \"simkl_sync_state\" SET {} WHERE \"id\" = ?{}",
        sets.join(", "),
        binds.len()
    );
    if db.execute(&sql, &binds).await? > 0 {
        return Ok(());
    }
    let success = previous
        .last_success
        .as_deref()
        .and_then(crate::clock::parse_date_millis);
    let sql = format!(
        r#"INSERT INTO "simkl_sync_state"
           ("id", "activities", "initialSyncComplete", "lastCheckedAt", "lastSuccessfulSyncAt", "lastError")
           VALUES (?1, ?2, ?3, {}, {}, ?6)"#,
        date_param(db, 4),
        date_param(db, 5)
    );
    let binds = [
        Bind::Int(previous.id),
        Bind::OptText(previous.activities.clone()),
        Bind::Bool(previous.initial_sync_complete),
        date_bind(db, now),
        success.map_or(Bind::OptText(None), |ms| date_bind(db, ms)),
        Bind::Text(message.to_owned()),
    ];
    db.execute(&sql, &binds).await?;
    Ok(())
}

/// The `try` block: everything that turns into `{ stale: true, error }`.
async fn attempt(
    state: &AppState,
    user_id: Option<i64>,
    previous: Option<&Previous>,
) -> Result<Value, String> {
    let client = user_client(state, user_id).await?;
    let Some(user_id) = user_id else {
        return Err(String::from(crate::simklapi::NOT_LINKED));
    };
    pull(&state.db, &client, user_id, previous).await
}

/// The two phases of Simkl's sync guide: `/sync/activities`, then only
/// what moved since the saved snapshot (everything on the first run).
async fn pull(
    db: &Db,
    client: &crate::simklapi::Client,
    user_id: i64,
    previous: Option<&Previous>,
) -> Result<Value, String> {
    // Read before pulling, so a change made meanwhile is in the next delta.
    let activities = get(client, "/sync/activities").await?;
    let snapshot = super::js_stringify(&activities);
    let old_activities = match previous
        .and_then(|p| p.activities.as_deref())
        .filter(|text| !text.is_empty())
    {
        Some(text) => Some(serde_json::from_str::<Value>(text).map_err(|e| e.to_string())?),
        None => None,
    };
    let old_watermark = old_activities.as_ref().and_then(watermark);
    let delta = match (previous, &old_activities, &old_watermark) {
        (Some(previous), Some(old), Some(from)) if previous.initial_sync_complete => {
            Some((previous, old, from.as_str()))
        }
        _ => None,
    };
    if let Some((previous, _, from)) = delta {
        if watermark(&activities).as_deref() == Some(from) {
            let sql = format!(
                "UPDATE \"simkl_sync_state\" SET \"lastCheckedAt\" = {} WHERE \"id\" = ?2",
                date_param(db, 1)
            );
            db.execute(
                &sql,
                &[
                    date_bind(db, crate::clock::now_millis()),
                    Bind::Int(previous.id),
                ],
            )
            .await
            .map_err(|e| format!("{e:#}"))?;
            return Ok(result(true, false, previous.last_success.as_deref(), None));
        }
    }

    let mut items: Vec<Item> = Vec::new();
    // Everything still on Simkl; local items missing from it were removed.
    let mut upstream: Option<HashSet<String>> = None;
    if let Some((_, old, from)) = delta {
        let moved = moved_activities(&activities, old);
        let from = crate::jsval::form_encode(from);
        if moved.statuses {
            let path = format!("/sync/all-items?date_from={from}&{EPISODE_PARAMS}");
            collect(&mut items, &get(client, &path).await?, None, true);
        }
        // A rating change on a listed item moves only `rated_at`.
        if moved.ratings {
            let path = format!("/sync/ratings?date_from={from}");
            collect(&mut items, &get(client, &path).await?, None, false);
        }
        if moved.removals {
            let data = get(client, "/sync/all-items?extended=simkl_ids_only").await?;
            let mut ids = HashSet::new();
            for (item, kind) in sync_entries(&data, None) {
                let item_ids = item
                    .get("ids")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                if let Some(id) = record_id(&item, &item_ids) {
                    ids.insert(format!("{kind}:{id}"));
                }
            }
            upstream = Some(ids);
        }
    } else {
        // One type after another, never in parallel.
        for (kind, local) in TYPES {
            let episodes = local != "movie";
            let params = if episodes { EPISODE_PARAMS } else { "" };
            let batches = match client.request(&all_items(kind, None, params), None).await {
                Ok(data) => vec![data],
                Err(failure) if is_max_items(&failure) => {
                    let mut batches = Vec::with_capacity(STATUSES.len());
                    for status in STATUSES {
                        batches.push(get(client, &all_items(kind, Some(status), params)).await?);
                    }
                    batches
                }
                Err(failure) => return Err(failure.message()),
            };
            for data in &batches {
                collect(&mut items, data, Some(local), episodes);
            }
        }
        upstream = Some(items.iter().map(item_key).collect());
    }
    let now = crate::clock::now_millis();
    write(
        db,
        user_id,
        &items,
        upstream.as_ref(),
        previous,
        &snapshot,
        now,
    )
    .await
    .map_err(|e| format!("{e:#}"))?;
    Ok(result(
        true,
        false,
        Some(&crate::clock::Utc::from_unix_millis(now).iso_string()),
        None,
    ))
}

/// `collect(data, type, withEpisodes)`.
fn collect(items: &mut Vec<Item>, data: &Value, fallback: Option<&str>, episodes: bool) {
    items.extend(
        sync_entries(data, fallback)
            .into_iter()
            .filter_map(|(item, kind)| normalize_item(&item, Some(kind.as_str()), episodes)),
    );
}

/// `getAllItems(type, params, status)`'s path.
fn all_items(kind: &str, status: Option<&str>, params: &str) -> String {
    let status = status.map(|s| format!("/{s}")).unwrap_or_default();
    let query = if params.is_empty() {
        String::new()
    } else {
        format!("?{params}")
    };
    format!("/sync/all-items/{kind}{status}{query}")
}

/// `isMaxItemsError`: Simkl wants this type fetched per status.
fn is_max_items(failure: &crate::simklapi::Failure) -> bool {
    static PATTERN: LazyLock<Option<regex::Regex>> =
        LazyLock::new(|| regex::Regex::new(r"(?i)max_items|too many").ok());
    let status = match failure {
        crate::simklapi::Failure::Rejected { status, .. }
        | crate::simklapi::Failure::OAuth { status, .. } => *status,
        crate::simklapi::Failure::RateLimited(_)
        | crate::simklapi::Failure::Unauthorized
        | crate::simklapi::Failure::Unavailable
        | crate::simklapi::Failure::Other(_) => return false,
    };
    status == 400
        && PATTERN
            .as_ref()
            .is_some_and(|pattern| pattern.is_match(&failure.message()))
}

/// `createSimklUserClient(userId)`.
async fn user_client(
    state: &AppState,
    user_id: Option<i64>,
) -> Result<crate::simklapi::Client, String> {
    let settings = super::settings(state).await.map_err(|e| format!("{e:#}"))?;
    let Some(client_id) = crate::simklapi::effective_client_id(&settings) else {
        return Err(String::from("simkl.clientId is not text"));
    };
    if client_id.is_empty() {
        return Err(String::from(crate::simklapi::NOT_CONFIGURED));
    }
    let Some(user_id) = user_id else {
        return Err(String::from(crate::simklapi::NOT_LINKED));
    };
    let config = crate::simklapi::Config::new(
        &state.outbound,
        &client_id,
        &state.version.version,
        crate::simklapi::timeout_of(&settings),
    );
    crate::simklapi::user_client(&state.db, &config, user_id).await
}

/// `request('get', path)` as the sync's error text.
async fn get(client: &crate::simklapi::Client, path: &str) -> Result<Value, String> {
    client.request(path, None).await.map_err(|e| e.message())
}

/// `scalar(activities.all)`.
fn watermark(activities: &Value) -> Option<String> {
    crate::simkl::scalar(activities.get("all"))
}

/// What `movedActivities` found moved.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct Moved {
    statuses: bool,
    removals: bool,
    ratings: bool,
}

/// `movedActivities(now, before)`: which parts of the library moved
/// between two snapshots. Every other key of a media bucket is a list
/// status (`watching`, `plantowatch`, …); `all` only summarizes them, and
/// `playback`, `settings` and `custom_lists` are unused.
fn moved_activities(now: &Value, before: &Value) -> Moved {
    let mut moved = Moved::default();
    for media in MEDIA_ACTIVITIES {
        let current = now.get(media).and_then(Value::as_object);
        let previous = before.get(media).and_then(Value::as_object);
        let keys: HashSet<&String> = current
            .into_iter()
            .chain(previous)
            .flat_map(Map::keys)
            .collect();
        for key in keys {
            let value = |bucket: Option<&Map<String, Value>>| {
                crate::simkl::scalar(bucket.and_then(|b| b.get(key)))
            };
            if value(current) == value(previous) {
                continue;
            }
            match key.as_str() {
                "removed_from_list" => moved.removals = true,
                "rated_at" => moved.ratings = true,
                "all" | "playback" => {}
                _ => moved.statuses = true,
            }
        }
    }
    moved
}

/// `SYNC_BUCKETS`.
fn sync_bucket(key: &str) -> Option<&'static str> {
    match key {
        "movies" | "movie" => Some("movie"),
        "shows" | "show" | "tv" => Some("show"),
        "anime" => Some("anime"),
        _ => None,
    }
}

/// `syncEntries(payload, fallbackType)`.
fn sync_entries(payload: &Value, fallback: Option<&str>) -> Vec<(Map<String, Value>, String)> {
    use crate::simkl::{catalog_entries, unwrap_item};
    match payload {
        Value::Array(items) => fallback.map_or_else(Vec::new, |kind| {
            items
                .iter()
                .filter_map(Value::as_object)
                .map(|item| (unwrap_item(item), kind.to_owned()))
                .collect()
        }),
        Value::Object(map) => {
            let mut entries = Vec::new();
            for (key, value) in crate::jsval::object_entries(map) {
                let Some(kind) = sync_bucket(key).or(fallback) else {
                    continue;
                };
                let Value::Array(items) = value else {
                    continue;
                };
                for item in items.iter().filter_map(Value::as_object) {
                    entries.push((unwrap_item(item), kind.to_owned()));
                }
            }
            if !entries.is_empty() {
                return entries;
            }
            let Some(kind) = fallback else {
                return Vec::new();
            };
            catalog_entries(payload, "all")
                .into_iter()
                .map(|(item, _)| (unwrap_item(&item), kind.to_owned()))
                .collect()
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => Vec::new(),
    }
}

/// `a ?? b ?? ...`.
fn coalesce<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    values.iter().copied().flatten().find(|v| !v.is_null())
}

/// `simklRecordId(item, ids)`.
fn record_id(item: &Map<String, Value>, ids: &Map<String, Value>) -> Option<String> {
    crate::simkl::scalar(coalesce(&[
        ids.get("simkl"),
        ids.get("simkl_id"),
        item.get("simkl_id"),
        item.get("id"),
    ]))
}

/// `stringValue`: a string with something besides white space, as is.
fn string_value(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|s| !crate::jsval::trim(s).is_empty())
        .map(str::to_owned)
}

/// `numberValue`: `Number(value)` when finite.
fn number_value(value: Option<&Value>) -> Option<f64> {
    let n = crate::jsval::number_of(value);
    n.is_finite().then_some(n)
}

/// `toDate`: Unix seconds or a date string, as milliseconds.
fn to_date(value: Option<&Value>) -> Option<i64> {
    let ms = match value? {
        Value::Number(n) => n.as_f64().filter(|n| n.is_finite())? * 1000.0,
        Value::String(text) => return js_date_parse(text),
        Value::Null | Value::Bool(_) | Value::Array(_) | Value::Object(_) => return None,
    };
    // `new Date(ms)`: TimeClip.
    (ms.abs() <= 8.64e15)
        .then(|| format!("{:.0}", ms.trunc()).parse().ok())
        .flatten()
}

/// `Date.parse` for ISO dates: `YYYY-MM-DD`, or with a time and `Z` or a
/// `±HH:MM` offset. Other shapes aren't read.
fn js_date_parse(text: &str) -> Option<i64> {
    if let Some(ms) = crate::clock::parse_date_millis(text) {
        return Some(ms);
    }
    let (date, time) = text.split_once('T')?;
    let split = time.rfind(['+', '-'])?;
    let (clock, offset) = time.split_at(split);
    let sign: i64 = if offset.starts_with('-') { -1 } else { 1 };
    let (hours, minutes) = offset.get(1..)?.split_once(':')?;
    let hours: i64 = hours.parse().ok()?;
    let minutes: i64 = minutes.parse().ok()?;
    if hours > 23 || minutes > 59 {
        return None;
    }
    let utc = crate::clock::parse_date_millis(&format!("{date}T{clock}Z"))?;
    Some(utc - sign * (hours * 3_600_000 + minutes * 60_000))
}

/// A `simkl_sync_item` column value.
#[derive(Debug, Clone, PartialEq)]
enum Cell {
    /// `null`: clears the column.
    Null,
    Text(String),
    Number(f64),
    Date(i64),
}

/// `normalizeItem`: the columns in entity order (absent ones left out, as
/// `undefined` is).
type Item = Vec<(&'static str, Cell)>;

/// A text column of an item.
fn item_text(item: &Item, column: &str) -> Option<String> {
    item.iter().find_map(|(c, cell)| match cell {
        Cell::Text(t) if *c == column => Some(t.clone()),
        Cell::Null | Cell::Text(_) | Cell::Number(_) | Cell::Date(_) => None,
    })
}

/// `${simklType}:${simklId}`.
fn item_key(item: &Item) -> String {
    format!(
        "{}:{}",
        item_text(item, "simklType").unwrap_or_default(),
        item_text(item, "simklId").unwrap_or_default()
    )
}

/// `episodeCoordinates(raw)`: watched episodes from an `extended=full`
/// row, in Simkl's numbering.
fn episode_coordinates(raw: &Map<String, Value>) -> Vec<(i64, i64)> {
    let int = |value: Option<&Value>| crate::mappinglayer::int_of(crate::jsval::number_of(value));
    let mut out = Vec::new();
    for season in raw
        .get("seasons")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(number) = int(season.get("number")).filter(|n| *n >= 0) else {
            continue;
        };
        for episode in season
            .get("episodes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(episode) = int(episode.get("number")).filter(|n| *n > 0) {
                out.push((number, episode));
            }
        }
    }
    out
}

/// `normalizeItem(raw, fallbackType, withEpisodes)`. `episodes`: the row
/// came from an `extended=full` request, so a show without `seasons` has
/// no watched episodes; other rows leave them alone.
fn normalize_item(
    raw: &Map<String, Value>,
    fallback: Option<&str>,
    episodes: bool,
) -> Option<Item> {
    let empty = Map::new();
    let ids = raw.get("ids").and_then(Value::as_object).unwrap_or(&empty);
    let simkl_id = record_id(raw, ids)?;
    let declared = string_value(coalesce(&[raw.get("type"), raw.get("simkl_type")]));
    let kind = match declared.as_deref() {
        Some(k @ ("show" | "anime" | "movie")) => k.to_owned(),
        _ => fallback?.to_owned(),
    };
    let title = string_value(coalesce(&[raw.get("title"), raw.get("name")]))?;
    let status = string_value(raw.get("status")).filter(|s| STATUSES.contains(&s.as_str()))?;
    let movie = kind == "movie";
    let mut item: Item = vec![
        ("simklId", Cell::Text(simkl_id)),
        ("simklType", Cell::Text(kind)),
    ];
    let number = |item: &mut Item, column: &'static str, value: Option<&Value>| {
        if let Some(n) = number_value(value) {
            item.push((column, Cell::Number(n)));
        }
    };
    number(
        &mut item,
        "tmdbId",
        coalesce(&[ids.get("tmdb"), raw.get("tmdb")]),
    );
    number(
        &mut item,
        "tvdbId",
        coalesce(&[ids.get("tvdb"), raw.get("tvdb")]),
    );
    if let Some(slug) = string_value(coalesce(&[raw.get("slug"), ids.get("slug")])) {
        item.push(("slug", Cell::Text(slug)));
    }
    item.push(("title", Cell::Text(title)));
    number(&mut item, "year", raw.get("year"));
    let poster = string_value(coalesce(&[raw.get("poster"), raw.get("poster_path")]));
    if let Some(url) = crate::simkl::poster_url(poster.as_deref()) {
        item.push(("posterPath", Cell::Text(url)));
    }
    if let Some(anime) = string_value(raw.get("anime_type")) {
        item.push(("animeType", Cell::Text(anime)));
    }
    item.push(("status", Cell::Text(status)));
    // `null` clears a removed rating; a missing one leaves the cache alone.
    if raw.get("user_rating").is_some_and(Value::is_null) {
        item.push(("userRating", Cell::Null));
    } else {
        number(
            &mut item,
            "userRating",
            coalesce(&[raw.get("user_rating"), raw.get("rating")]),
        );
    }
    let added = to_date(coalesce(&[
        raw.get("added_to_list_at"),
        raw.get("added_to_watchlist_at"),
        raw.get("added_at"),
    ]));
    if let Some(ms) = added {
        item.push(("addedAt", Cell::Date(ms)));
    }
    if let Some(ms) = to_date(coalesce(&[
        raw.get("last_watched_at"),
        raw.get("last_watched"),
    ])) {
        item.push(("lastWatchedAt", Cell::Date(ms)));
    }
    number(
        &mut item,
        "watchedEpisodeCount",
        raw.get("watched_episodes_count"),
    );
    number(
        &mut item,
        "totalEpisodeCount",
        raw.get("total_episodes_count"),
    );
    if episodes && !movie {
        let pairs: Vec<Value> = episode_coordinates(raw)
            .into_iter()
            .map(|(season, episode)| Value::from(vec![season, episode]))
            .collect();
        item.push((
            "watchedEpisodes",
            Cell::Text(Value::Array(pairs).to_string()),
        ));
    }
    Some(item)
}

/// A cell as SQL and its bind (placeholder `n`).
fn cell_sql(db: &Db, cell: &Cell, n: usize, binds: &mut Vec<Bind>) -> String {
    match cell {
        Cell::Null => String::from("NULL"),
        Cell::Text(text) => {
            binds.push(Bind::Text(text.clone()));
            format!("?{n}")
        }
        Cell::Number(value) => {
            if let Some(int) = whole(*value) {
                binds.push(Bind::Int(int));
                return format!("?{n}");
            }
            binds.push(Bind::Text(crate::jsnum::to_string(*value)));
            if db.is_postgres() {
                format!("CAST(?{n} AS double precision)")
            } else {
                format!("CAST(?{n} AS REAL)")
            }
        }
        Cell::Date(ms) => {
            binds.push(date_bind(db, *ms));
            date_param(db, n)
        }
    }
}

/// The transaction's writes (`dataSource.transaction`): each item saved over its existing row, the
/// rows Simkl no longer lists removed, and the sync state.
async fn write(
    db: &Db,
    user_id: i64,
    items: &[Item],
    upstream: Option<&HashSet<String>>,
    previous: Option<&Previous>,
    snapshot: &str,
    now: i64,
) -> anyhow::Result<()> {
    let mut tx = Tx::begin(db).await?;
    for item in items {
        save_item(db, &mut tx, user_id, item).await?;
    }
    if let Some(upstream) = upstream {
        let rows = tx
            .rows(
                r#"SELECT CAST("id" AS BIGINT) AS "id", "simklType", "simklId"
                   FROM "simkl_sync_item" WHERE "userId" = ?1"#,
                &[Bind::Int(user_id)],
            )
            .await?;
        for row in rows {
            let key = format!(
                "{}:{}",
                row.get("simklType").and_then(Value::as_str).unwrap_or(""),
                row.get("simklId").and_then(Value::as_str).unwrap_or("")
            );
            if upstream.contains(&key) {
                continue;
            }
            if let Some(id) = row.get("id").and_then(Value::as_i64) {
                tx.execute(
                    r#"DELETE FROM "simkl_sync_item" WHERE "id" = ?1"#,
                    &[Bind::Int(id)],
                )
                .await?;
            }
        }
    }
    let stamp = date_bind(db, now);
    if let Some(previous) = previous {
        let sql = format!(
            r#"UPDATE "simkl_sync_state" SET "activities" = ?1, "initialSyncComplete" = TRUE,
               "lastCheckedAt" = {}, "lastSuccessfulSyncAt" = {} WHERE "id" = ?4"#,
            date_param(db, 2),
            date_param(db, 3)
        );
        tx.execute(
            &sql,
            &[
                Bind::Text(snapshot.to_owned()),
                stamp.clone(),
                stamp,
                Bind::Int(previous.id),
            ],
        )
        .await?;
    } else {
        let sql = format!(
            r#"INSERT INTO "simkl_sync_state"
               ("activities", "initialSyncComplete", "lastCheckedAt", "lastSuccessfulSyncAt", "userId")
               VALUES (?1, TRUE, {}, {}, ?4)"#,
            date_param(db, 2),
            date_param(db, 3)
        );
        tx.execute(
            &sql,
            &[
                Bind::Text(snapshot.to_owned()),
                stamp.clone(),
                stamp,
                Bind::Int(user_id),
            ],
        )
        .await?;
    }
    tx.commit().await
}

/// `itemRepository.save(create({ ...existing, ...item, user }))`.
async fn save_item(db: &Db, tx: &mut Tx, user_id: i64, item: &Item) -> anyhow::Result<()> {
    let text = |column: &str| item_text(item, column);
    let existing = tx
        .rows(
            r#"SELECT CAST("id" AS BIGINT) AS "id" FROM "simkl_sync_item"
               WHERE "userId" = ?1 AND "simklType" = ?2 AND "simklId" = ?3 LIMIT 1"#,
            &[
                Bind::Int(user_id),
                Bind::Text(text("simklType").unwrap_or_default()),
                Bind::Text(text("simklId").unwrap_or_default()),
            ],
        )
        .await?
        .into_iter()
        .next()
        .and_then(|row| row.get("id").and_then(Value::as_i64));
    let mut binds = Vec::with_capacity(item.len() + 1);
    let mut parts = Vec::with_capacity(item.len());
    for (column, cell) in item {
        let n = binds.len() + 1;
        let sql = cell_sql(db, cell, n, &mut binds);
        parts.push((*column, sql));
    }
    binds.push(Bind::Int(existing.unwrap_or(user_id)));
    let last = binds.len();
    let sql = if existing.is_some() {
        let sets: Vec<String> = parts
            .iter()
            .map(|(c, v)| format!("\"{c}\" = {v}"))
            .collect();
        format!(
            "UPDATE \"simkl_sync_item\" SET {} WHERE \"id\" = ?{last}",
            sets.join(", ")
        )
    } else {
        let columns: Vec<String> = parts.iter().map(|(c, _)| format!("\"{c}\"")).collect();
        let values: Vec<&str> = parts.iter().map(|(_, v)| v.as_str()).collect();
        format!(
            "INSERT INTO \"simkl_sync_item\" ({}, \"userId\") VALUES ({}, ?{last})",
            columns.join(", "),
            values.join(", ")
        )
    };
    tx.execute(&sql, &binds).await?;
    Ok(())
}

#[cfg(test)]
mod tests;
