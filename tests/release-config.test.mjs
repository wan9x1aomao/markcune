// The update host is a GitHub Release. These checks lock the config, the fixed asset
// names, and the fact that a release build compiles UPDATE_ENDPOINT into the app.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FIXED,
  assertAssetNames,
  buildManifest,
  extraAssets,
  releaseAssetNames,
  renderManifest,
  stageReleaseAssets,
} from '../scripts/github-release-assets.mjs';

const root = new URL('..', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

function readConf(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const quoted = line.match(/^([A-Z0-9_]+)="(.*)"$/);
    if (quoted) {
      out[quoted[1]] = quoted[2];
      continue;
    }
    const bare = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (bare) out[bare[1]] = bare[2];
  }
  return out;
}

const GITHUB_LATEST = 'https://github.com/wan9x1aomao/markcune/releases/latest/download';
const conf = readConf(read('scripts/release.conf'));
assert.equal(conf.UPDATE_ENDPOINT, `${GITHUB_LATEST}/latest.json`);
assert.equal(conf.DOWNLOAD_BASE_URL, GITHUB_LATEST);
assert.equal(conf.SITE_DIR, '', 'SITE_DIR 默认为空，不再写入 WorkBuddy 目录');
assert.equal(conf.MANUAL_UPGRADE, '0');
assert.equal(conf.SIGNING_KEY_FILE, '$HOME/.tauri/mdpad.key');

const releaseSh = read('scripts/release.sh');
const exportAt = releaseSh.indexOf('export MDPAD_UPDATE_ENDPOINT="$UPDATE_ENDPOINT"');
const buildAt = releaseSh.indexOf('npx tauri build');
assert.ok(exportAt > 0 && buildAt > exportAt, '打包前要把 UPDATE_ENDPOINT 导出为 MDPAD_UPDATE_ENDPOINT');
assert.match(releaseSh, /github-release-assets\.mjs stage/);
assert.match(releaseSh, /release upload "v\$VERSION"/);
assert.match(releaseSh, /--clobber/);
assert.match(releaseSh, /check-assets/);
assert.match(releaseSh, /extra-assets/);
assert.match(releaseSh, /KEEP_RELEASE:-1/);
assert.match(releaseSh, /release edit v\$\{VERSION\} --draft=false/);
assert.match(releaseSh, /\/releases\/latest/);
assert.match(releaseSh, /\[\[ -n "\$SITE_DIR" \]\]/);
for (const name of Object.values(FIXED)) {
  assert.ok(releaseSh.includes(name), `release.sh 应提到固定文件名 ${name}`);
}

const buildYml = read('.github/workflows/build.yml');
const ymlExport = buildYml.indexOf('export MDPAD_UPDATE_ENDPOINT="$UPDATE_ENDPOINT"');
const ymlBuild = buildYml.indexOf('npx tauri build', ymlExport);
assert.ok(ymlExport > 0 && ymlBuild > ymlExport, 'Windows / Linux 打包也要注入同一个更新地址');
assert.match(buildYml, /source scripts\/release\.conf/);
assert.ok(read('scripts/build-kylin.sh').includes('export MDPAD_UPDATE_ENDPOINT="$UPDATE_ENDPOINT"'));

const updateRs = read('src-tauri/src/update.rs');
assert.match(updateRs, /option_env!\("MDPAD_UPDATE_ENDPOINT"\)/);
assert.match(updateRs, /\.endpoints\(vec!\[url\]\)/);
assert.match(updateRs, /302/);
const buildRs = read('src-tauri/build.rs');
assert.match(buildRs, /cargo:rerun-if-env-changed=MDPAD_UPDATE_ENDPOINT/);
assert.match(buildRs, /cargo:rustc-env=MDPAD_UPDATE_ENDPOINT=/);

const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
assert.equal(tauri.plugins.updater.requireSignedVersion, true);
assert.ok(tauri.plugins.updater.pubkey);
assert.equal(tauri.plugins.updater.endpoints, undefined, '端点只来自 UPDATE_ENDPOINT，不写进 tauri.conf.json');
assert.ok(!read('src-tauri/tauri.conf.json').includes('workbuddy'));

const siteScript = read('scripts/update-site.mjs');
for (const name of [FIXED.macDmg, FIXED.macTar, FIXED.win, FIXED.linux, FIXED.deb]) {
  assert.ok(siteScript.includes(name), `站点脚本的固定文件名应包含 ${name}`);
}

