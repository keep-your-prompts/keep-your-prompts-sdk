# Keep Your Prompts: TypeScript SDK

Read deployed prompts from memory, keep them fresh in the background, and keep serving when the network does not.

```ts
import { Client } from '@keepyourprompts/sdk';

const prompts = await Client.fromEnv(); // KYP_DELIVERY_KEY, KYP_APP, KYP_ENV
const system = prompts.render('triage', { company: 'Acme', billing_queue: 'refunds' });
```

- npm package `@keepyourprompts/sdk`, version 0.1.0. ESM and CommonJS builds with type declarations.
- Zero runtime dependencies. Uses the global `fetch` and Web Crypto, so it runs on Node 18+, Bun, Deno, Cloudflare Workers, Vercel Edge and in browsers.
- Implements [prompt delivery protocol v1](../protocol/README.md) and passes every required behaviour of the [conformance suite](../conformance/README.md).
- This code is under the repository's [LICENSE](../LICENSE).

## Install

```sh
npm install @keepyourprompts/sdk
# or: pnpm add / yarn add / bun add @keepyourprompts/sdk
# Deno: import { Client } from 'npm:@keepyourprompts/sdk';
```

## Quickstart

```ts
import { Client } from '@keepyourprompts/sdk';

// Set KYP_DELIVERY_KEY (kypd_...), KYP_APP=support-bot and optionally KYP_ENV=prod.
const prompts = await Client.fromEnv();

prompts.get('triage');                                    // the raw template
prompts.render('triage', { company: 'Acme' });            // filled in; throws on a missing variable
prompts.render('triage', {}, { strict: false });          // leaves {{company}} in place
const p = prompts.prompt('triage');                       // { name, version, sha256, variables, text, render() }
prompts.onUpdate((u) => console.log(`now at revision ${u.newRevision}:`, u.changed));
console.log(prompts.status());                            // which mirror served it, how stale it is
```

`get`, `render` and `prompt` are synchronous and read memory only: no I/O, no awaiting, safe to call on every request.

## With the Anthropic SDK

```ts
import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@keepyourprompts/sdk';

const prompts = await Client.fromEnv();
const anthropic = new Anthropic();

const response = await anthropic.messages.create({
  model: 'claude-opus-5-5',
  max_tokens: 16000,
  system: prompts.render('triage', { company: 'Acme' }),
  messages: [{ role: 'user', content: 'My invoice is wrong.' }],
});
```

## With the OpenAI SDK

```ts
import OpenAI from 'openai';
import { Client } from '@keepyourprompts/sdk';

const prompts = await Client.fromEnv();
const openai = new OpenAI();

const response = await openai.responses.create({
  model: 'gpt-5',
  instructions: prompts.render('triage', { company: 'Acme' }),
  input: 'My invoice is wrong.',
});
```

## Configuration

`Client.create({...})` takes these options; `Client.fromEnv(vars?, overrides?)` reads the environment variables (from `process.env`, or from the object you pass, such as a Workers `env` binding) and then applies `overrides`.

