//! `csurf` as `server/index.ts` mounts it when `network.csrfProtection` is
//! on (or in the desktop runtime), plus the middleware after it that hands
//! the frontend an `XSRF-TOKEN` cookie.
//!
//! Express's order: cookie-parser, `express.json()`/`urlencoded()`, csurf,
//! the `XSRF-TOKEN` cookie, then the session, the `OpenAPI` validator and
//! the routes. So this layer sits outside the validator gate and runs for
//! every path, `/api` or not:
//!
//! - The secret lives in the `_csrf` cookie (`HttpOnly`, `SameSite=Strict`,
//!   `Secure` in production). A request without one gets a fresh secret
//!   (`uid-safe`, 18 bytes) and the cookie, even when it is then refused.
//! - `POST`, `PUT`, `PATCH`, `DELETE`… must carry a token from
//!   `req.body._csrf`, `req.query._csrf` or the `csrf-token`, `xsrf-token`,
//!   `x-csrf-token`, `x-xsrf-token` headers; `GET`, `HEAD` and `OPTIONS`
//!   don't, nor do the two desktop redeem `POST`s. A token is
//!   `salt-base64url(sha256(salt-secret))` (the `csrf` package). A missing
//!   or wrong one is the error handler's 403 `{"message":"invalid csrf token"}`.
//! - Every request that gets through has a new `XSRF-TOKEN` cookie appended
//!   (`SameSite=Strict`, `Secure` in production); `/imageproxy` and
//!   `/avatarproxy` clear them again (`clearCookies`).
//!
//! The setting is read at startup, as Node mounts the middleware once.

use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, Response};
use axum::middleware::Next;
use base64::prelude::*;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::state::AppState;

/// csurf's cookie.
const SECRET_COOKIE: &str = "_csrf";
/// `express.json()`'s and `express.urlencoded()`'s default limit.
const BODY_LIMIT: usize = 100 * 1024;
/// urlencoded's `parameterLimit`.
const PARAMETER_LIMIT: usize = 1000;
/// csurf's `ignoreRequest`: native hosts redeem without browser cookies.
const IGNORED_POSTS: [&str; 2] = [
    "/api/v1/desktop/auth-tickets/redeem",
    "/api/v1/desktop/browser-cache/redeem",
];
/// The headers csurf's default `value()` reads, in its order.
const TOKEN_HEADERS: [&str; 4] = ["csrf-token", "xsrf-token", "x-csrf-token", "x-xsrf-token"];
/// `rndm`'s alphabet.
const SALT_CHARS: &[u8; 62] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/// The secret as cookie-parser leaves it in `req.cookies._csrf`.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Secret {
    /// A non-empty string.
    Text(String),
    /// A truthy `j:` JSON cookie that isn't a string: tokens can't be made
    /// from it.
    NotText,
}

/// A truthy value csurf's `value()` found.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    Text(String),
    /// An array, an object, `true`, a number: never valid.
    NotText,
}

/// What the body parsers make of the body, as far as csurf cares.
#[derive(Debug, Clone, PartialEq, Eq)]
enum BodyToken {
    /// No truthy `req.body._csrf`.
    Absent,
    Found(Token),
    /// The parser answers an error before csurf runs.
    ParserFails,
    /// A body the parsers read in a way not reproduced here.
    Unsure,
}

/// How the layer is configured at startup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Config {
    /// `secure: !dev` (always off in the desktop runtime).
    secure: bool,
}

/// csurf's configuration, or `None` where Node doesn't mount it.
fn config(state: &AppState) -> Option<Config> {
    let env = &state.env;
    if env.plugin_mode || !(env.desktop_runtime || state.csrf_at_startup()) {
        return None;
    }
    Some(Config {
        secure: !env.desktop_runtime && crate::standalone::production(),
    })
}

