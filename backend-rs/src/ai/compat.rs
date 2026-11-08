//! Any OpenAI-compatible endpoint (`OpenAI` with an API key, `Ollama`, LM
//! Studio, `vLLM`, `OpenRouter`, ...) through Chat Completions, which nearly
//! all of them implement.

use std::time::Duration;

use serde_json::{json, Value};

use super::{clip, AiError, Prompt};
use crate::vault::Secret;

const MODELS_TIMEOUT: Duration = Duration::from_secs(20);
const COMPLETE_TIMEOUT: Duration = Duration::from_secs(150);

/// Check a base URL: `http(s)`, no credentials, query or fragment (keys
/// go in the API key field, which is encrypted; the URL is not).
///
/// # Errors
///
/// Explains what's wrong with it.
pub fn normalize_base_url(input: &str) -> Result<String, AiError> {
    let trimmed = input.trim().trim_end_matches('/');
    let url = reqwest::Url::parse(trimmed)
        .map_err(|_| AiError::input("Enter a full URL, like https://api.openai.com/v1."))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AiError::input(
            "The URL must start with http:// or https://.",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AiError::input(
            "Don't put credentials in the URL; use the API key field, which is stored encrypted.",
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(AiError::input(
            "The URL can't have a query string or fragment.",
        ));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(AiError::input("The URL has no host."));
    }
    Ok(trimmed.to_owned())
}

/// A friendly name for the provider behind a base URL, for users who
/// don't need the address itself.
#[must_use]
pub fn provider_label(base_url: &str) -> &'static str {
    let host = reqwest::Url::parse(base_url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
        .unwrap_or_default();
    let port = reqwest::Url::parse(base_url).ok().and_then(|u| u.port());
    if host == "api.openai.com" {
        "OpenAI"
    } else if host.ends_with("openrouter.ai") {
        "OpenRouter"
    } else if host.contains("ollama") || port == Some(11434) {
        "Ollama"
    } else if port == Some(1234) || host.contains("lmstudio") {
        "LM Studio"
    } else {
        "Custom endpoint"
    }
}

/// Where a base URL sends credentials (scheme, host and port), to notice
/// when an endpoint moves elsewhere. Dropping to plain HTTP counts as a
/// move, since the key would then travel unencrypted.
#[must_use]
pub fn host_of(base_url: &str) -> Option<String> {
    reqwest::Url::parse(base_url).ok().map(|u| {
        format!(
            "{}://{}:{}",
            u.scheme(),
            u.host_str().unwrap_or(""),
            u.port_or_known_default().unwrap_or(0)
        )
    })
}

fn request(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: String,
    key: Option<&Secret>,
) -> reqwest::RequestBuilder {
    let req = client.request(method, url);
    match key.filter(|k| !k.is_empty()) {
        Some(k) => req.bearer_auth(k.expose()),
        None => req,
    }
}

fn failure(status: u16, body: &Value) -> AiError {
    let message = body
        .pointer("/error/message")
        .and_then(Value::as_str)
        .or_else(|| body.get("error").and_then(Value::as_str))
        .or_else(|| body.get("message").and_then(Value::as_str))
        .or_else(|| body.get("detail").and_then(Value::as_str))
        .unwrap_or("");
    match status {
        401 | 403 => AiError::input("The endpoint refused the API key."),
        404 => {
            AiError::input("The endpoint wasn't found. Check the base URL; it usually ends in /v1.")
        }
        429 => AiError::network("The endpoint is rate-limiting requests. Try again shortly."),
        _ if message.is_empty() => {
            AiError::upstream(format!("The endpoint returned an error ({status})."))
        }
        _ => AiError::upstream(format!("The endpoint said: {}", clip(message, 240))),
    }
}

/// The endpoint's models, as `(id, id)`, sorted.
///
/// # Errors
///
/// Fails when the endpoint can't be reached or refuses.
pub async fn models(
    client: &reqwest::Client,
    base_url: &str,
    key: Option<&Secret>,
) -> Result<Vec<(String, String)>, AiError> {
    let res = request(
        client,
        reqwest::Method::GET,
        format!("{base_url}/models"),
        key,
    )
    .timeout(MODELS_TIMEOUT)
    .send()
    .await
    .map_err(|_| AiError::network("The endpoint couldn't be reached."))?;
    let status = res.status().as_u16();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        return Err(failure(status, &body));
    }
    let mut ids: Vec<String> = body
        .get("data")
        .or_else(|| body.get("models"))
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|m| {
                    m.get("id")
                        .or_else(|| m.get("name"))
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    ids.dedup();
    Ok(ids.into_iter().map(|id| (id.clone(), id)).collect())
}

/// How strictly to ask for JSON; endpoints that reject one try the next.
#[derive(Debug, Clone, Copy)]
enum JsonMode {
    Schema,
    Object,
    Prompt,
}

/// Run `prompt` and return the model's text.
///
/// # Errors
///
/// Fails when the endpoint can't be reached or returns an error.
pub async fn complete(
    client: &reqwest::Client,
    base_url: &str,
    key: Option<&Secret>,
    model: &str,
    prompt: &Prompt<'_>,
) -> Result<String, AiError> {
    let json_modes: &[JsonMode] = if prompt.schema.is_some() {
        &[JsonMode::Schema, JsonMode::Object, JsonMode::Prompt]
    } else {
        &[JsonMode::Prompt]
    };
    let mut last = AiError::upstream("The endpoint returned nothing.");
    // When the endpoint can't enforce the schema, the model still gets it
    // in writing. Every schema-bearing answer is checked locally too.
    let described = prompt.schema.map(|(_, schema)| {
        format!(
            "{}\n\nReply with only a JSON object (no prose, no code fence) that matches this JSON Schema:\n{schema}",
            prompt.instructions
        )
    });
    for mode in json_modes {
        let instructions = match (mode, described.as_deref()) {
            (JsonMode::Object | JsonMode::Prompt, Some(text)) => text,
            (JsonMode::Schema | JsonMode::Object | JsonMode::Prompt, _) => prompt.instructions,
        };
        let mut body = json!({
            "model": model,
            "messages": [
                {"role": "system", "content": instructions},
                {"role": "user", "content": prompt.input},
            ],
            "stream": false,
        });
        if let Some(obj) = body.as_object_mut() {
            match (mode, prompt.schema) {
                (JsonMode::Schema, Some((name, schema))) => {
                    obj.insert(
                        String::from("response_format"),
                        json!({"type": "json_schema", "json_schema": {"name": name, "schema": schema, "strict": true}}),
                    );
                }
                (JsonMode::Object, Some(_)) => {
                    obj.insert(
                        String::from("response_format"),
                        json!({"type": "json_object"}),
                    );
                }
                (JsonMode::Schema | JsonMode::Object | JsonMode::Prompt, _) => {}
            }
        }
        let res = request(
            client,
            reqwest::Method::POST,
            format!("{base_url}/chat/completions"),
            key,
        )
        .timeout(COMPLETE_TIMEOUT)
        .json(&body)
        .send()
        .await
        .map_err(|_| AiError::network("The endpoint couldn't be reached."))?;
        let status = res.status().as_u16();
        let body: Value = res.json().await.unwrap_or(Value::Null);
        if (200..300).contains(&status) {
            let text = body
                .pointer("/choices/0/message/content")
                .and_then(Value::as_str)
                .ok_or_else(|| AiError::upstream("The endpoint's answer had no text."))?;
            validate_answer(text, prompt.schema.map(|(_, schema)| schema))?;
            let used = |key: &str| {
                body.pointer(&format!("/usage/{key}"))
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
            };
            super::note_tokens(used("prompt_tokens"), used("completion_tokens"));
            return Ok(text.to_owned());
        }
        last = failure(status, &body);
        // Only a rejected request shape is worth retrying in a looser mode.
        if !matches!(status, 400 | 422) {
            break;
        }
    }
    Err(last)
}

fn validate_answer(text: &str, schema: Option<&Value>) -> Result<(), AiError> {
    let Some(schema) = schema else { return Ok(()) };
    let valid = serde_json::from_str::<Value>(text)
        .is_ok_and(|value| crate::openapi::matches_schema(schema, &value));
    if valid {
        Ok(())
    } else {
        Err(AiError::upstream(
            "The endpoint's answer didn't match the requested JSON schema.",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_generated_json_without_coercion() {
        let schema = json!({"type":"object","additionalProperties":false,"required":["card"],"properties":{"card":{"type":"string"}}});
        assert!(validate_answer(r#"{"card":"Quiet sci-fi"}"#, Some(&schema)).is_ok());
        for invalid in [
            "plain text",
            "{}",
            r#"{"card":7}"#,
            r#"{"card":"yes","extra":true}"#,
        ] {
            assert!(
                validate_answer(invalid, Some(&schema)).is_err(),
                "{invalid}"
            );
        }
        assert!(validate_answer("plain text", None).is_ok());
    }

    #[test]
    fn scheme_changes_move_the_credential_destination() {
        assert_ne!(
            host_of("https://example.test:8443/v1"),
            host_of("http://example.test:8443/v1")
        );
        assert_eq!(
            host_of("https://example.test/v1"),
            host_of("https://example.test:443/other")
        );
    }

    #[test]
    fn normalizes_base_urls() {
        assert_eq!(
            normalize_base_url(" https://api.openai.com/v1/ ")
                .ok()
                .as_deref(),
            Some("https://api.openai.com/v1"),
            "trailing slash"
        );
        assert!(
            normalize_base_url("http://ollama:11434/v1").is_ok(),
            "plain http"
        );
        assert!(normalize_base_url("ftp://x/v1").is_err(), "scheme");
        assert!(
            normalize_base_url("https://u:p@x/v1").is_err(),
            "credentials"
        );
        assert!(normalize_base_url("https://x/v1?key=1").is_err(), "query");
        assert!(normalize_base_url("api.openai.com").is_err(), "not a URL");
    }

    #[test]
    fn explains_failures() {
        assert!(
            failure(401, &Value::Null).message.contains("API key"),
            "auth"
        );
        assert!(
            failure(404, &Value::Null).message.contains("/v1"),
            "url hint"
        );
        let said = failure(500, &json!({"error": {"message": "model crashed"}}));
        assert!(said.message.contains("model crashed"), "upstream message");
    }
}

#[cfg(test)]
mod completion_review_tests {
    use super::*;

    #[tokio::test]
    async fn rejects_an_invalid_plan_through_the_fallback_completion_path() -> anyhow::Result<()> {
        if rustls::crypto::ring::default_provider()
            .install_default()
            .is_err()
        {
            tracing::trace!("a provider was installed");
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}", listener.local_addr()?);
        let app = axum::Router::new().route(
            "/chat/completions",
            axum::routing::post(|axum::Json(body): axum::Json<Value>| async move {
                if body
                    .pointer("/response_format/type")
                    .and_then(Value::as_str)
                    == Some("json_schema")
                {
                    return (
                        axum::http::StatusCode::BAD_REQUEST,
                        axum::Json(json!({"error": {"message": "unsupported response_format"}})),
                    );
                }
                let plan = json!({"summary":"test", "mediaTypes":["movie"], "anime":false,
                "titleIdeas":[{"title":"Bad idea", "year":null, "mediaType":"book"}],
                "genres":[], "keywords":[], "yearFrom":null, "yearTo":null, "webQueries":[]});
                (
                    axum::http::StatusCode::OK,
                    axum::Json(json!({"choices":[{"message":{"content":plan.to_string()}}]})),
                )
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await });
        let schema = crate::ai::recs::prompts::plan_schema();
        let result = complete(
            &reqwest::Client::new(),
            &url,
            None,
            "test",
            &Prompt {
                instructions: "plan",
                input: "test",
                schema: Some(("plan", &schema)),
            },
        )
        .await;
        server.abort();
        assert!(
            result.is_err(),
            "invalid enum must be rejected through complete, including fallback modes"
        );
        Ok(())
    }
}
