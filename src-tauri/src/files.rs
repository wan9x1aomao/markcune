//! Document, folder and draft commands used by the page.

use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use percent_encoding::percent_decode_str;
use serde::Serialize;
use serde_json::Value;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::state::{absolute, app_state, with_win, Version, WinState};
use crate::watch;

pub const DOC_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "txt"];
const SKIPPED_DIRS: &[&str] = &["node_modules", "target", "dist", "build"];
const MAX_LISTED_DOCUMENTS: usize = 5000;

pub fn is_document(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| DOC_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
}

/// `dev` and `inode` (or the Windows volume serial and file index). Compared after canonicalize.
pub fn file_identity(path: &Path) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some((meta.dev(), meta.ino()))
    }
    #[cfg(windows)]
    {
        let _ = meta;
        windows_file_identity(path)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = meta;
        None
    }
}

/// Stable Win32 equivalent of the unstable `MetadataExt::file_index`.
/// A failed call stays `None`. It is not reported as index 0, which would
/// make every such file on the volume look identical.
#[cfg(windows)]
fn windows_file_identity(path: &Path) -> Option<(u64, u64)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};
    let file = std::fs::File::open(path).ok()?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) };
    if ok == 0 {
        return None;
    }
    let index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
    identity_from_index(Some(info.dwVolumeSerialNumber), Some(index))
}

fn canonical_dir(path: &Path) -> Option<PathBuf> {
    let path = absolute(path);
    let canon = std::fs::canonicalize(&path).ok()?;
    canon.is_dir().then_some(canon)
}

fn canonical_file(path: &Path) -> Option<PathBuf> {
    let path = absolute(path);
    std::fs::canonicalize(&path).ok().filter(|real| real.is_file())
}

/// Component-wise, after both sides are canonical. A string prefix would treat `/docs-secret` as inside `/docs`.
fn inside(root: &Path, path: &Path) -> bool {
    path.starts_with(root)
}

pub fn grant_dir(app: &AppHandle, label: &str, path: &Path) {
    let Some(real) = canonical_dir(path) else { return };
    with_win(app, label, |w| {
        if !w.allowed_dirs.iter().any(|dir| dir == &real) {
            w.allowed_dirs.push(real);
        }
    });
}

/// The folder a link download just wrote. The page then points the sidebar at it and opens the
/// file, both of which call [`authorize`]. Only this folder is added: not the library above it.
/// A symlink is not a folder this download created, so its target stays ungranted.
pub fn grant_fetched_dir(app: &AppHandle, label: &str, root: &Path) {
    with_win(app, label, |state| grant_fetched_dir_state(state, root));
}

fn grant_fetched_dir_state(state: &mut WinState, root: &Path) {
    let Ok(meta) = root.symlink_metadata() else { return };
    if !meta.file_type().is_dir() {
        return;
    }
    let Some(real) = canonical_dir(root) else { return };
    if !state.allowed_dirs.iter().any(|dir| dir == &real) {
        state.allowed_dirs.push(real);
    }
}

pub fn grant_file(app: &AppHandle, label: &str, path: &Path) {
    let Some(real) = canonical_file(path) else { return };
    with_win(app, label, |w| grant_file_only(w, real));
}

/// Only this file. A symlink to a document must not authorize the target's whole folder.
fn grant_file_only(state: &mut crate::state::WinState, real: PathBuf) {
    if !state.allowed_files.iter().any(|file| file == &real) {
        state.allowed_files.push(real);
    }
}

/// Volume serial plus file index. Either `None` stays unknown: substituting 0 for a
/// missing file index made every unnamed file on the volume look like the same file.
/// In Rust 1.99 both `volume_serial_number` and `file_index` are `Option`.
pub(crate) fn identity_from_index(volume: Option<u32>, index: Option<u64>) -> Option<(u64, u64)> {
    Some((u64::from(volume?), index?))
}

/// The file the user named, plus the folder that name is in.
/// A symlink grants that folder and the target file, not the target's folder.
pub fn grant_named_file(app: &AppHandle, label: &str, path: &Path) {
    with_win(app, label, |state| grant_named_file_state(state, path));
}

fn grant_named_file_state(state: &mut WinState, path: &Path) {
    let path = absolute(path);
    if let Some(parent) = path.parent() {
        if let Some(dir) = canonical_dir(parent) {
            if !state.allowed_dirs.iter().any(|have| have == &dir) {
                state.allowed_dirs.push(dir);
            }
        }
    }
    if let Some(real) = canonical_file(&path) {
        grant_file_only(state, real);
    }
}

/// After Save As the window follows the new file, including a folder that was not the sidebar root.
fn adopt_saved_document(state: &mut WinState, target: &Path) {
    if let Some(parent) = target.parent() {
        if let Some(dir) = canonical_dir(parent) {
            if !state.allowed_dirs.iter().any(|have| have == &dir) {
                state.allowed_dirs.push(dir);
            }
        }
    }
    if let Some(real) = canonical_file(target) {
        grant_file_only(state, real);
    }
    state.file_id = file_identity(target);
}

fn remembered(app: &AppHandle, path: &Path) -> bool {
    let state = app_state(app);
    let store = state.store.lock().unwrap();
    let listed = store
        .recent_files
        .iter()
        .chain(store.pinned_files.iter())
        .chain(store.recent_folders.iter());
    listed.filter_map(|item| std::fs::canonicalize(item).ok()).any(|real| real == path)
}

/// The page may touch `path` when this window was given the file or its folder, or the user
/// opened it before (recent / pinned). Anything else is refused, symlink and all.
pub fn authorize(app: &AppHandle, label: &str, path: &Path) -> Result<PathBuf, String> {
    let real = canonical_file(path).or_else(|| canonical_dir(path)).ok_or("文件或文件夹不存在")?;
    let allowed = with_win(app, label, |w| {
        w.allowed_files.iter().any(|file| file == &real)
            || w.allowed_dirs.iter().any(|dir| inside(dir, &real))
            || w.pending_image.as_ref().is_some_and(|image| image == &real)
    })
    .unwrap_or(false);
    if allowed || remembered(app, &real) {
        if real.is_file() {
            grant_file(app, label, &real);
        } else {
            grant_dir(app, label, &real);
        }
        return Ok(real);
    }
    Err("没有打开这个位置的权限".into())
}

/// The extension a pasted image keeps, falling back to `png` for anything unrecognised —
/// the name comes from the page, so it does not get to choose what lands in `assets/`.
fn image_ext(name: &Path) -> String {
    name.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .filter(|e| IMAGE_EXTENSIONS.contains(&e.as_str()))
        .unwrap_or_else(|| "png".to_string())
}

/// Chinese description of an I/O error (OS messages are often English).
pub fn describe(err: &std::io::Error) -> String {
    match err.kind() {
        ErrorKind::NotFound => "文件或文件夹不存在".into(),
        ErrorKind::PermissionDenied => "没有访问权限".into(),
        ErrorKind::AlreadyExists => "已存在同名文件".into(),
        ErrorKind::InvalidData => "文件不是 UTF-8 编码的文本".into(),
        ErrorKind::StorageFull => "磁盘空间不足".into(),
        ErrorKind::ReadOnlyFilesystem => "磁盘是只读的".into(),
        ErrorKind::IsADirectory => "这是一个文件夹".into(),
        _ => match err.raw_os_error() {
            Some(code) => format!("操作失败（错误代码 {code}）"),
            None => "操作失败".into(),
        },
    }
}

