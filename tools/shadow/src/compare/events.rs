//! Comparing one event's results: response and outgoing calls.

use std::collections::{BTreeSet, HashMap, HashSet};

use serde::Serialize;
use serde_json::Value;

use super::CompareConfig;
use crate::jsondiff::{self, canonical, Diff};
use crate::model::{header, Headers, ReplayResult};
use crate::urlnorm::redacted_url;

/// At most this many body differences are kept per event.
const MAX_BODY_DIFFS: usize = 200;

/// A header that differs: name, baseline value, candidate value.
pub type HeaderDiff = (String, Option<String>, Option<String>);

/// Differences found for one event.
#[derive(Debug, Default, Clone, Serialize)]
pub struct EventDiff {
    /// Status codes, when they differ.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<(Option<u16>, Option<u16>)>,
    /// Transport errors, when only one side had one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<(Option<String>, Option<String>)>,
    /// Compared headers that differ.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub headers: Vec<HeaderDiff>,
    /// JSON body differences.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub body: Vec<BodyDiff>,
    /// Non-JSON bodies differ (hashes).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_bytes: Option<(String, String)>,
    /// Outgoing calls only the baseline made.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub outgoing_missing: Vec<String>,
    /// Outgoing calls only the candidate made.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub outgoing_extra: Vec<String>,
    /// The candidate has no result for this event.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub missing: bool,
}

/// One JSON body difference.
#[derive(Debug, Clone, Serialize)]
pub struct BodyDiff {
    /// Exact JSON path.
    pub path: String,
    /// Path with array indices generalised.
    #[serde(skip)]
    pub generic: String,
    /// Baseline value; `None` when absent.
    pub baseline: Option<Value>,
    /// Candidate value; `None` when absent.
    pub candidate: Option<Value>,
}

impl EventDiff {
    /// Nothing differs.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.status.is_none()
            && self.error.is_none()
            && self.headers.is_empty()
            && self.body.is_empty()
            && self.body_bytes.is_none()
            && self.outgoing_missing.is_empty()
            && self.outgoing_extra.is_empty()
            && !self.missing
    }

    /// Names of the kinds of differences present.
    #[must_use]
    pub fn kinds(&self) -> Vec<&'static str> {
        [
            (self.missing, "missing"),
            (self.status.is_some(), "status"),
            (self.error.is_some(), "error"),
            (!self.headers.is_empty(), "headers"),
            (!self.body.is_empty() || self.body_bytes.is_some(), "body"),
            (
                !self.outgoing_missing.is_empty() || !self.outgoing_extra.is_empty(),
                "outgoing",
            ),
        ]
        .into_iter()
        .filter_map(|(present, name)| present.then_some(name))
        .collect()
    }
}

/// What the noise target taught us is not worth reporting.
#[derive(Debug, Default)]
pub struct Noise {
    paths: HashMap<String, HashSet<String>>,
    headers: HashMap<String, HashSet<String>>,
    flaky_status: HashSet<u64>,
    flaky_error: HashSet<u64>,
    text_routes: HashSet<String>,
    outgoing_routes: HashSet<String>,
}

impl Noise {
    /// Remember what differed between baseline and noise for this event.
    pub fn learn(&mut self, route: &str, seq: u64, d: &EventDiff) {
        if d.status.is_some() || d.missing {
            self.flaky_status.insert(seq);
        }
        if d.error.is_some() {
            self.flaky_error.insert(seq);
        }
        for (h, _, _) in &d.headers {
            self.headers
                .entry(route.to_owned())
                .or_default()
                .insert(h.clone());
        }
        for b in &d.body {
            self.paths
                .entry(route.to_owned())
                .or_default()
                .insert(b.generic.clone());
        }
        if d.body_bytes.is_some() {
            self.text_routes.insert(route.to_owned());
        }
        if !d.outgoing_missing.is_empty() || !d.outgoing_extra.is_empty() {
            self.outgoing_routes.insert(route.to_owned());
        }
    }

    /// Baseline and noise disagreed on this event's status.
    #[must_use]
    pub fn is_flaky(&self, seq: u64) -> bool {
        self.flaky_status.contains(&seq)
    }

