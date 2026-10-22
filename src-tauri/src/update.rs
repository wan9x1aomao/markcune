//! In-app updates. The update URL is baked in at build time (MDPAD_UPDATE_ENDPOINT, set by
//! scripts/release.sh); builds without it simply report that updates are not configured.
//! Updates are signed; tauri.conf.json carries the public key.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::state::app_state;

const ENDPOINT: Option<&str> = option_env!("MDPAD_UPDATE_ENDPOINT");

/// How long a *successful* check silences the next automatic one. Half an hour: the check is one
/// small JSON request, and a release should surface while the person is still working. It used to
/// be six hours, which meant an app opened in the morning heard about an afternoon release only
/// after lunch — or, if it was closed before then, never.
const AUTO_CHECK_INTERVAL_MS: u64 = 30 * 60 * 1000;
/// After a failed check, wait this long before trying again. Without it a window that regains
/// focus while offline would hammer the endpoint on every switch back.
const FAILED_RETRY_MS: u64 = 10 * 60 * 1000;

/// Whether an automatic check may run now. Split out from the command so the rule is testable
/// without a window — and so a future change cannot quietly make reminders disappear again.
fn auto_check_due(now: u64, last_ok: u64, last_fail: u64) -> bool {
    now.saturating_sub(last_ok) >= AUTO_CHECK_INTERVAL_MS && now.saturating_sub(last_fail) >= FAILED_RETRY_MS
}

// The times live in the settings map so they survive restarts. Only a check that came back with
// an answer stamps `LAST_OK` — a failure must never buy itself a quiet spell.
const KEY_LAST_OK: &str = "lastUpdateCheck";
const KEY_LAST_FAIL: &str = "lastUpdateFailedAt";
const KEY_LAST_ERROR: &str = "lastUpdateError";

/// Where a verified installer waits between "downloaded" and "restart to install".
///
/// It used to stay in memory: a 6 MB (macOS / Windows) or 80 MB (Linux AppImage) `Vec<u8>` held for
/// the rest of the session, because people postpone the restart. Now it goes to a temp file next to
/// the drafts and is read back once, at install time.
enum Staged {
    File(std::path::PathBuf),
    Memory(Vec<u8>),
}

#[derive(Default)]
pub struct UpdateState {
    available: Mutex<Option<Update>>,
    downloaded: Mutex<Option<(Update, Staged)>>,
    install_on_exit: AtomicBool,
    /// One check in flight at a time: launch, window focus and the manual entry all land here.
    checking: AtomicBool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
}

/// What 设置 › 关于 shows: the answer to "is this thing even checking?".
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    current_version: String,
    /// Milliseconds since the epoch, or `None` when no check has ever succeeded.
    last_checked: Option<u64>,
    /// Why the last automatic check failed, if it did. Cleared by the next successful one.
    last_error: Option<String>,
    available_version: Option<String>,
}

