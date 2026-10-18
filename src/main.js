import './style.css';
import { api, appWindow } from './bridge.js';
import { ai } from './ai-core.js';
import { installReview } from './ai-review.js';
import { installAiActions, skillCommands } from './ai-skills.js';
import { openAiSettings } from './ai-settings.js';
import { COMMANDS } from './commands.js';
import { createRichEditor } from './editor.js';
import { createFindbar } from './findbar.js';
import { icons } from './icons.js';
import { downloadNotice } from './notices.js';
import { createOutline } from './outline.js';
import { openPalette } from './palette.js';
import { basename, dirname, isInside, relative, samePath, splitExtension } from './paths.js';
import { installShortcuts } from './shortcuts.js';
import { createSidebar } from './sidebar.js';
import { createUpdater } from './update.js';
import { formatKeys, prompt, showMenu, toast } from './ui.js';
import { createTidyHint, tidyDocument } from './tidy-ui.js';

const AUTOSAVE_DELAY = 1000;
const CHANGELOG_URL = 'https://mdpad.app.workbuddy.host/#changelog';
const isMac = navigator.userAgent.includes('Mac');
const $ = (id) => document.getElementById(id);
const els = {
  docName: $('doc-name'),
  wordCount: $('word-count'),
  status: $('save-status'),
  banner: $('banner'),
  sidebar: $('sidebar'),
  sidebarBody: $('sidebar-body'),
  outline: $('outline'),
  panes: $('panes'),
  modeSwitch: $('mode-switch'),
  empty: $('empty-state'),
  richPane: $('rich-pane'),
  sourcePane: $('source-pane'),
  editorRoot: $('editor'),
  topbar: $('topbar'),
};

const app = {
  settings: { sidebar: true, outline: false },
  root: null,
  /**
   * raw: the file as on disk. snapshot: the editor's document (see editor.snapshot()) when it last
   * matched the disk/draft, or null if unknown. saved: the markdown last written, or null if unknown.
   * Comparing snapshots avoids serializing the whole document just to learn that nothing changed.
   */
  doc: { path: null, draftId: null, raw: '', snapshot: null, saved: null },
  hasDraftContent: false,
  mode: 'rich',
  split: false,
  focus: false,
  /** The AI selection button for the current editor, or null in source mode. */
  aiActions: null,
  /** The review list for the current editor, or null in source mode. */
  review: null,
  editor: null,
  preview: null,
  pending: false,
  status: 'idle',
  statusDetail: '',
  guard: false,
  saving: Promise.resolve(),
  headings: [],
  recentFiles: [],
};

// Status, title and close guard

const STATUS_TEXT = {
  idle: '',
  saving: '正在保存…',
  saved: '已保存',
  draft: '草稿已自动保存',
  error: '保存失败',
  conflict: '文件已在外部修改',
};

function setStatus(status, detail = '') {
  const changed = status !== app.status;
  app.status = status;
  app.statusDetail = detail;
  els.status.querySelector('.text').textContent = STATUS_TEXT[status];
  els.status.className = `status ${status}`;
  els.status.hidden = !STATUS_TEXT[status];
  els.status.title = status === 'error' ? `${detail}\n点击重试` : '';
  // A small nudge when the state settles (not on every "saving").
  if (changed && status !== 'saving') {
    void els.status.offsetWidth;
    els.status.classList.add('bump');
  }
  updateGuard();
}

function updateTitle() {
  const name = app.doc.path ? basename(app.doc.path) : '未命名';
  els.docName.textContent = name;
  api.setTitle(isMac ? name : `${name} - MDPad`);
}

/** Closing needs the page's attention while something is unsaved or a draft exists. */
function updateGuard() {
  const guard =
    app.pending || app.status === 'error' || app.status === 'conflict' || (!app.doc.path && app.hasDraftContent);
  if (guard !== app.guard) {
    app.guard = guard;
    api.setCloseGuard(guard);
  }
}

// Banner for external changes

function showBanner(message, actions) {
  els.banner.hidden = false;
  els.banner.querySelector('.message').textContent = message;
  const buttons = els.banner.querySelector('.buttons');
  buttons.replaceChildren();
  for (const [label, run] of actions) {
    const button = Object.assign(document.createElement('button'), { className: 'text-button', textContent: label });
    button.addEventListener('click', run);
    buttons.appendChild(button);
  }
}

function hideBanner() {
  els.banner.hidden = true;
}

function showConflict(reason) {
  setStatus('conflict');
  if (reason === 'missing') {
    showBanner('这个文件已被移动或删除，你的修改还没有保存。', [
      ['在原位置重新保存', () => resolveConflict('overwrite')],
      ['另存为…', () => saveAs()],
    ]);
  } else {
    showBanner('这个文件已被其他程序修改。', [
      ['载入外部版本', () => resolveConflict('reload')],
      ['保留我的版本', () => resolveConflict('overwrite')],
    ]);
  }
}

