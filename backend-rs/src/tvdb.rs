//! `server/api/tvdb`: the parts the episode catalog needs.
//!
//! Node keeps one
//! `Tvdb` instance per process (logged in when first created) with a
//! bearer token it refreshes a week before it expires; this process keeps
//! its own, the same way. Responses are cached for twelve hours, keyed by
//! URL and token as `ExternalAPI.get` keys them by params and headers.
//! Requests that reach TVDB, logins included, pass the instance's
//! `axios-rate-limit` (`maxRPS: 50`); cached answers don't. Concurrent
//! logins are folded into one.

use std::future::Future;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use crate::concurrency::MaxRps;
use crate::memcache::{self, CacheId};
use crate::sync::lock;

const BASE_URL: &str = "https://api4.thetvdb.com/v4";
/// The key every Foreseerr install logs in with.
const API_KEY: &str = "d00d9ecb-a9d0-4860-958a-74b14a041405";
/// `Tvdb.DEFAULT_CACHE_TTL`.
const CACHE_TTL: Duration = Duration::from_secs(43_200);
/// `Tvdb.DEFAULT_LANGUAGE`.
pub const DEFAULT_LANGUAGE: &str = "eng";
/// A token is renewed when it expires within a week.
const REFRESH_WINDOW_SECS: f64 = 604_800.0;
/// `DEFAULT_CONFIG.maxRequestsPerSecond` (it overrides `maxRequests`).
const MAX_RPS: usize = 50;

/// The process-wide TVDB client state.
#[derive(Debug, Default)]
struct State {
    /// `Tvdb.instance` exists (its first login was attempted).
    created: bool,
    token: Option<String>,
}

#[derive(Debug)]
struct Tvdb {
    state: Mutex<State>,
    /// Held for a login, so callers that find the token missing or stale
    /// at once wait for one login instead of each sending their own.
    login: tokio::sync::Mutex<()>,
    pace: MaxRps,
}

impl Tvdb {
    fn new() -> Self {
        Self {
            state: Mutex::new(State::default()),
            login: tokio::sync::Mutex::const_new(()),
            pace: MaxRps::new(MAX_RPS),
        }
    }

    /// `login` for a caller that found `seen` as the token, unless another
    /// login replaced it while this one waited its turn.
    async fn login_unless_renewed<F, Fut>(&self, seen: Option<String>, login: F) -> Result<()>
    where
        F: FnOnce() -> Fut + Send,
        Fut: Future<Output = Result<()>> + Send,
    {
        let _login = self.login.lock().await;
        if lock(&self.state).token != seen {
            return Ok(());
        }
        login().await
    }
}

static TVDB: LazyLock<Tvdb> = LazyLock::new(Tvdb::new);

/// `Tvdb.getInstance()`: the first call logs in.
///
/// # Errors
///
/// Fails when that first login fails.
pub async fn ensure_instance(client: &reqwest::Client) -> Result<()> {
    let first = {
        let mut state = lock(&TVDB.state);
        let first = !state.created;
        state.created = true;
        let seen = state.token.clone();
        drop(state);
        first.then_some(seen)
    };
    if let Some(seen) = first {
        TVDB.login_unless_renewed(seen, || login(client)).await?;
    }
    Ok(())
}

/// `refreshToken`: log in when there is no token, it carries no expiry or
/// it expires within a week.
///
/// # Errors
///
/// Fails when the token can't be decoded or a needed login fails.
pub async fn refresh_token(client: &reqwest::Client) -> Result<()> {
    let token = lock(&TVDB.state).token.clone();
    let Some(token) = token else {
        return TVDB.login_unless_renewed(None, || login(client)).await;
    };
    let payload = token
        .split('.')
        .nth(1)
        .context("the TVDB token has no payload")?;
    let decoded = lenient_base64(payload);
    let payload: Value = serde_json::from_str(&String::from_utf8_lossy(&decoded))
        .context("the TVDB token payload is not JSON")?;
    if payload.is_null() {
        bail!("the TVDB token payload is null");
    }
    let now = f64::from(u32::try_from(crate::clock::now_millis() / 1000).unwrap_or(u32::MAX));
    let renew = payload
        .get("exp")
        .and_then(Value::as_f64)
        .is_none_or(|exp| exp == 0.0 || exp - now < REFRESH_WINDOW_SECS);
    if renew {
        TVDB.login_unless_renewed(Some(token), || login(client))
            .await?;
    }
    Ok(())
}

