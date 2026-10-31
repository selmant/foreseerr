//! `server/routes/mediaServarr.ts`, second half: manual import of
//! completed downloads Radarr or Sonarr flagged with a warning, and the
//! status of the import command (which resolves a linked intervention).

use axum::http::Method;
use serde_json::{Map, Value};

use super::arrcall::{ArrError, ArrServer};
use super::interventions;
use super::mediaservarr::{
    answer, body, body_flag, body_text, chain, or_empty_list, put, query, query_is4k, redeem,
    resolve, Context, Fail, Native, Step,
};
use super::mediawrite::MANAGE_REQUESTS;
use super::servarrtokens;
use super::{Outcome, Ready};
use crate::media::js_string;
use crate::settings::public::truthy;

/// What a handler would throw on a shape it can't read; its exact text
/// is the JavaScript engine's, so this one only describes it.
fn shape_error(what: &str) -> Fail {
    Fail::Status(502, format!("Unexpected {what} from Servarr."))
}

/// `x?.toLowerCase()`: `Ok(None)` for null or undefined, `Err` where the
/// call would throw.
fn lower(v: Option<&Value>) -> Result<Option<String>, ()> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.to_lowercase())),
        Some(_) => Err(()),
    }
}

/// `isInteractiveImportQueueItem(item)`; `None` where it would throw.
fn interactive(item: &Value) -> Option<bool> {
    if item.is_null() {
        return None;
    }
    if lower(item.get("status")).ok()?.as_deref() != Some("completed") {
        return Some(false);
    }
    if lower(item.get("trackedDownloadStatus")).ok()?.as_deref() != Some("warning") {
        return Some(false);
    }
    Some(truthy(item.get("downloadId")) && truthy(item.get("outputPath")))
}

/// `importSourceFor(item)`. A Sonarr 5 download of several seasons is
/// marked `multiSeason`: Sonarr won't import it automatically, and its
/// files are imported only to episodes the user picked.
fn source_for(item: &Value) -> Value {
    let mut out = Map::new();
    out.insert(String::from("kind"), Value::from("queue"));
    put(&mut out, "label", item.get("title").cloned());
    put(&mut out, "folder", item.get("outputPath").cloned());
    put(&mut out, "downloadId", item.get("downloadId").cloned());
    if crate::sonarrv5::queue_item_multi_season(item) {
        out.insert(String::from("multiSeason"), Value::Bool(true));
    }
    Value::Object(out)
}

/// Sonarr's and Radarr's `FileExtensions.DangerousExtensions`.
const DANGEROUS_EXTENSIONS: &[&str] = &["arj", "lnk", "lzh", "ps1", "scr", "vbs", "zipx"];
/// Sonarr's and Radarr's `FileExtensions.ExecutableExtensions`.
const EXECUTABLE_EXTENSIONS: &[&str] = &["bat", "cmd", "exe", "sh"];
/// The rejection codes (Sonarr 5) of the two.
const DANGEROUS_FILE: &str = "dangerousFile";
const EXECUTABLE_FILE: &str = "executableFile";

/// The extension of the last segment of a path, lower-cased, without the
/// dot (`Path.GetExtension`, for `/` and `\` separators alike).
fn extension(path: &str) -> Option<String> {
    let name = path.rsplit(['/', '\\']).next()?;
    name.rsplit_once('.').map(|(_, ext)| ext.to_lowercase())
}

/// Why a candidate must never be imported, even with its warnings
/// acknowledged: a file the Arr calls potentially dangerous or executable
/// (typed as `dangerousFile`/`executableFile` on Sonarr 5, by the message
/// both Sonarr 4 and 5 give otherwise), or one whose own extension is on
/// those lists.
fn unsafe_kind(candidate: &Value) -> Option<&'static str> {
    let rejections = candidate.get("rejections").and_then(Value::as_array);
    for rejection in rejections.into_iter().flatten() {
        let code = rejection.get("code").and_then(Value::as_str);
        let text = rejection
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("");
        if code == Some(DANGEROUS_FILE) || text.starts_with("Caution: Found potentially dangerous")
        {
            return Some(DANGEROUS_FILE);
        }
        if code == Some(EXECUTABLE_FILE) || text.starts_with("Caution: Found executable") {
            return Some(EXECUTABLE_FILE);
        }
    }
    for key in ["path", "relativePath"] {
        let Some(ext) = candidate
            .get(key)
            .and_then(Value::as_str)
            .and_then(extension)
        else {
            continue;
        };
        if DANGEROUS_EXTENSIONS.contains(&ext.as_str()) {
            return Some(DANGEROUS_FILE);
        }
        if EXECUTABLE_EXTENSIONS.contains(&ext.as_str()) {
            return Some(EXECUTABLE_FILE);
        }
    }
    None
}

