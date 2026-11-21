// Document outline: headings of the open document; click to jump.
export function createOutline(el, { onSelect }) {
  let headings = [];
  let items = [];
  let activeItem = null;

  function render(active) {
    el.replaceChildren();
    items = [];
    activeItem = null;
    const head = document.createElement('div');
    head.className = 'panel-header';
    head.innerHTML = '<span class="title">大纲</span>';
    el.appendChild(head);
    if (!headings.length) {
      el.appendChild(Object.assign(document.createElement('div'), { className: 'panel-empty', textContent: '文档里还没有标题。' }));
      return;
    }
    const top = Math.min(...headings.map((h) => h.level));
    headings.forEach((heading, i) => {
      const item = document.createElement('button');
      item.className = 'outline-item' + (i === active ? ' active' : '');
      item.style.paddingLeft = `${8 + (heading.level - top) * 14}px`;
      item.textContent = heading.text || '（空标题）';
      item.title = heading.text;
      item.addEventListener('click', () => onSelect(heading));
      items.push(item);
      if (i === active) activeItem = item;
      el.appendChild(item);
    });
  }

  return {
    update(list, active = -1) {
      headings = list;
      render(active);
    },
    setActive(active) {
      const item = items[active] ?? null;
      if (activeItem === item) return;
      activeItem?.classList.remove('active');
      activeItem = item;
      activeItem?.classList.add('active');
      activeItem?.scrollIntoView({ block: 'nearest' });
    },
  };
}
