import assert from 'node:assert/strict';
import { createPrintLock, finishNativePrint, nativePrintEnd, restoresEditor, settleImage } from '../src/print-session.js';

assert.equal(nativePrintEnd('macos'), 'print-finished');
assert.equal(nativePrintEnd('windows'), 'afterprint');
assert.equal(nativePrintEnd('linux'), 'command');
for (const reason of ['finished', 'cancelled', 'error']) assert.equal(restoresEditor(reason), true);

class Bus {
  constructor() {
    this.listeners = new Map();
  }
  add(name, fn) {
    const list = this.listeners.get(name) ?? [];
    list.push(fn);
    this.listeners.set(name, list);
    return () => {
      this.listeners.set(name, (this.listeners.get(name) ?? []).filter((item) => item !== fn));
    };
  }
  emit(name, success) {
    for (const fn of this.listeners.get(name) ?? []) fn(success);
  }
}

const mac = new Bus();
let macStarted = 0;
const macRun = finishNativePrint('macos', {
  start: () => {
    macStarted += 1;
  },
  listenFinished: (fn) => mac.add('print-finished', fn),
});
await Promise.resolve();
assert.equal(macStarted, 1, 'the panel starts only after the completion listener is attached');
let macResult;
const macDone = macRun.then((reason) => {
  macResult = reason;
});
await Promise.resolve();
assert.equal(macResult, undefined, 'closing the panel is what ends the session');
mac.emit('print-finished', false);
await macDone;
assert.equal(macResult, 'cancelled');

const printed = new Bus();
const printedRun = finishNativePrint('macos', {
  start: () => {},
  listenFinished: (fn) => printed.add('print-finished', fn),
});
queueMicrotask(() => printed.emit('print-finished', true));
assert.equal(await printedRun, 'finished');

const windows = new Bus();
const windowsRun = finishNativePrint('windows', {
  start: () => {},
  listenAfterprint: (fn) => windows.add('afterprint', fn),
});
queueMicrotask(() => windows.emit('afterprint'));
assert.equal(await windowsRun, 'finished');

assert.equal(
  await finishNativePrint('linux', {
    start: async () => {},
  }),
  'finished',
);

await assert.rejects(
  finishNativePrint('linux', {
    start: async () => {
      throw new Error('print failed');
    },
  }),
);

const other = new Bus();
const firstWindow = finishNativePrint('macos', {
  start: () => {},
  listenFinished: (fn) => other.add('doc-1', fn),
});
let firstReason;
const firstDone = firstWindow.then((reason) => {
  firstReason = reason;
});
other.emit('doc-2', true);
await Promise.resolve();
assert.equal(firstReason, undefined, 'another window finishing does not end this one');
other.emit('doc-1', true);
await firstDone;
assert.equal(firstReason, 'finished');

const lock = createPrintLock();
let started = 0;
let release;
const first = lock.run(() => new Promise((resolve) => {
  started += 1;
  release = resolve;
}));
assert.equal(await lock.run(async () => {
  started += 1;
}), false);
assert.equal(started, 1);
release();
assert.equal(await first, true);
assert.equal(await lock.run(async () => {
  started += 1;
}), true);
assert.equal(started, 2);

const startedAt = Date.now();
await settleImage({ decode: () => new Promise(() => {}) }, 40);
assert.ok(Date.now() - startedAt < 1000, 'a hung image must not wait out the export');
await settleImage({ decode: () => Promise.reject(new Error('broken')) }, 1000);

console.log('print session ok');
