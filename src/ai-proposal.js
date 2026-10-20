// A rewrite is a proposal, never an edit on the spot.
//
// The document is not touched: the range gets decorations, the new text is a widget after it.
// Accepting is the only thing that changes the document, in one transaction per proposal, so one
// undo brings the original back. Rejecting removes the decorations and leaves no trace.
//
// Several proposals can sit on screen at once — a batch rewrites one block at a time — so their
// positions live in a plugin state slot rather than in module state. The slot maps them through
// every transaction, which is what keeps accepting the first proposal from shifting the rest.
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import { ai } from './ai-core.js';
import { addExtraDecorations } from './lazy.js';
import { toast } from './ui.js';

export const proposalKey = new PluginKey('ai-proposal');

/** A replacement longer than this is unreadable laid inline after the old text. */
const INLINE_LIMIT = 48;
/** One batch is capped: ten slow requests with no feedback feels broken. */
export const MAX_BLOCKS = 8;

let panelBar = null;
let barFor = null;
let barAt = 0;
let barView = null;
let busyNote = null;
let nextId = 1;
let activeId = null;
const listeners = new Set();

// ---------------------------------------------------------------- state

/** The proposals on screen, in document order. Never null. */
export function proposals(view) {
  return listOf(view.state);
}

function listOf(state) {
  try {
    return proposalKey.getState(state) ?? [];
  } catch {
    return [];
  }
}

/** Subscribes to changes of the proposal list (accepted, rejected, a new batch). */
export function onProposals(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(view) {
  const list = proposals(view);
  for (const fn of listeners) fn(list, view);
}

function signature(list) {
  return list.map((p) => `${p.id}:${p.from}:${p.to}`).join('|');
}

/** Positions follow the document; anything whose text changed underneath is dropped. */
function mapProposal(tr, p) {
  const from = tr.mapping.map(p.from, -1);
  const to = tr.mapping.map(p.to, 1);
  if (to <= from) return null;
  if (tr.doc.textBetween(from, to, '\n') !== p.source) return null;
  const blocks = p.blocks
    ? p.blocks.map((block) => ({
        from: tr.mapping.map(block.from, -1),
        to: tr.mapping.map(block.to, 1),
      }))
    : null;
  if (blocks && blocks.some((block) => block.to <= block.from)) return null;
  if (from === p.from && to === p.to) return p;
  return { ...p, from, to, blocks };
}

const proposalPlugin = new Plugin({
  key: proposalKey,
  state: {
    init: () => [],
    apply(tr, list) {
      const meta = tr.getMeta(proposalKey);
      if (meta?.clear) return [];
      let next = list;
      if (meta?.remove) next = next.filter((p) => p.id !== meta.remove);
      if (meta?.add) next = next.concat(meta.add);
      if (!tr.docChanged || !next.length) return next;
      return next.map((p) => mapProposal(tr, p)).filter(Boolean);
    },
  },
  props: {
    handleKeyDown(view, event) {
      const list = proposals(view);
      if (!list.length) return false;
      if (event.key === 'Escape') {
        reject(view, targetOf(view, list).id);
        return true;
      }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        accept(view, targetOf(view, list).id);
        return true;
      }
      return false;
    },
  },
  view: (editor) => ({
    update(view, previous) {
      const list = proposals(view);
      const before = listOf(previous);
      if (panelBar && !list.some((p) => p.id === barFor)) hideBar();
      else if (panelBar && view.state.doc !== previous.doc) place(barAt);
      if (signature(list) !== signature(before)) {
        if (activeId && !list.some((p) => p.id === activeId)) activeId = null;
        emit(view);
        syncBar(view);
      }
    },
  }),
});

/** Milkdown feature: the proposal slot, plus the keys that settle a proposal. */
export const proposalFeature = $prose(() => proposalPlugin);

/** The proposal the keyboard acts on: the last one jumped to, else the one under the caret. */
function targetOf(view, list) {
  const active = list.find((p) => p.id === activeId);
  if (active) return active;
  const cursor = view.state.selection.from;
  return list.find((p) => cursor >= p.from && cursor <= p.to) ?? list[0];
}

