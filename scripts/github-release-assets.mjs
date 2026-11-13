// Fixed-name assets for the GitHub Release that serves updates.
//
// Clients request DOWNLOAD_BASE_URL/<fixed name>, which is
// https://github.com/<owner>/<repo>/releases/latest/download/<fixed name>.
// That only resolves once the draft is published, and only if the latest
// published release actually contains these exact names. Versioned copies
// (MarkCune-<version>-…) are a local archive; they are not release assets.
//
// Signatures cover file bytes. Renaming a package does not change its
// minisign signature, so latest.json stores the .sig of the file we upload.
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const FIXED = {
  macDmg: 'MarkCune-macOS-arm64.dmg',
  macTar: 'MarkCune-macOS-arm64.tar.gz',
  win: 'MarkCune-windows-x64-setup.exe',
  linux: 'MarkCune-linux-x86_64.AppImage',
  deb: 'MarkCune-linux-amd64.deb',
  latest: 'latest.json',
};

// Updater packages have a .sig. The DMG and the .deb are manual installs.
const SIGNED = new Set([FIXED.macTar, FIXED.win, FIXED.linux]);

export function signatureName(fileName) {
  return SIGNED.has(fileName) ? `${fileName}.sig` : null;
}

export function releaseAssetNames({ includeLatest = true } = {}) {
  const names = [
    FIXED.macDmg,
    FIXED.macTar,
    signatureName(FIXED.macTar),
    FIXED.win,
    signatureName(FIXED.win),
    FIXED.linux,
    signatureName(FIXED.linux),
    FIXED.deb,
  ];
  if (includeLatest) names.push(FIXED.latest);
  return names.sort();
}

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// Non-ASCII is escaped so the file is plain ASCII. Viewers that guess a
// legacy encoding still show the notes correctly. JSON.parse restores them.
export function renderManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2).replace(/[\u0080-\uFFFF]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`;
}

export function buildManifest({ version, notes, base, pubDate, signatures }) {
  const root = String(base).replace(/\/$/, '');
  const entry = (signature, name) => ({ signature, url: `${root}/${name}` });
  return {
    version,
    notes: notes ?? '',
    pub_date: pubDate || new Date().toISOString(),
    platforms: {
      'darwin-aarch64': entry(signatures.mac, FIXED.macTar),
      'windows-x86_64': entry(signatures.win, FIXED.win),
      'linux-x86_64': entry(signatures.linux, FIXED.linux),
    },
  };
}

function readSignature(path) {
  const text = readFileSync(path, 'utf8');
  if (!text.startsWith('untrusted comment:')) {
    throw new Error(`签名文件不是 minisign 签名：${path}`);
  }
  return text;
}

// Copy the signed bytes to the fixed names, write latest.json from those
// signatures, and refuse to continue if the copy or the manifest drifts.
export function stageReleaseAssets({
  out,
  stage,
  base,
  version,
  notes,
  sources,
  includeLatest = true,
  pubDate,
}) {
  const macSig = readSignature(`${out}/${sources.mac}.sig`);
  const winSig = readSignature(`${out}/${sources.win}.sig`);
  const linuxSig = readSignature(`${out}/${sources.linux}.sig`);
  const manifest = buildManifest({
    version,
    notes,
    base,
    pubDate,
    signatures: { mac: macSig, win: winSig, linux: linuxSig },
  });
  const latestText = renderManifest(manifest);
  writeFileSync(`${out}/latest.json`, latestText);

  const copies = [
    [sources.dmg, FIXED.macDmg],
    [sources.mac, FIXED.macTar],
    [`${sources.mac}.sig`, signatureName(FIXED.macTar)],
    [sources.win, FIXED.win],
    [`${sources.win}.sig`, signatureName(FIXED.win)],
    [sources.linux, FIXED.linux],
    [`${sources.linux}.sig`, signatureName(FIXED.linux)],
    [sources.deb, FIXED.deb],
  ];
  for (const [from, name] of copies) {
    const source = `${out}/${from}`;
    const dest = `${stage}/${name}`;
    copyFileSync(source, dest);
    if (digest(source) !== digest(dest)) {
      throw new Error(`复制后内容变了：${name}`);
    }
  }
  if (includeLatest) writeFileSync(`${stage}/${FIXED.latest}`, latestText);

  const staged = JSON.parse(readFileSync(`${out}/latest.json`, 'utf8'));
  assertManifestMatchesFiles(staged, {
    base,
    signatures: {
      mac: readFileSync(`${stage}/${signatureName(FIXED.macTar)}`, 'utf8'),
      win: readFileSync(`${stage}/${signatureName(FIXED.win)}`, 'utf8'),
      linux: readFileSync(`${stage}/${signatureName(FIXED.linux)}`, 'utf8'),
    },
  });
  return manifest;
}

export function assertManifestMatchesFiles(manifest, { base, signatures }) {
  const root = String(base).replace(/\/$/, '');
  const rows = [
    ['darwin-aarch64', signatures.mac, FIXED.macTar],
    ['windows-x86_64', signatures.win, FIXED.win],
    ['linux-x86_64', signatures.linux, FIXED.linux],
  ];
  for (const [platform, signature, name] of rows) {
    const entry = manifest.platforms?.[platform];
    if (!entry) throw new Error(`latest.json 缺少 ${platform}`);
    if (entry.signature !== signature) {
      throw new Error(`latest.json 的 ${platform} 签名和 ${name}.sig 不一致`);
    }
    if (entry.url !== `${root}/${name}`) {
      throw new Error(`latest.json 的 ${platform} 地址不是 ${root}/${name}`);
    }
  }
}

function assetList(json) {
  const parsed = JSON.parse(readFileSync(json, 'utf8'));
  const assets = Array.isArray(parsed) ? parsed : parsed.assets;
  if (!Array.isArray(assets)) throw new Error(`无法读取 Release 资产列表：${json}`);
  return assets;
}

function includeLatestFromArgv(argv) {
  return !argv.includes('--no-latest');
}

export function extraAssets(assets, { includeLatest = true } = {}) {
  const keep = new Set(releaseAssetNames({ includeLatest }));
  return assets
    .filter((asset) => asset?.name && !keep.has(asset.name))
    .map((asset) => {
      if (!asset.apiUrl) throw new Error(`资产 ${asset.name} 没有 apiUrl，无法删除`);
      return { name: asset.name, apiUrl: asset.apiUrl };
    });
}

export function assertAssetNames(assets, { includeLatest = true } = {}) {
  const expected = releaseAssetNames({ includeLatest });
  const actual = assets.map((asset) => asset.name).sort();
  const same = expected.length === actual.length && expected.every((name, i) => name === actual[i]);
  if (!same) {
    const error = new Error('Release 上的文件和预期不一致');
    error.expected = expected;
    error.actual = actual;
    throw error;
  }
}

function die(error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (error?.expected) {
    console.error(`预期：\n${error.expected.join('\n')}`);
    console.error(`实际：\n${(error.actual || []).join('\n')}`);
  }
  process.exit(1);
}

function usage() {
  console.error('用法：node scripts/github-release-assets.mjs <names|stage|extra-assets|check-assets> [选项]');
  process.exit(2);
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) usage();

  if (command === 'names') {
    process.stdout.write(`${releaseAssetNames({ includeLatest: includeLatestFromArgv(rest) }).join('\n')}\n`);
  } else if (command === 'stage') {
    const stage = rest.find((arg) => !arg.startsWith('--'));
    if (!stage) usage();
    const { VERSION, NOTES, BASE, OUT, MAC, WIN, LINUX, DEB, DMG } = process.env;
    try {
      stageReleaseAssets({
        out: OUT,
        stage,
        base: BASE,
        version: VERSION,
        notes: NOTES ?? '',
        includeLatest: includeLatestFromArgv(rest),
        sources: { dmg: DMG, mac: MAC, win: WIN, linux: LINUX, deb: DEB },
      });
    } catch (error) {
      die(error);
    }
  } else if (command === 'extra-assets') {
    const file = rest.find((arg) => !arg.startsWith('--'));
    if (!file) usage();
    try {
      const extras = extraAssets(assetList(file), { includeLatest: includeLatestFromArgv(rest) });
      process.stdout.write(extras.map((asset) => `${asset.name}\t${asset.apiUrl}\n`).join(''));
    } catch (error) {
      die(error);
    }
  } else if (command === 'check-assets') {
    const file = rest.find((arg) => !arg.startsWith('--'));
    if (!file) usage();
    try {
      assertAssetNames(assetList(file), { includeLatest: includeLatestFromArgv(rest) });
    } catch (error) {
      die(error);
    }
  } else {
    usage();
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) main();
