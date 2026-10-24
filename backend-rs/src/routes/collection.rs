//! `GET /collection/{id}`.

use std::cmp::Ordering;
use std::future::Future;
use std::pin::Pin;

use serde_json::{Map, Value};

use super::movie::{languages, map_movie_result, RelatedTitles};
use super::ratingsenrich::enrich_results_with_ratings;
use super::{Outcome, Ready};

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// `GET /collection/{id}`: `mapCollection`, parts by release date.
pub(super) fn detail<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let user = match ctx.authenticated(0) {
            Ok(user) => user,
            Err(why) => return Outcome::forward(why),
        };
        let language = match super::movie::language_of(ctx) {
            Ok(language) => language,
            Err(why) => return Outcome::forward(why),
        };
        let id = match super::movie::path_number(ctx, 0) {
            Ok(id) => id,
            Err(why) => return Outcome::forward(why),
        };
        let (_, language) = languages(ctx, user.locale.as_deref(), language.as_deref());
        let collection = match ctx.state.tmdb.collection(id, &language).await {
            Ok(collection) => collection,
            Err(e) => {
                tracing::debug!("TMDB collection {id} failed: {e:#}");
                return ctx.error(500, "Unable to retrieve collection.");
            }
        };
        let Some(parts) = collection.get("parts").and_then(Value::as_array) else {
            return ctx.error(500, "Unable to retrieve collection.");
        };
        let related = match RelatedTitles::load(ctx, parts, "movie", Some(user.id)).await {
            Ok(related) => related,
            Err(why) => return Outcome::forward(why),
        };
        let mut sorted: Vec<&Value> = parts.iter().collect();
        sorted.sort_by(|a, b| lodash_compare(a.get("release_date"), b.get("release_date")));
        let mut out = Map::new();
        for (key, source) in [
            ("id", "id"),
            ("name", "name"),
            ("overview", "overview"),
            ("posterPath", "poster_path"),
            ("backdropPath", "backdrop_path"),
        ] {
            if let Some(value) = collection.get(source) {
                out.insert(String::from(key), value.clone());
            }
        }
        let parts: Vec<Value> = sorted
            .iter()
            .map(|part| map_movie_result(part, related.media_info(ctx, part, "movie")))
            .collect();
        // `mapped.parts = await enrichResultsWithRatings(mapped.parts)`,
        // inside the route's catch.
        let Ok(parts) = enrich_results_with_ratings(ctx, parts, None, false).await else {
            return ctx.error(500, "Unable to retrieve collection.");
        };
        out.insert(String::from("parts"), Value::Array(parts));
        ctx.json(&Value::Object(out))
    })
}

/// lodash's `sortBy` order for one key: values ascending, then null, then
/// missing. Strings compare by UTF-16 code unit like JavaScript.
fn lodash_compare(a: Option<&Value>, b: Option<&Value>) -> Ordering {
    let rank = |v: Option<&Value>| match v {
        None => 2,
        Some(Value::Null) => 1,
        Some(_) => 0,
    };
    match rank(a).cmp(&rank(b)) {
        Ordering::Equal => {}
        other @ (Ordering::Less | Ordering::Greater) => return other,
    }
    match (a, b) {
        (Some(Value::String(x)), Some(Value::String(y))) => x.encode_utf16().cmp(y.encode_utf16()),
        (Some(Value::Number(x)), Some(Value::Number(y))) => x
            .as_f64()
            .partial_cmp(&y.as_f64())
            .unwrap_or(Ordering::Equal),
        _ => Ordering::Equal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sorts_like_lodash() {
        let mut parts = [
            json!({"id": 1, "release_date": "2019-12-18"}),
            json!({"id": 2}),
            json!({"id": 3, "release_date": "1977-05-25"}),
            json!({"id": 4, "release_date": null}),
            json!({"id": 5, "release_date": ""}),
        ];
        parts.sort_by(|a, b| lodash_compare(a.get("release_date"), b.get("release_date")));
        let ids: Vec<i64> = parts
            .iter()
            .filter_map(|p| p.get("id").and_then(Value::as_i64))
            .collect();
        assert_eq!(
            ids,
            [5, 3, 1, 4, 2],
            "empty first, then dates, null, missing"
        );
    }
}
