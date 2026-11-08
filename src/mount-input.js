/**
 * Keystrokes during `crepe.create()` land in the document before the caller takes its baseline
 * snapshot. Clearing the snapshot and marking pending is what makes the next save write them.
 * A reload flag that ignores every change for the whole mount drops those keystrokes.
 */
export function mountBaseline(typed) {
  return typed ? { replaceSnapshot: true, pending: true } : { replaceSnapshot: false, pending: false };
}

/** A change is recorded whenever the current editor exists. Reload does not add a second veto. */
export function acceptsEdit(editor) {
  return Boolean(editor);
}
