//! The routes answered here. Everything else, and anything these routes
//! can't answer exactly as Node would, is forwarded to Node.

pub mod accountlink;
pub mod anilistdiscover;
mod arrcall;
pub mod arrsettings;
pub mod authcommon;
pub mod authjellyfin;
pub mod authplex;
pub mod authreset;
pub mod autorequest;
pub mod bettertrakt;
pub mod blocklist;
pub mod browsefilter;
pub mod calendar;
mod calendarquery;
pub mod collection;
pub mod desktop;
pub mod desktopcache;
pub mod deviceauth;
pub mod discover;
pub mod discoverkit;
pub mod draft;
pub mod episodes;
pub mod episodeselect;
mod expressroute;
pub mod imageproxy;
pub mod interventions;
pub mod issue;
pub mod issuewrite;
pub mod jellyfinsettings;
pub mod jobsettings;
pub mod library;
pub mod linkedaccounts;
pub mod listwrite;
pub mod login;
pub mod logs;
pub mod mappingsettings;
pub mod mdblistdiscover;
pub mod media;
pub mod mediaactions;
mod mediaimports;
pub mod mediasave;
pub mod mediaservarr;
pub mod mediawrite;
pub mod metadata;
pub mod movie;
pub mod nodestate;
mod params;
pub mod person;
pub mod plexdiscover;
pub mod plexsettings;
pub mod plexxml;
pub mod pluginauth;
pub mod procstate;
pub mod providerkit;
pub mod quota;
pub mod ratingsenrich;
pub mod related;
pub mod request;
pub mod requestcreate;
pub mod requestedit;
pub mod requestepisodes;
pub mod requestwrite;
pub mod search;
pub mod servarrsync;
mod servarrtokens;
pub mod service;
pub mod settings;
pub mod settings_integrations;
pub mod settings_main;
pub mod settings_notify;
mod settings_util;
pub mod settingswrite;
pub mod simkldiscover;
mod simklunconfigured;
pub mod tmdb;
pub mod trakt;
pub mod traktpages;
pub mod traktrecs;
pub mod tv;
pub mod user;
pub mod userextra;
pub mod userimportplex;
pub mod usersettings;
pub mod usersettingswrite;
mod userwatchdata;
pub mod userwrite;
pub mod writes;

use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::request::Parts;
use axum::http::{Method, Request as HttpRequest, Response};
use axum::routing::MethodRouter;
use axum::Router;
use serde_json::{Map, Value};

use crate::auth::{check_user, CurrentUser, Identity};
use crate::respond;
use crate::settings::public::{full_public_settings, truthy};
use crate::settings::Settings;
use crate::state::AppState;

type Shared = Arc<AppState>;

/// `Permission.ADMIN`.
pub(super) const ADMIN: i64 = 2;

