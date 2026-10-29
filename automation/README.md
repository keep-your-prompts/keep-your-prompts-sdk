# Keep Your Prompts automation apps

Apps for no-code automation platforms, built on the public REST API (`https://api.keepyourprompts.com/v1`, workspace
API key `kyp_live_…` as a Bearer token) and on outgoing webhooks. They are separate from the SDKs (which read
deployed prompts) and from [`integrations/`](../integrations) (which connect AI apps over MCP).

| Folder | Platform | What it is | Status |
| --- | --- | --- | --- |
| [`n8n/`](n8n) | n8n | Community node package `n8n-nodes-keepyourprompts`: a credential, the **Keep Your Prompts** node and the **Keep Your Prompts Trigger** | Builds, `n8n-node lint` clean, unit tests; not on npm yet |
| [`zapier/`](zapier) | Zapier | Zapier Platform CLI app (`zapier-platform-core` 19): 19 instant triggers, 1 search, 6 actions | Unit tests (appTester + nock), `zapier-platform validate` clean; not pushed yet |
| [`make/`](make) | Make | Custom app source in the Make Apps Editor (VS Code) local layout: base, connection, webhook with attach/detach, 10 modules, 2 custom IML functions | Static validation and function tests; not deployed yet |
| [`test-vectors/`](test-vectors) | all | `standard-webhooks.json` (signature vectors, starting with the Standard Webhooks reference vector) and `events.json` (the 18 event types with their example payloads) | Used by all three test suites |

## What every app does

