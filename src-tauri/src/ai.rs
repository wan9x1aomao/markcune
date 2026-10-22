//! AI helpers, behind one small contract.
//!
//! Two ways to reach a model, tried in this order:
//! 1. `ai.apiKey` in settings -> the provider at `ai.baseUrl`, OpenAI-compatible, called directly.
//!    The key is written here and never read back: the page only learns whether one is set.
//! 2. `MDPAD_TIDY_URL`        -> the team gateway, which owns the model, the key and the prompts.
//!
//! No key and no prompt ever reaches the page. The page sends text and gets text or labels back;
//! the prompt skeletons live in this file, so they cannot be swapped out by the renderer.
//!
//! Tidy follows the same order (`ai_available` / `ai_label`): a key the user configured classifies
//! the lines directly, and the gateway is the team-wide alternative. Without either, tidy is rules only.

use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::state::app_state;
use crate::store::Store;

const DEFAULT_BASE: &str = "https://api.deepseek.com/v1";
const DEFAULT_MODEL: &str = "deepseek-chat";

/// Kept small on purpose: a completion that reads more than this is guessing.
const MAX_BEFORE: usize = 2_000;
const MAX_AFTER: usize = 600;
const MAX_REWRITE: usize = 8_000;
const MAX_COMPLETION_CHARS: usize = 200;
const MAX_INSTRUCTION: usize = 400;

const TIMEOUT_COMPLETE: u64 = 8;
const TIMEOUT_REWRITE: u64 = 45;

const KEY_BASE: &str = "ai.baseUrl";
const KEY_MODEL: &str = "ai.model";
// 也在 `store::SECRET_SETTINGS` 里：window_init 回给页面之前会把它滤掉，别只改这一处。
const KEY_SECRET: &str = "ai.apiKey";
const KEY_COMPLETION: &str = "ai.completion";
const KEY_CUSTOM: &str = "ai.custom";

/// The user's own rewrites. A handful is plenty: more of them turns a menu into a list.
const MAX_CUSTOM: usize = 3;
const MAX_CUSTOM_LABEL: usize = 12;
const MAX_CUSTOM_INSTRUCTION: usize = 200;

// ---------------------------------------------------------------- settings

fn setting(app: &AppHandle, key: &str) -> Option<String> {
    let state = app_state(app);
    let store = state.store.lock().unwrap();
    store
        .settings
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn put(store: &mut Store, key: &str, value: Option<String>) {
    let Some(value) = value else { return };
    let value = value.trim().to_string();
    if value.is_empty() {
        store.settings.remove(key);
    } else {
        store.settings.insert(key.to_string(), json!(value));
    }
}

/// One rewrite the user wrote themselves: a short name and the sentence sent to the model.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct CustomSkill {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub instruction: String,
}

/// Keeps what is worth keeping: no empty instructions, at most `MAX_CUSTOM` of them, and lengths
/// that fit in the menu. A pasted paragraph is trimmed rather than rejected, so the user's typing
/// is never silently thrown away without a trace.
fn sanitize_custom(list: &[CustomSkill]) -> Vec<CustomSkill> {
    list.iter()
        .map(|skill| CustomSkill {
            label: clip(skill.label.trim(), MAX_CUSTOM_LABEL),
            instruction: clip(skill.instruction.trim(), MAX_CUSTOM_INSTRUCTION),
        })
        .filter(|skill| !skill.instruction.is_empty())
        .take(MAX_CUSTOM)
        .collect()
}

fn custom_skills(app: &AppHandle) -> Vec<CustomSkill> {
    let raw = {
        let state = app_state(app);
        let store = state.store.lock().unwrap();
        store.settings.get(KEY_CUSTOM).cloned().unwrap_or(Value::Null)
    };
    serde_json::from_value::<Vec<CustomSkill>>(raw).map(|list| sanitize_custom(&list)).unwrap_or_default()
}

/// A provider the user configured. Present only when a key is set.
#[derive(Clone)]
struct Target {
    base: String,
    model: String,
    key: String,
}

