# Changelog

All notable changes to the Rust SDK (`keepyourprompts`) are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the crate uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-29

### Added
- `kyp::Client` (blocking, `ureq` + rustls) and `kyp::AsyncClient` (feature `tokio`, `reqwest` + rustls) implementing
  prompt delivery protocol v1: embedded snapshot, snapshot folder, disk cache, CDN, origin and git mirrors in order.
- SHA-256 verification of every blob, `If-None-Match` revalidation with jittered polling and per-mirror backoff,
  atomic state swap via `arc-swap`, stale-mirror protection, failures never evict.
- Lock-free reads: `get`, `get_with`, `prompt`, `render`, `render_with`, `contains`, `names`, `revision`, `status`.
- `Builder` with `from_env()` (`KYP_*` variables), `on_update` callback, logger, `refresh()`, drop stops the poller.
- `include_snapshot!` macro and `Builder::embedded` for snapshots compiled into the binary; `kyp-snapshot` CLI,
  `pull_snapshot` and `embed_module_source`.
- Template functions `render`, `variables_in`, `sha256_hex`, `parse_manifest`.
- Conformance tests (all 12 required behaviours) against an in-process fake and `conformance/fake_cdn.py`.
