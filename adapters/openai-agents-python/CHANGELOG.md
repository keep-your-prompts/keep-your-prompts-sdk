# Changelog

All notable changes to `keepyourprompts-openai-agents` are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses semantic versioning.

## 0.1.0 - 2026-10-29

First release (preview).

- `kyp_instructions`: dynamic `instructions` rendering a deployed prompt on every run (variables from the run
  context, a mapping or a sync/async resolver; strict by default), with an `on_render` hook.
- `kyp_text`, `last_rendered`, `prompt_attributes`.