/// One module's routes: path, method, handler.
pub(super) type Table = [(&'static str, Method, Native)];

/// Every module's route table. A module adds itself here.
const TABLES: &[&Table] = &[
    &writes::WRITES,
    settingswrite::ROUTES,
    settings_main::ROUTES,
    settings_integrations::ROUTES,
    settings_notify::ROUTES,
    userwrite::ROUTES,
    userimportplex::ROUTES,
    usersettingswrite::ROUTES,
    linkedaccounts::ROUTES,
    accountlink::ROUTES,
    deviceauth::ROUTES,
    authplex::ROUTES,
    authjellyfin::ROUTES,
    authreset::ROUTES,
    desktop::ROUTES,
    desktopcache::ROUTES,
    arrsettings::ROUTES,
    jobsettings::ROUTES,
    logs::ROUTES,
    mappingsettings::ROUTES,
    plexsettings::ROUTES,
    jellyfinsettings::ROUTES,
    mediawrite::ROUTES,
    mediaservarr::ROUTES,
    interventions::ROUTES,
    library::ROUTES,
    mediaactions::ROUTES,
    metadata::ROUTES,
    episodes::ROUTES,
    calendar::ROUTES,
    trakt::ROUTES,
    anilistdiscover::ROUTES,
    mdblistdiscover::ROUTES,
    simkldiscover::ROUTES,
    plexdiscover::ROUTES,
    listwrite::ROUTES,
    issuewrite::ROUTES,
    requestcreate::ROUTES,
    requestedit::ROUTES,
];

/// The router: native routes first, Node for the rest. HEAD goes to Node
/// too: its `OpenAPI` validator answers 405 where Express alone would 200.
///
/// # Errors
///
/// When standalone mode can't load the `OpenAPI` validator.
pub fn router(state: Shared) -> anyhow::Result<Router> {
    let mut paths: Vec<(&'static str, Vec<(Method, Native)>)> = Vec::new();
    let mut add = |path: &'static str, method: Method, native: Native| {
        if let Some((_, methods)) = paths.iter_mut().find(|(p, _)| *p == path) {
            methods.push((method, native));
        } else {
            paths.push((path, vec![(method, native)]));
        }
    };
    for (path, native) in ROUTES {
        add(path, Method::GET, native);
    }
    for (path, pointer) in SETTINGS_SECTIONS {
        add(path, Method::GET, settings::section(pointer));
    }
    for table in TABLES {
        for &(path, ref method, native) in *table {
            add(path, method.clone(), native);
        }
    }
    let express = Arc::new(expressroute::Paths::new(paths.iter().map(|(p, _)| p)));
    let mut router = Router::new();
    for (path, methods) in paths {
        router = router.route(path, method_router(&methods));
    }
    let gate = crate::openapi::gate::Gate::new(Arc::clone(&state))?;
    let app = imageproxy::routes(router)
        .fallback(forward)
        .with_state(Arc::clone(&state));
    // The validator sees the request as it came, then Express's matching
    // picks the route.
    Ok(Router::new()
        .fallback_service(app)
        .layer(axum::middleware::map_request_with_state(
            express,
            expressroute::rewrite,
        ))
        .layer(axum::middleware::from_fn_with_state(
            gate,
            crate::openapi::gate::gate,
        ))
        .layer(axum::middleware::from_fn_with_state(
            Arc::clone(&state),
            crate::runtime::desktop::api_layer,
        ))
        .layer(axum::middleware::from_fn_with_state(
            Arc::clone(&state),
            crate::csrf::layer,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state,
            crate::runtime::http::layer,
        )))
}

/// The native methods of one path; HEAD and every other method go to Node.
fn method_router(methods: &[(Method, Native)]) -> MethodRouter<Shared> {
    let mut router = MethodRouter::new();
    for (method, native) in methods {
        let native = *native;
        let handler =
            move |State(state): State<Shared>,
                  ConnectInfo(peer): ConnectInfo<SocketAddr>,
                  req: Request| async move { Ctx::new(state, req).run(peer, native).await };
        router = match axum::routing::MethodFilter::try_from(method.clone()) {
            Ok(filter) => router.on(filter, handler),
            Err(_) => router,
        };
    }
    router.head(forward).fallback(forward)
}

/// Every route answered here, with the function that answers it.
const ROUTES: [(&str, Native); 74] = [
    ("/api/v1/status", status_native),
    ("/api/v1/status/appdata", status_appdata_native),
    ("/api/v1/settings/public", settings_public_native),
    ("/api/v1/auth/me", auth_me_native),
    ("/api/v1/settings/discover", settings_discover_native),
    ("/api/v1/user", user::list),
    ("/api/v1/user/{id}", user::detail),
    ("/api/v1/regions", tmdb::regions),
    ("/api/v1/languages", tmdb::languages),
    (
        "/api/v1/watchproviders/regions",
        tmdb::watch_provider_regions,
    ),
    ("/api/v1/watchproviders/movies", tmdb::movie_watch_providers),
    ("/api/v1/watchproviders/tv", tmdb::tv_watch_providers),
    ("/api/v1/settings/main", settings::main),
    ("/api/v1/settings/metadatas", settings::metadata),
    ("/api/v1/settings/notifications/webhook", settings::webhook),
    ("/api/v1/settings/trakt", settings::trakt),
    ("/api/v1/settings/simkl", settings::simkl),
    ("/api/v1/settings/anilist", settings::anilist),
    ("/api/v1/settings/mdblist", settings::mdblist),
    ("/api/v1/user/{id}/settings/main", usersettings::main),
    (
        "/api/v1/user/{id}/settings/password",
        usersettings::password,
    ),
    (
        "/api/v1/user/{id}/settings/notifications",
        usersettings::notifications,
    ),
    (
        "/api/v1/user/{id}/settings/permissions",
        usersettings::permissions,
    ),
    (
        "/api/v1/user/{id}/settings/discover",
        usersettings::discover,
    ),
    ("/api/v1/user/{id}/quota", quota::quota),
    ("/api/v1/overrideRule", blocklist::override_rules),
    ("/api/v1/blocklist", blocklist::list),
    ("/api/v1/media", media::list),
    ("/api/v1/request", request::list),
    ("/api/v1/request/count", request::count),
    ("/api/v1/request/{id}", request::detail),
    ("/api/v1/issue", issue::list),
    ("/api/v1/issue/count", issue::count),
    ("/api/v1/issue/{id}", issue::detail),
    ("/api/v1/user/{id}/requests", request::of_user),
    ("/api/v1/service/radarr", service::radarr),
    ("/api/v1/service/radarr/{id}", service::radarr_detail),
    ("/api/v1/service/sonarr", service::sonarr),
    ("/api/v1/service/sonarr/{id}", service::sonarr_detail),
    ("/api/v1/settings/about", settings::about),
    ("/api/v1/movie/{id}", movie::detail),
    ("/api/v1/movie/{id}/recommendations", movie::recommendations),
    ("/api/v1/movie/{id}/similar", movie::similar),
    ("/api/v1/movie/{id}/ratings", movie::rt_ratings),
    ("/api/v1/tv/{id}", tv::detail),
    ("/api/v1/tv/{id}/recommendations", tv::recommendations),
    ("/api/v1/tv/{id}/similar", tv::similar),
    ("/api/v1/tv/{id}/ratings", tv::rt_ratings),
    ("/api/v1/tv/{id}/season/{season}", tv::season),
    ("/api/v1/person/{id}", person::detail),
    (
        "/api/v1/person/{id}/combined_credits",
        person::combined_credits,
    ),
    ("/api/v1/collection/{id}", collection::detail),
    ("/api/v1/search", search::multi),
    ("/api/v1/search/keyword", search::keyword),
    ("/api/v1/search/company", search::company),
    ("/api/v1/discover/movies", discover::movies),
    ("/api/v1/discover/tv", discover::tv),
    (
        "/api/v1/discover/movies/upcoming",
        discover::movies_upcoming,
    ),
    ("/api/v1/discover/tv/upcoming", discover::tv_upcoming),
    (
        "/api/v1/discover/movies/language/{language}",
        discover::movies_language,
    ),
    (
        "/api/v1/discover/tv/language/{language}",
        discover::tv_language,
    ),
    ("/api/v1/discover/movies/genre/{id}", discover::movies_genre),
    ("/api/v1/discover/tv/genre/{id}", discover::tv_genre),
    (
        "/api/v1/discover/movies/studio/{id}",
        discover::movies_studio,
    ),
    ("/api/v1/discover/tv/network/{id}", discover::tv_network),
    ("/api/v1/discover/trending", discover::trending),
    (
        "/api/v1/discover/keyword/{id}/movies",
        discover::keyword_movies,
    ),
    (
        "/api/v1/discover/genreslider/movie",
        discover::genre_slider_movie,
    ),
    ("/api/v1/discover/genreslider/tv", discover::genre_slider_tv),
    ("/api/v1/user/{id}/watchlist", userextra::watchlist),
    (
        "/api/v1/user/{id}/pushSubscriptions",
        userextra::push_subscriptions,
    ),
    (
        "/api/v1/user/{id}/pushSubscription/{endpoint}",
        userextra::push_subscription,
    ),
    (
        "/api/v1/user/{id}/settings/linked-accounts/trakt",
        userextra::trakt,
    ),
    (
        "/api/v1/user/{id}/settings/linked-accounts/simkl",
        userextra::simkl,
    ),
];

/// Admin routes that return one section of settings.json as it is.
const SETTINGS_SECTIONS: [(&str, &str); 18] = [
    ("/api/v1/settings/network", "/network"),
    ("/api/v1/settings/plex/library", "/plex/libraries"),
    ("/api/v1/settings/jellyfin/library", "/jellyfin/libraries"),
    (
        "/api/v1/settings/servarr-interventions",
        "/servarrInterventions",
    ),
    ("/api/v1/settings/plex", "/plex"),
    ("/api/v1/settings/jellyfin", "/jellyfin"),
    ("/api/v1/settings/tautulli", "/tautulli"),
    ("/api/v1/settings/radarr", "/radarr"),
    ("/api/v1/settings/sonarr", "/sonarr"),
    (
        "/api/v1/settings/notifications/discord",
        "/notifications/agents/discord",
    ),
    (
        "/api/v1/settings/notifications/slack",
        "/notifications/agents/slack",
    ),
    (
        "/api/v1/settings/notifications/telegram",
        "/notifications/agents/telegram",
    ),
    (
        "/api/v1/settings/notifications/pushbullet",
        "/notifications/agents/pushbullet",
    ),
    (
        "/api/v1/settings/notifications/pushover",
        "/notifications/agents/pushover",
    ),
    (
        "/api/v1/settings/notifications/email",
        "/notifications/agents/email",
    ),
    (
        "/api/v1/settings/notifications/webpush",
        "/notifications/agents/webpush",
    ),
    (
        "/api/v1/settings/notifications/gotify",
        "/notifications/agents/gotify",
    ),
    (
        "/api/v1/settings/notifications/ntfy",
        "/notifications/agents/ntfy",
    ),
];

async fn forward(
    State(state): State<Shared>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response<Body> {
    let (mut head, body) = req.into_parts();
    expressroute::restore(&mut head);
    let req = HttpRequest::from_parts(head, body);
    if crate::standalone::enabled() {
        return crate::standalone::fallback::answer(&state, req).await;
    }
    state.node.forward(req, peer.ip()).await
}

/// `res.status(200).json(undefined)`: a JSON content type and no body.
pub(super) fn empty_json() -> Outcome {
    let mut res = Response::new(Body::empty());
    res.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static("application/json; charset=utf-8"),
    );
    res.headers_mut().insert(
        axum::http::header::CONTENT_LENGTH,
        axum::http::HeaderValue::from_static("0"),
    );
    Outcome::Done(res)
}

/// A native handler: all IO it needs is async, so it returns a boxed future.
pub(super) type Native =
    for<'a> fn(&'a Ready<'a>) -> Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// What a native handler decided.
pub(super) enum Outcome {
    /// Answered here.
    Done(Response<Body>),
    /// Not answered by the handler: in proxy mode Node answers it (the
    /// reason is logged); standalone mode gives the fallback's answer.
    Forward(Fallback),
}

impl Outcome {
    /// Hand the request on; standalone mode answers 500 (400 when the
    /// validator didn't vouch for the request) with `why` as the message.
    pub(super) fn forward(why: impl Into<Fallback>) -> Self {
        Self::Forward(why.into())
    }

    /// Hand the request on; standalone mode answers `status` with `why`
    /// as the message.
    pub(super) fn fail(status: u16, why: impl Into<String>) -> Self {
        Self::Forward(Fallback::status(status, why))
    }
}

/// Why a handler didn't answer, and what standalone mode answers instead.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Fallback {
    /// The reason: logged in proxy mode, the message in standalone mode.
    pub(super) why: String,
    answer: Answer,
}

#[derive(Debug, Clone, PartialEq)]
enum Answer {
    /// 400 when the validator didn't vouch for the request (its input is
    /// the odd part), else 500; `{"message": why}`.
    Auto,
    /// This status with `{"message": why}`.
    Status(u16),
    /// This status and body.
    Body(u16, Value),
}

impl Fallback {
    /// Standalone mode answers `status` with `why` as the message.
    pub(super) fn status(status: u16, why: impl Into<String>) -> Self {
        Self {
            why: why.into(),
            answer: Answer::Status(status),
        }
    }

    /// Standalone mode answers `status` with `body`.
    pub(super) fn body(status: u16, why: impl Into<String>, body: Value) -> Self {
        Self {
            why: why.into(),
            answer: Answer::Body(status, body),
        }
    }

    /// `isAuthenticated`'s 403.
    pub(super) fn forbidden(why: impl Into<String>) -> Self {
        Self::body(
            403,
            why,
            serde_json::json!({
                "status": 403,
                "error": "You do not have permission to access this endpoint",
            }),
        )
    }

    /// `isOwnProfile()` / `isOwnProfileOrAdmin()`'s 403.
    pub(super) fn not_own_profile() -> Self {
        Self::status(
            403,
            "You do not have permission to view this user's settings.",
        )
    }

    /// Standalone mode's answer for `head`.
    pub(super) fn respond(self, head: &Parts) -> Response<Body> {
        let unvouched = head.extensions.get::<crate::openapi::Validated>().is_none()
            || head.extensions.get::<crate::openapi::Unsure>().is_some();
        let (status, body) = match self.answer {
            Answer::Auto if unvouched => (400, None),
            Answer::Auto => (500, None),
            Answer::Status(status) => (status, None),
            Answer::Body(status, body) => (status, Some(body)),
        };
        if status >= 500 {
            tracing::warn!("{} {} failed: {}", head.method, head.uri.path(), self.why);
        }
        let body = body.unwrap_or_else(|| serde_json::json!({ "message": self.why }));
        respond::json_status(status, &head.method, &head.headers, &body)
    }
}

impl From<String> for Fallback {
    fn from(why: String) -> Self {
        Self {
            why,
            answer: Answer::Auto,
        }
    }
}

impl From<&str> for Fallback {
    fn from(why: &str) -> Self {
        Self::from(why.to_owned())
    }
}

impl From<&String> for Fallback {
    fn from(why: &String) -> Self {
        Self::from(why.clone())
    }
}

/// A request plus everything Node's `/api/v1` middleware would have
/// prepared for it. Only the head of the request is borrowed: the body
/// isn't `Sync`, and holding it across awaits would make handlers `!Send`.
pub(super) struct Ready<'a> {
    pub(super) state: &'a AppState,
    /// The same state, for work that outlives the request.
    pub(super) shared: Shared,
    pub(super) settings: Arc<Settings>,
    pub(super) user: Option<CurrentUser>,
    pub(super) req: &'a Parts,
    /// The JSON body of a write, as `express.json()` parsed it.
    pub(super) body: Option<Value>,
}

