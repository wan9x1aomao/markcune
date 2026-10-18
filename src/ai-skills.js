// The rewrite commands, and the small button that appears next to a selection.
//
// There is no chat panel: a selection plus one click is the whole interface.
// The instructions below are rewritten for this editor, not copied from anywhere.
import { onAiChange, ai } from './ai-core.js';
import { blocksIn, propose, proposeEach, proposePrevious } from './ai-proposal.js';
import { showMenu } from './ui.js';

/** `instruction` is the sentence the model receives; keep it short and about the text, not the UI. */
export const SKILLS = [
  { id: 'polish', label: '润色', hint: '更通顺，不改意思', instruction: '把这段文字改得更通顺自然，保持原意、语气和信息量不变。' },
  { id: 'tighten', label: '精简', hint: '删掉冗余', instruction: '删掉冗余和重复的表述，让句子更紧，但不要丢掉任何信息。' },
  { id: 'formal', label: '更正式', hint: '书面表达', instruction: '把这段文字改成正式、书面的表达，适合文档或公文。' },
  { id: 'casual', label: '更轻松', hint: '口语一点', instruction: '把这段文字改得更轻松、口语化，像在跟人讲话。' },
  { id: 'english', label: '译成英文', hint: '保留 Markdown', instruction: '把这段文字翻译成自然的英文，保留 Markdown 标记。' },
  { id: 'fix', label: '改错别字', hint: '只动错字和标点', instruction: '只修正错别字和标点，其余一字不改。' },
];

/**
 * The user's own rewrites, added in the settings panel. They are ordinary instructions typed by the
 * user and sent like any other — the shell still owns the built-in prompts above.
 */
export function customSkills() {
  const list = Array.isArray(ai.status.custom) ? ai.status.custom : [];
  return list
    .filter((item) => item && typeof item.instruction === 'string' && item.instruction.trim())
    .map((item, index) => ({
      id: `custom-${index + 1}`,
      label: String(item.label || '').trim() || `自定义 ${index + 1}`,
      hint: '自定义',
      instruction: String(item.instruction).trim(),
      custom: true,
    }));
}

/** Built-in skills first, then the user's own. */
export function allSkills() {
  return [...SKILLS, ...customSkills()];
}

/** How many paragraphs the current selection touches, or 0 when it cannot be split. */
function selectedBlocks(view) {
  const { from, to } = view.state.selection;
  if (from === to) return 0;
  return blocksIn(view.state.doc, from, to)?.length ?? 0;
}

/** Opens the skill list at `anchor`. `mode` decides what happens after a skill is picked. */
export function openSkillMenu(view, mode, anchor, title) {
  const run = (skill) => (mode === 'each' ? proposeEach(view, skill.instruction, skill.label) : propose(view, skill.instruction, skill.label));
  const items = allSkills().map((skill) => ({
    label: skill.label,
    hint: skill.hint,
    run: () => run(skill),
  }));
  if (mode !== 'each') {
    const count = selectedBlocks(view);
    if (count > 1) {
      // One request per paragraph, then a list to settle them in. Only offered when there is more
      // than one paragraph: for a single one it is just a slower rewrite.
      items.push('separator', {
        label: `逐段改写（${count} 段）…`,
        hint: '每段一条建议',
        run: () => openSkillMenu(view, 'each', anchor, '逐段改写：选一个技能'),
      });
    }
  }
  showMenu(items, anchor, { title: title ?? (mode === 'each' ? '逐段改写：选一个技能' : '改写选中文字') });
}

/**
 * Shows a small "AI" button next to a non-empty selection while AI is configured.
 * Clicking it lists the skills; choosing one sends the selection away and shows a proposal.
 */
export function installAiActions(view) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ai-pick';
  button.title = '用 AI 改写选中的文字';
  button.textContent = 'AI';
  button.hidden = true;
  document.body.appendChild(button);

  const hide = () => {
    button.hidden = true;
  };

  const place = () => {
    if (!ai.available() || !view.hasFocus()) return hide();
    const { from, to } = view.state.selection;
    if (from === to) return hide();
    let box;
    try {
      box = view.coordsAtPos(to);
    } catch {
      return hide();
    }
    if (box.bottom < 0 || box.top > window.innerHeight) return hide();
    button.hidden = false;
    button.style.left = `${Math.min(box.right + 6, window.innerWidth - 44)}px`;
    button.style.top = `${Math.min(box.bottom - 24, window.innerHeight - 32)}px`;
  };

  let frame = 0;
  const refresh = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(place);
  };

  document.addEventListener('selectionchange', refresh);
  window.addEventListener('scroll', refresh, { capture: true, passive: true });
  window.addEventListener('resize', refresh);
  const stopWatching = onAiChange(refresh);

  // mousedown would collapse the selection we are about to use.
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', () => {
    // Measure before hiding: a hidden element reports a zero rect, which pins the menu to the corner.
    const box = button.getBoundingClientRect();
    hide();
    openSkillMenu(view, 'single', { x: box.left, y: box.bottom + 4, origin: 'top left' });
  });

  return {
    destroy() {
      document.removeEventListener('selectionchange', refresh);
      window.removeEventListener('scroll', refresh, { capture: true });
      window.removeEventListener('resize', refresh);
      stopWatching();
      cancelAnimationFrame(frame);
      button.remove();
    },
  };
}

/** Command-palette entries, so a keyboard-only user never needs the button. */
export function skillCommands(view) {
  const items = allSkills().map((skill) => ({
    id: `ai-${skill.id}`,
    title: `AI 改写：${skill.label}`,
    hint: skill.hint,
    keys: '',
    run: () => propose(view, skill.instruction, skill.label),
  }));
  items.push({
    id: 'ai-each',
    title: 'AI 逐段改写…',
    hint: '每段一条建议',
    keys: '',
    run: () => {
      const { from } = view.state.selection;
      let point = { x: 80, y: 120 };
      try {
        const box = view.coordsAtPos(from);
        point = { x: box.left, y: box.bottom + 4, origin: 'top left' };
      } catch {
        // A caret outside the viewport still gets a usable menu.
      }
      openSkillMenu(view, 'each', point);
    },
  });
  return items;
}

/**
 * The slash-menu entries. A slash command can only be typed in a block that holds nothing but the
 * command, so it acts on the paragraph above — the one the user just finished writing.
 * Returns nothing at all when AI is not configured: an unused feature leaves no trace in the menu.
 */
export function slashItems() {
  if (!ai.available()) return [];
  return allSkills().map((skill) => ({
    key: `ai-${skill.id}`,
    label: `${skill.label}（上一段）`,
    run: (view) => proposePrevious(view, skill.instruction, skill.label),
  }));
}
