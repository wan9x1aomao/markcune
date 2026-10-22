// Command palette (⌘/Ctrl+K) and quick open (⌘/Ctrl+P).
const MAX_RESULTS = 60;

function score(item, query) {
  if (!query) return 0;
  const title = item.title.toLowerCase();
  if (title.startsWith(query)) return 0;
  if (title.includes(query)) return 1;
  // What makes the palette a directory instead of a memory test: "word", "pdf", "置顶" find the
  // command even when the title says 导出为 Word / 导出为 PDF / 置顶此文件.
  if (item.keywords?.toLowerCase().includes(query)) return 2;
  if (item.hint?.toLowerCase().includes(query)) return 3;
  return -1;
}

/**
 * mode: 'all' (commands and files) or 'files'.
 * commands: [{ title, hint, keywords?, common?, run }]; files(): Promise<[{ title, hint, run }]>;
 * recent: same shape.
 */
export function openPalette({ mode, commands, files, recent }) {
  document.querySelector('.overlay.palette-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'overlay palette-overlay';
  overlay.innerHTML = '<div class="palette"><input spellcheck="false" /><div class="results"></div></div>';
  const input = overlay.querySelector('input');
  const results = overlay.querySelector('.results');
  input.placeholder = mode === 'files' ? '输入文件名' : '输入命令或文件名';
  document.body.appendChild(overlay);
  input.focus();

  let fileItems = null;
  let shown = [];
  let selected = 0;
  files().then((items) => {
    fileItems = items;
    render();
  });

  function render() {
    const query = input.value.trim().toLowerCase();
    const groups = [];
    const pick = (items) =>
      items
        .map((item) => ({ item, s: score(item, query) }))
        .filter(({ s }) => s >= 0)
        .sort((a, b) => a.s - b.s)
        .map(({ item }) => item);
    if (mode === 'all') {
      if (query) groups.push(['命令', pick(commands)]);
      else {
        // Nothing typed yet: start people at the few entries a document needs, and keep the rest
        // right below so the palette still reads as the complete function list.
        groups.push(['常用', pick(commands.filter((item) => item.common))]);
        groups.push(['全部命令', pick(commands.filter((item) => !item.common))]);
      }
    }
    if (!query && recent.length) groups.push(['最近的文件', recent]);
    if (query || mode === 'files') {
      const recentTitles = new Set(query ? [] : recent.map((r) => r.hint + r.title));
      groups.push(['文件', pick((fileItems ?? []).filter((f) => !recentTitles.has(f.hint + f.title)))]);
    }

    results.replaceChildren();
    shown = [];
    for (const [title, items] of groups) {
      const visible = items.slice(0, MAX_RESULTS);
      if (!visible.length) continue;
      results.appendChild(Object.assign(document.createElement('div'), { className: 'group', textContent: title }));
      for (const item of visible) {
        const index = shown.length;
        const row = document.createElement('button');
        row.className = 'result';
        row.innerHTML = '<span class="label"></span><span class="hint"></span>';
        row.querySelector('.label').textContent = item.title;
        row.querySelector('.hint').textContent = item.hint ?? '';
        row.addEventListener('mousemove', () => select(index));
        row.addEventListener('click', () => choose(index));
        results.appendChild(row);
        shown.push({ item, row });
      }
    }
    if (!shown.length) {
      const text = fileItems === null && mode === 'files' ? '正在查找文件…' : '没有找到匹配的内容';
      results.appendChild(Object.assign(document.createElement('div'), { className: 'empty', textContent: text }));
    }
    select(0);
  }

  function select(index) {
    selected = Math.max(0, Math.min(index, shown.length - 1));
    shown.forEach(({ row }, i) => row.classList.toggle('selected', i === selected));
    shown[selected]?.row.scrollIntoView({ block: 'nearest' });
  }

  function choose(index) {
    const entry = shown[index];
    close();
    entry?.item.run();
  }

  function close() {
    overlay.remove();
  }

  input.addEventListener('input', render);
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown') select(selected + 1);
    else if (event.key === 'ArrowUp') select(selected - 1);
    else if (event.key === 'Enter') choose(selected);
    else if (event.key === 'Escape') close();
    else return;
    event.preventDefault();
  });
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close();
  });
  render();
}
