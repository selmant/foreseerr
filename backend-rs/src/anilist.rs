//! `server/api/anilist`: the GraphQL client the discover rows use.
//!
//! It keeps `ExternalAPI.post`'s response cache (keyed by the request body, not the
//! token, as Node's is) and the failure classification of `failures.ts`.
//!
//! Node's per-instance rate limiter (one request a second) never delays
//! these routes: each request builds its own client and makes one call.
//! A 429 holds every client back for its `Retry-After`; a short one is
//! waited out and the request goes once more.

use std::future::Future;
use std::time::{Duration, Instant};

use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{Map, Value};

use crate::jsval;
use crate::memcache::{self, CacheId};

/// `ANILIST_GRAPHQL_URL`.
const GRAPHQL_URL: &str = "https://graphql.anilist.co";
const PAGE_SIZE: i64 = 20;
/// `PUBLIC_PAGE_CACHE_TTL_SECONDS`.
pub const PAGE_TTL: Duration = Duration::from_secs(300);
/// `ANILIST_RATE_LIMIT_MAX_WAIT_SECONDS`: the longest a request waits out
/// `AniList`'s rate limit before failing.
const RATE_LIMIT_MAX_WAIT: Duration = Duration::from_secs(10);

/// `anilistRateLimitedUntilMs`. Every client shares it: one 429 means the
/// rest would get one too.
static GATE: RateGate = RateGate::new(RATE_LIMIT_MAX_WAIT);

macro_rules! media_fields {
    () => {
        "\n  id\n  idMal\n  title { romaji english native }\n  format\n  episodes\n  seasonYear\n  startDate { year }\n  coverImage { large medium }\n"
    };
}

macro_rules! media_relation_fields {
    () => {
        "\n  relations { edges { relationType node { id type format } } }\n"
    };
}

pub mod actions;

/// `PAGE_MEDIA_QUERY`, byte for byte.
const PAGE_MEDIA_QUERY: &str = concat!(
    "\n  query PageMedia(\n    $page: Int\n    $perPage: Int\n    $sort: [MediaSort]\n    $season: MediaSeason\n    $seasonYear: Int\n    $type: MediaType\n  ) {\n    Page(page: $page, perPage: $perPage) {\n      pageInfo { currentPage hasNextPage lastPage perPage total }\n      media(\n        type: $type\n        sort: $sort\n        season: $season\n        seasonYear: $seasonYear\n      ) {\n        ",
    media_fields!(),
    "\n        ",
    media_relation_fields!(),
    "\n      }\n    }\n  }\n"
);

/// `MEDIA_LIST_COLLECTION_QUERY`, byte for byte.
const MEDIA_LIST_COLLECTION_QUERY: &str = concat!(
    "\n  query MediaListCollection($userId: Int, $userName: String) {\n    MediaListCollection(userId: $userId, userName: $userName, type: ANIME) {\n      lists {\n        name\n        isCustomList\n        status\n        entries {\n          id\n          status\n          progress\n          score(format: POINT_10)\n          scoreRaw: score(format: POINT_100)\n          media { ",
    media_fields!(),
    " }\n        }\n      }\n    }\n  }\n"
);

/// `MEDIA_WITH_RELATIONS_QUERY`, byte for byte.
const MEDIA_WITH_RELATIONS_QUERY: &str = concat!(
    "\n  query MediaWithRelations($id: Int) {\n    Media(id: $id) { ",
    media_fields!(),
    " ",
    media_relation_fields!(),
    " }\n  }\n"
);

/// How a GraphQL call failed.
#[derive(Debug, Clone, PartialEq)]
pub enum AnilistError {
    /// `AnilistAuthError(message)`: 401.
    Auth(String),
    /// `AnilistOutageError(message)`: 503.
    Outage(String),
    /// `AnilistRateLimitedError(seconds)`: 429 with `Retry-After`.
    RateLimited(f64),
    /// `AnilistGraphQLError(message)`.
    GraphQl(String),
    /// An HTTP error axios rethrows unclassified (its status).
    Http(u16),
    /// A network failure.
    Network(String),
    /// A response shape Node would trip over in ways not reproduced here.
    Forward(String),
}

