//! The login avatar refresh behind `POST /internal/auth/avatar-check`.
//!
//! `checkAvatarChanged(user)` (`server/routes/avatarproxy.ts`) on the user
//! as `findOne` loads it (with the handler's stale properties laid over
//! it), and the avatar save when the image changed.

use std::sync::Arc;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::super::authcommon::{date_bind, date_param, hostname_of, EMBY, JELLYFIN};
use crate::db::{Bind, Db};
use crate::settings::public::truthy;
use crate::settings::Settings;
use crate::standalone::internal::Answer;
use crate::state::AppState;
use crate::typeorm::Changes;

/// The `user` columns the check reads and may write.
const COLUMNS: [&str; 7] = [
    "email",
    "jellyfinUserId",
    "avatarVersion",
    "avatarETag",
    "avatar",
    "username",
    "jellyfinUsername",
];
/// The properties `overrides` may carry besides `updatedAt`.
const OVERRIDABLE: [&str; 3] = ["avatar", "jellyfinUsername", "username"];
/// The columns `save()` compares.
const SAVED: [&str; 5] = [
    "avatar",
    "username",
    "jellyfinUsername",
    "avatarVersion",
    "avatarETag",
];

/// The user entity as far as the check goes.
#[derive(Debug, Clone, PartialEq)]
struct Entity {
    id: i64,
    columns: Map<String, Value>,
    /// `updatedAt` as `toJSON` prints it, `Null` for null or an invalid
    /// date.
    updated_at: Value,
}

impl Entity {
    fn get(&self, column: &str) -> &Value {
        self.columns.get(column).unwrap_or(&Value::Null)
    }

    fn text(&self, column: &str) -> Option<&str> {
        self.columns.get(column).and_then(Value::as_str)
    }
}

async fn load(db: &Db, id: i64) -> anyhow::Result<Option<Entity>> {
    let list: Vec<String> = COLUMNS.iter().map(|c| format!("\"{c}\"")).collect();
    let sql = format!(
        "SELECT {}, {} AS \"updatedAt\" FROM \"user\" WHERE \"id\" = ?1",
        list.join(", "),
        db.iso_sql("\"updatedAt\"")
    );
    let rows = db.rows(&sql, &[Bind::Int(id)]).await?;
    Ok(rows.into_iter().next().map(|mut row| {
        let updated_at = row.shift_remove("updatedAt").unwrap_or(Value::Null);
        Entity {
            id,
            columns: row,
            updated_at,
        }
    }))
}

/// The route.
pub async fn answer(state: &AppState, body: Option<&Value>) -> Answer {
    let Some(app) = super::app() else {
        return Answer::message(503, "The application state isn't ready");
    };
    let id = crate::jsval::number_of(body.and_then(|b| b.get("userId")));
    let id = (id.is_finite() && id.fract() == 0.0)
        .then(|| format!("{id:.0}").parse::<i64>().ok())
        .flatten();
    let loaded = match id {
        Some(id) => load(&state.db, id).await,
        None => Ok(None),
    };
    let mut entity = match loaded {
        Ok(Some(entity)) => entity,
        Ok(None) => return Answer::message(404, "User not found"),
        Err(e) => return Answer::message(500, &format!("{e:#}")),
    };
    if let Some(overrides) = body
        .and_then(|b| b.get("overrides"))
        .and_then(Value::as_object)
    {
        apply_overrides(&mut entity, overrides);
    }
    let settings = match super::settings(state).await {
        Ok(settings) => settings,
        Err(e) => return Answer::message(500, &format!("{e:#}")),
    };
    match check_changed(&app, &settings, &mut entity).await {
        Ok(true) => {
            let avatar = format!(
                "/avatarproxy/{}?v={}",
                crate::media::js_string(Some(entity.get("jellyfinUserId"))),
                crate::media::js_string(Some(entity.get("avatarVersion")))
            );
            entity
                .columns
                .insert(String::from("avatar"), Value::from(avatar));
            match save(&state.db, &mut entity).await {
                Ok(()) => tracing::debug!("Avatar updated during login (user {})", entity.id),
                Err(e) => tracing::error!("Error handling avatar during login: {e:#}"),
            }
        }
        Ok(false) => {}
        Err(e) => tracing::error!("Error handling avatar during login: {e:#}"),
    }
    let mut out = Map::new();
    out.insert(String::from("avatar"), entity.get("avatar").clone());
    out.insert(String::from("updatedAt"), entity.updated_at.clone());
    Answer::json(200, Value::Object(out))
}

