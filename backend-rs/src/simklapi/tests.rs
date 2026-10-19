use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::*;

/// One request the stub received.
#[derive(Debug, Clone)]
struct Seen {
    path: String,
    authorization: Option<String>,
    body: String,
}

impl Seen {
    fn form(&self, key: &str) -> Option<String> {
        self.body.split('&').find_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            (k == key).then(|| v.replace('+', " ").replace("%3A", ":"))
        })
    }
}

type Reply = Pin<Box<dyn Future<Output = (u16, Value)> + Send>>;
type Handler = Arc<dyn Fn(Seen) -> Reply + Send + Sync>;

/// A Simkl stand-in answering every request through `handler`; the
/// requests it saw, in order.
struct Stub {
    base: String,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Stub {
    async fn start(handler: Handler) -> std::io::Result<Self> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", listener.local_addr()?);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let handler = Arc::clone(&handler);
                let log = Arc::clone(&log);
                tokio::spawn(async move {
                    let Some(request) = read_request(&mut stream).await else {
                        return;
                    };
                    guard(&log).push(request.clone());
                    let (status, body) = handler(request).await;
                    let body = body.to_string();
                    let reply = format!(
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    stream.write_all(reply.as_bytes()).await.ok();
                });
            }
        });
        Ok(Self { base, seen })
    }

    fn paths(&self) -> Vec<String> {
        guard(&self.seen).iter().map(|s| s.path.clone()).collect()
    }

    fn requests(&self) -> Vec<Seen> {
        guard(&self.seen).clone()
    }
}

async fn read_request(stream: &mut tokio::net::TcpStream) -> Option<Seen> {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buffer.extend_from_slice(chunk.get(..n)?);
        let text = String::from_utf8_lossy(&buffer).into_owned();
        let Some((head, body)) = text.split_once("\r\n\r\n") else {
            continue;
        };
        let length = head
            .lines()
            .find_map(|l| {
                let (k, v) = l.split_once(':')?;
                k.eq_ignore_ascii_case("content-length")
                    .then(|| v.trim().parse::<usize>().ok())
                    .flatten()
            })
            .unwrap_or(0);
        if body.len() < length {
            continue;
        }
        let target = head.lines().next()?.split(' ').nth(1)?;
        let authorization = head.lines().find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.eq_ignore_ascii_case("authorization")
                .then(|| v.trim().to_owned())
        });
        return Some(Seen {
            path: target.split('?').next()?.to_owned(),
            authorization,
            body: body.to_owned(),
        });
    }
}

fn handler<F>(f: F) -> Handler
where
    F: Fn(&Seen) -> (u16, Value) + Send + Sync + 'static,
{
    Arc::new(move |seen| {
        let answer = f(&seen);
        Box::pin(async move { answer })
    })
}

fn config(stub: &Stub) -> Config {
    if rustls::crypto::ring::default_provider()
        .install_default()
        .is_err()
    {
        tracing::trace!("a provider was installed");
    }
    Config::new(&reqwest::Client::new(), "test-client", "1.0.0", None).with_base(&stub.base)
}

fn oauth_error(status: u16, code: &str) -> (u16, Value) {
    (status, json!({ "error": code, "error_description": code }))
}

fn v2_tokens() -> (u16, Value) {
    (
        200,
        json!({
            "access_token": "simkl_at_new",
            "token_type": "Bearer",
            "expires_in": 604_800,
            "refresh_token": "simkl_rt_refresh",
            "scope": "media:read media:write",
        }),
    )
}

async fn memory_db() -> anyhow::Result<Db> {
    let db = Db::Sqlite(
        sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?,
    );
    for sql in [
        r#"CREATE TABLE "user_settings" ("id" integer PRIMARY KEY, "userId" integer, "simklAccessToken" varchar, "simklRefreshToken" varchar, "simklTokenExpiresAt" bigint, "simklUsername" varchar, "simklUserId" varchar)"#,
        r#"CREATE TABLE "simkl_sync_item" ("id" integer PRIMARY KEY, "userId" integer)"#,
        r#"CREATE TABLE "simkl_sync_state" ("id" integer PRIMARY KEY, "userId" integer)"#,
    ] {
        db.execute(sql, &[]).await?;
    }
    Ok(db)
}

