//! What people did with their picks, without pressing a button: they
//! requested a pick, watched it later, or rated it on Trakt or Simkl.
//!
//! Signals are found by joining `ai_pick` (every title a run suggested)
//! with requests, watch history and ratings, and kept in `ai_signal`, one
//! per title and kind. They stay on this server; requests steer later picks
//! like a "like", and watches and ratings only reach the model when the
//! person allowed their watch history to be used.

use std::collections::HashMap;

use anyhow::Result;
use serde_json::Value;

use super::retrieve::{kind_of, Key};
use crate::db::{Bind, Db};
use crate::jobs::syncutil::Tx;
use crate::mappinglayer::watched::WatchedSets;
use crate::settings::Settings;
use crate::state::AppState;

/// A rating at or above this (out of 10) counts as liking a pick.
const LIKED_FROM: i64 = 7;
/// A rating at or below this counts as disliking it.
const DISLIKED_TO: i64 = 4;

/// One signal.
#[derive(Debug, Clone)]
pub struct Signal {
    /// Row id.
    pub id: i64,
    /// `requested`, `watched` or `rated`.
    pub kind: String,
    /// The rating out of 10, for `rated`.
    pub rating: Option<i64>,
    /// The title when it was suggested.
    pub title: String,
}

impl Signal {
    /// Whether it is history (watched or rated), which needs consent.
    #[must_use]
    pub fn is_history(&self) -> bool {
        self.kind != "requested"
    }

    /// As a line for the model: liked (`true`) or to avoid (`false`), or
    /// nothing for a middling rating.
    #[must_use]
    pub fn line(&self) -> Option<(bool, String)> {
        let title = if self.title.is_empty() {
            "A suggested title"
        } else {
            self.title.as_str()
        };
        match (self.kind.as_str(), self.rating) {
            ("requested", _) => Some((
                true,
                format!("{title} (requested it after it was suggested)"),
            )),
            ("watched", _) => Some((true, format!("{title} (watched it after it was suggested)"))),
            ("rated", Some(r)) if r >= LIKED_FROM => Some((
                true,
                format!("{title} (rated it {r}/10 after it was suggested)"),
            )),
            ("rated", Some(r)) if r <= DISLIKED_TO => Some((
                false,
                format!("{title} (rated it {r}/10 after it was suggested)"),
            )),
            _ => None,
        }
    }
}

fn signal_of(r: &serde_json::Map<String, Value>) -> Option<Signal> {
    Some(Signal {
        id: r.get("id")?.as_i64()?,
        kind: r.get("kind")?.as_str()?.to_owned(),
        rating: r.get("rating").and_then(Value::as_i64),
        title: r
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    })
}

/// A title this user was suggested.
#[derive(Debug, Clone)]
struct Picked {
    title: String,
    model: Option<String>,
    /// When it was first suggested (ISO).
    at: String,
}

/// Titles this user was suggested, with the title and model of the latest
/// suggestion.
async fn picked(db: &Db, tx: &mut Tx, user_id: i64) -> Result<HashMap<Key, Picked>> {
    let rows = tx
        .rows(
            &format!(
                r#"SELECT p."mediaType", CAST(p."tmdbId" AS BIGINT) AS "tmdbId", MAX(p."title") AS "title", MAX(r."model") AS "model", MIN({}) AS "at" FROM "ai_pick" p JOIN "ai_run" r ON r."id" = p."runId" WHERE p."userId" = ?1 AND NOT EXISTS (SELECT 1 FROM "ai_history_ignore" i WHERE i."userId" = p."userId" AND i."mediaType" = p."mediaType" AND i."tmdbId" = p."tmdbId") GROUP BY p."mediaType", p."tmdbId""#,
                db.iso_sql(r#"p."createdAt""#)
            ),
            &[Bind::Int(user_id)],
        )
        .await?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            let key = (
                kind_of(r.get("mediaType")?.as_str()?),
                r.get("tmdbId")?.as_i64()?,
            );
            let title = r
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let model = r.get("model").and_then(Value::as_str).map(str::to_owned);
            let at = r.get("at").and_then(Value::as_str)?.to_owned();
            Some((key, Picked { title, model, at }))
        })
        .collect())
}

/// Record a signal. A changed rating replaces the old one and is learned
/// again.
async fn insert(
    tx: &mut Tx,
    user_id: i64,
    key: Key,
    kind: &str,
    rating: Option<i64>,
    Picked { title, model, .. }: &Picked,
) -> Result<()> {
    tx.execute(
        r#"INSERT INTO "ai_signal" ("userId", "mediaType", "tmdbId", "kind", "rating", "title", "model") VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT ("userId", "mediaType", "tmdbId", "kind") DO UPDATE SET "rating" = excluded."rating", "learned" = ?8 WHERE "ai_signal"."rating" IS DISTINCT FROM excluded."rating""#,
        &[
            Bind::Int(user_id),
            Bind::Text(key.0.to_owned()),
            Bind::Int(key.1),
            Bind::Text(kind.to_owned()),
            Bind::OptInt(rating),
            Bind::Text(title.clone()),
            Bind::OptText(model.clone()),
            Bind::Bool(false),
        ],
    )
    .await?;
    Ok(())
}

/// Whether an action dated `at` (ISO; `None` when the source has no date)
/// came after the title was suggested. Undated actions count: titles
/// already watched were left out of the picks, so a later watch or rating
/// of a pick is new.
fn after(at: Option<&str>, pick: &Picked) -> bool {
    at.is_none_or(|at| at >= pick.at.as_str())
}

