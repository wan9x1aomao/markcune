//! Opening a document straight from a link.
//!
//! The user pastes a URL; we download it and drop it under the library folder (`~/Documents/MDPad/`)
//! so the sidebar lists the whole book.
//!
//! A repository link is fetched as a zip archive rather than file by file: a book's chapters link to
//! each other by relative paths, so only the archive keeps that structure. A single document still
//! has its own images — relative, absolute, and lazy-loaded — downloaded beside it.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use percent_encoding::percent_decode_str;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::files::{atomic_write, is_document};
use crate::tweet;

/// Caps so a hostile or careless link cannot eat the machine's memory or disk.
const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_UNPACKED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ENTRIES: usize = 20_000;
const TIMEOUT: Duration = Duration::from_secs(180);
/// 一篇文章里的单张图 / 全部图。原图动辄几 MB，单独设上限，免得一张图就把整次下载拖垮。
const MAX_IMAGE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_IMAGES_TOTAL: u64 = 96 * 1024 * 1024;

/// What a pasted link points at.
#[derive(Debug, PartialEq)]
pub enum Target {
    /// One document, already converted into an address we can fetch directly.
    File { url: String, folder: String, path: PathBuf },
    /// A whole repository, which arrives as a zip archive.
    Repo { owner: String, repo: String, branch: Option<String> },
    /// One post on X. The page itself is JavaScript-rendered and the long-form body sits behind a
    /// login, so this one is fetched through a mirror service and converted to Markdown locally.
    Post { handle: String, id: String },
}


// ---------------------------------------------------------------------------------------------
// Reading the link
// ---------------------------------------------------------------------------------------------

/// Turns what the user pasted into something we know how to fetch.
///
/// The case that matters most: a link copied out of the browser is `github.com/…/blob/…`, which
/// serves an HTML page, not the file. It has to be rewritten to `raw.githubusercontent.com`,
/// otherwise the app would happily download a web page and call it a document.
pub fn classify(input: &str) -> Result<Target, String> {
    let text = input.trim();
    if text.is_empty() {
        return Err("请先粘贴一个链接".into());
    }
    let url = reqwest::Url::parse(text).map_err(|_| "这不是一个有效的链接".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("只支持 http 和 https 链接".into());
    }

    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let segments: Vec<String> = url
        .path_segments()
        .map(|parts| parts.filter(|part| !part.is_empty()).map(str::to_string).collect())
        .unwrap_or_default();

    match host.as_str() {
        "github.com" | "www.github.com" => classify_github(&segments),
        "raw.githubusercontent.com" => {
            // owner / repo / ref / path…
            if segments.len() < 4 {
                return Err("这个链接没有指向具体的文件".into());
            }
            let path = relative_path(&segments[3..])?;
            Ok(Target::File {
                url: raw_url(&segments[0], &segments[1], &segments[2], &segments[3..]),
                folder: segments[1].clone(),
                path,
            })
        }
        _ if host.ends_with(".github.io") => classify_pages(&host, &segments),
        // X（Twitter）：`<user>/status/<id>`。普通推文和「长文」都是这一个形状，
        // 差别只在镜像服务返回的 JSON 里有没有 article。
        "x.com" | "www.x.com" | "mobile.x.com" | "twitter.com" | "www.twitter.com" | "mobile.twitter.com" => {
            classify_post(&segments)
        }

        _ => {
            // Any other host: treat it as a direct link to a file.
            let last = segments.last().ok_or("这个链接没有指向具体的文件")?;
            let name = safe_name(last)?;
            Ok(Target::File { url: url.to_string(), folder: host.clone(), path: PathBuf::from(name) })
        }
    }
}

/// GitHub Pages sites: `<user>.github.io/<repo>/` is just the published form of `<user>/<repo>`.
///
/// Reading the site itself would mean scraping HTML — the repository holds the real Markdown, so
/// map the address back to it. A Pages site with no path segment is the user site, whose
/// repository is named after the host (`<user>/<user>.github.io`).
fn classify_pages(host: &str, segments: &[String]) -> Result<Target, String> {
    let owner = &host[..host.len() - ".github.io".len()];
    if !valid_name(owner) {
        return Err("这个 GitHub Pages 链接里的账号名不合法".into());
    }
    let repo = segments.first().cloned().unwrap_or_else(|| host.to_string());
    if !valid_name(&repo) {
        return Err("链接里的仓库名不合法".into());
    }
    Ok(Target::Repo { owner: owner.to_string(), repo, branch: None })
}

/// X 的帖子地址：`<user>/status/<id>`，以及不带用户名的 `i/status/<id>`、`i/web/status/<id>`。
///
/// 长文（`i/article/<id>`）也出现在分享链接里，但它只能从帖子地址取到，所以这里明确指路，
/// 而不是让它掉进「其他域名当直链文件」那条路，最后报「返回的是网页」。
fn classify_post(segments: &[String]) -> Result<Target, String> {
    let parts: Vec<&str> = segments.iter().map(String::as_str).collect();
    let (handle, id) = match parts.as_slice() {
        [handle, "status", id, ..] => (*handle, *id),
        ["i", "web", "status", id, ..] => ("i", *id),
        ["i", "article", ..] => {
            return Err("这是 X 长文的地址，只能通过带 /status/ 的帖子链接打开——在帖子上点「分享 → 复制链接」".into())
        }
        _ => return Err("这个 X 链接不是一条帖子，请用「分享 → 复制链接」得到的地址".into()),
    };
    if !valid_handle(handle) {
        return Err("链接里的用户名不合法".into());
    }
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
        return Err("链接里没有帖子编号".into());
    }
    Ok(Target::Post { handle: handle.to_string(), id: id.to_string() })
}

/// X 的用户名：字母数字加下划线，最长 15；`i` 是「不带用户名的地址」用的占位。
fn valid_handle(handle: &str) -> bool {
    !handle.is_empty()
        && handle.len() <= 15
        && handle.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn classify_github(segments: &[String]) -> Result<Target, String> {
    if segments.len() < 2 {
        return Err("这个 GitHub 链接不完整，需要 owner/repo 两段".into());
    }
    let (owner, repo) = (segments[0].as_str(), segments[1].as_str());
    if !valid_name(owner) || !valid_name(repo) {
        return Err("链接里的仓库名不合法".into());
    }

    match segments.get(2).map(String::as_str) {
        // github.com/owner/repo/blob/ref/路径 —— 浏览器里复制到的就是这一种
        Some("blob") | Some("raw") => {
            if segments.len() < 5 {
                return Err("这个链接没有指向具体的文件".into());
            }
            let reference = &segments[3];
            let path = relative_path(&segments[4..])?;
            Ok(Target::File {
                url: raw_url(owner, repo, reference, &segments[4..]),
                folder: repo.to_string(),
                path,
            })
        }
        // github.com/owner/repo/tree/ref —— 整本
        Some("tree") => Ok(Target::Repo {
            owner: owner.to_string(),
            repo: repo.to_string(),
            branch: segments.get(3).filter(|branch| !branch.is_empty()).cloned(),
        }),
        // github.com/owner/repo —— 仓库首页，就是整本
        None => Ok(Target::Repo { owner: owner.to_string(), repo: repo.to_string(), branch: None }),
        Some(other) => Err(format!("还不支持 GitHub 的「{other}」页面，请用仓库首页或单个文件的链接")),
    }
}

fn raw_url(owner: &str, repo: &str, reference: &str, path: &[String]) -> String {
    format!("https://raw.githubusercontent.com/{owner}/{repo}/{reference}/{}", path.join("/"))
}

/// Turns the tail of a URL into a relative path, refusing anything that is not a plain name.
fn relative_path(segments: &[String]) -> Result<PathBuf, String> {
    if segments.is_empty() {
        return Err("这个链接没有指向具体的文件".into());
    }
    let mut path = PathBuf::new();
    for segment in segments {
        path.push(safe_name(segment)?);
    }
    Ok(path)
}

/// Device names Windows keeps for itself — a file called `con.md` cannot be created there at all.
const RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Whether one name can be written to disk on the given platform.
///
/// Windows is the strict one, and the difference is not academic: `: " < > | ? *` cannot appear in
/// a file name there at all, a trailing dot or space is dropped without a word (leaving a file whose
/// name is not the one the archive asked for), and [`RESERVED_NAMES`] are devices. Linux and macOS
/// accept most of that, which is why the platform is an argument instead of a `cfg!` — the rule has
/// to be provable from whichever platform the tests happen to run on.
///
/// The 255-byte ceiling applies to all three: ext4 and APFS count bytes, NTFS counts UTF-16 units,
/// and none of them takes more than 255.
fn name_fits(name: &str, windows: bool) -> bool {
    if name.is_empty() || name.len() > 255 {
        return false;
    }
    if !windows {
        return true;
    }
    if name.ends_with('.') || name.ends_with(' ') || name.chars().any(char::is_control) {
        return false;
    }
    if name.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')) {
        return false;
    }
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    !RESERVED_NAMES.contains(&stem.as_str())
}