async function resolveConflict(choice) {
  hideBanner();
  if (choice === 'reload') {
    await reloadFromDisk();
  } else {
    app.pending = true;
    setStatus('saving');
    await save({ force: true });
  }
}

// Editor lifecycle

const IMAGE_URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_ABSOLUTE = /^[a-z]:[\\/]/i;

function normalizePath(path) {
  const parts = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.' && part !== '') parts.push(part);
  }
  return (path.startsWith('/') ? '/' : '') + parts.join('/');
}

/** Asset URLs handed to the page, mapped back to the image file (for HTML export). */
const imageSources = new Map();
const grantedImages = new Map();

/**
 * Image paths are resolved against the document's folder for display only. Local files are
 * shown only after the shell confirms they are real images (see allow_image).
 */
function resolveImage(url) {
  if (url.startsWith('//') || (IMAGE_URL_SCHEME.test(url) && !WINDOWS_ABSOLUTE.test(url))) return url;
  let target;
  try {
    target = decodeURI(url);
  } catch {
    target = url;
  }
  if (!target.startsWith('/') && !WINDOWS_ABSOLUTE.test(target)) {
    if (!app.doc.path) return url;
    target = dirname(app.doc.path) + '/' + target;
  }
  target = normalizePath(target);
  if (!grantedImages.has(target)) {
    const granted = api.allowImage(target).then((real) => {
      if (!real) {
        grantedImages.delete(target); // Try again if the file appears later.
        return url;
      }
      const assetURL = api.fileURL(real);
      imageSources.set(assetURL, real);
      return assetURL;
    });
    grantedImages.set(target, granted);
  }
  return grantedImages.get(target);
}

async function embedImage(src) {
  const path = imageSources.get(src);
  if (!path) return null;
  try {
    return await api.imageDataUrl(path);
  } catch {
    return null;
  }
}

