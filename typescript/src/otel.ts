// `@keepyourprompts/sdk/otel`: OpenTelemetry for Keep Your Prompts (protocol/tracing.md).
//
//   import { instrument } from '@keepyourprompts/sdk/otel';
//   const otel = instrument(prompts);           // kyp.refresh spans + kyp.* metrics
//   otel.annotate('triage');                     // kyp.* + gen_ai.prompt.* on the active span
//
// `@opentelemetry/api` is an optional peer dependency: only this entry point imports it.
import {
  SpanKind,
  SpanStatusCode,
  ValueType,
  context,
  metrics,
  trace,
  type Attributes,
  type BatchObservableResult,
  type MeterProvider,
  type Observable,
  type Span,
  type TracerProvider,
} from '@opentelemetry/api';
import type { Client } from './client.js';
import type { Observer, PromptMeta, RefreshRecord, Rendered } from './telemetry.js';
import { VERSION } from './version.js';

/** Instrumentation scope (tracer and meter name), the same in every SDK. */
export const SCOPE = 'keepyourprompts';
export const REFRESH_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export interface AnnotateOptions {
  /** Span to annotate. Default: the active span. */
  span?: Span;
  /** Template variables; recorded only with content capture on. */
  variables?: Record<string, unknown>;
  /** Override the content-capture setting for this call. */
  captureContent?: boolean;
}

export interface FreeAnnotateOptions extends AnnotateOptions {
  /** The raw template, recorded as `kyp.prompt.template` with content capture on. */
  template?: string;
  /** Also set `gen_ai.prompt.name` / `gen_ai.prompt.version` (default `true`). */
  genAiAttributes?: boolean;
  /** Also set the OpenInference aliases (default `false`). */
  openInference?: boolean;
}

export interface InstrumentOptions {
  /** Default: the global tracer provider. */
  tracerProvider?: TracerProvider;
  /** Default: the global meter provider. */
  meterProvider?: MeterProvider;
  /**
   * Record prompt templates and variable values on annotated spans. Default `false`, or
   * `KYP_OTEL_CAPTURE_CONTENT=true`. PRIVACY: values often hold personal data; see the README.
   */
  captureContent?: boolean;
  /** Set `gen_ai.prompt.name` / `gen_ai.prompt.version` next to `kyp.*` (default `true`). */
  genAiAttributes?: boolean;
  /** Set OpenInference aliases (`prompt.vendor`, `prompt.id`, `llm.prompt_template.version`). Default `false`. */
  openInference?: boolean;
  /** Also export `kyp.refresh` spans for uneventful `not_modified` rounds (default `false`). */
  traceAllRefreshes?: boolean;
}

export interface Instrumentation {
  /** Annotate a span (default: the active one) with the prompt used. Returns its metadata. */
  annotate(prompt: string | PromptMeta | Rendered, options?: AnnotateOptions): PromptMeta;
  /** Stop recording spans and metrics for this client. */
  shutdown(): void;
}

function envCapture(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return /^(1|true|yes|on)$/i.test(env?.KYP_OTEL_CAPTURE_CONTENT ?? '');
}

const isRendered = (x: PromptMeta | Rendered): x is Rendered => 'meta' in x && 'text' in x;

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function apply(meta: PromptMeta, span: Span | undefined, o: FreeAnnotateOptions, capture: boolean): void {
  try {
    if (!span || !span.isRecording()) return;
    const a: Attributes = meta.attributes({ genAi: o.genAiAttributes !== false });
    if (o.openInference) {
      a['prompt.vendor'] = 'keepyourprompts';
      a['prompt.id'] = `${meta.app}/${meta.env}/${meta.name}`;
      a['llm.prompt_template.version'] = String(meta.version);
    }
    if (capture) {
      if (o.template !== undefined) {
        a['kyp.prompt.template'] = o.template;
        if (o.openInference) a['llm.prompt_template.template'] = o.template;
      }
      if (o.variables) {
        const vars: Record<string, string> = {};
        for (const [k, v] of Object.entries(o.variables)) {
          vars[k] = stringify(v);
          a[`gen_ai.prompt.variable.${k}`] = vars[k];
        }
        if (o.openInference) a['llm.prompt_template.variables'] = JSON.stringify(vars);
      }
    }
    span.setAttributes(a);
  } catch {
    // telemetry never breaks the app
  }
}

/**
 * Annotate a span (default: the active one) with a prompt's metadata, without a client.
 * `kyp.prompt.template` needs `template`; use `instrument(client).annotate` to have it filled in.
 */
export function annotate(prompt: PromptMeta | Rendered, options: FreeAnnotateOptions = {}): PromptMeta {
  const meta = isRendered(prompt) ? prompt.meta : prompt;
  apply(meta, options.span ?? trace.getActiveSpan(), options, options.captureContent ?? envCapture());
  return meta;
}

