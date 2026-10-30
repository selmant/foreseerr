//! Point-in-time copy of the backend's state at the start of a recording.

use std::path::Path;
use std::process::Command;

use anyhow::{bail, Context, Result};
use rusqlite::{Connection, DatabaseName, OpenFlags};

/// Create `dir` (and its parents) readable by the owner only: recordings
/// hold settings, databases and tokens. An existing `dir` is tightened too.
///
/// # Errors
///
/// Fails when `dir` can't be created or isn't a directory.
pub fn create_private_dir(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .with_context(|| format!("restricting {}", dir.display()))?;
    }
    Ok(())
}

/// Copy `config_dir` into `dest`, skipping `exclude` (top-level names). The
/// `SQLite` database is copied with `SQLite`'s online backup API so a running
/// backend is fine.
///
/// # Errors
///
/// Fails when `config_dir` has no `settings.json` or copying fails.
pub fn snapshot_config(config_dir: &Path, dest: &Path, exclude: &[String]) -> Result<()> {
    if !config_dir.join("settings.json").exists() {
        bail!(
            "{} has no settings.json; pass the backend's config directory",
            config_dir.display()
        );
    }
    std::fs::create_dir_all(dest)?;
    copy_tree(config_dir, dest, exclude, true)?;
    let db = config_dir.join("db/db.sqlite3");
    if db.exists() {
        std::fs::create_dir_all(dest.join("db"))?;
        backup_sqlite(&db, &dest.join("db/db.sqlite3"))?;
    }
    Ok(())
}

/// Copy a live `SQLite` database consistently.
///
/// # Errors
///
/// Fails when the source can't be opened or the copy can't be written.
pub fn backup_sqlite(src: &Path, dest: &Path) -> Result<()> {
    let conn = Connection::open_with_flags(
        src,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("opening {}", src.display()))?;
    conn.busy_timeout(std::time::Duration::from_secs(10))?;
    conn.backup(DatabaseName::Main, dest, None)
        .with_context(|| format!("backing up {}", src.display()))?;
    Ok(())
}

fn copy_tree(src: &Path, dest: &Path, exclude: &[String], top: bool) -> Result<()> {
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if top && exclude.iter().any(|e| e == &name) {
            continue;
        }
        // The database itself goes through the backup API.
        if name.starts_with("db.sqlite3") {
            continue;
        }
        let ty = entry.file_type()?;
        let target = dest.join(&name);
        if ty.is_dir() {
            std::fs::create_dir_all(&target)?;
            copy_tree(&entry.path(), &target, exclude, false)?;
        } else if ty.is_file() {
            std::fs::copy(entry.path(), &target)
                .with_context(|| format!("copying {}", entry.path().display()))?;
        }
    }
    Ok(())
}

/// Copy a directory tree as-is (gives each replay target its own config).
///
/// # Errors
///
/// Fails on any I/O error.
pub fn copy_dir(src: &Path, dest: &Path) -> Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let target = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Dump a Postgres database with `pg_dump` (custom format, restore with `pg_restore`).
///
/// # Errors
///
/// Fails when `pg_dump` is missing or exits unsuccessfully.
pub fn pg_dump(url: &str, dest: &Path) -> Result<()> {
    let status = Command::new("pg_dump")
        .args(["--format=custom", "--no-owner", "--no-privileges", "--file"])
        .arg(dest)
        .arg(url)
        .status()
        .context("running pg_dump (is it installed?)")?;
    if !status.success() {
        bail!("pg_dump exited with {status}");
    }
    Ok(())
}