/// Whether a candidate comes from a multi-season download (or Sonarr says
/// so of the file itself), so it may only be imported to the episodes the
/// user picked for it.
fn multi_season(candidate: &Value, source: &Value) -> bool {
    truthy(source.get("multiSeason"))
        || candidate
            .get("rejections")
            .and_then(Value::as_array)
            .is_some_and(|list| {
                list.iter().any(|r| {
                    r.get("code").and_then(Value::as_str) == Some(crate::sonarrv5::MULTI_SEASON)
                })
            })
}

/// `getImportQueue(context)`: the queue details of the mapped title.
async fn import_queue(c: &Context, arr: &ArrServer<'_>) -> Result<Value, ArrError> {
    let key = if c.radarr { "movieId" } else { "seriesId" };
    arr.get("/queue/details", &[(key, c.external_id.to_string())])
        .await
}

/// The first 20 downloads awaiting manual import, for the read routes.
async fn current_sources(c: &Context, arr: &ArrServer<'_>) -> Step<Vec<Value>> {
    let queue = import_queue(c, arr).await?;
    let Value::Array(list) = &queue else {
        return Err(shape_error("queue details"));
    };
    let mut sources = Vec::new();
    for item in list {
        match interactive(item) {
            Some(true) => sources.push(source_for(item)),
            Some(false) => {}
            None => return Err(shape_error("queue item")),
        }
    }
    sources.truncate(20);
    Ok(sources)
}

/// `assertCurrentImportSource`: the download must still be in the queue
/// and still need manual import.
async fn assert_current(c: &Context, arr: &ArrServer<'_>, source: &Value) -> Step<()> {
    let queue = import_queue(c, arr).await?;
    let list = queue
        .as_array()
        .ok_or_else(|| shape_error("queue details"))?;
    let mut current = None;
    for item in list {
        if item.is_null() {
            return Err(shape_error("queue item"));
        }
        if item.get("downloadId") == source.get("downloadId")
            && item.get("outputPath") == source.get("folder")
        {
            current = Some(item);
            break;
        }
    }
    let gone = || {
        Fail::Status(
            409,
            String::from("This download no longer requires manual import. Refresh and try again."),
        )
    };
    let current = current.ok_or_else(gone)?;
    match interactive(current) {
        Some(true) => Ok(()),
        Some(false) => Err(gone()),
        None => Err(shape_error("queue item")),
    }
}

/// `getManualImportCandidates({ folder, downloadId })`.
async fn candidates(arr: &ArrServer<'_>, source: &Value) -> Result<Value, ArrError> {
    let mut q = vec![("filterExistingFiles", String::from("true"))];
    for (param, key) in [("folder", "folder"), ("downloadId", "downloadId")] {
        if let Some(v) = source.get(key).filter(|v| truthy(Some(v))) {
            q.push((param, js_string(Some(v)).into_owned()));
        }
    }
    arr.get("/manualimport", &q).await
}

/// `x?.length` as a truthy check.
fn has_length(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::String(s)) => !s.is_empty(),
        _ => false,
    }
}

/// `isCompleteImportCandidate`. A rematched Sonarr 4 candidate names its
/// series by `seriesId` only.
fn complete(candidate: &Value, radarr: bool) -> bool {
    let has = |k: &str| truthy(candidate.get(k));
    if radarr {
        has("movie") && has("quality") && has_length(candidate.get("languages"))
    } else {
        (has("series") || has("seriesId"))
            && candidate.get("seasonNumber").is_some_and(|v| !v.is_null())
            && has_length(candidate.get("episodes"))
            && has("quality")
            && has_length(candidate.get("languages"))
    }
}

/// `candidateResponse`: the candidate's public fields with a token for it.
fn candidate_response(candidate: &Value, c: &Context, user_id: i64, source: &Value) -> Value {
    let mut stored = Map::new();
    stored.insert(String::from("candidate"), candidate.clone());
    stored.insert(String::from("source"), source.clone());
    let token = servarrtokens::issue(
        c.token(user_id, "import-candidate", Value::Object(stored)),
        900,
    );
    let names = |key: &str, keep_empty: bool| -> Value {
        match candidate.get(key) {
            Some(Value::Array(items)) => Value::Array(
                items
                    .iter()
                    .map(|i| i.get("name").cloned().unwrap_or(Value::Null))
                    .filter(|n| keep_empty || truthy(Some(n)))
                    .collect(),
            ),
            _ => Value::Array(Vec::new()),
        }
    };
    let mut out = Map::new();
    out.insert(String::from("token"), Value::from(token));
    put(&mut out, "source", source.get("label").cloned());
    for key in ["name", "relativePath", "folderName", "size"] {
        put(&mut out, key, candidate.get(key).cloned());
    }
    put(
        &mut out,
        "quality",
        chain(candidate, &["quality", "quality", "name"]),
    );
    out.insert(String::from("languages"), names("languages", false));
    put(
        &mut out,
        "releaseGroup",
        candidate.get("releaseGroup").cloned(),
    );
    out.insert(String::from("customFormats"), names("customFormats", true));
    put(
        &mut out,
        "customFormatScore",
        candidate.get("customFormatScore").cloned(),
    );
    out.insert(
        String::from("rejections"),
        or_empty_list(candidate.get("rejections")),
    );
    put(
        &mut out,
        "seasonNumber",
        candidate.get("seasonNumber").cloned(),
    );
    out.insert(
        String::from("episodes"),
        or_empty_list(candidate.get("episodes")),
    );
    out.insert(
        String::from("complete"),
        Value::Bool(complete(candidate, c.radarr)),
    );
    put(&mut out, "unsafe", unsafe_kind(candidate).map(Value::from));
    if !c.radarr && multi_season(candidate, source) {
        out.insert(String::from("multiSeason"), Value::Bool(true));
    }
    Value::Object(out)
}