/// Distinguishes temporary files created close together within this process.
static TEMP_COUNTER: AtomicU32 = AtomicU32::new(0);

/// True for symlinks (and for paths that can't be inspected), which must not be followed
/// when copying a document's assets.
fn is_symlink(path: &Path) -> bool {
    path.symlink_metadata().map(|meta| meta.file_type().is_symlink()).unwrap_or(true)
}

/// Writes via a temporary file in the same folder, so a crash never leaves a half-written document.
/// The temporary name is unpredictable and created exclusively, so nobody can pre-place a symlink
/// where it is about to land. A symlink at `path` is refused: renaming onto it would be safe, but
/// following it would write somewhere else, and replacing it would destroy the link.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    match path.symlink_metadata() {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err("这个文件已经变成链接，不能覆盖保存".into());
        }
        Ok(_) => {}
        Err(err) if err.kind() == ErrorKind::NotFound => {}
        Err(err) => return Err(describe(&err)),
    }
    let path = path.to_path_buf();
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or_default();
    let nonce = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_file_name(format!(".{name}.{}-{nanos:x}{nonce}.mdpad-tmp", std::process::id()));
    let result = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .and_then(|mut file| std::io::Write::write_all(&mut file, bytes))
        .and_then(|_| {
            if let Ok(meta) = std::fs::metadata(&path) {
                let _ = std::fs::set_permissions(&tmp, meta.permissions());
            }
            std::fs::rename(&tmp, &path)
        });
    if let Err(err) = result {
        let _ = std::fs::remove_file(&tmp);
        // `std::fs::write` follows symlinks. A link that appeared after the first check
        // would be written through. Rename failure is reported instead.
        if path.symlink_metadata().ok().is_some_and(|meta| meta.file_type().is_symlink()) {
            return Err("这个文件已经变成链接，不能覆盖保存".into());
        }
        return Err(describe(&err));
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    path: PathBuf,
    content: String,
    position: Option<Value>,
    rewritten: bool,
}

fn remember_document(app: &AppHandle, label: &str, path: &Path, content: &str) {
    with_win(app, label, |w| {
        w.doc = Some(path.to_path_buf());
        w.doc_canonical = std::fs::canonicalize(path).ok();
        w.version = Some(Version::of(content.as_bytes()));
    });
    app_state(app).store.lock().unwrap().add_recent_file(path);
    watch::update(app, label);
}

#[tauri::command]
pub fn read_document(window: WebviewWindow, path: PathBuf) -> Result<Opened, String> {
    let path = absolute(&path);
    let linked = path.symlink_metadata().map(|meta| meta.file_type().is_symlink()).unwrap_or(false);
    // Canonicalize before the extension check so `notes.md -> ~/.ssh/id_rsa` is not a document.
    // The editor then keeps the real path: a later save cannot follow a swapped link.
    let real = std::fs::canonicalize(&path).map_err(|e| describe(&e))?;
    if !is_document(&real) {
        return Err(if linked { "这个链接指向的不是文稿".into() } else { "只能打开 Markdown 或纯文本文件".into() });
    }
    let app = window.app_handle();
    // A link that lives in a folder this window may browse may point at a real document elsewhere.
    // The editor then holds the real file, so saving cannot follow a link that was swapped later.
    if let Some(parent) = path.parent() {
        if authorize(app, window.label(), parent).is_ok() {
            grant_file(app, window.label(), &real);
        }
    }
    let real = authorize(app, window.label(), &real)?;
    let bytes = std::fs::read(&real).map_err(|e| describe(&e))?;
    let content = String::from_utf8(bytes).map_err(|_| "文件不是 UTF-8 编码的文本".to_string())?;
    let id = file_identity(&real);
    remember_document(app, window.label(), &real, &content);
    with_win(app, window.label(), |w| w.file_id = id);
    let position = app_state(app).store.lock().unwrap().position(&real);
    Ok(Opened { path: portable_path(&real), content, position, rewritten: false })
}

/// Windows `canonicalize()` returns a verbatim path (`\\?\C:\...`). The page's path
/// helpers expect a plain drive/UNC path: splitting the verbatim prefix into components
/// turned `\\?\C:\docs\note.md` into `?/C:/docs/...`, so local images stopped resolving
/// on Windows (the smoke test's icon came back as a 404 relative URL).
/// The shell keeps the verbatim path for its own checks; only the page-facing copy is portable.
fn strip_verbatim_prefix(text: &str) -> String {
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc}");
    }
    if let Some(drive) = text.strip_prefix(r"\\?\") {
        return drive.to_string();
    }
    text.to_string()
}

