//! Wall-clock formatting the way `TypeORM` and `Date.toJSON` write it.

use std::time::{SystemTime, UNIX_EPOCH};

/// A moment as UTC calendar fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Utc {
    /// Full year.
    pub year: i64,
    /// 1-12.
    pub month: u32,
    /// 1-31.
    pub day: u32,
    /// 0-23.
    pub hour: u32,
    /// 0-59.
    pub minute: u32,
    /// 0-59.
    pub second: u32,
    /// 0-999.
    pub millis: u32,
}

impl Utc {
    /// Now.
    #[must_use]
    pub fn now() -> Self {
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(0));
        Self::from_unix_millis(ms)
    }

    /// From milliseconds since the Unix epoch (Howard Hinnant's civil
    /// date algorithm).
    #[must_use]
    pub fn from_unix_millis(ms: i64) -> Self {
        let days = ms.div_euclid(86_400_000);
        let rem = ms.rem_euclid(86_400_000);
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z.rem_euclid(146_097);
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let day = doy - (153 * mp + 2) / 5 + 1;
        let month = if mp < 10 { mp + 3 } else { mp - 9 };
        let year = yoe + era * 400 + i64::from(month <= 2);
        let to_u32 = |v: i64| u32::try_from(v).unwrap_or(0);
        Self {
            year,
            month: to_u32(month),
            day: to_u32(day),
            hour: to_u32(rem / 3_600_000),
            minute: to_u32(rem / 60_000 % 60),
            second: to_u32(rem / 1000 % 60),
            millis: to_u32(rem % 1000),
        }
    }

    /// `mixedDateToUtcDatetimeString`: `YYYY-MM-DD HH:MM:SS.SSS`.
    #[must_use]
    pub fn typeorm_string(&self) -> String {
        format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
            self.year, self.month, self.day, self.hour, self.minute, self.second, self.millis
        )
    }

    /// `Date.toJSON`: `YYYY-MM-DDTHH:MM:SS.SSSZ`.
    #[must_use]
    pub fn iso_string(&self) -> String {
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            self.year, self.month, self.day, self.hour, self.minute, self.second, self.millis
        )
    }

    /// `setFullYear(getFullYear() + years)`, keeping every other field.
    #[must_use]
    pub const fn plus_years(mut self, years: i64) -> Self {
        self.year += years;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{FixedOffset, MappedLocalTime, NaiveDate, NaiveDateTime};

    /// Central European time: +01:00, +02:00 from the last Sunday of March
    /// 01:00 UTC to the last Sunday of October 01:00 UTC (2026 only).
    #[derive(Debug, Clone, Copy)]
    struct Cet;

    fn ms(text: &str) -> i64 {
        parse_date_millis(text).unwrap_or_default()
    }

    fn cet_offset(seconds: i32) -> FixedOffset {
        FixedOffset::east_opt(seconds).unwrap_or_else(|| chrono::Offset::fix(&chrono::Utc))
    }

    impl chrono::TimeZone for Cet {
        type Offset = FixedOffset;

        fn from_offset(_: &FixedOffset) -> Self {
            Self
        }

        fn offset_from_local_date(&self, _: &NaiveDate) -> MappedLocalTime<FixedOffset> {
            MappedLocalTime::None
        }

        fn offset_from_local_datetime(&self, _: &NaiveDateTime) -> MappedLocalTime<FixedOffset> {
            MappedLocalTime::None
        }

        fn offset_from_utc_date(&self, _: &NaiveDate) -> FixedOffset {
            cet_offset(3600)
        }

        fn offset_from_utc_datetime(&self, utc: &NaiveDateTime) -> FixedOffset {
            let t = utc.and_utc().timestamp_millis();
            let summer = (ms("2026-03-29T01:00:00Z")..ms("2026-10-25T01:00:00Z")).contains(&t);
            cet_offset(if summer { 7200 } else { 3600 })
        }
    }

    #[test]
    fn local_calendar_days() {
        // Node and Bun with TZ=Europe/Berlin give the same moments.
        let before = |now: &str, days| {
            Utc::from_unix_millis(local_days_before(&Cet, ms(now), days)).iso_string()
        };
        assert_eq!(
            before("2026-03-30T10:00:00.000Z", 7),
            "2026-03-23T11:00:00.000Z",
            "a week with a 23-hour day"
        );
        assert_eq!(
            before("2026-10-26T10:00:00.000Z", 7),
            "2026-10-19T09:00:00.000Z",
            "a week with a 25-hour day"
        );
        assert_eq!(
            before("2026-03-30T00:30:00.000Z", 1),
            "2026-03-29T01:30:00.000Z",
            "02:30 was skipped: read at +01:00"
        );
        assert_eq!(
            before("2026-10-26T01:30:00.000Z", 1),
            "2026-10-25T00:30:00.000Z",
            "02:30 happened twice: the first"
        );
        assert_eq!(
            before("2026-06-15T12:00:00.000Z", 30),
            "2026-05-16T12:00:00.000Z",
            "no change in between"
        );
        assert_eq!(
            before("2026-03-23T11:00:00.000Z", -7),
            "2026-03-30T10:00:00.000Z",
            "negative days go forward"
        );
    }

    #[test]
    fn formats_known_moments() {
        let t = Utc::from_unix_millis(1_791_661_865_758);
        assert_eq!(t.iso_string(), "2026-10-10T19:51:05.758Z", "ISO");
        assert_eq!(t.typeorm_string(), "2026-10-10 19:51:05.758", "TypeORM");
        assert_eq!(
            Utc::from_unix_millis(0).iso_string(),
            "1970-01-01T00:00:00.000Z",
            "epoch"
        );
        assert_eq!(
            Utc::from_unix_millis(951_782_400_000).iso_string(),
            "2000-02-29T00:00:00.000Z",
            "leap day"
        );
        assert_eq!(t.plus_years(100).year, 2126, "a century on");
    }
}

