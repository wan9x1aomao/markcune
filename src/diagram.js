// Mermaid diagrams for ```mermaid code blocks. Loaded only when a document contains one.
import mermaid from 'mermaid';

let ready = false;
let counter = 0;

export async function renderMermaid(code) {
  if (!ready) {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default', securityLevel: 'strict', suppressErrorRendering: true });
    ready = true;
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
