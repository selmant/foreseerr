//! `server/lib/settings/migrator.ts` and the migrations in
//! `server/lib/settings/migrations`, applied to settings.json as read from
//! disk (before the defaults are merged under it), in Node's order.
//!
//! Every migration works on the parsed document with JavaScript's object
//! semantics: assigning an existing key keeps its position, a new key goes
//! last, `delete` removes it (`shift_remove`).

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{Map, Value};

use crate::db::Db;
use crate::media::js_string;
use crate::settings::public::truthy;

/// What the migrations that call out (0002, 0007) need.
#[derive(Debug, Clone, Copy)]
pub(crate) struct MigrationCtx<'a> {
    /// The database (users).
    pub(crate) db: &'a Db,
    /// Outgoing HTTP, as Node's axios has it before the proxy is set up.
    pub(crate) http: &'a reqwest::Client,
    /// `getAppVersion()`, for the Jellyfin authorization header.
    pub(crate) version: &'a str,
}

/// `SETTINGS_MIGRATIONS`, in order.
pub(crate) const NAMES: [&str; 12] = [
    "0001_migrate_hostname",
    "0002_migrate_apitokens",
    "0003_emby_media_server_type",
    "0004_migrate_region_setting",
    "0005_migrate_network_settings",
    "0006_remove_lunasea",
    "0007_migrate_arr_tags",
    "0008_migrate_blacklist_to_blocklist",
    "0011_release_calendar_sync_5m",
    "0012_restore_release_calendar_sync_interval",
    "0013_increase_arr_request_timeout",
    "0014_arr_scan_15m",
];

/// `JSON.stringify(value)`.
pub(crate) fn stringify(value: &Value) -> String {
    value.to_string()
}

/// `JSON.stringify(value, undefined, ' ')`.
///
/// # Errors
///
/// Never in practice; serializing a `Value` can't fail.
pub(crate) fn stringify_pretty(value: &Value) -> Result<String> {
    let mut text = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b" ");
    let mut ser = serde_json::Serializer::with_formatter(&mut text, formatter);
    serde::Serialize::serialize(value, &mut ser).context("serializing settings")?;
    String::from_utf8(text).context("settings are not UTF-8")
}

fn type_error(what: &str) -> anyhow::Error {
    anyhow!("{what} is missing")
}

/// `settings.main`, which every migration reaches without a guard.
fn main_mut(settings: &mut Map<String, Value>) -> Result<&mut Map<String, Value>> {
    settings
        .get_mut("main")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| type_error("undefined (reading 'main')"))
}

fn has_migration(settings: &Map<String, Value>, name: &str) -> bool {
    settings
        .get("migrations")
        .and_then(Value::as_array)
        .is_some_and(|list| list.iter().any(|n| n.as_str() == Some(name)))
}

/// `if (!Array.isArray(settings.migrations)) settings.migrations = [];
/// settings.migrations.push(name)`.
fn record(settings: &mut Map<String, Value>, name: &str) {
    let list = settings
        .entry("migrations")
        .or_insert_with(|| Value::Array(Vec::new()));
    if !list.is_array() {
        *list = Value::Array(Vec::new());
    }
    if let Value::Array(list) = list {
        list.push(Value::from(name));
    }
}

/// `if (!settings.jobs) settings.jobs = {}`, then the object.
fn jobs_mut(settings: &mut Map<String, Value>) -> Result<&mut Map<String, Value>> {
    let jobs = settings
        .entry("jobs")
        .or_insert_with(|| Value::Object(Map::new()));
    if !truthy(Some(jobs)) {
        *jobs = Value::Object(Map::new());
    }
    jobs.as_object_mut()
        .ok_or_else(|| anyhow!("settings.jobs is not an object"))
}

fn schedule(cron: &str) -> Value {
    let mut job = Map::new();
    job.insert(String::from("schedule"), Value::from(cron));
    Value::Object(job)
}

