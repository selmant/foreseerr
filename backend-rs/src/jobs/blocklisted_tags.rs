//! `process-blocklisted-tags`: `server/job/blocklistedTagsProcessor.ts`.
//!
//! Node runs the whole job in one transaction: it removes the media of
//! tag-blocklisted entries, then pages TMDB's discover results for every
//! blocklisted keyword and blocklists each title, and a cancellation rolls
//! all of it back. Holding a write transaction across minutes of TMDB calls
//! would block every other writer here, so the TMDB phase only collects
//! the titles; the writes Node makes are then replayed in that order in one
//! short transaction. A cancelled run writes nothing, as in Node.

use std::time::Duration;

use anyhow::Result;
use serde_json::{Map, Value};

use super::syncutil::{http_status, int, js_number_text, mutate_settings, text, Tx};
use super::JobCtx;
use crate::db::Bind;

const TMDB_API_DELAY: Duration = Duration::from_millis(250);
/// `MediaStatus.BLOCKLISTED`.
const BLOCKLISTED: i64 = 6;

const COMMON_SORT: [&str; 6] = [
    "popularity.desc",
    "popularity.asc",
    "vote_average.desc",
    "vote_average.asc",
    "vote_count.desc",
    "vote_count.asc",
];
/// `MovieSortOptionsIterable`.
const MOVIE_SORT: [&str; 14] = [
    COMMON_SORT[0],
    COMMON_SORT[1],
    COMMON_SORT[2],
    COMMON_SORT[3],
    COMMON_SORT[4],
    COMMON_SORT[5],
    "release_date.desc",
    "release_date.asc",
    "revenue.desc",
    "revenue.asc",
    "primary_release_date.desc",
    "primary_release_date.asc",
    "original_title.desc",
    "original_title.asc",
];
/// `TvSortOptionsIterable`.
const TV_SORT: [&str; 10] = [
    COMMON_SORT[0],
    COMMON_SORT[1],
    COMMON_SORT[2],
    COMMON_SORT[3],
    COMMON_SORT[4],
    COMMON_SORT[5],
    "first_air_date.desc",
    "first_air_date.asc",
    "original_name.desc",
    "original_name.asc",
];

/// One discover result to blocklist for a keyword.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Hit {
    tmdb_id: i64,
    media_type: &'static str,
    title: Option<String>,
    keyword: String,
}

/// The run's counters (`status()`).
struct Counters {
    progress: i64,
    total: i64,
}

fn report(job: &JobCtx, running: bool, c: &Counters) {
    job.progress(|p| {
        let mut status = Map::new();
        status.insert(String::from("running"), Value::Bool(running));
        status.insert(String::from("progress"), Value::from(c.progress));
        status.insert(String::from("total"), Value::from(c.total));
        p.status = status;
    });
}

/// `blocklistedTagsProcessor.run()`.
///
/// # Errors
///
/// A TMDB keyword lookup that fails other than with a 404, or a database
/// error; nothing is written then.
pub async fn run(job: &JobCtx) -> Result<()> {
    let mut counters = Counters {
        progress: 0,
        total: 0,
    };
    report(job, true, &counters);
    let result = collect_and_write(job, &mut counters).await;
    report(
        job,
        false,
        &Counters {
            progress: 0,
            total: 0,
        },
    );
    match result {
        Ok(Some(())) => Ok(()),
        Ok(None) => {
            tracing::info!(label = "Jobs", "Aborting job: Process Blocklisted Tags");
            Ok(())
        }
        Err(e) => Err(e),
    }
}

