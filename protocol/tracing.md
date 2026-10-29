# Tracing and observability

How every Keep Your Prompts SDK reports, in traces and metrics, **which deployed prompt version a call used** and
**how delivery is doing**. All SDKs use the names on this page so one dashboard or query works whatever language the
app is written in. This page is normative for the SDKs in this repository; the [delivery protocol](README.md) is
unchanged by it.

Status: **v1, preview** (SDK version 0.1.0). Names marked *stable here* will not change without a major version.

## Contents

1. [Goals](#goals)
2. [Background: what observability tools use today](#background-what-observability-tools-use-today)
3. [Prompt metadata](#prompt-metadata)
4. [Attributes on the app's LLM span](#attributes-on-the-apps-llm-span)
5. [Content capture (opt-in)](#content-capture-opt-in)
6. [Metadata maps for Langfuse, LangSmith and others](#metadata-maps-for-langfuse-langsmith-and-others)
7. [SDK spans and span events](#sdk-spans-and-span-events)
8. [Metrics](#metrics)
9. [Outcome reporting](#outcome-reporting)
10. [SDK architecture: no hard dependency on OpenTelemetry](#sdk-architecture-no-hard-dependency-on-opentelemetry)
11. [Conformance checklist](#conformance-checklist)

## Goals

- **Link every LLM call to the exact prompt body it used**: name, version, SHA-256, app, env, revision, workspace and
  which mirror served it, on the span the app already has for that call (created by the app, by an OpenTelemetry
  instrumentation for the model SDK, or by an observability vendor's SDK).
- **Make delivery observable**: refresh latency, how stale the held state is, fallbacks between mirrors, hash
  mismatches and render errors, as spans, span events and metrics.
- **Private by default**: no prompt text, rendered output or variable values leave the process unless the app turns
  on `captureContent`.
- **No hard dependency**: the core packages stay dependency-free. OpenTelemetry support is an optional add-on
  (package extra, submodule, optional peer dependency or separate package).

## Background: what observability tools use today

Researched in October 2026.

| System | How a call is linked to a prompt version | Consequence for us |
| --- | --- | --- |
| **OpenTelemetry GenAI semantic conventions** (moved in 2026 from `open-telemetry/semantic-conventions` to the dedicated `open-telemetry/semantic-conventions-genai` repository; every `gen_ai.*` attribute is still **Development** stability) | `gen_ai.prompt.name` (conditionally required "when a named prompt template is used"), `gen_ai.prompt.version` (string; "SHOULD match the version identifier used by [the prompt management] system"), `gen_ai.prompt.variable.<key>` (**opt-in**, may hold sensitive data). Message content (`gen_ai.input.messages`, `gen_ai.system_instructions`, `gen_ai.output.messages`) is opt-in too. | We set `gen_ai.prompt.name` and `gen_ai.prompt.version` next to our own `kyp.*` attributes. Variables only with `captureContent`. Because the GenAI conventions can still change, our `kyp.*` names are the durable contract. |
| **Langfuse** | Prompt linking works for prompts managed *in Langfuse* (`langfuse.observation.prompt.name` / `.version` on OTel spans, or the `prompt` argument of its SDK). Free-form metadata: `langfuse.observation.metadata.<key>` / `langfuse.trace.metadata.<key>` on OTel spans, or `metadata={...}` in its SDK. Also reads `gen_ai.*` and `deployment.environment.name`. | We do **not** set `langfuse.*.prompt.*`: Langfuse would look for a Langfuse-managed prompt with that name. We offer a metadata map instead (see below); Langfuse's OTel endpoint also keeps the `kyp.*` and `gen_ai.prompt.*` attributes. |
| **LangSmith** | Run metadata (`metadata={...}` in its SDK, `langsmith.metadata.<key>` on OTel spans), filterable in the UI and API. LangChain Hub prompts add their own metadata keys. | Metadata map with flat keys. |
| **Helicone** | Request headers: `Helicone-Property-<Name>` custom properties (plus `Helicone-Session-Id`, `Helicone-User-Id`). | The same flat map, sent as `Helicone-Property-<key>` headers. |
| **Datadog LLM Observability** | Its SDK's prompt annotation (`id`, `version`, `template`, `variables`) and prompt tracking; it also ingests OTLP spans that follow the OTel GenAI conventions. | `gen_ai.prompt.*` plus `kyp.*` on the span; with ddtrace, pass `{"id": name, "version": str(version)}` (template and variables only if you accept that content). |
| **Arize Phoenix / OpenInference** | `prompt.vendor`, `prompt.id`, `prompt.url`, `llm.prompt_template.version`, and (content) `llm.prompt_template.template`, `llm.prompt_template.variables`. | Optional OpenInference alias set (below). |
| **Grafana** (Tempo, Grafana Cloud AI Observability, built on OpenLIT) | Any span attribute, queried with TraceQL; dashboards use `gen_ai.*`. | `{ span.kyp.prompt.name = "triage" && span.kyp.prompt.version = 7 }` works as is; our metrics feed Mimir/Prometheus dashboards. |

## Prompt metadata

Every SDK exposes, for a prompt held in memory, a **prompt metadata** value read from memory only (no I/O, no locks
beyond the read path's own). All fields come from one consistent state: the metadata returned together with a
rendered prompt describes exactly the body that was rendered.

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | string | Prompt name, e.g. `triage`, `agents/reviewer`. |
| `version` | integer | Prompt version from the manifest. |
| `sha256` | string | 64 lowercase hex: the body actually used. |
| `app`, `env` | string | App and environment slugs the client is configured with. |
| `workspace` | string | `workspace` from the manifest. |
| `revision` | integer | Manifest revision held. |
| `source` | string | Normalised mirror kind that served or last confirmed the state (see below). |

Canonical API, spelled idiomatically per language (`meta`/`Meta`/`getMeta`, `renderWithMeta`/`render_with_meta`/
`RenderWithMeta`):

- `meta(name) -> PromptMeta`: throws/returns the SDK's not-found error for an unknown prompt.
- `renderWithMeta(name, vars, options) -> { text, meta }`: like `render`, plus the metadata of the body used.
- `PromptMeta.attributes() -> map`: the span attributes below (plain map, no OpenTelemetry types).
- `PromptMeta.traceMetadata()`, `langfuseMetadata()`, `langsmithMetadata()` -> map: the flat metadata maps below.

### `kyp.source` values

| Value | Mirror |
| --- | --- |
| `embedded` | Snapshot compiled into the binary or bundle (Go `embed`, TS module, resources). |
| `snapshot` | Snapshot folder shipped with the app (and any other folder mirror the app configures). |
| `cache` | The SDK's disk cache (`status().source` may call it `disk-cache`). |
| `cdn` | `cdn.keepyourprompts.com`. |
| `origin` | `api.keepyourprompts.com`. |
| `git` | The workspace's git mirror. |
| `custom` | A network mirror the app added whose name is none of the above. |

Normalisation: a mirror named `embedded`, `snapshot`, `cache`, `disk-cache`, `cdn`, `origin` or `git` maps to that
value (`disk-cache` to `cache`); otherwise an embedded mirror is `embedded`, a folder is `snapshot`, a network mirror
is `custom`. The configured mirror name itself is reported as `kyp.mirror` on SDK spans only. Before anything is
loaded the source is the empty string and the attribute is omitted.

## Attributes on the app's LLM span

The app annotates **its own** span for the model call (the current active span by default) with the prompt it used.
SDKs never create a span for `get`/`render`: reads stay allocation-light and span-free.

| Attribute | Type | Example | Notes |
| --- | --- | --- | --- |
| `kyp.prompt.name` | string | `triage` | *stable here* |
| `kyp.prompt.version` | int | `7` | *stable here* |
| `kyp.prompt.sha256` | string | `a3f9c1…` (64 hex) | *stable here*; the precise link to the body |
| `kyp.app` | string | `support-bot` | *stable here* |
| `kyp.env` | string | `prod` | *stable here* |
| `kyp.revision` | int | `42` | *stable here* |
| `kyp.workspace` | string | `acme` | *stable here*; omitted when empty |
| `kyp.source` | string enum | `cdn` | *stable here*; see the table above; omitted when empty |
| `gen_ai.prompt.name` | string | `triage` | OTel GenAI (Development): same value as `kyp.prompt.name` |
| `gen_ai.prompt.version` | **string** | `"7"` | OTel GenAI (Development): decimal string of `kyp.prompt.version` |

- Set both families by default. An app may turn off the `gen_ai.prompt.*` pair (`genAiAttributes: false`), for
  example when its model instrumentation already sets them for another prompt system.
- **OpenInference aliases (opt-in, `openInference: true`)**: `prompt.vendor` = `keepyourprompts`,
  `prompt.id` = `<app>/<env>/<name>`, `llm.prompt_template.version` = decimal version string. With content capture
  also `llm.prompt_template.template` and `llm.prompt_template.variables` (JSON object).
- `annotate` overwrites attributes already on the span with the same keys (a span describes one call and one prompt).
  For a call built from several prompts, annotate with the main (system) prompt; record the others with
  `kyp.prompts` (string array of `name@version`) if needed. SDKs MAY offer that, it is not required.
- Annotating a span that is not recording (sampled out, no SDK installed) is a cheap no-op.

### The `annotate` helper

Canonical form, adapted per language (in the OpenTelemetry add-on):

```
annotate(prompt: name | PromptMeta | Rendered, options?: { span?, variables?, captureContent? }) -> PromptMeta
```

- `span` defaults to the **current active span** of the OpenTelemetry context.
- `variables` are only recorded when content capture is on (see below); otherwise ignored.
- Returns the metadata, so the app can pass it to `report` (outcomes) or a vendor SDK.
- Never throws for telemetry reasons; an unknown prompt name raises the SDK's not-found error as `meta` does.

## Content capture (opt-in)

Off by default. Turned on with `captureContent: true` on the OpenTelemetry add-on (or per `annotate` call), or with
the environment variable `KYP_OTEL_CAPTURE_CONTENT=true`. When on, `annotate` additionally sets:

| Attribute | Value |
| --- | --- |
| `kyp.prompt.template` | The raw template text (not the rendered prompt). |
| `gen_ai.prompt.variable.<name>` | Each variable value passed to `annotate`, as a string (OTel GenAI, opt-in level). |

> **Privacy warning.** Templates can contain proprietary instructions, and variable values often contain personal
> data, customer content or secrets (names, emails, ticket text, API responses). With `captureContent` on, these go
> to every exporter and backend your OpenTelemetry pipeline sends to, are retained under that backend's retention
> policy, and are visible to everyone with access to it. Turn it on only in environments where that is acceptable
> (for example staging), consider redaction processors in your collector, and never in a process that handles data
> you may not export. SDK spans and metrics never contain content, whatever this flag says.

Rendered prompts are never attached by the SDK: the model instrumentation's own opt-in message capture
(`gen_ai.input.messages`, `gen_ai.system_instructions`) is the place for them.

## Metadata maps for Langfuse, LangSmith and others

Plain maps (no dependency on any vendor SDK) with **flat keys**: the attribute name with every `.` replaced by `_`.
Flat keys avoid backends that turn dots in metadata keys into nested objects (Langfuse's
`langfuse.observation.metadata.<key>` mapping, Helicone headers, LangSmith's metadata filter).

| Key | Type |
| --- | --- |
| `kyp_prompt_name` | string |
| `kyp_prompt_version` | int |
| `kyp_prompt_sha256` | string |
| `kyp_app`, `kyp_env` | string |
| `kyp_revision` | int |
| `kyp_workspace` | string (omitted when empty) |
| `kyp_source` | string (omitted when empty) |

- `traceMetadata()` returns exactly this map. `langfuseMetadata()` and `langsmithMetadata()` return the same map
  today; they are separate so each can follow its vendor if that ever requires it. No content keys, ever.
- Langfuse: `langfuse.update_current_generation(metadata=meta.langfuse_metadata())` (or the `metadata` of any
  observation); on raw OTel spans: `langfuse.observation.metadata.<key>`.
- LangSmith: `@traceable(metadata=...)`, `langsmith_extra={"metadata": ...}`, or `langsmith.metadata.<key>` on
  OTel spans.
- Helicone: send each entry as a `Helicone-Property-<key>` header.

## SDK spans and span events

Created only by the OpenTelemetry add-on, under the instrumentation scope (tracer and meter name)
**`keepyourprompts`** with the SDK version, so all languages share one scope name.

### Span `kyp.refresh`

One span per refresh round (start-up load, background poll or manual `refresh()`), kind `INTERNAL`, recorded
with the round's real start and end time. A background poll is a root span; a manual refresh is a child of the
caller's active span when the language makes that possible, a root span otherwise.

| Attribute | Type | Notes |
| --- | --- | --- |
| `kyp.app`, `kyp.env` | string | |
| `kyp.refresh.trigger` | string | `start`, `poll` or `manual` |
| `kyp.refresh.result` | string | `updated` (a new revision was installed), `not_modified` (a mirror confirmed what is held: `304` or same revision), `failed` (no mirror answered) |
| `kyp.revision` | int | Revision held after the round (omitted when nothing is held) |
| `kyp.workspace` | string | When known |
| `kyp.source`, `kyp.mirror` | string | Mirror that answered (omitted when `failed`) |
| `error.type` | string | Only when `failed`: the error type of the last failure (values below) |

Status `ERROR` with a short description (delivery key redacted) when the result is `failed`, unset otherwise.

To keep trace volume sane, rounds whose result is `not_modified` **and** that had no span event are not exported
by default (they are the 30-second heartbeat). Option `traceAllRefreshes: true` records them too. Metrics always
count every round.

### Span events (on `kyp.refresh`)

| Event | When | Attributes |
| --- | --- | --- |
| `kyp.fallback` | A mirror failed (error, not found, bad or stale manifest, missing blob) and the round moved on to the next mirror or ran out of mirrors | `kyp.mirror`, `kyp.source` (of the failed mirror), `error.type`, `kyp.error` (short message, key redacted) |
| `kyp.hash_mismatch` | A blob's SHA-256 did not match its name and was discarded | `kyp.mirror`, `kyp.source`, `kyp.blob.sha256` (the expected hash) |
| `kyp.update` | A new revision was installed | `kyp.revision.previous` (0 if none), `kyp.revision`, `kyp.prompts.changed` (int, count of changed prompts) |

`error.type` values (low cardinality): `timeout`, `network`, `http_<status>` (e.g. `http_503`), `not_found`
(`404`/`410` or a missing file), `bad_manifest`, `stale` (lower revision than held), `hash_mismatch`,
`blob_unavailable`, `_OTHER` (anything else).

## Metrics

Instrument names and units follow OpenTelemetry naming rules. Common attributes on every metric: `kyp.app`,
`kyp.env`.

| Instrument | Kind | Unit | Extra attributes | Meaning |
| --- | --- | --- | --- | --- |
| `kyp.refresh.duration` | Histogram | `s` | `kyp.refresh.trigger`, `kyp.refresh.result`, `kyp.source` (when answered) | Wall time of each refresh round |
| `kyp.staleness` | Gauge (observable) | `s` | | Seconds since a mirror last confirmed the held state (`status().staleFor`); alert on it |
| `kyp.revision` | Gauge (observable) | `{revision}` | | Revision held (0 when nothing) |
| `kyp.fallbacks` | Counter | `{fallback}` | `kyp.source`, `kyp.mirror`, `error.type` | Count of `kyp.fallback` events |
| `kyp.hash_mismatches` | Counter | `{blob}` | `kyp.source`, `kyp.mirror` | Count of `kyp.hash_mismatch` events |
| `kyp.render.errors` | Counter | `{error}` | `kyp.prompt.name`, `error.type` (`not_found`, `missing_variable`) | `render`/`renderWithMeta` failures |

Recommended histogram buckets for `kyp.refresh.duration` (seconds): `0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1,
2.5, 5, 10` (SDKs pass them as advice where the language API supports it).

Example alerts: `max(kyp_staleness_seconds) > 600` (nothing confirmed in 10 minutes), `rate(kyp_fallbacks_total[5m])
> 0` on `kyp_source="cdn"`, `increase(kyp_hash_mismatches_total[1h]) > 0`.

## Outcome reporting

[Outcome reporting](README.md#clarifications) (clarification 7) uses the same metadata: `report` accepts a
`PromptMeta` (or the result of `renderWithMeta`) in place of a prompt name, and then sends **its** `sha256`, so an
outcome is attributed to the body the call actually used even when a new revision arrived between render and report.
Reporting by name keeps working (it uses the body held at report time). The wire format is unchanged.
SDKs without outcome reporting (Java, .NET, C++, Rust, Swift, PHP and Ruby today) simply have nothing to wire.

## SDK architecture: no hard dependency on OpenTelemetry

The core package has no telemetry dependency. It exposes:

1. **Prompt metadata** and the plain-map helpers above.
2. **An observer hook**: `addObserver(observer) -> unsubscribe` (and/or an `observer` option). The core calls it
   on the thread or task that ran the refresh round (never while holding a lock the read path takes), and on the
   read path only for render errors, with:
   - `onRefresh(RefreshRecord)` after each round: `trigger`, `result`, `startTime` (wall clock), `duration`,
     `mirror`/`source` of the answering mirror, `revision`, `previousRevision`, `workspace`, `error`/`errorType`
     when failed, and the ordered list of span events (`kyp.fallback`, `kyp.hash_mismatch`, `kyp.update`) with their
     wall-clock time and attributes.
   - `onRenderError(name, errorType)` when `render`/`renderWithMeta` fails.
   An observer that throws is caught and logged; it never breaks the client.
3. **The OpenTelemetry add-on** (`instrument(client, options)` or language equivalent) registers an observer that
   turns records into `kyp.refresh` spans with events and into metrics, registers the observable gauges, and offers
   `annotate`. Options: `tracerProvider`, `meterProvider` (default: the global ones), `captureContent` (default
   `false`, or `KYP_OTEL_CAPTURE_CONTENT`), `genAiAttributes` (default `true`), `openInference` (default `false`),
   `traceAllRefreshes` (default `false`). `annotate` works without `instrument` too, as a free function.

| Language | Add-on |
| --- | --- |
| TypeScript | subpath `@keepyourprompts/sdk/otel`, `@opentelemetry/api` as an optional peer dependency |
| Python | extra `keepyourprompts[otel]`, module `keepyourprompts.otel` |
| Go | submodule `github.com/keep-your-prompts/keep-your-prompts-sdk/go/otel` (own `go.mod`) |
| Java | `com.keepyourprompts.otel` package; `io.opentelemetry:opentelemetry-api` as an `optional` Maven dependency |
| .NET | package `KeepYourPrompts.OpenTelemetry` (`ActivitySource`/`Meter` named `keepyourprompts`; core stays dependency-free) |
| C++, Rust, Swift, PHP, Ruby | same names; see each SDK's README |

## Conformance checklist

Each SDK that implements this page has tests (with an in-memory exporter) for:

1. `meta(name)` returns all fields; `renderWithMeta` returns the metadata of the rendered body.
2. `annotate` on the active span sets the eight `kyp.*` attributes and `gen_ai.prompt.name`/`gen_ai.prompt.version`
   (version as a string), and no content attribute.
3. With `captureContent`, `annotate` adds `kyp.prompt.template` and `gen_ai.prompt.variable.<name>`.
4. The metadata maps have exactly the flat keys above.
5. A start-up and an update produce `kyp.refresh` spans with `kyp.update`; a failing first mirror produces a
   `kyp.fallback` event and increments `kyp.fallbacks`; a tampered blob produces `kyp.hash_mismatch`.
6. `kyp.refresh.duration` is recorded per round; `kyp.staleness` and `kyp.revision` are observable.
7. A render with a missing variable increments `kyp.render.errors` with `error.type=missing_variable`.
8. `report` with a `PromptMeta` sends that metadata's `sha256`.
