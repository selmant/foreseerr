//! The Tautulli part of `GET /user/:id/watch_data`
//! (`server/routes/user/index.ts`, `server/api/tautulli.ts`): the user's
//! play count and the media of their 20 most recent distinct plays, in
//! play order. Every failure inside the handler's `try` is
//! `Failed to fetch user watch data.`.

use serde_json::{Map, Value};

use super::{Outcome, Ready};
use crate::db::Bind;
use crate::downloads::Downloads;
use crate::media::{js_string, media_json, tracks_downloads};
use crate::settings::public::truthy;

/// What the handler's `catch` sends.
const FAILED: &str = "Failed to fetch user watch data.";
/// `getUserWatchHistory`'s page size.
const TAKE: i64 = 100;
/// More pages than any Tautulli history has; Node would keep asking.
const MAX_PAGES: i64 = 10_000;

/// Why the lookups stopped: Node's 500, or a case not reproduced.
enum Stop {
    Failed(String),
    Unported(String),
}

/// After the "not configured" check: the lookups and the answer.
pub(super) async fn answer(ctx: &Ready<'_>, id: i64) -> Outcome {
    match lookups(ctx, id).await {
        Ok(body) => ctx.json(&body),
        Err(Stop::Failed(why)) => {
            tracing::error!("Something went wrong fetching user watch data: {why}");
            ctx.error(500, FAILED)
        }
        Err(Stop::Unported(why)) => Outcome::forward(why),
    }
}

async fn lookups(ctx: &Ready<'_>, id: i64) -> Result<Value, Stop> {
    let db = &ctx.state.db;
    let rows = db
        .rows(
            r#"SELECT "plexId" FROM "user" WHERE "id" = ?1"#,
            &[Bind::Int(id)],
        )
        .await
        .map_err(|e| Stop::Unported(format!("database: {e:#}")))?;
    let Some(row) = rows.first() else {
        return Err(Stop::Failed(String::from("findOneOrFail found no user")));
    };
    let plex_id = match row.get("plexId") {
        Some(Value::Number(n)) if n.as_i64().is_some_and(|n| n != 0) => n.to_string(),
        _ => {
            return Err(Stop::Failed(String::from(
                "User does not have an associated Plex ID",
            )))
        }
    };
    let stats = tautulli(
        ctx,
        &[
            ("cmd", "get_user_watch_time_stats"),
            ("user_id", &plex_id),
            ("query_days", "0"),
            ("grouping", "1"),
        ],
    )
    .await?;
    // `.data.response.data[0]`.
    let stats = match stats.pointer("/response/data") {
        Some(Value::Array(list)) => list.first().cloned(),
        Some(Value::String(text)) => text.chars().next().map(|c| Value::String(c.to_string())),
        Some(Value::Object(_) | Value::Bool(_) | Value::Number(_)) => None,
        Some(Value::Null) | None => {
            return Err(Stop::Failed(String::from("no response.data")));
        }
    };
    let history = history(ctx, &plex_id).await?;
    let recently = recently_watched(ctx, &history).await?;
    // `watchStats.total_plays`: undefined drops the key, a missing
    // `watchStats` throws.
    let total = match &stats {
        Some(Value::Null) | None => {
            return Err(Stop::Failed(String::from("no watch stats")));
        }
        Some(Value::Object(o)) => o.get("total_plays").cloned(),
        Some(_) => None,
    };
    let mut out = Map::new();
    out.insert(String::from("recentlyWatched"), Value::Array(recently));
    if let Some(total) = total {
        out.insert(String::from("playCount"), total);
    }
    Ok(Value::Object(out))
}

/// `this.axios.get('/api/v2', { params })` on the instance with
/// `params: { apikey }`: the answer's JSON (numbers as JavaScript holds
/// them).
async fn tautulli(ctx: &Ready<'_>, params: &[(&str, &str)]) -> Result<Value, Stop> {
    let setting = |k: &str| js_string(ctx.settings.get(&format!("/tautulli/{k}"))).into_owned();
    let base = match ctx.settings.get("/tautulli/urlBase") {
        None | Some(Value::Null) => String::new(),
        other => js_string(other).into_owned(),
    };
    let scheme = if truthy(ctx.settings.get("/tautulli/useSsl")) {
        "https"
    } else {
        "http"
    };
    let mut url = format!(
        "{scheme}://{}:{}{base}/api/v2",
        setting("hostname"),
        setting("port")
    );
    let mut all: Vec<(&str, String)> = Vec::new();
    match ctx.settings.get("/tautulli/apiKey") {
        None | Some(Value::Null) => {}
        other => all.push(("apikey", js_string(other).into_owned())),
    }
    all.extend(params.iter().map(|(k, v)| (*k, (*v).to_owned())));
    for (i, (k, v)) in all.iter().enumerate() {
        url.push(if i == 0 { '?' } else { '&' });
        url.push_str(k);
        url.push('=');
        url.push_str(&crate::tmdb::axios_encode(v));
    }
    let response = ctx
        .state
        .outbound
        .get(&url)
        .header(reqwest::header::ACCEPT, "application/json, text/plain, */*")
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| Stop::Failed(crate::outbound::describe(&e)))?;
    let bytes = response
        .bytes()
        .await
        .map_err(|e| Stop::Failed(crate::outbound::describe(&e)))?;
    // axios hands back text that isn't JSON; reading `.response` off a
    // string gives undefined, and the next read throws.
    Ok(serde_json::from_slice::<Value>(&bytes).map_or(Value::Null, crate::tmdb::js_numbers))
}