impl AnilistError {
    /// The message Node's error carries.
    #[must_use]
    pub fn message(&self) -> String {
        match self {
            Self::Auth(m)
            | Self::Outage(m)
            | Self::GraphQl(m)
            | Self::Network(m)
            | Self::Forward(m) => m.clone(),
            Self::RateLimited(s) => format!(
                "AniList API rate limited; retry after {}s",
                jsval::number_string(*s)
            ),
            Self::Http(status) => format!("Request failed with status code {status}"),
        }
    }
}

/// A season as `AnilistAPI.currentSeason` names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Season {
    /// `WINTER`, `SPRING`, `SUMMER` or `FALL`.
    pub name: &'static str,
    /// The year.
    pub year: i64,
}

/// `currentSeason(now)` for a UTC month (0-based) and year.
#[must_use]
pub const fn current_season(month: i64, year: i64) -> Season {
    let name = if month <= 2 {
        "WINTER"
    } else if month <= 5 {
        "SPRING"
    } else if month <= 8 {
        "SUMMER"
    } else {
        "FALL"
    };
    Season { name, year }
}

/// `nextSeason(now)`.
#[must_use]
pub const fn next_season(month: i64, year: i64) -> Season {
    let current = current_season(month, year);
    match current.name.as_bytes() {
        b"WINTER" => Season {
            name: "SPRING",
            year,
        },
        b"SPRING" => Season {
            name: "SUMMER",
            year,
        },
        b"SUMMER" => Season { name: "FALL", year },
        _ => Season {
            name: "WINTER",
            year: year + 1,
        },
    }
}

/// `Page.pageInfo` plus the page's media.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaPage {
    /// `Boolean(pageInfo.hasNextPage)`.
    pub has_next_page: bool,
    /// Media with an id, music left out.
    pub media: Vec<Value>,
}

/// `new AnilistAPI({ accessToken })`.
#[derive(Debug, Clone)]
pub struct Anilist {
    client: reqwest::Client,
    token: Option<String>,
    pace: Option<&'static Pace>,
}

/// An `AnilistAPI` instance's `axios-rate-limit` (`maxRPS: 1`): requests
/// that reach the network go out at most one a second; answers from the
/// cache never pass the limiter.
#[derive(Debug)]
pub struct Pace(tokio::sync::Mutex<Option<Instant>>);

impl Pace {
    /// A limiter that hasn't let anything through yet.
    #[must_use]
    pub const fn new() -> Self {
        Self(tokio::sync::Mutex::const_new(None))
    }

    async fn wait(&self) {
        let mut last = self.0.lock().await;
        if let Some(at) = *last {
            let wait = Duration::from_secs(1).saturating_sub(at.elapsed());
            if !wait.is_zero() {
                tokio::time::sleep(wait).await;
            }
        }
        *last = Some(Instant::now());
    }
}

impl Default for Pace {
    fn default() -> Self {
        Self::new()
    }
}

/// When `AniList` takes requests again after a 429, held against every
/// request that reaches the network.
#[derive(Debug)]
struct RateGate {
    until: std::sync::Mutex<Option<Instant>>,
    max_wait: Duration,
}

impl RateGate {
    const fn new(max_wait: Duration) -> Self {
        Self {
            until: std::sync::Mutex::new(None),
            max_wait,
        }
    }

    /// `waitForAnilistGate()`: wait for the gate, or fail when it opens
    /// later than a request waits.
    async fn wait(&self) -> Result<(), AnilistError> {
        let until = *crate::sync::lock(&self.until);
        let Some(left) = until.and_then(|at| at.checked_duration_since(Instant::now())) else {
            return Ok(());
        };
        if left > self.max_wait {
            return Err(AnilistError::RateLimited(left.as_secs_f64().ceil()));
        }
        tokio::time::sleep(left).await;
        Ok(())
    }

    /// `closeAnilistGate(seconds)`: hold requests back for a 429's
    /// `Retry-After`.
    fn close(&self, seconds: f64) {
        // No Retry-After AniList sends is past every deadline.
        let Some(until) = Duration::try_from_secs_f64(seconds)
            .ok()
            .and_then(|wait| Instant::now().checked_add(wait))
        else {
            return;
        };
        let mut current = crate::sync::lock(&self.until);
        let was_open = current.is_none_or(|at| at <= Instant::now());
        if current.is_none_or(|at| until > at) {
            *current = Some(until);
        }
        drop(current);
        if was_open {
            tracing::warn!(
                label = "AniList API",
                retryAfterSeconds = seconds,
                "AniList rate limited; holding requests back"
            );
        }
    }

