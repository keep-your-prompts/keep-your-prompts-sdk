# Framework adapters

Packages that plug prompts deployed with Keep Your Prompts into AI frameworks. Each one is a separate package that
depends on the matching core SDK (by its published name) and on the framework, so the core SDKs stay dependency-free.

> **Preview.** Every adapter is version 0.1.0 and **not published yet**. The install lines are what they will be.

| Framework | Folder | Package | What it gives you |
| --- | --- | --- | --- |
| Vercel AI SDK 7 | [`vercel-ai/`](vercel-ai) | npm `@keepyourprompts/ai-sdk` | `instructions` / `messages` for `generateText` and `streamText`, and a middleware that tags each call with the prompt version |
| LangChain.js 1.x | [`langchain-js/`](langchain-js) | npm `@keepyourprompts/langchain` | `PromptTemplate` / `ChatPromptTemplate` loaders, hub-like `pull(name)`, `livePrompt` |
| LangChain (Python) 1.x | [`langchain-python/`](langchain-python) | PyPI `keepyourprompts-langchain` | the same, for `langchain-core` |
| LlamaIndex 0.14 | [`llamaindex-python/`](llamaindex-python) | PyPI `keepyourprompts-llamaindex` | `PromptTemplate` / `ChatPromptTemplate` / `RichPromptTemplate`, `kyp_update_prompts` |
| OpenAI Agents SDK (Python) 0.24 | [`openai-agents-python/`](openai-agents-python) | PyPI `keepyourprompts-openai-agents` | dynamic `instructions` rendered per run |
| OpenAI Agents SDK (JS) 0.21 | [`openai-agents-js/`](openai-agents-js) | npm `@keepyourprompts/openai-agents` | dynamic `instructions` rendered per run |
| Claude Agent SDK (TS) 0.3 | [`claude-agent-sdk-ts/`](claude-agent-sdk-ts) | npm `@keepyourprompts/claude-agent-sdk` | system prompt, subagents and skills from deployed prompts, per session |
| Claude Agent SDK (Python) 0.2 | [`claude-agent-sdk-python/`](claude-agent-sdk-python) | PyPI `keepyourprompts-claude-agent-sdk` | the same, for `claude-agent-sdk` |
| Spring AI 2.0 | [`spring-ai/`](spring-ai) | Maven `com.keepyourprompts:kyp-spring-ai` | a `TemplateRenderer`, `PromptTemplate` / `Prompt` factory and Spring Boot auto-configuration |
| Semantic Kernel (.NET) 1.x | [`semantic-kernel-dotnet/`](semantic-kernel-dotnet) | NuGet `KeepYourPrompts.SemanticKernel` | an `IPromptTemplateFactory` (`template_format: kyp`) and `KernelFunction`s from deployed prompts |

## What every adapter guarantees

- **Same rendering as the core SDK.** `{{name}}` variables (spaces allowed), `{{{{` for a literal `{{`, values never
  rendered again, and a missing variable is an error by default. Where the framework formats templates itself
  (LangChain), the adapter converts the template with the core SDK's own parser and escapes every other brace, and
  the tests run the conformance `render` cases through the framework. Where the framework's formatter cannot express
  the same semantics (LlamaIndex leaves missing variables in place and cannot escape braces; Spring AI and Semantic
  Kernel use other syntaxes), the adapter plugs the core renderer into the framework's own extension point.
- **No network on the hot path.** Everything reads the core client's in-memory state (`prompt(name)`); deploys arrive
  through the core client's background refresher. The only I/O in any adapter is the Claude Agent SDK skill folder,
  written at session set-up and only when a skill changed (the Agent SDK loads skills from disk only).
- **Hot updates without a restart.** Either the framework calls back per run (dynamic instructions, live templates,
  per-session options), or the adapter makes a re-read cheap (`pull` per request, `livePrompt`, `keep_updated`).
