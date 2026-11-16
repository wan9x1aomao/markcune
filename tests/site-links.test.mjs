import assert from 'node:assert/strict';
import { siteLinks } from '../src/site-links.js';

assert.deepEqual(siteLinks(), { homepage: 'https://github.com/wan9x1aomao/markcune', changelog: 'https://github.com/wan9x1aomao/markcune/releases' });
assert.deepEqual(siteLinks('\r\n'), siteLinks(), 'Windows 空配置的行尾应当按未设置处理');
assert.deepEqual(siteLinks('https://writer.example.org/'), { homepage: 'https://writer.example.org', changelog: 'https://writer.example.org/guide.html#changelog' });
assert.deepEqual(siteLinks('https://wsmknows.top/markcune/'), { homepage: 'https://wsmknows.top/markcune/', changelog: 'https://wsmknows.top/markcune/guide.html#changelog' });
for (const value of ['http://writer.example.org', 'https://mdpad.app.workbuddy.host', 'https://writer.example.org/path', 'https://token@writer.example.org']) assert.throws(() => siteLinks(value));
console.log('site links ok');
