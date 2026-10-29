import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { main as cli } from '../src/cli.js';
import {
  Client,
  KypError,
  MissingVariableError,
  NotFoundError,
  UnavailableError,
  type EmbeddedSnapshot,
} from '../src/index.js';
import { FakeCdn, FIXTURES, KEY, TempDir, netOptions, routes } from './helpers.js';

let cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f();
  cleanup = [];
});
function track<T>(x: T): T {
  const o = x as { close?: () => unknown; stop?: () => unknown; remove?: () => unknown };
  cleanup.push(() => (o.close ? o.close() : o.stop ? o.stop() : o.remove?.()));
  return x;
}

function fixtureSnapshot(name: string): EmbeddedSnapshot {
  const dir = join(FIXTURES, name);
  const files: Record<string, string> = {
    'envs/demo/prod.json': readFileSync(join(dir, 'envs/demo/prod.json'), 'utf8'),
  };
  for (const b of readdirSync(join(dir, 'blobs'))) files[`blobs/${b}`] = readFileSync(join(dir, 'blobs', b), 'utf8');
  return { kyp: 1, files };
}

describe('client', () => {
  it('starts from an embedded snapshot with zero network and exports it back', async () => {
    const snap = fixtureSnapshot('v12');
    const c = track(await Client.create({ app: 'demo', embeddedSnapshot: snap, logLevel: 'off' }));
    expect(c.status().source).toBe('embedded');
    expect(c.prompt('greeting').version).toBe(4);
    expect(c.toSnapshot()!.files).toEqual(snap.files);
    expect(await c.refresh()).toBe(false); // nothing to poll
  });

  it('rejects an embedded snapshot whose blob does not match its hash', async () => {
    const snap = fixtureSnapshot('tampered-v14');
    await expect(Client.create({ app: 'demo', embeddedSnapshot: snap, logLevel: 'off' })).rejects.toBeInstanceOf(
      UnavailableError,
    );
  });

  it('prefers the newest local copy: a fresher disk cache beats an older snapshot', async () => {
    const t = track(new TempDir());
    t.fixture('v13', 'cache', 'acme', 'demo', 'prod');
    const c = track(
      await Client.create({ app: 'demo', snapshotDir: join(FIXTURES, 'v12'), cacheDir: t.join('cache'), logLevel: 'off' }),
    );
    expect(c.revision).toBe(13);
    expect(c.status().source).toBe('disk-cache');
  });

  it('polls the snapshot folder when no network mirror is configured', async () => {
    const t = track(new TempDir());
    const dir = t.fixture('v12', 'snap');
    const c = track(await Client.create({ app: 'demo', snapshotDir: dir, logLevel: 'off', autoRefresh: false }));
    t.fixture('v13', 'snap');
    expect(await c.refresh()).toBe(true);
    expect(c.revision).toBe(13);
  });

  it('fetches a blob from another mirror when one is tampered', async () => {
    const t = track(new TempDir());
    const bad = t.fixture('v13', 'bad');
    writeFileSync(join(bad, 'blobs/a413e0e86cf132f04fbac888b900733641d384cd0e9b42fd0042cf6942701cf2'), 'evil');
    const s = track(await FakeCdn.start(routes({ cdn: bad, origin: join(FIXTURES, 'v13') })));
    const warnings: string[] = [];
    const c = track(
      await Client.create({
        ...netOptions(s),
        logLevel: 'warn',
        logger: (_, m) => warnings.push(m),
      }),
    );
    expect(c.prompt('greeting').version).toBe(5);
    expect(c.get('greeting')).toBe('Hi {{name}}! {{company}} is glad you are here.');
    expect(c.status().source).toBe('cdn');
    expect(warnings.some((w) => w.includes('failed sha256 verification'))).toBe(true);
  });

  it('times out at start-up without a local copy, or starts empty and recovers', async () => {
    const s = track(await FakeCdn.start(routes({ cdn: join(FIXTURES, 'v12'), origin: join(FIXTURES, 'v12') })));
    await s.ctl('/__down/cdn');
    await s.ctl('/__down/origin');
    const start = Date.now();
    await expect(Client.create({ ...netOptions(s), startupTimeout: 400 })).rejects.toThrow(/HTTP 503|timed out|deadline exceeded/);
    const took = Date.now() - start;
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(2000);

    const c = track(await Client.create({ ...netOptions(s), startupTimeout: 200, startEmpty: true }));
    expect(c.status().ready).toBe(false);
    expect(c.tryGet('greeting')).toBeUndefined();
    expect(() => c.get('greeting')).toThrow(NotFoundError);
    await s.ctl('/__up/origin');
    expect(await c.refresh()).toBe(true);
    expect(c.status().source).toBe('origin');
    expect(c.prompt('greeting').version).toBe(4);
  });

  it('throws when nothing is configured', async () => {
    await expect(Client.create({ app: 'demo', logLevel: 'off' })).rejects.toBeInstanceOf(UnavailableError);
    const empty = await Client.create({ app: 'demo', logLevel: 'off', startEmpty: true });
    expect(empty.status().ready).toBe(false);
    await expect(Client.create({ app: 'Bad App' })).rejects.toBeInstanceOf(KypError);
    await expect(Client.create({ app: 'demo', deliveryKey: 'kypd_x/../y' })).rejects.toThrow(/invalid character/);
  });

  it('backs off a failing mirror between timer rounds', async () => {
    const v12 = join(FIXTURES, 'v12');
    const s = track(await FakeCdn.start(routes({ cdn: v12, origin: v12 })));
    const c = track(await Client.create({ ...netOptions(s), autoRefresh: true, pollInterval: 100, maxBackoff: 10_000 }));
    await s.ctl('/__down/cdn');
    await new Promise((r) => setTimeout(r, 1500));
    const st = await s.stats();
    // ~14 rounds: origin answers each one; cdn is tried after 0, 1, 3, 7 intervals only.
    expect(st.origin!['200'] + st.origin!['304']).toBeGreaterThanOrEqual(8);
    expect(st.cdn!['503']).toBeLessThanOrEqual(5);
    expect(c.status().mirrors.find((m) => m.name === 'cdn')!.consecutiveFailures).toBeGreaterThanOrEqual(2);
  });

  it('renders with options and exposes prompt objects', async () => {
    const c = track(await Client.create({ app: 'demo', snapshotDir: join(FIXTURES, 'v12'), logLevel: 'off' }));
    expect(() => c.render('greeting', { name: 'Ana' })).toThrow(MissingVariableError);
    expect(c.render('greeting', { name: 'Ana' }, { strict: false })).toBe('Hello Ana, welcome to {{ company }}.');
    expect(c.render('greeting', { name: 'Ana' }, { onMissing: 'empty' })).toBe('Hello Ana, welcome to .');
    const p = c.prompt('greeting');
    expect(p).toMatchObject({ name: 'greeting', version: 4, variables: ['name', 'company'] });
    expect(p.sha256).toBe('5d3d1a279222fe6f5711f3ce5ac7a3fd351c9a843d3c1aa4b107a365909dfc0d');
    expect(p.render({ name: 'Ana', company: 7 })).toBe('Hello Ana, welcome to 7.');
    expect(Object.isFrozen(p)).toBe(true);
    expect(c.names().sort()).toEqual(['agents/reviewer', 'empty', 'greeting', 'triage']);
    expect(c.has('agents/reviewer')).toBe(true);
    expect(() => c.prompt('nope')).toThrow(/prompt not found: "nope" \(demo\/prod revision 12\)/);
  });

  it('reads options from an env object (e.g. a Workers binding)', async () => {
    const o = Client.optionsFromEnv({
      KYP_APP: 'demo',
      KYP_ENV: 'staging',
      KYP_DELIVERY_KEY: KEY,
      KYP_POLL_INTERVAL: '2.5',
      KYP_GIT_MIRROR: 'https://raw.githubusercontent.com/acme/prompts/main/.kyp',
      KYP_GIT_TOKEN: 't',
      KYP_LOG: 'off',
    });
    expect(o).toMatchObject({ app: 'demo', env: 'staging', deliveryKey: KEY, pollInterval: 2500, gitToken: 't', logLevel: 'off' });
    const c = track(await Client.fromEnv({ KYP_APP: 'demo', KYP_SNAPSHOT_DIR: join(FIXTURES, 'v12'), KYP_LOG: 'off' }));
    expect(c.revision).toBe(12);
  });
});

