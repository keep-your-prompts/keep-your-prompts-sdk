# Keep Your Prompts: Java SDK

Read deployed prompts from memory, keep them fresh in the background, and keep serving when the network does not. Works from Java, Kotlin and Scala.

```java
try (KeepYourPrompts prompts = KeepYourPrompts.fromEnv()) {          // KYP_DELIVERY_KEY, KYP_APP, KYP_ENV
  String system = prompts.render("triage", Map.of("company", "Acme", "billing_queue", "refunds"));
}
```

- Java 17+ (bytecode 17, tested on 17, 21 and 25). **Zero runtime dependencies**: `java.net.http.HttpClient`, `MessageDigest` and a small internal JSON parser (`opentelemetry-api` is optional, for `com.keepyourprompts.otel`).
- Implements [prompt delivery protocol v1](../protocol/README.md) and passes the shared [conformance suite](../conformance/README.md).
- License: see the repository's `LICENSE` file.

## Install

Maven:

```xml
<dependency>
  <groupId>com.keepyourprompts</groupId>
  <artifactId>kyp-sdk</artifactId>
  <version>0.1.0</version>
</dependency>
```

Gradle (Kotlin DSL): `implementation("com.keepyourprompts:kyp-sdk:0.1.0")`. sbt: `libraryDependencies += "com.keepyourprompts" % "kyp-sdk" % "0.1.0"`.

The jar declares `Automatic-Module-Name: com.keepyourprompts` for JPMS users.

## Quickstart

```java
import com.keepyourprompts.KeepYourPrompts;
import java.time.Duration;
import java.util.Map;

KeepYourPrompts prompts = KeepYourPrompts.builder()
    .app("support-bot")
    .env("prod")
    .deliveryKey(System.getenv("KYP_DELIVERY_KEY"))
    .snapshotFromClasspath("prompts")             // optional: start with zero network
    .cacheDir(Path.of("/var/cache/kyp"))          // optional: survive restarts without network
    .onUpdate(u -> log.info("prompts r{} -> r{}: {}", u.oldRevision(), u.newRevision(), u.changed()))
    .build();

String raw   = prompts.get("triage");                                   // raw template, no I/O
String text  = prompts.render("triage", Map.of("company", "Acme"));     // {{company}} -> Acme
Prompt p     = prompts.prompt("agents/reviewer");                       // name, version, sha256, variables, text
Status s     = prompts.status();                                        // ready, source, revision, staleFor, ...
boolean ok   = prompts.refresh();                                       // revalidate now
prompts.close();                                                        // stops the refresher; reads keep working
```

`KeepYourPrompts` is thread-safe and meant to be a singleton. `get`, `render`, `prompt`, `contains`, `names` and `revision` are one volatile read plus a `HashMap` lookup: no I/O, no locks.

## API

| Member | Description |
| --- | --- |
| `static KeepYourPrompts fromEnv()` | `builderFromEnv().build()`. |
| `static Builder builder()` / `builderFromEnv()` | Fluent configuration (below); `builderFromEnv()` starts from the `KYP_*` variables. |
| `String get(String name)` | Raw template. Throws `PromptNotFoundException`. |
| `Optional<String> tryGet(String name)`, `boolean contains(String name)` | |
| `Prompt prompt(String name)` | Record `(name, version, sha256, variables, text)` with `render(Map)`. |
| `String render(String name, Map<String, ?> vars[, OnMissing])` | Values via `String.valueOf`. Throws `PromptNotFoundException`, `MissingVariableException` (lists every missing name). `OnMissing.KEEP` leaves `{{name}}`, `EMPTY` drops it. |
| `PromptMeta meta(String name)`, `Rendered renderWithMeta(String name, Map<String, ?> vars[, OnMissing])` | Prompt metadata; see Observability. |
| `Runnable addObserver(Telemetry.Observer o)` | Delivery telemetry hook (refresh rounds, render errors); returns an unsubscribe handle. |
| `List<String> names()`, `long revision()` | Current revision, 0 when nothing is loaded. |
| `Status status()` | Record: `ready`, `source`, `revision`, `workspace`, `deployedAt`, `promptCount`, `lastSuccess`, `lastError`, `staleFor`, `mirrors` (per mirror: `name`, `url`, `consecutiveFailures`, `lastError`, `lastSuccess`). |
| `boolean refresh()` | Revalidate now across the mirrors, ignoring backoff. `true` if a mirror answered. |
| `Runnable onUpdate(Consumer<Update> listener)` | Register a listener (returns an unsubscribe handle). `Update(oldRevision, newRevision, source, changed)`, called after the swap on the refresher thread (or the caller of `refresh()`); exceptions are caught and logged. |
| `void close()` | `AutoCloseable`: stops the refresher. Idempotent. |
| `static SnapshotInfo pullSnapshot(Builder, Path outDir)` | Write the deployed state to a folder (what `kyp pull` does), e.g. in a build step. |
| `Templates.render(...)`, `Templates.variables(...)`, `Templates.sha256Hex(...)` | The template engine and hash on their own. |

