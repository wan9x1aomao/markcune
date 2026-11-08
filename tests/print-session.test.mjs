import assert from 'node:assert/strict';
import { createPrintLock, runPrint, settleImage } from '../src/print-session.js';

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

const confirmed = new Target();
const confirmedRun = runPrint(confirmed, () => {
  confirmed.dispatch('beforeprint');
});
queueMicrotask(() => confirmed.dispatch('afterprint'));
assert.equal(await confirmedRun, 'afterprint');

const cancelled = new Target();
const cancelledRun = runPrint(cancelled, () => {
  cancelled.dispatch('beforeprint');
  cancelled.dispatch('afterprint');
});
assert.equal(await cancelledRun, 'afterprint');

const missing = new Target();
assert.equal(await runPrint(missing, () => {}), 'no-afterprint');

const broken = new Target();
assert.equal(
  await runPrint(broken, () => {
    throw new Error('print failed');
  }),
  'error',
);

const held = new Target();
let releaseAfter;
const heldRun = runPrint(held, () => {
  held.dispatch('beforeprint');
  releaseAfter = () => held.dispatch('afterprint');
});
let heldResult;
const finished = heldRun.then((reason) => {
  heldResult = reason;
});
await Promise.resolve();
assert.equal(heldResult, undefined, 'beforeprint without afterprint must keep the dialog open');
releaseAfter();
await finished;
assert.equal(heldResult, 'afterprint');

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