fn direct(app: &AppHandle) -> Option<Target> {
    Some(Target {
        base: setting(app, KEY_BASE).unwrap_or_else(|| DEFAULT_BASE.into()),
        model: setting(app, KEY_MODEL).unwrap_or_else(|| DEFAULT_MODEL.into()),
        key: setting(app, KEY_SECRET)?,
    })
}

fn gateway() -> Option<String> {
    let url = std::env::var("MDPAD_TIDY_URL").ok().or_else(|| option_env!("MDPAD_TIDY_URL").map(str::to_string))?;
    let url = url.trim().to_string();
    (url.starts_with("https://") || url.starts_with("http://localhost") || url.starts_with("http://127.0.0.1")).then_some(url)
}

/// What the page should show. Never contains the key itself.
#[tauri::command]
pub fn ai_status(app: AppHandle) -> Value {
    let has_key = setting(&app, KEY_SECRET).is_some();
    let has_gateway = gateway().is_some();
    let completion = {
        let state = app_state(&app);
        let store = state.store.lock().unwrap();
        store.settings.get(KEY_COMPLETION).and_then(Value::as_bool).unwrap_or(false)
    };
    json!({
        "mode": if has_key { "direct" } else if has_gateway { "gateway" } else { "none" },
        "direct": has_key,
        "gateway": has_gateway,
        "baseUrl": setting(&app, KEY_BASE).unwrap_or_else(|| DEFAULT_BASE.into()),
        "model": setting(&app, KEY_MODEL).unwrap_or_else(|| DEFAULT_MODEL.into()),
        "hasKey": has_key,
        "completion": completion,
        // Custom rewrites are the user's own text, so the page may see them; the built-in prompts
        // and the key stay here.
        "custom": custom_skills(&app),
    })
}

/// Saves the configuration. `apiKey`: `None` leaves it alone, `Some("")` removes it.
#[tauri::command]
pub fn ai_configure(
    app: AppHandle,
    base_url: Option<String>,
    model: Option<String>,
    api_key: Option<String>,
    completion: Option<bool>,
    custom: Option<Vec<CustomSkill>>,
) -> Value {
    {
        let state = app_state(&app);
        let mut store = state.store.lock().unwrap();
        put(&mut store, KEY_BASE, base_url);
        put(&mut store, KEY_MODEL, model);
        put(&mut store, KEY_SECRET, api_key);
        if let Some(completion) = completion {
            store.settings.insert(KEY_COMPLETION.to_string(), json!(completion));
        }
        if let Some(list) = custom {
            let list = sanitize_custom(&list);
            if list.is_empty() {
                store.settings.remove(KEY_CUSTOM);
            } else {
                store.settings.insert(KEY_CUSTOM.to_string(), json!(list));
            }
        }
        store.save();
    }
    ai_status(app)
}

// ---------------------------------------------------------------- model calls

/// Shared by the voice module: one connection pool for every outbound call.
pub(crate) fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().build().unwrap_or_else(|_| reqwest::Client::new()))
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars().take(max).collect()
}

fn clip_tail(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    text.chars().skip(count - max).collect()
}

/// A readable reason for an HTTP status, so "nothing happened" never means "network error".
fn status_message(status: u16) -> String {
    match status {
        400 => "AI 服务不接受这个请求（HTTP 400），检查模型名是否正确".into(),
        401 | 403 => "Key 无效，或者没有调用这个模型的权限".into(),
        402 => "账户余额不足".into(),
        404 => "地址不对：服务端没有 /chat/completions（HTTP 404）".into(),
        413 => "发送的内容太长".into(),
        429 => "请求太频繁，稍后再试".into(),
        500..=599 => format!("AI 服务暂时不可用（HTTP {status}）"),
        _ => format!("AI 服务返回了 HTTP {status}"),
    }
}

