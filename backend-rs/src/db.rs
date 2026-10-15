//! The database Node created, on `SQLite` or Postgres.
//!
//! Connection settings come from the same variables as Node's
//! `server/datasource.ts`: `DB_TYPE=postgres` plus `DB_HOST`, `DB_PORT`,
//! `DB_USER`, `DB_PASS`, `DB_NAME`, `DB_SOCKET_PATH`, `DB_USE_SSL` and
//! `DB_SSL_*`; otherwise `<config>/db/db.sqlite3`.
//!
//! Schema and migrations still belong to Node. Tables and columns are
//! `TypeORM`'s names, quoted, so the same SQL text works on both databases
//! apart from parameter placeholders.

use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgSslMode};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions};
use sqlx::{AssertSqlSafe, Row};

/// A pool for whichever database is configured.
#[derive(Debug, Clone)]
pub enum Db {
    /// `<config>/db/db.sqlite3`.
    Sqlite(SqlitePool),
    /// `DB_TYPE=postgres`.
    Postgres(PgPool),
}

/// What auth needs to know about a user.
#[derive(Debug, Clone)]
pub struct UserRow {
    /// User id.
    pub id: i64,
    /// `user.permissions`.
    pub permissions: i64,
    /// Whether a `user_settings` row exists.
    pub has_settings: bool,
    /// `user_settings.locale`, when a row exists.
    pub locale: Option<String>,
    /// `user_settings.notificationTypes` as stored (JSON text).
    pub notification_types: Option<String>,
}

impl Db {
    /// Open the pool for whichever database the environment names, like
    /// Node does. Connections are made on first use, so this works while
    /// Node is still creating the database on a fresh install.
    ///
    /// # Errors
    ///
    /// Fails when the Postgres settings can't be read.
    pub fn open(config_dir: &Path) -> Result<Self> {
        if std::env::var("DB_TYPE").is_ok_and(|t| t == "postgres") {
            let pool = PgPoolOptions::new()
                .max_connections(env_u32("DB_POOL_SIZE", 10))
                .acquire_timeout(Duration::from_millis(u64::from(env_u32(
                    "DB_CONNECT_TIMEOUT_MS",
                    30_000,
                ))))
                .connect_lazy_with(postgres_options()?);
            return Ok(Self::Postgres(pool));
        }
        let path = config_dir.join("db/db.sqlite3");
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(false)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_lazy_with(options);
        Ok(Self::Sqlite(pool))
    }

