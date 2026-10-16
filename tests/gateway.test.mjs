// 整理网关的契约测试：不连外网，用一个模型桩替换上游，验证 docs/tidy-gateway.md 的约定。
// 关键是最后那条——网关给出的标签必须能通过应用自己的校验，否则应用会把整段退回规则整理。
import assert from 'node:assert/strict';
import http from 'node:http';
import { configFromEnv, createGateway, fit, parseLabels } from '../gateway/tidy-gateway.mjs';
import { applyLabels, ruleLabels, sameWords, splitLines, validateLabels } from '../src/tidy.js';

const LINES = ['项目周报', '', '一、本周进展', '完成了登录页面'];
const GOOD = ['h1', 'blank', 'h2', 'p'];

/** 模型桩：按调用顺序吐出预设的回答。 */
async function startUpstream(script) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      calls.push(JSON.parse(raw || '{}'));
      const step = script[Math.min(calls.length - 1, script.length - 1)];
      const content = typeof step.reply === 'string' ? step.reply : JSON.stringify(step.reply);
      const body = step.raw ?? JSON.stringify({ choices: [{ message: { content } }] });
      res.writeHead(step.status ?? 200, { 'content-type': 'application/json' });
      res.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, calls, close: () => new Promise((r) => server.close(r)) };
}

