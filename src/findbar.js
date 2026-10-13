// Find and replace bar, working with whichever editor is active.
import { icons } from './icons.js';

export function createFindbar(el, { getEditor }) {
  const query = el.querySelector('.query');
  const replacement = el.querySelector('.replacement');
  const count = el.querySelector('.count');
  el.querySelector('.previous').innerHTML = icons.up;
  el.querySelector('.next').innerHTML = icons.down;
  el.querySelector('.toggle-replace').innerHTML = icons.replace;
  el.querySelector('.close').innerHTML = icons.close;

  const show = (info) => {
    if (!info || !query.value) count.textContent = '';
    else count.textContent = info.count ? `${info.index + 1}/${info.count}` : '无结果';
  };
  const search = () => show(getEditor()?.find.set(query.value));

  const api = {
    get open() {
      return !el.hidden;
    },
    show(withReplace) {
      el.hidden = false;
      el.classList.toggle('with-replace', withReplace);
      const selection = window.getSelection()?.toString();
      if (selection && !selection.includes('\n') && selection.length < 100) query.value = selection;
      query.focus();
      query.select();
      search();
    },
    close() {
      if (el.hidden) return;
      el.hidden = true;
      getEditor()?.find.finish();
    },
    go(delta) {
      if (el.hidden) return api.show(false);
      show(getEditor()?.find.go(delta));
    },
    /** Re-applies the query after the editor was replaced. */
    refresh() {
      if (!el.hidden) search();
    },
  };

  query.addEventListener('input', search);
  query.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Enter') api.go(event.shiftKey ? -1 : 1);
    else if (event.key === 'Escape') api.close();
    else return;
    event.preventDefault();
  });
  replacement.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Enter') show(getEditor()?.find.replace(replacement.value));
    else if (event.key === 'Escape') api.close();
    else return;
    event.preventDefault();
  });
  el.querySelector('.previous').addEventListener('click', () => api.go(-1));
  el.querySelector('.next').addEventListener('click', () => api.go(1));
  el.querySelector('.close').addEventListener('click', () => api.close());
  el.querySelector('.toggle-replace').addEventListener('click', () => {
    el.classList.toggle('with-replace');
    if (el.classList.contains('with-replace')) replacement.focus();
  });
  el.querySelector('.replace-one').addEventListener('click', () => show(getEditor()?.find.replace(replacement.value)));
  el.querySelector('.replace-all').addEventListener('click', () => show(getEditor()?.find.replaceAll(replacement.value)));
  return api;
}