fn portable_path(path: &Path) -> PathBuf {
    match path.to_str() {
        Some(text) => PathBuf::from(strip_verbatim_prefix(text)),
        None => path.to_path_buf(),
    }
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum WriteResult {
    Saved,
    /// The file changed on disk ("changed") or disappeared ("missing") since we last read it.
    Conflict { reason: &'static str },
}

#[tauri::command]
pub fn write_document(window: WebviewWindow, content: String, force: bool) -> Result<WriteResult, String> {
    let app = window.app_handle();
    let label = window.label();
    let (path, version) = with_win(app, label, |w| (w.doc.clone(), w.version)).unwrap_or_default();
    let path = path.ok_or("文档还没有保存位置")?;

    let expected = with_win(app, label, |w| w.file_id).flatten();
    match gate_path(&path, expected, force) {
        SaveGate::Conflict(reason) => return Ok(WriteResult::Conflict { reason }),
        SaveGate::Create | SaveGate::Write => {}
    }
    if !force {
        match std::fs::read(&path) {
            Ok(disk) => {
                if Some(Version::of(&disk)) != version && disk != content.as_bytes() {
                    return Ok(WriteResult::Conflict { reason: "changed" });
                }
            }
            Err(err) if err.kind() == ErrorKind::NotFound => {
                return Ok(WriteResult::Conflict { reason: "missing" });
            }
            Err(err) => return Err(describe(&err)),
        }
    }
    if let Err(message) = atomic_write(&path, content.as_bytes()) {
        // The path may have become a symlink between the check and the write.
        if path.symlink_metadata().ok().is_some_and(|meta| meta.file_type().is_symlink()) {
            return Ok(WriteResult::Conflict { reason: "redirected" });
        }
        return Err(message);
    }
    let id = file_identity(&path);
    if id.is_none() {
        return Ok(WriteResult::Conflict { reason: "unverified" });
    }
    with_win(app, label, |w| {
        w.version = Some(Version::of(content.as_bytes()));
        w.doc_canonical = std::fs::canonicalize(&path).ok();
        w.file_id = id;
    });
    Ok(WriteResult::Saved)
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum CheckResult {
    Unchanged,
    Changed { content: String },
    Missing,
}

/// Compares the document on disk with what we last read or wrote.
#[tauri::command]
pub fn check_document(window: WebviewWindow) -> Result<CheckResult, String> {
    let (path, version) = with_win(window.app_handle(), window.label(), |w| (w.doc.clone(), w.version))
        .unwrap_or_default();
    let Some(path) = path else { return Ok(CheckResult::Unchanged) };
    match std::fs::read(&path) {
        Ok(disk) if Some(Version::of(&disk)) == version => Ok(CheckResult::Unchanged),
        Ok(disk) => Ok(CheckResult::Changed { content: String::from_utf8_lossy(&disk).into_owned() }),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(CheckResult::Missing),
        Err(err) => Err(describe(&err)),
    }
}

/// Asks for a location and writes the document there, carrying relative images along.
#[tauri::command]
pub async fn save_as(window: WebviewWindow, content: String) -> Result<Option<Opened>, String> {
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let (current, root, draft_id) =
        with_win(&app, &label, |w| (w.doc.clone(), w.root.clone(), w.draft_id.clone())).unwrap_or_default();

    let mut dialog = app.dialog().file().add_filter("Markdown 文稿", &["md", "markdown"]).set_parent(&window);
    let directory = current.as_ref().and_then(|p| p.parent().map(Path::to_path_buf)).or(root);
    if let Some(dir) = directory {
        dialog = dialog.set_directory(dir);
    }
    let name = current
        .as_ref()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "未命名.md".into());
    let Some(target) = dialog.set_file_name(name).blocking_save_file() else { return Ok(None) };
    let target = absolute(&target.into_path().map_err(|_| "无法使用所选位置".to_string())?);

    let old_dir = current.as_ref().and_then(|p| p.parent());
    let new_dir = target.parent().ok_or("无法使用所选位置")?;
    let (content, rewritten) = match old_dir {
        Some(old_dir) if old_dir != new_dir => {
            let migrated = migrate_assets(&content, old_dir, new_dir);
            let rewritten = migrated != content;
            (migrated, rewritten)
        }
        _ => (content, false),
    };

    atomic_write(&target, content.as_bytes())?;
    if let Some(id) = draft_id {
        let _ = std::fs::remove_file(draft_file(&app, &id));
        with_win(&app, &label, |w| w.draft_id = None);
    }
    // The dialog is the user's choice of this directory, including one outside the current root
    // and the first save of an untitled draft. The window may then point its sidebar there.
    // file_id must become this file's, or the next save still thinks it is editing the old one.
    with_win(&app, &label, |state| adopt_saved_document(state, &target));
    remember_document(&app, &label, &target, &content);
    Ok(Some(Opened { path: target, content, position: None, rewritten }))
}

/// What a save is allowed to do. `force` answers a content conflict only.
#[derive(Debug, PartialEq, Eq)]
enum SaveGate {
    /// Replace the regular file that is already there.
    Write,
    /// The path is gone. Only a forced save may create it again.
    Create,
    /// `changed` / `missing` can be forced. `redirected` and `unverified` cannot.
    Conflict(&'static str),
}

/// `link` is the path itself, not whatever it points at. A missing identity never becomes "go ahead".
fn gate_save(link: bool, exists: bool, actual: Option<(u64, u64)>, expected: Option<(u64, u64)>, force: bool) -> SaveGate {
    if link {
        return SaveGate::Conflict("redirected");
    }
    if !exists {
        return if force { SaveGate::Create } else { SaveGate::Conflict("missing") };
    }
    let Some(actual) = actual else {
        return SaveGate::Conflict("unverified");
    };
    match expected {
        None => SaveGate::Conflict("unverified"),
        Some(expected) if expected != actual && !force => SaveGate::Conflict("changed"),
        Some(_) => SaveGate::Write,
    }
}

fn gate_path(path: &Path, expected: Option<(u64, u64)>, force: bool) -> SaveGate {
    let meta = match path.symlink_metadata() {
        Ok(meta) => Some(meta),
        Err(err) if err.kind() == ErrorKind::NotFound => None,
        Err(_) => return SaveGate::Conflict("unverified"),
    };
    let Some(meta) = meta else {
        return gate_save(false, false, None, expected, force);
    };
    if meta.file_type().is_symlink() {
        return gate_save(true, true, None, expected, force);
    }
    gate_save(false, true, file_identity(path), expected, force)
}

/// Rewrites or copies relative image references so they still work from `new_dir`.
/// Images inside the document's folder are copied along (e.g. assets/); images
/// elsewhere get a new relative path pointing at the original file.
pub fn migrate_assets(content: &str, old_dir: &Path, new_dir: &Path) -> String {
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some((start, end)) = find_image_url(rest) {
        out.push_str(&rest[..start]);
        out.push_str(&migrate_url(&rest[start..end], old_dir, new_dir));
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

fn find_image_url(s: &str) -> Option<(usize, usize)> {
    match (find_markdown_image(s), find_html_image(s)) {
        (Some(a), Some(b)) => Some(if a.0 <= b.0 { a } else { b }),
        (a, b) => a.or(b),
    }
}

/// `![alt](url "title")` or `![alt](<url with spaces>)`.
fn find_markdown_image(s: &str) -> Option<(usize, usize)> {
    let mut from = 0;
    while let Some(i) = s[from..].find("![") {
        let start = from + i;
        let j = s[start..].find("](")?;
        let url_start = start + j + 2;
        if s[start..url_start].contains("\n\n") {
            from = start + 2;
            continue;
        }
        let tail = &s[url_start..];
        if let Some(inner) = tail.strip_prefix('<') {
            let end = inner.find('>')?;
            return Some((url_start + 1, url_start + 1 + end));
        }
        let mut depth = 0usize;
        let mut end = tail.len();
        for (k, c) in tail.char_indices() {
            match c {
                '(' => depth += 1,
                ')' if depth == 0 => {
                    end = k;
                    break;
                }
                ')' => depth -= 1,
                c if c.is_whitespace() => {
                    end = k;
                    break;
                }
                _ => {}
            }
        }
        return Some((url_start, url_start + end));
    }
    None
}

/// `<img src="url">`.
fn find_html_image(s: &str) -> Option<(usize, usize)> {
    let mut from = 0;
    while let Some(i) = s[from..].find("<img") {
        let tag_start = from + i;
        let tag_end = tag_start + s[tag_start..].find('>').unwrap_or(s.len() - tag_start);
        let tag = &s[tag_start..tag_end];
        if let Some(j) = tag.find("src=") {
            let value_start = tag_start + j + 4;
            if let Some(quote) = s[value_start..].chars().next().filter(|c| *c == '"' || *c == '\'') {
                let url_start = value_start + 1;
                if let Some(len) = s[url_start..tag_end].find(quote) {
                    return Some((url_start, url_start + len));
                }
            }
        }
        from = tag_end.max(tag_start + 4);
    }
    None
}

fn has_scheme(url: &str) -> bool {
    match url.find(':') {
        // A single letter before ':' is a Windows drive, not a scheme.
        Some(i) if i >= 2 => url[..i].chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c)),
        _ => false,
    }
}

fn migrate_url(url: &str, old_dir: &Path, new_dir: &Path) -> String {
    let is_windows_absolute = url.len() > 2 && url.as_bytes()[1] == b':';
    if url.is_empty() || url.starts_with(['#', '/', '\\']) || has_scheme(url) || is_windows_absolute {
        return url.to_string();
    }
    let decoded = percent_decode_str(url).decode_utf8_lossy().replace('\\', "/");
    let relative = Path::new(&decoded);
    let source = old_dir.join(relative);
    if !source.is_file() {
        return url.to_string();
    }

    let inside = relative.components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    if inside {
        let target = new_dir.join(relative);
        if target.exists() {
            if std::fs::read(&target).ok() == std::fs::read(&source).ok() {
                return url.to_string();
            }
        } else if !is_symlink(&source)
            && target.parent().is_some_and(|dir| std::fs::create_dir_all(dir).is_ok())
            && std::fs::copy(&source, &target).is_ok()
        {
            return url.to_string();
        }
    }
    match relative_path(new_dir, &source) {
        Some(path) => encode_url(&path),
        None => encode_url(&source.to_string_lossy().replace('\\', "/")),
    }
}

/// Absolute path with `.` and `..` resolved lexically.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in absolute(path).components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

fn relative_path(from_dir: &Path, to: &Path) -> Option<String> {
    let (from_dir, to) = (normalize(from_dir), normalize(to));
    let from: Vec<_> = from_dir.components().collect();
    let to: Vec<_> = to.components().collect();
    if from.first() != to.first() {
        return None; // different drives on Windows
    }
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut parts: Vec<String> = vec!["..".into(); from.len() - common];
    parts.extend(to[common..].iter().map(|c| c.as_os_str().to_string_lossy().into_owned()));
    Some(parts.join("/"))
}

fn encode_url(path: &str) -> String {
    path.replace(' ', "%20").replace('(', "%28").replace(')', "%29")
}

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico", "tif", "tiff", "heic"];
const MAX_EMBEDDED_IMAGE: u64 = 50 * 1024 * 1024;

/// The real file behind `path` if it is an image. Symlinks are resolved first, so a link named
/// `x.png` that points at a key or password file is refused.
pub fn image_target(path: &Path) -> Option<PathBuf> {
    let real = std::fs::canonicalize(path).ok()?;
    let ext = real.extension()?.to_str()?.to_lowercase();
    (IMAGE_EXTENSIONS.contains(&ext.as_str()) && real.is_file()).then_some(real)
}

/// Lets the page display one local image. The asset protocol starts with an empty scope, so
/// only images that documents actually reference become readable. Returns the path to load.
#[tauri::command]
pub fn allow_image(window: WebviewWindow, path: PathBuf) -> Option<PathBuf> {
    let real = image_target(&path)?;
    let app = window.app_handle();
    let allowed = with_win(app, window.label(), |w| image_permitted(w, &real)).unwrap_or(false);
    if !allowed {
        return None;
    }
    app.asset_protocol_scope().allow_file(&real).ok()?;
    Some(real)
}

fn image_permitted(state: &WinState, real: &Path) -> bool {
    state.allowed_dirs.iter().any(|dir| inside(dir, real))
        || state.allowed_files.iter().any(|file| file == real)
        || state.pending_image.as_ref().is_some_and(|image| image == real)
}

/// A local image as a data: URL, for self-contained HTML export.
#[tauri::command]
pub fn image_data_url(window: WebviewWindow, path: PathBuf) -> Result<String, String> {
    use base64::Engine;
    let real = image_target(&path).ok_or("不是图片文件")?;
    let allowed = with_win(window.app_handle(), window.label(), |w| image_permitted(w, &real)).unwrap_or(false);
    if !allowed {
        return Err("没有读取这张图片的权限".into());
    }
    let size = std::fs::metadata(&real).map_err(|e| describe(&e))?.len();
    if size > MAX_EMBEDDED_IMAGE {
        return Err("图片太大，无法嵌入".into());
    }
    let bytes = std::fs::read(&real).map_err(|e| describe(&e))?;
    let ext = real.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "tif" | "tiff" => "image/tiff",
        other => return Ok(format!("data:image/{other};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))),
    };
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Stores a pasted or dropped image in an assets/ folder next to the document.
#[tauri::command]
pub fn save_image(window: WebviewWindow, request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("图片数据无效".into());
    };
    let name = request
        .headers()
        .get("x-file-name")
        .and_then(|value| value.to_str().ok())
        .map(|value| percent_decode_str(value).decode_utf8_lossy().into_owned())
        .unwrap_or_default();
    let doc = with_win(window.app_handle(), window.label(), |w| w.doc.clone()).flatten();
    let doc = doc.ok_or("文档还没有保存位置")?;
    let dir = doc.parent().ok_or("文档位置无效")?.join("assets");
    std::fs::create_dir_all(&dir).map_err(|e| describe(&e))?;

    let name = Path::new(&name);
    let ext = image_ext(name);
    let mut stem = String::new();
    for c in name.file_stem().and_then(|s| s.to_str()).unwrap_or("").chars() {
        if c.is_alphanumeric() || c == '_' || c == '-' {
            stem.push(c);
        } else if !stem.ends_with('-') {
            stem.push('-');
        }
    }
    if stem.is_empty() {
        stem = "图片".into();
    }
    let mut file_name = format!("{stem}.{ext}");
    let mut i = 1;
    while dir.join(&file_name).exists() {
        file_name = format!("{stem}-{i}.{ext}");
        i += 1;
    }
    std::fs::write(dir.join(&file_name), bytes).map_err(|e| describe(&e))?;
    Ok(format!("assets/{file_name}"))
}

/// Copies an image file into the document's assets/ folder (used by "替换" on an image).
#[tauri::command]
pub fn import_image(window: WebviewWindow, path: PathBuf) -> Result<String, String> {
    let real = image_target(&path).ok_or("不是图片文件")?;
    let app = window.app_handle();
    let doc = with_win(app, window.label(), |w| w.doc.clone()).flatten();
    let doc_dir = doc.as_ref().and_then(|d| d.parent()).and_then(|dir| std::fs::canonicalize(dir).ok()).ok_or("文档还没有保存位置")?;
    let pending = with_win(app, window.label(), |w| w.pending_image.take()).flatten();
    if !inside(&doc_dir, &real) && pending.as_ref() != Some(&real) {
        return Err("请重新选择图片".into());
    }
    if let Ok(inside_path) = real.strip_prefix(&doc_dir) {
        return Ok(encode_url(&inside_path.to_string_lossy().replace('\\', "/")));
    }
    let dir = doc_dir.join("assets");
    std::fs::create_dir_all(&dir).map_err(|e| describe(&e))?;
    let path = real;
    let name = path.file_name().ok_or("图片路径无效")?.to_string_lossy().into_owned();
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) => (stem.to_string(), format!(".{ext}")),
        None => (name.clone(), String::new()),
    };
    let mut file_name = name.clone();
    let mut i = 1;
    while dir.join(&file_name).exists() {
        if std::fs::read(dir.join(&file_name)).ok() == std::fs::read(&path).ok() {
            return Ok(encode_url(&format!("assets/{file_name}")));
        }
        file_name = format!("{stem}-{i}{ext}");
        i += 1;
    }
    std::fs::copy(&path, dir.join(&file_name)).map_err(|e| describe(&e))?;
    Ok(encode_url(&format!("assets/{file_name}")))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    path: PathBuf,
    is_dir: bool,
}

/// Hidden folders, build output and macOS bundles (apps are folders too) stay out of the file list.
fn is_hidden(name: &str) -> bool {
    name.starts_with('.') || SKIPPED_DIRS.contains(&name) || name.ends_with(".app")
}

/// Folders and documents directly inside `path`, folders first.
#[tauri::command]
pub fn list_dir(window: WebviewWindow, path: PathBuf) -> Result<Vec<Entry>, String> {
    let path = authorize(window.app_handle(), window.label(), &path)?;
    if !path.is_dir() {
        return Err("这是一个文件".into());
    }
    let mut entries: Vec<Entry> = std::fs::read_dir(&path)
        .map_err(|e| describe(&e))?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            let kind = entry.file_type().ok()?;
            if kind.is_symlink() {
                let Ok(target) = std::fs::canonicalize(&path) else { return None };
                if !is_document(&target) {
                    return None;
                }
                return Some(Entry { name, path, is_dir: false });
            }
            let is_dir = kind.is_dir();
            if (is_dir && is_hidden(&name)) || (!is_dir && (name.starts_with('.') || !is_document(&path))) {
                return None;
            }
            Some(Entry { name, path, is_dir })
        })
        .collect();
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}