async function uploadImage(file) {
  if (!app.doc.path) {
    // Untitled: there is no folder for assets yet, so embed the image.
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return api.saveImage(file.name || `图片-${Date.now()}.png`, bytes);
}

async function pickImage() {
  const path = await api.pickImage();
  if (!path) return null;
  if (!app.doc.path) return path;
  try {
    return await api.importImage(path);
  } catch (error) {
    toast(`无法使用这张图片：${error}`);
    return null;
  }
}

async function renderDiagram(code) {
  const { renderMermaid } = await import('./diagram.js');
  return renderMermaid(code);
}

function editorOptions() {
  return {
    resolveImage,
    uploadImage,
    pickImage,
    promptCaption: (caption) => prompt({ title: '图片说明', value: caption, okLabel: '完成' }),
    renderDiagram,
    onCopy: () => toast('已复制'),
    onOpenLink: (url) => api.openUrl(url),
  };
}

async function mountEditor(content, position) {
  performance.mark('mdpad:mount-start');
  const previous = app.editor;
  app.editor = null;
  await previous?.destroy();
  await app.preview?.destroy();
  app.preview = null;
  els.editorRoot.replaceChildren();
  els.sourcePane.replaceChildren();

  const source = app.mode === 'source';
  els.sourcePane.hidden = !source;
  els.richPane.hidden = source && !app.split;
  document.body.classList.toggle('split', source && app.split);

  let editor;
  if (source) {
    const { createSourceEditor } = await import('./source.js');
    editor = createSourceEditor({ root: els.sourcePane, content, scroller: els.sourcePane, onChange });
    if (app.split) {
      app.preview = await createRichEditor({
        ...editorOptions(),
        root: els.editorRoot,
        content,
        readonly: true,
        scroller: els.richPane,
      });
    }
  } else {
    editor = await createRichEditor({ ...editorOptions(), root: els.editorRoot, content, scroller: els.richPane, onChange });
  }
  performance.mark('mdpad:mount-created');
  app.doc.snapshot = editor.snapshot();
  performance.mark('mdpad:mount-serialized');
  app.editor = editor;
  // The AI button only exists in the rich editor: there is no selection to rewrite in source mode.
  app.aiActions?.destroy();
  app.aiActions = editor.kind === 'rich' ? installAiActions(editor.view) : null;
  app.review?.();
  app.review = editor.kind === 'rich' ? installReview(editor.view) : null;
  editor.setPosition(position);
  updateWordCount();
  refreshOutline();
  findbar.refresh();
  syncModeSwitch();
  updateEmpty();
  tidyHint.schedule();
  performance.mark('mdpad:mount-done');
}

const tidyHint = createTidyHint({
  button: $('tidy-hint'),
  getEditor: () => app.editor,
  // Dismissing the button is remembered for this document until the app restarts.
  docKey: () => app.doc.path ?? 'draft',
});

let wordCountTimer;
function updateWordCount() {
  if (!els.wordCount) return;
  const count = app.editor?.getWordCount?.() ?? 0;
  els.wordCount.textContent = `全文 ${count.toLocaleString('zh-CN')} 字`;
}

function scheduleWordCount() {
  clearTimeout(wordCountTimer);
  wordCountTimer = setTimeout(updateWordCount, 120);
}

function onChange() {
  if (!app.editor) return;
  scheduleWordCount();
  if (document.body.classList.contains('empty')) setEmpty(false);
  app.pending = true;
  if (app.status !== 'conflict') setStatus('saving');
  clearTimeout(app.saveTimer);
  app.saveTimer = setTimeout(() => save(), AUTOSAVE_DELAY);
  scheduleOutline();
  schedulePreview();
  updateGuard();
  tidyHint.schedule();
}

// Saving

function save({ force = false } = {}) {
  clearTimeout(app.saveTimer);
  app.saving = app.saving.then(() => writeNow(force)).catch(() => {});
  return app.saving;
}

async function writeNow(force) {
  if (!app.editor || (!app.pending && !force)) return;
  if (app.status === 'conflict' && !force) return;
  if (app.doc.path && !force && app.editor.matches(app.doc.snapshot)) {
    // Edited back to what is on disk (e.g. typed, then undid it).
    app.pending = false;
    setStatus('saved');
    return;
  }
  performance.mark('mdpad:save-start');
  // Serialize the snapshot (documents are immutable) without blocking typing; edits made
  // meanwhile set app.pending again and get their own save.
  const snapshot = app.editor.snapshot();
  app.pending = false;
  let content;
  try {
    content = await app.editor.getMarkdownAsync(snapshot);
  } catch (error) {
    app.pending = true;
    setStatus('error', String(error));
    return;
  }
  performance.mark('mdpad:save-serialized');
  try {
    if (app.doc.path) {
      if (content === app.doc.saved && !force) {
        app.doc.snapshot = snapshot;
        setStatus('saved');
        return;
      }
      const result = await api.writeDocument(content, force);
      if (result.status === 'conflict') {
        app.pending = true;
        showConflict(result.reason);
        return;
      }
      performance.mark('mdpad:save-written');
      app.doc.saved = content;
      app.doc.snapshot = snapshot;
      app.doc.raw = content;
      hideBanner();
      setStatus(app.pending ? 'saving' : 'saved');
    } else if (content.trim() === '') {
      if (app.doc.draftId) await api.draftDelete();
      app.doc.draftId = null;
      app.doc.saved = content;
      app.doc.snapshot = snapshot;
      app.hasDraftContent = false;
      setStatus('idle');
    } else {
      app.doc.draftId = await api.draftWrite(content);
      app.doc.saved = content;
      app.doc.snapshot = snapshot;
      app.hasDraftContent = true;
      setStatus(app.pending ? 'saving' : 'draft');
    }
  } catch (error) {
    app.pending = true;
    setStatus('error', String(error));
  }
}

async function saveNow() {
  if (!app.doc.path) return saveAs();
  app.pending = true;
  await save();
}

async function saveAs() {
  await app.saving;
  if (!app.editor) return false;
  const snapshot = app.editor.snapshot();
  const content = app.editor.getMarkdown();
  let result;
  try {
    result = await api.saveAs(content);
  } catch (error) {
    toast(`保存失败：${error}`);
    return false;
  }
  if (!result) return false;
  app.doc = { path: result.path, draftId: null, raw: result.content, snapshot, saved: result.content };
  app.hasDraftContent = false;
  app.pending = false;
  hideBanner();
  if (result.rewritten) {
    // Image paths were adjusted for the new folder.
    await mountEditor(result.content, app.editor.getPosition());
  }
  setStatus('saved');
  updateTitle();
  if (!app.root || !isInside(result.path, app.root)) await setRoot(dirname(result.path));
  else await sidebar.refreshDirs([dirname(result.path)]);
  await sidebar.setActive(result.path);
  return true;
}

async function reloadFromDisk() {
  const position = app.editor?.getPosition();
  try {
    const opened = await api.readDocument(app.doc.path);
    app.doc.raw = opened.content;
    app.doc.saved = null;
    app.pending = false;
    await mountEditor(opened.content, position);
    setStatus('saved');
  } catch (error) {
    toast(`无法重新载入：${error}`);
  }
}

// Opening documents and folders

function rememberPosition() {
  if (app.doc.path && app.editor) api.rememberPosition(app.doc.path, app.editor.getPosition());
}

async function setRoot(path) {
  app.root = path;
  app.documents = null;
  await api.setRoot(path);
  await sidebar.setRoot(path);
  if (app.doc.path) await sidebar.setActive(app.doc.path);
}

/** Shows the progress bar while `task` runs, unless it finishes quickly. */
async function withProgress(task) {
  const timer = setTimeout(() => document.body.classList.add('loading'), 150);
  try {
    return await task();
  } finally {
    clearTimeout(timer);
    document.body.classList.remove('loading');
  }
}

async function openFile(path) {
  if (samePath(path, app.doc.path)) return;
  return withProgress(() => openFileNow(path));
}

async function openFileNow(path) {
  // Never drop an unsaved draft: open the file next to it instead.
  if (!app.doc.path && app.hasDraftContent) return api.openInNewWindow(path);
  await save();
  rememberPosition();
  let opened;
  try {
    performance.mark('mdpad:read-start');
    opened = await api.readDocument(path);
    performance.mark('mdpad:read-done');
  } catch (error) {
    toast(`无法打开“${basename(path)}”：${error}`);
    return;
  }
  if (app.doc.draftId) await api.draftDelete();
  app.doc = { path: opened.path, draftId: null, raw: opened.content, snapshot: null, saved: null };
  app.hasDraftContent = false;
  app.pending = false;
  hideBanner();
  if (!app.root || !isInside(opened.path, app.root)) await setRoot(dirname(opened.path));
  await mountEditor(opened.content, opened.position);
  setStatus('saved');
  updateTitle();
  await sidebar.setActive(opened.path);
}

async function openFolder(path) {
  path ??= await api.pickFolder();
  if (!path) return;
  await setRoot(path);
  if (!app.settings.sidebar) setPanel('sidebar', true);
}

async function openFileDialog() {
  const [first, ...rest] = await api.pickDocuments();
  if (first) await openFile(first);
  for (const path of rest) api.openInNewWindow(path);
}

// Downloads a pasted link into the library folder and opens it. A repository comes down as a whole
// folder, so the sidebar is pointed at the book instead of the single file inside it.
async function openFromUrl() {
  const url = await prompt({
    title: '粘贴链接：GitHub 上的书，或一个 Markdown 文件的地址',
    value: '',
    okLabel: '下载并打开',
  });
  if (!url?.trim()) return;
  try {
    // Two steps on purpose: point the sidebar at the book first, then open the entry document —
    // opening would otherwise narrow the folder down to wherever that one file happens to live.
    const result = await withProgress(() => api.openFromUrl(url.trim()));
    if (result.root) await setRoot(result.root);
    await openFile(result.path);
    toast(downloadNotice(result));
  } catch (error) {
    await api.confirm('没有下载成功', String(error), '知道了');
  }
}

async function newDocument(dir) {
  dir ??= app.root ?? (app.doc.path && dirname(app.doc.path));
  if (!dir) return api.newWindow();
  try {
    const path = await api.createDocument(dir);
    await sidebar.refreshDirs([dir]);
    await openFile(path);
    if (samePath(app.doc.path, path)) await sidebar.startRename(path);
  } catch (error) {
    toast(`无法新建文档：${error}`);
  }
}

function onRenamed(from, to) {
  if (app.doc.path && (samePath(app.doc.path, from) || isInside(app.doc.path, from))) {
    app.doc.path = to + app.doc.path.slice(from.length);
    updateTitle();
    sidebar.setActive(app.doc.path);
  }
}

async function renameCurrent() {
  if (!app.doc.path) return saveAs();
  const name = basename(app.doc.path);
  const value = await prompt({ title: '重命名', value: name, okLabel: '重命名', selectEnd: splitExtension(name)[0].length });
  if (!value || value === name) return;
  try {
    const from = app.doc.path;
    const target = await api.renamePath(from, value);
    onRenamed(from, target);
    await sidebar.refreshDirs([dirname(target)]);
  } catch (error) {
    toast(`无法重命名：${error}`);
  }
}

// Modes, panels and focus

async function setMode(mode, split) {
  if (!app.editor) return;
  const matches = app.editor.matches(app.doc.snapshot);
  // Unedited documents are shown exactly as stored on disk.
  const unchanged = app.editor.kind === 'rich' && matches && app.doc.raw;
  const content = mode === 'source' && unchanged ? app.doc.raw : app.editor.getMarkdown();
  const pane = app.mode === 'source' ? els.sourcePane : els.richPane;
  const ratio = pane.scrollTop / Math.max(1, pane.scrollHeight - pane.clientHeight);
  const pending = app.pending;
  app.mode = mode;
  app.split = split;
  await mountEditor(content);
  // Edits not yet on disk must still be written, so the new editor doesn't match the disk.
  if (!matches) app.doc.snapshot = null;
  if (pending) onChange();
  const next = mode === 'source' ? els.sourcePane : els.richPane;
  requestAnimationFrame(() => (next.scrollTop = ratio * (next.scrollHeight - next.clientHeight)));
  app.editor.focus();
}

/**
 * FLIP: apply a layout change in one step, then let the document and the top bar glide from
 * where they were. Only `translate` animates, so it stays smooth on high-refresh displays.
 */
function glide(change) {
  const targets = [els.panes, els.modeSwitch, document.querySelector('.topbar-left'), document.querySelector('#topbar .actions')];
  const anchor = (target) =>
    target === els.panes
      ? (els.richPane.hidden ? els.sourcePane.querySelector('.cm-content') : els.editorRoot.querySelector('.milkdown')) ?? target
      : target;
  const before = targets.map((target) => anchor(target).getBoundingClientRect().left);
  change();
  targets.forEach((target, i) => {
    const dx = before[i] - anchor(target).getBoundingClientRect().left;
    target.classList.remove('glide');
    target.style.translate = Math.abs(dx) > 0.5 ? `${dx}px 0` : '';
  });
  void document.body.offsetWidth;
  for (const target of targets) {
    target.classList.add('glide');
    target.style.translate = '';
  }
}

function applyPanels() {
  document.body.classList.toggle('sidebar-hidden', !app.settings.sidebar);
  document.body.classList.toggle('outline-open', !!app.settings.outline);
  $('toggle-outline').classList.toggle('on', !!app.settings.outline);
}

function setPanel(name, visible) {
  app.settings[name] = visible;
  glide(applyPanels);
  api.setSetting(name, visible);
  if (name === 'outline' && visible) refreshOutline();
}

function setFocus(on) {
  app.focus = on;
  glide(() => {
    document.body.classList.toggle('focus', on);
    document.body.classList.remove('reveal-topbar');
  });
  app.editor?.focus();
}

// Mode switch (所见即所得 / 源码 / 分屏)

const currentMode = () => (app.mode === 'source' ? (app.split ? 'split' : 'source') : 'rich');

function syncModeSwitch() {
  const buttons = [...els.modeSwitch.querySelectorAll('button[data-mode]')];
  const index = Math.max(0, buttons.findIndex((b) => b.dataset.mode === currentMode()));
  buttons.forEach((button, i) => {
    button.classList.toggle('on', i === index);
    button.setAttribute('aria-selected', String(i === index));
  });
  els.modeSwitch.querySelector('.thumb').style.transform = `translateX(${index * 100}%)`;
}

els.modeSwitch.addEventListener('click', (event) => {
  const mode = event.target.closest('button[data-mode]')?.dataset.mode;
  if (!mode || mode === currentMode() || !app.editor) return;
  if (mode === 'rich') setMode('rich', false);
  else setMode('source', mode === 'split');
});

// Empty state: an untouched untitled document shows what you can do; typing just starts writing.

function setEmpty(on) {
  document.body.classList.toggle('empty', on);
  els.empty.hidden = !on;
}

function updateEmpty() {
  const empty =
    !app.doc.path &&
    !app.hasDraftContent &&
    !app.pending &&
    app.editor?.kind === 'rich' &&
    app.editor.getMarkdown().trim() === '';
  if (empty) renderEmpty();
  setEmpty(empty);
}

function renderEmpty() {
  const row = (icon, label, hint, run) => {
    const button = document.createElement('button');
    button.className = 'empty-row';
    button.innerHTML = `${icons[icon]}<span class="label"></span><span class="hint"></span>`;
    button.querySelector('.label').textContent = label;
    button.querySelector('.hint').textContent = hint;
    button.addEventListener('click', run);
    return button;
  };
  $('empty-actions').replaceChildren(
    row('pen', '开始写作', '', () => {
      setEmpty(false);
      app.editor?.focus();
    }),
    row('file', '打开文件…', formatKeys('Mod+O'), () => run('open-file')),
    row('folder', '打开文件夹…', formatKeys('Mod+Shift+O'), () => run('open-folder')),
    row('download', '从链接打开…', '', () => run('open-from-url')),
  );
  const recent = app.recentFiles.slice(0, 5);
  $('empty-recent-label').hidden = !recent.length;
  $('empty-recent').replaceChildren(
    ...recent.map((path) => row('clock', basename(path), basename(dirname(path)), () => openFile(path))),
  );
}

document.addEventListener('mousemove', (event) => {
  if (!app.focus) return;
  const near = event.clientY < 48 || els.topbar.contains(event.target);
  document.body.classList.toggle('reveal-topbar', near);
});

// Outline and split preview

let outlineTimer;
function scheduleOutline() {
  if (!app.settings.outline) return;
  clearTimeout(outlineTimer);
  outlineTimer = setTimeout(refreshOutline, 300);
}

function refreshOutline() {
  if (!app.settings.outline || !app.editor) return;
  app.headings = app.editor.headings();
  outline.update(app.headings, app.editor.activeHeading(app.headings));
}

let previewTimer;
function schedulePreview() {
  if (!app.preview) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => app.preview?.setMarkdown(app.editor.getMarkdown()), 250);
}

