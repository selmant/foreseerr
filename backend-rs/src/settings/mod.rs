//! settings.json, read the way Node reads it.
//!
//! The file is merged over the same defaults Node uses (`defaults.json`,
//! generated from `server/lib/settings/index.ts`) and reloaded whenever it
//! changes on disk (unless a handler left an unsaved change in memory, see
//! [`SettingsStore::mutate_unsaved`]). Node still runs the settings
//! migrations and generates keys; writes made here are changes to the
//! latest document under one lock ([`SettingsStore::mutate`]), saved the
//! way `Settings.save()` saves them, and Node is told to read the file
//! again.

pub mod public;

use std::ops::ControlFlow;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::SystemTime;

use anyhow::{Context, Result};
use serde_json::Value;

use crate::sync::{read, write};

/// Defaults applied under whatever settings.json contains.
const DEFAULTS: &str = include_str!("defaults.json");

/// One parsed version of settings.json.
#[derive(Debug, Clone)]
pub struct Settings {
    data: Value,
    api_key_override: Option<String>,
}

impl Settings {
    /// Merge `file` over the defaults.
    ///
    /// # Errors
    ///
    /// Fails when the embedded defaults don't parse.
    pub fn from_file_value(file: Value, api_key_override: Option<String>) -> Result<Self> {
        let mut data: Value =
            serde_json::from_str(DEFAULTS).context("parsing settings defaults")?;
        merge(&mut data, file);
        Ok(Self {
            data,
            api_key_override,
        })
    }

    /// The merged settings document.
    #[must_use]
    pub const fn data(&self) -> &Value {
        &self.data
    }

    /// The same settings with another document, used exactly as given (no
    /// defaults under it): an agent built from submitted settings.
    #[must_use]
    pub fn with_data(&self, data: Value) -> Self {
        Self {
            data,
            api_key_override: self.api_key_override.clone(),
        }
    }

    /// A value by JSON pointer, e.g. `/main/locale`.
    #[must_use]
    pub fn get(&self, pointer: &str) -> Option<&Value> {
        self.data.pointer(pointer)
    }

    /// A string by JSON pointer, empty when missing.
    #[must_use]
    pub fn str(&self, pointer: &str) -> &str {
        self.get(pointer).and_then(Value::as_str).unwrap_or("")
    }

    /// The API key in effect. `API_KEY` replaces a stored key, as in Node.
    #[must_use]
    pub fn api_key(&self) -> &str {
        let stored = self.str("/main/apiKey");
        match &self.api_key_override {
            Some(key) if !key.is_empty() => key,
            Some(_) | None => stored,
        }
    }

    /// Secret that signs session cookies.
    #[must_use]
    pub fn session_secret(&self) -> &str {
        self.str("/sessionSecret")
    }

    /// The parts of network settings that need a restart when changed.
    #[must_use]
    pub fn restart_relevant_network(&self) -> (Option<&Value>, Option<&Value>, Option<&Value>) {
        (
            self.get("/network/csrfProtection"),
            self.get("/network/trustProxy"),
            self.get("/network/proxy/enabled"),
        )
    }
}

/// lodash `mergeWith` as Node uses it: objects merge key by key, arrays and
/// everything else replace.
pub fn merge(target: &mut Value, incoming: Value) {
    match (target, incoming) {
        (Value::Object(t), Value::Object(src)) => {
            for (k, v) in src {
                match t.get_mut(&k) {
                    Some(existing) if existing.is_object() && v.is_object() => merge(existing, v),
                    Some(existing) => *existing = v,
                    None => {
                        t.insert(k, v);
                    }
                }
            }
        }
        (t, src) => *t = src,
    }
}

#[derive(Debug)]
struct Cached {
    modified: Option<SystemTime>,
    len: u64,
    settings: Arc<Settings>,
}

/// settings.json with a cache that is refreshed when the file changes.
#[derive(Debug)]
pub struct SettingsStore {
    path: PathBuf,
    /// Held from reading the document a change starts from until that
    /// change is written (or kept unsaved), so no two changes interleave.
    mutation_lock: tokio::sync::Mutex<()>,
    api_key_override: Option<String>,
    cached: RwLock<Option<Cached>>,
    /// Node's in-memory settings when a handler changed them and answered
    /// without `save()` (standalone mode only). Node never reads the file
    /// again, so this is what every later read sees, whatever the file
    /// says, until the next save writes it.
    unsaved: RwLock<Option<Arc<Settings>>>,
}

