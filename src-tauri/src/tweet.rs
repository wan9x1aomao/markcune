//! X（Twitter）帖子 → Markdown。
//!
//! 为什么不能像别的链接那样直接下载：`x.com/<user>/status/<id>` 是 JavaScript 渲染的页面，
//! 浏览器之外拿到的 HTML 里没有正文；而 X 的「长文」（Article）正文在一个需要登录的
//! `i/article/<id>` 地址后面。所以这里改走镜像服务 `api.fxtwitter.com`：它把帖子（含长文）
//! 解析成结构化 JSON 交给我们，转换在本地完成，本模块只做「JSON → Markdown」这一件事，
//! 不碰网络，方便单测。
//!
//! 图片在 Markdown 里先写成 `![](mdpad-img:0)` 这种占位，由调用方下载完再替换成真实路径：
//! 下载是异步的、可能失败，而排版逻辑不该知道这些。

use serde_json::Value;

/// 一条帖子转换后的样子。
#[derive(Debug, PartialEq)]
pub struct Post {
    /// 长文标题；普通推文是「@某人 的推文」。
    pub title: String,
    pub handle: String,
    pub author: String,
    pub url: String,
    /// `YYYY-MM-DD`
    pub date: String,
    /// 正文，图片是 `mdpad-img:<序号>` 占位。
    pub body: String,
    /// 正文里出现过的图片地址，顺序与占位序号一致。
    pub images: Vec<String>,
    pub is_article: bool,
}

/// 占位符前缀，调用方据此替换。
pub const IMAGE_PREFIX: &str = "mdpad-img:";

const MAX_IMAGES: usize = 80;

/// 把镜像服务返回的 JSON 转成 [`Post`]。
pub fn parse(json: &str) -> Result<Post, String> {
    let root: Value = serde_json::from_str(json).map_err(|_| "镜像服务返回的内容读不懂".to_string())?;
    let code = root.get("code").and_then(Value::as_int_like);
    if code != Some(200) {
        return Err(match code {
            Some(404) => "这条帖子不存在，可能已被删除或账号受保护".to_string(),
            Some(401 | 403) => "这条帖子需要登录才能看，镜像服务拿不到".to_string(),
            Some(429) => "镜像服务被请求得太频繁，过一会儿再试".to_string(),
            _ => "镜像服务没有返回这条帖子".to_string(),
        });
    }
    let tweet = root.get("tweet").ok_or("镜像服务没有返回这条帖子")?;

    let handle = text_at(tweet, &["author", "screen_name"]);
    let author = text_at(tweet, &["author", "name"]);
    if handle.is_empty() {
        return Err("这条帖子没有作者信息，可能已被删除".to_string());
    }
    let url = text_at(tweet, &["url"]);
    let date = post_date(tweet);
    let html_url = if url.is_empty() { format!("https://x.com/{handle}") } else { url };

    if let Some(article) = tweet.get("article").filter(|value| value.get("content").is_some()) {
        let title = text_at(article, &["title"]);
        let media = media_map(article);
        let (body, images) = blocks_to_markdown(article, &media);
        return Ok(Post {
            title: if title.is_empty() { format!("@{handle} 的长文") } else { title },
            handle,
            author,
            url: html_url,
            date,
            body,
            images,
            is_article: true,
        });
    }

    // 普通推文：正文 + 图片/视频封面。
    let text = text_at(tweet, &["text"]);
    if text.trim().is_empty() {
        return Err("这条帖子没有文字内容".to_string());
    }
    let mut images = Vec::new();
    let mut body = text.trim().replace("\r\n", "\n");
    if let Some(photos) = tweet.get("media").and_then(|media| media.get("photos")).and_then(Value::as_array) {
        for photo in photos {
            let url = text_at(photo, &["url"]);
            if !url.is_empty() && !images.contains(&url) && images.len() < MAX_IMAGES {
                let index = images.len();
                images.push(url);
                body.push_str(&format!("\n\n![]({IMAGE_PREFIX}{index})"));
            }
        }
    }
    if let Some(videos) = tweet.get("media").and_then(|media| media.get("videos")).and_then(Value::as_array) {
        for video in videos {
            let url = text_at(video, &["url"]);
            if !url.is_empty() {
                body.push_str(&format!("\n\n[{url}]({url})"));
            }
        }
    }
    let first_line = text.lines().next().unwrap_or_default().trim();
    let title = if first_line.is_empty() {
        format!("@{handle} 的推文")
    } else {
        summarize(first_line, 40)
    };
    Ok(Post { title, handle, author, url: html_url, date, body, images, is_article: false })
}

