// Remember a document block, rather than a pixel offset that changes when math,
// diagrams, images and code editors finish rendering.
export function readingBlock(view, scroller) {
  const edge = scroller.getBoundingClientRect().top;
  let top = null;
  view.state.doc.forEach((_node, pos) => {
    if (top) return;
    const dom = view.nodeDOM(pos);
    if (!dom?.getBoundingClientRect) return;
    const rect = dom.getBoundingClientRect();
    if (rect.bottom > edge) top = { pos, offset: Math.round(edge - rect.top) };
  });
  return top;
}

export function restoreReadingPosition(view, scroller, position, lazy) {
  if (!position || (!position.top && typeof position.scrollTop !== 'number')) return () => {};
  let frame;
  let stopped = false;
  const apply = () => {
    if (stopped || view.isDestroyed) return;
    if (typeof position.top?.pos === 'number') {
      if (lazy) lazy.scrollToBlock(position.top);
      else {
        const pos = Math.min(Math.max(0, position.top.pos), view.state.doc.content.size);
        const dom = view.nodeDOM(pos);
        if (dom?.getBoundingClientRect) scroller.scrollTop += dom.getBoundingClientRect().top - scroller.getBoundingClientRect().top + (position.top.offset || 0);
      }
    } else scroller.scrollTop = position.scrollTop;
  };
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(apply); };
  const observer = new ResizeObserver(schedule);
  const inputs = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timeout);
    cancelAnimationFrame(frame);
    observer.disconnect();
    for (const event of inputs) document.removeEventListener(event, stop, true);
  };
  // This guard only belongs to reopening/mounting. Any user action immediately
  // hands scroll control back, and it never survives editor destruction.
  const timeout = setTimeout(stop, 5000);
  for (const event of inputs) document.addEventListener(event, stop, { capture: true, passive: true });
  observer.observe(view.dom);
  apply();
  schedule();
  return stop;
}
