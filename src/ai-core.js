// Whether AI is configured, and the two calls the editing features make.
//
// The shell owns the key and the prompts: this file never sees either. `status` carries only
// `hasKey`, and every error arrives already worded by the shell, so the UI never invents a cause.
import { api } from './bridge.js';

const none = { mode: 'none', direct: false, gateway: false, baseUrl: '', model: '', hasKey: false, completion: false };

let status = { ...none };
const listeners = new Set();

function emit() {
  for (const fn of listeners) fn(status);
}

/** Subscribes to configuration changes. Returns the unsubscribe function. */
export function onAiChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const ai = {
  get status() {
    return status;
  },
  /** True once a provider or the gateway answers. */
  available() {
    return status.mode !== 'none';
  },
  /** True when the user turned inline completion on. */
  completionOn() {
    return status.completion && status.mode !== 'none';
  },
  async refresh() {
    status = await api.aiStatus().catch(() => ({ ...none }));
    emit();
    return status;
  },
  async configure(options) {
    status = await api.aiConfigure(options);
    emit();
    return status;
  },
  /** A round trip that proves the configuration works; the message is ready to show. */
  test() {
    return api.aiTest();
  },
  /**
   * Continues the text at the cursor. Returns '' when there is nothing worth suggesting,
   * which is a normal answer, not a failure.
   */
  async complete(before, after) {
    if (!status.mode || status.mode === 'none' || !before.trim()) return '';
    const text = await api.aiComplete(before, after);
    return typeof text === 'string' ? text : '';
  },
  async rewrite(text, instruction) {
    if (!status.mode || status.mode === 'none') throw new Error('还没有配置 AI 服务');
    const result = await api.aiRewrite(text, instruction);
    return typeof result === 'string' ? result : '';
  },
};
