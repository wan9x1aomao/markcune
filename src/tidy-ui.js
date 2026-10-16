// "Tidy format": the command and the floating button that offers it. Text logic lives in tidy.js.
// The model is chosen and configured by the gateway behind api.aiLabel; this page only sends lines and gets labels.
import { api } from './bridge.js';
import { applyLabels, chunkLines, needsTidy, ruleLabels, sameWords, splitLines, validateLabels } from './tidy.js';
import { toast } from './ui.js';

const MAX_CHECK_CHARS = 200_000; // beyond this the button check is skipped to keep typing smooth

/** Labels for all lines: the gateway when it is available and answers well, the rules otherwise. */
export async function labelLines(lines, { onProgress } = {}) {
  const rules = ruleLabels(lines);
  const configured = await api.aiAvailable().catch(() => false);
  if (!configured) return { labels: rules, ai: false, configured: false, failed: 0 };
  const labels = [...rules];
  const chunks = chunkLines(lines);
  let failed = 0;
  let firstError = '';
  onProgress?.(0, chunks.length);
  for (const [index, [from, to]] of chunks.entries()) {
    const part = lines.slice(from, to);
    try {
      const checked = validateLabels(await api.aiLabel(part), part);
      if (!checked) throw new Error('标签对不上原文');
      checked.forEach((label, i) => (labels[from + i] = label));
    } catch (error) {
      // This chunk keeps the rule labels; the others still use the service.
      failed++;
      firstError ||= String(error);
    }
    onProgress?.(index + 1, chunks.length);
  }
  return { labels, ai: failed < chunks.length, configured: true, failed, error: firstError };
}

/** Tidies the document in `editor`. One replace, so one undo brings the old text back. Returns true when it changed the text. */
export async function tidyDocument(editor, { onProgress } = {}) {
  const before = editor.getMarkdown();
  if (!before.trim()) {
    toast('文档是空的');
    return false;
  }
  const lines = splitLines(before);
  const { labels, ai, configured, failed, error } = await labelLines(lines, { onProgress });
  const after = applyLabels(lines, labels);
  // Safety net: markers and blank lines may change, words may not.
  if (!sameWords(before, after)) {
    toast('整理结果和原文的文字对不上，已放弃，原文没有改动');
    return false;
  }
  if (after.trim() === before.trim()) {
    toast('格式已经很整齐了');
    return false;
  }
  editor.setMarkdown(after);
  const how = ai ? (failed ? `AI 整理（${failed} 段改用规则：${error}）` : 'AI 整理') : configured ? `规则整理（AI 没有成功：${error}）` : '规则整理';
  toast(`已${how}，可以用撤销恢复`, configured && !ai ? 8000 : 4000);
  return true;
}

const NS = 'http://www.w3.org/2000/svg';
const GAP = 5; // space between the button and the progress ring
const STROKE = 3;
const LABEL = '<span class="spark">✦</span> 一键整理';
const HOLD_MS = 1100; // how long a finished ring stays on screen so 100% can be seen
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The floating button. It pops in a moment after editing stops when the text looks untidy, and goes away when it is
 * tidy again, when the user closes it for this document, or when a tidy finishes. While a tidy runs, a ring around the
 * button fills as the work goes: one full lap is 100%. With nothing to measure (a single request) an arc circles instead.
 */
export function createTidyHint({ button, getEditor, docKey }) {
  const dismissed = new Set();
  let timer;
  let running = false;
  const go = button.querySelector('.go');

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'ring');
  svg.setAttribute('aria-hidden', 'true');
  const track = document.createElementNS(NS, 'path');
  const arc = document.createElementNS(NS, 'path');
  for (const [el, cls] of [[track, 'track'], [arc, 'arc']]) {
    el.setAttribute('class', cls);
    el.setAttribute('pathLength', '100'); // so dash lengths are percentages whatever the button size
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke-width', String(STROKE));
    el.setAttribute('stroke-linecap', 'round');
    svg.appendChild(el);
  }
  button.appendChild(svg);

  /** A pill outline around the button that starts at the top centre and runs clockwise. */
  function fitRing() {
    const { width, height } = button.getBoundingClientRect();
    const w = width + GAP * 2;
    const h = height + GAP * 2;
    const m = STROKE / 2;
    const r = h / 2 - m;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.style.cssText = `width:${w}px;height:${h}px;left:${-GAP}px;top:${-GAP}px`;
    const d = `M ${w / 2} ${m} H ${w - m - r} A ${r} ${r} 0 0 1 ${w - m - r} ${h - m} H ${m + r} A ${r} ${r} 0 0 1 ${m + r} ${m} Z`;
    track.setAttribute('d', d);
    arc.setAttribute('d', d);
  }

  function setProgress(done, total) {
    if (total > 1) {
      const percent = Math.round((done / total) * 100);
      button.classList.remove('spinning');
      arc.setAttribute('stroke-dasharray', `${percent} ${100 - percent + 0.01}`);
      go.textContent = `整理中 ${percent}%`;
    } else {
      // One request: there is nothing to measure, so an arc circles the button.
      button.classList.add('spinning');
      arc.setAttribute('stroke-dasharray', '22 78');
      go.textContent = '整理中…';
    }
  }

  const hide = () => button.classList.remove('show');

  async function check() {
    const editor = getEditor();
    if (!editor || running || dismissed.has(docKey())) return hide();
    const text = await (editor.getMarkdownAsync?.() ?? editor.getMarkdown());
    if (text.length > MAX_CHECK_CHARS) return hide();
    const ai = await api.aiAvailable().catch(() => false);
    // Re-read after awaiting: the editor may have been replaced meanwhile.
    if (getEditor() !== editor) return;
    const show = needsTidy(text, ai);
    button.hidden = false;
    // Pop in only when it was not already showing, so typing does not replay the animation.
    button.classList.toggle('show', show);
  }

  async function run() {
    const editor = getEditor();
    if (!editor || running) return;
    running = true;
    go.disabled = true;
    // Lock the width at the widest label so the ring keeps its shape while the text changes.
    button.classList.add('busy');
    go.textContent = '整理完成 100%'; // the widest label, measured once
    button.style.minWidth = `${button.getBoundingClientRect().width}px`;
    fitRing();
    setProgress(0, 1);
    try {
      const changed = await tidyDocument(editor, { onProgress: setProgress });
      if (changed) {
        // A full lap and a moment to look at it, before the button goes away.
        button.classList.remove('spinning');
        arc.setAttribute('stroke-dasharray', '100 0.01');
        go.textContent = '整理完成 100%';
        await wait(HOLD_MS);
      }
    } catch (error) {
      toast(`整理失败：${error}`);
    } finally {
      running = false;
      go.disabled = false;
      button.classList.remove('busy', 'spinning');
      button.style.removeProperty('min-width');
      go.innerHTML = LABEL;
      hide();
      schedule(300);
    }
  }

  function schedule(delay = 1500) {
    clearTimeout(timer);
    timer = setTimeout(() => check().catch(() => hide()), delay);
  }

  go.addEventListener('click', run);
  button.querySelector('.close').addEventListener('click', () => {
    dismissed.add(docKey());
    hide();
  });
  return { schedule, run, hide };
}
