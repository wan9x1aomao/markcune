// Updates the official site for a release: download links, version labels, sizes and SHA-256.
// Usage: node scripts/update-site.mjs <site dir> <version> mac=<file> windows=<file> linux=<file> deb=<file>
// Elements are found by data-mdpad markers in index.html (link-<platform>, version, size-<platform>, sha-<platform>).
// Downloads live under one fixed name per platform (overwritten each release), so links never carry a version.
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [site, version, ...pairs] = process.argv.slice(2);
const files = Object.fromEntries(pairs.map((pair) => pair.split('=')));
const file = join(site, 'index.html');
let html = readFileSync(file, 'utf8');

// Fixed download names, keyed by the data-mdpad link marker. Keep in sync with scripts/release.sh.
const LINKS = {
  'link-mac': 'MDPad-macOS-arm64.dmg',
  'link-windows': 'MDPad-windows-x64-setup.exe',
  'link-linux': 'MDPad-linux-amd64.deb',
  'link-linux-appimage': 'MDPad-linux-x86_64.AppImage',
};
const seen = new Set();
html = html.replace(/<a\b[^>]*\bdata-mdpad="(link-[a-z-]+)"[^>]*>/g, (tag, marker) => {
  const name = LINKS[marker];
  if (!name) return tag;
  seen.add(marker);
  const href = `href="downloads/${name}"`;
  return /\shref="[^"]*"/.test(tag) ? tag.replace(/(\s)href="[^"]*"/, `$1${href}`) : tag.replace(/^<a\b/, `<a ${href}`);
});
for (const marker of Object.keys(LINKS)) {
  if (!seen.has(marker)) console.warn(`update-site: 页面里没有 data-mdpad="${marker}" 的下载链接`);
}

html = html
  // Any other mention of a versioned file (unmarked buttons, install commands) becomes the fixed name too.
  .replace(/MDPad-\d+\.\d+\.\d+-(macOS-arm64\.dmg|macOS-arm64\.tar\.gz|windows-x64-setup\.exe|linux-amd64\.deb|linux-x86_64\.AppImage)/g, 'MDPad-$1')
  .replace(/<b>v\d+\.\d+\.\d+<\/b>/g, `<b>v${version}</b>`)
  .replace(/(data-mdpad="version">)[^<]*/g, `$1${version}`);

for (const [platform, path] of Object.entries(files)) {
  const size = `${(statSync(path).size / 1024 / 1024).toFixed(1)} MB`;
  const sha = createHash('sha256').update(readFileSync(path)).digest('hex');
  html = html
    .replace(new RegExp(`(data-mdpad="size-${platform}">)[^<]*`, 'g'), `$1${size}`)
    .replace(new RegExp(`(data-mdpad="sha-${platform}"><b>SHA-256</b> )[^<]*`, 'g'), `$1${sha}`);
}
// The changelog section mirrors CHANGELOG.md, up to the version being released.
const changelog = join(dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md');
const escape = (text) => text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
// Backticks in CHANGELOG.md mean inline code; without this they show up as literal ` marks.
// Runs of two or more backticks are fence notation (```html) and must stay as typed, so the
// pattern only accepts a single backtick that is not adjacent to another one.
const inline = (text) => escape(text).replace(/(^|[^`])`([^`\n]+)`(?=[^`]|$)/g, '$1<code>$2</code>');
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
const releases = [];
for (const line of readFileSync(changelog, 'utf8').split('\n')) {
  const heading = line.match(/^##\s+(\d+\.\d+\.\d+)\s*(?:·\s*(.+))?$/);
  if (heading) releases.push({ version: heading[1], date: (heading[2] ?? '').trim(), items: [] });
  else if (/^-\s+/.test(line) && releases.length) releases.at(-1).items.push(line.replace(/^-\s+/, ''));
}
const shown = releases.filter((r) => !newer(r.version, version));
const rendered = shown
  .map((r, i) =>
    `<article class="release"><div class="ver"><b>${r.version}</b>${i === 0 ? '<em>最新</em>' : ''}<span>${escape(r.date)}</span></div>` +
    `<ul>${r.items.map((item) => `<li>${inline(item)}</li>`).join('')}</ul></article>`,
  )
  .join('');
html = html.replace(/(<!-- changelog:start -->)[\s\S]*?(<!-- changelog:end -->)/, `$1${rendered}$2`);

// The changelog starts collapsed in the static HTML, so the toggle button carries a
// placeholder count that must match what the toggle script computes after load —
// otherwise the label changes on every page load and the button shifts. The script uses
// (number of .release items - 1), so mirror that here before writing.
const hiddenReleases = Math.max(shown.length - 1, 0);
html = html.replace(
  /(<button class="cl-more"[^>]*>)[^<]*(<\/button>)/,
  `$1展开其余 ${hiddenReleases} 个版本的更新记录$2`,
);

writeFileSync(file, html);
