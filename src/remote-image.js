/**
 * Whether an image URL would leave the app bundle and hit the network.
 *
 * WebView2 (Windows) serves bundled assets from http://tauri.localhost/..., while
 * WKWebView / WebKitGTK use asset://localhost/.... Both are local: the "don't fetch
 * remote images by default" switch must not hide the app's own icons on Windows.
 */
const REMOTE_IMAGE = /^(https?:)?\/\//i;
const LOCAL_ORIGIN = /^(https?:)?\/\/(?:tauri|asset)\.localhost(?:\/|$)/i;

export function isRemoteImage(url) {
  if (typeof url !== 'string') return false;
  const value = url.trim();
  return REMOTE_IMAGE.test(value) && !LOCAL_ORIGIN.test(value);
}
