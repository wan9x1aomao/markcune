// Small UI pieces: toast, popup menu, text prompt, shortcut labels.

const isMac = navigator.userAgent.includes('Mac');

/** "Mod+Shift+S" → "⇧⌘S" on macOS, "Ctrl+Shift+S" elsewhere. */
export function formatKeys(keys) {
  if (!keys) return '';
  const parts = keys.split('+');
  if (!isMac) return parts.map((p) => (p === 'Mod' ? 'Ctrl' : p)).join('+');
  const order = ['Ctrl', 'Alt', 'Shift', 'Mod'];
  const symbols = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘' };
  const modifiers = parts.filter((p) => symbols[p]).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const key = parts.filter((p) => !symbols[p]).join('');
  return modifiers.map((m) => symbols[m]).join('') + key;
}

let toastTimer;
export function toast(message, duration = 2400) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

let closeOpenMenu = null;

/**
 * Shows a popup menu at `anchor` (an element or {x, y}).
 * Items: { label, hint, checked, run } or 'separator'.
 */
export function showMenu(items, anchor) {
  closeOpenMenu?.();
  const menu = document.createElement('div');
  menu.className = 'popup-menu';
  for (const item of items) {
    if (item === 'separator') {
      menu.appendChild(Object.assign(document.createElement('div'), { className: 'separator' }));
      continue;
    }
    const button = document.createElement('button');
    button.className = 'item' + (item.checked ? ' checked' : '');
    button.innerHTML = '<span class="label"></span><span class="hint"></span>';
    button.querySelector('.label').textContent = item.label;
    button.querySelector('.hint').textContent = item.hint ?? '';
    button.addEventListener('click', () => {
      close();
      item.run();
    });
    menu.appendChild(button);
  }
  document.body.appendChild(menu);

  const rect = anchor instanceof Element ? anchor.getBoundingClientRect() : null;
  const x = rect ? rect.right - menu.offsetWidth : anchor.x;
  const y = rect ? rect.bottom + 4 : anchor.y;
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8))}px`;

  const onPointer = (event) => {
    if (!menu.contains(event.target)) close();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  function close() {
    menu.remove();
    document.removeEventListener('mousedown', onPointer, true);
    document.removeEventListener('keydown', onKey, true);
    closeOpenMenu = null;
  }
  setTimeout(() => {
    document.addEventListener('mousedown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
  });
  closeOpenMenu = close;
  return close;
}

/** Asks for a line of text. Resolves to the text, or null if cancelled. */
export function prompt({ title, value = '', okLabel = '确定', selectEnd }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `
      <div class="prompt">
        <div class="title"></div>
        <input spellcheck="false" />
        <div class="buttons">
          <button class="text-button cancel">取消</button>
          <button class="text-button primary ok"></button>
        </div>
      </div>`;
    overlay.querySelector('.title').textContent = title;
    overlay.querySelector('.ok').textContent = okLabel;
    const input = overlay.querySelector('input');
    input.value = value;
    document.body.appendChild(overlay);
    input.focus();
    input.setSelectionRange(0, selectEnd ?? value.length);

    const finish = (result) => {
      overlay.remove();
      resolve(result);
    };
    overlay.querySelector('.ok').addEventListener('click', () => finish(input.value));
    overlay.querySelector('.cancel').addEventListener('click', () => finish(null));
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) finish(null);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) finish(input.value);
      if (event.key === 'Escape') finish(null);
    });
  });
}
