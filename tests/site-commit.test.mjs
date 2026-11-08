import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitFiles } from '../scripts/site-commit.mjs';

const root = mkdtempSync(join(tmpdir(), 'site-commit-'));
try {
  const page = join(root, 'index.html');
  const latest = join(root, 'latest.json');
  writeFileSync(page, 'OLD-PAGE 自定义正文');
  writeFileSync(latest, '{"version":"old"}');
  writeFileSync(join(root, 'sitemap.xml'), 'SITEMAP');
  writeFileSync(join(root, 'dirty.txt'), 'DIRTY');
  const source = join(root, 'new-latest.json');
  writeFileSync(source, '{"version":"new"}');

  commitFiles([
    { dest: page, html: 'NEW-PAGE 自定义正文' },
    { dest: latest, source },
  ]);
  assert.equal(readFileSync(page, 'utf8'), 'NEW-PAGE 自定义正文');
  assert.equal(readFileSync(latest, 'utf8'), '{"version":"new"}');
  assert.equal(readFileSync(join(root, 'sitemap.xml'), 'utf8'), 'SITEMAP');
  assert.equal(readFileSync(join(root, 'dirty.txt'), 'utf8'), 'DIRTY');

  writeFileSync(page, 'OLD-PAGE 自定义正文');
  writeFileSync(latest, '{"version":"old"}');
  mkdirSync(join(root, 'blocked'));
  assert.throws(() => commitFiles([
    { dest: page, html: 'SHOULD-ROLLBACK' },
    { dest: join(root, 'blocked'), html: 'nope' },
  ]));
  assert.equal(readFileSync(page, 'utf8'), 'OLD-PAGE 自定义正文');
  assert.equal(readFileSync(latest, 'utf8'), '{"version":"old"}');
  assert.equal(readFileSync(join(root, 'sitemap.xml'), 'utf8'), 'SITEMAP');
  assert.equal(readFileSync(join(root, 'dirty.txt'), 'utf8'), 'DIRTY');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('site commit ok');
