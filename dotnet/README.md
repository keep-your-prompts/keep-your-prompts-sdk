# Keep Your Prompts: .NET SDK

Read deployed prompts from memory, keep them fresh in the background, and keep serving when the network does not.

```csharp
await using var prompts = await KeepYourPromptsClient.FromEnvAsync();   // KYP_DELIVERY_KEY, KYP_APP, KYP_ENV
string system = prompts.Render("triage", new Dictionary<string, string> { ["company"] = "Acme", ["billing_queue"] = "refunds" });
```

- Targets **net8.0** and **netstandard2.0** (.NET Framework 4.6.2+, Unity, Mono). No dependencies on net8.0; on netstandard2.0 only `System.Text.Json`. Trimming and Native AOT compatible on net8.0.
- Implements [prompt delivery protocol v1](../protocol/README.md) and passes the shared [conformance suite](../conformance/README.md).
- License: see the repository's `LICENSE` file.

| Package | What |
| --- | --- |
| `KeepYourPrompts.Sdk` | The client. |
| `KeepYourPrompts.Extensions.DependencyInjection` | `services.AddKeepYourPrompts()` for ASP.NET Core and the generic host (depends on the `Microsoft.Extensions.*.Abstractions` packages only). |
| `KeepYourPrompts.OpenTelemetry` | Activities, metrics and `Annotate` for OpenTelemetry (see Observability; depends on `OpenTelemetry.Api.ProviderBuilderExtensions`). |

## Install

```sh
dotnet add package KeepYourPrompts.Sdk
dotnet add package KeepYourPrompts.Extensions.DependencyInjection   # ASP.NET Core
dotnet add package KeepYourPrompts.OpenTelemetry                    # OpenTelemetry (optional)
```

## Quickstart

```csharp
using KeepYourPrompts;

var options = new KeepYourPromptsOptions
{
    App = "support-bot",
    Env = "prod",
    DeliveryKey = Environment.GetEnvironmentVariable("KYP_DELIVERY_KEY"),
    CacheDir = "/var/cache/kyp",                     // optional: survive restarts without network
}.UseEmbeddedSnapshot(typeof(Program).Assembly);     // optional: start with zero network

await using var prompts = await KeepYourPromptsClient.CreateAsync(options);
prompts.Updated += (_, e) => Console.WriteLine($"prompts r{e.OldRevision} -> r{e.NewRevision}: {string.Join(", ", e.Changed)}");

string raw    = prompts.Get("triage");                                              // raw template, no I/O
string text   = prompts.Render("triage", new Dictionary<string, string> { ["company"] = "Acme" });
Prompt p      = prompts.Prompt("agents/reviewer");                                  // Name, Version, Sha256, Variables, Text
ClientStatus s = prompts.Status;                                                    // Ready, Source, Revision, StaleFor, ...
bool ok       = await prompts.RefreshAsync();                                       // revalidate now
```

`KeepYourPromptsClient` is thread-safe and meant to be a singleton. `Get`, `Render`, `Prompt`, `TryGet`, `Contains`, `Names` and `Revision` are one volatile read plus a dictionary lookup: no I/O, no locks.

## API