    /// The user id stored in a live session, if any.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn session_user_id(&self, sid: &str, now_ms: i64) -> Result<Option<SessionData>> {
        let json: Option<String> = match self {
            Self::Sqlite(p) => sqlx::query_scalar(
                r#"SELECT "json" FROM "session" WHERE "id" = ?1 AND "expiredAt" > ?2 AND "destroyedAt" IS NULL"#,
            )
            .bind(sid)
            .bind(now_ms)
            .fetch_optional(p)
            .await?,
            Self::Postgres(p) => sqlx::query_scalar(
                r#"SELECT "json" FROM "session" WHERE "id" = $1 AND "expiredAt" > $2 AND "destroyedAt" IS NULL"#,
            )
            .bind(sid)
            .bind(now_ms)
            .fetch_optional(p)
            .await?,
        };
        Ok(json.map(|j| SessionData::parse(&j)))
    }

    /// Push a session's expiry forward, as express-session does on every
    /// request that carries it.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn touch_session(&self, sid: &str, expired_at_ms: i64) -> Result<()> {
        match self {
            Self::Sqlite(p) => {
                sqlx::query(r#"UPDATE "session" SET "expiredAt" = ?1 WHERE "id" IN (?2)"#)
                    .bind(expired_at_ms)
                    .bind(sid)
                    .execute(p)
                    .await?;
            }
            Self::Postgres(p) => {
                sqlx::query(r#"UPDATE "session" SET "expiredAt" = $1 WHERE "id" IN ($2)"#)
                    .bind(expired_at_ms)
                    .bind(sid)
                    .execute(p)
                    .await?;
            }
        }
        Ok(())
    }

    /// A user and their notification settings.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn user(&self, id: i64) -> Result<Option<UserRow>> {
        const SQL_SQLITE: &str = r#"SELECT u."id" AS "id", u."permissions" AS "permissions", s."id" AS "settingsId", s."locale" AS "locale", s."notificationTypes" AS "notificationTypes"
            FROM "user" u LEFT JOIN "user_settings" s ON s."userId" = u."id" WHERE u."id" = ?1"#;
        const SQL_PG: &str = r#"SELECT u."id"::bigint AS "id", u."permissions"::bigint AS "permissions", s."id"::bigint AS "settingsId", s."locale" AS "locale", s."notificationTypes" AS "notificationTypes"
            FROM "user" u LEFT JOIN "user_settings" s ON s."userId" = u."id" WHERE u."id" = $1"#;
        let row = match self {
            Self::Sqlite(p) => sqlx::query(SQL_SQLITE)
                .bind(id)
                .fetch_optional(p)
                .await?
                .map(|r| -> Result<UserRow> {
                    Ok(UserRow {
                        id: r.try_get("id")?,
                        permissions: permissions_of(r.try_get("permissions")?),
                        has_settings: r.try_get::<Option<i64>, _>("settingsId")?.is_some(),
                        locale: r.try_get("locale")?,
                        notification_types: r.try_get("notificationTypes")?,
                    })
                })
                .transpose()?,
            Self::Postgres(p) => sqlx::query(SQL_PG)
                .bind(id)
                .fetch_optional(p)
                .await?
                .map(|r| -> Result<UserRow> {
                    Ok(UserRow {
                        id: r.try_get("id")?,
                        permissions: permissions_of(r.try_get("permissions")?),
                        has_settings: r.try_get::<Option<i64>, _>("settingsId")?.is_some(),
                        locale: r.try_get("locale")?,
                        notification_types: r.try_get("notificationTypes")?,
                    })
                })
                .transpose()?,
        };
        Ok(row)
    }

    /// Every `discover_slider` row, ordered as `find({ order: { order: 'ASC' } })`.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn discover_sliders(&self) -> Result<Vec<DiscoverSliderRow>> {
        const SQL_SQLITE: &str = r#"SELECT "id", "type", "order", "isBuiltIn", "enabled", "title", "data", "sort", "createdAt", "updatedAt" FROM "discover_slider" ORDER BY "order" ASC"#;
        const SQL_PG: &str = r#"SELECT "id"::bigint AS "id", "type"::bigint AS "type", "order"::bigint AS "order", "isBuiltIn", "enabled", "title", "data", "sort",
            to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
            to_char("updatedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"
            FROM "discover_slider" ORDER BY "order" ASC"#;
        let rows = match self {
            Self::Sqlite(p) => sqlx::query(SQL_SQLITE)
                .fetch_all(p)
                .await?
                .iter()
                .map(|r| slider_from_row(r, true))
                .collect::<Result<Vec<_>>>()?,
            Self::Postgres(p) => sqlx::query(SQL_PG)
                .fetch_all(p)
                .await?
                .iter()
                .map(|r| slider_from_row(r, false))
                .collect::<Result<Vec<_>>>()?,
        };
        Ok(rows)
    }

    /// How many `user_settings` rows have the given account linked.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn count_user_settings(&self, which: LinkedAccounts) -> Result<i64> {
        let sql = format!(
            r#"SELECT COUNT(*) FROM "user_settings" WHERE {}"#,
            which.condition()
        );
        // COUNT(*) is an int8 on Postgres already.
        self.scalar(&sql, &[]).await
    }

    /// `getQuota`'s movie count: non-declined movie requests by the user
    /// that count towards the quota, within the window when there is one.
    /// `TypeORM` writes the window as `BETWEEN` two `UTC` strings on `SQLite`.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn movie_quota_used(&self, user_id: i64, window: Option<QuotaWindow>) -> Result<i64> {
        let (sql, bounds) = match self {
            Self::Sqlite(_) => (
                format!(
                    r#"SELECT COUNT(*) FROM "media_request" r WHERE r."requestedById" = ?1 AND r."type" = 'movie' AND r."status" != 3 AND r."ignoreQuota" = 0{}"#,
                    if window.is_some() {
                        r#" AND r."createdAt" BETWEEN ?2 AND ?3"#
                    } else {
                        ""
                    }
                ),
                window.map(|w| {
                    (
                        w.start.typeorm_string(),
                        w.start.plus_years(100).typeorm_string(),
                    )
                }),
            ),
            Self::Postgres(_) => (
                format!(
                    r#"SELECT COUNT(*)::bigint FROM "media_request" r WHERE r."requestedById" = $1 AND r."type" = 'movie' AND r."status" != 3 AND r."ignoreQuota" = false{}"#,
                    if window.is_some() {
                        r#" AND r."createdAt" BETWEEN $2::timestamptz AND $3::timestamptz"#
                    } else {
                        ""
                    }
                ),
                window.map(|w| (w.start.iso_string(), w.start.plus_years(100).iso_string())),
            ),
        };
        Ok(match self {
            Self::Sqlite(p) => {
                let mut q = sqlx::query_scalar::<_, i64>(AssertSqlSafe(sql)).bind(user_id);
                if let Some((from, to)) = &bounds {
                    q = q.bind(from).bind(to);
                }
                q.fetch_one(p).await?
            }
            Self::Postgres(p) => {
                let mut q = sqlx::query_scalar::<_, i64>(AssertSqlSafe(sql)).bind(user_id);
                if let Some((from, to)) = &bounds {
                    q = q.bind(from).bind(to);
                }
                q.fetch_one(p).await?
            }
        })
    }

    /// `getQuota`'s tv sum: `tvQuotaUnits` over non-declined tv requests by
    /// the user that count towards the quota. The window start is compared
    /// as the ISO text `Date.toJSON` writes, which on `SQLite` sorts after
    /// a row from the same day (the `T` beats the space); Node does the same.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn tv_quota_used(&self, user_id: i64, window: Option<QuotaWindow>) -> Result<i64> {
        let sql = match self {
            Self::Sqlite(_) => format!(
                r#"SELECT COALESCE(SUM(r."tvQuotaUnits"), 0) FROM "media_request" r WHERE r."type" = 'tv' AND r."requestedById" = ?1 AND r."status" != 3 AND r."ignoreQuota" = 0{}"#,
                if window.is_some() {
                    r#" AND r."createdAt" > ?2"#
                } else {
                    ""
                }
            ),
            Self::Postgres(_) => format!(
                r#"SELECT COALESCE(SUM(r."tvQuotaUnits"), 0)::bigint FROM "media_request" r WHERE r."type" = 'tv' AND r."requestedById" = $1 AND r."status" != 3 AND r."ignoreQuota" = false{}"#,
                if window.is_some() {
                    r#" AND r."createdAt" > $2::timestamptz"#
                } else {
                    ""
                }
            ),
        };
        let start = window.map(|w| w.start.iso_string());
        Ok(match self {
            Self::Sqlite(p) => {
                let mut q = sqlx::query_scalar::<_, i64>(AssertSqlSafe(sql)).bind(user_id);
                if let Some(start) = &start {
                    q = q.bind(start);
                }
                q.fetch_one(p).await?
            }
            Self::Postgres(p) => {
                let mut q = sqlx::query_scalar::<_, i64>(AssertSqlSafe(sql)).bind(user_id);
                if let Some(start) = &start {
                    q = q.bind(start);
                }
                q.fetch_one(p).await?
            }
        })
    }

    /// Whether the user has a local password set.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn user_has_password(&self, id: i64) -> Result<bool> {
        let password: Option<Option<String>> = match self {
            Self::Sqlite(p) => {
                sqlx::query_scalar(r#"SELECT "password" FROM "user" WHERE "id" = ?1"#)
                    .bind(id)
                    .fetch_optional(p)
                    .await?
            }
            Self::Postgres(p) => {
                sqlx::query_scalar(r#"SELECT "password" FROM "user" WHERE "id" = $1"#)
                    .bind(id)
                    .fetch_optional(p)
                    .await?
            }
        };
        Ok(password.flatten().is_some_and(|p| !p.is_empty()))
    }

    /// A user's profile for `/auth/me`.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn user_profile(&self, id: i64) -> Result<Option<UserProfile>> {
        let row = match self {
            Self::Sqlite(p) => sqlx::query(PROFILE_SQLITE)
                .bind(id)
                .fetch_optional(p)
                .await?
                .map(|r| profile_from_row(&r, true))
                .transpose()?,
            Self::Postgres(p) => sqlx::query(PROFILE_PG)
                .bind(id)
                .fetch_optional(p)
                .await?
                .map(|r| profile_from_row(&r, false))
                .transpose()?,
        };
        Ok(row)
    }
    /// A user with its settings row, as `findOneOrFail` with the eager
    /// relation loads it.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn user_record(
        &self,
        id: i64,
    ) -> Result<Option<(UserRecord, Option<UserSettingsRecord>)>> {
        let row = match self {
            Self::Sqlite(p) => {
                let sql = format!(
                    r#"SELECT {USER_COLUMNS_SQLITE}, {SETTINGS_COLUMNS_SQLITE} FROM "user" u LEFT JOIN "user_settings" s ON s."userId" = u."id" WHERE u."id" = ?1"#
                );
                sqlx::query(AssertSqlSafe(sql))
                    .bind(id)
                    .fetch_optional(p)
                    .await?
                    .map(|r| -> Result<_> {
                        Ok((user_from_row(&r, true)?, settings_from_row(&r, true)?))
                    })
                    .transpose()?
            }
            Self::Postgres(p) => {
                let sql = format!(
                    r#"SELECT {USER_COLUMNS_PG}, {SETTINGS_COLUMNS_PG} FROM "user" u LEFT JOIN "user_settings" s ON s."userId" = u."id" WHERE u."id" = $1"#
                );
                sqlx::query(AssertSqlSafe(sql))
                    .bind(id)
                    .fetch_optional(p)
                    .await?
                    .map(|r| -> Result<_> {
                        Ok((user_from_row(&r, false)?, settings_from_row(&r, false)?))
                    })
                    .transpose()?
            }
        };
        Ok(row)
    }

    /// One page of users and the total, as `getManyAndCount` returns them.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn user_list(&self, query: &UserListQuery) -> Result<(Vec<UserRecord>, i64)> {
        let direction = if query.ascending { "ASC" } else { "DESC" };
        let key = user_sort_key(query.sort);
        let pattern = query.search.as_ref().map(|q| format!("%{q}%"));
        match self {
            Self::Sqlite(p) => {
                let filter = user_list_where(query, sqlite_ph);
                let n = usize::from(pattern.is_some()) + query.include_ids.len();
                let page = format!(
                    r#"SELECT DISTINCT {USER_COLUMNS_SQLITE}, {key} AS "sortKey" FROM "user" u{filter} ORDER BY "sortKey" {direction} LIMIT ?{} OFFSET ?{}"#,
                    n + 1,
                    n + 2
                );
                let count = format!(r#"SELECT COUNT(DISTINCT u."id") FROM "user" u{filter}"#);
                let mut page_q = sqlx::query(AssertSqlSafe(page));
                let mut count_q = sqlx::query_scalar::<_, i64>(AssertSqlSafe(count));
                if let Some(pattern) = &pattern {
                    page_q = page_q.bind(pattern);
                    count_q = count_q.bind(pattern);
                }
                for id in &query.include_ids {
                    page_q = page_q.bind(id);
                    count_q = count_q.bind(id);
                }
                let rows = page_q
                    .bind(query.take)
                    .bind(query.skip)
                    .fetch_all(p)
                    .await?;
                let users = rows
                    .iter()
                    .map(|r| user_from_row(r, true))
                    .collect::<Result<Vec<_>>>()?;
                Ok((users, count_q.fetch_one(p).await?))
            }
            Self::Postgres(p) => {
                let filter = user_list_where(query, pg_ph);
                let n = usize::from(pattern.is_some()) + query.include_ids.len();
                let page = format!(
                    r#"SELECT DISTINCT {USER_COLUMNS_PG}, {key} AS "sortKey" FROM "user" u{filter} ORDER BY "sortKey" {direction} LIMIT ${} OFFSET ${}"#,
                    n + 1,
                    n + 2
                );
                let count =
                    format!(r#"SELECT COUNT(DISTINCT u."id")::bigint FROM "user" u{filter}"#);
                let mut page_q = sqlx::query(AssertSqlSafe(page));
                let mut count_q = sqlx::query_scalar::<_, i64>(AssertSqlSafe(count));
                if let Some(pattern) = &pattern {
                    page_q = page_q.bind(pattern);
                    count_q = count_q.bind(pattern);
                }
                for id in &query.include_ids {
                    page_q = page_q.bind(id);
                    count_q = count_q.bind(id);
                }
                let rows = page_q
                    .bind(query.take)
                    .bind(query.skip)
                    .fetch_all(p)
                    .await?;
                let users = rows
                    .iter()
                    .map(|r| user_from_row(r, false))
                    .collect::<Result<Vec<_>>>()?;
                Ok((users, count_q.fetch_one(p).await?))
            }
        }
    }
    /// Every override rule, in insertion order (`find({})`).
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn override_rules(&self) -> Result<Vec<OverrideRuleRow>> {
        const SQL_SQLITE: &str = r#"SELECT "id", "radarrServiceId", "sonarrServiceId", "users", "genre", "language", "keywords", "profileId", "rootFolder", "tags", "createdAt", "updatedAt" FROM "override_rule""#;
        const SQL_PG: &str = r#"SELECT "id"::bigint AS "id", "radarrServiceId"::bigint AS "radarrServiceId", "sonarrServiceId"::bigint AS "sonarrServiceId", "users", "genre", "language", "keywords", "profileId"::bigint AS "profileId", "rootFolder", "tags",
            to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
            to_char("updatedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt" FROM "override_rule""#;
        let rows = match self {
            Self::Sqlite(p) => sqlx::query(SQL_SQLITE)
                .fetch_all(p)
                .await?
                .iter()
                .map(|r| override_rule_from_row(r, true))
                .collect::<Result<Vec<_>>>()?,
            Self::Postgres(p) => sqlx::query(SQL_PG)
                .fetch_all(p)
                .await?
                .iter()
                .map(|r| override_rule_from_row(r, false))
                .collect::<Result<Vec<_>>>()?,
        };
        Ok(rows)
    }

    /// One page of the blocklist with its users and the total, ordered as
    /// `getManyAndCount` does: newest first, then by id.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn blocklist(&self, query: &BlocklistQuery) -> Result<(Vec<BlocklistRow>, i64)> {
        let mut filter = String::from(" WHERE 1 = 1");
        match query.tagged {
            Some(true) => filter.push_str(r#" AND b."blocklistedTags" IS NOT NULL"#),
            Some(false) => filter.push_str(r#" AND b."blocklistedTags" IS NULL"#),
            None => {}
        }
        let pattern = query.search.as_ref().map(|s| format!("%{s}%"));
        let (ph_search, ph_take, ph_skip) = match self {
            Self::Sqlite(_) => (
                "?1",
                if pattern.is_some() { "?2" } else { "?1" },
                if pattern.is_some() { "?3" } else { "?2" },
            ),
            Self::Postgres(_) => (
                "$1",
                if pattern.is_some() { "$2" } else { "$1" },
                if pattern.is_some() { "$3" } else { "$2" },
            ),
        };
        if pattern.is_some() {
            filter.push_str(r#" AND b."title" like "#);
            filter.push_str(ph_search);
        }
        let (columns, dates) = match self {
            Self::Sqlite(_) => (
                format!(
                    r#"b."id" AS "b_id", b."mediaType" AS "b_mediaType", b."title" AS "b_title", b."tmdbId" AS "b_tmdbId", b."blocklistedTags" AS "b_blocklistedTags", b."createdAt" AS "b_createdAt", {USER_COLUMNS_SQLITE}"#
                ),
                true,
            ),
            Self::Postgres(_) => (
                format!(
                    r#"b."id"::bigint AS "b_id", b."mediaType" AS "b_mediaType", b."title" AS "b_title", b."tmdbId"::bigint AS "b_tmdbId", b."blocklistedTags" AS "b_blocklistedTags", to_char(b."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "b_createdAt", {USER_COLUMNS_PG}"#
                ),
                false,
            ),
        };
        let page = format!(
            r#"SELECT {columns} FROM "blocklist" b LEFT JOIN "user" u ON u."id" = b."userId"{filter} ORDER BY b."createdAt" DESC, b."id" ASC LIMIT {ph_take} OFFSET {ph_skip}"#
        );
        let count = format!(
            r#"SELECT COUNT(DISTINCT b."id") FROM "blocklist" b LEFT JOIN "user" u ON u."id" = b."userId"{filter}"#
        );
        let count = if dates {
            count
        } else {
            count.replace(
                "COUNT(DISTINCT b.\"id\")",
                "COUNT(DISTINCT b.\"id\")::bigint",
            )
        };
        match self {
            Self::Sqlite(p) => {
                let mut page_q = sqlx::query(AssertSqlSafe(page));
                let mut count_q = sqlx::query_scalar::<_, i64>(AssertSqlSafe(count));
                if let Some(pattern) = &pattern {
                    page_q = page_q.bind(pattern);
                    count_q = count_q.bind(pattern);
                }
                let rows = page_q
                    .bind(query.take)
                    .bind(query.skip)
                    .fetch_all(p)
                    .await?;
                let items = rows
                    .iter()
                    .map(|r| blocklist_from_row(r, dates))
                    .collect::<Result<Vec<_>>>()?;
                Ok((items, count_q.fetch_one(p).await?))
            }
            Self::Postgres(p) => {
                let mut page_q = sqlx::query(AssertSqlSafe(page));
                let mut count_q = sqlx::query_scalar::<_, i64>(AssertSqlSafe(count));
                if let Some(pattern) = &pattern {
                    page_q = page_q.bind(pattern);
                    count_q = count_q.bind(pattern);
                }
                let rows = page_q
                    .bind(query.take)
                    .bind(query.skip)
                    .fetch_all(p)
                    .await?;
                let items = rows
                    .iter()
                    .map(|r| blocklist_from_row(r, dates))
                    .collect::<Result<Vec<_>>>()?;
                Ok((items, count_q.fetch_one(p).await?))
            }
        }
    }

    /// One page of `GET /media` and the total, in Node's order.
    ///
    /// Rows come sorted by the sort column descending, then id ascending:
    /// the order `TypeORM`'s distinct id query imposes and `SQLite` keeps
    /// for ties. Each row carries its seasons by id, except when sorted by
    /// `mediaAddedAt`: that query builder doesn't load the eager relation,
    /// so Node leaves `seasons` out.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn media_list(&self, query: &MediaListQuery) -> Result<(Vec<MediaRow>, i64)> {
        let sql = MediaSql::build(matches!(self, Self::Sqlite(_)), query);
        let bound = query.statuses.iter().cycle().take(sql.status_binds);
        let (mut media, total) = match self {
            Self::Sqlite(p) => {
                let mut page_q = sqlx::query(AssertSqlSafe(sql.page));
                let mut count_q = sqlx::query_scalar::<_, i64>(AssertSqlSafe(sql.count));
                for status in bound {
                    page_q = page_q.bind(status);
                    count_q = count_q.bind(status);
                }
                let rows = page_q
                    .bind(query.take)
                    .bind(query.skip)
                    .fetch_all(p)
                    .await?;
                let media = rows
                    .iter()
                    .map(|r| media_from_row(r, true))
                    .collect::<Result<Vec<_>>>()?;
                (media, count_q.fetch_one(p).await?)
            }
            Self::Postgres(p) => {
                let mut page_q = sqlx::query(AssertSqlSafe(sql.page));
                let mut count_q = sqlx::query_scalar::<_, i64>(AssertSqlSafe(sql.count));
                for status in bound {
                    page_q = page_q.bind(status);
                    count_q = count_q.bind(status);
                }
                let rows = page_q
                    .bind(query.take)
                    .bind(query.skip)
                    .fetch_all(p)
                    .await?;
                let media = rows
                    .iter()
                    .map(|r| media_from_row(r, false))
                    .collect::<Result<Vec<_>>>()?;
                (media, count_q.fetch_one(p).await?)
            }
        };
        if let Self::Postgres(p) = self {
            if !media.is_empty() {
                return Ok((pg_eager_page(p, media, query).await?, total));
            }
        }
        if query.sort != MediaSort::MediaAddedAt && !media.is_empty() {
            let ids = media
                .iter()
                .map(|m| m.id.to_string())
                .collect::<Vec<_>>()
                .join(", ");
            for season in self.seasons_of(&ids).await? {
                if let Some(owner) = media.iter_mut().find(|m| Some(m.id) == season.media_id) {
                    owner.seasons.push(season);
                }
            }
        }
        Ok((media, total))
    }

    /// One page of `GET /request` and the total, with each request's season
    /// and episode rows in the order `MediaRequest.sortChildren` leaves
    /// them. Ordered like `getManyAndCount`: the sort column, then id
    /// ascending.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn request_list(&self, query: &RequestListQuery) -> Result<(Vec<RequestRow>, i64)> {
        let sqlite = matches!(self, Self::Sqlite(_));
        let sql = RequestSql::build(sqlite, query);
        let (mut requests, total) = match self {
            Self::Sqlite(p) => {
                let mut page_q = sqlx::query(AssertSqlSafe(sql.page));
                let mut count_q = sqlx::query_scalar::<_, i64>(AssertSqlSafe(sql.count));
                for value in &sql.binds {
                    page_q = bind_value(page_q, value);
                    count_q = bind_scalar(count_q, value);
                }
                let rows = page_q
                    .bind(query.take)
                    .bind(query.skip)
                    .fetch_all(p)
                    .await?;
                let requests = rows
                    .iter()
                    .map(|r| request_from_row(r, true))
                    .collect::<Result<Vec<_>>>()?;
                (requests, count_q.fetch_one(p).await?)
            }
            Self::Postgres(p) => {
                let mut page_q = sqlx::query(AssertSqlSafe(sql.page));
                let mut count_q = sqlx::query_scalar::<_, i64>(AssertSqlSafe(sql.count));
                for value in &sql.binds {
                    page_q = bind_value(page_q, value);
                    count_q = bind_scalar(count_q, value);
                }
                let rows = page_q
                    .bind(query.take)
                    .bind(query.skip)
                    .fetch_all(p)
                    .await?;
                let requests = rows
                    .iter()
                    .map(|r| request_from_row(r, false))
                    .collect::<Result<Vec<_>>>()?;
                let total = count_q.fetch_one(p).await?;
                if query.sort == RequestSort::UpdatedAt && !requests.is_empty() {
                    (
                        pg_request_order(p, requests, query, &sql.binds).await?,
                        total,
                    )
                } else {
                    (requests, total)
                }
            }
        };
        self.attach_request_children(&mut requests).await?;
        Ok((requests, total))
    }

    /// One request by id with its seasons and episodes, as `findOneOrFail`
    /// loads it.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn request_by_id(&self, id: i64) -> Result<Option<RequestRow>> {
        let row = match self {
            Self::Sqlite(p) => {
                let sql = format!(
                    r#"SELECT {REQUEST_COLUMNS_SQLITE} FROM "media_request" r WHERE r."id" = ?1"#
                );
                sqlx::query(AssertSqlSafe(sql))
                    .bind(id)
                    .fetch_optional(p)
                    .await?
                    .map(|r| request_from_row(&r, true))
                    .transpose()?
            }
            Self::Postgres(p) => {
                let sql = format!(
                    r#"SELECT {REQUEST_COLUMNS_PG} FROM "media_request" r WHERE r."id" = $1"#
                );
                sqlx::query(AssertSqlSafe(sql))
                    .bind(id)
                    .fetch_optional(p)
                    .await?
                    .map(|r| request_from_row(&r, false))
                    .transpose()?
            }
        };
        let mut requests: Vec<RequestRow> = row.into_iter().collect();
        self.attach_request_children(&mut requests).await?;
        Ok(requests.pop())
    }

    /// `GET /request/count`: the nine counts over requests that still have
    /// their media row.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn request_counts(&self) -> Result<RequestCounts> {
        let processing = r#"r."status" = 2 AND ((r."is4k" = false AND m."status" != 5) OR (r."is4k" = true AND m."status4k" != 5))"#;
        let available = r#"r."status" = 2 AND ((r."is4k" = false AND m."status" = 5) OR (r."is4k" = true AND m."status4k" = 5))"#;
        let cast = if matches!(self, Self::Sqlite(_)) {
            ""
        } else {
            "::bigint"
        };
        let count = |cond: &str, name: &str| {
            format!(r#"COUNT(CASE WHEN {cond} THEN 1 END){cast} AS "{name}""#)
        };
        let sql = format!(
            r#"SELECT COUNT(*){cast} AS "total", {}, {}, {}, {}, {}, {}, {}, {} FROM "media_request" r INNER JOIN "media" m ON m."id" = r."mediaId""#,
            count(r#"r."type" = 'movie'"#, "movie"),
            count(r#"r."type" = 'tv'"#, "tv"),
            count(r#"r."status" = 1"#, "pending"),
            count(r#"r."status" = 2"#, "approved"),
            count(r#"r."status" = 3"#, "declined"),
            count(processing, "processing"),
            count(available, "available"),
            count(r#"r."status" = 5"#, "completed"),
        );
        let read = |r: &dyn RequestCountRow| -> Result<RequestCounts> {
            Ok(RequestCounts {
                total: r.count("total")?,
                movie: r.count("movie")?,
                tv: r.count("tv")?,
                pending: r.count("pending")?,
                approved: r.count("approved")?,
                declined: r.count("declined")?,
                processing: r.count("processing")?,
                available: r.count("available")?,
                completed: r.count("completed")?,
            })
        };
        match self {
            Self::Sqlite(p) => {
                let row = sqlx::query(AssertSqlSafe(sql)).fetch_one(p).await?;
                read(&row)
            }
            Self::Postgres(p) => {
                let row = sqlx::query(AssertSqlSafe(sql)).fetch_one(p).await?;
                read(&row)
            }
        }
    }

    /// The media rows with these ids, with their seasons when asked.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn media_by_ids(&self, ids: &[i64], with_seasons: bool) -> Result<Vec<MediaRow>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let list = ids
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(", ");
        let mut media = match self {
            Self::Sqlite(p) => {
                let sql = format!(
                    r#"SELECT {MEDIA_COLUMNS_SQLITE} FROM "media" m WHERE m."id" IN ({list})"#
                );
                sqlx::query(AssertSqlSafe(sql))
                    .fetch_all(p)
                    .await?
                    .iter()
                    .map(|r| media_from_row(r, true))
                    .collect::<Result<Vec<_>>>()?
            }
            Self::Postgres(p) => {
                let sql =
                    format!(r#"SELECT {MEDIA_COLUMNS_PG} FROM "media" m WHERE m."id" IN ({list})"#);
                sqlx::query(AssertSqlSafe(sql))
                    .fetch_all(p)
                    .await?
                    .iter()
                    .map(|r| media_from_row(r, false))
                    .collect::<Result<Vec<_>>>()?
            }
        };
        if with_seasons && !media.is_empty() {
            for season in self.seasons_of(&list).await? {
                if let Some(owner) = media.iter_mut().find(|m| Some(m.id) == season.media_id) {
                    owner.seasons.push(season);
                }
            }
        }
        Ok(media)
    }

    /// Load the season and episode rows of these requests into them.
    async fn attach_request_children(&self, requests: &mut [RequestRow]) -> Result<()> {
        if requests.is_empty() {
            return Ok(());
        }
        let ids = requests
            .iter()
            .map(|r| r.id.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        let (seasons, episodes) = match self {
            Self::Sqlite(p) => {
                let seasons = format!(
                    r#"SELECT "id", "seasonNumber", "status", "createdAt", "updatedAt", "requestId" FROM "season_request" WHERE "requestId" IN ({ids}) ORDER BY "id" ASC"#
                );
                let episodes = format!(
                    r#"SELECT "id", "tvdbId", "seasonNumber", "episodeNumber", "title", "airDate", "status", "searchTriggeredAt", "createdAt", "updatedAt", "requestId" FROM "episode_request" WHERE "requestId" IN ({ids}) ORDER BY "seasonNumber" ASC, "episodeNumber" ASC, "id" ASC"#
                );
                (
                    sqlx::query(AssertSqlSafe(seasons))
                        .fetch_all(p)
                        .await?
                        .iter()
                        .map(|r| season_request_from_row(r, true))
                        .collect::<Result<Vec<_>>>()?,
                    sqlx::query(AssertSqlSafe(episodes))
                        .fetch_all(p)
                        .await?
                        .iter()
                        .map(|r| episode_request_from_row(r, true))
                        .collect::<Result<Vec<_>>>()?,
                )
            }
            Self::Postgres(p) => {
                let seasons = format!(
                    r#"SELECT "id"::bigint AS "id", "seasonNumber"::bigint AS "seasonNumber", "status"::bigint AS "status", {} AS "createdAt", {} AS "updatedAt", "requestId"::bigint AS "requestId" FROM "season_request" WHERE "requestId" IN ({ids}) ORDER BY "id" ASC"#,
                    pg_iso("\"createdAt\""),
                    pg_iso("\"updatedAt\"")
                );
                let episodes = format!(
                    r#"SELECT "id"::bigint AS "id", "tvdbId"::bigint AS "tvdbId", "seasonNumber"::bigint AS "seasonNumber", "episodeNumber"::bigint AS "episodeNumber", "title", "airDate", "status"::bigint AS "status", {} AS "searchTriggeredAt", {} AS "createdAt", {} AS "updatedAt", "requestId"::bigint AS "requestId" FROM "episode_request" WHERE "requestId" IN ({ids}) ORDER BY "seasonNumber" ASC, "episodeNumber" ASC, "id" ASC"#,
                    pg_iso("\"searchTriggeredAt\""),
                    pg_iso("\"createdAt\""),
                    pg_iso("\"updatedAt\"")
                );
                (
                    sqlx::query(AssertSqlSafe(seasons))
                        .fetch_all(p)
                        .await?
                        .iter()
                        .map(|r| season_request_from_row(r, false))
                        .collect::<Result<Vec<_>>>()?,
                    sqlx::query(AssertSqlSafe(episodes))
                        .fetch_all(p)
                        .await?
                        .iter()
                        .map(|r| episode_request_from_row(r, false))
                        .collect::<Result<Vec<_>>>()?,
                )
            }
        };
        for season in seasons {
            if let Some(owner) = requests
                .iter_mut()
                .find(|r| Some(r.id) == season.request_id)
            {
                owner.seasons.push(season);
            }
        }
        for episode in episodes {
            if let Some(owner) = requests
                .iter_mut()
                .find(|r| Some(r.id) == episode.request_id)
            {
                owner.episodes.push(episode);
            }
        }
        Ok(())
    }

    /// One page of `GET /issue` and the total, each issue with its comments
    /// by id, ordered like `getManyAndCount`: the sort column descending,
    /// then id ascending.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn issue_list(&self, query: &IssueListQuery) -> Result<(Vec<IssueRow>, i64)> {
        let sqlite = matches!(self, Self::Sqlite(_));
        let ph = |n: usize| if sqlite { sqlite_ph(n) } else { pg_ph(n) };
        let n = query.statuses.len();
        let statuses = (0..n).map(|i| ph(i + 1)).collect::<Vec<_>>().join(", ");
        let user_clause = query
            .created_by
            .map(|_| format!(r#" AND cb."id" = {}"#, ph(n + 1)))
            .unwrap_or_default();
        let binds = n + usize::from(query.created_by.is_some());
        let from = format!(
            r#"FROM "issue" i LEFT JOIN "user" cb ON cb."id" = i."createdById" WHERE i."status" IN ({statuses}){user_clause}"#
        );
        let order = match query.sort {
            IssueSort::CreatedAt => r#"i."createdAt" DESC, i."id" ASC"#,
            IssueSort::UpdatedAt => r#"i."updatedAt" DESC, i."id" ASC"#,
        };
        let columns = if sqlite {
            ISSUE_COLUMNS_SQLITE
        } else {
            ISSUE_COLUMNS_PG
        };
        let page = format!(
            "SELECT {columns} {from} ORDER BY {order} LIMIT {} OFFSET {}",
            ph(binds + 1),
            ph(binds + 2)
        );
        let count = format!("SELECT COUNT(*) {from}");
        let (mut issues, total) = match self {
            Self::Sqlite(p) => {
                let mut page_q = sqlx::query(AssertSqlSafe(page));
                let mut count_q = sqlx::query_scalar::<_, i64>(AssertSqlSafe(count));
                for status in &query.statuses {
                    page_q = page_q.bind(status);
                    count_q = count_q.bind(status);
                }
                if let Some(user) = query.created_by {
                    page_q = page_q.bind(user);
                    count_q = count_q.bind(user);
                }
                let rows = page_q
                    .bind(query.take)
                    .bind(query.skip)
                    .fetch_all(p)
                    .await?;
                let issues = rows
                    .iter()
                    .map(|r| issue_from_row(r, true))
                    .collect::<Result<Vec<_>>>()?;
                (issues, count_q.fetch_one(p).await?)
            }
            Self::Postgres(p) => {
                let mut page_q = sqlx::query(AssertSqlSafe(page));
                let mut count_q = sqlx::query_scalar::<_, i64>(AssertSqlSafe(count));
                for status in &query.statuses {
                    page_q = page_q.bind(status);
                    count_q = count_q.bind(status);
                }
                if let Some(user) = query.created_by {
                    page_q = page_q.bind(user);
                    count_q = count_q.bind(user);
                }
                let rows = page_q
                    .bind(query.take)
                    .bind(query.skip)
                    .fetch_all(p)
                    .await?;
                let issues = rows
                    .iter()
                    .map(|r| issue_from_row(r, false))
                    .collect::<Result<Vec<_>>>()?;
                (issues, count_q.fetch_one(p).await?)
            }
        };
        self.attach_issue_comments(&mut issues).await?;
        Ok((issues, total))
    }

    /// One issue by id with its comments.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn issue_by_id(&self, id: i64) -> Result<Option<IssueRow>> {
        let row = match self {
            Self::Sqlite(p) => {
                let sql =
                    format!(r#"SELECT {ISSUE_COLUMNS_SQLITE} FROM "issue" i WHERE i."id" = ?1"#);
                sqlx::query(AssertSqlSafe(sql))
                    .bind(id)
                    .fetch_optional(p)
                    .await?
                    .map(|r| issue_from_row(&r, true))
                    .transpose()?
            }
            Self::Postgres(p) => {
                let sql = format!(r#"SELECT {ISSUE_COLUMNS_PG} FROM "issue" i WHERE i."id" = $1"#);
                sqlx::query(AssertSqlSafe(sql))
                    .bind(id)
                    .fetch_optional(p)
                    .await?
                    .map(|r| issue_from_row(&r, false))
                    .transpose()?
            }
        };
        let mut issues: Vec<IssueRow> = row.into_iter().collect();
        self.attach_issue_comments(&mut issues).await?;
        Ok(issues.pop())
    }

    /// `GET /issue/count`.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn issue_counts(&self) -> Result<IssueCounts> {
        let cast = if matches!(self, Self::Sqlite(_)) {
            ""
        } else {
            "::bigint"
        };
        let count = |cond: &str, name: &str| {
            format!(r#"COUNT(CASE WHEN {cond} THEN 1 END){cast} AS "{name}""#)
        };
        let sql = format!(
            r#"SELECT COUNT(*){cast} AS "total", {}, {}, {}, {}, {}, {} FROM "issue" i"#,
            count(r#"i."issueType" = 1"#, "video"),
            count(r#"i."issueType" = 2"#, "audio"),
            count(r#"i."issueType" = 3"#, "subtitles"),
            count(r#"i."issueType" = 4"#, "others"),
            count(r#"i."status" = 1"#, "open"),
            count(r#"i."status" = 2"#, "closed"),
        );
        let read = |r: &dyn RequestCountRow| -> Result<IssueCounts> {
            Ok(IssueCounts {
                total: r.count("total")?,
                video: r.count("video")?,
                audio: r.count("audio")?,
                subtitles: r.count("subtitles")?,
                others: r.count("others")?,
                open: r.count("open")?,
                closed: r.count("closed")?,
            })
        };
        match self {
            Self::Sqlite(p) => read(&sqlx::query(AssertSqlSafe(sql)).fetch_one(p).await?),
            Self::Postgres(p) => read(&sqlx::query(AssertSqlSafe(sql)).fetch_one(p).await?),
        }
    }

    /// Load the comments of these issues into them, by id.
    async fn attach_issue_comments(&self, issues: &mut [IssueRow]) -> Result<()> {
        if issues.is_empty() {
            return Ok(());
        }
        let ids = issues
            .iter()
            .map(|i| i.id.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        let comments = match self {
            Self::Sqlite(p) => {
                let sql = format!(
                    r#"SELECT "id", "message", "createdAt", "updatedAt", "userId", "issueId" FROM "issue_comment" WHERE "issueId" IN ({ids}) ORDER BY "id" ASC"#
                );
                sqlx::query(AssertSqlSafe(sql))
                    .fetch_all(p)
                    .await?
                    .iter()
                    .map(|r| comment_from_row(r, true))
                    .collect::<Result<Vec<_>>>()?
            }
            Self::Postgres(p) => {
                let sql = format!(
                    r#"SELECT "id"::bigint AS "id", "message", {} AS "createdAt", {} AS "updatedAt", "userId"::bigint AS "userId", "issueId"::bigint AS "issueId" FROM "issue_comment" WHERE "issueId" IN ({ids}) ORDER BY "id" ASC"#,
                    pg_iso("\"createdAt\""),
                    pg_iso("\"updatedAt\"")
                );
                sqlx::query(AssertSqlSafe(sql))
                    .fetch_all(p)
                    .await?
                    .iter()
                    .map(|r| comment_from_row(r, false))
                    .collect::<Result<Vec<_>>>()?
            }
        };
        for comment in comments {
            if let Some(owner) = issues.iter_mut().find(|i| Some(i.id) == comment.issue_id) {
                owner.comments.push(comment);
            }
        }
        Ok(())
    }

    /// `GET /user/{id}/requests`: the user's requests newest first, with
    /// their children, and the total.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn requests_of_user(
        &self,
        user_id: i64,
        take: i64,
        skip: i64,
    ) -> Result<(Vec<RequestRow>, i64)> {
        let (mut requests, total) = match self {
            Self::Sqlite(p) => {
                let page = format!(
                    r#"SELECT {REQUEST_COLUMNS_SQLITE} FROM "media_request" r LEFT JOIN "user" rb ON rb."id" = r."requestedById" WHERE rb."id" = ?1 ORDER BY r."id" DESC LIMIT ?2 OFFSET ?3"#
                );
                let rows = sqlx::query(AssertSqlSafe(page))
                    .bind(user_id)
                    .bind(take)
                    .bind(skip)
                    .fetch_all(p)
                    .await?;
                let requests = rows
                    .iter()
                    .map(|r| request_from_row(r, true))
                    .collect::<Result<Vec<_>>>()?;
                let total: i64 = sqlx::query_scalar(
                    r#"SELECT COUNT(*) FROM "media_request" r LEFT JOIN "user" rb ON rb."id" = r."requestedById" WHERE rb."id" = ?1"#,
                )
                .bind(user_id)
                .fetch_one(p)
                .await?;
                (requests, total)
            }
            Self::Postgres(p) => {
                let page = format!(
                    r#"SELECT {REQUEST_COLUMNS_PG} FROM "media_request" r LEFT JOIN "user" rb ON rb."id" = r."requestedById" WHERE rb."id" = $1 ORDER BY r."id" DESC LIMIT $2 OFFSET $3"#
                );
                let rows = sqlx::query(AssertSqlSafe(page))
                    .bind(user_id)
                    .bind(take)
                    .bind(skip)
                    .fetch_all(p)
                    .await?;
                let requests = rows
                    .iter()
                    .map(|r| request_from_row(r, false))
                    .collect::<Result<Vec<_>>>()?;
                let total: i64 = sqlx::query_scalar(
                    r#"SELECT COUNT(*)::bigint FROM "media_request" r LEFT JOIN "user" rb ON rb."id" = r."requestedById" WHERE rb."id" = $1"#,
                )
                .bind(user_id)
                .fetch_one(p)
                .await?;
                (requests, total)
            }
        };
        self.attach_request_children(&mut requests).await?;
        Ok((requests, total))
    }

    /// `GET /settings/about`: rows in `media` and `media_request`.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn media_and_request_counts(&self) -> Result<(i64, i64)> {
        match self {
            Self::Sqlite(p) => Ok((
                sqlx::query_scalar(r#"SELECT COUNT(*) FROM "media""#)
                    .fetch_one(p)
                    .await?,
                sqlx::query_scalar(r#"SELECT COUNT(*) FROM "media_request""#)
                    .fetch_one(p)
                    .await?,
            )),
            Self::Postgres(p) => Ok((
                sqlx::query_scalar(r#"SELECT COUNT(*)::bigint FROM "media""#)
                    .fetch_one(p)
                    .await?,
                sqlx::query_scalar(r#"SELECT COUNT(*)::bigint FROM "media_request""#)
                    .fetch_one(p)
                    .await?,
            )),
        }
    }

    /// `Media.getMedia`: the media row with this TMDB id and type, with its
    /// seasons, or none.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn media_by_tmdb(&self, tmdb_id: i64, media_type: &str) -> Result<Option<MediaRow>> {
        let row = match self {
            Self::Sqlite(p) => {
                let sql = format!(
                    r#"SELECT {MEDIA_COLUMNS_SQLITE} FROM "media" m WHERE m."tmdbId" = ?1 AND m."mediaType" = ?2 LIMIT 1"#
                );
                sqlx::query(AssertSqlSafe(sql))
                    .bind(tmdb_id)
                    .bind(media_type)
                    .fetch_optional(p)
                    .await?
                    .map(|r| media_from_row(&r, true))
                    .transpose()?
            }
            Self::Postgres(p) => {
                let sql = format!(
                    r#"SELECT {MEDIA_COLUMNS_PG} FROM "media" m WHERE m."tmdbId" = $1 AND m."mediaType" = $2 LIMIT 1"#
                );
                sqlx::query(AssertSqlSafe(sql))
                    .bind(tmdb_id)
                    .bind(media_type)
                    .fetch_optional(p)
                    .await?
                    .map(|r| media_from_row(&r, false))
                    .transpose()?
            }
        };
        let Some(mut media) = row else {
            return Ok(None);
        };
        media.seasons = self.seasons_of(&media.id.to_string()).await?;
        Ok(Some(media))
    }

    /// The requests of one media row, by id, with their children.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn requests_of_media(&self, media_id: i64) -> Result<Vec<RequestRow>> {
        let mut requests = match self {
            Self::Sqlite(p) => {
                let sql = format!(
                    r#"SELECT {REQUEST_COLUMNS_SQLITE} FROM "media_request" r WHERE r."mediaId" = ?1 ORDER BY r."id" ASC"#
                );
                sqlx::query(AssertSqlSafe(sql))
                    .bind(media_id)
                    .fetch_all(p)
                    .await?
                    .iter()
                    .map(|r| request_from_row(r, true))
                    .collect::<Result<Vec<_>>>()?
            }
            Self::Postgres(p) => {
                let sql = format!(
                    r#"SELECT {REQUEST_COLUMNS_PG} FROM "media_request" r WHERE r."mediaId" = $1 ORDER BY r."id" ASC"#
                );
                sqlx::query(AssertSqlSafe(sql))
                    .bind(media_id)
                    .fetch_all(p)
                    .await?
                    .iter()
                    .map(|r| request_from_row(r, false))
                    .collect::<Result<Vec<_>>>()?
            }
        };
        self.attach_request_children(&mut requests).await?;
        Ok(requests)
    }

    /// The issues of one media row, by id, with their comments.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn issues_of_media(&self, media_id: i64) -> Result<Vec<IssueRow>> {
        let mut issues = match self {
            Self::Sqlite(p) => {
                let sql = format!(
                    r#"SELECT {ISSUE_COLUMNS_SQLITE} FROM "issue" i WHERE i."mediaId" = ?1 ORDER BY i."id" ASC"#
                );
                sqlx::query(AssertSqlSafe(sql))
                    .bind(media_id)
                    .fetch_all(p)
                    .await?
                    .iter()
                    .map(|r| issue_from_row(r, true))
                    .collect::<Result<Vec<_>>>()?
            }
            Self::Postgres(p) => {
                let sql = format!(
                    r#"SELECT {ISSUE_COLUMNS_PG} FROM "issue" i WHERE i."mediaId" = $1 ORDER BY i."id" ASC"#
                );
                sqlx::query(AssertSqlSafe(sql))
                    .bind(media_id)
                    .fetch_all(p)
                    .await?
                    .iter()
                    .map(|r| issue_from_row(r, false))
                    .collect::<Result<Vec<_>>>()?
            }
        };
        self.attach_issue_comments(&mut issues).await?;
        Ok(issues)
    }

    /// Whether a user has this title on their watchlist.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn watchlist_exists(
        &self,
        tmdb_id: i64,
        media_type: &str,
        user_id: Option<i64>,
    ) -> Result<bool> {
        let Some(user_id) = user_id else {
            return Ok(false);
        };
        let count: i64 = match self {
            Self::Sqlite(p) => {
                sqlx::query_scalar(
                    r#"SELECT COUNT(*) FROM "watchlist" w WHERE w."tmdbId" = ?1 AND w."mediaType" = ?2 AND w."requestedById" = ?3"#,
                )
                .bind(tmdb_id)
                .bind(media_type)
                .bind(user_id)
                .fetch_one(p)
                .await?
            }
            Self::Postgres(p) => {
                sqlx::query_scalar(
                    r#"SELECT COUNT(*)::bigint FROM "watchlist" w WHERE w."tmdbId" = $1 AND w."mediaType" = $2 AND w."requestedById" = $3"#,
                )
                .bind(tmdb_id)
                .bind(media_type)
                .bind(user_id)
                .fetch_one(p)
                .await?
            }
        };
        Ok(count > 0)
    }

    /// `Media.getRelatedMedia`: the media rows of one type with these TMDB
    /// ids, by id, each with the user's watchlist rows for it.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn related_media(
        &self,
        tmdb_ids: &[i64],
        media_type: &str,
        user_id: Option<i64>,
    ) -> Result<Vec<RelatedMedia>> {
        if tmdb_ids.is_empty() {
            return Ok(Vec::new());
        }
        let list = tmdb_ids
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(", ");
        let media = match self {
            Self::Sqlite(p) => {
                let sql = format!(
                    r#"SELECT {MEDIA_COLUMNS_SQLITE} FROM "media" m WHERE m."tmdbId" IN ({list}) AND m."mediaType" = ?1 ORDER BY m."id" ASC"#
                );
                sqlx::query(AssertSqlSafe(sql))
                    .bind(media_type)
                    .fetch_all(p)
                    .await?
                    .iter()
                    .map(|r| media_from_row(r, true))
                    .collect::<Result<Vec<_>>>()?
            }
            Self::Postgres(p) => {
                let sql = format!(
                    r#"SELECT {MEDIA_COLUMNS_PG} FROM "media" m WHERE m."tmdbId" IN ({list}) AND m."mediaType" = $1 ORDER BY m."id" ASC"#
                );
                sqlx::query(AssertSqlSafe(sql))
                    .bind(media_type)
                    .fetch_all(p)
                    .await?
                    .iter()
                    .map(|r| media_from_row(r, false))
                    .collect::<Result<Vec<_>>>()?
            }
        };
        let mut related: Vec<RelatedMedia> = media
            .into_iter()
            .map(|media| RelatedMedia {
                media,
                watchlists: Vec::new(),
            })
            .collect();
        let (Some(user_id), false) = (user_id, related.is_empty()) else {
            return Ok(related);
        };
        let media_ids = related
            .iter()
            .map(|r| r.media.id.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        let rows = match self {
            Self::Sqlite(p) => {
                let sql = format!(
                    r#"SELECT "id", "ratingKey", "mediaType", "title", "tmdbId", "createdAt", "updatedAt", "mediaId" FROM "watchlist" WHERE "mediaId" IN ({media_ids}) AND "requestedById" = ?1 ORDER BY "id" ASC"#
                );
                sqlx::query(AssertSqlSafe(sql))
                    .bind(user_id)
                    .fetch_all(p)
                    .await?
                    .iter()
                    .map(|r| watchlist_from_row(r, true))
                    .collect::<Result<Vec<_>>>()?
            }
            Self::Postgres(p) => {
                let sql = format!(
                    r#"SELECT "id"::bigint AS "id", "ratingKey", "mediaType", "title", "tmdbId"::bigint AS "tmdbId", {} AS "createdAt", {} AS "updatedAt", "mediaId"::bigint AS "mediaId" FROM "watchlist" WHERE "mediaId" IN ({media_ids}) AND "requestedById" = $1 ORDER BY "id" ASC"#,
                    pg_iso("\"createdAt\""),
                    pg_iso("\"updatedAt\"")
                );
                sqlx::query(AssertSqlSafe(sql))
                    .bind(user_id)
                    .fetch_all(p)
                    .await?
                    .iter()
                    .map(|r| watchlist_from_row(r, false))
                    .collect::<Result<Vec<_>>>()?
            }
        };
        for row in rows {
            if let Some(owner) = related
                .iter_mut()
                .find(|r| Some(r.media.id) == row.media_id)
            {
                owner.watchlists.push(row);
            }
        }
        Ok(related)
    }

    /// The media ids among these with a pending or approved request.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn media_with_active_requests(&self, media_ids: &[i64]) -> Result<Vec<i64>> {
        if media_ids.is_empty() {
            return Ok(Vec::new());
        }
        let list = media_ids
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(", ");
        let ids = match self {
            Self::Sqlite(p) => {
                let sql = format!(
                    r#"SELECT DISTINCT r."mediaId" FROM "media_request" r WHERE r."mediaId" IN ({list}) AND r."status" IN (1, 2)"#
                );
                sqlx::query_scalar::<_, i64>(AssertSqlSafe(sql))
                    .fetch_all(p)
                    .await?
            }
            Self::Postgres(p) => {
                let sql = format!(
                    r#"SELECT DISTINCT r."mediaId"::bigint FROM "media_request" r WHERE r."mediaId" IN ({list}) AND r."status" IN (1, 2)"#
                );
                sqlx::query_scalar::<_, i64>(AssertSqlSafe(sql))
                    .fetch_all(p)
                    .await?
            }
        };
        Ok(ids)
    }

    /// Run a statement written with `?N` placeholders on either database;
    /// the number of rows it touched.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn execute(&self, sql: &str, binds: &[Bind]) -> Result<u64> {
        match self {
            Self::Sqlite(p) => {
                let mut q = sqlx::query(AssertSqlSafe(sql.to_owned()));
                for b in binds {
                    q = bind_value(q, b);
                }
                Ok(q.execute(p).await?.rows_affected())
            }
            Self::Postgres(p) => {
                let mut q = sqlx::query(AssertSqlSafe(pg_placeholders(sql)));
                for b in binds {
                    q = bind_value(q, b);
                }
                Ok(q.execute(p).await?.rows_affected())
            }
        }
    }

    /// Whether this is Postgres.
    #[must_use]
    pub const fn is_postgres(&self) -> bool {
        matches!(self, Self::Postgres(_))
    }

    /// SQL that renders a date column as `TypeORM` prints a `Date` in JSON
    /// (`2026-10-11T10:20:29.000Z`), on either database.
    #[must_use]
    pub fn iso_sql(&self, expr: &str) -> String {
        if self.is_postgres() {
            format!(r#"to_char({expr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')"#)
        } else {
            format!("strftime('%Y-%m-%dT%H:%M:%fZ', {expr})")
        }
    }

    /// Rows of any query written with `?N` placeholders, each as a JSON
    /// object keyed by column name in select order. Integers (cast to
    /// `BIGINT` on Postgres for int8, though int2/int4 decode too), reals,
    /// booleans, text and NULL are understood; `SQLite` booleans come back
    /// as integers, so callers convert those.
    ///
    /// # Errors
    ///
    /// Fails on database errors or a column of another type.
    pub async fn rows(
        &self,
        sql: &str,
        binds: &[Bind],
    ) -> Result<Vec<serde_json::Map<String, serde_json::Value>>> {
        match self {
            Self::Sqlite(p) => {
                let mut q = sqlx::query(AssertSqlSafe(sql.to_owned()));
                for b in binds {
                    q = bind_value(q, b);
                }
                q.fetch_all(p).await?.iter().map(sqlite_json_row).collect()
            }
            Self::Postgres(p) => {
                let mut q = sqlx::query(AssertSqlSafe(pg_placeholders(sql)));
                for b in binds {
                    q = bind_value(q, b);
                }
                q.fetch_all(p).await?.iter().map(pg_json_row).collect()
            }
        }
    }

    /// One integer from a query written with `?N` placeholders (a count,
    /// or an id from `RETURNING CAST("id" AS BIGINT)`).
    ///
    /// # Errors
    ///
    /// Fails on database errors or when no row comes back.
    pub async fn scalar(&self, sql: &str, binds: &[Bind]) -> Result<i64> {
        match self {
            Self::Sqlite(p) => {
                let mut q = sqlx::query_scalar::<_, i64>(AssertSqlSafe(sql.to_owned()));
                for b in binds {
                    q = bind_scalar(q, b);
                }
                Ok(q.fetch_one(p).await?)
            }
            Self::Postgres(p) => {
                let mut q = sqlx::query_scalar::<_, i64>(AssertSqlSafe(pg_placeholders(sql)));
                for b in binds {
                    q = bind_scalar(q, b);
                }
                Ok(q.fetch_one(p).await?)
            }
        }
    }

    /// One override rule by id.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn override_rule(&self, id: i64) -> Result<Option<OverrideRuleRow>> {
        Ok(self
            .override_rules()
            .await?
            .into_iter()
            .find(|r| r.id == id))
    }

    /// One discover slider by id.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn discover_slider(&self, id: i64) -> Result<Option<DiscoverSliderRow>> {
        Ok(self
            .discover_sliders()
            .await?
            .into_iter()
            .find(|r| r.id == id))
    }

    /// One issue comment by id.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn issue_comment(&self, id: i64) -> Result<Option<IssueCommentRow>> {
        match self {
            Self::Sqlite(p) => sqlx::query(
                r#"SELECT "id", "message", "createdAt", "updatedAt", "userId", "issueId" FROM "issue_comment" WHERE "id" = ?1"#,
            )
            .bind(id)
            .fetch_optional(p)
            .await?
            .map(|r| comment_from_row(&r, true))
            .transpose(),
            Self::Postgres(p) => {
                let sql = format!(
                    r#"SELECT "id"::bigint AS "id", "message", {} AS "createdAt", {} AS "updatedAt", "userId"::bigint AS "userId", "issueId"::bigint AS "issueId" FROM "issue_comment" WHERE "id" = $1"#,
                    pg_iso("\"createdAt\""),
                    pg_iso("\"updatedAt\"")
                );
                sqlx::query(AssertSqlSafe(sql))
                    .bind(id)
                    .fetch_optional(p)
                    .await?
                    .map(|r| comment_from_row(&r, false))
                    .transpose()
            }
        }
    }

    /// A user's watchlist rows, a page in table order, and the total.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn watchlist_page(
        &self,
        user_id: i64,
        take: i64,
        skip: i64,
    ) -> Result<(Vec<WatchlistRow>, i64)> {
        let total = self
            .scalar(
                r#"SELECT COUNT(*) FROM "watchlist" WHERE "requestedById" = ?1"#,
                &[Bind::Int(user_id)],
            )
            .await?;
        let rows = match self {
            Self::Sqlite(p) => sqlx::query(
                r#"SELECT "id", "ratingKey", "mediaType", "title", "tmdbId", "createdAt", "updatedAt", "mediaId" FROM "watchlist" WHERE "requestedById" = ?1 LIMIT ?2 OFFSET ?3"#,
            )
            .bind(user_id)
            .bind(take)
            .bind(skip)
            .fetch_all(p)
            .await?
            .iter()
            .map(|r| watchlist_from_row(r, true))
            .collect::<Result<Vec<_>>>()?,
            Self::Postgres(p) => {
                let sql = format!(
                    r#"SELECT "id"::bigint AS "id", "ratingKey", "mediaType", "title", "tmdbId"::bigint AS "tmdbId", {} AS "createdAt", {} AS "updatedAt", "mediaId"::bigint AS "mediaId" FROM "watchlist" WHERE "requestedById" = $1 LIMIT $2 OFFSET $3"#,
                    pg_iso("\"createdAt\""),
                    pg_iso("\"updatedAt\"")
                );
                sqlx::query(AssertSqlSafe(sql))
                    .bind(user_id)
                    .bind(take)
                    .bind(skip)
                    .fetch_all(p)
                    .await?
                    .iter()
                    .map(|r| watchlist_from_row(r, false))
                    .collect::<Result<Vec<_>>>()?
            }
        };
        Ok((rows, total))
    }

    /// Whether the user has a Plex token (a `select: false` column).
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn user_has_plex_token(&self, id: i64) -> Result<bool> {
        Ok(self
            .scalar(
                r#"SELECT COUNT(*) FROM "user" WHERE "id" = ?1 AND "plexToken" IS NOT NULL AND "plexToken" != ''"#,
                &[Bind::Int(id)],
            )
            .await?
            > 0)
    }

    /// A user's push subscriptions, optionally one endpoint, by id.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn push_subscriptions(
        &self,
        user_id: i64,
        endpoint: Option<&str>,
    ) -> Result<Vec<PushSubscriptionRow>> {
        let filter = if endpoint.is_some() {
            r#" AND "endpoint" = ?2"#
        } else {
            ""
        };
        let rows = match self {
            Self::Sqlite(p) => {
                let sql = format!(
                    r#"SELECT "id", "endpoint", "p256dh", "auth", "userAgent", "createdAt", "userId" FROM "user_push_subscription" WHERE "userId" = ?1{filter} ORDER BY "id""#
                );
                let mut q = sqlx::query(AssertSqlSafe(sql)).bind(user_id);
                if let Some(e) = endpoint {
                    q = q.bind(e.to_owned());
                }
                q.fetch_all(p)
                    .await?
                    .iter()
                    .map(|r| push_from_row(r, true))
                    .collect::<Result<Vec<_>>>()?
            }
            Self::Postgres(p) => {
                let sql = pg_placeholders(&format!(
                    r#"SELECT "id"::bigint AS "id", "endpoint", "p256dh", "auth", "userAgent", {} AS "createdAt", "userId"::bigint AS "userId" FROM "user_push_subscription" WHERE "userId" = ?1{filter} ORDER BY "id""#,
                    pg_iso("\"createdAt\"")
                ));
                let mut q = sqlx::query(AssertSqlSafe(sql)).bind(user_id);
                if let Some(e) = endpoint {
                    q = q.bind(e.to_owned());
                }
                q.fetch_all(p)
                    .await?
                    .iter()
                    .map(|r| push_from_row(r, false))
                    .collect::<Result<Vec<_>>>()?
            }
        };
        Ok(rows)
    }

    /// The Trakt and Simkl link state in a user's settings row.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn linked_accounts(&self, user_id: i64) -> Result<Option<LinkedAccountsRow>> {
        const COLS: &str = r#""traktAccessToken", "traktRefreshToken", "traktUsername", "mediaActionsTraktEnabled", "simklAccessToken", "simklUsername", "mediaActionsSimklEnabled""#;
        let read = |r: &dyn LinkedRow| r.linked();
        match self {
            Self::Sqlite(p) => {
                let sql =
                    format!(r#"SELECT {COLS} FROM "user_settings" WHERE "userId" = ?1 LIMIT 1"#);
                let row = sqlx::query(AssertSqlSafe(sql))
                    .bind(user_id)
                    .fetch_optional(p)
                    .await?;
                row.as_ref().map(|r| read(r)).transpose()
            }
            Self::Postgres(p) => {
                let sql =
                    format!(r#"SELECT {COLS} FROM "user_settings" WHERE "userId" = $1 LIMIT 1"#);
                let row = sqlx::query(AssertSqlSafe(sql))
                    .bind(user_id)
                    .fetch_optional(p)
                    .await?;
                row.as_ref().map(|r| read(r)).transpose()
            }
        }
    }

    /// The columns a password sign-in reads, by lower-cased email.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn login_account(&self, email: &str) -> Result<Option<LoginAccount>> {
        const SQL: &str = r#"SELECT CAST(u."id" AS BIGINT) AS "id", u."email", u."password", CAST(u."plexId" AS BIGINT) AS "plexId", (SELECT COUNT(*) FROM "media_request" r WHERE r."requestedById" = u."id") AS "requestCount" FROM "user" u WHERE u."email" = ?1 LIMIT 1"#;
        let read = |r: &dyn LoginRow| r.account();
        match self {
            Self::Sqlite(p) => {
                let row = sqlx::query(SQL).bind(email).fetch_optional(p).await?;
                row.as_ref().map(|r| read(r)).transpose()
            }
            Self::Postgres(p) => {
                let row = sqlx::query(AssertSqlSafe(pg_placeholders(SQL)))
                    .bind(email)
                    .fetch_optional(p)
                    .await?;
                row.as_ref().map(|r| read(r)).transpose()
            }
        }
    }

    /// Every user with their settings row, by id.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn all_users_with_settings(
        &self,
    ) -> Result<Vec<(UserRecord, Option<UserSettingsRecord>)>> {
        match self {
            Self::Sqlite(p) => {
                let sql = format!(
                    r#"SELECT {USER_COLUMNS_SQLITE}, {SETTINGS_COLUMNS_SQLITE} FROM "user" u LEFT JOIN "user_settings" s ON s."userId" = u."id" ORDER BY u."id""#
                );
                sqlx::query(AssertSqlSafe(sql))
                    .fetch_all(p)
                    .await?
                    .iter()
                    .map(|r| Ok((user_from_row(r, true)?, settings_from_row(r, true)?)))
                    .collect()
            }
            Self::Postgres(p) => {
                let sql = format!(
                    r#"SELECT {USER_COLUMNS_PG}, {SETTINGS_COLUMNS_PG} FROM "user" u LEFT JOIN "user_settings" s ON s."userId" = u."id" ORDER BY u."id""#
                );
                sqlx::query(AssertSqlSafe(sql))
                    .fetch_all(p)
                    .await?
                    .iter()
                    .map(|r| Ok((user_from_row(r, false)?, settings_from_row(r, false)?)))
                    .collect()
            }
        }
    }

    /// Mapping edges: dataset, target scope, source and target range.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn mapping_edges(
        &self,
        sql: &str,
        binds: &[Bind],
    ) -> Result<Vec<(String, String, Option<String>, Option<String>)>> {
        let read = |r: &dyn EdgeRow| r.edge();
        match self {
            Self::Sqlite(p) => {
                let mut q = sqlx::query(AssertSqlSafe(sql.to_owned()));
                for b in binds {
                    q = bind_value(q, b);
                }
                q.fetch_all(p).await?.iter().map(|r| read(r)).collect()
            }
            Self::Postgres(p) => {
                let mut q = sqlx::query(AssertSqlSafe(pg_placeholders(sql)));
                for b in binds {
                    q = bind_value(q, b);
                }
                q.fetch_all(p).await?.iter().map(|r| read(r)).collect()
            }
        }
    }

    /// The seasons of the media rows with these ids (a comma-separated
    /// list of integers), as the eager relation loads them: by id on
    /// `SQLite`; on Postgres in the order its scans of `season` (sequential
    /// or by the `mediaId` index) return them, which is `ctid` order.
    async fn seasons_of(&self, ids: &str) -> Result<Vec<SeasonRow>> {
        match self {
            Self::Sqlite(p) => {
                let sql = format!(
                    r#"SELECT "id", "seasonNumber", "status", "status4k", "createdAt", "updatedAt", "mediaId" FROM "season" WHERE "mediaId" IN ({ids}) ORDER BY "id" ASC"#
                );
                sqlx::query(AssertSqlSafe(sql))
                    .fetch_all(p)
                    .await?
                    .iter()
                    .map(|r| season_from_row(r, true))
                    .collect()
            }
            Self::Postgres(p) => {
                let sql = format!(
                    r#"SELECT "id"::bigint AS "id", "seasonNumber"::bigint AS "seasonNumber", "status"::bigint AS "status", "status4k"::bigint AS "status4k", to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt", to_char("updatedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt", "mediaId"::bigint AS "mediaId" FROM "season" WHERE "mediaId" IN ({ids}) ORDER BY ctid"#
                );
                sqlx::query(AssertSqlSafe(sql))
                    .fetch_all(p)
                    .await?
                    .iter()
                    .map(|r| season_from_row(r, false))
                    .collect()
            }
        }
    }
}

/// `getManyAndCount`'s second query of `GET /request` on Postgres, sorted
/// by `updatedAt`: the page's requests again with every joined relation,
/// ordered by the sort column alone. Requests tied on `updatedAt` come
/// back in the order Postgres's sort leaves them, which is the order Node
/// answers with. `binds` are the page query's, in the same order.
async fn pg_request_order(
    pool: &PgPool,
    requests: Vec<RequestRow>,
    query: &RequestListQuery,
    binds: &[Bind],
) -> Result<Vec<RequestRow>> {
    let mut n = 0;
    let mut list = |count: usize| {
        let out = (n + 1..=n + count)
            .map(|i| format!("${i}"))
            .collect::<Vec<_>>()
            .join(", ");
        n += count;
        out
    };
    let statuses = list(query.statuses.len());
    let plain = list(query.media_statuses.len());
    let four_k = list(query.media_statuses.len());
    let user = if query.requested_by.is_some() {
        n += 1;
        format!(r#" AND "requestedBy"."id" = ${n}"#)
    } else {
        String::new()
    };
    let kind = if query.media_type.is_some() {
        n += 1;
        format!(r#" AND "request"."type" = ${n}"#)
    } else {
        String::new()
    };
    let filter = format!(
        r#""request"."status" IN ({statuses}) AND (("request"."is4k" = false AND "media"."status" IN ({plain})) OR ("request"."is4k" = true AND "media"."status4k" IN ({four_k}))){user}{kind}"#
    );
    let ids = requests
        .iter()
        .map(|r| r.id.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let direction = if query.ascending { "ASC" } else { "DESC" };
    let sql = format!(
        r#"SELECT "request"."id"::bigint AS "id" FROM "media_request" "request" LEFT JOIN "media" "media" ON "media"."id"="request"."mediaId"  LEFT JOIN "season_request" "seasons" ON "seasons"."requestId"="request"."id"  LEFT JOIN "episode_request" "episodes" ON "episodes"."requestId"="request"."id"  LEFT JOIN "user" "modifiedBy" ON "modifiedBy"."id"="request"."modifiedById"  LEFT JOIN "user" "requestedBy" ON "requestedBy"."id"="request"."requestedById" WHERE ( {filter} ) AND ( "request"."id" IN ({ids}) ) ORDER BY "request"."updatedAt" {direction}"#
    );
    let mut q = sqlx::query(AssertSqlSafe(sql));
    for value in binds {
        q = bind_value(q, value);
    }
    let mut left: Vec<Option<RequestRow>> = requests.into_iter().map(Some).collect();
    let mut out = Vec::with_capacity(left.len());
    for row in q.fetch_all(pool).await? {
        let id: i64 = row.try_get("id")?;
        if let Some(r) = left
            .iter_mut()
            .find(|r| r.as_ref().is_some_and(|r| r.id == id))
            .and_then(Option::take)
        {
            out.push(r);
        }
    }
    out.extend(left.into_iter().flatten());
    Ok(out)
}

/// `TypeORM`'s second query of a page on Postgres (a `take` with joins):
/// the page's media again, ordered by the sort column alone, with their
/// eager seasons joined (`findAndCount` for `added`/`modified`; the
/// `mediaAdded` query builder has no seasons). Its row order is the order
/// of the media (ties in the sort column included) and of each media's
/// seasons, which Postgres's sort leaves as it likes.
async fn pg_eager_page(
    pool: &PgPool,
    media: Vec<MediaRow>,
    query: &MediaListQuery,
) -> Result<Vec<MediaRow>> {
    let ids = media
        .iter()
        .map(|m| m.id.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let n = query.statuses.len();
    let list = |first: usize| {
        (first..first + n)
            .map(|i| format!("${i}"))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let sql = if query.sort == MediaSort::MediaAddedAt {
        let (sub, filter) = if n == 0 {
            (String::new(), format!(r#""media"."id" IN ({ids})"#))
        } else {
            (
                format!(r#" AND "sub"."status" IN ({})"#, list(1)),
                format!(
                    r#"( "media"."status" IN ({}) ) AND ( "media"."id" IN ({ids}) )"#,
                    list(n + 1)
                ),
            )
        };
        format!(
            r#"SELECT "media"."id"::bigint AS "parent", NULL::bigint AS "id" FROM "media" "media" INNER JOIN (SELECT MAX("sub"."id") AS "maxid" FROM "media" "sub" WHERE "sub"."mediaAddedAt" IS NOT NULL{sub} GROUP BY "sub"."tmdbId", "sub"."mediaType") "dedup" ON "media"."id" = dedup.maxid WHERE {filter} ORDER BY "media"."mediaAddedAt" DESC"#
        )
    } else {
        let filter = match n {
            0 => format!(r#""Media"."id" IN ({ids})"#),
            1 => format!(r#"( (("Media"."status" = $1)) ) AND ( "Media"."id" IN ({ids}) )"#),
            _ => format!(
                r#"( (("Media"."status" IN ({}))) ) AND ( "Media"."id" IN ({ids}) )"#,
                list(1)
            ),
        };
        let order = if query.sort == MediaSort::UpdatedAt {
            r#""Media"."updatedAt" DESC"#
        } else {
            r#""Media"."id" DESC"#
        };
        format!(
            r#"SELECT "Media"."id"::bigint AS "parent", "Media__seasons"."id"::bigint AS "id", "Media__seasons"."seasonNumber"::bigint AS "seasonNumber", "Media__seasons"."status"::bigint AS "status", "Media__seasons"."status4k"::bigint AS "status4k", to_char("Media__seasons"."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt", to_char("Media__seasons"."updatedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt", "Media__seasons"."mediaId"::bigint AS "mediaId" FROM "media" "Media" LEFT JOIN "season" "Media__seasons" ON "Media__seasons"."mediaId"="Media"."id" WHERE {filter} ORDER BY {order}"#
        )
    };
    let mut q = sqlx::query(AssertSqlSafe(sql));
    let binds = if query.sort == MediaSort::MediaAddedAt {
        2
    } else {
        1
    };
    for status in query.statuses.iter().cycle().take(binds * n) {
        q = q.bind(status);
    }
    let rows = q.fetch_all(pool).await?;
    let mut left: Vec<Option<MediaRow>> = media.into_iter().map(Some).collect();
    let mut out: Vec<MediaRow> = Vec::with_capacity(left.len());
    for row in &rows {
        let parent: i64 = row.try_get("parent")?;
        if !out.iter().any(|m| m.id == parent) {
            if let Some(m) = left
                .iter_mut()
                .find(|m| m.as_ref().is_some_and(|m| m.id == parent))
                .and_then(Option::take)
            {
                out.push(m);
            }
        }
        if row.try_get::<Option<i64>, _>("id")?.is_some() {
            let season = season_from_row(row, false)?;
            if let Some(owner) = out.iter_mut().find(|m| m.id == parent) {
                owner.seasons.push(season);
            }
        }
    }
    out.extend(left.into_iter().flatten());
    Ok(out)
}

/// A `discover_slider` row.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DiscoverSliderRow {
    /// `id`.
    pub id: i64,
    /// `type`, a `DiscoverSliderType`.
    pub slider_type: i64,
    /// `order`.
    pub order: i64,
    /// `isBuiltIn`.
    pub is_built_in: bool,
    /// `enabled`.
    pub enabled: bool,
    /// `title`.
    pub title: Option<String>,
    /// `data`.
    pub data: Option<String>,
    /// `sort`.
    pub sort: Option<String>,
    /// `createdAt` as ISO 8601 UTC.
    pub created_at: Option<String>,
    /// `updatedAt` as ISO 8601 UTC.
    pub updated_at: Option<String>,
}

fn slider_from_row<R: Row>(r: &R, sqlite_dates: bool) -> Result<DiscoverSliderRow>
where
    for<'a> &'a str: sqlx::ColumnIndex<R>,
    for<'a> String: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
    for<'a> i64: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
    for<'a> bool: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
{
    let date = |name: &str| date_column(r, name, sqlite_dates);
    Ok(DiscoverSliderRow {
        id: r.try_get("id")?,
        slider_type: r.try_get("type")?,
        order: r.try_get("order")?,
        is_built_in: r.try_get("isBuiltIn")?,
        enabled: r.try_get("enabled")?,
        title: r.try_get("title")?,
        data: r.try_get("data")?,
        sort: r.try_get("sort")?,
        created_at: date("createdAt")?,
        updated_at: date("updatedAt")?,
    })
}

/// Read a profile row. `sqlite_dates` says the date columns are `SQLite`'s
/// `YYYY-MM-DD HH:MM:SS[.SSS]` text rather than ISO 8601 already.
fn profile_from_row<R: Row>(r: &R, sqlite_dates: bool) -> Result<UserProfile>
where
    for<'a> &'a str: sqlx::ColumnIndex<R>,
    for<'a> String: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
    for<'a> i64: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
    for<'a> bool: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
{
    let date = |name: &str| date_column(r, name, sqlite_dates);
    let settings = if r.try_get::<Option<i64>, _>("settingsId")?.is_some() {
        Some(UserSettingsRow {
            locale: r
                .try_get::<Option<String>, _>("locale")?
                .unwrap_or_default(),
            discover_region: r.try_get("discoverRegion")?,
            streaming_region: r.try_get("streamingRegion")?,
            original_language: r.try_get("originalLanguage")?,
            notification_types: r.try_get("notificationTypes")?,
            watchlist_sync_movies: r.try_get("watchlistSyncMovies")?,
            watchlist_sync_tv: r.try_get("watchlistSyncTv")?,
            auto_complete_skipped_episode_endings: r
                .try_get("autoCompleteSkippedEpisodeEndings")?,
            auto_complete_skipped_episode_threshold: r
                .try_get("autoCompleteSkippedEpisodeThreshold")?,
            watch_ahead_episode_count: r.try_get("watchAheadEpisodeCount")?,
            servarr_interventions_seen_at: date("servarrInterventionsSeenAt")?,
            discover_filter_defaults: r.try_get("discoverFilterDefaults")?,
        })
    } else {
        None
    };
    Ok(UserProfile {
        id: r.try_get("id")?,
        email: r.try_get("email")?,
        username: r.try_get("username")?,
        plex_username: r.try_get("plexUsername")?,
        jellyfin_username: r.try_get("jellyfinUsername")?,
        avatar: r
            .try_get::<Option<String>, _>("avatar")?
            .unwrap_or_default(),
        permissions: permissions_of(r.try_get("permissions")?),
        user_type: r.try_get::<Option<i64>, _>("userType")?.unwrap_or_default(),
        created_at: date("createdAt")?,
        updated_at: date("updatedAt")?,
        plex_id: r.try_get("plexId")?,
        request_count: r.try_get("requestCount")?,
        settings,
    })
}

/// A date column as ISO 8601 UTC text.
///
/// # Errors
///
/// Fails on database errors, or when a `SQLite` value isn't in the shape
/// `TypeORM` writes: Node would then parse it in the server's local
/// timezone, which this port doesn't reproduce.
fn date_column<R: Row>(r: &R, name: &str, sqlite_dates: bool) -> Result<Option<String>>
where
    for<'a> &'a str: sqlx::ColumnIndex<R>,
    for<'a> String: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
{
    let text: Option<String> = r.try_get(name)?;
    if !sqlite_dates {
        return Ok(text);
    }
    text.map(|t| {
        sqlite_datetime_to_iso(&t)
            .with_context(|| format!("{name}={t:?} is not a datetime TypeORM wrote"))
    })
    .transpose()
}

/// `TypeORM`'s `SQLite` hydration, as ISO 8601 with milliseconds.
///
/// `YYYY-MM-DD HH:MM[:SS[.SSS]]` (or the same with `T`) is read as UTC and
/// `Date.toISOString` always prints milliseconds. Other shapes are parsed
/// as local time by Node, so they are refused here.
#[must_use]
pub fn sqlite_datetime_to_iso(text: &str) -> Option<String> {
    let (date, time) = text.split_once([' ', 'T'])?;
    let digits = |s: &str, len: usize, sep: char| {
        s.len() == len && s.chars().all(|c| c.is_ascii_digit() || c == sep)
    };
    if !digits(date, 10, '-') {
        return None;
    }
    let (clock, millis) = time.split_once('.').map_or((time, "000"), |(c, m)| (c, m));
    if !digits(millis, 3, '.') {
        return None;
    }
    let clock = match clock.len() {
        5 if digits(clock, 5, ':') => format!("{clock}:00"),
        8 if digits(clock, 8, ':') => clock.to_owned(),
        _ => return None,
    };
    Some(format!("{date}T{clock}.{millis}Z"))
}

/// A user with everything `User.toPublicJSON` reads, as stored.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UserProfile {
    /// `user.id`.
    pub id: i64,
    /// `user.email`, before the lowercasing transformer.
    pub email: Option<String>,
    /// `user.username`.
    pub username: Option<String>,
    /// `user.plexUsername`.
    pub plex_username: Option<String>,
    /// `user.jellyfinUsername`.
    pub jellyfin_username: Option<String>,
    /// `user.avatar`.
    pub avatar: String,
    /// `user.permissions` as its bits (`ToInt32`).
    pub permissions: i64,
    /// `user.userType`.
    pub user_type: i64,
    /// `user.createdAt` as ISO 8601 UTC.
    pub created_at: Option<String>,
    /// `user.updatedAt` as ISO 8601 UTC.
    pub updated_at: Option<String>,
    /// `user.plexId`.
    pub plex_id: Option<i64>,
    /// Rows in `media_request` requested by the user.
    pub request_count: i64,
    /// The `user_settings` row, if any.
    pub settings: Option<UserSettingsRow>,
}

/// The `user_settings` columns `toPublicJSON` exposes, as stored.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UserSettingsRow {
    /// `locale`, never null.
    pub locale: String,
    /// `discoverRegion`.
    pub discover_region: Option<String>,
    /// `streamingRegion`.
    pub streaming_region: Option<String>,
    /// `originalLanguage`.
    pub original_language: Option<String>,
    /// `notificationTypes` JSON text.
    pub notification_types: Option<String>,
    /// `watchlistSyncMovies`.
    pub watchlist_sync_movies: Option<bool>,
    /// `watchlistSyncTv`.
    pub watchlist_sync_tv: Option<bool>,
    /// `autoCompleteSkippedEpisodeEndings`.
    pub auto_complete_skipped_episode_endings: Option<bool>,
    /// `autoCompleteSkippedEpisodeThreshold`.
    pub auto_complete_skipped_episode_threshold: Option<i64>,
    /// `watchAheadEpisodeCount`.
    pub watch_ahead_episode_count: Option<i64>,
    /// `servarrInterventionsSeenAt` as ISO 8601 UTC.
    pub servarr_interventions_seen_at: Option<String>,
    /// `discoverFilterDefaults` JSON text.
    pub discover_filter_defaults: Option<String>,
}

/// `User` plus its settings and request count, as `findOne` with
/// `relations: { settings: true }` loads it.
const PROFILE_SQLITE: &str = concat!(
    r#"SELECT u."id" AS "id", u."email" AS "email", u."username" AS "username",
    u."plexUsername" AS "plexUsername", u."jellyfinUsername" AS "jellyfinUsername", u."avatar" AS "avatar",
    u."permissions" AS "permissions", u."userType" AS "userType", u."plexId" AS "plexId",
    s."id" AS "settingsId", s."locale" AS "locale", s."discoverRegion" AS "discoverRegion",
    s."streamingRegion" AS "streamingRegion", s."originalLanguage" AS "originalLanguage",
    s."notificationTypes" AS "notificationTypes", s."watchlistSyncMovies" AS "watchlistSyncMovies",
    s."watchlistSyncTv" AS "watchlistSyncTv",
    s."autoCompleteSkippedEpisodeEndings" AS "autoCompleteSkippedEpisodeEndings",
    s."autoCompleteSkippedEpisodeThreshold" AS "autoCompleteSkippedEpisodeThreshold",
    s."watchAheadEpisodeCount" AS "watchAheadEpisodeCount",
    s."discoverFilterDefaults" AS "discoverFilterDefaults","#,
    r#" u."createdAt" AS "createdAt", u."updatedAt" AS "updatedAt",
    s."servarrInterventionsSeenAt" AS "servarrInterventionsSeenAt",
    (SELECT COUNT(*) FROM "media_request" r WHERE r."requestedById" = u."id") AS "requestCount"
    FROM "user" u LEFT JOIN "user_settings" s ON s."userId" = u."id" WHERE u."id" = ?1"#
);

/// The same for Postgres, with its casts and UTC date formatting.
const PROFILE_PG: &str = concat!(
    r#"SELECT u."id"::bigint AS "id", u."email" AS "email", u."username" AS "username",
    u."plexUsername" AS "plexUsername", u."jellyfinUsername" AS "jellyfinUsername", u."avatar" AS "avatar",
    u."permissions"::bigint AS "permissions", u."userType"::bigint AS "userType", u."plexId"::bigint AS "plexId",
    s."id"::bigint AS "settingsId", s."locale" AS "locale", s."discoverRegion" AS "discoverRegion",
    s."streamingRegion" AS "streamingRegion", s."originalLanguage" AS "originalLanguage",
    s."notificationTypes" AS "notificationTypes", s."watchlistSyncMovies" AS "watchlistSyncMovies",
    s."watchlistSyncTv" AS "watchlistSyncTv",
    s."autoCompleteSkippedEpisodeEndings" AS "autoCompleteSkippedEpisodeEndings",
    s."autoCompleteSkippedEpisodeThreshold"::bigint AS "autoCompleteSkippedEpisodeThreshold",
    s."watchAheadEpisodeCount"::bigint AS "watchAheadEpisodeCount",
    s."discoverFilterDefaults" AS "discoverFilterDefaults","#,
    r#" to_char(u."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
    to_char(u."updatedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
    to_char(s."servarrInterventionsSeenAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "servarrInterventionsSeenAt",
    (SELECT COUNT(*) FROM "media_request" r WHERE r."requestedById" = u."id")::bigint AS "requestCount"
    FROM "user" u LEFT JOIN "user_settings" s ON s."userId" = u."id" WHERE u."id" = $1"#
);

/// The start of a quota window; the end is a century later.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QuotaWindow {
    /// `days` calendar days before now, in the server's time zone.
    pub start: crate::clock::Utc,
}

impl QuotaWindow {
    /// `User.getQuota`'s window: `date.setDate(date.getDate() - days)` on
    /// `now` (Unix milliseconds) in the server's time zone, when `days` is
    /// set and not 0. Quota reads and request admission both count from it.
    #[must_use]
    pub fn days_before(now: i64, days: Option<i64>) -> Option<Self> {
        days.filter(|d| *d != 0).map(|d| Self {
            start: crate::clock::Utc::from_unix_millis(crate::clock::local_days_before(
                &chrono::Local,
                now,
                d,
            )),
        })
    }
}

/// Which linked accounts `GET /settings/*` counts in `user_settings`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkedAccounts {
    /// `countLinkedTraktAccounts`.
    Trakt,
    /// `countLinkedSimklAccounts`.
    Simkl,
    /// `countLinkedAnilistAccounts`.
    Anilist,
}

impl LinkedAccounts {
    const fn condition(self) -> &'static str {
        match self {
            Self::Trakt => r#""traktAccessToken" IS NOT NULL AND "traktRefreshToken" IS NOT NULL"#,
            Self::Simkl => r#""simklUserId" IS NOT NULL"#,
            Self::Anilist => r#""anilistAccessToken" IS NOT NULL"#,
        }
    }
}

/// The parts of a stored express-session that matter here.
#[derive(Debug, Clone, Default)]
pub struct SessionData {
    /// `userId` set at login, if it is a whole number.
    pub user_id: Option<i64>,
}

impl SessionData {
    fn parse(json: &str) -> Self {
        let v: serde_json::Value = serde_json::from_str(json).unwrap_or_default();
        Self {
            user_id: v.get("userId").and_then(serde_json::Value::as_i64),
        }
    }
}

fn env_u32(name: &str, default: u32) -> u32 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(default)
}

/// `NAME`, or the contents of the file named by `NAME_FILE`.
fn env_or_file(name: &str) -> Result<Option<Vec<u8>>> {
    if let Ok(v) = std::env::var(name) {
        if !v.is_empty() {
            return Ok(Some(v.into_bytes()));
        }
    }
    match std::env::var(format!("{name}_FILE")) {
        Ok(path) if !path.is_empty() => Ok(Some(
            std::fs::read(&path).with_context(|| format!("reading {name}_FILE={path}"))?,
        )),
        Ok(_) | Err(_) => Ok(None),
    }
}

fn postgres_options() -> Result<PgConnectOptions> {
    let mut o = PgConnectOptions::new()
        .database(&std::env::var("DB_NAME").unwrap_or_else(|_| String::from("seerr")));
    if let Ok(user) = std::env::var("DB_USER") {
        o = o.username(&user);
    }
    if let Ok(pass) = std::env::var("DB_PASS") {
        o = o.password(&pass);
    }
    match std::env::var("DB_SOCKET_PATH") {
        Ok(socket) if !socket.is_empty() => o = o.socket(socket),
        Ok(_) | Err(_) => {
            if let Ok(host) = std::env::var("DB_HOST") {
                o = o.host(&host);
            }
            o = o.port(
                std::env::var("DB_PORT")
                    .ok()
                    .and_then(|p| p.parse().ok())
                    .unwrap_or(5432),
            );
        }
    }
    let use_ssl = std::env::var("DB_USE_SSL").is_ok_and(|v| v.eq_ignore_ascii_case("true"));
    o = o.ssl_mode(postgres_ssl_mode(
        use_ssl,
        std::env::var("DB_SSL_REJECT_UNAUTHORIZED").ok().as_deref(),
    ));
    if use_ssl {
        if let Some(ca) = env_or_file("DB_SSL_CA")? {
            o = o.ssl_root_cert_from_pem(ca);
        }
        if let Some(cert) = env_or_file("DB_SSL_CERT")? {
            o = o.ssl_client_cert_from_pem(cert);
        }
        if let Some(key) = env_or_file("DB_SSL_KEY")? {
            o = o.ssl_client_key_from_pem(key);
        }
    }
    Ok(o)
}

/// Node disables TLS unless `DB_USE_SSL` is true. `SQLx` otherwise defaults
/// to Prefer, which attempts TLS even when the operator turned it off.
fn postgres_ssl_mode(enabled: bool, reject_unauthorized: Option<&str>) -> PgSslMode {
    if !enabled {
        return PgSslMode::Disable;
    }
    if reject_unauthorized
        .filter(|v| !v.is_empty())
        .is_none_or(|v| v.eq_ignore_ascii_case("true"))
    {
        PgSslMode::VerifyFull
    } else {
        PgSslMode::Require
    }
}

/// Every selectable `user` column, as `User.filter` exposes them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UserRecord {
    /// `id`.
    pub id: i64,
    /// `email`, before the lowercasing transformer.
    pub email: Option<String>,
    /// `plexUsername`.
    pub plex_username: Option<String>,
    /// `jellyfinUsername`.
    pub jellyfin_username: Option<String>,
    /// `username`.
    pub username: Option<String>,
    /// `recoveryLinkExpirationDate` as ISO 8601 UTC.
    pub recovery_link_expiration_date: Option<String>,
    /// `userType`.
    pub user_type: i64,
    /// `plexId`.
    pub plex_id: Option<i64>,
    /// `jellyfinUserId`.
    pub jellyfin_user_id: Option<String>,
    /// `permissions`.
    pub permissions: i64,
    /// `avatar`.
    pub avatar: String,
    /// `avatarETag`.
    pub avatar_etag: Option<String>,
    /// `avatarVersion`.
    pub avatar_version: Option<String>,
    /// `movieQuotaLimit`.
    pub movie_quota_limit: Option<i64>,
    /// `movieQuotaDays`.
    pub movie_quota_days: Option<i64>,
    /// `tvQuotaLimit`.
    pub tv_quota_limit: Option<i64>,
    /// `tvQuotaDays`.
    pub tv_quota_days: Option<i64>,
    /// `createdAt` as ISO 8601 UTC.
    pub created_at: Option<String>,
    /// `updatedAt` as ISO 8601 UTC.
    pub updated_at: Option<String>,
    /// Rows in `media_request` requested by the user.
    pub request_count: i64,
}

/// Every selectable `user_settings` column, in entity order.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UserSettingsRecord {
    /// `id`.
    pub id: i64,
    /// The columns `toPublicJSON` also reads.
    pub public: UserSettingsRow,
    /// `pgpKey`.
    pub pgp_key: Option<String>,
    /// `discordIds` JSON text.
    pub discord_ids: Option<String>,
    /// `pushbulletAccessToken`.
    pub pushbullet_access_token: Option<String>,
    /// `pushoverApplicationToken`.
    pub pushover_application_token: Option<String>,
    /// `pushoverUserKey`.
    pub pushover_user_key: Option<String>,
    /// `pushoverSound`.
    pub pushover_sound: Option<String>,
    /// `telegramChatId`.
    pub telegram_chat_id: Option<String>,
    /// `telegramMessageThreadId`.
    pub telegram_message_thread_id: Option<String>,
    /// `telegramSendSilently`.
    pub telegram_send_silently: Option<bool>,
    /// `traktUsername`.
    pub trakt_username: Option<String>,
    /// `traktUserId`.
    pub trakt_user_id: Option<String>,
    /// `anilistUsername`.
    pub anilist_username: Option<String>,
    /// `anilistUserId`.
    pub anilist_user_id: Option<String>,
    /// `simklUsername`.
    pub simkl_username: Option<String>,
    /// `simklUserId`.
    pub simkl_user_id: Option<String>,
    /// `mediaActionsTraktEnabled`.
    pub media_actions_trakt_enabled: Option<bool>,
    /// `mediaActionsAnilistEnabled`.
    pub media_actions_anilist_enabled: Option<bool>,
    /// `mediaActionsSimklEnabled`.
    pub media_actions_simkl_enabled: Option<bool>,
}

/// How `GET /user` orders its page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UserSort {
    /// `user.createdAt`.
    Created,
    /// `user.updatedAt`.
    Updated,
    /// Request count.
    Requests,
    /// Lower-cased display name.
    DisplayName,
    /// `user.userType`.
    UserType,
    /// Owner, admins, everyone else.
    Role,
    /// `user.id`.
    Id,
}

/// The `GET /user` query after validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserListQuery {
    /// Lower-cased `q`, matched with `LIKE %q%` on the name columns.
    pub search: Option<String>,
    /// `includeIds`.
    pub include_ids: Vec<i64>,
    /// Sort key.
    pub sort: UserSort,
    /// `true` for ascending.
    pub ascending: bool,
    /// Page size.
    pub take: i64,
    /// Offset.
    pub skip: i64,
}

const USER_COLUMNS_SQLITE: &str = r#"u."id", u."email", u."plexUsername", u."jellyfinUsername", u."username",
    u."recoveryLinkExpirationDate", u."userType", u."plexId", u."jellyfinUserId", u."permissions", u."avatar",
    u."avatarETag", u."avatarVersion", u."movieQuotaLimit", u."movieQuotaDays", u."tvQuotaLimit", u."tvQuotaDays",
    u."createdAt", u."updatedAt",
    (SELECT COUNT(*) FROM "media_request" r WHERE r."requestedById" = u."id") AS "requestCount""#;

const USER_COLUMNS_PG: &str = r#"u."id"::bigint AS "id", u."email", u."plexUsername", u."jellyfinUsername", u."username",
    to_char(u."recoveryLinkExpirationDate" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recoveryLinkExpirationDate",
    u."userType"::bigint AS "userType", u."plexId"::bigint AS "plexId", u."jellyfinUserId", u."permissions"::bigint AS "permissions", u."avatar",
    u."avatarETag", u."avatarVersion", u."movieQuotaLimit"::bigint AS "movieQuotaLimit", u."movieQuotaDays"::bigint AS "movieQuotaDays",
    u."tvQuotaLimit"::bigint AS "tvQuotaLimit", u."tvQuotaDays"::bigint AS "tvQuotaDays",
    to_char(u."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
    to_char(u."updatedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
    (SELECT COUNT(*) FROM "media_request" r WHERE r."requestedById" = u."id")::bigint AS "requestCount""#;

const SETTINGS_COLUMNS_SQLITE: &str = r#"s."id" AS "settingsId", s."locale", s."discoverRegion", s."streamingRegion", s."originalLanguage",
    s."pgpKey", s."discordIds", s."pushbulletAccessToken", s."pushoverApplicationToken", s."pushoverUserKey", s."pushoverSound",
    s."telegramChatId", s."telegramMessageThreadId", s."telegramSendSilently", s."watchlistSyncMovies", s."watchlistSyncTv",
    s."autoCompleteSkippedEpisodeEndings", s."autoCompleteSkippedEpisodeThreshold", s."watchAheadEpisodeCount",
    s."servarrInterventionsSeenAt", s."traktUsername", s."traktUserId", s."anilistUsername", s."anilistUserId",
    s."simklUsername", s."simklUserId", s."mediaActionsTraktEnabled", s."mediaActionsAnilistEnabled", s."mediaActionsSimklEnabled",
    s."discoverFilterDefaults", s."notificationTypes""#;

const SETTINGS_COLUMNS_PG: &str = r#"s."id"::bigint AS "settingsId", s."locale", s."discoverRegion", s."streamingRegion", s."originalLanguage",
    s."pgpKey", s."discordIds", s."pushbulletAccessToken", s."pushoverApplicationToken", s."pushoverUserKey", s."pushoverSound",
    s."telegramChatId", s."telegramMessageThreadId", s."telegramSendSilently", s."watchlistSyncMovies", s."watchlistSyncTv",
    s."autoCompleteSkippedEpisodeEndings", s."autoCompleteSkippedEpisodeThreshold"::bigint AS "autoCompleteSkippedEpisodeThreshold",
    s."watchAheadEpisodeCount"::bigint AS "watchAheadEpisodeCount",
    to_char(s."servarrInterventionsSeenAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "servarrInterventionsSeenAt",
    s."traktUsername", s."traktUserId", s."anilistUsername", s."anilistUserId",
    s."simklUsername", s."simklUserId", s."mediaActionsTraktEnabled", s."mediaActionsAnilistEnabled", s."mediaActionsSimklEnabled",
    s."discoverFilterDefaults", s."notificationTypes""#;

/// The `ORDER BY` key for a sort, written as `createQueryBuilder` does.
const fn user_sort_key(sort: UserSort) -> &'static str {
    match sort {
        UserSort::Created => r#"u."createdAt""#,
        UserSort::Updated => r#"u."updatedAt""#,
        UserSort::UserType => r#"u."userType""#,
        UserSort::Id => r#"u."id""#,
        UserSort::Requests => {
            r#"(SELECT COUNT(r."id") FROM "media_request" r WHERE r."requestedById" = u."id")"#
        }
        UserSort::DisplayName => {
            r#"CASE WHEN (u."username" IS NULL OR u."username" = '') THEN (
                CASE WHEN (u."plexUsername" IS NULL OR u."plexUsername" = '') THEN (
                  CASE WHEN (u."jellyfinUsername" IS NULL OR u."jellyfinUsername" = '') THEN
                    u."email"
                  ELSE
                    LOWER(u."jellyfinUsername")
                  END)
                ELSE
                  LOWER(u."plexUsername")
                END)
              ELSE
                LOWER(u."username")
              END"#
        }
        UserSort::Role => {
            r#"CASE WHEN u."id" = 1 THEN 0 WHEN (u."permissions" & 2) != 0 THEN 1 ELSE 2 END"#
        }
    }
}

/// `WHERE` for `GET /user`, with the search as parameter 1 and the ids
/// following it. `ph` writes a placeholder for a parameter number. All SQL
/// text here is built from constants; user input only ever travels as a
/// bound parameter, which is what `AssertSqlSafe` asserts at the call sites.
///
/// Node writes the search as a bare `OR` chain and appends the id list with
/// `AND`, so the ids only narrow the last `OR` branch. That precedence is
/// kept on purpose: the answer has to match.
fn user_list_where(query: &UserListQuery, ph: fn(usize) -> String) -> String {
    let mut parts = Vec::new();
    if query.search.is_some() {
        let p = ph(1);
        parts.push(format!(
            r#"LOWER(u."username") LIKE {p} OR LOWER(u."email") LIKE {p} OR LOWER(u."plexUsername") LIKE {p} OR LOWER(u."jellyfinUsername") LIKE {p}"#
        ));
    }
    if !query.include_ids.is_empty() {
        let first = if query.search.is_some() { 2 } else { 1 };
        let list: Vec<String> = (0..query.include_ids.len())
            .map(|i| ph(first + i))
            .collect();
        parts.push(format!(r#"u."id" IN ({})"#, list.join(", ")));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", parts.join(" AND "))
    }
}

fn sqlite_ph(n: usize) -> String {
    format!("?{n}")
}

fn pg_ph(n: usize) -> String {
    format!("${n}")
}

/// A nullable integer column.
fn hydrated_int<R: Row>(r: &R, column: &str) -> Result<Option<i64>>
where
    for<'a> &'a str: sqlx::ColumnIndex<R>,
    for<'a> i64: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
{
    Ok(r.try_get::<Option<i64>, _>(column)?)
}

fn user_from_row<R: Row>(r: &R, sqlite_dates: bool) -> Result<UserRecord>
where
    for<'a> &'a str: sqlx::ColumnIndex<R>,
    for<'a> String: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
    for<'a> i64: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
{
    let date = |name: &str| date_column(r, name, sqlite_dates);
    Ok(UserRecord {
        id: r.try_get("id")?,
        email: r.try_get("email")?,
        plex_username: r.try_get("plexUsername")?,
        jellyfin_username: r.try_get("jellyfinUsername")?,
        username: r.try_get("username")?,
        recovery_link_expiration_date: date("recoveryLinkExpirationDate")?,
        user_type: r.try_get::<Option<i64>, _>("userType")?.unwrap_or_default(),
        plex_id: r.try_get("plexId")?,
        jellyfin_user_id: r.try_get("jellyfinUserId")?,
        permissions: permissions_of(r.try_get("permissions")?),
        avatar: r
            .try_get::<Option<String>, _>("avatar")?
            .unwrap_or_default(),
        avatar_etag: r.try_get("avatarETag")?,
        avatar_version: r.try_get("avatarVersion")?,
        movie_quota_limit: hydrated_int(r, "movieQuotaLimit")?,
        movie_quota_days: hydrated_int(r, "movieQuotaDays")?,
        tv_quota_limit: hydrated_int(r, "tvQuotaLimit")?,
        tv_quota_days: hydrated_int(r, "tvQuotaDays")?,
        created_at: date("createdAt")?,
        updated_at: date("updatedAt")?,
        request_count: r.try_get("requestCount")?,
    })
}

fn settings_from_row<R: Row>(r: &R, sqlite_dates: bool) -> Result<Option<UserSettingsRecord>>
where
    for<'a> &'a str: sqlx::ColumnIndex<R>,
    for<'a> String: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
    for<'a> i64: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
    for<'a> bool: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
{
    let Some(id) = r.try_get::<Option<i64>, _>("settingsId")? else {
        return Ok(None);
    };
    Ok(Some(UserSettingsRecord {
        id,
        public: UserSettingsRow {
            locale: r
                .try_get::<Option<String>, _>("locale")?
                .unwrap_or_default(),
            discover_region: r.try_get("discoverRegion")?,
            streaming_region: r.try_get("streamingRegion")?,
            original_language: r.try_get("originalLanguage")?,
            notification_types: r.try_get("notificationTypes")?,
            watchlist_sync_movies: r.try_get("watchlistSyncMovies")?,
            watchlist_sync_tv: r.try_get("watchlistSyncTv")?,
            auto_complete_skipped_episode_endings: r
                .try_get("autoCompleteSkippedEpisodeEndings")?,
            auto_complete_skipped_episode_threshold: r
                .try_get("autoCompleteSkippedEpisodeThreshold")?,
            watch_ahead_episode_count: r.try_get("watchAheadEpisodeCount")?,
            servarr_interventions_seen_at: date_column(
                r,
                "servarrInterventionsSeenAt",
                sqlite_dates,
            )?,
            discover_filter_defaults: r.try_get("discoverFilterDefaults")?,
        },
        pgp_key: r.try_get("pgpKey")?,
        discord_ids: r.try_get("discordIds")?,
        pushbullet_access_token: r.try_get("pushbulletAccessToken")?,
        pushover_application_token: r.try_get("pushoverApplicationToken")?,
        pushover_user_key: r.try_get("pushoverUserKey")?,
        pushover_sound: r.try_get("pushoverSound")?,
        telegram_chat_id: r.try_get("telegramChatId")?,
        telegram_message_thread_id: r.try_get("telegramMessageThreadId")?,
        telegram_send_silently: r.try_get("telegramSendSilently")?,
        trakt_username: r.try_get("traktUsername")?,
        trakt_user_id: r.try_get("traktUserId")?,
        anilist_username: r.try_get("anilistUsername")?,
        anilist_user_id: r.try_get("anilistUserId")?,
        simkl_username: r.try_get("simklUsername")?,
        simkl_user_id: r.try_get("simklUserId")?,
        media_actions_trakt_enabled: r.try_get("mediaActionsTraktEnabled")?,
        media_actions_anilist_enabled: r.try_get("mediaActionsAnilistEnabled")?,
        media_actions_simkl_enabled: r.try_get("mediaActionsSimklEnabled")?,
    }))
}

/// An `override_rule` row, in entity order.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OverrideRuleRow {
    /// `id`.
    pub id: i64,
    /// `radarrServiceId`.
    pub radarr_service_id: Option<i64>,
    /// `sonarrServiceId`.
    pub sonarr_service_id: Option<i64>,
    /// `users`.
    pub users: Option<String>,
    /// `genre`.
    pub genre: Option<String>,
    /// `language`.
    pub language: Option<String>,
    /// `keywords`.
    pub keywords: Option<String>,
    /// `profileId`.
    pub profile_id: Option<i64>,
    /// `rootFolder`.
    pub root_folder: Option<String>,
    /// `tags`.
    pub tags: Option<String>,
    /// `createdAt` as ISO 8601 UTC.
    pub created_at: Option<String>,
    /// `updatedAt` as ISO 8601 UTC.
    pub updated_at: Option<String>,
}

/// A `blocklist` row with its user, as the list route loads it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BlocklistRow {
    /// `id`.
    pub id: i64,
    /// `mediaType`.
    pub media_type: String,
    /// `title`.
    pub title: Option<String>,
    /// `tmdbId`.
    pub tmdb_id: i64,
    /// `blocklistedTags`.
    pub blocklisted_tags: Option<String>,
    /// `createdAt` as ISO 8601 UTC.
    pub created_at: Option<String>,
    /// The user who added it, if any.
    pub user: Option<UserRecord>,
}

/// `GET /blocklist`'s query after validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlocklistQuery {
    /// `blocklist.title like %search%`.
    pub search: Option<String>,
    /// `Some(true)` for rows with tags, `Some(false)` for manual ones.
    pub tagged: Option<bool>,
    /// Page size.
    pub take: i64,
    /// Offset.
    pub skip: i64,
}

fn override_rule_from_row<R: Row>(r: &R, sqlite_dates: bool) -> Result<OverrideRuleRow>
where
    for<'a> &'a str: sqlx::ColumnIndex<R>,
    for<'a> String: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
    for<'a> i64: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
{
    Ok(OverrideRuleRow {
        id: r.try_get("id")?,
        radarr_service_id: r.try_get("radarrServiceId")?,
        sonarr_service_id: r.try_get("sonarrServiceId")?,
        users: r.try_get("users")?,
        genre: r.try_get("genre")?,
        language: r.try_get("language")?,
        keywords: r.try_get("keywords")?,
        profile_id: r.try_get("profileId")?,
        root_folder: r.try_get("rootFolder")?,
        tags: r.try_get("tags")?,
        created_at: date_column(r, "createdAt", sqlite_dates)?,
        updated_at: date_column(r, "updatedAt", sqlite_dates)?,
    })
}

fn blocklist_from_row<R: Row>(r: &R, sqlite_dates: bool) -> Result<BlocklistRow>
where
    for<'a> &'a str: sqlx::ColumnIndex<R>,
    for<'a> String: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
    for<'a> i64: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
{
    let user = if r.try_get::<Option<i64>, _>("id")?.is_some() {
        Some(user_from_row(r, sqlite_dates)?)
    } else {
        None
    };
    Ok(BlocklistRow {
        id: r.try_get("b_id")?,
        media_type: r
            .try_get::<Option<String>, _>("b_mediaType")?
            .unwrap_or_default(),
        title: r.try_get("b_title")?,
        tmdb_id: hydrated_int(r, "b_tmdbId")?.unwrap_or_default(),
        blocklisted_tags: r.try_get("b_blocklistedTags")?,
        created_at: date_column(r, "b_createdAt", sqlite_dates)?,
        user,
    })
}

/// How `GET /media` pages, filters and sorts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaListQuery {
    /// `media.status` values to keep; empty keeps every row.
    pub statuses: Vec<i64>,
    /// Sort column.
    pub sort: MediaSort,
    /// Page size.
    pub take: i64,
    /// Rows to skip.
    pub skip: i64,
}

/// The `sort` query parameter of `GET /media`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaSort {
    /// `added` (the default): by id.
    Id,
    /// `modified`: by `updatedAt`.
    UpdatedAt,
    /// `mediaAdded`: by `mediaAddedAt`, one row per title.
    MediaAddedAt,
}

/// A `season` row.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SeasonRow {
    /// `id`.
    pub id: i64,
    /// `seasonNumber`.
    pub season_number: i64,
    /// `status`.
    pub status: i64,
    /// `status4k`.
    pub status4k: i64,
    /// `createdAt` as ISO 8601 UTC.
    pub created_at: Option<String>,
    /// `updatedAt` as ISO 8601 UTC.
    pub updated_at: Option<String>,
    /// `mediaId`.
    pub media_id: Option<i64>,
}

/// A `media` row with its seasons.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MediaRow {
    /// `id`.
    pub id: i64,
    /// `mediaType`: `movie` or `tv`.
    pub media_type: String,
    /// `tmdbId`.
    pub tmdb_id: i64,
    /// `tvdbId`.
    pub tvdb_id: Option<i64>,
    /// `imdbId`.
    pub imdb_id: Option<String>,
    /// `status`, a `MediaStatus`.
    pub status: i64,
    /// `status4k`.
    pub status4k: i64,
    /// `createdAt` as ISO 8601 UTC.
    pub created_at: Option<String>,
    /// `updatedAt` as ISO 8601 UTC.
    pub updated_at: Option<String>,
    /// `lastSeasonChange` as ISO 8601 UTC.
    pub last_season_change: Option<String>,
    /// `mediaAddedAt` as ISO 8601 UTC.
    pub media_added_at: Option<String>,
    /// `serviceId`: the Radarr or Sonarr server.
    pub service_id: Option<i64>,
    /// `serviceId4k`.
    pub service_id4k: Option<i64>,
    /// `externalServiceId`: the id on that server.
    pub external_service_id: Option<i64>,
    /// `externalServiceId4k`.
    pub external_service_id4k: Option<i64>,
    /// `externalServiceSlug`.
    pub external_service_slug: Option<String>,
    /// `externalServiceSlug4k`.
    pub external_service_slug4k: Option<String>,
    /// `ratingKey` (Plex).
    pub rating_key: Option<String>,
    /// `ratingKey4k`.
    pub rating_key4k: Option<String>,
    /// `jellyfinMediaId`.
    pub jellyfin_media_id: Option<String>,
    /// `jellyfinMediaId4k`.
    pub jellyfin_media_id4k: Option<String>,
    /// The eager `seasons` relation, by id.
    pub seasons: Vec<SeasonRow>,
}

const MEDIA_COLUMNS_SQLITE: &str = r#"m."id", m."mediaType", m."tmdbId", m."tvdbId", m."imdbId", m."status", m."status4k",
    m."createdAt", m."updatedAt", m."lastSeasonChange", m."mediaAddedAt", m."serviceId", m."serviceId4k",
    m."externalServiceId", m."externalServiceId4k", m."externalServiceSlug", m."externalServiceSlug4k",
    m."ratingKey", m."ratingKey4k", m."jellyfinMediaId", m."jellyfinMediaId4k""#;

const MEDIA_COLUMNS_PG: &str = r#"m."id"::bigint AS "id", m."mediaType", m."tmdbId"::bigint AS "tmdbId", m."tvdbId"::bigint AS "tvdbId", m."imdbId",
    m."status"::bigint AS "status", m."status4k"::bigint AS "status4k",
    to_char(m."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
    to_char(m."updatedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
    to_char(m."lastSeasonChange" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastSeasonChange",
    to_char(m."mediaAddedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "mediaAddedAt",
    m."serviceId"::bigint AS "serviceId", m."serviceId4k"::bigint AS "serviceId4k",
    m."externalServiceId"::bigint AS "externalServiceId", m."externalServiceId4k"::bigint AS "externalServiceId4k",
    m."externalServiceSlug", m."externalServiceSlug4k", m."ratingKey", m."ratingKey4k", m."jellyfinMediaId", m."jellyfinMediaId4k""#;

/// The page and count statements of `media_list`, with the status
/// placeholders they expect bound before `take` and `skip`.
struct MediaSql {
    page: String,
    count: String,
    status_binds: usize,
}

impl MediaSql {
    fn build(sqlite: bool, query: &MediaListQuery) -> Self {
        let ph = |n: usize| if sqlite { sqlite_ph(n) } else { pg_ph(n) };
        let n = query.statuses.len();
        let in_list = |first: usize| (0..n).map(|i| ph(first + i)).collect::<Vec<_>>().join(", ");
        let (from, status_binds) = match query.sort {
            MediaSort::MediaAddedAt => {
                let sub_filter = if n == 0 {
                    String::new()
                } else {
                    format!(r#" AND s."status" IN ({})"#, in_list(1))
                };
                let filter = if n == 0 {
                    String::new()
                } else {
                    format!(r#" WHERE m."status" IN ({})"#, in_list(n + 1))
                };
                (
                    format!(
                        r#"FROM "media" m INNER JOIN (SELECT MAX(s."id") AS "maxid" FROM "media" s WHERE s."mediaAddedAt" IS NOT NULL{sub_filter} GROUP BY s."tmdbId", s."mediaType") d ON m."id" = d."maxid"{filter}"#
                    ),
                    2 * n,
                )
            }
            MediaSort::Id | MediaSort::UpdatedAt => {
                let filter = if n == 0 {
                    String::new()
                } else {
                    format!(r#" WHERE m."status" IN ({})"#, in_list(1))
                };
                (format!(r#"FROM "media" m{filter}"#), n)
            }
        };
        let order = match query.sort {
            MediaSort::Id => r#"m."id" DESC"#,
            MediaSort::UpdatedAt => r#"m."updatedAt" DESC, m."id" ASC"#,
            MediaSort::MediaAddedAt => r#"m."mediaAddedAt" DESC, m."id" ASC"#,
        };
        let columns = if sqlite {
            MEDIA_COLUMNS_SQLITE
        } else {
            MEDIA_COLUMNS_PG
        };
        Self {
            page: format!(
                "SELECT {columns} {from} ORDER BY {order} LIMIT {} OFFSET {}",
                ph(status_binds + 1),
                ph(status_binds + 2)
            ),
            count: format!("SELECT COUNT(*) {from}"),
            status_binds,
        }
    }
}

fn media_from_row<R: Row>(r: &R, sqlite_dates: bool) -> Result<MediaRow>
where
    for<'a> &'a str: sqlx::ColumnIndex<R>,
    for<'a> String: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
    for<'a> i64: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
{
    let date = |name: &str| date_column(r, name, sqlite_dates);
    Ok(MediaRow {
        id: r.try_get("id")?,
        media_type: r.try_get("mediaType")?,
        tmdb_id: r.try_get("tmdbId")?,
        tvdb_id: r.try_get("tvdbId")?,
        imdb_id: r.try_get("imdbId")?,
        status: r.try_get("status")?,
        status4k: r.try_get("status4k")?,
        created_at: date("createdAt")?,
        updated_at: date("updatedAt")?,
        last_season_change: date("lastSeasonChange")?,
        media_added_at: date("mediaAddedAt")?,
        service_id: r.try_get("serviceId")?,
        service_id4k: r.try_get("serviceId4k")?,
        external_service_id: r.try_get("externalServiceId")?,
        external_service_id4k: r.try_get("externalServiceId4k")?,
        external_service_slug: r.try_get("externalServiceSlug")?,
        external_service_slug4k: r.try_get("externalServiceSlug4k")?,
        rating_key: r.try_get("ratingKey")?,
        rating_key4k: r.try_get("ratingKey4k")?,
        jellyfin_media_id: r.try_get("jellyfinMediaId")?,
        jellyfin_media_id4k: r.try_get("jellyfinMediaId4k")?,
        seasons: Vec::new(),
    })
}

fn season_from_row<R: Row>(r: &R, sqlite_dates: bool) -> Result<SeasonRow>
where
    for<'a> &'a str: sqlx::ColumnIndex<R>,
    for<'a> String: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
    for<'a> i64: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
{
    let date = |name: &str| date_column(r, name, sqlite_dates);
    Ok(SeasonRow {
        id: r.try_get("id")?,
        season_number: r.try_get("seasonNumber")?,
        status: r.try_get("status")?,
        status4k: r.try_get("status4k")?,
        created_at: date("createdAt")?,
        updated_at: date("updatedAt")?,
        media_id: r.try_get("mediaId")?,
    })
}

/// A `permissions` column (0 when null).
fn permissions_of(value: Option<i64>) -> i64 {
    value.unwrap_or_default()
}

/// The message for a failed query: the database's own when it refused
/// the statement, else the error with its causes.
#[must_use]
pub fn failure_message(error: &anyhow::Error) -> String {
    error
        .chain()
        .find_map(|e| e.downcast_ref::<sqlx::Error>())
        .and_then(sqlx::Error::as_database_error)
        .map_or_else(
            || format!("{error:#}"),
            |e| format!("Database error: {}", e.message()),
        )
}

/// Whether a failed query broke a unique constraint.
#[must_use]
pub fn is_unique_violation(error: &anyhow::Error) -> bool {
    error
        .chain()
        .find_map(|e| e.downcast_ref::<sqlx::Error>())
        .and_then(sqlx::Error::as_database_error)
        .is_some_and(sqlx::error::DatabaseError::is_unique_violation)
}

/// A bound value of a request query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Bind {
    /// An integer.
    Int(i64),
    /// Text.
    Text(String),
    /// An integer or NULL.
    OptInt(Option<i64>),
    /// Text or NULL.
    OptText(Option<String>),
    /// A boolean.
    Bool(bool),
}

pub(crate) fn bind_value<'q, DB: sqlx::Database>(
    q: sqlx::query::Query<'q, DB, <DB as sqlx::Database>::Arguments>,
    value: &'q Bind,
) -> sqlx::query::Query<'q, DB, <DB as sqlx::Database>::Arguments>
where
    i64: sqlx::Encode<'q, DB> + sqlx::Type<DB>,
    String: sqlx::Encode<'q, DB> + sqlx::Type<DB>,
    Option<i64>: sqlx::Encode<'q, DB> + sqlx::Type<DB>,
    Option<String>: sqlx::Encode<'q, DB> + sqlx::Type<DB>,
    bool: sqlx::Encode<'q, DB> + sqlx::Type<DB>,
{
    match value {
        Bind::Int(n) => q.bind(*n),
        Bind::Text(t) => q.bind(t.clone()),
        Bind::OptInt(n) => q.bind(*n),
        Bind::OptText(t) => q.bind(t.clone()),
        Bind::Bool(b) => q.bind(*b),
    }
}

fn bind_scalar<'q, DB: sqlx::Database>(
    q: sqlx::query::QueryScalar<'q, DB, i64, <DB as sqlx::Database>::Arguments>,
    value: &'q Bind,
) -> sqlx::query::QueryScalar<'q, DB, i64, <DB as sqlx::Database>::Arguments>
where
    i64: sqlx::Encode<'q, DB> + sqlx::Type<DB>,
    String: sqlx::Encode<'q, DB> + sqlx::Type<DB>,
    Option<i64>: sqlx::Encode<'q, DB> + sqlx::Type<DB>,
    Option<String>: sqlx::Encode<'q, DB> + sqlx::Type<DB>,
    bool: sqlx::Encode<'q, DB> + sqlx::Type<DB>,
{
    match value {
        Bind::Int(n) => q.bind(*n),
        Bind::Text(t) => q.bind(t.clone()),
        Bind::OptInt(n) => q.bind(*n),
        Bind::OptText(t) => q.bind(t.clone()),
        Bind::Bool(b) => q.bind(*b),
    }
}

/// How `GET /request` pages, filters and sorts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestListQuery {
    /// `request.status` values to keep.
    pub statuses: Vec<i64>,
    /// `media.status` (or `status4k` for 4K requests) values to keep.
    pub media_statuses: Vec<i64>,
    /// Sort column.
    pub sort: RequestSort,
    /// `sortDirection=asc`.
    pub ascending: bool,
    /// Only this user's requests.
    pub requested_by: Option<i64>,
    /// Only this `request.type`.
    pub media_type: Option<String>,
    /// Page size.
    pub take: i64,
    /// Rows to skip.
    pub skip: i64,
}

/// The `sort` query parameter of `GET /request`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestSort {
    /// `added` (the default): by id.
    Id,
    /// `modified`: by `updatedAt`.
    UpdatedAt,
}

/// The page and count statements of `request_list`, with the values to
/// bind before `take` and `skip`.
struct RequestSql {
    page: String,
    count: String,
    binds: Vec<Bind>,
}

impl RequestSql {
    fn build(sqlite: bool, query: &RequestListQuery) -> Self {
        let mut binds = Vec::new();
        let mut ph = |value: Bind| {
            binds.push(value);
            if sqlite {
                sqlite_ph(binds.len())
            } else {
                pg_ph(binds.len())
            }
        };
        let mut list = |values: &[i64]| {
            values
                .iter()
                .map(|v| ph(Bind::Int(*v)))
                .collect::<Vec<_>>()
                .join(", ")
        };
        let statuses = list(&query.statuses);
        let plain = list(&query.media_statuses);
        let four_k = list(&query.media_statuses);
        let user_clause = query
            .requested_by
            .map(|user| format!(r#" AND rb."id" = {}"#, ph(Bind::Int(user))))
            .unwrap_or_default();
        let type_clause = query
            .media_type
            .as_ref()
            .map(|kind| format!(r#" AND r."type" = {}"#, ph(Bind::Text(kind.clone()))))
            .unwrap_or_default();
        let from = format!(
            r#"FROM "media_request" r LEFT JOIN "media" m ON m."id" = r."mediaId" LEFT JOIN "user" rb ON rb."id" = r."requestedById" WHERE r."status" IN ({statuses}) AND ((r."is4k" = false AND m."status" IN ({plain})) OR (r."is4k" = true AND m."status4k" IN ({four_k}))){user_clause}{type_clause}"#
        );
        let direction = if query.ascending { "ASC" } else { "DESC" };
        let order = match query.sort {
            RequestSort::Id => format!(r#"r."id" {direction}"#),
            RequestSort::UpdatedAt => format!(r#"r."updatedAt" {direction}, r."id" ASC"#),
        };
        let columns = if sqlite {
            REQUEST_COLUMNS_SQLITE
        } else {
            REQUEST_COLUMNS_PG
        };
        let n = binds.len();
        let (take, skip) = if sqlite {
            (sqlite_ph(n + 1), sqlite_ph(n + 2))
        } else {
            (pg_ph(n + 1), pg_ph(n + 2))
        };
        Self {
            page: format!("SELECT {columns} {from} ORDER BY {order} LIMIT {take} OFFSET {skip}"),
            count: format!("SELECT COUNT(*) {from}"),
            binds,
        }
    }
}

/// `GET /request/count`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RequestCounts {
    /// Every request with a media row.
    pub total: i64,
    /// `type = movie`.
    pub movie: i64,
    /// `type = tv`.
    pub tv: i64,
    /// `status = PENDING`.
    pub pending: i64,
    /// `status = APPROVED`.
    pub approved: i64,
    /// `status = DECLINED`.
    pub declined: i64,
    /// Approved and the media isn't available yet.
    pub processing: i64,
    /// Approved and the media is available.
    pub available: i64,
    /// `status = COMPLETED`.
    pub completed: i64,
}

/// A row with named `i64` columns, so the counts can be read from either
/// database's row type.
trait RequestCountRow {
    fn count(&self, name: &str) -> Result<i64>;
}

impl RequestCountRow for sqlx::sqlite::SqliteRow {
    fn count(&self, name: &str) -> Result<i64> {
        Ok(self.try_get(name)?)
    }
}

impl RequestCountRow for sqlx::postgres::PgRow {
    fn count(&self, name: &str) -> Result<i64> {
        Ok(self.try_get(name)?)
    }
}

/// A `season_request` row.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SeasonRequestRow {
    /// `id`.
    pub id: i64,
    /// `seasonNumber`.
    pub season_number: i64,
    /// `status`, a `MediaRequestStatus`.
    pub status: i64,
    /// `createdAt` as ISO 8601 UTC.
    pub created_at: Option<String>,
    /// `updatedAt` as ISO 8601 UTC.
    pub updated_at: Option<String>,
    /// `requestId`.
    pub request_id: Option<i64>,
}

/// An `episode_request` row.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EpisodeRequestRow {
    /// `id`.
    pub id: i64,
    /// `tvdbId`.
    pub tvdb_id: i64,
    /// `seasonNumber`.
    pub season_number: i64,
    /// `episodeNumber`.
    pub episode_number: i64,
    /// `title`.
    pub title: Option<String>,
    /// `airDate`.
    pub air_date: Option<String>,
    /// `status`.
    pub status: i64,
    /// `searchTriggeredAt` as ISO 8601 UTC.
    pub search_triggered_at: Option<String>,
    /// `createdAt` as ISO 8601 UTC.
    pub created_at: Option<String>,
    /// `updatedAt` as ISO 8601 UTC.
    pub updated_at: Option<String>,
    /// `requestId`.
    pub request_id: Option<i64>,
}

/// A `media_request` row with its children; the related media and users
/// are loaded separately.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RequestRow {
    /// `id`.
    pub id: i64,
    /// `status`, a `MediaRequestStatus`.
    pub status: i64,
    /// `createdAt` as ISO 8601 UTC.
    pub created_at: Option<String>,
    /// `updatedAt` as ISO 8601 UTC.
    pub updated_at: Option<String>,
    /// `type`: `movie` or `tv`.
    pub request_type: String,
    /// `episodeSelectionType`.
    pub episode_selection_type: Option<String>,
    /// `episodeStartTvdbId`.
    pub episode_start_tvdb_id: Option<i64>,
    /// `episodeEndTvdbId`.
    pub episode_end_tvdb_id: Option<i64>,
    /// `watchAheadCount`.
    pub watch_ahead_count: Option<i64>,
    /// `ongoingEpisodeRequestKey`.
    pub ongoing_episode_request_key: Option<String>,
    /// `tvQuotaUnits`.
    pub tv_quota_units: i64,
    /// `is4k`.
    pub is4k: bool,
    /// `serverId`.
    pub server_id: Option<i64>,
    /// `profileId`.
    pub profile_id: Option<i64>,
    /// `rootFolder`.
    pub root_folder: Option<String>,
    /// `languageProfileId`.
    pub language_profile_id: Option<i64>,
    /// `tags` as stored, before the column transformer.
    pub tags: Option<String>,
    /// `isAutoRequest`.
    pub is_auto_request: bool,
    /// `ignoreQuota`.
    pub ignore_quota: bool,
    /// `mediaId`.
    pub media_id: Option<i64>,
    /// `requestedById`.
    pub requested_by_id: Option<i64>,
    /// `modifiedById`.
    pub modified_by_id: Option<i64>,
    /// `seasons`, by id.
    pub seasons: Vec<SeasonRequestRow>,
    /// `episodes`, by season and episode number.
    pub episodes: Vec<EpisodeRequestRow>,
}

const REQUEST_COLUMNS_SQLITE: &str = r#"r."id", r."status", r."createdAt", r."updatedAt", r."type", r."episodeSelectionType",
    r."episodeStartTvdbId", r."episodeEndTvdbId", r."watchAheadCount", r."ongoingEpisodeRequestKey", r."tvQuotaUnits", r."is4k",
    r."serverId", r."profileId", r."rootFolder", r."languageProfileId", r."tags", r."isAutoRequest", r."ignoreQuota",
    r."mediaId", r."requestedById", r."modifiedById""#;

const REQUEST_COLUMNS_PG: &str = r#"r."id"::bigint AS "id", r."status"::bigint AS "status",
    to_char(r."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
    to_char(r."updatedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
    r."type", r."episodeSelectionType", r."episodeStartTvdbId"::bigint AS "episodeStartTvdbId",
    r."episodeEndTvdbId"::bigint AS "episodeEndTvdbId", r."watchAheadCount"::bigint AS "watchAheadCount",
    r."ongoingEpisodeRequestKey", r."tvQuotaUnits"::bigint AS "tvQuotaUnits", r."is4k",
    r."serverId"::bigint AS "serverId", r."profileId"::bigint AS "profileId", r."rootFolder",
    r."languageProfileId"::bigint AS "languageProfileId", r."tags", r."isAutoRequest", r."ignoreQuota",
    r."mediaId"::bigint AS "mediaId", r."requestedById"::bigint AS "requestedById", r."modifiedById"::bigint AS "modifiedById""#;

/// A Postgres timestamp column as ISO 8601 UTC text.
fn pg_iso(column: &str) -> String {
    format!(r#"to_char({column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')"#)
}

fn request_from_row<R: Row>(r: &R, sqlite_dates: bool) -> Result<RequestRow>
where
    for<'a> &'a str: sqlx::ColumnIndex<R>,
    for<'a> String: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
    for<'a> i64: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
    for<'a> bool: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
{
    let date = |name: &str| date_column(r, name, sqlite_dates);
    Ok(RequestRow {
        id: r.try_get("id")?,
        status: r.try_get("status")?,
        created_at: date("createdAt")?,
        updated_at: date("updatedAt")?,
        request_type: r.try_get("type")?,
        episode_selection_type: r.try_get("episodeSelectionType")?,
        episode_start_tvdb_id: r.try_get("episodeStartTvdbId")?,
        episode_end_tvdb_id: r.try_get("episodeEndTvdbId")?,
        watch_ahead_count: r.try_get("watchAheadCount")?,
        ongoing_episode_request_key: r.try_get("ongoingEpisodeRequestKey")?,
        tv_quota_units: r.try_get("tvQuotaUnits")?,
        is4k: r.try_get("is4k")?,
        server_id: r.try_get::<Option<i64>, _>("serverId")?,
        profile_id: r.try_get::<Option<i64>, _>("profileId")?,
        root_folder: r.try_get("rootFolder")?,
        language_profile_id: r.try_get::<Option<i64>, _>("languageProfileId")?,
        tags: r.try_get("tags")?,
        is_auto_request: r.try_get("isAutoRequest")?,
        ignore_quota: r.try_get("ignoreQuota")?,
        media_id: r.try_get("mediaId")?,
        requested_by_id: r.try_get("requestedById")?,
        modified_by_id: r.try_get("modifiedById")?,
        seasons: Vec::new(),
        episodes: Vec::new(),
    })
}

fn season_request_from_row<R: Row>(r: &R, sqlite_dates: bool) -> Result<SeasonRequestRow>
where
    for<'a> &'a str: sqlx::ColumnIndex<R>,
    for<'a> String: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
    for<'a> i64: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
{
    let date = |name: &str| date_column(r, name, sqlite_dates);
    Ok(SeasonRequestRow {
        id: r.try_get("id")?,
        season_number: r.try_get("seasonNumber")?,
        status: r.try_get("status")?,
        created_at: date("createdAt")?,
        updated_at: date("updatedAt")?,
        request_id: r.try_get("requestId")?,
    })
}

fn episode_request_from_row<R: Row>(r: &R, sqlite_dates: bool) -> Result<EpisodeRequestRow>
where
    for<'a> &'a str: sqlx::ColumnIndex<R>,
    for<'a> String: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
    for<'a> i64: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
{
    let date = |name: &str| date_column(r, name, sqlite_dates);
    Ok(EpisodeRequestRow {
        id: r.try_get("id")?,
        tvdb_id: r.try_get("tvdbId")?,
        season_number: r.try_get("seasonNumber")?,
        episode_number: r.try_get("episodeNumber")?,
        title: r.try_get("title")?,
        air_date: r.try_get("airDate")?,
        status: r.try_get("status")?,
        search_triggered_at: date("searchTriggeredAt")?,
        created_at: date("createdAt")?,
        updated_at: date("updatedAt")?,
        request_id: r.try_get("requestId")?,
    })
}

/// How `GET /issue` pages, filters and sorts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueListQuery {
    /// `issue.status` values to keep.
    pub statuses: Vec<i64>,
    /// Sort column, always descending.
    pub sort: IssueSort,
    /// Only issues this user created.
    pub created_by: Option<i64>,
    /// Page size.
    pub take: i64,
    /// Rows to skip.
    pub skip: i64,
}

/// The `sort` query parameter of `GET /issue`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssueSort {
    /// `added` (the default): by `createdAt`.
    CreatedAt,
    /// `modified`: by `updatedAt`.
    UpdatedAt,
}

/// `GET /issue/count`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct IssueCounts {
    /// Every issue.
    pub total: i64,
    /// `issueType = VIDEO`.
    pub video: i64,
    /// `issueType = AUDIO`.
    pub audio: i64,
    /// `issueType = SUBTITLES`.
    pub subtitles: i64,
    /// `issueType = OTHER`.
    pub others: i64,
    /// `status = OPEN`.
    pub open: i64,
    /// `status = RESOLVED`.
    pub closed: i64,
}

/// An `issue_comment` row.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IssueCommentRow {
    /// `id`.
    pub id: i64,
    /// `message`.
    pub message: String,
    /// `createdAt` as ISO 8601 UTC.
    pub created_at: Option<String>,
    /// `updatedAt` as ISO 8601 UTC.
    pub updated_at: Option<String>,
    /// `userId`.
    pub user_id: Option<i64>,
    /// `issueId`.
    pub issue_id: Option<i64>,
}

/// An `issue` row with its comments; the media and users are loaded
/// separately.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IssueRow {
    /// `id`.
    pub id: i64,
    /// `issueType` (a REAL where a body gave a fraction).
    pub issue_type: i64,
    /// `status`.
    pub status: i64,
    /// `problemSeason`.
    pub problem_season: i64,
    /// `problemEpisode`.
    pub problem_episode: i64,
    /// `createdAt` as ISO 8601 UTC.
    pub created_at: Option<String>,
    /// `updatedAt` as ISO 8601 UTC.
    pub updated_at: Option<String>,
    /// `mediaId`.
    pub media_id: Option<i64>,
    /// `createdById`.
    pub created_by_id: Option<i64>,
    /// `modifiedById`.
    pub modified_by_id: Option<i64>,
    /// `comments`, by id.
    pub comments: Vec<IssueCommentRow>,
}

const ISSUE_COLUMNS_SQLITE: &str = r#"i."id", i."issueType", i."status", i."problemSeason", i."problemEpisode", i."createdAt", i."updatedAt",
    i."mediaId", i."createdById", i."modifiedById""#;

const ISSUE_COLUMNS_PG: &str = r#"i."id"::bigint AS "id", i."issueType"::bigint AS "issueType", i."status"::bigint AS "status",
    i."problemSeason"::bigint AS "problemSeason", i."problemEpisode"::bigint AS "problemEpisode",
    to_char(i."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
    to_char(i."updatedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
    i."mediaId"::bigint AS "mediaId", i."createdById"::bigint AS "createdById", i."modifiedById"::bigint AS "modifiedById""#;

fn issue_from_row<R: Row>(r: &R, sqlite_dates: bool) -> Result<IssueRow>
where
    for<'a> &'a str: sqlx::ColumnIndex<R>,
    for<'a> String: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
    for<'a> i64: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
{
    let date = |name: &str| date_column(r, name, sqlite_dates);
    Ok(IssueRow {
        id: r.try_get("id")?,
        issue_type: r.try_get("issueType")?,
        status: r.try_get("status")?,
        problem_season: r.try_get("problemSeason")?,
        problem_episode: r.try_get("problemEpisode")?,
        created_at: date("createdAt")?,
        updated_at: date("updatedAt")?,
        media_id: r.try_get("mediaId")?,
        created_by_id: r.try_get("createdById")?,
        modified_by_id: r.try_get("modifiedById")?,
        comments: Vec::new(),
    })
}

fn comment_from_row<R: Row>(r: &R, sqlite_dates: bool) -> Result<IssueCommentRow>
where
    for<'a> &'a str: sqlx::ColumnIndex<R>,
    for<'a> String: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
    for<'a> i64: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
{
    let date = |name: &str| date_column(r, name, sqlite_dates);
    Ok(IssueCommentRow {
        id: r.try_get("id")?,
        message: r.try_get("message")?,
        created_at: date("createdAt")?,
        updated_at: date("updatedAt")?,
        user_id: r.try_get("userId")?,
        issue_id: r.try_get("issueId")?,
    })
}

/// A media row with the requesting user's watchlist rows for it, as
/// `getRelatedMedia` joins them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RelatedMedia {
    /// The media row.
    pub media: MediaRow,
    /// The user's `watchlist` rows pointing at it, by id.
    pub watchlists: Vec<WatchlistRow>,
}

/// A `watchlist` row.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WatchlistRow {
    /// `id`.
    pub id: i64,
    /// `ratingKey`.
    pub rating_key: String,
    /// `mediaType`.
    pub media_type: String,
    /// `title`.
    pub title: String,
    /// `tmdbId`.
    pub tmdb_id: i64,
    /// `createdAt` as ISO 8601 UTC.
    pub created_at: Option<String>,
    /// `updatedAt` as ISO 8601 UTC.
    pub updated_at: Option<String>,
    /// `mediaId`.
    pub media_id: Option<i64>,
}

fn watchlist_from_row<R: Row>(r: &R, sqlite_dates: bool) -> Result<WatchlistRow>
where
    for<'a> &'a str: sqlx::ColumnIndex<R>,
    for<'a> String: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
    for<'a> i64: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
{
    let date = |name: &str| date_column(r, name, sqlite_dates);
    Ok(WatchlistRow {
        id: r.try_get("id")?,
        rating_key: r.try_get("ratingKey")?,
        media_type: r.try_get("mediaType")?,
        title: r.try_get("title")?,
        tmdb_id: r.try_get("tmdbId")?,
        created_at: date("createdAt")?,
        updated_at: date("updatedAt")?,
        media_id: r.try_get("mediaId")?,
    })
}

/// `?N` placeholders as Postgres's `$N`.
pub(crate) fn pg_placeholders(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '?' && chars.peek().is_some_and(char::is_ascii_digit) {
            out.push('$');
        } else {
            out.push(c);
        }
    }
    out
}

/// A `user_push_subscription` row.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PushSubscriptionRow {
    /// `id`.
    pub id: i64,
    /// `endpoint`.
    pub endpoint: String,
    /// `p256dh`.
    pub p256dh: String,
    /// `auth`.
    pub auth: String,
    /// `userAgent`.
    pub user_agent: Option<String>,
    /// `createdAt` as ISO 8601 UTC.
    pub created_at: Option<String>,
    /// `userId`.
    pub user_id: Option<i64>,
}

fn push_from_row<R: Row>(r: &R, sqlite_dates: bool) -> Result<PushSubscriptionRow>
where
    for<'a> &'a str: sqlx::ColumnIndex<R>,
    for<'a> String: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
    for<'a> i64: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
{
    Ok(PushSubscriptionRow {
        id: r.try_get("id")?,
        endpoint: r.try_get("endpoint")?,
        p256dh: r.try_get("p256dh")?,
        auth: r.try_get("auth")?,
        user_agent: r.try_get("userAgent")?,
        created_at: date_column(r, "createdAt", sqlite_dates)?,
        user_id: r.try_get("userId")?,
    })
}

/// The linked-account columns of `user_settings`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LinkedAccountsRow {
    /// `traktAccessToken` is set.
    pub trakt_access: bool,
    /// `traktRefreshToken` is set.
    pub trakt_refresh: bool,
    /// `traktUsername`.
    pub trakt_username: Option<String>,
    /// `mediaActionsTraktEnabled`.
    pub trakt_actions: Option<bool>,
    /// `simklAccessToken` is set.
    pub simkl_access: bool,
    /// `simklUsername`.
    pub simkl_username: Option<String>,
    /// `mediaActionsSimklEnabled`.
    pub simkl_actions: Option<bool>,
}

trait LinkedRow {
    fn linked(&self) -> Result<LinkedAccountsRow>;
}

fn linked_from<R: Row>(r: &R) -> Result<LinkedAccountsRow>
where
    for<'a> &'a str: sqlx::ColumnIndex<R>,
    for<'a> String: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
    for<'a> bool: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
{
    let set = |name: &str| -> Result<bool> {
        Ok(r.try_get::<Option<String>, _>(name)?
            .is_some_and(|v| !v.is_empty()))
    };
    Ok(LinkedAccountsRow {
        trakt_access: set("traktAccessToken")?,
        trakt_refresh: set("traktRefreshToken")?,
        trakt_username: r.try_get("traktUsername")?,
        trakt_actions: r.try_get("mediaActionsTraktEnabled")?,
        simkl_access: set("simklAccessToken")?,
        simkl_username: r.try_get("simklUsername")?,
        simkl_actions: r.try_get("mediaActionsSimklEnabled")?,
    })
}

impl LinkedRow for sqlx::sqlite::SqliteRow {
    fn linked(&self) -> Result<LinkedAccountsRow> {
        linked_from(self)
    }
}

impl LinkedRow for sqlx::postgres::PgRow {
    fn linked(&self) -> Result<LinkedAccountsRow> {
        linked_from(self)
    }
}

/// What a password sign-in needs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LoginAccount {
    /// `id`.
    pub id: i64,
    /// `email` as stored.
    pub email: Option<String>,
    /// `password`, the hash.
    pub password: Option<String>,
    /// `plexId`.
    pub plex_id: Option<i64>,
    /// `@RelationCount` of the user's requests.
    pub request_count: i64,
}

trait LoginRow {
    fn account(&self) -> Result<LoginAccount>;
}

fn account_from<R: Row>(r: &R) -> Result<LoginAccount>
where
    for<'a> &'a str: sqlx::ColumnIndex<R>,
    for<'a> String: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
    for<'a> i64: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
{
    Ok(LoginAccount {
        id: r.try_get("id")?,
        email: r.try_get("email")?,
        password: r.try_get("password")?,
        plex_id: r.try_get("plexId")?,
        request_count: r.try_get("requestCount")?,
    })
}

impl LoginRow for sqlx::sqlite::SqliteRow {
    fn account(&self) -> Result<LoginAccount> {
        account_from(self)
    }
}

impl LoginRow for sqlx::postgres::PgRow {
    fn account(&self) -> Result<LoginAccount> {
        account_from(self)
    }
}

trait EdgeRow {
    fn edge(&self) -> Result<(String, String, Option<String>, Option<String>)>;
}

impl EdgeRow for sqlx::sqlite::SqliteRow {
    fn edge(&self) -> Result<(String, String, Option<String>, Option<String>)> {
        Ok((
            self.try_get(0)?,
            self.try_get(1)?,
            self.try_get(2)?,
            self.try_get(3)?,
        ))
    }
}

impl EdgeRow for sqlx::postgres::PgRow {
    fn edge(&self) -> Result<(String, String, Option<String>, Option<String>)> {
        Ok((
            self.try_get(0)?,
            self.try_get(1)?,
            self.try_get(2)?,
            self.try_get(3)?,
        ))
    }
}

/// One `SQLite` row as JSON, by the storage class of each value.
pub(crate) fn sqlite_json_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<serde_json::Map<String, serde_json::Value>> {
    use serde_json::Value;
    use sqlx::{Column, TypeInfo, ValueRef};
    let mut out = serde_json::Map::new();
    for (i, column) in row.columns().iter().enumerate() {
        let raw = row.try_get_raw(i)?;
        let value = if raw.is_null() {
            Value::Null
        } else {
            match raw.type_info().name() {
                "INTEGER" | "BOOLEAN" => Value::from(row.try_get::<i64, _>(i)?),
                "REAL" => serde_json::Number::from_f64(row.try_get::<f64, _>(i)?)
                    .map_or(Value::Null, Value::Number),
                "BLOB" => Value::Null,
                _ => Value::from(row.try_get::<String, _>(i)?),
            }
        };
        out.insert(column.name().to_owned(), value);
    }
    Ok(out)
}

/// One Postgres row as JSON, by column type.
pub(crate) fn pg_json_row(
    row: &sqlx::postgres::PgRow,
) -> Result<serde_json::Map<String, serde_json::Value>> {
    use serde_json::Value;
    use sqlx::{Column, TypeInfo, ValueRef};
    let mut out = serde_json::Map::new();
    for (i, column) in row.columns().iter().enumerate() {
        let raw = row.try_get_raw(i)?;
        let value = if raw.is_null() {
            Value::Null
        } else {
            match column.type_info().name() {
                "INT8" => Value::from(row.try_get::<i64, _>(i)?),
                "INT4" => Value::from(row.try_get::<i32, _>(i)?),
                "INT2" => Value::from(row.try_get::<i16, _>(i)?),
                "FLOAT8" => serde_json::Number::from_f64(row.try_get::<f64, _>(i)?)
                    .map_or(Value::Null, Value::Number),
                "FLOAT4" => serde_json::Number::from_f64(f64::from(row.try_get::<f32, _>(i)?))
                    .map_or(Value::Null, Value::Number),
                "BOOL" => Value::Bool(row.try_get::<bool, _>(i)?),
                _ => Value::from(row.try_get::<String, _>(i)?),
            }
        };
        out.insert(column.name().to_owned(), value);
    }
    Ok(out)
}

#[cfg(test)]
mod failure_tests {
    use super::*;

    #[test]
    fn postgres_tls_only_runs_when_enabled() {
        assert!(
            matches!(postgres_ssl_mode(false, None), PgSslMode::Disable),
            "an unset or false DB_USE_SSL does not negotiate TLS"
        );
        assert!(
            matches!(postgres_ssl_mode(false, Some("true")), PgSslMode::Disable),
            "certificate options cannot turn TLS on"
        );
        for reject in [None, Some(""), Some("true"), Some("TRUE")] {
            assert!(
                matches!(postgres_ssl_mode(true, reject), PgSslMode::VerifyFull),
                "TLS verifies the certificate and host by default: {reject:?}"
            );
        }
        assert!(
            matches!(postgres_ssl_mode(true, Some("false")), PgSslMode::Require),
            "the explicit certificate-verification override is honored"
        );
    }

    #[tokio::test]
    async fn database_messages_are_sqlx_own() -> Result<()> {
        let db = Db::Sqlite(
            SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await?,
        );
        db.execute(
            r#"CREATE TABLE "t" ("id" INTEGER PRIMARY KEY, "k" TEXT UNIQUE NOT NULL)"#,
            &[],
        )
        .await?;
        db.execute(r#"INSERT INTO "t" ("k") VALUES ('a')"#, &[])
            .await?;
        let Err(duplicate) = db
            .execute(r#"INSERT INTO "t" ("k") VALUES ('a')"#, &[])
            .await
        else {
            anyhow::bail!("the duplicate was written");
        };
        assert!(is_unique_violation(&duplicate), "unique violation");
        let message = failure_message(&duplicate);
        assert!(message.starts_with("Database error: "), "{message}");
        assert!(!message.contains("SQLiteError"), "no bun:sqlite wording");
        let Err(null) = db
            .execute(r#"INSERT INTO "t" ("k") VALUES (NULL)"#, &[])
            .await
        else {
            anyhow::bail!("the null was written");
        };
        assert!(!is_unique_violation(&null), "not a unique violation");
        assert_eq!(
            failure_message(&anyhow::anyhow!("plain")),
            "plain",
            "other errors keep their text"
        );
        Ok(())
    }
}
