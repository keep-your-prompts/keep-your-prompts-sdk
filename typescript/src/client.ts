// Client: mirrors, background refresh and the in-memory read path.
import { MissingVariableError, NotFoundError, KypError, UnavailableError } from './errors.js';
import {
  atomicWrite,
  decodeUtf8,
  describeError,
  encodeUtf8,
  fileUrlToPath,
  httpGet,
  joinPath,
  loadFs,
  readFile,
  type FetchLike,
  type FetchResult,
  type NodeFs,
} from './io.js';
import { isSlug, parseManifest, type Manifest } from './manifest.js';
import { OUTCOME_KINDS, OutcomeBuffer, type OutcomeReport } from './outcomes.js';
import { sha256Hex } from './sha256.js';
import {
  classifyError,
  normalizeSource,
  promptMeta,
  type Observer,
  type PromptMeta,
  type RefreshRecord,
  type RefreshTrigger,
  type Rendered,
  type SourceKind,
  type TelemetryEvent,
} from './telemetry.js';
import { renderTemplate, type RenderOptions, type Vars } from './template.js';
import { VERSION } from './version.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A deployed prompt. Immutable. */
export interface Prompt {
  readonly name: string;
  readonly version: number;
  readonly sha256: string;
  readonly variables: readonly string[];
  /** The raw template. */
  readonly text: string;
  render(vars?: Vars, options?: RenderOptions): string;
}

/**
 * A mirror in the protocol layout. `url` is `https://…` (or `http://`), a directory
 * (`/opt/app/prompts` or `file:///opt/app/prompts`), or `embedded:` for `embeddedSnapshot`.
 */
export interface MirrorConfig {
  name: string;
  url: string;
  /** Sent as `Authorization: Bearer <token>`. */
  token?: string;
}

