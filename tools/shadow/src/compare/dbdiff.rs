//! Comparing databases: checkpoints during the run and the final state.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde::Serialize;
use serde_json::Value;

use super::Side;
use crate::db::{row_key, DbDump, DbFilter, TableDump};
use crate::jsondiff::{self, canonical};

/// Database findings for one candidate.
#[derive(Debug, Default, Serialize)]
pub struct DbReport {
    /// First event after which each table's digest diverged.
    pub first_divergence: Vec<Divergence>,
    /// Tables whose checkpoints differ between baseline and noise, so they
    /// can't be judged event by event.
    pub noisy_checkpoint_tables: Vec<String>,
    /// Tables that differ in the final state.
    pub tables: Vec<TableDiff>,
    /// Columns ignored because baseline and noise disagree on them.
    pub noisy_columns: Vec<String>,
}

/// Where a table first diverged.
#[derive(Debug, Serialize)]
pub struct Divergence {
    /// Table name.
    pub table: String,
    /// Event after which it differed.
    pub seq: u64,
    /// That event's label.
    pub label: String,
    /// Baseline digest.
    pub baseline: String,
    /// Candidate digest.
    pub candidate: String,
    /// The table also differs between baseline and noise at other
    /// checkpoints, so this may be timing rather than a bug.
    pub noisy: bool,
}

/// How one table differs in the final state.
#[derive(Debug, Default, Serialize)]
pub struct TableDiff {
    /// Table name.
    pub table: String,
    /// Row count in the baseline.
    pub baseline_rows: usize,
    /// Row count in the candidate.
    pub candidate_rows: usize,
    /// Keys of rows only the baseline has.
    pub missing: Vec<String>,
    /// Keys of rows only the candidate has.
    pub extra: Vec<String>,
    /// Rows present in both with different values.
    pub changed: Vec<RowDiff>,
    /// The candidate has no such table.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub table_missing: bool,
    /// Only the candidate has this table.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub table_extra: bool,
}

impl TableDiff {
    fn is_empty(&self) -> bool {
        self.missing.is_empty()
            && self.extra.is_empty()
            && self.changed.is_empty()
            && !self.table_missing
            && !self.table_extra
    }
}

/// Columns that differ in one row: name -> (baseline, candidate).
#[derive(Debug, Serialize)]
pub struct RowDiff {
    /// Row key.
    pub key: String,
    /// Differing columns.
    pub columns: BTreeMap<String, (Value, Value)>,
}

/// Compare the candidate's database with the baseline's.
#[must_use]
pub fn compare_dbs(
    baseline: &Side,
    noise: &[Side],
    cand: &Side,
    filter: &DbFilter,
    tolerance_ms: u64,
) -> DbReport {
    let noisy_tables = noisy_checkpoint_tables(baseline, noise);
    let first_divergence = divergences(baseline, noise, cand, &noisy_tables);
    let mut report = DbReport {
        first_divergence,
        noisy_checkpoint_tables: noisy_tables.into_iter().collect(),
        ..DbReport::default()
    };
    if let (Some(bdb), Some(cdb)) = (&baseline.db, &cand.db) {
        final_state(&mut report, bdb, cdb, noise, filter, tolerance_ms);
    }
    report
}

/// Tables where baseline and noise ever disagree are timing-sensitive.
fn noisy_checkpoint_tables(baseline: &Side, noise: &[Side]) -> BTreeSet<String> {
    let mut tables = BTreeSet::new();
    for (seq, b) in &baseline.results {
        let Some(bd) = &b.db_digest else {
            continue;
        };
        for nd in noise
            .iter()
            .filter_map(|n| n.results.get(seq).and_then(|r| r.db_digest.as_ref()))
        {
            for (t, h) in bd {
                if nd.get(t) != Some(h) {
                    tables.insert(t.clone());
                }
            }
        }
    }
    tables
}

