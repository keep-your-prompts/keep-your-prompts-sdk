// Tests for server/proxy.mjs against a fake Streamable HTTP MCP server. Run: node --test test/*.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { endpointFrom, sseMessages } from '../server/proxy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PROXY = join(here, '..', 'server', 'proxy.mjs');
const KEY = 'kyp_live_TESTKEY0123456789abcdef';

const seen = [];
let hang = false;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.push({ method: req.method, headers: req.headers, body: body ? JSON.parse(body) : null });
    if (req.method === 'DELETE') return res.writeHead(204).end();
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      res.writeHead(401, { 'content-type': 'application/problem+json', 'www-authenticate': 'Bearer resource_metadata="x"' });
      return res.end('{"title":"Unauthorized","status":401}');
    }
    const msg = JSON.parse(body);
    if (msg.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-abc' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2026-07-28', capabilities: { tools: {}, prompts: {} }, serverInfo: { name: 'keep-your-prompts', version: '0.1.0' } } }));
    }
    if (msg.method?.startsWith('notifications/')) return res.writeHead(202).end();
    if (msg.method === 'tools/call' && hang) return; // never answers
    if (msg.method === 'tools/list') {
      // SSE with a progress notification, CRLF line endings and a split write.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': keep-alive\r\n\r\n');
      res.write(`event: message\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\r\n\r\n`);
      const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'search_prompts', title: 'Search prompts', inputSchema: { type: 'object' } }] } });
      res.write(`data: ${payload.slice(0, 20)}`);
      setTimeout(() => res.end(`${payload.slice(20)}\r\n\r\n`), 30);
      return;
    }
    if (msg.method === 'tools/call') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }));
  });
});
let base;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

/** Runs the proxy, sends lines, collects stdout lines until `expect` responses arrived, then closes stdin. */
function session(lines, { env = {}, expect = lines.filter((l) => l.id !== undefined).length, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROXY], { env: { PATH: process.env.PATH, KYP_API_URL: base, KYP_API_KEY: KEY, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    let buf = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout; got ${JSON.stringify(out)}; stderr ${stderr}`));
    }, timeout);
    child.stderr.on('data', (c) => (stderr += c));
    child.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        out.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
        if (out.filter((m) => m.id !== undefined).length >= expect) child.stdin.end();
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, stderr });
    });
    (async () => {
      for (const l of lines) {
        child.stdin.write(`${typeof l === 'string' ? l : JSON.stringify(l)}\n`);
        // Like a real client, wait for the initialize result before sending anything else.
        if (l?.method === 'initialize') while (!out.some((m) => m.id === l.id)) await new Promise((r) => setTimeout(r, 10));
      }
      if (expect === 0) child.stdin.end();
    })();
  });
}

describe('helpers', () => {
  test('endpointFrom appends /mcp and refuses remote http', () => {
    assert.equal(endpointFrom(undefined), 'https://api.keepyourprompts.com/mcp');
    assert.equal(endpointFrom('https://api.example.com/'), 'https://api.example.com/mcp');
    assert.equal(endpointFrom('https://api.example.com/mcp'), 'https://api.example.com/mcp');
    assert.equal(endpointFrom('http://localhost:8080'), 'http://localhost:8080/mcp');
    assert.throws(() => endpointFrom('http://api.example.com'));
  });
  test('sseMessages handles CRLF, comments, multi-line data and split chunks', async () => {
    const enc = new TextEncoder();
    async function* body() {
      yield enc.encode(': hi\r\n\r\ndata: {"a":');
      yield enc.encode('1}\r\n\r\nevent: other\ndata: skip\n\ndata: line1\ndata: line2\n\ndata: tail');
    }
    const got = [];
    for await (const d of sseMessages(body())) got.push(d);
    assert.deepEqual(got, ['{"a":1}', 'line1\nline2', 'tail']);
  });
});

describe('bridge process', () => {
  test('initialize, notification, SSE list and a tool call', async () => {
    seen.length = 0;
    const { code, out } = await session([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'claude-desktop', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_prompts', arguments: { query: 'refund' } } },
    ]);
    assert.equal(code, 0);
    const byId = Object.fromEntries(out.filter((m) => m.id !== undefined).map((m) => [m.id, m]));
    assert.equal(byId[1].result.serverInfo.name, 'keep-your-prompts');
    assert.equal(byId[2].result.tools[0].name, 'search_prompts');
    assert.equal(byId[3].result.content[0].text, 'ok');
    assert.ok(out.some((m) => m.method === 'notifications/progress'), 'SSE notification forwarded');
    const posts = seen.filter((s) => s.method === 'POST');
    assert.equal(posts[0].headers['mcp-session-id'], undefined);
    assert.equal(posts[1].headers['mcp-session-id'], 'sess-abc', 'session id reused');
    assert.equal(posts[2].headers['mcp-protocol-version'], '2026-07-28', 'negotiated version sent');
    assert.match(posts[0].headers.accept, /application\/json/);
    assert.match(posts[0].headers.accept, /text\/event-stream/);
    assert.ok(seen.some((s) => s.method === 'DELETE' && s.headers['mcp-session-id'] === 'sess-abc'), 'session closed on exit');
  });

  test('a bad key becomes a JSON-RPC error with a fix, not a hang', async () => {
    const { out, stderr } = await session([{ jsonrpc: '2.0', id: 7, method: 'tools/list' }], { env: { KYP_API_KEY: 'kyp_live_WRONGKEY0000000000' } });
    assert.equal(out[0].id, 7);
    assert.equal(out[0].error.code, -32000);
    assert.match(out[0].error.message, /rejected the API key/);
    assert.match(stderr, /rejected the API key/);
  });

  test('unreachable server and timeouts answer every request', async () => {
    const down = await session([{ jsonrpc: '2.0', id: 'a', method: 'tools/list' }], { env: { KYP_API_URL: 'http://127.0.0.1:9' } });
    assert.equal(down.out[0].id, 'a');
    assert.match(down.out[0].error.message, /unreachable/);
    hang = true;
    const slow = await session([{ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'x' } }], { env: { KYP_TIMEOUT_MS: '300' } });
    hang = false;
    assert.equal(slow.out[0].id, 9);
    assert.match(slow.out[0].error.message, /timed out/);
  });

  test('invalid JSON on stdin gets a parse error', async () => {
    const { out } = await session(['{not json'], { expect: 1 });
    assert.equal(out[0].error.code, -32700);
  });
});
