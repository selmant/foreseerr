//! `GET /user/:id/quota`: `User.getQuota` from `server/entity/User.ts`.

use std::future::Future;
use std::pin::Pin;

use serde_json::{Map, Value};

use super::{Outcome, Ready};
use crate::clock::Utc;
use crate::db::QuotaWindow;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// `Permission.MANAGE_USERS` and `Permission.MANAGE_REQUESTS`.
const MANAGE_USERS: i64 = 8;
const MANAGE_REQUESTS: i64 = 16;

/// One media type's quota, before JSON.
struct Quota {
    days: Option<i64>,
    limit: Option<i64>,
    used: i64,
}

impl Quota {
    /// `undefined` fields are left out, as JSON does.
    fn json(&self) -> Value {
        let mut out = Map::new();
        if let Some(days) = self.days {
            out.insert(String::from("days"), Value::from(days));
        }
        if let Some(limit) = self.limit {
            out.insert(String::from("limit"), Value::from(limit));
        }
        out.insert(String::from("used"), Value::from(self.used));
        let limit = self.limit.unwrap_or(0);
        if limit != 0 {
            out.insert(
                String::from("remaining"),
                Value::from((limit - self.used).max(0)),
            );
        }
        out.insert(
            String::from("restricted"),
            Value::Bool(limit != 0 && limit - self.used <= 0),
        );
        Value::Object(out)
    }
}

/// `GET /user/:id/quota`.
pub(super) fn quota<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = ctx.no_query() {
            return Outcome::forward(why);
        }
        let viewer = match ctx.authenticated(0) {
            Ok(viewer) => viewer,
            Err(why) => return Outcome::forward(why),
        };
        let id = match super::params::path_int(ctx, 1) {
            Ok(id) => id,
            Err(why) => return Outcome::forward(why),
        };
        let own = id == viewer.id;
        if !own && !viewer.has_all_permissions(MANAGE_USERS | MANAGE_REQUESTS) {
            return ctx.error(
                403,
                "You do not have permission to view this user's request limits.",
            );
        }
        let user = match ctx.state.db.user_record(id).await {
            Ok(Some((user, _))) => user,
            Ok(None) => return ctx.error(404, "User not found."),
            Err(e) => return Outcome::forward(format!("loading the user failed: {e:#}")),
        };
        let can_bypass = viewer_bypasses(user.permissions);
        let (movie_limit, movie_days, tv_limit, tv_days) = match limits(ctx, &user) {
            Ok(limits) => limits,
            Err(why) => return Outcome::forward(why),
        };
        let movie_limit = if can_bypass { Some(0) } else { movie_limit };
        let tv_limit = if can_bypass { Some(0) } else { tv_limit };
        let now = Utc::now();
        let window = |days: Option<i64>| {
            days.filter(|d| *d != 0).map(|d| QuotaWindow {
                // `setDate(getDate() - days)` in the server's local time; a DST
                // change inside the window shifts Node's boundary by an hour,
                // which this doesn't reproduce.
                start: Utc::from_unix_millis(unix_millis(now) - d * 86_400_000),
            })
        };
        let movie_used = if movie_limit.unwrap_or(0) != 0 {
            match ctx
                .state
                .db
                .movie_quota_used(user.id, window(movie_days))
                .await
            {
                Ok(count) => count,
                Err(e) => {
                    return Outcome::forward(format!("counting movie requests failed: {e:#}"))
                }
            }
        } else {
            0
        };
        let tv_used = if tv_limit.unwrap_or(0) != 0 {
            match ctx.state.db.tv_quota_used(user.id, window(tv_days)).await {
                Ok(sum) => sum,
                Err(e) => return Outcome::forward(format!("summing tv requests failed: {e:#}")),
            }
        } else {
            0
        };
        let mut out = Map::new();
        out.insert(
            String::from("movie"),
            Quota {
                days: movie_days,
                limit: movie_limit,
                used: movie_used,
            }
            .json(),
        );
        out.insert(
            String::from("tv"),
            Quota {
                days: tv_days,
                limit: tv_limit,
                used: tv_used,
            }
            .json(),
        );
        ctx.json(&Value::Object(out))
    })
}

/// The user's own limits and windows, falling back to `defaultQuotas`
/// (`??`), as `(movie limit, movie days, tv limit, tv days)`. A default
/// that isn't a whole number is left to Node.
fn limits(ctx: &Ready<'_>, user: &crate::db::UserRecord) -> Result<Limits, String> {
    let default = |path: &str| -> Result<Option<i64>, String> {
        match ctx.settings.get(&format!("/main/defaultQuotas/{path}")) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::Number(n)) => n
                .as_i64()
                .map(Some)
                .ok_or_else(|| String::from("a fractional quota default")),
            Some(_) => Err(String::from("a quota default that is not a number")),
        }
    };
    let resolve = |own: Option<i64>, path: &str| -> Result<Option<i64>, String> {
        own.map_or_else(|| default(path), |v| Ok(Some(v)))
    };
    Ok((
        resolve(user.movie_quota_limit, "movie/quotaLimit")?,
        resolve(user.movie_quota_days, "movie/quotaDays")?,
        resolve(user.tv_quota_limit, "tv/quotaLimit")?,
        resolve(user.tv_quota_days, "tv/quotaDays")?,
    ))
}

type Limits = (Option<i64>, Option<i64>, Option<i64>, Option<i64>);

/// `hasPermission([MANAGE_USERS], { type: 'or' })` on the user whose quota
/// it is: admins and user managers have no limits.
const fn viewer_bypasses(permissions: i64) -> bool {
    permissions & 2 != 0 || permissions & MANAGE_USERS != 0
}

fn unix_millis(t: Utc) -> i64 {
    // Round-trips through the same civil algorithm; cheap enough here.
    let days = days_from_civil(t.year, t.month, t.day);
    days * 86_400_000
        + i64::from(t.hour) * 3_600_000
        + i64::from(t.minute) * 60_000
        + i64::from(t.second) * 1000
        + i64::from(t.millis)
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let m = i64::from(month);
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_round_trip() {
        for ms in [0, 951_782_400_000, 1_791_661_865_758, -86_400_000] {
            assert_eq!(
                unix_millis(Utc::from_unix_millis(ms)),
                ms,
                "{ms} round-trips"
            );
        }
    }

    #[test]
    fn quota_shape() {
        let q = Quota {
            days: Some(7),
            limit: Some(2),
            used: 2,
        };
        assert_eq!(
            q.json(),
            serde_json::json!({"days": 7, "limit": 2, "used": 2, "remaining": 0, "restricted": true}),
            "exhausted"
        );
        let q = Quota {
            days: None,
            limit: Some(0),
            used: 0,
        };
        assert_eq!(
            q.json(),
            serde_json::json!({"limit": 0, "used": 0, "restricted": false}),
            "bypassed"
        );
        let q = Quota {
            days: None,
            limit: None,
            used: 0,
        };
        assert_eq!(
            q.json(),
            serde_json::json!({"used": 0, "restricted": false}),
            "unset"
        );
    }
}
