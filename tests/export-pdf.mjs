// Prints a long document through the real export path and checks the PDF still has
// its start, middle and end. Chrome's print-to-PDF is the stand-in here.
// macOS WKWebView and Windows WebView2 were not run. A screen height of 0 is not treated as a proven cause.
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, sleep } from './cdp.mjs';

const chrome = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((path) => path && existsSync(path));

if (!chrome) {
  if (process.env.REQUIRE_CHROME) {
    console.error('PDF 回归需要 Chrome');
    process.exit(1);
  }
  console.log('SKIP  PDF 回归（没有 Chrome）');
  process.exit(0);
}

const PORT = 5221;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const rows = Array.from({ length: 80 }, (_, i) => `| R${String(i + 1).padStart(2, '0')} | 单元格 ${i + 1} ${'说明 '.repeat(6)} | ${i} |`);
const tall = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="4000"><rect width="80" height="4000" fill="#ddd"/><text y="24">MARK-TALL</text></svg>`;
const code = Array.from({ length: 80 }, (_, i) => `const line${i + 1} = "CODE-${String(i + 1).padStart(3, '0')}";`);
const paras = Array.from({ length: 16 }, (_, i) => `段落 P${String(i + 1).padStart(2, '0')}。${'这是跨页正文。'.repeat(12)}`);
const markdown = [
  '# MARK-START 开头',
  '',
  ...paras.flatMap((p) => [p, '']),
  '## MARK-MIDDLE 中段',
  '',
  '| 行 | 说明 | 值 |',
  '| --- | --- | --- |',
  ...rows,
  '',
  '```js',
  ...code,
  '```',
  '',
  '$$',
  '\\int_0^1 x^2 \\, dx',
  '$$',
  '',
  '```mermaid',
  'flowchart LR',
  '  A[MARK-MERMAID] --> B[完成]',
  '```',
  '',
  `![高图](data:image/svg+xml,${encodeURIComponent(tall)})`,
  '![本地](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==)',
  '',
  '![远程](https://example.invalid/pixel.png)',
  '',
  '# MARK-END 结尾',
  '',
  'MARK-LAST-SENTENCE',
  '',
].join('\n');

const server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
  cwd: ROOT,
  stdio: 'ignore',
});
try {
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try {
      up = (await fetch(`http://127.0.0.1:${PORT}/__lab.html`)).ok;
    } catch {
      await sleep(200);
    }
  }
  if (!up) throw new Error('开发服务器没有起来');
  const page = await open(`http://127.0.0.1:${PORT}/__lab.html`, { width: 1100, height: 800, scale: 1 });
  try {
    if (!(await page.waitFor('window.__ready === true', 160))) {
      throw new Error(await page.evaluate('window.__err || "lab not ready"'));
    }
    await page.evaluate(`window.__lab.setDoc(${JSON.stringify(markdown)})`);
    await sleep(300);
    const laid = await page.evaluate(`(async () => {
      const { preparePrint } = await import('/export.js');
      const { renderMermaid } = await import('/diagram.js');
      const height = await preparePrint(window.__lab.view.state.doc, {
        imageWaitMs: 500,
        image: async (src) => src.startsWith('http') ? 'https://127.0.0.1:9/never.png' : src,
        diagram: (code) => renderMermaid(code, 'light', { htmlLabels: false }),
      });
      document.documentElement.classList.add('printing');
      const root = document.getElementById('print-root');
      const text = root.innerText;
      const pre = root.querySelector('pre');
      const tallImage = [...root.querySelectorAll('img')].find((img) => (img.alt || '').includes('高图'));
      const preStyle = pre ? getComputedStyle(pre) : null;
      const imageStyle = tallImage ? getComputedStyle(tallImage) : null;
      return {
        height,
        scroll: root.scrollHeight,
        start: text.includes('MARK-START'),
        middle: text.includes('MARK-MIDDLE'),
        end: text.includes('MARK-LAST-SENTENCE'),
        credit: text.includes('由MarkCune导出'),
        code: text.includes('CODE-080'),
        row: text.includes('R80'),
        tall: Boolean(tallImage),
        overflow: preStyle && preStyle.overflow,
        breakInside: preStyle && (preStyle.breakInside || preStyle.pageBreakInside),
        imageMax: imageStyle && imageStyle.maxHeight,
      };
    })()`);
    if (laid.__error) throw new Error(laid.__error);
    console.log('layout', JSON.stringify(laid));
    for (const key of ['start', 'middle', 'end', 'credit', 'code', 'row', 'tall']) {
      if (!laid[key]) throw new Error(`打印树缺少 ${key}`);
    }
    if (!(laid.scroll > 400)) throw new Error(`打印树没有高度：${laid.scroll}`);
    if (laid.overflow === 'hidden') throw new Error('html.printing 下代码块仍是 overflow:hidden，分页规则没有进屏幕布局');
    if (!laid.imageMax || laid.imageMax === 'none') throw new Error(`超高图没有 max-height：${laid.imageMax}`);
    const pdf = await page.send('Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
      paperWidth: 8.27,
      paperHeight: 11.69,
      marginTop: 0,
      marginBottom: 0,
      marginLeft: 0,
      marginRight: 0,
    });
    const dir = mkdtempSync(join(tmpdir(), 'mdpad-pdf-'));
    const file = join(dir, 'export.pdf');
    writeFileSync(file, Buffer.from(pdf.result.data, 'base64'));
    writeFileSync('/opt/cursor/artifacts/export-pdf-regression.pdf', readFileSync(file));
    const text = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
    writeFileSync('/opt/cursor/artifacts/export-pdf-regression.txt', text);
    const pages = execFileSync('pdfinfo', [file], { encoding: 'utf8' }).match(/Pages:\s+(\d+)/)?.[1];
    console.log('pdf pages', pages, 'bytes', pdf.result.data.length);
    for (const marker of ['MARK-START', 'MARK-MIDDLE', 'R80', 'CODE-080', 'MARK-END', 'MARK-LAST-SENTENCE', '由MarkCune导出']) {
      if (!text.includes(marker)) throw new Error(`PDF 缺少 ${marker}`);
      console.log('YES', marker);
    }
    if (Number(pages) < 2) throw new Error(`PDF 只有 ${pages} 页，长文没有分页`);
    console.log('PDF 回归通过');
  } finally {
    page.close();
  }
} finally {
  server.kill();
}
