//! `server/lib/mapping/derive.ts`: a TMDB id for an anime no dataset
//! knows yet, by exact title (rule A) or through its prequel (rule B).

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;

use anyhow::Result;
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;
use unicode_properties::{GeneralCategoryGroup, UnicodeGeneralCategory};

use super::{edges, Ctx, IdRef, MediaType};
use crate::anilist::{Anilist, AnilistError};

/// A boxed future.
pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// `AnimeHints`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AnimeHints {
    /// `anilistId`.
    pub anilist_id: Option<i64>,
    /// Titles to try, most specific first; `None` when not given.
    pub titles: Option<Vec<String>>,
    /// Year.
    pub year: Option<i64>,
    /// `AniList` format.
    pub format: Option<String>,
    /// Relation edges; `None` lets the fallback ask `AniList`.
    pub relations: Option<Vec<Value>>,
}

/// `DerivedTmdb`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Derived {
    /// TMDB id.
    pub tmdb_id: i64,
    /// Namespace.
    pub media_type: MediaType,
    /// `title` or `prequel`.
    pub origin: &'static str,
    /// What matched.
    pub detail: String,
}

/// `TitleHit`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TitleHit {
    /// TMDB id.
    pub id: i64,
    /// Title.
    pub name: Option<String>,
    /// Original title.
    pub original_name: Option<String>,
    /// Release year.
    pub year: Option<i64>,
    /// Genre ids.
    pub genre_ids: Vec<i64>,
}

/// `DeriveDeps`: the TMDB title search and the `AniList` lookup.
pub trait DeriveDeps: Send + Sync {
    /// `search(mediaType, query)` (never fails: TMDB errors read as no
    /// results).
    fn search<'a>(&'a self, media_type: MediaType, query: &'a str) -> BoxFut<'a, Vec<TitleHit>>;
    /// `anilistMedia(id)`: the entry with its relations, `None` when
    /// `AniList` has no such entry.
    fn anilist_media(&self, anilist_id: i64) -> BoxFut<'_, Result<Option<Value>>>;
}

const ANIMATION_GENRE: i64 = 16;
const SERIES_FORMATS: [&str; 3] = ["TV", "TV_SHORT", "ONA"];
const MAX_TITLES: usize = 3;
const MAX_PREQUEL_HOPS: usize = 6;
const MAX_RELATION_FETCHES: usize = 3;

fn year_of(date: Option<&Value>) -> Option<i64> {
    let text = date.and_then(Value::as_str)?;
    let head: String = text.chars().take(4).collect();
    let n = crate::jsval::number_of_str(&head);
    (n.is_finite() && n > 1870.0)
        .then(|| super::int_of(n))
        .flatten()
}

/// `titleKey(value)`: NFKC, lower case, letters and digits only.
#[must_use]
pub fn title_key(value: Option<&str>) -> String {
    let normalized: String = value.unwrap_or_default().nfkc().collect();
    normalized
        .to_lowercase()
        .chars()
        .filter(|c| {
            matches!(
                c.general_category_group(),
                GeneralCategoryGroup::Letter | GeneralCategoryGroup::Number
            )
        })
        .collect()
}

/// The TMDB title search and `AniList` over the network, as Node's
/// `defaultDeps()` builds them.
#[derive(Debug)]
pub struct NetDeps<'a> {
    ctx: &'a Ctx<'a>,
}

impl<'a> NetDeps<'a> {
    /// Over `ctx`'s clients.
    #[must_use]
    pub const fn new(ctx: &'a Ctx<'a>) -> Self {
        Self { ctx }
    }
}

/// The shared `AnilistAPI` instance of the fallback lookups, whose
/// limiter lets one request a second through.
static ANILIST_PACE: crate::anilist::Pace = crate::anilist::Pace::new();