/// Auth, the `is4k` query and the media id `depth` segments from the end.
fn read_route(ctx: &Ready<'_>, depth: usize) -> Result<(i64, i64, bool), super::Fallback> {
    let user = ctx.authenticated(MANAGE_REQUESTS)?.id;
    let q = query(ctx, &["is4k"])?;
    Ok((user, ctx.path_id(depth)?, query_is4k(&q)?))
}

/// Auth for a write without a query.
fn write_route(ctx: &Ready<'_>) -> Result<i64, super::Fallback> {
    ctx.no_query()?;
    Ok(ctx.authenticated(MANAGE_REQUESTS)?.id)
}

/// `GET /media/{id}/servarr/imports/sources`.
pub(super) fn sources<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let (user, id, is4k) = match read_route(ctx, 3) {
            Ok(v) => v,
            Err(why) => return Outcome::forward(why),
        };
        let result = async {
            let c = resolve(ctx, id, is4k).await?;
            let found = current_sources(&c, &c.arr(ctx)).await?;
            let list: Vec<Value> = found
                .into_iter()
                .map(|source| {
                    let mut out = Map::new();
                    put(&mut out, "kind", source.get("kind").cloned());
                    put(&mut out, "label", source.get("label").cloned());
                    let token = servarrtokens::issue(c.token(user, "import-source", source), 900);
                    let mut entry = Map::new();
                    entry.insert(String::from("token"), Value::from(token));
                    entry.extend(out);
                    Value::Object(entry)
                })
                .collect();
            let mut out = Map::new();
            put(&mut out, "nativeUrl", c.native_url.clone().map(Value::from));
            out.insert(String::from("sources"), Value::Array(list));
            Step::Ok(Value::Object(out))
        }
        .await;
        match result {
            Ok(body) => ctx.json(&body),
            Err(fail) => answer(ctx, fail, true),
        }
    })
}

/// JavaScript's `string.length`.
fn js_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `POST /media/{id}/servarr/imports/scan`.
pub(super) fn scan<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let parsed = write_route(ctx).and_then(|user| {
            let b = body(ctx)?;
            Ok((
                user,
                ctx.path_id(3)?,
                body_text(b, "sourceToken")?.to_owned(),
                body_flag(b, "is4k")?,
            ))
        });
        let (user, id, token, is4k) = match parsed {
            Ok(v) => v,
            Err(why) => return Outcome::forward(why),
        };
        if js_len(&token) > 128 {
            return ctx.error(400, "Choose an import source.");
        }
        let result = async {
            let c = resolve(ctx, id, is4k).await?;
            let source = redeem(&token, &c, user, "import-source")?.value;
            let arr = c.arr(ctx);
            assert_current(&c, &arr, &source).await?;
            let found = candidates(&arr, &source).await?;
            let list = found
                .as_array()
                .filter(|l| l.iter().all(|v| !v.is_null()))
                .ok_or_else(|| shape_error("candidates"))?;
            let mut out = Map::new();
            put(&mut out, "source", source.get("label").cloned());
            out.insert(
                String::from("candidates"),
                Value::Array(
                    list.iter()
                        .map(|cand| candidate_response(cand, &c, user, &source))
                        .collect(),
                ),
            );
            Step::Ok(Value::Object(out))
        }
        .await;
        match result {
            Ok(body) => ctx.json(&body),
            Err(fail) => {
                tracing::error!("Servarr manual import scan failed: {fail:?}");
                answer(ctx, fail, false)
            }
        }
    })
}

/// The integers of a body list, or why the validator would judge it.
fn int_list(v: Option<&Value>, key: &str) -> Result<Vec<i64>, String> {
    v.and_then(Value::as_array)
        .and_then(|items| items.iter().map(Value::as_i64).collect::<Option<Vec<_>>>())
        .ok_or_else(|| format!("{key} isn't a list of integers"))
}

/// `[...new Set(ids)]`.
fn dedupe<T: PartialEq + Clone>(ids: &[T]) -> Vec<T> {
    let mut out: Vec<T> = Vec::new();
    for id in ids {
        if !out.contains(id) {
            out.push(id.clone());
        }
    }
    out
}

