//! What the `/discover` routes share.
//!
//! The query as Node's handlers see it (after the `OpenAPI` validator
//! coerced it and filled in its defaults, and after the router applied the
//! user's saved filter defaults), the error
//! shape with `Retry-After`, `annotateProviderActiveRequests`, the
//! unmapped-tile helpers, and the calls into Node's mapping layer, whose
//! caches, dataset generations and miss buffer live in the Node process.

use std::collections::HashMap;

use axum::http::HeaderValue;
use serde_json::{Map, Value};

use super::{Outcome, Ready};
use crate::db::Bind;
use crate::settings::public::truthy;

/// How the validator coerces one query parameter.
#[derive(Debug, Clone, Copy)]
pub(super) enum Kind {
    /// `type: string`: kept as it is.
    Str,
    /// `type: number`: only canonical decimal spellings are answered here,
    /// so `String(n)` gives the text back.
    Num,
    /// `type: number` with an integer meaning (`page`): digits only.
    Int,
    /// `type: boolean`: `true` or `false`.
    Bool,
    /// `type: string` with an `enum`.
    Enum(&'static [&'static str]),
}

/// One declared parameter: name and kind.
pub(super) type Param = (&'static str, Kind);

/// The parameters every TMDB discover list and most provider rows declare
/// through `components/parameters`.
pub(super) const FLAG_PARAMS: [Param; 5] = [
    ("ignoreWatched", Kind::Bool),
    ("ignoreDiscoverDefaults", Kind::Bool),
    ("hideUnmapped", Kind::Bool),
    ("ignoreCollected", Kind::Bool),
    ("ignoreWatchlisted", Kind::Bool),
];

/// The external-rating browse filters (`DiscoverImdbRatingGte` ...
/// `DiscoverIncludeNoRating`); `includeNoRating` defaults to `true`.
pub(super) const RATING_PARAMS: [Param; 13] = [
    ("imdbRatingGte", Kind::Num),
    ("imdbRatingLte", Kind::Num),
    ("imdbVotesGte", Kind::Num),
    ("imdbVotesLte", Kind::Num),
    ("rtCriticsGte", Kind::Num),
    ("rtCriticsLte", Kind::Num),
    ("rtAudienceGte", Kind::Num),
    ("rtAudienceLte", Kind::Num),
    ("metacriticGte", Kind::Num),
    ("metacriticLte", Kind::Num),
    ("traktRatingGte", Kind::Num),
    ("traktRatingLte", Kind::Num),
    ("includeNoRating", Kind::Bool),
];

/// `req.query` as a handler reads it.
#[derive(Debug, Clone, Default, PartialEq)]
pub(super) struct Query(Map<String, Value>);

impl Query {
    /// Parse a raw query string against the route's declared parameters, as
    /// the validator would accept and coerce it, then add the spec's
    /// defaults for absent keys. Anything the validator might reject or
    /// reshape in a way not reproduced here (unknown or repeated keys, empty
    /// values, unencoded reserved characters, non-canonical numbers, values
    /// outside an enum) is Node's.
    pub(super) fn parse(
        raw: Option<&str>,
        params: &[&[Param]],
        defaults: &[(&str, Value)],
    ) -> Result<Self, String> {
        let mut map = Map::new();
        for pair in raw.unwrap_or("").split('&').filter(|p| !p.is_empty()) {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            let kind = params
                .iter()
                .flat_map(|group| group.iter())
                .find(|(name, _)| *name == key)
                .map(|(_, kind)| *kind)
                .ok_or_else(|| format!("{key} isn't a declared query parameter"))?;
            if map.contains_key(key) {
                return Err(String::from("a repeated query key"));
            }
            let value = super::user::decode_query_value(value)
                .ok_or_else(|| String::from("a reserved or malformed character in the query"))?;
            if value.is_empty() {
                return Err(String::from(
                    "an empty query value; the validator answers 400",
                ));
            }
            map.insert(key.to_owned(), coerce(kind, &value)?);
        }
        for (key, value) in defaults {
            if !map.contains_key(*key) {
                map.insert((*key).to_owned(), value.clone());
            }
        }
        Ok(Self(map))
    }

    /// `req.query` as the `OpenAPI` validator left it (its coercion and
    /// defaults), when it ran; otherwise [`Query::parse`]. Keys the client
    /// sent must still be parameters this route implements (spec defaults
    /// for others are dropped, as `parse` never had them). A `page` that
    /// isn't a whole number is a 400.
    pub(super) fn of(
        ctx: &Ready<'_>,
        params: &[&[Param]],
        defaults: &[(&str, Value)],
    ) -> Result<Self, super::Fallback> {
        let query = Self::read(ctx, params, defaults)?;
        super::params::int(query.get("page"), "page")?;
        Ok(query)
    }

    fn read(
        ctx: &Ready<'_>,
        params: &[&[Param]],
        defaults: &[(&str, Value)],
    ) -> Result<Self, String> {
        let Some(validated) = super::params::query(ctx) else {
            return Self::parse(ctx.req.uri.query(), params, defaults);
        };
        let sent = crate::openapi::request::parse_query(ctx.req.uri.query().unwrap_or(""));
        let mut map = Map::new();
        for (key, value) in validated {
            let declared = params
                .iter()
                .flat_map(|group| group.iter())
                .any(|(name, _)| *name == key);
            if !declared {
                if sent
                    .keys()
                    .any(|k| *k == key || k.starts_with(&format!("{key}[")))
                {
                    return Err(format!("{key} isn't a parameter this route implements"));
                }
                // A spec default the route doesn't read, as before.
                continue;
            }
            // A whole float (`1e3` coerced) is the integer JavaScript holds.
            map.insert(key, crate::tmdb::js_numbers(value));
        }
        for (key, value) in defaults {
            if !map.contains_key(*key) {
                map.insert((*key).to_owned(), value.clone());
            }
        }
        Ok(Self(map))
    }

    /// A query from parts, for tests and for routes that build one.
    #[cfg(test)]
    pub(super) const fn from_map(map: Map<String, Value>) -> Self {
        Self(map)
    }

    /// `req.query[key]`.
    pub(super) fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(key)
    }

    /// Whether the key is present.
    pub(super) fn has(&self, key: &str) -> bool {
        self.0.contains_key(key)
    }

    /// `parseDiscoverTruthyQuery(req.query[key])`.
    pub(super) fn truthy(&self, key: &str) -> bool {
        matches!(self.0.get(key), Some(Value::Bool(true)))
            || matches!(self.0.get(key), Some(Value::String(s)) if s == "true" || s == "1")
    }

    /// `String(req.query[key] ?? '')`.
    pub(super) fn text(&self, key: &str) -> String {
        match self.0.get(key) {
            None | Some(Value::Null) => String::new(),
            v @ Some(_) => crate::media::js_string(v).into_owned(),
        }
    }

    /// `req.query[key]` when it is a string (the `typeof === 'string'`
    /// checks).
    pub(super) fn str(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(Value::as_str)
    }

    /// `req.query.page ? Number(req.query.page) : 1` ([`Query::of`]
    /// already refused a page that isn't a whole number).
    pub(super) fn page_number(&self) -> i64 {
        super::params::int_or(self.0.get("page"), "page", 1).unwrap_or(1)
    }

    /// The router's `applyDiscoverFilterDefaultsToQuery` step: unless
    /// `ignoreDiscoverDefaults` is truthy, the user's saved defaults fill
    /// keys the query (validator defaults included) doesn't have.
    pub(super) fn with_filter_defaults(mut self, stored: Option<&str>) -> Self {
        if self.truthy("ignoreDiscoverDefaults") {
            return self;
        }
        let defaults = parse_filter_defaults(stored);
        for key in BOOLEAN_DEFAULT_KEYS {
            if self.0.contains_key(key) {
                continue;
            }
            if let Some(Value::Bool(b)) = defaults.get(key) {
                self.0.insert(
                    key.to_owned(),
                    Value::from(if *b { "true" } else { "false" }),
                );
            }
        }
        for key in STRING_DEFAULT_KEYS {
            if self.0.contains_key(key) {
                continue;
            }
            if let Some(Value::String(s)) = defaults.get(key) {
                if !s.is_empty() {
                    self.0.insert(key.to_owned(), Value::from(s.as_str()));
                }
            }
        }
        self
    }
}