let scrollTimer;
let scrollFrame;
function onScroll(pane) {
  cancelAnimationFrame(scrollFrame);
  scrollFrame = requestAnimationFrame(() => {
    if (app.settings.outline && app.editor) outline.setActive(app.editor.activeHeading(app.headings));
    if (app.preview && pane === els.sourcePane) {
      const ratio = pane.scrollTop / Math.max(1, pane.scrollHeight - pane.clientHeight);
      els.richPane.scrollTop = ratio * (els.richPane.scrollHeight - els.richPane.clientHeight);
    }
  });
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(rememberPosition, 800);
}
els.richPane.addEventListener('scroll', () => onScroll(els.richPane), { passive: true });
els.sourcePane.addEventListener('scroll', () => onScroll(els.sourcePane), { passive: true });

// Export

/** The document to export: the rich editor's, or the split view's preview (brought up to date). */
async function exportDocument() {
  if (app.editor?.kind !== 'rich' && !app.preview) await setMode('rich', false);
  if (app.preview) {
    clearTimeout(previewTimer);
    app.preview.setMarkdown(app.editor.getMarkdown());
  }
  return (app.editor.kind === 'rich' ? app.editor : app.preview).view.state.doc;
}

const exportTitle = () => (app.doc.path ? splitExtension(basename(app.doc.path))[0] : '未命名');
const exportDiagram = async (code) => (await import('./diagram.js')).renderMermaid(code, 'light');