/// 组装最终写入磁盘的 Markdown。
///
/// `resolve` 负责把占位序号换成实际可用的图片地址（本地相对路径，或下载失败时的远程地址）。
pub fn document(post: &Post, resolve: &dyn Fn(usize) -> String) -> String {
    let mut out = String::new();
    out.push_str(&format!("# {}\n\n", post.title.trim()));
    let who = match (post.author.is_empty(), post.handle.is_empty()) {
        (false, false) => format!("{}（@{}）", post.author, post.handle),
        (_, false) => format!("@{}", post.handle),
        _ => String::new(),
    };
    let mut meta: Vec<String> = Vec::new();
    if !who.is_empty() {
        meta.push(who);
    }
    if !post.date.is_empty() {
        meta.push(post.date.clone());
    }
    if !post.url.is_empty() {
        meta.push(format!("[原帖]({})", post.url));
    }
    if !meta.is_empty() {
        out.push_str(&format!("> {}\n\n", meta.join(" · ")));
    }
    let body = replace_placeholders(&post.body, resolve);
    out.push_str(&body.trim_end());
    out.push('\n');
    out
}

/// 正文里剩下的占位符全换成给定地址；占位序号越界的原样保留，免得静默丢图。
fn replace_placeholders(body: &str, resolve: &dyn Fn(usize) -> String) -> String {
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while let Some(start) = rest.find(IMAGE_PREFIX) {
        out.push_str(&rest[..start]);
        let tail = &rest[start + IMAGE_PREFIX.len()..];
        let digits: String = tail.chars().take_while(char::is_ascii_digit).collect();
        if let Ok(index) = digits.parse::<usize>() {
            out.push_str(&resolve(index));
            rest = &tail[digits.len()..];
        } else {
            out.push_str(IMAGE_PREFIX);
            rest = tail;
        }
    }
    out.push_str(rest);
    out
}

/// 发布日，`YYYY-MM-DD`。
///
/// 镜像服务的 `created_at` 是 `Sun Oct 18 02:16:18 +0000 2026` 这种格式，直接截前 10 个字符
/// 会得到「Sun Oct 18」；用 `created_timestamp`（Unix 秒）自己换算才稳定。
fn post_date(tweet: &Value) -> String {
    let seconds = tweet
        .get("created_timestamp")
        .and_then(|value| value.as_i64().or_else(|| value.as_str().and_then(|text| text.parse().ok())));
    if let Some(seconds) = seconds.filter(|value| *value > 0) {
        let days = seconds.div_euclid(86_400);
        let (year, month, day) = civil_from_days(days);
        return format!("{year:04}-{month:02}-{day:02}");
    }
    let raw = text_at(tweet, &["created_at"]);
    let head: String = raw.chars().take(10).collect();
    if head.len() == 10 && head.chars().nth(4) == Some('-') { head } else { String::new() }
}

/// Unix 天数 → (年, 月, 日)。Howard Hinnant 的算法，不需要引入日期库。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

fn media_map(article: &Value) -> Vec<(String, String)> {    let mut out = Vec::new();
    if let Some(list) = article.get("media_entities").and_then(Value::as_array) {
        for item in list {
            let id = text_at(item, &["media_id"]);
            let url = text_at(item, &["media_info", "original_img_url"]);
            let url = if url.is_empty() { text_at(item, &["media_info", "preview_image", "original_img_url"]) } else { url };
            if !id.is_empty() && !url.is_empty() {
                out.push((id, url));
            }
        }
    }
    out
}