| Option | Env var | Default | Meaning |
| --- | --- | --- | --- |
| `app` | `KYP_APP` | required | App slug. |
| `env` | `KYP_ENV` | `prod` | Environment slug. |
| `deliveryKey` | `KYP_DELIVERY_KEY` | none | Read-only delivery key; enables the CDN and origin mirrors. Keep it server-side. |
| `snapshotDir` | `KYP_SNAPSHOT_DIR` | none | A snapshot folder shipped with the app (Node, Bun, Deno). |
| `cacheDir` | `KYP_CACHE_DIR` | none | Disk cache written by the SDK, so restarts without network come up on the last good version. |
| `embeddedSnapshot` | | none | A snapshot module from the CLI: zero-network start anywhere, including edge runtimes. |
| `gitMirror`, `gitToken` | `KYP_GIT_MIRROR`, `KYP_GIT_TOKEN` | none | Your git sync target, e.g. `https://raw.githubusercontent.com/acme/prompts/main/.kyp`; the token is sent as `Authorization: Bearer`. |
| `cdnUrl` | `KYP_CDN_URL` | `https://cdn.keepyourprompts.com/v1/d` | |
| `originUrl` | `KYP_ORIGIN_URL` | `https://api.keepyourprompts.com/v1/delivery` | |
| `workspace` | `KYP_WORKSPACE` | found by scanning `cacheDir` | |
| `pollInterval` | `KYP_POLL_INTERVAL` (seconds) | 30 000 ms, ±10% jitter | How often the manifest is revalidated (minimum 100 ms). |
| `requestTimeout` / `startupTimeout` | | 5 000 / 3 000 ms | Per request; how long `create` may wait on the network when nothing local exists. |
| `maxBackoff` | | 300 000 ms | Longest a failing mirror is skipped. |
| `startEmpty` | | `false` | Start with no prompts instead of throwing `UnavailableError`. |
| `autoRefresh` | | `true` (`false` on Cloudflare Workers) | Revalidate on a background timer. The timer is `unref`'d: it never keeps Node alive. |
| `onUpdate` | | none | Called after a new revision is swapped in. |
| `logger`, `logLevel` | `KYP_LOG` | `console.warn`, `warn` | `debug`, `info`, `warn`, `error` or `off`. The delivery key is never logged. |
| `mirrors`, `extraMirrors` | | | Replace or extend the default mirror list: `{ name, url, token? }` with an `https://` URL, a folder or `embedded:`. |
| `fetch`, `userAgent` | | global `fetch`, `kyp-ts/0.1.0` | |
| `apiKey`, `apiUrl` | `KYP_API_KEY`, `KYP_API_URL` | none, `https://api.keepyourprompts.com` | Outcome reporting (below). |

## Availability: mirrors

Every copy of your prompts uses the same layout, `envs/<app>/<env>.json` (the manifest: which body is live) plus `blobs/<sha256>` (immutable bodies), so the client treats every copy as an interchangeable mirror:

| # | Mirror | `status().source` | Enabled when |
| --- | --- | --- | --- |
| 1 | Embedded snapshot module | `embedded` | `embeddedSnapshot` |
| 2 | Snapshot folder | `snapshot` | `snapshotDir` |
| 3 | Disk cache | `disk-cache` | `cacheDir` |
| 4 | CDN (Cloudflare over R2) | `cdn` | a delivery key |
| 5 | Origin API | `origin` | a delivery key |
| 6 | Your git repo | `git` | `gitMirror` |

- **Start-up** reads the local mirrors (1 to 3) and starts from the highest revision found, so a fresh disk cache beats an older bundled snapshot. Only when nothing local exists does `create` wait on the network, for up to `startupTimeout`.
- **Refresh** revalidates the manifest with `If-None-Match` across the network mirrors in order, stopping at the first that answers (a `304` costs nothing). A new revision has its missing blobs fetched from the disk cache, the same mirror or any other mirror, each verified with SHA-256, written to the disk cache, and then the whole state is swapped in one assignment. Without network mirrors, the snapshot folder is polled instead, so a folder kept current by a sidecar or `git pull` is picked up live.
- **Failures never evict.** A failing mirror is skipped for 0, 1, 3, 7, ... poll intervals (up to `maxBackoff`); a manifest with a lower revision than the one held is ignored; a body whose hash does not match is discarded. `status()` reports `lastError` (for example `cdn: HTTP 503`) and `staleForMs`: alert on that.

## Edge runtimes and browsers

Edge runtimes have no file system and often no background timers, so ship the prompts inside your bundle and refresh from the request:

```sh
npx @keepyourprompts/sdk snapshot --app support-bot --env prod --out ./src/prompts --format module
# writes src/prompts.mjs and src/prompts.d.mts (use --out ./src/prompts.ts for a .ts module)
```

```ts
// Cloudflare Worker
import { Client } from '@keepyourprompts/sdk';
import snapshot from './prompts.mjs';

let prompts: Promise<Client> | undefined;

export default {
  async fetch(request: Request, env: Record<string, string>, ctx: ExecutionContext) {
    prompts ??= Client.fromEnv(env, { embeddedSnapshot: snapshot });
    const client = await prompts;             // instant: starts from the embedded copy
    ctx.waitUntil(client.maybeRefresh());     // revalidates at most once per pollInterval
    return new Response(client.render('triage', { company: 'Acme' }));
  },
};
```