/// `Ok(None)` when the run was cancelled.
async fn collect_and_write(job: &JobCtx, counters: &mut Counters) -> Result<Option<()>> {
    let settings = &job.settings;
    let tags_setting = settings.str("/main/blocklistedTags").to_owned();
    let tags: Vec<String> = tags_setting.split(',').map(str::to_owned).collect();
    let page_limit = settings
        .get("/main/blocklistedTagsLimit")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let mut hits: Vec<Hit> = Vec::new();
    let mut invalid: Vec<String> = Vec::new();
    if !tags_setting.is_empty() {
        let per_tag = i64::try_from(MOVIE_SORT.len() + TV_SORT.len()).unwrap_or(0);
        counters.total = i64::try_from(tags.len())
            .unwrap_or(0)
            .saturating_mul(page_limit)
            .saturating_mul(per_tag);
        report(job, true, counters);
        let discover = Discover::new(job);
        for tag in &tags {
            if !discover.keyword_exists(tag).await? {
                tracing::warn!(
                    label = "Blocklisted Tags Processor",
                    keyword_id = %tag,
                    "Skipping invalid keyword in blocklisted tags"
                );
                if !invalid.contains(tag) {
                    invalid.push(tag.clone());
                }
                continue;
            }
            for media_type in ["movie", "tv"] {
                let done = discover
                    .process_tag(job, counters, media_type, tag, page_limit, &mut hits)
                    .await;
                if !done {
                    return Ok(None);
                }
            }
        }
        if !invalid.is_empty() {
            clean_invalid(job, &tags, &tags_setting, &invalid).await?;
        }
    }
    write(job, &hits).await?;
    Ok(Some(()))
}

/// Drop keywords TMDB doesn't know from `main.blocklistedTags`.
async fn clean_invalid(
    job: &JobCtx,
    tags: &[String],
    tags_setting: &str,
    invalid: &[String],
) -> Result<()> {
    let cleaned = tags
        .iter()
        .filter(|t| !invalid.contains(t))
        .cloned()
        .collect::<Vec<_>>()
        .join(",");
    if cleaned == tags_setting {
        return Ok(());
    }
    mutate_settings(&job.state, |doc| {
        if let Some(Value::Object(main)) = doc.get_mut("main") {
            main.insert(
                String::from("blocklistedTags"),
                Value::from(cleaned.clone()),
            );
        }
    })
    .await?;
    tracing::info!(
        label = "Blocklisted Tags Processor",
        removed_keywords = ?invalid,
        new_blocklisted_tags = %cleaned,
        "Cleaned up invalid keywords from settings"
    );
    Ok(())
}

/// `createTmdbWithBlocklistSettings()`.
struct Discover<'a> {
    job: &'a JobCtx,
    locale: String,
    region: String,
    original_language: Option<String>,
}

impl<'a> Discover<'a> {
    fn new(job: &'a JobCtx) -> Self {
        let s = &job.settings;
        let locale = match s.str("/main/locale") {
            "" => String::from("en"),
            other => other.to_owned(),
        };
        let region = s
            .get("/main/blocklistRegion")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let original_language = s
            .get("/main/blocklistLanguage")
            .and_then(Value::as_str)
            .map(str::to_owned);
        Self {
            job,
            locale,
            region,
            original_language,
        }
    }

    /// `getKeywordDetails`: `false` for a 404.
    async fn keyword_exists(&self, tag: &str) -> Result<bool> {
        let path = format!("/keyword/{}", js_number_text(tag));
        match self.job.state.tmdb.raw(&path, &[], 604_800).await {
            Ok(_) => Ok(true),
            Err(e) if http_status(&e) == Some(404) => Ok(false),
            Err(e) => Err(e.context("[TMDB] Failed to fetch keyword")),
        }
    }

    /// `getDiscoverMovies` / `getDiscoverTv` with `{ page, sortBy, keywords }`.
    async fn page(&self, media_type: &str, page: i64, sort: &str, tag: &str) -> Result<Value> {
        let mut params: Vec<(&str, String)> =
            vec![("sort_by", sort.to_owned()), ("page", page.to_string())];
        if media_type == "movie" {
            params.push(("include_adult", String::from("false")));
            params.push(("include_video", String::from("true")));
        }
        params.push(("language", self.locale.clone()));
        params.push(("region", self.region.clone()));
        if let Some(lang) = &self.original_language {
            params.push(("with_original_language", lang.clone()));
        }
        if media_type == "tv" {
            params.push(("include_null_first_air_dates", String::from("false")));
        }
        params.push(("with_keywords", tag.to_owned()));
        self.job
            .state
            .tmdb
            .raw(&format!("/discover/{media_type}"), &params, 300)
            .await
    }

