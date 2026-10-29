# Keep Your Prompts: Python SDK

Read deployed prompts from memory, keep them fresh in the background, and keep serving when the network does not.

```python
from keepyourprompts import Client

prompts = Client.from_env()  # KYP_DELIVERY_KEY, KYP_APP, KYP_ENV
system = prompts.render("triage", company="Acme", billing_queue="refunds")
```

- PyPI package `keepyourprompts`, version 0.1.0. Python 3.9 or newer.
- No required dependencies (urllib and threading from the standard library). Optional extras: `httpx` for the asyncio client, `otel` for OpenTelemetry.
- Typed (`py.typed`). Implements [prompt delivery protocol v1](../protocol/README.md) and passes every required behaviour of the [conformance suite](../conformance/README.md).
- This code is under the repository's [LICENSE](../LICENSE).

## Install

```sh
pip install keepyourprompts            # sync client, standard library only
pip install "keepyourprompts[httpx]"   # AsyncClient on httpx (otherwise it uses urllib in a worker thread)
```

## Quickstart

```python
from keepyourprompts import Client

# Set KYP_DELIVERY_KEY (kypd_...), KYP_APP=support-bot and optionally KYP_ENV=prod.
prompts = Client.from_env()

prompts.get("triage")                                  # the raw template
prompts.render("triage", company="Acme")               # keyword arguments...
prompts.render("triage", {"company": "Acme"})          # ...or a dict; raises MissingVariableError if one is missing
prompts.render("triage", strict=False)                 # leaves {{company}} in place
p = prompts.prompt("triage")                           # Prompt(name, version, sha256, variables, text) + p.render()
print(prompts.status())                                # which mirror served it, how stale it is
```

`get`, `render` and `prompt` read memory only: no I/O and no locks, safe from any number of threads. `strict` and `on_missing` are reserved keywords of `render`; pass variables with those names in the dict.

Be notified of deploys:

```python
@prompts.on_update
def deployed(update):
    print(f"revision {update.old_revision} -> {update.new_revision}: {update.changed}")
```

## With the Anthropic SDK

```python
import anthropic
from keepyourprompts import Client

prompts = Client.from_env()
client = anthropic.Anthropic()

response = client.messages.create(
    model="claude-opus-5-5",
    max_tokens=16000,
    system=prompts.render("triage", company="Acme"),
    messages=[{"role": "user", "content": "My invoice is wrong."}],
)
```

## With the OpenAI SDK

```python
from openai import OpenAI
from keepyourprompts import Client

prompts = Client.from_env()
client = OpenAI()

response = client.responses.create(
    model="gpt-5",
    instructions=prompts.render("triage", company="Acme"),
    input="My invoice is wrong.",
)
```

## asyncio

`AsyncClient` has the same surface. Reads stay synchronous (they never wait); `refresh`, `flush` and `close` are coroutines and the refresher is an asyncio task.

```python
from keepyourprompts import AsyncClient

prompts = await AsyncClient.from_env()          # or: async with AsyncClient.from_env() as prompts:
text = prompts.render("triage", company="Acme")  # no await
await prompts.close()
```

`on_update` callbacks may be plain functions or coroutine functions.

### FastAPI

Create one client per process in the lifespan and share it:

```python
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from keepyourprompts import AsyncClient

@asynccontextmanager
async def lifespan(app: FastAPI):
    async with AsyncClient.from_env() as prompts:
        app.state.prompts = prompts
        yield

app = FastAPI(lifespan=lifespan)

@app.post("/chat")
async def chat(request: Request):
    system = request.app.state.prompts.render("triage", company="Acme")
    ...
```

The sync `Client` works in FastAPI too (its refresher is a thread, reads are lock-free); use `AsyncClient` when you prefer everything on the event loop.

### Django, Flask, Celery and other WSGI apps

Create one module-level `Client` (for example in `myapp/prompts.py`) and import it where needed. It is created once per worker process: with Gunicorn's `--preload`, or any fork after start-up, create it lazily in the worker (threads do not survive `fork`), for example:

