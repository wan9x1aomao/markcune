// File list: the window's folder as a lazily loaded tree, or recent items when no folder is open.
import { icons } from './icons.js';
import { basename, dirname, isInside, samePath, splitExtension } from './paths.js';
import { showMenu } from './ui.js';

/**
 * Options: api, revealLabel, onOpen(path), onOpenInNewWindow(path), onOpenFolder(path|undefined),
 * onNewDocument(dir), onRenamed(from, to).
 */
export function createSidebar(el, options) {
  const { api } = options;
  let root = null;
  let active = null;
  let renaming = null;
  let recent = { files: [], folders: [] };
  const expanded = new Set();
  const listings = new Map();
  // Rows are rebuilt on every render; the selection pill stays put so it can glide between rows.
  const list = document.createElement('div');
  const sel = Object.assign(document.createElement('div'), { className: 'tree-sel' });
  sel.style.opacity = '0';
  el.append(sel, list);

  const key = (path) => path.replace(/\\/g, '/').toLowerCase();

  async function load(dir) {
    try {
      listings.set(key(dir), await api.listDir(dir));
    } catch {
      listings.set(key(dir), []);
    }
  }

  function render() {
    const scrollTop = el.scrollTop;
    // FLIP: remember where rows were, rebuild, then let them glide from there (transform only).
    const before = new Map([...list.querySelectorAll('.tree-row[data-path]')].map((row) => [row.dataset.path, row.offsetTop]));
    list.replaceChildren();
    if (root) renderTree();
    else renderEmpty();
    el.scrollTop = scrollTop;
    if (before.size) {
      const rows = [...list.querySelectorAll('.tree-row[data-path]')];
      for (const row of rows) {
        const old = before.get(row.dataset.path);
        if (old === undefined) row.classList.add('entering');
        else if (old !== row.offsetTop) {
          row.style.transition = 'none';
          row.style.translate = `0 ${old - row.offsetTop}px`;
        }
      }
      void list.offsetHeight;
      for (const row of rows) {
        row.style.transition = '';
        row.style.translate = '';
        row.classList.remove('entering');
      }
    }
    placeSelection(before.size > 0);
  }

  function placeSelection(animate) {
    const row = list.querySelector('.tree-row.active');
    if (!row) {
      sel.style.opacity = '0';
      return;
    }
    if (!animate || sel.style.opacity === '0') sel.style.transition = 'none';
    sel.style.transform = `translateY(${row.offsetTop}px)`;
    sel.style.opacity = '1';
    void sel.offsetHeight;
    sel.style.transition = '';
  }

  function header(title, buttons = [], icon = null) {
    const head = document.createElement('div');
    head.className = 'panel-header';
    head.innerHTML = `${icon ? icons[icon] : ''}<span class="title"></span>`;
    head.querySelector('.title').textContent = title;
    for (const [icon, label, run] of buttons) {
      const button = document.createElement('button');
      button.className = 'icon-button';
      button.title = label;
      button.innerHTML = icons[icon];
      button.addEventListener('click', run);
      head.appendChild(button);
    }
    list.appendChild(head);
  }

  function renderTree() {
    header(
      basename(root),
      [
        ['plus', '新建文档', () => options.onNewDocument(root)],
        ['folder', '打开其他文件夹…', () => options.onOpenFolder()],
      ],
      'folder',
    );
    const entries = listings.get(key(root));
    if (entries && !entries.length) {
      list.appendChild(Object.assign(document.createElement('div'), { className: 'panel-empty', textContent: '这个文件夹里还没有 Markdown 文档。' }));
    }
    renderDir(root, 0);
  }

  function renderDir(dir, depth) {
    for (const entry of listings.get(key(dir)) ?? []) {
      const row = document.createElement('div');
      row.className = 'tree-row';
      row.style.paddingLeft = `${8 + depth * 14}px`;
      row.dataset.path = entry.path;
      const open = entry.isDir && expanded.has(key(entry.path));
      if (entry.isDir) {
        const chevron = document.createElement('span');
        chevron.className = 'chevron' + (open ? ' open' : '');
        chevron.innerHTML = icons.chevron;
        row.appendChild(chevron);
      } else {
        const kind = document.createElement('span');
        kind.className = 'kind';
        kind.innerHTML = icons.file;
        row.appendChild(kind);
      }
      if (renaming && samePath(renaming, entry.path)) {
        row.appendChild(renameInput(entry));
      } else {
        const [stem, ext] = entry.isDir ? [entry.name, ''] : splitExtension(entry.name);
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = stem;
        if (ext && ext.toLowerCase() !== '.md') {
          name.appendChild(Object.assign(document.createElement('span'), { className: 'ext', textContent: ext }));
        }
        row.appendChild(name);
        row.title = entry.name;
      }
      if (!entry.isDir && samePath(entry.path, active)) row.classList.add('active');
      row.addEventListener('click', () => (entry.isDir ? toggle(entry.path) : options.onOpen(entry.path)));
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        showMenu(contextItems(entry), { x: event.clientX, y: event.clientY });
      });
      list.appendChild(row);
      if (open) renderDir(entry.path, depth + 1);
    }
  }

  function contextItems(entry) {
    const common = [
      { label: '重命名…', run: () => startRename(entry.path) },
      { label: options.revealLabel, run: () => api.reveal(entry.path) },
    ];
    if (entry.isDir) return [{ label: '在此新建文档', run: () => options.onNewDocument(entry.path) }, 'separator', ...common];
    return [
      { label: '打开', run: () => options.onOpen(entry.path) },
      { label: '在新窗口中打开', run: () => options.onOpenInNewWindow(entry.path) },
      'separator',
      ...common,
    ];
  }

  function renameInput(entry) {
    const input = document.createElement('input');
    input.value = entry.name;
    input.spellcheck = false;
    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      renaming = null;
      const name = input.value.trim();
      if (commit && name && name !== entry.name) {
        try {
          const target = await api.renamePath(entry.path, name);
          await load(dirname(entry.path));
          options.onRenamed(entry.path, target);
        } catch (error) {
          options.onError?.(`无法重命名：${error}`);
        }
      }
      render();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) finish(true);
      if (event.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (event) => event.stopPropagation());
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(0, entry.isDir ? entry.name.length : splitExtension(entry.name)[0].length);
    });
    return input;
  }

  function renderEmpty() {
    header('文件');
    list.appendChild(
      Object.assign(document.createElement('div'), {
        className: 'panel-empty',
        textContent: '打开一个文件夹，就能在这里浏览其中的 Markdown 文档。',
      }),
    );
    const actions = document.createElement('div');
    actions.className = 'panel-actions';
    const button = Object.assign(document.createElement('button'), { className: 'text-button', textContent: '打开文件夹…' });
    button.addEventListener('click', () => options.onOpenFolder());
    actions.appendChild(button);
    list.appendChild(actions);

    const section = (title, items, run) => {
      if (!items.length) return;
      list.appendChild(Object.assign(document.createElement('div'), { className: 'panel-section', textContent: title }));
      for (const path of items) {
        const row = document.createElement('button');
        row.className = 'recent-row';
        row.title = path;
        row.appendChild(Object.assign(document.createElement('span'), { className: 'label', textContent: basename(path) }));
        row.appendChild(Object.assign(document.createElement('span'), { className: 'dir', textContent: basename(dirname(path)) }));
        row.addEventListener('click', () => run(path));
        list.appendChild(row);
      }
    };
    section('最近的文件夹', recent.folders, (path) => options.onOpenFolder(path));
    section('最近的文件', recent.files, (path) => options.onOpen(path));
  }

  async function toggle(dir) {
    if (expanded.has(key(dir))) {
      expanded.delete(key(dir));
    } else {
      expanded.add(key(dir));
      if (!listings.has(key(dir))) await load(dir);
    }
    render();
  }

  function startRename(path) {
    renaming = path;
    render();
  }

  return {
    get root() {
      return root;
    },
    async setRoot(path) {
      root = path;
      expanded.clear();
      listings.clear();
      if (root) await load(root);
      render();
    },
    setRecent(files, folders) {
      recent = { files, folders };
      if (!root) render();
    },
    /** Highlights the open document and expands the folders leading to it. */
    async setActive(path) {
      active = path;
      if (root && path && isInside(path, root)) {
        const chain = [];
        for (let dir = dirname(path); isInside(dir, root); dir = dirname(dir)) chain.unshift(dir);
        for (const dir of chain) {
          expanded.add(key(dir));
          if (!listings.has(key(dir))) await load(dir);
        }
      }
      render();
      list.querySelector('.tree-row.active')?.scrollIntoView({ block: 'nearest' });
    },
    async refreshDirs(dirs) {
      const stale = dirs.filter((dir) => listings.has(key(dir)));
      if (!stale.length) return;
      await Promise.all(stale.map(load));
      render();
    },
    async startRename(path) {
      await this.setActive(active);
      startRename(path);
    },
  };
}
