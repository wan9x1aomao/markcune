//! Pinned files: a short ordered list of paths kept above the file tree.
//!
//! A pin is a bookmark, not a copy. Nothing is written anywhere else, so the document you edit is
//! always the one on disk — unpinning removes a row and nothing else. A path that no longer
//! resolves (moved, renamed elsewhere, drive not mounted) is reported as missing and left alone.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::files;
use crate::state::{absolute, app_state};

const MAX_PINNED: usize = 20;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Pinned {
    path: PathBuf,
    name: String,
    /// Parent folder with the home directory shortened to `~`; the row's tooltip keeps the full path.
    dir: String,
    /// False when the file cannot be found. The row stays so the pin can be pointed elsewhere.
    exists: bool,
}

impl Pinned {
    fn read(path: &Path, home: Option<&Path>) -> Self {
        Pinned {
            path: path.to_path_buf(),
            name: path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default(),
            dir: shorten(path.parent().unwrap_or_else(|| Path::new("")), home),
            exists: path.is_file(),
        }
    }
}

fn shorten(dir: &Path, home: Option<&Path>) -> String {
    let text = dir.to_string_lossy().replace('\\', "/");
    if let Some(home) = home {
        let home = home.to_string_lossy().replace('\\', "/");
        if text == home {
            return "~".into();
        }
        if let Some(rest) = text.strip_prefix(&format!("{home}/")) {
            return format!("~/{rest}");
        }
    }
    text
}

/// Same document: equal after normalisation, or equal once symlinks are resolved.
fn same(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Why a path cannot be pinned, or `Ok` when it can.
fn check(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        return Err("文件夹不能置顶，选中里面的文档".into());
    }
    if !path.exists() {
        return Err("找不到这个文件".into());
    }
    if !files::is_document(path) {
        return Err("只有 Markdown 和纯文本可以置顶".into());
    }
    Ok(())
}

/// Adds a path unless it is already there. `false` means it was a duplicate, not a failure.
fn add(list: &mut Vec<PathBuf>, path: &Path) -> Result<bool, String> {
    if list.iter().any(|pinned| same(pinned, path)) {
        return Ok(false);
    }
    if list.len() >= MAX_PINNED {
        return Err(format!("置顶最多 {MAX_PINNED} 个，先取消几个"));
    }
    list.push(path.to_path_buf());
    Ok(true)
}

fn remove(list: &mut Vec<PathBuf>, path: &Path) -> bool {
    let before = list.len();
    list.retain(|pinned| !same(pinned, path));
    list.len() != before
}

/// Points an existing pin at a new path, keeping its place in the list.
fn relink(list: &mut Vec<PathBuf>, from: &Path, to: &Path) -> Result<(), String> {
    let index = list.iter().position(|pinned| same(pinned, from)).ok_or("这个文件不在置顶里")?;
    if list.iter().enumerate().any(|(i, pinned)| i != index && same(pinned, to)) {
        return Err("这个文件已经在置顶里".into());
    }
    list[index] = to.to_path_buf();
    Ok(())
}

fn home(app: &AppHandle) -> Option<PathBuf> {
    app.path().home_dir().ok()
}

#[tauri::command]
pub fn list_pinned(app: AppHandle) -> Vec<Pinned> {
    let home = home(&app);
    let state = app_state(&app);
    let store = state.store.lock().unwrap();
    store.pinned_files.iter().map(|path| Pinned::read(path, home.as_deref())).collect()
}

#[tauri::command]
pub fn pin_file(app: AppHandle, path: PathBuf) -> Result<Pinned, String> {
    let path = absolute(&path);
    check(&path)?;
    let home = home(&app);
    let state = app_state(&app);
    let mut store = state.store.lock().unwrap();
    if add(&mut store.pinned_files, &path)? {
        store.save();
    }
    Ok(Pinned::read(&path, home.as_deref()))
}

#[tauri::command]
pub fn unpin_file(app: AppHandle, path: PathBuf) -> Result<(), String> {
    let state = app_state(&app);
    let mut store = state.store.lock().unwrap();
    if remove(&mut store.pinned_files, &absolute(&path)) {
        store.save();
    }
    Ok(())
}

#[tauri::command]
pub fn relink_pinned(app: AppHandle, from: PathBuf, to: PathBuf) -> Result<Pinned, String> {
    let to = absolute(&to);
    check(&to)?;
    let home = home(&app);
    let state = app_state(&app);
    let mut store = state.store.lock().unwrap();
    relink(&mut store.pinned_files, &absolute(&from), &to)?;
    store.save();
    Ok(Pinned::read(&to, home.as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(list: &[&str]) -> Vec<PathBuf> {
        list.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn folders_are_shortened_with_a_tilde() {
        let home = Path::new("/Users/me");
        assert_eq!(shorten(Path::new("/Users/me/Documents/工作"), Some(home)), "~/Documents/工作");
        assert_eq!(shorten(home, Some(home)), "~");
        assert_eq!(shorten(Path::new("/Volumes/资料/书"), Some(home)), "/Volumes/资料/书");
    }

    #[test]
    fn the_same_document_is_never_pinned_twice() {
        let mut list = paths(&["/a/日报.md"]);
        assert_eq!(add(&mut list, Path::new("/a/日报.md")), Ok(false));
        assert_eq!(list.len(), 1);
        assert_eq!(add(&mut list, Path::new("/a/周报.md")), Ok(true));
        assert_eq!(list, paths(&["/a/日报.md", "/a/周报.md"]));
    }

    #[test]
    fn the_list_keeps_pinning_order_and_stops_at_twenty() {
        let mut list = Vec::new();
        for i in 0..MAX_PINNED {
            assert!(matches!(add(&mut list, Path::new(&format!("/a/{i}.md"))), Ok(true)));
        }
        assert_eq!(list[0], PathBuf::from("/a/0.md"));
        assert!(add(&mut list, Path::new("/a/overflow.md")).is_err());
        assert_eq!(list.len(), MAX_PINNED);
    }

    #[test]
    fn unpinning_removes_only_the_named_entry() {
        let mut list = paths(&["/a/1.md", "/a/2.md", "/a/3.md"]);
        assert!(remove(&mut list, Path::new("/a/2.md")));
        assert_eq!(list, paths(&["/a/1.md", "/a/3.md"]));
        assert!(!remove(&mut list, Path::new("/a/9.md")));
    }

    #[test]
    fn relinking_keeps_the_position_and_rejects_duplicates() {
        let mut list = paths(&["/a/1.md", "/a/2.md", "/a/3.md"]);
        assert_eq!(relink(&mut list, Path::new("/a/2.md"), Path::new("/b/二.md")), Ok(()));
        assert_eq!(list, paths(&["/a/1.md", "/b/二.md", "/a/3.md"]));
        assert!(relink(&mut list, Path::new("/b/二.md"), Path::new("/a/3.md")).is_err());
        assert!(relink(&mut list, Path::new("/a/missing.md"), Path::new("/b/x.md")).is_err());
    }
}