/** What the `snapshot --format module` CLI writes: the protocol layout as a plain object. */
export interface EmbeddedSnapshot {
  readonly kyp: 1;
  /** `envs/<app>/<env>.json` and `blobs/<sha256>`, as UTF-8 text. */
  readonly files: Readonly<Record<string, string>>;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type Logger = (level: LogLevel, message: string) => void;

/** Passed to `onUpdate` callbacks after a new revision was swapped in. */
export interface Update {
  /** `0` if nothing was loaded before. */
  oldRevision: number;
  newRevision: number;
  /** Mirror that delivered it. */
  source: string;
  /** Prompts added, removed or with a new body. */
  changed: string[];
}

export interface MirrorStatus {
  name: string;
  /** Delivery key redacted. */
  url: string;
  consecutiveFailures: number;
  lastError: string;
  lastSuccess: Date | null;
}

export interface Status {
  /** A manifest is loaded. */
  ready: boolean;
  /** Mirror that served or last confirmed the current state. */
  source: string;
  revision: number;
  workspace: string;
  deployedAt: string;
  promptCount: number;
  /** Last time a polled mirror confirmed the manifest (200 or 304). */
  lastSuccess: Date | null;
  /** Failures in the latest refresh round, e.g. `cdn: HTTP 503`. Empty when the first mirror answered. */
  lastError: string;
  /** Milliseconds since `lastSuccess` (since start-up if never). Alert on this. */
  staleForMs: number;
  mirrors: MirrorStatus[];
}

export interface ClientOptions {
  /** App slug. Required. Env var `KYP_APP`. */
  app: string;
  /** Env slug, default `prod`. Env var `KYP_ENV`. */
  env?: string;
  /** Read-only delivery key (`kypd_…`); enables the CDN and origin mirrors. `KYP_DELIVERY_KEY`. */
  deliveryKey?: string;
  /** Lets the disk cache be found without scanning `cacheDir`. `KYP_WORKSPACE`. */
  workspace?: string;
  /** A snapshot folder (Node, Bun, Deno). `KYP_SNAPSHOT_DIR`. */
  snapshotDir?: string;
  /** Disk cache folder written by the SDK (Node, Bun, Deno). `KYP_CACHE_DIR`. */
  cacheDir?: string;
  /** A snapshot module from `npx @keepyourprompts/sdk snapshot --format module`: zero-network start. */
  embeddedSnapshot?: EmbeddedSnapshot;
  /** Git mirror base URL, e.g. `https://raw.githubusercontent.com/acme/prompts/main/.kyp`. `KYP_GIT_MIRROR`. */
  gitMirror?: string;
  /** Token for a private git mirror. `KYP_GIT_TOKEN`. */
  gitToken?: string;
  /** CDN base, default `https://cdn.keepyourprompts.com/v1/d`. `KYP_CDN_URL`. */
  cdnUrl?: string;
  /** Origin base, default `https://api.keepyourprompts.com/v1/delivery`. `KYP_ORIGIN_URL`. */
  originUrl?: string;
  /** Replace the snapshot/CDN/origin/git mirrors with your own ordered list (embedded snapshot and disk cache still apply). */
  mirrors?: MirrorConfig[];
  /** Mirrors appended after the defaults. */
  extraMirrors?: MirrorConfig[];
  /** Milliseconds between revalidations (default 30 000, ±10% jitter, minimum 100). `KYP_POLL_INTERVAL` is in seconds. */
  pollInterval?: number;
  /** Per-request timeout in ms (default 5000). */
  requestTimeout?: number;
  /** How long `create` may block on the network when nothing local exists (default 3000 ms). */
  startupTimeout?: number;
  /** Longest a failing mirror is skipped (default 300 000 ms). */
  maxBackoff?: number;
  /** Start with no prompts instead of throwing `UnavailableError`. */
  startEmpty?: boolean;
  /**
   * Revalidate on a timer (default `true`, except on Cloudflare Workers where timers do not
   * outlive a request: call `maybeRefresh()` from `ctx.waitUntil` there).
   */
  autoRefresh?: boolean;
  onUpdate?: (update: Update) => void;
  /** Default: `console.warn('[kyp] warn: …')`. */
  logger?: Logger;
  /** Minimum level logged (default `warn`), or `off`. `KYP_LOG`. */
  logLevel?: LogLevel | 'off';
  /** Custom fetch (proxies, tests). Default: the global `fetch`. */
  fetch?: FetchLike;
  userAgent?: string;
  /** API key for outcome reporting (`report()`). `KYP_API_KEY`. Without it `report()` is a no-op. */
  apiKey?: string;
  /** API base for outcome reporting, default `https://api.keepyourprompts.com`. `KYP_API_URL`. */
  apiUrl?: string;
  /** Most outcome events held while the API is unreachable (default 1000, oldest dropped first). */
  outcomeBufferSize?: number;
  /** Milliseconds between outcome flushes (default 10 000). */
  outcomeFlushInterval?: number;
  /** Delivery telemetry hook (see protocol/tracing.md); `@keepyourprompts/sdk/otel` provides one. */
  observer?: Observer;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type Kind = 'embedded' | 'file' | 'cache' | 'http';

interface MirrorRt {
  name: string;
  kind: Kind;
  source: SourceKind;
  url: string;
  shownUrl: string;
  token?: string;
  etag: string;
  failures: number;
  retryAt: number;
  lastError: string;
  lastSuccess: Date | null;
}

class PromptImpl implements Prompt {
  constructor(
    readonly name: string,
    readonly version: number,
    readonly sha256: string,
    readonly variables: readonly string[],
    readonly text: string,
  ) {
    Object.freeze(this);
  }
  render(vars: Vars = {}, options?: RenderOptions): string {
    return renderTemplate(this.text, vars, options);
  }
}

interface State {
  readonly manifest: Manifest;
  readonly raw: string;
  readonly prompts: ReadonlyMap<string, Prompt>;
  readonly bySha: ReadonlyMap<string, string>;
}

type Outcome = 'updated' | 'unchanged' | 'stale' | 'failed';
interface Candidate {
  state?: State;
  etag?: string;
  missing?: boolean;
  err?: string;
}

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const DEFAULT_CDN = 'https://cdn.keepyourprompts.com/v1/d';
const DEFAULT_ORIGIN = 'https://api.keepyourprompts.com/v1/delivery';
const DEFAULT_API = 'https://api.keepyourprompts.com';

const joinUrl = (base: string, rel: string) => (base.endsWith('/') ? base + rel : `${base}/${rel}`);
const kindOf = (url: string): Kind =>
  url === 'embedded:' || url === 'embedded' ? 'embedded' : /^https?:\/\//i.test(url) ? 'http' : 'file';
const jitter = () => 0.9 + Math.random() * 0.2;

function redact(text: string, key: string): string {
  if (key.length < 8) return text;
  return text.split(key).join(`${key.slice(0, 9)}...`);
}

function isWorkers(): boolean {
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
  return nav?.userAgent === 'Cloudflare-Workers';
}

function readEnv(name: string, vars?: Record<string, unknown>): string {
  const src = vars ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const v = src?.[name];
  return typeof v === 'string' ? v : '';
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Deployed prompts, read from memory. Create with `await Client.create({...})` or
 * `await Client.fromEnv()`. Reads (`get`, `render`, `prompt`) never do I/O.
 */
export class Client {
  readonly app: string;
  readonly env: string;

  private state: State | null = null;
  private readonly mirrors: MirrorRt[] = [];
  private readonly polled: number[] = [];
  private cacheIdx = -1;
  private cacheRoot = '';
  private fs: NodeFs | null = null;
  private readonly fetchImpl: FetchLike;
  private readonly key: string;
  private readonly opts: Required<
    Pick<ClientOptions, 'pollInterval' | 'requestTimeout' | 'startupTimeout' | 'maxBackoff' | 'userAgent'>
  > &
    ClientOptions;
  private readonly logMin: number;
  private readonly listeners = new Set<(u: Update) => void>();
  private pending: Update[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly abort = new AbortController();
  private closed = false;
  private readonly started = Date.now();
  private lastSuccess: Date | null = null;
  private lastError = '';
  private source = '';
  private lastRoundAt = 0;
  private readonly outcomes: OutcomeBuffer | null = null;
  private readonly embedded?: EmbeddedSnapshot;
  private readonly observers = new Set<Observer>();
  /** Span events of the refresh round in progress (rounds run one at a time). */
  private roundEvents: TelemetryEvent[] = [];

  private constructor(options: ClientOptions) {
    const o = { ...options };
    if (!o.app) throw new KypError('kyp: app is not set (options.app or KYP_APP)');
    o.env = o.env || 'prod';
    if (!isSlug(o.app)) throw new KypError(`kyp: app "${o.app}" is not a slug ([a-z0-9][a-z0-9-]{0,62})`);
    if (!isSlug(o.env)) throw new KypError(`kyp: env "${o.env}" is not a slug ([a-z0-9][a-z0-9-]{0,62})`);
    this.key = o.deliveryKey ?? '';
    if (!/^[A-Za-z0-9_-]*$/.test(this.key)) throw new KypError('kyp: the delivery key contains an invalid character');
    this.app = o.app;
    this.env = o.env;
    this.opts = {
      ...o,
      pollInterval: Math.max(100, o.pollInterval ?? 30_000),
      requestTimeout: o.requestTimeout ?? 5_000,
      startupTimeout: o.startupTimeout ?? 3_000,
      maxBackoff: o.maxBackoff ?? 300_000,
      userAgent: o.userAgent ?? `kyp-ts/${VERSION}`,
    };
    this.logMin = o.logLevel === 'off' ? 99 : LEVELS[o.logLevel ?? 'warn'] ?? 2;
    const f = o.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
    this.fetchImpl = f ? (u, i) => f(u, i) : async () => Promise.reject(new Error('no fetch in this runtime'));
    if (this.key && !this.key.startsWith('kypd_'))
      this.log('warn', 'delivery key does not start with kypd_; check KYP_DELIVERY_KEY');
    if (o.onUpdate) this.listeners.add(o.onUpdate);
    if (o.observer) this.observers.add(o.observer);
    this.embedded = o.embeddedSnapshot;
    if (o.apiKey) {
      this.outcomes = new OutcomeBuffer({
        apiKey: o.apiKey,
        apiUrl: o.apiUrl || DEFAULT_API,
        app: o.app,
        fetch: this.fetchImpl,
        userAgent: this.opts.userAgent,
        maxBuffer: Math.max(1, o.outcomeBufferSize ?? 1000),
        flushInterval: o.outcomeFlushInterval ?? 10_000,
        timeoutMs: this.opts.requestTimeout,
        log: (l, m) => this.log(l, m),
      });
    }
  }

  /** Load prompts (see the README for start-up order) and start the background refresher. */
  static async create(options: ClientOptions): Promise<Client> {
    const c = new Client(options);
    await c.init();
    return c;
  }

  /**
   * Read `KYP_*` settings from `process.env` (or from `vars`, e.g. a Workers `env` binding object),
   * then apply `overrides`.
   */
  static fromEnv(vars?: Record<string, unknown>, overrides: Partial<ClientOptions> = {}): Promise<Client> {
    return Client.create({ ...Client.optionsFromEnv(vars), ...overrides } as ClientOptions);
  }

  /** The options `fromEnv` would use. */
  static optionsFromEnv(vars?: Record<string, unknown>): ClientOptions {
    const e = (n: string) => readEnv(n, vars);
    const o: ClientOptions = { app: e('KYP_APP') };
    const set = <K extends keyof ClientOptions>(k: K, v: ClientOptions[K] | '') => {
      if (v !== '' && v !== undefined) o[k] = v as ClientOptions[K];
    };
    set('env', e('KYP_ENV'));
    set('deliveryKey', e('KYP_DELIVERY_KEY'));
    set('workspace', e('KYP_WORKSPACE'));
    set('snapshotDir', e('KYP_SNAPSHOT_DIR'));
    set('cacheDir', e('KYP_CACHE_DIR'));
    set('gitMirror', e('KYP_GIT_MIRROR'));
    set('gitToken', e('KYP_GIT_TOKEN'));
    set('cdnUrl', e('KYP_CDN_URL'));
    set('originUrl', e('KYP_ORIGIN_URL'));
    set('apiKey', e('KYP_API_KEY'));
    set('apiUrl', e('KYP_API_URL'));
    const poll = parseFloat(e('KYP_POLL_INTERVAL'));
    if (poll > 0) o.pollInterval = Math.round(poll * 1000);
    const lvl = e('KYP_LOG');
    if (lvl === 'off' || lvl in LEVELS) o.logLevel = lvl as LogLevel | 'off';
    return o;
  }

  // --- reads: memory only ----------------------------------------------------

  /** The raw template. Throws `NotFoundError`. */
  get(name: string): string {
    return this.find(name).text;
  }

  /** The raw template, or `undefined`. */
  tryGet(name: string): string | undefined {
    return this.state?.prompts.get(name)?.text;
  }

  has(name: string): boolean {
    return this.state?.prompts.has(name) ?? false;
  }

  /** Name, version, sha256, variables, text and `render()`. Throws `NotFoundError`. */
  prompt(name: string): Prompt {
    return this.find(name);
  }

  /** Render a prompt. Throws `NotFoundError` or `MissingVariableError` (unless `{ strict: false }`). */
  render(name: string, vars: Vars = {}, options?: RenderOptions): string {
    try {
      return renderTemplate(this.find(name).text, vars, options);
    } catch (e) {
      this.renderFailed(name, e);
      throw e;
    }
  }

  /**
   * Which deployed body `name` is: name, version, sha256, app, env, workspace, revision and the
   * mirror kind that served it. Memory only. Throws `NotFoundError`.
   */
  meta(name: string): PromptMeta {
    const s = this.state;
    return this.metaOf(this.find(name), s);
  }

  /** `render` plus the metadata of the exact body rendered (one consistent state). */
  renderWithMeta(name: string, vars: Vars = {}, options?: RenderOptions): Rendered {
    const s = this.state;
    try {
      const p = this.findIn(s, name);
      return Object.freeze({ text: renderTemplate(p.text, vars, options), meta: this.metaOf(p, s) });
    } catch (e) {
      this.renderFailed(name, e);
      throw e;
    }
  }

  /** Subscribe to delivery telemetry (refresh rounds, render errors). Returns an unsubscribe function. */
  addObserver(observer: Observer): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  /** Prompt names in the current revision. */
  names(): string[] {
    return this.state ? [...this.state.prompts.keys()] : [];
  }

  /** Current revision, `0` when nothing is loaded. */
  get revision(): number {
    return this.state?.manifest.revision ?? 0;
  }

  status(): Status {
    const s = this.state;
    const since = this.lastSuccess?.getTime() ?? this.started;
    return {
      ready: !!s,
      source: this.source,
      revision: s?.manifest.revision ?? 0,
      workspace: s?.manifest.workspace ?? '',
      deployedAt: s?.manifest.deployedAt ?? '',
      promptCount: s?.prompts.size ?? 0,
      lastSuccess: this.lastSuccess,
      lastError: this.lastError,
      staleForMs: Math.max(0, Date.now() - since),
      mirrors: this.mirrors.map((m) => ({
        name: m.name,
        url: m.shownUrl,
        consecutiveFailures: m.failures,
        lastError: m.lastError,
        lastSuccess: m.lastSuccess,
      })),
    };
  }

  /**
   * The state held right now in the protocol layout, ready for `embeddedSnapshot` (what the
   * `snapshot --format module` CLI writes). `undefined` when nothing is loaded.
   */
  toSnapshot(): EmbeddedSnapshot | undefined {
    const s = this.state;
    if (!s) return undefined;
    const files: Record<string, string> = { [this.manifestPath]: s.raw };
    for (const [sha, text] of s.bySha) files[`blobs/${sha}`] = text;
    return { kyp: 1, files };
  }

  // --- control ---------------------------------------------------------------

  /** Subscribe to new revisions. Returns an unsubscribe function. */
  onUpdate(cb: (update: Update) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Revalidate now across mirrors, ignoring backoff. Resolves `true` if a mirror answered. */
  async refresh(): Promise<boolean> {
    if (!this.polled.length || this.closed) return false;
    const ok = await this.serial(() => this.round(true, Infinity, 'manual'));
    this.deliver();
    return ok;
  }

  /**
   * Refresh only if `pollInterval` has passed since the last round. Never throws. Meant for
   * runtimes without background timers: `ctx.waitUntil(prompts.maybeRefresh())`.
   */
  async maybeRefresh(): Promise<boolean> {
    if (Date.now() - this.lastRoundAt < this.opts.pollInterval) return false;
    try {
      return await this.refresh();
    } catch {
      return false;
    }
  }

  /**
   * Record how a call that used a prompt went. Buffered and sent in the background to
   * `POST {apiUrl}/v1/apps/{app}/outcomes`; a no-op without an API key. Never throws.
   */
  report(r: OutcomeReport | (Partial<Omit<OutcomeReport, 'prompt'>> & { prompt: PromptMeta | Rendered; outcome: OutcomeReport['outcome'] })): void {
    if (!this.outcomes || this.closed) return;
    try {
      if (!r || !OUTCOME_KINDS.includes(r.outcome)) {
        this.log('warn', `report: unknown outcome "${r?.outcome}" (use ${OUTCOME_KINDS.join(', ')})`);
        return;
      }
      // A PromptMeta (or renderWithMeta result) pins the body that was actually used.
      const meta: PromptMeta | undefined =
        typeof r.prompt === 'string' ? undefined : 'meta' in r.prompt ? r.prompt.meta : r.prompt;
      const name = meta ? meta.name : (r.prompt as string);
      const sha256 = meta?.sha256 ?? r.sha256 ?? this.state?.prompts.get(name)?.sha256;
      if (!sha256) {
        this.log('debug', `report: prompt "${name}" is not deployed; dropped`);
        return;
      }
      this.outcomes.add({
        env: meta?.env ?? this.env,
        prompt: name,
        sha256,
        outcome: r.outcome,
        latencyMs: r.latencyMs,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
      });
    } catch {
      // fail-silent
    }
  }

  /** Send buffered outcome reports now. Never throws. */
  async flush(): Promise<void> {
    await this.outcomes?.flush();
  }

  /** Stop the refresher and flush outcome reports. Reads keep working. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.abort.abort();
    this.outcomes?.stop();
    await this.outcomes?.flush();
  }

  // --- internals ------------------------------------------------------------

  private find(name: string): Prompt {
    return this.findIn(this.state, name);
  }

  private findIn(s: State | null, name: string): Prompt {
    const p = s?.prompts.get(name);
    if (p) return p;
    throw new NotFoundError(
      name,
      s ? `${this.app}/${this.env} revision ${s.manifest.revision}` : `nothing loaded for ${this.app}/${this.env}`,
    );
  }

  private metaOf(p: Prompt, s: State | null): PromptMeta {
    const mi = this.mirrors.find((m) => m.name === this.source);
    return promptMeta({
      name: p.name,
      version: p.version,
      sha256: p.sha256,
      app: this.app,
      env: this.env,
      workspace: s?.manifest.workspace ?? '',
      revision: s?.manifest.revision ?? 0,
      source: mi ? mi.source : '',
    });
  }

  private renderFailed(name: string, e: unknown): void {
    if (!this.observers.size) return;
    const errorType =
      e instanceof MissingVariableError ? 'missing_variable' : e instanceof NotFoundError ? 'not_found' : undefined;
    if (!errorType) return;
    for (const o of this.observers) {
      try {
        o.onRenderError?.({ app: this.app, env: this.env, name, errorType });
      } catch (err) {
        this.log('error', `observer threw: ${describeError(err)}`);
      }
    }
  }

  private event(name: TelemetryEvent['name'], attributes: Record<string, string | number>): void {
    if (this.observers.size) this.roundEvents.push({ name, time: Date.now(), attributes });
  }

  private fallback(mi: number, err: string): void {
    const m = this.mirrors[mi]!;
    this.event('kyp.fallback', {
      'kyp.mirror': m.name,
      'kyp.source': m.source,
      'error.type': classifyError(err),
      'kyp.error': redact(err, this.key),
    });
  }

  private emitRound(
    trigger: RefreshTrigger,
    started: number,
    answeredBy: number,
    prevRevision: number,
    updated: boolean,
    error: string,
  ): void {
    const events = this.roundEvents;
    this.roundEvents = [];
    if (!this.observers.size) return;
    const s = this.state;
    const m = answeredBy >= 0 ? this.mirrors[answeredBy] : undefined;
    const lastFallback = [...events].reverse().find((e) => e.name === 'kyp.fallback');
    const rec: RefreshRecord = {
      app: this.app,
      env: this.env,
      trigger,
      result: !m ? 'failed' : updated ? 'updated' : 'not_modified',
      startTime: started,
      duration: Math.max(0, Date.now() - started) / 1000,
      mirror: m?.name ?? '',
      source: m?.source ?? '',
      revision: s?.manifest.revision ?? 0,
      previousRevision: prevRevision,
      workspace: s?.manifest.workspace ?? '',
      error: m ? '' : redact(error, this.key),
      errorType: m ? '' : String(lastFallback?.attributes['error.type'] ?? classifyError(error)),
      events,
    };
    for (const o of this.observers) {
      try {
        o.onRefresh?.(rec);
      } catch (err) {
        this.log('error', `observer threw: ${describeError(err)}`);
      }
    }
  }

  private log(level: LogLevel, msg: string): void {
    if (LEVELS[level] < this.logMin) return;
    const m = redact(msg, this.key);
    try {
      if (this.opts.logger) this.opts.logger(level, m);
      else console.warn(`[kyp] ${level}: ${m}`);
    } catch {
      // a broken logger must not break the client
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private get manifestPath(): string {
    return `envs/${this.app}/${this.env}.json`;
  }

  private addMirror(name: string, url: string, kind: Kind, token?: string): void {
    this.mirrors.push({
      name,
      kind,
      source: normalizeSource(name, kind) as SourceKind,
      url,
      shownUrl: redact(url, this.key),
      token,
      etag: '',
      failures: 0,
      retryAt: 0,
      lastError: '',
      lastSuccess: null,
    });
  }

  private async init(): Promise<void> {
    const o = this.opts;
    const wantsFs = !!(o.snapshotDir || o.cacheDir || [...(o.mirrors ?? []), ...(o.extraMirrors ?? [])].some(
      (m) => kindOf(m.url) === 'file',
    ));
    if (wantsFs) {
      this.fs = await loadFs();
      if (!this.fs) this.log('info', 'no file system in this runtime: snapshot folder and disk cache are off');
    }
    let rest: MirrorConfig[];
    if (o.mirrors) rest = [...o.mirrors];
    else {
      rest = [];
      if (o.snapshotDir) rest.push({ name: 'snapshot', url: o.snapshotDir });
      if (this.key) {
        rest.push({ name: 'cdn', url: joinUrl(o.cdnUrl || DEFAULT_CDN, this.key) });
        rest.push({ name: 'origin', url: joinUrl(o.originUrl || DEFAULT_ORIGIN, this.key) });
      }
      if (o.gitMirror) rest.push({ name: 'git', url: o.gitMirror, token: o.gitToken });
    }
    rest.push(...(o.extraMirrors ?? []));

    const hasEmbedded = rest.some((m) => kindOf(m.url) === 'embedded');
    if (this.embedded && !hasEmbedded) this.addMirror('embedded', 'embedded:', 'embedded');
    const cacheOn = !!(o.cacheDir && this.fs);
    let cacheAdded = false;
    const addCache = () => {
      this.cacheIdx = this.mirrors.length;
      this.addMirror('disk-cache', o.cacheDir!, 'cache');
      cacheAdded = true;
    };
    for (const m of rest) {
      const k = kindOf(m.url);
      if (k === 'file' && !this.fs) continue;
      if (k === 'embedded' && !this.embedded) continue;
      if (!cacheAdded && cacheOn && k === 'http') addCache();
      this.addMirror(m.name, m.url, k, m.token);
    }
    if (!cacheAdded && cacheOn) addCache();

    this.mirrors.forEach((m, i) => m.kind === 'http' && this.polled.push(i));
    // No network mirrors: poll the file mirrors (a snapshot folder kept fresh by a sidecar or git pull).
    if (!this.polled.length) this.mirrors.forEach((m, i) => m.kind === 'file' && this.polled.push(i));

    await this.serial(() => this.loadLocal());
    const loadedLocally = !!this.state;
    if (!loadedLocally) {
      if (!this.polled.length) {
        if (!o.startEmpty)
          throw new UnavailableError(
            `kyp: no prompts for ${this.app}/${this.env}: no snapshot or disk cache found and no remote mirror ` +
              'configured (set KYP_DELIVERY_KEY, KYP_SNAPSHOT_DIR or pass embeddedSnapshot)',
          );
        this.log('warn', `starting empty: no mirror for ${this.app}/${this.env}`);
      } else {
        await this.startupFromNetwork();
      }
    }
    const auto = o.autoRefresh ?? !isWorkers();
    if (this.polled.length && auto) this.schedule(loadedLocally || !this.state ? 0 : undefined);
  }

  private schedule(delay?: number): void {
    if (this.closed) return;
    const wait = delay ?? Math.round(this.opts.pollInterval * jitter());
    this.timer = setTimeout(() => void this.tick(), wait);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async tick(): Promise<void> {
    this.timer = undefined;
    if (this.closed) return;
    try {
      await this.serial(() => this.round(false, Infinity, 'poll'));
    } catch (e) {
      this.log('error', `refresh error: ${describeError(e)}`);
    }
    this.deliver();
    this.schedule();
  }

  private deliver(): void {
    const todo = this.pending;
    this.pending = [];
    for (const u of todo)
      for (const cb of [...this.listeners]) {
        try {
          cb(u);
        } catch (e) {
          this.log('error', `onUpdate callback threw: ${describeError(e)}`);
        }
      }
  }

  // --- mirror access -----------------------------------------------------------

  private async fetch(mi: number, rel: string, etag: string, deadline: number): Promise<FetchResult> {
    const m = this.mirrors[mi]!;
    let r: FetchResult;
    switch (m.kind) {
      case 'embedded': {
        const text = this.embedded?.files[rel];
        r = text === undefined ? { kind: 'not_found', error: `not embedded: ${rel}` } : { kind: 'ok', body: encodeUtf8(text) };
        break;
      }
      case 'file':
        r = await readFile(this.fs, joinPath(fileUrlToPath(m.url), rel));
        break;
      case 'cache':
        r = this.cacheRoot ? await readFile(this.fs, joinPath(this.cacheRoot, rel)) : { kind: 'not_found', error: 'empty' };
        break;
      case 'http': {
        const timeoutMs = Math.min(this.opts.requestTimeout, deadline === Infinity ? Infinity : deadline - Date.now());
        r = await httpGet(this.fetchImpl, joinUrl(m.url, rel), {
          etag,
          token: m.token,
          timeoutMs,
          userAgent: this.opts.userAgent,
          signal: this.abort.signal,
        });
        break;
      }
    }
    if (r.error) r.error = redact(r.error, this.key);
    return r;
  }

  private inBackoff(mi: number): boolean {
    return this.mirrors[mi]!.retryAt > Date.now();
  }

  private recordOk(mi: number): void {
    const m = this.mirrors[mi]!;
    if (m.failures > 0) this.log('info', `${m.name} is answering again`);
    m.failures = 0;
    m.retryAt = 0;
    m.lastError = '';
    m.lastSuccess = new Date();
  }

  private recordFail(mi: number, err: string, count: boolean): void {
    const m = this.mirrors[mi]!;
    m.lastError = err;
    if (!count) return;
    m.failures++;
    // Skip the mirror for 0, 1, 3, 7, ... poll intervals, capped at maxBackoff.
    const mult = 2 ** Math.min(m.failures - 1, 20) - 1;
    const ms = Math.min(this.opts.pollInterval * mult, this.opts.maxBackoff);
    m.retryAt = Date.now() + ms * jitter();
    this.log(m.failures === 1 ? 'warn' : 'debug', `${m.name}: ${err}`);
  }

  // --- loading ----------------------------------------------------------------

  private async resolveBlob(mi: number, sha: string, deadline: number): Promise<{ text?: string; err?: string }> {
    const order = [...(this.cacheIdx >= 0 ? [this.cacheIdx] : []), mi, ...this.mirrors.keys()];
    const seen = new Set<number>();
    const errors: string[] = [];
    for (const i of order) {
      if (seen.has(i)) continue;
      seen.add(i);
      if (this.closed) break;
      if (i !== mi && this.mirrors[i]!.kind === 'http' && this.inBackoff(i)) continue;
      const r = await this.fetch(i, `blobs/${sha}`, '', deadline);
      if (r.kind !== 'ok') {
        if (i === mi) errors.push(`${this.mirrors[i]!.name}: ${r.error}`);
        continue;
      }
      if ((await sha256Hex(r.body!)) !== sha) {
        const msg = `blob ${sha.slice(0, 12)} failed sha256 verification`;
        this.event('kyp.hash_mismatch', {
          'kyp.mirror': this.mirrors[i]!.name,
          'kyp.source': this.mirrors[i]!.source,
          'kyp.blob.sha256': sha,
        });
        this.log('warn', `${this.mirrors[i]!.name}: ${msg} (discarded)`);
        errors.push(`${this.mirrors[i]!.name}: ${msg}`);
        continue;
      }
      return { text: decodeUtf8(r.body!) };
    }
    return { err: `blob ${sha.slice(0, 12)} unavailable${errors.length ? ` (${errors.join('; ')})` : ''}` };
  }

  private async build(mi: number, manifest: Manifest, raw: string, cur: State | null, deadline: number): Promise<State | string> {
    const prompts = new Map<string, Prompt>();
    const bySha = new Map<string, string>();
    for (const [name, mp] of Object.entries(manifest.prompts)) {
      let text = cur?.bySha.get(mp.sha256) ?? bySha.get(mp.sha256);
      if (text === undefined) {
        const r = await this.resolveBlob(mi, mp.sha256, deadline);
        if (r.text === undefined) return r.err!;
        text = r.text;
      }
      bySha.set(mp.sha256, text);
      prompts.set(name, new PromptImpl(name, mp.version, mp.sha256, mp.variables, text));
    }
    return Object.freeze({ manifest, raw, prompts, bySha });
  }

  private async tryMirror(mi: number, cur: State | null, useEtag: boolean, deadline: number): Promise<[Outcome, Candidate]> {
    const etag = useEtag && cur ? this.mirrors[mi]!.etag : '';
    const r = await this.fetch(mi, this.manifestPath, etag, deadline);
    if (r.kind === 'not_modified') return ['unchanged', { etag: r.etag }];
    if (r.kind !== 'ok')
      return [
        'failed',
        { missing: r.kind === 'not_found', err: r.kind === 'not_found' ? `manifest not found (${r.error})` : r.error },
      ];
    const raw = decodeUtf8(r.body!);
    let man: Manifest;
    try {
      man = parseManifest(raw, { app: this.app, env: this.env });
    } catch (e) {
      return ['failed', { err: `bad manifest: ${(e as Error).message}` }];
    }
    if (cur && man.revision < cur.manifest.revision)
      return ['stale', { err: `stale manifest ignored (revision ${man.revision} < held ${cur.manifest.revision})` }];
    if (cur && man.revision === cur.manifest.revision) return ['unchanged', { etag: r.etag }];
    const st = await this.build(mi, man, raw, cur, deadline);
    if (typeof st === 'string') return ['failed', { err: st }];
    return ['updated', { state: st, etag: r.etag }];
  }

  private install(st: State, mi: number, notify: boolean): void {
    const old = this.state;
    this.state = st; // the swap: one reference assignment
    this.source = this.mirrors[mi]!.name;
    let changedCount = 0;
    for (const p of st.prompts.values()) if (old?.prompts.get(p.name)?.sha256 !== p.sha256) changedCount++;
    if (old) for (const name of old.prompts.keys()) if (!st.prompts.has(name)) changedCount++;
    this.event('kyp.update', {
      'kyp.revision.previous': old?.manifest.revision ?? 0,
      'kyp.revision': st.manifest.revision,
      'kyp.prompts.changed': changedCount,
    });
    this.log(
      'info',
      `loaded ${this.app}/${this.env} revision ${st.manifest.revision} (${st.prompts.size} prompts) from ${this.source}`,
    );
    if (!notify) return;
    const changed: string[] = [];
    for (const p of st.prompts.values()) if (old?.prompts.get(p.name)?.sha256 !== p.sha256) changed.push(p.name);
    if (old) for (const name of old.prompts.keys()) if (!st.prompts.has(name)) changed.push(name);
    this.pending.push({
      oldRevision: old?.manifest.revision ?? 0,
      newRevision: st.manifest.revision,
      source: this.source,
      changed,
    });
  }

  // Start-up step 1: local mirrors only. The highest revision wins; ties go to the earlier mirror.
  private async loadLocal(): Promise<void> {
    const started = Date.now();
    this.roundEvents = [];
    await this.locateCache();
    let best: State | null = null;
    let bestMi = -1;
    let anyLocal = false;
    const errs: string[] = [];
    for (let mi = 0; mi < this.mirrors.length; mi++) {
      if (this.mirrors[mi]!.kind === 'http') continue;
      anyLocal = true;
      const [oc, c] = await this.tryMirror(mi, best, false, Infinity);
      if (oc === 'updated') {
        best = c.state!;
        bestMi = mi;
      } else if (oc === 'failed' && !c.missing) {
        this.recordFail(mi, c.err ?? '', false);
        this.fallback(mi, c.err ?? '');
        errs.push(`${this.mirrors[mi]!.name}: ${c.err}`);
      }
    }
    if (best) {
      this.install(best, bestMi, false);
      if (bestMi !== this.cacheIdx) await this.writeCache(best);
    }
    // Only a round when there was something local to read.
    if (anyLocal) this.emitRound('start', started, bestMi, 0, !!best, errs.join('; ') || 'no local copy');
    else this.roundEvents = [];
  }

  // Start-up step 2: nothing local, so wait on the network up to startupTimeout.
  private async startupFromNetwork(): Promise<void> {
    const deadline = Date.now() + this.opts.startupTimeout;
    let delay = 100;
    while (!this.state) {
      await this.serial(() => this.round(true, deadline, 'start'));
      const remaining = deadline - Date.now();
      if (this.state || remaining <= 100) break;
      await new Promise((r) => setTimeout(r, Math.min(delay, remaining - 100)));
      delay = Math.min(delay * 2, 1000);
    }
    this.pending = []; // the first load is not an "update"
    if (this.state) return;
    if (!this.opts.startEmpty)
      throw new UnavailableError(
        `kyp: could not load ${this.app}/${this.env} within ${this.opts.startupTimeout} ms: ${this.lastError}`,
      );
    this.log('warn', `starting empty, will keep trying: ${this.lastError}`);
  }

  // One refresh round over the polled mirrors, in order. Runs inside serial().
  private async round(ignoreBackoff: boolean, deadline: number, trigger: RefreshTrigger): Promise<boolean> {
    this.lastRoundAt = Date.now();
    const started = this.lastRoundAt;
    this.roundEvents = [];
    const cur = this.state;
    const errs: string[] = [];
    const skipped: number[] = [];
    let answeredBy = -1;
    let updated = false;
    const attempt = async (mi: number): Promise<boolean> => {
      const m = this.mirrors[mi]!;
      const [oc, c] = await this.tryMirror(mi, cur, true, deadline);
      switch (oc) {
        case 'updated':
          m.etag = c.etag ?? '';
          this.install(c.state!, mi, true);
          await this.writeCache(c.state!);
          this.recordOk(mi);
          answeredBy = mi;
          updated = true;
          return true;
        case 'unchanged':
          m.etag = c.etag ?? m.etag;
          this.recordOk(mi);
          if (cur) this.source = m.name;
          answeredBy = mi;
          return true;
        case 'stale':
          errs.push(`${m.name}: ${c.err}`);
          this.recordFail(mi, c.err ?? '', false);
          this.fallback(mi, c.err ?? '');
          return false;
        default:
          errs.push(`${m.name}: ${c.err}`);
          this.recordFail(mi, c.err ?? '', true);
          this.fallback(mi, c.err ?? '');
          return false;
      }
    };
    let answered = false;
    for (const mi of this.polled) {
      if (this.closed) break;
      if (!ignoreBackoff && this.inBackoff(mi)) {
        skipped.push(mi);
        continue;
      }
      if ((answered = await attempt(mi))) break;
    }
    // Everything we tried failed: give the mirrors in backoff a chance too.
    if (!answered)
      for (const mi of skipped) {
        if (this.closed) break;
        if ((answered = await attempt(mi))) break;
      }
    if (answered) this.lastSuccess = new Date();
    this.lastError = !answered && !errs.length ? 'all mirrors backing off' : errs.join('; ');
    if (!answered && !this.closed) this.log('warn', `refresh failed, serving what is held: ${errs.join('; ')}`);
    this.emitRound(trigger, started, answeredBy, cur?.manifest.revision ?? 0, updated, this.lastError);
    return answered;
  }

  // --- disk cache ----------------------------------------------------------------

  private cacheRootFor(workspace: string): string {
    return joinPath(joinPath(joinPath(this.opts.cacheDir!, workspace), this.app), this.env);
  }

  // Finds <cacheDir>/<workspace>/<app>/<env> holding the highest revision.
  private async locateCache(): Promise<void> {
    if (this.cacheIdx < 0 || this.cacheRoot || !this.fs) return;
    if (this.opts.workspace) {
      this.cacheRoot = this.cacheRootFor(this.opts.workspace);
      return;
    }
    let entries: string[] = [];
    try {
      entries = await this.fs.readdir(this.opts.cacheDir!);
    } catch {
      return;
    }
    let best = -1;
    for (const ws of entries) {
      const root = this.cacheRootFor(ws);
      const r = await readFile(this.fs, joinPath(root, this.manifestPath));
      if (r.kind !== 'ok') continue;
      try {
        const m = parseManifest(decodeUtf8(r.body!), { app: this.app, env: this.env });
        if (m.revision > best) {
          best = m.revision;
          this.cacheRoot = root;
        }
      } catch {
        // not ours
      }
    }
  }

  private async writeCache(st: State): Promise<void> {
    if (this.cacheIdx < 0 || !this.fs) return;
    const fs = this.fs;
    const root = this.cacheRootFor(st.manifest.workspace);
    try {
      for (const [sha, text] of st.bySha) {
        const blob = joinPath(root, `blobs/${sha}`);
        if ((await readFile(fs, blob)).kind !== 'ok') await atomicWrite(fs, blob, encodeUtf8(text));
      }
      const mpath = joinPath(root, this.manifestPath);
      const existing = await readFile(fs, mpath);
      if (existing.kind === 'ok') {
        const text = decodeUtf8(existing.body!);
        if (text === st.raw) {
          this.cacheRoot = root;
          return;
        }
        try {
          if (parseManifest(text, { app: this.app, env: this.env }).revision > st.manifest.revision) return;
        } catch {
          // overwrite a damaged manifest
        }
      }
      await atomicWrite(fs, mpath, encodeUtf8(st.raw));
      this.cacheRoot = root;
    } catch (e) {
      this.log('warn', `disk cache write failed: ${describeError(e)}`);
    }
  }
}
