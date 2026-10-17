//! `shadow compare`: what did the candidate do differently from the baseline?
//!
//! Three things are compared, event by event and at the end:
//!
//! 1. **Responses**: status, selected headers, and the body (structurally,
//!    when it is JSON).
//! 2. **Outgoing calls**: what each backend asked TMDB/Sonarr/Plex to do.
//! 3. **Databases**: the first event after which a table's digest diverged,
//!    and a row-by-row diff of the final state.
//!
//! When the run has a `noise` target (a second copy of the baseline),
//! anything that differs between baseline and noise is treated as noise and
//! not held against the candidate.

pub mod dbdiff;
pub mod events;
pub mod render;

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use clap::Args;
use serde::{Deserialize, Serialize};

use crate::db::{DbDump, DbFilter};
use crate::model::{read_json, read_jsonl, MatchKind, ReplayResult, RunMeta, TrafficEvent};
use crate::replay::Role;
use crate::urlnorm::route_of;
use dbdiff::DbReport;
use events::{compare_event, EventDiff, Noise};

/// Options for `shadow compare`.
#[derive(Args, Debug)]
pub struct CompareArgs {
    /// Replay output directory (the one containing run.json).
    pub run: PathBuf,
    /// The replay config; its `[compare]` and `[db]` sections are used.
    #[arg(long, short)]
    pub config: Option<PathBuf>,
    /// Only compare these candidates (default: all).
    #[arg(long)]
    pub candidate: Vec<String>,
    /// Also compare the baseline's replayed responses with the responses the
    /// real backend gave while recording. Shows how faithful the replay is.
    #[arg(long)]
    pub against_recording: bool,
    /// How many example differences to print per candidate.
    #[arg(long, default_value_t = 20)]
    pub max_examples: usize,
    /// Exit 0 even when differences are found.
    #[arg(long)]
    pub no_fail: bool,
}

/// The `[compare]` section of the replay config.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompareConfig {
    /// JSON paths to ignore in response bodies, e.g. `updatedAt` or
    /// `$.results[*].media.lastSeasonChange`. See [`crate::jsondiff::matches`].
    #[serde(default)]
    pub ignore_paths: Vec<String>,
    /// Response headers compared by value (Set-Cookie is compared by name).
    #[serde(default = "default_headers")]
    pub compare_headers: Vec<String>,
    /// Routes left out entirely, e.g. `GET /api/v1/status` or `/api/v1/settings/logs`.
    #[serde(default)]
    pub ignore_routes: Vec<String>,
    /// Treat every ISO timestamp in bodies as equal.
    #[serde(default)]
    pub mask_timestamps: bool,
    /// Timestamps (in bodies and DB cells) this close count as equal. Targets
    /// run in lockstep, so "now" values only differ by a little.
    #[serde(default = "default_tolerance")]
    pub timestamp_tolerance_ms: u64,
    /// Query parameters shown as a short hash in reports instead of their value.
    #[serde(default = "default_secret_params")]
    pub secret_params: Vec<String>,
}

fn default_secret_params() -> Vec<String> {
    [
        "api_key",
        "apikey",
        "x-plex-token",
        "token",
        "access_token",
        "api_token",
        "password",
        "client_secret",
    ]
    .map(String::from)
    .to_vec()
}

const fn default_tolerance() -> u64 {
    5_000
}

fn default_headers() -> Vec<String> {
    vec![String::from("content-type"), String::from("location")]
}

impl Default for CompareConfig {
    fn default() -> Self {
        Self {
            ignore_paths: Vec::new(),
            compare_headers: default_headers(),
            ignore_routes: Vec::new(),
            mask_timestamps: false,
            timestamp_tolerance_ms: default_tolerance(),
            secret_params: default_secret_params(),
        }
    }
}

