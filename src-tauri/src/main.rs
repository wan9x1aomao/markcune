#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod fetch;
mod files;
mod pinned;
mod state;
mod store;
mod tweet;
mod update;
mod voice;
mod watch;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;

use percent_encoding::percent_decode_str;
use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::ipc::{InvokeBody, Request};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};
use tauri_plugin_opener::OpenerExt;

use state::{absolute, app_state, with_win, AppState, Startup, WinState};
use store::Store;

fn focused_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false))
}

fn create_window(app: &AppHandle, startup: Startup) {
    let state = app_state(app);
    let label = format!("doc-{}", state.next_id.fetch_add(1, Ordering::Relaxed));
    state.windows.lock().unwrap().insert(label.clone(), WinState { startup: Some(startup), ..Default::default() });

    // Native file drops are off so HTML5 drag and drop (block handles, image drops) works on Windows too.
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("MDPad")
        .inner_size(1100.0, 760.0)
        .min_inner_size(520.0, 360.0)
        .disable_drag_drop_handler();
    // Windows: the page draws its own title bar with window buttons (no native title or menu bar).
    #[cfg(windows)]
    {
        builder = builder.decorations(false).shadow(true);
    }
    #[cfg(target_os = "macos")]
    {
        // The page's top bar doubles as the title bar.
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(16.0, 21.0));
    }
    let parent = focused_window(app).and_then(|w| Some((w.outer_position().ok()?, w.scale_factor().ok()?)));
    builder = match parent {
        Some((position, scale)) => {
            let position = position.to_logical::<f64>(scale);
            builder.position(position.x + 24.0, position.y + 24.0)
        }
        None => builder.center(),
    };
    if builder.build().is_err() {
        state.windows.lock().unwrap().remove(&label);
    }
}