impl Ready<'_> {
    /// `isAuthenticated(required)`: the signed-in user, or its 403.
    pub(super) fn authenticated(&self, required: i64) -> Result<&CurrentUser, Fallback> {
        match &self.user {
            Some(user) if user.has_permission(required) => Ok(user),
            Some(_) => Err(Fallback::forbidden("the user lacks the permission")),
            None => Err(Fallback::forbidden("no user")),
        }
    }

    /// What the `OpenAPI` validator left in `req.query`, the path params
    /// and `req.body`; `None` when it didn't run (the gate is off, or the
    /// route isn't in the spec).
    pub(super) fn validated(&self) -> Option<&crate::openapi::Validated> {
        if self
            .req
            .extensions
            .get::<crate::openapi::Unsure>()
            .is_some()
        {
            return None;
        }
        self.req.extensions.get()
    }

    /// The validator passed the request ([`Ready::judged`]).
    pub(super) fn passed(&self) -> bool {
        self.judged().is_some()
    }

    /// The validator's pass, also when its only doubt is a value coerced
    /// to `±Infinity` (which [`Ready::validated`] hides), for checks that
    /// don't read the coerced values.
    pub(super) fn judged(&self) -> Option<&crate::openapi::Validated> {
        self.validated().or_else(|| {
            self.req.extensions.get::<crate::openapi::NonFiniteOnly>()?;
            self.req.extensions.get()
        })
    }

    /// `isAuthenticated(required)` answering its 403 here once the
    /// validator ran (it answers first); otherwise Node decides as before.
    pub(super) fn require(&self, required: i64) -> Result<&CurrentUser, Box<Outcome>> {
        match self.authenticated(required) {
            Ok(user) => Ok(user),
            Err(_) if self.judged().is_some() || crate::standalone::enabled() => {
                Err(Box::new(self.forbidden()))
            }
            Err(why) => Err(Box::new(Outcome::forward(why))),
        }
    }

    /// `isAuthenticated`'s answer:
    /// `{"status":403,"error":"You do not have permission to access this endpoint"}`.
    pub(super) fn forbidden(&self) -> Outcome {
        let mut body = Map::new();
        body.insert(String::from("status"), Value::from(403));
        body.insert(
            String::from("error"),
            Value::from("You do not have permission to access this endpoint"),
        );
        self.json_with(403, &Value::Object(body))
    }

    /// The `OpenAPI` validator's security check: a `connect.sid` cookie or an
    /// `X-API-Key` header has to be present, valid or not. Routes without
    /// `isAuthenticated` run for any request that passes it.
    pub(super) fn credential_present(&self) -> Result<(), Fallback> {
        let has_cookie = self
            .req
            .headers
            .get_all(axum::http::header::COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|h| h.split(';'))
            .any(|pair| {
                pair.split_once('=')
                    .is_some_and(|(k, _)| k.trim() == "connect.sid")
            });
        if has_cookie || self.req.headers.contains_key("x-api-key") {
            Ok(())
        } else {
            Err(Fallback::status(401, "no credential"))
        }
    }

    pub(super) fn json(&self, value: &Value) -> Outcome {
        Outcome::Done(respond::json(&self.req.method, &self.req.headers, value))
    }

    /// An error as Node's handler formats it: `{"message": ...}`.
    pub(super) fn error(&self, status: u16, message: &str) -> Outcome {
        let mut body = Map::new();
        body.insert(String::from("message"), Value::from(message));
        Outcome::Done(respond::json_status(
            status,
            &self.req.method,
            &self.req.headers,
            &Value::Object(body),
        ))
    }

    /// The path segment `depth` places from the end as an integer id (a
    /// 400 when it isn't one).
    pub(super) fn path_id(&self, depth: usize) -> Result<i64, Fallback> {
        params::path_int(self, depth)
    }

    /// `res.status(204).send()`: no body, no content headers.
    pub(super) fn no_content() -> Outcome {
        let mut res = Response::new(Body::empty());
        *res.status_mut() = axum::http::StatusCode::NO_CONTENT;
        Outcome::Done(res)
    }

    /// Save a changed settings document (the whole merged document, as
    /// `getSettings().save()` writes it) and have Node read it again.
    ///
    /// # Errors
    ///
    /// Fails when the file can't be written; a Node that can't be told is
    /// only logged, as it may still be starting.
    pub(super) async fn save_settings(&self, data: &Value) -> anyhow::Result<()> {
        self.state
            .settings
            .save_from(self.settings.data(), data)
            .await?;
        if crate::standalone::enabled() {
            // No Node to tell; the settings store reloads the file itself.
            return Ok(());
        }
        let url = format!(
            "{}/internal/settings/reload",
            self.state.env.node_url.trim_end_matches('/')
        );
        let sent = self
            .state
            .internal
            .post(url)
            .header("X-API-Key", self.settings.api_key())
            .send()
            .await;
        match sent {
            Ok(res) if res.status().is_success() => {}
            Ok(res) => tracing::warn!("Node refused to reload settings: {}", res.status()),
            Err(e) => tracing::warn!("Node could not be told to reload settings: {e:#}"),
        }
        Ok(())
    }

    /// A JSON answer with any status.
    pub(super) fn json_with(&self, status: u16, value: &Value) -> Outcome {
        Outcome::Done(respond::json_status(
            status,
            &self.req.method,
            &self.req.headers,
            value,
        ))
    }

    /// Node validates query strings against the `OpenAPI` spec and rejects
    /// unknown parameters, so a route without parameters only answers bare
    /// requests here.
    ///
    /// Once the validator ran it has refused every parameter the spec
    /// doesn't declare, so a query it left empty (`?&&`) is a bare request.
    pub(super) fn no_query(&self) -> Result<(), Fallback> {
        match self.req.uri.query() {
            None | Some("") => Ok(()),
            Some(_) if self.judged().is_some_and(|v| v.query.is_empty()) => Ok(()),
            Some(_) => Err(Fallback::from("the query string could not be validated")),
        }
    }

    /// `req.path` in the router Node mounts at `mount`.
    pub(super) fn path_below(&self, mount: &str) -> String {
        expressroute::path_below(self.req, mount)
    }
}

