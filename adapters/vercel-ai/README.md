# Keep Your Prompts for the Vercel AI SDK

Use prompts deployed with [Keep Your Prompts](https://keepyourprompts.com) as `instructions` and `messages` for
`generateText`, `streamText`, `generateObject` and `ToolLoopAgent`, and tag every model call with the prompt's name,
version and SHA-256.

- npm package `@keepyourprompts/ai-sdk`, version 0.1.0 (preview, not published yet).
- Peer dependencies: [`@keepyourprompts/sdk`](../../typescript) `^0.1.0`, `ai` `^7` and `@ai-sdk/provider` `^4`.
- Every helper reads the client's memory: no network on the hot path. Rendering is the core SDK's, so a missing
  variable throws `MissingVariableError` unless you pass `{ strict: false }`.
- This code is under the repository's [LICENSE](../../LICENSE).

## Install

```sh
npm install @keepyourprompts/ai-sdk @keepyourprompts/sdk ai
```

## Quickstart

```ts
import { generateText, streamText, wrapLanguageModel } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { Client } from '@keepyourprompts/sdk';
import { kypInstructions, kypMessages, kypMiddleware } from '@keepyourprompts/ai-sdk';

const prompts = await Client.fromEnv(); // KYP_DELIVERY_KEY, KYP_APP, KYP_ENV
const model = wrapLanguageModel({ model: anthropic('claude-opus-5-5'), middleware: kypMiddleware() });

const { text, providerMetadata } = await generateText({
  model,
  instructions: kypInstructions(prompts, 'triage', { company: 'Acme' }),
  prompt: 'My invoice is wrong.',
});
providerMetadata?.kyp; // { name: 'triage', version: 7, sha256: 'f31b…', prompts: [ … ] }

const result = streamText({
  model,
  instructions: kypInstructions(prompts, 'triage', { company: 'Acme' }),
  messages: kypMessages(prompts, [{ role: 'user', prompt: 'ticket-template', vars: { ticket: '…' } }]),
});
```

Call the helpers per request: they cost a map lookup and a render, and a deploy picked up by the client's
background refresher shows up on the next call without a restart.

## How tagging works

`kypInstructions` and `kypMessages` put `{ name, version, sha256 }` under `providerOptions.kyp` on the message they
return. `kypMiddleware()` finds those messages in each model call, removes the tag before the provider sees it, and
adds `providerMetadata.kyp` to the result (`result.providerMetadata` for `generateText`, the `finish` part of
`streamText`). The AI SDK records provider metadata in its telemetry, so the prompt version travels with every span
without extra configuration. `onCall` is called once per tagged model call if you want to log or count it yourself.

AI SDK 7 refuses system messages inside `messages` unless you pass `allowSystemInMessages: true`; put the system
prompt in `instructions`.

## API

| Export | Description |
| --- | --- |
| `kypInstructions(client, name, vars?, { strict?, onMissing?, providerOptions? })` | A tagged `SystemModelMessage` for `instructions` (or `system`). Extra `providerOptions` (for example Anthropic cache control) are kept. |
| `kypSystem(client, name, vars?, options?)` | The rendered string, untagged. |
| `kypMessages(client, [{ role, prompt, vars?, options? }])` | Tagged `user` / `assistant` (or `system`) messages. |
| `kypMiddleware({ onCall?, strip? })` | `LanguageModelV4Middleware` for `wrapLanguageModel`. `strip: false` leaves the tag in what the provider receives. |
| `promptMetadata(prompt)`, `promptAttributes(prompt)` | `{ name, version, sha256 }`, or flat `kyp.prompt.name` / `kyp.prompt.version` / `kyp.prompt.sha256` attributes for your own spans. |
| `PROVIDER_KEY` | `'kyp'`. |

`client` is any object with `prompt(name)`, normally a `Client` from `@keepyourprompts/sdk`.

## Development

```sh
(cd ../../typescript && npm ci && npm run build)   # the core SDK, linked as a dev dependency
npm ci
npm run typecheck && npm run build && npm test     # tests run the real `ai` package with its MockLanguageModelV4
```