/// One value as the validator coerces it.
fn coerce(kind: Kind, value: &str) -> Result<Value, String> {
    match kind {
        Kind::Str => Ok(Value::from(value)),
        Kind::Bool => match value {
            "true" => Ok(Value::Bool(true)),
            "false" => Ok(Value::Bool(false)),
            _ => Err(String::from("a boolean the validator rejects")),
        },
        Kind::Int => super::blocklist::plain_integer(value)
            .map(Value::from)
            .ok_or_else(|| String::from("a number that isn't a plain integer")),
        Kind::Num => canonical_number(value).ok_or_else(|| String::from("an unsupported number")),
        Kind::Enum(allowed) => {
            if allowed.contains(&value) {
                Ok(Value::from(value))
            } else {
                Err(String::from("a value outside the enum"))
            }
        }
    }
}

/// A decimal written the way JavaScript prints the number back (no
/// leading zeros, no trailing fractional zeros, no exponent, few enough
/// digits to round-trip), as a JSON number.
fn canonical_number(text: &str) -> Option<Value> {
    let unsigned = text.strip_prefix('-').unwrap_or(text);
    let (int, frac) = unsigned
        .split_once('.')
        .map_or((unsigned, None), |(i, f)| (i, Some(f)));
    let digits_ok = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !digits_ok(int) || (int.len() > 1 && int.starts_with('0')) {
        return None;
    }
    if int.len() + frac.map_or(0, str::len) > 15 || text == "-0" {
        return None;
    }
    match frac {
        None => text.parse::<i64>().ok().map(Value::from),
        Some(f) if digits_ok(f) && !f.ends_with('0') => text
            .parse::<f64>()
            .ok()
            .and_then(serde_json::Number::from_f64)
            .map(Value::Number),
        Some(_) => None,
    }
}

