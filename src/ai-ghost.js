// Inline completion: a grey suggestion after the cursor, accepted with Tab.
//
// Two rules keep this cheap and quiet:
// - whether to ask the model is decided here, from the document, not by the model;
// - a suggestion is only ever a decoration, so it can never end up in the file.
//
// The decoration is built from module state rather than from a plugin state slot: this editor hands
// out decorations from one place (see `addExtraDecorations`), and reading the suggestion directly
// keeps a second lookup out of the render path.
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import { ai } from './ai-core.js';
import { IDLE_DELAY, MAX_AFTER, MAX_BEFORE, REJECT_COOLDOWN, oneLine, shouldAsk } from './ai-rules.js';
import { addExtraDecorations } from './lazy.js';

export const ghostKey = new PluginKey('ai-ghost');

let suggestion = null; // { text, pos }
let timer = null;
let token = 0;
let docVersion = 0;
let cooldownUntil = 0;
let composing = false;

/**
 * Whether asking the model about this position is worth a request.
 * Re-exported from `ai-rules.js`, where it lives free of editor imports.
 */
export { shouldAsk };

function ghostElement(text) {
  const span = document.createElement('span');
  span.className = 'ai-ghost';
  span.textContent = text;
  return span;
}

/**
 * The decoration for the current suggestion, or null.
 *
 * The caret check belongs here rather than in the plugin's `update`: `update` runs *after* the
 * decorations for that state have been built, so clearing the suggestion there would leave the old
 * widget on screen until something else happened to repaint.
 */
export function ghostDecorations(state) {
  if (!suggestion) return null;
  if (!state.selection.empty || state.selection.from !== suggestion.pos) return null;
  const at = Math.min(suggestion.pos, state.doc.content.size);
  return DecorationSet.create(state.doc, [
    Decoration.widget(at, () => ghostElement(suggestion.text), { side: 1, key: 'ai-ghost' }),
  ]);
}

// The lazy-rendering plugin owns the decorations slot in this editor, so hand ours to it.
addExtraDecorations((state) => ghostDecorations(state));

/** Repaints the editor after `suggestion` changed. The document itself is untouched. */
function repaint(view) {
  view.dispatch(view.state.tr);
}

function clear(view) {
  if (!suggestion) return;
  suggestion = null;
  repaint(view);
}

export function accept(view) {
  if (!suggestion) return false;
  const { text, pos } = suggestion;
  suggestion = null;
  const at = Math.min(pos, view.state.doc.content.size);
  const body = oneLine(text);
  const tr = view.state.tr;
  // A completion is one line by contract; a stray newline would split the paragraph.
  tr.insertText(body, at);
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(at + body.length, tr.doc.content.size))));
  view.dispatch(tr);
  view.focus();
  return true;
}

export function reject(view) {
  if (!suggestion) return false;
  clear(view);
  cooldownUntil = Date.now() + REJECT_COOLDOWN;
  view.focus();
  return true;
}

/** Everything the decision needs, read from the document once. */
export function contextOf(view) {
  const { selection, doc } = view.state;
  const { $from } = selection;
  const start = Math.max(0, $from.pos - MAX_BEFORE);
  const before = doc.textBetween(start, $from.pos, '\n');
  const after = doc.textBetween($from.pos, Math.min(doc.content.size, $from.pos + MAX_AFTER), '\n');
  return {
    enabled: ai.completionOn(),
    empty: selection.empty,
    atEnd: $from.parentOffset === $from.parent.content.size,
    paragraph: $from.parent.type.name === 'paragraph',
    isComposing: composing,
    cooldown: Date.now() < cooldownUntil,
    chars: before.trim().length,
    before,
    after,
    pos: $from.pos,
    version: docVersion,
  };
}

async function ask(view) {
  const context = contextOf(view);
  if (!shouldAsk(context)) return;
  const mine = ++token;
  const { before, after, pos, version } = context;
  let text;
  try {
    text = await ai.complete(before, after);
  } catch {
    // A completion that fails is not worth interrupting anyone over; the next pause retries.
    return;
  }
  if (mine !== token) return;
  const line = oneLine(text);
  if (!line) return;
  // The caret or the text moved while we waited: this suggestion belongs to another moment.
  if (version !== docVersion || view.state.selection.from !== pos) return;
  suggestion = { text: line, pos };
  repaint(view);
}

function schedule(view) {
  clearTimeout(timer);
  if (!ai.completionOn()) return;
  timer = setTimeout(() => ask(view), IDLE_DELAY);
}

/** Called by the editor after every document change. Cheap: one counter and one timer. */
export function notifyDocChange(view) {
  docVersion++;
  suggestion = null;
  schedule(view);
}

/**
 * Wires completion to an editor: keys are captured before ProseMirror sees them, because Tab
 * already means "indent" inside lists and must keep doing that when there is no suggestion.
 */
export function attachGhost(view) {
  const onKeyDown = (event) => {
    if (!suggestion) return;
    if (event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      accept(view);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      reject(view);
    }
  };
  const onCompositionStart = () => (composing = true);
  const onCompositionEnd = () => {
    composing = false;
    schedule(view);
  };
  view.dom.addEventListener('keydown', onKeyDown, true);
  view.dom.addEventListener('compositionstart', onCompositionStart);
  view.dom.addEventListener('compositionend', onCompositionEnd);
  return {
    accept: () => accept(view),
    reject: () => reject(view),
    clear: () => clear(view),
    has: () => suggestion !== null,
    /** Asks right away, skipping the pause. Used by tests. */
    now: () => ask(view),
    release() {
      view.dom.removeEventListener('keydown', onKeyDown, true);
      view.dom.removeEventListener('compositionstart', onCompositionStart);
      view.dom.removeEventListener('compositionend', onCompositionEnd);
      reset();
    },
  };
}

/** The controls for one view, so callers (settings, tests) can drive completion. */
const controlsByView = new WeakMap();
export function ghostControls(view) {
  return controlsByView.get(view);
}

/** Milkdown feature: drops the suggestion when the text or the caret moves, and keeps the pause. */
export const ghostFeature = $prose(
  () =>
    new Plugin({
      key: ghostKey,
      view: (editor) => {
        const controls = attachGhost(editor);
        controlsByView.set(editor, controls);
        return {
          update(current, previous) {
            if (current.state.doc !== previous.doc) {
              const stale = suggestion !== null;
              notifyDocChange(current);
              // The decorations for this state were built before `notifyDocChange` ran, so a
              // suggestion that was on screen has to be painted out explicitly. Dispatching from
              // inside a plugin view update re-enters the view, hence the microtask.
              if (stale) queueMicrotask(() => editor.dispatch(editor.state.tr));
              return;
            }
            // The caret moved: `ghostDecorations` already hides it, this just forgets it.
            if (!current.state.selection.eq(previous.selection)) suggestion = null;
          },
          destroy: () => controls.release(),
        };
      },
    }),
);

/** Drops any pending request and suggestion, e.g. when the window loses focus. */
export function reset() {
  clearTimeout(timer);
  token++;
  suggestion = null;
  cooldownUntil = 0;
}
