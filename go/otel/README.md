# Keep Your Prompts: Go OpenTelemetry module

`github.com/keep-your-prompts/keep-your-prompts-sdk/go/otel` (package `kypotel`) adds OpenTelemetry to the
[Go SDK](../README.md) without giving the SDK any dependency. It implements
[`protocol/tracing.md`](../../protocol/tracing.md): `kyp.*` and `gen_ai.prompt.*` attributes on your LLM spans,
`kyp.refresh` spans with `kyp.fallback`, `kyp.hash_mismatch` and `kyp.update` events, and the `kyp.*` metrics, under
the instrumentation scope `keepyourprompts`.

- Version 0.1.0 (preview), Go 1.23 or newer, `go.opentelemetry.io/otel` v1.38 or newer.
- This code is under the repository's [LICENSE](../../LICENSE).

```sh
go get github.com/keep-your-prompts/keep-your-prompts-sdk/go/otel@latest
```

```go
ins, err := kypotel.Instrument(prompts)
ctx, span := tracer.Start(ctx, "chat triage")
r, _ := prompts.RenderWithMeta("triage", kyp.Vars{"company": "Acme"})
ins.AnnotateMeta(ctx, r.Meta)
// ... call the model with r.Text ...
span.End()
```

| API | Description |
| --- | --- |
| `Instrument(c, ...Option) (*Instrumentation, error)` | Spans and metrics for a client, plus `Annotate`. |
| `New(...Option)`, `(*Instrumentation).Attach(c)` | To see the start-up round: pass `kyp.WithObserver(ins)` to `kyp.New`, then `Attach`. |
| `Annotate(ctx, name, ...)`, `AnnotateMeta(ctx, meta, ...)` | Set the attributes on the span in `ctx` (or `OnSpan(span)`). `WithVariables(vars)`, `CaptureContent(bool)`. |
| `AnnotateSpan(ctx, meta, ...)` | The same without an `Instrumentation` (`WithTemplate`, `AnnotateSpanOptions(genAI, openInference)`). |
| Options | `WithTracerProvider`, `WithMeterProvider`, `WithCaptureContent`, `WithoutGenAIAttributes`, `WithOpenInference`, `WithTraceAllRefreshes`. |
| `Shutdown()` | Stop recording. |

> **Privacy.** Content capture is off by default. `WithCaptureContent(true)` or `KYP_OTEL_CAPTURE_CONTENT=true`
> records the template and the variable values you pass, which often contain personal data, in every backend your
> traces reach. Turn it on only where that is acceptable.

Tests: `go test -race ./...` (in-memory span exporter and manual metric reader).
