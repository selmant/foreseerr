//! The filters and sorts of an `AniList` list view, as anilist.co's list
//! sidebar offers them: search, format, airing status, genres, country,
//! release years, and the list sorts, plus score ranges anilist.co's list
//! lacks (the community average and the entry's own score). The whole
//! collection is already in hand, so they apply before paging.

use std::cmp::Ordering;

use serde_json::Value;

use super::discoverkit::{Kind, Param, Query};
use crate::jsval;

/// `MediaFormat` values an anime can have.
const FORMATS: [&str; 7] = ["TV", "TV_SHORT", "MOVIE", "SPECIAL", "OVA", "ONA", "MUSIC"];
/// `MediaStatus` values.
const AIRING: [&str; 5] = [
    "RELEASING",
    "FINISHED",
    "NOT_YET_RELEASED",
    "CANCELLED",
    "HIATUS",
];
/// The countries anilist.co filters by.
const COUNTRIES: [&str; 4] = ["JP", "KR", "CN", "TW"];
/// anilist.co's list sorts.
pub(super) const SORTS: [&str; 8] = [
    "score",
    "title",
    "progress",
    "updatedAt",
    "createdAt",
    "releaseDate",
    "averageScore",
    "popularity",
];
const MAX_GENRES: usize = 20;
const MAX_SEARCH_CHARS: usize = 200;

/// The query parameters a list view reads for its filters.
pub(super) const PARAMS: [Param; 13] = [
    ("search", Kind::Str),
    ("format", Kind::Str),
    ("airingStatus", Kind::Str),
    ("genres", Kind::Str),
    ("country", Kind::Str),
    ("yearFrom", Kind::Int),
    ("yearTo", Kind::Int),
    ("sort", Kind::Enum(&SORTS)),
    ("order", Kind::Enum(&["asc", "desc"])),
    ("averageScoreMin", Kind::Int),
    ("averageScoreMax", Kind::Int),
    ("myScoreMin", Kind::Int),
    ("myScoreMax", Kind::Int),
];

/// A list view's filters; the default keeps the list as `AniList` sent it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct ListFilter {
    search: Option<String>,
    formats: Vec<&'static str>,
    airing: Vec<&'static str>,
    genres: Vec<String>,
    countries: Vec<&'static str>,
    year_from: Option<i64>,
    year_to: Option<i64>,
    /// The community average score range, 0–100.
    average_score: (Option<i64>, Option<i64>),
    /// The entry's own score range, 0–100 (unscored entries fail it).
    my_score: (Option<i64>, Option<i64>),
    sort: Option<&'static str>,
    descending: bool,
}

/// Comma-separated values from `allowed`, case-insensitive, each once.
fn pick_many(
    query: &Query,
    key: &str,
    allowed: &[&'static str],
) -> Result<Vec<&'static str>, String> {
    let mut out = Vec::new();
    if !query.has(key) {
        return Ok(out);
    }
    for part in query.text(key).split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let Some(value) = allowed.iter().find(|a| a.eq_ignore_ascii_case(part)) else {
            return Err(format!("{part} is not a valid {key}"));
        };
        if !out.contains(value) {
            out.push(*value);
        }
    }
    Ok(out)
}

fn year(query: &Query, key: &str) -> Result<Option<i64>, String> {
    let Some(value) = query.get(key) else {
        return Ok(None);
    };
    jsval::string_of(Some(value))
        .parse::<i64>()
        .ok()
        .filter(|y| (1900..=2100).contains(y))
        .map(Some)
        .ok_or_else(|| format!("{key} must be a year from 1900 to 2100"))
}

/// A 0–100 score bound.
fn score_bound(query: &Query, key: &str) -> Result<Option<i64>, String> {
    let Some(value) = query.get(key) else {
        return Ok(None);
    };
    jsval::string_of(Some(value))
        .parse::<i64>()
        .ok()
        .filter(|s| (0..=100).contains(s))
        .map(Some)
        .ok_or_else(|| format!("{key} must be a whole number from 0 to 100"))
}

/// Whether a score is in `(min, max)`; no score fails a set range.
fn in_range(score: Option<f64>, (min, max): (Option<i64>, Option<i64>)) -> bool {
    if min.is_none() && max.is_none() {
        return true;
    }
    score.is_some_and(|s| {
        min.is_none_or(|m| s >= crate::jsnum::from_i64(m))
            && max.is_none_or(|m| s <= crate::jsnum::from_i64(m))
    })
}

