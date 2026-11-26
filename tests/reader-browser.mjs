// Exercise the packaged reader worker with isolated documents and a stub native bridge.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import { open } from './cdp.mjs';

const outDir = mkdtempSync(join(tmpdir(), 'markcune-reader-test-'));
const configFile = fileURLToPath(new URL('../vite.config.mjs', import.meta.url));
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const content = '# 阅读测试\n\n任务列表\n\n- [x] 已完成\n\n' +
  '[参考链接][ref]\n\n脚注[^source]。\n\n' +
  Array.from({length: 100}, (_, i) => '## 第 ' + (i + 1) + ' 章\n\n' + '章节正文，用来检验按视口渲染。'.repeat(80)).join('\n\n') +
  '\n\n全文末尾检索目标\n\n[ref]: https://example.com/\n\n[^source]: 这是脚注正文。\n';
let page, server;
try {
  const config = { configFile, logLevel: 'warn', build: { outDir } };
  await build(config);
  server = await preview({ ...config, preview: { host:'127.0.0.1', port:0, strictPort:true } });
  const url = 'http://127.0.0.1:' + server.httpServer.address().port + '/';
  page = await open(null, {width: 1100, height: 760, scale: 1});
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: '(' + function (content, version) {
    const mode = new URL(location.href).searchParams.get('mode');
    let callback = 0;
    const listeners = {};
    window.readerCalls = [];
    window.readerSettings = [];
    window.readerOpened = [];
    window.readerErrors = [];
    addEventListener('error', (event) => readerErrors.push(event.message));
    addEventListener('unhandledrejection', (event) => readerErrors.push(String(event.reason)));
    window.readerEvent = (event, payload) => listeners[event]?.({ payload });
    window.__TAURI_INTERNALS__ = {
      metadata: {currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
      transformCallback(fn) { window['_' + (++callback)] = fn; return callback; },
      unregisterCallback() {},
      async invoke(cmd, options) {
        readerCalls.push(cmd);
        if (cmd === 'set_setting') readerSettings.push(options?.key);
        if (cmd === 'window_init') return {platform:'windows', startup:{kind:'file',path:'/demo/reader.md',
          mode: mode === 'source' ? 'source' : undefined}, settings:{sidebar:true,outline:true},
          recentFiles:[],recentFolders:[],pinnedFiles:[]};
        if (cmd === 'read_document') return {path:options.path,
          content: mode === 'blocks' ? '第一段\n\n第二段\n\n第三段\n' : content,
          bytes:mode === 'large' ? 10*1024*1024 : content.length, position:null};
        if (cmd === 'open_in_new_window') readerOpened.push(options.path);
        if (cmd === 'write_document') return {status:'saved'};
        if (cmd === 'list_dir' || cmd === 'list_pinned') return [];
        if (cmd === 'ai_status') return {hasKey:false,completion:false};
        if (cmd === 'voice_status') return {hasKey:false,ready:false};
        if (cmd === 'update_status') return {currentVersion:version};
        if (cmd === 'plugin:app|version') return version;
        if (cmd === 'plugin:event|listen') { listeners[options.event] = window['_' + options.handler]; return callback; }
        return null;
      }
    };
  } + ')(' + JSON.stringify(content) + ',' + JSON.stringify(version) + ')'});

  await page.goto(url);
  assert.ok(await page.waitFor('window.__mdpadDebug?.editor?.kind === "rich"'), 'small Markdown opens in edit mode');
  await page.evaluate('document.querySelector(\'[data-mode="reader"]\').click()');
  const hasReader = await page.waitFor('window.__mdpadDebug?.editor?.kind === "reader" && !!document.querySelector(".reader-document a[href^=https]") && document.getElementById("sidebar").hidden');
  assert.ok(hasReader, JSON.stringify(await page.evaluate(`({ kind:__mdpadDebug.editor?.kind, errors:readerErrors,
    article:document.querySelector('.reader-document')?.innerHTML.slice(0,1200),
    toast:document.querySelector('#toast')?.textContent })`)));
  const state = await page.evaluate('(' + function () {
    const toggle = document.getElementById('toggle-sidebar');
    const toggleRect = toggle.getBoundingClientRect();
    return {
      active: document.querySelector('#mode-switch [aria-selected="true"]').textContent,
      sidebar: document.getElementById('sidebar').hidden,
      sidebarToggleVisible: toggleRect.width > 0 && toggleRect.height > 0,
      outline: document.getElementById('outline').hidden,
      editor: !!document.querySelector('#editor [contenteditable="true"]'),
      disabledTask: document.querySelector('.reader-document input[type="checkbox"]')?.disabled,
      link: document.querySelector('.reader-document a[href^="https:"]')?.href,
    };
  } + ')()');
  assert.deepEqual(state, {active:'阅读', sidebar:true, sidebarToggleVisible:true, outline:false, editor:false, disabledTask:true, link:'https://example.com/'});
  // Clicking the files toggle in reading mode brings the file sidebar back without losing reader mode.
  await page.evaluate('document.getElementById("toggle-sidebar").click()');
  assert.ok(await page.waitFor('!document.getElementById("sidebar").hidden && document.getElementById("toggle-sidebar").getAttribute("aria-pressed") === "true"'));
  assert.equal(await page.evaluate('readerSettings.includes("sidebar")'), false, 'toggling sidebar in reader must not overwrite edit-mode setting');
  await page.evaluate('document.getElementById("toggle-sidebar").click()');
  assert.ok(await page.waitFor('document.getElementById("sidebar").hidden && document.getElementById("toggle-sidebar").getAttribute("aria-pressed") === "false"'));
  await page.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const search = await page.evaluate('__mdpadDebug.editor.find.set("全文末尾检索目标")');
  assert.equal(search.count, 1);
  assert.ok(await page.waitFor('document.querySelector(".reader-match")?.textContent === "全文末尾检索目标"'));
  assert.ok(await page.evaluate('document.querySelectorAll(".reader-page").length <= 6'));
  await page.evaluate('__mdpadDebug.editor.find.finish()');
  await page.evaluate('document.querySelector(\'[data-mode="rich"]\').click()');
  assert.ok(await page.waitFor('window.__mdpadDebug?.editor?.kind === "rich" && !document.getElementById("sidebar").hidden'));
  assert.equal(await page.evaluate('readerCalls.includes("write_document")'), false);

  await page.evaluate('readerEvent("file-drop-hover", {files:1, folders:0})');
  assert.equal(await page.evaluate('document.querySelector("#drop-overlay .drop-message").textContent'), '松开打开文档');
  await page.evaluate('readerEvent("open-path", {path:"/demo/dropped.md", isDir:false, dropped:true})');
  assert.ok(await page.waitFor('__mdpadDebug.doc.path === "/demo/dropped.md" && __mdpadDebug.editor?.kind === "rich"'));
  assert.equal(await page.evaluate('document.querySelector("#drop-overlay").hidden'), true);
  await page.evaluate(`(() => {
    const view = __mdpadDebug.editor.view;
    view.dispatch(view.state.tr.insertText('保留未保存的编辑', 2));
    readerEvent('open-path', {path:'/demo/another.md', isDir:false, dropped:true});
  })()`);
  assert.deepEqual(await page.evaluate('readerOpened'), ['/demo/another.md']);
  assert.equal(await page.evaluate('__mdpadDebug.doc.path'), '/demo/dropped.md');
  assert.ok(await page.evaluate('__mdpadDebug.editor.getMarkdown().includes("保留未保存的编辑")'));

  await page.goto(url+'?mode=large');
  assert.ok(await page.waitFor('window.__mdpadDebug?.editor?.kind === "reader"'), 'large documents open directly in reader');
  assert.ok(await page.waitFor('performance.getEntriesByName("mdpad:reader-first-paint").length > 0'));
  assert.equal(await page.evaluate('!!document.querySelector(".ProseMirror")'), false);

  await page.goto(url+'?mode=source');
  assert.ok(await page.waitFor('window.__mdpadDebug?.editor?.kind === "source"'), 'explicit source mode bypasses rich mount');

  await page.goto(url+'?mode=blocks');
  assert.ok(await page.waitFor('document.querySelector(".ProseMirror p")?.textContent === "第一段"'));
  const points = await page.evaluate(`(() => {
    const paragraphs = document.querySelectorAll('.ProseMirror p');
    const first = paragraphs[0].getBoundingClientRect();
    const last = paragraphs[2].getBoundingClientRect();
    return { hover:{x:first.left + 24, y:first.top + first.height / 2},
      drop:{x:last.left + 35, y:last.bottom - 2} };
  })()`);
  await page.send('Input.dispatchMouseEvent', {type:'mouseMoved', ...points.hover});
  assert.ok(await page.waitFor('!!document.querySelector(\'.milkdown-block-handle[data-show="true"]\')'));
  const grip = await page.evaluate(`(() => {
    const box = document.querySelector('.milkdown-block-handle .operation-item:last-child').getBoundingClientRect();
    return {x:box.left + box.width / 2, y:box.top + box.height / 2};
  })()`);
  await page.send('Input.dispatchMouseEvent', {type:'mousePressed', ...grip, button:'left', clickCount:1});
  await page.send('Input.dispatchMouseEvent', {type:'mouseMoved', ...points.drop, buttons:1});
  await page.send('Input.dispatchMouseEvent', {type:'mouseReleased', ...points.drop, button:'left', clickCount:1});
  assert.deepEqual(await page.evaluate('[...document.querySelectorAll(".ProseMirror p")].map(p => p.textContent)'),
    ['第二段', '第三段', '第一段']);
  console.log('阅读模式、全文检索、侧栏恢复、拖放与未保存内容保护、大文件分流、源码入口通过');
} finally {
  page?.close();
  await server?.close();
  rmSync(outDir, { recursive:true, force:true });
}
