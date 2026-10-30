//! `server/lib/requestFilters/browse.ts` and `lib/tmdbGenreEquivalents.ts`:
//! the post-fetch browse filters and the genre equivalence tables.

use serde_json::Value;

use super::discoverkit::{BrowseFilters, Query};

/// `TMDB_GENRE_EQUIVALENTS`.
const fn genre_equivalents(id: i64) -> &'static [i64] {
    match id {
        28 | 12 => &[10_759],
        10_759 => &[28, 12],
        14 | 878 => &[10_765],
        10_765 => &[14, 878],
        10_752 => &[10_768],
        10_768 => &[10_752],
        10_751 => &[10_762],
        10_762 => &[10_751],
        _ => &[],
    }
}

/// The equivalents of a JavaScript number id (only whole ids have any).
fn equivalents_of(id: f64) -> Vec<f64> {
    if id.fract() != 0.0 || id.abs() > 1e15 {
        return Vec::new();
    }
    format!("{id:.0}")
        .parse::<i64>()
        .map(genre_equivalents)
        .unwrap_or_default()
        .iter()
        .filter_map(|g| i32::try_from(*g).ok().map(f64::from))
        .collect()
}

const MOVIE_GENRE_IDS: [i64; 19] = [
    28, 12, 16, 35, 80, 99, 18, 10_751, 14, 36, 27, 10_402, 9_648, 10_749, 878, 10_770, 53, 10_752,
    37,
];

const TV_GENRE_IDS: [i64; 16] = [
    10_759, 16, 35, 80, 99, 18, 10_751, 10_762, 9_648, 10_763, 10_764, 10_765, 10_766, 10_767,
    10_768, 37,
];

/// `expandTmdbGenreIds`: each id with its equivalents, first-seen order.
pub(super) fn expand_genre_ids(ids: &[f64]) -> Vec<f64> {
    let mut out: Vec<f64> = Vec::new();
    for &id in ids.iter().filter(|id| id.is_finite()) {
        for candidate in std::iter::once(id).chain(equivalents_of(id)) {
            if !out.contains(&candidate) {
                out.push(candidate);
            }
        }
    }
    out
}

/// `toTmdbDiscoverGenres(genre, catalog)`: each picked id mapped onto the
/// catalog with its equivalents OR-ed (`|`), the picks AND-ed (`,`).
/// Ids are read with `Number()`.
pub(super) fn to_tmdb_discover_genres(
    genre: Option<&str>,
    tv: bool,
) -> Result<Option<String>, String> {
    let Some(genre) = genre.filter(|g| !g.is_empty()) else {
        return Ok(None);
    };
    let mut ids = Vec::new();
    for part in genre.split(',') {
        // `Number(part.trim())`, finite ones kept. An id that isn't an
        // integer has no equivalents and is in no catalog, so its group
        // comes out empty and is dropped.
        let id = crate::jsval::number_of_str(part);
        if !id.is_finite() || id.fract() != 0.0 || id.abs() >= 9_007_199_254_740_992.0 {
            continue;
        }
        ids.push(
            format!("{id:.0}")
                .parse::<i64>()
                .map_err(|_| String::from("a genre id out of range"))?,
        );
    }
    let allowed: &[i64] = if tv { &TV_GENRE_IDS } else { &MOVIE_GENRE_IDS };
    let groups: Vec<String> = ids
        .iter()
        .filter_map(|&id| {
            let mut group: Vec<i64> = Vec::new();
            let related = genre_equivalents(id).iter().copied();
            for candidate in std::iter::once(id).chain(related) {
                if !group.contains(&candidate) {
                    group.push(candidate);
                }
            }
            group.retain(|g| allowed.contains(g));
            (!group.is_empty()).then(|| {
                group
                    .iter()
                    .map(i64::to_string)
                    .collect::<Vec<_>>()
                    .join("|")
            })
        })
        .collect();
    Ok((!groups.is_empty()).then(|| groups.join(",")))
}

/// The fields `matchesBrowseFilters` reads from a title.
#[derive(Debug, Default)]
pub(super) struct BrowseItem<'a> {
    pub(super) vote_average: Option<f64>,
    pub(super) vote_count: Option<f64>,
    pub(super) genre_ids: Vec<f64>,
    pub(super) original_language: Option<&'a str>,
    pub(super) release_date: Option<&'a str>,
    pub(super) runtime: Option<f64>,
    pub(super) status: Option<&'a str>,
    pub(super) tv: bool,
}

