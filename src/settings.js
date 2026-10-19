// The settings panel: the place for anything that is a preference rather than an action.
//
// Everything applies immediately (there is no Save button): a theme or panel switch is its own
// confirmation. The panel is handed the few things it needs — the live settings object, the panel
// switch, and the command runner — so it can be opened from a test with plain fakes.
import { getVersion } from '@tauri-apps/api/app';
import { ai } from './ai-core.js';
import { onThemeChange, setTheme, themeState } from './theme.js';
import { formatKeys } from './ui.js';

const THEMES = [
  { id: 'system', label: '跟随系统' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
];

/**
 * Options: settings (live {sidebar, outline}), setPanel(name, visible), run(id),
 * version (optional string — the shell's version is read async otherwise), onClose(),
 * voice (optional { status(), configure() } — the speech-to-text form is hidden without it).
 * Returns a close function.
 */
export function openSettings({ settings, setPanel, run, version, onClose, voice }) {
  document.querySelector('.overlay.settings-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'overlay settings-overlay';
  overlay.innerHTML = `
    <div class="settings-panel" role="dialog" aria-label="设置">
      <header>
        <h2>设置</h2>
        <button class="settings-close" type="button" aria-label="关闭">×</button>
      </header>

      <section>
        <h3>外观</h3>
        <div class="settings-row">
          <div class="label">
            <b>主题</b>
            <em>只影响界面；导出文件始终是白底。</em>
          </div>
          <div class="segmented theme-choice" role="tablist">
            <i class="thumb"></i>
            ${THEMES.map((t) => `<button data-theme="${t.id}" role="tab">${t.label}</button>`).join('')}
          </div>
        </div>
      </section>

      <section>
        <h3>界面</h3>
        <label class="settings-row pick">
          <input type="checkbox" class="opt-sidebar" />
          <span class="label"><b>文件列表</b></span>
          <em>${formatKeys('Mod+Shift+L')}</em>
        </label>
        <label class="settings-row pick">
          <input type="checkbox" class="opt-outline" />
          <span class="label"><b>大纲</b></span>
          <em>${formatKeys('Mod+Shift+T')}</em>
        </label>
      </section>

      <section>
        <h3>写作</h3>
        <div class="settings-row">
          <div class="label">
            <b>AI 写作助手</b>
            <em class="ai-state">读取中…</em>
          </div>
          <button class="text-button opt-ai" type="button">AI 设置…</button>
        </div>
      </section>

      <section class="voice-section" hidden>
        <h3>语音输入</h3>
        <p class="settings-note">录音在这台电脑上完成，只是把音频发到你填的地址转成文字。聊天用的服务如果没有音频接口（比如 DeepSeek），这里要单独填一个。</p>
        <label class="settings-field"><span>服务地址</span><input class="voice-base" spellcheck="false" /></label>
        <label class="settings-field"><span>模型</span><input class="voice-model" spellcheck="false" /></label>
        <label class="settings-field"><span>API Key</span><input class="voice-key" type="password" spellcheck="false" autocomplete="off" /></label>
        <p class="settings-note voice-state"></p>
        <button class="text-button voice-clear" type="button" hidden>清除 Key</button>
      </section>

      <section>
        <h3>关于</h3>
        <div class="settings-row">
          <div class="label">
            <b>MDPad <span class="version">…</span></b>
            <em>本地写作，文件留在你自己的电脑上。</em>
          </div>
          <div class="buttons">
            <button class="text-button opt-update" type="button">检查更新</button>
            <button class="text-button opt-changelog" type="button">更新日志</button>
          </div>
        </div>
      </section>
    </div>`;

  const $ = (selector) => overlay.querySelector(selector);
  document.body.appendChild(overlay);

  // Appearance: the buttons show the stored setting, not the resolved colour, so "跟随系统" stays
  // selected when the OS is what decided. Clicking applies at once and persists.
  const choice = $('.theme-choice');
  const buttons = [...choice.querySelectorAll('button[data-theme]')];
  const syncTheme = () => {
    const { setting } = themeState();
    const index = Math.max(0, buttons.findIndex((b) => b.dataset.theme === setting));
    buttons.forEach((button, i) => {
      button.classList.toggle('on', i === index);
      button.setAttribute('aria-selected', String(i === index));
    });
    choice.querySelector('.thumb').style.transform = `translateX(${index * 100}%)`;
  };
  syncTheme();
  const stopTheme = onThemeChange(syncTheme);
  choice.addEventListener('click', (event) => {
    const id = event.target.closest('button[data-theme]')?.dataset.theme;
    if (id) setTheme(id);
  });

  // Panels: checkbox ⇄ the same switch the toolbar buttons use, so both stay in step.
  const sidebar = $('.opt-sidebar');
  const outline = $('.opt-outline');
  sidebar.checked = !!settings.sidebar;
  outline.checked = !!settings.outline;
  sidebar.addEventListener('change', () => setPanel('sidebar', sidebar.checked));
  outline.addEventListener('change', () => setPanel('outline', outline.checked));

  // AI: the panel only summarises; the form itself lives in its own dialog.
  const describeAi = () => {
    const status = ai.status ?? {};
    const state = $('.ai-state');
    if (!status.hasKey) {
      state.textContent = '未配置。不填 Key 也能照常写文档，只是没有 AI 建议。';
      return;
    }
    const provider = status.baseUrl ? status.baseUrl.replace(/^https?:\/\//, '').split('/')[0] : '';
    state.textContent = `已配置${status.model ? ` · ${status.model}` : ''}${provider ? ` · ${provider}` : ''}`;
  };
  describeAi();
  // The form is its own dialog; this panel just points at it.
  $('.opt-ai').addEventListener('click', () => {
    close();
    run('ai-settings');
  });

  // 语音输入：和聊天分开配，因为常见情况是聊天用一家、语音用另一家。改动即时保存。
  const voiceSection = $('.voice-section');
  if (voice) {
    voiceSection.hidden = false;
    const baseInput = $('.voice-base');
    const modelInput = $('.voice-model');
    const keyInput = $('.voice-key');
    const voiceState = $('.voice-state');
    const clearVoice = $('.voice-clear');
    let stored = { hasKey: false, ready: false };
    const describeVoice = () => {
      if (stored.hasKey) {
        voiceState.textContent = '已配置。编辑区右下角会出现麦克风按钮，点一下开始、再点一下结束。';
      } else if (stored.ready) {
        voiceState.textContent = '正在借用 AI 设置里的 Key。如果那家没有音频接口（比如 DeepSeek），请在上面单独填一个。';
      } else {
        voiceState.textContent = '还没配置。填一个支持音频转写的 Key，编辑区右下角就会出现麦克风按钮。';
      }
      clearVoice.hidden = !stored.hasKey;
      keyInput.placeholder = stored.hasKey ? '已保存，留空不修改' : '';
    };
    const paint = (status) => {
      stored = { ...stored, ...status };
      baseInput.value = status.baseUrl ?? '';
      modelInput.value = status.model ?? '';
      keyInput.value = '';
      describeVoice();
    };
    voice.status().then(paint).catch(() => {});
    const save = async () => {
      try {
        const typed = keyInput.value.trim();
        paint(await voice.configure({
          baseUrl: baseInput.value.trim(),
          model: modelInput.value.trim(),
          // 空字段表示沿用已存的 Key；只有明确的"清除"才发空串。
          ...(typed ? { apiKey: typed } : {}),
        }));
      } catch (error) {
        voiceState.textContent = String(error?.message ?? error);
      }
    };
    baseInput.addEventListener('change', save);
    modelInput.addEventListener('change', save);
    keyInput.addEventListener('change', save);
    clearVoice.addEventListener('click', async () => {
      try {
        paint(await voice.configure({ apiKey: '' }));
      } catch (error) {
        voiceState.textContent = String(error?.message ?? error);
      }
    });
  }

  const showVersion = (value) => {
    $('.version').textContent = typeof value === 'string' && value ? value : '—';
  };
  if (version) showVersion(version);
  else getVersion().then(showVersion, () => showVersion('—'));

  $('.opt-update').addEventListener('click', () => {
    close();
    run('check-update');
  });
  $('.opt-changelog').addEventListener('click', () => {
    close();
    run('changelog');
  });

  const onKey = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close();
  });
  $('.settings-close').addEventListener('click', () => close());

  function close() {
    stopTheme();
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  }
  return close;
}
