// The 12 required behaviours of conformance/README.md, with its exact fixtures.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Client,
  MissingVariableError,
  ProtocolError,
  parseManifest,
  renderTemplate,
  sha256Hex,
  templateVariables,
  type Update,
} from '../src/index.js';
import { CONFORMANCE, FakeCdn, FIXTURES, KEY, TempDir, netOptions, routes } from './helpers.js';

interface Cases {
  render: { template: string; vars: Record<string, string>; out?: string; error?: string; variable?: string; lenient?: boolean }[];
  variables: { template: string; out: string[] }[];
  manifest: { file?: string; json?: unknown; valid: boolean; prompts?: string[] }[];
  sha256: { in: string; out: string }[];
}
const cases = JSON.parse(readFileSync(join(CONFORMANCE, 'cases.json'), 'utf8')) as Cases;

const GREETING_V4 = 'Hello {{name}}, welcome to {{ company }}.';
const GREETING_V5 = 'Hi {{name}}! {{company}} is glad you are here.';

let cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f();
  cleanup = [];
});
const track = <T extends { close(): unknown } | { stop(): unknown } | TempDir>(x: T): T => {
  cleanup.push(() => ('close' in x ? x.close() : 'stop' in x ? x.stop() : (x as TempDir).remove()));
  return x;
};

describe('1. render', () => {
  it.each(cases.render.map((c, i) => [i, c] as const))('case %i', (_, c) => {
    if (c.error) {
      expect(c.error).toBe('missing_variable');
      try {
        renderTemplate(c.template, c.vars);
        expect.fail('expected MissingVariableError');
      } catch (e) {
        expect(e).toBeInstanceOf(MissingVariableError);
        expect((e as MissingVariableError).names).toEqual([c.variable]);
      }
    } else {
      expect(renderTemplate(c.template, c.vars, { strict: !c.lenient })).toBe(c.out);
    }
  });
});

describe('2. variables', () => {
  it.each(cases.variables)('$template', (c) => {
    expect(templateVariables(c.template)).toEqual(c.out);
  });
});

describe('3. manifest', () => {
  it.each(cases.manifest.map((c, i) => [i, c] as const))('case %i', (_, c) => {
    const input = c.file ? readFileSync(join(CONFORMANCE, c.file), 'utf8') : c.json;
    if (!c.valid) {
      expect(() => parseManifest(input)).toThrow(ProtocolError);
      return;
    }
    const m = parseManifest(input);
    if (c.prompts) expect(Object.keys(m.prompts).sort()).toEqual(c.prompts);
    for (const p of Object.values(m.prompts)) expect(Array.isArray(p.variables)).toBe(true);
  });
  it('variables default to []', () => {
    const m = parseManifest(cases.manifest[3]!.json);
    expect(m.prompts.p!.variables).toEqual([]);
  });
  it.each(cases.sha256)('sha256($in)', async (c) => {
    expect(await sha256Hex(c.in)).toBe(c.out);
  });
});

