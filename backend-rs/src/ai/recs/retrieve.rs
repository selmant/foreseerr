//! Finding real candidates for a plan.
//!
//! Sources: TMDB (the model's title ideas, recommendations for the seed and
//! liked titles, discover by genre and keyword), `AniList` for anime, the
//! person's Trakt recommendations (with their consent), and `SearXNG`
//! snippets for the ranker.
//!
//! Everything a candidate needs for ranking and display comes from TMDB,
//! so a title the model made up never reaches the results.

use std::collections::{HashMap, HashSet};
use std::hash::BuildHasher;

use serde_json::{Map, Value};

use super::prompts::{CandidateLine, Idea, Plan};
use crate::ai::clip;
use crate::concurrency::map_with_concurrency;
use crate::jellyfin::{join_all, Job};
use crate::mappinglayer::{discover::tmdb_for_anilist, Ctx as MapCtx, MediaType};
use crate::settings::Settings;
use crate::state::AppState;

/// The most candidates handed to the ranker.
pub const MAX_CANDIDATES: usize = 70;
/// TMDB answers cached this long (seconds) for these lookups.
const TTL: u64 = 6 * 3600;
/// `AniList` genre names (the only values its `genre_in` accepts).
const ANILIST_GENRES: [&str; 18] = [
    "Action",
    "Adventure",
    "Comedy",
    "Drama",
    "Ecchi",
    "Fantasy",
    "Horror",
    "Mahou Shoujo",
    "Mecha",
    "Music",
    "Mystery",
    "Psychological",
    "Romance",
    "Sci-Fi",
    "Slice of Life",
    "Sports",
    "Supernatural",
    "Thriller",
];

/// A title's identity.
pub type Key = (&'static str, i64);

/// The canonical `movie` / `tv` name.
#[must_use]
pub fn kind_of(text: &str) -> &'static str {
    if text == "tv" || text == "show" || text == "shows" {
        "tv"
    } else {
        "movie"
    }
}

/// One real title the ranker may pick.
#[derive(Debug, Clone)]
pub struct Candidate {
    /// `movie` or `tv`.
    pub media_type: &'static str,
    /// TMDB id.
    pub tmdb_id: i64,
    /// Title.
    pub title: String,
    /// Release year.
    pub year: Option<i64>,
    /// Genre ids.
    pub genre_ids: Vec<i64>,
    /// TMDB rating.
    pub rating: Option<f64>,
    /// Original language.
    pub language: String,
    /// Where it came from.
    pub source: &'static str,
    /// TMDB's result, slimmed to what a title card needs.
    pub tmdb: Value,
}

impl Candidate {
    /// Its key.
    #[must_use]
    pub const fn key(&self) -> Key {
        (self.media_type, self.tmdb_id)
    }

    /// Its reference for the ranker (`m603`, `t1399`).
    #[must_use]
    pub fn reference(&self) -> String {
        let prefix = if self.media_type == "tv" { 't' } else { 'm' };
        format!("{prefix}{}", self.tmdb_id)
    }

    /// Whether it's anime (Japanese animation).
    #[must_use]
    pub fn is_anime(&self) -> bool {
        self.language == "ja" && self.genre_ids.contains(&ANIMATION)
    }

    /// The ranker's line for it.
    #[must_use]
    pub fn line(&self, genres: &Genres) -> CandidateLine {
        CandidateLine {
            reference: self.reference(),
            title: self.title.clone(),
            year: self.year,
            genres: self
                .genre_ids
                .iter()
                .filter_map(|id| genres.name(*id))
                .map(str::to_owned)
                .collect(),
            rating: self.rating,
            overview: clip(
                self.tmdb
                    .get("overview")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim(),
                220,
            ),
            source: self.source,
        }
    }
}

/// TMDB's Animation genre.
const ANIMATION: i64 = 16;

