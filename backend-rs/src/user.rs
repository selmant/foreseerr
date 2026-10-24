//! `User.toPublicJSON` from `server/entity/User.ts`, including the column
//! transformers `TypeORM` applies while loading.

use serde_json::{Map, Value};

use crate::db::{UserProfile, UserSettingsRow};

/// `ALL_NOTIFICATIONS`: every `Notification` bit set.
const ALL_NOTIFICATIONS: i64 = 57342;

/// `DiscoverFilterDefaultsSchema`, in schema order: booleans, then strings.
const FILTER_BOOLEAN_KEYS: [&str; 5] = [
    "ignoreWatched",
    "ignoreCollected",
    "ignoreWatchlisted",
    "hideUnmapped",
    "includeNoRating",
];
const FILTER_STRING_KEYS: [&str; 22] = [
    "language",
    "primaryReleaseDateGte",
    "primaryReleaseDateLte",
    "firstAirDateGte",
    "firstAirDateLte",
    "genre",
    "voteAverageGte",
    "voteAverageLte",
    "voteCountGte",
    "voteCountLte",
    "imdbRatingGte",
    "imdbRatingLte",
    "imdbVotesGte",
    "imdbVotesLte",
    "rtCriticsGte",
    "rtCriticsLte",
    "rtAudienceGte",
    "rtAudienceLte",
    "metacriticGte",
    "metacriticLte",
    "traktRatingGte",
    "traktRatingLte",
];

/// The JSON `/auth/me` sends, or why Node would fail to build it.
///
/// # Errors
///
/// Returns the reason when a stored value would make Node throw.
pub fn public_json(user: &UserProfile) -> Result<Value, &'static str> {
    let text = |v: &Option<String>| v.as_deref().map_or(Value::Null, Value::from);
    let mut out = Map::new();
    out.insert(String::from("id"), Value::from(user.id));
    // The email column transformer: `(value ?? '').toLowerCase()`.
    let email = user.email.as_deref().unwrap_or("").to_lowercase();
    out.insert(String::from("email"), Value::from(email.as_str()));
    out.insert(String::from("username"), text(&user.username));
    out.insert(String::from("plexUsername"), text(&user.plex_username));
    out.insert(
        String::from("jellyfinUsername"),
        text(&user.jellyfin_username),
    );
    // `@AfterLoad`: username || plexUsername || jellyfinUsername || email.
    let display_name = [&user.username, &user.plex_username, &user.jellyfin_username]
        .into_iter()
        .find_map(|v| v.as_deref().filter(|s| !s.is_empty()))
        .map_or_else(|| email.clone(), str::to_owned);
    out.insert(String::from("displayName"), Value::from(display_name));
    out.insert(String::from("avatar"), Value::from(user.avatar.as_str()));
    out.insert(String::from("permissions"), Value::from(user.permissions));
    out.insert(String::from("userType"), Value::from(user.user_type));
    out.insert(String::from("createdAt"), text(&user.created_at));
    out.insert(String::from("updatedAt"), text(&user.updated_at));
    out.insert(
        String::from("requestCount"),
        Value::from(user.request_count),
    );
    out.insert(String::from("warnings"), Value::Array(Vec::new()));
    out.insert(
        String::from("plexId"),
        user.plex_id.map_or(Value::Null, Value::from),
    );
    if let Some(settings) = &user.settings {
        out.insert(String::from("settings"), settings_json(settings)?);
    }
    Ok(Value::Object(out))
}

