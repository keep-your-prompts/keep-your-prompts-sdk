#!/usr/bin/env node
// Copies files shared between integrations from their canonical location. `--check` fails if a copy is stale.
//   node scripts/sync-shared.mjs          update copies
//   node scripts/sync-shared.mjs --check  CI: exit 1 when a copy differs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = [
  // The prompt-capture hook: one script for Claude Code, Codex, Gemini CLI and Cursor.
  ['claude-code-plugin/scripts/capture.mjs', ['gemini-cli/scripts/capture.mjs']],
  // The repository LICENSE, shipped inside every plugin, extension and bundle built from this folder.
  ['../LICENSE', ['claude-code-plugin/LICENSE', 'gemini-cli/LICENSE', 'claude-desktop/LICENSE', 'chatgpt/LICENSE']],
];
const check = process.argv.includes('--check');
let stale = 0;
for (const [src, copies] of SHARED) {
  const want = readFileSync(join(root, src));
  for (const dst of copies) {
    let have = null;
    try {
      have = readFileSync(join(root, dst));
    } catch {}
    if (have && have.equals(want)) continue;
    if (check) {
      console.error(`stale: ${dst} differs from ${src} (run node scripts/sync-shared.mjs)`);
      stale++;
    } else {
      writeFileSync(join(root, dst), want);
      console.log(`updated ${dst}`);
    }
  }
}
process.exit(stale ? 1 : 0);