/** The exported page as a string (images and math fonts embedded). */
async function buildExportHtml() {
  const doc = await exportDocument();
  const { buildHtml } = await import('./export.js');
  return buildHtml(doc, exportTitle(), {
    image: async (src) => {
      const url = await resolveImage(src);
      return (await embedImage(url)) ?? url;
    },
    diagram: exportDiagram,
  });
}

async function exportHtml() {
  let html;
  try {
    html = await buildExportHtml();
  } catch (error) {
    toast(`导出失败：${error}`);
    return;
  }
  try {
    if (await api.exportHtml(html, `${exportTitle()}.html`)) toast('已导出为网页');
  } catch (error) {
    toast(`导出失败：${error}`);
  }
}

/** Fills the print-only container with the fully rendered document. */
async function preparePrintDocument() {
  const doc = await exportDocument();
  const { preparePrint } = await import('./export.js');
  await preparePrint(doc, { image: async (src) => resolveImage(src), diagram: exportDiagram });
}

async function exportPdf() {
  try {
    await preparePrintDocument();
  } catch (error) {
    toast(`导出失败：${error}`);
    return;
  }
  // The print dialog suggests the page title as the PDF's name.
  const previousTitle = document.title;
  document.title = exportTitle();
  toast('在打印窗口中选择“存储为 PDF”', 4000);
  await api.print();
  setTimeout(() => (document.title = previousTitle), 1000);
}

