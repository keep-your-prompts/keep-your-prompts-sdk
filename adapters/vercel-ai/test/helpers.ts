// Real `@keepyourprompts/sdk` clients over the shared conformance fixtures: no network, no fakes.
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@keepyourprompts/sdk';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = resolve(here, '../../../conformance/fixtures');

/** A client on fixture v12 (greeting v4, triage v7, agents/reviewer v2, empty v1). */
export function fixtureClient(): Promise<Client> {
  return Client.create({ app: 'demo', snapshotDir: join(FIXTURES, 'v12'), logLevel: 'off', autoRefresh: false });
}

/** A client on a writable copy of v12; `deploy('v13')` swaps the folder so the next `refresh()` sees v13. */
export async function liveClient(): Promise<{ client: Client; deploy(fixture: string): void; cleanup(): Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'kyp-adapter-'));
  cpSync(join(FIXTURES, 'v12'), dir, { recursive: true });
  const client = await Client.create({ app: 'demo', snapshotDir: dir, logLevel: 'off', autoRefresh: false });
  return {
    client,
    deploy(fixture) {
      cpSync(join(FIXTURES, fixture), dir, { recursive: true });
    },
    async cleanup() {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
