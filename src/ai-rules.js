// The rules behind inline completion, kept free of any editor import so they can be tested
// directly. Everything here is a pure function of its arguments.

/** How long the caret has to rest before a request is made. */
export const IDLE_DELAY = 600;
/** After a rejection, stay quiet for a while instead of offering the same text again. */
export const REJECT_COOLDOWN = 2500;
/** Shorter text than this gives the model nothing to work with. */
export const MIN_CHARS = 4;
/** How much surrounding text is sent: enough for context, small enough to stay fast. */
export const MAX_BEFORE = 2000;
export const MAX_AFTER = 600;

/**
 * Whether asking the model about this position is worth a request.
 *
 * The model is never asked "should I complete here" — that decision is made from the document,
 * which keeps a keystroke from turning into a request and keeps the cost predictable.
 */
export function shouldAsk({ enabled, empty, atEnd, paragraph, isComposing, cooldown, chars }) {
  return Boolean(enabled) && empty && atEnd && paragraph && !isComposing && !cooldown && chars >= MIN_CHARS;
}

/**
 * A completion is one line by contract: a stray newline would split the paragraph it lands in.
 * Also trims, because leading space from the model reads as a typo.
 */
export function oneLine(text) {
  return String(text ?? '')
    .replace(/\s*\n+\s*/g, ' ')
    .trim();
}
