//! The `/service` reads: the configured Radarr and Sonarr servers.
//!
//! `GET /service/radarr` and `/service/sonarr` list them from settings.json;
//! `GET /service/radarr/{id}` and `/service/sonarr/{id}` add each server's
//! profiles, root folders and tags from the server itself.

use std::future::Future;
use std::pin::Pin;

use serde_json::{Map, Value};

use super::{Outcome, Ready};
use crate::servarr::api_timeout;

type Native<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

/// The fields `GET /service/radarr` copies from each server's settings.
const RADARR_FIELDS: [&str; 6] = [
    "id",
    "name",
    "is4k",
    "isDefault",
    "activeDirectory",
    "activeProfileId",
];

/// The fields `GET /service/sonarr` copies from each server's settings.
const SONARR_FIELDS: [&str; 12] = [
    "id",
    "name",
    "is4k",
    "isDefault",
    "activeDirectory",
    "activeProfileId",
    "activeAnimeProfileId",
    "activeAnimeDirectory",
    "activeLanguageProfileId",
    "activeAnimeLanguageProfileId",
    "metadataLanguageId",
    "animeMetadataLanguageId",
];

/// `GET /service/radarr`: every Radarr server, `activeTags` defaulting to
/// an empty list.
pub(super) fn radarr<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = ctx
            .no_query()
            .and_then(|()| ctx.authenticated(0).map(|_| ()))
        {
            return Outcome::forward(why);
        }
        let Some(servers) = ctx.settings.get("/radarr").and_then(Value::as_array) else {
            return Outcome::forward(String::from("settings.radarr is not a list"));
        };
        let list: Vec<Value> = servers
            .iter()
            .map(|server| {
                let mut out = pick(server, &RADARR_FIELDS);
                out.insert(
                    String::from("activeTags"),
                    match server.get("tags") {
                        None | Some(Value::Null) => Value::Array(Vec::new()),
                        Some(tags) => tags.clone(),
                    },
                );
                Value::Object(out)
            })
            .collect();
        ctx.json(&Value::Array(list))
    })
}

/// `GET /service/sonarr`: every Sonarr server, `activeTags` always empty.
pub(super) fn sonarr<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        if let Err(why) = ctx
            .no_query()
            .and_then(|()| ctx.authenticated(0).map(|_| ()))
        {
            return Outcome::forward(why);
        }
        let Some(servers) = ctx.settings.get("/sonarr").and_then(Value::as_array) else {
            return Outcome::forward(String::from("settings.sonarr is not a list"));
        };
        let list: Vec<Value> = servers
            .iter()
            .map(|server| {
                let mut out = pick(server, &SONARR_FIELDS);
                out.insert(String::from("activeTags"), Value::Array(Vec::new()));
                Value::Object(out)
            })
            .collect();
        ctx.json(&Value::Array(list))
    })
}

/// `GET /service/radarr/{id}`: the server with its quality profiles, root
/// folders and tags. A failing server is Node's 500 with axios's words.
pub(super) fn radarr_detail<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let server = match find_server(ctx, "/radarr") {
            Ok(Some(server)) => server,
            Ok(None) => {
                return ctx.error(404, "Radarr server with provided ID  does not exist.");
            }
            Err(why) => return Outcome::forward(why),
        };
        let timeout = api_timeout(&ctx.settings);
        let client = &ctx.state.servarr;
        let api = "Radarr";
        let profiles = match client.profiles(&server, timeout).await {
            Ok(profiles) => profiles,
            Err(e) => return arr_failed(ctx, api, "profiles", &e),
        };
        let folders = match client.root_folders(&server, timeout).await {
            Ok(folders) => folders,
            Err(e) => return arr_failed(ctx, api, "root folders", &e),
        };
        let tags = match client.tags(&server, timeout).await {
            Ok(tags) => tags,
            Err(e) => return arr_failed(ctx, api, "tags", &e),
        };
        let mut info = pick(&server, &RADARR_FIELDS);
        if let Some(tags) = server.get("tags") {
            info.insert(String::from("activeTags"), tags.clone());
        }
        let mut out = Map::new();
        out.insert(String::from("server"), Value::Object(info));
        out.insert(
            String::from("profiles"),
            picked_list(&profiles, &["id", "name"]),
        );
        out.insert(
            String::from("rootFolders"),
            picked_list(&folders, &["id", "freeSpace", "path", "totalSpace"]),
        );
        out.insert(String::from("tags"), tags);
        ctx.json(&Value::Object(out))
    })
}