struct Ctx {
    state: Shared,
    head: Parts,
    body: Body,
}

impl Ctx {
    fn new(state: Shared, req: Request) -> Self {
        let (head, body) = req.into_parts();
        Self { state, head, body }
    }

    async fn run(self, peer: SocketAddr, native: Native) -> Response<Body> {
        let Self { state, head, body } = self;
        let (body, parsed) = if head.method == Method::GET {
            (body, Ok(None))
        } else {
            match read_body(&head, body).await {
                Ok((bytes, parsed)) => (Body::from(bytes), parsed),
                Err(response) => return response,
            }
        };
        // Once the validator passed the request, `req.body` is what it
        // left there (defaults applied, form bodies parsed).
        let sure = head.extensions.get::<crate::openapi::Unsure>().is_none();
        let parsed = match head.extensions.get::<crate::openapi::Validated>() {
            Some(validated) if sure && head.method != Method::GET => Ok(validated.body.clone()),
            Some(_) | None => parsed,
        };
        let outcome = match (prepare(&state, &head).await, parsed) {
            (Ok(mut ready), Ok(parsed)) => {
                ready.body = parsed;
                native(&ready).await
            }
            (Err(why), _) | (_, Err(why)) => Outcome::forward(why),
        };
        match outcome {
            Outcome::Done(res) => res,
            Outcome::Forward(fallback) => {
                if crate::standalone::enabled() {
                    return fallback.respond(&head);
                }
                let mut head = head;
                expressroute::restore(&mut head);
                tracing::debug!(
                    "{} {} goes to Node: {}",
                    head.method,
                    head.uri,
                    fallback.why
                );
                let req = HttpRequest::from_parts(head, body);
                state.node.forward(req, peer.ip()).await
            }
        }
    }
}

