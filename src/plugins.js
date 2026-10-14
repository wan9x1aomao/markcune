// ProseMirror plugins for the rich editor.
import { Fragment } from '@milkdown/kit/prose/model';
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import {
  bulletListSchema,
  headingIdGenerator,
  headingSchema,
  listItemSchema,
  orderedListSchema,
} from '@milkdown/kit/preset/commonmark';
import { $prose } from '@milkdown/kit/utils';

// Reveal markdown syntax around the cursor, Typora style.

const DELIMITERS = { strong: '**', emphasis: '*', inlineCode: '`', strike_through: '~~' };

/** The contiguous range of `type` around `$pos` within its textblock. */
function markRange($pos, type) {
  const { parent, parentOffset } = $pos;
  let child = parent.childAfter(parentOffset);
  if (!child.node || !type.isInSet(child.node.marks)) child = parent.childBefore(parentOffset);
  const mark = child.node && type.isInSet(child.node.marks);
  if (!mark) return null;
  let from = $pos.start() + child.offset;
  let to = from + child.node.nodeSize;
  let start = child.index;
  while (start > 0 && mark.isInSet(parent.child(start - 1).marks)) {
    start -= 1;
    from -= parent.child(start).nodeSize;
  }
  let end = child.index + 1;
  while (end < parent.childCount && mark.isInSet(parent.child(end).marks)) {
    to += parent.child(end).nodeSize;
    end += 1;
  }
  return { from, to, mark };
}

function marker(text) {
  return () => {
    const span = document.createElement('span');
    span.className = 'md-marker';
    span.textContent = text;
    return span;
  };
}

export const markdownMarkers = $prose(
  () =>
    new Plugin({
      key: new PluginKey('mdpad-markers'),
      props: {
        decorations(state) {
          const { $from, $to } = state.selection;
          if (!$from.sameParent($to) || !$from.parent.isTextblock) return null;
          const decorations = [];
          const parent = $from.parent;
          if (parent.type.name === 'heading') {
            const hashes = '#'.repeat(parent.attrs.level) + ' ';
            decorations.push(Decoration.widget($from.start(), marker(hashes), { side: -1, key: hashes }));
          }
          for (const [name, delimiter] of Object.entries(DELIMITERS)) {
            const type = state.schema.marks[name];
            const range = type && markRange($from, type);
            if (!range) continue;
            decorations.push(Decoration.widget(range.from, marker(delimiter), { side: -1, key: `${name}<${range.from}` }));
            decorations.push(Decoration.widget(range.to, marker(delimiter), { side: 1, key: `${name}>${range.to}` }));
          }
          const link = state.schema.marks.link;
          const range = link && markRange($from, link);
          if (range) {
            const close = `](${range.mark.attrs.href})`;
            decorations.push(Decoration.widget(range.from, marker('['), { side: -1, key: `link<${range.from}` }));
            decorations.push(Decoration.widget(range.to, marker(close), { side: 1, key: `link>${range.to}${close}` }));
          }
          return decorations.length ? DecorationSet.create(state.doc, decorations) : null;
        },
      },
    }),
);

// Pasting a URL onto selected text turns the text into a link.

const URL_PATTERN = /^(https?:\/\/|mailto:)\S+$/i;

export const linkPaste = $prose(
  () =>
    new Plugin({
      key: new PluginKey('mdpad-link-paste'),
      props: {
        handleDOMEvents: {
          // Runs before the clipboard plugin, which would otherwise replace the selection.
          paste(view, event) {
            const { selection, schema } = view.state;
            const text = event.clipboardData?.getData('text/plain')?.trim() ?? '';
            if (selection.empty || !(selection instanceof TextSelection) || !schema.marks.link) return false;
            if (!URL_PATTERN.test(text)) return false;
            event.preventDefault();
            const mark = schema.marks.link.create({ href: text });
            view.dispatch(view.state.tr.addMark(selection.from, selection.to, mark));
            return true;
          },
        },
      },
    }),
);