    /// Drop the parts of `d` that the noise target also showed.
    #[must_use]
    pub fn filter(&self, route: &str, seq: u64, mut d: EventDiff) -> EventDiff {
        if self.flaky_status.contains(&seq) {
            d.status = None;
            d.missing = false;
        }
        if self.flaky_error.contains(&seq) {
            d.error = None;
        }
        if let Some(h) = self.headers.get(route) {
            d.headers.retain(|(name, _, _)| !h.contains(name));
        }
        if let Some(p) = self.paths.get(route) {
            d.body.retain(|b| !p.contains(&b.generic));
        }
        if self.text_routes.contains(route) {
            d.body_bytes = None;
        }
        if self.outgoing_routes.contains(route) {
            d.outgoing_missing.clear();
            d.outgoing_extra.clear();
        }
        d
    }
}

/// Compare two results for the same event.
#[must_use]
pub fn compare_event(
    a: &ReplayResult,
    b: &ReplayResult,
    cfg: &CompareConfig,
    outgoing: bool,
) -> EventDiff {
    let mut d = EventDiff {
        headers: header_diffs(&a.headers, &b.headers, &cfg.compare_headers),
        ..EventDiff::default()
    };
    if a.status != b.status {
        d.status = Some((a.status, b.status));
    }
    if a.error.is_some() != b.error.is_some() {
        d.error = Some((a.error.clone(), b.error.clone()));
    }
    match (a.body.json(), b.body.json()) {
        (Some(ja), Some(jb)) => d.body = body_diffs(ja, jb, cfg),
        _ => {
            if a.body.sha256 != b.body.sha256 && !(a.body.is_empty() && b.body.is_empty()) {
                d.body_bytes = Some((short(&a.body.sha256), short(&b.body.sha256)));
            }
        }
    }
    if outgoing {
        let (sa, sb) = (signatures(a, cfg), signatures(b, cfg));
        d.outgoing_missing = only_in(&sa, &sb);
        d.outgoing_extra = only_in(&sb, &sa);
    }
    d
}

fn header_diffs(a: &Headers, b: &Headers, names: &[String]) -> Vec<HeaderDiff> {
    let norm = |v: Option<&str>| v.map(|s| s.replace(' ', "").to_ascii_lowercase());
    let mut out: Vec<HeaderDiff> = names
        .iter()
        .filter_map(|name| {
            let (va, vb) = (header(a, name), header(b, name));
            (norm(va) != norm(vb))
                .then(|| (name.clone(), va.map(String::from), vb.map(String::from)))
        })
        .collect();
    let cookie_names = |h: &Headers| -> BTreeSet<String> {
        h.iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case("set-cookie"))
            .filter_map(|(_, v)| v.split('=').next().map(|n| n.trim().to_owned()))
            .collect()
    };
    let (ca, cb) = (cookie_names(a), cookie_names(b));
    if ca != cb {
        out.push((
            String::from("set-cookie"),
            Some(ca.into_iter().collect::<Vec<_>>().join(",")),
            Some(cb.into_iter().collect::<Vec<_>>().join(",")),
        ));
    }
    out
}

fn body_diffs(mut ja: Value, mut jb: Value, cfg: &CompareConfig) -> Vec<BodyDiff> {
    if cfg.mask_timestamps {
        jsondiff::mask_timestamps(&mut ja);
        jsondiff::mask_timestamps(&mut jb);
    }
    jsondiff::diff(&ja, &jb, MAX_BODY_DIFFS)
        .into_iter()
        .filter(|x: &Diff| {
            !cfg.ignore_paths
                .iter()
                .any(|p| jsondiff::matches(p, &x.path))
        })
        .filter(|x: &Diff| match (&x.a, &x.b) {
            (Some(a), Some(b)) => !jsondiff::close_timestamps(a, b, cfg.timestamp_tolerance_ms),
            _ => true,
        })
        .map(|x| BodyDiff {
            path: x.path,
            generic: x.generic,
            baseline: x.a,
            candidate: x.b,
        })
        .collect()
}