```python
import functools
from keepyourprompts import Client

@functools.lru_cache(maxsize=None)
def prompts() -> Client:
    return Client.from_env()

# in a view: prompts().render("triage", company="Acme")
```

## Configuration

`Client(app=..., **options)` and `AsyncClient(...)` take these keyword arguments; `from_env(environ=None, **overrides)` reads the environment variables and then applies the overrides.

| Option | Env var | Default | Meaning |
| --- | --- | --- | --- |
| `app` | `KYP_APP` | required | App slug. |
| `env` | `KYP_ENV` | `"prod"` | Environment slug. |
| `delivery_key` | `KYP_DELIVERY_KEY` | none | Read-only delivery key; enables the CDN and origin mirrors. Keep it server-side. |
| `snapshot_dir` | `KYP_SNAPSHOT_DIR` | none | A snapshot folder shipped with the app. |
| `cache_dir` | `KYP_CACHE_DIR` | none | Disk cache written by the SDK, so restarts without network come up on the last good version. |
| `embedded_snapshot` | | none | `{"kyp": 1, "files": {...}}`, e.g. from `Client.to_snapshot()`. |
| `git_mirror`, `git_token` | `KYP_GIT_MIRROR`, `KYP_GIT_TOKEN` | none | Your git sync target, e.g. `https://raw.githubusercontent.com/acme/prompts/main/.kyp`; the token is sent as `Authorization: Bearer`. |
| `cdn_url` | `KYP_CDN_URL` | `https://cdn.keepyourprompts.com/v1/d` | |
| `origin_url` | `KYP_ORIGIN_URL` | `https://api.keepyourprompts.com/v1/delivery` | |
| `workspace` | `KYP_WORKSPACE` | found by scanning `cache_dir` | |
| `poll_interval` | `KYP_POLL_INTERVAL` | 30 s, ±10% jitter | Seconds between revalidations (minimum 0.1). |
| `request_timeout`, `startup_timeout` | | 5 s, 3 s | Per request; how long construction may wait on the network when nothing local exists. |
| `max_backoff` | | 300 s | Longest a failing mirror is skipped. |
| `start_empty` | | `False` | Start with no prompts instead of raising `UnavailableError`. |
| `auto_refresh` | | `True` | Run the background refresher. |
| `on_update` | | none | Called after a new revision is swapped in. |
| `mirrors`, `extra_mirrors` | | | Replace or extend the default list with `Mirror(name, url, token="")`: an `https://` URL, a folder or `embedded:`. |
| `log_level` | `KYP_LOG` | | Sets the level of the `keepyourprompts` logger (`debug`, `info`, `warn`, `error`, `off`). |
| `user_agent` | | `kyp-python/0.1.0` | |
| `api_key`, `api_url` | `KYP_API_KEY`, `KYP_API_URL` | none, `https://api.keepyourprompts.com` | Outcome reporting (below). |

Logs go to the standard `logging` logger `keepyourprompts` (a `NullHandler` is attached, as for any library: configure logging to see them). The delivery key is never logged.

## Availability: mirrors

Every copy of your prompts uses the same layout, `envs/<app>/<env>.json` (the manifest: which body is live) plus `blobs/<sha256>` (immutable bodies), so the client treats every copy as an interchangeable mirror:

| # | Mirror | `status().source` | Enabled when |
| --- | --- | --- | --- |
| 1 | Embedded snapshot | `embedded` | `embedded_snapshot` |
| 2 | Snapshot folder | `snapshot` | `snapshot_dir` |
| 3 | Disk cache | `disk-cache` | `cache_dir` |
| 4 | CDN (Cloudflare over R2) | `cdn` | a delivery key |
| 5 | Origin API | `origin` | a delivery key |
| 6 | Your git repo | `git` | `git_mirror` |

