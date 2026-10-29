# Changelog

All notable changes to the `keepyourprompts` gem are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the gem uses semantic versioning.

## 0.1.0 - 2026-10-29

First release.

- `KeepYourPrompts::Client` implementing prompt delivery protocol v1: mirrors in order snapshot folder, disk
  cache, CDN, origin, git; start-up from the newest local copy; a background thread revalidating with ETags
  every 30 s (with jitter); per-mirror backoff; SHA-256 verification; stale manifests ignored; failures never
  evict.
- Lock-free reads from a frozen state swapped in one assignment: `get`, `try_get`, `include?`,
  `render(name, **vars)`, `prompt`, `names`, `revision`.
- `status`, `refresh`, `on_update { |update| ... }`, `close`; `Client.from_env` reading `KYP_*`.
- Fork-safe for Puma, Unicorn and Pitchfork: a `Process._fork` hook (plus a pid check) restarts the poller
  and drops inherited sockets in the child.
- `KeepYourPrompts.configure` / `KeepYourPrompts.client` for a lazily built process-wide client, and a tiny
  Rails railtie reading `config/keepyourprompts.yml`.
- Disk cache in the shared cross-SDK layout (`<cache_dir>/<workspace>/<app>/<env>/`).
- Ruby 3.1+, no runtime dependencies (Net::HTTP, Digest::SHA256, JSON).
