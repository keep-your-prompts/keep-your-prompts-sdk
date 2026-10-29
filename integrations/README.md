# Keep Your Prompts integrations

Connect AI apps and coding agents to your Keep Your Prompts library. Everything here talks to one remote MCP
server:

```
https://api.keepyourprompts.com/mcp
```

It speaks MCP 2026-07-28 (and serves 2025-era clients statelessly) and accepts either an **OAuth 2.1 sign-in**
(Client ID Metadata Documents or dynamic client registration; nothing to configure) or a **workspace API key**
(`Authorization: Bearer kyp_live_...`, created in app.keepyourprompts.com > Settings > API keys). A viewer key
gets the read-only tools. Tools: `search_prompts`, `get_prompt`, `list_tree`, `create_prompt`, `update_prompt`,
`list_versions`, `diff_versions`, `restore_version`, `list_inbox`, `promote_capture`, `improve_prompt`, `deploy`,
`discover` and more; your saved prompts are also served as MCP prompts.

## Packages in this folder

| Folder | What it is | Status |
| --- | --- | --- |
| [`claude-code-plugin/`](claude-code-plugin) | Claude plugin `kyp`: the MCP server, `/kyp:save`, `/kyp:find`, `/kyp:use`, `/kyp:improve`, `/kyp:inbox`, a `keep-your-prompts` skill, and an opt-in prompt-capture hook. Loads in Claude Code, Cowork and claude.ai (skills + connector). | Validated with `claude plugin validate --strict` |
| [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) | Plugin marketplace (root: this folder) listing `kyp`. | Validated |
| [`claude-desktop/`](claude-desktop) | MCP Bundle (`.mcpb`) with a zero-dependency stdio-to-remote bridge, for API-key use in Claude Desktop. | `mcpb validate` passes; bridge tested |
| [`chatgpt/`](chatgpt) | OpenAI plugin package (Agent Plugins format) for ChatGPT and Codex: `plugin.json`, `mcp.json`, skill, review test cases. | Schema-checked; needs portal submission |
| [`gemini-cli/`](gemini-cli) | Gemini CLI extension: MCP server, `/kyp:*` commands, context file, opt-in capture hook. | JSON/TOML checked |
| [`mcp-registry/server.json`](mcp-registry/server.json) | Entry for the official MCP Registry (feeds the VS Code / GitHub MCP gallery and other clients). | Schema-valid; publish with `mcp-publisher` |
| [`scripts/`](scripts) | `zip.mjs` (bundle builder), `sync-shared.mjs` (keeps the shared capture hook in sync). | |

## Connect your app

Pick the OAuth config when you can: no secret in a file, and you choose the workspace when you sign in. Use the
API-key config for headless machines, CI and shared workspace keys. Set the key once in your shell profile:
`export KYP_API_KEY=kyp_live_...`.

