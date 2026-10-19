//! `POST /internal/settings/effects`: what the settings writes do besides
//! saving settings.json, in the order the handler runs them. Counting
//! effects report their count.

use serde_json::{json, Map, Value};

use super::synccache::{self, Provider};
use crate::standalone::internal::Answer;
use crate::state::AppState;

/// The effects Node runs on its own copies while it is still there (its
/// `MDBList` client serves the routes it still answers).
const NODE_MEMORY_EFFECTS: [&str; 1] = ["clearMdblistProviderState"];

/// The route.
pub async fn answer(state: &AppState, body: Option<&Value>) -> Answer {
    let Some(effects) = body
        .and_then(|b| b.get("effects"))
        .and_then(Value::as_array)
    else {
        return Answer::message(400, "effects must be an array");
    };
    let mut results = Map::new();
    for effect in effects {
        let name = effect.as_str().unwrap_or("");
        let counted = match name {
            "clearIntegrationHealthCache" => {
                super::health::clear();
                None
            }
            "clearMdblistProviderState" => {
                crate::mdblist::clear_provider_state();
                None
            }
            "clearSyncCache" => {
                synccache::clear_all(state).await;
                None
            }
            "clearAnilistSyncCache" => {
                synccache::clear_anilist(state).await;
                None
            }
            "disconnectAllTraktLinks" => Some(disconnect_trakt(state).await.map(Value::from)),
            "disconnectAllSimklLinks" => Some(disconnect_simkl(state).await.map(Value::from)),
            "disconnectAllAnilistLinks" => Some(disconnect_anilist(state).await.map(Value::from)),
            _ => return Answer::message(400, &format!("Unknown effect: {}", js_string_of(effect))),
        };
        match counted {
            Some(Ok(count)) => {
                results.insert(name.to_owned(), count);
            }
            Some(Err(e)) => return Answer::message(500, &format!("{e:#}")),
            None => {}
        }
    }
    tell_node(state, effects).await;
    Answer::json(200, Value::Object(results))
}

/// While Node runs it keeps its own `MDBList` client; reset that too.
async fn tell_node(state: &AppState, effects: &[Value]) {
    if crate::standalone::enabled() {
        return;
    }
    let memory: Vec<&Value> = effects
        .iter()
        .filter(|e| e.as_str().is_some_and(|e| NODE_MEMORY_EFFECTS.contains(&e)))
        .collect();
    if memory.is_empty() {
        return;
    }
    let Ok(settings) = super::settings(state).await else {
        return;
    };
    let url = format!(
        "{}/internal/settings/effects",
        state.env.node_url.trim_end_matches('/')
    );
    let sent = state
        .internal
        .post(url)
        .header("X-API-Key", settings.api_key())
        .json(&json!({ "effects": memory }))
        .send()
        .await;
    if let Err(e) = sent {
        tracing::warn!("Node's MDBList state could not be reset: {e:#}");
    }
}

/// `String(value)` for what an effects array may hold.
fn js_string_of(value: &Value) -> String {
    match value {
        Value::Object(_) => String::from("[object Object]"),
        Value::Array(items) => items
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    js_string_of(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        other @ (Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)) => {
            crate::media::js_string(Some(other)).into_owned()
        }
    }
}

/// `disconnectAllTraktLinks()`: clear every linked account's tokens and
/// drop those users' sync snapshots.
///
/// # Errors
///
/// Fails on database errors.
pub async fn disconnect_trakt(state: &AppState) -> anyhow::Result<usize> {
    let linked = state
        .db
        .rows(
            r#"SELECT CAST("user"."id" AS BIGINT) AS "userId" FROM "user_settings" "settings"
               LEFT JOIN "user" "user" ON "user"."id" = "settings"."userId"
               WHERE "settings"."traktAccessToken" IS NOT NULL
               AND "settings"."traktRefreshToken" IS NOT NULL"#,
            &[],
        )
        .await?;
    if linked.is_empty() {
        return Ok(0);
    }
    state
        .db
        .execute(
            r#"UPDATE "user_settings" SET "traktAccessToken" = NULL, "traktRefreshToken" = NULL,
               "traktTokenExpiresAt" = NULL, "traktUsername" = NULL, "traktUserId" = NULL
               WHERE "traktAccessToken" IS NOT NULL AND "traktRefreshToken" IS NOT NULL"#,
            &[],
        )
        .await?;
    for row in &linked {
        if let Some(user_id) = row.get("userId").and_then(Value::as_i64) {
            synccache::invalidate_user(state, user_id, Provider::Trakt).await;
        }
    }
    Ok(linked.len())
}

/// `disconnectAllSimklLinks()`: the linked count, then every Simkl link
/// and synced item gone.
///
/// # Errors
///
/// Fails on database errors.
pub async fn disconnect_simkl(state: &AppState) -> anyhow::Result<i64> {
    let linked = state
        .db
        .scalar(
            r#"SELECT CAST(COUNT(DISTINCT("settings"."id")) AS BIGINT) FROM "user_settings" "settings"
               WHERE "settings"."simklUserId" IS NOT NULL"#,
            &[],
        )
        .await?;
    state
        .db
        .execute(
            r#"UPDATE "user_settings" SET "simklAccessToken" = NULL, "simklRefreshToken" = NULL,
               "simklTokenExpiresAt" = NULL, "simklUsername" = NULL, "simklUserId" = NULL
               WHERE "simklUserId" IS NOT NULL"#,
            &[],
        )
        .await?;
    state
        .db
        .execute(r#"DELETE FROM "simkl_sync_item""#, &[])
        .await?;
    state
        .db
        .execute(r#"DELETE FROM "simkl_sync_state""#, &[])
        .await?;
    Ok(linked)
}

/// `disconnectAllAnilistLinks()`: the rows the update touched.
///
/// # Errors
///
/// Fails on database errors.
pub async fn disconnect_anilist(state: &AppState) -> anyhow::Result<u64> {
    state
        .db
        .execute(
            r#"UPDATE "user_settings" SET "anilistAccessToken" = NULL, "anilistTokenExpiresAt" = NULL,
               "anilistUsername" = NULL, "anilistUserId" = NULL
               WHERE "anilistAccessToken" IS NOT NULL"#,
            &[],
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_effects_print_like_string() {
        assert_eq!(js_string_of(&json!("x")), "x", "string");
        assert_eq!(js_string_of(&json!(1.5)), "1.5", "number");
        assert_eq!(js_string_of(&json!(null)), "null", "null");
        assert_eq!(js_string_of(&json!({})), "[object Object]", "object");
        assert_eq!(js_string_of(&json!([1, null, "a"])), "1,,a", "array");
    }
}