/// `express.json()`'s default limit.
const BODY_LIMIT: usize = 100 * 1024;

/// Buffer a write's body (so it can still be forwarded) and parse it as
/// `express.json()` would; anything it would refuse or skip is Node's.
async fn read_body(
    head: &Parts,
    body: Body,
) -> Result<(bytes::Bytes, Result<Option<Value>, Fallback>), Response<Body>> {
    let bytes = crate::openapi::request::buffer(body)
        .await
        .map_err(|unbuffered| unbuffered.response(&head.method, &head.headers))?;
    let content_type = head
        .headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let json_type = content_type
        .split(';')
        .next()
        .is_some_and(|t| t.trim().eq_ignore_ascii_case("application/json"));
    // express.json() leaves `req.body` undefined for a body it doesn't
    // read, and makes an empty JSON body `{}`.
    let parsed = if bytes.is_empty() {
        Ok(json_type.then(|| Value::Object(Map::new())))
    } else if !json_type {
        Err(Fallback::from("a body that isn't JSON"))
    } else if bytes.len() > BODY_LIMIT {
        Err(Fallback::status(413, "The request body is too large."))
    } else {
        let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
        match serde_json::from_slice(bytes) {
            Ok(v @ (Value::Object(_) | Value::Array(_))) => Ok(Some(v)),
            Ok(_) => Err(Fallback::status(
                400,
                "Invalid JSON body: expected an object or an array",
            )),
            Err(e) => Err(Fallback::status(400, format!("Invalid JSON body: {e}"))),
        }
    };
    Ok((bytes, parsed))
}

