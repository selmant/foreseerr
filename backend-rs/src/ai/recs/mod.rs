//! AI recommendations, without a chat: a request (a mood, a title someone
//! loves, or nothing but their taste) goes through one run:
//!
//! 1. **plan**: the model reads the request, the person's taste card and
//!    feedback (and, only with their consent, their watch history) and
//!    says what to look for;
//! 2. **search**: Foreseerr finds real titles ([`retrieve`]);
//! 3. **rank**: the model picks from those, each with a one-line reason,
//!    and suggests follow-ups.
//!
//! Feedback (like, dislike, seen, not interested) is kept per title; once
//! enough is new, the model folds it into the person's taste card, which
//! they can read, edit or clear. Runs on the server connection count
//! toward the admin's daily limit.

pub mod prompts;
pub mod retrieve;
pub mod rows;
pub mod store;

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use self::prompts::{Context, Plan, Ranking, TasteUpdate};
use self::retrieve::{kind_of, Candidate, Genres, Key, Sources};
use self::store::{Stage, Verdict};
use super::{AiError, Effective, ErrorKind, Policy, Prompt, Source, Unavailable};
use crate::auth::CurrentUser;
use crate::db::Bind;
use crate::settings::Settings;
use crate::state::AppState;

const ADMIN: i64 = 2;
/// The longest request text accepted.
pub const MAX_PROMPT_CHARS: usize = 300;
/// The most refinements kept on one request.
const MAX_REFINEMENTS: usize = 6;
/// A run still working after this long is treated as stopped.
const STALE_AFTER_MINUTES: i64 = 10;
/// New feedback rows that trigger a taste card update.
const TASTE_AFTER_FEEDBACK: usize = 3;
/// The plan step gets this long before the run fails.
const PLAN_TIMEOUT: Duration = Duration::from_mins(3);
/// Looking up candidates gets this long; slow sources are dropped.
const SEARCH_TIMEOUT: Duration = Duration::from_secs(45);

/// What someone asked for.
#[derive(Debug, Clone, Default)]
pub struct Request {
    /// What they typed.
    pub prompt: String,
    /// "More like this" title.
    pub seed: Option<Key>,
    /// `movie` or `tv` only.
    pub only: Option<&'static str>,
    /// Anime only.
    pub anime: bool,
    /// Follow-ups tapped so far.
    pub refinements: Vec<String>,
    /// Started by a Discover row (not listed with their own requests).
    pub row: bool,
}

impl Request {
    /// Read a request body.
    ///
    /// # Errors
    ///
    /// Fails on a too-long or malformed field.
    pub fn parse(body: &Map<String, Value>) -> Result<Self, AiError> {
        let prompt = body
            .get("prompt")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_owned();
        if prompt.chars().count() > MAX_PROMPT_CHARS {
            return Err(AiError::input(format!(
                "Keep the request under {MAX_PROMPT_CHARS} characters."
            )));
        }
        let seed = match body.get("seed") {
            None | Some(Value::Null) => None,
            Some(Value::Object(seed)) => {
                let kind = seed.get("mediaType").and_then(Value::as_str);
                let id = seed.get("tmdbId").and_then(Value::as_i64);
                match (kind, id) {
                    (Some(kind @ ("movie" | "tv")), Some(id)) if id > 0 => {
                        Some((kind_of(kind), id))
                    }
                    _ => return Err(AiError::input("That title isn't valid.")),
                }
            }
            Some(_) => return Err(AiError::input("That title isn't valid.")),
        };
        let only = match body.get("only").and_then(Value::as_str) {
            Some("movie") => Some("movie"),
            Some("tv") => Some("tv"),
            Some(_) | None => None,
        };
        let refinements: Vec<String> = body
            .get("refinements")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(|r| super::clip(r.trim(), 60))
                    .filter(|r| !r.is_empty())
                    .take(MAX_REFINEMENTS)
                    .collect()
            })
            .unwrap_or_default();
        Ok(Self {
            prompt,
            seed,
            only,
            anime: body.get("anime").and_then(Value::as_bool).unwrap_or(false),
            refinements,
            row: false,
        })
    }

    /// A stable identity for every recommendation constraint.
    #[must_use]
    pub fn cache_key(&self) -> String {
        let value = json!({"prompt": self.prompt, "seed": self.seed,
            "only": self.only, "anime": self.anime, "refinements": self.refinements});
        URL_SAFE_NO_PAD.encode(Sha256::digest(value.to_string().as_bytes()))
    }

    /// As stored with the run (the seed's title added for display).
    #[must_use]
    pub fn to_json(&self, seed_title: Option<&str>) -> Value {
        json!({
            "prompt": self.prompt,
            "seed": self.seed.map(|(kind, id)| json!({"mediaType": kind, "tmdbId": id, "title": seed_title.unwrap_or_default()})),
            "only": self.only,
            "anime": self.anime,
            "refinements": self.refinements,
            "row": self.row,
            "rowKey": self.row.then(|| self.cache_key()),
        })
    }
}