All exceptions are unchecked and extend `KypException`: `PromptNotFoundException` (`name()`), `MissingVariableException` (`names()`), `UnavailableException`, `ProtocolException`.

## Observability

Link every LLM call to the exact prompt version it used, and watch delivery health, with the names shared by every
Keep Your Prompts SDK ([`protocol/tracing.md`](../protocol/tracing.md)).

**Metadata, no dependency.** `meta(name)` and `renderWithMeta(name, vars)` read memory only, like `render`:

```java
Rendered r = prompts.renderWithMeta("triage", Map.of("company", "Acme"));
r.text();                      // the rendered prompt
r.meta();                      // PromptMeta[name=triage, version=7, sha256=f31b…, app, env, workspace, revision=42, source=cdn]
r.meta().attributes();         // kyp.prompt.name, kyp.prompt.version, …, gen_ai.prompt.name, gen_ai.prompt.version ("7")
r.meta().langfuseMetadata();   // kyp_prompt_name, kyp_prompt_version, kyp_prompt_sha256, … (flat keys)
r.meta().langsmithMetadata();  // the same flat map
```

**OpenTelemetry.** `io.opentelemetry:opentelemetry-api` is an *optional* dependency of the SDK: add it to your build
(most apps with OpenTelemetry already have it); only the `com.keepyourprompts.otel` package uses it.

```java
import com.keepyourprompts.otel.KypOpenTelemetry;

KypOpenTelemetry otel = KypOpenTelemetry.instrument(prompts); // GlobalOpenTelemetry, or builder().openTelemetry(sdk)

Span span = tracer.spanBuilder("chat triage").startSpan();     // or the span your model instrumentation created
try (Scope s = span.makeCurrent()) {
  Rendered r = prompts.renderWithMeta("triage", Map.of("company", "Acme"));
  otel.annotate(r); // kyp.prompt.name/version/sha256, kyp.app/env/revision/workspace/source, gen_ai.prompt.*
  // ... call the model with r.text() ...
} finally {
  span.end();
}
```

- `annotate(name | meta | rendered)` uses `Span.current()`; `annotate(span, meta, variables)` takes an explicit span.
  `KypOpenTelemetry.annotateSpan(...)` works without an instance.
- The instrumentation records a `kyp.refresh` span per refresh round that changed something or had trouble (events
  `kyp.fallback`, `kyp.hash_mismatch`, `kyp.update`; a manual `refresh()` joins the current trace) and the metrics
  `kyp.refresh.duration`, `kyp.staleness`, `kyp.revision`, `kyp.fallbacks`, `kyp.hash_mismatches`,
  `kyp.render.errors` (scope `keepyourprompts`). To see the start-up round too:
  `var k = KypOpenTelemetry.builder().build(); var prompts = KeepYourPrompts.builderFromEnv().observer(k).build(); k.attach(prompts);`
- Builder options: `captureContent`, `genAiAttributes` (default `true`), `openInference` (adds `prompt.vendor`,
  `prompt.id`, `llm.prompt_template.version` for Arize Phoenix), `traceAllRefreshes`. `close()` detaches it.
- Without OpenTelemetry, implement `Telemetry.Observer` (`onRefresh`, `onRenderError`) and pass it to
  `builder().observer(...)` or `prompts.addObserver(...)`.

> **Privacy.** By default no prompt text and no variable value leaves your process. `captureContent(true)` (or
> `KYP_OTEL_CAPTURE_CONTENT=true`) adds the template (`kyp.prompt.template`) and every variable passed to `annotate`
> (`gen_ai.prompt.variable.<name>`) to your spans. Variable values often contain personal data or customer content,
> and they then reach every backend your traces go to, under its retention and access rules. Turn it on only where
> that is acceptable.

