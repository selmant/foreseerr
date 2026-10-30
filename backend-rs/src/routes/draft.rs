//! What the write routes of requests, issues, the watchlist and the
//! blocklist share: entities as `TypeORM` leaves them after an insert, the
//! signed-in user as Node prints `req.user`, and body readers.
//!
//! A freshly built entity prints in the order its keys were assigned: the
//! class field initialisers, then the constructor's `Object.assign`. After
//! the insert `TypeORM` sets every nullable column that is still
//! `undefined` to `null` (column order), then merges the generated and
//! defaulted columns it read back (column order); keys that already exist
//! keep their place.

use serde_json::{Map, Value};

use super::Ready;
use crate::db::MediaRow;
use crate::downloads::Downloads;
use crate::lifecycle::UserRel;
use crate::user::filtered_json;

/// `Outcome::Forward` on an `Err`.
macro_rules! forward_on_err {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(why) => return super::Outcome::forward(why),
        }
    };
}
pub(super) use forward_on_err;

/// A 500 `{ message }` on an `Err` once something has been written:
/// forwarding then would write it again.
macro_rules! fail_on_err {
    ($ctx:expr, $e:expr) => {
        match $e {
            Ok(v) => v,
            Err(why) => {
                tracing::error!("{why}");
                return $ctx.error(500, &why);
            }
        }
    };
}
pub(super) use fail_on_err;

/// An entity being built: keys in assignment order, `None` for a key
/// assigned `undefined` (it keeps its place but doesn't print).
#[derive(Debug, Clone, Default)]
pub(super) struct Draft(Vec<(String, Option<Value>)>);

/// A column: name, nullable, read back after an insert (generated or
/// defaulted).
pub(super) type Column = (&'static str, bool, bool);

/// `Media`'s columns in declaration order.
pub(super) const MEDIA_COLUMNS: [Column; 21] = [
    ("id", false, true),
    ("mediaType", false, false),
    ("tmdbId", false, false),
    ("tvdbId", true, false),
    ("imdbId", true, false),
    ("status", false, true),
    ("status4k", false, true),
    ("createdAt", false, true),
    ("updatedAt", false, true),
    ("lastSeasonChange", false, true),
    ("mediaAddedAt", true, true),
    ("serviceId", true, false),
    ("serviceId4k", true, false),
    ("externalServiceId", true, false),
    ("externalServiceId4k", true, false),
    ("externalServiceSlug", true, false),
    ("externalServiceSlug4k", true, false),
    ("ratingKey", true, false),
    ("ratingKey4k", true, false),
    ("jellyfinMediaId", true, false),
    ("jellyfinMediaId4k", true, false),
];

impl Draft {
    /// Assign a key: in place when it exists, appended otherwise.
    pub(super) fn set(&mut self, key: &str, value: Option<Value>) {
        if let Some(slot) = self.0.iter_mut().find(|(k, _)| k == key) {
            slot.1 = value;
        } else {
            self.0.push((key.to_owned(), value));
        }
    }

    /// Assign a defined value.
    pub(super) fn put(&mut self, key: &str, value: Value) {
        self.set(key, Some(value));
    }

    fn defined(&self, key: &str) -> bool {
        self.0.iter().any(|(k, v)| k == key && v.is_some())
    }

    /// What `TypeORM` does to the entity after inserting its row: nullable
    /// columns still `undefined` become their (null) value, then the
    /// columns it reads back are merged in. `row` holds the stored values.
    pub(super) fn after_insert(&mut self, columns: &[Column], row: &Map<String, Value>) {
        let value = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
        for (key, nullable, _) in columns {
            if *nullable && !self.defined(key) {
                self.put(key, value(key));
            }
        }
        for (key, _, read_back) in columns {
            if *read_back {
                self.put(key, value(key));
            }
        }
    }

    /// The JSON `res.json` prints: `undefined` keys left out.
    pub(super) fn json(&self) -> Value {
        Value::Object(
            self.0
                .iter()
                .filter_map(|(k, v)| v.clone().map(|v| (k.clone(), v)))
                .collect(),
        )
    }
}

impl From<Map<String, Value>> for Draft {
    fn from(map: Map<String, Value>) -> Self {
        Self(map.into_iter().map(|(k, v)| (k, Some(v))).collect())
    }
}

/// A media row that was just inserted, as the entity built with `init`
/// (keys in constructor order) prints after the insert: the download
/// initialisers first, no `@AfterLoad` fields.
pub(super) fn inserted_media_json(
    row: &MediaRow,
    settings: &crate::settings::Settings,
    init: &[&str],
) -> Value {
    let Value::Object(stored) =
        crate::media::media_json(row, settings, &Downloads::default(), false)
    else {
        return Value::Null;
    };
    let mut draft = Draft::default();
    draft.put("downloadStatus", Value::Array(Vec::new()));
    draft.put("downloadStatus4k", Value::Array(Vec::new()));
    for key in init {
        draft.put(key, stored.get(*key).cloned().unwrap_or(Value::Null));
    }
    draft.after_insert(&MEDIA_COLUMNS, &stored);
    draft.json()
}

/// A user relation (or `req.user`) as loaded with its eager settings.
pub(super) fn user_json(rel: &UserRel) -> Result<Value, String> {
    filtered_json(&rel.0, Some(rel.1.as_ref()), true).map_err(str::to_owned)
}

/// `req.user`: the signed-in user with its settings, loaded now (as
/// `checkUser` did when the request came in).
pub(super) async fn current_user(ctx: &Ready<'_>, id: i64) -> Result<UserRel, String> {
    match ctx.state.db.user_record(id).await {
        Ok(Some(rel)) => Ok(rel),
        Ok(None) => Err(String::from("the signed-in user vanished")),
        Err(e) => Err(format!("loading the user failed: {e:#}")),
    }
}

/// The body as an object.
pub(super) fn body_object<'a>(ctx: &'a Ready<'_>) -> Result<&'a Map<String, Value>, String> {
    match &ctx.body {
        Some(Value::Object(map)) => Ok(map),
        _ => Err(String::from("a body that isn't an object")),
    }
}

/// Every key of the body is one of these; others are Node's to judge.
pub(super) fn known_keys(body: &Map<String, Value>, keys: &[&str]) -> Result<(), String> {
    body.keys()
        .find(|k| !keys.contains(&k.as_str()))
        .map_or(Ok(()), |key| Err(format!("an unexpected body key {key}")))
}

/// An optional text field.
pub(super) fn opt_text(body: &Map<String, Value>, key: &str) -> Result<Option<String>, String> {
    match body.get(key) {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(format!("{key} isn't text")),
    }
}

/// `mediaType`: `movie` or `tv`.
pub(super) fn media_type(value: Option<&Value>) -> Result<&'static str, String> {
    match value.and_then(Value::as_str) {
        Some("movie") => Ok("movie"),
        Some("tv") => Ok("tv"),
        _ => Err(String::from("mediaType isn't movie or tv")),
    }
}