/// `getUserWatchHistory`: pages of 100 until 20 distinct plays (by show,
/// then season, then item) or an empty page.
async fn history(ctx: &Ready<'_>, plex_id: &str) -> Result<Vec<Value>, Stop> {
    let mut results: Vec<Value> = Vec::new();
    let mut start = 0_i64;
    for _ in 0..MAX_PAGES {
        if results.len() >= 20 {
            results.truncate(20);
            return Ok(results);
        }
        let start_text = start.to_string();
        let take_text = TAKE.to_string();
        let page = tautulli(
            ctx,
            &[
                ("cmd", "get_history"),
                ("grouping", "1"),
                ("order_column", "date"),
                ("order_dir", "desc"),
                ("user_id", plex_id),
                ("media_type", "movie,episode"),
                ("length", &take_text),
                ("start", &start_text),
            ],
        )
        .await?;
        let data = match page.pointer("/response/data") {
            Some(Value::Null) | None => {
                return Err(Stop::Failed(String::from("no response.data")));
            }
            Some(data) => data.get("data"),
        };
        let records = match data {
            Some(Value::Array(records)) => records,
            Some(Value::Null) | None => {
                return Err(Stop::Failed(String::from("no response.data.data")));
            }
            // `!tautulliData.length` holds for anything without a length.
            Some(Value::Object(_) | Value::Bool(_) | Value::Number(_)) => return Ok(results),
            Some(Value::String(_)) => {
                return Err(Stop::Unported(String::from(
                    "a Tautulli history that is a string",
                )))
            }
        };
        if records.is_empty() {
            return Ok(results);
        }
        if records.iter().any(Value::is_null) {
            return Err(Stop::Failed(String::from("a null history record")));
        }
        if records.iter().any(|r| !r.is_object()) {
            return Err(Stop::Unported(String::from(
                "a history record that isn't an object",
            )));
        }
        for record in records {
            if !results.iter().any(|kept| same_play(record, kept)) {
                results.push(record.clone());
            }
        }
        start += TAKE;
    }
    Err(Stop::Unported(String::from(
        "a Tautulli history that never ends",
    )))
}

/// `uniqWith`'s comparator.
fn same_play(a: &Value, b: &Value) -> bool {
    let key = |r: &Value, k: &str| r.get(k).cloned().unwrap_or(Value::Null);
    for k in ["grandparent_rating_key", "parent_rating_key"] {
        let (x, y) = (key(a, k), key(b, k));
        if truthy(Some(&x)) && truthy(Some(&y)) {
            return strict_eq(&x, &y);
        }
    }
    strict_eq(&key(a, "rating_key"), &key(b, "rating_key"))
}

/// `===` on JSON values (objects and arrays are never the same object).
fn strict_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(_) | Value::Object(_), _) | (_, Value::Array(_) | Value::Object(_)) => false,
        _ => a == b,
    }
}

/// The rating keys of the plays of one kind.
fn keys(history: &[Value], media_type: &str, field: &str) -> Vec<Value> {
    history
        .iter()
        .filter(|r| r.get("media_type").and_then(Value::as_str) == Some(media_type))
        .map(|r| r.get(field).cloned().unwrap_or(Value::Null))
        .collect()
}

/// A rating key as a query parameter, or why it can't be bound as Node
/// binds it.
fn bind(key: &Value) -> Result<Bind, Stop> {
    match key {
        Value::Number(n) => n
            .as_i64()
            .map(Bind::Int)
            .ok_or_else(|| Stop::Unported(String::from("a fractional rating key"))),
        Value::String(s) => Ok(Bind::Text(s.clone())),
        Value::Null | Value::Bool(_) | Value::Array(_) | Value::Object(_) => Err(Stop::Unported(
            String::from("a rating key that isn't a number"),
        )),
    }
}

