---
description: Review the prompts captured in your Keep Your Prompts inbox and promote the keepers into your library.
argument-hint: "[number to show]"
disable-model-invocation: true
allowed-tools: mcp__plugin_kyp_keep-your-prompts__list_inbox mcp__plugin_kyp_keep-your-prompts__search_prompts
---

Review the user's Keep Your Prompts inbox.

1. Call `list_inbox` (limit: `$ARGUMENTS` if it is a number, else 15).
2. Group near-duplicates. For each item show: id, source, first line, and your suggestion (keep, merge into an
   existing prompt found with `search_prompts`, or dismiss).
3. Wait for the user's choices. Then call `promote_capture` (with a name and handle you propose) or
   `dismiss_capture` for each item they chose. Report what changed in one line per item.
