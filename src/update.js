// In-app updates: a quiet banner offers the new version, then downloads it and restarts.
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
      if (!automatic) toast(String(error), 4000);
      return;
    }
    if (!info) {
      if (!automatic) toast(`已是最新版本（${await getVersion()}）`);
      return;
    }
    const notes = info.notes?.split('\n').find((line) => line.trim())?.trim();
    show(`MDPad ${info.version} 已发布${notes ? `：${notes}` : '。'}`, [
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

  return { check };
}
