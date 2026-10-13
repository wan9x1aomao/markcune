// ProseMirror plugins for the rich editor.
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
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