The same pattern works on Vercel Edge and Deno Deploy. `snapshotDir` and `cacheDir` need `node:fs` and are skipped where it does not exist. In a browser the delivery key would be public: only do that for prompts you are happy to publish, and prefer an embedded snapshot.

## Snapshots

```sh
npx @keepyourprompts/sdk snapshot --app support-bot --env prod --out ./prompts               # a folder
npx @keepyourprompts/sdk snapshot --app support-bot --out ./src/prompts.mjs --format module  # a module
```

Options: `--key` (default `$KYP_DELIVERY_KEY`), `--cdn`, `--origin`, `--git`, `--git-token`, `--mirror <url>` (repeatable), `--timeout <seconds>`, `-q`. The folder is a complete offline mirror: commit it or bake it into the image and point `snapshotDir` at it. In code: `pullSnapshot(options)`, `writeSnapshotFolder(snapshot, dir)` and `prompts.toSnapshot()`.

## Outcome reporting (optional)

With an API key, tell Keep Your Prompts how each call went; the dashboard aggregates outcomes per prompt version.

```ts
const prompts = await Client.fromEnv(); // KYP_API_KEY set
const started = Date.now();
const response = await anthropic.messages.create({ /* ... */ });
prompts.report({
  prompt: 'triage',
  outcome: 'success', // 'success' | 'failure' | 'feedback_positive' | 'feedback_negative'
  latencyMs: Date.now() - started,
  inputTokens: response.usage.input_tokens,
  outputTokens: response.usage.output_tokens,
});
```

Reports are buffered (up to 1000, oldest dropped first), sent every 10 s or per 500 to `POST {apiUrl}/v1/apps/{app}/outcomes` with `Authorization: Bearer <apiKey>`, and never throw. `await prompts.close()` flushes them; on serverless runtimes call `ctx.waitUntil(prompts.flush())`.

## API

| Member | Description |
| --- | --- |
| `Client.create(options)`, `Client.fromEnv(vars?, overrides?)` | Load prompts and start the refresher. Rejects with `UnavailableError` when nothing can be loaded. |
| `get(name)`, `tryGet(name)`, `has(name)` | Raw template; `get` throws `NotFoundError`. |
| `render(name, vars?, { strict?, onMissing? })` | Throws `NotFoundError` or `MissingVariableError` (`.names` lists every missing variable). |
| `prompt(name)` | Frozen `{ name, version, sha256, variables, text, render(vars?, opts?) }`. |
| `names()`, `revision` | Prompt names and revision currently held. |
| `status()` | `{ ready, source, revision, workspace, deployedAt, promptCount, lastSuccess, lastError, staleForMs, mirrors[] }`. |
| `refresh()` | Revalidate now, ignoring backoff; resolves `true` if a mirror answered. |
| `maybeRefresh()` | Refresh only if `pollInterval` has passed; never throws. |
| `onUpdate(cb)` | `cb({ oldRevision, newRevision, source, changed })`; returns an unsubscribe function. |
| `report(outcome)`, `flush()` | Outcome reporting. |
| `toSnapshot()` | The state held now, usable as `embeddedSnapshot`. |
| `close()` | Stop the refresher and flush reports. Reads keep working. |

Pure helpers: `renderTemplate(template, vars, options)`, `templateVariables(template)`, `parseManifest(json, { app, env }?)`, `sha256Hex(data)`. Errors: `KypError` and its subclasses `NotFoundError`, `MissingVariableError`, `UnavailableError`, `ProtocolError`.

Templates: `{{name}}` (spaces inside the braces allowed) is replaced by the value; `{{{{` renders a literal `{{`; nothing else is special and values are never rendered again.

## Development

```sh
npm ci
npm run typecheck
npm run build
npm test        # vitest: conformance suite (runs ../conformance/fake_cdn.py with python3) and unit tests
```
