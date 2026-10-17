//! iconv-lite 0.7.2's decoders for the charsets the body parsers accept:
//! the `utf-*` family for JSON, `utf-8` and `iso-8859-1` for forms. The
//! result is a JavaScript string (UTF-16 units, lone surrogates and all),
//! with a leading byte-order mark stripped as `getDecoder` does. The body
//! is decoded as one chunk.

/// A charset iconv-lite knows, by its canonical name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Charset {
    Utf8,
    Utf16Le,
    Utf16Be,
    Utf16,
    Utf32Le,
    Utf32Be,
    Utf32,
    Utf7,
    Utf7Imap,
    Latin1,
}

/// `iconv.encodingExists(name)` for the names a body parser can ask for:
/// `_canonicalizeEncoding` (lower case, a trailing `:NNNN` and anything
/// but letters and digits dropped), then the aliases.
pub(super) fn lookup(name: &str) -> Option<Charset> {
    let lower = name.to_lowercase();
    let bytes = lower.as_bytes();
    let trimmed = match bytes.len().checked_sub(5).and_then(|at| lower.get(at..)) {
        Some(tail) if tail.starts_with(':') && tail.bytes().skip(1).all(|b| b.is_ascii_digit()) => {
            lower.get(..lower.len() - 5).unwrap_or("")
        }
        _ => lower.as_str(),
    };
    let canonical: String = trimmed
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .collect();
    Some(match canonical.as_str() {
        "utf8" | "unicode11utf8" => Charset::Utf8,
        "utf16le" | "ucs2" => Charset::Utf16Le,
        "utf16be" => Charset::Utf16Be,
        "utf16" => Charset::Utf16,
        "utf32le" | "ucs4le" => Charset::Utf32Le,
        "utf32be" | "ucs4be" => Charset::Utf32Be,
        "utf32" | "ucs4" => Charset::Utf32,
        "utf7" | "unicode11utf7" => Charset::Utf7,
        "utf7imap" => Charset::Utf7Imap,
        "iso88591" | "latin1" | "l1" | "binary" | "cp819" | "ibm819" | "isoir100" => {
            Charset::Latin1
        }
        _ => return None,
    })
}

/// The body as the decoder for `charset` turns it into a string.
pub(super) fn decode(bytes: &[u8], charset: Charset) -> Vec<u16> {
    let mut units = match charset {
        Charset::Utf8 => String::from_utf8_lossy(bytes).encode_utf16().collect(),
        Charset::Utf16Le => utf16(bytes, false),
        Charset::Utf16Be => utf16(bytes, true),
        Charset::Utf16 => utf16(bytes, detect_utf16(bytes)),
        Charset::Utf32Le => utf32(bytes, false),
        Charset::Utf32Be => utf32(bytes, true),
        Charset::Utf32 => utf32(bytes, detect_utf32(bytes)),
        Charset::Utf7 => utf7(bytes, b'+', false),
        Charset::Utf7Imap => utf7(bytes, b'&', true),
        Charset::Latin1 => return bytes.iter().map(|b| u16::from(*b)).collect(),
    };
    if units.first() == Some(&0xFEFF) {
        units.remove(0);
    }
    units
}

/// UTF-16 units; a trailing odd byte is dropped.
fn utf16(bytes: &[u8], big_endian: bool) -> Vec<u16> {
    bytes
        .chunks_exact(2)
        .map(|pair| match pair {
            [a, b] if big_endian => u16::from_be_bytes([*a, *b]),
            [a, b] => u16::from_le_bytes([*a, *b]),
            _ => 0,
        })
        .collect()
}

/// `utf16.js`'s `detectEncoding`: true for big-endian.
fn detect_utf16(bytes: &[u8]) -> bool {
    let (mut le, mut be) = (0_u32, 0_u32);
    for (i, pair) in bytes.chunks_exact(2).take(100).enumerate() {
        let (a, b) = match pair {
            [a, b] => (*a, *b),
            _ => break,
        };
        if i == 0 {
            if (a, b) == (0xFF, 0xFE) {
                return false;
            }
            if (a, b) == (0xFE, 0xFF) {
                return true;
            }
        }
        if a == 0 && b != 0 {
            be += 1;
        }
        if a != 0 && b == 0 {
            le += 1;
        }
    }
    be > le
}