// ---------------------------------------------------------------- rendering

function newTextElement(text, block, id) {
  const span = document.createElement('span');
  span.className = block ? 'ai-new ai-new-block' : 'ai-new';
  // Marks the widget in the DOM so the bar can be placed under the whole replacement, not just the
  // range it replaces: a longer rewrite wraps over lines the old range knows nothing about.
  span.dataset.proposal = String(id);
  const lines = block ? text.split('\n') : [text];
  if (lines.length > 1) {
    for (const line of lines) {
      const row = document.createElement('span');
      row.className = 'ai-new-line';
      row.textContent = line;
      span.appendChild(row);
    }
  } else {
    span.textContent = text;
  }
  return span;
}

/** The decorations for every proposal on screen, or null when there is none. */
export function proposalDecorations(state) {
  let list;
  try {
    list = proposalKey.getState(state) ?? [];
  } catch {
    return null;
  }
  if (!list.length) return null;
  const decorations = [];
  for (const proposal of list) {
    if (proposal.blocks?.length) {
      // A replaced section is marked per block: `text-decoration` on a block runs through every line
      // inside it, which no inline decoration can do across paragraph boundaries.
      for (const block of proposal.blocks) {
        decorations.push(Decoration.node(block.from, block.to, { class: 'ai-old-block' }));
      }
    } else if (proposal.to > proposal.from) {
      decorations.push(Decoration.inline(proposal.from, proposal.to, { class: 'ai-old' }));
    }
    // A section's replacement belongs after its last paragraph: inside it, the strike-through of the
    // block decoration would run across the new text as well.
    const at = Math.min(proposal.blocks?.length ? proposal.blocks.at(-1).to : proposal.to, state.doc.content.size);
    decorations.push(
      Decoration.widget(at, () => newTextElement(proposal.text, proposal.block, proposal.id), {
        side: 1,
        key: `ai-new-${proposal.id}`,
      }),
    );
  }
  decorations.sort((a, b) => a.from - b.from || a.to - b.to);
  return DecorationSet.create(state.doc, decorations);
}

// The lazy-rendering plugin owns the decorations slot in this editor, so hand ours to it.
addExtraDecorations((state) => proposalDecorations(state));

// ---------------------------------------------------------------- the bar

function hideBar() {
  unfollow?.();
  panelBar?.remove();
  panelBar = null;
  barFor = null;
  barView = null;
  busyNote = null;
  setPending(false);
}

/** True while a batch is filling the list; one bar per arriving item would flicker over the list. */
let batching = false;

/**
 * One proposal gets the bar; two or more are settled in the review list. Run after every change, so
 * that narrowing a batch down to its last item still leaves the user with buttons.
 */
function syncBar(view) {
  if (batching) return;
  const list = proposals(view);
  if (list.length === 1) {
    if (list[0].id !== barFor) showBar(view, list[0]);
  } else if (barFor) {
    hideBar();
  }
  // While anything is pending the review UI owns the screen: the formatting toolbar would sit on top
  // of the old text the user is comparing against.
  setPending(list.length > 0);
}

/** While a proposal is pending the AI bar is the only floating UI; the formatting toolbar steps aside. */
function setPending(on) {
  document.body.classList.toggle('ai-pending', on);
}

/** The text column the proposal sits in, so the bar can never cross into a side panel. */
function columnOf(view, pos) {
  try {
    const $pos = view.state.doc.resolve(Math.min(pos, view.state.doc.content.size));
    if ($pos.depth >= 1) {
      const box = view.nodeDOM($pos.before(1))?.getBoundingClientRect?.();
      if (box && box.width > 0) return box;
    }
  } catch {
    // Fall back to the editor box below.
  }
  return view.dom.getBoundingClientRect();
}

/** The box the replacement occupies on screen: a widget can wrap over lines the replaced range does not cover. */
function replacementBox(view, proposal) {
  const span = view.dom.querySelector(`[data-proposal="${proposal.id}"]`);
  if (!span) return null;
  const rects = [...span.getClientRects()].filter((rect) => rect.width || rect.height);
  if (!rects.length) return null;
  return {
    top: Math.min(...rects.map((rect) => rect.top)),
    bottom: Math.max(...rects.map((rect) => rect.bottom)),
  };
}

