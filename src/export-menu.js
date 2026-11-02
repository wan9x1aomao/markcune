// The four export actions live behind one menu entry. Titles come from the command list
// (the trailing ellipsis is only for the menu item that opens a dialog). Subtitles describe
// what that export actually writes.
import { COMMANDS } from './commands.js';

const CHEVRON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 7 5 5-5 5"/></svg>`;
const CLOSE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>`;

const FORMATS = [
  {
    id: 'export-html',
    kind: 'web',
    detail: '单文件 HTML，图片嵌在页内',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M4 12h16"/><path d="M12 4a12 12 0 0 1 0 16 12 12 0 0 1 0-16z"/></svg>`,
  },
  {
    id: 'export-word',
    kind: 'word',
    detail: '.docx，标题、列表和表格可再编辑',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3.5h6.8L19 8.6V20a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 6 20V5A1.5 1.5 0 0 1 7.5 3.5z"/><path d="M13.5 3.5V8.5H19"/><path d="M9 12.5h6M9 16h4.5"/></svg>`,
  },
  {
    id: 'export-pdf',
    kind: 'pdf',
    detail: '通过系统打印存成 PDF',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 8.5V4.5h10v4"/><rect x="5" y="8.5" width="14" height="7.5" rx="1.6"/><path d="M8 16v3.5h8V16"/></svg>`,
  },
  {
    id: 'export-image',
    kind: 'image',
    detail: 'PNG 长图，太长会按段分开',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.3"/><path d="m7 16.5 3.1-3.1a1 1 0 0 1 1.4 0L15.5 17"/><path d="m13.8 15.2 1.1-1.1a1 1 0 0 1 1.4 0L19.5 17"/></svg>`,
  },
];

/** Menu titles end with … because they open a dialog. The drawer row does not. */
function rowTitle(title) {
  return String(title ?? '').replace(/[…]+$/, '').replace(/\.{3}$/, '');
}

/**
 * Opens the export drawer. `run(id)` is the same command runner the menus use.
 * Returns a close function. Nothing is focused on open — a focus ring there reads as a bug.
 */
export function openExportDrawer({ run, onClose } = {}) {
  document.querySelector('.overlay.export-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'overlay export-overlay';
  overlay.innerHTML = `
    <div class="export-drawer" role="dialog" aria-modal="true" aria-label="导出">
      <header>
        <h2>导出</h2>
        <button class="export-close" type="button" aria-label="关闭">${CLOSE}</button>
      </header>
      <div class="export-list"></div>
    </div>`;

  const list = overlay.querySelector('.export-list');
  for (const format of FORMATS) {
    const command = COMMANDS.find((item) => item.id === format.id);
    if (!command) continue;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'export-row';
    row.innerHTML = `
      <span class="export-glyph ${format.kind}">${format.icon}</span>
      <span class="export-copy">
        <span class="export-name"></span>
        <span class="export-desc"></span>
      </span>
      <span class="export-chevron">${CHEVRON}</span>`;
    row.querySelector('.export-name').textContent = rowTitle(command.title);
    row.querySelector('.export-desc').textContent = format.detail;
    row.addEventListener('click', () => {
      close();
      run?.(format.id);
    });
    list.appendChild(row);
  }

  const onKey = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close();
  });
  overlay.querySelector('.export-close').addEventListener('click', close);
  document.body.appendChild(overlay);

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  }
  return close;
}
