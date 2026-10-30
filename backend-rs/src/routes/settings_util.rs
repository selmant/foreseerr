//! Helpers shared by the settings writes: the `OpenAPI` body checks they
//! rely on, JavaScript string semantics, the settings document as Node
//! holds it in memory, and Node's in-process side effects.

use anyhow::Result;
use serde_json::{json, Map, Value};

use super::{Outcome, Ready};

/// What a body property must be for the `OpenAPI` validator to let it
/// through (as far as these routes go).
#[derive(Debug, Clone, Copy)]
pub(super) enum Ty {
    /// `type: boolean`.
    Bool,
    /// `type: number`.
    Num,
    /// `type: integer`.
    Int,
    /// `type: integer` with `minimum` and `maximum`.
    IntRange(i64, i64),
    /// `type: string`.
    Str,
    /// `type: string, nullable: true`.
    NullStr,
    /// `type: number, nullable: true`.
    NullNum,
    /// `type: boolean, nullable: true`.
    NullBool,
    /// `type: string` with an `enum`.
    Enum(&'static [&'static str]),
    /// `type: object` with these properties.
    Obj(&'static [(&'static str, Self)]),
    /// `readOnly: true`: the validator refuses it in a request.
    ReadOnly,
}

/// The parsed body of a route whose spec requires one. A request without
/// a JSON body (Express 5 leaves `req.body` undefined) is the validator's
/// to refuse, so it goes to Node.
///
/// Once the validator passed the request, its body is what Node's handler
/// reads; see [`body_undefined`] for a request it passed without one.
pub(super) fn json_body<'a>(ctx: &'a Ready<'a>) -> Result<&'a Value, String> {
    use axum::http::header::{CONTENT_LENGTH, CONTENT_TYPE, TRANSFER_ENCODING};
    if ctx.validated().is_some() {
        return ctx
            .body
            .as_ref()
            .ok_or_else(|| String::from("req.body is undefined"));
    }
    let headers = &ctx.req.headers;
    let json_type = headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|t| t.split(';').next())
        .is_some_and(|t| t.trim().eq_ignore_ascii_case("application/json"));
    let has_body = headers.contains_key(TRANSFER_ENCODING)
        || headers
            .get(CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok())
            .is_some_and(|n| n > 0);
    match &ctx.body {
        Some(body) if json_type && has_body => Ok(body),
        _ => Err(String::from("no JSON body; the validator decides")),
    }
}

/// The validator passed the request without a body: Node's handler runs
/// with `req.body` undefined.
pub(super) fn body_undefined(ctx: &Ready<'_>) -> bool {
    ctx.validated().is_some() && ctx.body.is_none()
}

/// A route without a request body in the spec: only bare requests are
/// answered here.
pub(super) fn no_body(ctx: &Ready<'_>) -> Result<(), String> {
    match &ctx.body {
        None => Ok(()),
        Some(Value::Object(o)) if o.is_empty() => Ok(()),
        Some(_) => Err(String::from("an unexpected body")),
    }
}

/// A JSON number JavaScript sees as an integer (`5.0` parses to `5`).
pub(super) fn js_integer(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| {
        v.as_f64()
            .filter(|f| f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0)
            .and_then(|f| format!("{f:.0}").parse().ok())
    })
}

fn fits(ty: Ty, v: &Value) -> bool {
    match ty {
        Ty::Bool => v.is_boolean(),
        Ty::Num => v.is_number(),
        Ty::Int => js_integer(v).is_some(),
        Ty::IntRange(min, max) => js_integer(v).is_some_and(|i| (min..=max).contains(&i)),
        Ty::Str => v.is_string(),
        Ty::NullStr => v.is_string() || v.is_null(),
        Ty::NullNum => v.is_number() || v.is_null(),
        Ty::NullBool => v.is_boolean() || v.is_null(),
        Ty::Enum(allowed) => v.as_str().is_some_and(|s| allowed.contains(&s)),
        Ty::Obj(props) => conforms(v, props, &[]),
        Ty::ReadOnly => false,
    }
}

/// Whether `body` is an object whose listed properties have the listed
/// types and whose required properties are present. Other properties are
/// allowed, as the spec doesn't forbid them.
pub(super) fn conforms(body: &Value, props: &[(&str, Ty)], required: &[&str]) -> bool {
    let Some(object) = body.as_object() else {
        return false;
    };
    required.iter().all(|k| object.contains_key(*k))
        && props
            .iter()
            .all(|(k, ty)| object.get(*k).is_none_or(|v| fits(*ty, v)))
}

/// JavaScript's `WhiteSpace` and `LineTerminator`, which `trim` removes.
const fn js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `String.prototype.trim`.
pub(super) fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

/// `String(value ?? '').trim()` for a body property the validator has
/// already checked is a string when present.
pub(super) fn body_text(body: &Value, key: &str) -> String {
    body.get(key)
        .and_then(Value::as_str)
        .map_or_else(String::new, |s| js_trim(s).to_owned())
}

/// `body[key] !== false`.
pub(super) fn not_false(body: &Value, key: &str) -> bool {
    !matches!(body.get(key), Some(Value::Bool(false)))
}

/// `body[key] === true`.
pub(super) fn is_true(body: &Value, key: &str) -> bool {
    matches!(body.get(key), Some(Value::Bool(true)))
}

/// The settings document as Node holds it: `API_KEY` replaces the stored
/// key in memory at load, so every save writes it.
pub(super) fn node_memory(ctx: &Ready<'_>) -> Value {
    let mut data = ctx.settings.data().clone();
    let key = ctx.settings.api_key();
    if key != ctx.settings.str("/main/apiKey") {
        if let Some(main) = data.get_mut("main").and_then(Value::as_object_mut) {
            main.insert(String::from("apiKey"), Value::from(key));
        }
    }
    data
}