| App | How to connect |
| --- | --- |
| claude.ai, Claude Desktop, Claude mobile | Settings > Connectors > **Add custom connector** > URL `https://api.keepyourprompts.com/mcp` > Connect and sign in. Mobile picks it up from your account (you can't add connectors on mobile). Team/Enterprise: an Owner adds it in Organization settings > Connectors first. API-key alternative for Desktop: [`claude-desktop/`](claude-desktop). |
| Claude Code (plugin, recommended) | `/plugin marketplace add keep-your-prompts/keep-your-prompts-sdk` then `/plugin install kyp@keep-your-prompts` (see [the plugin README](claude-code-plugin/README.md); from a clone, `claude plugin marketplace add ./integrations` also works). |
| Claude Code (server only) | `claude mcp add --transport http keep-your-prompts https://api.keepyourprompts.com/mcp` then `/mcp` to sign in. API key: add `--header "Authorization: Bearer $KYP_API_KEY"`. |
| Cursor | [Install link](#cursor) or `~/.cursor/mcp.json` (below). |
| VS Code (GitHub Copilot agent mode) | `code --add-mcp '{"name":"keep-your-prompts","type":"http","url":"https://api.keepyourprompts.com/mcp"}'` or `.vscode/mcp.json` (below). |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` (below), then refresh in Cascade > MCP. |
| Zed | `context_servers` in `settings.json` (below). |
| Codex CLI / Codex app | `codex mcp add keep-your-prompts --url https://api.keepyourprompts.com/mcp` then `codex mcp login keep-your-prompts`, or `~/.codex/config.toml` (below). |
| Gemini CLI | `gemini extensions install https://github.com/keep-your-prompts/gemini-cli-extension` once published (see [`gemini-cli/`](gemini-cli)); today: `gemini extensions install ./integrations/gemini-cli`, or `gemini mcp add --transport http keep-your-prompts https://api.keepyourprompts.com/mcp`. |
| ChatGPT | Developer mode: ChatGPT > Plugins > **+** > Add custom MCP server > URL above > OAuth. Public listing: [`chatgpt/`](chatgpt). |
| JetBrains (AI Assistant, Junie) | Settings > Tools > AI Assistant (or Junie) > MCP > Add > `{"mcpServers":{"keep-your-prompts":{"url":"https://api.keepyourprompts.com/mcp"}}}`. |
| Mistral Le Chat, Perplexity | Connectors > Add custom MCP connector > URL above > sign in. |

### Cursor

One-click install (host this as a button on keepyourprompts.com; GitHub doesn't render `cursor:` links):

```
cursor://anysphere.cursor-deeplink/mcp/install?name=keep-your-prompts&config=eyJ1cmwiOiJodHRwczovL2FwaS5rZWVweW91cnByb21wdHMuY29tL21jcCJ9
```

`~/.cursor/mcp.json` (OAuth via dynamic registration):

```json
{
  "mcpServers": {
    "keep-your-prompts": {
      "url": "https://api.keepyourprompts.com/mcp"
    }
  }
}
```

API key:

```json
{
  "mcpServers": {
    "keep-your-prompts": {
      "url": "https://api.keepyourprompts.com/mcp",
      "headers": { "Authorization": "Bearer ${env:KYP_API_KEY}" }
    }
  }
}
```

### VS Code

Install link: `vscode:mcp/install?%7B%22name%22%3A%22keep-your-prompts%22%2C%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fapi.keepyourprompts.com%2Fmcp%22%7D`

`.vscode/mcp.json` (VS Code prompts for the key once and stores it securely):

```json
{
  "inputs": [
    { "type": "promptString", "id": "kyp-api-key", "description": "Keep Your Prompts API key (kyp_live_...)", "password": true }
  ],
  "servers": {
    "keep-your-prompts": {
      "type": "http",
      "url": "https://api.keepyourprompts.com/mcp",
      "headers": { "Authorization": "Bearer ${input:kyp-api-key}" }
    }
  }
}
```

For OAuth, drop `inputs` and `headers`.

### Windsurf

`~/.codeium/windsurf/mcp_config.json` (remote servers use `serverUrl`; omit `headers` for OAuth):

```json
{
  "mcpServers": {
    "keep-your-prompts": {
      "serverUrl": "https://api.keepyourprompts.com/mcp",
      "headers": { "Authorization": "Bearer ${env:KYP_API_KEY}" }
    }
  }
}
```

### Zed

`settings.json` (without an `Authorization` header Zed runs the OAuth flow):

```json
{
  "context_servers": {
    "keep-your-prompts": {
      "url": "https://api.keepyourprompts.com/mcp"
    }
  }
}
```

### Codex CLI

`~/.codex/config.toml` (omit `bearer_token_env_var` and run `codex mcp login keep-your-prompts` for OAuth):

```toml
[mcp_servers.keep-your-prompts]
url = "https://api.keepyourprompts.com/mcp"
bearer_token_env_var = "KYP_API_KEY"
```

### Gemini CLI

The extension in [`gemini-cli/`](gemini-cli) is the full setup. Server only, in `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "keep-your-prompts": {
      "httpUrl": "https://api.keepyourprompts.com/mcp",
      "headers": { "Authorization": "Bearer $KYP_API_KEY" }
    }
  }
}
```

## Capture the prompts you type in coding agents

`claude-code-plugin/scripts/capture.mjs` is one zero-dependency Node script that sends each prompt you type to your
inbox (`POST /v1/captures`, source `ide`). It is **off unless `KYP_CAPTURE=1`** and `KYP_API_KEY` are set, redacts
secrets on your machine first (API keys, tokens, private keys, passwords in URLs, card numbers; emails with
`KYP_REDACT_EMAIL=1`), skips slash commands, very short prompts and agent-generated turns, and never blocks or
changes the prompt (detached request, 3 s timeout, always exits 0). The Claude plugin and the Gemini extension
wire it up for you; for other agents point their prompt hook at a copy of the script:

| Agent | Hook file | Entry |
| --- | --- | --- |
| Claude Code | (plugin) | `UserPromptSubmit`, async |
| Gemini CLI | (extension) | `BeforeAgent` |
| Codex | `~/.codex/hooks.json` | `{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"node /path/to/capture.mjs","async":true}]}]}}` (review and trust it in Codex) |
| Cursor | `~/.cursor/hooks.json` | `{"version":1,"hooks":{"beforeSubmitPrompt":[{"command":"node /path/to/capture.mjs"}]}}` |

## Develop

```bash
node --test claude-code-plugin/test/*.test.mjs claude-desktop/test/*.test.mjs
claude plugin validate ./claude-code-plugin --strict && claude plugin validate .
node claude-desktop/build.mjs && npx @anthropic-ai/mcpb validate claude-desktop/manifest.json
node chatgpt/build.mjs
node scripts/sync-shared.mjs --check
```