/// First checkpoint where each table's digest diverged.
fn divergences(
    baseline: &Side,
    noise: &[Side],
    cand: &Side,
    noisy_tables: &BTreeSet<String>,
) -> Vec<Divergence> {
    let mut out = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (seq, b) in &baseline.results {
        let Some(bd) = &b.db_digest else {
            continue;
        };
        let Some(cd) = cand.results.get(seq).and_then(|r| r.db_digest.as_ref()) else {
            continue;
        };
        let noise_digests: Vec<&BTreeMap<String, String>> = noise
            .iter()
            .filter_map(|n| n.results.get(seq).and_then(|r| r.db_digest.as_ref()))
            .collect();
        let tables: BTreeSet<&String> = bd.keys().chain(cd.keys()).collect();
        for t in tables {
            if seen.contains(t.as_str()) || bd.get(t) == cd.get(t) {
                continue;
            }
            // At this checkpoint the noise copy disagrees too: not evidence.
            if noise_digests.iter().any(|nd| nd.get(t) != bd.get(t)) {
                continue;
            }
            seen.insert(t.clone());
            out.push(Divergence {
                table: t.clone(),
                seq: *seq,
                label: b.label.clone(),
                baseline: bd.get(t).cloned().unwrap_or_else(|| String::from("absent")),
                candidate: cd.get(t).cloned().unwrap_or_else(|| String::from("absent")),
                noisy: noisy_tables.contains(t.as_str()),
            });
        }
    }
    out
}

/// Row-by-row diff of the final databases, minus what the noise copies
/// disagree on.
fn final_state(
    report: &mut DbReport,
    bdb: &DbDump,
    cdb: &DbDump,
    noise: &[Side],
    filter: &DbFilter,
    tolerance_ms: u64,
) {
    let mut noisy_cols: HashSet<String> = HashSet::new();
    let mut noisy_rows: HashSet<String> = HashSet::new();
    for ndb in noise.iter().filter_map(|n| n.db.as_ref()) {
        for (t, td) in bdb {
            let Some(nt) = ndb.get(t) else {
                continue;
            };
            let d = diff_table(t, td, nt, filter, &HashSet::new(), 0);
            if !d.missing.is_empty() || !d.extra.is_empty() {
                noisy_rows.insert(t.clone());
            }
            for row in &d.changed {
                noisy_cols.extend(row.columns.keys().map(|c| format!("{t}.{c}")));
            }
        }
    }
    let mut cols: Vec<String> = noisy_cols.iter().cloned().collect();
    cols.sort();
    report.noisy_columns = cols;

    let tables: BTreeSet<&String> = bdb.keys().chain(cdb.keys()).collect();
    for t in tables {
        if filter.skips_table(t) {
            continue;
        }
        let d = match (bdb.get(t), cdb.get(t)) {
            (Some(bt), Some(ct)) => {
                let mut d = diff_table(t, bt, ct, filter, &noisy_cols, tolerance_ms);
                if noisy_rows.contains(t.as_str()) {
                    d.missing.clear();
                    d.extra.clear();
                }
                d
            }
            (Some(bt), None) => TableDiff {
                table: t.clone(),
                baseline_rows: bt.rows.len(),
                table_missing: true,
                ..TableDiff::default()
            },
            (None, Some(ct)) => TableDiff {
                table: t.clone(),
                candidate_rows: ct.rows.len(),
                table_extra: true,
                ..TableDiff::default()
            },
            (None, None) => continue,
        };
        if !d.is_empty() {
            report.tables.push(d);
        }
    }
}

