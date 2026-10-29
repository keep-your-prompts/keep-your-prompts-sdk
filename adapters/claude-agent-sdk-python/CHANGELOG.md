# Changelog

All notable changes to `keepyourprompts-claude-agent-sdk` are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses semantic versioning.

## 0.1.0 - 2026-10-29

First release (preview).

- `KypClaude`: per-session `ClaudeAgentOptions` (`system_prompt`, `agents`, `plugins`) from deployed prompts, with
  the metadata of every prompt used (`last_prompts()`).
- `kyp_system_prompt` (string or `claude_code` preset with `append`), `kyp_agents` / `agent_definition` (front matter
  like Claude Code agent files), `materialize_skills` (a local plugin with one `SKILL.md` per skill, rewritten only on
  change), `parse_front_matter`, `prompt_attributes`.
