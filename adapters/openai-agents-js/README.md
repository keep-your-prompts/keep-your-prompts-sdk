# Keep Your Prompts for the OpenAI Agents SDK (JavaScript)

Give an `Agent` dynamic `instructions` that render a prompt deployed with
[Keep Your Prompts](https://keepyourprompts.com) on every run: a deploy applies to the next run, without restarting
the process or rebuilding the agent.

- npm package `@keepyourprompts/openai-agents`, version 0.1.0 (preview, not published yet).
- Peer dependencies: [`@keepyourprompts/sdk`](../../typescript) `^0.1.0` and `@openai/agents-core` `>=0.21 <1`
  (installed with `@openai/agents`).
- Rendering reads the client's memory (no network per run) and is the core SDK's: a missing variable throws
  `MissingVariableError` unless you pass `strict: false`.
- This code is under the repository's [LICENSE](../../LICENSE).

## Install

```sh
npm install @keepyourprompts/openai-agents @keepyourprompts/sdk @openai/agents
```

## Quickstart

```ts
import { Agent, run } from '@openai/agents';
import { Client } from '@keepyourprompts/sdk';
import { kypInstructions, kypText } from '@keepyourprompts/openai-agents';

const prompts = await Client.fromEnv(); // KYP_DELIVERY_KEY, KYP_APP, KYP_ENV

const billing = new Agent({
  name: 'Billing',
  handoffDescription: kypText(prompts, 'agents/billing/handoff'),
  instructions: kypInstructions(prompts, 'agents/billing'),
});

const triage = Agent.create({
  name: 'Triage',
  instructions: kypInstructions(prompts, 'triage'),
  handoffs: [billing],
});

// Variables come from the run context by default:
const result = await run(triage, 'My invoice is wrong.', { context: { company: 'Acme' } });
```

Variables can also be fixed or computed per run:

```ts
kypInstructions(prompts, 'triage', { vars: { company: 'Acme' } });
kypInstructions<UserCtx>(prompts, 'triage', { vars: (ctx, agent) => ({ company: ctx.context.org.name }) });
```

## Tracing metadata

The OpenAI Agents SDK traces model calls with the instructions they used. To attach the prompt version as well,
use `onRender` (called after every render with `{ name, version, sha256, agent, runContext }`) or `lastRendered(fn)`,
and put the values where your tracing goes (a log line, a span attribute, trace metadata):

```ts
import { kypInstructions } from '@keepyourprompts/openai-agents';

const instructions = kypInstructions(prompts, 'triage', {
  onRender: (e) => console.log(`agent ${e.agent} uses ${e.name} v${e.version} (${e.sha256.slice(0, 12)})`),
});
```

`promptAttributes(prompt)` gives flat `kyp.prompt.name` / `kyp.prompt.version` / `kyp.prompt.sha256` attributes.

## API

| Export | Description |
| --- | --- |
| `kypInstructions(client, name, { vars?, strict?, onMissing?, onRender? })` | `(runContext, agent) => Promise<string>` for `Agent.instructions`. |
| `kypText(client, name, vars?, options?)` | Rendered text, read once (for `handoffDescription` and other static strings). |
| `lastRendered(instructions)` | `{ name, version, sha256 }` of the last render of a `kypInstructions` function. |
| `promptMetadata(prompt)`, `promptAttributes(prompt)` | Metadata as an object or as flat attributes. |

## Development

```sh
(cd ../../typescript && npm ci && npm run build)   # the core SDK, linked as a dev dependency
npm ci
npm run typecheck && npm run build && npm test     # tests run the real Agent/Runner with a recording Model
```
