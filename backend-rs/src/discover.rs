//! `toDiscoverSliderResponse` from `server/lib/discover/sliderEndpoint.ts`.

use serde_json::{Map, Value};

use crate::db::DiscoverSliderRow;

const API: &str = "/api/v1";

// `DiscoverSliderType` values that need an endpoint computed.
const TMDB_MOVIE_KEYWORD: i64 = 13;
const TMDB_MOVIE_GENRE: i64 = 14;
const TMDB_TV_KEYWORD: i64 = 15;
const TMDB_TV_GENRE: i64 = 16;
const TMDB_SEARCH: i64 = 17;
const TMDB_STUDIO: i64 = 18;
const TMDB_NETWORK: i64 = 19;
const TMDB_MOVIE_STREAMING_SERVICES: i64 = 20;
const TMDB_TV_STREAMING_SERVICES: i64 = 21;
const TRAKT_LIST: i64 = 1003;
const ANILIST_LIST: i64 = 1010;
const MDBLIST_LIST: i64 = 1014;

/// `retiredDiscoverSliderTypes`: Simkl rows without ids.
const RETIRED: [i64; 6] = [1017, 1018, 1019, 1020, 1021, 1022];

/// `builtInSliderTitles` and `fixedEndpoints`, by type.
const FIXED: [(i64, &str, &str); 17] = [
    (1001, "Trakt Recommendations", "trakt/recommendations"),
    (1002, "Trakt Watchlist", "trakt/watchlist"),
    (1004, "Trakt History", "trakt/history"),
    (1005, "AniList Trending", "anilist/trending"),
    (1006, "AniList This Season", "anilist/season"),
    (1007, "AniList Watching", "anilist/watching"),
    (1008, "AniList Planning", "anilist/planning"),
    (1009, "AniList Completed", "anilist/completed"),
    (1011, "AniList Popular", "anilist/popular"),
    (1012, "AniList Top 100", "anilist/top"),
    (1013, "AniList Next Season", "anilist/next-season"),
    (1015, "Simkl Trending", "simkl/trending"),
    (
        1016,
        "Simkl Plan to Watch",
        "simkl/library?status=plantowatch",
    ),
    (1023, "Simkl Watching", "simkl/library?status=watching"),
    (1024, "Simkl On Hold", "simkl/library?status=hold"),
    (1025, "Simkl Completed", "simkl/library?status=completed"),
    (1026, "Simkl Dropped", "simkl/library?status=dropped"),
];

/// Whether `GET /settings/discover` leaves the row out.
#[must_use]
pub fn is_retired(slider_type: i64) -> bool {
    RETIRED.contains(&slider_type)
}

/// The slider as the endpoint returns it.
#[must_use]
pub fn response(slider: &DiscoverSliderRow) -> Value {
    let text = |v: &Option<String>| v.as_deref().map_or(Value::Null, Value::from);
    let mut out = Map::new();
    out.insert(String::from("id"), Value::from(slider.id));
    out.insert(String::from("type"), Value::from(slider.slider_type));
    out.insert(String::from("order"), Value::from(slider.order));
    out.insert(String::from("isBuiltIn"), Value::Bool(slider.is_built_in));
    out.insert(String::from("enabled"), Value::Bool(slider.enabled));
    out.insert(String::from("title"), text(&slider.title));
    out.insert(String::from("data"), text(&slider.data));
    out.insert(String::from("sort"), text(&slider.sort));
    out.insert(String::from("createdAt"), text(&slider.created_at));
    out.insert(String::from("updatedAt"), text(&slider.updated_at));
    let kind = Some(slider.slider_type);
    if let Some(endpoint) = kind.and_then(|t| endpoint(t, slider.data.as_deref())) {
        out.insert(String::from("endpoint"), Value::from(endpoint));
    }
    if let Some(title) = kind.and_then(default_title) {
        out.insert(String::from("defaultTitle"), Value::from(title));
    }
    Value::Object(out)
}

fn default_title(slider_type: i64) -> Option<&'static str> {
    FIXED
        .iter()
        .find(|(t, _, _)| *t == slider_type)
        .map(|(_, title, _)| *title)
}