/// Opens a file or folder from outside (Finder, command line, second launch).
fn open_path(app: &AppHandle, path: PathBuf) {
    let path = absolute(&path);
    let is_dir = path.is_dir();
    let startup = if is_dir { Startup::Folder { path: path.clone() } } else { Startup::File { path: path.clone() } };

    enum Target {
        Focus(String),
        Ready(String),
        Pending,
        New,
    }
    let state = app_state(app);
    let target = {
        let mut windows = state.windows.lock().unwrap();
        if let Some((label, _)) = windows.iter().find(|(_, w)| !is_dir && w.doc.as_deref() == Some(path.as_path())) {
            Target::Focus(label.clone())
        } else if let Some(w) = windows.values_mut().find(|w| matches!(w.startup, Some(Startup::Empty))) {
            w.startup = Some(startup.clone());
            Target::Pending
        } else if let Some((label, _)) = windows.iter().find(|(_, w)| w.startup.is_none() && w.is_empty()) {
            Target::Ready(label.clone())
        } else {
            Target::New
        }
    };
    match target {
        Target::Focus(label) => {
            if let Some(window) = app.get_webview_window(&label) {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
        Target::Ready(label) => {
            let _ = app.emit_to(label.as_str(), "open-path", json!({ "path": path, "isDir": is_dir }));
            if let Some(window) = app.get_webview_window(&label) {
                let _ = window.set_focus();
            }
        }
        Target::Pending => {}
        Target::New => create_window(app, startup),
    }
}

fn path_args(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<PathBuf> {
    args.into_iter()
        .filter(|arg| !arg.starts_with('-'))
        .map(|arg| cwd.join(arg))
        .filter(|path| path.is_dir() || (path.is_file() && files::is_document(path)))
        .collect()
}

/// Closes every window (each page saves or asks first); the app exits once the last one is gone.
fn quit(app: &AppHandle) {
    app_state(app).quitting.store(true, Ordering::Relaxed);
    let windows = app.webview_windows();
    if windows.is_empty() {
        app.exit(0);
    }
    for window in windows.values() {
        let _ = window.close();
    }
}

fn zoom(app: &AppHandle, window: &WebviewWindow, id: &str) {
    let level = with_win(app, window.label(), |w| {
        let current = w.zoom.unwrap_or(1.0);
        let next = match id {
            "zoom-in" => (current + 0.1).min(3.0),
            "zoom-out" => (current - 0.1).max(0.5),
            _ => 1.0,
        };
        w.zoom = Some(next);
        next
    });
    if let Some(level) = level {
        let _ = window.set_zoom(level);
    }
}

fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "new-window" => return create_window(app, Startup::Empty),
        "quit" => return quit(app),
        _ => {}
    }
    let Some(window) = focused_window(app) else {
        // No window (macOS): still let people open things.
        let handle = app.clone();
        match id {
            "open-file" => app.dialog().file().add_filter("Markdown 文稿", files::DOC_EXTENSIONS).pick_files(move |paths| {
                for path in paths.unwrap_or_default().into_iter().filter_map(|p| p.into_path().ok()) {
                    open_path(&handle, path);
                }
            }),
            "open-folder" => app.dialog().file().pick_folder(move |path| {
                if let Some(path) = path.and_then(|p| p.into_path().ok()) {
                    open_path(&handle, path);
                }
            }),
            _ => {}
        }
        return;
    };
    match id {
        "zoom-in" | "zoom-out" | "zoom-reset" => zoom(app, &window, id),
        "fullscreen" => {
            let _ = window.set_fullscreen(!window.is_fullscreen().unwrap_or(false));
        }
        _ => {
            let _ = app.emit_to(window.label(), "menu", id);
        }
    }
}

/// Window-level actions the page triggers itself on Windows and Linux, which have no native menu.
#[tauri::command]
fn native_action(app: AppHandle, id: String) {
    if matches!(id.as_str(), "new-window" | "quit" | "zoom-in" | "zoom-out" | "zoom-reset" | "fullscreen") {
        handle_menu(&app, &id);
    }
}

/// The native menu bar, used on macOS only.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let mac = cfg!(target_os = "macos");
    let item = |id: &str, text: &str, accelerator: Option<&str>| MenuItem::with_id(app, id, text, true, accelerator);
    let separator = || PredefinedMenuItem::separator(app);
    let menu = Menu::new(app)?;

    #[cfg(target_os = "macos")]
    menu.append(&Submenu::with_items(app, "MDPad", true, &[
        &PredefinedMenuItem::about(app, Some("关于 MDPad"), None)?,
        &item("settings", "设置…", Some("CmdOrCtrl+,"))?,
        &separator()?,
        &item("check-update", "检查更新…", None)?,
        &item("changelog", "更新日志", None)?,
        &separator()?,
        &PredefinedMenuItem::hide(app, Some("隐藏 MDPad"))?,
        &PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?,
        &PredefinedMenuItem::show_all(app, Some("全部显示"))?,
        &separator()?,
        &item("quit", "退出 MDPad", Some("CmdOrCtrl+Q"))?,
    ])?)?;

    let file = Submenu::with_items(app, "文件", true, &[
        &item("new-window", "新建窗口", Some("CmdOrCtrl+N"))?,
        &item("new-document", "在文件夹中新建文档", None)?,
        &separator()?,
        &item("open-file", "打开文件…", Some("CmdOrCtrl+O"))?,
        &item("open-folder", "打开文件夹…", Some("CmdOrCtrl+Shift+O"))?,
        &item("open-from-url", "从链接打开…", None)?,
        &item("quick-open", "快速打开…", Some("CmdOrCtrl+P"))?,
        &separator()?,
        &item("save", "保存", Some("CmdOrCtrl+S"))?,
        &item("save-as", "另存为…", Some("CmdOrCtrl+Shift+S"))?,
        &item("rename", "重命名…", None)?,
        &item("reveal", if mac { "在访达中显示" } else { "在资源管理器中显示" }, None)?,
        &separator()?,
        &item("export-html", "导出为网页…", None)?,
        &item("export-word", "导出为 Word…", None)?,
        &item("export-pdf", "导出为 PDF…", None)?,
        &separator()?,
        &item("close", "关闭窗口", Some("CmdOrCtrl+W"))?,
    ])?;
    if !mac {
        file.append(&item("quit", "退出", Some("Alt+F4"))?)?;
    }
    menu.append(&file)?;

    let edit = Submenu::new(app, "编辑", true)?;
    if mac {
        edit.append(&PredefinedMenuItem::undo(app, Some("撤销"))?)?;
        edit.append(&PredefinedMenuItem::redo(app, Some("重做"))?)?;
    } else {
        edit.append(&item("undo", "撤销", Some("Ctrl+Z"))?)?;
        edit.append(&item("redo", "重做", Some("Ctrl+Y"))?)?;
    }
    edit.append_items(&[
        &separator()?,
        &PredefinedMenuItem::cut(app, Some("剪切"))?,
        &PredefinedMenuItem::copy(app, Some("拷贝"))?,
        &PredefinedMenuItem::paste(app, Some("粘贴"))?,
        &PredefinedMenuItem::select_all(app, Some("全选"))?,
        &separator()?,
        &item("find", "查找…", Some("CmdOrCtrl+F"))?,
        &item("replace", "替换…", Some(if mac { "Cmd+Alt+F" } else { "Ctrl+H" }))?,
        &item("find-next", "查找下一个", Some("CmdOrCtrl+G"))?,
        &item("find-previous", "查找上一个", Some("CmdOrCtrl+Shift+G"))?,
    ])?;
    menu.append(&edit)?;

    menu.append(&Submenu::with_items(app, "格式", true, &[
        &item("bold", "加粗", Some("CmdOrCtrl+B"))?,
        &item("italic", "斜体", Some("CmdOrCtrl+I"))?,
        &item("strikethrough", "删除线", Some("CmdOrCtrl+Alt+X"))?,
        &item("inline-code", "行内代码", Some("CmdOrCtrl+E"))?,
        &separator()?,
        &item("tidy", "一键整理格式", Some("CmdOrCtrl+Alt+L"))?,
    ])?)?;

    menu.append(&Submenu::with_items(app, "显示", true, &[
        &item("toggle-source", "源码模式", Some("CmdOrCtrl+/"))?,
        &item("toggle-split", "分屏预览", Some("CmdOrCtrl+Alt+/"))?,
        &item("toggle-focus", "专注模式", Some("F8"))?,
        &separator()?,
        &item("toggle-sidebar", "文件列表", Some("CmdOrCtrl+Shift+L"))?,
        &item("toggle-outline", "大纲", Some("CmdOrCtrl+Shift+T"))?,
        &item("theme-toggle", "浅色 / 深色", Some("CmdOrCtrl+Shift+D"))?,
        &item("command-palette", "命令面板…", Some("CmdOrCtrl+K"))?,
        &separator()?,
        &item("zoom-reset", "实际大小", Some("CmdOrCtrl+0"))?,
        &item("zoom-in", "放大", Some("CmdOrCtrl+="))?,
        &item("zoom-out", "缩小", Some("CmdOrCtrl+-"))?,
        &separator()?,
        &item("fullscreen", "切换全屏幕", Some(if mac { "Ctrl+Cmd+F" } else { "F11" }))?,
    ])?)?;

    #[cfg(target_os = "macos")]
    menu.append(&Submenu::with_id_and_items(app, tauri::menu::WINDOW_SUBMENU_ID, "窗口", true, &[
        &PredefinedMenuItem::minimize(app, Some("最小化"))?,
        &PredefinedMenuItem::maximize(app, Some("缩放"))?,
    ])?)?;

    // macOS wants the Help menu last. Windows and Linux have no menu bar at all — their entries
    // live in the page's "···" menu, which reads the same command ids.
    #[cfg(target_os = "macos")]
    menu.append(&Submenu::with_items(app, "帮助", true, &[
        &item("help", "键盘快捷键与功能…", None)?,
        &item("changelog", "更新日志", None)?,
        &item("website", "MDPad 官网", None)?,
    ])?)?;

    Ok(menu)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InitData {
    startup: Startup,
    settings: Map<String, Value>,
    recent_files: Vec<PathBuf>,
    recent_folders: Vec<PathBuf>,
    pinned_files: Vec<pinned::Pinned>,
    platform: &'static str,
}

#[tauri::command]
fn window_init(window: WebviewWindow) -> InitData {
    let app = window.app_handle();
    let startup = with_win(app, window.label(), |w| w.startup.take()).flatten().unwrap_or(Startup::Empty);
    if let Startup::Draft { id, .. } = &startup {
        with_win(app, window.label(), |w| w.draft_id = Some(id.clone()));
    }
    #[cfg(debug_assertions)]
    test_hook::start(&window);
    let state = app_state(app);
    // Read the pins before taking the store lock — the command locks it itself.
    let pinned_files = pinned::list_pinned(app.clone());
    let store = state.store.lock().unwrap();
    InitData {
        startup,
        // 页面只拿界面偏好。`ai.apiKey` / `voice.apiKey` 也存在 settings 里，但它们属于外壳：
        // 过滤在 Store::public_settings 一处完成，以后再加凭据也只需要改那里。
        settings: store.public_settings(),
        recent_files: store.recent_files.clone(),
        recent_folders: store.recent_folders.clone(),
        pinned_files,
        platform: if cfg!(target_os = "macos") { "macos" } else if cfg!(windows) { "windows" } else { "linux" },
    }
}

#[tauri::command]
fn set_close_guard(window: WebviewWindow, guard: bool) {
    with_win(window.app_handle(), window.label(), |w| w.close_guard = guard);
}

/// Closes the window without asking the page again.
#[tauri::command]
fn close_window(window: WebviewWindow) {
    let _ = window.destroy();
}

#[tauri::command]
fn cancel_quit(app: AppHandle) {
    app_state(&app).quitting.store(false, Ordering::Relaxed);
}

#[tauri::command]
fn set_title(window: WebviewWindow, title: String) {
    let _ = window.set_title(&title);
}

/// "保存…" / "不保存" / "取消" for an untitled draft being closed.
#[tauri::command]
async fn confirm_close_draft(window: WebviewWindow) -> &'static str {
    let result = window
        .dialog()
        .message("如果不保存，这篇草稿将被删除。")
        .title("要保存这篇未命名的文档吗？")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::YesNoCancelCustom("保存…".into(), "不保存".into(), "取消".into()))
        .parent(&window)
        .blocking_show_with_result();
    match result {
        MessageDialogResult::Yes => "save",
        MessageDialogResult::No => "discard",
        MessageDialogResult::Custom(label) if label == "保存…" => "save",
        MessageDialogResult::Custom(label) if label == "不保存" => "discard",
        _ => "cancel",
    }
}

