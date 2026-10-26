// Word export.
//
// The editor's DOM cannot be reused (code blocks render lazily, math and diagrams render on demand),
// so this walks the ProseMirror document the way export.js does and maps each node onto the closest
// thing Word actually has: headings → Heading 1-6, lists → real Word numbering (so they renumber
// when edited), quotes → indented paragraphs with a left rule, code → monospace on a shaded
// background, images → embedded pictures. Math has no faithful mapping — Word stores equations as
// OMML, which KaTeX does not produce — so a formula leaves as its TeX source instead of as a picture
// that nobody can edit any more.
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';

const MONO = 'Consolas';
const CODE_FILL = 'F7F8FA';
const CODE_COLOR = '24292F';
const INLINE_CODE_COLOR = 'C0306A';
const LINK_COLOR = '3B6CF6';
const QUOTE_RULE = 'D6DCF5';
const HEAD_FILL = 'F6F7F9';
const MUTED = '8A909C';
/** A4 with the usual margins leaves about 560px of text column at 96dpi. */
const MAX_IMAGE_WIDTH = 560;

const MATH_LANGUAGES = new Set(['latex', 'tex', 'katex', 'math']);

const safeHref = (href) => (/^(https?:|mailto:|#)/i.test(href ?? '') ? href : null);

const HEADING = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

// ---------------------------------------------------------------- images

function dataUrlBytes(url) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url ?? '');
  if (!match) return null;
  const [, mime, base64, payload] = match;
  if (!base64) return null;
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const ext = (mime ?? '').includes('jpeg') ? 'jpg' : ((mime ?? '').split('/')[1] ?? 'png').toLowerCase();
  return { bytes, type: ['png', 'jpg', 'gif', 'bmp'].includes(ext) ? ext : 'png' };
}

/** Measures an image so Word gets a sensible size instead of a default one. */
function measure(url) {
  return new Promise((resolve) => {
    const probe = new Image();
    probe.onload = () => resolve({ width: probe.naturalWidth || 0, height: probe.naturalHeight || 0 });
    probe.onerror = () => resolve({ width: 0, height: 0 });
    probe.src = url;
  });
}

/**
 * Resolves every image once, up front: the block walk itself has to stay synchronous so a picture
 * can sit among the runs of the paragraph that holds it.
 */
async function loadImages(doc, resolve) {
  const sources = new Set();
  doc.descendants((node) => {
    if ((node.type.name === 'image' || node.type.name === 'image-block') && node.attrs.src) {
      sources.add(node.attrs.src);
    }
    return true;
  });
  const images = new Map();
  await Promise.all(
    [...sources].map(async (src) => {
      let url = null;
      try {
        url = await resolve(src);
      } catch {
        // A picture that cannot be read leaves its alt text behind; the rest of the export is fine.
      }
      const decoded = dataUrlBytes(url);
      if (!decoded) return;
      images.set(src, { ...decoded, ...(await measure(url)) });
    }),
  );
  return images;
}

function imageRun(ctx, src, alt) {
  const picture = ctx.images.get(src);
  if (!picture) return alt ? new TextRun({ text: alt, italics: true, color: MUTED }) : null;
  let { width, height } = picture;
  if (!width || !height) {
    width = MAX_IMAGE_WIDTH;
    height = Math.round(MAX_IMAGE_WIDTH * 0.6);
  }
  const scale = width > MAX_IMAGE_WIDTH ? MAX_IMAGE_WIDTH / width : 1;
  return new ImageRun({
    type: picture.type,
    data: picture.bytes,
    transformation: { width: Math.round(width * scale), height: Math.round(height * scale) },
  });
}

// ---------------------------------------------------------------- inline

function inline(node, ctx) {
  const out = [];
  node.forEach((child) => {
    if (child.isText) {
      const names = new Set(child.marks.map((mark) => mark.type.name));
      const link = child.marks.find((mark) => mark.type.name === 'link');
      const href = link ? safeHref(link.attrs.href) : null;
      const run = new TextRun({
        text: child.text,
        bold: ctx.bold || names.has('strong'),
        italics: names.has('emphasis'),
        strike: names.has('strike_through'),
        ...(names.has('inlineCode')
          ? { font: MONO, color: INLINE_CODE_COLOR, shading: { type: ShadingType.CLEAR, fill: 'F2F3F5' } }
          : {}),
        ...(href ? { color: LINK_COLOR, underline: {} } : {}),
      });
      out.push(href ? new ExternalHyperlink({ link: href, children: [run] }) : run);
    } else if (child.type.name === 'hardbreak') {
      out.push(new TextRun({ break: 1 }));
    } else if (child.type.name === 'math_inline') {
      out.push(new TextRun({ text: `$${child.attrs.value ?? child.textContent}$`, font: MONO }));
    } else if (child.type.name === 'image') {
      const run = imageRun(ctx, child.attrs.src, child.attrs.alt);
      if (run) out.push(run);
    } else {
      out.push(...inline(child, ctx));
    }
  });
  return out;
}

