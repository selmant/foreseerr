//! The notification strings in every locale (`locale/*.json`, the files
//! Node's `server/i18n` used), embedded at build time, with the subset of
//! ICU `MessageFormat` they use.

use std::collections::HashMap;
use std::sync::OnceLock;

/// Every locale file, by name.
const LOCALES: [(&str, &str); 41] = [
    ("ar", include_str!("../locale/ar.json")),
    ("bg", include_str!("../locale/bg.json")),
    ("ca", include_str!("../locale/ca.json")),
    ("cs", include_str!("../locale/cs.json")),
    ("da", include_str!("../locale/da.json")),
    ("de", include_str!("../locale/de.json")),
    ("el", include_str!("../locale/el.json")),
    ("en", include_str!("../locale/en.json")),
    ("es", include_str!("../locale/es.json")),
    ("es-MX", include_str!("../locale/es-MX.json")),
    ("et", include_str!("../locale/et.json")),
    ("eu", include_str!("../locale/eu.json")),
    ("fi", include_str!("../locale/fi.json")),
    ("fr", include_str!("../locale/fr.json")),
    ("he", include_str!("../locale/he.json")),
    ("hi", include_str!("../locale/hi.json")),
    ("hr", include_str!("../locale/hr.json")),
    ("hu", include_str!("../locale/hu.json")),
    ("it", include_str!("../locale/it.json")),
    ("ja", include_str!("../locale/ja.json")),
    ("kab", include_str!("../locale/kab.json")),
    ("ko", include_str!("../locale/ko.json")),
    ("lb", include_str!("../locale/lb.json")),
    ("lt", include_str!("../locale/lt.json")),
    ("nb-NO", include_str!("../locale/nb-NO.json")),
    ("nl", include_str!("../locale/nl.json")),
    ("pl", include_str!("../locale/pl.json")),
    ("pt-BR", include_str!("../locale/pt-BR.json")),
    ("pt-PT", include_str!("../locale/pt-PT.json")),
    ("ro", include_str!("../locale/ro.json")),
    ("ru", include_str!("../locale/ru.json")),
    ("sk", include_str!("../locale/sk.json")),
    ("sl", include_str!("../locale/sl.json")),
    ("sq", include_str!("../locale/sq.json")),
    ("sr", include_str!("../locale/sr.json")),
    ("sv", include_str!("../locale/sv.json")),
    ("tr", include_str!("../locale/tr.json")),
    ("uk", include_str!("../locale/uk.json")),
    ("vi", include_str!("../locale/vi.json")),
    ("zh-Hans", include_str!("../locale/zh-Hans.json")),
    ("zh-Hant", include_str!("../locale/zh-Hant.json")),
];

fn catalogue() -> &'static HashMap<&'static str, HashMap<String, String>> {
    static CATALOGUE: OnceLock<HashMap<&'static str, HashMap<String, String>>> = OnceLock::new();
    CATALOGUE.get_or_init(|| {
        LOCALES
            .iter()
            .filter_map(|(name, text)| {
                serde_json::from_str::<HashMap<String, String>>(text)
                    .ok()
                    .map(|messages| (*name, messages))
            })
            .collect()
    })
}

fn empty() -> &'static HashMap<String, String> {
    static EMPTY: OnceLock<HashMap<String, String>> = OnceLock::new();
    EMPTY.get_or_init(HashMap::new)
}

/// `getIntl(locale)`: the requested locale, else the server's, else English.
#[derive(Debug, Clone, Copy)]
pub struct Intl {
    messages: &'static HashMap<String, String>,
    english: &'static HashMap<String, String>,
}

impl Intl {
    /// The catalogue for `locale`, falling back to `server_locale`, then
    /// English, as `getIntl` does.
    #[must_use]
    pub fn new(locale: Option<&str>, server_locale: &str) -> Self {
        let all = catalogue();
        let english = all.get("en");
        let requested = locale
            .filter(|l| !l.is_empty())
            .or_else(|| (!server_locale.is_empty()).then_some(server_locale));
        let messages = requested.and_then(|l| all.get(l)).or(english);
        let empty = empty();
        Self {
            messages: messages.unwrap_or(empty),
            english: english.unwrap_or(empty),
        }
    }

    /// `formatMessage` where an argument may be missing: formatjs then
    /// gives up and returns the message unformatted.
    #[must_use]
    pub fn format_strict(&self, id: &str, args: &[(&str, Option<&str>)]) -> String {
        let text = self.text(id);
        if args
            .iter()
            .any(|(name, value)| value.is_none() && text.contains(&format!("{{{name}}}")))
        {
            return text.to_owned();
        }
        let present: Vec<(&str, &str)> = args
            .iter()
            .filter_map(|(k, v)| v.map(|v| (*k, v)))
            .collect();
        render(text, &present)
    }

    /// `formatMessage`: the message for `id` (or English),
    /// with `{name}` arguments filled in.
    #[must_use]
    pub fn format(&self, id: &str, args: &[(&str, &str)]) -> String {
        render(self.text(id), args)
    }

    /// The message for `id` in this locale, else English, else the id.
    fn text<'a>(&self, id: &'a str) -> &'a str
    where
        'static: 'a,
    {
        self.messages
            .get(id)
            .or_else(|| self.english.get(id))
            .map_or(id, String::as_str)
    }
}

/// ICU `MessageFormat` for plain arguments: `{name}` is replaced, `''`
/// is a quote, and a quote before `{` or `}` starts a literal run that the
/// next lone quote ends.
fn render(text: &str, args: &[(&str, &str)]) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while let Some(&c) = chars.get(i) {
        match c {
            '\'' => {
                if chars.get(i + 1) == Some(&'\'') {
                    out.push('\'');
                    i += 2;
                } else if matches!(chars.get(i + 1), Some('{' | '}')) {
                    i += 1;
                    while let Some(&q) = chars.get(i) {
                        if q == '\'' {
                            if chars.get(i + 1) == Some(&'\'') {
                                out.push('\'');
                                i += 2;
                                continue;
                            }
                            i += 1;
                            break;
                        }
                        out.push(q);
                        i += 1;
                    }
                } else {
                    out.push('\'');
                    i += 1;
                }
            }
            '{' => {
                let end = chars
                    .get(i..)
                    .and_then(|rest| rest.iter().position(|&x| x == '}'))
                    .map(|p| p + i);
                if let Some(end) = end {
                    let name: String = chars
                        .get(i + 1..end)
                        .map(|s| s.iter().collect())
                        .unwrap_or_default();
                    let name = name.trim();
                    if let Some((_, value)) = args.iter().find(|(k, _)| *k == name) {
                        out.push_str(value);
                    }
                    i = end + 1;
                } else {
                    out.push('{');
                    i += 1;
                }
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_icu() {
        assert_eq!(
            render("Comment from {userName}", &[("userName", "Ann")]),
            "Comment from Ann",
            "argument"
        );
        assert_eq!(
            render("l'usuari {userName}", &[("userName", "x")]),
            "l'usuari x",
            "lone quote"
        );
        assert_eq!(
            render("it''s '{literal}'", &[]),
            "it's {literal}",
            "quoting"
        );
        let intl = Intl::new(Some("de"), "en");
        assert!(
            !intl
                .format("notifications.common.requestedBy", &[])
                .is_empty(),
            "lookup"
        );
        assert_eq!(
            Intl::new(Some("xx"), "").format("notifications.common.requestedBy", &[]),
            "Requested By",
            "fallback"
        );
    }
}
