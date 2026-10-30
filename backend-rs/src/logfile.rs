//! The log files `server/logger.ts` writes, for standalone mode (with Node
//! behind this server, Node keeps writing them).
//!
//! Two daily files under `LOG_DIRECTORY` (default `<config>/logs`):
//! `seerr-YYYY-MM-DD.log` in winston's `hformat`
//! (`<timestamp> [<level>][<label>]: <message> <metadata JSON>`), and
//! `.machinelogs-YYYY-MM-DD.json`, one `format.json()` object per line with
//! its keys sorted as `safe-stable-stringify` sorts them; the log viewer
//! (`GET /settings/logs`) reads the latter. `seerr.log` and
//! `.machinelogs.json` link to the current files, as `createSymlink` keeps
//! them. Files past 20 MB continue in `-YYYY-MM-DD.N`, and dated files
//! older than `maxFiles` (7 days, 1 day for the machine log) are removed.
//! The level is `LOG_LEVEL` (default `debug`), for this crate's events.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Sender};

use serde_json::{Map, Value};
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::Layer;

/// `maxSize: '20m'`.
const MAX_SIZE: u64 = 20 * 1024 * 1024;

/// One rotating file family.
struct Family {
    /// The part before the date: `seerr` or `.machinelogs`.
    stem: &'static str,
    /// `.log` or `.json`.
    ext: &'static str,
    /// The symlink `createSymlink` keeps.
    link: &'static str,
    /// `maxFiles`, in days.
    keep_days: i64,
}

const TEXT: Family = Family {
    stem: "seerr",
    ext: ".log",
    link: "seerr.log",
    keep_days: 7,
};

const MACHINE: Family = Family {
    stem: ".machinelogs",
    ext: ".json",
    link: ".machinelogs.json",
    keep_days: 1,
};

/// The open file of one family.
struct Open {
    date: String,
    index: u32,
    file: File,
    size: u64,
}

/// The writer thread's state.
struct Writer {
    dir: PathBuf,
    text: Option<Open>,
    machine: Option<Open>,
}

impl Writer {
    fn write(&mut self, date: &str, text_line: &str, machine_line: &str) {
        let dir = self.dir.clone();
        write_family(&dir, &TEXT, &mut self.text, date, text_line);
        write_family(&dir, &MACHINE, &mut self.machine, date, machine_line);
    }
}

fn file_name(family: &Family, date: &str, index: u32) -> String {
    if index == 0 {
        format!("{}-{date}{}", family.stem, family.ext)
    } else {
        format!("{}-{date}.{index}{}", family.stem, family.ext)
    }
}

/// Append one line, rotating by date and size first.
fn write_family(dir: &Path, family: &Family, open: &mut Option<Open>, date: &str, line: &str) {
    let bytes = u64::try_from(line.len())
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    let rotate = open
        .as_ref()
        .is_none_or(|o| o.date != date || o.size + bytes > MAX_SIZE && o.size > 0);
    if rotate {
        let index = match open.as_ref() {
            Some(o) if o.date == date => o.index + 1,
            _ => 0,
        };
        match open_family(dir, family, date, index) {
            Ok(next) => {
                *open = Some(next);
                prune(dir, family, date);
            }
            Err(e) => {
                report(&format!("Error in {} file transport: {e}", family.stem));
                return;
            }
        }
    }
    if let Some(o) = open.as_mut() {
        match writeln!(o.file, "{line}") {
            Ok(()) => o.size += bytes,
            Err(e) => report(&format!("Error in {} file transport: {e}", family.stem)),
        }
    }
}

/// Open (append) the family's file for `date`, starting at `index` and
/// moving past files already full, and point the symlink at it.
fn open_family(dir: &Path, family: &Family, date: &str, mut index: u32) -> std::io::Result<Open> {
    fs::create_dir_all(dir)?;
    loop {
        let name = file_name(family, date, index);
        let path = dir.join(&name);
        let size = fs::metadata(&path).map_or(0, |m| m.len());
        if size >= MAX_SIZE {
            index += 1;
            continue;
        }
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        relink(dir, family.link, &name);
        return Ok(Open {
            date: date.to_owned(),
            index,
            file,
            size,
        });
    }
}

