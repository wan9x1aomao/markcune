//! AI tidy: sends the lines of a document to the team's gateway, which returns one label per line
//! (heading, list, paragraph …). The app holds no model name, key or prompt: the gateway owns all of that.
//! The gateway address comes from the MDPAD_TIDY_URL environment variable or, failing that, is fixed at build time.

use std::time::Duration;

use serde_json::{json, Value};

const ALLOWED: [&str; 10] = ["h1", "h2", "h3", "ul", "ol", "quote", "p", "cont", "blank", "keep"];
const MAX_LINES: usize = 400;
const MAX_CHARS: usize = 30_000;

fn gateway() -> Option<String> {
    let url = std::env::var("MDPAD_TIDY_URL").ok().or_else(|| option_env!("MDPAD_TIDY_URL").map(str::to_string))?;
    let url = url.trim().to_string();
    (url.starts_with("https://") || url.starts_with("http://localhost") || url.starts_with("http://127.0.0.1")).then_some(url)
}

/// True when a gateway is configured, so the page knows whether the AI path exists.
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
    let client = reqwest::Client::builder().timeout(Duration::from_secs(60)).build().map_err(|e| e.to_string())?;
    let res = client.post(&url).json(&json!({ "lines": lines })).send().await.map_err(|e| format!("连不上整理服务：{e}"))?;
    let status = res.status();
    let body: Value = res.json().await.map_err(|_| format!("整理服务返回了无法识别的内容（HTTP {status}）"))?;
    if !status.is_success() {
        let msg = body["error"]["message"].as_str().or_else(|| body["error"].as_str()).or_else(|| body["message"].as_str()).unwrap_or("请求失败");
        return Err(format!("整理服务返回 {status}：{msg}"));
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
}
