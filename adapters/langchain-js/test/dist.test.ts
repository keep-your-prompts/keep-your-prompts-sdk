// Smoke test of the built package (ESM and CJS entry points). Skipped before `npm run build`.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fixtureClient } from './helpers.js';

const dist = fileURLToPath(new URL('../dist', import.meta.url));
const built = existsSync(join(dist, 'index.cjs'));

describe.skipIf(!built)('dist', () => {
  it('loads as CommonJS and ESM', async () => {
    const cjs = createRequire(import.meta.url)(join(dist, 'index.cjs')) as typeof import('../src/index.js');
    const esm = (await import(join(dist, 'index.js'))) as typeof import('../src/index.js');
    const prompts = await fixtureClient();
    for (const m of [cjs, esm]) {
      expect(m.loadPromptTemplate(prompts, "triage").metadata).toMatchObject({ "kyp.prompt.version": 7 });
      expect(m.toFString("{{a}}").template).toBe("{a}");
    }
    await prompts.close();
  });
});
