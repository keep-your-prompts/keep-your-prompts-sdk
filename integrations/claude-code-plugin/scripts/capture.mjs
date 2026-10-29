#!/usr/bin/env node
// Keep Your Prompts: prompt-capture hook. Zero dependencies, Node 18+.
//
// Sends each prompt you type in an AI coding agent to your Keep Your Prompts inbox
// (POST /v1/captures, source "ide"). One script serves several hosts, detected from the hook payload:
//   Claude Code  UserPromptSubmit     (prints nothing)
//   Codex        UserPromptSubmit     (prints nothing)
//   Gemini CLI   BeforeAgent          (prints "{}", Gemini requires JSON on stdout)
//   Cursor       beforeSubmitPrompt   (prints {"continue":true})
//
// Opt-in and fail-silent:
//   - Does nothing unless KYP_CAPTURE is 1/true/yes/on and KYP_API_KEY holds a kyp_live_/kyp_test_ key.
//   - Never blocks or alters the prompt, never exits non-zero, never writes to stderr.
//   - Secrets are redacted on this machine before anything leaves it (same rules as the browser extension).
//   - The HTTP request runs in a detached child process with a short timeout, so the agent never waits on it.
//
// Environment:
//   KYP_CAPTURE=1                 turn capture on (off by default)
//   KYP_API_KEY=kyp_live_...      workspace API key (Settings > API keys)
//   KYP_API_URL                   default https://api.keepyourprompts.com
//   KYP_WORKSPACE                 optional workspace id (X-KYP-Workspace)
//   KYP_CAPTURE_MIN_CHARS         skip prompts shorter than this (default 12)
//   KYP_CAPTURE_SLASH=1           also capture slash commands (skipped by default)
//   KYP_CAPTURE_TIMEOUT_MS        request timeout (default 3000, max 10000)
//   KYP_REDACT_EMAIL=1            also redact email addresses
//   KYP_CAPTURE_DETACH=0          send in-process instead of a detached child (tests, debugging)

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAX_TEXT = 256 * 1024; // server limit (CreateCapture.text)
const MAX_STDIN = 2 * 1024 * 1024;
const TRUE = new Set(['1', 'true', 'yes', 'on']);

// ── redaction (port of apps/extension/src/lib/redact.ts, default rules) ──

const tag = (id) => `[REDACTED:${id}]`;

function luhn(digits) {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const RULES = [
  ['private-key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g, 'private-key'],
  ['openai-anthropic-key', /\bsk-(?:proj-|ant-(?:api\d\d-|admin\d\d-)?|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, 'api-key'],
  ['aws-key', /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g, 'aws-key'],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g, 'github-token'],
  ['slack-token', /\bxox[abposre]-[A-Za-z0-9-]{10,}/g, 'slack-token'],
  ['kyp-key', /\bkyp(?:_live|_test|d)_[A-Za-z0-9_-]{16,}/g, 'kyp-key'],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g, 'google-api-key'],
  ['stripe-key', /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}/g, 'stripe-key'],
  ['jwt', /\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, 'jwt'],
];

/** Redacts secrets; returns { text, total }. Best effort, never a guarantee. */
export function redact(input, { email = false } = {}) {
  let text = input;
  let total = 0;
  for (const [, re, id] of RULES) {
    text = text.replace(re, () => {
      total++;
      return tag(id);
    });
  }
  text = text.replace(/\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@]{1,128}:)([^\s@/]{1,256})(@)/gi, (m, pre, pass, at) => {
    if (pass.startsWith('[REDACTED:')) return m;
    total++;
    return `${pre}${tag('password')}${at}`;
  });
  text = text.replace(/\b(Bearer\s+)([A-Za-z0-9._~+/-]{16,}=*)/g, (m, pre, tok) => {
    if (tok.startsWith('[REDACTED')) return m;
    total++;
    return `${pre}${tag('token')}`;
  });
  text = text.replace(/(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g, (m) => {
    const digits = m.replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > 19 || !'23456'.includes(digits[0]) || !luhn(digits)) return m;
    total++;
    return tag('card');
  });
  if (email) {
    text = text.replace(/\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g, () => {
      total++;
      return tag('email');
    });
  }
  return { text, total };
}

// ── host detection and prompt filtering ──

export function detectHost(payload) {
  const ev = String(payload?.hook_event_name ?? '');
  if (ev === 'BeforeAgent') return 'gemini';
  if (ev === 'beforeSubmitPrompt' || payload?.conversation_id !== undefined) return 'cursor';
  if (ev === 'UserPromptSubmit') return payload?.turn_id !== undefined || payload?.model !== undefined ? 'codex' : 'claude-code';
  return 'other';
}

