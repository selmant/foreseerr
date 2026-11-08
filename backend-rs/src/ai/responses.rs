//! The Responses API as `ChatGPT` plan usage allows it: `store: false`,
//! `stream: true`, no sampling or output-length fields, read through the
//! stream's terminal event.

use std::time::Duration;

use serde_json::{json, Value};

use super::chatgpt::API_BASE;
use super::{AiError, Prompt};
use crate::vault::Secret;

const TIMEOUT: Duration = Duration::from_secs(150);

/// Run `prompt` and return the model's text (JSON when a schema is given).
///
/// # Errors
///
/// Fails on transport errors, `OpenAI` errors (usage limits included), or a
/// stream that ends without `response.completed`.
pub async fn complete(
    client: &reqwest::Client,
    token: &Secret,
    model: &str,
    prompt: &Prompt<'_>,
) -> Result<String, AiError> {
    let mut body = json!({
        "model": model,
        "instructions": prompt.instructions,
        "input": [{"role": "user", "content": prompt.input}],
        "store": false,
        "stream": true,
    });
    if let (Some((name, schema)), Some(obj)) = (prompt.schema, body.as_object_mut()) {
        obj.insert(
            String::from("text"),
            json!({"format": {"type": "json_schema", "name": name, "schema": schema, "strict": true}}),
        );
    }
    let mut res = client
        .post(format!("{API_BASE}/responses"))
        .bearer_auth(token.expose())
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .timeout(TIMEOUT)
        .json(&body)
        .send()
        .await
        .map_err(|_| AiError::network("OpenAI couldn't be reached."))?;
    let status = res.status().as_u16();
    if !res.status().is_success() {
        let body: Value = res.json().await.unwrap_or(Value::Null);
        return Err(error_of(status, &body));
    }
    let mut reader = Sse::default();
    loop {
        let chunk = res
            .chunk()
            .await
            .map_err(|_| AiError::network("The connection to OpenAI dropped mid-answer."))?;
        let Some(chunk) = chunk else {
            break;
        };
        reader.push(&String::from_utf8_lossy(&chunk));
        while let Some(event) = reader.next_event() {
            if let Some(done) = reader.handle(&event)? {
                return Ok(done);
            }
        }
    }
    Err(AiError::network(
        "OpenAI's answer ended before it was complete. Try again.",
    ))
}

/// A server-sent-events reader that keeps the answer's text.
#[derive(Debug, Default)]
struct Sse {
    buffer: String,
    text: String,
    final_text: Option<String>,
}

impl Sse {
    fn push(&mut self, chunk: &str) {
        self.buffer.push_str(&chunk.replace("\r\n", "\n"));
    }

    /// The `data:` payload of the next complete event, if one is buffered.
    fn next_event(&mut self) -> Option<Value> {
        loop {
            let end = self.buffer.find("\n\n")?;
            let block: String = self.buffer.drain(..end.saturating_add(2)).collect();
            let data: Vec<&str> = block
                .lines()
                .filter_map(|l| l.strip_prefix("data:"))
                .map(str::trim_start)
                .collect();
            if data.is_empty() {
                continue;
            }
            let joined = data.join("\n");
            if joined == "[DONE]" {
                continue;
            }
            if let Ok(value) = serde_json::from_str(&joined) {
                return Some(value);
            }
        }
    }

    /// Apply one event; `Some(text)` once the response completed.
    fn handle(&mut self, event: &Value) -> Result<Option<String>, AiError> {
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "response.output_text.delta" => {
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    self.text.push_str(delta);
                }
                Ok(None)
            }
            "response.output_text.done" => {
                if let Some(text) = event.get("text").and_then(Value::as_str) {
                    self.final_text = Some(text.to_owned());
                }
                Ok(None)
            }
            "response.completed" => Ok(Some(
                self.final_text
                    .take()
                    .unwrap_or_else(|| std::mem::take(&mut self.text)),
            )),
            "response.failed" => {
                let error = event
                    .pointer("/response/error")
                    .cloned()
                    .unwrap_or(Value::Null);
                Err(error_of(0, &json!({"error": error})))
            }
            "response.incomplete" => {
                let reason = event
                    .pointer("/response/incomplete_details/reason")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                Err(AiError::upstream(format!(
                    "OpenAI stopped before finishing ({reason})."
                )))
            }
            "error" => Err(error_of(0, &json!({"error": event}))),
            _ => Ok(None),
        }
    }
}