    /// Whether the request a 429 answered waits it out and goes again.
    fn retries(&self, seconds: f64) -> bool {
        Duration::try_from_secs_f64(seconds).is_ok_and(|wait| wait <= self.max_wait)
    }
}

/// `graphql`'s fetch: the cache, else `send` behind `gate`. A 429 closes
/// the gate; when its `Retry-After` is short (`AniList`'s per-minute
/// window rolling over) the request waits it out and goes round once
/// more, cache first.
async fn fetch<C, S, F>(
    gate: &RateGate,
    cached: C,
    mut send: S,
) -> Result<std::sync::Arc<Value>, AnilistError>
where
    C: Fn() -> Option<std::sync::Arc<Value>>,
    S: FnMut() -> F,
    F: Future<Output = Result<std::sync::Arc<Value>, AnilistError>>,
{
    let mut retried = false;
    loop {
        if let Some(hit) = cached() {
            return Ok(hit);
        }
        gate.wait().await?;
        match send().await {
            Err(AnilistError::RateLimited(seconds)) => {
                gate.close(seconds);
                if retried || !gate.retries(seconds) {
                    return Err(AnilistError::RateLimited(seconds));
                }
                retried = true;
            }
            done => return done,
        }
    }
}

impl Anilist {
    /// A client over the outgoing HTTP client, with the user's token or
    /// none (the app client).
    #[must_use]
    pub fn new(client: &reqwest::Client, token: Option<String>) -> Self {
        Self {
            client: client.clone(),
            token,
            pace: None,
        }
    }

    /// The same client behind a shared instance's limiter.
    #[must_use]
    pub const fn paced(mut self, pace: &'static Pace) -> Self {
        self.pace = Some(pace);
        self
    }

    /// `ping()`: the smallest Page query `AniList` accepts, cached like a
    /// public page.
    ///
    /// # Errors
    ///
    /// Fails as Node's `graphql` does.
    pub async fn ping(&self) -> Result<(), AnilistError> {
        self.graphql(
            "query {\n        Page(page: 1, perPage: 1) {\n          pageInfo { currentPage }\n          media { id }\n        }\n      }",
            Map::new(),
            Some(PAGE_TTL),
        )
        .await
        .map(|_| ())
    }

