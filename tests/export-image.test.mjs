// 导出为图片：规划（纯函数）、PNG 头解析、各处接线的静态检查。Run: node tests/export-image.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LIMITS, pngInfo, planImage } from '../src/image-plan.js';

const root = new URL('..', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

// ---- 规划
const blocksOf = (count, each, gap = 16) =>
  Array.from({ length: count }, (_, i) => ({ top: i * (each + gap), bottom: i * (each + gap) + each }));
const layoutOf = (blocks, width = 760) => ({ width, height: blocks.at(-1).bottom + 80, blocks });

{
  const short = planImage({ width: 760, height: 3000, blocks: blocksOf(10, 280) });
  assert.equal(short.scale, 2);
  assert.equal(short.parts.length, 1);
  assert.equal(short.reduced, false);
  assert.equal(short.tooLong, false);

  const medium = planImage({ width: 760, height: 20000, blocks: blocksOf(100, 190) });
  assert.equal(medium.scale, 1.5);
  assert.equal(medium.reduced, true);
  assert.equal(medium.parts.length, 1);
  assert.ok(20000 * medium.scale <= LIMITS.maxSide);

  const blocks = blocksOf(500, 190); // 高约 103000
  const layout = layoutOf(blocks);
  const long = planImage(layout);
  assert.equal(long.scale, 1);
  assert.ok(long.parts.length > 1 && !long.tooLong);
  const starts = new Set(blocks.map((b) => b.top));
  const ends = new Set(blocks.map((b) => b.bottom));
  long.parts.forEach((part, i) => {
    assert.ok(part.height * long.scale <= LIMITS.maxSide, '每段不超过单边上限');
    assert.ok(!part.hardCut);
    if (i > 0) {
      // 切点落在上一块的底边与下一块的顶边之间（块间距里）
      const before = Math.max(...[...ends].filter((e) => e <= part.y));
      const after = Math.min(...[...starts].filter((s) => s >= part.y));
      assert.ok(before <= part.y && part.y <= after, `切点 ${part.y} 不在块边界`);
    }
  });
  const last = long.parts.at(-1);
  assert.equal(last.y + last.height, Math.ceil(layout.height), '各段首尾相接并覆盖全文');
  long.parts.slice(1).forEach((part, i) => assert.equal(part.y, long.parts[i].y + long.parts[i].height));

  // 单个超高块：独占并被硬切，其余切点仍在块边界
  const tall = [...blocksOf(3, 200), { top: 648, bottom: 648 + 70000 }, { top: 70664, bottom: 70664 + 200 }];
  const cut = planImage({ width: 760, height: 70944, blocks: tall });
  assert.equal(cut.scale, 1);
  assert.ok(cut.parts.some((p) => p.hardCut));
  assert.ok(cut.parts.every((p) => p.height <= LIMITS.maxSide));
  assert.equal(cut.parts[0].y, 0);
  assert.ok(cut.parts[0].height <= 648 && !cut.parts[0].hardCut, '超高块之前的内容单独成段');
  assert.equal(cut.parts.at(-1).y + cut.parts.at(-1).height, 70944);

  // 太长
  assert.equal(planImage(layoutOf(blocksOf(2000, 190))).tooLong, true);

  // 自定义上限
  const small = planImage(layoutOf(blocksOf(60, 190)), { maxSide: 4000 });
  assert.ok(small.reduced || small.parts.length > 1);
  assert.ok(small.parts.every((p) => p.height * small.scale <= 4000));
  const tiny = planImage({ width: 760, height: 1500, blocks: blocksOf(5, 250) }, { maxSide: 1000 });
  assert.equal(tiny.scale, 1);
  assert.equal(tiny.parts.length, 2);
  assert.ok(tiny.parts.every((p) => p.height <= 1000));

  // 面积上限
  const area = planImage({ width: 760, height: 10000, blocks: blocksOf(40, 240) }, { maxArea: 10_000_000 });
  assert.ok(760 * area.scale * 10000 * area.scale <= 10_000_000 || area.parts.length > 1);
}

// ---- PNG 头
{
  const png = new Uint8Array(33);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(png.buffer).setUint32(16, 1520);
  new DataView(png.buffer).setUint32(20, 6000);
  assert.deepEqual(pngInfo(png), { width: 1520, height: 6000 });
  assert.equal(pngInfo(png.slice(0, 20)), null, '截断');
  assert.equal(pngInfo(new TextEncoder().encode('<html>'.repeat(10))), null, '非 PNG');
  const noIhdr = png.slice();
  noIhdr[12] = 0x4a;
  assert.equal(pngInfo(noIhdr), null);
  assert.equal(pngInfo(null), null);
}

// ---- 接线（读源码文本；commands.js 依赖 navigator，Node 20 里不能直接 import）
{
  const commands = read('src/commands.js');
  const line = commands.split('\n').find((l) => l.includes("id: 'export-image'"));
  assert.ok(line, 'commands.js 缺少 export-image');
  assert.match(line, /group: '导出'/);
  assert.match(line, /title: '导出为图片…'/);
  for (const word of ['图片', 'png', '长图']) assert.ok(line.includes(word), `关键词缺少 ${word}`);
  assert.ok(commands.indexOf("id: 'export-image'") > commands.indexOf("id: 'export-pdf'"), '应在 export-pdf 之后');
  assert.doesNotMatch(line, /keys:/, '不设快捷键');

  const rust = read('src-tauri/src/main.rs');
  assert.match(
    rust,
    /item\("export-pdf", "导出为 PDF…", None\)\?,\s*&item\("export-image", "导出为图片…", None\)\?/,
    '原生菜单应在导出为 PDF 之后',
  );
  assert.match(rust.slice(rust.indexOf('generate_handler!')), /export_image,/);
  assert.match(rust, /async fn export_image\(/);

  const main = read('src/main.js');
  assert.match(main, /'export-image': exportImage,/);
  assert.match(main, /item\('export-pdf'\),\s*item\('export-image'\)/);
  assert.match(main, /image: buildExportImage/);

  const bridge = read('src/bridge.js');
  assert.match(bridge, /exportImage:[\s\S]{0,120}invoke\('export_image'/);

  for (const file of ['src/image-plan.js', 'src/export-image.js', 'tests/export-image.test.mjs']) {
    assert.doesNotMatch(read(file), new RegExp('MD' + 'Pad'), `${file} 出现旧品牌名`);
  }
}

console.log('export-image ok（规划、PNG 头、接线）');
