// The WYSIWYG editor (Milkdown Crepe), configured in Chinese.
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { EditorView } from '@codemirror/view';
import { Crepe } from '@milkdown/crepe';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';
import { commandsCtx, editorViewCtx } from '@milkdown/kit/core';
import { redoCommand, undoCommand } from '@milkdown/kit/plugin/history';
import { listener } from '@milkdown/kit/plugin/listener';
import {
  addBlockTypeCommand,
  clearTextInCurrentBlockCommand,
  codeBlockSchema,
  syncHeadingIdPlugin,
  syncListOrderPlugin,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleStrongCommand,
} from '@milkdown/kit/preset/commonmark';
import { toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm';
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import { $prose, callCommand, replaceAll } from '@milkdown/kit/utils';
import { ghostControls, ghostFeature } from './ai-ghost.js';
import { proposalFeature } from './ai-proposal.js';
import { slashItems } from './ai-skills.js';
import { createLazy, lazyController } from './lazy.js';
import { preserveMarkdown } from './markdown.js';
import { codeTheme } from './code-theme.js';
import { countMarkdownWords } from './count.js';
import { chunkedParsing } from './parse.js';
import { incrementalSerializer } from './serialize.js';
import {
  findKey,
  findPlugin,
  imageActions,
  linkPaste,
  markdownMarkers,
  syncHeadingIds,
  syncListOrder,
} from './plugins.js';

const LANGUAGE_NAMES = { latex: '公式', mermaid: '流程图', text: '纯文本', plaintext: '纯文本', '': '纯文本' };
/**
 * Canonical name for a fence language: exact name, then alias, then file extension ("py" → Python).
 * The fuzzy matcher is tried last by the caller — it is loose enough to pick "C" for "C++".
 */
const exactLanguageName = (language) => {
  const key = language.toLowerCase();
  const hit = languages.find(
    (desc) =>
      desc.name.toLowerCase() === key ||
      desc.alias.some((alias) => alias.toLowerCase() === key) ||
      desc.extensions.some((extension) => extension.toLowerCase() === key),
  );
  return hit?.name;
};
/** Chinese names for special blocks, proper names ("Python", "C++") for the rest. */
const languageLabel = (language) =>
  LANGUAGE_NAMES[language.toLowerCase()] ??
  exactLanguageName(language) ??
  LanguageDescription.matchLanguageName(languages, language, true)?.name ??
  language;

/**
 * Mermaid has no CodeMirror grammar, so `@codemirror/language-data` never offered it in the language
 * picker — the block was reachable only by typing a ```mermaid fence. Register it here: no syntax
 * highlighting (the block draws the diagram instead), but the aliases make it searchable.
 */
const DIAGRAM_LANGUAGE = LanguageDescription.of({
  name: 'mermaid',
  alias: ['mermaid', '流程图', 'flowchart', 'flow', '图表'],
  load: () => Promise.resolve(undefined),
});

/**
 * Copies for the picker. Crepe deep-merges its feature config with lodash, and that merge writes
 * into the arrays it is handed: pointing it at `languages` itself pushed other languages' aliases
 * onto innocent entries (C ended up with "c++", Go with "html"), so the list searched and labelled
 * wrongly. Copies keep the shared data pristine.
 */
const languageCopy = (description, extraAliases = []) =>
  LanguageDescription.of({
    name: description.name,
    alias: [...new Set([...description.alias, ...extraAliases])],
    support: description.support,
    load: () => description.load(),
  });

/** Chinese aliases so that 「公式」 finds LaTeX — the picker filters by name/alias, not by label. */
const MATH_ALIASES = ['公式', '数学公式', '数学', 'math', 'formula'];

/** Everything the picker offers: the CodeMirror language list, plus the diagram entry at the top. */
const CODE_LANGUAGES = [
  DIAGRAM_LANGUAGE,
  ...languages.map((description) =>
    languageCopy(description, description.name.toLowerCase() === 'latex' ? MATH_ALIASES : []),
  ),
];

/**
 * Label inside the picker. The list already holds exact names, so only the special blocks need
 * translating — running them through `languageLabel` fuzzy-matched "C++" down to "C" and "JSON" to
 * "Jinja", which made the list look like it had duplicates.
 */
const pickerLabel = (language) => LANGUAGE_NAMES[language.toLowerCase()] ?? language;

// Menu icons: strokes only, 24×24. The `fill: none` has to be inline — the menu stylesheet sets
// `fill` on the svg element for Crepe's solid glyphs, which would turn these outlines into blobs.
const icon = (shapes) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" style="fill:none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${shapes}</svg>`;

const FLOW_ICON = icon(`
  <rect x="9" y="2.5" width="6" height="4.6" rx="1.2"/>
  <rect x="2.5" y="16.4" width="6" height="4.6" rx="1.2"/>
  <rect x="15.5" y="16.4" width="6" height="4.6" rx="1.2"/>
  <path d="M12 7.1v5.2M5.5 12.3h13M5.5 12.3v4.1M18.5 12.3v4.1"/>`);
const SEQUENCE_ICON = icon(`
  <rect x="2" y="2.5" width="8" height="4.5" rx="1.2"/>
  <rect x="14" y="2.5" width="8" height="4.5" rx="1.2"/>
  <path d="M6 7v13M18 7v13M9.5 11h5.5M13.4 9.6l1.6 1.4-1.6 1.4"/>`);
const GANTT_ICON = icon(`<path stroke-width="3" d="M4 6.5h8M4 12h13M4 17.5h5.5"/>`);
const PIE_ICON = icon(`<circle cx="12" cy="12" r="8.5"/><path d="M12 12V3.5M12 12l7.2 4.4"/>`);
const CLASS_ICON = icon(`
  <rect x="4.5" y="2.5" width="15" height="19" rx="2"/>
  <path d="M4.5 8.5h15M8 12.5h5.5M8 16.5h8"/>`);
const FORMULA_ICON = icon(`<path d="M16.5 5h-9l4.5 7-4.5 7h9"/>`);
/** AI commands in the slash menu: a four-point spark, the same idea as the "AI" pill. */
const AI_ICON = icon(`<path d="M12 3.4l1.8 4.7 4.7 1.8-4.7 1.8-1.8 4.7-1.8-4.7-4.7-1.8 4.7-1.8z"/><path d="M18.4 15.4l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>`);

/**
 * What the slash menu can insert besides plain text: a fenced block of `language` with a sample
 * inside. The sample matters — an empty mermaid block only shows an error and an empty LaTeX block
 * shows nothing at all — and `selectSnippet` selects it, so the first keystroke replaces it.
 */
const FORMULA_SNIPPET = { label: '公式', language: 'LaTeX', starter: 'E = mc^2', icon: FORMULA_ICON };

const DIAGRAM_SNIPPETS = [
  { key: 'diagram-flow', label: '流程图', language: 'mermaid', starter: 'graph LR\n  开始 --> 结束', icon: FLOW_ICON },
  {
    key: 'diagram-sequence',
    label: '时序图',
    language: 'mermaid',
    starter: 'sequenceDiagram\n  用户->>应用: 打开文档\n  应用-->>用户: 显示内容',
    icon: SEQUENCE_ICON,
  },
  {
    key: 'diagram-gantt',
    label: '甘特图',
    language: 'mermaid',
    starter:
      'gantt\n  title 写作计划\n  dateFormat YYYY-MM-DD\n  axisFormat %m-%d\n  section 初稿\n  第一章 :a1, 2026-01-05, 10d\n  第二章 :a2, after a1, 10d\n  section 定稿\n  通读全稿 :a3, after a2, 7d',
    icon: GANTT_ICON,
  },
  {
    key: 'diagram-pie',
    label: '饼图',
    language: 'mermaid',
    starter: 'pie title 时间分配\n  "写作" : 60\n  "修改" : 30\n  "其他" : 10',
    icon: PIE_ICON,
  },
  {
    key: 'diagram-class',
    label: '类图',
    language: 'mermaid',
    starter: 'classDiagram\n  class 文档 {\n    +String 标题\n    +save() 保存\n  }',
    icon: CLASS_ICON,
  },
];

/** The code block's language button shows the raw name (or "Text"); show Chinese names instead. */
function relabelLanguageButtons(root) {
  for (const button of root.querySelectorAll('.language-button')) {
    const text = [...button.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
    const label = text && languageLabel(text.nodeValue.trim());
    if (label && label !== text.nodeValue) text.nodeValue = label;
  }
}

const COMMANDS = {
  bold: toggleStrongCommand,
  italic: toggleEmphasisCommand,
  strikethrough: toggleStrikethroughCommand,
  'inline-code': toggleInlineCodeCommand,
  undo: undoCommand,
  redo: redoCommand,
};

/**
 * Selects the sample inside the block that was just inserted, so the next keystroke replaces it
 * instead of landing in front of it. Goes through the ProseMirror position rather than the text,
 * because the document may already hold a block that looks the same. The code editor mounts a
 * frame or two later, hence the retry.
 */
function selectSnippet(view, pos) {
  let tries = 20;
  const run = () => {
    const $pos = view.state.doc.resolve(Math.min(pos, view.state.doc.content.size));
    const block = view.nodeDOM($pos.before($pos.depth));
    const host = block?.querySelector?.('.cm-editor');
    const editor = host && EditorView.findFromDOM(host);
    if (!editor) {
      if (--tries > 0) requestAnimationFrame(run);
      return;
    }
    editor.dispatch({ selection: { anchor: 0, head: editor.state.doc.length } });
    editor.focus();
  };
  requestAnimationFrame(run);
}

/** Slash-menu action: turn the current block into a `language` block holding `starter`. */
function insertSnippet({ language, starter }) {
  return (ctx) => {
    const commands = ctx.get(commandsCtx);
    const view = ctx.get(editorViewCtx);
    commands.call(clearTextInCurrentBlockCommand.key);
    commands.call(addBlockTypeCommand.key, { nodeType: codeBlockSchema.type(ctx), attrs: { language } });
    const { from } = view.state.selection;
    view.dispatch(view.state.tr.insertText(starter, from));
    selectSnippet(view, view.state.selection.from);
  };
}

/** Calls `onChange` after every document change, without serializing markdown. */
function changeWatcher(onChange) {
  return $prose(
    () =>
      new Plugin({
        key: new PluginKey('mdpad-change'),
        view: () => ({
          update(view, previous) {
            if (view.state.doc !== previous.doc) onChange();
          },
        }),
      }),
  );
}

/**
 * Creates the rich editor inside `root`.
 * Options: content, readonly, scroller (scrolling element), resolveImage(url),
 * uploadImage(file), pickImage(), promptCaption(caption), renderDiagram(language, code),
 * onChange(), onCopy(text), onOpenLink(url).
 */
export async function createRichEditor(options) {
  const { root, content, readonly = false, scroller } = options;
  const crepe = new Crepe({
    root,
    defaultValue: content,
    featureConfigs: {
      [Crepe.Feature.Placeholder]: { text: '开始写作，或输入 / 插入内容', mode: 'doc' },
      [Crepe.Feature.BlockEdit]: {
        textGroup: {
          label: '文本',
          text: { label: '正文' },
          h1: { label: '一级标题' },
          h2: { label: '二级标题' },
          h3: { label: '三级标题' },
          h4: { label: '四级标题' },
          h5: { label: '五级标题' },
          h6: { label: '六级标题' },
          quote: { label: '引用' },
          divider: { label: '分割线' },
        },
        listGroup: {
          label: '列表',
          bulletList: { label: '无序列表' },
          orderedList: { label: '有序列表' },
          taskList: { label: '任务列表' },
        },
        advancedGroup: {
          label: '插入',
          image: { label: '图片' },
          codeBlock: { label: '代码块' },
          table: { label: '表格' },
          // Replaced below: Crepe's own item leaves the formula block empty, which reads as broken.
          math: null,
        },
        // Runs after the groups above are built, so this appends to 「插入」 and adds 「图表」.
        buildMenu: (builder) => {
          builder.getGroup('advanced')?.addItem('formula', {
            label: FORMULA_SNIPPET.label,
            icon: FORMULA_SNIPPET.icon,
            onRun: insertSnippet(FORMULA_SNIPPET),
          });
          const diagrams = builder.addGroup('diagram', '图表');
          for (const snippet of DIAGRAM_SNIPPETS) {
            diagrams.addItem(snippet.key, {
              label: snippet.label,
              icon: snippet.icon,
              onRun: insertSnippet(snippet),
            });
          }
          // The slash menu is where users look for commands; the skills live there too. It is built
          // again for every keystroke of the filter, so the list follows the AI configuration.
          const aiItems = slashItems();
          if (aiItems.length) {
            const aiGroup = builder.addGroup('ai', 'AI 改写');
            for (const item of aiItems) {
              aiGroup.addItem(item.key, {
                label: item.label,
                icon: AI_ICON,
                onRun: (ctx) => item.run(ctx.get(editorViewCtx)),
              });
            }
          }
        },
      },
      [Crepe.Feature.Toolbar]: {
        boldLabel: '加粗',
        italicLabel: '斜体',
        strikethroughLabel: '删除线',
        codeLabel: '行内代码',
        latexLabel: '行内公式',
        linkLabel: '链接',
      },
      [Crepe.Feature.CodeMirror]: {
        theme: codeTheme(),
        languages: CODE_LANGUAGES,
        searchPlaceholder: '搜索语言',
        noResultText: '没有匹配的语言',
        copyText: '复制',
        onCopy: options.onCopy,
        previewToggleText: (previewOnly) => (previewOnly ? '编辑' : '隐藏'),
        previewLabel: '预览',
        previewLoading: '正在加载…',
        renderLanguage: pickerLabel,
        renderPreview: (language, code, apply) => {
          if (!options.renderDiagram || language.toLowerCase() !== 'mermaid') return null;
          options.renderDiagram(code).then(apply, () => apply('无法绘制这个流程图'));
          return undefined;
        },
      },
      [Crepe.Feature.ImageBlock]: {
        proxyDomURL: options.resolveImage,
        onUpload: options.uploadImage,
        inlineOnUpload: options.uploadImage,
        blockOnUpload: options.uploadImage,
        inlineUploadButton: '上传',
        inlineUploadPlaceholderText: '或粘贴图片链接',
        blockUploadButton: '选择图片',
        blockConfirmButton: '确定',
        blockCaptionPlaceholderText: '图片说明',
        blockUploadPlaceholderText: '或粘贴图片链接',
      },
      [Crepe.Feature.LinkTooltip]: {
        inputPlaceholder: '粘贴或输入链接',
        onCopyLink: options.onCopy,
      },
      [Crepe.Feature.Latex]: { katexOptions: { throwOnError: false } },
    },
  });
  const lazy = createLazy(scroller);
  crepe.editor
    .config(preserveMarkdown)
    .use(chunkedParsing)
    .use(lazy.views)
    .use(lazy.plugin)
    .use(markdownMarkers)
    .use(linkPaste)
    .use(findPlugin)
    .use(proposalFeature)
    .use(ghostFeature)
    .use(imageActions({ onReplace: options.pickImage, onCaption: options.promptCaption }))
    .use(syncHeadingIds)
    .use(syncListOrder)
    .use(changeWatcher(() => options.onChange?.()));
  // Crepe always installs Milkdown's listener plugin, which serializes the whole document when the
  // editor starts even though nothing listens. Nothing here uses it (changeWatcher replaces it).
  // The two sync plugins are replaced by faster copies (see plugins.js).
  await crepe.editor.remove([listener, syncHeadingIdPlugin, syncListOrderPlugin]);
  await crepe.create();
  if (readonly) crepe.setReadonly(true);

  const view = crepe.editor.action((ctx) => ctx.get(editorViewCtx));
  const { serialize, serializeAsync, warm } = crepe.editor.action(incrementalSerializer);
  // Fill the markdown cache in small slices while idle, so the first save is cheap too.
  let warmTimer = setTimeout(function warmUp() {
    warmTimer = warm(view.state.doc, 12) ? setTimeout(warmUp, 20) : null;
  }, 300);

  // ⌘/Ctrl + click opens links in the browser.
  const onClick = (event) => {
    const link = event.target.closest?.('a[href]');
    if (link && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      options.onOpenLink?.(link.getAttribute('href'));
    }
  };
  root.addEventListener('click', onClick);
  const labels = new MutationObserver(() => relabelLanguageButtons(root));
  labels.observe(root, { subtree: true, childList: true, characterData: true });
  relabelLanguageButtons(root);

  const scrollMatch = (match) => {
    lazyController(view)?.reveal(match.from);
    const { node } = view.domAtPos(match.from);
    const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    element?.scrollIntoView({ block: 'center' });
  };
  const findState = () => findKey.getState(view.state);
  const findInfo = () => ({ count: findState().matches.length, index: findState().index });

  return {
    kind: 'rich',
    view,
    crepe,
    /** Completion controls: accept / reject / has / now, or undefined if the feature failed to load. */
    ai: ghostControls(view),
    getMarkdown: () => serialize(view.state.doc),
    getWordCount: () => countMarkdownWords(serialize(view.state.doc)),
    /** The markdown of a snapshot (default: the current document), without blocking the page. */
    getMarkdownAsync: (snapshot = view.state.doc) => serializeAsync(snapshot),
    /** An immutable value identifying the current document, for matches(). */
    snapshot: () => view.state.doc,
    /** True if the document is the same as when `snapshot` was taken (unchanged parts compare by identity). */
    matches: (snapshot) => !!snapshot && (snapshot === view.state.doc || view.state.doc.eq(snapshot)),
    setMarkdown: (markdown) => crepe.editor.action(replaceAll(markdown)),
    focus: () => view.focus(),
    command(id) {
      const command = COMMANDS[id];
      if (command) crepe.editor.action(callCommand(command.key));
      view.focus();
    },
    headings() {
      const headings = [];
      view.state.doc.descendants((node, pos) => {
        if (node.type.name === 'heading') {
          headings.push({ level: node.attrs.level, text: node.textContent, pos });
          return false;
        }
        return node.type.name !== 'code_block';
      });
      return headings;
    },
    scrollToHeading(heading) {
      const lazy = lazyController(view);
      if (lazy) {
        lazy.scrollToBlock({ pos: heading.pos, offset: 12 });
      } else {
        const dom = view.nodeDOM(heading.pos);
        if (dom) {
          scroller.scrollTop += dom.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
        }
      }
      const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, heading.pos + 1));
      view.dispatch(tr);
      view.focus();
    },
    /** Index of the heading at the top of the visible area. */
    activeHeading(headings) {
      // Headings are in document order, so their tops increase: binary search for the last one
      // above the line instead of measuring every heading.
      const top = scroller.getBoundingClientRect().top + 80;
      const above = (i) => {
        const dom = view.nodeDOM(headings[i].pos);
        return !!dom && dom.getBoundingClientRect().top <= top;
      };
      let lo = 0;
      let hi = headings.length - 1;
      let active = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (above(mid)) {
          active = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return active;
    },
    getPosition() {
      const position = { mode: 'rich', anchor: view.state.selection.anchor, scrollTop: scroller.scrollTop };
      // With lazy rendering, pixel offsets depend on which blocks were measured; remember the block.
      const top = lazyController(view)?.topBlock();
      if (top) position.top = top;
      return position;
    },
    setPosition(position) {
      if (position?.mode === 'rich' && typeof position.anchor === 'number') {
        const anchor = Math.min(Math.max(position.anchor, 0), view.state.doc.content.size);
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(anchor))));
      }
      const lazy = lazyController(view);
      if (lazy && typeof position?.top?.pos === 'number') lazy.scrollToBlock(position.top);
      else if (typeof position?.scrollTop === 'number') scroller.scrollTop = position.scrollTop;
      lazy?.refresh();
    },
    /** Renders the whole document (for printing and export) or returns to lazy rendering. */
    renderAll(all) {
      lazyController(view)?.setAll(all);
    },
    find: {
      set(query) {
        view.dispatch(view.state.tr.setMeta(findKey, { query, index: 0 }));
        const { matches } = findState();
        if (matches.length) scrollMatch(matches[0]);
        return findInfo();
      },
      go(delta) {
        const { matches, index } = findState();
        if (!matches.length) return findInfo();
        const next = (index + delta + matches.length) % matches.length;
        view.dispatch(view.state.tr.setMeta(findKey, { index: next }));
        scrollMatch(matches[next]);
        return findInfo();
      },
      replace(text) {
        const { matches, index } = findState();
        const match = matches[index];
        if (match) view.dispatch(view.state.tr.insertText(text, match.from, match.to));
        const { matches: rest, index: next } = findState();
        if (rest[next]) scrollMatch(rest[next]);
        return findInfo();
      },
      replaceAll(text) {
        const { matches } = findState();
        const tr = view.state.tr;
        for (const match of [...matches].reverse()) tr.insertText(text, match.from, match.to);
        view.dispatch(tr);
        return findInfo();
      },
      /** Leaves the cursor on the current match and returns to the text. */
      finish() {
        const { matches, index } = findState();
        const match = matches[index];
        const tr = view.state.tr.setMeta(findKey, { query: '' });
        if (match) tr.setSelection(TextSelection.create(view.state.doc, match.from, match.to));
        view.dispatch(tr);
        view.focus();
      },
    },
    async destroy() {
      clearTimeout(warmTimer);
      root.removeEventListener('click', onClick);
      labels.disconnect();
      await crepe.destroy();
    },
  };
}
