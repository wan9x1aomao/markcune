// Item-by-item test of the AI features, against the real editor in headless Chrome.
//
// Run with `npm run test:browser`. The page it drives is `src/__lab.html`, which carries a fake
// Tauri shell: the UI is real, only the shell answers are canned, so this runs without an API key
// and without touching the network. Each group reloads the page, so a failure can never be caused
// by the case before it.
//
// Needs Chrome (or CHROME_PATH). The dev server is started automatically if the port is silent.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { open, sleep } from './cdp.mjs';

const PORT = Number(process.env.LAB_PORT ?? 5199);
const BASE = `http://127.0.0.1:${PORT}/__lab.html`;
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Starts the dev server when nothing answers, so the suite is one command. */
async function ensureServer() {
  const alive = () => fetch(BASE).then((r) => r.ok).catch(() => false);
  if (await alive()) return null;
  const server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    detached: false,
  });
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    if (await alive()) return server;
  }
  server.kill();
  throw new Error(`开发服务器起不来（端口 ${PORT}）`);
}

const results = [];
const check = (group, name, pass, detail = '') => {
  results.push({ group, name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${group}] ${name}${detail ? `  → ${detail}` : ''}`);
};

const server = await ensureServer();
const page = await open();
const run = (expression) => page.evaluate(expression);

const fresh = async () => {
  await page.goto(BASE);
  await page.waitFor('window.__ready === true', 120);
  await run(`(() => {
    const lab = window.__lab;
    window.__t = {
      calls: (cmd) => window.__stub.calls.filter((c) => c[0] === cmd),
      reset: () => { window.__stub.calls.length = 0; window.__stub.fail = ''; },
      status: async (next) => {
        window.__stub.status = { ...window.__stub.status, ...next };
        await (await import('/ai-core.js')).ai.refresh();
      },
      ai: async () => (await import('/ai-core.js')).ai,
      /** Drops any suggestion and pending timer, including the post-rejection cooldown. */
      settle: async () => {
        const { reset } = await import('/ai-ghost.js');
        reset();
        lab.view.dispatch(lab.view.state.tr);
        await new Promise((r) => setTimeout(r, 60));
      },
      md: () => lab.md(),
      undo: () => lab.editor.command('undo'),
      toast: () => document.getElementById('toast').textContent,
      ghost: () => document.querySelector('.ai-ghost'),
      pick: () => document.querySelector('.ai-pick'),
      bar: () => document.querySelector('.ai-bar'),
      /* Dispatches a key on the editor the way a real press arrives, and reports interception. */
      key: (key, extra = {}) => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra });
        lab.view.dom.dispatchEvent(event);
        return { prevented: event.defaultPrevented };
      },
      composition: (type) => lab.view.dom.dispatchEvent(new CompositionEvent(type, { bubbles: true })),
      /** Caret to the end of the block (paragraph, heading, …) that contains needle. */
      endOf: (needle) => {
        const hit = lab.caretAfter(needle);
        if (!hit) return null;
        const view = lab.view;
        const end = view.state.doc.resolve(hit.to).end();
        view.dispatch(view.state.tr.setSelection(lab.TextSelection.near(view.state.doc.resolve(end))));
        return end;
      },
      /**
       * The real path to a suggestion: caret at a paragraph end, one keystroke, then the idle delay.
       * Moving the caret alone must not ask — that is what the Tab control case checks.
       */
      askAt: async (needle, wait = 900) => {
        window.__t.endOf(needle);
        const view = lab.view;
        view.dispatch(view.state.tr.insertText('再', view.state.selection.from));
        await new Promise((r) => setTimeout(r, wait));
      },
      /** Asks immediately, for the cases where the pause itself is not what is under test. */
      askNow: async (needle) => {
        window.__t.endOf(needle);
        await lab.editor.ai.now();
      },
    };
  })()`);
  // Crepe applies the initial content after mount, which schedules one completion request of its
  // own. Wait it out so the counters start clean.
  await sleep(1000);
  await run(`window.__t.reset()`);
};

const docSnapshot = () => run(`window.__t.md()`);

try {
  // ============================== A. 续写（灰字） ==============================
  await fresh();
  const baseDoc = await docSnapshot();

  // A1 段末停顿发请求
  await run(`(async () => { window.__t.reset(); await window.__t.askAt('第一段内容在这里，正在写一句话。'); })()`);
  check('续写', '段末停顿后发一次请求', (await run(`window.__t.calls('ai_complete').length`)) === 1,
    `${await run(`window.__t.calls('ai_complete').length`)} 次`);
  check('续写', '灰字显示在光标后', (await run(`window.__t.ghost()?.textContent`)) === '接下来会展开说明。');
  const typedDoc = await docSnapshot();
  check('续写', '灰字不是文档内容', typedDoc === baseDoc.replace('一句话。', '一句话。再'), typedDoc.split('\n')[2]);

  // A2 Tab
  const tab = await run(`window.__t.key('Tab')`);
  check('续写', '有灰字时 Tab 被拦截', tab.prevented === true);
  const accepted = await docSnapshot();
  check('续写', 'Tab 把灰字写进文档', accepted.includes('正在写一句话。再接下来会展开说明。'), accepted.split('\n')[2]);
  await run(`window.__t.undo()`);
  check('续写', '接受后一次撤销回到原样', (await docSnapshot()) === typedDoc);

  // A3 Esc
  await run(`(async () => { await window.__t.settle(); window.__t.reset(); await window.__t.askAt('第一段内容在这里，正在写一句话。'); })()`);
  const ghostBeforeEsc = await run(`!!window.__t.ghost()`);
  const esc = await run(`window.__t.key('Escape')`);
  check('续写', '有灰字时 Esc 被拦截', ghostBeforeEsc && esc.prevented === true,
    `ghost=${ghostBeforeEsc} prevented=${esc.prevented} ctx=${JSON.stringify(await run(`window.__lab.ctx()`))}`);
  const afterEscDoc = await docSnapshot();
  check('续写', 'Esc 后灰字消失且文档不变', (await run(`!window.__t.ghost()`)) === true
    && afterEscDoc.replace('再', '') !== '' , afterEscDoc.split('\n')[2]);

  // A4 拒绝后的冷却期
  await run(`(() => { window.__t.reset(); window.__lab.ghostNow(); })()`);
  await sleep(300);
  check('续写', '拒绝后 2.5s 内不再请求', (await run(`window.__t.calls('ai_complete').length`)) === 0,
    `${await run(`window.__t.calls('ai_complete').length`)} 次`);
  await sleep(2700);
  await run(`window.__lab.ghostNow()`);
  await sleep(300);
  check('续写', '冷却结束后恢复请求', (await run(`window.__t.calls('ai_complete').length`)) >= 1);

  // A5 句中不请求：刻意把光标放在句子中间再打字
  await run(`(async () => {
    await window.__t.settle();
    window.__lab.caretAfter('正在写一句话');
    const view = window.__lab.view;
    view.dispatch(view.state.tr.insertText('再', view.state.selection.from));
    window.__t.reset();
    await new Promise((r) => setTimeout(r, 900));
  })()`);
  check('续写', '光标在句中不请求', (await run(`window.__t.calls('ai_complete').length`)) === 0);

  // A6 上下文太短：门槛数的是光标前的全部上下文，所以这里整篇都要短。
  await run(`(async () => {
    await window.__t.settle();
    window.__lab.setDoc('好。\\n');
    await new Promise((r) => setTimeout(r, 120));
    window.__t.reset();
    await window.__t.askAt('好。');
  })()`);
  check('续写', '上下文不足 4 字不请求', (await run(`window.__t.calls('ai_complete').length`)) === 0,
    `chars=${await run(`window.__lab.ctx().chars`)}`);

  // A7 标题里不请求
  await run(`(async () => {
    await window.__t.settle();
    window.__lab.setDoc('# 标题\\n\\n第一段内容在这里，正在写一句话。\\n\\n第二段文字，需要被改写。\\n');
    await new Promise((r) => setTimeout(r, 120));
    window.__t.reset();
    await window.__t.askAt('标题');
  })()`);
  check('续写', '标题里不请求', (await run(`window.__t.calls('ai_complete').length`)) === 0);

  // A8 输入法组字
  await run(`(async () => {
    await window.__t.settle();
    window.__lab.setDoc('# 标题\\n\\n第一段内容在这里，正在写一句话。\\n\\n第二段文字，需要被改写。\\n');
    await new Promise((r) => setTimeout(r, 120));
    window.__t.endOf('第一段内容在这里，正在写一句话。');
    window.__t.composition('compositionstart');
    window.__t.reset();
    await new Promise((r) => setTimeout(r, 900));
  })()`);
  check('续写', '输入法组字中不请求', (await run(`window.__t.calls('ai_complete').length`)) === 0);
  await run(`(async () => { window.__t.composition('compositionend'); await new Promise((r) => setTimeout(r, 900)); })()`);
  check('续写', '组字结束后恢复请求', (await run(`window.__t.calls('ai_complete').length`)) >= 1,
    `calls=${await run(`window.__t.calls('ai_complete').length`)} ctx=${JSON.stringify(await run(`window.__lab.ctx()`))} status=${JSON.stringify(await run(`window.__lab.status()`))}`);

  // A9 No ghost: Tab must behave exactly as it does with the feature switched off. The editor
  // already consumes Tab for its own indentation, so the check is "identical to the control",
  // not "never prevented".
  const tabControl = await run(`(async () => {
    await window.__t.settle();
    await window.__t.status({ mode: 'none', hasKey: false });
    window.__lab.setDoc('# 标题\\n\\n第一段内容在这里，正在写一句话。\\n\\n第二段文字，需要被改写。\\n');
    await new Promise((r) => setTimeout(r, 120));
    window.__lab.caretAfter('第一段内容在这里，正在写一句话。');
    const before = window.__lab.md();
    const event = window.__t.key('Tab');
    return { prevented: event.prevented, changed: window.__lab.md() !== before };
  })()`);
  const tabNoGhost = await run(`(async () => {
    await window.__t.status({ mode: 'direct', hasKey: true, completion: true });
    await window.__t.settle();
    window.__lab.setDoc('# 标题\\n\\n第一段内容在这里，正在写一句话。\\n\\n第二段文字，需要被改写。\\n');
    await new Promise((r) => setTimeout(r, 120));
    window.__lab.caretAfter('第一段内容在这里，正在写一句话。');
    const before = window.__lab.md();
    const event = window.__t.key('Tab');
    return { prevented: event.prevented, changed: window.__lab.md() !== before, ghost: !!window.__t.ghost() };
  })()`);
  check('续写', '没灰字时 Tab 与关掉 AI 时完全一样', tabNoGhost.ghost === false
    && tabNoGhost.prevented === tabControl.prevented && tabNoGhost.changed === tabControl.changed,
    `关掉AI=${JSON.stringify(tabControl)} 开着无灰字=${JSON.stringify(tabNoGhost)}`);

  // A10 光标移开
  await run(`(async () => {
    await window.__t.settle();
    window.__lab.setDoc('# 标题\\n\\n第一段内容在这里，正在写一句话。\\n\\n第二段文字，需要被改写。\\n');
    await new Promise((r) => setTimeout(r, 120));
    await window.__t.askAt('第一段内容在这里，正在写一句话。');
  })()`);
  const ghostShown = await run(`!!window.__t.ghost()`);
  await run(`window.__lab.caretAfter('第一段内容在这里')`);
  await sleep(150);
  check('续写', '光标移开后灰字消失', ghostShown && (await run(`!window.__t.ghost()`)) === true,
    `ghost shown before=${ghostShown}`);

  // A11 继续打字
  await run(`(async () => {
    await window.__t.settle();
    window.__lab.setDoc('# 标题\\n\\n第一段内容在这里，正在写一句话。\\n\\n第二段文字，需要被改写。\\n');
    await new Promise((r) => setTimeout(r, 120));
    await window.__t.askAt('第一段内容在这里，正在写一句话。');
  })()`);
  const ghostBeforeType = await run(`!!window.__t.ghost()`);
  await run(`(() => { const v = window.__lab.view; v.dispatch(v.state.tr.insertText('再', v.state.selection.from)); })()`);
  await sleep(150);
  check('续写', '继续打字后灰字消失', ghostBeforeType && (await run(`!window.__t.ghost()`)) === true,
    `ghost before=${ghostBeforeType}`);

  // A13 别处改动、光标没动：灰字也必须消失（这条专门盯 notifyDocChange 之后的重绘）
  await run(`(async () => {
    await window.__t.settle();
    window.__lab.setDoc('# 标题\\n\\n第一段内容在这里，正在写一句话。\\n\\n第二段文字，需要被改写。\\n');
    await new Promise((r) => setTimeout(r, 120));
    await window.__t.askAt('第一段内容在这里，正在写一句话。');
  })()`);
  const ghostBeforeFarEdit = await run(`!!window.__t.ghost()`);
  const farEdit = await run(`(async () => {
    const view = window.__lab.view;
    const caretBefore = view.state.selection.from;
    // An edit after the caret: the caret keeps its position, so only a repaint can drop the ghost.
    const end = view.state.doc.content.size;
    view.dispatch(view.state.tr.insertText('尾部补充', end - 1));
    await new Promise((r) => setTimeout(r, 100));
    return { caretBefore, caretAfter: view.state.selection.from, ghost: !!window.__t.ghost() };
  })()`);
  check('续写', '别处改动后灰字消失', ghostBeforeFarEdit && farEdit.ghost === false
    && farEdit.caretBefore === farEdit.caretAfter, JSON.stringify({ ghostBeforeFarEdit, ...farEdit }));

  // A12 多行返回压成一行
  await run(`(async () => {
    await window.__t.settle();
    window.__lab.setDoc('# 标题\\n\\n第一段内容在这里，正在写一句话。\\n\\n第二段文字，需要被改写。\\n');
    await new Promise((r) => setTimeout(r, 120));
    window.__stub.completion = '第一行\\n第二行';
    window.__t.reset();
    await window.__t.askAt('第一段内容在这里，正在写一句话。');
  })()`);
  check('续写', '多行结果只显示一行', (await run(`window.__t.ghost()?.textContent`)) === '第一行 第二行',
    await run(`JSON.stringify(window.__t.ghost()?.textContent)`));

  // A13 开关关闭
  await run(`(async () => {
    await window.__t.settle();
    await window.__t.status({ completion: false });
    window.__t.reset();
    await window.__t.askAt('第一段内容在这里，正在写一句话。');
  })()`);
  check('续写', '关闭续写开关后不请求', (await run(`window.__t.calls('ai_complete').length`)) === 0);

  // A14 未配置
  await run(`(async () => {
    await window.__t.status({ mode: 'none', hasKey: false, completion: true });
    window.__t.reset();
    await window.__t.askAt('第一段内容在这里，正在写一句话。');
  })()`);
  check('续写', '没配置时完全不请求', (await run(`window.__t.calls('ai_complete').length`)) === 0);

  // ============================== B. 改写（对照） ==============================
  await fresh();
  const proposalDoc = await docSnapshot();
  const SELECTED = '第二段文字，需要被改写。';

  // B1 没选中
  await run(`(async () => {
    window.__lab.caretAfter('第二段文字');
    window.__t.reset();
    window.__lab.propose('改得更简洁');
    await new Promise((r) => setTimeout(r, 200));
  })()`);
  check('改写', '没选中时提示先选中且不请求', (await run(`window.__t.calls('ai_rewrite').length`)) === 0
    && (await run(`window.__t.toast()`)) === '先选中要改的文字', await run(`window.__t.toast()`));

  // B2 非正文块（代码块）不参与改写
  await run(`(async () => {
    const fence = String.fromCharCode(96, 96, 96);
    window.__lab.setDoc('# 标题\\n\\n第一段文字，需要被改写。\\n\\n' + fence + 'js\\nconst a = 1;\\n' + fence + '\\n');
    await new Promise((r) => setTimeout(r, 250));
    window.__lab.selectBlocks(1, 2);
    window.__t.reset();
    document.getElementById('toast').textContent = '';
    window.__lab.propose('改得更简洁');
    await new Promise((r) => setTimeout(r, 200));
    return window.__lab.view.state.doc.childCount;
  })()`);
  check('改写', '代码块混在选区里时拒绝并说明', (await run(`window.__t.toast()`)) === '代码块不参与改写'
    && (await run(`window.__t.calls('ai_rewrite').length`)) === 0, await run(`window.__t.toast()`));
  await run(`(async () => {
    window.__lab.setDoc('# 标题\\n\\n第一段内容在这里，正在写一句话。\\n\\n第二段文字，需要被改写。\\n');
    await new Promise((r) => setTimeout(r, 250));
  })()`);

  // B2b 列表 / 引用块：容器里的一段也能改，跨多项时自动改成逐段
  await run(`(async () => {
    window.__lab.setDoc('第四点。\\n\\n- 第一项，需要被翻译。\\n- 第二项，也要被翻译。\\n');
    await new Promise((r) => setTimeout(r, 250));
    window.__lab.view.focus();
    window.__lab.select('第一项，需要被翻译。');
    window.__t.reset();
    document.getElementById('toast').textContent = '';
    window.__lab.propose('译成英文', '译成英文');
    await new Promise((r) => setTimeout(r, 400));
  })()`);
  check('改写', '列表项里的一段可以改写', (await run(`window.__t.calls('ai_rewrite').length`)) === 1
    && (await run(`window.__lab.proposals().length`)) === 1, await run(`window.__t.toast()`));
  await run(`(async () => { window.__lab.accept(window.__lab.proposals()[0]?.id); await new Promise((r) => setTimeout(r, 120)); })()`);
  const listMd = await run(`window.__lab.md()`);
  check('改写', '接受后列表结构还在', String(listMd).includes('改写之后的文字') && String(listMd).includes('- ')
    && !String(listMd).includes('第一项'), JSON.stringify(listMd));

  await run(`(async () => {
    window.__lab.setDoc('- 甲项文字，需要被翻译。\\n- 乙项文字，也要被翻译。\\n');
    await new Promise((r) => setTimeout(r, 250));
    window.__lab.view.focus();
    window.__lab.selectBlocks(0, 0);
    window.__t.reset();
    document.getElementById('toast').textContent = '';
    window.__lab.propose('译成英文', '译成英文');
    await new Promise((r) => setTimeout(r, 700));
  })()`);
  check('改写', '跨多个列表项时自动逐段改写', (await run(`window.__t.calls('ai_rewrite').length`)) === 2
    && (await run(`window.__lab.proposals().length`)) === 2,
    `${await run(`window.__t.calls('ai_rewrite').length`)} 次请求 / ${await run(`window.__lab.proposals().length`)} 条建议`);

  await run(`(async () => {
    window.__lab.setDoc('> 引用里的一段话，需要被改写。\\n');
    await new Promise((r) => setTimeout(r, 250));
    window.__lab.view.focus();
    window.__lab.select('引用里的一段话');
    window.__t.reset();
    document.getElementById('toast').textContent = '';
    window.__lab.propose('改得更简洁');
    await new Promise((r) => setTimeout(r, 400));
  })()`);
  check('改写', '引用块里的一段可以改写', (await run(`window.__t.calls('ai_rewrite').length`)) === 1
    && (await run(`window.__lab.proposals().length`)) === 1, await run(`window.__t.toast()`));

  await run(`(async () => {
    window.__lab.setDoc('| 甲 | 乙 |\\n| --- | --- |\\n| 一格字 | 二格字 |\\n');
    await new Promise((r) => setTimeout(r, 250));
    window.__lab.view.focus();
    window.__lab.select('一格字');
    window.__t.reset();
    document.getElementById('toast').textContent = '';
    window.__lab.propose('改得更简洁');
    await new Promise((r) => setTimeout(r, 400));
  })()`);
  check('改写', '表格单元格里的一段可以改写', (await run(`window.__t.calls('ai_rewrite').length`)) === 1
    && (await run(`window.__lab.proposals().length`)) === 1, await run(`window.__t.toast()`));

  await run(`(async () => {
    window.__lab.setDoc('# 标题\\n\\n第一段内容在这里，正在写一句话。\\n\\n第二段文字，需要被改写。\\n');
    await new Promise((r) => setTimeout(r, 250));
  })()`);

  // B3 请求与呈现
  await run(`(async () => {
    window.__stub.rewrite = '改写之后的文字，更短了。';
    window.__lab.view.focus();
    window.__lab.select(${JSON.stringify(SELECTED)});
    window.__t.reset();
    window.__lab.propose('删掉冗余和重复的表述');
    await new Promise((r) => setTimeout(r, 500));
  })()`);
  check('改写', '请求里带上了原文', (await run(`window.__t.calls('ai_rewrite')[0]?.[1]?.text`)) === SELECTED);
  check('改写', '原文被划掉', (await run(`!!document.querySelector('.ai-old')`)) === true);
  check('改写', '新文以绿字显示', (await run(`document.querySelector('.ai-new')?.textContent`)) === '改写之后的文字，更短了。',
    await run(`JSON.stringify(document.querySelector('.ai-new')?.textContent)`));
  check('改写', '提议期间文档不变', (await docSnapshot()) === proposalDoc);
  const barInfo = await run(`(() => {
    const bar = window.__t.bar();
    if (!bar) return null;
    const rect = bar.getBoundingClientRect();
    return {
      display: getComputedStyle(bar).display,
      inView: rect.top > 0 && rect.bottom < window.innerHeight,
      buttons: [...bar.querySelectorAll('button')].map((b) => b.dataset.act),
      note: bar.querySelector('.ai-bar-note')?.textContent,
    };
  })()`);
  check('改写', '浮动条在视口内、动作齐全', barInfo && barInfo.display !== 'none' && barInfo.inView
    && JSON.stringify(barInfo.buttons) === '["accept","retry","reject"]', JSON.stringify(barInfo));

  // B4 重来
  await run(`(async () => { window.__t.reset(); document.querySelector('.ai-bar button[data-act="retry"]').click(); await new Promise((r) => setTimeout(r, 500)); })()`);
  check('改写', '「重来」重新请求一次', (await run(`window.__t.calls('ai_rewrite').length`)) === 1);

  // B5 采纳
  await run(`document.querySelector('.ai-bar button[data-act="accept"]').click()`);
  await sleep(150);
  const acceptedDoc = await docSnapshot();
  check('改写', '采纳后写入文档', acceptedDoc.includes('改写之后的文字，更短了。'), acceptedDoc.split('\n')[4]);
  check('改写', '采纳后浮动条消失', (await run(`!window.__t.bar()`)) === true);
  check('改写', '采纳后对照消失', (await run(`!document.querySelector('.ai-old') && !document.querySelector('.ai-new')`)) === true);
  await run(`window.__t.undo()`);
  check('改写', '采纳也是一次撤销', (await docSnapshot()) === proposalDoc);

  // B6 拒绝
  await run(`(async () => {
    window.__lab.view.focus();
    window.__lab.select(${JSON.stringify(SELECTED)});
    window.__lab.propose('改得更正式');
    await new Promise((r) => setTimeout(r, 500));
  })()`);
  await run(`document.querySelector('.ai-bar button[data-act="reject"]').click()`);
  await sleep(150);
  check('改写', '「拒绝」不留痕迹', (await run(`!document.querySelector('.ai-old') && !document.querySelector('.ai-new') && !window.__t.bar()`)) === true
    && (await docSnapshot()) === proposalDoc);

  // B7 文档在提议期间被改：别处改动只移动位置，提议覆盖的文字一改就作废
  const moved = await run(`(async () => {
    window.__lab.view.focus();
    window.__lab.select(${JSON.stringify(SELECTED)});
    window.__lab.propose('改得更正式');
    await new Promise((r) => setTimeout(r, 500));
    const view = window.__lab.view;
    view.dispatch(view.state.tr.insertText('开头补一句。', 1));
    await new Promise((r) => setTimeout(r, 150));
    const list = window.__lab.proposals();
    document.querySelector('.ai-bar button[data-act="accept"]')?.click();
    await new Promise((r) => setTimeout(r, 200));
    return { left: list.length, source: list[0]?.source, md: window.__t.md() };
  })()`);
  check('改写', '别处改动后提议跟着走、仍改对的那句', moved.left === 1 && moved.source === SELECTED
    && moved.md.includes('开头补一句。') && moved.md.includes('改写之后的文字，更短了。'), JSON.stringify(moved));

  const stale = await run(`(async () => {
    window.__lab.setDoc('# 标题\\n\\n第二段文字，需要被改写。\\n');
    await new Promise((r) => setTimeout(r, 250));
    window.__lab.select(${JSON.stringify(SELECTED)});
    window.__lab.propose('改得更正式');
    await new Promise((r) => setTimeout(r, 500));
    const view = window.__lab.view;
    const proposal = window.__lab.proposals()[0];
    view.dispatch(view.state.tr.insertText('插话', proposal.to - 2));
    await new Promise((r) => setTimeout(r, 150));
    return {
      left: window.__lab.proposals().length,
      md: window.__t.md(),
      bar: !!document.querySelector('.ai-bar'),
      deco: !!document.querySelector('.ai-new'),
    };
  })()`);
  check('改写', '提议覆盖的文字被改后提议作废', stale.left === 0 && stale.bar === false && stale.deco === false
    && stale.md.includes('插话'), JSON.stringify(stale));

  // B8 多行结果
  await fresh();
  const multiDoc = await docSnapshot();
  const multi = await run(`(async () => {
    window.__stub.rewrite = '第一行文字\\n第二行文字';
    window.__lab.view.focus();
    window.__lab.select(${JSON.stringify(SELECTED)});
    window.__lab.propose('分成两行');
    await new Promise((r) => setTimeout(r, 500));
    document.querySelector('.ai-bar button[data-act="accept"]').click();
    await new Promise((r) => setTimeout(r, 150));
    const view = window.__lab.view;
    const blocks = [];
    view.state.doc.forEach((n) => blocks.push(n.type.name));
    return { blocks, md: window.__t.md() };
  })()`);
  check('改写', '多行结果用硬换行，不多出段落', JSON.stringify(multi.blocks) === '["heading","paragraph","paragraph"]'
    && multi.md.includes('第一行文字') && multi.md.includes('第二行文字'), JSON.stringify(multi));
  await run(`window.__t.undo()`);
  check('改写', '多行采纳也能一次撤销', (await docSnapshot()) === multiDoc);

  // B9 与原文相同
  await run(`(async () => {
    window.__stub.rewrite = ${JSON.stringify(SELECTED)};
    window.__lab.view.focus();
    window.__lab.select(${JSON.stringify(SELECTED)});
    window.__lab.propose('改得更正式');
    await new Promise((r) => setTimeout(r, 400));
  })()`);
  check('改写', '模型认为不用改时不显示提议', (await run(`!document.querySelector('.ai-new') && !window.__t.bar()`)) === true
    && (await run(`window.__t.toast()`)) === 'AI 认为这里不用改', await run(`window.__t.toast()`));

  // B10 空结果
  await run(`(async () => {
    window.__stub.rewrite = '   ';
    window.__lab.view.focus();
    window.__lab.select(${JSON.stringify(SELECTED)});
    window.__lab.propose('改得更正式');
    await new Promise((r) => setTimeout(r, 400));
  })()`);
  check('改写', '空结果时不显示提议并说明', (await run(`!document.querySelector('.ai-new')`)) === true
    && (await run(`window.__t.toast()`)) === 'AI 没有给出改写结果', await run(`window.__t.toast()`));

  // B11 失败
  await run(`(async () => {
    window.__stub.rewrite = '改写之后的文字。';
    window.__lab.view.focus();
    window.__lab.select(${JSON.stringify(SELECTED)});
    window.__t.reset();
    window.__stub.fail = 'Key 无效，或者没有调用这个模型的权限';
    window.__lab.propose('改得更正式');
    await new Promise((r) => setTimeout(r, 400));
  })()`);
  check('改写', '失败时说出真实原因', (await run(`window.__t.toast()`)) === 'Key 无效，或者没有调用这个模型的权限',
    await run(`window.__t.toast()`));
  check('改写', '失败时文档不变且无残留', (await docSnapshot()) === multiDoc
    && (await run(`!document.querySelector('.ai-new') && !window.__t.bar()`)) === true);

  // ============================== C. 设置面板 ==============================
  await fresh();
  await run(`(async () => {
    await window.__t.status({ mode: 'direct', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', hasKey: true, completion: true });
    window.__t.reset();
    (await import('/ai-settings.js')).openAiSettings();
    await new Promise((r) => setTimeout(r, 250));
  })()`);
  const filled = await run(`({
    provider: document.querySelector('.ai-provider').value,
    base: document.querySelector('.ai-base').value,
    model: document.querySelector('.ai-model').value,
    completion: document.querySelector('.ai-completion').checked,
    placeholder: document.querySelector('.ai-key').placeholder,
    clearHidden: document.querySelector('.ai-clear').hidden,
    keyEmpty: document.querySelector('.ai-key').value === '',
    keyType: document.querySelector('.ai-key').type,
  })`);
  check('设置', '打开时回填地址与模型', filled.base === 'https://api.deepseek.com/v1' && filled.model === 'deepseek-chat');
  check('设置', '认出已存的 DeepSeek 配置', filled.provider === 'deepseek', filled.provider);
  check('设置', '续写开关状态回填', filled.completion === true);
  check('设置', 'Key 是密码框且不回显', filled.keyType === 'password' && filled.keyEmpty === true);
  check('设置', '已存 Key 时提示留空不修改', filled.placeholder === '已保存，留空不修改' && filled.clearHidden === false);

  const switched = await run(`(() => {
    const select = document.querySelector('.ai-provider');
    select.value = 'kimi';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return { base: document.querySelector('.ai-base').value, model: document.querySelector('.ai-model').value };
  })()`);
  check('设置', '切换服务商自动填地址和模型', switched.base === 'https://api.moonshot.cn/v1' && switched.model === 'moonshot-v1-8k',
    JSON.stringify(switched));

  const keepCall = await run(`(async () => {
    window.__t.reset();
    document.querySelector('.ai-save').click();
    await new Promise((r) => setTimeout(r, 300));
    return window.__t.calls('ai_configure').pop()?.[1] ?? null;
  })()`);
  check('设置', '留空保存不发送 apiKey（不覆盖）', keepCall !== null && !('apiKey' in keepCall), JSON.stringify(keepCall));

  const newCall = await run(`(async () => {
    (await import('/ai-settings.js')).openAiSettings();
    await new Promise((r) => setTimeout(r, 200));
    window.__t.reset();
    document.querySelector('.ai-key').value = 'sk-new-key';
    document.querySelector('.ai-save').click();
    await new Promise((r) => setTimeout(r, 300));
    return window.__t.calls('ai_configure').pop()?.[1] ?? null;
  })()`);
  check('设置', '输入新 Key 会覆盖', newCall?.apiKey === 'sk-new-key');

  const clearCall = await run(`(async () => {
    (await import('/ai-settings.js')).openAiSettings();
    await new Promise((r) => setTimeout(r, 200));
    window.__t.reset();
    document.querySelector('.ai-clear').click();
    document.querySelector('.ai-save').click();
    await new Promise((r) => setTimeout(r, 300));
    return { call: window.__t.calls('ai_configure').pop()?.[1] ?? null, available: (await window.__t.ai()).available() };
  })()`);
  check('设置', '「清除」发送空 Key', clearCall.call?.apiKey === '');
  check('设置', '清除后 AI 变回未配置', clearCall.available === false, String(clearCall.available));

  check('设置', 'Esc 关闭面板', (await run(`(async () => {
    (await import('/ai-settings.js')).openAiSettings();
    await new Promise((r) => setTimeout(r, 150));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    return !document.querySelector('.ai-panel');
  })()`)) === true);

  check('设置', '点遮罩关闭面板', (await run(`(async () => {
    (await import('/ai-settings.js')).openAiSettings();
    await new Promise((r) => setTimeout(r, 150));
    document.querySelector('.ai-overlay').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    return !document.querySelector('.ai-panel');
  })()`)) === true);

  const testOk = await run(`(async () => {
    await window.__t.status({ mode: 'direct', hasKey: true });
    (await import('/ai-settings.js')).openAiSettings();
    await new Promise((r) => setTimeout(r, 200));
    document.querySelector('.ai-test').click();
    await new Promise((r) => setTimeout(r, 300));
    const el = document.querySelector('.ai-result');
    return { text: el.textContent, state: el.dataset.state };
  })()`);
  check('设置', '测试连接成功后提示已保存', testOk.state === 'ok' && testOk.text.startsWith('已保存'), testOk.text);

  const testFail = await run(`(async () => {
    (await import('/ai-settings.js')).openAiSettings();
    await new Promise((r) => setTimeout(r, 200));
    window.__stub.fail = 'Key 无效，或者没有调用这个模型的权限';
    document.querySelector('.ai-test').click();
    await new Promise((r) => setTimeout(r, 300));
    const el = document.querySelector('.ai-result');
    window.__stub.fail = '';
    return { text: el.textContent, state: el.dataset.state };
  })()`);
  check('设置', '测试连接失败显示原因', testFail.state === 'error' && testFail.text.includes('Key 无效'), testFail.text);

  // ============================== D. 入口显隐 ==============================
  await fresh();
  const commands = await run(`(async () => {
    const { skillCommands } = await import('/ai-skills.js');
    return skillCommands(window.__lab.view).map((c) => c.title);
  })()`);
  check('入口', '命令面板里有 6 条改写命令 + 1 条逐段', commands.length === 7, `${commands.length} 条`);

  const pickOff = await run(`(async () => {
    await window.__t.status({ mode: 'none', hasKey: false });
    window.__lab.view.focus();
    window.__lab.select(${JSON.stringify(SELECTED)});
    await new Promise((r) => setTimeout(r, 300));
    const el = window.__t.pick();
    return { exists: !!el, hidden: el?.hidden ?? null, available: (await window.__t.ai()).available() };
  })()`);
  check('入口', '没配置时选区旁没有 AI 按钮', pickOff.available === false && (pickOff.exists === false || pickOff.hidden === true),
    JSON.stringify(pickOff));

  const pickOn = await run(`(async () => {
    await window.__t.status({ mode: 'direct', hasKey: true });
    window.__lab.view.focus();
    window.__lab.select(${JSON.stringify(SELECTED)});
    await new Promise((r) => setTimeout(r, 300));
    const el = window.__t.pick();
    return { exists: !!el, hidden: el?.hidden ?? null, hasFocus: window.__lab.view.hasFocus() };
  })()`);
  check('入口', '已配置时选区出现 AI 按钮', pickOn.exists === true && pickOn.hidden === false, JSON.stringify(pickOn));

  // ============================== E. 浮标菜单 ==============================
  // The menu used to open pinned to the window corner, because the button was hidden *before* it was
  // measured — a hidden element reports a zero rect. Nothing had ever clicked that button.
  const pillMenu = await run(`(async () => {
    await window.__t.status({ mode: 'direct', hasKey: true });
    window.__lab.view.focus();
    window.__lab.select(${JSON.stringify(SELECTED)});
    await new Promise((r) => setTimeout(r, 300));
    const pill = window.__t.pick();
    if (!pill || pill.hidden) return { menu: false, why: 'no pill' };
    const pillRect = pill.getBoundingClientRect();
    pill.click();
    await new Promise((r) => setTimeout(r, 250));
    const menu = document.querySelector('.popup-menu');
    if (!menu) return { menu: false, why: 'no menu' };
    const rect = menu.getBoundingClientRect();
    return {
      menu: true,
      pill: { left: Math.round(pillRect.left), bottom: Math.round(pillRect.bottom) },
      rect: { left: Math.round(rect.left), top: Math.round(rect.top) },
      padLeft: getComputedStyle(menu.querySelector('.item')).paddingLeft,
      title: menu.querySelector('.menu-title')?.textContent ?? null,
      items: [...menu.querySelectorAll('.item')].map((el) => el.querySelector('.label').textContent),
      pillHidden: window.__t.pick().hidden,
    };
  })()`);
  check('菜单', '菜单紧贴浮标，不跑到窗口角落', pillMenu.menu === true
    && Math.abs(pillMenu.rect.left - pillMenu.pill.left) <= 2
    && Math.abs(pillMenu.rect.top - (pillMenu.pill.bottom + 4)) <= 2, JSON.stringify(pillMenu));
  check('菜单', '点开后浮标让位、菜单带标题', pillMenu.pillHidden === true && pillMenu.title === '改写选中文字', JSON.stringify(pillMenu));
  check('菜单', '没有为空勾选档留白', pillMenu.padLeft === '10px', `padding-left=${pillMenu.padLeft}`);
  check('菜单', '六个技能都在', pillMenu.items?.length === 6 && pillMenu.items[0] === '润色', `${pillMenu.items?.length} 项`);

  // The other menu in the app does carry check marks; its gutter has to survive the change above.
  const toggleMenu = await run(`(async () => {
    const { showMenu } = await import('/ui.js');
    showMenu([{ label: '大纲', checked: true }, { label: '侧栏', checked: false }], { x: 60, y: 60 });
    const menu = document.querySelector('.popup-menu');
    const info = {
      pad: getComputedStyle(menu.querySelector('.item')).paddingLeft,
      classes: menu.className,
      checkedMarked: !!menu.querySelector('.item.checked'),
    };
    menu.remove();
    return info;
  })()`);
  check('菜单', '带勾选的菜单仍留出勾选档', toggleMenu.pad === '28px' && toggleMenu.classes.includes('with-check')
    && toggleMenu.checkedMarked, JSON.stringify(toggleMenu));

  // The window edge is a hard limit — there is no page to scroll — so a menu taller than the window
  // used to lose its tail. It now scrolls inside the room it has, and the last row stays reachable.
  const tallMenu = await run(`(async () => {
    const { showMenu } = await import('/ui.js');
    const items = Array.from({ length: 60 }, (_, i) => ({ label: '第 ' + (i + 1) + ' 项' }));
    showMenu(items, { x: 60, y: 60 });
    const menu = document.querySelector('.popup-menu');
    const box = menu.getBoundingClientRect();
    const scrollable = menu.scrollHeight > menu.clientHeight + 1;
    menu.scrollTop = menu.scrollHeight;
    const rows = menu.querySelectorAll('.item');
    const top = menu.getBoundingClientRect().top;
    const last = rows[rows.length - 1].getBoundingClientRect();
    const info = {
      scrollClass: menu.classList.contains('scroll'),
      fits: box.top >= 0 && box.bottom <= innerHeight + 1,
      scrollable,
      lastVisible: last.bottom <= innerHeight + 1 && last.top >= top - 1,
      height: Math.round(box.height), win: innerHeight,
    };
    menu.remove();
    return info;
  })()`);
  check('菜单', '菜单比窗口高时在窗口内滚动，最后一项够得着', tallMenu.scrollClass === true
    && tallMenu.fits === true && tallMenu.scrollable === true && tallMenu.lastVisible === true,
    JSON.stringify(tallMenu));

  // Same limit at the other edge: a menu pinned near the bottom opens upwards instead of hanging off.
  const flipMenu = await run(`(async () => {
    const { showMenu } = await import('/ui.js');
    showMenu(Array.from({ length: 10 }, (_, i) => ({ label: '项 ' + i })), { x: 60, y: innerHeight - 20 });
    const menu = document.querySelector('.popup-menu');
    const box = menu.getBoundingClientRect();
    const info = {
      top: Math.round(box.top), bottom: Math.round(box.bottom), win: innerHeight,
      origin: menu.style.transformOrigin,
    };
    menu.remove();
    return info;
  })()`);
  check('菜单', '靠窗口底部的菜单往上开，不越界', flipMenu.bottom <= flipMenu.win - 8 && flipMenu.top >= 8
    && flipMenu.origin.includes('bottom'), JSON.stringify(flipMenu));

  // The menu is only useful if picking a row actually starts a rewrite with that skill's wording.
  const viaMenuItem = await run(`(async () => {
    await window.__t.status({ mode: 'direct', hasKey: true });
    window.__lab.view.focus();
    window.__lab.select(${JSON.stringify(SELECTED)});
    await new Promise((r) => setTimeout(r, 300));
    window.__t.pick().click();
    await new Promise((r) => setTimeout(r, 200));
    const polish = [...document.querySelectorAll('.popup-menu .item')]
      .find((el) => el.querySelector('.label').textContent === '润色');
    window.__t.reset();
    polish.click();
    await new Promise((r) => setTimeout(r, 300));
    const call = window.__t.calls('ai_rewrite').pop();
    return {
      proposed: !!document.querySelector('.ai-new'),
      instruction: call?.[1]?.instruction ?? '',
      menuGone: !document.querySelector('.popup-menu'),
    };
  })()`);
  check('菜单', '点「润色」用润色的指令发起改写', viaMenuItem.proposed === true
    && viaMenuItem.instruction.includes('通顺') && viaMenuItem.menuGone, JSON.stringify(viaMenuItem));

  // ============================== F. 提议浮层 ==============================
  // This bar used to show the raw instruction, sit on top of the formatting toolbar, and run past the
  // text column into the side panel — all three visible in one screenshot.
  const longCase = await run(`(async () => {
    window.__stub.rewrite = 'Hello, I am your new assistant. Nice to meet you all. This one is deliberately long.';
    await window.__t.settle();
    window.__lab.setDoc('# 标题\\n\\n晚上好我是你的新助手很高兴认识你，欢迎使用这个编辑器。\\n');
    await new Promise((r) => setTimeout(r, 200));
    window.__lab.select('晚上好我是你的新助手很高兴认识你，欢迎使用这个编辑器。');
    window.__t.reset();
    window.__lab.propose('把这段文字翻译成自然的英文，保留 Markdown 标记。', '译成英文');
    await new Promise((r) => setTimeout(r, 500));
    const bar = document.querySelector('.ai-bar');
    const nu = document.querySelector('.ai-new');
    const old = document.querySelector('.ai-old');
    const tb = document.querySelector('.milkdown-toolbar');
    if (tb) tb.dataset.show = 'true';
    const pick = document.querySelector('.ai-pick');
    if (pick) pick.hidden = false;
    const view = window.__lab.view;
    const col = view.nodeDOM(view.state.doc.resolve(3).before(1)).getBoundingClientRect();
    const r = bar.getBoundingClientRect();
    return {
      note: bar.querySelector('.ai-bar-note')?.textContent,
      noteTitle: bar.querySelector('.ai-bar-note')?.title,
      tag: bar.querySelector('.ai-bar-tag')?.textContent,
      block: nu.classList.contains('ai-new-block'),
      newBelowOld: nu.getBoundingClientRect().top >= old.getBoundingClientRect().bottom - 1,
      insideColumn: r.left >= col.left - 1 && r.right <= col.right + 1,
      toolbar: tb ? getComputedStyle(tb).display : 'missing',
      pick: pick ? getComputedStyle(pick).display : 'missing',
      pending: document.body.classList.contains('ai-pending'),
    };
  })()`);
  check('浮层', '浮动条显示技能名而不是提示词', longCase.note === '译成英文'
    && (longCase.noteTitle ?? '').includes('翻译'), JSON.stringify(longCase));
  check('浮层', '长改写整块显示在新行', longCase.block === true && longCase.newBelowOld === true, JSON.stringify(longCase));
  check('浮层', '浮动条不越出正文列', longCase.insideColumn === true, JSON.stringify(longCase));
  check('浮层', '提议期间格式浮条与 AI 浮标都让位', longCase.pending === true
    && longCase.toolbar === 'none' && longCase.pick === 'none', JSON.stringify(longCase));

  // A proposal that starts at the right end of a long line is where a window-wide clamp shows up: the
  // bar would be pushed to the window edge, over the side panel.
  const edgeCase = await run(`(async () => {
    window.__stub.rewrite = '更短的结尾。';
    await window.__t.settle();
    const filler = '这一段很长，用来把正文折成好几行，方便检查浮动条会不会越出正文列跑到侧栏里去。';
    window.__lab.setDoc('# 标题\\n\\n' + filler + filler + filler + '\\n');
    await new Promise((r) => setTimeout(r, 250));
    const view = window.__lab.view;
    // Resolve the paragraph by walking the document: position 3 can land in the heading instead.
    let paragraphPos = -1;
    let paragraphNode = null;
    view.state.doc.descendants((node, pos) => {
      if (paragraphNode) return false;
      if (node.type.name === 'paragraph') { paragraphPos = pos; paragraphNode = node; return false; }
      return true;
    });
    const start = paragraphPos + 1;
    const end = start + paragraphNode.content.size;
    const col = view.nodeDOM(paragraphPos).getBoundingClientRect();
    // Find a position that sits close to the right edge and still has room for a few characters.
    let from = -1;
    for (let pos = start + 6; pos < end - 8; pos++) {
      if (view.coordsAtPos(pos).left > col.right - 120) { from = pos; break; }
    }
    if (from < 0) return { found: false };
    view.dispatch(view.state.tr.setSelection(window.__lab.TextSelection.create(view.state.doc, from, from + 8)));
    window.__lab.propose('改得更简洁', '精简');
    await new Promise((r) => setTimeout(r, 400));
    const bar = document.querySelector('.ai-bar');
    const r = bar.getBoundingClientRect();
    return {
      found: true,
      from,
      anchorLeft: Math.round(view.coordsAtPos(from).left),
      bar: { left: Math.round(r.left), right: Math.round(r.right) },
      column: { left: Math.round(col.left), right: Math.round(col.right) },
      inside: r.right <= col.right + 1 && r.left >= col.left - 1,
    };
  })()`);
  check('浮层', '贴着右端发起时浮动条也不越出正文列', edgeCase.found === true && edgeCase.inside === true,
    JSON.stringify(edgeCase));

  // A block proposal is still a normal replace: accepting must write exactly the new text once.
  const longAccept = await run(`(async () => {
    window.__stub.rewrite = 'Hello, I am your new assistant. This sentence is deliberately long enough to need its own block.';
    await window.__t.settle();
    window.__lab.setDoc('# 标题\\n\\n晚上好我是你的新助手很高兴认识你，欢迎使用这个编辑器。\\n');
    await new Promise((r) => setTimeout(r, 200));
    window.__lab.select('晚上好我是你的新助手很高兴认识你，欢迎使用这个编辑器。');
    window.__lab.propose('把这段文字翻译成自然的英文，保留 Markdown 标记。', '译成英文');
    await new Promise((r) => setTimeout(r, 400));
    const block = !!document.querySelector('.ai-new-block');
    document.querySelector('.ai-bar button[data-act="accept"]').click();
    await new Promise((r) => setTimeout(r, 200));
    const md = window.__lab.md();
    window.__t.undo();
    await new Promise((r) => setTimeout(r, 150));
    const back = window.__lab.md();
    return {
      block,
      wrote: md.includes('Hello, I am your new assistant.') && !md.includes('晚上好'),
      once: (md.match(/Hello/g) || []).length === 1,
      restored: back.includes('晚上好我是你的新助手'),
      deco: !!document.querySelector('.ai-new') || !!document.querySelector('.ai-old'),
    };
  })()`);
  check('浮层', '整块提议采纳后原文被替换、一次撤销复原', longAccept.block === true
    && longAccept.wrote === true && longAccept.once === true && longAccept.restored === true
    && longAccept.deco === false, JSON.stringify(longAccept));

  const shortCase = await run(`(async () => {
    window.__stub.rewrite = '更短的一句。';
    await window.__t.settle();
    window.__lab.setDoc('# 标题\\n\\n第二段文字，需要被改写。\\n');
    await new Promise((r) => setTimeout(r, 200));
    window.__lab.select('第二段文字，需要被改写。');
    window.__lab.propose('删掉冗余和重复的表述，但不要丢掉任何信息。', '精简');
    await new Promise((r) => setTimeout(r, 400));
    const nu = document.querySelector('.ai-new');
    const old = document.querySelector('.ai-old');
    const inline = !nu.classList.contains('ai-new-block')
      && Math.abs(nu.getBoundingClientRect().top - old.getBoundingClientRect().top) <= 2;
    document.querySelector('.ai-bar button[data-act="reject"]').click();
    await new Promise((r) => setTimeout(r, 200));
    return {
      inline,
      pending: document.body.classList.contains('ai-pending'),
      deco: !!document.querySelector('.ai-new') || !!document.querySelector('.ai-old'),
      bar: !!document.querySelector('.ai-bar'),
    };
  })()`);
  check('浮层', '短改写仍在行内', shortCase.inline === true, JSON.stringify(shortCase));
  check('浮层', '拒绝后浮层状态复原', shortCase.pending === false
    && shortCase.deco === false && shortCase.bar === false, JSON.stringify(shortCase));

  // ============================== G. 多段选择 ==============================
  // Two paragraphs, one rewrite. The old text is marked per block (a node decoration can only cover
  // exactly one node) and the replacement sits after the last of them.
  await fresh();
  const multiCase = await run(`(async () => {
    window.__lab.setDoc('# 标题\\n\\n第一段，需要改。\\n\\n第二段，也要改。\\n\\n第三段，不动。\\n');
    await new Promise((r) => setTimeout(r, 250));
    window.__stub.rewrite = '合并之后的一段新文字。';
    window.__t.reset();
    window.__lab.selectBlocks(1, 2);
    const before = window.__lab.md();
    window.__lab.propose('精简', '精简');
    await new Promise((r) => setTimeout(r, 500));
    const nu = document.querySelector('.ai-new');
    return {
      before,
      after: window.__lab.md(),
      text: window.__t.calls('ai_rewrite')[0]?.[1]?.text,
      oldBlocks: document.querySelectorAll('.ai-old-block').length,
      newText: nu?.textContent,
      block: !!nu && nu.classList.contains('ai-new-block'),
      struck: !!nu && !!nu.closest('.ai-old-block'),
      bar: !!document.querySelector('.ai-bar'),
    };
  })()`);
  check('多段', '两段一次请求，正文按换行拼接', multiCase.text === '第一段，需要改。\n第二段，也要改。',
    JSON.stringify(multiCase.text));
  check('多段', '两段都被标记为待替换', multiCase.oldBlocks === 2, `${multiCase.oldBlocks} 段`);
  check('多段', '新文整块，且不在划线范围内', multiCase.block === true && multiCase.struck === false,
    JSON.stringify({ block: multiCase.block, struck: multiCase.struck }));
  check('多段', '提议期间文档不变', multiCase.after === multiCase.before, multiCase.after.slice(0, 40));

  const multiAccept = await run(`(async () => {
    window.__lab.accept(window.__lab.proposals()[0].id);
    await new Promise((r) => setTimeout(r, 200));
    const md = window.__lab.md();
    const deco = !!document.querySelector('.ai-old-block') || !!document.querySelector('.ai-new');
    window.__t.undo();
    await new Promise((r) => setTimeout(r, 200));
    return { md, deco, back: window.__lab.md() };
  })()`);
  check('多段', '采纳后两段合成一段', multiAccept.md === '# 标题\n\n合并之后的一段新文字。\n\n第三段，不动。\n',
    multiAccept.md);
  check('多段', '采纳后对照消失', multiAccept.deco === false);
  check('多段', '一次撤销恢复两段', multiAccept.back === multiCase.before, multiAccept.back.slice(0, 40));

  const multiLines = await run(`(async () => {
    window.__lab.setDoc('# 标题\\n\\n第一段，需要改。\\n\\n第二段，也要改。\\n');
    await new Promise((r) => setTimeout(r, 250));
    window.__stub.rewrite = '第一行。\\n第二行。';
    window.__lab.selectBlocks(1, 2);
    window.__lab.propose('分段', '分段');
    await new Promise((r) => setTimeout(r, 400));
    window.__lab.accept(window.__lab.proposals()[0].id);
    await new Promise((r) => setTimeout(r, 200));
    const blocks = [];
    window.__lab.view.state.doc.forEach((n) => blocks.push(n.type.name + ':' + n.textContent));
    const md = window.__lab.md();
    window.__t.undo();
    await new Promise((r) => setTimeout(r, 200));
    return { blocks, md, back: window.__lab.md() };
  })()`);
  check('多段', '多行结果拆成多个段落', JSON.stringify(multiLines.blocks) === '["heading:标题","paragraph:第一行。","paragraph:第二行。"]',
    JSON.stringify(multiLines.blocks));
  check('多段', '多段落采纳也能一次撤销', multiLines.back === '# 标题\n\n第一段，需要改。\n\n第二段，也要改。\n', multiLines.back);

  // ============================== H. 逐段改写与审阅清单 ==============================
  await fresh();
  const batch = await run(`(async () => {
    window.__lab.setDoc('# 标题\\n\\n甲段。\\n\\n乙段。\\n\\n丙段。\\n');
    await new Promise((r) => setTimeout(r, 250));
    window.__stub.rewrite = '改好了。';
    window.__t.reset();
    window.__lab.selectBlocks(1, 3);
    const before = window.__lab.md();
    window.__lab.proposeEach('润色', '润色');
    await new Promise((r) => setTimeout(r, 900));
    const rows = [...document.querySelectorAll('.ai-review-row')];
    return {
      calls: window.__t.calls('ai_rewrite').length,
      requests: window.__t.calls('ai_rewrite').map((c) => c[1].text),
      proposals: window.__lab.proposals().length,
      rows: rows.length,
      count: document.querySelector('.ai-review-count')?.textContent,
      olds: rows.map((r) => r.querySelector('.ai-review-old').textContent),
      bar: !!document.querySelector('.ai-bar'),
      before,
      after: window.__lab.md(),
    };
  })()`);
  check('审阅', '每段一次请求', batch.calls === 3 && JSON.stringify(batch.requests) === '["甲段。","乙段。","丙段。"]',
    JSON.stringify(batch.requests));
  check('审阅', '清单列出 3 条，顺序与正文一致', batch.rows === 3 && batch.count === '3'
    && JSON.stringify(batch.olds) === '["甲段。","乙段。","丙段。"]', JSON.stringify({ rows: batch.rows, olds: batch.olds }));
  check('审阅', '批量的建议期间文档不变、不弹单条浮动条', batch.after === batch.before && batch.bar === false,
    JSON.stringify({ same: batch.after === batch.before, bar: batch.bar }));

  const settleOne = await run(`(async () => {
    document.querySelectorAll('.ai-review-row')[0].querySelector('[data-act="accept"]').click();
    await new Promise((r) => setTimeout(r, 250));
    const list = window.__lab.proposals();
    return {
      left: list.length,
      rows: document.querySelectorAll('.ai-review-row').length,
      source: list[0]?.source,
      md: window.__lab.md(),
    };
  })()`);
  check('审阅', '采纳第一条后清单少一条', settleOne.left === 2 && settleOne.rows === 2, JSON.stringify(settleOne));
  check('审阅', '后面的建议仍指向自己那段', settleOne.source === '乙段。', JSON.stringify(settleOne.source));
  check('审阅', '采纳只改自己那一段', settleOne.md === '# 标题\n\n改好了。\n\n乙段。\n\n丙段。\n', settleOne.md);

  const settleReject = await run(`(async () => {
    document.querySelectorAll('.ai-review-row')[0].querySelector('[data-act="reject"]').click();
    await new Promise((r) => setTimeout(r, 250));
    return {
      left: window.__lab.proposals().length,
      md: window.__lab.md(),
      panel: !!document.querySelector('.ai-review'),
      bar: !!document.querySelector('.ai-bar'),
    };
  })()`);
  check('审阅', '拒绝后那段保持原样', settleReject.md === '# 标题\n\n改好了。\n\n乙段。\n\n丙段。\n', settleReject.md);
  check('审阅', '只剩一条时收起清单、换回浮动条', settleReject.left === 1 && settleReject.panel === false && settleReject.bar === true,
    JSON.stringify(settleReject));

  const acceptAll = await run(`(async () => {
    window.__lab.setDoc('# 标题\\n\\n甲段。\\n\\n乙段。\\n\\n丙段。\\n');
    await new Promise((r) => setTimeout(r, 250));
    window.__lab.selectBlocks(1, 3);
    window.__lab.proposeEach('润色', '润色');
    await new Promise((r) => setTimeout(r, 900));
    window.__lab.acceptAll();
    await new Promise((r) => setTimeout(r, 250));
    const md = window.__lab.md();
    const panel = !!document.querySelector('.ai-review');
    window.__t.undo();
    await new Promise((r) => setTimeout(r, 250));
    return { md, panel, back: window.__lab.md() };
  })()`);
  check('审阅', '全部采纳写入每一段', acceptAll.md === '# 标题\n\n改好了。\n\n改好了。\n\n改好了。\n', acceptAll.md);
  check('审阅', '全部采纳后清单消失', acceptAll.panel === false);
  check('审阅', '全部采纳也是一次撤销', acceptAll.back === '# 标题\n\n甲段。\n\n乙段。\n\n丙段。\n', acceptAll.back);

  const rejectAll = await run(`(async () => {
    window.__lab.setDoc('# 标题\\n\\n甲段。\\n\\n乙段。\\n\\n丙段。\\n');
    await new Promise((r) => setTimeout(r, 250));
    window.__lab.selectBlocks(1, 3);
    window.__lab.proposeEach('润色', '润色');
    await new Promise((r) => setTimeout(r, 900));
    document.querySelector('[data-act="none"]').click();
    await new Promise((r) => setTimeout(r, 250));
    return {
      md: window.__lab.md(),
      proposals: window.__lab.proposals().length,
      panel: !!document.querySelector('.ai-review'),
      deco: !!document.querySelector('.ai-old') || !!document.querySelector('.ai-new'),
    };
  })()`);
  check('审阅', '全部拒绝不留痕迹', rejectAll.md === '# 标题\n\n甲段。\n\n乙段。\n\n丙段。\n'
    && rejectAll.proposals === 0 && rejectAll.panel === false && rejectAll.deco === false, JSON.stringify(rejectAll));

  // The batch has to be reachable: a multi-paragraph selection adds one row to the ordinary menu.
  const eachEntry = await run(`(async () => {
    window.__lab.setDoc('# 标题\\n\\n甲段。\\n\\n乙段。\\n\\n丙段。\\n');
    await new Promise((r) => setTimeout(r, 250));
    await window.__t.status({ mode: 'direct', hasKey: true });
    window.__lab.view.focus();
    window.__lab.selectBlocks(1, 3);
    await new Promise((r) => setTimeout(r, 300));
    const pill = window.__t.pick();
    if (!pill || pill.hidden) return { why: 'no pill' };
    pill.click();
    await new Promise((r) => setTimeout(r, 250));
    const labels = [...document.querySelectorAll('.popup-menu .item .label')].map((el) => el.textContent);
    const batch = [...document.querySelectorAll('.popup-menu .item')].find((el) => el.textContent.includes('逐段改写'));
    batch?.click();
    await new Promise((r) => setTimeout(r, 250));
    const title = document.querySelector('.popup-menu .menu-title')?.textContent ?? null;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return { labels, title };
  })()`);
  check('审阅', '多段选中时菜单里有逐段改写入口', eachEntry.labels?.some((label) => label.startsWith('逐段改写（3 段）'))
    && eachEntry.title === '逐段改写：选一个技能', JSON.stringify(eachEntry));

  const singleNoPanel = await run(`(async () => {    window.__lab.setDoc('# 标题\\n\\n只有一段。\\n');
    await new Promise((r) => setTimeout(r, 250));
    window.__lab.select('只有一段。');
    window.__lab.propose('润色', '润色');
    await new Promise((r) => setTimeout(r, 400));
    return { panel: !!document.querySelector('.ai-review'), bar: !!document.querySelector('.ai-bar') };
  })()`);
  check('审阅', '单条建议不弹清单', singleNoPanel.panel === false && singleNoPanel.bar === true, JSON.stringify(singleNoPanel));

  // ============================== I. 斜杠命令 ==============================
  // A slash command can only be typed in a block of its own, so it rewrites the paragraph above.
  const slashRun = await run(`(async () => {
    window.__lab.setDoc('# 标题\\n\\n上一段要改的文字。\\n\\n/润色\\n');
    await new Promise((r) => setTimeout(r, 250));
    window.__stub.rewrite = '改好的上一段。';
    window.__t.reset();
    const view = window.__lab.view;
    view.dispatch(view.state.tr.setSelection(window.__lab.TextSelection.near(view.state.doc.resolve(view.state.doc.content.size - 1))));
    const items = window.__lab.slash();
    items.find((item) => item.label.startsWith('润色')).run(view);
    await new Promise((r) => setTimeout(r, 500));
    return {
      labels: items.map((item) => item.label),
      text: window.__t.calls('ai_rewrite')[0]?.[1]?.text,
      md: window.__lab.md(),
      newText: document.querySelector('.ai-new')?.textContent,
    };
  })()`);
  check('斜杠', '六个技能都进了斜杠菜单', slashRun.labels.length === 6 && slashRun.labels[0].startsWith('润色'),
    JSON.stringify(slashRun.labels));
  check('斜杠', '命令改的是上一段', slashRun.text === '上一段要改的文字。', JSON.stringify(slashRun.text));
  check('斜杠', '命令文字不留在文档里', !slashRun.md.includes('/润色') && slashRun.newText === '改好的上一段。', slashRun.md);

  // The menu itself, not just the item list: the group has to be there when a real slash is typed.
  const slashMenu = await run(`(async () => {
    window.__lab.setDoc('# 标题\\n\\n上一段要改的文字。\\n');
    await new Promise((r) => setTimeout(r, 300));
    window.__stub.rewrite = '改好的上一段。';
    window.__t.reset();
    const view = window.__lab.view;
    const end = view.state.doc.content.size - 1;
    view.dispatch(view.state.tr.setSelection(window.__lab.TextSelection.near(view.state.doc.resolve(end))));
    view.dispatch(view.state.tr.split(view.state.selection.from));
    view.dispatch(view.state.tr.insertText('/'));
    await new Promise((r) => setTimeout(r, 700));
    const menu = document.querySelector('.milkdown-slash-menu');
    const shown = menu?.dataset.show === 'true';
    const groups = menu ? [...menu.querySelectorAll('h6')].map((h) => h.textContent) : [];
    const item = menu && [...menu.querySelectorAll('li[data-index]')].find((el) => el.textContent.includes('润色（上一段）'));
    item?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    return {
      shown,
      groups,
      found: !!item,
      text: window.__t.calls('ai_rewrite')[0]?.[1]?.text,
      newText: document.querySelector('.ai-new')?.textContent,
    };
  })()`);
  check('斜杠', '输入 / 后菜单里有 AI 改写分组', slashMenu.shown === true && slashMenu.groups.includes('AI 改写'),
    JSON.stringify(slashMenu.groups));
  check('斜杠', '点菜单项就改上一段', slashMenu.found === true && slashMenu.text === '上一段要改的文字。'
    && slashMenu.newText === '改好的上一段。', JSON.stringify(slashMenu));

  const slashEmpty = await run(`(async () => {
    window.__lab.setDoc('/润色\\n');
    await new Promise((r) => setTimeout(r, 250));
    window.__t.reset();
    const view = window.__lab.view;
    // A slash command is always typed with the caret at the end of its own block.
    view.dispatch(view.state.tr.setSelection(window.__lab.TextSelection.near(view.state.doc.resolve(view.state.doc.content.size - 1))));
    window.__lab.slash()[0].run(view);
    await new Promise((r) => setTimeout(r, 250));
    return { toast: window.__t.toast(), calls: window.__t.calls('ai_rewrite').length, md: window.__lab.md() };
  })()`);
  check('斜杠', '上面没有段落时说明并清掉命令', slashEmpty.toast === '上面没有可以改写的段落'
    && slashEmpty.calls === 0 && !slashEmpty.md.includes('/润色'), JSON.stringify(slashEmpty));

  const slashOff = await run(`(async () => {
    await window.__t.status({ mode: 'none', hasKey: false });
    return window.__lab.slash().length;
  })()`);
  check('斜杠', '没配置时斜杠菜单里没有 AI 项', slashOff === 0, `${slashOff} 项`);

  // ============================== J. 自定义指令 ==============================
  await fresh();
  const customOpen = await run(`(async () => {
    await window.__t.status({ mode: 'direct', hasKey: true, custom: [{ label: '公文', instruction: '按公文格式改写' }] });
    (await import('/ai-settings.js')).openAiSettings();
    await new Promise((r) => setTimeout(r, 250));
    const rows = [...document.querySelectorAll('.ai-custom-row')];
    return {
      rows: rows.length,
      values: rows.map((row) => [row.querySelector('.ai-custom-label').value, row.querySelector('.ai-custom-rule').value]),
      addHidden: document.querySelector('.ai-custom-add').hidden,
      // The panel has to teach by example: someone opening it cold has no idea what goes in the box.
      eg: document.querySelector('.ai-custom-eg')?.textContent ?? '',
      labelHint: rows[0]?.querySelector('.ai-custom-label').placeholder ?? '',
      ruleHint: rows[0]?.querySelector('.ai-custom-rule').placeholder ?? '',
    };
  })()`);
  check('自定义', '打开面板回填已存的指令', customOpen.rows === 1
    && JSON.stringify(customOpen.values) === '[["公文","按公文格式改写"]]', JSON.stringify(customOpen));
  check('自定义', '面板里带着可以照着抄的例子', customOpen.eg.includes('公文')
    && customOpen.eg.includes('怎么改') && customOpen.ruleHint.includes('例如'), JSON.stringify({
    eg: customOpen.eg, labelHint: customOpen.labelHint, ruleHint: customOpen.ruleHint,
  }));

  const customSave = await run(`(async () => {
    window.__t.reset();
    document.querySelector('.ai-custom-add').click();
    const row = document.querySelectorAll('.ai-custom-row')[1];
    row.querySelector('.ai-custom-label').value = '更直接';
    row.querySelector('.ai-custom-rule').value = '不要客套话，直接说结论';
    document.querySelector('.ai-save').click();
    await new Promise((r) => setTimeout(r, 350));
    return {
      call: window.__t.calls('ai_configure').pop()?.[1]?.custom ?? null,
      status: window.__lab.status().custom,
    };
  })()`);
  check('自定义', '保存时带上全部指令', JSON.stringify(customSave.call) === '[{"label":"公文","instruction":"按公文格式改写"},{"label":"更直接","instruction":"不要客套话，直接说结论"}]',
    JSON.stringify(customSave.call));
  check('自定义', '保存后状态里能读到', Array.isArray(customSave.status) && customSave.status.length === 2,
    JSON.stringify(customSave.status));

  const customDelete = await run(`(async () => {
    (await import('/ai-settings.js')).openAiSettings();
    await new Promise((r) => setTimeout(r, 200));
    window.__t.reset();
    document.querySelectorAll('.ai-custom-row')[0].querySelector('.ai-custom-drop').click();
    document.querySelector('.ai-save').click();
    await new Promise((r) => setTimeout(r, 350));
    return window.__t.calls('ai_configure').pop()?.[1]?.custom ?? null;
  })()`);
  check('自定义', '删掉一行后不再发送', JSON.stringify(customDelete) === '[{"label":"更直接","instruction":"不要客套话，直接说结论"}]',
    JSON.stringify(customDelete));

  const customMenu = await run(`(async () => {
    const { skillCommands } = await import('/ai-skills.js');
    const titles = skillCommands(window.__lab.view).map((c) => c.title);
    return { skills: window.__lab.skills(), titles, slash: window.__lab.slash().map((i) => i.label) };
  })()`);
  check('自定义', '自定义指令出现在技能表与命令面板', JSON.stringify(customMenu.skills.map((s) => s.label)).includes('更直接')
    && customMenu.titles.some((t) => t.includes('更直接')), JSON.stringify(customMenu.titles));
  check('自定义', '自定义指令也进斜杠菜单', customMenu.slash.some((l) => l.startsWith('更直接')), JSON.stringify(customMenu.slash));

  const customCap = await run(`(async () => {
    await window.__t.status({ custom: [{ label: 'a', instruction: 'A' }, { label: 'b', instruction: 'B' }, { label: 'c', instruction: 'C' }] });
    (await import('/ai-settings.js')).openAiSettings();
    await new Promise((r) => setTimeout(r, 220));
    return { rows: document.querySelectorAll('.ai-custom-row').length, addHidden: document.querySelector('.ai-custom-add').hidden };
  })()`);
  check('自定义', '满 3 条后不再显示添加', customCap.rows === 3 && customCap.addHidden === true, JSON.stringify(customCap));
  await run(`(async () => { (await import('/ai-settings.js')).openAiSettings(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()`);
  await sleep(120);

  // ============================== W. 导出 Word ==============================
  const DOCX_DOC = [
    '# 测试标题',
    '',
    '正文里有一段**加粗**和 `行内代码`，还有 [链接](https://example.com)。',
    '',
    '- 甲项文字',
    '- 乙项文字',
    '',
    '1. 第一项',
    '2. 第二项',
    '',
    '- [x] 已完成的事',
    '- [ ] 未完成的事',
    '',
    '> 引用的一句话。',
    '',
    '```js',
    'const a = 1;',
    '```',
    '',
    '| 列一 | 列二 |',
    '| --- | --- |',
    '| 格一 | 格二 |',
    '',
  ].join('\n');
  await run(`(async () => {
    window.__lab.setDoc(${JSON.stringify(DOCX_DOC)});
    await new Promise((r) => setTimeout(r, 400));
  })()`);
  const docx = await run(`window.__lab.docx()`);
  const { writeFileSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const docPath = fileURLToPath(new URL('./.export-test.docx', import.meta.url));
  let parts = { names: [], document: '', error: '' };
  try {
    writeFileSync(docPath, Buffer.from(docx.base64, 'base64'));
    const script = [
      'import json, sys, zipfile',
      'z = zipfile.ZipFile(sys.argv[1])',
      'names = z.namelist()',
      "doc = z.read('word/document.xml').decode('utf-8')",
      'print(json.dumps({"names": names, "document": doc}))',
    ].join('\n');
    const out = spawnSync('python3', ['-c', script, docPath], { encoding: 'utf8' });
    parts = out.stdout ? JSON.parse(out.stdout) : { names: [], document: '', error: out.stderr };
  } catch (error) {
    parts.error = String(error);
  } finally {
    try {
      (await import('node:fs')).unlinkSync(docPath);
    } catch {
      // The file only exists when the write above succeeded.
    }
  }
  check('Word', '导出的是合法的 .docx 包', parts.names.includes('word/document.xml')
    && parts.names.includes('[Content_Types].xml'), parts.error || `${docx.size} 字节 / ${parts.names.length} 个部件`);
  check('Word', '标题用 Word 的标题样式', String(parts.document).includes('Heading1'));
  check('Word', '列表是真编号，改名会自动重排', parts.names.includes('word/numbering.xml') && String(parts.document).includes('numPr'));
  check('Word', '加粗、行内代码、超链接都在', ['<w:b/>', 'w:hyperlink', '行内代码'].every((bit) => String(parts.document).includes(bit))
    || ['<w:b/>', 'w:hyperlink', '行内代码'].filter((bit) => String(parts.document).includes(bit)).length >= 2,
    ['<w:b/>', 'w:hyperlink', '行内代码'].map((bit) => `${bit}:${String(parts.document).includes(bit)}`).join(' '));
  check('Word', '代码块与表格保留内容', String(parts.document).includes('const a = 1;') && String(parts.document).includes('w:tbl')
    && String(parts.document).includes('格一'));

  // ============================== X. 外观与设置 ==============================
  // Theme colours are chosen in CSS from <html data-theme>, so switching must never need a reload or
  // an editor remount. The panel is driven with fakes: it takes its dependencies as arguments, so
  // nothing here has to stand in for the whole app.
  await fresh();

  const themeEngine = await run(`(async () => {
    const theme = await import('/theme.js');
    const root = document.documentElement;
    const bg = () => getComputedStyle(root).getPropertyValue('--app-bg').trim();
    const lightBg = bg();
    theme.setTheme('dark');
    const dark = {
      attr: root.dataset.theme,
      colorScheme: root.style.colorScheme,
      bg: bg(),
      stored: window.__stub.calls.filter((c) => c[0] === 'set_setting').pop()?.[1] ?? null,
      mirror: localStorage.getItem('mdpad-theme'),
      // The editor's code colours are variables too, so an open editor follows along.
      codeVar: getComputedStyle(root).getPropertyValue('--cm-keyword').trim(),
    };
    theme.setTheme('light');
    const back = { attr: root.dataset.theme, bg: bg() };
    theme.setTheme('system');
    return { dark, back, lightBg, systemDark: theme.resolveTheme('system', true), systemLight: theme.resolveTheme('system', false) };
  })()`);
  check('外观', '切到深色：属性、原生配色、底色一起变', themeEngine.dark.attr === 'dark'
    && themeEngine.dark.colorScheme === 'dark' && themeEngine.dark.bg !== themeEngine.lightBg,
    JSON.stringify(themeEngine.dark));
  check('外观', '主题写进设置，也镜像一份给首屏', themeEngine.dark.stored?.key === 'theme'
    && themeEngine.dark.stored?.value === 'dark' && themeEngine.dark.mirror === 'dark',
    JSON.stringify(themeEngine.dark.stored));
  check('外观', '代码块颜色跟着走同一套变量', themeEngine.dark.codeVar === '#ff7b72', themeEngine.dark.codeVar);
  check('外观', '切回浅色不残留', themeEngine.back.attr === 'light' && themeEngine.back.bg === themeEngine.lightBg,
    JSON.stringify(themeEngine.back));
  check('外观', '跟随系统按系统偏好解析', themeEngine.systemDark === 'dark' && themeEngine.systemLight === 'light',
    `${themeEngine.systemDark}/${themeEngine.systemLight}`);

  const panel = await run(`(async () => {
    const { openSettings } = await import('/settings.js');
    const calls = [];
    const close = openSettings({
      settings: { sidebar: true, outline: false },
      setPanel: (name, value) => calls.push(['panel', name, value]),
      run: (id) => calls.push(['run', id]),
      version: '3.4.2',
      update: () => Promise.resolve({
        currentVersion: '3.4.2',
        lastChecked: Date.now() - 7 * 60 * 60 * 1000,
        lastError: null,
        availableVersion: '3.5.0',
      }),
    });
    await new Promise((r) => setTimeout(r, 150));
    const overlay = document.querySelector('.settings-overlay');
    const themes = [...overlay.querySelectorAll('.theme-choice button')].map((b) => ({ label: b.textContent, on: b.classList.contains('on') }));
    const thumbBefore = overlay.querySelector('.theme-choice .thumb').style.transform;
    overlay.querySelector('.theme-choice button[data-theme="dark"]').click();
    const afterPick = {
      attr: document.documentElement.dataset.theme,
      thumb: overlay.querySelector('.theme-choice .thumb').style.transform,
      on: [...overlay.querySelectorAll('.theme-choice button.on')].map((b) => b.dataset.theme),
    };
    const outline = overlay.querySelector('.opt-outline');
    outline.checked = true;
    outline.dispatchEvent(new Event('change', { bubbles: true }));
    const info = {
      headings: [...overlay.querySelectorAll('section:not([hidden]) h3')].map((h) => h.textContent),
      themes, thumbBefore, afterPick,
      ai: overlay.querySelector('.ai-state').textContent,
      version: overlay.querySelector('.version').textContent,
      updateState: overlay.querySelector('.update-state').textContent,
      calls,
    };
    overlay.querySelector('.settings-close').click();
    return { ...info, closed: !document.querySelector('.settings-overlay') };
  })()`);
  check('设置', '四段内容：外观 / 界面 / 写作 / 关于', JSON.stringify(panel.headings) === '["外观","界面","写作","关于"]',
    JSON.stringify(panel.headings));
  check('设置', '主题三选一，初始停在跟随系统', panel.themes.map((t) => t.label).join('/') === '跟随系统/浅色/深色'
    && panel.themes[0].on === true, JSON.stringify(panel.themes));
  check('设置', '面板里点深色立刻生效，滑块跟上', panel.afterPick.attr === 'dark'
    && panel.afterPick.on.join() === 'dark' && panel.afterPick.thumb === 'translateX(200%)',
    JSON.stringify(panel.afterPick));
  check('设置', '面板开关走应用自己的面板开关', panel.calls.some((c) => c[0] === 'panel' && c[1] === 'outline' && c[2] === true),
    JSON.stringify(panel.calls));
  check('设置', 'AI 一行说明当前状态，不重复表单', panel.ai.includes('已配置') && panel.ai.includes('test-model'), panel.ai);
  check('设置', '关于里读得到版本号', panel.version === '3.4.2', panel.version);
  check('设置', '关于里说明上次检查更新查到了什么',
    panel.updateState.includes('7 小时前') && panel.updateState.includes('发现 3.5.0'), panel.updateState);
  check('设置', '关闭按钮收掉面板', panel.closed === true);

  const updateFail = await run(`(async () => {
    const { openSettings } = await import('/settings.js');
    openSettings({
      settings: { sidebar: true, outline: false },
      setPanel() {}, run() {}, version: '3.4.2',
      update: () => Promise.resolve({
        currentVersion: '3.4.2',
        lastChecked: Date.now() - 3 * 24 * 60 * 60 * 1000,
        lastError: '暂时无法获取更新信息，请稍后再试',
        availableVersion: null,
      }),
    });
    await new Promise((r) => setTimeout(r, 120));
    const overlay = document.querySelector('.settings-overlay');
    const text = overlay.querySelector('.update-state').textContent;
    overlay.querySelector('.settings-close').click();
    return text;
  })()`);
  check('设置', '自动检查失败也在「关于」里说明原因',
    updateFail.includes('没成功') && updateFail.includes('请稍后再试'), updateFail);

  const voiceSetup = await run(`(async () => {
    const { openSettings } = await import('/settings.js');
    const { openVoiceSettings } = await import('/voice-settings.js');
    const saved = [];
    const runs = [];
    const voice = {
      status: async () => ({
        baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/SenseVoiceSmall',
        hasKey: false, ready: false, borrowed: false, aiHost: 'api.deepseek.com', sameService: false,
      }),
      configure: async (options) => {
        saved.push(options);
        return {
          baseUrl: options.baseUrl, model: options.model,
          hasKey: Boolean(options.apiKey), ready: Boolean(options.apiKey),
          borrowed: false, aiHost: 'api.deepseek.com', sameService: false,
        };
      },
      test: async () => 'Key 可用 · FunAudioLLM/SenseVoiceSmall',
    };
    const out = { saved };
    // ① 设置里只留一行摘要 + 入口，表单搬进自己的面板
    openSettings({ settings: { sidebar: true, outline: false }, setPanel() {}, run: (id) => runs.push(id), version: '3.4.2', voice });
    await new Promise((r) => setTimeout(r, 160));
    const overlay = document.querySelector('.settings-overlay');
    const row = overlay.querySelector('.voice-section');
    out.row = {
      headings: [...overlay.querySelectorAll('section:not([hidden]) h3')].map((h) => h.textContent),
      state: row.querySelector('.voice-state').textContent,
      inputs: row.querySelectorAll('input').length,
      button: row.querySelector('.opt-voice')?.textContent,
    };
    row.querySelector('.opt-voice').click();
    await new Promise((r) => setTimeout(r, 140));
    out.row.runs = runs;
    out.row.closed = !document.querySelector('.settings-overlay');
    // ② 语音面板与 AI 面板同版式
    const openPanel = async (status) => {
      document.querySelector('.voice-overlay')?.remove();
      openVoiceSettings({ voice: { ...voice, status: async () => status } });
      await new Promise((r) => setTimeout(r, 160));
      return document.querySelector('.voice-overlay .ai-panel');
    };
    const panel = await openPanel({ ...(await voice.status()) });
    const $ = (sel) => panel.querySelector(sel);
    out.panel = {
      title: $('h2').textContent,
      fields: [...panel.querySelectorAll('.ai-row > span')].map((e) => e.textContent),
      provider: $('.voice-provider').value,
      base: $('.voice-base').value,
      model: $('.voice-model').value,
      hint: $('.voice-hint').hidden ? '' : $('.voice-hint').textContent,
      actions: [...panel.querySelectorAll('.ai-footer button')].map((b) => b.textContent),
    };
    // ③ 换服务商自动填地址与模型
    $('.voice-provider').value = 'openai';
    $('.voice-provider').dispatchEvent(new Event('change', { bubbles: true }));
    out.switch = { base: $('.voice-base').value, model: $('.voice-model').value };
    // ④ 填 Key 保存：写回并关面板
    $('.voice-key').value = 'sk-voice';
    $('.voice-save').click();
    await new Promise((r) => setTimeout(r, 900));
    out.save = { last: saved.at(-1), closed: !document.querySelector('.voice-overlay') };
    // ⑤ 验证 Key：先把刚填的存下来，再用新 Key 去验
    const verify = await openPanel({ ...(await voice.status()) });
    verify.querySelector('.voice-key').value = 'sk-verify';
    verify.querySelector('.voice-test').click();
    await new Promise((r) => setTimeout(r, 260));
    out.verify = { last: saved.at(-1), result: verify.querySelector('.ai-result').textContent };
    verify.querySelector('.voice-cancel').click();
    // ⑥ 取消不写：Esc 关掉刚填的内容不落盘
    const before = saved.length;
    const esc = await openPanel({ ...(await voice.status()) });
    esc.querySelector('.voice-key').value = 'sk-discard';
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 160));
    out.esc = { extra: saved.length - before, closed: !document.querySelector('.voice-overlay') };
    // ⑦ 借 Key 与「不同家」的摘要要说清
    openSettings({ settings: { sidebar: true, outline: false }, setPanel() {}, run() {}, version: '3.4.2',
      voice: { ...voice, status: async () => ({ ...(await voice.status()), ready: true, borrowed: true, aiHost: 'api.siliconflow.cn', sameService: true }) } });
    await new Promise((r) => setTimeout(r, 140));
    out.borrowed = document.querySelector('.settings-overlay .voice-state').textContent;
    document.querySelector('.settings-overlay').remove();
    return out;
  })()`);
  check('语音设置', '设置里只留一行摘要与入口，不再塞表单', voiceSetup.row.headings.includes('语音')
    && voiceSetup.row.inputs === 0 && voiceSetup.row.button === '语音设置…'
    && voiceSetup.row.state.includes('未配置'), JSON.stringify(voiceSetup.row));
  check('语音设置', '点入口打开语音面板并收起设置', voiceSetup.row.runs[0] === 'voice-settings'
    && voiceSetup.row.closed === true, JSON.stringify(voiceSetup.row));
  check('语音设置', '与 AI 面板同版式：标题、四行、三个动作', voiceSetup.panel.title === '语音输入'
    && voiceSetup.panel.fields.join(',') === '服务商,服务地址,模型,API Key'
    && voiceSetup.panel.actions.join(',') === '验证 Key,取消,保存', JSON.stringify(voiceSetup.panel));
  check('语音设置', '预填硅基流动，并说明 AI 的 Key 借不过来', voiceSetup.panel.provider === 'siliconflow'
    && voiceSetup.panel.model === 'FunAudioLLM/SenseVoiceSmall'
    && voiceSetup.panel.hint.includes('api.deepseek.com'), JSON.stringify(voiceSetup.panel));
  check('语音设置', '换服务商自动填地址与模型', voiceSetup.switch.base === 'https://api.openai.com/v1'
    && voiceSetup.switch.model === 'whisper-1', JSON.stringify(voiceSetup.switch));
  check('语音设置', '保存写回并关面板', voiceSetup.save.last.apiKey === 'sk-voice'
    && voiceSetup.save.closed === true, JSON.stringify(voiceSetup.save));
  check('语音设置', '验证 Key 前先存，验的是刚填的那个', voiceSetup.verify.last.apiKey === 'sk-verify'
    && voiceSetup.verify.result.includes('可用'), JSON.stringify(voiceSetup.verify));
  check('语音设置', '取消不写，Esc 也不落盘', voiceSetup.esc.extra === 0 && voiceSetup.esc.closed === true,
    JSON.stringify(voiceSetup.esc));
  check('语音设置', '同一家服务时摘要说明在借 AI 的 Key', voiceSetup.borrowed.includes('借用'),
    voiceSetup.borrowed);

  // ============================== 语音输入 ==============================
  await fresh();
  const voice = await run(`(async () => {
    const { __lab: lab, __stub: stub } = window;
    const out = {};
    // 没有可用的识别服务时，不摆一个点了就报错的按钮。
    stub.voice = { ...stub.voice, hasKey: false, ready: false };
    await lab.voice.refresh();
    out.hiddenWhenUnconfigured = lab.voice.visible() === false;
    // 配好之后出现。
    stub.voice = { ...stub.voice, hasKey: true, ready: true };
    await lab.voice.refresh();
    out.shownWhenReady = lab.voice.visible() === true;
    out.readyFlag = lab.voice.ready();
    // 点一下开始录音。
    lab.voice.click();
    await new Promise((r) => setTimeout(r, 80));
    out.afterStart = lab.voice.state();
    out.startCalls = stub.calls.filter((c) => c[0] === 'voice_start').length;
    // 再点一下结束，文字落在光标处。
    lab.caretAfter('第一段内容');
    lab.voice.click();
    await new Promise((r) => setTimeout(r, 150));
    out.afterStop = lab.voice.state();
    out.stopCalls = stub.calls.filter((c) => c[0] === 'voice_stop').length;
    out.md = lab.md();
    // 录音中按 Esc：丢掉这段，不落字。
    stub.calls.length = 0;
    lab.voice.click();
    await new Promise((r) => setTimeout(r, 80));
    const before = lab.md();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 80));
    out.cancelCalls = stub.calls.filter((c) => c[0] === 'voice_cancel').length;
    out.cancelState = lab.voice.state();
    out.cancelKeptDoc = lab.md() === before;
    return out;
  })()`);
  check('语音', '没配识别服务时不显示按钮', voice.hiddenWhenUnconfigured === true);
  check('语音', '配好后按钮出现', voice.shownWhenReady === true && voice.readyFlag === 'yes',
    `visible=${voice.shownWhenReady} ready=${voice.readyFlag}`);
  check('语音', '点一下开始录音', voice.afterStart === 'recording' && voice.startCalls === 1,
    `state=${voice.afterStart} calls=${voice.startCalls}`);
  check('语音', '再点一下，转写结果落在光标处', voice.afterStop === 'idle' && voice.stopCalls === 1
    && voice.md.includes('这是语音转出来的文字。'), `state=${voice.afterStop} calls=${voice.stopCalls}`);
  check('语音', '录音中按 Esc 取消，不落字', voice.cancelCalls === 1 && voice.cancelState === 'idle'
    && voice.cancelKeptDoc === true, JSON.stringify({ calls: voice.cancelCalls, state: voice.cancelState }));

  // ============================== 汇总 ==============================
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(` - [${f.group}] ${f.name}  ${f.detail}`);
  }
  const pageError = await run(`window.__err`);
  if (pageError) console.log('页面错误:', pageError);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  page.close();
  server?.kill();
}
