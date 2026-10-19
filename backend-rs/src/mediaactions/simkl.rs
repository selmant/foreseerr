//! `simkl.ts`, with the user client of `server/lib/simkl.ts` and the
//! writes of `server/api/simkl`.
//!
//! History and ratings are written to Simkl, then a forced sync mirrors
//! them into `simkl_sync_item`, which the reads use.

use serde_json::{json, Map, Value};

use super::dispatcher::{Fut, MarkOptions, Provider, Thrown, Write};
use super::env::{stored_false, text, Env};
use super::score::{provider_to_stars, stars_to_provider};
use super::types::{Capabilities, Item, ProviderId, Status, FULL};
use crate::db::Bind;
use crate::mappinglayer::MediaType;

/// `syncSimklUser(userId, force)`, in this process.
///
/// # Errors
///
/// What the sync throws (it catches the upstream failures itself).
pub async fn sync(env: &Env<'_>, force: bool) -> Result<(), Thrown> {
    let body = json!({ "userId": env.user, "force": force });
    let answer = crate::routes::procstate::simklsync::answer(env.state, Some(&body)).await;
    answer
        .into_result("/simkl/sync")
        .map(drop)
        .map_err(|e| format!("{e:#}"))
}

/// `createSimklUserClient(userId)`'s client.
#[derive(Debug)]
pub struct SimklUser(crate::simklapi::Client);

/// `createSimklUserClient(userId)`.
///
/// # Errors
///
/// Not configured, not linked, database failures.
pub async fn user_client(env: &Env<'_>) -> Result<SimklUser, Thrown> {
    let client_id = crate::jsval::trim(env.settings.str("/simkl/clientId")).to_owned();
    if client_id.is_empty() {
        return Err(String::from(crate::simklapi::NOT_CONFIGURED));
    }
    let config = crate::simklapi::Config::new(
        &env.state.outbound,
        &client_id,
        &env.state.version.version,
        crate::simklapi::timeout_of(&env.settings),
    );
    crate::simklapi::user_client(&env.state.db, &config, env.user)
        .await
        .map(SimklUser)
}

impl SimklUser {
    /// `request(method, path, body)`.
    ///
    /// # Errors
    ///
    /// Node's Simkl errors.
    pub async fn request(
        &self,
        _env: &Env<'_>,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, Thrown> {
        self.0.request(path, body).await.map_err(|e| e.message())
    }
}

/// `{ movies | shows: [entry] }`.
fn typed_body(media_type: MediaType, entry: Value) -> Value {
    let key = match media_type {
        MediaType::Movie => "movies",
        MediaType::Tv => "shows",
    };
    let mut out = Map::new();
    out.insert(key.to_owned(), Value::Array(vec![entry]));
    Value::Object(out)
}

fn ids_entry(tmdb_id: i64, rating: Option<f64>) -> Value {
    let mut entry = Map::new();
    entry.insert(String::from("ids"), json!({ "tmdb": tmdb_id }));
    if let Some(rating) = rating {
        entry.insert(String::from("rating"), crate::jsval::num(rating));
    }
    Value::Object(entry)
}

/// `SimklMediaActionProvider.isAvailable(userId)`.
///
/// # Errors
///
/// Database failures.
pub async fn available(env: &Env<'_>) -> Result<bool, Thrown> {
    if env.provider_off("simkl") {
        return Ok(false);
    }
    let row = env
        .user_settings(r#""simklAccessToken", "mediaActionsSimklEnabled""#)
        .await?;
    Ok(text(row.as_ref(), "simklAccessToken").is_some()
        && !stored_false(row.as_ref(), "mediaActionsSimklEnabled"))
}

/// `SimklMediaActionProvider`.
#[derive(Debug)]
pub struct SimklProvider<'a> {
    env: &'a Env<'a>,
}

impl<'a> SimklProvider<'a> {
    /// For one request.
    #[must_use]
    pub const fn new(env: &'a Env<'a>) -> Self {
        Self { env }
    }

