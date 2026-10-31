//! Radarr and Sonarr calls that keep what an axios failure carries: the
//! status and body of an error answer, or the message of a request that
//! got no answer. `routeError` and the Arr clients' wrappers build their
//! messages from exactly these.

use std::time::Duration;

use axum::http::Method;
use serde_json::Value;

use crate::media::js_string;
use crate::servarr::build_url;
use crate::sonarrv5::{self, ApiVersion};
use crate::tmdb::{axios_encode, js_numbers};

/// `QUEUE_PAGE_SIZE` and `QUEUE_MAX_PAGES` of `ServarrBase.getQueue`.
const QUEUE_PAGE_SIZE: usize = 250;
const QUEUE_MAX_PAGES: i64 = 40;
/// `INTERACTIVE_RELEASE_SEARCH_TIMEOUT_MS`.
const RELEASE_SEARCH_TIMEOUT_MS: u64 = 120_000;

/// Why an Arr call failed, as the axios error describes it.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum ArrError {
    /// The server answered with an error status; `data` is the parsed body
    /// (a string when it isn't JSON).
    Http { status: u16, data: Value },
    /// No answer at all; the axios message.
    Transport(String),
    /// A wrapper threw a plain `Error` with this message (no status, no
    /// response), e.g. `[Sonarr] Failed to retrieve queue: ...`; the flag
    /// says whether the message carries a transport failure's text.
    Plain(String, bool),
}

impl ArrError {
    /// `e.message` of the error.
    pub(super) fn message(&self) -> String {
        match self {
            Self::Http { status, .. } => format!("Request failed with status code {status}"),
            Self::Transport(m) | Self::Plain(m, _) => m.clone(),
        }
    }

    /// The error rethrown as `new Error(`${prefix}${e.message}`)`.
    pub(super) fn wrapped(&self, prefix: &str) -> Self {
        Self::Plain(format!("{prefix}{}", self.message()), self.is_transport())
    }

    /// Whether nothing answered, so the message holds the transport
    /// failure's text.
    pub(super) const fn is_transport(&self) -> bool {
        matches!(self, Self::Transport(_) | Self::Plain(_, true))
    }

    /// `routeError(error, fallback)` of `mediaServarr.ts`: status and
    /// message of the error answer.
    pub(super) fn route_error(&self, fallback: u16) -> (u16, Value) {
        match self {
            Self::Http { status, data } => {
                let message = match data {
                    Value::String(s) if !s.is_empty() => Value::from(s.as_str()),
                    Value::Object(o) => o
                        .get("message")
                        .filter(|m| crate::settings::public::truthy(Some(m)))
                        .cloned()
                        .unwrap_or_else(|| Value::from(self.message())),
                    Value::Null
                    | Value::Bool(_)
                    | Value::Number(_)
                    | Value::String(_)
                    | Value::Array(_) => Value::from(self.message()),
                };
                (*status, message)
            }
            Self::Transport(m) | Self::Plain(m, _) => (fallback, Value::from(m.as_str())),
        }
    }
}

/// One configured Radarr or Sonarr server and the client to reach it.
#[derive(Debug, Clone, Copy)]
pub(super) struct ArrServer<'a> {
    pub(super) client: &'a reqwest::Client,
    pub(super) server: &'a Value,
    /// `network.apiRequestTimeout` in milliseconds; 0 means none.
    pub(super) timeout_ms: u64,
    /// `Radarr` or `Sonarr`, for the wrappers' messages.
    pub(super) api_name: &'static str,
}

