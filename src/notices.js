// The sentences the app shows after finishing something. Pure functions, so the exact wording —
// including when a sentence must *not* appear — can be checked without opening a window.

// What to say once a link has been downloaded.
export function downloadNotice({ kind, title, files, skipped, replaced }) {
  // 帖子：图片是逐张下载的。失败时正文会暂时留着原来的地址，编辑器默认不请求网络图片，
  // 看起来就像图丢了。张数和「可以再试一次」必须写在这句话里。
  if (kind === 'tweet') {
    if (!skipped) return `已下载《${title}》`;
    return `已下载《${title}》，有 ${skipped} 张图片没能下载。再下载一次这个链接即可重试`;
  }
  if (kind !== 'book') return `已下载 ${title}`;
  // A book may carry names this system cannot hold (Windows refuses `?`, `:` and friends); those
  // files are left out on purpose. Saying so beats quietly handing over a book with chapters missing.
  const leftOut = skipped ? `，另有 ${skipped} 个文件因本系统无法保存而跳过` : '';
  // Downloading the same book again refreshes the folder in place and overwrites same-named files.
  // That is the intended behaviour, but it must never be silent: local edits could be replaced.
  const refreshed = replaced ? '，同名书已在书库里，这次是覆盖更新' : '';
  return `已下载《${title}》，共 ${files} 个文件${leftOut}${refreshed}`;
}
