//! 语音输入：录音在 Rust 侧完成，再把 WAV 交给 OpenAI 兼容的 `/audio/transcriptions`。
//!
//! 为什么不在页面里录：macOS 的 WKWebView 必须先经 WKUIDelegate 的
//! `requestMediaCapturePermissionFor` 授权，才允许 `getUserMedia`；而 wry（Tauri 的 webview 层）
//! 没有实现这个回调，页面里拿到的永远是拒绝。放在 Rust 里用 cpal 录，三个平台走各自系统的
//! 音频 API（CoreAudio / WASAPI / ALSA），行为一致，也不必让页面碰麦克风。
//!
//! 转写走 OpenAI 兼容的接口：硅基流动、OpenAI、智谱都是这个形状。语音的 Key 与聊天分开存 ——
//! 常见情况是聊天用一家、语音用另一家（比如聊天用 DeepSeek，而它根本没有音频接口）。
//! 语音 Key 没填时回落到 AI 的 Key，这样两家恰好是同一家时只填一次。

use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::ai::client;
use crate::state::app_state;
use crate::store::Store;

const DEFAULT_BASE: &str = "https://api.siliconflow.cn/v1";
const DEFAULT_MODEL: &str = "FunAudioLLM/SenseVoiceSmall";

/// 转写模型要 16 kHz；设备通常给 44.1/48 kHz，录完再降采样。
const TARGET_RATE: u32 = 16_000;
/// 一次录音的上限。到这个点自动停，防止忘了点而把整段内存占满。
const MAX_SECONDS: u64 = 120;
/// 麦克风初始化最多等这么久：macOS 首次会弹权限对话框，用户可能要看一眼。
const READY_TIMEOUT: u64 = 20;
const UPLOAD_TIMEOUT: u64 = 60;
/// 低于这个时长基本是误触。
const MIN_SECONDS: f32 = 0.4;
/// 峰值低于这个值就当成"没收到声音"，多半是权限没给。
const SILENCE: f32 = 0.001;

const KEY_BASE: &str = "voice.baseUrl";
const KEY_MODEL: &str = "voice.model";
const KEY_SECRET: &str = "voice.apiKey";
/// 语音 Key 没配时借用的 AI Key。
const AI_SECRET: &str = "ai.apiKey";

// ---------------------------------------------------------------- 录音会话

struct Session {
    stop: mpsc::Sender<()>,
    samples: Arc<Mutex<Vec<f32>>>,
    rate: u32,
    join: Option<std::thread::JoinHandle<()>>,
}

/// 同一时刻只允许一段录音：麦克风是独占资源，两个窗口同时录没有意义。
fn session() -> &'static Mutex<Option<Session>> {
    static SESSION: OnceLock<Mutex<Option<Session>>> = OnceLock::new();
    SESSION.get_or_init(|| Mutex::new(None))
}

/// 把交错的多声道采样压成单声道，并转成 f32。
fn mix<I: Iterator<Item = f32>>(values: I, channels: usize, sink: &Arc<Mutex<Vec<f32>>>) {
    let channels = channels.max(1);
    let mut buffer = sink.lock().unwrap();
    let mut sum = 0.0;
    let mut count = 0usize;
    for value in values {
        sum += value;
        count += 1;
        if count == channels {
            buffer.push(sum / channels as f32);
            sum = 0.0;
            count = 0;
        }
    }
}

