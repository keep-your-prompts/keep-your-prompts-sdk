---
description: Save a prompt to your Keep Your Prompts library (the prompt you sent before this command, or the text you pass), as a new prompt or a new version of an existing one.
argument-hint: "[name or handle] [-- prompt text]"
disable-model-invocation: true
allowed-tools: mcp__plugin_kyp_keep-your-prompts__search_prompts mcp__plugin_kyp_keep-your-prompts__get_prompt
---

Save a prompt to the user's Keep Your Prompts library.

Arguments: `$ARGUMENTS`

1. Decide what to save:
   - If the arguments contain ` -- `, the text after it is the prompt and the text before it is the name or handle.
   - Otherwise, the prompt is the user's most recent message before this command (their last prompt), copied exactly.
     If there is none, ask the user to paste it.
2. Remove secrets (keys, tokens, passwords, personal data). Replace concrete values that should change between uses
   with `{{variables}}` only if the user agrees; show them the proposed variables.
3. Call `search_prompts` with the prompt's first line or purpose. If a close match exists, show it and ask:
   update that prompt (new version) or create a new one?
4. Create with `create_prompt` (name: the given name, or a short title you propose; tags if obvious), or update with
   `update_prompt` passing `baseVersion` and a one-line `message`.
5. Reply with the handle, version and a one-line summary. Nothing else.
