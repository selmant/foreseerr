//! `server/lib/email` and the pug templates in `server/templates/email`:
//! the HTML each template renders, a plain-text part, PGP/MIME for users
//! with a key, and SMTP delivery with the agent's TLS settings.

use std::str::FromStr;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use lettre::message::{header::ContentType, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::transport::smtp::extension::ClientId;
use lettre::{Address, AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use serde_json::Value;

use crate::media::js_string;
use crate::settings::public::truthy;
use crate::settings::Settings;

/// The head every template shares.
const HEAD: &str = concat!(
    "<!DOCTYPE html><head><meta charset=\"utf-8\"><meta name=\"x-apple-disable-message-reformatting\">",
    "<meta http-equiv=\"x-ua-compatible\" content=\"ie=edge\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<meta name=\"format-detection\" content=\"telephone=no, date=no, address=no, email=no\">",
    "<style>.title:hover * {\ntext-decoration: underline;\n}\n@media only screen and (max-width:600px) {\ntable {\nfont-size: 20px !important;\nwidth: 100% !important;\n}\n}</style></head>",
);
const WRAP_OPEN: &str = "<div style=\"display: block; background-color: #111827; padding: 2.5rem 0;\"><table style=\"margin: 0 auto; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, Roboto, Oxygen, Ubuntu, Cantarell, &quot;Helvetica Neue&quot;, Arial, sans-serif; color: #fff; font-size: 16px; width: 26rem;\">";
const WRAP_CLOSE: &str = "</table></div>";
const BUTTON: &str = "padding: 0.2rem; font-weight: 500; text-align: center; border-radius: 10px; background-color: rgb(99,102,241); color: #fff; display: block; border: 1px solid rgba(255,255,255,0.2);";
const LOGO_STYLE: &str =
    "width: 26rem; image-rendering: crisp-edges; image-rendering: -webkit-optimize-contrast;";
const PARAGRAPH: &str =
    "<tr><td style=\"text-align: center;\"><div style=\"margin: 1rem 0 0; font-size: 1.25em;\">";
const PARAGRAPH_END: &str = "</div></td></tr>";

/// Append formatted text without an intermediate `String`.
fn push(out: &mut String, args: std::fmt::Arguments<'_>) {
    if std::fmt::Write::write_fmt(out, args).is_err() {
        tracing::error!("formatting into a String failed");
    }
}

/// pug's escaping for `#{...}` and attribute values.
#[must_use]
pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            other => out.push(other),
        }
    }
    out
}

/// `name.replace(/\.|@/g, x => x + '﻿')`: keeps clients from linking
/// names that look like addresses.
fn unlink(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        out.push(c);
        if c == '.' || c == '@' {
            out.push('\u{feff}');
        }
    }
    out
}

/// The locals every template reads.
#[derive(Debug, Clone, Default)]
pub struct Frame {
    /// `applicationUrl`.
    pub application_url: String,
    /// `applicationTitle`.
    pub application_title: String,
    /// `logoUrl`.
    pub logo_url: Option<String>,
    /// `recipientName`.
    pub recipient_name: String,
    /// `recipientEmail`.
    pub recipient_email: String,
}

impl Frame {
    /// The frame for a recipient under the current settings.
    #[must_use]
    pub fn new(settings: &Settings, recipient_email: &str, recipient_name: &str) -> Self {
        let application_url = settings.str("/main/applicationUrl").to_owned();
        let logo_url = if truthy(settings.get("/notifications/agents/email/options/usePublicLogo"))
        {
            Some(String::from(
                "https://raw.githubusercontent.com/selmant/foreseerr/refs/heads/develop/public/logo_full.svg",
            ))
        } else if application_url.is_empty() {
            None
        } else {
            Some(format!("{application_url}/logo_full.svg"))
        };
        Self {
            application_title: settings.str("/main/applicationTitle").to_owned(),
            application_url,
            logo_url,
            recipient_name: recipient_name.to_owned(),
            recipient_email: recipient_email.to_owned(),
        }
    }

