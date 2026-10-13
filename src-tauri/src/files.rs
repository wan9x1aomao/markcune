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

use crate::state::{absolute, app_state, with_win, Version};
use crate::watch;

pub const DOC_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "txt"];
const SKIPPED_DIRS: &[&str] = &["node_modules", "target", "dist", "build"];
const MAX_LISTED_DOCUMENTS: usize = 5000;

pub fn is_document(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| DOC_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
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
/// where it is about to land. A symlinked document is written through to the file it points at,
/// instead of being replaced by a regular file.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let path = match std::fs::canonicalize(path) {
        Ok(real) if is_symlink(path) => real,
        _ => path.to_path_buf(),
    };
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
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
        // Some locations (network shares, files locked on Windows) refuse renames.
        std::fs::write(&path, bytes).map_err(|e| describe(&e))?;
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
    let bytes = std::fs::read(&path).map_err(|e| describe(&e))?;
    let content = String::from_utf8(bytes).map_err(|_| "文件不是 UTF-8 编码的文本".to_string())?;
    let app = window.app_handle();
    remember_document(app, window.label(), &path, &content);
    let position = app_state(app).store.lock().unwrap().position(&path);
    Ok(Opened { path, content, position, rewritten: false })
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
    atomic_write(&path, content.as_bytes())?;
    with_win(app, label, |w| {
        w.version = Some(Version::of(content.as_bytes()));
        w.doc_canonical = std::fs::canonicalize(&path).ok();
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
    remember_document(&app, &label, &target, &content);
    Ok(Some(Opened { path: target, content, position: None, rewritten }))
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
pub fn allow_image(app: AppHandle, path: PathBuf) -> Option<PathBuf> {
    let real = image_target(&path)?;
    app.asset_protocol_scope().allow_file(&real).ok()?;
    Some(real)
}

/// A local image as a data: URL, for self-contained HTML export.
#[tauri::command]
pub fn image_data_url(path: PathBuf) -> Result<String, String> {
    use base64::Engine;
    let real = image_target(&path).ok_or("不是图片文件")?;
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
    let ext = name.extension().and_then(|e| e.to_str()).filter(|e| !e.is_empty()).unwrap_or("png");
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
    let doc = with_win(window.app_handle(), window.label(), |w| w.doc.clone()).flatten();
    let doc_dir = doc.as_ref().and_then(|d| d.parent()).ok_or("文档还没有保存位置")?;
    if let Ok(inside) = path.strip_prefix(doc_dir) {
        return Ok(encode_url(&inside.to_string_lossy().replace('\\', "/")));
    }
    let dir = doc_dir.join("assets");
    std::fs::create_dir_all(&dir).map_err(|e| describe(&e))?;
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
pub fn list_dir(path: PathBuf) -> Result<Vec<Entry>, String> {
    let mut entries: Vec<Entry> = std::fs::read_dir(&path)
        .map_err(|e| describe(&e))?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            let is_dir = entry.file_type().ok()?.is_dir();
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
pub async fn list_documents(root: PathBuf) -> Vec<PathBuf> {
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
pub fn set_root(window: WebviewWindow, path: Option<PathBuf>) {
    let app = window.app_handle();
    let path = path.map(|p| absolute(&p));
    with_win(app, window.label(), |w| {
        w.root_canonical = path.as_ref().and_then(|p| std::fs::canonicalize(p).ok());
        w.root = path.clone();
    });
    if let Some(path) = &path {
        app_state(app).store.lock().unwrap().add_recent_folder(path);
    }
    watch::update(app, window.label());
}

/// Creates "未命名.md" (or "未命名 2.md", …) in `dir`.
#[tauri::command]
pub fn create_document(dir: PathBuf) -> Result<PathBuf, String> {
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
    if name.is_empty() {
        return Err("名称不能为空".into());
    }
    if name.contains(['/', '\\', ':']) {
        return Err("名称不能包含 / \\ :".into());
    }
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

        // Saving a symlinked document updates the file it points at and keeps the link.
        let link = base.join("link.md");
        std::os::unix::fs::symlink(&doc, &link).unwrap();
        atomic_write(&link, b"v3").unwrap();
        assert!(is_symlink(&link));
        assert_eq!(std::fs::read_to_string(&doc).unwrap(), "v3");
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
}
