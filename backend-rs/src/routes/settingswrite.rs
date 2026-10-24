//! Settings writes that only change settings.json.

use std::future::Future;
use std::pin::Pin;

use axum::http::Method;
use serde_json::Value;

use super::{Outcome, Ready, Table};

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// This module's routes.
pub(super) const ROUTES: &Table = &[("/api/v1/settings/network", Method::POST, network)];

/// lodash `merge`: objects merge key by key, arrays index by index, other
/// values replace (null included).
pub(super) fn lodash_merge(target: &mut Value, source: &Value) {
    match (target, source) {
        (Value::Object(t), Value::Object(src)) => {
            for (k, v) in src {
                match t.get_mut(k) {
                    Some(existing)
                        if (existing.is_object() && v.is_object())
                            || (existing.is_array() && v.is_array()) =>
                    {
                        lodash_merge(existing, v);
                    }
                    Some(existing) => *existing = v.clone(),
                    None => {
                        t.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        (Value::Array(t), Value::Array(src)) => {
            for (i, v) in src.iter().enumerate() {
                match t.get_mut(i) {
                    Some(existing)
                        if (existing.is_object() && v.is_object())
                            || (existing.is_array() && v.is_array()) =>
                    {
                        lodash_merge(existing, v);
                    }
                    Some(existing) => *existing = v.clone(),
                    None => t.push(v.clone()),
                }
            }
        }
        (t, src) => *t = src.clone(),
    }
}

/// Whether every key of `body` already exists in `current` with a value of
/// the same JSON type (or null on either side): what the `OpenAPI`
/// validator lets through for a settings object, approximately. Anything
/// else is Node's to judge.
pub(super) fn same_shape(current: &Value, body: &Value) -> bool {
    match (current, body) {
        (Value::Object(c), Value::Object(b)) => b
            .iter()
            .all(|(k, v)| c.get(k).is_some_and(|cv| same_shape(cv, v))),
        (Value::Null, _)
        | (_, Value::Null)
        | (Value::Array(_), Value::Array(_))
        | (Value::String(_), Value::String(_))
        | (Value::Bool(_), Value::Bool(_)) => true,
        (Value::Number(c), Value::Number(b)) => c.is_f64() || !b.is_f64(),
        _ => false,
    }
}

/// `POST /settings/network`: merged into `settings.network` and saved.
fn network<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = ctx
            .no_query()
            .and_then(|()| ctx.authenticated(super::ADMIN))
        {
            return Outcome::forward(why);
        }
        // `merge(settings.network, undefined)` changes nothing.
        let empty = Value::Object(serde_json::Map::new());
        let body = if super::settings_util::body_undefined(ctx) {
            Some(&empty)
        } else {
            ctx.body.as_ref()
        };
        let Some(body) = body.filter(|b| b.is_object()) else {
            return Outcome::forward(String::from("a body that isn't an object"));
        };
        let saved = super::settings_util::change_settings(ctx, |doc| {
            let Some(network) = doc.get_mut("network") else {
                return Err(String::from("no network settings"));
            };
            if !same_shape(network, body) {
                return Err(String::from("keys or types the validator may reject"));
            }
            lodash_merge(network, body);
            Ok(network.clone())
        })
        .await;
        match saved {
            Ok(network) => ctx.json(&network),
            Err(outcome) => outcome,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn merges_like_lodash() {
        let mut a = json!({"a": {"b": 1, "c": [1, 2, 3]}, "d": 1});
        lodash_merge(&mut a, &json!({"a": {"c": [9]}, "d": null, "e": true}));
        assert_eq!(
            a,
            json!({"a": {"b": 1, "c": [9, 2, 3]}, "d": null, "e": true}),
            "merge"
        );
        assert!(
            same_shape(&json!({"a": 1, "b": "x"}), &json!({"a": 2})),
            "same shape"
        );
        assert!(
            !same_shape(&json!({"a": 1}), &json!({"z": 2})),
            "unknown key"
        );
        assert!(
            !same_shape(&json!({"a": 1}), &json!({"a": "2"})),
            "type change"
        );
    }
}
