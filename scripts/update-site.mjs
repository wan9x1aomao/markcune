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
  // Hero pill reads "<b>品牌</b> v3.5.5 · macOS / …". It must stay plain text: .pill is an
  // inline-flex box with gap, so wrapping the number in a <span> would split the text into
  // extra flex items and change the spacing. Replace the digits only.
  .replace(/(class="pill"><b>[^<]*<\/b> v)\d+\.\d+\.\d+/g, `$1${version}`)
  .replace(/(data-mdpad="version">)[^<]*/g, `$1${version}`);

for (const [platform, path] of Object.entries(files)) {
  const size = `${(statSync(path).size / 1024 / 1024).toFixed(1)} MB`;
  const sha = createHash('sha256').update(readFileSync(path)).digest('hex');
  html = html
    .replace(new RegExp(`(data-mdpad="size-${platform}">)[^<]*`, 'g'), `$1${size}`)
    .replace(new RegExp(`(data-mdpad="sha-${platform}"><b>SHA-256</b> )[^<]*`, 'g'), `$1${sha}`);
}

// ---------------------------------------------------------------- changelog

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

/**
 * One version of the log. A paragraph directly under the heading is the editorial summary shown
 * on the card; when it is missing, the first bullet doubles as the one-line description.
 */
const releases = [];
for (const line of readFileSync(changelog, 'utf8').split('\n')) {
  const heading = line.match(/^##\s+(\d+\.\d+\.\d+)\s*(?:·\s*(.+))?$/);
  if (heading) {
    releases.push({ version: heading[1], date: (heading[2] ?? '').trim(), summary: '', items: [] });
    continue;
  }
  const release = releases.at(-1);
  if (!release) continue;
  if (/^-\s+/.test(line)) release.items.push(line.replace(/^-\s+/, ''));
  else if (line.trim() && !release.items.length && !release.summary) release.summary = line.trim();
}

// Bullets open with their own category word ("修复：…"); showing it twice reads badly, so the word
// becomes a coloured pill and the text loses the prefix.
const CATEGORIES = [
  { key: 'new', label: '新增', pattern: /^新增/ },
  { key: 'improve', label: '改进', pattern: /^(改进|优化)/ },
  { key: 'fix', label: '修复', pattern: /^修复/ },
  { key: 'secure', label: '加固', pattern: /^(加固|隐私|安全)/ },
];
function splitCategory(item) {
  for (const category of CATEGORIES) {
    if (!category.pattern.test(item)) continue;
    const text = item.replace(/^(新增|改进|优化|修复|加固|隐私|安全)[:：]\s*/, '').trim();
    return { category, text };
  }
  return { category: null, text: item };
}
function tagsOf(items) {
  const counts = new Map();
  for (const item of items) {
    const { category } = splitCategory(item);
    if (category) counts.set(category.key, (counts.get(category.key) ?? 0) + 1);
  }
  return CATEGORIES.filter((category) => counts.has(category.key))
    .map((category) => `<span class="lg-tag lg-${category.key}">${category.label} ${counts.get(category.key)}</span>`)
    .join('');
}
function itemsOf(items) {
  const rows = items.map((item) => {
    const { category, text } = splitCategory(item);
    const pill = category ? `<span class="lg-cat lg-${category.key}">${category.label}</span>` : '';
    return `<li>${pill}<span class="lg-text">${inline(text)}</span></li>`;
  });
  return `<ul class="lg-items">${rows.join('')}</ul>`;
}
const leadOf = (release) => release.summary || splitCategory(release.items[0] ?? '').text;

const LOG_CSS = `
#changelog .lg{--lg-line:var(--line,#e6e3dc);--lg-ink:var(--ink,#1c2230);--lg-ink2:var(--ink-2,#4a5263);--lg-ink3:var(--ink-3,#8a91a0);
  --lg-card:#fff;--lg-accent:var(--accent,#4f6bed);--lg-green:var(--green,#1f9d66);max-width:1040px}
#changelog .lg-card{background:var(--lg-card);border:1px solid var(--lg-line);border-radius:18px}
#changelog .lg-latest{padding:clamp(20px,2.2vw,30px);border-left:3px solid var(--lg-accent);box-shadow:0 14px 40px rgba(30,40,80,.07)}
#changelog .lg-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
#changelog .lg-badge{font-size:12px;font-weight:600;color:var(--lg-green);background:#e3f5ec;border-radius:999px;padding:3px 10px;letter-spacing:.02em}
#changelog .lg-version{font-size:clamp(22px,2vw,30px);font-weight:800;letter-spacing:-.02em;line-height:1}
#changelog .lg-date{color:var(--lg-ink3);font-size:13px;font-variant-numeric:tabular-nums}
#changelog .lg-summary{margin:12px 0 0;color:var(--lg-ink2);font-size:clamp(15px,1.15vw,18px);line-height:1.65;max-width:52em}
#changelog .lg-tags{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
#changelog .lg-latest .lg-tags{margin-top:14px}
#changelog .lg-tag{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px;background:rgba(0,0,0,.04);color:var(--lg-ink3)}
#changelog .lg-tag::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.9}
#changelog .lg-new{color:#4f6bed;background:rgba(79,107,237,.1)}
#changelog .lg-improve{color:#1f9d66;background:rgba(31,157,102,.1)}
#changelog .lg-fix{color:#b26a00;background:rgba(204,122,0,.12)}
#changelog .lg-secure{color:#6b4fbd;background:rgba(107,79,189,.1)}
#changelog .lg-items{list-style:none;margin:16px 0 0;padding:0;display:grid;gap:9px}
#changelog .lg-items li{display:flex;gap:10px;align-items:flex-start;font-size:14px;line-height:1.65;color:var(--lg-ink2)}
#changelog .lg-cat{flex:none;margin-top:1px;font-size:11.5px;font-weight:600;padding:2px 8px;border-radius:6px;background:rgba(0,0,0,.04);color:var(--lg-ink3)}
#changelog .lg-cat.lg-new{color:#4f6bed;background:rgba(79,107,237,.1)}
#changelog .lg-cat.lg-improve{color:#1f9d66;background:rgba(31,157,102,.1)}
#changelog .lg-cat.lg-fix{color:#b26a00;background:rgba(204,122,0,.12)}
#changelog .lg-cat.lg-secure{color:#6b4fbd;background:rgba(107,79,189,.1)}
#changelog .lg-recent{display:grid;gap:10px;margin-top:14px}
#changelog .lg-row{border:1px solid var(--lg-line);border-radius:14px;background:var(--lg-card);transition:border-color .16s ease,box-shadow .16s ease}
#changelog .lg-row:hover{border-color:#d9d4c9}
#changelog .lg-row[open]{box-shadow:0 8px 24px rgba(30,40,80,.06)}
#changelog .lg-row>summary{display:grid;grid-template-columns:112px minmax(0,1fr) auto 16px;gap:16px;align-items:center;padding:14px 18px;cursor:pointer;list-style:none}
#changelog .lg-row>summary::-webkit-details-marker{display:none}
#changelog .lg-meta{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
#changelog .lg-row .lg-version{font-size:16px}
#changelog .lg-row .lg-date{font-size:12.5px}
#changelog .lg-lead{min-width:0;color:var(--lg-ink2);font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#changelog .lg-caret{width:8px;height:8px;border-right:2px solid var(--lg-ink3);border-bottom:2px solid var(--lg-ink3);transform:rotate(-45deg);transition:transform .18s ease}
#changelog .lg-row[open] .lg-caret{transform:rotate(45deg)}
#changelog .lg-row>.lg-items{margin:0;padding:2px 18px 16px 18px}
#changelog .lg-older{margin-top:18px;padding-top:14px;border-top:1px solid var(--lg-line)}
#changelog .lg-older>summary{display:inline-flex;align-items:center;gap:10px;cursor:pointer;list-style:none;color:var(--lg-ink2);font-size:14px}
#changelog .lg-older>summary::before{content:"+";font-weight:600;color:var(--lg-ink3);font-size:17px;line-height:1;width:12px;text-align:center}
#changelog .lg-older[open]>summary::before{content:"−"}
#changelog .lg-older>summary:hover{color:var(--lg-ink)}
#changelog .lg-older>summary::-webkit-details-marker{display:none}
#changelog .lg-older>summary b{font-weight:600;color:var(--lg-ink)}
#changelog .lg-older>summary span{font-size:12.5px;color:var(--lg-ink3);background:rgba(0,0,0,.04);border-radius:999px;padding:2px 9px}
#changelog .lg-older[open]>summary{margin-bottom:12px}
#changelog .lg-older .lg-row{margin-top:10px}
@media (max-width:760px){
  #changelog .lg-row>summary{grid-template-columns:minmax(0,1fr) 16px;gap:10px}
  #changelog .lg-row .lg-tags,#changelog .lg-row .lg-meta .lg-date{display:none}
  #changelog .lg-row .lg-lead{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
}`;

function renderLog(shown) {
  if (!shown.length) return '';
  const [latest, ...rest] = shown;
  const row = (release) => `
    <details class="lg-row">
      <summary>
        <span class="lg-meta"><b class="lg-version">${escape(release.version)}</b><time class="lg-date">${escape(release.date)}</time></span>
        <span class="lg-lead">${inline(leadOf(release))}</span>
        <span class="lg-tags">${tagsOf(release.items)}</span>
        <span class="lg-caret" aria-hidden="true"></span>
      </summary>
      ${itemsOf(release.items)}
    </details>`;
  const recent = rest.slice(0, 2).map(row).join('');
  const older = rest.slice(2);
  const olderBlock = older.length
    ? `<details class="lg-older"><summary><b>更早的版本</b><span>${older.length} 个</span></summary>${older.map(row).join('')}</details>`
    : '';
  return `
    <style>${LOG_CSS}</style>
    <div class="lg">
      <article class="lg-card lg-latest">
        <div class="lg-head">
          <span class="lg-badge">最新版本</span>
          <b class="lg-version">${escape(latest.version)}</b>
          <time class="lg-date">${escape(latest.date)}</time>
        </div>
        <p class="lg-summary">${inline(leadOf(latest))}</p>
        <div class="lg-tags">${tagsOf(latest.items)}</div>
        ${itemsOf(latest.items)}
      </article>
      ${recent ? `<div class="lg-recent">${recent}</div>` : ''}
      ${olderBlock}
    </div>`;
}

const shown = releases.filter((r) => !newer(r.version, version));
html = html.replace(/(<!-- changelog:start -->)[\s\S]*?(<!-- changelog:end -->)/, `$1${renderLog(shown)}$2`);
// The previous renderer left a "展开其余 N 个版本" button outside the markers; the new block
// carries its own <details> controls, so a leftover button would duplicate them.
html = html.replace(/<button class="cl-more"[^>]*>[^<]*<\/button>\s*/g, '');

writeFileSync(file, html);
