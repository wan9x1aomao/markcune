import assert from 'node:assert/strict';
import { createPrintLock, settleImage, waitForAfterPrint } from '../src/print-session.js';

class Target {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(name, fn) {
    const list = this.listeners.get(name) ?? [];
    list.push(fn);
    this.listeners.set(name, list);
  }
  removeEventListener(name, fn) {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((item) => item !== fn));
  }
  dispatch(name) {
    for (const fn of this.listeners.get(name) ?? []) fn();
  }
}

const target = new Target();
let printed = 0;
const pending = waitForAfterPrint(target, () => {
  printed += 1;
});
assert.equal(printed, 1);
target.dispatch('afterprint');
await pending;

const cancelled = new Target();
await waitForAfterPrint(cancelled, () => cancelled.dispatch('afterprint'));

await assert.rejects(waitForAfterPrint(new Target(), () => {
  throw new Error('print failed');
}));

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