function place(pos) {
  if (!panelBar || !barView) return;
  const view = barView;
  const at = Math.min(pos, view.state.doc.content.size);
  const proposal = proposals(view).find((p) => p.id === barFor);
  let start;
  let end;
  try {
    end = view.coordsAtPos(at);
    // The bar follows the *start* of the changed text: anchoring on the end pushes it to the right
    // edge of a long paragraph, where it reads as a floating box in the margin.
    start = proposal ? view.coordsAtPos(Math.min(proposal.from, at)) : end;
  } catch {
    return;
  }
  const column = columnOf(view, at);
  const width = panelBar.offsetWidth || 260;
  const height = panelBar.offsetHeight || 34;
  panelBar.style.maxWidth = `${Math.round(column.width)}px`;
  const left = Math.max(column.left, Math.min(start.left, column.right - width));
  // Sit under the whole proposal — the old text *and* its replacement. Anchored on the replaced range
  // alone, the bar landed in the middle of a longer rewrite and covered the words being compared.
  const box = proposal ? replacementBox(view, proposal) : null;
  const first = Math.min(start.top, box?.top ?? start.top);
  const last = Math.max(end.bottom, box?.bottom ?? end.bottom);
  const below = last + 8;
  let top = below;
  // No room under the last line: sit above the proposal instead of covering it.
  if (below + height > window.innerHeight - 8) {
    top = first - height - 8 >= 8 ? first - height - 8 : Math.max(8, window.innerHeight - height - 8);
  }
  // Once the proposal leaves the viewport the bar would float over unrelated text.
  const visible = last > 0 && first < window.innerHeight;
  panelBar.style.display = visible ? '' : 'none';
  panelBar.style.left = `${left}px`;
  panelBar.style.top = `${Math.max(8, top)}px`;
}

// The bar is fixed to the viewport, so it has to be told when the text under it moves: scrolling the
// editor leaves a bar in place that then covers whatever was scrolled up behind it.
let unfollow = null;

function follow() {
  if (unfollow) return;
  let frame = 0;
  const again = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => place(barAt));
  };
  // Capture phase, because the editor scrolls inside its own container rather than the window.
  window.addEventListener('scroll', again, true);
  window.addEventListener('resize', again);
  unfollow = () => {
    cancelAnimationFrame(frame);
    window.removeEventListener('scroll', again, true);
    window.removeEventListener('resize', again);
    unfollow = null;
  };
}

function position(view, pos) {
  if (!panelBar) return;
  barView = view;
  barAt = pos;
  follow();
  // Park it off screen for one frame so the first measurement is the real width.
  panelBar.style.left = '-9999px';
  panelBar.style.top = '-9999px';
  requestAnimationFrame(() => place(pos));
}

function tag(label) {
  return text('ai-bar-tag', label);
}

function text(className, content) {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = content;
  return element;
}

function buttons() {
  const wrap = document.createElement('span');
  wrap.className = 'ai-bar-actions';
  for (const [act, label, keys] of [
    ['accept', '采纳', '⌘↵'],
    ['retry', '重来', ''],
    ['reject', '拒绝', 'esc'],
  ]) {
    const button = document.createElement('button');
    button.dataset.act = act;
    button.textContent = label;
    if (keys) {
      const kbd = document.createElement('kbd');
      kbd.textContent = keys;
      button.appendChild(kbd);
    }
    wrap.appendChild(button);
  }
  return wrap;
}

function showBusy(view, pos, note) {
  hideBar();
  panelBar = document.createElement('div');
  panelBar.className = 'ai-bar ai-bar-busy';
  busyNote = text('ai-bar-note', note);
  panelBar.append(tag('AI'), busyNote);
  document.body.appendChild(panelBar);
  setPending(true);
  position(view, pos);
}

function setBusyNote(note) {
  if (busyNote) busyNote.textContent = note;
}

