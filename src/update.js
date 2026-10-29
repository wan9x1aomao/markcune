// In-app updates: a quiet banner offers the new version, then downloads it and restarts.
//
// The shell decides when a check may run (half an hour after one that answered, ten minutes after
// one that failed), so `recheck()` can be called freely — on launch, on focus, on a timer, and from
// the menu. Failures of an automatic check stay quiet on screen but are recorded where
// 设置 › 关于 shows them.
import { getVersion } from '@tauri-apps/api/app';

/** Options: api, toast, beforeRestart() (saves the document). */
export function createUpdater(el, { api, toast, beforeRestart }) {
  const message = el.querySelector('.message');
  const buttons = el.querySelector('.buttons');

  function show(text, actions) {
    el.hidden = false;
    message.textContent = text;
    buttons.replaceChildren();
    for (const [label, run, primary] of actions) {
      const button = Object.assign(document.createElement('button'), {
        className: primary ? 'text-button primary' : 'text-button',
        textContent: label,
      });
      button.addEventListener('click', run);
      buttons.appendChild(button);
    }
  }
  const hide = () => (el.hidden = true);

  async function check(automatic) {
    let info;
    try {
      info = await api.checkUpdate(automatic);
    } catch (error) {
      if (automatic) {
        // Not worth interrupting the writing for; 设置 › 关于 has the reason, and the shell will
        // try again in ten minutes.
        console.warn('check for updates failed:', error);
      } else {
        toast(String(error), 4000);
      }
      return;
    }
    if (!info) {
      if (!automatic) toast(`已是最新版本（${await getVersion()}）`);
      return;
    }
    const first = info.notes?.split('\n').find((line) => line.trim())?.trim();
    // `latest.json` notes conventionally start with the version ("3.5.3：…"); the banner already
    // names it, so strip the duplicate instead of printing "MarkCune 3.5.4 已发布：3.5.4：…".
    const notes = first?.replace(/^\d+\.\d+\.\d+\s*[：:]\s*/, '');
    show(`MarkCune ${info.version} 已发布${notes ? `：${notes}` : '。'}`, [
      ['立即更新', download, true],
      ['稍后', hide],
    ]);
  }

  async function download() {
    show('正在下载更新…', []);
    try {
      const version = await api.downloadUpdate();
      show(`新版本 ${version} 已下载，重新启动后即可使用。`, [
        ['重新启动', restart, true],
        ['稍后', hide],
      ]);
    } catch (error) {
      show(String(error), [
        ['重试', () => check(false)],
        ['关闭', hide],
      ]);
    }
  }

  async function restart() {
    show('正在保存并重新启动…', []);
    await beforeRestart();
    api.restartToUpdate();
  }

  api.on('update-progress', ({ downloaded, total }) => {
    if (el.hidden) return;
    const size = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    message.textContent = total
      ? `正在下载更新… ${Math.floor((downloaded / total) * 100)}%（${size(downloaded)} / ${size(total)}）`
      : `正在下载更新… ${size(downloaded)}`;
  });

  return {
    check,
    /** A check nobody asked for: quiet on screen, rate limited by the shell. */
    recheck: () => check(true),
    status: () => api.updateStatus(),
  };
}
