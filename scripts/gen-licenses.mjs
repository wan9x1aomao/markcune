// 生成第三方许可清单。
//
// 为什么要有这个脚本：安装包里装着几十个前端库和五百多个 Rust crate，MIT / Apache-2.0 都要求
// 「随副本携带版权声明与许可原文」。手写清单一定会漏，漏一次就等于没做，所以清单必须从依赖树
// 里算出来，发版前重跑一遍。
//
// 用法：node scripts/gen-licenses.mjs
// 产物：src/licenses-text.js（应用内「关于 › 开源许可」展示，随安装包分发）
//       THIRD-PARTY-NOTICES.md（仓库里可读的一份）
//
// 只读 node_modules 与 cargo 的本地缓存，不联网。

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const NM = join(ROOT, 'node_modules');

const LICENSE_FILE = /^(licen[cs]e|copying|copyright|unlicense)([.\-_].*)?$/i;

// ---------------------------------------------------------------- 收集

// 前端：从 src 里真正 import 的包出发，沿 dependencies 走一遍闭包。devDependencies 里
// 的 vite / cli 这类只在构建时跑，不进安装包，因此不算「随副本分发的部分」。
function importedPackageNames() {
  const names = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(js|mjs)$/.test(entry) || /^__lab/.test(entry)) continue;
      const source = readFileSync(path, 'utf8');
      for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const spec = match[1];
        if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
        const parts = spec.split('/');
        names.add(spec.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]);
      }
    }
  };
  walk(join(ROOT, 'src'));
  return [...names].filter((name) => existsSync(join(NM, name, 'package.json')));
}

