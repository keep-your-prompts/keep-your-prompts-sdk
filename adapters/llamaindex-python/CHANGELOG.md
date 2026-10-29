# Changelog

All notable changes to `keepyourprompts-llamaindex` are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses semantic versioning.

## 0.1.0 - 2026-10-29

First release (preview).

- `load_prompt_template`, `load_chat_prompt_template`, `chat_prompt_template`, `load_rich_prompt_template`: LlamaIndex
  templates whose formatting is done by the core SDK (identical output, strict missing variables, literal braces kept),
  with `kyp.prompt.*` metadata.
- `kyp_update_prompts`: `update_prompts` with a variable check and optional re-apply on every deploy.
- `to_llamaindex_template`, `to_jinja`, `prompt_metadata`.