/// The language TMDB answers in.
#[must_use]
pub fn language(settings: &Settings) -> String {
    settings
        .get("/main/locale")
        .and_then(Value::as_str)
        .filter(|l| !l.is_empty())
        .unwrap_or("en")
        .to_owned()
}

/// ISO timestamp for "now minus this many minutes" (or the start of
/// today in UTC with `None`), comparable with `Db::iso_sql` columns.
#[must_use]
pub fn iso_since(minutes_ago: Option<i64>) -> String {
    let now = chrono::Utc::now();
    minutes_ago.map_or_else(
        || now.format("%Y-%m-%dT00:00:00.000Z").to_string(),
        |m| {
            (now - chrono::Duration::minutes(m))
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string()
        },
    )
}

/// The error for a user without a usable connection.
#[must_use]
pub fn unavailable_error(why: Unavailable) -> AiError {
    match why {
        Unavailable::Disabled => {
            AiError::not_eligible("AI features are turned off on this server.")
        }
        Unavailable::OwnNeedsSignIn => {
            AiError::reauth("Sign in to ChatGPT again in Profile → AI to keep using it.")
        }
        Unavailable::OwnMissing => AiError::new(
            ErrorKind::NotConfigured,
            "Your own AI account isn't connected. Connect it, or switch to the server connection, in Profile → AI.",
        ),
        Unavailable::NoServerConnection => AiError::new(
            ErrorKind::NotConfigured,
            "There's no AI connection you can use yet. Connect your own account in Profile → AI, or ask your admin.",
        ),
    }
}

/// The daily limit that applies to this user's runs on this connection
/// (None: no limit).
#[must_use]
pub const fn daily_limit(policy: &Policy, eff: &Effective, user: &CurrentUser) -> Option<u32> {
    if user.permissions & ADMIN != 0 || policy.daily_limit == 0 {
        return None;
    }
    match eff.source {
        Source::Own => None,
        Source::Server => Some(policy.daily_limit),
    }
}

/// Runs this user started on the server connection today, and the limit
/// that applies (None when unlimited).
///
/// # Errors
///
/// Fails on database errors.
pub async fn usage(
    state: &AppState,
    settings: &Settings,
    user: &CurrentUser,
) -> anyhow::Result<(Option<u32>, i64)> {
    let spent = store::server_runs_since(&state.db, user.id, &iso_since(None)).await?;
    let limit = super::effective(state, settings, user)
        .await?
        .ok()
        .and_then(|eff| daily_limit(&Policy::of(settings), &eff, user));
    Ok((limit, spent))
}

