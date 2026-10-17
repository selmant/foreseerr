//! `acquireDesktopLock()`: `<CONFIG_DIRECTORY>/state/instance.lock`.
//!
//! The lock file is created exclusively with mode 0600 and holding the owner's pid. A lock whose pid
//! is gone is taken over; a live one stops the start with exit code 73.

use std::io::Write;
use std::path::{Path, PathBuf};

use super::process::ExitError;

/// `DESKTOP_LOCK_EXIT_CODE`.
pub const DESKTOP_LOCK_EXIT_CODE: i32 = 73;
/// `DESKTOP_SCHEMA_EXIT_CODE`.
pub const DESKTOP_SCHEMA_EXIT_CODE: i32 = 74;

const OWNED: &str = "Another Foreseer Desktop instance owns this data directory";

/// The held lock; [`DesktopLock::release`] closes and removes it.
#[derive(Debug)]
pub struct DesktopLock {
    path: PathBuf,
    file: Option<std::fs::File>,
}

impl DesktopLock {
    /// Take the lock for this process.
    ///
    /// # Errors
    ///
    /// [`ExitError`] with code 73 when `CONFIG_DIRECTORY` is unset or
    /// another live process owns the lock; an I/O error otherwise.
    pub fn acquire() -> anyhow::Result<Self> {
        let Some(config) = std::env::var_os("CONFIG_DIRECTORY") else {
            return Err(ExitError::new(
                "Desktop runtime requires CONFIG_DIRECTORY",
                DESKTOP_LOCK_EXIT_CODE,
            )
            .into());
        };
        let path = Path::new(&config).join("state").join("instance.lock");
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let file = match create_exclusive(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let pid = std::fs::read_to_string(&path)
                    .ok()
                    .and_then(|text| parse_int(text.trim()));
                if pid.is_some_and(|pid| pid > 0 && alive(pid)) {
                    return Err(ExitError::new(OWNED, DESKTOP_LOCK_EXIT_CODE).into());
                }
                std::fs::remove_file(&path).ok();
                create_exclusive(&path).map_err(|_| {
                    anyhow::Error::from(ExitError::new(OWNED, DESKTOP_LOCK_EXIT_CODE))
                })?
            }
            Err(e) => return Err(e.into()),
        };
        let mut lock = Self {
            path,
            file: Some(file),
        };
        if let Some(file) = lock.file.as_mut() {
            file.write_all(format!("{}\n", std::process::id()).as_bytes())?;
        }
        Ok(lock)
    }

    /// Close and remove the lock file (errors ignored, as in Node).
    pub fn release(&mut self) {
        if self.file.take().is_some() {
            std::fs::remove_file(&self.path).ok();
        }
    }
}

fn create_exclusive(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// `Number.parseInt(text, 10)`: leading digits after an optional sign.
fn parse_int(text: &str) -> Option<i64> {
    let (sign, digits) = text.strip_prefix('-').map_or_else(
        || (1, text.strip_prefix('+').unwrap_or(text)),
        |rest| (-1, rest),
    );
    let end = digits
        .bytes()
        .position(|b| !b.is_ascii_digit())
        .unwrap_or(digits.len());
    digits.get(..end)?.parse::<i64>().ok().map(|n| n * sign)
}

/// `process.kill(pid, 0)` succeeds: the process exists and may be
/// signalled (a process of another user counts as gone, as in Node).
fn alive(pid: i64) -> bool {
    #[cfg(unix)]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }
    #[cfg(windows)]
    {
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
            .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains(&format!("\"{pid}\"")))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_int_like_javascript() {
        assert_eq!(parse_int("123\n"), Some(123), "trailing newline");
        assert_eq!(parse_int("12ab"), Some(12), "trailing garbage");
        assert_eq!(parse_int("-5"), Some(-5), "negative");
        assert_eq!(parse_int("x"), None, "NaN");
        assert_eq!(parse_int(""), None, "empty");
    }

    #[test]
    fn this_process_is_alive() {
        assert!(alive(i64::from(std::process::id())), "self");
    }
}