/// UTF-32 code points as units: an invalid one is U+FFFD, surrogate code
/// points pass through as they are; trailing bytes are dropped.
fn utf32(bytes: &[u8], big_endian: bool) -> Vec<u16> {
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for quad in bytes.chunks_exact(4) {
        let Ok(quad) = <[u8; 4]>::try_from(quad) else {
            continue;
        };
        let raw = if big_endian {
            i32::from_be_bytes(quad)
        } else {
            i32::from_le_bytes(quad)
        };
        let code = u32::try_from(raw)
            .ok()
            .filter(|c| *c <= 0x10_FFFF)
            .unwrap_or(0xFFFD);
        if code >= 0x1_0000 {
            let rest = code - 0x1_0000;
            out.push(u16::try_from(0xD800 | (rest >> 10)).unwrap_or(0xFFFD));
            out.push(u16::try_from(0xDC00 | (rest & 0x3FF)).unwrap_or(0xFFFD));
        } else {
            out.push(u16::try_from(code).unwrap_or(0xFFFD));
        }
    }
    out
}

/// `utf32.js`'s `detectEncoding`: true for big-endian.
fn detect_utf32(bytes: &[u8]) -> bool {
    // (little-endian, big-endian) counts.
    let mut invalid = (0_i32, 0_i32);
    let mut bmp = (0_i32, 0_i32);
    for (i, quad) in bytes.chunks_exact(4).take(100).enumerate() {
        let Ok([a, b, c, d]) = <[u8; 4]>::try_from(quad) else {
            break;
        };
        if i == 0 {
            if (a, b, c, d) == (0xFF, 0xFE, 0, 0) {
                return false;
            }
            if (a, b, c, d) == (0, 0, 0xFE, 0xFF) {
                return true;
            }
        }
        if a != 0 || b > 0x10 {
            invalid.1 += 1;
        }
        if d != 0 || c > 0x10 {
            invalid.0 += 1;
        }
        if a == 0 && b == 0 && (c != 0 || d != 0) {
            bmp.1 += 1;
        }
        if (a != 0 || b != 0) && c == 0 && d == 0 {
            bmp.0 += 1;
        }
    }
    bmp.1 - invalid.1 > bmp.0 - invalid.0
}

/// iconv-lite's `ascii` (an SBCS table): bytes past 0x7F are U+FFFD.
fn ascii(bytes: &[u8]) -> impl Iterator<Item = u16> + '_ {
    bytes
        .iter()
        .map(|b| if *b < 0x80 { u16::from(*b) } else { 0xFFFD })
}

/// `Buffer.from(text, 'base64')` (lenient: other characters skipped,
/// decoding stops at `=`), then UTF-16BE with the BOM stripped.
fn base64_utf16be(text: &[u8]) -> Vec<u16> {
    let value = |c: u8| -> Option<u32> {
        Some(u32::from(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return None,
        }))
    };
    let mut bytes = Vec::new();
    let (mut acc, mut bits) = (0_u32, 0_u32);
    for c in text {
        if *c == b'=' {
            break;
        }
        let Some(v) = value(*c) else {
            continue;
        };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push(u8::try_from((acc >> bits) & 0xFF).unwrap_or(0));
        }
    }
    let mut units = utf16(&bytes, true);
    if units.first() == Some(&0xFEFF) {
        units.remove(0);
    }
    units
}

