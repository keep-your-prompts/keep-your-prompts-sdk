# Changelog: Go SDK

All notable changes to `github.com/keep-your-prompts/keep-your-prompts-sdk/go`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the module uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-29

### Added

- `kyp.New`, `kyp.FromEnv` and `kyp.OptionsFromEnv` (`KYP_DELIVERY_KEY`, `KYP_APP`, `KYP_ENV`, `KYP_SNAPSHOT_DIR`,
  `KYP_CACHE_DIR`, `KYP_GIT_MIRROR`, `KYP_GIT_TOKEN`, `KYP_CDN_URL`, `KYP_ORIGIN_URL`, `KYP_POLL_INTERVAL`,
  `KYP_WORKSPACE`, `KYP_LOG`, `KYP_API_KEY`, `KYP_API_URL`).
- Prompt delivery protocol v1: embedded, snapshot, disk-cache, CDN, origin and git mirrors in order; SHA-256
  verification of every blob; ETag revalidation with jitter and per-mirror backoff; stale revisions ignored;
  failures never evict; atomic swap through `atomic.Pointer`.
- Lock-free reads: `Get`, `Render`, `Prompt`, `Contains`, `Names`, `Revision`.
- `Status`, `Refresh`, `OnUpdate`, `Close`, `Snapshot`, `PullSnapshot`.
- `WithEmbeddedSnapshot(fs.FS)` for `//go:embed` snapshots.
- `RenderTemplate`, `TemplateVariables`, `ParseManifest`, `SHA256Hex`.
- Optional outcome reporting (`RecordOutcome`, `FlushOutcomes`).
- Conformance tests against `fake_cdn.py` and an in-process port of it, a fuzz test for the renderer, benchmarks.
- Observability ([`protocol/tracing.md`](../protocol/tracing.md)): `Meta`, `RenderWithMeta`, `PromptMeta`
  attribute and Langfuse/LangSmith metadata maps, `Observer` / `AddObserver` / `WithObserver`, `Outcome.Meta`,
  and the `go/otel` module (`kypotel.Instrument`, `Annotate`).