/// One target's results, loaded from a run directory.
#[derive(Debug)]
pub struct Side {
    /// Target name.
    pub name: String,
    /// Results by event sequence number.
    pub results: BTreeMap<u64, ReplayResult>,
    /// Final database state, when dumped.
    pub db: Option<DbDump>,
    /// The recording itself: no outgoing calls or DB to compare.
    pub recorded: bool,
}

/// Everything `compare` found, as written to report.json.
#[derive(Debug, Serialize)]
pub struct Report {
    /// Run directory.
    pub run: String,
    /// Baseline target name.
    pub baseline: String,
    /// Noise target names.
    pub noise: Vec<String>,
    /// One entry per compared candidate.
    pub candidates: Vec<CandidateReport>,
}

/// Findings for one candidate.
#[derive(Debug, Serialize)]
pub struct CandidateReport {
    /// Candidate name.
    pub name: String,
    /// Events compared.
    pub events: usize,
    /// Events without differences.
    pub matching: usize,
    /// Events with differences.
    pub differing: usize,
    /// Events ignored because baseline and noise disagreed on the status.
    pub flaky: usize,
    /// Outgoing calls with no recorded answer, per target.
    pub unmatched_upstream: BTreeMap<String, usize>,
    /// Routes with at least one difference, worst first.
    pub routes: Vec<RouteSummary>,
    /// Every differing event.
    pub findings: Vec<Finding>,
    /// Database comparison (not for `--against-recording`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub db: Option<DbReport>,
}

impl CandidateReport {
    /// No differences that count.
    #[must_use]
    pub fn is_clean(&self) -> bool {
        self.differing == 0
            && self
                .db
                .as_ref()
                .is_none_or(|d| d.tables.is_empty() && d.first_divergence.iter().all(|x| x.noisy))
    }
}

/// Differences grouped by route.
#[derive(Debug, Serialize)]
pub struct RouteSummary {
    /// `METHOD /path/:id`.
    pub route: String,
    /// Events on this route.
    pub events: usize,
    /// Events with differences.
    pub differing: usize,
    /// Kinds of differences seen.
    pub kinds: BTreeSet<String>,
}

/// One differing event.
#[derive(Debug, Serialize)]
pub struct Finding {
    /// Event sequence number.
    pub seq: u64,
    /// `METHOD /uri` or `job id`.
    pub label: String,
    /// Route the event belongs to.
    pub route: String,
    /// Kinds of differences.
    pub kinds: Vec<&'static str>,
    /// The differences.
    pub diff: EventDiff,
}

/// Compare a replay run. Returns whether the result counts as a pass.
///
/// # Errors
///
/// Fails when the run or config can't be read, or there is nothing to compare.
pub fn run(args: &CompareArgs) -> Result<bool> {
    let (cfg, db_filter) = match &args.config {
        Some(p) => {
            let file = crate::replay::read_config(p)?;
            (file.compare.unwrap_or_default(), file.db)
        }
        None => (CompareConfig::default(), crate::replay::default_db_filter()),
    };

    let meta: RunMeta = read_json(&args.run.join("run.json"))?;
    let base_t = meta
        .targets
        .iter()
        .find(|t| t.role == Role::Baseline)
        .context("run has no baseline")?;
    let baseline = load_side(&args.run, &base_t.name, &base_t.dir)?;
    let noise: Vec<Side> = meta
        .targets
        .iter()
        .filter(|t| t.role == Role::Noise)
        .map(|t| load_side(&args.run, &t.name, &t.dir))
        .collect::<Result<_>>()?;
    let mut candidates: Vec<Side> = meta
        .targets
        .iter()
        .filter(|t| t.role == Role::Candidate)
        .filter(|t| args.candidate.is_empty() || args.candidate.contains(&t.name))
        .map(|t| load_side(&args.run, &t.name, &t.dir))
        .collect::<Result<_>>()?;
    if args.against_recording {
        candidates.push(recorded_side(Path::new(&meta.recording))?);
    }
    if candidates.is_empty() {
        bail!("nothing to compare: the run has no candidate targets (try --against-recording)");
    }
    if noise.is_empty() {
        tracing::warn!("no noise target: timestamps and random values will show up as differences");
    }

    let learned = learn_noise(&baseline, &noise, &cfg);
    let report = Report {
        run: args.run.display().to_string(),
        baseline: baseline.name.clone(),
        noise: noise.iter().map(|n| n.name.clone()).collect(),
        candidates: candidates
            .iter()
            .map(|cand| compare_candidate(&baseline, &noise, cand, &cfg, &db_filter, &learned))
            .collect(),
    };

    let md = render::markdown(&report, args.max_examples)?;
    std::fs::write(args.run.join("report.md"), md)?;
    crate::model::write_json(&args.run.join("report.json"), &report)?;
    let mut out = std::io::stdout().lock();
    writeln!(out, "{}", render::summary(&report)?)?;
    writeln!(out, "full report: {}", args.run.join("report.md").display())?;

    let clean = report.candidates.iter().all(CandidateReport::is_clean);
    Ok(clean || args.no_fail)
}

