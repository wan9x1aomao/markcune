// One-click tidy: turns plain pasted text into Markdown.
// The text is split into lines and every line gets a label (heading, list item, quote, paragraph …).
// Labels come from rules first and, when AI is configured, from a model. A model only ever returns labels,
// never text, so it cannot change, drop or invent wording: the Markdown is built from the original lines.

export const LABELS = ['h1', 'h2', 'h3', 'ul', 'ol', 'quote', 'p', 'cont', 'blank', 'keep'];

const HAS_MARKDOWN = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s?|```|~~~|\|.*\||!?\[.*\]\(|<\w)/;
const END_PUNCT = /[。！？!?；;，,：:、.…]$|[)）”"']$/;
const cjk = (s) => /[　-鿿＀-￯]/.test(s);

/** Lines of a document, trailing whitespace removed. */
export function splitLines(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));
}

// Chinese numbering: 第一章, 一、, （一）, 1.1, 1.
const RE_CHAPTER = /^第[一二三四五六七八九十百零\d]+[章部篇]\s*\S/;
const RE_CN_H2 = /^[一二三四五六七八九十]+[、．.]\s*\S/;
const RE_CN_H3 = /^[（(][一二三四五六七八九十]+[）)]\s*\S/;
const RE_NUM_H3 = /^\d+\.\d+(\.\d+)?\s*\S/;
const RE_UL = /^[•·●○▪■□◆◇\-*+]\s*\S/;
// A number is an ordered-list marker only when no digit follows it, so the "1." of a section number
// ("1.1 说明", "3.2.1 部署") is never mistaken for a list marker: a long numbered line would otherwise
// be renumbered and lose its own "1.", and the "no words changed" check would reject the document.
const RE_OL = /^(\d+[.、)）](?!\d)|[①-⑩][.、)）])\s*\S/;
const RE_QUOTE = /^[>＞]\s*\S/;

/** Label for one line using rules only. `next` helps tell a short title from a short sentence. */
export function ruleLabel(line, prev, next) {
  const t = line.trim();
  if (!t) return 'blank';
  if (HAS_MARKDOWN.test(t)) return 'keep';
  if (RE_CHAPTER.test(t)) return 'h1';
  if (RE_NUM_H3.test(t) && t.length <= 40 && !END_PUNCT.test(t)) return 'h3';
  if (RE_CN_H2.test(t) && t.length <= 40 && !END_PUNCT.test(t)) return 'h2';
  if (RE_CN_H3.test(t) && t.length <= 40 && !END_PUNCT.test(t)) return 'h3';
  if (RE_QUOTE.test(t)) return 'quote';
  if (RE_UL.test(t)) return 'ul';
  if (RE_OL.test(t)) return 'ol';
  // A short line with no ending punctuation, between blank lines (or at the top), is a title.
  // When there is no line before it, it is the document title whether or not anything follows:
  // otherwise the same text would be a title when the file ends with a newline and a paragraph when
  // it does not, and tidying twice would change the first line.
  const alone = prev === undefined || (prev.trim() === '' && next !== undefined && next.trim() !== '');
  const max = cjk(t) ? 24 : 60;
  if (alone && t.length <= max && !END_PUNCT.test(t)) return prev === undefined ? 'h1' : 'h2';
  return 'p';
}

export function ruleLabels(lines) {
  // Blank lines before the first text do not make that text a "later" title: the first text of the
  // document is the document title, whether or not blank lines come before it. Tidy drops leading
  // blank lines, so without this a second run would see the same line at the top and label it afresh.
  let seenText = false;
  return lines.map((l, i) => {
    const label = ruleLabel(l, seenText ? lines[i - 1] : undefined, lines[i + 1]);
    if (l.trim()) seenText = true;
    return label;
  });
}

const strip = {
  ul: (t) => t.replace(/^[•·●○▪■□◆◇\-*+]\s*/, ''),
  ol: (t) => t.replace(/^(\d+[.、)）](?!\d)|[①-⑩][.、)）])\s*/, ''),
  quote: (t) => t.replace(/^[>＞]\s*/, ''),
};

/** Checks that a label list from a model fits the lines. Returns the list, or null when it cannot be used. */
export function validateLabels(labels, lines) {
  if (!Array.isArray(labels) || labels.length !== lines.length) return null;
  const clean = labels.map((l) => String(l).toLowerCase().trim());
  if (!clean.every((l) => LABELS.includes(l))) return null;
  // A blank line stays blank and text never becomes blank: otherwise a line would disappear or appear.
  for (let i = 0; i < lines.length; i++) {
    const empty = lines[i].trim() === '';
    if (empty !== (clean[i] === 'blank')) return null;
  }
  return clean;
}

const join = (a, b) => (cjk(a.slice(-1)) || cjk(b[0]) ? a + b : `${a} ${b}`);

/** Builds the Markdown. Pure: only adds markers and blank lines, and joins lines marked "cont" to the line before. */
export function applyLabels(lines, labels) {
  const blocks = [];
  let ordered = 0;
  let gap = false; // a blank line came before the next block
  for (let i = 0; i < lines.length; i++) {
    const label = labels[i];
    const t = lines[i].trim();
    if (label === 'blank') {
      ordered = 0;
      gap = true;
      continue;
    }
    const prev = blocks.at(-1);
    if (label === 'cont' && prev && (prev.kind === 'p' || prev.kind === 'ul' || prev.kind === 'ol' || prev.kind === 'quote')) {
      prev.text = join(prev.text, t);
      continue;
    }
    if (label === 'ol') ordered = prev?.kind === 'ol' ? ordered + 1 : 1;
    else ordered = 0;
    const kind = label === 'cont' ? 'p' : label;
    const body = kind === 'ul' || kind === 'ol' || kind === 'quote' ? strip[kind](t) : t;
    blocks.push({ kind, text: kind === 'keep' ? lines[i] : body, n: ordered, gap });
    gap = false;
  }
  const out = [];
  blocks.forEach((b, i) => {
    const prev = blocks[i - 1];
    const tight = prev && prev.kind === b.kind && (b.kind === 'ul' || b.kind === 'ol' || b.kind === 'quote' || (b.kind === 'keep' && !b.gap));
    if (i && !tight) out.push('');
    const line = { h1: `# ${b.text}`, h2: `## ${b.text}`, h3: `### ${b.text}`, ul: `- ${b.text}`, ol: `${b.n}. ${b.text}`, quote: `> ${b.text}`, p: b.text, keep: b.text }[b.kind];
    out.push(line);
  });
  return out.join('\n') + '\n';
}

