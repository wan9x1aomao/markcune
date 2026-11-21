import { Marked } from 'marked';

const escape = (text) => String(text).replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[ch]);
const noteId = (label) => 'reader-note-' + encodeURIComponent(label.toLowerCase());
const plainInline = (tokens) => tokens.map((token) => token.tokens ? plainInline(token.tokens) : token.text ?? token.label ?? '').join('');
const slug = (text) => text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-');
const mathHtml = (tex, block) => {
  const tag = block ? 'div' : 'span';
  return '<' + tag + ' class="reader-math" data-reader-math="' + (block ? 'block' : 'inline') + '">' + escape(tex) + '</' + tag + '>';
};

const markdown = new Marked({
  gfm: true,
  renderer: {
    html: ({ text }) => escape(text),
    heading({ tokens, depth, readerId }) {
      return '<h' + depth + (readerId ? ' id="' + escape(readerId) + '"' : '') + '>' +
        this.parser.parseInline(tokens) + '</h' + depth + '>';
    },
    image({ href, text, title }) {
      return '<img loading="lazy" data-reader-src="' + escape(href) + '" alt="' + escape(text) + '"' +
        (title ? ' title="' + escape(title) + '"' : '') + '>';
    },
    code({ lang, text }) {
      const language = (lang || '').split(/\s+/)[0].toLowerCase();
      if (['math', 'latex', 'katex', 'tex'].includes(language)) return mathHtml(text, true);
      if (language === 'mermaid') return '<div class="reader-diagram" data-reader-diagram><pre>' + escape(text) + '</pre></div>';
      return '<pre><code>' + escape(text) + '</code></pre>';
    },
  },
  extensions: [
    {
      name: 'readerDefinition',
      level: 'block',
      tokenizer(src) {
        const hit = /^ {0,3}\[\^([^\]\n]+)\]:[ \t]*(.*(?:\n(?: {4}|\t)[^\n]*)*)(?:\n|$)/.exec(src);
        if (!hit) return;
        return { type: 'readerDefinition', raw: hit[0], label: hit[1], body: hit[2].replace(/\n(?: {4}|\t)/g, '\n') };
      },
      renderer: () => '',
    },
    {
      name: 'readerNote',
      level: 'inline',
      start: (src) => src.indexOf('[^'),
      tokenizer(src) {
        const hit = /^\[\^([^\]\n]+)\]/.exec(src);
        if (hit) return { type: 'readerNote', raw: hit[0], label: hit[1] };
      },
      renderer: ({ label }) => '<sup><a href="#' + escape(noteId(label)) + '">' + escape(label) + '</a></sup>',
    },
    {
      name: 'readerBlockMath',
      level: 'block',
      tokenizer(src) {
        const hit = /^ {0,3}\$\$[ \t]*\n([\s\S]*?)\n {0,3}\$\$[ \t]*(?:\n|$)/.exec(src);
        if (hit) return { type: 'readerBlockMath', raw: hit[0], text: hit[1] };
      },
      renderer: ({ text }) => mathHtml(text, true),
    },
    {
      name: 'readerInlineMath',
      level: 'inline',
      start: (src) => src.indexOf('$'),
      tokenizer(src) {
        const hit = /^\$(?![\s$])((?:\\.|[^\\$\n])+?)\$(?!\d)/.exec(src);
        if (hit) return { type: 'readerInlineMath', raw: hit[0], text: hit[1] };
      },
      renderer: ({ text }) => mathHtml(text, false),
    },
  ],
});

const PAGE_CHARS = 4800;
const TABLE_ROWS = 32;
const pages = [];

