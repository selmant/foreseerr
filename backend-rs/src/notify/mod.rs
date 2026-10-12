//! `server/lib/notifications`: the payload every agent formats, who gets
//! told, and the agents that tell them.
//!
//! As in Node, sending is fire and forget: [`send`] spawns the agents and
//! returns; their failures are logged.

pub mod agents;
pub mod email;
pub mod webpush;

use std::sync::Arc;

use serde_json::Value;

use crate::db::{MediaRow, UserRecord, UserSettingsRecord};
use crate::i18n::Intl;
use crate::settings::Settings;
use crate::state::AppState;

/// `Notification`: the event, by its bit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// `MEDIA_PENDING`.
    MediaPending,
    /// `MEDIA_APPROVED`.
    MediaApproved,
    /// `MEDIA_AVAILABLE`.
    MediaAvailable,
    /// `MEDIA_FAILED`.
    MediaFailed,
    /// `TEST_NOTIFICATION`.
    Test,
    /// `MEDIA_DECLINED`.
    MediaDeclined,
    /// `MEDIA_AUTO_APPROVED`.
    MediaAutoApproved,
    /// `ISSUE_CREATED`.
    IssueCreated,
    /// `ISSUE_COMMENT`.
    IssueComment,
    /// `ISSUE_RESOLVED`.
    IssueResolved,
    /// `ISSUE_REOPENED`.
    IssueReopened,
    /// `MEDIA_AUTO_REQUESTED`.
    MediaAutoRequested,
    /// `NEW_SEASON`.
    NewSeason,
    /// `RELEASE_DATE_CHANGED`.
    ReleaseDateChanged,
}

impl Kind {
    /// The bit.
    #[must_use]
    pub const fn bit(self) -> i64 {
        match self {
            Self::MediaPending => 2,
            Self::MediaApproved => 4,
            Self::MediaAvailable => 8,
            Self::MediaFailed => 16,
            Self::Test => 32,
            Self::MediaDeclined => 64,
            Self::MediaAutoApproved => 128,
            Self::IssueCreated => 256,
            Self::IssueComment => 512,
            Self::IssueResolved => 1024,
            Self::IssueReopened => 2048,
            Self::MediaAutoRequested => 4096,
            Self::NewSeason => 16384,
            Self::ReleaseDateChanged => 32768,
        }
    }

    /// `Notification[type]`.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::MediaPending => "MEDIA_PENDING",
            Self::MediaApproved => "MEDIA_APPROVED",
            Self::MediaAvailable => "MEDIA_AVAILABLE",
            Self::MediaFailed => "MEDIA_FAILED",
            Self::Test => "TEST_NOTIFICATION",
            Self::MediaDeclined => "MEDIA_DECLINED",
            Self::MediaAutoApproved => "MEDIA_AUTO_APPROVED",
            Self::IssueCreated => "ISSUE_CREATED",
            Self::IssueComment => "ISSUE_COMMENT",
            Self::IssueResolved => "ISSUE_RESOLVED",
            Self::IssueReopened => "ISSUE_REOPENED",
            Self::MediaAutoRequested => "MEDIA_AUTO_REQUESTED",
            Self::NewSeason => "NEW_SEASON",
            Self::ReleaseDateChanged => "RELEASE_DATE_CHANGED",
        }
    }

    /// `getAdminPermission`.
    const fn admin_permission(self) -> i64 {
        match self {
            Self::MediaPending
            | Self::MediaApproved
            | Self::MediaAvailable
            | Self::MediaFailed
            | Self::MediaDeclined
            | Self::MediaAutoApproved => MANAGE_REQUESTS,
            Self::IssueCreated | Self::IssueComment | Self::IssueResolved | Self::IssueReopened => {
                MANAGE_ISSUES
            }
            Self::Test | Self::MediaAutoRequested | Self::NewSeason | Self::ReleaseDateChanged => {
                ADMIN
            }
        }
    }
}

const ADMIN: i64 = 2;
const MANAGE_REQUESTS: i64 = 16;
const MANAGE_ISSUES: i64 = 1_048_576;

/// `hasNotificationType(type, mask)`: test notifications always pass.
#[must_use]
pub const fn has_type(kind: Kind, mask: i64) -> bool {
    let mask = if mask & Kind::Test.bit() == 0 {
        mask + Kind::Test.bit()
    } else {
        mask
    };
    mask & kind.bit() != 0
}

/// A user as the agents read one.
#[derive(Debug, Clone, Default)]
pub struct Person {
    /// `id`.
    pub id: i64,
    /// `displayName`.
    pub display_name: String,
    /// `email`, lower-cased.
    pub email: String,
    /// `avatar`.
    pub avatar: String,
    /// `permissions`.
    pub permissions: i64,
    /// `jellyfinUserId`.
    pub jellyfin_user_id: Option<String>,
    /// The settings row, when there is one.
    pub settings: Option<PersonSettings>,
}

