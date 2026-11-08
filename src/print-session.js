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
 * What tells us the native panel is gone.
 * macOS: NSPrintOperation's didRunSelector, emitted as `print-finished` (confirm and cancel).
 * Windows: wry's print evaluates `window.print()`, which fires `afterprint` when the dialog closes.
 * Linux: the GTK dialog blocks inside the command, so the command returning is the end.
 */
export function nativePrintEnd(platform) {
  if (platform === 'linux') return 'command';
  if (platform === 'macos') return 'print-finished';
  return 'afterprint';
}

/** Confirm, cancel, and a failed start all leave the editor. None of them wait on a timer. */
export function restoresEditor(reason) {
  return reason === 'finished' || reason === 'cancelled' || reason === 'error';
}

/**
 * Subscribe first, then start the native print. `hooks.listenFinished` / `listenAfterprint`
 * return an unsubscribe function. The macOS command returns before the panel closes.
 */
export function finishNativePrint(platform, hooks) {
  const end = nativePrintEnd(platform);
  if (end === 'command') {
    return Promise.resolve(hooks.start()).then(() => 'finished');
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let stop = () => {};
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      stop();
      resolve(reason);
    };
    const arm =
      end === 'afterprint'
        ? Promise.resolve(hooks.listenAfterprint(() => finish('finished')))
        : Promise.resolve(hooks.listenFinished((success) => finish(success ? 'finished' : 'cancelled')));
    arm
      .then((unlisten) => {
        if (typeof unlisten === 'function') stop = unlisten;
        return hooks.start();
      })
      .then(
        () => {},
        (error) => {
          if (settled) return;
          settled = true;
          stop();
          reject(error);
        },
      );
  });
}

/** Resolves when the image has decoded, or when `timeoutMs` has passed. A hung image must not stall export. */
export function settleImage(img, timeoutMs) {
  const done = img.decode?.().catch(() => {}) ?? Promise.resolve();
  return Promise.race([done, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
}