fn transport_message(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "AI 服务没有在预期时间内返回".to_string()
    } else if error.is_connect() {
        "连不上 AI 服务，检查网络或地址".to_string()
    } else if error.is_decode() {
        "AI 服务返回的内容不是合法的 JSON".to_string()
    } else {
        format!("请求 AI 服务失败：{error}")
    }
}

/// Reads `choices[0].message.content` from an OpenAI-compatible answer.
fn read_content(body: &Value) -> Result<String, String> {
    let content = body
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or_else(|| "AI 服务的返回里没有内容".to_string())?;
    Ok(content.to_string())
}

/// Server-side reason, when the provider sends one. Falls back to the status text.
fn read_error(body: &Value, status: u16) -> String {
    let detail = body.pointer("/error/message").and_then(Value::as_str).filter(|s| !s.is_empty());
    match detail {
        Some(detail) if detail.chars().count() <= 160 => format!("{}：{detail}", status_message(status)),
        _ => status_message(status),
    }
}

async fn chat(target: &Target, system: &str, user: &str, max_tokens: u32, timeout: u64) -> Result<String, String> {
    let url = format!("{}/chat/completions", target.base.trim_end_matches('/'));
    let response = client()
        .post(&url)
        .timeout(Duration::from_secs(timeout))
        .bearer_auth(&target.key)
        .json(&json!({
            "model": target.model,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user },
            ],
            "max_tokens": max_tokens,
            "temperature": 0.4,
            "stream": false,
        }))
        .send()
        .await
        .map_err(|e| transport_message(&e))?;
    let status = response.status().as_u16();
    let body: Value = response.json().await.map_err(|_| match status {
        200 => "AI 服务返回的内容不是合法的 JSON".to_string(),
        _ => status_message(status),
    })?;
    if !(200..300).contains(&status) {
        return Err(read_error(&body, status));
    }
    read_content(&body)
}

/// The gateway answers on its own endpoints; it owns the prompt, so only the payload is sent.
async fn gate(endpoint: &str, payload: Value, timeout: u64) -> Result<String, String> {
    let base = gateway().ok_or("还没有配置 AI 服务")?;
    let url = format!("{}/{endpoint}", base.trim_end_matches('/'));
    let response = client()
        .post(&url)
        .timeout(Duration::from_secs(timeout))
        .json(&payload)
        .send()
        .await
        .map_err(|e| transport_message(&e))?;
    let status = response.status().as_u16();
    let body: Value = response.json().await.map_err(|_| match status {
        200 => "服务返回的内容无法识别".to_string(),
        _ => status_message(status),
    })?;
    if !(200..300).contains(&status) {
        return Err(read_error(&body, status));
    }
    body.get("text").and_then(Value::as_str).map(str::to_string).ok_or_else(|| "服务没有返回 text".to_string())
}

// ---------------------------------------------------------------- output clean-up

/// Removes a wrapper the model put around the whole answer: a code fence or one pair of quotes.
fn unwrap_outer(text: &str) -> String {
    let mut s = text.trim();
    if let Some(rest) = s.strip_prefix("```") {
        let inner = match rest.find('\n') {
            // The first line is a language label when it is short and has no space.
            Some(at) if rest[..at].trim().len() <= 16 && !rest[..at].contains(' ') => &rest[at + 1..],
            _ => rest,
        };
        s = inner.trim_end();
        if let Some(at) = s.rfind("```") {
            s = &s[..at];
        }
        s = s.trim();
    }
    for (open, close) in [('"', '"'), ('“', '”'), ('「', '」'), ('『', '』')] {
        if s.starts_with(open) && s.ends_with(close) && s.chars().count() > 2 {
            let inner: String = s.chars().skip(1).collect();
            let count = inner.chars().count();
            return inner.chars().take(count - 1).collect::<String>().trim().to_string();
        }
    }
    s.trim().to_string()
}

/// A completion must be one line: anything after the first line is the model explaining itself.
fn first_line(text: &str) -> String {
    unwrap_outer(text).lines().next().unwrap_or("").trim().to_string()
}