/// An `OpenAI` error response as an [`AiError`], with the recoveries
/// `OpenAI` documents for `ChatGPT` plan usage.
#[must_use]
pub fn error_of(status: u16, body: &Value) -> AiError {
    let error = body.get("error");
    let code = error
        .and_then(|e| e.get("code"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let message = error
        .and_then(|e| e.get("message"))
        .and_then(Value::as_str)
        .or_else(|| body.get("detail").and_then(Value::as_str))
        .unwrap_or("");
    match code {
        "subscription_sharing_usage_limit_exceeded" => AiError::usage_limit(),
        "subscription_sharing_user_not_eligible"
        | "chatpass_v2_scope_not_authorized"
        | "chatpass_v2_invalid_authorization_context" => {
            AiError::not_eligible("ChatGPT plan use isn't available for this account or workspace.")
        }
        "subscription_sharing_usage_unavailable" | "subscription_sharing_user_unavailable" => {
            AiError::network("ChatGPT couldn't check your plan right now. Try again shortly.")
        }
        "subscription_sharing_invalid_user" => {
            AiError::reauth("ChatGPT didn't accept this sign-in. Sign in again.")
        }
        "subscription_sharing_unsupported_capability" => {
            let param = error
                .and_then(|e| e.get("param"))
                .and_then(Value::as_str)
                .unwrap_or("a request field");
            AiError::upstream(format!(
                "ChatGPT plan use doesn't support {param} with this model. Pick another model."
            ))
        }
        "model_not_found" => {
            AiError::input("This model isn't available to the account. Pick another model.")
        }
        _ => match status {
            401 => AiError::reauth("OpenAI didn't accept the sign-in. Sign in again."),
            403 => AiError::not_eligible("OpenAI refused the request for this account or region."),
            429 => AiError::network("OpenAI is rate-limiting requests. Try again shortly."),
            503 => AiError::network("OpenAI is temporarily unavailable. Try again shortly."),
            _ if message.is_empty() => {
                AiError::upstream(format!("OpenAI returned an error ({status})."))
            }
            _ => AiError::upstream(format!("OpenAI: {}", super::clip(message, 240))),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(stream: &str) -> Result<Option<String>, AiError> {
        let mut sse = Sse::default();
        sse.push(stream);
        while let Some(event) = sse.next_event() {
            if let Some(done) = sse.handle(&event)? {
                return Ok(Some(done));
            }
        }
        Ok(None)
    }

    #[test]
    fn collects_text_until_completed() {
        let stream = "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"Hel\"}\n\n\
                      data: {\"type\":\"response.output_text.delta\",\"delta\":\"lo\"}\r\n\r\n\
                      data: {\"type\":\"response.completed\",\"response\":{}}\n\n";
        assert_eq!(
            run(stream).ok().flatten().as_deref(),
            Some("Hello"),
            "joined deltas"
        );
    }

    #[test]
    fn prefers_the_done_text() {
        let stream = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"x\"}\n\n\
                      data: {\"type\":\"response.output_text.done\",\"text\":\"{\\\"a\\\":1}\"}\n\n\
                      data: {\"type\":\"response.completed\"}\n\n";
        assert_eq!(
            run(stream).ok().flatten().as_deref(),
            Some("{\"a\":1}"),
            "final text"
        );
    }

    #[test]
    fn maps_usage_limits() {
        let stream = "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"subscription_sharing_usage_limit_exceeded\"}}}\n\n";
        let err = run(stream).err();
        assert_eq!(
            err.map(|e| e.kind),
            Some(super::super::ErrorKind::UsageLimit),
            "usage limit"
        );
    }

    #[test]
    fn waits_for_whole_events() {
        let mut sse = Sse::default();
        sse.push("data: {\"type\":\"response.output_text.delta\",");
        assert!(sse.next_event().is_none(), "partial");
        sse.push("\"delta\":\"a\"}\n\n");
        assert!(sse.next_event().is_some(), "complete");
    }
}