// Turns a host starts on its own (scheduled tasks, background agents reporting back, cross-session messages)
// arrive wrapped in a tag; they are not prompts a person typed.
const SYNTHETIC = /^<(task-notification|cross-session-message|system-reminder|local-command-stdout|local-command-stderr|command-name|command-message|bash-input|bash-stdout|bash-stderr|scheduled-task|webhook-payload|child-session-event|wake)\b/i;

/** Returns the text to capture, or null when this prompt should be skipped. */
export function selectPrompt(raw, env = process.env) {
  if (typeof raw !== 'string') return null;
  // Claude Code marks expanded pastes with <pasted_content id="…"> lines; keep the content, drop the markers.
  let text = raw.replace(/^<\/?pasted_content(?: id="[^"]*")?>\s*$/gm, '').trim();
  if (!text) return null;
  if (SYNTHETIC.test(text)) return null;
  if (text.startsWith('/') && !TRUE.has(String(env.KYP_CAPTURE_SLASH ?? '').toLowerCase())) return null;
  const min = Number.parseInt(env.KYP_CAPTURE_MIN_CHARS ?? '', 10);
  if (text.length < (Number.isFinite(min) && min >= 0 ? min : 12)) return null;
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
  return text;
}

const HOST_PREFIX = { 'claude-code': 'cc', codex: 'codex', gemini: 'gem', cursor: 'cur', other: 'ide' };

/**
 * The server merges captures that share a clientId (it was built for draft autosave), so each distinct prompt needs
 * its own id: host + session + content hash. Re-sending the same text in the same session stays one inbox row.
 */
export function clientIdFor(host, payload, text) {
  const session = String(payload?.session_id ?? payload?.conversation_id ?? 'nosession').replace(/[^\w.-]/g, '').slice(0, 64);
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 20);
  return `${HOST_PREFIX[host] ?? 'ide'}:${session}:${hash}`.slice(0, 100);
}

/** Builds the request, or null when capture is off or misconfigured. */
export function buildRequest(payload, env = process.env) {
  if (!TRUE.has(String(env.KYP_CAPTURE ?? '').toLowerCase())) return null;
  const key = String(env.KYP_API_KEY ?? '').trim();
  if (!/^kyp_(?:live|test)_[A-Za-z0-9_-]{8,}$/.test(key)) return null;
  let base;
  try {
    base = new URL(env.KYP_API_URL || 'https://api.keepyourprompts.com');
  } catch {
    return null;
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) return null; // never send a key in clear text
  const selected = selectPrompt(payload?.prompt, env);
  if (!selected) return null;
  const { text } = redact(selected, { email: TRUE.has(String(env.KYP_REDACT_EMAIL ?? '').toLowerCase()) });
  const host = detectHost(payload);
  const headers = {
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
    'user-agent': `kyp-capture/0.1 (${host})`,
  };
  const ws = String(env.KYP_WORKSPACE ?? '').trim();
  if (/^[\w-]{1,100}$/.test(ws)) headers['x-kyp-workspace'] = ws;
  const t = Number.parseInt(env.KYP_CAPTURE_TIMEOUT_MS ?? '', 10);
  return {
    url: new URL('/v1/captures', base).toString(),
    headers,
    body: JSON.stringify({ source: 'ide', text, draft: false, clientId: clientIdFor(host, payload, text) }),
    timeoutMs: Number.isFinite(t) && t > 0 ? Math.min(t, 10_000) : 3000,
  };
}

export async function send(req) {
  try {
    const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(req.timeoutMs) });
    await res.body?.cancel().catch(() => {});
    return res.status;
  } catch {
    return 0;
  }
}

function readStdin(limitMs = 1500) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const done = () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(done, limitMs);
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size <= MAX_STDIN) chunks.push(c);
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

function ack(host) {
  if (host === 'gemini') process.stdout.write('{}');
  else if (host === 'cursor') process.stdout.write('{"continue":true}');
}

async function main() {
  if (process.argv[2] === '--send') {
    // Detached child: the request arrives on stdin as JSON.
    try {
      await send(JSON.parse(await readStdin(5000)));
    } catch {}
    return;
  }
  let payload = {};
  try {
    payload = JSON.parse(await readStdin());
  } catch {}
  ack(detectHost(payload));
  let req = null;
  try {
    req = buildRequest(payload);
  } catch {}
  if (!req) return;
  if (String(process.env.KYP_CAPTURE_DETACH ?? '1') === '0') {
    await send(req);
    return;
  }
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--send'], {
      detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, env: process.env,
    });
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(req), () => child.unref());
  } catch {}
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch(() => {}).finally(() => {
    process.exitCode = 0;
  });
}
