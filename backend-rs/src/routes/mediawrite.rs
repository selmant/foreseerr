//! `server/routes/media.ts` beyond the list.
//!
//! Deleting a media item or its files, setting its status by hand, and
//! Tautulli watch data. Status changes go through `mediasave`, which
//! reproduces `MediaSubscriber` (request approval and completion,
//! availability notifications).

use std::future::Future;
use std::pin::Pin;

use axum::http::Method;
use serde_json::{Map, Value};

use super::arrcall::{ArrError, ArrServer};
use super::mediasave::{self, MediaEdit, M_AVAILABLE, M_DELETED, M_PARTIAL};
use super::{Outcome, Ready, Table, ADMIN};
use crate::db::{Bind, Db, MediaRow};
use crate::downloads::Downloads;
use crate::jobs::syncutil::Tx;
use crate::media::{js_string, tracks_downloads};
use crate::settings::public::truthy;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// `Permission.MANAGE_REQUESTS`.
pub(super) const MANAGE_REQUESTS: i64 = 16;
/// `MediaStatus.UNKNOWN`, `PENDING`, `PROCESSING`, `BLOCKLISTED`.
const M_UNKNOWN: i64 = 1;
const M_PENDING: i64 = 2;
const M_PROCESSING: i64 = 3;
const M_BLOCKLISTED: i64 = 6;

/// This module's routes.
pub(super) const ROUTES: &Table = &[
    ("/api/v1/media/{id}", Method::DELETE, delete_media),
    ("/api/v1/media/{id}/{status}", Method::POST, set_status),
    ("/api/v1/media/{id}/file", Method::DELETE, delete_file),
    ("/api/v1/media/{id}/watch_data", Method::GET, watch_data),
];

macro_rules! try_forward {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(why) => return Outcome::forward(why),
        }
    };
}

/// One media row with its seasons.
pub(super) async fn load_media(ctx: &Ready<'_>, id: i64) -> Result<Option<MediaRow>, String> {
    ctx.state
        .db
        .media_by_ids(&[id], true)
        .await
        .map(|mut rows| rows.pop())
        .map_err(|e| format!("loading media {id} failed: {e:#}"))
}

/// `DELETE /media/{id}`: a blocklisted item only loses its service data;
/// anything else is removed with its seasons. A missing one is a 204 too.
fn delete_media<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        try_forward!(ctx.authenticated(MANAGE_REQUESTS));
        let id = try_forward!(ctx.path_id(0));
        let Some(media) = try_forward!(load_media(ctx, id).await) else {
            return Ready::no_content();
        };
        let result = if media.status == M_BLOCKLISTED {
            let mut edit = MediaEdit::new(media);
            mediasave::reset_service_data(&mut edit.after, None);
            mediasave::save(&mediasave::lc_of(ctx), &mut edit).await
        } else {
            remove_media(&ctx.state.db, id).await
        };
        match result {
            Ok(()) => Ready::no_content(),
            Err(e) => {
                tracing::error!("Something went wrong deleting media {id}: {e:#}");
                ctx.error(500, "Failed to delete media")
            }
        }
    })
}

/// `mediaRepository.remove(media)`: the eager seasons (cascade) first, in
/// one transaction.
async fn remove_media(db: &Db, id: i64) -> anyhow::Result<()> {
    let mut tx = Tx::begin(db).await?;
    tx.execute(
        r#"DELETE FROM "season" WHERE "mediaId" = ?1"#,
        &[Bind::Int(id)],
    )
    .await?;
    tx.execute(r#"DELETE FROM "media" WHERE "id" = ?1"#, &[Bind::Int(id)])
        .await?;
    tx.commit().await
}

/// The body of a status change: `is4k` as `String(is4k) === 'true'` reads
/// it (the validator only lets booleans through) and the season numbers
/// `available` marks on a series.
fn status_body(ctx: &Ready<'_>) -> Result<(bool, Option<Vec<i64>>), String> {
    let Some(Value::Object(body)) = &ctx.body else {
        return Err(String::from("a body that isn't an object"));
    };
    let is4k = match body.get("is4k") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err(String::from("is4k isn't a boolean; the validator decides")),
    };
    let seasons = match body.get("seasons") {
        None | Some(Value::Null) => Some(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| item.get("seasonNumber").and_then(Value::as_i64))
            .collect::<Option<Vec<i64>>>(),
        Some(_) => None,
    };
    Ok((is4k, seasons))
}

