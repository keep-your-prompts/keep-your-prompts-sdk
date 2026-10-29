# Changelog

All notable changes to `KeepYourPrompts.SemanticKernel` are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses semantic versioning.

## 0.1.0 - 2026-10-29

First release (preview).

- `KypPromptTemplateFactory` (`template_format: kyp`) and `KypPromptTemplate`: `{{var}}` templates rendered by the core
  SDK, strict by default, with Semantic Kernel's value encoding unless `AllowDangerouslySetContent`.
- `CreateFunctionFromDeployedPrompt` and `CreatePluginFromDeployedPrompts`: functions that render the deployed
  version on every call.
- `KypPromptMetadataFilter` / `AddKypPromptMetadata`: `kyp.prompt.*` in `FunctionResult.Metadata`.
