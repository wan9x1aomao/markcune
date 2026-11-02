// The sentence every export ends with. HTML, PDF and the long picture share `exportCreditHtml`;
// Word uses the same words after its own rule. Markdown uses `appendExportCredit` so a later
// exporter cannot drift onto a different spelling or a missing separator.

/** 导出文件末尾的署名，各格式共用这一句，一个字都不能改。 */
export const EXPORT_CREDIT = '由MarkCune导出';

/**
 * 正文结束后空一行、一条分隔线、再空一行，然后是署名。
 * 空文档只留署名这一段，不在开头堆空行。
 */
export function appendExportCredit(markdown) {
  const body = String(markdown ?? '').replace(/\s+$/u, '');
  const footer = `---\n\n${EXPORT_CREDIT}`;
  if (!body) return `${footer}\n`;
  return `${body}\n\n${footer}\n`;
}

/** 跟在导出正文后面的分隔线和署名。调用方把它放进文档末尾，不要插在段落中间。 */
export function exportCreditHtml() {
  return `<hr>\n<p class="export-credit">${EXPORT_CREDIT}</p>`;
}
