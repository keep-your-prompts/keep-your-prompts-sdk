# Prompt delivery protocol v1

How apps get prompts at runtime. Every SDK in this repository implements this, and so can anyone with an HTTP client.

## Idea: one layout, many mirrors

Prompt bodies are immutable and content-addressed. The only thing that changes is a small **manifest** per app environment that says which body is live. Every place that holds a copy of a workspace uses the **same file layout**, so an SDK treats them as interchangeable mirrors and tries them in order:

| Mirror | Base URL example | Depends on our API? |
| --- | --- | --- |
| Bundled snapshot (shipped with the app) | `file:///opt/myapp/prompts` | No |
| Local disk cache (written by the SDK) | `file:///var/cache/kyp` | No |
| Our CDN (Cloudflare cache over an R2 bucket) | `https://cdn.keepyourprompts.com/v1/d/<delivery-key>` | No: R2 serves while our cluster is down |
| Our origin API | `https://api.keepyourprompts.com/v1/delivery/<delivery-key>` | Yes |
| The user's git repo (sync target) | `https://raw.githubusercontent.com/acme/prompts/main/.kyp` | No: GitHub serves it |

That is the availability story without an SLA: four independent copies (yours, Cloudflare's, ours, GitHub's), any one of which is enough, and an in-memory cache that keeps serving the last good version through all of them failing.

## Layout

Under any base URL:

```
envs/<app>/<env>.json      manifest (changes on deploy/rollback)
blobs/<sha256>             prompt body, UTF-8 text (never changes)
```

`<app>` and `<env>` are lowercase slugs `[a-z0-9][a-z0-9-]{0,62}`.

## Manifest

```json
{
  "schema": 1,
  "workspace": "acme",
  "app": "support-bot",
  "env": "prod",
  "revision": 42,
  "deployed_at": "2026-10-29T14:03:11Z",
  "prompts": {
    "triage":     { "sha256": "a3f9c1…64 hex…", "version": 7, "variables": ["company", "billing_queue"] },
    "escalation": { "sha256": "77b02e…64 hex…", "version": 3, "variables": [] }
  }
}
```

- `revision` increases by one on every deploy or rollback of this app env. Clients ignore a manifest with a lower revision than the one they hold (protects against a stale mirror).
- Prompt names are slugs; nested names use `/` (e.g. `agents/reviewer`).
- Unknown fields must be ignored.

## Blob

`blobs/<sha256>` is the prompt template body as UTF-8 text. **Clients must verify** that `sha256(body) == <sha256>` and discard mismatches; this makes every mirror untrusted-safe.

## Templates

Variables are written `{{name}}` (`[A-Za-z_][A-Za-z0-9_]*`, optional spaces inside the braces). Rendering replaces each with the supplied value; a missing variable is an error by default. `{{{{` renders a literal `{{`. No logic, loops or escaping: prompts are plain text.

## HTTP caching

| Path | Cache-Control set by us | Client behaviour |
| --- | --- | --- |
| `envs/…json` | `public, max-age=15, stale-while-revalidate=300, stale-if-error=86400` + `ETag` | Revalidate with `If-None-Match` every 30 s (configurable); `304` costs nothing |
| `blobs/…` | `public, max-age=31536000, immutable` | Fetch once, keep forever |

On deploy, the server writes the new manifest to R2 and purges `envs/<app>/<env>.json` from the Cloudflare cache. Worst-case propagation is the 15 s edge TTL plus the client poll interval.

## Delivery keys

`<delivery-key>` is a read-only capability (`kypd_` + 32 random base62 chars) scoped to one workspace and a set of apps. It sits in the path so responses are cacheable by a plain CDN. Treat it like an API key for reading prompts: keep it server-side. Rotating it re-publishes under a new prefix and deletes the old one. For the origin API the key may instead be sent as `Authorization: Bearer <key>` with base `https://api.keepyourprompts.com/v1/delivery`.

## Git mirror

When a workspace syncs to git, the sync engine also writes `.kyp/envs/…` and `.kyp/blobs/…` in the same layout, and moves the ref `refs/envs/<app>/<env>` on deploy. A private repo is read with a fine-grained read-only token sent as `Authorization: Bearer`.

## Snapshot

