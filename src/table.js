// Resizable tables.
//
// Crepe's table block owns the table DOM and offers no way to drag column borders. Milkdown ships
// prosemirror-tables' `columnResizing` plugin, but it only works when the table node view renders
// `<table><colgroup/><tbody/></table>` itself — table-block renders a Vue wrapper, and its node view
// wins over the plugin's own. So: subclass the public TableNodeView, slot a colgroup into the real
// `<table>` (table-block also keeps a hidden drag-preview clone), and keep it in sync with the
// cells' `colwidth` attributes. The stock plugin then does hit-testing and commits widths on drag.
//
// Markdown tables have no width field, so the widths are remembered on this machine in the app
// settings, keyed by document and table, and re-applied every time the editor mounts.
import { TableNodeView } from '@milkdown/kit/component/table-block';
import { columnResizingPlugin, tableSchema } from '@milkdown/kit/preset/gfm';
import { TableMap, updateColumnsOnResize } from '@milkdown/kit/prose/tables';
import { $view } from '@milkdown/kit/utils';

/** Narrowest a column can be dragged; matches the resize handle's minimum. */
const MIN_CELL_WIDTH = 80;

class ResizableTableNodeView extends TableNodeView {
  constructor(ctx, node, view, getPos) {
    super(ctx, node, view, getPos);
    // Vue finishes mounting the wrapper after super(); syncColumns retries across a frame.
    this.syncColumns();
  }

  /** The real `<table>`: the parent of the content tbody (a drag-preview clone comes first). */
  tableElement() {
    const parent = this.contentDOM?.parentNode;
    if (parent && parent.tagName === 'TABLE') return parent;
    return this.dom.querySelector('.table-wrapper > table');
  }

  syncColumns() {
    const table = this.tableElement();
    if (!table) {
      // The tbody is appended by Vue's mount; give it another frame, then give up if detached.
      requestAnimationFrame(() => {
        if (this.dom.isConnected) this.syncColumns();
      });
      return;
    }
    let colgroup = table.querySelector(':scope > colgroup');
    if (!colgroup) {
      colgroup = document.createElement('colgroup');
      table.insertBefore(colgroup, table.firstChild);
    }
    updateColumnsOnResize(this.node, colgroup, table, MIN_CELL_WIDTH);
  }

  update(node) {
    const ok = super.update(node);
    if (ok) this.syncColumns();
    return ok;
  }
}

export const resizableTable = $view(
  tableSchema.node,
  (ctx) => (node, view, getPos) => new ResizableTableNodeView(ctx, node, view, getPos),
);

export { columnResizingPlugin };

const tableTypeOf = (view) => view.state.schema.nodes.table;

/** The table DOM for a top-level table node, or null while it is not rendered. */
function tableDom(view, pos) {
  const block = view.nodeDOM(pos);
  if (!block?.querySelector) return null;
  const tbody = block.querySelector('tbody[data-content-dom]');
  return tbody ? tbody.closest('table') : block.querySelector('.table-wrapper > table');
}

/**
 * Widths currently shown, one entry per top-level table: an array of pixels when the table has
 * been resized, null when it is still content-sized. Read from the rendered cells, so a table
 * restored from the settings file counts as resized even though its markdown carries no widths.
 */
export function readTableWidths(view) {
  const tableType = tableTypeOf(view);
  const widths = [];
  view.state.doc.forEach((node, pos) => {
    if (node.type !== tableType) return;
    const table = tableDom(view, pos);
    const firstRow = table?.querySelector('tbody tr');
    const cells = firstRow ? [...firstRow.children] : [];
    const resized = [...(table?.querySelectorAll(':scope > colgroup > col') ?? [])].some((col) => col.style.width);
    if (!resized || !cells.length) {
      widths.push(null);
      return;
    }
    widths.push(cells.map((cell) => Math.round(cell.getBoundingClientRect().width)));
  });
  return widths;
}

/**
 * Re-applies remembered widths without touching the document: only the table's colgroup is set.
 * That keeps mode switches and reopening invisible in the undo history and in the saved markdown.
 */
export function applyTableWidths(view, saved) {
  if (!Array.isArray(saved) || !saved.length) return false;
  const tableType = tableTypeOf(view);
  let index = 0;
  let applied = false;
  view.state.doc.forEach((node, pos) => {
    if (node.type !== tableType) return;
    const widths = saved[index++];
    if (!widths) return;
    const table = tableDom(view, pos);
    const colgroup = table?.querySelector(':scope > colgroup');
    const cols = colgroup ? [...colgroup.children] : [];
    if (cols.length !== widths.length) return;
    for (const [i, col] of cols.entries()) col.style.width = `${widths[i]}px`;
    applied = true;
  });
  return applied;
}

/** Re-applies once the table node views have finished mounting (their colgroup is async). */
export function restoreTableWidths(view, saved) {
  if (!saved?.length) return;
  let attempts = 0;
  const tick = () => {
    if (applyTableWidths(view, saved) || ++attempts > 20) return;
    requestAnimationFrame(tick);
  };
  tick();
}

/** Whether a table's rendered widths differ from the remembered ones (for capturing changes). */
export function tableWidthsChanged(view, saved) {
  const current = readTableWidths(view);
  return JSON.stringify(current) !== JSON.stringify(saved ?? []);
}