/// Whether every part of a relative path can be written on the given platform.
///
/// Every part, not just the last one: a chapter sitting inside a folder called `Day 3: 复习/` is
/// just as unsavable as that folder itself.
fn savable(path: &Path, windows: bool) -> bool {
    let mut parts = 0usize;
    for part in path.components() {
        let std::path::Component::Normal(name) = part else { return false };
        if !name.to_str().is_some_and(|text| name_fits(text, windows)) {
            return false;
        }
        parts += 1;
    }
    parts > 0
}

/// Accepts one path segment: no separators, not `.` or `..`, usable as a file name on every platform.
fn safe_name(segment: &str) -> Result<String, String> {
    let decoded = percent_decode_str(segment).decode_utf8().map_err(|_| "链接里有无法识别的内容")?;
    let name = decoded.trim();
    if name.is_empty() || name == "." || name == ".." {
        return Err("链接里有不正常的文件名".into());
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err("链接里有不正常的文件名".into());
    }
    if name.chars().count() > 120 {
        return Err("链接里的文件名太长了".into());
    }
    // `true` on purpose: a link has to work on every platform we ship, not only this one.
    if !name_fits(name, true) {
        return Err("链接里的文件名不能用来保存".into());
    }
    Ok(name.to_string())
}

/// Stricter than [`safe_name`]: what GitHub itself allows in an owner or repository name.
fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && !value.starts_with('.')
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

// ---------------------------------------------------------------------------------------------
// Downloading
// ---------------------------------------------------------------------------------------------

/// A failed download, kept structured so we can tell "wrong branch" from a real problem.
enum Failure {
    NotFound(String),
    Message(String),
}

impl Failure {
    fn message(self) -> String {
        match self {
            Failure::NotFound(text) | Failure::Message(text) => text,
        }
    }

    fn is_not_found(&self) -> bool {
        matches!(self, Failure::NotFound(_))
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        // GitHub's API answers 403 to a request without one.
        .user_agent(format!("MarkCune/{}", env!("CARGO_PKG_VERSION")))
        .timeout(TIMEOUT)
        .build()
        .map_err(|error| format!("无法准备网络请求：{error}"))
}

struct Download {
    bytes: Vec<u8>,
    content_type: String,
}

/// Downloads a URL, stopping as soon as it grows past `limit`.
///
/// The cap has to be enforced while the bytes arrive, not before: GitHub's archive endpoint does
/// not send a Content-Length, so "check the size first" is not an option there.
async fn download(client: &reqwest::Client, url: &str, limit: u64) -> Result<Vec<u8>, Failure> {
    Ok(download_limited(client, url, limit).await?.bytes)
}

async fn download_limited(
    client: &reqwest::Client,
    url: &str,
    limit: u64,
) -> Result<Download, Failure> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|error| Failure::Message(friendly(&error)))?;
    let status = response.status();
    if !status.is_success() {
        let text = match status.as_u16() {
            404 => "这个链接指向的内容不存在（404）".to_string(),
            401 | 403 => "对方拒绝了这次请求，可能是访问太频繁，稍后再试".to_string(),
            429 => "请求太频繁了，稍后再试".to_string(),
            code => format!("下载失败：HTTP {code}"),
        };
        return Err(if status.as_u16() == 404 {
            Failure::NotFound(text)
        } else {
            Failure::Message(text)
        });
    }
    if let Some(total) = response.content_length() {
        if total > limit {
            return Err(Failure::Message(format!(
                "内容有 {}，超过 {} 的上限",
                size(total),
                size(limit)
            )));
        }
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();

    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| Failure::Message(friendly(&error)))?
    {
        if body.len() as u64 + chunk.len() as u64 > limit {
            return Err(Failure::Message(format!(
                "内容超过 {} 的上限，已停止下载",
                size(limit)
            )));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Download {
        bytes: body,
        content_type,
    })
}

fn friendly(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "连接超时".into()
    } else if error.is_connect() {
        "连不上这个地址（检查网络或代理）".into()
    } else if error.is_redirect() {
        "这个地址跳转太多次".into()
    } else {
        format!("下载出错：{error}")
    }
}

fn size(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{} KB", bytes / 1024)
    }
}

/// Text of a downloaded document, or a reason it cannot be opened.
fn decode(bytes: &[u8]) -> Result<String, String> {
    // A UTF-8 BOM would otherwise ride along in front of the first heading and break it.
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    let text = std::str::from_utf8(body).map_err(|_| "这个文件不是 UTF-8 编码的文本，暂时打不开".to_string())?;
    // A page returned where a file was expected looks exactly like this. Compare against the
    // trimmed text — leading whitespace is common and must not be enough to slip past.
    let opening = text.trim_start();
    let head = opening.get(..64).unwrap_or(opening).to_ascii_lowercase();
    if head.starts_with("<!doctype html") || head.starts_with("<html") {
        return Err("这个链接返回的是网页而不是文本文件——如果它是 GitHub 上的书，请改用它的仓库地址".into());
    }
    Ok(text.to_string())
}

// ---------------------------------------------------------------------------------------------
// Unpacking a book
// ---------------------------------------------------------------------------------------------

/// What came out of an archive.
#[derive(Debug, Default, PartialEq)]
struct Unpacked {
    /// Files actually written.
    files: usize,
    /// Entries left out because this platform cannot hold their names.
    skipped: usize,
    /// The folder already held a copy of this book, so this download overwrote its files.
    replaced: bool,
}

/// Extracts an archive into `dest`, reporting what landed and what could not.
///
/// Every entry is checked three times: `enclosed_name` refuses absolute paths and `..` that climb
/// out, symbolic links are skipped outright because a link can point somewhere else entirely, and
/// names this platform cannot write are passed over rather than allowed to abort the download.
fn unpack(archive: &[u8], dest: &Path) -> Result<Unpacked, String> {
    unpack_with(archive, dest, cfg!(windows))
}

/// [`unpack`] with the platform stated, so the Windows-only rule stays testable from the others.
fn unpack_with(archive: &[u8], dest: &Path, windows: bool) -> Result<Unpacked, String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive))
        .map_err(|error| format!("下载到的压缩包无法读取：{error}"))?;
    if zip.len() > MAX_ENTRIES {
        return Err("压缩包里的文件太多了，已停止".into());
    }
    // The same book can be downloaded again to pick up upstream changes; that is meant to refresh
    // the folder rather than create `book-2`, but overwriting someone's local edits must not happen
    // quietly — the receipt says so (see `downloadNotice`).
    let replaced = dest
        .read_dir()
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false);
    std::fs::create_dir_all(dest).map_err(|error| format!("无法创建目录：{error}"))?;

    let mut out = Unpacked { replaced, ..Unpacked::default() };
    let mut total = 0u64;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|error| format!("压缩包损坏：{error}"))?;
        let Some(inside) = entry.enclosed_name() else {
            return Err("压缩包里有指向外部的路径，已停止解压".into());
        };
        if is_symlink(entry.unix_mode()) {
            continue;
        }
        // GitHub wraps everything in a single <repo>-<branch>/ folder; drop it.
        let Some(relative) = strip_wrapper(&inside) else { continue };
        // A book is worth more than any single file in it: a repository is free to contain a name
        // this platform cannot write — `Day 3: review.md` is enough on Windows — and failing the
        // whole download over it would cost the reader the other three hundred chapters.
        if !savable(&relative, windows) {
            out.skipped += 1;
            continue;
        }
        let target = dest.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&target).map_err(|error| format!("无法创建目录：{error}"))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| format!("无法创建目录：{error}"))?;
        }
        total += entry.size();
        if total > MAX_UNPACKED_BYTES {
            return Err("这本书解压后太大了，已停止".into());
        }
        // The declared size comes from the archive itself, so never trust it for the allocation.
        let mut content = Vec::with_capacity(entry.size().min(1 << 20) as usize);
        entry.read_to_end(&mut content).map_err(|error| format!("解压出错：{error}"))?;
        std::fs::write(&target, &content).map_err(|error| format!("无法写入文件：{error}"))?;
        out.files += 1;
    }
    Ok(out)
}

/// The name a downloaded single document lands under: a link without an extension gets `.md`,
/// because the library should only contain files the app can open again.
fn document_name(path: PathBuf) -> PathBuf {
    if crate::files::is_document(&path) {
        path
    } else {
        path.with_extension("md")
    }
}

