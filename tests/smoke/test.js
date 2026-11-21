// Runs inside the editor (debug builds only, via MDPAD_TEST_JS).
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 20000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await wait(100);
  }
  return check();
};
const placeCaret = (element, atEnd = true) => {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(!atEnd);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
};

const images = [...document.querySelectorAll('.milkdown img')];
await Promise.all(images.map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))));

// Edit, then let autosave run.
document.querySelector('.ProseMirror').focus();
placeCaret(document.querySelector('.ProseMirror p'));
document.execCommand('insertText', false, '新增的文字');
await wait(2000);

// Markdown markers appear when the caret is inside a heading or bold text.
placeCaret(document.querySelector('.ProseMirror h1'));
await wait(100);
const headingMarkers = [...document.querySelectorAll('.md-marker')].map((m) => m.textContent);
placeCaret(document.querySelector('.ProseMirror strong'));
await wait(100);
const boldMarkers = [...document.querySelectorAll('.md-marker')].map((m) => m.textContent);

// KaTeX 与 CodeMirror 是按需加载的 chunk，机器慢（CI 的软件渲染）时加载会明显更慢。
// 原来只靠固定的 wait 赌它已经就位 —— Linux 上偶发把 katex 判成 false，挡住整次发版。
// 改成等节点出现为止；超时后仍然是 false，真坏了照样失败。
await until(() => document.querySelector('.katex'));
await until(() => document.querySelector('.cm-editor'));

// Exercise the tree's native directory entries on Windows and its ordinary open-document path.
async function renameFromTree(from, stem) {
  const rows = () => [...document.querySelectorAll('#sidebar .tree-row')];
  const row = rows().find((entry) => entry.title === from);
  if (!row) throw new Error(`Missing file row: ${from}`);
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 100 }));
  const rename = [...document.querySelectorAll('.popup-menu .item')].find((item) => item.textContent === '重命名…');
  if (!rename) throw new Error('Missing rename action');
  rename.click();
  if (!(await until(() => document.activeElement?.matches('#sidebar .tree-row input')))) {
    throw new Error('Rename field did not receive focus');
  }
  const input = document.activeElement;
  input.value = stem;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const name = stem + '.md';
  if (!(await until(() => document.getElementById('doc-name').textContent === name &&
    rows().some((entry) => entry.title === name && entry.classList.contains('active')) &&
    !rows().some((entry) => entry.title === from)))) {
    throw new Error(`Renaming ${from} to ${name} did not refresh the title and tree`);
  }
  const check = await window.__TAURI_INTERNALS__.invoke('check_document');
  if (check.status !== 'unchanged') throw new Error(`Open document did not follow the rename to ${name}`);
}

await renameFromTree('sample.md', '改名回归');
document.querySelector('.ProseMirror').focus();
placeCaret(document.querySelector('.ProseMirror p'));
document.execCommand('insertText', false, '改名后继续编辑');
if (!(await until(() => window.__mdpadDebug.doc.raw.includes('改名后继续编辑')))) {
  throw new Error('Autosave did not write to the renamed file');
}
await renameFromTree('改名回归.md', 'sample');

return JSON.stringify({
  images: images.map((img) => img.src + ' loaded=' + (img.naturalWidth > 0)),
  katex: !!document.querySelector('.katex'),
  table: !!document.querySelector('.milkdown table'),
  codemirror: !!document.querySelector('.cm-editor'),
  status: document.getElementById('save-status').textContent,
  title: document.getElementById('doc-name').textContent,
  headingMarkers,
  boldMarkers,
  files: [...document.querySelectorAll('#sidebar .tree-row')].map((row) => row.textContent),
});