/// Every document under `root` (bounded), for quick open.
#[tauri::command]
pub async fn list_documents(window: WebviewWindow, root: PathBuf) -> Vec<PathBuf> {
    let Ok(root) = authorize(window.app_handle(), window.label(), &root) else { return Vec::new() };
    if !root.is_dir() {
        return Vec::new();
    }
    let mut found = Vec::new();
    let mut stack = vec![(root, 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            match entry.file_type() {
                Ok(t) if t.is_dir() && !is_hidden(&name) && depth < 12 => stack.push((path, depth + 1)),
                Ok(t) if t.is_file() && !name.starts_with('.') && is_document(&path) => {
                    found.push(path);
                    if found.len() >= MAX_LISTED_DOCUMENTS {
                        return found;
                    }
                }
                _ => {}
            }
        }
    }
    found
}

#[tauri::command]
pub fn set_root(window: WebviewWindow, path: Option<PathBuf>) -> Result<(), String> {
    let app = window.app_handle();
    let path = match path {
        Some(path) => Some(authorize(app, window.label(), &path)?),
        None => None,
    };
    if path.as_ref().is_some_and(|path| !path.is_dir()) {
        return Err("不是文件夹".into());
    }
    with_win(app, window.label(), |w| {
        w.root_canonical = path.as_ref().and_then(|p| std::fs::canonicalize(p).ok());
        w.root = path.clone();
    });
    if let Some(path) = &path {
        app_state(app).store.lock().unwrap().add_recent_folder(path);
    }
    watch::update(app, window.label());
    Ok(())
}