fn strip_wrapper(path: &Path) -> Option<PathBuf> {
    let mut parts = path.components();
    parts.next()?;
    let rest: PathBuf = parts.collect();
    (!rest.as_os_str().is_empty()).then_some(rest)
}

fn is_symlink(mode: Option<u32>) -> bool {
    // S_IFLNK
    mode.is_some_and(|bits| bits & 0o170000 == 0o120000)
}

/// The file to open once a book is on disk.
fn pick_entry(dir: &Path) -> Option<PathBuf> {
    const PREFERRED: [&str; 8] = [
        "README.md",
        "readme.md",
        "Readme.md",
        "README.markdown",
        "SUMMARY.md",
        "summary.md",
        "index.md",
        "README.txt",
    ];
    for name in PREFERRED {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_document(path))
        .collect();
    found.sort();
    found.into_iter().next()
}

// ---------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fetched {
    /// The document to open.
    path: PathBuf,
    /// The book's folder, so the sidebar can be pointed at it.
    root: PathBuf,
    /// `"file"` or `"book"` — the page words its confirmation differently.
    kind: &'static str,
    /// What to call this in the message.
    title: String,
    /// How many files came with it (1 for a single document).
    files: usize,
    /// Files the book contained whose names this platform cannot hold, so they were left out.
    skipped: usize,
    /// Same book downloaded before: the folder was refreshed in place.
    replaced: bool,
}

/// Where downloaded books live. `MDPAD_LIBRARY_DIR` overrides it, following `MDPAD_DATA_DIR`.
fn library_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("MDPAD_LIBRARY_DIR") {
        return Ok(PathBuf::from(dir));
    }
    // 书库沿用旧目录（老用户下载的书都在这里，改了会找不到书），本次不迁移。
    app.path()
        .document_dir()
        .map(|dir| dir.join("MDPad"))
        .or_else(|_| app.path().home_dir().map(|home| home.join("Documents").join("MDPad")))
        // 共享临时目录谁都能预建、也能换成符号链接（多用户机器上就是把书库交出去），
        // 所以最后退的是用户自己的应用数据目录，和 main.rs 里设置/草稿的落点保持一致。
        .or_else(|_| app.path().app_data_dir().map(|dir| dir.join("MDPad")))
        .or_else(|_| app.path().home_dir().map(|home| home.join(".mdpad").join("library")))
        .map_err(|_| "找不到可以存放书库的位置".to_string())
}

#[tauri::command]
pub async fn open_from_url(app: AppHandle, url: String) -> Result<Fetched, String> {
    let target = classify(&url)?;
    let client = client()?;
    let library = library_dir(&app)?;

    match target {
        Target::File { url, folder, path } => {
            let bytes = download(&client, &url, MAX_FILE_BYTES).await.map_err(Failure::message)?;
            let text = decode(&bytes)?;
            if text.trim().is_empty() {
                return Err("这个文件是空的".into());
            }
            let root = library.join(safe_name(&folder)?);
            // 链接末尾可能没有扩展名（`https://example.com/readme`）。书库里的文件必须能再次打开，
            // 而 read_document 只认文档类型，所以这里就把名字补成 .md。
            let path = document_name(path);
            let dest = root.join(&path);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|error| format!("无法创建目录：{error}"))?;
            }
            // 单篇 Markdown 里的图（相对路径、绝对地址、懒加载）落到文档旁边，引用改写成本地路径。
            let (text, failed) = localize_images(&client, &text, &url, dest.parent().unwrap_or(&root), true, &[]).await;
            atomic_write(&dest, text.as_bytes())?;
            let title = dest.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
            Ok(Fetched { path: dest, root, kind: "file", title, files: 1, skipped: failed, replaced: false })
        }
        Target::Repo { owner, repo, branch } => {
            let archive = fetch_archive(&client, &owner, &repo, branch.as_deref())
                .await
                .map_err(Failure::message)?;
            let root = library.join(safe_name(&repo)?);
            let unpacked = unpack(&archive, &root)?;
            let files = unpacked.files;
            let entry = pick_entry(&root)
                .ok_or_else(|| format!("这本书里没有找到能打开的 Markdown 文件（已解压 {files} 个文件）"))?;
            Ok(Fetched {
                path: entry,
                root,
                kind: "book",
                title: repo,
                files,
                skipped: unpacked.skipped,
                replaced: unpacked.replaced,
            })
        }
        Target::Post { handle, id } => post_to_library(&client, &library, &handle, &id).await,
    }
}

/// 一条帖子落到书库：`<书库>/x.com/<用户名>-<帖子号>/`，图片进同级的 `images/`。
async fn post_to_library(
    client: &reqwest::Client,
    library: &Path,
    handle: &str,
    id: &str,
) -> Result<Fetched, String> {
    let post = fetch_post(client, handle, id).await?;
    let root = library.join("x.com").join(safe_name(&format!("{handle}-{id}"))?);
    std::fs::create_dir_all(&root).map_err(|error| format!("无法创建目录：{error}"))?;
    let images_dir = root.join("images");
    let (saved, failed) = save_images(client, &post.images, &images_dir).await;
    let text = tweet::document(&post, &|index| match saved.get(index).and_then(Option::as_ref) {
        Some(name) => format!("images/{name}"),
        // 图没下下来就把远程地址留着：能上外网的人照样看得见，正文也不会因此失败。
        None => post.images.get(index).cloned().unwrap_or_default(),
    });
    // 正文里另写的图片（Markdown / HTML，含 srcset、data-src）不在媒体表里，这里补下。
    // 媒体表里已经试过的地址不再试第二遍，失败张数也不会算两次。
    let (text, extra_failed) = localize_images(client, &text, &post.url, &root, false, &post.images).await;
    let dest = root.join(post_file_name(&post.title, id));
    atomic_write(&dest, text.as_bytes())?;
    Ok(Fetched { path: dest, root, kind: "tweet", title: post.title, files: 1, skipped: failed + extra_failed, replaced: false })
}

/// 向镜像服务要一条帖子，并转成 Markdown。
async fn fetch_post(client: &reqwest::Client, handle: &str, id: &str) -> Result<tweet::Post, String> {
    let url = format!("https://api.fxtwitter.com/{handle}/status/{id}");
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|error| format!("{}——X 的内容要走境外网络，请确认这台机器能访问外网", friendly(&error)))?;
    let status = response.status();
    let body = response.text().await.map_err(|error| format!("读取帖子内容失败：{error}"))?;
    if !status.is_success() {
        return Err(match status.as_u16() {
            404 => "这条帖子不存在，可能已被删除，或者账号是受保护的".to_string(),
            401 | 403 => "这条帖子需要登录才能看，镜像服务拿不到".to_string(),
            429 => "镜像服务被请求得太频繁，过一会儿再试".to_string(),
            code => format!("镜像服务返回 HTTP {code}"),
        });
    }
    tweet::parse(&body)
}

/// 逐张下载正文里的图片，返回（成功落盘的文件名, 失败的张数）。
async fn save_images(
    client: &reqwest::Client,
    urls: &[String],
    dir: &Path,
) -> (Vec<Option<String>>, usize) {
    let mut saved: Vec<Option<String>> = vec![None; urls.len()];
    let mut failed = 0usize;
    let mut total = 0u64;
    for (index, url) in urls.iter().enumerate() {
        if total >= MAX_IMAGES_TOTAL {
            failed += 1;
            continue;
        }
        match download_limited(client, url, MAX_IMAGE_BYTES).await {
            Ok(payload) if !payload.bytes.is_empty() => {
                // 网页或空响应当成没下到，别存成一张打不开的 .jpg。
                let Some(ext) = image_ext_of(&payload.bytes, &payload.content_type) else {
                    failed += 1;
                    continue;
                };
                total += payload.bytes.len() as u64;
                if std::fs::create_dir_all(dir).is_err() {
                    failed += 1;
                    continue;
                }
                let name = format!("{}{}", index + 1, ext);
                match atomic_write(&dir.join(&name), &payload.bytes) {
                    Ok(()) => saved[index] = Some(name),
                    Err(_) => failed += 1,
                }
            }
            _ => failed += 1,
        }
    }
    (saved, failed)
}

/// 一篇文档里最多跟着下多少张图。再多就留下原来的地址，避免一个页面把磁盘写满。
const MAX_LOCAL_IMAGES: usize = 80;