    /// The logo or title row and the greeting.
    fn top(&self) -> String {
        let mut out = String::from("<tr><td style=\"text-align: center;\">");
        match (&self.logo_url, self.application_url.is_empty()) {
            (Some(logo), false) => {
                push(&mut out, format_args!("<a href=\"{}\" style=\"margin: 0 1rem;\"><img src=\"{}\" style=\"{LOGO_STYLE}\"></a>",
                    escape(&self.application_url),
                    escape(logo)));
            }
            (Some(logo), true) => {
                push(
                    &mut out,
                    format_args!(
                        "<img src=\"{}\" style=\"margin: 0 1rem; {LOGO_STYLE}\">",
                        escape(logo)
                    ),
                );
            }
            (None, _) => {
                push(&mut out, format_args!("<div style=\"margin: 0 1rem 2.5rem; font-size: 3em; font-weight: 700;\">{}</div>",
                    escape(&self.application_title)));
            }
        }
        out.push_str("</td></tr>");
        if self.recipient_name != self.recipient_email {
            push(
                &mut out,
                format_args!(
                    "{PARAGRAPH}Hi, {}!{PARAGRAPH_END}",
                    escape(&unlink(&self.recipient_name))
                ),
            );
        }
        out
    }

    fn page(&self, rows: &str) -> String {
        format!("{HEAD}{WRAP_OPEN}{}{rows}{WRAP_CLOSE}", self.top())
    }

    fn button(href: &str, label: &str, margin: &str) -> String {
        format!(
            "<tr><td><a href=\"{}\" style=\"display: block; margin: {margin}; text-decoration: none; font-size: 1.0em; line-height: 2.25em;\"><span style=\"{BUTTON}\">{}</span></a></td></tr>",
            escape(href),
            escape(label)
        )
    }
}

/// A rendered email: subject and HTML.
#[derive(Debug, Clone)]
pub struct Rendered {
    /// The subject line.
    pub subject: String,
    /// The HTML body.
    pub html: String,
}

/// `test-email`.
#[must_use]
pub fn test_email(frame: &Frame, body: &str) -> Rendered {
    let mut rows = format!("{PARAGRAPH}{}{PARAGRAPH_END}", escape(body));
    if !frame.application_url.is_empty() {
        rows.push_str(&Frame::button(
            &frame.application_url,
            &format!("Open {}", frame.application_title),
            "1.5rem 3rem 0",
        ));
    }
    Rendered {
        subject: format!("Test Notification [{}]", frame.application_title),
        html: frame.page(&rows),
    }
}

/// The locals of `media-request`.
#[derive(Debug, Clone, Default)]
pub struct MediaRequestMail {
    /// `event`.
    pub event: Option<String>,
    /// `body`.
    pub body: String,
    /// `mediaName`.
    pub media_name: String,
    /// `mediaExtra`.
    pub extra: Vec<(String, String)>,
    /// `imageUrl`.
    pub image_url: Option<String>,
    /// `timestamp`.
    pub timestamp: String,
    /// `requestedBy`.
    pub requested_by: String,
    /// `actionUrl`.
    pub action_url: Option<String>,
}