| Member | Description |
| --- | --- |
| `static Task<KeepYourPromptsClient> FromEnvAsync(CancellationToken)` | `CreateAsync(KeepYourPromptsOptions.FromEnvironment())`. |
| `static Task<KeepYourPromptsClient> CreateAsync(KeepYourPromptsOptions, CancellationToken)` | Loads prompts (see start-up below). Throws `UnavailableException`, or `KypException` for invalid options. |
| `static KeepYourPromptsClient Create(KeepYourPromptsOptions)` | Synchronous variant for DI factories. |
| `string Get(string name)` | Raw template. Throws `PromptNotFoundException`. |
| `bool TryGet(string name, out string text)`, `bool Contains(string name)` | |
| `Prompt Prompt(string name)` | `Name`, `Version`, `Sha256`, `Variables`, `Text`, `Render(vars)`. |
| `string Render(string name, IReadOnlyDictionary<string, string>? vars, OnMissing onMissing = OnMissing.Error)` | Throws `PromptNotFoundException` or `MissingVariableException` (`.Names` lists every missing variable). `OnMissing.Keep` leaves `{{name}}`, `Empty` drops it. |
| `PromptMeta Meta(string name)`, `Rendered RenderWithMeta(string name, vars, onMissing)` | Prompt metadata; see Observability. |
| `IDisposable AddObserver(IKypObserver)`, `KeepYourPromptsOptions.Observers` | Delivery telemetry hook (refresh rounds, render errors). |
| `IReadOnlyList<string> Names`, `long Revision` | Current revision, 0 when nothing is loaded. |
| `ClientStatus Status` | `Ready`, `Source`, `Revision`, `Workspace`, `DeployedAt`, `PromptCount`, `LastSuccess`, `LastError`, `StaleFor`, `Mirrors` (per mirror: `Name`, `Url`, `ConsecutiveFailures`, `LastError`, `LastSuccess`). |
| `Task<bool> RefreshAsync(CancellationToken)` | Revalidate now, ignoring backoff. `true` if a mirror answered. |
| `event EventHandler<PromptsUpdatedEventArgs> Updated` | `OldRevision`, `NewRevision`, `Source`, `Changed`; raised after the swap on the refresh loop (or the caller of `RefreshAsync`). Handler exceptions are caught and logged. |
| `ValueTask DisposeAsync()` / `void Dispose()` | Stop the refresh loop. Reads keep working. |
| `static Task<SnapshotInfo> PullSnapshotAsync(options, outDir)` | Write the deployed state to a folder (what `kyp pull` does). |
| `Templates.Render`, `Templates.Variables`, `Templates.Sha256Hex` | The template engine and hash on their own. |

Exceptions derive from `KypException`: `PromptNotFoundException` (`Name`), `MissingVariableException` (`Names`), `UnavailableException`, `ProtocolException`.

## Configuration

| `KeepYourPromptsOptions` | Default | Env var (`FromEnvironment`) |
| --- | --- | --- |
| `App` | required | `KYP_APP` |
| `Env` | `"prod"` | `KYP_ENV` |
| `DeliveryKey` | none: no CDN/origin | `KYP_DELIVERY_KEY` |
| `SnapshotDir` | none | `KYP_SNAPSHOT_DIR` |
| `UseEmbeddedSnapshot(assembly, prefix = "kyp")` / `EmbeddedSnapshot` | none | |
| `CacheDir` | none: no disk cache | `KYP_CACHE_DIR` |
| `GitMirror`, `GitToken` | none | `KYP_GIT_MIRROR`, `KYP_GIT_TOKEN` |
| `Workspace` | found by scanning `CacheDir` | `KYP_WORKSPACE` |
| `CdnBase` / `OriginBase` | `https://cdn.keepyourprompts.com/v1/d`, `https://api.keepyourprompts.com/v1/delivery` | `KYP_CDN_URL`, `KYP_ORIGIN_URL` |
| `Mirrors` / `ExtraMirrors` | snapshot, CDN, origin, git | |
| `PollInterval` | 30 s (minimum 100 ms), plus or minus 10% jitter | `KYP_POLL_INTERVAL` (seconds) |
| `ConnectTimeout` / `RequestTimeout` | 2 s / 5 s | |
| `StartupTimeout` | 3 s | |
| `StartEmpty` | `false` | |
| `MaxBackoff` | 5 min | |
| `UserAgent` | `kyp-dotnet/0.1.0` | |
| `Logger` (`Action<KypLogLevel, string>`) | stderr, `[kyp] warn: ...` (`ILogger` with the DI package) | |
| `LogLevel` | `Warn` | `KYP_LOG=debug\|info\|warn\|error\|off` |
| `HttpHandlerFactory` | `SocketsHttpHandler` (net8.0), `HttpClientHandler` | |

The delivery key never appears in logs or `Status`; it is shortened to `kypd_Ab3d...`. HTTP honours `HTTPS_PROXY`/`NO_PROXY` (the default `HttpClient` proxy).

## Mirrors and availability

Every copy of your prompts uses the same layout, `envs/<app>/<env>.json` plus immutable `blobs/<sha256>`, so the client treats them as interchangeable mirrors, in this order:

