import assert from 'node:assert/strict';
import { createPreviewCache } from '../src/preview-sync.js';

const cache = createPreviewCache();
const seen = [];
assert.equal(cache.apply('同一篇', (markdown) => seen.push(markdown)), true);
assert.equal(cache.apply('同一篇', () => seen.push('skipped')), false);
cache.reset();
assert.equal(cache.apply('同一篇', (markdown) => seen.push(markdown)), true);
assert.deepEqual(seen, ['同一篇', '同一篇']);

console.log('preview sync ok');
