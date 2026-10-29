// protocol/tracing.md conformance checklist, with in-memory OpenTelemetry exporters.
import { join } from 'node:path';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  AggregationTemporality,
  DataPointType,
  MeterProvider,
  MetricReader,
  type MetricData,
} from '@opentelemetry/sdk-metrics';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client, MissingVariableError } from '../src/index.js';
import { annotate, instrument } from '../src/otel.js';
import { FakeCdn, FIXTURES, TempDir, netOptions, routes } from './helpers.js';

const GREETING_SHA = '5d3d1a279222fe6f5711f3ce5ac7a3fd351c9a843d3c1aa4b107a365909dfc0d';

class TestReader extends MetricReader {
  constructor() {
    super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE });
  }
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
  async metrics(): Promise<Map<string, MetricData>> {
    const { resourceMetrics } = await this.collect();
    const out = new Map<string, MetricData>();
    for (const sm of resourceMetrics.scopeMetrics) {
      expect(sm.scope.name).toBe('keepyourprompts');
      for (const m of sm.metrics) out.set(m.descriptor.name, m);
    }
    return out;
  }
}

let ctxManager: AsyncLocalStorageContextManager;
beforeAll(() => {
  ctxManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(ctxManager);
});
afterAll(() => {
  context.disable();
});

let cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f();
  cleanup = [];
});
function track<T>(x: T): T {
  const o = x as { close?: () => unknown; stop?: () => unknown; remove?: () => unknown; shutdown?: () => unknown };
  cleanup.push(() => (o.close ? o.close() : o.stop ? o.stop() : o.remove ? o.remove() : o.shutdown?.()));
  return x;
}

function setup() {
  const exporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const reader = new TestReader();
  const meterProvider = new MeterProvider({ readers: [reader] });
  cleanup.push(() => meterProvider.shutdown());
  const tracer = tracerProvider.getTracer('app');
  const refreshSpans = () => exporter.getFinishedSpans().filter((s) => s.name === 'kyp.refresh');
  return { exporter, tracerProvider, meterProvider, reader, tracer, refreshSpans };
}

/** Run `fn` inside an active "llm.call" span and return the finished span. */
function inSpan(t: ReturnType<typeof setup>, fn: () => void): ReadableSpan {
  t.tracer.startActiveSpan('llm.call', (span) => {
    fn();
    span.end();
  });
  return t.exporter.getFinishedSpans().find((s) => s.name === 'llm.call')!;
}

const ev = (s: ReadableSpan, name: string) => s.events.filter((e) => e.name === name);

describe('prompt metadata', () => {
  it('meta() and renderWithMeta() describe the body used', async () => {
    const c = track(await Client.create({ app: 'demo', snapshotDir: join(FIXTURES, 'v12'), logLevel: 'off' }));
    const m = c.meta('greeting');
    expect({ ...m.attributes() }).toEqual({
      'kyp.prompt.name': 'greeting',
      'kyp.prompt.version': 4,
      'kyp.prompt.sha256': GREETING_SHA,
      'kyp.app': 'demo',
      'kyp.env': 'prod',
      'kyp.revision': 12,
      'kyp.workspace': 'acme',
      'kyp.source': 'snapshot',
      'gen_ai.prompt.name': 'greeting',
      'gen_ai.prompt.version': '4',
    });
    const r = c.renderWithMeta('greeting', { name: 'Ada', company: 'Acme' });
    expect(r.text).toBe('Hello Ada, welcome to Acme.');
    expect(r.meta.sha256).toBe(GREETING_SHA);
    expect(r.meta.version).toBe(4);
    expect(() => c.meta('nope')).toThrow();
  });

  it('metadata maps use flat kyp_ keys and never content', async () => {
    const c = track(await Client.create({ app: 'demo', snapshotDir: join(FIXTURES, 'v12'), logLevel: 'off' }));
    const want = {
      kyp_prompt_name: 'triage',
      kyp_prompt_version: 7,
      kyp_prompt_sha256: 'f31befda9f5a0fed97bb07f8164baf8673f4342fcca9ad37d59dafaacefc53bf',
      kyp_app: 'demo',
      kyp_env: 'prod',
      kyp_revision: 12,
      kyp_workspace: 'acme',
      kyp_source: 'snapshot',
    };
    const m = c.meta('triage');
    expect(m.traceMetadata()).toEqual(want);
    expect(m.langfuseMetadata()).toEqual(want);
    expect(m.langsmithMetadata()).toEqual(want);
  });

  it('report() with metadata sends that body, even after an update', async () => {
    const t = track(new TempDir());
    const srv = t.fixture('v12', 'srv');
    const s = track(await FakeCdn.start(routes({ cdn: srv })));
    const posts: string[] = [];
    const f = async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push(init.body as string);
        return new Response(null, { status: 202 });
      }
      return fetch(url, init);
    };
    const c = await Client.create({ ...netOptions(s), apiKey: 'kyp_live_x', apiUrl: 'https://api.example.test', fetch: f });
    const used = c.renderWithMeta('greeting', { name: 'A', company: 'B' });
    t.fixture('v13', 'srv');
    await c.refresh();
    expect(c.prompt('greeting').version).toBe(5);
    c.report({ prompt: used, outcome: 'success', latencyMs: 5 });
    c.report({ prompt: used.meta, outcome: 'failure' });
    await c.close();
    const sent = JSON.parse(posts[0]!) as { prompt: string; sha256: string }[];
    expect(sent.map((e) => [e.prompt, e.sha256])).toEqual([
      ['greeting', GREETING_SHA],
      ['greeting', GREETING_SHA],
    ]);
  });
});