/// The UTF-7 decoders (`+` shifts for UTF-7, `&` with `,` for `/` for
/// the IMAP variant), as one chunk followed by `end()`.
fn utf7(bytes: &[u8], shift: u8, imap: bool) -> Vec<u16> {
    let base64_char =
        |b: u8| b.is_ascii_alphanumeric() || b == b'/' || b == b'+' || (imap && b == b',');
    let imap_fix = |chunk: &[u8]| -> Vec<u8> {
        chunk
            .iter()
            .map(|b| if imap && *b == b',' { b'/' } else { *b })
            .collect()
    };
    let mut out = Vec::new();
    let mut in_base64 = false;
    let mut last = 0_usize;
    let mut i = 0_usize;
    while let Some(&b) = bytes.get(i) {
        if !in_base64 {
            if b == shift {
                out.extend(ascii(bytes.get(last..i).unwrap_or_default()));
                last = i + 1;
                in_base64 = true;
            }
        } else if !base64_char(b) {
            if i == last && b == b'-' {
                out.push(u16::from(shift));
            } else {
                let chunk = imap_fix(bytes.get(last..i).unwrap_or_default());
                out.extend(base64_utf16be(&chunk));
            }
            if b != b'-' {
                // The character that ended the run is read again directly.
                last = i;
                in_base64 = false;
                continue;
            }
            last = i + 1;
            in_base64 = false;
        }
        i += 1;
    }
    let rest = bytes.get(last..).unwrap_or_default();
    if in_base64 {
        // `write` decodes whole groups of 8; `end()` the remainder.
        let text = imap_fix(rest);
        let whole = text.len() - text.len() % 8;
        out.extend(base64_utf16be(text.get(..whole).unwrap_or_default()));
        let tail = text.get(whole..).unwrap_or_default();
        if !tail.is_empty() {
            out.extend(base64_utf16be(tail));
        }
    } else {
        out.extend(ascii(rest));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(units: &[u16]) -> String {
        String::from_utf16_lossy(units)
    }

    #[test]
    fn canonical_names() {
        assert_eq!(lookup("UTF-8"), Some(Charset::Utf8), "upper case");
        assert_eq!(
            lookup("utf-16-le"),
            Some(Charset::Utf16Le),
            "dashes dropped"
        );
        assert_eq!(lookup("utf-8:2024"), Some(Charset::Utf8), "a year suffix");
        assert_eq!(lookup("utf-9"), None, "unknown");
        assert_eq!(lookup("iso-8859-1"), Some(Charset::Latin1), "latin-1");
    }

    #[test]
    fn decodes_like_iconv_lite() {
        let le: Vec<u8> = "{\"a\":\"\u{e9}\"}"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        assert_eq!(
            text(&decode(&le, Charset::Utf16)),
            "{\"a\":\"\u{e9}\"}",
            "guessed LE"
        );
        let mut be = vec![0xFE, 0xFF];
        be.extend("{}".encode_utf16().flat_map(u16::to_be_bytes));
        assert_eq!(text(&decode(&be, Charset::Utf16)), "{}", "BOM, big-endian");
        assert_eq!(
            text(&decode(b"{\"a\":1}", Charset::Utf16)),
            "\u{227b}\u{2261}\u{313a}",
            "ASCII read as UTF-16LE"
        );
        assert_eq!(
            text(&decode(&[0x7b, 0, 0, 0, 0x7d, 0, 0, 0], Charset::Utf32)),
            "{}",
            "UTF-32 guessed LE"
        );
        assert_eq!(
            text(&decode(b"{\"a\":\"+AOk-\"}", Charset::Utf7)),
            "{\"a\":\"\u{e9}\"}",
            "UTF-7 base64 run"
        );
        assert_eq!(
            text(&decode(&[b'"', 0xE9, b'"'], Charset::Utf7)),
            "\"\u{fffd}\"",
            "high bytes in UTF-7"
        );
        assert_eq!(text(&decode(b"a+-b", Charset::Utf7)), "a+b", "+- is a plus");
        assert_eq!(
            text(&decode(&[0xEF, 0xBB, 0xBF, b'1'], Charset::Utf8)),
            "1",
            "BOM stripped"
        );
    }
}