function showBar(view, proposal) {
  hideBar();
  barFor = proposal.id;
  activeId = proposal.id;  panelBar = document.createElement('div');
  panelBar.className = 'ai-bar';
  panelBar.setAttribute('role', 'dialog');
  panelBar.setAttribute('aria-label', 'AI 改写建议');
  // Show what the user asked for, not the sentence we send to the model: that one is a prompt, and
  // truncated mid-sentence it reads like broken UI.
  const note = text('ai-bar-note', proposal.label || '改写');
  note.title = proposal.instruction;
  panelBar.append(tag('AI'), note, buttons());
  document.body.appendChild(panelBar);
  setPending(true);
  position(view, proposal.to);
  // mousedown would move the selection away and invalidate the proposal.
  panelBar.addEventListener('mousedown', (event) => event.preventDefault());
  panelBar.addEventListener('click', (event) => {
    const act = event.target.closest('button')?.dataset.act;
    if (act === 'accept') accept(view, proposal.id);
    else if (act === 'reject') reject(view, proposal.id);
    else if (act === 'retry') {
      const { from, to, source, instruction, label, split } = proposal;
      remove(view, proposal.id);
      run(view, { from, to, source, instruction, label, split });
    }
  });
}

// ---------------------------------------------------------------- ranges

/** The text blocks a rewrite may touch. Anything else is refused, with a reason worth reading. */
const PROSE = new Set(['paragraph', 'heading']);

/**
 * Why a block cannot be rewritten, in the user's words. A code block is a text block to
 * ProseMirror, but rewriting code as prose is never what the user meant; the rest carry no
 * sentences at all, so the only honest answer is to say which one got in the way.
 */
const NOT_PROSE = {
  code_block: '代码块不参与改写',
  table: '表格里没有可以改写的段落',
  hr: '选区跨过了分隔线，只选文字再试',
  image: '选区里有图片，只选文字再试',
  'image-block': '选区里有图片，只选文字再试',
  html: '选区里有原始 HTML，只选文字再试',
  math_block: '选区里有公式块，只选文字再试',
  math_inline: '选区里有公式，只选文字再试',
};

const FALLBACK = '这里没有可以改写的文字';

/**
 * The text blocks a selection touches, each with the part of it that is selected.
 *
 * Walks *into* containers: a list item, a quote and a table cell all hold ordinary paragraphs, and
 * refusing them made 「只选了一段」 fail for the most common shape of all — a bulleted outline. What
 * is still refused is a text block that is not a paragraph (`code_block`) and any block that holds
 * no sentences at all.
 *
 * `nested` marks a block that is not a direct child of the document; the caller needs to know
 * because such a block cannot be replaced as a whole without destroying the container around it.
 */
export function scanBlocks(doc, from, to) {
  const hits = [];
  let reason = '';

  const walk = (parent, base, depth) => {
    parent.forEach((child, offset) => {
      const start = base + offset;
      const end = start + child.nodeSize;
      if (end <= from || start >= to) return;
      if (child.isTextblock) {
        if (!PROSE.has(child.type.name)) {
          reason ||= NOT_PROSE[child.type.name] ?? FALLBACK;
          return;
        }
        hits.push({
          pos: start,
          node: child,
          nested: depth > 0,
          from: Math.max(from, start + 1),
          to: Math.min(to, end - 1),
        });
        return;
      }
      if (child.isLeaf) {
        reason ||= NOT_PROSE[child.type.name] ?? FALLBACK;
        return;
      }
      walk(child, start + 1, depth + 1);
    });
  };

  walk(doc, 0, 0);
  return { hits, reason };
}

/** Same walk, but only the blocks — null when the selection touches anything unrewritable. */
export function blocksIn(doc, from, to) {
  const { hits, reason } = scanBlocks(doc, from, to);
  return reason ? null : hits;
}

function wantsBlock(text, source, atEnd) {
  if (!atEnd) return false;
  return text.length > INLINE_LIMIT || source.length > INLINE_LIMIT;
}

/** Whether the caret sits at the end of the block that holds it. */
function atBlockEnd(view, pos) {
  const $pos = view.state.doc.resolve(pos);
  return $pos.parentOffset === $pos.parent.content.size;
}

// ---------------------------------------------------------------- asking