    /// `getMediaPage(page, { sort, season })`.
    ///
    /// # Errors
    ///
    /// Fails as Node's `graphql` does.
    pub async fn media_page(
        &self,
        page: i64,
        sort: &str,
        season: Option<Season>,
    ) -> Result<MediaPage, AnilistError> {
        let mut variables = Map::new();
        variables.insert(String::from("page"), Value::from(page));
        variables.insert(String::from("perPage"), Value::from(PAGE_SIZE));
        variables.insert(String::from("type"), Value::from("ANIME"));
        variables.insert(String::from("sort"), Value::Array(vec![Value::from(sort)]));
        if let Some(season) = season {
            variables.insert(String::from("season"), Value::from(season.name));
            variables.insert(String::from("seasonYear"), Value::from(season.year));
        }
        let data = self
            .graphql(PAGE_MEDIA_QUERY, variables, Some(PAGE_TTL))
            .await?;
        let page_value = data.get("Page").filter(|p| !p.is_null());
        let has_next_page = page_value
            .and_then(|p| p.get("pageInfo"))
            .filter(|i| !i.is_null())
            .is_some_and(|info| crate::settings::public::truthy(info.get("hasNextPage")));
        let media = match page_value.and_then(|p| p.get("media")) {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(items)) => items
                .iter()
                .filter(|item| {
                    !item.is_null()
                        && crate::settings::public::truthy(item.get("id"))
                        && item.get("format").and_then(Value::as_str) != Some("MUSIC")
                })
                .cloned()
                .collect(),
            Some(_) => return Err(AnilistError::Forward(String::from("media isn't an array"))),
        };
        Ok(MediaPage {
            has_next_page,
            media,
        })
    }

    /// `getMediaListCollection(user)`: the lists (by account id or name).
    ///
    /// # Errors
    ///
    /// Fails as Node's `graphql` does.
    pub async fn media_list_collection(&self, user: &Value) -> Result<Vec<Value>, AnilistError> {
        let mut variables = Map::new();
        let key = if user.is_string() {
            "userName"
        } else {
            "userId"
        };
        variables.insert(String::from(key), user.clone());
        let data = self
            .graphql(MEDIA_LIST_COLLECTION_QUERY, variables, None)
            .await?;
        match data
            .get("MediaListCollection")
            .filter(|c| !c.is_null())
            .and_then(|c| c.get("lists"))
        {
            None | Some(Value::Null) => Ok(Vec::new()),
            Some(Value::Array(lists)) => Ok(lists.clone()),
            Some(_) => Err(AnilistError::Forward(String::from("lists isn't an array"))),
        }
    }

    /// `getMediaWithRelations(id)`: the entry with its prequel links, or
    /// `None` when `AniList` answers without one.
    ///
    /// # Errors
    ///
    /// Fails as Node's `graphql` does.
    pub async fn media_with_relations(&self, id: i64) -> Result<Option<Value>, AnilistError> {
        let mut variables = Map::new();
        variables.insert(String::from("id"), Value::from(id));
        let data = self
            .graphql(MEDIA_WITH_RELATIONS_QUERY, variables, Some(PAGE_TTL))
            .await?;
        Ok(data.get("Media").filter(|m| !m.is_null()).cloned())
    }

    /// `graphql(query, variables, ttl)`.
    async fn graphql(
        &self,
        query: &str,
        variables: Map<String, Value>,
        ttl: Option<Duration>,
    ) -> Result<Value, AnilistError> {
        let mut body = Map::new();
        body.insert(String::from("query"), Value::from(query));
        body.insert(String::from("variables"), Value::Object(variables));
        let body = Value::Object(body).to_string();
        // `ExternalAPI.post` consults the cache whatever the TTL; a TTL
        // of 0 only skips storing.
        // Keyed by the query and its variables; the token isn't part of it.
        let key = &format!("{GRAPHQL_URL} {body}");
        let body = &body;
        let response = fetch(
            &GATE,
            || {
                memcache::get(CacheId::Anilist, key)
                    .filter(|v| crate::settings::public::truthy(Some(v)))
            },
            move || async move {
                if let Some(pace) = self.pace {
                    pace.wait().await;
                }
                let response = std::sync::Arc::new(self.post(body).await?);
                if let Some(ttl) = ttl {
                    memcache::set(
                        CacheId::Anilist,
                        key.clone(),
                        std::sync::Arc::clone(&response),
                        ttl,
                    );
                }
                Ok(response)
            },
        )
        .await?;
        if let Some(failure) = classify_body(&response, None)? {
            return Err(failure);
        }
        match response.get("errors") {
            None | Some(Value::Null) => {}
            Some(Value::Array(errors)) if errors.is_empty() => {}
            Some(Value::Array(errors)) => {
                let message = errors
                    .first()
                    .and_then(|e| e.get("message"))
                    .filter(|m| crate::settings::public::truthy(Some(m)))
                    .map_or_else(
                        || String::from("AniList GraphQL error"),
                        |m| jsval::string_of(Some(m)),
                    );
                return Err(AnilistError::GraphQl(message));
            }
            Some(_) => return Err(AnilistError::Forward(String::from("errors isn't an array"))),
        }
        match response.get("data") {
            Some(data @ Value::Object(_)) => Ok(data.clone()),
            None | Some(Value::Null) => Err(AnilistError::GraphQl(String::from(
                "AniList returned an empty response",
            ))),
            Some(_) => Err(AnilistError::Forward(String::from("data isn't an object"))),
        }
    }

    /// The POST itself; a 2xx answer that isn't a JSON object is Node's.
    async fn post(&self, body: &str) -> Result<Value, AnilistError> {
        let mut req = self
            .client
            .post(GRAPHQL_URL)
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, "application/json")
            .body(body.to_owned());
        if let Some(token) = &self.token {
            req = req.header(AUTHORIZATION, format!("Bearer {token}"));
        }
        let res = req
            .send()
            .await
            .map_err(|e| AnilistError::Network(crate::outbound::describe(&e)))?;
        let status = res.status().as_u16();
        let retry_after = res
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let text = res
            .text()
            .await
            .map_err(|e| AnilistError::Network(crate::outbound::describe(&e)))?;
        let parsed = serde_json::from_str::<Value>(&text)
            .map_or_else(|_| Value::from(text.as_str()), crate::tmdb::js_numbers);
        if (200..300).contains(&status) {
            return if parsed.is_object() {
                Ok(parsed)
            } else {
                Err(AnilistError::Forward(String::from(
                    "a GraphQL answer that isn't an object",
                )))
            };
        }
        if status == 429 {
            let seconds = retry_after.map_or(f64::NAN, |t| jsval::number_of_str(&t));
            return Err(AnilistError::RateLimited(
                if seconds.is_finite() && seconds > 0.0 {
                    seconds
                } else {
                    60.0
                },
            ));
        }
        Err(classify_body(&parsed, Some(status))?.unwrap_or(AnilistError::Http(status)))
    }
}

