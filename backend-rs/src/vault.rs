//! Encryption at rest for credentials Foreseerr keeps on someone's behalf:
//! AI provider API keys and `OAuth` token sets.
//!
//! The master key comes from, in order:
//!
//! 1. `FORESEERR_SECRET_KEY`: 32 bytes as base64 (standard or URL-safe) or
//!    64 hex characters;
//! 2. `FORESEERR_SECRET_KEY_FILE`: a file holding such a value (a Docker or
//!    Kubernetes secret);
//! 3. `<config>/secret.key`, created on first use with owner-only access.
//!
//! The third keeps things working out of the box, but the key then sits next
//! to the database it protects, so a copy of the config directory carries
//! both. The first two keep database dumps and backups useless on their own.
//!
//! Each purpose gets its own key, derived with HKDF-SHA256, and every
//! sealed value is bound to the row it belongs to through AES-GCM's
//! associated data: a sealed token copied into another user's row does
//! not open there.
//!
//! What this can't do: the server has to decrypt a credential to use it,
//! so someone with the server's key and its database (root on the host)
//! can recover the credentials. Through the app itself, sealed values are
//! never sent anywhere.

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, bail, Context, Result};
use base64::prelude::*;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
use ring::hkdf;
use ring::rand::{SecureRandom, SystemRandom};

/// What a sealed value starts with; the version names the scheme.
const PREFIX: &str = "fsv1:";
/// The key file in the config directory.
const KEY_FILE: &str = "secret.key";
/// HKDF salt: fixed, since the master key is already uniformly random.
const SALT: &[u8] = b"foreseerr-vault-v1";

/// A secret in memory. `Debug` never prints it.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    /// Wrap a value.
    #[must_use]
    pub const fn new(value: String) -> Self {
        Self(value)
    }

    /// The value, for the one place that sends it.
    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }

    /// Whether it is empty.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

/// What a sealed value is for. Each purpose has its own derived key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    /// An AI provider credential (API key or `OAuth` token set).
    AiCredential,
}

impl Purpose {
    const fn info(self) -> &'static [u8] {
        match self {
            Self::AiCredential => b"ai-credential",
        }
    }
}

/// The master key, with its derived keys.
pub struct Vault {
    ai_credential: LessSafeKey,
    rng: SystemRandom,
    /// Where the key came from, for the startup log.
    source: KeySource,
}

impl fmt::Debug for Vault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Vault")
            .field("source", &self.source)
            .finish_non_exhaustive()
    }
}

/// Where the master key was found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeySource {
    /// `FORESEERR_SECRET_KEY`.
    Env,
    /// `FORESEERR_SECRET_KEY_FILE`.
    File(PathBuf),
    /// `<config>/secret.key`, which existed.
    ConfigFile(PathBuf),
    /// `<config>/secret.key`, created now.
    Generated(PathBuf),
}

impl KeySource {
    /// Whether the key lives in the config directory, next to the
    /// database it protects.
    #[must_use]
    pub const fn beside_database(&self) -> bool {
        matches!(self, Self::ConfigFile(_) | Self::Generated(_))
    }
}

