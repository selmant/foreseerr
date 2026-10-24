//! node-schedule's cron strings (`settings.jobs[*].schedule`).
//!
//! They are read the way node-schedule reads them: `cron-parser` 4.9's `parseExpression` (six
//! fields with seconds, five without, `L`, `#`, month and weekday names,
//! `@daily`-style shortcuts) and its `next()` search, in the process's local
//! time zone with Luxon's date arithmetic (so DST transitions land where
//! Node's land).
//!
//! The search is cron-parser's own: a cursor walks forward a day, month,
//! hour, minute or second at a time until every field matches, giving up
//! after 10 000 steps.

use chrono::{DateTime, Datelike, Days, NaiveDate, NaiveDateTime, Offset, TimeZone, Timelike};

/// `LOOP_LIMIT`.
const LOOP_LIMIT: u32 = 10_000;

/// `CronExpression.daysInMonth` (February counts 29).
const DAYS_IN_MONTH: [usize; 12] = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const HOUR_MS: i64 = 3_600_000;

/// The six fields, in expression order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Field {
    Second,
    Minute,
    Hour,
    DayOfMonth,
    Month,
    DayOfWeek,
}

/// The fields with `CronExpression.parseDefaults`.
const FIELDS: [(Field, &str); 6] = [
    (Field::Second, "0"),
    (Field::Minute, "*"),
    (Field::Hour, "*"),
    (Field::DayOfMonth, "*"),
    (Field::Month, "*"),
    (Field::DayOfWeek, "*"),
];

impl Field {
    const fn min(self) -> i64 {
        match self {
            Self::Second | Self::Minute | Self::Hour | Self::DayOfWeek => 0,
            Self::DayOfMonth | Self::Month => 1,
        }
    }

    const fn max(self) -> i64 {
        match self {
            Self::Second | Self::Minute => 59,
            Self::Hour => 23,
            Self::DayOfMonth => 31,
            Self::Month => 12,
            Self::DayOfWeek => 7,
        }
    }

    /// `constraints.chars`: only the day fields take `L`.
    const fn takes_l(self) -> bool {
        matches!(self, Self::DayOfMonth | Self::DayOfWeek)
    }

    /// `CronExpression.validCharacters[field]`, one character.
    const fn valid_char(self, c: char) -> bool {
        let standard = matches!(c, ',' | '*' | '/' | '-') || c.is_ascii_digit();
        match self {
            Self::Second | Self::Minute | Self::Hour | Self::Month => standard,
            Self::DayOfMonth => standard || matches!(c, '?' | 'L'),
            Self::DayOfWeek => standard || matches!(c, '?' | 'L' | '#'),
        }
    }

    const fn aliases(self) -> &'static [(&'static str, i64)] {
        match self {
            Self::Month => &[
                ("jan", 1),
                ("feb", 2),
                ("mar", 3),
                ("apr", 4),
                ("may", 5),
                ("jun", 6),
                ("jul", 7),
                ("aug", 8),
                ("sep", 9),
                ("oct", 10),
                ("nov", 11),
                ("dec", 12),
            ],
            Self::DayOfWeek => &[
                ("sun", 0),
                ("mon", 1),
                ("tue", 2),
                ("wed", 3),
                ("thu", 4),
                ("fri", 5),
                ("sat", 6),
            ],
            Self::Second | Self::Minute | Self::Hour | Self::DayOfMonth => &[],
        }
    }
}

/// One value of a parsed field: a number, or a string holding `L`.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Atom {
    Num(i64),
    Text(String),
}

/// What cron-parser's `parseRange` hands back.
enum Parsed {
    List(Vec<i64>),
    Num(Option<i64>),
    Text(String),
}

/// A parsed expression (`CronExpression.fields` plus `nthDayOfWeek`).
#[derive(Debug, Clone, PartialEq)]
pub struct CronExpr {
    second: Vec<Atom>,
    minute: Vec<Atom>,
    hour: Vec<Atom>,
    day_of_month: Vec<Atom>,
    month: Vec<Atom>,
    day_of_week: Vec<Atom>,
    nth_day_of_week: f64,
}

/// JavaScript's `\s`.
fn js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// `+s` for the strings a field can hold once its characters are checked:
/// digits (empty is 0); anything else is `NaN` (`None`).
fn js_int(s: &str) -> Option<i64> {
    if s.is_empty() {
        return Some(0);
    }
    if s.bytes().all(|b| b.is_ascii_digit()) {
        return Some(s.parse::<i64>().unwrap_or(i64::MAX));
    }
    None
}