/// What `/^([^:]+)(:([0-9]+))?(\/.*)?$/` captures: ip, port, url base.
fn split_host(rest: &str) -> Option<(&str, Option<&str>, Option<&str>)> {
    // `.` stops at line terminators; `$` is the end of the input.
    let tail_ok = |tail: &str| {
        tail.is_empty()
            || (tail.starts_with('/') && !tail.contains(['\n', '\r', '\u{2028}', '\u{2029}']))
    };
    let run_end = rest.find(':').unwrap_or(rest.len());
    let mut ends: Vec<usize> = rest
        .char_indices()
        .map(|(i, c)| i + c.len_utf8())
        .filter(|&end| end <= run_end)
        .collect();
    ends.reverse();
    for ip_end in ends {
        let ip = rest.get(..ip_end)?;
        let after = rest.get(ip_end..)?;
        if let Some(port_part) = after.strip_prefix(':') {
            let digits = port_part
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(port_part.len());
            if digits > 0 {
                let port = port_part.get(..digits)?;
                let tail = port_part.get(digits..)?;
                if tail_ok(tail) {
                    return Some((ip, Some(port), Some(tail).filter(|t| !t.is_empty())));
                }
            }
        }
        if tail_ok(after) {
            return Some((ip, None, Some(after).filter(|t| !t.is_empty())));
        }
    }
    None
}

/// `/^(https?):\/\//i`: the scheme and the rest.
fn split_scheme(hostname: &str) -> (Option<&str>, &str) {
    for scheme in ["https", "http"] {
        let prefix_len = scheme.len() + 3;
        if let Some(prefix) = hostname.get(..prefix_len) {
            if prefix.eq_ignore_ascii_case(&format!("{scheme}://")) {
                return (
                    hostname.get(..scheme.len()),
                    hostname.get(prefix_len..).unwrap_or(""),
                );
            }
        }
    }
    (None, hostname)
}

/// 0001: `jellyfin.hostname` split into ip, port, useSsl and urlBase.
fn migrate_hostname(settings: &mut Map<String, Value>) -> Result<()> {
    let Some(jellyfin) = settings.get_mut("jellyfin").and_then(Value::as_object_mut) else {
        return Ok(());
    };
    if !truthy(jellyfin.get("hostname")) {
        return Ok(());
    }
    let hostname = jellyfin
        .get("hostname")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("the hostname is not text"))?
        .to_owned();
    let (scheme, remaining) = split_scheme(&hostname);
    let use_ssl = scheme.is_some_and(|s| s.eq_ignore_ascii_case("https"));
    jellyfin.shift_remove("hostname");
    if let Some((ip, port, url_base)) = split_host(remaining) {
        let port = match port {
            Some(p) if !p.is_empty() => p.parse::<i64>().map_or_else(
                |_| Value::from(p.parse::<f64>().unwrap_or(f64::NAN)),
                Value::from,
            ),
            Some(_) | None => Value::from(if use_ssl { 443 } else { 80 }),
        };
        jellyfin.insert(String::from("ip"), Value::from(ip));
        jellyfin.insert(String::from("port"), port);
        jellyfin.insert(String::from("useSsl"), Value::Bool(use_ssl));
        let base = url_base.map_or("", |b| b.strip_suffix('/').unwrap_or(b));
        jellyfin.insert(String::from("urlBase"), Value::from(base));
    }
    Ok(())
}

