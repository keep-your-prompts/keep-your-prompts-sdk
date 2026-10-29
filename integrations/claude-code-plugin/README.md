# Keep Your Prompts plugin for Claude (`kyp`)

Your versioned prompt library inside Claude Code, Cowork and claude.ai. The plugin connects Claude to the Keep Your
Prompts MCP server and adds commands and a skill that teach Claude when to search, reuse, save and version prompts.
In Claude Code it can also send every prompt you type to your Keep Your Prompts inbox (opt-in, secrets redacted
locally), so the prompts you write while coding are kept like the ones you write on claude.ai.

## Install

In Claude Code:

```
/plugin marketplace add keep-your-prompts/keep-your-prompts-sdk
/plugin install kyp@keep-your-prompts
```

From a shell: `claude plugin marketplace add keep-your-prompts/keep-your-prompts-sdk && claude plugin install kyp@keep-your-prompts`.
From a clone of this repository: `claude plugin marketplace add ./integrations`. To try it for one session:
`claude --plugin-dir ./integrations/claude-code-plugin`.

On claude.ai and in Cowork, once the plugin is listed in Anthropic's directory: **Customize > Plugins > Discover**,
then connect the Keep Your Prompts connector from the plugin's **Connectors** tab. A plugin installed on your
claude.ai account also appears in Claude Code as `kyp@synced`.

## Sign in

Pick one:

- **OAuth (default).** Leave `KYP_API_KEY` unset, run `/mcp`, select `plugin:kyp:keep-your-prompts` and sign in
  in the browser. Tokens are stored in your system keychain and refreshed automatically.
- **API key.** `export KYP_API_KEY=kyp_live_...` (from app.keepyourprompts.com > Settings > API keys) before
  starting Claude Code. A viewer key gives the read-only tools. The plugin's `headersHelper`
  (`scripts/mcp-headers.sh`) sends it as a bearer token; without a key it sends nothing, so OAuth is used.

`KYP_WORKSPACE=<workspace id>` picks the workspace for an OAuth sign-in that can see several (API keys are already
bound to one).

## Commands

| Command | What it does |
| --- | --- |
| `/kyp:find <what>` | Search your library (add "public" to include the public library). |
| `/kyp:use <handle> [name=value ...]` | Fill a saved prompt's `{{variables}}` and run it. |
| `/kyp:save [name] [-- text]` | Save your previous prompt (or the text after `--`) as a new prompt or a new version. |
| `/kyp:improve <handle> [goal]` | Rewrite a prompt, show the diff, save a new version after you approve. |
| `/kyp:inbox [n]` | Review captured prompts; promote the keepers, dismiss the rest. |

The `keep-your-prompts` skill loads on its own when you talk about saved or reusable prompts. Read-only tools
(`search_prompts`, `get_prompt`, `list_versions`, `diff_versions`, `list_inbox`, ...) run without a permission
prompt while a command or the skill is active; writes (`create_prompt`, `update_prompt`, `deploy`, ...) ask first.
Your saved prompts are also served as MCP prompts, which Claude Code lists in the `/` menu under the server's name.

## Capture what you type (optional)

```bash
export KYP_CAPTURE=1
export KYP_API_KEY=kyp_live_...
```

With both set, a `UserPromptSubmit` hook runs `scripts/capture.mjs` (Node 18+, no dependencies) for each prompt:

- **Opt-in:** nothing is sent unless `KYP_CAPTURE` is `1`/`true` and a valid key is set. Without them the hook
  exits before starting Node.
- **Redacted locally:** API keys (OpenAI, Anthropic, AWS, GitHub, Slack, Stripe, Google, Keep Your Prompts),
  bearer tokens, JWTs, private keys, passwords in connection strings and card numbers become `[REDACTED:<kind>]`
  before anything leaves your machine. `KYP_REDACT_EMAIL=1` also redacts email addresses.
- **Only what you typed:** slash commands, prompts shorter than 12 characters (`KYP_CAPTURE_MIN_CHARS`), and turns
  Claude Code starts on its own (scheduled tasks, background agents reporting back) are skipped.
  `KYP_CAPTURE_SLASH=1` also keeps slash commands.
- **Never in the way:** the hook runs async, hands the request to a detached process with a 3 s timeout
  (`KYP_CAPTURE_TIMEOUT_MS`), prints nothing, and always exits 0. A failed request is dropped silently.
- **Where it goes:** `POST https://api.keepyourprompts.com/v1/captures` with `source: "ide"`. Captures show up in
  your inbox (app, extension overlay, `/kyp:inbox`); the same prompt sent twice in one session is stored once.

To turn it off, unset `KYP_CAPTURE` or disable the plugin (`/plugin`).

## What loads where

| Component | Claude Code | Cowork | claude.ai chat |
| --- | --- | --- | --- |
| MCP server (remote, OAuth) | yes | yes (connect it in the plugin's Connectors tab) | yes (connect it in the plugin's Connectors tab) |
| API-key `headersHelper` | yes | no | no |
| Skill and commands | yes | yes | yes (commands load as skills) |
| Capture hook | yes | yes, if Node and the variables are present | no (use the browser extension) |

## Develop

```bash
claude plugin validate . --strict
node --test test/*.test.mjs     # capture hook and headers helper against a fake API
```

Files: `.claude-plugin/plugin.json` (manifest), `.mcp.json` (server), `hooks/hooks.json` (capture hook),
`skills/*/SKILL.md` (commands and skill), `scripts/` (hook and headers helper). `scripts/capture.mjs` is shared with
the Gemini CLI extension; edit it here and run `node ../scripts/sync-shared.mjs`.

## Privacy

The plugin sends the MCP requests Claude makes to the Keep Your Prompts API, and, only if you turn capture on, the
redacted text of the prompts you type. Nothing else is collected. See https://keepyourprompts.com/legal/privacy.