async function run(view, { from, to, source, instruction, label, split }) {
  const { hits, reason } = scanBlocks(view.state.doc, from, to);
  if (reason) {
    toast(reason);
    return;
  }
  if (!hits.length) {
    toast(FALLBACK);
    return;
  }
  // List items, quotes and table cells cannot be replaced as one paragraph without destroying the
  // container, so a selection spanning several of them gets one request per block instead — the
  // same thing 「逐段改写」 does, just picked for the user rather than by them.
  if (hits.length > 1 && hits.some((hit) => hit.nested)) {
    hideBar();
    return proposeEach(view, instruction, label, { from, to });
  }
  const multi = hits.length > 1;
  showBusy(view, from, multi ? '正在改写整段…' : '正在改写…');
  let result;
  try {
    result = await ai.rewrite(source, instruction);
  } catch (error) {
    hideBar();
    toast(String(error?.message ?? error));
    return;
  }
  if (!result.trim()) {
    hideBar();
    toast('AI 没有给出改写结果');
    return;
  }
  if (result.trim() === source.trim()) {
    hideBar();
    toast('AI 认为这里不用改');
    return;
  }
  if (view.state.doc.textBetween(from, to, '\n') !== source) {
    hideBar();
    toast('文档已经变了，请重新选中');
    return;
  }
  const proposal = {
    id: `p${nextId++}`,
    from,
    to,
    source,
    instruction,
    label,
    text: result.trim(),
    block: multi ? true : wantsBlock(result.trim(), source, atBlockEnd(view, to)),
    // One range per block: a node decoration has to cover exactly one node, so a section is marked
    // block by block rather than with a single span over all of them.
    blocks: multi ? hits.map((hit) => ({ from: hit.pos, to: hit.pos + hit.node.nodeSize })) : null,
    split: Boolean(split),
  };
  hideBar();
  view.dispatch(view.state.tr.setMeta(proposalKey, { add: [proposal] }));
  // One proposal gets the bar (shown by the state update); several are settled in the review list.
  if (proposals(view).length > 1) focusProposal(view, proposal.id);
}

/** Adds a proposal without asking the model; used by the batch. */
function add(view, proposal) {
  view.dispatch(view.state.tr.setMeta(proposalKey, { add: [proposal] }));
}

function remove(view, id) {
  view.dispatch(view.state.tr.setMeta(proposalKey, { remove: id }));
}

/**
 * Rewrites an explicit range. The selection is the normal entry; the slash command and the batch
 * call this with a range they computed themselves.
 */
export function proposeRange(view, from, to, instruction, label) {
  if (from === to) {
    toast('先选中要改的文字');
    return;
  }
  const source = view.state.doc.textBetween(from, to, '\n');
  if (!source.trim()) {
    toast('先选中要改的文字');
    return;
  }
  if (!blocksIn(view.state.doc, from, to)) {
    const { reason } = scanBlocks(view.state.doc, from, to);
    toast(reason || FALLBACK);
    return;
  }
  run(view, { from, to, source, instruction, label, split: false });
}

/**
 * Rewrites the selection and shows the result as a proposal.
 * `instruction` is the sentence sent to the model, e.g. 「把这段话改得更简洁」; `label` is the short
 * name the user picked, and the only one of the two that is ever shown.
 */
export function propose(view, instruction, label) {
  const { from, to } = view.state.selection;
  proposeRange(view, from, to, instruction, label);
}

/**
 * Slash-command entry: rewrite the paragraph *above* the block holding the command.
 *
 * The slash menu only opens while a block starts with `/` and the caret is at its end, so the block
 * itself holds nothing but the command. The paragraph the user just wrote is the one before it.
 */