/// `POST /media/{id}/{status}`.
fn set_status<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        try_forward!(ctx.authenticated(MANAGE_REQUESTS));
        let status = ctx.req.uri.path().rsplit('/').next().unwrap_or("");
        let target = match status {
            "available" => Some(M_AVAILABLE),
            "partial" => Some(M_PARTIAL),
            "processing" => Some(M_PROCESSING),
            "pending" => Some(M_PENDING),
            "unknown" => Some(M_UNKNOWN),
            "deleted" => None,
            _ => return Outcome::forward(String::from("the validator rejects other statuses")),
        };
        let id = try_forward!(ctx.path_id(1));
        let (is4k, seasons) = try_forward!(status_body(ctx));
        let Some(media) = try_forward!(load_media(ctx, id).await) else {
            return ctx.error(404, "Media does not exist.");
        };
        if status == "partial" && media.media_type == "movie" {
            return ctx.error(400, "Only series can be set to be partially available");
        }
        let mut edit = MediaEdit::new(media);
        if let Some(target) = target {
            if is4k {
                edit.after.status4k = target;
            } else {
                edit.after.status = target;
            }
        }
        if status == "available" && edit.after.media_type == "tv" {
            let Some(numbers) = seasons else {
                return Outcome::forward(String::from("seasons is not a list of numbered seasons"));
            };
            for number in numbers {
                edit.set_season_status(number, is4k, M_AVAILABLE);
            }
        }
        let downloads = try_forward!(downloads_for(ctx, &edit.before).await);
        if let Err(e) = mediasave::save(&mediasave::lc_of(ctx), &mut edit).await {
            tracing::error!("Saving media {id} failed: {e:#}");
            return ctx.error(500, &format!("{e:#}"));
        }
        ctx.json(&mediasave::saved_json(&edit, &ctx.settings, &downloads))
    })
}

/// The download tracker's items when the row's `@AfterLoad` reads them.
pub(super) async fn downloads_for(ctx: &Ready<'_>, media: &MediaRow) -> Result<Downloads, String> {
    if !tracks_downloads(media) {
        return Ok(Downloads::default());
    }
    Downloads::fetch(
        &ctx.state.internal,
        &ctx.state.env.node_url,
        ctx.settings.api_key(),
    )
    .await
    .map_err(|e| format!("reading the download tracker failed: {e:#}"))
}

/// The `is4k` query of `DELETE /media/{id}/file`, as the validator lets it
/// through.
fn is4k_query(raw: Option<&str>) -> Result<bool, String> {
    match raw.unwrap_or("") {
        "" | "is4k=false" => Ok(false),
        "is4k=true" => Ok(true),
        _ => Err(String::from("a query the validator has to judge")),
    }
}

/// The Radarr or Sonarr server a media item's files are deleted from: the
/// default for the quality, or the item's own server when it names
/// another one.
fn file_server(
    settings: &crate::settings::Settings,
    media: &MediaRow,
    is4k: bool,
) -> Option<Value> {
    let section = if media.media_type == "movie" {
        "/radarr"
    } else {
        "/sonarr"
    };
    let servers = settings.get(section).and_then(Value::as_array)?;
    let mut server = servers
        .iter()
        .find(|s| truthy(s.get("isDefault")) && s.get("is4k") == Some(&Value::Bool(is4k)));
    let specific = if is4k {
        media.service_id4k
    } else {
        media.service_id
    };
    if let Some(specific) = specific.filter(|id| *id > 0) {
        if server.and_then(|s| s.get("id")).and_then(Value::as_i64) != Some(specific) {
            server = servers
                .iter()
                .find(|s| s.get("id").and_then(Value::as_i64) == Some(specific));
        }
    }
    server.cloned()
}

