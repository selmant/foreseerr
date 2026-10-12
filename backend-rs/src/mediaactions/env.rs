//! What every provider of one request reads: the process state, the
//! settings as the request sees them and the signed-in user.

use std::sync::Arc;

use serde_json::{Map, Value};

use crate::db::Bind;
use crate::mappinglayer::Ctx;
use crate::settings::Settings;
use crate::state::AppState;

/// `MediaServerType.JELLYFIN`.
const JELLYFIN: i64 = 2;

/// One request's view.
#[derive(Debug, Clone)]
pub struct Env<'a> {
    /// Database, outgoing client, caches.
    pub state: &'a AppState,
    /// settings.json.
    pub settings: Arc<Settings>,
    /// `req.user.id`.
    pub user: i64,
}

impl Env<'_> {
    /// `settings.mediaActions?.providers?.[id] === false`.
    #[must_use]
    pub fn provider_off(&self, id: &str) -> bool {
        self.settings.get(&format!("/mediaActions/providers/{id}")) == Some(&Value::Bool(false))
    }

    /// `settings.main.mediaServerType === MediaServerType.JELLYFIN`.
    #[must_use]
    pub fn jellyfin_server(&self) -> bool {
        self.settings
            .get("/main/mediaServerType")
            .is_some_and(|v| v.is_number() && v.as_i64() == Some(JELLYFIN))
    }

    /// `settings.trakt.provider === 'jellyfin'` (Better Trakt).
    #[must_use]
    pub fn jellyfin_trakt(&self) -> bool {
        self.settings.get("/trakt/provider") == Some(&Value::from("jellyfin"))
    }

    /// The mapping layer's lookups, with `new TheMovieDb()`'s language.
    #[must_use]
    pub fn ctx(&self) -> Ctx<'_> {
        Ctx::with_settings(self.state, &self.settings)
    }

    /// The user's `user_settings` row (the columns asked for), if any.
    ///
    /// # Errors
    ///
    /// Database failures, as their message.
    pub async fn user_settings(&self, columns: &str) -> Result<Option<Map<String, Value>>, String> {
        Self::user_settings_of(self.state, self.user, columns).await
    }

    /// [`Env::user_settings`] of any user.
    ///
    /// # Errors
    ///
    /// Database failures, as their message.
    pub async fn user_settings_of(
        state: &AppState,
        user: i64,
        columns: &str,
    ) -> Result<Option<Map<String, Value>>, String> {
        let sql = format!(r#"SELECT {columns} FROM "user_settings" WHERE "userId" = ?1 LIMIT 1"#);
        let rows = state
            .db
            .rows(&sql, &[Bind::Int(user)])
            .await
            .map_err(|e| format!("{e:#}"))?;
        Ok(rows.into_iter().next())
    }
}

/// A boolean column stored as `false` (`=== false`; `SQLite` gives 0).
#[must_use]
pub fn stored_false(row: Option<&Map<String, Value>>, key: &str) -> bool {
    match row.and_then(|r| r.get(key)) {
        Some(Value::Bool(b)) => !*b,
        Some(Value::Number(n)) => n.as_i64() == Some(0),
        _ => false,
    }
}

/// A non-empty text column.
#[must_use]
pub fn text(row: Option<&Map<String, Value>>, key: &str) -> Option<String> {
    row.and_then(|r| r.get(key))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn columns() {
        let row = json!({"a": 0, "b": false, "c": null, "d": 1, "t": ""});
        let row = row.as_object();
        assert!(stored_false(row, "a"), "SQLite false");
        assert!(stored_false(row, "b"), "Postgres false");
        assert!(!stored_false(row, "c"), "null is not false");
        assert!(!stored_false(row, "d"), "true");
        assert!(!stored_false(None, "a"), "no row");
        assert_eq!(text(row, "t"), None, "empty text");
    }
}
