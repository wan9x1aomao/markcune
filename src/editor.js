// The WYSIWYG editor (Milkdown Crepe), configured in Chinese.
import { Crepe } from '@milkdown/crepe';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';
import { editorViewCtx } from '@milkdown/kit/core';
import { redoCommand, undoCommand } from '@milkdown/kit/plugin/history';
import {
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleStrongCommand,
} from '@milkdown/kit/preset/commonmark';
import { toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm';
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import { $prose, callCommand, replaceAll } from '@milkdown/kit/utils';
import { preserveMarkdown } from './markdown.js';
import { findKey, findPlugin, imageActions, linkPaste, markdownMarkers } from './plugins.js';

if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
  await import('@milkdown/crepe/theme/frame-dark.css');
}

const LANGUAGE_NAMES = { latex: '公式', mermaid: '流程图', text: '纯文本', plaintext: '纯文本', '': '纯文本' };
const languageLabel = (language) => LANGUAGE_NAMES[language.toLowerCase()] ?? language;

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
          math: { label: '公式' },
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
        searchPlaceholder: '搜索语言',
        noResultText: '没有匹配的语言',
        copyText: '复制',
        onCopy: options.onCopy,
        previewToggleText: (previewOnly) => (previewOnly ? '编辑' : '隐藏'),
        previewLabel: '预览',
        previewLoading: '正在加载…',
        renderLanguage: languageLabel,
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
  crepe.editor
    .config(preserveMarkdown)
    .use(markdownMarkers)
    .use(linkPaste)
    .use(findPlugin)
    .use(imageActions({ onReplace: options.pickImage, onCaption: options.promptCaption }))
    .use(changeWatcher(() => options.onChange?.()));
  await crepe.create();
  if (readonly) crepe.setReadonly(true);

  const view = crepe.editor.action((ctx) => ctx.get(editorViewCtx));

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
    const { node } = view.domAtPos(match.from);
    const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    element?.scrollIntoView({ block: 'center' });
  };
  const findState = () => findKey.getState(view.state);
  const findInfo = () => ({ count: findState().matches.length, index: findState().index });

  return {
    kind: 'rich',
    view,
    getMarkdown: () => crepe.getMarkdown(),
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
      view.nodeDOM(heading.pos)?.scrollIntoView({ block: 'start' });
      const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, heading.pos + 1));
      view.dispatch(tr);
      view.focus();
    },
    /** Index of the heading at the top of the visible area. */
    activeHeading(headings) {
      const top = scroller.getBoundingClientRect().top + 80;
      let active = -1;
      headings.forEach((heading, i) => {
        const dom = view.nodeDOM(heading.pos);
        if (dom && dom.getBoundingClientRect().top <= top) active = i;
      });
      return active;
    },
    getPosition: () => ({ mode: 'rich', anchor: view.state.selection.anchor, scrollTop: scroller.scrollTop }),
    setPosition(position) {
      if (position?.mode === 'rich' && typeof position.anchor === 'number') {
        const anchor = Math.min(Math.max(position.anchor, 0), view.state.doc.content.size);
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(anchor))));
      }
      if (typeof position?.scrollTop === 'number') scroller.scrollTop = position.scrollTop;
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
      root.removeEventListener('click', onClick);
      labels.disconnect();
      await crepe.destroy();
    },
  };
}
