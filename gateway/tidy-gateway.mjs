#!/usr/bin/env node
// 「一键整理」的网关。
//
// 应用只把原始行发过来，由这里决定用哪个模型、写什么提示词、失败了怎么兜底——
// 模型名、Key 和提示词全都留在这个服务里，应用端一个都不持有（见 docs/tidy-gateway.md）。
//
//   TIDY_API_KEY=sk-xxx node gateway/tidy-gateway.mjs
//
// 环境变量
//   TIDY_BASE_URL   上游地址，任何 OpenAI 兼容接口都行。默认 https://api.deepseek.com/v1
//   TIDY_API_KEY    上游 Key。没有它则拒绝整理（503），应用会退回规则整理
//   TIDY_MODEL      模型名。默认 deepseek-chat
//   TIDY_MAX_TOKENS 一次生成的上限。默认 4096
//   PORT            监听端口。默认 8787
//   TIDY_HOST       监听地址。默认 127.0.0.1（只有本机能连）。
//                   改成 0.0.0.0 之类的对外地址时，必须同时设 TIDY_TOKEN，否则拒绝启动。
//   TIDY_TOKEN      可选。设了之后要求请求带 Authorization: Bearer <token>
//   TIDY_JSON_MODE  默认 1，要求上游返回 JSON；个别上游不支持时设 0
//   TIDY_TIMEOUT_MS 调上游的超时。默认 45000（应用那边是 60 秒）

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { LABELS, validateLabels } from '../src/tidy.js';

// 和 docs/tidy-gateway.md、src-tauri/src/ai.rs 里的上限保持一致。
export const MAX_LINES = 400;
export const MAX_CHARS = 30_000;
const MAX_BODY = 1_000_000;

const PROMPT = [
  '你是文档排版助手。下面是一段没有排版的纯文本，每行前面是行号和制表符。',
  '请给每一行打一个标签，只输出 JSON，形如 {"labels":["h1","p"]}，数组长度必须等于行数。',
  `标签只能是：${LABELS.join('、')}。`,
  '空行必须标 blank，非空行不能标 blank。',
  'h1 是文档标题（全文只有一个），h2 是章节标题，h3 是小节标题，ul / ol 是列表项，',
  'quote 是引用，p 是正文段落，cont 是上一行被换行打断的后半句，keep 是本来就是 Markdown 的行。',
  '不要修改、翻译、总结文字，你只打标签。',
].join('');

