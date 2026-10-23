// HTML and PDF export, rendered from the document itself (not the editor's DOM).
// The editor renders off-screen code blocks lazily and math/diagram previews on demand, so its
// DOM is not a complete picture of the document; this module renders every node in full.
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightCode } from '@lezer/highlight';
import katex from 'katex';
import { exportHighlighter, tokenCss } from './code-theme.js';

const SCOPE = '.mdpad-export';
const MATH_LANGUAGES = new Set(['latex', 'tex', 'katex', 'math']);

const escapeHtml = (text) =>
  String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Only plain web and mail links survive; anything else (javascript:, file:) is dropped. */
const safeHref = (href) => (/^(https?:|mailto:|#)/i.test(href ?? '') ? href : null);

function renderMath(value, displayMode) {
  try {
    return katex.renderToString(value, { displayMode, throwOnError: false, output: 'html' });
  } catch {
    return `<code>${escapeHtml(value)}</code>`;
  }
}

async function highlight(code, language) {
  const description = language && LanguageDescription.matchLanguageName(languages, language, true);
  if (!description) return { html: escapeHtml(code), label: language || '' };
  try {
    const support = await description.load();
    const tree = support.language.parser.parse(code);
    let html = '';
    highlightCode(
      code,
      tree,
      exportHighlighter,
      (text, classes) => (html += classes ? `<span class="${classes}">${escapeHtml(text)}</span>` : escapeHtml(text)),
      () => (html += '\n'),
    );
    return { html, label: description.name };
  } catch {
    return { html: escapeHtml(code), label: description.name };
  }
}

/**
 * Renders a ProseMirror document to HTML.
 * Options: image(src) → Promise<url> for the exported page; diagram(code) → Promise<svg>.
 */
export async function renderDocument(doc, { image, diagram }) {
  const state = { math: false };

  function inline(node) {
    let html = '';
    node.forEach((child) => {
      if (child.isText) {
        let text = escapeHtml(child.text);
        for (const mark of child.marks) {
          if (mark.type.name === 'inlineCode') text = `<code>${text}</code>`;
        }
        for (const mark of child.marks) {
          const name = mark.type.name;
          if (name === 'strong') text = `<strong>${text}</strong>`;
          else if (name === 'emphasis') text = `<em>${text}</em>`;
          else if (name === 'strike_through') text = `<del>${text}</del>`;
          else if (name === 'link') {
            const href = safeHref(mark.attrs.href);
            text = href ? `<a href="${escapeHtml(href)}">${text}</a>` : text;
          }
        }
        html += text;
      } else if (child.type.name === 'hardbreak') html += '<br>';
      else if (child.type.name === 'math_inline') {
        state.math = true;
        html += renderMath(child.attrs.value ?? child.textContent, false);
      } else if (child.type.name === 'image') {
        html += `<img data-src="${escapeHtml(child.attrs.src)}" alt="${escapeHtml(child.attrs.alt ?? '')}">`;
      } else html += inline(child);
    });
    return html;
  }

  async function children(node) {
    const parts = [];
    for (let i = 0; i < node.childCount; i++) parts.push(await block(node.child(i), node));
    return parts.join('\n');
  }

  async function cell(node, tag) {
    const align = node.attrs.alignment ? ` style="text-align:${node.attrs.alignment}"` : '';
    const content = [];
    node.forEach((child) => content.push(child.isTextblock ? inline(child) : ''));
    return `<${tag}${align}>${content.join('<br>')}</${tag}>`;
  }

  async function block(node, parent) {
    const name = node.type.name;
    switch (name) {
      case 'paragraph':
        return `<p>${inline(node)}</p>`;
      case 'heading': {
        const level = Math.min(Math.max(node.attrs.level ?? 1, 1), 6);
        const id = node.attrs.id ? ` id="${escapeHtml(node.attrs.id)}"` : '';
        return `<h${level}${id}>${inline(node)}</h${level}>`;
      }
      case 'blockquote':
        return `<blockquote>${await children(node)}</blockquote>`;
      case 'bullet_list':
        return `<ul${node.attrs.spread ? ' class="spread"' : ''}>${await children(node)}</ul>`;
      case 'ordered_list': {
        const start = node.attrs.order && node.attrs.order !== 1 ? ` start="${node.attrs.order}"` : '';
        return `<ol${start}${node.attrs.spread ? ' class="spread"' : ''}>${await children(node)}</ol>`;
      }
      case 'list_item': {
        if (node.attrs.checked === true || node.attrs.checked === false) {
          const done = node.attrs.checked ? ' done' : '';
          return `<li class="task${done}"><span class="box"></span><div>${await children(node)}</div></li>`;
        }
        return `<li>${await children(node)}</li>`;
      }
      case 'code_block': {
        const language = (node.attrs.language ?? '').trim();
        const code = node.textContent;
        if (language.toLowerCase() === 'mermaid' && diagram) {
          try {
            return `<figure class="diagram">${await diagram(code)}</figure>`;
          } catch {
            // Fall through to the source.
          }
        }
        if (MATH_LANGUAGES.has(language.toLowerCase())) {
          state.math = true;
          return `<div class="math-block">${renderMath(code, true)}</div>`;
        }
        const { html, label } = await highlight(code, language);
        const caption = label ? `<figcaption>${escapeHtml(label)}</figcaption>` : '';
        return `<figure class="code">${caption}<pre><code>${html}</code></pre></figure>`;
      }
      case 'hr':
        return '<hr>';
      case 'image-block': {
        const { src, alt, caption, ratio } = node.attrs;
        const width = ratio && ratio > 0 && ratio < 1 ? ` style="width:${(ratio * 100).toFixed(1)}%"` : '';
        const text = caption || '';
        return `<figure class="image"><img data-src="${escapeHtml(src)}" alt="${escapeHtml(alt || text)}"${width}>${
          text ? `<figcaption>${escapeHtml(text)}</figcaption>` : ''
        }</figure>`;
      }
      case 'table': {
        const head = [];
        const body = [];
        for (let i = 0; i < node.childCount; i++) {
          const row = node.child(i);
          const header = row.type.name === 'table_header_row';
          const cells = [];
          for (let j = 0; j < row.childCount; j++) {
            const c = row.child(j);
            cells.push(await cell(c, header || c.type.name === 'table_header' ? 'th' : 'td'));
          }
          (header ? head : body).push(`<tr>${cells.join('')}</tr>`);
        }
        return `<table>${head.length ? `<thead>${head.join('')}</thead>` : ''}<tbody>${body.join('')}</tbody></table>`;
      }
      case 'html':
        // Raw HTML is shown as text in the editor too; never render it.
        return `<p class="raw">${escapeHtml(node.attrs.value ?? node.textContent)}</p>`;
      default:
        if (node.isTextblock) return `<p>${inline(node)}</p>`;
        return node.childCount ? children(node) : '';
    }
  }

  const container = document.createElement('article');
  container.className = 'mdpad-export';
  container.innerHTML = await children(doc);

  // Resolve images last, all at once.
  await Promise.all(
    [...container.querySelectorAll('img[data-src]')].map(async (img) => {
      const src = img.getAttribute('data-src');
      img.removeAttribute('data-src');
      img.setAttribute('src', (await image(src).catch(() => null)) ?? src);
    }),
  );
  return { element: container, math: state.math };
}

/** The exported document's look: always light, independent of the app theme. */
export function documentCss(scope = SCOPE) {
  return `
${scope} {
  color-scheme: light;
  box-sizing: border-box;
  max-width: 760px;
  margin: 0 auto;
  padding: 56px 40px 80px;
  color: #1f2329;
  background: #fff;
  font: 16px/1.78 -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif;
  -webkit-font-smoothing: antialiased;
  word-wrap: break-word;
}
${scope} *, ${scope} *::before, ${scope} *::after { box-sizing: border-box; }
${scope} h1, ${scope} h2, ${scope} h3, ${scope} h4, ${scope} h5, ${scope} h6 { line-height: 1.35; letter-spacing: -0.01em; margin: 1.8em 0 0.6em; font-weight: 650; }
${scope} h1 { font-size: 2em; margin-top: 0.4em; }
${scope} h2 { font-size: 1.45em; padding-bottom: 0.3em; border-bottom: 1px solid #ececef; }
${scope} h3 { font-size: 1.2em; }
${scope} h4 { font-size: 1.05em; }
${scope} h5, ${scope} h6 { font-size: 1em; color: #5d6370; }
${scope} p { margin: 0 0 1em; }
${scope} a { color: #3b6cf6; text-decoration: none; border-bottom: 1px solid rgba(59, 108, 246, 0.3); }
${scope} strong { font-weight: 650; }
${scope} del { color: #8a909c; }
${scope} code { font-family: 'SF Mono', ui-monospace, Menlo, Consolas, 'Cascadia Mono', monospace; font-size: 0.86em; }
${scope} :not(pre) > code { padding: 0.15em 0.4em; border-radius: 6px; background: #f2f3f5; color: #c0306a; }
${scope} ul, ${scope} ol { margin: 0 0 1em; padding-left: 1.6em; }
${scope} li { margin: 0.25em 0; }
${scope} li > p, ${scope} li.task > div > p { margin: 0; }
${scope} .spread > li > p { margin: 0 0 0.6em; }
${scope} li > ul, ${scope} li > ol { margin: 0.25em 0; }
${scope} li.task { list-style: none; display: flex; gap: 0.6em; align-items: flex-start; margin-left: -1.6em; }
${scope} li.task > div { flex: 1; min-width: 0; }
${scope} li.task .box { flex: none; width: 1.05em; height: 1.05em; margin-top: 0.38em; border: 1.6px solid #b7bcc6; border-radius: 0.3em; position: relative; }
${scope} li.task.done .box { background: #3b6cf6; border-color: #3b6cf6; }
${scope} li.task.done .box::after { content: ''; position: absolute; left: 0.3em; top: 0.08em; width: 0.28em; height: 0.56em; border: solid #fff; border-width: 0 0.13em 0.13em 0; transform: rotate(45deg); }
${scope} li.task.done > div { color: #8a909c; text-decoration: line-through; }
${scope} blockquote { margin: 0 0 1em; padding: 0.1em 0 0.1em 1em; border-left: 3px solid #d6dcf5; color: #5d6370; }
${scope} blockquote > :last-child { margin-bottom: 0; }
${scope} hr { border: 0; height: 1px; background: #e6e7eb; margin: 2em 0; }
${scope} table { width: 100%; margin: 0.4em 0 1.4em; border-collapse: separate; border-spacing: 0; border: 1px solid #e3e5ea; border-radius: 10px; overflow: hidden; font-size: 0.93em; }
${scope} th, ${scope} td { padding: 0.55em 0.9em; border-bottom: 1px solid #e3e5ea; text-align: left; vertical-align: top; }
${scope} th + th, ${scope} td + td { border-left: 1px solid #eef0f3; }
${scope} tbody tr:last-child td { border-bottom: 0; }
${scope} th { background: #f6f7f9; font-weight: 600; }
${scope} figure { margin: 1.2em 0; }
${scope} figure.code { position: relative; border: 1px solid #e6e8ec; border-radius: 12px; background: #f8f9fb; overflow: hidden; }
${scope} figure.code figcaption { position: absolute; top: 0.55em; right: 0.9em; font-size: 0.72em; color: #9096a3; letter-spacing: 0.02em; }
${scope} figure.code pre { margin: 0; padding: 1em 1.2em; overflow-x: auto; font-size: 0.84em; line-height: 1.7; color: #24292f; white-space: pre; }
${scope} figure.code pre code { font-size: 1em; }
${tokenCss(`${scope} figure.code`)}
${scope} figure.image { text-align: center; }
${scope} figure.image img, ${scope} p img { max-width: 100%; height: auto; border-radius: 8px; }
${scope} figure.image figcaption { margin-top: 0.5em; font-size: 0.85em; color: #8a909c; }
${scope} figure.diagram { text-align: center; }
${scope} figure.diagram svg { max-width: 100%; height: auto; }
${scope} .math-block { margin: 1.2em 0; overflow-x: auto; text-align: center; }
${scope} .raw { white-space: pre-wrap; font-family: 'SF Mono', ui-monospace, Menlo, Consolas, monospace; font-size: 0.86em; color: #5d6370; }
`;
}

/** Print rules for the article (`prefix` scopes them): page margins, no awkward page breaks. */
const printRules = (prefix) => `
  @page { margin: 16mm 15mm; }
  ${prefix}${SCOPE} { max-width: none; padding: 0; font-size: 11pt; }
  ${prefix}${SCOPE} * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  ${prefix}${SCOPE} h1, ${prefix}${SCOPE} h2, ${prefix}${SCOPE} h3, ${prefix}${SCOPE} h4 { break-after: avoid; page-break-after: avoid; }
  /* Anything that can be taller than one page has to be allowed to split. WebKit clips the rest of
     an overflow:hidden box once it crosses a page boundary and refuses to break inside a box marked
     break-inside: avoid — long tables and code blocks were the ones coming out incomplete. */
  ${prefix}${SCOPE} figure, ${prefix}${SCOPE} table, ${prefix}${SCOPE} blockquote { break-inside: auto; page-break-inside: auto; }
  ${prefix}${SCOPE} figure.code, ${prefix}${SCOPE} figure.code pre,
  ${prefix}${SCOPE} table, ${prefix}${SCOPE} .math-block { overflow: visible; }
  ${prefix}${SCOPE} figure.code, ${prefix}${SCOPE} table { border-radius: 0; }
  /* Things that fit on one page keep their no-split rule; oversized images must at least scale. */
  ${prefix}${SCOPE} tr, ${prefix}${SCOPE} img, ${prefix}${SCOPE} blockquote > :first-child,
  ${prefix}${SCOPE} .math-block, ${prefix}${SCOPE} li.task,
  ${prefix}${SCOPE} figure.image, ${prefix}${SCOPE} figure.diagram { break-inside: avoid; page-break-inside: avoid; }
  ${prefix}${SCOPE} img, ${prefix}${SCOPE} figure.diagram svg { max-height: 23cm; }
  ${prefix}${SCOPE} figure.code pre { white-space: pre-wrap; word-break: break-all; }
  ${prefix}${SCOPE} th, ${prefix}${SCOPE} td { overflow-wrap: anywhere; }
  ${prefix}${SCOPE} thead { display: table-header-group; }
  ${prefix}${SCOPE} a { border-bottom: 0; }`;

/** In the app: only the print container is printed. */
const PRINT_CSS = `
#print-root { display: none; }
@media print {
  html, body { height: auto !important; overflow: visible !important; display: block !important; background: #fff !important; }
  body > *:not(#print-root) { display: none !important; }
  #print-root { display: block !important; position: static !important; height: auto !important; overflow: visible !important; }
${printRules('#print-root ')}
}`;

/** KaTeX's stylesheet with its woff2 fonts inlined, so exported math looks right anywhere. */
async function katexCss() {
  const rules = [];
  const fonts = [];
  for (const sheet of document.styleSheets) {
    let list;
    try {
      list = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of list) {
      if (rule instanceof CSSFontFaceRule && /KaTeX/.test(rule.style.getPropertyValue('font-family'))) {
        fonts.push({ rule, base: sheet.href || location.href });
      } else if (rule.selectorText?.includes('.katex')) {
        rules.push(rule.cssText);
      }
    }
  }
  const faces = await Promise.all(
    fonts.map(async ({ rule, base }) => {
      const src = rule.style.getPropertyValue('src');
      const woff2 = src.match(/url\(["']?([^"')]+\.woff2)["']?\)/);
      if (!woff2) return '';
      try {
        const blob = await (await fetch(new URL(woff2[1], base))).blob();
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        const style = rule.style;
        return `@font-face { font-family: ${style.getPropertyValue('font-family')}; font-style: ${style.getPropertyValue('font-style') || 'normal'}; font-weight: ${style.getPropertyValue('font-weight') || 'normal'}; src: url(${data}) format('woff2'); }`;
      } catch {
        return '';
      }
    }),
  );
  return faces.join('\n') + '\n' + rules.join('\n');
}

/** A self-contained HTML page. `options` as for renderDocument (image should return data: URLs). */
export async function buildHtml(doc, title, options) {
  const { element, math } = await renderDocument(doc, options);
  const extra = math ? await katexCss() : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
html, body { margin: 0; background: #fff; }
${documentCss()}
@media print {${printRules('')}
}
${extra}
</style>
</head>
<body>
${element.outerHTML}
</body>
</html>`;
}

/** Fills the print-only container with the rendered document; resolves once images are ready. */
export async function preparePrint(doc, options) {
  if (!document.getElementById('export-style')) {
    const style = document.createElement('style');
    style.id = 'export-style';
    style.textContent = documentCss() + PRINT_CSS;
    document.head.appendChild(style);
  }
  let root = document.getElementById('print-root');
  if (!root) {
    root = Object.assign(document.createElement('div'), { id: 'print-root' });
    document.body.appendChild(root);
  }
  const { element } = await renderDocument(doc, options);
  root.replaceChildren(element);
  await Promise.all([...root.querySelectorAll('img')].map((img) => img.decode?.().catch(() => {})));
}
