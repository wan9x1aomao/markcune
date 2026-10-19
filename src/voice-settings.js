// 语音输入设置：和「AI 写作助手」同一个版式（同一套 .ai-* 样式），不另起一套外观。
//
// 为什么单独一个面板而不是塞进设置的一行：语音常常和聊天不是同一家服务，
// 服务商、地址、模型、Key 这四样都要能改，塞进设置列表里既挤又会和 AI 的字段混淆。
//
// Key 是只写的：外壳只告诉前端「有没有存」，不回传内容，所以输入框初始为空，
// 占位文字说明「留空 = 沿用」。
const PROVIDERS = [
  { id: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/SenseVoiceSmall' },
  { id: 'openai', name: 'OpenAI Whisper', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
  { id: 'glm', name: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-asr' },
  { id: 'custom', name: '自定义', baseUrl: '', model: '' },
];

const options = PROVIDERS.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');

/**
 * Options: voice ({ status(), configure(), test() }), onClose().
 * Returns a close function.
 */
export function openVoiceSettings({ voice, onClose }) {
  document.querySelector('.overlay.voice-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'overlay voice-overlay';
  overlay.innerHTML = `
    <div class="ai-panel" role="dialog" aria-label="语音输入">
      <h2>语音输入</h2>
      <p class="ai-lead">可选功能。不填 Key 也能照常写文档，只是没有语音输入。</p>

      <label class="ai-row"><span>服务商</span><select class="voice-provider">${options}</select></label>
      <label class="ai-row"><span>服务地址</span><input class="voice-base" spellcheck="false" placeholder="https://api.siliconflow.cn/v1"></label>
      <label class="ai-row"><span>模型</span><input class="voice-model" spellcheck="false" placeholder="FunAudioLLM/SenseVoiceSmall"></label>
      <label class="ai-row"><span>API Key</span><input class="voice-key" type="password" spellcheck="false" autocomplete="off"></label>
      <p class="ai-key-state"><span class="voice-key-note"></span><button class="voice-clear" type="button">清除</button></p>

      <p class="voice-hint" hidden></p>
      <p class="ai-privacy">录音只在这台电脑上完成，只有你按下的那段音频会发到上面填的地址。Key 只保存在这台电脑上。</p>

      <div class="ai-footer">
        <button class="voice-test" type="button">验证 Key</button>
        <span class="ai-result"></span>
        <button class="voice-cancel" type="button">取消</button>
        <button class="voice-save" type="button">保存</button>
      </div>
    </div>`;

  const $ = (selector) => overlay.querySelector(selector);
  const provider = $('.voice-provider');
  const base = $('.voice-base');
  const model = $('.voice-model');
  const key = $('.voice-key');
  const keyNote = $('.voice-key-note');
  const clearButton = $('.voice-clear');
  const hint = $('.voice-hint');
  const result = $('.ai-result');
  const testButton = $('.voice-test');
  const saveButton = $('.voice-save');

  let stored = { hasKey: false, ready: false };

  /** 填一次表：地址、模型、Key 的「已存/未存」状态。 */
  const paint = (next) => {
    stored = { ...stored, ...next };
    const known = PROVIDERS.find((p) => p.baseUrl && p.baseUrl === next.baseUrl);
    provider.value = known?.id ?? 'custom';
    base.value = next.baseUrl ?? '';
    model.value = next.model ?? '';
    key.value = '';
    key.placeholder = stored.hasKey ? '已保存，留空不修改' : '';
    keyNote.textContent = stored.hasKey ? '已经保存了一个 Key。留空则沿用，输入新的会覆盖。' : '还没有设置 Key。';
    clearButton.hidden = !stored.hasKey;
  };

  /** 面板里说清「AI 的 Key 能不能借」——这正是最容易踩的坑。 */
  const describeHint = (next) => {
    if (next.borrowed) {
      hint.hidden = false;
      hint.textContent = '没填 Key，正在借用 AI 设置里的 Key（两家是同一个服务）。想让语音独立，可以在这里单独填一个。';
    } else if (!next.hasKey && next.aiHost) {
      hint.hidden = false;
      hint.textContent = `AI 设置里用的是 ${next.aiHost}，它和语音服务不是同一家，Key 不能通用 —— 这里要单独填一个。`;
    } else {
      hint.hidden = true;
      hint.textContent = '';
    }
  };

  document.body.appendChild(overlay);
  requestAnimationFrame(() => base.focus());
  if (!voice.test) testButton.hidden = true;

  voice
    .status()
    .then((next) => {
      paint(next);
      describeHint(next);
    })
    .catch((error) => {
      result.textContent = String(error?.message ?? error);
      result.dataset.state = 'error';
    });

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close();
  });
  $('.voice-cancel').addEventListener('click', close);

  provider.addEventListener('change', () => {
    const chosen = PROVIDERS.find((p) => p.id === provider.value);
    if (!chosen) return;
    if (chosen.id === 'custom') {
      base.focus();
      return;
    }
    base.value = chosen.baseUrl;
    model.value = chosen.model;
  });

  // 清空不等于删除：留空是「沿用」，删除 Key 要单独一个动作。
  let clearing = false;
  const stopClearing = () => {
    clearing = false;
    keyNote.textContent = '已经保存了一个 Key。留空则沿用，输入新的会覆盖。';
    clearButton.hidden = false;
  };
  clearButton.addEventListener('click', () => {
    clearing = true;
    key.value = '';
    clearButton.hidden = true;
    keyNote.textContent = '保存后会删掉这个 Key，语音按钮随之消失。输入新的 Key 可撤销。';
    result.textContent = '';
    result.dataset.state = '';
  });
  key.addEventListener('input', () => {
    if (clearing) stopClearing();
  });

  /** 存下表单。返回新的状态。 */
  async function store() {
    const entered = clearing ? '' : key.value.trim();
    const next = await voice.configure({
      baseUrl: base.value.trim(),
      model: model.value.trim(),
      // 空字段表示沿用已存的 Key；只有明确的「清除」才发空串。
      ...(clearing || entered ? { apiKey: entered } : {}),
    });
    clearing = false;
    paint(next);
    describeHint(next);
    return next;
  }

  saveButton.addEventListener('click', async () => {
    saveButton.disabled = true;
    try {
      await store();
      result.textContent = '已保存';
      result.dataset.state = 'ok';
      setTimeout(close, 600);
    } catch (error) {
      result.textContent = String(error?.message ?? error);
      result.dataset.state = 'error';
    } finally {
      saveButton.disabled = false;
    }
  });

  testButton.addEventListener('click', async () => {
    testButton.disabled = true;
    result.textContent = '正在验证…';
    result.dataset.state = '';
    try {
      // 先存再验：外壳只能验「已存的」Key，否则验的是旧值，通过也会误导人。
      await store();
      const message = await voice.test();
      result.textContent = `已保存 · ${message}`;
      result.dataset.state = 'ok';
    } catch (error) {
      result.textContent = String(error?.message ?? error);
      result.dataset.state = 'error';
    } finally {
      testButton.disabled = false;
    }
  });

  return close;
}
