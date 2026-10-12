//! `refreshUserTraktTokens(userId, callerTokens)` (`server/lib/trakt.ts`)
//! behind `POST /internal/trakt/refresh`.
//!
//! One refresh per user at a time,
//! callers queued behind it reuse the new pair, a rejected refresh token
//! clears the link.

use std::sync::LazyLock;
use std::time::Duration;

use serde_json::{Map, Value};

use super::synccache::{self, Provider};
use super::KeyLock;
use crate::db::Bind;
use crate::standalone::internal::Answer;
use crate::state::AppState;
use crate::trakt::TraktClient;

const TOKEN_URL: &str = "https://api.trakt.tv/oauth/token";
const RAW_TIMEOUT: Duration = Duration::from_secs(15);
const RAW_USER_AGENT: &str = "axios/1.18.0";
/// `TraktReconnectRequiredError`'s default message.
const RECONNECT: &str = "Trakt authorization expired; reconnect your account";

/// `traktRefreshLock`.
static LOCKS: LazyLock<KeyLock> = LazyLock::new(KeyLock::default);

/// A thrown error: its `name` and `message`.
type Thrown = (String, String);

fn thrown(name: &str, message: &str) -> Thrown {
    (name.to_owned(), message.to_owned())
}

/// The route: `{ tokens }`, or `{ error: { name, message } }` (always 200).
pub async fn answer(state: &AppState, body: Option<&Value>) -> Answer {
    let user_id = crate::jsval::number_of(body.and_then(|b| b.get("userId")));
    let caller = body.and_then(|b| b.get("tokens"));
    let mut out = Map::new();
    match refresh(state, user_id, caller).await {
        Ok(tokens) => {
            out.insert(String::from("tokens"), Value::Object(tokens));
        }
        Err((name, message)) => {
            out.insert(String::from("error"), super::error_object(&name, &message));
        }
    }
    Answer::json(200, Value::Object(out))
}

/// The stored link: the settings row and its token state.
struct Latest {
    settings_id: i64,
    access: String,
    refresh: String,
    expires_at: f64,
    has_user_id: bool,
}