#[tauri::command]
async fn confirm(window: WebviewWindow, title: String, message: String, ok: String) -> bool {
    let result = window
        .dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(ok.clone(), "取消".into()))
        .parent(&window)
        .blocking_show_with_result();
    match result {
        MessageDialogResult::Ok => true,
        MessageDialogResult::Custom(label) => label == ok && label != "取消",
        _ => false,
    }
}

#[tauri::command]
async fn pick_documents(window: WebviewWindow) -> Vec<PathBuf> {
    window
        .dialog()
        .file()
        .add_filter("Markdown 文稿", files::DOC_EXTENSIONS)
        .set_parent(&window)
        .blocking_pick_files()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .collect()
}

#[tauri::command]
async fn pick_folder(window: WebviewWindow) -> Option<PathBuf> {
    window.dialog().file().set_parent(&window).blocking_pick_folder().and_then(|p| p.into_path().ok())
}

#[tauri::command]
async fn pick_image(window: WebviewWindow) -> Option<PathBuf> {
    window
        .dialog()
        .file()
        .add_filter("图片", &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"])
        .set_parent(&window)
        .blocking_pick_file()
        .and_then(|p| p.into_path().ok())
}

#[tauri::command]
fn open_in_new_window(app: AppHandle, path: PathBuf) {
    let path = absolute(&path);
    let startup = if path.is_dir() { Startup::Folder { path } } else { Startup::File { path } };
    create_window(&app, startup);
}

#[tauri::command]
fn new_window(app: AppHandle) {
    create_window(&app, Startup::Empty);
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) {
    let lower = url.to_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:") {
        let _ = app.opener().open_url(url, None::<&str>);
    }
}

