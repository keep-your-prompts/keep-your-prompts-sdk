# Changelog

All notable changes to `@keepyourprompts/openai-agents` are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses semantic versioning.

## 0.1.0 - 2026-10-29

First release (preview).

- `kypInstructions`: dynamic `instructions` rendering a deployed prompt on every run (variables from the run
  context, fixed values or a resolver; strict by default), with an `onRender` hook.
- `kypText`, `lastRendered`, `promptMetadata`, `promptAttributes`.
