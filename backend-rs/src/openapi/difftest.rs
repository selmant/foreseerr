//! Replays the corpus `scripts/openapi-diff.js` records from Node against
//! [`Validator::decide`]. Ignored by default; `scripts/openapi-diff.sh`
//! runs it with `OPENAPI_CORPUS` set.

use std::fmt::Write as _;
use std::io::Write as _;
use std::path::PathBuf;

use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, Uri};
use serde_json::{Map, Value};

use super::{Decision, Validator};

fn canon(value: &Value) -> Value {
    match value {
        Value::Number(n) => n.as_f64().map_or(Value::Null, crate::jsval::num),
        Value::Array(items) => Value::Array(items.iter().map(canon).collect()),
        Value::Object(map) => {
            Value::Object(map.iter().map(|(k, v)| (k.clone(), canon(v))).collect())
        }
        other @ (Value::Null | Value::Bool(_) | Value::String(_)) => other.clone(),
    }
}

fn text(value: &Value) -> String {
    serde_json::to_string(&canon(value)).unwrap_or_default()
}

fn spec_path() -> PathBuf {
    std::env::var_os("OPENAPI_SPEC").map_or_else(
        || PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../seerr-api.yml"),
        PathBuf::from,
    )
}

/// What Rust answers, in the corpus' terms: status and body text.
fn answer(decision: &Decision) -> (u16, String) {
    match decision {
        Decision::Unvalidated => (299, String::from("unvalidated")),
        Decision::Reject(r) => (r.status, serde_json::to_string(&r.body).unwrap_or_default()),
        Decision::Pass(v) => {
            let mut echo = Map::new();
            echo.insert(String::from("query"), Value::Object(v.query.clone()));
            echo.insert(String::from("params"), Value::Object(v.params.clone()));
            echo.insert(
                String::from("body"),
                v.body.clone().unwrap_or_else(|| Value::from("<undefined>")),
            );
            (299, text(&Value::Object(echo)))
        }
    }
}

/// Node's answer, in the same terms.
fn expected(record: &Value) -> (u16, String) {
    let status = record
        .get("status")
        .and_then(Value::as_u64)
        .and_then(|s| u16::try_from(s).ok())
        .unwrap_or(0);
    let body = record.get("response").and_then(Value::as_str).unwrap_or("");
    if record.get("method").and_then(Value::as_str) == Some("HEAD") {
        if status == 299 {
            return (299, String::from("head reaches the routes"));
        }
        return (
            status,
            format!(
                "length {}",
                record
                    .get("contentLength")
                    .and_then(Value::as_str)
                    .unwrap_or("")
            ),
        );
    }
    if status != 299 {
        return (status, body.to_owned());
    }
    let echo: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    if echo.get("matched") == Some(&Value::Bool(false)) {
        return (299, String::from("unvalidated"));
    }
    let mut out = Map::new();
    for key in ["query", "params", "body"] {
        out.insert(
            key.to_owned(),
            echo.get(key).cloned().unwrap_or(Value::Null),
        );
    }
    (299, text(&Value::Object(out)))
}

fn request(record: &Value) -> Option<(Method, Uri, HeaderMap, Option<Vec<u8>>)> {
    let method = Method::from_bytes(record.get("method")?.as_str()?.as_bytes()).ok()?;
    let uri: Uri = record.get("target")?.as_str()?.parse().ok()?;
    let mut headers = HeaderMap::new();
    for pair in record.get("headers")?.as_array()? {
        let name = HeaderName::from_bytes(pair.get(0)?.as_str()?.as_bytes()).ok()?;
        // An HTTP parser drops the whitespace around a value.
        let value = HeaderValue::from_str(pair.get(1)?.as_str()?.trim_matches([' ', '\t'])).ok()?;
        headers.append(name, value);
    }
    let body = record
        .get("body")
        .and_then(Value::as_str)
        .map(|b| b.as_bytes().to_vec())
        .or_else(|| {
            use base64::Engine as _;
            let b64 = record.get("bodyB64")?.as_str()?;
            base64::engine::general_purpose::STANDARD.decode(b64).ok()
        });
    Some((method, uri, headers, body))
}

/// Differences from Node that are on purpose: Rust words body-parser
/// failures itself (Node shows Bun's `JSON Parse error: …`); it refuses
/// JSON numbers past the double range (Bun reads `Infinity`) and lone
/// UTF-16 surrogates; and it validates absolute-form targets like any
/// other request (Node's validator skips them).
fn intended(want: &(u16, String), got: &(u16, String)) -> Option<&'static str> {
    if want.1 == "unvalidated" {
        return Some("absolute-form targets are validated");
    }
    let rust_parse = got.0 == 400 && got.1.contains("Invalid JSON body: ");
    if rust_parse && want.0 == 400 && want.1.contains("JSON Parse error: ") {
        return Some("body-parser wording");
    }
    if rust_parse && got.1.contains("number out of range") {
        return Some("a JSON number past f64 is refused");
    }
    if rust_parse && got.1.contains("hex escape") {
        return Some("a lone surrogate is refused");
    }
    None
}

