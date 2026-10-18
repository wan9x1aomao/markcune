// Minimal CDP harness for driving the MDPad editor in headless Chrome.
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function chromePath() {
  const found = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`没有找到 Chrome，装一个或者用 CHROME_PATH 指过去（试过：${CHROME_CANDIDATES.join('、')}）`);
  }
  return found;
}

export async function open(url, { width = 1280, height = 860, scale = 2 } = {}) {
  const CHROME = chromePath();
  const PORT = 9600 + Math.floor(Math.random() * 300);
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=/tmp/chrome-lab-${PORT}`,
      '--hide-scrollbars',
      '--disable-gpu',
      '--no-sandbox',
      '--no-proxy-server',
      `--force-device-scale-factor=${scale}`,
      `--window-size=${width},${height}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  let targets;
  for (let i = 0; i < 100; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      if (targets.some((t) => t.type === 'page')) break;
    } catch {}
    await sleep(200);
  }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  };
  const waitFor = async (expression, tries = 120) => {
    for (let i = 0; i < tries; i++) {
      if (await evaluate(expression)) return true;
      await sleep(150);
    }
    return false;
  };
  const type = async (text) => {
    await send('Input.insertText', { text });
  };
  const key = async (key, { code, modifiers = 0 } = {}) => {
    for (const t of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', {
        type: t,
        key,
        code: code ?? key,
        windowsVirtualKeyCode: key === 'Backspace' ? 8 : key === 'Enter' ? 13 : key === 'Escape' ? 27 : 0,
        modifiers,
      });
    }
  };
  const clickAt = async (x, y) => {
    for (const t of ['mousePressed', 'mouseReleased'])
      await send('Input.dispatchMouseEvent', { type: t, x, y, button: 'left', clickCount: 1 });
  };
  const shot = async (path) => {
    const { result } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path, Buffer.from(result.data, 'base64'));
    return path;
  };
  const goto = async (u) => {
    await send('Page.navigate', { url: u });
  };
  const close = () => {
    ws.close();
    chrome.kill();
  };
  if (url) await goto(url);
  return { send, evaluate, waitFor, type, key, clickAt, shot, goto, close };
}
