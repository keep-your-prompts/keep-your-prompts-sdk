# Keep Your Prompts: C++ SDK

Read deployed prompts from memory in nanoseconds, keep them fresh in the background, and keep serving when the network does not.

```cpp
#include <kyp/kyp.hpp>

auto prompts = kyp::Client::from_env();  // KYP_DELIVERY_KEY, KYP_APP, KYP_ENV
std::string p = prompts.render("triage", {{"company", "Acme"}, {"billing_queue", "refunds"}});
```

New here? Start with the [repository overview](../README.md).

- C++17, CMake 3.20+, one target: `kyp::kyp`.
- Dependencies: libcurl (system, optional) and nlohmann/json 3.11.3 (fetched and hash-pinned, used privately). SHA-256 is built in; no OpenSSL.
- Implements [prompt delivery protocol v1](../protocol/README.md).

## Install

```cmake
include(FetchContent)
FetchContent_Declare(kyp
  GIT_REPOSITORY https://github.com/keep-your-prompts/keep-your-prompts-sdk
  GIT_TAG        cpp-v0.1.0
  SOURCE_SUBDIR  cpp)
FetchContent_MakeAvailable(kyp)

target_link_libraries(my-app PRIVATE kyp::kyp)
```

libcurl headers: `apt-get install libcurl4-openssl-dev`, `dnf install libcurl-devel`, or nothing on macOS.

| CMake option | Default | Effect |
| --- | --- | --- |
| `KYP_WITH_CURL` | `ON` | HTTP(S) mirrors. `OFF` builds a file-only client (embedded, snapshot and disk cache) with no libcurl. |
| `KYP_USE_SYSTEM_JSON` | `OFF` | Use an installed `nlohmann_json` instead of fetching it. An existing `nlohmann_json::nlohmann_json` target is always reused. |
| `KYP_BUILD_TESTS`, `KYP_BUILD_EXAMPLES`, `KYP_BUILD_TOOLS` | top-level only | Tests, examples and `kyp-snapshot`. |
| `KYP_WARNINGS_AS_ERRORS` | top-level only | `-Wall -Wextra -Werror` on the SDK's own targets. |
| `KYP_WITH_OTEL` | `OFF` | Adds the `kyp::otel` target (`<kyp/otel.hpp>`, header-only) on `find_package(opentelemetry-cpp)`'s `opentelemetry-cpp::api`. See [Observability](#observability). |

## How it works

Every copy of your prompts uses the same layout: `envs/<app>/<env>.json` (the manifest: which body is live) and `blobs/<sha256>` (immutable bodies). The client treats every copy as a mirror and tries them in order:

| # | Mirror | Name in `status()` | Enabled when |
| --- | --- | --- | --- |
| 1 | Snapshot compiled into the binary | `embedded` | `kyp_embed_snapshot()` was used for this app/env |
| 2 | Snapshot folder | `snapshot` | `snapshot_dir` / `KYP_SNAPSHOT_DIR` |
| 3 | Disk cache written by the SDK | `disk-cache` | `cache_dir` / `KYP_CACHE_DIR` |
| 4 | CDN `https://cdn.keepyourprompts.com/v1/d/<key>` | `cdn` | a delivery key is set |
| 5 | Origin `https://api.keepyourprompts.com/v1/delivery/<key>` | `origin` | a delivery key is set |
| 6 | Your git repo | `git` | `git_mirror` / `KYP_GIT_MIRROR` |

**Start-up.** Mirrors 1 to 3 are read without the network. If any holds the manifest, the constructor returns at once with the highest revision found and a background refresh starts immediately. Otherwise it blocks on the network mirrors for up to `startup_timeout` (3 s), then throws `kyp::Unavailable`, or starts empty if you asked for `start_empty()`.

**Refresh.** A background thread revalidates the manifest every `poll_interval` (30 s, plus or minus 10% jitter) with `If-None-Match`, asking the network mirrors in order and stopping at the first that answers. A new revision has its missing blobs fetched (from the disk cache, then the same mirror, then any other mirror), each verified with SHA-256, written to the disk cache, and then the whole state is swapped in one atomic step. A manifest with a lower revision than the one held is ignored. A failing mirror is skipped for 0, 1, 3, 7, ... poll intervals (capped at `max_backoff`, 5 min) and retried first if nothing else answers. Failures never evict what is held.

**Reads.** `get`, `render`, `prompt`, `contains` read an immutable snapshot of the state: one atomic load and a hash lookup. No I/O, no locks. The state pointer is published with `std::atomic_store` and read with `std::atomic_load` (the C++17 free functions; `std::atomic<std::shared_ptr>` under C++20); a per-thread copy keyed by a generation counter means the steady-state read is one atomic load and a compare, with no reference-count traffic.