/// The external scores, in [`super::discoverkit::EXTERNAL_FILTER_KEYS`]
/// pair order: `IMDb` rating, `IMDb` votes, RT critics, RT audience,
/// Metacritic, Trakt.
pub(super) type ExternalRatings = [Option<f64>; 6];

/// `externalRatingsFromResponse`.
pub(super) fn external_ratings(ratings: Option<&Value>) -> ExternalRatings {
    let at = |pointer: &str| {
        ratings
            .and_then(|r| r.pointer(pointer))
            .and_then(Value::as_f64)
    };
    [
        at("/imdb/criticsScore"),
        at("/imdb/criticsScoreCount"),
        at("/rt/criticsScore"),
        at("/rt/audienceScore"),
        at("/metacritic/score"),
        at("/trakt/rating"),
    ]
}

/// `passesScoreRange`.
const fn passes_score_range(
    score: Option<f64>,
    gte: Option<f64>,
    lte: Option<f64>,
    include_no_rating: bool,
) -> bool {
    if gte.is_none() && lte.is_none() {
        return true;
    }
    let Some(score) = score else {
        return include_no_rating;
    };
    if !score.is_finite() {
        return include_no_rating;
    }
    if let Some(gte) = gte {
        if score < gte {
            return false;
        }
    }
    if let Some(lte) = lte {
        if score > lte {
            return false;
        }
    }
    true
}

const STATUS_BY_ID: [&str; 6] = [
    "Returning Series",
    "Planned",
    "In Production",
    "Ended",
    "Canceled",
    "Pilot",
];

/// `matchesBrowseFilters`.
pub(super) fn matches_browse_filters(
    item: &BrowseItem<'_>,
    f: &BrowseFilters,
    external: &ExternalRatings,
) -> bool {
    let finite = |v: Option<f64>| v.filter(|n| n.is_finite());
    let in_range = |value: Option<f64>, gte: Option<f64>, lte: Option<f64>| {
        let value = finite(value);
        gte.is_none_or(|g| value.is_some_and(|v| v >= g))
            && lte.is_none_or(|l| value.is_some_and(|v| v <= l))
    };
    if !in_range(item.vote_average, f.vote_average_gte, f.vote_average_lte)
        || !in_range(item.vote_count, f.vote_count_gte, f.vote_count_lte)
    {
        return false;
    }
    if !f.genre_ids.is_empty() {
        let wanted = expand_genre_ids(&f.genre_ids);
        if !item.genre_ids.iter().any(|id| wanted.contains(id)) {
            return false;
        }
    }
    if let Some(language) = &f.language {
        if item.original_language.map(str::to_lowercase) != Some(language.to_lowercase()) {
            return false;
        }
    }
    let (gte, lte) = if item.tv {
        (&f.tv_first_air_date_gte, &f.tv_first_air_date_lte)
    } else {
        (&f.movie_release_date_gte, &f.movie_release_date_lte)
    };
    let date = item.release_date.filter(|d| !d.is_empty());
    if let Some(gte) = gte {
        if date.is_none_or(|d| utf16_lt(d, gte)) {
            return false;
        }
    }
    if let Some(lte) = lte {
        if date.is_none_or(|d| utf16_lt(lte, d)) {
            return false;
        }
    }
    let runtime = finite(item.runtime);
    if f.runtime_gte.is_some_and(|g| runtime.is_none_or(|r| r < g))
        || f.runtime_lte.is_some_and(|l| runtime.is_none_or(|r| r > l))
    {
        return false;
    }
    if !f.series_status_ids.is_empty() {
        let matches = f.series_status_ids.iter().any(|&id| {
            usize::try_from(id)
                .ok()
                .and_then(|i| STATUS_BY_ID.get(i))
                .is_some_and(|s| item.status == Some(*s))
        });
        if !item.tv || !matches {
            return false;
        }
    }
    external.iter().enumerate().all(|(i, score)| {
        let gte = f.external.get(i * 2).copied().flatten();
        let lte = f.external.get(i * 2 + 1).copied().flatten();
        passes_score_range(*score, gte, lte, f.include_no_rating)
    })
}

/// JavaScript's `<` on strings: UTF-16 code unit order.
fn utf16_lt(a: &str, b: &str) -> bool {
    a.encode_utf16().lt(b.encode_utf16())
}

