/** One export at a time. A second click while a DOM print dialog is open does nothing. */
export function createPrintLock() {
  let active = false;
  return {
    get active() {
      return active;
    },
    async run(work) {
      if (active) return false;
      active = true;
      try {
        await work();
        return true;
      } finally {
        active = false;
      }
    },
  };
}

/**
 * Runs `startPrint` and always settles.
 *
 * Browsers that implement the HTML print events fire `beforeprint` during the call and
 * `afterprint` when the dialog closes (confirm or cancel). This waits for that pair.
 * A platform that fires neither — WKWebView's `printOperationWithPrintInfo` is a native
 * panel and wry does not hook its delegate — settles as `no-afterprint` on the next
 * microtask. Callers must not hide the editor until one of these events: the native
 * panel does not send them, and a timer that removed layout would race pagination.
 */
export function runPrint(target, startPrint) {
  return new Promise((resolve) => {
    let settled = false;
    let sawBefore = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      target.removeEventListener('beforeprint', onBefore);
      target.removeEventListener('afterprint', onAfter);
      resolve(reason);
    };
    const onBefore = () => {
      sawBefore = true;
    };
    const onAfter = () => finish('afterprint');
    target.addEventListener('beforeprint', onBefore);
    target.addEventListener('afterprint', onAfter);
    let invocation;
    try {
      invocation = Promise.resolve(startPrint());
    } catch (error) {
      finish('error');
      return;
    }
    invocation.then(
      () => {
        queueMicrotask(() => {
          if (settled || sawBefore) return;
          finish('no-afterprint');
        });
      },
      () => finish('error'),
    );
  });
}

/** Resolves when the image has decoded, or when `timeoutMs` has passed. A hung image must not stall export. */
export function settleImage(img, timeoutMs) {
  const done = img.decode?.().catch(() => {}) ?? Promise.resolve();
  return Promise.race([done, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
}