/// The media `find` with the four `In(...)` conditions (`0=1` for an empty
/// list), sorted by the first play each matches.
async fn recently_watched(ctx: &Ready<'_>, history: &[Value]) -> Result<Vec<Value>, Stop> {
    let movies = keys(history, "movie", "rating_key");
    let shows = keys(history, "episode", "grandparent_rating_key");
    let mut binds = Vec::new();
    let mut conditions = Vec::new();
    for (media_type, column, list) in [
        ("movie", "ratingKey", &movies),
        ("movie", "ratingKey4k", &movies),
        ("tv", "ratingKey", &shows),
        ("tv", "ratingKey4k", &shows),
    ] {
        binds.push(Bind::Text(media_type.to_owned()));
        let type_param = binds.len();
        let mut params = Vec::new();
        for key in list {
            binds.push(bind(key)?);
            params.push(format!("?{}", binds.len()));
        }
        let within = if params.is_empty() {
            String::from("0=1")
        } else {
            format!(r#""media"."{column}" IN ({})"#, params.join(", "))
        };
        conditions.push(format!(
            r#"("media"."mediaType" = ?{type_param} AND {within})"#
        ));
    }
    let sql = format!(
        r#"SELECT CAST("media"."id" AS BIGINT) AS "id" FROM "media" "media" WHERE {} ORDER BY "media"."id" ASC"#,
        conditions.join(" OR ")
    );
    let db = &ctx.state.db;
    let ids: Vec<i64> = db
        .rows(&sql, &binds)
        .await
        .map_err(|e| Stop::Failed(format!("database: {e:#}")))?
        .iter()
        .filter_map(|r| r.get("id").and_then(Value::as_i64))
        .collect();
    let mut rows = db
        .media_by_ids(&ids, true)
        .await
        .map_err(|e| Stop::Unported(format!("database: {e:#}")))?;
    rows.sort_by_key(|m| ids.iter().position(|id| *id == m.id));
    let downloads = if rows.iter().any(tracks_downloads) {
        Downloads::current()
    } else {
        Downloads::default()
    };
    // `sortBy` is stable: ties keep the database order.
    rows.sort_by_key(|m| first_play(history, m.rating_key.as_deref(), m.rating_key4k.as_deref()));
    Ok(rows
        .iter()
        .map(|row| media_json(row, &ctx.settings, &downloads, true))
        .collect())
}

/// `findIndex(watchHistory, ...)`: the first play whose key equals
/// `parseInt` of either rating key (`-1` for none).
fn first_play(history: &[Value], key: Option<&str>, key4k: Option<&str>) -> i64 {
    let parsed = |k: Option<&str>| k.filter(|k| !k.is_empty()).and_then(parse_int);
    let (a, b) = (parsed(key), parsed(key4k));
    history
        .iter()
        .position(|record| {
            let field = if record.get("media_type").and_then(Value::as_str) == Some("movie") {
                "rating_key"
            } else {
                "grandparent_rating_key"
            };
            let played = record.get(field).and_then(Value::as_f64);
            a.iter()
                .chain(b.iter())
                .any(|n| played.is_some_and(|p| p.to_bits() == n.to_bits()))
        })
        .and_then(|i| i64::try_from(i).ok())
        .unwrap_or(-1)
}

/// `parseInt(text)` for the leading decimal digits (`None` for `NaN`).
fn parse_int(text: &str) -> Option<f64> {
    let t = super::nodestate::js_trim(text);
    let (negative, digits) = t
        .strip_prefix('-')
        .map_or_else(|| (false, t.strip_prefix('+').unwrap_or(t)), |d| (true, d));
    let end = digits
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(digits.len());
    let n: f64 = digits.get(..end).filter(|d| !d.is_empty())?.parse().ok()?;
    Some(if negative { -n } else { n })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{first_play, parse_int, same_play};

    #[test]
    fn dedupes_like_uniq_with() {
        let a = json!({"grandparent_rating_key": 5, "rating_key": 1});
        let b = json!({"grandparent_rating_key": 5, "rating_key": 2});
        let c = json!({"grandparent_rating_key": "", "parent_rating_key": "", "rating_key": 2});
        assert!(same_play(&a, &b), "same show");
        assert!(!same_play(&a, &c), "falls through to the item");
        assert!(same_play(&c, &json!({"rating_key": 2})), "same item");
    }

    #[test]
    fn finds_the_first_play() {
        let history = [
            json!({"media_type": "episode", "grandparent_rating_key": 7}),
            json!({"media_type": "movie", "rating_key": 9}),
        ];
        assert_eq!(first_play(&history, Some("9"), None), 1, "movie");
        assert_eq!(first_play(&history, None, Some("7x")), 0, "parseInt");
        assert_eq!(first_play(&history, Some("3"), None), -1, "none");
        assert_eq!(parse_int(" 12ab"), Some(12.0), "leading digits");
        assert_eq!(parse_int("ab"), None, "NaN");
    }
}