/// `DiscoverFilterDefaultsSchema` boolean keys, in `BOOLEAN_KEYS` order.
const BOOLEAN_DEFAULT_KEYS: [&str; 5] = [
    "ignoreWatched",
    "ignoreCollected",
    "ignoreWatchlisted",
    "hideUnmapped",
    "includeNoRating",
];

/// `DiscoverFilterDefaultsSchema` string keys, in `STRING_KEYS` order.
const STRING_DEFAULT_KEYS: [&str; 22] = [
    "language",
    "primaryReleaseDateGte",
    "primaryReleaseDateLte",
    "firstAirDateGte",
    "firstAirDateLte",
    "genre",
    "voteAverageGte",
    "voteAverageLte",
    "voteCountGte",
    "voteCountLte",
    "imdbRatingGte",
    "imdbRatingLte",
    "imdbVotesGte",
    "imdbVotesLte",
    "rtCriticsGte",
    "rtCriticsLte",
    "rtAudienceGte",
    "rtAudienceLte",
    "metacriticGte",
    "metacriticLte",
    "traktRatingGte",
    "traktRatingLte",
];

/// The column transformer plus `safeParseDiscoverFilterDefaults`: the
/// stored JSON when every key is known and well-typed, otherwise nothing.
fn parse_filter_defaults(stored: Option<&str>) -> Map<String, Value> {
    let Some(text) = stored.filter(|t| !t.is_empty()) else {
        return Map::new();
    };
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(text) else {
        return Map::new();
    };
    let valid = map.iter().all(|(key, value)| {
        if BOOLEAN_DEFAULT_KEYS.contains(&key.as_str()) {
            value.is_boolean()
        } else if STRING_DEFAULT_KEYS.contains(&key.as_str()) {
            value.as_str().is_some_and(|s| !s.is_empty())
        } else {
            false
        }
    });
    if valid {
        map
    } else {
        Map::new()
    }
}

/// `hasDiscoverTmdbId`: a finite number above zero.
pub(super) fn has_discover_tmdb_id(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_f64)
        .is_some_and(|n| n.is_finite() && n > 0.0)
}

/// `omitUnmappedDiscoverItems`.
pub(super) fn omit_unmapped(items: Vec<Value>, hide: bool) -> Vec<Value> {
    if !hide {
        return items;
    }
    items
        .into_iter()
        .filter(|item| {
            has_discover_tmdb_id(item.get("tmdbId"))
                && matches!(
                    item.get("mediaType").and_then(Value::as_str),
                    Some("movie" | "tv")
                )
        })
        .collect()
}

/// `next({ status, message, retryAfter })` through Express's error
/// handler: `{"message": ...}`, and `Retry-After` (rounded up) on a 429
/// with a finite `retryAfter`.
pub(super) fn route_error(
    ctx: &Ready<'_>,
    status: u16,
    message: &str,
    retry_after: Option<f64>,
) -> Outcome {
    let outcome = ctx.error(status, message);
    match (outcome, retry_after) {
        (Outcome::Done(mut res), Some(seconds))
            if status == 429 && seconds.is_finite() && seconds.abs() < 1e15 =>
        {
            let ceil = seconds.ceil();
            let text = if ceil == 0.0 {
                String::from("0")
            } else {
                format!("{ceil:.0}")
            };
            if let Ok(value) = HeaderValue::from_str(&text) {
                res.headers_mut().insert("retry-after", value);
            }
            Outcome::Done(res)
        }
        (outcome, _) => outcome,
    }
}

