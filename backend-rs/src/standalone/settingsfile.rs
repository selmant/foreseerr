//! `Settings.load()` from `server/lib/settings/index.ts`.
//!
//! For a process with no Node behind it: settings.json created from the defaults when missing,
//! migrated, merged over the defaults, and the keys and ids Node generates
//! (API key, client id, session secret, VAPID keys) filled in.

use std::path::Path;

use anyhow::{bail, Context, Result};
use base64::Engine;
use ring::rand::{SecureRandom, SystemRandom};
use serde_json::Value;

use super::settingsmigrations::{self, stringify, stringify_pretty, MigrationCtx};
use crate::settings::public::truthy;

/// The constructor's document: the defaults with a fresh `clientId`.
///
/// # Errors
///
/// Fails when the embedded defaults don't parse.
pub(crate) fn constructor_defaults() -> Result<Value> {
    let mut data =
        crate::settings::Settings::from_file_value(Value::Object(serde_json::Map::new()), None)?
            .data()
            .clone();
    if let Some(map) = data.as_object_mut() {
        map.insert(String::from("clientId"), Value::from(uuid_v4()?));
    }
    Ok(data)
}

/// `Settings.save()`: `JSON.stringify(data, undefined, ' ')` through a
/// temp file and a rename.
///
/// # Errors
///
/// Fails when the file can't be written.
pub(crate) async fn save(path: &Path, data: &Value) -> Result<()> {
    let tmp = std::path::PathBuf::from(format!("{}.tmp", path.display()));
    tokio::fs::write(&tmp, stringify_pretty(data)?)
        .await
        .with_context(|| format!("writing {}", tmp.display()))?;
    tokio::fs::rename(&tmp, path)
        .await
        .with_context(|| format!("renaming {}", tmp.display()))
}

fn random_bytes<const N: usize>() -> Result<[u8; N]> {
    let mut bytes = [0_u8; N];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| anyhow::anyhow!("the system random source failed"))?;
    Ok(bytes)
}

/// Bytes as lower-case hex, as `Buffer.toString('hex')`.
fn hex_lower(bytes: &[u8]) -> String {
    let digit = |n: u8| char::from_digit(u32::from(n), 16).unwrap_or('0');
    bytes
        .iter()
        .flat_map(|b| [digit(b >> 4), digit(b & 0x0f)])
        .collect()
}

/// `crypto.randomUUID()`.
///
/// # Errors
///
/// Fails when the system random source does.
pub(crate) fn uuid_v4() -> Result<String> {
    let mut b = random_bytes::<16>()?;
    if let Some(v) = b.get_mut(6) {
        *v = (*v & 0x0f) | 0x40;
    }
    if let Some(v) = b.get_mut(8) {
        *v = (*v & 0x3f) | 0x80;
    }
    let hex = hex_lower(&b);
    let part = |range: std::ops::Range<usize>| hex.get(range).unwrap_or("");
    Ok(format!(
        "{}-{}-{}-{}-{}",
        part(0..8),
        part(8..12),
        part(12..16),
        part(16..20),
        part(20..32)
    ))
}

/// `generateApiKey()`: `API_KEY`, or base64 of the time and a UUID.
fn generate_api_key() -> Result<String> {
    if let Some(key) = api_key_env() {
        return Ok(key);
    }
    let raw = format!("{}{}", crate::clock::now_millis(), uuid_v4()?);
    Ok(base64::engine::general_purpose::STANDARD.encode(raw))
}

fn api_key_env() -> Option<String> {
    std::env::var("API_KEY").ok().filter(|k| !k.is_empty())
}

/// web-push's `generateVAPIDKeys()`: a P-256 key pair, the uncompressed
/// public point and the private scalar, both base64url without padding.
///
/// # Errors
///
/// Fails when the key can't be generated.
pub(crate) fn vapid_keys() -> Result<(String, String)> {
    use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
    let rng = SystemRandom::new();
    let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng)
        .map_err(|_| anyhow::anyhow!("generating the VAPID key failed"))?;
    let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng)
        .map_err(|_| anyhow::anyhow!("reading the VAPID key failed"))?;
    let private =
        private_scalar(pkcs8.as_ref()).context("no private key in the PKCS#8 document")?;
    let url = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    Ok((url.encode(pair.public_key().as_ref()), url.encode(private)))
}

/// The 32-byte scalar in ring's P-256 PKCS#8 document: the `ECPrivateKey`
/// `version 1, privateKey OCTET STRING (32)` it always writes.
fn private_scalar(der: &[u8]) -> Option<&[u8]> {
    const MARKER: [u8; 5] = [0x02, 0x01, 0x01, 0x04, 0x20];
    let start = der.windows(MARKER.len()).position(|w| w == MARKER)? + MARKER.len();
    der.get(start..start + 32)
}

