// Source mode: the raw markdown in CodeMirror. Loaded on demand.
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { EditorSelection, EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, drawSelection, keymap } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { countMarkdownWords } from './count.js';

const style = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.45em', fontWeight: '700' },
  { tag: tags.heading2, fontSize: '1.3em', fontWeight: '700' },
  { tag: tags.heading3, fontSize: '1.15em', fontWeight: '700' },
  { tag: tags.heading, fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url], color: 'var(--accent)' },
  { tag: tags.quote, color: 'var(--text-muted)' },
  { tag: tags.monospace, color: '#c2410c' },
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator, tags.labelName], color: 'var(--text-faint)' },
  { tag: [tags.keyword, tags.operatorKeyword], color: '#8250df' },
  { tag: [tags.string, tags.special(tags.string)], color: '#0a7f4f' },
  { tag: tags.comment, color: 'var(--text-faint)', fontStyle: 'italic' },
  { tag: [tags.number, tags.bool, tags.null], color: '#b35900' },
  { tag: [tags.function(tags.variableName), tags.typeName, tags.className], color: '#2f6fde' },
]);

const WRAPPERS = { bold: '**', italic: '*', strikethrough: '~~', 'inline-code': '`' };

// Find highlighting, independent of CodeMirror's search panel.
const setFind = StateEffect.define();
const findField = StateField.define({
  create: () => ({ query: '', matches: [], index: 0, decorations: Decoration.none }),
  update(value, tr) {
    let { query, index } = value;
    let recompute = tr.docChanged && Boolean(query);
    for (const effect of tr.effects) {
      if (!effect.is(setFind)) continue;
      if (effect.value.query !== undefined) {
        query = effect.value.query;
        recompute = true;
      }
      if (effect.value.index !== undefined) index = effect.value.index;
    }
    let { matches } = value;
    if (recompute) {
      matches = [];
      if (query) {
        const text = tr.state.doc.toString().toLowerCase();
        const needle = query.toLowerCase();
        for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) {
          matches.push({ from: i, to: i + needle.length });
        }
      }
    }
    index = Math.min(Math.max(index, 0), Math.max(matches.length - 1, 0));
    if (!recompute && index === value.index) return value;
    const decorations = Decoration.set(
      matches.map((m, i) => Decoration.mark({ class: i === index ? 'find-match find-current' : 'find-match' }).range(m.from, m.to)),
    );
    return { query, matches, index, decorations };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

function headingsOf(doc) {
  const headings = [];
  let fence = null;
  for (let n = 1; n <= doc.lines; n++) {
    const text = doc.line(n).text;
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(text);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(text);
    if (heading) headings.push({ level: heading[1].length, text: heading[2], line: n });
  }
  return headings;
}

/** Same interface as the rich editor. Options: root, content, scroller, onChange. */
export function createSourceEditor({ root, content, scroller, onChange }) {
  const view = new EditorView({
    parent: root,
    state: EditorState.create({
      doc: content,
      extensions: [
        history(),
        drawSelection(),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        syntaxHighlighting(style),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        findField,
        EditorView.contentAttributes.of({ spellcheck: 'false' }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange?.();
        }),
      ],
    }),
  });

  const findState = () => view.state.field(findField);
  const findInfo = () => ({ count: findState().matches.length, index: findState().index });
  const reveal = (match) =>
    view.dispatch({ effects: EditorView.scrollIntoView(match.from, { y: 'center' }) });

  return {
    kind: 'source',
    view,
    getMarkdown: () => view.state.doc.toString(),
    getWordCount: () => countMarkdownWords(view.state.doc.toString()),
    getMarkdownAsync: async (snapshot = view.state.doc) => snapshot.toString(),
    snapshot: () => view.state.doc,
    matches: (snapshot) => !!snapshot && (snapshot === view.state.doc || view.state.doc.eq(snapshot)),
    setMarkdown: (text) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }),
    focus: () => view.focus(),
    command(id) {
      if (id === 'undo') undo(view);
      else if (id === 'redo') redo(view);
      else if (WRAPPERS[id]) {
        const wrap = WRAPPERS[id];
        view.dispatch(
          view.state.changeByRange((range) => {
            const text = view.state.sliceDoc(range.from, range.to);
            const wrapped = text.startsWith(wrap) && text.endsWith(wrap) && text.length >= wrap.length * 2;
            const insert = wrapped ? text.slice(wrap.length, -wrap.length) : wrap + text + wrap;
            const from = range.from;
            return {
              changes: { from, to: range.to, insert },
              // An empty selection puts the cursor between the new markers.
              range: range.empty
                ? EditorSelection.cursor(from + wrap.length)
                : EditorSelection.range(from, from + insert.length),
            };
          }),
        );
      }
      view.focus();
    },
    headings: () => headingsOf(view.state.doc),
    scrollToHeading(heading) {
      const line = view.state.doc.line(heading.line);
      view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'start' }) });
      view.focus();
    },
    activeHeading(headings) {
      const block = view.lineBlockAtHeight(scroller.scrollTop + 80 - view.documentPadding.top);
      const line = view.state.doc.lineAt(block.from).number;
      let active = -1;
      headings.forEach((heading, i) => {
        if (heading.line <= line) active = i;
      });
      return active;
    },
    getPosition: () => ({ mode: 'source', anchor: view.state.selection.main.head, scrollTop: scroller.scrollTop }),
    setPosition(position) {
      if (position?.mode === 'source' && typeof position.anchor === 'number') {
        view.dispatch({ selection: { anchor: Math.min(position.anchor, view.state.doc.length) } });
      }
      if (typeof position?.scrollTop === 'number') {
        // Wait for CodeMirror to measure before restoring the scroll offset.
        requestAnimationFrame(() => (scroller.scrollTop = position.scrollTop));
      }
    },
    find: {
      set(query) {
        view.dispatch({ effects: setFind.of({ query, index: 0 }) });
        const { matches } = findState();
        if (matches.length) reveal(matches[0]);
        return findInfo();
      },
      go(delta) {
        const { matches, index } = findState();
        if (!matches.length) return findInfo();
        const next = (index + delta + matches.length) % matches.length;
        view.dispatch({ effects: setFind.of({ index: next }) });
        reveal(matches[next]);
        return findInfo();
      },
      replace(text) {
        const { matches, index } = findState();
        const match = matches[index];
        if (match) view.dispatch({ changes: { from: match.from, to: match.to, insert: text } });
        const { matches: rest, index: next } = findState();
        if (rest[next]) reveal(rest[next]);
        return findInfo();
      },
      replaceAll(text) {
        const { matches } = findState();
        view.dispatch({ changes: matches.map((m) => ({ from: m.from, to: m.to, insert: text })) });
        return findInfo();
      },
      finish() {
        const { matches, index } = findState();
        const match = matches[index];
        view.dispatch({
          effects: setFind.of({ query: '' }),
          selection: match ? { anchor: match.from, head: match.to } : undefined,
        });
        view.focus();
      },
    },
    destroy() {
      view.destroy();
    },
  };
}
