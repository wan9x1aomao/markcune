// What the page puts in front of people: the "常用" group in the command palette and the grouped
// reference behind 键盘快捷键与功能. Kept out of main.js so tests (and the help panel) can read the
// same definitions without booting the app.
import { COMMANDS } from './commands.js';
import { formatKeys } from './ui.js';

/** The handful a new user needs first; everything else is one search away. */
export const COMMON_COMMANDS = [
  'open-folder',
  'open-file',
  'open-from-url',
  'quick-open',
  'tidy',
  'export-word',
  'settings',
  'help',
];

const isCommon = (command) => COMMON_COMMANDS.includes(command.id);

/** Palette items: the fields `openPalette` understands, plus `common` for the empty-query grouping. */
export function paletteCommands(run) {
  return COMMANDS.map((command) => ({
    title: command.title,
    hint: formatKeys(command.keys),
    keywords: command.keywords ?? '',
    common: isCommon(command),
    run: () => run(command.id),
  }));
}

/** Order the sections by the order people meet the features; unknown groups sort last. */
const GROUP_ORDER = ['文件', '编辑', '格式', '导出', '显示', 'AI 与语音', '设置与帮助'];
const rank = (title) => {
  const index = GROUP_ORDER.indexOf(title);
  return index === -1 ? GROUP_ORDER.length : index;
};

/** [{ title, commands }] — every command exactly once, in its group. */
export function helpGroups() {
  const groups = new Map();
  for (const command of COMMANDS) {
    const title = command.group ?? '其他';
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title).push(command);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([title, commands]) => ({ title, commands }));
}
