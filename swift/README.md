# Keep Your Prompts: Swift SDK

Read deployed prompts from memory, keep them fresh in the background, and keep working offline from the very first launch.

```swift
import KeepYourPrompts

let prompts = try await KeepYourPrompts(app: "support-bot", env: "prod", deliveryKey: key)
let text = try prompts.render("triage", ["company": "Acme", "billing_queue": "refunds"])
```

- SwiftPM library `KeepYourPrompts`. Swift 5.9+ (tools 5.9), clean under Swift 6 language mode and strict concurrency.
- iOS 15, macOS 12, tvOS 15, watchOS 8, visionOS 1, and Linux.
- Dependencies: none on Apple platforms (Foundation, `URLSession`, CryptoKit). On Linux: [swift-crypto](https://github.com/apple/swift-crypto) for SHA-256 and FoundationNetworking.
- Implements [prompt delivery protocol v1](../protocol/README.md) and passes the shared [conformance suite](../conformance/README.md).
- Optional product `KeepYourPromptsOTel` for OpenTelemetry (see [Observability](#observability)); `KeepYourPrompts`
  itself never imports it.

## Install

The package manifest is at the repository root, so add the repository by URL:

```swift
// Package.swift
dependencies: [
    .package(url: "https://github.com/keep-your-prompts/keep-your-prompts-sdk.git", from: "0.1.0"),
],
targets: [
    .target(name: "MyApp", dependencies: [.product(name: "KeepYourPrompts", package: "keep-your-prompts-sdk")]),
]
```

In Xcode: File > Add Package Dependencies..., paste the URL, pick the `KeepYourPrompts` library. Releases are git tags `swift-vX.Y.Z` plus the plain SemVer tag `X.Y.Z` that SwiftPM resolves (`from: "0.1.0"`).

## Quickstart

```swift
import KeepYourPrompts

var options = Options(app: "support-bot", env: "prod", deliveryKey: key)
options.cacheDirectory = Options.defaultCacheDirectory   // <Caches>/KeepYourPrompts
options.onUpdate = { update in print("prompts: \(update.oldRevision) -> \(update.newRevision) \(update.changed)") }

let prompts = try await KeepYourPrompts(options)

let raw: String? = prompts.get("triage")                        // memory only, any thread
let text = try prompts.render("triage", ["company": "Acme"])    // throws .notFound / .missingVariables
let p = prompts.prompt("triage")                                 // name, version, sha256, variables, text

for await update in prompts.updates { reloadUI(for: update.changed) }   // AsyncStream<Update>

let status = prompts.status()   // revision, source, lastError, staleFor, per-mirror health
await prompts.refresh()         // revalidate now (optional; it also happens every 30 s)
```

From the environment (servers, CLIs): `try await KeepYourPrompts.fromEnvironment()` reads the `KYP_*` variables below.

The client is a `final class` that is `Sendable`: share one instance across your app, tasks and threads. Reads take an `os_unfair_lock` (Apple) or `NSLock` (Linux) for a pointer load; no actor hop, no `await`, no I/O. Releasing the client (or calling `close()`) stops the background refresher and finishes `updates` streams.

## iOS: offline from the first launch

1. Pull a snapshot when you build: `kyp pull --app support-bot --env prod --out KeepYourPrompts` (any SDK's snapshot tool writes the same layout).
2. Add the `KeepYourPrompts` folder to your app target as a **folder reference** (blue folder), so the bundle contains `KeepYourPrompts/envs/support-bot/prod.json` and `KeepYourPrompts/blobs/...`.
3. That's it: `Options` looks in `Bundle.main` by default. In a Swift package, ship it with `resources: [.copy("KeepYourPrompts")]` and call `options.useBundle(Bundle.module)`.

Start-up then never waits on the network: the bundled snapshot (`status().source == "embedded"`) serves at once, a newer disk cache wins over it, and the network upgrades both in the background. With `cacheDirectory` set, every verified update is persisted, so the next launch, even in airplane mode, starts on the latest version this device has seen. The system may purge Caches; the bundled snapshot is the floor.

Background refresh is a plain `Task` with `Task.sleep`; it does not keep the app awake and simply resumes polling when the app is in the foreground again. Call `await prompts.refresh()` from `scenePhase == .active` if you want an immediate check on resume.

## Privacy (App Store)

The SDK collects **no user data**: no identifiers, analytics, telemetry or tracking. It only downloads your workspace's manifest and prompt bodies (`GET` requests with your delivery key in the path, an optional `If-None-Match` and a `User-Agent: kyp-swift/0.1.0`) and stores them in the cache directory you choose. Nothing about the user or device is sent. You do not need to declare data collection for it in App Store privacy details, and it uses no required-reason APIs beyond ordinary file access to its own cache.

The delivery key is a read-only capability for deployed prompts; shipping it in an app means anyone can read those prompts, so do not put secrets in prompts delivered to clients.

## How it works: mirrors and availability

Every copy of your prompts uses the same layout, `envs/<app>/<env>.json` (the manifest) and `blobs/<sha256>` (immutable bodies), so the client treats each copy as a mirror:

| # | Mirror | `status().source` | Enabled when |
| --- | --- | --- | --- |
| 1 | Snapshot in the app bundle | `embedded` | `Bundle.main` (or `useBundle`) has `KeepYourPrompts/envs/<app>/<env>.json` |
| 2 | Snapshot folder | `snapshot` | `snapshotDirectory` / `KYP_SNAPSHOT_DIR` |
| 3 | Disk cache written by the SDK | `disk-cache` | `cacheDirectory` / `KYP_CACHE_DIR` |
| 4 | CDN `https://cdn.keepyourprompts.com/v1/d/<key>` | `cdn` | a delivery key is set |
| 5 | Origin `https://api.keepyourprompts.com/v1/delivery/<key>` | `origin` | a delivery key is set |
| 6 | Your git repo (`.kyp` folder) | `git` | `gitMirror` / `KYP_GIT_MIRROR` (+ `gitToken` as `Authorization: Bearer`) |

Four independent copies (the app's, Cloudflare's, ours, GitHub's), any one of which is enough, and an in-memory state that keeps serving through all of them failing.

- **Start-up**: local mirrors first; the highest revision wins. With nothing local, waits on the network for up to `startupTimeout` (3 s), then throws `KYPError.unavailable` (or starts empty with `startEmpty`).
- **Refresh**: every `pollInterval` (30 s ± 10%) with `If-None-Match`, network mirrors in order, first answer wins; a `304` costs nothing. New revisions have their blobs verified with SHA-256 (CryptoKit / swift-crypto), are written to the disk cache, swapped in atomically, then `onUpdate` and `updates` fire once. Lower revisions are ignored. Failing mirrors back off for 0, 1, 3, 7, ... intervals (max `maxBackoff`). **Failures never evict what is held.**

## Configuration

| `Options` property | Default | Env var (`fromEnvironment`) |
| --- | --- | --- |
| `app` | required | `KYP_APP` |
| `env` | `"prod"` | `KYP_ENV` |
| `deliveryKey` | `nil`: no CDN/origin | `KYP_DELIVERY_KEY` |
| `workspace` | found by scanning `cacheDirectory` | `KYP_WORKSPACE` |
| `snapshotDirectory` | `nil` | `KYP_SNAPSHOT_DIR` |
| `cacheDirectory` | `nil` (use `Options.defaultCacheDirectory` in apps) | `KYP_CACHE_DIR` |
| `bundleResourceURL` / `useBundle(_:subdirectory:)` | `Bundle.main`, subdirectory `KeepYourPrompts` | |
| `gitMirror`, `gitToken` | `nil` | `KYP_GIT_MIRROR`, `KYP_GIT_TOKEN` |
| `cdnBase` / `originBase` | `https://cdn.keepyourprompts.com/v1/d`, `https://api.keepyourprompts.com/v1/delivery` | `KYP_CDN_URL`, `KYP_ORIGIN_URL` |
| `mirrors` / `extraMirrors` | snapshot, CDN, origin, git / `[]` | |
| `pollInterval` | 30 s (min 0.1) | `KYP_POLL_INTERVAL` (seconds) |
| `connectTimeout` / `requestTimeout` | 2 s / 5 s | |
| `startupTimeout` | 3 s | |
| `maxBackoff` | 300 s | |
| `startEmpty` | `false` | |
| `userAgent` | `kyp-swift/0.1.0` | |
| `onUpdate` | `nil` | |
| `logger` / `logLevel` | standard error / `.warn` | `KYP_LOG=debug\|info\|warn\|error\|off` |
| `observers` | `[]`; delivery telemetry, see [Observability](#observability) | |

The delivery key never appears in logs, errors or `status()` (shortened to `kypd_Ab3d...`).

## API summary

| | |
| --- | --- |
| `init(_ options: Options) async throws`, `init(app:env:deliveryKey:cacheDirectory:bundle:onUpdate:) async throws`, `static fromEnvironment(_:) async throws` | Load and start refreshing. |
| `get(_:) -> String?`, `contains(_:)`, `prompt(_:) -> Prompt?`, `names`, `revision` | Memory-only reads. |
| `render(_:_:onMissing:) throws -> String` | `{{name}}` substitution; `.error` (default), `.keep`, `.empty`. |
| `meta(_:) throws -> PromptMeta`, `renderWithMeta(_:_:onMissing:) throws -> Rendered` | Which body is held / was rendered: `name`, `version`, `sha256`, `app`, `env`, `workspace`, `revision`, `source`; `attributes()`, `traceMetadata()`, `langfuseMetadata()`, `langsmithMetadata()`. |
| `addObserver(_:) -> ObserverToken`, `removeObserver(_:)` | Delivery telemetry. |
| `status() -> Status` | `ready`, `source`, `revision`, `workspace`, `deployedAt`, `promptCount`, `lastSuccess`, `lastError`, `staleFor`, `mirrors`. |
| `updates: AsyncStream<Update>` | `oldRevision`, `newRevision`, `source`, `changed`. |
| `refresh() async -> Bool`, `close()` | |
| `renderTemplate(_:_:onMissing:)`, `templateVariables(in:)`, `sha256Hex(_:)`, `Manifest.parse(_:app:env:)`, `pullSnapshot(_:to:)` | Free functions. |

Errors: `KYPError.notFound`, `.missingVariables([String])`, `.unavailable`, `.protocolError`, `.invalidConfiguration`.

## Observability

The SDK reports which prompt version each LLM call used and how delivery is doing, with the attribute, span and
metric names of [`protocol/tracing.md`](../protocol/tracing.md), the same in every SDK.

**Prompt metadata** (memory only, no content):

```swift
let r = try prompts.renderWithMeta("triage", ["company": "Acme"])
r.text                      // the rendered prompt
r.meta.attributes()         // ["kyp.prompt.name": "triage", "kyp.prompt.version": 7, "kyp.prompt.sha256": ..., "kyp.app": ...,
                            //  "kyp.env": ..., "kyp.revision": 42, "kyp.workspace": ..., "kyp.source": "cdn",
                            //  "gen_ai.prompt.name": "triage", "gen_ai.prompt.version": "7"]
r.meta.traceMetadata()      // flat keys: ["kyp_prompt_name": "triage", "kyp_prompt_version": 7, ...]
```

Values are `TelemetryValue` (`.string` / `.int`, `Codable`). `langfuseMetadata()` and `langsmithMetadata()` return
the same flat map (Langfuse observation metadata, LangSmith run metadata, `Helicone-Property-<key>` headers).
`kyp.source` is the mirror kind: `embedded`, `snapshot`, `cache`, `cdn`, `origin`, `git` or `custom`.

**OpenTelemetry**: add the product `KeepYourPromptsOTel` (it depends on `OpenTelemetryApi` from
[opentelemetry-swift-core](https://github.com/open-telemetry/opentelemetry-swift-core); your app sets up the SDK and
exporters):

```swift
.target(name: "MyApp", dependencies: [
    .product(name: "KeepYourPrompts", package: "keep-your-prompts-sdk"),
    .product(name: "KeepYourPromptsOTel", package: "keep-your-prompts-sdk"),
])
```

```swift
import KeepYourPromptsOTel

let otel = KYPInstrumentation()                    // the registered tracer/meter providers
var options = Options.fromEnvironment()
options.observers = [otel]                         // so the start-up round is traced too
let prompts = try await KeepYourPrompts(options)
otel.attach(prompts)                               // kyp.staleness / kyp.revision gauges, annotate by name

let r = try prompts.renderWithMeta("triage", ["company": "Acme"])
otel.annotate(r)                                   // kyp.* + gen_ai.prompt.* on the active span
```

- `annotate` takes a name (`throws` for an unknown one), a `PromptMeta` or a `Rendered`, annotates the active span
  (or `span:`) and returns the `PromptMeta`; a span that is not recording is left alone.
  `KYPInstrumentation.annotate(meta, span:...)` does the same without a client.
- The instrumentation records a `kyp.refresh` span per refresh round (start-up, poll, `refresh()`; a manual
  refresh is a child of the active span) with `kyp.fallback`, `kyp.hash_mismatch` and `kyp.update` events, and the
  metrics `kyp.refresh.duration`, `kyp.fallbacks`, `kyp.hash_mismatches`, `kyp.render.errors` and the gauges
  `kyp.staleness` and `kyp.revision`, under the instrumentation scope `keepyourprompts`. Rounds that only confirmed
  what is held (the 30-second heartbeat) are counted but not traced unless `traceAllRefreshes`.
- `KYPInstrumentation.Settings`: `captureContent` (default off, or `KYP_OTEL_CAPTURE_CONTENT`), `genAIAttributes`
  (default `true`), `openInference` (default `false`: `prompt.vendor`, `prompt.id`, `llm.prompt_template.*`),
  `traceAllRefreshes` (default `false`). `shutdown()` stops it.
- The OpenTelemetry Swift metrics API has no units on instrument builders, so the instruments carry none;
  `kyp.revision` is a double gauge (the Swift SDK reports observable long gauges as 0).

**Content capture is off by default.** With `captureContent: true` (or `KYP_OTEL_CAPTURE_CONTENT=true`),
`annotate` also records the raw template as `kyp.prompt.template` and each variable passed as
`gen_ai.prompt.variable.<name>`. Templates can hold proprietary instructions and variables often hold personal data,
customer content or secrets; with capture on they reach every exporter and backend of your OpenTelemetry pipeline
and stay there under its retention. Turn it on only where that is acceptable. SDK spans and metrics never carry
content.

**Without OpenTelemetry**, conform to `TelemetryObserver` (`onRefresh(_: RefreshRecord)`, `onRenderError(_:)`,
both optional) and pass it in `Options.observers` or to `addObserver`. A `RefreshRecord` has `trigger`, `result`,
`startTime`, `duration`, `mirror`, `source`, `revision`, `previousRevision`, `workspace`, `error`, `errorType` and
`events`. Observers run outside the client's locks.

## Tests

```sh
swift test                                   # from the repository root (macOS or Linux)
KYP_SWIFT6=1 KYP_WERROR=1 swift test             # Swift 6 language mode, warnings as errors
```

`KeepYourPromptsOTelTests` runs the OpenTelemetry add-on against the OpenTelemetry Swift SDK with in-memory
exporters. The SDK takes a `TRACEPARENT` environment variable as the parent of every span: unset it when running
the tests from inside a traced process.

The conformance tests run every `conformance/cases.json` case and the 12 required behaviours against an in-process HTTP fake, and again against `conformance/fake_cdn.py` when `python3` is on the `PATH`. On Linux (Swift 6.2, release build) a `get` takes about 90 ns and a two-variable `render` about 480 ns.

## License

See the [LICENSE](../LICENSE) file at the repository root.