fn load_side(run: &Path, name: &str, dir: &str) -> Result<Side> {
    let d = run.join(dir);
    let results: Vec<ReplayResult> = read_jsonl(&d.join("results.jsonl"))?;
    let db_path = d.join("db.json");
    let db = if db_path.exists() {
        Some(read_json(&db_path)?)
    } else {
        None
    };
    Ok(Side {
        name: name.to_owned(),
        results: results.into_iter().map(|r| (r.seq, r)).collect(),
        db,
        recorded: false,
    })
}

/// The recording's own responses, shaped like replay results.
fn recorded_side(recording: &Path) -> Result<Side> {
    let events: Vec<TrafficEvent> = read_jsonl(&recording.join("traffic.jsonl"))?;
    let mut results = BTreeMap::new();
    for e in events {
        let TrafficEvent::Http(h) = e else {
            continue;
        };
        let h = *h;
        if let Some(resp) = h.response {
            results.insert(
                h.seq,
                ReplayResult {
                    seq: h.seq,
                    kind: String::from("http"),
                    label: format!("{} {}", h.request.method, h.request.uri),
                    status: Some(resp.status),
                    headers: resp.headers,
                    body: resp.body,
                    duration_ms: h.duration_ms,
                    ..ReplayResult::default()
                },
            );
        }
    }
    Ok(Side {
        name: String::from("recording"),
        results,
        db: None,
        recorded: true,
    })
}

/// Learn noise strictly (no timestamp tolerance): any value that moves
/// between two copies of the baseline is volatile.
fn learn_noise(baseline: &Side, noise: &[Side], cfg: &CompareConfig) -> Noise {
    let strict = CompareConfig {
        timestamp_tolerance_ms: 0,
        ..cfg.clone()
    };
    let mut learned = Noise::default();
    for n in noise {
        for (seq, b) in &baseline.results {
            let d = n.results.get(seq).map_or_else(
                || EventDiff {
                    missing: true,
                    ..EventDiff::default()
                },
                |r| compare_event(b, r, &strict, true),
            );
            learned.learn(&route_key(b), *seq, &d);
        }
    }
    learned
}

fn route_key(r: &ReplayResult) -> String {
    match r.label.split_once(' ') {
        Some((method, uri)) if r.kind == "http" => format!("{method} {}", route_of(uri)),
        Some(_) | None => r.label.clone(),
    }
}

fn route_ignored(cfg: &CompareConfig, route: &str) -> bool {
    cfg.ignore_routes.iter().any(|p| {
        if p.contains(' ') {
            route.starts_with(p.as_str())
        } else {
            route
                .split_once(' ')
                .is_some_and(|(_, path)| path.starts_with(p.as_str()))
        }
    })
}

