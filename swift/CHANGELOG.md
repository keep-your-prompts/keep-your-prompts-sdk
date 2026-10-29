# Changelog

All notable changes to the Swift SDK (`KeepYourPrompts`) are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-29

### Added
- `KeepYourPrompts` client implementing prompt delivery protocol v1: bundled snapshot (`Bundle.main` or
  `Bundle.module`), snapshot folder, disk cache, CDN, origin and git mirrors, in that order.
- SHA-256 verification of every blob (CryptoKit on Apple platforms, swift-crypto on Linux), `If-None-Match`
  revalidation with jittered polling and per-mirror backoff, atomic state swap, stale-mirror protection,
  failures never evict.
- `Sendable` actor-free read path (`os_unfair_lock` / `NSLock`): `get`, `prompt`, `render`, `contains`, `names`,
  `revision`, `status`; `refresh()`, `close()`, `updates` `AsyncStream`, `onUpdate` callback.
- `Options` with `fromEnvironment()` (`KYP_*` variables) and `Options.defaultCacheDirectory`.
- `renderTemplate`, `templateVariables(in:)`, `sha256Hex`, `Manifest.parse`, `pullSnapshot(_:to:)`.
- XCTest conformance suite (all 12 required behaviours) against an in-process fake and `conformance/fake_cdn.py`.