    /// `item(userId, ref)` read through `statusFrom`: the latest watched
    /// row of the title after a sync.
    async fn read(&self, item: Item) -> Result<Status, Thrown> {
        sync(self.env, false).await?;
        let db = &self.env.state.db;
        let simkl_type = match item.media_type {
            MediaType::Movie => "movie",
            MediaType::Tv => "show",
        };
        let sql = format!(
            r#"SELECT {} AS "lastWatchedAt", "userRating" FROM "simkl_sync_item" WHERE "userId" = ?1 AND "tmdbId" = ?2 AND "simklType" = ?3 ORDER BY "lastWatchedAt" DESC LIMIT 1"#,
            crate::naivetime::select(db, "\"lastWatchedAt\"")
        );
        let rows = db
            .rows(
                &sql,
                &[
                    Bind::Int(self.env.user),
                    Bind::Int(item.tmdb_id),
                    Bind::Text(simkl_type.to_owned()),
                ],
            )
            .await
            .map_err(|e| format!("{e:#}"))?;
        let row = rows.first();
        let watched = row
            .and_then(|r| r.get("lastWatchedAt"))
            .is_some_and(|v| !v.is_null());
        let rating = row
            .and_then(|r| r.get("userRating"))
            .filter(|v| !v.is_null())
            .map(|v| crate::jsval::number_of(Some(v)));
        Ok(Status {
            watched,
            rating,
            rating_stars: rating.map(provider_to_stars),
            error: None,
        })
    }

    async fn read_many(&self, items: &[Item]) -> Result<Vec<(Item, Status)>, Thrown> {
        sync(self.env, false).await?;
        let mut out = Vec::new();
        for item in items {
            out.push((*item, self.read(*item).await?));
        }
        Ok(out)
    }

    async fn post(&self, client: &SimklUser, path: &str, body: &Value) -> Result<(), Thrown> {
        client.request(self.env, path, Some(body)).await.map(drop)
    }

    async fn mark(&self, item: Item, options: MarkOptions) -> Result<Status, Thrown> {
        let client = user_client(self.env).await?;
        let body = typed_body(item.media_type, ids_entry(item.tmdb_id, None));
        self.post(&client, "/sync/history", &body).await?;
        if let Some(stars) = options.rating_stars {
            let rating = stars_to_provider(stars)?;
            let body = typed_body(item.media_type, ids_entry(item.tmdb_id, Some(rating)));
            self.post(&client, "/sync/ratings", &body).await?;
        }
        sync(self.env, true).await?;
        self.read(item).await
    }

    async fn unmark(&self, item: Item, remove_rating: bool) -> Result<Status, Thrown> {
        let client = user_client(self.env).await?;
        let body = typed_body(item.media_type, ids_entry(item.tmdb_id, None));
        self.post(&client, "/sync/history/remove", &body).await?;
        if remove_rating {
            self.post(&client, "/sync/ratings/remove", &body).await?;
        }
        sync(self.env, true).await?;
        self.read(item).await
    }

    async fn rate(&self, item: Item, stars: f64) -> Result<Status, Thrown> {
        let client = user_client(self.env).await?;
        let rating = stars_to_provider(stars)?;
        let body = typed_body(item.media_type, ids_entry(item.tmdb_id, Some(rating)));
        self.post(&client, "/sync/ratings", &body).await?;
        sync(self.env, true).await?;
        self.read(item).await
    }
}

impl Provider for SimklProvider<'_> {
    fn id(&self) -> ProviderId {
        ProviderId::Simkl
    }

    fn capabilities(&self) -> Capabilities {
        FULL
    }

    fn is_available(&self) -> Fut<'_, Result<bool, Thrown>> {
        Box::pin(available(self.env))
    }

    fn status(&self, item: Item) -> Fut<'_, Result<Status, Thrown>> {
        Box::pin(self.read(item))
    }

    fn statuses<'b>(&'b self, items: &'b [Item]) -> Fut<'b, Result<Vec<(Item, Status)>, Thrown>> {
        Box::pin(self.read_many(items))
    }

    fn write(&self, item: Item, write: Write) -> Fut<'_, Result<Status, Thrown>> {
        Box::pin(async move {
            match write {
                Write::Mark(options) => self.mark(item, options).await,
                Write::Unmark { remove_rating } => self.unmark(item, remove_rating).await,
                Write::Rate(stars) => self.rate(item, stars).await,
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bodies() {
        assert_eq!(
            typed_body(MediaType::Tv, ids_entry(1399, Some(8.0))),
            json!({"shows": [{"ids": {"tmdb": 1399}, "rating": 8}]}),
            "rating body"
        );
        assert_eq!(
            typed_body(MediaType::Movie, ids_entry(550, None)),
            json!({"movies": [{"ids": {"tmdb": 550}}]}),
            "history body"
        );
    }
}