/// `media-request`.
#[must_use]
pub fn media_request(frame: &Frame, m: &MediaRequestMail) -> Rendered {
    let image = m.image_url.as_deref().unwrap_or("undefined");
    let href = m
        .action_url
        .as_deref()
        .map(|u| format!(" href=\"{}\"", escape(u)))
        .unwrap_or_default();
    let mut rows = format!("{PARAGRAPH}{}{PARAGRAPH_END}", escape(&m.body));
    push(&mut rows, format_args!("<tr><td><div style=\"box-sizing: border-box; margin: 1.5rem 0 0; width: 100%; color: #fff; border-radius: .75rem; padding: 1rem; border: 1px solid rgb(100,100,100); background: linear-gradient(135deg, rgba(17,24,39,0.47) 0%, rgb(17,24,39) 75%), url({}) center 25%/cover\"><table style=\"color: #fff; width: 100%;\"><tr><td style=\"vertical-align: top;\"><a{href} style=\"display: block; max-width: 20rem; color: #fff; font-weight: 700; text-decoration: none; margin: 0 1rem 0.25rem 0; font-size: 1.3em; line-height: 1.25em; margin-bottom: 5px;\" class=\"title\">{}</a><div style=\"overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #d1d5db; font-size: .975em; line-height: 1.45em; padding-top: .25rem; padding-bottom: .25rem;\"><span style=\"display: block;\"><b style=\"color: #9ca3af; font-weight: 700;\">Requested By&nbsp;</b>{}</span>",
        escape(image),
        escape(&m.media_name),
        escape(&unlink(&m.requested_by))));
    for (name, value) in &m.extra {
        push(&mut rows, format_args!("<span style=\"display: block;\"><b style=\"color: #9ca3af; font-weight: 700;\">{}&nbsp;</b>{}</span>",
            escape(name),
            escape(value)));
    }
    rows.push_str("</div></td>");
    if let Some(image) = &m.image_url {
        push(&mut rows, format_args!("<td rowspan=\"2\" style=\"width: 7rem;\"><a style=\"display: block; width: 7rem; overflow: hidden; border-radius: .375rem;\"{href}><div style=\"overflow: hidden; box-sizing: border-box; margin: 0px;\"><img alt=\"\" src=\"{}\" style=\"box-sizing: border-box; padding: 0px; border: none; margin: auto; display: block; min-width: 100%; max-width: 100%; min-height: 100%; max-height: 100%;\"></div></a></td>",
            escape(image)));
    }
    push(&mut rows, format_args!("</tr><tr><td style=\"font-size: .85em; color: #9ca3af; line-height: 1em; vertical-align: bottom; margin-right: 1rem\"><span>{}</span></td></tr></table></div></td></tr>",
        escape(&m.timestamp)));
    if let Some(url) = &m.action_url {
        rows.push_str(&Frame::button(
            url,
            &format!("View Media in {}", frame.application_title),
            "1.5rem 3rem 0",
        ));
    }
    Rendered {
        subject: format!(
            "{} - {} [{}]",
            m.event.as_deref().unwrap_or("undefined"),
            m.media_name,
            frame.application_title
        ),
        html: frame.page(&rows),
    }
}

/// The locals of `media-issue`.
#[derive(Debug, Clone, Default)]
pub struct MediaIssueMail {
    /// `event`.
    pub event: Option<String>,
    /// `body`.
    pub body: String,
    /// `issueDescription`.
    pub issue_description: Option<String>,
    /// `issueComment`.
    pub issue_comment: Option<String>,
    /// `mediaName`.
    pub media_name: String,
    /// `actionUrl`.
    pub action_url: Option<String>,
}

/// `media-issue`.
#[must_use]
pub fn media_issue(frame: &Frame, m: &MediaIssueMail) -> Rendered {
    let mut rows = format!("{PARAGRAPH}{}{PARAGRAPH_END}", escape(&m.body));
    if let Some(comment) = m.issue_comment.as_ref().filter(|c| !c.is_empty()) {
        push(
            &mut rows,
            format_args!("{PARAGRAPH}{}{PARAGRAPH_END}", escape(comment)),
        );
    } else if let Some(description) = m.issue_description.as_ref().filter(|d| !d.is_empty()) {
        push(
            &mut rows,
            format_args!("{PARAGRAPH}{}{PARAGRAPH_END}", escape(description)),
        );
    }
    if let Some(url) = &m.action_url {
        rows.push_str(&Frame::button(
            url,
            &format!("View Issue in {}", frame.application_title),
            "1.5rem 3rem 0",
        ));
    }
    Rendered {
        subject: format!(
            "{} - {} [{}]",
            m.event.as_deref().unwrap_or("undefined"),
            m.media_name,
            frame.application_title
        ),
        html: frame.page(&rows),
    }
}

/// `generatedpassword`.
#[must_use]
pub fn generated_password(frame: &Frame, password: &str) -> Rendered {
    let mut rows = format!(
        "{PARAGRAPH}An account has been created for you at {}.{PARAGRAPH_END}",
        escape(&frame.application_title)
    );
    push(&mut rows, format_args!("<tr><td style=\"text-align: center;\"><div style=\"margin: 1rem 0 0; font-size: 1.25em;\">Your password is:</div><div style=\"font-size: 1.25em; font-weight: 500; line-height: 2.25em;\"><span style=\"padding: 0.5rem; font-weight: 500; border: 1px solid rgb(100,100,100); font-family: monospace;\">{}</span></div></td></tr>",
        escape(password)));
    if !frame.application_url.is_empty() {
        rows.push_str(&Frame::button(
            &frame.application_url,
            &format!("Open {}", frame.application_title),
            "1.5rem 3rem 0",
        ));
    }
    Rendered {
        subject: format!("Account Information [{}]", frame.application_title),
        html: frame.page(&rows),
    }
}

