//! winston's `Console` transport as `server/logger.ts` configures it.
//!
//! The managed runtimes' launchers read the console:
//! `<ISO timestamp> [<colourised level>][<label>]: <message> ` and the
//! metadata's JSON when there is any. Errors and warnings go to stderr and
//! the rest to stdout, except in the desktop runtime, whose stdout carries
//! only the readiness record: everything goes to stderr there.

use std::io::Write;

use serde_json::{Map, Value};
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::Layer;

/// The layer.
#[derive(Debug, Clone, Copy)]
pub struct ConsoleLayer {
    /// Every level on stderr (`stderrLevels` lists them all).
    all_stderr: bool,
}

/// The console layer of the current runtime.
#[must_use]
pub const fn layer(desktop: bool) -> ConsoleLayer {
    ConsoleLayer {
        all_stderr: desktop,
    }
}

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

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.metadata
            .insert(field.name().to_owned(), Value::from(value));
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.record_str(field, &format!("{value:?}"));
    }
}

/// `format.colorize()` with winston's npm colours.
const fn colour(level: Level) -> (&'static str, &'static str) {
    match level {
        Level::ERROR => ("\x1b[31m", "error"),
        Level::WARN => ("\x1b[33m", "warn"),
        Level::INFO => ("\x1b[32m", "info"),
        Level::DEBUG => ("\x1b[34m", "debug"),
        Level::TRACE => ("\x1b[35m", "silly"),
    }
}

/// `hformat` over the colourised level.
fn line(timestamp: &str, level: Level, fields: &Fields) -> String {
    let (start, name) = colour(level);
    let label = fields
        .label
        .as_ref()
        .map_or_else(String::new, |l| format!("[{l}]"));
    let mut out = format!(
        "{timestamp} [{start}{name}\x1b[39m]{label}: {} ",
        fields.message
    );
    if !fields.metadata.is_empty() {
        out.push_str(&Value::Object(fields.metadata.clone()).to_string());
    }
    out.push('\n');
    out
}

impl<S: Subscriber> Layer<S> for ConsoleLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut fields = Fields::default();
        event.record(&mut fields);
        let timestamp = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let level = *event.metadata().level();
        let text = line(&timestamp, level, &fields);
        let to_stderr = self.all_stderr || level <= Level::WARN;
        let written = if to_stderr {
            std::io::stderr().lock().write_all(text.as_bytes())
        } else {
            std::io::stdout().lock().write_all(text.as_bytes())
        };
        // A closed console (EPIPE) is ignored, as launcher.js does.
        written.ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_like_winston_console() {
        let mut fields = Fields {
            message: String::from("Server ready on 127.0.0.1 port 7501"),
            label: Some(String::from("Server")),
            metadata: Map::new(),
        };
        assert_eq!(
            line("2026-10-11T17:22:16.086Z", Level::INFO, &fields),
            "2026-10-11T17:22:16.086Z [\x1b[32minfo\x1b[39m][Server]: Server ready on 127.0.0.1 port 7501 \n",
            "info with label"
        );
        fields.label = None;
        fields
            .metadata
            .insert(String::from("userId"), Value::from(1));
        assert_eq!(
            line("t", Level::WARN, &fields),
            "t [\x1b[33mwarn\x1b[39m]: Server ready on 127.0.0.1 port 7501 {\"userId\":1}\n",
            "metadata"
        );
    }
}