/// Start a run: check access and the daily limit, store it, and work on
/// it in the background. Returns the run id.
///
/// # Errors
///
/// Fails when the user has no usable connection, reached the limit, or
/// already has a run working.
pub async fn start(
    state: Arc<AppState>,
    settings: Arc<Settings>,
    user: CurrentUser,
    request: Request,
) -> Result<i64, AiError> {
    let db_err = |e: anyhow::Error| AiError::internal(format!("{e:#}"));
    let eff = match super::effective(&state, &settings, &user)
        .await
        .map_err(db_err)?
    {
        Ok(eff) => eff,
        Err(why) => return Err(unavailable_error(why)),
    };
    if eff.model.is_none() {
        return Err(AiError::not_configured());
    }
    let policy = Policy::of(&settings);
    if let Some(limit) = daily_limit(&policy, &eff, &user) {
        let spent = store::server_runs_since(&state.db, user.id, &iso_since(None))
            .await
            .map_err(db_err)?;
        if spent >= i64::from(limit) {
            return Err(AiError::daily_limit(limit));
        }
    }
    sweep_stale(&state).await;
    // One request of their own at a time; Discover rows run alongside.
    if !request.row
        && store::active_run(&state.db, user.id, &iso_since(Some(STALE_AFTER_MINUTES)))
            .await
            .map_err(db_err)?
            .is_some()
    {
        return Err(AiError::input(
            "Your last request is still working. Wait for it to finish.",
        ));
    }
    let seed_title = match request.seed {
        Some((kind, id)) => {
            let details = state
                .tmdb
                .title_summary(kind, id, &language(&settings))
                .await
                .map_err(|_| AiError::input("That title couldn't be found on TMDB."))?;
            retrieve::candidate(&details, kind, "seed").map(|c| c.title)
        }
        None => None,
    };
    let source = match eff.source {
        Source::Own => "own",
        Source::Server => "server",
    };
    let run_id = store::create_run(
        &state.db,
        user.id,
        &request.to_json(seed_title.as_deref()),
        source,
        eff.model.as_deref(),
    )
    .await
    .map_err(db_err)?;
    tokio::spawn(async move {
        let result = work(&state, &settings, &user, &eff, run_id, &request).await;
        let saved = match &result {
            Ok(done) => store::finish(&state.db, run_id, done).await,
            Err(e) => {
                tracing::info!("AI run {run_id} for user {} failed: {}", user.id, e.message);
                store::fail(&state.db, run_id, &e.to_json()).await
            }
        };
        if let Err(e) = saved {
            tracing::warn!("saving AI run {run_id} failed: {e:#}");
        }
        if result.is_ok() {
            if let Err(e) = maybe_update_taste(&state, &eff, user.id).await {
                tracing::info!(
                    "updating the taste card of user {} failed: {}",
                    user.id,
                    e.message
                );
            }
        }
    });
    Ok(run_id)
}

/// The person's taste, feedback and (with consent) history, plus the
/// titles never to suggest.
struct Person {
    ctx: Context,
    liked: Vec<Key>,
    excluded: HashSet<Key>,
    trakt: bool,
}

