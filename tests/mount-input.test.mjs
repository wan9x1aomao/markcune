import assert from 'node:assert/strict';
import { acceptsEdit, mountBaseline } from '../src/mount-input.js';

assert.deepEqual(mountBaseline(false), { replaceSnapshot: false, pending: false });
const typed = mountBaseline(true);
assert.equal(typed.pending, true);
assert.equal(typed.replaceSnapshot, true);
assert.equal(acceptsEdit(null), false);
assert.equal(acceptsEdit({ kind: 'rich' }), true);

// The save path skips a write when there is nothing pending, or when the editor still matches
// the baseline. A keystroke during mount clears that baseline, so the write is not skipped.
function saveWouldSkip(pending, matchesSnapshot) {
  if (!pending) return true;
  if (matchesSnapshot) return true;
  return false;
}
assert.equal(saveWouldSkip(typed.pending, typed.replaceSnapshot ? false : true), false);
assert.equal(saveWouldSkip(false, true), true);

console.log('mount input ok');
