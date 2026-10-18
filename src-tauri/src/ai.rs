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
//! Tidy keeps using the gateway only (`ai_available` / `ai_label`): it needs the line classifier,
//! which the gateway owns. The writing features below work with either path.

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

fn client() -> &'static reqwest::Client {
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

// ---------------------------------------------------------------- tidy (gateway only)

const ALLOWED: [&str; 10] = ["h1", "h2", "h3", "ul", "ol", "quote", "p", "cont", "blank", "keep"];
const MAX_LINES: usize = 400;
const MAX_CHARS: usize = 30_000;

/// True when a gateway is configured, so the page knows whether the AI tidy path exists.
#[tauri::command]
pub fn ai_available() -> bool {
    gateway().is_some()
}

/// Accepts `{"labels": [...]}` or a bare array, with labels in any case.
fn parse_labels(body: &Value) -> Result<Vec<String>, String> {
    let list = body.get("labels").unwrap_or(body).as_array().ok_or("网关返回的内容里没有 labels")?;
    list.iter().map(|v| v.as_str().map(|s| s.trim().to_lowercase()).ok_or_else(|| "labels 里有不是文字的项".to_string())).collect()
}

/// Labels the lines of one chunk. The page validates the result again before using it.
#[tauri::command]
pub async fn ai_label(lines: Vec<String>) -> Result<Vec<String>, String> {
    let url = gateway().ok_or("还没有配置整理服务（MDPAD_TIDY_URL）")?;
    if lines.is_empty() || lines.len() > MAX_LINES || lines.iter().map(|l| l.chars().count()).sum::<usize>() > MAX_CHARS {
        return Err("这一段太长，无法交给整理服务".into());
    }
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

    #[test]
    fn labels_come_from_an_object_or_a_bare_array() {
        assert_eq!(parse_labels(&json!({ "labels": ["H1", " p "] })).unwrap(), vec!["h1", "p"]);
        assert_eq!(parse_labels(&json!(["blank"])).unwrap(), vec!["blank"]);
        assert!(parse_labels(&json!({ "labels": "x" })).is_err());
        assert!(parse_labels(&json!({ "labels": [1] })).is_err());
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