/// `filterDiscoverResults`: mapped TMDB results (movies and series)
/// checked against the query's filters; people and collections pass.
pub(super) fn filter_discover_results(results: Vec<Value>, query: &Query) -> Vec<Value> {
    let f = BrowseFilters::parse_tmdb_discover(query);
    if !f.any() || results.is_empty() {
        return results;
    }
    let need_mdblist = f.needs_mdblist();
    results
        .into_iter()
        .filter(|item| {
            let tv = match item.get("mediaType").and_then(Value::as_str) {
                Some("movie") => false,
                Some("tv") => true,
                _ => return true,
            };
            let external = if need_mdblist {
                external_ratings(item.get("ratings"))
            } else {
                [None; 6]
            };
            let date_key = if tv { "firstAirDate" } else { "releaseDate" };
            let genre_ids = item
                .get("genreIds")
                .and_then(Value::as_array)
                .map(|ids| ids.iter().filter_map(Value::as_f64).collect())
                .unwrap_or_default();
            let browse = BrowseItem {
                vote_average: item.get("voteAverage").and_then(Value::as_f64),
                vote_count: item.get("voteCount").and_then(Value::as_f64),
                genre_ids,
                original_language: item.get("originalLanguage").and_then(Value::as_str),
                release_date: item.get(date_key).and_then(Value::as_str),
                runtime: None,
                status: None,
                tv,
            };
            matches_browse_filters(&browse, &f, &external)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn query(v: &Value) -> Query {
        Query::from_map(v.as_object().cloned().unwrap_or_default())
    }

    #[test]
    fn genre_mapping() {
        assert_eq!(
            to_tmdb_discover_genres(Some("28,18"), true),
            Ok(Some(String::from("10759,18"))),
            "action maps onto the tv catalog"
        );
        assert_eq!(
            to_tmdb_discover_genres(Some("10759"), false),
            Ok(Some(String::from("28|12"))),
            "action & adventure ORs on movies"
        );
        assert_eq!(
            to_tmdb_discover_genres(Some("10762"), false),
            Ok(Some(String::from("10751"))),
            "kids becomes family"
        );
        assert_eq!(
            to_tmdb_discover_genres(Some("10763"), false),
            Ok(None),
            "nothing left"
        );
        assert_eq!(to_tmdb_discover_genres(None, false), Ok(None), "none");
        assert_eq!(to_tmdb_discover_genres(Some("x"), false), Ok(None), "NaN");
        assert_eq!(
            to_tmdb_discover_genres(Some(" 0x1C , 1.5,Infinity"), false),
            to_tmdb_discover_genres(Some("28"), false),
            "Number() reads hex; fractions and Infinity drop out"
        );
        assert_eq!(
            expand_genre_ids(&[28.0, 12.0]),
            vec![28.0, 10_759.0, 12.0],
            "expanded"
        );
    }

    #[test]
    fn filters_results() {
        let results = vec![
            json!({"id": 1, "mediaType": "movie", "voteAverage": 8, "genreIds": [28], "releaseDate": "2020-01-01"}),
            json!({"id": 2, "mediaType": "movie", "voteAverage": 5, "genreIds": [28], "releaseDate": "2020-01-01"}),
            json!({"id": 3, "mediaType": "tv", "voteAverage": 9, "genreIds": [10759], "firstAirDate": "2019-01-01"}),
            json!({"id": 4, "mediaType": "person"}),
        ];
        let q = query(&json!({"voteAverageGte": 7, "genre": "28", "includeNoRating": true}));
        let ids: Vec<i64> = filter_discover_results(results.clone(), &q)
            .iter()
            .filter_map(|r| r.get("id").and_then(Value::as_i64))
            .collect();
        assert_eq!(ids, vec![1, 3, 4], "votes, genre equivalents, people pass");
        let q = query(&json!({"primaryReleaseDateGte": "2021-01-01", "includeNoRating": true}));
        let ids: Vec<i64> = filter_discover_results(results.clone(), &q)
            .iter()
            .filter_map(|r| r.get("id").and_then(Value::as_i64))
            .collect();
        assert_eq!(ids, vec![3, 4], "movie dates only bind movies");
        let q = query(&json!({"withRuntimeGte": 60, "status": "3", "includeNoRating": true}));
        assert_eq!(
            filter_discover_results(results, &q).len(),
            4,
            "runtime and status are TMDB's to apply upstream"
        );
    }

    #[test]
    fn score_ranges() {
        assert!(passes_score_range(None, None, None, false), "no gate");
        assert!(!passes_score_range(None, Some(1.0), None, false), "missing");
        assert!(passes_score_range(None, Some(1.0), None, true), "allowed");
        assert!(!passes_score_range(Some(0.5), Some(1.0), None, true), "low");
        assert!(
            passes_score_range(Some(1.0), Some(1.0), Some(1.0), true),
            "edge"
        );
    }
}
