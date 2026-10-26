// Guards the rename's invariants: the public brand is MarkCune, the version is the same in every
// manifest, and the identifiers old installs depend on are still the old ones. Run: node tests/rebrand.test.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const pkg = JSON.parse(read('package.json'));
const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
const npmLock = JSON.parse(read('package-lock.json'));
const cargo = read('src-tauri/Cargo.toml');
const cargoLock = read('src-tauri/Cargo.lock');

// 4.0.0 is the rename release; a half-bumped version means one platform ships another number.
const cargoVersion = cargo.match(/^version = "([^"]+)"/m)?.[1];
const lockVersion = cargoLock.match(/name = "mdpad"\nversion = "([^"]+)"/)?.[1];
assert.equal(pkg.name, 'markcune');
assert.equal(pkg.version, tauri.version, 'package.json 与 tauri.conf.json 版本不一致');
assert.equal(pkg.version, cargoVersion, 'package.json 与 Cargo.toml 版本不一致');
assert.equal(pkg.version, lockVersion, 'package.json 与 Cargo.lock 版本不一致');
assert.equal(npmLock.version, pkg.version, 'package-lock.json 版本没跟上');
assert.equal(npmLock.packages[''].name, 'markcune');

// User-visible name changes; the bundle identity does not. Old installs keep their config, AI keys
// and drafts because macOS/Windows/Linux all key them off the identifier and the binary name.
assert.equal(tauri.productName, 'MarkCune');
assert.equal(tauri.identifier, 'local.mdpad', 'Bundle ID 必须沿用 local.mdpad，否则老用户会多一份配置');
assert.match(cargo, /^name = "mdpad"$/m, 'crate / 二进制名必须沿用 mdpad，Tauri 升级后按它重启');
assert.equal(tauri.bundle.linux.deb.conflicts.includes('md-pad'), true, '旧 .deb 包名是 md-pad，新包要声明 Conflicts');
assert.equal(tauri.bundle.linux.deb.replaces.includes('md-pad'), true, '旧 .deb 包名是 md-pad，新包要声明 Replaces');

for (const icon of tauri.bundle.icon) {
  assert.ok(existsSync(new URL(`src-tauri/${icon}`, root)), `图标不存在：${icon}`);
}

console.log(`rebrand ok（${pkg.version}，${tauri.productName}，标识与包名沿用旧值）`);