fn settings_json(s: &UserSettingsRow) -> Result<Value, &'static str> {
    let text = |v: &Option<String>| v.as_deref().map_or(Value::Null, Value::from);
    let flag = |v: Option<bool>| v.map_or(Value::Null, Value::Bool);
    let number = |v: Option<i64>| v.map_or(Value::Null, Value::from);
    let mut out = Map::new();
    out.insert(String::from("locale"), Value::from(s.locale.as_str()));
    out.insert(String::from("discoverRegion"), text(&s.discover_region));
    out.insert(String::from("streamingRegion"), text(&s.streaming_region));
    out.insert(String::from("originalLanguage"), text(&s.original_language));
    out.insert(
        String::from("notificationTypes"),
        notification_types(s.notification_types.as_deref())?,
    );
    out.insert(
        String::from("watchlistSyncMovies"),
        flag(s.watchlist_sync_movies),
    );
    out.insert(String::from("watchlistSyncTv"), flag(s.watchlist_sync_tv));
    out.insert(
        String::from("autoCompleteSkippedEpisodeEndings"),
        flag(s.auto_complete_skipped_episode_endings),
    );
    out.insert(
        String::from("autoCompleteSkippedEpisodeThreshold"),
        number(s.auto_complete_skipped_episode_threshold),
    );
    out.insert(
        String::from("watchAheadEpisodeCount"),
        number(s.watch_ahead_episode_count),
    );
    out.insert(
        String::from("servarrInterventionsSeenAt"),
        text(&s.servarr_interventions_seen_at),
    );
    out.insert(
        String::from("discoverFilterDefaults"),
        discover_filter_defaults(s.discover_filter_defaults.as_deref()),
    );
    Ok(Value::Object(out))
}

/// The `notificationTypes` column transformer: defaults when empty or not
/// an object, otherwise the stored object with `email` and `webpush`
/// filled in when missing.
///
/// # Errors
///
/// Returns the reason when the stored text would make Node throw.
pub fn notification_types(stored: Option<&str>) -> Result<Value, &'static str> {
    let defaults = || {
        let mut m = Map::new();
        for (key, value) in [
            ("email", ALL_NOTIFICATIONS),
            ("discord", 0),
            ("pushbullet", 0),
            ("pushover", 0),
            ("slack", 0),
            ("telegram", 0),
            ("webhook", 0),
            ("webpush", ALL_NOTIFICATIONS),
        ] {
            m.insert(String::from(key), Value::from(value));
        }
        Value::Object(m)
    };
    let Some(text) = stored.filter(|t| !t.is_empty()) else {
        return Ok(defaults());
    };
    let parsed: Value =
        serde_json::from_str(text).map_err(|_| "user_settings.notificationTypes is not JSON")?;
    match parsed {
        // `typeof null === 'object'`, then `null.email` throws.
        Value::Null => Err("user_settings.notificationTypes is null"),
        Value::Object(mut m) => {
            for key in ["email", "webpush"] {
                if matches!(m.get(key), None | Some(Value::Null)) {
                    m.insert(String::from(key), Value::from(ALL_NOTIFICATIONS));
                }
            }
            Ok(Value::Object(m))
        }
        // Arrays are objects to `typeof`; the two keys are added to them.
        Value::Array(_) => Err("user_settings.notificationTypes is an array"),
        Value::Bool(_) | Value::Number(_) | Value::String(_) => Ok(defaults()),
    }
}

/// The `discoverFilterDefaults` column transformer: a strict zod parse that
/// yields `{}` for anything invalid, with keys in schema order.
#[must_use]
pub fn discover_filter_defaults(stored: Option<&str>) -> Value {
    let Some(text) = stored.filter(|t| !t.is_empty()) else {
        return Value::Object(Map::new());
    };
    let Ok(parsed) = serde_json::from_str::<Value>(text) else {
        return Value::Object(Map::new());
    };
    let Value::Object(input) = parsed else {
        // `null` becomes `{}` through `input ?? {}`; other scalars fail.
        return Value::Object(Map::new());
    };
    let mut out = Map::new();
    for key in FILTER_BOOLEAN_KEYS {
        match input.get(key) {
            None => {}
            Some(Value::Bool(b)) => {
                out.insert(String::from(key), Value::Bool(*b));
            }
            Some(_) => return Value::Object(Map::new()),
        }
    }
    for key in FILTER_STRING_KEYS {
        match input.get(key) {
            None => {}
            Some(Value::String(s)) if !s.is_empty() => {
                out.insert(String::from(key), Value::from(s.as_str()));
            }
            Some(_) => return Value::Object(Map::new()),
        }
    }
    let known = |k: &String| {
        FILTER_BOOLEAN_KEYS.contains(&k.as_str()) || FILTER_STRING_KEYS.contains(&k.as_str())
    };
    if !input.keys().all(known) {
        return Value::Object(Map::new());
    }
    Value::Object(out)
}

