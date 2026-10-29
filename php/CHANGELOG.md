# Changelog

All notable changes to `keepyourprompts/sdk` are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses semantic versioning.

## 0.1.0 - 2026-10-29

First release.

- `KeepYourPrompts` client implementing prompt delivery protocol v1 for request-scoped PHP: mirrors in order
  snapshot folder, disk cache, CDN, origin, git; start-up from the newest local copy; SHA-256 verification;
  stale manifests ignored; failures never evict.
- State shared between requests and workers in APCu (when enabled) or a file store (atomic rename), with an
  in-memory store for long-running workers. Revalidation with `If-None-Match` at most once per poll interval
  (30 s) per server, by whichever request wins a non-blocking lock; everyone else keeps serving
  (stale-while-revalidate). Per-mirror backoff. Optional revalidation after the response
  (`refreshOnShutdown`).
- `get`, `tryGet`, `has`, `render(name, array $vars, OnMissing)`, `prompt`, `names`, `revision`,
  `onUpdate`, `refresh`, `status` (with `toArray()` for health endpoints); `fromEnv()` reading `KYP_*`.
- Disk cache in the shared cross-SDK layout (`<cache_dir>/<workspace>/<app>/<env>/`).
- HTTP over ext-curl (keep-alive), PHP streams (no extension), or any PSR-18 client (`Psr18Transport`).
- Laravel service provider, `Prompts` facade and publishable config (auto-discovered).
- PHP 8.1+, no required dependencies, PHPStan level max.
