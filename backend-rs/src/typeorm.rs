//! The parts of `TypeORM`'s `save()` the user writes depend on, and the small
//! libraries those handlers call (`gravatar-url`, `nanoid`,
//! `Bun.password`, `URLSearchParams`).
//!
//! `save()` compares every assigned column with the row it reloads and only
//! writes the ones that differ (`===` after the column transformer), bumps
//! `updatedAt` when anything did, and afterwards sets every nullable column
//! the entity left `undefined` to `null` — which is what decides whether an
//! omitted body field comes back as `null` or not at all.

use anyhow::{anyhow, Result};
use serde_json::{Map, Value};

use crate::db::{Bind, Db, UserSettingsRecord};

/// `NotificationAgentKey`: the keys the `notificationTypes` transformer keeps.
pub const NOTIFICATION_AGENT_KEYS: [&str; 10] = [
    "discord",
    "email",
    "gotify",
    "ntfy",
    "pushbullet",
    "pushover",
    "slack",
    "telegram",
    "webhook",
    "webpush",
];

/// `DiscoverFilterDefaultsSchema`'s keys in shape order, with whether the
/// value is a boolean (otherwise a non-empty string).
const FILTER_KEYS: [(&str, bool); 27] = [
    ("ignoreWatched", true),
    ("ignoreCollected", true),
    ("ignoreWatchlisted", true),
    ("hideUnmapped", true),
    ("includeNoRating", true),
    ("language", false),
    ("primaryReleaseDateGte", false),
    ("primaryReleaseDateLte", false),
    ("firstAirDateGte", false),
    ("firstAirDateLte", false),
    ("genre", false),
    ("voteAverageGte", false),
    ("voteAverageLte", false),
    ("voteCountGte", false),
    ("voteCountLte", false),
    ("imdbRatingGte", false),
    ("imdbRatingLte", false),
    ("imdbVotesGte", false),
    ("imdbVotesLte", false),
    ("rtCriticsGte", false),
    ("rtCriticsLte", false),
    ("rtAudienceGte", false),
    ("rtAudienceLte", false),
    ("metacriticGte", false),
    ("metacriticLte", false),
    ("traktRatingGte", false),
    ("traktRatingLte", false),
];

/// The `user` columns that are `select: false` and nullable, in column
/// order: `save()` sets them to `null` on an entity it updated.
pub const USER_HIDDEN_COLUMNS: [&str; 5] = [
    "password",
    "resetPasswordGuid",
    "jellyfinDeviceId",
    "jellyfinAuthToken",
    "plexToken",
];

/// The same for `user_settings`.
pub const SETTINGS_HIDDEN_COLUMNS: [&str; 6] = [
    "traktAccessToken",
    "traktRefreshToken",
    "traktTokenExpiresAt",
    "anilistAccessToken",
    "anilistTokenExpiresAt",
    "simklAccessToken",
];

/// JavaScript `===` between two JSON scalars. Objects and arrays are never
/// identical to anything here: they are always fresh values.
#[must_use]
pub fn strict_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::String(x), Value::String(y)) => x == y,
        (Value::Number(x), Value::Number(y)) => match (x.as_i64(), y.as_i64()) {
            (Some(x), Some(y)) => x == y,
            _ => x
                .as_f64()
                .zip(y.as_f64())
                .is_some_and(|(x, y)| (x - y).abs() < f64::EPSILON),
        },
        _ => false,
    }
}

/// The column changes of one entity, in column order.
#[derive(Debug, Clone, Default)]
pub struct Changes {
    /// Column and new value.
    pub sets: Vec<(&'static str, Value)>,
}

impl Changes {
    /// An assignment `entity[column] = new`: nothing for `undefined`,
    /// otherwise a change when it isn't `===` the stored value.
    pub fn assign(&mut self, column: &'static str, new: Option<&Value>, old: &Value) {
        if let Some(new) = new {
            if !strict_eq(new, old) {
                self.sets.push((column, new.clone()));
            }
        }
    }

    /// A change that always counts (a fresh password hash, or a value the
    /// diff compares through a transformer).
    pub fn set(&mut self, column: &'static str, value: Value) {
        self.sets.push((column, value));
    }

