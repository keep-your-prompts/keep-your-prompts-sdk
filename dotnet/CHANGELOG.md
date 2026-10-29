# Changelog

All notable changes to the .NET packages `KeepYourPrompts.Sdk` and `KeepYourPrompts.Extensions.DependencyInjection`. Versions follow [Semantic Versioning](https://semver.org/); tags are `dotnet-v<version>`.

## 0.1.0 - 2026-10-29

First release.

- `KeepYourPromptsClient` implementing prompt delivery protocol v1: embedded-resource snapshot, snapshot folder, disk cache, CDN, origin and git mirrors, in that order.
- SHA-256 verification of every blob, ETag revalidation with jittered polling and per-mirror backoff, atomic in-memory swap, failures never evict.
- `Get`, `TryGet`, `Contains`, `Prompt`, `Render`, `Names`, `Revision`, `Status`, `RefreshAsync`, `Updated` event, `IAsyncDisposable`/`IDisposable`.
- `FromEnvAsync()` / `KeepYourPromptsOptions.FromEnvironment()` reading `KYP_*` variables.
- `UseEmbeddedSnapshot(assembly)` so apps start with zero network; `PullSnapshotAsync` to write the deployed state to a folder.
- Targets net8.0 (no dependencies, trimming/AOT compatible) and netstandard2.0 (System.Text.Json).
- `KeepYourPrompts.Extensions.DependencyInjection`: `services.AddKeepYourPrompts()` with `ILogger` integration.
- Observability ([`protocol/tracing.md`](../protocol/tracing.md)): `Meta`, `RenderWithMeta`, `PromptMeta`
  attribute and Langfuse/LangSmith metadata maps, `IKypObserver` / `AddObserver` / `KeepYourPromptsOptions.Observers`.
- `KeepYourPrompts.OpenTelemetry`: `AddKeepYourPromptsInstrumentation()` for tracer and meter providers,
  `client.AddOpenTelemetry()`, `Annotate`, `Activity.SetPromptAttributes`.