/// 0002: a Jellyfin or Emby install without `jellyfin.apiKey` gets one
/// created from the admin's token.
async fn migrate_api_tokens(
    settings: &mut Map<String, Value>,
    ctx: MigrationCtx<'_>,
) -> Result<()> {
    let has_key = settings
        .get("jellyfin")
        .is_some_and(|j| truthy(j.get("apiKey")));
    let server_type = main_mut(settings)?
        .get("mediaServerType")
        .and_then(Value::as_f64);
    if has_key || !server_type.is_some_and(|t| [2.0, 3.0].contains(&t)) {
        return Ok(());
    }
    let admin = ctx
        .db
        .rows(
            r#"SELECT "jellyfinAuthToken", "jellyfinUserId", "jellyfinDeviceId" FROM "user" WHERE "id" = 1 ORDER BY "id" ASC LIMIT 1"#,
            &[],
        )
        .await?;
    let Some(admin) = admin.first() else {
        return Ok(());
    };
    let jellyfin = settings.get("jellyfin");
    let field = |key: &str| js_string(jellyfin.and_then(|j| j.get(key))).into_owned();
    let scheme = if truthy(jellyfin.and_then(|j| j.get("useSsl"))) {
        "https"
    } else {
        "http"
    };
    let base = format!(
        "{scheme}://{}:{}{}",
        field("ip"),
        field("port"),
        field("urlBase")
    );
    let token = admin.get("jellyfinAuthToken").and_then(Value::as_str);
    let device = admin
        .get("jellyfinDeviceId")
        .and_then(Value::as_str)
        .filter(|d| !d.is_empty())
        .map_or_else(|| String::from("Qk9UX3NlZXJy"), str::to_owned);
    let mut auth = format!(
        r#"MediaBrowser Client="Foreseerr", Device="Foreseerr", DeviceId="{device}", Version="{}""#,
        ctx.version
    );
    if let Some(token) = token.filter(|t| !t.is_empty()) {
        auth.push_str(", Token=\"");
        auth.push_str(token);
        auth.push('"');
    }
    let key = create_api_token(ctx.http, &base, &auth).await.map_err(|e| {
        tracing::error!(
            label = "Jellyfin API",
            "Something went wrong while creating an API key from the Jellyfin server: {e:#}"
        );
        anyhow!("Failed to create Jellyfin API token from admin account. Please check your network configuration or edit your settings.json by adding an 'apiKey' field inside of the 'jellyfin' section to fix this issue.")
    })?;
    let jellyfin = settings
        .get_mut("jellyfin")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| type_error("undefined (setting 'apiKey')"))?;
    jellyfin.insert(String::from("apiKey"), key);
    Ok(())
}

/// `JellyfinAPI.createApiToken('Foreseerr')`.
async fn create_api_token(http: &reqwest::Client, base: &str, auth: &str) -> Result<Value> {
    let send = |request: reqwest::RequestBuilder| {
        request
            .header("Authorization", auth)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .send()
    };
    send(http.post(format!("{base}/Auth/Keys?App=Foreseerr")))
        .await?
        .error_for_status()?;
    let keys: Value = send(http.get(format!("{base}/Auth/Keys")))
        .await?
        .error_for_status()?
        .json()
        .await?;
    let items = keys
        .get("Items")
        .and_then(Value::as_array)
        .context("no Items in /Auth/Keys")?;
    items
        .iter()
        .rev()
        .find(|item| item.get("AppName").and_then(Value::as_str) == Some("Foreseerr"))
        .and_then(|item| item.get("AccessToken"))
        .cloned()
        .context("the new key is not listed")
}

/// 0003: `JELLYFIN_TYPE=emby` turns a Jellyfin install into Emby.
fn migrate_emby(settings: &mut Map<String, Value>) -> Result<()> {
    let main = main_mut(settings)?;
    let jellyfin = main.get("mediaServerType").and_then(Value::as_f64) == Some(2.0);
    if jellyfin && std::env::var("JELLYFIN_TYPE").is_ok_and(|t| t == "emby") {
        main.insert(String::from("mediaServerType"), Value::from(3));
    }
    Ok(())
}

/// 0004: `main.region` split into discover and streaming regions.
fn migrate_region(settings: &mut Map<String, Value>) -> Result<()> {
    let main = main_mut(settings)?;
    if main.contains_key("discoverRegion") && main.contains_key("streamingRegion") {
        return Ok(());
    }
    let old = main.get("region").cloned();
    if truthy(old.as_ref()) {
        let old = old.unwrap_or(Value::Null);
        main.insert(String::from("discoverRegion"), old.clone());
        main.insert(String::from("streamingRegion"), old);
    } else {
        main.insert(String::from("discoverRegion"), Value::from(""));
        main.insert(String::from("streamingRegion"), Value::from("US"));
    }
    main.shift_remove("region");
    Ok(())
}