/// Creates "未命名.md" (or "未命名 2.md", …) in `dir`.
#[tauri::command]
pub fn create_document(window: WebviewWindow, dir: PathBuf) -> Result<PathBuf, String> {
    let dir = authorize(window.app_handle(), window.label(), &dir)?;
    if !dir.is_dir() {
        return Err("不是文件夹".into());
    }
    for i in 1.. {
        let name = if i == 1 { "未命名.md".to_string() } else { format!("未命名 {i}.md") };
        let path = dir.join(name);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(_) => return Ok(path),
            Err(err) if err.kind() == ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(describe(&err)),
        }
    }
    unreachable!()
}

/// Renames a file or folder in place, keeping the extension if the new name has none.
#[tauri::command]
pub fn rename_path(window: WebviewWindow, path: PathBuf, name: String) -> Result<PathBuf, String> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." {
        return Err("名称不能为空".into());
    }
    if name.contains(['/', '\\', ':']) {
        return Err("名称不能包含 / \\ :".into());
    }
    let path = absolute(&path);
    let parent = path.parent().ok_or("无法重命名")?;
    // Authorize the folder, not the canonical target: renaming a symlink must rename the link.
    authorize(window.app_handle(), window.label(), parent)?;
    let mut target = path.with_file_name(name);
    if path.is_file() && target.extension().is_none() {
        if let Some(ext) = path.extension() {
            target.set_extension(ext);
        }
    }
    if target == path {
        return Ok(path);
    }
    if target.exists() {
        return Err("已存在同名文件".into());
    }
    std::fs::rename(&path, &target).map_err(|e| describe(&e))?;

    let app = window.app_handle();
    let label = window.label();
    with_win(app, label, |w| {
        if let Some(rest) = w.doc.as_ref().and_then(|doc| doc.strip_prefix(&path).ok()) {
            let doc = target.join(rest);
            w.doc_canonical = std::fs::canonicalize(&doc).ok();
            w.doc = Some(doc);
        }
    });
    app_state(app).store.lock().unwrap().rename_path(&path, &target);
    watch::update(app, label);
    Ok(target)
}

// Drafts: untitled documents are kept in the app data folder until saved or discarded.

pub fn draft_file(app: &AppHandle, id: &str) -> PathBuf {
    app_state(app).drafts_dir.join(format!("{id}.md"))
}

static DRAFT_COUNTER: AtomicU32 = AtomicU32::new(0);

#[tauri::command]
pub fn draft_write(window: WebviewWindow, content: String) -> Result<String, String> {
    let app = window.app_handle();
    let id = with_win(app, window.label(), |w| {
        w.draft_id
            .get_or_insert_with(|| {
                let millis = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or_default();
                format!("{millis}-{}", DRAFT_COUNTER.fetch_add(1, Ordering::Relaxed))
            })
            .clone()
    })
    .ok_or("窗口已关闭")?;
    std::fs::create_dir_all(&app_state(app).drafts_dir).map_err(|e| describe(&e))?;
    atomic_write(&draft_file(app, &id), content.as_bytes())?;
    Ok(id)
}

#[tauri::command]
pub fn draft_delete(window: WebviewWindow) {
    let app = window.app_handle();
    if let Some(id) = with_win(app, window.label(), |w| w.draft_id.take()).flatten() {
        let _ = std::fs::remove_file(draft_file(app, &id));
    }
}

/// Drafts left from the last session (empty ones are removed).
pub fn saved_drafts(app: &AppHandle) -> Vec<(String, String)> {
    let Ok(entries) = std::fs::read_dir(&app_state(app).drafts_dir) else { return Vec::new() };
    let mut drafts: Vec<(String, String)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                return None;
            }
            let content = std::fs::read_to_string(&path).ok()?;
            if content.trim().is_empty() {
                let _ = std::fs::remove_file(&path);
                return None;
            }
            Some((path.file_stem()?.to_string_lossy().into_owned(), content))
        })
        .collect();
    drafts.sort();
    drafts
}

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// Splits concatenated PNG files by walking their chunks (signature, IHDR first, up to IEND).
/// The page can write only PNG through export_image, whatever it sends.
pub fn split_pngs(bytes: &[u8], expected: usize) -> Result<Vec<&[u8]>, String> {
    let invalid = || "图片数据无效".to_string();
    let mut parts = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let start = at;
        if bytes.get(at..at + 8) != Some(&PNG_SIGNATURE[..]) {
            return Err(invalid());
        }
        at += 8;
        let mut first = true;
        loop {
            let head = bytes.get(at..at + 8).ok_or_else(invalid)?;
            let length = u32::from_be_bytes([head[0], head[1], head[2], head[3]]) as usize;
            let kind = &head[4..8];
            if first && kind != b"IHDR" {
                return Err(invalid());
            }
            first = false;
            at = at.checked_add(12).and_then(|n| n.checked_add(length)).ok_or_else(invalid)?;
            if at > bytes.len() {
                return Err(invalid());
            }
            if kind == b"IEND" {
                break;
            }
        }
        parts.push(&bytes[start..at]);
        if parts.len() > expected {
            return Err(invalid());
        }
    }
    if parts.len() != expected || expected == 0 {
        return Err(invalid());
    }
    Ok(parts)
}

