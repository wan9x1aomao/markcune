// Virtual rendering for large documents.
//
// A long document produces hundreds of thousands of DOM nodes (plus a Vue app per list item,
// table and image), and WebKit then needs seconds for every style/layout pass: opening, typing and
// scrolling all crawl. For documents with many top-level blocks, only the blocks near the viewport
// (and the ones holding the selection) are rendered for real; every other top-level block is an
// empty box of its measured (or estimated) height. The ProseMirror document is untouched, so
// saving, undo, find and copy work on the whole document as before.
//
// Mechanism: the plugin decorates the top-level blocks that should be real; every block node view
// is wrapped so that a top-level block without that decoration renders as a placeholder, and a
// change of the decoration makes ProseMirror recreate the view.
import { EditorStateReady, editorStateCtx, editorViewTimerCtx, nodeViewCtx } from '@milkdown/kit/core';
import { createTimer } from '@milkdown/kit/ctx';
import { DOMSerializer } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import { POSITIONS_UNCHANGED } from './plugins.js';

/** Documents with fewer top-level blocks render normally. */
export const LAZY_MIN_BLOCKS = 200;
const REAL = { mdpadReal: true };
const lazyKey = new PluginKey('mdpad-lazy');

const isLarge = (doc) => doc.childCount >= LAZY_MIN_BLOCKS;
const isReal = (decorations) => decorations.some((d) => d.spec.mdpadReal);

// ProseMirror asks every plugin for decorations and keeps only the first non-null answer, and this
// plugin almost always has one (it marks which blocks are real). So features that need decorations
// of their own — the AI suggestion and the AI proposal — register them here instead of losing that
// race. Providers are called with the editor state on every update.
const extraDecorations = [];

/** Adds a decorations provider. Returns a function that removes it again. */
export function addExtraDecorations(provider) {
  extraDecorations.push(provider);
  return () => {
    const at = extraDecorations.indexOf(provider);
    if (at >= 0) extraDecorations.splice(at, 1);
  };
}

/** Start positions of the top-level blocks, cached per document. */
const startsCache = new WeakMap();
function startsOf(doc) {
  let starts = startsCache.get(doc);
  if (!starts) {
    starts = new Array(doc.childCount);
    let pos = 0;
    for (let i = 0; i < doc.childCount; i++) {
      starts[i] = pos;
      pos += doc.child(i).nodeSize;
    }
    startsCache.set(doc, starts);
  }
  return starts;
}