/// `network.apiRequestTimeout` as axios reads it.
pub(super) fn timeout_ms(settings: &crate::settings::Settings) -> u64 {
    settings
        .get("/network/apiRequestTimeout")
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

/// `removeMovie` / `removeSeries`: look the title up by its external id
/// and delete it with its files; one Arr no longer has is fine.
async fn remove_from_arr(arr: &ArrServer<'_>, lookup: &str, kind: &str) -> Result<(), ArrError> {
    let found = arr
        .get(&format!("/{kind}/lookup"), &[("term", lookup.to_owned())])
        .await?;
    let Some(first) = found.get(0).filter(|v| !v.is_null()) else {
        return Err(ArrError::Plain(String::from("not found"), false));
    };
    let Some(arr_id) = first.get("id").filter(|v| truthy(Some(v))) else {
        tracing::info!("[{}] Title not in library, nothing to remove", arr.api_name);
        return Ok(());
    };
    match arr
        .request(
            Method::DELETE,
            &format!("/{kind}/{}", js_string(Some(arr_id))),
            &[
                ("deleteFiles", String::from("true")),
                ("addImportExclusion", String::from("false")),
            ],
            None,
            arr.timeout_ms,
        )
        .await
    {
        Ok(_) | Err(ArrError::Http { status: 404, .. }) => Ok(()),
        Err(e) => Err(e),
    }
}

/// `DELETE /media/{id}/file`.
fn delete_file<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.authenticated(MANAGE_REQUESTS));
        let is4k = try_forward!(is4k_query(ctx.req.uri.query()));
        let id = try_forward!(ctx.path_id(1));
        let Some(media) = try_forward!(load_media(ctx, id).await) else {
            return ctx.error(404, "Media not found");
        };
        let movie = media.media_type == "movie";
        let Some(server) = file_server(&ctx.settings, &media, is4k) else {
            let name = format!(
                "{}{}",
                if is4k { "4K " } else { "" },
                if movie { "Radarr" } else { "Sonarr" }
            );
            tracing::info!("There is no default {name} server configured. Did you set any of your {name} servers as default?");
            return ctx.error(
                409,
                &format!("No {name} server configured to delete media files"),
            );
        };
        let arr = ArrServer {
            client: &ctx.state.outbound,
            server: &server,
            timeout_ms: timeout_ms(&ctx.settings),
            api_name: if movie { "Radarr" } else { "Sonarr" },
        };
        let mut edit = MediaEdit::new(media);
        let removed = if movie {
            remove_from_arr(&arr, &format!("tmdb:{}", edit.after.tmdb_id), "movie")
                .await
                .map_err(|e| e.message())
        } else {
            remove_series(ctx, &arr, &mut edit, is4k).await
        };
        if let Err(why) = removed {
            tracing::error!("Something went wrong deleting media file of {id}: {why}");
            return ctx.error(500, "Failed to delete media file");
        }
        if is4k {
            edit.after.status4k = M_DELETED;
        } else {
            edit.after.status = M_DELETED;
        }
        mediasave::reset_service_data(&mut edit.after, Some(is4k));
        if let Err(e) = mediasave::save(&mediasave::lc_of(ctx), &mut edit).await {
            tracing::error!("Something went wrong deleting media file of {id}: {e:#}");
            return ctx.error(500, "Failed to delete media file");
        }
        Ready::no_content()
    })
}

/// The series half of `DELETE /media/{id}/file`: TVDB id from TMDB (or
/// the row), Sonarr's copy removed, every season marked deleted.
async fn remove_series(
    ctx: &Ready<'_>,
    arr: &ArrServer<'_>,
    edit: &mut MediaEdit,
    is4k: bool,
) -> Result<(), String> {
    let locale = match ctx.settings.str("/main/locale") {
        "" => "en",
        other => other,
    };
    let series = ctx
        .state
        .tmdb
        .tv(edit.after.tmdb_id, locale)
        .await
        .map_err(|e| format!("{e:#}"))?;
    let tvdb = match series.pointer("/external_ids/tvdb_id") {
        None | Some(Value::Null) => edit.after.tvdb_id,
        Some(v) => v.as_i64(),
    };
    let Some(tvdb) = tvdb.filter(|t| *t != 0) else {
        return Err(String::from("TVDB ID not found"));
    };
    remove_from_arr(arr, &format!("tvdb:{tvdb}"), "series")
        .await
        .map_err(|e| e.message())?;
    for season in &mut edit.after.seasons {
        if is4k {
            season.status4k = M_DELETED;
        } else {
            season.status = M_DELETED;
        }
    }
    Ok(())
}

