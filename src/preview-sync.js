/** Remembers the markdown last pushed to the split preview. `reset` runs when the document changes. */
export function createPreviewCache() {
  let markdown = null;
  return {
    reset() {
      markdown = null;
    },
    apply(next, setMarkdown) {
      if (next === markdown) return false;
      markdown = next;
      setMarkdown(next);
      return true;
    },
  };
}
