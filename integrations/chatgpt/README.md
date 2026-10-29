# Keep Your Prompts for ChatGPT and Codex

OpenAI now distributes apps for ChatGPT and Codex as **plugins**: a ZIP with a manifest, skills and one remote MCP
server, reviewed once and listed in the plugin directory shared by ChatGPT and Codex. This folder is that package,
in the portable [Agent Plugins](https://agent-plugins.org) format OpenAI recommends:

| File | Purpose |
| --- | --- |
| `plugin.json` | Identity, listing copy (`extensions.com.openai.interface`), five positive and three negative review test cases, release notes. |
| `mcp.json` | The remote server `https://api.keepyourprompts.com/mcp` (Streamable HTTP), OAuth with a Client ID Metadata Document. |
| `skills/keep-your-prompts/SKILL.md` | When and how ChatGPT should search, reuse, save and version prompts. |
| `assets/` | `icon.png` (composer icon) and `logo.png`. |
| `build.mjs` | Writes `dist/keep-your-prompts-chatgpt-<version>.zip` for upload. |

Not included on purpose: lifecycle hooks and `.app.json` (packages with either can't be submitted), API-key auth
(the portal only connects no-auth, OAuth and mixed servers), and any secret.

## Try it in your own account first

1. ChatGPT > **Plugins** > **+** > **Add custom MCP server**, URL `https://api.keepyourprompts.com/mcp`,
   authentication OAuth. Accept the developer-mode warning. Sign in to Keep Your Prompts.
2. Run each review test case from `plugin.json` against a populated test workspace and fix what fails.
3. Optional: **Create as a plugin**, then point Codex at this folder through a local marketplace
   (`~/.agents/plugins/marketplace.json` with `"source": { "source": "local", "path": "./..." }`).

## Server requirements (api.keepyourprompts.com)

These live in the API, not in this package. Check them before submitting:

- [ ] **Tool annotations:** every tool sets `readOnlyHint`, `destructiveHint` and `openWorldHint` explicitly.
      OpenAI's rule: `destructiveHint: true` for deletion, overwriting, cancellation, access revocation or
      irreversible sends ("being able to undo an action does not, by itself, justify false"). Proposed:
      `true` for `deploy`, `rollback`, `dismiss_capture`, `update_prompt` (it overwrites the current version),
      `restore_version`, `move_node`; `openWorldHint: true` for `share`, `publish`, `discover`, `install_asset`.
      Anthropic's directory checks the same hints.
- [ ] **OAuth:** protected resource metadata names the authorization server; the authorization server metadata
      advertises `code_challenge_methods_supported: ["S256"]`, `client_id_metadata_document_supported: true` and
      `"none"` in `token_endpoint_auth_methods_supported`; tokens carry the `resource` as audience. Allow the
      redirect `https://chatgpt.com/connector_platform_oauth_redirect` (if the server returns `iss` per RFC 9207,
      otherwise the per-connector `https://chatgpt.com/connector/oauth/{callback_id}` shown in the portal).
- [ ] **Domain verification:** serve the portal's token as plain text at
      `https://api.keepyourprompts.com/.well-known/openai-apps-challenge`.
- [ ] **No upsell inside ChatGPT:** tool results must not link to checkout or upgrade pages. The quota-exceeded
      problem detail currently includes the billing URL; for ChatGPT clients, say the plan limit was reached
      without the link.
- [ ] **Data minimisation:** tools never ask for conversation history; responses omit internal ids and timestamps
      the user didn't ask for. Prompts must not carry secrets (OpenAI prohibits collecting credentials).
- [ ] **Firewall:** the Cloudflare rules (managed challenge for hosting ASNs, the `/api/auth/*` rate limit) must not
      challenge OpenAI's or Anthropic's egress: both call discovery, registration and token endpoints from shared
      IP ranges.

## Submission checklist (platform.openai.com > Plugins)

- [ ] Verify The Republic US LLC as the developer organization (Platform Dashboard > Settings > General).
- [ ] Prepare a reviewer account with a populated workspace: prompts `support/refund-reply` (variables
      `customer_name`, `issue`) and `writing/release-notes` with versions 1 and 2, and a few inbox captures.
      Reviewers can't use MFA, email or SMS codes or magic links, and Keep Your Prompts is passwordless: enable a
      password sign-in for this one review account (for example Better Auth email-and-password restricted to an
      allowlisted address), or give reviewers a GitHub test account that signs in without a device check.
      Anthropic's directory asks for the same kind of test account.
- [ ] Record a short demo video of the positive test cases; add its URL in **Review details**
      (or as `review.demo_recording_url` in `plugin.json`).
- [ ] `node build.mjs`, then **Upload new or existing plugin** with `dist/keep-your-prompts-chatgpt-0.1.0.zip`.
- [ ] Resolve automated findings under **Metadata & Skills** and **MCPs**; **Connect** the server, complete domain
      verification, authorize with the reviewer account, wait for the tool scan.
- [ ] Enter reviewer credentials in **Review details**, complete the policy attestations, submit.
- [ ] After approval, choose when to **Publish**. Tool changes on the server are rescanned daily; metadata and
      skill changes need a new ZIP; a URL change needs OpenAI support.

## Listing rules that affect copy

No pricing, plans or comparisons in descriptions; no "MCP" or "Plugin" suffix in the name; example prompts
instead of screenshots; general audience (13+).