fn compare_candidate(
    baseline: &Side,
    noise: &[Side],
    cand: &Side,
    cfg: &CompareConfig,
    db_filter: &DbFilter,
    learned: &Noise,
) -> CandidateReport {
    // The recording happened at another time: wall-clock values can't match.
    let recorded_cfg = CompareConfig {
        mask_timestamps: true,
        ..cfg.clone()
    };
    let mut findings = Vec::new();
    let mut routes: BTreeMap<String, RouteSummary> = BTreeMap::new();
    let (mut matching, mut flaky, mut events) = (0, 0, 0);
    for (seq, b) in &baseline.results {
        let route = route_key(b);
        // The recording has no job events or outgoing calls to compare.
        if route_ignored(cfg, &route) || (cand.recorded && b.kind != "http") {
            continue;
        }
        events += 1;
        if learned.is_flaky(*seq) {
            flaky += 1;
        }
        let raw = match cand.results.get(seq) {
            Some(c) if cand.recorded => compare_event(b, c, &recorded_cfg, false),
            Some(c) => compare_event(b, c, cfg, true),
            None => EventDiff {
                missing: true,
                ..EventDiff::default()
            },
        };
        let d = learned.filter(&route, *seq, raw);
        let entry = routes.entry(route.clone()).or_insert_with(|| RouteSummary {
            route: route.clone(),
            events: 0,
            differing: 0,
            kinds: BTreeSet::new(),
        });
        entry.events += 1;
        if d.is_empty() {
            matching += 1;
        } else {
            entry.differing += 1;
            let kinds = d.kinds();
            entry.kinds.extend(kinds.iter().map(|k| String::from(*k)));
            findings.push(Finding {
                seq: *seq,
                label: b.label.clone(),
                route,
                kinds,
                diff: d,
            });
        }
    }

    let mut routes: Vec<RouteSummary> = routes.into_values().filter(|r| r.differing > 0).collect();
    routes.sort_by(|a, b| {
        b.differing
            .cmp(&a.differing)
            .then_with(|| a.route.cmp(&b.route))
    });
    CandidateReport {
        name: cand.name.clone(),
        events,
        matching,
        differing: findings.len(),
        flaky,
        unmatched_upstream: if cand.recorded {
            BTreeMap::new()
        } else {
            unmatched_counts(baseline, noise, cand)
        },
        routes,
        findings,
        db: (!cand.recorded).then(|| {
            dbdiff::compare_dbs(baseline, noise, cand, db_filter, cfg.timestamp_tolerance_ms)
        }),
    }
}

fn unmatched_counts(baseline: &Side, noise: &[Side], cand: &Side) -> BTreeMap<String, usize> {
    std::iter::once(baseline)
        .chain(noise)
        .chain(std::iter::once(cand))
        .map(|side| {
            let n = side
                .results
                .values()
                .flat_map(|r| &r.outgoing)
                .filter(|c| c.matched == MatchKind::None)
                .count();
            (side.name.clone(), n)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_group_ids_and_respect_ignores() {
        let r = ReplayResult {
            kind: String::from("http"),
            label: String::from("GET /api/v1/movie/550?language=en"),
            ..ReplayResult::default()
        };
        assert_eq!(route_key(&r), "GET /api/v1/movie/:id", "ids grouped");
        let job = ReplayResult {
            kind: String::from("job"),
            label: String::from("job radarr-scan"),
            ..ReplayResult::default()
        };
        assert_eq!(route_key(&job), "job radarr-scan", "jobs keep their label");
        let cfg = CompareConfig {
            ignore_routes: vec![
                String::from("/api/v1/movie"),
                String::from("POST /api/v1/request"),
            ],
            ..CompareConfig::default()
        };
        assert!(
            route_ignored(&cfg, "GET /api/v1/movie/:id"),
            "path prefix, any method"
        );
        assert!(
            route_ignored(&cfg, "POST /api/v1/request"),
            "method and path"
        );
        assert!(!route_ignored(&cfg, "GET /api/v1/request"), "other method");
    }
}