/// 0005: the network options move from `main` to `network`.
fn migrate_network(settings: &mut Map<String, Value>) -> Result<()> {
    if truthy(settings.get("network")) {
        return Ok(());
    }
    let main = main_mut(settings)?;
    let or = |key: &str, default: Value| match main.get(key) {
        None | Some(Value::Null) => default,
        Some(v) => v.clone(),
    };
    let mut network = Map::new();
    network.insert(
        String::from("csrfProtection"),
        or("csrfProtection", Value::Bool(false)),
    );
    network.insert(
        String::from("trustProxy"),
        or("trustProxy", Value::Bool(false)),
    );
    network.insert(
        String::from("forceIpv4First"),
        or("forceIpv4First", Value::Bool(false)),
    );
    network.insert(String::from("proxy"), or("proxy", default_proxy()));
    for key in ["csrfProtection", "trustProxy", "forceIpv4First", "proxy"] {
        main.shift_remove(key);
    }
    settings.insert(String::from("network"), Value::Object(network));
    Ok(())
}

fn default_proxy() -> Value {
    serde_json::json!({
        "enabled": false,
        "hostname": "",
        "port": 8080,
        "useSsl": false,
        "user": "",
        "password": "",
        "bypassFilter": "",
        "bypassLocalAddresses": true
    })
}

/// 0006: the `LunaSea` agent is gone.
fn remove_lunasea(settings: &mut Map<String, Value>) {
    if let Some(agents) = settings
        .get_mut("notifications")
        .filter(|n| truthy(Some(n)))
        .and_then(|n| n.get_mut("agents"))
        .filter(|a| truthy(Some(a)))
        .and_then(Value::as_object_mut)
    {
        if truthy(agents.get("lunasea")) {
            agents.shift_remove("lunasea");
        }
    }
}

/// The user's display name as `@AfterLoad` computes it.
fn display_name(user: &crate::db::UserRecord) -> String {
    [&user.username, &user.plex_username, &user.jellyfin_username]
        .into_iter()
        .find_map(|v| v.as_deref().filter(|s| !s.is_empty()))
        .map_or_else(
            || user.email.as_deref().unwrap_or("").to_lowercase(),
            str::to_owned,
        )
}

/// 0007: user tags in Radarr and Sonarr renamed to `<id>-<name>`.
async fn migrate_arr_tags(settings: &mut Map<String, Value>, ctx: MigrationCtx<'_>) -> Result<()> {
    const NAME: &str = "0007_migrate_arr_tags";
    if has_migration(settings, NAME) {
        return Ok(());
    }
    let users = ctx.db.all_users_with_settings().await?;
    let servarr = crate::servarr::ServarrClient::new(ctx.http.clone());
    let mut error_occurred = false;
    for (kind, label) in [("radarr", "Radarr"), ("sonarr", "Sonarr")] {
        let servers = match settings.get(kind) {
            Some(Value::Array(list)) => list.clone(),
            // `settings.radarr || []`; a string iterates its characters,
            // none of which has `tagRequests`.
            Some(v) if !truthy(Some(v)) || v.is_string() => Vec::new(),
            None => Vec::new(),
            Some(_) => bail!("settings.{kind} is not a list"),
        };
        for server in servers.iter().filter(|s| truthy(s.get("tagRequests"))) {
            if let Err(e) = rename_user_tags(&servarr, server, &users).await {
                tracing::error!(
                    "Unable to rename {label} tags to the new format. Please check your {label} connection settings for the instance \"{}\". {e:#}",
                    js_string(server.get("name"))
                );
                error_occurred = true;
            }
        }
    }
    if !error_occurred {
        record(settings, NAME);
    }
    Ok(())
}

