import assert from 'node:assert/strict';
import { computeCaretBox, resolveSmoothCaretTarget } from '../src/smooth-caret.js';

assert.deepEqual(
  computeCaretBox({ left: 120.3, top: 240.6, height: 22 }, 16),
  { x: 120.5, y: 240.5, height: 22 },
);
assert.deepEqual(
  computeCaretBox({ left: 210.4, top: 100, bottom: 122 }, 16),
  { x: 210.5, y: 100, height: 22 },
  'supports ProseMirror/CodeMirror coordsAtPos rects with top/bottom',
);
assert.deepEqual(
  computeCaretBox({ left: 80, top: 100, height: 30 }, 16),
  { x: 80, y: 104, height: 22 },
  'centers caret height within taller line boxes and clamps to 1.38x fontSize',
);
assert.deepEqual(
  computeCaretBox({ left: 40, top: 50, height: 10 }, 12),
  { x: 40, y: 50, height: 15 },
  'enforces minimum readable caret height',
);
assert.equal(computeCaretBox(null, 16), null);

assert.equal(resolveSmoothCaretTarget(null), null);
assert.equal(resolveSmoothCaretTarget({ nodeType: 1, tagName: 'INPUT', type: 'checkbox', disabled: false, readOnly: false }), null);
const textInput = { nodeType: 1, tagName: 'INPUT', type: 'text', disabled: false, readOnly: false };
assert.equal(resolveSmoothCaretTarget(textInput), textInput);
const editable = { nodeType: 1, tagName: 'DIV', isContentEditable: true, closest: () => null };
assert.equal(resolveSmoothCaretTarget(editable), editable);

console.log('smooth caret model ok');