/// The middleware.
pub async fn layer(State(state): State<Arc<AppState>>, req: Request, next: Next) -> Response<Body> {
    let Some(config) = config(&state) else {
        return next.run(req).await;
    };
    let (parts, body) = req.into_parts();
    let (body, body_token) = if crate::openapi::request::has_body(&parts.headers) {
        match crate::openapi::request::buffer(body).await {
            Ok(bytes) => {
                let token = body_token(&parts.headers, &bytes);
                (Body::from(bytes), token)
            }
            Err(unbuffered) => return unbuffered.response(&parts.method, &parts.headers),
        }
    } else {
        (body, BodyToken::Absent)
    };
    let req = Request::from_parts(parts, body);
    let body_token = match body_token {
        // A body the parsers read in a way not reproduced here has no
        // token csurf could find.
        BodyToken::Absent | BodyToken::Unsure => None,
        BodyToken::Found(token) => Some(token),
        // Node answers the parser's error before csurf: no cookies.
        BodyToken::ParserFails => return next.run(req).await,
    };
    let (secret, fresh) = if let Some(secret) = request_secret(req.headers()) {
        (secret, None)
    } else {
        let Some(secret) = new_secret() else {
            tracing::error!("no randomness for a csrf secret");
            return error_response(&req, 500, "misconfigured csrf");
        };
        (Secret::Text(secret.clone()), Some(secret))
    };
    let fresh_cookie = fresh.map(|s| secret_cookie(&s, config));
    if !ignored(req.method(), req.uri().path()) {
        let token = body_token.or_else(|| query_token(req.uri().query().unwrap_or("")));
        let token = token.or_else(|| header_token(req.headers()));
        if !verify(&secret, token.as_ref()) {
            let mut res = error_response(&req, 403, "invalid csrf token");
            prepend_cookies(&mut res, fresh_cookie.into_iter().collect());
            return res;
        }
    }
    let Secret::Text(secret_text) = &secret else {
        // `req.csrfToken()` throws in the XSRF-TOKEN middleware.
        return error_response(&req, 500, "argument secret is required");
    };
    let cleared = under(req.uri().path(), "/imageproxy") || under(req.uri().path(), "/avatarproxy");
    let mut res = next.run(req).await;
    if cleared {
        return res;
    }
    let mut cookies: Vec<String> = fresh_cookie.into_iter().collect();
    cookies.push(xsrf_cookie(&create_token(secret_text), config));
    prepend_cookies(&mut res, cookies);
    res
}

/// `path` is `prefix` or below it (Express mounts match case-insensitively).
fn under(path: &str, prefix: &str) -> bool {
    path.get(..prefix.len())
        .is_some_and(|p| p.eq_ignore_ascii_case(prefix))
        && matches!(path.as_bytes().get(prefix.len()), None | Some(b'/'))
}

/// `ignoreMethods` (`GET`, `HEAD`, `OPTIONS`) and `ignoreRequest`.
fn ignored(method: &Method, path: &str) -> bool {
    matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS)
        || (*method == Method::POST && IGNORED_POSTS.contains(&path))
}

/// A header value as Node holds it: Latin-1, one character per byte.
fn latin1(bytes: &[u8]) -> String {
    bytes.iter().copied().map(char::from).collect()
}

/// `req.headers[name]`: repeated headers joined with `, `, as Node does
/// for headers it doesn't know.
fn joined_header(headers: &HeaderMap, name: &str, separator: &str) -> Option<String> {
    let values: Vec<String> = headers
        .get_all(name)
        .iter()
        .map(|v| latin1(v.as_bytes()))
        .collect();
    (!values.is_empty()).then(|| values.join(separator))
}

/// `req.cookies._csrf` after cookie-parser, or `None` when csurf makes a
/// new secret (missing or empty).
fn request_secret(headers: &HeaderMap) -> Option<Secret> {
    let cookies = joined_header(headers, "cookie", "; ")?;
    let raw = crate::openapi::request::cookie_raw(&cookies, SECRET_COOKIE)?;
    let value = crate::jsval::decode_uri_component(raw).unwrap_or_else(|| raw.to_owned());
    if let Some(json) = value.strip_prefix("j:") {
        // cookie-parser's `JSONCookie`: kept when it parses to a truthy value.
        match serde_json::from_str::<Value>(json) {
            Ok(Value::String(s)) if !s.is_empty() => return Some(Secret::Text(s)),
            Ok(
                other @ (Value::Bool(_) | Value::Number(_) | Value::Array(_) | Value::Object(_)),
            ) if crate::settings::public::truthy(Some(&other)) => {
                return Some(Secret::NotText);
            }
            Ok(_) | Err(_) => {}
        }
    }
    (!value.is_empty()).then_some(Secret::Text(value))
}

/// A JSON value as `value()`'s `||` chain sees it.
fn truthy_token(value: &Value) -> Option<Token> {
    match value {
        Value::String(s) if !s.is_empty() => Some(Token::Text(s.clone())),
        Value::String(_) | Value::Null => None,
        other @ (Value::Bool(_) | Value::Number(_) | Value::Array(_) | Value::Object(_)) => {
            crate::settings::public::truthy(Some(other)).then_some(Token::NotText)
        }
    }
}

