//! Opening a document straight from a link.
//!
//! The user pastes a URL; we download it and drop it under the library folder (`~/Documents/MDPad/`)
//! so the sidebar lists the whole book.
//!
//! A repository link is fetched as a zip archive rather than file by file: a book's images and the
//! links between its chapters are relative paths, so downloading a single `.md` on its own would
//! leave every one of them broken.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use percent_encoding::percent_decode_str;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::files::{atomic_write, is_document};

/// Caps so a hostile or careless link cannot eat the machine's memory or disk.
const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_UNPACKED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ENTRIES: usize = 20_000;
const TIMEOUT: Duration = Duration::from_secs(180);

/// What a pasted link points at.
#[derive(Debug, PartialEq)]
pub enum Target {
    /// One document, already converted into an address we can fetch directly.
    File { url: String, folder: String, path: PathBuf },
    /// A whole repository, which arrives as a zip archive.
    Repo { owner: String, repo: String, branch: Option<String> },
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
        .user_agent(format!("MDPad/{}", env!("CARGO_PKG_VERSION")))
        .timeout(TIMEOUT)
        .build()
        .map_err(|error| format!("无法准备网络请求：{error}"))
}

/// Downloads a URL, stopping as soon as it grows past `limit`.
///
/// The cap has to be enforced while the bytes arrive, not before: GitHub's archive endpoint does
/// not send a Content-Length, so "check the size first" is not an option there.
async fn download(client: &reqwest::Client, url: &str, limit: u64) -> Result<Vec<u8>, Failure> {
    let mut response = client.get(url).send().await.map_err(|error| Failure::Message(friendly(&error)))?;
    let status = response.status();
    if !status.is_success() {
        let text = match status.as_u16() {
            404 => "这个链接指向的内容不存在（404）".to_string(),
            401 | 403 => "对方拒绝了这次请求，可能是访问太频繁，稍后再试".to_string(),
            429 => "请求太频繁了，稍后再试".to_string(),
            code => format!("下载失败：HTTP {code}"),
        };
        return Err(if status.as_u16() == 404 { Failure::NotFound(text) } else { Failure::Message(text) });
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

    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| Failure::Message(friendly(&error)))? {
        if body.len() as u64 + chunk.len() as u64 > limit {
            return Err(Failure::Message(format!("内容超过 {} 的上限，已停止下载", size(limit))));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
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
    std::fs::create_dir_all(dest).map_err(|error| format!("无法创建目录：{error}"))?;

    let mut out = Unpacked::default();
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
}

/// Where downloaded books live. `MDPAD_LIBRARY_DIR` overrides it, following `MDPAD_DATA_DIR`.
fn library_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("MDPAD_LIBRARY_DIR") {
        return Ok(PathBuf::from(dir));
    }
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
            atomic_write(&dest, text.as_bytes())?;
            let title = dest.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
            Ok(Fetched { path: dest, root, kind: "file", title, files: 1, skipped: 0 })
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
            Ok(Fetched { path: entry, root, kind: "book", title: repo, files, skipped: unpacked.skipped })
        }
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
        assert_eq!(unpack_with(&bytes, &windows, true).unwrap(), Unpacked { files: 2, skipped: 2 });
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
        assert_eq!(unpack_with(&bytes, &unix, false).unwrap(), Unpacked { files: 4, skipped: 0 });
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
}
