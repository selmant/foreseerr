//! `simkl.ts`, with the user client of `server/lib/simkl.ts` and the
//! writes of `server/api/simkl`.
//!
//! History and ratings are written to Simkl, then a forced sync mirrors
//! them into `simkl_sync_item`, which the reads use.

use std::time::Duration;

use serde_json::{json, Map, Value};

use super::dispatcher::{Fut, MarkOptions, Provider, Thrown, Write};
use super::env::{stored_false, text, Env};
use super::score::{provider_to_stars, stars_to_provider};
use super::types::{Capabilities, Item, ProviderId, Status, FULL};
use crate::db::Bind;
use crate::mappinglayer::MediaType;

const BASE_URL: &str = "https://api.simkl.com";

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

/// `new SimklAPI({ accessToken, onUnauthorized })`.
#[derive(Debug)]
pub struct SimklUser {
    http: reqwest::Client,
    client_id: String,
    token: String,
    version: String,
    timeout: Option<Duration>,
    settings_id: i64,
    user_id: i64,
    unauthorized_handled: std::sync::atomic::AtomicBool,
    next_at: tokio::sync::Mutex<Option<tokio::time::Instant>>,
}

/// `createSimklUserClient(userId)`.
///
/// # Errors
///
/// Not configured, not linked, database failures.
pub async fn user_client(env: &Env<'_>) -> Result<SimklUser, Thrown> {
    let client_id = crate::jsval::trim(env.settings.str("/simkl/clientId")).to_owned();
    if client_id.is_empty() {
        return Err(String::from(
            "Simkl application Client ID is not configured",
        ));
    }
    let row = env
        .user_settings(r#"CAST("id" AS BIGINT) AS "id", "simklAccessToken""#)
        .await?;
    let Some(token) = text(row.as_ref(), "simklAccessToken") else {
        return Err(String::from("User has not linked a Simkl account"));
    };
    let timeout = env
        .settings
        .get("/network/apiRequestTimeout")
        .and_then(Value::as_u64)
        .filter(|ms| *ms > 0)
        .map(Duration::from_millis);
    Ok(SimklUser {
        http: env.state.outbound.clone(),
        client_id,
        token,
        version: env.state.version.version.clone(),
        timeout,
        settings_id: row
            .as_ref()
            .and_then(|r| r.get("id"))
            .and_then(Value::as_i64)
            .unwrap_or(0),
        user_id: env.user,
        unauthorized_handled: std::sync::atomic::AtomicBool::new(false),
        next_at: tokio::sync::Mutex::new(None),
    })
}

impl SimklUser {
    /// `pace(post)`: requests of one client at least 100 ms (1 s after a
    /// POST) apart.
    async fn pace(&self, post: bool) {
        let mut next = self.next_at.lock().await;
        if let Some(at) = *next {
            tokio::time::sleep_until(at).await;
        }
        let interval = Duration::from_millis(if post { 1000 } else { 100 });
        *next = Some(tokio::time::Instant::now() + interval);
    }

    /// `request(method, path, body)`.
    ///
    /// # Errors
    ///
    /// Node's Simkl errors.
    pub async fn request(
        &self,
        env: &Env<'_>,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, Thrown> {
        let post = body.is_some();
        self.pace(post).await;
        let separator = if path.contains('?') { '&' } else { '?' };
        let url = format!(
            "{BASE_URL}{path}{separator}client_id={}&app-name=foreseerr&app-version={}",
            crate::jsval::form_encode(&self.client_id),
            crate::jsval::form_encode(&self.version)
        );
        let mut first = true;
        loop {
            let mut req = if post {
                self.http.post(&url)
            } else {
                self.http.get(&url)
            };
            req = req
                .header(reqwest::header::ACCEPT, "application/json")
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .header("simkl-api-key", &self.client_id)
                .header("app-name", "foreseerr")
                .header("app-version", &self.version)
                .header(
                    reqwest::header::USER_AGENT,
                    format!("Foreseerr/{} (Simkl integration)", self.version),
                )
                .header(
                    reqwest::header::AUTHORIZATION,
                    format!("Bearer {}", self.token),
                );
            if let Some(body) = body {
                req = req.body(body.to_string());
            }
            if let Some(timeout) = self.timeout {
                req = req.timeout(timeout);
            }
            let status = match req.send().await {
                Ok(res) if res.status().is_success() => {
                    let text = res.text().await.unwrap_or_default();
                    return Ok(serde_json::from_str::<Value>(&text)
                        .map_or(Value::String(text), crate::tmdb::js_numbers));
                }
                Ok(res) => {
                    let status = res.status().as_u16();
                    if status == 429 {
                        let after = res
                            .headers()
                            .get("retry-after")
                            .and_then(|v| v.to_str().ok())
                            .map_or(f64::NAN, crate::jsval::number_of_str);
                        let after = if after.is_nan() || after == 0.0 {
                            1.0
                        } else {
                            after
                        };
                        return Err(format!(
                            "Simkl API rate limited; retry after {}s",
                            crate::jsnum::to_string(after.max(1.0))
                        ));
                    }
                    Some(status)
                }
                Err(_) => None,
            };
            if status == Some(401) {
                self.unauthorized(env).await;
                return Err(String::from(
                    "Simkl authorization was rejected; reconnect the linked account",
                ));
            }
            let temporary = status.is_none_or(|s| s >= 500);
            if !post && first && temporary {
                first = false;
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }
            return Err(match status {
                Some(s) if !temporary => format!("Request failed with status code {s}"),
                _ => String::from("Simkl is temporarily unavailable"),
            });
        }
    }

    /// `onUnauthorized`, once: drop the link and the user's synced rows.
    async fn unauthorized(&self, env: &Env<'_>) {
        if self
            .unauthorized_handled
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            return;
        }
        let db = &env.state.db;
        let cleared = async {
            db.execute(
                r#"UPDATE "user_settings" SET "simklAccessToken" = NULL, "simklUsername" = NULL, "simklUserId" = NULL WHERE "id" = ?1"#,
                &[Bind::Int(self.settings_id)],
            )
            .await?;
            db.execute(
                r#"DELETE FROM "simkl_sync_item" WHERE "userId" = ?1"#,
                &[Bind::Int(self.user_id)],
            )
            .await?;
            db.execute(
                r#"DELETE FROM "simkl_sync_state" WHERE "userId" = ?1"#,
                &[Bind::Int(self.user_id)],
            )
            .await
        };
        if let Err(e) = cleared.await {
            tracing::error!("clearing the rejected Simkl link failed: {e:#}");
        }
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
