// src/licenses-text.js 是生成物，但它必须与「当前这个版本」一致：版本号、依赖清单、条款都要对得上。
// 这些断言守的是最容易被忽略的一条 —— 加了依赖、忘了重跑 npm run licenses，署名就漏了。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const read = (path) => readFileSync(fileURLToPath(new URL(path, root)), 'utf8');

const pkg = JSON.parse(read('package.json'));
const text = read('src/licenses-text.js');
const notices = read('THIRD-PARTY-NOTICES.md');

// 生成物是一个 export default "…" 的模块，取回来才是正文。
const match = text.match(/^export default (".*");$/m);
assert.ok(match, 'licenses-text.js 应是 export default <JSON 字符串>');
const body = JSON.parse(match[1]);

// 版本号必须等于 package.json：发版时改了版本忘了重跑，弹窗里就会写着旧版本。
assert.ok(
  body.startsWith(`MarkCune ${pkg.version} 第三方软件许可`),
  `清单版本应等于 ${pkg.version}，实际开头：${body.slice(0, 30)}`,
);

// 三段结构缺一不可。
for (const heading of ['## 前端依赖', '## Rust 依赖', '## 许可正文']) {
  assert.ok(body.includes(heading), `缺少段落：${heading}`);
}

// 关键组件在列：这几家常被点名核对。
for (const name of ['katex', '@milkdown/crepe', 'mermaid', 'docx']) {
  assert.ok(body.includes(`- ${name} `), `清单里应有 ${name}`);
}

// 条款引用不能悬空：每个「条款 [n]」都要有对应的 ### [n]。
const refs = new Set([...body.matchAll(/条款 \[(\d+)\]/g)].map((m) => Number(m[1])));
const bodies = new Set([...body.matchAll(/^### \[(\d+)\] /gm)].map((m) => Number(m[1])));
assert.ok(refs.size > 0, '应有条款引用');
for (const ref of refs) assert.ok(bodies.has(ref), `条款 [${ref}] 没有对应正文`);

// 两家 md 必须一模一样：仓库里给人看的那份和应用里发出去的那份不能分叉。
// Windows checkout may turn the .md into CRLF; the generated JS string stays LF.
assert.equal(
  notices.replace(/\r\n/g, '\n').trim(),
  body.replace(/\r\n/g, '\n').trim(),
  'THIRD-PARTY-NOTICES.md 与 src/licenses-text.js 内容应一致',
);

// 入口接线：设置里有按钮、命令注册表里有 id、actions 里有实现。
assert.ok(read('src/settings.js').includes('opt-licenses'), '设置面板应有开源许可入口');
assert.ok(/id: 'licenses'/.test(read('src/commands.js')), '命令面板应注册 licenses');
assert.ok(/licenses: \(\) => openLicenses/.test(read('src/main.js')), 'main.js 应把 licenses 接到 openLicenses');

console.log(`licenses ok（${pkg.version}，${refs.size} 段条款，${(body.length / 1024).toFixed(0)} KB）`);
