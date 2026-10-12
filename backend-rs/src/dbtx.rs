//! Statements that run either on the pool or inside a
//! `dataSource.transaction(...)` ([`crate::jobs::syncutil::Tx`]), so the
//! helpers a transaction shares with plain writes take either.

use anyhow::{Context, Result};
use serde_json::{Map, Value};

use crate::db::{Bind, Db};
use crate::jobs::syncutil::Tx;

/// Where a statement runs.
#[derive(Debug)]
pub enum Exec<'a> {
    /// The pool: each statement on its own.
    Db(&'a Db),
    /// The open transaction.
    Tx(&'a mut Tx),
}

impl Exec<'_> {
    /// A statement with `?N` placeholders; the rows it touched.
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn execute(&mut self, sql: &str, binds: &[Bind]) -> Result<u64> {
        match self {
            Self::Db(db) => db.execute(sql, binds).await,
            Self::Tx(tx) => tx.execute(sql, binds).await,
        }
    }

    /// Rows as JSON objects, like [`Db::rows`].
    ///
    /// # Errors
    ///
    /// Fails on database errors.
    pub async fn rows(&mut self, sql: &str, binds: &[Bind]) -> Result<Vec<Map<String, Value>>> {
        match self {
            Self::Db(db) => db.rows(sql, binds).await,
            Self::Tx(tx) => tx.rows(sql, binds).await,
        }
    }

    /// One integer: the first column of the first row, like
    /// [`Db::scalar`].
    ///
    /// # Errors
    ///
    /// Fails on database errors or when no integer comes back.
    pub async fn scalar(&mut self, sql: &str, binds: &[Bind]) -> Result<i64> {
        match self {
            Self::Db(db) => db.scalar(sql, binds).await,
            Self::Tx(tx) => tx
                .rows(sql, binds)
                .await?
                .first()
                .and_then(|row| row.values().next())
                .and_then(Value::as_i64)
                .context("the statement returned no integer"),
        }
    }
}

/// [`crate::typeorm::insert`] on the pool or inside a transaction: the
/// new row's id.
///
/// # Errors
///
/// Fails for non-scalar values or database errors.
pub async fn insert(exec: &mut Exec<'_>, table: &str, columns: &[(&str, Value)]) -> Result<i64> {
    let mut binds = Vec::new();
    let mut names = Vec::with_capacity(columns.len());
    let mut values = Vec::with_capacity(columns.len());
    for (column, value) in columns {
        names.push(format!("\"{column}\""));
        values.push(crate::typeorm::sql_value(value, &mut binds)?);
    }
    let sql = format!(
        "INSERT INTO \"{table}\" ({}) VALUES ({}) RETURNING CAST(\"id\" AS BIGINT)",
        names.join(", "),
        values.join(", ")
    );
    exec.scalar(&sql, &binds).await
}