/// 正文里另写的图片（相对路径、绝对地址、`srcset`、懒加载 `data-src`）落到 `assets/`，
/// 引用改成相对路径。`skip` 里的地址已经试过（比如帖子的媒体表），不再下第二次。
///
/// 返回改写后的正文，以及没能保存的张数。失败的引用保持原样。
async fn localize_images(
    client: &reqwest::Client,
    text: &str,
    base: &str,
    dir: &Path,
    allow_relative: bool,
    skip: &[String],
) -> (String, usize) {
    let images = collect_remote_images(text, base, allow_relative);
    if images.is_empty() {
        return (text.to_string(), 0);
    }
    let mut paths: HashMap<String, String> = HashMap::new();
    let mut attempted: HashSet<String> = HashSet::new();
    let mut failed = 0usize;
    let mut total = 0u64;
    let mut saved = 0usize;
    let assets = dir.join("assets");
    for image in &images {
        if skip.iter().any(|seen| same_url(seen, &image.resolved)) {
            continue;
        }
        if !attempted.insert(image.resolved.clone()) {
            continue;
        }
        if saved >= MAX_LOCAL_IMAGES || total >= MAX_IMAGES_TOTAL {
            failed += 1;
            continue;
        }
        match download_limited(client, &image.resolved, MAX_IMAGE_BYTES).await {
            Ok(payload) if !payload.bytes.is_empty() => {
                let Some(ext) = image_ext_of(&payload.bytes, &payload.content_type) else {
                    failed += 1;
                    continue;
                };
                if total + payload.bytes.len() as u64 > MAX_IMAGES_TOTAL {
                    failed += 1;
                    continue;
                }
                total += payload.bytes.len() as u64;
                if std::fs::create_dir_all(&assets).is_err() {
                    failed += 1;
                    continue;
                }
                let name = format!("{}{ext}", saved + 1);
                if atomic_write(&assets.join(&name), &payload.bytes).is_err() {
                    failed += 1;
                    continue;
                }
                saved += 1;
                paths.insert(image.resolved.clone(), format!("assets/{name}"));
            }
            _ => failed += 1,
        }
    }
    (apply_local_paths(text, &images, &paths), failed)
}

fn same_url(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    match (reqwest::Url::parse(a), reqwest::Url::parse(b)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

struct RemoteImage {
    start: usize,
    end: usize,
    /// `Some`：整段 `<img>` 换成 Markdown 图片；`None`：只替换 URL 那一段。
    alt: Option<String>,
    resolved: String,
}

fn collect_remote_images(text: &str, base: &str, allow_relative: bool) -> Vec<RemoteImage> {
    let fences = fenced_spans(text);
    let mut out = Vec::new();
    let mut from = 0usize;
    while from < text.len() {
        let markdown = find_markdown_image(text, from);
        let html = find_html_image(text, from);
        let markdown_at = markdown.as_ref().map(|image| image.0);
        let html_at = html.as_ref().map(|image| image.0);
        let html_first = match (markdown_at, html_at) {
            (Some(md), Some(tag)) => tag < md,
            (None, Some(_)) => true,
            _ => false,
        };
        if html_first {
            let (start, end, url, alt) = html.unwrap();
            if inside(&fences, start) {
                from = fence_end(&fences, start).unwrap_or(end);
                continue;
            }
            if let Some(resolved) = resolve_image_url(base, &url, allow_relative) {
                out.push(RemoteImage {
                    start,
                    end,
                    alt: Some(alt),
                    resolved,
                });
            }
            from = end;
            continue;
        }
        let Some((bang, url_start, url_end, url)) = markdown else {
            break;
        };
        if inside(&fences, bang) {
            from = fence_end(&fences, bang).unwrap_or(bang + 2);
            continue;
        }
        if let Some(resolved) = resolve_image_url(base, &url, allow_relative) {
            out.push(RemoteImage {
                start: url_start,
                end: url_end,
                alt: None,
                resolved,
            });
        }
        from = url_end.max(bang + 2);
    }
    out
}

fn apply_local_paths(
    text: &str,
    images: &[RemoteImage],
    paths: &HashMap<String, String>,
) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    for image in images {
        let Some(local) = paths.get(&image.resolved) else {
            continue;
        };
        if image.start < cursor || image.end > text.len() || image.start > image.end {
            continue;
        }
        out.push_str(&text[cursor..image.start]);
        match &image.alt {
            Some(alt) => {
                out.push_str("![");
                out.push_str(&alt_for_md(alt));
                out.push_str("](");
                out.push_str(local);
                out.push(')');
            }
            None => out.push_str(local),
        }
        cursor = image.end;
    }
    out.push_str(&text[cursor..]);
    out
}

fn alt_for_md(alt: &str) -> String {
    alt.replace(['[', ']', '\n', '\r'], " ")
}

/// 把图片地址解析成可下载的 http(s) 链接。
///
/// `allow_relative` 为假时只收绝对地址（帖子正文里的 `images/1.jpg` 已经在本地，不能再拿帖子页面当基准去请求）。
fn resolve_image_url(base: &str, raw: &str, allow_relative: bool) -> Option<String> {
    let raw = decode_basic_entities(raw).trim().to_string();
    if raw.is_empty()
        || raw.starts_with('#')
        || raw.starts_with("data:")
        || raw.starts_with("blob:")
        || raw.starts_with("javascript:")
    {
        return None;
    }
    let bytes = raw.as_bytes();
    if bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && !raw.starts_with("http")
    {
        return None;
    }
    let absolute =
        raw.starts_with("http://") || raw.starts_with("https://") || raw.starts_with("//");
    if !absolute && !allow_relative {
        return None;
    }
    let encoded = raw.replace(' ', "%20");
    if encoded.starts_with("http://") || encoded.starts_with("https://") {
        let url = reqwest::Url::parse(&encoded).ok()?;
        return matches!(url.scheme(), "http" | "https").then(|| url.to_string());
    }
    if encoded.starts_with("//") {
        let scheme = reqwest::Url::parse(base)
            .ok()
            .map(|url| url.scheme().to_string())
            .unwrap_or_else(|| "https".into());
        let url = reqwest::Url::parse(&format!("{scheme}:{encoded}")).ok()?;
        return matches!(url.scheme(), "http" | "https").then(|| url.to_string());
    }
    let base = reqwest::Url::parse(base).ok()?;
    let joined = base.join(&encoded).ok()?;
    matches!(joined.scheme(), "http" | "https").then(|| joined.to_string())
}

fn decode_basic_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

/// `(图片语法起点, URL 起点, URL 终点, URL)`。终点不含右括号。
fn find_markdown_image(text: &str, from: usize) -> Option<(usize, usize, usize, String)> {
    let slice = text.get(from..)?;
    let mut local_from = 0usize;
    while let Some(i) = slice[local_from..].find("![") {
        let start = from + local_from + i;
        let Some(bracket) = text[start..].find("](") else {
            local_from += i + 2;
            continue;
        };
        let url_start = start + bracket + 2;
        if text[start..url_start].contains("\n\n") {
            local_from += i + 2;
            continue;
        }
        let tail = &text[url_start..];
        if let Some(inner) = tail.strip_prefix('<') {
            let Some(end) = inner.find('>') else {
                local_from += i + 2;
                continue;
            };
            let url_begin = url_start + 1;
            let url_end = url_begin + end;
            return Some((
                start,
                url_begin,
                url_end,
                text[url_begin..url_end].to_string(),
            ));
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
        let url_end = url_start + end;
        return Some((
            start,
            url_start,
            url_end,
            text[url_start..url_end].to_string(),
        ));
    }
    None
}

/// `(标签起点, 标签终点, 选中的 URL, alt)`。懒加载优先用 `data-src`，否则 `src`，再否则 `srcset` 里最大的那张。
fn find_html_image(text: &str, from: usize) -> Option<(usize, usize, String, String)> {
    let bytes = text.as_bytes();
    let mut i = from;
    while i + 4 <= bytes.len() {
        if text.is_char_boundary(i)
            && bytes[i] == b'<'
            && bytes[i + 1].eq_ignore_ascii_case(&b'i')
            && bytes[i + 2].eq_ignore_ascii_case(&b'm')
            && bytes[i + 3].eq_ignore_ascii_case(&b'g')
        {
            let next = bytes.get(i + 4).copied().unwrap_or(b' ');
            if next.is_ascii_whitespace() || next == b'/' || next == b'>' {
                let tag_start = i;
                let Some(rel) = text[tag_start..].find('>') else {
                    return None;
                };
                let tag_end = tag_start + rel + 1;
                let tag = &text[tag_start..tag_end];
                if let Some(url) = chosen_img_url(tag) {
                    let alt = attr_value(tag, "alt").unwrap_or("").to_string();
                    return Some((tag_start, tag_end, url, alt));
                }
                i = tag_end;
                continue;
            }
        }
        i += 1;
    }
    None
}

fn chosen_img_url(tag: &str) -> Option<String> {
    let data_src = ["data-src", "data-original", "data-lazy-src"]
        .into_iter()
        .find_map(|name| attr_value(tag, name))
        .map(decode_basic_entities);
    let src = attr_value(tag, "src").map(decode_basic_entities);
    let srcset = attr_value(tag, "srcset")
        .or_else(|| attr_value(tag, "data-srcset"))
        .and_then(|value| best_srcset(&decode_basic_entities(value)));
    if let Some(url) = data_src
        .as_deref()
        .map(str::trim)
        .filter(|url| usable_url(url))
    {
        return Some(url.to_string());
    }
    if let Some(url) = src.as_deref().map(str::trim).filter(|url| usable_url(url)) {
        return Some(url.to_string());
    }
    srcset
        .filter(|url| usable_url(url.trim()))
        .map(|url| url.trim().to_string())
}

fn usable_url(url: &str) -> bool {
    let url = url.trim();
    !url.is_empty()
        && !url.starts_with("data:")
        && !url.starts_with("blob:")
        && !url.starts_with("javascript:")
}

fn best_srcset(value: &str) -> Option<String> {
    let mut best: Option<(f64, String)> = None;
    for part in value.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let mut bits = part.split_whitespace();
        let Some(url) = bits.next() else { continue };
        if !usable_url(url) {
            continue;
        }
        let score = bits.next().map(descriptor_score).unwrap_or(0.0);
        let replace = best
            .as_ref()
            .map(|(current, _)| score >= *current)
            .unwrap_or(true);
        if replace {
            best = Some((score, url.to_string()));
        }
    }
    best.map(|(_, url)| url)
}

fn descriptor_score(token: &str) -> f64 {
    let token = token.trim();
    if let Some(number) = token.strip_suffix("w").or_else(|| token.strip_suffix("W")) {
        return number.parse::<f64>().unwrap_or(0.0);
    }
    if let Some(number) = token.strip_suffix("x").or_else(|| token.strip_suffix("X")) {
        return number.parse::<f64>().unwrap_or(0.0) * 10_000.0;
    }
    0.0
}

fn attr_value<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let lower = tag.to_ascii_lowercase();
    let needle = format!("{}=", name.to_ascii_lowercase());
    let hay = lower.as_bytes();
    let needle_bytes = needle.as_bytes();
    let mut from = 0usize;
    while from + needle_bytes.len() <= hay.len() {
        if hay[from..from + needle_bytes.len()].eq_ignore_ascii_case(needle_bytes) {
            let boundary_ok = from == 0 || {
                let prev = hay[from - 1];
                !prev.is_ascii_alphanumeric() && prev != b'-' && prev != b':'
            };
            if boundary_ok {
                return attr_unquote(&tag[from + needle_bytes.len()..]);
            }
        }
        from += 1;
    }
    None
}

