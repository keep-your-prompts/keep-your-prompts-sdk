# Keep Your Prompts for LangChain (Python)

Load prompts deployed with [Keep Your Prompts](https://keepyourprompts.com) as LangChain `PromptTemplate` and
`ChatPromptTemplate` objects, with a hub-like `pull(name)`.

- PyPI package `keepyourprompts-langchain`, version 0.1.0 (preview, not published yet). Python 3.10+.
- Depends on [`keepyourprompts`](../../python) `>=0.1,<0.2` and `langchain-core` `>=1,<2`.
- Reads the client's memory only: no network on the hot path. The prompt's name, version and SHA-256 are set as the
  template's `metadata` (`kyp.prompt.name`, `kyp.prompt.version`, `kyp.prompt.sha256`), which LangChain adds to every
  run it traces (LangSmith, OpenTelemetry, callbacks).
- This code is under the repository's [LICENSE](../../LICENSE).

## Install

```sh
pip install keepyourprompts-langchain
```

## Quickstart

```python
from keepyourprompts import Client
from keepyourprompts_langchain import live_prompt, load_chat_prompt_template, pull, set_default_client
from langchain_anthropic import ChatAnthropic
from langchain_core.prompts import MessagesPlaceholder

prompts = Client.from_env()  # KYP_DELIVERY_KEY, KYP_APP, KYP_ENV
set_default_client(prompts)
model = ChatAnthropic(model="claude-opus-5-5")

# Like hub.pull: the deployed version, as a ChatPromptTemplate with a system message.
chain = pull("triage") | model
chain.invoke({"company": "Acme"})

# The deployed prompt as the system message, then your own messages.
chat = load_chat_prompt_template(
    prompts, "triage", messages=[MessagesPlaceholder("history"), ("human", "{input}")]
)

# A long-lived chain that picks up every deploy without being rebuilt (sync and async).
live = live_prompt("triage") | model
```

## Templates

Deployed prompts write variables as `{{name}}` and a literal `{{` as `{{{{`. LangChain f-strings write `{name}` and
escape braces as `{{` / `}}`. The loaders convert one into the other: the core SDK finds the variables (so both agree
on what is a variable) and every other brace is escaped, so a template formats to exactly the text
`client.render(name, ...)` returns. `to_fstring(text)` exposes the conversion.

What stays LangChain's: a missing variable raises LangChain's `KeyError` rather than `MissingVariableError` (still an
error, so strict by default), and values are formatted by `str.format`. There is no lenient mode: use
`partial_variables` for values you want to bind up front.

## API

| Function | Description |
| --- | --- |
| `pull(name, *, client=None, chat=True, **options)` | `ChatPromptTemplate` (default) or `PromptTemplate` (`chat=False`) for the version deployed now. |
| `set_default_client(client)` | Client used by `pull` and `live_prompt` when none is passed. |
| `live_prompt(name, *, client=None, chat=True, **options)` | A `RunnableLambda` that pulls on every invocation (`invoke` and `ainvoke`). |
| `load_prompt_template(client, name, *, partial_variables=None, metadata=None, tags=None)` | `PromptTemplate` (f-string) with prompt metadata. |
| `load_chat_prompt_template(client, name, *, role="system", messages=None, ...)` | `ChatPromptTemplate`: the prompt as one message, then `messages`. |
| `kyp_message(client, role, name)` | A `(role, template)` tuple for composing several deployed prompts. |
| `to_fstring(text)` | `FStringTemplate(template, input_variables)`. |
| `prompt_metadata(prompt)` | `{"kyp.prompt.name", "kyp.prompt.version", "kyp.prompt.sha256"}`. |

`client` is a `Client` or `AsyncClient` of `keepyourprompts` (anything with `prompt(name)`). Templates are values: one
you loaded keeps its version. `pull` is cheap (a dict lookup; the conversion is cached by SHA-256), so call it per
request, or use `live_prompt`.

## Development

```sh
python -m venv .venv && . .venv/bin/activate
pip install -e ../../python -e ".[dev]"
ruff check . && ruff format --check .
pytest   # runs the real langchain-core over ../../conformance/fixtures
```
