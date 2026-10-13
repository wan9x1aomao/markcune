//! Event-driven file watching (FSEvents / ReadDirectoryChangesW, no polling).
//! Each window watches its folder and the folder of its document; bursts of
//! events are coalesced and delivered to the page as one "fs-changed" event.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::time::Duration;

use notify::{EventKind, RecursiveMode, Watcher};
use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::state::{app_state, with_win};

const QUIET_PERIOD: Duration = Duration::from_millis(300);

pub fn start_debouncer(app: AppHandle) -> Sender<(String, Vec<PathBuf>)> {
    let (tx, rx) = channel::<(String, Vec<PathBuf>)>();
    std::thread::spawn(move || {
        let mut pending: HashMap<String, BTreeSet<PathBuf>> = HashMap::new();
        loop {
            let message = if pending.is_empty() {
                match rx.recv() {
                    Ok(message) => message,
                    Err(_) => return,
                }
            } else {
                match rx.recv_timeout(QUIET_PERIOD) {
                    Ok(message) => message,
                    Err(RecvTimeoutError::Timeout) => {
                        for (label, paths) in pending.drain() {
                            deliver(&app, &label, paths);
                        }
                        continue;
                    }
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            };
            pending.entry(message.0).or_default().extend(message.1);
        }
    });
    tx
}

/// Tells the page whether its document changed and which listed folders need refreshing.
fn deliver(app: &AppHandle, label: &str, paths: BTreeSet<PathBuf>) {
    let Some((doc, root, root_canonical)) =
        with_win(app, label, |w| (w.doc_canonical.clone(), w.root.clone(), w.root_canonical.clone()))
    else {
        return;
    };
    let doc_changed = doc.is_some_and(|doc| paths.iter().any(|p| canonical(p) == doc));
    let mut dirs = BTreeSet::new();
    if let (Some(root), Some(root_canonical)) = (root, root_canonical) {
        for path in &paths {
            let changed = canonical(path);
            if let Some(parent) = changed.parent() {
                if let Ok(rest) = parent.strip_prefix(&root_canonical) {
                    dirs.insert(root.join(rest));
                }
            }
        }
    }
    let _ = app.emit_to(label, "fs-changed", json!({ "docChanged": doc_changed, "dirs": dirs }));
}

/// Canonical form of a path that may no longer exist (e.g. a deleted file).
fn canonical(path: &Path) -> PathBuf {
    if let Ok(path) = std::fs::canonicalize(path) {
        return path;
    }
    match (path.parent().and_then(|p| std::fs::canonicalize(p).ok()), path.file_name()) {
        (Some(parent), Some(name)) => parent.join(name),
        _ => path.to_path_buf(),
    }
}

/// Rebuilds a window's watcher after its folder or document changed.
pub fn update(app: &AppHandle, label: &str) {
    let tx = app_state(app).fs_events.clone();
    let owner = label.to_string();
    let watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        if let Ok(event) = result {
            if !matches!(event.kind, EventKind::Access(_)) {
                let _ = tx.send((owner.clone(), event.paths));
            }
        }
    });
    let Ok(mut watcher) = watcher else { return };

    with_win(app, label, |w| {
        if let Some(root) = &w.root {
            let _ = watcher.watch(root, RecursiveMode::Recursive);
        }
        if let Some(dir) = w.doc.as_ref().and_then(|d| d.parent()) {
            let inside_root = w.root.as_ref().is_some_and(|root| dir.starts_with(root));
            if !inside_root {
                let _ = watcher.watch(dir, RecursiveMode::NonRecursive);
            }
        }
        w.watcher = Some(watcher);
    });
}