function jsPackages() {
  const seen = new Map();
  const queue = importedPackageNames();
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    const dir = join(NM, name);
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    seen.set(name, { manifest, dir });
    for (const dep of Object.keys(manifest.dependencies ?? {})) queue.push(dep);
  }
  return [...seen.entries()]
    .map(([name, { manifest, dir }]) => ({
      name,
      version: manifest.version ?? '',
      license: typeof manifest.license === 'string' ? manifest.license : licenseFromObject(manifest.license),
      holder: holderOf(manifest),
      repository: repoOf(manifest),
      text: readLicenseText(dir),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function repoOf(manifest) {
  const repo = manifest.repository;
  const url = typeof repo === 'string' ? repo : repo?.url;
  if (!url) return '';
  return url.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '');
}

function licenseFromObject(license) {
  if (!license || typeof license !== 'object') return '未标注';
  return license.type ?? '未标注';
}

function holderOf(manifest) {
  const person = (value) => {
    if (!value) return '';
    if (typeof value === 'string') return value;
    return [value.name, value.email && `<${value.email}>`].filter(Boolean).join(' ');
  };
  const author = person(manifest.author);
  if (author) return author;
  if (Array.isArray(manifest.contributors) && manifest.contributors.length) {
    return manifest.contributors.slice(0, 3).map(person).filter(Boolean).join(', ');
  }
  return '';
}

function readLicenseText(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return '';
  }
  const candidates = entries
    .filter((entry) => LICENSE_FILE.test(entry))
    .sort((a, b) => a.length - b.length);
  for (const entry of candidates) {
    const path = join(dir, entry);
    try {
      const text = readFileSync(path, 'utf8');
      if (text.length > 200) return text;
    } catch {
      // 读不了就试下一个
    }
  }
  return '';
}

// Rust：从 cargo metadata 的解析图里走，跳过 dev-dependencies（测试工具不进二进制）。
function rustPackages() {
  let meta;
  try {
    meta = JSON.parse(
      execFileSync('cargo', ['metadata', '--format-version', '1', '--manifest-path', 'src-tauri/Cargo.toml'], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 128 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    process.stderr.write('cargo metadata 失败：先确保能离线解析 src-tauri/Cargo.toml\n');
    process.exit(1);
  }

  const byId = new Map(meta.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(meta.resolve.nodes.map((node) => [node.id, node]));
  const rootId = meta.resolve.root;
  const seen = new Set();
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const node = nodes.get(id);
    if (!node) continue;
    for (const dep of node.deps) {
      const kinds = (dep.dep_kinds ?? []).map((kind) => kind.kind);
      if (kinds.length && kinds.every((kind) => kind === 'dev')) continue;
      queue.push(dep.pkg);
    }
  }

  const registry = join(homedir(), '.cargo', 'registry', 'src');
  const sourceRoots = existsSync(registry) ? readdirSync(registry).map((entry) => join(registry, entry)) : [];

  return [...seen]
    .map((id) => byId.get(id))
    .filter((pkg) => pkg && pkg.id !== rootId)
    .map((pkg) => {
      let text = '';
      if (pkg.license_file) {
        const path = resolve(dirname(pkg.manifest_path), pkg.license_file);
        if (existsSync(path)) text = readFileSync(path, 'utf8');
      }
      if (!text) {
        for (const base of sourceRoots) {
          const dir = join(base, `${pkg.name}-${pkg.version}`);
          if (!existsSync(dir)) continue;
          text = readLicenseText(dir);
          if (text) break;
        }
      }
      return {
        name: pkg.name,
        version: pkg.version,
        license: pkg.license ?? '未标注',
        holder: (pkg.authors ?? []).slice(0, 3).join(', '),
        repository: pkg.repository ?? '',
        text,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- 归纳

// 去掉版权行后比较正文：几十个 MIT 包共用同一份正文，正文只需印一遍。
// 归一化到「字母数字」级别，是为了让换行位置、markdown 标记、弯引号不同的同一份许可并成一块；
// 同时丢掉每份正文自己的标题行（"The MIT License (MIT)"、"Apache License Version 2.0…"），
// 否则同一份 MIT 会因为标题写法不同被拆成十几份。
function bodyKey(text) {
  const body = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (/^\s*copyright\b/i.test(line)) return false;
      if (line.length < 25) return false;
      if (/licen[cs]e/i.test(line) && line.length < 80) return false;
      return true;
    })
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

function licenseName(text, declared) {
  const t = text.replace(/[‘’“”]/g, "'").replace(/\s+/g, ' ');
  if (/Apache License\s*,?\s*Version 2\.0/i.test(t)) return 'Apache License 2.0';
  if (/Mozilla Public License\s+Version\s+2\.0/i.test(t)) return 'Mozilla Public License 2.0';
  if (/SIL OPEN FONT LICENSE/i.test(t)) return 'SIL Open Font License 1.1';
  if (/Permission is hereby granted, free of charge/i.test(t)) return 'MIT License';
  if (/Permission to use, copy, modify, and\/or distribute/i.test(t)) return 'ISC License';
  if (/Redistribution and use in source and binary forms/i.test(t)) {
    return /Neither the name|may be used to endorse/i.test(t) ? 'BSD 3-Clause License' : 'BSD 2-Clause License';
  }
  if (/provided '?as[- ]?is'?/i.test(t)) return 'zlib License';
  if (/UNICODE, INC\. LICENSE AGREEMENT/i.test(t)) return 'Unicode License v3';
  if (/free and unencumbered software released into the public domain/i.test(t)) return 'Unlicense';
  if (/Boost Software License/i.test(t)) return 'Boost Software License 1.0';
  if (/Creative Commons Legal Code|CC0 1\.0 Universal/i.test(t)) return 'CC0 1.0';
  return declared && declared !== '未标注' ? declared : '许可原文见下';
}

function copyrightLines(text, fallback) {
  // 只看开头的版权区（正文里 Apache 的 "copyright notice that is included…" 也会以 copyright 打头，
  // 那不是署名）。
  const lines = text
    .split('\n')
    .slice(0, 20)
    .map((line) => line.trim())
    .filter((line) => /^copyright\b/i.test(line) && /(\(c\)|©|(19|20)\d\d)/i.test(line))
    .slice(0, 2);
  if (lines.length) return lines;
  return fallback ? [`Copyright (c) ${fallback}`] : [];
}

// 正文里不带任何一家的版权行：署名已经逐条列在上面，正文只留条款本身，
// 否则第一家的版权会看起来像是这份许可的归属。
function stripLeadingCopyright(text) {
  const lines = text.replace(/^\s+/, '').split('\n');
  const header = (line) => {
    const t = line.trim();
    if (!t) return true;
    if (/^copyright\b/i.test(t)) return true;
    if (/licen[cs]e/i.test(t) && t.length < 70) return true;
    if (/^version\s+[\d.,]+\s*$/i.test(t)) return true;
    if (/^https?:\/\/\S+$/.test(t)) return true;
    return false;
  };
  while (lines.length && header(lines[0])) lines.shift();
  return lines.join('\n');
}

function buildText(sections) {
  const bodies = [];
  const bodyIndex = new Map();
  const missingRef = { ref: '' };
  const lines = [];

  const render = (list) => {
    for (const pkg of list) {
      let key;
      let ref;
      if (!pkg.text) {
        // 没随包提供许可文件的一律归到同一段说明，不按包名各生成一份空正文。
        if (!missingRef.ref) {
          missingRef.ref = `[${bodies.length + 1}]`;
          bodies.push({ ref: missingRef.ref, name: '未随包提供许可文件', text: '' });
        }
        ref = missingRef.ref;
      } else {
        key = bodyKey(pkg.text);
        ref = bodyIndex.get(key);
        if (!ref) {
          ref = `[${bodies.length + 1}]`;
          bodyIndex.set(key, ref);
          bodies.push({ ref, name: licenseName(pkg.text, pkg.license), text: stripLeadingCopyright(pkg.text) });
        }
      }
      lines.push(`- ${pkg.name} ${pkg.version} · ${pkg.license || '未标注'} · 条款 ${ref}`);
      for (const line of copyrightLines(pkg.text, pkg.holder)) lines.push(`  ${line}`);
      if (pkg.repository) lines.push(`  源码 ${pkg.repository}`);
    }
  };

  for (const section of sections) {
    lines.push('');
    lines.push(`## ${section.title}`);
    lines.push('');
    if (section.note) {
      lines.push(section.note);
      lines.push('');
    }
    render(section.packages);
  }

  lines.push('');
  lines.push('## 许可正文');
  for (const body of bodies) {
    lines.push('');
    lines.push(`### ${body.ref} ${body.name}`);
    lines.push('');
    const text = body.text
      ? body.text.replace(/\s+$/, '')
      : '该组件未随包提供许可文件。其声明的许可标识已写在上一条，版权与完整条款以上游仓库声明为准。';
    lines.push(...text.split('\n').map((line) => (line.trim() ? `    ${line}` : '')));
  }

  return { text: lines.join('\n'), bodies: bodies.length };
}

// ---------------------------------------------------------------- 输出

const js = jsPackages();
const rust = rustPackages();
const { text, bodies } = buildText([
  {
    title: '前端依赖（JavaScript，随界面一起打包）',
    note: `共 ${js.length} 个包，来源为 src/ 中 import 的包及其 dependencies 闭包；构建工具（vite 等）不进安装包，未列入。`,
    packages: js,
  },
  {
    title: 'Rust 依赖（静态链接进可执行文件）',
    note: `共 ${rust.length} 个 crate，来源为 cargo metadata 的解析图，已排除 dev-dependencies。`,
    packages: rust,
  },
]);

const header = `MarkCune ${APP.version} 第三方软件许可
================================================

本应用包含下列开源软件。各组件著作权归其各自作者所有，按其各自许可发布。
本文件随安装包一同分发，应用内可在「设置 › 关于 › 开源许可」查看同一份内容。

MarkCune 自身的代码以 MIT 许可发布，版权 (c) 2026 wan9x1aomao。
注：本文件为机器生成，勿手工修改；发版前跑 node scripts/gen-licenses.mjs 重新生成。
`;

const footer = `

------------------------------------------------
本文件由 scripts/gen-licenses.mjs 生成，共 ${js.length + rust.length} 个组件、${bodies} 份许可正文。
`;

const full = `${header}${text}${footer}`;

writeFileSync(join(ROOT, 'THIRD-PARTY-NOTICES.md'), full);
writeFileSync(
  join(ROOT, 'src', 'licenses-text.js'),
  `// 由 scripts/gen-licenses.mjs 生成，勿手改。发版前重跑该脚本。\n// 作为独立的异步 chunk 加载，只有点开「关于 › 开源许可」时才会被读进内存。\nexport default ${JSON.stringify(full)};\n`,
);

process.stdout.write(`组件 ${js.length} 个前端包 + ${rust.length} 个 crate，许可正文 ${bodies} 份，${(full.length / 1024).toFixed(1)} KB\n`);