/// `req.body._csrf` after `express.json()` / `express.urlencoded()`.
fn body_token(headers: &HeaderMap, bytes: &Bytes) -> BodyToken {
    let mut content_types = headers.get_all(header::CONTENT_TYPE).iter();
    let (Some(content_type), None) = (content_types.next(), content_types.next()) else {
        return if headers.contains_key(header::CONTENT_TYPE) {
            BodyToken::Unsure
        } else {
            BodyToken::Absent
        };
    };
    let Some((media, params)) = content_type
        .to_str()
        .ok()
        .and_then(crate::openapi::request::strict_content_type)
    else {
        return BodyToken::Absent;
    };
    let json = match media.as_str() {
        "application/json" => true,
        "application/x-www-form-urlencoded" => false,
        _ => return BodyToken::Absent,
    };
    let charset = params
        .iter()
        .find(|(k, _)| k == "charset")
        .map(|(_, v)| v.to_lowercase())
        .filter(|v| !v.is_empty());
    let encoded = headers
        .get(header::CONTENT_ENCODING)
        .is_some_and(|v| !v.as_bytes().eq_ignore_ascii_case(b"identity"));
    if json {
        match charset.as_deref() {
            None | Some("utf-8") => {}
            Some(c) if c.starts_with("utf-") => return BodyToken::Unsure,
            Some(_) => return BodyToken::ParserFails,
        }
    } else {
        match charset.as_deref() {
            None | Some("utf-8") => {}
            Some("iso-8859-1") => return BodyToken::Unsure,
            Some(_) => return BodyToken::ParserFails,
        }
    }
    if encoded {
        return BodyToken::Unsure;
    }
    if bytes.len() > BODY_LIMIT {
        return BodyToken::ParserFails;
    }
    if json {
        json_body_token(bytes)
    } else {
        form_body_token(bytes)
    }
}

/// `express.json()` (strict): an object or array, or the parser's 400.
fn json_body_token(bytes: &[u8]) -> BodyToken {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let first = bytes
        .iter()
        .find(|b| !matches!(b, b' ' | b'\t' | b'\n' | b'\r'));
    match first {
        None => BodyToken::Absent,
        Some(b'{' | b'[') => match serde_json::from_slice::<Value>(bytes) {
            Ok(Value::Object(map)) => map
                .get(SECRET_COOKIE)
                .and_then(truthy_token)
                .map_or(BodyToken::Absent, BodyToken::Found),
            Ok(_) => BodyToken::Absent,
            Err(_) => BodyToken::ParserFails,
        },
        Some(_) => BodyToken::ParserFails,
    }
}

/// qs's decoder: `+` is a space, then `decodeURIComponent`, keeping the
/// text when that throws.
fn qs_decode(text: &str) -> String {
    let spaced = text.replace('+', " ");
    crate::jsval::decode_uri_component(&spaced).unwrap_or(spaced)
}

/// `express.urlencoded({ extended: true })` (qs) as far as `_csrf` goes:
/// one plain value is a string, anything repeated or bracketed is an array
/// or object.
fn form_body_token(bytes: &[u8]) -> BodyToken {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return BodyToken::Unsure;
    };
    if text.is_empty() {
        return BodyToken::Absent;
    }
    if text.split('&').count() > PARAMETER_LIMIT {
        return BodyToken::ParserFails;
    }
    let mut plain = Vec::new();
    let mut nested = false;
    for part in text.split('&') {
        let split_at = part.find("]=").map(|i| i + 1).or_else(|| part.find('='));
        let (raw_key, raw_value) = split_at.map_or((part, ""), |i| {
            (part.get(..i).unwrap_or(""), part.get(i + 1..).unwrap_or(""))
        });
        let key = qs_decode(raw_key);
        if key == SECRET_COOKIE {
            plain.push(qs_decode(raw_value));
        } else if let Some(rest) = key.strip_prefix("_csrf[") {
            if rest
                .find(['[', ']'])
                .and_then(|i| rest.get(i..))
                .is_some_and(|r| r.starts_with(']'))
            {
                nested = true;
            }
        }
    }
    match (plain.as_slice(), nested) {
        ([], false) => BodyToken::Absent,
        ([one], false) if one.is_empty() => BodyToken::Absent,
        ([one], false) => BodyToken::Found(Token::Text(one.clone())),
        (_, _) => BodyToken::Found(Token::NotText),
    }
}

/// `req.query._csrf` (Express 5's `querystring` parser).
fn query_token(query: &str) -> Option<Token> {
    crate::openapi::request::parse_query(query)
        .get(SECRET_COOKIE)
        .and_then(truthy_token)
}

/// The first non-empty token header.
fn header_token(headers: &HeaderMap) -> Option<Token> {
    TOKEN_HEADERS
        .iter()
        .find_map(|name| joined_header(headers, name, ", ").filter(|v| !v.is_empty()))
        .map(Token::Text)
}