#[tauri::command]
fn reveal(app: AppHandle, path: PathBuf) {
    let _ = app.opener().reveal_item_in_dir(path);
}

#[tauri::command]
fn print_page(window: WebviewWindow) {
    let _ = window.print();
}

#[tauri::command]
async fn export_html(window: WebviewWindow, html: String, name: String) -> Result<bool, String> {
    let directory = with_win(window.app_handle(), window.label(), |w| {
        w.doc.as_ref().and_then(|d| d.parent().map(Path::to_path_buf)).or(w.root.clone())
    })
    .flatten();
    let mut dialog = window.dialog().file().add_filter("网页", &["html"]).set_parent(&window).set_file_name(name);
    if let Some(dir) = directory {
        dialog = dialog.set_directory(dir);
    }
    let Some(target) = dialog.blocking_save_file() else { return Ok(false) };
    let target = target.into_path().map_err(|_| "无法使用所选位置".to_string())?;
    files::atomic_write(&target, html.as_bytes())?;
    Ok(true)
}

/// Saves an exported .docx. The bytes arrive as the request body: a multi-megabyte document as a
/// JSON array of numbers would be slower to encode than to write.
#[tauri::command]
async fn export_docx(window: WebviewWindow, request: Request<'_>) -> Result<bool, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("文档数据无效".into());
    };
    let name = request
        .headers()
        .get("x-file-name")
        .and_then(|value| value.to_str().ok())
        .map(|value| percent_decode_str(value).decode_utf8_lossy().into_owned())
        .unwrap_or_else(|| "未命名.docx".into());
    let directory = with_win(window.app_handle(), window.label(), |w| {
        w.doc.as_ref().and_then(|d| d.parent().map(Path::to_path_buf)).or(w.root.clone())
    })
    .flatten();
    let mut dialog = window.dialog().file().add_filter("Word 文档", &["docx"]).set_parent(&window).set_file_name(name);
    if let Some(dir) = directory {
        dialog = dialog.set_directory(dir);
    }
    let Some(target) = dialog.blocking_save_file() else { return Ok(false) };
    let target = target.into_path().map_err(|_| "无法使用所选位置".to_string())?;
    files::atomic_write(&target, bytes)?;
    Ok(true)
}

