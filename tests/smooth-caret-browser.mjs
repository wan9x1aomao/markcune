// Browser verification for MaoBot-style smooth caret across rich mode, source mode, and reduced motion.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { open, sleep } from './cdp.mjs';

const port = Number(process.env.CARET_TEST_PORT || 5268);
const server = spawn('npx', ['vite', '--port', String(port), '--host', '127.0.0.1', '--strictPort'], { stdio: 'ignore' });
const url = `http://127.0.0.1:${port}/`;
const content = '# 光标平滑测试\n\n第一行用于测试平滑移动的光标。\n\n第二行用来验证换行平移。\n';

let page;
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try { ready = (await fetch(url)).ok; } catch {}
    if (ready) break;
    await sleep(120);
  }
  assert.ok(ready, 'vite dev server ready');

  page = await open(null, { width: 1100, height: 760, scale: 1 });
  await page.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: 'light' },
      { name: 'prefers-reduced-motion', value: 'no-preference' },
    ],
  });
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(${function (doc) {
      let callback = 0;
      window.caretErrors = [];
      addEventListener('error', (event) => window.caretErrors.push(event.message));
      addEventListener('unhandledrejection', (event) => window.caretErrors.push(String(event.reason)));
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
        transformCallback(fn) { window['_' + (++callback)] = fn; return callback; },
        unregisterCallback() {},
        async invoke(cmd) {
          if (cmd === 'window_init') {
            return {
              platform: 'macos',
              startup: { kind: 'draft', id: 'caret-test', content: doc },
              settings: { sidebar: false, outline: false },
              recentFiles: [],
              recentFolders: [],
              pinnedFiles: [],
            };
          }
          if (cmd === 'draft_write') return 'caret-test';
          if (cmd === 'list_dir' || cmd === 'list_pinned') return [];
          if (cmd === 'ai_status') return { hasKey: false, completion: false };
          if (cmd === 'voice_status') return { hasKey: false, ready: false };
          if (cmd === 'update_status') return { currentVersion: '4.1.4' };
          if (cmd === 'plugin:app|version') return '4.1.4';
          if (cmd === 'plugin:event|listen') return ++callback;
          return null;
        },
      };
    }})(${JSON.stringify(content)})`,
  });

  await page.goto(url);
  assert.ok(await page.waitFor('window.__mdpadDebug?.editor?.kind === "rich"'));

  // Focus rich editor on the first paragraph and confirm global smooth caret activates with MaoBot blue.
  await page.evaluate(`(() => {
    const p = document.querySelector('#editor .ProseMirror p');
    const r = p.getBoundingClientRect();
    __mdpadDebug.editor.focus();
    const view = __mdpadDebug.editor.view;
    const pos = view.posAtCoords({ left: r.left + 8, top: r.top + r.height / 2 })?.pos;
    if (pos != null) view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.near(view.state.doc.resolve(pos))));
  })()`);
  assert.ok(await page.waitFor('!!document.querySelector("#mc-smooth-caret.is-visible") && document.querySelector("#editor .ProseMirror")?.getAttribute("data-smooth-caret") === "active"'));

  const initialRich = await page.evaluate(`(() => {
    const el = document.getElementById('mc-smooth-caret');
    const style = getComputedStyle(el);
    const virtual = document.querySelector('#editor .ProseMirror .prosemirror-virtual-cursor');
    const virtualStyle = virtual ? getComputedStyle(virtual) : null;
    return {
      bg: style.backgroundColor,
      transform: el.style.transform,
      virtualHidden: !virtualStyle || (virtualStyle.visibility === 'hidden' && virtualStyle.opacity === '0'),
    };
  })()`);
  assert.equal(initialRich.bg, 'rgb(59, 111, 216)', 'light theme caret uses MaoBot blue #3b6fd8');
  assert.equal(initialRich.virtualHidden, true, 'Milkdown virtual cursor must stay hidden while smooth caret is active');

  // Typing moves the caret smoothly with 82ms CSS transform transition and sets is-moving.
  const glideResult = await page.evaluate(`(async () => {
    const el = document.getElementById('mc-smooth-caret');
    const before = el.style.transform;
    const view = __mdpadDebug.editor.view;
    view.dispatch(view.state.tr.insertText('平滑输入'));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const after = el.style.transform;
    const animations = el.getAnimations().map((a) => a.transitionProperty);
    return { before, after, moving: el.classList.contains('is-moving'), animations };
  })()`);
  assert.notEqual(glideResult.before, glideResult.after, 'caret moves after typing');
  assert.equal(glideResult.moving, true, 'is-moving pauses blink while gliding');
  assert.ok(glideResult.animations.includes('transform'), `expected smooth transform transition, got ${JSON.stringify(glideResult)}`);

  // Dark theme MaoBot blue verification.
  await page.evaluate('document.documentElement.dataset.theme = "dark"');
  const darkBg = await page.evaluate('getComputedStyle(document.getElementById("mc-smooth-caret")).backgroundColor');
  assert.equal(darkBg, 'rgb(107, 156, 245)', 'dark theme caret uses MaoBot blue #6b9cf5');
  await page.evaluate('document.documentElement.dataset.theme = "light"');

  // Non-empty selection hides the smooth caret.
  await page.evaluate(`(() => {
    const view = __mdpadDebug.editor.view;
    const from = Math.max(1, view.state.selection.from - 3);
    const to = view.state.selection.from;
    view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.create(view.state.doc, from, to)));
  })()`);
  assert.ok(await page.waitFor('!document.querySelector("#mc-smooth-caret.is-visible")'));

  // Source mode: global smooth caret tracks CodeMirror seamlessly.
  await page.evaluate('document.querySelector(\'[data-mode="source"]\').click()');
  assert.ok(await page.waitFor('window.__mdpadDebug?.editor?.kind === "source"'));
  await page.evaluate('__mdpadDebug.editor.focus()');
  assert.ok(await page.waitFor('!!document.querySelector("#mc-smooth-caret.is-visible") && document.querySelector("#source-pane .cm-editor")?.getAttribute("data-smooth-caret") === "active" && document.querySelector("#source-pane .cm-content")?.getAttribute("data-smooth-caret") === "active"'));
  const sourceGlide = await page.evaluate(`(async () => {
    const el = document.getElementById('mc-smooth-caret');
    const before = el.style.transform;
    __mdpadDebug.editor.insert('smooth');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const after = el.style.transform;
    return { before, after, moving: el.classList.contains('is-moving'), bg: getComputedStyle(el).backgroundColor };
  })()`);
  assert.equal(sourceGlide.bg, 'rgb(59, 111, 216)');
  assert.notEqual(sourceGlide.before, sourceGlide.after);
  assert.equal(sourceGlide.moving, true);

  // Overlay occlusion: opening a modal while the editor still holds focus must hide the caret behind it.
  await page.evaluate(`(() => {
    __mdpadDebug.editor.focus();
  })()`);
  assert.ok(await page.waitFor('!!document.querySelector("#mc-smooth-caret.is-visible")'));
  await page.evaluate(`(() => {
    const overlay = document.createElement('div');
    overlay.className = 'overlay test-overlay';
    document.body.appendChild(overlay);
  })()`);
  assert.ok(await page.waitFor('!document.querySelector("#mc-smooth-caret.is-visible")'));
  await page.evaluate('document.querySelector(".test-overlay")?.remove()');

  // Reduced motion disables the overlay and keeps native MaoBot blue caret.
  await page.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: 'light' },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ],
  });
  assert.ok(await page.waitFor('!document.querySelector("#mc-smooth-caret.is-visible")'));
  await page.evaluate('document.querySelector(\'[data-mode="rich"]\').click()');
  assert.ok(await page.waitFor('window.__mdpadDebug?.editor?.kind === "rich"'));
  const nativeCaret = await page.evaluate('getComputedStyle(document.querySelector("#editor .ProseMirror")).caretColor');
  assert.equal(nativeCaret, 'rgb(59, 111, 216)');
  assert.deepEqual(await page.evaluate('window.caretErrors'), []);

  console.log('MaoBot 风格平滑光标（富文本/源码/深浅主题/选区隐藏/减弱动态）全部通过');
} finally {
  page?.close();
  server.kill();
}