describe('annotate', () => {
  it('sets kyp.* and gen_ai.prompt.* on the active span, and no content by default', async () => {
    const t = setup();
    const c = track(await Client.create({ app: 'demo', snapshotDir: join(FIXTURES, 'v12'), logLevel: 'off' }));
    const otel = track(instrument(c, { tracerProvider: t.tracerProvider, meterProvider: t.meterProvider }));
    const span = inSpan(t, () => {
      const meta = otel.annotate('greeting', { variables: { name: 'Ada' } });
      expect(meta.version).toBe(4);
    });
    expect(span.attributes).toEqual({
      'kyp.prompt.name': 'greeting',
      'kyp.prompt.version': 4,
      'kyp.prompt.sha256': GREETING_SHA,
      'kyp.app': 'demo',
      'kyp.env': 'prod',
      'kyp.revision': 12,
      'kyp.workspace': 'acme',
      'kyp.source': 'snapshot',
      'gen_ai.prompt.name': 'greeting',
      'gen_ai.prompt.version': '4',
    });
  });

  it('captureContent adds the template and variables; openInference adds aliases', async () => {
    const t = setup();
    const c = track(await Client.create({ app: 'demo', snapshotDir: join(FIXTURES, 'v12'), logLevel: 'off' }));
    const otel = track(
      instrument(c, {
        tracerProvider: t.tracerProvider,
        meterProvider: t.meterProvider,
        captureContent: true,
        openInference: true,
      }),
    );
    const span = inSpan(t, () => {
      const r = c.renderWithMeta('greeting', { name: 'Ada', company: 'Acme' });
      otel.annotate(r, { variables: { name: 'Ada', company: 'Acme' } });
    });
    expect(span.attributes['kyp.prompt.template']).toBe('Hello {{name}}, welcome to {{ company }}.');
    expect(span.attributes['gen_ai.prompt.variable.name']).toBe('Ada');
    expect(span.attributes['gen_ai.prompt.variable.company']).toBe('Acme');
    expect(span.attributes['prompt.vendor']).toBe('keepyourprompts');
    expect(span.attributes['prompt.id']).toBe('demo/prod/greeting');
    expect(span.attributes['llm.prompt_template.version']).toBe('4');
    expect(JSON.parse(span.attributes['llm.prompt_template.variables'] as string)).toEqual({ name: 'Ada', company: 'Acme' });
  });

  it('works on an explicit span, without instrument(), and without gen_ai attributes', async () => {
    const t = setup();
    const c = track(await Client.create({ app: 'demo', snapshotDir: join(FIXTURES, 'v12'), logLevel: 'off' }));
    const span = t.tracer.startSpan('explicit');
    annotate(c.meta('triage'), { span, genAiAttributes: false, variables: { company: 'x' } });
    span.end();
    const done = t.exporter.getFinishedSpans()[0]!;
    expect(done.attributes['kyp.prompt.version']).toBe(7);
    expect(done.attributes['gen_ai.prompt.name']).toBeUndefined();
    expect(done.attributes['gen_ai.prompt.variable.company']).toBeUndefined();
    // No active span: a no-op that still returns the metadata.
    expect(annotate(c.meta('triage')).name).toBe('triage');
    expect(trace.getActiveSpan()).toBeUndefined();
  });
});