/** Index of the top-level block containing (or starting at) `pos`. */
function indexAt(doc, pos) {
  const starts = startsOf(doc);
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function buildDecorations(doc, { all, from, to, pins }, selection) {
  const decorations = [];
  const starts = startsOf(doc);
  const add = (i) => decorations.push(Decoration.node(starts[i], starts[i] + doc.child(i).nodeSize, {}, REAL));
  if (all) {
    for (let i = 0; i < starts.length; i++) add(i);
    return DecorationSet.create(doc, decorations);
  }
  const wanted = new Set();
  const first = indexAt(doc, from);
  for (let i = first; i < starts.length && starts[i] < to; i++) wanted.add(i);
  wanted.add(indexAt(doc, selection.from));
  wanted.add(indexAt(doc, selection.to));
  for (const pin of pins) wanted.add(indexAt(doc, pin));
  [...wanted].sort((a, b) => a - b).forEach(add);
  return DecorationSet.create(doc, decorations);
}

// Heights: measured heights of blocks that have been real, estimates for the rest. Estimates are
// corrected per node type by the ratio between measured and estimated heights seen so far.
const LINE = 28;
const measured = new WeakMap();
const ratio = new Map();

function estimate(node, width) {
  const perLine = Math.max(20, width / 9);
  const lines = (length) => Math.max(1, Math.ceil(length / perLine));
  switch (node.type.name) {
    case 'heading':
      return 64;
    case 'code_block':
      return node.textContent.split('\n').length * 22 + 70;
    case 'table':
      return node.childCount * 46 + 24;
    case 'image-block':
      return 320;
    case 'hr':
      return 40;
    case 'bullet_list':
    case 'ordered_list':
      return (node.childCount + lines(node.textContent.length)) * LINE + 16;
    default:
      return lines(node.textContent.length) * LINE + 16;
  }
}

function heightOf(node, width) {
  const known = measured.get(node);
  if (known !== undefined) return known;
  return Math.round(estimate(node, width) * (ratio.get(node.type.name)?.value ?? 1));
}

function learn(node, height, width) {
  measured.set(node, height);
  const entry = ratio.get(node.type.name) ?? { measured: 0, estimated: 0, value: 1 };
  entry.measured += height;
  entry.estimated += estimate(node, width);
  entry.value = Math.min(4, Math.max(0.25, entry.measured / entry.estimated));
  ratio.set(node.type.name, entry);
}

function placeholderView(node, width) {
  const dom = document.createElement('div');
  dom.className = 'mdpad-lazy';
  dom.contentEditable = 'false';
  dom.style.height = `${heightOf(node, width)}px`;
  let current = node;
  return {
    dom,
    update(next, outer) {
      if (isReal(outer)) return false;
      if (next !== current) {
        current = next;
        dom.style.height = `${heightOf(next, width)}px`;
      }
      return true;
    },
    ignoreMutation: () => true,
  };
}

/** A top-level block rendered for real: the original node view, or the node's own toDOM. */
function realView(node, view, getPos, outer, inner, original) {
  let nodeView = original?.(node, view, getPos, outer, inner);
  if (!nodeView?.dom) {
    const { dom, contentDOM } = DOMSerializer.renderSpec(document, node.type.spec.toDOM(node), null, node.attrs);
    nodeView = { dom, contentDOM };
  }
  const update = nodeView.update?.bind(nodeView);
  let current = node;
  nodeView.update = (next, nextOuter, nextInner) => {
    if (!isReal(nextOuter)) return false;
    if (update) return update(next, nextOuter, nextInner);
    // ProseMirror's own rule for views without update().
    if ((!nodeView.contentDOM && !next.isLeaf) || !next.sameMarkup(current)) return false;
    current = next;
    return true;
  };
  return nodeView;
}

function wrapNodeViews(nodeViews, schema, getWidth) {
  const wrapped = { ...nodeViews };
  for (const type of Object.values(schema.nodes)) {
    if (!type.isBlock) continue;
    const original = nodeViews[type.name];
    wrapped[type.name] = (node, view, getPos, outer, inner) => {
      const pos = getPos();
      const doc = view.state.doc;
      const starts = startsOf(doc);
      const index = typeof pos === 'number' ? indexAt(doc, pos) : -1;
      const topLevel = index >= 0 && starts[index] === pos && doc.child(index) === node;
      if (!topLevel) return original?.(node, view, getPos, outer, inner);
      if (!isReal(outer)) return placeholderView(node, getWidth(view));
      return realView(node, view, getPos, outer, inner, original);
    };
  }
  return wrapped;
}

/** Per-view helpers, for the editor wrapper. */
const controllers = new WeakMap();

/**
 * Lazy rendering for the editor scrolled by `scroller`. Use both `views` and `plugin` with
 * editor.use().
 */
export function createLazy(scroller) {
  const width = (view) => view.dom.clientWidth || 700;

  // Wraps the registered node views once the initial document is known, before the view is
  // created (the view waits for this timer). Node views register right after the schema is ready,
  // long before the editor state.
  const LazyViewsReady = createTimer('MdpadLazyViewsReady');
  const views = (ctx) => {
    ctx.record(LazyViewsReady);
    ctx.update(editorViewTimerCtx, (timers) => timers.concat(LazyViewsReady));
    return async () => {
      await ctx.wait(EditorStateReady);
      performance.mark('mdpad:state-ready');
      const { doc, schema } = ctx.get(editorStateCtx);
      if (isLarge(doc)) {
        ctx.update(nodeViewCtx, (entries) => Object.entries(wrapNodeViews(Object.fromEntries(entries), schema, width)));
      }
      ctx.done(LazyViewsReady);
      return () => ctx.clearTimer(LazyViewsReady);
    };
  };

  const plugin = $prose(
    () =>
      new Plugin({
        key: lazyKey,
        state: {
          init(_, state) {
            const active = isLarge(state.doc);
            if (!active) return { active };
            // Start with roughly three screens of blocks from the top.
            let to = 0;
            let height = 0;
            for (let i = 0; i < state.doc.childCount && height < 3000; i++) {
              const node = state.doc.child(i);
              height += heightOf(node, 700);
              to += node.nodeSize;
            }
            const value = { active, all: false, from: 0, to, pins: [] };
            return { ...value, decorations: buildDecorations(state.doc, value, state.selection) };
          },
          apply(tr, prev, _old, state) {
            if (!prev.active) return prev;
            const meta = tr.getMeta(lazyKey);
            if (!meta && !tr.docChanged && !tr.selectionSet) return prev;
            let { all, from, to, pins } = prev;
            if (tr.docChanged && !tr.getMeta(POSITIONS_UNCHANGED)) {
              from = tr.mapping.map(from, -1);
              to = tr.mapping.map(to, 1);
              pins = pins.map((pin) => tr.mapping.map(pin));
            }
            if (meta?.all !== undefined) all = meta.all;
            if (meta?.window) {
              [from, to] = meta.window;
              pins = [];
            }
            if (meta?.pin !== undefined) pins = [...pins, meta.pin];
            const size = state.doc.content.size;
            from = Math.min(Math.max(from, 0), size);
            to = Math.min(Math.max(to, from), size);
            const value = { active: true, all, from, to, pins };
            if (!meta && !tr.docChanged) {
              // Selection moved: only matters if it entered a block that isn't real.
              const { doc, selection } = state;
              const inWindow = (pos) => pos >= from && pos <= to;
              if (all || (inWindow(selection.from) && inWindow(selection.to))) return prev;
              const old = _old.selection;
              if (indexAt(doc, old.from) === indexAt(doc, selection.from) && indexAt(doc, old.to) === indexAt(doc, selection.to)) {
                return prev;
              }
            }
            return { ...value, decorations: buildDecorations(state.doc, value, state.selection) };
          },
        },
        props: {
          decorations: (state) => {
            let set = lazyKey.getState(state).decorations ?? null;
            for (const provider of extraDecorations) {
              const more = provider(state);
              if (more) set = set ? set.add(state.doc, more) : more;
            }
            return set;
          },
        },
        view(view) {
          performance.mark('mdpad:view-created');
          if (!lazyKey.getState(view.state).active) return {};
          let frame = 0;
          let lastWidth = width(view);

          const rectOf = (doc, i) => view.nodeDOM(startsOf(doc)[i])?.getBoundingClientRect();

          /** Remembers the heights of the blocks currently rendered for real. */
          const measure = (doc, state) => {
            const starts = startsOf(doc);
            const first = indexAt(doc, state.from);
            const last = Math.min(indexAt(doc, state.to), starts.length - 1);
            const w = width(view);
            let top = rectOf(doc, first)?.top;
            for (let i = first; i <= last && top !== undefined; i++) {
              if (i + 1 >= starts.length) break;
              const next = rectOf(doc, i + 1)?.top;
              if (next === undefined) break;
              const dom = view.nodeDOM(starts[i]);
              if (dom && !dom.classList?.contains('mdpad-lazy')) learn(doc.child(i), Math.max(0, next - top), w);
              top = next;
            }
          };

          /** First and last block intersecting the scroller's box widened by `margin` pixels. */
          const range = (doc, margin) => {
            const n = doc.childCount;
            const box = scroller.getBoundingClientRect();
            const top = box.top - margin;
            const bottom = box.bottom + margin;
            let lo = 0;
            let hi = n - 1;
            while (lo < hi) {
              const mid = (lo + hi) >> 1;
              if (rectOf(doc, mid).bottom > top) hi = mid;
              else lo = mid + 1;
            }
            const first = lo;
            hi = n - 1;
            while (lo < hi) {
              const mid = (lo + hi + 1) >> 1;
              if (rectOf(doc, mid).top < bottom) lo = mid;
              else hi = mid - 1;
            }
            return [first, Math.max(first, lo)];
          };

          const refresh = () => {
            frame = 0;
            const state = lazyKey.getState(view.state);
            if (!state.active || state.all || view.isDestroyed || !view.dom.isConnected) return;
            const { doc } = view.state;
            if (!doc.childCount) return;
            const w = width(view);
            if (w !== lastWidth) {
              // Line wrapping changed: re-measure everything from now on.
              lastWidth = w;
              ratio.clear();
            }
            measure(doc, state);
            const screen = scroller.clientHeight || 800;
            const starts = startsOf(doc);
            const [needFirst, needLast] = range(doc, screen * 0.5);
            const have = [indexAt(doc, state.from), indexAt(doc, Math.max(state.from, state.to - 1))];
            const covered = needFirst >= have[0] && needLast <= have[1];
            const tooBig = have[1] - have[0] > (needLast - needFirst) * 4 + 60;
            if (covered && !tooBig) return;
            const [first, last] = range(doc, screen * 1.5);
            // Keep the first visible block where it is while blocks above it change height.
            const [anchor] = range(doc, 0);
            const before = rectOf(doc, anchor)?.top;
            const window = [starts[first], starts[last] + doc.child(last).nodeSize];
            view.dispatch(view.state.tr.setMeta(lazyKey, { window }));
            const after = rectOf(view.state.doc, anchor)?.top;
            if (before !== undefined && after !== undefined && Math.abs(after - before) > 0.5) {
              scroller.scrollTop += after - before;
            }
          };
          const schedule = () => {
            if (!frame) frame = requestAnimationFrame(refresh);
          };

          scroller.addEventListener('scroll', schedule, { passive: true });
          window.addEventListener('resize', schedule);
          controllers.set(view, {
            refresh,
            /** Renders the block at `pos` for real (e.g. before scrolling to it). */
            reveal(pos) {
              view.dispatch(view.state.tr.setMeta(lazyKey, { pin: pos }));
            },
            /** Renders every block, e.g. for printing or export. */
            setAll(all) {
              view.dispatch(view.state.tr.setMeta(lazyKey, { all }));
              if (!all) refresh();
            },
            /** The first visible top-level block and how far the view is scrolled past its top. */
            topBlock() {
              const { doc } = view.state;
              const [index] = range(doc, 0);
              const rect = rectOf(doc, index);
              if (!rect) return null;
              return { pos: startsOf(doc)[index], offset: Math.round(scroller.getBoundingClientRect().top - rect.top) };
            },
            scrollToBlock({ pos, offset = 0 }) {
              const target = () => {
                const { doc } = view.state;
                const index = indexAt(doc, Math.min(Math.max(pos, 0), doc.content.size));
                const rect = rectOf(doc, index);
                if (!rect) return;
                scroller.scrollTop += rect.top - scroller.getBoundingClientRect().top - offset;
                refresh();
              };
              const { doc } = view.state;
              const index = indexAt(doc, Math.min(Math.max(pos, 0), doc.content.size));
              this.reveal(startsOf(doc)[index]);
              target();
              // Rendering a pinned block can change its measured height. Re-apply the target
              // position after the DOM update so clicks work for distant headings too.
              requestAnimationFrame(() => {
                target();
                requestAnimationFrame(target);
              });
            }
          });
          return {
            update(_, previous) {
              if (view.state.doc !== previous.doc) schedule();
            },
            destroy() {
              cancelAnimationFrame(frame);
              scroller.removeEventListener('scroll', schedule);
              window.removeEventListener('resize', schedule);
              controllers.delete(view);
            },
          };
        },
      }),
  );

  return { views, plugin };
}

/** The lazy-rendering controller of `view`, or null when the document renders normally. */
export const lazyController = (view) => controllers.get(view) ?? null;
