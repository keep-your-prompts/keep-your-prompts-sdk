# Changelog

All notable changes to `@keepyourprompts/ai-sdk` are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses semantic versioning.

## 0.1.0 - 2026-10-29

First release (preview).

- `kypInstructions`, `kypSystem` and `kypMessages`: deployed prompts rendered by the core SDK (strict by default) as
  AI SDK 7 instructions and messages, tagged with name, version and sha256 in `providerOptions.kyp`.
- `kypMiddleware()`: `LanguageModelV4Middleware` that strips the tag before the provider and adds
  `providerMetadata.kyp` to `generateText` results and `streamText` finish parts; optional `onCall` hook.
- `promptMetadata` and `promptAttributes` helpers.