function indexDocument(source) {
  const headings = [];
  const usedIds = new Set();
  const nextSuffix = new Map();
  const definitions = new Map();
  let pending = [];
  let start = 0, offset = 0, length = 0, height = 0;

  function nextPage() {
    if (!pending.length) return;
    pages.push({ tokens: pending, offset: start, height: Math.max(32, height) });
    pending = [];
    length = 0;
    height = 0;
  }

  function add(token, position, size) {
    if (pending.length && (length >= PAGE_CHARS || pending.length >= 38)) nextPage();
    if (!pending.length) start = position;
    if (token.type === 'heading') {
      const text = plainInline(token.tokens);
      const base = slug(text) || 'heading';
      let id = base;
      let suffix = nextSuffix.get(base) ?? 2;
      while (usedIds.has(id)) id = base + '-' + suffix++;
      nextSuffix.set(base, suffix);
      usedIds.add(id);
      token.readerId = id;
      headings.push({ id, text, level: token.depth, pos: position, page: pages.length });
    }
    pending.push(token);
    length += size;
    if (token.type === 'space') return;
    const lines = (token.text ?? token.raw ?? '').match(/\n/g)?.length ?? 0;
    height += token.type === 'heading' ? 68 : 15 + 27 * Math.max(lines + 1, Math.ceil(size / 65));
  }

  for (const token of markdown.lexer(source.replace(/\r\n?/g, '\n'))) {
    const size = token.raw.length;
    if (token.type === 'readerDefinition') {
      const id = noteId(token.label);
      if (!definitions.has(id)) definitions.set(id, token);
    } else if (token.type === 'table' && token.rows.length > TABLE_ROWS) {
      nextPage();
      for (let row = 0; row < token.rows.length; row += TABLE_ROWS) {
        const rows = token.rows.slice(row, row + TABLE_ROWS);
        const raw = rows.map((cells) => cells.map((cell) => cell.text).join(' ')).join('\n');
        pages.push({ tokens: [{ ...token, rows, raw }], offset: offset + Math.floor(size * row / token.rows.length),
          height: 55 + rows.length * 34, table: true });
      }
    } else if (token.type === 'code' && token.text.length > PAGE_CHARS * 2 &&
      !['math', 'latex', 'katex', 'tex'].includes((token.lang || '').trim())) {
      nextPage();
      const lines = token.text.match(/[^\n]*\n|[^\n]+$/g) || [];
      for (let i = 0, at = offset; i < lines.length; i += 120) {
        const text = lines.slice(i, i + 120).join('');
        pages.push({ tokens: [{ ...token, text, raw: text }], offset: at, height: 42 + 24 * Math.min(120, lines.length - i) });
        at += text.length;
      }
    } else {
      add(token, offset, size);
    }
    offset += size;
  }
  nextPage();
  for (const [id, token] of definitions) {
    pages.push({ tokens: markdown.lexer(token.body), offset, height: 75, note: { id, label: token.label } });
  }
  if (!pages.length) pages.push({ tokens: [], offset: 0, height: 32 });
  return headings;
}

function firstScreen(source) {
  const tokens = markdown.lexer(source.slice(0, 6500)).slice(0, 28);
  return markdown.parser(tokens.map((token) => token.type === 'table' && token.rows.length > TABLE_ROWS
    ? { ...token, rows: token.rows.slice(0, TABLE_ROWS) } : token));
}

function countInBackground() {
  let next = 0, count = 0;
  const step = () => {
    const end = Math.min(pages.length, next + 24);
    for (; next < end; next++) for (const token of pages[next].tokens) {
      if (token.type === 'space' || token.type === 'def') continue;
      const text = ['heading', 'paragraph'].includes(token.type) ? plainInline(token.tokens) : token.text ?? token.raw;
      count += text.match(/\p{Script=Han}|[\p{L}\p{N}]+/gu)?.length ?? 0;
    }
    if (next < pages.length) setTimeout(step, 0);
    else self.postMessage({ type: 'words', count });
  };
  setTimeout(step, 0);
}

function renderPage(index) {
  const page = pages[index];
  let html = markdown.parser(page.tokens);
  if (page.table) html = '<div class="reader-table">' + html + '</div>';
  if (page.note) html = '<aside class="reader-note" id="' + escape(page.note.id) + '"><sup>' +
    escape(page.note.label) + '</sup>' + html + '</aside>';
  return html;
}

function search(query) {
  const needle = query.toLowerCase();
  return pages.map((page) => {
    if (!needle) return 0;
    const text = (page.searchText ??= page.tokens.map((token) => token.raw).join('').toLowerCase());
    let from = 0, count = 0;
    while ((from = text.indexOf(needle, from)) !== -1) {
      count++;
      from += needle.length;
    }
    return count;
  });
}

self.onmessage = ({ data }) => {
  try {
    if (data.type === 'open') {
      pages.length = 0;
      if (data.text.length > PAGE_CHARS * 2) self.postMessage({ type: 'lead', html: firstScreen(data.text) });
      const headings = indexDocument(data.text);
      self.postMessage({
        type: 'document', headings, first: renderPage(0),
        pages: pages.map(({ offset, height, note }) => ({ offset, height, note: note?.id })),
      });
      countInBackground();
    } else if (data.type === 'pages') {
      self.postMessage({ type: 'pages', id: data.id, items: data.indices.map((i) => [i, renderPage(i)]) });
    } else if (data.type === 'find') {
      self.postMessage({ type: 'find', id: data.id, counts: search(data.query) });
    }
  } catch (error) {
    self.postMessage({ type: 'error', id: data.id, message: String(error) });
  }
};
