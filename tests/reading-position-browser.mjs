import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { open, sleep } from './cdp.mjs';

const port = 5241;
const root = fileURLToPath(new URL('..', import.meta.url));
const server = spawn('npx', ['vite', '--port', String(port), '--host', '127.0.0.1', '--strictPort'], { cwd: root, stdio: 'ignore' });
let page;
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try { ready = (await fetch(`http://127.0.0.1:${port}/__lab.html`)).ok; } catch {}
    if (ready) break;
    await sleep(200);
  }
  if (!ready) throw new Error('阅读位置测试服务器没有启动');
  page = await open(`http://127.0.0.1:${port}/__lab.html`);
  if (!await page.waitFor('window.__ready === true')) throw new Error('测试编辑器没有启动');
  const result = await page.evaluate(`(async () => {
    const wait=ms=>new Promise(r=>setTimeout(r,ms));
    const editor=window.__lab.editor;
    const pane=document.getElementById('root');
    pane.style.height='600px';pane.style.overflowY='auto';pane.style.overflowAnchor='none';
    editor.setMarkdown('# 起点\\n\\n'+Array.from({length:80},(_,i)=>'第 '+i+' 段内容。').join('\\n\\n'));
    await wait(150);
    pane.scrollTop=900;
    const saved=editor.getPosition();
    editor.setPosition(saved);
    await wait(100);
    const afterSet=editor.getPosition();
    const node=editor.view.nodeDOM(0);
    const beforeHeight=node.getBoundingClientRect().height;
    // Change layout outside the editable DOM; direct style mutations on a node
    // are parsed and removed by ProseMirror rather than simulating a load.
    const style=document.createElement('style');document.head.appendChild(style);
    style.textContent='.ProseMirror h1 {min-height:240px!important}';
    await wait(200);
    const heightChanged=node.isConnected && node.getBoundingClientRect().height>beforeHeight+100;
    const afterResize=editor.getPosition();
    const sameBlock=saved.top.pos===afterResize.top.pos && Math.abs(saved.top.offset-afterResize.top.offset)<=1;
    editor.setPosition({mode:'rich',anchor:1,scrollTop:900});
    style.textContent='.ProseMirror h1 {min-height:300px!important}';
    await wait(200);
    const legacy=pane.scrollTop;
    document.dispatchEvent(new WheelEvent('wheel'));
    pane.scrollTop=400;
    style.textContent='.ProseMirror h1 {min-height:340px!important}';
    await wait(200);
    const userScroll=pane.scrollTop;
    await editor.destroy();
    style.remove();
    pane.replaceChildren();
    const {createRichEditor}=await import('/editor.js');
    const large=await createRichEditor({root:pane,scroller:pane,content:'# 长文\\n\\n'+Array.from({length:260},(_,i)=>'第 '+i+' 个长文段落。').join('\\n\\n'),onChange:()=>{}});
    pane.scrollTop=2200;await wait(300);
    const largeSaved=large.getPosition();
    large.setPosition(largeSaved);await wait(250);
    const largeAfter=large.getPosition();
    const largeSame=largeSaved.top.pos===largeAfter.top.pos && Math.abs(largeSaved.top.offset-largeAfter.top.offset)<=1;
    await large.destroy();
    return {saved,afterSet,afterResize,heightChanged,sameBlock,legacy,userScroll,largeSaved,largeAfter,largeSame};
  })()`);
  console.log(JSON.stringify(result));
  if (!result.heightChanged || !result.sameBlock || !result.largeSame || result.legacy !== 900 || result.userScroll !== 400) throw new Error('阅读位置、旧配置兼容或用户滚动回归');
  console.log('PASS 阅读段落在异步排版后保持、旧像素位置兼容、用户输入取消恢复、销毁清理');
} finally { page?.close(); server.kill(); }
