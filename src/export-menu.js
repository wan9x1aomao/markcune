// The four export actions live behind one menu entry. Labels stay the command titles, so the
// drawer, the command palette and 键盘快捷键与功能 cannot drift apart.
import { COMMANDS } from './commands.js';

const EXPORT_IDS = ['export-html', 'export-word', 'export-pdf', 'export-image'];

/**
 * Opens the export drawer. `run(id)` is the same command runner the menus use.
 * Returns a close function.
 */
export function openExportDrawer({ run, onClose } = {}) {
  document.querySelector('.overlay.export-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'overlay export-overlay';
  overlay.innerHTML = `
    <div class="export-drawer" role="dialog" aria-modal="true" aria-label="导出">
      <header>
        <h2>导出</h2>
        <button class="export-close" type="button" aria-label="关闭">×</button>
      </header>
      <div class="export-list"></div>
    </div>`;

  const list = overlay.querySelector('.export-list');
  for (const id of EXPORT_IDS) {
    const command = COMMANDS.find((item) => item.id === id);
    if (!command) continue;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'export-row';
    row.textContent = command.title;
    row.addEventListener('click', () => {
      close();
      run?.(id);
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
  overlay.querySelector('.export-row')?.focus();

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  }
  return close;
}