## Configuration

| Builder method | Default | Env var (`fromEnv`) |
| --- | --- | --- |
| `app(String)` | required | `KYP_APP` |
| `env(String)` | `"prod"` | `KYP_ENV` |
| `deliveryKey(String)` | none: no CDN/origin | `KYP_DELIVERY_KEY` |
| `snapshotDir(Path)` | none | `KYP_SNAPSHOT_DIR` |
| `snapshotFromClasspath(String prefix[, ClassLoader])` | none | `KYP_SNAPSHOT_DIR=classpath:prompts` |
| `cacheDir(Path)` | none: no disk cache | `KYP_CACHE_DIR` |
| `gitMirror(String url[, String token])` | none | `KYP_GIT_MIRROR`, `KYP_GIT_TOKEN` |
| `workspace(String)` | found by scanning `cacheDir` | `KYP_WORKSPACE` |
| `cdnBase(String)` / `originBase(String)` | `https://cdn.keepyourprompts.com/v1/d`, `https://api.keepyourprompts.com/v1/delivery` | `KYP_CDN_URL`, `KYP_ORIGIN_URL` |
| `mirrors(List<Mirror>)` / `addMirror(Mirror)` | snapshot, CDN, origin, git | |
| `pollInterval(Duration)` | 30 s (minimum 100 ms), plus or minus 10% jitter | `KYP_POLL_INTERVAL` (seconds) |
| `connectTimeout` / `requestTimeout` | 2 s / 5 s | |
| `startupTimeout(Duration)` | 3 s | |
| `startEmpty(boolean)` | `false` | |
| `maxBackoff(Duration)` | 5 min | |
| `userAgent(String)` | `kyp-java/0.1.0` | |
| `onUpdate(Consumer<Update>)` | none | |
| `logger(BiConsumer<LogLevel, String>)` | `System.Logger` `com.keepyourprompts` (JUL by default; SLF4J/Log4j through their `System.Logger` bridges) | |
| `logLevel(LogLevel)` | `WARN` | `KYP_LOG=debug\|info\|warn\|error\|off` |

The delivery key never appears in logs or `status()`; it is shortened to `kypd_Ab3d...`. HTTP goes through the JVM's default `ProxySelector` (`https.proxyHost`, `-Djava.net.useSystemProxies=true`).

## Mirrors and availability

Every copy of your prompts uses the same layout, `envs/<app>/<env>.json` plus immutable `blobs/<sha256>`, so the client treats them as interchangeable mirrors, in this order:

| # | Mirror | `status().source()` | Enabled when |
| --- | --- | --- | --- |
| 1 | Snapshot on the class path (inside your jar) | `embedded` | `snapshotFromClasspath(...)` |
| 2 | Snapshot folder | `snapshot` | `snapshotDir` / `KYP_SNAPSHOT_DIR` |
| 3 | Disk cache written by the SDK | `disk-cache` | `cacheDir` / `KYP_CACHE_DIR` |
| 4 | CDN `https://cdn.keepyourprompts.com/v1/d/<key>` | `cdn` | a delivery key is set |
| 5 | Origin `https://api.keepyourprompts.com/v1/delivery/<key>` | `origin` | a delivery key is set |
| 6 | Your git repo (`.kyp/` written by git sync) | `git` | `gitMirror` / `KYP_GIT_MIRROR` |

- **Start-up.** Mirrors 1 to 3 are read without the network and the highest revision wins, so `build()` returns at once. Otherwise it waits on the network for up to `startupTimeout`, then throws `UnavailableException` (or starts empty with `startEmpty(true)` and keeps trying).
- **Refresh.** A daemon thread (`ScheduledExecutorService`, `kyp-refresh-<app>/<env>`) revalidates the manifest every `pollInterval` with `If-None-Match`; a `304` costs nothing. A new revision has its missing blobs fetched (disk cache, then the same mirror, then any other), each **verified with SHA-256**, written to the disk cache (temp file, fsync, atomic rename), then the whole state is swapped through one `AtomicReference`. A lower revision than the one held (a stale mirror) is ignored.
- **Failures never evict.** A failing mirror is skipped for 0, 1, 3, 7, ... poll intervals (capped at `maxBackoff`) and the next one is asked; if every mirror is down, reads keep returning the last good prompts and `status().staleFor()` grows. Alert on that.
- **No network mirror configured?** The refresher then polls the snapshot folder, so a folder kept current by a sidecar or `git pull` is picked up live.