/// `+s` for anything (the `#` occurrence is read before the characters are
/// checked, so it can be `2.5` or `0x3`).
fn js_number(s: &str) -> f64 {
    match s {
        "" => 0.0,
        "Infinity" | "+Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        _ => {
            let radix = [
                ("0x", 16),
                ("0X", 16),
                ("0o", 8),
                ("0O", 8),
                ("0b", 2),
                ("0B", 2),
            ]
            .iter()
            .find_map(|(prefix, radix)| s.strip_prefix(prefix).map(|rest| (rest, *radix)));
            if let Some((digits, radix)) = radix {
                return u32::from_str_radix(digits, radix).map_or(f64::NAN, f64::from);
            }
            if s.chars()
                .all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'))
            {
                s.parse::<f64>().unwrap_or(f64::NAN)
            } else {
                f64::NAN
            }
        }
    }
}

fn constraint_error(value: impl std::fmt::Display, field: Field) -> String {
    format!(
        "Constraint error, got value {value} expected range {}-{}",
        field.min(),
        field.max()
    )
}

/// `value.replace(/[a-z]{3}/gi, alias)` for months and weekdays.
fn replace_aliases(field: Field, value: &str) -> Result<String, String> {
    let chars: Vec<char> = value.chars().collect();
    let mut out = String::with_capacity(value.len());
    let mut i = 0;
    while i < chars.len() {
        match chars.get(i..i + 3) {
            Some(three) if three.iter().all(char::is_ascii_alphabetic) => {
                let key: String = three.iter().map(char::to_ascii_lowercase).collect();
                let Some((_, n)) = field.aliases().iter().find(|(name, _)| *name == key) else {
                    return Err(format!("Validation error, cannot resolve alias \"{key}\""));
                };
                out.push_str(&n.to_string());
                i += 3;
            }
            _ => {
                if let Some(c) = chars.get(i) {
                    out.push(*c);
                }
                i += 1;
            }
        }
    }
    Ok(out)
}

/// `parseRange(val, repeatInterval)`.
fn parse_range(field: Field, val: &str, repeat: Option<&str>) -> Result<Parsed, String> {
    let atoms: Vec<&str> = val.split('-').collect();
    if atoms.len() < 2 {
        return Ok(
            js_int(val).map_or_else(|| Parsed::Text(val.to_owned()), |n| Parsed::Num(Some(n)))
        );
    }
    let first = atoms.first().copied().unwrap_or_default();
    let second = atoms.get(1).copied().unwrap_or_default();
    if first.is_empty() {
        if second.is_empty() {
            return Err(format!("Invalid range: {val}"));
        }
        // `+val`: a negative number, or NaN.
        let negative = val
            .strip_prefix('-')
            .filter(|rest| !rest.is_empty())
            .and_then(js_int)
            .map(|n| -n);
        return Ok(Parsed::Num(negative));
    }
    let (Some(min), Some(max)) = (js_int(first), js_int(second)) else {
        return Err(format!(
            "Constraint error, got range NaN expected range {}-{}",
            field.min(),
            field.max()
        ));
    };
    if min < field.min() || max > field.max() {
        return Err(format!(
            "Constraint error, got range {min}-{max} expected range {}-{}",
            field.min(),
            field.max()
        ));
    }
    if min > max {
        return Err(format!("Invalid range: {val}"));
    }
    let interval = repeat.map_or(1, |r| js_int(r).unwrap_or(0));
    if interval <= 0 {
        return Err(format!(
            "Constraint error, cannot repeat at every {interval} time."
        ));
    }
    let mut stack = Vec::new();
    if field == Field::DayOfWeek && max % 7 == 0 {
        stack.push(0);
    }
    let mut repeat_index = interval;
    for index in min..=max {
        if !stack.contains(&index) && repeat_index > 0 && repeat_index % interval == 0 {
            repeat_index = 1;
            stack.push(index);
        } else {
            repeat_index += 1;
        }
    }
    Ok(Parsed::List(stack))
}