/// Outgoing calls as comparable strings, with their counts.
fn signatures(r: &ReplayResult, cfg: &CompareConfig) -> HashMap<String, usize> {
    let mut m = HashMap::new();
    for c in &r.outgoing {
        let body = c.body.json().map_or_else(
            || {
                if c.body.is_empty() {
                    String::new()
                } else {
                    format!(" <{} bytes {}>", c.body.len, short(&c.body.sha256))
                }
            },
            |v| format!(" {}", canonical(&v)),
        );
        let key = format!(
            "{} {}{body}",
            c.method,
            redacted_url(&c.url, &cfg.secret_params)
        );
        *m.entry(key).or_insert(0) += 1;
    }
    m
}

/// Calls in `a` that `b` didn't make (as many times as they're missing).
fn only_in(a: &HashMap<String, usize>, b: &HashMap<String, usize>) -> Vec<String> {
    let mut out: Vec<String> = a
        .iter()
        .flat_map(|(k, &n)| {
            std::iter::repeat_n(k.clone(), n.saturating_sub(b.get(k).copied().unwrap_or(0)))
        })
        .collect();
    out.sort();
    out
}

fn short(sha: &str) -> String {
    sha.chars().take(12).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Body, MatchKind, OutgoingCall};

    fn result(seq: u64, body: &str, outgoing: &[&str]) -> ReplayResult {
        ReplayResult {
            seq,
            kind: String::from("http"),
            label: format!("GET /api/v1/movie/{seq}"),
            status: Some(200),
            headers: vec![(
                String::from("content-type"),
                String::from("application/json; charset=utf-8"),
            )],
            body: Body::capture(body.as_bytes(), 1 << 20),
            duration_ms: 1,
            outgoing: outgoing
                .iter()
                .map(|u| OutgoingCall {
                    method: String::from("GET"),
                    url: (*u).to_owned(),
                    body: Body::default(),
                    matched: MatchKind::Exact,
                    recorded_id: None,
                })
                .collect(),
            ..ReplayResult::default()
        }
    }

    #[test]
    fn noise_is_filtered_per_route() {
        let cfg = CompareConfig::default();
        let base = result(1, r#"{"id":1,"title":"A","fetchedAt":"t1"}"#, &[]);
        let noise = result(1, r#"{"id":1,"title":"A","fetchedAt":"t2"}"#, &[]);
        let cand = result(1, r#"{"id":1,"title":"B","fetchedAt":"t3"}"#, &[]);
        let mut learned = Noise::default();
        learned.learn(
            "GET /api/v1/movie/:id",
            1,
            &compare_event(&base, &noise, &cfg, true),
        );
        let d = learned.filter(
            "GET /api/v1/movie/:id",
            1,
            compare_event(&base, &cand, &cfg, true),
        );
        let paths: Vec<&str> = d.body.iter().map(|b| b.path.as_str()).collect();
        assert_eq!(
            paths,
            vec!["$.title"],
            "fetchedAt is noise, title is a real difference"
        );
        assert_eq!(d.kinds(), vec!["body"], "only the body differs");
    }

    #[test]
    fn outgoing_multisets() {
        let cfg = CompareConfig::default();
        let a = result(
            1,
            "{}",
            &["https://x/a?b=1&a=2", "https://x/c", "https://x/c"],
        );
        let b = result(
            1,
            "{}",
            &["https://x/a?a=2&b=1", "https://x/c", "https://x/d"],
        );
        let d = compare_event(&a, &b, &cfg, true);
        assert_eq!(
            d.outgoing_missing,
            vec!["GET https://x/c"],
            "one of two calls missing"
        );
        assert_eq!(
            d.outgoing_extra,
            vec!["GET https://x/d"],
            "query order ignored"
        );
    }

    #[test]
    fn timestamps_within_tolerance_match() {
        let cfg = CompareConfig::default();
        let a = result(1, r#"{"at":"2026-10-10T10:00:00.000Z"}"#, &[]);
        let b = result(1, r#"{"at":"2026-10-10T10:00:01.000Z"}"#, &[]);
        assert!(
            compare_event(&a, &b, &cfg, true).is_empty(),
            "1s apart is within 5s"
        );
        let strict = CompareConfig {
            timestamp_tolerance_ms: 0,
            ..CompareConfig::default()
        };
        assert!(
            !compare_event(&a, &b, &strict, true).is_empty(),
            "no tolerance"
        );
    }
}