/** Record `kyp.refresh` spans and `kyp.*` metrics for a client, and annotate LLM spans. */
export function instrument(client: Client, options: InstrumentOptions = {}): Instrumentation {
  const tracer = (options.tracerProvider ?? trace.getTracerProvider()).getTracer(SCOPE, VERSION);
  const meter = (options.meterProvider ?? metrics.getMeterProvider()).getMeter(SCOPE, VERSION);
  const capture = options.captureContent ?? envCapture();
  const base = { 'kyp.app': client.app, 'kyp.env': client.env };

  const duration = meter.createHistogram('kyp.refresh.duration', {
    unit: 's',
    description: 'Wall time of each prompt refresh round.',
    advice: { explicitBucketBoundaries: REFRESH_BUCKETS },
  });
  const fallbacks = meter.createCounter('kyp.fallbacks', {
    unit: '{fallback}',
    description: 'Mirror failures that made a refresh move on to the next mirror.',
    valueType: ValueType.INT,
  });
  const mismatches = meter.createCounter('kyp.hash_mismatches', {
    unit: '{blob}',
    description: 'Prompt bodies discarded because their SHA-256 did not match.',
    valueType: ValueType.INT,
  });
  const renderErrors = meter.createCounter('kyp.render.errors', {
    unit: '{error}',
    description: 'render() failures: unknown prompt or missing variable.',
    valueType: ValueType.INT,
  });
  const staleness = meter.createObservableGauge('kyp.staleness', {
    unit: 's',
    description: 'Seconds since a mirror last confirmed the prompts held.',
  });
  const revision = meter.createObservableGauge('kyp.revision', {
    unit: '{revision}',
    description: 'Manifest revision held (0 when nothing is loaded).',
    valueType: ValueType.INT,
  });
  const observe = (r: BatchObservableResult) => {
    try {
      const s = client.status();
      r.observe(staleness, s.staleForMs / 1000, base);
      r.observe(revision, s.revision, base);
    } catch {
      // ignore
    }
  };
  const gauges: Observable[] = [staleness, revision];
  meter.addBatchObservableCallback(observe, gauges);

  const onRefresh = (rec: RefreshRecord) => {
    const metricAttrs: Attributes = {
      ...base,
      'kyp.refresh.trigger': rec.trigger,
      'kyp.refresh.result': rec.result,
    };
    if (rec.source) metricAttrs['kyp.source'] = rec.source;
    duration.record(rec.duration, metricAttrs);
    for (const e of rec.events) {
      if (e.name === 'kyp.fallback')
        fallbacks.add(1, {
          ...base,
          'kyp.source': e.attributes['kyp.source']!,
          'kyp.mirror': e.attributes['kyp.mirror']!,
          'error.type': e.attributes['error.type']!,
        });
      else if (e.name === 'kyp.hash_mismatch')
        mismatches.add(1, { ...base, 'kyp.source': e.attributes['kyp.source']!, 'kyp.mirror': e.attributes['kyp.mirror']! });
    }
    if (rec.result === 'not_modified' && !rec.events.length && !options.traceAllRefreshes) return;

    const attrs: Attributes = { ...base, 'kyp.refresh.trigger': rec.trigger, 'kyp.refresh.result': rec.result };
    if (rec.revision) attrs['kyp.revision'] = rec.revision;
    if (rec.workspace) attrs['kyp.workspace'] = rec.workspace;
    if (rec.source) {
      attrs['kyp.source'] = rec.source;
      attrs['kyp.mirror'] = rec.mirror;
    }
    if (rec.result === 'failed') attrs['error.type'] = rec.errorType || '_OTHER';
    const parent = rec.trigger === 'manual' ? context.active() : undefined;
    const span = tracer.startSpan(
      'kyp.refresh',
      { kind: SpanKind.INTERNAL, startTime: rec.startTime, attributes: attrs, root: rec.trigger !== 'manual' },
      parent,
    );
    for (const e of rec.events) span.addEvent(e.name, e.attributes, e.time);
    if (rec.result === 'failed') span.setStatus({ code: SpanStatusCode.ERROR, message: rec.error.slice(0, 500) });
    span.end(rec.startTime + rec.duration * 1000);
  };

  const observer: Observer = {
    onRefresh: (rec) => {
      try {
        onRefresh(rec);
      } catch {
        // telemetry never breaks the client
      }
    },
    onRenderError: (info) => {
      try {
        renderErrors.add(1, { ...base, 'kyp.prompt.name': info.name, 'error.type': info.errorType });
      } catch {
        // ignore
      }
    },
  };
  const unsubscribe = client.addObserver(observer);

  return {
    annotate(prompt, o = {}) {
      const meta = typeof prompt === 'string' ? client.meta(prompt) : isRendered(prompt) ? prompt.meta : prompt;
      const cap = o.captureContent ?? capture;
      let template: string | undefined;
      if (cap) {
        // Only the template of the very body the metadata names.
        const held = client.has(meta.name) ? client.prompt(meta.name) : undefined;
        if (held && held.sha256 === meta.sha256) template = held.text;
      }
      apply(
        meta,
        o.span ?? trace.getActiveSpan(),
        { ...o, template, genAiAttributes: options.genAiAttributes, openInference: options.openInference },
        cap,
      );
      return meta;
    },
    shutdown() {
      unsubscribe();
      meter.removeBatchObservableCallback(observe, gauges);
    },
  };
}

export type { PromptMeta, Rendered, RefreshRecord, Observer } from './telemetry.js';
