use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const MAX_RECENT: usize = 12;
const MAX_POSITIONS: usize = 300;

/// Settings that must never reach the page. `ai_configure` / `voice_configure` write them, and
/// `ai_status` / `voice_status` only tell the page whether one is set. `window_init` hands out
/// `Store::public_settings()` instead of the raw map, so this is the one place to keep in sync
/// when a third credential is added.
pub const SECRET_SETTINGS: &[&str] = &["ai.apiKey", "voice.apiKey"];

/// Whether a settings key must stay in the shell.
///
/// The explicit list documents today's credentials; the suffix rules keep the guarantee when
/// someone adds another one and forgets this file. No UI preference currently ends in
/// "secret", "token" or contains "apikey", so nothing legitimate is dropped.
fn is_secret_setting(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    SECRET_SETTINGS.contains(&key)
        || lower.contains("apikey")
        || lower.ends_with("secret")
        || lower.ends_with("token")
}

/// Small JSON file in the app data folder: settings, recent items and reading positions.
#[derive(Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Store {
    pub settings: Map<String, Value>,
    pub recent_files: Vec<PathBuf>,
    pub recent_folders: Vec<PathBuf>,
    /// Files pinned above the tree, in the order they were pinned. Paths only — see `pinned.rs`.
    pub pinned_files: Vec<PathBuf>,
    /// Oldest first, so the list can be trimmed from the front.
    positions: Vec<(PathBuf, Value)>,
    #[serde(skip)]
    file: PathBuf,
}

impl Store {
    pub fn load(file: PathBuf) -> Self {
        let mut store: Store = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        store.file = file;
        store
    }

    pub fn save(&self) {
        let Ok(json) = serde_json::to_vec_pretty(self) else { return };
        if let Some(dir) = self.file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = crate::files::atomic_write(&self.file, &json);
    }

    /// The settings map as the page may see it: UI preferences only, never credentials.
    /// Everything that crosses into the renderer goes through here (see `window_init`).
    pub fn public_settings(&self) -> Map<String, Value> {
        self.settings
            .iter()
            .filter(|(key, _)| !is_secret_setting(key))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect()
    }

    pub fn add_recent_file(&mut self, path: &Path) {
        push_recent(&mut self.recent_files, path);
        self.save();
    }

    pub fn add_recent_folder(&mut self, path: &Path) {
        push_recent(&mut self.recent_folders, path);
        self.save();
    }

    pub fn position(&self, path: &Path) -> Option<Value> {
        self.positions.iter().rev().find(|(p, _)| p == path).map(|(_, v)| v.clone())
    }

    pub fn set_position(&mut self, path: PathBuf, position: Value) {
        self.positions.retain(|(p, _)| *p != path);
        self.positions.push((path, position));
        if self.positions.len() > MAX_POSITIONS {
            let excess = self.positions.len() - MAX_POSITIONS;
            self.positions.drain(..excess);
        }
        self.save();
    }

    pub fn rename_path(&mut self, from: &Path, to: &Path) {
        let rename = |p: &mut PathBuf| {
            if let Ok(rest) = p.strip_prefix(from) {
                *p = to.join(rest);
            }
        };
        self.recent_files.iter_mut().for_each(rename);
        self.recent_folders.iter_mut().for_each(rename);
        self.pinned_files.iter_mut().for_each(rename);
        self.positions.iter_mut().for_each(|(p, _)| rename(p));
        self.save();
    }
}

fn push_recent(list: &mut Vec<PathBuf>, path: &Path) {
    list.retain(|p| p != path);
    list.insert(0, path.to_path_buf());
    list.truncate(MAX_RECENT);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn store_with(entries: &[(&str, Value)]) -> Store {
        let mut store = Store::default();
        for (key, value) in entries {
            store.settings.insert((*key).to_string(), value.clone());
        }
        store
    }

    /// The page used to receive the whole settings map, keys included: `window_init` returned
    /// `store.settings` and the credentials live right there. The promise "the renderer never
    /// reads the key back" therefore depended on the page not looking. This is that promise,
    /// made enforceable.
    #[test]
    fn public_settings_drops_the_api_keys() {
        let store = store_with(&[
            ("theme", json!("dark")),
            ("ai.apiKey", json!("sk-ai")),
            ("voice.apiKey", json!("sk-voice")),
        ]);
        let public = store.public_settings();
        assert_eq!(public.get("theme"), Some(&json!("dark")));
        assert!(!public.contains_key("ai.apiKey"));
        assert!(!public.contains_key("voice.apiKey"));
    }

    /// A future credential must not leak just because nobody remembered to add it to the list.
    #[test]
    fn public_settings_drops_credential_shaped_keys() {
        let store = store_with(&[
            ("sidebar", json!(true)),
            ("some.futureApiKey", json!("x")),
            ("gateway.token", json!("x")),
            ("sync.secret", json!("x")),
        ]);
        let public = store.public_settings();
        assert_eq!(public.len(), 1, "只应留下界面偏好：{public:?}");
        assert_eq!(public.get("sidebar"), Some(&json!(true)));
    }

    /// Everything the page legitimately reads at startup has to survive the filter.
    #[test]
    fn public_settings_keeps_ui_preferences() {
        let store = store_with(&[
            ("theme", json!("system")),
            ("sidebar", json!(true)),
            ("outline", json!(false)),
            ("pinHintSeen", json!(true)),
            ("ai.completion", json!(true)),
        ]);
        assert_eq!(store.public_settings().len(), 5);
    }
}