/// `User.filter(showFiltered)`: the entity's keys in Node's order.
///
/// The sensitive fields are left out unless `show_filtered`. The settings
/// relation is only present when it was loaded (`settings` is `Some`), and
/// only kept when `show_filtered`.
///
/// # Errors
///
/// Returns the reason when a stored value would make Node throw.
pub fn filtered_json(
    user: &crate::db::UserRecord,
    settings: Option<Option<&crate::db::UserSettingsRecord>>,
    show_filtered: bool,
) -> Result<Value, &'static str> {
    let text = |v: &Option<String>| v.as_deref().map_or(Value::Null, Value::from);
    let number = |v: Option<i64>| v.map_or(Value::Null, Value::from);
    let email = user.email.as_deref().unwrap_or("").to_lowercase();
    let display_name = [&user.username, &user.plex_username, &user.jellyfin_username]
        .into_iter()
        .find_map(|v| v.as_deref().filter(|s| !s.is_empty()))
        .map_or_else(|| email.clone(), str::to_owned);
    let mut out = Map::new();
    out.insert(String::from("displayName"), Value::from(display_name));
    out.insert(String::from("warnings"), Value::Array(Vec::new()));
    out.insert(String::from("permissions"), Value::from(user.permissions));
    out.insert(String::from("id"), Value::from(user.id));
    if show_filtered {
        out.insert(String::from("email"), Value::from(email.as_str()));
    }
    out.insert(String::from("plexUsername"), text(&user.plex_username));
    out.insert(
        String::from("jellyfinUsername"),
        text(&user.jellyfin_username),
    );
    out.insert(String::from("username"), text(&user.username));
    out.insert(
        String::from("recoveryLinkExpirationDate"),
        text(&user.recovery_link_expiration_date),
    );
    out.insert(String::from("userType"), Value::from(user.user_type));
    if show_filtered {
        out.insert(String::from("plexId"), number(user.plex_id));
    }
    out.insert(String::from("jellyfinUserId"), text(&user.jellyfin_user_id));
    out.insert(String::from("avatar"), Value::from(user.avatar.as_str()));
    out.insert(String::from("avatarETag"), text(&user.avatar_etag));
    out.insert(String::from("avatarVersion"), text(&user.avatar_version));
    out.insert(
        String::from("movieQuotaLimit"),
        number(user.movie_quota_limit),
    );
    out.insert(
        String::from("movieQuotaDays"),
        number(user.movie_quota_days),
    );
    out.insert(String::from("tvQuotaLimit"), number(user.tv_quota_limit));
    out.insert(String::from("tvQuotaDays"), number(user.tv_quota_days));
    out.insert(String::from("createdAt"), text(&user.created_at));
    out.insert(String::from("updatedAt"), text(&user.updated_at));
    if show_filtered {
        if let Some(loaded) = settings {
            out.insert(
                String::from("settings"),
                loaded.map_or(Ok(Value::Null), settings_record_json)?,
            );
        }
    }
    out.insert(
        String::from("requestCount"),
        Value::from(user.request_count),
    );
    Ok(Value::Object(out))
}