async fn rename_user_tags(
    servarr: &crate::servarr::ServarrClient,
    server: &Value,
    users: &[(crate::db::UserRecord, Option<crate::db::UserSettingsRecord>)],
) -> Result<()> {
    let tags = servarr
        .call(server, reqwest::Method::GET, "/tag", &[], None, None)
        .await?;
    let tags = tags.as_array().cloned().unwrap_or_default();
    for (user, _) in users {
        let spaced = format!("{} - ", user.id);
        let joined = format!("{}-", user.id);
        let mut found = None;
        for tag in &tags {
            let label = tag
                .get("label")
                .and_then(Value::as_str)
                .context("a label is not text")?;
            if label.starts_with(&spaced) || label.starts_with(&joined) {
                found = Some(tag);
                break;
            }
        }
        let Some(tag) = found else {
            continue;
        };
        let id = tag.get("id").cloned().unwrap_or(Value::Null);
        let label = format!(
            "{}-{}",
            user.id,
            crate::lifecycle::sanitize_display_name(&display_name(user))
        );
        let mut body = Map::new();
        body.insert(String::from("id"), id.clone());
        body.insert(String::from("label"), Value::from(label));
        let path = format!("/tag/{}", js_string(Some(&id)));
        servarr
            .call(
                server,
                reqwest::Method::PUT,
                &path,
                &[],
                Some(&Value::Object(body)),
                None,
            )
            .await?;
    }
    Ok(())
}

/// 0008: blacklist settings renamed to blocklist.
fn migrate_blocklist(settings: &mut Map<String, Value>) {
    const NAME: &str = "0008_migrate_blacklist_to_blocklist";
    if has_migration(settings, NAME) {
        return;
    }
    if let Some(main) = settings.get_mut("main").and_then(Value::as_object_mut) {
        for (old, new) in [
            ("hideBlacklisted", "hideBlocklisted"),
            ("blacklistedTags", "blocklistedTags"),
            ("blacklistedTagsLimit", "blocklistedTagsLimit"),
        ] {
            if let Some(value) = main.get(old).cloned() {
                main.insert(new.to_owned(), value);
                main.shift_remove(old);
            }
        }
    }
    if let Some(jobs) = settings.get_mut("jobs").and_then(Value::as_object_mut) {
        if let Some(job) = jobs
            .get("process-blacklisted-tags")
            .filter(|j| truthy(Some(j)))
            .cloned()
        {
            jobs.insert(String::from("process-blocklisted-tags"), job);
            jobs.shift_remove("process-blacklisted-tags");
        }
    }
    record(settings, NAME);
}

/// 0011 and 0012: a missing release calendar schedule gets the six-hour
/// default.
fn release_calendar(settings: &mut Map<String, Value>, name: &str) -> Result<()> {
    if has_migration(settings, name) {
        return Ok(());
    }
    let jobs = jobs_mut(settings)?;
    if !truthy(jobs.get("release-calendar-sync")) {
        jobs.insert(
            String::from("release-calendar-sync"),
            schedule("0 0 */6 * * *"),
        );
    }
    record(settings, name);
    Ok(())
}

/// 0013: the old ten-second request timeout becomes sixty seconds.
fn arr_request_timeout(settings: &mut Map<String, Value>) {
    const NAME: &str = "0013_increase_arr_request_timeout";
    if has_migration(settings, NAME) {
        return;
    }
    if let Some(network) = settings.get_mut("network").and_then(Value::as_object_mut) {
        if network.get("apiRequestTimeout").and_then(Value::as_f64) == Some(10_000.0) {
            network.insert(String::from("apiRequestTimeout"), Value::from(60_000));
        }
    }
    record(settings, NAME);
}

/// 0014: the factory daily *arr scans become every fifteen minutes.
fn arr_scan_interval(settings: &mut Map<String, Value>) -> Result<()> {
    const NAME: &str = "0014_arr_scan_15m";
    if has_migration(settings, NAME) {
        return Ok(());
    }
    let jobs = jobs_mut(settings)?;
    for (id, old) in [
        ("radarr-scan", "0 0 4 * * *"),
        ("sonarr-scan", "0 30 4 * * *"),
    ] {
        let replace = match jobs.get(id) {
            Some(job) if truthy(Some(job)) => {
                job.get("schedule").and_then(Value::as_str) == Some(old)
            }
            Some(_) | None => true,
        };
        if replace {
            jobs.insert(id.to_owned(), schedule("0 */15 * * * *"));
        }
    }
    record(settings, NAME);
    Ok(())
}

