# Changelog

All notable changes to `keepyourprompts-langchain` are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses semantic versioning.

## 0.1.0 - 2026-10-29

First release (preview).

- `to_fstring`: converts `{{var}}` templates to LangChain f-strings, escaping literal braces, with variables found by
  the core SDK so formatting matches `client.render`.
- `load_prompt_template`, `load_chat_prompt_template`, `kyp_message`: LangChain templates with `kyp.prompt.*` metadata.
- `pull(name)` (hub-like), `set_default_client`, and `live_prompt(name)`, a runnable that follows deploys.
