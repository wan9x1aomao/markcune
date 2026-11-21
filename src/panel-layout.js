import { normalizePanelLayout, PANEL_LAYOUTS, resolvePanelLayout } from './panel-layout-model.js';
import { formatKeys } from './ui.js';

const labels = { sidebar: '文件', outline: '大纲', content: '正文' };
const panelShortcuts = { sidebar: 'Mod+Shift+L', outline: 'Mod+Shift+T' };
const rect = (element, box) => {
  Object.assign(element.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px`, right: 'auto', bottom: 'auto' });
};

/** One controller per window. Panels and the editor stay mounted throughout every rearrangement. */
export function createPanelLayout({ getSettings, persist, setPanel, beforeChange = () => null, afterChange = () => {}, onError = () => {} }) {
  const workspace = document.getElementById('workspace');
  const panels = Object.fromEntries(['sidebar', 'outline'].map(name => [name, document.getElementById(name)]));
  const toggles = Object.fromEntries(Object.keys(panels).map(name => [name, document.getElementById(`toggle-${name}`)]));
  const fileToggle = toggles.sidebar;
  const toolbarLeft = fileToggle.parentElement;
  const listeners = new Set();
  let drawer = null, model, restoration = 0;
  document.body.classList.add('panels-managed');
  const tabs = document.createElement('div');
  tabs.className = 'panel-dock-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '文件与大纲');
  tabs.innerHTML = ['sidebar', 'outline'].map(name => `<button type="button" role="tab" id="dock-tab-${name}" aria-controls="${name}" data-panel="${name}">${labels[name]}</button>`).join('');
  workspace.appendChild(tabs);
  tabs.addEventListener('click', event => { const name = event.target.closest('[data-panel]')?.dataset.panel; if (name) controller.set({ tab: name }); });
  tabs.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const name = event.key === 'Home' ? 'sidebar' : event.key === 'End' ? 'outline' : model.prefs.tab === 'sidebar' ? 'outline' : 'sidebar';
    controller.set({ tab: name }); tabs.querySelector(`[data-panel="${name}"]`).focus();
  });
  const scrim = document.createElement('button');
  scrim.className = 'panel-drawer-scrim'; scrim.type = 'button'; scrim.setAttribute('aria-label', '收起侧栏'); scrim.hidden = true;
  workspace.appendChild(scrim);
  scrim.addEventListener('click', () => { drawer = null; apply(); });

  function restore(position) {
    cancelAnimationFrame(restoration);
    if (position) restoration = requestAnimationFrame(() => afterChange(position));
  }
  function save() { Promise.resolve(persist(normalizePanelLayout(getSettings().panelLayout))).catch(onError); }
  function apply() {
    const style = getComputedStyle(document.documentElement);
    const settings = getSettings();
    const previous = model;
    model = resolvePanelLayout({ preferences: settings.panelLayout, sidebar: !document.body.classList.contains('reader') && settings.sidebar !== false, outline: !!settings.outline, width: innerWidth, height: innerHeight, inset: parseFloat(style.getPropertyValue('--inset')) || 8, header: parseFloat(style.getPropertyValue('--topbar-h')) || 44, focus: document.body.classList.contains('focus'), drawer });
    const fileSide = model.sides.sidebar;
    if (fileToggle.dataset.dock !== fileSide) {
      const right = fileSide === 'right';
      if (right) toggles.outline.before(fileToggle);
      else toolbarLeft.prepend(fileToggle);
      fileToggle.dataset.dock = fileSide;
      fileToggle.classList.toggle('round-button', right);
      fileToggle.classList.toggle('icon-button', !right);
    }
    const stackChanges = previous && (previous.split || model.split) &&
      Object.keys(panels).some(name => previous.boxes[name].visible !== model.boxes[name].visible);
    const drawerOpen = model.compact && Object.values(model.boxes).some(box => box.visible);
    document.body.classList.toggle('panels-compact', model.compact);
    workspace.style.setProperty('--layout-content-left', `${model.contentLeft}px`);
    workspace.style.setProperty('--layout-content-right', `${model.contentRight}px`);
    for (const [name, panel] of Object.entries(panels)) {
      const box = model.boxes[name];
      const oldBox = previous?.boxes[name];
      panel.classList.toggle('panel-stack-transition', !!stackChanges && box.visible && oldBox.visible && oldBox.side === box.side);
      panel.hidden = !box.visible;
      panel.inert = !box.visible;
      // Keep the last visible rectangle until the panel fades out.
      if (box.visible) rect(panel, box);
      panel.dataset.dock = box.side;
      if (model.tabs) { panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `dock-tab-${name}`); }
      else { panel.removeAttribute('role'); panel.removeAttribute('aria-labelledby'); }
      const button = toggles[name];
      const label = `${box.visible ? '收起' : '显示'}${name === 'sidebar' ? '文件列表' : labels[name]}`;
      button.classList.toggle('on', box.visible); button.setAttribute('aria-pressed', String(box.visible));
      button.setAttribute('aria-label', label);
      button.title = `${label}（${formatKeys(panelShortcuts[name])}）`;
    }
    tabs.hidden = !model.tabs;
    if (model.tabs) rect(tabs, model.tabs);
    tabs.querySelectorAll('button').forEach(button => button.setAttribute('aria-selected', String(button.dataset.panel === model.prefs.tab)));
    scrim.hidden = !drawerOpen;
    scrim.inert = !drawerOpen;
    for (const side of ['left', 'right']) { const handle = grips[side]; handle.hidden = !model.grips[side]; if (!handle.hidden) { rect(handle, model.grips[side]); handle.setAttribute('aria-valuenow', String(Math.round(model.widths[side]))); } }
    grips.horizontal.hidden = !model.split;
    if (model.split) { rect(grips.horizontal, model.split); grips.horizontal.setAttribute('aria-valuenow', String(Math.round(model.prefs.ratio * 100))); }
    listeners.forEach(fn => fn(controller.get()));
  }
  function resizeHandle(side) {
    const handle = document.createElement('button'); handle.type = 'button'; handle.className = `panel-resizer ${side === 'horizontal' ? 'horizontal' : 'vertical'}`;
    handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', side === 'horizontal' ? 'horizontal' : 'vertical'); handle.setAttribute('aria-label', side === 'horizontal' ? '调整文件与大纲的高度' : '调整侧栏宽度');
    handle.setAttribute('aria-valuemin', side === 'horizontal' ? '25' : '176'); handle.setAttribute('aria-valuemax', side === 'horizontal' ? '75' : '420');
    let dragging = false, position = null;
    const keyForSide = () => ['left', 'right'].includes(model.prefs.preset) ? 'sharedWidth' : model.groups[side][0] + 'Width';
    handle.addEventListener('pointerdown', event => { if (event.button !== 0) return; event.preventDefault(); dragging = true; position = beforeChange(); handle.setPointerCapture(event.pointerId); });
    handle.addEventListener('pointermove', event => {
      if (!dragging) return;
      let patch;
      if (side === 'horizontal') { if (!model.split?.room) return; const ratio = (event.clientY - model.split.top) / model.split.room; patch = { ratio: model.split.first === 'sidebar' ? ratio : 1 - ratio }; }
      else patch = { [keyForSide()]: side === 'left' ? event.clientX - 8 : innerWidth - event.clientX - 8 };
      getSettings().panelLayout = normalizePanelLayout({ ...model.prefs, ...patch }); apply();
    });
    const finish = () => { if (!dragging) return; dragging = false; save(); restore(position); };
    handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish); handle.addEventListener('lostpointercapture', finish);
    handle.addEventListener('keydown', event => {
      const keys = side === 'horizontal' ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight']; if (!keys.includes(event.key)) return;
      event.preventDefault(); const delta = event.key === keys[1] ? 1 : -1;
      controller.set(side === 'horizontal' ? { ratio: model.prefs.ratio + delta * .05 * (model.split.first === 'sidebar' ? 1 : -1) } : { [keyForSide()]: model.widths[side] + delta * 12 * (side === 'left' ? 1 : -1) });
    });
    workspace.appendChild(handle); return handle;
  }
  const grips = Object.fromEntries(['left', 'right', 'horizontal'].map(side => [side, resizeHandle(side)]));
  const controller = {
    get: () => ({ preferences: normalizePanelLayout(getSettings().panelLayout), sidebar: getSettings().sidebar !== false, outline: !!getSettings().outline, compact: model?.compact }),
    subscribe(fn) { listeners.add(fn); fn(controller.get()); return () => listeners.delete(fn); },
    apply,
    set(patch) { const position = beforeChange(); getSettings().panelLayout = normalizePanelLayout({ ...normalizePanelLayout(getSettings().panelLayout), ...patch }); apply(); save(); restore(position); },
    toggle(name) {
      if (model.compact) { const position = beforeChange(); if (drawer === name) drawer = null; else { if (!getSettings()[name]) setPanel(name, true); drawer = name; } apply(); restore(position); }
      else if (getSettings()[name] && model.tabs && !model.boxes[name].visible) controller.set({ tab: name });
      else setPanel(name, !getSettings()[name]);
    },
    visibility: setPanel,
    mount: (host, options) => mountLayoutControls(host, controller, options),
  };
  window.addEventListener('resize', apply);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && drawer) { drawer = null; apply(); event.preventDefault(); } });
  apply();
  return controller;
}

export function mountLayoutControls(host, controller, { visibility = true } = {}) {
  host.classList.add('panel-layout-controls');
  host.innerHTML = `<div class="layout-presets">${PANEL_LAYOUTS.map(item => `<button type="button" class="layout-preset" data-layout="${item.id}" aria-pressed="false"><span class="layout-mini" aria-hidden="true">${item.cells.map(cell => cell === 'both' ? '<span class="layout-mini-stack"><b>文件</b><b>大纲</b></span>' : `<b class="${cell === 'content' ? 'document' : ''}">${labels[cell]}</b>`).join('')}</span><strong>${item.label}</strong><span>${item.description}</span></button>`).join('')}</div><div class="layout-same" hidden><span class="layout-field-label">同侧排列</span><div class="layout-choice"><button type="button" data-arrangement="stack">上下分区</button><button type="button" data-arrangement="tabs">标签切换</button></div><div class="layout-order"><span></span><button type="button" class="text-button">交换上下</button></div></div>${visibility ? '<div class="layout-visibility"><label><input type="checkbox" data-visible="sidebar">文件列表</label><label><input type="checkbox" data-visible="outline">大纲</label></div>' : ''}<p class="layout-note">自动记住布局；窄窗时收起侧栏，保留正文空间。</p>`;
  host.querySelectorAll('[data-layout]').forEach(button => button.addEventListener('click', () => { controller.set({ preset: button.dataset.layout }); }));
  host.querySelectorAll('[data-arrangement]').forEach(button => button.addEventListener('click', () => controller.set({ arrangement: button.dataset.arrangement })));
  host.querySelector('.layout-order button').addEventListener('click', () => controller.set({ order: controller.get().preferences.order === 'sidebar-first' ? 'outline-first' : 'sidebar-first' }));
  host.querySelectorAll('[data-visible]').forEach(input => input.addEventListener('change', () => controller.visibility(input.dataset.visible, input.checked)));
  return controller.subscribe(({ preferences, sidebar, outline }) => {
    host.querySelectorAll('[data-layout]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.layout === preferences.preset)));
    host.querySelector('.layout-same').hidden = !['left', 'right'].includes(preferences.preset);
    host.querySelectorAll('[data-arrangement]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.arrangement === preferences.arrangement)));
    host.querySelector('.layout-order').hidden = preferences.arrangement !== 'stack'; host.querySelector('.layout-order span').textContent = preferences.order === 'sidebar-first' ? '文件在上，大纲在下' : '大纲在上，文件在下';
    host.querySelectorAll('[data-visible]').forEach(input => { input.checked = input.dataset.visible === 'sidebar' ? sidebar : outline; });
  });
}
