// "导出为图片": renders the document with the same code as the HTML export, lays it out off-screen
// to learn its size, then rasterizes it through an SVG foreignObject onto a canvas. Everything
// stays on this machine. Loaded on demand, like export.js and docx.js.
import { documentCss, imageRules, katexCss, renderDocument } from './export.js';
import { LIMITS, TARGET_SCALE, planImage } from './image-plan.js';

export const PAGE_WIDTH = 760;
const CONTENT_WIDTH = PAGE_WIDTH - 80; // documentCss pads the page by 40px on each side
const REMOTE_TIMEOUT = 8000;
const XHTML = 'http://www.w3.org/1999/xhtml';
const HOST_ATTRIBUTE = 'data-export-image-host';
const BLOCKS = new Set(['image', 'image-block', 'hr', 'table', 'math_inline', 'code_block']);

export const EMPTY_MESSAGE = '文档是空的，没有可导出的内容';

/** True when there is nothing to put in a picture: no text, and no image, rule, table, formula or code. */
export function isBlankDoc(doc) {
  if (doc.textContent.trim()) return false;
  let found = false;
  doc.descendants((node) => {
    if (BLOCKS.has(node.type.name)) found = true;
    return !found;
  });
  return !found;
}

const frame = () =>
  new Promise((resolve) => {
    requestAnimationFrame(resolve);
    setTimeout(resolve, 100); // a hidden window never fires animation frames
  });

function loadImage(src, { cross = false, timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (cross) img.crossOrigin = 'anonymous';
    const timer = timeout && setTimeout(() => reject(new Error('timeout')), timeout);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error('load'));
    };
    img.src = src;
  });
}

/** Re-encodes a decoded picture no wider than `maxWidth`; null when it is already small enough. */
function shrink(img, maxWidth, type) {
  if (!img.naturalWidth || img.naturalWidth <= maxWidth) return null;
  const canvas = document.createElement('canvas');
  canvas.width = maxWidth;
  canvas.height = Math.max(1, Math.round((img.naturalHeight * maxWidth) / img.naturalWidth));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const url = type === 'image/jpeg' ? canvas.toDataURL('image/jpeg', 0.92) : canvas.toDataURL('image/png');
  canvas.width = 0;
  return url;
}

/**
 * Turns whatever the app resolved an image to into a data: URL that cannot taint the canvas, or
 * null when it cannot be embedded (the caller then draws a placeholder).
 */