/// User 7, linked through AUTH V2 with a token expiring in `expires_in`
/// seconds.
async fn link_v2(db: &Db, expires_in: i64) -> anyhow::Result<()> {
    db.execute(
        r#"INSERT INTO "user_settings" VALUES (3, 7, 'simkl_at_old', 'simkl_rt_refresh', ?1, 'name', '4242')"#,
        &[Bind::Int(now_seconds() + expires_in)],
    )
    .await?;
    db.execute(r#"INSERT INTO "simkl_sync_item" VALUES (1, 7)"#, &[])
        .await?;
    Ok(())
}

async fn stored(db: &Db) -> anyhow::Result<(Value, Value, Value)> {
    let rows = db
        .rows(
            r#"SELECT "simklAccessToken", "simklRefreshToken", "simklUserId" FROM "user_settings" WHERE "id" = 3"#,
            &[],
        )
        .await?;
    let row = rows.into_iter().next().unwrap_or_default();
    let get = |k: &str| row.get(k).cloned().unwrap_or(Value::Null);
    Ok((
        get("simklAccessToken"),
        get("simklRefreshToken"),
        get("simklUserId"),
    ))
}

#[test]
fn error_details_read_like_simkl_error_detail() {
    assert_eq!(
        error_detail(&json!({"error": "client_id_failed", "message": "Your client_id is wrong"}))
            .as_deref(),
        Some("client_id_failed — Your client_id is wrong"),
        "V1"
    );
    assert_eq!(
        error_detail(&json!({"error": "invalid_client", "error_description": "Unknown client"}))
            .as_deref(),
        Some("invalid_client — Unknown client"),
        "V2"
    );
    assert_eq!(
        error_detail(&Value::from(
            "<html><body><h1>400 Bad Request</h1>\n<p>Invalid header</p></body></html>"
        ))
        .as_deref(),
        Some("400 Bad Request Invalid header"),
        "a proxy's page"
    );
    assert_eq!(error_detail(&Value::from("")), None, "empty");
    assert_eq!(error_detail(&json!({})), None, "no fields");
    assert_eq!(
        error_detail(&json!({"error": "bad", "message": "x".repeat(500)}))
            .map(|d| d.chars().count()),
        Some(200),
        "capped"
    );
    assert_eq!(
        Failure::Rejected {
            status: 412,
            detail: Some(String::from("client_id_failed — wrong")),
        }
        .message(),
        "Simkl rejected the request (HTTP 412): client_id_failed — wrong"
    );
}

#[tokio::test]
async fn validates_a_v2_client_id_against_the_device_endpoint() -> anyhow::Result<()> {
    let stub = Stub::start(handler(|_| {
        (
            200,
            json!({"device_code": "secret", "user_code": "BDWP-HQPK"}),
        )
    }))
    .await?;
    config(&stub).anonymous().validate_client_id().await?;
    assert_eq!(stub.paths(), ["/oauth2/device"]);
    let request = stub.requests().remove(0);
    assert_eq!(request.form("client_id").as_deref(), Some("test-client"));
    assert_eq!(
        request.form("scope").as_deref(),
        Some("media:read media:write"),
        "Foreseerr writes history and ratings"
    );
    Ok(())
}

#[tokio::test]
async fn validates_a_v1_client_id_against_the_pin_endpoint() -> anyhow::Result<()> {
    let stub = Stub::start(handler(|seen| {
        if seen.path == "/oauth2/device" {
            oauth_error(401, "invalid_client")
        } else {
            (200, json!({"result": "OK", "user_code": "ABCDE"}))
        }
    }))
    .await?;
    config(&stub).anonymous().validate_client_id().await?;
    assert_eq!(stub.paths(), ["/oauth2/device", "/oauth/pin"]);
    Ok(())
}

#[tokio::test]
async fn reports_an_unknown_client_id_with_the_v1_reason() -> anyhow::Result<()> {
    let stub = Stub::start(handler(|seen| {
        if seen.path == "/oauth2/device" {
            oauth_error(401, "invalid_client")
        } else {
            (
                412,
                json!({"error": "client_id_failed", "message": "Your client_id is wrong"}),
            )
        }
    }))
    .await?;
    let failure = config(&stub)
        .anonymous()
        .validate_client_id()
        .await
        .err()
        .ok_or_else(|| anyhow::anyhow!("accepted"))?;
    assert!(failure.is_request_error());
    assert_eq!(
        failure.message(),
        "Simkl rejected the request (HTTP 412): client_id_failed — Your client_id is wrong"
    );
    Ok(())
}

#[tokio::test]
async fn exposes_the_oauth_error_code() -> anyhow::Result<()> {
    let stub = Stub::start(handler(|_| oauth_error(400, "slow_down"))).await?;
    let failure = config(&stub)
        .anonymous()
        .poll_device_token("secret")
        .await
        .err()
        .ok_or_else(|| anyhow::anyhow!("no error"))?;
    assert_eq!(failure.oauth_code(), Some("slow_down"));
    let request = stub.requests().remove(0);
    assert_eq!(request.form("device_code").as_deref(), Some("secret"));
    assert_eq!(
        request.form("grant_type").as_deref(),
        Some(DEVICE_GRANT),
        "the device grant"
    );
    Ok(())
}

#[test]
fn token_columns_follow_simkl_token_columns() {
    let (access, refresh, expires_at) = token_columns(&json!({"access_token": "v1"}));
    assert_eq!(
        (access, refresh, expires_at),
        (Value::from("v1"), Value::Null, Value::Null),
        "a V1 token neither refreshes nor expires"
    );
    let (_, refresh, expires_at) = token_columns(&v2_tokens().1);
    assert_eq!(refresh, Value::from("simkl_rt_refresh"));
    let left = expires_at.as_i64().unwrap_or_default() - now_seconds();
    assert!((left - 604_800).abs() < 60, "{left}");
}

#[tokio::test]
async fn refreshes_once_for_concurrent_callers() -> anyhow::Result<()> {
    let db = memory_db().await?;
    link_v2(&db, 60).await?;
    let stub = Stub::start(handler(|_| v2_tokens())).await?;
    let config = config(&stub);
    let (first, second) = tokio::join!(
        refresh_user_tokens(&db, &config, 7, "simkl_at_old"),
        refresh_user_tokens(&db, &config, 7, "simkl_at_old"),
    );
    assert_eq!(first?.access_token, "simkl_at_new");
    assert_eq!(second?.access_token, "simkl_at_new");
    assert_eq!(stub.paths(), ["/oauth2/token"], "one refresh");
    let request = stub.requests().remove(0);
    assert_eq!(request.form("grant_type").as_deref(), Some("refresh_token"));
    assert_eq!(
        request.form("refresh_token").as_deref(),
        Some("simkl_rt_refresh")
    );
    let (access, refresh, _) = stored(&db).await?;
    assert_eq!(access, Value::from("simkl_at_new"));
    assert_eq!(refresh, Value::from("simkl_rt_refresh"), "non-rotating");
    Ok(())
}

#[tokio::test]
async fn unlinks_when_simkl_rejects_the_refresh_token() -> anyhow::Result<()> {
    let db = memory_db().await?;
    link_v2(&db, 60).await?;
    let stub = Stub::start(handler(|_| oauth_error(400, "invalid_grant"))).await?;
    let failure = refresh_user_tokens(&db, &config(&stub), 7, "simkl_at_old").await;
    assert_eq!(failure, Err(Failure::Unauthorized));
    assert_eq!(
        stored(&db).await?,
        (Value::Null, Value::Null, Value::Null),
        "unlinked"
    );
    let items = db
        .scalar(r#"SELECT COUNT(*) FROM "simkl_sync_item""#, &[])
        .await?;
    assert_eq!(items, 0, "sync cache cleared");
    Ok(())
}

#[tokio::test]
async fn keeps_the_link_through_a_temporary_failure() -> anyhow::Result<()> {
    let db = memory_db().await?;
    link_v2(&db, 60).await?;
    let stub = Stub::start(handler(|_| (503, Value::from("down")))).await?;
    let failure = refresh_user_tokens(&db, &config(&stub), 7, "simkl_at_old").await;
    assert_eq!(failure, Err(Failure::Unavailable));
    assert_eq!(stored(&db).await?.1, Value::from("simkl_rt_refresh"));
    Ok(())
}

#[tokio::test]
async fn does_not_restore_a_link_removed_mid_refresh() -> anyhow::Result<()> {
    let db = memory_db().await?;
    link_v2(&db, 60).await?;
    let unlink = db.clone();
    let stub = Stub::start(Arc::new(move |_| {
        let db = unlink.clone();
        Box::pin(async move {
            clear_credentials(&db, 3, None).await.ok();
            v2_tokens()
        })
    }))
    .await?;
    let failure = refresh_user_tokens(&db, &config(&stub), 7, "simkl_at_old").await;
    assert_eq!(failure, Err(Failure::Unauthorized));
    assert_eq!(stored(&db).await?, (Value::Null, Value::Null, Value::Null));
    Ok(())
}

#[tokio::test]
async fn leaves_a_newer_link_alone_when_the_old_grant_is_rejected() -> anyhow::Result<()> {
    let db = memory_db().await?;
    link_v2(&db, 60).await?;
    let relink = db.clone();
    let stub = Stub::start(Arc::new(move |_| {
        let db = relink.clone();
        Box::pin(async move {
            db.execute(
                r#"UPDATE "user_settings" SET "simklAccessToken" = 'simkl_at_relinked' WHERE "id" = 3"#,
                &[],
            )
            .await
            .ok();
            oauth_error(400, "invalid_grant")
        })
    }))
    .await?;
    let failure = refresh_user_tokens(&db, &config(&stub), 7, "simkl_at_old").await;
    assert_eq!(failure, Err(Failure::Unauthorized));
    let (access, _, user) = stored(&db).await?;
    assert_eq!(access, Value::from("simkl_at_relinked"));
    assert_eq!(user, Value::from("4242"));
    Ok(())
}

#[tokio::test]
async fn refreshes_a_token_about_to_expire_before_using_it() -> anyhow::Result<()> {
    let db = memory_db().await?;
    link_v2(&db, 60).await?;
    let stub = Stub::start(handler(|seen| {
        if seen.path == "/oauth2/token" {
            v2_tokens()
        } else {
            (200, json!({"all": 1}))
        }
    }))
    .await?;
    let client = user_client(&db, &config(&stub), 7)
        .await
        .map_err(anyhow::Error::msg)?;
    client.request("/sync/activities", None).await?;
    client.request("/sync/activities", None).await?;
    assert_eq!(
        stub.paths(),
        ["/oauth2/token", "/sync/activities", "/sync/activities"]
    );
    let used: Vec<_> = stub
        .requests()
        .into_iter()
        .filter(|s| s.path == "/sync/activities")
        .map(|s| s.authorization)
        .collect();
    assert_eq!(
        used,
        [
            Some(String::from("Bearer simkl_at_new")),
            Some(String::from("Bearer simkl_at_new"))
        ]
    );
    Ok(())
}

#[tokio::test]
async fn keeps_a_valid_token_when_an_early_refresh_fails() -> anyhow::Result<()> {
    let db = memory_db().await?;
    link_v2(&db, 3600).await?;
    let stub = Stub::start(handler(|seen| {
        if seen.path == "/oauth2/token" {
            (503, Value::from("down"))
        } else {
            (200, json!({"all": 1}))
        }
    }))
    .await?;
    let client = user_client(&db, &config(&stub), 7)
        .await
        .map_err(anyhow::Error::msg)?;
    assert_eq!(
        client.request("/sync/activities", None).await?,
        json!({"all": 1})
    );
    let last = stub.requests().pop().and_then(|s| s.authorization);
    assert_eq!(last.as_deref(), Some("Bearer simkl_at_old"));
    Ok(())
}

#[tokio::test]
async fn fails_when_an_expired_token_cannot_be_refreshed() -> anyhow::Result<()> {
    let db = memory_db().await?;
    link_v2(&db, -60).await?;
    let stub = Stub::start(handler(|_| (503, Value::from("down")))).await?;
    let client = user_client(&db, &config(&stub), 7)
        .await
        .map_err(anyhow::Error::msg)?;
    assert_eq!(
        client.request("/sync/activities", None).await,
        Err(Failure::Unavailable)
    );
    assert_eq!(
        stub.paths(),
        ["/oauth2/token"],
        "no request with a dead token"
    );
    Ok(())
}

#[tokio::test]
async fn refreshes_once_after_a_401_and_repeats_the_request() -> anyhow::Result<()> {
    let db = memory_db().await?;
    link_v2(&db, 86_400 * 6).await?;
    let stub = Stub::start(handler(|seen| {
        if seen.path == "/oauth2/token" {
            v2_tokens()
        } else if seen.authorization.as_deref() == Some("Bearer simkl_at_new") {
            (200, json!({"all": 1}))
        } else {
            (401, json!({}))
        }
    }))
    .await?;
    let client = user_client(&db, &config(&stub), 7)
        .await
        .map_err(anyhow::Error::msg)?;
    assert_eq!(
        client.request("/sync/activities", None).await?,
        json!({"all": 1})
    );
    assert_eq!(
        stub.paths(),
        ["/sync/activities", "/oauth2/token", "/sync/activities"]
    );
    assert_eq!(
        stored(&db).await?.0,
        Value::from("simkl_at_new"),
        "still linked"
    );
    Ok(())
}

#[tokio::test]
async fn gives_up_when_the_refreshed_token_is_rejected_too() -> anyhow::Result<()> {
    let db = memory_db().await?;
    link_v2(&db, 86_400 * 6).await?;
    let stub = Stub::start(handler(|seen| {
        if seen.path == "/oauth2/token" {
            v2_tokens()
        } else {
            (401, json!({}))
        }
    }))
    .await?;
    let client = user_client(&db, &config(&stub), 7)
        .await
        .map_err(anyhow::Error::msg)?;
    assert_eq!(
        client.request("/sync/activities", None).await,
        Err(Failure::Unauthorized)
    );
    assert_eq!(
        stub.paths(),
        ["/sync/activities", "/oauth2/token", "/sync/activities"]
    );
    assert_eq!(
        stored(&db).await?,
        (Value::Null, Value::Null, Value::Null),
        "unlinked"
    );
    Ok(())
}

#[tokio::test]
async fn a_v1_link_never_refreshes() -> anyhow::Result<()> {
    let db = memory_db().await?;
    db.execute(
        r#"INSERT INTO "user_settings" VALUES (3, 7, 'v1-token', NULL, NULL, 'name', '4242')"#,
        &[],
    )
    .await?;
    let stub = Stub::start(handler(|_| (401, json!({})))).await?;
    let client = user_client(&db, &config(&stub), 7)
        .await
        .map_err(anyhow::Error::msg)?;
    assert_eq!(
        client.request("/sync/activities", None).await,
        Err(Failure::Unauthorized)
    );
    assert_eq!(stub.paths(), ["/sync/activities"], "no refresh attempt");
    assert_eq!(stored(&db).await?.0, Value::Null, "the 401 unlinked it");
    Ok(())
}