- **Start-up** reads the local mirrors (1 to 3) and starts from the highest revision found, so a fresh disk cache beats an older bundled snapshot. Only when nothing local exists does the constructor wait on the network, for up to `startup_timeout`.
- **Refresh** revalidates the manifest with `If-None-Match` across the network mirrors in order, stopping at the first that answers (a `304` costs nothing). A new revision has its missing blobs fetched from the disk cache, the same mirror or any other mirror, each verified with SHA-256, written to the disk cache (temp file, fsync, rename), and then the whole state is swapped in one assignment. Without network mirrors, the snapshot folder is polled instead, so a folder kept current by a sidecar or `git pull` is picked up live.
- **Failures never evict.** A failing mirror is skipped for 0, 1, 3, 7, ... poll intervals (up to `max_backoff`); a manifest with a lower revision than the one held is ignored; a body whose hash does not match is discarded. `status()` reports `last_error` (for example `cdn: HTTP 503`) and `stale_for` in seconds: alert on that.

## Snapshots

```sh
python -m keepyourprompts snapshot --app support-bot --env prod --out ./prompts
```

Options: `--key` (default `$KYP_DELIVERY_KEY`), `--cdn`, `--origin`, `--git`, `--git-token`, `--mirror <url>` (repeatable), `--timeout <seconds>`, `-q`. The folder is a complete offline mirror: commit it or bake it into the image and set `KYP_SNAPSHOT_DIR`, so the app starts with zero network. In code: `pull_snapshot(out_dir, app=..., delivery_key=...)`. The command is also installed as `keepyourprompts`.

## Outcome reporting (optional)

With an API key, tell Keep Your Prompts how each call went; the dashboard aggregates outcomes per prompt version.

```python
prompts = Client.from_env()  # KYP_API_KEY set
started = time.monotonic()
response = client.messages.create(...)
prompts.report(
    "triage",
    "success",  # "success" | "failure" | "feedback_positive" | "feedback_negative"
    latency_ms=(time.monotonic() - started) * 1000,
    input_tokens=response.usage.input_tokens,
    output_tokens=response.usage.output_tokens,
)
```

Reports are buffered (up to 1000, oldest dropped first), sent every 10 s or per 500 from a background thread (a task for `AsyncClient`) to `POST {api_url}/v1/apps/{app}/outcomes` with `Authorization: Bearer <api_key>`, and never raise. `close()` flushes them.

## Observability

Link every LLM call to the exact prompt version it used, and watch delivery health, with the names shared by every
Keep Your Prompts SDK ([`protocol/tracing.md`](../protocol/tracing.md)).

**Metadata, no dependency.** `meta(name)` and `render_with_meta(name, **vars)` read memory only, like `render`:

```python
r = prompts.render_with_meta("triage", company="Acme")
r.text                      # the rendered prompt
r.meta                      # PromptMeta(name='triage', version=7, sha256='f31b…', app, env, workspace, revision=42, source='cdn')
r.meta.attributes()         # {'kyp.prompt.name': 'triage', 'kyp.prompt.version': 7, …, 'gen_ai.prompt.version': '7'}
r.meta.langfuse_metadata()  # {'kyp_prompt_name': 'triage', 'kyp_prompt_version': 7, 'kyp_prompt_sha256': …}
r.meta.langsmith_metadata() # the same flat dict
prompts.report(r, "success")  # outcomes count against the body you actually used
```

With Langfuse: `langfuse.update_current_generation(metadata=r.meta.langfuse_metadata())`. With LangSmith:
`@traceable(metadata=...)` or `langsmith_extra={"metadata": r.meta.langsmith_metadata()}`.

**OpenTelemetry.** `pip install "keepyourprompts[otel]"` (adds `opentelemetry-api`; only `keepyourprompts.otel`
imports it):

```python
from opentelemetry import trace
from keepyourprompts.otel import instrument

otel = instrument(prompts)  # global providers, or tracer_provider=..., meter_provider=...
tracer = trace.get_tracer(__name__)

with tracer.start_as_current_span("chat triage"):      # or the span your model instrumentation created
    r = prompts.render_with_meta("triage", company="Acme")
    otel.annotate(r)  # kyp.prompt.name/version/sha256, kyp.app/env/revision/workspace/source, gen_ai.prompt.*
    response = anthropic.messages.create(system=r.text, ...)
```