#[tauri::command]
fn remember_position(app: AppHandle, path: PathBuf, position: Value) {
    app_state(&app).store.lock().unwrap().set_position(path, position);
}

#[tauri::command]
fn set_setting(app: AppHandle, key: String, value: Value) {
    let state = app_state(&app);
    let mut store = state.store.lock().unwrap();
    store.settings.insert(key, value);
    store.save();
}

#[tauri::command]
fn test_report(window: WebviewWindow, result: String) {
    #[cfg(debug_assertions)]
    test_hook::report(window, result);
    #[cfg(not(debug_assertions))]
    let _ = (window, result);
}

/// Debug-build-only automation for tests/smoke: MDPAD_TEST_JS is an async JS body
/// run in the first window; its result is printed to stderr and the app exits.
#[cfg(debug_assertions)]
mod test_hook {
    use super::*;
    use std::sync::Once;
    use std::time::Duration;

    static START: Once = Once::new();

    pub fn start(window: &WebviewWindow) {
        #[cfg(target_os = "macos")]
        if let Some(path) = std::env::var_os("MDPAD_TEST_DROP") {
            let target = window.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(1500));
                simulate_drop(&target, PathBuf::from(path));
            });
        }
        let Ok(js) = std::env::var("MDPAD_TEST_JS") else { return };
        let window = window.clone();
        START.call_once(move || {
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(2));
                let script = format!(
                    "(async () => {{ let result; try {{ result = await (async () => {{ {js} }})(); }} \
                     catch (e) {{ result = 'EXC ' + (e && e.stack || e); }} \
                     window.__TAURI_INTERNALS__.invoke('test_report', {{ result: String(result) }}); }})()"
                );
                let _ = window.eval(&script);
            });
        });
    }

    pub fn report(window: WebviewWindow, result: String) {
        eprintln!("TEST_RESULT: {result}");
        let app = window.app_handle().clone();
        let exit = move || {
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(300));
                app.exit(0);
            });
        };
        #[cfg(target_os = "macos")]
        if let Some(path) = std::env::var_os("MDPAD_TEST_SNAPSHOT") {
            return snapshot(&window, PathBuf::from(path), exit);
        }
        exit();
    }

    /// Sends a Finder-style file drop to the webview (a real pasteboard behind a stand-in
    /// NSDraggingInfo), exercising the same performDragOperation: path as a real drag.
    #[cfg(target_os = "macos")]
    fn simulate_drop(window: &WebviewWindow, path: PathBuf) {
        use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, Sel};
        use objc2::{class, msg_send, sel};
        use std::sync::OnceLock;

        static PASTEBOARD: OnceLock<usize> = OnceLock::new();
        extern "C-unwind" fn dragging_pasteboard(_: *mut AnyObject, _: Sel) -> *mut AnyObject {
            *PASTEBOARD.get().unwrap() as *mut AnyObject
        }

        let _ = window.with_webview(move |webview| unsafe {
            let kind = super::mac_drop::filenames_type();
            let pasteboard: *mut AnyObject = msg_send![class!(NSPasteboard), pasteboardWithUniqueName];
            let types: *mut AnyObject = msg_send![class!(NSArray), arrayWithObject: kind];
            let _: isize = msg_send![pasteboard, declareTypes: types, owner: std::ptr::null_mut::<AnyObject>()];
            let c_path = std::ffi::CString::new(path.to_string_lossy().as_bytes()).unwrap();
            let ns_path: *mut AnyObject = msg_send![class!(NSString), stringWithUTF8String: c_path.as_ptr()];
            let paths: *mut AnyObject = msg_send![class!(NSArray), arrayWithObject: ns_path];
            let _: objc2::runtime::Bool = msg_send![pasteboard, setPropertyList: paths, forType: kind];
            let _ = PASTEBOARD.set(pasteboard as usize);

            let info_class: &AnyClass = AnyClass::get(c"MDPadTestDraggingInfo").unwrap_or_else(|| {
                let mut builder = ClassBuilder::new(c"MDPadTestDraggingInfo", class!(NSObject)).unwrap();
                builder.add_method(
                    sel!(draggingPasteboard),
                    dragging_pasteboard as extern "C-unwind" fn(*mut AnyObject, Sel) -> *mut AnyObject,
                );
                builder.register()
            });
            let info: *mut AnyObject = msg_send![info_class, new];
            let view: *mut AnyObject = webview.inner().cast();
            let handled: objc2::runtime::Bool = msg_send![view, performDragOperation: info];
            eprintln!("TEST_DROP_HANDLED: {}", handled.as_bool());
        });
    }

    /// Writes a PNG of the page (WKWebView snapshot; needs no screen-recording permission).
    #[cfg(target_os = "macos")]
    fn snapshot(window: &WebviewWindow, path: PathBuf, done: impl FnOnce() + Send + 'static) {
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};
        use std::cell::RefCell;

        let _ = window.with_webview(move |webview| unsafe {
            let state = RefCell::new(Some((path, done)));
            let handler = block2::RcBlock::new(move |image: *mut AnyObject, _error: *mut AnyObject| {
                let Some((path, done)) = state.borrow_mut().take() else { return };
                if !image.is_null() {
                    let tiff: *mut AnyObject = msg_send![image, TIFFRepresentation];
                    let rep: *mut AnyObject = msg_send![class!(NSBitmapImageRep), imageRepWithData: tiff];
                    let properties: *mut AnyObject = msg_send![class!(NSDictionary), dictionary];
                    // NSBitmapImageFileTypePNG = 4
                    let png: *mut AnyObject = msg_send![rep, representationUsingType: 4usize, properties: properties];
                    let length: usize = msg_send![png, length];
                    let bytes: *const u8 = msg_send![png, bytes];
                    let _ = std::fs::write(&path, std::slice::from_raw_parts(bytes, length));
                }
                done();
            });
            let webview: *mut AnyObject = webview.inner().cast();
            let _: () = msg_send![webview, takeSnapshotWithConfiguration: std::ptr::null_mut::<AnyObject>(), completionHandler: &*handler];
        });
    }
}