impl ArrServer<'_> {
    /// `interactiveReleaseSearchTimeout()`.
    pub(super) fn release_search_timeout(&self) -> u64 {
        if self.timeout_ms == 0 {
            0
        } else {
            self.timeout_ms.max(RELEASE_SEARCH_TIMEOUT_MS)
        }
    }

    /// The API this server is talked to through: v5 for a Sonarr that
    /// offers it, v3 otherwise.
    async fn api(&self) -> ApiVersion {
        if self.api_name != "Sonarr" {
            return ApiVersion::V3;
        }
        let api_key = match self.server.get("apiKey") {
            None | Some(Value::Null) => None,
            other => Some(js_string(other)),
        };
        let timeout = (self.timeout_ms > 0).then(|| Duration::from_millis(self.timeout_ms));
        sonarrv5::api_version(
            self.client,
            &build_url(self.server, ""),
            api_key.as_deref(),
            timeout,
        )
        .await
    }

    /// `this.axios.<method>(path, { params, timeout })` against `/api/v3`,
    /// translated to `/api/v5` for a Sonarr that offers it.
    pub(super) async fn request(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<&Value>,
        timeout_ms: u64,
    ) -> Result<Value, ArrError> {
        let api = self.api().await;
        let query: Vec<(String, String)> = query
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect();
        let (query, body) = match api {
            ApiVersion::V3 => (query, body.cloned()),
            ApiVersion::V5 => sonarrv5::to_v5_request(method.as_str(), path, query, body.cloned()),
        };
        let mut url = build_url(self.server, &format!("{}{path}", api.prefix()));
        let mut params: Vec<(String, String)> = Vec::new();
        match self.server.get("apiKey") {
            None | Some(Value::Null) => {}
            other => params.push((String::from("apikey"), js_string(other).into_owned())),
        }
        params.extend(query);
        for (i, (k, v)) in params.iter().enumerate() {
            url.push(if i == 0 && !url.contains('?') {
                '?'
            } else {
                '&'
            });
            url.push_str(&axios_encode(k));
            url.push('=');
            url.push_str(&axios_encode(v));
        }
        let mut request = self
            .client
            .request(method.clone(), &url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CONTENT_TYPE, "application/json");
        if timeout_ms > 0 {
            request = request.timeout(Duration::from_millis(timeout_ms));
        }
        if let Some(body) = &body {
            request = request.body(body.to_string());
        }
        let response = request
            .send()
            .await
            .map_err(|e| ArrError::Transport(transport_message(&e)))?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|e| ArrError::Transport(transport_message(&e)))?;
        let data = axios_data(&bytes);
        if status.is_success() {
            Ok(match api {
                ApiVersion::V3 => data,
                ApiVersion::V5 => sonarrv5::from_v5_response(method.as_str(), path, data),
            })
        } else {
            Err(ArrError::Http {
                status: status.as_u16(),
                data,
            })
        }
    }

    /// A GET with the default timeout.
    pub(super) async fn get(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<Value, ArrError> {
        self.request(Method::GET, path, query, None, self.timeout_ms)
            .await
    }

    /// `ServarrBase.getQueue`: every page of `/queue` with episodes, as one
    /// list; failures wrapped as `[<api>] Failed to retrieve queue: ...`.
    pub(super) async fn queue(&self) -> Result<Vec<Value>, ArrError> {
        let mut records: Vec<Value> = Vec::new();
        for page in 1..=QUEUE_MAX_PAGES {
            let data = self
                .get(
                    "/queue",
                    &[
                        ("page", page.to_string()),
                        ("pageSize", QUEUE_PAGE_SIZE.to_string()),
                        ("includeEpisode", String::from("true")),
                    ],
                )
                .await
                .map_err(|e| {
                    e.wrapped(&format!("[{}] Failed to retrieve queue: ", self.api_name))
                })?;
            let page_records = match data.get("records") {
                None | Some(Value::Null) => Vec::new(),
                Some(Value::Array(items)) => items.clone(),
                Some(_) => {
                    return Err(ArrError::Plain(
                        format!(
                            "[{}] Failed to retrieve queue: records is not a list",
                            self.api_name
                        ),
                        false,
                    ))
                }
            };
            let count = page_records.len();
            records.extend(page_records);
            let total = match data.get("totalRecords") {
                None | Some(Value::Null) => None,
                Some(v) => v.as_f64(),
            };
            let reached = total.is_none_or(|t| usize_as_f64(records.len()) >= t);
            if reached || count < QUEUE_PAGE_SIZE {
                break;
            }
        }
        Ok(records)
    }

    /// The queue entries of one series with their episodes, from
    /// `GET /queue/details?seriesId=` (downloads and pending releases, as
    /// `/queue` lists them) instead of every page of the whole queue;
    /// failures wrapped as `queue`'s are.
    pub(super) async fn series_queue(&self, series_id: i64) -> Result<Vec<Value>, ArrError> {
        let failed = |why: &str| format!("[{}] Failed to retrieve queue: {why}", self.api_name);
        let data = self
            .get(
                "/queue/details",
                &[
                    ("seriesId", series_id.to_string()),
                    ("includeEpisode", String::from("true")),
                ],
            )
            .await
            .map_err(|e| e.wrapped(&failed("")))?;
        match data {
            Value::Array(items) => Ok(items),
            Value::Null
            | Value::Bool(_)
            | Value::Number(_)
            | Value::String(_)
            | Value::Object(_) => Err(ArrError::Plain(failed("the answer is not a list"), false)),
        }
    }

    /// Sonarr's `getEpisodes`: failures become `Failed to get episodes`.
    pub(super) async fn episodes(&self, series_id: i64) -> Result<Vec<Value>, ArrError> {
        let data = self
            .get("/episode", &[("seriesId", series_id.to_string())])
            .await
            .map_err(|_| ArrError::Plain(String::from("Failed to get episodes"), false))?;
        Ok(as_list(data))
    }

    /// `runCommand(name, options)`: failures wrapped as
    /// `[<api>] Failed to run command: ...`.
    pub(super) async fn command(&self, body: &Value) -> Result<Value, ArrError> {
        self.request(Method::POST, "/command", &[], Some(body), self.timeout_ms)
            .await
            .map_err(|e| e.wrapped(&format!("[{}] Failed to run command: ", self.api_name)))
    }
}

