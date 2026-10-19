// Browser harness for the AI features: the shell is stubbed in __lab.html.
// The app stylesheet comes with main.js, so this page has to pull it in itself — without it the
// suggestion, the proposal and the action bar are all in the document but invisible.
import './style.css';
import { ai } from './ai-core.js';
import { accept, acceptAll, focusProposal, propose, proposeEach, proposePrevious, proposals, reject, rejectAll } from './ai-proposal.js';
import { installReview } from './ai-review.js';
import { allSkills, installAiActions, slashItems } from './ai-skills.js';
import { createRichEditor } from './editor.js';
import { TextSelection } from '@milkdown/kit/prose/state';
import { contextOf, ghostKey } from './ai-ghost.js';
import { createVoiceInput } from './voice.js';

await ai.refresh();

const root = document.getElementById('root');
const editor = await createRichEditor({
  root,
  content: '# 标题\n\n第一段内容在这里，正在写一句话。\n\n第二段文字，需要被改写。\n',
  scroller: root,
  onChange: () => {},
});

// The app installs these in mountEditor; the harness has to do the same or the UI never exists.
const aiActions = installAiActions(editor.view);
const review = installReview(editor.view);

// The microphone button is mounted by main.js in the real app; the harness has to do it itself.
// Nothing is recorded here: the shell is stubbed, so start/stop just answer.
const voice = createVoiceInput({ getEditor: () => editor });
document.body.appendChild(voice.element);
await voice.refresh();

function findText(needle) {
  let found = null;
  editor.view.state.doc.descendants((node, pos) => {
    if (found || !node.isText) return !found;
    const at = node.text.indexOf(needle);
    if (at >= 0) found = { from: pos + at, to: pos + at + needle.length };
    return !found;
  });
  return found;
}

window.__lab = {
  editor,
  view: editor.view,
  /** Exposed so a test can build a selection without resolving bare module specifiers in the page. */
  TextSelection,
  md: () => editor.getMarkdown(),
  /** Replaces the document, so a case can start from an exact text instead of reloading the page. */
  setDoc: (markdown) => editor.setMarkdown(markdown),
  calls: () => window.__stub.calls,
  status: () => ai.status,
  ghostDeco: () => {
    try {
      const set = ghostKey.getState(editor.view.state);
      const items = set ? set.find().map((d) => ({ from: d.from, to: d.to, side: d.spec.side, type: d.type && d.type.name, key: d.spec.key })) : [];
      const merged = editor.view.someProp('decorations', (f) => f(editor.view.state));
      return {
        count: items.length,
        items,
        merged: merged ? merged.find().length : -1,
        html: editor.view.dom.innerHTML.slice(-160),
      };
    } catch (error) {
      return { error: String(error && error.message) };
    }
  },
  decoInfo: () => {
    const v = editor.view;
    const providers = [];
    v.state.plugins.forEach((plugin, index) => {
      if (plugin.spec.props?.decorations) providers.push({ index, key: String(plugin.key) });
    });
    const set = v.someProp('decorations');
    return { providers, found: set ? set.find().length : -1, ourIndex: v.state.plugins.findIndex((p) => String(p.key).includes('ai-ghost')) };
  },
  /** Puts the caret at the end of the first paragraph that contains `needle`. */
  caretAfter(needle) {
    const hit = findText(needle);
    if (!hit) return null;
    const tr = editor.view.state.tr.setSelection(TextSelection.near(editor.view.state.doc.resolve(hit.to)));
    editor.view.dispatch(tr);
    editor.view.focus();
    return hit;
  },
  select(needle) {
    const hit = findText(needle);
    if (!hit) return null;
    editor.view.dispatch(editor.view.state.tr.setSelection(TextSelection.create(editor.view.state.doc, hit.from, hit.to)));
    editor.view.focus();
    return hit;
  },
  propose: (instruction, label) => propose(editor.view, instruction, label),
  proposeEach: (instruction, label) => proposeEach(editor.view, instruction, label),
  proposePrevious: (instruction, label) => proposePrevious(editor.view, instruction, label),
  proposals: () => proposals(editor.view).map((p) => ({ id: p.id, from: p.from, to: p.to, source: p.source, text: p.text, label: p.label, blocks: p.blocks })),
  slash: () => slashItems(),
  skills: () => allSkills().map((s) => ({ label: s.label, custom: !!s.custom })),
  accept: (id) => accept(editor.view, id),
  reject: (id) => reject(editor.view, id),
  acceptAll: () => acceptAll(editor.view),
  rejectAll: () => rejectAll(editor.view),
  focus: (id) => focusProposal(editor.view, id),
  /** Selects the nth top-level block's whole content, for the multi-paragraph cases. */
  selectBlocks(fromIndex, toIndex) {
    const doc = editor.view.state.doc;
    if (fromIndex < 0 || toIndex >= doc.childCount) return null;
    let pos = 0;
    for (let i = 0; i < fromIndex; i++) pos += doc.child(i).nodeSize;
    const from = pos + 1;
    let end = pos;
    for (let i = fromIndex; i <= toIndex; i++) end += doc.child(i).nodeSize;
    editor.view.dispatch(editor.view.state.tr.setSelection(TextSelection.create(doc, from, end - 1)));
    editor.view.focus();
    return { from, to: end - 1 };
  },
  blockIndexAt(pos) {
    const doc = editor.view.state.doc;
    let at = 0;
    for (let i = 0; i < doc.childCount; i++) {
      at += doc.child(i).nodeSize;
      if (pos < at) return i;
    }
    return doc.childCount - 1;
  },
  ghostNow: () => editor.ai?.now(),
  /** Builds the Word export and hands it back as base64, so a test can unzip and read it. */
  docx: async () => {
    const { buildDocx } = await import('./docx.js');
    const bytes = await buildDocx(editor.view.state.doc, {
      title: '测试',
      image: async (src) => src,
    });
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return { size: bytes.length, base64: btoa(binary) };
  },
  ctx: () => {
    const c = contextOf(editor.view);
    return { enabled: c.enabled, empty: c.empty, atEnd: c.atEnd, paragraph: c.paragraph, composing: c.isComposing, cooldown: c.cooldown, chars: c.chars, pos: c.pos, version: c.version };
  },
  ghostHas: () => editor.ai?.has(),
  ghostHtml: () => root.querySelector('.ai-ghost')?.textContent ?? null,
  proposalHtml: () => root.querySelector('.ai-new')?.textContent ?? null,
  barVisible: () => {
    const bar = document.querySelector('.ai-bar');
    return !!bar && bar.style.display !== 'none';
  },
  click: (selector) => {
    const element = document.querySelector(selector);
    element?.click();
    return !!element;
  },
  /** 语音按钮：浏览器里没有真麦克风，start/stop 由桩回答。 */
  voice: {
    state: () => voice.state,
    visible: () => !voice.element.hidden,
    ready: () => voice.element.dataset.ready,
    click: () => voice.element.click(),
    refresh: () => voice.refresh(),
    label: () => voice.element.textContent.replace(/\s+/g, ' ').trim(),
  },
};

window.__ready = true;