/// Logs the underlying error (for diagnosis) and returns the Chinese message for the page.
fn fail<E: std::fmt::Display>(message: &'static str) -> impl FnOnce(E) -> String {
    move |err| {
        eprintln!("update: {message}: {err}");
        message.to_string()
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

fn stored_ms(app: &AppHandle, key: &str) -> u64 {
    let state = app_state(app);
    let store = state.store.lock().unwrap();
    store.settings.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn stored_text(app: &AppHandle, key: &str) -> Option<String> {
    let state = app_state(app);
    let store = state.store.lock().unwrap();
    store.settings.get(key).and_then(Value::as_str).map(str::to_string)
}

fn remember(app: &AppHandle, entries: &[(&str, Value)]) {
    let state = app_state(app);
    let mut store = state.store.lock().unwrap();
    for (key, value) in entries {
        store.settings.insert((*key).to_string(), value.clone());
    }
    store.save();
}

/// Builds the updater and asks the endpoint. Nothing here touches the settings, so the caller can
/// decide what a failure means.
async fn fetch(app: &AppHandle) -> Result<Option<Update>, String> {
    let endpoint = ENDPOINT.ok_or_else(|| "当前版本暂不支持在线更新".to_string())?;
    let url = endpoint.parse().map_err(fail("更新地址无效"))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .and_then(|builder| builder.build())
        .map_err(fail("无法检查更新"))?;
    updater.check().await.map_err(fail("暂时无法获取更新信息，请稍后再试"))
}

/// Looks for a newer version.
///
/// `automatic` is the quiet path: nothing is shown on failure, but the reason is remembered so
/// 设置 › 关于 can say what went wrong. It is rate limited — half an hour after a check that got
/// an answer, ten minutes after one that did not. The manual path (`automatic: false`) always runs
/// and returns the error to the caller, who shows it.
#[tauri::command]
pub async fn check_update(app: AppHandle, automatic: bool) -> Result<Option<UpdateInfo>, String> {
    if automatic {
        if ENDPOINT.is_none() {
            return Ok(None);
        }
        let now = now_ms();
        if !auto_check_due(now, stored_ms(&app, KEY_LAST_OK), stored_ms(&app, KEY_LAST_FAIL)) {
            return Ok(None);
        }
    }
    if app.state::<UpdateState>().checking.swap(true, Ordering::Relaxed) {
        return Ok(None);
    }

    let outcome = fetch(&app).await;
    app.state::<UpdateState>().checking.store(false, Ordering::Relaxed);

    let update = match outcome {
        Ok(update) => update,
        Err(message) => {
            if !automatic {
                return Err(message);
            }
            // Keep the reason around and wait a little before asking again.
            remember(
                &app,
                &[(KEY_LAST_FAIL, json!(now_ms())), (KEY_LAST_ERROR, json!(message))],
            );
            eprintln!("update: 自动检查失败：{message}");
            return Ok(None);
        }
    };

    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone(),
    });
    *app.state::<UpdateState>().available.lock().unwrap() = update;
    if automatic {
        remember(
            &app,
            &[
                (KEY_LAST_OK, json!(now_ms())),
                (KEY_LAST_FAIL, json!(0)),
                (KEY_LAST_ERROR, json!("")),
            ],
        );
    }
    Ok(info)
}

/// The last check's outcome, for 设置 › 关于.
#[tauri::command]
pub fn update_status(app: AppHandle) -> UpdateStatus {
    let last_checked = match stored_ms(&app, KEY_LAST_OK) {
        0 => None,
        ms => Some(ms),
    };
    let available_version = app
        .state::<UpdateState>()
        .available
        .lock()
        .unwrap()
        .as_ref()
        .map(|update| update.version.clone());
    UpdateStatus {
        current_version: app.package_info().version.to_string(),
        last_checked,
        last_error: stored_text(&app, KEY_LAST_ERROR).filter(|text| !text.is_empty()),
        available_version,
    }
}

/// Downloads and verifies the update found by `check_update`, reporting progress to the window.
#[tauri::command]
pub async fn download_update(window: WebviewWindow) -> Result<String, String> {
    let app = window.app_handle().clone();
    let state = app.state::<UpdateState>();
    let update = state.available.lock().unwrap().take().ok_or("没有可用的更新")?;
    let label = window.label().to_string();
    let mut downloaded = 0u64;
    let mut reported = u64::MAX;
    let result = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                // Report each whole percent (or each 256 KB when the size is unknown).
                let step = total.map(|t| downloaded * 100 / t.max(1)).unwrap_or(downloaded >> 18);
                if step != reported {
                    reported = step;
                    let _ = app.emit_to(label.as_str(), "update-progress", json!({ "downloaded": downloaded, "total": total }));
                }
            },
            || {},
        )
        .await;
    match result {
        Ok(bytes) => {
            let version = update.version.clone();
            let path = staging_path(&app, &version);
            // Keep the verified installer off the heap: it can be up to ~80 MB (Linux AppImage) and
            // someone who postpones the restart would otherwise carry it for the whole session.
            let staged = match std::fs::write(&path, &bytes) {
                Ok(()) => Staged::File(path),
                Err(err) => {
                    eprintln!("update: 无法暂存更新包，保留在内存里：{err}");
                    Staged::Memory(bytes)
                }
            };
            *state.downloaded.lock().unwrap() = Some((update, staged));
            Ok(version)
        }
        Err(err) => {
            *state.available.lock().unwrap() = Some(update);
            let tampered = matches!(err, tauri_plugin_updater::Error::Minisign(_) | tauri_plugin_updater::Error::SignatureUtf8(_));
            let message = if tampered { "更新包校验失败，已取消更新" } else { "下载更新失败，请检查网络连接后重试" };
            Err(fail(message)(err))
        }
    }
}

