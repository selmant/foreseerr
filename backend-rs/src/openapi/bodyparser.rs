//! `express.json()` and `express.urlencoded({ extended: true })`
//! (body-parser 2.2.2 over raw-body 3 and iconv-lite 0.7.2) as they read
//! a request body: the charset check, `Content-Encoding` (gzip, deflate,
//! brotli), the 100 kB limit, the charset decoding, then `JSON.parse` in
//! strict mode or `qs.parse`.

use axum::http::HeaderMap;
use serde_json::{Map, Value};

use super::iconv::{self, Charset};
use super::qs;
use super::request::node_header;

/// body-parser's default `limit` (100 kb).
pub(super) const LIMIT: usize = 100 * 1024;

/// What the parsers leave in `req.body`.
#[derive(Debug)]
pub(super) enum Parsed {
    /// JSON.
    Json(Value),
    /// A form, as `qs` built it.
    Form(Value),
}

/// An `HttpError` the parsers raise: status and message.
pub(super) type Failure = (u16, String);

fn failure(status: u16, message: impl Into<String>) -> Failure {
    (status, message.into())
}

/// Which parser takes the content type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Json,
    Form,
}

/// `read(req, ...)` for a request whose content type `kind` parses, with
/// `charset` the content type's charset parameter (lower case, `None`
/// when missing, empty or unparsable).
pub(super) fn read(
    kind: Kind,
    charset: Option<&str>,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<Parsed, Failure> {
    let charset = charset.unwrap_or("utf-8");
    let valid = match kind {
        Kind::Json => charset.get(..4) == Some("utf-"),
        Kind::Form => charset == "utf-8" || charset == "iso-8859-1",
    };
    if !valid {
        return Err(unsupported_charset(charset));
    }
    let encoding = node_header(headers, "content-encoding")
        .map_or_else(|| String::from("identity"), |e| e.to_lowercase());
    let compression = match encoding.as_str() {
        "identity" => None,
        "deflate" => Some(Compression::Deflate),
        "gzip" => Some(Compression::Gzip),
        "br" => Some(Compression::Brotli),
        other => {
            return Err(failure(
                415,
                format!("unsupported content encoding \"{other}\""),
            ))
        }
    };
    let Some(decoder) = iconv::lookup(charset) else {
        return Err(unsupported_charset(charset));
    };
    let raw = match compression {
        None => {
            // raw-body checks the declared length before reading.
            let limit = f64::from(u32::try_from(LIMIT).unwrap_or(u32::MAX));
            let declared = node_header(headers, "content-length")
                .map(|l| crate::jsval::parse_int(&l, Some(10)))
                .filter(|n| !n.is_nan());
            if declared.is_some_and(|n| n > limit) || body.len() > LIMIT {
                return Err(failure(413, "request entity too large"));
            }
            body.to_vec()
        }
        Some(compression) => inflate(compression, body)?,
    };
    let text = iconv::decode(&raw, decoder);
    match kind {
        Kind::Json => json(&text),
        Kind::Form => form(&text, decoder == Charset::Latin1),
    }
}

fn unsupported_charset(charset: &str) -> Failure {
    failure(
        415,
        format!("unsupported charset \"{}\"", charset.to_uppercase()),
    )
}

#[derive(Debug, Clone, Copy)]
enum Compression {
    Deflate,
    Gzip,
    Brotli,
}

/// Decompress as Node's zlib streams do (gzip members one after
/// another, trailing zero bytes ignored), stopping with raw-body's 413
/// once the output passes the limit. Errors carry zlib's and brotli's
/// messages as Node words them.
fn inflate(compression: Compression, body: &[u8]) -> Result<Vec<u8>, Failure> {
    let mut out = Vec::new();
    match compression {
        Compression::Brotli => brotli(body, &mut out)?,
        Compression::Deflate => {
            zlib(flate2::Decompress::new(true), body, &mut out)?;
        }
        Compression::Gzip => {
            let mut rest = body;
            loop {
                let used = zlib(flate2::Decompress::new_gzip(15), rest, &mut out)?;
                rest = rest.get(used..).unwrap_or_default();
                if rest.first().is_none_or(|b| *b == 0) {
                    break;
                }
            }
        }
    }
    Ok(out)
}

/// One zlib stream from `input` into `out`; the bytes it used.
fn zlib(mut stream: flate2::Decompress, input: &[u8], out: &mut Vec<u8>) -> Result<usize, Failure> {
    let mut chunk = vec![0_u8; 16 * 1024];
    loop {
        let before_in = stream.total_in();
        let before_out = stream.total_out();
        let at = usize::try_from(before_in).unwrap_or(usize::MAX);
        let status = stream
            .decompress(
                input.get(at..).unwrap_or_default(),
                &mut chunk,
                flate2::FlushDecompress::Finish,
            )
            .map_err(|e| failure(400, e.message().unwrap_or("invalid data")))?;
        let produced = usize::try_from(stream.total_out() - before_out).unwrap_or(0);
        out.extend_from_slice(chunk.get(..produced).unwrap_or_default());
        if out.len() > LIMIT {
            return Err(failure(413, "request entity too large"));
        }
        match status {
            flate2::Status::StreamEnd => {
                return Ok(usize::try_from(stream.total_in()).unwrap_or(usize::MAX));
            }
            flate2::Status::Ok | flate2::Status::BufError => {
                if produced == 0 && stream.total_in() == before_in {
                    return Err(failure(400, "unexpected end of file"));
                }
            }
        }
    }
}

/// A brotli stream from `input` into `out`.
fn brotli(input: &[u8], out: &mut Vec<u8>) -> Result<(), Failure> {
    use brotli_decompressor::{BrotliDecompressStream, BrotliResult, BrotliState, StandardAlloc};
    let mut state = BrotliState::new(
        StandardAlloc::default(),
        StandardAlloc::default(),
        StandardAlloc::default(),
    );
    let (mut available_in, mut input_offset) = (input.len(), 0_usize);
    let mut chunk = vec![0_u8; 16 * 1024];
    let mut total = 0_usize;
    loop {
        let (mut available_out, mut output_offset) = (chunk.len(), 0_usize);
        let result = BrotliDecompressStream(
            &mut available_in,
            &mut input_offset,
            input,
            &mut available_out,
            &mut output_offset,
            &mut chunk,
            &mut total,
            &mut state,
        );
        out.extend_from_slice(chunk.get(..output_offset).unwrap_or_default());
        if out.len() > LIMIT {
            return Err(failure(413, "request entity too large"));
        }
        match result {
            BrotliResult::ResultSuccess => return Ok(()),
            BrotliResult::NeedsMoreOutput => {}
            BrotliResult::NeedsMoreInput => return Err(failure(400, "unexpected end of file")),
            BrotliResult::ResultFailure => return Err(failure(400, "Decompression failed")),
        }
    }
}

/// The json parser's `parse(body)`: `{}` for nothing, only an object or
/// an array at the top (strict mode), then the JSON itself.
fn json(text: &[u16]) -> Result<Parsed, Failure> {
    if text.is_empty() {
        return Ok(Parsed::Json(Value::Object(Map::new())));
    }
    let text = String::from_utf16_lossy(text);
    match text
        .trim_start_matches([' ', '\t', '\n', '\r'])
        .chars()
        .next()
    {
        Some('{' | '[') => {}
        Some(_) => {
            return Err(failure(
                400,
                "Invalid JSON body: expected an object or an array",
            ))
        }
        None => return Err(failure(400, "Invalid JSON body: empty")),
    }
    serde_json::from_str(&text)
        .map(Parsed::Json)
        .map_err(|e| failure(400, format!("Invalid JSON body: {e}")))
}

/// The urlencoded parser's `parse(body)`: the parameter count, then `qs`.
fn form(text: &[u16], latin1: bool) -> Result<Parsed, Failure> {
    if text.is_empty() {
        return Ok(Parsed::Form(Value::Object(Map::new())));
    }
    let text = String::from_utf16_lossy(text);
    let count = text.matches('&').count() + 1;
    if count > 1000 {
        return Err(failure(413, "too many parameters"));
    }
    let options = qs::Options {
        allow_prototypes: true,
        array_limit: count.max(100),
        depth: 32,
        latin1,
        parameter_limit: 1000,
        strict_depth: true,
    };
    qs::parse(&text, &options).map_or_else(
        |qs::DepthExceeded| Err(failure(400, "The input exceeded the depth")),
        |obj| Ok(Parsed::Form(Value::Object(qs::obj_json(&obj)))),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn gzip(data: &[u8]) -> Vec<u8> {
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let written = enc.write_all(data);
        assert!(written.is_ok(), "compressing");
        enc.finish().unwrap_or_default()
    }

    fn headers(encoding: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        if let Ok(v) = encoding.parse() {
            h.insert("content-encoding", v);
        }
        h
    }

    fn run(encoding: &str, charset: Option<&str>, body: &[u8]) -> String {
        match read(Kind::Json, charset, &headers(encoding), body) {
            Ok(Parsed::Json(v) | Parsed::Form(v)) => v.to_string(),
            Err((status, message)) => format!("{status} {message}"),
        }
    }

    /// Bun 1.4.1 with body-parser 2.2.2.
    #[test]
    fn reads_like_body_parser() {
        let good = br#"{"a":1}"#;
        assert_eq!(run("gzip", None, &gzip(good)), r#"{"a":1}"#, "gzip");
        assert_eq!(run("GZIP", None, &gzip(good)), r#"{"a":1}"#, "upper case");
        assert_eq!(
            run("gzip", None, b"notgzipdata"),
            "400 incorrect header check",
            "corrupt"
        );
        assert_eq!(
            run("gzip", None, gzip(good).get(..10).unwrap_or_default()),
            "400 unexpected end of file",
            "truncated"
        );
        let mut concat = gzip(br#"{"a":"#);
        concat.extend(gzip(b"2}"));
        assert_eq!(run("gzip", None, &concat), r#"{"a":2}"#, "two members");
        let mut trailing = gzip(good);
        trailing.extend(b"xx");
        assert_eq!(
            run("gzip", None, &trailing),
            "400 incorrect header check",
            "trailing data"
        );
        assert_eq!(
            run("gzip", None, b""),
            "400 unexpected end of file",
            "empty"
        );
        assert_eq!(
            run("br", None, b"zzzzzz"),
            "400 Decompression failed",
            "corrupt brotli"
        );
        assert_eq!(
            run("compress", None, good),
            "415 unsupported content encoding \"compress\"",
            "unknown encoding"
        );
        assert_eq!(
            run("gzip, gzip", None, good),
            "415 unsupported content encoding \"gzip, gzip\"",
            "two encodings"
        );
        assert_eq!(
            run("identity", Some("utf-9"), good),
            "415 unsupported charset \"UTF-9\"",
            "unknown charset"
        );
        assert_eq!(
            run("identity", Some("latin1"), good),
            "415 unsupported charset \"LATIN1\"",
            "not utf"
        );
        assert_eq!(
            run("identity", None, b"   "),
            "400 Invalid JSON body: empty",
            "whitespace"
        );
        assert_eq!(
            run("identity", None, b"null"),
            "400 Invalid JSON body: expected an object or an array",
            "strict"
        );
        assert!(
            run("identity", None, b"{\"a\":").starts_with("400 Invalid JSON body: EOF"),
            "truncated"
        );
        assert_eq!(
            run(
                "identity",
                None,
                &[0x7B, 0x22, 0x61, 0x22, 0x3A, 0x22, 0xFF, 0x22, 0x7D]
            ),
            "{\"a\":\"\u{fffd}\"}",
            "bad UTF-8"
        );
    }

    #[test]
    fn reads_forms() {
        let h = HeaderMap::new();
        let latin1 = read(
            Kind::Form,
            Some("iso-8859-1"),
            &h,
            &[0x61, 0x3D, 0xE9, 0x26, 0x62, 0x3D, 0x25, 0x45, 0x39],
        );
        assert!(
            matches!(&latin1, Ok(Parsed::Form(v)) if *v == serde_json::json!({"a": "\u{e9}", "b": "\u{e9}"})),
            "latin-1: {latin1:?}"
        );
        let utf16 = read(Kind::Form, Some("utf-16"), &h, b"a=1");
        assert!(
            matches!(&utf16, Err((415, m)) if m == "unsupported charset \"UTF-16\""),
            "forms take two charsets"
        );
        let many = "a=1&".repeat(1000);
        assert!(
            matches!(read(Kind::Form, None, &h, many.as_bytes()), Err((413, _))),
            "too many parameters"
        );
    }
}
