// 冒烟测试：打开一份没有排版的纯文本，等悬浮按钮出现，点它，然后看结果。
// 跑法见 tests/smoke/run.sh 与 run.ps1；这里只负责操作界面并报告看到的东西。
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hint = document.getElementById('tidy-hint');
const go = hint?.querySelector('.go');
const editor = document.querySelector('.ProseMirror');

// 编辑停止一会儿后才会检查，所以要轮询等它出现。
let appeared = false;
for (let i = 0; i < 80 && !appeared; i++) {
  appeared = hint.classList.contains('show');
  if (!appeared) await wait(250);
}

const before = editor ? editor.innerText.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
const buttonHidden = hint.hasAttribute('hidden') || getComputedStyle(hint).display === 'none';

let busySeen = false;
let runningLabel = '';
if (appeared && go) {
  go.click();
  await wait(300);
  busySeen = hint.classList.contains('busy');
  runningLabel = go.textContent;
}

// 等整理结束（按钮结束 busy），再等自动保存落盘。
for (let i = 0; i < 80 && hint.classList.contains('busy'); i++) await wait(250);
await wait(3000);

const text = editor ? editor.innerText : '';
return JSON.stringify({
  appeared,
  busySeen,
  runningLabel,
  buttonHidden,
  before,
  toast: document.getElementById('toast')?.textContent ?? '',
  saveStatus: document.getElementById('save-status')?.textContent ?? '',
  headings: [...document.querySelectorAll('.ProseMirror h1, .ProseMirror h2, .ProseMirror h3')].map((h) => h.tagName + ' ' + h.textContent),
});