fn attr_unquote(tail: &str) -> Option<&str> {
    let bytes = tail.as_bytes();
    if bytes.is_empty() {
        return None;
    }
    let quote = bytes[0];
    if quote == b'"' || quote == b'\'' {
        let rest = &tail[1..];
        let end = rest.find(quote as char)?;
        return Some(&rest[..end]);
    }
    let end = tail
        .find(|c: char| c.is_whitespace() || c == '>')
        .unwrap_or(tail.len());
    Some(&tail[..end])
}

fn fenced_spans(text: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut offset = 0usize;
    let mut open: Option<(usize, &'static str)> = None;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_start();
        let marker = if trimmed.starts_with("```") {
            Some("```")
        } else if trimmed.starts_with("~~~") {
            Some("~~~")
        } else {
            None
        };
        if let Some(marker) = marker {
            if let Some((start, opened)) = open {
                if opened == marker {
                    spans.push((start, offset + line.len()));
                    open = None;
                }
            } else {
                open = Some((offset, marker));
            }
        }
        offset += line.len();
    }
    if let Some((start, _)) = open {
        spans.push((start, text.len()));
    }
    spans
}

fn inside(spans: &[(usize, usize)], index: usize) -> bool {
    spans
        .iter()
        .any(|(start, end)| *start <= index && index < *end)
}

fn fence_end(spans: &[(usize, usize)], index: usize) -> Option<usize> {
    spans
        .iter()
        .find(|(start, end)| *start <= index && index < *end)
        .map(|(_, end)| *end)
}

fn looks_like_html(bytes: &[u8]) -> bool {
    let head = bytes.get(..128).unwrap_or(bytes);
    let text = String::from_utf8_lossy(head);
    let trimmed = text.trim_start().to_ascii_lowercase();
    trimmed.starts_with("<!doctype html") || trimmed.starts_with("<html")
}

fn sniff_image_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(".png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(".jpg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some(".gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(".webp");
    }
    if bytes.starts_with(b"BM") {
        return Some(".bmp");
    }
    let head = bytes.get(..512).unwrap_or(bytes);
    let text = String::from_utf8_lossy(head)
        .trim_start()
        .to_ascii_lowercase();
    if text.starts_with("<svg")
        || (text.contains("<svg") && !text.starts_with("<!doctype") && !text.starts_with("<html"))
    {
        return Some(".svg");
    }
    None
}

fn ext_from_content_type(header: &str) -> Option<&'static str> {
    let mime = header.split(';').next()?.trim().to_ascii_lowercase();
    match mime.as_str() {
        "image/jpeg" | "image/jpg" => Some(".jpg"),
        "image/png" => Some(".png"),
        "image/gif" => Some(".gif"),
        "image/webp" => Some(".webp"),
        "image/svg+xml" => Some(".svg"),
        "image/bmp" | "image/x-ms-bmp" => Some(".bmp"),
        "image/avif" => Some(".avif"),
        "image/x-icon" | "image/vnd.microsoft.icon" => Some(".ico"),
        _ if mime.starts_with("image/") => Some(".jpg"),
        _ => None,
    }
}

/// 魔数优先；`Content-Type` 说是图片但内容是网页时不保存。
fn image_ext_of(bytes: &[u8], content_type: &str) -> Option<&'static str> {
    if looks_like_html(bytes) {
        return None;
    }
    sniff_image_ext(bytes).or_else(|| ext_from_content_type(content_type))
}


/// 帖子存成什么文件名：标题里的 `/:*?"<>|` 三平台都不能留，超长要截断。
fn post_file_name(title: &str, id: &str) -> String {
    let mut name = String::new();
    for ch in title.chars() {
        if name.chars().count() >= 60 {
            break;
        }
        let bad = ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|');
        name.push(if bad { ' ' } else { ch });
    }
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    let name = name.trim_matches(|c: char| c == '.' || c.is_whitespace()).to_string();
    let candidate = format!("{name}.md");
    // Windows 保留名（`con.md` 之类）和超长名都退回到编号。
    if name.is_empty() || !name_fits(&candidate, true) {
        format!("{id}.md")
    } else {
        candidate
    }
}

/// The archive addresses to try, most likely first.
fn archive_urls(owner: &str, repo: &str, branch: Option<&str>) -> Vec<String> {
    let mut urls = vec![match branch {
        Some(branch) => format!("https://codeload.github.com/{owner}/{repo}/zip/refs/heads/{branch}"),
        None => format!("https://codeload.github.com/{owner}/{repo}/zip/HEAD"),
    }];
    for fallback in ["main", "master"] {
        let url = format!("https://codeload.github.com/{owner}/{repo}/zip/refs/heads/{fallback}");
        if !urls.contains(&url) {
            urls.push(url);
        }
    }
    urls
}