// Find in document.

export const findKey = new PluginKey('mdpad-find');

function search(doc, query) {
  const matches = [];
  if (!query) return matches;
  const needle = query.toLowerCase();
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const text = node.textBetween(0, node.content.size, undefined, '￼').toLowerCase();
    for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) {
      matches.push({ from: pos + 1 + i, to: pos + 1 + i + needle.length });
    }
    return false;
  });
  return matches;
}

export const findPlugin = $prose(
  () =>
    new Plugin({
      key: findKey,
      state: {
        init: () => ({ query: '', matches: [], index: 0 }),
        apply(tr, previous) {
          const meta = tr.getMeta(findKey);
          if (meta) {
            const query = meta.query ?? previous.query;
            const matches = query === previous.query && !tr.docChanged ? previous.matches : search(tr.doc, query);
            const index = Math.min(Math.max(meta.index ?? previous.index, 0), Math.max(matches.length - 1, 0));
            return { query, matches, index };
          }
          if (tr.docChanged && previous.query) {
            const matches = search(tr.doc, previous.query);
            return { ...previous, matches, index: Math.min(previous.index, Math.max(matches.length - 1, 0)) };
          }
          return previous;
        },
      },
      props: {
        decorations(state) {
          const { matches, index } = findKey.getState(state);
          if (!matches.length) return null;
          return DecorationSet.create(
            state.doc,
            matches.map((m, i) =>
              Decoration.inline(m.from, m.to, { class: i === index ? 'find-match find-current' : 'find-match' }),
            ),
          );
        },
      },
    }),
);

// Actions shown next to a selected image: replace, width, caption.

const WIDTHS = [
  { label: '小', ratio: 0.33 },
  { label: '中', ratio: 0.5 },
  { label: '大', ratio: 0.75 },
  { label: '原始', ratio: 1 },
];

export function imageActions({ onReplace, onCaption }) {
  return $prose(
    () =>
      new Plugin({
        key: new PluginKey('mdpad-image-actions'),
        view(view) {
          const bar = document.createElement('div');
          bar.className = 'image-actions';
          bar.hidden = true;
          document.body.appendChild(bar);
          // Keep focus (and the selection) in the editor while clicking the bar.
          bar.addEventListener('mousedown', (event) => event.preventDefault());

          const selectedImage = () => {
            const { selection } = view.state;
            return selection instanceof NodeSelection && selection.node.type.name === 'image-block'
              ? { node: selection.node, pos: selection.from }
              : null;
          };
          const setAttrs = (attrs) => {
            const image = selectedImage();
            if (!image) return;
            const tr = view.state.tr.setNodeMarkup(image.pos, null, { ...image.node.attrs, ...attrs });
            view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, image.pos)));
          };

          const update = () => {
            const image = selectedImage();
            if (!image || !view.editable) {
              bar.hidden = true;
              return;
            }
            bar.replaceChildren();
            const button = (label, run, active = false) => {
              const b = document.createElement('button');
              b.textContent = label;
              b.classList.toggle('active', active);
              b.addEventListener('click', run);
              bar.appendChild(b);
            };
            const separator = () => bar.appendChild(Object.assign(document.createElement('span'), { className: 'separator' }));
            button('替换', async () => {
              const src = await onReplace();
              if (src) setAttrs({ src });
            });
            separator();
            for (const width of WIDTHS) {
              button(width.label, () => setAttrs({ ratio: width.ratio }), Math.abs(image.node.attrs.ratio - width.ratio) < 0.01);
            }
            separator();
            button('说明', async () => {
              const caption = await onCaption(image.node.attrs.caption);
              if (caption !== null) setAttrs({ caption });
            });
            const dom = view.nodeDOM(image.pos);
            const rect = (dom?.querySelector?.('img') ?? dom)?.getBoundingClientRect();
            if (!rect) return;
            bar.hidden = false;
            const top = rect.top - bar.offsetHeight - 8;
            bar.style.top = `${top > 50 ? top : rect.bottom + 8}px`;
            bar.style.left = `${Math.max(8, rect.left + rect.width / 2 - bar.offsetWidth / 2)}px`;
          };

          const scroller = view.dom.closest('.pane');
          const hide = () => (bar.hidden = true);
          scroller?.addEventListener('scroll', hide, { passive: true });
          return {
            update,
            destroy() {
              scroller?.removeEventListener('scroll', hide);
              bar.remove();
            },
          };
        },
      }),
  );
}