/// The rematched candidate Sonarr answered, with the file details it left
/// out taken from the candidate before the rematch: Sonarr 4 answers only
/// the match (`seriesId`, episodes, quality…), without the file's name,
/// path or size, and Sonarr 5 without its folder.
fn rematched(answer: &Value, before: Option<&Value>) -> Value {
    let (Value::Object(answer), Some(Value::Object(before))) = (answer, before) else {
        return answer.clone();
    };
    let mut out = answer.clone();
    for key in ["name", "relativePath", "folderName", "size"] {
        if out.get(key).is_none_or(Value::is_null) {
            if let Some(value) = before.get(key) {
                out.insert(key.to_owned(), value.clone());
            }
        }
    }
    Value::Object(out)
}

/// The ids of a series' episodes.
async fn episode_ids(c: &Context, arr: &ArrServer<'_>) -> Step<Vec<Value>> {
    Ok(arr
        .episodes(c.external_id)
        .await?
        .iter()
        .filter_map(|e| e.get("id").cloned())
        .collect())
}

/// `POST /media/{id}/servarr/imports/reprocess`.
pub(super) fn reprocess<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let parsed = write_route(ctx).and_then(|user| {
            let b = body(ctx)?;
            Ok((
                user,
                ctx.path_id(3)?,
                body_text(b, "candidateToken")?.to_owned(),
                int_list(b.get("episodeIds"), "episodeIds")?,
                body_flag(b, "is4k")?,
            ))
        });
        let (user, id, token, ids, is4k) = match parsed {
            Ok(v) => v,
            Err(why) => return Outcome::forward(why),
        };
        if js_len(&token) > 128 || ids.is_empty() || ids.len() > 100 {
            return ctx.error(400, "Choose valid episodes to rematch.");
        }
        let result = async {
            let c = resolve(ctx, id, is4k).await?;
            if c.radarr {
                return Err(Fail::Status(
                    400,
                    String::from("Episode rematching is only available for Sonarr."),
                ));
            }
            let stored = redeem(&token, &c, user, "import-candidate")?.value;
            let source = stored.get("source").cloned().unwrap_or(Value::Null);
            let arr = c.arr(ctx);
            assert_current(&c, &arr, &source).await?;
            let valid = episode_ids(&c, &arr).await?;
            let ids = dedupe(&ids);
            if ids.iter().any(|id| !valid.contains(&Value::from(*id))) {
                return Err(Fail::Status(
                    400,
                    String::from("Every selected episode must belong to this series."),
                ));
            }
            let before = stored.get("candidate");
            let mut file = before
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            file.insert(String::from("seriesId"), Value::from(c.external_id));
            file.insert(
                String::from("episodeIds"),
                Value::Array(ids.iter().map(|i| Value::from(*i)).collect()),
            );
            let answered = arr
                .request(
                    Method::POST,
                    "/manualimport",
                    &[],
                    Some(&Value::Array(vec![Value::Object(file)])),
                    arr.timeout_ms,
                )
                .await?;
            let Some(first) = answered
                .as_array()
                .and_then(|l| l.first())
                .filter(|v| truthy(Some(v)))
            else {
                return Err(Fail::Status(
                    502,
                    String::from("Sonarr did not return a rematched import candidate."),
                ));
            };
            servarrtokens::remove(&token);
            Ok(candidate_response(
                &rematched(first, before),
                &c,
                user,
                &source,
            ))
        }
        .await;
        match result {
            Ok(body) => ctx.json(&body),
            Err(fail) => answer(ctx, fail, false),
        }
    })
}

/// `GET /media/{id}/servarr/imports`.
pub(super) fn list<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let (user, id, is4k) = match read_route(ctx, 2) {
            Ok(v) => v,
            Err(why) => return Outcome::forward(why),
        };
        let result = async {
            let c = resolve(ctx, id, is4k).await?;
            let arr = c.arr(ctx);
            let found = current_sources(&c, &arr).await?;
            let lists = futures_join(&arr, &found).await;
            let mut pairs: Vec<(Value, &Value)> = Vec::new();
            for (list, source) in lists.into_iter().zip(found.iter()) {
                let list = list?;
                let Some(items) = list.as_array().filter(|l| l.iter().all(|v| !v.is_null())) else {
                    return Err(Fail::Forward(String::from(
                        "candidates the handler would trip over",
                    )));
                };
                pairs.extend(items.iter().map(|cand| (cand.clone(), source)));
            }
            let mut seen: Vec<Option<Value>> = Vec::new();
            let mut out_list = Vec::new();
            for (cand, source) in &pairs {
                let path = cand.get("path").cloned();
                let comparable = !matches!(path, Some(Value::Object(_) | Value::Array(_)));
                if comparable && seen.contains(&path) {
                    continue;
                }
                seen.push(path);
                out_list.push(candidate_response(cand, &c, user, source));
            }
            let mut out = Map::new();
            out.insert(String::from("candidates"), Value::Array(out_list));
            Step::Ok(Value::Object(out))
        }
        .await;
        match result {
            Ok(body) => ctx.json(&body),
            Err(fail) => answer(ctx, fail, true),
        }
    })
}

