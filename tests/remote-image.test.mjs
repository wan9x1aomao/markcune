import assert from 'node:assert/strict';
import { isRemoteImage } from '../src/remote-image.js';

// Windows WebView2 serves bundled assets over http://tauri.localhost; WebKit uses
// asset://localhost. Treating either as remote made the 4.0.4 Windows smoke test fail:
// the sample document's icon never loaded, so "loaded=true" was false.
for (const local of [
  'http://tauri.localhost/assets/icon.png',
  'https://tauri.localhost/assets/icon.png',
  'http://asset.localhost/assets/icon.png',
  'asset://localhost/%2Ftmp%2Fassets%2Ficon.png',
  'assets/icon.png',
  './assets/icon.png',
  'data:image/png;base64,AAAA',
  'C:\\docs\\image.png',
  '',
]) {
  assert.equal(isRemoteImage(local), false, `local asset read as remote: ${String(local)}`);
}

for (const remote of [
  'https://example.com/a.png',
  'http://example.com/a.png',
  '//cdn.example.com/a.png',
  'HTTPS://EXAMPLE.COM/A.PNG',
  // A lookalike host must still count as remote.
  'http://tauri.localhost.evil.com/a.png',
]) {
  assert.equal(isRemoteImage(remote), true, `remote image read as local: ${remote}`);
}

for (const other of [null, undefined, 42, {}]) {
  assert.equal(isRemoteImage(other), false);
}

console.log('remote image ok');
