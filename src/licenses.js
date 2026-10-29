// 开源许可：把安装包里用到的第三方组件和它们的许可原文摊开给人看。
//
// 为什么值得一个独立面板：MIT / Apache-2.0 的条件是「随副本携带版权声明与许可原文」，
// 藏在仓库里的一个 md 文件不算随副本分发。清单由 scripts/gen-licenses.mjs 生成，
// 作为单独的异步 chunk 加载 —— 不点开这个面板就不会被读进内存。
//
// 面板结构和 help.js 一致：Esc、点遮罩、点 × 都能关。
export function openLicenses({ onClose } = {}) {
  document.querySelector('.overlay.licenses-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'overlay licenses-overlay';
  overlay.innerHTML = `
    <div class="licenses-panel" role="dialog" aria-label="开源许可">
      <header>
        <h2>开源许可</h2>
        <button class="licenses-close" type="button" aria-label="关闭">×</button>
      </header>
      <p class="licenses-lead">
        这份安装包里用到的第三方组件及其许可，随应用一起分发；同一份内容也在仓库的
        <code>THIRD-PARTY-NOTICES.md</code>。MarkCune 自身的代码以 MIT 许可发布。
      </p>
      <pre class="licenses-body" tabindex="0">读取中…</pre>
    </div>`;

  const body = overlay.querySelector('.licenses-body');

  const onKey = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close();
  });
  overlay.querySelector('.licenses-close').addEventListener('click', close);
  document.body.appendChild(overlay);

  import('./licenses-text.js')
    .then(({ default: text }) => {
      body.textContent = text;
    })
    .catch(() => {
      body.textContent = '许可清单读取失败。安装包内应包含此文件，可从仓库的 THIRD-PARTY-NOTICES.md 查看同一份内容。';
    });

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  }
  return close;
}
