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

/// How long a *successful* check silences the next automatic one. Six hours instead of a day:
/// a machine that stays open across a release should hear about it the same day, and the check
/// itself is one small JSON request.
const AUTO_CHECK_INTERVAL_MS: u64 = 6 * 60 * 60 * 1000;
/// After a failed check, wait this long before trying again. Without it a window that regains
/// focus while offline would hammer the endpoint on every switch back.
const FAILED_RETRY_MS: u64 = 10 * 60 * 1000;

// The times live in the settings map so they survive restarts. Only a check that came back with
// an answer stamps `LAST_OK` — a failure must never buy itself a quiet spell.
const KEY_LAST_OK: &str = "lastUpdateCheck";
const KEY_LAST_FAIL: &str = "lastUpdateFailedAt";
const KEY_LAST_ERROR: &str = "lastUpdateError";

#[derive(Default)]
pub struct UpdateState {
    available: Mutex<Option<Update>>,
    downloaded: Mutex<Option<(Update, Vec<u8>)>>,
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
/// 设置 › 关于 can say what went wrong. It is rate limited — six hours after a check that got an
/// answer, ten minutes after one that did not. The manual path (`automatic: false`) always runs
/// and returns the error to the caller, who shows it.
#[tauri::command]
pub async fn check_update(app: AppHandle, automatic: bool) -> Result<Option<UpdateInfo>, String> {
    if automatic {
        if ENDPOINT.is_none() {
            return Ok(None);
        }
        let now = now_ms();
        if now.saturating_sub(stored_ms(&app, KEY_LAST_OK)) < AUTO_CHECK_INTERVAL_MS
            || now.saturating_sub(stored_ms(&app, KEY_LAST_FAIL)) < FAILED_RETRY_MS
        {
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
            *state.downloaded.lock().unwrap() = Some((update, bytes));
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

/// Installs the downloaded update and relaunches. Returns only if installing failed.
pub fn install_and_restart(app: &AppHandle) {
    let state = app.state::<UpdateState>();
    state.install_on_exit.store(false, Ordering::Relaxed);
    let Some((update, bytes)) = state.downloaded.lock().unwrap().take() else { return };
    match update.install(bytes) {
        Ok(()) => app.restart(),
        Err(err) => eprintln!("failed to install update: {err}"),
    }
}
