#!/usr/bin/env node
// Builds dist/keep-your-prompts-<version>.mcpb: manifest.json, icon.png, LICENSE and server/ (no dependencies to bundle).
// Usage: node build.mjs            (then: npx @anthropic-ai/mcpb validate manifest.json, and optionally mcpb sign)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, zip } from '../scripts/zip.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));

const include = new Set(['manifest.json', 'icon.png', 'README.md', 'LICENSE', 'server/proxy.mjs']);
const entries = collect(here, (rel) => !(include.has(rel) || rel === 'server'));
for (const f of include) if (!entries.some((e) => e.name === f)) throw new Error(`missing ${f}`);

const out = join(here, 'dist', `${manifest.name}-${manifest.version}.mcpb`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, zip(entries));
console.log(`wrote ${out} (${entries.length} files)`);
