// 语音输入：录音在 Rust 里做（webview 拿不到麦克风），转写结果插到光标处。
//
// 按钮浮在编辑区右下角，只有配置好 Key 才出现 —— 和 AI 的其它入口一致：没有可用服务时，
// 不摆一个点了就报错的按钮。录完直接落字，不弹确认框：说错了按 ⌘Z 撤销，和打字一样。
import { api } from './bridge.js';
import { icons } from './icons.js';
import { toast } from './ui.js';

/** 与 Rust 侧的上限一致；到点自动收尾，防止忘了点。 */
export const MAX_SECONDS = 120;

const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/**
 * Options: getEditor (active editor or null), bridge (test seam), notify (test seam),
 * onChange (test seam: receives the state name).
 * Returns { element, refresh, state, destroy }.
 */
export function createVoiceInput({ getEditor, bridge = api, notify = toast, onChange }) {
  let state = 'idle'; // idle | starting | recording | working
  let startedAt = 0;
  let timer = null;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'voice-button';
  button.hidden = true;
  button.title = '语音输入：点一下开始，说完再点一下';
  button.innerHTML = `
    <span class="voice-glyph">${icons.mic}</span>
    <span class="voice-dot"></span>
    <span class="voice-spin"></span>
    <span class="voice-time"></span>`;

  const glyph = button.querySelector('.voice-glyph');
  const time = button.querySelector('.voice-time');

  const setState = (next) => {
    state = next;
    button.dataset.state = next;
    if (next === 'idle') {
      button.title = '语音输入：点一下开始，说完再点一下';
      time.textContent = '';
      glyph.hidden = false;
    } else if (next === 'starting') {
      button.title = '正在等待麦克风…';
      glyph.hidden = true;
      time.textContent = '等待';
    } else if (next === 'recording') {
      button.title = '正在录音，点一下结束';
      glyph.hidden = true;
    } else {
      button.title = '正在转成文字…';
      glyph.hidden = true;
      time.textContent = '识别中';
    }
    onChange?.(next);
  };

  function tick() {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    time.textContent = clock(seconds);
    // 到上限前一秒收尾，留出上传的时间。
    if (seconds >= MAX_SECONDS - 1) void stop();
  }

  async function start() {
    if (state !== 'idle') return;
    setState('starting');
    try {
      await bridge.voiceStart();
      startedAt = Date.now();
      setState('recording');
      timer = setInterval(tick, 250);
      tick();
    } catch (error) {
      setState('idle');
      notify(String(error?.message ?? error));
    }
  }

  async function stop() {
    if (state !== 'recording') return;
    clearInterval(timer);
    timer = null;
    setState('working');
    try {
      const text = await bridge.voiceStop();
      const editor = getEditor();
      if (editor?.insert) {
        editor.insert(text);
      } else {
        notify('没有打开的文档，转写结果没有落字');
      }
      setState('idle');
    } catch (error) {
      setState('idle');
      notify(String(error?.message ?? error));
    }
  }

  async function cancel() {
    if (state !== 'recording' && state !== 'starting') return;
    clearInterval(timer);
    timer = null;
    setState('idle');
    await Promise.resolve(bridge.voiceCancel()).catch(() => {});
  }

  button.addEventListener('click', () => {
    if (state === 'idle') void start();
    else if (state === 'recording') void stop();
  });

  // Esc 丢掉这段录音。抢在编辑器之前处理，否则它只会取消选区。
  const onKey = (event) => {
    if (event.key !== 'Escape') return;
    if (state !== 'recording' && state !== 'starting') return;
    event.preventDefault();
    event.stopPropagation();
    void cancel();
  };
  document.addEventListener('keydown', onKey, true);

  /** Shows the button only when a service is configured. Called at startup and after saving settings. */
  async function refresh() {
    let ready = false;
    try {
      ready = !!(await bridge.voiceStatus()).ready;
    } catch {
      ready = false;
    }
    // Don't yank the button out from under a running recording.
    if (state === 'idle') button.hidden = !ready;
    button.dataset.ready = ready ? 'yes' : 'no';
    return ready;
  }

  return {
    element: button,
    refresh,
    get state() {
      return state;
    },
    start,
    stop,
    cancel,
    destroy() {
      clearInterval(timer);
      document.removeEventListener('keydown', onKey, true);
      button.remove();
    },
  };
}