/// `OPENAPI_CORPUS`, or `None` to skip. Under `CI` a missing corpus fails:
/// the job that runs these with `--ignored` must not pass vacuously.
fn corpus_path() -> Option<std::ffi::OsString> {
    let corpus = std::env::var_os("OPENAPI_CORPUS");
    assert!(
        corpus.is_some() || std::env::var_os("CI").is_none(),
        "CI is set but OPENAPI_CORPUS is not; run scripts/openapi-diff.sh"
    );
    corpus
}

#[test]
#[ignore = "needs the corpus from scripts/openapi-diff.js"]
fn openapi_differential() {
    let Some(corpus) = corpus_path() else {
        return;
    };
    let validator = Validator::load(&spec_path());
    assert!(validator.is_ok(), "the spec loads: {:?}", validator.err());
    let Ok(validator) = validator else { return };
    let text_in = std::fs::read_to_string(&corpus).unwrap_or_default();
    let (mut total, mut unreachable, mut sure, mut sure_ok, mut unsure, mut unsure_ok) =
        (0, 0, 0, 0, 0, 0);
    let mut shown = 0;
    let mut report = String::new();
    let mut reasons: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    let mut intended_counts: std::collections::BTreeMap<&str, usize> =
        std::collections::BTreeMap::new();
    for line in text_in.lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        total += 1;
        let Some((method, uri, headers, body)) = request(&record) else {
            unreachable += 1;
            continue;
        };
        let raw = Validator::needs_body(&headers).then_some(body.as_deref().unwrap_or_default());
        let verdict = validator.decide(&method, &uri, &headers, raw);
        let mut got = answer(&verdict.decision);
        if method == Method::HEAD {
            got.1 = match &verdict.decision {
                Decision::Reject(r) => format!(
                    "length {}",
                    serde_json::to_string(&r.body).unwrap_or_default().len()
                ),
                Decision::Pass(_) | Decision::Unvalidated => {
                    String::from("head reaches the routes")
                }
            };
        }
        let want = expected(&record);
        let ok = got == want;
        if let Some(why) = &verdict.unsure {
            unsure += 1;
            unsure_ok += usize::from(ok);
            *reasons.entry(why.clone()).or_default() += 1;
        } else if let Some(why) = (!ok).then(|| intended(&want, &got)).flatten() {
            *intended_counts.entry(why).or_default() += 1;
        } else {
            sure += 1;
            sure_ok += usize::from(ok);
            if !ok && shown < 40 {
                shown += 1;
                let note = record.get("note").and_then(Value::as_str).unwrap_or("");
                writeln!(
                    report,
                    "MISMATCH {method} {uri} [{note}]\n  node: {} {}\n  rust: {} {}",
                    want.0, want.1, got.0, got.1
                )
                .ok();
            }
        }
    }
    writeln!(
        report,
        "{total} requests: {unreachable} not representable as an http::Uri; certain {sure_ok}/{sure} match; unsure (forwarded in proxy mode) {unsure_ok}/{unsure} match"
    )
    .ok();
    for (why, n) in &reasons {
        writeln!(report, "  unsure: {n} x {why}").ok();
    }
    for (why, n) in &intended_counts {
        writeln!(report, "  intended difference: {n} x {why}").ok();
    }
    std::io::stderr().write_all(report.as_bytes()).ok();
    assert!(total > 0, "the corpus has requests");
    assert_eq!(sure_ok, sure, "every certain decision matches Node");
}

#[test]
#[ignore = "needs the spec JSON from scripts/openapi-diff.js"]
fn openapi_yaml_matches_js_yaml() {
    let Some(corpus) = corpus_path() else {
        return;
    };
    let json_path = corpus.to_string_lossy().replace(".jsonl", ".spec.json");
    let node: Value = serde_json::from_str(&std::fs::read_to_string(json_path).unwrap_or_default())
        .unwrap_or(Value::Null);
    let rust = super::yaml::load(&std::fs::read_to_string(spec_path()).unwrap_or_default())
        .unwrap_or(Value::Null);
    if text(&node) != text(&rust) {
        std::fs::write(
            format!("{}.rust.json", corpus.to_string_lossy()),
            text(&rust),
        )
        .ok();
    }
    assert!(
        text(&node) == text(&rust),
        "seerr-api.yml loads as js-yaml loads it"
    );
}
