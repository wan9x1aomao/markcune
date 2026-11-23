const LARGE_DELETION = 500;
const LARGE_DELETION_RATIO = 0.2;
const MIN_RATIO_LENGTH = 200;

/**
 * Decides whether a change deserves a short autosave pause.
 * The returned counts are useful for the user-facing warning without serializing again.
 */
export function detectDestructiveDeletion(before, after) {
  const previous = String(before ?? '');
  const next = String(after ?? '');
  const removed = Math.max(0, previous.length - next.length);
  const ratio = previous.length ? removed / previous.length : 0;
  const destructive =
    (previous.trim().length > 0 && next.trim().length === 0) ||
    removed >= LARGE_DELETION ||
    (previous.length >= MIN_RATIO_LENGTH && ratio >= LARGE_DELETION_RATIO);
  return { destructive, removed, ratio };
}

export function saveDelayForDeletion(before, after, normalDelay, guardedDelay) {
  return detectDestructiveDeletion(before, after).destructive ? guardedDelay : normalDelay;
}
