//! Path ids and numeric query values, read as plain integers.
//!
//! A path id or a numeric query value that isn't a whole number (`1.5`,
//! `1e2`, `0x10`, `Infinity`) is a bad parameter: the request gets a 400
//! (in proxy mode Node still answers it).

use serde_json::{Map, Value};

use super::{Fallback, Ready};
use crate::jsval::decode_uri_component;

/// `req.params[name]` for the path segment `depth` places from the end:
/// the segment percent-decoded. `None` when it doesn't decode.
pub(super) fn param(ctx: &Ready<'_>, depth: usize) -> Option<String> {
    ctx.req
        .uri
        .path()
        .rsplit('/')
        .nth(depth)
        .and_then(decode_uri_component)
}

/// The path segment `depth` places from the end as an integer id.
///
/// # Errors
///
/// A 400 when the segment isn't an integer.
pub(super) fn path_int(ctx: &Ready<'_>, depth: usize) -> Result<i64, Fallback> {
    param(ctx, depth)
        .as_deref()
        .and_then(integer)
        .ok_or_else(|| Fallback::status(400, "The id in the path must be an integer."))
}

/// `text` as a decimal integer (an optional sign, then digits).
pub(super) fn integer(text: &str) -> Option<i64> {
    let digits = text.strip_prefix(['-', '+']).unwrap_or(text);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// `req.query` once the validator ran (with its coercion and defaults);
/// `None` when it wasn't sure of it.
pub(super) fn query(ctx: &Ready<'_>) -> Option<Map<String, Value>> {
    ctx.validated().map(|validated| validated.query.clone())
}

/// A numeric query value as an integer: `Ok(None)` when it is missing or
/// null.
///
/// # Errors
///
/// A 400 when the value isn't a whole number.
pub(super) fn int(value: Option<&Value>, key: &str) -> Result<Option<i64>, Fallback> {
    let bad = || Fallback::status(400, format!("{key} must be an integer."));
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n.as_i64().map(Some).ok_or_else(bad),
        Some(Value::String(s)) => integer(s.trim()).map(Some).ok_or_else(bad),
        Some(Value::Array(items)) => int(items.first(), key),
        Some(Value::Bool(_) | Value::Object(_)) => Err(bad()),
    }
}

/// `Number(value) || fallback` for an integer query value: a missing or
/// zero value takes the fallback.
///
/// # Errors
///
/// A 400 when the value isn't a whole number.
pub(super) fn int_or(value: Option<&Value>, key: &str, fallback: i64) -> Result<i64, Fallback> {
    Ok(int(value, key)?.filter(|n| *n != 0).unwrap_or(fallback))
}

/// `take` (`Number(take) || take_default`) and `skip` (`Number(skip) || 0`)
/// of a list route.
///
/// # Errors
///
/// A 400 when either isn't a whole number, `take` is negative or `skip`
/// is negative.
pub(super) fn take_skip(q: &Map<String, Value>, take_default: i64) -> Result<(i64, i64), Fallback> {
    let take = int_or(q.get("take"), "take", take_default)?;
    let skip = int_or(q.get("skip"), "skip", 0)?;
    if take < 0 {
        return Err(Fallback::status(400, "take must not be negative."));
    }
    if skip < 0 {
        return Err(Fallback::status(400, "skip must not be negative."));
    }
    Ok((take, skip))
}

/// `{ pages, pageSize, results, page }` of a list route.
pub(super) fn page_info(take: i64, skip: i64, total: i64) -> Map<String, Value> {
    let size = take.max(1);
    let mut info = Map::new();
    info.insert(
        String::from("pages"),
        Value::from((total + size - 1) / size),
    );
    info.insert(String::from("pageSize"), Value::from(take));
    info.insert(String::from("results"), Value::from(total));
    info.insert(
        String::from("page"),
        Value::from((skip + size - 1) / size + 1),
    );
    info
}

/// An optional integer field of a JSON body: `Ok(None)` when absent.
///
/// # Errors
///
/// A 400 when the value isn't a whole number.
pub(super) fn body_int(body: &Map<String, Value>, key: &str) -> Result<Option<i64>, Fallback> {
    body.get(key).map_or(Ok(None), |v| {
        v.as_i64()
            .map(Some)
            .ok_or_else(|| Fallback::status(400, format!("{key} must be an integer.")))
    })
}

/// Whether a query value is truthy (`value ? ... : ...`).
pub(super) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// The indices `array.slice(start, end)` takes for whole, non-negative
/// bounds.
pub(super) fn slice_range(len: usize, start: i64, end: i64) -> std::ops::Range<usize> {
    let clamp = |n: i64| usize::try_from(n.max(0)).unwrap_or(usize::MAX).min(len);
    let from = clamp(start);
    from..clamp(end).max(from)
}