/// Every source's candidates, fetched concurrently like `Promise.all`.
async fn futures_join(arr: &ArrServer<'_>, sources: &[Value]) -> Vec<Result<Value, ArrError>> {
    let jobs: Vec<crate::jellyfin::Job<'_, Result<Value, ArrError>>> = sources
        .iter()
        .map(|source| {
            let job: crate::jellyfin::Job<'_, _> = Box::pin(candidates(arr, source));
            job
        })
        .collect();
    crate::jellyfin::join_all(jobs).await
}

/// The body of `POST /imports` as the validator lets it through.
#[derive(Debug, Clone)]
struct ImportBody {
    tokens: Vec<String>,
    copy: bool,
    is4k: bool,
    acknowledge: bool,
    mappings: Vec<(String, Vec<i64>)>,
    intervention: Option<i64>,
}

fn import_body(b: &Map<String, Value>) -> Result<ImportBody, String> {
    let tokens = b
        .get("candidateTokens")
        .and_then(Value::as_array)
        .and_then(|l| {
            l.iter()
                .map(|t| t.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()
        })
        .ok_or_else(|| String::from("candidateTokens isn't a list of strings"))?;
    let copy = match b.get("importMode").and_then(Value::as_str) {
        Some("copy") => true,
        Some("move") => false,
        _ => return Err(String::from("importMode outside the enum")),
    };
    let mappings = match b.get("episodeMappings") {
        None => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                Some((
                    item.get("candidateToken")?.as_str()?.to_owned(),
                    int_list(item.get("episodeIds"), "episodeIds").ok()?,
                ))
            })
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| String::from("episodeMappings the validator judges"))?,
        Some(_) => return Err(String::from("episodeMappings isn't a list")),
    };
    let intervention = match b.get("interventionId") {
        None => None,
        Some(v) => Some(
            v.as_i64()
                .ok_or_else(|| String::from("interventionId isn't an integer"))?,
        ),
    };
    Ok(ImportBody {
        tokens,
        copy,
        is4k: body_flag(b, "is4k")?,
        acknowledge: body_flag(b, "acknowledgeRejections")?,
        mappings,
        intervention,
    })
}

/// `POST /media/{id}/servarr/imports`.
pub(super) fn import<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let parsed =
            write_route(ctx).and_then(|user| Ok((user, ctx.path_id(2)?, import_body(body(ctx)?)?)));
        let (user, id, b) = match parsed {
            Ok(v) => v,
            Err(why) => return Outcome::forward(why),
        };
        match run_import(ctx, user, id, &b).await {
            Ok(body) => ctx.json_with(202, &body),
            Err(fail) => answer(ctx, fail, false),
        }
    })
}

/// The intervention a manual import may resolve, checked against the
/// import.
async fn import_intervention(
    ctx: &Ready<'_>,
    c: &Context,
    id: i64,
    sources: &[Value],
) -> Step<i64> {
    let record = interventions::load(&ctx.state.db, id)
        .await
        .map_err(|e| Fail::Status(500, format!("{e:#}")))?;
    let external = c.external_id;
    let valid = record.is_some_and(|r| {
        r.state == "active"
            && r.manual_import_capable
            && r.media_id == c.media_id
            && r.service_id == c.service_id
            && external == r.external_service_id
            && r.is4k == c.is4k
            && sources.iter().all(|s| {
                matches!(s.get("downloadId"), Some(Value::String(d)) if Some(d.as_str()) == r.download_id.as_deref())
            })
    });
    if valid {
        Ok(id)
    } else {
        Err(Fail::Status(
            409,
            String::from("This intervention is not valid for the selected import."),
        ))
    }
}

async fn run_import(ctx: &Ready<'_>, user: i64, id: i64, b: &ImportBody) -> Step<Value> {
    let c = resolve(ctx, id, b.is4k).await?;
    if b.tokens.is_empty()
        || b.tokens.len() > 100
        || b.tokens.iter().any(|t| t.is_empty() || js_len(t) > 128)
    {
        return Err(Fail::Status(
            400,
            String::from("Select between one and 100 files to import."),
        ));
    }
    let stored: Vec<Value> = b
        .tokens
        .iter()
        .map(|t| redeem(t, &c, user, "import-candidate").map(|r| r.value))
        .collect::<Step<Vec<_>>>()?;
    let sources: Vec<Value> = stored
        .iter()
        .map(|s| s.get("source").cloned().unwrap_or(Value::Null))
        .collect();
    safe_to_import(&c, b, &stored)?;
    let arr = c.arr(ctx);
    for source in &sources {
        assert_current(&c, &arr, source).await?;
    }
    let mut files: Vec<Map<String, Value>> = stored
        .iter()
        .map(|s| {
            s.get("candidate")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default()
        })
        .collect();
    let intervention = match b.intervention {
        Some(iid) => Some(import_intervention(ctx, &c, iid, &sources).await?),
        None => None,
    };
    if files
        .iter()
        .any(|f| !complete(&Value::Object(f.clone()), c.radarr))
    {
        return Err(Fail::Status(
            409,
            String::from("One or more files need additional Arr metadata before importing."),
        ));
    }
    if files.iter().any(|f| has_length(f.get("rejections"))) && !b.acknowledge {
        return Err(Fail::Status(
            409,
            String::from("Confirm import rejection warnings before importing."),
        ));
    }
    assign_targets(&c, &arr, &mut files, b).await?;
    run_command(ctx, &c, &arr, files, b, user, intervention).await
}