/// Opens documents and folders dropped onto a window from Finder.
fn open_dropped(app: &AppHandle, label: Option<String>, paths: Vec<PathBuf>) {
    let mut paths = paths.into_iter();
    if let (Some(label), Some(first)) = (label, paths.next()) {
        let is_dir = first.is_dir();
        let _ = app.emit_to(label.as_str(), "open-path", json!({ "path": first, "isDir": is_dir }));
    }
    for path in paths {
        open_path(app, path);
    }
}

/// Tauri's own drop handler swallows every drag (breaking in-page dragging of blocks and
/// images), so it stays off. Instead, the webview's performDragOperation: is wrapped: drops
/// of documents or folders open them, anything else goes to WebKit as before.
#[cfg(target_os = "macos")]
mod mac_drop {
    use super::*;
    use objc2::runtime::{AnyObject, Bool, Imp, Sel};
    use objc2::{class, msg_send, sel};
    use std::ffi::{c_char, CStr};
    use std::sync::OnceLock;

    static APP: OnceLock<AppHandle> = OnceLock::new();
    static ORIGINAL: OnceLock<Imp> = OnceLock::new();

    type PerformDrag = unsafe extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> Bool;

    pub unsafe fn filenames_type() -> *mut AnyObject {
        msg_send![class!(NSString), stringWithUTF8String: c"NSFilenamesPboardType".as_ptr()]
    }