/// Fetches the repository archive.
///
/// With no branch named we ask for `zip/HEAD`, which GitHub resolves to the default branch. That
/// deliberately avoids the REST API: anonymous API calls are limited per address and refuse often
/// enough that a feature depending on them would be unreliable. A named branch that turns out to be
/// wrong (and a refused `HEAD`) fall back to the two names almost every repository uses.
async fn fetch_archive(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    branch: Option<&str>,
) -> Result<Vec<u8>, Failure> {
    let urls = archive_urls(owner, repo, branch);
    let last = urls.len() - 1;
    for (index, url) in urls.iter().enumerate() {
        match download(client, url, MAX_ARCHIVE_BYTES).await {
            Ok(body) => return Ok(body),
            // Only a missing branch is worth retrying; anything else is the real answer.
            Err(error) if error.is_not_found() && index < last => continue,
            Err(error) if error.is_not_found() => {
                let wanted = branch.unwrap_or("默认分支");
                return Err(Failure::NotFound(format!("在 {owner}/{repo} 里找不到 {wanted} 的内容")));
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("the candidate list is never empty")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(target: Target) -> (String, String, PathBuf) {
        match target {
            Target::File { url, folder, path } => (url, folder, path),
            other => panic!("expected a single file, got {other:?}"),
        }
    }

    fn repo(target: Target) -> (String, String, Option<String>) {
        match target {
            Target::Repo { owner, repo, branch } => (owner, repo, branch),
            other => panic!("expected a repository, got {other:?}"),
        }
    }

    fn post(target: Target) -> (String, String) {
        match target {
            Target::Post { handle, id } => (handle, id),
            other => panic!("expected a post, got {other:?}"),
        }
    }

    #[test]
    fn an_x_link_is_read_as_a_post() {
        // 带不带 `?s=20`、带不带 `/photo/1`，落到的都是同一条帖子。
        for input in [
            "https://x.com/zureA255062/status/2111642497927798995",
            "https://twitter.com/zureA255062/status/2111642497927798995?s=20",
            "https://mobile.x.com/zureA255062/status/2111642497927798995/photo/1",
            "https://www.x.com/zureA255062/status/2111642497927798995",
        ] {
            assert_eq!(
                post(classify(input).unwrap()),
                ("zureA255062".to_string(), "2111642497927798995".to_string()),
                "{input}"
            );
        }
    }

    #[test]
    fn an_x_link_without_a_user_name_still_lands_on_the_post() {
        assert_eq!(
            post(classify("https://x.com/i/status/2111642497927798995").unwrap()),
            ("i".to_string(), "2111642497927798995".to_string())
        );
        assert_eq!(
            post(classify("https://x.com/i/web/status/2111642497927798995").unwrap()),
            ("i".to_string(), "2111642497927798995".to_string())
        );
    }

    #[test]
    fn an_article_link_says_to_use_the_post_address() {
        // 长文页只能通过帖子地址取到；不指路的话它会落到「当直链文件」那条路，最后报「返回的是网页」。
        let error = classify("https://x.com/i/article/2111636021112881152").unwrap_err();
        assert!(error.contains("/status/"), "{error}");
    }

    #[test]
    fn a_profile_link_is_not_a_post() {
        assert!(classify("https://x.com/zureA255062").is_err());
        assert!(classify("https://x.com/zureA255062/status/not-a-number").is_err());
        assert!(classify("https://x.com/zureA255062/status/").is_err());
    }

    /// 真去请求镜像服务并写到临时目录。默认不跑（要外网、会随帖子变化），手动：
    /// `cargo test a_real_post -- --ignored --nocapture`
    #[test]
    #[ignore = "需要外网，且依赖别人账号的帖子始终存在"]
    fn a_real_post_becomes_a_document() {
        let client = client().unwrap();
        let post = tauri::async_runtime::block_on(fetch_post(&client, "ai_chuhai", "2111864471639498764")).unwrap();
        assert!(!post.title.is_empty());
        assert!(!post.body.trim().is_empty());
        let text = tweet::document(&post, &|index| format!("images/{index}.jpg"));
        println!("{}", text.chars().take(300).collect::<String>());
        assert!(text.starts_with("# "), "{text}");
        assert!(text.contains("2026-10-18"), "{text}");
    }

    /// 整条落盘链路：下载 → 转换 → 写文件 → 图片进 `images/`。
    #[test]
    #[ignore = "需要外网，且依赖别人账号的帖子始终存在"]
    fn a_real_post_lands_in_the_library() {
        let client = client().unwrap();
        let library = std::env::temp_dir().join(format!("mdpad-post-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&library);
        let fetched = tauri::async_runtime::block_on(post_to_library(
            &client,
            &library,
            "zureA255062",
            "2111642497927798995",
        ))
        .unwrap();
        assert_eq!(fetched.kind, "tweet");
        assert!(fetched.path.is_file(), "{:?}", fetched.path);
        let text = std::fs::read_to_string(&fetched.path).unwrap();
        assert!(text.starts_with("# "), "{text}");
        let images = fetched.root.join("images");
        let count = std::fs::read_dir(&images).map(|dir| dir.count()).unwrap_or(0);
        println!("图片 {} 张，失败 {} 张，正文 {} 字", count, fetched.skipped, text.chars().count());
        assert!(count > 0, "这篇文章有图，应该至少落一张");
        // 相对路径能对上磁盘上的文件，MarkCune 打开时才不会显示空图。
        for line in text.lines().filter(|line| line.starts_with("![](")) {
            let path = line.trim_start_matches("![](").trim_end_matches(')');
            assert!(fetched.root.join(path).is_file(), "找不到 {path}");
        }
        let _ = std::fs::remove_dir_all(&library);
    }

    #[test]
    fn a_link_copied_from_the_browser_is_rewritten_to_the_raw_address() {
        // The whole point: this URL serves an HTML page, the raw one serves the file.
        let (url, folder, path) = file(
            classify("https://github.com/rust-lang/book/blob/main/src/ch01-00-getting-started.md").unwrap(),
        );
        assert_eq!(url, "https://raw.githubusercontent.com/rust-lang/book/main/src/ch01-00-getting-started.md");
        assert_eq!(folder, "book");
        assert_eq!(path, PathBuf::from("src/ch01-00-getting-started.md"));
    }

    #[test]
    fn a_repository_link_means_the_whole_book() {
        assert_eq!(
            repo(classify("https://github.com/rust-lang/book").unwrap()),
            ("rust-lang".into(), "book".into(), None)
        );
        assert_eq!(
            repo(classify("https://github.com/rust-lang/book/").unwrap()),
            ("rust-lang".into(), "book".into(), None)
        );
        assert_eq!(
            repo(classify("https://github.com/rust-lang/book/tree/main").unwrap()),
            ("rust-lang".into(), "book".into(), Some("main".into()))
        );
    }

    #[test]
    fn a_raw_link_works_as_it_is() {
        let (url, folder, path) =
            file(classify("https://raw.githubusercontent.com/rust-lang/book/main/README.md").unwrap());
        assert_eq!(url, "https://raw.githubusercontent.com/rust-lang/book/main/README.md");
        assert_eq!(folder, "book");
        assert_eq!(path, PathBuf::from("README.md"));
    }

    #[test]
    fn any_other_host_is_a_direct_file() {
        let (url, folder, path) = file(classify("https://example.com/notes/today.md").unwrap());
        assert_eq!(url, "https://example.com/notes/today.md");
        assert_eq!(folder, "example.com");
        assert_eq!(path, PathBuf::from("today.md"));
    }

    #[test]
    fn a_github_pages_site_is_traced_back_to_its_repository() {
        // The page itself is HTML; only the repository has the Markdown. Every form of the same
        // address has to land on the same place, or one of them silently downloads a web page.
        for input in [
            "https://arthaks.github.io/anthropic-engineering-guide/",
            "https://arthaks.github.io/anthropic-engineering-guide",
            "https://arthaks.github.io/anthropic-engineering-guide/book/03-claude-code.html",
            "https://arthaks.github.io/anthropic-engineering-guide/?from=weibo",
        ] {
            assert_eq!(
                repo(classify(input).unwrap()),
                ("arthaks".into(), "anthropic-engineering-guide".into(), None),
                "{input}"
            );
        }
    }

    #[test]
    fn a_github_pages_user_site_maps_to_the_repository_named_after_the_host() {
        assert_eq!(
            repo(classify("https://arthaks.github.io/").unwrap()),
            ("arthaks".into(), "arthaks.github.io".into(), None)
        );
    }

    #[test]
    fn plain_github_dot_io_is_not_mistaken_for_a_pages_site() {
        // No subdomain means no repository to fall back to, so it stays an ordinary direct file.
        assert!(classify("https://github.io/report.md").is_ok());
    }

    #[test]
    fn percent_escapes_in_the_file_name_are_decoded() {
        let (_, _, path) = file(classify("https://raw.githubusercontent.com/me/notes/main/%E7%AC%94%E8%AE%B0.md").unwrap());
        assert_eq!(path, PathBuf::from("笔记.md"));
    }

    #[test]
    fn a_link_can_never_produce_a_path_outside_the_book_folder() {
        // `url` folds `../` away while parsing — its escaped form included — so the thing worth
        // asserting is the outcome: a plain relative path made only of ordinary names.
        for input in [
            "https://example.com/../../etc/passwd.md",
            "https://example.com/%2e%2e/secret.md",
            "https://example.com/a/%2e%2e/%2e%2e/b.md",
        ] {
            let (_, folder, path) = file(classify(input).unwrap());
            assert_eq!(folder, "example.com");
            assert!(!path.is_absolute(), "{input} produced an absolute path: {path:?}");
            assert!(
                path.components().all(|part| matches!(part, std::path::Component::Normal(_))),
                "{input} produced a path with a root or parent component: {path:?}"
            );
        }
    }

    #[test]
    fn safe_name_only_accepts_a_plain_file_name() {
        for hostile in ["", " ", ".", "..", "a/b", "a\\b", "a\0b"] {
            assert!(safe_name(hostile).is_err(), "{hostile:?} should have been refused");
        }
        // Windows device names cannot be written to disk either.
        for reserved in ["CON", "nul.md", "LPT1.txt"] {
            assert!(safe_name(reserved).is_err(), "{reserved:?} should have been refused");
        }
        assert_eq!(safe_name("笔记.md").unwrap(), "笔记.md");
        assert_eq!(safe_name("%E7%AC%94%E8%AE%B0.md").unwrap(), "笔记.md");
    }

    #[test]
    fn a_link_without_an_extension_still_lands_as_something_openable() {
        assert_eq!(document_name(PathBuf::from("readme")), PathBuf::from("readme.md"));
        assert_eq!(document_name(PathBuf::from("chapter.2")), PathBuf::from("chapter.md"));
        assert_eq!(document_name(PathBuf::from("notes.rst")), PathBuf::from("notes.md"));
        // 已经是文档类型的名字保持原样，别把 README.md 变成 README.md.md。
        assert_eq!(document_name(PathBuf::from("README.md")), PathBuf::from("README.md"));
        assert_eq!(document_name(PathBuf::from("a.txt")), PathBuf::from("a.txt"));
    }

    #[test]
    fn an_escaped_separator_is_refused_because_it_hides_a_traversal() {
        // `%2f` survives URL parsing, so the segment arrives holding a `/` of its own.
        assert!(classify("https://example.com/%2e%2e%2fsecret.md").is_err());
        assert!(classify("https://example.com/a%2Fb.md").is_err());
    }

    #[test]
    fn links_we_cannot_use_are_refused_with_a_reason() {
        assert!(classify("").is_err());
        assert!(classify("   ").is_err());
        assert!(classify("not a link at all").is_err());
        assert!(classify("file:///etc/passwd").is_err());
        assert!(classify("javascript:alert(1)").is_err());
        assert!(classify("https://github.com/rust-lang/book/issues").is_err());
        assert!(classify("https://github.com/rust-lang").is_err());
        assert!(classify("https://example.com/").is_err());
    }

    #[test]
    fn a_browser_page_is_not_mistaken_for_a_document() {
        assert!(decode(b"<!DOCTYPE html>\n<html><body>x</body></html>").is_err());
        assert!(decode(b"  <html lang=\"en\">").is_err());
        assert!(decode(b"{ \"not\": \"markdown\" }").is_ok());
    }

    #[test]
    fn a_byte_order_mark_is_dropped() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("# 标题\n".as_bytes());
        assert_eq!(decode(&bytes).unwrap(), "# 标题\n");
    }

    #[test]
    fn non_utf8_is_reported_rather_than_shown_as_garbage() {
        // "中文" in GBK
        assert!(decode(&[0xD6, 0xD0, 0xCE, 0xC4]).is_err());
    }

    #[test]
    fn the_archive_wrapper_folder_is_removed() {
        assert_eq!(strip_wrapper(Path::new("book-main/src/a.md")), Some(PathBuf::from("src/a.md")));
        assert_eq!(strip_wrapper(Path::new("book-main")), None);
        assert_eq!(strip_wrapper(Path::new("single.md")), None);
    }

    #[test]
    fn the_default_branch_is_requested_without_touching_the_api() {
        let urls = archive_urls("me", "notes", None);
        assert_eq!(urls[0], "https://codeload.github.com/me/notes/zip/HEAD");
        // Fallbacks for when HEAD is refused — and `main` must not be queued twice.
        assert_eq!(urls[1], "https://codeload.github.com/me/notes/zip/refs/heads/main");
        assert_eq!(urls[2], "https://codeload.github.com/me/notes/zip/refs/heads/master");
    }

    #[test]
    fn a_named_branch_is_tried_first_and_not_repeated() {
        let urls = archive_urls("me", "notes", Some("main"));
        assert_eq!(urls[0], "https://codeload.github.com/me/notes/zip/refs/heads/main");
        assert_eq!(urls.len(), 2, "main should not be queued twice: {urls:?}");
        assert_eq!(urls[1], "https://codeload.github.com/me/notes/zip/refs/heads/master");
    }

    #[test]
    fn symbolic_links_are_recognised() {
        assert!(is_symlink(Some(0o120777)));
        assert!(!is_symlink(Some(0o100644)));
        assert!(!is_symlink(None));
    }

    // -----------------------------------------------------------------------------------------
    // Unpacking. This is the part that turns a stranger's archive into files on this machine,
    // so it gets adversarial inputs and not only the happy path.
    // -----------------------------------------------------------------------------------------

    const FILE: u32 = 0o100644;
    const LINK: u32 = 0o120777;

    /// A private scratch folder, so these never touch the real library or each other. Not worth a
    /// `tempfile` dependency for four tests.
    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mdpad-fetch-{}-{label}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Builds a real archive in memory — the guard only runs on real zips, so nothing less will do.
    ///
    /// Entries are appended by hand rather than through `start_file`, which refuses to write the
    /// very names these tests are about (`..`, absolute paths). A hostile archive has to be
    /// assembled from bytes because our own writer will not produce one.
    fn archive(entries: &[(&str, &str, u32)]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut offsets: Vec<usize> = Vec::new();

        for (name, body, _) in entries {
            let name = name.as_bytes();
            let body = body.as_bytes();
            let crc = crc32(body);
            offsets.push(out.len());
            out.extend_from_slice(&0x0403_4b50u32.to_le_bytes()); // local file header
            out.extend_from_slice(&20u16.to_le_bytes()); // version needed
            out.extend_from_slice(&0u16.to_le_bytes()); // flags
            out.extend_from_slice(&0u16.to_le_bytes()); // stored — no compressor involved
            out.extend_from_slice(&0u16.to_le_bytes()); // time
            out.extend_from_slice(&0u16.to_le_bytes()); // date
            out.extend_from_slice(&crc.to_le_bytes());
            out.extend_from_slice(&(body.len() as u32).to_le_bytes());
            out.extend_from_slice(&(body.len() as u32).to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes()); // extra length
            out.extend_from_slice(name);
            out.extend_from_slice(body);
        }

        let directory_at = out.len();
        for ((name, body, mode), offset) in entries.iter().zip(&offsets) {
            let name = name.as_bytes();
            let body = body.as_bytes();
            out.extend_from_slice(&0x0201_4b50u32.to_le_bytes()); // central directory header
            out.extend_from_slice(&0x031e_u16.to_le_bytes()); // made by: unix, so `mode` is read
            out.extend_from_slice(&20u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&crc32(body).to_le_bytes());
            out.extend_from_slice(&(body.len() as u32).to_le_bytes());
            out.extend_from_slice(&(body.len() as u32).to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&(mode << 16).to_le_bytes()); // external attributes
            out.extend_from_slice(&(*offset as u32).to_le_bytes());
            out.extend_from_slice(name);
        }

        let directory_size = out.len() - directory_at;
        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes()); // end of central directory
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(directory_size as u32).to_le_bytes());
        out.extend_from_slice(&(directory_at as u32).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xFFFF_FFFFu32;
        for byte in bytes {
            crc ^= *byte as u32;
            for _ in 0..8 {
                crc = (crc >> 1) ^ (0xEDB8_8320 & 0u32.wrapping_sub(crc & 1));
            }
        }
        !crc
    }

    #[test]
    fn a_book_lands_under_its_own_folder_without_the_archive_wrapper() {
        let dest = scratch("plain");
        let bytes = archive(&[
            ("book-main/README.md", "# 书\n", FILE),
            ("book-main/src/ch1.md", "# 一\n", FILE),
        ]);
        assert_eq!(unpack(&bytes, &dest).unwrap().files, 2);
        assert!(dest.join("README.md").is_file());
        assert!(dest.join("src/ch1.md").is_file());
        assert!(!dest.join("book-main").exists(), "the wrapper folder should be gone");
    }

    #[test]
    fn downloading_the_same_book_again_reports_that_it_replaced_the_old_copy() {
        let dest = scratch("again");
        let bytes = archive(&[("book-main/README.md", "# 第一版\n", FILE)]);
        assert!(!unpack(&bytes, &dest).unwrap().replaced, "a new folder is not a replacement");
        let second = unpack(&bytes, &dest).unwrap();
        assert!(second.replaced, "the second download overwrote an existing folder");
        assert_eq!(second.files, 1);
    }

    #[test]
    fn an_entry_that_climbs_out_of_the_folder_is_refused() {
        let dest = scratch("climb");
        let bytes = archive(&[
            ("book-main/README.md", "# ok\n", FILE),
            ("book-main/../../escaped.md", "pwned\n", FILE),
        ]);
        assert!(unpack(&bytes, &dest).is_err(), ".. must not be extracted");
        let escaped = dest.parent().unwrap().join("escaped.md");
        assert!(!escaped.exists(), "a file escaped to {}", escaped.display());
    }

    #[test]
    fn an_absolute_path_in_the_archive_is_refused() {
        let dest = scratch("absolute");
        let outside = std::env::temp_dir().join(format!("mdpad-fetch-abs-{}.md", std::process::id()));
        let _ = std::fs::remove_file(&outside);
        let bytes = archive(&[("book-main/README.md", "# ok\n", FILE), (outside.to_str().unwrap(), "pwned\n", FILE)]);
        assert!(unpack(&bytes, &dest).is_err(), "an absolute path must not be extracted");
        assert!(!outside.exists(), "a file escaped to {}", outside.display());
    }

    #[test]
    fn a_symbolic_link_entry_is_skipped_because_it_can_point_anywhere() {
        let dest = scratch("symlink");
        let bytes = archive(&[
            ("book-main/README.md", "# ok\n", FILE),
            ("book-main/escape", "/etc/passwd", LINK),
        ]);
        // The link is dropped, the real file still arrives, and nothing is written for the link.
        assert_eq!(unpack(&bytes, &dest).unwrap().files, 1);
        assert!(dest.join("README.md").is_file());
        assert!(!dest.join("escape").exists());
    }

    #[test]
    fn windows_is_the_platform_that_cannot_hold_every_name() {
        // Names a book may legitimately contain that Windows refuses outright.
        for rejected in
            ["Day 3: review.md", "why?.md", "a*.md", "a|b.md", "a<b>.md", "quote\".md", "trailing. ", "CON.md", "nul"]
        {
            assert!(!name_fits(rejected, true), "{rejected:?} should be unsavable on Windows");
        }
        // …and the very same names are ordinary files elsewhere.
        for accepted in ["Day 3: review.md", "why?.md", "a*.md", "CON.md"] {
            assert!(name_fits(accepted, false), "{accepted:?} should be fine off Windows");
        }
        // A full-width colon is a different character from the ASCII one, and is allowed everywhere.
        for fine in ["第 3 天：复习.md", "a b.md", "笔记.md", "chapter-01.md"] {
            assert!(name_fits(fine, true), "{fine:?} should be savable on Windows too");
        }
        // Length is the one limit all three filesystems share (255 bytes; CJK is three bytes each).
        assert!(name_fits(&"长".repeat(85), false), "255 bytes still fits");
        assert!(!name_fits(&"长".repeat(86), false), "258 bytes does not");
        assert!(!name_fits("", true) && !name_fits("", false));
    }

    #[test]
    fn a_name_windows_cannot_save_costs_one_file_not_the_whole_book() {
        let bytes = archive(&[
            ("book-main/README.md", "# ok\n", FILE),
            ("book-main/why?.md", "# also a chapter\n", FILE),
            ("book-main/Day 3: notes/ch.md", "# inside a folder Windows cannot name\n", FILE),
            ("book-main/src/ch1.md", "# one\n", FILE),
        ]);

        // Windows: the two unsavable entries — one file, one folder — are passed over and the rest
        // of the book arrives intact. Aborting here would have cost the reader everything.
        let windows = scratch("win-names");
        assert_eq!(
            unpack_with(&bytes, &windows, true).unwrap(),
            Unpacked { files: 2, skipped: 2, replaced: false }
        );
        assert!(windows.join("README.md").is_file());
        assert!(windows.join("src/ch1.md").is_file(), "unrelated entries must be unaffected");
        assert!(!windows.join("why?.md").exists());
    }

    // 那些名字在别处是普通文件，所以一个都不该落下。
    // 这条只能在非 Windows 上跑：它要证明的是「放开规则后真的写得下去」，
    // 而 Windows 的文件系统本身就不接受 `?` 和 `:`，在那边跑不出这个结论 —— 会以
    // os error 123 失败，看起来像产品坏了，其实是被测的宿主文件系统不配合。
    #[cfg(not(windows))]
    #[test]
    fn names_windows_rejects_are_ordinary_files_elsewhere() {
        let bytes = archive(&[
            ("book-main/README.md", "# ok\n", FILE),
            ("book-main/why?.md", "# also a chapter\n", FILE),
            ("book-main/Day 3: notes/ch.md", "# inside a folder Windows cannot name\n", FILE),
            ("book-main/src/ch1.md", "# one\n", FILE),
        ]);
        let unix = scratch("unix-names");
        assert_eq!(
            unpack_with(&bytes, &unix, false).unwrap(),
            Unpacked { files: 4, skipped: 0, replaced: false }
        );
        assert!(unix.join("why?.md").is_file());
        assert!(unix.join("Day 3: notes/ch.md").is_file());
    }

    #[test]
    fn the_first_chapter_is_the_readme_when_there_is_one() {
        let dir = scratch("entry");
        std::fs::write(dir.join("chapter-09.md"), "9").unwrap();
        std::fs::write(dir.join("README.md"), "# start").unwrap();
        std::fs::write(dir.join("cover.png"), "x").unwrap();
        assert_eq!(pick_entry(&dir).unwrap(), dir.join("README.md"));

        // With no README it should still find a document rather than give up.
        std::fs::remove_file(dir.join("README.md")).unwrap();
        assert_eq!(pick_entry(&dir).unwrap(), dir.join("chapter-09.md"));
    }

    fn sample_article() -> &'static str {
        r#"
# 标题

![图](./pic.png)
![远](https://cdn.example/a.jpg)
![协议](//cdn.example/b.png)

```
![x](./not-this.png)
```

<img src="../img/c.webp" alt="近">
<img src="data:image/gif;base64,AAAA" data-src="images/lazy.png" alt="懒">
<img srcset="small.png 480w, large.png 800w" alt="组">
<img src="https://cdn.example/a.jpg" alt="重复">
"#
    }

    #[test]
    fn article_images_cover_relative_absolute_srcset_and_lazy_src() {
        let base = "https://example.com/notes/post.md";
        let text = sample_article();
        let found = collect_remote_images(text, base, true);
        let urls: Vec<&str> = found.iter().map(|image| image.resolved.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "https://example.com/notes/pic.png",
                "https://cdn.example/a.jpg",
                "https://cdn.example/b.png",
                "https://example.com/img/c.webp",
                "https://example.com/notes/images/lazy.png",
                "https://example.com/notes/large.png",
                "https://cdn.example/a.jpg",
            ]
        );
        assert!(
            !urls.iter().any(|url| url.contains("not-this")),
            "围栏里的示例不该下载"
        );

        let mut paths = std::collections::HashMap::new();
        let mut n = 0usize;
        for image in &found {
            paths.entry(image.resolved.clone()).or_insert_with(|| {
                n += 1;
                format!("assets/{n}.png")
            });
        }
        let out = apply_local_paths(text, &found, &paths);
        assert!(out.contains("![图](assets/1.png)"), "{out}");
        assert!(out.contains("![远](assets/2.png)"), "{out}");
        assert!(out.contains("![协议](assets/3.png)"), "{out}");
        assert!(out.contains("![x](./not-this.png)"), "{out}");
        assert!(out.contains("![近](assets/4.png)"), "{out}");
        assert!(out.contains("![懒](assets/5.png)"), "{out}");
        assert!(out.contains("![组](assets/6.png)"), "{out}");
        assert!(
            out.contains("![重复](assets/2.png)"),
            "同一张图只下一次：{out}"
        );
        assert!(!out.contains("data-src"), "{out}");
        assert!(!out.contains("srcset"), "{out}");
    }

    #[test]
    fn a_post_does_not_refetch_relative_paths_that_are_already_local() {
        let text = sample_article();
        let found = collect_remote_images(text, "https://x.com/demo/status/1", false);
        let urls: Vec<&str> = found.iter().map(|image| image.resolved.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "https://cdn.example/a.jpg",
                "https://cdn.example/b.png",
                "https://cdn.example/a.jpg",
            ]
        );
    }

    #[test]
    fn a_failed_image_keeps_its_original_reference() {
        let text = "![图](./pic.png)\n";
        let found = collect_remote_images(text, "https://example.com/notes/post.md", true);
        let out = apply_local_paths(text, &found, &std::collections::HashMap::new());
        assert_eq!(out, text);
    }

    #[test]
    fn an_html_page_is_not_saved_as_a_picture() {
        assert_eq!(
            image_ext_of(b"<!DOCTYPE html><html></html>", "image/jpeg"),
            None
        );
        assert_eq!(
            image_ext_of(b"\x89PNG\r\n\x1a\nrest", "text/plain"),
            Some(".png")
        );
        assert_eq!(image_ext_of(b"not really", "image/webp"), Some(".webp"));
        assert_eq!(
            image_ext_of(b"<svg xmlns='http://www.w3.org/2000/svg'></svg>", ""),
            Some(".svg")
        );
    }
}
