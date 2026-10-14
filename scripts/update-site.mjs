// Updates the official site for a release: version labels, file names, sizes and SHA-256.
// Usage: node scripts/update-site.mjs <site dir> <version> mac=<file> windows=<file> linux=<file>
// Elements are found by data-mdpad markers in index.html (version, size-<platform>, sha-<platform>).
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [site, version, ...pairs] = process.argv.slice(2);
const files = Object.fromEntries(pairs.map((pair) => pair.split('=')));
const file = join(site, 'index.html');
let html = readFileSync(file, 'utf8');

html = html
  .replace(/MDPad-\d+\.\d+\.\d+-(macOS|windows|linux)/g, `MDPad-${version}-$1`)
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
    `<ul>${r.items.map((item) => `<li>${escape(item)}</li>`).join('')}</ul></article>`,
  )
  .join('');
html = html.replace(/(<!-- changelog:start -->)[\s\S]*?(<!-- changelog:end -->)/, `$1${rendered}$2`);

writeFileSync(file, html);