/// Draft.js 的块 → Markdown。
fn blocks_to_markdown(article: &Value, media: &[(String, String)]) -> (String, Vec<String>) {
    let blocks = article
        .get("content")
        .and_then(|content| content.get("blocks"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let entities: Vec<Value> = article
        .get("content")
        .and_then(|content| content.get("entityMap"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut images: Vec<String> = Vec::new();
    let mut out: Vec<String> = Vec::new();
    let mut ordered = 0usize;
    // 代码块要整段拼好再入列：块与块之间要空一行，代码内部的行不能空。
    let mut code: Option<String> = None;

    for block in &blocks {
        let kind = block.get("type").and_then(Value::as_str).unwrap_or("unstyled");
        let text = block.get("text").and_then(Value::as_str).unwrap_or_default();
        if kind != "ordered-list-item" {
            ordered = 0;
        }
        if kind == "code-block" {
            let buffer = code.get_or_insert_with(|| "```\n".to_string());
            buffer.push_str(text);
            buffer.push('\n');
            continue;
        }
        if let Some(mut buffer) = code.take() {
            buffer.push_str("```");
            out.push(buffer);
        }
        match kind {
            "header-one" => out.push(format!("# {}", text.trim())),
            "header-two" => out.push(format!("## {}", text.trim())),
            "header-three" => out.push(format!("### {}", text.trim())),
            "header-four" => out.push(format!("#### {}", text.trim())),
            "header-five" => out.push(format!("##### {}", text.trim())),
            "header-six" => out.push(format!("###### {}", text.trim())),
            "unordered-list-item" => out.push(format!("- {}", styled(text, block))),
            "ordered-list-item" => {
                ordered += 1;
                out.push(format!("{ordered}. {}", styled(text, block)));
            }
            "blockquote" => out.push(format!("> {}", styled(text, block))),
            "atomic" => {
                for range in block.get("entityRanges").and_then(Value::as_array).into_iter().flatten() {
                    let index = range.get("key").and_then(Value::as_u64).unwrap_or(0) as usize;
                    let Some(entity) = entities.get(index) else { continue };
                    let value = entity.get("value").unwrap_or(&Value::Null);
                    match value.get("type").and_then(Value::as_str).unwrap_or_default() {
                        // X 的代码块本身就是一段 Markdown（带围栏），原样放进来即可。
                        "MARKDOWN" => {
                            let snippet = text_at(value, &["data", "markdown"]);
                            if !snippet.trim().is_empty() {
                                out.push(snippet.trim_end().to_string());
                            }
                        }
                        "MEDIA" => {
                            let items = value
                                .get("data")
                                .and_then(|data| data.get("mediaItems"))
                                .and_then(Value::as_array)
                                .cloned()
                                .unwrap_or_default();
                            for item in items {
                                let id = text_at(&item, &["mediaId"]);
                                let Some((_, url)) = media.iter().find(|(known, _)| *known == id) else { continue };
                                let index = match images.iter().position(|seen| seen == url) {
                                    Some(at) => at,
                                    None => {
                                        if images.len() >= MAX_IMAGES {
                                            continue;
                                        }
                                        images.push(url.clone());
                                        images.len() - 1
                                    }
                                };
                                out.push(format!("![]({IMAGE_PREFIX}{index})"));
                            }
                        }
                        "DIVIDER" => out.push("---".into()),
                        _ => {}
                    }
                }
            }
            _ => {
                let line = styled(text, block);
                out.push(line.trim_end().to_string());
            }
        }
    }
    if let Some(mut buffer) = code.take() {
        buffer.push_str("```");
        out.push(buffer);
    }

    // 空行规则：同一种列表的相邻项之间不空行，其余块之间空一行。
    let mut text = String::new();
    let mut previous: Option<&'static str> = None;
    for line in out {
        if line.trim().is_empty() {
            continue;
        }
        let kind = list_kind(&line);
        let trimmed = line.trim_end();
        if text.is_empty() {
            text.push_str(trimmed);
        } else if kind.is_some() && kind == previous {
            text.push('\n');
            text.push_str(trimmed);
        } else {
            text.push_str("\n\n");
            text.push_str(trimmed);
        }
        previous = kind;
    }
    (text, images)
}

/// `- 项` / `12. 项` —— 只有同一种列表的相邻项才不空行，否则有序列表会被并进无序列表里。
fn list_kind(line: &str) -> Option<&'static str> {
    if line.starts_with("- ") || line.starts_with("* ") {
        return Some("ul");
    }
    let digits: String = line.chars().take_while(char::is_ascii_digit).collect();
    if !digits.is_empty() && line[digits.len()..].starts_with(". ") {
        return Some("ol");
    }
    None
}

/// 给一段文本按 Draft.js 的 inlineStyleRanges 加粗/斜体/删除线。
fn styled(text: &str, block: &Value) -> String {
    let Some(ranges) = block.get("inlineStyleRanges").and_then(Value::as_array) else {
        return text.to_string();
    };
    let chars: Vec<char> = text.chars().collect();
    let mut marks: Vec<(usize, usize, &'static str)> = Vec::new();
    for range in ranges {
        let start = range.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
        let len = range.get("length").and_then(Value::as_u64).unwrap_or(0) as usize;
        if len == 0 {
            continue;
        }
        let marker = match range.get("style").and_then(Value::as_str).unwrap_or_default() {
            "Bold" => "**",
            "Italic" => "*",
            "Strikethrough" => "~~",
            _ => continue,
        };
        let from = char_index(text, start);
        let to = char_index(text, start + len);
        if from < to && to <= chars.len() {
            marks.push((from, to, marker));
        }
    }
    if marks.is_empty() {
        return text.to_string();
    }
    marks.sort();
    let mut out = String::new();
    let mut pos = 0usize;
    for (from, to, marker) in marks {
        if from < pos {
            continue;
        }
        out.extend(&chars[pos..from]);
        out.push_str(marker);
        out.extend(&chars[from..to]);
        out.push_str(marker);
        pos = to;
    }
    out.extend(&chars[pos..]);
    out
}

/// Draft.js 的 offset 按 UTF-16 码元算，这里换算成字符下标（表情是代理对，不换算会错位）。
fn char_index(text: &str, utf16: usize) -> usize {
    let mut used = 0usize;
    for (index, ch) in text.chars().enumerate() {
        if used >= utf16 {
            return index;
        }
        used += ch.len_utf16();
    }
    text.chars().count()
}

fn summarize(text: &str, limit: usize) -> String {
    let taken: String = text.chars().take(limit).collect();
    if text.chars().count() > limit {
        format!("{taken}…")
    } else {
        taken
    }
}

fn text_at(value: &Value, path: &[&str]) -> String {
    let mut cursor = value;
    for key in path {
        match cursor.get(*key) {
            Some(next) => cursor = next,
            None => return String::new(),
        }
    }
    cursor.as_str().unwrap_or_default().to_string()
}

/// `code` 在镜像服务里是数字，但也见过字符串形式，两种都认。
trait AsIntLike {
    fn as_int_like(&self) -> Option<i64>;
}

impl AsIntLike for Value {
    fn as_int_like(&self) -> Option<i64> {
        self.as_i64().or_else(|| self.as_str().and_then(|text| text.parse().ok()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn article_json() -> String {
        r#"{
          "code": 200,
          "tweet": {
            "url": "https://x.com/demo/status/42",
            "text": "https://x.com/i/article/7",
            "created_at": "2026-10-18T02:16:18.000Z",
            "author": {"screen_name": "demo", "name": "演示账号"},
            "article": {
              "title": "标题：带冒号/和斜杠",
              "content": {
                "blocks": [
                  {"type": "header-two", "text": "第一节", "inlineStyleRanges": [], "entityRanges": []},
                  {"type": "unstyled", "text": "这是一段话，其中重点标出来。", "inlineStyleRanges": [{"offset": 8, "length": 2, "style": "Bold"}], "entityRanges": []},
                  {"type": "unordered-list-item", "text": "第一项", "inlineStyleRanges": [], "entityRanges": []},
                  {"type": "unordered-list-item", "text": "第二项", "inlineStyleRanges": [], "entityRanges": []},
                  {"type": "ordered-list-item", "text": "步骤一", "inlineStyleRanges": [], "entityRanges": []},
                  {"type": "ordered-list-item", "text": "步骤二", "inlineStyleRanges": [], "entityRanges": []},
                  {"type": "blockquote", "text": "引用一句", "inlineStyleRanges": [], "entityRanges": []},
                  {"type": "atomic", "text": "", "inlineStyleRanges": [], "entityRanges": [{"key": 0, "length": 1, "offset": 0}]},
                  {"type": "atomic", "text": "", "inlineStyleRanges": [], "entityRanges": [{"key": 1, "length": 1, "offset": 0}]},
                  {"type": "atomic", "text": "", "inlineStyleRanges": [], "entityRanges": [{"key": 2, "length": 1, "offset": 0}]}
                ],
                "entityMap": [
                  {"key": "9", "value": {"type": "MARKDOWN", "data": {"markdown": "```sh\nnpm test\n```"}}},
                  {"key": "10", "value": {"type": "MEDIA", "data": {"mediaItems": [{"mediaId": "555"}]}}},
                  {"key": "11", "value": {"type": "DIVIDER", "data": {}}}
                ]
              },
              "media_entities": [
                {"media_id": "555", "media_info": {"original_img_url": "https://pbs.twimg.com/media/a.jpg"}}
              ]
            }
          }
        }"#
        .to_string()
    }

    #[test]
    fn an_article_becomes_markdown_with_lists_code_and_images() {
        let post = parse(&article_json()).unwrap();
        assert_eq!(post.title, "标题：带冒号/和斜杠");
        assert_eq!(post.handle, "demo");
        assert_eq!(post.date, "2026-10-18");
        assert!(post.is_article);
        let text = document(&post, &|index| format!("images/{}.jpg", index + 1));
        assert!(text.contains("# 标题：带冒号/和斜杠"));
        assert!(text.contains("> 演示账号（@demo）"), "{text}");
        assert!(text.contains("## 第一节"));
        assert!(text.contains("这是一段话，其中**重点**标出来。"), "{text}");
        assert!(text.contains("- 第一项\n- 第二项"), "列表项之间不该有空行：{text}");
        // 换一种列表要断开，否则有序列表会被当成无序列表的续行。
        assert!(text.contains("- 第二项\n\n1. 步骤一"), "{text}");
        assert!(text.contains("1. 步骤一\n2. 步骤二"), "{text}");
        assert!(text.contains("> 引用一句"));
        assert!(text.contains("```sh\nnpm test\n```"));
        assert!(text.contains("![](images/1.jpg)"), "{text}");
        assert!(text.contains("---"));
        assert_eq!(post.images, vec!["https://pbs.twimg.com/media/a.jpg".to_string()]);
    }

    #[test]
    fn an_ordinary_tweet_keeps_its_text_and_photos() {
        let json = r#"{
          "code": 200,
          "tweet": {
            "url": "https://x.com/demo/status/1",
            "text": "一句话说清楚这件事",
            "created_at": "2026-10-01T00:00:00.000Z",
            "author": {"screen_name": "demo", "name": "演示"},
            "media": {"photos": [{"url": "https://pbs.twimg.com/media/p.jpg"}]}
          }
        }"#;
        let post = parse(json).unwrap();
        assert!(!post.is_article);
        assert_eq!(post.title, "一句话说清楚这件事");
        assert_eq!(post.images.len(), 1);
        let text = document(&post, &|index| format!("images/{index}.jpg"));
        assert!(text.contains("一句话说清楚这件事"));
        assert!(text.contains("![](images/0.jpg)"));
    }

    #[test]
    fn offsets_are_counted_in_utf16_so_emoji_do_not_shift_the_bold() {
        // 表情是代理对：按字符数算会把加粗整体右移一位。
        let json = r#"{
          "code": 200,
          "tweet": {"text": "x", "author": {"screen_name": "demo"},
            "article": {"title": "t", "content": {"blocks": [
              {"type": "unstyled", "text": "😀重点", "inlineStyleRanges": [{"offset": 2, "length": 2, "style": "Bold"}], "entityRanges": []}
            ], "entityMap": []}}}
        }"#;
        let post = parse(json).unwrap();
        let text = document(&post, &|_| String::new());
        assert!(text.contains("😀**重点**"), "{text}");
    }

    #[test]
    fn a_deleted_post_is_reported_plainly() {
        let error = parse(r#"{"code": 404, "message": "Not found"}"#).unwrap_err();
        assert!(error.contains("不存在"), "{error}");
    }

    #[test]
    fn the_date_comes_out_as_iso_not_as_weekday_month() {
        // 镜像服务的 created_at 是 C 语言那种格式，只有时间戳可靠。
        let json = r#"{"code": 200, "tweet": {"text": "x", "created_timestamp": 1792289778,
            "created_at": "Sun Oct 18 02:16:18 +0000 2026", "author": {"screen_name": "demo"}}}"#;
        assert_eq!(parse(json).unwrap().date, "2026-10-18");
        // 没有时间戳时，已经像 ISO 日期的照用。
        let json = r#"{"code": 200, "tweet": {"text": "x", "created_at": "2026-10-18T02:16:18.000Z",
            "author": {"screen_name": "demo"}}}"#;
        assert_eq!(parse(json).unwrap().date, "2026-10-18");
        // 什么都不能用时宁可不写，也不要写「Sun Oct 18」。
        let json = r#"{"code": 200, "tweet": {"text": "x", "created_at": "Sun Oct 18 02:16:18 +0000 2026",
            "author": {"screen_name": "demo"}}}"#;
        assert_eq!(parse(json).unwrap().date, "");
    }

    #[test]
    fn pictures_that_failed_to_download_keep_their_remote_address() {
        let post = parse(&article_json()).unwrap();
        let text = document(&post, &|_| "https://pbs.twimg.com/media/a.jpg".into());
        assert!(text.contains("](https://pbs.twimg.com/media/a.jpg)"));
    }
}
