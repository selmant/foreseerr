//! URL and route normalisation used to match calls across backends.

use url::Url;

/// Canonical form of an absolute URL: lowercase host, default port dropped,
/// query parameters sorted, ignored parameters removed.
#[must_use]
pub fn normalize_url(raw: &str, ignore_params: &[String]) -> String {
    let Ok(url) = Url::parse(raw) else {
        return raw.to_owned();
    };
    let mut pairs: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(k, _)| !ignore_params.iter().any(|p| p.eq_ignore_ascii_case(k)))
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    pairs.sort();
    build(&url, &pairs)
}

/// Like [`normalize_url`], but values that change from day to day (dates,
/// unix timestamps) are replaced with placeholders.
///
/// Used as a last-resort match when a replay runs on a different day than
/// the recording.
#[must_use]
pub fn fuzzy_url(raw: &str, ignore_params: &[String]) -> String {
    let Ok(mut url) = Url::parse(raw) else {
        return raw.to_owned();
    };
    let mut pairs: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(k, _)| !ignore_params.iter().any(|p| p.eq_ignore_ascii_case(k)))
        .map(|(k, v)| (k.into_owned(), volatile_value(&v)))
        .collect();
    pairs.sort();
    let path = url
        .path()
        .split('/')
        .map(volatile_value)
        .collect::<Vec<_>>()
        .join("/");
    url.set_path(&path);
    build(&url, &pairs)
}

/// [`normalize_url`] with secret query values replaced by a short hash, for
/// reports that may be shared. Equal secrets still compare equal.
#[must_use]
pub fn redacted_url(raw: &str, secret_params: &[String]) -> String {
    let Ok(mut url) = Url::parse(raw) else {
        return raw.to_owned();
    };
    let mut pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| {
            let secret = secret_params.iter().any(|p| p.eq_ignore_ascii_case(&k));
            let v = if secret {
                let hash = crate::model::sha256_hex(v.as_bytes());
                format!("redacted-{}", hash.get(..6).unwrap_or(&hash))
            } else {
                v.into_owned()
            };
            (k.into_owned(), v)
        })
        .collect();
    pairs.sort();
    // Credentials in the authority are secrets too; failure only means the
    // URL can't carry any.
    if url.set_password(None).is_err() || url.set_username("").is_err() {
        tracing::trace!("{raw}: URL cannot carry credentials");
    }
    build(&url, &pairs)
}

fn build(url: &Url, pairs: &[(String, String)]) -> String {
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    let port = match (url.scheme(), url.port()) {
        (_, None) | ("http", Some(80)) | ("https", Some(443)) => String::new(),
        (_, Some(p)) => format!(":{p}"),
    };
    let mut out = format!("{}://{}{}{}", url.scheme(), host, port, url.path());
    if !pairs.is_empty() {
        let q = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(pairs.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .finish();
        out.push('?');
        out.push_str(&q);
    }
    out
}

fn volatile_value(v: &str) -> String {
    if looks_like_date(v) {
        return "<date>".into();
    }
    if (v.len() == 10 || v.len() == 13) && v.bytes().all(|b| b.is_ascii_digit()) {
        return "<epoch>".into();
    }
    v.to_owned()
}

/// Starts with `YYYY-MM-DD`.
fn looks_like_date(v: &str) -> bool {
    let shape = b"dddd-dd-dd";
    v.len() >= shape.len()
        && v.bytes().zip(shape).all(|(c, want)| match want {
            b'd' => c.is_ascii_digit(),
            _ => c == *want,
        })
}

/// Group request paths into routes: `/api/v1/movie/550?x=1` -> `/api/v1/movie/:id`.
#[must_use]
pub fn route_of(path_and_query: &str) -> String {
    let path = path_and_query.split('?').next().unwrap_or("");
    path.split('/')
        .map(|seg| if is_id_segment(seg) { ":id" } else { seg })
        .collect::<Vec<_>>()
        .join("/")
}

fn is_id_segment(seg: &str) -> bool {
    if seg.is_empty() {
        return false;
    }
    if seg.bytes().all(|b| b.is_ascii_digit()) {
        return true;
    }
    // uuids and long hex/hash ids
    let hexish = seg.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-');
    hexish && seg.len() >= 16 && seg.bytes().any(|b| b.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_query_and_drops_default_port() {
        assert_eq!(
            normalize_url(
                "https://API.themoviedb.org:443/3/movie/550?language=en&api_key=k",
                &[]
            ),
            "https://api.themoviedb.org/3/movie/550?api_key=k&language=en",
            "host lowercased, :443 dropped, query sorted"
        );
        assert_eq!(
            normalize_url("http://sonarr:8989/api/v3/series?_=123&b=2", &["_".into()]),
            "http://sonarr:8989/api/v3/series?b=2",
            "ignored parameter removed, custom port kept"
        );
    }

    #[test]
    fn fuzzy_ignores_dates() {
        let a = fuzzy_url(
            "https://x/discover?primary_release_date.gte=2026-10-10&page=1",
            &[],
        );
        let b = fuzzy_url(
            "https://x/discover?page=1&primary_release_date.gte=2026-11-02",
            &[],
        );
        assert_eq!(a, b, "dates in query values are masked");
        let c = fuzzy_url("http://sonarr/api/v3/calendar/2026-10-10T00:00:00Z", &[]);
        let d = fuzzy_url("http://sonarr/api/v3/calendar/2026-10-12T00:00:00Z", &[]);
        assert_eq!(c, d, "dates in path segments are masked");
    }

    #[test]
    fn redacts_secrets() {
        let secret = ["api_key".to_owned()];
        let a = redacted_url("https://x/3/movie?api_key=abc&page=1", &secret);
        assert!(
            a.starts_with("https://x/3/movie?api_key=redacted-"),
            "secret replaced: {a}"
        );
        assert!(!a.contains("abc"), "secret value gone: {a}");
        assert_eq!(
            a,
            redacted_url("https://x/3/movie?page=1&api_key=abc", &secret),
            "same secret, same redaction"
        );
        assert_ne!(
            a,
            redacted_url("https://x/3/movie?page=1&api_key=xyz", &secret),
            "different secrets stay distinguishable"
        );
    }

    #[test]
    fn routes() {
        assert_eq!(
            route_of("/api/v1/movie/550?language=en"),
            "/api/v1/movie/:id",
            "numeric id"
        );
        assert_eq!(
            route_of("/api/v1/request/12/approve"),
            "/api/v1/request/:id/approve",
            "id in the middle"
        );
        assert_eq!(
            route_of("/api/v1/discover/movies"),
            "/api/v1/discover/movies",
            "no ids"
        );
        assert_eq!(
            route_of("/api/v1/x/3f2504e0-4f89-11d3-9a0c-0305e82c3301"),
            "/api/v1/x/:id",
            "uuid"
        );
    }
}