impl DeriveDeps for NetDeps<'_> {
    fn search<'a>(&'a self, media_type: MediaType, query: &'a str) -> BoxFut<'a, Vec<TitleHit>> {
        Box::pin(async move {
            let path = format!("/search/{}", media_type.as_str());
            let params = [
                ("query", query.to_owned()),
                ("page", String::from("1")),
                ("include_adult", String::from("true")),
                ("language", self.ctx.locale.clone()),
            ];
            let Ok(page) = self.ctx.tmdb.raw(&path, &params, 300).await else {
                return Vec::new();
            };
            let (name, original, released) = match media_type {
                MediaType::Movie => ("title", "original_title", "release_date"),
                MediaType::Tv => ("name", "original_name", "first_air_date"),
            };
            page.get("results")
                .and_then(Value::as_array)
                .map(|results| {
                    results
                        .iter()
                        .map(|r| TitleHit {
                            id: r.get("id").and_then(Value::as_i64).unwrap_or(0),
                            name: r.get(name).and_then(Value::as_str).map(str::to_owned),
                            original_name: r
                                .get(original)
                                .and_then(Value::as_str)
                                .map(str::to_owned),
                            year: year_of(r.get(released)),
                            genre_ids: r
                                .get("genre_ids")
                                .and_then(Value::as_array)
                                .map(|g| g.iter().filter_map(Value::as_i64).collect())
                                .unwrap_or_default(),
                        })
                        .collect()
                })
                .unwrap_or_default()
        })
    }

    fn anilist_media(&self, anilist_id: i64) -> BoxFut<'_, Result<Option<Value>>> {
        Box::pin(async move {
            let client = Anilist::new(self.ctx.http, None).paced(&ANILIST_PACE);
            match client.media_with_relations(anilist_id).await {
                Ok(media) => Ok(media),
                Err(AnilistError::GraphQl(_) | AnilistError::Http(404)) => Ok(None),
                Err(e) => Err(anyhow::anyhow!(e.message())),
            }
        })
    }
}

/// Rule A: exactly one TMDB record with the same title, year (±1) and
/// the Animation genre.
async fn by_exact_title(
    hints: &AnimeHints,
    media_type: MediaType,
    deps: &dyn DeriveDeps,
) -> Option<Derived> {
    let year = hints.year.filter(|y| *y != 0)?;
    let mut seen = HashSet::new();
    let titles: Vec<&String> = hints
        .titles
        .iter()
        .flatten()
        .filter(|t| !crate::jsval::trim(t).is_empty())
        .filter(|t| seen.insert(t.as_str()))
        .collect();
    for title in titles.into_iter().take(MAX_TITLES) {
        let wanted = title_key(Some(title));
        if wanted.is_empty() {
            continue;
        }
        let matches: Vec<TitleHit> = deps
            .search(media_type, title)
            .await
            .into_iter()
            .filter(|hit| {
                (title_key(hit.name.as_deref()) == wanted
                    || title_key(hit.original_name.as_deref()) == wanted)
                    && hit.year.is_some_and(|y| (y - year).abs() <= 1)
                    && hit.genre_ids.contains(&ANIMATION_GENRE)
            })
            .collect();
        match matches.as_slice() {
            [hit] => {
                return Some(Derived {
                    tmdb_id: hit.id,
                    media_type,
                    origin: "title",
                    detail: format!(
                        "\"{title}\" ({})",
                        hit.year
                            .map_or_else(|| String::from("undefined"), |y| y.to_string())
                    ),
                });
            }
            [] => {}
            _ => return None,
        }
    }
    None
}

/// `prequelsOf(relations)`.
fn prequels_of(relations: Option<&[Value]>) -> Vec<(i64, Option<String>)> {
    relations
        .unwrap_or_default()
        .iter()
        .filter_map(|edge| {
            if edge.get("relationType").and_then(Value::as_str) != Some("PREQUEL") {
                return None;
            }
            let node = edge.get("node").filter(|n| !n.is_null())?;
            let id = node
                .get("id")
                .and_then(Value::as_i64)
                .filter(|id| *id != 0)?;
            let kind = node
                .get("type")
                .filter(|t| !t.is_null())
                .and_then(Value::as_str)
                .unwrap_or("ANIME");
            (kind == "ANIME").then(|| {
                (
                    id,
                    node.get("format")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                )
            })
        })
        .collect()
}

