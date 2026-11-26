// Global smooth gliding caret engine, ported 1:1 from MaoBot's `hb-smooth-caret`.
// Covers Milkdown (.ProseMirror), CodeMirror (.cm-content), and text inputs/textareas.

const SMOOTH_CARET_INPUT_TYPES = new Set(['', 'text', 'search', 'url', 'email', 'password', 'tel']);
const SMOOTH_CARET_MIRROR_PROPS = [
  'boxSizing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle',
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
  'letterSpacing', 'wordSpacing', 'lineHeight', 'textIndent', 'textTransform',
  'textAlign', 'tabSize', 'direction', 'overflowWrap', 'wordBreak',
];

const parsePx = (value) => {
  const num = Number.parseFloat(value);
  return Number.isFinite(num) ? num : 0;
};

export function computeCaretBox(rawRect, fontSize, fallbackLineHeight) {
  if (!rawRect) return null;
  const fs = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 15;
  const measuredH = Number.isFinite(rawRect.height) && rawRect.height > 0
    ? rawRect.height
    : (Number.isFinite(rawRect.bottom) && Number.isFinite(rawRect.top) ? rawRect.bottom - rawRect.top : 0);
  const rawH = measuredH > 0 ? measuredH : fallbackLineHeight || fs * 1.3;
  const caretH = Math.max(15, Math.min(Math.round(fs * 1.38), Math.round(rawH)));
  const x = Math.round(rawRect.left * 2) / 2;
  const y = Math.round((rawRect.top + Math.max(0, (rawH - caretH) / 2)) * 2) / 2;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(caretH) || caretH <= 0) return null;
  return { x, y, height: Math.round(caretH) };
}

export function resolveSmoothCaretTarget(rawEl) {
  if (!rawEl || rawEl.nodeType !== 1) return null;
  if (rawEl.closest?.('[data-native-caret]')) return null;
  const tag = String(rawEl.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') {
    return rawEl.disabled || rawEl.readOnly ? null : rawEl;
  }
  if (tag === 'INPUT') {
    if (rawEl.disabled || rawEl.readOnly) return null;
    const type = String(rawEl.type || '').toLowerCase();
    return SMOOTH_CARET_INPUT_TYPES.has(type) ? rawEl : null;
  }
  if (rawEl.isContentEditable) {
    const host = rawEl.closest?.('[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]') || rawEl;
    return host.closest?.('[data-native-caret]') ? null : host;
  }
  return null;
}

