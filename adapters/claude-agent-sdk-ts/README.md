# Keep Your Prompts for the Claude Agent SDK (TypeScript)

Take the system prompt, subagents and skills of a Claude Agent SDK app from prompts deployed with
[Keep Your Prompts](https://keepyourprompts.com). Options are rebuilt for every session, so each new `query()` uses
what is deployed at that moment, without a restart.

- npm package `@keepyourprompts/claude-agent-sdk`, version 0.1.0 (preview, not published yet). Node 18+.
- Peer dependencies: [`@keepyourprompts/sdk`](../../typescript) `^0.1.0` and `@anthropic-ai/claude-agent-sdk` `>=0.3 <1`.
- Prompts are read from the client's memory and rendered by the core SDK (strict: a missing variable throws
  `MissingVariableError`). The only I/O is writing skill files, at session set-up, and only when a skill changed.
- This code is under the repository's [LICENSE](../../LICENSE).

## Install

```sh
npm install @keepyourprompts/claude-agent-sdk @keepyourprompts/sdk @anthropic-ai/claude-agent-sdk
```

## Quickstart

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@keepyourprompts/sdk';
import { KypClaude } from '@keepyourprompts/claude-agent-sdk';

const prompts = await Client.fromEnv(); // KYP_DELIVERY_KEY, KYP_APP, KYP_ENV
const kyp = new KypClaude(prompts, {
  systemPrompt: { name: 'support-agent', preset: 'claude_code', vars: { company: 'Acme' } },
  agents: { prefix: 'agents/' },            // every agents/... prompt becomes a subagent
  skills: { dir: '.kyp/claude-plugin' },    // every skills/... prompt becomes a skill
});

for await (const message of query({
  prompt: 'Review the open pull request',
  options: kyp.options({ allowedTools: ['Read', 'Grep', 'Agent', 'Skill'] }),
})) {
  if (message.type === 'result') console.log(message.result);
}
console.log(kyp.lastPrompts()); // name, version and sha256 of every prompt this session used
```

## Conventions

| Deployed prompt | Becomes |
| --- | --- |
| the one named in `systemPrompt` | `systemPrompt`: the text, or `{ type: 'preset', preset: 'claude_code', append }` |
| `agents/code-reviewer` | `agents['code-reviewer']` (nested names join with `-`: `agents/billing/refunds` → `billing-refunds`) |
| `skills/pdf-tools` | skill `kyp:pdf-tools` in a local plugin passed through `plugins` |

Keep Your Prompts' delivery manifest does not carry an asset's kind, so the adapter goes by name prefix (both are
options). A prompt may start with front matter like a Claude Code agent or skill file:

```markdown
---
description: Reviews diffs for security issues
tools: Read, Grep, Glob
model: sonnet
maxTurns: 5
---
You review code for {{company}}.
```

Agent front matter maps to `AgentDefinition` fields (`description`, `tools`, `disallowedTools` /
`disallowed-tools`, `model`, `skills`, `maxTurns`, `effort`, `permissionMode`, `memory`, `background`,
`initialPrompt`); the rest of the prompt is the agent's `prompt`. Without a `description`, the first line of the body
is used (or `descriptions[name]`). Skills without front matter get `name` and `description` the same way.

**Why skills are files.** The Agent SDK loads skills only from the file system (it has no API to register them), so
`materializeSkills` writes `<dir>/.claude-plugin/plugin.json` and `<dir>/skills/<skill>/SKILL.md`, rewriting a skill
only when its sha256 changed and removing skills that are no longer deployed. The folder belongs to the adapter: it
refuses a non-empty folder it did not create. Inside a long-running session, call `kyp.syncSkills()` and then
`await q.reloadSkills()` to pick up new skills without starting a new session.

## API

| Export | Description |
| --- | --- |
| `new KypClaude(client, { systemPrompt?, agents?, skills? })` | `.options(overrides?)` builds `{ systemPrompt, agents, plugins }` for one session over your options; `.syncSkills()`; `.lastPrompts()` returns the metadata of every prompt used. |
| `kypSystemPrompt(client, name, { vars?, preset?, excludeDynamicSections?, strict? })` | The `systemPrompt` option. |
| `kypAgents(client, { prefix?, vars?, descriptions?, defaults?, exclude? })` | `Record<string, AgentDefinition>`. |
| `agentDefinition(client, name, options?)` | One `AgentDefinition`. |
| `materializeSkills(client, { dir, prefix?, pluginName?, vars?, descriptions? })` | Writes the plugin; returns `{ plugin, skills, prompts, changed }`. |
| `parseFrontMatter(text)` | The front matter reader used above. |
| `promptMetadata(prompt)`, `promptAttributes(prompt)` | `{ name, version, sha256 }`, or flat `kyp.prompt.*` attributes. |

## Development

```sh
(cd ../../typescript && npm ci && npm run build)   # the core SDK, linked as a dev dependency
npm ci
npm run typecheck && npm run build && npm test
KYP_CLAUDE_E2E=1 npx vitest run test/e2e.test.ts   # starts a real session (bundled Claude Code), aborted at init
```