    /// Whether anything changed.
    #[must_use]
    pub fn any(&self) -> bool {
        !self.sets.is_empty()
    }

    /// `UPDATE "table" SET ... WHERE "id" = ?`, with `updatedAt` bumped for
    /// tables that have one. `None` when nothing changed.
    ///
    /// # Errors
    ///
    /// Fails for a value that isn't a JSON scalar.
    pub fn update_sql(
        &self,
        table: &str,
        id: i64,
        touch_updated_at: bool,
    ) -> Result<Option<(String, Vec<Bind>)>> {
        if self.sets.is_empty() {
            return Ok(None);
        }
        let mut parts = Vec::with_capacity(self.sets.len() + 1);
        let mut binds = Vec::new();
        for (column, value) in &self.sets {
            parts.push(format!("\"{column}\" = {}", sql_value(value, &mut binds)?));
        }
        if touch_updated_at {
            parts.push(String::from("\"updatedAt\" = CURRENT_TIMESTAMP"));
        }
        binds.push(Bind::Int(id));
        let sql = format!(
            "UPDATE \"{table}\" SET {} WHERE \"id\" = ?{}",
            parts.join(", "),
            binds.len()
        );
        Ok(Some((sql, binds)))
    }
}

/// A JSON scalar as SQL: booleans and null as literals (both databases
/// read `TRUE`/`FALSE`), numbers and text as placeholders.
///
/// A number that isn't an `i64` goes in as its `String(n)` text, which a
/// column's affinity on `SQLite` stores as the bound double would be (an
/// integer column keeps a REAL).
///
/// # Errors
///
/// Fails for arrays and objects.
pub fn sql_value(value: &Value, binds: &mut Vec<Bind>) -> Result<String> {
    match value {
        Value::Null => Ok(String::from("NULL")),
        Value::Bool(true) => Ok(String::from("TRUE")),
        Value::Bool(false) => Ok(String::from("FALSE")),
        Value::Number(n) => {
            binds.push(n.as_i64().map_or_else(
                || Bind::Text(crate::jsval::number_string(crate::jsval::json_number(n))),
                Bind::Int,
            ));
            Ok(format!("?{}", binds.len()))
        }
        Value::String(s) => {
            binds.push(Bind::Text(s.clone()));
            Ok(format!("?{}", binds.len()))
        }
        Value::Array(_) | Value::Object(_) => Err(anyhow!("a non-scalar column value")),
    }
}

/// `INSERT INTO "table" (...) VALUES (...) RETURNING id`.
///
/// # Errors
///
/// Fails for non-scalar values or database errors.
pub async fn insert(db: &Db, table: &str, columns: &[(&str, Value)]) -> Result<i64> {
    let mut binds = Vec::new();
    let mut names = Vec::with_capacity(columns.len());
    let mut values = Vec::with_capacity(columns.len());
    for (column, value) in columns {
        names.push(format!("\"{column}\""));
        values.push(sql_value(value, &mut binds)?);
    }
    let sql = format!(
        "INSERT INTO \"{table}\" ({}) VALUES ({}) RETURNING CAST(\"id\" AS BIGINT)",
        names.join(", "),
        values.join(", ")
    );
    db.scalar(&sql, &binds).await
}

/// Run an update built by [`Changes::update_sql`], if there is one.
///
/// # Errors
///
/// Fails on database errors.
pub async fn run(db: &Db, update: Option<(String, Vec<Bind>)>) -> Result<()> {
    if let Some((sql, binds)) = update {
        db.execute(&sql, &binds).await?;
    }
    Ok(())
}

/// A date column of one row as `TypeORM` prints the reloaded `Date`.
///
/// # Errors
///
/// Fails on database errors or a missing row.
pub async fn date_of(db: &Db, table: &str, column: &str, id: i64) -> Result<Value> {
    let sql = format!(
        "SELECT {} AS \"v\" FROM \"{table}\" WHERE \"id\" = ?1",
        db.iso_sql(&format!("\"{column}\""))
    );
    let rows = db.rows(&sql, &[Bind::Int(id)]).await?;
    rows.into_iter()
        .next()
        .and_then(|mut r| r.shift_remove("v"))
        .ok_or_else(|| anyhow!("row {id} of {table} vanished"))
}

/// The settings row id of a user, if there is one.
///
/// # Errors
///
/// Fails on database errors.
pub async fn settings_id(db: &Db, user_id: i64) -> Result<Option<i64>> {
    let rows = db
        .rows(
            r#"SELECT CAST("id" AS BIGINT) AS "id" FROM "user_settings" WHERE "userId" = ?1"#,
            &[Bind::Int(user_id)],
        )
        .await?;
    Ok(rows
        .first()
        .and_then(|r| r.get("id"))
        .and_then(Value::as_i64))
}

/// `ensureUserSettings`: the user's settings row id, created with the
/// defaults when missing; `None` when the user doesn't exist.
///
/// # Errors
///
/// Fails on database errors.
pub async fn ensure_user_settings(db: &Db, user_id: i64) -> Result<Option<i64>> {
    let exists = db
        .scalar(
            r#"SELECT COUNT(*) FROM "user" WHERE "id" = ?1"#,
            &[Bind::Int(user_id)],
        )
        .await?;
    if exists == 0 {
        return Ok(None);
    }
    if let Some(id) = settings_id(db, user_id).await? {
        return Ok(Some(id));
    }
    let id = insert(
        db,
        "user_settings",
        &[
            ("locale", Value::from("")),
            ("userId", Value::from(user_id)),
        ],
    )
    .await?;
    Ok(Some(id))
}

/// The `notificationTypes` transformer's `to`: unknown agent keys are
/// deleted from the value (which the handler then sends back) and the rest
/// is stringified.
#[must_use]
pub fn notification_types_to(types: &mut Map<String, Value>) -> String {
    strip_unknown_agents(types);
    serde_json::to_string(types).unwrap_or_default()
}

/// The deletion half of the `notificationTypes` transformer.
pub fn strip_unknown_agents(types: &mut Map<String, Value>) {
    types.retain(|k, _| NOTIFICATION_AGENT_KEYS.contains(&k.as_str()));
}

/// The `discordIds` transformer's `to`: `null` for an empty list.
#[must_use]
pub fn discord_ids_to(ids: &[Value]) -> Value {
    json_array_to(&Value::Array(ids.to_vec()))
}

/// `jsonArrayTransformer.to`: `v?.length ? JSON.stringify(v) : null`.
#[must_use]
pub fn json_array_to(v: &Value) -> Value {
    if has_length(v) {
        Value::from(serde_json::to_string(v).unwrap_or_default())
    } else {
        Value::Null
    }
}

/// `v?.length` truthiness, the test `jsonArrayTransformer.to` applies.
fn has_length(v: &Value) -> bool {
    match v {
        Value::Array(a) => !a.is_empty(),
        Value::String(s) => !s.is_empty(),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::Object(_) => false,
    }
}

/// Whether `save()` finds a loaded settings row changed by itself.
///
/// `discordIds` and `discoverFilterDefaults` load as `[]` and `{}` but
/// compare as `null` when stored empty, and `[] !== null`.
#[must_use]
pub fn settings_change_by_itself(s: &UserSettingsRecord) -> bool {
    let discord = crate::user::discord_ids(s.discord_ids.as_deref());
    let filters =
        crate::user::discover_filter_defaults(s.public.discover_filter_defaults.as_deref());
    !has_length(&discord) || filters.as_object().is_some_and(Map::is_empty)
}

/// `DiscoverFilterDefaultsSchema.parse`: the known keys in shape order, or
/// `None` when zod would throw (an unknown key, a wrong type, an empty
/// string).
#[must_use]
pub fn parse_filter_defaults(input: &Map<String, Value>) -> Option<Map<String, Value>> {
    if !input
        .keys()
        .all(|k| FILTER_KEYS.iter().any(|(name, _)| name == k))
    {
        return None;
    }
    let mut out = Map::new();
    for (key, boolean) in FILTER_KEYS {
        match (input.get(key), boolean) {
            (None, _) => {}
            (Some(v @ Value::Bool(_)), true) => {
                out.insert(String::from(key), v.clone());
            }
            (Some(Value::String(s)), false) if !s.is_empty() => {
                out.insert(String::from(key), Value::from(s.as_str()));
            }
            (Some(_), _) => return None,
        }
    }
    Some(out)
}

/// `String.prototype.length`: UTF-16 code units.
#[must_use]
pub fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `URLSearchParams` serialization of one value.
#[must_use]
pub fn form_urlencode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for b in text.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(char::from(b));
            }
            b' ' => out.push('+'),
            other => {
                out.push('%');
                push_hex(&mut out, other, b"0123456789ABCDEF");
            }
        }
    }
    out
}

