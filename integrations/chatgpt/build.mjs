#!/usr/bin/env node
// Builds dist/keep-your-prompts-chatgpt-<version>.zip for the OpenAI plugin portal (ChatGPT and Codex):
// plugin.json, mcp.json, LICENSE, skills/ and assets/ at the root of the archive. No secrets, hooks or .app.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, zip } from '../scripts/zip.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const plugin = JSON.parse(readFileSync(join(here, 'plugin.json'), 'utf8'));
const keep = (rel) => rel === 'plugin.json' || rel === 'mcp.json' || rel === 'LICENSE' || /^(skills|assets)(\/|$)/.test(rel);
const entries = collect(here, (rel) => !keep(rel));
for (const required of ['plugin.json', 'mcp.json', 'LICENSE', 'skills/keep-your-prompts/SKILL.md', 'assets/icon.png', 'assets/logo.png']) {
  if (!entries.some((e) => e.name === required)) throw new Error(`missing ${required}`);
}
const out = join(here, 'dist', `${plugin.name}-chatgpt-${plugin.version}.zip`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, zip(entries));
console.log(`wrote ${out} (${entries.map((e) => e.name).join(', ')})`);
