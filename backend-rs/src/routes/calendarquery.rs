//! `parseCalendarQuery` (`server/lib/calendar/query.ts`) on the query the
//! `OpenAPI` validator left in `req.query`, and the `new Date(text)` it
//! relies on, as Bun (`JavaScriptCore`) reads the strings the validator lets
//! through.
//!
//! The validator coerces `serverId`, `is4k`, `includeEpisodes` and
//! `includeUnmonitored` to numbers and booleans, and the handler reads
//! strings only (`readSingle`), so those filters stay unset; a repeated or
//! bracketed `start`/`end` reaches the handler as an array or object and
//! reads as missing.

use serde_json::{Map, Value};

use crate::clock::{days_from_civil, Utc};

const DAY_MS: i64 = 86_400_000;
/// `MAX_RANGE_DAYS`.
const MAX_RANGE_DAYS: i64 = 366;

/// The filters `parseCalendarQuery` returns, as far as they apply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Query {
    pub(super) start: i64,
    pub(super) end: i64,
    pub(super) all: bool,
    pub(super) media_type: Option<String>,
    pub(super) source: Option<String>,
}

/// What `parseCalendarQuery` does with a validated query.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Parsed {
    Query(Query),
    /// It throws: the status and message the handler passes to `next`.
    Refuse(u16, &'static str),
    /// A shape the validator should not have let through.
    Unported(&'static str),
}

/// `readSingle`.
fn single<'a>(query: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    query.get(key).and_then(Value::as_str)
}

/// `parseCalendarQuery(req.query, isAdmin)`.
pub(super) fn parse(query: &Map<String, Value>, admin: bool) -> Parsed {
    let (Some(start), Some(end)) = (single(query, "start"), single(query, "end")) else {
        return Parsed::Refuse(400, "start and end are required ISO dates or timestamps.");
    };
    if start.is_empty() || end.is_empty() {
        return Parsed::Refuse(400, "start and end are required ISO dates or timestamps.");
    }
    let (start, end) = match (date_value(start), date_value(end)) {
        (Ok(start), Ok(end)) => (start, end),
        (Err(why), _) | (_, Err(why)) => return Parsed::Unported(why),
    };
    let (Some(start), Some(end)) = (start, end) else {
        return Parsed::Refuse(400, "start and end must define a valid, non-empty range.");
    };
    if end <= start {
        return Parsed::Refuse(400, "start and end must define a valid, non-empty range.");
    }
    if end - start > MAX_RANGE_DAYS * DAY_MS {
        return Parsed::Refuse(400, "Calendar range cannot exceed 366 days.");
    }
    let scope = single(query, "scope").unwrap_or("mine");
    let media_type = single(query, "mediaType").filter(|v| !v.is_empty());
    let source = single(query, "source").filter(|v| !v.is_empty());
    let server_id = single(query, "serverId").filter(|v| !v.is_empty());
    let include_unmonitored = single(query, "includeUnmonitored") == Some("true");
    if scope != "mine" && scope != "all" {
        return Parsed::Refuse(400, "scope must be mine or all.");
    }
    if media_type.is_some_and(|m| m != "movie" && m != "tv") {
        return Parsed::Refuse(400, "mediaType must be movie or tv.");
    }
    if source.is_some_and(|s| s != "sonarr" && s != "radarr") {
        return Parsed::Refuse(400, "source must be sonarr or radarr.");
    }
    if !admin && (server_id.is_some() || include_unmonitored) {
        return Parsed::Refuse(
            403,
            "This calendar filter requires administrator permission.",
        );
    }
    if ["serverId", "is4k", "includeEpisodes", "includeUnmonitored"]
        .iter()
        .any(|key| single(query, key).is_some())
    {
        return Parsed::Unported("a filter the validator left a string");
    }
    Parsed::Query(Query {
        start,
        end,
        all: scope == "all",
        media_type: media_type.map(str::to_owned),
        source: source.map(str::to_owned),
    })
}

/// `new Date(text).getTime()` (`None` for `NaN`) for the strings the
/// validator's `date` and `date-time` formats accept, limited to the years
/// `TypeORM` writes as four digits; other strings are `Err`.
fn date_value(text: &str) -> Result<Option<i64>, &'static str> {
    let ms = if crate::openapi::fast_date(text) {
        date_only(text)
    } else if crate::openapi::fast_date_time(text) {
        date_time(text)
    } else {
        return Err("a date the validator should have refused");
    };
    match ms {
        Some(ms) if !(0..=9999).contains(&Utc::from_unix_millis(ms).year) => {
            Err("a date outside the years TypeORM writes as four digits")
        }
        other => Ok(other),
    }
}

