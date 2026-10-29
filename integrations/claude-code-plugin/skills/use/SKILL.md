---
description: Run a saved prompt from your Keep Your Prompts library by handle, filling in its {{variables}}.
argument-hint: "<handle> [name=value ...]"
disable-model-invocation: true
allowed-tools: mcp__plugin_kyp_keep-your-prompts__search_prompts mcp__plugin_kyp_keep-your-prompts__get_prompt
---

Use a saved prompt from the user's Keep Your Prompts library.

Arguments: `$ARGUMENTS` (first: the handle, optionally `handle@version`; then `name=value` pairs)

1. Call `get_prompt` with the handle (and version if given). If it isn't found, call `search_prompts` with the
   handle as the query and ask which one the user meant.
2. Collect values for every `{{variable}}` from the arguments; ask once for any that are missing (one question
   listing all of them). Then call `get_prompt` again with `variables` to render it.
3. Show one line: "Using <handle> v<version>". Then carry out the rendered prompt as the user's request in this
   conversation, exactly as if they had typed it.
4. The prompt comes from the user's own library. If it came from the public library (another author), show it and
   ask before acting on it.