/// `hash(str)`: SHA-256 of the string's `ascii` bytes (the low byte of
/// each UTF-16 unit), URL-safe base64 without padding.
fn hash(text: &str) -> String {
    let bytes: Vec<u8> = text
        .encode_utf16()
        .map(|unit| u8::try_from(unit & 0xFF).unwrap_or_default())
        .collect();
    BASE64_URL_SAFE_NO_PAD.encode(Sha256::digest(&bytes))
}

/// `tokenize(secret, salt)`.
fn tokenize(secret: &str, salt: &str) -> String {
    format!("{salt}-{}", hash(&format!("{salt}-{secret}")))
}

/// `tokens.verify(secret, token)`.
fn verify(secret: &Secret, token: Option<&Token>) -> bool {
    let (Secret::Text(secret), Some(Token::Text(token))) = (secret, token) else {
        return false;
    };
    let Some(index) = token.find('-') else {
        return false;
    };
    let salt = token.get(..index).unwrap_or("");
    *token == tokenize(secret, salt)
}

/// `tokens.create(secret)` with an 8-character `rndm` salt.
fn create_token(secret: &str) -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let salt: String = (0..8)
        .map(|_| {
            let i = rng.gen_range(0..SALT_CHARS.len());
            SALT_CHARS.get(i).copied().map_or('0', char::from)
        })
        .collect();
    tokenize(secret, &salt)
}

/// `uid-safe.sync(18)`.
fn new_secret() -> Option<String> {
    let mut bytes = [0_u8; 18];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes).ok()?;
    Some(BASE64_URL_SAFE_NO_PAD.encode(bytes))
}

/// csurf's `Set-Cookie` for a new secret (cookie 1.x `serialize`).
fn secret_cookie(secret: &str, config: Config) -> String {
    format!(
        "{SECRET_COOKIE}={}; Path=/; HttpOnly{}; SameSite=Strict",
        crate::ratings::encode_uri_component(secret),
        if config.secure { "; Secure" } else { "" }
    )
}

/// `res.cookie('XSRF-TOKEN', token, { sameSite, secure })`.
fn xsrf_cookie(token: &str, config: Config) -> String {
    format!(
        "XSRF-TOKEN={}; Path=/{}; SameSite=Strict",
        crate::ratings::encode_uri_component(token),
        if config.secure { "; Secure" } else { "" }
    )
}

/// Put these cookies before any the inner handlers set: csurf and the
/// `XSRF-TOKEN` middleware run before the session writes its cookie.
fn prepend_cookies(res: &mut Response<Body>, cookies: Vec<String>) {
    if cookies.is_empty() {
        return;
    }
    let headers = res.headers_mut();
    let existing: Vec<HeaderValue> = headers
        .get_all(header::SET_COOKIE)
        .iter()
        .cloned()
        .collect();
    headers.remove(header::SET_COOKIE);
    for cookie in cookies {
        if let Ok(v) = HeaderValue::from_str(&cookie) {
            headers.append(header::SET_COOKIE, v);
        }
    }
    for v in existing {
        headers.append(header::SET_COOKIE, v);
    }
}

