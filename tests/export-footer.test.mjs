// 导出署名：一句固定的话，网页 / PDF / 长图 / Word 都放在文末，中间隔一条线。
// Run: node tests/export-footer.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appendExportCredit, EXPORT_CREDIT, exportCreditHtml } from '../src/export-footer.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

assert.equal(EXPORT_CREDIT, '由MarkCune导出');

{
  const out = appendExportCredit('# 标题\n\n正文');
  assert.equal(out, `# 标题\n\n正文\n\n---\n\n${EXPORT_CREDIT}\n`);
  assert.equal(out.indexOf(EXPORT_CREDIT), out.lastIndexOf(EXPORT_CREDIT));
  assert.ok(out.indexOf('---') > out.indexOf('正文'));
}

assert.equal(appendExportCredit(''), `---\n\n${EXPORT_CREDIT}\n`);
assert.equal(appendExportCredit('正文\n\n'), `正文\n\n---\n\n${EXPORT_CREDIT}\n`);

{
  const html = exportCreditHtml();
  assert.match(html, /^<hr>\n<p class="export-credit">由MarkCune导出<\/p>$/);
  assert.ok(html.indexOf('<hr>') < html.indexOf(EXPORT_CREDIT));
}

const exportJs = read('../src/export.js');
const docx = read('../src/docx.js');
assert.match(exportJs, /exportCreditHtml\(\)/);
assert.match(exportJs, /\.export-credit/);
assert.match(docx, /EXPORT_CREDIT/);
assert.match(docx, /exportCreditParagraphs\(\)/);
assert.ok(
  docx.indexOf('children.push(...exportCreditParagraphs())') > docx.indexOf('const children = blocks(doc, ctx)'),
  '署名必须接在正文块之后',
);

console.log('export-footer ok');
