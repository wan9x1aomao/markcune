// Unit tests for the inline-completion rules (src/ai-rules.js). Run: node tests/ai.test.mjs
//
// These are the rules that decide whether a keystroke turns into a request, so they are worth
// pinning down: a mistake here either spends the user's tokens on every character or silently
// turns the feature off. They live in their own module precisely so they can be tested without
// a browser or an editor.
import assert from 'node:assert/strict';
import { IDLE_DELAY, MAX_AFTER, MAX_BEFORE, MIN_CHARS, REJECT_COOLDOWN, oneLine, shouldAsk } from '../src/ai-rules.js';

// The one state where asking is right: the caret rests at the end of a paragraph with enough text.
const good = { enabled: true, empty: true, atEnd: true, paragraph: true, isComposing: false, cooldown: false, chars: MIN_CHARS };
assert.equal(shouldAsk(good), true, 'baseline asks');

// Each condition on its own must be enough to stay quiet. Note that `cooldown` is the reverse:
// it vetoes when it is on.
const vetoes = {
  enabled: [false, 'the user turned completion off'],
  empty: [false, 'text is selected'],
  atEnd: [false, 'the caret is in the middle of a paragraph'],
  paragraph: [false, 'the caret is in a heading, quote, code block or table cell'],
  cooldown: [true, 'the previous suggestion was just rejected'],
};
for (const [key, [value, why]] of Object.entries(vetoes)) {
  assert.equal(shouldAsk({ ...good, [key]: value }), false, `stays quiet when ${why}`);
}
assert.equal(shouldAsk({ ...good, isComposing: true }), false, 'stays quiet while an IME composition is open');
assert.equal(shouldAsk({ ...good, chars: MIN_CHARS - 1 }), false, 'stays quiet on a nearly empty paragraph');

// A missing flag is a no, not a crash: the caller reads them off the document.
assert.equal(shouldAsk({}), false, 'an empty context asks nothing');
assert.equal(shouldAsk({ ...good, enabled: undefined }), false, 'an undefined flag counts as off');

// The limits are what keeps a long document from being sent whole.
assert.equal(MAX_BEFORE, 2000);
assert.equal(MAX_AFTER, 600);
assert.ok(IDLE_DELAY >= 400, 'a pause long enough to be a pause');
assert.ok(REJECT_COOLDOWN > IDLE_DELAY, 'a rejection outlasts the idle delay');

// A completion lands inside a paragraph, so it has to be one line.
assert.equal(oneLine('接下来会展开说明。'), '接下来会展开说明。');
assert.equal(oneLine('第一行\n第二行'), '第一行 第二行', 'a newline becomes a space');
assert.equal(oneLine('第一行\n\n  第二行\r\n第三行'), '第一行 第二行 第三行', 'blank lines and CRLF collapse too');
assert.equal(oneLine('  前后都有空格  '), '前后都有空格', 'trimmed');
assert.equal(oneLine(''), '', 'empty stays empty');
assert.equal(oneLine(null), '', 'null is empty');
assert.equal(oneLine(undefined), '', 'undefined is empty');
assert.equal(oneLine('\n\n'), '', 'whitespace alone is not a suggestion');

console.log('ai-rules: all assertions passed');
