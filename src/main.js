import './style.css';
import { api, appWindow } from './bridge.js';
import { COMMANDS } from './commands.js';
import { createRichEditor } from './editor.js';
import { buildHtml } from './export.js';
import { createFindbar } from './findbar.js';
import { icons } from './icons.js';
import { createOutline } from './outline.js';
import { openPalette } from './palette.js';
import { basename, dirname, isInside, relative, samePath, splitExtension } from './paths.js';
import { installShortcuts } from './shortcuts.js';
import { createSidebar } from './sidebar.js';
import { createUpdater } from './update.js';
import { formatKeys, prompt, showMenu, toast } from './ui.js';

const AUTOSAVE_DELAY = 1000;
const isMac = navigator.userAgent.includes('Mac');
const $ = (id) => document.getElementById(id);
const els = {
  docName: $('doc-name'),
  status: $('save-status'),
  banner: $('banner'),
  sidebar: $('sidebar'),
  outline: $('outline'),
  richPane: $('rich-pane'),
  sourcePane: $('source-pane'),
  editorRoot: $('editor'),
  topbar: $('topbar'),
};

const app = {
  settings: { sidebar: true, outline: false },
  root: null,
  /** raw: the file as on disk; saved: the editor's markdown when it last matched the disk/draft. */
  doc: { path: null, draftId: null, raw: '', saved: '' },
  hasDraftContent: false,
  mode: 'rich',
  split: false,
  focus: false,
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
  app.status = status;
  app.statusDetail = detail;
  els.status.textContent = STATUS_TEXT[status];
  els.status.className = `status ${status}`;
  els.status.title = status === 'error' ? `${detail}\n点击重试` : '';
  els.status.previousElementSibling.hidden = !STATUS_TEXT[status];
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
  app.doc.saved = editor.getMarkdown();
  performance.mark('mdpad:mount-serialized');
  app.editor = editor;
  editor.setPosition(position);
  refreshOutline();
  findbar.refresh();
  performance.mark('mdpad:mount-done');
}

function onChange() {
  if (!app.editor) return;
  app.pending = true;
  if (app.status !== 'conflict') setStatus('saving');
  clearTimeout(app.saveTimer);
  app.saveTimer = setTimeout(() => save(), AUTOSAVE_DELAY);
  scheduleOutline();
  schedulePreview();
  updateGuard();
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
  performance.mark('mdpad:save-start');
  const content = app.editor.getMarkdown();
  performance.mark('mdpad:save-serialized');
  app.pending = false;
  try {
    if (app.doc.path) {
      if (content === app.doc.saved && !force) {
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
      app.doc.raw = content;
      hideBanner();
      setStatus(app.pending ? 'saving' : 'saved');
    } else if (content.trim() === '') {
      if (app.doc.draftId) await api.draftDelete();
      app.doc.draftId = null;
      app.doc.saved = content;
      app.hasDraftContent = false;
      setStatus('idle');
    } else {
      app.doc.draftId = await api.draftWrite(content);
      app.doc.saved = content;
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
  const content = app.editor.getMarkdown();
  let result;
  try {
    result = await api.saveAs(content);
  } catch (error) {
    toast(`保存失败：${error}`);
    return false;
  }
  if (!result) return false;
  app.doc = { path: result.path, draftId: null, raw: result.content, saved: content };
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

async function openFile(path) {
  if (samePath(path, app.doc.path)) return;
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
  app.doc = { path: opened.path, draftId: null, raw: opened.content, saved: '' };
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
  const current = app.editor.getMarkdown();
  // Unedited documents are shown exactly as stored on disk.
  const unchanged = app.editor.kind === 'rich' && current === app.doc.saved && app.doc.raw;
  const content = mode === 'source' && unchanged ? app.doc.raw : current;
  const pane = app.mode === 'source' ? els.sourcePane : els.richPane;
  const ratio = pane.scrollTop / Math.max(1, pane.scrollHeight - pane.clientHeight);
  const pending = app.pending;
  app.mode = mode;
  app.split = split;
  await mountEditor(content);
  if (pending) onChange();
  const next = mode === 'source' ? els.sourcePane : els.richPane;
  requestAnimationFrame(() => (next.scrollTop = ratio * (next.scrollHeight - next.clientHeight)));
  app.editor.focus();
}

function setPanel(name, visible) {
  app.settings[name] = visible;
  els.sidebar.hidden = !app.settings.sidebar;
  els.outline.hidden = !app.settings.outline;
  api.setSetting(name, visible);
  if (name === 'outline' && visible) refreshOutline();
}

function setFocus(on) {
  app.focus = on;
  document.body.classList.toggle('focus', on);
  document.body.classList.remove('reveal-topbar');
  app.editor?.focus();
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

async function exportHtml() {
  if (app.mode === 'source' && !app.split) await setMode('rich', false);
  const title = app.doc.path ? splitExtension(basename(app.doc.path))[0] : '未命名';
  const html = await buildHtml(els.editorRoot, title, embedImage);
  try {
    if (await api.exportHtml(html, `${title}.html`)) toast('已导出为网页');
  } catch (error) {
    toast(`导出失败：${error}`);
  }
}

async function exportPdf() {
  if (app.mode === 'source') await setMode('rich', false);
  toast('在打印窗口中选择“存储为 PDF”', 4000);
  api.print();
}

// Commands

const actions = {
  'new-window': () => api.newWindow(),
  'new-document': () => newDocument(),
  'open-file': openFileDialog,
  'open-folder': () => openFolder(),
  'quick-open': () => showPalette('files'),
  'command-palette': () => showPalette('all'),
  save: saveNow,
  'save-as': saveAs,
  rename: renameCurrent,
  reveal: () => (app.doc.path || app.root) && api.reveal(app.doc.path ?? app.root),
  'export-html': exportHtml,
  'export-pdf': exportPdf,
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
    commands: COMMANDS.map((c) => ({ title: c.title, hint: formatKeys(c.keys), run: () => run(c.id) })),
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
    ],
    anchor,
  );
}

// Wiring

const sidebar = createSidebar(els.sidebar, {
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

$('toggle-sidebar').innerHTML = icons.sidebar;
$('open-find').innerHTML = icons.search;
$('open-more').innerHTML = icons.more;
$('toggle-sidebar').title = `文件列表（${formatKeys('Mod+Shift+L')}）`;
$('open-find').title = `搜索（${formatKeys('Mod+F')}）`;
$('toggle-sidebar').addEventListener('click', () => run('toggle-sidebar'));
$('open-find').addEventListener('click', () => run('find'));
$('open-more').addEventListener('click', (event) => showMore(event.currentTarget));
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
els.sidebar.hidden = !app.settings.sidebar;
els.outline.hidden = !app.settings.outline;
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