/// The notification parts of a user's settings.
#[derive(Debug, Clone, Default)]
pub struct PersonSettings {
    /// `locale`.
    pub locale: String,
    /// `discordIds` after its transformer.
    pub discord_ids: Vec<String>,
    /// `telegramChatId`.
    pub telegram_chat_id: Option<String>,
    /// `telegramMessageThreadId`.
    pub telegram_thread_id: Option<String>,
    /// `telegramSendSilently`.
    pub telegram_silent: Option<bool>,
    /// `pushbulletAccessToken`.
    pub pushbullet_token: Option<String>,
    /// `pushoverApplicationToken`.
    pub pushover_app: Option<String>,
    /// `pushoverUserKey`.
    pub pushover_key: Option<String>,
    /// `pushoverSound`.
    pub pushover_sound: Option<String>,
    /// `pgpKey`.
    pub pgp_key: Option<String>,
    /// `notificationTypes` after its transformer: agent name to mask.
    pub types: Value,
}

impl Person {
    /// From a loaded user and settings row.
    #[must_use]
    pub fn from_records(user: &UserRecord, settings: Option<&UserSettingsRecord>) -> Self {
        let email = user.email.as_deref().unwrap_or("").to_lowercase();
        let display_name = [&user.username, &user.plex_username, &user.jellyfin_username]
            .into_iter()
            .find_map(|v| v.as_deref().filter(|s| !s.is_empty()))
            .map_or_else(|| email.clone(), str::to_owned);
        Self {
            id: user.id,
            display_name,
            email,
            avatar: user.avatar.clone(),
            permissions: user.permissions,
            jellyfin_user_id: user.jellyfin_user_id.clone(),
            settings: settings.map(|s| PersonSettings {
                locale: s.public.locale.clone(),
                discord_ids: crate::user::discord_ids(s.discord_ids.as_deref())
                    .as_array()
                    .map(|ids| {
                        ids.iter()
                            .map(|v| crate::media::js_string(Some(v)).into_owned())
                            .collect()
                    })
                    .unwrap_or_default(),
                telegram_chat_id: s.telegram_chat_id.clone(),
                telegram_thread_id: s.telegram_message_thread_id.clone(),
                telegram_silent: s.telegram_send_silently,
                pushbullet_token: s.pushbullet_access_token.clone(),
                pushover_app: s.pushover_application_token.clone(),
                pushover_key: s.pushover_user_key.clone(),
                pushover_sound: s.pushover_sound.clone(),
                pgp_key: s.pgp_key.clone(),
                types: crate::user::notification_types(s.public.notification_types.as_deref())
                    .unwrap_or(Value::Null),
            }),
        }
    }

    /// `user.settings?.hasNotificationType(agent, type)`: `None` without
    /// a settings row.
    #[must_use]
    pub fn wants(&self, agent: &str, kind: Kind) -> Option<bool> {
        self.settings.as_ref().map(|s| {
            has_type(
                kind,
                s.types.get(agent).and_then(Value::as_i64).unwrap_or(0),
            )
        })
    }

    /// `hasPermission(permission)`: admins have every permission.
    #[must_use]
    pub const fn has_permission(&self, permission: i64) -> bool {
        permission == 0 || self.permissions & ADMIN != 0 || self.permissions & permission != 0
    }

    /// The user's locale, if set.
    #[must_use]
    pub fn locale(&self) -> Option<&str> {
        self.settings
            .as_ref()
            .map(|s| s.locale.as_str())
            .filter(|l| !l.is_empty())
    }
}

/// The request a notification is about.
#[derive(Debug, Clone, Default)]
pub struct RequestInfo {
    /// `id`.
    pub id: i64,
    /// `is4k`.
    pub is4k: bool,
    /// `requestedBy`.
    pub requested_by: Person,
    /// `modifiedBy`.
    pub modified_by: Option<Person>,
}

/// The issue a notification is about.
#[derive(Debug, Clone, Default)]
pub struct IssueInfo {
    /// `id`.
    pub id: i64,
    /// `issueType`.
    pub issue_type: i64,
    /// `status`.
    pub status: i64,
    /// `createdBy`.
    pub created_by: Person,
    /// `modifiedBy`.
    pub modified_by: Option<Person>,
}

/// The comment a notification is about.
#[derive(Debug, Clone, Default)]
pub struct CommentInfo {
    /// `message`.
    pub message: String,
    /// `user`.
    pub user: Person,
}

/// `NotificationPayload`.
#[derive(Debug, Clone, Default)]
pub struct Payload {
    /// `event`.
    pub event: Option<String>,
    /// `subject`.
    pub subject: String,
    /// `message`.
    pub message: Option<String>,
    /// `image`.
    pub image: Option<String>,
    /// `notifySystem`.
    pub notify_system: bool,
    /// `notifyAdmin`.
    pub notify_admin: bool,
    /// `notifyUser`.
    pub notify_user: Option<Person>,
    /// `media`.
    pub media: Option<MediaRow>,
    /// `request`.
    pub request: Option<RequestInfo>,
    /// `issue`.
    pub issue: Option<IssueInfo>,
    /// `comment`.
    pub comment: Option<CommentInfo>,
    /// `extra`: name and value pairs.
    pub extra: Vec<(String, String)>,
    /// `pendingRequestsCount`.
    pub pending_requests_count: Option<i64>,
    /// `isAdmin`.
    pub is_admin: Option<bool>,
    /// `watchUrl`.
    pub watch_url: Option<String>,
}