export function proposePrevious(view, instruction, label) {
  const { $from } = view.state.selection;
  if (!$from.parent.isTextblock) {
    toast('把命令单独放在一段里');
    return;
  }
  const start = $from.start();
  const before = $from.parent.textBetween(0, $from.parentOffset, '\n', '\ufffc');
  if (!before.startsWith('/')) {
    toast('把命令单独放在一段里');
    return;
  }
  const index = $from.depth === 0 ? -1 : $from.index(0);
  const block = index > 0 ? view.state.doc.child(index - 1) : null;
  if (!block || !block.isTextblock || !block.textContent.trim()) {
    // Drop the command anyway: leaving it in the document would look like a typo.
    view.dispatch(view.state.tr.delete(start, start + $from.parent.content.size));
    toast('上面没有可以改写的段落');
    return;
  }
  let blockPos = 0;
  for (let i = 0; i < index - 1; i++) blockPos += view.state.doc.child(i).nodeSize;
  const from = blockPos + 1;
  const to = from + block.content.size;
  // The command has done its job; remove it in the same breath.
  const tr = view.state.tr.delete(start, start + $from.parent.content.size);
  view.dispatch(tr);
  run(view, { from, to, source: block.textContent, instruction, label, split: false });
}

/**
 * One request per paragraph, then a review list. Used for 「逐段改写」: a long section is easier to
 * judge paragraph by paragraph than as one wall of new text.
 */
export async function proposeEach(view, instruction, label, range) {
  const { from, to } = range ?? view.state.selection;
  if (from === to) {
    toast('先选中要改的文字');
    return;
  }
  const { hits, reason } = scanBlocks(view.state.doc, from, to);
  if (reason) {
    toast(reason);
    return;
  }
  if (!hits.length) {
    toast(FALLBACK);
    return;
  }
  if (hits.length < 2) {
    proposeRange(view, from, to, instruction, label);
    return;
  }
  const parts = hits
    .map((hit) => ({ from: hit.from, to: hit.to, source: view.state.doc.textBetween(hit.from, hit.to, '\n') }))
    .filter((part) => part.source.trim());
  if (!parts.length) {
    toast('先选中要改的文字');
    return;
  }
  if (parts.length > MAX_BLOCKS) {
    toast(`一次最多改 ${MAX_BLOCKS} 段，请缩小选区`);
    return;
  }

  const doc = view.state.doc;
  batching = true;
  showBusy(view, from, `正在逐段改写 0/${parts.length}…`);
  let done = 0;
  let failed = 0;
  let same = 0;
  let firstError = '';
  let stopped = false;
  try {
    for (const [index, part] of parts.entries()) {
      setBusyNote(`正在逐段改写 ${index + 1}/${parts.length}…`);
      let result = '';
      try {
        result = await ai.rewrite(part.source, instruction);
      } catch (error) {
        failed++;
        firstError ||= String(error?.message ?? error);
        continue;
      }
      // The user kept editing while we waited: every position we hold is now wrong.
      if (view.state.doc !== doc) {
        stopped = true;
        break;
      }
      if (!result.trim() || result.trim() === part.source.trim()) {
        same++;
        continue;
      }
      add(view, {
        id: `p${nextId++}`,
        from: part.from,
        to: part.to,
        source: part.source,
        instruction,
        label,
        text: result.trim(),
        block: true,
        blocks: null,
        split: true,
      });
      done++;
    }
  } finally {
    batching = false;
  }
  hideBar();
  syncBar(view);
  if (stopped) {
    toast('文档在改写期间被修改，已停止逐段改写');
    return;
  }
  if (!done) {
    toast(failed ? firstError : 'AI 没有给出改写结果');
    return;
  }
  const notes = [`${done} 段已改`];
  if (same) notes.push(`${same} 段不用改`);
  if (failed) notes.push(`${failed} 段失败：${firstError}`);
  toast(notes.join('，'), 4000);
}

// ---------------------------------------------------------------- settling

