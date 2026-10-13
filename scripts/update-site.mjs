// Updates the official site for a release: version labels, file names, sizes and SHA-256.
// Usage: node scripts/update-site.mjs <site dir> <version> mac=<file> windows=<file> linux=<file>
// Elements are found by data-mdpad markers in index.html (version, size-<platform>, sha-<platform>).
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
writeFileSync(file, html);
