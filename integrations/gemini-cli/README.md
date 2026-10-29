# Keep Your Prompts extension for Gemini CLI

Connects Gemini CLI to your Keep Your Prompts library (MCP server `keep-your-prompts`), adds `/kyp:find`,
`/kyp:use`, `/kyp:save`, `/kyp:improve` and `/kyp:inbox`, loads a short context file that tells Gemini when to
use your library, and can send the prompts you type to your inbox (opt-in).

## Install

```bash
gemini extensions install ./integrations/gemini-cli          # from a clone of this repository
# once published as its own repository (the gallery needs gemini-extension.json at the repository root):
gemini extensions install https://github.com/keep-your-prompts/gemini-cli-extension
```

Gemini CLI asks for the extension settings on install (change them later with
`gemini extensions config keep-your-prompts`):

| Setting | Variable | Notes |
| --- | --- | --- |
| API key | `KYP_API_KEY` | `kyp_live_...` from app.keepyourprompts.com > Settings > API keys. Stored in the system keychain. |
| Capture prompts | `KYP_CAPTURE` | `1` to send each prompt you type to your inbox. Empty: off. |

Gemini CLI only passes declared settings to extensions (it strips variables like `*_KEY` from the environment), so
set the key through the extension settings rather than your shell.

Prefer OAuth? Skip the API key and add the server yourself:
`gemini mcp add --transport http keep-your-prompts https://api.keepyourprompts.com/mcp`, then `/mcp auth keep-your-prompts`.

## Capture

The `BeforeAgent` hook runs `scripts/capture.mjs` (the same script as the Claude plugin). It prints `{}` right away
so Gemini continues, and, when `KYP_CAPTURE=1` and a key are set, sends the redacted prompt to `POST /v1/captures`
from a detached process with a 3 s timeout. See the [Claude plugin README](../claude-code-plugin/README.md#capture-what-you-type-optional)
for what is redacted and skipped. The hook only runs when hooks are enabled in Gemini CLI (`hooksConfig.enabled`).

## Publish to the gallery

1. Copy this folder to the root of a public repository, for example `keep-your-prompts/gemini-cli-extension`
   (sync `scripts/capture.mjs` from `../claude-code-plugin/scripts/` first: `node ../scripts/sync-shared.mjs`).
2. Add the `gemini-cli-extension` topic to the repository. The gallery crawler indexes it within a day or two.
3. Tag releases; users update with `gemini extensions update keep-your-prompts`.