impl SettingsStore {
    /// A store for `<config_dir>/settings.json`.
    #[must_use]
    pub fn new(config_dir: &std::path::Path) -> Self {
        Self {
            path: config_dir.join("settings.json"),
            mutation_lock: tokio::sync::Mutex::new(()),
            api_key_override: std::env::var("API_KEY").ok(),
            cached: RwLock::new(None),
            unsaved: RwLock::new(None),
        }
    }

    /// Keep `data` (a whole merged document) as the current settings without
    /// writing the file: a Node handler that changed `getSettings()` and
    /// returned before `save()`. The next save writes it with its own change.
    fn keep_unsaved(&self, data: Value) {
        *write(&self.unsaved) = Some(Arc::new(Settings {
            data,
            api_key_override: self.api_key_override.clone(),
        }));
    }

    /// Change the settings and save them, as a Node handler changes the one
    /// shared settings object and calls `save()`: `change` runs on the
    /// latest document (other requests' saved or unsaved changes included)
    /// under the mutation lock, so nothing it reads, allocates or edits can
    /// be overtaken before the write. `Break` writes nothing.
    ///
    /// # Errors
    ///
    /// Fails when the settings can't be read or the file can't be written.
    pub async fn mutate<B, C>(
        &self,
        change: impl FnOnce(&mut Value) -> ControlFlow<B, C>,
    ) -> Result<ControlFlow<B, C>> {
        let guard = self.mutation_lock.lock().await;
        let mut doc = self.node_memory().await?;
        let flow = change(&mut doc);
        if flow.is_continue() {
            self.write_locked(&doc, guard).await?;
        } else {
            drop(guard);
        }
        Ok(flow)
    }

    /// [`SettingsStore::mutate`] for a change that is always saved.
    ///
    /// # Errors
    ///
    /// Fails when the settings can't be read or the file can't be written.
    pub async fn update(&self, change: impl FnOnce(&mut Value)) -> Result<()> {
        self.mutate(|doc| {
            change(doc);
            ControlFlow::<(), ()>::Continue(())
        })
        .await
        .map(drop)
    }

    /// [`SettingsStore::mutate`] without the write, the changed document
    /// kept as the current settings instead: a Node handler that changed
    /// `getSettings()` and returned before `save()`.
    ///
    /// # Errors
    ///
    /// Fails when the current settings can't be read.
    pub async fn mutate_unsaved<T>(&self, change: impl FnOnce(&mut Value) -> T) -> Result<T> {
        let guard = self.mutation_lock.lock().await;
        let mut doc = self.node_memory().await?;
        let out = change(&mut doc);
        self.keep_unsaved(doc);
        drop(guard);
        Ok(out)
    }

    /// The current document as Node holds it: `API_KEY` replaces the
    /// stored key in memory at load (every save writes it anyway).
    async fn node_memory(&self) -> Result<Value> {
        let current = self.current().await?;
        let mut doc = current.data().clone();
        let key = current.api_key();
        if key != current.str("/main/apiKey") {
            if let Some(main) = doc.get_mut("main").and_then(Value::as_object_mut) {
                main.insert(String::from("apiKey"), Value::from(key));
            }
        }
        Ok(doc)
    }

    /// The current settings, re-read if the file changed since last time.
    ///
    /// # Errors
    ///
    /// Fails when the file can't be read or isn't valid JSON and nothing was
    /// loaded before.
    pub async fn current(&self) -> Result<Arc<Settings>> {
        if let Some(unsaved) = read(&self.unsaved).as_ref() {
            return Ok(Arc::clone(unsaved));
        }
        let meta = tokio::fs::metadata(&self.path).await.ok();
        let modified = meta.as_ref().and_then(|m| m.modified().ok());
        let len = meta.as_ref().map_or(0, std::fs::Metadata::len);
        if let Some(c) = read(&self.cached).as_ref() {
            if c.modified == modified && c.len == len {
                return Ok(crate::runtime::desktop::effective(Arc::clone(&c.settings)));
            }
        }
        let loaded = match self.load().await {
            Ok(s) => Arc::new(s),
            Err(e) => {
                // Node writes via a temp file and rename, but a half-written
                // file is still possible; keep serving the last good copy.
                if let Some(c) = read(&self.cached).as_ref() {
                    tracing::warn!("keeping previous settings: {e:#}");
                    return Ok(crate::runtime::desktop::effective(Arc::clone(&c.settings)));
                }
                return Err(e);
            }
        };
        *write(&self.cached) = Some(Cached {
            modified,
            len,
            settings: Arc::clone(&loaded),
        });
        Ok(crate::runtime::desktop::effective(loaded))
    }