    unsafe fn dropped_paths(info: *mut AnyObject) -> Vec<PathBuf> {
        let pasteboard: *mut AnyObject = msg_send![info, draggingPasteboard];
        if pasteboard.is_null() {
            return Vec::new();
        }
        let list: *mut AnyObject = msg_send![pasteboard, propertyListForType: filenames_type()];
        if list.is_null() {
            return Vec::new();
        }
        let is_array: Bool = msg_send![list, isKindOfClass: class!(NSArray)];
        if !is_array.as_bool() {
            return Vec::new();
        }
        let count: usize = msg_send![list, count];
        (0..count)
            .filter_map(|i| {
                let item: *mut AnyObject = msg_send![list, objectAtIndex: i];
                let text: *const c_char = msg_send![item, UTF8String];
                (!text.is_null()).then(|| PathBuf::from(CStr::from_ptr(text).to_string_lossy().into_owned()))
            })
            .collect()
    }

    extern "C-unwind" fn perform_drag(this: &AnyObject, cmd: Sel, info: *mut AnyObject) -> Bool {
        let openable: Vec<PathBuf> = unsafe { dropped_paths(info) }
            .into_iter()
            .filter(|p| p.is_dir() || files::is_document(p))
            .collect();
        if let (false, Some(app)) = (openable.is_empty(), APP.get()) {
            let ns_window: *mut AnyObject = unsafe { msg_send![this, window] };
            let label = app
                .webview_windows()
                .into_iter()
                .find(|(_, w)| w.ns_window().is_ok_and(|p| p.cast::<AnyObject>() == ns_window))
                .map(|(label, _)| label);
            open_dropped(app, label, openable);
            return Bool::YES;
        }
        match ORIGINAL.get() {
            Some(original) => unsafe { std::mem::transmute::<Imp, PerformDrag>(*original)(this, cmd, info) },
            None => Bool::NO,
        }
    }

    /// Call once a window exists, so the webview class is known.
    pub fn install(app: &AppHandle, window: &WebviewWindow) {
        if APP.set(app.clone()).is_err() {
            return;
        }
        let _ = window.with_webview(|webview| unsafe {
            let view: *mut AnyObject = webview.inner().cast();
            let Some(method) = (*view).class().instance_method(sel!(performDragOperation:)) else { return };
            let ours: Imp = std::mem::transmute(
                perform_drag as extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> Bool,
            );
            let _ = ORIGINAL.set(method.set_implementation(ours));
        });
    }
}

/// tao does not implement applicationShouldTerminate:, so Dock "Quit", logging out or an
/// AppleScript quit would end the app without letting pages save. Route those through quit().
#[cfg(target_os = "macos")]
mod mac_quit {
    use super::*;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{class, msg_send, sel};
    use std::sync::OnceLock;

    static APP: OnceLock<AppHandle> = OnceLock::new();

    extern "C-unwind" fn should_terminate(_: &AnyObject, _: Sel, _: *mut AnyObject) -> usize {
        if let Some(app) = APP.get() {
            quit(app);
        }
        0 // NSTerminateCancel; quit() exits once every window has closed.
    }

    pub fn install(app: &AppHandle) {
        let _ = APP.set(app.clone());
        unsafe {
            let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let delegate: *mut AnyObject = msg_send![ns_app, delegate];
            if delegate.is_null() {
                return;
            }
            let cls = (*delegate).class() as *const AnyClass as *mut AnyClass;
            let imp: Imp = std::mem::transmute(
                should_terminate as extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> usize,
            );
            objc2::ffi::class_addMethod(cls, sel!(applicationShouldTerminate:), imp, c"Q@:@".as_ptr());
        }
    }
}

fn on_window_event(window: &Window, event: &WindowEvent) {
    let app = window.app_handle();
    let label = window.label();
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            if with_win(app, label, |w| w.close_guard).unwrap_or(false) {
                api.prevent_close();
                let quitting = app_state(app).quitting.load(Ordering::Relaxed);
                let _ = app.emit_to(label, "close-requested", json!({ "quitting": quitting }));
            }
        }
        WindowEvent::Destroyed => {
            app_state(app).windows.lock().unwrap().remove(label);
        }
        _ => {}
    }
}

