// Unit tests for src/tidy.js (pure functions). Run: node tests/tidy.test.mjs
import assert from 'node:assert/strict';
import { applyLabels, chunkLines, ruleLabels, sameWords, splitLines, tidyByRules, validateLabels } from '../src/tidy.js';

const raw = `项目周报

一、本周进展
完成了登录页面
• 修复了三个缺陷
• 补充了单元测试

二、下周计划
1、上线灰度版本
2、整理用户反馈
结论：整体进度正常，没有阻塞。
> 注意：周五封版`;

const out = tidyByRules(raw);
console.log(out);
assert.match(out, /^# 项目周报\n/);
assert.match(out, /\n## 一、本周进展\n/);
assert.match(out, /\n- 修复了三个缺陷\n- 补充了单元测试\n/, 'bullets become a tight list');
assert.match(out, /\n1\. 上线灰度版本\n2\. 整理用户反馈\n/, 'numbering is normalised');
assert.match(out, /\n> 注意：周五封版\n$/);
assert.ok(sameWords(raw, out), 'no words changed');

// A sentence is not a title.
assert.equal(ruleLabels(['', '今天天气很好。', ''])[1], 'p');
// Existing Markdown is left alone.
assert.equal(tidyByRules('## 已有标题\n\n- 一项\n- 两项').trim(), '## 已有标题\n\n- 一项\n- 两项');

// Model labels: wrong length, unknown label, or turning text into blank are all refused.
const lines = splitLines('标题\n\n内容');
assert.deepEqual(validateLabels(['h1', 'blank', 'p'], lines), ['h1', 'blank', 'p']);
assert.equal(validateLabels(['h1', 'p'], lines), null);
assert.equal(validateLabels(['h1', 'blank', 'nope'], lines), null);
assert.equal(validateLabels(['h1', 'p', 'p'], lines), null, 'a blank line cannot become text');
assert.equal(validateLabels(['blank', 'blank', 'p'], lines), null, 'text cannot become blank');

// "cont" joins hard-wrapped lines; Chinese is joined without a space, English with one.
assert.equal(applyLabels(['这是一段很长的', '被折行的话。'], ['p', 'cont']).trim(), '这是一段很长的被折行的话。');
assert.equal(applyLabels(['hello', 'world'], ['p', 'cont']).trim(), 'hello world');

// Chunks cut at blank lines when they can.
const many = Array.from({ length: 300 }, (_, i) => (i % 50 === 49 ? '' : `行${i}`));
const chunks = chunkLines(many, 120);
assert.equal(chunks[0][0], 0);
assert.equal(chunks.at(-1)[1], 300);
assert.ok(chunks.every(([a, b], i) => b > a && (i === 0 || chunks[i - 1][1] === a)));

// A chunk never carries more than its character budget, even when every line is long.
const long = Array.from({ length: 40 }, () => '很长的段落'.repeat(200));
const byChars = chunkLines(long, 120, 6000);
assert.ok(byChars.length > 1, 'long lines are split by characters, not only by count');
assert.ok(byChars.every(([a, b]) => long.slice(a, b).join('\n').length <= 6000), 'every chunk fits the budget');
assert.equal(byChars.at(-1)[1], 40, 'the last chunk reaches the end');
console.log('tidy ok');

// The floating button: shows for untidy text, not for tidy or tiny text.
import { needsTidy } from '../src/tidy.js';
assert.equal(needsTidy(raw), true, 'untidy report shows the button');
assert.equal(needsTidy(tidyByRules(raw)), false, 'tidy text hides it');
assert.equal(needsTidy('随手记一句话'), false, 'tiny text never shows it');
assert.equal(needsTidy('标题甲\n\n• 项目一\n• 项目二'), true, 'ten characters is enough');
assert.equal(needsTidy('• 一\n• 二'), false, 'under ten characters is not');
assert.equal(needsTidy('# 标题\n\n- 一项\n- 两项\n\n正文内容一二三四五六七八九十一二三四五六七八九十'), false, 'already Markdown');
const prose = Array.from({ length: 8 }, (_, i) => `这是第${i}段没有任何结构的长句子，内容很多很多很多，一直写下去没有标点之外的任何格式。`).join('\n');
assert.equal(needsTidy(prose, false), false, 'no structure and no AI: nothing the rules can do');
assert.equal(needsTidy(prose, true), true, 'no structure but AI is available');
console.log('hint ok');

// Invariants: for any document, one tidy keeps every word, does not change anything the second time,
// and passes the same "words unchanged" guard tidyDocument checks before it writes. Written after two
// bugs the examples above missed: the guard rejected documents with section numbers ("1.1 说明"),
// and the first line's label depended on whether the file ended with a newline (so tidying twice
// turned a one-line note into a title).
const samples = [
  raw,
  '1.1 说明\n这是正文内容。',
  '2.3.4 接口约定\n请求方式为 POST。',
  '1.1 概述\n1.2 目标\n本文说明本次改造的范围。',
  '项目周报',
  '项目周报\n',
  '\nhello world',
  '   \n完成了登录页面',
  '一、本周进展\n完成了登录页面。',
  '1、上线灰度版本\n2、整理用户反馈',
  '# 已有标题\n\n- 一项\n- 两项',
  '| 字段 | 类型 |\n| --- | --- |\n| lines | array |',
  '关于本次改造的说明\n\n本次改造主要解决三个问题，第一个是打开速度，第二个是排版\n混乱，第三个是导出不全。',
  '',
  '   \n\n   ',
];
for (const doc of samples) {
  const once = tidyByRules(doc);
  assert.ok(sameWords(doc, once), `words preserved: ${JSON.stringify(doc)}`);
  assert.equal(tidyByRules(once), once, `idempotent: ${JSON.stringify(doc)}`);
  assert.equal(needsTidy(once), false, `tidy text no longer offers the button: ${JSON.stringify(doc)}`);
  const lines = splitLines(doc);
  assert.ok(validateLabels(ruleLabels(lines), lines) !== null, `own labels are valid: ${JSON.stringify(doc)}`);
}

// A section number stays in the heading text: the "1." of "1.1" is not an ordered-list marker.
assert.equal(tidyByRules('1.1 说明\n这是正文内容。'), '### 1.1 说明\n\n这是正文内容。\n');
assert.equal(tidyByRules('2.3.4 接口约定\n请求方式为 POST。'), '### 2.3.4 接口约定\n\n请求方式为 POST。\n');

// A numbered line too long to be a heading keeps its own number and is not turned into a list item
// (a heading is capped at 40 characters, so these fall through to the rules for lists).
const longNum = '1.1 这是一个明显超过四十个字的章节标题为了让长度检查失败而故意写得很长很长很长很长很长很长很长然后继续写下去';
const longDeep = '3.2.1 关于部署环境的详细说明由于内容较多此处不再展开只能简单描述一下基本情况就是这样了';
for (const line of [longNum, longDeep]) {
  const out = tidyByRules(`${line}\n正文内容。`);
  assert.ok(out.includes(line), `long numbered line kept as is: ${line.slice(0, 12)}…`);
  assert.ok(!/^1\. \d/m.test(out), 'never rewritten as an ordered list item');
  assert.ok(sameWords(`${line}\n正文内容。`, out), 'the guard passes, so the document is not refused');
}

// The first line is the document title whether or not the file ends with a newline, and blank lines
// before it do not demote it to a section.
assert.equal(tidyByRules('项目周报'), tidyByRules('项目周报\n'));
assert.match(tidyByRules('项目周报'), /^# 项目周报\n/);
assert.match(tidyByRules('\n\n项目周报\n\n正文内容。'), /^# 项目周报\n/);

// The same invariants over many random documents. Fixed seed, so any failure can be reproduced.
let seed = 20261016;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pool = [
  '项目周报', '一、本周进展', '（一）子小节', '1.1 说明', longNum, longDeep, '完成了登录页面',
  '• 修复了三个缺陷', '1、上线灰度', '> 注意：周五封版', '', '   ', '# 已有标题', '- 一项', '```',
  '| a | b |', '结论：进度正常。', 'A', 'hello world',
];
const seen = new Set();
for (let i = 0; i < 400; i++) {
  const doc = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => pool[Math.floor(rnd() * pool.length)]).join('\n');
  if (seen.has(doc)) continue;
  seen.add(doc);
  const once = tidyByRules(doc);
  assert.ok(sameWords(doc, once), `random words: ${JSON.stringify(doc)}`);
  assert.equal(tidyByRules(once), once, `random idempotent: ${JSON.stringify(doc)}`);
  assert.equal(needsTidy(once), false, `random no re-tidy: ${JSON.stringify(doc)}`);
}
console.log(`invariants ok (${samples.length} samples + ${seen.size} random)`);
