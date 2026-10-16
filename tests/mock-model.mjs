// 模型桩：模仿一个 OpenAI 兼容接口，按行数返回预设标签。只给标签，不给文字。
import http from 'node:http';

const LABELS = process.env.MOCK_LABELS ? process.env.MOCK_LABELS.split(',') : ['h1', 'h2', 'h3', 'h2', 'h3'];

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      res.writeHead(400).end('{}');
      return;
    }
    const ask = body.messages?.at(-1)?.content ?? '';
    const count = (ask.match(/^\s*\d+\t/gm) || []).length;
    const labels = Array.from({ length: count }, (_, i) => LABELS[i] ?? 'p');
    console.log(`MOCK 收到请求：${count} 行，模型=${body.model}，回 ${JSON.stringify(labels)}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ labels }) } }] }));
  });
});

server.listen(Number(process.env.MOCK_PORT || 8792), '127.0.0.1', () => console.log('模型桩就绪'));