/// The `UserSettings` entity as loaded, in column order.
fn settings_record_json(s: &crate::db::UserSettingsRecord) -> Result<Value, &'static str> {
    let text = |v: &Option<String>| v.as_deref().map_or(Value::Null, Value::from);
    let flag = |v: Option<bool>| v.map_or(Value::Null, Value::Bool);
    let number = |v: Option<i64>| v.map_or(Value::Null, Value::from);
    let p = &s.public;
    let mut out = Map::new();
    out.insert(String::from("id"), Value::from(s.id));
    out.insert(String::from("locale"), Value::from(p.locale.as_str()));
    out.insert(String::from("discoverRegion"), text(&p.discover_region));
    out.insert(String::from("streamingRegion"), text(&p.streaming_region));
    out.insert(String::from("originalLanguage"), text(&p.original_language));
    out.insert(String::from("pgpKey"), text(&s.pgp_key));
    out.insert(
        String::from("discordIds"),
        discord_ids(s.discord_ids.as_deref()),
    );
    out.insert(
        String::from("pushbulletAccessToken"),
        text(&s.pushbullet_access_token),
    );
    out.insert(
        String::from("pushoverApplicationToken"),
        text(&s.pushover_application_token),
    );
    out.insert(String::from("pushoverUserKey"), text(&s.pushover_user_key));
    out.insert(String::from("pushoverSound"), text(&s.pushover_sound));
    out.insert(String::from("telegramChatId"), text(&s.telegram_chat_id));
    out.insert(
        String::from("telegramMessageThreadId"),
        text(&s.telegram_message_thread_id),
    );
    out.insert(
        String::from("telegramSendSilently"),
        flag(s.telegram_send_silently),
    );
    out.insert(
        String::from("watchlistSyncMovies"),
        flag(p.watchlist_sync_movies),
    );
    out.insert(String::from("watchlistSyncTv"), flag(p.watchlist_sync_tv));
    out.insert(
        String::from("autoCompleteSkippedEpisodeEndings"),
        flag(p.auto_complete_skipped_episode_endings),
    );
    out.insert(
        String::from("autoCompleteSkippedEpisodeThreshold"),
        number(p.auto_complete_skipped_episode_threshold),
    );
    out.insert(
        String::from("watchAheadEpisodeCount"),
        number(p.watch_ahead_episode_count),
    );
    out.insert(
        String::from("servarrInterventionsSeenAt"),
        text(&p.servarr_interventions_seen_at),
    );
    out.insert(String::from("traktUsername"), text(&s.trakt_username));
    out.insert(String::from("traktUserId"), text(&s.trakt_user_id));
    out.insert(String::from("anilistUsername"), text(&s.anilist_username));
    out.insert(String::from("anilistUserId"), text(&s.anilist_user_id));
    out.insert(String::from("simklUsername"), text(&s.simkl_username));
    out.insert(String::from("simklUserId"), text(&s.simkl_user_id));
    out.insert(
        String::from("mediaActionsTraktEnabled"),
        flag(s.media_actions_trakt_enabled),
    );
    out.insert(
        String::from("mediaActionsAnilistEnabled"),
        flag(s.media_actions_anilist_enabled),
    );
    out.insert(
        String::from("mediaActionsSimklEnabled"),
        flag(s.media_actions_simkl_enabled),
    );
    out.insert(
        String::from("discoverFilterDefaults"),
        discover_filter_defaults(p.discover_filter_defaults.as_deref()),
    );
    out.insert(
        String::from("notificationTypes"),
        notification_types(p.notification_types.as_deref())?,
    );
    Ok(Value::Object(out))
}