/// One change made to the latest settings as Node holds them and saved
/// (see [`Ready::mutate_settings`]). A reason from `change` hands the
/// request on with nothing written; a failed save is answered here, as it
/// may have written part of the file.
pub(super) async fn change_settings<T>(
    ctx: &Ready<'_>,
    change: impl FnOnce(&mut Value) -> Result<T, String>,
) -> Result<T, Outcome> {
    super::nodestate::mutate(ctx, |doc| {
        change(doc).map_err(|why| Box::new(Outcome::forward(why)))
    })
    .await
}

/// `mergeSettings(current, incoming)` as a setter runs it: objects merge
/// key by key, arrays and everything else replace. A missing section is
/// created.
pub(super) fn assign_merged(data: &mut Value, section: &str, incoming: Value) {
    if let Some(object) = data.as_object_mut() {
        match object.get_mut(section) {
            Some(current) => crate::settings::merge(current, incoming),
            None => {
                object.insert(section.to_owned(), incoming);
            }
        }
    }
}

/// `settings.mediaActions = { providers: { ... } }` with one provider set.
pub(super) fn set_provider(data: &mut Value, provider: &str, enabled: bool) {
    let mut providers = Map::new();
    providers.insert(provider.to_owned(), Value::Bool(enabled));
    assign_merged(
        data,
        "mediaActions",
        json!({ "providers": Value::Object(providers) }),
    );
}

/// `x !== false` for a `mediaActions` provider.
pub(super) fn provider_enabled(data: &Value, provider: &str) -> bool {
    !matches!(
        data.pointer(&format!("/mediaActions/providers/{provider}")),
        Some(Value::Bool(false))
    )
}

/// `value ? '********' : ''`.
pub(super) fn masked(value: Option<&Value>) -> Value {
    Value::from(if crate::settings::public::truthy(value) {
        "********"
    } else {
        ""
    })
}

/// Run the side effects of a settings write (cache resets, account
/// disconnects that also drop in-memory caches) through the in-process
/// `POST /internal/settings/effects`, in order. The answer maps each
/// counting effect to its count.
///
/// # Errors
///
/// Fails when an effect fails or is unknown.
pub(super) async fn node_effects(ctx: &Ready<'_>, effects: &[&str]) -> Result<Value> {
    let body = json!({ "effects": effects });
    crate::standalone::internal::call(
        ctx.state,
        &reqwest::Method::POST,
        "/settings/effects",
        Some(&body),
    )
    .await
    .into_result("/settings/effects")
}

/// Count `user_settings` rows with an account linked.
pub(super) async fn linked(
    ctx: &Ready<'_>,
    which: crate::db::LinkedAccounts,
) -> Result<i64, String> {
    ctx.state
        .db
        .count_user_settings(which)
        .await
        .map_err(|e| format!("counting linked accounts failed: {e:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_like_javascript() {
        assert_eq!(
            js_trim("\u{feff} a b\u{3000}\n"),
            "a b",
            "BOM and ideographic space"
        );
        assert_eq!(
            js_trim("\u{85}x\u{85}"),
            "\u{85}x\u{85}",
            "NEL is not JS whitespace"
        );
    }

    #[test]
    fn checks_bodies() {
        const PROPS: &[(&str, Ty)] = &[
            ("a", Ty::Bool),
            ("n", Ty::IntRange(1, 720)),
            ("o", Ty::Obj(&[("s", Ty::NullStr)])),
        ];
        assert!(conforms(&json!({"a": true, "n": 5.0}), PROPS, &["a"]), "ok");
        assert!(!conforms(&json!({"n": 5}), PROPS, &["a"]), "required");
        assert!(!conforms(&json!({"a": 1}), PROPS, &[]), "type");
        assert!(!conforms(&json!({"n": 721}), PROPS, &[]), "range");
        assert!(!conforms(&json!({"n": 1.5}), PROPS, &[]), "integer");
        assert!(
            conforms(&json!({"o": {"s": null}, "x": 1}), PROPS, &[]),
            "nested"
        );
        assert!(
            !conforms(&json!({"o": {"s": 1}}), PROPS, &[]),
            "nested type"
        );
        assert!(!conforms(&json!([]), PROPS, &[]), "not an object");
    }

    #[test]
    fn every_path_routes() {
        let mut paths: Vec<&str> = super::super::ROUTES.iter().map(|(p, _)| *p).collect();
        paths.extend(super::super::SETTINGS_SECTIONS.iter().map(|(p, _)| *p));
        for table in super::super::TABLES {
            paths.extend(table.iter().map(|(p, _, _)| *p));
        }
        paths.sort_unstable();
        paths.dedup();
        let routed = std::panic::catch_unwind(|| {
            paths
                .iter()
                .fold(axum::Router::<()>::new(), |router, path| {
                    router.route(path, axum::routing::get(|| async {}))
                })
        });
        assert!(routed.is_ok(), "paths conflict");
    }

    #[test]
    fn merges_into_sections() {
        let mut data = json!({"mediaActions": {"providers": {"trakt": true, "simkl": true}}});
        set_provider(&mut data, "simkl", false);
        assert_eq!(
            data,
            json!({"mediaActions": {"providers": {"trakt": true, "simkl": false}}}),
            "one provider"
        );
        assert!(!provider_enabled(&data, "simkl"), "disabled");
        assert!(
            provider_enabled(&data, "anilist"),
            "missing counts as enabled"
        );
    }
}