/// `classifyAnilistFailure` over `firstAnilistGraphQlError(data)`.
fn classify_body(
    data: &Value,
    http_status: Option<u16>,
) -> Result<Option<AnilistError>, AnilistError> {
    let first = match data.get("errors") {
        Some(Value::Array(errors)) => errors.first(),
        None | Some(Value::Null) => None,
        Some(_) => {
            return Err(AnilistError::Forward(String::from(
                "an errors field that isn't an array",
            )))
        }
    };
    let (status, message) = match first {
        None | Some(Value::Null) => (None, None),
        Some(Value::Object(e)) => (e.get("status").filter(|s| !s.is_null()), e.get("message")),
        Some(_) => return Err(AnilistError::Forward(String::from("an odd GraphQL error"))),
    };
    let message = match message {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(m)) => jsval::trim(m).to_owned(),
        Some(_) => {
            return Err(AnilistError::Forward(String::from(
                "a GraphQL message that isn't text",
            )))
        }
    };
    if outage_message(&message) {
        return Ok(Some(AnilistError::Outage(message)));
    }
    let status = status.map_or_else(
        || http_status.map(f64::from),
        |s| s.as_f64().or(Some(f64::NAN)),
    );
    if status.is_some_and(|s| (s - 401.0).abs() < f64::EPSILON || (s - 403.0).abs() < f64::EPSILON)
    {
        return Ok(Some(AnilistError::Auth(if message.is_empty() {
            String::from("AniList authorization expired; reconnect your account")
        } else {
            message
        })));
    }
    Ok(None)
}

/// `OUTAGE_MESSAGE`.
fn outage_message(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    [
        "temporarily disabled",
        "stability issues",
        "service unavailable",
        "under maintenance",
    ]
    .iter()
    .any(|p| lower.contains(p))
}

/// `parseAnilistListUrl(input)`.
///
/// # Errors
///
/// Fails with Node's message.
pub fn parse_list_url(input: &str) -> Result<(String, Option<String>), String> {
    let value = jsval::trim(input);
    if value.is_empty() {
        return Err(String::from("List URL or reference is required"));
    }
    match match_list_url(value) {
        Some((user, section, list)) => {
            if section.is_some_and(|s| !s.eq_ignore_ascii_case("animelist")) {
                return Err(String::from(
                    "Unsupported AniList list URL: only anime lists can be opened",
                ));
            }
            let unsupported = || String::from("Unsupported AniList list URL");
            let user = jsval::decode_uri_component(user).ok_or_else(unsupported)?;
            let list = match list {
                Some(l) => Some(jsval::decode_uri_component(l).ok_or_else(unsupported)?),
                None => None,
            };
            Ok((user, list))
        }
        None if value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') =>
        {
            Ok((value.to_owned(), None))
        }
        None => Err(String::from("Unsupported AniList list URL")),
    }
}

