// keepyourprompts snapshot: pull a snapshot folder or an importable module.
//
//   npx @keepyourprompts/sdk snapshot --app support-bot --env prod --out ./prompts
//   npx @keepyourprompts/sdk snapshot --app support-bot --out ./src/prompts.mjs --format module
import { Client, type MirrorConfig } from './client.js';
import { atomicWrite, loadFs } from './io.js';
import { pullSnapshot, snapshotModuleSource, snapshotModuleTypes, writeSnapshotFolder } from './snapshot.js';
import { VERSION } from './version.js';

const USAGE = `usage: keepyourprompts snapshot --app <app> [--env prod] --out <path> [options]

Pulls the deployed prompts of an app env, verifies every body with SHA-256 and writes
them as a folder (the delivery protocol layout; use with snapshotDir / KYP_SNAPSHOT_DIR)
or as a JS module (use with the embeddedSnapshot option on edge runtimes).

options:
  --format folder|module  output kind (default folder)
  --key <kypd_...>        delivery key (default: $KYP_DELIVERY_KEY)
  --cdn <url>             CDN base (default: https://cdn.keepyourprompts.com/v1/d)
  --origin <url>          origin base (default: https://api.keepyourprompts.com/v1/delivery)
  --git <url>             git mirror base, e.g. https://raw.githubusercontent.com/acme/prompts/main/.kyp
  --git-token <token>     token for a private git mirror (default: $KYP_GIT_TOKEN)
  --mirror <url>          use only these mirrors (repeatable; https:// or a folder)
  --timeout <seconds>     give up after this long (default 10)
  -q, --quiet             print nothing on success
  -h, --help              this help
  -v, --version           print the SDK version

With --format module, --out is a file: .mjs/.js (ESM), .cjs (CommonJS) or .ts.
Without an extension, <out>.mjs and <out>.d.mts are written.`;

class UsageError extends Error {}

export async function main(argv: string[]): Promise<number> {
  const env = Client.optionsFromEnv();
  const a = [...argv];
  if (a[0] === '-h' || a[0] === '--help' || a.length === 0) {
    console.log(USAGE);
    return a.length === 0 ? 2 : 0;
  }
  if (a[0] === '-v' || a[0] === '--version') {
    console.log(VERSION);
    return 0;
  }
  if (a[0] !== 'snapshot') {
    console.error(`keepyourprompts: unknown command ${a[0]}\n\n${USAGE}`);
    return 2;
  }
  a.shift();
  let app = '';
  let envName = 'prod';
  let out = '';
  let format = 'folder';
  let key = env.deliveryKey ?? '';
  let cdnUrl = env.cdnUrl;
  let originUrl = env.originUrl;
  let git = '';
  let gitToken = env.gitToken ?? '';
  let timeout = 10;
  let quiet = false;
  const mirrors: MirrorConfig[] = [];
  try {
    for (let i = 0; i < a.length; i++) {
      const arg = a[i]!;
      const next = () => {
        if (i + 1 >= a.length) throw new UsageError(`${arg} needs a value`);
        return a[++i]!;
      };
      switch (arg) {
        case '--app': app = next(); break;
        case '--env': envName = next(); break;
        case '--out': out = next(); break;
        case '--format': format = next(); break;
        case '--key': key = next(); break;
        case '--cdn': cdnUrl = next(); break;
        case '--origin': originUrl = next(); break;
        case '--git': git = next(); break;
        case '--git-token': gitToken = next(); break;
        case '--mirror': mirrors.push({ name: `mirror${mirrors.length + 1}`, url: next() }); break;
        case '--timeout': timeout = Number(next()); break;
        case '-q': case '--quiet': quiet = true; break;
        case '-h': case '--help': console.log(USAGE); return 0;
        default: throw new UsageError(`unknown argument ${arg}`);
      }
    }
    if (!app) throw new UsageError('--app is required');
    if (!out) throw new UsageError('--out is required');
    if (format !== 'folder' && format !== 'module') throw new UsageError('--format must be folder or module');
    if (!(timeout > 0)) throw new UsageError('--timeout must be a positive number of seconds');
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`keepyourprompts: ${e.message}\n\n${USAGE}`);
    return 2;
  }

  try {
    const res = await pullSnapshot({
      app,
      env: envName,
      deliveryKey: key || undefined,
      cdnUrl,
      originUrl,
      gitMirror: git || undefined,
      gitToken: gitToken || undefined,
      mirrors: mirrors.length ? mirrors : undefined,
      startupTimeout: timeout * 1000,
      requestTimeout: Math.min(5000, timeout * 1000),
    });
    let wrote: string;
    if (format === 'folder') {
      const n = await writeSnapshotFolder(res.snapshot, out);
      wrote = `${out} (${n} files written)`;
    } else {
      const fs = (await loadFs())!;
      const m = /\.(mjs|js|cjs|ts|mts)$/.exec(out);
      const file = m ? out : `${out}.mjs`;
      const ext = m?.[1] ?? 'mjs';
      const kind = ext === 'cjs' ? 'cjs' : ext === 'ts' || ext === 'mts' ? 'ts' : 'esm';
      await atomicWrite(fs, file, snapshotModuleSource(res.snapshot, kind));
      if (kind !== 'ts') {
        const dts = file.replace(/\.(mjs|js|cjs)$/, (_, e: string) => (e === 'mjs' ? '.d.mts' : e === 'cjs' ? '.d.cts' : '.d.ts'));
        await atomicWrite(fs, dts, snapshotModuleTypes());
      }
      wrote = file;
    }
    if (!quiet)
      console.log(
        `${app}/${envName} revision ${res.revision} (${res.promptCount} prompts, workspace ${res.workspace}) from ${res.source} -> ${wrote}`,
      );
    return 0;
  } catch (e) {
    console.error(`keepyourprompts: ${(e as Error).message}`);
    return 1;
  }
}

const g = globalThis as { process?: { argv: string[]; exitCode?: number } };
if (g.process) {
  main(g.process.argv.slice(2)).then(
    (code) => {
      g.process!.exitCode = code;
    },
    (e: unknown) => {
      console.error(e);
      g.process!.exitCode = 1;
    },
  );
}
