// Runs inside the editor (debug builds only, via MDPAD_TEST_JS).
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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