### Snapshot inside the jar (Spring Boot, fat jars, containers)

Pull the deployed state into `src/main/resources/prompts` at build time (`kyp pull --app support-bot --env prod --out src/main/resources/prompts`, or `KeepYourPrompts.pullSnapshot(...)` from a build step), then:

```java
KeepYourPrompts.builder().app("support-bot").snapshotFromClasspath("prompts").deliveryKey(key).build();
```

The app starts with zero network from the bundled revision and upgrades in the background as soon as the CDN answers.

## Spring Boot

```java
@Configuration
class PromptsConfig {
  @Bean(destroyMethod = "close")
  KeepYourPrompts prompts(@Value("${kyp.delivery-key}") String key) {
    return KeepYourPrompts.builder()
        .app("support-bot")
        .env("prod")
        .deliveryKey(key)
        .snapshotFromClasspath("prompts")
        .cacheDir(Path.of(System.getProperty("java.io.tmpdir"), "kyp"))
        .build();
  }

  @Bean
  HealthIndicator promptsHealth(KeepYourPrompts prompts) {
    return () -> {
      Status s = prompts.status();
      return (s.ready() ? Health.up() : Health.down())
          .withDetail("revision", s.revision())
          .withDetail("source", s.source())
          .withDetail("staleSeconds", s.staleFor().toSeconds())
          .build();
    };
  }
}
```

## Kotlin

```kotlin
import com.keepyourprompts.KeepYourPrompts

val prompts = KeepYourPrompts.builder()
    .app("support-bot")
    .deliveryKey(System.getenv("KYP_DELIVERY_KEY"))
    .onUpdate { println("now at revision ${it.newRevision()}: ${it.changed()}") }
    .build()

prompts.use {
    val system = it.render("triage", mapOf("company" to "Acme", "billing_queue" to "refunds"))
    val missing = it.tryGet("maybe").orElse(null)
}
```

`src/test/kotlin/.../KotlinUsageTest.kt` compiles and runs this style against the real API with `mvn -Pkotlin verify`.

## Example: Claude with a managed system prompt

With the official Anthropic Java SDK (`com.anthropic:anthropic-java`):

```java
import com.anthropic.client.AnthropicClient;
import com.anthropic.client.okhttp.AnthropicOkHttpClient;
import com.anthropic.models.messages.Message;
import com.anthropic.models.messages.MessageCreateParams;

KeepYourPrompts prompts = KeepYourPrompts.fromEnv();
AnthropicClient claude = AnthropicOkHttpClient.fromEnv();              // ANTHROPIC_API_KEY

MessageCreateParams params = MessageCreateParams.builder()
    .model("claude-opus-5-5")
    .maxTokens(16000L)
    .system(prompts.render("triage", Map.of("company", "Acme", "billing_queue", "refunds")))
    .addUserMessage("I was charged twice this month.")
    .build();

Message reply = claude.messages().create(params);
reply.content().stream()
    .flatMap(block -> block.text().stream())
    .forEach(text -> System.out.println(text.text()));
```

Editing and deploying `triage` in Keep Your Prompts changes what the next request sends, without a redeploy of your service. Log `prompts.prompt("triage").version()` next to each request to know which version produced an answer.

## Build and test

```sh
mvn verify                 # unit tests, cases.json, HTTP conformance (in-JVM fake + fake_cdn.py when python3 exists)
mvn -Pkotlin verify        # also compiles and runs the Kotlin usage test
```

Tests read `../conformance` (override with `-Dkyp.conformance.dir=...`). The in-JVM fake CDN (`com.sun.net.httpserver`) always runs; the `fake_cdn.py` run is skipped when `python3` is missing.

## Notes on the protocol

- Start-up reads every local mirror and keeps the highest revision (ties go to the earlier mirror), so a fresh disk cache beats an older bundled snapshot.
- A blob may come from any mirror: it is verified by hash, so the source does not matter. A blob that is not valid UTF-8 is rejected.
- `revision` equal to the one held counts as confirmation; lower is ignored and reported in `lastError`.
- A manifest whose `app`/`env` differ from the ones configured, or with `schema` other than 1, is rejected. Unknown fields are ignored.