| Capability | API | n8n | Zapier | Make |
| --- | --- | --- | --- | --- |
| Connect with an API key | `GET /v1/me` (test) | credential test | auth test | connection |
| React to events | `POST /v1/webhooks` (`source` `n8n`/`zapier`/`make`) on activation, `DELETE /v1/webhooks/:id` on deactivation | Trigger node | REST hooks | dedicated webhook attach/detach + Watch Events |
| Verify deliveries | Standard Webhooks `webhook-id`/`webhook-timestamp`/`webhook-signature: v1,<base64 HMAC-SHA256>`, two signatures while a secret rotates, 5-minute tolerance | every delivery (raw body) | every delivery (`rawRequest.content`) | function shipped and tested, not wired in (see [make/README.md](make/README.md#webhook-signatures)) |
| Find prompts | `GET /v1/search`, `GET /v1/assets/:slugOrId` | Search, Get | Find Prompt | Search Prompts, Get a Prompt |
| Render | `GET /v1/assets/:id/compiled`, then `{{variables}}` client-side with the SDK rules | Render | Render Prompt | Render a Prompt (`kypRender`) |
| Create, save a version | `POST /v1/assets`, `PATCH /v1/assets/:id` (`baseVersion` guard) | Create, Save Version | Create Prompt, Save Prompt Version | Create a Prompt, Save a Prompt Version |
| Deploy, roll back | `POST /v1/apps/:app/deploy`, `POST /v1/apps/:app/rollback` | Deploy, Roll Back | Deploy Prompts, Roll Back Environment | Deploy Prompts, Roll Back an Environment |
| Capture | `POST /v1/captures` (`source: "api"`) | Capture › Create | Capture Prompt | Capture a Prompt |

There is no server-side render endpoint: the apps fetch the compiled body (includes inlined, as a deploy would deliver
it) and fill variables locally with the rules of [`protocol/README.md`](../protocol/README.md#templates), tested
against [`conformance/cases.json`](../conformance/cases.json).

Webhook endpoints need an **editor API key created by an owner or admin** (viewer keys cannot manage webhooks), a
public `https://` URL (private addresses are refused), and count toward the plan's limit (Free 1, Pro 3, Team and up
20 endpoints per workspace).

## Owner checklist

Things only the owner can do; none of them has been done.

**n8n** ([submit community nodes](https://docs.n8n.io/integrations/creating-nodes/deploy/submit-community-nodes/),
[verification guidelines](https://docs.n8n.io/integrations/creating-nodes/build/reference/verification-guidelines/))

1. Create the npm package `n8n-nodes-keepyourprompts` and add this repository's `automation-n8n.yml` workflow as its
   [trusted publisher](https://docs.npmjs.com/trusted-publishers) (environment `npm`). Then tag `n8n-v0.1.0`.
   n8n requires GitHub Actions publishing with provenance for verification since 1 May 2026; the workflow does that.
   n8n's starter names this workflow `publish.yml`; npm trusted publishing accepts any workflow file name, but rename
   it if n8n's checker insists.
2. **Decide the licence.** Verified community nodes must be **MIT**; this package ships under the repository's
   Lex Aequa licence. Without verification the node still installs on self-hosted n8n (and n8n Cloud only shows
   verified nodes). If you relicense it, set `"license": "MIT"`, replace `n8n/LICENSE`, set `"strict": true` and
   restore the default `eslint.config.mjs` (`export default config;`).
3. Run `npx @n8n/scan-community-package n8n-nodes-keepyourprompts` after publishing, then submit it in the
   n8n Creator Portal (linked from the submission page above). n8n can reject nodes that compete with its paid features.
4. Make sure the npm author/maintainer matches the GitHub repository owner and that the repository is public.

**Zapier** ([publishing](https://docs.zapier.com/platform/publish/public-integration),
[requirements](https://docs.zapier.com/platform/publish/integration-publishing-requirements))

1. Create a Zapier developer account with a `keepyourprompts.com` address (an admin from the service's own domain is
   required), `zapier-platform register "Keep Your Prompts"`, then `zapier-platform push` (or set the
   `ZAPIER_DEPLOY_KEY` secret and `ZAPIER_APP_ID` variable and tag `zapier-v0.1.0`).
2. In the Platform UI: logo, description ("Keep Your Prompts is a…"), homepage, categories, and a non-expiring test
   account for Zapier's reviewers with every feature the triggers and actions need (editor key, a paid plan for
   reviews/approvals/evals), plus public API documentation for every endpoint used.
3. Build and turn on a test Zap for every trigger, search and action with at least one successful run, then
   **Publish › Submit for Review** (answer within about a week; then 90 days of beta before public).

**Make** ([app review](https://developers.make.com/custom-apps-documentation/app-review/overview),
[prerequisites](https://developers.make.com/custom-apps-documentation/app-review/prerequisites))

1. Create the app in Make, deploy `make/src` with the VS Code extension ([steps](make/README.md#import-into-make)),
   and ask Make support to enable **custom IML functions** for it (needed by Render a Prompt).
2. Ask Make how webhook communication reads data saved by `attach` and switch on signature verification
   ([make/README.md](make/README.md#webhook-signatures)).
3. Run test scenarios that use every module (with pagination logs for Search Prompts and a scenario that ends in an
   error), then **Publish** (irreversible: components can no longer be deleted) and **Request review** with links to
   the API documentation and the scenarios. Publishing alone gives an invite link; the review makes it public.

**API**: the apps assume the webhook API in the product repository's `docs/webhooks.md` is live (including `source`
values `zapier`, `n8n`, `make` for editor API keys) and that `GET /v1/assets/:id/compiled` is reachable with an API key.

## Research (October 2026)

| Topic | Source | What we follow |
| --- | --- | --- |
| n8n node tooling | [n8n-node CLI](https://docs.n8n.io/integrations/creating-nodes/build/n8n-node/), [n8n-nodes-starter](https://github.com/n8n-io/n8n-nodes-starter) | `@n8n/node-cli` 0.54.5 (`n8n-node build/lint/dev/release`), starter `package.json` (`n8n` field with `n8nNodesApiVersion: 1`, `n8n-community-node-package` keyword, `n8n-workflow` peer dependency), `tsconfig.json`, `eslint.config.mjs`, codex `.node.json` categories, themed SVG icons |
| n8n verification | [verification guidelines](https://docs.n8n.io/integrations/creating-nodes/build/reference/verification-guidelines/), [submission](https://docs.n8n.io/integrations/creating-nodes/deploy/submit-community-nodes/) | no runtime dependencies, no env/file access, English UI, programmatic trigger in the same package, MIT licence (owner decision), provenance publishing |
| n8n lint rules | `@n8n/eslint-plugin-community-nodes` 0.37 (in the CLI) | credential test and icon, trigger naming, `webhookMethods` with `checkExists`/`create`/`delete` and no swallowed errors, `NodeApiError`/`NodeOperationError`, `pairedItem`, `usableAsTool`, allowed imports (`crypto` is allowed) |
| Zapier CLI | [CLI reference](https://docs.zapier.com/platform/reference/cli-docs), [zapier-platform README](https://github.com/zapier/zapier-platform/tree/main/packages/cli) | `zapier-platform-core`/`-cli` 19.2.1, command `zapier-platform` (the `zapier` binary was removed in v19), Node 22 runtime, Jest templates using `createAppTester` |
| Zapier REST hooks | [REST hook triggers](https://docs.zapier.com/integrations/build/cli-hook-trigger), [bundle](https://docs.zapier.com/integrations/build/bundle) | `performSubscribe` with `bundle.targetUrl`, `performUnsubscribe` with `bundle.subscribeData.id`, `perform` returns an array, `performList` for samples; `bundle.rawRequest` (raw `content`, headers renamed `Http-…`) is only available in hook `perform` |
| Zapier checks | `zapier-platform validate` | schema and integration checks pass; `flags.cleanInputData: false` (D028) |
| Make app layout | [local development](https://developers.make.com/custom-apps-documentation/get-started/make-apps-editor/apps-sdk/local-development-for-apps), [Make Apps Editor source](https://github.com/integromat/vscode-apps-sdk) 2.9.0 | `makecomapp.json` (`fileVersion`, `generalCodeFiles`, `components`, `origins`), `<component>.<code>.iml.json` files in `connections/`, `webhooks/`, `modules/`, `functions/`, `general/base.iml.json`, `modules/groups.json`; the extension's JSON schemas drive `scripts/validate.mjs` |
| Make webhooks | [webhooks](https://developers.make.com/custom-apps-documentation/app-components/webhooks), [attached dedicated](https://developers.make.com/custom-apps-documentation/app-components/webhooks/dedicated/attached), [instant trigger](https://developers.make.com/custom-apps-documentation/app-components/modules/instant-trigger) | attach saves `response.data` (id, secret), detach uses `{{webhook.id}}`; webhook code sees parsed `body` and `headers` only |
| Make functions and review | [custom IML functions](https://developers.make.com/custom-apps-documentation/app-components/iml-functions), [IML tests](https://developers.make.com/custom-apps-documentation/get-started/make-apps-editor/apps-sdk/iml-tests), [review prerequisites](https://developers.make.com/custom-apps-documentation/app-review/prerequisites), [universal module](https://developers.make.com/custom-apps-documentation/app-components/modules/universal-module) | functions need Make to enable them, only built-ins and `Buffer`, 5,000 characters, 10 s; review needs sanitization, error handling, a universal module with relative URLs, `limit` on searches, labels and descriptions |
| Signatures | [Standard Webhooks spec](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md) | reference vector `whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw` / `msg_p5jXN8AQM9LWM0D4loKWxJek` / `1614265330` / `{"test": 2432232314}` → `v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=` |

## Licence

Everything here is under [The Republic Lex Aequa License 1.0](../LICENSE); each app folder carries a copy.