**Network.** One libcurl easy handle per client, reused across requests (keep-alive), HTTP/2 over TLS when the server offers it, gzip, 2 s connect and 5 s total timeouts, `HTTPS_PROXY` honoured. Shutdown aborts any request in flight.

## API

Everything is in `<kyp/kyp.hpp>`, namespace `kyp`.

### `kyp::Client`

| Member | Description |
| --- | --- |
| `explicit Client(Options)` | Loads prompts (see start-up above). Throws `kyp::Unavailable`, or `kyp::Error` for invalid options. |
| `static Client from_env()` | `Client(Options::from_env())`. |
| `std::string get(std::string_view name) const` | Raw template. Throws `kyp::NotFound`. |
| `std::optional<std::string> try_get(std::string_view name) const` | Same, `std::nullopt` if absent. |
| `bool contains(std::string_view name) const` | |
| `Prompt prompt(std::string_view name) const` | `{name, version, sha256, variables, text, render(vars)}`. Throws `kyp::NotFound`. |
| `std::string render(std::string_view name, const Vars& vars, OnMissing = OnMissing::error) const` | Renders the template. Throws `kyp::NotFound`, `kyp::MissingVariable`. |
| `PromptMeta meta(std::string_view name) const` | Which body is held: `name`, `version`, `sha256`, `app`, `env`, `workspace`, `revision`, `source`; `attributes()`, `trace_metadata()`, `langfuse_metadata()`, `langsmith_metadata()`. Throws `kyp::NotFound`. |
| `Rendered render_with_meta(name, vars, OnMissing = OnMissing::error) const` | `{text, meta}`: the metadata of the exact body rendered. |
| `ObserverId add_observer(std::shared_ptr<Observer>)` / `bool remove_observer(ObserverId)` | Delivery telemetry (see [Observability](#observability)). |
| `std::vector<std::string> names() const` | Prompt names in the current revision. |
| `std::int64_t revision() const` | Current revision, `0` if nothing is loaded. |
| `Status status() const` | Health, for logs and metrics (below). |
| `bool refresh_now()` | Revalidate now, ignoring backoff. Returns `true` if a mirror answered. Do not call it from `on_update`. |
| `void close()` | Stop the refresher. Reads keep working. The destructor calls it. |

Thread-safe. Movable, not copyable. Prompt names may contain `/` (`agents/reviewer`).

### `kyp::Options`

A fluent builder: `kyp::Options().app("support-bot").env("prod").delivery_key(key)`.

| Setter | Default | Env var (`from_env`) |
| --- | --- | --- |
| `app(std::string)` | required | `KYP_APP` |
| `env(std::string)` | `"prod"` | `KYP_ENV` |
| `delivery_key(std::string)` | none: no CDN/origin | `KYP_DELIVERY_KEY` |
| `snapshot_dir(path)` | none | `KYP_SNAPSHOT_DIR` |
| `cache_dir(path)` | none: no disk cache | `KYP_CACHE_DIR` |
| `git_mirror(url, token = "")` | none | `KYP_GIT_MIRROR`, `KYP_GIT_TOKEN` |
| `embedded_snapshot(bool)` | `true` (used when one is linked in) | |
| `workspace(std::string)` | found by scanning `cache_dir` | `KYP_WORKSPACE` |
| `cdn_base(url)` / `origin_base(url)` | `https://cdn.keepyourprompts.com/v1/d`, `https://api.keepyourprompts.com/v1/delivery` | `KYP_CDN_URL`, `KYP_ORIGIN_URL` |
| `mirrors(std::vector<Mirror>)` | snapshot, CDN, origin, git | |
| `add_mirror(Mirror)` | | |
| `poll_interval(ms)` | 30 s (minimum 100 ms) | `KYP_POLL_INTERVAL` (seconds) |
| `connect_timeout(ms)` / `request_timeout(ms)` | 2 s / 5 s | |
| `startup_timeout(ms)` | 3 s | |
| `start_empty(bool)` | `false` | |
| `max_backoff(ms)` | 5 min | |
| `user_agent(std::string)` | `kyp-cpp/0.1.0` | |
| `on_update(std::function<void(const Update&)>)` | none | |
| `logger(std::function<void(LogLevel, const std::string&)>)` | stderr, `[kyp] warn: ...` | |
| `log_level(LogLevel)` | `warn` | `KYP_LOG=debug\|info\|warn\|error\|off` |
| `observer(std::shared_ptr<Observer>)` | none; registered before start-up, so the start-up round is reported | |

`mirrors()` replaces the snapshot/CDN/origin/git defaults with your own ordered list; the embedded snapshot and disk cache still apply. Build entries with `Mirror::file(dir, name)`, `Mirror::http(base_url, name, bearer_token)` and `Mirror::embedded()`. To send the delivery key as a header to the origin instead of in the path: `Mirror::http("https://api.keepyourprompts.com/v1/delivery", "origin", key)`.

The delivery key never appears in logs or `status()`; it is shortened to `kypd_Ab3d...`.

### `kyp::Status`

| Field | Meaning |
| --- | --- |
| `bool ready` | A manifest is loaded. |
| `std::string source` | Mirror that served or last confirmed the current state: `embedded`, `snapshot`, `disk-cache`, `cdn`, `origin`, `git`. |
| `std::int64_t revision`, `workspace`, `deployed_at`, `prompt_count` | From the manifest. |
| `std::optional<system_clock::time_point> last_success` | Last time a polled mirror confirmed the manifest (200 or 304). |
| `std::string last_error` | Failures in the latest round, e.g. `cdn: HTTP 503`. Empty when the first mirror answered. |
| `std::chrono::milliseconds stale_for` | Time since `last_success` (since start-up if never). Alert on this. |
| `std::vector<MirrorStatus> mirrors` | Per mirror: `name`, `url`, `consecutive_failures`, `last_error`, `last_success`. |

### `kyp::Update` (passed to `on_update`)

`old_revision`, `new_revision`, `source`, `changed` (names added, removed or with a new body). Called on the refresher thread after the swap; exceptions are caught and logged.

### Templates

```cpp
std::string kyp::render(std::string_view tmpl, const kyp::Vars& vars, kyp::OnMissing = kyp::OnMissing::error);
std::vector<std::string> kyp::variables_in(std::string_view tmpl);
std::string kyp::sha256_hex(std::string_view data);
```

`{{name}}` (spaces inside the braces allowed, names `[A-Za-z_][A-Za-z0-9_]*`) is replaced by `vars.at(name)`. `{{{{` renders a literal `{{`. Anything else is plain text: no logic, no escaping, values are not rendered again. A missing variable throws `kyp::MissingVariable` (listing every missing name) unless you pass `OnMissing::keep` or `OnMissing::empty`.

### Errors

All derive from `kyp::Error` (a `std::runtime_error`): `NotFound` (`.name()`), `MissingVariable` (`.names()`), `Unavailable`, `ProtocolError`.

## Observability

The SDK reports which prompt version each LLM call used and how delivery is doing, with the attribute, span and
metric names of [`protocol/tracing.md`](../protocol/tracing.md), the same in every SDK. The library itself has no
tracing dependency.

**Prompt metadata** (memory only, no content):

```cpp
kyp::Rendered r = prompts.render_with_meta("triage", {{"company", "Acme"}});
r.text;                       // the rendered prompt
r.meta.attributes();          // {"kyp.prompt.name", "triage"}, {"kyp.prompt.version", 7}, {"kyp.prompt.sha256", ...},
                              // {"kyp.app", ...}, {"kyp.env", ...}, {"kyp.revision", 42}, {"kyp.workspace", ...},
                              // {"kyp.source", "cdn"}, {"gen_ai.prompt.name", "triage"}, {"gen_ai.prompt.version", "7"}
r.meta.trace_metadata();      // flat keys: {"kyp_prompt_name", "triage"}, {"kyp_prompt_version", 7}, ...
```

Values are `kyp::AttrValue` (`std::variant<std::string, std::int64_t>`). `langfuse_metadata()` and
`langsmith_metadata()` return the flat map too (Langfuse observation metadata, LangSmith run metadata,
`Helicone-Property-<key>` headers). `kyp.source` is the mirror kind: `embedded`, `snapshot`, `cache`, `cdn`, `origin`,
`git` or `custom`.

**Any tracer** (`<kyp/tracing.hpp>`, header-only, no dependency): implement `kyp::tracing::Tracer` / `Span` /
`Meter` over your tracing library, or annotate through a callback:

```cpp
#include <kyp/tracing.hpp>

auto inst = std::make_shared<kyp::tracing::Instrumentation>(my_tracer, my_meter);  // either may be null
kyp::Client prompts(kyp::Options::from_env().observer(inst));  // kyp.refresh spans + kyp.* metrics

kyp::tracing::annotate(prompts, "triage", [&](const std::string& key, const kyp::AttrValue& value) {
  my_llm_span.set_attribute(key, value);                       // kyp.* + gen_ai.prompt.*
});
```

`kyp::tracing::annotation(meta, options)` returns the attribute list, `gauge_values(client)` the values of the
`kyp.staleness` and `kyp.revision` gauges for your backend's collection callback.

**OpenTelemetry** (`-DKYP_WITH_OTEL=ON`, link `kyp::otel`; needs the opentelemetry-cpp API, your app sets up the SDK):

```cpp
#include <kyp/otel.hpp>

auto otel = kyp::otel::Instrumentation::create();                 // global tracer/meter providers
kyp::Client prompts(kyp::Options::from_env().observer(otel->observer()));
otel->attach(prompts);                                            // kyp.staleness / kyp.revision gauges

auto r = prompts.render_with_meta("triage", {{"company", "Acme"}});
kyp::otel::annotate(r.meta);                                      // on the active span (or pass a span)
otel->annotate("triage", &vars);                                  // by name; adds the template with capture on
```

- A `kyp.refresh` span is recorded per refresh round (start-up, poll, `refresh_now()`; a manual refresh is a child of
  the active span) with `kyp.fallback`, `kyp.hash_mismatch` and `kyp.update` events, plus the metrics
  `kyp.refresh.duration`, `kyp.fallbacks`, `kyp.hash_mismatches`, `kyp.render.errors` and the gauges
  `kyp.staleness` and `kyp.revision`, under the instrumentation scope `keepyourprompts`. Rounds that only confirmed
  what is held (the 30-second heartbeat) are counted but not traced unless `trace_all_refreshes`.
- `kyp::otel::Options`: `tracer_provider`, `meter_provider` (default: the global ones), `annotate`
  (`capture_content`, `gen_ai_attributes`, `open_inference`), `trace_all_refreshes`. The C++ metrics API has no
  bucket advice: add a View with `kyp::tracing::kRefreshBuckets` for the recommended `kyp.refresh.duration` buckets.
- The client must outlive `attach()` (or call `detach()`).

**Content capture is off by default.** With `capture_content = true` (or `KYP_OTEL_CAPTURE_CONTENT=true`),
annotating also records the raw template as `kyp.prompt.template` and each variable passed as
`gen_ai.prompt.variable.<name>`. Templates can hold proprietary instructions and variables often hold personal data,
customer content or secrets; with capture on they reach every exporter and backend of your pipeline and stay there
under its retention. Turn it on only where that is acceptable. SDK spans and metrics never carry content.

**Your own observer**: derive from `kyp::Observer` (`on_refresh(const RefreshRecord&)`, `on_render_error(const
RenderError&)`) and pass it to `Options::observer` or `add_observer`. A `RefreshRecord` has `trigger`, `result`,
`start_time`, `duration`, `mirror`, `source`, `revision`, `previous_revision`, `workspace`, `error`, `error_type` and
`events`. Observers run outside the client's locks; an exception is caught and logged.

## Snapshots

Pull the deployed state into a folder:

```sh
kyp-snapshot --app support-bot --env prod --out ./prompts      # uses $KYP_DELIVERY_KEY
```

The folder is a complete mirror. Ship it next to the binary (`KYP_SNAPSHOT_DIR=./prompts`) or compile it in:

```cmake
kyp_embed_snapshot(my-app DIR prompts)
```

`kyp_embed_snapshot` generates a `.cpp` with each file as a byte array and adds it to the target; it regenerates when the folder changes. The client finds it on its own (`status().source == "embedded"`), so the binary starts with zero files and zero network, then upgrades in the background as soon as a network mirror answers. In code: `kyp::pull_snapshot(options, dir)`.

## Disk cache

With `cache_dir` set, every verified state is written to `<cache_dir>/<workspace>/<app>/<env>/` in the same layout (temp file, `fsync`, `rename`), so a restart without network comes up on the last version this machine saw. Several processes can share one cache directory. Blobs are re-verified when read back, so a damaged cache is skipped, never served.

## Examples and tests

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
ctest --test-dir build --output-on-failure
./build/kyp-example-bench          # ns per get()/render() with 1..N threads
```

- `examples/hello`: the ten-line integration.
- `examples/server`: a request loop that shows hot reload (`on_update`) and a health line from `status()`.
- `examples/bench`: the micro-benchmark quoted in the guide.

With `-DKYP_WITH_OTEL=ON` (and `CMAKE_PREFIX_PATH` pointing at an opentelemetry-cpp install that has the
in-memory exporters) `test_otel` checks the OpenTelemetry adapter against the SDK.

The tests use a built-in harness (no gtest). `test_http` runs `tests/fake_cdn.py` (Python 3, standard library only; ETag/304, Cache-Control, routes that can be taken down) and is reported as skipped when `python3` is missing.

## Notes on the protocol

- Start-up reads all local mirrors and keeps the highest revision (ties go to the earlier mirror), so a fresh disk cache beats an older bundled snapshot.
- When no network mirror is configured, the refresher polls the file mirrors instead, so a snapshot folder kept current by a sidecar or `git pull` is picked up live.
- A blob may come from any mirror: it is verified by hash, so the source does not matter.
- `revision` equal to the one held counts as confirmation; lower is ignored and reported in `last_error`.
- A manifest whose `app`/`env` differ from the ones configured, or with `schema` other than 1, is rejected.