const sig = (label) => `untrusted comment: signature from tauri secret key\n${label}\n`;
const manifest = buildManifest({
  version: '9.9.9',
  notes: '修复：问题',
  base: `${GITHUB_LATEST}/`,
  pubDate: '2026-11-13T00:00:00.000Z',
  signatures: { mac: sig('mac'), win: sig('win'), linux: sig('linux') },
});
assert.equal(manifest.platforms['darwin-aarch64'].url, `${GITHUB_LATEST}/${FIXED.macTar}`);
assert.equal(manifest.platforms['windows-x86_64'].url, `${GITHUB_LATEST}/${FIXED.win}`);
assert.equal(manifest.platforms['linux-x86_64'].url, `${GITHUB_LATEST}/${FIXED.linux}`);
assert.equal(manifest.platforms['darwin-aarch64'].signature, sig('mac'));
const rendered = renderManifest(manifest);
assert.doesNotMatch(rendered, /修复/);
assert.match(rendered, /\\u4fee\\u590d/);
assert.equal(JSON.parse(rendered).notes, '修复：问题');

const expected = [
  FIXED.deb,
  `${FIXED.linux}.sig`,
  FIXED.linux,
  FIXED.macDmg,
  `${FIXED.macTar}.sig`,
  FIXED.macTar,
  `${FIXED.win}.sig`,
  FIXED.win,
  FIXED.latest,
].sort();
assert.deepEqual(releaseAssetNames(), expected);
assert.deepEqual(releaseAssetNames({ includeLatest: false }), expected.filter((name) => name !== FIXED.latest));

const dir = mkdtempSync(join(tmpdir(), 'markcune-release-'));
try {
  const out = join(dir, 'out');
  const stage = join(dir, 'stage');
  mkdirSync(out);
  mkdirSync(stage);
  const sources = {
    dmg: 'MarkCune-9.9.9-macOS-arm64.dmg',
    mac: 'MarkCune-9.9.9-macOS-arm64.tar.gz',
    win: 'MarkCune-9.9.9-windows-x64-setup.exe',
    linux: 'MarkCune-9.9.9-linux-x86_64.AppImage',
    deb: 'MarkCune-9.9.9-linux-amd64.deb',
  };
  writeFileSync(join(out, sources.dmg), 'dmg-bytes');
  writeFileSync(join(out, sources.mac), 'tar-bytes');
  writeFileSync(join(out, `${sources.mac}.sig`), sig('mac'));
  writeFileSync(join(out, sources.win), 'exe-bytes');
  writeFileSync(join(out, `${sources.win}.sig`), sig('win'));
  writeFileSync(join(out, sources.linux), 'appimage-bytes');
  writeFileSync(join(out, `${sources.linux}.sig`), sig('linux'));
  writeFileSync(join(out, sources.deb), 'deb-bytes');
  stageReleaseAssets({
    out,
    stage,
    base: GITHUB_LATEST,
    version: '9.9.9',
    notes: '说明',
    sources,
    pubDate: '2026-11-13T00:00:00.000Z',
  });
  const latest = JSON.parse(readFileSync(join(stage, FIXED.latest), 'utf8'));
  assert.equal(latest.platforms['darwin-aarch64'].signature, sig('mac'));
  assert.equal(readFileSync(join(stage, FIXED.macTar), 'utf8'), 'tar-bytes');
  assert.equal(readFileSync(join(stage, `${FIXED.macTar}.sig`), 'utf8'), sig('mac'));
  assert.equal(readFileSync(join(out, sources.mac), 'utf8'), 'tar-bytes');

  const versioned = {
    name: 'MarkCune-9.9.9-windows-x64-setup.exe',
    apiUrl: 'https://api.github.com/repos/wan9x1aomao/markcune/releases/assets/1',
  };
  const fixedAssets = releaseAssetNames().map((name, i) => ({
    name,
    apiUrl: `https://api.github.com/repos/wan9x1aomao/markcune/releases/assets/${i + 10}`,
  }));
  assert.deepEqual(extraAssets([...fixedAssets, versioned]).map((asset) => asset.name), [versioned.name]);
  assert.throws(() => assertAssetNames([...fixedAssets, versioned]), /不一致/);
  assert.doesNotThrow(() => assertAssetNames(fixedAssets));
  assert.throws(() => extraAssets([{ name: 'extra.txt' }]), /apiUrl/);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const repo = fileURLToPath(new URL('..', import.meta.url));
const names = spawnSync(process.execPath, ['scripts/github-release-assets.mjs', 'names'], {
  cwd: repo,
  encoding: 'utf8',
});
assert.equal(names.status, 0, names.stderr);
assert.deepEqual(names.stdout.trim().split('\n'), releaseAssetNames());

const bad = spawnSync(process.execPath, ['scripts/github-release-assets.mjs', 'check-assets', join(dir, 'missing.json')], {
  cwd: repo,
  encoding: 'utf8',
});
assert.notEqual(bad.status, 0);

console.log('release-config ok');
