# KeepYourPrompts.OpenTelemetry

OpenTelemetry for the [Keep Your Prompts .NET SDK](https://github.com/keep-your-prompts/keep-your-prompts-sdk/tree/main/dotnet),
implementing [`protocol/tracing.md`](https://github.com/keep-your-prompts/keep-your-prompts-sdk/blob/main/protocol/tracing.md):
`kyp.*` and `gen_ai.prompt.*` attributes on your LLM activities, `kyp.refresh` activities with `kyp.fallback`,
`kyp.hash_mismatch` and `kyp.update` events, and the `kyp.*` metrics, from an `ActivitySource` and a `Meter` named
`keepyourprompts`. Version 0.1.0 (preview); net8.0 and netstandard2.0. License: the repository's `LICENSE` file
(`LicenseRef-Republic-Lex-Aequa-1.0`).

```sh
dotnet add package KeepYourPrompts.OpenTelemetry
```

```csharp
using KeepYourPrompts.OpenTelemetry;

builder.Services.AddOpenTelemetry()
    .WithTracing(t => t.AddKeepYourPromptsInstrumentation())
    .WithMetrics(m => m.AddKeepYourPromptsInstrumentation());

var otel = prompts.AddOpenTelemetry();
var r = prompts.RenderWithMeta("triage", vars);
otel.Annotate(r);   // on Activity.Current
```

| API | Description |
| --- | --- |
| `TracerProviderBuilder.AddKeepYourPromptsInstrumentation()`, `MeterProviderBuilder.AddKeepYourPromptsInstrumentation()` | Listen to the `keepyourprompts` source and meter. |
| `client.AddOpenTelemetry(options?)` / `KeepYourPromptsInstrumentation.Instrument(client, options?)` | Record activities and metrics for a client. |
| `new KeepYourPromptsInstrumentation(options?)` + `KeepYourPromptsOptions.Observers` + `Attach(client)` | The same, including the start-up round. |
| `Annotate(name \| PromptMeta \| Rendered, activity?, variables?)` | Set the attributes on `activity` (default `Activity.Current`). |
| `Activity.SetPromptAttributes(meta, variables?, template?, captureContent, genAiAttributes, openInference)` | Without an instrumentation. |
| `KeepYourPromptsInstrumentationOptions` | `CaptureContent`, `GenAiAttributes`, `OpenInference`, `TraceAllRefreshes`. |

> **Privacy.** Content capture is off by default. `CaptureContent = true` or `KYP_OTEL_CAPTURE_CONTENT=true` records
> the template and the variable values you pass, which often contain personal data, in every backend your traces
> reach. Turn it on only where that is acceptable.
