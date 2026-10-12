//! Reading a backend's database as plain JSON rows, for diffing.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use base64::Engine;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

/// Where a target keeps its data.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DbSpec {
    /// A `SQLite` file.
    Sqlite {
        /// Path to the database file.
        path: PathBuf,
    },
    /// A Postgres database.
    Postgres {
        /// Connection URL.
        url: String,
    },
}

/// All rows of one table.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TableDump {
    /// Column names in table order.
    pub columns: Vec<String>,
    /// Primary key columns; empty means rows are matched by content.
    pub key: Vec<String>,
    /// Rows ordered by primary key.
    pub rows: Vec<Map<String, Value>>,
}

/// Every table, by name.
pub type DbDump = BTreeMap<String, TableDump>;

/// Tables and columns left out of digests and diffs.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DbFilter {
    /// Table names; entries may end in `*` to match a prefix (`mapping_*`).
    #[serde(default)]
    pub ignore_tables: Vec<String>,
    /// `column` (any table) or `table.column`.
    #[serde(default)]
    pub ignore_columns: Vec<String>,
}

impl DbFilter {
    /// Whether `table` is left out entirely.
    #[must_use]
    pub fn skips_table(&self, table: &str) -> bool {
        let table = table.to_ascii_lowercase();
        self.ignore_tables.iter().any(|t| {
            let t = t.to_ascii_lowercase();
            t.strip_suffix('*')
                .map_or_else(|| t == table, |prefix| table.starts_with(prefix))
        })
    }

    /// Whether `column` of `table` is left out.
    #[must_use]
    pub fn skips_column(&self, table: &str, column: &str) -> bool {
        self.ignore_columns.iter().any(|c| match c.split_once('.') {
            Some((t, col)) => t.eq_ignore_ascii_case(table) && col.eq_ignore_ascii_case(column),
            None => c.eq_ignore_ascii_case(column),
        })
    }
}

/// Read every table (minus filtered ones) as JSON rows.
///
/// # Errors
///
/// Fails when the database can't be opened or queried.
pub async fn dump(spec: &DbSpec, filter: &DbFilter) -> Result<DbDump> {
    match spec {
        DbSpec::Sqlite { path } => {
            let path = path.clone();
            let filter = filter.clone();
            tokio::task::spawn_blocking(move || dump_sqlite(&path, &filter)).await?
        }
        DbSpec::Postgres { url } => dump_postgres(url, filter).await,
    }
}

/// `rows:hash` per table, ignoring filtered tables and columns. Computed
/// without materialising rows, so it is cheap enough to run after every write.
///
/// # Errors
///
/// Fails when the database can't be opened or queried.
pub async fn digests(spec: &DbSpec, filter: &DbFilter) -> Result<BTreeMap<String, String>> {
    match spec {
        DbSpec::Sqlite { path } => {
            let path = path.clone();
            let filter = filter.clone();
            tokio::task::spawn_blocking(move || digests_sqlite(&path, &filter)).await?
        }
        DbSpec::Postgres { url } => digests_postgres(url, filter).await,
    }
}

