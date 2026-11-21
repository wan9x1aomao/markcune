// WebView2's native file receiver replaces its HTML drop target. Keep the editor's
// block handle usable by passing pointer drags through Milkdown's existing move path.
export function installBlockPointerDrop(root, view) {
  let cancel = null;

  function press(event) {
    const handle = event.target.closest('.milkdown-block-handle');
    const grip = event.target.closest('.operation-item');
    if (event.button !== 0 || !view.editable || !handle || grip !== handle.lastElementChild) return;
    cancel?.();
    event.preventDefault();
    const id = event.pointerId;
    const { clientX: x, clientY: y } = event;
    const data = new DataTransfer();
    const scope = new AbortController();
    const options = { capture: true, signal: scope.signal };
    let moving = false;

    function mouse(type, point) {
      handle.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, clientX: point.clientX, clientY: point.clientY, button: 0,
      }));
    }
    function drag(target, type, point) {
      target.dispatchEvent(new DragEvent(type, {
        dataTransfer: data, bubbles: true, cancelable: true, clientX: point.clientX, clientY: point.clientY,
      }));
    }
    function targetAt(point) {
      const target = document.elementFromPoint(point.clientX, point.clientY);
      return view.dom.contains(target) ? target : null;
    }
    function move(point) {
      if (point.pointerId !== id) return;
      if (!moving && Math.hypot(point.clientX - x, point.clientY - y) >= 5) {
        moving = true;
        drag(handle, 'dragstart', point);
      }
      const target = moving && targetAt(point);
      if (target) drag(target, 'dragover', point);
    }
    function finish(point, dropped) {
      if (point.pointerId !== id) return;
      scope.abort();
      cancel = null;
      if (moving) {
        const target = dropped && targetAt(point);
        if (target) drag(target, 'drop', point);
        drag(handle, 'dragend', point);
      }
      mouse('mouseup', point);
    }

    mouse('mousedown', event);
    cancel = () => finish(event, false);
    document.addEventListener('pointermove', move, options);
    document.addEventListener('pointerup', (point) => finish(point, true), options);
    document.addEventListener('pointercancel', (point) => finish(point, false), options);
    window.addEventListener('blur', cancel, options);
    document.addEventListener('keydown', (key) => { if (key.key === 'Escape') cancel(); }, options);
  }

  root.addEventListener('pointerdown', press, true);
  return () => {
    cancel?.();
    root.removeEventListener('pointerdown', press, true);
  };
}