/// `gravatarUrl(email, { default: 'mm', size: 200 })` (gravatar-url 4).
#[must_use]
pub fn gravatar_url(identifier: &str) -> String {
    let id = if identifier.contains('@') {
        identifier.to_lowercase().trim().to_owned()
    } else {
        identifier.to_owned()
    };
    format!(
        "https://gravatar.com/avatar/{}?default=mm&size=200",
        md5_hex(id.as_bytes())
    )
}

/// `nanoid(16)` with nanoid's URL-safe alphabet.
#[must_use]
pub fn nanoid16() -> String {
    const ALPHABET: &[u8; 64] = b"useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";
    let mut bytes = [0u8; 16];
    if ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes).is_err() {
        tracing::error!("the system random source failed");
    }
    bytes
        .iter()
        .filter_map(|b| ALPHABET.get(usize::from(b & 63)).copied())
        .map(char::from)
        .collect()
}

/// `Bun.password.hash(password, { algorithm: 'bcrypt', cost: 12 })`. Bun
/// pre-hashes passwords over 72 bytes, which callers hand to Node instead.
///
/// # Errors
///
/// Fails when hashing fails.
pub async fn hash_password(password: String) -> Result<String> {
    crate::cpu::run(move || bcrypt::hash(bun_password(&password), 12))
        .await?
        .map_err(|e| anyhow!("bcrypt: {e}"))
}

