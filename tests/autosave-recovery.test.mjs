import assert from 'node:assert/strict';

import { detectDestructiveDeletion, saveDelayForDeletion } from '../src/autosave-recovery.js';

const repeated = (length, char = '字') => char.repeat(length);

assert.equal(detectDestructiveDeletion(repeated(1200), repeated(650)).destructive, true);
assert.equal(detectDestructiveDeletion(repeated(1200), repeated(1000)).destructive, false);
assert.equal(detectDestructiveDeletion(repeated(900), '').destructive, true);
assert.equal(detectDestructiveDeletion(repeated(120), '').destructive, true);
assert.equal(detectDestructiveDeletion(repeated(200), repeated(159)).destructive, true);
assert.equal(detectDestructiveDeletion(repeated(200), repeated(161)).destructive, false);

assert.equal(saveDelayForDeletion(repeated(1200), repeated(1000), 1000, 5000), 1000);
assert.equal(saveDelayForDeletion(repeated(1200), repeated(650), 1000, 5000), 5000);

console.log('autosave recovery tests passed');