/// `discoverSliderEndpoint`.
fn endpoint(slider_type: i64, data: Option<&str>) -> Option<String> {
    if is_retired(slider_type) {
        return None;
    }
    if let Some((_, _, path)) = FIXED.iter().find(|(t, _, _)| *t == slider_type) {
        return Some(provider(path, &[]));
    }
    let data = data?.trim();
    if data.is_empty() {
        return None;
    }
    match slider_type {
        TMDB_MOVIE_KEYWORD => Some(with_query(
            &format!("{API}/discover/movies"),
            &[("keywords", data)],
        )),
        TMDB_TV_KEYWORD => Some(with_query(
            &format!("{API}/discover/tv"),
            &[("keywords", data)],
        )),
        TMDB_MOVIE_GENRE => Some(with_query(
            &format!("{API}/discover/movies"),
            &[("genre", data)],
        )),
        TMDB_TV_GENRE => Some(with_query(
            &format!("{API}/discover/tv"),
            &[("genre", data)],
        )),
        TMDB_SEARCH => Some(with_query(&format!("{API}/search"), &[("query", data)])),
        TMDB_STUDIO => Some(format!(
            "{API}/discover/movies/studio/{}",
            encode_query_value(data)
        )),
        TMDB_NETWORK => Some(format!(
            "{API}/discover/tv/network/{}",
            encode_query_value(data)
        )),
        TMDB_MOVIE_STREAMING_SERVICES | TMDB_TV_STREAMING_SERVICES => {
            // `data` is `<region>,<provider ids joined by |>`.
            let mut parts = data.split(',').map(str::trim);
            let region = parts.next().unwrap_or("");
            let providers = parts.next().unwrap_or("");
            if region.is_empty() || providers.is_empty() {
                return None;
            }
            let kind = if slider_type == TMDB_MOVIE_STREAMING_SERVICES {
                "movies"
            } else {
                "tv"
            };
            Some(with_query(
                &format!("{API}/discover/{kind}"),
                &[("watchRegion", region), ("watchProviders", providers)],
            ))
        }
        TRAKT_LIST => Some(provider("trakt/list", &[("url", data)])),
        ANILIST_LIST => Some(provider("anilist/list", &[("name", data)])),
        MDBLIST_LIST => Some(provider("mdblist/list", &[("url", data)])),
        _ => None,
    }
}

/// Provider endpoints always ask the server to drop unmapped tiles. A fixed
/// `path` may already carry a query.
fn provider(path: &str, params: &[(&str, &str)]) -> String {
    let (path, fixed_query) = path.split_once('?').unwrap_or((path, ""));
    let mut query: Vec<String> = fixed_query
        .split('&')
        .filter(|q| !q.is_empty())
        .map(str::to_owned)
        .collect();
    query.extend(
        params
            .iter()
            .map(|(k, v)| format!("{k}={}", encode_query_value(v))),
    );
    query.push(String::from("hideUnmapped=true"));
    format!("{API}/discover/{path}?{}", query.join("&"))
}

fn with_query(path: &str, params: &[(&str, &str)]) -> String {
    let query: Vec<String> = params
        .iter()
        .map(|(k, v)| format!("{k}={}", encode_query_value(v)))
        .collect();
    if query.is_empty() {
        path.to_owned()
    } else {
        format!("{path}?{}", query.join("&"))
    }
}

/// `encodeURIComponent`, then `!'()*` percent-encoded too.
#[must_use]
pub fn encode_query_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        let keep = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~');
        if keep {
            out.push(char::from(byte));
        } else {
            out.push('%');
            for nibble in [byte >> 4, byte & 0x0F] {
                out.push(
                    char::from_digit(u32::from(nibble), 16).map_or('0', |c| c.to_ascii_uppercase()),
                );
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_like_the_frontend() {
        assert_eq!(
            encode_query_value("Rewatch (2024)!"),
            "Rewatch%20%282024%29%21",
            "reserved characters"
        );
        assert_eq!(
            encode_query_value("a-b_c.d~e"),
            "a-b_c.d~e",
            "unreserved stay"
        );
        assert_eq!(encode_query_value("é"), "%C3%A9", "utf-8 bytes");
    }

    #[test]
    fn endpoints() {
        assert_eq!(
            endpoint(1016, None).as_deref(),
            Some("/api/v1/discover/simkl/library?status=plantowatch&hideUnmapped=true"),
            "fixed with query"
        );
        assert_eq!(
            endpoint(1001, None).as_deref(),
            Some("/api/v1/discover/trakt/recommendations?hideUnmapped=true"),
            "fixed"
        );
        assert_eq!(
            endpoint(TMDB_MOVIE_KEYWORD, Some(" 1,2 ")).as_deref(),
            Some("/api/v1/discover/movies?keywords=1%2C2"),
            "keyword"
        );
        assert_eq!(
            endpoint(TMDB_TV_STREAMING_SERVICES, Some("US, 8|9")).as_deref(),
            Some("/api/v1/discover/tv?watchRegion=US&watchProviders=8%7C9"),
            "streaming"
        );
        assert_eq!(
            endpoint(TMDB_TV_STREAMING_SERVICES, Some("US")),
            None,
            "streaming needs both"
        );
        assert_eq!(
            endpoint(TRAKT_LIST, Some("https://t/l")).as_deref(),
            Some("/api/v1/discover/trakt/list?url=https%3A%2F%2Ft%2Fl&hideUnmapped=true"),
            "trakt list"
        );
        assert_eq!(
            endpoint(TMDB_STUDIO, Some("a b")).as_deref(),
            Some("/api/v1/discover/movies/studio/a%20b"),
            "studio"
        );
        assert_eq!(endpoint(1, None), None, "client-drawn rows");
        assert_eq!(endpoint(1017, None), None, "retired");
        assert_eq!(endpoint(TMDB_SEARCH, Some("  ")), None, "blank data");
    }
}
