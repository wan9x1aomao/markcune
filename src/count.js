// Count readable words in a Markdown document: CJK characters count individually, while Latin
// words and numbers count as one. Markdown punctuation and structural markers are ignored.
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

export function markdownText(markdown) {
  return markdown
    .replace(/^---\r?\n[\s\S]*?\r?\n---\s*/m, '')
    .replace(/```[^\n]*\r?\n([\s\S]*?)```/g, '$1')
    .replace(/~~~[^\n]*\r?\n([\s\S]*?)~~~/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)/gm, '')
    .replace(/\[[ xX]\]\s*/g, '')
    .replace(/\\([\\`*_[\]{}()#+.!>|~-])/g, '$1')
    .replace(/[*_~`]/g, '');
}

export function countWords(text) {
  const cjk = text.match(CJK)?.length ?? 0;
  const rest = text.replace(CJK, ' ');
  return cjk + (rest.match(WORD)?.length ?? 0);
}

export function countMarkdownWords(markdown) {
  return countWords(markdownText(markdown));
}