// Faster copies of two plugins from Milkdown's commonmark preset, which walk every node of the
// document (including all inline content) after each change: 45 ms per keystroke at 5 MB. They
// produce the same attributes, but skip the inside of textblocks (which can contain neither
// headings nor lists) and only look at the part of the document that changed: heading ids depend
// only on the sequence of headings, and list labels only on their own list.

/** Transaction meta: the document changed, but every position still means the same place. */
export const POSITIONS_UNCHANGED = 'mdpadPositionsUnchanged';

/** The range of top-level blocks of `doc` (and of `prev`) that differ between the two, or null. */
function changedRange(prev, doc) {
  const start = doc.content.findDiffStart(prev.content);
  if (start == null) return null;
  const end = doc.content.findDiffEnd(prev.content);
  // Widen to whole top-level blocks: a list item's label depends on the items before it.
  const widen = (node, from, to) => {
    const $from = node.resolve(Math.min(Math.max(from, 0), node.content.size));
    const $to = node.resolve(Math.min(Math.max(to, 0), node.content.size));
    return [$from.depth ? $from.before(1) : $from.pos, $to.depth ? $to.after(1) : $to.pos];
  };
  const [from, to] = widen(doc, start - 1, Math.max(end.a, start) + 1);
  const [prevFrom, prevTo] = widen(prev, start - 1, Math.max(end.b, start) + 1);
  return { from, to, prevFrom, prevTo };
}

function hasNodeOfType(doc, from, to, type) {
  let found = false;
  doc.nodesBetween(from, to, (node) => {
    if (found || node.type === type) found = true;
    return !found && !node.isTextblock;
  });
  return found;
}

/** Same as commonmark's syncHeadingIdPlugin: keeps each heading's `id` attribute current. */
export const syncHeadingIds = $prose((ctx) => {
  const key = new PluginKey('MDPAD_HEADING_ID');
  const updateId = (view) => {
    if (view.composing) return;
    const getId = ctx.get(headingIdGenerator.key);
    const headingType = headingSchema.type(ctx);
    const { doc, selection } = view.state;
    const changes = [];
    const idMap = {};
    doc.descendants((node, pos) => {
      if (node.type === headingType) {
        if (node.textContent.trim().length === 0) return false;
        const attrs = node.attrs;
        let id = getId(node);
        if (idMap[id]) {
          idMap[id] += 1;
          id += `-#${idMap[id]}`;
        } else {
          idMap[id] = 1;
        }
        if (attrs.id !== id) changes.push({ pos, id });
        return false;
      }
      return !node.isTextblock;
    });
    if (!changes.length) return;
    const tr = view.state.tr.setMeta('addToHistory', false).setMeta(key, true);
    if (changes.length <= 50) {
      for (const { pos, id } of changes) tr.setNodeMarkup(pos, undefined, { ...doc.nodeAt(pos).attrs, id });
    } else {
      // One setNodeMarkup step per heading copies the document's top-level child array each time
      // (6 s for the ~4,000 headings of a 5 MB file when it opens). Replace the affected top-level
      // range in one step instead; only attributes change, so positions stay the same.
      const ids = new Map(changes.map(({ pos, id }) => [pos, id]));
      const first = changes[0].pos;
      const last = changes[changes.length - 1].pos;
      const rebuild = (node, pos) => {
        if (ids.has(pos) && node.type === headingType) {
          return node.type.create({ ...node.attrs, id: ids.get(pos) }, node.content, node.marks);
        }
        if (node.isTextblock || node.isLeaf) return node;
        const children = [];
        node.forEach((child, offset) => children.push(rebuild(child, pos + 1 + offset)));
        return node.copy(Fragment.from(children));
      };
      const $first = doc.resolve(first);
      const $last = doc.resolve(last);
      const start = $first.depth ? $first.before(1) : first;
      const end = $last.depth ? $last.after(1) : last + doc.nodeAt(last).nodeSize;
      const nodes = [];
      doc.nodesBetween(start, end, (node, pos) => {
        nodes.push(rebuild(node, pos));
        return false;
      });
      tr.replaceWith(start, end, nodes);
      const same = { map: (pos) => pos, mapResult: (pos) => ({ pos, deleted: false }) };
      tr.setSelection(selection.map(tr.doc, same)).setMeta(POSITIONS_UNCHANGED, true);
    }
    view.dispatch(tr);
  };
  return new Plugin({
    key,
    view: (view) => {
      updateId(view);
      return {
        update: (view, prevState) => {
          if (view.state.doc.eq(prevState.doc)) return;
          // Ids only change when a heading was added, removed or edited.
          const range = changedRange(prevState.doc, view.state.doc);
          const headingType = headingSchema.type(ctx);
          if (
            range &&
            !hasNodeOfType(view.state.doc, range.from, range.to, headingType) &&
            !hasNodeOfType(prevState.doc, range.prevFrom, range.prevTo, headingType)
          ) {
            return;
          }
          updateId(view);
        },
      };
    },
  });
});