// ---------------------------------------------------------------- blocks

/**
 * Paragraph options the surrounding container imposes: list numbering, quote indent, continuation
 * indent. A docx paragraph cannot be given a bullet after it is built, so this has to be threaded
 * through the walk rather than applied afterwards.
 */
function frame(style) {
  const options = {};
  if (style.bullet) {
    options.bullet = { level: style.level ?? 0 };
    return options;
  }
  if (style.numbering) {
    options.numbering = { reference: style.numbering, level: style.level ?? 0, instance: style.instance };
    return options;
  }
  if (style.quote || style.indent != null) {
    options.indent = { left: style.indent ?? 360 };
    if (style.quote) options.border = { left: { style: BorderStyle.SINGLE, size: 12, color: QUOTE_RULE, space: 8 } };
  }
  return options;
}

function textBlock(node, ctx, style) {
  const children = inline(node, ctx);
  if (style.prefix) children.unshift(new TextRun({ text: style.prefix }));
  if (!children.length) children.push(new TextRun({ text: '' }));
  if (node.type.name === 'heading') {
    const level = Math.min(Math.max(node.attrs.level ?? 1, 1), 6);
    return new Paragraph({ ...frame(style), children, heading: HEADING[level - 1] });
  }
  return new Paragraph({ ...frame(style), children, ...(style.align ? { alignment: style.align } : {}) });
}

function codeBlock(node) {
  const language = (node.attrs.language ?? '').trim().toLowerCase();
  if (MATH_LANGUAGES.has(language)) {
    return new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 120, after: 120 },
      children: [new TextRun({ text: node.textContent, font: MONO, size: 20 })],
    });
  }
  const lines = node.textContent.replace(/\n$/, '').split('\n');
  const children = [];
  lines.forEach((line, index) => {
    if (index) children.push(new TextRun({ break: 1 }));
    children.push(new TextRun({ text: line || ' ', font: MONO, size: 18, color: CODE_COLOR }));
  });
  const edge = (space) => ({ style: BorderStyle.SINGLE, size: 4, color: 'E6E8EC', space });
  return new Paragraph({
    shading: { type: ShadingType.CLEAR, fill: CODE_FILL },
    spacing: { before: 160, after: 160, line: 280 },
    indent: { left: 120, right: 120 },
    border: { top: edge(6), bottom: edge(6), left: edge(6), right: edge(6) },
    children,
  });
}

function tableBlock(node, ctx) {
  let columns = 1;
  node.forEach((row) => {
    columns = Math.max(columns, row.childCount);
  });
  const rows = [];
  node.forEach((row) => {
    const header = row.type.name === 'table_header_row';
    const cells = [];
    row.forEach((cell) => {
      const content = [];
      cell.forEach((child) => {
        if (!child.isTextblock) return;
        const runs = inline(child, header ? { ...ctx, bold: true } : ctx);
        content.push(new Paragraph({ children: runs.length ? runs : [new TextRun({ text: '' })] }));
      });
      cells.push(
        new TableCell({
          children: content.length ? content : [new Paragraph({ children: [new TextRun({ text: '' })] })],
          width: { size: Math.floor(100 / columns), type: WidthType.PERCENTAGE },
          margins: { top: 80, bottom: 80, left: 140, right: 140 },
          ...(header ? { shading: { type: ShadingType.CLEAR, fill: HEAD_FILL } } : {}),
        }),
      );
    });
    rows.push(new TableRow({ children: cells, tableHeader: header, cantSplit: true }));
  });
  const line = { style: BorderStyle.SINGLE, size: 4, color: 'E3E5EA' };
  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: line, bottom: line, left: line, right: line, insideHorizontal: line, insideVertical: line },
  });
}

/** One list, at one level. `style` already carries the level and the numbering or bullet. */
function listBlocks(list, ctx, style) {
  const out = [];
  list.forEach((item) => {
    const checked = item.attrs?.checked;
    const prefix = checked === true ? '☑ ' : checked === false ? '☐ ' : '';
    let first = true;
    item.forEach((child) => {
      const name = child.type.name;
      if (name === 'bullet_list' || name === 'ordered_list') {
        const ordered = name === 'ordered_list';
        out.push(
          ...listBlocks(child, ctx, {
            level: Math.min((style.level ?? 0) + 1, 8),
            quote: style.quote,
            bullet: !ordered,
            numbering: ordered ? 'mdpad-ordered' : null,
            instance: ordered ? ctx.nextInstance++ : undefined,
          }),
        );
        return;
      }
      if (!child.isTextblock) return;
      // Only the first line of an item carries a marker; the rest are indented continuation lines.
      out.push(
        textBlock(
          child,
          ctx,
          first
            ? { ...style, ...(prefix ? { prefix } : {}) }
            : { level: style.level, quote: style.quote, indent: 720 + (style.level ?? 0) * 360 },
        ),
      );
      first = false;
    });
  });
  return out;
}