/// `annotateProviderActiveRequests`: library status on tiles Foreseerr
/// tracks, and `hasActiveRequest` while `hideRequested` is on. A database
/// error leaves the tiles as they are, as `getRelatedMedia` returns `[]`.
pub(super) async fn annotate_provider_active_requests(
    ctx: &Ready<'_>,
    items: Vec<Value>,
) -> Vec<Value> {
    annotate_with(ctx.state, &ctx.settings, items).await
}

/// [`annotate_provider_active_requests`] outside a request.
pub async fn annotate_with(
    state: &crate::state::AppState,
    settings: &crate::settings::Settings,
    items: Vec<Value>,
) -> Vec<Value> {
    let wanted: Vec<(i64, &str)> = items
        .iter()
        .filter_map(|item| {
            let id = item.get("tmdbId")?;
            let kind = item.get("mediaType").and_then(Value::as_str)?;
            (has_discover_tmdb_id(Some(id)) && matches!(kind, "movie" | "tv"))
                .then(|| id.as_i64().map(|id| (id, kind)))
                .flatten()
        })
        .collect();
    let related = related_media(state, settings, &wanted)
        .await
        .unwrap_or_else(|e| {
            tracing::error!("{e}");
            HashMap::new()
        });
    let hide_requested = truthy(settings.get("/main/hideRequested"));
    items
        .into_iter()
        .map(|item| {
            let key = match (
                item.get("tmdbId").and_then(Value::as_i64),
                item.get("mediaType").and_then(Value::as_str),
            ) {
                (Some(id), Some(kind)) if id != 0 && !kind.is_empty() => format!("{kind}:{id}"),
                _ => return item,
            };
            let (Some(media), Value::Object(mut map)) = (related.get(&key), item.clone()) else {
                return item;
            };
            let mut info = Map::new();
            for field in ["id", "tmdbId", "status", "status4k"] {
                info.insert(
                    String::from(field),
                    media.row.get(field).cloned().unwrap_or(Value::Null),
                );
            }
            map.insert(String::from("mediaInfo"), Value::Object(info));
            if hide_requested && media.active {
                map.insert(String::from("hasActiveRequest"), Value::Bool(true));
            }
            Value::Object(map)
        })
        .collect()
}

struct RelatedRow {
    row: Map<String, Value>,
    active: bool,
}

/// `Media.getRelatedMedia(undefined, items, { includeActiveRequest: true })`
/// keyed by `mediaType:tmdbId`.
async fn related_media(
    state: &crate::state::AppState,
    settings: &crate::settings::Settings,
    wanted: &[(i64, &str)],
) -> Result<HashMap<String, RelatedRow>, String> {
    let mut out = HashMap::new();
    if wanted.is_empty() {
        return Ok(out);
    }
    let mut ids: Vec<i64> = wanted.iter().map(|(id, _)| *id).collect();
    ids.sort_unstable();
    ids.dedup();
    let placeholders: Vec<String> = (1..=ids.len()).map(|i| format!("?{i}")).collect();
    let sql = format!(
        r#"SELECT "id", "tmdbId", "mediaType", "status", "status4k" FROM "media" WHERE "tmdbId" IN ({})"#,
        placeholders.join(", ")
    );
    let binds: Vec<Bind> = ids.iter().map(|id| Bind::Int(*id)).collect();
    let rows = state
        .db
        .rows(&sql, &binds)
        .await
        .map_err(|e| format!("loading related media failed: {e:#}"))?;
    let rows: Vec<Map<String, Value>> = rows
        .into_iter()
        .filter(|row| {
            let id = row.get("tmdbId").and_then(Value::as_i64);
            let kind = row.get("mediaType").and_then(Value::as_str);
            wanted
                .iter()
                .any(|(w_id, w_kind)| Some(*w_id) == id && Some(*w_kind) == kind)
        })
        .collect();
    let active = if truthy(settings.get("/main/hideRequested")) && !rows.is_empty() {
        let media_ids: Vec<i64> = rows
            .iter()
            .filter_map(|r| r.get("id").and_then(Value::as_i64))
            .collect();
        state
            .db
            .media_with_active_requests(&media_ids)
            .await
            .map_err(|e| format!("loading active requests failed: {e:#}"))?
    } else {
        Vec::new()
    };
    for row in rows {
        let key = format!(
            "{}:{}",
            row.get("mediaType").and_then(Value::as_str).unwrap_or(""),
            row.get("tmdbId").and_then(Value::as_i64).unwrap_or(0)
        );
        let id = row.get("id").and_then(Value::as_i64).unwrap_or(0);
        out.insert(
            key,
            RelatedRow {
                row,
                active: active.contains(&id),
            },
        );
    }
    Ok(out)
}