/** Same as commonmark's syncListOrderPlugin: keeps ordered list item labels current. */
export const syncListOrder = $prose((ctx) => {
  const syncOrderLabel = (transactions, _oldState, newState) => {
    if (!newState.selection || transactions.some((tr) => tr.getMeta('addToHistory') === false || !tr.isGeneric)) {
      return null;
    }
    const orderedListType = orderedListSchema.type(ctx);
    const bulletListType = bulletListSchema.type(ctx);
    const listItemType = listItemSchema.type(ctx);
    const handleNodeItem = (attrs, index, order = 1) => {
      const expectedLabel = `${index + order}.`;
      if (attrs.label === expectedLabel) return false;
      attrs.label = expectedLabel;
      return true;
    };
    const range = changedRange(_oldState.doc, newState.doc);
    if (!range) return null;
    let tr = newState.tr;
    let needDispatch = false;
    newState.doc.nodesBetween(range.from, range.to, (node, pos, parent, index) => {
      if (node.isTextblock) return false;
      if (node.type === bulletListType) {
        const base = node.maybeChild(0);
        if (base?.type === listItemType && base.attrs.listType === 'ordered') {
          needDispatch = true;
          tr.setNodeMarkup(pos, orderedListType, { spread: true });
          // (Positions relative to the list, as in the original.)
          node.descendants((child, childPos, _parent, childIndex) => {
            if (child.type === listItemType) {
              const attrs = { ...child.attrs };
              if (handleNodeItem(attrs, childIndex)) tr = tr.setNodeMarkup(childPos, undefined, attrs);
            }
            return false;
          });
        }
      } else if (node.type === listItemType && parent?.type === orderedListType) {
        const attrs = { ...node.attrs };
        let changed = false;
        if (attrs.listType !== 'ordered') {
          attrs.listType = 'ordered';
          changed = true;
        }
        const base = parent?.maybeChild(0);
        if (base) changed = handleNodeItem(attrs, index, parent?.attrs.order ?? 1);
        if (changed) {
          tr = tr.setNodeMarkup(pos, undefined, attrs);
          needDispatch = true;
        }
      }
      return true;
    });
    return needDispatch ? tr.setMeta('addToHistory', false) : null;
  };
  return new Plugin({ key: new PluginKey('MDPAD_KEEP_LIST_ORDER'), appendTransaction: syncOrderLabel });
});