/// TMDB's genres for movies and TV, by id and by name.
#[derive(Debug, Clone, Default)]
pub struct Genres {
    names: HashMap<i64, String>,
    movie: HashMap<String, i64>,
    tv: HashMap<String, i64>,
}

impl Genres {
    /// Load both lists (in English, so the model's names match).
    pub async fn load(state: &AppState) -> Self {
        let mut out = Self::default();
        for kind in ["movie", "tv"] {
            let list = state.tmdb.genres(kind, "en").await.unwrap_or_default();
            for g in list {
                let (Some(id), Some(name)) = (
                    g.get("id").and_then(Value::as_i64),
                    g.get("name").and_then(Value::as_str),
                ) else {
                    continue;
                };
                out.names.insert(id, name.to_owned());
                let by_name = if kind == "tv" {
                    &mut out.tv
                } else {
                    &mut out.movie
                };
                by_name.insert(name.to_lowercase(), id);
            }
        }
        out
    }

    /// Every genre name, for the plan prompt.
    #[must_use]
    pub fn all_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.names.values().cloned().collect();
        names.sort();
        names.dedup();
        names
    }

    /// A genre's name.
    #[must_use]
    pub fn name(&self, id: i64) -> Option<&str> {
        self.names.get(&id).map(String::as_str)
    }

    /// The ids of these names for one kind. TV merges some movie genres
    /// ("Action & Adventure"), so a name also matches the TV genre it's
    /// part of.
    #[must_use]
    pub fn ids(&self, kind: &str, names: &[String]) -> Vec<i64> {
        let map = if kind == "tv" { &self.tv } else { &self.movie };
        let mut out = Vec::new();
        for name in names {
            let wanted = name.trim().to_lowercase();
            let found = map.get(&wanted).copied().or_else(|| {
                map.iter()
                    .find(|(k, _)| k.split(" & ").any(|part| part == wanted))
                    .map(|(_, id)| *id)
            });
            if let Some(id) = found {
                if !out.contains(&id) {
                    out.push(id);
                }
            }
        }
        out
    }
}

fn year_of(v: &Value) -> Option<i64> {
    ["release_date", "first_air_date"]
        .iter()
        .find_map(|k| v.get(*k).and_then(Value::as_str))
        .and_then(|d| d.get(..4))
        .and_then(|y| y.parse().ok())
}

const KEEP: [&str; 18] = [
    "id",
    "title",
    "name",
    "original_title",
    "original_name",
    "original_language",
    "origin_country",
    "poster_path",
    "backdrop_path",
    "release_date",
    "first_air_date",
    "vote_average",
    "vote_count",
    "popularity",
    "genre_ids",
    "overview",
    "adult",
    "video",
];

/// A TMDB search result or details answer as a search-result-shaped
/// candidate.
#[must_use]
pub fn candidate(v: &Value, media_type: &'static str, source: &'static str) -> Option<Candidate> {
    if v.get("adult").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let tmdb_id = v.get("id").and_then(Value::as_i64)?;
    let title = v
        .get(if media_type == "tv" { "name" } else { "title" })
        .and_then(Value::as_str)
        .filter(|t| !t.trim().is_empty())?
        .to_owned();
    let genre_ids: Vec<i64> = v
        .get("genre_ids")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_i64).collect())
        .or_else(|| {
            v.get("genres").and_then(Value::as_array).map(|a| {
                a.iter()
                    .filter_map(|g| g.get("id").and_then(Value::as_i64))
                    .collect()
            })
        })
        .unwrap_or_default();
    let mut slim = Map::new();
    if let Some(obj) = v.as_object() {
        for key in KEEP {
            if let Some(value) = obj.get(key) {
                slim.insert(key.to_owned(), value.clone());
            }
        }
    }
    slim.insert(
        String::from("genre_ids"),
        Value::Array(genre_ids.iter().map(|id| Value::from(*id)).collect()),
    );
    slim.insert(String::from("media_type"), Value::from(media_type));
    Some(Candidate {
        media_type,
        tmdb_id,
        title,
        year: year_of(v),
        genre_ids,
        rating: v.get("vote_average").and_then(Value::as_f64),
        language: v
            .get("original_language")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        source,
        tmdb: Value::Object(slim),
    })
}

