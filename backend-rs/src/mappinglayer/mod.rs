//! `server/lib/mapping` (lookups, stored resolutions, the anime
//! fallback) and the discover, Trakt, `AniList`, `animeList`, Simkl and
//! watched-title code built on it, in this process.
//!
//! One process owns the mapping state (lookup caches, the miss buffer,
//! the per-user sync caches): this one when it runs the jobs
//! ([`owned`]), Node otherwise. The call sites ask [`owned`] and either
//! call in here or keep calling Node's `/internal` routes, which
//! [`answer`] reproduces for standalone mode.

pub mod animelist;
pub mod derive;
pub mod discover;
pub mod edges;
pub mod lru;
pub mod probe;
pub mod resolutions;
pub mod resolve;
pub mod simklresolve;
pub mod synccache;
pub mod watched;

mod routes;

#[cfg(test)]
mod dbtests;

use std::sync::{Arc, Mutex, Weak};

use anyhow::Result;
use serde_json::Value;

pub use routes::answer;

use crate::db::Db;
use crate::state::AppState;
use crate::sync::lock;
use crate::tmdb::TmdbClient;

/// Whether this process owns the mapping state: when it runs the jobs
/// (always in standalone mode). Otherwise Node does, and the call sites
/// keep using its `/internal` routes.
#[must_use]
pub fn owned() -> bool {
    crate::jobs::scheduler::rust_jobs()
}

static SHARED: Mutex<Option<Weak<AppState>>> = Mutex::new(None);

/// Remember the shared state, for the background work a lookup can start
/// (the first dataset download).
pub fn register(state: &Arc<AppState>) {
    *lock(&SHARED) = Some(Arc::downgrade(state));
}

/// The shared state, once registered.
#[must_use]
pub fn shared() -> Option<Arc<AppState>> {
    lock(&SHARED).as_ref().and_then(Weak::upgrade)
}

/// `ensureMappingLayer()`: the dataset rows are loaded, and a dataset
/// that was never written starts downloading in the background.
///
/// # Errors
///
/// Fails on database errors.
pub async fn ensure(db: &Db) -> Result<()> {
    match shared() {
        Some(state) => crate::mappingdatasets::ensure_mapping_layer(state).await,
        None => crate::mappingdatasets::load_active_generations(db, false).await,
    }
}

/// The readable edge set changed (Node's `onDatasetsChanged` listeners
/// and `POST /internal/mapping/datasets/changed`): drop the edge and
/// answer caches.
pub fn datasets_changed() {
    edges::clear_edge_cache();
    resolve::clear_hot();
}

/// What the lookups need: the database, TMDB, the outgoing client and
/// `settings.main.locale || 'en'` (the language `new TheMovieDb()` uses).
#[derive(Debug)]
pub struct Ctx<'a> {
    /// The database.
    pub db: &'a Db,
    /// The shared TMDB client and its cache.
    pub tmdb: &'a TmdbClient,
    /// Outgoing HTTP (`AniList`).
    pub http: &'a reqwest::Client,
    /// TMDB language.
    pub locale: String,
}

impl<'a> Ctx<'a> {
    /// Over the process state, reading the locale from settings.json.
    ///
    /// # Errors
    ///
    /// Fails when settings.json can't be read.
    pub async fn of(state: &'a AppState) -> Result<Self> {
        let settings = state.settings.current().await?;
        Ok(Self::with_settings(state, &settings))
    }

    /// Over the process state with the settings already read.
    #[must_use]
    pub fn with_settings(state: &'a AppState, settings: &crate::settings::Settings) -> Self {
        let locale = settings
            .get("/main/locale")
            .and_then(Value::as_str)
            .filter(|l| !l.is_empty())
            .unwrap_or("en")
            .to_owned();
        Self {
            db: &state.db,
            tmdb: &state.tmdb,
            http: &state.outbound,
            locale,
        }
    }
}

/// `'movie' | 'tv'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MediaType {
    /// A film.
    Movie,
    /// A series.
    Tv,
}

