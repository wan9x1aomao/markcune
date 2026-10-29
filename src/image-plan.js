// Pure helpers for "导出为图片": how large the picture can be, and where a tall one is cut.
// No DOM, no imports — tests/export-image.test.mjs runs this file in Node.

export const LIMITS = { maxSide: 32000, maxArea: 64_000_000, minScale: 1, maxParts: 10 };
export const TARGET_SCALE = 2;

/**
 * layout: { width, height, blocks: [{ top, bottom }] } in CSS px.
 * Returns { scale, reduced, parts: [{ y, height, hardCut? }], tooLong }.
 * One image whenever it fits at 1× or better; otherwise 1× and cut between top-level blocks.
 */
export function planImage(layout, limits = {}) {
  const { maxSide, maxArea, minScale, maxParts } = { ...LIMITS, ...limits };
  const { width, blocks = [] } = layout;
  const height = Math.max(1, Math.ceil(layout.height));

  const fit = Math.min(TARGET_SCALE, maxSide / height, Math.sqrt(maxArea / (width * height)));
  if (fit >= minScale) {
    const stepped = Math.floor(fit * 4) / 4;
    const scale = stepped >= minScale ? stepped : fit;
    return { scale, reduced: scale < TARGET_SCALE, parts: [{ y: 0, height }], tooLong: false };
  }

  const scale = minScale;
  const cap = Math.max(1, Math.floor(Math.min(maxSide / scale, maxArea / (width * scale * scale))));
  const parts = [];
  let start = 0;
  let previous = null;
  for (const block of blocks) {
    if (block.bottom - start > cap) {
      // Close the segment in the gap before this block, if it already holds something.
      if (previous && previous.bottom > start) {
        const cut = Math.round((previous.bottom + block.top) / 2);
        if (cut > start && cut <= start + cap) {
          parts.push({ y: start, height: cut - start });
          start = cut;
        }
      }
      // A block taller than a whole segment is the one case that gets cut through.
      while (block.bottom - start > cap) {
        parts.push({ y: start, height: cap, hardCut: true });
        start += cap;
      }
    }
    previous = block;
  }
  while (height - start > cap) {
    parts.push({ y: start, height: cap, hardCut: true });
    start += cap;
  }
  parts.push({ y: start, height: height - start });
  return { scale, reduced: false, parts, tooLong: parts.length > maxParts };
}

/** Width and height from a PNG's signature and IHDR; null for anything else or a truncated file. */
export function pngInfo(bytes) {
  if (!bytes || bytes.length < 33) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (signature.some((byte, i) => bytes[i] !== byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return null;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}