/** Rule-only tidy of a whole text. */
export function tidyByRules(text) {
  const lines = splitLines(text);
  return applyLabels(lines, ruleLabels(lines));
}

// Leading list / quote / heading markers that tidy may add or normalise. A number is an ordered-list
// marker only when no digit follows it, so the "1." inside a section number like "1.1 说明" is left
// alone: otherwise plain() would strip it from one side only and sameWords() would reject a good tidy.
const MARKER = /^\s*(#{1,6}\s+|[•·●○▪■□◆◇\-*+]\s*|>\s*|[＞]\s*|(\d+[.、)）](?!\d)|[①-⑩][.、)）])\s*)/;

/** Text without leading markers and without whitespace: used to prove a tidy changed no words. */
export function plain(text) {
  return String(text)
    .split('\n')
    .map((l) => l.replace(MARKER, ''))
    .join('')
    .replace(/\s+/g, '');
}

/** True when two texts differ only in Markdown markers, numbering style and whitespace. */
export function sameWords(before, after) {
  return plain(before) === plain(after);
}

/** Splits lines into chunks for a model: at most `size` lines and `maxChars` characters, cut at a blank line when it can.
 *  The character budget matters because a long paragraph can be a thousand characters per line: counting lines alone would
 *  hand one request more text than a service accepts. */
export function chunkLines(lines, size = 120, maxChars = 6000) {
  const chunks = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let chars = 0;
    while (end < lines.length && end - start < size) {
      const width = lines[end].length + 1;
      if (end > start && chars + width > maxChars) break;
      chars += width;
      end++;
    }
    const span = end - start;
    if (end < lines.length && span > 1) {
      for (let j = end; j > start + span / 2; j--) {
        if (lines[j - 1].trim() === '') {
          end = j;
          break;
        }
      }
    }
    chunks.push([start, end]);
    start = end;
  }
  return chunks;
}

/**
 * Whether the floating "tidy" button should show. It shows when the rules find structure that is not Markdown yet
 * (titles, lists, quotes), or, with an AI service, when a long text has no structure at all.
 */
/** Shortest text that can show the button. */
export const MIN_CHARS = 10;

export function needsTidy(text, aiAvailable = false) {
  const body = String(text ?? '');
  if (body.trim().length < MIN_CHARS) return false;
  const lines = splitLines(body);
  const labels = ruleLabels(lines);
  const fixable = labels.filter((l) => ['h1', 'h2', 'h3', 'ul', 'ol', 'quote'].includes(l)).length;
  if (fixable >= 2) return true;
  const structured = labels.filter((l) => l === 'keep').length;
  const filled = lines.filter((l) => l.trim()).length;
  return aiAvailable && body.length >= 300 && structured === 0 && filled >= 4;
}
