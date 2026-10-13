// Export the rendered document as a self-contained HTML file.

function collectStyles() {
  let css = '';
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) css += rule.cssText + '\n';
    } catch {
      // Cross-origin sheets cannot be read; skip them.
    }
  }
  return css;
}

const escapeHtml = (text) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * `editorRoot` contains the rich editor's `.milkdown`; `embedImage(src)` returns a data: URL
 * for a local image (or null to keep the reference).
 *
 * Copying the editor's DOM as HTML is safe only because Milkdown renders raw HTML from the
 * markdown as text nodes, never as elements. Re-check this before enabling raw HTML rendering.
 */
export async function buildHtml(editorRoot, title, embedImage) {
  const source = editorRoot.querySelector('.ProseMirror');
  const clone = source.cloneNode(true);
  clone.removeAttribute('contenteditable');
  clone.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'));
  clone.querySelectorAll('.md-marker, input, button, .operation, .image-resize-handle').forEach((el) => el.remove());
  clone.querySelectorAll('.find-match').forEach((el) => el.replaceWith(...el.childNodes));

  // Code blocks: keep a rendered preview (formula, diagram) if shown, otherwise plain code.
  clone.querySelectorAll('.milkdown-code-block').forEach((block) => {
    const preview = block.querySelector('.preview');
    if (preview && preview.textContent.trim() !== '' && !preview.closest('[hidden]')) {
      const figure = document.createElement('div');
      figure.className = 'export-preview';
      figure.append(...preview.childNodes);
      block.replaceWith(figure);
      return;
    }
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = [...block.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\n');
    pre.appendChild(code);
    block.replaceWith(pre);
  });

  // Embed local images so the file works on its own.
  await Promise.all(
    [...clone.querySelectorAll('img')].map(async (img) => {
      const data = await embedImage(img.getAttribute('src'));
      if (data) img.src = data;
    }),
  );

  const extra = `
    html, body { height: auto; overflow: auto; display: block; }
    body { background: #fff; color: #1f2328; }
    .milkdown { max-width: 860px; margin: 0 auto; }
    .milkdown .ProseMirror { padding: 48px 32px; }
    pre { background: #f6f8fa; padding: 12px 16px; border-radius: 8px; overflow: auto; }
    .export-preview { text-align: center; margin: 16px 0; }`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${collectStyles()}${extra}</style>
</head>
<body>
<div class="milkdown"><div class="ProseMirror">${clone.innerHTML}</div></div>
</body>
</html>`;
}
