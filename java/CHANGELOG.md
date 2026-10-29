# Changelog

All notable changes to the Java SDK (`com.keepyourprompts:kyp-sdk`). Versions follow [Semantic Versioning](https://semver.org/); tags are `java-v<version>`.

## 0.1.0 - 2026-10-29

First release.

- `KeepYourPrompts` client implementing prompt delivery protocol v1: class-path snapshot, snapshot folder, disk cache, CDN, origin and git mirrors, in that order.
- SHA-256 verification of every blob, ETag revalidation with jittered polling and per-mirror backoff, atomic in-memory swap, failures never evict.
- `get`, `tryGet`, `contains`, `prompt`, `render`, `names`, `revision`, `status`, `refresh`, `onUpdate`, `close` (`AutoCloseable`).
- `fromEnv()` / `builderFromEnv()` reading `KYP_*` variables; fluent `builder()`.
- `snapshotFromClasspath(prefix)` so fat jars and Spring Boot apps start with zero network.
- `pullSnapshot(builder, dir)` to write the deployed state to a folder.
- Zero runtime dependencies; Java 17 bytecode, tested on 17, 21 and 25.
- Observability ([`protocol/tracing.md`](../protocol/tracing.md)): `meta`, `renderWithMeta`, `PromptMeta`
  attribute and Langfuse/LangSmith metadata maps, `Telemetry.Observer` / `addObserver` / `Builder.observer`, and
  `com.keepyourprompts.otel.KypOpenTelemetry` (`instrument`, `annotate`) with `opentelemetry-api` as an optional
  dependency.