| # | Mirror | `Status.Source` | Enabled when |
| --- | --- | --- | --- |
| 1 | Snapshot embedded in an assembly | `embedded` | `UseEmbeddedSnapshot(...)` |
| 2 | Snapshot folder | `snapshot` | `SnapshotDir` / `KYP_SNAPSHOT_DIR` |
| 3 | Disk cache written by the SDK | `disk-cache` | `CacheDir` / `KYP_CACHE_DIR` |
| 4 | CDN `https://cdn.keepyourprompts.com/v1/d/<key>` | `cdn` | a delivery key is set |
| 5 | Origin `https://api.keepyourprompts.com/v1/delivery/<key>` | `origin` | a delivery key is set |
| 6 | Your git repo (`.kyp/` written by git sync) | `git` | `GitMirror` / `KYP_GIT_MIRROR` |

- **Start-up.** Mirrors 1 to 3 are read without the network and the highest revision wins, so `CreateAsync` completes at once. Otherwise it waits on the network for up to `StartupTimeout`, then throws `UnavailableException` (or starts empty with `StartEmpty = true` and keeps trying).
- **Refresh.** A background loop revalidates the manifest every `PollInterval` with `If-None-Match`; a `304` costs nothing. A new revision has its missing blobs fetched (disk cache, then the same mirror, then any other), each **verified with SHA-256**, written to the disk cache (temp file, flush, atomic rename), then the whole state is swapped in one reference assignment. A lower revision than the one held (a stale mirror) is ignored.
- **Failures never evict.** A failing mirror is skipped for 0, 1, 3, 7, ... poll intervals (capped at `MaxBackoff`) and the next one is asked; if every mirror is down, reads keep returning the last good prompts and `Status.StaleFor` grows. Alert on that.
- **No network mirror configured?** The loop then polls the snapshot folder, so a folder kept current by a sidecar or `git pull` is picked up live.

### Embedded snapshot

Pull the deployed state into a folder (`kyp pull --app support-bot --env prod --out prompts`, or `KeepYourPromptsClient.PullSnapshotAsync`) and embed it:

```xml
<ItemGroup>
  <EmbeddedResource Include="prompts/**/*" LogicalName="kyp/%(RecursiveDir)%(Filename)%(Extension)" />
</ItemGroup>
```

```csharp
options.UseEmbeddedSnapshot(typeof(Program).Assembly);   // resources kyp/envs/..., kyp/blobs/...
```