/// `Bun.password.verify(password, hash)` for a bcrypt hash.
///
/// # Errors
///
/// Fails when the hash can't be checked.
pub async fn verify_password(password: &str, hash: String) -> Result<bool> {
    let password = bun_password(password);
    crate::cpu::run(move || bcrypt::verify(password, &hash))
        .await?
        .map_err(|e| anyhow!("bcrypt: {e}"))
}

/// The bytes `Bun.password` gives bcrypt: the password, or its SHA-512
/// digest when it is longer than bcrypt's 72 bytes (measured: a 100-byte
/// password verifies as the raw digest, NUL bytes pass through).
#[must_use]
pub fn bun_password(password: &str) -> Vec<u8> {
    use sha2::Digest as _;
    if password.len() > 72 {
        sha2::Sha512::digest(password.as_bytes()).to_vec()
    } else {
        password.as_bytes().to_vec()
    }
}

/// Two hex digits of a byte.
fn push_hex(out: &mut String, b: u8, digits: &[u8; 16]) {
    for nibble in [b >> 4, b & 15] {
        if let Some(d) = digits.get(usize::from(nibble)) {
            out.push(char::from(*d));
        }
    }
}

/// MD5 as lowercase hex (RFC 1321).
#[must_use]
pub fn md5_hex(data: &[u8]) -> String {
    const S: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5,
        9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10,
        15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    const K: [u32; 64] = [
        0xd76a_a478,
        0xe8c7_b756,
        0x2420_70db,
        0xc1bd_ceee,
        0xf57c_0faf,
        0x4787_c62a,
        0xa830_4613,
        0xfd46_9501,
        0x6980_98d8,
        0x8b44_f7af,
        0xffff_5bb1,
        0x895c_d7be,
        0x6b90_1122,
        0xfd98_7193,
        0xa679_438e,
        0x49b4_0821,
        0xf61e_2562,
        0xc040_b340,
        0x265e_5a51,
        0xe9b6_c7aa,
        0xd62f_105d,
        0x0244_1453,
        0xd8a1_e681,
        0xe7d3_fbc8,
        0x21e1_cde6,
        0xc337_07d6,
        0xf4d5_0d87,
        0x455a_14ed,
        0xa9e3_e905,
        0xfcef_a3f8,
        0x676f_02d9,
        0x8d2a_4c8a,
        0xfffa_3942,
        0x8771_f681,
        0x6d9d_6122,
        0xfde5_380c,
        0xa4be_ea44,
        0x4bde_cfa9,
        0xf6bb_4b60,
        0xbebf_bc70,
        0x289b_7ec6,
        0xeaa1_27fa,
        0xd4ef_3085,
        0x0488_1d05,
        0xd9d4_d039,
        0xe6db_99e5,
        0x1fa2_7cf8,
        0xc4ac_5665,
        0xf429_2244,
        0x432a_ff97,
        0xab94_23a7,
        0xfc93_a039,
        0x655b_59c3,
        0x8f0c_cc92,
        0xffef_f47d,
        0x8584_5dd1,
        0x6fa8_7e4f,
        0xfe2c_e6e0,
        0xa301_4314,
        0x4e08_11a1,
        0xf753_7e82,
        0xbd3a_f235,
        0x2ad7_d2bb,
        0xeb86_d391,
    ];
    let mut message = data.to_vec();
    let bit_len = u64::try_from(data.len()).unwrap_or(0).wrapping_mul(8);
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_le_bytes());
    let (mut h0, mut h1, mut h2, mut h3) = (
        0x6745_2301_u32,
        0xefcd_ab89_u32,
        0x98ba_dcfe_u32,
        0x1032_5476_u32,
    );
    for chunk in message.chunks_exact(64) {
        let mut words = [0u32; 16];
        for (word, bytes) in words.iter_mut().zip(chunk.chunks_exact(4)) {
            *word = u32::from_le_bytes(bytes.try_into().unwrap_or([0; 4]));
        }
        let mut v = [h0, h1, h2, h3];
        for (step, (ki, si)) in K.iter().zip(S.iter()).enumerate() {
            let [va, vb, vc, vd] = v;
            let (mix, index) = match step / 16 {
                0 => ((vb & vc) | (!vb & vd), step),
                1 => ((vd & vb) | (!vd & vc), (5 * step + 1) % 16),
                2 => (vb ^ vc ^ vd, (3 * step + 5) % 16),
                _ => (vc ^ (vb | !vd), (7 * step) % 16),
            };
            let word = words.get(index).copied().unwrap_or(0);
            let rotated = va
                .wrapping_add(mix)
                .wrapping_add(*ki)
                .wrapping_add(word)
                .rotate_left(*si);
            v = [vd, vb.wrapping_add(rotated), vb, vc];
        }
        let [va, vb, vc, vd] = v;
        h0 = h0.wrapping_add(va);
        h1 = h1.wrapping_add(vb);
        h2 = h2.wrapping_add(vc);
        h3 = h3.wrapping_add(vd);
    }
    [h0, h1, h2, h3].iter().flat_map(|w| w.to_le_bytes()).fold(
        String::with_capacity(32),
        |mut out, b| {
            push_hex(&mut out, b, b"0123456789abcdef");
            out
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn md5_vectors() {
        assert_eq!(md5_hex(b""), "d41d8cd98f00b204e9800998ecf8427e", "empty");
        assert_eq!(
            md5_hex(b"The quick brown fox jumps over the lazy dog"),
            "9e107d9d372bb6826bd81d3542a419d6",
            "fox"
        );
        assert_eq!(
            md5_hex(&[b'a'; 100]),
            "36a92cc94a9e0fa21f625f8bfb007adf",
            "two blocks"
        );
    }

    #[test]
    fn gravatar() {
        assert_eq!(
            gravatar_url("Admin@Seerr.dev"),
            format!(
                "https://gravatar.com/avatar/{}?default=mm&size=200",
                md5_hex(b"admin@seerr.dev")
            ),
            "lower-cased"
        );
        assert_eq!(
            gravatar_url("admin@seerr.dev"),
            "https://gravatar.com/avatar/abe004981d8c301dd39ae36ee1d5d18d?default=mm&size=200",
            "matches a recorded avatar"
        );
    }

    #[test]
    fn nanoid_shape() {
        let id = nanoid16();
        assert_eq!(id.len(), 16, "length");
        assert!(
            id.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
            "alphabet"
        );
    }

    #[test]
    fn urlencode_like_url_search_params() {
        assert_eq!(
            form_urlencode("https://anilist.co/api/v2/oauth/pin"),
            "https%3A%2F%2Fanilist.co%2Fapi%2Fv2%2Foauth%2Fpin",
            "reserved characters"
        );
        assert_eq!(form_urlencode("a b*~"), "a+b*%7E", "space and tilde");
    }

    #[test]
    fn strict_equality() {
        assert!(strict_eq(&json!(5), &json!(5.0)), "numbers");
        assert!(!strict_eq(&json!("5"), &json!(5)), "types");
        assert!(strict_eq(&Value::Null, &Value::Null), "null");
        assert!(!strict_eq(&json!([]), &json!([])), "fresh arrays");
    }

    #[test]
    fn changes_build_sql() {
        let mut c = Changes::default();
        c.assign("username", Some(&json!("a")), &json!("a"));
        assert!(!c.any(), "unchanged");
        c.assign("username", None, &json!("a"));
        assert!(!c.any(), "undefined is skipped");
        c.assign("username", Some(&json!("b")), &json!("a"));
        c.assign("watchlistSyncTv", Some(&json!(true)), &Value::Null);
        let built = c.update_sql("user", 7, true).ok().flatten();
        assert_eq!(
            built.as_ref().map(|(sql, _)| sql.as_str()),
            Some(
                r#"UPDATE "user" SET "username" = ?1, "watchlistSyncTv" = TRUE, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?2"#
            ),
            "sql"
        );
        assert_eq!(built.map(|(_, b)| b.len()), Some(2), "binds");
    }

    #[test]
    fn filter_defaults_parse() {
        let input = json!({"genre": "28", "ignoreWatched": true})
            .as_object()
            .cloned()
            .unwrap_or_default();
        let parsed = parse_filter_defaults(&input);
        assert_eq!(
            parsed.map(Value::Object),
            Some(json!({"ignoreWatched": true, "genre": "28"})),
            "shape order"
        );
        for bad in [
            json!({"genre": ""}),
            json!({"x": 1}),
            json!({"ignoreWatched": "true"}),
        ] {
            let map = bad.as_object().cloned().unwrap_or_default();
            assert!(parse_filter_defaults(&map).is_none(), "{bad} fails");
        }
    }

    #[test]
    fn notification_transformer() {
        let mut types = json!({"discord": 1, "foo": 2, "email": 3})
            .as_object()
            .cloned()
            .unwrap_or_default();
        assert_eq!(
            notification_types_to(&mut types),
            r#"{"discord":1,"email":3}"#,
            "unknown keys dropped"
        );
        assert_eq!(discord_ids_to(&[]), Value::Null, "empty list");
        assert_eq!(
            discord_ids_to(&[json!("1")]),
            json!(r#"["1"]"#),
            "stringified"
        );
    }

    #[test]
    fn settings_phantom_change() {
        let mut s = UserSettingsRecord::default();
        assert!(settings_change_by_itself(&s), "empty columns");
        s.discord_ids = Some(String::from(r#"["1"]"#));
        s.public.discover_filter_defaults = Some(String::from(r#"{"genre":"1"}"#));
        assert!(!settings_change_by_itself(&s), "filled columns");
    }

    #[test]
    fn utf16_length() {
        assert_eq!(js_length("abc"), 3, "ascii");
        assert_eq!(js_length("😀"), 2, "surrogate pair");
    }
}

#[cfg(test)]
mod bun_password_tests {
    use super::bun_password;

    /// Hashes Bun 1.4.1 made (`Bun.password.hashSync(pw, { algorithm:
    /// 'bcrypt', cost: 4 })`).
    #[test]
    fn verifies_bun_hashes() {
        let long = "a".repeat(100);
        assert_eq!(
            bcrypt::verify(
                bun_password(&long),
                "$2b$04$ZAkOCMoMSkTU0GvKeR2nP.7rT30Czqiwm.O/6QeddRbZBmfZ8ZUkG"
            )
            .ok(),
            Some(true),
            "a long password goes in as its SHA-512 digest"
        );
        assert_eq!(
            bcrypt::verify(
                bun_password("ab\0cd"),
                "$2b$04$q.LopxKB3e4RlLMvTwYyGOQyXisDnNO8OQqWrxfZ.utp8PRRToU.C"
            )
            .ok(),
            Some(true),
            "NUL bytes are kept"
        );
    }
}
