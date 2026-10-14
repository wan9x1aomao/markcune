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
const isList = (node) => node.type.name === 'bullet_list' || node.type.name === 'ordered_list';

/**
 * For the editor's ctx, returns serialize(doc), producing the same markdown as Milkdown's
 * serializer, and warm(doc, limit), which caches up to `limit` more units and returns whether
 * any remain (so the first save after opening a large document needn't serialize all of it).
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
    if (missing.length && !fill(missing)) return serializer(doc);
    const markdown = units.map(cached).join('\n\n');
    return markdown && !markdown.endsWith('\n') && !markdown.endsWith('\r') ? markdown + '\n' : markdown;
  };

  const warm = (doc, limit) => {
    const units = unitsOf(doc);
    if (!units) return false;
    const missing = [];
    for (const nodes of units) {
      if (cached(nodes) !== undefined) continue;
      if (missing.length === limit) return fill(missing);
      missing.push(nodes);
    }
    if (missing.length) fill(missing);
    return false;
  };

  return { serialize, warm };
}
