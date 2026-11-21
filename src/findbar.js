// Find and replace bar, working with whichever editor is active.
import { icons } from './icons.js';

export function createFindbar(el, { getEditor }) {
  const query = el.querySelector('.query');
  const replacement = el.querySelector('.replacement');
  const count = el.querySelector('.count');
  let sequence = 0;
  el.querySelector('.previous').innerHTML = icons.up;
  el.querySelector('.next').innerHTML = icons.down;
  el.querySelector('.toggle-replace').innerHTML = icons.replace;
  el.querySelector('.close').innerHTML = icons.close;

  const show = (info) => {
    if (!info || !query.value) count.textContent = '';
    else count.textContent = info.count ? `${info.index + 1}/${info.count}` : '无结果';
  };
  const update = (result) => {
    const id = ++sequence;
    if (!result?.then) return show(result);
    count.textContent = '';
    result.then((info) => { if (!el.hidden && id === sequence) show(info); }).catch(() => {});
  };
  const editable = () => getEditor()?.kind !== 'reader';
  const search = () => update(getEditor()?.find.set(query.value));

  const api = {
    get open() {
      return !el.hidden;
    },
    show(withReplace) {
      el.hidden = false;
      el.classList.toggle('with-replace', withReplace && editable());
      const selection = window.getSelection()?.toString();
      if (selection && !selection.includes('\n') && selection.length < 100) query.value = selection;
      query.focus();
      query.select();
      search();
    },
    close() {
      if (el.hidden) return;
      el.hidden = true;
      sequence++;
      getEditor()?.find.finish();
    },
    go(delta) {
      if (el.hidden) return api.show(false);
      update(getEditor()?.find.go(delta));
    },
    /** Re-applies the query after the editor was replaced. */
    refresh() {
      if (!editable()) el.classList.remove('with-replace');
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
    if (event.key === 'Enter' && editable()) show(getEditor()?.find.replace(replacement.value));
    else if (event.key === 'Escape') api.close();
    else return;
    event.preventDefault();
  });
  el.querySelector('.previous').addEventListener('click', () => api.go(-1));
  el.querySelector('.next').addEventListener('click', () => api.go(1));
  el.querySelector('.close').addEventListener('click', () => api.close());
  el.querySelector('.toggle-replace').addEventListener('click', () => {
    if (!editable()) return;
    el.classList.toggle('with-replace');
    if (el.classList.contains('with-replace')) replacement.focus();
  });
  el.querySelector('.replace-one').addEventListener('click', () => { if (editable()) show(getEditor()?.find.replace(replacement.value)); });
  el.querySelector('.replace-all').addEventListener('click', () => { if (editable()) show(getEditor()?.find.replaceAll(replacement.value)); });
  return api;
}