/// `Settings.load()` (or `load(undefined, true)` with `raw`): the
/// in-memory document Node ends up with. settings.json is written as Node
/// writes it along the way.
///
/// # Errors
///
/// Where Node stops: unreadable JSON, a failing migration, a file that
/// can't be written.
pub(crate) async fn load(path: &Path, raw: bool, ctx: MigrationCtx<'_>) -> Result<Value> {
    let mut data = constructor_defaults()?;
    let text = match tokio::fs::read_to_string(path).await {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };
    if text.is_none() {
        save(path, &data).await?;
    }
    let mut change = false;
    if let Some(text) = text {
        let parsed: Value = crate::tmdb::js_numbers(
            serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))?,
        );
        if raw {
            data = parsed;
        } else {
            let migrated = settingsmigrations::run(&parsed, path, ctx).await?;
            // mergeSettings: lodash mergeWith with arrays replaced.
            crate::settings::merge(&mut data, migrated.clone());
            change = stringify(&data) != stringify(&migrated);
        }
    }
    change |= generate_missing(&mut data)?;
    if change {
        save(path, &data).await?;
    }
    Ok(data)
}

/// The keys and ids `load()` fills in when missing; whether any was.
fn generate_missing(data: &mut Value) -> Result<bool> {
    let Some(map) = data.as_object_mut() else {
        bail!("the settings are not an object");
    };
    let mut change = false;
    let Some(main) = map.get_mut("main").and_then(Value::as_object_mut) else {
        bail!("apiKey is missing");
    };
    if !truthy(main.get("apiKey")) {
        main.insert(String::from("apiKey"), Value::from(generate_api_key()?));
        change = true;
    } else if let Some(key) = api_key_env() {
        // Kept in memory only; the next save writes it.
        main.insert(String::from("apiKey"), Value::from(key));
    }
    if !truthy(map.get("clientId")) {
        map.insert(String::from("clientId"), Value::from(uuid_v4()?));
        change = true;
    }
    if !truthy(map.get("sessionSecret")) {
        let secret = hex_lower(&random_bytes::<32>()?);
        map.insert(String::from("sessionSecret"), Value::from(secret));
        change = true;
    }
    if !truthy(map.get("vapidPublic")) || !truthy(map.get("vapidPrivate")) {
        let (public, private) = vapid_keys()?;
        map.insert(String::from("vapidPrivate"), Value::from(private));
        map.insert(String::from("vapidPublic"), Value::from(public));
        change = true;
    }
    Ok(change)
}

#[cfg(test)]
mod tests {
    use base64::Engine;
    use serde_json::json;

    use super::*;

    #[tokio::test]
    async fn unreadable_settings_are_not_replaced() -> Result<()> {
        let dir = std::env::temp_dir().join(format!("foreseerr-unreadable-{}", uuid_v4()?));
        let path = dir.join("settings.json");
        // A directory gives a read error even when tests run as root.
        tokio::fs::create_dir_all(&path).await?;
        let db = crate::db::Db::Sqlite(
            sqlx::sqlite::SqlitePoolOptions::new().connect_lazy("sqlite::memory:")?,
        );
        let http = reqwest::Client::new();
        let ctx = MigrationCtx {
            db: &db,
            http: &http,
            version: "test",
        };
        let result = load(&path, false, ctx).await;
        assert!(
            result.is_err_and(|e| e.to_string().starts_with("reading ")),
            "startup fails on the original read error"
        );
        assert!(path.is_dir(), "the original path is untouched");
        assert!(
            !dir.join("settings.json.tmp").exists(),
            "no replacement was attempted"
        );
        tokio::fs::remove_dir_all(dir).await?;
        Ok(())
    }

    #[test]
    fn generated_values() -> Result<()> {
        let id = uuid_v4()?;
        assert_eq!(id.len(), 36, "uuid length");
        assert_eq!(id.chars().nth(14), Some('4'), "version 4");
        assert!(
            matches!(id.chars().nth(19), Some('8' | '9' | 'a' | 'b')),
            "RFC 4122 variant"
        );
        let (public, private) = vapid_keys()?;
        let url = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let public = url.decode(public)?;
        assert_eq!(public.len(), 65, "uncompressed point");
        assert_eq!(public.first(), Some(&4), "uncompressed marker");
        assert_eq!(url.decode(private)?.len(), 32, "scalar");
        Ok(())
    }

    #[test]
    fn fills_only_missing_keys() -> Result<()> {
        let mut data = json!({"main": {"apiKey": "k"}, "clientId": "c", "sessionSecret": "", "vapidPublic": "p", "vapidPrivate": "q"});
        assert!(generate_missing(&mut data)?, "the secret was missing");
        assert_eq!(data.pointer("/main/apiKey"), Some(&json!("k")), "kept");
        assert_eq!(data.pointer("/clientId"), Some(&json!("c")), "kept");
        assert_eq!(data.pointer("/vapidPublic"), Some(&json!("p")), "kept");
        assert_eq!(
            data.pointer("/sessionSecret")
                .and_then(Value::as_str)
                .map(str::len),
            Some(64),
            "32 bytes in hex"
        );
        assert!(!generate_missing(&mut data)?, "nothing left to fill");
        Ok(())
    }
}