/// `parseRepeat(val)`.
fn parse_repeat(field: Field, val: &str) -> Result<Parsed, String> {
    let atoms: Vec<&str> = val.split('/').collect();
    match atoms.as_slice() {
        [first, step] => {
            // `atoms[0] == +atoms[0]`: a number repeats up to the maximum.
            let start = if js_int(first).is_some() {
                format!("{first}-{}", field.max())
            } else {
                (*first).to_owned()
            };
            parse_range(field, &start, Some(step))
        }
        [_] => parse_range(field, val, None),
        _ => Err(format!("Invalid repeat: {val}")),
    }
}

/// `handleResult` of `parseSequence`.
fn push_result(field: Field, result: Parsed, stack: &mut Vec<Atom>) -> Result<(), String> {
    match result {
        Parsed::List(values) => {
            for value in values {
                if value < field.min() || value > field.max() {
                    return Err(constraint_error(value, field));
                }
                stack.push(Atom::Num(value));
            }
        }
        Parsed::Text(text) if field.takes_l() && text.contains('L') => stack.push(Atom::Text(text)),
        Parsed::Text(text) => return Err(constraint_error(text, field)),
        Parsed::Num(None) => return Err(constraint_error("NaN", field)),
        Parsed::Num(Some(n)) => {
            if n < field.min() || n > field.max() {
                return Err(constraint_error(n, field));
            }
            stack.push(Atom::Num(if field == Field::DayOfWeek { n % 7 } else { n }));
        }
    }
    Ok(())
}

/// `CronExpression._sortCompareFn`: numbers ascending, then strings.
fn sort_atoms(atoms: &mut [Atom]) {
    atoms.sort_by(|a, b| match (a, b) {
        (Atom::Num(x), Atom::Num(y)) => x.cmp(y),
        (Atom::Num(_), Atom::Text(_)) => std::cmp::Ordering::Less,
        (Atom::Text(_), Atom::Num(_)) => std::cmp::Ordering::Greater,
        (Atom::Text(x), Atom::Text(y)) => x.cmp(y),
    });
}

/// `CronExpression._parseField`.
fn parse_field(field: Field, value: &str) -> Result<Vec<Atom>, String> {
    let mut value = if field.aliases().is_empty() {
        value.to_owned()
    } else {
        replace_aliases(field, value)?
    };
    if value.is_empty() || !value.chars().all(|c| field.valid_char(c)) {
        return Err(format!("Invalid characters, got value: {value}"));
    }
    let full = format!("{}-{}", field.min(), field.max());
    if value.contains('*') {
        value = value.replace('*', &full);
    } else if value.contains('?') {
        value = value.replace('?', &full);
    }
    let atoms: Vec<&str> = value.split(',').collect();
    if atoms.iter().any(|a| a.is_empty()) {
        return Err(String::from("Invalid list value format"));
    }
    let mut stack = Vec::new();
    for atom in atoms {
        push_result(field, parse_repeat(field, atom)?, &mut stack)?;
    }
    sort_atoms(&mut stack);
    Ok(stack)
}

/// `parseNthDay`: the weekday field without its `#n`, and `n` (0 without).
fn parse_nth_day(val: &str) -> Result<(&str, f64), String> {
    let atoms: Vec<&str> = val.split('#').collect();
    if atoms.len() < 2 {
        return Ok((val, 0.0));
    }
    let nth = js_number(atoms.last().copied().unwrap_or_default());
    if val.contains(',') || val.contains('/') || val.contains('-') {
        return Err(String::from(
            "Constraint error, invalid dayOfWeek `#` and `,`, `/` or `-` special characters are incompatible",
        ));
    }
    if atoms.len() > 2 || nth.is_nan() || !(1.0..=5.0).contains(&nth) {
        return Err(String::from(
            "Constraint error, invalid dayOfWeek occurrence number (#)",
        ));
    }
    Ok((atoms.first().copied().unwrap_or_default(), nth))
}

fn month_days(month: &[Atom]) -> Option<usize> {
    match month {
        [Atom::Num(m)] => usize::try_from(*m - 1)
            .ok()
            .and_then(|i| DAYS_IN_MONTH.get(i))
            .copied(),
        _ => None,
    }
}

/// `matchSchedule(value, sequence)`.
fn match_schedule(value: i64, sequence: &[Atom]) -> bool {
    for atom in sequence {
        if let Atom::Num(n) = atom {
            if *n >= value {
                return *n == value;
            }
        }
    }
    matches!(sequence.first(), Some(Atom::Num(n)) if *n == value)
}

