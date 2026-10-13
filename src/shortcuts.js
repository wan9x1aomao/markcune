// Keyboard shortcuts on Windows and Linux, which have no native menu bar to handle them.
// macOS gets these from the native menu (src-tauri/src/main.rs).
import { COMMANDS } from './commands.js';

// Shortcuts that live only in the native menu on macOS.
const EXTRA = {
  'Mod+N': 'new-window',
  'Mod+K': 'command-palette',
  'Mod+G': 'find-next',
  'Mod+Shift+G': 'find-previous',
  'Mod+=': 'zoom-in',
  'Mod+-': 'zoom-out',
  'Mod+0': 'zoom-reset',
  F11: 'fullscreen',
};
// The editors already handle these themselves in rich mode.
const EDITOR_KEYS = new Set(['bold', 'italic', 'strikethrough', 'inline-code']);

const CODE_KEYS = { Slash: '/', Equal: '=', Minus: '-', NumpadAdd: '=', NumpadSubtract: '-' };

function keyOf(event) {
  const code = event.code;
  let key = CODE_KEYS[code] ?? (/^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit\d$/.test(code) ? code.slice(5) : event.key);
  if (/^F\d+$/.test(event.key)) key = event.key;
  const parts = [];
  if (event.ctrlKey) parts.push('Mod');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

/** `run(id)` runs a command; `isRichEditor()` tells whether the editor handles formatting keys. */
export function installShortcuts({ run, isRichEditor }) {
  const table = { ...EXTRA };
  for (const command of COMMANDS) {
    if (command.keys) table[command.keys.replace('Ctrl+', 'Mod+')] = command.id;
  }
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.isComposing || event.metaKey) return;
      const id = table[keyOf(event)];
      if (!id || (EDITOR_KEYS.has(id) && isRichEditor())) return;
      event.preventDefault();
      event.stopPropagation();
      run(id);
    },
    true,
  );
}
