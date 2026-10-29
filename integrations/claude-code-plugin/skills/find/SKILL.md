---
description: Search your Keep Your Prompts library for prompts, skills and agents matching a description.
argument-hint: "<what you are looking for>"
disable-model-invocation: true
allowed-tools: mcp__plugin_kyp_keep-your-prompts__search_prompts mcp__plugin_kyp_keep-your-prompts__get_prompt
---

Search the user's Keep Your Prompts library for: `$ARGUMENTS`

1. Call `search_prompts` with that query (scope `mine`, limit 10). If the user wrote "public" or "library",
   use scope `all` and label public results as written by other people.
2. Show a compact table: handle, name, version, one-line snippet. Best match first.
3. If nothing matches, say so and suggest `/kyp:save` for the prompt they are looking for.
4. Do not open, run or modify any prompt unless the user asks; suggest `/kyp:use <handle>` to run one.