    /// `processTagForType`: `false` when the run was cancelled.
    async fn process_tag(
        &self,
        job: &JobCtx,
        counters: &mut Counters,
        media_type: &'static str,
        tag: &str,
        page_limit: i64,
        hits: &mut Vec<Hit>,
    ) -> bool {
        let sorts: &[&str] = if media_type == "movie" {
            &MOVIE_SORT
        } else {
            &TV_SORT
        };
        let len = i64::try_from(sorts.len()).unwrap_or(1);
        let mut query_max = page_limit.saturating_mul(len);
        let mut fixed = false;
        let mut query: i64 = 0;
        while query < query_max {
            let page = if fixed { query + 1 } else { query / len + 1 };
            let sort = if fixed {
                "popularity.desc"
            } else {
                usize::try_from(query % len)
                    .ok()
                    .and_then(|i| sorts.get(i))
                    .copied()
                    .unwrap_or("popularity.desc")
            };
            if job.cancelled() {
                return false;
            }
            match self.page(media_type, page, sort, tag).await {
                Ok(response) => {
                    collect(&response, media_type, tag, hits);
                    tokio::time::sleep(TMDB_API_DELAY).await;
                    counters.progress += 1;
                    let max = i32::try_from(query_max).map_or(f64::INFINITY, f64::from);
                    let total_pages = response.get("total_pages").and_then(Value::as_f64);
                    if let Some(total_pages) = total_pages.filter(|t| page == 1 && *t <= max) {
                        let total_pages = js_int(total_pages);
                        counters.progress += query_max - total_pages;
                        fixed = true;
                        query_max = total_pages;
                        query = 0;
                    }
                    report(job, true, counters);
                }
                Err(e) => tracing::error!(
                    label = "Blocklisted Tags Processor",
                    keyword_id = %tag,
                    error_message = %format!("{e:#}"),
                    "Error processing keyword in blocklisted tags"
                ),
            }
            query += 1;
        }
        true
    }
}

/// The titles of one discover page, in order.
fn collect(response: &Value, media_type: &'static str, tag: &str, hits: &mut Vec<Hit>) {
    let Some(results) = response.get("results").and_then(Value::as_array) else {
        return;
    };
    for entry in results {
        let Some(tmdb_id) = entry.get("id").and_then(Value::as_i64) else {
            continue;
        };
        let title = match entry.get("title").or_else(|| entry.get("name")) {
            Some(Value::String(s)) => Some(s.clone()),
            _ => None,
        };
        let hit = Hit {
            tmdb_id,
            media_type,
            title,
            keyword: tag.to_owned(),
        };
        // A repeat of the same title for the same keyword changes nothing.
        if !hits.iter().any(|h| {
            h.tmdb_id == hit.tmdb_id && h.media_type == hit.media_type && h.keyword == hit.keyword
        }) {
            hits.push(hit);
        }
    }
}

