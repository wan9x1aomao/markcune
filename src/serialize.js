// Incremental markdown serialization.
//
// Serializing a large document takes ~0.7 s per MB and blocks the page, and autosave did it after
// every pause in typing. ProseMirror nodes are immutable and an edit keeps every untouched
// top-level block as the same object, so each block's markdown is cached by node identity and
// only changed blocks are serialized again.
//
// At the top level, remark joins blocks with one blank line and keeps no state between them, except
// that a list right after another list switches bullet ("-" then "*") so the two stay separate.
// Runs of adjacent lists are therefore serialized together as one unit. Uncached units are
// serialized in one batch with a sentinel paragraph after each, and the output is split at the
// sentinels; if that split doesn't come out exactly, the whole document is serialized as before.
// Like the document serializer, a trailing empty paragraph (the typing area) is left out.
import { schemaCtx, serializerCtx } from '@milkdown/kit/core';

const SENTINEL = '\uE000'; // private use; text containing it takes the fallback
const SEPARATOR = `\n\n${SENTINEL}\n\n`;
const ENDING = `\n\n${SENTINEL}\n`;
const BATCH = 200;
const isList = (node) => node.type.name === 'bullet_list' || node.type.name === 'ordered_list';

/**
 * For the editor's ctx, returns serialize(doc), producing the same markdown as Milkdown's
 * serializer, serializeAsync(doc), the same without blocking the page, and warm(doc, ms), which fills the cache for about `ms` milliseconds and returns
 * whether anything remains (so the first save after opening a large document is cheap too).
 */
export function incrementalSerializer(ctx) {
  const serializer = ctx.get(serializerCtx);
  const schema = ctx.get(schemaCtx);
  /** First node of a unit → { nodes, text }. */
  const cache = new WeakMap();

  /** Top-level blocks grouped into units, without a trailing empty paragraph; null if none. */
  const unitsOf = (doc) => {
    let count = doc.childCount;
    const final = count && doc.child(count - 1);
    if (final && final.type.name === 'paragraph' && final.content.size === 0) count -= 1;
    if (!count) return null;
    const units = [];
    let last = null;
    for (let i = 0; i < count; i++) {
      const node = doc.child(i);
      if (last && isList(node) && isList(last[last.length - 1])) last.push(node);
      else units.push((last = [node]));
    }
    return units;
  };

  const cached = (nodes) => {
    const hit = cache.get(nodes[0]);
    if (!hit || hit.nodes.length !== nodes.length) return undefined;
    return hit.nodes.every((node, j) => node === nodes[j]) ? hit.text : undefined;
  };

  /** Serializes `units` in one batch and caches them; false if the output can't be split. */
  const fill = (units) => {
    const sentinel = schema.nodes.paragraph.create(null, schema.text(SENTINEL));
    const children = [];
    for (const nodes of units) children.push(...nodes, sentinel);
    const output = serializer(schema.topNodeType.create(null, children));
    const parts = output.endsWith(ENDING) ? output.slice(0, -ENDING.length).split(SEPARATOR) : [];
    if (parts.length !== units.length || parts.some((part) => part.includes(SENTINEL))) return false;
    units.forEach((nodes, k) => cache.set(nodes[0], { nodes, text: parts[k] }));
    return true;
  };

  const serialize = (doc) => {
    const units = unitsOf(doc);
    if (!units) return serializer(doc);
    const missing = units.filter((nodes) => cached(nodes) === undefined);
    // Milkdown's serializer is quadratic in the number of children of a node (it rebuilds the
    // child array with concat for each child), so batches stay small.
    for (let i = 0; i < missing.length; i += BATCH) {
      if (!fill(missing.slice(i, i + BATCH))) return serializer(doc);
    }
    const markdown = units.map(cached).join('\n\n');
    return markdown && !markdown.endsWith('\n') && !markdown.endsWith('\r') ? markdown + '\n' : markdown;
  };

  /** Like serialize, but yields to the page every ~12 ms while filling the cache. */
  const serializeAsync = async (doc) => {
    const units = unitsOf(doc);
    if (!units) return serializer(doc);
    const missing = units.filter((nodes) => cached(nodes) === undefined);
    let deadline = performance.now() + 12;
    for (let i = 0; i < missing.length; i += 20) {
      if (!fill(missing.slice(i, i + 20))) return serializer(doc);
      if (performance.now() > deadline) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        deadline = performance.now() + 12;
      }
    }
    return serialize(doc);
  };

  let warming = { doc: null, units: [], next: 0 };
  const warm = (doc, ms) => {
    const deadline = performance.now() + ms;
    if (warming.doc !== doc) warming = { doc, units: unitsOf(doc) ?? [], next: 0 };
    const { units } = warming;
    while (warming.next < units.length) {
      const batch = [];
      while (warming.next < units.length && batch.length < 20) {
        const nodes = units[warming.next++];
        if (cached(nodes) === undefined) batch.push(nodes);
      }
      if (batch.length && !fill(batch)) return false;
      if (performance.now() > deadline) break;
    }
    return warming.next < units.length;
  };

  return { serialize, serializeAsync, warm };
}
