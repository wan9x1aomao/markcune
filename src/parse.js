// Chunked markdown parsing.
//
// remark's parser slows down more than linearly with document size (0.8 s for 0.9 MB, 8 s for
// 3.7 MB of text), so large documents are cut into pieces of roughly CHUNK characters, each piece
// is parsed on its own, and the resulting top-level blocks are concatenated.
//
// A piece may only start where every block is certain to have ended: at an ATX heading ("# ...")
// in column 0 right after a blank line. Such a line closes any list or block quote (no lazy
// continuation after a blank line), so only fenced code, math ($$) and raw HTML blocks of the
// kinds that may contain blank lines (<pre>, <script>, <!-- -->, ...) can span it; the splitter
// tracks those. Link reference and footnote definitions apply to the whole document, so documents
// containing anything that looks like one are parsed in one piece. As a safety net, a piece whose
// last block is a code block or HTML that its text doesn't visibly close is merged with the next
// piece and parsed again.
import { ParserReady, editorStateTimerCtx, parserCtx } from '@milkdown/kit/core';
import { createTimer } from '@milkdown/kit/ctx';
import { Fragment } from '@milkdown/kit/prose/model';

const CHUNK = 64 * 1024;
const DEFINITION = /^ {0,3}\[[^\]\n]+\]:/m;
const HEADING = /^#{1,6}(?:[ \t]|$)/;
const CONTAINER = /^(?:>|[-+*](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$))/;
const FENCE_OPEN = /^(`{3,})[^`]*$|^(~{3,}).*$|^(\${2,})[^$]*$/;
const HTML_OPEN = [
  [/^<(?:script|pre|style|textarea)(?:[\s>]|$)/i, /<\/(?:script|pre|style|textarea)>/i],
  [/^<!--/, /-->/],
  [/^<\?/, /\?>/],
  [/^<![A-Za-z]/, />/],
  [/^<!\[CDATA\[/, /\]\]>/],
];

const indentOf = (line) => {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += 4 - (width % 4);
    else break;
  }
  return width;
};

/** Splits `markdown` into pieces that parse independently (see above); one piece if unsure. */
export function splitMarkdown(markdown, chunk = CHUNK) {
  if (markdown.length < chunk * 2 || DEFINITION.test(markdown)) return [markdown];
  const pieces = [];
  let start = 0;
  let fence = null; // { char, length } of an open fence at the top level
  let html = null; // end pattern of an open raw HTML block
  let container = false; // a list or block quote may be open
  let blank = true; // the previous line was blank
  for (let pos = 0; pos < markdown.length; ) {
    let next = markdown.indexOf('\n', pos);
    next = next === -1 ? markdown.length : next + 1;
    const line = markdown.slice(pos, next).replace(/\r?\n$/, '');
    const indent = indentOf(line);
    const text = line.trimStart();
    if (fence) {
      const close = indent < 4 && new RegExp(`^\\${fence.char}{${fence.length},}[ \\t]*$`).test(text);
      if (close) fence = null;
    } else if (html) {
      if (html.test(line)) html = null;
    } else if (!text) {
      blank = true;
      pos = next;
      continue;
    } else {
      const marker = indent < 4 && CONTAINER.test(text);
      if (indent === 0 && !marker && (blank || !container)) {
        // Column 0 after a blank line (or with nothing open): every container has ended.
        container = false;
        if (blank && HEADING.test(line) && pos - start >= chunk) {
          pieces.push(markdown.slice(start, pos));
          start = pos;
        }
      } else if (marker) {
        container = true;
      }
      // Openers in column 0 can't continue a container; indented ones count only with no
      // container open. (One inside a list ends with the list item, at the latest at the next
      // split point; one missed here is caught by the safety net.)
      if (indent === 0 || (indent < 4 && !container)) {
        const open = FENCE_OPEN.exec(text);
        if (open) {
          const run = open[1] ?? open[2] ?? open[3];
          fence = { char: run[0], length: run.length };
          if (indent === 0) container = false;
        } else {
          const kind = HTML_OPEN.find(([opener]) => opener.test(text));
          if (kind && !kind[1].test(text.slice(1))) html = kind[1];
          if (kind && indent === 0) container = false;
        }
      }
    }
    blank = false;
    pos = next;
  }
  pieces.push(markdown.slice(start));
  return pieces;
}

/** True unless the piece's last block is code or raw HTML that its text doesn't visibly close. */
function endsCleanly(doc, text) {
  const last = doc.lastChild;
  if (!last) return true;
  const lines = text.replace(/\s+$/, '').split('\n');
  const lastLine = lines[lines.length - 1].replace(/\r$/, '');
  if (last.type.name === 'code_block') {
    const content = last.textContent.split('\n');
    const contentEnd = content[content.length - 1];
    // A closing fence is not part of the code; an unclosed fence would contain that line.
    if (/^ {0,3}(?:`{3,}|~{3,}|\${2,})[ \t]*$/.test(lastLine)) return contentEnd !== lastLine.trim();
    // Indented code loses its indentation; an unclosed fence would keep it.
    const dedented = lastLine.replace(/^(?: {4}|\t)/, '');
    return dedented !== lastLine && contentEnd === dedented;
  }
  let html = null;
  last.descendants((node) => {
    if (node.type.name === 'html') html = node.attrs.value ?? '';
    return html === null;
  });
  if (html !== null) {
    const kind = HTML_OPEN.find(([opener]) => opener.test(html.trimStart()));
    if (kind && !kind[1].test(html.trimStart().slice(1))) return false;
  }
  return true;
}

/** Wraps a Milkdown parser (text → doc) to parse large documents in pieces. */
export function chunkedParser(parse) {
  const run = (text, chunk) => {
    const pieces = typeof text === 'string' ? splitMarkdown(text, chunk) : [];
    if (pieces.length < 2) return parse(text);
    const children = [];
    let first = null;
    // The blank lines before a split point belong to no block in the whole document, but at the
    // end of a piece they would join a code block left open by its list item; leave them out.
    const trim = (piece, last) => (last ? piece : piece.replace(/\r?\n\s*$/, ''));
    for (let i = 0; i < pieces.length; i++) {
      let piece = pieces[i];
      let doc = parse(trim(piece, i === pieces.length - 1));
      while (i + 1 < pieces.length && !endsCleanly(doc, piece)) {
        i += 1;
        piece += pieces[i];
        doc = parse(trim(piece, i === pieces.length - 1));
      }
      first ??= doc;
      doc.forEach((node) => children.push(node));
    }
    return first.type.create(first.attrs, Fragment.fromArray(children));
  };
  const chunked = (text) => run(text, CHUNK);
  // For tests: the plain parser, and parsing with another piece size.
  chunked.unchunked = parse;
  chunked.withChunkSize = run;
  return chunked;
}

/** Milkdown plugin: installs the chunked parser before the initial document is parsed. */
export const chunkedParsing = (ctx) => {
  const ChunkedParserReady = createTimer('MdpadChunkedParserReady');
  ctx.record(ChunkedParserReady);
  ctx.update(editorStateTimerCtx, (timers) => timers.concat(ChunkedParserReady));
  return async () => {
    await ctx.wait(ParserReady);
    ctx.update(parserCtx, (parse) => chunkedParser(parse));
    ctx.done(ChunkedParserReady);
    return () => ctx.clearTimer(ChunkedParserReady);
  };
};
