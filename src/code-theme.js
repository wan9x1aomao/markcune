// Code block colors: one palette for the editor (CodeMirror theme) and for exported HTML/PDF.
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tagHighlighter, tags as t } from '@lezer/highlight';

export const PALETTES = {
  light: {
    text: '#24292f',
    comment: '#6e7781',
    keyword: '#cf222e',
    string: '#0a3069',
    number: '#0550ae',
    function: '#8250df',
    type: '#953800',
    property: '#0550ae',
    tag: '#116329',
    heading: '#0550ae',
    invalid: '#82071e',
    selection: 'rgba(59, 108, 246, 0.18)',
    caret: '#3b6cf6',
  },
  dark: {
    text: '#e6edf3',
    comment: '#8b949e',
    keyword: '#ff7b72',
    string: '#a5d6ff',
    number: '#79c0ff',
    function: '#d2a8ff',
    type: '#ffa657',
    property: '#79c0ff',
    tag: '#7ee787',
    heading: '#79c0ff',
    invalid: '#ffa198',
    selection: 'rgba(143, 168, 255, 0.24)',
    caret: '#8fa8ff',
  },
};

/** Token groups: lezer tags → palette key. The export uses the same groups via `tok-*` classes. */
const GROUPS = [
  [[t.comment, t.lineComment, t.blockComment, t.docComment, t.meta], 'comment', { fontStyle: 'italic' }],
  [[t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier, t.self, t.null, t.bool], 'keyword'],
  [[t.string, t.special(t.string), t.regexp, t.escape, t.character, t.url], 'string'],
  [[t.number, t.integer, t.float, t.atom, t.constant(t.name), t.unit], 'number'],
  [[t.function(t.variableName), t.function(t.propertyName), t.macroName, t.labelName], 'function'],
  [[t.typeName, t.className, t.namespace, t.definition(t.typeName), t.annotation], 'type'],
  [[t.propertyName, t.attributeName, t.definition(t.propertyName)], 'property'],
  [[t.tagName, t.angleBracket, t.inserted], 'tag'],
  [[t.heading, t.strong], 'heading', { fontWeight: '600' }],
  [[t.emphasis], 'text', { fontStyle: 'italic' }],
  [[t.link], 'string', { textDecoration: 'underline' }],
  [[t.invalid, t.deleted], 'invalid'],
];

function editorTheme(palette, dark) {
  return EditorView.theme(
    {
      '&': { color: palette.text, backgroundColor: 'transparent' },
      '.cm-scroller': { fontFamily: 'var(--font-code)', lineHeight: '1.7' },
      '.cm-content': { caretColor: palette.caret, padding: '0' },
      '.cm-line': { padding: '0' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: palette.caret, borderLeftWidth: '2px' },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
        { backgroundColor: palette.selection },
      '.cm-activeLine': { backgroundColor: 'transparent' },
      '.cm-gutters': { display: 'none' },
      '&.cm-focused .cm-matchingBracket': { backgroundColor: palette.selection, outline: 'none' },
      '.cm-tooltip': { border: 'none', borderRadius: '10px' },
    },
    { dark },
  );
}

/** CodeMirror extensions for the code blocks in the rich editor. */
export function codeTheme(dark) {
  const palette = PALETTES[dark ? 'dark' : 'light'];
  const style = HighlightStyle.define(
    GROUPS.flatMap(([tags, key, extra]) => tags.map((tag) => ({ tag, color: palette[key], ...extra }))),
  );
  return [editorTheme(palette, dark), syntaxHighlighting(style)];
}

/** Highlighter for static (export) highlighting: same groups as the editor, as `tok-<group>` classes. */
export const exportHighlighter = tagHighlighter(
  GROUPS.flatMap(([tags, key]) => tags.map((tag) => ({ tag, class: `tok-${key}` }))),
);

const cssProps = (extra = {}) =>
  Object.entries(extra)
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}: ${v};`)
    .join(' ');

/** CSS for `exportHighlighter` classes, scoped under `scope`. */
export function tokenCss(scope, palette = PALETTES.light) {
  const seen = new Set();
  return GROUPS.filter(([, key]) => !seen.has(key) && seen.add(key))
    .map(([, key, extra]) => `${scope} .tok-${key} { color: ${palette[key]}; ${cssProps(extra)} }`)
    .join('\n');
}