fn results(v: &Value) -> Vec<Value> {
    v.get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// The TMDB match for a title (and year): an exact title match in the
/// right year first, then any exact match, then the top result.
pub async fn search_title(
    state: &AppState,
    language: &str,
    title: &str,
    year: Option<i64>,
    media_type: &'static str,
    source: &'static str,
) -> Option<Candidate> {
    let path = format!("/search/{media_type}");
    let year_key = if media_type == "tv" {
        "first_air_date_year"
    } else {
        "primary_release_year"
    };
    let mut attempts: Vec<Option<i64>> = vec![year];
    if year.is_some() {
        attempts.push(None);
    }
    for y in attempts {
        let mut params: Vec<(&str, String)> = vec![
            ("query", title.to_owned()),
            ("page", String::from("1")),
            ("include_adult", String::from("false")),
            ("language", language.to_owned()),
        ];
        if let Some(y) = y {
            params.push((year_key, y.to_string()));
        }
        let Ok(answer) = state.tmdb.raw(&path, &params, TTL).await else {
            continue;
        };
        let found = results(&answer);
        let wanted = title.trim().to_lowercase();
        let named = |r: &&Value| {
            ["title", "name", "original_title", "original_name"]
                .iter()
                .filter_map(|k| r.get(*k).and_then(Value::as_str))
                .any(|t| t.trim().to_lowercase() == wanted)
        };
        let best = found
            .iter()
            .find(|r| named(r) && (year.is_none() || year_of(r) == year))
            .or_else(|| found.iter().find(named))
            .or_else(|| found.first());
        if let Some(c) = best.and_then(|r| candidate(r, media_type, source)) {
            return Some(c);
        }
    }
    None
}

async fn title_list(
    state: &AppState,
    language: &str,
    key: Key,
    list: &str,
    take: usize,
    source: &'static str,
) -> Vec<Candidate> {
    let (kind, id) = key;
    state
        .tmdb
        .title_list(kind, id, list, 1, language)
        .await
        .map(|v| {
            results(&v)
                .iter()
                .take(take)
                .filter_map(|r| candidate(r, kind, source))
                .collect()
        })
        .unwrap_or_default()
}

async fn keyword_ids(state: &AppState, keywords: &[String]) -> Vec<i64> {
    let found = map_with_concurrency(
        keywords.iter().take(6).cloned().collect(),
        4,
        |kw: String| async move {
            let answer = state.tmdb.search_plain("keyword", &kw, 1).await.ok()?;
            let list = results(&answer);
            let wanted = kw.trim().to_lowercase();
            list.iter()
                .find(|k| {
                    k.get("name")
                        .and_then(Value::as_str)
                        .is_some_and(|n| n.to_lowercase() == wanted)
                })
                .or_else(|| list.first())
                .and_then(|k| k.get("id").and_then(Value::as_i64))
        },
    )
    .await;
    let mut ids: Vec<i64> = found.into_iter().flatten().collect();
    ids.dedup();
    ids
}

/// What to discover on TMDB for one kind.
#[derive(Debug, Clone)]
struct DiscoverQuery {
    kind: &'static str,
    genres: Vec<i64>,
    keywords: Vec<i64>,
    years: (Option<i64>, Option<i64>),
    anime: bool,
}

async fn discover(state: &AppState, language: &str, q: DiscoverQuery) -> Vec<Candidate> {
    let date = if q.kind == "tv" {
        "first_air_date"
    } else {
        "primary_release_date"
    };
    let mut genres = q.genres.clone();
    if q.anime && !genres.contains(&ANIMATION) {
        genres.push(ANIMATION);
    }
    let mut out: Vec<Candidate> = Vec::new();
    // All genres first (closest to the request), then any of them when
    // that finds too little.
    for joiner in [",", "|"] {
        if joiner == "|" && (genres.len() < 2 || out.len() >= 10) {
            break;
        }
        let mut params: Vec<(&str, String)> = vec![
            ("page", String::from("1")),
            ("language", language.to_owned()),
            ("include_adult", String::from("false")),
            ("sort_by", String::from("popularity.desc")),
            (
                "vote_count.gte",
                String::from(if q.kind == "tv" { "60" } else { "150" }),
            ),
            ("vote_average.gte", String::from("6.2")),
        ];
        if !genres.is_empty() {
            params.push((
                "with_genres",
                genres
                    .iter()
                    .map(i64::to_string)
                    .collect::<Vec<_>>()
                    .join(joiner),
            ));
        }
        if !q.keywords.is_empty() {
            params.push((
                "with_keywords",
                q.keywords
                    .iter()
                    .map(i64::to_string)
                    .collect::<Vec<_>>()
                    .join("|"),
            ));
        }
        if q.anime {
            params.push(("with_original_language", String::from("ja")));
        }
        let gte = format!("{date}.gte");
        let lte = format!("{date}.lte");
        if let Some(from) = q.years.0 {
            params.push((gte.as_str(), format!("{from}-01-01")));
        }
        if let Some(to) = q.years.1 {
            params.push((lte.as_str(), format!("{to}-12-31")));
        }
        let path = format!("/discover/{}", q.kind);
        if let Ok(answer) = state.tmdb.raw(&path, &params, TTL).await {
            out.extend(
                results(&answer)
                    .iter()
                    .filter_map(|r| candidate(r, q.kind, "discover")),
            );
        }
    }
    out
}

async fn summary(
    state: &AppState,
    language: &str,
    key: Key,
    source: &'static str,
) -> Option<Candidate> {
    let v = state
        .tmdb
        .title_summary(key.0, key.1, language)
        .await
        .ok()?;
    candidate(&v, key.0, source)
}

async fn anilist(
    state: &AppState,
    settings: &Settings,
    language: &str,
    plan: &Plan,
) -> Vec<Candidate> {
    let genres: Vec<String> = plan
        .genres
        .iter()
        .filter_map(|g| {
            let g = g.trim();
            let alias = match g.to_lowercase().as_str() {
                "science fiction" | "sci-fi & fantasy" => Some("Sci-Fi"),
                "action & adventure" => Some("Action"),
                _ => None,
            };
            alias.or_else(|| {
                ANILIST_GENRES
                    .iter()
                    .copied()
                    .find(|a| a.eq_ignore_ascii_case(g))
            })
        })
        .map(str::to_owned)
        .take(3)
        .collect();
    let client = crate::anilist::Anilist::new(&state.outbound, None);
    let Ok(media) = client
        .search_media(&genres, &[], None, (plan.year_from, plan.year_to), 15)
        .await
    else {
        return Vec::new();
    };
    let ctx = MapCtx::with_settings(state, settings);
    let ctx = &ctx;
    let mapped = map_with_concurrency(media, 4, |m: Value| async move {
        let id = m.get("id").and_then(Value::as_i64)?;
        let hint = m
            .pointer("/title/english")
            .and_then(Value::as_str)
            .or_else(|| m.pointer("/title/romaji").and_then(Value::as_str))
            .map(str::to_owned);
        let (tmdb_id, kind) = tmdb_for_anilist(ctx, id, None, hint.as_deref(), Some(&m), false)
            .await
            .ok()
            .flatten()?;
        let kind = match kind {
            MediaType::Movie => "movie",
            MediaType::Tv => "tv",
        };
        summary(state, language, (kind, tmdb_id), "anilist").await
    })
    .await;
    mapped.into_iter().flatten().collect()
}

async fn trakt(
    state: &AppState,
    settings: &Settings,
    user_id: i64,
    language: &str,
) -> Vec<Candidate> {
    let Ok(client) = crate::mediaactions::trakt::user_client(state, settings, user_id).await else {
        return Vec::new();
    };
    let mut keys: Vec<Key> = Vec::new();
    for kind in ["movie", "tv"] {
        let Ok(items) = client.recommendations(kind, true, false, "min").await else {
            continue;
        };
        keys.extend(
            items
                .iter()
                .filter_map(|i| i.get("tmdbId").and_then(Value::as_i64))
                .take(8)
                .map(|id| (kind_of(kind), id)),
        );
    }
    map_with_concurrency(keys, 4, |key: Key| async move {
        summary(state, language, key, "trakt").await
    })
    .await
    .into_iter()
    .flatten()
    .collect()
}

async fn web(state: &AppState, url: &str, queries: &[String]) -> Vec<String> {
    let mut lines = Vec::new();
    for q in queries.iter().take(super::prompts::MAX_WEB_QUERIES) {
        let Ok(hits) = crate::searxng::search(&state.outbound, url, q, 6).await else {
            continue;
        };
        for hit in hits {
            let host = reqwest::Url::parse(&hit.url)
                .ok()
                .and_then(|u| u.host_str().map(str::to_owned))
                .unwrap_or_default();
            lines.push(format!(
                "{} — {} ({host})",
                clip(hit.title.trim(), 120),
                clip(hit.snippet.trim(), 240)
            ));
        }
    }
    lines
}

/// What to look up besides the plan.
#[derive(Debug, Clone, Default)]
pub struct Sources {
    /// The seed title, for "more like this".
    pub seed: Option<Key>,
    /// Titles they liked (most recent first).
    pub liked: Vec<Key>,
    /// Use their Trakt recommendations (history consent).
    pub trakt: bool,
    /// The `SearXNG` URL, when web search is on.
    pub searxng: Option<String>,
    /// `movie` or `tv` only.
    pub only: Option<&'static str>,
    /// Anime only.
    pub anime_only: bool,
}

/// The candidates and web snippets for a plan.
#[derive(Debug, Clone, Default)]
pub struct Gathered {
    /// Distinct candidates, best sources first.
    pub candidates: Vec<Candidate>,
    /// Web result lines.
    pub web: Vec<String>,
}

/// Who and what a lookup is for.
#[derive(Debug, Clone, Copy)]
pub struct Env<'a> {
    /// The app.
    pub state: &'a AppState,
    /// Current settings.
    pub settings: &'a Settings,
    /// The person.
    pub user_id: i64,
    /// TMDB's answer language.
    pub language: &'a str,
    /// TMDB's genres.
    pub genres: &'a Genres,
}