/// `cleanBlocklist`, then `processResults` for every collected title, in one
/// transaction.
async fn write(job: &JobCtx, hits: &[Hit]) -> Result<()> {
    let mut tx = Tx::begin(&job.state.db).await?;
    let doomed = tx
        .rows(
            r#"SELECT CAST("media"."id" AS BIGINT) AS "id" FROM "media" INNER JOIN "blocklist" "blist" ON "blist"."tmdbId" = "media"."tmdbId" AND "blist"."mediaType" = "media"."mediaType" WHERE "blist"."blocklistedTags" IS NOT NULL"#,
            &[],
        )
        .await?;
    let ids: Vec<i64> = doomed.iter().filter_map(|r| int(r, "id")).collect();
    for chunk in ids.chunks(500) {
        let list = chunk
            .iter()
            .map(i64::to_string)
            .collect::<Vec<_>>()
            .join(", ");
        tx.execute(
            &format!(r#"DELETE FROM "season" WHERE "mediaId" IN ({list})"#),
            &[],
        )
        .await?;
        tx.execute(
            &format!(r#"DELETE FROM "media" WHERE "id" IN ({list})"#),
            &[],
        )
        .await?;
    }
    for hit in hits {
        process_hit(&mut tx, hit).await?;
    }
    tx.commit().await
}

/// One title of `processResults`.
async fn process_hit(tx: &mut Tx, hit: &Hit) -> Result<()> {
    let existing = tx
        .rows(
            r#"SELECT CAST("id" AS BIGINT) AS "id", "blocklistedTags" FROM "blocklist" WHERE "tmdbId" = ?1 AND "mediaType" = ?2 LIMIT 1"#,
            &[Bind::Int(hit.tmdb_id), Bind::Text(hit.media_type.to_owned())],
        )
        .await?;
    if let Some(entry) = existing.first() {
        let tags = text(entry, "blocklistedTags");
        if let (Some(tags), Some(id)) = (tags, int(entry, "id")) {
            if !tags.is_empty() && !tags.contains(&format!(",{},", hit.keyword)) {
                tx.execute(
                    r#"UPDATE "blocklist" SET "blocklistedTags" = ?1 WHERE "id" = ?2"#,
                    &[Bind::Text(format!("{tags}{},", hit.keyword)), Bind::Int(id)],
                )
                .await?;
            }
        }
        return Ok(());
    }
    add_to_blocklist(tx, hit).await
}

/// `Blocklist.addToBlocklist` without a user.
async fn add_to_blocklist(tx: &mut Tx, hit: &Hit) -> Result<()> {
    let media = tx
        .rows(
            r#"SELECT CAST("id" AS BIGINT) AS "id", CAST("status" AS BIGINT) AS "status", CAST("status4k" AS BIGINT) AS "status4k" FROM "media" WHERE "tmdbId" = ?1 AND "mediaType" = ?2 LIMIT 1"#,
            &[Bind::Int(hit.tmdb_id), Bind::Text(hit.media_type.to_owned())],
        )
        .await?;
    let entry = tx
        .insert_id(
            r#"INSERT INTO "blocklist" ("mediaType", "title", "tmdbId", "blocklistedTags", "createdAt") VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP) RETURNING CAST("id" AS BIGINT) AS "id""#,
            &[
                Bind::Text(hit.media_type.to_owned()),
                Bind::OptText(hit.title.clone()),
                Bind::Int(hit.tmdb_id),
                Bind::Text(format!(",{},", hit.keyword)),
            ],
        )
        .await?;
    let media_id = if let Some(m) = media.first() {
        let id = int(m, "id").unwrap_or(0);
        if int(m, "status") != Some(BLOCKLISTED) || int(m, "status4k") != Some(BLOCKLISTED) {
            tx.execute(
                r#"UPDATE "media" SET "status" = ?1, "status4k" = ?1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?2"#,
                &[Bind::Int(BLOCKLISTED), Bind::Int(id)],
            )
            .await?;
        }
        id
    } else {
        tx.insert_id(
            r#"INSERT INTO "media" ("mediaType", "tmdbId", "tvdbId", "status", "status4k", "createdAt", "updatedAt", "lastSeasonChange", "mediaAddedAt") VALUES (?1, ?2, NULL, ?3, ?3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING CAST("id" AS BIGINT) AS "id""#,
            &[
                Bind::Text(hit.media_type.to_owned()),
                Bind::Int(hit.tmdb_id),
                Bind::Int(BLOCKLISTED),
            ],
        )
        .await?
    };
    tx.execute(
        r#"UPDATE "blocklist" SET "mediaId" = ?1 WHERE "id" = ?2"#,
        &[Bind::Int(media_id), Bind::Int(entry)],
    )
    .await?;
    Ok(())
}

/// A whole page count (TMDB sends integers).
fn js_int(n: f64) -> i64 {
    format!("{:.0}", n.floor()).parse().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sort_option_counts() {
        assert_eq!(MOVIE_SORT.len() + TV_SORT.len(), 24, "per tag and page");
        assert_eq!(MOVIE_SORT.get(6), Some(&"release_date.desc"), "movie order");
        assert_eq!(TV_SORT.get(9), Some(&"original_name.asc"), "tv order");
    }

    #[test]
    fn collects_titles_once_per_keyword() {
        let mut hits = Vec::new();
        let page = json!({"results": [
            {"id": 1, "title": "A"},
            {"id": 2, "name": "B"},
            {"id": 1, "title": "A again"}
        ]});
        collect(&page, "movie", "9", &mut hits);
        collect(&page, "movie", "10", &mut hits);
        assert_eq!(hits.len(), 4, "two titles for two keywords");
        assert_eq!(
            hits.first().and_then(|h| h.title.clone()),
            Some(String::from("A")),
            "the first sighting names it"
        );
        assert_eq!(
            hits.get(1).and_then(|h| h.title.clone()),
            Some(String::from("B")),
            "tv names"
        );
    }

    #[test]
    fn keyword_ids() {
        assert_eq!(js_number_text("12"), "12", "plain");
        assert_eq!(js_number_text(" 7 "), "7", "trimmed");
        assert_eq!(js_number_text(""), "0", "empty is zero");
        assert_eq!(js_number_text("abc"), "NaN", "not a number");
    }
}