fn relation_edges(media: &Value) -> Option<Vec<Value>> {
    media
        .get("relations")
        .filter(|r| !r.is_null())
        .and_then(|r| r.get("edges"))
        .and_then(Value::as_array)
        .cloned()
}

/// Rule B: the show the nearest mapped series prequel belongs to.
async fn by_prequel(
    ctx: &Ctx<'_>,
    hints: &AnimeHints,
    deps: &dyn DeriveDeps,
) -> Result<Option<Derived>> {
    let mut frontier = prequels_of(hints.relations.as_deref());
    let mut seen: HashSet<i64> = hints.anilist_id.filter(|id| *id != 0).into_iter().collect();
    let mut fetches = 0;
    let mut hop = 0;
    while hop < MAX_PREQUEL_HOPS && !frontier.is_empty() {
        let mut next = Vec::new();
        for (id, format) in frontier {
            if !seen.insert(id) {
                continue;
            }
            if !format
                .as_deref()
                .is_some_and(|f| SERIES_FORMATS.contains(&f))
            {
                continue;
            }
            let pivot = IdRef::new("anilist", &id.to_string());
            if let Some(known) =
                edges::dataset_tmdb(ctx.db, &pivot, Some(MediaType::Tv), false).await?
            {
                return Ok(Some(Derived {
                    tmdb_id: known.tmdb_id,
                    media_type: MediaType::Tv,
                    origin: "prequel",
                    detail: format!("prequel anilist:{id}"),
                }));
            }
            if fetches >= MAX_RELATION_FETCHES {
                continue;
            }
            fetches += 1;
            let media = deps.anilist_media(id).await?;
            next.extend(prequels_of(
                media.as_ref().and_then(relation_edges).as_deref(),
            ));
        }
        frontier = next;
        hop += 1;
    }
    Ok(None)
}

