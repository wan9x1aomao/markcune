// UI-only preferences. Window size changes the effective rectangles, never the saved choice.
export const PANEL_LAYOUTS = [
  { id: 'split', label: '左右分栏', description: '文件左，大纲右', cells: ['sidebar', 'content', 'outline'] },
  { id: 'reverse', label: '反向分栏', description: '大纲左，文件右', cells: ['outline', 'content', 'sidebar'] },
  { id: 'left', label: '集中在左', description: '文件与大纲都在左', cells: ['both', 'content'] },
  { id: 'right', label: '集中在右', description: '文件与大纲都在右', cells: ['content', 'both'] },
];
const limit = (value, fallback, min, max) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
export function normalizePanelLayout(value = {}) {
  value = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    preset: PANEL_LAYOUTS.some(item => item.id === value.preset) ? value.preset : 'split',
    arrangement: value.arrangement === 'tabs' ? 'tabs' : 'stack',
    order: value.order === 'outline-first' ? 'outline-first' : 'sidebar-first',
    tab: value.tab === 'outline' ? 'outline' : 'sidebar',
    sidebarWidth: limit(value.sidebarWidth, 260, 176, 420),
    outlineWidth: limit(value.outlineWidth, 232, 176, 420),
    sharedWidth: limit(value.sharedWidth, 260, 176, 420),
    ratio: limit(value.ratio, .56, .25, .75),
  };
}
export function panelSides(preset) {
  return { sidebar: preset === 'reverse' || preset === 'right' ? 'right' : 'left', outline: preset === 'reverse' || preset === 'left' ? 'left' : 'right' };
}
export function resolvePanelLayout({ preferences, sidebar = true, outline = false, width, height, inset = 8, header = 44, focus = false, drawer = null }) {
  const prefs = normalizePanelLayout(preferences);
  width = Math.max(0, Number(width) || 0); height = Math.max(0, Number(height) || 0);
  const sides = panelSides(prefs.preset);
  const groups = { left: [], right: [] };
  if (sidebar && !focus) groups[sides.sidebar].push('sidebar');
  if (outline && !focus) groups[sides.outline].push('outline');
  const columns = ['left', 'right'].filter(side => groups[side].length);
  const wanted = Object.fromEntries(columns.map(side => [side, ['left', 'right'].includes(prefs.preset) ? prefs.sharedWidth : prefs[groups[side][0] + 'Width']]));
  const budget = Math.max(0, width - 420 - columns.length * 2 * inset);
  const compact = !!columns.length && budget < columns.length * 176;
  const result = { prefs, sides, groups, compact, contentLeft: 0, contentRight: 0, boxes: {}, widths: {}, tabs: null, split: null, grips: {} };
  const y = Math.min(height, header), available = Math.max(0, height - y - inset);
  for (const name of ['sidebar', 'outline']) result.boxes[name] = { x: inset, y, width: 0, height: 0, visible: false, side: sides[name] };
  if (compact) {
    if (drawer && groups[sides[drawer]]?.includes(drawer)) {
      const w = Math.max(0, Math.min(width - inset * 2, wanted[sides[drawer]]));
      result.boxes[drawer] = { x: sides[drawer] === 'left' ? inset : width - inset - w, y, width: w, height: available, visible: true, side: sides[drawer] };
    }
    return result;
  }
  const total = Object.values(wanted).reduce((sum, value) => sum + value, 0);
  const flexible = Math.max(1, total - columns.length * 176);
  for (const side of columns) {
    const names = groups[side];
    const w = total <= budget ? wanted[side] : 176 + (wanted[side] - 176) * Math.max(0, budget - columns.length * 176) / flexible;
    result.widths[side] = w;
    result[side === 'left' ? 'contentLeft' : 'contentRight'] = w + inset * 2;
    const x = side === 'left' ? inset : width - inset - w;
    result.grips[side] = { x: side === 'left' ? x + w : x - inset, y, width: inset, height: available };
    if (names.length === 1) result.boxes[names[0]] = { x, y, width: w, height: available, visible: true, side };
    else if (prefs.arrangement === 'tabs') {
      const tabHeight = Math.min(34, available);
      result.tabs = { x, y, width: w, height: tabHeight };
      for (const name of names) result.boxes[name] = { x, y: y + tabHeight + 4, width: w, height: Math.max(0, available - tabHeight - 4), visible: name === prefs.tab, side };
    } else {
      const gap = Math.min(10, available), room = available - gap;
      const first = prefs.order === 'sidebar-first' ? 'sidebar' : 'outline';
      const second = first === 'sidebar' ? 'outline' : 'sidebar';
      const firstHeight = room * (first === 'sidebar' ? prefs.ratio : 1 - prefs.ratio);
      result.boxes[first] = { x, y, width: w, height: firstHeight, visible: true, side };
      result.split = { x, y: y + firstHeight, width: w, height: gap, first, room, top: y };
      result.boxes[second] = { x, y: y + firstHeight + gap, width: w, height: room - firstHeight, visible: true, side };
    }
  }
  return result;
}