#[cfg(unix)]
fn relink(dir: &Path, link: &str, target: &str) {
    let path = dir.join(link);
    if fs::read_link(&path).is_ok_and(|t| t == Path::new(target)) {
        return;
    }
    if let Err(e) = fs::remove_file(&path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            report(&format!("Error replacing {link}: {e}"));
        }
    }
    if let Err(e) = std::os::unix::fs::symlink(target, &path) {
        report(&format!("Error linking {link}: {e}"));
    }
}

#[cfg(not(unix))]
fn relink(_dir: &Path, _link: &str, _target: &str) {}

/// Remove the family's dated files older than `keep_days` before `today`.
fn prune(dir: &Path, family: &Family, today: &str) {
    let Ok(today) = chrono::NaiveDate::parse_from_str(today, "%Y-%m-%d") else {
        return;
    };
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let prefix = format!("{}-", family.stem);
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(rest) = name.strip_prefix(&prefix) else {
            continue;
        };
        let Some(date) = rest.get(..10) else { continue };
        let Ok(date) = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d") else {
            continue;
        };
        if (today - date).num_days() >= family.keep_days {
            if let Err(e) = fs::remove_file(entry.path()) {
                report(&format!("Error removing {name}: {e}"));
            }
        }
    }
}

/// The fields of one event: the message, the label, the rest as metadata
/// in the order they were written.
#[derive(Default)]
struct Fields {
    message: String,
    label: Option<String>,
    metadata: Map<String, Value>,
}

impl Visit for Fields {
    fn record_str(&mut self, field: &Field, value: &str) {
        match field.name() {
            "message" => value.clone_into(&mut self.message),
            "label" => self.label = Some(value.to_owned()),
            name => {
                self.metadata.insert(name.to_owned(), Value::from(value));
            }
        }
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.metadata
            .insert(field.name().to_owned(), Value::from(value));
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.metadata
            .insert(field.name().to_owned(), Value::from(value));
    }

    fn record_f64(&mut self, field: &Field, value: f64) {
        self.metadata
            .insert(field.name().to_owned(), Value::from(value));
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.metadata
            .insert(field.name().to_owned(), Value::from(value));
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.record_str(field, &format!("{value:?}"));
    }
}

/// winston's npm level names.
const fn level_name(level: Level) -> &'static str {
    match level {
        Level::ERROR => "error",
        Level::WARN => "warn",
        Level::INFO => "info",
        Level::DEBUG => "debug",
        Level::TRACE => "silly",
    }
}

/// `hformat`: `<timestamp> [<level>][<label>]: <message> ` and then the
/// metadata's JSON when there is any.
fn text_line(timestamp: &str, level: &str, fields: &Fields) -> String {
    let label = fields
        .label
        .as_ref()
        .map_or_else(String::new, |l| format!("[{l}]"));
    let mut line = format!("{timestamp} [{level}]{label}: {} ", fields.message);
    if !fields.metadata.is_empty() {
        line.push_str(&Value::Object(fields.metadata.clone()).to_string());
    }
    line
}

/// `format.json()`: every key, sorted (nested objects too).
fn machine_line(timestamp: &str, level: &str, fields: &Fields) -> String {
    let mut all = fields.metadata.clone();
    if let Some(label) = &fields.label {
        all.insert(String::from("label"), Value::from(label.as_str()));
    }
    all.insert(String::from("level"), Value::from(level));
    all.insert(
        String::from("message"),
        Value::from(fields.message.as_str()),
    );
    all.insert(String::from("timestamp"), Value::from(timestamp));
    sorted(Value::Object(all)).to_string()
}

fn sorted(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<(String, Value)> = map.into_iter().collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            Value::Object(entries.into_iter().map(|(k, v)| (k, sorted(v))).collect())
        }
        Value::Array(items) => Value::Array(items.into_iter().map(sorted).collect()),
        other @ (Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)) => other,
    }
}

/// A transport failure, on stderr as winston's `error` handlers print it
/// (the logger can't log its own failures).
fn report(message: &str) {
    std::io::stderr()
        .write_all(format!("{message}\n").as_bytes())
        .ok();
}

