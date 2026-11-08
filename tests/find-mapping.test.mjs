// A multi-step transaction's changed ranges must be mapped onto the final document.
import assert from 'node:assert/strict';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState } from '@milkdown/kit/prose/state';
import { search, searchEdited } from '../src/plugins.js';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
  },
});

const paragraph = (text) => schema.node('paragraph', null, text ? schema.text(text) : null);
const doc = schema.node('doc', null, [paragraph('find stays'), paragraph('tail')]);
const state = EditorState.create({ schema, doc });
const before = search(state.doc, 'find');
assert.equal(before.length, 1);

let tr = state.tr.insertText('find ', state.doc.content.size - 1);
const atStart = tr.mapping.map(1);
tr = tr.insertText('0123456789', atStart);
const edited = searchEdited(tr.doc, 'find', before, tr);
const full = search(tr.doc, 'find');
assert.equal(full.length, 2);
assert.deepEqual(edited, full);

console.log('find mapping ok');