/// Titles this user watched on Simkl, with when.
async fn simkl_watched(db: &Db, user_id: i64) -> Result<Vec<(Key, Option<String>)>> {
    let rows = db
        .rows(
            &format!(
                r#"SELECT "simklType", "animeType", CAST("tmdbId" AS BIGINT) AS "tmdbId", {} AS "at" FROM "simkl_sync_item" WHERE "userId" = ?1 AND "tmdbId" IS NOT NULL AND "lastWatchedAt" IS NOT NULL"#,
                db.iso_sql(r#""lastWatchedAt""#)
            ),
            &[Bind::Int(user_id)],
        )
        .await?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let id = row.get("tmdbId").and_then(Value::as_i64)?;
            let at = row.get("at").and_then(Value::as_str).map(str::to_owned);
            Some(((simkl_kind(row), id), at))
        })
        .collect())
}

/// `movie` or `tv` for a Simkl row (anime movies are movies).
fn simkl_kind(row: &serde_json::Map<String, Value>) -> &'static str {
    let simkl_type = row.get("simklType").and_then(Value::as_str);
    let movie = simkl_type == Some("movie")
        || simkl_type == Some("anime")
            && row.get("animeType").and_then(Value::as_str) == Some("movie");
    if movie {
        "movie"
    } else {
        "tv"
    }
}

