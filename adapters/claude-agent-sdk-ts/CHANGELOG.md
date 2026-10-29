# Changelog

All notable changes to `@keepyourprompts/claude-agent-sdk` are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses semantic versioning.

## 0.1.0 - 2026-10-29

First release (preview).

- `KypClaude`: per-session `systemPrompt`, `agents` and `plugins` options from deployed prompts, with the metadata of
  every prompt used (`lastPrompts()`).
- `kypSystemPrompt` (string or `claude_code` preset with `append`), `kypAgents` / `agentDefinition` (front matter
  like Claude Code agent files), `materializeSkills` (a local plugin with one `SKILL.md` per skill, rewritten only on
  change), `parseFrontMatter`, `promptMetadata`, `promptAttributes`.
