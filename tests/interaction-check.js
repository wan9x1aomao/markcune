// Runs inside the real app (MDPAD_TEST_JS) and reports whether the two WebView2-sensitive
// interactions work. Used by .github/workflows/preview.yml on a real Windows runner; the same
// script runs on macOS for local checks. Return value: one JSON line.
await new Promise((r) => setTimeout(r, 1000));
const editor = () => window.__mdpadDebug.editor;
const mouse = (target, type, x, y, extra = {}) =>
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'mousemove' ? 1 : 0, ...extra }));

// --- left margin: click places the caret, drag selects text (the Windows report) ---
await editor().setMarkdown('# 标题\n\n第一段正文内容，用来测试点击与选中位置。\n\n第二段正文内容，稍微长一点。\n');
await new Promise((r) => setTimeout(r, 900));
const prose = document.querySelector('#editor .ProseMirror') ?? document.querySelector('.ProseMirror');
const para = [...prose.querySelectorAll('p')].find((p) => p.textContent.includes('第一段'));
const rect = para.getBoundingClientRect();
const y = rect.top + rect.height / 2;

mouse(prose, 'mousedown', rect.left - 40, y);
document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: rect.left - 40, clientY: y, button: 0 }));
await new Promise((r) => setTimeout(r, 250));
const caret = editor().view.state.selection;
const marginCaretOk = caret.empty && editor().view.state.doc.resolve(caret.from).parent.textContent.includes('第一段');

mouse(prose, 'mousedown', rect.left - 40, y);
for (const dx of [40, 100, 180]) {
  document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: rect.left - 40 + dx, clientY: y, button: 0, buttons: 1 }));
  await new Promise((r) => setTimeout(r, 40));
}
document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: rect.left + 140, clientY: y, button: 0 }));
await new Promise((r) => setTimeout(r, 300));
const range = editor().view.state.selection;
const marginDragOk = !range.empty
  && editor().view.state.doc.textBetween(range.from, range.to, '\n').includes('第一段正文内容');

// right padding: caret at the end of the clicked line, not in the next block
mouse(prose, 'mousedown', rect.right + 30, y);
document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: rect.right + 30, clientY: y, button: 0 }));
await new Promise((r) => setTimeout(r, 250));
const rightPad = editor().view.state.selection;
const rightPadOk = rightPad.empty === true
  && editor().view.state.doc.resolve(rightPad.from).parent.textContent.includes('第一段');

// an <hr> next to the margin: margin clicks must land a text caret, not select the atom
await editor().setMarkdown('# 标题\n\n分割线前的段落。\n\n---\n\n分割线后的段落。\n');
await new Promise((r) => setTimeout(r, 800));
const hr = (document.querySelector('#editor .ProseMirror') ?? document.querySelector('.ProseMirror')).querySelector('hr');
const hrRect = hr.getBoundingClientRect();
mouse(prose, 'mousedown', hrRect.left - 30, hrRect.top + 4);
document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: hrRect.left - 30, clientY: hrRect.top + 4, button: 0 }));
await new Promise((r) => setTimeout(r, 250));
const atomSel = editor().view.state.selection;
const atomParent = editor().view.state.doc.resolve(atomSel.from).parent;
const atomCaretOk = atomSel.empty === true && atomParent.type.name === 'paragraph';


// --- table: colgroup present, content-sized layout, dragging a border changes the width ---
await editor().setMarkdown('# 表格\n\n| 甲 | 乙长一点 | 丙 |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n');
await new Promise((r) => setTimeout(r, 1000));
const table = document.querySelector('.milkdown-table-block tbody[data-content-dom]')?.closest('table');
const colgroup = table?.querySelector(':scope > colgroup');
const tableColsOk = !!table && !!colgroup && colgroup.children.length === 3;
const tableLayout = table ? getComputedStyle(table).tableLayout : 'none';
// Apply explicit widths the way a committed drag does, then check the view/CSS took them.
let tableWidthsApplied = false;
try {
  const view = editor().view;
  const tr = view.state.tr;
  view.state.doc.descendants((node, pos) => {
    if (node.type.spec.tableRole === 'cell') tr.setNodeMarkup(pos, undefined, { ...node.attrs, colwidth: [260] });
  });
  view.dispatch(tr);
  await new Promise((r) => setTimeout(r, 600));
  const sized = document.querySelector('.milkdown-table-block tbody[data-content-dom]')?.closest('table');
  const cols = sized ? [...sized.querySelectorAll(':scope > colgroup > col')] : [];
  tableWidthsApplied = cols.length === 3
    && cols.every((col) => col.style.width !== '')
    && getComputedStyle(sized).tableLayout === 'fixed';
} catch {}
let resizeChanged = false;
if (table) {
  const cells = [...table.querySelectorAll('tr')[1].children];
  const first = cells[0].getBoundingClientRect();
  const startWidth = first.width;
  const edgeX = first.right - 2;
  const edgeY = (first.top + first.bottom) / 2;
  cells[0].dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: edgeX, clientY: edgeY, button: 0 }));
  await new Promise((r) => setTimeout(r, 300));
  cells[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: edgeX, clientY: edgeY, button: 0 }));
  for (const dx of [20, 50, 90]) {
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: edgeX + dx, clientY: edgeY, button: 0, buttons: 1 }));
    await new Promise((r) => setTimeout(r, 50));
  }
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: edgeX + 90, clientY: edgeY, button: 0 }));
  await new Promise((r) => setTimeout(r, 600));
  // Vue may have re-rendered the table during the drag; re-query instead of trusting the old node.
  const after = document.querySelector('.milkdown-table-block tbody[data-content-dom]')?.closest('table');
  const bodyRow = after ? [...after.querySelectorAll('tbody tr')][1] : null;
  resizeChanged = !!bodyRow && bodyRow.children[0].getBoundingClientRect().width >= startWidth + 40;
}
// clicking a cell must place a text caret in it (the table has its own handles on the edges)
let cellCaretOk = false;
const tableForClick = document.querySelector('.milkdown-table-block tbody[data-content-dom]')?.closest('table');
if (tableForClick) {
  const bodyCell = [...tableForClick.querySelectorAll('tbody tr')][1]?.children[0];
  if (bodyCell) {
    const cr = bodyCell.getBoundingClientRect();
    bodyCell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: cr.left + 10, clientY: cr.top + cr.height / 2, button: 0 }));
    bodyCell.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: cr.left + 10, clientY: cr.top + cr.height / 2, button: 0 }));
    await new Promise((r) => setTimeout(r, 250));
    const cellSel = editor().view.state.selection;
    cellCaretOk = cellSel.empty === true
      && editor().view.state.doc.resolve(cellSel.from).parent.type.name === 'paragraph';
  }
}

return JSON.stringify({ marginCaretOk, marginDragOk, rightPadOk, atomCaretOk, tableColsOk, tableLayout, tableWidthsApplied, cellCaretOk, resizeChanged });