/// The error handler's `res.status(status).json({ message })`.
fn error_response(req: &Request, status: u16, message: &str) -> Response<Body> {
    let mut body = Map::new();
    body.insert(String::from("message"), Value::from(message));
    let body = Value::Object(body);
    let mut res = crate::respond::json_status(status, req.method(), req.headers(), &body);
    let length = serde_json::to_vec(&body).map_or(0, |b| b.len());
    if let Ok(v) = HeaderValue::from_str(&length.to_string()) {
        res.headers_mut().insert(header::CONTENT_LENGTH, v);
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (k, v) in pairs {
            map.append(*k, HeaderValue::from_static(v));
        }
        map
    }

    #[test]
    fn tokens_match_the_csrf_package() {
        // Made by Node: secret UApPH7OKxWA3RZT65Q3iE0NK.
        let secret = Secret::Text(String::from("UApPH7OKxWA3RZT65Q3iE0NK"));
        let token = Token::Text(String::from(
            "N6YZyhW5-EdxldnpVpkKqK-kxWp9dXoumYQd4PCZMMhBPN4LfPLE",
        ));
        assert!(verify(&secret, Some(&token)), "Node's token verifies");
        let other = Token::Text(String::from(
            "N6YZyhW5-EdxldnpVpkKqK-kxWp9dXoumYQd4PCZMMhBPN4LfPLF",
        ));
        assert!(!verify(&secret, Some(&other)), "a changed token fails");
        assert!(!verify(&secret, None), "no token");
        assert!(
            !verify(&Secret::NotText, Some(&token)),
            "a JSON cookie secret"
        );
        let made = create_token("UApPH7OKxWA3RZT65Q3iE0NK");
        assert_eq!(made.len(), 52, "8 + 1 + 43 characters");
        assert!(
            verify(&secret, Some(&Token::Text(made))),
            "own tokens verify"
        );
        assert_eq!(new_secret().map(|s| s.len()), Some(24), "18 bytes");
    }

    #[test]
    fn secrets_read_like_cookie_parser() {
        assert_eq!(request_secret(&headers(&[])), None, "no cookie");
        assert_eq!(
            request_secret(&headers(&[("cookie", "a=1; _csrf=")])),
            None,
            "empty"
        );
        assert_eq!(
            request_secret(&headers(&[
                ("cookie", "a=1"),
                ("cookie", "_csrf=x%41; _csrf=y")
            ])),
            Some(Secret::Text(String::from("xA"))),
            "joined headers, first pair, decoded"
        );
        assert_eq!(
            request_secret(&headers(&[("cookie", "_csrf=j:{\"a\":1}")])),
            Some(Secret::NotText),
            "a JSON object"
        );
        assert_eq!(
            request_secret(&headers(&[("cookie", "_csrf=j:\"s\"")])),
            Some(Secret::Text(String::from("s"))),
            "a JSON string"
        );
        assert_eq!(
            request_secret(&headers(&[("cookie", "_csrf=j:0")])),
            Some(Secret::Text(String::from("j:0"))),
            "a falsy JSON value keeps the text"
        );
    }

    #[test]
    fn tokens_come_from_body_query_and_headers() {
        let json = headers(&[
            ("content-type", "application/json"),
            ("content-length", "1"),
        ]);
        assert_eq!(
            body_token(&json, &Bytes::from_static(br#"{"_csrf":"t"}"#)),
            BodyToken::Found(Token::Text(String::from("t"))),
            "JSON"
        );
        assert_eq!(
            body_token(&json, &Bytes::from_static(br#"{"_csrf":0}"#)),
            BodyToken::Absent,
            "falsy"
        );
        assert_eq!(
            body_token(&json, &Bytes::from_static(b"{x")),
            BodyToken::ParserFails,
            "bad JSON"
        );
        assert_eq!(
            body_token(&json, &Bytes::from_static(b"\"s\"")),
            BodyToken::ParserFails,
            "strict"
        );
        let form = headers(&[("content-type", "application/x-www-form-urlencoded")]);
        assert_eq!(
            body_token(&form, &Bytes::from_static(b"a=1&_csrf=x+y%21")),
            BodyToken::Found(Token::Text(String::from("x y!"))),
            "form"
        );
        assert_eq!(
            body_token(&form, &Bytes::from_static(b"_csrf=a&_csrf=b")),
            BodyToken::Found(Token::NotText),
            "repeated"
        );
        assert_eq!(
            body_token(&form, &Bytes::from_static(b"_csrf[]=a")),
            BodyToken::Found(Token::NotText),
            "bracketed"
        );
        assert_eq!(
            body_token(&form, &Bytes::from_static(b"_csrf[=a")),
            BodyToken::Absent,
            "not a bracket pair"
        );
        assert_eq!(
            query_token("_csrf=a%20b"),
            Some(Token::Text(String::from("a b"))),
            "query"
        );
        assert_eq!(
            query_token("_csrf=a&_csrf=b"),
            Some(Token::NotText),
            "array"
        );
        assert_eq!(
            header_token(&headers(&[("x-csrf-token", ""), ("x-xsrf-token", "z")])),
            Some(Token::Text(String::from("z"))),
            "empty headers skipped"
        );
    }

    #[test]
    fn cookies_serialize_like_node() {
        let dev = Config { secure: false };
        let prod = Config { secure: true };
        assert_eq!(
            secret_cookie("abc", dev),
            "_csrf=abc; Path=/; HttpOnly; SameSite=Strict",
            "dev secret"
        );
        assert_eq!(
            secret_cookie("abc", prod),
            "_csrf=abc; Path=/; HttpOnly; Secure; SameSite=Strict",
            "production secret"
        );
        assert_eq!(
            xsrf_cookie("s-t", prod),
            "XSRF-TOKEN=s-t; Path=/; Secure; SameSite=Strict",
            "production token"
        );
        assert!(ignored(&Method::GET, "/x"), "GET");
        assert!(
            ignored(&Method::POST, "/api/v1/desktop/auth-tickets/redeem"),
            "redeem"
        );
        assert!(!ignored(&Method::POST, "/api/v1/auth/logout"), "POST");
    }
}