impl MediaType {
    /// `movie` or `tv`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Movie => "movie",
            Self::Tv => "tv",
        }
    }

    /// From `movie` or `tv`.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "movie" => Some(Self::Movie),
            "tv" => Some(Self::Tv),
            _ => None,
        }
    }

    /// From a JSON value holding `movie` or `tv`.
    #[must_use]
    pub fn of(value: Option<&Value>) -> Option<Self> {
        value.and_then(Value::as_str).and_then(Self::parse)
    }

    /// `tmdbNamespace(mediaType)`.
    #[must_use]
    pub const fn namespace(self) -> &'static str {
        match self {
            Self::Movie => "tmdb_movie",
            Self::Tv => "tmdb_show",
        }
    }

    /// The other one.
    #[must_use]
    pub const fn other(self) -> Self {
        match self {
            Self::Movie => Self::Tv,
            Self::Tv => Self::Movie,
        }
    }
}

/// `NAMESPACES`.
pub const NAMESPACES: [&str; 10] = [
    "tmdb_movie",
    "tmdb_show",
    "tvdb_movie",
    "tvdb_show",
    "imdb",
    "anidb",
    "anilist",
    "mal",
    "simkl",
    "trakt",
];

/// An `IdRef`; an empty `id` stands for a falsy one.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IdRef {
    /// Namespace.
    pub ns: String,
    /// Id, as `String(ref.id)`.
    pub id: String,
    /// Season, when the id is one season of a show.
    pub season: Option<i64>,
}

impl IdRef {
    /// `{ ns, id }`.
    #[must_use]
    pub fn new(ns: &str, id: &str) -> Self {
        Self {
            ns: ns.to_owned(),
            id: id.to_owned(),
            season: None,
        }
    }

    /// From a JSON `{ ns, id, season? }`; a number id becomes its
    /// JavaScript text (`0` counts as falsy, so as empty).
    #[must_use]
    pub fn of(value: Option<&Value>) -> Option<Self> {
        let value = value.filter(|v| v.is_object())?;
        let ns = value.get("ns").and_then(Value::as_str).unwrap_or_default();
        Some(Self {
            ns: ns.to_owned(),
            id: id_text(value.get("id")),
            season: value.get("season").and_then(Value::as_f64).and_then(int_of),
        })
    }

    /// `ref?.ns && ref.id`.
    #[must_use]
    pub fn truthy(&self) -> bool {
        !self.ns.is_empty() && !self.id.is_empty()
    }

    /// `refKey(ref)`.
    #[must_use]
    pub fn key(&self) -> String {
        self.season.map_or_else(
            || format!("{}:{}", self.ns, self.id),
            |season| format!("{}:{}:s{season}", self.ns, self.id),
        )
    }
}

/// `String(id)` for a truthy string or number id, else empty.
#[must_use]
pub fn id_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.clone(),
        Some(v @ Value::Number(_)) if crate::settings::public::truthy(Some(v)) => {
            crate::jsnum::value_string(Some(v))
        }
        _ => String::new(),
    }
}

/// `seasonScope(season)`.
#[must_use]
pub fn season_scope(season: i64) -> String {
    format!("s{season}")
}

/// `scopeSeason(scope)`: the season `s<digits>` names.
#[must_use]
pub fn scope_season(scope: &str) -> Option<i64> {
    let digits = scope.strip_prefix('s')?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    int_of(crate::jsval::number_of_str(digits))
}

/// A float that holds an integer, as `i64`.
#[must_use]
pub fn int_of(n: f64) -> Option<i64> {
    if !crate::jsnum::is_integer(n) || n.abs() > 9_007_199_254_740_991.0 {
        return None;
    }
    format!("{n:.0}").parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn refs_and_scopes() {
        let r = IdRef::of(Some(&json!({"ns": "anilist", "id": 21}))).unwrap_or_default();
        assert_eq!(r.key(), "anilist:21", "number id");
        assert!(r.truthy(), "truthy");
        let zero = IdRef::of(Some(&json!({"ns": "trakt", "id": 0}))).unwrap_or_default();
        assert!(!zero.truthy(), "0 is falsy");
        let season = IdRef {
            season: Some(2),
            ..IdRef::new("tmdb_show", "1")
        };
        assert_eq!(season.key(), "tmdb_show:1:s2", "season key");
        assert_eq!(scope_season("s12"), Some(12), "season scope");
        assert_eq!(scope_season("R"), None, "AniDB scope");
        assert_eq!(scope_season("s"), None, "no digits");
        assert_eq!(int_of(3.0), Some(3), "integer");
        assert_eq!(int_of(3.5), None, "fraction");
    }
}
