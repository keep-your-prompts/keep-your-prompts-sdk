---
description: Improve a saved prompt in your Keep Your Prompts library, show the diff, and save it as a new version once you approve.
argument-hint: "<handle> [what to improve]"
disable-model-invocation: true
allowed-tools: mcp__plugin_kyp_keep-your-prompts__get_prompt mcp__plugin_kyp_keep-your-prompts__list_versions mcp__plugin_kyp_keep-your-prompts__diff_versions
---

Improve a prompt from the user's Keep Your Prompts library.

Arguments: `$ARGUMENTS` (first: the handle; the rest: what to improve, optional)

1. Call `get_prompt` for the handle. Note its current version and its `{{variables}}`.
2. Write an improved version yourself: clearer task and constraints, explicit output format, examples only if they
   help, no filler. Keep every existing `{{variable}}` unless the user asked to change them; if you add or remove
   one, say so, because callers that fill the old variables would break.
   (If the user asks for the hosted improver, call `improve_prompt` instead; it counts against their AI quota.)
3. Show a short critique (3 bullets at most) and the changes as a diff against the current body.
4. Ask for approval. Only after the user approves, call `update_prompt` with the new body, `baseVersion` set to
   the version you read, and a one-line `message`. Report the new version number.