describe('SDK spans and metrics', () => {
  it('start-up with a failing CDN: fallback, update, metrics', async () => {
    const t = setup();
    const s = track(await FakeCdn.start(routes({ cdn: join(FIXTURES, 'v12'), origin: join(FIXTURES, 'v12') })));
    await s.ctl('/__down/cdn');
    const c = track(await Client.create({ ...netOptions(s), startEmpty: true }));
    // The start-up round happened before instrument(): observe it through the option too.
    const otel = track(instrument(c, { tracerProvider: t.tracerProvider, meterProvider: t.meterProvider }));
    expect(c.revision).toBe(12);

    // Manual refresh: CDN still down, origin answers 304 -> a round with a fallback event is traced.
    expect(await c.refresh()).toBe(true);
    const [span] = t.refreshSpans();
    expect(span).toBeDefined();
    expect(span!.attributes).toMatchObject({
      'kyp.app': 'demo',
      'kyp.env': 'prod',
      'kyp.refresh.trigger': 'manual',
      'kyp.refresh.result': 'not_modified',
      'kyp.revision': 12,
      'kyp.workspace': 'acme',
      'kyp.source': 'origin',
      'kyp.mirror': 'origin',
    });
    const fb = ev(span!, 'kyp.fallback');
    expect(fb).toHaveLength(1);
    expect(fb[0]!.attributes).toMatchObject({ 'kyp.mirror': 'cdn', 'kyp.source': 'cdn', 'error.type': 'http_503' });

    const m = await t.reader.metrics();
    const fallbacks = m.get('kyp.fallbacks')!;
    expect(fallbacks.dataPoints[0]!.value).toBe(1);
    expect(fallbacks.dataPoints[0]!.attributes).toMatchObject({ 'kyp.source': 'cdn', 'error.type': 'http_503' });
    const dur = m.get('kyp.refresh.duration')!;
    expect(dur.dataPointType).toBe(DataPointType.HISTOGRAM);
    expect(dur.descriptor.unit).toBe('s');
    expect(m.get('kyp.revision')!.dataPoints[0]!.value).toBe(12);
    const stale = m.get('kyp.staleness')!.dataPoints[0]!.value as number;
    expect(stale).toBeGreaterThanOrEqual(0);
    expect(stale).toBeLessThan(5);
    otel.shutdown();
  });

  it('a start-up round and an update produce kyp.refresh spans with kyp.update', async () => {
    const t = setup();
    const tmp = track(new TempDir());
    const srv = tmp.fixture('v12', 'srv');
    const s = track(await FakeCdn.start(routes({ cdn: srv })));
    const c = track(
      await Client.create({
        ...netOptions(s),
        // Attach before start-up so the "start" round is recorded too.
        observer: {
          onRefresh: (r) => {
            if (r.trigger === 'start') startRecords.push(r);
          },
        },
      }),
    );
    const otel = track(instrument(c, { tracerProvider: t.tracerProvider, meterProvider: t.meterProvider }));
    expect(startRecords.map((r) => [r.trigger, r.result, r.revision, r.source])).toEqual([['start', 'updated', 12, 'cdn']]);
    expect(startRecords[0]!.events.map((e) => e.name)).toEqual(['kyp.update']);

    expect(await c.refresh()).toBe(true); // 304: not traced
    expect(t.refreshSpans()).toHaveLength(0);
    tmp.fixture('v13', 'srv');
    expect(await c.refresh()).toBe(true);
    const spans = t.refreshSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes['kyp.refresh.result']).toBe('updated');
    expect(spans[0]!.attributes['kyp.revision']).toBe(13);
    expect(ev(spans[0]!, 'kyp.update')[0]!.attributes).toEqual({
      'kyp.revision.previous': 12,
      'kyp.revision': 13,
      'kyp.prompts.changed': 1,
    });
    const dur = (await t.reader.metrics()).get('kyp.refresh.duration')!;
    const counts = dur.dataPoints.map((p) => [p.attributes['kyp.refresh.result'], (p.value as { count: number }).count]);
    expect(counts).toEqual(expect.arrayContaining([['not_modified', 1], ['updated', 1]]));
    otel.shutdown();
  });

  it('traceAllRefreshes records uneventful rounds; a failed round is an error span', async () => {
    const t = setup();
    const v12 = join(FIXTURES, 'v12');
    const s = track(await FakeCdn.start(routes({ cdn: v12, origin: v12 })));
    const c = track(await Client.create({ ...netOptions(s) }));
    track(instrument(c, { tracerProvider: t.tracerProvider, meterProvider: t.meterProvider, traceAllRefreshes: true }));
    await c.refresh();
    await s.ctl('/__down/cdn');
    await s.ctl('/__down/origin');
    expect(await c.refresh()).toBe(false);
    const [ok, failed] = t.refreshSpans();
    expect(ok!.attributes['kyp.refresh.result']).toBe('not_modified');
    expect(failed!.attributes['kyp.refresh.result']).toBe('failed');
    expect(failed!.attributes['error.type']).toBe('http_503');
    expect(failed!.status.code).toBe(2); // ERROR
    expect(failed!.attributes['kyp.source']).toBeUndefined();
  });

  it('a tampered blob produces kyp.hash_mismatch and counts it', async () => {
    const t = setup();
    const s = track(await FakeCdn.start(routes({ cdn: join(FIXTURES, 'tampered-v14'), origin: join(FIXTURES, 'v13') })));
    const c = track(await Client.create({ ...netOptions(s), snapshotDir: join(FIXTURES, 'v12') }));
    track(instrument(c, { tracerProvider: t.tracerProvider, meterProvider: t.meterProvider }));
    expect(await c.refresh()).toBe(true);
    expect(c.revision).toBe(13);
    const [span] = t.refreshSpans();
    const mm = ev(span!, 'kyp.hash_mismatch');
    expect(mm[0]!.attributes).toEqual({
      'kyp.mirror': 'cdn',
      'kyp.source': 'cdn',
      'kyp.blob.sha256': 'fcadfa6b70f5b153be065e4f32dc011328b1aff4749fb3b748bba68a60c0838e',
    });
    expect(ev(span!, 'kyp.fallback')[0]!.attributes!['error.type']).toBe('blob_unavailable');
    expect(span!.events.map((e) => e.name)).toEqual(['kyp.hash_mismatch', 'kyp.fallback', 'kyp.update']);
    const m = await t.reader.metrics();
    expect(m.get('kyp.hash_mismatches')!.dataPoints[0]!.value).toBe(1);
  });

  it('render errors are counted by type', async () => {
    const t = setup();
    const c = track(await Client.create({ app: 'demo', snapshotDir: join(FIXTURES, 'v12'), logLevel: 'off' }));
    track(instrument(c, { tracerProvider: t.tracerProvider, meterProvider: t.meterProvider }));
    expect(() => c.render('greeting', { name: 'x' })).toThrow(MissingVariableError);
    expect(() => c.renderWithMeta('greeting')).toThrow(MissingVariableError);
    expect(() => c.render('nope')).toThrow();
    const pts = (await t.reader.metrics()).get('kyp.render.errors')!.dataPoints;
    const byType = Object.fromEntries(pts.map((p) => [`${p.attributes['kyp.prompt.name']}/${p.attributes['error.type']}`, p.value]));
    expect(byType).toEqual({ 'greeting/missing_variable': 2, 'nope/not_found': 1 });
  });

  it('a throwing observer never breaks the client', async () => {
    const c = track(
      await Client.create({
        app: 'demo',
        snapshotDir: join(FIXTURES, 'v12'),
        logLevel: 'off',
        observer: {
          onRefresh: () => {
            throw new Error('boom');
          },
          onRenderError: () => {
            throw new Error('boom');
          },
        },
      }),
    );
    expect(() => c.render('greeting')).toThrow(MissingVariableError);
    expect(c.get('triage')).toContain('support agent');
  });
});

const startRecords: import('../src/index.js').RefreshRecord[] = [];