/// Milliseconds since the Unix epoch, now.
#[must_use]
pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(0))
}

/// `Date.parse` for the shapes TMDB and the database write.
///
/// `YYYY-MM-DD`, optionally followed by `THH:MM[:SS[.SSS]]Z`. Other shapes
/// (which JavaScript would read in local time) are `None`.
#[must_use]
pub fn parse_date_millis(text: &str) -> Option<i64> {
    let (date, time) = text
        .split_once('T')
        .map_or((text, None), |(d, t)| (d, Some(t)));
    let mut parts = date.split('-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: i64 = parts.next()?.parse().ok()?;
    let day: i64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let millis = if let Some(time) = time {
        let clock = time.strip_suffix('Z')?;
        let (hms, fraction) = clock.split_once('.').map_or((clock, "0"), |(h, f)| (h, f));
        let mut fields = hms.split(':');
        let hour: i64 = fields.next()?.parse().ok()?;
        let minute: i64 = fields.next()?.parse().ok()?;
        let second: i64 = fields.next().map_or(Some(0), |s| s.parse().ok())?;
        if fields.next().is_some() || hour > 23 || minute > 59 || second > 59 {
            return None;
        }
        let fraction: String = fraction.chars().take(3).collect();
        let padded = format!("{fraction:0<3}");
        let ms: i64 = padded.parse().ok()?;
        hour * 3_600_000 + minute * 60_000 + second * 1000 + ms
    } else {
        0
    };
    Some(days_from_civil(year, month, day) * 86_400_000 + millis)
}

/// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
#[must_use]
pub const fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod date_tests {
    use super::*;

    #[test]
    fn parses_dates() {
        assert_eq!(parse_date_millis("1970-01-02"), Some(86_400_000), "day two");
        assert_eq!(
            parse_date_millis("1999-10-15"),
            Some(939_945_600_000),
            "fight club"
        );
        assert_eq!(
            parse_date_millis("2025-02-04T11:00:00.500Z"),
            Some(1_738_666_800_500),
            "with time"
        );
        assert_eq!(parse_date_millis("15/10/1999"), None, "other shapes");
        assert_eq!(
            Utc::from_unix_millis(939_945_600_000).iso_string(),
            "1999-10-15T00:00:00.000Z",
            "round trip"
        );
    }
}

/// `date.setDate(date.getDate() - days)` on a `Date` at `now` in `tz`.
///
/// The result (Unix milliseconds) shows the same wall-clock time `days`
/// calendar days earlier, so a daylight-saving change in between makes the
/// span an hour longer or shorter than `days` times 24 hours.
#[must_use]
pub fn local_days_before<Tz: chrono::TimeZone>(tz: &Tz, now: i64, days: i64) -> i64 {
    let fixed = || now.saturating_sub(days.saturating_mul(86_400_000));
    let Some(at) = chrono::DateTime::from_timestamp_millis(now) else {
        return fixed();
    };
    let wall = tz.from_utc_datetime(&at.naive_utc()).naive_local();
    let step = chrono::Days::new(days.unsigned_abs());
    let shifted = if days >= 0 {
        wall.checked_sub_days(step)
    } else {
        wall.checked_add_days(step)
    };
    shifted.map_or_else(fixed, |wall| from_local_wall(tz, wall))
}

/// `UTC(t)`: the moment the wall-clock fields `wall` show in `tz`. An
/// ambiguous time (clocks going back) is the earlier moment; a skipped one
/// (clocks going forward) is read with the offset in force before the
/// change.
fn from_local_wall<Tz: chrono::TimeZone>(tz: &Tz, wall: chrono::NaiveDateTime) -> i64 {
    let local = wall.and_utc().timestamp_millis();
    let offset = |utc: i64| {
        chrono::DateTime::from_timestamp_millis(utc).map_or(0, |at| {
            let fixed = chrono::Offset::fix(&tz.offset_from_utc_datetime(&at.naive_utc()));
            i64::from(fixed.local_minus_utc()) * 1000
        })
    };
    let before = offset(local - 86_400_000);
    let after = offset(local + 86_400_000);
    [before, after]
        .into_iter()
        .map(|o| local - o)
        .filter(|&utc| offset(utc) == local - utc)
        .min()
        .unwrap_or(local - before)
}
