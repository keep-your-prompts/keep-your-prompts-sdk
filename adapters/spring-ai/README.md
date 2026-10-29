# Keep Your Prompts for Spring AI

Spring AI `PromptTemplate`, `SystemPromptTemplate`, messages and `Prompt`s from prompts deployed with
[Keep Your Prompts](https://keepyourprompts.com), with Spring Boot auto-configuration.

- Maven `com.keepyourprompts:kyp-spring-ai:0.1.0` (preview, not published yet). Java 17+, Spring AI 2.0, Spring
  Boot 4.
- Depends on [`com.keepyourprompts:kyp-sdk`](../../java); Spring AI (`spring-ai-model`) and Spring Boot
  (`spring-boot-autoconfigure`) are `provided`: your application brings them.
- Every call reads the client's memory (no network) and builds objects from the version deployed at that moment, so
  deploys apply to the next request without a restart. Rendering is the core SDK's: a missing variable throws
  `MissingVariableException` unless you set `kyp.on-missing`.
- This code is under the repository's [LICENSE](../../LICENSE) (shipped in the jar as `META-INF/LICENSE`).

## Install

```xml
<dependency>
  <groupId>com.keepyourprompts</groupId>
  <artifactId>kyp-spring-ai</artifactId>
  <version>0.1.0</version>
</dependency>
```

## Quickstart

```properties
# application.properties (or the KYP_APP, KYP_ENV, KYP_DELIVERY_KEY environment variables)
kyp.app=support-bot
kyp.env=prod
kyp.delivery-key=${KYP_DELIVERY_KEY}
```

```java
@RestController
class SupportController {
  private final ChatClient chat;
  private final KypPrompts prompts;

  SupportController(ChatClient.Builder builder, KypPrompts prompts) {
    // Templates written in ChatClient calls also use {{var}} syntax, rendered like the core SDK.
    this.chat = builder.defaultTemplateRenderer(prompts.renderer()).build();
    this.prompts = prompts;
  }

  @PostMapping("/ask")
  String ask(@RequestBody String question) {
    return chat.prompt()
        .messages(prompts.systemMessage("triage", Map.of("company", "Acme")))   // deployed system prompt
        .user(question)
        .call()
        .content();
  }
}
```

Or with templates and `ChatModel` directly:

```java
PromptTemplate template = prompts.promptTemplate("ticket-summary");          // uses KypTemplateRenderer
Prompt prompt = template.create(Map.of("ticket", text), chatOptions);
SystemPromptTemplate system = prompts.systemPromptTemplate("triage");
Prompt full = prompts.prompt("triage", Map.of("company", "Acme"), "My invoice is wrong.", chatOptions);
```

## Templates

Spring AI renders templates with a `TemplateRenderer` (StringTemplate's `{name}` by default). `KypTemplateRenderer`
plugs in the Keep Your Prompts syntax (`{{name}}`, `{{{{` for a literal `{{`) through the core SDK, so output is
identical to `KeepYourPrompts.render`. Every template from `KypPrompts` uses it; pass `prompts.renderer()` to
`ChatClient.Builder.defaultTemplateRenderer` to use it in `ChatClient` calls as well.

## Tracing metadata

Messages from `systemMessage`, `userMessage` and `assistantMessage` carry `kyp.prompt.name`, `kyp.prompt.version` and
`kyp.prompt.sha256` in their metadata. `prompts.metadata(name)` returns a `KypPromptMetadata(name, version, sha256)`
with `asMap()` for span attributes or logs.

## Configuration

| Property | Default | Meaning |
| --- | --- | --- |
| `kyp.enabled` | `true` | Turn the auto-configuration off. |
| `kyp.app` | `KYP_APP` | App slug. The client bean is created only when it is set. |
| `kyp.env` | `prod` | Environment slug. |
| `kyp.delivery-key` | `KYP_DELIVERY_KEY` | Read-only delivery key. Keep it server-side. |
| `kyp.snapshot-dir`, `kyp.snapshot-classpath` | none | A snapshot folder, or one on the classpath (e.g. `kyp`). |
| `kyp.cache-dir` | none | Disk cache. |
| `kyp.git-mirror`, `kyp.git-token` | none | Your git sync target. |
| `kyp.poll-interval` | `30s` | Revalidation interval. |
| `kyp.start-empty` | `false` | Start with no prompts instead of failing when nothing can be loaded. |
| `kyp.on-missing` | `error` | `error`, `keep` or `empty`. |

Beans: `KeepYourPrompts` (closed on shutdown), `KypTemplateRenderer`, `KypPrompts`. Each steps aside when your
application defines its own.

## API

| Member of `KypPrompts` | Returns |
| --- | --- |
| `promptTemplate(name)`, `systemPromptTemplate(name)` | `PromptTemplate`, `SystemPromptTemplate` with the deployed text and `KypTemplateRenderer`. |
| `systemMessage(name, vars)`, `userMessage(name, vars)`, `assistantMessage(name, vars)` | Rendered `Message` with prompt metadata. |
| `prompt(name, vars)`, `prompt(name, vars, options)`, `prompt(systemName, vars, userText, options)` | A `Prompt`. |
| `render(name, vars)`, `metadata(name)`, `renderer()`, `client()` | Text, `KypPromptMetadata`, the renderer, the client. |

## Development

```sh
(cd ../../java && mvn -B install -DskipTests)   # the core SDK into the local Maven repository
mvn -B verify                                   # tests: real Spring AI classes, ChatClient, ApplicationContextRunner
```
