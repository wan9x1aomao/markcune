// Isolated renderer regression: real application/editor, a fake native bridge and no user files.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { open, sleep } from './cdp.mjs';

const port = Number(process.env.LAYOUT_TEST_PORT || 5252);
const root = fileURLToPath(new URL('..', import.meta.url));
const output = process.env.LAYOUT_TEST_OUTPUT;
if (output) mkdirSync(output, { recursive: true });
const server = spawn('npx', ['vite', '--port', String(port), '--host', '127.0.0.1', '--strictPort'], { cwd: root, stdio: 'ignore' });
const note = '# 把阅读，变成自己的知识\n\n> 阅读收藏与写作 · MarkCune 演示文稿\n\n## 从一条好文章开始\n\n在 X 读到值得留下的长文，复制分享链接，用「从链接打开」存成 Markdown。正文和配图回到本地。\n\n## 给想法留一点空间\n\n'+Array.from({length:36},(_,i)=>`第 ${i+1} 段：好的笔记，不必一次写完。先记下一个问题、一句想法，再慢慢把它们连成自己的文章。`).join('\n\n');
const runId = String(Date.now()) + '-' + Math.random();
const boot = `
window.__pageToken=Math.random();window.__errors=[];addEventListener('error',e=>__errors.push(e.message));addEventListener('unhandledrejection',e=>__errors.push(String(e.reason)));
if(localStorage.getItem('layout-run-id')!==${JSON.stringify(runId)}){localStorage.removeItem('layout-test-settings');localStorage.setItem('layout-run-id',${JSON.stringify(runId)});}
window.__stub={settings:JSON.parse(localStorage.getItem('layout-test-settings')||'{"sidebar":true,"outline":true}'),calls:[]};
window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},transformCallback(callback){const id=Math.floor(Math.random()*1e9);window['_'+id]=callback;return id;},unregisterCallback(){},async invoke(cmd,args){
__stub.calls.push([cmd,args]);
if(cmd==='window_init')return{platform:new URL(location.href).searchParams.get('platform')||'macos',settings:__stub.settings,recentFiles:[],recentFolders:[],pinnedFiles:Array.from({length:8},(_,i)=>({path:'/demo/note-'+i+'.md',name:'常用笔记 '+(i+1)+'.md',dir:'/demo',exists:true})),startup:{kind:'draft',id:'layout-test',content:${JSON.stringify(note)}}};
if(cmd==='set_setting'){__stub.settings[args.key]=args.value;localStorage.setItem('layout-test-settings',JSON.stringify(__stub.settings));return null;}
if(cmd==='ai_status')return{hasKey:false,completion:false};
if(cmd==='voice_status')return{hasKey:false,ready:false};
if(cmd==='list_pinned'||cmd==='list_dir')return[];
if(cmd==='update_status')return{currentVersion:'4.0.6'};
if(cmd==='check_update')return{kind:'current',version:'4.0.6'};
if(cmd==='draft_write')return'layout-test';
if(cmd==='plugin:event|listen')return 1;
if(cmd==='plugin:app|version')return'4.0.6';
if(cmd.includes('is_fullscreen')||cmd.includes('is_maximized'))return false;
return null;}};`;
let page;
const checks=[];
async function click(selector) { const point=await page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`);assert.ok(point,selector);await page.clickAt(point.x,point.y);await sleep(100); }
async function preset(id) { await click('#open-layout');await click(`[data-layout="${id}"]`);await sleep(160); }
async function state() { return page.evaluate(`(()=>{const box=id=>{const e=document.getElementById(id),r=e.getBoundingClientRect();return{hidden:e.hidden,x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};return{sidebar:box('sidebar'),outline:box('outline'),content:box('content'),width:innerWidth,height:innerHeight,compact:document.body.classList.contains('panels-compact'),prefs:__stub.settings.panelLayout,errors:__errors,theme:document.documentElement.dataset.theme};})()`); }
function record(name,value){checks.push({name,...value});assert.deepEqual(value.errors||[],[],name);}
try {
  let ready=false;
  for(let i=0;i<80;i++){try{ready=(await fetch(`http://127.0.0.1:${port}/`)).ok;}catch{}if(ready)break;await sleep(200);}
  assert.ok(ready,'layout test server');
  page=await open(null,{width:1280,height:860,scale:1});
  await page.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});
  await page.send('Page.addScriptToEvaluateOnNewDocument',{source:boot});
  await page.goto(`http://127.0.0.1:${port}/`);
  if(!await page.waitFor('!!window.__mdpadDebug?.editor'))throw new Error(JSON.stringify(await page.evaluate('({errors:__errors,calls:__stub.calls.slice(-10)})')));
  const original=await page.evaluate('__mdpadDebug.editor.getMarkdown()');
  for(const width of [1280,1024,800,640]){
    await page.send('Emulation.setDeviceMetricsOverride',{width,height:860,deviceScaleFactor:1,mobile:false});
    for(const id of ['split','reverse','left','right']){
      await preset(id);
      const result=await state();
      assert.equal(result.prefs.preset,id);
      assert.ok(result.content.width>=420);
      for(const box of [result.sidebar,result.outline])if(!box.hidden)assert.ok(box.x>=0&&box.right<=width+1&&box.bottom<=860);
      if(!result.compact){
        if(id==='split')assert.ok(result.sidebar.x<result.content.x&&result.outline.x>=result.content.right-1);
        if(id==='reverse')assert.ok(result.outline.x<result.content.x&&result.sidebar.x>=result.content.right-1,JSON.stringify(result));
        if(id==='left'||id==='right')assert.ok(result.sidebar.bottom<=result.outline.y+1);
      }
      assert.equal(await page.evaluate('__mdpadDebug.editor.getMarkdown()'),original);
      record(`${id}-${width}`,result);
      if(output&&width===1280)await page.shot(`${output}/${id}-light.png`);
    }
  }
  await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:860,deviceScaleFactor:1,mobile:false});
  await preset('left');await click('#open-layout');await click('[data-arrangement="tabs"]');
  assert.equal((await state()).outline.hidden,true);
  await click('#dock-tab-outline');assert.equal((await state()).sidebar.hidden,true);assert.equal((await state()).outline.hidden,false);
  await click('#open-layout');await click('[data-arrangement="stack"]');await click('.layout-order button');
  let result=await state();assert.ok(result.outline.y<result.sidebar.y);record('stack-swap',result);
  await page.key('Escape');
  const beforeWidth=result.prefs.sharedWidth;
  const point=await page.evaluate(`(()=>{const e=document.querySelector('.panel-resizer.vertical:not([hidden])'),r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await page.send('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});
  await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+40,y:point.y,button:'left',buttons:1});
  await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x+40,y:point.y,button:'left',clickCount:1});
  await sleep(100);assert.ok((await state()).prefs.sharedWidth>beforeWidth);
  const divider=await page.evaluate(`(()=>{const r=document.querySelector('.panel-resizer.horizontal').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await page.send('Input.dispatchMouseEvent',{type:'mousePressed',x:divider.x,y:divider.y,button:'left',clickCount:1});
  await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:divider.x,y:700,button:'left',buttons:1});
  await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:divider.x,y:700,button:'left',clickCount:1});await sleep(100);
  const pinnedBounds=await page.evaluate(`(()=>{const p=document.getElementById('sidebar').getBoundingClientRect(),pins=document.querySelector('.sidebar-pinned').getBoundingClientRect(),body=document.getElementById('sidebar-body').getBoundingClientRect();return{height:p.height,pinned:pins.height,bodyBottom:body.bottom,bottom:p.bottom};})()`);
  assert.ok(pinnedBounds.pinned<=pinnedBounds.height*.46&&pinnedBounds.bodyBottom<=pinnedBounds.bottom+1);record('stacked-pinned-files',pinnedBounds);
  const shared=(await state()).prefs.sharedWidth;
  await click('#open-layout');await click('[data-visible="sidebar"]');
  assert.equal((await state()).sidebar.hidden,true);assert.equal((await state()).outline.width,shared);
  await click('[data-visible="sidebar"]');await page.key('Escape');
  await page.evaluate(`(()=>{const p=document.getElementById('rich-pane');p.scrollTop=900;})()`);await sleep(200);
  const position=await page.evaluate('__mdpadDebug.editor.getPosition()');await preset('reverse');await sleep(250);
  const restored=await page.evaluate('__mdpadDebug.editor.getPosition()');
  assert.equal(restored.anchor,position.anchor);assert.equal(restored.top.pos,position.top.pos);
  assert.ok(Math.abs(restored.top.offset-position.top.offset)<2);record('reading-position',{position,restored});
  await click('[data-mode="source"]');await sleep(180);const sourceEditor=await page.evaluate('__mdpadDebug.editor.kind');await preset('right');
  assert.equal(await page.evaluate('__mdpadDebug.editor.kind'),sourceEditor);assert.equal(await page.evaluate('__mdpadDebug.editor.getMarkdown()'),original);
  await click('[data-mode="split"]');await sleep(200);await preset('left');assert.equal(await page.evaluate('__mdpadDebug.split'),true);assert.equal(await page.evaluate('document.getElementById("rich-pane").hidden'),false);
  await click('[data-mode="rich"]');await sleep(180);
  await page.evaluate(`document.documentElement.dataset.theme='dark'`);
  if(output)await page.shot(`${output}/right-dark.png`);
  await page.send('Emulation.setDeviceMetricsOverride',{width:640,height:800,deviceScaleFactor:1,mobile:false});await preset('split');
  result=await state();assert.equal(result.compact,true);await click('#toggle-outline');assert.equal((await state()).outline.hidden,false);await click('.panel-drawer-scrim');assert.equal((await state()).outline.hidden,true);
  await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:860,deviceScaleFactor:1,mobile:false});await preset('left');await click('#open-layout');await click('[data-arrangement="tabs"]');await page.key('Escape');await click('#dock-tab-outline');
  const saved=(await state()).prefs;
  const oldToken=await page.evaluate('window.__pageToken');
  await page.goto(`http://127.0.0.1:${port}/?platform=windows`);assert.ok(await page.waitFor(`window.__pageToken!==${JSON.stringify(oldToken)} && !!window.__mdpadDebug?.editor`));
  result=await state();assert.deepEqual(result.prefs,saved);assert.equal(result.outline.hidden,false);assert.equal(result.sidebar.hidden,true);record('windows-and-reload',result);
  await click('#open-layout');
  const menu=await page.evaluate(`(()=>{const r=document.querySelector('.panel-layout-menu').getBoundingClientRect();return{x:r.x,right:r.right,y:r.y,bottom:r.bottom};})()`);
  assert.ok(menu.x>=0&&menu.right<=1280&&menu.y>=0&&menu.bottom<=860);
  record('layout-menu',await state());
  if(output){await page.shot(`${output}/layout-menu.png`);writeFileSync(`${output}/browser-checks.json`,JSON.stringify(checks,null,2)+'\n');}
  await page.key('Escape');await click('#open-more');await click('.popup-menu .item:last-child');
  assert.equal(await page.evaluate('document.querySelectorAll(".settings-layout .layout-preset").length'),4);
  await click('.settings-layout [data-layout="reverse"]');assert.equal((await state()).prefs.preset,'reverse');
  await page.key('Escape');record('shared-settings-entry',await state());
  console.log(`panel layout browser ok（${checks.length} 项真实编辑器检查）`);
}finally{page?.close();server.kill();}