/// One migration by name.
async fn apply(name: &str, settings: &mut Map<String, Value>, ctx: MigrationCtx<'_>) -> Result<()> {
    match name {
        "0001_migrate_hostname" => migrate_hostname(settings),
        "0002_migrate_apitokens" => migrate_api_tokens(settings, ctx).await,
        "0003_emby_media_server_type" => migrate_emby(settings),
        "0004_migrate_region_setting" => migrate_region(settings),
        "0005_migrate_network_settings" => migrate_network(settings),
        "0006_remove_lunasea" => {
            remove_lunasea(settings);
            Ok(())
        }
        "0007_migrate_arr_tags" => migrate_arr_tags(settings, ctx).await,
        "0008_migrate_blacklist_to_blocklist" => {
            migrate_blocklist(settings);
            Ok(())
        }
        "0011_release_calendar_sync_5m" | "0012_restore_release_calendar_sync_interval" => {
            release_calendar(settings, name)
        }
        "0013_increase_arr_request_timeout" => {
            arr_request_timeout(settings);
            Ok(())
        }
        "0014_arr_scan_15m" => arr_scan_interval(settings),
        other => bail!("unknown settings migration {other}"),
    }
}

/// The ledger cleanup before the migrations: request routing (0009, 0010)
/// was removed with its data.
fn drop_request_routing(settings: &mut Map<String, Value>) -> Result<()> {
    if let Some(Value::Array(list)) = settings.get_mut("migrations") {
        let mut kept = Vec::with_capacity(list.len());
        for name in list.drain(..) {
            let text = name.as_str().context("a name is not text")?;
            if !text.starts_with("0009_") && !text.starts_with("0010_") {
                kept.push(name);
            }
        }
        *list = kept;
    }
    settings.shift_remove("requestRouting");
    settings.shift_remove("requestFilters");
    Ok(())
}

/// `assertNoUnsupportedMigrations`: names this build has no migration for.
fn unsupported(settings: &Map<String, Value>) -> Vec<String> {
    settings
        .get("migrations")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|n| js_string(Some(n)).into_owned())
                .filter(|n| !NAMES.contains(&n.as_str()))
                .collect()
        })
        .unwrap_or_default()
}

/// `runMigrations(settings, SETTINGS_PATH)`: the migrated document, with
/// settings.old.json and settings.json written as Node writes them.
///
/// # Errors
///
/// Where Node exits: a newer settings.json, a failing migration, or a file
/// that can't be written.
pub(crate) async fn run(original: &Value, path: &Path, ctx: MigrationCtx<'_>) -> Result<Value> {
    let before = stringify(original);
    let mut migrated = original
        .as_object()
        .cloned()
        .ok_or_else(|| type_error("a settings.json that is not an object"))?;
    drop_request_routing(&mut migrated)?;
    let unknown = unsupported(&migrated);
    if !unknown.is_empty() {
        tracing::error!(
            label = "Settings Migrator",
            "This settings.json was migrated by a newer version of Foreseerr and includes migrations this version does not recognize: {}.",
            unknown.join(", ")
        );
        tracing::error!(
            label = "Settings Migrator",
            "Downgrading to an older Foreseerr version with a newer settings.json is not supported. Restore a settings.json backup that matches this version (see settings.old.json in your config directory), or upgrade to a Foreseerr release that recognizes these migrations."
        );
        bail!("settings.json was written by a newer Foreseerr");
    }
    // `SETTINGS_PATH.replace('.json', '.old.json')`: the first match in
    // the whole path.
    let backup = PathBuf::from(path.to_string_lossy().replacen(".json", ".old.json", 1));
    let written = write_with_backup(original, &mut migrated, &before, path, &backup, ctx).await;
    if let Err(e) = written {
        tracing::error!(
            label = "Settings Migrator",
            "Something went wrong while running settings migrations: {e:#}"
        );
        return Err(e);
    }
    Ok(Value::Object(migrated))
}