/// Closes every window the usual way (saving first); the update is installed on exit.
#[tauri::command]
pub fn restart_to_update(app: AppHandle) {
    app.state::<UpdateState>().install_on_exit.store(true, Ordering::Relaxed);
    crate::quit(&app);
}

pub fn install_pending(app: &AppHandle) -> bool {
    app.state::<UpdateState>().install_on_exit.load(Ordering::Relaxed)
}

/// Path of the temp file a downloaded installer waits in. Next to the drafts folder, so it shares
/// the data directory's lifetime and never lands somewhere shared.
fn staging_path(app: &AppHandle, version: &str) -> std::path::PathBuf {
    app_state(app).drafts_dir.with_file_name(format!("update-{version}.bin"))
}

/// Whether a file in the data directory is one of our downloaded installers.
fn is_staged_update(name: &str) -> bool {
    name.starts_with("update-") && name.ends_with(".bin")
}

/// Removes installers from a session that ended without installing them.
pub fn clean_staging(app: &AppHandle) {
    let drafts = app_state(app).drafts_dir.clone();
    let dir = drafts.parent().map(std::path::Path::to_path_buf).unwrap_or(drafts);
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if is_staged_update(&entry.file_name().to_string_lossy()) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Installs the downloaded update and relaunches. Returns only if installing failed.
pub fn install_and_restart(app: &AppHandle) {
    let state = app.state::<UpdateState>();
    state.install_on_exit.store(false, Ordering::Relaxed);
    let Some((update, staged)) = state.downloaded.lock().unwrap().take() else { return };
    let bytes = match staged {
        Staged::File(path) => {
            let bytes = std::fs::read(&path).ok();
            let _ = std::fs::remove_file(&path);
            bytes
        }
        Staged::Memory(bytes) => Some(bytes),
    };
    let Some(bytes) = bytes else {
        eprintln!("update: 暂存的更新包不见了，已取消安装");
        return;
    };
    match update.install(bytes) {
        Ok(()) => app.restart(),
        Err(err) => eprintln!("failed to install update: {err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: u64 = 60 * 1000;
    const NOW: u64 = 1_000_000_000;

    /// The bug this guards: a check that answered in the morning used to silence the rest of the
    /// day, so an afternoon release was never announced while the app was open.
    #[test]
    fn a_check_that_answered_waits_half_an_hour() {
        assert!(!auto_check_due(NOW, NOW - 29 * MIN, 0));
        assert!(auto_check_due(NOW, NOW - 30 * MIN, 0));
    }

    #[test]
    fn never_checked_is_due() {
        assert!(auto_check_due(NOW, 0, 0));
    }

    /// A failure must not buy a long silence, but must stop focus switches from hammering it.
    #[test]
    fn a_failure_waits_ten_minutes() {
        assert!(!auto_check_due(NOW, 0, NOW - 9 * MIN));
        assert!(auto_check_due(NOW, 0, NOW - 10 * MIN));
    }

    /// Only our own staging files may be deleted on startup; the drafts folder shares the directory.
    #[test]
    fn only_staged_installers_are_cleaned_up() {
        assert!(is_staged_update("update-3.5.4.bin"));
        assert!(!is_staged_update("state.json"));
        assert!(!is_staged_update("1700000000000-0.md"));
        assert!(!is_staged_update("update-notes.txt"));
    }
}