/// `GET /service/sonarr/{id}`: like Radarr's, plus language profiles for
/// Sonarr v3 and older, found through the system status, and the metadata
/// languages for Sonarr 5.
pub(super) fn sonarr_detail<'a>(ctx: &'a Ready<'a>) -> Native<'a> {
    Box::pin(async move {
        let server = match find_server(ctx, "/sonarr") {
            Ok(Some(server)) => server,
            Ok(None) => {
                return ctx.error(404, "Sonarr server with provided ID does not exist.");
            }
            Err(why) => return Outcome::forward(why),
        };
        let timeout = api_timeout(&ctx.settings);
        let client = &ctx.state.servarr;
        let api = "Sonarr";
        let status = match client.system_status(&server, timeout).await {
            Ok(status) => status,
            Err(e) => return arr_failed(ctx, api, "system status", &e),
        };
        // `Number(systemStatus.version.split('.')[0])`.
        let Some(version) = status.get("version").and_then(Value::as_str) else {
            return ctx.error(500, &format!("[{api}] The system status has no version."));
        };
        let major = crate::jsval::number_of_str(version.split('.').next().unwrap_or(""));
        let legacy = major <= 3.0;
        let profiles = match client.profiles(&server, timeout).await {
            Ok(profiles) => profiles,
            Err(e) => return arr_failed(ctx, api, "profiles", &e),
        };
        let folders = match client.root_folders(&server, timeout).await {
            Ok(folders) => folders,
            Err(e) => return arr_failed(ctx, api, "root folders", &e),
        };
        let languages = if legacy {
            match client.language_profiles(&server, timeout).await {
                Ok(languages) => Value::Array(languages),
                Err(e) => {
                    tracing::error!(
                        label = "Sonarr API",
                        "Something went wrong while retrieving Sonarr language profiles. {e:#}"
                    );
                    return ctx.error(500, "Failed to get language profiles");
                }
            }
        } else {
            Value::Null
        };
        let metadata_languages = if legacy {
            None
        } else {
            super::arrsettings::sonarr_metadata_languages(client, &server, timeout).await
        };
        let tags = match client.tags(&server, timeout).await {
            Ok(tags) => tags,
            Err(e) => return arr_failed(ctx, api, "tags", &e),
        };
        let mut info = pick(&server, &SONARR_FIELDS);
        if let Some(tags) = server.get("tags") {
            info.insert(String::from("activeTags"), tags.clone());
        }
        if let Some(tags) = server.get("animeTags") {
            info.insert(String::from("activeAnimeTags"), tags.clone());
        }
        let mut out = Map::new();
        out.insert(String::from("server"), Value::Object(info));
        out.insert(
            String::from("profiles"),
            picked_list(&profiles, &["id", "name"]),
        );
        out.insert(
            String::from("rootFolders"),
            picked_list(&folders, &["id", "freeSpace", "path", "totalSpace"]),
        );
        out.insert(String::from("languageProfiles"), languages);
        crate::sonarrmeta::MetadataLanguages::insert_into(metadata_languages.as_ref(), &mut out);
        out.insert(String::from("tags"), tags);
        ctx.json(&Value::Object(out))
    })
}

/// The server in a settings section whose `id` is the path's last
/// segment, which has to be a plain integer (the validator wants a
/// number). `Ok(None)` when no server has that id.
/// A failed `*arr` call through the error handler:
/// `[{apiName}] Failed to retrieve {what}: {axios message}`.
fn arr_failed(ctx: &Ready<'_>, api: &str, what: &str, e: &anyhow::Error) -> Outcome {
    ctx.error(500, &arr_failure(api, what, e))
}

