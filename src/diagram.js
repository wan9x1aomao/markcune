// Mermaid diagrams for ```mermaid code blocks. Loaded only when a document contains one.
import mermaid from 'mermaid';

let current = null;
let counter = 0;

/**
 * `theme`: 'auto' follows the app's theme; exports pass 'light' so diagrams match the white page.
 * `htmlLabels: false` draws labels as plain SVG text — pictures need that, since WebKit does not
 * reliably render a foreignObject nested in the foreignObject that carries the page.
 */
export async function renderMermaid(code, theme = 'auto', { htmlLabels = true } = {}) {
  const appDark = document.documentElement.dataset.theme === 'dark';
  const dark = theme === 'auto' ? appDark : theme === 'dark';
  const wanted = dark ? 'dark' : 'default';
  const key = `${wanted}:${htmlLabels}`;
  if (current !== key) {
    mermaid.initialize({
      startOnLoad: false,
      theme: wanted,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      ...(htmlLabels ? {} : { htmlLabels: false, flowchart: { htmlLabels: false } }),
    });
    current = key;
  }
  const id = `mdpad-diagram-${++counter}`;
  try {
    const { svg } = await mermaid.render(id, code);
    return svg;
  } finally {
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}