/// The regex `^(?:https?:\/\/)?(?:www\.)?anilist\.co\/user\/([^/?#]+)
/// (?:\/([^/?#]+)(?:\/([^/?#]+))?)?\/?(?:[?#].*)?$/i`: user, section, list.
fn match_list_url(value: &str) -> Option<(&str, Option<&str>, Option<&str>)> {
    let strip = |s: &str, prefix: &str| -> Option<usize> {
        s.get(..prefix.len())
            .filter(|p| p.eq_ignore_ascii_case(prefix))
            .map(|_| prefix.len())
    };
    let mut rest = value;
    for scheme in ["https://", "http://"] {
        if let Some(n) = strip(rest, scheme) {
            rest = rest.get(n..)?;
            break;
        }
    }
    if let Some(n) = strip(rest, "www.") {
        rest = rest.get(n..)?;
    }
    rest = rest.get(strip(rest, "anilist.co/user/")?..)?;
    let run = |s: &str| s.find(['/', '?', '#']).unwrap_or(s.len());
    let user_len = run(rest);
    if user_len == 0 {
        return None;
    }
    let (user, mut rest) = rest.split_at(user_len);
    let mut segments: Vec<&str> = Vec::new();
    while segments.len() < 2 {
        let Some(after) = rest.strip_prefix('/') else {
            break;
        };
        let len = run(after);
        if len == 0 {
            break;
        }
        let (segment, tail) = after.split_at(len);
        segments.push(segment);
        rest = tail;
    }
    let rest = rest.strip_prefix('/').unwrap_or(rest);
    let tail_ok = rest.is_empty()
        || (rest.starts_with(['?', '#']) && !rest.contains(['\n', '\r', '\u{2028}', '\u{2029}']));
    if !tail_ok {
        return None;
    }
    Some((user, segments.first().copied(), segments.get(1).copied()))
}