/// The `discordIds` transformer: whatever JSON is stored, `[]` when empty
/// or unparseable.
#[must_use]
pub fn discord_ids(stored: Option<&str>) -> Value {
    stored
        .filter(|t| !t.is_empty())
        .and_then(|t| serde_json::from_str(t).ok())
        .unwrap_or_else(|| Value::Array(Vec::new()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn notification_defaults() {
        assert_eq!(
            notification_types(None).unwrap_or_default(),
            json!({"email":57342,"discord":0,"pushbullet":0,"pushover":0,"slack":0,"telegram":0,"webhook":0,"webpush":57342}),
            "null column"
        );
        assert_eq!(
            notification_types(Some(r#"{"discord":4,"webpush":0}"#)).unwrap_or_default(),
            json!({"discord":4,"webpush":0,"email":57342}),
            "stored keys first, missing email appended"
        );
        assert_eq!(
            notification_types(Some("2"))
                .unwrap_or_default()
                .get("email"),
            Some(&json!(57342)),
            "a bare number means defaults"
        );
        assert!(notification_types(Some("null")).is_err(), "null throws");
        assert!(notification_types(Some("{")).is_err(), "bad JSON throws");
    }

    #[test]
    fn filter_defaults() {
        assert_eq!(discover_filter_defaults(None), json!({}), "null column");
        assert_eq!(
            discover_filter_defaults(Some(r#"{"genre":"28","ignoreWatched":true}"#)),
            json!({"ignoreWatched":true,"genre":"28"}),
            "schema order"
        );
        assert_eq!(
            discover_filter_defaults(Some(r#"{"genre":""}"#)),
            json!({}),
            "empty string fails"
        );
        assert_eq!(
            discover_filter_defaults(Some(r#"{"unknown":1}"#)),
            json!({}),
            "strict"
        );
        assert_eq!(
            discover_filter_defaults(Some(r#"{"ignoreWatched":"yes"}"#)),
            json!({}),
            "wrong type"
        );
        assert_eq!(
            discover_filter_defaults(Some("null")),
            json!({}),
            "null input"
        );
        assert_eq!(
            discover_filter_defaults(Some("[1]")),
            json!({}),
            "array fails"
        );
    }

    #[test]
    fn profile_shape() {
        let user = UserProfile {
            id: 1,
            email: Some(String::from("Admin@Seerr.dev")),
            username: Some(String::from("admin")),
            plex_username: Some(String::from("admin")),
            avatar: String::from("a"),
            permissions: 2,
            user_type: 1,
            created_at: Some(String::from("2026-08-20T12:08:46.000Z")),
            updated_at: Some(String::from("2026-08-20T12:08:46.000Z")),
            plex_id: Some(1),
            ..UserProfile::default()
        };
        let json = public_json(&user).unwrap_or_default();
        assert_eq!(
            serde_json::to_string(&json).unwrap_or_default(),
            r#"{"id":1,"email":"admin@seerr.dev","username":"admin","plexUsername":"admin","jellyfinUsername":null,"displayName":"admin","avatar":"a","permissions":2,"userType":1,"createdAt":"2026-08-20T12:08:46.000Z","updatedAt":"2026-08-20T12:08:46.000Z","requestCount":0,"warnings":[],"plexId":1}"#,
            "matches a recorded /auth/me body"
        );
    }

    #[test]
    fn sqlite_dates() {
        use crate::db::sqlite_datetime_to_iso as iso;
        assert_eq!(
            iso("2026-08-20 12:08:46").as_deref(),
            Some("2026-08-20T12:08:46.000Z"),
            "seconds"
        );
        assert_eq!(
            iso("2026-10-10 20:50:32.775").as_deref(),
            Some("2026-10-10T20:50:32.775Z"),
            "millis"
        );
        assert_eq!(
            iso("2026-10-10 20:50").as_deref(),
            Some("2026-10-10T20:50:00.000Z"),
            "minutes"
        );
        assert_eq!(
            iso("2026-10-10 20:50:32.5"),
            None,
            "one fraction digit is local time in Node"
        );
        assert_eq!(
            iso("2026-10-10T20:50:32.775Z"),
            None,
            "a zone suffix is not what TypeORM writes"
        );
        assert_eq!(iso("yesterday"), None, "garbage");
    }
}
