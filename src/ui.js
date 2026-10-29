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

export function hideToast() {
  clearTimeout(toastTimer);
  document.getElementById('toast').classList.remove('show');
}

let closeOpenMenu = null;

/**
 * Shows a popup menu at `anchor` (an element or {x, y}).
 * Items: { label, hint, checked, run } or 'separator'.
 * Options: { title } — a small heading above the items.
 *
 * The left gutter that holds the check mark is only reserved when some item can actually carry one;
 * a plain list of actions would otherwise sit behind an empty column.
 */
export function showMenu(items, anchor, options = {}) {
  closeOpenMenu?.();
  const checkable = items.some((item) => item !== 'separator' && item.checked !== undefined);
  const menu = document.createElement('div');
  menu.className = 'popup-menu' + (checkable ? ' with-check' : '');
  if (options.title) {
    const heading = document.createElement('div');
    heading.className = 'menu-title';
    heading.textContent = options.title;
    menu.appendChild(heading);
  }
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

  // The menu is drawn inside the window, so the window edge is a hard limit: whatever falls past it
  // can never be reached — not by scrolling the page, since there is no page to scroll. Long menus
  // (the whole app menu, or the skill list with custom instructions) are given the roomier side of
  // the anchor and scroll inside whatever room that side has.
  const margin = 8;
  const gap = 4;
  const rect = anchor instanceof Element ? anchor.getBoundingClientRect() : null;
  const below = rect ? rect.bottom + gap : anchor.y;
  const above = rect ? rect.top - gap : anchor.y;
  const spaceBelow = innerHeight - below - margin;
  const spaceAbove = above - margin;
  const natural = menu.offsetHeight;
  const flip = natural > spaceBelow && spaceAbove > spaceBelow;
  const room = Math.min(Math.max(120, flip ? spaceAbove : spaceBelow), innerHeight - margin * 2);
  if (natural > room) {
    menu.style.maxHeight = `${room}px`;
    menu.classList.add('scroll');
  }
  const height = Math.min(natural, room);
  const x = rect ? rect.right - menu.offsetWidth : anchor.x;
  const y = flip ? above - height : below;
  menu.style.left = `${Math.max(margin, Math.min(x, innerWidth - menu.offsetWidth - margin))}px`;
  menu.style.top = `${Math.max(margin, Math.min(y, innerHeight - height - margin))}px`;
  // Grow out of the corner nearest the anchor, or a menu pinned to a caret looks like it slides in
  // from the wrong side. Opening upwards mirrors that corner.
  const corner = rect ? 'right' : (anchor.origin ?? 'top left').endsWith('right') ? 'right' : 'left';
  menu.style.transformOrigin = `${flip ? 'bottom' : 'top'} ${corner}`;

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