/// Everything that happens before a Node route runs, or why it can't be
/// reproduced here.
async fn prepare<'a>(shared: &'a Shared, head: &'a Parts) -> Result<Ready<'a>, Fallback> {
    let state: &AppState = shared;
    if !state.env.native_routes() {
        return Err(Fallback::status(
            500,
            "plugin and desktop modes are not ported",
        ));
    }
    if !state.node.is_ready() {
        return Err(Fallback::status(503, "The server is still starting."));
    }
    let settings = state
        .settings
        .current()
        .await
        .map_err(|e| Fallback::status(500, format!("settings.json is unreadable: {e:#}")))?;
    let headers = crate::runtime::desktop::session_headers(head);
    let user = match check_user(&state.db, &settings, &headers)
        .await
        .map_err(|e| Fallback::status(500, format!("looking up the user failed: {e:#}")))?
    {
        Identity::Anonymous => None,
        Identity::User(user) => Some(user),
        Identity::Unportable(why) => return Err(Fallback::status(400, why)),
    };
    Ok(Ready {
        state,
        shared: Arc::clone(shared),
        settings,
        user,
        req: head,
        body: None,
    })
}

/// `GET /status`, including the update check against GitHub.
fn status_native<'a>(ctx: &'a Ready<'a>) -> Pin<Box<dyn Future<Output = Outcome> + Send + 'a>> {
    Box::pin(async move {
        let check_update = match (ctx.validated(), ctx.req.uri.query().unwrap_or("")) {
            (Some(validated), _) => validated.query.get("checkUpdateAvailable").map_or_else(
                || truthy(ctx.settings.get("/main/versionCheck")),
                |v| truthy(Some(v)),
            ),
            (None, "") => truthy(ctx.settings.get("/main/versionCheck")),
            (None, "checkUpdateAvailable=true") => true,
            (None, "checkUpdateAvailable=false") => false,
            (None, _) => {
                return Outcome::forward(String::from("query string needs the OpenAPI validator"))
            }
        };
        let version = &ctx.state.version;
        let mut body = Map::new();
        body.insert(
            String::from("version"),
            Value::from(version.version.as_str()),
        );
        body.insert(
            String::from("commitTag"),
            Value::from(version.commit_tag.as_str()),
        );
        if check_update {
            let update = match update_check(ctx).await {
                Ok(update) => update,
                Err(why) => return Outcome::forward(why),
            };
            body.insert(
                String::from("updateAvailable"),
                Value::Bool(update.available),
            );
            body.insert(
                String::from("commitsBehind"),
                Value::from(update.commits_behind),
            );
        }
        body.insert(
            String::from("restartRequired"),
            Value::Bool(ctx.state.restart_required(&ctx.settings)),
        );
        crate::runtime::desktop::status_fields(&mut body);
        ctx.json(&Value::Object(body))
    })
}

