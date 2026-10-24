//! The part of xml2js that plex.tv's XML answers need.
//!
//! Strict parsing, attributes under `$`, children as arrays: elements,
//! their attributes in document order, and their child elements. Anything
//! sax would reject in strict mode, or that isn't followed here (DOCTYPE,
//! unknown entities, duplicate attributes), is refused so the route can
//! hand the request to Node.

/// One element: name, attributes in document order, child elements.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Element {
    pub(super) name: String,
    pub(super) attrs: Vec<(String, String)>,
    pub(super) children: Vec<Self>,
}

impl Element {
    /// An attribute's value.
    pub(super) fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    /// The child elements named `name`, in order.
    pub(super) fn children_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Self> {
        self.children.iter().filter(move |c| c.name == name)
    }

    /// Whether xml2js gives this element a `$` (at least one attribute).
    pub(super) fn has_attrs(&self) -> bool {
        !self.attrs.is_empty()
    }
}

/// Nesting deeper than this is refused.
const MAX_DEPTH: usize = 64;

struct Parser<'a> {
    text: &'a str,
    pos: usize,
}

impl<'a> Parser<'a> {
    fn rest(&self) -> &'a str {
        self.text.get(self.pos..).unwrap_or("")
    }

    fn eat(&mut self, prefix: &str) -> bool {
        if self.rest().starts_with(prefix) {
            self.pos += prefix.len();
            true
        } else {
            false
        }
    }

    fn skip_ws(&mut self) {
        let trimmed = self.rest().trim_start_matches([' ', '\t', '\r', '\n']);
        self.pos = self.text.len() - trimmed.len();
    }

    /// Skip to just past `end`.
    fn skip_past(&mut self, end: &str) -> Option<()> {
        let at = self.rest().find(end)?;
        self.pos += at + end.len();
        Some(())
    }

    /// Comments and processing instructions between markup.
    fn skip_misc(&mut self) -> Option<()> {
        loop {
            self.skip_ws();
            if self.eat("<!--") {
                self.skip_past("-->")?;
            } else if self.rest().starts_with("<?") {
                self.skip_past("?>")?;
            } else {
                return Some(());
            }
        }
    }

    fn name(&mut self) -> Option<String> {
        let rest = self.rest();
        let end = rest
            .find(|c: char| c.is_whitespace() || matches!(c, '/' | '>' | '=' | '<'))
            .unwrap_or(rest.len());
        let name = rest.get(..end)?;
        if name.is_empty() {
            return None;
        }
        self.pos += end;
        Some(name.to_owned())
    }

    fn element(&mut self, depth: usize) -> Option<Element> {
        if depth > MAX_DEPTH || !self.eat("<") {
            return None;
        }
        let name = self.name()?;
        let mut attrs: Vec<(String, String)> = Vec::new();
        loop {
            self.skip_ws();
            if self.eat("/>") {
                return Some(Element {
                    name,
                    attrs,
                    children: Vec::new(),
                });
            }
            if self.eat(">") {
                break;
            }
            let key = self.name()?;
            self.skip_ws();
            if !self.eat("=") {
                return None;
            }
            self.skip_ws();
            let quote = self
                .rest()
                .chars()
                .next()
                .filter(|c| matches!(c, '"' | '\''))?;
            self.pos += 1;
            let raw_end = self.rest().find(quote)?;
            let raw = self.rest().get(..raw_end)?;
            if raw.contains('<') {
                return None;
            }
            let value = decode_entities(raw)?;
            self.pos += raw_end + 1;
            if attrs.iter().any(|(k, _)| *k == key) {
                return None;
            }
            attrs.push((key, value));
        }
        let mut children = Vec::new();
        loop {
            let rest = self.rest();
            let next = rest.find('<')?;
            decode_entities(rest.get(..next)?)?;
            self.pos += next;
            if self.eat("</") {
                let close = self.name()?;
                self.skip_ws();
                if close != name || !self.eat(">") {
                    return None;
                }
                return Some(Element {
                    name,
                    attrs,
                    children,
                });
            }
            if self.eat("<!--") {
                self.skip_past("-->")?;
            } else if self.eat("<![CDATA[") {
                self.skip_past("]]>")?;
            } else if self.rest().starts_with("<?") {
                self.skip_past("?>")?;
            } else if self.rest().starts_with("<!") {
                return None;
            } else {
                children.push(self.element(depth + 1)?);
            }
        }
    }
}

/// XML's five entities and character references; none for anything else.
fn decode_entities(raw: &str) -> Option<String> {
    if !raw.contains('&') {
        return Some(raw.to_owned());
    }
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(at) = rest.find('&') {
        out.push_str(rest.get(..at)?);
        let after = rest.get(at + 1..)?;
        let end = after.find(';')?;
        let entity = after.get(..end)?;
        let decoded = match entity {
            "lt" => '<',
            "gt" => '>',
            "amp" => '&',
            "quot" => '"',
            "apos" => '\'',
            _ => {
                let code = if let Some(hex) = entity.strip_prefix("#x") {
                    u32::from_str_radix(hex, 16).ok()?
                } else {
                    entity.strip_prefix('#')?.parse::<u32>().ok()?
                };
                char::from_u32(code)?
            }
        };
        out.push(decoded);
        rest = after.get(end + 1..)?;
    }
    out.push_str(rest);
    Some(out)
}

/// Parse a whole document into its root element.
pub(super) fn parse(xml: &str) -> Option<Element> {
    let mut parser = Parser {
        text: xml.strip_prefix('\u{feff}').unwrap_or(xml),
        pos: 0,
    };
    parser.skip_misc()?;
    if parser.rest().starts_with("<!") {
        return None;
    }
    let root = parser.element(0)?;
    parser.skip_misc()?;
    parser.rest().is_empty().then_some(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plex_shapes() {
        let xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<MediaContainer size=\"1\">\n  <Device name=\"A &amp; B\" provides=\"server\" owned=\"1\">\n    <Connection protocol=\"https\" address=\"10.0.0.2\" port=\"32400\" uri=\"https://x\" local=\"1\"/>\n  </Device>\n</MediaContainer>\n";
        let root = parse(xml);
        let device = root
            .as_ref()
            .and_then(|r| r.children_named("Device").next());
        assert_eq!(device.and_then(|d| d.attr("name")), Some("A & B"), "entity");
        assert_eq!(
            device.map(|d| d.children_named("Connection").count()),
            Some(1),
            "child"
        );
        assert!(parse("<a><b></a>").is_none(), "mismatched");
        assert!(
            parse("<a x=\"1\" x=\"2\"/>").is_none(),
            "duplicate attribute"
        );
        assert!(parse("<a x=\"&nbsp;\"/>").is_none(), "unknown entity");
        assert!(parse("<!DOCTYPE a><a/>").is_none(), "doctype");
        assert_eq!(
            parse("<a b='&#65;&#x42;'/>").map(|a| a.attrs),
            Some(vec![(String::from("b"), String::from("AB"))]),
            "char refs"
        );
    }
}
