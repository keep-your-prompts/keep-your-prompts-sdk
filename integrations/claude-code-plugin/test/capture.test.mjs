// Tests for scripts/capture.mjs and scripts/mcp-headers.sh against a fake API. Run: node --test test/
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildRequest, clientIdFor, detectHost, redact, selectPrompt } from '../scripts/capture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', 'scripts', 'capture.mjs');
const HEADERS = join(here, '..', 'scripts', 'mcp-headers.sh');
const KEY = 'kyp_live_TESTKEY0123456789abcdef';

// ── fake API ──
const received = [];
let mode = 'ok'; // ok | hang | slow
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null, at: Date.now() });
    if (mode === 'hang') return; // never answer
    const reply = () => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"id":"cap_1"}');
    };
    if (mode === 'slow') setTimeout(reply, 1500);
    else reply();
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

function run(payload, env = {}, { raw } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [SCRIPT], {
      env: { PATH: process.env.PATH, KYP_API_URL: base, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(raw ?? JSON.stringify(payload));
  });
}
const waitFor = async (pred, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
};
const claude = (prompt) => ({ session_id: 'sess-123', transcript_path: '/tmp/t.jsonl', cwd: '/tmp', permission_mode: 'default', hook_event_name: 'UserPromptSubmit', prompt });
const ON = { KYP_CAPTURE: '1', KYP_API_KEY: KEY };

