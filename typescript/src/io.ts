// Mirror access: files (Node, Bun, Deno only, through a dynamic import that bundlers
// for edge runtimes leave alone) and HTTP (global fetch everywhere).

export interface FetchResult {
  kind: 'ok' | 'not_modified' | 'not_found' | 'failed';
  body?: Uint8Array;
  etag?: string;
  error?: string;
}

export const MAX_BODY = 16 * 1024 * 1024; // far above any manifest or prompt

// --- files -------------------------------------------------------------------
export interface NodeFs {
  readFile(path: string): Promise<Uint8Array>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, opts: { recursive: true }): Promise<unknown>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, opts: { force: true }): Promise<void>;
  open(path: string, flags: string): Promise<{
    writeFile(data: Uint8Array | string): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }>;
}

let fsPromise: Promise<NodeFs | null> | undefined;

/** node:fs/promises when the runtime has a file system (Node, Bun, Deno), else null. */
export function loadFs(): Promise<NodeFs | null> {
  if (!fsPromise) {
    const spec = 'node:fs/promises';
    fsPromise = (async () => {
      try {
        const g = globalThis as { process?: { versions?: { node?: string } }; Deno?: unknown; Bun?: unknown };
        if (!g.process?.versions?.node && !g.Deno && !g.Bun) return null;
        const m = (await import(/* @vite-ignore */ /* webpackIgnore: true */ spec)) as NodeFs & { default?: NodeFs };
        return typeof m.readFile === 'function' ? m : (m.default ?? null);
      } catch {
        return null;
      }
    })();
  }
  return fsPromise;
}

export function fileUrlToPath(url: string): string {
  if (!url.startsWith('file://')) return url;
  let p = decodeURIComponent(url.slice(7));
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1); // file:///C:/dir on Windows
  return p;
}

export function joinPath(base: string, rel: string): string {
  return base.endsWith('/') || base.endsWith('\\') ? base + rel : `${base}/${rel}`;
}

function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i <= 0 ? p.slice(0, i + 1) || '.' : p.slice(0, i);
}

export async function readFile(fs: NodeFs | null, path: string): Promise<FetchResult> {
  if (!fs) return { kind: 'failed', error: 'no file system in this runtime' };
  try {
    const buf = await fs.readFile(path);
    return { kind: 'ok', body: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'not_found', error: `no such file: ${path}` };
    return { kind: 'failed', error: `cannot read ${path}: ${(e as Error).message}` };
  }
}

/** Write through a temp file, fsync and rename, so readers never see half a file. */
export async function atomicWrite(fs: NodeFs, path: string, data: Uint8Array | string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${Math.random().toString(36).slice(2)}`;
  try {
    const fh = await fs.open(tmp, 'w');
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, path);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

// --- HTTP --------------------------------------------------------------------
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const isBrowser = (): boolean =>
  typeof (globalThis as { document?: unknown }).document !== 'undefined' &&
  typeof (globalThis as { window?: unknown }).window !== 'undefined';

export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  const detail = cause ? cause.code || cause.message : undefined;
  return detail && !e.message.includes(detail) ? `${e.message} (${detail})` : e.message;
}

export async function httpGet(
  fetchImpl: FetchLike,
  url: string,
  opts: { etag?: string; token?: string; timeoutMs: number; userAgent: string; signal?: AbortSignal },
): Promise<FetchResult> {
  if (opts.timeoutMs <= 0) return { kind: 'failed', error: 'deadline exceeded' };
  const headers: Record<string, string> = {};
  if (opts.etag) headers['If-None-Match'] = opts.etag;
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const browser = isBrowser();
  if (!browser) headers['User-Agent'] = opts.userAgent;
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, opts.timeoutMs);
  const onAbort = () => ctl.abort();
  opts.signal?.addEventListener('abort', onAbort);
  try {
    const init: RequestInit = { headers, signal: ctl.signal, redirect: 'follow' };
    // In a browser the HTTP cache does the ETag revalidation for us.
    if (browser) init.cache = 'no-cache';
    const res = await fetchImpl(url, init);
    const etag = res.headers.get('etag') ?? undefined;
    if (res.status === 304) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: 'not_modified', etag };
    }
    if (res.status < 200 || res.status > 299) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: res.status === 404 || res.status === 410 ? 'not_found' : 'failed', error: `HTTP ${res.status}` };
    }
    const len = Number(res.headers.get('content-length') ?? '0');
    if (len > MAX_BODY) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: 'failed', error: 'response larger than 16 MiB' };
    }
    const body = new Uint8Array(await res.arrayBuffer());
    if (body.byteLength > MAX_BODY) return { kind: 'failed', error: 'response larger than 16 MiB' };
    return { kind: 'ok', body, etag };
  } catch (e) {
    if (timedOut) return { kind: 'failed', error: `timed out after ${opts.timeoutMs} ms` };
    if (opts.signal?.aborted) return { kind: 'failed', error: 'cancelled' };
    return { kind: 'failed', error: describeError(e) };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
export const decodeUtf8 = (b: Uint8Array): string => decoder.decode(b);
export const encodeUtf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