/// `getUserTraktSettings(userId)` and `tokenStateFromSettings`.
async fn latest(state: &AppState, user_id: i64) -> Result<Option<Latest>, Thrown> {
    let rows = state
        .db
        .rows(
            r#"SELECT CAST("settings"."id" AS BIGINT) AS "id",
                      "settings"."traktAccessToken" AS "access",
                      "settings"."traktRefreshToken" AS "refresh",
                      CAST("settings"."traktTokenExpiresAt" AS TEXT) AS "expires",
                      "settings"."traktUserId" AS "traktUserId"
               FROM "user_settings" "settings"
               LEFT JOIN "user" "user" ON "user"."id" = "settings"."userId"
               WHERE "user"."id" = ?1"#,
            &[Bind::Int(user_id)],
        )
        .await
        .map_err(|e| thrown("DatabaseError", &crate::db::failure_message(&e)))?;
    let Some(row) = rows.into_iter().next() else {
        return Ok(None);
    };
    let text = |key: &str| {
        row.get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let (Some(access), Some(refresh)) = (text("access"), text("refresh")) else {
        return Ok(None);
    };
    let expires_at = text("expires").map_or(0.0, |t| crate::jsval::number_of_str(&t));
    Ok(Some(Latest {
        settings_id: row.get("id").and_then(Value::as_i64).unwrap_or(0),
        access,
        refresh,
        expires_at,
        has_user_id: text("traktUserId").is_some(),
    }))
}

fn token_state(
    access: Option<Value>,
    refresh: Option<Value>,
    expires_at: f64,
) -> Map<String, Value> {
    let mut out = Map::new();
    if let Some(access) = access {
        out.insert(String::from("accessToken"), access);
    }
    if let Some(refresh) = refresh {
        out.insert(String::from("refreshToken"), refresh);
    }
    out.insert(String::from("expiresAt"), crate::jsnum::json(expires_at));
    out
}

/// `refreshUserTraktTokens`.
async fn refresh(
    state: &AppState,
    user_id: f64,
    caller: Option<&Value>,
) -> Result<Map<String, Value>, Thrown> {
    let id = format!("{user_id}").parse::<i64>().ok();
    let _guard = match id {
        Some(id) => Some(LOCKS.acquire(id).await),
        None => None,
    };
    let latest = match id {
        Some(id) => latest(state, id).await?,
        None => None,
    };
    let Some(latest) = latest else {
        return Err(thrown("TraktReconnectRequiredError", RECONNECT));
    };
    let Some(caller) = caller.filter(|c| !c.is_null()) else {
        return Err(thrown("Error", "No Trakt tokens were given."));
    };
    let same = |key: &str, stored: &str| caller.get(key).and_then(Value::as_str) == Some(stored);
    if !same("accessToken", &latest.access) || !same("refreshToken", &latest.refresh) {
        return Ok(token_state(
            Some(Value::from(latest.access)),
            Some(Value::from(latest.refresh)),
            latest.expires_at,
        ));
    }
    let settings = super::settings(state)
        .await
        .map_err(|e| thrown("Error", &format!("{e:#}")))?;
    let client_id = crate::jsval::trim(settings.str("/trakt/clientId")).to_owned();
    let client_secret = crate::jsval::trim(settings.str("/trakt/clientSecret")).to_owned();
    if client_id.is_empty() || client_secret.is_empty() {
        return Err(thrown(
            "TraktNotConfiguredError",
            "Trakt application credentials are not configured",
        ));
    }
    let payload = match post_refresh(state, &client_id, &client_secret, &latest.refresh).await? {
        Refreshed::Payload(payload) => payload,
        Refreshed::Rejected(status) => {
            tracing::warn!(
                "Trakt refresh token rejected; account must reconnect (user {user_id}, status {status})"
            );
            clear_credentials(state, latest.settings_id, id).await?;
            return Err(thrown("TraktReconnectRequiredError", RECONNECT));
        }
    };
    let applied = apply_tokens(&payload, &latest);
    let mut writes: Vec<(&str, Value)> = Vec::new();
    if let Some(access) = &applied.access {
        writes.push(("traktAccessToken", access.clone()));
    }
    if let Some(refresh) = &applied.refresh {
        writes.push(("traktRefreshToken", refresh.clone()));
    }
    writes.push((
        "traktTokenExpiresAt",
        Value::from(crate::jsnum::to_string(applied.expires_at)),
    ));
    if !latest.has_user_id {
        let client = TraktClient::with_tokens(
            state.outbound.clone(),
            client_id,
            applied.client_access.clone(),
            applied.client_refresh.clone(),
            applied.expires_at,
        );
        match client.user_profile().await {
            Ok((username, trakt_id)) => {
                writes.push(("traktUserId", Value::from(trakt_id)));
                writes.push(("traktUsername", Value::from(username)));
            }
            Err(e) => tracing::warn!(
                "Failed to backfill Trakt user identity during refresh (user {user_id}): {}",
                e.message()
            ),
        }
    }
    save(state, latest.settings_id, &writes).await?;
    Ok(token_state(
        applied.access,
        applied.refresh,
        applied.expires_at,
    ))
}

enum Refreshed {
    Payload(Value),
    Rejected(u16),
}

/// `refreshAccessToken()` without a callback: the `rawAxios` POST.
async fn post_refresh(
    state: &AppState,
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
) -> Result<Refreshed, Thrown> {
    let mut body = Map::new();
    body.insert(String::from("refresh_token"), Value::from(refresh_token));
    body.insert(String::from("client_id"), Value::from(client_id));
    body.insert(String::from("client_secret"), Value::from(client_secret));
    body.insert(
        String::from("redirect_uri"),
        Value::from("urn:ietf:wg:oauth:2.0:oob"),
    );
    body.insert(String::from("grant_type"), Value::from("refresh_token"));
    let res = state
        .outbound
        .post(TOKEN_URL)
        .timeout(RAW_TIMEOUT)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "application/json")
        .header("trakt-api-version", "2")
        .header("trakt-api-key", client_id)
        .header(reqwest::header::USER_AGENT, RAW_USER_AGENT)
        .body(Value::Object(body).to_string())
        .send()
        .await
        .map_err(|e| thrown("RequestError", &crate::outbound::describe(&e)))?;
    let status = res.status().as_u16();
    if status == 400 || status == 401 {
        return Ok(Refreshed::Rejected(status));
    }
    if !(200..300).contains(&status) {
        return Err(thrown(
            "Error",
            &format!("Trakt token refresh failed with status {status}"),
        ));
    }
    let text = res
        .text()
        .await
        .map_err(|e| thrown("RequestError", &crate::outbound::describe(&e)))?;
    Ok(Refreshed::Payload(
        serde_json::from_str::<Value>(&text).map_or(Value::String(text), crate::tmdb::js_numbers),
    ))
}

/// What `applyTokens(payload)` leaves: the raw `access_token` and
/// `refresh_token` it returns, the client's pair and `expiresAt`.
#[derive(Debug, Clone, PartialEq)]
struct Applied {
    access: Option<Value>,
    refresh: Option<Value>,
    client_access: String,
    client_refresh: String,
    expires_at: f64,
}

fn apply_tokens(payload: &Value, latest: &Latest) -> Applied {
    apply_tokens_at(payload, latest, crate::clock::now_millis())
}