/// Drops a tail the model copied from the text after the cursor.
fn strip_echo(text: &str, after: &str) -> String {
    let body: Vec<char> = text.chars().collect();
    let next: Vec<char> = after.trim_start().chars().collect();
    let max = body.len().min(next.len());
    for size in (6..=max).rev() {
        if body[body.len() - size..] == next[..size] {
            return body[..body.len() - size].iter().collect::<String>().trim_end().to_string();
        }
    }
    text.to_string()
}

// ---------------------------------------------------------------- commands

const COMPLETE_PROMPT: &str = "你在一个 Markdown 编辑器里帮用户续写正文。<before> 是光标前的文字，<after> 是光标后的文字。\n\
只输出紧接着光标应该出现的文字：不解释、不加引号、不重复 <before> 里已有的内容、不写 Markdown 语法标记。\n\
中文之间不加空格，英文单词之间保留一个空格。最多一句话。\n\
如果句子已经完整、或者你没有把握，就输出空字符串。";

const REWRITE_PROMPT: &str = "你在一个 Markdown 编辑器里改写一段正文。只输出改写后的正文：不要解释、不要开场白、不要包进代码块或引号。\n\
保留原有的 Markdown 标记（标题、列表、粗体、链接、行内代码、公式）。\n\
不要新增原文没有的事实、数字、人名或链接。除非要求翻译，否则保持原文的语言。";

/// Continues the text at the cursor. An empty string means "nothing worth suggesting".
#[tauri::command]
pub async fn ai_complete(app: AppHandle, before: String, after: String) -> Result<String, String> {
    if before.trim().is_empty() {
        return Ok(String::new());
    }
    let before = clip(&before, MAX_BEFORE);
    let after = clip_tail(&after, MAX_AFTER);
    let user = format!("<before>{before}</before>\n<cursor/>\n<after>{after}</after>");

    let raw = if let Some(target) = direct(&app) {
        chat(&target, COMPLETE_PROMPT, &user, 120, TIMEOUT_COMPLETE).await?
    } else if gateway().is_some() {
        gate("complete", json!({ "before": before, "after": after }), TIMEOUT_COMPLETE).await?
    } else {
        return Err("还没有配置 AI 服务".into());
    };

    let text = first_line(&raw);
    let text = strip_echo(&text, &after);
    Ok(clip(&text, MAX_COMPLETION_CHARS))
}

/// Rewrites one block. `instruction` is a short command such as 「润色」; the rules live above.
#[tauri::command]
pub async fn ai_rewrite(app: AppHandle, text: String, instruction: String) -> Result<String, String> {
    if text.trim().is_empty() {
        return Err("先选中要改的文字".into());
    }
    if text.chars().count() > MAX_REWRITE {
        return Err(format!("这一段太长了，先分成 {MAX_REWRITE} 字以内的段落"));
    }
    let instruction = clip(instruction.trim(), MAX_INSTRUCTION);
    if instruction.is_empty() {
        return Err("没有说明要怎么改".into());
    }

    let raw = if let Some(target) = direct(&app) {
        let user = format!("<要求>{instruction}</要求>\n<正文>\n{text}\n</正文>");
        chat(&target, REWRITE_PROMPT, &user, 4_000, TIMEOUT_REWRITE).await?
    } else if gateway().is_some() {
        gate("rewrite", json!({ "text": text, "instruction": instruction }), TIMEOUT_REWRITE).await?
    } else {
        return Err("还没有配置 AI 服务".into());
    };

    let cleaned = unwrap_outer(&raw);
    if cleaned.is_empty() {
        return Err("AI 没有给出改写结果".into());
    }
    Ok(cleaned)
}

/// A cheap round trip, used by the settings panel to prove the configuration works.
#[tauri::command]
pub async fn ai_test(app: AppHandle) -> Result<String, String> {
    if let Some(target) = direct(&app) {
        let answer = chat(&target, "只回复一个词：ok", "现在测试连接", 8, TIMEOUT_COMPLETE).await?;
        return Ok(format!("{} 可用（回复：{}）", target.model, first_line(&answer)));
    }
    if gateway().is_some() {
        gate("complete", json!({ "before": "测试", "after": "" }), TIMEOUT_COMPLETE).await?;
        return Ok("网关可用".into());
    }
    Err("还没有配置 AI 服务".into())
}

