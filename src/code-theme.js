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

/**
 * The editor takes its colours from CSS variables (declared in style.css, one set per theme), so a
 * theme switch recolours code blocks that are already open. CodeMirror bakes its theme in at
 * creation time, so literal colours would leave every existing block in the old theme until the
 * document was reopened.
 */
const VARS = {
  text: '--cm-text',
  comment: '--cm-comment',
  keyword: '--cm-keyword',
  string: '--cm-string',
  number: '--cm-number',
  function: '--cm-function',
  type: '--cm-type',
  property: '--cm-property',
  tag: '--cm-tag',
  heading: '--cm-heading',
  invalid: '--cm-invalid',
  selection: '--cm-selection',
  caret: '--cm-caret',
};
const LIVE = Object.fromEntries(Object.entries(VARS).map(([key, name]) => [key, `var(${name})`]));

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

/** CodeMirror extensions for the code blocks in the rich editor. Colours follow the CSS variables. */
export function codeTheme() {
  const style = HighlightStyle.define(
    GROUPS.flatMap(([tags, key, extra]) => tags.map((tag) => ({ tag, color: LIVE[key], ...extra }))),
  );
  // The `dark` flag only picks CodeMirror's own light/dark defaults (tooltips, panels); every colour
  // we care about comes from the variables above.
  const dark = document.documentElement.dataset.theme === 'dark';
  return [editorTheme(LIVE, dark), syntaxHighlighting(style)];
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