/// The layer: formats each event and hands it to the writer thread.
#[derive(Debug)]
pub struct FileLayer {
    lines: Sender<(String, String, String)>,
}

impl<S: Subscriber> Layer<S> for FileLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut fields = Fields::default();
        event.record(&mut fields);
        let now = chrono::Utc::now();
        let timestamp = now.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        let date = now
            .with_timezone(&chrono::Local)
            .format("%Y-%m-%d")
            .to_string();
        let level = level_name(*event.metadata().level());
        // The writer thread lives as long as the process; a send can't fail.
        self.lines
            .send((
                date,
                text_line(&timestamp, level, &fields),
                machine_line(&timestamp, level, &fields),
            ))
            .ok();
    }
}

/// `LOG_DIRECTORY`, or `<config>/logs`.
#[must_use]
pub fn directory(config_dir: &Path) -> PathBuf {
    std::env::var_os("LOG_DIRECTORY")
        .filter(|d| !d.is_empty())
        .map_or_else(|| config_dir.join("logs"), PathBuf::from)
}

/// `LOG_LEVEL` (winston's names; default `debug`) as a tracing level.
#[must_use]
pub fn level_from_env() -> Level {
    match std::env::var("LOG_LEVEL")
        .map(|l| l.to_lowercase())
        .as_deref()
    {
        Ok("error") => Level::ERROR,
        Ok("warn") => Level::WARN,
        Ok("info" | "http") => Level::INFO,
        Ok("silly") => Level::TRACE,
        Ok(_) | Err(_) => Level::DEBUG,
    }
}

/// The layer writing into `dir`, with its writer thread.
#[must_use]
pub fn layer(dir: PathBuf) -> FileLayer {
    let (lines, rx) = mpsc::channel::<(String, String, String)>();
    // Detached on purpose: the thread ends with the process.
    drop(std::thread::spawn(move || {
        let mut writer = Writer {
            dir,
            text: None,
            machine: None,
        };
        for (date, text, machine) in rx {
            writer.write(&date, &text, &machine);
        }
    }));
    FileLayer { lines }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields(label: Option<&str>, meta: &[(&str, Value)]) -> Fields {
        Fields {
            message: String::from("Starting scheduled job: Download Sync"),
            label: label.map(str::to_owned),
            metadata: meta
                .iter()
                .map(|(k, v)| ((*k).to_owned(), v.clone()))
                .collect(),
        }
    }

    #[test]
    fn formats_like_winston() {
        let ts = "2026-10-11T17:01:00.005Z";
        let plain = fields(Some("Jobs"), &[]);
        assert_eq!(
            text_line(ts, "debug", &plain),
            "2026-10-11T17:01:00.005Z [debug][Jobs]: Starting scheduled job: Download Sync "
        );
        assert_eq!(
            machine_line(ts, "debug", &plain),
            r#"{"label":"Jobs","level":"debug","message":"Starting scheduled job: Download Sync","timestamp":"2026-10-11T17:01:00.005Z"}"#
        );
        let meta = fields(
            None,
            &[("zeta", Value::from(1)), ("alpha", Value::from("a"))],
        );
        assert_eq!(
            text_line(ts, "info", &meta),
            r#"2026-10-11T17:01:00.005Z [info]: Starting scheduled job: Download Sync {"zeta":1,"alpha":"a"}"#
        );
        assert_eq!(
            machine_line(ts, "info", &meta),
            r#"{"alpha":"a","level":"info","message":"Starting scheduled job: Download Sync","timestamp":"2026-10-11T17:01:00.005Z","zeta":1}"#
        );
    }

    #[test]
    fn names_files_like_the_rotator() {
        assert_eq!(file_name(&TEXT, "2026-10-11", 0), "seerr-2026-10-11.log");
        assert_eq!(file_name(&TEXT, "2026-10-11", 2), "seerr-2026-10-11.2.log");
        assert_eq!(
            file_name(&MACHINE, "2026-10-11", 0),
            ".machinelogs-2026-10-11.json"
        );
    }
}