/// `deriveTmdb(hints, mediaType, deps)`: rule A, then (asking `AniList`
/// for titles and relations the caller lacked) rule A again and rule B.
///
/// # Errors
///
/// `AniList` failures other than "no such entry", and database errors.
pub async fn derive_tmdb(
    ctx: &Ctx<'_>,
    hints: &AnimeHints,
    media_type: MediaType,
    deps: &dyn DeriveDeps,
) -> Result<Option<Derived>> {
    if let Some(titled) = by_exact_title(hints, media_type, deps).await {
        return Ok(Some(titled));
    }
    let mut known = hints.clone();
    if let (Some(anilist_id), None) = (hints.anilist_id.filter(|id| *id != 0), &hints.relations) {
        if let Some(media) = deps.anilist_media(anilist_id).await? {
            let mut tried: HashSet<String> = if hints.year.is_some_and(|y| y != 0) {
                hints
                    .titles
                    .iter()
                    .flatten()
                    .map(|t| title_key(Some(t)))
                    .collect()
            } else {
                HashSet::new()
            };
            let title = media.get("title").filter(|t| !t.is_null());
            let field = |k: &str| title.and_then(|t| t.get(k)).and_then(Value::as_str);
            let fresh: Vec<String> = [field("native"), field("romaji"), field("english")]
                .into_iter()
                .flatten()
                .map(str::to_owned)
                .chain(hints.titles.iter().flatten().cloned())
                .filter(|t| {
                    let key = title_key(Some(t));
                    !key.is_empty() && tried.insert(key)
                })
                .collect();
            let year = media
                .get("startDate")
                .filter(|d| !d.is_null())
                .and_then(|d| d.get("year"))
                .filter(|y| !y.is_null())
                .or_else(|| media.get("seasonYear").filter(|y| !y.is_null()))
                .and_then(Value::as_f64)
                .and_then(super::int_of)
                .or(hints.year);
            known = AnimeHints {
                anilist_id: hints.anilist_id,
                titles: Some(fresh),
                year,
                format: media
                    .get("format")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| hints.format.clone()),
                relations: Some(relation_edges(&media).unwrap_or_default()),
            };
            if known.titles.as_ref().is_some_and(|t| !t.is_empty()) {
                if let Some(retitled) = by_exact_title(&known, media_type, deps).await {
                    return Ok(Some(retitled));
                }
            }
        }
    }
    let is_series = media_type == MediaType::Tv
        && known
            .format
            .as_deref()
            .is_none_or(|f| f.is_empty() || SERIES_FORMATS.contains(&f));
    if is_series {
        by_prequel(ctx, &known, deps).await
    } else {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Fake {
        answers: Vec<(&'static str, Vec<TitleHit>)>,
        asked: Mutex<Vec<String>>,
    }

    impl DeriveDeps for Fake {
        fn search<'a>(&'a self, _: MediaType, query: &'a str) -> BoxFut<'a, Vec<TitleHit>> {
            crate::sync::lock(&self.asked).push(query.to_owned());
            let hits = self
                .answers
                .iter()
                .find(|(q, _)| *q == query)
                .map(|(_, h)| h.clone())
                .unwrap_or_default();
            Box::pin(async move { hits })
        }

        fn anilist_media(&self, _: i64) -> BoxFut<'_, Result<Option<Value>>> {
            Box::pin(async { Err(anyhow::anyhow!("AniList should not be asked")) })
        }
    }

    fn hit(id: i64, name: &str, year: i64, genres: &[i64]) -> TitleHit {
        TitleHit {
            id,
            name: Some(name.to_owned()),
            original_name: None,
            year: Some(year),
            genre_ids: genres.to_vec(),
        }
    }

    fn hints(titles: &[&str], year: Option<i64>) -> AnimeHints {
        AnimeHints {
            titles: Some(titles.iter().map(|t| (*t).to_owned()).collect()),
            year,
            relations: Some(Vec::new()),
            format: Some(String::from("MOVIE")),
            ..AnimeHints::default()
        }
    }

    #[test]
    fn title_keys() {
        assert_eq!(title_key(Some("SAKAMOTO DAYS")), "sakamotodays", "ascii");
        assert_eq!(
            title_key(Some("Sakamoto  Days!")),
            title_key(Some("sakamoto-days")),
            "punctuation and spacing"
        );
        assert_eq!(title_key(Some("ダンダダン")), "ダンダダン", "Japanese");
        assert_eq!(
            title_key(Some("ＳＰＹ×ＦＡＭＩＬＹ")),
            "spyfamily",
            "full width"
        );
        assert_eq!(title_key(None), "", "nothing");
    }

    #[tokio::test]
    async fn exact_title_rule() {
        let fake = Fake {
            answers: vec![
                ("Sakamoto Days", vec![hit(1, "SAKAMOTO DAYS", 2025, &[16])]),
                ("Live", vec![hit(2, "Live", 2025, &[18])]),
                ("Near", vec![hit(3, "Near Miss", 2025, &[16])]),
                ("Remake", vec![hit(4, "Remake", 2010, &[16])]),
                (
                    "Twice",
                    vec![hit(5, "Twice", 2025, &[16]), hit(6, "Twice", 2024, &[16])],
                ),
            ],
            asked: Mutex::new(Vec::new()),
        };
        let found = by_exact_title(&hints(&["Sakamoto Days"], Some(2025)), MediaType::Tv, &fake)
            .await
            .map(|d| (d.tmdb_id, d.origin, d.detail));
        assert_eq!(
            found,
            Some((1, "title", String::from("\"Sakamoto Days\" (2025)"))),
            "one exact match"
        );
        for (title, why) in [
            ("Live", "live action"),
            ("Near", "near match"),
            ("Remake", "another year"),
        ] {
            assert_eq!(
                by_exact_title(&hints(&[title], Some(2025)), MediaType::Tv, &fake).await,
                None,
                "{why}"
            );
        }
        crate::sync::lock(&fake.asked).clear();
        assert_eq!(
            by_exact_title(
                &hints(&["Twice", "Sakamoto Days"], Some(2025)),
                MediaType::Tv,
                &fake
            )
            .await,
            None,
            "two exact matches"
        );
        assert_eq!(
            crate::sync::lock(&fake.asked).clone(),
            vec![String::from("Twice")],
            "no other spelling tried"
        );
        assert_eq!(
            by_exact_title(&hints(&["Sakamoto Days"], None), MediaType::Tv, &fake).await,
            None,
            "no year"
        );
    }
}
