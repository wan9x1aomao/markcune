// The review list: every pending proposal in one place.
//
// A single proposal has its own bar and needs no list. A batch — one proposal per paragraph — does:
// the user wants to see how many there are, jump to one, and settle them in any order. The list is
// plain DOM, rebuilt whenever the proposal set changes, because it never holds more than eight rows.
import { accept, acceptAll, activeProposal, focusProposal, onProposals, reject, rejectAll } from './ai-proposal.js';

let panel = null;
let view = null;
let list = [];
let dismissed = false;

/** Mounts the list on one editor. Returns the teardown. */
export function installReview(editorView) {
  view = editorView;
  const off = onProposals((items) => {
    list = items;
    if (!items.length) dismissed = false;
    render();
  });
  return () => {
    off();
    panel?.remove();
    panel = null;
  };
}

/** Hides the list without settling anything; the proposals stay in the document. */
export function dismissReview() {
  dismissed = true;
  render();
}

function excerpt(text, max = 60) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function element(tagName, className, content) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function row(proposal) {
  const wrap = element('div', 'ai-review-row' + (proposal.id === activeProposal() ? ' is-active' : ''));
  wrap.dataset.id = proposal.id;

  const jump = element('button', 'ai-review-jump');
  jump.type = 'button';
  jump.dataset.act = 'jump';
  jump.title = proposal.instruction;
  jump.append(
    element('span', 'ai-review-label', proposal.label || '改写'),
    element('span', 'ai-review-old', excerpt(proposal.source)),
    element('span', 'ai-review-new', excerpt(proposal.text)),
  );

  const actions = element('span', 'ai-review-actions');
  for (const [act, label] of [
    ['accept', '采纳'],
    ['reject', '拒绝'],
  ]) {
    const button = element('button', 'ai-review-' + act, label);
    button.type = 'button';
    button.dataset.act = act;
    actions.appendChild(button);
  }
  wrap.append(jump, actions);
  return wrap;
}

function build() {
  const root = element('div', 'ai-review');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'AI 改写建议');

  const head = element('div', 'ai-review-head');
  head.append(element('span', 'ai-review-title', 'AI 建议'), element('span', 'ai-review-count', String(list.length)));
  const close = element('button', 'ai-review-close', '×');
  close.type = 'button';
  close.title = '收起（建议保留在文档里）';
  close.dataset.act = 'close';
  head.appendChild(close);

  const body = element('div', 'ai-review-list');
  for (const proposal of list) body.appendChild(row(proposal));

  const foot = element('div', 'ai-review-foot');
  foot.append(
    element('span', 'ai-review-tip', '逐条采纳，或一次全收'),
    (() => {
      const all = element('button', 'ai-review-all', '全部采纳');
      all.type = 'button';
      all.dataset.act = 'all';
      return all;
    })(),
    (() => {
      const none = element('button', 'ai-review-none', '全部拒绝');
      none.type = 'button';
      none.dataset.act = 'none';
      return none;
    })(),
  );

  root.append(head, body, foot);
  root.addEventListener('mousedown', (event) => {
    // Clicking the list must not take the selection away from the proposal it is about to settle.
    if (event.target.closest('button')) event.preventDefault();
  });
  root.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || !view) return;
    const act = button.dataset.act;
    const id = button.closest('.ai-review-row')?.dataset.id;
    if (act === 'close') dismissReview();
    else if (act === 'all') acceptAll(view);
    else if (act === 'none') rejectAll(view);
    else if (act === 'jump' && id) focusProposal(view, id);
    else if (act === 'accept' && id) accept(view, id);
    else if (act === 'reject' && id) reject(view, id);
  });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      dismissReview();
    }
  });
  return root;
}

function render() {
  if (!view || dismissed || list.length < 2) {
    panel?.remove();
    panel = null;
    return;
  }
  panel?.remove();
  panel = build();
  document.body.appendChild(panel);
}
