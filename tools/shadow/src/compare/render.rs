//! Turning a [`Report`] into Markdown and a console summary.

use std::fmt::{self, Write};

use serde_json::Value;

use super::dbdiff::DbReport;
use super::{CandidateReport, Finding, Report};

/// Body differences listed per finding before "and N more".
const BODY_LINES: usize = 15;
/// Changed rows listed per table before "and N more".
const ROW_LINES: usize = 10;

/// One line per candidate.
///
/// # Errors
///
/// Only if formatting into a `String` fails, which it doesn't.
pub fn summary(r: &Report) -> Result<String, fmt::Error> {
    let mut s = String::new();
    for c in &r.candidates {
        let db_tables = c.db.as_ref().map_or(0, |d| d.tables.len());
        let div = c.db.as_ref().map_or(0, |d| {
            d.first_divergence.iter().filter(|x| !x.noisy).count()
        });
        writeln!(
            s,
            "{} vs {}: {}/{} events match, {} differ ({} flaky ignored); DB: {db_tables} tables differ at the end, {div} diverged mid-run",
            c.name, r.baseline, c.matching, c.events, c.differing, c.flaky
        )?;
    }
    Ok(s.trim_end().to_owned())
}

/// The full Markdown report.
///
/// # Errors
///
/// Only if formatting into a `String` fails, which it doesn't.
pub fn markdown(r: &Report, max_examples: usize) -> Result<String, fmt::Error> {
    let mut s = String::new();
    writeln!(s, "# Shadow comparison\n")?;
    writeln!(s, "- Run: `{}`\n- Baseline: `{}`", r.run, r.baseline)?;
    if r.noise.is_empty() {
        writeln!(
            s,
            "- Noise targets: none (timestamps and random values are reported as differences)"
        )?;
    } else {
        writeln!(s, "- Noise targets: {}", code_list(&r.noise))?;
    }
    writeln!(s)?;
    writeln!(
        s,
        "| Candidate | Events | Match | Differ | Flaky (ignored) | DB tables differing | Unmatched upstream calls |"
    )?;
    writeln!(s, "|---|---:|---:|---:|---:|---:|---|")?;
    for c in &r.candidates {
        let unmatched = c
            .unmatched_upstream
            .iter()
            .map(|(k, v)| format!("{k}: {v}"))
            .collect::<Vec<_>>()
            .join(", ");
        writeln!(
            s,
            "| `{}` | {} | {} | {} | {} | {} | {} |",
            c.name,
            c.events,
            c.matching,
            c.differing,
            c.flaky,
            c.db.as_ref()
                .map_or_else(|| String::from("n/a"), |d| d.tables.len().to_string()),
            if unmatched.is_empty() {
                String::from("n/a")
            } else {
                unmatched
            }
        )?;
    }
    for c in &r.candidates {
        candidate(&mut s, c, max_examples)?;
        if let Some(db) = &c.db {
            database(&mut s, db)?;
        }
    }
    Ok(s)
}

fn candidate(s: &mut String, c: &CandidateReport, max_examples: usize) -> fmt::Result {
    writeln!(s, "\n## `{}`\n", c.name)?;
    if c.routes.is_empty() {
        return writeln!(s, "All compared responses and outgoing calls match.");
    }
    writeln!(
        s,
        "### Routes with differences\n\n| Route | Differing / events | What differs |\n|---|---:|---|"
    )?;
    for rt in &c.routes {
        writeln!(
            s,
            "| `{}` | {}/{} | {} |",
            rt.route,
            rt.differing,
            rt.events,
            rt.kinds.iter().cloned().collect::<Vec<_>>().join(", ")
        )?;
    }
    writeln!(
        s,
        "\n### First {} differences",
        max_examples.min(c.findings.len())
    )?;
    for f in c.findings.iter().take(max_examples) {
        finding(s, f)?;
    }
    Ok(())
}

fn finding(s: &mut String, f: &Finding) -> fmt::Result {
    writeln!(s, "\n#### seq {} `{}`\n", f.seq, f.label)?;
    let d = &f.diff;
    if d.missing {
        writeln!(s, "- the candidate has no result for this event")?;
    }
    if let Some((a, b)) = &d.status {
        writeln!(
            s,
            "- status: baseline `{}`, candidate `{}`",
            opt(a.as_ref()),
            opt(b.as_ref())
        )?;
    }
    if let Some((a, b)) = &d.error {
        writeln!(
            s,
            "- error: baseline `{}`, candidate `{}`",
            opt(a.as_ref()),
            opt(b.as_ref())
        )?;
    }
    for (h, a, b) in &d.headers {
        writeln!(
            s,
            "- header `{h}`: baseline `{}`, candidate `{}`",
            opt(a.as_ref()),
            opt(b.as_ref())
        )?;
    }
    if let Some((a, b)) = &d.body_bytes {
        writeln!(s, "- body differs (sha256 {a}… vs {b}…)")?;
    }
    for b in d.body.iter().take(BODY_LINES) {
        writeln!(
            s,
            "- `{}`: baseline {}, candidate {}",
            b.path,
            value_brief(b.baseline.as_ref()),
            value_brief(b.candidate.as_ref())
        )?;
    }
    if d.body.len() > BODY_LINES {
        writeln!(
            s,
            "- … and {} more body differences",
            d.body.len() - BODY_LINES
        )?;
    }
    for o in &d.outgoing_missing {
        writeln!(
            s,
            "- outgoing call only the baseline made: `{}`",
            truncate(o, 300)
        )?;
    }
    for o in &d.outgoing_extra {
        writeln!(
            s,
            "- outgoing call only the candidate made: `{}`",
            truncate(o, 300)
        )?;
    }
    Ok(())
}

