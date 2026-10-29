# Keep Your Prompts for Semantic Kernel

Use prompts deployed with [Keep Your Prompts](https://keepyourprompts.com) in Semantic Kernel: an
`IPromptTemplateFactory` for `{{var}}` templates rendered like the core SDK, and `KernelFunction`s that render the
deployed prompt on every call.

- NuGet package `KeepYourPrompts.SemanticKernel`, version 0.1.0 (preview, not published yet). .NET 8, or
  netstandard2.0.
- Depends on [`KeepYourPrompts.Sdk`](../../dotnet) and `Microsoft.SemanticKernel.Core` `[1.81, 2)`.
- Every render reads the client's memory (no I/O), so a deploy applies to the next invocation without rebuilding the
  kernel. A missing variable throws `MissingVariableException` unless you pick `OnMissing.Keep` / `OnMissing.Empty`.
- This code is under the repository's [LICENSE](../../LICENSE) (packed at the package root).

## Install

```sh
dotnet add package KeepYourPrompts.SemanticKernel
```

## Quickstart

```csharp
using KeepYourPrompts;
using KeepYourPrompts.SemanticKernel;
using Microsoft.SemanticKernel;

var prompts = await KeepYourPromptsClient.FromEnvAsync(); // KYP_DELIVERY_KEY, KYP_APP, KYP_ENV

Kernel kernel = Kernel.CreateBuilder()
    .AddOpenAIChatCompletion("gpt-5", apiKey)   // or any chat completion connector
    .Build();
kernel.AddKypPromptMetadata();                   // kyp.prompt.* in FunctionResult.Metadata

// A function that renders the deployed "triage" prompt on every call.
KernelFunction triage = kernel.CreateFunctionFromDeployedPrompt(prompts, "triage",
    new KypFunctionOptions { Description = "Triage a support ticket" });
FunctionResult result = await kernel.InvokeAsync(triage, new() { ["company"] = "Acme" });
Console.WriteLine(result.Metadata?["kyp.prompt.version"]);

// Every deployed prompt under "support/" as a plugin (support/refunds -> function "refunds").
kernel.Plugins.Add(prompts.CreatePluginFromDeployedPrompts("support", "support/"));
```

### `template_format: kyp`

For prompts you keep in code or YAML, register the factory next to Semantic Kernel's own:

```csharp
var factory = new AggregatorPromptTemplateFactory(new KypPromptTemplateFactory(), new KernelPromptTemplateFactory());
var config = new PromptTemplateConfig("Say hi to {{name}}.") { TemplateFormat = "kyp" };
KernelFunction hi = kernel.CreateFunctionFromPrompt(config, factory);
```

## Rendering

`KypPromptTemplate` renders with the core SDK: `{{name}}` (spaces allowed inside), `{{{{` for a literal `{{`, nothing
else special, values never rendered again. Input variable defaults from the config apply.

Like Semantic Kernel's built-in template engines, argument values are HTML-encoded unless the config
(`AllowDangerouslySetContent`, or `KypFunctionOptions.AllowDangerouslySetContent`) or the input variable allows
dangerous content, so a value cannot inject `<message role="system">` tags into a chat prompt. With it allowed, the
output is byte-for-byte what `KeepYourPromptsClient.Render` returns.

## API

| Member | Description |
| --- | --- |
| `client.CreateFunctionFromDeployedPrompt(name, options?)`, `kernel.CreateFunctionFromDeployedPrompt(client, name, options?)` | A `KernelFunction` over a live `KypPromptTemplate`; parameters from the prompt's variables. |
| `client.CreatePluginFromDeployedPrompts(pluginName, prefix, options?)` | A `KernelPlugin` with one function per deployed prompt under `prefix`. |
| `KypFunctionOptions` | `FunctionName`, `Description`, `ExecutionSettings`, `AllowDangerouslySetContent`, `OnMissing`, `LoggerFactory`. |
| `KypPromptTemplateFactory(onMissing)` | `IPromptTemplateFactory` for `TemplateFormat = "kyp"`. |
| `KypPromptTemplate` | The `IPromptTemplate`; `PromptName`, `LastRendered`. |
| `kernel.AddKypPromptMetadata()`, `KypPromptMetadataFilter` | Adds `kyp.prompt.name`, `kyp.prompt.version`, `kyp.prompt.sha256` to `FunctionResult.Metadata` (non-streaming). |
| `KypPromptMetadata` | `Name`, `Version`, `Sha256`, `ToDictionary()`. |

## Development

```sh
dotnet test KeepYourPrompts.SemanticKernel.sln -c Release   # real Kernel and functions with a recording IChatCompletionService
dotnet pack src/KeepYourPrompts.SemanticKernel -c Release -o artifacts
```

The core SDK is a project reference (`../../dotnet`), packed as a dependency on `KeepYourPrompts.Sdk`.
