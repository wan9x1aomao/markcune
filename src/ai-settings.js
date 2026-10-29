// The AI settings panel: provider, address, model, key, and the completion switch.
//
// The key is write-only. The shell reports whether one is stored and never sends the value back,
// so the field starts empty and its placeholder says what leaving it empty means.
import { ai } from './ai-core.js';

const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'qwen', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'kimi', name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'glm', name: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'ollama', name: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
  { id: 'custom', name: '自定义', baseUrl: '', model: '' },
];

const options = PROVIDERS.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');

/** A rewrite the user keeps: a short name and the sentence sent to the model. */
const MAX_CUSTOM = 3;

export function openAiSettings() {
  document.querySelector('.overlay.ai-overlay')?.remove();
  const status = ai.status;
  const known = PROVIDERS.find((p) => p.baseUrl && p.baseUrl === status.baseUrl);

  const overlay = document.createElement('div');
  overlay.className = 'overlay ai-overlay';
  overlay.innerHTML = `
    <div class="ai-panel" role="dialog" aria-label="AI 写作助手">
      <h2>AI 写作助手</h2>
      <p class="ai-lead">可选功能。不填 Key 也能照常写文档，只是没有 AI 建议。</p>

      <label class="ai-row"><span>服务商</span><select class="ai-provider">${options}</select></label>
      <label class="ai-row"><span>服务地址</span><input class="ai-base" spellcheck="false" placeholder="https://api.deepseek.com/v1"></label>
      <label class="ai-row"><span>模型</span><input class="ai-model" spellcheck="false" placeholder="deepseek-chat"></label>
      <label class="ai-row"><span>API Key</span><input class="ai-key" type="password" spellcheck="false" autocomplete="off"></label>
      <p class="ai-key-state"><span class="ai-key-note"></span><button class="ai-clear" type="button">清除</button></p>

      <label class="ai-toggle">
        <input type="checkbox" class="ai-completion">
        <span>停顿时给出续写建议 <em>Tab 接受 · Esc 忽略</em></span>
      </label>

      <div class="ai-custom">
        <div class="ai-custom-head">
          <span>自定义指令</span>
          <button class="ai-custom-add" type="button">添加一条</button>
        </div>
        <p class="ai-custom-lead">存几条你常用的改法，会出现在 AI 菜单和斜杠菜单里，最多 3 条。</p>
        <p class="ai-custom-eg">例：名字 <b>公文</b>，要求 <b>改成正式公文语气，去掉口语和感叹号，数字不动</b>。<br>要求要写「怎么改」，不要写「改成什么内容」。</p>
        <div class="ai-custom-rows"></div>
      </div>

      <p class="ai-privacy">开启后，你选中的文字和「一键整理」要排版的文本会直接发送到上面填写的地址，MarkCune 不做中转；长文档按段发送。Key 只保存在这台电脑上。</p>

      <div class="ai-footer">
        <button class="ai-test" type="button">测试连接</button>
        <span class="ai-result"></span>
        <button class="ai-cancel" type="button">取消</button>
        <button class="ai-save" type="button">保存</button>
      </div>
    </div>`;

  const $ = (selector) => overlay.querySelector(selector);
  const provider = $('.ai-provider');
  const base = $('.ai-base');
  const model = $('.ai-model');
  const key = $('.ai-key');
  const completion = $('.ai-completion');
  const keyNote = $('.ai-key-note');
  const clearButton = $('.ai-clear');
  const result = $('.ai-result');
  const testButton = $('.ai-test');
  const saveButton = $('.ai-save');

  provider.value = known?.id ?? 'custom';
  base.value = status.baseUrl ?? '';
  model.value = status.model ?? '';
  completion.checked = !!status.completion;
  /**
   * Rows for the user's own rewrites. They are read back from the inputs on every change, so a row
   * that is added or removed never reformats the ones next to it.
   */
  const customRows = $('.ai-custom-rows');
  const customAdd = $('.ai-custom-add');
  const readCustom = () =>
    [...customRows.querySelectorAll('.ai-custom-row')].map((row) => ({
      label: row.querySelector('.ai-custom-label').value.trim(),
      instruction: row.querySelector('.ai-custom-rule').value.trim(),
    }));
  const renderCustom = (list) => {
    customRows.replaceChildren();
    for (const [index, item] of list.entries()) {
      const row = document.createElement('div');
      row.className = 'ai-custom-row';
      const label = document.createElement('input');
      label.className = 'ai-custom-label';
      label.maxLength = 12;
      label.value = item.label ?? '';
      label.placeholder = ['公文', '更直接', '术语统一'][index] ?? '名称';
      label.spellcheck = false;
      const rule = document.createElement('input');
      rule.className = 'ai-custom-rule';
      rule.maxLength = 200;
      rule.value = item.instruction ?? '';
      rule.placeholder = '怎么改，例如：改成正式公文语气，去掉口语，数字不动';
      rule.spellcheck = false;
      const drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'ai-custom-drop';
      drop.textContent = '删除';
      drop.addEventListener('click', () => renderCustom(readCustom().filter((_, at) => at !== index)));
      row.append(label, rule, drop);
      customRows.appendChild(row);
    }
    customAdd.hidden = customRows.children.length >= MAX_CUSTOM;
  };
  renderCustom(Array.isArray(status.custom) ? status.custom : []);
  customAdd.addEventListener('click', () => {
    if (customRows.children.length >= MAX_CUSTOM) return;
    renderCustom([...readCustom(), { label: '', instruction: '' }]);
    customRows.querySelector('.ai-custom-row:last-child .ai-custom-label')?.focus();
  });
  /** Reflects what is stored, so the field itself never has to hold the key. */
  const describe = (hasKey) => {
    keyNote.textContent = hasKey ? '已经保存了一个 Key。留空则沿用，输入新的会覆盖。' : '还没有设置 Key。';
    clearButton.hidden = !hasKey;
  };
  describe(status.hasKey);
  if (status.hasKey) key.placeholder = '已保存，留空不修改';
  document.body.appendChild(overlay);
  requestAnimationFrame(() => (status.hasKey ? base : key).focus());

  // A typed value replaces the key, an empty field keeps it — so removing it needs its own action.
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
    keyNote.textContent = '保存后就不再使用 AI：Key 会被删掉，续写和改写入口随之消失。输入新的 Key 可撤销。';
    result.textContent = '';
    result.dataset.state = '';
  });
  key.addEventListener('input', () => {
    if (clearing) stopClearing();
  });

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

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
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
  $('.ai-cancel').addEventListener('click', close);

  /** Saves what is in the form. Returns the new status. */
  async function store() {
    const entered = clearing ? '' : key.value.trim();
    const next = await ai.configure({
      baseUrl: base.value.trim(),
      model: model.value.trim(),
      // An empty field means "keep the stored key": only a typed value replaces it, and only the
      // clear action sends the empty string that removes it.
      ...(clearing || entered ? { apiKey: entered } : {}),
      completion: completion.checked,
      // Always sent, so deleting a row is saved like editing one.
      custom: readCustom(),
    });
    clearing = false;
    key.value = '';
    key.placeholder = next.hasKey ? '已保存，留空不修改' : '';
    describe(next.hasKey);
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
    result.textContent = '正在测试…';
    result.dataset.state = '';
    try {
      await store();
      const message = await ai.test();
      // Testing saves first, because the shell can only test what is stored.
      result.textContent = `已保存 · ${message}`;
      result.dataset.state = 'ok';
    } catch (error) {
      result.textContent = String(error?.message ?? error);
      result.dataset.state = 'error';
    } finally {
      testButton.disabled = false;
    }
  });
}
