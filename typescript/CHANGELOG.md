# Changelog

All notable changes to `@keepyourprompts/sdk` are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses semantic versioning.

## 0.1.0 - 2026-10-29

First release.

- `Client.create()` / `Client.fromEnv()`: prompt delivery protocol v1 with mirrors in order embedded snapshot,
  snapshot folder, disk cache, CDN, origin, git; start-up from the newest local copy; ETag revalidation every
  30 s with jitter; per-mirror backoff; SHA-256 verification of every body; atomic state swap; failures never evict.
- Synchronous, memory-only reads: `get`, `tryGet`, `has`, `render` (strict by default), `prompt`, `names`.
- `status()`, `refresh()`, `maybeRefresh()` (for runtimes without timers), `onUpdate()`, `close()`.
- `embeddedSnapshot` option and `toSnapshot()`; disk cache and snapshot folders on Node, Bun and Deno.
- Optional outcome reporting: `report()` and `flush()`, buffered and fail-silent.
- `snapshot` CLI: `npx @keepyourprompts/sdk snapshot --app … --env … --out … [--format folder|module]`.
- Pure helpers: `renderTemplate`, `templateVariables`, `parseManifest`, `sha256Hex`.
- ESM and CommonJS builds with type declarations; zero runtime dependencies.
- Observability ([`protocol/tracing.md`](../protocol/tracing.md)): `meta()`, `renderWithMeta()`, `PromptMeta`
  attribute and Langfuse/LangSmith metadata maps, `addObserver()`, `report()` accepting prompt metadata, and the
  `@keepyourprompts/sdk/otel` entry point (`instrument`, `annotate`; `@opentelemetry/api` as an optional peer).
