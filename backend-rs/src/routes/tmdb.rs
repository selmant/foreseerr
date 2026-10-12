//! Metadata lookups that pass TMDB through: regions, languages and watch
//! providers, from `server/routes/index.ts`.

use std::future::Future;
use std::pin::Pin;

use serde_json::{Map, Value};

use super::{Outcome, Ready};

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// `GET /regions`.
pub(super) fn regions<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = ctx
            .no_query()
            .and_then(|()| ctx.authenticated(0).map(|_| ()))
        {
            return Outcome::forward(why);
        }
        match ctx.state.tmdb.regions().await {
            Ok(items) => ctx.json(&Value::Array(items)),
            Err(e) => failed(ctx, "Unable to retrieve regions.", &e),
        }
    })
}

/// `GET /languages`.
pub(super) fn languages<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = ctx
            .no_query()
            .and_then(|()| ctx.authenticated(0).map(|_| ()))
        {
            return Outcome::forward(why);
        }
        match ctx.state.tmdb.languages().await {
            Ok(items) => ctx.json(&Value::Array(items)),
            Err(e) => failed(ctx, "Unable to retrieve languages.", &e),
        }
    })
}

/// `GET /watchproviders/regions`. The route has no `isAuthenticated`, so
/// any request the validator lets through (a credential is present) is
/// answered.
pub(super) fn watch_provider_regions<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = ctx.no_query().and_then(|()| ctx.credential_present()) {
            return Outcome::forward(why);
        }
        match ctx
            .state
            .tmdb
            .watch_provider_regions(original_language(ctx))
            .await
        {
            Ok(items) => ctx.json(&Value::Array(items)),
            Err(e) => failed(ctx, "Unable to retrieve watch provider regions.", &e),
        }
    })
}

/// `GET /watchproviders/movies`.
pub(super) fn movie_watch_providers<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    watch_providers(ctx, "movie", "Unable to retrieve movie watch providers.")
}

/// `GET /watchproviders/tv`.
pub(super) fn tv_watch_providers<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    watch_providers(ctx, "tv", "Unable to retrieve tv watch providers.")
}

fn watch_providers<'a>(
    ctx: &'a Ready<'a>,
    kind: &'static str,
    failure: &'static str,
) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = ctx.credential_present() {
            return Outcome::forward(why);
        }
        // `watchRegion` is required and the only parameter; once the
        // validator passed the query, its decoded value is what the
        // handler reads.
        let validated = ctx
            .validated()
            .map(|v| v.query.get("watchRegion").and_then(Value::as_str));
        let region = match (
            validated,
            ctx.req
                .uri
                .query()
                .unwrap_or("")
                .strip_prefix("watchRegion="),
        ) {
            (Some(Some(v)), _) => v,
            (None, Some(v)) if !v.is_empty() && !v.contains('&') && is_unreserved(v) => v,
            (Some(None) | None, _) => {
                return Outcome::forward(String::from("watchRegion needs the OpenAPI validator"))
            }
        };
        match ctx
            .state
            .tmdb
            .watch_providers(kind, original_language(ctx), region)
            .await
        {
            Ok(items) => {
                let mapped: Vec<Value> = items.iter().map(map_watch_provider).collect();
                ctx.json(&Value::Array(mapped))
            }
            Err(e) => failed(ctx, failure, &e),
        }
    })
}

/// `mapWatchProviderDetails` for one provider; missing fields are
/// `undefined` in Node and so left out.
fn map_watch_provider(provider: &Value) -> Value {
    let mut out = Map::new();
    for (to, from) in [
        ("displayPriority", "display_priority"),
        ("logoPath", "logo_path"),
        ("id", "provider_id"),
        ("name", "provider_name"),
    ] {
        if let Some(v) = provider.get(from) {
            out.insert(String::from(to), v.clone());
        }
    }
    Value::Object(out)
}

/// `createTmdbWithRegionLanguage()` with no user: `settings.main.originalLanguage`,
/// which axios sends even when empty and leaves out when it is missing.
fn original_language<'a>(ctx: &'a Ready<'a>) -> Option<&'a str> {
    ctx.settings
        .get("/main/originalLanguage")
        .and_then(Value::as_str)
}

fn is_unreserved(value: &str) -> bool {
    value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~'))
}

/// The 500 Node's error handler sends after `next({ status: 500, message })`.
fn failed(ctx: &Ready<'_>, message: &str, error: &anyhow::Error) -> Outcome {
    tracing::debug!("{message} {error:#}");
    ctx.error(500, message)
}
