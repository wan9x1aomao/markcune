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
const AUTO_CHECK_INTERVAL_MS: u64 = 24 * 60 * 60 * 1000;

#[derive(Default)]
pub struct UpdateState {
    available: Mutex<Option<Update>>,
    downloaded: Mutex<Option<(Update, Vec<u8>)>>,
    install_on_exit: AtomicBool,
    checked_this_launch: AtomicBool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
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

/// Looks for a newer version. `automatic` checks run once per launch and at most daily.
#[tauri::command]
pub async fn check_update(app: AppHandle, automatic: bool) -> Result<Option<UpdateInfo>, String> {
    let state = app.state::<UpdateState>();
    if automatic {
        if ENDPOINT.is_none() || state.checked_this_launch.swap(true, Ordering::Relaxed) {
            return Ok(None);
        }
        let app_state = app_state(&app);
        let mut store = app_state.store.lock().unwrap();
        let last = store.settings.get("lastUpdateCheck").and_then(Value::as_u64).unwrap_or(0);
        if now_ms().saturating_sub(last) < AUTO_CHECK_INTERVAL_MS {
            return Ok(None);
        }
        store.settings.insert("lastUpdateCheck".into(), json!(now_ms()));
        store.save();
    }

    let endpoint = ENDPOINT.ok_or("当前版本暂不支持在线更新")?;
    let url = endpoint.parse().map_err(fail("更新地址无效"))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .and_then(|builder| builder.build())
        .map_err(fail("无法检查更新"))?;
    let update = updater.check().await.map_err(fail("暂时无法获取更新信息，请稍后再试"))?;
    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone(),
    });
    *state.available.lock().unwrap() = update;
    Ok(info)
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
