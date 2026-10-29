#!/usr/bin/env node
// Keep Your Prompts: stdio <-> Streamable HTTP bridge for Claude Desktop (MCP Bundle). Zero dependencies, Node 18+.
//
// Claude Desktop starts this process and speaks MCP over stdio (one JSON-RPC message per line). Each message is
// forwarded to the remote server at <KYP_API_URL>/mcp with the user's API key; the reply (JSON or an SSE stream)
// is written back to stdout, one message per line. Logs go to stderr, which Claude Desktop keeps in its MCP log.
//
// Environment (set by the bundle's user_config):
//   KYP_API_KEY    kyp_live_... workspace API key (required)
//   KYP_API_URL    default https://api.keepyourprompts.com
//   KYP_WORKSPACE  optional workspace id (X-KYP-Workspace)
//   KYP_TIMEOUT_MS per-request timeout, default 120000

import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const VERSION = '0.1.0';
// MCP 2026-07-28 carries the protocol version in each message's _meta instead of an initialize handshake.
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const log = (...a) => process.stderr.write(`[keep-your-prompts] ${a.join(' ')}\n`);

/** Resolves the MCP endpoint from a base URL; refuses plain http except to loopback. */
export function endpointFrom(base) {
  const u = new URL(base || 'https://api.keepyourprompts.com');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error(`KYP_API_URL must use https (got ${u.protocol})`);
  const path = u.pathname.replace(/\/+$/, '');
  return new URL(path.endsWith('/mcp') ? path : `${path}/mcp`, u).toString();
}

/** Yields the data payload of each "message" event in an SSE body. */
export async function* sseMessages(body) {
  const decoder = new TextDecoder();
  let buf = '';
  let data = [];
  let event = 'message';
  function* flush() {
    if (data.length && event === 'message') yield data.join('\n');
    data = [];
    event = 'message';
  }
  function* lines(final) {
    let m;
    while ((m = /\r\n|\n|\r/.exec(buf))) {
      // A trailing \r may be the first half of \r\n: wait for more input.
      if (!final && m[0] === '\r' && m.index === buf.length - 1) break;
      const line = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      if (line === '') yield* flush();
      else if (!line.startsWith(':')) {
        const i = line.indexOf(':');
        const field = i < 0 ? line : line.slice(0, i);
        const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
        if (field === 'data') data.push(value);
        else if (field === 'event') event = value || 'message';
      }
    }
  }
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    yield* lines(false);
  }
  buf += decoder.decode();
  if (buf) buf += '\n';
  yield* lines(true);
  yield* flush();
}