fn has_l(sequence: &[Atom]) -> bool {
    sequence
        .iter()
        .any(|a| matches!(a, Atom::Text(t) if t.contains('L')))
}

/// `isNthDayMatch(date, nthDayOfWeek)`.
fn is_nth_day_match(day: u32, nth: f64) -> bool {
    if nth >= 6.0 {
        return false;
    }
    if day < 8 && (nth - 1.0).abs() < f64::EPSILON {
        return true;
    }
    let offset = u32::from(day % 7 != 0);
    let occurrence = (day - day % 7) / 7 + offset;
    (f64::from(occurrence) - nth).abs() < f64::EPSILON
}

impl CronExpr {
    /// `CronExpression.parse(expression)`.
    ///
    /// # Errors
    ///
    /// cron-parser's message when it throws.
    pub fn parse(expression: &str) -> Result<Self, String> {
        let expression = match expression {
            "@yearly" => "0 0 1 1 *",
            "@monthly" => "0 0 1 * *",
            "@weekly" => "0 0 * * 0",
            "@daily" => "0 0 * * *",
            "@hourly" => "0 * * * *",
            other => other,
        };
        let atoms: Vec<&str> = expression
            .split(js_space)
            .filter(|s| !s.is_empty())
            .collect();
        if atoms.len() > 6 {
            return Err(String::from("Invalid cron expression"));
        }
        let start = 6 - atoms.len().max(1);
        let mut nth = 0.0;
        let mut fields = Vec::with_capacity(6);
        for (i, (field, default)) in FIELDS.iter().enumerate() {
            let value = i.checked_sub(start).and_then(|j| atoms.get(j)).copied();
            let parsed = match value {
                None => parse_field(*field, default)?,
                Some(v) if *field == Field::DayOfWeek => {
                    let (rest, n) = parse_nth_day(v)?;
                    if n > 0.0 {
                        nth = n;
                    }
                    parse_field(*field, rest)?
                }
                Some(v) => parse_field(*field, v)?,
            };
            fields.push(parsed);
        }
        let mut it = fields.into_iter();
        let mut expr = Self {
            second: it.next().unwrap_or_default(),
            minute: it.next().unwrap_or_default(),
            hour: it.next().unwrap_or_default(),
            day_of_month: it.next().unwrap_or_default(),
            month: it.next().unwrap_or_default(),
            day_of_week: it.next().unwrap_or_default(),
            nth_day_of_week: nth,
        };
        // `_handleMaxDaysInMonth`.
        if let Some(days) = month_days(&expr.month) {
            let max = i64::try_from(days).unwrap_or(31);
            if matches!(expr.day_of_month.first(), Some(Atom::Num(d)) if *d > max) {
                return Err(String::from("Invalid explicit day of month definition"));
            }
            expr.day_of_month.retain(|a| match a {
                Atom::Num(d) => *d <= max,
                Atom::Text(t) => t == "L",
            });
            sort_atoms(&mut expr.day_of_month);
        }
        Ok(expr)
    }
}

/// The search position and the DST bookkeeping cron-parser keeps on the
/// expression between `next()` calls.
#[derive(Debug, Clone)]
pub struct CronIter<Tz: TimeZone> {
    expr: CronExpr,
    tz: Tz,
    current: i64,
    end: Option<i64>,
    dst_start: Option<i64>,
    dst_end: Option<i64>,
}

/// The units the cursor moves by.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Unit {
    Month,
    Day,
    Hour,
    Minute,
    Second,
}

/// The zone's offset at a moment, in milliseconds.
fn offset_ms<Tz: TimeZone>(tz: &Tz, ms: i64) -> i64 {
    DateTime::from_timestamp_millis(ms).map_or(0, |utc| {
        i64::from(
            tz.offset_from_utc_datetime(&utc.naive_utc())
                .fix()
                .local_minus_utc(),
        ) * 1000
    })
}

/// The local wall-clock fields of a moment.
fn local<Tz: TimeZone>(tz: &Tz, ms: i64) -> NaiveDateTime {
    DateTime::from_timestamp_millis(ms + offset_ms(tz, ms))
        .map(|d| d.naive_utc())
        .unwrap_or_default()
}