/// A length or count as a JSON integer.
pub(super) fn count(n: usize) -> i64 {
    i64::try_from(n).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn integers_only() {
        assert_eq!(integer("42"), Some(42), "plain");
        assert_eq!(integer("-3"), Some(-3), "negative");
        assert_eq!(integer("+7"), Some(7), "explicit sign");
        for odd in ["1e2", "0x10", "1.5", "Infinity", "", " 1", "-", "1_000"] {
            assert_eq!(integer(odd), None, "{odd:?}");
        }
    }

    #[test]
    fn query_values() {
        assert_eq!(int(Some(&json!(3)), "page"), Ok(Some(3)), "number");
        assert_eq!(int(Some(&json!("4")), "page"), Ok(Some(4)), "text");
        assert_eq!(int(None, "page"), Ok(None), "missing");
        assert_eq!(int(Some(&Value::Null), "page"), Ok(None), "null");
        let bad = int(Some(&json!(1.5)), "page");
        assert_eq!(
            bad,
            Err(Fallback::status(400, "page must be an integer.")),
            "a fraction"
        );
        assert!(int(Some(&json!("1e2")), "take").is_err(), "an exponent");
        assert_eq!(int_or(Some(&json!(0)), "page", 1), Ok(1), "0 || 1");
        assert_eq!(int_or(None, "page", 1), Ok(1), "missing");
        assert!(truthy(Some(&json!("0"))), "a non-empty string");
        assert!(!truthy(Some(&json!(0))), "zero");
    }

    #[test]
    fn slices() {
        assert_eq!(slice_range(30, 10, 30), 10..30, "a page");
        assert_eq!(slice_range(30, 40, 60), 30..30, "past the end");
        assert_eq!(slice_range(30, -5, 20), 0..20, "a negative start");
    }

    async fn answer(
        fallback: Fallback,
        validated: bool,
    ) -> Result<(u16, String), Box<dyn std::error::Error>> {
        use http_body_util::BodyExt;
        let mut head = axum::http::Request::builder()
            .uri("/api/v1/request/1e2")
            .body(())?
            .into_parts()
            .0;
        if validated {
            head.extensions.insert(crate::openapi::Validated {
                query: Map::new(),
                params: Map::new(),
                body: None,
            });
        }
        let res = fallback.respond(&head);
        let status = res.status().as_u16();
        let bytes = res.into_body().collect().await?.to_bytes();
        Ok((status, String::from_utf8(bytes.to_vec())?))
    }

    #[tokio::test]
    async fn standalone_answers() -> Result<(), Box<dyn std::error::Error>> {
        assert_eq!(
            answer(Fallback::from("listing requests failed"), true).await?,
            (
                500,
                String::from(r#"{"message":"listing requests failed"}"#)
            ),
            "an internal failure"
        );
        assert_eq!(
            answer(Fallback::from("a body that isn't an object"), false)
                .await?
                .0,
            400,
            "input the validator didn't vouch for"
        );
        assert_eq!(
            answer(Fallback::status(400, "take must be an integer."), true).await?,
            (
                400,
                String::from(r#"{"message":"take must be an integer."}"#)
            ),
            "a bad parameter"
        );
        assert_eq!(
            answer(Fallback::forbidden("no user"), true).await?,
            (
                403,
                String::from(
                    r#"{"status":403,"error":"You do not have permission to access this endpoint"}"#
                )
            ),
            "isAuthenticated"
        );
        assert_eq!(
            answer(Fallback::not_own_profile(), false).await?.0,
            403,
            "isOwnProfile"
        );
        Ok(())
    }

    #[test]
    fn body_integers() {
        let Value::Object(body) = json!({"a": 2, "b": 1.5, "c": "3"}) else {
            return;
        };
        assert_eq!(body_int(&body, "a"), Ok(Some(2)), "integer");
        assert_eq!(body_int(&body, "z"), Ok(None), "missing");
        assert_eq!(
            body_int(&body, "b"),
            Err(Fallback::status(400, "b must be an integer.")),
            "no REAL for an integer column"
        );
        assert!(body_int(&body, "c").is_err(), "text");
    }

    #[test]
    fn take_and_skip() {
        let Value::Object(q) = json!({"take": 0, "skip": "40"}) else {
            return;
        };
        assert_eq!(take_skip(&q, 20), Ok((20, 40)), "0 takes the default");
        let Value::Object(q) = json!({"skip": -1}) else {
            return;
        };
        assert!(take_skip(&q, 20).is_err(), "negative skip");
        assert_eq!(
            page_info(20, 40, 45),
            json!({"pages": 3, "pageSize": 20, "results": 45, "page": 3})
                .as_object()
                .cloned()
                .unwrap_or_default(),
            "page info"
        );
    }
}