/// 在后台线程里开设备、录到收到停止信号为止。`Stream` 不是 Send，所以它必须留在这个线程里。
fn spawn() -> Result<Session, String> {
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(u32, usize), String>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
    let sink = Arc::clone(&samples);

    let join = std::thread::spawn(move || {
        let host = cpal::default_host();
        let Some(device) = host.default_input_device() else {
            let _ = ready_tx.send(Err("没有找到麦克风，检查系统设置里的输入设备".into()));
            return;
        };
        let supported = match device.default_input_config() {
            Ok(config) => config,
            Err(error) => {
                let _ = ready_tx.send(Err(format!("麦克风打不开：{error}")));
                return;
            }
        };
        let rate = supported.sample_rate().0;
        let channels = supported.channels() as usize;
        let format = supported.sample_format();
        let config: cpal::StreamConfig = supported.into();

        // 每种采样格式一个回调，统一压成单声道 f32。Sink 需要各自 clone。
        let built = match format {
            cpal::SampleFormat::F32 => {
                let sink = Arc::clone(&sink);
                device.build_input_stream(
                    &config,
                    move |data: &[f32], _: &cpal::InputCallbackInfo| mix(data.iter().copied(), channels, &sink),
                    |error| eprintln!("录音出错: {error}"),
                    None,
                )
            }
            cpal::SampleFormat::I16 => {
                let sink = Arc::clone(&sink);
                device.build_input_stream(
                    &config,
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        mix(data.iter().map(|s| *s as f32 / 32768.0), channels, &sink)
                    },
                    |error| eprintln!("录音出错: {error}"),
                    None,
                )
            }
            cpal::SampleFormat::U16 => {
                let sink = Arc::clone(&sink);
                device.build_input_stream(
                    &config,
                    move |data: &[u16], _: &cpal::InputCallbackInfo| {
                        mix(data.iter().map(|s| (*s as f32 - 32768.0) / 32768.0), channels, &sink)
                    },
                    |error| eprintln!("录音出错: {error}"),
                    None,
                )
            }
            other => {
                let _ = ready_tx.send(Err(format!("麦克风输出格式不支持：{other:?}")));
                return;
            }
        };

        let stream = match built {
            Ok(stream) => stream,
            Err(error) => {
                let _ = ready_tx.send(Err(format!("打不开麦克风：{error}")));
                return;
            }
        };
        if let Err(error) = stream.play() {
            let _ = ready_tx.send(Err(format!("麦克风没有开始采集：{error}")));
            return;
        }
        let _ = ready_tx.send(Ok((rate, channels)));
        // 要么用户点停止，要么到上限自动收尾。
        let _ = stop_rx.recv_timeout(Duration::from_secs(MAX_SECONDS));
        drop(stream);
    });

    match ready_rx.recv_timeout(Duration::from_secs(READY_TIMEOUT)) {
        Ok(Ok((rate, _channels))) => Ok(Session { stop: stop_tx, samples, rate, join: Some(join) }),
        Ok(Err(message)) => {
            let _ = join.join();
            Err(message)
        }
        Err(_) => Err("麦克风没有响应：检查系统设置里的麦克风权限".into()),
    }
}

/// 线性插值降采样。语音识别对这点误差不敏感，换来的是不引入重采样依赖。
fn resample(samples: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || samples.is_empty() || from == 0 {
        return samples.to_vec();
    }
    let step = from as f64 / to as f64;
    let out_len = (samples.len() as f64 / step).floor() as usize;
    let last = samples.len() - 1;
    (0..out_len)
        .map(|index| {
            let position = index as f64 * step;
            let at = position as usize;
            let fraction = position - at as f64;
            let a = samples[at.min(last)] as f64;
            let b = samples[(at + 1).min(last)] as f64;
            (a + (b - a) * fraction) as f32
        })
        .collect()
}

/// 16-bit 单声道 PCM 的 WAV 容器。头是 44 字节，其余是 little-endian 采样。
fn wav(samples: &[f32], rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // 单声道
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes()); // 每秒字节数
    out.extend_from_slice(&2u16.to_le_bytes()); // 每个采样的字节数
    out.extend_from_slice(&16u16.to_le_bytes()); // 位深
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        let value = (sample.clamp(-1.0, 1.0) * 32767.0) as i16;
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

// ---------------------------------------------------------------- 设置