/// `createTmdbWithRegionLanguage(user)`: the region and the original
/// language the TMDB client is built with (`None` when the setting is
/// missing, which axios then leaves out).
pub(super) struct RegionLanguage {
    pub(super) region: String,
    pub(super) original_language: Option<String>,
}

/// The user's streaming region and original language, `all` meaning none,
/// falling back to the main settings.
pub(super) fn region_language(
    ctx: &Ready<'_>,
    streaming_region: Option<&str>,
    original_language: Option<&str>,
) -> RegionLanguage {
    let pick = |own: Option<&str>, main: &str| -> Option<String> {
        match own {
            Some("all") => Some(String::new()),
            Some(v) if !v.is_empty() => Some(v.to_owned()),
            Some(_) | None => ctx
                .settings
                .get(main)
                .map(|v| crate::media::js_string(Some(v)).into_owned()),
        }
    };
    RegionLanguage {
        region: pick(streaming_region, "/main/discoverRegion").unwrap_or_default(),
        original_language: pick(original_language, "/main/originalLanguage"),
    }
}

/// `needsMdblistEnrichment(query)`: an `MDBList` key and either a visible
/// `MDBList` badge or an active `MDBList` browse filter.
pub(super) fn needs_mdblist_enrichment(ctx: &Ready<'_>, query: Option<&Query>) -> bool {
    if ctx.settings.str("/mdblist/apiKey").trim().is_empty() {
        return false;
    }
    let badge_visible = [
        "showImdb",
        "showRt",
        "showRtUser",
        "showMetacritic",
        "showTraktCommunity",
    ]
    .iter()
    .any(|key| ctx.settings.get(&format!("/mdblist/{key}")) != Some(&Value::Bool(false)));
    if badge_visible {
        return true;
    }
    query.is_some_and(|q| {
        let f = BrowseFilters::parse(q);
        f.any() && f.needs_mdblist()
    })
}

/// `parseBrowseQueryFilters`: the post-fetch filters a query asks for.
#[derive(Debug, Clone, Default, PartialEq)]
pub(super) struct BrowseFilters {
    pub(super) vote_average_gte: Option<f64>,
    pub(super) vote_average_lte: Option<f64>,
    pub(super) vote_count_gte: Option<f64>,
    pub(super) vote_count_lte: Option<f64>,
    pub(super) genre_ids: Vec<f64>,
    pub(super) language: Option<String>,
    pub(super) movie_release_date_gte: Option<String>,
    pub(super) movie_release_date_lte: Option<String>,
    pub(super) tv_first_air_date_gte: Option<String>,
    pub(super) tv_first_air_date_lte: Option<String>,
    pub(super) runtime_gte: Option<f64>,
    pub(super) runtime_lte: Option<f64>,
    pub(super) series_status_ids: Vec<i64>,
    /// The `MDBList` gates, in `BrowseQueryFilters` order: `IMDb` rating and
    /// votes, RT critics and audience, Metacritic, Trakt (gte, lte each).
    pub(super) external: [Option<f64>; 12],
    pub(super) include_no_rating: bool,
}

/// The `MDBList` gate keys in [`BrowseFilters::external`] order.
pub(super) const EXTERNAL_FILTER_KEYS: [&str; 12] = [
    "imdbRatingGte",
    "imdbRatingLte",
    "imdbVotesGte",
    "imdbVotesLte",
    "rtCriticsGte",
    "rtCriticsLte",
    "rtAudienceGte",
    "rtAudienceLte",
    "metacriticGte",
    "metacriticLte",
    "traktRatingGte",
    "traktRatingLte",
];