fn diff_table(
    table: &str,
    a: &TableDump,
    b: &TableDump,
    filter: &DbFilter,
    noisy_cols: &HashSet<String>,
    tolerance_ms: u64,
) -> TableDiff {
    let (ia, ib) = (index_rows(a), index_rows(b));
    let mut d = TableDiff {
        table: table.to_owned(),
        baseline_rows: a.rows.len(),
        candidate_rows: b.rows.len(),
        ..TableDiff::default()
    };
    for (k, ra) in &ia {
        let Some(rb) = ib.get(k) else {
            d.missing.push(k.clone());
            continue;
        };
        let names: BTreeSet<&String> = ra.keys().chain(rb.keys()).collect();
        let columns: BTreeMap<String, (Value, Value)> = names
            .into_iter()
            .filter(|c| {
                !filter.skips_column(table, c) && !noisy_cols.contains(&format!("{table}.{c}"))
            })
            .filter_map(|c| {
                let va = ra.get(c).cloned().unwrap_or(Value::Null);
                let vb = rb.get(c).cloned().unwrap_or(Value::Null);
                let same =
                    same_cell(&va, &vb) || jsondiff::close_timestamps(&va, &vb, tolerance_ms);
                (!same).then(|| (c.clone(), (va, vb)))
            })
            .collect();
        if !columns.is_empty() {
            d.changed.push(RowDiff {
                key: k.clone(),
                columns,
            });
        }
    }
    d.extra = ib
        .keys()
        .filter(|k| !ia.contains_key(*k))
        .cloned()
        .collect();
    d
}

/// Rows by key.
fn index_rows(td: &TableDump) -> BTreeMap<String, &serde_json::Map<String, Value>> {
    td.rows.iter().map(|r| (row_key(td, r), r)).collect()
}

fn same_cell(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => jsondiff::numbers_equal(x, y),
        // JSON stored in text columns: compare parsed, ignoring key order.
        (Value::String(x), Value::String(y)) if x != y => {
            match (
                serde_json::from_str::<Value>(x),
                serde_json::from_str::<Value>(y),
            ) {
                (Ok(px), Ok(py)) if px.is_object() || px.is_array() => {
                    canonical(&px) == canonical(&py)
                }
                _ => false,
            }
        }
        _ => a == b,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::{Context, Result};

    fn table(rows: Vec<Value>) -> Result<TableDump> {
        Ok(TableDump {
            columns: vec![
                String::from("id"),
                String::from("status"),
                String::from("updatedAt"),
            ],
            key: vec![String::from("id")],
            rows: rows
                .into_iter()
                .map(|v| v.as_object().cloned().context("row is an object"))
                .collect::<Result<_>>()?,
        })
    }

    #[test]
    fn table_diff_finds_changes() -> Result<()> {
        let a = table(vec![
            serde_json::json!({"id": 1, "status": 2, "updatedAt": "x"}),
            serde_json::json!({"id": 2, "status": 1, "updatedAt": "x"}),
        ])?;
        let b = table(vec![
            serde_json::json!({"id": 1, "status": 3, "updatedAt": "y"}),
            serde_json::json!({"id": 3, "status": 1, "updatedAt": "y"}),
        ])?;
        let filter = DbFilter {
            ignore_tables: vec![],
            ignore_columns: vec![String::from("updatedAt")],
        };
        let d = diff_table("media", &a, &b, &filter, &HashSet::new(), 0);
        assert_eq!(d.missing, vec!["2"], "row 2 only in baseline");
        assert_eq!(d.extra, vec!["3"], "row 3 only in candidate");
        let changed: Vec<(&str, Vec<&String>)> = d
            .changed
            .iter()
            .map(|r| (r.key.as_str(), r.columns.keys().collect()))
            .collect();
        assert_eq!(
            changed,
            vec![("1", vec![&String::from("status")])],
            "updatedAt ignored"
        );
        Ok(())
    }

    #[test]
    fn json_text_cells_ignore_key_order() {
        assert!(
            same_cell(
                &Value::String(String::from(r#"{"a":1,"b":2}"#)),
                &Value::String(String::from(r#"{"b":2,"a":1}"#))
            ),
            "same JSON, different key order"
        );
        assert!(
            !same_cell(
                &Value::String(String::from("x")),
                &Value::String(String::from("y"))
            ),
            "different text"
        );
        assert!(
            same_cell(&serde_json::json!(1), &serde_json::json!(1.0)),
            "1 and 1.0 are equal"
        );
    }
}