// ---------------------------------------------------------------- tidy (direct or gateway)

const ALLOWED: [&str; 10] = ["h1", "h2", "h3", "ul", "ol", "quote", "p", "cont", "blank", "keep"];
const MAX_LINES: usize = 400;
const MAX_CHARS: usize = 30_000;
/// One label per line, so a full chunk needs a fraction of this. Twice over is plenty of room.
const MAX_LABEL_TOKENS: u32 = 2_048;
const TIMEOUT_LABEL: u64 = 60;

/// The line classifier, worded the same way as the gateway's, so both paths ask a model for the same
/// thing. The model answers with labels only: the Markdown is rebuilt from the original lines, so it
/// cannot change, drop or invent a word.
const LABEL_PROMPT: &str = "你是文档排版助手。下面是一段没有排版的纯文本，每行前面是行号和制表符。\n\
请给每一行打一个标签，只输出 JSON，形如 {\"labels\":[\"h1\",\"p\"]}，数组长度必须等于行数。\n\
标签只能是：h1、h2、h3、ul、ol、quote、p、cont、blank、keep。\n\
空行必须标 blank，非空行不能标 blank。\n\
h1 是文档标题（全文只有一个），h2 是章节标题，h3 是小节标题，ul / ol 是列表项，quote 是引用，\
p 是正文段落，cont 是上一行被换行打断的后半句，keep 是本来就是 Markdown 的行。\n\
不要修改、翻译、总结文字，你只打标签。";

/// True when a model can be reached: the user's own key, or the team gateway.
#[tauri::command]
pub fn ai_available(app: AppHandle) -> bool {
    direct(&app).is_some() || gateway().is_some()
}

/// Accepts `{"labels": [...]}` or a bare array, with labels in any case.
fn parse_labels(body: &Value) -> Result<Vec<String>, String> {
    let list = body.get("labels").unwrap_or(body).as_array().ok_or("网关返回的内容里没有 labels")?;
    list.iter().map(|v| v.as_str().map(|s| s.trim().to_lowercase()).ok_or_else(|| "labels 里有不是文字的项".to_string())).collect()
}

/// Pulls a label array out of whatever a model wrote: a JSON object, a bare array, or either one
/// wrapped in prose or a code fence.
fn parse_labels_text(text: &str) -> Option<Vec<String>> {
    let raw = unwrap_outer(text);
    let mut attempts = vec![raw.clone()];
    for (open, close) in [('{', '}'), ('[', ']')] {
        if let (Some(from), Some(to)) = (raw.find(open), raw.rfind(close)) {
            if to > from {
                attempts.push(raw[from..=to].to_string());
            }
        }
    }
    for attempt in attempts {
        let Ok(value) = serde_json::from_str::<Value>(&attempt) else { continue };
        let Some(items) = value.get("labels").unwrap_or(&value).as_array() else { continue };
        let labels: Vec<String> = items.iter().map(|v| v.as_str().unwrap_or("").trim().to_lowercase()).collect();
        if !labels.is_empty() && labels.iter().all(|label| !label.is_empty()) {
            return Some(labels);
        }
    }
    None
}

/// Makes a model's labels usable, or gives up. A blank line becomes `blank` whatever was said, and a
/// `blank` on a line that has text becomes `p`: both are facts about the line, so fixing them cannot
/// change a word. Anything else (wrong length, unknown label) is refused and the chunk keeps rules.
fn fit_labels(labels: Vec<String>, lines: &[String]) -> Option<Vec<String>> {
    if labels.len() != lines.len() {
        return None;
    }
    let mut out = Vec::with_capacity(labels.len());
    for (label, line) in labels.into_iter().zip(lines) {
        let empty = line.trim().is_empty();
        let label = match (empty, label.as_str()) {
            (true, _) => "blank".to_string(),
            (false, "blank") => "p".to_string(),
            _ => label,
        };
        if !ALLOWED.contains(&label.as_str()) {
            return None;
        }
        out.push(label);
    }
    Some(out)
}