/// Luxon's `fixOffset`: the moment showing these wall-clock fields,
/// preferring the offset `guess` (the one before the change).
fn from_local<Tz: TimeZone>(tz: &Tz, fields: NaiveDateTime, guess: i64) -> i64 {
    let local_ts = fields.and_utc().timestamp_millis();
    let utc_guess = local_ts - guess;
    let o2 = offset_ms(tz, utc_guess);
    if o2 == guess {
        return utc_guess;
    }
    let utc_guess = utc_guess - (o2 - guess);
    let o3 = offset_ms(tz, utc_guess);
    if o2 == o3 {
        return utc_guess;
    }
    local_ts - o2.min(o3)
}

const fn is_leap(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// The real number of days in a month.
const fn days_in(year: i32, month: u32) -> u32 {
    match month {
        2 if is_leap(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn day_start(date: NaiveDate) -> NaiveDateTime {
    date.and_hms_opt(0, 0, 0).unwrap_or_default()
}

/// `CronDate.addDay`: `plus({ days: 1 }).startOf('day')`.
fn add_day<Tz: TimeZone>(tz: &Tz, ms: i64) -> i64 {
    let l = local(tz, ms);
    let Some(date) = l.date().checked_add_days(Days::new(1)) else {
        return ms;
    };
    let moved = from_local(tz, date.and_time(l.time()), offset_ms(tz, ms));
    let start = day_start(local(tz, moved).date());
    from_local(tz, start, offset_ms(tz, moved))
}

/// `CronDate.addMonth`: `plus({ months: 1 }).startOf('month')`.
fn add_month<Tz: TimeZone>(tz: &Tz, ms: i64) -> i64 {
    let l = local(tz, ms);
    let (year, month) = if l.month() == 12 {
        (l.year() + 1, 1)
    } else {
        (l.year(), l.month() + 1)
    };
    let day = l.day().min(days_in(year, month));
    let Some(date) = NaiveDate::from_ymd_opt(year, month, day) else {
        return ms;
    };
    let moved = from_local(tz, date.and_time(l.time()), offset_ms(tz, ms));
    let m = local(tz, moved);
    let Some(first) = NaiveDate::from_ymd_opt(m.year(), m.month(), 1) else {
        return moved;
    };
    from_local(tz, day_start(first), offset_ms(tz, moved))
}

/// `plus(amount).startOf(unit)` for the time units, with `keep` the local
/// fields kept by `startOf`.
fn add_time<Tz: TimeZone>(tz: &Tz, ms: i64, amount: i64, unit: Unit) -> i64 {
    let moved = ms + amount;
    let l = local(tz, moved);
    let (h, m, s) = match unit {
        Unit::Hour => (l.hour(), 0, 0),
        Unit::Minute => (l.hour(), l.minute(), 0),
        Unit::Second | Unit::Day | Unit::Month => (l.hour(), l.minute(), l.second()),
    };
    let Some(fields) = l.date().and_hms_opt(h, m, s) else {
        return moved;
    };
    from_local(tz, fields, offset_ms(tz, moved))
}

/// `CronDate.addHour`.
fn add_hour<Tz: TimeZone>(tz: &Tz, ms: i64) -> i64 {
    let next = add_time(tz, ms, HOUR_MS, Unit::Hour);
    if next <= ms {
        next + HOUR_MS
    } else {
        next
    }
}

/// `CronDate.addMinute` / `addSecond`.
fn add_small<Tz: TimeZone>(tz: &Tz, ms: i64, unit: Unit) -> i64 {
    let amount = if unit == Unit::Minute { 60_000 } else { 1000 };
    let next = add_time(tz, ms, amount, unit);
    if next < ms {
        next + HOUR_MS
    } else {
        next
    }
}

/// `CronDate.subtractHour`: `minus({ hours: 1 }).endOf('hour')`, to the
/// second.
fn subtract_hour<Tz: TimeZone>(tz: &Tz, ms: i64) -> i64 {
    let moved = ms - HOUR_MS;
    let l = local(tz, moved);
    let Some(fields) = l.date().and_hms_opt(l.hour(), 59, 59) else {
        return moved;
    };
    let next = from_local(tz, fields, offset_ms(tz, moved));
    if next >= ms {
        next - HOUR_MS
    } else {
        next
    }
}

impl<Tz: TimeZone> CronIter<Tz> {
    /// An iterator starting after `current` (Unix milliseconds), giving up
    /// past `end` when one is set.
    #[must_use]
    pub const fn new(expr: CronExpr, tz: Tz, current: i64, end: Option<i64>) -> Self {
        Self {
            expr,
            tz,
            current,
            end,
            dst_start: None,
            dst_end: None,
        }
    }

    /// `_applyTimezoneShift(currentDate, 'add', unit)`.
    fn shift(&mut self, ms: i64, unit: Unit) -> i64 {
        let tz = &self.tz;
        match unit {
            Unit::Month | Unit::Day => {
                let next = if unit == Unit::Month {
                    add_month(tz, ms)
                } else {
                    add_day(tz, ms)
                };
                if next != ms {
                    return next;
                }
                let l = local(tz, next);
                if l.minute() == 0 && l.second() == 0 {
                    add_hour(tz, next)
                } else if l.minute() == 59 && l.second() == 59 {
                    subtract_hour(tz, next)
                } else {
                    next
                }
            }
            Unit::Hour | Unit::Minute | Unit::Second => {
                let previous = i64::from(local(tz, ms).hour());
                let next = if unit == Unit::Hour {
                    add_hour(tz, ms)
                } else {
                    add_small(tz, ms, unit)
                };
                let l = local(tz, next);
                let hour = i64::from(l.hour());
                let hour_set = self.expr.hour.len() != 24;
                if hour - previous == 2 {
                    if hour_set {
                        self.dst_start = Some(hour);
                    }
                } else if hour == previous && l.minute() == 0 && l.second() == 0 && hour_set {
                    self.dst_end = Some(hour);
                }
                next
            }
        }
    }

    /// `isLastWeekdayOfMonthMatch(expressions)`.
    fn last_weekday_match(&self, l: &NaiveDateTime) -> Result<bool, String> {
        let weekday = i64::from(l.weekday().num_days_from_sunday());
        let last = l.day() + 7 > days_in(l.year(), l.month());
        for atom in &self.expr.day_of_week {
            let Atom::Text(text) = atom else { continue };
            let Some(first) = text.chars().next().and_then(|c| c.to_digit(10)) else {
                return Err(format!(
                    "Invalid last weekday of the month expression: {text}"
                ));
            };
            if weekday == i64::from(first) % 7 && last {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// `next()`: the following matching moment (Unix milliseconds).
    ///
    /// # Errors
    ///
    /// `Out of the timespan range` past the end date, or the loop limit.
    pub fn next_after(&mut self) -> Result<i64, String> {
        let mut current = self.current;
        let start = current;
        let mut steps = 0;
        while steps < LOOP_LIMIT {
            steps += 1;
            if self.end.is_some_and(|end| end < current) {
                return Err(String::from("Out of the timespan range"));
            }
            let l = local(&self.tz, current);
            let e = &self.expr;
            let day = l.day();
            let month_day_ok = match_schedule(i64::from(day), &e.day_of_month)
                || (has_l(&e.day_of_month) && day == days_in(l.year(), l.month()));
            let weekday = i64::from(l.weekday().num_days_from_sunday());
            let week_day_ok = match_schedule(weekday, &e.day_of_week)
                || (has_l(&e.day_of_week) && self.last_weekday_match(&l)?);
            let month_len = usize::try_from(l.month0())
                .ok()
                .and_then(|m| DAYS_IN_MONTH.get(m))
                .copied()
                .unwrap_or(31);
            let any_month_day = e.day_of_month.len() >= month_len;
            let any_week_day = e.day_of_week.len() == 8;
            let hour = i64::from(l.hour());
            // cron-parser's three day checks (its second one, a restricted
            // day of month without a match under a wildcard weekday, is
            // covered by the first) and the `#` occurrence.
            let skip_day = (!month_day_ok && (!week_day_ok || any_week_day))
                || (any_month_day && !any_week_day && !week_day_ok)
                || (e.nth_day_of_week > 0.0 && !is_nth_day_match(day, e.nth_day_of_week));
            if skip_day {
                current = self.shift(current, Unit::Day);
                continue;
            }
            if !match_schedule(i64::from(l.month()), &e.month) {
                current = self.shift(current, Unit::Month);
                continue;
            }
            if !match_schedule(hour, &e.hour) {
                if self.dst_start != Some(hour) {
                    self.dst_start = None;
                    current = self.shift(current, Unit::Hour);
                    continue;
                } else if !match_schedule(hour - 1, &e.hour) {
                    current = add_hour(&self.tz, current);
                    continue;
                }
            } else if self.dst_end == Some(hour) {
                self.dst_end = None;
                current = self.shift(current, Unit::Hour);
                continue;
            }
            if !match_schedule(i64::from(l.minute()), &e.minute) {
                current = self.shift(current, Unit::Minute);
                continue;
            }
            if !match_schedule(i64::from(l.second()), &e.second) {
                current = self.shift(current, Unit::Second);
                continue;
            }
            if start == current {
                current = self.shift(current, Unit::Second);
                continue;
            }
            break;
        }
        if steps >= LOOP_LIMIT {
            return Err(String::from("Invalid expression, loop limit exceeded"));
        }
        self.current = current;
        Ok(current)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{FixedOffset, MappedLocalTime, Utc};

    fn ms(iso: &str) -> i64 {
        crate::clock::parse_date_millis(iso).unwrap_or_default()
    }

    fn iso(ms: i64) -> String {
        crate::clock::Utc::from_unix_millis(ms).iso_string()
    }

    fn run<Tz: TimeZone>(expr: &str, tz: Tz, from: &str, n: usize) -> Vec<String> {
        let parsed = CronExpr::parse(expr).unwrap_or_else(|e| CronExpr {
            second: vec![Atom::Text(e)],
            minute: Vec::new(),
            hour: Vec::new(),
            day_of_month: Vec::new(),
            month: Vec::new(),
            day_of_week: Vec::new(),
            nth_day_of_week: 0.0,
        });
        let mut it = CronIter::new(parsed, tz, ms(from), None);
        (0..n)
            .map(|_| it.next_after().map_or_else(|e| e, iso))
            .collect()
    }

    #[test]
    fn default_schedules() {
        assert_eq!(
            run("0 */5 * * * *", Utc, "2026-10-11T14:36:37.123Z", 2),
            ["2026-10-11T14:40:00.000Z", "2026-10-11T14:45:00.000Z"],
            "every five minutes"
        );
        assert_eq!(
            run("0 0 3 * * *", Utc, "2026-10-11T14:36:37.123Z", 2),
            ["2026-10-12T03:00:00.000Z", "2026-10-13T03:00:00.000Z"],
            "daily"
        );
        assert_eq!(
            run("0 30 1 */7 * *", Utc, "2026-10-11T00:00:00.000Z", 4),
            [
                "2026-10-15T01:30:00.000Z",
                "2026-10-22T01:30:00.000Z",
                "2026-10-29T01:30:00.000Z",
                "2026-11-01T01:30:00.000Z"
            ],
            "every seventh day"
        );
        assert_eq!(
            run("0 0 */6 * * *", Utc, "2026-10-11T18:00:00.000Z", 2),
            ["2026-10-12T00:00:00.000Z", "2026-10-12T06:00:00.000Z"],
            "an exact match moves on"
        );
        assert_eq!(
            run("* * * * *", Utc, "2026-10-11T14:36:37.123Z", 1),
            ["2026-10-11T14:37:00.000Z"],
            "five fields default the seconds to 0"
        );
        assert_eq!(
            run("", Utc, "2026-10-11T14:36:37.123Z", 1),
            ["2026-10-11T14:37:00.000Z"],
            "an empty expression is every minute"
        );
        assert_eq!(
            run("@daily", Utc, "2026-10-11T14:36:37.123Z", 1),
            ["2026-10-12T00:00:00.000Z"],
            "shortcut"
        );
    }

    #[test]
    fn day_fields() {
        assert_eq!(
            run("0 0 12 * * mon-fri", Utc, "2026-10-09T13:00:00.000Z", 2),
            ["2026-10-12T12:00:00.000Z", "2026-10-13T12:00:00.000Z"],
            "weekday names"
        );
        assert_eq!(
            run("0 0 0 * * 7", Utc, "2026-10-09T13:00:00.000Z", 1),
            ["2026-10-11T00:00:00.000Z"],
            "7 is Sunday"
        );
        assert_eq!(
            run("0 0 0 L * *", Utc, "2026-02-03T00:00:00.000Z", 2),
            ["2026-02-28T00:00:00.000Z", "2026-03-31T00:00:00.000Z"],
            "last day of the month"
        );
        assert_eq!(
            run("0 0 0 * * 5L", Utc, "2026-10-01T00:00:00.000Z", 1),
            ["2026-10-30T00:00:00.000Z"],
            "last Friday"
        );
        assert_eq!(
            run("0 0 0 * * 1#2", Utc, "2026-10-01T00:00:00.000Z", 2),
            ["2026-10-12T00:00:00.000Z", "2026-11-09T00:00:00.000Z"],
            "second Monday"
        );
        assert_eq!(
            run("0 0 0 1,15 * 5", Utc, "2026-10-01T00:00:00.000Z", 3),
            [
                "2026-10-02T00:00:00.000Z",
                "2026-10-09T00:00:00.000Z",
                "2026-10-15T00:00:00.000Z"
            ],
            "either day field matches"
        );
        assert_eq!(
            run("0 0 0 29 2 *", Utc, "2026-10-01T00:00:00.000Z", 1),
            ["2028-02-29T00:00:00.000Z"],
            "leap day"
        );
        assert_eq!(
            run("0 0 0 * * L", Utc, "2026-10-01T00:00:00.000Z", 1),
            ["Invalid last weekday of the month expression: L"],
            "a weekday L needs a day"
        );
    }

    #[test]
    fn rejects_what_cron_parser_rejects() {
        for bad in [
            "60 * * * * *",
            "* * * * * * *",
            "not a cron",
            "0 0 0 31 2 *",
            "0 0 0 30 2 *",
            "*/0 * * * * *",
            "5- * * * * *",
            "1,,2 * * * * *",
            "0 0 0 * * 1#6",
            "0 0 0 * * 1#2,3",
            "0 0 0 * * monday",
            "0 0 0 * foo *",
            "1/2/3 * * * * *",
        ] {
            assert!(CronExpr::parse(bad).is_err(), "{bad}");
        }
        for good in [
            "0-0 * * * * *",
            "05/15 * * * * *",
            "0 0 0 ? * *",
            "0 0 0 * JAN-mar SUN",
        ] {
            assert!(CronExpr::parse(good).is_ok(), "{good}");
        }
    }

    #[test]
    fn local_time() {
        let tz = FixedOffset::east_opt(3 * 3600).unwrap_or_else(|| Utc.fix());
        assert_eq!(
            run("0 0 3 * * *", tz, "2026-10-11T14:36:37.123Z", 1),
            ["2026-10-12T00:00:00.000Z"],
            "03:00 at +03:00"
        );
    }

    /// Central European time: +01:00, +02:00 from the last Sunday of March
    /// 01:00 UTC to the last Sunday of October 01:00 UTC (2026 only).
    #[derive(Debug, Clone, Copy)]
    struct Cet;

    impl TimeZone for Cet {
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
            FixedOffset::east_opt(3600).unwrap_or_else(|| Utc.fix())
        }

        fn offset_from_utc_datetime(&self, utc: &NaiveDateTime) -> FixedOffset {
            let t = utc.and_utc().timestamp_millis();
            let summer = (ms("2026-03-29T01:00:00Z")..ms("2026-10-25T01:00:00Z")).contains(&t);
            FixedOffset::east_opt(if summer { 7200 } else { 3600 }).unwrap_or_else(|| Utc.fix())
        }
    }

    #[test]
    fn dst_transitions() {
        // Node with TZ=Europe/Berlin gives the same moments.
        assert_eq!(
            run("0 30 2 * * *", Cet, "2026-03-28T12:00:00.000Z", 2),
            ["2026-03-29T01:30:00.000Z", "2026-03-30T00:30:00.000Z"],
            "a time in the spring gap"
        );
        assert_eq!(
            run("0 0 * * * *", Cet, "2026-03-28T23:30:00.000Z", 3),
            [
                "2026-03-29T00:00:00.000Z",
                "2026-03-29T01:00:00.000Z",
                "2026-03-29T02:00:00.000Z"
            ],
            "hourly over the spring change"
        );
        assert_eq!(
            run("0 30 2 * * *", Cet, "2026-10-24T12:00:00.000Z", 2),
            ["2026-10-25T00:30:00.000Z", "2026-10-26T01:30:00.000Z"],
            "a time repeated in autumn"
        );
        assert_eq!(
            run("0 0 * * * *", Cet, "2026-10-24T23:30:00.000Z", 3),
            [
                "2026-10-25T00:00:00.000Z",
                "2026-10-25T01:00:00.000Z",
                "2026-10-25T02:00:00.000Z"
            ],
            "hourly over the autumn change"
        );
    }
}
