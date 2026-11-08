/** One export at a time. A second click while the dialog is open does nothing. */
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
 * Waits until the page reports `afterprint` (dialog confirmed or cancelled).
 * The listener is installed before `startPrint`, so an event fired during the call is not missed.
 * There is no timer: restoring the editor before the dialog closes undoes pagination.
 */
export function waitForAfterPrint(target, startPrint) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      target.removeEventListener('afterprint', onAfter);
      if (error) reject(error);
      else resolve();
    };
    const onAfter = () => finish();
    target.addEventListener('afterprint', onAfter);
    try {
      Promise.resolve(startPrint()).catch((error) => finish(error));
    } catch (error) {
      finish(error);
    }
  });
}

/** Resolves when the image has decoded, or when `timeoutMs` has passed. A hung image must not stall export. */
export function settleImage(img, timeoutMs) {
  const done = img.decode?.().catch(() => {}) ?? Promise.resolve();
  return Promise.race([done, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
}
