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
 * voice (optional { status() } — the summary row is hidden without it; the form is its own
 * panel, see voice-settings.js).
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
        <h3>语音</h3>
        <div class="settings-row">
          <div class="label">
            <b>语音输入</b>
            <em class="voice-state">读取中…</em>
          </div>
          <button class="text-button opt-voice" type="button">语音设置…</button>
        </div>
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

  // 语音输入：和 AI 一样，这里只给一行摘要，表单在它自己的面板里（见 voice-settings.js）。
  // 单独一个面板而不是塞进列表：服务商、地址、模型、Key 四样都要能改，挤在设置行里会和 AI 的字段混淆。
  const voiceSection = $('.voice-section');
  if (voice) {
    voiceSection.hidden = false;
    const voiceState = $('.voice-state');
    const describeVoice = (status) => {
      const host = status.baseUrl ? status.baseUrl.replace(/^https?:\/\//, '').split('/')[0] : '';
      if (status.hasKey) {
        voiceState.textContent = `已配置${status.model ? ` · ${status.model}` : ''}${host ? ` · ${host}` : ''}`;
      } else if (status.borrowed) {
        voiceState.textContent = `正在借用 AI 设置里的 Key${status.model ? ` · ${status.model}` : ''}`;
      } else {
        voiceState.textContent = '未配置。不填 Key 也能照常写文档，只是没有语音输入。';
      }
    };
    voice.status().then(describeVoice).catch(() => {
      voiceState.textContent = '';
    });
    $('.opt-voice').addEventListener('click', () => {
      close();
      run('voice-settings');
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
