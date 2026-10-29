# n8n-nodes-keepyourprompts

[n8n](https://n8n.io) community nodes for [Keep Your Prompts](https://keepyourprompts.com), version control and
deployment for prompts. Search, render, create, version and deploy prompts from a workflow, capture text into your
inbox, and start workflows when something happens in your workspace.

> **Preview.** Version 0.1.0 is not published to npm yet. The install line below is what it will be at release.

## Install

In n8n: **Settings › Community nodes › Install**, enter `n8n-nodes-keepyourprompts` and confirm. Self-hosted n8n
can also run `npm install n8n-nodes-keepyourprompts` in `~/.n8n/nodes` and restart. See n8n's
[community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/).

## Credentials

**Keep Your Prompts API**: a workspace API key (`kyp_live_…`) from **Settings › API keys** in the app. n8n checks it
with `GET /v1/me` when you save the credential.

| Key role | What works |
| --- | --- |
| Viewer | Prompt › Search, Get, Render |
| Editor created by an owner or admin | Everything, including the trigger (it registers a webhook) |

The **Base URL** field defaults to `https://api.keepyourprompts.com`; leave it unless support gives you another one.

## Nodes

### Keep Your Prompts

| Resource | Operation | API |
| --- | --- | --- |
| Prompt | Search | `GET /v1/search?q=&scope=&limit=` (one item per result: `asset`, `score`, `snippet`) |
| Prompt | Get | `GET /v1/assets/:slugOrId` (and `GET /v1/assets/:id/versions/:v` for a past version) |
| Prompt | Render | `GET /v1/assets/:id/compiled?version=` (includes compiled), then fills `{{variables}}` from key/value pairs |
| Prompt | Create | `POST /v1/assets` (name, body, kind, slug, description, tags, message) |
| Prompt | Save Version | `PATCH /v1/assets/:id` with a new body (optional message and base version: a stale base fails with 409) |
| Deployment | Deploy | `POST /v1/apps/:app/deploy` with `{ env, prompts:[{ name, assetId, version? }], message? }` |
| Deployment | Roll Back | `POST /v1/apps/:app/rollback` with `{ env, toRevision }` |
| Capture | Create | `POST /v1/captures` with `source: "api"` |

Prompts can be given by slug (`support-triage`) or ID (`ast_…`); slugs are resolved first. Rendering follows the
SDKs' rules: `{{ name }}` (spaces allowed), `{{{{` is a literal `{{`, and a missing variable fails by default (choose
*Keep the Placeholder* or *Leave Empty* instead). The node can be used as a tool by n8n AI agents.

### Keep Your Prompts Trigger

Choose events (or *All Events*). When the workflow is activated (or you click *Listen for test event*), the node
registers a webhook endpoint for its URL with `POST /v1/webhooks` (`source: "n8n"`) and keeps the signing secret it
gets back in the workflow's static data. Deactivating deletes the endpoint. An endpoint left over for the same URL
(for example after a failed deactivation) is removed before a new one is made.

Every delivery is checked before the workflow runs:

- **Signature**: [Standard Webhooks](https://www.standardwebhooks.com) `webhook-signature: v1,<base64 HMAC-SHA256>`
  over `webhook-id.webhook-timestamp.<raw body>`, with the secret's base64 key. During a secret rotation two
  signatures arrive and either may match.
- **Freshness**: `webhook-timestamp` within 5 minutes of n8n's clock (replay protection).

A delivery that fails either check gets `401` and starts nothing. Output: the event envelope
`{ id, type, timestamp, version, workspace, data }`. `id` is the same on every retry, so use it to drop duplicates
(delivery is at least once). Events sent with **Send test event** (`"test": true`) start the workflow unless you turn
on *Ignore Test Events*.

The 18 events: `prompt.created`, `prompt.version_saved`, `prompt.deleted`, `deploy.completed`, `deploy.rolled_back`,
`deploy.requested`, `deploy.approved`, `review.requested`, `review.merged`, `review.closed`, `capture.created`,
`eval.run_completed`, `eval.gate_failed`, `sync.conflict`, `sync.failed`, `quota.warning`, `member.joined`,
`member.removed`. Payloads never carry a prompt body: use **Prompt › Get** or **Render** with `data.prompt.id`.

Your n8n instance must be reachable over public HTTPS: Keep Your Prompts refuses webhook URLs that are not `https://`
or that resolve to private addresses. Plans allow 1 (Free), 3 (Pro) or 20 (Team and up) endpoints per workspace.

## Example workflows

- **Deploy on review merge**: Trigger (`review.merged`) → Keep Your Prompts › Deployment › Deploy
  (`data.prompt.id`, version `data.version`) to `staging`.
- **Slack on failed eval gate**: Trigger (`eval.gate_failed`) → Slack › Send message with `data.app.slug`,
  `data.env` and each `data.items[].passRate`.
- **Render for an LLM call**: Manual trigger → Keep Your Prompts › Prompt › Render (`support-triage`,
  `company` = `Acme`) → an AI node using `rendered` as the system prompt.

## Develop

```sh
npm install
npm run build      # n8n-node build
npm run lint       # n8n-node lint (n8n's community node rules)
npm test           # node --test against dist/ (shared webhook vectors, conformance render cases, fakes for the API)
npm run dev        # n8n with these nodes loaded (needs Docker or Podman)
```

The package has no runtime dependencies (`n8n-workflow` is a peer dependency).

## Licence

[The Republic Lex Aequa License 1.0](LICENSE) (SPDX `LicenseRef-Republic-Lex-Aequa-1.0`), like the rest of this
repository. n8n's verified community nodes must be MIT: see [`../README.md`](../README.md#owner-checklist).
`n8n-node lint` reports that rule only in strict mode, which is turned off in `package.json` for that reason.