/// `resetpassword`.
#[must_use]
pub fn reset_password(frame: &Frame, link: &str) -> Rendered {
    let mut rows = format!(
        "{PARAGRAPH}A request has been received to change the password for your {} account.{PARAGRAPH_END}",
        escape(&frame.application_title)
    );
    rows.push_str(&Frame::button(link, "Reset Password", "1.5rem 3rem"));
    push(
        &mut rows,
        format_args!("{PARAGRAPH}The above link will expire in 24 hours.{PARAGRAPH_END}"),
    );
    rows.push_str("<tr><td style=\"text-align: center;\"><div style=\"margin: 1rem 1rem 0; font-size: 1.25em;\">If you did not initiate this request, you may safely disregard this message.</div></td></tr>");
    Rendered {
        subject: format!("Password Reset [{}]", frame.application_title),
        html: frame.page(&rows),
    }
}

/// The plain-text part `email-templates` derives from the HTML.
fn text_part(html: &str) -> String {
    let body = html.split_once("</head>").map_or(html, |(_, b)| b);
    let mut out = String::new();
    let mut in_tag = false;
    let mut tag = String::new();
    for c in body.chars() {
        if in_tag {
            if c == '>' {
                in_tag = false;
                let name = tag
                    .trim_start_matches('/')
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if matches!(name.as_str(), "tr" | "div" | "span" | "br") && !out.ends_with('\n') {
                    out.push('\n');
                }
                tag.clear();
            } else {
                tag.push(c);
            }
        } else if c == '<' {
            in_tag = true;
        } else {
            out.push(c);
        }
    }
    out.replace("&nbsp;", " ")
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace('\u{feff}', "")
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// `validator.isEmail(address, { require_tld: false })`, near enough.
#[must_use]
pub fn is_email(address: &str) -> bool {
    Address::from_str(address).is_ok()
}

/// Send a rendered email with the email agent's SMTP settings, encrypted
/// to `pgp_key` when one is given.
///
/// # Errors
///
/// Fails when the settings, addresses or SMTP exchange fail.
pub async fn send(
    settings: &Settings,
    to: &str,
    rendered: &Rendered,
    pgp_key: Option<&str>,
) -> Result<()> {
    let opt = |p: &str| settings.get(&format!("/notifications/agents/email/options/{p}"));
    let text = |p: &str| match opt(p) {
        None | Some(Value::Null) => String::new(),
        other => js_string(other).into_owned(),
    };
    // nodemailer leaves the From header out and sends `MAIL FROM:<>` for an
    // empty `emailFrom`; lettre insists on one, so a stand-in is removed
    // from the formatted message below.
    let sender = text("emailFrom");
    let from_address = if sender.is_empty() {
        None
    } else {
        Some(Address::from_str(&sender).context("emailFrom")?)
    };
    let from = Mailbox::new(
        Some(text("senderName")).filter(|n| !n.is_empty()),
        from_address
            .clone()
            .map_or_else(|| Address::new("from", "invalid"), Ok)
            .context("emailFrom")?,
    );
    let message = Message::builder()
        .from(from)
        .to(Mailbox::new(
            None,
            Address::from_str(to).context("recipient")?,
        ))
        .subject(rendered.subject.clone())
        .multipart(MultiPart::alternative_plain_html(
            text_part(&rendered.html),
            rendered.html.clone(),
        ))
        .context("building the message")?;
    // `getSocket` (used for every host that isn't an IP address) wants a
    // host and a numeric port; with an IP address nodemailer connects
    // itself, a port that is `0`/`NaN` meaning the default.
    let host = text("smtpHost");
    let ip = host.parse::<std::net::IpAddr>().is_ok();
    let raw_port = opt("smtpPort");
    let port_number = if ip {
        let n = crate::jsval::number_of(raw_port);
        if n == 0.0 || n.is_nan() {
            if truthy(opt("secure")) {
                465.0
            } else {
                587.0
            }
        } else {
            n
        }
    } else {
        match raw_port {
            Some(Value::Number(n)) if !host.is_empty() => n.as_f64().unwrap_or(f64::NAN),
            _ => return Err(anyhow!("SMTP host and port are required")),
        }
    };
    let port = crate::jsval::to_i64(port_number)
        .and_then(|p| u16::try_from(p).ok())
        .ok_or_else(|| anyhow!("Port should be >= 0 and < 65536"))?;
    let params = TlsParameters::builder(host.clone())
        .dangerous_accept_invalid_certs(truthy(opt("allowSelfSigned")))
        .build_rustls()
        .context("TLS settings")?;
    let tls = if truthy(opt("secure")) {
        Tls::Wrapper(params)
    } else if truthy(opt("ignoreTls")) {
        Tls::None
    } else if truthy(opt("requireTls")) {
        Tls::Required(params)
    } else {
        Tls::Opportunistic(params)
    };
    let mut builder = AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host)
        .port(port)
        .tls(tls)
        .timeout(Some(Duration::from_secs(60)));
    let (user, pass) = (text("authUser"), text("authPass"));
    if !user.is_empty() && !pass.is_empty() {
        builder = builder.credentials(Credentials::new(user, pass));
    }
    let application_url = settings.str("/main/applicationUrl");
    if let Some(host) = reqwest::Url::parse(application_url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
    {
        builder = builder.hello_name(ClientId::Domain(host));
    }
    let transport = builder.build();
    if from_address.is_none() {
        let envelope = lettre::address::Envelope::new(None, message.envelope().to().to_vec())
            .context("envelope")?;
        let raw = without_from(&message.formatted());
        let raw = match pgp_key.filter(|k| !k.is_empty()) {
            Some(key) => {
                pgp_wrap(&raw, key, &text("pgpPrivateKey"), &text("pgpPassword")).unwrap_or(raw)
            }
            None => raw,
        };
        transport.send_raw(&envelope, &raw).await.context("SMTP")?;
        return Ok(());
    }
    match pgp_key.filter(|k| !k.is_empty()) {
        Some(key) => {
            let raw = message.formatted();
            let wrapped = match pgp_wrap(&raw, key, &text("pgpPrivateKey"), &text("pgpPassword")) {
                Ok(wrapped) => wrapped,
                Err(e) => {
                    tracing::error!(
                        "Something went wrong while encrypting email message with OpenPGP. Sending email without encryption: {e:#}"
                    );
                    raw
                }
            };
            transport
                .send_raw(message.envelope(), &wrapped)
                .await
                .context("SMTP")?;
        }
        None => {
            transport.send(message).await.context("SMTP")?;
        }
    }
    Ok(())
}

/// A formatted message without its `From` header (and its folded lines).
fn without_from(raw: &[u8]) -> Vec<u8> {
    let text = String::from_utf8_lossy(raw);
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let mut kept: Vec<&str> = Vec::new();
    let mut skipping = false;
    for line in head.split("\r\n") {
        if line.starts_with([' ', '\t']) {
            if !skipping {
                kept.push(line);
            }
            continue;
        }
        skipping = line
            .get(..5)
            .is_some_and(|n| n.eq_ignore_ascii_case("from:"));
        if !skipping {
            kept.push(line);
        }
    }
    format!("{}\r\n\r\n{body}", kept.join("\r\n")).into_bytes()
}

/// A `text/plain` single part.
#[must_use]
pub fn plain_part(text: String) -> SinglePart {
    SinglePart::builder()
        .header(ContentType::TEXT_PLAIN)
        .body(text)
}

/// `openpgpEncrypt`: moves the content headers and body into an armored,
/// optionally signed, `OpenPGP` message inside a `multipart/encrypted` body.
fn pgp_wrap(raw: &[u8], public_key: &str, signing_key: &str, password: &str) -> Result<Vec<u8>> {
    use pgp::composed::{
        ArmorOptions, Deserializable, MessageBuilder, SignedPublicKey, SignedSecretKey,
    };
    use pgp::crypto::hash::HashAlgorithm;
    use pgp::crypto::sym::SymmetricKeyAlgorithm;
    use pgp::types::{Password, PublicKeyTrait};

    const DELIMITER: &str = "\r\n\r\n";
    let message = String::from_utf8_lossy(raw).into_owned();
    let mut parts = message.split(DELIMITER);
    let header = parts.next().unwrap_or("");
    let rest: Vec<&str> = parts.collect();
    let mut email_headers: Vec<Vec<&str>> = Vec::new();
    let mut content_headers: Vec<Vec<&str>> = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    let is_content = |h: &[&str]| {
        h.first().is_some_and(|l| {
            let l = l.to_ascii_lowercase();
            l.starts_with("content-type:") || l.starts_with("content-transfer-encoding:")
        })
    };
    for (i, line) in header.split("\r\n").enumerate() {
        if i == 0 || line.starts_with(char::is_whitespace) {
            current.push(line);
        } else {
            let done = std::mem::replace(&mut current, vec![line]);
            if is_content(&done) {
                content_headers.push(done);
            } else {
                email_headers.push(done);
            }
        }
    }
    if !current.is_empty() {
        if is_content(&current) {
            content_headers.push(current);
        } else {
            email_headers.push(current);
        }
    }
    let mut boundary_bytes = [0_u8; 14];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut boundary_bytes)
        .map_err(|_| anyhow!("no randomness for the boundary"))?;
    let boundary = format!(
        "nm_{}",
        boundary_bytes.iter().fold(String::new(), |mut hex, b| {
            push(&mut hex, format_args!("{b:02x}"));
            hex
        })
    );
    let join = |headers: &[Vec<&str>]| {
        headers
            .iter()
            .map(|h| h.join("\r\n"))
            .collect::<Vec<_>>()
            .join("\r\n")
    };
    let email_raw = format!(
        "{}\r\nContent-Type: multipart/encrypted; protocol=\"application/pgp-encrypted\";\r\n boundary=\"{boundary}\"\r\nContent-Description: OpenPGP encrypted message\r\nContent-Transfer-Encoding: 7bit",
        join(&email_headers)
    );
    let inner = format!(
        "{}{DELIMITER}{}",
        join(&content_headers),
        rest.join(DELIMITER)
    );
    let (public, _) =
        SignedPublicKey::from_string(public_key).map_err(|e| anyhow!("public key: {e}"))?;
    let secret = if signing_key.is_empty() || password.is_empty() {
        None
    } else {
        Some(
            SignedSecretKey::from_string(signing_key)
                .map_err(|e| anyhow!("signing key: {e}"))?
                .0,
        )
    };
    let mut builder = MessageBuilder::from_bytes("", inner.into_bytes())
        .seipd_v1(rand::thread_rng(), SymmetricKeyAlgorithm::AES256);
    let subkey = public
        .public_subkeys
        .iter()
        .find(|k| PublicKeyTrait::is_encryption_key(*k));
    match subkey {
        Some(subkey) => builder.encrypt_to_key(rand::thread_rng(), subkey),
        None => builder.encrypt_to_key(rand::thread_rng(), &public.primary_key),
    }
    .map_err(|e| anyhow!("encrypting: {e}"))?;
    if let Some(secret) = &secret {
        builder.sign(
            &secret.primary_key,
            Password::from(password),
            HashAlgorithm::Sha256,
        );
    }
    let armored = builder
        .to_armored_string(rand::thread_rng(), ArmorOptions::default())
        .map_err(|e| anyhow!("armoring: {e}"))?;
    let body = format!(
        "--{boundary}\r\nContent-Type: application/pgp-encrypted\r\nContent-Transfer-Encoding: 7bit\r\n\r\nVersion: 1\r\n\r\n--{boundary}\r\nContent-Type: application/octet-stream; name=encrypted.asc\r\nContent-Disposition: inline; filename=encrypted.asc\r\nContent-Transfer-Encoding: 7bit\r\n\r\n{armored}\r\n--{boundary}--\r\n"
    );
    Ok(format!("{email_raw}{DELIMITER}{body}").into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_the_from_header() {
        let raw = b"From: X\r\n <x@y>\r\nTo: a@b\r\n\r\nbody\r\nFrom: kept";
        assert_eq!(
            without_from(raw),
            b"To: a@b\r\n\r\nbody\r\nFrom: kept".to_vec(),
            "header only"
        );
    }

    #[test]
    fn renders_and_escapes() {
        let frame = Frame {
            application_url: String::new(),
            application_title: String::from("Foreseerr"),
            logo_url: None,
            recipient_name: String::from("ann.b"),
            recipient_email: String::from("a@b.c"),
        };
        let r = test_email(&frame, "Hello <world>");
        assert_eq!(r.subject, "Test Notification [Foreseerr]", "subject");
        assert!(r.html.contains("Hello &lt;world&gt;"), "escaped body");
        assert!(r.html.contains("Hi, ann.\u{feff}b!"), "unlinked name");
        assert!(text_part(&r.html).contains("Hello <world>"), "text part");
        assert!(is_email("a@b"), "no tld needed");
        assert!(!is_email("nope"), "not an address");
    }
}
