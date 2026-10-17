//! The operation tokens of `mediaServarr.ts` (a process-local `NodeCache`
//! there): opaque UUIDs standing for a release, an import source, an
//! import candidate or a command, bound to the user, media item, quality,
//! service type and Arr id they were issued for. Every route that issues
//! or redeems one is answered here, so this store replaces Node's.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::sync::lock;

/// What a token stands for.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Token {
    pub(super) user_id: i64,
    pub(super) media_id: i64,
    pub(super) is4k: bool,
    /// `radarr` or `sonarr`.
    pub(super) service: &'static str,
    pub(super) external_id: i64,
    /// `release`, `import-source`, `import-candidate` or `command`.
    pub(super) kind: &'static str,
    pub(super) value: Value,
    pub(super) episode_id: Option<i64>,
    pub(super) season_number: Option<i64>,
}

#[derive(Debug)]
struct Entry {
    token: Token,
    expires: Instant,
}

fn store() -> &'static Mutex<HashMap<String, Entry>> {
    static STORE: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `crypto.randomUUID()`: a version 4 UUID in lower-case hex.
fn random_uuid() -> String {
    let mut bytes: [u8; 16] = rand::random();
    if let Some(b) = bytes.get_mut(6) {
        *b = (*b & 0x0f) | 0x40;
    }
    if let Some(b) = bytes.get_mut(8) {
        *b = (*b & 0x3f) | 0x80;
    }
    let hex: String = bytes.iter().fold(String::new(), |mut acc, b| {
        acc.push(char::from_digit(u32::from(b >> 4), 16).unwrap_or('0'));
        acc.push(char::from_digit(u32::from(b & 0x0f), 16).unwrap_or('0'));
        acc
    });
    let part = |from: usize, to: usize| hex.get(from..to).unwrap_or("");
    format!(
        "{}-{}-{}-{}-{}",
        part(0, 8),
        part(8, 12),
        part(12, 16),
        part(16, 20),
        part(20, 32)
    )
}

/// `tokenFor(record, ttl)`: store the record for `ttl_secs` under a new
/// UUID.
pub(super) fn issue(token: Token, ttl_secs: u64) -> String {
    let id = random_uuid();
    let now = Instant::now();
    let mut map = lock(store());
    map.retain(|_, e| e.expires > now);
    map.insert(
        id.clone(),
        Entry {
            token,
            expires: now + Duration::from_secs(ttl_secs),
        },
    );
    id
}

/// `tokens.get(id)`: the record while it is live.
pub(super) fn get(id: &str) -> Option<Token> {
    let map = lock(store());
    map.get(id)
        .filter(|e| e.expires > Instant::now())
        .map(|e| e.token.clone())
}

/// `tokens.del(id)`.
pub(super) fn remove(id: &str) {
    lock(store()).remove(id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_get_remove() {
        let id = random_uuid();
        assert_eq!(id.len(), 36, "uuid length");
        assert_eq!(id.chars().nth(14), Some('4'), "version 4");
        let token = Token {
            user_id: 1,
            media_id: 2,
            is4k: false,
            service: "radarr",
            external_id: 3,
            kind: "release",
            value: Value::Null,
            episode_id: None,
            season_number: None,
        };
        let id = issue(token.clone(), 60);
        assert_eq!(get(&id), Some(token), "live token");
        remove(&id);
        assert_eq!(get(&id), None, "removed");
        assert_eq!(get("missing"), None, "unknown");
    }
}