describe('outcomes', () => {
  function fakeApi(status = 202) {
    const calls: { url: string; init: RequestInit }[] = [];
    let fail = false;
    const f = async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        calls.push({ url, init: init! });
        if (fail) throw new Error('network down');
        return new Response(null, { status });
      }
      return fetch(url, init);
    };
    return { calls, f, setFail: (v: boolean) => (fail = v) };
  }

  it('buffers reports and posts them to the API with the API key', async () => {
    const api = fakeApi();
    const c = await Client.create({
      app: 'demo',
      snapshotDir: join(FIXTURES, 'v12'),
      logLevel: 'off',
      apiKey: 'kyp_live_secret',
      apiUrl: 'https://api.example.test/',
      fetch: api.f,
    });
    c.report({ prompt: 'greeting', outcome: 'success', latencyMs: 812.4, inputTokens: 120, outputTokens: 40 });
    c.report({ prompt: 'triage', outcome: 'feedback_negative' });
    c.report({ prompt: 'greeting', outcome: 'meh' as never }); // dropped: unknown outcome
    c.report({ prompt: 'unknown', outcome: 'failure' }); // dropped: not deployed
    expect(api.calls).toHaveLength(0);
    await c.close(); // flushes
    expect(api.calls).toHaveLength(1);
    const { url, init } = api.calls[0]!;
    expect(url).toBe('https://api.example.test/v1/apps/demo/outcomes');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer kyp_live_secret');
    expect(JSON.parse(init.body as string)).toEqual([
      {
        env: 'prod',
        prompt: 'greeting',
        sha256: '5d3d1a279222fe6f5711f3ce5ac7a3fd351c9a843d3c1aa4b107a365909dfc0d',
        outcome: 'success',
        latencyMs: 812,
        inputTokens: 120,
        outputTokens: 40,
      },
      { env: 'prod', prompt: 'triage', sha256: 'f31befda9f5a0fed97bb07f8164baf8673f4342fcca9ad37d59dafaacefc53bf', outcome: 'feedback_negative' },
    ]);
  });

  it('is fail-silent and bounded', async () => {
    const api = fakeApi();
    api.setFail(true);
    const c = track(
      await Client.create({
        app: 'demo',
        snapshotDir: join(FIXTURES, 'v12'),
        logLevel: 'off',
        apiKey: 'k',
        fetch: api.f,
        outcomeBufferSize: 3,
        outcomeFlushInterval: 0,
      }),
    );
    for (let i = 0; i < 5; i++) c.report({ prompt: 'greeting', outcome: 'success', latencyMs: i });
    await c.flush(); // fails, keeps the newest 3
    expect(api.calls).toHaveLength(1);
    api.setFail(false);
    await c.flush();
    const sent = JSON.parse(api.calls[1]!.init.body as string) as { latencyMs: number }[];
    expect(sent.map((e) => e.latencyMs)).toEqual([2, 3, 4]);
  });

  it('is a no-op without an API key', async () => {
    const api = fakeApi();
    const c = track(await Client.create({ app: 'demo', snapshotDir: join(FIXTURES, 'v12'), logLevel: 'off', fetch: api.f }));
    c.report({ prompt: 'greeting', outcome: 'success' });
    await c.flush();
    expect(api.calls).toHaveLength(0);
  });
});