impl ListFilter {
    /// The filters a request asks for, or the 400 message.
    pub(super) fn parse(query: &Query) -> Result<Self, String> {
        let search = query
            .has("search")
            .then(|| jsval::trim(&query.text("search")).to_lowercase())
            .filter(|s| !s.is_empty());
        if search
            .as_ref()
            .is_some_and(|s| s.chars().count() > MAX_SEARCH_CHARS)
        {
            return Err(format!(
                "search must be at most {MAX_SEARCH_CHARS} characters"
            ));
        }
        let mut genres: Vec<String> = Vec::new();
        if query.has("genres") {
            for genre in query.text("genres").split(',') {
                let genre = genre.trim().to_lowercase();
                if genre.is_empty() || genres.contains(&genre) {
                    continue;
                }
                if !genre
                    .chars()
                    .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '\''))
                {
                    return Err(format!("{genre} is not an AniList genre"));
                }
                genres.push(genre);
            }
        }
        if genres.len() > MAX_GENRES {
            return Err(format!("pick at most {MAX_GENRES} genres"));
        }
        let sort = query
            .get("sort")
            .and_then(Value::as_str)
            .and_then(|s| SORTS.iter().copied().find(|x| *x == s));
        // Titles read A→Z; every score, count, and date high→low.
        let descending = match query.get("order").and_then(Value::as_str) {
            Some("asc") => false,
            Some("desc") => true,
            _ => sort != Some("title"),
        };
        Ok(Self {
            search,
            formats: pick_many(query, "format", &FORMATS)?,
            airing: pick_many(query, "airingStatus", &AIRING)?,
            genres,
            countries: pick_many(query, "country", &COUNTRIES)?,
            year_from: year(query, "yearFrom")?,
            year_to: year(query, "yearTo")?,
            average_score: (
                score_bound(query, "averageScoreMin")?,
                score_bound(query, "averageScoreMax")?,
            ),
            my_score: (
                score_bound(query, "myScoreMin")?,
                score_bound(query, "myScoreMax")?,
            ),
            sort,
            descending,
        })
    }

    /// Whether this entry passes every filter.
    fn keeps(&self, entry: &Value, media: &Value) -> bool {
        if !in_range(number(media.get("averageScore")), self.average_score)
            || !in_range(sort_value("score", entry, media), self.my_score)
        {
            return false;
        }
        let text = |key: &str| media.get(key).and_then(Value::as_str);
        if let Some(search) = &self.search {
            let titles = media.get("title");
            let hit = ["romaji", "english", "native"].iter().any(|k| {
                titles
                    .and_then(|t| t.get(*k))
                    .and_then(Value::as_str)
                    .is_some_and(|t| t.to_lowercase().contains(search.as_str()))
            });
            if !hit {
                return false;
            }
        }
        let one_of = |picked: &[&str], value: Option<&str>| {
            picked.is_empty() || value.is_some_and(|v| picked.contains(&v))
        };
        if !one_of(&self.formats, text("format"))
            || !one_of(&self.airing, text("status"))
            || !one_of(&self.countries, text("countryOfOrigin"))
        {
            return false;
        }
        if !self.genres.is_empty() {
            let have: Vec<String> = media
                .get("genres")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_lowercase)
                .collect();
            if !self.genres.iter().all(|g| have.contains(g)) {
                return false;
            }
        }
        if self.year_from.is_some() || self.year_to.is_some() {
            let Some(year) = release_year(media) else {
                return false;
            };
            if self.year_from.is_some_and(|from| year < from)
                || self.year_to.is_some_and(|to| year > to)
            {
                return false;
            }
        }
        true
    }

    /// The entries kept, sorted when a sort was picked (ties and unknown
    /// values keep the list's order, unknowns last), as media.
    pub(super) fn apply(&self, entries: Vec<(Value, Value)>) -> Vec<Value> {
        let mut kept: Vec<(Value, Value)> = entries
            .into_iter()
            .filter(|(entry, media)| self.keeps(entry, media))
            .collect();
        if let Some(sort) = self.sort {
            if sort == "title" {
                kept.sort_by(|a, b| {
                    let order = jsval::locale_compare_or_base(&title(&a.1), &title(&b.1));
                    if self.descending {
                        order.reverse()
                    } else {
                        order
                    }
                });
            } else {
                kept.sort_by(|a, b| {
                    match (sort_value(sort, &a.0, &a.1), sort_value(sort, &b.0, &b.1)) {
                        (Some(x), Some(y)) => {
                            let order = x.partial_cmp(&y).unwrap_or(Ordering::Equal);
                            if self.descending {
                                order.reverse()
                            } else {
                                order
                            }
                        }
                        (Some(_), None) => Ordering::Less,
                        (None, Some(_)) => Ordering::Greater,
                        (None, None) => Ordering::Equal,
                    }
                });
            }
        }
        kept.into_iter().map(|(_, media)| media).collect()
    }
}

fn number(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|n| n.is_finite())
}

/// The start year, else the season year.
fn release_year(media: &Value) -> Option<i64> {
    let from = |v: Option<&Value>| v.and_then(Value::as_i64).filter(|y| *y > 0);
    from(media.get("releaseDate").and_then(|d| d.get("year")))
        .or_else(|| from(media.get("startDate").and_then(|d| d.get("year"))))
        .or_else(|| from(media.get("seasonYear")))
}

/// The English title, else romaji, else native.
fn title(media: &Value) -> String {
    let titles = media.get("title");
    ["english", "romaji", "native"]
        .iter()
        .find_map(|k| {
            titles
                .and_then(|t| t.get(*k))
                .and_then(Value::as_str)
                .filter(|t| !t.trim().is_empty())
        })
        .unwrap_or_default()
        .to_owned()
}