describe('redaction', () => {
  test('removes common secrets', () => {
    const input = [
      'openai sk-proj-abcdefghijklmnopqrstuvwxyz0123',
      'anthropic sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
      'aws AKIAABCDEFGHIJKLMNOP',
      'gh ghp_' + 'a'.repeat(36),
      'kyp kyp_live_abcdefghijklmnopqrstu',
      'google AIza' + 'b'.repeat(35),
      'stripe sk_live_abcdefghijklmnop1234',
      'jwt eyJhbGciOi.eyJzdWIiOiIx.abcdefghij',
      'db postgres://admin:hunter2secret@db.internal:5432/app',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
      'card 4111 1111 1111 1111',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const { text, total } = redact(input);
    for (const secret of ['abcdefghijklmnopqrstuvwxyz0123', 'AKIAABCDEFGHIJKLMNOP', 'hunter2secret', '4111 1111 1111 1111', 'MIIEow', 'kyp_live_abcdefghijklmnopqrstu', 'sk_live_abcdefghijklmnop1234', 'eyJhbGciOi']) {
      assert.ok(!text.includes(secret), `leaked ${secret}`);
    }
    assert.ok(total >= 12, `expected 12+ redactions, got ${total}`);
    assert.match(text, /\[REDACTED:password\]@db\.internal/);
  });
  test('keeps ordinary text, numbers and emails by default', () => {
    const s = 'Order 1234 5678 shipped to ana@example.com on 2026-10-29; ticket 4111111111111112 is not a card.';
    assert.equal(redact(s).text, s);
    assert.match(redact(s, { email: true }).text, /\[REDACTED:email\]/);
  });
});

describe('prompt selection', () => {
  test('skips slash commands, short prompts and synthetic turns', () => {
    assert.equal(selectPrompt('/kyp:save', {}), null);
    assert.equal(selectPrompt('yes', {}), null);
    assert.equal(selectPrompt('<task-notification>\nBackground task done</task-notification>', {}), null);
    assert.equal(selectPrompt('   ', {}), null);
    assert.ok(selectPrompt('/review the auth module carefully', { KYP_CAPTURE_SLASH: '1' }));
    assert.ok(selectPrompt('ok go', { KYP_CAPTURE_MIN_CHARS: '0' }));
  });
  test('drops pasted-content markers but keeps the paste', () => {
    const t = selectPrompt('Summarize this:\n<pasted_content id="1">\nline one\n</pasted_content id="1">', {});
    assert.equal(t, 'Summarize this:\n\nline one');
  });
  test('truncates to the server limit', () => {
    assert.equal(selectPrompt('x'.repeat(300 * 1024), {}).length, 256 * 1024);
  });
  test('detects hosts and builds distinct client ids per prompt', () => {
    assert.equal(detectHost(claude('x')), 'claude-code');
    assert.equal(detectHost({ hook_event_name: 'BeforeAgent' }), 'gemini');
    assert.equal(detectHost({ hook_event_name: 'beforeSubmitPrompt', conversation_id: 'c' }), 'cursor');
    const a = clientIdFor('claude-code', claude('x'), 'first prompt');
    const b = clientIdFor('claude-code', claude('x'), 'second prompt');
    assert.notEqual(a, b);
    assert.match(a, /^cc:sess-123:[0-9a-f]{20}$/);
    assert.ok(a.length <= 100);
  });
  test('refuses to send a key over plain http to a remote host', () => {
    assert.equal(buildRequest(claude('refactor the payment module please'), { ...ON, KYP_API_URL: 'http://api.example.com' }), null);
    assert.ok(buildRequest(claude('refactor the payment module please'), { ...ON, KYP_API_URL: 'https://api.example.com' }));
  });
});

describe('hook process', () => {
  test('does nothing when capture is off (default)', async () => {
    received.length = 0;
    const r = await run(claude('Write a migration that adds an index on users.email'), { KYP_API_KEY: KEY });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(received.length, 0);
  });

  test('does nothing without a valid key', async () => {
    received.length = 0;
    const r = await run(claude('Write a migration that adds an index on users.email'), { KYP_CAPTURE: '1', KYP_API_KEY: 'not-a-key' });
    assert.equal(r.code, 0);
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(received.length, 0);
  });

  test('sends a redacted capture (in-process mode)', async () => {
    received.length = 0;
    mode = 'ok';
    const prompt = 'Debug this: curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123" https://x.dev with key sk-ant-api03-SECRETSECRETSECRETSECRET';
    const r = await run(claude(prompt), { ...ON, KYP_CAPTURE_DETACH: '0', KYP_WORKSPACE: 'ws_42' });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', 'Claude Code hooks must not print (stdout becomes context)');
    assert.equal(r.stderr, '');
    assert.equal(received.length, 1);
    const [c] = received;
    assert.equal(c.method, 'POST');
    assert.equal(c.url, '/v1/captures');
    assert.equal(c.headers.authorization, `Bearer ${KEY}`);
    assert.equal(c.headers['x-kyp-workspace'], 'ws_42');
    assert.equal(c.headers['content-type'], 'application/json');
    assert.equal(c.body.source, 'ide');
    assert.equal(c.body.draft, false);
    assert.match(c.body.clientId, /^cc:sess-123:[0-9a-f]{20}$/);
    assert.ok(!c.body.text.includes('SECRETSECRET'));
    assert.ok(!c.body.text.includes('abcdefghijklmnopqrstuvwxyz123'));
    assert.match(c.body.text, /\[REDACTED:token\]/);
    assert.match(c.body.text, /\[REDACTED:api-key\]/);
  });

  test('detached mode returns immediately and still delivers', async () => {
    received.length = 0;
    mode = 'slow';
    const r = await run(claude('Explain the retry logic in src/queue/worker.ts'), ON);
    assert.equal(r.code, 0);
    assert.ok(r.ms < 1000, `hook took ${r.ms} ms`);
    assert.ok(await waitFor(() => received.length === 1), 'detached child did not deliver');
    mode = 'ok';
  });

  test('gives up after the timeout when the API hangs', async () => {
    received.length = 0;
    mode = 'hang';
    const r = await run(claude('Write tests for the rate limiter edge cases'), { ...ON, KYP_CAPTURE_DETACH: '0', KYP_CAPTURE_TIMEOUT_MS: '400' });
    assert.equal(r.code, 0);
    assert.equal(r.stderr, '');
    assert.equal(received.length, 1);
    assert.ok(r.ms < 2500, `hook took ${r.ms} ms`);
    mode = 'ok';
  });

  test('stays silent when the API is unreachable', async () => {
    const r = await run(claude('Write tests for the rate limiter edge cases'), { ...ON, KYP_CAPTURE_DETACH: '0', KYP_API_URL: 'http://127.0.0.1:9' });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  });

  test('survives garbage on stdin', async () => {
    const r = await run(null, ON, { raw: 'not json' });
    assert.equal(r.code, 0);
    assert.equal(r.stderr, '');
  });

  test('answers Gemini CLI and Cursor in their formats', async () => {
    received.length = 0;
    const g = await run({ session_id: 'g1', hook_event_name: 'BeforeAgent', prompt: 'Draft release notes for v2.3 from the changelog', timestamp: '2026-10-29T00:00:00Z' }, { ...ON, KYP_CAPTURE_DETACH: '0' });
    assert.equal(g.stdout, '{}');
    const c = await run({ conversation_id: 'c1', hook_event_name: 'beforeSubmitPrompt', prompt: 'Rename the user service to account service everywhere' }, { ...ON, KYP_CAPTURE_DETACH: '0' });
    assert.deepEqual(JSON.parse(c.stdout), { continue: true });
    assert.equal(received.length, 2);
    assert.match(received[0].body.clientId, /^gem:g1:/);
    assert.match(received[1].body.clientId, /^cur:c1:/);
    // Answers even when capture is off.
    const off = await run({ hook_event_name: 'beforeSubmitPrompt', conversation_id: 'c1', prompt: 'x' }, {});
    assert.deepEqual(JSON.parse(off.stdout), { continue: true });
  });
});

describe('MCP headers helper', () => {
  const helper = (env) => new Promise((resolve, reject) => {
    execFile('sh', [HEADERS], { env: { PATH: process.env.PATH, ...env } }, (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout))));
  });
  test('sends the API key as a bearer token', async () => {
    assert.deepEqual(await helper({ KYP_API_KEY: KEY }), { Authorization: `Bearer ${KEY}` });
  });
  test('prints {} without a key so OAuth is used', async () => {
    assert.deepEqual(await helper({}), {});
  });
  test('rejects values that would break the JSON', async () => {
    assert.deepEqual(await helper({ KYP_API_KEY: 'kyp_live_abc"},"x":"y' }), {});
    assert.deepEqual(await helper({ KYP_API_KEY: 'sk-other-provider' }), {});
  });
  test('adds the workspace header', async () => {
    assert.deepEqual(await helper({ KYP_API_KEY: KEY, KYP_WORKSPACE: 'ws_42' }), { Authorization: `Bearer ${KEY}`, 'X-KYP-Workspace': 'ws_42' });
  });
});