impl BrowseFilters {
    /// Read the filters from the query.
    pub(super) fn parse(query: &Query) -> Self {
        let number = |key: &str| js_query_number(query.get(key));
        let string = |key: &str| {
            query
                .str(key)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        };
        let genre_ids = string("genre")
            .map(|raw| {
                raw.split(',')
                    .filter_map(|part| js_number_of_str(part.trim()))
                    .collect()
            })
            .unwrap_or_default();
        let series_status_ids = string("status")
            .map(|raw| {
                raw.split('|')
                    .filter_map(|part| js_number_of_str(part.trim()))
                    .filter(|n| n.fract() == 0.0 && (0.0..=5.0).contains(n))
                    .filter_map(|n| format!("{n:.0}").parse::<i64>().ok())
                    .collect()
            })
            .unwrap_or_default();
        let mut external = [None; 12];
        for (slot, key) in external.iter_mut().zip(EXTERNAL_FILTER_KEYS) {
            *slot = number(key);
        }
        Self {
            vote_average_gte: number("voteAverageGte"),
            vote_average_lte: number("voteAverageLte"),
            vote_count_gte: number("voteCountGte"),
            vote_count_lte: number("voteCountLte"),
            genre_ids,
            language: string("language"),
            movie_release_date_gte: string("primaryReleaseDateGte"),
            movie_release_date_lte: string("primaryReleaseDateLte"),
            tv_first_air_date_gte: string("firstAirDateGte"),
            tv_first_air_date_lte: string("firstAirDateLte"),
            runtime_gte: number("withRuntimeGte"),
            runtime_lte: number("withRuntimeLte"),
            series_status_ids,
            external,
            include_no_rating: query.get("includeNoRating") != Some(&Value::from("false")),
        }
    }

    /// `needsMdblistBrowseFilters`.
    pub(super) fn needs_mdblist(&self) -> bool {
        self.external.iter().any(Option::is_some)
    }

    /// `needsTraktRatingBrowseFilters`.
    pub(super) const fn needs_trakt_rating(&self) -> bool {
        self.external[10].is_some() || self.external[11].is_some()
    }

    /// `needsNonTraktMdblistBrowseFilters`.
    pub(super) fn needs_non_trakt_mdblist(&self) -> bool {
        self.external.iter().take(10).any(Option::is_some)
    }

    /// `needsTmdbBrowseFilters`.
    pub(super) fn needs_tmdb(&self) -> bool {
        self.vote_average_gte.is_some()
            || self.vote_average_lte.is_some()
            || self.vote_count_gte.is_some()
            || self.vote_count_lte.is_some()
            || !self.genre_ids.is_empty()
            || self.language.is_some()
            || self.movie_release_date_gte.is_some()
            || self.movie_release_date_lte.is_some()
            || self.tv_first_air_date_gte.is_some()
            || self.tv_first_air_date_lte.is_some()
            || self.runtime_gte.is_some()
            || self.runtime_lte.is_some()
            || !self.series_status_ids.is_empty()
    }

    /// `hasBrowseQueryFilters`.
    pub(super) fn any(&self) -> bool {
        self.needs_tmdb() || self.needs_mdblist() || !self.include_no_rating
    }
}

/// `nullableQueryNumber`: `null`/missing/`''` are none, otherwise
/// `Number(value)` when finite.
fn js_query_number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(n) => n.as_f64(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::String(s) if !s.is_empty() => js_number_of_str(s),
        Value::Null | Value::String(_) | Value::Array(_) | Value::Object(_) => None,
    }
}

/// `Number(text)` when finite (hex, octal and binary integers included;
/// blank text is 0).
pub(super) fn js_number_of_str(text: &str) -> Option<f64> {
    Some(crate::jsval::number_of_str(text)).filter(|n| n.is_finite())
}

/// Talk to one of Node's `/internal` routes with the API key.
async fn node_call(
    ctx: &Ready<'_>,
    method: reqwest::Method,
    path: &str,
    body: Option<&Value>,
) -> Result<Option<Value>, String> {
    if crate::mappinglayer::owned() {
        if let Some(answer) = crate::mappinglayer::answer(ctx.state, &method, path, body).await {
            return answer
                .into_result(path)
                .map(|v| (!v.is_null()).then_some(v))
                .map_err(|e| format!("{e:#}"));
        }
    }
    if crate::standalone::enabled() {
        return crate::standalone::internal::call(ctx.state, &method, path, body)
            .await
            .into_result(path)
            .map(|v| (!v.is_null()).then_some(v))
            .map_err(|e| format!("{e:#}"));
    }
    let url = format!(
        "{}/internal{path}",
        ctx.state.env.node_url.trim_end_matches('/')
    );
    let mut request = ctx
        .state
        .internal
        .request(method, url)
        .header("X-API-Key", ctx.settings.api_key());
    if let Some(body) = body {
        request = request.json(body);
    }
    let res = request
        .send()
        .await
        .map_err(|e| format!("the internal {path} could not be reached: {e:#}"))?
        .error_for_status()
        .map_err(|e| format!("the internal {path} failed: {e:#}"))?;
    if res.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(None);
    }
    res.json::<Value>()
        .await
        .map(Some)
        .map_err(|e| format!("the internal {path} answered something other than JSON: {e:#}"))
}