- **Prompt name, version and SHA-256 exposed for tracing**, with the same keys everywhere: `kyp.prompt.name`,
  `kyp.prompt.version`, `kyp.prompt.sha256`. The adapters only expose them in each framework's own metadata channel;
  they do not create spans (the core SDKs' OpenTelemetry support is separate).

## Research: where a prompt registry plugs into each framework

Checked against the official documentation and the installed packages' sources and type definitions, as of
October 2026 (versions are the latest releases at that date).

| Framework | How prompts are represented | Where a remote registry plugs in | Adapter's choice |
| --- | --- | --- | --- |
| Vercel AI SDK 7 (`ai` 7.0.156) | Plain strings: `instructions` (`system` is deprecated) takes a string or `SystemModelMessage`, which can carry `providerOptions`; system messages inside `messages` need `allowSystemInMessages: true`. No template engine. Telemetry in v7 has no `metadata` field; the OpenTelemetry integration records `ai.response.providerMetadata` when enabled. | Language-model middleware (`LanguageModelV4Middleware` with `specificationVersion: 'v4'`, `transformParams` / `wrapGenerate` / `wrapStream`) via `wrapLanguageModel`. | Helpers return tagged `SystemModelMessage`s; the middleware moves the tag into `providerMetadata.kyp`. |
| LangChain.js (`@langchain/core` 1.3.1) and LangChain Python (`langchain-core` 1.7.1) | `PromptTemplate` / `ChatPromptTemplate` with `f-string` (`{x}`, `{{` escapes) or `mustache` formats; `metadata` and `tags` on a template are merged into every run's config (tracing). | The prompt hub: LangSmith's `client.pull_prompt(name)` (Python) and `hub.pull(name)` from `langchain/hub` (JS) return templates by name, cached in memory. | `pull(name)` with the same shape, backed by the core client; f-string conversion (mustache would give `{{#x}}` sections and dotted names a meaning the deployed text does not have). |
| LlamaIndex (`llama-index-core` 0.14.25) | `PromptTemplate` (f-string style, formatted by `SafeFormatter`: missing keys stay, no brace escaping), `ChatPromptTemplate`, and `RichPromptTemplate` (Jinja via banks, `{% chat %}` blocks). | `get_prompts()` / `update_prompts({"module:key": template})` on any `PromptMixin` (query engines, synthesizers, agents). | Subclasses whose `format` uses the core renderer; `kyp_update_prompts` with a variable check and re-apply on deploy. |
| OpenAI Agents SDK, Python (`openai-agents` 0.24.0) and JS (`@openai/agents-core` 0.21.0) | `Agent.instructions` is a string or a function `(run_context, agent) -> str` (sync or async in Python, `string | Promise<string>` in JS), called for every run. A `prompt` parameter refers to OpenAI-hosted prompts (Responses API only). | Dynamic `instructions`. | Instruction functions that render the deployed version per run, with variables from the run context. |
| Claude Agent SDK, TS (`@anthropic-ai/claude-agent-sdk` 0.3.312) and Python (`claude-agent-sdk` 0.2.174) | `systemPrompt` / `system_prompt`: a string, or `{type: 'preset', preset: 'claude_code', append}`; subagents in the `agents` option as `AgentDefinition` (`description`, `prompt`, `tools`, `model`, `skills`, `maxTurns`, ...). Skills are `SKILL.md` files only: the SDK has no API to register them; they load from setting sources or the `plugins` option (`{type: 'local', path}`). A resumed session reuses its recorded system prompt until compaction. | Options built per `query()` (new session); skills through a local plugin folder. | `KypClaude.options()` per session; agents from `agents/...` prompts and skills from `skills/...` prompts (the delivery manifest has no asset kind, so the prefix decides). |
| Spring AI 2.0.2 (Spring Boot 4.1) | `PromptTemplate` / `SystemPromptTemplate` rendered by a `TemplateRenderer` (default `StTemplateRenderer`, `{x}`); `ChatClient.Builder.defaultTemplateRenderer`. Messages carry a metadata map. | A custom `TemplateRenderer`, plus beans from Spring Boot auto-configuration. | `KypTemplateRenderer`, `KypPrompts` bean, `kyp.*` properties. |
| Semantic Kernel .NET (`Microsoft.SemanticKernel.Core` 1.81.0) | `PromptTemplateConfig` with a `TemplateFormat` (`semantic-kernel` with `{{$var}}`, Handlebars, Liquid); values are HTML-encoded unless `AllowDangerouslySetContent`. | `IPromptTemplateFactory` (combined with `AggregatorPromptTemplateFactory`), `KernelFunctionFactory.CreateFromPrompt(IPromptTemplate, config)`, invocation filters for result metadata. | `template_format: kyp`, live templates for deployed prompts, `KypPromptMetadataFilter`. |

Sources:

- Vercel AI SDK: [Language model middleware](https://ai-sdk.dev/docs/ai-sdk-core/middleware),
  [Telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry); `ai` 7.0.156 and `@ai-sdk/provider` 4.0.34 type definitions.
- LangChain: [Manage prompts programmatically (LangSmith prompt hub)](https://docs.langchain.com/langsmith/manage-prompts-programmatically);
  `@langchain/core` 1.3.1 (`prompts/template.js`, `prompts/base.js`) and `langchain-core` 1.7.1 sources.
- LlamaIndex: [Prompts](https://developers.llamaindex.ai/python/framework/module_guides/models/prompts/);
  `llama-index-core` 0.14.25 (`prompts/base.py`, `prompts/rich.py`, `prompts/utils.py`, `prompts/mixin.py`).
- OpenAI Agents SDK: [Agents (Python)](https://openai.github.io/openai-agents-python/agents/),
  [Agents (JS)](https://openai.github.io/openai-agents-js/guides/agents/); `openai-agents` 0.24.0 and
  `@openai/agents-core` 0.21.0 (`agent.d.ts`).
- Claude Agent SDK: [Subagents in the SDK](https://code.claude.com/docs/en/agent-sdk/subagents),
  [Extend agents with skills](https://code.claude.com/docs/en/agent-sdk/skills),
  [Modifying system prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts);
  `@anthropic-ai/claude-agent-sdk` 0.3.312 `sdk.d.ts` and `claude-agent-sdk` 0.2.174 types.
- Spring AI: [Prompts](https://docs.spring.io/spring-ai/reference/api/prompt.html); `spring-ai-model` and
  `spring-ai-commons` 2.0.2 (`PromptTemplate`, `TemplateRenderer`).
- Semantic Kernel: [Prompt template syntax](https://learn.microsoft.com/en-us/semantic-kernel/concepts/prompts/prompt-template-syntax);
  `Microsoft.SemanticKernel.Abstractions` / `.Core` 1.81.0 API docs (`IPromptTemplateFactory`,
  `KernelFunctionFactory`, `IFunctionInvocationFilter`).

## How each adapter is tested

Every adapter's tests use a **real core SDK client** over the shared [conformance fixtures](../conformance/fixtures)
(or snapshot folders written by the test), including a deploy (`v12` → `v13`) picked up by `refresh()` without
recreating anything. No network.

| Adapter | Against the real framework | Stand-ins |
| --- | --- | --- |
| `vercel-ai` | `generateText`, `streamText`, `wrapLanguageModel` from `ai` | `MockLanguageModelV4` from `ai/test` in place of a provider |
| `langchain-js` | `PromptTemplate`, `ChatPromptTemplate`, `MessagesPlaceholder`, `RunnableLambda`, callbacks | none |
| `langchain-python` | the same in `langchain-core`, sync and async | none |
| `llamaindex-python` | the template classes, a compact response synthesizer, `get_prompts` / `update_prompts` | `MockLLM` |
| `openai-agents-python` | `Agent`, `Runner.run`, `Runner.run_sync`, `RunContextWrapper` | a recording `Model` in place of the OpenAI API |
| `openai-agents-js` | `Agent`, `Runner.run`, `RunContext` | a recording `Model` |
| `claude-agent-sdk-ts` | option types; opt-in `KYP_CLAUDE_E2E=1` test starts a real session (bundled Claude Code) and checks the `init` message lists the deployed agents and skills | none in the e2e test; it is stopped at `init` |
| `claude-agent-sdk-python` | `AgentDefinition`, `ClaudeAgentOptions`; the same opt-in real-session test with `ClaudeSDKClient` | as above |
| `spring-ai` | `PromptTemplate`, `SystemPromptTemplate`, `ChatClient`, Spring Boot `ApplicationContextRunner` | a fake `ChatModel` |
| `semantic-kernel-dotnet` | `Kernel`, `KernelFunction`s, `AggregatorPromptTemplateFactory`, invocation filters | a recording `IChatCompletionService` |

## Releases

Each adapter has its own workflow (`.github/workflows/adapter-<folder>.yml`, path-filtered) and publishes on a
`<folder>-v<version>` tag, after the core SDK it depends on has been released.
