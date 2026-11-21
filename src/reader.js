import DOMPurify from 'dompurify';
import ReaderWorker from './reader-worker.js?worker&inline';

const BUFFER = 700;

/** Static Markdown with a window of rendered sections and two spacers outside it. */
const clean = (html) => DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form'], FORBID_ATTR: ['style', 'srcset'] });

export async function createReader({ root, scroller, content, resolveImage, onOpenLink, renderDiagram, onWordCount }) {
  const worker = new ReaderWorker();
  const pending = new Map();
  const mounted = new Map();
  const top = document.createElement('div');
  const bottom = document.createElement('div');
  const article = Object.assign(document.createElement('article'), { className: 'reader-document', tabIndex: 0 });
  article.setAttribute('aria-label', '文档阅读');
  article.append(top, bottom);
  root.append(article);
  let sequence = 0, frame = 0, first = -1, last = -1, destroyed = false;
  let words = 0, lead = null, firstPaint = false;
  const markFirstPaint = () => {
    if (firstPaint) return;
    firstPaint = true;
    requestAnimationFrame(() => { if (!destroyed) performance.mark('mdpad:reader-first-paint'); });
  };

  const firstMessage = new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.type === 'lead') {
        lead = Object.assign(document.createElement('section'), { className: 'reader-page' });
        lead.innerHTML = clean(data.html);
        article.insertBefore(lead, bottom);
        markFirstPaint();
      } else if (data.type === 'document') resolve(data);
      else if (data.type === 'words') {
        words = data.count;
        onWordCount?.();
      }
      else if (data.type === 'error' && !data.id) reject(new Error(data.message));
      else {
        const request = pending.get(data.id);
        pending.delete(data.id);
        if (data.type === 'error') request?.reject(new Error(data.message));
        else request?.resolve(data);
      }
    };
    worker.onerror = (error) => {
      reject(error);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };
  });
  const ask = (data) => new Promise((resolve, reject) => {
    if (destroyed) return resolve(null);
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...data, id });
  });

  scroller.scrollTop = 0;
  worker.postMessage({ type: 'open', text: content });
  let documentIndex;
  try {
    documentIndex = await firstMessage;
  } catch (error) {
    worker.terminate();
    article.remove();
    throw error;
  }
  lead?.remove();
  const { pages, headings } = documentIndex;
  const byHeading = new Map(headings.map((heading) => [heading.id, heading]));
  const notePages = new Map(pages.flatMap((page, i) => page.note ? [[page.note, i]] : []));
  const heights = pages.map((page) => page.height);
  const starts = new Float64Array(heights.length + 1);
  const scrollerInset = () => article.offsetTop + top.offsetTop;
  function indexHeights() {
    for (let i = 0; i < heights.length; i++) starts[i + 1] = starts[i] + heights[i];
  }
  indexHeights();
  function pageAt(y) {
    let lo = 0, hi = heights.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (starts[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  function spacers() {
    top.style.height = starts[first] + 'px';
    bottom.style.height = (starts[heights.length] - starts[last + 1]) + 'px';
  }
  const observer = new ResizeObserver((changes) => {
    if (destroyed) return;
    const anchor = pageAt(Math.max(0, scroller.scrollTop - scrollerInset()));
    const before = starts[anchor];
    let changed = false;
    for (const { target } of changes) {
      const index = Number(target.dataset.page);
      const height = target.offsetHeight;
      if (mounted.get(index) !== target || !height || height === heights[index]) continue;
      heights[index] = height;
      changed = true;
    }
    if (changed) {
      indexHeights();
      spacers();
      const shift = starts[anchor] - before;
      if (shift) scroller.scrollTop += shift;
      schedule();
    }
  });

  function loadImages(page) {
    for (const image of page.querySelectorAll('img[data-reader-src]')) {
      const source = image.dataset.readerSrc;
      Promise.resolve(resolveImage(source)).then((url) => {
        if (image.isConnected && url) image.src = url;
      }).catch(() => {});
    }
  }

  function fill(page, html) {
    page.style.minHeight = '';
    page.innerHTML = clean(html);
    for (const checkbox of page.querySelectorAll('input')) checkbox.disabled = true;
    loadImages(page);
    const formulas = page.querySelectorAll('[data-reader-math]');
    if (formulas.length) {
      import('katex').then(({ default: katex }) => {
        for (const formula of formulas) {
          if (formula.isConnected) katex.render(formula.textContent, formula, {
            displayMode: formula.dataset.readerMath === 'block', throwOnError: false,
          });
        }
      }).catch(() => {});
    }
    if (renderDiagram) {
      for (const diagram of page.querySelectorAll('[data-reader-diagram]')) {
        renderDiagram(diagram.textContent).then((svg) => {
          if (diagram.isConnected && svg) diagram.innerHTML = DOMPurify.sanitize(svg);
        }).catch(() => {});
      }
    }
    observer.observe(page);
  }

  function renderWindow(firstHtml) {
    if (destroyed) return;
    frame = 0;
    const y = Math.max(0, scroller.scrollTop - scrollerInset());
    const from = pageAt(Math.max(0, y - BUFFER));
    const to = pageAt(y + scroller.clientHeight + BUFFER);
    if (from === first && to === last) return;
    first = from;
    last = to;
    for (const [index, page] of mounted) {
      if (index >= from && index <= to) continue;
      observer.unobserve(page);
      page.remove();
      mounted.delete(index);
    }
    const missing = [];
    let next = bottom;
    for (let i = to; i >= from; i--) {
      let page = mounted.get(i);
      if (!page) {
        page = Object.assign(document.createElement('section'), { className: 'reader-page' });
        page.dataset.page = i;
        page.style.minHeight = heights[i] + 'px';
        mounted.set(i, page);
        article.insertBefore(page, next);
        if (i === 0 && firstHtml !== undefined) fill(page, firstHtml);
        else missing.push(i);
      }
      next = page;
    }
    spacers();
    if (missing.length) ask({ type: 'pages', indices: missing }).then((reply) => {
      for (const [i, html] of reply?.items ?? []) {
        const target = mounted.get(i);
        if (target && target.style.minHeight) fill(target, html);
      }
      highlight();
    }).catch(() => {});
  }

  function schedule() {
    if (!frame && !destroyed) frame = requestAnimationFrame(() => renderWindow());
  }
  scroller.addEventListener('scroll', schedule, { passive: true });
  const viewport = new ResizeObserver(schedule);
  viewport.observe(scroller);

  function jump(page, id) {
    if (!Number.isInteger(page)) return;
    scroller.scrollTop = scrollerInset() + starts[page];
    renderWindow();
    if (!id) return;
    const targetPage = mounted.get(page);
    const show = () => {
      const target = document.getElementById(id);
      if (!targetPage?.contains(target)) return false;
      const delta = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTop += delta - 10;
      return true;
    };
    if (show() || !targetPage) return;
    const watch = new MutationObserver(() => { show(); watch.disconnect(); });
    watch.observe(targetPage, { childList: true });
  }

  article.addEventListener('click', (event) => {
    const link = event.target.closest('a[href]');
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute('href');
    if (href.startsWith('#')) {
      const id = href.slice(1);
      let decoded = id;
      try { decoded = decodeURIComponent(id); } catch {}
      const heading = byHeading.get(id) ?? byHeading.get(decoded);
      if (heading) jump(heading.page, heading.id);
      else jump(notePages.get(id), id);
    } else if (/^(https?:|mailto:)/i.test(href)) {
      onOpenLink(href);
    }
  });

  let query = '', found = [], count = 0, selected = -1, selectedPage = -1, occurrence = 0, queryVersion = 0;
  const findInfo = () => ({ count, index: selected });
  function highlight() {
    const previous = article.querySelector('mark.reader-match');
    if (previous) {
      const parent = previous.parentNode;
      previous.replaceWith(document.createTextNode(previous.textContent));
      parent.normalize();
    }
    const page = mounted.get(selectedPage);
    if (!page || !query) return;
    const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
    const needle = query.toLowerCase();
    let seen = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = node.data.toLowerCase();
      let index = 0;
      while ((index = value.indexOf(needle, index)) !== -1) {
        if (seen++ === occurrence) {
          const range = new Range();
          range.setStart(node, index);
          range.setEnd(node, Math.min(node.length, index + query.length));
          const mark = document.createElement('mark');
          mark.className = 'reader-match';
          range.surroundContents(mark);
          const delta = mark.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
          scroller.scrollTop += delta - scroller.clientHeight / 3;
          return;
        }
        index += needle.length;
      }
    }
  }

  function selectMatch() {
    let remaining = selected;
    selectedPage = found.findIndex((hits) => {
      if (remaining < hits) return true;
      remaining -= hits;
      return false;
    });
    occurrence = remaining;
    if (selectedPage >= 0) jump(selectedPage);
    highlight();
    return findInfo();
  }

  const reader = {
    kind: 'reader',
    getMarkdown: () => content,
    getMarkdownAsync: async () => content,
    snapshot: () => content,
    matches: (snapshot) => content === snapshot,
    getWordCount: () => words,
    refreshImages: () => { for (const page of mounted.values()) loadImages(page); },
    headings: () => headings,
    activeHeading(list) {
      const page = pageAt(scroller.scrollTop - scrollerInset() + 20);
      let lo = 0, hi = list.length - 1, active = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (list[mid].page <= page) {
          active = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return active;
    },
    scrollToHeading: (heading) => jump(heading.page, heading.id),
    focus: () => article.focus({ preventScroll: true }),
    getPosition() {
      const y = Math.max(0, scroller.scrollTop - scrollerInset());
      const page = pageAt(y);
      const heading = headings[reader.activeHeading(headings)];
      return { mode: 'reader', scrollTop: scroller.scrollTop, offset: pages[page].offset, inset: y - starts[page],
        progress: y / Math.max(1, starts[heights.length]), heading: heading?.text };
    },
    setPosition(position) {
      if (!position) return;
      if (position.mode === 'reader' && Number.isFinite(position.offset)) {
        let lo = 0, hi = pages.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >>> 1;
          if (pages[mid].offset <= position.offset) lo = mid;
          else hi = mid - 1;
        }
        scroller.scrollTop = scrollerInset() + starts[lo] + (position.inset ?? 0);
      } else {
        const heading = headings.find((item) => item.text === position.heading);
        if (heading) jump(heading.page, heading.id);
        else scroller.scrollTop = Number.isFinite(position.progress)
          ? position.progress * starts[heights.length]
          : position.scrollTop ?? (typeof position === 'number' ? position : 0);
      }
      renderWindow();
    },
    find: {
      async set(value) {
        const version = ++queryVersion;
        query = value;
        selected = selectedPage = -1;
        count = 0;
        highlight();
        if (!value) return findInfo();
        const response = await ask({ type: 'find', query: value }).catch(() => null);
        if (version !== queryVersion || !response) return findInfo();
        found = response.counts;
        count = found.reduce((sum, hits) => sum + hits, 0);
        if (!count) return findInfo();
        selected = 0;
        return selectMatch();
      },
      go(delta) {
        if (!count) return findInfo();
        selected = (selected + delta + count) % count;
        return selectMatch();
      },
      finish() { reader.find.set(''); },
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', schedule);
      viewport.disconnect();
      observer.disconnect();
      worker.terminate();
      for (const request of pending.values()) request.resolve(null);
      pending.clear();
      article.remove();
    },
  };
  scroller.scrollTop = 0;
  renderWindow(documentIndex.first);
  markFirstPaint();
  performance.mark('mdpad:reader-ready');
  return reader;
}