/// POST JSON to a Node internal route and read the JSON answer.
pub(super) async fn node_post(ctx: &Ready<'_>, path: &str, body: &Value) -> Result<Value, String> {
    node_call(ctx, reqwest::Method::POST, path, Some(body))
        .await
        .map(Option::unwrap_or_default)
}

/// GET a Node internal route.
pub(super) async fn node_get(ctx: &Ready<'_>, path: &str) -> Result<Value, String> {
    node_call(ctx, reqwest::Method::GET, path, None)
        .await
        .map(Option::unwrap_or_default)
}

fn array_of(value: Value) -> Result<Vec<Value>, String> {
    match value {
        Value::Array(items) => Ok(items),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) | Value::Object(_) => {
            Err(String::from(
                "the internal mapping route answered something other than an array",
            ))
        }
    }
}

/// Wrap a body: `{ <key>: value, options }`.
fn body_with(key: &str, value: Value, options: Option<Value>) -> Value {
    let mut map = Map::new();
    map.insert(key.to_owned(), value);
    if let Some(options) = options {
        map.insert(String::from("options"), options);
    }
    Value::Object(map)
}

/// `confirmOrRepair(item, options)` for each item, concurrently in Node
/// (`Promise.all`); `null` where the id is fine.
pub(super) async fn confirm_or_repair(
    ctx: &Ready<'_>,
    items: Vec<Value>,
    options: Value,
) -> Result<Vec<Value>, String> {
    let body = body_with("items", Value::Array(items), Some(options));
    array_of(node_post(ctx, "/mapping/confirm", &body).await?)
}

/// `resolveDiscoverItems(items, options)`.
pub(super) async fn resolve_discover_items(
    ctx: &Ready<'_>,
    items: Vec<Value>,
    options: Value,
) -> Result<Vec<Value>, String> {
    let body = body_with("items", Value::Array(items), Some(options));
    array_of(node_post(ctx, "/mapping/resolve-items", &body).await?)
}

/// `withTmdbPosters(items)`.
pub(super) async fn with_tmdb_posters(
    ctx: &Ready<'_>,
    items: Vec<Value>,
) -> Result<Vec<Value>, String> {
    if items.is_empty() {
        return Ok(items);
    }
    let body = body_with("items", Value::Array(items), None);
    array_of(node_post(ctx, "/mapping/posters", &body).await?)
}

/// `recordUnmappedItems(items, options)`.
pub(super) async fn record_unmapped(
    ctx: &Ready<'_>,
    items: &[Value],
    options: Value,
) -> Result<(), String> {
    let body = body_with("items", Value::Array(items.to_vec()), Some(options));
    node_post(ctx, "/mapping/unmapped", &body).await.map(|_| ())
}

/// `hydrateTraktTmdbIds(items, { discoverSource })`, then, with `confirm`,
/// `confirmTraktTmdbIds` on the result with the same source.
pub(super) async fn trakt_tmdb_ids(
    ctx: &Ready<'_>,
    items: Vec<Value>,
    discover_source: &str,
    confirm: bool,
) -> Result<Vec<Value>, String> {
    let mut options = Map::new();
    options.insert(String::from("discoverSource"), Value::from(discover_source));
    options.insert(String::from("confirm"), Value::Bool(confirm));
    let body = body_with("items", Value::Array(items), Some(Value::Object(options)));
    array_of(node_post(ctx, "/mapping/trakt-ids", &body).await?)
}

/// `mapAnilistMediaList(media)`.
pub(super) async fn anilist_media_list(
    ctx: &Ready<'_>,
    media: Vec<Value>,
) -> Result<Vec<Value>, String> {
    let body = body_with("media", Value::Array(media), None);
    array_of(node_post(ctx, "/mapping/anilist-media", &body).await?)
}

