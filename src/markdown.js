import { remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import { imageBlockSchema } from '@milkdown/kit/component/image-block';
import { remarkGFMPlugin } from '@milkdown/kit/preset/gfm';
import stringWidth from 'string-width';

// Keep saved markdown close to what the user wrote.
export function preserveMarkdown(ctx) {
  ctx.update(remarkStringifyOptionsCtx, (prev) => ({ ...prev, bullet: '-' }));
  // Measure table cells by display width so CJK columns stay aligned.
  ctx.update(remarkGFMPlugin.options.key, (prev) => ({ ...prev, stringLength: stringWidth }));

  // Crepe's image block stores its size ratio as the whole alt text, which would
  // replace `![description](src)` with `![1.00](src)`. Keep the description and
  // append the ratio Obsidian-style instead: `![description|0.50](src)`.
  ctx.update(imageBlockSchema.key, (prev) => (innerCtx) => {
    const schema = prev(innerCtx);
    return {
      ...schema,
      attrs: { ...schema.attrs, alt: { default: '', validate: 'string' } },
      parseDOM: schema.parseDOM.map((rule) => ({
        ...rule,
        getAttrs: (dom) => {
          const attrs = rule.getAttrs(dom);
          return attrs && { ...attrs, alt: dom.getAttribute('alt') ?? '' };
        },
      })),
      parseMarkdown: {
        match: schema.parseMarkdown.match,
        runner: (state, node, type) => {
          const { alt, ratio } = splitAlt(node.alt ?? '');
          state.addNode(type, { src: node.url, caption: node.title ?? '', ratio, alt });
        },
      },
      toMarkdown: {
        match: schema.toMarkdown.match,
        runner: (state, node) => {
          const { src, caption, ratio, alt } = node.attrs;
          const size = Number(ratio) !== 1 ? Number(ratio).toFixed(2) : '';
          state.openNode('paragraph');
          state.addNode('image', undefined, undefined, {
            title: caption || null,
            url: src,
            alt: alt && size ? `${alt}|${size}` : alt || size,
          });
          state.closeNode();
        },
      },
    };
  });
}

/** `description|0.50`, `0.50` or `description` → { alt, ratio }. */
export function splitAlt(text) {
  const match = /^(?:(.*)\|)?(\d*\.?\d+)$/s.exec(text);
  const ratio = match ? Number(match[2]) : NaN;
  if (match && ratio > 0 && ratio <= 1) return { alt: match[1] ?? '', ratio };
  return { alt: text, ratio: 1 };
}
