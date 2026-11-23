use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use serde::Serialize;
use tauri::{Manager, WebviewWindow};

use crate::files::describe;
use crate::state::{app_state, with_win};

const HISTORY_LIMIT: usize = 20;
static HISTORY_COUNTER: AtomicU32 = AtomicU32::new(0);

fn history_key(path: Option<&Path>, draft_id: Option<&str>, file_id: Option<(u64, u64)>) -> String {
    let mut hasher = DefaultHasher::new();
    match (path, draft_id, file_id) {
        // Atomic saves replace the inode, so the path is the stable identity across autosaves.
        (Some(path), _, _) => ("path", path.to_string_lossy()).hash(&mut hasher),
        (None, Some(id), _) => ("draft", id).hash(&mut hasher),
        (None, None, Some((device, inode))) => ("file", device, inode).hash(&mut hasher),
        (None, None, None) => "untracked".hash(&mut hasher),
    }
    format!("{:016x}", hasher.finish())
}

fn snapshot_files(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("md"))
        .collect();
    files.sort();
    Ok(files)
}

fn trim_history(dir: &Path) -> Result<(), String> {
    let files = snapshot_files(dir).map_err(|error| describe(&error))?;
    let excess = files.len().saturating_sub(HISTORY_LIMIT);
    for path in files.into_iter().take(excess) {
        fs::remove_file(path).map_err(|error| describe(&error))?;
    }
    Ok(())
}

fn window_history_dir(window: &WebviewWindow) -> Option<PathBuf> {
    let app = window.app_handle();
    let (path, draft_id, file_id) = with_win(app, window.label(), |state| {
        (state.doc.clone(), state.draft_id.clone(), state.file_id)
    })?;
    if path.is_none() && draft_id.is_none() {
        return None;
    }
    Some(app_state(app).history_dir.join(history_key(
        path.as_deref(),
        draft_id.as_deref(),
        file_id,
    )))
}

fn timestamp() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySnapshot {
    pub content: String,
    pub saved_at: u64,
}

/// Stores the content that is about to be replaced by an autosave.
#[tauri::command]
pub fn history_save(window: WebviewWindow, content: String) -> Result<(), String> {
    if content.is_empty() {
        return Ok(());
    }
    let Some(dir) = window_history_dir(&window) else {
        return Ok(());
    };
    fs::create_dir_all(&dir).map_err(|error| describe(&error))?;
    if let Some(latest) = snapshot_files(&dir)
        .map_err(|error| describe(&error))?
        .last()
    {
        if fs::read(latest).ok().as_deref() == Some(content.as_bytes()) {
            return Ok(());
        }
    }
    let name = format!(
        "{}-{}.md",
        timestamp(),
        HISTORY_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    crate::files::atomic_write(&dir.join(name), content.as_bytes())?;
    trim_history(&dir)
}

#[tauri::command]
pub fn history_latest(window: WebviewWindow) -> Result<Option<HistorySnapshot>, String> {
    let Some(dir) = window_history_dir(&window) else {
        return Ok(None);
    };
    let files = match snapshot_files(&dir) {
        Ok(files) => files,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(describe(&error)),
    };
    let Some(path) = files.last().cloned() else {
        return Ok(None);
    };
    let content = fs::read_to_string(&path).map_err(|error| describe(&error))?;
    let saved_at = path
        .file_stem()
        .and_then(|name| name.to_str())
        .and_then(|name| name.split('-').next())
        .and_then(|value| value.parse().ok())
        .unwrap_or_default();
    Ok(Some(HistorySnapshot { content, saved_at }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    #[test]
    fn path_key_is_stable_when_atomic_save_replaces_the_inode() {
        assert_eq!(
            history_key(Some(Path::new("/tmp/note.md")), None, Some((4, 9))),
            history_key(Some(Path::new("/tmp/note.md")), None, Some((4, 10))),
        );
    }

    #[test]
    fn different_documents_get_different_path_keys() {
        assert_ne!(
            history_key(Some(Path::new("/tmp/one.md")), None, None),
            history_key(Some(Path::new("/tmp/two.md")), None, None),
        );
    }

    #[test]
    fn retention_keeps_only_the_newest_twenty_snapshots() {
        let dir = std::env::temp_dir().join(format!("mdpad-history-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for index in 0..25 {
            fs::write(dir.join(format!("{index:03}-0.md")), index.to_string()).unwrap();
        }

        trim_history(&dir).unwrap();
        let files = snapshot_files(&dir).unwrap();
        assert_eq!(files.len(), 20);
        assert!(files[0]
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("005-"));
        assert!(files[19]
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("024-"));
        fs::remove_dir_all(dir).unwrap();
    }
}
