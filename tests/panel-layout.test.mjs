import assert from 'node:assert/strict';
import { normalizePanelLayout, PANEL_LAYOUTS, resolvePanelLayout } from '../src/panel-layout-model.js';

const resolve = (preferences, extra = {}) => resolvePanelLayout({ preferences, sidebar: true, outline: true, width: 1280, height: 800, ...extra });
assert.equal(normalizePanelLayout(null).preset, 'split');
assert.equal(normalizePanelLayout({ preset: 'unknown', ratio: Infinity, sharedWidth: -1 }).sharedWidth, 176);
assert.equal(normalizePanelLayout({ ratio: Infinity }).ratio, .56);
assert.equal(normalizePanelLayout({ ratio: 10 }).ratio, .75);
for (const [preset, sidebarSide, outlineSide] of [['split', 'left', 'right'], ['reverse', 'right', 'left'], ['left', 'left', 'left'], ['right', 'right', 'right']]) {
  const result = resolve({ preset });
  assert.equal(result.boxes.sidebar.side, sidebarSide);
  assert.equal(result.boxes.outline.side, outlineSide);
  assert.equal(result.boxes.sidebar.visible, true);
  assert.equal(result.boxes.outline.visible, true);
  assert.equal(Boolean(result.split), sidebarSide === outlineSide);
}
for (const preset of ['left', 'right']) {
  const stacked = resolve({ preset, order: 'outline-first', ratio: .6 });
  assert.ok(stacked.boxes.outline.y < stacked.boxes.sidebar.y);
  assert.ok(stacked.boxes.sidebar.height > stacked.boxes.outline.height);
  const tabs = resolve({ preset, arrangement: 'tabs', tab: 'outline' });
  assert.equal(tabs.boxes.sidebar.visible, false);
  assert.equal(tabs.boxes.outline.visible, true);
  assert.ok(tabs.tabs);
  assert.equal(tabs.split, null);
  const onlyFile = resolve({ preset, arrangement: 'tabs', tab: 'outline' }, { outline: false });
  assert.equal(onlyFile.boxes.sidebar.visible, true, 'hidden outline cannot hide the remaining file panel');
  assert.equal(onlyFile.tabs, null);
  assert.equal(resolve({ preset, sharedWidth: 350 }, { outline: false }).widths[preset], 350, 'hiding one same-side panel keeps the shared width');
}
const narrow = resolve({ preset: 'reverse', sidebarWidth: 400, outlineWidth: 400 }, { width: 700 });
assert.equal(narrow.compact, true);
assert.equal(narrow.contentLeft + narrow.contentRight, 0);
assert.equal(narrow.boxes.sidebar.visible || narrow.boxes.outline.visible, false);
const drawer = resolve({ preset: 'reverse' }, { width: 700, drawer: 'outline' });
assert.equal(drawer.boxes.outline.visible, true);
assert.equal(drawer.boxes.outline.side, 'left');
const prefs = { preset: 'left', sharedWidth: 400, ratio: .7 };
const saved = JSON.stringify(prefs);
resolve(prefs, { width: 650 });
assert.equal(JSON.stringify(prefs), saved, 'automatic fitting must not overwrite preferences');
assert.equal(resolve(prefs).widths.left, 400, 'wide windows restore the chosen width');
const focused = resolve(prefs, { focus: true, drawer: 'sidebar' });
assert.equal(focused.boxes.sidebar.visible || focused.boxes.outline.visible, false);
assert.equal(focused.contentLeft + focused.contentRight, 0);

let cases = 0;
for (const preset of PANEL_LAYOUTS.map(p => p.id)) for (const arrangement of ['stack', 'tabs']) for (const sidebar of [true, false]) for (const outline of [true, false]) for (const width of [640, 800, 1024, 1440]) for (const height of [500, 800]) {
  const result = resolve({ preset, arrangement }, { sidebar, outline, width, height });
  for (const box of Object.values(result.boxes)) {
    assert.ok(box.width >= 0 && box.height >= 0);
    if (box.visible) assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width + .01 && box.y + box.height <= height + .01);
  }
  if (!result.compact) assert.ok(width - result.contentLeft - result.contentRight >= 420);
  cases++;
}
console.log(`panel layout ok（${cases} 个排列、显隐和窗口尺寸组合）`);