/// `Object.assign(user, rest)` and `user.updatedAt = …`.
fn apply_overrides(entity: &mut Entity, overrides: &Map<String, Value>) {
    for key in OVERRIDABLE {
        if let Some(value) = overrides.get(key) {
            entity.columns.insert(key.to_owned(), value.clone());
        }
    }
    match overrides.get("updatedAt") {
        None => {}
        Some(Value::String(text)) => {
            entity.updated_at = crate::clock::parse_date_millis(text).map_or(Value::Null, |ms| {
                Value::from(crate::clock::Utc::from_unix_millis(ms).iso_string())
            });
        }
        Some(_) => entity.updated_at = Value::Null,
    }
}

/// `checkAvatarChanged(user)`: whether the image's hash changed. The
/// entity carries the new version (and hash) when it was saved.
///
/// # Errors
///
/// Never for the check itself (Node's catch turns failures into "not
/// changed"); kept for the save inside it.
async fn check_changed(
    app: &Arc<AppState>,
    settings: &Settings,
    entity: &mut Entity,
) -> anyhow::Result<bool> {
    let Some(jellyfin_id) = entity
        .text("jellyfinUserId")
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
    else {
        return Ok(false);
    };
    let server_type = settings
        .get("/main/mediaServerType")
        .and_then(Value::as_i64);
    let get = |key: &str| settings.get(&format!("/jellyfin/{key}"));
    let host = hostname_of(get("useSsl"), get("ip"), get("port"), get("urlBase"));
    let url = if server_type == Some(JELLYFIN) {
        format!("{host}/UserImage?UserId={jellyfin_id}")
    } else {
        format!("{host}/Users/{jellyfin_id}/Images/Primary?quality=90")
    };
    let head = match app.outbound.head(&url).send().await {
        Ok(res) if res.status().as_u16() == 200 => res,
        _ => return Ok(false),
    };
    let now = crate::clock::now_millis().to_string();
    let header = |name: &str| {
        head.headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };
    let remote = if server_type == Some(JELLYFIN) {
        header("last-modified")
            .and_then(|t| parse_http_date(&t))
            .filter(|ms| *ms != 0)
            .map_or(now, |ms| ms.to_string())
    } else if server_type == Some(EMBY) {
        header("etag")
            .map(|e| e.replace('"', ""))
            .filter(|e| !e.is_empty())
            .unwrap_or(now)
    } else {
        now
    };
    let current = entity.get("avatarVersion");
    if truthy(Some(current)) && current.as_str() == Some(remote.as_str()) {
        return Ok(false);
    }
    clear_cached_image(&app.env.config_dir, &url).await;
    let email = entity
        .text("email")
        .filter(|e| !e.is_empty())
        .unwrap_or("none");
    let fallback = crate::typeorm::gravatar_url(email);
    let image =
        match crate::imagecache::get_image(app, crate::imagecache::AVATAR, &url, Some(&fallback))
            .await
        {
            Ok(image) => image,
            Err(e) => {
                tracing::error!("Error checking avatar changes: {e:#}");
                return Ok(false);
            }
        };
    let hash = super::super::authcommon::hex(&Sha256::digest(&image.bytes));
    let changed = entity.text("avatarETag") != Some(hash.as_str());
    entity
        .columns
        .insert(String::from("avatarVersion"), Value::from(remote));
    if changed {
        entity
            .columns
            .insert(String::from("avatarETag"), Value::from(hash));
    }
    if let Err(e) = save(&app.db, entity).await {
        tracing::error!("Error checking avatar changes: {e:#}");
        return Ok(false);
    }
    Ok(changed)
}

