// Unit tests for src/notices.js (pure functions). Run: node tests/notices.test.mjs
import assert from 'node:assert/strict';
import { downloadNotice } from '../src/notices.js';

// A whole book reports how many files came with it, and says nothing extra when nothing was left out.
assert.equal(
  downloadNotice({ kind: 'book', title: 'es6tutorial', files: 287, skipped: 0 }),
  '已下载《es6tutorial》，共 287 个文件',
);

// Files this system cannot hold are named out loud: a book quietly missing chapters is worse than
// one that says which ones did not make it.
assert.equal(
  downloadNotice({ kind: 'book', title: 'es6tutorial', files: 287, skipped: 2 }),
  '已下载《es6tutorial》，共 287 个文件，另有 2 个文件因本系统无法保存而跳过',
);

// A single document has no count and never a skip note, whatever the payload claims.
assert.equal(downloadNotice({ kind: 'file', title: 'README.md', files: 1, skipped: 0 }), '已下载 README.md');
assert.equal(downloadNotice({ kind: 'file', title: 'README.md', files: 1, skipped: 2 }), '已下载 README.md');

// A payload from a build that predates the field must read as a sentence, not as "undefined".
assert.equal(downloadNotice({ kind: 'book', title: 'x', files: 3 }), '已下载《x》，共 3 个文件');

console.log('notices ok');