/// The query of a route that takes exactly `mediaType=movie|tv`.
pub(super) fn media_type_query(ctx: &Ready<'_>) -> Result<&'static str, String> {
    if let Some(validated) = ctx.validated() {
        if validated.query.len() == 1 {
            match validated.query.get("mediaType").and_then(Value::as_str) {
                Some("movie") => return Ok("movie"),
                Some("tv") => return Ok("tv"),
                _ => {}
            }
        }
    }
    match ctx.req.uri.query().unwrap_or("") {
        "mediaType=movie" => Ok("movie"),
        "mediaType=tv" => Ok("tv"),
        _ => Err(String::from("the query is the validator's")),
    }
}

/// The 404 message for a missing row.
pub(super) fn not_found(entity: &str) -> String {
    format!("{entity} not found.")
}

/// The TMDB id in the last path segment, bound for a query.
pub(super) fn tmdb_path_key(ctx: &Ready<'_>) -> Result<crate::db::Bind, super::Fallback> {
    super::params::path_int(ctx, 0).map(crate::db::Bind::Int)
}

/// The download tracker, when a media row needs it.
pub(super) fn downloads_for(media: &[&MediaRow]) -> Downloads {
    if media.iter().any(|m| crate::media::tracks_downloads(m)) {
        Downloads::current()
    } else {
        Downloads::default()
    }
}

/// The `RETURNING` clause that gives an inserted id on both databases.
pub(super) const RETURNING_ID: &str = r#" RETURNING CAST("id" AS BIGINT)"#;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn draft_order() {
        let mut d = Draft::default();
        d.put("tmdbId", json!(5));
        d.set("tvdbId", None);
        d.put("mediaType", json!("movie"));
        let Value::Object(row) = json!({"id": 9, "tvdbId": null, "imdbId": null, "status": 1, "status4k": 1,
            "createdAt": "c", "updatedAt": "u", "lastSeasonChange": "l", "mediaAddedAt": "m"})
        else {
            return;
        };
        let cols: [Column; 9] = [
            ("id", false, true),
            ("mediaType", false, false),
            ("tmdbId", false, false),
            ("tvdbId", true, false),
            ("imdbId", true, false),
            ("status", false, true),
            ("createdAt", false, true),
            ("lastSeasonChange", false, true),
            ("mediaAddedAt", true, true),
        ];
        d.after_insert(&cols, &row);
        let keys: Vec<String> = match d.json() {
            Value::Object(m) => m.keys().cloned().collect(),
            Value::Null
            | Value::Bool(_)
            | Value::Number(_)
            | Value::String(_)
            | Value::Array(_) => Vec::new(),
        };
        assert_eq!(
            keys,
            [
                "tmdbId",
                "tvdbId",
                "mediaType",
                "imdbId",
                "mediaAddedAt",
                "id",
                "status",
                "createdAt",
                "lastSeasonChange"
            ],
            "nullable first, then read back"
        );
        assert_eq!(not_found("Blocklist"), "Blocklist not found.", "message");
    }
}
