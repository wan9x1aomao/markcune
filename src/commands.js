// Commands shared by the native menu, the "···" menu and the command palette.
// Shortcuts mirror the native menu in src-tauri/src/main.rs.
//
// `group` places the command in 键盘快捷键与功能; `keywords` is what makes it findable when the
// user does not remember the exact wording ("word", "pdf", "置顶"). Both are checked by the
// browser tests: a command missing either is a feature nobody can discover.

const isMac = navigator.userAgent.includes('Mac');

export const COMMANDS = [
  // ---- 文件
  { id: 'new-window', group: '文件', title: '新建窗口', keys: 'Mod+N', keywords: '新窗口 new window 开窗' },
  { id: 'new-document', group: '文件', title: '在文件夹中新建文档', keywords: '新建文档 new document file 新建文件' },
  { id: 'open-file', group: '文件', title: '打开文件…', keys: 'Mod+O', keywords: '打开文件 open file md' },
  { id: 'open-folder', group: '文件', title: '打开文件夹…', keys: 'Mod+Shift+O', keywords: '文件夹 folder directory 目录 工作区' },
  { id: 'open-from-url', group: '文件', title: '从链接打开…', keywords: '链接 link url 网址 github x 推特 帖子 下载' },
  { id: 'quick-open', group: '文件', title: '快速打开…', keys: 'Mod+P', keywords: '快速打开 quick open 找文件 搜索文件' },
  { id: 'save', group: '文件', title: '保存', keys: 'Mod+S', keywords: '保存 save' },
  { id: 'save-as', group: '文件', title: '另存为…', keys: 'Mod+Shift+S', keywords: '另存为 save as 存到' },
  { id: 'rename', group: '文件', title: '重命名…', keywords: '重命名 rename 改名' },
  { id: 'pin-file', group: '文件', title: '置顶此文件', keywords: '置顶 pin bookmark 收藏 常用 固定' },
  { id: 'unpin-file', group: '文件', title: '取消置顶', keywords: '取消置顶 unpin 移出 取消收藏' },
  { id: 'reveal', group: '文件', title: isMac ? '在访达中显示' : '在资源管理器中显示', keywords: '访达 finder 资源管理器 reveal 显示位置' },
  { id: 'close', group: '文件', title: '关闭窗口', keys: 'Mod+W', keywords: '关闭窗口 close window 关掉' },

  // ---- 编辑
  { id: 'find', group: '编辑', title: '查找…', keys: 'Mod+F', keywords: '查找 find 搜索 search' },
  { id: 'replace', group: '编辑', title: '替换…', keys: isMac ? 'Mod+Alt+F' : 'Ctrl+H', keywords: '替换 replace 查找替换' },
  { id: 'bold', group: '编辑', title: '加粗', keys: 'Mod+B', keywords: '加粗 bold 粗体' },
  { id: 'italic', group: '编辑', title: '斜体', keys: 'Mod+I', keywords: '斜体 italic 倾斜' },
  { id: 'strikethrough', group: '编辑', title: '删除线', keys: 'Mod+Alt+X', keywords: '删除线 strikethrough 划掉' },
  { id: 'inline-code', group: '编辑', title: '行内代码', keys: 'Mod+E', keywords: '行内代码 inline code 代码' },

  // ---- 格式
  { id: 'tidy', group: '格式', title: '一键整理格式', keys: 'Mod+Alt+L', keywords: '整理 排版 tidy format 格式化 标题 列表 引用' },

  // ---- 导出
  { id: 'export-html', group: '导出', title: '导出为网页…', keywords: '导出 网页 html web 单文件 export' },
  { id: 'export-word', group: '导出', title: '导出为 Word…', keywords: '导出 word docx 文档 export' },
  { id: 'export-pdf', group: '导出', title: '导出为 PDF…', keywords: '导出 pdf 打印 print export' },
  { id: 'export-image', group: '导出', title: '导出为图片…', keywords: '导出 图片 长图 png 截图 分享 image picture screenshot export' },

  // ---- 显示
  { id: 'toggle-source', group: '显示', title: '源码模式', keys: 'Mod+/', keywords: '源码 source markdown 原文' },
  { id: 'toggle-split', group: '显示', title: '分屏预览', keys: 'Mod+Alt+/', keywords: '分屏 split 预览 preview' },
  { id: 'toggle-focus', group: '显示', title: '专注模式', keys: 'F8', keywords: '专注 focus 沉浸 无干扰' },
  { id: 'toggle-sidebar', group: '显示', title: '文件列表', keys: 'Mod+Shift+L', keywords: '文件列表 sidebar 侧栏 面板' },
  { id: 'toggle-outline', group: '显示', title: '大纲', keys: 'Mod+Shift+T', keywords: '大纲 outline 目录 章节' },
  { id: 'theme-toggle', group: '显示', title: '切换浅色 / 深色', keys: 'Mod+Shift+D', keywords: '主题 深色 浅色 dark light 外观' },
  { id: 'command-palette', group: '显示', title: '命令面板…', keys: 'Mod+K', keywords: '命令面板 command palette 全部功能 搜命令' },
  { id: 'zoom-in', group: '显示', title: '放大', keys: 'Mod+=', keywords: '放大 zoom in 字号' },
  { id: 'zoom-out', group: '显示', title: '缩小', keys: 'Mod+-', keywords: '缩小 zoom out 字号' },
  { id: 'zoom-reset', group: '显示', title: '实际大小', keys: 'Mod+0', keywords: '实际大小 zoom reset 100%' },
  { id: 'fullscreen', group: '显示', title: '切换全屏幕', keywords: '全屏 fullscreen 全屏幕' },

  // ---- AI 与语音
  { id: 'ai-settings', group: 'AI 与语音', title: 'AI 设置…', keywords: 'ai 设置 模型 服务商 key 写作助手' },
  { id: 'voice-settings', group: 'AI 与语音', title: '语音设置…', keywords: '语音 录音 麦克风 voice 转写 识别' },

  // ---- 设置与帮助
  { id: 'settings', group: '设置与帮助', title: '设置…', keys: 'Mod+,', keywords: '设置 preferences 偏好 外观' },
  { id: 'help', group: '设置与帮助', title: '键盘快捷键与功能…', keywords: '帮助 help 快捷键 shortcuts 功能一览 手册 说明' },
  { id: 'check-update', group: '设置与帮助', title: '检查更新…', keywords: '更新 update 检查升级 版本' },
  { id: 'changelog', group: '设置与帮助', title: '更新日志', keywords: '更新日志 changelog 版本历史 release' },
  { id: 'licenses', group: '设置与帮助', title: '开源许可', keywords: '开源许可 licenses 第三方 third-party 版权 copyright 组件' },
  { id: 'website', group: '设置与帮助', title: 'MarkCune 官网', keywords: '官网 website 主页 下载 homepage' },
];

export const commandById = Object.fromEntries(COMMANDS.map((c) => [c.id, c]));
