# Keep Your Prompts for Claude Desktop

Two ways to connect Claude Desktop to your Keep Your Prompts library. Pick one.

## Option A (recommended): custom connector, sign in with your account

Claude Desktop, claude.ai and the Claude mobile apps share connectors, so one setup covers all three.

1. Open **Settings > Connectors** (on Team and Enterprise plans an Owner adds it under **Organization settings > Connectors** first).
2. Choose **Add custom connector**, name it `Keep Your Prompts`, and enter the URL `https://api.keepyourprompts.com/mcp`.
3. Select **Connect** and sign in to Keep Your Prompts in the browser window. Approve access.
4. In a chat, open the tools menu and make sure **Keep Your Prompts** is on.

Claude reaches the server from Anthropic's cloud, so nothing runs on your computer. Your saved prompts are also
exposed as MCP prompts, which you can insert directly in Claude apps that support MCP prompts.

## Option B: this extension (`.mcpb`), with an API key

Use this when you want Claude Desktop to use a workspace API key instead of an account sign-in (for example a
read-only viewer key, or a shared team workspace key), or when your organization only allows local extensions.

1. Download `keep-your-prompts-<version>.mcpb` from the [releases page](https://github.com/keep-your-prompts/keep-your-prompts-sdk/releases), or build it (below).
2. Double-click it (or drag it onto Claude Desktop, or **Settings > Extensions > Install extension**).
3. Paste an API key from **app.keepyourprompts.com > Settings > API keys** (`kyp_live_...`). It is stored in your system keychain.
4. Turn the extension on. The tools appear under **Keep Your Prompts** in the tools menu.

The extension is a small bridge (`server/proxy.mjs`, no dependencies) that runs on Claude Desktop's built-in Node.js
and forwards MCP messages to `https://api.keepyourprompts.com/mcp` with your key. It stores nothing and sends nothing else.

### Settings

| Setting | Default | Notes |
| --- | --- | --- |
| API key | (required) | Editor keys get every tool; viewer keys get the read-only tools. |
| API URL | `https://api.keepyourprompts.com` | Only change it for a self-hosted server. Plain `http://` is refused except to `localhost`. |
| Workspace id | (empty) | Only for OAuth tokens that can see several workspaces. |

### Build

```bash
node build.mjs                               # writes dist/keep-your-prompts-<version>.mcpb
npx @anthropic-ai/mcpb validate manifest.json
npx @anthropic-ai/mcpb info dist/keep-your-prompts-0.1.0.mcpb
npx @anthropic-ai/mcpb sign dist/keep-your-prompts-0.1.0.mcpb --cert cert.pem --key key.pem   # optional
node --test test/*.test.mjs                  # bridge tests against a local fake server
```

### Distribution notes

- Anthropic's directory no longer lists desktop extensions (MCPB). Distribute the `.mcpb` from GitHub releases or
  your website, or through an organization's allowlist (Team and Enterprise admins can upload custom extensions).
- The public directory listing for Keep Your Prompts is the remote connector (Option A) and the Claude plugin
  (`../claude-code-plugin`), which also bundles the remote server.

## Privacy Policy

The extension sends the MCP requests Claude makes (tool calls with their arguments, such as search queries and
prompt text you ask Claude to save) to the Keep Your Prompts API, authenticated with your API key, and returns the
responses to Claude Desktop. It does not read files, collect conversation history or send telemetry. Data handling,
retention, sharing and your rights are described in the Keep Your Prompts privacy policy:
https://keepyourprompts.com/legal/privacy. Contact: contact@keepyourprompts.com.
