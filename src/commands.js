// Commands shared by the native menu, the "···" menu and the command palette.
// Shortcuts mirror the native menu in src-tauri/src/main.rs.

const isMac = navigator.userAgent.includes('Mac');

export const COMMANDS = [
  { id: 'new-window', title: '新建窗口', keys: 'Mod+N' },
  { id: 'new-document', title: '在文件夹中新建文档' },
  { id: 'open-file', title: '打开文件…', keys: 'Mod+O' },
  { id: 'open-folder', title: '打开文件夹…', keys: 'Mod+Shift+O' },
  { id: 'open-from-url', title: '从链接打开…' },
  { id: 'quick-open', title: '快速打开…', keys: 'Mod+P' },
  { id: 'save', title: '保存', keys: 'Mod+S' },
  { id: 'save-as', title: '另存为…', keys: 'Mod+Shift+S' },
  { id: 'rename', title: '重命名…' },
  { id: 'reveal', title: isMac ? '在访达中显示' : '在资源管理器中显示' },
  { id: 'export-html', title: '导出为网页…' },
  { id: 'export-pdf', title: '导出为 PDF…' },
  { id: 'tidy', title: '一键整理格式', keys: 'Mod+Alt+L' },
  { id: 'ai-settings', title: 'AI 设置…' },
  { id: 'find', title: '查找…', keys: 'Mod+F' },
  { id: 'replace', title: '替换…', keys: isMac ? 'Mod+Alt+F' : 'Ctrl+H' },
  { id: 'bold', title: '加粗', keys: 'Mod+B' },
  { id: 'italic', title: '斜体', keys: 'Mod+I' },
  { id: 'strikethrough', title: '删除线', keys: 'Mod+Alt+X' },
  { id: 'inline-code', title: '行内代码', keys: 'Mod+E' },
  { id: 'toggle-source', title: '源码模式', keys: 'Mod+/' },
  { id: 'toggle-split', title: '分屏预览', keys: 'Mod+Alt+/' },
  { id: 'toggle-focus', title: '专注模式', keys: 'F8' },
  { id: 'toggle-sidebar', title: '文件列表', keys: 'Mod+Shift+L' },
  { id: 'toggle-outline', title: '大纲', keys: 'Mod+Shift+T' },
  { id: 'command-palette', title: '命令面板…', keys: 'Mod+K' },
  { id: 'check-update', title: '检查更新…' },
  { id: 'changelog', title: '更新日志' },
  { id: 'close', title: '关闭窗口', keys: 'Mod+W' },
];

export const commandById = Object.fromEntries(COMMANDS.map((c) => [c.id, c]));