async function startGateway(config, options) {
  const server = createGateway({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test', model: 'test-model', maxTokens: 64, port: 0, token: '', jsonMode: true, timeoutMs: 5000, ...config }, options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

async function post(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: response.status, body: json };
}

const upstream = await startUpstream([
  { reply: { labels: ['h1', 'p', 'h2', 'p'] } }, // 空行被标成 p：网关应当纠正
  { reply: ['h1', 'blank', 'h2', 'p'] }, // 裸数组
  { reply: '```json\n{"labels":["h1","blank","h2","p"]}\n```' }, // 带围栏
  { reply: { labels: ['h1', 'blank'] } }, // 行数不对，第一次
  { reply: { labels: ['h1', 'blank'] } }, // 行数不对，第二次
  { status: 500, raw: '{"error":"模型炸了"}' }, // 上游故障
]);
const gateway = await startGateway({ baseUrl: upstream.url });
const url = `${gateway.base}/tidy`;

// 1. 正常一次：空行被纠正为 blank，标签原样返回
{
  const { status, body } = await post(url, { lines: LINES });
  assert.equal(status, 200);
  assert.deepEqual(body.labels, GOOD);
  assert.equal(body.engine, 'model');
  assert.equal(body.lines, LINES.length);
  console.log('ok  正常一次：空行被纠正，标签对上原文');
}

// 2. 模型返回裸数组 / 带围栏的代码块，都能解析
for (const label of ['裸数组', '带围栏代码块']) {
  const { status, body } = await post(url, { lines: LINES });
  assert.equal(status, 200, label);
  assert.deepEqual(body.labels, GOOD, label);
}
console.log('ok  模型输出的三种写法都能解析');

// 3. 行数对不上：重试一次仍不对，如实报错（应用据此退回规则整理）
{
  const before = upstream.calls.length;
  const { status, body } = await post(url, { lines: LINES });
  assert.equal(status, 502);
  assert.match(body.error.message, /对不上/);
  assert.equal(upstream.calls.length - before, 2, '应当重试一次');
  console.log('ok  行数对不上：重试一次后如实报错');
}

// 4. 上游故障：不重试，直接报错
{
  const before = upstream.calls.length;
  const { status, body } = await post(url, { lines: LINES });
  assert.equal(status, 502);
  assert.match(body.error.message, /500/);
  assert.equal(upstream.calls.length - before, 1, '上游报错不该重试');
  console.log('ok  上游故障：不重试，原因带回给应用');
}

// 5. 请求本身的问题
{
  const empty = await post(url, { lines: [] });
  assert.equal(empty.status, 413);
  const long = await post(url, { lines: Array.from({ length: 401 }, (_, i) => `第 ${i} 行`) });
  assert.equal(long.status, 413);
  const notJson = await post(url, '{ 这不是 JSON');
  assert.equal(notJson.status, 400);
  const noLines = await post(url, { text: '你好' });
  assert.equal(noLines.status, 400);
  const wrongMethod = await fetch(url);
  assert.equal(wrongMethod.status, 405);
  console.log('ok  空/超长/坏 JSON/缺 lines/错方法：都被挡住');
}

// 6. 没有模型 Key：明确说清楚，而不是假装成功
{
  const bare = await startGateway({ baseUrl: upstream.url, apiKey: '' });
  const { status, body } = await post(`${bare.base}/tidy`, { lines: LINES });
  assert.equal(status, 503);
  assert.match(body.error.message, /TIDY_API_KEY/);
  const health = await fetch(`${bare.base}/health`);
  assert.equal((await health.json()).ready, false);
  await bare.close();
  console.log('ok  没配 Key：503 说清原因，/health 显示未就绪');
}

// 7. 访问令牌
{
  const own = await startUpstream([{ reply: { labels: GOOD } }]);
  const guarded = await startGateway({ baseUrl: own.url, token: 's3cret' });
  const denied = await post(`${guarded.base}/tidy`, { lines: LINES });
  assert.equal(denied.status, 401);
  const allowed = await post(`${guarded.base}/tidy`, { lines: LINES }, { authorization: 'Bearer s3cret' });
  assert.equal(allowed.status, 200);
  assert.deepEqual(allowed.body.labels, GOOD);
  await guarded.close();
  await own.close();
  console.log('ok  访问令牌：不带 401，带上通');
}

// 8. 上游只认 OpenAI 的老写法：response_format 被拒后要能退一步重试
{
  const picky = await startUpstream([{ status: 400, raw: '{"error":{"message":"response_format is not supported"}}' }, { reply: { labels: GOOD } }]);
  const via = await startGateway({ baseUrl: picky.url });
  const { status, body } = await post(`${via.base}/tidy`, { lines: LINES });
  assert.equal(status, 200);
  assert.deepEqual(body.labels, GOOD);
  assert.equal(picky.calls.length, 2, '应当去掉 response_format 再试一次');
  assert.equal('response_format' in picky.calls[1], false);
  await via.close();
  await picky.close();
  console.log('ok  上游不支持 response_format：自动去掉再试');
}

// 9. 网关给出的标签，必须能通过应用自己的校验 —— 否则整段会被退回规则整理
{
  const cases = [
    ['项目周报', '', '一、本周进展', '完成了登录页面'],
    ['把这段话排一下', '第一点内容比较长需要换行所以这里继续写下去', '第二点'],
    ['1.1 说明', '这是正文内容。', '2.3.4 接口约定', '请求方式为 POST。'],
    ['   ', '', '只有一行有字'],
  ];
  for (const lines of cases) {
    const labels = fit(ruleLabels(lines), lines);
    assert.ok(labels, `规则标签自己必须是合法的：${JSON.stringify(lines)}`);
    const markdown = applyLabels(lines, labels);
    assert.ok(sameWords(lines.join('\n'), markdown), `文字必须守恒：${JSON.stringify(lines)}`);
  }
  console.log('ok  规则标签与整理结果都过应用的安全闸门');
}

// 10. 纯函数与默认配置
{
  assert.deepEqual(parseLabels('  ["h1"]  '), ['h1']);
  assert.deepEqual(parseLabels('前缀 {"labels":["H2"," p "]} 后缀'), ['h2', 'p']);
  assert.equal(parseLabels('没有 JSON'), null);
  assert.equal(fit(['h1', 'blank'], LINES), null, '数量不对必须退回');
  assert.equal(fit(['h1', 'p', 'h2', '不存在的标签'], LINES), null, '未知标签必须退回');
  assert.deepEqual(fit(['h1', 'p', 'h2', 'p'], LINES), GOOD);

  const env = configFromEnv({});
  assert.equal(env.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(env.model, 'deepseek-chat');
  assert.equal(env.port, 8787);
  assert.equal(env.jsonMode, true);
  assert.equal(configFromEnv({ TIDY_JSON_MODE: '0', TIDY_BASE_URL: 'http://x/v1/' }).jsonMode, false);
  assert.equal(configFromEnv({ TIDY_BASE_URL: 'http://x/v1/' }).baseUrl, 'http://x/v1');
  console.log('ok  纯函数与默认配置');
}

await gateway.close();
await upstream.close();
const modelCalls = upstream.calls.filter((call) => call.messages).length;
assert.ok(modelCalls >= 5, '上游应当被调用过多次');
assert.ok(upstream.calls.every((call) => call.messages?.[0]?.content.includes('行号')), '提示词要按约定带上行号说明');
console.log(`\ngateway ok（上游共收到 ${upstream.calls.length} 次调用）`);
