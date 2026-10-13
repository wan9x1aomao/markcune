use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32};
use std::sync::mpsc::Sender;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::store::Store;

/// What a new window should show once its page asks for it.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Startup {
    Empty,
    File { path: PathBuf },
    Folder { path: PathBuf },
    Draft { id: String, content: String },
}

/// Identifies file contents we last read or wrote, to detect changes made by other programs.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Version {
    len: usize,
    hash: u64,
}

impl Version {
    pub fn of(bytes: &[u8]) -> Self {
        let mut hasher = DefaultHasher::new();
        bytes.hash(&mut hasher);
        Version { len: bytes.len(), hash: hasher.finish() }
    }
}

/// One window: an optional folder shown in the file list and the document being edited.
#[derive(Default)]
pub struct WinState {
    pub startup: Option<Startup>,
    pub doc: Option<PathBuf>,
    pub doc_canonical: Option<PathBuf>,
    pub version: Option<Version>,
    pub root: Option<PathBuf>,
    pub root_canonical: Option<PathBuf>,
    pub draft_id: Option<String>,
    /// Set by the page while closing needs its attention (unsaved edits or a draft).
    pub close_guard: bool,
    pub zoom: Option<f64>,
    pub watcher: Option<notify::RecommendedWatcher>,
}

impl WinState {
    /// True when the window shows nothing worth keeping, so a newly opened file can reuse it.
    pub fn is_empty(&self) -> bool {
        self.doc.is_none() && self.draft_id.is_none() && self.root.is_none()
    }
}

pub struct AppState {
    pub windows: Mutex<HashMap<String, WinState>>,
    pub next_id: AtomicU32,
    pub quitting: AtomicBool,
    pub store: Mutex<Store>,
    pub fs_events: Sender<(String, Vec<PathBuf>)>,
    pub drafts_dir: PathBuf,
}

pub fn app_state(app: &AppHandle) -> tauri::State<'_, AppState> {
    app.state::<AppState>()
}

/// Runs `f` on a window's state, if the window still exists.
pub fn with_win<R>(app: &AppHandle, label: &str, f: impl FnOnce(&mut WinState) -> R) -> Option<R> {
    app_state(app).windows.lock().unwrap().get_mut(label).map(f)
}

pub fn absolute(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}