export function installSmoothCaret({ getEditor = () => null } = {}) {
  if (typeof window === 'undefined' || typeof document === 'undefined' || !document.body) return () => {};
  const reducedMotionMql = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

  const caretEl = document.createElement('div');
  caretEl.id = 'mc-smooth-caret';
  caretEl.className = 'smooth-caret';
  caretEl.setAttribute('aria-hidden', 'true');
  document.body.appendChild(caretEl);

  let mirrorEl = null;
  const getMirror = () => {
    if (mirrorEl && mirrorEl.isConnected) return mirrorEl;
    mirrorEl = document.createElement('div');
    mirrorEl.className = 'smooth-caret-mirror';
    mirrorEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(mirrorEl);
    return mirrorEl;
  };

  let activeHost = null;
  let lastRenderedHost = null;
  let lastPos = null;
  let visible = false;
  let rafId = 0;
  let followTimer = 0;
  let idleTimer = 0;
  let scrollHoldTimer = 0;
  let scrolling = false;
  let pendingInstant = false;

  const isOccludedByModal = (target) => {
    const overlays = document.querySelectorAll('.overlay');
    for (let i = 0; i < overlays.length; i += 1) {
      if (!overlays[i].hidden && !overlays[i].contains(target)) return true;
    }
    return false;
  };

  const clearHostAttr = (el) => {
    if (!el) return;
    if (el.getAttribute?.('data-smooth-caret') === 'active') {
      el.removeAttribute('data-smooth-caret');
    }
    const cmEditor = el.closest?.('.cm-editor');
    if (cmEditor && cmEditor.getAttribute('data-smooth-caret') === 'active') {
      cmEditor.removeAttribute('data-smooth-caret');
    }
  };

  const hideCaret = ({ keepHostRef = false } = {}) => {
    if (activeHost) clearHostAttr(activeHost);
    if (!keepHostRef) {
      activeHost = null;
      lastRenderedHost = null;
      lastPos = null;
    }
    visible = false;
    caretEl.classList.remove('is-visible', 'is-moving');
  };

  const measureTextControlCaret = (el) => {
    let start = null;
    let end = null;
    try {
      start = el.selectionStart;
      end = el.selectionEnd;
    } catch {
      return null;
    }
    if (typeof start !== 'number' || typeof end !== 'number' || start !== end) return null;

    const elRect = el.getBoundingClientRect();
    if (elRect.width < 4 || elRect.height < 4) return null;

    const cs = window.getComputedStyle(el);
    const isInput = el.tagName === 'INPUT';
    const mirror = getMirror();
    for (const prop of SMOOTH_CARET_MIRROR_PROPS) {
      mirror.style[prop] = cs[prop];
    }
    const borderL = parsePx(cs.borderLeftWidth);
    const borderR = parsePx(cs.borderRightWidth);
    const borderT = parsePx(cs.borderTopWidth);
    const borderB = parsePx(cs.borderBottomWidth);
    const padL = parsePx(cs.paddingLeft);
    const padR = parsePx(cs.paddingRight);
    const padT = parsePx(cs.paddingTop);
    const padB = parsePx(cs.paddingBottom);

    mirror.style.whiteSpace = isInput ? 'pre' : 'pre-wrap';
    mirror.style.width = isInput ? 'auto' : `${Math.max(1, el.clientWidth + borderL + borderR)}px`;
    mirror.style.height = isInput ? `${Math.max(1, elRect.height)}px` : 'auto';
    mirror.style.overflowWrap = isInput ? 'normal' : (cs.overflowWrap || 'break-word');

    const rawVal = String(el.value || '');
    const maskedVal = isInput && String(el.type || '').toLowerCase() === 'password'
      ? '•'.repeat(rawVal.length)
      : rawVal;
    const before = maskedVal.slice(0, start);
    const after = maskedVal.slice(start);

    mirror.textContent = '';
    if (before) mirror.appendChild(document.createTextNode(before));
    const marker = document.createElement('span');
    marker.textContent = '\u200b';
    mirror.appendChild(marker);
    if (after) mirror.appendChild(document.createTextNode(after));

    const mirrorRect = mirror.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    const fontSize = parsePx(cs.fontSize) || 14;
    const lineH = parsePx(cs.lineHeight) || Math.round(fontSize * 1.35);
    const caretH = Math.max(14, Math.min(Math.round(fontSize * 1.36), Math.round(markerRect.height || lineH)));

    const x = elRect.left + (markerRect.left - mirrorRect.left) - (el.scrollLeft || 0);
    let y;
    if (isInput) {
      const innerTop = elRect.top + borderT + padT;
      const innerH = Math.max(caretH, elRect.height - borderT - borderB - padT - padB);
      y = innerTop + (innerH - caretH) / 2;
    } else {
      const rawTop = elRect.top + (markerRect.top - mirrorRect.top) - (el.scrollTop || 0);
      const rawH = markerRect.height || lineH;
      y = rawTop + Math.max(0, (rawH - caretH) / 2);
    }

    const clipL = elRect.left + borderL - 2;
    const clipR = elRect.right - borderR + 2;
    const clipT = elRect.top + borderT - 2;
    const clipB = elRect.bottom - borderB + 2;
    if (x < clipL || x > clipR || y + caretH < clipT || y > clipB) return null;
    return { x, y, height: caretH };
  };

  const measureEditorViewCaret = (root) => {
    const editor = getEditor?.();
    const view = editor?.view;
    if (!view) return null;
    // ProseMirror (rich mode): use ProseMirror's own WebKit-safe coordsAtPos when not composing.
    if (editor.kind === 'rich' && view.dom === root) {
      if (view.composing) return null;
      const { selection } = view.state;
      if (!selection?.empty) return { hidden: true };
      if (selection.node) return { hidden: true };
      try {
        const coords = view.coordsAtPos(selection.head);
        if (coords && coords.bottom > coords.top) {
          const domPos = view.domAtPos(selection.head);
          const refEl = domPos?.node?.nodeType === 1 ? domPos.node : domPos?.node?.parentElement || root;
          const fontSize = parsePx(window.getComputedStyle(refEl).fontSize) || 16;
          return computeCaretBox(coords, fontSize);
        }
      } catch {
        return null;
      }
    }
    // CodeMirror (source mode): use CodeMirror's WebKit-safe coordsAtPos when not composing.
    if (editor.kind === 'source' && view.contentDOM === root) {
      if (view.composing) return null;
      const { selection } = view.state;
      if (!selection || selection.ranges.length !== 1 || !selection.main.empty) return { hidden: true };
      try {
        const coords = view.coordsAtPos(selection.main.head);
        if (coords && coords.bottom > coords.top) {
          const fontSize = parsePx(window.getComputedStyle(root).fontSize) || 14;
          return computeCaretBox(coords, fontSize);
        }
      } catch {
        return null;
      }
    }
    return null;
  };

  const measureContentEditableCaret = (root) => {
    const editorMeasured = measureEditorViewCaret(root);
    if (editorMeasured?.hidden) return null;
    let box = editorMeasured;

    if (!box) {
      const sel = window.getSelection?.();
      if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
      const anchorNode = sel.anchorNode;
      if (!anchorNode || !root.contains(anchorNode)) return null;

      const range = sel.getRangeAt(0).cloneRange();
      range.collapse(true);

      let rawRect = null;
      const rects = range.getClientRects();
      for (let i = 0; i < rects.length; i += 1) {
        const r = rects[i];
        if (r && r.height > 0 && (r.left > 0 || r.top > 0)) {
          rawRect = r;
          break;
        }
      }
      if (!rawRect) {
        const br = range.getBoundingClientRect();
        if (br && br.height > 0 && (br.left > 0 || br.top > 0)) rawRect = br;
      }

      // WebKit (WKWebView) often returns an empty rect for a collapsed range at the end of a text node
      // or during IME composition. Measure the immediately preceding/following character instead of
      // falling back to the paragraph's left edge.
      if (!rawRect && anchorNode.nodeType === Node.TEXT_NODE) {
        const textLen = anchorNode.nodeValue?.length ?? 0;
        const offset = Math.min(Math.max(sel.anchorOffset, 0), textLen);
        if (offset > 0) {
          const charRange = document.createRange();
          charRange.setStart(anchorNode, offset - 1);
          charRange.setEnd(anchorNode, offset);
          const charRects = charRange.getClientRects();
          const last = charRects[charRects.length - 1] || charRange.getBoundingClientRect();
          if (last && last.height > 0 && (last.right > 0 || last.top > 0)) {
            rawRect = { left: last.right, top: last.top, height: last.height };
          }
        } else if (textLen > 0) {
          const charRange = document.createRange();
          charRange.setStart(anchorNode, 0);
          charRange.setEnd(anchorNode, 1);
          const first = charRange.getClientRects()[0] || charRange.getBoundingClientRect();
          if (first && first.height > 0 && (first.left > 0 || first.top > 0)) {
            rawRect = { left: first.left, top: first.top, height: first.height };
          }
        }
      }

      const anchorEl = anchorNode.nodeType === 1 ? anchorNode : anchorNode.parentElement;
      if (!rawRect && anchorEl) {
        if (anchorNode.nodeType === 1) {
          const prevChild = anchorNode.childNodes[sel.anchorOffset - 1];
          if (prevChild && prevChild.nodeType === Node.TEXT_NODE && prevChild.nodeValue?.length) {
            const charRange = document.createRange();
            charRange.setStart(prevChild, prevChild.nodeValue.length - 1);
            charRange.setEnd(prevChild, prevChild.nodeValue.length);
            const charRects = charRange.getClientRects();
            const last = charRects[charRects.length - 1] || charRange.getBoundingClientRect();
            if (last && last.height > 0 && (last.right > 0 || last.top > 0)) {
              rawRect = { left: last.right, top: last.top, height: last.height };
            }
          } else if (prevChild && prevChild.nodeType === 1 && !prevChild.classList?.contains('prosemirror-virtual-cursor')) {
            const cr = prevChild.getBoundingClientRect();
            if (cr && cr.height > 0 && cr.width > 0) {
              rawRect = { left: cr.right, top: cr.top, height: cr.height };
            }
          }
          if (!rawRect) {
            const nextChild = anchorNode.childNodes[sel.anchorOffset];
            if (nextChild && nextChild.nodeType === 1 && !nextChild.classList?.contains('prosemirror-virtual-cursor')) {
              const cr = nextChild.getBoundingClientRect();
              if (cr && cr.height > 0) {
                rawRect = { left: cr.left, top: cr.top, height: cr.height };
              }
            }
          }
        }
        if (!rawRect) {
          const er = anchorEl.getBoundingClientRect();
          if (er && er.width > 0 && er.height > 0) {
            const ecs = window.getComputedStyle(anchorEl);
            const fs = parsePx(ecs.fontSize) || 15;
            const lh = parsePx(ecs.lineHeight) || Math.round(fs * 1.4);
            rawRect = {
              left: er.left + parsePx(ecs.paddingLeft) + parsePx(ecs.borderLeftWidth),
              top: er.top + parsePx(ecs.paddingTop) + parsePx(ecs.borderTopWidth),
              height: Math.min(er.height, lh),
            };
          }
        }
      }
      if (!rawRect) return null;

      const refEl = anchorEl || root;
      const cs = window.getComputedStyle(refEl);
      const fontSize = parsePx(cs.fontSize) || 15;
      box = computeCaretBox(rawRect, fontSize);
      if (!box) return null;
    }

    // Clip to both the editable root and its visible scroll pane so scrolled-out carets never float over the topbar.
    const rootRect = root.getBoundingClientRect();
    const pane = root.closest('#rich-pane, #source-pane, .cm-scroller');
    const clipRect = pane ? pane.getBoundingClientRect() : rootRect;
    const clipL = Math.max(rootRect.left, clipRect.left) - 4;
    const clipR = Math.min(rootRect.right, clipRect.right) + 4;
    const clipT = Math.max(rootRect.top, clipRect.top) - 4;
    const clipB = Math.min(rootRect.bottom, clipRect.bottom) + 4;
    if (box.x < clipL || box.x > clipR || box.y + box.height < clipT || box.y > clipB) {
      return null;
    }
    return box;
  };

  const updateCaretNow = (instantFlag = false) => {
    if (reducedMotionMql?.matches) {
      hideCaret();
      return;
    }
    const target = resolveSmoothCaretTarget(document.activeElement);
    if (!target || !target.isConnected || isOccludedByModal(target)) {
      hideCaret();
      return;
    }
    if (activeHost && activeHost !== target) clearHostAttr(activeHost);
    activeHost = target;

    const measured = (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
      ? measureTextControlCaret(target)
      : measureContentEditableCaret(target);

    if (!measured) {
      hideCaret({ keepHostRef: true });
      return;
    }

    target.setAttribute('data-smooth-caret', 'active');
    target.closest?.('.cm-editor')?.setAttribute('data-smooth-caret', 'active');
    const rx = Math.round(measured.x * 2) / 2;
    const ry = Math.round(measured.y * 2) / 2;
    const rh = Math.round(measured.height);
    const switchedHost = lastRenderedHost !== target;
    const moved = !lastPos || Math.abs(lastPos.x - rx) > 0.25 || Math.abs(lastPos.y - ry) > 0.25 || lastPos.h !== rh;
    const useInstant = scrolling || instantFlag || pendingInstant || !visible || switchedHost;
    pendingInstant = false;

    if (useInstant) caretEl.classList.add('is-instant');
    else caretEl.classList.remove('is-instant');

    caretEl.style.height = `${rh}px`;
    caretEl.style.transform = `translate3d(${rx}px, ${ry}px, 0)`;
    caretEl.classList.add('is-visible');

    // Avoid forcing synchronous layout on every 120Hz scroll frame; restore transition once scrolling settles.
    if (useInstant && !scrolling) {
      void caretEl.offsetWidth;
      caretEl.classList.remove('is-instant');
    }

    if (moved && !switchedHost && !scrolling) {
      caretEl.classList.add('is-moving');
      if (idleTimer) window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => {
        idleTimer = 0;
        caretEl.classList.remove('is-moving');
      }, 360);
    }

    lastRenderedHost = target;
    lastPos = { x: rx, y: ry, h: rh };
    visible = true;
  };

  const scheduleUpdate = ({ instant = false, followUp = false } = {}) => {
    if (instant) pendingInstant = true;
    if (!rafId) {
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        updateCaretNow(pendingInstant);
      });
    }
    if (followUp) {
      if (followTimer) window.clearTimeout(followTimer);
      followTimer = window.setTimeout(() => {
        followTimer = 0;
        updateCaretNow(false);
      }, 18);
    }
  };

  const onFocusIn = () => scheduleUpdate({ instant: true, followUp: true });
  const onFocusOut = () => {
    window.setTimeout(() => {
      if (!resolveSmoothCaretTarget(document.activeElement)) hideCaret();
    }, 0);
  };
  const onInput = () => scheduleUpdate({ followUp: true });
  const onKeyDown = () => scheduleUpdate({ followUp: true });
  const onKeyUp = () => scheduleUpdate({ followUp: false });
  const onPointerUp = () => scheduleUpdate({ followUp: true });
  const onSelectionChange = () => {
    if (resolveSmoothCaretTarget(document.activeElement)) scheduleUpdate({ followUp: false });
  };
  const onComposition = () => scheduleUpdate({ followUp: true });
  const onScrollOrResize = () => {
    if (!visible && !activeHost) return;
    scrolling = true;
    caretEl.classList.add('is-instant');
    if (scrollHoldTimer) window.clearTimeout(scrollHoldTimer);
    scrollHoldTimer = window.setTimeout(() => {
      scrollHoldTimer = 0;
      scrolling = false;
      caretEl.classList.remove('is-instant');
    }, 120);
    scheduleUpdate({ instant: true });
  };
  const onMotionChange = () => scheduleUpdate({ instant: true });

  // Hide or re-sync immediately when overlays/banners/sidebars appear or resize #panes.
  const panes = document.getElementById('panes');
  const resizeObserver = typeof ResizeObserver === 'function' && panes
    ? new ResizeObserver(() => {
        if (visible || activeHost) scheduleUpdate({ instant: true });
      })
    : null;
  const overlayObserver = typeof MutationObserver === 'function'
    ? new MutationObserver(() => {
        if (visible || activeHost) scheduleUpdate({ instant: true });
      })
    : null;

  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', onFocusOut, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('selectionchange', onSelectionChange);
  document.addEventListener('compositionstart', onComposition, true);
  document.addEventListener('compositionupdate', onComposition, true);
  document.addEventListener('compositionend', onComposition, true);
  document.addEventListener('scroll', onScrollOrResize, true);
  window.addEventListener('resize', onScrollOrResize);
  window.addEventListener('blur', hideCaret);
  reducedMotionMql?.addEventListener?.('change', onMotionChange);
  resizeObserver?.observe(panes);
  overlayObserver?.observe(document.body, { childList: true });

  const destroy = () => {
    if (rafId) window.cancelAnimationFrame(rafId);
    if (followTimer) window.clearTimeout(followTimer);
    if (idleTimer) window.clearTimeout(idleTimer);
    if (scrollHoldTimer) window.clearTimeout(scrollHoldTimer);
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('focusout', onFocusOut, true);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('keyup', onKeyUp, true);
    document.removeEventListener('pointerup', onPointerUp, true);
    document.removeEventListener('selectionchange', onSelectionChange);
    document.removeEventListener('compositionstart', onComposition, true);
    document.removeEventListener('compositionupdate', onComposition, true);
    document.removeEventListener('compositionend', onComposition, true);
    document.removeEventListener('scroll', onScrollOrResize, true);
    window.removeEventListener('resize', onScrollOrResize);
    window.removeEventListener('blur', hideCaret);
    reducedMotionMql?.removeEventListener?.('change', onMotionChange);
    resizeObserver?.disconnect();
    overlayObserver?.disconnect();
    hideCaret();
    caretEl.remove();
    mirrorEl?.remove();
  };

  return {
    refresh: (instant = false) => scheduleUpdate({ instant, followUp: true }),
    destroy,
  };
}
