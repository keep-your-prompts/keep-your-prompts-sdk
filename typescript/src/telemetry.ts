// Prompt metadata, metadata maps and the observer hook (protocol/tracing.md).
// No dependency on OpenTelemetry: the `@keepyourprompts/sdk/otel` subpath builds on these.

/** Normalised mirror kind (`kyp.source`). */
export type SourceKind = 'embedded' | 'snapshot' | 'cache' | 'cdn' | 'origin' | 'git' | 'custom';

/** Which deployed body a call used. Read from memory; see `Client.meta()`. */
export interface PromptMeta {
  readonly name: string;
  readonly version: number;
  readonly sha256: string;
  readonly app: string;
  readonly env: string;
  readonly workspace: string;
  readonly revision: number;
  /** Normalised mirror kind, `''` before anything is loaded. */
  readonly source: SourceKind | '';
  /** `kyp.*` plus `gen_ai.prompt.name` / `gen_ai.prompt.version` span attributes (plain map). */
  attributes(options?: { genAi?: boolean }): Record<string, string | number>;
  /** Flat `kyp_*` keys: for any tool's free-form metadata. */
  traceMetadata(): Record<string, string | number>;
  /** Same map, for `langfuse.update_current_generation({ metadata })` and friends. */
  langfuseMetadata(): Record<string, string | number>;
  /** Same map, for LangSmith `traceable({ metadata })`. */
  langsmithMetadata(): Record<string, string | number>;
}

/** What `renderWithMeta` returns. */
export interface Rendered {
  readonly text: string;
  readonly meta: PromptMeta;
}

export type RefreshTrigger = 'start' | 'poll' | 'manual';
export type RefreshResult = 'updated' | 'not_modified' | 'failed';

/** A span event recorded during a refresh round. */
export interface TelemetryEvent {
  name: 'kyp.fallback' | 'kyp.hash_mismatch' | 'kyp.update';
  /** Wall clock, ms since the epoch. */
  time: number;
  attributes: Record<string, string | number>;
}

/** Passed to `Observer.onRefresh` after each refresh round. */
export interface RefreshRecord {
  app: string;
  env: string;
  trigger: RefreshTrigger;
  result: RefreshResult;
  /** Wall clock, ms since the epoch. */
  startTime: number;
  /** Seconds. */
  duration: number;
  /** Configured name of the mirror that answered (`''` when failed). */
  mirror: string;
  source: SourceKind | '';
  revision: number;
  previousRevision: number;
  workspace: string;
  /** When failed: short message (delivery key redacted) and `error.type`. */
  error: string;
  errorType: string;
  events: TelemetryEvent[];
}

/** Receives delivery telemetry. Every method is optional; exceptions are caught and logged. */
export interface Observer {
  onRefresh?(record: RefreshRecord): void;
  onRenderError?(info: { app: string; env: string; name: string; errorType: 'not_found' | 'missing_variable' }): void;
}

const SOURCES = new Set(['embedded', 'snapshot', 'cache', 'cdn', 'origin', 'git']);

/** Mirror name and kind to `kyp.source`. */
export function normalizeSource(name: string, kind: 'embedded' | 'file' | 'cache' | 'http'): SourceKind | '' {
  if (!name) return '';
  if (name === 'disk-cache') return 'cache';
  if (SOURCES.has(name)) return name as SourceKind;
  if (kind === 'embedded') return 'embedded';
  if (kind === 'cache') return 'cache';
  if (kind === 'file') return 'snapshot';
  return 'custom';
}

/** A failure message to a low-cardinality `error.type`. */
export function classifyError(message: string): string {
  const m = message.toLowerCase();
  if (/blob \S+ unavailable/.test(m)) return 'blob_unavailable';
  if (m.includes('sha256 verification') || m.includes('hash mismatch')) return 'hash_mismatch';
  if (m.includes('stale manifest')) return 'stale';
  if (m.includes('bad manifest') || m.includes('invalid manifest')) return 'bad_manifest';
  if (/http (404|410)\b/.test(m) || m.includes('not found') || m.includes('no such file') || m.includes('not embedded'))
    return 'not_found';
  const http = /http (\d{3})\b/.exec(m);
  if (http) return `http_${http[1]}`;
  if (m.includes('timed out') || m.includes('timeout') || m.includes('deadline')) return 'timeout';
  if (/fetch failed|econn|enotfound|eai_again|network|socket|connection/.test(m)) return 'network';
  return '_OTHER';
}

export interface MetaFields {
  name: string;
  version: number;
  sha256: string;
  app: string;
  env: string;
  workspace: string;
  revision: number;
  source: SourceKind | '';
}

class Meta implements PromptMeta {
  readonly name: string;
  readonly version: number;
  readonly sha256: string;
  readonly app: string;
  readonly env: string;
  readonly workspace: string;
  readonly revision: number;
  readonly source: SourceKind | '';
  constructor(f: MetaFields) {
    this.name = f.name;
    this.version = f.version;
    this.sha256 = f.sha256;
    this.app = f.app;
    this.env = f.env;
    this.workspace = f.workspace;
    this.revision = f.revision;
    this.source = f.source;
    Object.freeze(this);
  }
  attributes(options?: { genAi?: boolean }): Record<string, string | number> {
    const a: Record<string, string | number> = {
      'kyp.prompt.name': this.name,
      'kyp.prompt.version': this.version,
      'kyp.prompt.sha256': this.sha256,
      'kyp.app': this.app,
      'kyp.env': this.env,
      'kyp.revision': this.revision,
    };
    if (this.workspace) a['kyp.workspace'] = this.workspace;
    if (this.source) a['kyp.source'] = this.source;
    if (options?.genAi !== false) {
      a['gen_ai.prompt.name'] = this.name;
      a['gen_ai.prompt.version'] = String(this.version);
    }
    return a;
  }
  traceMetadata(): Record<string, string | number> {
    const out: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(this.attributes({ genAi: false }))) out[k.replace(/\./g, '_')] = v;
    return out;
  }
  langfuseMetadata(): Record<string, string | number> {
    return this.traceMetadata();
  }
  langsmithMetadata(): Record<string, string | number> {
    return this.traceMetadata();
  }
  toJSON(): MetaFields {
    const { name, version, sha256, app, env, workspace, revision, source } = this;
    return { name, version, sha256, app, env, workspace, revision, source };
  }
}

/** Build a `PromptMeta` from its fields (tests, or metadata carried across processes). */
export function promptMeta(fields: MetaFields): PromptMeta {
  return new Meta(fields);
}