/// Look everything up at once, then merge: drop excluded and duplicate
/// titles and titles of the wrong kind, keep the first source per title.
pub async fn gather<S: BuildHasher + Sync>(
    env: &Env<'_>,
    plan: &Plan,
    sources: &Sources,
    excluded: &HashSet<Key, S>,
) -> Gathered {
    let Env {
        state,
        settings,
        user_id,
        language,
        genres,
    } = *env;
    let anime = sources.anime_only || plan.anime;
    let kinds: Vec<&'static str> = match sources.only {
        Some(kind) => vec![kind],
        None if plan.media_types.is_empty() => vec!["movie", "tv"],
        None => {
            let mut k: Vec<&'static str> = plan.media_types.iter().map(|m| kind_of(m)).collect();
            k.dedup();
            k
        }
    };
    let keywords = keyword_ids(state, &plan.keywords).await;

    let mut jobs: Vec<Job<'_, Vec<Candidate>>> = Vec::new();
    let ideas: Vec<Idea> = plan
        .title_ideas
        .iter()
        .take(super::prompts::MAX_IDEAS)
        .cloned()
        .collect();
    jobs.push(Box::pin(async move {
        map_with_concurrency(ideas, 6, |idea: Idea| async move {
            search_title(
                state,
                language,
                &idea.title,
                idea.year,
                kind_of(&idea.media_type),
                "idea",
            )
            .await
        })
        .await
        .into_iter()
        .flatten()
        .collect()
    }));
    if let Some(seed) = sources.seed {
        jobs.push(Box::pin(async move {
            let mut out = title_list(state, language, seed, "recommendations", 15, "similar").await;
            out.extend(title_list(state, language, seed, "similar", 10, "similar").await);
            out
        }));
    }
    for liked in sources.liked.iter().take(3).copied() {
        jobs.push(Box::pin(async move {
            title_list(state, language, liked, "recommendations", 6, "liked").await
        }));
    }
    if !plan.genres.is_empty() || !keywords.is_empty() || anime {
        for kind in &kinds {
            let q = DiscoverQuery {
                kind,
                genres: genres.ids(kind, &plan.genres),
                keywords: keywords.clone(),
                years: (plan.year_from, plan.year_to),
                anime,
            };
            jobs.push(Box::pin(async move { discover(state, language, q).await }));
        }
    }
    if anime {
        jobs.push(Box::pin(async move {
            anilist(state, settings, language, plan).await
        }));
    }
    if sources.trakt {
        jobs.push(Box::pin(async move {
            trakt(state, settings, user_id, language).await
        }));
    }
    let web_job = async {
        match &sources.searxng {
            Some(url) if !plan.web_queries.is_empty() => web(state, url, &plan.web_queries).await,
            Some(_) | None => Vec::new(),
        }
    };
    let (found, web) = tokio::join!(join_all(jobs), web_job);

    let mut seen: HashSet<Key> = HashSet::new();
    let mut candidates = Vec::new();
    for c in found.into_iter().flatten() {
        if excluded.contains(&c.key()) || !kinds.contains(&c.media_type) {
            continue;
        }
        if sources.anime_only && !c.is_anime() {
            continue;
        }
        if seen.insert(c.key()) {
            candidates.push(c);
        }
        if candidates.len() >= MAX_CANDIDATES {
            break;
        }
    }
    Gathered { candidates, web }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn candidate_from_details_and_search_results() {
        let details = json!({"id": 603, "title": "The Matrix", "release_date": "1999-03-30",
            "genres": [{"id": 28, "name": "Action"}], "vote_average": 8.2, "original_language": "en",
            "overview": "A hacker learns the truth.", "budget": 63_000_000});
        let c = candidate(&details, "movie", "idea");
        assert_eq!(c.as_ref().map(|c| c.year), Some(Some(1999)), "year");
        assert_eq!(
            c.as_ref().map(|c| c.genre_ids.clone()),
            Some(vec![28]),
            "genre ids from details"
        );
        assert_eq!(
            c.as_ref().map(Candidate::reference).as_deref(),
            Some("m603"),
            "reference"
        );
        assert!(
            c.as_ref().and_then(|c| c.tmdb.get("budget")).is_none(),
            "slimmed to card fields"
        );
        let anime =
            json!({"id": 1, "name": "Frieren", "genre_ids": [16, 18], "original_language": "ja"});
        assert!(
            candidate(&anime, "tv", "anilist").is_some_and(|c| c.is_anime()),
            "anime"
        );
        let adult = json!({"id": 2, "title": "x", "adult": true});
        assert!(
            candidate(&adult, "movie", "idea").is_none(),
            "adult titles are skipped"
        );
    }

    #[test]
    fn genre_ids_match_tv_merged_genres() {
        let mut g = Genres::default();
        g.tv.insert(String::from("action & adventure"), 10759);
        g.movie.insert(String::from("action"), 28);
        assert_eq!(
            g.ids("tv", &[String::from("Action")]),
            vec![10759],
            "tv merged genre"
        );
        assert_eq!(
            g.ids("movie", &[String::from("action")]),
            vec![28],
            "movie genre"
        );
    }
}