fn apply_tokens_at(payload: &Value, latest: &Latest, now_ms: i64) -> Applied {
    let truthy = |key: &str| {
        payload
            .get(key)
            .filter(|v| crate::settings::public::truthy(Some(v)))
    };
    let or_number = |key: &str| truthy(key).map_or(0.0, |v| crate::jsval::number_of(Some(v)));
    let expires_in = or_number("expires_in");
    // `if (expiresIn)`: zero and NaN keep the old expiry.
    let expires_at = if expires_in.abs() > 0.0 {
        let created = or_number("created_at");
        let base = if created.is_finite() && created > 0.0 {
            created
        } else {
            (crate::jsnum::from_i64(now_ms) / 1000.0).floor()
        };
        base + expires_in
    } else {
        latest.expires_at
    };
    let text = |v: Option<&Value>, fallback: &str| {
        v.map_or_else(
            || fallback.to_owned(),
            |v| crate::media::js_string(Some(v)).into_owned(),
        )
    };
    Applied {
        access: payload.get("access_token").cloned(),
        refresh: payload.get("refresh_token").cloned(),
        client_access: text(truthy("access_token"), &latest.access),
        client_refresh: text(truthy("refresh_token"), &latest.refresh),
        expires_at,
    }
}

/// `getRepository(UserSettings).save(latestSettings)` for the columns the
/// refresh set.
async fn save(state: &AppState, settings_id: i64, writes: &[(&str, Value)]) -> Result<(), Thrown> {
    let mut sets = Vec::with_capacity(writes.len());
    let mut binds = Vec::with_capacity(writes.len() + 1);
    for (column, value) in writes {
        if value.is_null() {
            sets.push(format!("\"{column}\" = NULL"));
            continue;
        }
        binds.push(Bind::Text(
            crate::media::js_string(Some(value)).into_owned(),
        ));
        let n = binds.len();
        if *column == "traktTokenExpiresAt" && state.db.is_postgres() {
            sets.push(format!("\"{column}\" = CAST(?{n} AS BIGINT)"));
        } else {
            sets.push(format!("\"{column}\" = ?{n}"));
        }
    }
    binds.push(Bind::Int(settings_id));
    let sql = format!(
        "UPDATE \"user_settings\" SET {} WHERE \"id\" = ?{}",
        sets.join(", "),
        binds.len()
    );
    state
        .db
        .execute(&sql, &binds)
        .await
        .map(|_| ())
        .map_err(|e| thrown("DatabaseError", &crate::db::failure_message(&e)))
}

/// `clearUserTraktCredentials(settingsId, userId)`.
async fn clear_credentials(
    state: &AppState,
    settings_id: i64,
    user_id: Option<i64>,
) -> Result<(), Thrown> {
    state
        .db
        .execute(
            r#"UPDATE "user_settings" SET "traktAccessToken" = NULL, "traktRefreshToken" = NULL,
               "traktTokenExpiresAt" = NULL, "traktUsername" = NULL, "traktUserId" = NULL
               WHERE "id" = ?1"#,
            &[Bind::Int(settings_id)],
        )
        .await
        .map_err(|e| thrown("DatabaseError", &crate::db::failure_message(&e)))?;
    if let Some(user_id) = user_id {
        synccache::invalidate_user(state, user_id, Provider::Trakt).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn latest() -> Latest {
        Latest {
            settings_id: 1,
            access: String::from("old-a"),
            refresh: String::from("old-r"),
            expires_at: 100.0,
            has_user_id: true,
        }
    }

    #[test]
    fn applies_tokens_like_the_client() {
        let applied = apply_tokens_at(
            &json!({"access_token": "a", "refresh_token": "r", "expires_in": 7_776_000, "created_at": 1_700_000_000}),
            &latest(),
            0,
        );
        assert!(
            (applied.expires_at - 1_707_776_000.0).abs() < f64::EPSILON,
            "created_at + expires_in"
        );
        assert_eq!(applied.access, Some(json!("a")), "returned as sent");
        let applied = apply_tokens_at(&json!({"expires_in": 60}), &latest(), 5_000);
        assert!(
            (applied.expires_at - 65.0).abs() < f64::EPSILON,
            "now + expires_in"
        );
        assert_eq!(applied.access, None, "an absent token stays absent");
        assert_eq!(applied.client_access, "old-a", "the client keeps its token");
        let applied = apply_tokens_at(&json!({"expires_in": "soon"}), &latest(), 5_000);
        assert!(
            (applied.expires_at - 100.0).abs() < f64::EPSILON,
            "NaN keeps the old expiry"
        );
    }

    #[test]
    fn token_state_shape() {
        assert_eq!(
            Value::Object(token_state(Some(json!("a")), None, 12.0)),
            json!({"accessToken": "a", "expiresAt": 12}),
            "undefined keys dropped"
        );
    }
}
