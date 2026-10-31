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
    /// Sonarr's series lookup for `term` (`anilist:21`, `mal:21`) on the
    /// lookup server; `None` when no Sonarr is set up.
    fn sonarr_lookup<'a>(&'a self, _term: &'a str) -> BoxFut<'a, Result<Option<Vec<Value>>>> {
        Box::pin(async { Ok(None) })
    }
}

/// A series Sonarr found for an `AniList` or MAL id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SonarrMatch {
    /// TMDB id.
    pub tmdb_id: i64,
    /// TVDB id.
    pub tvdb_id: Option<i64>,
    /// Sonarr's title.
    pub title: String,
}

/// Whether Sonarr's `anilist:` / `mal:` lookup may answer for an entry.
///
/// Those ids cover a whole franchise: Sonarr names the TVDB series every
/// season, film and special of it belongs to. So only an entry that is a
/// TV series (a known series format) and starts its own show (no series
/// prequel, no parent, relations known) is looked up; later seasons stay
/// with the prequel rule, and spin-offs, side stories, films, OVAs and
/// entries of unknown format or relations with the title rule.
#[must_use]
pub fn sonarr_lookup_applies(hints: &AnimeHints) -> bool {
    let series = hints
        .format
        .as_deref()
        .is_some_and(|f| SERIES_FORMATS.contains(&f));
    let Some(relations) = hints.relations.as_deref() else {
        return false;
    };
    let sequel = prequels_of(Some(relations)).iter().any(|(_, format)| {
        format
            .as_deref()
            .is_none_or(|f| SERIES_FORMATS.contains(&f))
    });
    // `PARENT`: the entry is someone's side story or spin-off, which
    // Sonarr may file under the parent's series.
    let spin_off = relations
        .iter()
        .any(|edge| edge.get("relationType").and_then(Value::as_str) == Some("PARENT"));
    series && hints.year.is_some_and(|y| y != 0) && !sequel && !spin_off
}