/// `test()`: log in again.
///
/// # Errors
///
/// Fails when the login fails.
pub async fn test(client: &reqwest::Client) -> Result<()> {
    let _login = TVDB.login.lock().await;
    login(client).await
}

/// `login`: POST the API key, keep the token. Callers hold `TVDB.login`.
async fn login(client: &reqwest::Client) -> Result<()> {
    TVDB.pace.wait().await;
    let body: Value = client
        .post(format!("{BASE_URL}/login"))
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(json!({ "apiKey": API_KEY }).to_string())
        .send()
        .await
        .context("POST /login")?
        .error_for_status()
        .context("POST /login")?
        .json()
        .await
        .context("POST /login: not JSON")?;
    let token = body
        .pointer("/data/token")
        .and_then(Value::as_str)
        .context("the TVDB login answer has no token")?
        .to_owned();
    lock(&TVDB.state).token = Some(token);
    Ok(())
}

/// A cached GET of `path` (query included) with the bearer token.
///
/// # Errors
///
/// Fails when TVDB can't be reached, answers an error or no JSON.
pub async fn get(client: &reqwest::Client, path: &str) -> Result<Value> {
    get_ttl(client, path, CACHE_TTL).await
}

/// [`get`] with another TTL (`ExternalAPI`'s default of five minutes
/// where a call names none).
///
/// # Errors
///
/// Fails when TVDB can't be reached, answers an error or no JSON.
pub async fn get_ttl(client: &reqwest::Client, path: &str, ttl: Duration) -> Result<Value> {
    let token = lock(&TVDB.state)
        .token
        .clone()
        .unwrap_or_else(|| String::from("undefined"));
    let url = format!("{BASE_URL}{path}");
    let key = cache_key(path, &token);
    if let Some(value) = memcache::get(CacheId::Tvdb, &key) {
        return Ok(value);
    }
    TVDB.pace.wait().await;
    let value: Value = client
        .get(&url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .send()
        .await
        .with_context(|| format!("GET {path}"))?
        .error_for_status()
        .with_context(|| format!("GET {path}"))?
        .json()
        .await
        .with_context(|| format!("GET {path}: not JSON"))?;
    let value = crate::tmdb::js_numbers(value);
    memcache::set(CacheId::Tvdb, key, value.clone(), ttl);
    Ok(value)
}

/// The cache key of a request: its path and the token it is sent with,
/// so each token has its own entries.
fn cache_key(path: &str, token: &str) -> String {
    format!("{BASE_URL}{path} {token}")
}

/// `Buffer.from(s, 'base64')`: standard and URL-safe alphabets, anything
/// else skipped, decoding stops at the first `=`.
fn lenient_base64(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for byte in text.bytes() {
        let sextet = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        acc = (acc << 6) | u32::from(sextet);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(u8::try_from((acc >> bits) & 0xFF).unwrap_or(0));
        }
    }
    out
}

/// `convertTmdbLanguageToTvdbWithFallback(language, 'eng')`. `None` for a
/// name Node's object lookup would find on `Object.prototype`.
#[must_use]
pub fn tvdb_language(tmdb: &str) -> Option<&'static str> {
    const PROTOTYPE: [&str; 12] = [
        "constructor",
        "__proto__",
        "hasownproperty",
        "isprototypeof",
        "propertyisenumerable",
        "tolocalestring",
        "tostring",
        "valueof",
        "__definegetter__",
        "__definesetter__",
        "__lookupgetter__",
        "__lookupsetter__",
    ];
    if PROTOTYPE.contains(&tmdb.to_lowercase().as_str()) {
        return None;
    }
    Some(
        mapping(tmdb)
            .or_else(|| mapping(&tmdb.to_lowercase()))
            .unwrap_or(DEFAULT_LANGUAGE),
    )
}