fn main() {
    let builder = tauri::Builder::default();
    // A second launch (e.g. double-clicking another .md on Windows) hands its paths to this instance.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
        let paths = path_args(argv.into_iter().skip(1), Path::new(&cwd));
        if paths.is_empty() {
            create_window(app, Startup::Empty);
        }
        for path in paths {
            open_path(app, path);
        }
    }));

    // Windows and Linux use the page's own menu ("···", ⌘K) and shortcuts instead of a menu bar.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(build_menu).on_menu_event(|app, event| handle_menu(app, event.id().as_ref()));

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(update::UpdateState::default())
        .setup(|app| {
            // Drafts and recent paths are private: never fall back to a shared temp folder.
            let data_dir = app
                .path()
                .app_data_dir()
                .or_else(|_| app.path().home_dir().map(|home| home.join(".mdpad")))
                .map_err(|_| "找不到可以保存设置和草稿的位置")?;
            // Tests point debug builds at a scratch folder so they never touch real settings or drafts.
            #[cfg(debug_assertions)]
            let data_dir = std::env::var_os("MDPAD_DATA_DIR").map(PathBuf::from).unwrap_or(data_dir);
            app.manage(AppState {
                windows: Mutex::new(HashMap::new()),
                next_id: AtomicU32::new(0),
                quitting: AtomicBool::new(false),
                store: Mutex::new(Store::load(data_dir.join("state.json"))),
                fs_events: watch::start_debouncer(app.handle().clone()),
                drafts_dir: data_dir.join("drafts"),
            });
            // A downloaded installer lives in a temp file; one left by a session that ended without
            // installing it is dead weight from the previous version.
            update::clean_staging(app.handle());
            Ok(())
        })
        .on_window_event(on_window_event)
        .invoke_handler(tauri::generate_handler![
            window_init,
            native_action,
            set_close_guard,
            close_window,
            cancel_quit,
            set_title,
            confirm_close_draft,
            confirm,
            pick_documents,
            pick_folder,
            pick_image,
            open_in_new_window,
            new_window,
            open_url,
            reveal,
            print_page,
            export_html,
            export_docx,
            remember_position,
            set_setting,
            ai::ai_available,
            ai::ai_label,
            ai::ai_status,
            ai::ai_configure,
            ai::ai_complete,
            ai::ai_rewrite,
            ai::ai_test,
            voice::voice_status,
            voice::voice_configure,
            voice::voice_start,
            voice::voice_stop,
            voice::voice_cancel,
            voice::voice_test,
            test_report,
            files::read_document,
            files::write_document,
            files::check_document,
            files::save_as,
            files::save_image,
            files::import_image,
            files::allow_image,
            files::image_data_url,
            files::list_dir,
            files::list_documents,
            files::set_root,
            files::create_document,
            files::rename_path,
            pinned::list_pinned,
            pinned::pin_file,
            pinned::unpin_file,
            pinned::relink_pinned,
            files::draft_write,
            files::draft_delete,
            fetch::open_from_url,
            update::check_update,
            update::update_status,
            update::download_update,
            update::restart_to_update,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build MDPad")
        .run(|app, event| match event {
            RunEvent::Ready => {
                #[cfg(target_os = "macos")]
                mac_quit::install(app);
                for (id, content) in files::saved_drafts(app) {
                    create_window(app, Startup::Draft { id, content });
                }
                let cwd = std::env::current_dir().unwrap_or_default();
                for path in path_args(std::env::args().skip(1), &cwd) {
                    open_path(app, path);
                }
                if app_state(app).windows.lock().unwrap().is_empty() {
                    create_window(app, Startup::Empty);
                }
                #[cfg(target_os = "macos")]
                if let Some(window) = app.webview_windows().into_values().next() {
                    mac_drop::install(app, &window);
                }
            }
            #[cfg(target_os = "macos")]
            RunEvent::Opened { urls } => {
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        open_path(app, path);
                    }
                }
            }
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { has_visible_windows: false, .. } => {
                if app.webview_windows().is_empty() {
                    create_window(app, Startup::Empty);
                }
            }
            RunEvent::ExitRequested { code: None, api, .. } => {
                if update::install_pending(app) {
                    // Every window has saved and closed: install, then relaunch.
                    update::install_and_restart(app);
                    // Installing failed; keep the app running.
                    api.prevent_exit();
                    app_state(app).quitting.store(false, Ordering::Relaxed);
                    create_window(app, Startup::Empty);
                    return;
                }
                // macOS document apps keep running after the last window closes.
                if cfg!(target_os = "macos") && !app_state(app).quitting.load(Ordering::Relaxed) {
                    api.prevent_exit();
                }
            }
            _ => {}
        });
}