function applyTo(tr, schema, proposal) {
  const { from, to, text, blocks } = proposal;
  if (!blocks?.length) {
    const lines = text.split('\n');
    // Milkdown names the node `hardbreak`; the camel-case spelling is the prosemirror-schema-basic one.
    const hardBreak = schema.nodes.hardbreak ?? schema.nodes.hardBreak;
    tr.insertText(lines[0], from, to);
    let pos = from + lines[0].length;
    for (const line of lines.slice(1)) {
      tr.insert(pos, hardBreak.create());
      tr.insertText(line, pos + 1);
      pos += 1 + line.length;
    }
    return pos;
  }

  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  const contentFrom = first.from + 1;
  const contentTo = last.to - 1;
  const prefix = tr.doc.textBetween(contentFrom, from);
  const suffix = tr.doc.textBetween(to, contentTo);
  const $first = tr.doc.resolve(Math.min(from, tr.doc.content.size));
  const type = $first.parent.type;
  const attrs = $first.parent.attrs;
  const paragraph = schema.nodes.paragraph;

  const inline = (value) => (value ? schema.text(value) : null);
  const lines = text.split('\n');
  const nodes = [];
  if (lines.length === 1) {
    nodes.push(type.create(attrs, inline(prefix + lines[0] + suffix)));
  } else {
    nodes.push(type.create(attrs, inline(prefix + lines[0])));
    for (const line of lines.slice(1, -1)) nodes.push(paragraph.create(null, inline(line)));
    nodes.push(paragraph.create(null, inline(lines[lines.length - 1] + suffix)));
  }
  tr.replaceWith(first.from, last.to, nodes);
}

/** Accepts one proposal. Returns false when there is nothing to accept. */
export function accept(view, id) {
  const list = proposals(view);
  const proposal = id ? list.find((p) => p.id === id) : targetOf(view, list);
  if (!proposal) return false;
  // The text under the proposal must still be the text it was written for.
  if (view.state.doc.textBetween(proposal.from, proposal.to, '\n') !== proposal.source) {
    remove(view, proposal.id);
    toast('文档已经变了，请重新选中');
    return true;
  }
  const tr = view.state.tr;
  applyTo(tr, view.state.schema, proposal);
  tr.setMeta(proposalKey, { remove: proposal.id });
  view.dispatch(tr);
  view.focus();
  return true;
}

/** Rejects one proposal; the document is untouched. */
export function reject(view, id) {
  const list = proposals(view);
  const proposal = id ? list.find((p) => p.id === id) : targetOf(view, list);
  if (!proposal) return false;
  remove(view, proposal.id);
  view.focus();
  return true;
}

/**
 * Accepts every proposal in one transaction, from the bottom up so the positions of the ones still
 * to be applied never move. One undo takes the whole batch back.
 */
export function acceptAll(view) {
  const list = proposals(view);
  if (!list.length) return 0;
  const tr = view.state.tr;
  let applied = 0;
  for (const proposal of [...list].sort((a, b) => b.from - a.from)) {
    if (tr.doc.textBetween(proposal.from, proposal.to, '\n') !== proposal.source) continue;
    applyTo(tr, view.state.schema, proposal);
    applied++;
  }
  tr.setMeta(proposalKey, { clear: true });
  view.dispatch(tr);
  view.focus();
  return applied;
}

export function rejectAll(view) {
  if (!proposals(view).length) return false;
  view.dispatch(view.state.tr.setMeta(proposalKey, { clear: true }));
  view.focus();
  return true;
}

/** Drops every proposal without touching the document. */
export function clear(view) {
  hideBar();
  if (view && proposals(view).length) view.dispatch(view.state.tr.setMeta(proposalKey, { clear: true }));
}

/** True while a proposal is on screen, so callers can leave the selection alone. */
export function active() {
  return Boolean(panelBar) || activeId !== null;
}

/** The proposal the keyboard and the review list treat as current, if any. */
export function activeProposal() {
  return activeId;
}

/** Puts the selection on a proposal and scrolls it into view. */
export function focusProposal(view, id) {
  const proposal = proposals(view).find((p) => p.id === id);
  if (!proposal) return false;
  activeId = id;
  try {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, proposal.from, proposal.to)));
    const dom = view.nodeDOM(view.state.doc.resolve(proposal.from).before(1));
    dom?.scrollIntoView({ block: 'center' });
  } catch {
    // A position that no longer resolves is handled by the next state update.
  }
  emit(view);
  return true;
}

// Keep the bar next to its anchor when the page moves.
window.addEventListener(
  'scroll',
  () => {
    if (panelBar && barView) place(barAt);
  },
  { capture: true, passive: true },
);
window.addEventListener('resize', () => {
  if (panelBar && barView) place(barAt);
});
