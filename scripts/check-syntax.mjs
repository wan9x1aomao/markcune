// Syntax check for the project's own JavaScript. No typechecker: the source is plain JS.
// tests/*.js are snippets evaluated inside a browser function, so `return` is legal there
// and `node --check` is the wrong tool. The module entry points are the .mjs tests.
import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'target') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith('.js') || name.endsWith('.mjs')) out.push(path);
  }
}

const files = [];
walk('src', files);
walk('scripts', files);
walk('tests', files);
const checked = files.filter((file) => file.endsWith('.mjs') || file.startsWith('src/'));
let failed = 0;
for (const file of checked) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed += 1;
    process.stderr.write(`${file}\n${result.stderr}`);
  }
}
if (failed) {
  console.error(`语法检查失败：${failed} 个文件`);
  process.exit(1);
}
console.log(`syntax ok（${checked.length} 个文件）`);