struct UpdateCheck {
    available: bool,
    commits_behind: i64,
}

/// The update check as `/status` does it: commits behind `develop` for
/// development builds, otherwise whether the latest release names this
/// version. Shapes Node would trip over are handed back to it.
async fn update_check(ctx: &Ready<'_>) -> Result<UpdateCheck, String> {
    let version = &ctx.state.version;
    let mut update = UpdateCheck {
        available: false,
        commits_behind: 0,
    };
    if version.commit_tag == "local" {
        return Ok(update);
    }
    if version.version.starts_with("develop-") {
        let commits = ctx.state.github.commits().await;
        if commits.is_empty() {
            return Ok(update);
        }
        let mut shas = Vec::with_capacity(commits.len());
        for commit in &commits {
            let sha = commit.get("sha").and_then(Value::as_str);
            let message = commit.pointer("/commit/message").and_then(Value::as_str);
            match (sha, message) {
                (Some(sha), Some(message)) => {
                    if !message.contains("[skip ci]") {
                        shas.push(sha);
                    }
                }
                _ => return Err(String::from("a GitHub commit lacks sha or message")),
            }
        }
        let Some(newest) = shas.first() else {
            return Err(String::from("every GitHub commit is [skip ci]"));
        };
        if *newest != version.commit_tag {
            update.available = true;
            update.commits_behind = shas
                .iter()
                .position(|sha| *sha == version.commit_tag)
                .and_then(|i| i64::try_from(i).ok())
                .unwrap_or(-1);
        }
    } else {
        let releases = ctx.state.github.releases().await;
        if let Some(latest) = releases.first() {
            let Some(name) = latest.get("name").and_then(Value::as_str) else {
                return Err(String::from("the latest GitHub release has no name"));
            };
            if !name.contains(&version.version) {
                update.available = true;
            }
        }
    }
    Ok(update)
}

