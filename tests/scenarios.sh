#!/bin/bash
# File-handling scenarios against a debug build (macOS). Build first:
#   npx tauri build --debug --no-bundle
set -uo pipefail
cd "$(dirname "$0")/.."
BIN="$PWD/src-tauri/target.noindex/debug/mdpad"
FAILED=0

# run <data-dir> <js> [file] — runs the app until the JS reports, prints the result line.
run() {
  local data="$1" js="$2" file="${3:-}"
  # MDPAD_LIBRARY_DIR 指向临时目录，否则「从链接打开」会往用户真实的 ~/Documents/MDPad 里写书
  MDPAD_DATA_DIR="$data" MDPAD_LIBRARY_DIR="$WORK/library" MDPAD_TEST_JS="$js" "$BIN" ${file:+"$file"} 2>&1 \
    | grep -m1 'TEST_RESULT' | sed 's/^TEST_RESULT: //'
}

check() {
  local name="$1" result="$2" expected="$3"
  if [[ "$result" == *"$expected"* ]]; then
    echo "PASS  $name"
  else
    echo "FAIL  $name"
    echo "      expected: $expected"
    echo "      got:      $result"
    FAILED=1
  fi
}

fresh() {
  WORK=$(mktemp -d)
  mkdir -p "$WORK/.data"
  cp -R tests/smoke/sample.md tests/smoke/assets "$WORK/"
}

WAIT='const wait = (ms) => new Promise((r) => setTimeout(r, ms));'
TYPE='const typeAtEnd = (text) => { const p = document.querySelector(".ProseMirror p"); document.querySelector(".ProseMirror").focus(); const r = document.createRange(); r.selectNodeContents(p); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); document.execCommand("insertText", false, text); };'
STATE='const state = () => ({ text: document.querySelector(".ProseMirror")?.innerText ?? "", status: document.getElementById("save-status").textContent, banner: document.getElementById("banner").hidden ? "" : document.querySelector("#banner .message").textContent, toast: document.getElementById("toast").hidden ? "" : document.getElementById("toast").textContent });'

# 1. External change while there are no unsaved edits: reload automatically.
fresh
( for _ in $(seq 1 150); do grep -q testReady "$WORK/.data/state.json" 2>/dev/null && break; sleep 0.1; done
  printf '\n外部程序追加的段落\n' >> "$WORK/sample.md" ) &
result=$(run "$WORK/.data" "$WAIT $STATE await window.__TAURI_INTERNALS__.invoke('set_setting', { key: 'testReady', value: true }); for (let i = 0; i < 50 && !state().text.includes('外部程序追加的段落'); i++) await wait(100); return JSON.stringify(state());" "$WORK/sample.md")
check "外部修改且本地无改动 → 自动载入" "$result" "外部程序追加的段落"
check "外部修改 → 提示已载入" "$result" "已载入最新内容"

# 2. External change while typing: keep both, ask. The page signals (via a setting written to
# state.json) once it has unsaved edits; only then does the outside program write.
fresh
( for _ in $(seq 1 150); do grep -q testTyping "$WORK/.data/state.json" 2>/dev/null && break; sleep 0.1; done
  printf '\n外部冲突内容\n' >> "$WORK/sample.md" ) &
result=$(run "$WORK/.data" "$WAIT $TYPE $STATE typeAtEnd('本地未保存'); await window.__TAURI_INTERNALS__.invoke('set_setting', { key: 'testTyping', value: true }); for (let i = 0; i < 12; i++) { await wait(300); document.execCommand('insertText', false, '。'); } await wait(1500); return JSON.stringify(state());" "$WORK/sample.md")
check "编辑中外部修改 → 显示冲突提醒" "$result" "这个文件已被其他程序修改"
check "冲突时不覆盖磁盘文件" "$(grep -c '本地未保存' "$WORK/sample.md")/$(grep -c '外部冲突内容' "$WORK/sample.md")" "0/1"

# 3. Untitled draft survives a restart.
fresh
run "$WORK/.data" "$WAIT document.querySelector('.ProseMirror').focus(); document.execCommand('insertText', false, '草稿内容一二三'); await wait(2000); return document.getElementById('save-status').textContent;" >/dev/null
result=$(run "$WORK/.data" "$WAIT $STATE await wait(500); return JSON.stringify(state());")
check "草稿重启后恢复" "$result" "草稿内容一二三"
check "草稿状态显示" "$result" "草稿已自动保存"

# 4. Reading position is restored.
fresh
for i in $(seq 1 60); do printf '\n第 %d 段正文内容。\n' "$i" >> "$WORK/sample.md"; done
run "$WORK/.data" "$WAIT const pane = document.getElementById('rich-pane'); pane.scrollTop = 900; pane.dispatchEvent(new Event('scroll')); await wait(1500); return pane.scrollTop;" "$WORK/sample.md" >/dev/null
result=$(run "$WORK/.data" "$WAIT await wait(500); return 'scrollTop=' + document.getElementById('rich-pane').scrollTop;" "$WORK/sample.md")
check "重新打开回到上次位置" "$result" "scrollTop=900"