impl Vault {
    /// A vault from a 32-byte master key.
    ///
    /// # Errors
    ///
    /// Fails when a key can't be derived (not expected for 32 bytes).
    pub fn from_master(master: &[u8; 32], source: KeySource) -> Result<Self> {
        let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, SALT).extract(master);
        let derive = |purpose: Purpose| -> Result<LessSafeKey> {
            let info = [purpose.info()];
            let okm = prk
                .expand(&info, &AES_256_GCM)
                .map_err(|_| anyhow!("deriving the {purpose:?} key failed"))?;
            Ok(LessSafeKey::new(UnboundKey::from(okm)))
        };
        Ok(Self {
            ai_credential: derive(Purpose::AiCredential)?,
            rng: SystemRandom::new(),
            source,
        })
    }

    /// Where the master key came from.
    #[must_use]
    pub const fn source(&self) -> &KeySource {
        &self.source
    }

    const fn key(&self, purpose: Purpose) -> &LessSafeKey {
        match purpose {
            Purpose::AiCredential => &self.ai_credential,
        }
    }

    /// Encrypt `plain` for `purpose`, bound to `context` (the row it is
    /// stored in, e.g. `ai-connection:user:7`).
    ///
    /// # Errors
    ///
    /// Fails when the system random source or the cipher fails.
    pub fn seal(&self, purpose: Purpose, context: &str, plain: &Secret) -> Result<String> {
        let mut nonce = [0u8; NONCE_LEN];
        self.rng
            .fill(&mut nonce)
            .map_err(|_| anyhow!("the system random source failed"))?;
        let mut buf = plain.expose().as_bytes().to_vec();
        self.key(purpose)
            .seal_in_place_append_tag(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(context.as_bytes()),
                &mut buf,
            )
            .map_err(|_| anyhow!("sealing failed"))?;
        let mut out = nonce.to_vec();
        out.append(&mut buf);
        Ok(format!("{PREFIX}{}", BASE64_URL_SAFE_NO_PAD.encode(out)))
    }

    /// Decrypt a value [`Vault::seal`] made for the same purpose and
    /// context.
    ///
    /// # Errors
    ///
    /// Fails when the value is malformed, was sealed under another key or
    /// for another context, or was altered.
    pub fn open(&self, purpose: Purpose, context: &str, sealed: &str) -> Result<Secret> {
        let Some(body) = sealed.strip_prefix(PREFIX) else {
            bail!("not a sealed value");
        };
        let bytes = BASE64_URL_SAFE_NO_PAD
            .decode(body)
            .context("a sealed value is not base64")?;
        let (nonce, rest) = bytes
            .split_at_checked(NONCE_LEN)
            .ok_or_else(|| anyhow!("a sealed value is too short"))?;
        let nonce = Nonce::try_assume_unique_for_key(nonce)
            .map_err(|_| anyhow!("a sealed value has a bad nonce"))?;
        let mut buf = rest.to_vec();
        let plain = self
            .key(purpose)
            .open_in_place(nonce, Aad::from(context.as_bytes()), &mut buf)
            .map_err(|_| {
                anyhow!("a sealed value doesn't open: wrong key, wrong row, or altered")
            })?;
        let text = std::str::from_utf8(plain).context("a sealed value is not UTF-8")?;
        Ok(Secret::new(text.to_owned()))
    }
}

/// The process's vault, loaded on first use.
static VAULT: Mutex<Option<Arc<Vault>>> = Mutex::new(None);

/// The vault for this config directory: the key from the environment, or
/// the config directory's key file, created if missing.
///
/// # Errors
///
/// Fails when a configured key is malformed or unreadable, or the key file
/// can't be created.
pub fn get(config_dir: &Path) -> Result<Arc<Vault>> {
    let mut slot = crate::sync::lock(&VAULT);
    if let Some(vault) = slot.as_ref() {
        return Ok(Arc::clone(vault));
    }
    let (master, source) = load_master(config_dir)?;
    let vault = Arc::new(Vault::from_master(&master, source)?);
    match vault.source() {
        KeySource::Generated(path) => tracing::warn!(
            "Created a new secret key at {}. It encrypts saved AI credentials. Back it up \
             with the database, or move it out of the config directory with \
             FORESEERR_SECRET_KEY_FILE so a copy of the database alone can't be decrypted.",
            path.display()
        ),
        KeySource::ConfigFile(path) => tracing::info!(
            "Using the secret key in {}; set FORESEERR_SECRET_KEY_FILE to keep it apart from \
             the database.",
            path.display()
        ),
        KeySource::Env | KeySource::File(_) => {}
    }
    *slot = Some(Arc::clone(&vault));
    drop(slot);
    Ok(vault)
}