/// Refuses, before anything is asked of the Arr, a file flagged as
/// potentially dangerous or executable (no acknowledgement lets it
/// through), and a file of a multi-season download the user didn't pick
/// episodes for.
fn safe_to_import(c: &Context, b: &ImportBody, stored: &[Value]) -> Step<()> {
    let candidate = |s: &Value| s.get("candidate").cloned().unwrap_or(Value::Null);
    if stored.iter().any(|s| unsafe_kind(&candidate(s)).is_some()) {
        return Err(Fail::Status(
            409,
            String::from(
                "Foreseerr does not import files flagged as potentially dangerous or executable.",
            ),
        ));
    }
    if c.radarr {
        return Ok(());
    }
    let unpicked = stored.iter().zip(&b.tokens).any(|(s, token)| {
        multi_season(&candidate(s), s.get("source").unwrap_or(&Value::Null))
            && !b
                .mappings
                .iter()
                .any(|(t, ids)| t == token && !ids.is_empty())
    });
    if unpicked {
        return Err(Fail::Status(
            409,
            String::from(
                "Choose the episodes of every file from a multi-season download before importing.",
            ),
        ));
    }
    Ok(())
}

/// `movieId`, or `seriesId` and the chosen (or matched) episodes, on every
/// file.
async fn assign_targets(
    c: &Context,
    arr: &ArrServer<'_>,
    files: &mut [Map<String, Value>],
    b: &ImportBody,
) -> Step<()> {
    if c.radarr {
        for file in files.iter_mut() {
            file.insert(String::from("movieId"), Value::from(c.external_id));
        }
        return Ok(());
    }
    let valid = episode_ids(c, arr).await?;
    for (index, file) in files.iter_mut().enumerate() {
        let token = b.tokens.get(index).map_or("", String::as_str);
        let mapped = b
            .mappings
            .iter()
            .rev()
            .find(|(t, _)| t == token)
            .map(|(_, ids)| ids.iter().map(|i| Value::from(*i)).collect::<Vec<_>>());
        let ids: Vec<Value> = mapped.unwrap_or_else(|| match file.get("episodes") {
            Some(Value::Array(eps)) => eps
                .iter()
                .map(|e| e.get("id").cloned().unwrap_or(Value::Null))
                .collect(),
            _ => Vec::new(),
        });
        if ids.is_empty() || ids.iter().any(|id| !valid.contains(id)) {
            return Err(Fail::Status(
                400,
                String::from("Choose valid episodes for every selected file."),
            ));
        }
        file.insert(String::from("seriesId"), Value::from(c.external_id));
        file.insert(String::from("episodeIds"), Value::Array(dedupe(&ids)));
    }
    Ok(())
}

/// The `ManualImport` command, the intervention claimed around it, and
/// the command token.
async fn run_command(
    ctx: &Ready<'_>,
    c: &Context,
    arr: &ArrServer<'_>,
    files: Vec<Map<String, Value>>,
    b: &ImportBody,
    user: i64,
    intervention: Option<i64>,
) -> Step<Value> {
    let db = &ctx.state.db;
    if let Some(iid) = intervention {
        let claimed = interventions::start_import(db, iid, user)
            .await
            .map_err(|e| Fail::Status(500, format!("{e:#}")))?;
        if !claimed {
            return Err(Fail::Status(
                409,
                String::from("This warning is already being handled."),
            ));
        }
    }
    let mut command_body = Map::new();
    command_body.insert(String::from("name"), Value::from("ManualImport"));
    command_body.insert(
        String::from("files"),
        Value::Array(files.into_iter().map(Value::Object).collect()),
    );
    command_body.insert(
        String::from("importMode"),
        Value::from(if b.copy { "copy" } else { "move" }),
    );
    let command = match arr.command(&Value::Object(command_body)).await {
        Ok(command) => command,
        Err(e) => {
            if let Some(iid) = intervention {
                if let Err(err) = interventions::fail_import(db, iid, Some(&e.message())).await {
                    tracing::error!("Failed to release intervention {iid}: {err:#}");
                }
            }
            return Err(Fail::Arr(e));
        }
    };
    for token in &b.tokens {
        servarrtokens::remove(token);
    }
    let mut value = Map::new();
    put(&mut value, "commandId", command.get("id").cloned());
    put(&mut value, "interventionId", intervention.map(Value::from));
    let token = servarrtokens::issue(c.token(user, "command", Value::Object(value)), 3600);
    let mut out = Map::new();
    out.insert(String::from("accepted"), Value::Bool(true));
    out.insert(String::from("commandToken"), Value::from(token));
    put(&mut out, "status", command.get("status").cloned());
    Ok(Value::Object(out))
}