`kyp pull --app support-bot --env prod --out ./prompts` writes the layout to a folder: commit it or bake it into the image/binary. Building with a snapshot means the app starts with zero network.

## Client algorithm (all SDKs)

1. On start, load the manifest from the first mirror that answers (snapshot and disk cache first, so start-up never blocks on the network unless nothing local exists).
2. `get(name)` reads from memory only: O(1), no I/O, no locks beyond a read lock or atomic pointer swap.
3. A background refresher revalidates the manifest every `poll_interval` across mirrors in order (`If-None-Match`), fetches missing blobs, verifies hashes, writes them to disk cache, then atomically swaps the in-memory state.
4. Failures never evict what is held. The client reports which mirror served the current state and how stale it is.

## Clarifications

Points that implementing the SDKs showed were ambiguous above. They are part of protocol v1.

1. **Blobs are bytes, exactly as stored.** The SHA-256 is computed over the raw bytes of `blobs/<sha256>` as served. Clients never add, strip or normalise anything before hashing or when returning the text: no trailing newline added or removed, no line-ending conversion, no Unicode normalisation. An empty body is valid (its name is `e3b0c442…b855`).
2. **A UTF-8 byte order mark is part of the bytes.** A body that starts with `EF BB BF` is hashed with it and returned with it (as `U+FEFF` in languages with string types). Clients do not strip it.
3. **Slugs.** `app` and `env` (in paths, in the manifest and in the disk-cache key `<cache_dir>/<workspace>/<app>/<env>/`) match `[a-z0-9][a-z0-9-]{0,62}`; a client rejects a configured app or env that does not. The C++ SDK, the reference here, is looser for `workspace`, which only appears in the manifest and the cache path: 1 to 128 characters from `[A-Za-z0-9._-]`, never `.` or `..` (so it is always a single safe path segment). Other clients should accept at least that set and reject anything that is not a single safe path segment.
4. **`404` and `410` mean "not found on this mirror".** The mirror does not hold this app env (not deployed there yet, key rotated or revoked). It is a failure of that mirror for this round: the client moves on to the next mirror and the failure counts toward that mirror's backoff like any other error. It never evicts what is held.
5. **A missing `schema` field means schema 1.** A manifest without `schema` is read as schema 1; any other value than `1` is rejected.
6. **Empty `variables`.** `variables` is optional and defaults to `[]`. When a prompt's `variables` is empty, clients SHOULD derive the list from the body with the template rules above (in order of first appearance, without duplicates), as the C++ SDK does, so `prompt(name).variables` is useful for manifests written by older tools.
7. **Outcome reporting (optional).** An SDK may let the app report how a prompt performed. It is not part of delivery: it goes to the origin API only, never to a mirror, and an SDK without it is still conformant.
   - `POST https://api.keepyourprompts.com/v1/apps/<app>/outcomes` with `Content-Type: application/json` and `Authorization: Bearer <workspace API key>` (`kyp_live_…`; a viewer key is enough). The API does not accept delivery keys (`kypd_…`) on this route today.
   - Body: one event or an array of at most 500 events. Each event:

     ```json
     { "env": "prod", "prompt": "triage", "sha256": "a3f9c1…64 hex…", "outcome": "success",
       "latencyMs": 840, "inputTokens": 1200, "outputTokens": 310 }
     ```

     `env` is a slug, `prompt` a prompt name, `sha256` the body the app actually used (from the manifest it held),
     `outcome` one of `success`, `failure`, `feedback_positive`, `feedback_negative`; `latencyMs`, `inputTokens` and
     `outputTokens` are optional non-negative integers. The server aggregates by app, env, prompt, sha256 and hour.
   - Response: `202` with no body. `422` (problem+JSON) for an invalid event or more than 500 (the whole request is rejected), `401` for a bad key, `404` for an unknown app.
   - Clients buffer events in memory (bounded, dropping the oldest when full), send them in the background in batches of at most 500, and never block or throw on the read path. Failures are silent apart from a log line: a `429` or `5xx` batch may be retried later within the buffer bound; any other `4xx` batch is dropped.

## Tracing and observability

Span attributes, metadata maps, SDK spans and metrics shared by every SDK (`kyp.prompt.name`, `kyp.prompt.version`,
`kyp.prompt.sha256`, `kyp.source`, ...) are specified in [`tracing.md`](tracing.md). They are not part of delivery.