/// The chosen path with `.png` added unless it already ends that way (GTK adds no extension).
pub fn png_target(path: PathBuf) -> PathBuf {
    let is_png = path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("png"));
    if is_png {
        return path;
    }
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".png");
    path.with_file_name(name)
}

/// `name-1.png … name-N.png` next to the chosen file.
pub fn part_paths(path: &Path, count: usize) -> Vec<PathBuf> {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "未命名".into());
    (1..=count).map(|i| path.with_file_name(format!("{stem}-{i}.png"))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_markdown_and_html_images() {
        let s = "a ![x](assets/a.png \"t\") b <img src=\"pic/b.jpg\" width=3> ![y](<my pic.png>)";
        let mut urls = Vec::new();
        let mut rest = s;
        while let Some((a, b)) = find_image_url(rest) {
            urls.push(rest[a..b].to_string());
            rest = &rest[b..];
        }
        assert_eq!(urls, ["assets/a.png", "pic/b.jpg", "my pic.png"]);
    }

    #[test]
    fn only_image_extensions_survive_a_pasted_name() {
        assert_eq!(image_ext(Path::new("a.PNG")), "png");
        assert_eq!(image_ext(Path::new("照片.jpeg")), "jpeg");
        // 页面给的名字不能决定写出去的后缀。
        assert_eq!(image_ext(Path::new("x.sh")), "png");
        assert_eq!(image_ext(Path::new("x")), "png");
        assert_eq!(image_ext(Path::new("x.tar.gz")), "png");
        assert_eq!(image_ext(Path::new("x.")), "png");
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_is_a_document_only_when_its_target_is() {
        let base = std::env::temp_dir().join(format!("mdpad-doc-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let secret = base.join("id_rsa");
        let real = base.join("notes.md");
        std::fs::write(&secret, "KEY").unwrap();
        std::fs::write(&real, "# hi\n").unwrap();
        std::os::unix::fs::symlink(&secret, base.join("leak.md")).unwrap();
        std::os::unix::fs::symlink(&real, base.join("alias.md")).unwrap();
        let leak = std::fs::canonicalize(base.join("leak.md")).unwrap();
        let alias = std::fs::canonicalize(base.join("alias.md")).unwrap();
        assert!(!is_document(&leak), "a link named .md must not open a non-document");
        assert!(is_document(&alias));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn only_documents_are_readable_through_the_page() {
        assert!(is_document(Path::new("/tmp/a.md")));
        assert!(is_document(Path::new("/tmp/a.MARKDOWN")));
        assert!(is_document(Path::new("/tmp/a.txt")));
        // 渲染层一旦被攻破，这些路径必须进不去。
        assert!(!is_document(Path::new("/home/u/.ssh/id_rsa")));
        assert!(!is_document(Path::new("/home/u/.aws/credentials")));
        assert!(!is_document(Path::new("/etc/passwd")));
        assert!(!is_document(Path::new("/tmp/a.sh")));
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_ignores_planted_temp_symlinks_and_keeps_document_symlinks() {
        let base = std::env::temp_dir().join(format!("mdpad-atomic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let victim = base.join("victim.txt");
        std::fs::write(&victim, "SECRET").unwrap();
        // The old, predictable temporary name, planted as a symlink to the victim.
        std::os::unix::fs::symlink(&victim, base.join(".doc.md.mdpad-tmp")).unwrap();
        let doc = base.join("doc.md");
        atomic_write(&doc, b"v1").unwrap();
        atomic_write(&doc, b"v2").unwrap();
        assert_eq!(std::fs::read_to_string(&doc).unwrap(), "v2");
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "SECRET");

        // A symlink is not a place to write. `std::fs::write` would follow it and change v2.
        let link = base.join("link.md");
        std::os::unix::fs::symlink(&doc, &link).unwrap();
        assert!(atomic_write(&link, b"v3").is_err());
        assert!(is_symlink(&link));
        assert_eq!(std::fs::read_to_string(&doc).unwrap(), "v2");

        // Rename onto a directory fails. The old fallback would then call `std::fs::write`.
        let dir = base.join("not-a-file.md");
        std::fs::create_dir(&dir).unwrap();
        assert!(atomic_write(&dir, b"nope").is_err());
        assert!(dir.is_dir());
        assert!(std::fs::read_dir(&dir).unwrap().next().is_none());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn images_must_really_be_images() {
        let base = std::env::temp_dir().join(format!("mdpad-images-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let secret = base.join("id_rsa");
        std::fs::write(&secret, "KEY").unwrap();
        let picture = base.join("photo.PNG");
        std::fs::write(&picture, "png").unwrap();
        std::os::unix::fs::symlink(&secret, base.join("leak.png")).unwrap();

        assert!(image_target(&picture).is_some());
        assert!(image_target(&secret).is_none());
        assert!(image_target(&base.join("leak.png")).is_none(), "symlink to a non-image");
        assert!(image_target(Path::new("/etc/passwd")).is_none());
        assert!(image_target(&base).is_none(), "folder");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn migration_does_not_copy_through_symlinks() {
        let base = std::env::temp_dir().join(format!("mdpad-migrate-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let old = base.join("old");
        let new = base.join("new");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(base.join("secret"), "KEY").unwrap();
        std::os::unix::fs::symlink(base.join("secret"), old.join("leak.png")).unwrap();
        migrate_assets("![](leak.png)", &old, &new);
        assert!(!new.join("leak.png").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn migrates_images() {
        let base = std::env::temp_dir().join(format!("mdpad-migrate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let old = base.join("old");
        let new = base.join("new/deeper");
        std::fs::create_dir_all(old.join("assets")).unwrap();
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(old.join("assets/a b.png"), b"img").unwrap();
        std::fs::write(base.join("shared.png"), b"shared").unwrap();

        let content = "![a](assets/a%20b.png) ![s](../shared.png) ![w](https://x.y/z.png) ![m](missing.png)";
        let out = migrate_assets(content, &old, &new);
        assert_eq!(out, "![a](assets/a%20b.png) ![s](../../shared.png) ![w](https://x.y/z.png) ![m](missing.png)");
        assert_eq!(std::fs::read(new.join("assets/a b.png")).unwrap(), b"img");
        let _ = std::fs::remove_dir_all(&base);
    }

    fn tiny_png(extra: &[u8]) -> Vec<u8> {
        let mut out = PNG_SIGNATURE.to_vec();
        for (kind, data) in [(&b"IHDR"[..], &[0u8; 13][..]), (&b"IDAT"[..], extra), (&b"IEND"[..], &[][..])] {
            out.extend((data.len() as u32).to_be_bytes());
            out.extend(kind);
            out.extend(data);
            out.extend([0u8; 4]);
        }
        out
    }

    #[test]
    fn splits_concatenated_pngs_and_rejects_anything_else() {
        let (a, b) = (tiny_png(b"abc"), tiny_png(b""));
        let both = [a.clone(), b.clone()].concat();
        let parts = split_pngs(&both, 2).unwrap();
        assert_eq!(parts, [&a[..], &b[..]]);
        assert_eq!(split_pngs(&a, 1).unwrap().len(), 1);
        // 段数与声明不符
        assert!(split_pngs(&both, 1).is_err());
        assert!(split_pngs(&a, 2).is_err());
        assert!(split_pngs(&[], 0).is_err());
        // 缺 IEND
        assert!(split_pngs(&a[..a.len() - 12], 1).is_err());
        // 签名错误 / 首块不是 IHDR / 非 PNG
        let mut bad = a.clone();
        bad[1] = b'X';
        assert!(split_pngs(&bad, 1).is_err());
        let mut no_ihdr = a.clone();
        no_ihdr[12..16].copy_from_slice(b"IDAT");
        assert!(split_pngs(&no_ihdr, 1).is_err());
        assert!(split_pngs(b"<html></html>", 1).is_err());
        // 尾部多余字节
        assert!(split_pngs(&[a.clone(), vec![1, 2, 3]].concat(), 1).is_err());
    }

    #[test]
    fn force_does_not_skip_a_missing_or_redirected_identity() {
        let id = Some((1, 1));
        let other = Some((2, 2));
        assert_eq!(gate_save(false, true, other, id, false), SaveGate::Conflict("changed"));
        assert_eq!(gate_save(false, true, other, id, true), SaveGate::Write);
        assert_eq!(gate_save(true, true, other, id, false), SaveGate::Conflict("redirected"));
        assert_eq!(gate_save(true, true, other, id, true), SaveGate::Conflict("redirected"));
        assert_eq!(gate_save(false, true, None, id, false), SaveGate::Conflict("unverified"));
        assert_eq!(gate_save(false, true, None, id, true), SaveGate::Conflict("unverified"));
        assert_eq!(gate_save(false, true, id, None, true), SaveGate::Conflict("unverified"));
        assert_eq!(gate_save(false, false, None, id, false), SaveGate::Conflict("missing"));
        assert_eq!(gate_save(false, false, None, id, true), SaveGate::Create);
    }

    #[cfg(unix)]
    #[test]
    fn a_swapped_symlink_is_not_written_even_when_forced() {
        let base = std::env::temp_dir().join(format!("mdpad-force-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let doc = base.join("notes.md");
        let secret = base.join("secret.md");
        std::fs::write(&doc, "v1").unwrap();
        std::fs::write(&secret, "SECRET").unwrap();
        let opened = file_identity(&doc).unwrap();

        // Another editor replaced the file in place. Force may put the user's text back.
        let tmp = base.join("notes.md.new");
        std::fs::write(&tmp, "v2").unwrap();
        std::fs::rename(&tmp, &doc).unwrap();
        assert_ne!(file_identity(&doc), Some(opened));
        assert_eq!(gate_path(&doc, Some(opened), false), SaveGate::Conflict("changed"));
        assert_eq!(std::fs::read_to_string(&doc).unwrap(), "v2");
        assert_eq!(gate_path(&doc, Some(opened), true), SaveGate::Write);
        atomic_write(&doc, b"mine").unwrap();
        assert_eq!(std::fs::read_to_string(&doc).unwrap(), "mine");
        assert!(!doc.symlink_metadata().unwrap().file_type().is_symlink());
        let kept = file_identity(&doc).unwrap();

        // The same path is then replaced by a symlink. Force must not follow it.
        std::fs::remove_file(&doc).unwrap();
        std::os::unix::fs::symlink(&secret, &doc).unwrap();
        assert_eq!(gate_path(&doc, Some(kept), false), SaveGate::Conflict("redirected"));
        assert_eq!(gate_path(&doc, Some(kept), true), SaveGate::Conflict("redirected"));
        assert!(atomic_write(&doc, b"mine").is_err());
        assert_eq!(std::fs::read_to_string(&secret).unwrap(), "SECRET");
        assert!(doc.symlink_metadata().unwrap().file_type().is_symlink());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_windows_verbatim_path_is_given_to_the_page_as_a_plain_path() {
        assert_eq!(strip_verbatim_prefix(r"\\?\C:\docs\note.md"), r"C:\docs\note.md");
        assert_eq!(strip_verbatim_prefix(r"\\?\UNC\server\share\note.md"), r"\\server\share\note.md");
        assert_eq!(strip_verbatim_prefix("/tmp/note.md"), "/tmp/note.md");
        assert_eq!(portable_path(Path::new("/tmp/note.md")), PathBuf::from("/tmp/note.md"));
    }

    #[test]
    fn a_missing_windows_file_index_is_not_treated_as_zero() {
        assert_eq!(identity_from_index(Some(7), None), None);
        assert_eq!(identity_from_index(None, Some(1)), None);
        assert_eq!(identity_from_index(Some(7), Some(0)), Some((7, 0)));
        assert_ne!(identity_from_index(Some(7), Some(1)), identity_from_index(Some(7), Some(2)));
        assert_ne!(identity_from_index(Some(7), Some(1)), identity_from_index(Some(8), Some(1)));
    }

    /// 4.0.4 的保存闸门靠文件身份放行；Windows 走 GetFileInformationByHandle。
    /// 这条查询若在真实文件上失败，冒烟测试第 1 段的「已保存 / 落盘」必然失败。
    /// 只在 Windows CI 上跑，用来确认或排除这条线，别靠猜改产品代码。
    #[cfg(windows)]
    #[test]
    fn windows_identity_lets_the_save_gate_pass() {
        let base = std::env::temp_dir().join(format!("mdpad-win-id-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let doc = base.join("sample.md");
        std::fs::write(&doc, "# hi\n").unwrap();
        let id = file_identity(&doc);
        assert!(id.is_some(), "GetFileInformationByHandle returned no identity for a plain file");
        // 编辑器持有 canonicalize 之后的路径（Windows 的 \\?\ 前缀），身份必须一致。
        let canon = std::fs::canonicalize(&doc).unwrap();
        assert_eq!(file_identity(&canon), id, "identity differs after canonicalize");
        assert_eq!(gate_path(&doc, id, false), SaveGate::Write, "the first save would be refused as unverified");
        std::fs::write(&doc, "# hi\n新增的文字\n").unwrap();
        assert_eq!(file_identity(&doc), id, "identity changed after an in-place rewrite");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn save_as_switches_identity_and_grants_the_chosen_folder() {
        let base = std::env::temp_dir().join(format!("mdpad-saveas-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("root");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let original = root.join("a.md");
        let renamed = root.join("b.md");
        let first = outside.join("未命名.md");
        let elsewhere = base.join("other");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let outside_existing = elsewhere.join("c.md");
        std::fs::write(&original, "A").unwrap();
        std::fs::write(&renamed, "old B").unwrap();
        std::fs::write(&outside_existing, "old C").unwrap();

        let mut state = WinState::default();
        state.file_id = file_identity(&original);
        state.allowed_dirs.push(std::fs::canonicalize(&root).unwrap());

        // Overwrite an existing document: the next save must see B, not A.
        std::fs::write(&renamed, "B").unwrap();
        adopt_saved_document(&mut state, &renamed);
        assert_eq!(state.file_id, file_identity(&renamed));
        assert_eq!(gate_path(&renamed, state.file_id, false), SaveGate::Write);
        // A different inode at a regular path is a content conflict. Force may replace that
        // regular file. It does not make a symlink acceptable; that case is tested separately.
        assert_eq!(gate_path(&renamed, file_identity(&original), false), SaveGate::Conflict("changed"));
        assert_eq!(gate_path(&renamed, file_identity(&original), true), SaveGate::Write);

        // First save of an untitled draft, into a folder that was not the sidebar.
        std::fs::write(&first, "draft").unwrap();
        let mut fresh = WinState::default();
        adopt_saved_document(&mut fresh, &first);
        let outside_dir = std::fs::canonicalize(&outside).unwrap();
        assert!(fresh.allowed_dirs.iter().any(|dir| dir == &outside_dir));
        assert_eq!(fresh.file_id, file_identity(&first));
        assert_eq!(gate_path(&first, fresh.file_id, false), SaveGate::Write);

        // Save outside the current root, then both a normal save and a forced save can proceed.
        std::fs::write(&outside_existing, "C").unwrap();
        adopt_saved_document(&mut state, &outside_existing);
        let other_dir = std::fs::canonicalize(&elsewhere).unwrap();
        assert!(state.allowed_dirs.iter().any(|dir| dir == &other_dir));
        assert_eq!(gate_path(&outside_existing, state.file_id, false), SaveGate::Write);
        assert_eq!(gate_path(&outside_existing, state.file_id, true), SaveGate::Write);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn a_document_symlink_does_not_grant_the_targets_folder() {
        let base = std::env::temp_dir().join(format!("mdpad-grant-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let links = base.join("links");
        let secret = base.join("secret");
        std::fs::create_dir_all(&links).unwrap();
        std::fs::create_dir_all(&secret).unwrap();
        let notes = secret.join("notes.md");
        std::fs::write(&notes, "# hi\n").unwrap();
        let alias = links.join("alias.md");
        std::os::unix::fs::symlink(&notes, &alias).unwrap();
        let picture = secret.join("shot.png");
        std::fs::write(&picture, "png").unwrap();
        let picked = links.join("picked.png");
        std::fs::write(&picked, "png").unwrap();

        let mut state = WinState::default();
        grant_file_only(&mut state, std::fs::canonicalize(&alias).unwrap());
        let secret_dir = std::fs::canonicalize(&secret).unwrap();
        let notes_real = std::fs::canonicalize(&notes).unwrap();
        assert!(state.allowed_files.iter().any(|file| file == &notes_real));
        assert!(!state.allowed_dirs.iter().any(|dir| dir == &secret_dir));

        let mut named = WinState::default();
        grant_named_file_state(&mut named, &alias);
        let links_dir = std::fs::canonicalize(&links).unwrap();
        assert!(named.allowed_dirs.iter().any(|dir| dir == &links_dir));
        assert!(named.allowed_files.iter().any(|file| file == &notes_real));
        assert!(!named.allowed_dirs.iter().any(|dir| dir == &secret_dir));

        assert!(!image_permitted(&named, &std::fs::canonicalize(&picture).unwrap()));
        assert!(image_permitted(&named, &std::fs::canonicalize(&picked).unwrap()));
        named.pending_image = Some(std::fs::canonicalize(&picture).unwrap());
        assert!(image_permitted(&named, &std::fs::canonicalize(&picture).unwrap()));
        named.pending_image = None;
        assert!(!image_permitted(&named, &std::fs::canonicalize(&picture).unwrap()));

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Same directory check `authorize` uses, without recent files or the image picker.
    fn granted_here(state: &WinState, path: &Path) -> bool {
        let Some(real) = canonical_file(path).or_else(|| canonical_dir(path)) else {
            return false;
        };
        state.allowed_files.iter().any(|file| file == &real) || state.allowed_dirs.iter().any(|dir| inside(dir, &real))
    }

    #[test]
    fn a_download_grants_its_own_folder_and_not_the_library() {
        let base = std::env::temp_dir().join(format!("mdpad-fetch-grant-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let library = base.join("MDPad");
        let book = library.join("x.com").join("demo-1");
        let notes = book.join("demo.md");
        let picture = book.join("images").join("1.jpg");
        let sibling = library.join("other");
        let secret = sibling.join("secret.md");
        let lookalike = library.join("x.com").join("demo-1-extra");
        std::fs::create_dir_all(picture.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::create_dir_all(&lookalike).unwrap();
        std::fs::write(&notes, "# hi\n").unwrap();
        std::fs::write(&picture, "jpg").unwrap();
        std::fs::write(&secret, "nope").unwrap();

        let mut state = WinState::default();
        assert!(!granted_here(&state, &book), "a new download is not already granted");
        grant_fetched_dir_state(&mut state, &book);
        grant_fetched_dir_state(&mut state, &book);

        let book_real = std::fs::canonicalize(&book).unwrap();
        let library_real = std::fs::canonicalize(&library).unwrap();
        assert_eq!(state.allowed_dirs, vec![book_real]);
        assert!(granted_here(&state, &book));
        assert!(granted_here(&state, &notes));
        assert!(granted_here(&state, picture.parent().unwrap()));
        assert!(!granted_here(&state, &library));
        assert!(!state.allowed_dirs.iter().any(|dir| dir == &library_real));
        assert!(!granted_here(&state, &sibling));
        assert!(!granted_here(&state, &secret));
        assert!(!granted_here(&state, &lookalike));
        grant_fetched_dir_state(&mut state, &notes);
        assert_eq!(state.allowed_dirs.len(), 1, "a file is not a folder grant");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_download_folder_does_not_grant_its_target() {
        let base = std::env::temp_dir().join(format!("mdpad-fetch-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let secret = base.join("secret");
        std::fs::create_dir_all(&secret).unwrap();
        std::fs::write(secret.join("notes.md"), "# hi\n").unwrap();
        let alias = base.join("book");
        std::os::unix::fs::symlink(&secret, &alias).unwrap();

        let mut state = WinState::default();
        grant_fetched_dir_state(&mut state, &alias);
        let secret_real = std::fs::canonicalize(&secret).unwrap();
        assert!(state.allowed_dirs.is_empty());
        assert!(!granted_here(&state, &secret));
        assert!(!state.allowed_dirs.iter().any(|dir| dir == &secret_real));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn png_targets_and_part_names() {
        assert_eq!(png_target(PathBuf::from("/x/a")), PathBuf::from("/x/a.png"));
        assert_eq!(png_target(PathBuf::from("/x/a.PNG")), PathBuf::from("/x/a.PNG"));
        assert_eq!(png_target(PathBuf::from("/x/a.jpg")), PathBuf::from("/x/a.jpg.png"));
        let parts = part_paths(Path::new("/x/笔记.png"), 3);
        assert_eq!(parts, ["/x/笔记-1.png", "/x/笔记-2.png", "/x/笔记-3.png"].map(PathBuf::from));
    }
}
