// Dry-run checks for scripts/update-site.mjs. The published site lives outside this repo, so
// the fixtures below stand in for index.html / guide.html / compare.html.
// Run: node tests/update-site.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/update-site.mjs', import.meta.url));
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const newest = changelog.match(/^##\s+(\d+\.\d+\.\d+)/m)?.[1];
assert.ok(newest, 'CHANGELOG.md 缺少版本标题');

const BYTES = {
  mac: 1024 * 1024,
  windows: 2 * 1024 * 1024,
  linux: 1536 * 1024,
  deb: 512 * 1024,
};
const sizeOf = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const shaOf = (bytes) => createHash('sha256').update(Buffer.alloc(bytes, 1)).digest('hex');
const SIZE = Object.fromEntries(Object.entries(BYTES).map(([key, bytes]) => [key, sizeOf(bytes)]));
const SHA = Object.fromEntries(Object.entries(BYTES).map(([key, bytes]) => [key, shaOf(bytes)]));

// A "<" before the version selector must not be treated as a tag. The live pages do this.
const SCRIPT = `<script>
if (a < b) console.log('keep-lt');
const pageVersion = (document.querySelector('[data-mdpad="version"]')?.textContent || '').trim() || null;
</script>`;

function markedPages() {
  const index = `<!doctype html>
<html><body>
<p>SENTINEL-INDEX</p>
<p>官网已发布 MarkCune 1.2.3，这段正文不要改。</p>
<span class="brand-badge" data-mdpad="version">v0.1.0</span>
<span class="metric-pill" data-mdpad="size-mac-approx">约 9.9 MB</span>
<span class="metric-pill" data-mdpad="size-windows-approx">约 9.9 MB</span>
<span class="metric-pill">约 <span data-mdpad="size-deb-approx">9.9 MB</span> / <span data-mdpad="size-linux-approx">9.9 MB</span></span>
<div class="os-req">macOS 13+ · Apple 芯片 (arm64) · <span data-mdpad="size-mac-approx">约 9.9 MB</span></div>
<div class="os-req">Windows 10 / 11 · x64 · <span data-mdpad="size-windows-approx">约 9.9 MB</span></div>
<a href="downloads/MarkCune-9.9.9-macOS-arm64.dmg" class="dl-btn" data-mdpad="link-mac">mac</a>
<a data-mdpad="link-windows">win</a>
<a href="downloads/somewhere/old.deb" data-mdpad="link-linux">deb</a>
<a
  href="downloads/MarkCune-9.9.9-linux-x86_64.AppImage"
  data-mdpad="link-linux-appimage">appimage</a>
<span class="pkg-ext">.deb · <span data-mdpad="size-deb-approx">约 9.9 MB</span></span>
<span class="pkg-ext">.AppImage · <span data-mdpad="size-linux-approx">约 9.9 MB</span></span>
<code>sudo apt install ./MarkCune-1.2.3-linux-amd64.deb</code>
${SCRIPT}
</body></html>
`;
  const guide = `<!doctype html>
<html><body>
<p>SENTINEL-GUIDE</p>
<p>当前最新版本：<strong data-mdpad="version" id="latest">0.1.0</strong></p>
<p>官网已发布 MarkCune 1.2.3，指南正文不要改。</p>
<table>
<tr>
<td><a href="downloads/old.dmg" data-mdpad="link-mac">MarkCune-macOS-arm64.dmg</a></td>
<td><span data-mdpad="size-mac">9.9 MB</span></td>
<td><code data-mdpad="sha-mac">dead</code></td>
</tr>
<tr>
<td><a href="downloads/old.exe" data-mdpad="link-windows">x</a></td>
<td><span data-mdpad="size-windows">9.9 MB</span></td>
<td><code class="hash" data-mdpad="sha-windows">dead</code></td>
</tr>
<tr>
<td><a href="downloads/old.deb" data-mdpad="link-linux">x</a></td>
<td><span data-mdpad="size-deb">9.9 MB</span></td>
<td><code data-mdpad="sha-deb" title="hash">dead</code></td>
</tr>
<tr>
<td><a href="downloads/old.AppImage" data-mdpad="link-linux-appimage">x</a></td>
<td><span data-mdpad="size-linux">9.9 MB</span></td>
<td><code data-mdpad="sha-linux">dead</code></td>
</tr>
</table>
<pre><code>MarkCune-4.0.0-windows-x64-setup.exe</code></pre>
<!-- changelog:start -->OLDLOG<!-- changelog:end -->
<button class="cl-more">展开其余 3 个版本</button>
${SCRIPT}
</body></html>
`;
  const compare = `<!doctype html>
<html><body>
<p>SENTINEL-COMPARE</p>
<script>const pageVersion = (document.querySelector('[data-mdpad="version"]')?.textContent || '').trim() || null;</script>
<p>约 9.9 MB</p>
</body></html>
`;
  return { index, guide, compare };
}

function unmarkedPages() {
  const index = `<!doctype html>
<html><body>
<span class="brand-badge" data-mdpad="version">v4.0.1</span>
<span class="metric-pill">约 6.5 MB</span>
<a href="downloads/MarkCune-macOS-arm64.dmg" data-mdpad="link-mac">mac</a>
<a href="downloads/MarkCune-windows-x64-setup.exe" data-mdpad="link-windows">win</a>
<a href="downloads/MarkCune-linux-amd64.deb" data-mdpad="link-linux">deb</a>
<a href="downloads/MarkCune-linux-x86_64.AppImage" data-mdpad="link-linux-appimage">appimage</a>
</body></html>
`;
  const guide = `<!doctype html>
<html><body>
<p>当前最新版本：<strong data-mdpad="version">4.0.1</strong></p>
<a href="downloads/MarkCune-macOS-arm64.dmg" data-mdpad="link-mac">mac</a>
<a href="downloads/MarkCune-windows-x64-setup.exe" data-mdpad="link-windows">win</a>
<a href="downloads/MarkCune-linux-amd64.deb" data-mdpad="link-linux">deb</a>
<a href="downloads/MarkCune-linux-x86_64.AppImage" data-mdpad="link-linux-appimage">appimage</a>
<span data-mdpad="size-mac">6.5 MB</span>
<span data-mdpad="size-windows">5.5 MB</span>
<span data-mdpad="size-linux">81.5 MB</span>
<span data-mdpad="size-deb">6.8 MB</span>
<td><code>deadbeef</code></td>
</body></html>
`;
  return { index, guide };
}

function writeBins(dir) {
  const bins = {};
  for (const [platform, bytes] of Object.entries(BYTES)) {
    const path = join(dir, platform);
    writeFileSync(path, Buffer.alloc(bytes, 1));
    bins[platform] = path;
  }
  return bins;
}

function writeSite(dir, pages) {
  mkdirSync(dir, { recursive: true });
  for (const [name, html] of Object.entries(pages)) writeFileSync(join(dir, `${name}.html`), html);
}

function run(site, version, bins, env = {}) {
  return spawnSync(process.execPath, [
    script,
    site,
    version,
    `mac=${bins.mac}`,
    `windows=${bins.windows}`,
    `linux=${bins.linux}`,
    `deb=${bins.deb}`,
  ], { encoding: 'utf8', env: { ...process.env, ...env } });
}

function listedMissing(stderr, file) {
  const line = stderr.split('\n').find((item) => item.includes(`以下标记在 ${file} 中找不到：`));
  assert.ok(line, `没有列出 ${file} 的缺失标记：\n${stderr}`);
  return line.split('找不到：')[1].split(',').map((item) => item.trim());
}

const root = mkdtempSync(join(tmpdir(), 'update-site-'));
try {
  const bins = writeBins(root);

  const markedDir = join(root, 'marked');
  const marked = markedPages();
  writeSite(markedDir, marked);
  const first = run(markedDir, newest, bins);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, '');
  assert.equal(first.stderr, '');

  const index = readFileSync(join(markedDir, 'index.html'), 'utf8');
  const guide = readFileSync(join(markedDir, 'guide.html'), 'utf8');
  const compare = readFileSync(join(markedDir, 'compare.html'), 'utf8');
  assert.equal(compare, marked.compare);

  assert.match(index, new RegExp(`data-mdpad="version">v${newest}<`));
  assert.match(guide, new RegExp(`data-mdpad="version" id="latest">${newest}<`));
  assert.doesNotMatch(guide, new RegExp(`data-mdpad="version"[^>]*>v${newest}`));
  assert.match(index, /SENTINEL-INDEX/);
  assert.match(guide, /SENTINEL-GUIDE/);
  assert.match(index, /官网已发布 MarkCune 1\.2\.3，这段正文不要改。/);
  assert.match(guide, /官网已发布 MarkCune 1\.2\.3，指南正文不要改。/);
  assert.match(index, /if \(a < b\) console\.log\('keep-lt'\);/);
  assert.match(guide, /querySelector\('\[data-mdpad="version"\]'\)/);

  assert.match(index, new RegExp(`data-mdpad="size-mac-approx">约 ${SIZE.mac}<`));
  assert.match(index, new RegExp(`data-mdpad="size-windows-approx">约 ${SIZE.windows}<`));
  assert.match(
    index,
    new RegExp(`约 <span data-mdpad="size-deb-approx">${SIZE.deb}</span> / <span data-mdpad="size-linux-approx">${SIZE.linux}</span>`),
  );
  assert.match(index, new RegExp(`macOS 13\\+ · Apple 芯片 \\(arm64\\) · <span data-mdpad="size-mac-approx">约 ${SIZE.mac}</span>`));
  assert.match(index, new RegExp(`\\.deb · <span data-mdpad="size-deb-approx">约 ${SIZE.deb}</span>`));
  assert.match(index, new RegExp(`\\.AppImage · <span data-mdpad="size-linux-approx">约 ${SIZE.linux}</span>`));

  assert.match(guide, new RegExp(`data-mdpad="size-mac">${SIZE.mac}</span>`));
  assert.match(guide, new RegExp(`data-mdpad="size-windows">${SIZE.windows}</span>`));
  assert.match(guide, new RegExp(`data-mdpad="size-deb">${SIZE.deb}</span>`));
  assert.match(guide, new RegExp(`data-mdpad="size-linux">${SIZE.linux}</span>`));
  assert.doesNotMatch(guide, /data-mdpad="size-[a-z]+">约 /);

  assert.match(guide, new RegExp(`<code data-mdpad="sha-mac">${SHA.mac}</code>`));
  assert.match(guide, new RegExp(`<code class="hash" data-mdpad="sha-windows">${SHA.windows}</code>`));
  assert.match(guide, new RegExp(`<code data-mdpad="sha-deb" title="hash">${SHA.deb}</code>`));
  assert.match(guide, new RegExp(`<code data-mdpad="sha-linux">${SHA.linux}</code>`));
  assert.doesNotMatch(guide, /<b>SHA-256<\/b>/);
  assert.doesNotMatch(index, /<b>SHA-256<\/b>/);

  assert.match(index, /href="downloads\/MarkCune-macOS-arm64\.dmg"/);
  assert.match(index, /<a href="downloads\/MarkCune-windows-x64-setup\.exe" data-mdpad="link-windows">/);
  assert.match(index, /href="downloads\/MarkCune-linux-amd64\.deb"/);
  assert.match(index, /href="downloads\/MarkCune-linux-x86_64\.AppImage"/);
  assert.match(guide, /href="downloads\/MarkCune-linux-x86_64\.AppImage"/);
  assert.match(index, /sudo apt install \.\/MarkCune-linux-amd64\.deb/);
  assert.doesNotMatch(index, /MarkCune-\d+\.\d+\.\d+-/);
  assert.match(guide, /<pre><code>MarkCune-windows-x64-setup\.exe<\/code><\/pre>/);
  assert.doesNotMatch(guide, /MarkCune-\d+\.\d+\.\d+-/);

  assert.match(guide, new RegExp(`class="lg-version">${newest}<`));
  assert.match(guide, /<!-- changelog:start -->/);
  assert.match(guide, /<!-- changelog:end -->/);
  assert.doesNotMatch(guide, /OLDLOG/);
  assert.doesNotMatch(guide, /cl-more/);
  assert.doesNotMatch(index, /<!-- changelog:start -->/);

  // Windows git checkouts rewrite CHANGELOG.md as CRLF. The rendered block must match the LF run.
  const crlfLog = join(root, 'CHANGELOG.crlf.md');
  writeFileSync(crlfLog, changelog.replace(/\r?\n/g, '\r\n'));
  assert.ok(readFileSync(crlfLog, 'utf8').includes('\r\n'));
  const crlfDir = join(root, 'crlf');
  writeSite(crlfDir, markedPages());
  const crlfRun = run(crlfDir, newest, bins, { UPDATE_SITE_CHANGELOG: crlfLog });
  assert.equal(crlfRun.status, 0, crlfRun.stderr);
  assert.equal(crlfRun.stderr, '');
  const crlfGuide = readFileSync(join(crlfDir, 'guide.html'), 'utf8');
  const block = (html) => html.match(/<!-- changelog:start -->([\s\S]*?)<!-- changelog:end -->/)[1];
  assert.equal(block(crlfGuide), block(guide));
  assert.doesNotMatch(crlfGuide, /\r/);
  assert.match(crlfGuide, new RegExp(`class="lg-version">${newest}<`));

  const again = run(markedDir, newest, bins);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stderr, '');
  assert.equal(readFileSync(join(markedDir, 'index.html'), 'utf8'), index);
  assert.equal(readFileSync(join(markedDir, 'guide.html'), 'utf8'), guide);
  assert.equal(readFileSync(join(markedDir, 'compare.html'), 'utf8'), compare);

  const unmarkedDir = join(root, 'unmarked');
  const unmarked = unmarkedPages();
  writeSite(unmarkedDir, unmarked);
  const failed = run(unmarkedDir, newest, bins);
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, '');
  assert.deepEqual(listedMissing(failed.stderr, 'index.html'), [
    'size-mac-approx',
    'size-windows-approx',
    'size-linux-approx',
    'size-deb-approx',
  ]);
  assert.deepEqual(listedMissing(failed.stderr, 'guide.html'), [
    'sha-mac',
    'sha-windows',
    'sha-linux',
    'sha-deb',
    'changelog:start',
    'changelog:end',
  ]);
  assert.match(failed.stderr, /页面结构可能已改动，请先核对标记再发版。/);
  assert.equal(readFileSync(join(unmarkedDir, 'index.html'), 'utf8'), unmarked.index);
  assert.equal(readFileSync(join(unmarkedDir, 'guide.html'), 'utf8'), unmarked.guide);

  const partialDir = join(root, 'partial');
  mkdirSync(partialDir);
  writeFileSync(join(partialDir, 'index.html'), marked.index);
  const missingGuide = run(partialDir, newest, bins);
  assert.equal(missingGuide.status, 1);
  assert.equal(missingGuide.stderr, 'update-site: 找不到页面 guide.html\n');
  assert.equal(readFileSync(join(partialDir, 'index.html'), 'utf8'), marked.index);

  const warnDir = join(root, 'warn');
  writeSite(warnDir, markedPages());
  const warned = run(warnDir, '0.0.1', bins);
  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stderr, new RegExp(`CHANGELOG 中有比 0\\.0\\.1 更新的条目，已跳过：.*${newest}`));
  const warnedGuide = readFileSync(join(warnDir, 'guide.html'), 'utf8');
  const warnedIndex = readFileSync(join(warnDir, 'index.html'), 'utf8');
  assert.match(warnedGuide, /<!-- changelog:start --><!-- changelog:end -->/);
  assert.doesNotMatch(warnedGuide, /class="lg-version">/);
  assert.match(warnedIndex, /data-mdpad="version">v0\.0\.1</);
  assert.match(warnedGuide, /data-mdpad="version" id="latest">0\.0\.1</);
  assert.doesNotMatch(warnedGuide, /data-mdpad="version"[^>]*>v0\.0\.1/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`update-site ok（版本 ${newest}，约字按元素原文保留）`);