async fn person(
    state: &AppState,
    settings: &Settings,
    user_id: i64,
    request: &Request,
    seed_line: Option<String>,
) -> anyhow::Result<Person> {
    let prefs = super::store::prefs(&state.db, user_id).await?;
    let policy = Policy::of(settings);
    let taste = store::taste(&state.db, user_id)
        .await?
        .map(|(card, _)| card);
    let feedback = store::feedback(&state.db, user_id, 200).await?;
    let mut liked_lines = Vec::new();
    let mut avoid_lines = Vec::new();
    let mut liked = Vec::new();
    let mut excluded: HashSet<Key> = HashSet::new();
    for f in &feedback {
        let key = (kind_of(&f.media_type), f.tmdb_id);
        let label = if f.title.is_empty() {
            format!("{} #{}", f.media_type, f.tmdb_id)
        } else {
            f.title.clone()
        };
        match Verdict::parse(&f.kind) {
            Some(Verdict::Like) => {
                excluded.insert(key);
                liked.push(key);
                if liked_lines.len() < 25 {
                    liked_lines.push(label);
                }
            }
            Some(v @ (Verdict::Dislike | Verdict::Seen | Verdict::NotInterested)) => {
                excluded.insert(key);
                if avoid_lines.len() < 40 {
                    let why = match v {
                        Verdict::Dislike => "disliked",
                        Verdict::Seen => "already seen",
                        Verdict::Like | Verdict::NotInterested => "not interested",
                    };
                    avoid_lines.push(format!("{label} ({why})"));
                }
            }
            None => {}
        }
    }
    if let Some(seed) = request.seed {
        excluded.insert(seed);
    }
    // Hiding what they already watched happens here, on this server; it
    // sends nothing to the model.
    if let Ok(Ok(watched)) = tokio::time::timeout(
        Duration::from_secs(10),
        crate::mappinglayer::watched::load_combined(state, settings, user_id),
    )
    .await
    {
        for (kind, ids) in [("movie", &watched.movie), ("tv", &watched.tv)] {
            for id in ids {
                if let Some(id) = whole(*id) {
                    excluded.insert((kind, id));
                }
            }
        }
    }
    let history = if prefs.use_history {
        tokio::time::timeout(Duration::from_secs(15), history(state, settings, user_id))
            .await
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    Ok(Person {
        ctx: Context {
            request: request.prompt.clone(),
            seed: seed_line,
            only: request.only,
            anime_only: request.anime,
            refinements: request.refinements.clone(),
            taste,
            liked: liked_lines,
            avoid: avoid_lines,
            history,
            web_search_enabled: policy.searxng_enabled && !policy.searxng_url.is_empty(),
        },
        liked,
        excluded,
        trakt: prefs.use_history,
    })
}

/// A float id as an integer, when it is one.
fn whole(id: f64) -> Option<i64> {
    let text = format!("{id:.0}");
    text.parse::<i64>().ok().filter(|n| *n > 0)
}

fn title_year(item: Option<&Value>) -> Option<String> {
    let item = item?;
    let title = item.get("title").and_then(Value::as_str)?;
    Some(
        item.get("year")
            .and_then(Value::as_i64)
            .map_or_else(|| title.to_owned(), |y| format!("{title} ({y})")),
    )
}

/// Recent and top-rated titles from Trakt, Simkl and the Foreseerr
/// watchlist, as short lines. Only called with the person's consent.
async fn history(state: &AppState, settings: &Settings, user_id: i64) -> Vec<String> {
    let mut lines = Vec::new();
    if let Ok(client) = crate::mediaactions::trakt::user_client(state, settings, user_id).await {
        if let Ok(snap) = crate::mappinglayer::synccache::warm_trakt(&client, user_id).await {
            for (items, key) in [
                (&snap.ratings_movies, "movie"),
                (&snap.ratings_shows, "show"),
            ] {
                let mut rated: Vec<(i64, String)> = items
                    .iter()
                    .filter_map(|r| {
                        let rating = r.get("rating").and_then(Value::as_i64)?;
                        Some((rating, title_year(r.get(key))?))
                    })
                    .collect();
                rated.sort_by_key(|(rating, _)| std::cmp::Reverse(*rating));
                lines.extend(
                    rated
                        .into_iter()
                        .take(12)
                        .map(|(rating, t)| format!("{t}: rated {rating}/10")),
                );
            }
            for (items, key) in [
                (&snap.watched_movies, "movie"),
                (&snap.watched_shows, "show"),
            ] {
                let mut watched: Vec<(String, String)> = items
                    .iter()
                    .filter_map(|w| {
                        let when = w
                            .get("last_watched_at")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned();
                        Some((when, title_year(w.get(key))?))
                    })
                    .collect();
                watched.sort_by(|a, b| b.0.cmp(&a.0));
                lines.extend(
                    watched
                        .into_iter()
                        .take(10)
                        .map(|(_, t)| format!("{t}: watched")),
                );
            }
        }
    }
    let simkl = state
        .db
        .rows(
            r#"SELECT "title", "year", "userRating", "status" FROM "simkl_sync_item" WHERE "userId" = ?1 AND "lastWatchedAt" IS NOT NULL ORDER BY "lastWatchedAt" DESC LIMIT 15"#,
            &[Bind::Int(user_id)],
        )
        .await
        .unwrap_or_default();
    for row in simkl {
        let Some(title) = row.get("title").and_then(Value::as_str) else {
            continue;
        };
        let year = row
            .get("year")
            .and_then(Value::as_i64)
            .map(|y| format!(" ({y})"))
            .unwrap_or_default();
        let rating = row
            .get("userRating")
            .and_then(Value::as_f64)
            .map(|r| format!(", rated {r:.0}/10"))
            .unwrap_or_default();
        lines.push(format!("{title}{year}: watched{rating}"));
    }
    if let Ok((rows, _)) = state.db.watchlist_page(user_id, 15, 0).await {
        lines.extend(
            rows.into_iter()
                .map(|r| format!("{}: on their watchlist", r.title)),
        );
    }
    lines.dedup();
    lines.truncate(60);
    lines
}

async fn ask<T: for<'de> serde::Deserialize<'de>>(
    state: &AppState,
    eff: &Effective,
    instructions: &str,
    input: &str,
    schema: (&str, &Value),
) -> Result<T, AiError> {
    let answer = super::complete(
        state,
        &eff.connection,
        eff.model.as_deref(),
        &Prompt {
            instructions,
            input,
            schema: Some(schema),
        },
    )
    .await?;
    prompts::parse_json(&answer).map_err(|e| {
        tracing::info!("the model's answer wasn't the JSON asked for: {e}");
        AiError::upstream("The model's answer couldn't be read. Try again, or pick another model.")
    })
}

async fn work(
    state: &AppState,
    settings: &Settings,
    user: &CurrentUser,
    eff: &Effective,
    run_id: i64,
    request: &Request,
) -> Result<Value, AiError> {
    let db_err = |e: anyhow::Error| AiError::internal(format!("{e:#}"));
    let lang = language(settings);
    let policy = Policy::of(settings);
    let seed = match request.seed {
        Some((kind, id)) => state
            .tmdb
            .title_summary(kind, id, &lang)
            .await
            .ok()
            .and_then(|d| retrieve::candidate(&d, kind, "seed")),
        None => None,
    };
    let genres = Genres::load(state).await;
    let seed_line = seed.as_ref().map(|s| {
        let line = s.line(&genres);
        let year = line.year.map(|y| format!(" ({y})")).unwrap_or_default();
        format!(
            "{}{year} [{}] — {}: {}",
            line.title,
            s.media_type,
            line.genres.join(", "),
            line.overview
        )
    });
    let person = person(state, settings, user.id, request, seed_line)
        .await
        .map_err(db_err)?;

    let plan_schema = prompts::plan_schema();
    let plan: Plan = tokio::time::timeout(
        PLAN_TIMEOUT,
        ask(
            state,
            eff,
            prompts::PLAN_INSTRUCTIONS,
            &prompts::plan_input(&person.ctx, &genres.all_names()),
            ("recommendation_plan", &plan_schema),
        ),
    )
    .await
    .map_err(|_| {
        AiError::network("The model took too long to answer. Try again, or pick a faster model.")
    })??;

    store::set_stage(&state.db, run_id, Stage::Searching)
        .await
        .map_err(db_err)?;
    let sources = Sources {
        seed: request.seed,
        liked: person.liked.clone(),
        trakt: person.trakt,
        searxng: (policy.searxng_enabled && !policy.searxng_url.is_empty())
            .then(|| policy.searxng_url.clone()),
        only: request.only,
        anime_only: request.anime,
    };
    let gathered = tokio::time::timeout(
        SEARCH_TIMEOUT,
        retrieve::gather(
            &retrieve::Env {
                state,
                settings,
                user_id: user.id,
                language: &lang,
                genres: &genres,
            },
            &plan,
            &sources,
            &person.excluded,
        ),
    )
    .await
    .unwrap_or_default();
    if gathered.candidates.is_empty() {
        return Err(AiError::input(
            "Nothing matching turned up. Try wording it differently or widening it.",
        ));
    }

    store::set_stage(&state.db, run_id, Stage::Ranking)
        .await
        .map_err(db_err)?;
    let lines: Vec<_> = gathered
        .candidates
        .iter()
        .map(|c| c.line(&genres))
        .collect();
    let rank_schema = prompts::rank_schema();
    let ranking: Ranking = ask(
        state,
        eff,
        prompts::RANK_INSTRUCTIONS,
        &prompts::rank_input(&person.ctx, &lines, &gathered.web),
        ("recommendation_picks", &rank_schema),
    )
    .await?;

    let mut picked: Vec<(Candidate, String)> = Vec::new();
    let mut taken: HashSet<Key> = HashSet::new();
    for pick in ranking.picks.iter().take(prompts::MAX_PICKS) {
        let reference = pick.reference.trim().trim_matches(|c| c == '[' || c == ']');
        if let Some(c) = gathered
            .candidates
            .iter()
            .find(|c| c.reference() == reference)
        {
            if taken.insert(c.key()) {
                picked.push((c.clone(), clip_why(&pick.why)));
            }
        }
    }
    for extra in ranking.extra.iter().take(prompts::MAX_EXTRA) {
        let kind = kind_of(&extra.media_type);
        if request.only.is_some_and(|only| only != kind) {
            continue;
        }
        if let Some(c) =
            retrieve::search_title(state, &lang, &extra.title, extra.year, kind, "idea").await
        {
            if !person.excluded.contains(&c.key()) && taken.insert(c.key()) {
                picked.push((c, clip_why(&extra.why)));
            }
        }
    }
    if picked.is_empty() {
        return Err(AiError::upstream(
            "The model didn't pick any of the titles found. Try again.",
        ));
    }
    let refinements: Vec<String> = ranking
        .refinements
        .iter()
        .map(|r| super::clip(r.trim(), 40))
        .filter(|r| !r.is_empty())
        .take(5)
        .collect();
    Ok(json!({
        "headline": super::clip(ranking.headline.trim(), 80),
        "summary": super::clip(plan.summary.trim(), 160),
        "picks": picked.iter().map(|(c, why)| json!({
            "mediaType": c.media_type,
            "tmdbId": c.tmdb_id,
            "why": why,
            "source": c.source,
            "tmdb": c.tmdb,
        })).collect::<Vec<_>>(),
        "refinements": refinements,
        "candidates": gathered.candidates.len(),
        "usedWeb": !gathered.web.is_empty(),
    }))
}

fn clip_why(why: &str) -> String {
    super::clip(why.trim(), 200)
}

/// Fold new feedback into the taste card when enough has piled up.
async fn maybe_update_taste(
    state: &AppState,
    eff: &Effective,
    user_id: i64,
) -> Result<(), AiError> {
    let db_err = |e: anyhow::Error| AiError::internal(format!("{e:#}"));
    let current = store::taste(&state.db, user_id).await.map_err(db_err)?;
    let feedback = store::feedback(&state.db, user_id, 60)
        .await
        .map_err(db_err)?;
    let since = current
        .as_ref()
        .map(|(_, at)| at.as_str())
        .unwrap_or_default();
    let new: Vec<&store::Feedback> = feedback
        .iter()
        .filter(|f| f.updated_at.as_str() > since)
        .collect();
    if new.len() < TASTE_AFTER_FEEDBACK {
        return Ok(());
    }
    let lines: Vec<String> = new
        .iter()
        .map(|f| {
            let verdict = match Verdict::parse(&f.kind) {
                Some(Verdict::Like) => "liked",
                Some(Verdict::Dislike) => "disliked",
                Some(Verdict::Seen) => "already seen",
                Some(Verdict::NotInterested) | None => "not interested",
            };
            format!("{} ({}): {verdict}", f.title, f.media_type)
        })
        .collect();
    let requests: Vec<String> = store::recent_runs(&state.db, user_id, 8)
        .await
        .map_err(db_err)?
        .iter()
        .filter_map(|r| r.request.get("prompt").and_then(Value::as_str))
        .filter(|p| !p.trim().is_empty())
        .map(|p| super::clip(p.trim(), 120))
        .collect();
    let schema = prompts::taste_schema();
    let update: TasteUpdate = ask(
        state,
        eff,
        prompts::TASTE_INSTRUCTIONS,
        &prompts::taste_input(current.as_ref().map(|(c, _)| c.as_str()), &lines, &requests),
        ("taste_card", &schema),
    )
    .await?;
    let card = super::clip(update.card.trim(), prompts::TASTE_MAX_CHARS);
    if card.is_empty() {
        return Ok(());
    }
    store::save_taste(&state.db, user_id, &card)
        .await
        .map_err(db_err)
}

/// Fail runs a restart left working.
pub async fn sweep_stale(state: &AppState) {
    match store::fail_stale_runs(&state.db, &iso_since(Some(STALE_AFTER_MINUTES))).await {
        Ok(0) => {}
        Ok(n) => tracing::info!("marked {n} unfinished AI runs as failed"),
        Err(e) => tracing::warn!("sweeping unfinished AI runs failed: {e:#}"),
    }
}

/// How much new feedback waits to be folded into the taste card.
///
/// # Errors
///
/// Fails on database errors.
pub async fn pending_feedback(state: &AppState, user_id: i64) -> anyhow::Result<(usize, usize)> {
    let current = store::taste(&state.db, user_id).await?;
    let feedback = store::feedback(&state.db, user_id, 1000).await?;
    let since = current
        .as_ref()
        .map(|(_, at)| at.as_str())
        .unwrap_or_default();
    let pending = feedback
        .iter()
        .filter(|f| f.updated_at.as_str() > since)
        .count();
    Ok((feedback.len(), pending))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_requests() {
        let body = json!({"prompt": "  cozy mystery  ", "seed": {"mediaType": "tv", "tmdbId": 1399}, "only": "tv", "refinements": ["Less violent", ""]});
        let parsed = body.as_object().map(Request::parse).and_then(Result::ok);
        assert!(parsed.is_some(), "request parses");
        let req = parsed.unwrap_or_default();
        assert_eq!(req.prompt, "cozy mystery", "trimmed");
        assert_eq!(req.seed, Some(("tv", 1399)), "seed");
        assert_eq!(req.only, Some("tv"), "only");
        assert_eq!(
            req.refinements,
            vec![String::from("Less violent")],
            "blank refinements dropped"
        );
        let long = json!({"prompt": "x".repeat(MAX_PROMPT_CHARS + 1)});
        assert!(
            long.as_object()
                .map(Request::parse)
                .is_some_and(|r| r.is_err()),
            "too long"
        );
        let bad = json!({"seed": {"mediaType": "game", "tmdbId": 1}});
        assert!(
            bad.as_object()
                .map(Request::parse)
                .is_some_and(|r| r.is_err()),
            "bad seed"
        );
    }

    #[test]
    fn whole_ids() {
        assert_eq!(whole(603.0), Some(603), "integral float");
        assert_eq!(whole(-1.0), None, "negative");
    }
}
