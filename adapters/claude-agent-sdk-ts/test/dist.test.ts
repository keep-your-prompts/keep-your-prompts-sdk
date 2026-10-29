// Smoke test of the built package (ESM and CJS entry points). Skipped before `npm run build`.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { snapshotClient } from './helpers.js';

const dist = fileURLToPath(new URL('../dist', import.meta.url));
const built = existsSync(join(dist, 'index.cjs'));

describe.skipIf(!built)('dist', () => {
  it('loads as CommonJS and ESM', async () => {
    const cjs = createRequire(import.meta.url)(join(dist, 'index.cjs')) as typeof import('../src/index.js');
    const esm = (await import(join(dist, 'index.js'))) as typeof import('../src/index.js');
    const s = await snapshotClient({ 'agents/a': { text: 'Do A.', version: 1 } });
    for (const m of [cjs, esm]) expect(m.kypAgents(s.client)).toEqual({ a: { description: 'Do A.', prompt: 'Do A.' } });
    await s.cleanup();
  });
});