async function embeddable(url) {
  const maxWidth = CONTENT_WIDTH * TARGET_SCALE;
  if (/^data:image\//i.test(url)) {
    const img = await loadImage(url);
    if (/^data:image\/svg/i.test(url)) return url;
    return shrink(img, maxWidth, /^data:image\/jpe?g/i.test(url) ? 'image/jpeg' : 'image/png') ?? url;
  }
  if (/^https?:\/\//i.test(url)) {
    // The page's CSP lets <img> load https: but not fetch() it, so read it through a canvas. A server
    // without CORS headers taints the canvas and ends up as a placeholder.
    const img = await loadImage(url, { cross: true, timeout: REMOTE_TIMEOUT });
    const type = /\.jpe?g(?:[?#]|$)/i.test(url) ? 'image/jpeg' : 'image/png';
    const small = shrink(img, maxWidth, type);
    if (small) return small;
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || 1;
    canvas.height = img.naturalHeight || 1;
    canvas.getContext('2d').drawImage(img, 0, 0);
    const data = canvas.toDataURL(type, 0.92);
    canvas.width = 0;
    return data;
  }
  return null;
}

function placeholder(src, alt) {
  const name = alt || decodeURIComponentSafe(src.split(/[?#]/)[0].split('/').pop() || src);
  const box = document.createElement('div');
  box.className = 'image-missing';
  box.textContent = `图片无法导出：${name}`;
  return box;
}

function decodeURIComponentSafe(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Shrinks formulas and diagrams that are wider than the page so they show whole (not below 60%). */
function fitWide(article) {
  for (const box of article.querySelectorAll('.math-block, figure.diagram')) {
    const available = box.clientWidth;
    if (!available || box.scrollWidth <= available + 1) continue;
    const ratio = Math.max(0.6, available / box.scrollWidth);
    if (box.classList.contains('math-block')) box.style.fontSize = `${(ratio * 100).toFixed(1)}%`;
    else {
      const svg = box.querySelector('svg');
      if (svg) svg.style.width = `${Math.floor(svg.getBoundingClientRect().width * ratio)}px`;
    }
  }
}

/** Lays the article out in a hidden shadow tree: its height and where each top-level block sits. */
async function measure(article, css, serialize) {
  const host = document.createElement('div');
  host.setAttribute(HOST_ATTRIBUTE, '');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = `position:fixed;left:-100000px;top:0;width:${PAGE_WIDTH}px;visibility:hidden;pointer-events:none;contain:layout style paint;`;
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `:host{all:initial}\n${css}`;
  shadow.append(style, article);
  document.body.appendChild(host);
  try {
    await document.fonts.ready;
    await Promise.all([...article.querySelectorAll('img')].map((img) => img.decode?.().catch(() => {})));
    fitWide(article);
    const box = article.getBoundingClientRect();
    const blocks = [...article.children].map((child) => {
      const rect = child.getBoundingClientRect();
      return { top: rect.top - box.top, bottom: rect.bottom - box.top };
    });
    return { height: Math.ceil(box.height), blocks, markup: serialize(article) };
  } finally {
    host.remove();
  }
}

/** Reads one pixel back from the far corner: a canvas the engine cannot really allocate reads empty. */
function canvasWorks(width, height) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;
    ctx.fillStyle = '#000';
    ctx.fillRect(width - 1, height - 1, 1, 1);
    const ok = ctx.getImageData(width - 1, height - 1, 1, 1).data[3] === 255;
    canvas.width = 0;
    return ok;
  } catch {
    return false;
  }
}

const escapeXml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
// eslint-disable-next-line no-control-regex
const stripControls = (text) => text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');

/**
 * One segment as an SVG image at 1× (CSS px). The 2× comes from drawing it onto a larger canvas, and
 * the segment offset is a negative margin, not a viewBox: WebKit (macOS, Linux) paints positioned
 * content inside a foreignObject (KaTeX, code blocks, task checkboxes) without the SVG's own
 * scale/translate, so any transform inside the SVG puts those pieces in the wrong place.
 */
function svgSource(css, markup, width, scale, part) {
  const outHeight = Math.ceil(part.height * scale);
  const outWidth = Math.round(width * scale);
  const height = outHeight / scale;
  const inner = `<div xmlns="${XHTML}" style="margin-top:-${part.y}px"><style>${escapeXml(css)}</style>${markup}</div>`;
  return {
    outWidth,
    outHeight,
    url:
      'data:image/svg+xml;charset=utf-8,' +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
          `<foreignObject x="0" y="0" width="${width}" height="${height}">${inner}</foreignObject></svg>`,
      ),
  };
}

async function rasterize(source, passes, marks) {
  let canvas;
  for (let pass = 0; pass < passes; pass++) {
    const img = await loadImage(source.url);
    await img.decode?.().catch(() => {});
    await frame();
    await frame();
    canvas = document.createElement('canvas');
    canvas.width = source.outWidth;
    canvas.height = source.outHeight;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    // A block taller than one image is cut through; a faint dashed line marks where it continues.
    ctx.strokeStyle = '#c5c9d2';
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = 1;
    for (const y of marks) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(canvas.width, y + 0.5);
      ctx.stroke();
    }
  }
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const width = canvas.width;
  const height = canvas.height;
  canvas.width = 0;
  if (!blob) throw new Error(CANVAS_MESSAGE);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
}

const CANVAS_MESSAGE = '图片过大或内存不足，请改用“导出为 PDF”';
const TAINT_MESSAGE = '有图片无法嵌入，请检查文档中的网络图片';

/**
 * Renders `doc` (a ProseMirror node) to PNG data.
 * options: image(src) → Promise<url>, diagram(code) → Promise<svg> (as for renderDocument),
 * limits (see image-plan.js LIMITS; tests lower them instead of allocating huge canvases).
 * Resolves { parts: [{ bytes, width, height }], scale, reduced, failed, tooLong, html, layout }.
 */
export async function buildImage(doc, { image, diagram, limits = {} } = {}) {
  if (isBlankDoc(doc)) throw new Error(EMPTY_MESSAGE);

  let failed = 0;
  const { element, math } = await renderDocument(doc, {
    diagram,
    image: async (src) => {
      try {
        const url = await embeddable(await image(src));
        if (url) return url;
      } catch {
        // Falls through to the placeholder.
      }
      failed++;
      return null;
    },
    missingImage: placeholder,
  });

  const css = documentCss() + imageRules() + (math ? await katexCss() : '');
  const serialize = (node) => stripControls(new XMLSerializer().serializeToString(node));
  const layout = await measure(element, css, serialize);
  const html = element.outerHTML;

  let scope = { ...LIMITS, ...limits };
  let plan;
  for (let attempt = 0; ; attempt++) {
    plan = planImage({ width: PAGE_WIDTH, height: layout.height, blocks: layout.blocks }, scope);
    if (plan.tooLong) return { parts: [], scale: plan.scale, reduced: false, failed, tooLong: true, html, layout };
    const tallest = Math.max(...plan.parts.map((part) => part.height));
    if (canvasWorks(Math.round(PAGE_WIDTH * plan.scale), Math.ceil(tallest * plan.scale))) break;
    if (attempt >= 2) throw new Error(CANVAS_MESSAGE);
    scope = { ...scope, maxSide: Math.floor(scope.maxSide / 2), maxArea: Math.floor(scope.maxArea / 2) };
  }

  const parts = [];
  try {
    for (const [i, part] of plan.parts.entries()) {
      const source = svgSource(css, layout.markup, PAGE_WIDTH, plan.scale, part);
      const marks = [];
      if (part.hardCut) marks.push(Math.floor(source.outHeight) - 1);
      if (i > 0 && plan.parts[i - 1].hardCut) marks.push(0);
      // Fonts and pictures inside an SVG image can be missing from the first frame (WebKit): draw twice.
      parts.push(await rasterize(source, math || element.querySelector('img') ? 2 : 1, marks));
    }
  } catch (error) {
    if (error?.name === 'SecurityError') throw new Error(TAINT_MESSAGE);
    throw error;
  }
  return { parts, scale: plan.scale, reduced: plan.reduced, failed, tooLong: false, html, layout: { height: layout.height, blocks: layout.blocks } };
}
