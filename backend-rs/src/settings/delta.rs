//! Node's single shared settings object, for handlers that work on copies.
//!
//! Node keeps one settings object that every handler mutates in place; a
//! handler here builds its new document from the snapshot it started with.
//! Replaying only what the handler changed (snapshot → new document) onto
//! the settings as they are now keeps the changes other requests made in
//! between, as the shared object would.

use serde_json::Value;

/// Apply the changes from `base` to `data` onto `current`.
///
/// Where nothing else changed `current` becomes `data` exactly (key order included);
/// otherwise objects merge key by key: changed values are assigned
/// (a new key goes last, an existing one keeps its place, as a JavaScript
/// assignment does), removed keys are deleted, and anything else is
/// replaced whole.
pub fn apply(current: &mut Value, base: &Value, data: &Value) {
    if current == base {
        current.clone_from(data);
        return;
    }
    match (current, base, data) {
        (Value::Object(cur), Value::Object(base), Value::Object(data)) => {
            for (key, new) in data {
                match (base.get(key), cur.get_mut(key)) {
                    (Some(old), _) if old == new => {}
                    (Some(old), Some(now)) => apply(now, old, new),
                    (Some(_) | None, _) => {
                        cur.insert(key.clone(), new.clone());
                    }
                }
            }
            for key in base.keys() {
                if !data.contains_key(key) {
                    cur.shift_remove(key);
                }
            }
        }
        (current, _, data) => current.clone_from(data),
    }
}

#[cfg(test)]
mod tests {
    use super::apply;
    use serde_json::json;

    #[test]
    fn keeps_concurrent_changes() {
        let base = json!({"plex": {"ip": "a", "port": 1}, "radarr": [], "main": {"x": 1}});
        let mut current = json!({"plex": {"ip": "z", "port": 1}, "radarr": [], "main": {"x": 1}});
        let data = json!({"plex": {"ip": "a", "port": 1}, "radarr": [{"id": 0}], "main": {"x": 1}});
        apply(&mut current, &base, &data);
        assert_eq!(
            current,
            json!({"plex": {"ip": "z", "port": 1}, "radarr": [{"id": 0}], "main": {"x": 1}}),
            "the other request's plex change stays"
        );
    }

    #[test]
    fn exact_when_alone() {
        let base = json!({"a": 1, "b": 2});
        let data = json!({"b": 2, "a": 3, "c": 4});
        let mut current = base.clone();
        apply(&mut current, &base, &data);
        assert_eq!(
            serde_json::to_string(&current).ok(),
            serde_json::to_string(&data).ok(),
            "the handler's document, key order included"
        );
    }

    #[test]
    fn removals_and_new_keys() {
        let base = json!({"main": {"a": 1, "b": 2}});
        let mut current = json!({"main": {"a": 1, "b": 2, "z": 0}});
        let data = json!({"main": {"a": 1, "c": 3}});
        apply(&mut current, &base, &data);
        assert_eq!(
            serde_json::to_string(&current).ok(),
            Some(String::from(r#"{"main":{"a":1,"z":0,"c":3}}"#)),
            "b deleted, c appended, z kept"
        );
    }
}