fn database(s: &mut String, db: &DbReport) -> fmt::Result {
    writeln!(s, "\n### Database\n")?;
    if db.first_divergence.is_empty() {
        writeln!(s, "No table diverged at any checkpoint.")?;
    } else {
        writeln!(
            s,
            "First event after which each table differed:\n\n| Table | seq | Event | Note |\n|---|---:|---|---|"
        )?;
        for d in &db.first_divergence {
            let note = if d.noisy {
                "noisy table, may be timing"
            } else {
                ""
            };
            writeln!(s, "| `{}` | {} | `{}` | {note} |", d.table, d.seq, d.label)?;
        }
    }
    if !db.noisy_checkpoint_tables.is_empty() {
        writeln!(
            s,
            "\nCheckpoints can't judge these tables because the baseline and noise copies differ on them \
             (add their volatile columns to `[db] ignore_columns`): {}",
            code_list(&db.noisy_checkpoint_tables)
        )?;
    }
    if db.tables.is_empty() {
        writeln!(s, "\nFinal databases match.")?;
    } else {
        writeln!(s, "\nFinal state:")?;
        for t in &db.tables {
            write!(
                s,
                "\n- `{}` ({} rows vs {})",
                t.table, t.baseline_rows, t.candidate_rows
            )?;
            if t.table_missing {
                write!(s, ": table missing in candidate")?;
            }
            if t.table_extra {
                write!(s, ": table only exists in candidate")?;
            }
            writeln!(s)?;
            if !t.missing.is_empty() {
                writeln!(s, "  - rows only in baseline: {}", keys_brief(&t.missing))?;
            }
            if !t.extra.is_empty() {
                writeln!(s, "  - rows only in candidate: {}", keys_brief(&t.extra))?;
            }
            for row in t.changed.iter().take(ROW_LINES) {
                let cols = row
                    .columns
                    .iter()
                    .map(|(c, (a, b))| {
                        format!("`{c}` {} → {}", value_brief(Some(a)), value_brief(Some(b)))
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                writeln!(s, "  - row `{}`: {cols}", row.key)?;
            }
            if t.changed.len() > ROW_LINES {
                writeln!(
                    s,
                    "  - … and {} more changed rows",
                    t.changed.len() - ROW_LINES
                )?;
            }
        }
    }
    if !db.noisy_columns.is_empty() {
        writeln!(
            s,
            "\nIgnored as noise (baseline and noise copies disagree): {}",
            code_list(&db.noisy_columns)
        )?;
    }
    Ok(())
}

fn code_list(items: &[String]) -> String {
    items
        .iter()
        .map(|n| format!("`{n}`"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn opt<T: fmt::Display>(v: Option<&T>) -> String {
    v.map_or_else(|| String::from("none"), ToString::to_string)
}

fn value_brief(v: Option<&Value>) -> String {
    v.map_or_else(
        || String::from("(absent)"),
        |v| format!("`{}`", truncate(&v.to_string(), 120)),
    )
}

fn keys_brief(keys: &[String]) -> String {
    let shown: Vec<String> = keys.iter().take(10).map(|k| format!("`{k}`")).collect();
    if keys.len() > 10 {
        format!("{} … ({} total)", shown.join(", "), keys.len())
    } else {
        shown.join(", ")
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_owned()
    } else {
        format!("{}…", s.chars().take(n).collect::<String>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncates_by_characters() {
        assert_eq!(truncate("héllo", 2), "hé…", "multi-byte safe");
        assert_eq!(truncate("hi", 5), "hi", "short strings untouched");
    }

    #[test]
    fn empty_report_renders() -> Result<(), fmt::Error> {
        let r = Report {
            run: String::from("run"),
            baseline: String::from("release"),
            noise: Vec::new(),
            candidates: Vec::new(),
        };
        let md = markdown(&r, 5)?;
        assert!(
            md.contains("Noise targets: none"),
            "mentions missing noise target"
        );
        assert_eq!(summary(&r)?, "", "no candidates, no lines");
        Ok(())
    }
}
