# Keep Your Prompts SDKs

[Keep Your Prompts](https://keepyourprompts.com) is version control and deployment for prompts. You write and
version prompts, system prompts and agent skills in one library, deploy a set of versions to an app environment
(`support-bot` / `prod`), and roll back when you need to. This repository is how those deployed prompts reach your code:

- **Delivered over a CDN**, with fallbacks: a snapshot bundled with your app, a disk cache, our origin API and your
  own git repository all hold the same files, and the SDK treats them as interchangeable mirrors.
- **Hash-verified**: every prompt body is content-addressed by SHA-256 and checked on arrival, so no mirror has to be
  trusted.
- **Read from memory**: `get` and `render` do no I/O and take no locks. A background refresher picks up new deploys
  within a poll interval (30 s by default) and keeps serving the last good version when the network does not.

> **Preview.** Every package here is version 0.1.0 and **not published to its registry yet**. The install lines
> below are what they will be at release.

## SDKs

| Language | Package | Install | Minimum runtime | Folder |
| --- | --- | --- | --- | --- |
| C++ | CMake target `kyp::kyp` | CMake `FetchContent` (see [cpp/](cpp/README.md#install)) | C++17, CMake 3.20 | [`cpp/`](cpp) |
| TypeScript / JavaScript | `@keepyourprompts/sdk` | `npm install @keepyourprompts/sdk` | Node 18, Bun, Deno, Workers, browsers | [`typescript/`](typescript) |
| Python | `keepyourprompts` | `pip install keepyourprompts` | Python 3.9 | [`python/`](python) |
| Go | `github.com/keep-your-prompts/keep-your-prompts-sdk/go` | `go get github.com/keep-your-prompts/keep-your-prompts-sdk/go@latest` | Go 1.22 | [`go/`](go) |
| Java / Kotlin | `com.keepyourprompts:kyp-sdk` | Maven / Gradle: `implementation("com.keepyourprompts:kyp-sdk:0.1.0")` | Java 17 | [`java/`](java) |
| C# / .NET | `KeepYourPrompts.Sdk` (+ `KeepYourPrompts.Extensions.DependencyInjection`) | `dotnet add package KeepYourPrompts.Sdk` | .NET 8, or netstandard2.0 (.NET Framework 4.6.2) | [`dotnet/`](dotnet) |
| Rust | `keepyourprompts` (imported as `kyp`) | `cargo add keepyourprompts` | Rust 1.75 | [`rust/`](rust) |
| Swift | SwiftPM library `KeepYourPrompts` | `.package(url: "https://github.com/keep-your-prompts/keep-your-prompts-sdk.git", from: "0.1.0")` | Swift 5.9; iOS 15, macOS 12, tvOS 15, watchOS 8, visionOS 1, Linux | [`swift/`](swift) |
| PHP | `keepyourprompts/sdk` | `composer require keepyourprompts/sdk` | PHP 8.1 | [`php/`](php) |
| Ruby | `keepyourprompts` | `gem "keepyourprompts", "~> 0.1"` | Ruby 3.1 | [`ruby/`](ruby) |

Every SDK has few or no runtime dependencies, implements the same [delivery protocol](protocol/README.md)
and passes the same [conformance suite](conformance/README.md). Each folder's README has the full API.

### C++ quickstart

```cpp
#include <kyp/kyp.hpp>

int main() {
  auto prompts = kyp::Client::from_env();  // KYP_DELIVERY_KEY, KYP_APP, KYP_ENV
  std::string system_prompt = prompts.render("triage", {
      {"company", "Acme"},
      {"billing_queue", "refunds"},
  });
}
```

### TypeScript quickstart

```ts
import { Client } from '@keepyourprompts/sdk';

// Set KYP_DELIVERY_KEY (kypd_...), KYP_APP=support-bot and optionally KYP_ENV=prod.
const prompts = await Client.fromEnv();

prompts.get('triage');                                    // the raw template
prompts.render('triage', { company: 'Acme' });            // filled in; throws on a missing variable
prompts.onUpdate((u) => console.log(`now at revision ${u.newRevision}:`, u.changed));
console.log(prompts.status());                            // which mirror served it, how stale it is
```

A delivery key (`kypd_...`) is read-only and scoped to a workspace and its apps: create one in the app under
Settings > Delivery keys and keep it server-side.

## Observability

Every SDK can tell your traces **which deployed prompt version a call used**, and report how delivery is doing,
with the same names in every language ([`protocol/tracing.md`](protocol/tracing.md)):

- `meta(name)` / `renderWithMeta(name, vars)` return the prompt's name, version, SHA-256, app, env, workspace,
  revision and which mirror served it, from memory, with helpers that turn it into span attributes or into flat
  metadata maps for Langfuse, LangSmith and Helicone (no dependency on any of them).
- An optional OpenTelemetry add-on puts `kyp.prompt.name`, `kyp.prompt.version`, `kyp.prompt.sha256`, `kyp.app`,
  `kyp.env`, `kyp.revision`, `kyp.workspace`, `kyp.source` and the GenAI convention's `gen_ai.prompt.name` /
  `gen_ai.prompt.version` on **your** LLM span, records `kyp.refresh` spans (events `kyp.fallback`,
  `kyp.hash_mismatch`, `kyp.update`), and the metrics `kyp.refresh.duration`, `kyp.staleness`, `kyp.revision`,
  `kyp.fallbacks`, `kyp.hash_mismatches` and `kyp.render.errors`.
- **No prompt text or variable values** leave your process unless you turn on `captureContent`.

| SDK | OpenTelemetry add-on |
| --- | --- |
| TypeScript | `@keepyourprompts/sdk/otel` (`@opentelemetry/api` as an optional peer dependency) |
| Python | `pip install "keepyourprompts[otel]"`, module `keepyourprompts.otel` |
| Go | module `github.com/keep-your-prompts/keep-your-prompts-sdk/go/otel` |
| Java / Kotlin | `com.keepyourprompts.otel` (add `io.opentelemetry:opentelemetry-api`, an optional dependency) |
| C# / .NET | package `KeepYourPrompts.OpenTelemetry` |
| C++ | CMake `-DKYP_WITH_OTEL=ON`, target `kyp::otel` (`<kyp/otel.hpp>`); `<kyp/tracing.hpp>` bridges any tracer |
| Rust | cargo feature `otel` (`kyp::otel`) |
| Swift | product `KeepYourPromptsOTel` |
| PHP | `KeepYourPrompts\OpenTelemetry\Instrumentation` (suggests `open-telemetry/api`) |
| Ruby | `require "keepyourprompts/otel"` (with `opentelemetry-api`) |

```ts
import { instrument } from '@keepyourprompts/sdk/otel';

const otel = instrument(prompts);
const { text, meta } = prompts.renderWithMeta('triage', { company: 'Acme' });
otel.annotate(meta);                                  // on the active span: your model call's span
prompts.report({ prompt: meta, outcome: 'success' }); // outcomes count against the body you actually used
```

## Framework adapters

Separate packages under [`adapters/`](adapters/README.md) plug deployed prompts into AI frameworks. Each depends on the
matching core SDK and on the framework; rendering, strict variables and memory-only reads are the core SDK's, and
every adapter exposes the prompt's name, version and SHA-256 for tracing.

| Framework | Package | Folder |
| --- | --- | --- |
| Vercel AI SDK | `@keepyourprompts/ai-sdk` | [`adapters/vercel-ai/`](adapters/vercel-ai) |
| LangChain.js | `@keepyourprompts/langchain` | [`adapters/langchain-js/`](adapters/langchain-js) |
| LangChain (Python) | `keepyourprompts-langchain` | [`adapters/langchain-python/`](adapters/langchain-python) |
| LlamaIndex | `keepyourprompts-llamaindex` | [`adapters/llamaindex-python/`](adapters/llamaindex-python) |
| OpenAI Agents SDK (Python) | `keepyourprompts-openai-agents` | [`adapters/openai-agents-python/`](adapters/openai-agents-python) |
| OpenAI Agents SDK (JS) | `@keepyourprompts/openai-agents` | [`adapters/openai-agents-js/`](adapters/openai-agents-js) |
| Claude Agent SDK (TypeScript) | `@keepyourprompts/claude-agent-sdk` | [`adapters/claude-agent-sdk-ts/`](adapters/claude-agent-sdk-ts) |
| Claude Agent SDK (Python) | `keepyourprompts-claude-agent-sdk` | [`adapters/claude-agent-sdk-python/`](adapters/claude-agent-sdk-python) |
| Spring AI | `com.keepyourprompts:kyp-spring-ai` | [`adapters/spring-ai/`](adapters/spring-ai) |
| Semantic Kernel (.NET) | `KeepYourPrompts.SemanticKernel` | [`adapters/semantic-kernel-dotnet/`](adapters/semantic-kernel-dotnet) |

## How availability works

Prompt bodies never change (`blobs/<sha256>`); only a small manifest per app environment (`envs/<app>/<env>.json`)
says which body is live. Every copy of a workspace uses that same layout, so the SDK tries them in order:

| Mirror | Depends on our API? |
| --- | --- |
| Snapshot bundled with your app (folder, or compiled into the binary) | No |
| Disk cache written by the SDK | No |
| CDN `cdn.keepyourprompts.com` (Cloudflare over R2) | No |
| Origin `api.keepyourprompts.com` | Yes |
| Your git repository (when the workspace syncs to git) | No |

- **Start-up** reads the local mirrors first, so an app with a snapshot starts with zero network.
- **Refresh** revalidates the manifest every 30 s with `If-None-Match` (a `304` costs nothing), fetches only new
  bodies, verifies each hash, then swaps the whole state atomically. A stale mirror (lower revision) is ignored.
- **Failures never evict** what is held. A failing mirror backs off; `status()` reports which mirror served the
  state and how stale it is, so you can alert on it.

Any one mirror is enough, and the in-memory state keeps serving through all of them failing. The full specification,
including caching headers and delivery keys, is in [`protocol/README.md`](protocol/README.md).

## The `kyp` CLI

[`cli/`](cli/README.md) is a single binary for snapshots and workspace management: `kyp pull` writes a snapshot for
your build (optionally as Go `embed` or a TypeScript module), `kyp get` prints a rendered prompt, and `kyp push`,
`diff`, `deploy`, `rollback` and friends manage the workspace from a terminal or CI.

```sh
go install github.com/keep-your-prompts/keep-your-prompts-sdk/cli/cmd/kyp@latest
kyp pull --app support-bot --env prod --out ./prompts      # uses $KYP_DELIVERY_KEY
```

Prebuilt binaries will be attached to `cli-v*` GitHub releases.

## Integrations

Use your prompt library from AI apps and coding agents. Everything talks to one remote MCP server:
**`https://api.keepyourprompts.com/mcp`** (OAuth sign-in, or a workspace API key). See
[`integrations/`](integrations/README.md) for every client.

| Client | How |
| --- | --- |
| Claude Code | `/plugin marketplace add keep-your-prompts/keep-your-prompts-sdk` then `/plugin install kyp@keep-your-prompts` ([plugin](integrations/claude-code-plugin)) |
| claude.ai, Claude Desktop | Settings > Connectors > Add custom connector > `https://api.keepyourprompts.com/mcp`; API-key alternative for Desktop: the [`.mcpb` bundle](integrations/claude-desktop) |
| ChatGPT | Developer mode: add a custom MCP server with the URL above; the [plugin package](integrations/chatgpt) is awaiting directory review |
| Gemini CLI | `gemini extensions install ./integrations/gemini-cli` from a clone ([extension](integrations/gemini-cli)), or `gemini mcp add --transport http keep-your-prompts https://api.keepyourprompts.com/mcp` |
| Other MCP clients | Cursor, VS Code, Windsurf, Zed, Codex, JetBrains: see [`integrations/README.md`](integrations/README.md); registry entry in [`integrations/mcp-registry/`](integrations/mcp-registry/server.json) |

## Automation apps

No-code platforms reach your workspace through the REST API and signed webhooks (Standard Webhooks): react to saved
versions, deploys, reviews and captures, and find, render, version and deploy prompts from a workflow. See
[`automation/`](automation/README.md).

| Platform | Package | Status |
| --- | --- | --- |
| n8n | Community nodes `n8n-nodes-keepyourprompts` ([`automation/n8n/`](automation/n8n)): an action node and a trigger | Not on npm yet |
| Zapier | Zapier Platform CLI app ([`automation/zapier/`](automation/zapier)): instant triggers, a search and actions | Not pushed to Zapier yet |
| Make | Custom app source for Make's VS Code extension ([`automation/make/`](automation/make)) | Not deployed to Make yet |

## Conformance suite

[`conformance/`](conformance/README.md) holds table-driven cases (`cases.json`), complete fixture mirrors and a
small fake CDN (`fake_cdn.py`, Python standard library only). The SDKs run it in CI against its 12 required
behaviours, so a prompt renders and refreshes identically in every language (the C++ SDK covers the same behaviours
with its own fixtures in `cpp/tests/`). Writing a client in another language?
Start there.

## Licence

The code in this repository is **source-available**, not open source. It is published under
[The Republic Lex Aequa License 1.0](LICENSE) (SPDX `LicenseRef-Republic-Lex-Aequa-1.0`). In plain words:

- **You may** use it for free, including commercially, in production, and inside products you build and sell
  (including for clients and in app stores). You may read, copy and modify it.
- **You may not** use it to offer a prompt-management service that competes with Keep Your Prompts, or rebrand it
  and distribute it as your own SDK, CLI or integration.

This summary is not the licence: [LICENSE](LICENSE) is what applies.

## Contributing

We are not accepting outside pull requests yet: contributions will need a contributor licence agreement, which is
not available yet. **Issues are welcome**: bug reports, protocol questions and requests for a language or
integration help us most.

## Security

Please report vulnerabilities privately to **security@keepyourprompts.com**, not in a public issue.
