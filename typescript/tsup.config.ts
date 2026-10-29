import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts', otel: 'src/otel.ts' },
    // @opentelemetry/api is an optional peer dependency: never bundled.
    external: ['@opentelemetry/api'],
    format: ['esm', 'cjs'],
    dts: true,
    target: 'es2022',
    platform: 'neutral',
    sourcemap: true,
    treeshake: true,
  },
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    target: 'es2022',
    platform: 'node',
    banner: { js: '#!/usr/bin/env node' },
  },
]);
