//! validator.js 13.15's `isEmail(str, { require_tld: false })`, which
//! `GET /auth/me` checks addresses with when emails are required.
//!
//! The patterns test UTF-16 units, so a character past the BMP (a
//! surrogate pair) fails the local-part classes and passes the domain one.

/// `validator.isEmail(text, { require_tld: false })`.
#[must_use]
pub fn is_email(text: &str) -> bool {
    if text.encode_utf16().count() > 254 {
        return false;
    }
    let Some(at) = text.rfind('@') else {
        // `domain` is the whole text, `user` is empty.
        return is_fqdn(text) && local_part_ok("");
    };
    let (user, domain) = (
        text.get(..at).unwrap_or(""),
        text.get(at + 1..).unwrap_or(""),
    );
    // `isByteLength` counts UTF-8 bytes (`encodeURI` escapes).
    if user.len() > 64 || domain.len() > 254 {
        return false;
    }
    if !is_fqdn(domain) {
        return false;
    }
    local_part_ok(user)
}

/// The local part: quoted, or dot-separated atoms.
fn local_part_ok(user: &str) -> bool {
    let units: Vec<u16> = user.encode_utf16().collect();
    let quote = u16::from(b'"');
    if units.first() == Some(&quote) && units.last() == Some(&quote) {
        let inner = units
            .get(1..units.len().saturating_sub(1))
            .unwrap_or_default();
        return quoted_ok(inner);
    }
    user.split('.').all(|part| {
        let part: Vec<u16> = part.encode_utf16().collect();
        !part.is_empty() && part.iter().all(|u| atom_unit(*u))
    })
}

/// The atom characters: ASCII letters, digits and ``!#$%&'*+-/=?^_`{|}~``,
/// and `\u00A1-\uD7FF`, `\uF900-\uFDCF`, `\uFDF0-\uFFEF`.
fn atom_unit(u: u16) -> bool {
    if let Ok(b) = u8::try_from(u) {
        if b.is_ascii_alphanumeric() || b"!#$%&'*+-/=?^_`{|}~".contains(&b) {
            return true;
        }
    }
    matches!(u, 0x00A1..=0xD7FF | 0xF900..=0xFDCF | 0xFDF0..=0xFFEF)
}

/// JavaScript's `\s`.
const fn js_space(u: u16) -> bool {
    matches!(
        u,
        0x09..=0x0D | 0x20 | 0xA0 | 0x1680 | 0x2000..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF
    )
}

/// `quotedEmailUserUtf8`: plain units, or a backslash and an escapable
/// unit, any number of times.
fn quoted_ok(units: &[u16]) -> bool {
    let plain = |u: u16| {
        js_space(u)
            || matches!(u, 0x01..=0x08 | 0x0B | 0x0C | 0x0E..=0x1F | 0x7F | 0x21 | 0x23..=0x5B | 0x5D..=0x7E)
            || matches!(u, 0x00A0..=0xD7FF | 0xF900..=0xFDCF | 0xFDF0..=0xFFEF)
    };
    let escaped = |u: u16| {
        matches!(u, 0x01..=0x09 | 0x0B | 0x0C | 0x0D..=0x7F)
            || matches!(u, 0x00A0..=0xD7FF | 0xF900..=0xFDCF | 0xFDF0..=0xFFEF)
    };
    let mut i = 0;
    while let Some(&u) = units.get(i) {
        if u == u16::from(b'\\') {
            match units.get(i + 1) {
                Some(&next) if escaped(next) => i += 2,
                _ => return false,
            }
        } else if plain(u) {
            i += 1;
        } else {
            return false;
        }
    }
    true
}

/// `isFQDN(domain, { require_tld: false, allow_underscores: false })`.
fn is_fqdn(domain: &str) -> bool {
    let parts: Vec<&str> = domain.split('.').collect();
    let tld = parts.last().copied().unwrap_or("");
    if !tld.is_empty() && tld.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    parts.iter().all(|part| {
        let units: Vec<u16> = part.encode_utf16().collect();
        if units.len() > 63 || units.is_empty() {
            return false;
        }
        let allowed = |u: u16| {
            u8::try_from(u).map_or(u >= 0x00A1, |b| {
                b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b >= 0xA1
            })
        };
        units.iter().all(|u| allowed(*u))
            && !units.iter().any(|u| (0xFF01..=0xFF5E).contains(u))
            && !part.starts_with('-')
            && !part.ends_with('-')
            && !part.contains('_')
    })
}

#[cfg(test)]
mod tests {
    use super::is_email;

    #[test]
    fn checks_like_validator() {
        for ok in [
            "a@b",
            "admin@seerr.dev",
            "a.b+c@host",
            "\"a b\"@x",
            "\"\"@x",
            "\u{e9}@x",
            "a@xn--p1ai",
        ] {
            assert!(is_email(ok), "{ok} is an address");
        }
        for bad in [
            "",
            "plex",
            "a@",
            "@b",
            "a..b@c",
            "a@b.123",
            "a@-b",
            "a@b_c",
            "a@\u{ff21}",
            "\u{1F600}@x",
            "a b@c",
        ] {
            assert!(!is_email(bad), "{bad} isn't an address");
        }
    }
}
