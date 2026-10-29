# Keep Your Prompts for the OpenAI Agents SDK (Python)

Give an `Agent` dynamic `instructions` that render a prompt deployed with
[Keep Your Prompts](https://keepyourprompts.com) on every run: a deploy applies to the next run, without restarting
the process or rebuilding the agent.

- PyPI package `keepyourprompts-openai-agents`, version 0.1.0 (preview, not published yet). Python 3.10+.
- Depends on [`keepyourprompts`](../../python) `>=0.1,<0.2` and `openai-agents` `>=0.24,<1`.
- Rendering reads the client's memory (no network per run) and is the core SDK's: a missing variable raises
  `MissingVariableError` unless you pass `strict=False`.
- This code is under the repository's [LICENSE](../../LICENSE).

## Install

```sh
pip install keepyourprompts-openai-agents
```

## Quickstart

```python
from agents import Agent, Runner
from keepyourprompts import Client
from keepyourprompts_openai_agents import kyp_instructions, kyp_text

prompts = Client.from_env()  # KYP_DELIVERY_KEY, KYP_APP, KYP_ENV

billing = Agent(
    name="Billing",
    handoff_description=kyp_text(prompts, "agents/billing/handoff"),
    instructions=kyp_instructions(prompts, "agents/billing"),
)
triage = Agent(name="Triage", instructions=kyp_instructions(prompts, "triage"), handoffs=[billing])

# Variables come from the run context by default (a dict, a dataclass or a pydantic model):
result = await Runner.run(triage, "My invoice is wrong.", context={"company": "Acme"})
```

Variables can also be fixed or computed per run (the resolver may be async):

```python
kyp_instructions(prompts, "triage", vars={"company": "Acme"})
kyp_instructions(prompts, "triage", vars=lambda ctx, agent: {"company": ctx.context.org.name})
```

## Tracing metadata

The Agents SDK traces model calls with the instructions they used. To record the prompt version as well, use
`on_render` (called after every render with a `RenderEvent(name, version, sha256, agent, context)`) or
`last_rendered(agent.instructions)`, and put the values where your tracing goes, for example a `custom_span`:

```python
from agents import custom_span
from keepyourprompts_openai_agents import kyp_instructions, prompt_attributes

def record(e):
    with custom_span("kyp.prompt", data=prompt_attributes(e)):
        pass

agent = Agent(name="Triage", instructions=kyp_instructions(prompts, "triage", on_render=record))
```

## API

| Function | Description |
| --- | --- |
| `kyp_instructions(client, name, *, vars=None, strict=True, on_missing=None, on_render=None)` | `async (ctx, agent) -> str` for `Agent(instructions=...)`. |
| `kyp_text(client, name, variables=None, **render_options)` | Rendered text read once (for `handoff_description` and other static strings). |
| `last_rendered(instructions)` | `PromptMetadata(name, version, sha256)` of the last render, or `None`. |
| `prompt_attributes(prompt)` | Flat `kyp.prompt.name` / `kyp.prompt.version` / `kyp.prompt.sha256`. |

`client` is a `Client` or `AsyncClient` of `keepyourprompts` (anything with `prompt(name)`).

## Development

```sh
python -m venv .venv && . .venv/bin/activate
pip install -e ../../python -e ".[dev]"
ruff check . && ruff format --check .
pytest   # real Agent and Runner with a recording Model, over ../../conformance/fixtures
```
