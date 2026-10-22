// 键盘快捷键与功能：a one-page reference grouped by what people are trying to do. Rows are
// buttons — reading "导出为 PDF" and then hunting for it again is worse than clicking it.
//
// The list is generated from the command registry, so a new command shows up here (and in the
// palette) without anyone remembering to update a second document.
import { helpGroups } from './discovery.js';
import { formatKeys } from './ui.js';

export function openHelp({ run, onClose } = {}) {
  document.querySelector('.overlay.help-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'overlay help-overlay';
  overlay.innerHTML = `
    <div class="help-panel" role="dialog" aria-label="键盘快捷键与功能">
      <header>
        <h2>键盘快捷键与功能</h2>
        <button class="help-close" type="button" aria-label="关闭">×</button>
      </header>
      <p class="help-lead">点一行直接执行。也可以随时用命令面板搜功能名或英文名，比如「导出」「word」「置顶」。</p>
      <div class="help-groups"></div>
    </div>`;
  const host = overlay.querySelector('.help-groups');

  for (const group of helpGroups()) {
    const section = document.createElement('section');
    section.className = 'help-group';
    const heading = document.createElement('h3');
    heading.textContent = group.title;
    section.appendChild(heading);
    for (const command of group.commands) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'help-row';
      row.innerHTML = '<span class="label"></span><span class="keys"></span>';
      row.querySelector('.label').textContent = command.title;
      row.querySelector('.keys').textContent = formatKeys(command.keys);
      row.addEventListener('click', () => {
        close();
        run?.(command.id);
      });
      section.appendChild(row);
    }
    host.appendChild(section);
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
  overlay.querySelector('.help-close').addEventListener('click', close);
  document.body.appendChild(overlay);

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  }
  return close;
}