/// A JSON-mode answer. Some OpenAI-compatible providers reject `response_format`, so the plain shape
/// is tried again instead of losing the whole chunk to it.
async fn chat_json(target: &Target, system: &str, user: &str, max_tokens: u32, timeout: u64) -> Result<String, String> {
    let url = format!("{}/chat/completions", target.base.trim_end_matches('/'));
    let payload = |json_mode: bool| {
        let mut body = json!({
            "model": target.model,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user },
            ],
            "max_tokens": max_tokens,
            "temperature": 0.0,
            "stream": false,
        });
        if json_mode {
            body["response_format"] = json!({ "type": "json_object" });
        }
        body
    };
    let mut json_mode = true;
    loop {
        let response = client()
            .post(&url)
            .timeout(Duration::from_secs(timeout))
            .bearer_auth(&target.key)
            .json(&payload(json_mode))
            .send()
            .await
            .map_err(|e| transport_message(&e))?;
        let status = response.status().as_u16();
        let text = response.text().await.map_err(|_| "AI 服务返回的内容无法读取".to_string())?;
        if status == 400 && json_mode && text.contains("response_format") {
            json_mode = false;
            continue;
        }
        if !(200..300).contains(&status) {
            let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            return Err(read_error(&body, status));
        }
        let body: Value = serde_json::from_str(&text).map_err(|_| "AI 服务返回的内容不是合法的 JSON".to_string())?;
        return read_content(&body);
    }
}

/// How small a piece may get before a bad answer is treated as the whole chunk's failure.
const MIN_SPLIT_LINES: usize = 24;

/// Why a piece could not be labelled. The difference matters: a bad answer may do better on a
/// smaller piece, while a network or quota error will not.
enum LabelFail {
    Content(String),
    Fatal(String),
}

/// Labels one piece: two asks, the second saying exactly how many items are needed.
async fn label_piece(target: &Target, lines: &[String]) -> Result<Vec<String>, LabelFail> {
    let numbered: Vec<String> = lines.iter().enumerate().map(|(i, line)| format!("{}\t{line}", i + 1)).collect();
    let numbered = numbered.join("\n");
    let mut last = "模型给的不是标签数组".to_string();
    for strict in [false, true] {
        let lead = if strict {
            format!(
                "上一次的输出不能用。数组必须正好 {} 项，第 i 项对应第 i 行；不许合并、省略或补行。共 {} 行：",
                lines.len(),
                lines.len()
            )
        } else {
            format!("共 {} 行：", lines.len())
        };
        let asked = chat_json(target, LABEL_PROMPT, &format!("{lead}\n\n{numbered}"), MAX_LABEL_TOKENS, TIMEOUT_LABEL).await;
        let content = match asked {
            Ok(content) => content,
            Err(message) => return Err(LabelFail::Fatal(message)),
        };
        match parse_labels_text(&content) {
            Some(labels) => match fit_labels(labels, lines) {
                Some(fitted) => return Ok(fitted),
                None => last = format!("标签对不上原文（需要 {} 个）", lines.len()),
            },
            None => last = "模型给的不是标签数组".to_string(),
        }
    }
    Err(LabelFail::Content(last))
}