// Commands

const actions = {
  'new-window': () => api.newWindow(),
  'new-document': () => newDocument(),
  'open-file': openFileDialog,
  'open-folder': () => openFolder(),
  'open-from-url': openFromUrl,
  'quick-open': () => showPalette('files'),
  'command-palette': () => showPalette('all'),
  save: saveNow,
  'save-as': saveAs,
  rename: renameCurrent,
  reveal: () => (app.doc.path || app.root) && api.reveal(app.doc.path ?? app.root),
  'export-html': exportHtml,
  'export-pdf': exportPdf,
  tidy: () => tidyHint.run(),
  'ai-settings': () => openAiSettings(),
  find: () => findbar.show(false),
  replace: () => findbar.show(true),
  'find-next': () => findbar.go(1),
  'find-previous': () => findbar.go(-1),
  'toggle-source': () => setMode(app.mode === 'source' && !app.split ? 'rich' : 'source', false),
  'toggle-split': () => (app.split ? setMode('rich', false) : setMode('source', true)),
  'toggle-focus': () => setFocus(!app.focus),
  'toggle-sidebar': () => setPanel('sidebar', !app.settings.sidebar),
  'toggle-outline': () => setPanel('outline', !app.settings.outline),
  'check-update': () => updater.check(false),
  changelog: () => api.openUrl(CHANGELOG_URL),
  // Handled by the shell (native menu items on macOS).
  'zoom-in': () => api.nativeAction('zoom-in'),
  'zoom-out': () => api.nativeAction('zoom-out'),
  'zoom-reset': () => api.nativeAction('zoom-reset'),
  fullscreen: () => api.nativeAction('fullscreen'),
  close: () => appWindow.close(),
};
for (const id of ['bold', 'italic', 'strikethrough', 'inline-code', 'undo', 'redo']) {
  actions[id] = () => app.editor?.command(id);
}