/// `loadCombinedWatchedIdSets(userId)`: the TMDB ids the user watched on
/// Trakt, Jellyfin and `AniList`, from Node's sync caches.
pub(super) async fn watched_sets(
    ctx: &Ready<'_>,
    user_id: i64,
) -> Result<(Vec<i64>, Vec<i64>), String> {
    let value = node_get(ctx, &format!("/discover/watched/{user_id}")).await?;
    let ids = |key: &str| -> Vec<i64> {
        value
            .get(key)
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_i64).collect())
            .unwrap_or_default()
    };
    Ok((ids("movie"), ids("tv")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const PARAMS: [Param; 4] = [
        ("page", Kind::Int),
        ("genre", Kind::Str),
        ("voteAverageGte", Kind::Num),
        ("type", Kind::Enum(&["movie", "tv"])),
    ];

    fn parse(raw: &str) -> Result<Query, String> {
        Query::parse(
            Some(raw),
            &[&PARAMS, &FLAG_PARAMS, &RATING_PARAMS],
            &[("page", json!(1)), ("includeNoRating", json!(true))],
        )
    }

    #[test]
    fn parses_like_the_validator() {
        let q =
            parse("genre=18%2C35&voteAverageGte=7.5&hideUnmapped=true&type=tv").unwrap_or_default();
        assert_eq!(q.get("genre"), Some(&json!("18,35")), "decoded string");
        assert_eq!(q.get("voteAverageGte"), Some(&json!(7.5)), "number");
        assert!(q.truthy("hideUnmapped"), "boolean");
        assert_eq!(q.get("page"), Some(&json!(1)), "default page");
        assert_eq!(q.get("includeNoRating"), Some(&json!(true)), "default flag");
        assert_eq!(q.text("type"), "tv", "enum");
        for raw in [
            "x=1",
            "page=1&page=2",
            "genre=",
            "voteAverageGte=7.0",
            "voteAverageGte=07",
            "voteAverageGte=1e3",
            "hideUnmapped=1",
            "type=anime",
            "genre=a+b",
            "page=-1",
        ] {
            assert!(parse(raw).is_err(), "{raw} goes to Node");
        }
    }

    #[test]
    fn applies_filter_defaults() {
        let stored = r#"{"hideUnmapped":true,"genre":"18","includeNoRating":false}"#;
        let q = parse("")
            .unwrap_or_default()
            .with_filter_defaults(Some(stored));
        assert_eq!(
            q.get("hideUnmapped"),
            Some(&json!("true")),
            "boolean as text"
        );
        assert_eq!(q.get("genre"), Some(&json!("18")), "string");
        assert_eq!(
            q.get("includeNoRating"),
            Some(&json!(true)),
            "the validator's default wins"
        );
        let ignored = parse("ignoreDiscoverDefaults=true")
            .unwrap_or_default()
            .with_filter_defaults(Some(stored));
        assert!(!ignored.has("genre"), "ignored on request");
        let invalid = parse("")
            .unwrap_or_default()
            .with_filter_defaults(Some(r#"{"genre":"18","bogus":1}"#));
        assert!(!invalid.has("genre"), "strict schema");
    }

    #[test]
    fn browse_filters() {
        let q = Query::from_map(
            json!({"genre": "18, x,35", "status": "0|7|3", "includeNoRating": "false", "imdbRatingGte": 7})
                .as_object()
                .cloned()
                .unwrap_or_default(),
        );
        let f = BrowseFilters::parse(&q);
        assert_eq!(f.genre_ids, vec![18.0, 35.0], "finite genre ids");
        assert_eq!(f.series_status_ids, vec![0, 3], "status range");
        assert!(!f.include_no_rating, "includeNoRating false");
        assert!(
            f.needs_mdblist() && f.needs_non_trakt_mdblist(),
            "imdb gate"
        );
        assert!(!f.needs_trakt_rating(), "no trakt gate");
        assert!(f.any(), "filters on");
    }

    #[test]
    fn unmapped_tiles() {
        let items = vec![
            json!({"tmdbId": 5, "mediaType": "movie"}),
            json!({"tmdbId": 0, "mediaType": "movie"}),
            json!({"tmdbId": 6}),
        ];
        assert_eq!(omit_unmapped(items.clone(), false).len(), 3, "kept");
        assert_eq!(omit_unmapped(items, true).len(), 1, "hidden");
    }
}
