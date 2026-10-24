//! `plex-refresh-token` (`server/lib/refreshToken.ts`).
//!
//! Pings plex.tv with every user's Plex token so the tokens stay alive. Node starts the pings
//! without waiting for them, so the job ends as soon as they are sent.

use serde_json::Value;

use super::JobCtx;

/// `refreshToken.run()`.
///
/// # Errors
///
/// When the users can't be read.
pub async fn run(job: &JobCtx) -> anyhow::Result<()> {
    let rows = job
        .state
        .db
        .rows(
            r#"SELECT "plexToken" FROM "user" WHERE "plexToken" != ''"#,
            &[],
        )
        .await?;
    for row in rows {
        let Some(token) = row.get("plexToken").and_then(Value::as_str) else {
            continue;
        };
        if token.is_empty() {
            continue;
        }
        tokio::spawn(ping_token(job.state.outbound.clone(), token.to_owned()));
    }
    Ok(())
}

/// `PlexTvAPI.pingToken()`: failures are only logged.
async fn ping_token(client: reqwest::Client, token: String) {
    let sent = client
        .get("https://plex.tv/api/v2/ping")
        .header("X-Plex-Token", token)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("X-Plex-Client-Identifier", uuid_v4())
        .send()
        .await;
    let failure = match sent {
        Err(e) => Some(e.to_string()),
        Ok(res) if !res.status().is_success() => Some(format!(
            "Request failed with status code {}",
            res.status().as_u16()
        )),
        Ok(res) => match res.json::<Value>().await {
            Ok(body) if crate::settings::public::truthy(body.get("pong")) => None,
            Ok(_) | Err(_) => Some(String::from("No pong response")),
        },
    };
    if let Some(message) = failure {
        tracing::error!(
            label = "Plex Refresh Token",
            errorMessage = %message,
            "Failed to ping token"
        );
    }
}

/// `crypto.randomUUID()`.
fn uuid_v4() -> String {
    let mut bytes: [u8; 16] = rand::random();
    if let Some(b) = bytes.get_mut(6) {
        *b = (*b & 0x0f) | 0x40;
    }
    if let Some(b) = bytes.get_mut(8) {
        *b = (*b & 0x3f) | 0x80;
    }
    let mut out = String::with_capacity(36);
    for (i, b) in bytes.iter().enumerate() {
        if matches!(i, 4 | 6 | 8 | 10) {
            out.push('-');
        }
        out.push(char::from_digit(u32::from(b >> 4), 16).unwrap_or('0'));
        out.push(char::from_digit(u32::from(b & 0xf), 16).unwrap_or('0'));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuids() {
        let id = uuid_v4();
        assert_eq!(id.len(), 36, "length");
        assert_eq!(id.chars().nth(14), Some('4'), "version");
    }
}