/** Reads configuration from the environment. */
export function configFromEnv(env = process.env) {
  return {
    baseUrl: (env.TIDY_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    apiKey: env.TIDY_API_KEY || '',
    model: env.TIDY_MODEL || 'deepseek-chat',
    maxTokens: Number(env.TIDY_MAX_TOKENS || 4096),
    port: Number(env.PORT || 8787),
    // 只听回环：别人扫不到这个端口，也就不需要令牌。要对外必须先想清楚鉴权。
    host: env.TIDY_HOST || '127.0.0.1',
    token: env.TIDY_TOKEN || '',
    jsonMode: env.TIDY_JSON_MODE !== '0',
    timeoutMs: Number(env.TIDY_TIMEOUT_MS || 45_000),
  };
}

/** True for addresses that only accept connections from this machine. */
export function isLoopback(host) {
  const name = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  return name === 'localhost' || name === '::1' || /^127\./.test(name) || name === '::ffff:127.0.0.1';
}

/**
 * Refuses a configuration that would expose the gateway to the network without a token.
 * Being reachable by an unknown party is not the same as being usable by it: without a token
 * anyone on the same LAN can spend the upstream model budget, one request at a time.
 */
export function checkExposure(config) {
  if (config.host && !isLoopback(config.host) && !config.token) {
    throw new Error(
      `监听地址是 ${config.host}（对外可达），但没有设置 TIDY_TOKEN —— 同网段的任何人都能拿它刷模型的额度。\n` +
        '要么去掉 TIDY_HOST（只给本机用），要么设一个 TIDY_TOKEN 并让调用方带上 Authorization: Bearer <token>。',
    );
  }
  return config;
}

/** Pulls a label array out of whatever the model wrote: a JSON object, a bare array, or either inside prose. */
export function parseLabels(text) {
  const raw = String(text ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const attempts = [raw];
  const object = raw.match(/\{[\s\S]*\}/);
  const array = raw.match(/\[[\s\S]*\]/);
  if (object) attempts.push(object[0]);
  if (array) attempts.push(array[0]);
  for (const attempt of attempts) {
    try {
      const value = JSON.parse(attempt);
      const list = Array.isArray(value) ? value : value?.labels;
      if (Array.isArray(list)) return list.map((item) => String(item).toLowerCase().trim());
    } catch {
      // try the next shape
    }
  }
  return null;
}

/**
 * Makes a label list usable, or gives up. Blank lines are forced to `blank` and a `blank` on a line that has
 * text becomes `p`: both are facts about the line itself, so fixing them can never change a word.
 * Anything else that does not fit (wrong length, unknown label) is left for the caller to reject.
 */
export function fit(labels, lines) {
  if (!Array.isArray(labels) || labels.length !== lines.length) return null;
  const fixed = labels.map((label, i) => {
    if (lines[i].trim() === '') return 'blank';
    const clean = String(label).toLowerCase().trim();
    return clean === 'blank' ? 'p' : clean;
  });
  return validateLabels(fixed, lines);
}

/** One call to the upstream model. Throws with a user-facing message. */
async function callModel(lines, config, strict, fetchImpl) {
  const numbered = lines.map((line, i) => `${i + 1}\t${line}`).join('\n');
  const ask = `${strict ? '上一次的输出不可用，请重来一次。' : ''}共 ${lines.length} 行：\n\n${numbered}`;
  const payload = {
    model: config.model,
    temperature: 0,
    max_tokens: config.maxTokens,
    messages: [
      { role: 'system', content: PROMPT },
      { role: 'user', content: ask },
    ],
  };
  if (config.jsonMode) payload.response_format = { type: 'json_object' };

  const post = async (body) => {
    const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    const text = await response.text();
    return { response, text };
  };

  let { response, text } = await post(payload);
  // Some OpenAI-compatible services reject response_format; keep the plain shape as a second try.
  if (!response.ok && response.status === 400 && /response_format/i.test(text) && config.jsonMode) {
    delete payload.response_format;
    ({ response, text } = await post(payload));
  }
  if (!response.ok) throw new Error(`上游返回 ${response.status}：${text.slice(0, 200)}`);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('上游返回的不是 JSON');
  }
  const content = body?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`上游返回里没有内容：${text.slice(0, 200)}`);
  return parseLabels(content);
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

const fail = (message) => ({ error: { message } });

/** Whether an `Origin` header belongs to the host this request was addressed to. */
function sameHost(origin, host) {
  try {
    return new URL(origin).host === String(host ?? '');
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求太大'));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

/** Labels one request. Returns `{ status, body }` so the HTTP layer stays trivial. */
export async function labelRequest(lines, config, fetchImpl = fetch) {
  if (!config.apiKey) return { status: 503, body: fail('网关还没有配置模型 Key（TIDY_API_KEY）') };

  let lastError = '';
  for (const strict of [false, true]) {
    let parsed;
    try {
      parsed = await callModel(lines, config, strict, fetchImpl);
    } catch (error) {
      // 连不上或上游报错：再问一次也不会变好，直接把原因交给应用。
      return { status: 502, body: fail(`网关没能整理这段文字：${error.message}`) };
    }
    if (!parsed) {
      lastError = '上游给的不是标签数组';
      continue;
    }
    const labels = fit(parsed, lines);
    if (labels) return { status: 200, body: { labels, engine: 'model', model: config.model, lines: lines.length } };
    lastError = `标签对不上原文（给了 ${parsed.length} 个，需要 ${lines.length} 个）`;
  }
  return { status: 502, body: fail(`网关没能整理这段文字：${lastError}`) };
}

export function createGateway(config, { fetchImpl = fetch, log = () => {} } = {}) {
  return http.createServer(async (req, res) => {
    const started = Date.now();
    const path = new URL(req.url, 'http://localhost').pathname;

    if (req.method === 'GET' && path === '/health') {
      // 设了令牌就一并保护：/health 会说出模型名和上游地址，没必要给陌生人看。
      if (config.token && req.headers.authorization !== `Bearer ${config.token}`) {
        return send(res, 401, fail('没有带访问令牌'));
      }
      return send(res, 200, { ok: true, ready: Boolean(config.apiKey), model: config.model, baseUrl: config.baseUrl });
    }
    if (req.method !== 'POST') return send(res, 405, fail('只接受 POST'));
    if (config.token && req.headers.authorization !== `Bearer ${config.token}`) {
      return send(res, 401, fail('没有带访问令牌'));
    }
    // 别的网站也能往这个端口发「简单请求」（text/plain，不触发预检），所以按类型挡：
    // 只认 application/json，跨站想发就必须预检，而这里不回应预检。
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') {
      return send(res, 415, fail('只接受 Content-Type: application/json'));
    }
    // 兜底：如果浏览器还是带上了 Origin，就和本次请求的 Host 对一下。
    if (req.headers.origin && !sameHost(req.headers.origin, req.headers.host)) {
      return send(res, 403, fail('不接受跨站请求'));
    }

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (error) {
      return send(res, 400, fail(`请求不是合法的 JSON：${error.message}`));
    }

    const lines = body?.lines;
    if (!Array.isArray(lines) || !lines.every((line) => typeof line === 'string')) {
      return send(res, 400, fail('请求里没有 lines 数组'));
    }
    if (lines.length === 0 || lines.length > MAX_LINES || lines.join('').length > MAX_CHARS) {
      return send(res, 413, fail(`这一段太长，一次最多 ${MAX_LINES} 行 / ${MAX_CHARS} 字`));
    }

    // 规则先在手上：模型这条路走不通时，应用自己会用它兜底（应用端本来就算了一份）。
    // 所以这里如实报错，不假装成功——否则应用会显示「AI 整理」，实际却是规则做的。
    let result;
    try {
      result = await labelRequest(lines, config, fetchImpl);
    } catch (error) {
      result = { status: 502, body: fail(`网关内部出错：${error.message}`) };
    }
    const brief = result.status === 200 ? result.body.engine : result.body.error.message;
    log(`POST / ${lines.length} 行 ${Date.now() - started}ms ${result.status} ${brief}`);
    return send(res, result.status, result.body);
  });
}

async function main() {
  const config = checkExposure(configFromEnv());
  if (!config.apiKey) console.error('提示：还没有设置 TIDY_API_KEY，整理请求会一律返回 503，应用会退回规则整理。');
  if (!isLoopback(config.host)) {
    console.error(`注意：网关正在监听 ${config.host}，本机以外也能访问（已要求 TIDY_TOKEN）。`);
  }
  const server = createGateway(config, { log: (line) => console.error(line) });
  server.listen(config.port, config.host, () => {
    const shown = config.host.includes(':') ? `[${config.host}]` : config.host;
    console.error(`整理网关已启动：http://${shown}:${config.port}（模型 ${config.model}，上游 ${config.baseUrl}）`);
    console.error(`接到应用：MDPAD_TIDY_URL=http://127.0.0.1:${config.port}/tidy`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