/// `new Date(text)` as Bun reads it, where that is known.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum JsDate {
    /// `getTime()`.
    Ms(i64),
    /// An invalid date (`NaN`).
    Invalid,
    /// A shape not reproduced.
    Unknown,
}

/// `new Date(text)` for the validator's `date` and `date-time` shapes, and
/// for text without a digit (always invalid).
pub(super) fn js_date(text: &str) -> JsDate {
    let ms = if crate::openapi::fast_date(text) {
        date_only(text)
    } else if crate::openapi::fast_date_time(text) {
        date_time(text)
    } else if text.bytes().any(|b| b.is_ascii_digit()) {
        return JsDate::Unknown;
    } else {
        None
    };
    ms.map_or(JsDate::Invalid, JsDate::Ms)
}

/// A run of ASCII digits as a number.
fn number(text: Option<&str>) -> Option<i64> {
    let text = text?;
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// The date part: `JavaScriptCore` takes any day from 1 to 31 and lets it
/// run into the next month.
fn day_ms(text: &str) -> Option<i64> {
    let year = number(text.get(..4))?;
    let month = number(text.get(5..7))?;
    let day = number(text.get(8..10))?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some((days_from_civil(year, month, 1) + day - 1) * DAY_MS)
}

/// `YYYY-MM-DD`: UTC midnight.
fn date_only(text: &str) -> Option<i64> {
    day_ms(text)
}

/// `YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM|±HHMM)`, `T` and `Z` in
/// either case. Hour 24 only as `24:00:00` with a zero fraction; no leap
/// second; the fraction is truncated to milliseconds; a bare `±HH` offset
/// is invalid.
fn date_time(text: &str) -> Option<i64> {
    let day = day_ms(text)?;
    let time = text.get(11..)?;
    let hour = number(time.get(..2))?;
    let minute = number(time.get(3..5))?;
    let second = number(time.get(6..8))?;
    let mut rest = time.get(8..)?;
    let mut fraction = "";
    if let Some(after) = rest.strip_prefix('.') {
        let digits = after.bytes().take_while(u8::is_ascii_digit).count();
        fraction = after.get(..digits)?;
        rest = after.get(digits..)?;
    }
    let zero_fraction = fraction.bytes().all(|b| b == b'0');
    let valid_time = if hour == 24 {
        minute == 0 && second == 0 && zero_fraction
    } else {
        hour < 24 && minute < 60 && second < 60
    };
    if !valid_time {
        return None;
    }
    let kept: String = fraction.chars().take(3).collect();
    let millis = if kept.is_empty() {
        0
    } else {
        format!("{kept:0<3}").parse::<i64>().ok()?
    };
    let offset = offset_ms(rest)?;
    Some(day + hour * 3_600_000 + minute * 60_000 + second * 1000 + millis - offset)
}

/// The zone: `Z`, `±HH:MM` or `±HHMM`, hours up to 23.
fn offset_ms(zone: &str) -> Option<i64> {
    if zone.eq_ignore_ascii_case("z") {
        return Some(0);
    }
    let sign = match zone.as_bytes().first() {
        Some(b'+') => 1,
        Some(b'-') => -1,
        _ => return None,
    };
    let (hours, minutes) = match zone.len() {
        6 if zone.as_bytes().get(3) == Some(&b':') => (zone.get(1..3), zone.get(4..6)),
        5 => (zone.get(1..3), zone.get(3..5)),
        _ => return None,
    };
    let hours = number(hours)?;
    let minutes = number(minutes)?;
    if hours > 23 || minutes > 59 {
        return None;
    }
    Some(sign * (hours * 3_600_000 + minutes * 60_000))
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Map, Value};

    use super::{date_value, parse, Parsed, Query};

    /// `new Date(text).getTime()` as Bun 1.4.1 printed it.
    #[test]
    fn reads_dates_like_bun() {
        let cases: &[(&str, Option<i64>)] = &[
            ("2024-01-02", Some(1_704_153_600_000)),
            ("2024-13-02", None),
            ("2024-00-02", None),
            ("2024-01-00", None),
            ("2024-01-32", None),
            ("2024-02-30", Some(1_709_251_200_000)),
            ("2023-02-29", Some(1_677_628_800_000)),
            ("2024-04-31", Some(1_714_521_600_000)),
            ("0000-01-01", Some(-62_167_219_200_000)),
            ("1969-12-31", Some(-86_400_000)),
            ("9999-12-31", Some(253_402_214_400_000)),
            ("2024-01-02T03:04:05Z", Some(1_704_164_645_000)),
            ("2024-01-02t03:04:05z", Some(1_704_164_645_000)),
            ("2024-01-02T24:00:00Z", Some(1_704_240_000_000)),
            ("2024-01-02T25:00:00Z", None),
            ("2024-01-02T29:59:59Z", None),
            ("2024-01-02T23:59:60Z", None),
            ("2024-01-02T03:04:05.1Z", Some(1_704_164_645_100)),
            ("2024-01-02T03:04:05.9999Z", Some(1_704_164_645_999)),
            ("2024-01-02T03:04:05.123456789Z", Some(1_704_164_645_123)),
            ("2024-01-02T03:04:05+01", None),
            ("2024-01-02T03:04:05+0100", Some(1_704_161_045_000)),
            ("2024-01-02T03:04:05-01:30", Some(1_704_170_045_000)),
            ("2024-01-02T03:04:05+24:00", None),
            ("2024-01-02T03:04:05+23:59", Some(1_704_078_305_000)),
            ("2024-01-02T03:04:05+00:60", None),
            ("2024-01-02T03:04:05-0000", Some(1_704_164_645_000)),
            ("2024-02-30T03:04:05Z", Some(1_709_262_245_000)),
            ("2024-01-02T24:00:00.0000Z", Some(1_704_240_000_000)),
            ("2024-01-02T24:00:00.0001Z", None),
            ("2024-01-02T24:00:01Z", None),
            ("2024-01-02T24:00:00+01:00", Some(1_704_236_400_000)),
            ("2024-12-31T24:00:00Z", Some(1_735_689_600_000)),
            ("1970-01-01T00:00:00.999999Z", Some(999)),
        ];
        for (text, want) in cases {
            assert_eq!(date_value(text), Ok(*want), "{text}");
        }
        assert!(date_value("2024-1-02").is_err(), "not a validator date");
        assert!(
            date_value("0000-01-01T00:00:00+01:00").is_err(),
            "year -1 TypeORM writes oddly"
        );
    }

    #[test]
    fn reads_other_text_like_bun() {
        use super::{js_date, JsDate};
        assert_eq!(js_date("abc"), JsDate::Invalid, "no digit");
        assert_eq!(js_date("null"), JsDate::Invalid, "no digit");
        assert_eq!(
            js_date("2024-02-30"),
            JsDate::Ms(1_709_251_200_000),
            "overflow"
        );
        assert_eq!(js_date("2024-13-01"), JsDate::Invalid, "no month 13");
        assert_eq!(js_date("2024"), JsDate::Unknown, "a year alone");
    }

    fn query(value: &Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn parses_like_node() {
        let base = json!({"start": "2024-01-02", "end": "2024-01-03", "scope": "mine",
            "includeEpisodes": true, "includeUnmonitored": false, "serverId": 3});
        assert_eq!(
            parse(&query(&base), false),
            Parsed::Query(Query {
                start: 1_704_153_600_000,
                end: 1_704_240_000_000,
                all: false,
                media_type: None,
                source: None,
            }),
            "coerced filters don't apply"
        );
        let array = json!({"start": ["1", "2"], "end": "2024-01-02", "scope": "mine"});
        assert_eq!(
            parse(&query(&array), true),
            Parsed::Refuse(400, "start and end are required ISO dates or timestamps."),
            "an array start"
        );
        let bad = json!({"start": "2024-13-02", "end": "2024-01-02", "scope": "mine"});
        assert_eq!(
            parse(&query(&bad), true),
            Parsed::Refuse(400, "start and end must define a valid, non-empty range."),
            "an invalid date"
        );
        let long = json!({"start": "2024-01-01", "end": "2025-01-02", "scope": "all"});
        assert_eq!(
            parse(&query(&long), true),
            Parsed::Refuse(400, "Calendar range cannot exceed 366 days."),
            "too long"
        );
    }
}