describe('snapshot CLI', () => {
  it('writes a folder and a module that clients start from offline', async () => {
    const t = track(new TempDir());
    const s = track(await FakeCdn.start(routes({ cdn: join(FIXTURES, 'v13') })));
    const common = ['--app', 'demo', '--key', KEY, '--cdn', `${s.base}/v1/d`, '--origin', `${s.base}/v1/delivery`, '-q'];
    expect(await cli(['snapshot', ...common, '--out', t.join('folder')])).toBe(0);
    expect(existsSync(t.join('folder/envs/demo/prod.json'))).toBe(true);
    const offline = track(await Client.create({ app: 'demo', snapshotDir: t.join('folder'), logLevel: 'off' }));
    expect(offline.revision).toBe(13);

    expect(await cli(['snapshot', ...common, '--format', 'module', '--out', t.join('prompts')])).toBe(0);
    expect(readFileSync(t.join('prompts.d.mts'), 'utf8')).toContain('EmbeddedSnapshot');
    const mod = (await import(pathToFileURL(t.join('prompts.mjs')).href)) as { default: EmbeddedSnapshot };
    const edge = track(await Client.create({ app: 'demo', embeddedSnapshot: mod.default, logLevel: 'off' }));
    expect(edge.prompt('greeting').version).toBe(5);
    expect(edge.status().source).toBe('embedded');

    expect(await cli(['snapshot', ...common, '--format', 'module', '--out', t.join('p.ts')])).toBe(0);
    expect(readFileSync(t.join('p.ts'), 'utf8')).toContain('const snapshot: EmbeddedSnapshot =');
  });

  it('fails loudly on bad arguments or unreachable mirrors', async () => {
    const err = console.error;
    console.error = () => undefined;
    try {
      expect(await cli(['snapshot', '--app', 'demo'])).toBe(2);
      expect(await cli(['snapshot', '--app', 'demo', '--out', 'x', '--format', 'zip'])).toBe(2);
      expect(await cli(['nope'])).toBe(2);
      expect(
        await cli(['snapshot', '--app', 'demo', '--out', 'x', '--mirror', 'http://127.0.0.1:9/x', '--timeout', '0.3']),
      ).toBe(1);
    } finally {
      console.error = err;
    }
  });
});