/// `ImageProxy.clearCachedImage(path)` on the avatar cache: the image's
/// directory goes (what is held in memory stays, as in Node).
async fn clear_cached_image(config_dir: &std::path::Path, path: &str) {
    let key = crate::imagecache::cache_key(crate::imagecache::AVATAR.key, path);
    let directory = crate::imagecache::cache_root(config_dir)
        .join(crate::imagecache::AVATAR.key)
        .join(&key);
    match tokio::fs::remove_dir_all(&directory).await {
        Ok(()) => tracing::debug!("Cleared {key} from cache 'avatar'"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            tracing::debug!("Cache directory '{key}' does not exist; nothing to clear.");
        }
        Err(e) => tracing::error!("Failed to clear cached image: {e}"),
    }
}

/// `userRepository.save(user)`: the changed columns, `updatedAt` bumped
/// unless it was set, and reloaded after.
async fn save(db: &Db, entity: &mut Entity) -> anyhow::Result<()> {
    let Some(stored) = load(db, entity.id).await? else {
        return Ok(());
    };
    let mut changes = Changes::default();
    for column in SAVED {
        changes.assign(column, entity.columns.get(column), stored.get(column));
    }
    let touch_date = entity.updated_at != stored.updated_at;
    if !changes.any() && !touch_date {
        return Ok(());
    }
    let mut parts = Vec::new();
    let mut binds = Vec::new();
    for (column, value) in &changes.sets {
        parts.push(format!(
            "\"{column}\" = {}",
            crate::typeorm::sql_value(value, &mut binds)?
        ));
    }
    if touch_date {
        match entity
            .updated_at
            .as_str()
            .and_then(crate::clock::parse_date_millis)
        {
            Some(ms) => {
                binds.push(date_bind(db, ms));
                parts.push(format!("\"updatedAt\" = {}", date_param(db, binds.len())));
            }
            None => parts.push(String::from("\"updatedAt\" = NULL")),
        }
    } else {
        parts.push(String::from("\"updatedAt\" = CURRENT_TIMESTAMP"));
    }
    binds.push(Bind::Int(entity.id));
    let sql = format!(
        "UPDATE \"user\" SET {} WHERE \"id\" = ?{}",
        parts.join(", "),
        binds.len()
    );
    db.execute(&sql, &binds).await?;
    entity.updated_at = crate::typeorm::date_of(db, "user", "updatedAt", entity.id).await?;
    Ok(())
}

/// `Date.parse` of an HTTP date (`Sun, 06 Nov 1994 08:49:37 GMT`).
fn parse_http_date(text: &str) -> Option<i64> {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let rest = text.split_once(", ").map_or(text, |(_, r)| r);
    let mut parts = rest.split_whitespace();
    let day: i64 = parts.next()?.parse().ok()?;
    let month = parts.next()?;
    let month = MONTHS.iter().position(|m| m.eq_ignore_ascii_case(month))?;
    let year: i64 = parts.next()?.parse().ok()?;
    let time = parts.next()?;
    let zone = parts.next().unwrap_or("GMT");
    if !matches!(zone, "GMT" | "UTC" | "Z") {
        return None;
    }
    let iso = format!("{year:04}-{:02}-{day:02}T{time}Z", month.checked_add(1)?);
    crate::clock::parse_date_millis(&iso)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn http_dates() {
        assert_eq!(
            parse_http_date("Sun, 06 Nov 1994 08:49:37 GMT"),
            Some(784_111_777_000),
            "IMF-fixdate"
        );
        assert_eq!(parse_http_date("yesterday"), None, "other shapes");
    }

    #[test]
    fn overrides_lay_over_the_loaded_user() {
        let empty = Map::new();
        let mut entity = Entity {
            id: 1,
            columns: json!({"avatar": "a", "username": "u"})
                .as_object()
                .cloned()
                .unwrap_or_default(),
            updated_at: json!("2026-01-01T00:00:00.000Z"),
        };
        let overrides = json!({"avatar": "b", "updatedAt": "2025-01-01T00:00:00Z", "email": "x"});
        apply_overrides(&mut entity, overrides.as_object().unwrap_or(&empty));
        assert_eq!(entity.get("avatar"), &json!("b"), "avatar");
        assert_eq!(entity.get("username"), &json!("u"), "untouched");
        assert_eq!(
            entity.get("email"),
            &Value::Null,
            "only the handler's properties"
        );
        assert_eq!(
            entity.updated_at,
            json!("2025-01-01T00:00:00.000Z"),
            "a Date"
        );
    }
}