fn load_master(config_dir: &Path) -> Result<([u8; 32], KeySource)> {
    if let Some(value) = std::env::var("FORESEERR_SECRET_KEY")
        .ok()
        .filter(|v| !v.trim().is_empty())
    {
        return Ok((
            parse_key(&value).context("FORESEERR_SECRET_KEY")?,
            KeySource::Env,
        ));
    }
    if let Some(path) = std::env::var("FORESEERR_SECRET_KEY_FILE")
        .ok()
        .filter(|v| !v.trim().is_empty())
    {
        let path = PathBuf::from(path);
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("reading FORESEERR_SECRET_KEY_FILE {}", path.display()))?;
        let key = parse_key(&text).with_context(|| format!("the key in {}", path.display()))?;
        return Ok((key, KeySource::File(path)));
    }
    let path = config_dir.join(KEY_FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            let key = parse_key(&text).with_context(|| format!("the key in {}", path.display()))?;
            sync_key_directory(&path)?;
            Ok((key, KeySource::ConfigFile(path)))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let key = generate_key_file(&path)?;
            Ok((key, KeySource::Generated(path)))
        }
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
    }
}

/// A key written as base64 (standard or URL-safe, padded or not) or hex.
fn parse_key(text: &str) -> Result<[u8; 32]> {
    let text = text.trim();
    let bytes = if text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit()) {
        hex_decode(text)?
    } else {
        let unpadded = text.trim_end_matches('=');
        BASE64_STANDARD_NO_PAD
            .decode(unpadded)
            .or_else(|_| BASE64_URL_SAFE_NO_PAD.decode(unpadded))
            .context("the key is neither 64 hex characters nor base64")?
    };
    bytes.try_into().map_err(|b: Vec<u8>| {
        anyhow!(
            "the key must be 32 bytes, this one is {} (generate one with `openssl rand -base64 32`)",
            b.len()
        )
    })
}

fn hex_decode(text: &str) -> Result<Vec<u8>> {
    let digits: Vec<u8> = text
        .bytes()
        .map(|b| match b {
            b'0'..=b'9' => Ok(b - b'0'),
            b'a'..=b'f' => Ok(b - b'a' + 10),
            b'A'..=b'F' => Ok(b - b'A' + 10),
            _ => Err(anyhow!("not a hex digit")),
        })
        .collect::<Result<_>>()?;
    Ok(digits
        .chunks_exact(2)
        .map(|pair| match pair {
            [hi, lo] => (hi << 4) | lo,
            _ => 0,
        })
        .collect())
}

fn sync_key_directory(path: &Path) -> Result<()> {
    #[cfg(not(unix))]
    let _ = path;
    #[cfg(unix)]
    std::fs::File::open(path.parent().unwrap_or_else(|| Path::new(".")))?.sync_all()?;
    Ok(())
}