/// `TMDB_TO_TVDB_MAPPING`.
fn mapping(code: &str) -> Option<&'static str> {
    Some(match code {
        "ar" => "ara",
        "bg" => "bul",
        "ca" => "cat",
        "cs" => "ces",
        "da" => "dan",
        "de" => "deu",
        "el" => "ell",
        "en" => "eng",
        "es" | "es-MX" => "spa",
        "et" => "est",
        "fi" => "fin",
        "fr" => "fra",
        "he" => "heb",
        "hi" => "hin",
        "hr" => "hrv",
        "hu" => "hun",
        "it" => "ita",
        "ja" => "jpn",
        "ko" => "kor",
        "lb" => "ltz",
        "lt" => "lit",
        "nl" => "nld",
        "pl" => "pol",
        "ro" => "ron",
        "ru" => "rus",
        "sq" => "sqi",
        "sr" => "srp",
        "sv" => "swe",
        "tr" => "tur",
        "uk" => "ukr",
        "vi" => "vie",
        "nb-NO" => "nor",
        "pt-BR" => "pt",
        "pt-PT" => "por",
        "zh-CN" => "zho",
        "zh-TW" => "zhtw",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_languages_like_node() {
        assert_eq!(tvdb_language("de"), Some("deu"), "plain");
        assert_eq!(tvdb_language("DE"), Some("deu"), "lowercased");
        assert_eq!(tvdb_language("pt-BR"), Some("pt"), "region exact");
        assert_eq!(tvdb_language("pt-br"), Some("eng"), "region case matters");
        assert_eq!(tvdb_language("xx"), Some("eng"), "fallback");
        assert_eq!(tvdb_language(""), Some("eng"), "empty");
        assert_eq!(tvdb_language("toString"), None, "prototype names");
    }

    #[tokio::test]
    async fn concurrent_logins_fold_into_one() -> Result<()> {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let tvdb = Tvdb::new();
        let logins = AtomicUsize::new(0);
        let attempt = |seen: Option<String>| {
            let (tvdb, logins) = (&tvdb, &logins);
            tvdb.login_unless_renewed(seen, move || async move {
                logins.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(20)).await;
                let n = logins.load(Ordering::SeqCst);
                lock(&tvdb.state).token = Some(format!("token-{n}"));
                Ok(())
            })
        };
        let (a, b, c) = tokio::join!(attempt(None), attempt(None), attempt(None));
        assert!(a.is_ok() && b.is_ok() && c.is_ok(), "all succeed");
        assert_eq!(
            logins.load(Ordering::SeqCst),
            1,
            "one login for a cold start"
        );
        let stale = Some(String::from("token-1"));
        let (a, b, c) = tokio::join!(
            attempt(stale.clone()),
            attempt(stale.clone()),
            attempt(stale)
        );
        assert!(a.is_ok() && b.is_ok() && c.is_ok(), "all succeed");
        assert_eq!(
            logins.load(Ordering::SeqCst),
            2,
            "one login renews a stale token"
        );
        Ok(())
    }

    #[test]
    fn decodes_base64_leniently() {
        assert_eq!(
            lenient_base64("eyJleHAiOjF9"),
            b"{\"exp\":1}".to_vec(),
            "plain"
        );
        assert_eq!(
            lenient_base64("eyJleHAiOjF9=="),
            b"{\"exp\":1}".to_vec(),
            "padded"
        );
        assert_eq!(lenient_base64("aGk"), b"hi".to_vec(), "unpadded");
        assert_eq!(lenient_base64("_-8"), vec![0xFF, 0xEF], "url-safe");
    }
}