function run(id) {
  actions[id]?.();
}

function showPalette(mode) {
  const fileItem = (path) => ({
    title: basename(path),
    hint: app.root && isInside(path, app.root) ? relative(dirname(path), app.root) || basename(app.root) : dirname(path),
    run: () => openFile(path),
  });
  openPalette({
    mode,
    commands: [
      ...COMMANDS.map((c) => ({ title: c.title, hint: formatKeys(c.keys), run: () => run(c.id) })),
      // Rewrite skills live here too, so a keyboard user never needs the floating button.
      ...(mode === 'all' && ai.available() && app.editor?.kind === 'rich' ? skillCommands(app.editor.view) : []),
    ],
    recent: app.recentFiles.filter((p) => !samePath(p, app.doc.path)).slice(0, 8).map(fileItem),
    files: async () => {
      if (!app.root) return [];
      app.documents ??= await api.listDocuments(app.root).catch(() => []);
      return app.documents.map(fileItem);
    },
  });
}

function showMore(anchor) {
  const item = (id, checked) => {
    const command = COMMANDS.find((c) => c.id === id);
    return { label: command.title, hint: formatKeys(command.keys), checked, run: () => run(id) };
  };
  // Without a native menu bar (Windows, Linux), file actions live here too.
  const fileItems = isMac
    ? []
    : [
        item('new-window'),
        item('open-file'),
        item('open-folder'),
        item('open-from-url'),
        item('quick-open'),
        'separator',
        item('save'),
        item('save-as'),
        item('rename'),
        'separator',
      ];
  showMenu(
    [
      ...fileItems,
      item('find'),
      item('replace'),
      item('tidy'),
      item('ai-settings'),
      'separator',
      item('toggle-source', app.mode === 'source' && !app.split),
      item('toggle-split', app.split),
      item('toggle-focus', app.focus),
      'separator',
      item('toggle-sidebar', app.settings.sidebar),
      item('toggle-outline', app.settings.outline),
      'separator',
      { label: '命令面板…', hint: formatKeys('Mod+K'), run: () => run('command-palette') },
      'separator',
      item('export-html'),
      item('export-pdf'),
      'separator',
      item('reveal'),
      'separator',
      item('check-update'),
      item('changelog'),
    ],
    anchor,
  );
}

// Wiring

const sidebar = createSidebar(els.sidebarBody, {
  api,
  revealLabel: isMac ? '在访达中显示' : '在资源管理器中显示',
  onOpen: openFile,
  onOpenInNewWindow: (path) => api.openInNewWindow(path),
  onOpenFolder: openFolder,
  onNewDocument: newDocument,
  onRenamed,
  onError: toast,
});
const outline = createOutline(els.outline, { onSelect: (heading) => app.editor?.scrollToHeading(heading) });
const findbar = createFindbar($('findbar'), { getEditor: () => app.editor });
const updater = createUpdater($('update-banner'), {
  api,
  toast,
  beforeRestart: async () => {
    await save();
    rememberPosition();
  },
});

const buttons = {
  'toggle-sidebar': [icons.sidebar, `显示文件列表（${formatKeys('Mod+Shift+L')}）`, () => run('toggle-sidebar')],
  'sidebar-collapse': [icons.sidebar, `收起文件列表（${formatKeys('Mod+Shift+L')}）`, () => run('toggle-sidebar')],
  'sidebar-search': [icons.search, `快速打开（${formatKeys('Mod+P')}）`, () => run('quick-open')],
  'toggle-outline': [icons.outline, `大纲（${formatKeys('Mod+Shift+T')}）`, () => run('toggle-outline')],
  'open-more': [icons.more, '更多', (event) => showMore(event.currentTarget)],
};
for (const [id, [icon, title, onClick]] of Object.entries(buttons)) {
  $(id).innerHTML = icon;
  $(id).title = title;
  $(id).addEventListener('click', onClick);
}
document.querySelector('#empty-state .empty-icon').innerHTML = icons.file;
$('exit-focus').addEventListener('click', () => setFocus(false));
els.status.addEventListener('click', () => {
  if (app.status === 'error') saveNow();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  if (findbar.open) findbar.close();
  else if (app.focus) setFocus(false);
});

