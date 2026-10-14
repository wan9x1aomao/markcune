// Mermaid diagrams for ```mermaid code blocks. Loaded only when a document contains one.
import mermaid from 'mermaid';

let current = null;
let counter = 0;

/** `theme`: 'auto' follows the system; exports pass 'light' so diagrams match the white page. */
export async function renderMermaid(code, theme = 'auto') {
  const dark = theme === 'auto' ? window.matchMedia('(prefers-color-scheme: dark)').matches : theme === 'dark';
  const wanted = dark ? 'dark' : 'default';
  if (current !== wanted) {
    mermaid.initialize({ startOnLoad: false, theme: wanted, securityLevel: 'strict', suppressErrorRendering: true });
    current = wanted;
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