async fn write_with_backup(
    original: &Value,
    migrated: &mut Map<String, Value>,
    before: &str,
    path: &Path,
    backup: &Path,
    ctx: MigrationCtx<'_>,
) -> Result<()> {
    let old_backup = tokio::fs::read_to_string(backup).await.ok();
    tokio::fs::write(backup, stringify_pretty(original)?)
        .await
        .with_context(|| format!("writing {}", backup.display()))?;
    for name in NAMES {
        tracing::debug!(
            label = "Settings Migrator",
            "Checking migration '{name}'..."
        );
        let previous = stringify(&Value::Object(migrated.clone()));
        if let Err(e) = apply(name, migrated, ctx).await {
            tracing::error!(
                label = "Settings Migrator",
                "Error while running migration '{name}': {e:#}"
            );
            tracing::error!(
                label = "Settings Migrator",
                "A common cause for this error is a permission issue with your configuration folder, a network issue or a corrupted database."
            );
            return Err(e);
        }
        if previous != stringify(&Value::Object(migrated.clone())) {
            tracing::debug!(
                label = "Settings Migrator",
                "Migration '{name}' has been applied."
            );
        }
    }
    let after = Value::Object(migrated.clone());
    if before != stringify(&after) {
        tokio::fs::write(path, stringify_pretty(&after)?)
            .await
            .with_context(|| format!("writing {}", path.display()))?;
        let saved: Value = serde_json::from_str(&tokio::fs::read_to_string(path).await?)?;
        if stringify(&crate::tmdb::js_numbers(saved)) != stringify(&after) {
            bail!("Unable to save settings after migration.");
        }
    } else if let Some(old) = old_backup.filter(|o| !o.is_empty()) {
        tokio::fs::write(backup, old)
            .await
            .with_context(|| format!("writing {}", backup.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn obj(v: Value) -> Map<String, Value> {
        match v {
            Value::Object(map) => map,
            Value::Null
            | Value::Bool(_)
            | Value::Number(_)
            | Value::String(_)
            | Value::Array(_) => Map::new(),
        }
    }

    #[test]
    fn hostname_split() {
        assert_eq!(
            split_host("jf.local:8096/jellyfin/"),
            Some(("jf.local", Some("8096"), Some("/jellyfin/"))),
            "all parts"
        );
        assert_eq!(
            split_host("jf.local"),
            Some(("jf.local", None, None)),
            "bare"
        );
        assert_eq!(
            split_host("a/b:xyz"),
            Some(("a", None, Some("/b:xyz"))),
            "backtracks to the last slash"
        );
        assert_eq!(split_host(":80"), None, "no ip");
        let mut s = obj(
            json!({"jellyfin": {"name": "x", "hostname": "HTTPS://jf:8920/base/", "ip": "old"}}),
        );
        assert!(migrate_hostname(&mut s).is_ok(), "migrates");
        assert_eq!(
            Value::Object(s),
            json!({"jellyfin": {"name": "x", "ip": "jf", "port": 8920, "useSsl": true, "urlBase": "/base"}}),
            "ip keeps its place, the rest is appended"
        );
        let mut s = obj(json!({"jellyfin": {"hostname": "jf"}}));
        assert!(migrate_hostname(&mut s).is_ok(), "migrates");
        assert_eq!(
            Value::Object(s),
            json!({"jellyfin": {"ip": "jf", "port": 80, "useSsl": false, "urlBase": ""}}),
            "defaults"
        );
    }

    #[test]
    fn region_and_network() {
        let mut s = obj(json!({"main": {"region": "GB", "csrfProtection": true, "proxy": null}}));
        assert!(migrate_region(&mut s).is_ok(), "region");
        assert!(migrate_network(&mut s).is_ok(), "network");
        assert_eq!(
            Value::Object(s),
            json!({
                "main": {"discoverRegion": "GB", "streamingRegion": "GB"},
                "network": {
                    "csrfProtection": true, "trustProxy": false, "forceIpv4First": false,
                    "proxy": default_proxy()
                }
            }),
            "moved"
        );
        let mut s = obj(json!({"main": {"discoverRegion": ""}}));
        assert!(migrate_region(&mut s).is_ok(), "region");
        assert_eq!(
            Value::Object(s),
            json!({"main": {"discoverRegion": "", "streamingRegion": "US"}}),
            "defaults when one is missing"
        );
    }

    #[test]
    fn ledger_migrations() {
        let mut s = obj(json!({
            "main": {"hideBlacklisted": true},
            "jobs": {"process-blacklisted-tags": {"schedule": "x"}, "radarr-scan": {"schedule": "0 0 4 * * *"}},
            "network": {"apiRequestTimeout": 10000},
            "migrations": "nope"
        }));
        migrate_blocklist(&mut s);
        assert!(
            release_calendar(&mut s, "0011_release_calendar_sync_5m").is_ok(),
            "0011"
        );
        assert!(
            release_calendar(&mut s, "0012_restore_release_calendar_sync_interval").is_ok(),
            "0012"
        );
        arr_request_timeout(&mut s);
        assert!(arr_scan_interval(&mut s).is_ok(), "0014");
        assert_eq!(
            Value::Object(s),
            json!({
                "main": {"hideBlocklisted": true},
                "jobs": {
                    "radarr-scan": {"schedule": "0 */15 * * * *"},
                    "process-blocklisted-tags": {"schedule": "x"},
                    "release-calendar-sync": {"schedule": "0 0 */6 * * *"},
                    "sonarr-scan": {"schedule": "0 */15 * * * *"}
                },
                "network": {"apiRequestTimeout": 60000},
                "migrations": [
                    "0008_migrate_blacklist_to_blocklist",
                    "0011_release_calendar_sync_5m",
                    "0012_restore_release_calendar_sync_interval",
                    "0013_increase_arr_request_timeout",
                    "0014_arr_scan_15m"
                ]
            }),
            "applied in order"
        );
    }

    #[test]
    fn arr_scan_keeps_custom_schedules() {
        // Ported from 0014_arr_scan_15m.test.ts.
        let mut s =
            obj(json!({"jobs": {"radarr-scan": {"schedule": "0 0 5 * * *"}}, "migrations": []}));
        assert!(arr_scan_interval(&mut s).is_ok(), "0014");
        assert_eq!(
            s.get("jobs"),
            Some(
                &json!({"radarr-scan": {"schedule": "0 0 5 * * *"}, "sonarr-scan": {"schedule": "0 */15 * * * *"}})
            ),
            "an administrator's schedule stays"
        );
        let again = s.clone();
        assert!(arr_scan_interval(&mut s).is_ok(), "0014 twice");
        assert_eq!(s, again, "recorded migrations are skipped");
    }

    #[test]
    fn cleanup_and_guard() {
        let mut s = obj(
            json!({"migrations": ["0009_x", "0010_y", "0007_migrate_arr_tags"], "requestRouting": {}}),
        );
        assert!(drop_request_routing(&mut s).is_ok(), "cleanup");
        assert_eq!(
            Value::Object(s.clone()),
            json!({"migrations": ["0007_migrate_arr_tags"]}),
            "dropped"
        );
        assert!(unsupported(&s).is_empty(), "known");
        let s = obj(json!({"migrations": ["0099_future"]}));
        assert_eq!(
            unsupported(&s),
            vec![String::from("0099_future")],
            "unknown"
        );
    }

    #[test]
    fn lunasea() {
        let mut s =
            obj(json!({"notifications": {"agents": {"email": {}, "lunasea": {"enabled": false}}}}));
        remove_lunasea(&mut s);
        assert_eq!(
            Value::Object(s),
            json!({"notifications": {"agents": {"email": {}}}}),
            "removed"
        );
    }
}