/// The message of [`arr_failed`], which any signed-in user can read.
fn arr_failure(api: &str, what: &str, e: &anyhow::Error) -> String {
    let message = crate::outbound::failure_in(e).unwrap_or_else(|| format!("{e:#}"));
    format!("[{api}] Failed to retrieve {what}: {message}")
}

fn find_server(ctx: &Ready<'_>, section: &str) -> Result<Option<Value>, super::Fallback> {
    ctx.no_query()?;
    ctx.authenticated(0)?;
    // `servers.find((s) => s.id === Number(req.params.id))`.
    let id = super::movie::path_number(ctx, 0)?;
    let servers = ctx
        .settings
        .get(section)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("settings{section} is not a list"))?;
    Ok(servers
        .iter()
        .find(|s| match s.get("id") {
            Some(Value::Number(n)) => n.as_i64() == Some(id),
            _ => false,
        })
        .cloned())
}

/// The listed keys of an object, in that order, skipping ones it lacks
/// (an `undefined` property is left out of JSON).
fn pick(source: &Value, keys: &[&str]) -> Map<String, Value> {
    let mut out = Map::new();
    for key in keys {
        if let Some(value) = source.get(*key) {
            out.insert((*key).to_owned(), value.clone());
        }
    }
    out
}

fn picked_list(items: &[Value], keys: &[&str]) -> Value {
    Value::Array(
        items
            .iter()
            .map(|item| Value::Object(pick(item, keys)))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn picks_in_order_and_skips_missing() {
        let picked = pick(
            &json!({"name": "x", "id": 3, "extra": true, "is4k": null}),
            &RADARR_FIELDS,
        );
        assert_eq!(
            Value::Object(picked),
            json!({"id": 3, "name": "x", "is4k": null}),
            "declared order, nulls kept, missing left out"
        );
    }

    /// One plain HTTP answer with `status` to every connection.
    async fn answering(status: u16) -> std::io::Result<u16> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut request = [0_u8; 4096];
                // One read takes the whole small request; its length isn't needed.
                let _read = stream.read(&mut request).await.ok();
                let answer = format!(
                    "HTTP/1.1 {status} Oops\r\nContent-Type: text/plain\r\nContent-Length: 4\r\nConnection: close\r\n\r\noops"
                );
                stream.write_all(answer.as_bytes()).await.ok();
            }
        });
        Ok(port)
    }

    #[tokio::test]
    async fn failures_leave_the_api_key_out() -> Result<(), Box<dyn std::error::Error>> {
        const KEY: &str = "review-sensitive-service-key";
        let closed = {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
            listener.local_addr()?.port()
        };
        let refusing = answering(500).await?;
        let client = crate::servarr::ServarrClient::new(reqwest::Client::new());
        for port in [closed, refusing] {
            let server = json!({"id": 0, "hostname": "127.0.0.1", "port": port, "useSsl": false, "baseUrl": "/radarr", "apiKey": KEY});
            let failures = [
                client.tags(&server, None).await.err(),
                client.system_status(&server, None).await.err(),
                client
                    .call(
                        &server,
                        reqwest::Method::GET,
                        "/movie",
                        &[("term", String::from("x"))],
                        None,
                        None,
                    )
                    .await
                    .err(),
            ];
            for e in failures {
                let e = e.ok_or("the call should fail")?;
                for text in [
                    arr_failure("Radarr", "tags", &e),
                    format!("{e:#}"),
                    format!("{e:?}"),
                ] {
                    assert!(!text.contains(KEY), "port {port}: {text}");
                    assert!(!text.contains("apikey"), "port {port}: {text}");
                }
            }
        }
        let refused = client
            .tags(
                &json!({"hostname": "127.0.0.1", "port": refusing, "apiKey": KEY}),
                None,
            )
            .await
            .err()
            .ok_or("the call should fail")?;
        assert_eq!(
            arr_failure("Radarr", "tags", &refused),
            "[Radarr] Failed to retrieve tags: Request failed with status code 500",
            "axios' message"
        );
        Ok(())
    }
}