/// Identity of a row inside its table.
#[must_use]
pub fn row_key(td: &TableDump, row: &Map<String, Value>) -> String {
    if td.key.is_empty() {
        let hash =
            crate::model::sha256_hex(serde_json::to_string(row).unwrap_or_default().as_bytes());
        return format!("#{}", hash.get(..16).unwrap_or(&hash));
    }
    td.key
        .iter()
        .map(|k| match row.get(k) {
            Some(Value::String(s)) => s.clone(),
            Some(v) => v.to_string(),
            None => "null".into(),
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn order_by(key: &[String], fallback: &str) -> String {
    if key.is_empty() {
        fallback.to_owned()
    } else {
        key.iter().map(|k| quote(k)).collect::<Vec<_>>().join(", ")
    }
}

fn open_sqlite(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("opening {}", path.display()))?;
    conn.busy_timeout(std::time::Duration::from_secs(10))?;
    Ok(conn)
}

fn sqlite_tables(conn: &Connection) -> Result<Vec<String>> {
    let tables = conn
        .prepare(
            "SELECT name FROM sqlite_master \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(tables)
}

/// Column names and primary key columns (in key order).
fn sqlite_columns(conn: &Connection, table: &str) -> Result<(Vec<String>, Vec<String>)> {
    let mut columns = Vec::new();
    let mut key: Vec<(i64, String)> = Vec::new();
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", quote(table)))?;
    let mut rows = stmt.query([])?;
    while let Some(r) = rows.next()? {
        let name: String = r.get(1)?;
        let pk: i64 = r.get(5)?;
        if pk > 0 {
            key.push((pk, name.clone()));
        }
        columns.push(name);
    }
    key.sort();
    Ok((columns, key.into_iter().map(|(_, n)| n).collect()))
}

fn sqlite_value(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(n) => Value::from(n),
        ValueRef::Real(f) => Value::from(f),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Value::String(format!(
            "base64:{}",
            base64::engine::general_purpose::STANDARD.encode(b)
        )),
    }
}

fn dump_sqlite(path: &Path, filter: &DbFilter) -> Result<DbDump> {
    let conn = open_sqlite(path)?;
    let mut out = DbDump::new();
    for table in sqlite_tables(&conn)? {
        if filter.skips_table(&table) {
            continue;
        }
        let (columns, key) = sqlite_columns(&conn, &table)?;
        let sql = format!(
            "SELECT * FROM {} ORDER BY {}",
            quote(&table),
            order_by(&key, "rowid")
        );
        let mut stmt = conn.prepare(&sql)?;
        let names: Vec<String> = stmt
            .column_names()
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        let mut rows = stmt.query([])?;
        let mut dumped = Vec::new();
        while let Some(r) = rows.next()? {
            let mut obj = Map::new();
            for (i, name) in names.iter().enumerate() {
                obj.insert(name.clone(), sqlite_value(r.get_ref(i)?));
            }
            dumped.push(obj);
        }
        out.insert(
            table,
            TableDump {
                columns,
                key,
                rows: dumped,
            },
        );
    }
    Ok(out)
}

fn digests_sqlite(path: &Path, filter: &DbFilter) -> Result<BTreeMap<String, String>> {
    let conn = open_sqlite(path)?;
    let mut out = BTreeMap::new();
    for table in sqlite_tables(&conn)? {
        if filter.skips_table(&table) {
            continue;
        }
        let (columns, key) = sqlite_columns(&conn, &table)?;
        let kept: Vec<String> = columns
            .iter()
            .filter(|c| !filter.skips_column(&table, c))
            .map(|c| quote(c))
            .collect();
        let select = if kept.is_empty() {
            String::from("1")
        } else {
            kept.join(", ")
        };
        let mut stmt = conn.prepare(&format!(
            "SELECT {select} FROM {} ORDER BY {}",
            quote(&table),
            order_by(&key, "rowid")
        ))?;
        let n = stmt.column_count();
        let mut rows = stmt.query([])?;
        let mut hasher = Sha256::new();
        let mut count = 0usize;
        while let Some(r) = rows.next()? {
            count += 1;
            for i in 0..n {
                hash_value(&mut hasher, r.get_ref(i)?);
            }
            hasher.update(b"\n");
        }
        let hash = crate::model::hex(hasher.finalize().get(..8).unwrap_or_default());
        out.insert(table, format!("{count}:{hash}"));
    }
    Ok(out)
}

/// Timestamps are hashed as a bare marker: wall-clock values written "now"
/// differ by milliseconds between targets and would make every checkpoint
/// disagree. The final row-by-row diff still compares them, with tolerance.
fn hash_value(hasher: &mut Sha256, v: ValueRef<'_>) {
    match v {
        ValueRef::Null => hasher.update(b"N"),
        ValueRef::Integer(n) => {
            hasher.update(b"I");
            hasher.update(n.to_le_bytes());
        }
        ValueRef::Real(f) => {
            hasher.update(b"R");
            hasher.update(f.to_le_bytes());
        }
        ValueRef::Text(t)
            if std::str::from_utf8(t).is_ok_and(crate::jsondiff::looks_like_timestamp) =>
        {
            hasher.update(b"D");
        }
        ValueRef::Text(t) | ValueRef::Blob(t) => {
            hasher.update(b"T");
            hasher.update(u64::try_from(t.len()).unwrap_or(u64::MAX).to_le_bytes());
            hasher.update(t);
        }
    }
}

/// Postgres regex for the text form of a timestamp.
const PG_TIMESTAMP: &str =
    r"\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)?";

async fn pg_connect(url: &str) -> Result<tokio_postgres::Client> {
    let (client, conn) = tokio_postgres::connect(url, tokio_postgres::NoTls)
        .await
        .context("connecting to postgres")?;
    tokio::spawn(async move {
        if let Err(e) = conn.await {
            tracing::warn!("postgres connection: {e}");
        }
    });
    Ok(client)
}

async fn pg_strings(
    client: &tokio_postgres::Client,
    sql: &str,
    params: &[&(dyn tokio_postgres::types::ToSql + Sync)],
) -> Result<Vec<String>> {
    client
        .query(sql, params)
        .await?
        .iter()
        .map(|r| r.try_get::<_, String>(0).map_err(anyhow::Error::from))
        .collect()
}

async fn pg_tables(client: &tokio_postgres::Client) -> Result<Vec<String>> {
    pg_strings(
        client,
        "SELECT table_name::text FROM information_schema.tables \
         WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY 1",
        &[],
    )
    .await
}

async fn pg_columns(client: &tokio_postgres::Client, table: &str) -> Result<Vec<String>> {
    pg_strings(
        client,
        "SELECT column_name::text FROM information_schema.columns \
         WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position",
        &[&table],
    )
    .await
}

async fn dump_postgres(url: &str, filter: &DbFilter) -> Result<DbDump> {
    let client = pg_connect(url).await?;
    let mut out = DbDump::new();
    for table in pg_tables(&client).await? {
        if filter.skips_table(&table) {
            continue;
        }
        let quoted = quote(&table);
        let columns = pg_columns(&client, &table).await?;
        let key = pg_strings(
            &client,
            "SELECT a.attname::text FROM pg_index i \
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) \
             WHERE i.indrelid = $1::text::regclass AND i.indisprimary \
             ORDER BY array_position(i.indkey, a.attnum)",
            &[&quoted],
        )
        .await?;
        let sql = format!(
            "SELECT row_to_json(t)::text FROM {quoted} t ORDER BY {}",
            order_by(&key, "1")
        );
        let mut rows = Vec::new();
        for text in pg_strings(&client, &sql, &[]).await? {
            if let Value::Object(obj) = serde_json::from_str(&text)? {
                rows.push(obj);
            }
        }
        out.insert(table, TableDump { columns, key, rows });
    }
    Ok(out)
}

async fn digests_postgres(url: &str, filter: &DbFilter) -> Result<BTreeMap<String, String>> {
    let client = pg_connect(url).await?;
    let mut out = BTreeMap::new();
    for table in pg_tables(&client).await? {
        if filter.skips_table(&table) {
            continue;
        }
        let kept: Vec<String> = pg_columns(&client, &table)
            .await?
            .iter()
            .filter(|c| !filter.skips_column(&table, c))
            .map(|c| quote(c))
            .collect();
        let row = if kept.is_empty() {
            String::from("ROW(1)")
        } else {
            format!("ROW({})", kept.join(", "))
        };
        // Hash in the database; order by the row text so no key lookup is
        // needed. Timestamps are masked, as in `hash_value`.
        let sql = format!(
            "SELECT count(*), coalesce(md5(string_agg(r, E'\\n' ORDER BY r)), '') \
             FROM (SELECT regexp_replace({row}::text, '{PG_TIMESTAMP}', 'D', 'g') AS r FROM {}) s",
            quote(&table)
        );
        let r = client.query_one(&sql, &[]).await?;
        let count: i64 = r.try_get(0)?;
        let hash: String = r.try_get(1)?;
        out.insert(
            table,
            format!("{count}:{}", hash.chars().take(16).collect::<String>()),
        );
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters() {
        let f = DbFilter {
            ignore_tables: vec!["session".into(), "mapping_*".into()],
            ignore_columns: vec!["updatedAt".into(), "media.status".into()],
        };
        assert!(f.skips_table("Session"), "exact, case-insensitive");
        assert!(f.skips_table("mapping_edge"), "prefix");
        assert!(!f.skips_table("media"), "not listed");
        assert!(f.skips_column("user", "updatedAt"), "any table");
        assert!(f.skips_column("media", "status"), "table.column");
        assert!(!f.skips_column("user", "status"), "other table's column");
    }

    #[test]
    fn digests_ignore_filtered_columns() -> Result<()> {
        let dir = std::env::temp_dir().join(format!("shadow-db-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir)?;
        let make = |name: &str, updated: &str| -> Result<PathBuf> {
            let path = dir.join(name);
            let conn = Connection::open(&path)?;
            conn.execute_batch(&format!(
                "DROP TABLE IF EXISTS t; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, updatedAt TEXT);\
                 INSERT INTO t VALUES (1, 'a', '{updated}');"
            ))?;
            Ok(path)
        };
        let jan = make("a.sqlite", "2026-01-01")?;
        let feb = make("b.sqlite", "2026-02-02")?;
        let strict = DbFilter::default();
        let loose = DbFilter {
            ignore_tables: Vec::new(),
            ignore_columns: vec!["updatedAt".into()],
        };
        assert_ne!(
            digests_sqlite(&jan, &strict)?,
            digests_sqlite(&feb, &strict)?,
            "different updatedAt"
        );
        assert_eq!(
            digests_sqlite(&jan, &loose)?,
            digests_sqlite(&feb, &loose)?,
            "updatedAt ignored"
        );
        let early = make("c.sqlite", "2026-01-01 10:00:00.001")?;
        let late = make("d.sqlite", "2026-01-01 10:00:00.002")?;
        assert_eq!(
            digests_sqlite(&early, &strict)?,
            digests_sqlite(&late, &strict)?,
            "timestamp values don't affect checkpoints"
        );
        let dumped = dump_sqlite(&jan, &strict)?;
        let t = dumped.get("t").context("table t dumped")?;
        assert_eq!(t.key, vec!["id"], "primary key found");
        assert_eq!(t.rows.len(), 1, "one row");
        std::fs::remove_dir_all(dir)?;
        Ok(())
    }
}