// A web page can't learn a dropped file's path, so dropped documents are opened via the menu.
document.addEventListener(
  'drop',
  (event) => {
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.some((f) => /\.(md|markdown|mdown|mkd|txt)$/i.test(f.name))) {
      event.preventDefault();
      event.stopPropagation();
      toast('请用“文件 › 打开文件…”打开文档');
    }
  },
  true,
);
document.addEventListener('dragover', (event) => event.preventDefault());

api.on('menu', run);
api.on('open-path', ({ path, isDir }) => (isDir ? openFolder(path) : openFile(path)));
api.on('fs-changed', async ({ docChanged, dirs }) => {
  app.documents = null;
  await sidebar.refreshDirs(dirs);
  if (!docChanged || !app.doc.path || app.status === 'conflict') return;
  await app.saving;
  const check = await api.checkDocument().catch(() => null);
  if (!check || check.status === 'unchanged') return;
  if (check.status === 'missing') return showConflict('missing');
  if (app.pending) return showConflict('changed');
  await reloadFromDisk();
  toast('文件已在其他程序中修改，已载入最新内容');
});
api.on('close-requested', async ({ quitting }) => {
  await save();
  if (app.status === 'error' || app.status === 'conflict') {
    const message =
      app.status === 'error'
        ? `保存失败：${app.statusDetail}。仍要关闭吗？`
        : '文件已在其他程序中修改，你的更改还没有保存。仍要关闭吗？';
    if (!(await api.confirm('文档还没有保存', message, '仍要关闭'))) return api.cancelQuit();
  }
  if (!app.doc.path && app.hasDraftContent && !quitting) {
    const choice = await api.confirmCloseDraft();
    if (choice === 'cancel') return api.cancelQuit();
    if (choice === 'save' && !(await saveAs())) return api.cancelQuit();
    if (choice === 'discard') await api.draftDelete();
  }
  rememberPosition();
  api.closeWindow();
});
appWindow.onFocusChanged(({ payload: focused }) => {
  if (!focused) {
    save();
    rememberPosition();
  }
});
appWindow.onResized(async () => {
  document.documentElement.classList.toggle('fullscreen', await appWindow.isFullscreen());
});

function setupWindowControls() {
  const controls = $('window-controls');
  controls.hidden = false;
  const maximize = controls.querySelector('.maximize');
  controls.querySelector('.minimize').innerHTML = icons.minimize;
  controls.querySelector('.close').innerHTML = icons.closeWindow;
  const sync = async () => {
    const maximized = await appWindow.isMaximized();
    maximize.innerHTML = maximized ? icons.restore : icons.maximize;
    maximize.title = maximized ? '还原' : '最大化';
  };
  controls.querySelector('.minimize').addEventListener('click', () => appWindow.minimize());
  maximize.addEventListener('click', () => appWindow.toggleMaximize());
  controls.querySelector('.close').addEventListener('click', () => appWindow.close());
  appWindow.onResized(sync);
  sync();
}

// Startup

const init = await api.init();
document.documentElement.classList.add(init.platform);
if (!isMac) installShortcuts({ run, isRichEditor: () => app.editor?.kind === 'rich' });
if (init.platform === 'windows') setupWindowControls();
app.settings = { ...app.settings, ...init.settings };
app.recentFiles = init.recentFiles;
// Ask the shell once, before any editor mounts, whether AI is configured.
await ai.refresh();
applyPanels();
sidebar.setRecent(init.recentFiles, init.recentFolders);

const startup = init.startup;
if (startup.kind === 'file') await openFile(startup.path);
else if (startup.kind === 'folder') await setRoot(startup.path);
if (startup.kind === 'draft') {
  app.doc.draftId = startup.id;
  app.hasDraftContent = true;
  await mountEditor(startup.content);
  setStatus('draft');
  toast('已恢复上次未保存的草稿');
}
if (!app.editor) await mountEditor('');
updateTitle();
updateGuard();
app.editor.focus();
// Look for updates once, a little after startup, so opening the app stays fast.
setTimeout(() => updater.check(true), 5000);

// Lets tests/scenarios.sh drive the editor through ProseMirror's own input handling.
window.__mdpadDebug = app;
// Lets tests check the export output without a save dialog.
window.__mdpadExport = { html: buildExportHtml, print: preparePrintDocument };