/// Labels one chunk with the user's own model. A piece that comes back unusable is split and asked
/// again, so one stubborn paragraph cannot send a whole long document back to the rules.
async fn label_direct(target: &Target, lines: &[String]) -> Result<Vec<String>, String> {
    let mut labels = vec![String::new(); lines.len()];
    let mut pending = vec![(0usize, lines.len())];
    while let Some((from, to)) = pending.pop() {
        match label_piece(target, &lines[from..to]).await {
            Ok(piece) => labels[from..to].clone_from_slice(&piece),
            Err(LabelFail::Fatal(message)) => return Err(message),
            Err(LabelFail::Content(message)) => {
                if to - from <= MIN_SPLIT_LINES {
                    return Err(message);
                }
                let middle = from + (to - from) / 2;
                // The second half goes on the stack first, so pieces are asked for in reading order.
                pending.push((middle, to));
                pending.push((from, middle));
            }
        }
    }
    Ok(labels)
}

/// Labels the lines of one chunk. The page validates the result again before using it.
#[tauri::command]
pub async fn ai_label(app: AppHandle, lines: Vec<String>) -> Result<Vec<String>, String> {
    if lines.is_empty() || lines.len() > MAX_LINES || lines.iter().map(|l| l.chars().count()).sum::<usize>() > MAX_CHARS {
        return Err("这一段太长，无法交给整理服务".into());
    }
    if let Some(target) = direct(&app) {
        return label_direct(&target, &lines).await;
    }
    let url = gateway().ok_or("还没有配置 AI 服务")?;
    let response = client()
        .post(&url)
        .timeout(Duration::from_secs(60))
        .json(&json!({ "lines": lines }))
        .send()
        .await
        .map_err(|e| transport_message(&e))?;
    let status = response.status().as_u16();
    let body: Value = response.json().await.map_err(|_| status_message(status))?;
    if !(200..300).contains(&status) {
        return Err(read_error(&body, status));
    }
    let labels = parse_labels(&body)?;
    if labels.len() != lines.len() || labels.iter().any(|l| !ALLOWED.contains(&l.as_str())) {
        return Err("整理服务给的标签数量或种类不对".into());
    }
    Ok(labels)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The page must never learn the key; `window_init` filters settings through that list.
    /// If this fails, the key is on its way back to the renderer.
    #[test]
    fn the_key_is_on_the_never_sent_list() {
        assert!(crate::store::SECRET_SETTINGS.contains(&KEY_SECRET));
    }

    #[test]
    fn labels_come_from_an_object_or_a_bare_array() {
        assert_eq!(parse_labels(&json!({ "labels": ["H1", " p "] })).unwrap(), vec!["h1", "p"]);
        assert_eq!(parse_labels(&json!(["blank"])).unwrap(), vec!["blank"]);
        assert!(parse_labels(&json!({ "labels": "x" })).is_err());
        assert!(parse_labels(&json!({ "labels": [1] })).is_err());
    }

    #[test]
    fn labels_are_found_in_an_object_an_array_or_prose() {
        assert_eq!(parse_labels_text("{\"labels\":[\"H1\",\" p \"]}").unwrap(), vec!["h1", "p"]);
        assert_eq!(parse_labels_text("```json\n[\"blank\"]\n```").unwrap(), vec!["blank"]);
        assert_eq!(parse_labels_text("好的，结果如下：{\"labels\":[\"h2\"]}").unwrap(), vec!["h2"]);
        assert!(parse_labels_text("没有 JSON").is_none());
        assert!(parse_labels_text("{\"labels\":[]}").is_none(), "an empty list is not an answer");
    }

    #[test]
    fn a_blank_label_follows_the_line_it_describes() {
        let lines = vec!["标题".to_string(), String::new(), "正文".to_string()];
        // `p` on a blank line and `blank` on text are both corrected: neither can change a word.
        assert_eq!(fit_labels(vec!["h1".into(), "p".into(), "blank".into()], &lines).unwrap(), vec!["h1", "blank", "p"]);
        assert!(fit_labels(vec!["h1".into(), "blank".into()], &lines).is_none(), "too few labels");
        assert!(fit_labels(vec!["h1".into(), "blank".into(), "bullet".into()], &lines).is_none(), "unknown label");
    }

    /// 真去问一次模型，验证直连这条路（JSON 模式、标签解析、长度对齐）。默认不跑，手动：
    /// `MDPAD_AI_KEY=sk-… cargo test a_real_model_labels -- --ignored --nocapture`
    #[test]
    #[ignore = "需要真实的 AI Key 和外网，只在手工验证时跑"]
    fn a_real_model_labels_every_line() {
        let Ok(key) = std::env::var("MDPAD_AI_KEY") else { return };
        let target = Target {
            base: std::env::var("MDPAD_AI_BASE").unwrap_or_else(|_| DEFAULT_BASE.into()),
            model: std::env::var("MDPAD_AI_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.into()),
            key,
        };
        let lines: Vec<String> = [
            "关于开展安全自查的通知",
            "",
            "一、自查范围",
            "本次自查覆盖全部对外服务的系统。",
            "1、账号与权限",
            "核查是否存在共用账号。",
        ]
        .iter()
        .map(|line| line.to_string())
        .collect();
        let labels = tauri::async_runtime::block_on(label_direct(&target, &lines)).unwrap();
        println!("{labels:?}");
        assert_eq!(labels.len(), lines.len());
        assert_eq!(labels[1], "blank", "an empty line is always blank");
        assert!(labels.iter().any(|label| label == "h1" || label == "h2"), "the title is a heading: {labels:?}");
    }

    #[test]
    fn status_messages_name_the_real_cause() {
        assert!(status_message(401).contains("Key"));
        assert!(status_message(429).contains("频繁"));
        assert!(status_message(404).contains("地址"));
        assert!(status_message(503).contains("503"));
    }

    #[test]
    fn clippers_count_characters_not_bytes() {
        assert_eq!(clip("中文三个字", 2), "中文");
        assert_eq!(clip_tail("中文三个字", 2), "个字");
        assert_eq!(clip("abc", 9), "abc");
    }

    #[test]
    fn a_fence_or_a_quote_around_the_whole_answer_is_removed() {
        assert_eq!(unwrap_outer("```markdown\n# 标题\n```"), "# 标题");
        assert_eq!(unwrap_outer("```\n一行\n```"), "一行");
        assert_eq!(unwrap_outer("“一段话”"), "一段话");
        assert_eq!(unwrap_outer("原样保留"), "原样保留");
    }

    #[test]
    fn a_completion_keeps_only_its_first_line() {
        assert_eq!(first_line("第一句\n\n以上是我续写的"), "第一句");
        assert_eq!(first_line("  "), "");
    }

    #[test]
    fn a_tail_copied_from_the_next_text_is_dropped() {
        assert_eq!(strip_echo("这段说明接下来会详细讨论配置项", "会详细讨论配置项的细节"), "这段说明接下来");
        assert_eq!(strip_echo("短尾好", "好，继续"), "短尾好");
        assert_eq!(strip_echo("无关内容", "完全不同的后文"), "无关内容");
    }

    #[test]
    fn custom_skills_are_trimmed_capped_and_dropped_when_empty() {
        let list = vec![
            CustomSkill { label: "  公文  ".into(), instruction: "  按公文格式改写  ".into() },
            CustomSkill { label: "空的".into(), instruction: "   ".into() },
            CustomSkill { label: "二".into(), instruction: "第二条".into() },
            CustomSkill { label: "三".into(), instruction: "第三条".into() },
            CustomSkill { label: "四".into(), instruction: "第四条".into() },
        ];
        let clean = sanitize_custom(&list);
        assert_eq!(clean.len(), MAX_CUSTOM);
        assert_eq!(clean[0].label, "公文");
        assert_eq!(clean[0].instruction, "按公文格式改写");
        assert_eq!(clean[1].label, "二");
    }

    #[test]
    fn custom_skill_text_is_clipped_by_characters() {
        let long = "改".repeat(300);
        let clean = sanitize_custom(&[CustomSkill { label: "长".repeat(20), instruction: long }]);
        assert_eq!(clean[0].instruction.chars().count(), MAX_CUSTOM_INSTRUCTION);
        assert_eq!(clean[0].label.chars().count(), MAX_CUSTOM_LABEL);
    }
}