/// A list answer; anything else counts as empty.
pub(super) fn as_list(value: Value) -> Vec<Value> {
    match value {
        Value::Array(items) => items,
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) | Value::Object(_) => {
            Vec::new()
        }
    }
}

fn usize_as_f64(n: usize) -> f64 {
    u32::try_from(n).map_or(f64::MAX, f64::from)
}

/// axios's `transformResponse`: JSON when it parses, otherwise the text.
fn axios_data(bytes: &[u8]) -> Value {
    serde_json::from_slice::<Value>(bytes).map_or_else(
        |_| Value::String(String::from_utf8_lossy(bytes).into_owned()),
        js_numbers,
    )
}

/// The message for a request that got no answer.
pub(super) fn transport_message(e: &reqwest::Error) -> String {
    crate::outbound::describe(e)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn route_errors() {
        let http = ArrError::Http {
            status: 400,
            data: json!({"message": "Release not found"}),
        };
        assert_eq!(
            http.route_error(502),
            (400, json!("Release not found")),
            "the body's message"
        );
        let text = ArrError::Http {
            status: 500,
            data: json!("boom"),
        };
        assert_eq!(text.route_error(502), (500, json!("boom")), "a text body");
        let list = ArrError::Http {
            status: 400,
            data: json!([{"errorMessage": "x"}]),
        };
        assert_eq!(
            list.route_error(502),
            (400, json!("Request failed with status code 400")),
            "a list body"
        );
        assert_eq!(
            ArrError::Plain(String::from("Failed to get episodes"), false).route_error(502),
            (502, json!("Failed to get episodes")),
            "a wrapper's error"
        );
        assert_eq!(
            text.wrapped("[Sonarr] Failed to run command: ").message(),
            "[Sonarr] Failed to run command: Request failed with status code 500",
            "wrapped"
        );
        assert_eq!(axios_data(b""), json!(""), "empty body");
        assert_eq!(axios_data(b"{\"a\":1.0}"), json!({"a": 1}), "js numbers");
    }
}
