# Keep Your Prompts for LlamaIndex

Use prompts deployed with [Keep Your Prompts](https://keepyourprompts.com) as LlamaIndex `PromptTemplate`,
`ChatPromptTemplate` and `RichPromptTemplate` objects, and swap them into query engines, synthesizers and agents
with `update_prompts`, kept current on every deploy.

- PyPI package `keepyourprompts-llamaindex`, version 0.1.0 (preview, not published yet). Python 3.10+.
- Depends on [`keepyourprompts`](../../python) `>=0.1,<0.2` and `llama-index-core` `>=0.14,<0.15`.
- Reads the client's memory only: no network on the hot path. Each template's `metadata` carries
  `kyp.prompt.name`, `kyp.prompt.version` and `kyp.prompt.sha256` (visible in `get_prompts()` and to LlamaIndex
  instrumentation).
- This code is under the repository's [LICENSE](../../LICENSE).

## Install

```sh
pip install keepyourprompts-llamaindex
```

## Quickstart

```python
from keepyourprompts import Client
from keepyourprompts_llamaindex import kyp_update_prompts, load_chat_prompt_template, load_prompt_template

prompts = Client.from_env()  # KYP_DELIVERY_KEY, KYP_APP, KYP_ENV

# A PromptTemplate (keyword arguments are partial variables).
qa = load_prompt_template(prompts, "rag/answer", company="Acme")
qa.format(context_str="...", query_str="What is KYP?")

# Put it into a query engine, and re-apply it whenever a deploy changes it.
query_engine = index.as_query_engine()
stop = kyp_update_prompts(
    query_engine,
    prompts,
    {"response_synthesizer:text_qa_template": "rag/answer"},
    keep_updated=True,
    template=lambda client, name: load_prompt_template(client, name, company="Acme"),
)

# Chat and Rich (Jinja) templates.
chat = load_chat_prompt_template(prompts, "triage", messages=[("user", "{query_str}")])
```

## Why formatting goes through the core SDK

LlamaIndex's `PromptTemplate` leaves a missing `{variable}` in place without an error, and has no way to escape a
literal brace, so a deployed prompt containing `{json}` or `{{{{` would not render as deployed. The templates
returned here are the LlamaIndex classes (`KypPromptTemplate` is a `PromptTemplate`, and so on) with `format` /
`format_messages` done by the core SDK: output is exactly what `client.render` returns, a missing variable raises
`MissingVariableError` (or is kept / emptied with `strict=False` / `on_missing="empty"`), and partial variables,
`template_var_mappings` and `function_mappings` work as usual. The `template` attribute holds the `{name}` form for
display and for code that reads it.

`load_rich_prompt_template` converts to Jinja instead (variables become `{{ name }}`, literal braces go inside
`{% raw %}`), with the same strict check; `role="system"` wraps it in a `{% chat %}` block.

## API

| Function | Description |
| --- | --- |
| `load_prompt_template(client, name, *, prompt_type=..., strict=True, on_missing=None, template_var_mappings=None, function_mappings=None, **partials)` | `KypPromptTemplate`. |
| `load_chat_prompt_template(client, name, *, role="system", messages=(), **options)` | `KypChatPromptTemplate`: the deployed prompt as one message, then your messages. |
| `chat_prompt_template(client, [KypMessage(role, name), ("user", "{query_str}"), ChatMessage(...)], ...)` | Mix several deployed prompts with ordinary messages (`metadata["kyp.prompts"]` lists them). |
| `load_rich_prompt_template(client, name, *, role=None, strict=True, on_missing=None, **partials)` | `KypRichPromptTemplate` (Jinja via banks). |
| `kyp_update_prompts(module, client, {prompt_key: name}, *, check_variables=True, keep_updated=False, template=load_prompt_template)` | Calls `module.update_prompts`; refuses a deployed prompt missing a variable the replaced prompt used (`context_str`, `query_str`...); with `keep_updated`, re-applies after each deploy that changes one of the prompts and returns a function that stops it. |
| `to_llamaindex_template(text)`, `to_jinja(text)` | The conversions on their own. |
| `prompt_metadata(prompt)` | `{"kyp.prompt.name", "kyp.prompt.version", "kyp.prompt.sha256"}`. |

`keep_updated` runs `update_prompts` from the client's refresher thread; a request already running keeps the prompt it
started with. Templates are values: one you loaded keeps its version, so reload per request or use `keep_updated`.

## Development

```sh
python -m venv .venv && . .venv/bin/activate
pip install -e ../../python -e ".[dev]"
ruff check . && ruff format --check .
pytest   # real llama-index-core (templates, a response synthesizer with MockLLM, update_prompts)
```