impl Payload {
    /// `shouldSendAdminNotification`.
    #[must_use]
    pub fn admin_should_get(&self, kind: Kind, user: &Person) -> bool {
        let notify_user = self.notify_user.as_ref().map(|u| u.id);
        user.id != notify_user.unwrap_or(i64::MIN)
            && user.has_permission(kind.admin_permission())
            && (kind != Kind::MediaAutoApproved
                || Some(user.id)
                    != self
                        .request
                        .as_ref()
                        .map(|r| r.modified_by.as_ref().map_or(r.requested_by.id, |m| m.id)))
            && (kind != Kind::IssueCreated
                || Some(user.id) != self.issue.as_ref().map(|i| i.created_by.id))
            && (kind != Kind::IssueComment
                || Some(user.id) != self.comment.as_ref().map(|c| c.user.id))
            && (!matches!(kind, Kind::IssueResolved | Kind::IssueReopened)
                || Some(user.id)
                    != self
                        .issue
                        .as_ref()
                        .and_then(|i| i.modified_by.as_ref().map(|m| m.id)))
    }

    /// The link most agents attach: the watch URL, else the issue or media
    /// page when `applicationUrl` is set.
    #[must_use]
    pub fn link(&self, application_url: &str) -> Option<String> {
        if let Some(url) = &self.watch_url {
            return Some(url.clone());
        }
        if application_url.is_empty() {
            return None;
        }
        if let Some(issue) = &self.issue {
            return Some(format!("{application_url}/issues/{}", issue.id));
        }
        self.media
            .as_ref()
            .map(|m| format!("{application_url}/{}/{}", m.media_type, m.tmdb_id))
    }
}

/// `IssueTypeName`.
#[must_use]
pub const fn issue_type_name(issue_type: i64) -> &'static str {
    match issue_type {
        1 => "Video",
        2 => "Audio",
        3 => "Subtitle",
        4 => "Other",
        _ => "undefined",
    }
}

/// `requestNotificationStatus`.
#[must_use]
pub fn request_status(kind: Kind, payload: &Payload, intl: &Intl) -> Option<String> {
    let common = |key: &str| intl.format(&format!("notifications.common.{key}"), &[]);
    match kind {
        Kind::MediaAutoRequested => {
            Some(if payload.media.as_ref().is_some_and(|m| m.status == 2) {
                common("pendingApproval")
            } else {
                common("processing")
            })
        }
        Kind::MediaPending => Some(common("pendingApproval")),
        Kind::MediaApproved | Kind::MediaAutoApproved => Some(common("processing")),
        Kind::MediaAvailable => Some(common("available")),
        Kind::MediaDeclined => Some(common("declined")),
        Kind::MediaFailed => Some(common("failed")),
        Kind::Test
        | Kind::IssueCreated
        | Kind::IssueComment
        | Kind::IssueResolved
        | Kind::IssueReopened
        | Kind::NewSeason
        | Kind::ReleaseDateChanged => None,
    }
}

/// Everything an agent needs while it runs.
#[derive(Debug, Clone)]
pub struct Env {
    /// Shared state: database and HTTP clients.
    pub state: Arc<AppState>,
    /// settings.json when the notification was sent.
    pub settings: Arc<Settings>,
}

impl Env {
    /// `getIntl(locale)`.
    #[must_use]
    pub fn intl(&self, locale: Option<&str>) -> Intl {
        Intl::new(locale, self.settings.str("/main/locale"))
    }

    /// One agent's settings section.
    #[must_use]
    pub fn agent(&self, name: &str) -> Value {
        self.settings
            .get(&format!("/notifications/agents/{name}"))
            .cloned()
            .unwrap_or(Value::Null)
    }

    /// Every user with their settings, as `userRepository.find()` loads them.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn users(&self) -> anyhow::Result<Vec<Person>> {
        Ok(self
            .state
            .db
            .all_users_with_settings()
            .await?
            .iter()
            .map(|(u, s)| Person::from_records(u, s.as_ref()))
            .collect())
    }
}

/// `notificationManager.sendNotification`: every agent that should send
/// gets the payload, in the background.
pub fn send(state: Arc<AppState>, settings: Arc<Settings>, kind: Kind, payload: Payload) {
    tracing::info!(
        "Sending notification(s) for {}: {}",
        kind.name(),
        payload.subject
    );
    let env = Env { state, settings };
    let payload = Arc::new(payload);
    for agent in agents::ALL {
        let (env, payload) = (env.clone(), Arc::clone(&payload));
        tokio::spawn(async move {
            if let Err(e) = agent(env, kind, payload).await {
                tracing::error!("notification agent failed: {e:#}");
            }
        });
    }
}