/// The one series Sonarr's lookup for `{ns}:{id}` found, when it has a TMDB
/// id, lists the id among its own (Sonarr 5 reports them; Sonarr 4
/// doesn't) and starts within a year of the entry.
#[must_use]
pub fn sonarr_match(found: &[Value], ns: &str, id: i64, year: i64) -> Option<SonarrMatch> {
    let [series] = found else {
        return None;
    };
    let tmdb_id = series
        .get("tmdbId")
        .and_then(Value::as_i64)
        .filter(|id| *id > 0)?;
    let ids_key = match ns {
        "anilist" => "aniListIds",
        "mal" => "malIds",
        _ => return None,
    };
    if let Some(ids) = series.get(ids_key).and_then(Value::as_array) {
        if !ids.iter().any(|v| v.as_i64() == Some(id)) {
            return None;
        }
    }
    let starts = series.get("year").and_then(Value::as_i64)?;
    if (starts - year).abs() > 1 {
        return None;
    }
    Some(SonarrMatch {
        tmdb_id,
        tvdb_id: series
            .get("tvdbId")
            .and_then(Value::as_i64)
            .filter(|id| *id > 0),
        title: series
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    })
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

    fn sonarr_lookup<'a>(&'a self, term: &'a str) -> BoxFut<'a, Result<Option<Vec<Value>>>> {
        Box::pin(async move {
            let Some(state) = super::shared() else {
                return Ok(None);
            };
            let settings = state.settings.current().await?;
            let Some(server) = crate::sonarrmeta::lookup_server(&settings) else {
                return Ok(None);
            };
            let arr = crate::arr::Arr {
                client: &state.servarr,
                server: &server,
                timeout: crate::servarr::api_timeout(&settings),
            };
            crate::sonarrmeta::lookup_series(&arr, term).await.map(Some)
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

    fn edge(relation: &str, id: i64, format: Option<&str>) -> Value {
        serde_json::json!({"relationType": relation, "node": {"id": id, "type": "ANIME", "format": format}})
    }

    #[test]
    fn sonarr_lookup_only_for_a_shows_first_entry() {
        let first = AnimeHints {
            anilist_id: Some(1),
            titles: None,
            year: Some(1998),
            format: Some(String::from("TV")),
            relations: Some(vec![edge("SIDE_STORY", 5, Some("MOVIE"))]),
        };
        assert!(sonarr_lookup_applies(&first), "a show's first season");
        let after_film = AnimeHints {
            relations: Some(vec![edge("PREQUEL", 5, Some("MOVIE"))]),
            ..first.clone()
        };
        assert!(sonarr_lookup_applies(&after_film), "a series after a film");
        for (hints, why) in [
            (
                AnimeHints {
                    format: Some(String::from("MOVIE")),
                    ..first.clone()
                },
                "a film",
            ),
            (
                AnimeHints {
                    format: Some(String::from("OVA")),
                    ..first.clone()
                },
                "an OVA",
            ),
            (
                AnimeHints {
                    format: None,
                    ..first.clone()
                },
                "unknown format",
            ),
            (
                AnimeHints {
                    relations: Some(vec![edge("PREQUEL", 2, Some("TV"))]),
                    ..first.clone()
                },
                "a later season",
            ),
            (
                AnimeHints {
                    relations: Some(vec![edge("PREQUEL", 2, None)]),
                    ..first.clone()
                },
                "a prequel of unknown format",
            ),
            (
                AnimeHints {
                    relations: Some(vec![edge("PARENT", 3, Some("TV"))]),
                    ..first.clone()
                },
                "a spin-off",
            ),
            (
                AnimeHints {
                    relations: Some(vec![edge("PARENT", 3, Some("MOVIE"))]),
                    ..first.clone()
                },
                "a film's side story",
            ),
            (
                AnimeHints {
                    relations: None,
                    ..first.clone()
                },
                "unknown relations",
            ),
            (
                AnimeHints {
                    year: None,
                    ..first
                },
                "no year",
            ),
        ] {
            assert!(!sonarr_lookup_applies(&hints), "{why}");
        }
    }

    #[test]
    fn sonarr_lookup_results() {
        let bebop = serde_json::json!({
            "title": "Cowboy Bebop", "tvdbId": 76885, "tmdbId": 30991, "year": 1998,
            "aniListIds": [1, 5], "malIds": [1, 5]
        });
        let found = Some(SonarrMatch {
            tmdb_id: 30991,
            tvdb_id: Some(76885),
            title: String::from("Cowboy Bebop"),
        });
        assert_eq!(
            sonarr_match(std::slice::from_ref(&bebop), "anilist", 1, 1998),
            found
        );
        assert_eq!(
            sonarr_match(std::slice::from_ref(&bebop), "mal", 1, 1999),
            found,
            "a year apart"
        );
        let v4 = serde_json::json!({"title": "Cowboy Bebop", "tvdbId": 76885, "tmdbId": 30991, "year": 1998});
        assert_eq!(
            sonarr_match(&[v4], "anilist", 1, 1998),
            found,
            "Sonarr 4 lists no ids"
        );
        for (results, ns, id, year, why) in [
            (vec![bebop.clone()], "anilist", 9, 1998, "not among its ids"),
            (
                vec![bebop.clone()],
                "anilist",
                1,
                2005,
                "starts years apart",
            ),
            (vec![bebop.clone()], "anidb", 1, 1998, "another namespace"),
            (vec![bebop.clone(), bebop], "anilist", 1, 1998, "two series"),
            (Vec::new(), "anilist", 1, 1998, "nothing"),
            (
                vec![serde_json::json!({"tvdbId": 1, "year": 1998})],
                "anilist",
                1,
                1998,
                "no TMDB id",
            ),
        ] {
            assert_eq!(sonarr_match(&results, ns, id, year), None, "{why}");
        }
    }
}
