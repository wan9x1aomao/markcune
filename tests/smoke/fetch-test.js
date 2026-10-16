// 「从链接打开」端到端实测：真的去 GitHub 下一本书回来。
// 由 MDPAD_TEST_JS 注入到真实窗口里执行，结果经 test_report 打回 stderr。
//
// 这一段的结论只写在最后一行 verdict=… 上，run.sh 与 run.ps1 都只认那一行：
//   verdict=pass  三项都真的走通了
//   verdict=skip  这台机器连不上 GitHub —— 网络问题，不该拦住发版
//   verdict=fail  功能本身有问题（链接识别、解压、拒绝逻辑）
const invoke = window.__TAURI_INTERNALS__.invoke;
const out = [];

// 只有传输层的失败才算 skip。分类/解压/拒绝逻辑出错一律算 fail —— 否则真故障会伪装成网络问题溜过去。
const transport = (text) => /连不上这个地址|连接超时|下载出错/.test(String(text));

// 每一项的结论：true 通过 / false 有问题 / 'skip' 这台机器到不了 GitHub
const verdicts = [];
const record = (value) => verdicts.push(value);
// 出错时统一判：网络走不通 → skip，其余 → 有问题
const recordError = (error) => record(transport(error) ? 'skip' : false);

// 1) 仓库链接 —— 整本书（含图片、SUMMARY.md 与章节互链）
//    README.md 由 pick_entry 选中；文件数说明 wrapper 目录剥掉了、图片也跟着下来了。
try {
  const book = await invoke('open_from_url', { url: 'https://github.com/ruanyf/es6tutorial' });
  out.push(`BOOK ok kind=${book.kind} files=${book.files} title=${book.title}`);
  out.push(`BOOK path=${book.path}`);
  out.push(`BOOK root=${book.root}`);
  const opened = await invoke('read_document', { path: book.path });
  out.push(`BOOK chars=${opened.content.length}`);
  record(book.kind === 'book' && book.files > 100 && opened.content.length > 100);
} catch (error) {
  out.push(`BOOK fail ${error}`);
  recordError(error);
}

// 2) 浏览器里复制到的 blob 链接 —— 单个文件。
//    这个链接给的是 HTML 页面，必须被改写成 raw 才拿得到正文。
try {
  const one = await invoke('open_from_url', { url: 'https://github.com/rust-lang/book/blob/main/README.md' });
  out.push(`FILE ok kind=${one.kind} files=${one.files} title=${one.title}`);
  out.push(`FILE path=${one.path}`);
  const opened = await invoke('read_document', { path: one.path });
  out.push(`FILE chars=${opened.content.length} head=${JSON.stringify(opened.content.slice(0, 24))}`);
  // 拿到 HTML 就说明改写没生效 —— 这正是这个用例存在的意义。
  record(opened.content.startsWith('# ') && !opened.content.includes('<!DOCTYPE'));
} catch (error) {
  out.push(`FILE fail ${error}`);
  recordError(error);
}

// 3) 不支持的页面必须被拒绝，而不是把网页当文档下回来
try {
  await invoke('open_from_url', { url: 'https://github.com/rust-lang/book/issues' });
  out.push('REJECT fail 没有报错');
  record(false);
} catch (error) {
  out.push(`REJECT ok ${error}`);
  // 拒绝的理由必须说得出是哪种链接 —— 别的报错说明问题出在别处。
  if (/issues/.test(String(error))) record(true);
  else recordError(error);
}

const passed = verdicts.filter((value) => value === true).length;
const broken = verdicts.some((value) => value === false);
const verdict = broken ? 'fail' : passed === verdicts.length ? 'pass' : 'skip';

out.push(`verdict=${verdict} passed=${passed}/${verdicts.length}`);
return out.join('\n');