describe('mirrors', () => {
  it('4. hash check: tampered-v14 is refused and 12 is kept', async () => {
    const t = track(new TempDir());
    const s = track(await FakeCdn.start(routes({ cdn: join(FIXTURES, 'tampered-v14'), origin: join(FIXTURES, 'tampered-v14') })));
    const c = track(await Client.create({ ...netOptions(s), snapshotDir: join(FIXTURES, 'v12'), cacheDir: t.join('cache') }));
    expect(c.revision).toBe(12);
    expect(await c.refresh()).toBe(false);
    expect(c.revision).toBe(12);
    expect(c.prompt('greeting').version).toBe(4);
    expect(c.status().lastError).toMatch(/failed sha256 verification/);

    // Nothing local: the tampered manifest is never served.
    const fresh = Client.create({ ...netOptions(s), startupTimeout: 300 });
    await expect(fresh).rejects.toThrow(/sha256/);
  });

  it('5. start from local: snapshot v12 and no network', async () => {
    const start = Date.now();
    const c = track(
      await Client.create({
        app: 'demo',
        deliveryKey: KEY,
        cdnUrl: 'http://127.0.0.1:9/v1/d',
        originUrl: 'http://127.0.0.1:9/v1/delivery',
        snapshotDir: join(FIXTURES, 'v12'),
        logLevel: 'off',
      }),
    );
    expect(Date.now() - start).toBeLessThan(500);
    const p = c.prompt('greeting');
    expect(p.version).toBe(4);
    expect(p.text).toBe(GREETING_V4);
    expect(c.render('greeting', { name: 'Ana', company: 'Acme' })).toBe('Hello Ana, welcome to Acme.');
    expect(c.status().source).toBe('snapshot');
    expect(c.get('triage')).toContain('{{{{braces}}');
    expect(c.render('triage', { company: 'Acme' })).toBe('You are a support agent for Acme. Literal {{braces}} stay.');
    expect(c.get('agents/reviewer')).toBe('Review the diff.');
    expect(c.get('empty')).toBe('');
  });

  it('6. mirror order: CDN, then origin, then git with a bearer token', async () => {
    const v12 = join(FIXTURES, 'v12');
    const s = track(await FakeCdn.start(routes({ cdn: v12, origin: v12, git: v12 })));
    const c = track(
      await Client.create({ ...netOptions(s), gitMirror: `${s.base}/acme/prompts/main/.kyp`, gitToken: 'github_pat_test' }),
    );
    expect(c.status().source).toBe('cdn');
    let st = await s.stats();
    expect(st.origin!['200']).toBe(0);
    expect(st.git!['200']).toBe(0);

    await s.ctl('/__down/cdn');
    expect(await c.refresh()).toBe(true);
    expect(c.status().source).toBe('origin');
    expect(c.status().lastError).toContain('cdn: HTTP 503');

    await s.ctl('/__down/origin');
    expect(await c.refresh()).toBe(true);
    expect(c.status().source).toBe('git');
    st = await s.stats();
    expect(st.git!.auth).toBe('Bearer github_pat_test');
    expect(st.cdn!.auth).toBeNull(); // the delivery key travels in the path
    expect(c.prompt('greeting').version).toBe(4);
    for (const m of c.status().mirrors) expect(m.url).not.toContain(KEY);

    await s.ctl('/__up/cdn');
    expect(await c.refresh()).toBe(true);
    expect(c.status().source).toBe('cdn');
    expect(c.status().lastError).toBe('');
  });

  it('7. revalidation: the second poll sends If-None-Match and a 304 changes nothing', async () => {
    const s = track(await FakeCdn.start(routes({ cdn: join(FIXTURES, 'v12') })));
    const updates: Update[] = [];
    const c = track(await Client.create({ ...netOptions(s), onUpdate: (u) => updates.push(u) }));
    const before = c.prompt('greeting');
    expect((await s.stats()).cdn!['200']).toBeGreaterThan(0);
    expect(await c.refresh()).toBe(true);
    expect(await c.refresh()).toBe(true);
    expect((await s.stats()).cdn!['304']).toBe(2);
    expect(c.prompt('greeting')).toBe(before); // the very same object: nothing was swapped
    expect(updates).toEqual([]);
    expect(c.status().lastSuccess).toBeInstanceOf(Date);
  });

  it('8. hot update: v12 -> v13 after one refresh, callback once', async () => {
    const t = track(new TempDir());
    const srv = t.fixture('v12', 'srv');
    const s = track(await FakeCdn.start(routes({ cdn: srv, origin: srv })));
    const updates: Update[] = [];
    const c = track(await Client.create({ ...netOptions(s) }));
    c.onUpdate((u) => updates.push(u));
    expect(c.prompt('greeting').version).toBe(4);
    t.fixture('v13', 'srv'); // deploy
    expect(await c.refresh()).toBe(true);
    expect(c.prompt('greeting').version).toBe(5);
    expect(c.get('greeting')).toBe(GREETING_V5);
    expect(updates).toEqual([{ oldRevision: 12, newRevision: 13, source: 'cdn', changed: ['greeting'] }]);
    expect(await c.refresh()).toBe(true);
    expect(updates).toHaveLength(1);
  });

  it('8b. hot update through the background timer', async () => {
    const t = track(new TempDir());
    const srv = t.fixture('v12', 'srv');
    const s = track(await FakeCdn.start(routes({ cdn: srv })));
    let calls = 0;
    const c = track(await Client.create({ ...netOptions(s), autoRefresh: true, pollInterval: 100, onUpdate: () => calls++ }));
    t.fixture('v13', 'srv');
    const end = Date.now() + 5000;
    while (c.revision !== 13 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(c.revision).toBe(13);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(1);
  });

  it('9. stale mirror: v11-stale never replaces revision 12', async () => {
    const stale = join(FIXTURES, 'v11-stale');
    const s = track(await FakeCdn.start(routes({ cdn: stale, origin: stale })));
    const c = track(await Client.create({ ...netOptions(s), snapshotDir: join(FIXTURES, 'v12') }));
    expect(await c.refresh()).toBe(false);
    expect(c.revision).toBe(12);
    expect(c.prompt('greeting').version).toBe(4);
    expect(c.status().lastError).toMatch(/stale manifest ignored \(revision 11 < held 12\)/);
  });

  it('10. failures never evict', async () => {
    const v12 = join(FIXTURES, 'v12');
    const s = track(await FakeCdn.start(routes({ cdn: v12, origin: v12 })));
    const c = track(await Client.create({ ...netOptions(s) }));
    await s.ctl('/__down/cdn');
    await s.ctl('/__down/origin');
    await new Promise((r) => setTimeout(r, 30));
    for (let i = 0; i < 3; i++) expect(await c.refresh()).toBe(false);
    expect(c.get('greeting')).toBe(GREETING_V4);
    const st = c.status();
    expect(st.ready).toBe(true);
    expect(st.revision).toBe(12);
    expect(st.lastError).toContain('cdn: HTTP 503');
    expect(st.lastError).toContain('origin: HTTP 503');
    expect(st.staleForMs).toBeGreaterThanOrEqual(25);
    expect(st.mirrors.find((m) => m.name === 'cdn')!.consecutiveFailures).toBe(3);
  });

  it('11. disk cache: a new client with only the cache starts from it', async () => {
    const t = track(new TempDir());
    const s = track(await FakeCdn.start(routes({ cdn: join(FIXTURES, 'v12') })));
    const first = await Client.create({ ...netOptions(s), cacheDir: t.join('cache') });
    await first.close();
    expect(readFileSync(t.join('cache/acme/demo/prod/envs/demo/prod.json'), 'utf8')).toContain('"revision": 12');

    const start = Date.now();
    const c = track(await Client.create({ app: 'demo', cacheDir: t.join('cache'), logLevel: 'off' }));
    expect(Date.now() - start).toBeLessThan(500);
    expect(c.status().source).toBe('disk-cache');
    expect(c.prompt('greeting').version).toBe(4);
    expect(c.get('agents/reviewer')).toBe('Review the diff.');
  });

  it('12. read path: no I/O, safe from many tasks at once', async () => {
    const t = track(new TempDir());
    const srv = t.fixture('v12', 'srv');
    const s = track(await FakeCdn.start(routes({ cdn: srv })));
    let requests = 0;
    const counting = (u: string, i?: RequestInit) => {
      requests++;
      return fetch(u, i);
    };
    const c = track(await Client.create({ ...netOptions(s), fetch: counting, cacheDir: t.join('cache') }));
    const before = requests;
    for (let i = 0; i < 10_000; i++) c.get('greeting');
    expect(requests).toBe(before);
    expect(typeof c.get('greeting')).toBe('string'); // synchronous, no promise

    // Many tasks read while the state flips between v12 and v13: each read sees a whole state.
    let stop = false;
    const seen = new Set<string>();
    const readers = Array.from({ length: 50 }, async () => {
      while (!stop) {
        const p = c.prompt('greeting');
        expect(p.text).toBe(p.version === 4 ? GREETING_V4 : GREETING_V5);
        seen.add(c.get('greeting'));
        await Promise.resolve();
        await new Promise((r) => setImmediate(r));
      }
    });
    t.fixture('v13', 'srv');
    await c.refresh();
    stop = true;
    await Promise.all(readers);
    expect(c.prompt('greeting').version).toBe(5);
    expect([...seen].every((x) => x === GREETING_V4 || x === GREETING_V5)).toBe(true);
  });
});