/// JavaScript's `value == n` for a Tautulli field.
fn loose_eq(value: Option<&Value>, n: f64) -> bool {
    match value {
        Some(Value::Number(v)) => v.as_f64() == Some(n),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                n == 0.0
            } else {
                t.parse::<f64>().ok() == Some(n)
            }
        }
        Some(Value::Bool(b)) => f64::from(u8::from(*b)) == n,
        None | Some(Value::Null | Value::Array(_) | Value::Object(_)) => false,
    }
}

/// One Tautulli `/api/v2` command's `response.data`.
async fn tautulli(ctx: &Ready<'_>, cmd: &str, rating_key: &str) -> Result<Value, String> {
    let t = |k: &str| js_string(ctx.settings.get(&format!("/tautulli/{k}"))).into_owned();
    let base = match ctx.settings.get("/tautulli/urlBase") {
        None | Some(Value::Null) => String::new(),
        other => js_string(other).into_owned(),
    };
    let scheme = if truthy(ctx.settings.get("/tautulli/useSsl")) {
        "https"
    } else {
        "http"
    };
    let mut url = format!("{scheme}://{}:{}{base}/api/v2", t("hostname"), t("port"));
    let mut params = Vec::new();
    match ctx.settings.get("/tautulli/apiKey") {
        None | Some(Value::Null) => {}
        other => params.push(("apikey", js_string(other).into_owned())),
    }
    params.push(("cmd", cmd.to_owned()));
    params.push(("rating_key", rating_key.to_owned()));
    params.push(("grouping", String::from("1")));
    for (i, (k, v)) in params.iter().enumerate() {
        url.push(if i == 0 { '?' } else { '&' });
        url.push_str(k);
        url.push('=');
        url.push_str(&crate::tmdb::axios_encode(v));
    }
    let response = ctx
        .state
        .outbound
        .get(&url)
        .header(reqwest::header::ACCEPT, "application/json, text/plain, */*")
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| crate::outbound::describe(&e))?;
    let data: Value = response
        .json()
        .await
        .map_err(|e| crate::outbound::describe(&e))?;
    data.pointer("/response/data")
        .cloned()
        .map(crate::tmdb::js_numbers)
        .ok_or_else(|| String::from("no response.data"))
}

/// `data` or `data4k` of the watch data: plays over all time, a week and
/// a month, and the users Tautulli saw watching, by Plex id.
async fn watch_block(ctx: &Ready<'_>, rating_key: &str) -> Result<Result<Value, String>, String> {
    let stats = match tautulli(ctx, "get_item_watch_time_stats", rating_key).await {
        Ok(v) => v,
        Err(e) => return Ok(Err(e)),
    };
    let watchers = match tautulli(ctx, "get_item_user_stats", rating_key).await {
        Ok(v) => v,
        Err(e) => return Ok(Err(e)),
    };
    // `.map`/`.find` on something that isn't a list, or a property read on
    // a null item, throw inside the handler's try: a 500.
    let (Value::Array(stats), Value::Array(watchers)) = (stats, watchers) else {
        return Ok(Err(String::from(
            "Tautulli answered something other than lists",
        )));
    };
    if stats.iter().chain(watchers.iter()).any(Value::is_null) {
        return Ok(Err(String::from("a null item in Tautulli's list")));
    }
    let mut plex_ids: Vec<i64> = Vec::new();
    for w in &watchers {
        let Some(id) = w.get("user_id").and_then(Value::as_i64) else {
            return Err(String::from("a Tautulli user_id that isn't an integer"));
        };
        plex_ids.push(id);
    }
    if plex_ids.is_empty() {
        plex_ids.push(-1);
    }
    let list = plex_ids
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    let rows = ctx
        .state
        .db
        .rows(
            &format!(r#"SELECT CAST("user"."id" AS BIGINT) AS "id" FROM "user" "user" WHERE "user"."plexId" IN ({list})"#),
            &[],
        )
        .await
        .map_err(|e| format!("database: {e:#}"))?;
    let mut users = Vec::new();
    for row in rows {
        let Some(uid) = row.get("id").and_then(Value::as_i64) else {
            continue;
        };
        let Some((user, _)) = ctx
            .state
            .db
            .user_record(uid)
            .await
            .map_err(|e| format!("database: {e:#}"))?
        else {
            continue;
        };
        users.push(crate::user::filtered_json(&user, None, true).map_err(str::to_owned)?);
    }
    let plays = |days: f64| {
        stats
            .iter()
            .find(|s| loose_eq(s.get("query_days"), days))
            .and_then(|s| s.get("total_plays"))
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| Value::from(0))
    };
    let mut out = Map::new();
    out.insert(String::from("users"), Value::Array(users));
    out.insert(String::from("playCount"), plays(0.0));
    out.insert(String::from("playCount7Days"), plays(7.0));
    out.insert(String::from("playCount30Days"), plays(30.0));
    Ok(Ok(Value::Object(out)))
}

