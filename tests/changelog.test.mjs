// Guards the shape of CHANGELOG.md, which the site renders verbatim: a release that lists 16
// bullets reads as noise, and `**bold**` shows up as literal asterisks (the renderer only knows
// inline code). Run: node tests/changelog.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const text = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');

// At most five bullets per release: the site shows every one of them, and past five nobody reads.
const releases = [];
for (const line of text.split('\n')) {
  const heading = line.match(/^##\s+(\d+\.\d+\.\d+)\s*·\s*(\d{4}-\d{2}-\d{2})\s*$/);
  if (heading) releases.push({ version: heading[1], date: heading[2], items: [] });
  else if (/^-\s+/.test(line)) {
    assert.ok(releases.length, `有不属于任何版本的条目：${line}`);
    releases.at(-1).items.push(line.replace(/^-\s+/, ''));
  }
}
assert.ok(releases.length >= 3, `更新日志里只有 ${releases.length} 个版本`);
for (const release of releases) {
  assert.ok(release.items.length >= 1, `${release.version} 一条都没写`);
  assert.ok(
    release.items.length <= 5,
    `${release.version} 有 ${release.items.length} 条，上限是 5 条 —— 合并同类项再删细节`,
  );
}

// Newest first, so the page and the file tell the same story.
const numbers = releases.map((r) => r.version.split('.').map(Number));
for (let i = 1; i < numbers.length; i++) {
  const [a, b] = [numbers[i - 1], numbers[i]];
  const older = a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
  assert.ok(older, `${releases[i].version} 排在了 ${releases[i - 1].version} 后面，应保持从新到旧`);
}

// The site's renderer escapes HTML and turns single backticks into <code>; anything else shows up
// as typed, so markdown-only syntax has to stay out.
for (const release of releases) {
  for (const item of release.items) {
    assert.ok(!item.includes('**'), `${release.version} 里有 markdown 加粗，站点会原样显示星号：${item}`);
    assert.ok(!item.includes('```'), `${release.version} 里有三反引号，会打乱页面的日志区：${item}`);
  }
}

console.log(`changelog ok（${releases.length} 个版本，最多 ${Math.max(...releases.map((r) => r.items.length))} 条）`);
