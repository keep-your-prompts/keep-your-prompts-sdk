# Keep Your Prompts for LangChain.js

Load prompts deployed with [Keep Your Prompts](https://keepyourprompts.com) as LangChain `PromptTemplate` and
`ChatPromptTemplate` objects, with a hub-like `pull(name)`.

- npm package `@keepyourprompts/langchain`, version 0.1.0 (preview, not published yet).
- Peer dependencies: [`@keepyourprompts/sdk`](../../typescript) `^0.1.0` and `@langchain/core` `^1`.
- Reads the client's memory only: no network on the hot path. The prompt's name, version and SHA-256 are set as the
  template's `metadata` (`kyp.prompt.name`, `kyp.prompt.version`, `kyp.prompt.sha256`), which LangChain adds to every
  run it traces (LangSmith, OpenTelemetry exporters, callbacks).
- This code is under the repository's [LICENSE](../../LICENSE).

## Install

```sh
npm install @keepyourprompts/langchain @keepyourprompts/sdk @langchain/core
```

## Quickstart

```ts
import { ChatAnthropic } from '@langchain/anthropic';
import { MessagesPlaceholder } from '@langchain/core/prompts';
import { Client } from '@keepyourprompts/sdk';
import { livePrompt, loadChatPromptTemplate, pull, setDefaultClient } from '@keepyourprompts/langchain';

const prompts = await Client.fromEnv(); // KYP_DELIVERY_KEY, KYP_APP, KYP_ENV
setDefaultClient(prompts);
const model = new ChatAnthropic({ model: 'claude-opus-5-5' });

// Like hub.pull: the deployed version, as a ChatPromptTemplate with a system message.
const chain = pull('triage').pipe(model);
await chain.invoke({ company: 'Acme' });

// The deployed prompt as the system message, then your own messages.
const chat = loadChatPromptTemplate(prompts, 'triage', {
  messages: [new MessagesPlaceholder('history'), ['human', '{input}']],
});

// A long-lived chain that picks up every deploy without being rebuilt.
const live = livePrompt('triage').pipe(model);
```

## Templates

Deployed prompts write variables as `{{name}}` and a literal `{{` as `{{{{`. LangChain f-strings write `{name}` and
escape braces as `{{` / `}}`. The loaders convert one into the other: the core SDK finds the variables (so both agree
on what is a variable) and every other brace is escaped, so a template formats to exactly the text
`client.render(name, vars)` returns. `toFString(text)` exposes the conversion.

Differences that stay LangChain's: a missing variable raises LangChain's `INVALID_PROMPT_INPUT` error rather than
`MissingVariableError` (it is still an error, so strict by default), and non-string values are formatted by LangChain
(`JSON.stringify`). There is no lenient mode: use `partialVariables` for values you want to bind up front.

## API

| Export | Description |
| --- | --- |
| `pull(name, { client?, chat?, role?, messages?, partialVariables?, metadata?, tags? })` | `ChatPromptTemplate` (default) or `PromptTemplate` (`chat: false`) for the version deployed now. |
| `setDefaultClient(client)` | Client used by `pull` and `livePrompt` when none is passed. |
| `livePrompt(name, options?)` | A `Runnable` that pulls on every invocation, so it follows deploys. |
| `loadPromptTemplate(client, name, options?)` | `PromptTemplate` (f-string) with prompt metadata. |
| `loadChatPromptTemplate(client, name, { role?, messages?, ... })` | `ChatPromptTemplate`: the prompt as one message (`system` by default) followed by `messages`. |
| `kypMessage(client, role, name)` | A `[role, template]` tuple for composing several deployed prompts with `ChatPromptTemplate.fromMessages`. |
| `toFString(text)` | `{ template, inputVariables }`: the conversion on its own. |
| `promptMetadata(prompt)` | `{ 'kyp.prompt.name', 'kyp.prompt.version', 'kyp.prompt.sha256' }`. |

Templates are values: one you loaded keeps the version it was loaded from. `pull` is cheap (a map lookup; the
conversion is cached by SHA-256), so call it per request, or use `livePrompt`.

## Development

```sh
(cd ../../typescript && npm ci && npm run build)   # the core SDK, linked as a dev dependency
npm ci
npm run typecheck && npm run build && npm test     # tests run the real @langchain/core
```