function blocks(node, ctx, style = {}) {
  const out = [];
  node.forEach((child) => {
    switch (child.type.name) {
      case 'paragraph':
      case 'heading':
        out.push(textBlock(child, ctx, style));
        return;
      case 'bullet_list':
        out.push(...listBlocks(child, ctx, { level: 0, quote: style.quote, bullet: true }));
        return;
      case 'ordered_list':
        out.push(
          ...listBlocks(child, ctx, {
            level: 0,
            quote: style.quote,
            bullet: false,
            numbering: 'mdpad-ordered',
            instance: ctx.nextInstance++,
          }),
        );
        return;
      case 'blockquote':
        out.push(...blocks(child, ctx, { ...style, quote: true }));
        return;
      case 'code_block':
        out.push(codeBlock(child));
        return;
      case 'table':
        out.push(tableBlock(child, ctx));
        // Word needs a paragraph between two tables, or they merge into one.
        out.push(new Paragraph({ children: [new TextRun({ text: '' })] }));
        return;
      case 'hr':
        out.push(
          new Paragraph({
            children: [new TextRun({ text: '' })],
            spacing: { before: 200, after: 200 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'E6E7EB', space: 1 } },
          }),
        );
        return;
      case 'image-block': {
        const run = imageRun(ctx, child.attrs.src, child.attrs.alt || child.attrs.caption);
        out.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [run ?? new TextRun({ text: '' })] }));
        if (child.attrs.caption) {
          out.push(
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { before: 60, after: 160 },
              children: [new TextRun({ text: child.attrs.caption, size: 18, color: MUTED })],
            }),
          );
        }
        return;
      }
      case 'html':
        out.push(
          new Paragraph({
            shading: { type: ShadingType.CLEAR, fill: CODE_FILL },
            children: [new TextRun({ text: child.attrs.value ?? child.textContent, font: MONO, size: 18 })],
          }),
        );
        return;
      default:
        if (child.isTextblock) out.push(textBlock(child, ctx, style));
    }
  });
  return out;
}

// ---------------------------------------------------------------- document

const ORDERED_LEVELS = [
  LevelFormat.DECIMAL,
  LevelFormat.LOWER_LETTER,
  LevelFormat.LOWER_ROMAN,
  LevelFormat.DECIMAL,
  LevelFormat.LOWER_LETTER,
  LevelFormat.LOWER_ROMAN,
  LevelFormat.DECIMAL,
  LevelFormat.LOWER_LETTER,
  LevelFormat.LOWER_ROMAN,
].map((format, level) => ({
  level,
  format,
  text: `%${level + 1}.`,
  alignment: AlignmentType.START,
  style: { paragraph: { indent: { left: 360 + level * 360, hanging: 300 } } },
}));

const NUMBERING = { config: [{ reference: 'mdpad-ordered', levels: ORDERED_LEVELS }] };

const heading = (size, before, after) => ({
  run: { size, bold: true, color: '1F2329' },
  paragraph: { spacing: { before, after } },
});

const STYLES = {
  default: {
    document: {
      run: { font: 'PingFang SC', size: 22, color: '1F2329' },
      paragraph: { spacing: { line: 320, after: 120 } },
    },
    heading1: heading(40, 320, 160),
    heading2: heading(32, 260, 140),
    heading3: heading(26, 220, 120),
    heading4: heading(23, 200, 100),
    heading5: heading(22, 180, 90),
    heading6: heading(22, 160, 80),
  },
};

/**
 * Builds the .docx. `image(src)` turns an image source into a data: URL, the same callback the HTML
 * export uses; a picture that cannot be read leaves its alt text behind.
 */
export async function buildDocx(doc, { image, title }) {
  const images = await loadImages(doc, image);
  const ctx = { images, nextInstance: 1, bold: false };
  const children = blocks(doc, ctx);
  if (!children.length) children.push(new Paragraph({ children: [new TextRun({ text: '' })] }));
  const document = new Document({
    creator: 'MarkCune',
    title: title || '未命名',
    description: '由 MarkCune 导出',
    numbering: NUMBERING,
    styles: STYLES,
    sections: [
      {
        properties: { page: { margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 } } },
        children,
      },
    ],
  });
  const blob = await Packer.toBlob(document);
  return new Uint8Array(await blob.arrayBuffer());
}
