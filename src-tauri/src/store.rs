use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const MAX_RECENT: usize = 12;
const MAX_POSITIONS: usize = 300;

/// Small JSON file in the app data folder: settings, recent items and reading positions.
#[derive(Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Store {
    pub settings: Map<String, Value>,
    pub recent_files: Vec<PathBuf>,
    pub recent_folders: Vec<PathBuf>,
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
        self.positions.iter_mut().for_each(|(p, _)| rename(p));
        self.save();
    }
}

fn push_recent(list: &mut Vec<PathBuf>, path: &Path) {
    list.retain(|p| p != path);
    list.insert(0, path.to_path_buf());
    list.truncate(MAX_RECENT);
}