The binary starts with zero files and zero network, then upgrades in the background as soon as the CDN answers. (`\` in resource names, as `RecursiveDir` produces on Windows, is handled.)

## ASP.NET Core

```csharp
using KeepYourPrompts;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddKeepYourPrompts(o =>
{
    o.App = "support-bot";                                // or KYP_APP; KYP_* variables are read first
    o.DeliveryKey = builder.Configuration["Kyp:DeliveryKey"];
    o.UseEmbeddedSnapshot(typeof(Program).Assembly);
});

var app = builder.Build();
app.MapGet("/healthz/prompts", (KeepYourPromptsClient p) =>
    p.Status.Ready ? Results.Ok(new { p.Status.Revision, p.Status.Source, stale = p.Status.StaleFor.TotalSeconds })
                   : Results.Problem("prompts not loaded"));
app.Run();
```

The client is a singleton created on first resolution and disposed with the container; its logs go to `ILogger` category `KeepYourPrompts` (level filtering: `LogLevel` on the options, then your logging configuration).

## Example: Claude with a managed system prompt

With the official Anthropic C# SDK (`dotnet add package Anthropic`):

```csharp
using Anthropic;
using Anthropic.Models.Messages;
using KeepYourPrompts;

await using var prompts = await KeepYourPromptsClient.FromEnvAsync();
AnthropicClient claude = new();                                     // ANTHROPIC_API_KEY

var response = await claude.Messages.Create(new MessageCreateParams
{
    Model = "claude-opus-5-5",
    MaxTokens = 16000,
    System = prompts.Render("triage", new Dictionary<string, string> { ["company"] = "Acme", ["billing_queue"] = "refunds" }),
    Messages = [new UserMessageParam { Content = "I was charged twice this month." }],
});

foreach (var text in response.Content.Select(b => b.Value).OfType<TextBlock>())
    Console.WriteLine(text.Text);
```

Editing and deploying `triage` in Keep Your Prompts changes what the next request sends, without redeploying your service. Log `prompts.Prompt("triage").Version` next to each request to know which version produced an answer.

## Observability

Link every LLM call to the exact prompt version it used, and watch delivery health, with the names shared by every
Keep Your Prompts SDK ([`protocol/tracing.md`](../protocol/tracing.md)).

**Metadata, no dependency.** `Meta(name)` and `RenderWithMeta(name, vars)` read memory only, like `Render`:

```csharp
var r = prompts.RenderWithMeta("triage", new Dictionary<string, string> { ["company"] = "Acme" });
// r.Text: the rendered prompt
// r.Meta: Name "triage", Version 7, Sha256 "f31b…", App, Env, Workspace, Revision 42, Source "cdn"
r.Meta.Attributes();        // kyp.prompt.name, kyp.prompt.version, …, gen_ai.prompt.name, gen_ai.prompt.version ("7")
r.Meta.LangfuseMetadata();  // kyp_prompt_name, kyp_prompt_version, kyp_prompt_sha256, … (flat keys)
r.Meta.LangSmithMetadata(); // the same flat map
```

**OpenTelemetry** is the separate package `KeepYourPrompts.OpenTelemetry` (the SDK keeps zero dependencies). It
uses an `ActivitySource` and a `Meter` named `keepyourprompts`:

```csharp
using KeepYourPrompts.OpenTelemetry;

builder.Services.AddOpenTelemetry()
    .WithTracing(t => t.AddKeepYourPromptsInstrumentation() /* .AddOtlpExporter() */)
    .WithMetrics(m => m.AddKeepYourPromptsInstrumentation());

var otel = prompts.AddOpenTelemetry();   // kyp.refresh activities + kyp.* metrics for this client

using var activity = source.StartActivity("chat triage");  // or the activity your model instrumentation created
var r = prompts.RenderWithMeta("triage", vars);
otel.Annotate(r);   // kyp.prompt.name/version/sha256, kyp.app/env/revision/workspace/source, gen_ai.prompt.* on Activity.Current
```

- `Annotate(name | meta | rendered, activity?, variables?)`; `activity.SetPromptAttributes(meta, ...)` works without
  an instrumentation.
- The instrumentation records a `kyp.refresh` activity per refresh round that changed something or had trouble
  (events `kyp.fallback`, `kyp.hash_mismatch`, `kyp.update`; `RefreshAsync` joins the current trace) and the metrics
  `kyp.refresh.duration`, `kyp.staleness`, `kyp.revision`, `kyp.fallbacks`, `kyp.hash_mismatches`,
  `kyp.render.errors`. To see the start-up round too, add `new KeepYourPromptsInstrumentation()` to
  `KeepYourPromptsOptions.Observers` before `CreateAsync`, then call `Attach(client)`.
- `KeepYourPromptsInstrumentationOptions`: `CaptureContent`, `GenAiAttributes` (default `true`), `OpenInference`
  (adds `prompt.vendor`, `prompt.id`, `llm.prompt_template.version` for Arize Phoenix), `TraceAllRefreshes`.
  Dispose the instrumentation to detach it.
- Without OpenTelemetry, implement `IKypObserver` (`OnRefresh`, `OnRenderError`) and pass it to `AddObserver`.

> **Privacy.** By default no prompt text and no variable value leaves your process. `CaptureContent = true` (or
> `KYP_OTEL_CAPTURE_CONTENT=true`) adds the template (`kyp.prompt.template`) and every variable passed to `Annotate`
> (`gen_ai.prompt.variable.<name>`) to your activities. Variable values often contain personal data or customer
> content, and they then reach every backend your traces go to, under its retention and access rules. Turn it on
> only where that is acceptable.

## Build and test

```sh
dotnet test KeepYourPrompts.sln                 # net8.0 and net10.0 test runs
dotnet test KeepYourPrompts.sln -f net10.0      # one runtime
dotnet pack KeepYourPrompts.sln -c Release -o artifacts
```

Tests read `../conformance` (override with `KYP_CONFORMANCE_DIR`). The conformance tests run against an in-process `HttpListener` fake that always runs, and against `conformance/fake_cdn.py` when `python3` is installed.

## Notes on the protocol

- Start-up reads every local mirror and keeps the highest revision (ties go to the earlier mirror), so a fresh disk cache beats an older embedded snapshot.
- A blob may come from any mirror: it is verified by hash, so the source does not matter. A blob that is not valid UTF-8 is rejected.
- `revision` equal to the one held counts as confirmation; lower is ignored and reported in `LastError`.
- A manifest whose `app`/`env` differ from the ones configured, or with `schema` other than 1, is rejected. Unknown fields are ignored.