/// `GET /status/appdata`: whether the config directory is a mounted volume
/// (no `DOCKER` marker file) and reachable.
fn status_appdata_native<'a>(
    ctx: &'a Ready<'a>,
) -> Pin<Box<dyn Future<Output = Outcome> + Send + 'a>> {
    Box::pin(async move {
        if let Err(why) = ctx.no_query() {
            return Outcome::forward(why);
        }
        let config = &ctx.state.env.config_dir;
        let mut body = Map::new();
        body.insert(
            String::from("appData"),
            Value::Bool(!config.join("DOCKER").exists()),
        );
        body.insert(
            String::from("appDataPath"),
            Value::from(config.to_string_lossy().into_owned()),
        );
        body.insert(
            String::from("appDataPermissions"),
            Value::Bool(std::fs::metadata(config).is_ok()),
        );
        ctx.json(&Value::Object(body))
    })
}

/// `GET /settings/public`.
fn settings_public_native<'a>(
    ctx: &'a Ready<'a>,
) -> Pin<Box<dyn Future<Output = Outcome> + Send + 'a>> {
    Box::pin(async move {
        if let Err(why) = ctx.no_query() {
            return Outcome::forward(why);
        }
        let mut body = full_public_settings(&ctx.settings, ctx.state.env.plugin_mode);
        if ctx.user.as_ref().is_some_and(|u| !u.webpush_enabled) {
            body.insert(String::from("enablePushRegistration"), Value::Bool(false));
        }
        ctx.json(&Value::Object(body))
    })
}

/// `GET /auth/me`. Without a user Node answers 401 or 403 itself; with
/// `userEmailRequired` on, an address `validator.isEmail` refuses adds the
/// `userEmailRequired` warning.
fn auth_me_native<'a>(ctx: &'a Ready<'a>) -> Pin<Box<dyn Future<Output = Outcome> + Send + 'a>> {
    Box::pin(async move {
        if let Err(why) = ctx.no_query() {
            return Outcome::forward(why);
        }
        let user = match ctx.require(0) {
            Ok(user) => user,
            Err(answer) => return *answer,
        };
        let profile = match ctx.state.db.user_profile(user.id).await {
            Ok(Some(profile)) => profile,
            Ok(None) => return Outcome::forward(String::from("the user vanished")),
            Err(e) => return Outcome::forward(format!("loading the user failed: {e:#}")),
        };
        let email_required = truthy(
            ctx.settings
                .get("/notifications/agents/email/options/userEmailRequired"),
        );
        let warn = match (&profile.email, email_required) {
            (_, false) => false,
            (Some(email), true) => !crate::isemail::is_email(&email.to_lowercase()),
            // `validator.isEmail(undefined)` throws.
            (None, true) => return Outcome::forward(String::from("a user without an email")),
        };
        match crate::user::public_json(&profile) {
            Ok(mut body) => {
                if warn {
                    if let Some(Value::Array(warnings)) = body.get_mut("warnings") {
                        warnings.push(Value::from("userEmailRequired"));
                    }
                }
                ctx.json(&body)
            }
            Err(why) => Outcome::forward(why.to_owned()),
        }
    })
}

/// `GET /settings/discover`: every slider that isn't retired, in order.
fn settings_discover_native<'a>(
    ctx: &'a Ready<'a>,
) -> Pin<Box<dyn Future<Output = Outcome> + Send + 'a>> {
    Box::pin(async move {
        if let Err(why) = ctx.no_query() {
            return Outcome::forward(why);
        }
        if let Err(answer) = ctx.require(0) {
            return *answer;
        }
        let sliders = match ctx.state.db.discover_sliders().await {
            Ok(sliders) => sliders,
            Err(e) => return Outcome::forward(format!("loading sliders failed: {e:#}")),
        };
        let body: Vec<Value> = sliders
            .iter()
            .filter(|s| !crate::discover::is_retired(s.slider_type))
            .map(crate::discover::response)
            .collect();
        ctx.json(&Value::Array(body))
    })
}