/// `GET /media/{id}/servarr/commands/{token}`.
pub(super) fn command<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let (user, id, is4k) = match read_route(ctx, 3) {
            Ok(v) => v,
            Err(why) => return Outcome::forward(why),
        };
        let token = ctx.req.uri.path().rsplit('/').next().unwrap_or("");
        if token.contains('%') {
            return Outcome::forward(String::from("an encoded token; Express decodes it"));
        }
        let result = async {
            let c = resolve(ctx, id, is4k).await?;
            let value = redeem(token, &c, user, "command")?.value;
            let arr = c.arr(ctx);
            let found = arr
                .get(
                    &format!("/command/{}", js_string(value.get("commandId"))),
                    &[],
                )
                .await?;
            let status = match found.get("status") {
                None | Some(Value::Null) => String::from("unknown"),
                Some(Value::String(s)) => s.to_lowercase(),
                Some(_) => return Err(shape_error("command status")),
            };
            if let Some(iid) = value
                .get("interventionId")
                .filter(|v| truthy(Some(v)))
                .and_then(Value::as_i64)
            {
                let db = &ctx.state.db;
                let done = match status.as_str() {
                    "completed" => interventions::resolve_import(db, iid, user).await,
                    "failed" | "aborted" => {
                        let message = found.get("message").and_then(Value::as_str);
                        interventions::fail_import(db, iid, message).await
                    }
                    _ => Ok(()),
                };
                done.map_err(|e| Fail::Status(500, format!("{e:#}")))?;
            }
            let mut out = Map::new();
            out.insert(String::from("status"), Value::from(status));
            put(&mut out, "message", found.get("message").cloned());
            put(&mut out, "queuedAt", found.get("queued").cloned());
            put(&mut out, "startedAt", found.get("started").cloned());
            put(&mut out, "endedAt", found.get("ended").cloned());
            Step::Ok(Value::Object(out))
        }
        .await;
        match result {
            Ok(body) => ctx.json(&body),
            Err(fail) => answer(ctx, fail, false),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn queue_and_candidates() {
        let item = json!({"status": "completed", "trackedDownloadStatus": "Warning", "downloadId": "d", "outputPath": "/x", "title": "T"});
        assert_eq!(interactive(&item), Some(true), "interactive");
        assert_eq!(interactive(&Value::Null), None, "null throws");
        assert_eq!(
            interactive(&json!({"status": 3})),
            None,
            "a number has no toLowerCase"
        );
        assert_eq!(interactive(&json!(5)), Some(false), "a number item");
        assert_eq!(
            source_for(&item),
            json!({"kind": "queue", "label": "T", "folder": "/x", "downloadId": "d"}),
            "source"
        );
        let cand = json!({"series": {}, "seasonNumber": 1, "episodes": [{"id": 1}], "quality": {}, "languages": [{"name": "English"}, {}]});
        assert!(complete(&cand, false), "complete for sonarr");
        assert!(!complete(&cand, true), "no movie for radarr");
        assert_eq!(dedupe(&[3, 1, 3]), vec![3, 1], "first occurrence kept");
        assert_eq!(js_len("a😀"), 3, "utf-16 length");
        assert!(
            complete(
                &json!({"seriesId": 3, "seasonNumber": 1, "episodes": [{"id": 1}], "quality": {}, "languages": [{"name": "English"}]}),
                false
            ),
            "a rematched Sonarr 4 candidate names its series by id"
        );
        assert!(
            !complete(
                &json!({"seasonNumber": 1, "episodes": [{"id": 1}], "quality": {}, "languages": [{}]}),
                false
            ),
            "no series at all"
        );
        let raw = json!({"candidateTokens": ["a"], "importMode": "copy"});
        let parsed = raw.as_object().map(import_body);
        assert!(
            matches!(parsed, Some(Ok(ImportBody { copy: true, .. }))),
            "copy mode"
        );
    }

    #[test]
    fn unsafe_files() {
        let typed =
            |code: &str| json!({"path": "/d/a.mkv", "rejections": [{"reason": "m", "code": code}]});
        assert_eq!(unsafe_kind(&typed("dangerousFile")), Some("dangerousFile"));
        assert_eq!(
            unsafe_kind(&typed("executableFile")),
            Some("executableFile")
        );
        assert_eq!(unsafe_kind(&typed("sample")), None, "another warning");
        assert_eq!(
            unsafe_kind(&json!({"rejections": [
                {"reason": "Caution: Found executable file with extension: '.exe'", "type": "permanent"}
            ]})),
            Some("executableFile"),
            "Sonarr 4 says it in words"
        );
        assert_eq!(
            unsafe_kind(&json!({"rejections": [
                {"reason": "Caution: Found potentially dangerous file with extension: .lnk"}
            ]})),
            Some("dangerousFile")
        );
        assert_eq!(
            unsafe_kind(&json!({"path": "/d/Show.S01E01.mkv.EXE", "rejections": []})),
            Some("executableFile"),
            "the file itself, any case"
        );
        assert_eq!(
            unsafe_kind(&json!({"path": "C:\\d\\x.scr"})),
            Some("dangerousFile"),
            "a Windows path"
        );
        assert_eq!(
            unsafe_kind(&json!({"relativePath": "Show/x.vbs"})),
            Some("dangerousFile")
        );
        assert_eq!(
            unsafe_kind(&json!({"path": "/d.exe/Show.S01E01.mkv"})),
            None,
            "only the file name counts"
        );
        assert_eq!(extension("/a/b.tar.GZ"), Some(String::from("gz")));
        assert_eq!(extension("/a/noext"), None);
    }

    #[test]
    fn multi_season_downloads() {
        let item = json!({
            "status": "completed", "trackedDownloadStatus": "warning", "downloadId": "d",
            "outputPath": "/x", "title": "Show.S01-S02",
            "seasons": [{"seasonNumber": 1}, {"seasonNumber": 2}]
        });
        let source = source_for(&item);
        assert_eq!(source.get("multiSeason"), Some(&json!(true)), "source");
        let file = json!({"path": "/x/Show.S02E01.mkv", "rejections": []});
        assert!(multi_season(&file, &source), "from the download");
        assert!(
            multi_season(
                &json!({"rejections": [{"reason": "m", "code": "multiSeason"}]}),
                &Value::Null
            ),
            "Sonarr says so of the file"
        );
        assert!(!multi_season(&file, &source_for(&json!({"title": "T"}))));
        let body = |mappings: Vec<(String, Vec<i64>)>| ImportBody {
            tokens: vec![String::from("a")],
            copy: false,
            is4k: false,
            acknowledge: true,
            mappings,
            intervention: None,
        };
        let c = Context {
            media_id: 1,
            is4k: false,
            radarr: false,
            external_id: 7,
            service_id: 1,
            service_name: None,
            native_url: None,
            server: Value::Null,
        };
        let stored = [json!({"candidate": file, "source": source})];
        assert!(
            matches!(
                safe_to_import(&c, &body(Vec::new()), &stored),
                Err(Fail::Status(409, _))
            ),
            "episodes not picked"
        );
        assert!(
            matches!(
                safe_to_import(&c, &body(vec![(String::from("a"), Vec::new())]), &stored),
                Err(Fail::Status(409, _))
            ),
            "an empty pick"
        );
        assert_eq!(
            safe_to_import(&c, &body(vec![(String::from("a"), vec![21])]), &stored),
            Ok(()),
            "picked"
        );
        let exe = [json!({"candidate": {"path": "/x/setup.exe"}, "source": {}})];
        assert!(
            matches!(
                safe_to_import(&c, &body(vec![(String::from("a"), vec![21])]), &exe),
                Err(Fail::Status(409, m)) if m.contains("dangerous or executable")
            ),
            "never, acknowledged or not"
        );
    }

    #[test]
    fn rematch_keeps_file_details() {
        let before = json!({
            "path": "/d/S01E02E03.mkv", "name": "S01E02E03", "relativePath": "S01E02E03.mkv",
            "folderName": "S01E02E03", "size": 20, "series": {"id": 3},
            "episodes": [{"id": 396}]
        });
        // Sonarr 4's answer to `POST /api/v3/manualimport`.
        let v4 = json!({
            "path": "/d/S01E02E03.mkv", "seriesId": 3, "seasonNumber": 1,
            "episodes": [{"id": 396}, {"id": 397}], "rejections": []
        });
        assert_eq!(
            rematched(&v4, Some(&before)),
            json!({
                "path": "/d/S01E02E03.mkv", "seriesId": 3, "seasonNumber": 1,
                "episodes": [{"id": 396}, {"id": 397}], "rejections": [],
                "name": "S01E02E03", "relativePath": "S01E02E03.mkv",
                "folderName": "S01E02E03", "size": 20
            }),
            "the file details carry over, the match is Sonarr's"
        );
        let v5 = json!({"name": "renamed", "size": 21, "series": {"id": 3}});
        assert_eq!(
            rematched(&v5, Some(&before)),
            json!({
                "name": "renamed", "size": 21, "series": {"id": 3},
                "relativePath": "S01E02E03.mkv", "folderName": "S01E02E03"
            }),
            "what Sonarr answered wins"
        );
        assert_eq!(
            rematched(&json!(5), Some(&before)),
            json!(5),
            "not an object"
        );
        assert_eq!(rematched(&v4, None), v4, "nothing to carry over");
    }
}