- `otel.annotate(name | meta | rendered, span=None, variables=None)` sets the attributes on the current span (or
  `span`) and returns the metadata. `keepyourprompts.otel.annotate(meta, ...)` does the same without a client.
- `instrument` records a `kyp.refresh` span per refresh round that changed something or had trouble (events
  `kyp.fallback`, `kyp.hash_mismatch`, `kyp.update`) and the metrics `kyp.refresh.duration`, `kyp.staleness`,
  `kyp.revision`, `kyp.fallbacks`, `kyp.hash_mismatches`, `kyp.render.errors` (scope `keepyourprompts`). To see
  the start-up round as well, pass `observer=` to the client.
- Options: `capture_content` (default `False`), `gen_ai_attributes` (default `True`), `open_inference` (adds
  `prompt.vendor`, `prompt.id`, `llm.prompt_template.version` for Arize Phoenix), `trace_all_refreshes` (also
  trace uneventful `304` rounds). `otel.shutdown()` detaches it. Works with `Client` and `AsyncClient`.
- Without OpenTelemetry, subclass `keepyourprompts.Observer` (`on_refresh`, `on_render_error`) and pass it as
  `observer=` or to `prompts.add_observer(...)`.

> **Privacy.** By default no prompt text and no variable value leaves your process. `capture_content=True` (or
> `KYP_OTEL_CAPTURE_CONTENT=true`) adds the template (`kyp.prompt.template`) and every variable passed to
> `annotate` (`gen_ai.prompt.variable.<name>`) to your spans. Variable values often contain personal data or
> customer content, and they then reach every backend your traces go to, under its retention and access rules.
> Turn it on only where that is acceptable.

## API

| Member | Description |
| --- | --- |
| `Client(app, **options)`, `Client.from_env(environ=None, **overrides)` | Load prompts and start the refresher. Raises `UnavailableError` when nothing can be loaded. |
| `get(name)`, `try_get(name)`, `name in prompts` | Raw template; `get` raises `NotFoundError` (also a `KeyError`). |
| `render(name, vars=None, /, *, strict=True, on_missing=None, **vars)` | Raises `NotFoundError` or `MissingVariableError` (`.names` lists every missing variable). |
| `prompt(name)` | Frozen `Prompt(name, version, sha256, variables, text)` with `.render(...)`. |
| `meta(name)`, `render_with_meta(name, vars=None, /, **vars)` | `PromptMeta` and `Rendered(text, meta)`; see Observability. |
| `add_observer(observer)` | Delivery telemetry hook (`on_refresh`, `on_render_error`); returns a function that unsubscribes. |
| `names()`, `revision` | Prompt names and revision currently held. |
| `status()` | `Status(ready, source, revision, workspace, deployed_at, prompt_count, last_success, last_error, stale_for, mirrors)`. |
| `refresh()` | Revalidate now, ignoring backoff; `True` if a mirror answered. |
| `on_update(callback)` | Register (usable as a decorator); `remove_update_listener(callback)`. |
| `report(prompt, outcome, *, latency_ms, input_tokens, output_tokens)`, `flush()` | Outcome reporting; `prompt` is a name, a `PromptMeta` or a `Rendered`. |
| `to_snapshot()` | The state held now, usable as `embedded_snapshot`. |
| `close()`, `with Client(...) as prompts:` | Stop the refresher and flush reports. Reads keep working. |

`AsyncClient`: the same, with `await AsyncClient.from_env()` / `await AsyncClient.create(...)` / `async with`, and `await` on `refresh()`, `flush()` and `close()`.

Pure helpers: `render_template(template, vars, *, strict=True, on_missing=None)`, `template_variables(template)`, `parse_manifest(data, app=None, env=None)`, `sha256_hex(data)`. Errors: `KypError` and its subclasses `NotFoundError`, `MissingVariableError`, `UnavailableError`, `ProtocolError`.

Templates: `{{name}}` (spaces inside the braces allowed) is replaced by `str(value)`; `{{{{` renders a literal `{{`; nothing else is special and values are never rendered again.

## Development

```sh
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
ruff check . && ruff format --check .
pytest   # conformance suite (starts ../conformance/fake_cdn.py) and unit tests
```