# 5. Source mode shows the file exactly as stored.
fresh
result=$(run "$WORK/.data" "$WAIT window.__TAURI_INTERNALS__.invoke('plugin:event|emit_to', { target: { kind: 'AnyLabel', label: 'doc-0' }, event: 'menu', payload: 'toggle-source' }); await wait(800); const text = document.querySelector('.cm-content').innerText; return text.includes('| --- | --- |') && text.includes('![图标](assets/icon.png)') ? 'raw-ok' : text.slice(0, 300);" "$WORK/sample.md")
check "源码模式显示原始文本" "$result" "raw-ok"

# 6. Pasting a URL onto selected text makes a link.
fresh
result=$(run "$WORK/.data" "$WAIT const strong = document.querySelector('.ProseMirror strong'); document.querySelector('.ProseMirror').focus(); const r = document.createRange(); r.selectNodeContents(strong); getSelection().removeAllRanges(); getSelection().addRange(r); await wait(100); const data = new DataTransfer(); data.setData('text/plain', 'https://example.org/'); strong.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); await wait(1800); return document.querySelector('.ProseMirror a[href=\"https://example.org/\"]')?.textContent ?? 'no link';" "$WORK/sample.md")
check "粘贴网址生成链接" "$result" "粗体"
grep -q '\[\*\*粗体\*\*\](https://example.org/)\|\*\*\[粗体\](https://example.org/)\*\*' "$WORK/sample.md" && check "链接已写入文件" "ok" "ok" || check "链接已写入文件" "$(grep -o '.\{0,10\}example.org.\{0,5\}' "$WORK/sample.md")" "粗体](https://example.org/)"

# 7. Clicking an image shows its actions.
fresh
result=$(run "$WORK/.data" "$WAIT const img = document.querySelector('.ProseMirror img'); img.scrollIntoView(); await wait(200); const box = img.getBoundingClientRect(); const at = { bubbles: true, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, button: 0 }; img.dispatchEvent(new MouseEvent('mousedown', at)); img.dispatchEvent(new MouseEvent('mouseup', at)); img.dispatchEvent(new MouseEvent('click', at)); await wait(400); const bar = document.querySelector('.image-actions'); return bar && !bar.hidden ? bar.innerText.replace(/\\n/g, ' ') : 'hidden';" "$WORK/sample.md")
check "点击图片出现操作条" "$result" "替换"

DRIVE='const view = window.__mdpadDebug.editor.view; view.focus(); const type = (text) => { for (const ch of text) { const { from, to } = view.state.selection; if (!view.someProp("handleTextInput", (f) => f(view, from, to, ch))) view.dispatch(view.state.tr.insertText(ch, from, to)); } }; const key = (k, mod = false) => view.someProp("handleKeyDown", (f) => f(view, new KeyboardEvent("keydown", { key: k, metaKey: mod, ctrlKey: mod })));'

# 8. Lists: "- " starts a list, Enter continues it, Enter on an empty item leaves it.
fresh
result=$(run "$WORK/.data" "$WAIT $DRIVE type('- '); type('第一项'); key('Enter'); type('第二项'); key('Enter'); key('Enter'); type('列表之后'); await wait(200); return JSON.stringify(window.__mdpadDebug.editor.getMarkdown());")
check "输入 - 创建列表，两次回车退出" "$result" '- 第一项\n- 第二项\n\n列表之后'

# 9. Undo restores a deleted paragraph and a table edit.
fresh
result=$(run "$WORK/.data" "$WAIT $DRIVE const before = window.__mdpadDebug.editor.getMarkdown(); let para; view.state.doc.forEach((node, offset) => { if (!para && node.type.name === 'paragraph') para = { from: offset, to: offset + node.nodeSize }; }); view.dispatch(view.state.tr.delete(para.from, para.to)); const deleted = !window.__mdpadDebug.editor.getMarkdown().includes('粗体'); window.__mdpadDebug.editor.command('undo'); const restored = window.__mdpadDebug.editor.getMarkdown() === before; let cell; view.state.doc.descendants((node, pos) => { if (!cell && node.type.name === 'table_cell') cell = pos; }); view.dispatch(view.state.tr.insertText('改', cell + 2)); const edited = window.__mdpadDebug.editor.getMarkdown() !== before; window.__mdpadDebug.editor.command('undo'); const tableRestored = window.__mdpadDebug.editor.getMarkdown() === before; return JSON.stringify({ deleted, restored, edited, tableRestored });" "$WORK/sample.md")
check "撤销恢复删除的段落和表格修改" "$result" '"deleted":true,"restored":true,"edited":true,"tableRestored":true'