    /// `Settings.save()`: the whole document, `JSON.stringify(data,
    /// undefined, ' ')`, through a temp file and a rename, holding the
    /// mutation lock. The written document becomes the cached one at once,
    /// so the next change builds on it whatever the file's timestamp says.
    async fn write_locked(
        &self,
        data: &Value,
        _guard: tokio::sync::MutexGuard<'_, ()>,
    ) -> Result<()> {
        // The desktop's loopback `applicationUrl` is never written.
        let stored = read(&self.cached)
            .as_ref()
            .and_then(|c| c.settings.get("/main/applicationUrl").cloned());
        let durable = crate::runtime::desktop::durable_document(data, stored);
        let data = durable.as_ref().unwrap_or(data);
        // Node keeps `API_KEY` in its in-memory settings, so every save
        // writes it to the file.
        let mut owned;
        let mut data = data;
        if let Some(key) = self.api_key_override.as_ref().filter(|k| !k.is_empty()) {
            owned = data.clone();
            if let Some(main) = owned.get_mut("main").and_then(Value::as_object_mut) {
                main.insert(String::from("apiKey"), Value::from(key.as_str()));
            }
            data = &owned;
        }
        let mut text = Vec::new();
        let formatter = serde_json::ser::PrettyFormatter::with_indent(b" ");
        let mut ser = serde_json::Serializer::with_formatter(&mut text, formatter);
        serde::Serialize::serialize(data, &mut ser).context("serializing settings")?;
        let tmp = self.path.with_extension("json.tmp");
        tokio::fs::write(&tmp, &text)
            .await
            .with_context(|| format!("writing {}", tmp.display()))?;
        tokio::fs::rename(&tmp, &self.path)
            .await
            .with_context(|| format!("renaming {}", tmp.display()))?;
        let meta = tokio::fs::metadata(&self.path).await.ok();
        let settings = Settings::from_file_value(data.clone(), self.api_key_override.clone())?;
        *write(&self.cached) = Some(Cached {
            modified: meta.as_ref().and_then(|m| m.modified().ok()),
            len: meta.as_ref().map_or(0, std::fs::Metadata::len),
            settings: Arc::new(settings),
        });
        // The saved document was built from the unsaved one; the file has
        // it now.
        *write(&self.unsaved) = None;
        Ok(())
    }

    async fn load(&self) -> Result<Settings> {
        let file = match tokio::fs::read_to_string(&self.path).await {
            Ok(text) => serde_json::from_str(&text)
                .with_context(|| format!("parsing {}", self.path.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && read(&self.cached).is_none() => {
                Value::Object(serde_json::Map::new())
            }
            Err(e) => return Err(e).with_context(|| format!("reading {}", self.path.display())),
        };
        anyhow::ensure!(file.is_object(), "settings.json must contain an object");
        Settings::from_file_value(file, self.api_key_override.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn missing_or_invalid_settings_keep_the_last_valid_secrets() -> Result<()> {
        let dir = std::env::temp_dir().join(format!(
            "foreseerr-settings-{}",
            crate::standalone::settingsfile::uuid_v4()?
        ));
        tokio::fs::create_dir_all(&dir).await?;
        let store = SettingsStore {
            api_key_override: None,
            ..SettingsStore::new(&dir)
        };
        let doc = json!({"main": {"apiKey": "valid-key"}, "sessionSecret": "valid-secret"});
        tokio::fs::write(&store.path, doc.to_string()).await?;
        let first = store.current().await?;
        assert_eq!(first.api_key(), "valid-key", "fixture key");
        tokio::fs::remove_file(&store.path).await?;
        let missing = store.current().await?;
        assert_eq!(missing.api_key(), "valid-key", "missing file keeps the key");
        assert_eq!(
            missing.session_secret(),
            "valid-secret",
            "missing file keeps the cookie secret"
        );
        for invalid in ["null", "[]", "42", "{broken"] {
            tokio::fs::write(&store.path, invalid).await?;
            assert_eq!(
                store.current().await?.api_key(),
                "valid-key",
                "invalid document {invalid:?} keeps the key"
            );
        }
        tokio::fs::write(
            &store.path,
            json!({"main": {"apiKey": "replacement-key"}, "sessionSecret": "replacement-secret"})
                .to_string(),
        )
        .await?;
        assert_eq!(
            store.current().await?.api_key(),
            "replacement-key",
            "a valid replacement is loaded"
        );
        tokio::fs::remove_dir_all(&dir).await?;
        Ok(())
    }
}