export function createBridge({ url, apiKey, workspace, timeoutMs = 120_000, write, fetchImpl = fetch }) {
  let sessionId = null;
  let protocolVersion = null;

  const headers = (message) => {
    const h = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'user-agent': `kyp-claude-desktop/${VERSION}`,
    };
    if (apiKey) h.authorization = `Bearer ${apiKey}`;
    if (workspace) h['x-kyp-workspace'] = workspace;
    if (sessionId) h['mcp-session-id'] = sessionId;
    const single = message && !Array.isArray(message) ? message : null;
    const claimed = single?.params?._meta?.[PROTOCOL_VERSION_META_KEY];
    if (typeof claimed === 'string') {
      h['mcp-protocol-version'] = claimed; // modern era: the header must match the body's claim
      if (typeof single.method === 'string') h['mcp-method'] = single.method;
    } else if (protocolVersion) {
      h['mcp-protocol-version'] = protocolVersion; // 2025 era: the version negotiated by initialize
    }
    return h;
  };

  const emit = (msg) => {
    // Remember the negotiated version so later requests carry MCP-Protocol-Version.
    if (msg && typeof msg === 'object' && msg.result && typeof msg.result.protocolVersion === 'string' && msg.result.serverInfo) {
      protocolVersion = msg.result.protocolVersion;
    }
    write(JSON.stringify(msg));
  };
  const fail = (ids, code, message) => {
    for (const id of ids) emit({ jsonrpc: '2.0', id, error: { code, message } });
  };

  async function forward(message) {
    const batch = Array.isArray(message) ? message : [message];
    const ids = batch.filter((m) => m && m.id !== undefined && m.id !== null && typeof m.method === 'string').map((m) => m.id);
    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', headers: headers(message), body: JSON.stringify(message), signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const why = err?.name === 'TimeoutError' ? `timed out after ${Math.round(timeoutMs / 1000)} s` : (err?.cause?.code ?? err?.message ?? 'network error');
      log(`request failed: ${why}`);
      fail(ids, -32000, `Keep Your Prompts is unreachable (${why}). Check your connection and try again.`);
      return;
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    if (res.status === 202 || res.status === 204) {
      await res.body?.cancel().catch(() => {});
      return;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {}
      if (parsed && parsed.jsonrpc === '2.0') {
        emit(parsed); // a JSON-RPC error from the server passes through as-is
        return;
      }
      if (res.status === 404 && sessionId) sessionId = null; // session expired: the client re-initializes
      const detail = (parsed && (parsed.detail || parsed.title)) || '';
      const msg = res.status === 401
        ? 'Keep Your Prompts rejected the API key. Create a key in Settings > API keys at app.keepyourprompts.com and update it in Claude Desktop (Settings > Extensions > Keep Your Prompts).'
        : res.status === 429
          ? `Keep Your Prompts quota reached${detail ? `: ${detail}` : '.'}`
          : `Keep Your Prompts returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`;
      log(msg);
      fail(ids, -32000, msg);
      return;
    }
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const answered = new Set();
    const out = (m) => {
      if (m && m.id !== undefined && m.method === undefined) answered.add(m.id);
      emit(m);
    };
    try {
      if (type.includes('text/event-stream')) {
        for await (const data of sseMessages(res.body)) {
          if (!data.trim()) continue;
          const parsed = JSON.parse(data);
          for (const m of Array.isArray(parsed) ? parsed : [parsed]) out(m);
        }
      } else {
        const text = await res.text();
        if (text.trim()) {
          const parsed = JSON.parse(text);
          for (const m of Array.isArray(parsed) ? parsed : [parsed]) out(m);
        }
      }
    } catch (err) {
      log(`bad response: ${err?.message}`);
    }
    fail(ids.filter((id) => !answered.has(id)), -32000, 'Keep Your Prompts closed the response without an answer.');
  }

  async function close() {
    if (!sessionId) return;
    try {
      const res = await fetchImpl(url, { method: 'DELETE', headers: headers(), signal: AbortSignal.timeout(2000) });
      await res.body?.cancel().catch(() => {});
    } catch {}
  }

  return { forward, close };
}

async function main() {
  const env = process.env;
  let url;
  try {
    url = endpointFrom(env.KYP_API_URL);
  } catch (err) {
    log(err.message);
    process.exit(1);
  }
  const apiKey = String(env.KYP_API_KEY ?? '').trim();
  if (!/^kyp_(?:live|test)_[A-Za-z0-9_-]{8,}$/.test(apiKey)) {
    log('KYP_API_KEY is missing or is not a Keep Your Prompts key (kyp_live_...). Set it in Settings > Extensions > Keep Your Prompts.');
  }
  const ws = String(env.KYP_WORKSPACE ?? '').trim();
  const t = Number.parseInt(env.KYP_TIMEOUT_MS ?? '', 10);
  const bridge = createBridge({
    url,
    apiKey,
    workspace: /^[\w-]{1,100}$/.test(ws) ? ws : '',
    timeoutMs: Number.isFinite(t) && t > 0 ? t : 120_000,
    write: (line) => process.stdout.write(`${line}\n`),
  });

  const pending = new Set();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      return;
    }
    const p = bridge.forward(msg).catch((err) => log(`unexpected: ${err?.message}`));
    pending.add(p);
    p.finally(() => pending.delete(p));
  });
  rl.on('close', async () => {
    await Promise.allSettled([...pending]);
    await bridge.close();
    process.exit(0);
  });
  log(`bridge ready -> ${url}`);
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isMain()) main();