# 10. Dropping a document or folder from Finder opens it (simulated drop, same native path).
fresh
mkdir -p "$WORK/拖入的文件夹" && printf '# 拖进来的文档\n' > "$WORK/拖入的文件夹/拖入.md"
result=$(MDPAD_DATA_DIR="$WORK/.data" MDPAD_TEST_DROP="$WORK/拖入的文件夹/拖入.md" MDPAD_TEST_JS="$WAIT await wait(1500); return document.getElementById('doc-name').textContent;" "$BIN" "$WORK/sample.md" 2>&1 | grep -m1 TEST_RESULT)
check "拖入文档后打开" "$result" "拖入.md"
result=$(MDPAD_DATA_DIR="$WORK/.data" MDPAD_TEST_DROP="$WORK/拖入的文件夹" MDPAD_TEST_JS="$WAIT await wait(1500); return document.querySelector('#sidebar .panel-header .title').textContent;" "$BIN" "$WORK/sample.md" 2>&1 | grep -m1 TEST_RESULT)
check "拖入文件夹后打开" "$result" "拖入的文件夹"

# 11. Only real images referenced by the document are readable through the asset protocol.
fresh
printf 'KEY' > "$WORK/id_rsa"
ln -s "$WORK/id_rsa" "$WORK/leak.png"
printf '# 恶意文档\n\n![ok](assets/icon.png)\n\n![passwd](../../../../../../../etc/passwd)\n\n![leak](leak.png)\n' > "$WORK/evil.md"
result=$(run "$WORK/.data" "$WAIT await wait(1500); const imgs = [...document.querySelectorAll('.ProseMirror img')]; await Promise.all(imgs.map((i) => i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; }))); const loaded = imgs.map((i) => i.naturalWidth > 0); const probe = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r('loaded'); i.onerror = () => r('blocked'); i.src = src; }); const direct = await probe(window.__TAURI_INTERNALS__.convertFileSrc('$WORK/id_rsa')); return JSON.stringify({ loaded, direct });" "$WORK/evil.md")
check "只有真正的图片能显示（系统文件、伪装链接被拒）" "$result" '"loaded":[true,false,false]'
check "直接请求私密文件被拒绝" "$result" '"direct":"blocked"'
result=$(run "$WORK/.data" "$WAIT const call = window.__TAURI_INTERNALS__.invoke; const ok = await call('image_data_url', { path: '$WORK/assets/icon.png' }).then((d) => d.slice(0, 22), String); const leak = await call('image_data_url', { path: '$WORK/leak.png' }).then(() => 'leaked', String); return JSON.stringify({ ok, leak });" "$WORK/sample.md")
check "导出网页可嵌入本地图片" "$result" '"ok":"data:image/png;base64,"'
check "导出不会嵌入伪装成图片的文件" "$result" '"leak":"不是图片文件"'

# 12. 「从链接打开」的完整用户路径：菜单 → 弹窗 → 下载 → 落盘 → 打开（要联网）
#     第 3 段冒烟测试直接调 open_from_url，绕过了菜单到弹窗这一段；这里把整条路走一遍。
fresh
MENU="window.__TAURI_INTERNALS__.invoke('plugin:event|emit_to', { target: { kind: 'AnyLabel', label: 'doc-0' }, event: 'menu', payload: 'open-from-url' });"
result=$(run "$WORK/.data" "$WAIT $MENU for (let i = 0; i < 60 && !document.querySelector('.overlay .prompt'); i++) await wait(100); const box = document.querySelector('.overlay .prompt'); if (!box) return 'menus did not open a dialog'; box.querySelector('input').value = 'https://github.com/ruanyf/es6tutorial'; box.querySelector('.ok').click(); for (let i = 0; i < 900 && !document.getElementById('toast').textContent.includes('已下载'); i++) await wait(100); await wait(300); return JSON.stringify({ promptTitle: box.querySelector('.title').textContent, okLabel: box.querySelector('.ok').textContent, toast: document.getElementById('toast').textContent, docName: document.getElementById('doc-name').textContent, heading: document.querySelector('.ProseMirror h1')?.innerText ?? '', root: document.querySelector('#sidebar .panel-header .title')?.textContent ?? '' });" "$WORK/sample.md")
check "菜单打开的是粘贴链接的弹窗" "$result" "粘贴链接：GitHub 上的书"
check "按钮说的是要发生的事" "$result" '"okLabel":"下载并打开"'
check "下完给了一句回执" "$result" "已下载《es6tutorial》"
check "打开的是书的第一章" "$result" '"docName":"README.md"'
check "正文确实渲染出了书的内容" "$result" "ES6 入门教程"
check "侧栏指向的是书的文件夹" "$result" '"root":"es6tutorial"'
# 图片跟着 zip 一起下来了（这是选整仓下载而不是抓单文件的意义）
check "书里的图片也落了盘" "$(ls "$WORK/library/es6tutorial/images" 2>/dev/null | wc -l | tr -d ' ')" "9"
check "书里的章节文件都在" "$(ls "$WORK/library/es6tutorial/docs" 2>/dev/null | wc -l | tr -d ' ')" "37"

exit $FAILED