/// `GET /media/{id}/watch_data`: admins only.
fn watch_data<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        try_forward!(ctx.no_query());
        try_forward!(ctx.authenticated(ADMIN));
        if ["hostname", "port", "apiKey"]
            .iter()
            .any(|k| !truthy(ctx.settings.get(&format!("/tautulli/{k}"))))
        {
            return ctx.error(404, "Tautulli API not configured.");
        }
        let id = try_forward!(ctx.path_id(1));
        let Some(media) = try_forward!(load_media(ctx, id).await) else {
            return ctx.error(404, "Media does not exist.");
        };
        let mut out = Map::new();
        for (key, rating_key) in [("data", &media.rating_key), ("data4k", &media.rating_key4k)] {
            let Some(rating_key) = rating_key.as_deref().filter(|k| !k.is_empty()) else {
                continue;
            };
            match try_forward!(watch_block(ctx, rating_key).await) {
                Ok(block) => {
                    out.insert(key.to_owned(), block);
                }
                Err(why) => {
                    tracing::error!("Something went wrong fetching media watch data: {why}");
                    return ctx.error(500, "Failed to fetch watch data.");
                }
            }
        }
        ctx.json(&Value::Object(out))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dbtx::scratch::{self, ints, PENDING_SEASON_ONE};
    use serde_json::json;

    #[test]
    fn helpers() {
        assert_eq!(is4k_query(None), Ok(false), "no query");
        assert_eq!(is4k_query(Some("is4k=true")), Ok(true), "4k");
        assert!(is4k_query(Some("is4k=1")).is_err(), "not a boolean");
        assert!(loose_eq(Some(&json!("7")), 7.0), "string 7 == 7");
        assert!(loose_eq(Some(&json!("")), 0.0), "'' == 0");
        assert!(!loose_eq(Some(&Value::Null), 0.0), "null != 0");
        assert!(loose_eq(Some(&json!(30)), 30.0), "number");
        let settings = crate::settings::Settings::from_file_value(
            json!({"sonarr": [
                {"id": 0, "isDefault": true, "is4k": false},
                {"id": 2, "isDefault": false, "is4k": false}
            ]}),
            None,
        );
        let Ok(settings) = settings else {
            return;
        };
        let media = MediaRow {
            media_type: String::from("tv"),
            service_id: Some(2),
            ..MediaRow::default()
        };
        assert_eq!(
            file_server(&settings, &media, false).and_then(|s| s.get("id").cloned()),
            Some(json!(2)),
            "the item's own server"
        );
        let on_default = MediaRow {
            media_type: String::from("tv"),
            service_id: Some(0),
            ..MediaRow::default()
        };
        assert_eq!(
            file_server(&settings, &on_default, false).and_then(|s| s.get("id").cloned()),
            Some(json!(0)),
            "server 0 is falsy, so the default stays"
        );
    }

    #[tokio::test]
    async fn a_failed_media_delete_keeps_its_seasons() -> anyhow::Result<()> {
        let scratch = scratch::sqlite("mediawrite").await?;
        let db = &scratch.db;
        scratch::run(db, &PENDING_SEASON_ONE).await?;
        scratch::run(
            db,
            &[r#"CREATE TRIGGER "refuse_media" BEFORE DELETE ON "media" BEGIN SELECT RAISE(ABORT, 'media delete refused'); END"#],
        )
        .await?;
        assert!(remove_media(db, 1).await.is_err(), "the media delete fails");
        let seasons = r#"SELECT "seasonNumber" FROM "season" WHERE "mediaId" = 1"#;
        assert_eq!(
            ints(db, seasons).await?,
            [1],
            "the season delete rolled back"
        );

        scratch::run(db, &[r#"DROP TRIGGER "refuse_media""#]).await?;
        remove_media(db, 1).await?;
        assert!(ints(db, seasons).await?.is_empty(), "removed together");
        Ok(())
    }
}
