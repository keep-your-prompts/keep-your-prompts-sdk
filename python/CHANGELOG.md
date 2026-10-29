# Changelog

All notable changes to `keepyourprompts` are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses semantic versioning.

## 0.1.0 - 2026-10-29

First release.

- `Client` (background daemon thread) and `AsyncClient` (asyncio task; httpx when installed, urllib in a
  worker thread otherwise) implementing prompt delivery protocol v1: mirrors in order embedded snapshot,
  snapshot folder, disk cache, CDN, origin, git; start-up from the newest local copy; ETag revalidation every
  30 s with jitter; per-mirror backoff; SHA-256 verification; atomic state swap; failures never evict.
- Memory-only, thread-safe reads: `get`, `try_get`, `in`, `render(name, **vars)` / `render(name, vars)`,
  `prompt`, `names`.
- `status()`, `refresh()`, `on_update` (decorator), `close()` and context managers.
- Optional outcome reporting: `report()` and `flush()`, buffered and fail-silent.
- `python -m keepyourprompts snapshot` CLI and `pull_snapshot()`.
- Pure helpers: `render_template`, `template_variables`, `parse_manifest`, `sha256_hex`.
- Python 3.9+, standard library only; optional `httpx` extra; type hints and `py.typed`.