/// Create the key file with owner-only access. The key is written and
/// synced to a temporary file first, then published with a hard link,
/// which fails if the key already exists: a reader never sees a half
/// written key, an interrupted write leaves no `secret.key`, and of two
/// processes the second reads the first one's key.
fn generate_key_file(path: &Path) -> Result<[u8; 32]> {
    use std::io::Write as _;
    let mut key = [0u8; 32];
    SystemRandom::new()
        .fill(&mut key)
        .map_err(|_| anyhow!("the system random source failed"))?;
    let mut suffix = [0u8; 8];
    SystemRandom::new()
        .fill(&mut suffix)
        .map_err(|_| anyhow!("the system random source failed"))?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let temp = path.with_file_name(format!(
        ".{name}.{}.tmp",
        BASE64_URL_SAFE_NO_PAD.encode(suffix)
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let encoded = format!("{}\n", BASE64_STANDARD.encode(key));
    let write_new = |target: &Path| {
        options.open(target).and_then(|mut file| {
            file.write_all(encoded.as_bytes())?;
            file.sync_all()
        })
    };
    let written = write_new(&temp).and_then(|()| std::fs::hard_link(&temp, path));
    // The temporary name is never needed again, published or not.
    if let Err(e) = std::fs::remove_file(&temp) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!("removing {} failed: {e}", temp.display());
        }
    }
    match written {
        Ok(()) => {
            sync_key_directory(path)?;
            Ok(key)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let text = std::fs::read_to_string(path)
                .with_context(|| format!("reading {}", path.display()))?;
            let key = parse_key(&text)?;
            sync_key_directory(path)?;
            Ok(key)
        }
        Err(e) => Err(e).with_context(|| format!("creating {}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault(byte: u8) -> Result<Vault> {
        Vault::from_master(&[byte; 32], KeySource::Env)
    }

    #[test]
    fn round_trips_and_binds_the_context() -> Result<()> {
        let v = vault(7)?;
        let secret = Secret::new(String::from("sk-test-123"));
        let sealed = v.seal(Purpose::AiCredential, "ai-connection:user:1", &secret)?;
        assert!(sealed.starts_with(PREFIX), "versioned");
        assert!(!sealed.contains("sk-test"), "no plaintext");
        let opened = v.open(Purpose::AiCredential, "ai-connection:user:1", &sealed)?;
        assert_eq!(opened, secret, "round trip");
        assert!(
            v.open(Purpose::AiCredential, "ai-connection:user:2", &sealed)
                .is_err(),
            "another row's context doesn't open it"
        );
        assert!(
            vault(8)?
                .open(Purpose::AiCredential, "ai-connection:user:1", &sealed)
                .is_err(),
            "another key doesn't open it"
        );
        Ok(())
    }

    #[test]
    fn nonces_differ() -> Result<()> {
        let v = vault(1)?;
        let secret = Secret::new(String::from("same"));
        let a = v.seal(Purpose::AiCredential, "c", &secret)?;
        let b = v.seal(Purpose::AiCredential, "c", &secret)?;
        assert_ne!(a, b, "fresh nonce each time");
        Ok(())
    }

    #[test]
    fn tampering_is_detected() -> Result<()> {
        let v = vault(3)?;
        let sealed = v.seal(Purpose::AiCredential, "c", &Secret::new(String::from("x")))?;
        let mut bytes = BASE64_URL_SAFE_NO_PAD.decode(sealed.trim_start_matches(PREFIX))?;
        if let Some(last) = bytes.last_mut() {
            *last ^= 1;
        }
        let altered = format!("{PREFIX}{}", BASE64_URL_SAFE_NO_PAD.encode(bytes));
        assert!(
            v.open(Purpose::AiCredential, "c", &altered).is_err(),
            "tag check"
        );
        assert!(
            v.open(Purpose::AiCredential, "c", "plain").is_err(),
            "prefix check"
        );
        Ok(())
    }

    #[test]
    fn parses_key_formats() -> Result<()> {
        let key = [0xabu8; 32];
        assert_eq!(parse_key(&BASE64_STANDARD.encode(key))?, key, "base64");
        assert_eq!(
            parse_key(&BASE64_URL_SAFE_NO_PAD.encode(key))?,
            key,
            "base64url"
        );
        assert_eq!(parse_key(&"ab".repeat(32))?, key, "hex");
        assert_eq!(
            parse_key(&format!(" {}\n", "AB".repeat(32)))?,
            key,
            "trimmed hex"
        );
        assert!(parse_key("short").is_err(), "too short");
        Ok(())
    }

    #[test]
    fn debug_hides_the_secret() {
        let shown = format!("{:?}", Secret::new(String::from("sk-live-abc")));
        assert!(!shown.contains("sk-live"), "redacted: {shown}");
    }

    #[test]
    fn generates_one_key_file() -> Result<()> {
        let dir = std::env::temp_dir().join(format!(
            "foreseerr-vault-{}-{}",
            std::process::id(),
            crate::clock::now_millis()
        ));
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(KEY_FILE);
        let first = generate_key_file(&path)?;
        let second = generate_key_file(&path)?;
        assert_eq!(first, second, "an existing file wins");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&path)?.permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "owner only");
        }
        std::fs::remove_dir_all(&dir)?;
        Ok(())
    }
}