fn setting(app: &AppHandle, key: &str) -> Option<String> {
    let state = app_state(app);
    let store = state.store.lock().unwrap();
    store
        .settings
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn put(store: &mut Store, key: &str, value: Option<String>) {
    let value = value.unwrap_or_default().trim().to_string();
    if value.is_empty() {
        store.settings.remove(key);
    } else {
        store.settings.insert(key.to_string(), json!(value));
    }
}

/// 语音用的 Key：自己的优先，没有就借 AI 的。
fn secret(app: &AppHandle) -> Option<String> {
    setting(app, KEY_SECRET).or_else(|| setting(app, AI_SECRET))
}

fn status(app: &AppHandle) -> Value {
    json!({
        "baseUrl": setting(app, KEY_BASE).unwrap_or_else(|| DEFAULT_BASE.into()),
        "model": setting(app, KEY_MODEL).unwrap_or_else(|| DEFAULT_MODEL.into()),
        "hasKey": setting(app, KEY_SECRET).is_some(),
        "ready": secret(app).is_some(),
        "defaultBase": DEFAULT_BASE,
        "defaultModel": DEFAULT_MODEL,
    })
}

#[tauri::command]
pub fn voice_status(app: AppHandle) -> Value {
    status(&app)
}

/// `api_key`: `None` 表示不动，`Some("")` 表示删掉。
#[tauri::command]
pub fn voice_configure(app: AppHandle, base_url: Option<String>, model: Option<String>, api_key: Option<String>) -> Value {
    {
        let state = app_state(&app);
        let mut store = state.store.lock().unwrap();
        put(&mut store, KEY_BASE, base_url);
        put(&mut store, KEY_MODEL, model);
        put(&mut store, KEY_SECRET, api_key);
        store.save();
    }
    status(&app)
}

// ---------------------------------------------------------------- 命令

#[tauri::command]
pub fn voice_start() -> Result<Value, String> {
    if session().lock().unwrap().is_some() {
        return Err("已经在录音了".into());
    }
    let started = spawn()?;
    *session().lock().unwrap() = Some(started);
    Ok(json!({ "ok": true }))
}

fn take_session() -> Option<Session> {
    session().lock().unwrap().take()
}

fn finish(mut session: Session) {
    let _ = session.stop.send(());
    if let Some(join) = session.join.take() {
        let _ = join.join();
    }
}

#[tauri::command]
pub async fn voice_stop(app: AppHandle) -> Result<String, String> {
    let Some(session) = take_session() else {
        return Err("没有正在进行的录音".into());
    };
    let rate = session.rate;
    let samples = Arc::clone(&session.samples);
    finish(session);

    let captured = { samples.lock().unwrap().clone() };
    if captured.len() < (rate as f32 * MIN_SECONDS) as usize {
        return Err("说话时间太短，点一下开始，说完再点一下".into());
    }
    if captured.iter().fold(0f32, |peak, sample| peak.max(sample.abs())) < SILENCE {
        return Err("没有收到声音：检查系统设置里是否允许 MDPad 使用麦克风".into());
    }
    let mono = resample(&captured, rate, TARGET_RATE);
    transcribe(&app, wav(&mono, TARGET_RATE)).await
}

#[tauri::command]
pub fn voice_cancel() -> Result<(), String> {
    if let Some(session) = take_session() {
        finish(session);
    }
    Ok(())
}

// ---------------------------------------------------------------- 上传

fn failure(status: u16) -> String {
    match status {
        400 => "语音服务不接受这个请求，检查模型名（例如 FunAudioLLM/SenseVoiceSmall）".into(),
        401 | 403 => "语音识别的 Key 无效，或者没有调用这个模型的权限".into(),
        402 => "账户余额不足".into(),
        404 => "地址不对：服务端没有 /audio/transcriptions（HTTP 404）".into(),
        413 => "这段录音太长了".into(),
        429 => "请求太频繁，稍后再试".into(),
        500..=599 => format!("语音服务暂时不可用（HTTP {status}）"),
        _ => format!("语音服务返回了 HTTP {status}"),
    }
}

fn transport(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "语音服务没有在预期时间内返回".to_string()
    } else if error.is_connect() {
        "连不上语音服务，检查网络或地址".to_string()
    } else {
        format!("请求语音服务失败：{error}")
    }
}