/// What an entry sorts by; `None` when it has no value.
fn sort_value(sort: &str, entry: &Value, media: &Value) -> Option<f64> {
    match sort {
        // An unscored entry (0) sorts with the unknowns, as on anilist.co.
        "score" => number(entry.get("scoreRaw")).filter(|s| *s > 0.0),
        "progress" => number(entry.get("progress")),
        "updatedAt" | "createdAt" => number(entry.get(sort)).filter(|t| *t > 0.0),
        "averageScore" | "popularity" => number(media.get(sort)),
        "releaseDate" => {
            let date = media.get("releaseDate");
            let part = |k: &str| date.and_then(|d| d.get(k)).and_then(Value::as_f64);
            let year = part("year").or_else(|| release_year(media).map(crate::jsnum::from_i64))?;
            Some(
                part("month").unwrap_or(0.0).mul_add(100.0, year * 10_000.0)
                    + part("day").unwrap_or(0.0),
            )
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn query(pairs: &Value) -> Query {
        Query::from_map(pairs.as_object().cloned().unwrap_or_default())
    }

    fn entries() -> Vec<(Value, Value)> {
        vec![
            (
                json!({"scoreRaw": 80, "progress": 12, "updatedAt": 300}),
                json!({"id": 1, "title": {"romaji": "Shingeki", "english": "Attack on Titan"}, "format": "TV",
                       "status": "FINISHED", "countryOfOrigin": "JP", "genres": ["Action", "Drama"],
                       "averageScore": 84, "popularity": 900, "releaseDate": {"year": 2013, "month": 4, "day": 7}}),
            ),
            (
                json!({"scoreRaw": 0, "progress": 1, "updatedAt": 500}),
                json!({"id": 2, "title": {"romaji": "Na Honjaman"}, "format": "ONA", "status": "RELEASING",
                       "countryOfOrigin": "KR", "genres": ["Action", "Fantasy"], "averageScore": 82,
                       "popularity": 700, "seasonYear": 2024}),
            ),
            (
                json!({"scoreRaw": 95, "progress": 1, "updatedAt": 100}),
                json!({"id": 3, "title": {"romaji": "Kimi no Na wa", "english": "Your Name"}, "format": "MOVIE",
                       "status": "FINISHED", "countryOfOrigin": "JP", "genres": ["Drama", "Romance"],
                       "averageScore": 85, "popularity": 800, "releaseDate": {"year": 2016, "month": 8, "day": 26}}),
            ),
        ]
    }

    fn ids(filter: &ListFilter) -> Vec<i64> {
        filter
            .apply(entries())
            .iter()
            .filter_map(|m| m.get("id").and_then(Value::as_i64))
            .collect()
    }

    fn parsed(pairs: &Value) -> ListFilter {
        ListFilter::parse(&query(pairs)).unwrap_or_default()
    }

    #[test]
    fn filters() {
        assert_eq!(ids(&ListFilter::default()), vec![1, 2, 3], "untouched");
        assert_eq!(
            ids(&parsed(&json!({"search": "titan"}))),
            vec![1],
            "english title"
        );
        assert_eq!(ids(&parsed(&json!({"format": "tv,movie"}))), vec![1, 3]);
        assert_eq!(ids(&parsed(&json!({"airingStatus": "RELEASING"}))), vec![2]);
        assert_eq!(ids(&parsed(&json!({"country": "KR"}))), vec![2]);
        assert_eq!(
            ids(&parsed(&json!({"genres": "drama,action"}))),
            vec![1],
            "every genre must match"
        );
        assert_eq!(
            ids(&parsed(&json!({"yearFrom": 2014, "yearTo": 2024}))),
            vec![2, 3],
            "season year stands in"
        );
        assert_eq!(
            ids(&parsed(&json!({"averageScoreMin": 84}))),
            vec![1, 3],
            "community score"
        );
        assert_eq!(
            ids(&parsed(&json!({"myScoreMax": 90}))),
            vec![1],
            "own score; unscored entries fail a set range"
        );
        assert!(ListFilter::parse(&query(&json!({"myScoreMin": 101}))).is_err());
        assert!(ListFilter::parse(&query(&json!({"format": "DOCUMENTARY"}))).is_err());
        assert!(ListFilter::parse(&query(&json!({"yearFrom": 1800}))).is_err());
    }

    #[test]
    fn sorts() {
        assert_eq!(
            ids(&parsed(&json!({"sort": "score"}))),
            vec![3, 1, 2],
            "unscored last"
        );
        assert_eq!(ids(&parsed(&json!({"sort": "updatedAt"}))), vec![2, 1, 3]);
        assert_eq!(
            ids(&parsed(&json!({"sort": "title"}))),
            vec![1, 2, 3],
            "A→Z by default"
        );
        assert_eq!(
            ids(&parsed(&json!({"sort": "releaseDate", "order": "asc"}))),
            vec![1, 3, 2]
        );
        assert_eq!(ids(&parsed(&json!({"sort": "popularity"}))), vec![1, 3, 2]);
    }
}
