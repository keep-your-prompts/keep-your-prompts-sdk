import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const CONFORMANCE = resolve(here, '../../conformance');
export const FIXTURES = join(CONFORMANCE, 'fixtures');
export const KEY = 'kypd_Ab3dEf6hIj9lMn2pQr5tUv8xYz1bCd4f';
export const PYTHON = process.env.PYTHON ?? 'python3';

export interface Stats {
  [route: string]: { '200': number; '304': number; '404': number; '503': number; auth: string | null };
}

export class FakeCdn {
  private constructor(
    private readonly proc: ChildProcess,
    readonly port: number,
  ) {}

  static start(routes: Record<string, [prefix: string, dir: string]>): Promise<FakeCdn> {
    const args = [join(CONFORMANCE, 'fake_cdn.py')];
    for (const [name, [prefix, dir]] of Object.entries(routes)) args.push('--route', `${name}:${prefix}:${dir}`);
    const proc = spawn(PYTHON, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    return new Promise((ok, fail) => {
      let buf = '';
      proc.on('error', fail);
      proc.stdout!.on('data', (d: Buffer) => {
        buf += d.toString();
        const m = /PORT (\d+)/.exec(buf);
        if (m) ok(new FakeCdn(proc, Number(m[1])));
      });
      proc.on('exit', (code) => fail(new Error(`fake_cdn.py exited with ${code}`)));
    });
  }

  get base(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async ctl(path: string): Promise<string> {
    return (await fetch(this.base + path)).text();
  }

  async stats(): Promise<Stats> {
    return JSON.parse(await this.ctl('/__stats')) as Stats;
  }

  stop(): void {
    this.proc.kill('SIGTERM');
  }
}

/** Standard routes: cdn and origin under the delivery key, git under a repo path. */
export function routes(dirs: { cdn?: string; origin?: string; git?: string }): Record<string, [string, string]> {
  const r: Record<string, [string, string]> = {};
  if (dirs.cdn) r.cdn = [`/v1/d/${KEY}`, dirs.cdn];
  if (dirs.origin) r.origin = [`/v1/delivery/${KEY}`, dirs.origin];
  if (dirs.git) r.git = ['/acme/prompts/main/.kyp', dirs.git];
  return r;
}

export function netOptions(s: FakeCdn) {
  return {
    app: 'demo',
    deliveryKey: KEY,
    cdnUrl: `${s.base}/v1/d`,
    originUrl: `${s.base}/v1/delivery`,
    logLevel: 'off' as const,
    autoRefresh: false,
  };
}

export class TempDir {
  readonly path = mkdtempSync(join(tmpdir(), 'kyp-ts-'));
  join(...p: string[]): string {
    return join(this.path, ...p);
  }
  /** Copy a fixture (or merge it over an existing dir: blobs first, then the manifest, like a deploy). */
  fixture(name: string, ...to: string[]): string {
    const dst = this.join(...to);
    cpSync(join(FIXTURES, name, 'blobs'), join(dst, 'blobs'), { recursive: true });
    cpSync(join(FIXTURES, name, 'envs'), join(dst, 'envs'), { recursive: true });
    return dst;
  }
  remove(): void {
    rmSync(this.path, { recursive: true, force: true });
  }
}

export async function eventually(fn: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return fn();
}
