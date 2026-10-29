// Real `@keepyourprompts/sdk` clients over snapshot folders written by the tests: no network, no fakes.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@keepyourprompts/sdk';

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'kyp-claude-'));
}

/** Write a snapshot folder (protocol layout, app `demo`, env `prod`) holding `prompts` at `revision`. */
export function writeSnapshot(dir: string, prompts: Record<string, { text: string; version: number }>, revision: number): void {
  mkdirSync(join(dir, 'envs', 'demo'), { recursive: true });
  mkdirSync(join(dir, 'blobs'), { recursive: true });
  const manifest: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(prompts)) {
    const sha = createHash('sha256').update(p.text, 'utf8').digest('hex');
    writeFileSync(join(dir, 'blobs', sha), p.text);
    manifest[name] = { sha256: sha, version: p.version, variables: [] };
  }
  writeFileSync(
    join(dir, 'envs', 'demo', 'prod.json'),
    JSON.stringify({ schema: 1, workspace: 'acme', app: 'demo', env: 'prod', revision, deployed_at: '2026-10-29T09:00:00Z', prompts: manifest }),
  );
}

export async function snapshotClient(prompts: Record<string, { text: string; version: number }>) {
  const dir = tempDir();
  let revision = 1;
  writeSnapshot(dir, prompts, revision);
  const client = await Client.create({ app: 'demo', snapshotDir: dir, logLevel: 'off', autoRefresh: false });
  return {
    client,
    async deploy(next: Record<string, { text: string; version: number }>) {
      writeSnapshot(dir, next, ++revision);
      await client.refresh();
    },
    async cleanup() {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