async fn transcribe(app: &AppHandle, audio: Vec<u8>) -> Result<String, String> {
    let base = setting(app, KEY_BASE).unwrap_or_else(|| DEFAULT_BASE.into());
    let model = setting(app, KEY_MODEL).unwrap_or_else(|| DEFAULT_MODEL.into());
    let key = secret(app).ok_or_else(|| "还没有配置语音识别：先在设置里填一个 Key".to_string())?;

    let url = format!("{}/audio/transcriptions", base.trim_end_matches('/'));
    let part = reqwest::multipart::Part::bytes(audio)
        .file_name("speech.wav")
        .mime_str("audio/wav")
        .map_err(|error| format!("录音数据有问题：{error}"))?;
    let form = reqwest::multipart::Form::new().text("model", model).part("file", part);

    let response = client()
        .post(&url)
        .timeout(Duration::from_secs(UPLOAD_TIMEOUT))
        .bearer_auth(key)
        .multipart(form)
        .send()
        .await
        .map_err(|error| transport(&error))?;
    let code = response.status().as_u16();
    let body: Value = response
        .json()
        .await
        .map_err(|_| if code == 200 { "语音服务返回的内容无法识别".to_string() } else { failure(code) })?;
    if !(200..300).contains(&code) {
        // OpenAI 把原因放在 error.message；硅基流动放在顶层 message。
        let detail = body
            .pointer("/error/message")
            .or_else(|| body.get("message"))
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty());
        return Err(match detail {
            Some(detail) if detail.chars().count() <= 160 => format!("{}：{detail}", failure(code)),
            _ => failure(code),
        });
    }
    let text = body
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    if text.is_empty() {
        return Err("没有听出内容，再试一次".into());
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_header_matches_the_samples() {
        let bytes = wav(&[0.0, 0.5, -0.5], 16_000);
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        assert_eq!(u32::from_le_bytes(bytes[24..28].try_into().unwrap()), 16_000);
        assert_eq!(u16::from_le_bytes(bytes[22..24].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(bytes[40..44].try_into().unwrap()), 6);
        assert_eq!(bytes.len(), 44 + 6);
    }

    #[test]
    fn resample_keeps_the_duration() {
        let input = vec![0.1f32; 48_000];
        let out = resample(&input, 48_000, 16_000);
        assert!((out.len() as i64 - 16_000).abs() <= 1);
    }

    #[test]
    fn resample_of_matching_rate_is_a_copy() {
        let input = vec![0.25f32; 10];
        assert_eq!(resample(&input, 16_000, 16_000), input);
    }

    /// 真机验证：`cargo test record_from_the_default_input -- --ignored --nocapture`
    /// CI 上没有麦克风，所以默认不跑。第一次跑 macOS 会弹权限对话框。
    #[test]
    #[ignore = "需要麦克风和系统权限，只在手工验证时跑"]
    fn record_from_the_default_input() {
        let started = spawn().expect("打不开麦克风");
        let rate = started.rate;
        std::thread::sleep(Duration::from_millis(1_500));
        let samples = Arc::clone(&started.samples);
        finish(started);
        let captured = samples.lock().unwrap();
        let peak = captured.iter().fold(0f32, |peak, sample| peak.max(sample.abs()));
        println!("录到 {} 个采样 · {} Hz · 峰值 {peak:.4}", captured.len(), rate);
        // 顺手把降采样后的成品写出来，好用 ffprobe 确认能当普通 WAV 读。
        let mono = resample(&captured, rate, TARGET_RATE);
        let bytes = wav(&mono, TARGET_RATE);
        let _ = std::fs::write("/tmp/mdpad-voice-test.wav", &bytes);
        println!("WAV {} 字节 · {} 个采样 @ {TARGET_RATE} Hz", bytes.len(), mono.len());
        assert!(captured.len() > rate as usize / 2, "一秒半只拿到 {} 个采样", captured.len());
    }
}