/// Ratings out of 10 this user gave on Simkl and (with `trakt`) Trakt,
/// with when (Trakt dates its ratings; Simkl doesn't).
async fn ratings(
    state: &AppState,
    settings: &Settings,
    user_id: i64,
    trakt: bool,
) -> HashMap<Key, (i64, Option<String>)> {
    let mut out = HashMap::new();
    let simkl = state.db.rows(r#"SELECT "simklType", "animeType", CAST("tmdbId" AS BIGINT) AS "tmdbId", "userRating" FROM "simkl_sync_item" WHERE "userId" = ?1 AND "tmdbId" IS NOT NULL AND "userRating" IS NOT NULL"#, &[Bind::Int(user_id)]).await.unwrap_or_default();
    for row in simkl {
        let (Some(id), Some(rating)) = (
            row.get("tmdbId").and_then(Value::as_i64),
            row.get("userRating").and_then(Value::as_f64),
        ) else {
            continue;
        };
        if let Ok(rating) = format!("{rating:.0}").parse::<i64>() {
            out.insert((simkl_kind(&row), id), (rating, None));
        }
    }
    if trakt {
        if let Ok(client) = crate::mediaactions::trakt::user_client(state, settings, user_id).await
        {
            if let Ok(snap) = crate::mappinglayer::synccache::warm_trakt(&client, user_id).await {
                for (items, key, kind) in [
                    (&snap.ratings_movies, "movie", "movie"),
                    (&snap.ratings_shows, "show", "tv"),
                ] {
                    for r in items {
                        let id = r
                            .pointer(&format!("/{key}/ids/tmdb"))
                            .and_then(Value::as_i64);
                        let rating = r.get("rating").and_then(Value::as_i64);
                        let at = r.get("rated_at").and_then(Value::as_str).map(str::to_owned);
                        if let (Some(id), Some(rating)) = (id, rating) {
                            out.insert((kind, id), (rating, at));
                        }
                    }
                }
            }
        }
    }
    out
}

/// Record what this user did with their picks since the last sync.
/// `watched` is their combined watch history; `trakt` also reads Trakt
/// ratings (a network call, so the nightly job does it).
///
/// # Errors
///
/// Fails on database errors.
pub async fn sync(
    state: &AppState,
    settings: &Settings,
    user_id: i64,
    watched: Option<&WatchedSets>,
    trakt: bool,
) -> Result<()> {
    let db = &state.db;
    // Fetch network-backed data before locking. All writes then serialize
    // with Forget all ratings, including writes from an already running sync.
    let ratings = ratings(state, settings, user_id, trakt).await;
    let simkl_seen = simkl_watched(db, user_id).await?;
    let mut tx = Tx::begin(db).await?;
    lock_user(&mut tx, user_id).await?;
    let at = |col: &str| db.iso_sql(col);
    tx.execute(
        &format!(
            r#"INSERT INTO "ai_signal" ("userId", "mediaType", "tmdbId", "kind", "title", "model") SELECT p."userId", p."mediaType", p."tmdbId", 'requested', MAX(p."title"), MAX(r."model") FROM "ai_pick" p JOIN "ai_run" r ON r."id" = p."runId" JOIN "media" m ON m."tmdbId" = p."tmdbId" AND m."mediaType" = p."mediaType" JOIN "media_request" q ON q."mediaId" = m."id" AND q."requestedById" = p."userId" WHERE p."userId" = ?1 AND {} >= {} GROUP BY p."userId", p."mediaType", p."tmdbId" ON CONFLICT ("userId", "mediaType", "tmdbId", "kind") DO NOTHING"#,
            at(r#"q."createdAt""#),
            at(r#"p."createdAt""#)
        ),
        &[Bind::Int(user_id)],
    )
    .await?;
    let picks = picked(db, &mut tx, user_id).await?;
    if picks.is_empty() {
        return tx.commit().await;
    }
    let mut seen: Vec<(Key, Option<String>)> = Vec::new();
    if let Some(watched) = watched {
        for (kind, ids) in [("movie", &watched.movie), ("tv", &watched.tv)] {
            for id in ids {
                if let Ok(id) = format!("{id:.0}").parse::<i64>() {
                    seen.push(((kind, id), None));
                }
            }
        }
    }
    seen.extend(simkl_seen);
    for (key, at) in seen {
        if let Some(pick) = picks.get(&key).filter(|p| after(at.as_deref(), p)) {
            insert(&mut tx, user_id, key, "watched", None, pick).await?;
        }
    }
    for (key, (rating, at)) in ratings {
        if let Some(pick) = picks.get(&key).filter(|p| after(at.as_deref(), p)) {
            insert(&mut tx, user_id, key, "rated", Some(rating), pick).await?;
        }
    }
    tx.commit().await
}

/// Serialize signal writes and resets for one user. `SQLite` already holds
/// its writer lock; `PostgreSQL` uses the user row for the transaction's life.
/// # Errors
/// Fails on database errors.
pub(super) async fn lock_user(tx: &mut Tx, user_id: i64) -> Result<()> {
    if tx.is_postgres() {
        tx.rows(
            r#"SELECT "id" FROM "user" WHERE "id" = ?1 FOR UPDATE"#,
            &[Bind::Int(user_id)],
        )
        .await?;
    }
    Ok(())
}

/// This user's signals, newest first. `history` includes watches and
/// ratings (only with their consent to use watch history).
///
/// # Errors
///
/// Fails on database errors.
pub async fn recent(db: &Db, user_id: i64, history: bool, limit: i64) -> Result<Vec<Signal>> {
    let filter = if history {
        ""
    } else {
        r#" AND "kind" = 'requested'"#
    };
    Ok(db
        .rows(
            &format!(
                r#"SELECT CAST("id" AS BIGINT) AS "id", "kind", CAST("rating" AS BIGINT) AS "rating", "title" FROM "ai_signal" WHERE "userId" = ?1{filter} ORDER BY "id" DESC LIMIT ?2"#
            ),
            &[Bind::Int(user_id), Bind::Int(limit)],
        )
        .await?
        .iter()
        .filter_map(signal_of)
        .collect())
}

/// Signals not yet folded into the taste card.
///
/// # Errors
///
/// Fails on database errors.
pub async fn unlearned(db: &Db, user_id: i64, history: bool) -> Result<Vec<Signal>> {
    let filter = if history {
        ""
    } else {
        r#" AND "kind" = 'requested'"#
    };
    Ok(db
        .rows(
            &format!(
                r#"SELECT CAST("id" AS BIGINT) AS "id", "kind", CAST("rating" AS BIGINT) AS "rating", "title" FROM "ai_signal" WHERE "userId" = ?1 AND "learned" = ?2{filter} ORDER BY "id" LIMIT 40"#
            ),
            &[Bind::Int(user_id), Bind::Bool(false)],
        )
        .await?
        .iter()
        .filter_map(signal_of)
        .collect())
}

/// Mark signals as folded into the taste card.
///
/// # Errors
///
/// Fails on database errors.
pub async fn mark_learned(db: &Db, user_id: i64, ids: &[i64]) -> Result<()> {
    for id in ids {
        db.execute(
            r#"UPDATE "ai_signal" SET "learned" = ?1 WHERE "id" = ?2 AND "userId" = ?3"#,
            &[Bind::Bool(true), Bind::Int(*id), Bind::Int(user_id)],
        )
        .await?;
    }
    Ok(())
}

/// How picks did since `since_iso`: titles suggested, and how many of
/// them were requested, watched, liked or rated well.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Outcomes {
    /// Distinct titles suggested.
    pub picks: i64,
    /// Requested after being suggested.
    pub requested: i64,
    /// Watched after being suggested.
    pub watched: i64,
    /// Liked (button) or rated 7+ after being suggested.
    pub liked: i64,
}

impl Outcomes {
    /// As the API returns it.
    #[must_use]
    pub fn to_json(self) -> Value {
        serde_json::json!({
            "picks": self.picks,
            "requested": self.requested,
            "watched": self.watched,
            "liked": self.liked,
        })
    }
}

/// Outcomes per user (`None` key: everyone) since `since_iso`.
///
/// # Errors
///
/// Fails on database errors.
pub async fn outcomes(db: &Db, since_iso: &str) -> Result<HashMap<i64, Outcomes>> {
    outcomes_for(db, since_iso, None).await
}

/// One user's outcomes, filtered before aggregation.
/// # Errors
/// Fails on database errors.
pub async fn user_outcomes(db: &Db, since_iso: &str, user_id: i64) -> Result<Outcomes> {
    Ok(outcomes_for(db, since_iso, Some(user_id))
        .await?
        .remove(&user_id)
        .unwrap_or_default())
}

async fn outcomes_for(
    db: &Db,
    since_iso: &str,
    user_id: Option<i64>,
) -> Result<HashMap<i64, Outcomes>> {
    let filter = |alias: &str, position: i32| {
        user_id.map_or_else(String::new, |_| {
            format!(r#" AND {alias}."userId" = ?{position}"#)
        })
    };
    let binds = |mut values: Vec<Bind>| {
        if let Some(id) = user_id {
            values.push(Bind::Int(id));
        }
        values
    };
    let created = |t: &str| db.iso_sql(&format!(r#"{t}."createdAt""#));
    let mut out: HashMap<i64, Outcomes> = HashMap::new();
    let picks = db
        .rows(
            &format!(
                r#"SELECT CAST(p."userId" AS BIGINT) AS "userId", CAST(COUNT(DISTINCT p."mediaType" || ':' || CAST(p."tmdbId" AS VARCHAR)) AS BIGINT) AS "n" FROM "ai_pick" p WHERE {} >= ?1{} GROUP BY p."userId""#,
                created("p"), filter("p", 2)
            ),
            &binds(vec![Bind::Text(since_iso.to_owned())]),
        )
        .await?;
    for r in picks {
        if let (Some(u), Some(n)) = (
            r.get("userId").and_then(Value::as_i64),
            r.get("n").and_then(Value::as_i64),
        ) {
            out.entry(u).or_default().picks = n;
        }
    }
    let signals = db
        .rows(
            &format!(
                r#"SELECT CAST(s."userId" AS BIGINT) AS "userId", s."kind", CAST(COUNT(*) AS BIGINT) AS "n" FROM "ai_signal" s WHERE {} >= ?1{} AND s."kind" IN ('requested', 'watched') GROUP BY s."userId", s."kind""#,
                created("s"), filter("s", 2)
            ),
            &binds(vec![Bind::Text(since_iso.to_owned())]),
        )
        .await?;
    for r in signals {
        let (Some(u), Some(kind), Some(n)) = (
            r.get("userId").and_then(Value::as_i64),
            r.get("kind").and_then(Value::as_str),
            r.get("n").and_then(Value::as_i64),
        ) else {
            continue;
        };
        let o = out.entry(u).or_default();
        match kind {
            "requested" => o.requested += n,
            _ => o.watched += n,
        }
    }
    let liked = db
        .rows(
            &format!(
                // Each title once, liked with the button, rated well, or both.
                r#"SELECT CAST(t."userId" AS BIGINT) AS "userId", CAST(COUNT(*) AS BIGINT) AS "n" FROM (SELECT s."userId", s."mediaType", s."tmdbId" FROM "ai_signal" s WHERE s."kind" = 'rated' AND s."rating" >= ?2 AND {} >= ?1{} UNION SELECT f."userId", f."mediaType", f."tmdbId" FROM "ai_feedback" f WHERE f."kind" = 'like' AND {} >= ?1{}) t GROUP BY t."userId""#,
                created("s"), filter("s", 3),
                db.iso_sql(r#"f."updatedAt""#), filter("f", 3)
            ),
            &binds(vec![Bind::Text(since_iso.to_owned()), Bind::Int(LIKED_FROM)]),
        )
        .await?;
    for r in liked {
        if let (Some(u), Some(n)) = (
            r.get("userId").and_then(Value::as_i64),
            r.get("n").and_then(Value::as_i64),
        ) {
            out.entry(u).or_default().liked += n;
        }
    }
    Ok(out)
}

/// Outcomes per model since `since_iso`: (model, runs, picks, requested,
/// watched, liked-by-rating, average tokens per run, failed runs).
///
/// # Errors
///
/// Fails on database errors.
pub async fn by_model(db: &Db, since_iso: &str) -> Result<Vec<Value>> {
    let runs = db
        .rows(
            &format!(
                r#"SELECT COALESCE("model", '') AS "model", CAST(COUNT(*) AS BIGINT) AS "runs", CAST(SUM(CASE WHEN "stage" = 'failed' THEN 1 ELSE 0 END) AS BIGINT) AS "failed", CAST(COALESCE(SUM("inputTokens"), 0) AS BIGINT) AS "inputTokens", CAST(COALESCE(SUM("outputTokens"), 0) AS BIGINT) AS "outputTokens" FROM "ai_run" WHERE {} >= ?1 GROUP BY COALESCE("model", '') ORDER BY COUNT(*) DESC"#,
                db.iso_sql(r#""createdAt""#)
            ),
            &[Bind::Text(since_iso.to_owned())],
        )
        .await?;
    let picks = db
        .rows(
            &format!(
                r#"SELECT COALESCE(r."model", '') AS "model", CAST(COUNT(*) AS BIGINT) AS "n" FROM "ai_pick" p JOIN "ai_run" r ON r."id" = p."runId" WHERE {} >= ?1 GROUP BY COALESCE(r."model", '')"#,
                db.iso_sql(r#"p."createdAt""#)
            ),
            &[Bind::Text(since_iso.to_owned())],
        )
        .await?;
    let signals = db
        .rows(
            &format!(
                r#"SELECT COALESCE("model", '') AS "model", "kind", CAST(COUNT(*) AS BIGINT) AS "n" FROM "ai_signal" WHERE {} >= ?1 AND ("kind" <> 'rated' OR "rating" >= ?2) GROUP BY COALESCE("model", ''), "kind""#,
                db.iso_sql(r#""createdAt""#)
            ),
            &[Bind::Text(since_iso.to_owned()), Bind::Int(LIKED_FROM)],
        )
        .await?;
    let count = |rows: &[serde_json::Map<String, Value>], model: &str, kind: Option<&str>| {
        rows.iter()
            .filter(|r| r.get("model").and_then(Value::as_str) == Some(model))
            .filter(|r| kind.is_none_or(|k| r.get("kind").and_then(Value::as_str) == Some(k)))
            .filter_map(|r| r.get("n").and_then(Value::as_i64))
            .sum::<i64>()
    };
    Ok(runs
        .iter()
        .filter_map(|r| {
            let model = r.get("model")?.as_str()?;
            let get = |k: &str| r.get(k).and_then(Value::as_i64).unwrap_or(0);
            Some(serde_json::json!({
                "model": if model.is_empty() { Value::Null } else { Value::from(model) },
                "runs": get("runs"),
                "failed": get("failed"),
                "inputTokens": get("inputTokens"),
                "outputTokens": get("outputTokens"),
                "picks": count(&picks, model, None),
                "requested": count(&signals, model, Some("requested")),
                "watched": count(&signals, model, Some("watched")),
                "ratedWell": count(&signals, model, Some("rated")),
            }))
        })
        .collect())
}

const DISPLAY_NAME: &str = r#"COALESCE(NULLIF(u."username", ''), NULLIF(u."jellyfinUsername", ''), NULLIF(u."plexUsername", ''), u."email")"#;

/// Per person since `since_iso`: requests (asked for or automatic), failures,
/// today's count toward the daily limit (`today_iso`) and tokens.
///
/// # Errors
///
/// Fails on database errors.
pub async fn people_usage(
    db: &Db,
    since_iso: &str,
    today_iso: &str,
) -> Result<Vec<serde_json::Map<String, Value>>> {
    let created = db.iso_sql(r#"r."createdAt""#);
    db.rows(
        &format!(
            r#"SELECT CAST(r."userId" AS BIGINT) AS "userId", {DISPLAY_NAME} AS "name", u."avatar" AS "avatar",
            CAST(COUNT(*) AS BIGINT) AS "runs",
            CAST(SUM(CASE WHEN r."origin" = 'manual' THEN 1 ELSE 0 END) AS BIGINT) AS "manual",
            CAST(SUM(CASE WHEN r."origin" IN ('scheduled', 'weekly') THEN 1 ELSE 0 END) AS BIGINT) AS "automatic",
            CAST(SUM(CASE WHEN r."stage" = 'failed' THEN 1 ELSE 0 END) AS BIGINT) AS "failed",
            CAST(SUM(CASE WHEN r."source" = 'server' AND r."origin" NOT IN ('scheduled', 'weekly') AND {created} >= ?2 THEN 1 ELSE 0 END) AS BIGINT) AS "today",
            CAST(COALESCE(SUM(r."inputTokens" + r."outputTokens"), 0) AS BIGINT) AS "tokens",
            CAST(COALESCE(SUM(CASE WHEN r."source" = 'server' THEN r."inputTokens" + r."outputTokens" ELSE 0 END), 0) AS BIGINT) AS "serverTokens",
            MAX({created}) AS "lastRunAt"
            FROM "ai_run" r JOIN "user" u ON u."id" = r."userId"
            WHERE {created} >= ?1
            GROUP BY r."userId", u."username", u."jellyfinUsername", u."plexUsername", u."email", u."avatar"
            ORDER BY COUNT(*) DESC"#
        ),
        &[
            Bind::Text(since_iso.to_owned()),
            Bind::Text(today_iso.to_owned()),
        ],
    )
    .await
}

/// The last failed runs since `since_iso`, with who and the stored error.
///
/// # Errors
///
/// Fails on database errors.
pub async fn recent_failures(
    db: &Db,
    since_iso: &str,
) -> Result<Vec<serde_json::Map<String, Value>>> {
    let created = db.iso_sql(r#"r."createdAt""#);
    db.rows(
        &format!(
            r#"SELECT CAST(r."id" AS BIGINT) AS "id", {DISPLAY_NAME} AS "name", {created} AS "createdAt", r."model", r."origin", r."error"
            FROM "ai_run" r JOIN "user" u ON u."id" = r."userId"
            WHERE r."stage" = 'failed' AND {created} >= ?1 ORDER BY r."id" DESC LIMIT 10"#
        ),
        &[Bind::Text(since_iso.to_owned())],
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::recs::store;
    use crate::ai::recs::Request;
    use crate::dbtx::scratch;
    use serde_json::json;

    #[tokio::test]
    async fn picks_requests_and_watches_become_signals_and_outcomes() -> Result<()> {
        let scratch = scratch::sqlite("ai-signals").await?;
        let db = &scratch.db;
        db.execute(r#"INSERT INTO "user" ("id", "email", "permissions", "userType", "avatar") VALUES (1, 'sig@example.test', 0, 1, '')"#, &[]).await?;
        let run = store::create_run(
            db,
            1,
            &Request::default().to_json(None),
            "server",
            Some("m1"),
        )
        .await?;
        store::finish(
            db,
            run,
            &json!({"picks": [
                {"mediaType": "movie", "tmdbId": 10, "tmdb": {"title": "Requested One"}},
                {"mediaType": "tv", "tmdbId": 20, "tmdb": {"name": "Watched Show"}},
                {"mediaType": "movie", "tmdbId": 30, "tmdb": {"title": "Ignored"}}
            ]}),
        )
        .await?;
        // Requested after the pick (same timestamp counts).
        db.execute(r#"INSERT INTO "media" ("id", "mediaType", "tmdbId", "status") VALUES (5, 'movie', 10, 2)"#, &[]).await?;
        db.execute(r#"INSERT INTO "media_request" ("status", "type", "mediaId", "requestedById", "is4k", "isAutoRequest") VALUES (1, 'movie', 5, 1, 0, 0)"#, &[]).await?;
        let state = AppState::for_tests(db.clone(), &std::env::temp_dir())?;
        let settings = Settings::from_file_value(json!({}), None)?;
        let watched = WatchedSets {
            movie: vec![],
            tv: vec![20.0],
        };
        sync(&state, &settings, 1, Some(&watched), false).await?;
        sync(&state, &settings, 1, Some(&watched), false).await?;
        let all = recent(db, 1, true, 10).await?;
        let mut kinds: Vec<&str> = all.iter().map(|s| s.kind.as_str()).collect();
        kinds.sort_unstable();
        assert_eq!(
            kinds,
            ["requested", "watched"],
            "one signal per title and kind"
        );
        assert!(
            recent(db, 1, false, 10)
                .await?
                .iter()
                .all(|s| !s.is_history()),
            "without consent only requests"
        );
        let o = outcomes(db, "2000").await?.remove(&1).unwrap_or_default();
        assert_eq!((o.picks, o.requested, o.watched), (3, 1, 1));
        let models = by_model(db, "2000").await?;
        assert_eq!(
            models.first().and_then(|m| m.get("requested")),
            Some(&json!(1))
        );
        // Learning marks them.
        let ids: Vec<i64> = unlearned(db, 1, true).await?.iter().map(|s| s.id).collect();
        mark_learned(db, 1, &ids).await?;
        assert!(unlearned(db, 1, true).await?.is_empty());
        // A Simkl watch from before the suggestion isn't credited to it; a
        // rating is, and a changed rating replaces it and is learned again.
        db.execute(r#"INSERT INTO "simkl_sync_item" ("userId", "simklId", "simklType", "tmdbId", "title", "status", "lastWatchedAt") VALUES (1, 's10', 'movie', 10, 'Requested One', 'completed', '2001-01-01 00:00:00')"#, &[]).await?;
        db.execute(r#"INSERT INTO "simkl_sync_item" ("userId", "simklId", "simklType", "tmdbId", "title", "status", "userRating") VALUES (1, 's30', 'movie', 30, 'Ignored', 'completed', 8)"#, &[]).await?;
        sync(&state, &settings, 1, None, false).await?;
        let rated = |all: Vec<Signal>| {
            all.into_iter()
                .find(|s| s.kind == "rated")
                .and_then(|s| s.rating)
        };
        assert_eq!(rated(unlearned(db, 1, true).await?), Some(8));
        assert!(!recent(db, 1, true, 10)
            .await?
            .iter()
            .any(|s| s.kind == "watched" && s.title == "Requested One"));
        mark_learned(
            db,
            1,
            &unlearned(db, 1, true)
                .await?
                .iter()
                .map(|s| s.id)
                .collect::<Vec<_>>(),
        )
        .await?;
        db.execute(
            r#"UPDATE "simkl_sync_item" SET "userRating" = 3 WHERE "simklId" = 's30'"#,
            &[],
        )
        .await?;
        sync(&state, &settings, 1, None, false).await?;
        assert_eq!(rated(unlearned(db, 1, true).await?), Some(3));
        // A title liked and rated well counts once.
        db.execute(
            r#"UPDATE "simkl_sync_item" SET "userRating" = 9 WHERE "simklId" = 's30'"#,
            &[],
        )
        .await?;
        sync(&state, &settings, 1, None, false).await?;
        store::set_feedback(db, 1, "movie", 30, store::Verdict::Like, "Ignored").await?;
        assert_eq!(
            outcomes(db, "2000")
                .await?
                .remove(&1)
                .unwrap_or_default()
                .liked,
            1
        );
        // Forgetting ratings forgets them, and the ratings still on Simkl
        // don't bring them back.
        store::clear_all_feedback(db, 1).await?;
        let only_requests = |signals: Vec<Signal>| {
            assert_eq!(signals.len(), 1);
            assert_eq!(signals.first().map(|s| s.kind.as_str()), Some("requested"));
        };
        only_requests(recent(db, 1, true, 10).await?);
        // Re-suggest the undated Simkl rating after forgetting it.
        let again =
            store::create_run(db, 1, &Request::default().to_json(None), "server", None).await?;
        store::finish(
            db,
            again,
            &json!({"picks": [{"mediaType": "movie", "tmdbId": 30}]}),
        )
        .await?;
        sync(&state, &settings, 1, Some(&watched), false).await?;
        only_requests(recent(db, 1, true, 10).await?);
        let o = user_outcomes(db, "2000", 1).await?;
        assert_eq!((o.picks, o.requested, o.watched, o.liked), (3, 1, 0, 0));
        assert_eq!(
            by_model(db, "2000")
                .await?
                .first()
                .and_then(|m| m.get("requested")),
            Some(&json!(1))
        );
        assert_eq!(
            user_outcomes(db, "2000", 999).await?.to_json(),
            Outcomes::default().to_json()
        );
        // Explicit feedback can still express a new preference.
        store::set_feedback(db, 1, "movie", 30, store::Verdict::Like, "Ignored").await?;
        assert_eq!(user_outcomes(db, "2000", 1).await?.liked, 1);
        assert!(store::delete_run(db, 1, run).await?);
        Ok(())
    }

    #[tokio::test]
    async fn pruning_and_clearing_history() -> Result<()> {
        let scratch = scratch::sqlite("ai-history").await?;
        let db = &scratch.db;
        db.execute(r#"INSERT INTO "user" ("id", "email", "permissions", "userType", "avatar") VALUES (1, 'h@example.test', 0, 1, '')"#, &[]).await?;
        let old = store::create_run(db, 1, &Request::default().to_json(None), "own", None).await?;
        store::finish(
            db,
            old,
            &json!({"picks": [{"mediaType": "movie", "tmdbId": 1}]}),
        )
        .await?;
        db.execute(
            r#"UPDATE "ai_run" SET "createdAt" = '2001-01-01 00:00:00' WHERE "id" = ?1"#,
            &[Bind::Int(old)],
        )
        .await?;
        let new = store::create_run(db, 1, &Request::default().to_json(None), "own", None).await?;
        store::finish(db, new, &json!({"picks": []})).await?;
        assert_eq!(
            store::prune_runs(db, Some("2010-01-01T00:00:00.000Z")).await?,
            1
        );
        assert!(store::run(db, 1, old).await?.is_none());
        assert!(store::run(db, 1, new).await?.is_some());
        assert_eq!(store::delete_runs(db, 1).await?, 1);
        assert!(store::personal_runs(db, 1, 20).await?.is_empty());
        Ok(())
    }

    /// Deleting history keeps the counts the limits read, and a running
    /// request that is deleted saves nothing when it finishes.
    #[tokio::test]
    async fn deleted_history_still_counts() -> Result<()> {
        let scratch = scratch::sqlite("ai-scrub").await?;
        let db = &scratch.db;
        db.execute(r#"INSERT INTO "user" ("id", "email", "permissions", "userType", "avatar") VALUES (1, 'h@example.test', 0, 1, '')"#, &[]).await?;
        let request = Request {
            prompt: String::from("Secret prompt"),
            ..Request::default()
        };
        let done = store::create_run(db, 1, &request.to_json(None), "server", None).await?;
        store::finish(
            db,
            done,
            &json!({"picks": [{"mediaType": "movie", "tmdbId": 1}]}),
        )
        .await?;
        store::add_tokens(
            db,
            done,
            crate::ai::Tokens {
                input: 100,
                output: 20,
            },
        )
        .await?;
        let running = store::create_run(db, 1, &request.to_json(None), "server", None).await?;
        assert_eq!(store::delete_runs(db, 1).await?, 2);
        store::finish(
            db,
            running,
            &json!({"picks": [{"mediaType": "movie", "tmdbId": 2}]}),
        )
        .await?;
        assert!(store::run(db, 1, running).await?.is_none(), "stays deleted");
        assert!(store::personal_runs(db, 1, 20).await?.is_empty());
        let since = "2000-01-01T00:00:00.000Z";
        assert_eq!(store::server_runs_since(db, 1, since).await?, 2);
        assert_eq!(store::server_tokens_since(db, since).await?, 120);
        let leftover = db
            .rows(r#"SELECT COUNT(*) AS "n" FROM "ai_run" WHERE "request" LIKE '%Secret%' OR "result" IS NOT NULL"#, &[])
            .await?;
        assert_eq!(
            leftover
                .first()
                .and_then(|r| r.get("n"))
                .and_then(Value::as_i64),
            Some(0)
        );
        assert_eq!(outcomes(db, "2000").await?.get(&1).map(|o| o.picks), None);
        // Scrubbed rows go once they're old enough.
        db.execute(
            r#"UPDATE "ai_run" SET "createdAt" = '2001-01-01 00:00:00'"#,
            &[],
        )
        .await?;
        assert_eq!(store::prune_runs(db, None).await?, 0);
        assert_eq!(store::server_runs_since(db, 1, since).await?, 0);
        Ok(())
    }

    /// The new tables and every new query on `PostgreSQL`.
    #[tokio::test]
    #[ignore = "requires an empty scratch database at FORESEERR_AI_TEST_POSTGRES_URL"]
    async fn postgres_insights() -> Result<()> {
        use crate::ai::recs::store::{Origin, Reserve};
        let url = std::env::var("FORESEERR_AI_TEST_POSTGRES_URL")?;
        let db = Db::Postgres(sqlx::PgPool::connect(&url).await?);
        crate::dbmigrate::run(&db, &crate::dbmigrate::migrations(&db)).await?;
        db.execute(r#"INSERT INTO "user" ("id", "email", "permissions", "userType", "avatar") VALUES (1, 'pg@example.test', 0, 1, '')"#, &[]).await?;
        let how = Reserve {
            source: "server",
            model: Some("m"),
            daily_limit: Some(5),
            monthly_tokens: Some(10_000),
            origin: Origin::Manual,
            fresh_minutes: 60,
        };
        let (run, _) = store::reserve_run(&db, 1, &Request::default(), None, how)
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        store::finish(&db, run, &json!({"picks": [{"mediaType": "movie", "tmdbId": 10, "tmdb": {"title": "A"}}, {"mediaType": "tv", "tmdbId": 20, "tmdb": {"name": "B"}}]})).await?;
        store::add_tokens(
            &db,
            run,
            crate::ai::Tokens {
                input: 10,
                output: 5,
            },
        )
        .await?;
        db.execute(r#"INSERT INTO "media" ("id", "mediaType", "tmdbId", "status") VALUES (5, 'movie', 10, 2)"#, &[]).await?;
        db.execute(r#"INSERT INTO "media_request" ("status", "type", "mediaId", "requestedById", "is4k", "isAutoRequest") VALUES (1, 'movie', 5, 1, false, false)"#, &[]).await?;
        let state = AppState::for_tests(db.clone(), &std::env::temp_dir())?;
        let settings = Settings::from_file_value(json!({}), None)?;
        let watched = WatchedSets {
            movie: vec![],
            tv: vec![20.0],
        };
        sync(&state, &settings, 1, Some(&watched), false).await?;
        assert_eq!(recent(&db, 1, true, 10).await?.len(), 2);
        let ids: Vec<i64> = unlearned(&db, 1, true)
            .await?
            .iter()
            .map(|s| s.id)
            .collect();
        mark_learned(&db, 1, &ids).await?;
        // Ratings: a change is updated in place; a like and a good rating
        // of one title count once.
        db.execute(r#"INSERT INTO "simkl_sync_item" ("userId", "simklId", "simklType", "tmdbId", "title", "status", "userRating", "lastWatchedAt") VALUES (1, 's10', 'movie', 10, 'A', 'completed', 8, '2001-01-01 00:00:00')"#, &[]).await?;
        sync(&state, &settings, 1, None, false).await?;
        db.execute(r#"UPDATE "simkl_sync_item" SET "userRating" = 9"#, &[])
            .await?;
        sync(&state, &settings, 1, None, false).await?;
        assert_eq!(
            unlearned(&db, 1, true)
                .await?
                .first()
                .and_then(|s| s.rating),
            Some(9)
        );
        store::set_feedback(&db, 1, "movie", 10, store::Verdict::Like, "A").await?;
        let o = outcomes(&db, "2000-01-01T00:00:00.000Z")
            .await?
            .remove(&1)
            .unwrap_or_default();
        assert_eq!((o.picks, o.requested, o.watched, o.liked), (2, 1, 1, 1));
        assert!(!by_model(&db, "2000-01-01T00:00:00.000Z").await?.is_empty());
        assert_eq!(
            people_usage(&db, "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z")
                .await?
                .len(),
            1
        );
        assert!(recent_failures(&db, "2000-01-01T00:00:00.000Z")
            .await?
            .is_empty());
        assert_eq!(
            store::server_tokens_since(&db, "2000-01-01T00:00:00.000Z").await?,
            15
        );
        store::touch_active(&db, 1).await?;
        crate::ai::store::update_prefs(
            &db,
            1,
            &crate::ai::store::PrefsChange {
                weekly_picks: Some(false),
                ..Default::default()
            },
        )
        .await?;
        assert!(!crate::ai::store::prefs(&db, 1).await?.weekly_picks);
        assert!(store::latest_weekly(&db, 1).await?.is_none());
        assert!(store::last_weekly_at(&db, 1).await?.is_none());
        assert_eq!(store::personal_runs(&db, 1, 5).await?.len(), 1);
        assert_eq!(
            store::prune_runs(&db, Some("2000-01-01T00:00:00.000Z")).await?,
            0
        );
        assert!(store::delete_run(&db, 1, run).await?);
        assert_eq!(store::delete_runs(&db, 1).await?, 0);
        for all in [false, true] {
            let run =
                store::create_run(&db, 1, &Request::default().to_json(None), "own", None).await?;
            let mut completion = Tx::begin(&db).await?;
            completion
                .execute(
                    r#"UPDATE "ai_run" SET "stage" = 'done' WHERE "id" = ?1"#,
                    &[Bind::Int(run)],
                )
                .await?;
            let deleting_db = db.clone();
            let mut deletion = tokio::spawn(async move {
                if all {
                    store::delete_runs(&deleting_db, 1).await.map(|_| ())
                } else {
                    store::delete_run(&deleting_db, 1, run).await.map(|_| ())
                }
            });
            // Completion holds the run lock, so deletion must wait BEFORE
            // deleting picks. With the old order the following pick survived.
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(50), &mut deletion)
                    .await
                    .is_err()
            );
            completion.execute(r#"INSERT INTO "ai_pick" ("userId", "runId", "mediaType", "tmdbId") VALUES (1, ?1, 'movie', 99)"#, &[Bind::Int(run)]).await?;
            completion.commit().await?;
            deletion.await??;
            assert!(db
                .rows(
                    r#"SELECT "id" FROM "ai_pick" WHERE "runId" = ?1"#,
                    &[Bind::Int(run)]
                )
                .await?
                .is_empty());
        }
        store::clear_all_feedback(&db, 1).await?;
        assert_eq!(user_outcomes(&db, "2000", 1).await?.requested, 1);
        assert!(recent(&db, 1, true, 10)
            .await?
            .iter()
            .all(|s| s.kind == "requested"));
        sync(&state, &settings, 1, None, false).await?;
        assert!(recent(&db, 1, true, 10)
            .await?
            .iter()
            .all(|s| s.kind == "requested"));
        Ok(())
    }

    #[test]
    fn rows_saved_before_the_filter_keep_their_cache() {
        let plain = Request {
            prompt: String::from("cozy"),
            ..Request::default()
        };
        let mut library = plain.clone();
        library.availability = Some("library");
        assert_ne!(plain.cache_key(), library.cache_key());
        // The key of a request without the filter didn't change.
        assert_eq!(plain.cache_key(), {
            use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
            use sha2::{Digest, Sha256};
            let v = json!({"prompt": "cozy", "seed": null, "only": null, "anime": false, "refinements": []});
            URL_SAFE_NO_PAD.encode(Sha256::digest(v.to_string().as_bytes()))
        });
    }
}