/// `STATUS_LIST_NAMES[status]`.
#[must_use]
pub fn status_list_name(status: &str) -> Option<&'static str> {
    Some(match status {
        "CURRENT" => "Watching",
        "PLANNING" => "Planning",
        "COMPLETED" => "Completed",
        "DROPPED" => "Dropped",
        "PAUSED" => "Paused",
        "REPEATING" => "Repeating",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn queries_keep_their_text() {
        assert!(
            PAGE_MEDIA_QUERY.starts_with("\n  query PageMedia(\n    $page: Int\n"),
            "page query head"
        );
        assert!(
            PAGE_MEDIA_QUERY.contains("      ) {\n        \n  id\n  idMal\n"),
            "media fields interpolated"
        );
        assert!(
            PAGE_MEDIA_QUERY.ends_with("coverImage { large medium }\n\n        \n  relations { edges { relationType node { id type format } } }\n\n      }\n    }\n  }\n"),
            "page query tail"
        );
        assert!(
            MEDIA_LIST_COLLECTION_QUERY.contains("media { \n  id\n")
                && MEDIA_LIST_COLLECTION_QUERY
                    .ends_with("large medium }\n }\n        }\n      }\n    }\n  }\n"),
            "collection query"
        );
    }

    #[test]
    fn seasons() {
        assert_eq!(
            current_season(9, 2026),
            Season {
                name: "FALL",
                year: 2026
            },
            "october"
        );
        assert_eq!(
            next_season(11, 2026),
            Season {
                name: "WINTER",
                year: 2027
            },
            "wraps"
        );
        assert_eq!(
            next_season(0, 2026),
            Season {
                name: "SPRING",
                year: 2026
            },
            "january"
        );
    }

    #[test]
    fn list_urls() {
        assert_eq!(
            parse_list_url("https://anilist.co/user/Foo/animelist/Watching%20Now"),
            Ok((String::from("Foo"), Some(String::from("Watching Now")))),
            "list"
        );
        assert_eq!(
            parse_list_url("ANILIST.co/user/Foo/"),
            Ok((String::from("Foo"), None)),
            "bare"
        );
        assert_eq!(
            parse_list_url("anilist.co/user/Foo/mangalist"),
            Err(String::from(
                "Unsupported AniList list URL: only anime lists can be opened"
            )),
            "manga"
        );
        assert_eq!(
            parse_list_url("anilist.co/user/Foo/a/b/c"),
            Err(String::from("Unsupported AniList list URL")),
            "too deep"
        );
        assert_eq!(
            parse_list_url("some_user-1"),
            Ok((String::from("some_user-1"), None)),
            "username"
        );
        assert_eq!(
            parse_list_url("anilist.co/user/Foo?tab=1"),
            Ok((String::from("Foo"), None)),
            "query tail"
        );
    }

    #[test]
    fn classifies_failures() {
        let outage = json!({"errors": [{"message": " API temporarily disabled ", "status": 403}]});
        assert_eq!(
            classify_body(&outage, None),
            Ok(Some(AnilistError::Outage(String::from(
                "API temporarily disabled"
            )))),
            "outage beats auth"
        );
        let auth = json!({"errors": [{"status": 401}]});
        assert_eq!(
            classify_body(&auth, None),
            Ok(Some(AnilistError::Auth(String::from(
                "AniList authorization expired; reconnect your account"
            )))),
            "default auth message"
        );
        assert!(
            classify_body(&json!({}), Some(403))
                .ok()
                .flatten()
                .is_some(),
            "http 403"
        );
        assert_eq!(
            classify_body(&json!({}), Some(404)),
            Ok(None),
            "404 passes through"
        );
        assert_eq!(
            AnilistError::RateLimited(1.5).message(),
            "AniList API rate limited; retry after 1.5s",
            "rate message"
        );
    }

    /// `fetch` through `gate` with nothing cached, each send answered by
    /// the next of `answers`; the result and how many sends there were.
    async fn fetch_answers(
        gate: &RateGate,
        answers: Vec<Result<Value, AnilistError>>,
    ) -> (Result<std::sync::Arc<Value>, AnilistError>, usize) {
        let answers = std::sync::Mutex::new(answers.into_iter());
        let sends = std::sync::atomic::AtomicUsize::new(0);
        let (answers_ref, sends_ref) = (&answers, &sends);
        let result = fetch(
            gate,
            || None,
            move || async move {
                sends_ref.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let answer = crate::sync::lock(answers_ref).next();
                answer
                    .unwrap_or_else(|| Err(AnilistError::Forward(String::from("no answer left"))))
                    .map(std::sync::Arc::new)
            },
        )
        .await;
        (result, sends.load(std::sync::atomic::Ordering::SeqCst))
    }

    #[tokio::test]
    async fn waits_out_a_short_rate_limit_once() {
        let gate = RateGate::new(Duration::from_millis(500));
        let started = Instant::now();
        let (result, sends) = fetch_answers(
            &gate,
            vec![
                Err(AnilistError::RateLimited(0.05)),
                Ok(json!({"data": {}})),
            ],
        )
        .await;
        assert_eq!(
            result.ok().as_deref(),
            Some(&json!({"data": {}})),
            "retried"
        );
        assert_eq!(sends, 2, "two sends");
        assert!(started.elapsed() >= Duration::from_millis(50), "waited");

        let (result, sends) = fetch_answers(
            &gate,
            vec![
                Err(AnilistError::RateLimited(0.01)),
                Err(AnilistError::RateLimited(0.01)),
            ],
        )
        .await;
        assert_eq!(result, Err(AnilistError::RateLimited(0.01)), "retries once");
        assert_eq!(sends, 2, "no third send");
    }

    #[tokio::test]
    async fn a_long_rate_limit_holds_every_request_back() {
        let gate = RateGate::new(Duration::from_millis(500));
        let (result, sends) =
            fetch_answers(&gate, vec![Err(AnilistError::RateLimited(30.0))]).await;
        assert_eq!(result, Err(AnilistError::RateLimited(30.0)), "no retry");
        assert_eq!(sends, 1, "one send");

        let (result, sends) = fetch_answers(&gate, vec![Ok(json!({}))]).await;
        assert_eq!(result, Err(AnilistError::RateLimited(30.0)), "held back");
        assert_eq!(sends, 0, "never sent");

        let hit = std::sync::Arc::new(json!({"data": {}}));
        let cached = fetch(
            &gate,
            || Some(std::sync::Arc::clone(&hit)),
            || async { Err(AnilistError::Forward(String::from("sent"))) },
        )
        .await;
        assert_eq!(cached, Ok(hit), "the cache still answers");
    }
}
