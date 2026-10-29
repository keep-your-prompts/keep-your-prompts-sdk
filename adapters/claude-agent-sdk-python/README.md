# Keep Your Prompts for the Claude Agent SDK (Python)

Take the system prompt, subagents and skills of a Claude Agent SDK app from prompts deployed with
[Keep Your Prompts](https://keepyourprompts.com). Options are rebuilt for every session, so each new `query()` or
`ClaudeSDKClient` uses what is deployed at that moment, without a restart.

- PyPI package `keepyourprompts-claude-agent-sdk`, version 0.1.0 (preview, not published yet). Python 3.10+.
- Depends on [`keepyourprompts`](../../python) `>=0.1,<0.2` and `claude-agent-sdk` `>=0.2.174,<0.3`.
- Prompts are read from the client's memory and rendered by the core SDK (strict: a missing variable raises
  `MissingVariableError`). The only I/O is writing skill files, at session set-up, and only when a skill changed.
- This code is under the repository's [LICENSE](../../LICENSE).

## Install

```sh
pip install keepyourprompts-claude-agent-sdk
```

## Quickstart

```python
from claude_agent_sdk import ResultMessage, query
from keepyourprompts import Client
from keepyourprompts_claude_agent_sdk import KypClaude

prompts = Client.from_env()  # KYP_DELIVERY_KEY, KYP_APP, KYP_ENV
kyp = KypClaude(
    prompts,
    system_prompt={"name": "support-agent", "preset": "claude_code", "variables": {"company": "Acme"}},
    agents={"prefix": "agents/"},             # every agents/... prompt becomes a subagent
    skills={"dir": ".kyp/claude-plugin"},     # every skills/... prompt becomes a skill
)

async for message in query(
    prompt="Review the open pull request",
    options=kyp.options(allowed_tools=["Read", "Grep", "Agent", "Skill"]),
):
    if isinstance(message, ResultMessage):
        print(message.result)
print(kyp.last_prompts())  # name, version and sha256 of every prompt this session used
```

`options(base=None, **overrides)` starts from a `ClaudeAgentOptions` you pass (never modified) or from the keyword
arguments, and keeps your own `agents` and `plugins`.

## Conventions

| Deployed prompt | Becomes |
| --- | --- |
| the one named in `system_prompt` | `system_prompt`: the text, or `{"type": "preset", "preset": "claude_code", "append": ...}` |
| `agents/code-reviewer` | `agents["code-reviewer"]` (nested names join with `-`: `agents/billing/refunds` → `billing-refunds`) |
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
`materialize_skills` writes `<dir>/.claude-plugin/plugin.json` and `<dir>/skills/<skill>/SKILL.md`, rewriting a skill
only when its sha256 changed and removing skills that are no longer deployed. The folder belongs to the adapter: it
refuses a non-empty folder it did not create. Inside a long-running `ClaudeSDKClient` session, call
`kyp.sync_skills()` to rewrite the folder; Claude Code picks changed skill files up for the next session.

## API

| Name | Description |
| --- | --- |
| `KypClaude(client, *, system_prompt=None, agents=True, skills=None)` | `.options(base=None, **overrides)` → `ClaudeAgentOptions`; `.sync_skills()`; `.last_prompts()` → `SessionPrompts(system_prompt, agents, skills)`. |
| `kyp_system_prompt(client, name, variables=None, *, preset=None, exclude_dynamic_sections=None, strict=True)` | The `system_prompt` option. |
| `kyp_agents(client, *, prefix="agents/", variables=None, descriptions=None, defaults=None, exclude=())` | `dict[str, AgentDefinition]`. |
| `agent_definition(client, name, **options)` | One `AgentDefinition`. |
| `materialize_skills(client, dir, *, prefix="skills/", plugin_name="kyp", variables=None, descriptions=None)` | Writes the plugin; returns `SkillsResult(plugin, skills, prompts, changed)`. |
| `parse_front_matter(text)` | The front matter reader used above. |
| `prompt_attributes(prompt)` | Flat `kyp.prompt.name` / `kyp.prompt.version` / `kyp.prompt.sha256`. |

## Development

```sh
python -m venv .venv && . .venv/bin/activate
pip install -e ../../python -e ".[dev]"
ruff check . && ruff format --check .
pytest                              # unit tests
KYP_CLAUDE_E2E=1 pytest tests/test_e2e.py   # starts a real session (bundled Claude Code), stopped at init
```
